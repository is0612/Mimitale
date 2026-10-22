'use strict';

// tools/test-record-store.js
// Run with: node --test tools/test-record-store.js
// Electron and data-dir are isolated before requiring store.js; no real data is touched.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-record-store-'));
const dataRoot = path.join(tmpRoot, 'data');
const fakeElectron = {
  app: {
    getName: () => 'Mimitale',
    getPath: (name) => (name === 'appData' ? path.join(tmpRoot, 'appdata') : dataRoot),
    getAppPath: () => path.join(__dirname, '..'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value) => value,
    decryptString: (value) => value
  }
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const store = require('../main/store.js');
const { dataFile } = store;
const files = {
  characters: dataFile('characters.json'),
  worldbooks: dataFile('worldbooks.json'),
  presets: dataFile('presets.json')
};

const character = (id, name = id) => ({ id, name, description: `${name} description` });
const worldbook = (id, name = id) => ({ id, name, entries: [] });
const preset = (id, name = id) => ({ id, name, content: `${name} content` });
const read = (kind, suffix = '') => JSON.parse(fs.readFileSync(files[kind] + suffix, 'utf8'));
const write = (kind, value) => {
  fs.mkdirSync(path.dirname(files[kind]), { recursive: true });
  fs.writeFileSync(files[kind], JSON.stringify(value, null, 2), 'utf8');
};
const clean = (kind) => {
  for (const suffix of ['', '.backup', '.tmp']) fs.rmSync(files[kind] + suffix, { force: true });
};

// Queue state is process-global, so every test awaits its writes and uses unique ids.
test('three record stores provide CRUD and first ENOENT loads as empty', async () => {
  for (const kind of ['characters', 'worldbooks', 'presets']) {
    clean(kind);
    const item = kind === 'characters' ? character(`crud-${kind}`) : kind === 'worldbooks' ? worldbook(`crud-${kind}`) : preset(`crud-${kind}`);
    // Explicit API names keep this assertion readable and verify all three exports.
    const singular = kind === 'characters' ? 'Character' : kind === 'worldbooks' ? 'Worldbook' : 'Preset';
    assert.equal(store[`load${singular}`]('missing-first'), null);
    const saved = await store[`save${singular}`](item);
    assert.equal(saved.id, item.id);
    assert.equal((await store[`load${singular}`](item.id)).id, item.id);
    const deleted = await store[`delete${singular}`](item.id);
    assert.deepEqual(deleted, { id: item.id, deleted: true });
    assert.equal(await store[`load${singular}`](item.id), null);
    assert.deepEqual(await store[`delete${singular}`](item.id), { id: item.id, deleted: false });
  }
});

test('same-tick different ids are serialized without loss, and same-id last write wins', async () => {
  clean('characters');
  await Promise.all([store.saveCharacter(character('parallel-a')), store.saveCharacter(character('parallel-b'))]);
  assert.deepEqual(read('characters').characters.map((r) => r.id).sort(), ['parallel-a', 'parallel-b']);

  const first = store.saveCharacter(character('last-write', 'first'));
  const second = store.saveCharacter(character('last-write', 'second'));
  await Promise.all([first, second]);
  assert.equal(read('characters').characters.find((r) => r.id === 'last-write').name, 'second');
});

test('save snapshots its argument and rejects missing/invalid ids', async () => {
  clean('characters');
  const input = { ...character('snapshot', 'before'), tags: ['original'] };
  const pending = store.saveCharacter(input);
  input.name = 'after';
  input.id = 'mutated-id';
  input.tags.push('changed');
  const saved = await pending;
  assert.equal(saved.name, 'before');
  assert.equal(saved.id, 'snapshot');
  assert.deepEqual(saved.tags, ['original']);
  await assert.rejects(store.saveCharacter({ name: 'no id' }), /Record id/);
  await assert.rejects(store.saveCharacter({ id: '  bad  ', name: 'x' }), /Record id/);
  await assert.rejects(store.deleteCharacter(''), /Record id/);
  assert.throws(() => store.loadCharacter('  bad  '), /Record id/);
});

test('invalid and duplicate on-disk records are rejected without being normalized away', async () => {
  clean('characters');
  write('characters', { characters: [{ id: 'dup' }, { id: 'dup' }] });
  await assert.rejects(store.saveCharacter(character('new')), /Duplicate record id/);
  write('characters', { characters: [{ id: 42 }] });
  assert.throws(() => store.loadCharacter('x'), /Record id/);
});

test('single-record writes preserve collection root metadata while normalizing unknown record fields', async () => {
  clean('worldbooks');
  write('worldbooks', {
    libraryVersion: 7,
    ownerNote: 'keep this root field',
    worldbooks: [{ id: 'metadata-book', name: 'Book', entries: [], unknownPeer: 'drop this' }]
  });
  await store.saveWorldbook({ id: 'metadata-next', name: 'Next', entries: [], unknownPeer: 'drop this too' });
  const saved = read('worldbooks');
  assert.equal(saved.libraryVersion, 7);
  assert.equal(saved.ownerNote, 'keep this root field');
  assert.equal(saved.worldbooks.find((item) => item.id === 'metadata-book').unknownPeer, 'drop this');
  assert.equal(saved.worldbooks.find((item) => item.id === 'metadata-next').unknownPeer, undefined);
});

test('save and delete in the same tick serialize in invocation order', async () => {
  clean('characters');
  await store.saveCharacter(character('order-existing'));
  const save = store.saveCharacter(character('order-existing', 'saved-again'));
  const remove = store.deleteCharacter('order-existing');
  await Promise.all([save, remove]);
  assert.equal(await store.loadCharacter('order-existing'), null);

  const removeFirst = store.deleteCharacter('order-new');
  const saveAfter = store.saveCharacter(character('order-new'));
  await Promise.all([removeFirst, saveAfter]);
  assert.equal((await store.loadCharacter('order-new')).id, 'order-new');
});

test('corrupt primary and backup refuses mutation without changing either byte-for-byte', async () => {
  const primary = '{not-json-primary';
  const backup = '{not-json-backup';
  fs.writeFileSync(files.characters, primary, 'utf8');
  fs.writeFileSync(files.characters + '.backup', backup, 'utf8');
  await assert.rejects(store.saveCharacter(character('both-bad')), /Cannot read characters/);
  assert.equal(fs.readFileSync(files.characters, 'utf8'), primary);
  assert.equal(fs.readFileSync(files.characters + '.backup', 'utf8'), backup);
});

test('missing primary with bad backup and primary/backup read failures reject safely', async () => {
  clean('characters');
  fs.writeFileSync(files.characters + '.backup', '{bad-backup', 'utf8');
  await assert.rejects(store.saveCharacter(character('missing-primary')), /Cannot read characters/);
  clean('characters');
  const originalRead = fs.readFileSync;
  let mode = 'primary';
  fs.writeFileSync(files.characters, JSON.stringify({ characters: [character('read-protected')] }), 'utf8');
  fs.writeFileSync(files.characters + '.backup', JSON.stringify({ characters: [character('backup-protected')] }), 'utf8');
  fs.readFileSync = function injectedRead(file, encoding) {
    if (mode === 'primary' && file === files.characters) {
      const err = new Error('primary denied');
      err.code = 'EACCES';
      throw err;
    }
    if (mode === 'backup' && file === files.characters + '.backup') {
      const err = new Error('backup denied');
      err.code = 'EACCES';
      throw err;
    }
    return originalRead.apply(this, arguments);
  };
  try {
    assert.throws(() => store.loadCharacter('read-protected'), /primary denied/);
    await assert.rejects(store.saveCharacter(character('denied-primary-write')), /primary denied/);
    mode = 'backup';
    fs.writeFileSync(files.characters, '{corrupt-primary', 'utf8');
    assert.throws(() => store.loadCharacter('backup-protected'), /backup denied/);
    await assert.rejects(store.saveCharacter(character('denied-backup-write')), /backup denied/);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('backup recovery copy failure preserves corrupt primary and valid backup', async () => {
  clean('characters');
  const corrupt = '{corrupt-primary';
  const good = JSON.stringify({ characters: [character('copy-good')] });
  fs.writeFileSync(files.characters, corrupt, 'utf8');
  fs.writeFileSync(files.characters + '.backup', good, 'utf8');
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = function injectedCopy(source, target) {
    if (source === files.characters + '.backup' && target === files.characters) {
      const err = new Error('restore copy failed');
      err.code = 'EACCES';
      throw err;
    }
    return originalCopy.apply(this, arguments);
  };
  try {
    await assert.rejects(store.saveCharacter(character('copy-mutation')), /restore copy failed/);
  } finally {
    fs.copyFileSync = originalCopy;
  }
  assert.equal(fs.readFileSync(files.characters, 'utf8'), corrupt);
  assert.equal(fs.readFileSync(files.characters + '.backup', 'utf8'), good);
});

test('recovery followed by primary rename failure preserves good backup and queue recovers', async () => {
  clean('characters');
  const corrupt = '{corrupt-primary-again';
  const good = JSON.stringify({ characters: [character('rename-good')] });
  fs.writeFileSync(files.characters, corrupt, 'utf8');
  fs.writeFileSync(files.characters + '.backup', good, 'utf8');
  const originalRename = fs.renameSync;
  let fail = true;
  fs.renameSync = function injectedRename(source, target) {
    if (fail && target === files.characters) {
      const err = new Error('recovery rename failed');
      err.code = 'ENOSPC';
      throw err;
    }
    return originalRename.apply(this, arguments);
  };
  try {
    await assert.rejects(store.saveCharacter(character('rename-mutation')), /写入失败/);
  } finally {
    fail = false;
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(files.characters + '.backup', 'utf8'), good);
  await store.saveCharacter(character('rename-continues'));
  assert.equal((await store.loadCharacter('rename-continues')).id, 'rename-continues');
});

test('good backup is used, restored, and then safely updated', async () => {
  const good = JSON.stringify({ characters: [character('recovered')] });
  fs.writeFileSync(files.characters, '{broken', 'utf8');
  fs.writeFileSync(files.characters + '.backup', good, 'utf8');
  assert.equal((await store.loadCharacter('recovered')).id, 'recovered');
  await store.saveCharacter(character('after-recovery'));
  assert.deepEqual(read('characters').characters.map((r) => r.id), ['recovered', 'after-recovery']);
  assert.deepEqual(read('characters', '.backup').characters.map((r) => r.id), ['recovered']);
});

test('write and rename failures reject, and the shared queue continues after recovery', async () => {
  for (const [operation, inject] of [
    ['write', 'writeFileSync'],
    ['rename', 'renameSync']
  ]) {
    clean('worldbooks');
    const original = fs[inject];
    let fail = true;
    fs[inject] = function injectedFailure(source, target) {
      const destination = inject === 'writeFileSync' ? source : target;
      if (fail && destination === (inject === 'writeFileSync' ? files.worldbooks + '.tmp' : files.worldbooks)) {
        const err = new Error(`injected ${operation} failure`);
        err.code = 'ENOSPC';
        throw err;
      }
      return original.apply(this, arguments);
    };
    try {
      await assert.rejects(store.saveWorldbook(worldbook(`${operation}-failed`)), /写入失败/);
    } finally {
      fail = false;
      fs[inject] = original;
    }
    await store.saveWorldbook(worldbook(`${operation}-continues`));
    assert.equal((await store.loadWorldbook(`${operation}-continues`)).id, `${operation}-continues`);
  }
});

test('worldbooks and presets reject new records at MAX=200 but allow update and delete', async () => {
  for (const [kind, singular, make] of [
    ['worldbooks', 'Worldbook', worldbook],
    ['presets', 'Preset', preset]
  ]) {
    clean(kind);
    const list = Array.from({ length: 200 }, (_, i) => make(`${kind}-full-${i}`));
    await store[`save${kind[0].toUpperCase() + kind.slice(1)}`]({ [kind]: list });
    await assert.rejects(store[`save${singular}`](make(`${kind}-new`)), /Collection limit reached/);
    await store[`save${singular}`](make(`${kind}-full-17`, 'updated'));
    assert.equal((await store[`load${singular}`](`${kind}-full-17`)).name, 'updated');

    // A pre-existing over-limit library is not silently evicted by an update.
    const overLimit = Array.from({ length: 201 }, (_, i) => make(`${kind}-over-${i}`));
    write(kind, { [kind]: overLimit });
    await store[`save${singular}`](make(`${kind}-over-17`, 'updated-over-limit'));
    assert.equal(read(kind)[kind].length, 201);
    assert.equal(read(kind)[kind].find((item) => item.id === `${kind}-over-17`).name, 'updated-over-limit');

    // Restore the exactly-full fixture for the delete/new-record assertions below.
    await store[`save${kind[0].toUpperCase() + kind.slice(1)}`]({ [kind]: list });
    assert.deepEqual(await store[`delete${singular}`](`${kind}-full-17`), { id: `${kind}-full-17`, deleted: true });
    await store[`save${singular}`](make(`${kind}-new-after-delete`));
    assert.equal((await store[`load${singular}`](`${kind}-new-after-delete`)).id, `${kind}-new-after-delete`);
    assert.ok(fs.existsSync(files[kind] + '.backup'), `${kind} backup should exist`);
  }
});

test('batch changes are atomic, preserve unrelated records/root fields, and snapshot input', async () => {
  clean('worldbooks');
  write('worldbooks', {
    libraryVersion: 7,
    ownerNote: 'preserve',
    worldbooks: [worldbook('batch-peer'), worldbook('batch-update', 'before')]
  });
  const payload = { upserts: [worldbook('batch-update', 'after'), worldbook('batch-new')], deletes: [] };
  const pending = store.applyWorldbookChanges(payload);
  payload.upserts[0].name = 'mutated-after-call';
  const ack = await pending;
  assert.deepEqual(ack.upserts.map((item) => item.name), ['after', 'batch-new']);
  assert.deepEqual(ack.deletes, []);
  assert.equal(read('worldbooks').libraryVersion, 7);
  assert.equal(read('worldbooks').ownerNote, 'preserve');
  assert.deepEqual(read('worldbooks').worldbooks.map((item) => item.id), ['batch-peer', 'batch-update', 'batch-new']);
  assert.equal(read('worldbooks').worldbooks.find((item) => item.id === 'batch-update').name, 'after');

  const beforeFailure = fs.readFileSync(files.worldbooks, 'utf8');
  await assert.rejects(
    store.applyWorldbookChanges({ upserts: [worldbook('must-not-partially-write')], deletes: ['bad id '] }),
    /Record id/
  );
  assert.equal(fs.readFileSync(files.worldbooks, 'utf8'), beforeFailure);
  await assert.rejects(
    store.applyWorldbookChanges({ upserts: [worldbook('batch-duplicate'), worldbook('batch-duplicate')], deletes: [] }),
    /Duplicate upsert/
  );
  assert.equal(fs.readFileSync(files.worldbooks, 'utf8'), beforeFailure);
});

test('synchronous batch supersedes an earlier queued batch without replay', async () => {
  clean('characters');
  write('characters', { characters: [character('sync-peer')] });
  const queuedBatch = store.applyCharacterChanges({ upserts: [character('stale-queued')], deletes: [] });
  const syncAck = store.applyCharacterChangesNow({ upserts: [character('sync-final')], deletes: [] });
  assert.deepEqual(syncAck.upserts.map((item) => item.id), ['sync-final']);
  assert.deepEqual(syncAck.deletes, []);
  await assert.rejects(queuedBatch, (err) => /ERR_SUPERSEDED/.test(err.message));
  assert.deepEqual(read('characters').characters.map((item) => item.id), ['sync-peer', 'sync-final']);
});

test('legacy full-library save remains compatible before single-record operations', async () => {
  const whole = store.saveCharacters({ characters: [character('legacy-character')] });
  const single = store.saveCharacter(character('single-after-legacy'));
  await Promise.all([whole, single]);
  assert.deepEqual(read('characters').characters.map((r) => r.id), ['legacy-character', 'single-after-legacy']);
  await store.saveWorldbooks({ worldbooks: [worldbook('legacy-worldbook')] });
  await store.saveWorldbook(worldbook('single-after-legacy-worldbook'));
  assert.equal((await store.loadWorldbook('legacy-worldbook')).id, 'legacy-worldbook');
  // This only tests the documented sequencing compatibility; it does not claim mixed full/immediate saves avoid conflicts.
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
