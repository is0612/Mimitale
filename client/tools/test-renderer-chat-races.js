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
  const sendAttrs = {};
  const sendIcon = { outerHTML: '' };
  let sends = 0, confirmations = 0, renders = 0, shownViews = [];
  const ctx = vm.createContext({
    state, console, setTimeout, clearTimeout, setInterval, clearInterval, structuredClone,
    CONFIG: {}, now: () => 1, uid: (() => { let n = 0; return () => `req-${++n}`; })(),
    iconHtml: (name) => `<svg class="field-icon">${name}</svg>`,
    activeConvo: () => state.conversations.find(c => c.id === state.activeId),
    el: { btnSend: { disabled: false, attrs: sendAttrs, setAttribute(name, value) { this.attrs[name] = value; }, getAttribute(name) { return this.attrs[name] || null; }, querySelector: () => sendIcon }, input: { focus() {} }, messages: { querySelector: () => null } },
    ensureConvoEndpoint: () => ({ provider: { id: 'p', apiKey: 'k' }, model: 'm' }), isBridgeProvider: () => false,
    showToast() {}, openSettings() {}, renderAll() { renders++; }, persistConversations() {},
    matchWorldbookSections: () => world.promise, recallSection: async () => '',
    buildApiMessages: () => [], characterContextForConvo: () => '', effectiveSampling: () => ({}),
    api: { sendChat: async () => { sends++; return { ok: true, content: 'reply' }; }, stopChat: async () => {} },
    streamPainter: { stop() {} }, syncConvoPanel() {}, syncConvoOptions() {}, syncPlayerNameFromPanel() {},
    convoPanelFields: () => [], maybeSummarize: async () => {}, maybePetAutoSpeak: async () => {},
    confirmDialog: () => { confirmations++; return confirm.promise; }, resetPetTurns() {}, showView(view) { shownViews.push(view); },
    shiftSummariesForRemoval() {}, invalidateSummariesForEdit() {},
    rebuildConvoDerivedState() {}, invalidateConvoDerivedRequests() {},
    beginConversationReplacement() {}, endConversationReplacement() {},
  });
  vm.runInContext(moduleSource('renderer/js/views/composer.js'), ctx);
  vm.runInContext(moduleSource('renderer/js/views/convoActions.js'), ctx);
  return { ctx, state, convo, other, world, confirm, sends: () => sends, confirmations: () => confirmations, renders: () => renders, shownViews };
}

(async () => {
  let h = harness();
  const sending = h.ctx.sendMessage('first');
  assert.equal(h.state.streaming, true, 'lock held before worldbook await');
  assert.equal(h.ctx.el.btnSend.disabled, false, 'send button stays clickable while streaming');
  assert.equal(h.ctx.el.btnSend.getAttribute('data-mode'), 'stop', 'streaming mode selects stop');
  assert.equal(await h.ctx.sendMessage('duplicate'), false);
  h.ctx.switchConvo('a');
  assert.equal(h.state.activeId, 'a', 'returning to active conversation keeps target');
  assert.equal(h.shownViews?.at(-1), 'chat');
  const renderCount = h.renders?.();
  h.ctx.switchConvo('b');
  assert.equal(h.state.activeId, 'a', 'cannot switch to a different conversation while streaming');
  assert.equal(h.renders?.(), renderCount, 'same-conversation return does not redraw streaming DOM');
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

  // A stop belongs to the whole turn, not just the active HTTP request.
  h = harness();
  h.ctx.convoPanelFields = () => ['HP'];
  h.ctx.convoFieldDisplayNames = () => ['HP'];
  const continuationStarted = deferred();
  const continuationReply = deferred();
  let chainRequests = 0, backgroundCalls = 0;
  h.ctx.maybeSummarize = async () => { backgroundCalls++; };
  h.ctx.maybePetAutoSpeak = async () => { backgroundCalls++; };
  h.ctx.api.sendChat = async () => {
    chainRequests++;
    if (chainRequests === 1) return { ok: true, content: 'partial', finishReason: 'length' };
    if (chainRequests === 2) { continuationStarted.resolve(); return continuationReply.promise; }
    throw new Error('stopped turn must not issue a panel repair');
  };
  h.ctx.api.stopChat = async () => continuationReply.resolve({ ok: false, error: '已停止生成。' });
  const truncatedTurn = h.ctx.sendMessage('start');
  h.world.resolve({});
  await continuationStarted.promise;
  await h.ctx.stopGenerating();
  await truncatedTurn;
  assert.equal(chainRequests, 2, 'stopping auto-continue prevents panel repair');
  assert.equal(backgroundCalls, 0, 'stopped turn issues no summary or pet request');
  assert.equal(h.convo.messages.at(-1).content, 'partial', 'stop keeps partial content');
  assert.equal(h.state.streaming, false);

  // A failed/cancelled regeneration must restore all original messages and candidates.
  for (const mode of ['prepare-error', 'prepare-stop', 'request-error', 'partial-stop', 'success']) {
    h = harness();
    const question = { role: 'user', content: 'question' };
    const answer = { role: 'assistant', content: 'old answer', variants: ['older', 'old answer'], variantIndex: 1 };
    const later = { role: 'user', content: 'later question' };
    const original = [question, answer, later];
    h.convo.messages = original;
    h.convo.summaries = [{ start: 0, end: 2, text: 'old summary' }];
    h.convo.panel = { HP: '50' };
    const previousSummary = JSON.stringify(h.convo.summaries);
    h.ctx.invalidateSummariesForEdit = () => { h.convo.summaries = []; };
    h.ctx.rebuildConvoDerivedState = () => { h.convo.panel = { HP: '100' }; };
    h.ctx.api.sendChat = async () => {
      if (mode === 'partial-stop') {
        h.state.requestTarget.assistant.content = 'incomplete candidate';
        await h.ctx.stopGenerating();
        return { ok: false, error: '已停止生成。' };
      }
      return mode === 'request-error' ? { ok: false, error: 'network failed' } : { ok: true, content: 'replacement', finishReason: 'stop' };
    };
    const regenerating = h.ctx.regenerateFrom(1);
    if (mode === 'prepare-error') h.world.reject(new Error('recall failed'));
    else if (mode === 'prepare-stop') await h.ctx.stopGenerating();
    else h.world.resolve({});
    await regenerating;
    if (mode === 'success') {
      assert.equal(h.convo.messages.length, 2);
      assert.equal(h.convo.messages[1].content, 'replacement');
      assert.deepEqual(Array.from(h.convo.messages[1].variants), ['older', 'old answer', 'replacement']);
      assert.equal(h.convo.summaries.length, 0, 'successful regeneration invalidates old summary');
    } else {
      assert.equal(h.convo.messages, original, `${mode}: original history restored`);
      assert.equal(h.convo.messages[1], answer, `${mode}: original candidate object retained`);
      assert.equal(h.convo.messages[2], later, `${mode}: later turns retained`);
      assert.equal(h.convo.panel.HP, '50', `${mode}: panel restored`);
      assert.equal(JSON.stringify(h.convo.summaries), previousSummary, `${mode}: summary restored`);
    }
    assert.equal(h.state.streaming, false, `${mode}: unlocked`);
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
    conversationsSavePayload: () => ({ conversations: h.state.conversations, activeId: h.state.activeId }),
  });
  vm.runInContext(closeBody, closeCtx);
  close();
  assert.equal(saves, 0, 'uninitialized/failed startup cannot overwrite storage on close');
  closeCtx.startupDataLoaded = true;
  close();
  assert.equal(saves, 2, 'successful startup still saves on close');
  assert.ok(source.indexOf('startupDataLoaded = true;') > source.indexOf('state.conversations = asArray(stored.conversations)'));
  // Pending replacement is never persisted, including the synchronous close payload.
  const persistedConvo = { id: 'replace', messages: [{ content: 'partial replacement' }] };
  const originalConvo = { id: 'replace', messages: [{ content: 'original answer' }, { content: 'later turn' }] };
  const persistCtx = vm.createContext({ state: { conversations: [persistedConvo], activeId: 'replace' }, setTimeout, clearTimeout, console });
  vm.runInContext(moduleSource('renderer/js/data/persist.js'), persistCtx);
  persistCtx.beginConversationReplacement(persistedConvo, originalConvo);
  assert.equal(persistCtx.conversationsSavePayload().conversations[0], originalConvo);
  persistCtx.endConversationReplacement(persistedConvo);
  assert.equal(persistCtx.conversationsSavePayload().conversations[0], persistedConvo);
  console.log('✓ renderer chat race regressions passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
