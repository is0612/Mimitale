/**
 * 后台页面截图 —— 带登录态。
 *
 * 用法：
 *   node scripts/shot.mjs customers            → shots/admin-customers.png
 *   node scripts/shot.mjs cards shots/cards.png
 *
 * 干的事：
 *   ① 先打真后端拿一个 admin token
 *   ② 用 Chrome headless + CDP 打开后台，把 token 塞进 localStorage
 *   ③ 导航到目标路由，等数据渲染完再截
 *
 * 为什么不用 `chrome --screenshot` 一把梭：那样只能截登录页，
 * 而所有页面都在登录后面 —— 没有 token 注入就只能截个空壳。
 *
 * 前置：django 不管，但要先起 server（8080）和 admin（5173）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SITE = process.env.SHOT_SITE ?? 'http://localhost:5173/admin/'

/**
 * 每次问系统要一个空闲端口。
 *
 * ⚠️ 这里原来写死 9333，踩过一个很阴的坑：上一轮的 Chrome 没退干净时，
 *    新起的 Chrome 绑不上调试端口，**脚本就会连到那个旧实例上** ——
 *    于是截出来的是旧页面、甚至是别的项目，而脚本一路绿灯说「已保存」。
 *    每次换端口，最坏情况是新 Chrome 起不来（报错），不会静默接错人。
 */
function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', fail)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => ok(port))
    })
  })
}

const ROUTE = process.argv[2] ?? 'customers'
const OUT = resolve(process.argv[3] ?? `shots/admin-${ROUTE.replace(/\//g, '-')}.png`)
/**
 * 可选：截图前在页面里跑一段 JS。
 * 用来截「点开某个弹窗之后」的样子 —— 不然只能截到列表页。
 * 例：node scripts/shot.mjs announcements shots/x.png "document.querySelector('.btn-new').click()"
 */
const EXEC = process.argv[4] ?? ''
const PORT = await freePort()
const ORIGIN = new URL(SITE).origin

/* ---------------- ① 拿 token ---------------- */

const res = await fetch(`${ORIGIN}/api/admin/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? 'admin123'
  })
})
const body = await res.json()
if (body.code !== 0) throw new Error(`登录失败：${body.message}（后端起来了吗？）`)
const { token, refreshToken } = body.data

/* ---------------- ② 启 Chrome ---------------- */

const profile = mkdtempSync(join(tmpdir(), 'mimi-shot-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

let wsUrl = null
for (let i = 0; i < 60; i++) {
  try {
    const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    const page = targets.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) {
      wsUrl = page.webSocketDebuggerUrl
      break
    }
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 200))
}
if (!wsUrl) {
  chrome.kill()
  throw new Error('Chrome 没起来，检查 CHROME_PATH')
}

const ws = new WebSocket(wsUrl)
await new Promise((ok, fail) => {
  ws.onopen = ok
  ws.onerror = fail
})

let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  const done = msg.id ? pending.get(msg.id) : null
  if (done) {
    pending.delete(msg.id)
    done(msg)
  }
}

function send(method, params = {}) {
  const id = ++seq
  return new Promise((ok) => {
    pending.set(id, ok)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- ③ 注入登录态并截图 ---------------- */

await send('Page.enable')
await send('Runtime.enable')

// 固定视口 —— 不然截出来的大小跟着系统 DPI 走（1440×900 会变成 754×462）
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false
})

// 先落在同源页面上，localStorage 才有地方写
await send('Page.navigate', { url: SITE })
await wait(2500)
await send('Runtime.evaluate', {
  expression: `
    localStorage.setItem('mimitale_admin_token', ${JSON.stringify(token)});
    localStorage.setItem('mimitale_admin_refresh', ${JSON.stringify(refreshToken)});
    'ok'
  `
})

// ⚠️ 注入 token 之后必须**整页重载**，不能只改 hash。
//    Pinia store 的 token 是在创建时从 localStorage 读的；只改 hash 的话
//    store 里还是空字符串，layout 的 loadMe() 会因为 `if (!token.value) return null`
//    直接返回 —— 结果就是「数据能加载、顶栏却写着未登录」。
await send('Page.navigate', { url: `${SITE}#/${ROUTE}` })
await wait(600)
await send('Page.reload')
await wait(3500)

// 可选动作（截弹窗用）—— 跑完多等一会儿让过渡动画走完
if (EXEC) {
  const r = await send('Runtime.evaluate', { expression: EXEC, awaitPromise: true })
  if (r.result?.exceptionDetails) {
    chrome.kill()
    throw new Error('页面里那段 JS 抛错了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  }
  await wait(1200)
}

// 拍之前对一眼地址：接错浏览器 / 服务被别的项目顶掉时，宁可报错也别交一张错图
const where = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
const href = String(where.result?.result?.value ?? '')
if (!href.startsWith(SITE)) {
  chrome.kill()
  throw new Error(`页面地址不对，截不了：期望以 ${SITE} 开头，实际是 ${href}`)
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
if (!shot.result?.data) {
  chrome.kill()
  throw new Error('截图失败：' + JSON.stringify(shot).slice(0, 200))
}

await writeFile(OUT, Buffer.from(shot.result.data, 'base64'))
console.log(`已保存 → ${OUT}`)

ws.close()
chrome.kill()
