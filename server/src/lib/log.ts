import type { Prisma } from '../generated/prisma/client.js'
import { prisma } from '../prisma.js'

export type Tx = Prisma.TransactionClient

export interface LogEntry {
  adminId: number
  adminName: string
  action: string
  targetType: string
  targetId: number | null
  targetName: string
  detail: string
  ip?: string
}

/**
 * 写一条操作日志。
 *
 * ⛔ 只有后端能写 —— 没有对应的写接口。日志如果靠前端上报，
 *    它记录的只是「前端愿意上报的那部分」，出事时一文不值。
 *
 * 传 tx 就跟着业务事务一起提交，业务回滚日志也不留。
 */
export async function pushLog(entry: LogEntry, tx: Tx | typeof prisma = prisma): Promise<void> {
  await tx.operationLog.create({
    data: {
      adminId: entry.adminId,
      adminName: entry.adminName,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      targetName: entry.targetName,
      detail: entry.detail,
      ip: entry.ip ?? ''
    }
  })
}

/**
 * 事务 + 日志的常用组合。
 * 业务写库和写日志必须在同一个事务里，否则会出现「额度改了但日志没记」。
 */
export async function withLog<T>(
  entry: LogEntry,
  work: (tx: Tx) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await work(tx)
    await pushLog(entry, tx)
    return result
  })
}
