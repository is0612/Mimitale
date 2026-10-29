'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../main/account.js'), 'utf8');
const initial = () => ({ version: 2, token: 'old', refreshToken: 'refresh', user: { id: 1 } });
const response = (status, data, code = 0) => ({ status, ok: status < 400, json: async () => ({ code, data }) });
function harness(fetch, opts = {}) {
  let disk = initial();
  let writes = Promise.resolve();
  const context = vm.createContext({
    require: (id) => id === './store.js' ? {
      dataFile: n => n,
      loadJsonWithFallback: () => structuredClone(disk),
      writeJson: (_path, value) => {
        const task = writes.then(() => {
          if (opts.failWrite) throw Error('disk full');
          disk = structuredClone(value);
        });
        writes = task.catch(() => {});
        return task;
      }
    } : require(id),
    process: { env: {} }, module: { exports: {} },
    console: { warn() {} }, fetch, AbortController,
    setTimeout: opts.setTimeout || setTimeout, clearTimeout,
    setInterval, clearInterval
  });
  vm.runInContext(source, context);
  return { api: context.module.exports, run: code => vm.runInContext(code, context), state: () => disk };
}
test('login resolves after persistence; write failure does not claim success', async () => {
  const fetch = async () => response(200, { token: 'new', refreshToken: 'new-refresh', user: { id: 2 } });
  const h = harness(fetch);
  await h.api.login({});
  assert.equal(h.state().token, 'new');
  assert.equal(h.state().user.id, 2);
  await assert.rejects(harness(fetch, { failWrite: true }).api.login({}), /disk full/);
});
test('queued account patches merge against the latest persisted state', async () => {
  const h = harness(async () => {});
  await h.run("Promise.all([patchState({token:'new'}),patchState({user:{id:2}})])");
  assert.equal(h.state().token, 'new');
  assert.equal(h.state().user.id, 2);
});
test('refresh network failure retains session and exposes network classification', async () => {
  const h = harness(async url => {
    if (url.endsWith('/refresh')) throw Error('offline');
    return response(401);
  });
  await assert.rejects(h.api.consumeMessage(), e => e.network === true && !e.unauthorized);
  assert.equal(h.state().token, 'old');
});
test('refresh rejection clears state and classifies authorization failure', async () => {
  const h = harness(async () => response(401));
  await assert.rejects(h.api.consumeMessage(), e => e.unauthorized === true);
  assert.equal(h.state().token, '');
  assert.equal(h.state().user, null);
});
test('persistent 401 retries once, never recursively refreshes forever', async () => {
  let refreshes = 0, requests = 0;
  const h = harness(async url => {
    if (url.endsWith('/refresh')) { refreshes++; return response(200, { token: 'fresh' }); }
    requests++; return response(401);
  });
  await assert.rejects(h.api.consumeMessage(), e => e.unauthorized);
  assert.equal(refreshes, 1);
  assert.equal(requests, 2);
});
test('concurrent requests share one refresh and use the persisted fresh token', async () => {
  let refreshes = 0;
  const h = harness(async (url, options) => {
    if (url.endsWith('/refresh')) { refreshes++; await Promise.resolve(); return response(200, { token: 'fresh' }); }
    return options.headers.authorization === 'Bearer fresh' ? response(200, { allowed: true }) : response(401);
  });
  const results = await Promise.all([h.api.consumeMessage(), h.api.messageQuota()]);
  assert.equal(refreshes, 1);
  assert.ok(results.every(r => r.allowed));
});
test('refresh has an abort timeout and preserves the session on timeout', async () => {
  const h = harness(async (url, options) => {
    if (!url.endsWith('/refresh')) return response(401);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('abort'))));
  }, { setTimeout: (fn) => setTimeout(fn, 5) });
  await assert.rejects(h.api.consumeMessage(), e => e.network === true);
  assert.equal(h.state().token, 'old');
});
test('HTTP server errors do not masquerade as offline permission bypass', async () => {
  const h = harness(async () => response(500));
  await assert.rejects(h.api.consumeMessage(), e => !e.network && !e.unauthorized);
  assert.equal(h.state().token, 'old');
});
test('logged-out quota requests fail authorization locally even when offline', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; throw Error('offline'); });
  await h.run('clearSession()');
  await assert.rejects(h.api.consumeMessage(), e => e.unauthorized === true && !e.network);
  assert.equal(requests, 0);
});
test('late refresh response cannot resurrect a logged-out account', async () => {
  let finishRefresh;
  const h = harness(async url => {
    if (url.endsWith('/refresh')) return new Promise(resolve => { finishRefresh = () => resolve(response(200, { token: 'late' })); });
    return response(401);
  });
  const pending = h.api.consumeMessage();
  while (!finishRefresh) await Promise.resolve();
  await h.run('clearSession()');
  finishRefresh();
  await assert.rejects(pending, e => e.unauthorized);
  assert.equal(h.state().token, '');
});
test('successful redemption persists updated membership for offline startup', async () => {
  const h = harness(async () => response(200, { user: { id: 1, membership: { active: true } }, grant: { days: 30 } }));
  await h.api.redeemCard({ code: 'test-only' });
  assert.equal(h.state().user.membership.active, true);
});
test('expired registration token does not clear an existing login', async () => {
  const h = harness(async () => response(401));
  await h.run("patchState({pendingToken:'pending'})");
  await assert.rejects(h.api.completeProfile({}), e => e.unauthorized);
  assert.equal(h.state().token, 'old');
});
