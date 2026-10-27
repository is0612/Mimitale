import type { FastifyReply } from 'fastify'
import type { ApiResult } from '@contract'
import { ApiCode } from './codes.js'

/** 成功。data 为 null 也要保留外壳 */
export function ok<T>(data: T): ApiResult<T> {
  return { code: ApiCode.OK, message: 'ok', data }
}

/**
 * 业务失败。HTTP 状态仍然是 200 —— 前端靠 code 判断，
 * 只有「认证失败」才走 401（那条规则见 types/index.ts 顶部约定）。
 */
export function fail<T = null>(code: number, message: string, data: T | null = null): ApiResult<T | null> {
  return { code, message, data }
}

/** 认证失败 —— 唯一会改 HTTP 状态的情况 */
export function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .send({ code: ApiCode.TOKEN_EXPIRED, message: '登录已过期，请重新登录', data: null })
}

export function forbidden(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(403).send({ code, message, data: null })
}
