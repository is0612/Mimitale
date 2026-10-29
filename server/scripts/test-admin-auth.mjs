import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function loadAuth(prisma) {
  const source = readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  const context = vm.createContext({ exports, require: id => id === '../prisma.js' ? { prisma } : id === '../env.js' ? { env: {} } : id === './codes.js' ? { ApiCode: { UNAUTHORIZED: 1001, TOKEN_EXPIRED: 1002 } } : require(id), Number, Object })
  vm.runInContext(js, context)
  return exports
}
function reply() { return { status: 200, code(status) { this.status = status; return this }, send(payload) { this.payload = payload; return this } } }
function request(kind = 'admin', sub = 7) { return { jwtVerify: async function () { this.user = { kind, sub } }, user: {} } }

test('admin guard permits an existing admin', async () => {
  let queries = 0
  const auth = loadAuth({ admin: { findUnique: async query => { queries++; assert.equal(query.where.id, 7); assert.equal(query.select.id, true); return { id: 7 } } } })
  const res = reply(); await auth.adminGuard(request(), res)
  assert.equal(res.status, 200); assert.equal(queries, 1)
})

test('admin guard returns 401 for deleted admin and does not pass route through', async () => {
  const auth = loadAuth({ admin: { findUnique: async () => null } })
  const res = reply(); await auth.adminGuard(request(), res)
  assert.equal(res.status, 401); assert.match(res.payload.message, /不存在/)
})

test('admin guard rejects a valid client JWT before querying admin table', async () => {
  let queries = 0
  const auth = loadAuth({ admin: { findUnique: async () => { queries++; return { id: 7 } } } })
  const res = reply(); await auth.adminGuard(request('client'), res)
  assert.equal(res.status, 401); assert.equal(queries, 0)
})
