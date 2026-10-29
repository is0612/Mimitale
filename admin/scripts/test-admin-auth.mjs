import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import axios from 'axios'
import ts from 'typescript'

const source = readFileSync(new URL('../src/api/request.ts', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../src/stores/auth.ts', import.meta.url), 'utf8')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(handler) {
  const storage = new Map(), messages = [], instances = []
  const localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) }
  const location = { hash: '#/customers', reloads: 0, reload() { this.reloads++ } }
  const axiosMock = { create(options) {
    const instance = axios.create({ ...options, adapter: async config => {
      const result = await handler(config)
      const response = { status: 200, statusText: 'OK', headers: {}, config, data: { code: 0, data: {} }, ...result }
      if (response.status >= 400) throw new axios.AxiosError('HTTP ' + response.status, 'ERR_BAD_REQUEST', config, null, response)
      return response
    } })
    instances.push(instance); return instance
  } }
  const exports = {}
  const code = ts.transpileModule(source.replaceAll('import.meta.env', 'testEnv'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const context = { exports, require: key => {
    if (key === 'axios') return { default: axiosMock }
    if (key === 'element-plus') return { ElMessage: { error: m => messages.push(m), warning: m => messages.push(m) } }
    if (key === '@/types') return { ApiCode: { OK: 0, SERVER_ERROR: 50000 } }
    if (key === '@/mock') return {}
    throw Error(key)
  }, localStorage, window: { location }, testEnv: { VITE_USE_MOCK: 'false' }, console }
  vm.runInNewContext(code, context)
  exports.setAuthTokens('old', 'refresh')
  return { api: exports, storage, messages, location, localStorage }
}
const ok = data => ({ data: { code: 0, data } })
const denied = () => ({ status: 401, data: { code: 40101, message: 'expired', data: null } })

test('real Axios: concurrent expired requests share one refresh and retry with fresh token', async () => {
  const started = deferred(), release = deferred(); let refreshes = 0
  const h = fixture(async c => {
    if (c.url.endsWith('/refresh')) { refreshes++; started.resolve(); await release.promise; return ok({ token: 'fresh' }) }
    return c.headers.Authorization === 'Bearer fresh' ? ok({ success: true }) : denied()
  })
  const a = h.api.request({ url: '/a' }), b = h.api.request({ url: '/b' })
  await started.promise; release.resolve()
  assert.equal((await a).success, true); assert.equal((await b).success, true)
  assert.equal(refreshes, 1); assert.equal(h.storage.get(h.api.TOKEN_KEY), 'fresh')
})

test('real Axios: delayed old 401 uses token already refreshed by another request', async () => {
  const lateStarted = deferred(), releaseLate = deferred(); let refreshes = 0
  const h = fixture(async c => {
    if (c.url.endsWith('/refresh')) { refreshes++; return ok({ token: 'fresh' }) }
    if (c.url === '/late' && c.headers.Authorization === 'Bearer old') { lateStarted.resolve(); await releaseLate.promise; return denied() }
    return c.headers.Authorization === 'Bearer fresh' ? ok({ success: true }) : denied()
  })
  const late = h.api.request({ url: '/late' }); await lateStarted.promise
  await h.api.request({ url: '/first' }); releaseLate.resolve(); await late
  assert.equal(refreshes, 1)
})

for (const failure of ['network', 'server', 'unauthorized']) test(`real Axios: refresh ${failure} is classified without accidental logout`, async () => {
  const h = fixture(async c => {
    if (!c.url.endsWith('/refresh')) return denied()
    if (failure === 'network') throw new axios.AxiosError('offline', 'ERR_NETWORK', c)
    return { status: failure === 'server' ? 503 : 401, data: { code: 1, message: failure } }
  })
  await assert.rejects(h.api.request({ url: '/guarded' }))
  assert.equal(h.storage.get(h.api.TOKEN_KEY), failure === 'unauthorized' ? undefined : 'old')
  assert.equal(h.location.reloads, failure === 'unauthorized' ? 1 : 0)
})

test('real Axios: persistent 401 retries only once then clears session', async () => {
  let refreshes = 0, calls = 0
  const h = fixture(async c => {
    if (c.url.endsWith('/refresh')) { refreshes++; return ok({ token: 'fresh' }) }
    calls++; return denied()
  })
  await assert.rejects(h.api.request({ url: '/guarded' }))
  assert.equal(calls, 2); assert.equal(refreshes, 1); assert.equal(h.storage.get(h.api.TOKEN_KEY), undefined)
})

test('real Axios: logout or account switch during refresh cannot restore stale credentials', async () => {
  for (const switchAccount of [false, true]) {
    const started = deferred(), release = deferred()
    const h = fixture(async c => {
      if (!c.url.endsWith('/refresh')) return denied()
      started.resolve(); await release.promise; return ok({ token: 'stale' })
    })
    const result = h.api.request({ url: '/guarded' }).catch(e => e)
    await started.promise
    if (switchAccount) h.api.setAuthTokens('new-account', 'new-refresh')
    else h.api.clearAuthTokens()
    release.resolve(); await result
    assert.equal(h.storage.get(h.api.TOKEN_KEY), switchAccount ? 'new-account' : undefined)
    assert.equal(h.location.reloads, 0)
  }
})

test('real Axios: login 401 shows error and retains existing session', async () => {
  const h = fixture(async () => denied()); h.location.hash = '#/login'
  await assert.rejects(h.api.request({ url: '/admin/auth/login', method: 'post' }))
  assert.equal(h.messages.length, 1); assert.equal(h.storage.get(h.api.TOKEN_KEY), 'old')
  assert.equal(h.location.reloads, 0)
})

test('store logout immediately clears tokens and ignores late login and me responses', async () => {
  const h = fixture(async () => ok({})), login = deferred(), me = deferred(), exports = {}
  const code = ts.transpileModule(storeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { exports, localStorage: h.localStorage, require: key => {
    if (key === 'vue') return { ref: value => ({ value }), computed: getter => ({ get value() { return getter() } }) }
    if (key === 'pinia') return { defineStore: (_name, setup) => setup }
    if (key === '@/api/admin') return { adminLogin: () => login.promise, adminMe: () => me.promise }
    if (key === '@/api/request') return h.api
    throw Error(key)
  } })
  const auth = exports.useAuthStore(), pendingLogin = auth.login('test', 'test'), pendingMe = auth.loadMe()
  auth.logout()
  assert.equal(h.storage.get(h.api.TOKEN_KEY), undefined)
  login.resolve({ token: 'late', refreshToken: 'late-refresh', admin: { id: 1 } }); me.resolve({ id: 1 })
  await pendingLogin; await pendingMe
  assert.equal(auth.token.value, ''); assert.equal(auth.admin.value, null)
  assert.equal(h.storage.get(h.api.TOKEN_KEY), undefined)
})
