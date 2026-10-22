'use strict';

// Run: node --test client/tools/test-library-transaction.js
// Real temporary files with injected I/O failures; no Electron or user data.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibraryTransaction } = require('../main/library-transaction.js');

const JOURNAL = 'library-save.pending.json';
const keys = ['characters', 'worldbooks'];
const roots = (name) => ({
  characters: { metadata: { owner: name }, characters: [{ id: 'local', name }, { id: 'peer', extra: { untouched: true } }] },
  worldbooks: { revision: 7, worldbooks: [{ id: 'book', name, entries: [] }, { id: 'peer-book', custom: [1, 2] }] }
});
const ioError = (message) => Object.assign(new Error(message), { code: 'EIO' });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-library-transaction-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  const old = roots('old');
  const oldBytes = {};
  for (const key of keys) {
    // Deliberately nonstandard formatting to verify byte-exact undo.
    oldBytes[key] = Buffer.from('\ufeff' + JSON.stringify(old[key], null, '\t') + '\r\n');
    fs.writeFileSync(file(key + '.json'), oldBytes[key]);
  }
  const calls = [];
  const controls = { fail: null, afterWrite: null };
  function write(absolute, data) {
    const name = path.basename(absolute);
    assert.equal(path.dirname(absolute), directory);
    calls.push(name);
    if (controls.fail) controls.fail(name, data);
    if (fs.existsSync(absolute)) fs.copyFileSync(absolute, absolute + '.backup');
    fs.writeFileSync(absolute + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(absolute + '.tmp', absolute);
    if (controls.afterWrite) controls.afterWrite(name, data);
    return true;
  }
  const open = () => createLibraryTransaction({ directory: () => directory, write });
  const journal = (before = oldBytes) => ({ version: 1, encoding: 'base64', before: Object.fromEntries(keys.map((key) =>
    [key, before[key] === null ? null : before[key].toString('base64')])) });
  const seedJournal = (value = journal()) => fs.writeFileSync(file(JOURNAL), JSON.stringify(value));
  const assertOld = () => keys.forEach((key) => assert.deepEqual(fs.readFileSync(file(key + '.json')), oldBytes[key]));
  return { directory, file, oldBytes, calls, controls, open, journal, seedJournal, assertOld };
}

test('successful save preserves complete roots and peers, snapshots input, removes journal and backup', (t) => {
  const f = fixture(t);
  const after = roots('new');
  const expected = structuredClone(after);
  f.controls.afterWrite = (name) => {
    if (name === JOURNAL) {
      after.characters.metadata.owner = 'changed after preparation';
      after.worldbooks.worldbooks[1].custom.push(999);
      fs.copyFileSync(f.file(JOURNAL), f.file(JOURNAL + '.backup'));
    }
  };
  assert.deepEqual(f.open().commit(after), expected);
  for (const key of keys) assert.deepEqual(JSON.parse(fs.readFileSync(f.file(key + '.json'), 'utf8')), expected[key]);
  assert.deepEqual(f.calls, [JOURNAL, 'characters.json', 'worldbooks.json']);
  assert.equal(fs.existsSync(f.file(JOURNAL)), false);
  assert.equal(fs.existsSync(f.file(JOURNAL + '.backup')), false);
  assert.equal(f.open().recover(), false);
});

for (const target of ['characters.json', 'worldbooks.json']) {
  test(`${target} failure immediately undoes both files byte-for-byte and throws original error`, (t) => {
    const f = fixture(t);
    const error = ioError('target failed');
    f.controls.fail = (name) => { if (name === target) throw error; };
    assert.throws(() => f.open().commit(roots('new')), (actual) => actual === error);
    f.assertOld();
    assert.equal(fs.existsSync(f.file(JOURNAL)), false);
  });

  test(`${target} failure plus undo interruption keeps journal; new instance restores old state`, (t) => {
    const f = fixture(t);
    const rename = fs.renameSync;
    f.controls.fail = (name) => { if (name === target) throw ioError('target failed'); };
    const mocked = t.mock.method(fs, 'renameSync', (source, destination) => {
      if (source === f.file('characters.json.tmp') && f.calls.includes(target)) throw ioError('undo interrupted');
      return rename(source, destination);
    });
    assert.throws(() => f.open().commit(roots('new')), (error) => {
      assert.equal(error.code, 'ERR_LIBRARY_TRANSACTION_RECOVERY');
      assert.match(error.message, /target failed.*undo interrupted/);
      assert.equal(error.errors.length, 2);
      return true;
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file(JOURNAL), 'utf8')), f.journal());
    mocked.mock.restore();
    f.controls.fail = null;
    assert.equal(f.open().recover(), true);
    f.assertOld();
    assert.equal(f.open().recover(), false);
  });
}

for (const target of ['characters.json', 'worldbooks.json']) {
  test(`${target} installed before writer throws is still undone`, (t) => {
    const f = fixture(t);
    f.controls.afterWrite = (name) => { if (name === target) throw ioError('post-rename failure'); };
    assert.throws(() => f.open().commit(roots('new')), /post-rename failure/);
    f.assertOld();
    assert.equal(fs.existsSync(f.file(JOURNAL)), false);
  });
}

for (const stopAfter of [JOURNAL, 'characters.json', 'worldbooks.json']) {
  test(`process exit after ${stopAfter} reopens and restores old bytes`, (t) => {
    const f = fixture(t);
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const path = require('node:path');
      const { createLibraryTransaction } = require(${JSON.stringify(require.resolve('../main/library-transaction.js'))});
      createLibraryTransaction({
        directory: () => ${JSON.stringify(f.directory)},
        write: (file, data) => {
          fs.writeFileSync(file + '.tmp', JSON.stringify(data));
          fs.renameSync(file + '.tmp', file);
          if (path.basename(file) === ${JSON.stringify(stopAfter)}) process.exit(73);
        }
      }).commit(${JSON.stringify(roots('interrupted'))});
    `], { stdio: 'inherit' });
    assert.ifError(child.error);
    assert.equal(child.status, 73);
    assert.equal(fs.existsSync(f.file(JOURNAL)), true);
    assert.equal(f.open().recover(), true);
    f.assertOld();
    assert.equal(f.open().recover(), false);
  });
}

test('journal write failure never changes either target', (t) => {
  const f = fixture(t);
  f.controls.fail = (name) => { if (name === JOURNAL) throw ioError('journal failed'); };
  assert.throws(() => f.open().commit(roots('new')), /journal failed/);
  f.assertOld();
  assert.deepEqual(f.calls, [JOURNAL]);
  assert.equal(fs.existsSync(f.file(JOURNAL)), false);
});

test('writer failure after journal installation leaves valid undo and untouched targets', (t) => {
  const f = fixture(t);
  f.controls.afterWrite = (name) => { if (name === JOURNAL) throw ioError('after journal rename'); };
  assert.throws(() => f.open().commit(roots('new')), /after journal rename/);
  f.assertOld();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file(JOURNAL), 'utf8')), f.journal());
  assert.equal(f.open().recover(), true);
  f.assertOld();
});

for (const suffix of ['', '.backup']) {
  test(`journal${suffix} deletion failure preserves primary undo and recovery is idempotent`, (t) => {
    const f = fixture(t);
    f.controls.afterWrite = (name) => {
      if (name === JOURNAL) fs.copyFileSync(f.file(JOURNAL), f.file(JOURNAL + '.backup'));
    };
    const unlink = fs.unlinkSync;
    const mocked = t.mock.method(fs, 'unlinkSync', (target) => {
      if (target === f.file(JOURNAL + suffix)) throw ioError('cleanup blocked');
      return unlink(target);
    });
    assert.throws(() => f.open().commit(roots('new')), /cleanup blocked/);
    f.assertOld();
    assert.equal(fs.existsSync(f.file(JOURNAL)), true);
    assert.throws(() => f.open().recover(), /cleanup blocked/);
    f.assertOld();
    mocked.mock.restore();
    assert.equal(f.open().recover(), true);
    f.assertOld();
    assert.equal(f.open().recover(), false);
    assert.equal(fs.existsSync(f.file(JOURNAL + '.backup')), false);
  });
}

test('recovery restores arbitrary original bytes, keeps existing backups, and removes originally missing files', (t) => {
  const f = fixture(t);
  const original = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x7d, 0x0a]);
  f.seedJournal(f.journal({ characters: original, worldbooks: null }));
  fs.writeFileSync(f.file('characters.json.backup'), 'do not overwrite this backup');
  assert.equal(f.open().recover(), true);
  assert.deepEqual(fs.readFileSync(f.file('characters.json')), original);
  assert.equal(fs.readFileSync(f.file('characters.json.backup'), 'utf8'), 'do not overwrite this backup');
  assert.equal(fs.existsSync(f.file('worldbooks.json')), false);
});

test('initial save with missing targets undoes creation after target failure', (t) => {
  const f = fixture(t);
  for (const key of keys) fs.unlinkSync(f.file(key + '.json'));
  f.controls.fail = (name) => { if (name === 'worldbooks.json') throw ioError('new target failed'); };
  assert.throws(() => f.open().commit(roots('new')), /new target failed/);
  for (const key of keys) assert.equal(fs.existsSync(f.file(key + '.json')), false);
  assert.equal(fs.existsSync(f.file(JOURNAL)), false);
});

test('bad journals are rejected and preserved, without any target or writer changes', (t) => {
  const f = fixture(t);
  const malformed = [
    '{not json', 'null', '[]',
    JSON.stringify({ ...f.journal(), version: 2 }),
    JSON.stringify({ ...f.journal(), encoding: 'utf8' }),
    JSON.stringify({ ...f.journal(), path: '../arbitrary.json' }),
    JSON.stringify({ ...f.journal(), before: { characters: null } }),
    JSON.stringify({ ...f.journal(), before: { characters: '../arbitrary.json', worldbooks: null } }),
    JSON.stringify({ ...f.journal(), before: { characters: 12, worldbooks: null } }),
    JSON.stringify({ ...f.journal(), before: { characters: '', worldbooks: null, filename: 'other.json' } })
  ];
  for (const text of malformed) {
    fs.writeFileSync(f.file(JOURNAL), text);
    fs.writeFileSync(f.file(JOURNAL + '.backup'), JSON.stringify(f.journal()));
    assert.throws(() => f.open().recover(), /Invalid library undo journal/);
    assert.throws(() => f.open().commit(roots('new')), /Invalid library undo journal/);
    assert.equal(fs.readFileSync(f.file(JOURNAL), 'utf8'), text);
    f.assertOld();
  }
  assert.deepEqual(f.calls, []);
});

test('missing journal is no-op and does not read or revive a backup journal', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file(JOURNAL + '.backup'), 'corrupt backup');
  assert.equal(f.open().recover(), false);
  f.assertOld();
  assert.deepEqual(f.calls, []);
});

test('commit first undoes pending transaction even when next snapshot is invalid', (t) => {
  const f = fixture(t);
  f.seedJournal();
  for (const key of keys) fs.writeFileSync(f.file(key + '.json'), JSON.stringify(roots('partial')[key]));
  assert.throws(() => f.open().commit({ characters: { characters: [] } }), /Invalid collection root/);
  f.assertOld();
  assert.equal(fs.existsSync(f.file(JOURNAL)), false);
  assert.deepEqual(f.calls, []);
});

test('unresolved recovery blocks the next journal and all new writes', (t) => {
  const f = fixture(t);
  f.seedJournal();
  const text = fs.readFileSync(f.file(JOURNAL), 'utf8');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.file('worldbooks.json')) throw ioError('old recovery blocked');
    return rename(source, destination);
  });
  assert.throws(() => f.open().commit(roots('new')), /old recovery blocked/);
  assert.equal(fs.readFileSync(f.file(JOURNAL), 'utf8'), text);
  assert.deepEqual(f.calls, []);
});

test('both snapshots are validated before journal creation including serialized shape and duplicates', (t) => {
  const f = fixture(t);
  const invalid = [null, {}, { characters: { characters: [] } }];
  for (const key of keys) {
    for (const root of [[], null, {}, { [key]: [null] }, { [key]: [{ id: '' }] },
      { [key]: [{ id: 1 }] }, { [key]: [{ id: ' spaced ' }] }, { [key]: [{ id: 'a' }, { id: 'a' }] }]) {
      invalid.push({ ...roots('new'), [key]: root });
    }
    invalid.push({ ...roots('new'), [key]: { [key]: [], toJSON: () => ({ [key]: [{ id: '' }] }) } });
  }
  const circular = roots('new');
  circular.worldbooks.circular = circular;
  invalid.push(circular);
  const bigint = roots('new');
  bigint.worldbooks.extra = 1n;
  invalid.push(bigint);
  for (const value of invalid) {
    assert.throws(() => f.open().commit(value));
    f.assertOld();
    assert.equal(fs.existsSync(f.file(JOURNAL)), false);
  }
  assert.deepEqual(f.calls, []);
});

test('target read errors other than ENOENT never become absent before-images', (t) => {
  const f = fixture(t);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === f.file('worldbooks.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(target, ...args);
  });
  assert.throws(() => f.open().commit(roots('new')), /denied/);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.file(JOURNAL)), false);
});

test('journal read errors other than ENOENT propagate without fallback', (t) => {
  const f = fixture(t);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === f.file(JOURNAL)) throw Object.assign(new Error('journal denied'), { code: 'EACCES' });
    return read(target, ...args);
  });
  assert.throws(() => f.open().recover(), /journal denied/);
  assert.throws(() => f.open().commit(roots('new')), /journal denied/);
  assert.deepEqual(f.calls, []);
});
