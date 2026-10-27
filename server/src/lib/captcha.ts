import { randomInt, randomUUID } from 'node:crypto'
import { biz } from './bizError.js'

/**
 * 图形校验码。
 *
 * 为什么需要它：`POST /api/client/auth/code` 会真发一封邮件。没有这道闸，
 * 任何人写个循环就能把别人的邮箱塞满、把你的 SMTP 额度刷爆。
 *
 * 为什么不落库：这东西 5 分钟就过期、一次性、丢了让用户点一下换一张即可。
 * 存数据库只会多一张要清理的表。代价是服务重启后正在注册的人要重新换一张，
 * 提示语里已经说了「点图片换一张」，不算坑。
 *
 * 画法和 `client/main/account.js` 里那版一致 —— 同一个应用里两种校验码长得不一样
 * 会显得很随意。
 */

/** 去掉 0/O/1/I/L 这些抄错就说不清的 */
const CAPTCHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const TTL_MS = 5 * 60 * 1000
/** 内存上限。超过就砍掉最老的一半 —— 防止有人拿脚本狂刷 /captcha 把进程撑爆 */
const MAX_ENTRIES = 2000

interface Entry {
  answer: string
  expiresAt: number
}

const store = new Map<string, Entry>()

function randomAnswer(length = 4): string {
  let out = ''
  // charAt 而不是下标：越界时下标返回 undefined，`+=` 会把它拼成字面上的 "undefined"，
  // 校验码从 4 位变 9 位，用户永远输不对
  for (let i = 0; i < length; i += 1) out += CAPTCHA_CHARS.charAt(randomInt(CAPTCHA_CHARS.length))
  return out
}

function captchaSvg(answer: string): string {
  const width = 112
  const height = 40
  const parts: string[] = []

  parts.push(`<rect width="${width}" height="${height}" rx="4" fill="#1d2126"/>`)

  // 噪点比噪线耐看，也不会把字符压糊
  for (let i = 0; i < 26; i += 1) {
    const x = randomInt(2, width - 2)
    const y = randomInt(2, height - 2)
    parts.push(`<circle cx="${x}" cy="${y}" r="0.8" fill="#3b4249"/>`)
  }

  for (let i = 0; i < 2; i += 1) {
    const y1 = randomInt(6, height - 6)
    const y2 = randomInt(6, height - 6)
    const cy1 = randomInt(0, height)
    const cy2 = randomInt(0, height)
    parts.push(
      `<path d="M0 ${y1} C ${width * 0.3} ${cy1}, ${width * 0.7} ${cy2}, ${width} ${y2}" ` +
        'fill="none" stroke="#4a535c" stroke-width="1.2"/>'
    )
  }

  const step = width / (answer.length + 1)
  for (let i = 0; i < answer.length; i += 1) {
    const x = Math.round(step * (i + 1))
    const y = Math.round(height / 2 + randomInt(-3, 4))
    const rotate = randomInt(-22, 23)
    const size = randomInt(20, 25)
    const color = ['#e8e4d8', '#cbb88f', '#a9c2b0'][randomInt(0, 3)]
    parts.push(
      `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" ` +
        `font-family="Consolas, monospace" font-size="${size}" font-weight="700" ` +
        `fill="${color}" transform="rotate(${rotate} ${x} ${y})">${answer[i]}</text>`
    )
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export interface CaptchaResult {
  id: string
  /** data:image/svg+xml;... 直接塞进 <img src> */
  image: string
  /** 有效期（秒） */
  expiresIn: number
  /** ⚠️ 只有自动化测试（MIMITALE_ACCOUNT_TEST=1）才带答案，生产绝不给 */
  answer?: string
}

export function createCaptcha(options: { reveal?: boolean } = {}): CaptchaResult {
  const now = Date.now()

  for (const [id, entry] of store) {
    if (entry.expiresAt < now) store.delete(id)
    else break // Map 按插入序，后面的只会更晚过期
  }

  if (store.size > MAX_ENTRIES) {
    let drop = Math.floor(store.size / 2)
    for (const id of store.keys()) {
      store.delete(id)
      if (--drop <= 0) break
    }
  }

  const id = randomUUID()
  const answer = randomAnswer()
  store.set(id, { answer, expiresAt: now + TTL_MS })

  const result: CaptchaResult = { id, image: captchaSvg(answer), expiresIn: Math.round(TTL_MS / 1000) }
  if (options.reveal) result.answer = answer
  return result
}

/**
 * 校验并作废。**不管对错都作废** —— 对的那次也删，防止同一张图被重放。
 * 抛出的文案和客户端那版一致，用户看到的还是熟悉的一句话。
 */
export function verifyCaptcha(captchaId: unknown, answer: unknown): void {
  const id = String(captchaId ?? '')
  const entry = store.get(id)
  if (!entry) throw biz('校验码已失效，点图片换一张')

  store.delete(id)

  if (entry.expiresAt < Date.now()) throw biz('校验码过期了，点图片换一张')
  if (String(answer ?? '').trim().toUpperCase() !== entry.answer) {
    throw biz('校验码不对，换一张再试')
  }
}
