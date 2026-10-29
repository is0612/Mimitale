'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '../renderer/js', file), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/\bexport /g, '');
}
function harness() {
  const node = () => ({ dataset: {}, textContent: '', value: '', classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, addEventListener() {}, querySelector: () => null, focus() {} });
  const stats = { consume: 0, refund: 0, quota: 0, invalidated: 0, dialogs: 0 };
  let failure = null;
  let endpoint = { provider: { id: 'p', name: 'test', apiKey: 'key' }, model: 'model' };
  const convo = { id: 'c', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'old reply' }] };
  const api = {
    accountLogin: async () => ({ ok: true, user: { id: 'u' } }),
    accountLogout: async () => ({ ok: true }),
    accountConsumeMessage: async () => { stats.consume++; return failure || { ok: true, allowed: true, remaining: 19 }; },
    accountMessageQuota: async () => { stats.quota++; return { ok: true, remaining: 0, unlimited: false }; },
    accountRefundMessage: async () => { stats.refund++; return { ok: true }; }
  };
  const ctx = vm.createContext({ console: { warn() {}, error() {} }, structuredClone, api,
    el: { input: node(), quotaLine: node(), btnSend: node(), messages: { querySelector: () => null } },
    state: { streaming: false, settings: {} }, activeConvo: () => convo,
    ensureConvoEndpoint: () => endpoint, providers: () => endpoint ? [endpoint.provider] : [], providerById: () => endpoint?.provider,
    isBridgeProvider: () => false, showToast() {}, openSettings() {}, openAccountModal() {}, openProfile() {},
    confirmDialog: async () => { stats.dialogs++; return false; },
    beginConversationReplacement() {}, endConversationReplacement() {}, invalidateConvoDerivedRequests() {},
    invalidateSummariesForEdit() {}, rebuildConvoDerivedState() {},
    renderAll() {}, persistConversations() {}, syncConvoPanel() {}, syncConvoOptions() {}, syncPlayerNameFromPanel() {},
    now: () => 123, streamPainter: { stop() {} },
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  vm.runInContext(source('data/account.js'), ctx);
  vm.runInContext(source('views/composer.js'), ctx);
  const run = (text) => vm.runInContext(text, ctx);
  run('onAccountInvalidated(() => { globalThis.notifyInvalidated(); })');
  ctx.notifyInvalidated = () => stats.invalidated++;
  return { ctx, stats, convo, run, fail: (v) => { failure = v; }, endpoint: (v) => { endpoint = v; } };
}

test('unauthorized quota clears renderer login and quota, notifies UI, and blocks send', async () => {
  const h = harness(); await h.run('login({})');
  h.fail({ ok: false, error: '登录失效', unauthorized: true });
  assert.equal(await h.run('allowSend({charge:true})'), null);
  assert.equal(h.run('isLoggedIn()'), false);
  assert.equal(h.run('messageQuotaSnapshot()'), null);
  assert.equal(h.stats.invalidated, 1);
  assert.equal(h.ctx.el.input.readOnly, true);
  assert.equal(h.stats.dialogs, 1);
});

test('only an explicit network failure can degrade; server or business failures block', async () => {
  const h = harness(); await h.run('login({})');
  h.fail({ ok: false, error: 'offline', network: true });
  assert.equal((await h.run('allowSend({charge:true})')).degraded, true);
  h.fail({ ok: false, error: 'server failed' });
  assert.equal(await h.run('allowSend({charge:true})'), null);
  assert.equal(h.run('isLoggedIn()'), true);
  assert.equal(h.stats.dialogs, 0);
});

test('options recheck quota instead of trusting expired unlimited snapshot', async () => {
  const h = harness(); await h.run('login({})');
  h.run("quotaSnapshot = {unlimited:true, day:'yesterday'}");
  assert.equal(await h.run('optionsAllowed()'), null);
  assert.equal(h.stats.quota, 1);
});

test('logout clears quota belonging to the previous account', async () => {
  const h = harness(); await h.run('login({})'); await h.run('consumeMessage()');
  await h.run('logout()');
  assert.equal(h.run('isLoggedIn()'), false);
  assert.equal(h.run('messageQuotaSnapshot()'), null);
});

test('regeneration with missing provider or missing key does not charge or alter history', async () => {
  const h = harness(); await h.run('login({})');
  h.endpoint(null); await h.run('regenerateFrom(1)');
  h.endpoint({ provider: { name: 'empty key', apiKey: '' } }); await h.run('regenerateFrom(1)');
  assert.equal(h.stats.consume, 0); assert.equal(h.stats.refund, 0);
  assert.equal(h.convo.messages[1].content, 'old reply');
});

test('completion early exits refund real charge once and preserve regeneration history', async () => {
  const h = harness(); await h.run('login({})');
  h.ctx.state.streaming = true;
  await h.run('requestCompletion(activeConvo(), {charged:true})');
  assert.equal(h.stats.refund, 1);
  h.ctx.state.streaming = false; h.endpoint(null);
  await h.run('requestCompletion(activeConvo(), {charged:true})');
  assert.equal(h.stats.refund, 2);
  await h.run('requestCompletion(activeConvo(), {charged:false})');
  assert.equal(h.stats.refund, 2);
});

test('completion failure and cancellation before output refund once, never on degraded requests', async () => {
  for (const charged of [true, false]) {
    for (const cancellation of [true, false]) {
      const h = harness();
      h.run(cancellation
        ? 'prepareCompletion = async () => { generationStopped = true; return {}; }'
        : "prepareCompletion = async () => { throw new Error('failed'); }");
      await h.run(`requestCompletion(activeConvo(), {charged:${charged}})`);
      assert.equal(h.stats.refund, charged ? 1 : 0);
    }
  }
});

test('regeneration failure after partial output does not refund when rollback clears assistant', async () => {
  const h = harness();
  Object.assign(h.ctx, {
    uid: () => 'req', buildApiMessages: () => [], characterContextForConvo: () => null, effectiveSampling: () => ({}),
    reasoningTokensOf: () => 0
  });
  h.run('prepareCompletion = async () => ({worldbook:[],ragSection:""})');
  h.ctx.api.sendChat = async () => {
    h.ctx.state.requestTarget.assistant.content = 'partial output';
    return { ok: false, error: 'provider failed' };
  };
  h.ctx.rollback = () => {};
  await h.run('requestCompletion(activeConvo(), {charged:true,rollback})');
  assert.equal(h.stats.refund, 0);
});

test('degraded regeneration propagates uncharged state to completion', async () => {
  const h = harness(); await h.run('login({})');
  h.fail({ ok: false, error: 'offline', network: true });
  h.run('requestCompletion = async (_convo, options) => options');
  const result = await h.run('regenerateFrom(1)');
  assert.equal(result.charged, false);
  assert.equal(h.stats.refund, 0);
});

test('failed continuation only refunds when quota was actually charged', async () => {
  for (const degraded of [false, true]) {
    const h = harness(); await h.run('login({})');
    if (degraded) h.fail({ ok: false, error: 'offline', network: true });
    h.run("prepareCompletion = async () => { throw new Error('model failed'); }");
    await h.run('continueLastMessage()');
    assert.equal(h.stats.refund, degraded ? 0 : 1);
  }
});
