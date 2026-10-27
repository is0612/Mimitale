import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>

const KEY_LEN = 64
const PREFIX = 'scrypt'

/**
 * 用 Node 内置的 scrypt，不引 bcrypt / argon2。
 *
 * 理由：那两个都要编译原生模块，在这台装了火绒的机器上装一次失败一次
 * （admin 那边的 esbuild 就是这么翻车的）。scrypt 是 Node 自带的，
 * 零依赖、零编译，安全性对「几百个客户」这个量级绰绰有余。
 *
 * 存储格式：scrypt$<salt hex>$<hash hex>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_LEN)
  return `${PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, keyHex] = stored.split('$')
  if (algo !== PREFIX || !saltHex || !keyHex) return false

  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(keyHex, 'hex')
  if (expected.length !== KEY_LEN) return false

  const actual = await scrypt(password, salt, KEY_LEN)
  // 定长比较，别用 ===（会按字节提前返回，泄漏前缀信息）
  return timingSafeEqual(actual, expected)
}
