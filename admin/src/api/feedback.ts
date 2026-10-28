/**
 * 意见反馈 —— 对应 src/types/admin.ts 的 18~19 号契约
 *
 * 客户端用户点「意见反馈」写的那段话会落到这里。
 * ⚠️ 这一页只有「看」和「标状态」，**没有编辑正文的接口** ——
 *    改了就成了伪造用户发言。见服务端 routes/admin/feedbacks.ts 文件头。
 */

import { request } from './request'
import type { Feedback, FeedbackListQuery, FeedbackListRes, UpdateFeedbackReq } from '@/types'

/** 18. 列表（分页 + 状态 + 类型 + 关键词），顺带把各状态总数拿回来 */
export function fetchFeedbacks(query: FeedbackListQuery): Promise<FeedbackListRes> {
  return request<FeedbackListRes>({
    url: '/admin/feedbacks',
    method: 'get',
    params: query
  })
}

/** 19. 改状态 / 写内部备注 */
export function updateFeedback(id: number, payload: UpdateFeedbackReq): Promise<Feedback> {
  return request<Feedback>({
    url: `/admin/feedbacks/${id}`,
    method: 'patch',
    data: payload
  })
}
