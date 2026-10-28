/**
 * 一条命令把账号后端拉起来 —— 每天开机后用这个。
 *
 *   npm run dev
 *
 * 做四件事，每一步都是幂等的（跑一百次结果一样）：
 *   ① docker compose up -d db mail   数据库和本地收信服务器，已经在跑就跳过
 *   ② 等 Postgres 真的能连上          （容器起来 ≠ 能接受连接，通常差 2~3 秒）
 *   ③ prisma migrate deploy          库结构升级
 *   ④ seed + 启动服务（带热重载）      管理员/字典缺哪补哪，示范数据只在空库时造
 *
 * 想只起服务（数据库已经在跑）就用 `npm run dev:app`，
 * 容器整个不要了就 `npm run db:down`（数据在 volume 里，不会丢）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// 这个脚本自己要用 DATABASE_URL 探活，所以得先把 .env 读进来
// （服务进程那边由 src/env.ts 自己 import 'dotenv/config'）
import 'dotenv/config'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRISMA = resolve(ROOT, 'node_modules/prisma/build/index.js')

function run(cmd, args, options = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...options })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} 退出码 ${code}`))))
  })
}

function step(n, text) {
  console.log(`\n\x1b[2m[${n}/4]\x1b[0m ${text}`)
}

/* ---------------- ① 容器 ---------------- */

if (!existsSync(resolve(ROOT, 'node_modules'))) {
  console.error('\n还没装依赖 —— 先跑一次 `npm install`\n')
  process.exit(1)
}

step(1, '起数据库和本地收信服务器（docker）')

// ⚠️ 有的机器（这台就是）只装了独立的 docker-compose.exe：Docker CLI 认不到那份
//    cli-plugins，`docker compose` 直接报 unknown command。先问谁在，再决定用哪条 ——
//    别拿 up 的失败当探测，那会把「镜像拉不下来」也误判成「没有 compose」。
async function pickCompose() {
  for (const candidate of [{ cmd: 'docker', base: ['compose'] }, { cmd: 'docker-compose', base: [] }]) {
    try {
      await run(candidate.cmd, [...candidate.base, 'version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // 换下一个
    }
  }
  return null
}

{
  const compose = await pickCompose()
  if (!compose) {
    console.error('\n找不到 docker compose。先打开 Docker Desktop，等它显示 Running 再试。\n')
    process.exit(1)
  }
  try {
    await run(compose.cmd, [...compose.base, 'up', '-d', 'db', 'mail'])
  } catch {
    console.error('\n容器没起来。`docker compose logs db` 看看容器怎么了。\n')
    process.exit(1)
  }
}

/* ---------------- ② 等数据库接受连接 ---------------- */

step(2, '等 Postgres 就绪')
{
  // 用 pg 直连探活比 `docker exec pg_isready` 稳 —— 后者在容器刚起时会假报 ready
  const { default: pg } = await import('pg')
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('  缺少 DATABASE_URL —— 把 .env.example 复制成 .env')
    process.exit(1)
  }

  let ready = false
  for (let i = 0; i < 30; i += 1) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      await client.query('SELECT 1')
      await client.end()
      ready = true
      break
    } catch {
      await client.end().catch(() => {})
      await sleep(600)
    }
  }

  if (!ready) {
    console.error('  连不上数据库。`docker compose logs db` 看看容器怎么了。')
    process.exit(1)
  }
  console.log('  连上了')
}

/* ---------------- ③ 迁移 + 重新生成客户端 ---------------- */

step(3, '同步库结构并重新生成客户端')
await run(process.execPath, [PRISMA, 'migrate', 'deploy'])

// ⚠️ 这一步不能省：schema 加了模型/字段而 client 没重新生成时，
//    代码里 `prisma.新模型` 会是 undefined，报的是
//    「Cannot read properties of undefined (reading 'groupBy')」这种看不懂的错。
await run(process.execPath, [PRISMA, 'generate'])

/* ---------------- ④ 播种 + 启动 ---------------- */

step(4, '播种并启动服务')
await run(process.execPath, [resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'prisma/seed.ts'])

console.log('\n\x1b[36m启动服务 —— 改代码会自动重启，Ctrl+C 停\x1b[0m\n')

// 用 --import tsx 而不是 `tsx watch`：后者在没有 TTY 的环境里起不来
const app = spawn(process.execPath, ['--import', 'tsx', '--watch', 'src/index.ts'], {
  cwd: ROOT,
  stdio: 'inherit'
})

const stop = () => {
  app.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
