'use strict';

// Bare-Node behavioral regression: execute renderer modules with deferred IPC/DOM stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const moduleSource = (rel) => read(rel).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/\bexport /g, '');
function harness() {
  const convo = { id: 'a', messages: [], summaries: [] };
  const other = { id: 'b', messages: [{ role: 'assistant', content: 'other' }] };
  const state = { conversations: [convo, other], activeId: 'a', streaming: false, requestId: null, requestTarget: null, settings: {} };
  const world = deferred();
  const confirm = deferred();
  let sends = 0, confirmations = 0;
  const ctx = vm.createContext({
    state, console, CONFIG: {}, now: () => 1, uid: (() => { let n = 0; return () => `req-${++n}`; })(),
    activeConvo: () => state.conversations.find(c => c.id === state.activeId),
    el: { btnStop: { classList: { toggle() {} } }, btnSend: {}, input: { focus() {} }, messages: { querySelector: () => null } },
    ensureConvoEndpoint: () => ({ provider: { id: 'p', apiKey: 'k' }, model: 'm' }), isBridgeProvider: () => false,
    showToast() {}, openSettings() {}, renderAll() {}, persistConversations() {},
    matchWorldbookSections: () => world.promise, recallSection: async () => '',
    buildApiMessages: () => [], characterContextForConvo: () => '', effectiveSampling: () => ({}),
    api: { sendChat: async () => { sends++; return { ok: true, content: 'reply' }; }, stopChat: async () => {} },
    streamPainter: { stop() {} }, syncConvoPanel() {}, syncConvoOptions() {}, syncPlayerNameFromPanel() {},
    convoPanelFields: () => [], maybeSummarize: async () => {}, maybePetAutoSpeak: async () => {},
    confirmDialog: () => { confirmations++; return confirm.promise; }, resetPetTurns() {}, showView() {},
    shiftSummariesForRemoval() {}, invalidateSummariesForEdit() {},
  });
  vm.runInContext(moduleSource('renderer/js/views/composer.js'), ctx);
  vm.runInContext(moduleSource('renderer/js/views/convoActions.js'), ctx);
  return { ctx, state, convo, other, world, confirm, sends: () => sends, confirmations: () => confirmations };
}

(async () => {
  let h = harness();
  const sending = h.ctx.sendMessage('first');
  assert.equal(h.state.streaming, true, 'lock held before worldbook await');
  assert.equal(await h.ctx.sendMessage('duplicate'), false);
  h.ctx.switchConvo('b');
  assert.equal(h.state.activeId, 'a', 'cannot switch during preparation');
  await h.ctx.clearConvo();
  assert.equal(h.confirmations(), 0, 'clear blocked before confirmation');
  h.world.resolve({});
  assert.equal(await sending, true);
  assert.equal(h.sends(), 1);
  assert.equal(h.state.streaming, false);
  assert.equal(h.state.requestTarget, null);

  h = harness();
  const failed = h.ctx.sendMessage('first');
  h.world.reject(new Error('worldbook failed'));
  await failed;
  assert.equal(h.state.streaming, false, 'preparation failure unlocks');
  assert.equal(h.convo.messages.at(-1).role, 'error');

  h = harness();
  const stopped = h.ctx.sendMessage('first');
  await h.ctx.stopGenerating();
  h.world.resolve({});
  await stopped;
  assert.equal(h.sends(), 0, 'stop during preparation prevents send');
  assert.equal(h.state.streaming, false);

  h = harness();
  h.convo.messages.push({ role: 'assistant', content: 'prior' });
  const continuing = h.ctx.continueLastMessage();
  assert.equal(h.state.streaming, true, 'continue locks preparation too');
  h.world.reject(new Error('recall failed'));
  await continuing;
  assert.equal(h.state.streaming, false);

  for (const action of ['clearConvo', 'removeConvo', 'removeMessage']) {
    h = harness();
    const original = { role: 'user', content: 'keep' };
    h.convo.messages.push(original);
    const pending = h.ctx[action](action === 'removeConvo' ? 'a' : 0);
    h.state.streaming = true;
    h.confirm.resolve(true);
    await pending;
    assert.ok(h.state.conversations.includes(h.convo), `${action}: original conversation retained`);
    assert.equal(h.convo.messages[0], original, `${action}: recheck after confirmation`);
  }

  // Execute the actual chunk/reasoning listener block, not a reimplementation.
  const source = read('renderer/js/main.js');
  const listeners = source.slice(source.indexOf('  let chunkTarget ='), source.indexOf("  window.addEventListener('beforeunload'"));
  h = harness();
  const target = { role: 'assistant', content: '', reasoning: '' };
  h.convo.messages.push(target, { role: 'assistant', content: 'new tail' });
  h.state.requestId = 'owned';
  h.state.requestTarget = { convo: h.convo, assistant: target };
  h.state.activeId = 'b';
  let chunk, reasoning, paints = 0, queries = 0;
  h.ctx.api.onChunk = fn => { chunk = fn; };
  h.ctx.api.onReasoning = fn => { reasoning = fn; };
  h.ctx.streamPainter.push = () => { paints++; };
  h.ctx.el.messages.querySelector = () => { queries++; return { isConnected: true }; };
  h.ctx.cleanAssistantText = text => text;
  h.ctx.cutTrailingStatusBlock = text => text;
  h.ctx.convoFieldDisplayNames = () => [];
  h.ctx.panelGroupNames = () => [];
  vm.runInContext(listeners, h.ctx);
  chunk({ requestId: 'stale', text: 'discard' });
  chunk({ requestId: 'owned', text: '正文' });
  reasoning({ requestId: 'owned', text: '思考' });
  assert.equal(target.content, '正文');
  assert.equal(target.reasoning, '思考');
  assert.equal(h.convo.messages.at(-1).content, 'new tail');
  assert.equal(h.other.messages[0].content, 'other');
  assert.equal(paints, 0, 'no foreign-conversation painting');
  assert.equal(queries, 0);
  h.state.activeId = 'a';
  chunk({ requestId: 'owned', text: '接着' });
  assert.equal(target.content, '正文接着', 'returning to target does not inject another separator');
  assert.equal(paints, 1);
  h.convo.messages.splice(0, 1);
  chunk({ requestId: 'owned', text: 'deleted' });
  assert.equal(target.content, '正文接着', 'removed target ignored');

  // Exercise the real close hook while startup has not completed, including failed reads.
  const closeBody = source.slice(source.indexOf("  window.addEventListener('beforeunload'"), source.indexOf('\n}\n', source.indexOf("  window.addEventListener('beforeunload'")));
  let close, saves = 0;
  const closeCtx = vm.createContext({ startupDataLoaded: false, state: h.state,
    window: { addEventListener: (_, fn) => { close = fn; } },
    api: { saveConversationsNow: () => { saves++; } }, persistCharacters: () => { saves++; },
  });
  vm.runInContext(closeBody, closeCtx);
  close();
  assert.equal(saves, 0, 'uninitialized/failed startup cannot overwrite storage on close');
  closeCtx.startupDataLoaded = true;
  close();
  assert.equal(saves, 2, 'successful startup still saves on close');
  assert.ok(source.indexOf('startupDataLoaded = true;') > source.indexOf('state.conversations = asArray(stored.conversations)'));
  console.log('✓ renderer chat race regressions passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
