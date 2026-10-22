'use strict';

// Real preload -> IPC -> store round trips, isolated from the application data.
// Run: electron --no-sandbox tools/test-record-ipc.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-record-ipc-'));
app.setPath('userData', root);
process.env.MIMITALE_DATA_DIR = root;
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let win;
  let failed = false;
  const watchdog = setTimeout(() => app.exit(2), 30000);
  try {
    require('../main/ipc.js').registerIpc();
    const page = path.join(root, 'blank.html');
    fs.writeFileSync(page, '<!doctype html><html><body></body></html>');
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    await win.loadFile(page);
    const results = await win.webContents.executeJavaScript(`(async () => {
      const results = [];
      const check = (name, pass) => results.push({ name, pass: !!pass });
      const api = window.mimitale;
      for (const [singular, plural] of [['Character', 'Characters'], ['Worldbook', 'Worldbooks'], ['Preset', 'Presets']]) {
        const key = plural.toLowerCase();
        const legacy = await api['save' + plural]({ [key]: [{ id: 'peer', name: 'existing', entries: [], content: 'rule' }] });
        check(key + ': legacy save still works', legacy[key].length === 1);
        const [one, two] = await Promise.all([
          api['save' + singular]({ id: 'one', name: 'first', content: 'one', entries: [] }),
          api['save' + singular]({ id: 'two', name: 'second', content: 'two', entries: [] })
        ]);
        check(key + ': save return values', one.id === 'one' && two.id === 'two');
        check(key + ': get-one round trip', (await api['get' + singular]('one')).name === 'first');
        check(key + ': missing id returns null', await api['get' + singular]('missing') === null);
        check(key + ': concurrent records preserve peer', (await api['get' + plural]())[key].length === 3);
        let rejected = false;
        try { await api['save' + singular]({ name: 'no id' }); } catch (_) { rejected = true; }
        check(key + ': invalid save rejects through IPC', rejected);
        check(key + ': delete result', (await api['delete' + singular]('one')).deleted === true);
        check(key + ': repeat delete is idempotent', (await api['delete' + singular]('one')).deleted === false);
        check(key + ': deletion persisted', await api['get' + singular]('one') === null);
        check(key + ': peer remains', (await api['get' + singular]('peer')).id === 'peer');

        const applyName = singular === 'Character' ? 'applyCharacterChanges' : singular === 'Worldbook' ? 'applyWorldbookChanges' : 'applyPresetChanges';
        const applyNowName = applyName + 'Now';
        const batchAck = await api[applyName]({ upserts: [{ id: 'batch-a', name: 'batch', content: 'batch', entries: [] }], deletes: ['two'] });
        check(key + ': async batch acknowledgement', batchAck.upserts[0].id === 'batch-a' && batchAck.deletes[0] === 'two');
        check(key + ': async batch persisted and peer retained', (await api['get' + plural]())[key].some((item) => item.id === 'peer') && !(await api['get' + plural]())[key].some((item) => item.id === 'two'));
        const syncAck = api[applyNowName]({ upserts: [{ id: 'batch-sync', name: 'sync', content: 'sync', entries: [] }], deletes: [] });
        check(key + ': sync batch acknowledgement', syncAck.upserts[0].id === 'batch-sync');
        check(key + ': sync batch persisted', (await api['get' + singular]('batch-sync')).id === 'batch-sync');
        let malformedRejected = false;
        try { await api[applyName]({ upserts: [{ id: 'bad-duplicate' }, { id: 'bad-duplicate' }], deletes: [] }); } catch (_) { malformedRejected = true; }
        check(key + ': duplicate batch ids reject', malformedRejected);
      }
      return results;
    })()`);
    for (const result of results) console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.name}`);
    assert.ok(results.every((result) => result.pass));
    // Fault injection is scoped to this isolated file; invoke must reject on disk failure.
    const target = path.join(root, 'characters.json');
    const originalRename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (to === target) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
      return originalRename.apply(this, arguments);
    };
    let errorPassed;
    try {
      errorPassed = await win.webContents.executeJavaScript(`window.mimitale.saveCharacter({id:'failed',name:'fail'}).then(() => false, error => /ENOSPC/.test(error.message))`);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(errorPassed, true, 'disk failure rejects preload invoke');
    assert.equal(require('../main/store.js').loadCharacter('failed'), null);
    const recovered = await win.webContents.executeJavaScript(`window.mimitale.saveCharacter({id:'after-failure',name:'recovered'})`);
    assert.equal(recovered.id, 'after-failure');
    console.log(`All passed: ${results.length + 3} IPC assertions`);
  } catch (error) {
    failed = true;
    console.error(error.stack || error);
  } finally {
    clearTimeout(watchdog);
    if (win && !win.isDestroyed()) win.destroy();
    // Chromium may retain handles until exit; only remove this test-owned directory.
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temporary profile may remain locked */ }
    app.exit(failed ? 1 : 0);
  }
}).catch((error) => { console.error(error); app.exit(1); });
