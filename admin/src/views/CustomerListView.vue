<script setup lang="ts">
/**
 * 客户管理 —— 后台的核心页面。
 * 这里列出的是在 Mimitale 客户端里注册使用的人（客户），不是本后台的登录账号。
 */
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { fetchCustomers } from '@/api/customer'
import { useDictStore } from '@/stores/dict'
import CustomerDialogs from '@/components/CustomerDialogs.vue'
import {
  CUSTOMER_STATUS_LABEL,
  CUSTOMER_STATUS_TAG,
  formatDay,
  formatTime,
  freeDaysLeft,
  freeState,
  membershipState,
  MEMBER_NAME
} from '@/config/labels'
import type { Customer, CustomerStatus } from '@/types'
import type { TagType } from '@/config/labels'

const router = useRouter()
const dict = useDictStore()
const dialogs = ref<InstanceType<typeof CustomerDialogs> | null>(null)

const loading = ref(false)
const rows = ref<Customer[]>([])
const total = ref(0)

const query = reactive({
  page: 1,
  pageSize: 10,
  keyword: '',
  status: '' as CustomerStatus | ''
})

// 搜索、筛选和翻页可以并发；只有最后一次请求能改列表与加载状态。
let loadSequence = 0
async function load(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  try {
    const res = await fetchCustomers({ ...query })
    if (sequence !== loadSequence) return
    rows.value = res.list
    total.value = res.total
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function search(): void {
  query.page = 1
  load()
}

function reset(): void {
  query.keyword = ''
  query.status = ''
  query.page = 1
  load()
}

function openDetail(row: Customer): void {
  router.push({ name: 'customer-detail', params: { id: row.id } })
}

/**
 * 这一列显示「他现在还能用到什么时候」，不是「他是什么等级的会员」——
 * 注册用户等级是 none，但他有 30 天免费天数，显示「非会员」会让人以为他一点权益都没有。
 */
function memberLabel(row: Customer): string {
  if (membershipState(row) === 'active') return MEMBER_NAME
  const free = freeDaysLeft(row)
  if (free !== null) return `免费 ${free} 天`
  if (membershipState(row) === 'expired' || freeState(row) === 'expired') return '已用完'
  return '无'
}

/** 会员绿、免费橙、用完红、从没有过灰 */
function memberTag(row: Customer): TagType {
  if (membershipState(row) === 'active') return 'success'
  if (freeDaysLeft(row) !== null) return 'warning'
  if (membershipState(row) === 'expired' || freeState(row) === 'expired') return 'danger'
  return 'info'
}

onMounted(load)
</script>

<template>
  <div class="page">
    <el-card shadow="never" class="panel">
      <div class="toolbar">
        <el-input
          v-model="query.keyword"
          class="search"
          placeholder="搜邮箱、昵称或邀请码"
          :prefix-icon="Search"
          clearable
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.status" class="status" @change="search">
          <el-option label="全部状态" value="" />
          <el-option :label="CUSTOMER_STATUS_LABEL.active" value="active" />
          <el-option :label="CUSTOMER_STATUS_LABEL.banned" value="banned" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <div class="spacer" />
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="dialogs?.openCreate()">新增客户</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <el-table v-loading="loading" :data="rows" stripe @row-dblclick="openDetail">
        <el-table-column prop="id" label="ID" width="56" />
        <el-table-column label="昵称" width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="who">
              <img v-if="row.avatar" class="avatar" :src="row.avatar" alt="" />
              <span v-else class="avatar">{{ row.nickname.slice(0, 1) }}</span>
              <span class="nick">{{ row.nickname }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="140" show-overflow-tooltip />
        <el-table-column label="邀请码" width="120">
          <template #default="{ row }">
            <span v-if="row.inviteCode" class="mono">{{ row.inviteCode }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="76">
          <template #default="{ row }">
            <el-tag :type="CUSTOMER_STATUS_TAG[row.status as CustomerStatus]" size="small" disable-transitions>
              {{ CUSTOMER_STATUS_LABEL[row.status as CustomerStatus] }}
            </el-tag>
            <el-tooltip v-if="row.banReason" :content="dict.labelOf('ban_reason', row.banReason)" placement="top">
              <span class="reason">原因</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="当前权益" width="104">
          <template #default="{ row }">
            <el-tag :type="memberTag(row)" size="small" disable-transitions>{{ memberLabel(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="会员到期" width="132">
          <template #default="{ row }">
            <span v-if="membershipState(row) === 'none'" class="muted">—</span>
            <span v-else :class="{ expired: membershipState(row) === 'expired' }">
              {{ formatTime(row.membershipExpireAt) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" width="138">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="最后登录" min-width="118">
          <template #default="{ row }">
            <span v-if="row.lastLoginAt" :title="formatTime(row.lastLoginAt)">{{ formatDay(row.lastLoginAt) }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="216" fixed="right" class-name="op-col">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            <el-button link type="primary" @click="dialogs?.openMembership(row)">发会员</el-button>
            <el-button
              v-if="row.status === 'active'"
              link
              type="danger"
              @click="dialogs?.openBan(row)"
            >
              封禁
            </el-button>
            <el-button v-else link type="success" @click="dialogs?.submitUnban(row)">解封</el-button>
            <el-button link type="danger" @click="dialogs?.openDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.pageSize"
          :total="total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="search"
        />
      </div>
    </el-card>

    <CustomerDialogs ref="dialogs" @done="load" />
  </div>
</template>

<style scoped>
/**
 * 操作列塞了四颗链接按钮（详情 / 发会员 / 封禁 / 删除）。
 * 默认间距是 12px，四颗下来会把这列撑到 220px 以上，把「最后登录」挤到固定列底下 ——
 * 收紧到 6px、左右内边距各留 8px 就够了。
 */
.op-col :deep(.cell) {
  /* 四颗按钮必须在一行里 —— 让它换行会把整张表撑高，看上去像行高出了 bug */
  white-space: nowrap;
  padding-left: 8px;
  padding-right: 4px;
}

.op-col :deep(.el-button + .el-button) {
  margin-left: 6px;
}

.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 昵称列：头像 + 名字。没设头像就用首字占位，别让那一列忽宽忽窄 */
.who {
  display: flex;
  align-items: center;
  gap: 8px;
}

.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #eeedfe;
  color: #534ab7;
  font-size: 12px;
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

.nick {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel :deep(.el-card__body) {
  padding: 14px 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search {
  width: 258px;
}

.status {
  width: 130px;
}

.spacer {
  flex: 1;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.muted {
  color: #b4b2a9;
}

.expired {
  color: #a32d2d;
}

.reason {
  margin-left: 6px;
  font-size: 11px;
  color: #854f0b;
  border-bottom: 1px dashed #ef9f27;
  cursor: help;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
