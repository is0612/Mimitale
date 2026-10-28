/**
 * ============================================================================
 * 后台侧契约 —— 【本 admin 项目实际调用的全部接口】
 * ============================================================================
 *
 * 认证：Authorization: Bearer <adminToken>
 * baseURL 通常是 /api，所以下面路径都从 /admin 开头。
 *
 * 全部是本后台用的接口，共 16 个，分五组：
 *   1~4   管理员认证（账号密码，**没有注册**）
 *   5~7   客户：列表 / 改 / 详情
 *   8     操作日志（只读）
 *   9~11  卡密：列表 / 批量生成 / 作废
 *   12~16 字典：读全量 / 新建类型 / 增 / 改 / 删
 *
 * 客户自己在客户端怎么登录不在这里 —— 那在 ./client.ts。
 */

/* ------------------------------------------------------------------ */
/* 管理员（登录本后台的人 = 你自己）                                     */
/* ------------------------------------------------------------------ */

export interface AdminAccount {
  id: number
  username: string
  nickname: string
  /** super = 还能管管理员；normal = 只能管客户 */
  role: 'super' | 'normal'
  lastLoginAt: string | null
}

/**
 * 1. POST /api/admin/auth/login
 *    账号 + 密码。**没有注册** —— 管理员账号由部署时初始化写入（或由 super 创建），
 *    绝不允许通过这个接口自助注册。
 */
export interface AdminLoginReq {
  username: string
  password: string
}
export interface AdminLoginRes {
  token: string
  refreshToken: string
  /** token 有效期（秒） */
  expiresIn: number
  admin: AdminAccount
}

/**
 * 2. POST /api/admin/auth/refresh
 *    body: { refreshToken } → { token, expiresIn }
 */
export interface AdminRefreshReq {
  refreshToken: string
}
export interface AdminRefreshRes {
  token: string
  expiresIn: number
}

/* 3. GET  /api/admin/auth/me      → ApiResult<AdminAccount>  启动时校验 token */
/* 4. POST /api/admin/auth/logout  → ApiResult<null>          前端清本地 token  */

/* ------------------------------------------------------------------ */
/* 客户（在 Mimitale 客户端里注册的那些人）                              */
/* ------------------------------------------------------------------ */

/** 客户状态：正常 / 封禁 */
export type CustomerStatus = 'active' | 'banned'

/**
 * 会员等级 —— 字典 `membership_level` 的 value。
 *
 * `'none'` 是「非会员」哨兵，**不进字典**（跟客户状态 active/banned 一个道理，是代码语义）；
 * 其余值（basic / medium / premium …）都来自字典，运营在字典页加一档，发会员的下拉立刻多一档，
 * 不用改代码、不用发版。
 */
export type MembershipLevel = string

/** 一段天数的来源：注册赠送 / 邀请奖励 / 后台发 */
export type GrantSource = 'trial' | 'invite' | 'admin' | 'card'

export interface Customer {
  id: number
  /** 客户在 Mimitale 客户端里注册用的邮箱 */
  email: string
  nickname: string
  /**
   * 头像，`data:image/jpeg;base64,...`（客户端压到 256×256，约 14KB 字符）。
   * 没设头像为 null。⚠️ 列表接口也带它 —— 一页 10 条约 170KB，所以别再调大列表页尺寸，
   * 否则这个接口会变成拖慢后台的那一个。
   */
  avatar: string | null
  status: CustomerStatus
  /** 最近一次被封的原因，值来自字典 ban_reason。解封后清空 */
  banReason: string | null
  /** 会员等级。none = 非会员 */
  membershipLevel: MembershipLevel
  /** 会员到期时间（ISO 8601）。非会员为 null；已过期的会保留历史到期时间 */
  membershipExpireAt: string | null
  /**
   * 免费天数用到哪天（注册送 30 天 + 每邀 1 人 7 天）。
   * ⚠️ 跟 membershipExpireAt **互不吞噬**，实际权益取两者更晚的那个。
   *    这不是会员 —— 等级仍然是 none。
   */
  freeExpireAt: string | null
  /** 注册时填的码（**别人给我的**）：后台发的卡密，或另一个客户的邀请码。直接邮箱注册为 null */
  inviteCode: string | null
  /** **我自己的**邀请码，别人注册时填它。一人一个、能邀多人。null = 老数据，还没补 */
  referralCode: string | null
  /** 邀请我的人是谁（客户 id）。来源是后台卡密时为 null */
  referredById: number | null
  /**
   * 24 位登录凭证码（`XXXX-XXXX-…`）。换机器 / 重装后靠它登回来。
   * 用户可以在客户端里自己刷新，刷新后这里看到的就是新码、旧码立刻失效。
   * 还没生成过（老数据）为 null。
   */
  voucher: string | null
  /** 注册时间 */
  createdAt: string
  /** 最后一次登录客户端的时间；从未登录过为 null */
  lastLoginAt: string | null
}

/**
 * 5. GET /api/admin/customers
 *    分页 + 关键词（邮箱 / 昵称 / 邀请码）+ 状态筛选
 */
export interface CustomerListQuery {
  page: number
  pageSize: number
  /** 模糊匹配邮箱、昵称、邀请码 */
  keyword?: string
  /** 空字符串或不传 = 全部 */
  status?: CustomerStatus | ''
}
export interface CustomerListRes {
  total: number
  list: Customer[]
}

/**
 * 24. POST /api/admin/customers
 *     后台代建一个客户 —— **等价于注册**
 *
 * 建出来的号和客户端自己注册的完全一样：会生成凭证码和邀请码、
 * profileReady = true、默认送 30 天试用，所以也算进「今日注册」。
 * ⚠️ 唯一区别：不发邮件、不验验证码。密码由运营填，交给本人后让他自己改。
 */
export interface CreateCustomerReq {
  email: string
  /** 2~20 字 */
  nickname: string
  /** 8~128 位。不给强度规则，长度比「必须含大写」有用 */
  password: string
  /** 头像（data URL，选填） */
  avatar?: string
  /** 送几天试用，默认 30；填 0 = 不送。上限 3650 */
  trialDays?: number
}

/* 返回创建出来的客户（Customer），**不含密码** */

/**
 * 25. DELETE /api/admin/customers/{id}
 *     真删，**不可恢复**。返回 ApiResult<null>
 *
 * 会一并清掉：登录记录、使用会话、会员流水、公告已读。
 * 他发过的意见反馈**保留正文但抹掉身份**（删号不该顺手销毁用户说过的话，
 * 但联系方式必须清）。用过的卡密不回收，只把「谁用的」置空。
 */

/**
 * 6. PATCH /api/admin/customers/{id}
 *    只传要改的字段
 */
export interface UpdateCustomerReq {
  status?: CustomerStatus
  /** 封禁原因 —— 值来自字典 ban_reason（只有 status 改成 banned 时才有意义） */
  banReason?: string
  /** 发会员 —— 目标等级（目前只有 basic） */
  membershipLevel?: MembershipLevel
  /** 发会员时顺延的天数（正整数，30 = 一个月） */
  membershipDays?: number
}

/**
 * 7. GET /api/admin/customers/{id}
 *    客户详情 = 客户本身 + 他的邀请码来自哪张卡 + 他身上的操作记录
 */
/**
 * 一条客户活动。⚠️ 失败尝试**不记**（量大十倍，而且这块看的是「人从哪来」）
 */
export interface LoginLog {
  id: number
  /** password | voucher | register */
  method: string
  /** 客户端出口 IP。部署在 nginx 后面要开 Fastify 的 trustProxy，否则全是 127.0.0.1 */
  ip: string
  /** Electron 的 UA，带客户端版本号 */
  userAgent: string
  createdAt: string
}

/**
 * 一次「打开软件到关闭」的使用会话。
 * ⚠️ 结束时间靠「下次启动结清」补，可能比真实退出晚一个心跳间隔（5 分钟）。
 */
export interface ClientSession {
  id: number
  startedAt: string
  /** 最后心跳；一次心跳都没赶上就是 null */
  lastSeenAt: string | null
  /** 结束时间；null = 还没结清（还开着） */
  endedAt: string | null
  /** quit | crash | unknown */
  endReason: string | null
  /** crash 时的补充（render-process-gone 的 reason） */
  endDetail: string
  /** 客户端版本号 */
  appVersion: string
  ip: string
}

/**
 * 一次「加天数」。同一个客户可能有好几条 —— 注册送、邀了 3 个人、你后台续过。
 * ⚠️ startsAt / expiresAt 是**这一段天数**的区间，相邻两条首尾相接。
 */
export interface MembershipGrant {
  id: number
  days: number
  /** trial 注册赠送 | invite 邀请奖励 | admin 后台发 | card 卡密兑换 */
  source: GrantSource
  /** 一句话说明，例：「邀请了 小明 +7 天」 */
  note: string
  /** invite 是哪个被邀请人换来的；admin 是哪个管理员发的 */
  refId: number | null
  startsAt: string
  expiresAt: string
  createdAt: string
}

export interface CustomerDetail extends Customer {
  /** 注册时用的那张卡；直接邮箱注册 / 被客户邀请的则为 null */
  usedCard: InviteCard | null
  /** 针对这个客户发生过的操作，最近的在前 */
  logs: OperationLog[]
  /** 他邀请了几个人（对方注册时填的是他的 referralCode） */
  invitedCount: number
  /** 是谁邀请的他；来源是后台卡密或直接邮箱注册则为 null */
  referredBy: { id: number; nickname: string; email: string } | null
  /** 最近 30 条活动记录（登录 / 注册），最近的在前 */
  loginLogs: LoginLog[]
  /** 天数流水，最近的在前。这里能看出「这些天谁给的」 */
  grants: MembershipGrant[]
  /** 最近 30 次使用会话（打开到关闭），最近的在前 */
  sessions: ClientSession[]
}

/* ------------------------------------------------------------------ */
/* 操作日志                                                            */
/* ------------------------------------------------------------------ */

/**
 * 动作类型。
 *
 * ⚠️ 这是**由代码产生的**枚举，不是「真字典」—— 后端每加一种动作就要加一段代码，
 *    所以它**不进字典表**（放进去了也加不出新动作，只会造出一个假旋钮）。
 *    字典只管它的**显示名**，见 src/config/labels.ts 的 LOG_ACTION_LABEL。
 */
export type LogAction =
  | 'customer.ban'
  | 'customer.unban'
  | 'customer.membership'
  // 后台代建 / 删除账号（2026-10-28）—— 删除是唯一一条「对象已经不存在」的日志
  | 'customer.create'
  | 'customer.delete'
  | 'card.create'
  | 'card.void'
  | 'dict.create'
  | 'dict.update'
  | 'dict.delete'
  // 消息（2026-10-28）：反馈只记「改了状态/备注」，公告记增删改
  | 'feedback.update'
  | 'announcement.create'
  | 'announcement.update'
  | 'announcement.delete'

export interface OperationLog {
  id: number
  adminId: number
  adminName: string
  action: LogAction
  /** 被操作对象的类型：customer / card / dict */
  targetType: string
  targetId: number | null
  /** 被操作对象的名字，用于直接阅读（客户昵称 / 卡密 / 字典项） */
  targetName: string
  /** 一句话说清改了什么，例：「发会员：初级会员 +30 天」 */
  detail: string
  ip: string
  createdAt: string
}

/**
 * 8. GET /api/admin/logs
 *    只读。日志**只由后端写入**，前端没有新增/修改/删除日志的接口 —— 这是刻意的。
 */
export interface LogListQuery {
  page: number
  pageSize: number
  /** 空 = 全部动作 */
  action?: LogAction | ''
  /** 模糊匹配 targetName 与 detail */
  keyword?: string
  /** ISO 日期（含当天）。前端传 'YYYY-MM-DD' */
  from?: string
  to?: string
}
export interface LogListRes {
  total: number
  list: OperationLog[]
}

/* ------------------------------------------------------------------ */
/* 卡密 / 激活码                                                        */
/* ------------------------------------------------------------------ */

/** 卡密状态。同样是**代码枚举**，不进字典：后端要靠它判断能不能用 */
export type CardStatus = 'unused' | 'used' | 'void'

export interface InviteCard {
  id: number
  /** 卡密本体，例：MIMI-7K2M-9QXA */
  code: string
  /** 备注，值来自字典 card_note（例：种子用户 / 活动赠送） */
  note: string
  /** 兑换给多少天会员 —— 卡本身就是商品，天数写在卡上 */
  days: number
  /** 会员等级。2026-10-28 起产品上只有一档，恒为 basic（列留着，将来要分档再说） */
  level: string
  status: CardStatus
  /** 被哪个客户用了。unused / void 时为 null */
  usedByCustomerId: number | null
  usedByEmail: string | null
  createdAt: string
  usedAt: string | null
  /** 过期时间；null = 永久有效 */
  expireAt: string | null
}

/**
 * 9. GET /api/admin/cards —— 分页 + 状态筛选 + 关键词（卡密 / 邮箱 / 备注）
 */
export interface CardListQuery {
  page: number
  pageSize: number
  keyword?: string
  status?: CardStatus | ''
}
export interface CardListRes {
  total: number
  list: InviteCard[]
}

/**
 * 10. POST /api/admin/cards —— 批量生成
 *     一次最多 100 张，别在后台手点 1000 次
 */
export interface CreateCardsReq {
  count: number
  /** 兑换给几天会员（1~3650）。不传 = 30 */
  days?: number
  /** **卡本身**的有效天数（没被用掉就作废）；null = 永久有效。注意和 days 不是一回事 */
  expireDays: number | null
  note?: string
}
export interface CreateCardsRes {
  /** 本次生成的卡密，直接回给前端让用户可以复制 */
  created: InviteCard[]
}

/** 11. PATCH /api/admin/cards/{id} —— 目前只用于作废 */
export interface UpdateCardReq {
  status: 'void'
}

/* ------------------------------------------------------------------ */
/* 字典                                                                */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 字典只收「真字典」—— 加了新值**不需要改代码**的那些。
 *
 * 该进字典：封禁原因、客户来源、卡密备注分类
 *           （这些是纯业务数据，运营自己加一个「刷屏」不需要重新部署）
 *
 * 不该进字典：客户状态、卡密状态、管理员角色
 *           （这些值被后端 if 判断引用。塞进字典只会让界面多出一个
 *             "新状态"，看着能加，加了却什么都不生效 —— 假旋钮比没旋钮更糟）
 */
export interface DictType {
  /** 类型编码，建表后不可改。例：ban_reason */
  code: string
  name: string
  remark: string
  createdAt: string
}

export interface DictItem {
  id: number
  typeCode: string
  /** 显示给人看的，例：刷屏 */
  label: string
  /** 存进数据库的，例：spam */
  value: string
  /** 小的排前面 */
  sort: number
  /** 停用后新建的地方选不到，但历史数据照旧显示 */
  enabled: boolean
  remark: string
}

/** 一次把类型和数据项都拿回来 —— 数据量小，没必要拆两个请求 */
export interface DictBundle {
  type: DictType
  items: DictItem[]
}

/** 12. GET /api/admin/dicts → ApiResult<DictBundle[]> */
/** 13. POST /api/admin/dicts —— 新建一个字典类型 */
export interface CreateDictTypeReq {
  code: string
  name: string
  remark?: string
}

/** 14. POST /api/admin/dicts/{code}/items —— 新增数据项 */
export interface CreateDictItemReq {
  label: string
  value: string
  sort?: number
  remark?: string
}

/** 15. PATCH /api/admin/dicts/items/{id} —— 改标签 / 排序 / 启用停用 */
export interface UpdateDictItemReq {
  label?: string
  value?: string
  sort?: number
  enabled?: boolean
  remark?: string
}

/* 16. DELETE /api/admin/dicts/items/{id} → ApiResult<null> */

/* ------------------------------------------------------------------ */
/* 17. 概览统计 —— 原 16 个契约之外新增的（2026-10-27）                    */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/overview
 *
 * 起因是星宝一句「今天有多少个账号注册」。原来的 16 个接口里没有统计，
 * 后台首页也只有客户列表，回答不了这个问题。
 *
 * ⚠️ 所有「今天」都是**北京时间**的今天，不看服务器时区。
 *    Docker 容器默认 UTC，直接按本地时间算会把早上 8 点前的注册算到昨天。
 */
export interface OverviewRes {
  /** 今天（北京时间）注册的客户数 */
  todayRegistered: number
  /** 昨天注册的，用来算「比昨天多/少」 */
  yesterdayRegistered: number
  totalCustomers: number
  bannedCustomers: number
  /** 会员：后台发过、等级不是 none **且** 还没到期。**不含免费天数** */
  activeMembers: number
  /** 发过会员的总数（含已过期）—— activeMembers 和它的差就是「过期待续」 */
  memberTotal: number
  /** 会员 7 天内到期的人数，该催续费的那批 */
  expiringIn7Days: number
  /** 免费天数还没用完的人数 —— 还没转化的盘子 */
  freeActive: number
  /** 免费天数 7 天内到期的人数 —— 最该推付费的那批 */
  freeExpiring: number
  /** 累计送出去多少天免费（注册 + 邀请），按天算不按人算 */
  freeDaysGranted: number
  /** 今天登录过的客户数（不是注册，是登录） */
  todayActive: number
  /** 今天开过软件的人数（去重，按 client_sessions） */
  todaySessionUsers: number
  /** 近 7 天平均单次会话时长（分钟，排除超过 12 小时的挂机幽灵会话） */
  avgSessionMinutes: number
  /** 还没被用掉的卡密 */
  unusedCards: number
  /** 近 7 天每天的注册数。中间没人注册的那天补 0，不连成一条假曲线 */
  trend: Array<{ day: string; count: number }>
  /** 最近 5 个注册的客户 */
  recent: Customer[]
}

/* ------------------------------------------------------------------ */
/* 消息                                                            */
/*                                                                   */
/* 侧边栏「消息」组下两个页面，方向恰好相反：                            */
/*   意见反馈 = 客户端用户发给运营（外部进来的）                        */
/*   通知公告 = 运营发给客户端用户（内部发出去的）                      */
/* 别因为「都是消息」就合并成一张表：状态机、权限、生命周期完全不一样。   */
/* ------------------------------------------------------------------ */

/** 18. GET /api/admin/feedbacks —— 意见反馈列表（分页 + 状态 + 类型 + 关键词） */

/** 反馈类型 —— 和客户端弹窗的三颗按钮一一对应 */
export type FeedbackKind = 'bug' | 'idea' | 'other'

/** 反馈状态 —— 代码枚举（值参与逻辑），不进字典 */
export type FeedbackStatus = 'pending' | 'read' | 'resolved' | 'ignored'

export interface Feedback {
  id: number
  /** 登录状态下提交才有；未登录为 null（不登录也能发，见 schema 注释） */
  customerId: number | null
  /** 提交时带上的联系方式，未登录又没填就是空串 */
  contactEmail: string
  contactName: string
  kind: FeedbackKind
  content: string
  /** 客户端版本号，例 1.4.2 —— 「只有老版本会崩」靠它判断 */
  appVersion: string
  /** win32 / darwin / linux */
  platform: string
  status: FeedbackStatus
  /** 管理员内部备注，**不回传给客户端**（客户端没有收回复的地方） */
  note: string
  handledBy: string
  handledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface FeedbackListQuery {
  page?: number
  pageSize?: number
  status?: FeedbackStatus | ''
  kind?: FeedbackKind | ''
  /** 模糊匹配正文 / 邮箱 / 昵称 */
  keyword?: string
}

/** 各状态有多少条 —— 给顶部那几个「待处理 3」的数字用 */
export interface FeedbackCounts {
  total: number
  pending: number
  read: number
  resolved: number
  ignored: number
  /** 今天（北京时间）收到的，和概览页「今日注册」同一套时区口径 */
  today: number
}

export interface FeedbackListRes {
  total: number
  list: Feedback[]
  /** 各状态的总数。**全表口径** —— 不跟着当前筛选和分页变，
   *  否则「待处理 3」会变成「当前筛选下待处理 3」，数字就没意义了 */
  counts: FeedbackCounts
}

/** 19. PATCH /api/admin/feedbacks/{id} —— 改状态 / 写内部备注 */
export interface UpdateFeedbackReq {
  status?: FeedbackStatus
  note?: string
}

/** 20. GET /api/admin/announcements —— 公告列表 */
export type AnnouncementLevel = 'normal' | 'important' | 'maintenance'

export interface Announcement {
  id: number
  title: string
  content: string
  level: AnnouncementLevel
  /** 下架开关，false = 客户端拉不到 */
  enabled: boolean
  /** 置顶：客户端横条优先显示置顶的 */
  pinned: boolean
  /** 生效时间，null = 立刻生效 */
  startsAt: string | null
  /** 失效时间，null = 永不失效 */
  endsAt: string | null
  authorName: string
  createdAt: string
  updatedAt: string
}

export interface AnnouncementListQuery {
  page?: number
  pageSize?: number
  /** 不传 = 全部；'1' 只在架、'0' 只看下架的 */
  enabled?: '' | '1' | '0'
  keyword?: string
}

export interface AnnouncementListRes {
  total: number
  list: Announcement[]
  /** 此刻真正能显示在客户端上的条数（在架 + 在有效期内） */
  liveCount: number
}

/** 21. POST /api/admin/announcements —— 发一条新公告 */
export interface CreateAnnouncementReq {
  title: string
  content: string
  level?: AnnouncementLevel
  pinned?: boolean
  startsAt?: string | null
  endsAt?: string | null
}

/** 22. PATCH /api/admin/announcements/{id} —— 改内容 / 上下架 / 置顶 */
export interface UpdateAnnouncementReq {
  title?: string
  content?: string
  level?: AnnouncementLevel
  enabled?: boolean
  pinned?: boolean
  startsAt?: string | null
  endsAt?: string | null
}

/* 23. DELETE /api/admin/announcements/{id} → ApiResult<null>
 *     真删。公告没有审计价值（操作日志里已经留了「谁在什么时候发了什么」） */
