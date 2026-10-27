import { randomInt } from 'node:crypto'
import { biz } from './bizError.js'

/**
 * 凭证码 —— 换机器 / 重装之后登回来用的那张 24 位码。
 *
 * 云同步不做之后（数据全在本机），这是**唯一**的迁移手段，
 * 客户端还能把它导出成一张 PNG 卡（码写在 `tEXt` 块里）。
 *
 * 安全上它等于一个长期口令，所以：只存服务端、和客户一一对应、
 * 改密码不会重置它（故意的 —— 否则换了密码旧机器就进不来了）。
 */

/** 去掉 0/O/1/I/L —— 这串是要被人手抄的 */
export const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * ⚠️ 别用 `byte % 32` 取字符：这套字符集只有 31 个（去掉了 0/O/1/I/L），
 *    下标 31 会取到 undefined，拼出来就是 `...-NKEu-ndef-ined-...` 这种鬼东西。
 *    randomInt 无偏，顺便把「31 不是 2 的幂」那点模偏差也绕开了。
 */
export function makeVoucher(): string {
  const chars: string[] = []
  // ⚠️ 用 charAt 而不是 `alphabet[idx]` —— 后者在越界时返回 undefined，
  //    拼进去就是字面上的 "undefined"，凭证码直接废掉
  for (let i = 0; i < 24; i += 1) chars.push(VOUCHER_ALPHABET.charAt(randomInt(VOUCHER_ALPHABET.length)))
  return chars.join('').match(/.{4}/g)!.join('-')
}

/** 容忍大小写、空格、少写/多写连字符 —— 手抄过的人都知道 */
export function normalizeVoucher(value: unknown): string {
  const raw = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

  if (!raw) throw biz('先填凭证码')
  if (raw.length !== 24) throw biz('凭证码是 24 位，检查一下有没有抄漏')
  return raw.match(/.{4}/g)!.join('-')
}
