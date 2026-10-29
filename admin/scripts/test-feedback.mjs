import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const vue = readFileSync(new URL('../src/views/FeedbackView.vue', import.meta.url), 'utf8')
const script = vue.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
const source = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const feedback = (id, status = 'pending') => ({ id, status, note: '', content: 'test', handledBy: null, handledAt: null })
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function harness({ rows = [feedback(1)], fetch, update } = {}) {
  let data = rows.map(x => ({ ...x })), updates = 0, fetches = []
  const context = vm.createContext({
    ref: value => ({ value }), reactive: x => x, computed: fn => ({ get value() { return fn() } }), onMounted() {},
    ElMessage: { info() {}, success() {} },
    fetchFeedbacks: async query => {
      fetches.push({ ...query })
      if (fetch) return fetch(query)
      const selected = data.filter(row => !query.status || row.status === query.status)
      return { list: selected.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(x => ({ ...x })), total: selected.length,
        counts: { total: data.length, pending: data.filter(x => x.status === 'pending').length, read: data.filter(x => x.status === 'read').length } }
    },
    updateFeedback: async (id, patch) => { updates++; if (update) return update(id, patch); const row = data.find(x => x.id === id); Object.assign(row, patch); return { ...row } },
    FEEDBACK_KIND_LABEL: {}, FEEDBACK_KIND_OPTIONS: [], FEEDBACK_KIND_TAG: {}, FEEDBACK_STATUS_LABEL: {}, FEEDBACK_STATUS_OPTIONS: [], FEEDBACK_STATUS_TAG: {}, formatTime() {}
  })
  vm.runInContext(source, context)
  return { run: code => vm.runInContext(code, context), updates: () => updates, fetches, data }
}
test('marking pending feedback read refreshes filter, total and authoritative counts', async () => {
  const h = harness(); await h.run("query.status='pending';load()")
  await h.run('markSeen(rows.value[0])')
  assert.equal(h.run('rows.value.length'), 0); assert.equal(h.run('total.value'), 0)
  assert.equal(h.run('counts.value.pending'), 0); assert.equal(h.run('counts.value.read'), 1)
  assert.equal(h.run('current.value.status'), 'read'); assert.equal(h.run('detailVisible.value'), true)
})
test('removing the last filtered row on a later page falls back to a valid page', async () => {
  const h = harness({ rows: Array.from({ length: 11 }, (_, i) => feedback(i + 1)) })
  await h.run("query.status='pending';query.page=2;load()")
  await h.run('markSeen(rows.value[0])')
  assert.equal(h.run('query.page'), 1); assert.equal(h.run('rows.value.length'), 10); assert.equal(h.run('total.value'), 10)
})
test('double click coalesces marking request and never manually double increments counts', async () => {
  const gate = deferred()
  const h = harness({ update: async (id, patch) => { await gate.promise; return { ...feedback(id), ...patch } }, fetch: async () => ({ list: [], total: 0, counts: { total: 1, pending: 0, read: 1 } }) })
  h.run('rows.value=[{id:1,status:"pending",note:""}]')
  const first = h.run('markSeen(rows.value[0])'), second = h.run('markSeen(rows.value[0])')
  assert.equal(h.updates(), 1); gate.resolve(); await Promise.all([first, second])
  assert.equal(h.run('counts.value.read'), 1); assert.equal(h.run('counts.value.pending'), 0)
})
test('late obsolete list request cannot restore a stale filtered row', async () => {
  const stale = deferred(); let calls = 0
  const h = harness({ fetch: async () => ++calls === 1 ? stale.promise : ({ list: [], total: 0, counts: { pending: 0, read: 1 } }) })
  h.run('rows.value=[{id:1,status:"pending",note:""}]')
  const old = h.run('load()'); await h.run('markSeen(rows.value[0])')
  stale.resolve({ list: [feedback(1)], total: 1, counts: { pending: 1, read: 0 } }); await old
  assert.equal(h.run('rows.value.length'), 0); assert.equal(h.run('counts.value.pending'), 0); assert.equal(h.run('loading.value'), false)
})
test('failed mark still opens original details and refreshes authoritative list', async () => {
  const h = harness({ update: async () => { throw Error('failed') } }); await h.run('load()')
  await h.run('markSeen(rows.value[0])')
  assert.equal(h.run('current.value.status'), 'pending'); assert.equal(h.run('detailVisible.value'), true)
  assert.equal(h.run('counts.value.pending'), 1)
})
