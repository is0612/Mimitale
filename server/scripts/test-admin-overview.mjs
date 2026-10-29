import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/routes/admin/overview.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

test('registration trend and today cards both exclude unfinished profiles', async () => {
  const fixtures = [
    { profileReady: true, day: '2026-10-29' },
    { profileReady: false, day: '2026-10-29' },
    { profileReady: false, day: '2026-10-29' }
  ]
  const countQueries = [], rawQueries = []
  const prisma = {
    customer: {
      count: async options => {
        countQueries.push(options)
        if (options?.where?.profileReady === true) return fixtures.filter(c => c.profileReady).length
        return 0
      },
      findMany: async () => []
    },
    membershipGrant: { groupBy: async () => [] }, inviteCard: { count: async () => 0 },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?')
      rawQueries.push({ sql, values })
      if (sql.includes('FROM customers')) {
        const rows = sql.includes('profile_ready = true') ? fixtures.filter(c => c.profileReady) : fixtures
        return [{ day: '2026-10-29', count: rows.length }]
      }
      return [{ today_users: 0, avg_minutes: 0 }]
    }
  }
  const routes = new Map(), exports = {}
  const mocks = {
    '../../prisma.js': { prisma }, '../../lib/reply.js': { ok: data => data },
    '../../lib/dto.js': { toCustomer: c => c },
    '../../lib/time.js': {
      DAY_MS: 86_400_000,
      today: () => '2026-10-29',
      daysAgo: n => '2026-10-' + String(29 - n).padStart(2, '0'),
      dayRange: day => ({ start: new Date(day + 'T00:00:00Z'), end: new Date(day + 'T23:59:59Z') })
    }
  }
  vm.runInNewContext(code, { exports, require: name => {
    assert.ok(name in mocks, 'unexpected dependency ' + name)
    return mocks[name]
  }, Date, Map })
  await exports.adminOverviewRoutes({ get: (path, handler) => routes.set(path, handler) })
  const data = await routes.get('/overview')()
  const trendQuery = rawQueries.find(q => q.sql.includes('FROM customers'))
  assert.match(trendQuery.sql, /WHERE\s+profile_ready\s*=\s*true\s+AND\s+created_at/)
  assert.equal(countQueries[0].where.profileReady, true)
  assert.equal(countQueries[1].where.profileReady, true)
  assert.equal(data.todayRegistered, 1)
  assert.equal(data.trend.find(r => r.day === '2026-10-29').count, 1)
})
