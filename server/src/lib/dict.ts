import { prisma } from '../prisma.js'
import type { Tx } from './log.js'

/**
 * 查一个字典值的显示名。
 *
 * 查不到就把原值原样返回 —— 这样即使运营删了某个字典项，
 * 历史日志里存的老值也不会变成空字符串。
 */
export async function dictLabel(typeCode: string, value: string, tx: Tx | typeof prisma = prisma): Promise<string> {
  const item = await tx.dictItem.findFirst({
    where: { typeCode, value },
    select: { label: true }
  })
  return item?.label ?? value
}

/** 这个值在这个字典类型下存在吗（用来挡「发一个不存在的会员等级」） */
export async function dictValueExists(
  typeCode: string,
  value: string,
  tx: Tx | typeof prisma = prisma
): Promise<boolean> {
  const count = await tx.dictItem.count({ where: { typeCode, value } })
  return count > 0
}
