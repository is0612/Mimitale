'use strict';

// Run with Electron, e.g. `npm exec electron -- --no-sandbox tools/test-conversation-close.js`.
// Uses only an isolated temporary userData directory and a blank renderer page.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-conversation-close-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const passed = (name) => console.log(`PASS ${name}`);

async function main() {
  const store = require('../main/store.js');
  const ipc = require('electron').ipcMain;
  const originalOn = ipc.on;
  let syncHandler;
  ipc.on = function(channel, listener) {
    if (channel === 'conversations:save-sync') syncHandler = listener;
    return originalOn.call(this, channel, listener);
  };
  require('../main/ipc.js').registerIpc();
  ipc.on = originalOn;
  const invokeSyncHandler = (payload) => {
    const event = { returnValue: undefined };
    syncHandler(event, payload);
    assert.ok(event.returnValue && typeof event.returnValue === 'object');
    assert.equal(event.returnValue.result instanceof Promise, false);
    return event.returnValue;
  };
  assert.equal(path.resolve(store.dataFile('conversations.json')), path.join(profile, 'conversations.json'));

  const blank = path.join(profile, 'blank.html');
  fs.writeFileSync(blank, '<!doctype html><meta charset="utf-8"><title>conversation close</title>');
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  await win.loadFile(blank);
  const sync = (payload) => win.webContents.executeJavaScript(`window.mimitale.saveConversationsNow(${JSON.stringify(payload)})`);

  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (path.resolve(String(file)) === path.join(profile, 'conversations.json.tmp')) {
      const err = new Error('ENOSPC: injected disk full'); err.code = 'ENOSPC'; throw err;
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    const result = await win.webContents.executeJavaScript(`(() => { try { mimitale.saveConversationsNow({conversations:[{id:'fail'}],activeId:'fail'}); return 'no throw'; } catch (e) { return e.message; } })()`);
    assert.match(result, /ENOSPC/);
  } finally { fs.writeFileSync = originalWrite; }
  passed('Electron: sync ENOSPC ack throws to preload caller');

  const payload = { conversations: [{ id: 'persisted', updatedAt: 1, messages: [] }], activeId: 'persisted' };
  await sync(payload);
  const reopened = store.loadConversations();
  assert.equal(reopened.activeId, 'persisted');
  assert.equal(reopened.conversations[0].id, 'persisted');
  passed('Electron: successful sync save is readable from store');

  const oldQueued = store.saveConversations({ conversations: [{ id: 'queued' }], activeId: 'queued' });
  assert.equal(invokeSyncHandler({ conversations: [{ id: 'sync-wins' }], activeId: 'sync-wins' }).ok, true);
  await assert.rejects(oldQueued, (err) => err.code === 'ERR_SUPERSEDED');
  assert.equal(store.loadConversations().activeId, 'sync-wins');
  passed('Electron: successful immediate save supersedes queued snapshot');

  const stillQueued = store.saveConversations({ conversations: [{ id: 'queued-survives' }], activeId: 'queued-survives' });
  fs.writeFileSync = function(file, ...args) {
    if (path.resolve(String(file)) === path.join(profile, 'conversations.json.tmp')) {
      const err = new Error('ENOSPC: injected disk full'); err.code = 'ENOSPC'; throw err;
    }
    return originalWrite.call(this, file, ...args);
  };
  try {
    const response = invokeSyncHandler({ conversations: [{ id: 'sync-fails' }], activeId: 'sync-fails' });
    assert.equal(response.ok, false);
    assert.match(response.error, /ENOSPC/);
  } finally { fs.writeFileSync = originalWrite; }
  await stillQueued;
  assert.equal(store.loadConversations().activeId, 'queued-survives');
  passed('Electron: failed immediate save does not supersede queued write');

  const many = Array.from({ length: 105 }, (_, i) => ({ id: `c${i}`, updatedAt: i }));
  await sync({ conversations: many, activeId: 'c104' });
  const limited = store.loadConversations();
  assert.equal(limited.conversations.length, 100);
  assert.equal(limited.activeId, 'c104');
  await sync({ conversations: many, activeId: 'c0' });
  assert.notEqual(store.loadConversations().activeId, 'c0');
  passed('Electron: activeId validation and 100-conversation limit preserved');

  win.destroy();
  app.exit(0);
}

app.whenReady().then(main).catch((err) => {
  console.error(err.stack || err);
  app.exit(1);
});
