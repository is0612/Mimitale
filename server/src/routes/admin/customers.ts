import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '../../generated/prisma/client'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { dictLabel } from '../../lib/dict.js'
import { pushLog, type LogEntry } from '../../lib/log.js'
import { toCard, toCustomer, toLog } from '../../lib/dto.js'
import { currentAdmin } from '../../lib/whoami.js'
import { dayOf } from '../../lib/time.js'
import { grantDaysIn, MEMBER_NAME } from '../../lib/membership.js'
import { hashPassword } from '../../lib/password.js'
import {
  TRIAL_DAYS,
  normalizeEmail,
  normalizeUsername,
  normalizePassword,
  normalizeAvatar
} from '../../lib/customerRules.js'
import { makeUniqueVoucher, makeUniqueReferralCode } from '../../lib/customerCodes.js'

/** 和 mock 保持一致的翻页收口：pageSize 最大 100，最小 1 */
function paging(query: Record<string, unknown>): { page: number; pageSize: number; skip: number; take: number } {
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 10))
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 客户管理。前缀 /api/admin
 *
 * 三条从 mock 抄过来的规矩：
 *   ① 封禁**值没变就不写日志** —— 重复提交同一个状态不该刷出噪音
 *   ② 业务写库和写日志在同一个事务里，不会出现「会员发了但没记录」
 *   ③ 发会员从 max(现在, 原到期日) 顺延，不是从今天重新算
 */
export const adminCustomerRoutes: FastifyPluginAsync = async (app) => {
  /** GET /api/admin/customers —— 分页 + 关键词 + 状态 */
  app.get('/customers', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const { page, pageSize, skip, take } = paging(query)

    const keyword = textOf(query.keyword)
    const status = textOf(query.status)
    const where: Prisma.CustomerWhereInput = {}

    if (status === 'active' || status === 'banned') where.status = status

    if (keyword) {
      // 邀请码也一起搜 —— 后台常要查「这个码被谁用了」
      where.OR = [
        { email: { contains: keyword, mode: 'insensitive' } },
        { nickname: { contains: keyword, mode: 'insensitive' } },
        { inviteCode: { contains: keyword, mode: 'insensitive' } }
      ]
    }

    const [total, rows] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take
      })
    ])

    return ok({ total, list: rows.map(toCustomer) })
  })

  /** GET /api/admin/customers/:id —— 客户 + 他用的卡 + 他身上的操作记录 */
  app.get('/customers/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '客户 id 不对')

    const customer = await prisma.customer.findUnique({ where: { id } })
    if (!customer) return fail(ApiCode.NOT_FOUND, '客户不存在')

    const [card, logs, invitedCount, referrer, loginLogs, grants, sessions] = await Promise.all([
      prisma.inviteCard.findFirst({ where: { usedByCustomerId: id } }),
      prisma.operationLog.findMany({
        where: { targetType: 'customer', targetId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200
      }),
      // 「他邀请了几个人」和「谁邀请的他」都要现查 —— 都是逻辑字段，没有关系表
      prisma.customer.count({ where: { referredById: id } }),
      customer.referredById
        ? prisma.customer.findUnique({
            where: { id: customer.referredById },
            select: { id: true, nickname: true, email: true }
          })
        : null,
      // 最近 30 次登录就够看「从哪来、几点来」，一次拉全量只会把详情页拖慢
      prisma.loginLog.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 30
      }),
      // 天数流水：这 60 天里哪 30 天是送的、哪 30 天是发的，全在这里
      prisma.membershipGrant.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100
      }),
      // 使用会话：最近 30 次「打开到关闭」，看时长和版本
      prisma.clientSession.findMany({
        where: { customerId: id },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: 30
      })
    ])

    return ok({
      ...toCustomer(customer),
      usedCard: card ? toCard(card, customer.email) : null,
      logs: logs.map(toLog),
      invitedCount,
      referredBy: referrer,
      loginLogs: loginLogs.map((l) => ({
        id: l.id,
        method: l.method,
        ip: l.ip,
        userAgent: l.userAgent,
        createdAt: l.createdAt.toISOString()
      })),
      grants: grants.map((g) => ({
        id: g.id,
        days: g.days,
        source: g.source,
        note: g.note,
        refId: g.refId,
        startsAt: g.startsAt.toISOString(),
        expiresAt: g.expiresAt.toISOString(),
        createdAt: g.createdAt.toISOString()
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
        endedAt: s.endedAt?.toISOString() ?? null,
        endReason: s.endReason,
        endDetail: s.endDetail,
        appVersion: s.appVersion,
        ip: s.ip
      }))
    })
  })

  /**
   * PATCH /api/admin/customers/:id —— 封禁 / 解封 / 发会员
   *
   * 一次请求可以带多个字段（比如封禁的同时发会员），
   * 每个**真正发生变化**的字段各落一条日志。
   */
  app.patch('/customers/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '客户 id 不对')

    const target = await prisma.customer.findUnique({ where: { id } })
    if (!target) return fail(ApiCode.NOT_FOUND, '客户不存在')

    const admin = await currentAdmin(request)
    const body = (request.body ?? {}) as Record<string, unknown>

    const data: Prisma.CustomerUpdateInput = {}
    /** 待写的日志：adminId / adminName / ip 在事务里补齐，其余这里定好 */
    const logs: Array<Omit<LogEntry, 'adminId' | 'adminName' | 'ip'>> = []

    const base = {
      targetType: 'customer',
      targetId: target.id,
      targetName: target.nickname
    }

    /* ---------------- 封禁 / 解封 ---------------- */
    const nextStatus = textOf(body.status)
    if (nextStatus === 'active' || nextStatus === 'banned') {
      if (nextStatus !== target.status) {
        if (nextStatus === 'banned') {
          const reason = textOf(body.banReason)
          data.status = 'banned'
          data.banReason = reason || null
          logs.push({
            ...base,
            action: 'customer.ban',
            detail: reason ? `封禁（${await dictLabel('ban_reason', reason)}）` : '封禁'
          })
        } else {
          data.status = 'active'
          data.banReason = null
          logs.push({
            ...base,
            action: 'customer.unban',
            detail: target.banReason ? `解封（原因为 ${await dictLabel('ban_reason', target.banReason)}）` : '解封'
          })
        }
      }
    }

    /* ---------------- 发会员 ---------------- */
    /** 会员天数不在 data 里改 —— 它要锁行 + 写流水，只能在事务里走 grantDaysIn */
    let grant: { level: string; days: number } | null = null
    if (body.membershipLevel !== undefined) {
      const level = String(body.membershipLevel).trim()
      const label = await dictLabel('membership_level', level)

      // 字典里查不到 → 原值原样返回，据此判断这档不存在（含误传 'none'）
      if (!level || level === 'none' || label === level) {
        return fail(ApiCode.INVALID_PARAM, '这个会员等级不存在')
      }

      const days = Math.floor(Number(body.membershipDays ?? 30))
      if (!Number.isFinite(days) || days <= 0) {
        return fail(ApiCode.INVALID_PARAM, '顺延天数要是正整数')
      }

      grant = { level, days }
    }

    // 一个字段都没变 —— 回原样，不写库也不写日志
    if (logs.length === 0 && !grant) return ok(toCustomer(target))

    const updated = await prisma.$transaction(async (tx) => {
      // 只发会员时 data 是空的，别白跑一次 update
      let row = Object.keys(data).length > 0 ? await tx.customer.update({ where: { id }, data }) : target

      if (grant) {
        // 还在有效期就往后接，已过期或从没发过就从今天起算（grantDaysIn 里算）
        const result = await grantDaysIn(tx, {
          customerId: id,
          days: grant.days,
          source: 'admin',
          wallet: 'member',
          level: grant.level,
          refId: admin.id,
          note: '后台发会员'
        })
        row = result.customer

        await pushLog(
          {
            ...base,
            action: 'customer.membership',
            // 只说天数，不说等级名 —— 产品上只有一档（MEMBER_NAME），
            // 而日志是留着以后对账的，写「初级会员」将来会被当成真有分档
            detail: `发会员：${MEMBER_NAME} +${grant.days} 天（${
              target.membershipLevel === 'none' ? '新开通' : '续费'
            }，到期 ${dayOf(result.grant.expiresAt)}）`,
            adminId: admin.id,
            adminName: admin.nickname,
            ip: request.ip
          },
          tx
        )
      }

      for (const log of logs) {
        await pushLog({ ...log, adminId: admin.id, adminName: admin.nickname, ip: request.ip }, tx)
      }
      return row
    })

    return ok(toCustomer(updated))
  })

  /**
   * POST /api/admin/customers —— 后台代建一个客户
   *
   * **「相当于注册」**（星宝 2026-10-28 定的）：字段、默认值、发的两个码全按注册那套来。
   * 所以它建出来的号和客户端自己注册的**长得一模一样** —— 有凭证码、有邀请码、
   * profileReady = true、送 30 天试用，因此在后台「今日注册」里也算一个。
   *
   * ⚠️ 和真注册唯一的区别：**不发邮件、不验验证码**。人就在旁边，让他去收封信
   *    没意义；密码由运营填，交给本人之后应该在「个人中心」改掉。
   * ⚠️ 不写 login_logs —— 这个人还没登录过。硬写一条 register 会让「登录记录」
   *    和 IP 统计里出现一个不存在的人。
   */
  app.post('/customers', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    // 这几个 normalize 和客户端注册**共用一份**（lib/customerRules.ts）——
    // 两份校验迟早会跑偏成「注册不让过的邮箱，后台能建」
    const email = normalizeEmail(body.email)
    const nickname = normalizeUsername(body.nickname)
    const password = normalizePassword(body.password)
    const avatar = normalizeAvatar(body.avatar)

    const rawDays = body.trialDays === undefined || body.trialDays === null ? TRIAL_DAYS : Number(body.trialDays)
    const trialDays = Math.floor(rawDays)
    if (!Number.isFinite(trialDays) || trialDays < 0 || trialDays > 3650) {
      return fail(ApiCode.INVALID_PARAM, '赠送天数要在 0 ~ 3650 之间')
    }

    const exists = await prisma.customer.findUnique({ where: { email }, select: { id: true } })
    if (exists) return fail(ApiCode.INVALID_PARAM, '这个邮箱已经有账号了')

    const admin = await currentAdmin(request)
    const passwordHash = await hashPassword(password)

    const created = await prisma.$transaction(async (tx) => {
      const voucher = await makeUniqueVoucher(tx)
      const referralCode = await makeUniqueReferralCode(tx)

      let row = await tx.customer.create({
        data: {
          email,
          nickname,
          avatar: avatar || null,
          passwordHash,
          voucher,
          referralCode,
          status: 'active',
          // 建出来就是「资料齐全」的号 —— 后台的「今日注册」只数这种人
          profileReady: true
        }
      })

      if (trialDays > 0) {
        const granted = await grantDaysIn(tx, {
          customerId: row.id,
          days: trialDays,
          source: 'trial',
          wallet: 'free',
          note: `后台代建账号，按注册赠送 ${trialDays} 天`
        })
        row = granted.customer
      }

      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'customer.create',
          targetType: 'customer',
          targetId: row.id,
          targetName: nickname,
          detail: `代建账号 ${email}${trialDays > 0 ? `，送 ${trialDays} 天试用` : '，不送试用'}`,
          ip: request.ip
        },
        tx
      )

      return row
    })

    return ok(toCustomer(created))
  })

  /**
   * DELETE /api/admin/customers/{id} —— 真删，**不可恢复**
   *
   * ⚠️ 本库不建外键，没有 cascade 可用：关联表得一张张手动清。
   *    漏一张就留下指向不存在客户的孤儿行，之后「今日活跃」「会员人数」这些
   *    统计算出来的数字会跟客户列表对不上，而且很难查。
   * ⚠️ 反馈**不删，只断开身份**：那是用户亲口说过的话，删号不该顺手销毁内容；
   *    但联系方式必须一起清掉，否则删号等于没删（人走了还留着邮箱）。
   * ⚠️ 用过的卡密不回收：只把 usedByCustomerId 置空。卡已经花掉了，
   *    不能因为人走了就变回「未使用」再卖一次。
   */
  app.delete('/customers/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '客户 id 不对')

    const target = await prisma.customer.findUnique({ where: { id } })
    if (!target) return fail(ApiCode.NOT_FOUND, '客户不存在')

    const admin = await currentAdmin(request)

    await prisma.$transaction(async (tx) => {
      // ① 他发过的反馈：保留正文，抹掉身份
      const anonymized = await tx.feedback.updateMany({
        where: { customerId: id },
        data: { customerId: null, contactEmail: '', contactName: '' }
      })

      // ② 纯属这个人的运行数据：一起带走，否则统计会飘
      await tx.announcementRead.deleteMany({ where: { customerId: id } })
      await tx.loginLog.deleteMany({ where: { customerId: id } })
      await tx.clientSession.deleteMany({ where: { customerId: id } })
      await tx.membershipGrant.deleteMany({ where: { customerId: id } })

      // ③ 别人的数据里提到他的地方：断开引用，别顺手改别人的
      await tx.customer.updateMany({ where: { referredById: id }, data: { referredById: null } })
      await tx.inviteCard.updateMany({ where: { usedByCustomerId: id }, data: { usedByCustomerId: null } })

      // ④ 本人
      await tx.customer.delete({ where: { id } })

      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'customer.delete',
          targetType: 'customer',
          targetId: id,
          // ⚠️ 这行日志是删除后**唯一**还记得这个人叫什么的记录，别省
          targetName: `${target.nickname}（${target.email}）`,
          detail:
            `删除账号：登录记录 / 会员流水 / 已读记录一并清掉` +
            (anonymized.count > 0 ? `，他的 ${anonymized.count} 条反馈保留但已匿名` : ''),
          ip: request.ip
        },
        tx
      )
    })

    return ok(null)
  })
}
