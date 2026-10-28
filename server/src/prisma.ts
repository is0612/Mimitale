import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'

/**
 * 全局单例。
 *
 * 开发时 tsx watch 会反复重载模块 —— 不挂到 globalThis 上，
 * 每次热重载都会新建一个连接池，几十次之后就打满 Postgres 的连接数。
 *
 * Prisma 7 走 driver adapter：不再有 query engine 二进制，
 * 底层就是 node-postgres，进程内存也小一截。
 */
const globalForPrisma = globalThis as unknown as { __mimitalePrisma?: PrismaClient }

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('缺少 DATABASE_URL —— 先把 .env.example 复制成 .env')
  }
  return url
}

export const prisma: PrismaClient =
  globalForPrisma.__mimitalePrisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl() }),
    log: ['warn', 'error']
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.__mimitalePrisma = prisma
