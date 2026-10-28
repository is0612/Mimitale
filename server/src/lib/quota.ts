import { prisma } from '../prisma.js'
import { entitlementOf } from './membership.js'

/**
 * 免费额度：没有权益的人每天能发几条。
 *
 * 计数放服务端，是为了让「改系统时间 / 改本地数据」都重置不了 ——
 * 客户端那份判断只是体验层（提前把输入框锁上、超额弹窗），
 * 真正决定放不放行的是这里。
 */

/** 一天几条 */
export const FREE_DAILY_MESSAGES = 20
/** 一天最多退几条（模型调用完全失败时退） */
export const FREE_DAILY_REFUNDS = 5

/**
 * 服务器时区的自然日。
 * ⚠️ 别用 toISOString().slice(0,10)：那是 UTC，中国晚上 8 点后日期就和用户看到的不是一天，
 *    「明天 0 点恢复」会变成下午 4 点恢复。
 */
export function dayKey(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export interface MessageQuota {
  /** true = 有权益，不限量（limit/used 此时没有意义） */
  unlimited: boolean
  limit: number
  used: number
  remaining: number
  /** 服务器自然日，客户端拿来判断「跨天了，刷新一下」 */
  day: string
}

async function entitled(customerId: number): Promise<boolean> {
  const c = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { freeExpireAt: true, membershipExpireAt: true }
  })
  // 查不到人也别拦：这只会发生在账号刚被删、token 还没过期的那几分钟
  if (!c) return true
  return entitlementOf(c).active
}

// remaining 填 0 不填 Infinity：Infinity JSON 序列化成 null，客户端会读成「没有剩余」
function unlimited(day: string): MessageQuota {
  return { unlimited: true, limit: FREE_DAILY_MESSAGES, used: 0, remaining: 0, day }
}

async function usedToday(customerId: number, day: string): Promise<number> {
  const row = await prisma.clientMessageUsage.findUnique({
    where: { customerId_day: { customerId, day } },
    select: { used: true }
  })
  return row?.used ?? 0
}

/** 只查今天用了多少，不扣 */
export async function dailyMessageStatus(customerId: number): Promise<MessageQuota> {
  const day = dayKey()
  if (await entitled(customerId)) return unlimited(day)
  const used = await usedToday(customerId, day)
  return {
    unlimited: false,
    limit: FREE_DAILY_MESSAGES,
    used,
    remaining: Math.max(0, FREE_DAILY_MESSAGES - used),
    day
  }
}

/**
 * 扣一条（发消息 / 继续 之前调）。
 *
 * ⚠️ 判定和自增必须在同一条 SQL 里：先 findUnique 看够不够、再 update +1，
 *    两个请求同时进来会都读到 used=19，然后都放行 —— 20 条就成了 21 条。
 */
export async function consumeDailyMessage(customerId: number): Promise<MessageQuota & { allowed: boolean }> {
  const day = dayKey()
  if (await entitled(customerId)) return { ...unlimited(day), allowed: true }

  const rows = await prisma.$queryRaw<Array<{ used: number }>>`
    INSERT INTO client_message_usage (customer_id, day, used, refunds, updated_at)
    VALUES (${customerId}, ${day}, 1, 0, now())
    ON CONFLICT (customer_id, day) DO UPDATE
      SET used = client_message_usage.used + 1, updated_at = now()
      WHERE client_message_usage.used < ${FREE_DAILY_MESSAGES}
    RETURNING used
  `

  if (rows.length === 0) {
    // WHERE 没过 = 今天已经满了；把真实数字读回去给客户端显示
    const used = await usedToday(customerId, day)
    return {
      allowed: false,
      unlimited: false,
      limit: FREE_DAILY_MESSAGES,
      used,
      remaining: Math.max(0, FREE_DAILY_MESSAGES - used),
      day
    }
  }

  const used = rows[0]?.used ?? FREE_DAILY_MESSAGES
  return {
    allowed: true,
    unlimited: false,
    limit: FREE_DAILY_MESSAGES,
    used,
    remaining: Math.max(0, FREE_DAILY_MESSAGES - used),
    day
  }
}

/**
 * 退一条 —— 模型调用完全没产出时（Key 填错、厂商 4xx、断网）用。
 *
 * ⚠️ 必须带上限：没有 refunds < N 的话，每次发完立刻退，等于这个账号有无限额度。
 */
export async function refundDailyMessage(customerId: number): Promise<{ refunded: boolean } & MessageQuota> {
  const day = dayKey()
  if (await entitled(customerId)) return { ...unlimited(day), refunded: false }

  const rows = await prisma.$queryRaw<Array<{ used: number }>>`
    UPDATE client_message_usage
       SET used = used - 1, refunds = refunds + 1, updated_at = now()
     WHERE customer_id = ${customerId}
       AND day = ${day}
       AND used > 0
       AND refunds < ${FREE_DAILY_REFUNDS}
    RETURNING used
  `

  const used = rows[0]?.used ?? (await usedToday(customerId, day))
  return {
    refunded: rows.length > 0,
    unlimited: false,
    limit: FREE_DAILY_MESSAGES,
    used,
    remaining: Math.max(0, FREE_DAILY_MESSAGES - used),
    day
  }
}
