/**
 * 客户字段的校验规则 —— 注册和「后台代建客户」共用这一份。
 *
 * ⚠️ 为什么必须共用：后台的「新增客户」是**等价于注册**（星宝 2026-10-28 定的）。
 *    只要有两份校验，迟早会出现「注册不让过的邮箱，后台能建」或者反过来的情况，
 *    然后两个人都以为是对方的 bug。
 *
 * ⚠️ 这里只管**格式**，不管唯一性和业务状态（邮箱是否已存在、是否封禁在路由里判断）。
 */

import { biz } from './bizError.js'

/** 邮箱正则。只做「像不像」的粗筛，真正的可达性靠发验证码 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * 头像上限（base64 字符数）。
 *
 * 客户端压到 256×256 JPEG 后正常是 14KB 图 / 19K 字符，这里留三倍余量就够 ——
 * 原来写的 40 万（约 300KB 原图）等于没设：客户端真压漏了、或者有人直接打接口，
 * 也照样能塞进去。客户端那边有 50K 的预算自适应降质量，别让两边差太远。
 */
export const MAX_AVATAR_CHARS = 60 * 1000

/** 注册送的免费天数 —— 注意这不是「送会员」，等级仍然是 none */
export const TRIAL_DAYS = 30

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 邮箱：转小写 + 长度上限。大小写不敏感是刻意的（没人记得住自己当初怎么大写的） */
export function normalizeEmail(value: unknown): string {
  const email = textOf(value).toLowerCase()
  if (!EMAIL_RE.test(email)) throw biz('邮箱格式不对，检查一下')
  if (email.length > 120) throw biz('邮箱太长了')
  return email
}

/** 用户名：2~20 字，前后空格会去掉（中间的空格保留） */
export function normalizeUsername(value: unknown): string {
  const name = textOf(value)
  if (name.length < 2) throw biz('用户名至少 2 个字')
  if (name.length > 20) throw biz('用户名最多 20 个字')
  return name
}

/** 密码：8~128 位。**不**做复杂度要求 —— 长度比「必须含大写」有用得多 */
export function normalizePassword(value: unknown): string {
  const password = String(value ?? '')
  if (password.length < 8) throw biz('密码至少 8 位')
  if (password.length > 128) throw biz('密码最多 128 位')
  return password
}

/** 头像只收图片 data URL */
export function normalizeAvatar(value: unknown): string {
  const avatar = textOf(value)
  if (!avatar) return ''
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(avatar)) {
    throw biz('头像格式不认识（只收 PNG / JPEG / WebP）')
  }
  if (avatar.length > MAX_AVATAR_CHARS) throw biz('头像太大了，换一张小一点的')
  return avatar
}
