import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { env } from './env.js'
import { ApiCode } from './lib/codes.js'
import { BizError } from './lib/bizError.js'
import { ok } from './lib/reply.js'
import { adminGuard, clientGuard } from './lib/auth.js'

import { adminAuthPublicRoutes, adminAuthRoutes } from './routes/admin/auth.js'
import { adminCustomerRoutes } from './routes/admin/customers.js'
import { adminLogRoutes } from './routes/admin/logs.js'
import { adminCardRoutes } from './routes/admin/cards.js'
import { adminDictRoutes } from './routes/admin/dicts.js'
import { adminOverviewRoutes } from './routes/admin/overview.js'
import { clientAuthPublicRoutes, clientAuthProtectedRoutes } from './routes/client/auth.js'

const ADMIN = '/api/admin'
const CLIENT = '/api/client'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.isProd
      ? { level: 'info' }
      : { level: 'info', transport: undefined },
    // 客户里的昵称、卡密备注都可能有中文，别被 body 大小坑到
    bodyLimit: 1024 * 1024,
    // ⚠️ 默认关。开了就等于信任请求头里的 X-Forwarded-For，只有前面真有 nginx /
    //    云负载均衡时才该开，否则登录记录的 IP 是别人随手写的。
    trustProxy: env.trustProxy
  })

  // 后台是纯前端（vite dev 5173 / 将来的 nginx），必然跨域
  await app.register(cors, { origin: true })

  await app.register(jwt, { secret: env.jwtSecret })

  /**
   * 允许「带 content-type: application/json 但没有 body」的请求。
   *
   * 不这么做，DELETE / PATCH 这类没有 body 的请求会被 Fastify 直接拒成 400
   * （FST_ERR_CTP_EMPTY_JSON_BODY）—— axios 的 delete()、很多前端的封装都会
   * 默认带上 content-type，于是「删字典项」这种接口在你自己写的脚本里好好的，
   * 一接前端就报错。空 body 当成 undefined，交给各路由自己判断。
   */
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : ''
    // 只有「真空」才放过；坏 JSON 仍然报 400（那是客户端写错了，不该静默吞掉）
    if (raw === '') return done(null, undefined)
    try {
      done(null, JSON.parse(raw))
    } catch (err) {
      // 标记成 400：这是客户端把 JSON 写坏了，不是我们服务端出错。
      // 不标的话统一错误处理会把它当 500，日志里堆满假的故障。
      ;(err as Error & { statusCode?: number }).statusCode = 400
      done(err as Error, undefined)
    }
  })

  /* ---------------- 统一的响应外壳与兜底 ---------------- */

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ code: ApiCode.NOT_FOUND, message: '接口不存在', data: null })
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // 自己抛的业务错：HTTP 200 + code ≠ 0，前端弹 message 就行
    if (error instanceof BizError) {
      return reply.code(200).send({ code: error.code, message: error.message, data: null })
    }

    const status = error.statusCode ?? 500

    // Fastify 自己抛的 4xx（JSON 格式错、body 太大、Schema 不过）
    if (status < 500) {
      request.log.warn({ err: error }, '请求被拒')
      return reply.code(status).send({ code: ApiCode.INVALID_PARAM, message: error.message, data: null })
    }

    // 真的出事了：日志里留堆栈，对外只说一句 —— 别把表和字段名漏出去
    request.log.error({ err: error }, '未捕获的错误')
    return reply.code(500).send({ code: ApiCode.SERVER_ERROR, message: '服务端出错了', data: null })
  })

  /* ---------------- 健康检查 ---------------- */

  app.get('/api/health', async () => ok({ service: 'mimitale-server', time: new Date().toISOString() }))

  /* ---------------- 公开接口 ---------------- */

  // 管理员登录 / 刷新 —— 这两个不能要 token，所以单独一个前缀
  await app.register(adminAuthPublicRoutes, { prefix: `${ADMIN}/auth` })
  // 客户的图形码 / 发码 / 注册两步 / 密码登录 / 凭证登录 / 刷新
  await app.register(clientAuthPublicRoutes, { prefix: `${CLIENT}/auth` })

  /* ---------------- 要管理员 token 的 ---------------- */

  await app.register(async (scope) => {
    scope.addHook('preHandler', adminGuard)

    await scope.register(adminAuthRoutes, { prefix: ADMIN })
    await scope.register(adminCustomerRoutes, { prefix: ADMIN })
    await scope.register(adminLogRoutes, { prefix: ADMIN })
    await scope.register(adminCardRoutes, { prefix: ADMIN })
    await scope.register(adminDictRoutes, { prefix: ADMIN })
    await scope.register(adminOverviewRoutes, { prefix: ADMIN })
  })

  /* ---------------- 要客户 token 的 ---------------- */

  await app.register(async (scope) => {
    scope.addHook('preHandler', clientGuard)
    await scope.register(clientAuthProtectedRoutes, { prefix: `${CLIENT}/auth` })
  })

  return app
}
