import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '../../generated/prisma/client'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { pushLog, withLog } from '../../lib/log.js'
import { toAnnouncement } from '../../lib/dto.js'
import { currentAdmin } from '../../lib/whoami.js'
// 「此刻要不要显示」的判断全项目只有一份，后台列表和客户端拉取共用
import { liveWindow } from '../../lib/announcement.js'

const LEVELS = ['normal', 'important', 'maintenance'] as const
type Level = (typeof LEVELS)[number]

const TITLE_MAX = 60
const CONTENT_MAX = 4000

const LEVEL_LABEL: Record<Level, string> = {
  normal: '普通',
  important: '重要',
  maintenance: '维护'
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isLevel(v: unknown): v is Level {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
}

/**
 * 解析请求里的时间字段，三态要分清：
 *   undefined = 前端没传这个字段 → 不改（PATCH 用）
 *   null / ''  = 明确要清空     → 立刻生效 / 永不失效
 *   Date       = 具体时刻
 *
 * ⚠️ 把 undefined 和 null 混成一个值，PATCH 就永远没法表达
 *    「这条公告不要失效时间了」—— 两种语义必须分开。
 */
function parseDateField(value: unknown): { ok: true; value: Date | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null || value === '') return { ok: true, value: null }
  if (typeof value !== 'string' && typeof value !== 'number') return { ok: false }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return { ok: false }
  return { ok: true, value: d }
}

/**
 * 通知公告。前缀 /api/admin
 *
 * 运营写一条 → 客户端启动时拉下来显示在聊天页上方的横条里。
 * 和「意见反馈」方向相反，所以是两张表、两个页面。
 */
export const adminAnnouncementRoutes: FastifyPluginAsync = async (app) => {
  /** 20. GET /announcements —— 列表（含下架的，后台要能看见全部） */
  app.get('/announcements', async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const page = Math.max(1, Number(query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 10))

    const keyword = textOf(query.keyword)
    const enabledParam = textOf(query.enabled)

    const where: Prisma.AnnouncementWhereInput = {}
    if (enabledParam === '1') where.enabled = true
    if (enabledParam === '0') where.enabled = false

    if (keyword) {
      where.OR = [
        { title: { contains: keyword, mode: 'insensitive' } },
        { content: { contains: keyword, mode: 'insensitive' } }
      ]
    }

    const [total, rows, liveCount] = await Promise.all([
      prisma.announcement.count({ where }),
      prisma.announcement.findMany({
        where,
        // 置顶的排前面：「我现在发出去的是什么」比「什么时候发的」更该在第一眼
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.announcement.count({ where: liveWindow() })
    ])

    return ok({ total, list: rows.map(toAnnouncement), liveCount })
  })

  /** 21. POST /announcements —— 发一条新公告 */
  app.post('/announcements', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    const title = textOf(body.title)
    const content = textOf(body.content)
    if (!title) return fail(ApiCode.INVALID_PARAM, '标题不能空')
    if (title.length > TITLE_MAX) return fail(ApiCode.INVALID_PARAM, `标题最多 ${TITLE_MAX} 字`)
    if (!content) return fail(ApiCode.INVALID_PARAM, '正文不能空')
    if (content.length > CONTENT_MAX) return fail(ApiCode.INVALID_PARAM, `正文最多 ${CONTENT_MAX} 字`)

    const level: Level = isLevel(body.level) ? body.level : 'normal'
    if (body.level !== undefined && !isLevel(body.level)) {
      return fail(ApiCode.INVALID_PARAM, '级别只能是 normal / important / maintenance')
    }

    const starts = parseDateField(body.startsAt)
    const ends = parseDateField(body.endsAt)
    if (!starts.ok) return fail(ApiCode.INVALID_PARAM, '生效时间格式不对')
    if (!ends.ok) return fail(ApiCode.INVALID_PARAM, '失效时间格式不对')

    const startsAt = starts.value ?? null
    const endsAt = ends.value ?? null
    if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
      return fail(ApiCode.INVALID_PARAM, '失效时间要晚于生效时间')
    }

    const admin = await currentAdmin(request)
    const pinned = body.pinned === true

    // ⚠️ 这里不用 withLog：它先跑业务再写日志，拿不到「日志里该记的 targetId」
    //    （新公告的 id 得等 create 回来才知道）。所以手动开事务，先建行再写日志。
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.announcement.create({
        data: {
          title,
          content,
          level,
          pinned,
          startsAt,
          endsAt,
          authorId: admin.id,
          authorName: admin.nickname
        }
      })
      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'announcement.create',
          targetType: 'announcement',
          targetId: row.id,
          targetName: title,
          detail: `发公告（${LEVEL_LABEL[level]}${pinned ? '，置顶' : ''}）`,
          ip: request.ip
        },
        tx
      )
      return row
    })

    return ok(toAnnouncement(created))
  })

  /** 22. PATCH /announcements/:id —— 改内容 / 上下架 / 置顶 */
  app.patch('/announcements/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '公告 id 不对')

    const row = await prisma.announcement.findUnique({ where: { id } })
    if (!row) return fail(ApiCode.NOT_FOUND, '这条公告不存在')

    const body = (request.body ?? {}) as Record<string, unknown>
    const data: Prisma.AnnouncementUpdateInput = {}
    const changes: string[] = []

    if (body.title !== undefined) {
      const title = textOf(body.title)
      if (!title) return fail(ApiCode.INVALID_PARAM, '标题不能空')
      if (title.length > TITLE_MAX) return fail(ApiCode.INVALID_PARAM, `标题最多 ${TITLE_MAX} 字`)
      if (title !== row.title) {
        data.title = title
        changes.push('改了标题')
      }
    }

    if (body.content !== undefined) {
      const content = textOf(body.content)
      if (!content) return fail(ApiCode.INVALID_PARAM, '正文不能空')
      if (content.length > CONTENT_MAX) return fail(ApiCode.INVALID_PARAM, `正文最多 ${CONTENT_MAX} 字`)
      if (content !== row.content) {
        data.content = content
        changes.push('改了正文')
      }
    }

    if (body.level !== undefined) {
      if (!isLevel(body.level)) return fail(ApiCode.INVALID_PARAM, '级别只能是 normal / important / maintenance')
      if (body.level !== row.level) {
        data.level = body.level
        changes.push(`级别：${LEVEL_LABEL[row.level as Level] ?? row.level} → ${LEVEL_LABEL[body.level]}`)
      }
    }

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return fail(ApiCode.INVALID_PARAM, 'enabled 是布尔值')
      if (body.enabled !== row.enabled) {
        data.enabled = body.enabled
        changes.push(body.enabled ? '上架' : '下架')
      }
    }

    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') return fail(ApiCode.INVALID_PARAM, 'pinned 是布尔值')
      if (body.pinned !== row.pinned) {
        data.pinned = body.pinned
        changes.push(body.pinned ? '置顶' : '取消置顶')
      }
    }

    const starts = parseDateField(body.startsAt)
    const ends = parseDateField(body.endsAt)
    if (!starts.ok) return fail(ApiCode.INVALID_PARAM, '生效时间格式不对')
    if (!ends.ok) return fail(ApiCode.INVALID_PARAM, '失效时间格式不对')

    if (starts.value !== undefined) {
      data.startsAt = starts.value
      changes.push(starts.value ? '改了生效时间' : '改成立刻生效')
    }
    if (ends.value !== undefined) {
      data.endsAt = ends.value
      changes.push(ends.value ? '改了失效时间' : '改成永不过期')
    }

    // 合并后的区间还得成立：只改一头也要和另一头比一次
    const nextStart = starts.value !== undefined ? starts.value : row.startsAt
    const nextEnd = ends.value !== undefined ? ends.value : row.endsAt
    if (nextStart && nextEnd && nextStart.getTime() >= nextEnd.getTime()) {
      return fail(ApiCode.INVALID_PARAM, '失效时间要晚于生效时间')
    }

    if (changes.length === 0) return fail(ApiCode.INVALID_PARAM, '没有要改的内容')

    const admin = await currentAdmin(request)

    const updated = await withLog(
      {
        adminId: admin.id,
        adminName: admin.nickname,
        action: 'announcement.update',
        targetType: 'announcement',
        targetId: row.id,
        targetName: row.title,
        detail: changes.join('；'),
        ip: request.ip
      },
      async (tx) => tx.announcement.update({ where: { id: row.id }, data })
    )

    return ok(toAnnouncement(updated))
  })

  /** 23. DELETE /announcements/:id —— 真删 */
  app.delete('/announcements/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '公告 id 不对')

    const row = await prisma.announcement.findUnique({ where: { id } })
    if (!row) return fail(ApiCode.NOT_FOUND, '这条公告不存在')

    const admin = await currentAdmin(request)

    await withLog(
      {
        adminId: admin.id,
        adminName: admin.nickname,
        action: 'announcement.delete',
        targetType: 'announcement',
        targetId: row.id,
        targetName: row.title,
        detail: '删掉这条公告',
        ip: request.ip
      },
      async (tx) => {
        await tx.announcement.delete({ where: { id: row.id } })
        // 已读记录跟着清 —— 不然这张表会攒下一堆指向不存在公告的孤儿行
        await tx.announcementRead.deleteMany({ where: { announcementId: row.id } })
      }
    )

    return ok(null)
  })
}
