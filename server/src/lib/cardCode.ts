import { randomInt } from 'node:crypto'

/** 去掉了容易看错的 I O 0 1 —— 手抄卡密时不至于抄错 */
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function randCode(len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_CHARS[randomInt(CODE_CHARS.length)]
  return out
}

/** MIMI-7K2M-9QXA */
export function newInviteCode(): string {
  return `MIMI-${randCode(4)}-${randCode(4)}`
}
