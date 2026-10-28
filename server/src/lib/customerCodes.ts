import type { Prisma } from '../generated/prisma/client'
import { makeVoucher } from './voucher.js'
import { newInviteCode } from './cardCode.js'
import { biz } from './bizError.js'

/**
 * 凭证码 / 自己的邀请码 —— 生成 + 查重。
 *
 * 注册和「后台代建客户」都要发这两个码，而它们都必须**全表唯一**：
 *   凭证码：换机器登录的唯一凭据，撞了两个人就互相能登对方的号
 *   邀请码：客户拿去送人，撞了天数会加到别人头上
 *
 * ⚠️ 唯一性靠的唯一索引只有 customers.email；voucher / referralCode 上**没有**
 *    唯一约束（当初建表没加），所以只能生成时先查一遍。31^24 / 31^8 的空间，
 *    实际几乎不会撞，但撞了必须换一个再来 —— 别用「理论上不会」赌用户数据。
 * ⚠️ 两条都要能查 referralCode **也**查 voucher：客户可以用凭证码的样式去填邀请码，
 *    所以这两个字段在「被当成码」这件事上是同一个命名空间。
 */

/** 生成一个没被占用的凭证码（24 位） */
export async function makeUniqueVoucher(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = makeVoucher()
    const clash = await tx.customer.findUnique({ where: { voucher: candidate }, select: { id: true } })
    if (!clash) return candidate
  }
  throw biz('凭证码生成失败，稍后再试')
}

/** 生成一个没被占用的邀请码（MIMI-XXXX-XXXX） */
export async function makeUniqueReferralCode(tx: Prisma.TransactionClient): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = newInviteCode()
    const clash = await tx.customer.findFirst({
      where: { OR: [{ referralCode: candidate }, { voucher: candidate }] },
      select: { id: true }
    })
    if (!clash) return candidate
  }
  throw biz('邀请码生成失败，稍后再试')
}
