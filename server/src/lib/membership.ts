import { prisma } from '../prisma.js'
import { DAY_MS } from './time.js'
import type { Customer, Prisma } from '../generated/prisma/client'

/**
 * 加天数的唯一入口。
 *
 * 两个钱包，各自累加、互不吞噬：
 *   free   → customers.free_expire_at       注册送的 30 天、每邀 1 人 +7 天
 *   member → customers.membership_expire_at 后台手动发的会员
 *
 * 实际权益取两者里更晚的那个（`entitlementOf`）。分开存的好处是
 * 「免费还剩几天」永远是一个减法 —— 混在一条时间轴上就得从混合区间里拆。
 *
 * ⚠️ 每次加天数都要写一条 membership_grants：只改到期日不记流水，
 *    「这 30 天是谁给的」就永久丢了，事后补不回来。
 */

/** trial 注册赠送 / invite 邀请奖励 / admin 后台发 */
export type GrantSource = 'trial' | 'invite' | 'admin'

export type Wallet = 'free' | 'member'

interface GrantInput {
  customerId: number
  days: number
  source: GrantSource
  wallet: Wallet
  /** 一句话说明，展示在「天数流水」里 */
  note?: string
  /** invite 存被邀请人 id，admin 存管理员 id */
  refId?: number | null
  /** 只有 member 钱包用：同时写进 membership_level */
  level?: string
}

export interface GrantResult {
  customer: Customer
  /** 这一段天数落在哪个区间 —— 日志文案要用「到期哪天」 */
  grant: { days: number; source: GrantSource; startsAt: Date; expiresAt: Date }
}

/**
 * 加天数（必须在调用方的事务里跑）。
 *
 * ⚠️ 先 SELECT ... FOR UPDATE 锁住这行再算到期日。邀请是「每邀 1 人 +7 天、无上限」，
 *    同一个人被两个号同时邀请是完全可能的；不锁的话两笔都读到旧到期日，
 *    后写的那笔直接吃掉前一笔的天数。
 */
export async function grantDaysIn(
  tx: Prisma.TransactionClient,
  input: GrantInput
): Promise<GrantResult> {
  const rows = await tx.$queryRaw<Array<{ free_expire_at: Date | null; membership_expire_at: Date | null }>>`
    SELECT free_expire_at, membership_expire_at FROM customers WHERE id = ${input.customerId} FOR UPDATE
  `
  const locked = rows[0]
  if (!locked) throw new Error(`客户 ${input.customerId} 不存在`)

  const now = Date.now()
  const current = input.wallet === 'free' ? locked.free_expire_at : locked.membership_expire_at
  // 还在有效期内就往后接，已过期或从没有过就从今天起算
  const startsAt = new Date(Math.max(now, current ? current.getTime() : 0))
  const expiresAt = new Date(startsAt.getTime() + input.days * DAY_MS)

  const data: Prisma.CustomerUpdateInput =
    input.wallet === 'free' ? { freeExpireAt: expiresAt } : { membershipExpireAt: expiresAt }
  if (input.wallet === 'member' && input.level) data.membershipLevel = input.level

  await tx.membershipGrant.create({
    data: {
      customerId: input.customerId,
      days: input.days,
      source: input.source,
      note: input.note ?? '',
      refId: input.refId ?? null,
      startsAt,
      expiresAt
    }
  })

  const customer = await tx.customer.update({ where: { id: input.customerId }, data })

  return {
    customer,
    grant: { days: input.days, source: input.source, startsAt, expiresAt }
  }
}

/** 加天数（自己开事务的版本，给只有一笔写入的调用方用） */
export async function grantDays(input: GrantInput): Promise<GrantResult> {
  return prisma.$transaction((tx) => grantDaysIn(tx, input))
}

export interface Entitlement {
  /** 还能用（免费或会员任一未过期） */
  active: boolean
  /** 免费天数用到哪天 */
  freeExpireAt: Date | null
  /** 免费还剩几天（向上取整，已过期 / 没有 = null） */
  freeDaysLeft: number | null
  /** 会员用到哪天 */
  memberExpireAt: Date | null
  memberDaysLeft: number | null
  /** 真正的权益到期日 = 两个钱包里更晚的那个 */
  until: Date | null
  /** 这份权益是不是纯免费的（会员没了、只剩免费天数） */
  freeOnly: boolean
}

/**
 * 权益快照。⚠️ 「有没有过期」只认这里算出来的结果，
 * 客户端别拿本地时钟去比 —— 改系统时间就能把自己变成永久会员。
 */
export function entitlementOf(c: {
  freeExpireAt: Date | null
  membershipExpireAt: Date | null
}, now = Date.now()): Entitlement {
  const left = (d: Date | null): number | null => {
    if (!d) return null
    const ms = d.getTime() - now
    return ms > 0 ? Math.ceil(ms / DAY_MS) : null
  }

  const freeDaysLeft = left(c.freeExpireAt)
  const memberDaysLeft = left(c.membershipExpireAt)
  const until =
    c.freeExpireAt && c.membershipExpireAt
      ? new Date(Math.max(c.freeExpireAt.getTime(), c.membershipExpireAt.getTime()))
      : (c.freeExpireAt ?? c.membershipExpireAt)

  return {
    active: freeDaysLeft !== null || memberDaysLeft !== null,
    freeExpireAt: c.freeExpireAt,
    freeDaysLeft,
    memberExpireAt: c.membershipExpireAt,
    memberDaysLeft,
    until,
    freeOnly: memberDaysLeft === null && freeDaysLeft !== null
  }
}
