import { randomInt, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
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
 * 服务端直接画 PNG 像素，只依赖 Node 内置 zlib。不能把带答案文本的 SVG 发出去，
 * 否则关闭测试 answer 字段也能从图片源码无损提取答案。
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

// 固定小字库只用于服务端绘制像素；响应里不包含字形编码或答案元数据。
const FONT: Record<string, string> = {
  A:'01110/10001/10001/11111/10001/10001/10001', B:'11110/10001/10001/11110/10001/10001/11110',
  C:'01111/10000/10000/10000/10000/10000/01111', D:'11110/10001/10001/10001/10001/10001/11110',
  E:'11111/10000/10000/11110/10000/10000/11111', F:'11111/10000/10000/11110/10000/10000/10000',
  G:'01111/10000/10000/10111/10001/10001/01110', H:'10001/10001/10001/11111/10001/10001/10001',
  J:'00111/00010/00010/00010/10010/10010/01100', K:'10001/10010/10100/11000/10100/10010/10001',
  M:'10001/11011/10101/10101/10001/10001/10001', N:'10001/11001/10101/10011/10001/10001/10001',
  P:'11110/10001/10001/11110/10000/10000/10000', Q:'01110/10001/10001/10001/10101/10010/01101',
  R:'11110/10001/10001/11110/10100/10010/10001', S:'01111/10000/10000/01110/00001/00001/11110',
  T:'11111/00100/00100/00100/00100/00100/00100', U:'10001/10001/10001/10001/10001/10001/01110',
  V:'10001/10001/10001/10001/10001/01010/00100', W:'10001/10001/10001/10101/10101/10101/01010',
  X:'10001/10001/01010/00100/01010/10001/10001', Y:'10001/10001/01010/00100/00100/00100/00100',
  Z:'11111/00001/00010/00100/01000/10000/11111', 2:'01110/10001/00001/00010/00100/01000/11111',
  3:'11110/00001/00001/01110/00001/00001/11110', 4:'00010/00110/01010/10010/11111/00010/00010',
  5:'11111/10000/10000/11110/00001/00001/11110', 6:'01110/10000/10000/11110/10001/10001/01110',
  7:'11111/00001/00010/00100/01000/01000/01000', 8:'01110/10001/10001/01110/10001/10001/01110',
  9:'01110/10001/10001/01111/00001/00001/01110'
}

function pngChunk(kind: string, data: Buffer): Buffer {
  const type = Buffer.from(kind)
  let crc = 0xffffffff
  for (const byte of Buffer.concat([type, data])) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, type, data, checksum])
}

function captchaPng(answer: string): string {
  const width = 112, height = 40
  // 每行 filter=0，RGB 像素；不写 tEXt/iTXt 等任何可逆答案元数据。
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  const paint = (x: number, y: number, rgb: number[]) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const at = y * (width * 3 + 1) + 1 + x * 3
    pixels[at] = rgb[0]!
    pixels[at + 1] = rgb[1]!
    pixels[at + 2] = rgb[2]!
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) paint(x, y, [29,33,38])
  for (let i = 0; i < 150; i += 1) paint(randomInt(width), randomInt(height), [70,80,88])
  for (let i = 0; i < answer.length; i += 1) {
    const rows = FONT[answer[i]!]!.split('/')
    const left = 9 + i * 26 + randomInt(-2, 3), top = 8 + randomInt(-3, 4)
    const shear = randomInt(-2, 3) / 7
    const color = [[232,228,216],[203,184,143],[169,194,176]][randomInt(3)]!
    for (let y = 0; y < 21; y += 1) for (let x = 0; x < 15; x += 1) {
      if (rows[Math.floor(y / 3)]![Math.floor(x / 3)] === '1') paint(left + x + Math.round(y * shear), top + y, color)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))])
  return 'data:image/png;base64,' + png.toString('base64')
}

export interface CaptchaResult {
  id: string
  /** PNG data URL，直接塞进 <img src> */
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

  const result: CaptchaResult = { id, image: captchaPng(answer), expiresIn: Math.round(TTL_MS / 1000) }
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
