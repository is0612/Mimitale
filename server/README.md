# Mimitale 账号中心

**只管账号与会员。** 角色卡、世界书、聊天记录、本地设置 —— 一份都不存，全部留在用户自己电脑上。

数据量级的现实：100 个客户也就几百 KB，全部是「这人有几个、什么状态、会员到哪天」。

---

## 为什么要单独一个后端

客户端是 Electron，用户自带 API Key 直连模型厂商。这台服务器**永远不碰模型请求**——
一旦碰了（哪怕是转发不落地），身份就从「账号服务提供者」变成「面向境内公众的生成式 AI 服务提供者」，
要办算法备案 + 大模型备案。这条红线写在 `admin/登录体系决策记录.md` 的决策 4，别动。

所以这里做的事只有：**发验证码、建号、发会员、封号、记账**。

---

## 快速开始

```bash
cd server
cp .env.example .env    # 只第一次
npm install             # 只第一次

npm run dev             # 之后每天都用这一条
```

`npm run dev`（`scripts/dev.mjs`）会依次做四件事，**每一步都是幂等的**（跑一百次都一样）：

1. 起 postgres + mailpit 容器（已经在跑就跳过）
2. 等 Postgres **真的能连上**（容器起来 ≠ 能接受连接，通常差两三秒）
3. `prisma migrate deploy` 同步库结构
4. 播种（缺哪补哪）+ 启动服务，改代码自动重启

前提：**Docker Desktop 得先开着**。

| 其他命令 | 干什么 |
| --- | --- |
| `npm run dev:app` | 只起服务（数据库已经在跑时用，跳过建表和播种） |
| `npm run db:down` | 停容器。数据在 docker volume 里，**不会丢** |
| `npm run db:reset` | 清库重建 —— ⚠️ 会丢数据，只在本地开发用 |
| `npm run db:studio` | 浏览器里直接看表 |
| `node scripts/smoke.mjs` | 126 条断言打一遍真接口 |

验证：

```bash
curl http://127.0.0.1:8080/api/health
```

**验证码邮件去哪看**：<http://127.0.0.1:8025>（mailpit 的网页收件箱）。
它拦住所有出站邮件，不会真发给任何人。

**后台连上来**：`admin/.env` 里设 `VITE_USE_MOCK=false`，然后 `npm run dev`。
vite 的 `/api` 代理本来就指着 `127.0.0.1:8080`，不用改。

---

## 这东西长什么样

```
                    ┌──────────────────┐
   Mimitale 客户端 ──┤                  │
   （用户机器）      │  mimitale-server │──> PostgreSQL
                    │                  │
   管理后台 ─────────┤   :8080          │──> SMTP（验证码）
   （你浏览器）      └──────────────────┘
                          ↑
                    nginx 反代 /api
```

- 客户端调 `/api/client/auth/*`（5 个）
- 后台调 `/api/admin/*`（16 个 + 1 个概览）
- **两套 token 互不通用**：客户 token 进不了管理接口，管理员也不是客户

---

## 目录

```
server/
├── prisma/
│   ├── schema.prisma      ⭐ 6 张表，全在「账号与运营」范围内
│   └── seed.ts            幂等播种（每次启动都跑也不会重复插）
├── src/
│   ├── index.ts           启动 + 优雅退出
│   ├── app.ts             Fastify 组装、守卫挂载、统一错误外壳
│   ├── env.ts             环境变量（唯一读 process.env 的地方）
│   ├── prisma.ts          单例（热重载不会撑爆连接池）
│   ├── lib/
│   │   ├── codes.ts       业务错误码（从 admin/src/types 复制的一份值）
│   │   ├── bizError.ts    业务错误（BizError）—— 别用裸 Error，会被当成 500
│   │   ├── reply.ts       ok / fail / 401
│   │   ├── auth.ts        JWT 签发与守卫（admin / client / pending 三种）
│   │   ├── password.ts    scrypt（Node 内置，不编译原生模块）
│   │   ├── captcha.ts     图形校验码（内存 + SVG，5 分钟一次性）
│   │   ├── voucher.ts     24 位凭证码
│   │   ├── log.ts         操作日志，跟业务同事务
│   │   ├── dict.ts        字典值查询
│   │   ├── dto.ts         数据库行 → 接口数据（Date → ISO 字符串）
│   │   ├── time.ts        ⚠️ 全部按北京时间算
│   │   ├── mail.ts        nodemailer
│   │   └── cardCode.ts    MIMI-XXXX-XXXX
│   └── routes/
│       ├── admin/         auth · customers · logs · cards · dicts · overview
│       └── client/        auth（12 个：图形码 / 发码 / 注册两步 / 密码登录 / 凭证登录 / 会话 / 凭证 / 改资料 / 改密码 / 改邮箱）
├── docker-compose.yml     db:5433 · mail:1025+8025 · api:8080(profile full)
└── Dockerfile             无构建步骤，tsx 直接跑
```

---

## 接口

统一响应外壳：

```json
{ "code": 0, "message": "ok", "data": { } }
```

`code === 0` 是成功。**只有认证失败才改 HTTP 状态码（401）**，其余业务错误都是 HTTP 200 + `code ≠ 0`。
错误码表在 `src/lib/codes.ts`，和 `admin/src/types/index.ts` 里的 `ApiCode` 必须一致。

### 后台侧（Bearer adminToken）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/auth/login` | 账号 + 密码，**没有注册** |
| POST | `/api/admin/auth/refresh` | 换新 token |
| GET | `/api/admin/auth/me` | 拿当前管理员 |
| POST | `/api/admin/auth/logout` | 登出 |
| GET | `/api/admin/customers` | 分页 / 关键词 / 状态 |
| GET | `/api/admin/customers/{id}` | 详情 + 用的卡 + 他的日志 |
| PATCH | `/api/admin/customers/{id}` | 封禁 / 解封 / 改额度 / 发会员 |
| GET | `/api/admin/logs` | 只读，**没有写接口** |
| GET | `/api/admin/cards` | 卡密列表 |
| POST | `/api/admin/cards` | 批量生成（≤100 张） |
| PATCH | `/api/admin/cards/{id}` | 作废 |
| GET | `/api/admin/dicts` | 类型 + 数据项一次拿回 |
| POST | `/api/admin/dicts` | 新建类型 |
| POST | `/api/admin/dicts/{code}/items` | 新增项 |
| PATCH | `/api/admin/dicts/items/{id}` | 改 / 启停 |
| DELETE | `/api/admin/dicts/items/{id}` | 删 |
| GET | `/api/admin/overview` | ⭐ 今天注册了几个、近 7 天曲线、会员数 |
| GET | `/api/admin/feedbacks` | 意见反馈列表 + 五个状态的总数 |
| PATCH | `/api/admin/feedbacks/{id}` | 改状态 / 写内部备注（**不能改正文**） |
| GET | `/api/admin/announcements` | 公告列表（含已下架）+ 在架条数 |
| POST | `/api/admin/announcements` | 发一条公告 |
| PATCH | `/api/admin/announcements/{id}` | 改 / 上下架 / 置顶 |
| DELETE | `/api/admin/announcements/{id}` | 真删（已读记录一起清） |

### 客户端侧（Bearer clientToken）

形状和 `client/main/account.js` 的 12 个 IPC 通道一一对应，不多不少。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/client/auth/captcha` | 图形校验码（SVG，5 分钟，一次性） |
| POST | `/api/client/auth/code` | 发邮箱验证码（**必须先过图形码**，60 秒限一次，10 分钟有效） |
| POST | `/api/client/auth/register` | 注册第一步：邮箱 + 验证码 → 建空号，发**临时令牌** |
| POST | `/api/client/auth/complete-profile` | 注册第二步：带临时令牌设用户名/密码/头像 → 发正式 token |
| POST | `/api/client/auth/login` | 邮箱 + 密码 + 图形码 |
| POST | `/api/client/auth/voucher-login` | 24 位凭证码登录（换机器 / 重装） |
| POST | `/api/client/auth/refresh` | 换新 token |
| GET | `/api/client/auth/me` | 当前客户 → `{ user }` |
| POST | `/api/client/auth/logout` | 登出 |
| GET | `/api/client/auth/voucher` | 取凭证（客户端拿去画那张 PNG 卡） |
| PATCH | `/api/client/auth/profile` | 改用户名 / 头像 |
| POST | `/api/client/auth/password` | 改密码（要当前密码，改完不踢会话） |
| POST | `/api/client/auth/email` | 改邮箱（要新邮箱收到的验证码） |

⚠️ **注册是两步**，`complete-profile` 靠 `register` 发的**临时令牌**认身份，**不靠 `accountId`** ——
自增 id 能被枚举，否则谁都能给别人的号设资料。临时令牌 10 分钟、只能调这一个接口，
拿去调 `/me` 会被 401 打回。

### 客户端侧：消息（**故意不要求登录**）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/client/feedback` | 发意见反馈。登录了就自动带上邮箱昵称 |
| GET | `/api/client/announcements` | 拉此刻该显示的公告，带 `isRead` |
| POST | `/api/client/announcements/{id}/read` | 标一条已读（未登录回 `unread: 0`） |

这三个在 `clientGuard` **外面**，带不发 token 都能用 —— 理由写在 `routes/client/messages.ts` 文件头：
「连登录都进不去」的人才最需要报错入口，「你被停机了」这种公告也恰恰要发给登录不进去的人。
带了有效 token 就走 `optionalCustomerId` 认出是谁；token 过期也当没登录，**不报 401**（否则客户端启动时拉公告会整块失败）。
限频按设备指纹查库（60 秒一条、一天 10 条），没带指纹就退回 IP。

⚠️ 新用户的 30 天试用会员在**第二步完成时**发，不在第一步。后台的「今日注册」也只算走完两步的人。

⚠️ **图形码是 `/code` 的前置条件**，不是装饰：没有它，这个接口就是一个免费的邮件轰炸器。

---

## 几条不能改的设计

**① 「今天」一律按北京时间**

容器默认 UTC。直接拿 `new Date().getDate()` 算日期，北京时间早上 8 点前的注册会被算到昨天 ——
你看到的「今日注册」就是错的。所以 `lib/time.ts` 把所有日期计算都钉在 `Asia/Shanghai`，
SQL 里聚合也用 `created_at AT TIME ZONE 'Asia/Shanghai'`。别改成本地时区。

**② 操作日志只由后端写**

封禁、改额度、发会员、生成卡密、作废、改字典，都在业务事务里顺手 `pushLog`。
**没有 `POST /logs` 这种接口，也不要有** —— 日志一旦靠前端上报，记的就只是「前端愿意上报的那部分」。

还有一条细节：**值没变就不写日志**。重复提交同一个额度不该刷出噪音。

**③ 会员过期不存字段**

只存 `membership_level` + `membership_expire_at`，「已过期」由「到期时间 < 现在」推导。
加一个 `expired` 布尔就会跟到期时间打架。
续费从 `max(现在, 原到期日)` 顺延 N 天 —— 还在有效期就往后接，过期了从今天算。

**④ 字典只收「加一个值不用改代码」的**

封禁原因、客户来源、额度预设、卡密备注、会员等级 → 进字典。
客户状态、卡密状态、管理员角色、日志动作类型 → **不进**，它们是代码里的 `if` 判据，
塞进字典只会造出「选得动但什么都不发生」的假旋钮。

**⑤ 客户和管理员是两套账号**

不共用表、不共用 token、不共用接口。客户能自助注册是设计，管理员能自助注册是漏洞。

**⑥ 业务错误用 `throw biz(...)`，不要裸 `throw new Error(...)`**

裸 Error 会被统一的错误处理当成 500（「服务端出错了」），用户看不到真正的原因；
更糟的是日志里会堆满假的故障，真出事时没人分得清。`lib/bizError.ts` 那个 `BizError`
对应「HTTP 200 + code 1001 + 中文原因」，真正的崩溃才走 500 + 堆栈。

**⑦ 时间列是 `timestamp(3)`（没有时区标记），里面存的是 UTC**

服务端全走 Prisma，读写一致，没问题。但**用原生 SQL 直接查时要注意**：

- 按天聚合 → `created_at AT TIME ZONE 'Asia/Shanghai'`（把 UTC 值转成北京时间）
- 用 `pg` 这类驱动读出来 → 要么 `(col AT TIME ZONE 'UTC')` 声明成 timestamptz，要么自己按 UTC 解析
  （`new Date("2026-11-26 09:50:00")` 会按**本地时区**算，东八区直接差 8 小时）

`scripts/smoke.mjs` 里那段 `parseDbTime` / `AT TIME ZONE 'UTC'` 就是被这个坑绊过之后加的。

---

## 上线前必须改的四个值

```bash
JWT_SECRET  = openssl rand -hex 32 的结果
ADMIN_PASSWORD = 别用 admin123
DEV_ECHO_CODE  = false   # 否则验证码会打进日志
SEED_DEMO      = false   # 否则生产库里凭空多出 12 个假客户
```

`docker-compose.yml` 里 api 服务已经设好了后两个，前两个从宿主机的环境变量传。

---

## 部署（将来有服务器时）

```bash
# 模拟生产：db + mail + api 全在容器里
docker compose --profile full up -d --build
```

`Dockerfile` 没有构建步骤（tsx 直接跑 TS），所以镜像里不会有 `dist/` 和源码对不上的问题。
容器启动时自动跑 `prisma migrate deploy` + 幂等 seed。

搬到香港服务器时只改 nginx：

```nginx
location /api/ { proxy_pass http://127.0.0.1:8080/api/; }
location /admin/ { alias /var/www/mimitale-admin/; index index.html; }
```

**备份只备份数据库**，不备份代码 —— 代码在 git 里，数据只有一份。

```bash
docker exec mimitale-db pg_dump -U mimitale mimitale | gzip > backup-$(date +%F).sql.gz
```
