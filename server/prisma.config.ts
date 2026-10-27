import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

/**
 * Prisma 7 起，连接串不再写在 schema.prisma 里，而是这里。
 * 好处：schema 可以纯声明、不会有密码问题；坏处：多一个文件。
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: {
    url: env('DATABASE_URL')
  }
})
