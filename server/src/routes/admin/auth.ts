import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { verifyPassword } from '../../lib/password.js'
import { issueTokens, readRefreshToken } from '../../lib/auth.js'
import { toAdmin } from '../../lib/dto.js'
import { currentAdmin } from '../../lib/whoami.js'

/**
 * 管理员认证 —— 账号 + 密码，**没有注册分支**。
 *
 * ⛔ 客户能自助注册是设计，管理员能自助注册是漏洞。
 *    对不上就是错，绝不会「顺手建个号」。
 *
 * 前缀：/api/admin/auth
 */
export const adminAuthPublicRoutes: FastifyPluginAsync = async (app) => {
  app.post('/login', async (request) => {
    const body = (request.body ?? {}) as { username?: unknown; password?: unknown }
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')

    if (!username || !password) return fail(ApiCode.INVALID_PARAM, '账号和密码都要填')

    const admin = await prisma.admin.findUnique({ where: { username } })
    // 账号不存在 和 密码不对 返回同一个错误码 —— 不给撞库的人做区分
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      return fail(ApiCode.BAD_CREDENTIALS, '账号或密码不对')
    }

    const fresh = await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() }
    })

    return ok({ ...issueTokens(app, 'admin', admin.id), admin: toAdmin(fresh) })
  })

  app.post('/refresh', async (request, reply) => {
    const body = (request.body ?? {}) as { refreshToken?: unknown }
    const who = readRefreshToken(app, body.refreshToken, 'admin')
    if (!who) {
      return reply.code(401).send({ code: ApiCode.TOKEN_EXPIRED, message: '登录已过期，请重新登录', data: null })
    }

    const admin = await prisma.admin.findUnique({ where: { id: who.sub } })
    if (!admin) {
      return reply.code(401).send({ code: ApiCode.TOKEN_EXPIRED, message: '账号已不存在', data: null })
    }

    const { token, expiresIn } = issueTokens(app, 'admin', admin.id)
    return ok({ token, expiresIn })
  })
}

/**
 * 需要 token 的管理接口。前缀 /api/admin（守卫在 app.ts 里挂）
 */
export const adminAuthRoutes: FastifyPluginAsync = async (app) => {
  /** 拿当前管理员，顺便校验 token 还有效 */
  app.get('/auth/me', async (request) => {
    return ok(toAdmin(await currentAdmin(request)))
  })

  /** 登出。JWT 无状态，服务端没什么可清的 —— 前端丢掉 token 即可 */
  app.post('/auth/logout', async () => ok(null))
}
