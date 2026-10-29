import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { inflateSync } from 'node:zlib'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const code = ts.transpileModule(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  const context = vm.createContext({ exports, require: name => name in mocks ? mocks[name] : require(name), console, Buffer, process, setTimeout, clearTimeout, Date, Intl })
  vm.runInContext(code, context)
  return exports
}
const biz = message => new Error(message)
function reply() { return { status: 200, payload: null, code(status) { this.status = status; return this }, send(payload) { this.payload = payload; return this } } }

// Execute the production route with a serialized transaction substitute. Both requests
// read the same unfinished profile before either transaction; the CAS must pick one winner.
for (const invited of [false, true]) test('concurrent registration awards once' + (invited ? ' including inviter bonus' : ''), async () => {
  let customer = { id: 1, status: 'active', profileReady: false, nickname: 'pending' }
  let queue = Promise.resolve(), reads = 0, release
  const barrier = new Promise(resolve => { release = resolve })
  const grants = [], routes = new Map()
  const tx = { customer: {
    updateMany: async ({ where, data }) => { if (customer.profileReady !== where.profileReady || customer.status !== where.status) return { count: 0 }; Object.assign(customer, data); return { count: 1 } },
    findUniqueOrThrow: async () => ({ ...customer })
  }, inviteCard: { updateMany: async () => ({ count: 1 }) } }
  const prisma = {
    customer: { findUnique: async ({ where }) => {
      if (where.referralCode) return { id: 2 }
      const snapshot = { ...customer }; if (++reads === 2) release(); await barrier; return snapshot
    } },
    inviteCard: { findUnique: async () => null }, loginLog: { create: async () => ({}) },
    $transaction: fn => { const result = queue.then(() => fn(tx)); queue = result.catch(() => {}); return result }
  }
  const mod = load('routes/client/auth.ts', {
    '../../prisma.js': { prisma }, '../../env.js': { env: {} }, '../../lib/codes.js': { ApiCode: {} },
    '../../lib/reply.js': { ok: data => ({ code: 0, data }), fail: (_c, m) => { throw Error(m) } }, '../../lib/bizError.js': { biz },
    '../../lib/password.js': { hashPassword: async p => 'hash:' + p }, '../../lib/auth.js': { issueTokens: () => ({ token: 'access' }) },
    '../../lib/captcha.js': {}, '../../lib/voucher.js': {}, '../../lib/cardCode.js': {}, '../../lib/mail.js': {}, '../../lib/whoami.js': {},
    '../../lib/time.js': {}, '../../lib/dict.js': {}, '../../lib/session.js': {},
    '../../lib/customerRules.js': { TRIAL_DAYS: 30, normalizeUsername: x => x, normalizePassword: x => x, normalizeAvatar: x => x },
    '../../lib/customerCodes.js': { makeUniqueVoucher: async () => 'voucher', makeUniqueReferralCode: async () => 'referral' },
    '../../lib/clientUser.js': { INVITE_BONUS_DAYS: 7, toClientUser: async c => c },
    '../../lib/membership.js': { grantDaysIn: async (_tx, grant) => { grants.push(grant); return { customer: { ...customer } } } }
  })
  await mod.clientAuthPublicRoutes({ post: (url, fn) => routes.set(url, fn) })
  const request = nickname => ({ body: { username: nickname, password: nickname, avatar: '', inviteCode: invited ? 'MIMI-ABCD-EFGH' : '' }, jwtVerify: async () => {}, user: { sub: 1, kind: 'client', pending: true }, ip: '', headers: {}, log: { warn() {} } })
  const result = await Promise.allSettled(['first', 'second'].map(name => routes.get('/complete-profile')(request(name), reply())))
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(result.filter(r => r.status === 'rejected').length, 1)
  assert.equal(grants.filter(g => g.source === 'trial').length, 1)
  assert.equal(grants.filter(g => g.source === 'invite').length, invited ? 1 : 0)
  assert.equal(customer.passwordHash, 'hash:first')
})

test('PNG captcha contains only raster chunks; accepted answer is single-use', () => {
  const mod = load('lib/captcha.ts', { './bizError.js': { biz } })
  const c = mod.createCaptcha({ reveal: true })
  const png = Buffer.from(c.image.split(',')[1], 'base64')
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  let at = 8, raw, width, height; const chunks = []
  while (at < png.length) { const size = png.readUInt32BE(at), kind = png.toString('ascii', at + 4, at + 8); const data = png.subarray(at + 8, at + 8 + size); chunks.push(kind); if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4) }; if (kind === 'IDAT') raw = inflateSync(data); at += size + 12 }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND'])
  assert.equal(width, 112); assert.equal(height, 40); assert.equal(raw.length, 40 * (112 * 3 + 1))
  for (let i = 0; i < 4; i++) { let bright = 0; for (let y = 3; y < 35; y++) for (let x = 5 + i * 26; x < 28 + i * 26; x++) if (raw[y * 337 + 1 + x * 3] > 140) bright++; assert.ok(bright > 45, 'each glyph has visible pixels') }
  assert.equal('answer' in mod.createCaptcha(), false)
  mod.verifyCaptcha(c.id, c.answer.toLowerCase())
  assert.throws(() => mod.verifyCaptcha(c.id, c.answer), /失效/)
  const wrong = mod.createCaptcha({ reveal: true }); assert.throws(() => mod.verifyCaptcha(wrong.id, 'WRONG'), /不对/); assert.throws(() => mod.verifyCaptcha(wrong.id, wrong.answer), /失效/)
})

for (const invalid of [null, { status: 'banned', profileReady: true }, { status: 'active', profileReady: false }]) test('guard rejects invalid customer and soft auth remains anonymous: ' + JSON.stringify(invalid), async () => {
  const mod = load('lib/auth.ts', { '../prisma.js': { prisma: { customer: { findUnique: async () => invalid } } }, '../env.js': { env: {} }, './codes.js': { ApiCode: { UNAUTHORIZED: 1001 } } })
  const req = { jwtVerify: async () => {}, user: { sub: 1, kind: 'client' }, headers: { authorization: 'Bearer signed' }, server: { jwt: { verify: () => ({ sub: 1, kind: 'client' }) } } }
  const res = reply(); await mod.clientGuard(req, res); assert.equal(res.status, 401)
  assert.equal(await mod.optionalCustomerId(req), null)
  await assert.rejects(mod.requireUsableCustomer(1), e => e.statusCode === 401)
})

test('active customer accepted; refresh/pending tokens rejected before database access', async () => {
  let queries = 0
  const mod = load('lib/auth.ts', { '../prisma.js': { prisma: { customer: { findUnique: async () => { queries++; return { status: 'active', profileReady: true } } } } }, '../env.js': { env: {} }, './codes.js': { ApiCode: {} } })
  const req = { jwtVerify: async () => {}, user: { sub: 1, kind: 'client' } }
  const good = reply(); await mod.clientGuard(req, good); assert.equal(good.payload, null); assert.equal(queries, 1)
  for (const flags of [{ ref: true }, { pending: true }, { kind: 'admin' }]) { const res = reply(); await mod.clientGuard({ ...req, user: { sub: 1, kind: 'client', ...flags } }, res); assert.equal(res.status, 401) }
  assert.equal(queries, 1)
})

test('protected HTTP route and refresh reject banned/deleted/unfinished accounts with 401', async () => {
  const Fastify = require('fastify')
  for (const customer of [null, { status: 'banned', profileReady: true }, { status: 'active', profileReady: false }, { id: 1, status: 'active', profileReady: true }]) {
    const prisma = { customer: { findUnique: async () => customer } }
    const auth = load('lib/auth.ts', { '../prisma.js': { prisma }, '../env.js': { env: {} }, './codes.js': { ApiCode: {} } })
    const mod = load('routes/client/auth.ts', {
      '../../prisma.js': { prisma }, '../../env.js': { env: {} }, '../../lib/codes.js': { ApiCode: {} },
      '../../lib/reply.js': { ok: data => ({ code: 0, data }) }, '../../lib/bizError.js': { biz },
      '../../lib/password.js': {}, '../../lib/auth.js': { ...auth, readRefreshToken: () => ({ sub: 1 }), issueTokens: () => ({ token: 'access', expiresIn: 60 }) },
      '../../lib/captcha.js': {}, '../../lib/voucher.js': {}, '../../lib/cardCode.js': {}, '../../lib/mail.js': {}, '../../lib/whoami.js': {},
      '../../lib/time.js': {}, '../../lib/dict.js': {}, '../../lib/session.js': {}, '../../lib/customerRules.js': {},
      '../../lib/customerCodes.js': {}, '../../lib/clientUser.js': {}, '../../lib/membership.js': {}
    })
    const routes = new Map(); await mod.clientAuthPublicRoutes({ post: (url, fn) => routes.set(url, fn) })
    const res = reply(); await routes.get('/refresh')({ body: { refreshToken: 'signed-refresh' } }, res)
    assert.equal(res.status, customer?.status === 'active' && customer.profileReady ? 200 : 401)
    const app = Fastify()
    app.decorateRequest('jwtVerify', async function () { this.user = { sub: 1, kind: 'client' } })
    let called = false
    app.get('/protected', { preHandler: auth.clientGuard }, async () => { called = true; return { ok: true } })
    const response = await app.inject({ method: 'GET', url: '/protected' })
    const valid = customer?.status === 'active' && customer.profileReady
    assert.equal(response.statusCode, valid ? 200 : 401); assert.equal(called, !!valid)
    await app.close()
  }
})

test('quota never grants deleted customer unlimited access', async () => {
  const auth = load('lib/auth.ts', { '../prisma.js': { prisma: { customer: { findUnique: async () => null } } }, '../env.js': { env: {} }, './codes.js': {} })
  const quota = load('lib/quota.ts', { '../prisma.js': { prisma: {} }, './membership.js': {}, './auth.js': auth })
  await assert.rejects(quota.consumeDailyMessage(1), e => e.statusCode === 401)
})

test('heartbeat ownership, stale closure and active other devices', async () => {
  const now = Date.now(), sessions = [
    { id: 1, customerId: 1, startedAt: new Date(now - 7 * 86400000), lastSeenAt: new Date(now - 7 * 86400000 + 300000), endedAt: null, ip: 'old-ip' },
    { id: 2, customerId: 1, startedAt: new Date(now - 600000), lastSeenAt: new Date(now - 60000), endedAt: null, ip: 'other-device' },
    { id: 3, customerId: 2, startedAt: new Date(now - 600000), lastSeenAt: new Date(now - 60000), endedAt: null }
  ]
  const originalOther = sessions[2].lastSeenAt.getTime()
  const prisma = { clientSession: {
    updateMany: async ({ where, data }) => { const row = sessions.find(s => s.id === where.id && s.customerId === where.customerId && s.endedAt === null); if (row) Object.assign(row, data); return { count: row ? 1 : 0 } },
    create: async ({ data }) => { sessions.push({ id: 4, ...data }); return { id: 4 } }
  }, $transaction: tasks => Promise.all(tasks), $executeRaw: async (sql, customerId, cutoff) => {
    assert.match(sql.join('?'), /ended_at = COALESCE\(last_seen_at, started_at\)/)
    assert.doesNotMatch(sql.join('?'), /SET[^]*ip\s*=/)
    for (const row of sessions) if (row.customerId === customerId && row.endedAt === null && (row.lastSeenAt ?? row.startedAt) < cutoff) { row.endedAt = row.lastSeenAt ?? row.startedAt; row.endReason = 'unknown' }
  } }
  const mod = load('lib/session.ts', { '../prisma.js': { prisma } })
  mod.touchSession({}, 1, 3)
  await mod.openSession({ headers: {}, ip: 'new-device' }, 1)
  assert.equal(sessions[2].lastSeenAt.getTime(), originalOther)
  assert.equal(sessions[0].endedAt.getTime(), sessions[0].lastSeenAt.getTime())
  assert.equal(sessions[0].ip, 'old-ip')
  assert.equal(sessions[1].endedAt, null)
})
