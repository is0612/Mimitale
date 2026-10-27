import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '../../generated/prisma/client.js'
import { prisma } from '../../prisma.js'
import { ok } from '../../lib/reply.js'
import { toLog } from '../../lib/dto.js'
import { dayRange } from '../../lib/time.js'

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 操作日志 —— **只有查，没有写**。
 *
 * ⛔ 别加 POST /logs。日志只由后端在业务 handler 里顺手写，
 *    一旦开了写接口，日志就从「证据」变成「前端愿意上报的部分」。
 */
export const adminLogRoutes: FastifyPluginAsync = async (app) => {
  app.get('/logs', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const page = Math.max(1, Number(query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 10))

    const action = textOf(query.action)
    const keyword = textOf(query.keyword)
    const from = textOf(query.from)
    const to = textOf(query.to)

    const where: Prisma.OperationLogWhereInput = {}

    if (action) where.action = action

    if (keyword) {
      where.OR = [
        { targetName: { contains: keyword, mode: 'insensitive' } },
        { detail: { contains: keyword, mode: 'insensitive' } },
        { adminName: { contains: keyword, mode: 'insensitive' } }
      ]
    }

    // 前端传的是 'YYYY-MM-DD'，按北京时间整天算
    if (from || to) {
      const range: Prisma.DateTimeFilter = {}
      if (from) range.gte = dayRange(from).start
      if (to) range.lt = dayRange(to).end
      where.createdAt = range
    }

    const [total, rows] = await Promise.all([
      prisma.operationLog.count({ where }),
      prisma.operationLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      })
    ])

    return ok({ total, list: rows.map(toLog) })
  })
}
