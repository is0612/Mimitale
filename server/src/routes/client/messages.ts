import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { optionalCustomerId } from '../../lib/auth.js'
import { liveWindow } from '../../lib/announcement.js'
import { DAY_MS } from '../../lib/time.js'

const KINDS = ['bug', 'idea', 'other'] as const
type Kind = (typeof KINDS)[number]

const CONTENT_MAX = 2000
const EMAIL_MAX = 120

/** 同一台设备两次提交的最小间隔 */
const COOLDOWN_MS = 60_000
/** 同一台设备 24 小时内的条数上限 */
const DAILY_MAX = 10

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isKind(v: unknown): v is Kind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v)
}

function isEmail(v: string): boolean {
  // 这里只做「像不像邮箱」的粗筛 —— 真正的验证在发信那一步，
  // 反馈里的邮箱是给人回信用的，不该因为一个正则把真话拦下来
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}

/**
 * 客户端消息：发反馈 / 拉公告。前缀 /api/client
 *
 * ⚠️ 这三个接口**故意不挂 clientGuard**（不登录也要能用）：
 *    ① 发反馈：新用户「连登录都进不去」的时候才最需要报错
 *    ② 拉公告：「你被停机了」这种公告，恰恰要发给登录不进去的人
 *    ③ 标已读：未登录时后端没地方记，返回 unread: 0 让客户端走本地记录
 */
export const clientMessageRoutes: FastifyPluginAsync = async (app) => {
  /** 14. POST /feedback —— 发一条意见反馈 */
  app.post('/feedback', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>

    const content = textOf(body.content)
    if (!content) return fail(ApiCode.INVALID_PARAM, '先写两句再发')
    if (content.length > CONTENT_MAX) return fail(ApiCode.INVALID_PARAM, `最多 ${CONTENT_MAX} 字`)

    const kind: Kind = isKind(body.kind) ? body.kind : 'bug'
    if (body.kind !== undefined && !isKind(body.kind)) {
      return fail(ApiCode.INVALID_PARAM, '类型只能是 bug / idea / other')
    }

    const contactEmail = textOf(body.contactEmail)
    if (contactEmail && (!isEmail(contactEmail) || contactEmail.length > EMAIL_MAX)) {
      return fail(ApiCode.INVALID_PARAM, '邮箱格式不太对')
    }

    const appVersion = textOf(body.appVersion).slice(0, 32)
    const platform = textOf(body.platform).slice(0, 32)
    const deviceId = textOf(body.deviceId).slice(0, 64)
    const customerId = await optionalCustomerId(request)

    // 限频按「设备指纹」走，没带就退回 IP —— 未登录的人只有这两个抓手。
    // ⚠️ 查库而不是记内存：后端一重启内存就清空，限频等于没有。
    const deviceWhere = deviceId ? { deviceId } : { deviceId: '', ip: request.ip }

    const [last, todayCount] = await Promise.all([
      prisma.feedback.findFirst({ where: deviceWhere, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.feedback.count({ where: { ...deviceWhere, createdAt: { gte: new Date(Date.now() - DAY_MS) } } })
    ])

    if (last && Date.now() - last.createdAt.getTime() < COOLDOWN_MS) {
      return fail(ApiCode.TOO_FREQUENT, '刚刚已经发过一条了，等一分钟再发')
    }
    if (todayCount >= DAILY_MAX) {
      return fail(ApiCode.TOO_FREQUENT, '今天发的条数到上限了，有事可以直接邮件联系')
    }

    // 登录了就自动填上联系方式 —— 用户不用自己再敲一遍
    let email = contactEmail
    let name = ''
    if (customerId) {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { email: true, nickname: true }
      })
      if (customer) {
        email = email || customer.email
        name = customer.nickname
      }
    }

    const row = await prisma.feedback.create({
      data: {
        customerId,
        contactEmail: email,
        contactName: name,
        kind,
        content,
        appVersion,
        platform,
        deviceId,
        status: 'pending',
        ip: request.ip
      }
    })

    // 只回 id 和时间：客户端只需要知道「发出去了」，不需要看到自己刚写的东西
    return ok({ id: row.id, createdAt: row.createdAt.toISOString() })
  })

  /** 15. GET /announcements —— 拉此刻该显示的公告 */
  app.get('/announcements', async (request) => {
    const customerId = await optionalCustomerId(request)

    const rows = await prisma.announcement.findMany({
      where: liveWindow(),
      // 置顶的排前面：横条最多显示 2 条，得先显示最要紧的
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: 50
    })

    // 已读状态只对登录用户有意义
    const readIds = new Set<number>()
    if (customerId && rows.length > 0) {
      const reads = await prisma.announcementRead.findMany({
        where: { customerId, announcementId: { in: rows.map((r) => r.id) } },
        select: { announcementId: true }
      })
      for (const r of reads) readIds.add(r.announcementId)
    }

    const list = rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      level: r.level === 'important' ? 'important' : r.level === 'maintenance' ? 'maintenance' : 'normal',
      pinned: r.pinned,
      startsAt: r.startsAt?.toISOString() ?? null,
      endsAt: r.endsAt?.toISOString() ?? null,
      isRead: readIds.has(r.id),
      createdAt: r.createdAt.toISOString()
    }))

    return ok({ list, unread: list.filter((a) => !a.isRead).length })
  })

  /** 16. POST /announcements/:id/read —— 标一条已读 */
  app.post('/announcements/:id/read', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '公告 id 不对')

    const customerId = await optionalCustomerId(request)
    // 未登录：没地方记。回 unread: 0 让客户端自己在本地记一份，不算错误
    if (!customerId) return ok({ unread: 0 })

    const exists = await prisma.announcement.findUnique({ where: { id }, select: { id: true } })
    if (!exists) return fail(ApiCode.NOT_FOUND, '这条公告不存在')

    await prisma.announcementRead.upsert({
      where: { announcementId_customerId: { announcementId: id, customerId } },
      create: { announcementId: id, customerId },
      update: {}
    })

    // 顺手把最新的未读数带回去，客户端不用为了一颗红点再拉一次列表
    const live = await prisma.announcement.findMany({ where: liveWindow(), select: { id: true } })
    const readCount = await prisma.announcementRead.count({
      where: { customerId, announcementId: { in: live.map((a) => a.id) } }
    })

    return ok({ unread: Math.max(0, live.length - readCount) })
  })
}
