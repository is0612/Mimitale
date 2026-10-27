import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../env.js'

let transporter: Transporter | null = null

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      // 没有用户名就是匿名投递（mailpit 就是这样收信的）
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
      // 本地 mailpit 不带证书，别卡在这上面
      tls: { rejectUnauthorized: false },
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000
    })
  }
  return transporter
}

function html(code: string, minutes: number): string {
  return `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f5f5f4;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif">
  <table role="presentation" style="max-width:420px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e7e5e4">
    <tr><td style="padding:28px 28px 8px">
      <div style="font-size:15px;font-weight:600;color:#1c1917">Mimitale 登录验证码</div>
      <div style="margin-top:6px;font-size:13px;color:#78716c;line-height:1.6">在客户端输入下面这串数字完成登录。不是你本人在操作就直接忽略这封信。</div>
    </td></tr>
    <tr><td style="padding:8px 28px 4px">
      <div style="font-family:ui-monospace,Consolas,monospace;font-size:32px;letter-spacing:8px;color:#b45309;font-weight:600">${code}</div>
    </td></tr>
    <tr><td style="padding:4px 28px 28px">
      <div style="font-size:12px;color:#a8a29e">${minutes} 分钟内有效，只能用一次。</div>
    </td></tr>
  </table>
</body></html>`
}

/**
 * 发验证码。返回 false 表示没发出去（SMTP 挂了 / 配置错了）。
 *
 * 注意：调用方**不应该**因为发送失败就 500 —— 换成业务错误码 1004，
 * 让客户端能提示「验证码没发出去，稍后再试」而不是白屏。
 */
export async function sendLoginCode(to: string, code: string, minutes: number): Promise<boolean> {
  try {
    await getTransporter().sendMail({
      from: env.mailFrom,
      to,
      subject: `Mimitale 登录验证码：${code}`,
      text: `你的验证码是 ${code}，${minutes} 分钟内有效，只能用一次。\n不是你本人在操作就忽略这封信。`,
      html: html(code, minutes)
    })
    return true
  } catch (err) {
    console.error('[mail] 验证码发送失败 →', to, (err as Error).message)
    return false
  }
}
