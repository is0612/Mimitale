import type { FastifyPluginAsync } from 'fastify'
import type { InviteCard, Prisma } from '../../generated/prisma/client'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { pushLog } from '../../lib/log.js'
import { toCard } from '../../lib/dto.js'
import { currentAdmin } from '../../lib/whoami.js'
import { newInviteCode } from '../../lib/cardCode.js'
import { DAY_MS } from '../../lib/time.js'

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 卡密。前缀 /api/admin
 *
 * 卡密现在还没接收费，是「发号」用的：生成 → 发给人 → 注册时填 → 绑上客户。
 */
export const adminCardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/cards', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const page = Math.max(1, Number(query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 10))

    const keyword = textOf(query.keyword)
    const status = textOf(query.status)

    const where: Prisma.InviteCardWhereInput = {}
    if (status === 'unused' || status === 'used' || status === 'void') where.status = status

    if (keyword) {
      // 按邮箱搜要先找到客户 —— 卡密表里只存 id
      const owners = await prisma.customer.findMany({
        where: { email: { contains: keyword, mode: 'insensitive' } },
        select: { id: true }
      })
      where.OR = [
        { code: { contains: keyword, mode: 'insensitive' } },
        { note: { contains: keyword, mode: 'insensitive' } },
        { usedByCustomerId: { in: owners.map((o) => o.id) } }
      ]
    }

    const [total, rows] = await Promise.all([
      prisma.inviteCard.count({ where }),
      prisma.inviteCard.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      })
    ])

    // 一次性把用卡人的邮箱查出来，别在循环里 N+1
    const ownerIds = rows.map((r) => r.usedByCustomerId).filter((v): v is number => v !== null)
    const owners =
      ownerIds.length > 0
        ? await prisma.customer.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, email: true }
          })
        : []
    const emailById = new Map(owners.map((o) => [o.id, o.email]))

    return ok({
      total,
      list: rows.map((r) => toCard(r, (r.usedByCustomerId && emailById.get(r.usedByCustomerId)) || null))
    })
  })

  /**
   * POST /api/admin/cards —— 批量生成（一次最多 100 张）
   */
  app.post('/cards', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    const count = Math.floor(Number(body.count))
    if (!Number.isFinite(count) || count < 1) return fail(ApiCode.INVALID_PARAM, '生成数量至少 1 张')
    if (count > 100) return fail(ApiCode.INVALID_PARAM, '一次最多生成 100 张')

    const admin = await currentAdmin(request)
    const note = textOf(body.note) || '未分类'

    // 卡密从 2026-10-28 起本身就是商品：兑换给几天会员、哪一档，都写在卡上。
    // 老数据（migration 前）默认 30 天 / basic，和当时「注册送 30 天」的实际效果一致
    const days = body.days === undefined || body.days === null ? 30 : Math.floor(Number(body.days))
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return fail(ApiCode.INVALID_PARAM, '会员天数要在 1 ~ 3650 之间')
    }

    // 会员等级：2026-10-28 起产品上只有「会员」一档（星宝：「会员等级好像用不上，
    // 直接订阅会员就好了」），所以不再让运营选。库里那一列保留、默认 basic，
    // 是为了不为了这件事跑一次删列迁移；将来真要分档再说。

    const expireDays =
      body.expireDays === null || body.expireDays === undefined ? null : Math.floor(Number(body.expireDays))
    if (expireDays !== null && (!Number.isFinite(expireDays) || expireDays <= 0)) {
      return fail(ApiCode.INVALID_PARAM, '有效天数要是正整数，或留空表示永久有效')
    }

    const now = Date.now()
    const expireAt = expireDays === null ? null : new Date(now + expireDays * DAY_MS)

    // 逐个 create，撞了唯一约束就换一个码重试 ——
    // 比「先查全部已有码」省一次全表扫描，也不会有竞态
    const created = await prisma.$transaction(async (tx) => {
      const rows: InviteCard[] = []
      for (let i = 0; i < count; i++) {
        let row: InviteCard | null = null
        for (let attempt = 0; attempt < 5 && !row; attempt++) {
          try {
            row = await tx.inviteCard.create({
              data: { code: newInviteCode(), note, days, status: 'unused', expireAt }
            })
          } catch (err) {
            // P2002 = 唯一约束冲突，换一个码再来
            if ((err as { code?: string }).code !== 'P2002') throw err
          }
        }
        if (!row) throw new Error('卡密生成失败：连续 5 次都撞码')
        rows.push(row)
      }

      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'card.create',
          targetType: 'card',
          targetId: rows[0]?.id ?? null,
          targetName: rows.length === 1 ? rows[0]!.code : `${rows.length} 张`,
          detail: `生成 ${rows.length} 张卡密（${note}）：会员 ${days} 天${expireDays ? `，${expireDays} 天后过期` : '，永久有效'}`,
          ip: request.ip
        },
        tx
      )

      return rows
    })

    return ok({ created: created.map((r) => toCard(r, null)) })
  })

  /** PATCH /api/admin/cards/:id —— 目前只用于作废 */
  app.patch('/cards/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '卡密 id 不对')

    const card = await prisma.inviteCard.findUnique({ where: { id } })
    if (!card) return fail(ApiCode.NOT_FOUND, '卡密不存在')

    const body = (request.body ?? {}) as Record<string, unknown>
    if (textOf(body.status) !== 'void') return fail(ApiCode.INVALID_PARAM, '目前只能改成作废')
    if (card.status === 'used') return fail(ApiCode.INVALID_PARAM, '已被使用的卡密不能作废')
    if (card.status === 'void') return fail(ApiCode.INVALID_PARAM, '这张卡密已经是作废状态')

    const admin = await currentAdmin(request)

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.inviteCard.update({ where: { id }, data: { status: 'void' } })
      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'card.void',
          targetType: 'card',
          targetId: card.id,
          targetName: card.code,
          detail: '手动作废',
          ip: request.ip
        },
        tx
      )
      return row
    })

    const owner = updated.usedByCustomerId
      ? await prisma.customer.findUnique({ where: { id: updated.usedByCustomerId }, select: { email: true } })
      : null

    return ok(toCard(updated, owner?.email ?? null))
  })
}
