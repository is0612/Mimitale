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
      freeActive,
      freeExpiring,
      freeGrantedRows,
      todayActive,
      sessionStats,
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

      // 「会员」= 后台发过、等级不是 none、且还没到期。**不含免费天数**
      prisma.customer.count({ where: { ...member, membershipExpireAt: { gt: now } } }),
      prisma.customer.count({ where: member }),
      prisma.customer.count({
        where: { ...member, membershipExpireAt: { gt: now, lte: sevenDaysLater } }
      }),

      // 免费天数还没用完的人 —— 这批是「还没转化」的盘子
      prisma.customer.count({ where: { freeExpireAt: { gt: now } } }),
      // 免费 7 天内到期：最该推付费的那批
      prisma.customer.count({ where: { freeExpireAt: { gt: now, lte: sevenDaysLater } } }),
      // 累计送出去多少天免费（注册 + 邀请），不按人算，按天算
      prisma.membershipGrant.groupBy({
        by: ['source'],
        where: { source: { in: ['trial', 'invite'] } },
        _sum: { days: true }
      }),

      // 今天有动作的客户（登录过）
      prisma.customer.count({
        where: { lastLoginAt: { gte: todayRange.start, lt: todayRange.end } }
      }),

      // 使用会话统计：今天开过软件的人数 + 近 7 天平均单次会话时长（分钟）。
      // ⚠️ 结束时间用 COALESCE(ended_at, last_seen_at, started_at) ——
      //    没结清（还开着）的会话取最后心跳，开了但一次心跳都没赶上的取开始时间。
      //    超过 12 小时的幽灵会话（挂机不关）不算进平均，否则平均时长会被拉到几十小时。
      prisma.$queryRaw<Array<{ today_users: number; avg_minutes: number }>>`
        SELECT
          (SELECT COUNT(DISTINCT customer_id)::int
             FROM client_sessions
            WHERE started_at >= ${todayRange.start} AND started_at < ${todayRange.end}) AS today_users,
          (SELECT COALESCE(ROUND(AVG(
                    EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen_at, started_at) - started_at)) / 60
                  ))::int, 0)
             FROM client_sessions
            WHERE started_at >= ${trendSince}
              AND EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen_at, started_at) - started_at)) <= 12 * 3600
          ) AS avg_minutes
      `,

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
      freeActive,
      freeExpiring,
      // 累计送出去的免费天数（注册 + 邀请），按天算不按人算
      freeDaysGranted: freeGrantedRows.reduce((sum, r) => sum + (r._sum.days ?? 0), 0),
      todayActive,
      todaySessionUsers: sessionStats[0]?.today_users ?? 0,
      avgSessionMinutes: sessionStats[0]?.avg_minutes ?? 0,
      unusedCards,
      trend,
      recent: recent.map(toCustomer)
    })
  })
}
