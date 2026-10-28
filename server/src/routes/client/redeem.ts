import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { biz } from '../../lib/bizError.js'
import { currentCustomerId } from '../../lib/whoami.js'
import { grantDaysIn } from '../../lib/membership.js'
import { toClientUser } from '../../lib/clientUser.js'

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 把用户抄的码收拾成 `MIMI-XXXX-XXXX`。
 *
 * 容忍大小写、空格、少写连字符 —— 这串是要人一个字一个字抄下来的，
 * 抄错一个字符就报「卡不对」的话，客服会被问爆。
 * 规则和注册时那个 `normalizeInviteInput` 一致（同一个码库）。
 */
function normalizeCardCode(value: unknown): string {
  const raw = textOf(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (!raw) throw biz('先把卡密填上')
  if (raw.length === 12 && raw.startsWith('MIMI')) {
    return `MIMI-${raw.slice(4, 8)}-${raw.slice(8)}`
  }
  if (raw.length !== 8) throw biz('卡密是 MIMI-XXXX-XXXX 这个样子，检查一下有没有抄全')
  return `MIMI-${raw.slice(0, 4)}-${raw.slice(4)}`
}

/**
 * 卡密兑换 —— 前缀 /api/client，**要登录**（挂在 clientGuard 后面）
 *
 * 一张卡只能兑一次，且只兑给自己：`invite_cards.status` 从 unused 改成 used 时
 * 用条件更新（`where: { id, status: 'unused' }`）抢这一张，
 * 两个人同时兑同一张卡只有一个人成功 —— 和注册时消耗卡密是同一招。
 *
 * ⚠️ 失败原因要分得细：卡不存在 / 已被用过 / 已作废 / 已过期。全说「卡密不对」
 *    会让「我明明买了」的人无从下手。
 * ⚠️ 填的其实是别人的**邀请码**（同一套 MIMI-XXXX-XXXX 格式）时，要明确告诉他
 *    「这是邀请码，要在注册时填」—— 否则他会以为自己的卡坏了。
 * ⚠️ 会员天数按**卡上写的**发（`card.days` / `card.level`），不是固定 30 天。
 */
export const clientRedeemRoutes: FastifyPluginAsync = async (app) => {
  app.post('/redeem', async (request) => {
    const customerId = currentCustomerId(request)
    const body = (request.body ?? {}) as Record<string, unknown>

    const code = normalizeCardCode(body.code)

    const me = await prisma.customer.findUnique({ where: { id: customerId } })
    if (!me) return fail(ApiCode.NOT_FOUND, '账号不存在')
    if (me.status === 'banned') {
      return fail(ApiCode.ACCOUNT_BANNED, me.banReason ? '账号已被封禁，如有疑问请联系我们' : '账号已被封禁')
    }

    const result = await prisma.$transaction(async (tx) => {
      const card = await tx.inviteCard.findUnique({ where: { code } })

      if (!card) {
        // 是不是把别人的邀请码当卡密填了？单独说一句，别让人以为自己买到了假卡
        const inviter = await tx.customer.findUnique({ where: { referralCode: code }, select: { id: true } })
        if (inviter) {
          throw biz(inviter.id === customerId ? '这是你自己的邀请码，不能当卡密用' : '这是别人的邀请码 —— 邀请码在注册时填，不是在这里兑')
        }
        throw biz('卡密不对，检查一下有没有抄错')
      }

      if (card.status === 'void') throw biz('这张卡已经作废了，找卖你的人换一张')
      if (card.status === 'used') {
        // 大概率是自己又兑了一遍，或者买了张二手的
        throw biz(
          card.usedByCustomerId === customerId ? '这张卡你已经兑过了' : '这张卡已经被用掉了'
        )
      }
      if (card.expireAt && card.expireAt.getTime() <= Date.now()) throw biz('这张卡过期了')

      // 抢卡：只有还是 unused 才能改成 used，同一个瞬间来的第二个人会拿到 count = 0
      const taken = await tx.inviteCard.updateMany({
        where: { id: card.id, status: 'unused' },
        data: { status: 'used', usedByCustomerId: customerId, usedAt: new Date() }
      })
      if (taken.count === 0) throw biz('这张卡刚被别人兑走了')

      const granted = await grantDaysIn(tx, {
        customerId,
        days: card.days,
        source: 'card',
        wallet: 'member',
        refId: card.id,
        note: `卡密兑换 ${card.code}`
      })

      return { customer: granted.customer, grant: granted.grant, card }
    })

    return ok({
      user: await toClientUser(result.customer),
      // 本次这一张卡的摘要 —— 客户端拿它说「+90 天，到 X 到期」，不用自己算
      grant: {
        days: result.card.days,
        expiresAt: result.grant.expiresAt.toISOString(),
        // 这次把多少天「免费」并进了会员（没有就是 0）—— 界面要写清楚，
        // 否则用户会以为卡买了 90 天却显示 120 天
        absorbedFreeDays: result.grant.absorbedFreeDays,
        code: result.card.code
      }
    })
  })
}
