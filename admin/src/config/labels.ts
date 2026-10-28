/**
 * ============================================================================
 * 显示名 / 标签色 —— 写死在代码里的那些枚举
 * ============================================================================
 *
 * ⚠️ 为什么这些**不放字典**？判断标准只有一条：
 *
 *     加一个新的值，需不需要改代码？
 *
 *   需要 → 写在这里（下面这些全是）。因为后端有 `if (status === 'banned')`、
 *          前端有 `row.status === 'active' ? '封禁' : '解封'` —— 值本身参与逻辑。
 *          把它塞进字典，只能改显示名，加不出真正生效的选项，
 *          结果是界面上多出一个「选得动、但什么都不发生」的假旋钮。
 *
 *   不需要 → 放字典（封禁原因、客户来源、卡密备注）。
 *           运营自己加一个「刷屏」不用重新部署，这才是字典该干的事。
 *
 * 这条边界是有意的，别为了「统一」把这些也搬进字典。
 */

import type {
  AnnouncementLevel,
  CardStatus,
  CustomerStatus,
  FeedbackKind,
  FeedbackStatus,
  GrantSource,
  LogAction,
  MembershipLevel
} from '@/types'

/** el-tag 支持的类型 */
export type TagType = 'success' | 'info' | 'warning' | 'danger'

/** 操作日志的动作 → 中文 */
export const LOG_ACTION_LABEL: Record<LogAction, string> = {
  'customer.ban': '封禁客户',
  'customer.unban': '解封客户',
  'customer.membership': '发会员',
  'customer.create': '代建账号',
  'customer.delete': '删除账号',
  'card.create': '生成卡密',
  'card.void': '作废卡密',
  'dict.create': '新建字典',
  'dict.update': '改字典项',
  'dict.delete': '删字典项',
  'feedback.update': '处理反馈',
  'announcement.create': '发公告',
  'announcement.update': '改公告',
  'announcement.delete': '删公告'
}

/** 动作 → 标签色。破坏性的红、恢复性的绿、其它中性 */
export const LOG_ACTION_TAG: Record<LogAction, TagType> = {
  'customer.ban': 'danger',
  'customer.unban': 'success',
  'customer.membership': 'success',
  'customer.create': 'success',
  'customer.delete': 'danger',
  'card.create': 'info',
  'card.void': 'danger',
  'dict.create': 'info',
  'dict.update': 'warning',
  'dict.delete': 'danger',
  'feedback.update': 'warning',
  'announcement.create': 'success',
  'announcement.update': 'warning',
  'announcement.delete': 'danger'
}

/** 日志筛选项（顺序即下拉里的顺序） */
export const LOG_ACTION_OPTIONS: LogAction[] = [
  'customer.create',
  'customer.delete',
  'customer.ban',
  'customer.unban',
  'customer.membership',
  'card.create',
  'card.void',
  'dict.create',
  'dict.update',
  'dict.delete',
  'feedback.update',
  'announcement.create',
  'announcement.update',
  'announcement.delete'
]

/** 活动类型 —— 代码枚举（服务端 record 的入参），不进字典 */
export const LOGIN_METHOD_LABEL: Record<string, string> = {
  password: '密码登录',
  voucher: '凭证登录',
  register: '注册即登录'
}

export const LOGIN_METHOD_TAG: Record<string, TagType> = {
  password: 'info',
  voucher: 'warning',
  register: 'success'
}

/** 使用会话的结束原因 —— 代码枚举，不进字典 */
export const SESSION_END_REASON_LABEL: Record<string, string> = {
  quit: '正常退出',
  crash: '崩溃',
  unknown: '未知（下次启动结清）'
}

export const SESSION_END_REASON_TAG: Record<string, TagType> = {
  quit: 'success',
  crash: 'danger',
  unknown: 'info'
}

/** 客户状态 */
export const CUSTOMER_STATUS_LABEL: Record<CustomerStatus, string> = {
  active: '正常',
  banned: '已封禁'
}

export const CUSTOMER_STATUS_TAG: Record<CustomerStatus, TagType> = {
  active: 'success',
  banned: 'danger'
}

/**
 * 会员在界面上的名字。只有一档，所以是常量、不查字典（2026-10-28）。
 * 和服务端 `lib/clientUser.ts` 的 MEMBER_NAME 是同一个词 —— 改要两边一起改，
 * 否则会出现「后台说订阅会员、客户端说初级会员」。
 */
export const MEMBER_NAME = '订阅会员'

/**
 * 会员生效状态：none 非会员 / active 生效中 / expired 已过期。
 * 只由「等级 + 到期时间 vs 现在」推导 —— 后端不需要在表里另存一个"过期"字段。
 *
 * 显示名走上面的 MEMBER_NAME，不再查 membership_level 字典：
 * 产品上只有一档，字典里那几档（初级/中级/高级）是早期留下的，
 * 谁在字典页改个字客户端就跟着变，是不可控因素。
 */
export function membershipState(c: {
  membershipLevel: MembershipLevel
  membershipExpireAt: string | null
}): 'none' | 'active' | 'expired' {
  if (c.membershipLevel === 'none' || !c.membershipExpireAt) return 'none'
  return Date.parse(c.membershipExpireAt) > Date.now() ? 'active' : 'expired'
}

/**
 * 免费天数还剩几天（向上取整，今天到期 = 1）。没送过 / 已用完 = null。
 * ⚠️ 跟服务端 `lib/membership.ts` 的 entitlementOf 同一算法，两边不一致会出现
 *    「后台说还剩 3 天、客户端说已结束」。
 */
export function freeDaysLeft(c: { freeExpireAt: string | null }): number | null {
  if (!c.freeExpireAt) return null
  const ms = Date.parse(c.freeExpireAt) - Date.now()
  return ms > 0 ? Math.ceil(ms / 86_400_000) : null
}

/** 免费天数状态：没送过 / 还能用 / 已用完 */
export function freeState(c: { freeExpireAt: string | null }): 'none' | 'active' | 'expired' {
  if (!c.freeExpireAt) return 'none'
  return Date.parse(c.freeExpireAt) > Date.now() ? 'active' : 'expired'
}

/**
 * 一段天数的来源 —— 送了几天、谁给的。
 * `trial` / `invite` 都是免费天数，`admin` 是会员。
 */
export const GRANT_SOURCE_LABEL: Record<GrantSource, string> = {
  trial: '注册赠送',
  card: '卡密兑换',
  invite: '邀请奖励',
  admin: '后台发会员'
}

export const GRANT_SOURCE_TAG: Record<GrantSource, TagType> = {
  trial: 'info',
  card: 'success',
  invite: 'warning',
  admin: 'success'
}

/** 卡密状态 */
export const CARD_STATUS_LABEL: Record<CardStatus, string> = {
  unused: '未使用',
  used: '已使用',
  void: '已作废'
}

export const CARD_STATUS_TAG: Record<CardStatus, TagType> = {
  unused: 'success',
  used: 'info',
  void: 'danger'
}

/**
 * 客户来源 —— 由「有没有邀请码」推导，**数据库里不存这一列**。
 * 值本身是推导出来的，但显示名走字典 customer_source，所以运营改叫法不用动代码。
 */
export function deriveCustomerSource(customer: { inviteCode: string | null }): string {
  return customer.inviteCode ? 'invite' : 'email'
}

/** 统一的时间格式化：2026-10-08 14:30 */
export function formatTime(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 只到日：2026-10-08 */
export function formatDay(value: string | null): string {
  if (!value) return '—'
  return formatTime(value).slice(0, 10)
}

/* ------------------------------------------------------------------ */
/* 消息：意见反馈 / 通知公告                                            */
/* ------------------------------------------------------------------ */

/** 反馈类型 —— 客户端弹窗那三颗按钮的同一套叫法 */
export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  bug: '问题',
  idea: '建议',
  other: '其它'
}

export const FEEDBACK_KIND_TAG: Record<FeedbackKind, TagType> = {
  bug: 'danger',
  idea: 'warning',
  other: 'info'
}

/** 反馈类型筛选项（顺序即下拉里的顺序） */
export const FEEDBACK_KIND_OPTIONS: FeedbackKind[] = ['bug', 'idea', 'other']

/**
 * 反馈状态。
 * pending 还没人看 → read 看过了 → resolved 处理完了 / ignored 不打算处理。
 * ⚠️ 没有「已回复」这一档：客户端没有收回复的地方，加了就是个假的。
 */
export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  pending: '待处理',
  read: '已查看',
  resolved: '已处理',
  ignored: '已忽略'
}

export const FEEDBACK_STATUS_TAG: Record<FeedbackStatus, TagType> = {
  pending: 'danger',
  read: 'info',
  resolved: 'success',
  ignored: 'warning'
}

export const FEEDBACK_STATUS_OPTIONS: FeedbackStatus[] = ['pending', 'read', 'resolved', 'ignored']

/**
 * 公告级别 —— 决定客户端横条的颜色和左边那颗图标。
 * 加一档要同时改客户端样式，所以是代码枚举、不进字典。
 */
export const ANNOUNCEMENT_LEVEL_LABEL: Record<AnnouncementLevel, string> = {
  normal: '普通',
  important: '重要',
  maintenance: '维护'
}

export const ANNOUNCEMENT_LEVEL_TAG: Record<AnnouncementLevel, TagType> = {
  normal: 'info',
  important: 'danger',
  maintenance: 'warning'
}

/** 公告此刻能不能显示在客户端上 —— 前端只用来标「已过期」，判断真源在服务端 */
export function announcementLive(a: {
  enabled: boolean
  startsAt: string | null
  endsAt: string | null
}): boolean {
  if (!a.enabled) return false
  const now = Date.now()
  if (a.startsAt && Date.parse(a.startsAt) > now) return false
  if (a.endsAt && Date.parse(a.endsAt) < now) return false
  return true
}
