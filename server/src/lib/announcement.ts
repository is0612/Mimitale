import type { Prisma } from '../generated/prisma/client'

/**
 * 「这条公告此刻要不要显示在客户端上」—— 全项目只在这一处判断。
 *
 * ⚠️ 库里**没有** visible 布尔：那得有人定时去翻它，翻漏了就永远不消失，
 *    翻多了服务器白跑。显示与否永远由 enabled + startsAt + endsAt 现算。
 *
 * ⚠️ 后台列表和客户端拉取必须共用这一份条件，否则会出现
 *    「后台标着在架、客户端却看不到」这种互相对不上的情况。
 */
export function liveWindow(now: Date = new Date()): Prisma.AnnouncementWhereInput {
  return {
    enabled: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }
    ]
  }
}

/** 单条对象版（前端/后台标「已过期」时用得上，也是同一套判断） */
export function isLive(
  a: { enabled: boolean; startsAt: Date | null; endsAt: Date | null },
  now: Date = new Date()
): boolean {
  if (!a.enabled) return false
  if (a.startsAt && a.startsAt.getTime() > now.getTime()) return false
  if (a.endsAt && a.endsAt.getTime() < now.getTime()) return false
  return true
}
