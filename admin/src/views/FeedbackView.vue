<script setup lang="ts">
/**
 * 意见反馈 —— 客户端用户点「意见反馈」写的那段话
 *
 * 这一页只干三件事：
 *   ① 看：谁、什么时候、什么版本、写了什么
 *   ② 标：待处理 → 已查看 → 已处理 / 已忽略
 *   ③ 记：写一句给自己看的内部备注（**不会回传给用户**）
 *
 * ⚠️ 刻意**没有编辑正文**的地方：改了就是伪造用户发言。要回复用户，
 *    目前没有渠道（客户端没有收回复的地方），所以状态机里也没有「已回复」这一档。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import { fetchFeedbacks, updateFeedback } from '@/api/feedback'
import {
  FEEDBACK_KIND_LABEL,
  FEEDBACK_KIND_OPTIONS,
  FEEDBACK_KIND_TAG,
  FEEDBACK_STATUS_LABEL,
  FEEDBACK_STATUS_OPTIONS,
  FEEDBACK_STATUS_TAG,
  formatTime
} from '@/config/labels'
import type { Feedback, FeedbackCounts, FeedbackKind, FeedbackStatus } from '@/types'

const loading = ref(false)
const rows = ref<Feedback[]>([])
const total = ref(0)
const counts = ref<FeedbackCounts>({ total: 0, pending: 0, read: 0, resolved: 0, ignored: 0, today: 0 })

const query = reactive({
  page: 1,
  pageSize: 10,
  keyword: '',
  kind: '' as FeedbackKind | '',
  status: '' as FeedbackStatus | ''
})

let loadSequence = 0
async function load(): Promise<void> {
  const sequence = ++loadSequence
  loading.value = true
  try {
    const res = await fetchFeedbacks({ ...query })
    if (sequence !== loadSequence) return
    // 标记已读/处理后，当前筛选的最后一页可能变空，退到仍存在的页再查。
    const lastPage = Math.max(1, Math.ceil(res.total / query.pageSize))
    if (query.page > lastPage) {
      query.page = lastPage
      await load()
      return
    }
    rows.value = res.list
    total.value = res.total
    counts.value = res.counts
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
  query.kind = ''
  query.status = ''
  query.page = 1
  load()
}

/** 点顶部那颗数字 = 按这个状态筛。再点一下取消筛选 */
function filterBy(status: FeedbackStatus): void {
  query.status = query.status === status ? '' : status
  search()
}

/* ---------------- 处理 ---------------- */

const detailVisible = ref(false)
const saving = ref(false)
const current = ref<Feedback | null>(null)
const form = reactive({
  status: 'pending' as FeedbackStatus,
  note: ''
})

function openDetail(row: Feedback): void {
  current.value = row
  form.status = row.status
  form.note = row.note
  detailVisible.value = true
}

/**
 * 打开详情就算「看过了」：待处理 → 已查看。
 * 不这么做的话，列表里永远一堆「待处理」，其实你早看完了只是没点按钮。
 */
const markingSeen = new Map<number, Promise<void>>()
let detailSequence = 0
async function markSeen(row: Feedback): Promise<void> {
  const selection = ++detailSequence
  let pending = markingSeen.get(row.id)
  if (!pending && row.status === 'pending') {
    // 使先前查询失效；否则它可能把已标记的旧行重新放回筛选列表。
    loadSequence += 1
    pending = (async () => {
      const updated = await updateFeedback(row.id, { status: 'read' })
      Object.assign(row, updated)
      // 列表和计数以服务端为准；pending 筛选下已读行要移出，分页也需重算。
      await load()
    })()
    markingSeen.set(row.id, pending)
    pending.then(() => markingSeen.delete(row.id), () => markingSeen.delete(row.id))
  }
  try {
    if (pending) await pending
  } catch {
    // 标记失败也照样让人看详情 —— 不能因为一次写库失败就打不开
    await load()
  }
  // 快速点击不同反馈时，较慢的旧请求不能抢回后点的详情。
  if (selection === detailSequence) openDetail(row)
}

async function save(): Promise<void> {
  const row = current.value
  if (!row) return

  const changed = form.status !== row.status || form.note !== row.note
  if (!changed) {
    ElMessage.info('没改动')
    return
  }

  saving.value = true
  try {
    const updated = await updateFeedback(row.id, { status: form.status, note: form.note })
    Object.assign(row, updated)
    detailVisible.value = false
    ElMessage.success('已保存')
    await load()
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    saving.value = false
  }
}

/** 抽屉里那三个快捷动作：处理完 / 不打算处理 */
async function quickStatus(status: FeedbackStatus): Promise<void> {
  form.status = status
  await save()
}

const detail = computed(() => current.value)

/** 「来自谁」：登录用户有邮箱昵称，匿名就明说匿名，别留个空白让人猜 */
function fromWho(row: Feedback): string {
  if (row.contactEmail && row.contactName) return `${row.contactName} · ${row.contactEmail}`
  if (row.contactEmail) return row.contactEmail
  if (row.customerId) return `客户 #${row.customerId}`
  return '未登录（匿名）'
}

onMounted(load)
</script>

<template>
  <div class="page">
    <!-- 状态计数条：点一下就按那个状态筛，再点取消 -->
    <el-card shadow="never" class="panel">
      <div class="stats">
        <button
          v-for="s in FEEDBACK_STATUS_OPTIONS"
          :key="s"
          class="stat"
          :class="{ on: query.status === s, [`st-${s}`]: true }"
          @click="filterBy(s)"
        >
          <span class="stat-n">{{ counts[s] }}</span>
          <span class="stat-l">{{ FEEDBACK_STATUS_LABEL[s] }}</span>
        </button>
        <div class="stat static">
          <span class="stat-n">{{ counts.today }}</span>
          <span class="stat-l">今日收到</span>
        </div>
        <div class="spacer" />
        <span class="total-hint">累计 {{ counts.total }} 条</span>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <div class="toolbar">
        <el-input
          v-model="query.keyword"
          class="search"
          placeholder="搜正文、邮箱或昵称"
          :prefix-icon="Search"
          clearable
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.kind" class="narrow" placeholder="全部类型" @change="search">
          <el-option label="全部类型" value="" />
          <el-option
            v-for="k in FEEDBACK_KIND_OPTIONS"
            :key="k"
            :label="FEEDBACK_KIND_LABEL[k]"
            :value="k"
          />
        </el-select>
        <el-select v-model="query.status" class="narrow" placeholder="全部状态" @change="search">
          <el-option label="全部状态" value="" />
          <el-option
            v-for="s in FEEDBACK_STATUS_OPTIONS"
            :key="s"
            :label="FEEDBACK_STATUS_LABEL[s]"
            :value="s"
          />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <div class="spacer" />
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <el-table v-loading="loading" :data="rows" stripe @row-click="markSeen">
        <el-table-column prop="id" label="ID" width="62" />
        <el-table-column label="类型" width="82">
          <template #default="{ row }">
            <el-tag :type="FEEDBACK_KIND_TAG[row.kind as FeedbackKind]" size="small" disable-transitions>
              {{ FEEDBACK_KIND_LABEL[row.kind as FeedbackKind] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="88">
          <template #default="{ row }">
            <el-tag :type="FEEDBACK_STATUS_TAG[row.status as FeedbackStatus]" size="small" disable-transitions>
              {{ FEEDBACK_STATUS_LABEL[row.status as FeedbackStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="反馈内容" min-width="300">
          <template #default="{ row }">
            <div class="clamp">{{ row.content }}</div>
            <div v-if="row.note" class="note-line">备注：{{ row.note }}</div>
          </template>
        </el-table-column>
        <el-table-column label="来自" width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span :class="{ muted: !row.contactEmail }">{{ fromWho(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="版本" width="106">
          <template #default="{ row }">
            <span class="mono">{{ row.appVersion || '—' }}</span>
            <span v-if="row.platform" class="plat">{{ row.platform }}</span>
          </template>
        </el-table-column>
        <el-table-column label="提交时间" width="146">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="76" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="markSeen(row)">处理</el-button>
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

    <!-- 详情抽屉：左边原文，右边处理和备注 -->
    <el-drawer v-model="detailVisible" title="反馈详情" size="560px">
      <div v-if="detail" class="detail">
        <div class="meta">
          <el-tag :type="FEEDBACK_KIND_TAG[detail.kind]" size="small" disable-transitions>
            {{ FEEDBACK_KIND_LABEL[detail.kind] }}
          </el-tag>
          <el-tag :type="FEEDBACK_STATUS_TAG[detail.status]" size="small" disable-transitions>
            {{ FEEDBACK_STATUS_LABEL[detail.status] }}
          </el-tag>
          <span class="meta-text">#{{ detail.id }} · {{ formatTime(detail.createdAt) }}</span>
        </div>

        <div class="content-box">{{ detail.content }}</div>

        <div class="kv">
          <div class="k">来自</div>
          <div class="v">{{ fromWho(detail) }}</div>
        </div>
        <div class="kv">
          <div class="k">客户端</div>
          <div class="v">
            {{ detail.appVersion || '版本未知' }}<span v-if="detail.platform"> · {{ detail.platform }}</span>
          </div>
        </div>
        <div v-if="detail.handledBy" class="kv">
          <div class="k">上次处理</div>
          <div class="v">{{ detail.handledBy }} · {{ formatTime(detail.handledAt) }}</div>
        </div>

        <el-divider />

        <div class="field-label">状态</div>
        <el-radio-group v-model="form.status">
          <el-radio-button v-for="s in FEEDBACK_STATUS_OPTIONS" :key="s" :value="s">
            {{ FEEDBACK_STATUS_LABEL[s] }}
          </el-radio-button>
        </el-radio-group>

        <div class="field-label">内部备注</div>
        <el-input
          v-model="form.note"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
          placeholder="只给自己看，不会回传给用户"
        />
        <div class="hint">
          备注不会发给用户 —— 客户端目前没有收回复的地方。要联系本人，按上面的邮箱写邮件。
        </div>
      </div>

      <template #footer>
        <div class="drawer-foot">
          <el-button @click="quickStatus('ignored')">不处理</el-button>
          <el-button type="success" @click="quickStatus('resolved')">标记已处理</el-button>
          <div class="spacer" />
          <el-button @click="detailVisible = false">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel :deep(.el-card__body) {
  padding: 14px 16px;
}

/* 状态计数条 */
.stats {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 78px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: border-color 0.12s, background 0.12s;
}

.stat:hover {
  border-color: #c9c7bd;
}

.stat.on {
  border-color: #8a6d2f;
  background: rgba(138, 109, 47, 0.07);
}

.stat.static {
  cursor: default;
}

.stat-n {
  font-size: 19px;
  font-weight: 600;
  line-height: 1.1;
}

.stat-l {
  font-size: 12px;
  color: var(--text-sub);
}

/* 待处理的数字标红一点，一眼能找到 */
.st-pending .stat-n {
  color: #a32d2d;
}

.st-resolved .stat-n {
  color: #0f6e56;
}

.total-hint {
  font-size: 12px;
  color: var(--text-sub);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search {
  width: 248px;
}

.narrow {
  width: 122px;
}

.spacer {
  flex: 1;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.plat {
  display: block;
  font-size: 11px;
  color: var(--text-sub);
}

.muted {
  color: #b4b2a9;
}

/* 表格里正文最多两行，超了省略 —— 全文去抽屉里看 */
.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.55;
  word-break: break-word;
}

.note-line {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-sub);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

/* 抽屉 */
.detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.meta-text {
  font-size: 12px;
  color: var(--text-sub);
}

.content-box {
  margin: 8px 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #faf9f6;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}

.kv {
  display: flex;
  gap: 10px;
  font-size: 13px;
  line-height: 1.9;
}

.kv .k {
  width: 68px;
  flex: none;
  color: var(--text-sub);
}

.kv .v {
  word-break: break-all;
}

.field-label {
  font-size: 12px;
  color: var(--text-sub);
  margin: 8px 0 6px;
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.7;
}

.drawer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
