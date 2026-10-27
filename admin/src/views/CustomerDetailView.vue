<script setup lang="ts">
/**
 * 客户详情页 —— 路由 /customers/:id
 *
 * 列表只能看个大概，这一页回答四个问题：
 *   ① 这个人是谁（邮箱、来源、邀请码、凭证码、最后一次上线）
 *   ② 他的邀请码是哪张卡发出去的、他邀请了几个人
 *   ③ 他从哪儿、什么时候登进来的（登录记录，IP + 方式）
 *   ④ 我们对他做过什么（操作记录，时间线形式，最近的在最上面）
 *
 * ③④ 的数据都不是这一页自己攒的 —— 后端在登录 / 封禁 / 发会员时**顺手写进表**，
 * 所以哪怕是从列表页操作的，这里也看得到。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { fetchCustomerDetail } from '@/api/customer'
import { useDictStore } from '@/stores/dict'
import CustomerDialogs from '@/components/CustomerDialogs.vue'
import {
  CARD_STATUS_LABEL,
  CARD_STATUS_TAG,
  CUSTOMER_STATUS_LABEL,
  CUSTOMER_STATUS_TAG,
  LOGIN_METHOD_LABEL,
  LOGIN_METHOD_TAG,
  SESSION_END_REASON_LABEL,
  SESSION_END_REASON_TAG,
  LOG_ACTION_LABEL,
  LOG_ACTION_TAG,
  GRANT_SOURCE_LABEL,
  GRANT_SOURCE_TAG,
  deriveCustomerSource,
  formatDay,
  formatTime,
  freeDaysLeft,
  freeState,
  membershipState
} from '@/config/labels'
import type { TagType } from '@/config/labels'
import type { ClientSession, CustomerDetail, GrantSource } from '@/types'

const route = useRoute()
const router = useRouter()
const dict = useDictStore()
const dialogs = ref<InstanceType<typeof CustomerDialogs> | null>(null)

const loading = ref(false)
const detail = ref<CustomerDetail | null>(null)
const notFound = ref(false)

const customerId = computed(() => Number(route.params.id))

async function load(): Promise<void> {
  loading.value = true
  notFound.value = false
  try {
    detail.value = await fetchCustomerDetail(customerId.value)
  } catch {
    notFound.value = true
    detail.value = null
  } finally {
    loading.value = false
  }
}

function goBack(): void {
  router.push({ name: 'customers' })
}

function memberLabel(c: CustomerDetail): string {
  const s = membershipState(c)
  if (s === 'none') return '非会员'
  if (s === 'expired') return '已过期'
  return dict.labelOf('membership_level', c.membershipLevel)
}

function memberTag(c: CustomerDetail): TagType {
  const s = membershipState(c)
  if (s === 'none') return 'info'
  if (s === 'expired') return 'danger'
  return 'success'
}

/** 凭证码要给用户念 / 粘贴，所以留一个复制 —— 复制的永远是不带空格的原文 */
async function copyVoucher(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code)
    ElMessage.success('凭证码已复制')
  } catch {
    ElMessage.warning('复制失败，手动选中复制一下')
  }
}

/** UA 压成一句人话。整串太长（Electron 的 UA 有 120+ 字符），表格里只看得出
 * 「是不是 Windows / 哪个版本」就够了，原文挂在 tooltip 上。
 */
function uaSummary(ua: string): string {
  if (!ua) return '—'
  const os = /Windows NT 10/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? 'macOS'
      : /Linux/.test(ua)
        ? 'Linux'
        : ''
  const version =
    (ua.match(/Electron\/[\d.]+/) || [])[0] || (ua.match(/Chrome\/[\d.]+/) || [])[0] || ''
  const parts = [os, version].filter(Boolean)
  return parts.length ? parts.join(' · ') : ua.slice(0, 32)
}

/** 表格里的 row 是 any，索引 Record<GrantSource, _> 过不了类型检查，收口到这两个 */
function grantLabel(source: string): string {
  return GRANT_SOURCE_LABEL[source as GrantSource] || source
}

function grantTag(source: string): TagType {
  return GRANT_SOURCE_TAG[source as GrantSource] || 'info'
}

/** 一次会话的时长，人话格式。没结束的按最后心跳算，一次心跳都没有就是「—」 */
function sessionDuration(s: ClientSession): string {
  const end = s.endedAt ?? s.lastSeenAt
  if (!end) return '—'
  const ms = Date.parse(end) - Date.parse(s.startedAt)
  if (ms < 0) return '—'
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="head">
      <el-button :icon="ArrowLeft" text @click="goBack">返回客户列表</el-button>
      <div class="spacer" />
      <el-button :icon="Refresh" @click="load">刷新</el-button>
    </div>

    <el-empty v-if="notFound" description="客户不存在（可能已被删除）">
      <el-button type="primary" @click="goBack">回列表</el-button>
    </el-empty>

    <template v-else-if="detail">
      <el-card shadow="never" class="panel">
        <div class="top">
          <div class="who">
            <div class="avatar">
              <img v-if="detail.avatar" :src="detail.avatar" alt="" />
              <template v-else>{{ detail.nickname.slice(0, 1) }}</template>
            </div>
            <div>
              <div class="name">
                {{ detail.nickname }}
                <el-tag
                  :type="CUSTOMER_STATUS_TAG[detail.status]"
                  size="small"
                  disable-transitions
                  class="status-tag"
                >
                  {{ CUSTOMER_STATUS_LABEL[detail.status] }}
                </el-tag>
              </div>
              <div class="mail">{{ detail.email }}</div>
            </div>
          </div>
          <div class="actions">
            <el-button @click="dialogs?.openMembership(detail)">发会员</el-button>
            <el-button v-if="detail.status === 'active'" type="danger" @click="dialogs?.openBan(detail)">
              封禁
            </el-button>
            <el-button v-else type="success" @click="dialogs?.submitUnban(detail)">解封</el-button>
          </div>
        </div>

        <el-descriptions :column="3" border class="desc">
          <el-descriptions-item label="客户 ID">{{ detail.id }}</el-descriptions-item>
          <el-descriptions-item label="来源">
            {{ dict.labelOf('customer_source', deriveCustomerSource(detail)) }}
          </el-descriptions-item>
          <el-descriptions-item label="登录凭证码">
            <span v-if="detail.voucher" class="voucher">
              <span class="mono">{{ detail.voucher }}</span>
              <el-button link type="primary" size="small" @click="copyVoucher(detail.voucher)">复制</el-button>
            </span>
            <span v-else class="muted">还没生成</span>
          </el-descriptions-item>
          <el-descriptions-item label="我的邀请码">
            <span v-if="detail.referralCode" class="mono">{{ detail.referralCode }}</span>
            <span v-else class="muted">还没生成</span>
          </el-descriptions-item>
          <el-descriptions-item label="已邀请">
            <span v-if="detail.invitedCount > 0">{{ detail.invitedCount }} 人</span>
            <span v-else class="muted">0 人</span>
          </el-descriptions-item>
          <el-descriptions-item label="邀请人">
            <span v-if="detail.referredBy">
              {{ detail.referredBy.nickname }}
              <span class="muted">（{{ detail.referredBy.email }}）</span>
            </span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="会员等级">
            <el-tag :type="memberTag(detail)" size="small" disable-transitions>{{ memberLabel(detail) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="免费天数">
            <span v-if="freeDaysLeft(detail) !== null" :class="{ warn: freeDaysLeft(detail)! <= 7 }">
              剩 {{ freeDaysLeft(detail) }} 天
              <span class="muted">（到 {{ formatDay(detail.freeExpireAt) }}）</span>
            </span>
            <span v-else-if="freeState(detail) === 'expired'" class="muted">
              已用完（{{ formatDay(detail.freeExpireAt) }} 结束）
            </span>
            <span v-else class="muted">—</span>
          </el-descriptions-item>
          <el-descriptions-item label="会员到期">
            <span v-if="membershipState(detail) === 'none'" class="muted">—</span>
            <span v-else :class="{ expired: membershipState(detail) === 'expired' }">
              {{ formatTime(detail.membershipExpireAt) }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="注册时间">{{ formatTime(detail.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="最后登录">{{ formatTime(detail.lastLoginAt) }}</el-descriptions-item>
          <el-descriptions-item label="邀请码">
            <span v-if="detail.inviteCode" class="mono">{{ detail.inviteCode }}</span>
            <span v-else class="muted">没用（邮箱直注）</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.status === 'banned'" label="封禁原因" :span="3">
            <el-tag type="warning" size="small" disable-transitions>
              {{ dict.labelOf('ban_reason', detail.banReason) }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card shadow="never" class="panel">
        <template #header>
          <div class="card-head">
            <span>注册用的卡密</span>
          </div>
        </template>
        <el-descriptions v-if="detail.usedCard" :column="4" border>
          <el-descriptions-item label="卡密">
            <span class="mono">{{ detail.usedCard.code }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="备注">{{ detail.usedCard.note }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="CARD_STATUS_TAG[detail.usedCard.status]" size="small" disable-transitions>
              {{ CARD_STATUS_LABEL[detail.usedCard.status] }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="使用时间">
            {{ formatTime(detail.usedCard.usedAt) }}
          </el-descriptions-item>
        </el-descriptions>
        <el-empty v-else :image-size="60" description="这个客户是直接邮箱注册的，没用卡密" />
      </el-card>

      <el-card shadow="never" class="panel">
        <template #header>
          <div class="card-head">
            <span>天数流水</span>
            <span class="sub">
              共 {{ detail.grants.length }} 条 ·
              免费 {{ detail.grants.filter((g) => g.source !== 'admin').reduce((s, g) => s + g.days, 0) }} 天 ·
              会员 {{ detail.grants.filter((g) => g.source === 'admin').reduce((s, g) => s + g.days, 0) }} 天
            </span>
          </div>
        </template>
        <el-table v-if="detail.grants.length" :data="detail.grants" size="small">
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="来源" width="118">
            <template #default="{ row }">
              <el-tag :type="grantTag(row.source)" size="small" disable-transitions>
                {{ grantLabel(row.source) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="天数" width="80">
            <template #default="{ row }">+{{ row.days }} 天</template>
          </el-table-column>
          <el-table-column label="这段落在" width="230">
            <template #default="{ row }">
              <span class="mono">{{ formatDay(row.startsAt) }} → {{ formatDay(row.expiresAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="说明" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.note">{{ row.note }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else :image-size="60" description="还没有加过天数" />
      </el-card>

      <el-card shadow="never" class="panel">
        <template #header>
          <div class="card-head">
            <span>活动记录</span>
            <span class="sub">最近 {{ detail.loginLogs.length }} 条 · IP 是客户端出口地址</span>
          </div>
        </template>
        <el-table v-if="detail.loginLogs.length" :data="detail.loginLogs" size="small">
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="方式" width="118">
            <template #default="{ row }">
              <el-tag :type="LOGIN_METHOD_TAG[row.method] || 'info'" size="small" disable-transitions>
                {{ LOGIN_METHOD_LABEL[row.method] || row.method }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="IP" width="150">
            <template #default="{ row }">
              <span v-if="row.ip" class="mono">{{ row.ip }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="客户端" show-overflow-tooltip>
            <template #default="{ row }">{{ uaSummary(row.userAgent) }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-else :image-size="60" description="还没有登录记录（这个功能上线前登录的不补记）" />
      </el-card>

      <el-card shadow="never" class="panel">
        <template #header>
          <div class="card-head">
            <span>使用记录</span>
            <span class="sub">最近 {{ detail.sessions.length }} 次 · 结束时间最多比真实退出晚 5 分钟</span>
          </div>
        </template>
        <el-table v-if="detail.sessions.length" :data="detail.sessions" size="small">
          <el-table-column label="开始" width="150">
            <template #default="{ row }">{{ formatTime(row.startedAt) }}</template>
          </el-table-column>
          <el-table-column label="时长" width="90">
            <template #default="{ row }">{{ sessionDuration(row) }}</template>
          </el-table-column>
          <el-table-column label="版本" width="100">
            <template #default="{ row }">
              <span v-if="row.appVersion" class="mono">{{ row.appVersion }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="结束" width="120">
            <template #default="{ row }">
              <el-tag
                v-if="row.endReason"
                :type="SESSION_END_REASON_TAG[row.endReason] || 'info'"
                size="small"
                disable-transitions
              >
                {{ SESSION_END_REASON_LABEL[row.endReason] || row.endReason }}
              </el-tag>
              <el-tag v-else type="warning" size="small" disable-transitions>使用中</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="IP" width="140">
            <template #default="{ row }">
              <span v-if="row.ip" class="mono">{{ row.ip }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="说明" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.endDetail" class="muted">{{ row.endDetail }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else :image-size="60" description="还没有使用记录（这个功能上线后才会开始记）" />
      </el-card>

      <el-card shadow="never" class="panel">
        <template #header>
          <div class="card-head">
            <span>操作记录</span>
            <span class="sub">共 {{ detail.logs.length }} 条 · 日志由后端写入，不可编辑</span>
          </div>
        </template>
        <el-timeline v-if="detail.logs.length" class="timeline">
          <el-timeline-item
            v-for="log in detail.logs"
            :key="log.id"
            :timestamp="formatTime(log.createdAt)"
            placement="top"
          >
            <div class="log-line">
              <el-tag :type="LOG_ACTION_TAG[log.action]" size="small" disable-transitions>
                {{ LOG_ACTION_LABEL[log.action] }}
              </el-tag>
              <span class="log-detail">{{ log.detail }}</span>
            </div>
            <div class="log-meta">操作人：{{ log.adminName }} · IP {{ log.ip }}</div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else :image-size="60" description="还没有针对这个客户的操作" />
      </el-card>
    </template>

    <CustomerDialogs ref="dialogs" @done="load" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.head {
  display: flex;
  align-items: center;
}

.spacer {
  flex: 1;
}

.panel :deep(.el-card__body) {
  padding: 16px 18px;
}

.panel :deep(.el-card__header) {
  padding: 12px 18px;
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}

.who {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #eeedfe;
  color: #534ab7;
  font-size: 17px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  overflow: hidden;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.name {
  font-size: 15px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-tag {
  font-weight: 400;
}

.mail {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 2px;
}

.actions {
  display: flex;
  gap: 8px;
}

.actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.desc :deep(.el-descriptions__label) {
  width: 92px;
  color: var(--text-sub);
}

.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-weight: 500;
}

.card-head .sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-sub);
}

.timeline {
  padding-left: 2px;
}

.timeline :deep(.el-timeline-item__timestamp) {
  font-size: 12px;
  color: var(--text-sub);
}

.log-line {
  display: flex;
  align-items: center;
  gap: 9px;
}

.log-detail {
  font-size: 13px;
}

.log-meta {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 3px;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

/* 凭证码 + 复制：两者同一行，别让「复制」掉到下一行去 */
.voucher {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 标签列不许折行 —— 五个字的标签会被挤成「我的邀请」+「码」，这一格折了整行都会歪。
   ⚠️ 必须 :deep：label 格子是 el-descriptions 渲染的，不带 scoped 的 data-v */
.desc :deep(.el-descriptions__label) {
  white-space: nowrap;
}

.muted {
  color: #b4b2a9;
}

/* 会员等级后面那颗「试用 / 后台开通」 */
/* 免费天数快用完（≤7 天）—— 这是最该推付费的时刻，得显眼一点 */
.warn {
  color: #b8791a;
}

.expired {
  color: #a32d2d;
}
</style>
