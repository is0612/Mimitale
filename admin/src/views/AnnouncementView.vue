<script setup lang="ts">
/**
 * 通知公告 —— 运营写一条，客户端启动时拉下来显示在聊天页上方的横条里
 *
 * 三件要理解的事：
 *   ① 「此刻会不会显示」= enabled + 生效时间 + 失效时间，**现算**，库里没有 visible 字段。
 *      所以下架只是把开关关掉，历史已读记录不动（重新上架不会又变成未读）。
 *   ② 置顶的排在前面：客户端横条最多同时显示 2 条，得先显示最要紧的。
 *   ③ 下架 ≠ 删除。下架是「先别显示了」，删掉是真的没了（已读记录一起清）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bell, Plus, Refresh, Search } from '@element-plus/icons-vue'
import { createAnnouncement, deleteAnnouncement, fetchAnnouncements, updateAnnouncement } from '@/api/announcement'
import { ANNOUNCEMENT_LEVEL_LABEL, ANNOUNCEMENT_LEVEL_TAG, formatTime } from '@/config/labels'
import type { Announcement, AnnouncementLevel, CreateAnnouncementReq } from '@/types'

const loading = ref(false)
const rows = ref<Announcement[]>([])
const total = ref(0)
const liveCount = ref(0)

const query = reactive({
  page: 1,
  pageSize: 10,
  keyword: '',
  enabled: '' as '' | '1' | '0'
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await fetchAnnouncements({ ...query })
    rows.value = res.list
    total.value = res.total
    liveCount.value = res.liveCount
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    loading.value = false
  }
}

function search(): void {
  query.page = 1
  load()
}

function reset(): void {
  query.keyword = ''
  query.enabled = ''
  query.page = 1
  load()
}

/* ---------------- 状态推导 ---------------- */

type LiveState = 'live' | 'off' | 'pending' | 'expired'

function stateOf(row: Announcement): LiveState {
  if (!row.enabled) return 'off'
  const now = Date.now()
  if (row.startsAt && Date.parse(row.startsAt) > now) return 'pending'
  if (row.endsAt && Date.parse(row.endsAt) < now) return 'expired'
  return 'live'
}

const STATE_LABEL: Record<LiveState, string> = {
  live: '在架',
  off: '已下架',
  pending: '未生效',
  expired: '已过期'
}

const STATE_TAG: Record<LiveState, 'success' | 'info' | 'warning' | 'danger'> = {
  live: 'success',
  off: 'info',
  pending: 'warning',
  expired: 'danger'
}

/* ---------------- 新建 / 编辑 ---------------- */

const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)

const form = reactive({
  title: '',
  content: '',
  level: 'normal' as AnnouncementLevel,
  pinned: false,
  /** null = 立刻生效 / 永不失效 */
  startsAt: null as Date | null,
  endsAt: null as Date | null
})

const dialogTitle = computed(() => (editingId.value === null ? '发公告' : '改公告'))

function openCreate(): void {
  editingId.value = null
  form.title = ''
  form.content = ''
  form.level = 'normal'
  form.pinned = false
  form.startsAt = null
  form.endsAt = null
  dialogVisible.value = true
}

function openEdit(row: Announcement): void {
  editingId.value = row.id
  form.title = row.title
  form.content = row.content
  form.level = row.level
  form.pinned = row.pinned
  form.startsAt = row.startsAt ? new Date(row.startsAt) : null
  form.endsAt = row.endsAt ? new Date(row.endsAt) : null
  dialogVisible.value = true
}

/** 前端先挡一道，省得为了一个「时间反了」跑一次网络 */
const timeError = computed(() => {
  if (form.startsAt && form.endsAt && form.startsAt.getTime() >= form.endsAt.getTime()) {
    return '失效时间要晚于生效时间'
  }
  return ''
})

async function submit(): Promise<void> {
  if (!form.title.trim()) {
    ElMessage.warning('标题不能空')
    return
  }
  if (!form.content.trim()) {
    ElMessage.warning('正文不能空')
    return
  }
  if (timeError.value) {
    ElMessage.warning(timeError.value)
    return
  }

  const payload: CreateAnnouncementReq = {
    title: form.title.trim(),
    content: form.content.trim(),
    level: form.level,
    pinned: form.pinned,
    startsAt: form.startsAt ? form.startsAt.toISOString() : null,
    endsAt: form.endsAt ? form.endsAt.toISOString() : null
  }

  saving.value = true
  try {
    if (editingId.value === null) {
      await createAnnouncement(payload)
      ElMessage.success('已发出，客户端下次启动就能看到')
    } else {
      await updateAnnouncement(editingId.value, payload)
      ElMessage.success('已保存')
    }
    dialogVisible.value = false
    load()
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    saving.value = false
  }
}

/* ---------------- 上下架 / 删除 ---------------- */

async function toggleEnabled(row: Announcement): Promise<void> {
  try {
    await updateAnnouncement(row.id, { enabled: !row.enabled })
    ElMessage.success(row.enabled ? '已下架，客户端拉不到了' : '已上架')
    load()
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

async function remove(row: Announcement): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删掉「${row.title}」吗？删了之后已读记录也会一起清掉，且不能恢复。`,
      '提示',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await deleteAnnouncement(row.id)
    ElMessage.success('已删除')
    load()
  } catch {
    // 错误提示已在请求层统一处理
  }
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
          placeholder="搜标题或正文"
          :prefix-icon="Search"
          clearable
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.enabled" class="narrow" placeholder="全部" @change="search">
          <el-option label="全部" value="" />
          <el-option label="在架" value="1" />
          <el-option label="已下架" value="0" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <div class="spacer" />
        <span class="live-hint">
          <el-icon><Bell /></el-icon>
          此刻客户端能看到 {{ liveCount }} 条
        </span>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">发公告</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column prop="id" label="ID" width="62" />
        <el-table-column label="标题" min-width="220">
          <template #default="{ row }">
            <span v-if="row.pinned" class="pin" title="置顶">置顶</span>
            <span class="title-text">{{ row.title }}</span>
            <div class="sub">{{ row.content }}</div>
          </template>
        </el-table-column>
        <el-table-column label="级别" width="82">
          <template #default="{ row }">
            <el-tag
              :type="ANNOUNCEMENT_LEVEL_TAG[row.level as AnnouncementLevel]"
              size="small"
              disable-transitions
            >
              {{ ANNOUNCEMENT_LEVEL_LABEL[row.level as AnnouncementLevel] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="88">
          <template #default="{ row }">
            <el-tag :type="STATE_TAG[stateOf(row)]" size="small" disable-transitions>
              {{ STATE_LABEL[stateOf(row)] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="有效期" width="182">
          <template #default="{ row }">
            <!-- 没设生效时间就是「立即生效」，别显示成「— 起」那种读不通的东西 -->
            <div class="range">{{ row.startsAt ? `${formatTime(row.startsAt)} 起` : '立即生效' }}</div>
            <div class="range sub">
              {{ row.endsAt ? `${formatTime(row.endsAt)} 止` : '永久有效' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="发布人" width="96">
          <template #default="{ row }">{{ row.authorName || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="164" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link :type="row.enabled ? 'warning' : 'success'" @click="toggleEnabled(row)">
              {{ row.enabled ? '下架' : '上架' }}
            </el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
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

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="600px">
      <div class="dlg-body">
        <div class="dlg-label">标题</div>
        <el-input v-model="form.title" maxlength="60" show-word-limit placeholder="例：v1.5 更新，世界书支持按段排序" />

        <div class="dlg-label">正文</div>
        <el-input
          v-model="form.content"
          type="textarea"
          :rows="6"
          maxlength="4000"
          show-word-limit
          placeholder="客户端横条只显示首行，点开才看全文。换行会被保留。"
        />

        <div class="row2">
          <div class="col">
            <div class="dlg-label">级别</div>
            <el-radio-group v-model="form.level">
              <el-radio-button value="normal">普通</el-radio-button>
              <el-radio-button value="important">重要</el-radio-button>
              <el-radio-button value="maintenance">维护</el-radio-button>
            </el-radio-group>
          </div>
          <div class="col">
            <div class="dlg-label">置顶</div>
            <el-switch v-model="form.pinned" active-text="优先显示" />
          </div>
        </div>

        <div class="row2">
          <div class="col">
            <div class="dlg-label">生效时间</div>
            <el-date-picker
              v-model="form.startsAt"
              type="datetime"
              placeholder="留空 = 立刻生效"
              style="width: 100%"
            />
          </div>
          <div class="col">
            <div class="dlg-label">失效时间</div>
            <el-date-picker
              v-model="form.endsAt"
              type="datetime"
              placeholder="留空 = 永不失效"
              style="width: 100%"
            />
          </div>
        </div>

        <div v-if="timeError" class="hint err">{{ timeError }}</div>
        <div v-else class="hint">
          级别只影响客户端横条的颜色和图标（重要=红、维护=琥珀、普通=灰）。
          下架不算删除：重新上架后，看过的人不会再算未读。
        </div>
      </div>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">
          {{ editingId === null ? '发出去' : '保存' }}
        </el-button>
      </template>
    </el-dialog>
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
  width: 108px;
}

.spacer {
  flex: 1;
}

.live-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-sub);
  margin-right: 2px;
}

.pin {
  display: inline-block;
  margin-right: 6px;
  padding: 0 5px;
  border-radius: 3px;
  background: rgba(138, 109, 47, 0.12);
  color: #8a6d2f;
  font-size: 11px;
  line-height: 17px;
  vertical-align: 1px;
}

.title-text {
  font-weight: 500;
}

.sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
}

.range {
  font-size: 12px;
  line-height: 1.6;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dlg-label {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 8px;
  margin-bottom: 6px;
}

.row2 {
  display: flex;
  gap: 14px;
}

.row2 .col {
  flex: 1;
  min-width: 0;
}

.hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.7;
}

.hint.err {
  color: #a32d2d;
  margin-top: 8px;
}
</style>
