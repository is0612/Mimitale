import type {
  AdminAccount,
  Customer as CustomerDTO,
  InviteCard as InviteCardDTO,
  OperationLog as OperationLogDTO,
  DictType as DictTypeDTO,
  DictItem as DictItemDTO
} from '@contract'
import type {
  Admin,
  Customer,
  InviteCard,
  OperationLog,
  DictType,
  DictItem
} from '../generated/prisma/client'

/**
 * 数据库行 → 接口数据。
 *
 * 唯一的实质工作是把 Date 转成 ISO 字符串：Prisma 给的是 Date 对象，
 * 契约要求的是 string。字段名两边都是 camelCase，不用转换。
 *
 * 所有路由都必须过这一层 —— 直接把 Prisma 对象丢出去，
 * 类型上过得去（Date 是 any 的帮凶），但契约就悄悄破了。
 */

export function toAdmin(a: Admin): AdminAccount {
  return {
    id: a.id,
    username: a.username,
    nickname: a.nickname,
    role: a.role === 'super' ? 'super' : 'normal',
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null
  }
}

export function toCustomer(c: Customer): CustomerDTO {
  return {
    id: c.id,
    email: c.email,
    nickname: c.nickname,
    avatar: c.avatar,
    status: c.status === 'banned' ? 'banned' : 'active',
    banReason: c.banReason,
    membershipLevel: c.membershipLevel,
    membershipExpireAt: c.membershipExpireAt?.toISOString() ?? null,
    freeExpireAt: c.freeExpireAt?.toISOString() ?? null,
    inviteCode: c.inviteCode,
    referralCode: c.referralCode,
    referredById: c.referredById,
    voucher: c.voucher,
    createdAt: c.createdAt.toISOString(),
    lastLoginAt: c.lastLoginAt?.toISOString() ?? null
  }
}

export function toCard(card: InviteCard, usedByEmail: string | null = null): InviteCardDTO {
  return {
    id: card.id,
    code: card.code,
    note: card.note,
    status: card.status === 'used' ? 'used' : card.status === 'void' ? 'void' : 'unused',
    usedByCustomerId: card.usedByCustomerId,
    usedByEmail,
    createdAt: card.createdAt.toISOString(),
    usedAt: card.usedAt?.toISOString() ?? null,
    expireAt: card.expireAt?.toISOString() ?? null
  }
}

export function toLog(l: OperationLog): OperationLogDTO {
  return {
    id: l.id,
    adminId: l.adminId,
    adminName: l.adminName,
    action: l.action as OperationLogDTO['action'],
    targetType: l.targetType,
    targetId: l.targetId,
    targetName: l.targetName,
    detail: l.detail,
    ip: l.ip,
    createdAt: l.createdAt.toISOString()
  }
}

export function toDictType(t: DictType): DictTypeDTO {
  return {
    code: t.code,
    name: t.name,
    remark: t.remark,
    createdAt: t.createdAt.toISOString()
  }
}

export function toDictItem(i: DictItem): DictItemDTO {
  return {
    id: i.id,
    typeCode: i.typeCode,
    label: i.label,
    value: i.value,
    sort: i.sort,
    enabled: i.enabled,
    remark: i.remark
  }
}
