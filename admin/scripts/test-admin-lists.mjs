import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the production list loader. Requests are manually resolved out of order.
const source = readFileSync(new URL('../src/views/CustomerListView.vue', import.meta.url), 'utf8')
const start = source.indexOf('let loadSequence = 0')
const end = source.indexOf('function search()', start)
assert.ok(start >= 0 && end > start)
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText
function harness() {
  const pending = []
  const state = {
    loading: { value: false }, rows: { value: [] }, total: { value: 0 },
    query: { page: 1, pageSize: 10, keyword: '', status: '' },
    fetchCustomers: query => new Promise((resolve, reject) => pending.push({ query, resolve, reject }))
  }
  const context = vm.createContext(state)
  vm.runInContext(code, context)
  return { state, pending, load: () => vm.runInContext('load()', context) }
}

test('latest search wins when an earlier response arrives last', async () => {
  const h = harness()
  h.state.query.keyword = 'first'
  const old = h.load()
  h.state.query.keyword = 'latest'
  const latest = h.load()
  assert.equal(h.pending[0].query.keyword, 'first')
  assert.equal(h.pending[1].query.keyword, 'latest')
  h.pending[1].resolve({ list: [{ id: 2 }], total: 1 })
  await latest
  assert.equal(h.state.loading.value, false)
  h.pending[0].resolve({ list: [{ id: 1 }], total: 80 })
  await old
  assert.equal(h.state.rows.value[0].id, 2)
  assert.equal(h.state.total.value, 1)
})

test('older request completion cannot clear current loading or replace current rows', async () => {
  const h = harness()
  const old = h.load()
  h.state.query.page = 2
  const latest = h.load()
  h.pending[0].resolve({ list: [{ id: 1 }], total: 20 })
  await old
  assert.equal(h.state.loading.value, true)
  assert.equal(h.state.rows.value.length, 0)
  h.pending[1].resolve({ list: [{ id: 11 }], total: 20 })
  await latest
  assert.equal(h.state.rows.value[0].id, 11)
  assert.equal(h.state.loading.value, false)
})

test('older failure cannot clear loading for a newer request', async () => {
  const h = harness()
  const old = h.load()
  const latest = h.load()
  h.pending[0].reject(Error('old failure'))
  await old
  assert.equal(h.state.loading.value, true)
  h.pending[1].resolve({ list: [{ id: 2 }], total: 1 })
  await latest
  assert.equal(h.state.rows.value[0].id, 2)
  assert.equal(h.state.loading.value, false)
})
