/**
 * 真后端验收 —— 直接打 http://127.0.0.1:8080，不碰 mock。
 *
 * 跑法：后端先起来（npm run dev），然后
 *   node --experimental-strip-types scripts/smoke.mjs
 *   或  npx tsx scripts/smoke.mjs
 *
 * 和 admin/scripts/smoke.mjs 的区别：
 *   - 那个测的是 mock adapter（前端自带假后端）
 *   - 这个测的是真服务 + 真 Postgres，验证码从数据库里捞
 *
 * 每次跑都会新建一个 smoke-<时间戳>@example.com 的客户，
 * 所以「今日注册」的数字会被它撑大 —— 这是测试数据的正常副作用。
 */
import 'dotenv/config'
import pg from 'pg'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8080'
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123'

let passed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

async function api(method, path, { token, body, headers: extra } = {}) {
  const headers = { ...extra }
  if (token) headers.authorization = `Bearer ${token}`
  // 没 body 就别带 content-type —— 后端虽然容忍了空 JSON body，但没必要去踩
  if (body !== undefined) headers['content-type'] = 'application/json'

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 空响应 */
  }
  return { status: res.status, code: json?.code, data: json?.data, message: json?.message }
}

/**
 * 本次冒烟的开始时刻，写成 UTC 的 `YYYY-MM-DD HH:mm:ss`。
 *
 * ⚠️ 收尾时用它把「这次跑出来」的操作日志整段删掉。不这么做的话，卡密和字典那几段
 *    每次都会往库里留 6 条日志，跑十次就有 60 条假的「管理员操作」—— 日志页会越来越脏。
 * ⚠️ 要写成字符串而不是传 Date：`created_at` 是 `timestamp(3)`（无时区），
 *    传 Date 会被 pg 当 timestamptz 发过去，靠会话时区转换，容易差 8 小时。
 */
const RUN_START_UTC = new Date().toISOString().slice(0, 19).replace('T', ' ')

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

/**
 * 开跑之前先把**上一次**留下的烟雾残骸清掉。
 *
 * ⚠️ 上一次如果中途崩了（服务端被重启、断言抛错、Ctrl+C），收尾那段不会跑到，
 *    库里就会留着几个 `smoke...@example.com` 的假账号，把「今日注册」撑大，
 *    而看列表的人根本不知道那是谁 —— 自己清一次，比每次都要人肉排查强。
 * ⚠️ 只删 `smoke%` 这一类：那是本脚本专用的邮箱前缀，绝不会碰到真人。
 */
await db.query(`DELETE FROM login_logs WHERE customer_id IN (SELECT id FROM customers WHERE email LIKE 'smoke%@example.com')`)
await db.query(`DELETE FROM membership_grants WHERE customer_id IN (SELECT id FROM customers WHERE email LIKE 'smoke%@example.com')`)
await db.query(`DELETE FROM customers WHERE email LIKE 'smoke%@example.com'`)
await db.query(`DELETE FROM login_codes WHERE email LIKE 'smoke%@example.com'`)

/**
 * 解析数据库里的时间。
 *
 * ⚠️ 这张库的时间列是 `timestamp(3)`（**没有**时区标记），Prisma 往里写的是 UTC 值。
 *    原生 pg 驱动读出来是字符串 `"2026-11-26 09:50:00"`，直接 `new Date(...)` 会按
 *    **本地时区**解析 —— 在东八区就差 8 小时。加上 T 和 Z 明确按 UTC 解析才对。
 *
 *    服务端代码不走这条路（Prisma 自己按 UTC 解析 Date），只有本脚本用原生 pg 才要小心。
 */
function parseDbTime(value) {
  if (value instanceof Date) return value
  return new Date(String(value).replace(' ', 'T') + 'Z')
}

/* ------------------------------------------------------------------ */

section('健康检查')
{
  const r = await api('GET', '/api/health')
  check('GET /api/health 返回 code 0', r.code === 0, `code=${r.code}`)
  check('服务的名字对', r.data?.service === 'mimitale-server')
}

section('管理员认证')
{
  const bad = await api('POST', '/api/admin/auth/login', { body: { username: ADMIN_USERNAME, password: '肯定不对' } })
  check('错密码返回 1005', bad.code === 1005, `code=${bad.code}`)

  const nobody = await api('POST', '/api/admin/auth/login', { body: { username: '不存在的账号', password: 'x' } })
  check('不存在的账号和错密码同一个错误码（不做区分）', nobody.code === 1005, `code=${nobody.code}`)

  const empty = await api('POST', '/api/admin/auth/login', { body: { username: '', password: '' } })
  check('空账号密码返回 1001', empty.code === 1001, `code=${empty.code}`)

  const okLogin = await api('POST', '/api/admin/auth/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }
  })
  check('正确账号密码能登录', okLogin.code === 0 && !!okLogin.data?.token, `code=${okLogin.code}`)
  check('返回 refreshToken', !!okLogin.data?.refreshToken)
  check('管理员信息里没有密码字段', okLogin.data?.admin && !('password' in okLogin.data.admin))

  globalThis.adminToken = okLogin.data?.token
  globalThis.refreshToken = okLogin.data?.refreshToken

  const me = await api('GET', '/api/admin/auth/me', { token: globalThis.adminToken })
  check('GET /auth/me 认得出当前管理员', me.code === 0 && me.data?.username === ADMIN_USERNAME)

  const refreshed = await api('POST', '/api/admin/auth/refresh', { body: { refreshToken: globalThis.refreshToken } })
  check('refreshToken 能换新 token', refreshed.code === 0 && !!refreshed.data?.token)

  const wrongKind = await api('POST', '/api/admin/auth/refresh', { body: { refreshToken: 'adminToken' } })
  check('乱传 refreshToken 被拒（401）', wrongKind.status === 401)
}

const T = globalThis.adminToken

section('守卫：两套 token 不能混用')
{
  const noToken = await api('GET', '/api/admin/customers')
  check('不带 token 访问管理接口 → 401', noToken.status === 401)

  const fake = await api('GET', '/api/admin/customers', { token: 'not-a-real-token' })
  check('假 token → 401', fake.status === 401)
}

section('客户列表')
{
  /* ---------------- 本脚本自己的夹具客户 ---------------- */
  // ⚠️ 不能依赖 SEED_DEMO 造的示范客户 —— 关掉之后（干净库 / 生产）一条都没有。
  // ⚠️ 更要紧：**别把列表第一条当成自己的测试对象**。真实用户可能就排在第一位，
  //    后面「客户详情 / 封禁 / 发会员」会全打在他身上，末尾那步还会把他 DELETE 掉。
  //    所以这里先造几条带固定邮箱的夹具，测试对象一律按邮箱取，不按位置取。
  const FIXTURES = [
    ['smoke-search@example.com', '夜航船', 'MIMI-TEST-0001'],
    ['smoke-page1@example.com', '分页甲', null],
    ['smoke-page2@example.com', '分页乙', null],
    ['smoke-page3@example.com', '分页丙', null],
    ['smoke-page4@example.com', '分页丁', null],
    ['smoke-page5@example.com', '分页戊', null]
  ]
  for (const [fxEmail, nickname, inviteCode] of FIXTURES) {
    await db.query(
      `INSERT INTO customers (email, nickname, profile_ready, status, membership_level, invite_code)
       VALUES ($1, $2, true, 'active', 'none', $3)
       ON CONFLICT (email) DO UPDATE SET nickname = EXCLUDED.nickname, invite_code = EXCLUDED.invite_code`,
      [fxEmail, nickname, inviteCode]
    )
  }
  const mine = await db.query(`SELECT id FROM customers WHERE email = 'smoke-search@example.com'`)

  const list = await api('GET', '/api/admin/customers?page=1&pageSize=5', { token: T })
  check('列表返回 code 0', list.code === 0)
  check('有数据', list.data?.total >= FIXTURES.length, `total=${list.data?.total}`)
  check('每页 5 条', list.data?.list?.length === 5, `实际 ${list.data?.list?.length}`)

  const first = list.data?.list?.[0]
  check('客户字段齐全（email/nickname/status）', !!first?.email && !!first?.nickname && !!first?.status)
  check('带回 voucher 字段（老数据可为 null）', 'voucher' in (first ?? {}))
  check('带回 avatar 字段', 'avatar' in (first ?? {}))
  check('时间字段是 ISO 字符串', typeof first?.createdAt === 'string' && first.createdAt.includes('T'))

  const banned = await api('GET', '/api/admin/customers?status=banned', { token: T })
  check('按状态筛出被封的', banned.data?.list?.every((c) => c.status === 'banned'))

  const kw = await api('GET', '/api/admin/customers?keyword=夜航船', { token: T })
  check('按昵称搜索命中', kw.data?.total >= 1, `total=${kw.data?.total}`)

  const kwCard = await api('GET', '/api/admin/customers?keyword=MIMI', { token: T })
  check('按邀请码搜索命中', kwCard.data?.total >= 1, `total=${kwCard.data?.total}`)

  const nope = await api('GET', '/api/admin/customers?keyword=绝对搜不到的东西xyz', { token: T })
  check('搜不到时 total 为 0、list 是空数组', nope.data?.total === 0 && Array.isArray(nope.data?.list))

  // 后面所有「改会员 / 封禁 / 发会员」都只碰这条夹具
  globalThis.customerId = mine.rows[0]?.id
}

section('客户详情')
{
  const d = await api('GET', `/api/admin/customers/${globalThis.customerId}`, { token: T })
  check('详情返回 code 0', d.code === 0)
  check('带 usedCard 字段（有卡就是卡、没卡是 null）', 'usedCard' in (d.data ?? {}))
  check('带 logs 数组', Array.isArray(d.data?.logs))

  const miss = await api('GET', '/api/admin/customers/999999', { token: T })
  check('不存在的客户 → 40400', miss.code === 40400, `code=${miss.code}`)
}

section('概览：今天注册了几个')
{
  const o = await api('GET', '/api/admin/overview', { token: T })
  check('概览返回 code 0', o.code === 0)
  check('有 todayRegistered', typeof o.data?.todayRegistered === 'number', `值=${o.data?.todayRegistered}`)
  check('今日注册 >= 2（种子刻意在今天放了 2 个）', o.data?.todayRegistered >= 2, `实际 ${o.data?.todayRegistered}`)
  check('trend 是 7 天', o.data?.trend?.length === 7, `实际 ${o.data?.trend?.length}`)
  check('trend 每项有 day 和 count', o.data?.trend?.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.day) && typeof t.count === 'number'))
  check('trend 最后一天就是今天', o.data?.trend?.[6]?.day === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))
  check('memberTotal >= activeMembers', o.data?.memberTotal >= o.data?.activeMembers)
  check(
    '⭐ 免费期人数和会员人数分开数（免费不算会员）',
    typeof o.data?.freeActive === 'number' && typeof o.data?.freeExpiring === 'number'
  )
  check('累计送出的免费天数 >= 人数 × 30（注册每人 30 天）', o.data?.freeDaysGranted >= 0, `值=${o.data?.freeDaysGranted}`)
  check('recent 最多 5 条', (o.data?.recent?.length ?? 0) <= 5)

  console.log(
    `    今日 ${o.data?.todayRegistered} / 昨日 ${o.data?.yesterdayRegistered} · 总客户 ${o.data?.totalCustomers} · ` +
      `生效会员 ${o.data?.activeMembers}/${o.data?.memberTotal} · 免费期内 ${o.data?.freeActive} 人 · ` +
      `累计送出 ${o.data?.freeDaysGranted} 天免费 · 可用卡密 ${o.data?.unusedCards}`
  )
}

section('改客户：发会员')
{
  const before = await api('GET', `/api/admin/customers/${globalThis.customerId}`, { token: T })
  const beforeExpire = before.data?.membershipExpireAt
  check('详情带 freeExpireAt（免费天数到哪天）', 'freeExpireAt' in (before.data ?? {}), String(before.data?.freeExpireAt))
  check('详情带天数流水', Array.isArray(before.data?.grants), `条数=${before.data?.grants?.length}`)

  const r = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { membershipLevel: 'basic', membershipDays: 30 }
  })
  check('发会员成功', r.code === 0, `code=${r.code} message=${r.message}`)
  check('等级变成 basic', r.data?.membershipLevel === 'basic')
  check(
    '⭐ 发会员后等级生效（免费天数不算，这里是真会员）',
    r.data?.membershipLevel !== 'none' && Date.parse(r.data?.membershipExpireAt) > Date.now(),
    `${r.data?.membershipLevel} / ${r.data?.membershipExpireAt}`
  )

  const afterExpire = r.data?.membershipExpireAt ? Date.parse(r.data.membershipExpireAt) : 0
  const base = beforeExpire ? Math.max(Date.now(), Date.parse(beforeExpire)) : Date.now()
  const expect = base + 30 * 86_400_000
  check('到期时间 = max(现在, 原到期) + 30 天', Math.abs(afterExpire - expect) < 5000, `差 ${Math.abs(afterExpire - expect)}ms`)

  const badLevel = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { membershipLevel: '乱编的等级' }
  })
  check('不存在的会员等级 → 1001', badLevel.code === 1001, `code=${badLevel.code}`)

  const noneLevel = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { membershipLevel: 'none' }
  })
  check("不能发 'none'（那是非会员哨兵）", noneLevel.code === 1001, `code=${noneLevel.code}`)

  const zeroDays = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { membershipLevel: 'basic', membershipDays: 0 }
  })
  check('顺延 0 天 → 1001', zeroDays.code === 1001, `code=${zeroDays.code}`)
}

section('改客户：封禁 / 值没变不写日志')
{
  const logCountBefore = (await api('GET', '/api/admin/logs?pageSize=1', { token: T })).data?.total

  const ban = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { status: 'banned', banReason: 'spam' }
  })
  check('封禁成功', ban.code === 0 && ban.data?.status === 'banned')
  check('封禁原因存下来了', ban.data?.banReason === 'spam')

  const afterBan = (await api('GET', '/api/admin/logs?pageSize=1', { token: T })).data?.total
  check('封禁落了一条日志', afterBan === logCountBefore + 1, `${logCountBefore} → ${afterBan}`)

  // 重复封一次（状态没变）—— 不该再刷日志
  await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { status: 'banned', banReason: 'spam' }
  })
  const afterDup = (await api('GET', '/api/admin/logs?pageSize=1', { token: T })).data?.total
  check('重复封禁不写第二条日志', afterDup === afterBan, `${afterBan} → ${afterDup}`)

  const unban = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { status: 'active' }
  })
  check('解封成功', unban.data?.status === 'active')
  check('解封后封禁原因被清空', unban.data?.banReason === null, `实际 ${JSON.stringify(unban.data?.banReason)}`)

  // 状态没变 → 不该再写一条（避免刷屏式日志）
  const beforeDup = (await api('GET', '/api/admin/logs?pageSize=1', { token: T })).data?.total
  const dup = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { status: 'active' }
  })
  const afterDup2 = (await api('GET', '/api/admin/logs?pageSize=1', { token: T })).data?.total
  check('状态没变也能正常返回', dup.code === 0 && dup.data?.status === 'active')
  check('状态没变不写日志', afterDup2 === beforeDup, `${beforeDup} → ${afterDup2}`)

  // 额度字段已撤掉 —— 传了不该被写，返回里也不该有这个键
  const legacy = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { quota: 500 }
  })
  check('额度字段已撤掉，传了不生效', legacy.code === 0 && !('quota' in (legacy.data ?? {})), `keys=${Object.keys(legacy.data ?? {}).join(',')}`)
}

section('操作日志')
{
  const logs = await api('GET', '/api/admin/logs?page=1&pageSize=10', { token: T })
  check('日志列表 code 0', logs.code === 0)
  check('按时间倒序（最近的在最前）', Date.parse(logs.data.list[0].createdAt) >= Date.parse(logs.data.list.at(-1).createdAt))

  const byAction = await api('GET', '/api/admin/logs?action=customer.membership', { token: T })
  check('按动作筛选生效', byAction.data?.list?.every((l) => l.action === 'customer.membership'))

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  const byDate = await api('GET', `/api/admin/logs?from=${today}&to=${today}`, { token: T })
  check('按日期筛选能查到今天的日志', byDate.data?.total >= 1, `total=${byDate.data?.total}`)

  const writeAttempt = await api('POST', '/api/admin/logs', { token: T, body: { detail: '伪造一条' } })
  check('没有写日志的接口（404）', writeAttempt.status === 404, `status=${writeAttempt.status}`)
}

section('卡密')
{
  const list = await api('GET', '/api/admin/cards?pageSize=100', { token: T })
  check('卡密列表 code 0', list.code === 0)

  const created = await api('POST', '/api/admin/cards', { token: T, body: { count: 3, expireDays: 90, note: '内部测试' } })
  check('批量生成 3 张', created.code === 0 && created.data?.created?.length === 3)
  check('卡密格式 MIMI-XXXX-XXXX', created.data.created.every((c) => /^MIMI-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c.code)))
  check('是一批不重复的码', new Set(created.data.created.map((c) => c.code)).size === 3)

  const tooMany = await api('POST', '/api/admin/cards', { token: T, body: { count: 101 } })
  check('一次最多 100 张 → 1001', tooMany.code === 1001, `code=${tooMany.code}`)

  const zero = await api('POST', '/api/admin/cards', { token: T, body: { count: 0 } })
  check('生成 0 张 → 1001', zero.code === 1001)

  const target = created.data.created[0]
  const voided = await api('PATCH', `/api/admin/cards/${target.id}`, { token: T, body: { status: 'void' } })
  check('作废成功', voided.code === 0 && voided.data?.status === 'void')

  const again = await api('PATCH', `/api/admin/cards/${target.id}`, { token: T, body: { status: 'void' } })
  check('重复作废 → 1001', again.code === 1001, `code=${again.code}`)

  // 「已使用」的卡没有接口能造（使用只发生在注册流程里），干净库上也没有现成的 ——
  // 所以把刚生成的另一张直接标成已使用，用来验「带 usedByEmail」和「已使用不能作废」。
  const usedTarget = created.data.created[1] ?? created.data.created[0]
  await db.query(
    `UPDATE invite_cards SET status = 'used', used_by_customer_id = $1, used_at = now() WHERE id = $2`,
    [globalThis.customerId, usedTarget.id]
  )
  const afterUse = await api('GET', '/api/admin/cards?pageSize=100', { token: T })
  const usedCard = afterUse.data.list.find((c) => c.id === usedTarget.id)
  check('已用卡密带 usedByEmail', !!usedCard?.usedByEmail, `usedByEmail=${usedCard?.usedByEmail}`)

  const voidUsed = await api('PATCH', `/api/admin/cards/${usedTarget.id}`, { token: T, body: { status: 'void' } })
  check('已使用的卡不能作废 → 1001', voidUsed.code === 1001, `code=${voidUsed.code}`)
}

section('字典')
{
  const d = await api('GET', '/api/admin/dicts', { token: T })
  check('字典一次拿全', d.code === 0 && Array.isArray(d.data))
  check('4 个类型都在', ['ban_reason', 'customer_source', 'card_note', 'membership_level'].every((c) => d.data.some((b) => b.type.code === c)))
  const ml = d.data.find((b) => b.type.code === 'membership_level')
  check('会员等级里有 basic', ml.items.some((i) => i.value === 'basic'))

  const newType = await api('POST', '/api/admin/dicts', { token: T, body: { code: 'smoke_test', name: '冒烟测试', remark: '' } })
  check('新建字典类型', newType.code === 0, `code=${newType.code} ${newType.message ?? ''}`)

  const dupType = await api('POST', '/api/admin/dicts', { token: T, body: { code: 'smoke_test', name: '重复', remark: '' } })
  check('重复编码 → 1001', dupType.code === 1001)

  const badCode = await api('POST', '/api/admin/dicts', { token: T, body: { code: 'Bad-Code', name: 'x' } })
  check('编码格式不对 → 1001', badCode.code === 1001)

  const item = await api('POST', '/api/admin/dicts/smoke_test/items', { token: T, body: { label: '甲', value: 'a' } })
  check('新增字典项', item.code === 0 && item.data?.value === 'a')

  const dupItem = await api('POST', '/api/admin/dicts/smoke_test/items', { token: T, body: { label: '甲2', value: 'a' } })
  check('同类型下重复值 → 1001', dupItem.code === 1001)

  const patched = await api('PATCH', `/api/admin/dicts/items/${item.data.id}`, { token: T, body: { label: '甲改', enabled: false } })
  check('改标签 + 停用', patched.code === 0 && patched.data?.label === '甲改' && patched.data?.enabled === false)

  const del = await api('DELETE', `/api/admin/dicts/items/${item.data.id}`, { token: T })
  check('删字典项', del.code === 0)

  // 清理测试类型，别在库里留垃圾
  await db.query('DELETE FROM dict_items WHERE type_code = $1', ['smoke_test'])
  await db.query('DELETE FROM dict_types WHERE code = $1', ['smoke_test'])
}

section('客户端：图形码 → 发码 → 注册两步')
{
  const email = `smoke-${Date.now()}@example.com`

  /** 每次都拿一张新的图形码（一次性，用过就废） */
  async function freshCaptcha() {
    const c = await api('POST', '/api/client/auth/captcha')
    if (c.code !== 0 || !c.data?.id) throw new Error('拿不到图形码：' + (c.message ?? ''))
    return { captchaId: c.data.id, captchaAnswer: c.data.answer }
  }

  /* ---------------- 图形码 ---------------- */

  const c0 = await api('POST', '/api/client/auth/captcha')
  check('图形码返回 id 和 SVG', c0.code === 0 && !!c0.data?.id && String(c0.data?.image).startsWith('data:image/svg+xml'))
  check('DEV_ECHO_CODE 开着时带答案（供自动化，生产不给）', typeof c0.data?.answer === 'string')

  const wrong = await api('POST', '/api/client/auth/code', {
    body: { email, captchaId: c0.data.id, captchaAnswer: 'ZZZZ' }
  })
  check('图形码不对 → 发码被拒', wrong.code !== 0, `code=${wrong.code}`)
  check('被拒的文案是「校验码不对」', String(wrong.message).includes('校验码'), wrong.message)

  const reuse = await api('POST', '/api/client/auth/code', {
    body: { email, captchaId: c0.data.id, captchaAnswer: c0.data.answer }
  })
  check('同一张图形码用过就作废（重放挡得住）', reuse.code !== 0, `code=${reuse.code}`)

  /* ---------------- 发邮箱验证码 ---------------- */

  const badEmail = await api('POST', '/api/client/auth/code', {
    body: { email: '不是邮箱', ...(await freshCaptcha()) }
  })
  check('邮箱格式不对 → 报错', badEmail.code !== 0 && String(badEmail.message).includes('邮箱'))

  const sent = await api('POST', '/api/client/auth/code', { body: { email, ...(await freshCaptcha()) } })
  check('发验证码成功', sent.code === 0, `code=${sent.code} ${sent.message ?? ''}`)
  check('10 分钟有效期', sent.data?.expiresIn === 600, `expiresIn=${sent.data?.expiresIn}`)

  const tooSoon = await api('POST', '/api/client/auth/code', { body: { email, ...(await freshCaptcha()) } })
  check('60 秒内再发 → 被拒', tooSoon.code !== 0 && String(tooSoon.message).includes('刚发过'), tooSoon.message)

  const row = await db.query(
    'SELECT code FROM login_codes WHERE email = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [email]
  )
  const code = row.rows[0]?.code
  check('验证码进了数据库（重启不丢）', !!code && /^\d{6}$/.test(code), `取到 ${code}`)

  /* ---------------- 注册第一步：邮箱 + 验证码 ---------------- */

  const wrongCode = await api('POST', '/api/client/auth/register', { body: { email, code: '000000' } })
  check('验证码错 → 注册被拒', wrongCode.code !== 0 && String(wrongCode.message).includes('验证码'), wrongCode.message)

  const reg = await api('POST', '/api/client/auth/register', { body: { email, code } })
  check('注册第一步成功', reg.code === 0, `code=${reg.code} ${reg.message ?? ''}`)
  check('返回 needsProfile', reg.data?.needsProfile === true)
  check('返回临时令牌（不靠自增 id 定位账号）', typeof reg.data?.pendingToken === 'string')

  const pendingToken = reg.data.pendingToken

  /* ---------------- 注册第二步：用户名 + 密码 + 头像 ---------------- */

  const shortName = await api('POST', '/api/client/auth/complete-profile', {
    token: pendingToken,
    body: { username: 'a', password: 'smoke1234' }
  })
  check('用户名太短 → 被拒', shortName.code !== 0 && String(shortName.message).includes('用户名'))

  const shortPw = await api('POST', '/api/client/auth/complete-profile', {
    token: pendingToken,
    body: { username: '冒烟测试', password: '123' }
  })
  check('密码太短 → 被拒', shortPw.code !== 0 && String(shortPw.message).includes('密码'))

  const done = await api('POST', '/api/client/auth/complete-profile', {
    token: pendingToken,
    body: { username: '冒烟测试', password: 'smoke1234', avatar: '' }
  })
  check('完成注册', done.code === 0, `code=${done.code} ${done.message ?? ''}`)
  check('用户名写进去了', done.data?.user?.username === '冒烟测试')
  check('profileReady = true', done.data?.user?.profileReady === true)
  check('这一步才发正式 token', typeof done.data?.token === 'string')

  const customerId = Number(done.data.user.id)

  // ⚠️ `AT TIME ZONE 'UTC'` 不能省：时间列是 timestamp(3)（无时区），
  //    驱动会按本地时区把它当成 Date，东八区就差 8 小时。
  //    声明成 timestamptz 之后驱动才解析得对。
  const dbCustomer = await db.query(
    "SELECT membership_level, membership_expire_at, (free_expire_at AT TIME ZONE 'UTC') AS free_at, voucher FROM customers WHERE id = $1",
    [customerId]
  )
  const trial = dbCustomer.rows[0]
  // 注册送的是免费天数，不是会员 —— 等级必须还是 none，会员那一列必须空着
  check('⭐ 注册不给会员等级（送的是免费天数）', trial?.membership_level === 'none', `等级=${trial?.membership_level}`)
  check('会员到期时间没被顺手写上', trial?.membership_expire_at === null, String(trial?.membership_expire_at))

  const freeDays = trial?.free_at ? (new Date(trial.free_at).getTime() - Date.now()) / 86_400_000 : NaN
  check('免费天数约 30 天后到期', Math.abs(freeDays - 30) < 0.01, `实际 ${freeDays.toFixed(3)} 天`)
  check('建号时顺手生成了凭证码', /^([A-Z0-9]{4}-){5}[A-Z0-9]{4}$/.test(trial?.voucher ?? ''), trial?.voucher)

  const again = await api('POST', '/api/client/auth/complete-profile', {
    token: pendingToken,
    body: { username: '再来一次', password: 'smoke1234' }
  })
  check('第二步不能重复提交', again.code !== 0)

  /* ---------------- 临时令牌不能当登录态 ---------------- */

  const pendingMe = await api('GET', '/api/client/auth/me', { token: pendingToken })
  check('⭐ 临时令牌进不了 /me（401）', pendingMe.status === 401, `status=${pendingMe.status}`)

  const pendingAdmin = await api('GET', '/api/admin/customers', { token: pendingToken })
  check('⭐ 临时令牌更进不了管理接口（401）', pendingAdmin.status === 401, `status=${pendingAdmin.status}`)

  /* ---------------- 密码登录 ---------------- */

  const login = await api('POST', '/api/client/auth/login', {
    body: { email, password: 'smoke1234', ...(await freshCaptcha()) }
  })
  check('邮箱 + 密码登录成功', login.code === 0 && typeof login.data?.token === 'string', `code=${login.code} ${login.message ?? ''}`)

  const clientToken = login.data.token

  const badPw = await api('POST', '/api/client/auth/login', {
    body: { email, password: '肯定不是这个', ...(await freshCaptcha()) }
  })
  check('密码错 → 「邮箱或密码不对」', badPw.message === '邮箱或密码不对', badPw.message)

  const noSuchUser = await api('POST', '/api/client/auth/login', {
    body: { email: `nobody-${Date.now()}@example.com`, password: 'whatever', ...(await freshCaptcha()) }
  })
  check('邮箱不存在 → 和密码错同一句话（不暴露邮箱是否存在）', noSuchUser.message === '邮箱或密码不对', noSuchUser.message)

  /* ---------------- 会话 / 凭证 ---------------- */

  const me = await api('GET', '/api/client/auth/me', { token: clientToken })
  check('/me 拿到自己', me.code === 0 && me.data?.user?.email === email)

  const voucher = await api('GET', '/api/client/auth/voucher', { token: clientToken })
  check('拿到凭证码', voucher.code === 0 && /^([A-Z0-9]{4}-){5}[A-Z0-9]{4}$/.test(voucher.data?.code ?? ''), voucher.data?.code)
  check('凭证里带画卡片要的字段', !!voucher.data?.username && !!voucher.data?.email && 'avatar' in (voucher.data ?? {}))

  const vLogin = await api('POST', '/api/client/auth/voucher-login', { body: { voucher: voucher.data.code } })
  check('凭证码登录成功', vLogin.code === 0 && typeof vLogin.data?.token === 'string')

  const vLoose = await api('POST', '/api/client/auth/voucher-login', {
    body: { voucher: `  ${voucher.data.code.toLowerCase().replace(/-/g, ' ')}  ` }
  })
  check('凭证码容忍小写 / 空格 / 少连字符', vLoose.code === 0, `code=${vLoose.code} ${vLoose.message ?? ''}`)

  const vBad = await api('POST', '/api/client/auth/voucher-login', {
    body: { voucher: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF' }
  })
  check('凭证码错 → 被拒', vBad.code !== 0 && String(vBad.message).includes('凭证码'))

  const vShort = await api('POST', '/api/client/auth/voucher-login', { body: { voucher: 'ABCD-1234' } })
  check('凭证码位数不够 → 提示 24 位', String(vShort.message).includes('24'), vShort.message)

  /* ---------------- 改资料 / 改密码 ---------------- */

  const prof = await api('PATCH', '/api/client/auth/profile', {
    token: clientToken,
    body: { username: '改过的名字' }
  })
  check('改用户名成功', prof.code === 0 && prof.data?.user?.username === '改过的名字')

  const badAvatar = await api('PATCH', '/api/client/auth/profile', {
    token: clientToken,
    body: { avatar: 'http://example.com/a.png' }
  })
  check('头像只收 data URL → 被拒', badAvatar.code !== 0 && String(badAvatar.message).includes('头像'))

  const wrongCur = await api('POST', '/api/client/auth/password', {
    token: clientToken,
    body: { currentPassword: '不是当前密码', password: 'newpass1234' }
  })
  check('改密码要当前密码', wrongCur.code !== 0 && String(wrongCur.message).includes('当前密码'))

  const changed = await api('POST', '/api/client/auth/password', {
    token: clientToken,
    body: { currentPassword: 'smoke1234', password: 'newpass1234' }
  })
  check('改密码成功', changed.code === 0)

  const oldPwFail = await api('POST', '/api/client/auth/login', {
    body: { email, password: 'smoke1234', ...(await freshCaptcha()) }
  })
  check('旧密码登不进去了', oldPwFail.code !== 0)

  const newPwOk = await api('POST', '/api/client/auth/login', {
    body: { email, password: 'newpass1234', ...(await freshCaptcha()) }
  })
  check('新密码能登录', newPwOk.code === 0)

  /* ---------------- 改邮箱 ---------------- */

  const newEmail = `smoke-next-${Date.now()}@example.com`
  const sentNew = await api('POST', '/api/client/auth/code', { body: { email: newEmail, ...(await freshCaptcha()) } })
  check('给新邮箱发码', sentNew.code === 0)

  const newRow = await db.query(
    'SELECT code FROM login_codes WHERE email = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [newEmail]
  )

  const sameEmail = await api('POST', '/api/client/auth/email', {
    token: clientToken,
    body: { email, code: newRow.rows[0].code }
  })
  check('改成当前邮箱 → 被拒', sameEmail.code !== 0 && String(sameEmail.message).includes('现在用的'))

  const changedEmail = await api('POST', '/api/client/auth/email', {
    token: clientToken,
    body: { email: newEmail, code: newRow.rows[0].code }
  })
  check('改邮箱成功', changedEmail.code === 0, `code=${changedEmail.code} ${changedEmail.message ?? ''}`)
  check('返回的邮箱是新的', changedEmail.data?.user?.email === newEmail)

  /* ---------------- 封禁 ---------------- */

  const ban = await api('PATCH', `/api/admin/customers/${customerId}`, {
    token: T,
    body: { status: 'banned', banReason: 'spam' }
  })
  check('后台能封掉这个号', ban.code === 0)

  const bannedLogin = await api('POST', '/api/client/auth/login', {
    body: { email: newEmail, password: 'newpass1234', ...(await freshCaptcha()) }
  })
  check('⭐ 被封后登录被拒', bannedLogin.code !== 0, `code=${bannedLogin.code}`)

  const bannedVoucher = await api('POST', '/api/client/auth/voucher-login', { body: { voucher: voucher.data.code } })
  check('⭐ 被封后凭证码也登不进', bannedVoucher.code !== 0)

  await api('PATCH', `/api/admin/customers/${customerId}`, { token: T, body: { status: 'active' } })

  /* ---------------- 刷新凭证码 ---------------- */

  const oldCode = voucher.data.code
  const refreshed = await api('POST', '/api/client/auth/voucher/refresh', { token: clientToken })
  check('刷新凭证码成功', refreshed.code === 0 && /^([A-Z0-9]{4}-){5}[A-Z0-9]{4}$/.test(refreshed.data?.code ?? ''), refreshed.data?.code)
  check('新码和旧码不一样', refreshed.data?.code !== oldCode, `${oldCode} → ${refreshed.data?.code}`)

  const oldLogin = await api('POST', '/api/client/auth/voucher-login', { body: { voucher: oldCode } })
  check('⭐ 旧码刷新后立刻失效', oldLogin.code !== 0, `code=${oldLogin.code}`)

  const newLogin = await api('POST', '/api/client/auth/voucher-login', { body: { voucher: refreshed.data.code } })
  check('新码能登回来', newLogin.code === 0, `code=${newLogin.code} ${newLogin.message ?? ''}`)

  const noAuthRefresh = await api('POST', '/api/client/auth/voucher/refresh')
  check('刷新凭证也要登录 → 401', noAuthRefresh.status === 401, `status=${noAuthRefresh.status}`)

  const adminSees = await api('GET', `/api/admin/customers/${customerId}`, { token: T })
  check('⭐ 刷新后后台看到的是新码', adminSees.data?.voucher === refreshed.data?.code, `${adminSees.data?.voucher}`)

  /* ---------------- 登录记录（IP / 方式 / 时间） ---------------- */

  const loginCount = async () =>
    Number((await db.query('SELECT count(*) AS n FROM login_logs WHERE customer_id = $1', [customerId])).rows[0].n)

  const beforeLogin = await loginCount()
  check('注册那一刻就记了一条登录', beforeLogin >= 1, `条数=${beforeLogin}`)

  const wrongPass = await api('POST', '/api/client/auth/login', {
    body: { email: newEmail, password: '这不是密码', ...(await freshCaptcha()) }
  })
  check('密码错 → 不记登录记录（只记成功的）', wrongPass.code !== 0 && (await loginCount()) === beforeLogin, `条数=${await loginCount()}`)

  const passLogin = await api('POST', '/api/client/auth/login', {
    body: { email: newEmail, password: 'newpass1234', ...(await freshCaptcha()) }
  })
  check('密码登录记一条', passLogin.code === 0 && (await loginCount()) === beforeLogin + 1)

  const voucherLogin = await api('POST', '/api/client/auth/voucher-login', {
    body: { voucher: refreshed.data.code }
  })
  check('凭证登录也记一条', voucherLogin.code === 0 && (await loginCount()) === beforeLogin + 2)

  const loginRows = await db.query(
    'SELECT method, ip, user_agent FROM login_logs WHERE customer_id = $1 ORDER BY created_at DESC, id DESC',
    [customerId]
  )
  check('方式按先后记对了', loginRows.rows[0]?.method === 'voucher' && loginRows.rows[1]?.method === 'password', `${loginRows.rows[0]?.method}/${loginRows.rows[1]?.method}`)
  check('记下了 IP', /^[0-9a-fA-F:.]+$/.test(loginRows.rows[0]?.ip ?? ''), loginRows.rows[0]?.ip)
  check('记下了客户端 UA', String(loginRows.rows[0]?.user_agent ?? '').length > 0)

  /* ---------------- 使用会话（打开软件 → 心跳 → 退出） ---------------- */

  const sessionCount = async () =>
    Number((await db.query('SELECT count(*) AS n FROM client_sessions WHERE customer_id = $1', [customerId])).rows[0].n)

  const beforeSession = await sessionCount()
  const launch1 = await api('POST', '/api/client/auth/launch', { token: clientToken })
  const sid1 = launch1.data?.sessionId
  check('⭐ 打开软件开一行会话并返回 sessionId', launch1.code === 0 && Number.isInteger(sid1) && sid1 > 0, `sessionId=${sid1}`)
  check('会话数 +1', (await sessionCount()) === beforeSession + 1, `条数=${await sessionCount()}`)

  // 心跳：先并一个，再报一个，服务端应该去重/合并，不产生新行
  await api('POST', '/api/client/auth/launch/ping', { token: clientToken, body: { sessionId: sid1 } })
  const pingAgain = await api('POST', '/api/client/auth/launch/ping', { token: clientToken, body: { sessionId: sid1 } })
  check('心跳成功', pingAgain.code === 0, `code=${pingAgain.code}`)
  check('心跳只刷新 last_seen_at，不新增会话', (await sessionCount()) === beforeSession + 1)

  // 退出：结清会话
  const exit1 = await api('POST', '/api/client/auth/launch/exit', { token: clientToken, body: { sessionId: sid1 } })
  check('⭐ 退出结清会话', exit1.code === 0, `code=${exit1.code}`)
  const ended = (
    await db.query('SELECT ended_at, end_reason FROM client_sessions WHERE id = $1', [sid1])
  ).rows[0]
  check('退出后写上了结束时间和原因', ended?.ended_at !== null && ended?.end_reason === 'quit', JSON.stringify(ended))

  // 再开一次 = 又一行（不像 login_logs 那样按天去重），并且把上一次没结清的也结掉
  const launch2 = await api('POST', '/api/client/auth/launch', { token: clientToken })
  const sid2 = launch2.data?.sessionId
  check('⭐ 再开一次是新的会话（不是按天去重）', launch2.code === 0 && sid2 !== sid1, `sid1=${sid1} sid2=${sid2}`)
  check('会话数 +1（共两次启动）', (await sessionCount()) === beforeSession + 2)

  // 没带 sessionId 的 ping/exit → 参数错误
  const pingNoId = await api('POST', '/api/client/auth/launch/ping', { token: clientToken, body: {} })
  check('心跳缺 sessionId → 参数错误', pingNoId.code !== 0, `code=${pingNoId.code}`)

  const launchNoAuth = await api('POST', '/api/client/auth/launch')
  check('打开软件也要登录 → 401', launchNoAuth.status === 401, `status=${launchNoAuth.status}`)

  // 版本号要透传进去
  const withVer = await api('POST', '/api/client/auth/launch', { token: clientToken, headers: { 'x-app-version': '9.9.9-test' } })
  const verRow = (
    await db.query('SELECT app_version FROM client_sessions WHERE id = $1', [withVer.data?.sessionId])
  ).rows[0]
  check('⭐ 启动上报带版本号', verRow?.app_version === '9.9.9-test', String(verRow?.app_version))

  // ⚠️ 守 trustProxy=false。开了它，登录记录的 IP 就等于「调用方自己填的」。
  const spoof = await api('POST', '/api/client/auth/login', {
    body: { email: newEmail, password: 'newpass1234', ...(await freshCaptcha()) },
    headers: { 'x-forwarded-for': '203.0.113.7' }
  })
  const spoofIp = (
    await db.query('SELECT ip FROM login_logs WHERE customer_id = $1 ORDER BY id DESC LIMIT 1', [customerId])
  ).rows[0]?.ip
  check('⭐ 伪造 X-Forwarded-For 不被采信', spoof.code === 0 && spoofIp !== '203.0.113.7', `ip=${spoofIp}`)


  const withLoginLogs = await api('GET', `/api/admin/customers/${customerId}`, { token: T })
  check('⭐ 后台详情带活动记录', Array.isArray(withLoginLogs.data?.loginLogs) && withLoginLogs.data.loginLogs.length >= 3, `条数=${withLoginLogs.data?.loginLogs?.length}`)
  check('活动记录里没有「打开软件」（已挪去使用记录）', !(withLoginLogs.data?.loginLogs ?? []).some((l) => l.method === 'launch'))
  check('⭐ 后台详情带使用记录', Array.isArray(withLoginLogs.data?.sessions) && withLoginLogs.data.sessions.length >= 2, `条数=${withLoginLogs.data?.sessions?.length}`)
  check(
    '使用记录最近的排最前',
    Date.parse(withLoginLogs.data.sessions[0].startedAt) >=
      Date.parse(withLoginLogs.data.sessions.at(-1).startedAt)
  )

  /* ---------------- 两套 token 隔离 ---------------- */

  const cross = await api('GET', '/api/admin/customers', { token: clientToken })
  check('⭐ 客户 token 进不了管理接口（401）', cross.status === 401, `status=${cross.status}`)

  const crossClient = await api('GET', '/api/client/auth/me', { token: T })
  check('⭐ 管理员 token 也进不了客户接口（401）', crossClient.status === 401, `status=${crossClient.status}`)

  /* ---------------- 卡密兑换（客户端） ---------------- */

  /** 造一张卡：走后台接口，最接近运营的真实动作 */
  async function makeCard(payload) {
    const res = await api('POST', '/api/admin/cards', {
      token: T,
      body: { count: 1, note: '兑换冒烟', expireDays: null, ...payload }
    })
    return res.data?.created?.[0] ?? null
  }

  const card90 = await makeCard({ days: 90, level: 'basic' })
  check('造出一张 90 天会员卡', !!card90?.code && card90.days === 90, JSON.stringify(card90 && { days: card90.days, level: card90.level }))

  // 故意用小写 + 不带横杠：抄码的人不止一种写法
  const sloppy = String(card90.code).toLowerCase().replace(/-/g, '')
  const redeemed = await api('POST', '/api/client/redeem', { token: clientToken, body: { code: sloppy } })
  check('小写不带横杠也能兑', redeemed.code === 0, `code=${redeemed.code} ${redeemed.message ?? ''}`)
  check('回的是新会员状态', redeemed.data?.user?.membership?.level === 'basic', String(redeemed.data?.user?.membership?.level))
  check(
    '⭐ 会员剩 120 天（卡的 90 天 + 注册还剩的 30 天免费并进来了，不是被盖掉）',
    Math.abs((redeemed.data?.user?.membership?.memberDaysLeft ?? 0) - 120) <= 1,
    String(redeemed.data?.user?.membership?.memberDaysLeft)
  )
  check(
    '带回了本次兑换摘要（天数 / 到期 / 并进了几天免费）',
    redeemed.data?.grant?.days === 90 &&
      !!redeemed.data?.grant?.expiresAt &&
      redeemed.data?.grant?.absorbedFreeDays === 30,
    JSON.stringify(redeemed.data?.grant ?? {})
  )
  check(
    '免费钱包被清空（并进会员了，不能两边各算一次）',
    redeemed.data?.user?.membership?.freeDaysLeft === null,
    String(redeemed.data?.user?.membership?.freeDaysLeft)
  )

  const usedRow = await db.query('SELECT status, used_by_customer_id FROM invite_cards WHERE code = $1', [card90.code])
  check(
    '卡标成已使用，并记下兑给谁了',
    usedRow.rows[0]?.status === 'used' && Number(usedRow.rows[0]?.used_by_customer_id) === customerId
  )

  const twice = await api('POST', '/api/client/redeem', { token: clientToken, body: { code: card90.code } })
  check('同一张卡兑第二次 → 「你已经兑过了」', String(twice.message).includes('已经兑过'), twice.message)

  const card30 = await makeCard({ days: 30 })
  const stacked = await api('POST', '/api/client/redeem', { token: clientToken, body: { code: card30.code } })
  check(
    '再兑一张 30 天 → 接在 120 天后面（不从今天重算）',
    Math.abs((stacked.data?.user?.membership?.memberDaysLeft ?? 0) - 150) <= 1,
    String(stacked.data?.user?.membership?.memberDaysLeft)
  )

  const voidCard = await makeCard({ days: 30 })
  await api('PATCH', `/api/admin/cards/${voidCard.id}`, { token: T, body: { status: 'void' } })
  const voided = await api('POST', '/api/client/redeem', { token: clientToken, body: { code: voidCard.code } })
  check('作废的卡不能兑', String(voided.message).includes('作废'), voided.message)

  const expireCard = await makeCard({ days: 30 })
  await db.query("UPDATE invite_cards SET expire_at = now() - interval '1 day' WHERE id = $1", [expireCard.id])
  const expired = await api('POST', '/api/client/redeem', { token: clientToken, body: { code: expireCard.code } })
  check('过期的卡不能兑', String(expired.message).includes('过期'), expired.message)

  const ghost = await api('POST', '/api/client/redeem', { token: clientToken, body: { code: 'MIMI-AAAA-BBBB' } })
  check('不存在的码 → 「卡密不对」', String(ghost.message).includes('卡密不对'), ghost.message)

  const selfCode = (await api('GET', '/api/client/auth/me', { token: clientToken })).data?.user?.inviteCode ?? ''
  const selfAsCard = await api('POST', '/api/client/redeem', { token: clientToken, body: { code: selfCode } })
  check('拿自己的邀请码当卡密 → 明确指出这不是卡密', String(selfAsCard.message).includes('邀请码'), selfAsCard.message)

  const noAuth = await api('POST', '/api/client/redeem', { body: { code: card30.code } })
  check('不登录不能兑（401）', noAuth.status === 401, `status=${noAuth.status}`)

  const badShape = await api('POST', '/api/client/redeem', { token: clientToken, body: { code: 'abc' } })
  check('码太短 → 提示检查有没有抄全', String(badShape.message).includes('抄全') || String(badShape.message).includes('卡密是'), badShape.message)

  /* ---------------- 清理这次冒烟造的号 ---------------- */

  // 客户列表章节造的那批夹具（固定邮箱，不会误伤真实用户）
  const fixtures = await db.query(
    `SELECT id FROM customers WHERE email = 'smoke-search@example.com' OR email LIKE 'smoke-page%@example.com'`
  )
  const fixtureIds = fixtures.rows.map((r) => r.id)
  if (fixtureIds.length > 0) {
    await db.query(`DELETE FROM operation_logs WHERE target_type = 'customer' AND target_id = ANY($1)`, [fixtureIds])
    await db.query(`DELETE FROM client_sessions WHERE customer_id = ANY($1)`, [fixtureIds])
    await db.query(`DELETE FROM membership_grants WHERE customer_id = ANY($1)`, [fixtureIds])
    await db.query(`DELETE FROM customers WHERE id = ANY($1)`, [fixtureIds])
  }

  await db.query('DELETE FROM operation_logs WHERE target_type = $1 AND target_id = $2', ['customer', customerId])
  await db.query('DELETE FROM login_logs WHERE customer_id = $1', [customerId])
  await db.query('DELETE FROM client_sessions WHERE customer_id = $1', [customerId])
  await db.query('DELETE FROM membership_grants WHERE customer_id = $1', [customerId])
  await db.query('DELETE FROM customers WHERE id = $1', [customerId])
  await db.query('DELETE FROM login_codes WHERE email = ANY($1)', [[email, newEmail]])
}

section('邀请码：自己发码 / 别人填码 / 归因')
{
  /** 造一个完整注册的号，返回它的 user 和 id */
  async function registerOne(tag, inviteCode) {
    const email = `smoke-inv-${tag}-${Date.now()}@example.com`
    const cap = await api('POST', '/api/client/auth/captcha')
    await api('POST', '/api/client/auth/code', {
      body: { email, captchaId: cap.data.id, captchaAnswer: cap.data.answer }
    })
    const row = await db.query(
      'SELECT code FROM login_codes WHERE email = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [email]
    )
    const reg = await api('POST', '/api/client/auth/register', { body: { email, code: row.rows[0].code } })
    const done = await api('POST', '/api/client/auth/complete-profile', {
      token: reg.data?.pendingToken,
      body: { username: tag, password: 'smoke1234', avatar: '', inviteCode: inviteCode ?? '' }
    })
    return { email, done }
  }

  const CODE_RE = /^MIMI-[A-Z0-9]{4}-[A-Z0-9]{4}$/

  /* ---------------- 每个人注册完就有自己的码 ---------------- */

  const a = await registerOne('冒烟甲')
  check('不带码也能注册', a.done.code === 0, `code=${a.done.code} ${a.done.message ?? ''}`)

  const aId = Number(a.done.data?.user?.id)
  const aCode = a.done.data?.user?.inviteCode || ''
  check('⭐ 注册完就有自己的邀请码', CODE_RE.test(aCode), aCode)
  check('还没邀请过任何人', a.done.data?.user?.invitedCount === 0, String(a.done.data?.user?.invitedCount))

  const aRow = await db.query('SELECT invite_code, referred_by_id FROM customers WHERE id = $1', [aId])
  check('没填码 → 库里两个来源字段都是 null', aRow.rows[0]?.invite_code === null && aRow.rows[0]?.referred_by_id === null, JSON.stringify(aRow.rows[0]))

  /* ---------------- 别人填我的码 ---------------- */

  // 大小写 / 空格 / 少连字符都该认
  const loose = ` ${aCode.toLowerCase().replace(/-/g, ' ')} `
  const b = await registerOne('冒烟乙', loose)
  check('⭐ 填别人的邀请码能注册（且容忍小写/空格）', b.done.code === 0, `code=${b.done.code} ${b.done.message ?? ''}`)

  const bId = Number(b.done.data?.user?.id)
  const bCode = b.done.data?.user?.inviteCode || ''
  check('乙也有自己的码，且和甲的不一样', CODE_RE.test(bCode) && bCode !== aCode, `${aCode} / ${bCode}`)

  const bRow = await db.query('SELECT invite_code, referred_by_id FROM customers WHERE id = $1', [bId])
  check('⭐ 乙记下填的是甲的码', bRow.rows[0]?.invite_code === aCode, String(bRow.rows[0]?.invite_code))
  check('⭐ 归因记到了甲的头上', Number(bRow.rows[0]?.referred_by_id) === aId, `referred_by_id=${bRow.rows[0]?.referred_by_id}`)

  const aMe = await api('GET', '/api/client/auth/me', { token: a.done.data.token })
  check('⭐ 甲的「已邀请」变成 1 人', aMe.data?.user?.invitedCount === 1, String(aMe.data?.user?.invitedCount))
  check('/me 也带自己的邀请码', aMe.data?.user?.inviteCode === aCode, aMe.data?.user?.inviteCode)
  check(
    '⭐ 注册送的 30 天是免费天数，不算会员',
    aMe.data?.user?.membership?.level === 'none' && aMe.data?.user?.membership?.freeDaysLeft >= 29,
    `level=${aMe.data?.user?.membership?.level} 免费剩 ${aMe.data?.user?.membership?.freeDaysLeft} 天`
  )

  /* ---------------- 注册时直接填卡密：按卡上的权益发 ---------------- */

  const regCardRes = await api('POST', '/api/admin/cards', {
    token: T,
    body: { count: 1, days: 90, level: 'basic', note: '兑换冒烟', expireDays: null }
  })
  const regCardCode = regCardRes.data?.created?.[0]?.code

  const cardUser = await registerOne('冒烟丙', regCardCode)
  check('注册第二步填卡密也能过', cardUser.done.code === 0, `code=${cardUser.done.code} ${cardUser.done.message ?? ''}`)

  const cardUserId = Number(cardUser.done.data?.user?.id)
  const cardUserMe = await api('GET', '/api/client/auth/me', { token: cardUser.done.data.token })
  check(
    '⭐ 填了卡 → 注册完直接是会员（等级按卡上写的）',
    cardUserMe.data?.user?.membership?.level === 'basic' && (cardUserMe.data?.user?.membership?.memberDaysLeft ?? 0) >= 89,
    `level=${cardUserMe.data?.user?.membership?.level} 会员剩 ${cardUserMe.data?.user?.membership?.memberDaysLeft} 天`
  )
  check(
    '⭐ 填了卡就不再送 30 天试用（试用是给没买的人的）',
    cardUserMe.data?.user?.membership?.freeDaysLeft === null,
    String(cardUserMe.data?.user?.membership?.freeDaysLeft)
  )

  const usedCardRow = await db.query('SELECT status, used_by_customer_id FROM invite_cards WHERE code = $1', [regCardCode])
  check(
    '这张卡被消耗掉、并记下是谁用的',
    usedCardRow.rows[0]?.status === 'used' && Number(usedCardRow.rows[0]?.used_by_customer_id) === cardUserId
  )

  const cardUserGrants = await db.query("SELECT source, days FROM membership_grants WHERE customer_id = $1 ORDER BY id", [cardUserId])
  check(
    '会员流水记成 card（后台天数流水里能看出是卡密兑的）',
    cardUserGrants.rows.length === 1 && cardUserGrants.rows[0].source === 'card' && cardUserGrants.rows[0].days === 90,
    JSON.stringify(cardUserGrants.rows)
  )

  /* ---------------- 邀请奖励：每邀 1 人 +7 天免费 ---------------- */
  check(
    '⭐ 邀请 1 人 → 邀请人的免费天数 +7',
    aMe.data?.user?.membership?.freeDaysLeft >= 36,
    `免费剩 ${aMe.data?.user?.membership?.freeDaysLeft} 天`
  )
  check('多得了几天也算给客户端（文案要用）', aMe.data?.user?.freeDaysFromInvite === 7, String(aMe.data?.user?.freeDaysFromInvite))

  const aGrants = await db.query(
    'SELECT source, days, starts_at, expires_at FROM membership_grants WHERE customer_id = $1 ORDER BY id',
    [aId]
  )
  const freeSegs = aGrants.rows.filter((r) => r.source === 'trial' || r.source === 'invite')
  check('⭐ 邀请奖励进了天数流水', freeSegs.some((r) => r.source === 'invite' && r.days === 7), JSON.stringify(freeSegs.map((r) => r.source)))
  check('注册那 30 天的流水也在', freeSegs.some((r) => r.source === 'trial' && r.days === 30))
  check(
    '⭐ 流水首尾相接（后一条从前一条到期日接着算，不能留空档）',
    freeSegs.length === 2 &&
      Math.abs(parseDbTime(freeSegs[1].starts_at) - parseDbTime(freeSegs[0].expires_at)) < 3000,
    freeSegs.length === 2
      ? `${parseDbTime(freeSegs[0].expires_at)} vs ${parseDbTime(freeSegs[1].starts_at)}`
      : `段数=${freeSegs.length}`
  )

  /* ---------------- 码不对要被挡住 ---------------- */

  const bad = await registerOne('冒烟丙', 'MIMI-ZZZZ-ZZZZ')
  check('码不存在 → 注册被拒', bad.done.code !== 0 && String(bad.done.message).includes('邀请码'), bad.done.message)

  /* ---------------- 后台卡密是另一种来源，会被消耗 ---------------- */

  await db.query(`DELETE FROM invite_cards WHERE code = 'MIMI-SMOK-0001'`)
  await db.query(
    `INSERT INTO invite_cards (code, note, status, expire_at) VALUES ('MIMI-SMOK-0001', '冒烟测试', 'unused', NULL)`
  )

  const c = await registerOne('冒烟丁', 'MIMI-SMOK-0001')
  check('用后台卡密也能注册', c.done.code === 0, `code=${c.done.code} ${c.done.message ?? ''}`)

  const cId = Number(c.done.data?.user?.id)
  const cardRow = await db.query(`SELECT status, used_by_customer_id FROM invite_cards WHERE code = 'MIMI-SMOK-0001'`)
  check('⭐ 卡密被标成已使用', cardRow.rows[0]?.status === 'used', `status=${cardRow.rows[0]?.status}`)
  check('卡密记下了谁用的', Number(cardRow.rows[0]?.used_by_customer_id) === cId)

  const cRow = await db.query('SELECT invite_code, referred_by_id FROM customers WHERE id = $1', [cId])
  check('用卡密注册 → 没有「邀请人」', cRow.rows[0]?.referred_by_id === null, String(cRow.rows[0]?.referred_by_id))

  const reuseCard = await registerOne('冒烟戊', 'MIMI-SMOK-0001')
  check('同一张卡不能注册第二次', reuseCard.done.code !== 0 && String(reuseCard.done.message).includes('用过了'), reuseCard.done.message)

  /* ---------------- 后台能看出邀请关系 ---------------- */

  const detail = await api('GET', `/api/admin/customers/${aId}`, { token: T })
  check('后台详情带 invitedCount', detail.data?.invitedCount === 1, String(detail.data?.invitedCount))

  const bDetail = await api('GET', `/api/admin/customers/${bId}`, { token: T })
  check('⭐ 后台看得到「谁邀请的」', bDetail.data?.referredBy?.id === aId, JSON.stringify(bDetail.data?.referredBy))

  /* ---------------- 清理 ---------------- */

  // ⚠️ 按邮箱取而不是拿上面那三个 id：码填错的「丙」和重复用卡的「戊」在
  //    complete-profile 就失败了，号已经建出来（profileReady=false），不按邮箱清会留垃圾
  const left = await db.query(`SELECT id FROM customers WHERE email LIKE 'smoke-inv-%@example.com'`)
  const ids = left.rows.map((r) => r.id)
  if (ids.length) {
    await db.query('DELETE FROM operation_logs WHERE target_type = $1 AND target_id = ANY($2)', ['customer', ids])
    await db.query('DELETE FROM login_logs WHERE customer_id = ANY($1)', [ids])
    await db.query('DELETE FROM client_sessions WHERE customer_id = ANY($1)', [ids])
    await db.query('DELETE FROM membership_grants WHERE customer_id = ANY($1)', [ids])
    await db.query('UPDATE customers SET referred_by_id = NULL WHERE referred_by_id = ANY($1)', [ids])
    await db.query('DELETE FROM customers WHERE id = ANY($1)', [ids])
  }
  await db.query(`DELETE FROM invite_cards WHERE code = 'MIMI-SMOK-0001'`)
  await db.query(`DELETE FROM login_codes WHERE email LIKE 'smoke-inv-%@example.com'`)
}

section('客户：后台代建（等价于注册）')
{
  const email = `smoke-created-${Date.now()}@example.com`

  const badMail = await api('POST', '/api/admin/customers', {
    token: T,
    body: { email: '不是邮箱', nickname: '小明', password: '12345678' }
  })
  check('邮箱格式不对 → 1001', badMail.code === 1001, `code=${badMail.code}`)

  const badName = await api('POST', '/api/admin/customers', {
    token: T,
    body: { email, nickname: '一', password: '12345678' }
  })
  check('用户名 1 个字 → 1001（和注册同一套规则）', badName.code === 1001, `code=${badName.code}`)

  const badPwd = await api('POST', '/api/admin/customers', {
    token: T,
    body: { email, nickname: '小明', password: '1234567' }
  })
  check('密码 7 位 → 1001', badPwd.code === 1001, `code=${badPwd.code}`)

  const badDays = await api('POST', '/api/admin/customers', {
    token: T,
    body: { email, nickname: '小明', password: '12345678', trialDays: 99999 }
  })
  check('赠送天数超上限 → 1001', badDays.code === 1001, `code=${badDays.code}`)

  const overviewBefore = await api('GET', '/api/admin/overview', { token: T })

  const created = await api('POST', '/api/admin/customers', {
    token: T,
    body: { email, nickname: '后台代建的人', password: 'abcd1234' }
  })
  check('代建成功', created.code === 0 && created.data?.email === email, `code=${created.code}`)
  // 24 位码是 4 位一组带连字符的，所以字符串长度是 29
  check('发了 24 位凭证码（4 位一组）', /^([A-Z0-9]{4}-){5}[A-Z0-9]{4}$/.test(String(created.data?.voucher ?? '')))
  check(
    '发了邀请码 MIMI-XXXX-XXXX',
    /^MIMI-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(created.data?.referralCode ?? ''))
  )
  check(
    '默认送 30 天试用',
    !!created.data?.freeExpireAt && Date.parse(created.data.freeExpireAt) - Date.now() > 29 * 86400_000
  )
  check('会员等级还是 none（试用不等于会员）', created.data?.membershipLevel === 'none')

  const dup = await api('POST', '/api/admin/customers', {
    token: T,
    body: { email, nickname: '重名的人', password: 'abcd1234' }
  })
  check('邮箱已存在 → 1001', dup.code === 1001, `code=${dup.code}`)

  // 「等价于注册」的硬证据：库里和真注册出来的行长得一样
  const row = await db.query(
    `SELECT id, profile_ready, password_hash, voucher, referral_code, free_expire_at FROM customers WHERE email = $1`,
    [email]
  )
  const me = row.rows[0]
  check('profileReady = true（所以算「今日注册」）', me?.profile_ready === true)
  check('存的是 scrypt 哈希，不是明文', String(me?.password_hash ?? '').startsWith('scrypt$'))
  check('免费到期时间已落库', !!me?.free_expire_at)

  const overviewAfter = await api('GET', '/api/admin/overview', { token: T })
  check(
    '今日注册 +1',
    overviewAfter.data?.todayRegistered === overviewBefore.data?.todayRegistered + 1,
    `${overviewBefore.data?.todayRegistered} → ${overviewAfter.data?.todayRegistered}`
  )

  globalThis.smokeCreatedCustomerId = me?.id

  /* ---------------- 删除 ---------------- */

  // 给他造一条反馈和一条登录记录，用来验证「删号之后关联数据怎么办」
  // ⚠️ 上面建号失败时 me 是 undefined，这里先兜住：空 id 硬插会触发 not-null 报错，
  //    脚本直接崩在半路，后面的断言一条都跑不到 —— 看到的错误还跟真正的原因无关
  // ⚠️ 反馈正文带上邮箱：固定文案会撞上「上次跑崩了没清掉」的旧行，
  //    按正文查就会查出两条，断言跟着假失败
  const fbContent = `删号前发的反馈 ${email}`
  if (!me?.id) {
    check('（建号失败，删除段跳过）', false, '没有 customerId')
  } else {
    await db.query(
      `INSERT INTO feedbacks (customer_id, contact_email, contact_name, kind, content, app_version, platform, device_id, status, note, handled_by, ip, created_at, updated_at)
       VALUES ($1, $2, $3, 'bug', $4, '9.9.9', 'win32', 'smoke-del', 'pending', '', '', '127.0.0.1', now(), now())`,
      [me.id, email, '后台代建的人', fbContent]
    )
    await db.query(
      `INSERT INTO login_logs (customer_id, method, ip, user_agent, created_at) VALUES ($1, 'password', '127.0.0.1', 'smoke', now())`,
      [me.id]
    )
  }

  const ghostDelete = await api('DELETE', '/api/admin/customers/99999999', { token: T })
  check('删不存在的客户 → 40400', ghostDelete.code === 40400, `code=${ghostDelete.code}`)

  const removed = await api('DELETE', `/api/admin/customers/${me?.id}`, { token: T })
  check('删除成功', removed.code === 0, `code=${removed.code}`)

  const gone = await db.query(`SELECT id FROM customers WHERE id = $1`, [me?.id])
  check('客户真没了', gone.rowCount === 0)

  const logs = await db.query(`SELECT count(*)::int n FROM login_logs WHERE customer_id = $1`, [me?.id])
  check('登录记录一起清掉（不留孤儿行）', logs.rows[0].n === 0, `剩 ${logs.rows[0].n} 条`)

  const fb = await db.query(
    `SELECT customer_id, contact_email, contact_name FROM feedbacks WHERE content = $1`,
    [fbContent]
  )
  check('反馈保留下来了', fb.rowCount === 1, `查到 ${fb.rowCount} 条`)
  check('但 customerId 已置空', fb.rows[0]?.customer_id === null)
  check('联系方式也抹掉了', fb.rows[0]?.contact_email === '' && fb.rows[0]?.contact_name === '')

  const audit = await db.query(
    `SELECT target_name, detail FROM operation_logs WHERE action = 'customer.delete' AND target_id = $1`,
    [me?.id]
  )
  check('操作日志留了名字和邮箱（删完只剩这一处还认得出他）', String(audit.rows[0]?.target_name ?? '').includes(email))
  check('日志里写明了反馈已匿名', String(audit.rows[0]?.detail ?? '').includes('匿名'))
}

section('消息：意见反馈（客户端发 / 后台处理）')
{
  const device = `smoke-dev-${Date.now()}`

  const empty = await api('POST', '/api/client/feedback', { body: { kind: 'bug', content: '   ', deviceId: device } })
  check('空内容 → 1001', empty.code === 1001, `code=${empty.code}`)

  const tooLong = await api('POST', '/api/client/feedback', {
    body: { kind: 'bug', content: '啊'.repeat(2001), deviceId: device }
  })
  check('正文超 2000 字 → 1001', tooLong.code === 1001, `code=${tooLong.code}`)

  const badKind = await api('POST', '/api/client/feedback', {
    body: { kind: '投诉', content: '随便写点', deviceId: device }
  })
  check('类型不在枚举里 → 1001', badKind.code === 1001, `code=${badKind.code}`)

  const badMail = await api('POST', '/api/client/feedback', {
    body: { kind: 'idea', content: '随便写点', deviceId: device, contactEmail: '不是邮箱' }
  })
  check('邮箱格式不对 → 1001', badMail.code === 1001, `code=${badMail.code}`)

  // 不登录也要能发 —— 这是这个功能的设计前提（连登录都进不去时才最需要报错）
  const sent = await api('POST', '/api/client/feedback', {
    body: {
      kind: 'bug',
      content: '冒烟测试：世界书条目多了以后滚动会卡。',
      appVersion: '9.9.9',
      platform: 'win32',
      deviceId: device
    }
  })
  check('未登录也能发反馈', sent.code === 0 && typeof sent.data?.id === 'number', `code=${sent.code}`)
  globalThis.smokeFeedbackId = sent.data?.id

  const again = await api('POST', '/api/client/feedback', {
    body: { kind: 'bug', content: '紧接着又来一条', deviceId: device }
  })
  check('同一设备 60 秒内再发 → 1003', again.code === 1003, `code=${again.code}`)

  const list = await api('GET', '/api/admin/feedbacks?page=1&pageSize=50', { token: T })
  const row = list.data?.list?.find((f) => f.id === globalThis.smokeFeedbackId)
  check('后台列表里能看到这条反馈', !!row)
  check('未登录发的反馈 customerId 是 null', row?.customerId === null)
  check('版本号存下来了', row?.appVersion === '9.9.9')
  check('默认状态是 pending', row?.status === 'pending')

  const c = list.data?.counts
  check('counts 里五个状态 + 今日都有', !!c && typeof c.pending === 'number' && typeof c.today === 'number')
  check('counts.total ≥ 各状态之和', c && c.total >= c.pending + c.read + c.resolved + c.ignored)

  const handled = await api('PATCH', `/api/admin/feedbacks/${globalThis.smokeFeedbackId}`, {
    token: T,
    body: { status: 'resolved', note: '冒烟测试写的备注' }
  })
  check('改状态成功', handled.code === 0 && handled.data?.status === 'resolved')
  check('记下了处理人', handled.data?.handledBy === '星宝')
  check('备注存下来了', handled.data?.note === '冒烟测试写的备注')

  const noChange = await api('PATCH', `/api/admin/feedbacks/${globalThis.smokeFeedbackId}`, {
    token: T,
    body: { status: 'resolved' }
  })
  check('状态没变时不写日志，直接 1001', noChange.code === 1001, `code=${noChange.code}`)

  const badStatus = await api('PATCH', `/api/admin/feedbacks/${globalThis.smokeFeedbackId}`, {
    token: T,
    body: { status: '已处理' }
  })
  check('状态不在枚举里 → 1001', badStatus.code === 1001, `code=${badStatus.code}`)

  const ghost = await api('PATCH', '/api/admin/feedbacks/99999999', { token: T, body: { status: 'read' } })
  check('改不存在的反馈 → 40400', ghost.code === 40400, `code=${ghost.code}`)

  const noAuth = await api('GET', '/api/admin/feedbacks')
  check('未登录看不到反馈列表 → 401', noAuth.status === 401)
}

section('消息：通知公告（后台发 / 客户端拉）')
{
  const emptyTitle = await api('POST', '/api/admin/announcements', {
    token: T,
    body: { title: '  ', content: '正文' }
  })
  check('空标题 → 1001', emptyTitle.code === 1001, `code=${emptyTitle.code}`)

  const emptyBody = await api('POST', '/api/admin/announcements', {
    token: T,
    body: { title: '标题', content: '' }
  })
  check('空正文 → 1001', emptyBody.code === 1001, `code=${emptyBody.code}`)

  const badRange = await api('POST', '/api/admin/announcements', {
    token: T,
    body: {
      title: '时间反了',
      content: '正文',
      startsAt: '2026-12-02T00:00:00.000Z',
      endsAt: '2026-12-01T00:00:00.000Z'
    }
  })
  check('失效时间早于生效时间 → 1001', badRange.code === 1001, `code=${badRange.code}`)

  const badLevel = await api('POST', '/api/admin/announcements', {
    token: T,
    body: { title: '级别不对', content: '正文', level: '紧急' }
  })
  check('级别不在枚举里 → 1001', badLevel.code === 1001, `code=${badLevel.code}`)

  const created = await api('POST', '/api/admin/announcements', {
    token: T,
    body: { title: '冒烟测试公告', content: '这条是冒烟测试发的，跑完会删掉。', level: 'important', pinned: true }
  })
  check('发公告成功', created.code === 0 && typeof created.data?.id === 'number', `code=${created.code}`)
  globalThis.smokeAnnouncementId = created.data?.id
  check('作者记成了当前管理员', created.data?.authorName === '星宝')
  check('置顶存下来了', created.data?.pinned === true)

  // 客户端一侧：不带 token 也要能拉
  const clientList = await api('GET', '/api/client/announcements')
  const mine = clientList.data?.list?.find((a) => a.id === globalThis.smokeAnnouncementId)
  check('客户端（未登录）能拉到这条公告', !!mine)
  check('未登录时 isRead 是 false', mine?.isRead === false)

  const adminList = await api('GET', '/api/admin/announcements?page=1&pageSize=50', { token: T })
  check('后台 liveCount ≥ 1', (adminList.data?.liveCount ?? 0) >= 1, `liveCount=${adminList.data?.liveCount}`)

  const off = await api('PATCH', `/api/admin/announcements/${globalThis.smokeAnnouncementId}`, {
    token: T,
    body: { enabled: false }
  })
  check('下架成功', off.code === 0 && off.data?.enabled === false)

  const afterOff = await api('GET', '/api/client/announcements')
  check(
    '下架后客户端拉不到',
    !afterOff.data?.list?.some((a) => a.id === globalThis.smokeAnnouncementId)
  )

  const backOn = await api('PATCH', `/api/admin/announcements/${globalThis.smokeAnnouncementId}`, {
    token: T,
    body: { enabled: true, title: '冒烟测试公告（改过）' }
  })
  check('重新上架并改标题', backOn.code === 0 && backOn.data?.title === '冒烟测试公告（改过）')

  const badPatch = await api('PATCH', `/api/admin/announcements/${globalThis.smokeAnnouncementId}`, {
    token: T,
    body: { enabled: 'yes' }
  })
  check('enabled 传字符串 → 1001', badPatch.code === 1001, `code=${badPatch.code}`)

  const removed = await api('DELETE', `/api/admin/announcements/${globalThis.smokeAnnouncementId}`, { token: T })
  check('删除成功', removed.code === 0)

  const afterDelete = await api('GET', '/api/client/announcements')
  check(
    '删掉之后客户端也拉不到',
    !afterDelete.data?.list?.some((a) => a.id === globalThis.smokeAnnouncementId)
  )

  const ghost = await api('DELETE', '/api/admin/announcements/99999999', { token: T })
  check('删不存在的公告 → 40400', ghost.code === 40400, `code=${ghost.code}`)

  /* ---------------- 清理：这一场跑出来的全部收干净 ---------------- */
  // ⚠️ 必须放在**最后一个**用库的段落里。之前这段清理写在「邀请码」段（文件中间），
  //    后面的消息段又写了几条日志，于是每次跑完库里都留着 4 条假的「管理员发公告」。
  await db.query(`DELETE FROM feedbacks WHERE app_version = '9.9.9'`)
  await db.query(`DELETE FROM announcements WHERE title LIKE '冒烟测试公告%'`)

  // 这一场注册的账号（smoke<时间戳>b / smoke-inv-*）—— 不删的话「今日注册」天天被撑大。
  // 本库不建外键，所以关联表得自己一个个清，不然会留一堆指向不存在客户的孤儿行
  const smokeAccounts = await db.query(`SELECT id FROM customers WHERE email LIKE 'smoke%@example.com'`)
  const mineIds = smokeAccounts.rows.map((r) => r.id)
  if (mineIds.length) {
    await db.query('DELETE FROM login_logs WHERE customer_id = ANY($1)', [mineIds])
    await db.query('DELETE FROM client_sessions WHERE customer_id = ANY($1)', [mineIds])
    await db.query('DELETE FROM membership_grants WHERE customer_id = ANY($1)', [mineIds])
    await db.query('DELETE FROM announcement_reads WHERE customer_id = ANY($1)', [mineIds])
    await db.query('DELETE FROM feedbacks WHERE customer_id = ANY($1)', [mineIds])
    await db.query('UPDATE customers SET referred_by_id = NULL WHERE referred_by_id = ANY($1)', [mineIds])
    await db.query('DELETE FROM customers WHERE id = ANY($1)', [mineIds])
  }

  // 卡密按「这场跑出来的时间窗」删：不按备注删，否则会误伤星宝自己建的「内部测试」卡
  await db.query(`DELETE FROM invite_cards WHERE created_at >= $1`, [RUN_START_UTC])

  // 最后兜一刀：这场写出来的操作日志全清掉（卡密 / 字典 / 公告那几条没有 id 可循，只能按时间切）
  await db.query(`DELETE FROM operation_logs WHERE created_at >= $1`, [RUN_START_UTC])

  // 验证码：这场发出去的都删掉。不删的话每跑一次留十来条，虽然会过期，
  // 但表会一直变大，「最近的验证码」这种排查会看到一堆烟雾测试的邮箱
  await db.query(`DELETE FROM login_codes WHERE email LIKE 'smoke%@example.com'`)
}

section('参数校验兜底')
{
  const badJson = await fetch(`${BASE}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` },
    body: '{ 这不是 json'
  })
  check('坏 JSON 返回 4xx 而不是 500', badJson.status >= 400 && badJson.status < 500, `status=${badJson.status}`)

  const missing = await api('GET', '/api/nonexistent', { token: T })
  check('不存在的路径 → 404 + 40400', missing.status === 404 && missing.code === 40400)
}

await db.end()

/* ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(52)}`)
if (failures.length === 0) {
  console.log(`全部通过：${passed} 条断言`)
} else {
  console.log(`通过 ${passed} 条，失败 ${failures.length} 条：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
