/**
 * ============================================================================
 * 内置 mock 后端 —— 【只实现后台侧接口】
 * ============================================================================
 *
 * 这是一个真的 axios adapter —— 不是「拦截器里随便返回点东西」，
 * 而是把请求按 method + path 路由到 handler 上，走的是和真实后端一模一样的流程：
 * 校验参数 → 校验 token → 返回 ApiResult。
 *
 * 想真连后端：把 .env 里的 VITE_USE_MOCK 改成 false。
 *
 * ⚠️ 两个刻意的设计，真实后端要照抄：
 *
 *   ① 后台管理员账号是**预置**的，没有注册入口。
 *      客户能在客户端自助注册，管理员绝对不能自助注册（那是漏洞）。
 *
 *   ② **操作日志只由后端写入，前端没有写入接口。**
 *      封禁 / 发会员 / 生成卡密 / 作废卡密 / 改字典，都在同一个 handler 里
 *      顺手写一条日志。这不是「顺便加的功能」—— 日志如果靠前端上报，
 *      那它记录的就只是「前端愿意上报的部分」，出事时一文不值。
 *
 * 试玩账号：admin / admin123
 */

import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import {
  ApiCode,
  type AdminAccount,
  type AdminLoginReq,
  type AdminRefreshReq,
  type Announcement,
  type AnnouncementListQuery,
  type CardListQuery,
  type CardStatus,
  type CreateAnnouncementReq,
  type CreateCardsReq,
  type CreateCustomerReq,
  type CreateDictItemReq,
  type CreateDictTypeReq,
  type Customer,
  type CustomerDetail,
  type CustomerStatus,
  type ClientSession,
  type DictBundle,
  type DictItem,
  type DictType,
  type Feedback,
  type FeedbackKind,
  type FeedbackListQuery,
  type FeedbackStatus,
  type InviteCard,
  type LogAction,
  type LogListQuery,
  type LoginLog,
  type MembershipLevel,
  type MembershipGrant,
  type OperationLog,
  type UpdateAnnouncementReq,
  type UpdateCardReq,
  type UpdateCustomerReq,
  type UpdateDictItemReq,
  type UpdateFeedbackReq
} from '@/types'

/* ------------------------------------------------------------------ */
/* 管理员（预置，不可注册）                                              */
/* ------------------------------------------------------------------ */

interface MockAdmin extends AdminAccount {
  password: string
}

const admins: MockAdmin[] = [
  {
    id: 1,
    username: 'admin',
    password: 'admin123',
    nickname: '星宝',
    role: 'super',
    lastLoginAt: null
  }
]

/* ------------------------------------------------------------------ */
/* 伪随机工具（固定种子，保证每次刷新看到的都一样）                        */
/* ------------------------------------------------------------------ */

/** 线性同余伪随机 —— 种子一样，数据就一样 */
function makeRng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function randCode(rng: () => number, len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)]
  return out
}

const NOW = Date.parse('2026-10-08T09:00:00+08:00')
const DAY = 86_400_000

/* ------------------------------------------------------------------ */
/* 客户                                                                */
/* ------------------------------------------------------------------ */

const NICK_POOL = [
  '夜航船', '灰羽', '半糖去冰', '雾岛听风', '拾光', '南风',
  '三月初九', '过路人', '纸飞机', '旧巷', '星野', '沉舟',
  '听雪', '折枝', '青柠', '白露', '千叶', '林间',
  '夏至', '一苇', '阿柚', '不系舟', '小满', '故里', '长夜', '晚照'
]

function seedCustomers(): Customer[] {
  const rng = makeRng(20261008)
  // 和字典 ban_reason 的 value 对应（mock 里写死一份，真实后端直接查字典表）
  const BAN_REASON_POOL = ['spam', 'card_resale', 'api_abuse']
  const list: Customer[] = []

  for (let i = 0; i < 26; i++) {
    const daysAgo = Math.floor(rng() * 210) + 1
    const createdAt = NOW - daysAgo * DAY - Math.floor(rng() * DAY)
    const everLogged = rng() > 0.12
    const banned = rng() < 0.12

    // 会员：用下标 i 规律分布（非会员 / 初级 / 中级 / 高级 轮换，生效与过期各半），
    // 不额外消耗 rng —— 免得扰动其它种子字段的既有取值。
    let membershipLevel: MembershipLevel = 'none'
    let membershipExpireAt: string | null = null
    const mem = i % 4
    if (mem !== 0) {
      membershipLevel = (['basic', 'medium', 'premium'] as const)[mem - 1]
      membershipExpireAt =
        i % 2 === 0
          ? new Date(NOW - (3 + (i % 80)) * DAY).toISOString() // 已过期
          : new Date(NOW + (20 + (i % 20)) * DAY).toISOString() // 生效中
    }

    list.push({
      id: i + 1,
      email: `user${String(i + 1).padStart(3, '0')}@example.com`,
      nickname: NICK_POOL[i % NICK_POOL.length],
      // mock 里不放 base64 图 —— 26 条 × 14KB 会把假后端撑得比真后端还慢
      avatar: null,
      status: banned ? 'banned' : 'active',
      banReason: banned ? BAN_REASON_POOL[Math.floor(rng() * BAN_REASON_POOL.length)] : null,
      membershipLevel,
      membershipExpireAt,
      // 注册就送 30 天免费（不是会员，是免费天数）。老号自然过期、新号还在期内
      freeExpireAt: new Date(createdAt + 30 * DAY).toISOString(),
      inviteCode: rng() > 0.55 ? `MIMI-${randCode(rng, 4)}-${randCode(rng, 4)}` : null,
      // 自己的邀请码：一人一个，形状和卡密一样（真实的在 server 里颁发）
      referralCode: `MIMI-${randCode(rng, 4)}-${randCode(rng, 4)}`,
      // 造几条「被某个客户邀请」的关系，详情页的「邀请人」才有东西看
      referredById: null as number | null,
      // 24 位凭证码 = 6 组 4 位，跟 server/src/lib/voucher.ts 的 makeVoucher 同形状
      voucher: [0, 1, 2, 3, 4, 5].map(() => randCode(rng, 4)).join('-'),
      createdAt: new Date(createdAt).toISOString(),
      lastLoginAt: everLogged
        ? new Date(createdAt + Math.floor(rng() * (NOW - createdAt))).toISOString()
        : null
    })
  }

  // 放一个眼熟的客户在最前面，打开页面就有东西看
  list[1] = {
    ...list[1],
    nickname: '露西娅',
    inviteCode: 'MIMI-DEMO-8888',
    membershipLevel: 'basic',
    membershipExpireAt: new Date(NOW + 28 * DAY).toISOString()
  }

  // 邀请关系：让 4 个人是被露西娅拉来的，她的「已邀请」才不是 0。
  // ⚠️ 他们注册时填的是露西娅的邀请码，不是卡密 —— 两种来源只会有一种
  for (const c of list.slice(2, 6)) {
    c.referredById = list[1].id
    c.inviteCode = list[1].referralCode
  }
  return list
}

/* ------------------------------------------------------------------ */
/* 卡密                                                                */
/* ------------------------------------------------------------------ */

function seedCards(list: Customer[]): InviteCard[] {
  const rng = makeRng(20261009)
  const cards: InviteCard[] = []
  const used = new Set<string>()
  let id = 1

  const freshCode = (): string => {
    let code = ''
    do {
      code = `MIMI-${randCode(rng, 4)}-${randCode(rng, 4)}`
    } while (used.has(code))
    used.add(code)
    return code
  }

  // ① 每个「有邀请码」的客户，对应一张已使用的卡 —— 数据要能对得上
  // ⚠️ 被人邀请来的（referredById 有值）不算：他们填的是别人的邀请码，不是卡密
  for (const c of list) {
    if (!c.inviteCode || c.referredById) continue
    used.add(c.inviteCode)
    cards.push({
      id: id++,
      code: c.inviteCode,
      note: rng() > 0.5 ? '种子用户' : '活动赠送',
      days: 30,
      level: 'basic',
      status: 'used',
      usedByCustomerId: c.id,
      usedByEmail: c.email,
      createdAt: new Date(Date.parse(c.createdAt) - (Math.floor(rng() * 3) + 1) * DAY).toISOString(),
      usedAt: c.createdAt,
      expireAt: null
    })
  }

  // ② 一批还没被用掉的
  for (let i = 0; i < 14; i++) {
    const daysAgo = Math.floor(rng() * 60) + 1
    const expireDays = rng() > 0.4 ? 90 + Math.floor(rng() * 180) : null
    const createdAt = NOW - daysAgo * DAY
    cards.push({
      id: id++,
      code: freshCode(),
      note: rng() > 0.6 ? '付费购买' : '内部测试',
      days: [30, 90, 365][Math.floor(rng() * 3)],
      level: 'basic',
      status: 'unused',
      usedByCustomerId: null,
      usedByEmail: null,
      createdAt: new Date(createdAt).toISOString(),
      usedAt: null,
      expireAt: expireDays ? new Date(createdAt + expireDays * DAY).toISOString() : null
    })
  }

  // ③ 几张作废的
  for (let i = 0; i < 3; i++) {
    cards.push({
      id: id++,
      code: freshCode(),
      note: '内部测试',
      days: 30,
      level: 'basic',
      status: 'void',
      usedByCustomerId: null,
      usedByEmail: null,
      createdAt: new Date(NOW - (Math.floor(rng() * 40) + 5) * DAY).toISOString(),
      usedAt: null,
      expireAt: null
    })
  }

  return cards
}

/* ------------------------------------------------------------------ */
/* 字典                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 只放「真字典」。判断标准就一条：
 *    **加一条新数据，需不需要改代码？**
 *
 *    不需要 → 该进字典（封禁原因、客户来源、卡密备注）
 *    需要   → 别放进来（客户状态、卡密状态、管理员角色、日志动作类型）
 *             因为后端有 `if (status === 'banned')`，字典里加个第三态
 *             只会让界面多出一个选得动、但什么都不发生的选项。
 */
interface SeedDict {
  type: DictType
  items: Array<[label: string, value: string, remark: string]>
}

const DICT_SEEDS: SeedDict[] = [
  {
    type: { code: 'ban_reason', name: '封禁原因', remark: '封禁客户时选的原因，用于事后追溯', createdAt: '' },
    items: [
      ['刷屏广告', 'spam', '在角色卡/世界书里夹带广告'],
      ['盗卖卡密', 'card_resale', '把卡密拿到外面倒卖'],
      ['违规调用接口', 'api_abuse', '用脚本高频刷接口'],
      ['冒充他人', 'impersonation', ''],
      ['其他', 'other', '']
    ]
  },
  {
    type: { code: 'customer_source', name: '客户来源', remark: '由「有没有邀请码」推导出来，字典只负责它的显示名', createdAt: '' },
    items: [
      ['邮箱直注', 'email', '没填邀请码，直接邮箱注册'],
      ['邀请码', 'invite', '注册时填了卡密'],
      ['后台导入', 'import', '预留给批量导入，目前没有产生途径']
    ]
  },
  {
    type: { code: 'card_note', name: '卡密备注分类', remark: '生成卡密时选，方便日后按来源统计', createdAt: '' },
    items: [
      ['种子用户', 'seed', '早期免费发的'],
      ['活动赠送', 'promo', ''],
      ['付费购买', 'paid', '第三方平台卖出去的'],
      ['内部测试', 'test', '']
    ]
  },
  {
    type: { code: 'membership_level', name: '会员等级', remark: '客户所属的会员档位；none 是「非会员」哨兵，不进字典', createdAt: '' },
    items: [
      ['初级会员', 'basic', '新用户免费试用 30 天'],
      ['中级会员', 'medium', ''],
      ['高级会员', 'premium', '']
    ]
  }
]

function seedDicts(): DictBundle[] {
  let itemId = 1
  return DICT_SEEDS.map((s) => ({
    type: { ...s.type, createdAt: new Date(NOW - 120 * DAY).toISOString() },
    items: s.items.map(([label, value, remark], idx) => ({
      id: itemId++,
      typeCode: s.type.code,
      label,
      value,
      sort: (idx + 1) * 10,
      enabled: true,
      remark
    }))
  }))
}

/* ------------------------------------------------------------------ */
/* 内存状态                                                            */
/* ------------------------------------------------------------------ */

let customers: Customer[] = seedCustomers()
let cards: InviteCard[] = seedCards(customers)
let dicts: DictBundle[] = seedDicts()

/**
 * 天数流水。真实后端每加一次天数写一条，这里按种子客户补出来：
 * 每人一条「注册赠送 30 天」，会员再过一条「后台发会员」。
 */
let grantSeq = 0
/** 契约里没有 customerId（详情只返回这个人的流水），内存里得留着才能筛 */
type MockGrant = MembershipGrant & { customerId: number }
const grants: MockGrant[] = []
for (const c of customers) {
  if (!c.freeExpireAt) continue
  const start = Date.parse(c.createdAt)
  const end = Date.parse(c.freeExpireAt)
  grants.push({
    id: (grantSeq += 1),
    customerId: c.id,
    days: Math.round((end - start) / DAY),
    source: 'trial',
    note: '注册赠送 30 天免费',
    refId: null,
    startsAt: new Date(start).toISOString(),
    expiresAt: new Date(end).toISOString(),
    createdAt: new Date(start).toISOString()
  })

  if (c.membershipExpireAt) {
    const mEnd = Date.parse(c.membershipExpireAt)
    grants.push({
      id: (grantSeq += 1),
      customerId: c.id,
      days: Math.max(1, Math.round(Math.abs(mEnd - end) / DAY)),
      source: 'admin',
      note: '后台发会员',
      // 假数据里没有真管理员 id，用 1（种子管理员是星宝）
      refId: 1,
      startsAt: new Date(Math.min(end, mEnd)).toISOString(),
      expiresAt: new Date(Math.max(end, mEnd)).toISOString(),
      createdAt: new Date(Math.min(end, mEnd)).toISOString()
    })
  }
}

/** 详情返回时把 customerId 剥掉，形状跟契约对齐 */
function grantsOf(customerId: number): MembershipGrant[] {
  return grants
    .filter((g) => g.customerId === customerId)
    .map(({ customerId: _drop, ...rest }) => rest)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

let logSeq = 0
const logs: OperationLog[] = []

/** 新日志插到最前面（最近的在上） */
function pushLog(e: {
  adminId: number
  adminName: string
  action: LogAction
  targetType: string
  targetId: number | null
  targetName: string
  detail: string
  createdAt?: string
}): OperationLog {
  logSeq += 1
  const log: OperationLog = {
    id: logSeq,
    adminId: e.adminId,
    adminName: e.adminName,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    targetName: e.targetName,
    detail: e.detail,
    ip: '127.0.0.1',
    createdAt: e.createdAt ?? new Date().toISOString()
  }
  logs.unshift(log)
  return log
}

/** 造一批历史日志，让日志页打开就有东西看 */
function seedLogs(): void {
  const rng = makeRng(20261010)
  const me = admins[0]

  type Entry = { at: number; log: Parameters<typeof pushLog>[0] }
  const entries: Entry[] = []
  const add = (at: number, log: Parameters<typeof pushLog>[0]): void => {
    if (at <= NOW) entries.push({ at, log })
  }

  const base = {
    adminId: me.id,
    adminName: me.nickname,
    targetType: 'customer',
    targetId: null as number | null
  }

  // ① 已经存在的封禁客户，补上「当初是谁、为什么封的」
  for (const c of customers) {
    if (c.status !== 'banned' || !c.banReason) continue
    add(Date.parse(c.createdAt) + Math.floor(rng() * 30 + 2) * DAY, {
      ...base,
      action: 'customer.ban',
      targetId: c.id,
      targetName: c.nickname,
      detail: `封禁（${labelOfSeed('ban_reason', c.banReason)}）`
    })
  }

  // ② 生成卡密
  for (const card of cards.filter((c) => c.status === 'unused').slice(0, 6)) {
    add(Date.parse(card.createdAt), {
      adminId: me.id,
      adminName: me.nickname,
      action: 'card.create',
      targetType: 'card',
      targetId: card.id,
      targetName: card.code,
      detail: `生成 1 张卡密（${card.note}）`
    })
  }

  // ③ 作废卡密
  for (const card of cards.filter((c) => c.status === 'void')) {
    add(Date.parse(card.createdAt) + 3 * DAY, {
      adminId: me.id,
      adminName: me.nickname,
      action: 'card.void',
      targetType: 'card',
      targetId: card.id,
      targetName: card.code,
      detail: '作废（长期未被使用）'
    })
  }

  // ④ 给最前面那个「眼熟的客户」补一条，详情页打开就有东西看
  const demo = customers[1]
  if (demo) {
    add(Date.parse(demo.createdAt) + 1 * DAY, {
      ...base,
      action: 'customer.membership',
      targetId: demo.id,
      targetName: demo.nickname,
      detail: '发会员：初级会员 +30 天（新开通）'
    })
  }

  // 按时间正序 push —— pushLog 是 unshift，最终正好是「最近的在上」
  entries
    .sort((a, b) => a.at - b.at)
    .forEach((e) => pushLog({ ...e.log, createdAt: new Date(e.at).toISOString() }))
}

/** 种子阶段用的 label 查找（只在 mock 内部用） */
function labelOfSeed(typeCode: string, value: string): string {
  const t = DICT_SEEDS.find((d) => d.type.code === typeCode)
  return t?.items.find(([, v]) => v === value)?.[0] ?? value
}

seedLogs()

/** adminToken → adminId */
const sessions = new Map<string, number>()
/** adminRefreshToken → adminId */
const refreshSessions = new Map<string, number>()

let tokenSeq = 0

function issueToken(adminId: number): { token: string; refreshToken: string; expiresIn: number } {
  tokenSeq += 1
  const token = `mock-admin-token-${tokenSeq}-${adminId}`
  const refreshToken = `mock-admin-refresh-${tokenSeq}-${adminId}`
  sessions.set(token, adminId)
  refreshSessions.set(refreshToken, adminId)
  return { token, refreshToken, expiresIn: 7200 }
}

/* ------------------------------------------------------------------ */
/* 路由骨架                                                            */
/* ------------------------------------------------------------------ */

interface MockCtx {
  params: Record<string, string>
  query: Record<string, string>
  body: Record<string, unknown>
  headers: Record<string, string>
}

interface MockOutcome {
  code: number
  message?: string
  data?: unknown
  /** 不填 = 200 */
  httpStatus?: number
}

type MockHandler = (ctx: MockCtx) => MockOutcome

function ok(data: unknown): MockOutcome {
  return { code: ApiCode.OK, message: 'ok', data }
}

function fail(code: number, message: string): MockOutcome {
  return { code, message, data: null }
}

function expired(): MockOutcome {
  return {
    code: ApiCode.TOKEN_EXPIRED,
    message: '登录已过期，请重新登录',
    data: null,
    httpStatus: 401
  }
}

function bearerToken(headers: Record<string, string>): string {
  return (headers['authorization'] ?? '').replace(/^Bearer\s+/i, '').trim()
}

function requireAdmin(headers: Record<string, string>): MockAdmin | null {
  const adminId = sessions.get(bearerToken(headers))
  if (!adminId) return null
  return admins.find((a) => a.id === adminId) ?? null
}

/** 去掉密码再往外给 */
function toAdminAccount(admin: MockAdmin): AdminAccount {
  const { id, username, nickname, role, lastLoginAt } = admin
  return { id, username, nickname, role, lastLoginAt }
}

/** 翻页 + 关键词的统一收尾 */
function paginate<T>(list: T[], query: Record<string, string>): { total: number; list: T[] } {
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 10))
  const start = (page - 1) * pageSize
  return { total: list.length, list: list.slice(start, start + pageSize) }
}

/** 本地时区的 YYYY-MM-DD，用来跟 query.from / to 比 */
function localDay(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ------------------------------------------------------------------ */
/* 1~4 · 管理员认证                                                     */
/* ------------------------------------------------------------------ */

/**
 * POST /api/admin/auth/login
 * 账号 + 密码。**没有注册分支** —— 对不上就是错，不会顺手建号。
 */
function handleAdminLogin({ body }: MockCtx): MockOutcome {
  const req = body as unknown as AdminLoginReq
  const username = String(req.username ?? '').trim()
  const password = String(req.password ?? '')

  if (!username || !password) return fail(ApiCode.INVALID_PARAM, '账号和密码都要填')

  const admin = admins.find((a) => a.username === username && a.password === password)
  if (!admin) return fail(ApiCode.BAD_CREDENTIALS, '账号或密码不对')

  admin.lastLoginAt = new Date().toISOString()
  const { token, refreshToken, expiresIn } = issueToken(admin.id)
  return ok({ token, refreshToken, expiresIn, admin: toAdminAccount(admin) })
}

/** POST /api/admin/auth/refresh */
function handleAdminRefresh({ body }: MockCtx): MockOutcome {
  const rt = String((body as unknown as AdminRefreshReq).refreshToken ?? '')
  const adminId = refreshSessions.get(rt)
  if (!adminId) return expired()
  const { token, expiresIn } = issueToken(adminId)
  return ok({ token, expiresIn })
}

/** GET /api/admin/auth/me —— 校验 token 并拿到当前管理员 */
function handleAdminMe({ headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()
  return ok(toAdminAccount(admin))
}

/** POST /api/admin/auth/logout */
function handleAdminLogout({ headers }: MockCtx): MockOutcome {
  sessions.delete(bearerToken(headers))
  return ok(null)
}

/* ------------------------------------------------------------------ */
/* 5~7 · 客户                                                          */
/* ------------------------------------------------------------------ */

/** GET /api/admin/customers —— 分页 + 关键词 + 状态筛选 */
function handleListCustomers({ query, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const keyword = (query.keyword ?? '').trim().toLowerCase()
  const status = (query.status ?? '') as CustomerStatus | ''

  let filtered = customers
  if (keyword) {
    // 邀请码也一起搜 —— 后台常要查「这个码被谁用了」
    filtered = filtered.filter(
      (c) =>
        c.email.toLowerCase().includes(keyword) ||
        c.nickname.toLowerCase().includes(keyword) ||
        (c.inviteCode ?? '').toLowerCase().includes(keyword)
    )
  }
  if (status) filtered = filtered.filter((c) => c.status === status)

  return ok(paginate(filtered, query))
}

/**
 * 造几条活动记录。真后端只记成功的、且从建表那天才开始有 ——
 * 这里连「注册即登录」那次也补上，详情页打开就有东西看。
 */
const MOCK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mimitale/1.0.0 Chrome/126.0.6478.234 Electron/31.3.1 Safari/537.36'

function seedLoginLogs(c: Customer): LoginLog[] {
  const ip = `11${(c.id * 7) % 90 + 10}.${(c.id * 13) % 200 + 20}.${(c.id * 3) % 250 + 1}.${(c.id * 17) % 250 + 1}`
  const rows: LoginLog[] = [
    { id: c.id * 10, method: 'register', ip, userAgent: MOCK_UA, createdAt: c.createdAt }
  ]
  if (c.lastLoginAt) {
    const last = Date.parse(c.lastLoginAt)
    rows.push({ id: c.id * 10 + 1, method: 'password', ip, userAgent: MOCK_UA, createdAt: new Date(last).toISOString() })
    rows.push({
      id: c.id * 10 + 2,
      method: 'voucher',
      ip,
      userAgent: MOCK_UA,
      createdAt: new Date(last - 3 * DAY).toISOString()
    })
  }
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

/** 造几条使用会话，详情页「使用记录」卡打开就有东西看 */
function seedSessions(c: Customer): ClientSession[] {
  const ip = `11${(c.id * 7) % 90 + 10}.${(c.id * 13) % 200 + 20}.${(c.id * 3) % 250 + 1}.${(c.id * 17) % 250 + 1}`
  const rows: ClientSession[] = []
  if (c.lastLoginAt) {
    const last = Date.parse(c.lastLoginAt)
    const start = last - 42 * 60_000 // 42 分钟前开始
    rows.push({
      id: c.id * 100 + 1,
      startedAt: new Date(start).toISOString(),
      lastSeenAt: new Date(start + 40 * 60_000).toISOString(),
      endedAt: new Date(start + 42 * 60_000).toISOString(),
      endReason: 'quit',
      endDetail: '',
      appVersion: '1.0.0',
      ip
    })
    rows.push({
      id: c.id * 100 + 2,
      startedAt: new Date(last - 3 * DAY).toISOString(),
      lastSeenAt: new Date(last - 3 * DAY + 8 * 60_000).toISOString(),
      endedAt: new Date(last - 3 * DAY + 9 * 60_000).toISOString(),
      endReason: 'crash',
      endDetail: 'render-process-gone:oom',
      appVersion: '1.0.0',
      ip
    })
  }
  return rows.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
}

/** GET /api/admin/customers/{id} —— 详情：客户 + 他的卡 + 他的登录与操作记录 */
function handleGetCustomer({ params, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const c = customers.find((x) => x.id === Number(params.id))
  if (!c) return fail(ApiCode.NOT_FOUND, '客户不存在')

  const referrer = c.referredById ? customers.find((x) => x.id === c.referredById) : null
  const detail: CustomerDetail = {
    ...c,
    usedCard: cards.find((card) => card.usedByCustomerId === c.id) ?? null,
    logs: logs.filter((l) => l.targetType === 'customer' && l.targetId === c.id),
    invitedCount: customers.filter((x) => x.referredById === c.id).length,
    referredBy: referrer ? { id: referrer.id, nickname: referrer.nickname, email: referrer.email } : null,
    loginLogs: seedLoginLogs(c),
    grants: grantsOf(c.id),
    sessions: seedSessions(c)
  }
  return ok(detail)
}

/** PATCH /api/admin/customers/{id} —— 封禁 / 解封 / 发会员（每个动作都落一条日志） */
function handleUpdateCustomer({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const target = customers.find((c) => c.id === Number(params.id))
  if (!target) return fail(ApiCode.NOT_FOUND, '客户不存在')

  const req = body as unknown as UpdateCustomerReq

  if (req.status === 'active' || req.status === 'banned') {
    const next = req.status
    if (next !== target.status) {
      target.status = next
      if (next === 'banned') {
        const reason = String(req.banReason ?? '').trim()
        target.banReason = reason || null
        pushLog({
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'customer.ban',
          targetType: 'customer',
          targetId: target.id,
          targetName: target.nickname,
          detail: reason ? `封禁（${dictLabel('ban_reason', reason)}）` : '封禁'
        })
      } else {
        const had = target.banReason
        target.banReason = null
        pushLog({
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'customer.unban',
          targetType: 'customer',
          targetId: target.id,
          targetName: target.nickname,
          detail: had ? `解封（原因为 ${dictLabel('ban_reason', had)}）` : '解封'
        })
      }
    }
  }

  // 发会员：把等级设为传进来的字典值，从「当前到期时间（若还在有效期）或现在」顺延 N 天。
  // 没收费功能，会员全靠这里手动发 —— 客户到期来找你，你就给他续。
  // 等级直接取字典 membership_level 的 value，运营加一档这里自动支持，不用改代码。
  if (req.membershipLevel) {
    const level = String(req.membershipLevel)
    const levelLabel = dictLabel('membership_level', level)
    // dictLabel 查不到就原样返回，所以「label === 原值」= 字典里没这档（含误传 'none'）
    if (level === 'none' || levelLabel === level) {
      return fail(ApiCode.INVALID_PARAM, '这个会员等级不存在')
    }
    const days = Math.floor(Number(req.membershipDays ?? 30))
    if (!Number.isFinite(days) || days <= 0) {
      return fail(ApiCode.INVALID_PARAM, '顺延天数要是正整数')
    }

    const now = Date.now()
    const base = target.membershipExpireAt
      ? Math.max(now, Date.parse(target.membershipExpireAt) || now)
      : now
    const next = base + days * DAY
    const wasNone = target.membershipLevel === 'none'
    target.membershipLevel = level
    target.membershipExpireAt = new Date(next).toISOString()
    grants.push({
      id: (grantSeq += 1),
      customerId: target.id,
      days,
      source: 'admin',
      note: '后台发会员',
      refId: admin.id,
      startsAt: new Date(base).toISOString(),
      expiresAt: new Date(next).toISOString(),
      createdAt: new Date().toISOString()
    })
    pushLog({
      adminId: admin.id,
      adminName: admin.nickname,
      action: 'customer.membership',
      targetType: 'customer',
      targetId: target.id,
      targetName: target.nickname,
      detail: `发会员：${levelLabel} +${days} 天（${wasNone ? '新开通' : '续费'}，到期 ${localDay(
        new Date(next).toISOString()
      )}）`
    })
  }

  return ok(target)
}

/* ------------------------------------------------------------------ */
/* 8 · 操作日志（只读）                                                 */
/* ------------------------------------------------------------------ */

/** GET /api/admin/logs */
function handleListLogs({ query, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const q = query as unknown as LogListQuery
  const action = (q.action ?? '') as LogAction | ''
  const keyword = String(q.keyword ?? '').trim().toLowerCase()
  const from = String(q.from ?? '').trim()
  const to = String(q.to ?? '').trim()

  let filtered = logs
  if (action) filtered = filtered.filter((l) => l.action === action)
  if (keyword) {
    filtered = filtered.filter(
      (l) =>
        l.targetName.toLowerCase().includes(keyword) ||
        l.detail.toLowerCase().includes(keyword) ||
        l.adminName.toLowerCase().includes(keyword)
    )
  }
  if (from) filtered = filtered.filter((l) => localDay(l.createdAt) >= from)
  if (to) filtered = filtered.filter((l) => localDay(l.createdAt) <= to)

  return ok(paginate(filtered, query))
}

/* ------------------------------------------------------------------ */
/* 9~11 · 卡密                                                         */
/* ------------------------------------------------------------------ */

/** GET /api/admin/cards */
function handleListCards({ query, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const q = query as unknown as CardListQuery
  const keyword = String(q.keyword ?? '').trim().toLowerCase()
  const status = (q.status ?? '') as CardStatus | ''

  let filtered = cards
  if (keyword) {
    filtered = filtered.filter(
      (c) =>
        c.code.toLowerCase().includes(keyword) ||
        (c.usedByEmail ?? '').toLowerCase().includes(keyword) ||
        c.note.toLowerCase().includes(keyword)
    )
  }
  if (status) filtered = filtered.filter((c) => c.status === status)

  // 新的在前面
  filtered = [...filtered].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return ok(paginate(filtered, query))
}

/** POST /api/admin/cards —— 批量生成 */
function handleCreateCards({ body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const req = body as unknown as CreateCardsReq
  const count = Math.floor(Number(req.count))
  if (!Number.isFinite(count) || count < 1) return fail(ApiCode.INVALID_PARAM, '生成数量至少 1 张')
  if (count > 100) return fail(ApiCode.INVALID_PARAM, '一次最多生成 100 张')

  const exists = new Set(cards.map((c) => c.code))
  const rng = makeRng(Date.now() % 2147483647)
  const now = Date.now()
  const created: InviteCard[] = []

  for (let i = 0; i < count; i++) {
    let code = ''
    do {
      code = `MIMI-${randCode(rng, 4)}-${randCode(rng, 4)}`
    } while (exists.has(code))
    exists.add(code)

    const card: InviteCard = {
      id: cards.reduce((max, c) => Math.max(max, c.id), 0) + i + 1,
      code,
      note: String(req.note ?? '').trim() || '未分类',
      days: Number(req.days ?? 30),
      level: String(req.level ?? 'basic'),
      status: 'unused',
      usedByCustomerId: null,
      usedByEmail: null,
      createdAt: new Date(now).toISOString(),
      usedAt: null,
      expireAt:
        req.expireDays === null || req.expireDays === undefined
          ? null
          : new Date(now + Math.floor(Number(req.expireDays)) * DAY).toISOString()
    }
    cards.push(card)
    created.push(card)
  }

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'card.create',
    targetType: 'card',
    targetId: created[0]?.id ?? null,
    targetName: count === 1 ? created[0].code : `${count} 张`,
    detail: `生成 ${count} 张卡密（${created[0].note}）${
      req.expireDays ? `，${req.expireDays} 天后过期` : '，永久有效'
    }`
  })

  return ok({ created })
}

/** PATCH /api/admin/cards/{id} —— 目前只用于作废 */
function handleUpdateCard({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const card = cards.find((c) => c.id === Number(params.id))
  if (!card) return fail(ApiCode.NOT_FOUND, '卡密不存在')

  const req = body as unknown as UpdateCardReq
  if (req.status !== 'void') return fail(ApiCode.INVALID_PARAM, '目前只能改成作废')
  if (card.status === 'used') return fail(ApiCode.INVALID_PARAM, '已被使用的卡密不能作废')
  if (card.status === 'void') return fail(ApiCode.INVALID_PARAM, '这张卡密已经是作废状态')

  card.status = 'void'
  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'card.void',
    targetType: 'card',
    targetId: card.id,
    targetName: card.code,
    detail: '手动作废'
  })
  return ok(card)
}

/* ------------------------------------------------------------------ */
/* 12~16 · 字典                                                        */
/* ------------------------------------------------------------------ */

/** 查一个值对应的显示名；查不到就把原值原样返回 */
function dictLabel(typeCode: string, value: string): string {
  const t = dicts.find((d) => d.type.code === typeCode)
  return t?.items.find((i) => i.value === value)?.label ?? value
}

/** GET /api/admin/dicts —— 一次把类型和数据项都拿回来 */
function handleListDicts({ headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()
  return ok(
    dicts.map((d) => ({
      type: d.type,
      items: [...d.items].sort((a, b) => a.sort - b.sort)
    }))
  )
}

/** POST /api/admin/dicts —— 新建一个字典类型 */
function handleCreateDictType({ body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const req = body as unknown as CreateDictTypeReq
  const code = String(req.code ?? '').trim()
  const name = String(req.name ?? '').trim()
  if (!code || !name) return fail(ApiCode.INVALID_PARAM, '编码和名称都要填')
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(code)) {
    return fail(ApiCode.INVALID_PARAM, '编码只能用小写字母、数字和下划线，且以字母开头')
  }
  if (dicts.some((d) => d.type.code === code)) return fail(ApiCode.INVALID_PARAM, '这个编码已经存在')

  const type: DictType = {
    code,
    name,
    remark: String(req.remark ?? '').trim(),
    createdAt: new Date().toISOString()
  }
  dicts.push({ type, items: [] })
  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'dict.create',
    targetType: 'dict',
    targetId: null,
    targetName: `${name}（${code}）`,
    detail: '新建字典类型'
  })
  return ok({ type, items: [] })
}

/** POST /api/admin/dicts/{code}/items —— 新增数据项 */
function handleCreateDictItem({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const bundle = dicts.find((d) => d.type.code === params.code)
  if (!bundle) return fail(ApiCode.NOT_FOUND, '字典类型不存在')

  const req = body as unknown as CreateDictItemReq
  const label = String(req.label ?? '').trim()
  const value = String(req.value ?? '').trim()
  if (!label || !value) return fail(ApiCode.INVALID_PARAM, '标签和值都要填')
  if (bundle.items.some((i) => i.value === value)) return fail(ApiCode.INVALID_PARAM, '这个值已经存在')

  const item: DictItem = {
    id: dicts.reduce((max, d) => Math.max(max, ...d.items.map((i) => i.id), 0), 0) + 1,
    typeCode: bundle.type.code,
    label,
    value,
    sort: Number.isFinite(Number(req.sort)) && req.sort !== undefined ? Math.floor(Number(req.sort)) : 100,
    enabled: true,
    remark: String(req.remark ?? '').trim()
  }
  bundle.items.push(item)
  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'dict.update',
    targetType: 'dict',
    targetId: item.id,
    targetName: `${bundle.type.name} / ${label}`,
    detail: `新增数据项 ${label}（${value}）`
  })
  return ok(item)
}

/** PATCH /api/admin/dicts/items/{id} */
function handleUpdateDictItem({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const id = Number(params.id)
  let bundle: DictBundle | undefined
  let item: DictItem | undefined
  for (const d of dicts) {
    const found = d.items.find((i) => i.id === id)
    if (found) {
      bundle = d
      item = found
      break
    }
  }
  if (!bundle || !item) return fail(ApiCode.NOT_FOUND, '字典项不存在')

  const req = body as unknown as UpdateDictItemReq
  const changes: string[] = []

  if (typeof req.label === 'string' && req.label.trim() && req.label.trim() !== item.label) {
    changes.push(`标签 ${item.label} → ${req.label.trim()}`)
    item.label = req.label.trim()
  }
  if (typeof req.value === 'string' && req.value.trim() && req.value.trim() !== item.value) {
    if (bundle.items.some((i) => i.id !== item!.id && i.value === req.value!.trim())) {
      return fail(ApiCode.INVALID_PARAM, '这个值已经存在')
    }
    changes.push(`值 ${item.value} → ${req.value.trim()}`)
    item.value = req.value.trim()
  }
  if (typeof req.sort === 'number' && req.sort !== item.sort) {
    changes.push(`排序 ${item.sort} → ${req.sort}`)
    item.sort = req.sort
  }
  if (typeof req.enabled === 'boolean' && req.enabled !== item.enabled) {
    changes.push(req.enabled ? '启用' : '停用')
    item.enabled = req.enabled
  }
  if (typeof req.remark === 'string' && req.remark !== item.remark) {
    item.remark = req.remark
    changes.push('改了备注')
  }

  if (changes.length === 0) return ok(item)

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'dict.update',
    targetType: 'dict',
    targetId: item.id,
    targetName: `${bundle.type.name} / ${item.label}`,
    detail: changes.join('；')
  })
  return ok(item)
}

/** DELETE /api/admin/dicts/items/{id} */
function handleDeleteDictItem({ params, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const id = Number(params.id)
  for (const d of dicts) {
    const idx = d.items.findIndex((i) => i.id === id)
    if (idx < 0) continue

    const [removed] = d.items.splice(idx, 1)
    pushLog({
      adminId: admin.id,
      adminName: admin.nickname,
      action: 'dict.delete',
      targetType: 'dict',
      targetId: removed.id,
      targetName: `${d.type.name} / ${removed.label}`,
      detail: `删除数据项 ${removed.label}（${removed.value}）`
    })
    return ok(null)
  }
  return fail(ApiCode.NOT_FOUND, '字典项不存在')
}

/* ------------------------------------------------------------------ */
/* 概览统计（第 17 个接口，原契约之外新增）                              */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/overview
 *
 * ⚠️ mock 里的「今天」钉在种子的 NOW（2026-10-08），不是真实的今天 ——
 *    种子客户的注册时间就是围着 NOW 生成的。所以你在 mock 模式下看到的
 *    「今日新增」是那一天的数字，切到真后端才会跟着真实日期走。
 */
function handleOverview({ headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const dayOf = (iso: string): string => localDay(iso)
  const todayKey = dayOf(new Date(NOW).toISOString())
  const yesterdayKey = dayOf(new Date(NOW - DAY).toISOString())

  const countOn = (day: string): number => customers.filter((c) => dayOf(c.createdAt) === day).length

  const members = customers.filter((c) => c.membershipLevel !== 'none')
  const stillValid = members.filter((c) => c.membershipExpireAt && Date.parse(c.membershipExpireAt) > NOW)
  const freeValid = customers.filter((c) => c.freeExpireAt && Date.parse(c.freeExpireAt) > NOW)
  const freeExpiring = freeValid.filter((c) => Date.parse(c.freeExpireAt ?? '') <= NOW + 7 * DAY)
  // 累计送出去的免费天数（注册 + 邀请），按天算不按人算
  const freeDaysGranted = grants.filter((g) => g.source !== 'admin').reduce((s, g) => s + g.days, 0)
  const expiring = stillValid.filter(
    (c) => c.membershipExpireAt && Date.parse(c.membershipExpireAt) <= NOW + 7 * DAY
  )

  const trend = Array.from({ length: 7 }, (_, i) => {
    const day = dayOf(new Date(NOW - (6 - i) * DAY).toISOString())
    return { day, count: countOn(day) }
  })

  return ok({
    todayRegistered: countOn(todayKey),
    yesterdayRegistered: countOn(yesterdayKey),
    totalCustomers: customers.length,
    bannedCustomers: customers.filter((c) => c.status === 'banned').length,
    activeMembers: stillValid.length,
    memberTotal: members.length,
    expiringIn7Days: expiring.length,
    freeActive: freeValid.length,
    freeExpiring: freeExpiring.length,
    freeDaysGranted,
    todayActive: customers.filter((c) => c.lastLoginAt && dayOf(c.lastLoginAt) === todayKey).length,
    todaySessionUsers: customers.filter((c) => c.lastLoginAt && dayOf(c.lastLoginAt) === todayKey).length,
    avgSessionMinutes: 35,
    unusedCards: cards.filter((c) => c.status === 'unused').length,
    trend,
    recent: [...customers].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5)
  })
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 消息：意见反馈 / 通知公告（2026-10-28）                              */
/* ------------------------------------------------------------------ */

const HOUR = 3600_000

/** 相对现在的 ISO 时间，让 mock 数据看起来是「刚发生」的 */
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * HOUR).toISOString()
}

/**
 * 假反馈数据。
 * ⚠️ mock 只实现**后台侧**接口：这里有「看反馈 / 改状态」，没有「发反馈」——
 *    发反馈是客户端调 /api/client/feedback，后台自带这份假后端管不着。
 */
const feedbacks: Feedback[] = [
  {
    id: 4,
    customerId: customers[2]?.id ?? null,
    contactEmail: customers[2]?.email ?? '',
    contactName: customers[2]?.nickname ?? '',
    kind: 'bug',
    content: '托盘图标在双屏拔掉一个之后就不见了，要重启才回来。',
    appVersion: '1.4.0',
    platform: 'win32',
    status: 'pending',
    note: '',
    handledBy: '',
    handledAt: null,
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(2)
  },
  {
    id: 3,
    customerId: null,
    contactEmail: '',
    contactName: '',
    kind: 'idea',
    content: '希望剧情选项能记住上次选的那批，换一批的时候别整个刷新，思路会断。',
    appVersion: '1.4.2',
    platform: 'win32',
    status: 'pending',
    note: '',
    handledBy: '',
    handledAt: null,
    createdAt: hoursAgo(9),
    updatedAt: hoursAgo(9)
  },
  {
    id: 2,
    customerId: customers[1]?.id ?? null,
    contactEmail: customers[1]?.email ?? '',
    contactName: customers[1]?.nickname ?? '',
    kind: 'other',
    content: '凭证码那张图丢了还能找回账号吗？换过一次电脑，现在只能靠它登回来。',
    appVersion: '1.4.1',
    platform: 'darwin',
    status: 'resolved',
    note: '已经私信教他用手抄码登录了',
    handledBy: '星宝',
    handledAt: hoursAgo(26),
    createdAt: hoursAgo(28),
    updatedAt: hoursAgo(26)
  },
  {
    id: 1,
    customerId: customers[4]?.id ?? null,
    contactEmail: customers[4]?.email ?? '',
    contactName: customers[4]?.nickname ?? '',
    kind: 'bug',
    content: '世界书条目超过 50 条之后，编辑页滚动会卡一秒左右才跟手。',
    appVersion: '1.4.2',
    platform: 'win32',
    status: 'ignored',
    note: '等世界书那块整体重做再看',
    handledBy: '星宝',
    handledAt: hoursAgo(50),
    createdAt: hoursAgo(52),
    updatedAt: hoursAgo(50)
  }
]

const announcements: Announcement[] = [
  {
    id: 2,
    title: 'v1.5 计划：世界书支持按段排序',
    content: '下个版本会给世界书条目加排序和分组。已经建好的书不受影响，排序可以一键恢复默认。',
    level: 'important',
    enabled: true,
    pinned: false,
    startsAt: null,
    endsAt: null,
    authorName: '星宝',
    createdAt: hoursAgo(20),
    updatedAt: hoursAgo(20)
  },
  {
    id: 1,
    title: '欢迎使用 Mimitale',
    content:
      '这是第一条公告。有意见或者遇到 bug，点左下角头像里的「意见反馈」，我们会看。\n换电脑前记得把凭证码那张图存好 —— 它是唯一的迁移手段。',
    level: 'normal',
    enabled: true,
    pinned: true,
    startsAt: null,
    endsAt: null,
    authorName: '星宝',
    createdAt: hoursAgo(96),
    updatedAt: hoursAgo(96)
  }
]

let announcementSeq = 3

/** 和服务端 lib/announcement.ts 的 isLive 同一套判断 */
function announcementLive(a: Announcement): boolean {
  if (!a.enabled) return false
  const now = Date.now()
  if (a.startsAt && Date.parse(a.startsAt) > now) return false
  if (a.endsAt && Date.parse(a.endsAt) < now) return false
  return true
}

/** GET /api/admin/feedbacks */
function handleListFeedbacks({ query, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const q = query as unknown as FeedbackListQuery
  const keyword = String(q.keyword ?? '').trim().toLowerCase()
  const status = (q.status ?? '') as FeedbackStatus | ''
  const kind = (q.kind ?? '') as FeedbackKind | ''

  let filtered = feedbacks
  if (status) filtered = filtered.filter((f) => f.status === status)
  if (kind) filtered = filtered.filter((f) => f.kind === kind)
  if (keyword) {
    filtered = filtered.filter(
      (f) =>
        f.content.toLowerCase().includes(keyword) ||
        f.contactEmail.toLowerCase().includes(keyword) ||
        f.contactName.toLowerCase().includes(keyword)
    )
  }

  filtered = [...filtered].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  // 状态计数是全表口径，不跟筛选走 —— 和真后端一致
  const counts = {
    total: feedbacks.length,
    pending: feedbacks.filter((f) => f.status === 'pending').length,
    read: feedbacks.filter((f) => f.status === 'read').length,
    resolved: feedbacks.filter((f) => f.status === 'resolved').length,
    ignored: feedbacks.filter((f) => f.status === 'ignored').length,
    today: feedbacks.filter((f) => localDay(f.createdAt) === localDay(new Date().toISOString())).length
  }

  return ok({ ...paginate(filtered, query), counts })
}

/** PATCH /api/admin/feedbacks/:id */
function handleUpdateFeedback({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const id = Number(params.id)
  const row = feedbacks.find((f) => f.id === id)
  if (!row) return fail(ApiCode.NOT_FOUND, '这条反馈不存在')

  const req = body as unknown as UpdateFeedbackReq
  const changes: string[] = []

  if (req.status !== undefined) {
    if (!['pending', 'read', 'resolved', 'ignored'].includes(req.status)) {
      return fail(ApiCode.INVALID_PARAM, '状态只能是 pending / read / resolved / ignored')
    }
    if (req.status !== row.status) {
      changes.push(`状态：${row.status} → ${req.status}`)
      row.status = req.status
    }
  }

  if (req.note !== undefined) {
    const note = String(req.note).trim()
    if (note.length > 500) return fail(ApiCode.INVALID_PARAM, '备注最多 500 字')
    if (note !== row.note) {
      row.note = note
      changes.push(note ? '改了备注' : '清了备注')
    }
  }

  if (changes.length === 0) return fail(ApiCode.INVALID_PARAM, '没有要改的内容')

  row.handledBy = admin.nickname
  row.handledAt = new Date().toISOString()
  row.updatedAt = row.handledAt

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'feedback.update',
    targetType: 'feedback',
    targetId: row.id,
    targetName: `#${row.id} ${row.content.slice(0, 12)}`,
    detail: changes.join('；'),
    createdAt: row.handledAt
  })

  return ok({ ...row })
}

/** GET /api/admin/announcements */
function handleListAnnouncements({ query, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const q = query as unknown as AnnouncementListQuery
  const keyword = String(q.keyword ?? '').trim().toLowerCase()
  const enabled = String(q.enabled ?? '')

  let filtered = announcements
  if (enabled === '1') filtered = filtered.filter((a) => a.enabled)
  if (enabled === '0') filtered = filtered.filter((a) => !a.enabled)
  if (keyword) {
    filtered = filtered.filter(
      (a) => a.title.toLowerCase().includes(keyword) || a.content.toLowerCase().includes(keyword)
    )
  }

  // 置顶优先，同组内新的在前
  filtered = [...filtered].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })

  return ok({ ...paginate(filtered, query), liveCount: announcements.filter(announcementLive).length })
}

/** POST /api/admin/announcements */
function handleCreateAnnouncement({ body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const req = body as unknown as CreateAnnouncementReq
  const title = String(req.title ?? '').trim()
  const content = String(req.content ?? '').trim()
  if (!title) return fail(ApiCode.INVALID_PARAM, '标题不能空')
  if (title.length > 60) return fail(ApiCode.INVALID_PARAM, '标题最多 60 字')
  if (!content) return fail(ApiCode.INVALID_PARAM, '正文不能空')

  const startsAt = req.startsAt ?? null
  const endsAt = req.endsAt ?? null
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) {
    return fail(ApiCode.INVALID_PARAM, '失效时间要晚于生效时间')
  }

  const now = new Date().toISOString()
  const row: Announcement = {
    id: announcementSeq++,
    title,
    content,
    level: req.level ?? 'normal',
    enabled: true,
    pinned: req.pinned === true,
    startsAt,
    endsAt,
    authorName: admin.nickname,
    createdAt: now,
    updatedAt: now
  }
  announcements.unshift(row)

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'announcement.create',
    targetType: 'announcement',
    targetId: row.id,
    targetName: row.title,
    detail: `发公告（${row.level}${row.pinned ? '，置顶' : ''}）`,
    createdAt: now
  })

  return ok({ ...row })
}

/** PATCH /api/admin/announcements/:id */
function handleUpdateAnnouncement({ params, body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const id = Number(params.id)
  const row = announcements.find((a) => a.id === id)
  if (!row) return fail(ApiCode.NOT_FOUND, '这条公告不存在')

  const req = body as unknown as UpdateAnnouncementReq
  const changes: string[] = []

  if (req.title !== undefined) {
    const title = String(req.title).trim()
    if (!title) return fail(ApiCode.INVALID_PARAM, '标题不能空')
    if (title !== row.title) {
      row.title = title
      changes.push('改了标题')
    }
  }
  if (req.content !== undefined) {
    const content = String(req.content).trim()
    if (!content) return fail(ApiCode.INVALID_PARAM, '正文不能空')
    if (content !== row.content) {
      row.content = content
      changes.push('改了正文')
    }
  }
  if (req.level !== undefined && req.level !== row.level) {
    row.level = req.level
    changes.push(`级别 → ${req.level}`)
  }
  if (req.enabled !== undefined && req.enabled !== row.enabled) {
    row.enabled = req.enabled
    changes.push(req.enabled ? '上架' : '下架')
  }
  if (req.pinned !== undefined && req.pinned !== row.pinned) {
    row.pinned = req.pinned
    changes.push(req.pinned ? '置顶' : '取消置顶')
  }
  if (req.startsAt !== undefined && req.startsAt !== row.startsAt) {
    row.startsAt = req.startsAt
    changes.push('改了生效时间')
  }
  if (req.endsAt !== undefined && req.endsAt !== row.endsAt) {
    row.endsAt = req.endsAt
    changes.push('改了失效时间')
  }

  if (row.startsAt && row.endsAt && Date.parse(row.startsAt) >= Date.parse(row.endsAt)) {
    return fail(ApiCode.INVALID_PARAM, '失效时间要晚于生效时间')
  }
  if (changes.length === 0) return fail(ApiCode.INVALID_PARAM, '没有要改的内容')

  row.updatedAt = new Date().toISOString()

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'announcement.update',
    targetType: 'announcement',
    targetId: row.id,
    targetName: row.title,
    detail: changes.join('；'),
    createdAt: row.updatedAt
  })

  return ok({ ...row })
}

/** DELETE /api/admin/announcements/:id */
function handleDeleteAnnouncement({ params, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const id = Number(params.id)
  const index = announcements.findIndex((a) => a.id === id)
  if (index < 0) return fail(ApiCode.NOT_FOUND, '这条公告不存在')

  const [row] = announcements.splice(index, 1)
  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'announcement.delete',
    targetType: 'announcement',
    targetId: row.id,
    targetName: row.title,
    detail: '删掉这条公告',
    createdAt: new Date().toISOString()
  })

  return ok(null)
}

/* ------------------------------------------------------------------ */
/* 客户：新增（代建）/ 删除（2026-10-28）                                */
/* ------------------------------------------------------------------ */

/**
 * 真后端发的凭证码是 24 位、4 位一组带连字符（`ABCD-EFGH-...`，全长 29）。
 * mock 照着长一样，免得界面上一眼看出是假的。
 */
function mockVoucher(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const part = (n: number): string => {
    let out = ''
    for (let i = 0; i < n; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
    return out
  }
  return Array.from({ length: 6 }, () => part(4)).join('-')
}

function mockReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const part = (n: number): string => {
    let out = ''
    for (let i = 0; i < n; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
    return out
  }
  return `MIMI-${part(4)}-${part(4)}`
}

/** POST /api/admin/customers —— 代建客户，等价于注册 */
function handleCreateCustomer({ body, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const req = body as unknown as CreateCustomerReq
  const email = String(req.email ?? '').trim().toLowerCase()
  const nickname = String(req.nickname ?? '').trim()
  const password = String(req.password ?? '')

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(ApiCode.INVALID_PARAM, '邮箱格式不对，检查一下')
  if (nickname.length < 2) return fail(ApiCode.INVALID_PARAM, '用户名至少 2 个字')
  if (nickname.length > 20) return fail(ApiCode.INVALID_PARAM, '用户名最多 20 个字')
  if (password.length < 8) return fail(ApiCode.INVALID_PARAM, '密码至少 8 位')
  if (customers.some((c) => c.email.toLowerCase() === email)) {
    return fail(ApiCode.INVALID_PARAM, '这个邮箱已经有账号了')
  }

  const days = req.trialDays === undefined || req.trialDays === null ? 30 : Math.floor(Number(req.trialDays))
  if (!Number.isFinite(days) || days < 0 || days > 3650) {
    return fail(ApiCode.INVALID_PARAM, '赠送天数要在 0 ~ 3650 之间')
  }

  const now = new Date()
  const row: Customer = {
    id: Math.max(0, ...customers.map((c) => c.id)) + 1,
    email,
    nickname,
    avatar: '',
    status: 'active',
    banReason: null,
    membershipLevel: 'none',
    membershipExpireAt: null,
    freeExpireAt: days > 0 ? new Date(now.getTime() + days * DAY).toISOString() : null,
    inviteCode: null,
    referralCode: mockReferralCode(),
    referredById: null,
    voucher: mockVoucher(),
    createdAt: now.toISOString(),
    lastLoginAt: null
  }
  customers.unshift(row)

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'customer.create',
    targetType: 'customer',
    targetId: row.id,
    targetName: row.nickname,
    detail: `代建账号 ${email}${days > 0 ? `，送 ${days} 天试用` : '，不送试用'}`
  })

  return ok({ ...row })
}

/** DELETE /api/admin/customers/:id —— 真删 */
function handleDeleteCustomer({ params, headers }: MockCtx): MockOutcome {
  const admin = requireAdmin(headers)
  if (!admin) return expired()

  const id = Number(params.id)
  const index = customers.findIndex((c) => c.id === id)
  if (index < 0) return fail(ApiCode.NOT_FOUND, '客户不存在')

  const target = customers[index]
  customers.splice(index, 1)
  // 别人的「谁邀请的」指向他要断开 —— 和真后端一个口径
  for (const c of customers) {
    if (c.referredById === id) c.referredById = null
  }
  // 他发过的反馈保留、抹掉身份（mock 里反馈是按 customerId 关联的）
  for (const f of feedbacks) {
    if (f.customerId === id) {
      f.customerId = null
      f.contactEmail = ''
      f.contactName = ''
    }
  }

  pushLog({
    adminId: admin.id,
    adminName: admin.nickname,
    action: 'customer.delete',
    targetType: 'customer',
    targetId: id,
    targetName: `${target.nickname}（${target.email}）`,
    detail: '删除账号：登录记录 / 会员流水 / 已读记录一并清掉'
  })

  return ok(null)
}

const routes: Array<{ method: string; pattern: string; handler: MockHandler }> = [
  { method: 'POST', pattern: '/admin/auth/login', handler: handleAdminLogin },
  { method: 'POST', pattern: '/admin/auth/refresh', handler: handleAdminRefresh },
  { method: 'GET', pattern: '/admin/auth/me', handler: handleAdminMe },
  { method: 'POST', pattern: '/admin/auth/logout', handler: handleAdminLogout },

  { method: 'GET', pattern: '/admin/overview', handler: handleOverview },

  { method: 'GET', pattern: '/admin/customers', handler: handleListCustomers },
  { method: 'POST', pattern: '/admin/customers', handler: handleCreateCustomer },
  { method: 'DELETE', pattern: '/admin/customers/:id', handler: handleDeleteCustomer },
  { method: 'GET', pattern: '/admin/customers/:id', handler: handleGetCustomer },
  { method: 'PATCH', pattern: '/admin/customers/:id', handler: handleUpdateCustomer },

  { method: 'GET', pattern: '/admin/logs', handler: handleListLogs },

  { method: 'GET', pattern: '/admin/feedbacks', handler: handleListFeedbacks },
  { method: 'PATCH', pattern: '/admin/feedbacks/:id', handler: handleUpdateFeedback },

  { method: 'GET', pattern: '/admin/announcements', handler: handleListAnnouncements },
  { method: 'POST', pattern: '/admin/announcements', handler: handleCreateAnnouncement },
  { method: 'PATCH', pattern: '/admin/announcements/:id', handler: handleUpdateAnnouncement },
  { method: 'DELETE', pattern: '/admin/announcements/:id', handler: handleDeleteAnnouncement },

  { method: 'GET', pattern: '/admin/cards', handler: handleListCards },
  { method: 'POST', pattern: '/admin/cards', handler: handleCreateCards },
  { method: 'PATCH', pattern: '/admin/cards/:id', handler: handleUpdateCard },

  { method: 'GET', pattern: '/admin/dicts', handler: handleListDicts },
  { method: 'POST', pattern: '/admin/dicts', handler: handleCreateDictType },
  // 注意：这两条靠段位区分，`items` 是字面量、`:code` 是通配，不会互相吃掉
  { method: 'PATCH', pattern: '/admin/dicts/items/:id', handler: handleUpdateDictItem },
  { method: 'DELETE', pattern: '/admin/dicts/items/:id', handler: handleDeleteDictItem },
  { method: 'POST', pattern: '/admin/dicts/:code/items', handler: handleCreateDictItem }
]

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const a = path.split('/').filter(Boolean)
  if (p.length !== a.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i])
    else if (p[i] !== a[i]) return null
  }
  return params
}

/* ------------------------------------------------------------------ */
/* adapter                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 自定义 adapter 也要遵守 Axios 的 validateStatus，才能触发 401 错误拦截器。 */
function settleResponse(response: AxiosResponse): AxiosResponse {
  const validateStatus = response.config.validateStatus
  if (response.status && validateStatus && !validateStatus(response.status)) {
    throw new AxiosError(
      `Request failed with status code ${response.status}`,
      response.status >= 400 && response.status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE,
      response.config,
      response.request,
      response
    )
  }
  return response
}

export const mockAdapter: AxiosAdapter = async (config) => {
  await sleep(160 + Math.random() * 240)

  const method = (config.method ?? 'get').toUpperCase()

  // ⚠️ 自定义 adapter 得自己把 params 拼成 query string ——
  // 平时这件事是 axios 内置 adapter 做的，绕开它就得自己来，否则筛选条件会全部丢失
  const params = (config.params ?? {}) as Record<string, unknown>
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const queryString = search.toString()

  const url = new URL(
    `${config.baseURL ?? ''}${config.url ?? ''}${queryString ? `?${queryString}` : ''}`,
    'http://mock.local'
  )
  const path = url.pathname.replace(/^\/api/, '') || '/'

  const query: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })

  const headers: Record<string, string> = {}
  const rawHeaders = config.headers as unknown as Record<string, unknown> | undefined
  if (rawHeaders) {
    for (const key of Object.keys(rawHeaders)) {
      const value = rawHeaders[key]
      if (typeof value === 'string') headers[key.toLowerCase()] = value
    }
  }

  let body: Record<string, unknown> = {}
  if (typeof config.data === 'string' && config.data) {
    try {
      body = JSON.parse(config.data) as Record<string, unknown>
    } catch {
      body = {}
    }
  } else if (config.data && typeof config.data === 'object') {
    body = config.data as Record<string, unknown>
  }

  const requestConfig = config as InternalAxiosRequestConfig

  for (const route of routes) {
    if (route.method !== method) continue
    const paramsMatched = matchPath(route.pattern, path)
    if (!paramsMatched) continue

    const outcome = route.handler({ params: paramsMatched, query, body, headers })
    const status = outcome.httpStatus ?? 200
    return settleResponse({
      data: { code: outcome.code, message: outcome.message ?? 'ok', data: outcome.data ?? null },
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: {},
      config: requestConfig
    } as AxiosResponse)
  }

  return settleResponse({
    data: {
      code: ApiCode.NOT_FOUND,
      message: `mock 还没实现这个接口：${method} ${path}`,
      data: null
    },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: requestConfig
  } as AxiosResponse)
}
