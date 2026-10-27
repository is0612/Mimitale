/**
 * 概览统计 —— 对应 src/types/admin.ts 的 17 号契约（原 16 个之外新增的）
 *
 * 起因：「今天有多少个账号注册」。客户列表回答不了这个问题。
 */

import { request } from './request'
import type { OverviewRes } from '@/types'

export function fetchOverview(): Promise<OverviewRes> {
  return request<OverviewRes>({
    url: '/admin/overview',
    method: 'get'
  })
}
