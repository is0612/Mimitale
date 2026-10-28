/**
 * 播种。**幂等** —— 每次启动都跑一遍也不会重复插入、不会覆盖已有数据。
 *
 * 做三件事：
 *   ① 建初始管理员（已存在就跳过，绝不重置密码）
 *   ② 建 5 个字典类型和数据项（缺哪条补哪条）
 *   ③ 可选：造一批示范客户/卡密/日志，让后台第一次打开不是空表
 *
 * ③ 用 SEED_DEMO=false 关掉 —— 生产环境必须关，不然会凭空多出 12 个假客户。
 */
import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('缺少 DATABASE_URL —— 先把 .env.example 复制成 .env')

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123'
const ADMIN_NICKNAME = process.env.ADMIN_NICKNAME ?? '星宝'

const DAY = 86_400_000

/* ------------------------------------------------------------------ */
/* ① 管理员                                                            */
/* ------------------------------------------------------------------ */

async function seedAdmin(): Promise<void> {
  const exists = await prisma.admin.findUnique({ where: { username: ADMIN_USERNAME } })
  if (exists) {
    console.log(`[seed] 管理员 ${ADMIN_USERNAME} 已存在，跳过`)
    return
  }

  // 动态 import：避免 password 模块在极早期就被加载
  const { hashPassword } = await import('../src/lib/password.js')

  await prisma.admin.create({
    data: {
      username: ADMIN_USERNAME,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      nickname: ADMIN_NICKNAME,
      role: 'super'
    }
  })
  console.log(`[seed] 已创建管理员 ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`)
}

/* ------------------------------------------------------------------ */
/* ② 字典                                                              */
/* ------------------------------------------------------------------ */

interface SeedDict {
  code: string
  name: string
  remark: string
  items: Array<[label: string, value: string, remark: string]>
}

const DICTS: SeedDict[] = [
  {
    code: 'ban_reason',
    name: '封禁原因',
    remark: '封禁客户时选的原因，用于事后追溯',
    items: [
      ['刷屏广告', 'spam', '在角色卡/世界书里夹带广告'],
      ['盗卖卡密', 'card_resale', '把卡密拿到外面倒卖'],
      ['违规调用接口', 'api_abuse', '用脚本高频刷接口'],
      ['冒充他人', 'impersonation', ''],
      ['其他', 'other', '']
    ]
  },
  {
    code: 'customer_source',
    name: '客户来源',
    remark: '由「有没有邀请码」推导出来，字典只负责它的显示名',
    items: [
      ['邮箱直注', 'email', '没填邀请码，直接邮箱注册'],
      ['邀请码', 'invite', '注册时填了卡密'],
      ['后台导入', 'import', '预留给批量导入，目前没有产生途径']
    ]
  },
  {
    code: 'card_note',
    name: '卡密备注分类',
    remark: '生成卡密时选，方便日后按来源统计',
    items: [
      ['种子用户', 'seed', '早期免费发的'],
      ['活动赠送', 'promo', ''],
      ['付费购买', 'paid', '第三方平台卖出去的'],
      ['内部测试', 'test', '']
    ]
  },
  {
    code: 'membership_level',
    name: '会员等级',
    remark: '客户所属的会员档位；none 是「非会员」哨兵，不进字典',
    items: [
      ['初级会员', 'basic', '新用户免费试用 30 天'],
      ['中级会员', 'medium', ''],
      ['高级会员', 'premium', '']
    ]
  }
]

async function seedDicts(): Promise<void> {
  for (const d of DICTS) {
    const type = await prisma.dictType.findUnique({ where: { code: d.code } })
    if (!type) {
      await prisma.dictType.create({ data: { code: d.code, name: d.name, remark: d.remark } })
      console.log(`[seed] 字典类型 ${d.code} 已创建`)
    }

    for (const [index, [label, value, remark]] of d.items.entries()) {
      const item = await prisma.dictItem.findFirst({ where: { typeCode: d.code, value } })
      if (item) continue
      await prisma.dictItem.create({
        data: { typeCode: d.code, label, value, remark, sort: (index + 1) * 10 }
      })
    }
  }
  console.log('[seed] 字典已就绪')
}

/* ------------------------------------------------------------------ */
/* ③ 示范数据                                                          */
/* ------------------------------------------------------------------ */

const DEMO_NAMES = [
  '夜航船',
  '灰羽',
  '半糖去冰',
  '雾岛听风',
  '拾光',
  '南风',
  '三月初九',
  '过路人',
  '纸飞机',
  '旧巷',
  '星野',
  '沉舟'
]

const DEMO_EMAILS = [
  'yehangchuan@example.com',
  'huiyu@example.com',
  'bantang@example.com',
  'wudao@example.com',
  'shiguang@example.com',
  'nanfeng@example.com',
  'sanyue@example.com',
  'guoluren@example.com',
  'zhifeiji@example.com',
  'jiuxiang@example.com',
  'xingye@example.com',
  'chenzhou@example.com'
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 北京时间某一天的某个时刻 */
function at(offsetDays: number, hour: number, minute = 0): Date {
  const d = new Date(Date.now() - offsetDays * DAY)
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)
  return new Date(`${day}T${pad(hour)}:${pad(minute)}:00.000+08:00`)
}

async function seedDemo(): Promise<void> {
  const existing = await prisma.customer.count()
  if (existing > 0) {
    console.log(`[seed] 已有 ${existing} 个客户，跳过示范数据`)
    return
  }

  const admin = await prisma.admin.findUnique({ where: { username: ADMIN_USERNAME } })
  if (!admin) throw new Error('管理员还没建出来')

  // 前 3 个排在今天/昨天，这样概览页的「今日注册」不是 0
  const offsets = [0, 0, 1, 3, 5, 8, 11, 14, 18, 21, 24, 28]

  const { newInviteCode } = await import('../src/lib/cardCode.js')
  const { makeVoucher } = await import('../src/lib/voucher.js')
  const { hashPassword } = await import('../src/lib/password.js')

  // 示范客户都是「走完注册第二步」的正式账号，统一用这个密码 ——
  // 只用于本地开发，生产 SEED_DEMO=false 时根本不会跑
  const demoPasswordHash = await hashPassword('demo1234')

  // 先造一批卡密，前 5 张给前 5 个客户用掉
  const cards: Array<{ id: number; code: string }> = []
  for (let i = 0; i < 13; i++) {
    const card = await prisma.inviteCard.create({
      data: {
        code: newInviteCode(),
        note: i < 5 ? '种子用户' : i < 11 ? '活动赠送' : '内部测试',
        status: 'unused',
        expireAt: i >= 11 ? null : new Date(Date.now() + 180 * DAY)
      }
    })
    cards.push({ id: card.id, code: card.code })
  }

  const customers: Array<{ id: number; nickname: string; email: string }> = []

  for (let i = 0; i < DEMO_EMAILS.length; i++) {
    const offset = offsets[i] ?? 30
    const createdAt = at(offset, 9 + (i % 9), (i * 7) % 60)
    const usingCard = i < 5 ? cards[i] : null

    // 免费天数：注册就送 30 天（不是会员）。注册早的人自然已经用完
    const freeExpireAt = new Date(createdAt.getTime() + 30 * DAY)

    // 会员：前 3 个生效中（第 3 个 7 天内到期）、接着 2 个已过期、其余从没发过
    let membershipLevel = 'none'
    let membershipExpireAt: Date | null = null
    if (i === 0) {
      membershipLevel = 'basic'
      membershipExpireAt = new Date(at(0, 9).getTime() + 30 * DAY)
    } else if (i === 1) {
      membershipLevel = 'medium'
      membershipExpireAt = new Date(Date.now() + 4 * DAY)
    } else if (i === 2) {
      membershipLevel = 'premium'
      membershipExpireAt = new Date(Date.now() + 20 * DAY)
    } else if (i === 3 || i === 4) {
      membershipLevel = 'basic'
      membershipExpireAt = new Date(Date.now() - (10 + i) * DAY)
    }

    const customer = await prisma.customer.create({
      data: {
        email: DEMO_EMAILS[i]!,
        nickname: DEMO_NAMES[i]!,
        // 走完了注册第二步 —— 后台的「今日注册」只算这些人
        profileReady: true,
        voucher: makeVoucher(),
        passwordHash: demoPasswordHash,
        // 第 2 个封禁，其余正常
        status: i === 2 ? 'banned' : 'active',
        banReason: i === 2 ? 'spam' : null,
        membershipLevel,
        membershipExpireAt,
        freeExpireAt,
        inviteCode: usingCard ? usingCard.code : null,
        createdAt,
        lastLoginAt: new Date(createdAt.getTime() + 3600_000)
      }
    })
    customers.push({ id: customer.id, nickname: customer.nickname, email: customer.email })

    // 天数流水：每个人都有一条注册赠送；发过会员的再补一条
    await prisma.membershipGrant.create({
      data: {
        customerId: customer.id,
        days: 30,
        source: 'trial',
        note: '注册赠送 30 天免费',
        startsAt: createdAt,
        expiresAt: freeExpireAt
      }
    })
    if (membershipExpireAt) {
      const from = new Date(Math.min(freeExpireAt.getTime(), membershipExpireAt.getTime()))
      const to = new Date(Math.max(freeExpireAt.getTime(), membershipExpireAt.getTime()))
      await prisma.membershipGrant.create({
        data: {
          customerId: customer.id,
          days: Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY)),
          source: 'admin',
          note: '后台发会员',
          startsAt: from,
          expiresAt: to
        }
      })
    }

    if (usingCard) {
      await prisma.inviteCard.update({
        where: { id: usingCard.id },
        data: { status: 'used', usedByCustomerId: customer.id, usedAt: createdAt }
      })
    }
  }

  // 一张作废的
  const voidCard = cards[12]
  if (voidCard) {
    await prisma.inviteCard.update({ where: { id: voidCard.id }, data: { status: 'void' } })
  }

  // 几条历史日志 —— 打开日志页就有东西看
  const log = (
    action: string,
    targetType: string,
    targetId: number | null,
    targetName: string,
    detail: string,
    createdAt: Date
  ) => ({
    adminId: admin.id,
    adminName: admin.nickname,
    action,
    targetType,
    targetId,
    targetName,
    detail,
    ip: '127.0.0.1',
    createdAt
  })

  const demo = customers[0]
  const banned = customers[2]

  await prisma.operationLog.createMany({
    data: [
      ...(banned
        ? [log('customer.ban', 'customer', banned.id, banned.nickname, '封禁（刷屏广告）', at(2, 11, 20))]
        : []),
      ...(demo
        ? [
            log('customer.membership', 'customer', demo.id, demo.nickname, '发会员：初级会员 +30 天（新开通）', at(0, 9, 5))
          ]
        : []),
      log('card.create', 'card', cards[0]?.id ?? null, cards[0]?.code ?? '', '生成 13 张卡密（种子用户），180 天后过期', at(6, 15))
    ]
  })

  /* ---------------- 消息：几条反馈 + 两条公告 ---------------- */

  // 反馈三种类型各来一条，第一条是登录状态发的（带 customerId 和联系方式），
  // 其余是匿名的 —— 和真实情况一致：很多人是在登不进去的时候才来报错的
  const fb1 = customers[1]
  const fb2 = customers[3]
  const fb3 = customers[5]

  await prisma.feedback.createMany({
    data: [
      {
        customerId: fb1?.id ?? null,
        contactEmail: fb1?.email ?? '',
        contactName: fb1?.nickname ?? '',
        kind: 'bug',
        content: '世界书条目超过 50 条之后，编辑页滚动会卡一秒左右才跟手，改成虚拟滚动会好些吗？',
        appVersion: '1.4.2',
        platform: 'win32',
        deviceId: 'demo-dev-1',
        status: 'pending',
        ip: '127.0.0.1',
        createdAt: at(0, 8, 40)
      },
      {
        customerId: null,
        contactEmail: '',
        contactName: '',
        kind: 'idea',
        content: '希望剧情选项能记住上次选的那批，换一批的时候别整个刷新，思路会断。',
        appVersion: '1.4.2',
        platform: 'win32',
        deviceId: 'demo-dev-2',
        status: 'read',
        handledBy: admin.nickname,
        handledAt: at(1, 10, 12),
        ip: '127.0.0.1',
        createdAt: at(1, 9, 30)
      },
      {
        customerId: fb2?.id ?? null,
        contactEmail: fb2?.email ?? '',
        contactName: fb2?.nickname ?? '',
        kind: 'other',
        content: '凭证码那张图丢了还能找回账号吗？换过一次电脑，现在只能靠它登回来。',
        appVersion: '1.4.1',
        platform: 'darwin',
        deviceId: 'demo-dev-3',
        status: 'resolved',
        note: '已经私信教他用手抄码登录了',
        handledBy: admin.nickname,
        handledAt: at(2, 16, 5),
        ip: '127.0.0.1',
        createdAt: at(2, 15, 48)
      },
      {
        customerId: fb3?.id ?? null,
        contactEmail: fb3?.email ?? '',
        contactName: fb3?.nickname ?? '',
        kind: 'bug',
        content: '托盘图标在双屏拔掉一个之后就不见了，要重启才回来。',
        appVersion: '1.4.0',
        platform: 'win32',
        deviceId: 'demo-dev-4',
        status: 'ignored',
        note: '等托盘那块整体重做再看',
        handledBy: admin.nickname,
        handledAt: at(3, 11, 2),
        ip: '127.0.0.1',
        createdAt: at(3, 10, 20)
      }
    ]
  })

  const notice1 = await prisma.announcement.create({
    data: {
      title: '欢迎使用 Mimitale',
      content:
        '这是第一条公告。有意见或者遇到 bug，点左下角头像里的「意见反馈」，我们会看。\n换电脑前记得把凭证码那张图存好 —— 它是唯一的迁移手段。',
      level: 'normal',
      pinned: true,
      authorId: admin.id,
      authorName: admin.nickname,
      createdAt: at(5, 10)
    }
  })

  await prisma.announcement.create({
    data: {
      title: 'v1.5 计划：世界书支持按段排序',
      content:
        '下个版本会给世界书条目加排序和分组。已经建好的书不受影响，排序可以一键恢复默认。',
      level: 'important',
      authorId: admin.id,
      authorName: admin.nickname,
      createdAt: at(1, 14, 20)
    }
  })

  // 一部分客户已经看过第一条 —— 不然「未读」永远是全红，看不出差别
  const readers = customers.slice(0, 5)
  if (readers.length > 0) {
    await prisma.announcementRead.createMany({
      data: readers.map((c) => ({
        announcementId: notice1.id,
        customerId: c.id,
        readAt: at(4, 9)
      }))
    })
  }

  console.log(
    `[seed] 示范数据：${DEMO_EMAILS.length} 个客户、${cards.length} 张卡密、4 条反馈、2 条公告、若干日志`
  )
}

/* ------------------------------------------------------------------ */

await seedAdmin()
await seedDicts()

if (process.env.SEED_DEMO === 'false') {
  console.log('[seed] SEED_DEMO=false，不造示范数据')
} else {
  await seedDemo()
}

await prisma.$disconnect()
