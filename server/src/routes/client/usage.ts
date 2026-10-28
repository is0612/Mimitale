import type { FastifyPluginAsync } from 'fastify'
import { ok } from '../../lib/reply.js'
import { currentCustomerId } from '../../lib/whoami.js'
import { consumeDailyMessage, dailyMessageStatus, refundDailyMessage } from '../../lib/quota.js'

/**
 * 免费额度计数 —— 前缀 /api/client/usage，**要登录**（挂在 clientGuard 后面）。
 *
 * 客户端在「发送 / 继续」之前调一次扣数，模型调用完全失败再调一次退款。
 * 三个接口都只认 token 里的人是谁，不接受客户端传 customerId —— 传了就说明
 * 有人想给别人扣数或者给自己加数。
 */
export const clientUsageRoutes: FastifyPluginAsync = async (app) => {
  /** 扣一条；allowed=false 表示今天已经用满 */
  app.post('/message', async (request) => {
    const quota = await consumeDailyMessage(currentCustomerId(request))
    return ok(quota)
  })

  /** 只查剩余，不扣（界面显示「今天还剩 N 条」用） */
  app.get('/message', async (request) => {
    return ok(await dailyMessageStatus(currentCustomerId(request)))
  })

  /** 退一条（每天有上限，服务端有兜底） */
  app.post('/message/refund', async (request) => {
    return ok(await refundDailyMessage(currentCustomerId(request)))
  })
}
