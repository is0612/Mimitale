import { ApiCode } from './codes.js'

/**
 * 业务校验错误 —— 「邮箱格式不对」「验证码错了」这类**用户能看懂、能自己纠正**的错。
 *
 * 为什么不直接用 `throw new Error(...)`：那样会被统一的错误处理当成 500
 * （未捕获的服务端故障），前端拿到的是「服务端出错了」而不是真正的原因。
 * 而真正该报 500 的（Prisma 炸了、代码有 bug）也不该和这类混在一起 ——
 * 混在一起之后，日志里全是假的故障，真出事时没人看得出来。
 *
 * 约定：
 *   - BizError → HTTP 200 + `{ code: 1001, message: '中文原因' }`（前端弹 message 即可）
 *   - 其它 Error → HTTP 500 + `{ code: 50000 }`，日志里带堆栈
 */
export class BizError extends Error {
  readonly code: number

  constructor(message: string, code: number = ApiCode.INVALID_PARAM) {
    super(message)
    this.name = 'BizError'
    this.code = code
  }
}

/** 简写：`throw biz('邮箱格式不对')` */
export function biz(message: string, code?: number): BizError {
  return new BizError(message, code)
}
