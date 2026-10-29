import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../src/routes/admin/cards.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const bizSource = ts.transpileModule(readFileSync(new URL('../src/lib/bizError.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const bizExports = {}
vm.runInNewContext(bizSource, { exports: bizExports, require: () => ({ ApiCode: { INVALID_PARAM: 1001 } }) })
async function routeHarness({ race = false, status = 'unused' } = {}) {
  const card = { id: 1, code: 'MIMI-TEST-CARD', status, usedByCustomerId: null, usedAt: null }
  const logs = []
  const tx = { inviteCard: {
    updateMany: async ({ where, data }) => {
      if (card.id !== where.id || card.status !== where.status) return { count: 0 }
      Object.assign(card, data); return { count: 1 }
    },
    findUniqueOrThrow: async () => ({ ...card })
  } }
  const prisma = {
    inviteCard: { findUnique: async () => ({ ...card }) },
    $transaction: async fn => {
      // Redemption wins after void read its stale unused snapshot, before void's CAS.
      if (race) { card.status = 'used'; card.usedByCustomerId = 9; card.usedAt = new Date() }
      return fn(tx)
    }, customer: { findUnique: async () => ({ email: 'test@example.invalid' }) }
  }
  const mocks = {
    '../../prisma.js': { prisma }, '../../lib/codes.js': { ApiCode: { INVALID_PARAM: 1001, NOT_FOUND: 1004 } },
    '../../lib/reply.js': { ok: data => ({ code: 0, data }), fail: (code, message) => ({ code, message }) },
    '../../lib/bizError.js': bizExports,
    '../../lib/log.js': { pushLog: async data => { logs.push(data) } }, '../../lib/dto.js': { toCard: c => c },
    '../../lib/whoami.js': { currentAdmin: async () => ({ id: 2, nickname: 'test' }) },
    '../../lib/cardCode.js': {}, '../../lib/time.js': {}
  }
  const exports = {}
  vm.runInNewContext(source, { exports, require: name => name in mocks ? mocks[name] : require(name) })
  let handler
  await exports.adminCardRoutes({ get() {}, post() {}, patch: (_path, fn) => { handler = fn } })
  return { card, logs, run: () => handler({ params: { id: '1' }, body: { status: 'void' }, ip: '' }) }
}
test('void commits only an unused card and records exactly one successful log', async () => {
  const h = await routeHarness(); const result = await h.run()
  assert.equal(result.code, 0); assert.equal(h.card.status, 'void'); assert.equal(h.logs.length, 1)
})
test('redemption winning the race remains used and returns a friendly business error', async () => {
  const h = await routeHarness({ race: true })
  await assert.rejects(h.run(), err => err.name === 'BizError' && err.code === 1001 && /状态已改变/.test(err.message))
  assert.equal(h.card.status, 'used'); assert.equal(h.card.usedByCustomerId, 9); assert.equal(h.logs.length, 0)
})
test('a second stale void cannot overwrite state or add a success log', async () => {
  const h = await routeHarness()
  const first = await h.run(); assert.equal(first.code, 0)
  const second = await h.run(); assert.equal(second.code, 1001)
  assert.equal(h.logs.length, 1)
})
