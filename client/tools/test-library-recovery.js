'use strict';

// Run: node --test client/tools/test-library-recovery.js
// Import the real store with fake Electron and real isolated temporary files.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STORE = require.resolve('../main/store.js');
const JOURNAL = 'library-save.pending.json';
const KEYS = ['characters', 'worldbooks'];

// Self-contained so the crash/reopen subprocesses use the same isolation setup.
function openStore(directory, storeFile) {
  const Module = require('node:module');
  const path = require('node:path');
  const fakeElectron = {
    app: {
      getName: () => 'Mimitale-test',
      getPath: (name) => name === 'appData' ? path.join(directory, 'appdata') : directory,
      getAppPath: () => path.dirname(path.dirname(storeFile)),
      isPackaged: false
    },
    safeStorage: { isEncryptionAvailable: () => false }
  };
  delete require.cache[storeFile];
  delete require.cache[require.resolve(path.join(path.dirname(storeFile), 'data-dir.js'))];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const store = require(storeFile);
    if (store.dataFile('characters.json') !== path.join(directory, 'characters.json')) {
      throw new Error('Store escaped isolated data directory');
    }
    return store;
  } finally {
    Module._load = originalLoad;
  }
}

const character = (id, name) => ({ id, name, description: name + ' description' });
const worldbook = (id, name) => ({ id, name, entries: [] });
const changes = (name) => ({
  characters: {
    upserts: [character('local', name), character('added', name + '-added')],
    deletes: ['remove']
  },
  worldbooks: {
    upserts: [worldbook('book', name), worldbook('added-book', name + '-added')],
    deletes: ['remove-book']
  }
});
const errorWithCode = (message, code = 'ENOSPC') => Object.assign(new Error(message), { code });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-library-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  const old = {
    characters: {
      schemaVersion: 1, rootExtra: { legacy: ['keep', 7] },
      characters: [character('local', 'old'), character('remove', 'remove'),
        { id: 'peer', name: 'raw-peer', unknownLegacy: { preserve: ['raw', 9] } }]
    },
    worldbooks: {
      schemaVersion: 3, rootExtra: { legacy: ['keep-book', 8] },
      worldbooks: [worldbook('book', 'old'), worldbook('remove-book', 'remove'),
        { id: 'peer-book', name: 'raw-peer-book', entries: [], unknownLegacy: { preserve: [false, 11] } }]
    }
  };
  const oldBytes = {};
  for (const key of KEYS) {
    // Valid legacy JSON, deliberately unlike the store's serializer (no BOM).
    oldBytes[key] = Buffer.from(' \r\n' + JSON.stringify(old[key], null, '\t') + '\r\n');
    fs.writeFileSync(file(key + '.json'), oldBytes[key]);
  }
  const read = (key) => JSON.parse(fs.readFileSync(file(key + '.json'), 'utf8'));
  const assertOld = () => {
    for (const key of KEYS) assert.deepEqual(fs.readFileSync(file(key + '.json')), oldBytes[key]);
  };
  const assertNoJournal = () => {
    for (const suffix of ['', '.backup', '.tmp']) assert.equal(fs.existsSync(file(JOURNAL + suffix)), false);
  };
  const assertNames = (store, name) => {
    assert.equal(store.loadCharacters().characters.find((item) => item.id === 'local').name, name);
    assert.equal(store.loadWorldbooks().worldbooks.find((item) => item.id === 'book').name, name);
  };
  const assertNew = (name) => {
    for (const key of KEYS) {
      const current = read(key);
      const main = key === 'characters' ? 'local' : 'book';
      const peer = key === 'characters' ? 'peer' : 'peer-book';
      const added = key === 'characters' ? 'added' : 'added-book';
      const removed = key === 'characters' ? 'remove' : 'remove-book';
      assert.equal(current[key].find((item) => item.id === main).name, name);
      assert.equal(current[key].find((item) => item.id === added).name, name + '-added');
      assert.equal(current[key].some((item) => item.id === removed), false);
      assert.deepEqual(current[key].find((item) => item.id === peer), old[key][key].find((item) => item.id === peer));
      const { [key]: ignoredCurrent, ...currentRoot } = current;
      const { [key]: ignoredOld, ...oldRoot } = old[key];
      assert.deepEqual(currentRoot, oldRoot);
    }
  };
  const seedPending = () => {
    const journal = { version: 1, encoding: 'base64', before: {} };
    for (const key of KEYS) {
      journal.before[key] = oldBytes[key].toString('base64');
      const partial = structuredClone(old[key]);
      partial[key][0].name = 'partial';
      fs.writeFileSync(file(key + '.json'), JSON.stringify(partial));
      fs.writeFileSync(file(key + '.json.backup'), oldBytes[key]);
    }
    const bytes = Buffer.from(JSON.stringify(journal));
    fs.writeFileSync(file(JOURNAL), bytes);
    return bytes;
  };
  return { directory, file, old, oldBytes, read, assertOld, assertNew, assertNames, assertNoJournal,
    seedPending, open: () => openStore(directory, STORE) };
}

for (const mode of ['queued', 'sync']) {
  test(mode + ' joint save: second target ENOSPC undoes exact bytes, then retry commits both roots', async (t) => {
    const f = fixture(t);
    let store = f.open();
    f.assertNames(store, 'old');
    const rename = fs.renameSync;
    let failures = 0;
    const hook = t.mock.method(fs, 'renameSync', (source, destination) => {
      if (source === f.file('worldbooks.json.tmp') && destination === f.file('worldbooks.json') && failures === 0) {
        failures += 1;
        assert.equal(f.read('characters').characters[0].name, 'new');
        throw errorWithCode('ENOSPC injected worldbooks target rename');
      }
      return rename(source, destination);
    });
    if (mode === 'queued') await assert.rejects(store.applyLibraryChanges(changes('new')), /ENOSPC injected/);
    else assert.throws(() => store.applyLibraryChangesNow(changes('new')), /ENOSPC injected/);
    assert.equal(failures, 1);
    f.assertOld();
    f.assertNames(store, 'old');
    f.assertNoJournal();
    for (const key of KEYS) assert.deepEqual(fs.readFileSync(f.file(key + '.json.backup')), f.oldBytes[key]);
    store = f.open();
    f.assertNames(store, 'old');
    f.assertOld();
    hook.mock.restore();
    if (mode === 'queued') await store.applyLibraryChanges(changes('new'));
    else store.applyLibraryChangesNow(changes('new'));
    f.assertNew('new');
    f.assertNames(f.open(), 'new');
    f.assertNoJournal();
  });
}

test('invalid second-library payload cannot write the valid first library', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const write = fs.writeFileSync;
  const writes = [];
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    writes.push(target);
    return write(target, ...args);
  });
  const invalidBooks = [null, {}, { upserts: [], deletes: null },
    { upserts: [worldbook('duplicate', 'one'), worldbook('duplicate', 'two')], deletes: [] },
    { upserts: [worldbook('book', 'bad')], deletes: ['book'] }];
  for (const worldbooks of invalidBooks) {
    const payload = { ...changes('never'), worldbooks };
    await assert.rejects(store.applyLibraryChanges(payload));
    assert.throws(() => store.applyLibraryChangesNow(payload));
    f.assertOld();
    f.assertNoJournal();
  }
  assert.deepEqual(writes, []);
});

test('synchronous joint generation supersedes queued independent and joint batches', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const pending = [store.applyCharacterChanges({ upserts: [character('local', 'stale-character')], deletes: [] }),
    store.applyWorldbookChanges({ upserts: [worldbook('book', 'stale-book')], deletes: [] }),
    store.applyLibraryChanges(changes('stale-joint'))];
  const rejected = pending.map((promise) => assert.rejects(promise, /ERR_SUPERSEDED|superseded/i));
  store.applyLibraryChangesNow(changes('sync-final'));
  await Promise.all(rejected);
  f.assertNew('sync-final');
  f.assertNoJournal();
});

async function assertBlockedWrites(store, match) {
  for (const call of [
    () => store.applyLibraryChanges(changes('blocked')),
    () => store.applyCharacterChanges({ upserts: [character('local', 'blocked')], deletes: [] }),
    () => store.applyWorldbookChanges({ upserts: [worldbook('book', 'blocked')], deletes: [] }),
    () => store.saveCharacter(character('local', 'blocked')),
    () => store.saveWorldbook(worldbook('book', 'blocked')),
    () => store.deleteCharacter('local'),
    () => store.deleteWorldbook('book'),
    () => store.saveCharacters({ characters: [character('local', 'blocked')] }),
    () => store.saveWorldbooks({ worldbooks: [worldbook('book', 'blocked')] })
  ]) await assert.rejects(Promise.resolve().then(call), match);
  for (const call of [
    () => store.applyLibraryChangesNow(changes('blocked')),
    () => store.applyCharacterChangesNow({ upserts: [character('local', 'blocked')], deletes: [] }),
    () => store.applyWorldbookChangesNow({ upserts: [worldbook('book', 'blocked')], deletes: [] }),
    () => store.saveCharacters({ characters: [] }, { immediate: true }),
    () => store.saveWorldbooks({ worldbooks: [] }, { immediate: true })
  ]) assert.throws(call, match);
}

test('pending undo failure blocks both legacy loaders, fallback and every library writer until recovery succeeds', async (t) => {
  const f = fixture(t);
  let store = f.open();
  const journal = f.seedPending();
  const blockedBook = fs.readFileSync(f.file('worldbooks.json'));
  const rename = fs.renameSync;
  const hook = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.file('worldbooks.json')) throw errorWithCode('pending undo ENOSPC');
    return rename(source, destination);
  });
  for (let reopen = 0; reopen < 2; reopen += 1) {
    if (reopen) store = f.open();
    assert.throws(() => store.loadCharacters(), /pending undo ENOSPC/);
    assert.throws(() => store.loadWorldbooks(), /pending undo ENOSPC/);
    assert.throws(() => store.loadCharacter('local'), /pending undo ENOSPC/);
    assert.throws(() => store.loadWorldbook('book'), /pending undo ENOSPC/);
    for (const key of KEYS) assert.throws(() => store.loadJsonWithFallback(f.file(key + '.json')), /pending undo ENOSPC/);
    await assertBlockedWrites(store, /pending undo ENOSPC/);
    assert.deepEqual(fs.readFileSync(f.file(JOURNAL)), journal);
    assert.deepEqual(fs.readFileSync(f.file('worldbooks.json')), blockedBook);
    assert.deepEqual(fs.readFileSync(f.file('characters.json')), f.oldBytes.characters);
  }
  hook.mock.restore();
  f.assertNames(store, 'old');
  f.assertOld();
  f.assertNoJournal();
  await store.applyLibraryChanges(changes('recovered'));
  f.assertNew('recovered');
  f.assertNoJournal();
});

test('corrupt primary journal blocks loading and saving without using valid journal or library backups', async (t) => {
  const f = fixture(t);
  const store = f.open();
  const validJournal = f.seedPending();
  fs.writeFileSync(f.file(JOURNAL + '.backup'), validJournal);
  const before = Object.fromEntries(KEYS.map((key) => [key, fs.readFileSync(f.file(key + '.json'))]));
  for (const corrupt of ['{not-json', JSON.stringify({ version: 99, encoding: 'base64', before: { characters: null, worldbooks: null } })]) {
    fs.writeFileSync(f.file(JOURNAL), corrupt);
    assert.throws(() => store.loadCharacters(), /Invalid library undo journal/);
    assert.throws(() => store.loadWorldbooks(), /Invalid library undo journal/);
    await assertBlockedWrites(store, /Invalid library undo journal/);
    for (const key of KEYS) assert.deepEqual(fs.readFileSync(f.file(key + '.json')), before[key]);
    assert.equal(fs.readFileSync(f.file(JOURNAL), 'utf8'), corrupt);
    assert.deepEqual(fs.readFileSync(f.file(JOURNAL + '.backup')), validJournal);
    assert.throws(() => f.open().loadCharacters(), /Invalid library undo journal/);
  }
});

test('real store process exit after character rename is undone by a fresh process legacy load', (t) => {
  const f = fixture(t);
  const bootstrap = `const openStore = ${openStore.toString()};\nconst store = openStore(${JSON.stringify(f.directory)}, ${JSON.stringify(STORE)});`;
  const crash = spawnSync(process.execPath, ['-e', bootstrap + `
    const fs = require('node:fs');
    const rename = fs.renameSync;
    fs.renameSync = function (source, destination) {
      const result = rename(source, destination);
      if (destination === ${JSON.stringify(f.file('characters.json'))}) process.exit(73);
      return result;
    };
    store.applyLibraryChangesNow(${JSON.stringify(changes('interrupted'))});
    process.exit(74);
  `], { stdio: 'inherit' });
  assert.ifError(crash.error);
  assert.equal(crash.status, 73);
  assert.equal(fs.existsSync(f.file(JOURNAL)), true);
  assert.equal(f.read('characters').characters[0].name, 'interrupted');
  assert.deepEqual(fs.readFileSync(f.file('worldbooks.json')), f.oldBytes.worldbooks);
  const reopen = spawnSync(process.execPath, ['-e', bootstrap + `
    const assert = require('node:assert/strict');
    assert.equal(store.loadCharacters().characters.find((item) => item.id === 'local').name, 'old');
    assert.equal(store.loadWorldbooks().worldbooks.find((item) => item.id === 'book').name, 'old');
  `], { stdio: 'inherit' });
  assert.ifError(reopen.error);
  assert.equal(reopen.status, 0);
  f.assertOld();
  f.assertNoJournal();
});
