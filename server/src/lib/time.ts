/**
 * 时间统一按**北京时间**算，跟服务器在哪个时区跑无关。
 *
 * 为什么必须写死：Docker 容器默认 UTC。如果直接用 new Date().getDate() 算「今天」，
 * 北京时间早上 8 点之前的注册会被算到「昨天」—— 星宝看到的数字就是错的。
 */

export const DAY_MS = 86_400_000
export const TZ = 'Asia/Shanghai'

/** ISO 时间（或 Date）→ 北京时间下的 YYYY-MM-DD */
export function dayOf(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value
  // en-CA 的日期格式正好是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)
}

/** 今天的北京日期 */
export function today(): string {
  return dayOf(new Date())
}

/**
 * 'YYYY-MM-DD' 当作北京时间的一整天 → [start, end) 两个 UTC 时刻。
 * 用半开区间，避免 23:59:59.999 这种边界漏数据。
 */
export function dayRange(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000+08:00`)
  const end = new Date(start.getTime() + DAY_MS)
  return { start, end }
}

/** 从今天往前推 n 天的北京日期 */
export function daysAgo(n: number): string {
  return dayOf(new Date(Date.now() - n * DAY_MS))
}
