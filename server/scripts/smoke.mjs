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

async function api(method, path, { token, body } = {}) {
  const headers = {}
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

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

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
  const list = await api('GET', '/api/admin/customers?page=1&pageSize=5', { token: T })
  check('列表返回 code 0', list.code === 0)
  check('有数据（种子造了 12 个）', list.data?.total >= 12, `total=${list.data?.total}`)
  check('每页 5 条', list.data?.list?.length === 5, `实际 ${list.data?.list?.length}`)

  const first = list.data?.list?.[0]
  check('客户字段齐全（email/nickname/status/quota）', !!first?.email && !!first?.nickname && !!first?.status)
  check('时间字段是 ISO 字符串', typeof first?.createdAt === 'string' && first.createdAt.includes('T'))

  const banned = await api('GET', '/api/admin/customers?status=banned', { token: T })
  check('按状态筛出被封的', banned.data?.list?.every((c) => c.status === 'banned'))

  const kw = await api('GET', '/api/admin/customers?keyword=夜航船', { token: T })
  check('按昵称搜索命中', kw.data?.total >= 1, `total=${kw.data?.total}`)

  const kwCard = await api('GET', '/api/admin/customers?keyword=MIMI', { token: T })
  check('按邀请码搜索命中', kwCard.data?.total >= 1, `total=${kwCard.data?.total}`)

  const nope = await api('GET', '/api/admin/customers?keyword=绝对搜不到的东西xyz', { token: T })
  check('搜不到时 total 为 0、list 是空数组', nope.data?.total === 0 && Array.isArray(nope.data?.list))

  globalThis.customerId = first?.id
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
  check('recent 最多 5 条', (o.data?.recent?.length ?? 0) <= 5)

  console.log(
    `    今日 ${o.data?.todayRegistered} / 昨日 ${o.data?.yesterdayRegistered} · 总客户 ${o.data?.totalCustomers} · ` +
      `生效会员 ${o.data?.activeMembers}/${o.data?.memberTotal} · 7 天内到期 ${o.data?.expiringIn7Days} · 可用卡密 ${o.data?.unusedCards}`
  )
}

section('改客户：发会员')
{
  const before = await api('GET', `/api/admin/customers/${globalThis.customerId}`, { token: T })
  const beforeExpire = before.data?.membershipExpireAt

  const r = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { membershipLevel: 'basic', membershipDays: 30 }
  })
  check('发会员成功', r.code === 0, `code=${r.code} message=${r.message}`)
  check('等级变成 basic', r.data?.membershipLevel === 'basic')

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

section('改客户：封禁 / 改额度 / 值没变不写日志')
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

  const quota = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { quota: 500 }
  })
  check('改额度成功', quota.data?.quota === 500)

  const same = await api('PATCH', `/api/admin/customers/${globalThis.customerId}`, {
    token: T,
    body: { quota: 500 }
  })
  check('提交同一个额度也能正常返回（只是不写日志）', same.code === 0 && same.data?.quota === 500)
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
  const used = list.data.list.find((c) => c.status === 'used')
  check('已用卡密带 usedByEmail', !!used?.usedByEmail)

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

  const usedCard = list.data.list.find((c) => c.status === 'used')
  const voidUsed = await api('PATCH', `/api/admin/cards/${usedCard.id}`, { token: T, body: { status: 'void' } })
  check('已使用的卡不能作废 → 1001', voidUsed.code === 1001, `code=${voidUsed.code}`)
}

section('字典')
{
  const d = await api('GET', '/api/admin/dicts', { token: T })
  check('字典一次拿全', d.code === 0 && Array.isArray(d.data))
  check('5 个类型都在', ['ban_reason', 'customer_source', 'quota_preset', 'card_note', 'membership_level'].every((c) => d.data.some((b) => b.type.code === c)))
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
    "SELECT membership_level, (membership_expire_at AT TIME ZONE 'UTC') AS exp_at, voucher FROM customers WHERE id = $1",
    [customerId]
  )
  const trial = dbCustomer.rows[0]
  check('库里会员等级是 basic', trial?.membership_level === 'basic', `等级=${trial?.membership_level}`)

  const trialDays = trial?.exp_at ? (new Date(trial.exp_at).getTime() - Date.now()) / 86_400_000 : NaN
  check('到期时间约 30 天后', Math.abs(trialDays - 30) < 0.01, `实际 ${trialDays.toFixed(3)} 天`)
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

  /* ---------------- 两套 token 隔离 ---------------- */

  const cross = await api('GET', '/api/admin/customers', { token: clientToken })
  check('⭐ 客户 token 进不了管理接口（401）', cross.status === 401, `status=${cross.status}`)

  const crossClient = await api('GET', '/api/client/auth/me', { token: T })
  check('⭐ 管理员 token 也进不了客户接口（401）', crossClient.status === 401, `status=${crossClient.status}`)

  /* ---------------- 清理这次冒烟造的号 ---------------- */

  await db.query('DELETE FROM operation_logs WHERE target_type = $1 AND target_id = $2', ['customer', customerId])
  await db.query('DELETE FROM customers WHERE id = $1', [customerId])
  await db.query('DELETE FROM login_codes WHERE email = ANY($1)', [[email, newEmail]])
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
