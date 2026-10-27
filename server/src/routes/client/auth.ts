import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Customer } from '../../generated/prisma/client.js'
import { prisma } from '../../prisma.js'
import { env } from '../../env.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { biz } from '../../lib/bizError.js'
import { hashPassword, verifyPassword } from '../../lib/password.js'
import { issueTokens, issuePendingToken, readRefreshToken } from '../../lib/auth.js'
import { createCaptcha, verifyCaptcha } from '../../lib/captcha.js'
import { makeVoucher, normalizeVoucher } from '../../lib/voucher.js'
import { sendLoginCode } from '../../lib/mail.js'
import { currentCustomerId } from '../../lib/whoami.js'
import { DAY_MS } from '../../lib/time.js'

/**
 * 客户侧账号 —— 前缀 /api/client/auth
 *
 * 这里的接口形状是照着 `client/main/account.js` 那 12 个 IPC 通道定的，
 * 不是照 `登录体系决策记录.md` 决策 3 的「纯验证码登录即注册」。
 * 决策 3 是 2026-10-08 定的，客户端界面 2026-10-23 做的却是
 * **邮箱 + 密码 + 图形码 + 24 位凭证码 + 两步注册**。以客户端为准（2026-10-27 定）。
 *
 * 流程：
 *   ① POST /captcha           拿一张图形码
 *   ② POST /code              图形码过了才发邮箱验证码
 *   ③ POST /register          邮箱 + 验证码 → 建一个「还没设资料」的空号，发临时令牌
 *   ④ POST /complete-profile  带临时令牌，设用户名+密码+头像 → 账号可用，发正式 token
 *   ⑤ POST /login             邮箱 + 密码 + 图形码
 *   ⑥ POST /voucher-login     24 位凭证码（换机器用）
 */

/** 头像上限（base64 字符数，约 300KB 原图）—— 客户端上传前已经压到 256×256 */
const MAX_AVATAR_CHARS = 400 * 1000

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** 验证码：10 分钟有效，60 秒内不许重发，最多试 5 次 */
const CODE_TTL = 600
const CODE_COOLDOWN_MS = 60_000
const CODE_DAILY_LIMIT = 30
const CODE_MAX_TRIES = 5

/** 新用户送的免费试用 */
const TRIAL_DAYS = 30

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeEmail(value: unknown): string {
  const email = textOf(value).toLowerCase()
  if (!EMAIL_RE.test(email)) throw biz('邮箱格式不对，检查一下')
  if (email.length > 120) throw biz('邮箱太长了')
  return email
}

function normalizeUsername(value: unknown): string {
  const name = textOf(value)
  if (name.length < 2) throw biz('用户名至少 2 个字')
  if (name.length > 20) throw biz('用户名最多 20 个字')
  return name
}

function normalizePassword(value: unknown): string {
  const password = String(value ?? '')
  if (password.length < 8) throw biz('密码至少 8 位')
  if (password.length > 128) throw biz('密码最多 128 位')
  return password
}

/** 头像只收图片 data URL */
function normalizeAvatar(value: unknown): string {
  const avatar = textOf(value)
  if (!avatar) return ''
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(avatar)) {
    throw biz('头像格式不认识（只收 PNG / JPEG / WebP）')
  }
  if (avatar.length > MAX_AVATAR_CHARS) throw biz('头像太大了，换一张小一点的')
  return avatar
}

/**
 * 给客户端的账号形状 —— 跟客户端 `publicUser()` 完全一致。
 * ⚠️ id 转成字符串：客户端原来用 UUID，渲染层可能拿它做字符串比较。
 *    服务端内部是自增 int，但**别把它当凭据**（认证一律走 token）。
 */
function toClientUser(c: Customer) {
  return {
    id: String(c.id),
    email: c.email,
    username: c.nickname,
    avatar: c.avatar ?? '',
    createdAt: c.createdAt.toISOString(),
    profileReady: c.profileReady
  }
}

/** 封禁了就拦住，登录、换码、凭证登录都一样 */
function assertNotBanned(customer: Customer | null): void {
  if (customer?.status === 'banned') {
    throw biz(
      customer.banReason ? '账号已被封禁，如有疑问请联系我们' : '账号已被封禁',
      ApiCode.ACCOUNT_BANNED
    )
  }
}

/**
 * 验证码试错计数（内存）—— 六位数不设上限的话可以硬试。
 * 不落库的理由：重启把计数清掉影响很小，而这张表不值得为它加一列。
 */
const codeTries = new Map<string, number>()

/**
 * 取最近一条还没用的验证码并核销。
 * 错一次记一次，满 5 次就把这个邮箱的待用码全废掉 —— 让她重新发一封。
 */
async function consumeEmailCode(email: string, code: string): Promise<void> {
  const tries = codeTries.get(email) ?? 0

  if (tries >= CODE_MAX_TRIES) {
    await prisma.loginCode.deleteMany({ where: { email, consumedAt: null } })
    codeTries.delete(email)
    throw biz('试错次数太多，重新获取验证码')
  }

  const entry = await prisma.loginCode.findFirst({
    where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }
  })

  if (!entry) throw biz('验证码过期了，重新获取')

  if (entry.code !== textOf(code)) {
    codeTries.set(email, tries + 1)
    throw biz('验证码不对，再看看邮件')
  }

  codeTries.delete(email)
  await prisma.loginCode.update({ where: { id: entry.id }, data: { consumedAt: new Date() } })
}

/**
 * 新用户送哪一档会员。
 * 优先字典里叫 basic 的那档；运营改名/删了就往回退，别让注册直接失败。
 */
async function trialLevel(): Promise<string> {
  const basic = await prisma.dictItem.findFirst({
    where: { typeCode: 'membership_level', value: 'basic', enabled: true },
    select: { value: true }
  })
  if (basic) return basic.value

  const fallback = await prisma.dictItem.findFirst({
    where: { typeCode: 'membership_level', enabled: true },
    orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    select: { value: true }
  })
  return fallback?.value ?? 'none'
}

/* ------------------------------------------------------------------ */
/* 公开接口                                                            */
/* ------------------------------------------------------------------ */

export const clientAuthPublicRoutes: FastifyPluginAsync = async (app) => {
  /**
   * ① 图形校验码
   * ⚠️ 只有 DEV_ECHO_CODE 开着（本地开发）才把答案一起返回，好让自动化测试跑得通。
   *    生产环境打死也不给 —— 给了等于没有这道闸。
   */
  app.post('/captcha', async () => {
    return ok(createCaptcha({ reveal: env.devEchoCode }))
  })

  /** ② 发邮箱验证码 —— 必须先过图形码，否则这接口就是免费的邮件轰炸器 */
  app.post('/code', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    // 图形码先过。抛的错文案跟客户端那版一致
    verifyCaptcha(body.captchaId, body.captchaAnswer)

    const email = normalizeEmail(body.email)
    const now = Date.now()

    const existing = await prisma.customer.findUnique({ where: { email } })
    if (existing?.profileReady) {
      // ⚠️ 这里确实暴露了「邮箱是否注册」。客户端原版也是这个取舍：
      //    注册流程里报清楚更省事。等有风控要求再改成「无论是否注册都返回成功」。
      throw biz('这个邮箱已经注册过了，直接登录')
    }

    const recent = await prisma.loginCode.findFirst({
      where: { email, createdAt: { gt: new Date(now - CODE_COOLDOWN_MS) } },
      orderBy: { createdAt: 'desc' }
    })
    if (recent) throw biz('刚发过一封，等一分钟再试')

    const todayCount = await prisma.loginCode.count({
      where: { email, createdAt: { gt: new Date(now - DAY_MS) } }
    })
    if (todayCount >= CODE_DAILY_LIMIT) throw biz('这个邮箱今天要的验证码太多了，明天再试')

    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
    await prisma.loginCode.create({
      data: { email, code, expiresAt: new Date(now + CODE_TTL * 1000) }
    })
    // 顺手清掉两天前的，这张表不用留档
    await prisma.loginCode.deleteMany({ where: { expiresAt: { lt: new Date(now - 2 * DAY_MS) } } })

    const sent = await sendLoginCode(email, code, Math.round(CODE_TTL / 60))

    if (!sent && !env.devEchoCode) throw biz('验证码没发出去，稍后再试')

    if (sent) console.info(`[mail] 已发送 —— ${email} 的验证码是 ${code}`)
    else console.info(`[mail] 没发出去，DEV_ECHO_CODE 开着 —— ${email} 的验证码是 ${code}`)

    // DEV_ECHO_CODE 开着就**始终**把码一起返回（邮件照发，只是额外多给一份）——
    // 客户端冒烟测试跑在 Electron 里，没法去 mailpit 网页里抄验证码。
    // 生产必须把它关掉，否则这道验证码等于不存在。
    if (env.devEchoCode) {
      return ok({ email, expiresIn: CODE_TTL, deliver: 'dev', devCode: code })
    }

    return ok({ email, expiresIn: CODE_TTL, deliver: 'email' })
  })

  /** ③ 注册第一步：邮箱 + 验证码 → 建一个「还没设资料」的空号 */
  app.post('/register', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const email = normalizeEmail(body.email)
    await consumeEmailCode(email, textOf(body.code))

    const existing = await prisma.customer.findUnique({ where: { email } })
    if (existing?.profileReady) throw biz('这个邮箱注册过了，直接登录')

    // 已经建过空号（上次走到一半跑了）—— 直接复用，别报「已注册」把人卡死
    const customer =
      existing ??
      (await prisma.customer.create({
        data: {
          email,
          // 先拿邮箱前缀顶着，第二步会覆盖成用户自己填的
          nickname: email.split('@')[0] || '旅人',
          status: 'active',
          quota: 0,
          profileReady: false
        }
      }))

    return ok({
      accountId: String(customer.id),
      email: customer.email,
      needsProfile: true,
      // ⚠️ 第二步靠这个令牌定位账号，不靠 accountId —— 自增 id 能被枚举，
      //    否则谁都能给别人的号设资料
      pendingToken: issuePendingToken(app, customer.id)
    })
  })

  /**
   * ④ 注册第二步：用户名 + 密码 + 头像 → 账号正式可用
   *
   * 这一步用 pendingToken 认证（不走 clientGuard —— 那个会拒绝 pending）。
   */
  app.post('/complete-profile', async (request, reply) => {
    const customerId = await readPendingToken(request, reply)
    if (customerId === null) return reply

    const body = (request.body ?? {}) as Record<string, unknown>
    const username = normalizeUsername(body.username)
    const password = normalizePassword(body.password)
    const avatar = normalizeAvatar(body.avatar)

    const customer = await prisma.customer.findUnique({ where: { id: customerId } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '注册信息过期了，重新来一遍')
    if (customer.profileReady) throw biz('这个账号已经设置过了')

    assertNotBanned(customer)

    const level = await trialLevel()
    const now = new Date()

    const updated = await prisma.$transaction(async (tx) => {
      // 凭证码要唯一：撞了就换一个再来（31^24 的空间，实际几乎不会撞）
      let voucher: string | null = null
      for (let attempt = 0; attempt < 5 && !voucher; attempt += 1) {
        const candidate = makeVoucher()
        const clash = await tx.customer.findUnique({ where: { voucher: candidate }, select: { id: true } })
        if (!clash) voucher = candidate
      }
      if (!voucher) throw biz('凭证码生成失败，稍后再试')

      return tx.customer.update({
        where: { id: customer.id },
        data: {
          nickname: username,
          avatar: avatar || null,
          passwordHash: await hashPassword(password),
          voucher,
          profileReady: true,
          lastLoginAt: now,
          // 试用会员在这里发 —— 只有走完第二步的号才算「真的注册了」，
          // 后台的「今日注册」也跟着只算这些人
          membershipLevel: level,
          membershipExpireAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS)
        }
      })
    })

    // 形状跟客户端那 12 个通道对齐：`{ user, token, refreshToken, expiresIn }`
    return ok({ user: toClientUser(updated), ...issueTokens(app, 'client', updated.id) })
  })

  /** ⑤ 邮箱 + 密码 + 图形码登录 */
  app.post('/login', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    verifyCaptcha(body.captchaId, body.captchaAnswer)

    const email = normalizeEmail(body.email)
    const customer = await prisma.customer.findUnique({ where: { email } })

    // ⚠️ 「邮箱不存在」「没走完注册」「密码不对」给同一句 —— 别让人拿登录页探邮箱
    const bad = biz('邮箱或密码不对')
    if (!customer || !customer.profileReady || !customer.passwordHash) throw bad
    if (!(await verifyPassword(String(body.password ?? ''), customer.passwordHash))) throw bad

    assertNotBanned(customer)

    const fresh = await prisma.customer.update({
      where: { id: customer.id },
      data: { lastLoginAt: new Date() }
    })

    return ok({ user: toClientUser(fresh), ...issueTokens(app, 'client', fresh.id) })
  })

  /** ⑥ 凭证码登录 —— 换机器 / 重装之后用 */
  app.post('/voucher-login', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const voucher = normalizeVoucher(body.voucher)

    const customer = await prisma.customer.findUnique({ where: { voucher } })
    if (!customer) throw biz('凭证码不对，检查一下有没有抄漏')

    assertNotBanned(customer)

    const fresh = await prisma.customer.update({
      where: { id: customer.id },
      data: { lastLoginAt: new Date() }
    })

    return ok({ user: toClientUser(fresh), ...issueTokens(app, 'client', fresh.id) })
  })

  /** ⑦ 刷新 token */
  app.post('/refresh', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const who = readRefreshToken(app, body.refreshToken, 'client')
    if (!who) {
      return reply.code(401).send({ code: ApiCode.TOKEN_EXPIRED, message: '登录已过期，请重新登录', data: null })
    }

    const customer = await prisma.customer.findUnique({ where: { id: who.sub } })
    if (!customer) {
      return reply.code(401).send({ code: ApiCode.TOKEN_EXPIRED, message: '账号已不存在', data: null })
    }
    assertNotBanned(customer)

    const { token, expiresIn } = issueTokens(app, 'client', customer.id)
    return ok({ token, expiresIn })
  })
}

/* ------------------------------------------------------------------ */
/* 要登录才行的                                                        */
/* ------------------------------------------------------------------ */

export const clientAuthProtectedRoutes: FastifyPluginAsync = async (app) => {
  /** ⑧ 会话 —— 客户端首屏靠它判断「登没登录」 */
  app.get('/me', async (request) => {
    const customer = await prisma.customer.findUnique({ where: { id: currentCustomerId(request) } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '账号不存在')
    return ok({ user: toClientUser(customer) })
  })

  /** ⑨ 登出。JWT 无状态，服务端没什么可清的 —— 客户端丢掉 token 即可 */
  app.post('/logout', async () => ok({ user: null }))

  /** ⑩ 取凭证 —— 客户端拿这些字段去画那张 PNG 卡 */
  app.get('/voucher', async (request) => {
    let customer = await prisma.customer.findUnique({ where: { id: currentCustomerId(request) } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '账号不存在')

    if (!customer.voucher) {
      for (let attempt = 0; attempt < 5 && !customer.voucher; attempt += 1) {
        const candidate = makeVoucher()
        const clash = await prisma.customer.findUnique({ where: { voucher: candidate }, select: { id: true } })
        if (clash) continue
        customer = await prisma.customer.update({ where: { id: customer.id }, data: { voucher: candidate } })
      }
      if (!customer.voucher) return fail(ApiCode.SERVER_ERROR, '凭证码生成失败，稍后再试')
    }

    return ok({
      code: customer.voucher,
      username: customer.nickname,
      email: customer.email,
      avatar: customer.avatar ?? '',
      createdAt: customer.createdAt.toISOString(),
      version: 1
    })
  })

  /** ⑪ 改资料（用户名 / 头像）。邮箱和密码各有自己的接口 */
  app.patch('/profile', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    const data: { nickname?: string; avatar?: string | null } = {}
    if (body.username !== undefined) data.nickname = normalizeUsername(body.username)
    if (body.avatar !== undefined) data.avatar = normalizeAvatar(body.avatar) || null

    if (Object.keys(data).length === 0) {
      const same = await prisma.customer.findUnique({ where: { id: currentCustomerId(request) } })
      return ok({ user: toClientUser(same!) })
    }

    const updated = await prisma.customer.update({ where: { id: currentCustomerId(request) }, data })
    return ok({ user: toClientUser(updated) })
  })

  /**
   * ⑫ 改密码 —— 要当前密码（防「人走了没锁屏，回来密码被换了」）。
   * 改完不踢会话：自己改的密码，没必要让自己重新登一遍。
   */
  app.post('/password', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const customer = await prisma.customer.findUnique({ where: { id: currentCustomerId(request) } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '账号不存在')

    const current = String(body.currentPassword ?? '')
    if (!customer.passwordHash || !(await verifyPassword(current, customer.passwordHash))) {
      throw biz('当前密码不对')
    }

    const updated = await prisma.customer.update({
      where: { id: customer.id },
      data: { passwordHash: await hashPassword(normalizePassword(body.password)) }
    })
    return ok({ user: toClientUser(updated) })
  })

  /**
   * ⑬ 改邮箱 —— 必须拿着**新邮箱**收到的验证码。
   * ⚠️ 真后端在这一步也该给旧邮箱发一封「邮箱已更换」的通知，不然号被盗了人都不知道。
   *    （现在是 TODO，SMTP 通了之后再补）
   */
  app.post('/email', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const email = normalizeEmail(body.email)

    const customer = await prisma.customer.findUnique({ where: { id: currentCustomerId(request) } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '账号不存在')
    if (customer.email === email) throw biz('这就是你现在用的邮箱')

    const taken = await prisma.customer.findUnique({ where: { email } })
    if (taken) throw biz('这个邮箱已经被别的账号用了')

    await consumeEmailCode(email, textOf(body.code))

    const updated = await prisma.customer.update({ where: { id: customer.id }, data: { email } })
    return ok({ user: toClientUser(updated) })
  })
}

/**
 * 校验注册第二步的临时令牌，返回客户 id。
 * 不合格时已经往 reply 里发了 401，调用方直接 return。
 */
async function readPendingToken(request: FastifyRequest, reply: FastifyReply): Promise<number | null> {
  try {
    await request.jwtVerify()
  } catch {
    reply.code(401).send({ code: ApiCode.TOKEN_EXPIRED, message: '注册信息过期了，重新来一遍', data: null })
    return null
  }

  if (request.user.kind !== 'client' || !request.user.pending) {
    reply.code(401).send({ code: ApiCode.UNAUTHORIZED, message: '这不是注册凭证', data: null })
    return null
  }

  return request.user.sub
}
