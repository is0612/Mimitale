import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../env.js'
import { ApiCode } from './codes.js'

export interface TokenPayload {
  /** 账号 id（admin.id 或 customer.id，看 kind） */
  sub: number
  /** 两套账号必须分得开 —— 客户 token 绝对不能进管理接口 */
  kind: 'admin' | 'client'
  /** true = 这是 refreshToken，不能当 accessToken 用 */
  ref?: boolean
  /**
   * true = 这是「注册还没走完第二步」的临时令牌。
   * 只能用来调 complete-profile，不能当登录态用。
   * 有了它，complete-profile 就不需要靠自增 accountId 定位账号（那样能枚举别人的号）。
   */
  pending?: boolean
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: TokenPayload
    user: TokenPayload
  }
}

export interface IssuedTokens {
  token: string
  refreshToken: string
  /** accessToken 有效期（秒），前端拿去算什么时候主动刷新 */
  expiresIn: number
}

export function issueTokens(
  app: FastifyInstance,
  kind: 'admin' | 'client',
  sub: number,
  options: { pending?: boolean } = {}
): IssuedTokens {
  const ttl = kind === 'admin' ? env.adminTokenTtl : env.clientTokenTtl

  const token = app.jwt.sign({ sub, kind, pending: options.pending === true }, { expiresIn: ttl })
  // refreshToken 活得更久，但只能用来换 token
  const refreshToken = app.jwt.sign({ sub, kind, ref: true }, { expiresIn: ttl * 12 })

  return { token, refreshToken, expiresIn: ttl }
}

/** 注册第二步用的临时令牌 —— 10 分钟，只认 pending */
export function issuePendingToken(app: FastifyInstance, customerId: number): string {
  return app.jwt.sign({ sub: customerId, kind: 'client', pending: true }, { expiresIn: 600 })
}

function reject(reply: FastifyReply, code: number, message: string): FastifyReply {
  return reply.code(401).send({ code, message, data: null })
}

/** 校验 accessToken，并确认它确实是这个身份 */
async function verify(request: FastifyRequest, reply: FastifyReply, kind: TokenPayload['kind']): Promise<boolean> {
  try {
    await request.jwtVerify()
  } catch {
    reject(reply, ApiCode.TOKEN_EXPIRED, '登录已过期，请重新登录')
    return false
  }

  if (request.user.ref) {
    // refreshToken 混进了业务接口
    reject(reply, ApiCode.UNAUTHORIZED, '这不是登录凭证')
    return false
  }

  if (request.user.pending) {
    // 注册第二步的临时令牌混进了业务接口 —— 它只是一张「允许你设置资料」的票
    reject(reply, ApiCode.UNAUTHORIZED, '注册还没完成')
    return false
  }

  if (request.user.kind !== kind) {
    reject(reply, ApiCode.UNAUTHORIZED, '凭证类型不对')
    return false
  }

  return true
}

/** 管理接口守卫。注册在带认证的子 scope 上当 preHandler */
export async function adminGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await verify(request, reply, 'admin')
}

/** 客户接口守卫 */
export async function clientGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await verify(request, reply, 'client')
}

/** 从 refreshToken 里解出身份；解不出或类型不对就返回 null */
export function readRefreshToken(
  app: FastifyInstance,
  raw: unknown,
  kind: TokenPayload['kind']
): { sub: number } | null {
  const rt = typeof raw === 'string' ? raw.trim() : ''
  if (!rt) return null
  try {
    const payload = app.jwt.verify<TokenPayload>(rt)
    if (!payload.ref || payload.kind !== kind || typeof payload.sub !== 'number') return null
    return { sub: payload.sub }
  } catch {
    return null
  }
}
