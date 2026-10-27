import { buildApp } from './app.js'
import { env } from './env.js'
import { prisma } from './prisma.js'

const app = await buildApp()

try {
  await app.listen({ port: env.port, host: env.host })
  app.log.info(`Mimitale 账号中心已启动 → http://127.0.0.1:${env.port}/api/health`)
} catch (err) {
  app.log.error(err)
  await prisma.$disconnect()
  process.exit(1)
}

// 关窗口 / docker stop 时把连接断干净，别把 Postgres 的连接数拖到满载
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`收到 ${signal}，正在关闭…`)
    void app.close().finally(async () => {
      await prisma.$disconnect()
      process.exit(0)
    })
  })
}
