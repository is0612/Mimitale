import type { FastifyRequest } from 'fastify'
import { prisma } from '../prisma.js'

/**
 * 客户端使用会话 —— 一次「打开软件到关闭」记一行。
 *
 * 结束时间为什么靠「下次启动结清」而不是退出时同步上报：
 *   强杀 / 断电 / 崩溃都没法在退出那一刻写库，只能下次启动用最后心跳时间补上。
 *   所以 ended_at 和真实退出最多差一个心跳间隔，算「每天用了多久」够用。
 */

/** 心跳写库的最小间隔。5 分钟的心跳没必要每次都落库，攒够这个窗口才 flush 一次 */
const FLUSH_INTERVAL_MS = 30_000

/** sessionId → 最近一次心跳的时间戳。只在内存里，进程重启就丢 —— 丢就丢，下次心跳会再写 */
const pendingTouches = new Map<number, number>()

/** 上一次真写库的时间。用来掐「最多 30 秒写一次」 */
let lastFlushAt = 0
let flushTimer: NodeJS.Timeout | null = null

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushTouches()
  }, FLUSH_INTERVAL_MS)
  // 别让这个 timer 吊住进程退出
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

async function flushTouches(): Promise<void> {
  if (pendingTouches.size === 0) return
  const entries = Array.from(pendingTouches.entries())
  pendingTouches.clear()
  lastFlushAt = Date.now()

  // 一次事务把攒下来的心跳全写掉，避免逐条 UPDATE 打满连接
  try {
    await prisma.$transaction(
      entries.map(([sessionId, seenAt]) =>
        prisma.clientSession.updateMany({
          where: { id: sessionId, endedAt: null },
          data: { lastSeenAt: new Date(seenAt) }
        })
      )
    )
  } catch (err) {
    // 写失败就丢了这次心跳 —— 无所谓，下一次心跳会再写。绝不因此报错给客户端
    console.warn('[session] 心跳批量落库失败（下个心跳会再写）:', (err as Error).message)
  }
}

/**
 * 开一次新会话。
 * 1. 把该客户**上一次**没结清的会话补上 ended_at（用最后心跳，没心跳就用开始时间）
 * 2. 插一行新的，返回它的 id（客户端心跳 / 退出要用）
 */
export async function openSession(request: FastifyRequest, customerId: number): Promise<number> {
  const now = new Date()
  const appVersion = String(request.headers['x-app-version'] ?? '').slice(0, 40)
  const ip = request.ip || ''
  const ua = String(request.headers['user-agent'] ?? '').slice(0, 200)

  // 结清上次没关干净的（可能是上次强杀/断电，没走到 exit）
  await prisma.clientSession.updateMany({
    where: { customerId, endedAt: null },
    data: {
      // last_seen_at 可能为 null（开了但一次心跳都没赶上），退化成 started_at
      endedAt: now,
      endReason: 'unknown',
      ip,
      userAgent: ua
    }
  })

  const created = await prisma.clientSession.create({
    data: { customerId, appVersion, ip, userAgent: ua, startedAt: now }
  })
  return created.id
}

/**
 * 心跳。5 分钟调一次，只在内存里记，攒够 30 秒才批量写库 ——
 * 上千在线用户时也不会把写放大到「一天每人 288 次 UPDATE」。
 */
export function touchSession(request: FastifyRequest, customerId: number, sessionId: number): void {
  pendingTouches.set(sessionId, Date.now())
  // 间隔内第二次心跳直接并进上次那批；到点才真写
  if (Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
    lastFlushAt = Date.now()
    void flushTouches()
  } else {
    scheduleFlush()
  }
}

/**
 * 退出时结清当前会话。客户端在 before-quit 里调，不 await ——
 * 所以这里也容忍失败（进程可能马上就被杀了，写不写得到看运气）。
 */
export async function closeSession(
  request: FastifyRequest,
  customerId: number,
  sessionId: number,
  reason: 'quit' | 'crash',
  detail = ''
): Promise<void> {
  const ip = request.ip || ''
  try {
    await prisma.clientSession.updateMany({
      where: { id: sessionId, customerId, endedAt: null },
      data: {
        endedAt: new Date(),
        endReason: reason,
        endDetail: detail.slice(0, 200),
        lastSeenAt: new Date(),
        ip
      }
    })
  } catch (err) {
    console.warn('[session] 结清会话失败（下次启动会兜底）:', (err as Error).message)
  }
}
