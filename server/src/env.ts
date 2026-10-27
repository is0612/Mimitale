import 'dotenv/config'

/** 读一个整数环境变量，读不出就用默认值 */
function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function str(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

export const env = {
  port: int('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  isProd: process.env.NODE_ENV === 'production',

  jwtSecret: str('JWT_SECRET', 'dev-only-change-me-in-production'),
  adminTokenTtl: int('ADMIN_TOKEN_TTL', 7200),
  clientTokenTtl: int('CLIENT_TOKEN_TTL', 60 * 60 * 24 * 30),

  /** 首次播种时写入的管理员 */
  admin: {
    username: str('ADMIN_USERNAME', 'admin'),
    password: str('ADMIN_PASSWORD', 'admin123'),
    nickname: str('ADMIN_NICKNAME', '星宝')
  },

  smtp: {
    host: str('SMTP_HOST', '127.0.0.1'),
    port: int('SMTP_PORT', 1025),
    secure: process.env.SMTP_SECURE === 'true',
    user: str('SMTP_USER', ''),
    pass: str('SMTP_PASS', '')
  },
  mailFrom: str('MAIL_FROM', 'Mimitale <no-reply@mimitale.local>'),

  /**
   * 把验证码打进服务端日志。
   * 只在没有真实邮件通道时有意义 —— 本地开发时省得开 mailpit。
   * 生产必须为 false（docker-compose 里已经这么设了）。
   */
  devEchoCode: process.env.DEV_ECHO_CODE !== 'false',

  /**
   * 信任反向代理转发来的 X-Forwarded-For。
   *
   * ⚠️ 默认 **false**：不信任就等于用 TCP 层的真实对端地址，客户端伪造
   *    X-Forwarded-For 也没用。所以别为了「让 IP 好看点」随手开 ——
   *    直连公网时开了，任何人都能把自己的 IP 写成任意值。
   * ⚠️ 只有「前面确实有一层 nginx / 云负载均衡」时才设 true，
   *    否则登录记录和操作日志里的 IP 会全是 127.0.0.1。
   */
  trustProxy: process.env.TRUST_PROXY === 'true'
} as const
