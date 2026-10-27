/**
 * 业务错误码。
 *
 * ⚠️ 这份值是从 admin/src/types/index.ts 的 ApiCode **复制**过来的，不是 import。
 *    原因：那是另一个 npm 项目里的 TS 文件，运行时不能跨项目加载
 *    （类型可以 `import type` 过来，值是擦除掉的）。
 *
 *    改这里的数字 = 改前后端契约。任何后端语言都得复制这一份，
 *    所以接 Java 也好 Node 也好，这个文件就是「错误码真源」的镜像。
 */
export const ApiCode = {
  OK: 0,

  INVALID_PARAM: 1001,
  /** 验证码错误或已过期（客户侧） */
  CODE_INVALID: 1002,
  /** 发送太频繁（同邮箱 60 秒一次） */
  TOO_FREQUENT: 1003,
  /** 邮件发不出去 */
  EMAIL_SEND_FAILED: 1004,
  /** 管理员账号或密码不对 */
  BAD_CREDENTIALS: 1005,

  /** 未登录 / 没带 token */
  UNAUTHORIZED: 40100,
  /** token 过期 */
  TOKEN_EXPIRED: 40101,

  /** 该客户已被封禁 */
  ACCOUNT_BANNED: 40300,
  /** 不是管理员 */
  NOT_ADMIN: 40301,

  NOT_FOUND: 40400,
  SERVER_ERROR: 50000
} as const

export type ApiCodeValue = (typeof ApiCode)[keyof typeof ApiCode]
