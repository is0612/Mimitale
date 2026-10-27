import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../../prisma.js'
import { ok } from '../../lib/reply.js'
import { toCustomer } from '../../lib/dto.js'
import { DAY_MS, dayRange, daysAgo, today } from '../../lib/time.js'

/**
 * 概览 —— 「今天有多少个账号注册」就是在这儿回答的。
 *
 * 这个接口不属于原来的 16 个契约（后台首页没有数据卡片），是后加的。
 * 契约类型见 admin/src/types/admin.ts 的 OverviewRes。
 *
 * ⚠️ 所有「今天」都按北京时间算，不看服务器时区 —— Docker 里默认是 UTC，
 *    直接拿 new Date() 算日期会把早上 8 点前的注册算到昨天。
 *
 * 前缀：/api/admin
 */
export const adminOverviewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/overview', async () => {
    const now = new Date()
    const todayRange = dayRange(today())
    const yesterdayRange = dayRange(daysAgo(1))
    const sevenDaysLater = new Date(now.getTime() + 7 * DAY_MS)
    const trendSince = dayRange(daysAgo(6)).start

    /** 会员的两个条件，复用三次 */
    const member = { membershipLevel: { not: 'none' } }

    const [
      todayRegistered,
      yesterdayRegistered,
      totalCustomers,
      bannedCustomers,
      activeMembers,
      memberTotal,
      expiringIn7Days,
      todayActive,
      unusedCards,
      recent,
      trendRows
    ] = await Promise.all([
      // 「今日注册」只算**走完注册第二步**的人 —— 第一步只是建了个没资料的壳，
      // 把那些算进去数字会虚高（用户中途放弃、或者拿脚本刷）
      prisma.customer.count({
        where: { profileReady: true, createdAt: { gte: todayRange.start, lt: todayRange.end } }
      }),
      prisma.customer.count({
        where: { profileReady: true, createdAt: { gte: yesterdayRange.start, lt: yesterdayRange.end } }
      }),
      prisma.customer.count(),
      prisma.customer.count({ where: { status: 'banned' } }),

      // 「会员」= 等级不是 none 且还没到期（过期状态由到期时间推导，不存字段）
      prisma.customer.count({ where: { ...member, membershipExpireAt: { gt: now } } }),
      prisma.customer.count({ where: member }),
      prisma.customer.count({
        where: { ...member, membershipExpireAt: { gt: now, lte: sevenDaysLater } }
      }),

      // 今天有动作的客户（登录过）
      prisma.customer.count({
        where: { lastLoginAt: { gte: todayRange.start, lt: todayRange.end } }
      }),

      prisma.inviteCard.count({ where: { status: 'unused' } }),

      prisma.customer.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5 }),

      // 近 7 天每天注册了多少。用 SQL 分组，别把几千行拉回来在 JS 里数
      prisma.$queryRaw<Array<{ day: string; count: number }>>`
        SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS count
        FROM customers
        WHERE created_at >= ${trendSince}
        GROUP BY 1
      `
    ])

    const byDay = new Map(trendRows.map((r) => [r.day, Number(r.count)]))
    // 中间没人的那天也要有一个 0 —— 否则曲线会把两天的数据连起来，看着像天天都有人注册
    const trend = Array.from({ length: 7 }, (_, i) => {
      const day = daysAgo(6 - i)
      return { day, count: byDay.get(day) ?? 0 }
    })

    return ok({
      todayRegistered,
      yesterdayRegistered,
      totalCustomers,
      bannedCustomers,
      activeMembers,
      memberTotal,
      expiringIn7Days,
      todayActive,
      unusedCards,
      trend,
      recent: recent.map(toCustomer)
    })
  })
}
