import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '../../generated/prisma/client'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { withLog } from '../../lib/log.js'
import { toFeedback } from '../../lib/dto.js'
import { currentAdmin } from '../../lib/whoami.js'
import { dayRange, today } from '../../lib/time.js'

const STATUSES = ['pending', 'read', 'resolved', 'ignored'] as const
const KINDS = ['bug', 'idea', 'other'] as const

type Status = (typeof STATUSES)[number]
type Kind = (typeof KINDS)[number]

/** 备注长度上限。备注是给运营自己看的一句话，不是第二个正文框 */
const NOTE_MAX = 500

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isStatus(v: unknown): v is Status {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
}

function isKind(v: unknown): v is Kind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v)
}

/** 状态的中文，只用于写操作日志和提示语（前端另有一份 labels.ts） */
const STATUS_LABEL: Record<Status, string> = {
  pending: '待处理',
  read: '已查看',
  resolved: '已处理',
  ignored: '已忽略'
}

/**
 * 意见反馈。前缀 /api/admin
 *
 * 这一页是**只读为主**：反馈是用户说出来的原话，运营能做的是
 * 「看一眼 → 标个状态 → 写句给自己看的备注」，不改用户写的内容。
 * ⚠️ 所以这里没有 PUT 正文的接口，也不该加 —— 改了就成伪造用户发言了。
 */
export const adminFeedbackRoutes: FastifyPluginAsync = async (app) => {
  /** 18. GET /feedbacks —— 列表 + 各状态总数 */
  app.get('/feedbacks', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const page = Math.max(1, Number(query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 10))

    const status = textOf(query.status)
    const kind = textOf(query.kind)
    const keyword = textOf(query.keyword)

    const where: Prisma.FeedbackWhereInput = {}
    if (isStatus(status)) where.status = status
    if (isKind(kind)) where.kind = kind

    if (keyword) {
      where.OR = [
        { content: { contains: keyword, mode: 'insensitive' } },
        { contactEmail: { contains: keyword, mode: 'insensitive' } },
        { contactName: { contains: keyword, mode: 'insensitive' } }
      ]
    }

    // 今天的反馈数按北京时间切 —— 和概览页「今日注册」一套口径，
    // 否则会出现「概览说今天 2 个、反馈页说今天 0 个」这种自己打自己脸的情况
    const { start, end } = dayRange(today())

    const [total, rows, grouped, todayCount] = await Promise.all([
      prisma.feedback.count({ where }),
      prisma.feedback.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      // 状态计数是**全表**口径：不跟当前筛选走，否则「待处理 3」会随筛选跳动
      prisma.feedback.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.feedback.count({ where: { createdAt: { gte: start, lt: end } } })
    ])

    const counts = {
      total: 0,
      pending: 0,
      read: 0,
      resolved: 0,
      ignored: 0,
      today: todayCount
    }
    for (const g of grouped) {
      const n = g._count._all
      counts.total += n
      if (isStatus(g.status)) counts[g.status] = n
    }

    return ok({ total, list: rows.map(toFeedback), counts })
  })

  /** 19. PATCH /feedbacks/:id —— 改状态 / 写内部备注 */
  app.patch('/feedbacks/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '反馈 id 不对')

    const row = await prisma.feedback.findUnique({ where: { id } })
    if (!row) return fail(ApiCode.NOT_FOUND, '这条反馈不存在')

    const body = (request.body ?? {}) as Record<string, unknown>

    const data: Prisma.FeedbackUpdateInput = {}
    const changes: string[] = []

    // 状态：只在真的变了的时候算一次改动，重复点「已处理」不该刷日志
    if (body.status !== undefined) {
      if (!isStatus(body.status)) return fail(ApiCode.INVALID_PARAM, '状态只能是 pending / read / resolved / ignored')
      if (body.status !== row.status) {
        changes.push(`状态：${STATUS_LABEL[row.status as Status] ?? row.status} → ${STATUS_LABEL[body.status]}`)
        data.status = body.status
      }
    }

    if (body.note !== undefined) {
      const note = textOf(body.note)
      if (note.length > NOTE_MAX) return fail(ApiCode.INVALID_PARAM, `备注最多 ${NOTE_MAX} 字`)
      if (note !== row.note) {
        data.note = note
        // 备注内容不进日志（可能写了对某个用户的主观判断，日志是半公开的）
        changes.push(row.note ? '改了备注' : '加了备注')
      }
    }

    if (changes.length === 0) return fail(ApiCode.INVALID_PARAM, '没有要改的内容')

    const admin = await currentAdmin(request)

    const updated = await withLog(
      {
        adminId: admin.id,
        adminName: admin.nickname,
        action: 'feedback.update',
        targetType: 'feedback',
        targetId: row.id,
        // 目标名用「类型 + 前 12 字」——日志列表里得认得出是哪条，又没有标题字段
        targetName: `#${row.id} ${row.content.slice(0, 12)}`,
        detail: changes.join('；'),
        ip: request.ip
      },
      async (tx) => {
        return tx.feedback.update({
          where: { id: row.id },
          data: {
            ...data,
            // 只要动过就算「有人处理过」，标一下是谁、什么时候
            handledBy: admin.nickname,
            handledAt: new Date()
          }
        })
      }
    )

    return ok(toFeedback(updated))
  })
}
