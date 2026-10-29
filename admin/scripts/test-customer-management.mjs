import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
function evaluate(source, mocks, extra = {}) {
  const exports = {}
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { exports, require: key => key in mocks ? mocks[key] : require(key), console, Date, Math, ...extra })
  return exports
}
const reactive = {
  ref: value => ({ value }), reactive: value => value,
  computed: getter => ({ get value() { return getter() } })
}
function component(path, expose, mocks, extra = {}) {
  const source = read(path).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  return evaluate(source + `\nObject.assign(exports, {${expose}})`, { vue: reactive, ...mocks }, {
    defineEmits: () => () => {}, defineExpose: () => {}, ...extra
  })
}
const request = body => ({ params: { id: '1' }, body, ip: 'test-only' })
async function serverFixture(overrides = {}) {
  let customer = {
    id: 1, nickname: 'isolated', email: 'test@example.invalid', status: 'active', banReason: null,
    membershipLevel: 'none', membershipExpireAt: null, freeExpireAt: null, inviteCode: null, ...overrides
  }
  let queue = Promise.resolve()
  const calls = [], logs = [], routes = {}, grants = [], cards = []
  const tx = {
    $queryRaw: async () => customer ? [{ id: customer.id, free_expire_at: customer.freeExpireAt, membership_expire_at: customer.membershipExpireAt }] : [],
    customer: {
      findUnique: async () => customer ? { ...customer } : null,
      update: async ({ data }) => { Object.assign(customer, data); return { ...customer } },
      updateMany: async () => ({ count: 0 }),
      delete: async () => { customer = null; calls.push('customer.delete') }
    },
    membershipGrant: { create: async ({ data }) => { grants.push(data) } }
  }
  for (const table of ['feedback', 'announcementRead', 'loginLog', 'clientSession', 'membershipGrant', 'clientMessageUsage', 'inviteCard']) {
    tx[table] ??= {}
    tx[table].deleteMany = async () => { calls.push(table + '.deleteMany') }
    tx[table].updateMany = async () => { calls.push(table + '.updateMany'); return { count: 0 } }
  }
  const prisma = {
    customer: { findUnique: async () => customer ? { ...customer } : null, count: async () => 0 },
    inviteCard: { findFirst: async ({ where }) => cards.find(c => c.usedByCustomerId === where.usedByCustomerId && c.code === where.code) ?? null },
    operationLog: { findMany: async () => [] }, loginLog: { findMany: async () => [] },
    membershipGrant: { findMany: async () => [] }, clientSession: { findMany: async () => [] },
    $transaction: fn => { const result = queue.then(() => fn(tx)); queue = result.catch(() => {}); return result }
  }
  const membership = evaluate(read('server/src/lib/membership.ts'), { '../prisma.js': { prisma }, './time.js': { DAY_MS: 86400000 } })
  const routeModule = evaluate(read('server/src/routes/admin/customers.ts'), {
    '../../prisma.js': { prisma }, '../../lib/codes.js': { ApiCode: { INVALID_PARAM: 1, NOT_FOUND: 2 } },
    '../../lib/reply.js': { ok: data => ({ code: 0, data }), fail: (code, message) => ({ code, message }) },
    '../../lib/dict.js': { dictLabel: async (_type, value) => value },
    '../../lib/log.js': { pushLog: async entry => logs.push(entry) },
    '../../lib/dto.js': { toCustomer: value => value, toCard: value => value, toLog: value => value },
    '../../lib/whoami.js': { currentAdmin: async () => ({ id: 7, nickname: 'operator' }) },
    '../../lib/time.js': { dayOf: date => date.toISOString().slice(0, 10) },
    '../../lib/membership.js': membership, '../../lib/password.js': {},
    '../../lib/customerRules.js': {}, '../../lib/customerCodes.js': {}
  })
  await routeModule.adminCustomerRoutes({
    get: (path, fn) => { if (path === '/customers/:id') routes.detail = fn },
    patch: (_path, fn) => { routes.patch = fn }, post() {}, delete: (_path, fn) => { routes.delete = fn }
  })
  return { routes, calls, logs, grants, cards, customer: () => customer }
}
const labels = { GRANT_SOURCE_LABEL: { trial: '注册赠送', invite: '邀请奖励', card: '卡密兑换', admin: '后台发放' } }
function dialogs(updateCustomer) {
  return component('admin/src/components/CustomerDialogs.vue', 'openMembership,submitMembership,grantingMembership', {
    'element-plus': { ElMessage: { success() {}, warning() {} }, ElMessageBox: {} },
    '@/api/customer': { updateCustomer }, '@/stores/dict': { useDictStore: () => ({}) }, '@/config/labels': labels
  })
}

test('rapid membership clicks call the production route once and grant exactly 30 days', async () => {
  const h = await serverFixture()
  const ui = dialogs((_id, body) => h.routes.patch(request(body)))
  ui.openMembership(h.customer())
  const before = Date.now()
  await Promise.all([ui.submitMembership(), ui.submitMembership(), ui.submitMembership()])
  assert.equal(h.grants.length, 1)
  assert.equal(h.grants[0].days, 30)
  assert.equal(Math.round((h.customer().membershipExpireAt - before) / 86400000), 30)
  assert.equal(h.logs.length, 1)
  assert.equal(ui.grantingMembership.value, false)
})
test('membership busy state resets after failure so an explicit retry works', async () => {
  let calls = 0
  const ui = dialogs(async () => { if (++calls === 1) throw Error('isolated failure') })
  ui.openMembership({ id: 1, nickname: 'test' })
  await ui.submitMembership()
  assert.equal(ui.grantingMembership.value, false)
  await ui.submitMembership()
  assert.equal(calls, 2)
})
test('basic membership works without dictionary and preserves remaining free days', async () => {
  const h = await serverFixture({ freeExpireAt: new Date(Date.now() + 10 * 86400000) })
  const result = await h.routes.patch(request({ membershipLevel: 'basic', membershipDays: 30 }))
  assert.equal(result.code, 0)
  assert.equal(h.customer().freeExpireAt, null)
  assert.equal(Math.round((h.customer().membershipExpireAt - Date.now()) / 86400000), 40)
  assert.equal((await h.routes.patch(request({ membershipLevel: 'premium', membershipDays: 30 }))).code, 1)
  assert.equal((await h.routes.patch(request({ membershipLevel: 'basic', membershipDays: 1.5 }))).code, 1)
  assert.equal(h.grants.length, 1)
})
test('concurrent duplicate bans log once; a queued unban rechecks the locked latest status', async () => {
  const h = await serverFixture()
  await Promise.all([h.routes.patch(request({ status: 'banned', banReason: 'first' })), h.routes.patch(request({ status: 'banned', banReason: 'first' }))])
  assert.equal(h.logs.filter(l => l.action === 'customer.ban').length, 1)
  await h.routes.patch(request({ status: 'active' }))
  h.logs.length = 0
  await Promise.all([h.routes.patch(request({ status: 'banned' })), h.routes.patch(request({ status: 'active' }))])
  assert.equal(h.customer().status, 'active')
  assert.deepEqual(h.logs.map(l => l.action), ['customer.ban', 'customer.unban'])
})
test('customer deletion cleans daily quota as well as the other owned runtime rows', async () => {
  const h = await serverFixture()
  await h.routes.delete(request({}))
  assert.ok(h.calls.includes('clientMessageUsage.deleteMany'))
  assert.ok(h.calls.includes('membershipGrant.deleteMany'))
  assert.equal(h.customer(), null)
})
test('detail selects the registration card, never a later redemption or a referral code', async () => {
  for (const [inviteCode, expected] of [[null, null], ['REFERRAL', null], ['REGISTER', 'REGISTER']]) {
    const h = await serverFixture({ inviteCode })
    h.cards.push({ code: 'LATER', usedByCustomerId: 1 }, { code: 'REGISTER', usedByCustomerId: 1 })
    const result = await h.routes.detail(request({}))
    assert.equal(result.data.usedCard?.code ?? null, expected)
  }
})
test('detail sums grant sources without calling card payments free and ignores stale responses', async () => {
  const pending = [], watches = []
  let dispose
  const ui = component('admin/src/views/CustomerDetailView.vue', 'load,detail,loading,grantSummary', {
    vue: { ...reactive, watch: (_getter, fn) => watches.push(fn), onBeforeUnmount: fn => { dispose = fn } },
    'vue-router': { useRoute: () => ({ params: { id: '1' } }), useRouter: () => ({}) },
    '@element-plus/icons-vue': {}, 'element-plus': {}, '@/components/CustomerDialogs.vue': {},
    '@/stores/dict': { useDictStore: () => ({}) }, '@/config/labels': labels,
    '@/api/customer': { fetchCustomerDetail: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }
  })
  const old = ui.load(), latest = ui.load()
  pending[1].resolve({ id: 2, grants: [{ source: 'trial', days: 30 }, { source: 'card', days: 90 }, { source: 'invite', days: 7 }] })
  await latest
  pending[0].reject(Error('stale failure'))
  await old
  assert.equal(ui.detail.value.id, 2)
  assert.equal(ui.grantSummary.value, '注册赠送 30 天 · 卡密兑换 90 天 · 邀请奖励 7 天')
  assert.equal(ui.loading.value, false)
  const late = ui.load()
  dispose()
  pending[2].resolve({ id: 99, grants: [] })
  await late
  assert.equal(ui.detail.value.id, 2)
  assert.equal(watches.length, 1)
})
