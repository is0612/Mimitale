/**
 * ============================================================================
 * 客户侧契约 —— 【Mimitale 客户端调的，本后台一行都不用】
 * ============================================================================
 *
 * 放在这里的目的：给后端当参考，也给将来改客户端的人一份「接口长什么样」。
 *
 * ⚠️ 2026-10-27 重写：原来这里只有 5 个接口（发验证码 / 登录即注册 / 刷新 / me / 登出），
 *    照着 `登录体系决策记录.md` 决策 3 的「纯邮箱验证码」写的。
 *    但客户端界面（2026-10-23 做的）走的是**邮箱 + 密码 + 图形码 + 24 位凭证码 + 两步注册**，
 *    两边叉开了。**以客户端为准** —— 现在这里 12 个接口，形状对齐
 *    `client/main/account.js` 那 12 个 IPC 通道，一一对应，不多不少。
 *
 * 和后台侧（./admin.ts）的关键区别：
 *   - 客户能自助注册（这是设计），管理员不能（那是漏洞）
 *   - 客户侧返回的 `ClientUser` 和后台的 `Customer` **是两个形状**，别想着统一：
 *     后台要看会员/封禁原因/卡密，客户端只关心「我是谁、我叫什么、我的头像、我的会员」
 *
 * 统一约定见 ./index.ts：`{ code, message, data }`，`code === 0` 成功，
 * 认证走 `Authorization: Bearer <token>`，认证失败才返回 HTTP 401。
 */

/* ------------------------------------------------------------------ */
/* 客户端看到的「我」                                                   */
/* ------------------------------------------------------------------ */

/**
 * 会员状态。
 *
 * ⚠️ 「有没有过期」由服务端算好给 `active`，客户端**不要**自己拿 expireAt 和本地时钟比 ——
 *    用户改系统时间就能把过期会员变成会员。判定口径在 `server/src/routes/client/auth.ts`。
 */
export interface ClientMembership {
  /** 会员等级：none = 非会员（哨兵值，不在字典里）| basic | medium | premium */
  level: string
  /** 等级显示名，来自字典；非会员固定「非会员」 */
  name: string
  /** 还能用（免费天数或会员任一未过期） */
  active: boolean
  /** 免费天数还剩几天（注册 + 邀请）。没送过 / 已用完 = null */
  freeDaysLeft: number | null
  /** 免费天数用到哪天 */
  freeExpireAt: string | null
  /** 会员还剩几天（后台发的）。没有 / 已过期 = null */
  memberDaysLeft: number | null
  /** 会员用到哪天 */
  memberExpireAt: string | null
  /** 权益真正到哪天 = 两个里更晚的那个 */
  until: string | null
}

/**
 * ⚠️ 跟 `./admin.ts` 的 `Customer` **不是同一个东西**。
 * - `id` 是字符串（客户端从第一天就用 UUID，渲染层可能拿它做字符串比较）
 * - `username` 在服务端那一列叫 `nickname`（后台列表显示成「昵称」），**同一列**
 * - 会员只给「够显示」的四个字段，不给封禁原因和内部分级依据
 */
export interface ClientUser {
  id: string
  email: string
  /** 注册第二步填的「用户名」 */
  username: string
  /** data:image/...;base64，空字符串 = 没设头像 */
  avatar: string
  createdAt: string
  /** 有没有走完注册第二步。false = 建了号但没设资料，不算注册成功 */
  profileReady: boolean
  membership: ClientMembership
  /**
   * **我自己的**邀请码（`MIMI-XXXX-XXXX`），发给别人、对方注册时填。
   * 一人一个、能邀多人。空字符串 = 还没生成（老数据，服务端会在 /me 里补上）
   */
  inviteCode: string
  /** 我邀请了几个人（他们注册时填了我的码）。只统计走完注册第二步的 */
  invitedCount: number
  /** 邀请已经给我挣到多少天免费（= invitedCount × 每人天数）。服务端算，客户端别写死 7 */
  freeDaysFromInvite: number
}

/* ------------------------------------------------------------------ */
/* 1. POST /api/client/auth/captcha —— 图形校验码                        */
/* ------------------------------------------------------------------ */

/**
 * 为什么客户端也要图形码：`/code` 会真发一封邮件，没有这道闸，
 * 任何人写个循环就能把别人邮箱塞满、把 SMTP 额度刷爆。
 *
 * 一次性的：用过就废（对的那次也废），错了也要换一张。
 */
export interface CaptchaRes {
  id: string
  /** data:image/svg+xml;... 直接塞进 <img src> */
  image: string
  /** 有效期（秒），5 分钟 */
  expiresIn: number
  /** ⚠️ 只有服务端 DEV_ECHO_CODE=true（本地开发）才返回，给自动化测试用 */
  answer?: string
}

/* ------------------------------------------------------------------ */
/* 2. POST /api/client/auth/code —— 发邮箱验证码                        */
/* ------------------------------------------------------------------ */

export interface SendCodeReq {
  email: string
  captchaId: string
  captchaAnswer: string
}

export interface SendCodeRes {
  email: string
  /** 有效期（秒），10 分钟 */
  expiresIn: number
  /**
   * `email` = 真发出去了；`dev` = 开发模式，码在下面 `devCode` 里
   * （界面上那句「演示模式：验证码是 123456」就是靠这个）
   */
  deliver: 'email' | 'dev'
  /** 只有 deliver === 'dev' 才有 */
  devCode?: string
}

/* ------------------------------------------------------------------ */
/* 3. POST /api/client/auth/register —— 注册第一步                      */
/* ------------------------------------------------------------------ */

export interface RegisterReq {
  email: string
  code: string
}

export interface RegisterRes {
  /** 仅用于展示/排查，**别拿它当凭据** —— 自增 id 能被枚举 */
  accountId: string
  email: string
  /** 恒为 true：还差用户名/密码/头像 */
  needsProfile: boolean
  /**
   * 注册第二步的临时令牌（10 分钟）。
   * ⚠️ 第二步靠它定位账号，不靠 accountId —— 否则谁都能给别人的号设资料。
   *    它**只能**用来调 complete-profile，当不了登录态。
   */
  pendingToken: string
}

/* ------------------------------------------------------------------ */
/* 4. POST /api/client/auth/complete-profile —— 注册第二步              */
/* ------------------------------------------------------------------ */

/** 认证用第 3 步拿到的 pendingToken */
export interface CompleteProfileReq {
  username: string
  password: string
  /** 可空字符串 */
  avatar?: string
}

/* ------------------------------------------------------------------ */
/* 5. POST /api/client/auth/login —— 邮箱 + 密码 + 图形码                */
/* ------------------------------------------------------------------ */

export interface ClientLoginReq {
  email: string
  password: string
  captchaId: string
  captchaAnswer: string
}

/**
 * 登录 / 注册第二步 / 凭证登录，**成功时都是这个形状**。
 *
 * 客户端只把 `token` / `refreshToken` / `user` 存本地，
 * 密码、凭证码、验证码一个字都不落盘。
 */
export interface ClientSessionRes {
  user: ClientUser
  token: string
  refreshToken: string
  /** accessToken 有效期（秒） */
  expiresIn: number
}

/* ------------------------------------------------------------------ */
/* 6. POST /api/client/auth/voucher-login —— 凭证码登录                 */
/* ------------------------------------------------------------------ */

export interface VoucherLoginReq {
  /** 24 位，容忍大小写 / 空格 / 少连字符 */
  voucher: string
}

/* ------------------------------------------------------------------ */
/* 7. POST /api/client/auth/refresh                                    */
/* ------------------------------------------------------------------ */

export interface ClientRefreshReq {
  refreshToken: string
}
export interface ClientRefreshRes {
  token: string
  expiresIn: number
}

/* ------------------------------------------------------------------ */
/* 8. GET /api/client/auth/me —— 会话                                  */
/* ------------------------------------------------------------------ */

/** → `{ user: ClientUser }`。客户端首屏靠它判断登没登录 */

/* ------------------------------------------------------------------ */
/* 10. GET /api/client/auth/voucher —— 取凭证（画那张 PNG 卡用）          */
/* ------------------------------------------------------------------ */

export interface VoucherRes {
  /** XXXX-XXXX-XXXX-XXXX-XXXX-XXXX */
  code: string
  username: string
  email: string
  avatar: string
  createdAt: string
  version: number
}

/* ------------------------------------------------------------------ */
/* 11. PATCH /api/client/auth/profile —— 改资料                        */
/* ------------------------------------------------------------------ */

export interface UpdateProfileReq {
  username?: string
  /** 只收 data:image/(png|jpeg|webp);base64，别传外链 */
  avatar?: string
}

/* ------------------------------------------------------------------ */
/* 12. POST /api/client/auth/password —— 改密码                        */
/* ------------------------------------------------------------------ */

/**
 * 必须给当前密码 —— 防「人走了没锁屏，回来密码被换了」。
 * 改完**不踢会话**：自己改的密码，没必要让自己重新登一遍。
 */
export interface ChangePasswordReq {
  currentPassword: string
  password: string
}

/* ------------------------------------------------------------------ */
/* 13. POST /api/client/auth/email —— 改邮箱                           */
/* ------------------------------------------------------------------ */

/** 验证码发到**新邮箱**上（走的是 2 号接口，同样要过图形码） */
export interface ChangeEmailReq {
  email: string
  code: string
}

/* 9. POST /api/client/auth/logout  → ApiResult<{ user: null }>        */

/* ------------------------------------------------------------------ */
/* 消息（2026-10-28）—— 客户端这一侧的收发两端                          */
/*                                                                   */
/* 和登录那 13 个接口不是一回事：那组要客户 token，这组里「发反馈」故意 */
/* **不要求登录**（连登录都进不去的时候才最需要报错）。                 */
/* ------------------------------------------------------------------ */

/** 14. POST /api/client/feedback —— 发一条意见反馈 */
export interface SubmitFeedbackReq {
  /** 和客户端弹窗那三颗按钮一一对应 */
  kind: 'bug' | 'idea' | 'other'
  /** 正文，1 ~ 2000 字 */
  content: string
  /** 愿意留联系方式就带上；登录状态下后端会自己填 */
  contactEmail?: string
  /** 客户端版本号，例 1.4.2 */
  appVersion?: string
  /** win32 / darwin / linux */
  platform?: string
  /** 设备指纹。**未登录时靠它限频**，不然一个人能刷一万条 */
  deviceId?: string
}

export interface SubmitFeedbackRes {
  id: number
  createdAt: string
}

/** 15. GET /api/client/announcements —— 拉「现在该显示」的公告 */
export interface ClientAnnouncement {
  id: number
  title: string
  /** 横条只显示首行，点开看全文 */
  content: string
  /** normal | important | maintenance，决定横条颜色和图标 */
  level: 'normal' | 'important' | 'maintenance'
  /** 置顶的排前面 */
  pinned: boolean
  startsAt: string | null
  endsAt: string | null
  /** 当前这个人看过没有。未登录永远 false（客户端自己在本地记一份） */
  isRead: boolean
  createdAt: string
}

export interface ClientAnnouncementListRes {
  list: ClientAnnouncement[]
  /** 未读数 = list 里 isRead 为 false 的条数，后端算好省得客户端再遍一次 */
  unread: number
}

/**
 * 16. POST /api/client/announcements/{id}/read —— 标一条已读
 *
 * ⚠️ 只对**登录用户**有效：未登录时后端没地方记（总不能给每个匿名设备造个假客户 id），
 *    接口会返回 `{ unread: 0 }` 让客户端走本地记录。
 */
export interface MarkAnnouncementReadRes {
  unread: number
}
