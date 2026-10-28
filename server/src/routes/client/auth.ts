import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { ClientUser } from '@contract'
import type { Customer } from '../../generated/prisma/client'
import { prisma } from '../../prisma.js'
import { env } from '../../env.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { biz } from '../../lib/bizError.js'
import { hashPassword, verifyPassword } from '../../lib/password.js'
import { issueTokens, issuePendingToken, readRefreshToken } from '../../lib/auth.js'
import { createCaptcha, verifyCaptcha } from '../../lib/captcha.js'
import { makeVoucher, normalizeVoucher } from '../../lib/voucher.js'
import { newInviteCode } from '../../lib/cardCode.js'
import { sendLoginCode } from '../../lib/mail.js'
import { currentCustomerId } from '../../lib/whoami.js'
import { DAY_MS } from '../../lib/time.js'
import { dictLabel } from '../../lib/dict.js'
import { entitlementOf, grantDaysIn } from '../../lib/membership.js'
import { openSession, touchSession, closeSession } from '../../lib/session.js'
import {
  TRIAL_DAYS,
  normalizeEmail,
  normalizeUsername,
  normalizePassword,
  normalizeAvatar
} from '../../lib/customerRules.js'
import { makeUniqueVoucher, makeUniqueReferralCode } from '../../lib/customerCodes.js'
import { toClientUser, INVITE_BONUS_DAYS } from '../../lib/clientUser.js'

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

// 邮箱 / 用户名 / 密码 / 头像的校验和 TRIAL_DAYS 都搬到了 lib/customerRules.ts ——
// 后台「新增客户」也要用同一套规则（那是等价于注册的），两份校验迟早会跑偏。

/** 验证码：10 分钟有效，60 秒内不许重发，最多试 5 次 */
const CODE_TTL = 600
const CODE_COOLDOWN_MS = 60_000
const CODE_DAILY_LIMIT = 30
const CODE_MAX_TRIES = 5

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 注册时填的邀请码 —— 大小写、空格、少写连字符都容忍（跟凭证码一个脾气）。
 * 空 = 没填，返回 ''。**只做形状校验，码存不存在由 resolveInvite 查库**。
 */
function normalizeInviteInput(value: unknown): string {
  let raw = textOf(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (!raw) return ''
  // 只写 8 位也认（7K2M9QXA），前面那段 MIMI- 可有可无
  if (raw.length === 12 && raw.startsWith('MIMI')) raw = raw.slice(4)
  if (raw.length !== 8) throw biz('邀请码是 MIMI-XXXX-XXXX 这个样子，检查一下')
  return `MIMI-${raw.slice(0, 4)}-${raw.slice(4)}`
}

/**
 * 这个码是哪种来源。
 *
 * 先查卡密（后台发的，一码一次），查不到再查客户自己的邀请码（一码能邀多人）。
 * 两者形状一样，所以顺序不能反 —— 卡密是花钱买的/活动发的，优先消耗它。
 */
type Invite =
  | { kind: 'none' }
  | { kind: 'card'; code: string; cardId: number; days: number; level: string }
  | { kind: 'customer'; code: string; inviterId: number }

async function resolveInvite(code: string, selfId: number): Promise<Invite> {
  if (!code) return { kind: 'none' }

  const card = await prisma.inviteCard.findUnique({ where: { code } })
  if (card) {
    if (card.status === 'void') throw biz('这张卡已经作废了')
    if (card.status === 'used') throw biz('这张卡已经被用过了')
    if (card.expireAt && card.expireAt.getTime() <= Date.now()) throw biz('这张卡过期了')
    return { kind: 'card', code, cardId: card.id, days: card.days, level: card.level }
  }

  const inviter = await prisma.customer.findUnique({ where: { referralCode: code }, select: { id: true } })
  if (inviter) {
    // 自己填自己没意义（注册时还不可能，是防以后「改绑」写错）
    if (inviter.id === selfId) throw biz('不能填自己的邀请码')
    return { kind: 'customer', code, inviterId: inviter.id }
  }

  throw biz('邀请码不对，检查一下有没有抄错')
}

/**
 * 保证这个人有自己的邀请码 —— 老数据没有，第一次取账号信息时补一个。
 *
 * 和 `/voucher` 的懒生成同一套路：迁移里不写随机码（SQL 拼 8 位随机太重），
 * 放到这里撞一次唯一索引就换一个。
 */
async function ensureReferralCode(c: Customer): Promise<Customer> {
  if (c.referralCode) return c

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = newInviteCode()
    const clash = await prisma.customer.findFirst({
      where: { OR: [{ referralCode: candidate }, { voucher: candidate }] },
      select: { id: true }
    })
    if (clash) continue
    // 卡密表也要避开：注册时先查卡密、再查邀请码，同码共存会分不清是谁的
    const card = await prisma.inviteCard.findUnique({ where: { code: candidate }, select: { id: true } })
    if (card) continue
    return prisma.customer.update({ where: { id: c.id }, data: { referralCode: candidate } })
  }

  // 31^8 的空间里连撞 5 次基本等于库坏了，这次先不补，别把整个 /me 弄挂
  return c
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
 * 记一条登录记录 —— 后台「登录记录」和 IP 统计都靠它。
 *
 * ⚠️ 只记成功的那次。失败的密码尝试不记：量会大十倍，而这块要看的是
 *    「人从哪来、什么时候来」，不是撞库审计（那要另配限流计数）。
 * ⚠️ 记日志失败**不能让登录失败** —— 表没了也得让人进得来，只 warn。
 * ⚠️ 上了 nginx 记得给 Fastify 开 trustProxy，否则这里全是 127.0.0.1。
 */
async function recordLogin(
  request: FastifyRequest,
  customerId: number,
  method: 'password' | 'voucher' | 'register'
): Promise<void> {
  await writeActivity(request, customerId, method)
}

/** 写一条活动记录。失败只 warn —— 记日志不能把登录拦掉 */
async function writeActivity(
  request: FastifyRequest,
  customerId: number,
  method: 'password' | 'voucher' | 'register'
): Promise<void> {
  try {
    await prisma.loginLog.create({
      data: {
        customerId,
        method,
        ip: request.ip || '',
        // UA 里带着 Electron/客户端版本号，排查「旧版本还在用」时是唯一线索
        userAgent: String(request.headers['user-agent'] ?? '').slice(0, 200)
      }
    })
  } catch (err) {
    request.log.warn({ err }, '写活动记录失败（登录照常）')
  }
}

/** 画那张凭证卡要的字段 —— 取凭证和刷新凭证共用同一个形状 */
function voucherPayload(c: Customer) {
  return {
    code: c.voucher ?? '',
    username: c.nickname,
    email: c.email,
    avatar: c.avatar ?? '',
    createdAt: c.createdAt.toISOString(),
    version: 1
  }
}

/** 造一张没被占用的凭证码；连撞 5 次就放弃（返回空串） */
async function makeFreeVoucher(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = makeVoucher()
    const clash = await prisma.customer.findUnique({ where: { voucher: candidate }, select: { id: true } })
    if (!clash) return candidate
  }
  return ''
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
   * ④ 注册第二步：用户名 + 密码 + 头像（+ 邀请码，选填）→ 账号正式可用
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
    const inviteCode = normalizeInviteInput(body.inviteCode)

    const customer = await prisma.customer.findUnique({ where: { id: customerId } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '注册信息过期了，重新来一遍')
    if (customer.profileReady) throw biz('这个账号已经设置过了')

    assertNotBanned(customer)

    const invite = await resolveInvite(inviteCode, customer.id)

    const now = new Date()

    const updated = await prisma.$transaction(async (tx) => {
      // 凭证码要唯一：撞了就换一个再来（31^24 的空间，实际几乎不会撞）
      const voucher = await makeUniqueVoucher(tx)

      // 自己的邀请码也在这里发 —— 别等第一次进「个人信息」才补，那样刚注册的人
      // 找不到码可以发出去
      const referralCode = await makeUniqueReferralCode(tx)

      // 卡密是花钱买的，必须真的消耗掉；条件更新挡住两个人同时用同一张卡
      if (invite.kind === 'card') {
        const used = await tx.inviteCard.updateMany({
          where: { id: invite.cardId, status: 'unused' },
          data: { status: 'used', usedByCustomerId: customer.id, usedAt: now }
        })
        if (used.count === 0) throw biz('这张卡刚被别人用掉了，换一张')
      }

      const registered = await tx.customer.update({
        where: { id: customer.id },
        data: {
          nickname: username,
          avatar: avatar || null,
          passwordHash: await hashPassword(password),
          voucher,
          referralCode,
          profileReady: true,
          lastLoginAt: now,
          // 没填码就别写 null 占位，两类来源靠「有没有 inviteCode」区分
          ...(invite.kind === 'none' ? {} : { inviteCode: invite.code }),
          ...(invite.kind === 'customer' ? { referredById: invite.inviterId } : {})
        }
      })

      // 注册送的 30 天是**免费天数**，不是会员（等级留在 none）。
      // 只有走完第二步的号才算「真的注册了」，后台的「今日注册」也跟着只算这些人
      //
      // ⚠️ 2026-10-28 起卡密本身就是商品：填了卡就按**卡上写的**等级和天数开会员，
      //    不再另送 30 天免费 —— 试用是给还没买的人的，买了还白送等于自己给自己打折。
      //    没填卡、或填的是别人的邀请码，照旧送试用。
      const result =
        invite.kind === 'card'
          ? await grantDaysIn(tx, {
              customerId: registered.id,
              days: invite.days,
              source: 'card',
              wallet: 'member',
              level: invite.level,
              refId: invite.cardId,
              note: `卡密兑换 ${invite.code}（注册时）`
            })
          : await grantDaysIn(tx, {
              customerId: registered.id,
              days: TRIAL_DAYS,
              source: 'trial',
              wallet: 'free',
              note: `注册赠送 ${TRIAL_DAYS} 天免费`
            })

      // 受邀注册时给邀请人加天数。
      // ⚠️ 别用它的返回值 —— 那返回的是**邀请人**那一行，拿它当注册结果会把
      //    新注册的人替换成邀请人（token 也会发给邀请人）。只发天数，结果丢掉。
      if (invite.kind === 'customer') {
        await grantDaysIn(tx, {
          customerId: invite.inviterId,
          days: INVITE_BONUS_DAYS,
          source: 'invite',
          wallet: 'free',
          refId: registered.id,
          note: `邀请了 ${registered.nickname} +${INVITE_BONUS_DAYS} 天`
        })
      }

      return result.customer
    })

    // 形状跟客户端那 12 个通道对齐：`{ user, token, refreshToken, expiresIn }`
    // 注册完就是一次登录 —— 记成 register，后台看得出「这个人是刚注册的」
    await recordLogin(request, updated.id, 'register')
    return ok({ user: await toClientUser(updated), ...issueTokens(app, 'client', updated.id) })
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

    await recordLogin(request, fresh.id, 'password')
    return ok({ user: await toClientUser(fresh), ...issueTokens(app, 'client', fresh.id) })
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

    await recordLogin(request, fresh.id, 'voucher')
    return ok({ user: await toClientUser(fresh), ...issueTokens(app, 'client', fresh.id) })
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
    let customer = await prisma.customer.findUnique({ where: { id: currentCustomerId(request) } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '账号不存在')
    // 老数据没有自己的邀请码 —— 顺手补一个，别让「个人信息」那块空着
    customer = await ensureReferralCode(customer)
    return ok({ user: await toClientUser(customer) })
  })

  /**
   * ⑧ 客户端启动 —— 开一次新使用会话，返回 sessionId（心跳 / 退出要用）。
   *
   * ⚠️ 客户端**只在主进程启动时**调这一个接口，别挂在 /me 上：
   *    设置页点「刷新」也走 /me，那样一天会记十几次。
   * 老版本客户端不会调它 —— 所以「今日活跃」仍然以登录为准，
   * 会话数据只用来回答「开了多久、什么版本、怎么结束的」。
   */
  app.post('/launch', async (request) => {
    const customerId = currentCustomerId(request)
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { status: true }
    })
    if (!customer) return fail(ApiCode.NOT_FOUND, '账号不存在')

    // 封禁的号也开会话 —— 后台正想知道「封了他还在不在开」
    const sessionId = await openSession(request, customerId)
    return ok({ sessionId })
  })

  /** ⑧b 心跳。5 分钟一次，只更新 last_seen_at；服务端内存合并，不是每次都写库 */
  app.post('/launch/ping', async (request) => {
    const customerId = currentCustomerId(request)
    const sessionId = Number((request.body as { sessionId?: number })?.sessionId)
    if (!Number.isInteger(sessionId) || sessionId <= 0) return fail(ApiCode.INVALID_PARAM, '缺少 sessionId')

    touchSession(request, customerId, sessionId)
    return ok({ ok: true })
  })

  /** ⑧c 退出。结清会话；客户端不 await，这里也容忍写失败 */
  app.post('/launch/exit', async (request) => {
    const customerId = currentCustomerId(request)
    const body = (request.body ?? {}) as { sessionId?: number; reason?: string; detail?: string }
    const sessionId = Number(body.sessionId)
    if (!Number.isInteger(sessionId) || sessionId <= 0) return fail(ApiCode.INVALID_PARAM, '缺少 sessionId')

    const reason = body.reason === 'crash' ? 'crash' : 'quit'
    await closeSession(request, customerId, sessionId, reason, body.detail ?? '')
    return ok({ ok: true })
  })

  /** ⑨ 登出。JWT 无状态，服务端没什么可清的 —— 客户端丢掉 token 即可 */
  app.post('/logout', async () => ok({ user: null }))

  /** ⑩ 取凭证 —— 客户端拿这些字段去画那张 PNG 卡 */
  app.get('/voucher', async (request) => {
    let customer = await prisma.customer.findUnique({ where: { id: currentCustomerId(request) } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '账号不存在')

    if (!customer.voucher) {
      const code = await makeFreeVoucher()
      if (!code) return fail(ApiCode.SERVER_ERROR, '凭证码生成失败，稍后再试')
      customer = await prisma.customer.update({ where: { id: customer.id }, data: { voucher: code } })
    }

    return ok(voucherPayload(customer))
  })

  /**
   * 换一张新的凭证码。
   *
   * ⚠️ 旧的**立刻失效**：凭证码是「换机器 / 重装后登回来」的唯一凭据，
   *    两张同时有效等于留了一把旧钥匙。客户端那边必须先让用户确认再调。
   */
  app.post('/voucher/refresh', async (request) => {
    const me = await prisma.customer.findUnique({
      where: { id: currentCustomerId(request) },
      select: { id: true }
    })
    if (!me) return fail(ApiCode.NOT_FOUND, '账号不存在')

    const code = await makeFreeVoucher()
    if (!code) return fail(ApiCode.SERVER_ERROR, '凭证码生成失败，稍后再试')

    const updated = await prisma.customer.update({ where: { id: me.id }, data: { voucher: code } })
    return ok(voucherPayload(updated))
  })

  /** ⑪ 改资料（用户名 / 头像）。邮箱和密码各有自己的接口 */
  app.patch('/profile', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    const data: { nickname?: string; avatar?: string | null } = {}
    if (body.username !== undefined) data.nickname = normalizeUsername(body.username)
    if (body.avatar !== undefined) data.avatar = normalizeAvatar(body.avatar) || null

    if (Object.keys(data).length === 0) {
      const same = await prisma.customer.findUnique({ where: { id: currentCustomerId(request) } })
      return ok({ user: await toClientUser(same!) })
    }

    const updated = await prisma.customer.update({ where: { id: currentCustomerId(request) }, data })
    return ok({ user: await toClientUser(updated) })
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
    return ok({ user: await toClientUser(updated) })
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
    return ok({ user: await toClientUser(updated) })
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
