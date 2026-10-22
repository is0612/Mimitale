'use strict';

// Run: .\node_modules\electron\dist\electron.exe tools/test-library-close.js
// Only a temporary profile and a blank page are opened. The application entry,
// single-instance lock, real application page and private data are never loaded.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-library-close-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const read = (name) => JSON.parse(fs.readFileSync(path.join(profile, name), 'utf8'));
const seed = (name, value) => fs.writeFileSync(path.join(profile, name), JSON.stringify(value));
const passed = (name) => console.log(`PASS ${name}`);

async function pureTests() {
  const source = fs.readFileSync(path.join(root, 'renderer/js/data/libraryChanges.js'), 'utf8');
  const { createLibraryChanges } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let records = [{ id: 'a', name: 'old' }];
  let finish;
  const commits = [];
  const changes = createLibraryChanges({ records: () => records,
    save: (batch) => { commits.push(batch); return new Promise((resolve) => { finish = resolve; }); },
    saveNow: (batch) => commits.push(batch) });
  changes.markLoaded();
  records[0].name = 'inflight';
  const inflight = changes.flush();
  records[0].name = 'old';
  changes.flushNow();
  assert.equal(commits[1].upserts[0].name, 'old', 'reverted diff must override inflight write');
  finish();
  await inflight;
  changes.flushNow();
  assert.equal(commits.length, 2, 'late callback must not rewind acknowledged baseline');
  passed('pure: reverted diff and late inflight callback');

  let fail = true;
  const retryWrites = [];
  const retry = createLibraryChanges({ records: () => records, save: async () => {}, saveNow: (batch) => {
    if (fail) throw new Error('ENOSPC injected');
    retryWrites.push(batch);
  } });
  retry.markLoaded();
  records[0].name = 'retry';
  assert.throws(() => retry.flushNow(), /ENOSPC/);
  fail = false;
  retry.flushNow();
  assert.equal(retryWrites[0].upserts[0].name, 'retry');
  passed('pure: synchronous failure retains pending diff for retry');

  let a = [{ id: 'a', name: 'old' }];
  let b = [{ id: 'b', name: 'old' }];
  const diskA = [];
  const first = createLibraryChanges({ records: () => a, save: async (batch) => diskA.push(batch), saveNow: (batch) => diskA.push(batch) });
  const second = createLibraryChanges({ records: () => b, save: async () => { throw new Error('ENOSPC'); }, saveNow: () => {} });
  first.markLoaded(); second.markLoaded();
  a[0].name = 'changed'; b[0].name = 'changed';
  await first.flush();
  await assert.rejects(second.flush(), /ENOSPC/);
  a = [{ id: 'a', name: 'old' }]; b = [{ id: 'b', name: 'old' }]; // UI rollback
  first.flushNow();
  assert.equal(diskA.length, 2);
  assert.equal(diskA[1].upserts[0].name, 'old', 'rollback needs a compensating write, not markLoaded');
  passed('pure: partial cross-library success and UI rollback baseline compensation');

  const invalid = createLibraryChanges({ records: () => [{ name: 'legacy missing id' }], save() {}, saveNow() {} });
  assert.throws(() => invalid.markLoaded(), /ID/);
  passed('pure: missing ID is rejected at initialization baseline');
}

async function integrationTests() {
  seed('characters.json', { characters: [{ id: 'c1', name: 'original' }] });
  seed('worldbooks.json', { worldbooks: [{ id: 'w1', name: 'book', entries: [] }] });
  seed('presets.json', { presets: [{ id: 'p1', name: 'preset', entries: [] }] });
  seed('conversations.json', { conversations: [], activeId: null });
  const blank = path.join(profile, 'blank.html');
  fs.writeFileSync(blank, `<!doctype html><meta charset="utf-8"><title>library close test</title><div id="toast"></div><script src="${pathToFileURL(path.join(root, 'main/panel-fields.js')).href}"></script>`);
  const store = require('../main/store.js');
  assert.equal(path.resolve(store.dataFile('characters.json')), path.join(profile, 'characters.json'), 'must use temporary profile');
  require('../main/ipc.js').registerIpc();
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  await win.loadFile(blank);
  const url = (relative) => JSON.stringify(pathToFileURL(path.join(root, relative)).href);
  const run = (body) => win.webContents.executeJavaScript(`(async () => { ${body} })()`);
  await run(`
    window.testState = (await import(${url('renderer/js/core/state.js')})).state;
    window.testPersist = await import(${url('renderer/js/data/persist.js')});
    const dom = await import(${url('renderer/js/core/dom.js')});
    dom.el.toast = document.getElementById('toast');
    for (const key of ['applyCharacterChanges', 'applyCharacterChangesNow', 'applyWorldbookChanges', 'applyWorldbookChangesNow', 'applyPresetChanges', 'applyPresetChangesNow']) {
      if (typeof window.mimitale[key] !== 'function') throw new Error('Batch API not ready: ' + key);
    }
    testState.characters = (await mimitale.getCharacters()).characters;
    testState.worldbooks = (await mimitale.getWorldbooks()).worldbooks;
    testState.dialoguePresets = (await mimitale.getPresets()).presets;
    testPersist.markCharactersLoaded(); testPersist.markWorldbooksLoaded(); testPersist.markPresetsLoaded();
    testState.characters[0].name = 'local edited';
  `);
  await store.saveCharacter({ id: 'peer', name: 'external peer' });
  await run('testPersist.flushLibrariesNow();');
  assert.equal(read('characters.json').characters.find((item) => item.id === 'c1').name, 'local edited');
  assert.equal(read('characters.json').characters.find((item) => item.id === 'peer').name, 'external peer');
  passed('Electron: mark loaded -> local edit -> external peer -> close flush preserves peer');

  // Evaluate the exact production listener without importing the full application.
  const main = fs.readFileSync(path.join(root, 'renderer/js/main.js'), 'utf8');
  const start = main.indexOf("  window.addEventListener('beforeunload'");
  const end = main.indexOf('\n  });', start);
  assert.ok(start >= 0 && end > start, 'production beforeunload listener must be located');
  await run(`
    const startupDataLoaded = true;
    const api = window.mimitale;
    const { conversationsSavePayload, flushLibrariesNow } = testPersist;
    window.closeErrors = [];
    const showToast = (text) => closeErrors.push(text);
    ${main.slice(start, end + '\n  });'.length)}
  `);
  await run("testState.characters[0].name = 'after ENOSPC';");
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (path.resolve(String(file)) === path.join(profile, 'characters.json.tmp')) {
      const err = new Error('ENOSPC: injected disk full'); err.code = 'ENOSPC'; throw err;
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    const result = await run(`try { testPersist.flushLibrariesNow(); return { threw: false }; }
      catch (err) { return { threw: true, message: err.message }; }`);
    assert.equal(result.threw, true);
    assert.match(result.message, /ENOSPC/);
    assert.equal(read('characters.json').characters.find((item) => item.id === 'c1').name, 'local edited');
    const blocked = new Promise((resolve) => win.webContents.once('will-prevent-unload', resolve));
    win.close();
    await blocked;
    assert.equal(win.isDestroyed(), false, 'failed flush must block close');
    assert.match(await run('return closeErrors.join(" ");'), /ENOSPC/);
    passed('Electron: ENOSPC flush throws synchronously and real beforeunload blocks closing');
  } finally {
    fs.writeFileSync = originalWrite;
  }
  await run('testPersist.flushLibrariesNow();');
  assert.equal(read('characters.json').characters.find((item) => item.id === 'c1').name, 'after ENOSPC');
  passed('Electron: repaired flush retries pending diff');

  await run("testState.dialoguePresets[0].name = 'preset saved on close';");
  const closed = new Promise((resolve) => win.once('closed', resolve));
  win.close();
  await closed;
  assert.equal(read('presets.json').presets.find((item) => item.id === 'p1').name, 'preset saved on close');
  assert.ok(read('characters.json').characters.some((item) => item.id === 'peer'));
  passed('Electron: production beforeunload flushes pending preset and closes');

  // Report historical fixture behavior without depending on it remaining broken.
  seed('presets.json', { presets: [{ name: 'legacy preset missing id' }] });
  const legacy = store.loadPresets().presets[0];
  console.log(legacy && legacy.id ? 'INFO legacy preset ID normalized by store' : 'INFO legacy preset missing ID survives load; strict markPresetsLoaded rejects it (startup isolation is handled by main.js)');
}

const watchdog = setTimeout(() => { console.error('FAIL watchdog timeout'); app.exit(2); }, 45000);
app.whenReady().then(async () => {
  await pureTests();
  await integrationTests();
  clearTimeout(watchdog);
  console.log(`All library close tests passed. Temporary profile: ${profile}`);
  app.exit(0);
}).catch((error) => {
  clearTimeout(watchdog);
  console.error('FAIL', error.stack || error);
  console.error(`Temporary profile retained: ${profile}`);
  app.exit(1);
});
