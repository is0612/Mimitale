import type { Customer } from '../generated/prisma/client'
import type { ClientUser } from '@contract'
import { prisma } from '../prisma.js'
import { entitlementOf, MEMBER_NAME } from './membership.js'

/**
 * 客户端看到的「我是谁」—— 登录、/me、兑换卡密之后，回的都是这一份。
 *
 * ⚠️ 为什么放 lib 而不是留在 routes/client/auth.ts：兑换卡密（routes/client/redeem.ts）
 *    也要回同一个形状。抄一份到那边，迟早出现「登录后会员显示 30 天、兑换后显示 0 天」
 *    这类只有对比才看得出的 bug。
 */

/** 每邀 1 人邀请人得几天。无上限，想刷就刷（收费本来也不贵） */
export const INVITE_BONUS_DAYS = 7

/** 会员快照（显示名取 lib/membership 的 MEMBER_NAME，跟后台一致） */
export async function clientMembership(c: Customer) {
  const e = entitlementOf(c)
  const level = c.membershipLevel || 'none'
  const isMember = level !== 'none' && e.memberDaysLeft !== null

  return {
    level: isMember ? level : 'none',
    name: isMember ? MEMBER_NAME : '非会员',
    active: e.active,
    // 免费天数（注册送 + 邀请奖励），剩余为 null 就是已用完
    freeDaysLeft: e.freeDaysLeft,
    freeExpireAt: e.freeExpireAt?.toISOString() ?? null,
    // 会员（后台发的 / 卡密兑换的）
    memberDaysLeft: e.memberDaysLeft,
    memberExpireAt: e.memberExpireAt?.toISOString() ?? null,
    // 权益真正到哪天（两个钱包里更晚的那个）
    until: e.until?.toISOString() ?? null
  }
}

/**
 * 给客户端的账号形状 —— 跟客户端 `publicUser()` 完全一致。
 * ⚠️ id 转成字符串：客户端原来用 UUID，渲染层可能拿它做字符串比较。
 *    服务端内部是自增 int，但**别把它当凭据**（认证一律走 token）。
 * ⚠️ 邀请人数要查库，所以这里是 async —— 加字段时别写成同步的。
 */
export async function toClientUser(c: Customer): Promise<ClientUser> {
  const invitedCount = await prisma.customer.count({ where: { referredById: c.id } })

  return {
    id: String(c.id),
    email: c.email,
    username: c.nickname,
    avatar: c.avatar ?? '',
    createdAt: c.createdAt.toISOString(),
    profileReady: c.profileReady,
    membership: await clientMembership(c),
    inviteCode: c.referralCode ?? '',
    invitedCount,
    // 「每邀 1 人 +7 天」只在这里定义一次，客户端拿来算「多得了几天」
    freeDaysFromInvite: invitedCount * INVITE_BONUS_DAYS
  }
}
