import type { FastifyRequest } from 'fastify'
import type { Admin } from '../generated/prisma/client.js'
import { prisma } from '../prisma.js'

/**
 * 从已校验的 token 里把管理员捞出来。
 *
 * 为什么不直接把昵称塞进 JWT：日志里要记「当时是谁干的」，
 * 塞进 token 的话管理员改了昵称，旧 token 会继续用旧名字写日志。
 * 多查一次主键，换一个不会错的名字，值得。
 */
export async function currentAdmin(request: FastifyRequest): Promise<Admin> {
  return prisma.admin.findUniqueOrThrow({ where: { id: request.user.sub } })
}

/** 客户的 id 直接从 token 里取（客户侧接口用） */
export function currentCustomerId(request: FastifyRequest): number {
  return request.user.sub
}
