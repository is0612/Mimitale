'use strict';

// Run real renderer logic with IPC/DOM stubs; never contact a model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fields = require('../main/panel-fields.js');
const source = (rel) => fs.readFileSync(path.join(__dirname, '..', 'renderer/js', rel), 'utf8')
  .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/\bexport /g, '');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function harness() {
  const card = { id: 'npc', name: 'NPC', attributes: [{ name: '体力', value: '100', type: 'meter', max: 100 }] };
  const playerCard = { id: 'hero', name: 'Hero', attributes: [{ name: '金币', value: '20', type: 'number' }] };
  const convo = { id: 'a', characterId: 'npc', player: { name: 'Hero', characterId: 'hero' }, messages: [], panelFields: [], panel: {}, panelDefs: {}, panelManual: {}, optionsSpec: { count: 4 }, options: [], summaries: [] };
  const state = { conversations: [convo], activeId: 'a', streaming: false };
  const response = deferred();
  let sends = 0, world = Promise.resolve('');
  const ctx = vm.createContext({ ...fields, state, console, Date, now: () => 1000, asArray: value => Array.isArray(value) ? value : [],
    characterAttrs: c => c.attributes || [], characterById: id => [card, playerCard].find(c => c.id === id), characters: () => [card, playerCard],
    convoWorldbookIds: () => [], worldbookById: () => null, worldbookCharacters: () => [], stripEmoTags: x => x,
    persistConversations() {}, activeConvo: () => state.conversations.find(c => c.id === state.activeId), showToast() {}, refreshAll() {}, renderAll() {},
    confirmDialog: async () => true, shiftSummariesForRemoval() {}, resetPetTurns() {}, el: { input: { focus() {} } },
    ensureConvoEndpoint: () => ({ provider: { id: 'p' }, model: 'm' }), uid: () => 'request', matchWorldbookSections: () => world,
    recallSection: async () => '', buildApiMessages: () => [], api: { sendChat: () => { sends++; return response.promise; } },
  });
  for (const rel of ['data/panel.js', 'data/suggestions.js', 'data/convoState.js', 'views/convoActions.js', 'views/suggestionsUi.js']) vm.runInContext(source(rel), ctx, { filename: rel });
  return { ctx, convo, state, response, sends: () => sends, setWorld: value => { world = value; } };
}
const options = c => Array.from(c.options);
(async () => {
  let h = harness();
  h.convo.messages = [
    { role: 'assistant', content: '开场\n【体力】：90/100\n【剧情选项】：等候 / 离开', at: 10 },
    { role: 'assistant', content: '受伤\n【体力】：40/100\n【秘密】：已发现\n【剧情选项】：包扎 / 逃跑', at: 20 },
  ];
  h.ctx.syncConvoPanel(h.convo);
  h.ctx.syncConvoOptions(h.convo);
  await h.ctx.removeMessage(1);
  assert.equal(h.convo.panel['体力\0npc'], '90/100', 'delete tail restores remaining-history value');
  assert.equal(h.convo.panel['秘密\0npc'], undefined, 'only occurrence does not survive as cached value');
  assert.ok(h.convo.panelFields.includes('秘密\0npc'), 'field schema is retained');
  assert.deepEqual(options(h.convo), ['等候', '离开']);
  await h.ctx.removeMessage(0);
  assert.equal(h.convo.panel['体力\0npc'], '100/100', 'delete last occurrence restores template initial value');
  assert.deepEqual(options(h.convo), []);

  h = harness();
  h.convo.messages = [{ role: 'assistant', content: '【体力】：10/100', at: 10 }];
  h.ctx.syncConvoPanel(h.convo);
  h.convo.panel['体力\0npc'] = '70/100';
  h.convo.panelManual['体力\0npc'] = 15;
  h.ctx.rebuildConvoDerivedState(h.convo);
  assert.equal(h.convo.panel['体力\0npc'], '70/100', 'unoverwritten manual edit survives ordinary rebuild');
  h.convo.messages.push({ role: 'assistant', content: '【体力】：30/100', at: 20 });
  h.ctx.syncConvoPanel(h.convo);
  await h.ctx.removeMessage(1);
  assert.equal(h.convo.panel['体力\0npc'], '10/100', 'deleted model value is not mistaken for old manual value');
  h.convo.options = ['旧选项'];
  h.convo.checkpoints = [{ panel: { story: 'stale' } }];
  await h.ctx.clearConvo();
  assert.equal(h.convo.characterId, 'npc');
  assert.equal(h.convo.player.characterId, 'hero');
  assert.equal(h.convo.panel['体力\0npc'], '100/100');
  assert.equal(h.convo.panel['金币\0player'], '20');
  assert.equal(h.convo.panel['姓名\0player'], 'Hero');
  assert.equal(Object.keys(h.convo.panelManual).length, 0);
  assert.equal(h.convo.checkpoints.length, 1, 'clear preserves explicitly saved restore points');
  assert.deepEqual(options(h.convo), []);

  for (const mode of ['new-turn', 'clear', 'stale-failure', 'version-only', 'removed', 'options-changed']) {
    h = harness();
    h.convo.messages = [{ role: 'assistant', content: '旧轮', at: 10 }];
    h.convo.options = ['旧选项'];
    const pending = h.ctx.requestMoreOptions(h.convo);
    // Flush preparation across the VM's Promise realm before mutating the round.
    await new Promise(setImmediate);
    assert.equal(h.sends(), 1);
    if (mode === 'clear') await h.ctx.clearConvo();
    else if (mode === 'version-only') h.ctx.invalidateConvoDerivedRequests(h.convo);
    else if (mode === 'removed') h.state.conversations = [];
    else if (mode === 'options-changed') h.convo.options = ['新选项'];
    else { h.convo.messages.push({ role: 'user', content: '新轮', at: 20 }); h.convo.options = ['新轮选项']; }
    if (mode === 'stale-failure') h.response.reject(new Error('old request failed'));
    else h.response.resolve({ ok: true, content: '【剧情选项】：过期选项 / 不得落地' });
    assert.equal(await pending, false, mode);
    assert.ok(!h.convo.options.includes('过期选项'), mode);
    if (mode === 'clear') assert.deepEqual(options(h.convo), []);
    if (mode === 'stale-failure') assert.deepEqual(options(h.convo), ['新轮选项'], 'stale catch cannot restore old options');
  }
  h = harness();
  h.convo.messages = [{ role: 'assistant', content: '有效轮次', at: 10 }];
  const valid = h.ctx.requestMoreOptions(h.convo);
  h.response.resolve({ ok: true, content: '【剧情选项】：有效选项 / 另一个' });
  assert.equal(await valid, true);
  assert.deepEqual(options(h.convo), ['有效选项', '另一个']);

  h = harness();
  h.convo.messages = [{ role: 'assistant', content: '旧轮', at: 10 }];
  const world = deferred(); h.setWorld(world.promise);
  const preparing = h.ctx.requestMoreOptions(h.convo);
  h.ctx.invalidateConvoDerivedRequests(h.convo);
  world.resolve('');
  assert.equal(await preparing, false);
  assert.equal(h.sends(), 0, 'invalidated preparation never dispatches IPC');

  // Imported/legacy history can contain null placeholders; context building skips
  // them, so asking for options must do the same without leaving the global lock.
  h = harness();
  h.convo.messages = [null, { role: 'assistant', content: '有效轮次', at: 10 }, null];
  const withNullHistory = h.ctx.requestMoreOptions(h.convo);
  h.response.resolve({ ok: true, content: '【剧情选项】：检查房间 / 离开房间' });
  assert.equal(await withNullHistory, true);
  assert.deepEqual(options(h.convo), ['检查房间', '离开房间']);
  assert.equal(await h.ctx.requestMoreOptions(h.convo), true, 'null history must not leave options request permanently busy');
  h = harness();
  h.convo.messages = [null];
  assert.equal(await h.ctx.requestMoreOptions(h.convo), false, 'null-only history is empty');

  // Execute the real list-item keyboard handler with a native nested button target.
  const listSource = source('views/chatList.js');
  const keyboard = listSource.match(/onkeydown: (\(event\) => \{[\s\S]*?\n          \}),/)[1];
  let switches = 0, prevented = 0;
  const handler = vm.runInNewContext(keyboard, { convo: { id: 'a' }, switchConvo: () => { switches++; } });
  const row = {}, button = {};
  handler({ key: 'Enter', target: button, currentTarget: row, preventDefault: () => { prevented++; } });
  assert.equal(switches, 0); assert.equal(prevented, 0);
  handler({ key: ' ', target: row, currentTarget: row, preventDefault: () => { prevented++; } });
  assert.equal(switches, 1); assert.equal(prevented, 1);
  console.log('✓ chat derived-state, stale-options and nested-keyboard regressions passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
