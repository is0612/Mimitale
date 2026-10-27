import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '../../generated/prisma/client.js'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { dictLabel } from '../../lib/dict.js'
import { pushLog, type LogEntry } from '../../lib/log.js'
import { toCard, toCustomer, toLog } from '../../lib/dto.js'
import { currentAdmin } from '../../lib/whoami.js'
import { DAY_MS, dayOf } from '../../lib/time.js'

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
 *   ① 封禁和改额度**值没变就不写日志** —— 重复提交同一个额度不该刷出噪音
 *   ② 业务写库和写日志在同一个事务里，不会出现「额度改了但没记录」
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

    const [card, logs] = await Promise.all([
      prisma.inviteCard.findFirst({ where: { usedByCustomerId: id } }),
      prisma.operationLog.findMany({
        where: { targetType: 'customer', targetId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200
      })
    ])

    return ok({
      ...toCustomer(customer),
      usedCard: card ? toCard(card, customer.email) : null,
      logs: logs.map(toLog)
    })
  })

  /**
   * PATCH /api/admin/customers/:id —— 封禁 / 解封 / 改额度 / 发会员
   *
   * 一次请求可以带多个字段（比如同时改额度又发会员），
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

    /* ---------------- 改额度 ---------------- */
    if (typeof body.quota === 'number' && Number.isFinite(body.quota)) {
      const next = Math.floor(body.quota)
      if (next !== target.quota) {
        data.quota = next
        const show = (n: number): string => (n === -1 ? '不限量' : String(n))
        logs.push({
          ...base,
          action: 'customer.quota',
          detail: `额度 ${show(target.quota)} → ${show(next)}`
        })
      }
    }

    /* ---------------- 发会员 ---------------- */
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

      // 还在有效期就往后接，已过期或非会员从今天起算
      const now = Date.now()
      const from = target.membershipExpireAt ? Math.max(now, target.membershipExpireAt.getTime()) : now
      const expireAt = new Date(from + days * DAY_MS)

      data.membershipLevel = level
      data.membershipExpireAt = expireAt

      logs.push({
        ...base,
        action: 'customer.membership',
        detail: `发会员：${label} +${days} 天（${
          target.membershipLevel === 'none' ? '新开通' : '续费'
        }，到期 ${dayOf(expireAt)}）`
      })
    }

    // 一个字段都没变 —— 回原样，不写库也不写日志
    if (logs.length === 0) return ok(toCustomer(target))

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.customer.update({ where: { id }, data })
      for (const log of logs) {
        await pushLog({ ...log, adminId: admin.id, adminName: admin.nickname, ip: request.ip }, tx)
      }
      return row
    })

    return ok(toCustomer(updated))
  })
}
