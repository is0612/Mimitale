/**
 * 通知公告 —— 对应 src/types/admin.ts 的 20~23 号契约
 *
 * 运营写一条 → 客户端启动时拉下来，显示在聊天页上方的横条里。
 * 「此刻会不会显示」由 enabled + startsAt + endsAt 现算，库里没有 visible 布尔。
 */

import { request } from './request'
import type {
  Announcement,
  AnnouncementListQuery,
  AnnouncementListRes,
  CreateAnnouncementReq,
  UpdateAnnouncementReq
} from '@/types'

/** 20. 列表（含已下架的，后台要能看见全部）+ 此刻在架条数 */
export function fetchAnnouncements(query: AnnouncementListQuery): Promise<AnnouncementListRes> {
  return request<AnnouncementListRes>({
    url: '/admin/announcements',
    method: 'get',
    params: query
  })
}

/** 21. 发一条新公告 */
export function createAnnouncement(payload: CreateAnnouncementReq): Promise<Announcement> {
  return request<Announcement>({
    url: '/admin/announcements',
    method: 'post',
    data: payload
  })
}

/** 22. 改内容 / 上下架 / 置顶 */
export function updateAnnouncement(id: number, payload: UpdateAnnouncementReq): Promise<Announcement> {
  return request<Announcement>({
    url: `/admin/announcements/${id}`,
    method: 'patch',
    data: payload
  })
}

/** 23. 真删（已读记录后端会一起清掉） */
export function deleteAnnouncement(id: number): Promise<null> {
  return request<null>({
    url: `/admin/announcements/${id}`,
    method: 'delete'
  })
}
