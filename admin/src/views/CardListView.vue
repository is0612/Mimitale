<script setup lang="ts">
/**
 * 卡密 / 激活码管理
 *
 * 卡密就是客户注册时填的那个邀请码。这一页管三件事：
 *   ① 看：谁发的、谁用的、过期没
 *   ② 发：批量生成（一次最多 100 张，别手点 1000 次）
 *   ③ 收：把没用的作废掉
 *   ④ 导：把当前筛选下的卡密导成 TXT（一行一个码），直接喂发卡平台或手动发货
 *
 * 备注分类走字典 card_note —— 运营想加一个「双十一活动」不用改代码。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Plus, Refresh, Search } from '@element-plus/icons-vue'
import { createCards, fetchCards, voidCard } from '@/api/card'
import { useDictStore } from '@/stores/dict'
import { CARD_STATUS_LABEL, CARD_STATUS_TAG, formatTime } from '@/config/labels'
import type { CardStatus, InviteCard } from '@/types'

const dict = useDictStore()

const loading = ref(false)
const rows = ref<InviteCard[]>([])
const total = ref(0)

const query = reactive({
  page: 1,
  pageSize: 10,
  keyword: '',
  status: '' as CardStatus | ''
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await fetchCards({ ...query })
    rows.value = res.list
    total.value = res.total
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
  query.status = ''
  query.page = 1
  load()
}

/* ---------------- 生成 ---------------- */

const genVisible = ref(false)
const generating = ref(false)
const genForm = reactive({
  count: 10,
  /** 兑换给多少天会员 —— 这是「用了给什么」，不是卡自己的保质期 */
  days: 30,
  /** 会员等级（字典 membership_level） */
  level: 'basic',
  /** 0 = 卡永久有效（不会作废）。和上面的 days 完全是两件事 */
  expireDays: 0,
  note: ''
})

/** 字典 membership_level —— 加一档这里自动多一项 */
const levelOptions = computed(() => dict.optionsOf('membership_level'))

/** 字典 card_note —— 备注分类的快捷选项 */
const noteOptions = computed(() => dict.optionsOf('card_note'))

const genHint = computed(() => {
  const n = Number(genForm.count)
  if (!Number.isFinite(n) || n < 1) return '至少 1 张'
  if (n > 100) return '一次最多 100 张'
  const days = Number(genForm.days)
  if (!Number.isFinite(days) || days < 1 || days > 3650) return '会员天数要在 1 ~ 3650 之间'
  const level = levelOptions.value.find((o) => o.value === genForm.level)?.label ?? genForm.level
  const shelf = !genForm.expireDays ? '永久有效' : `${genForm.expireDays} 天后作废`
  return `将生成 ${n} 张：兑换得「${level} ${days} 天」，卡本身 ${shelf}`
})

function openGenerate(): void {
  genForm.count = 10
  genForm.days = 30
  genForm.level = levelOptions.value[0]?.value ?? 'basic'
  genForm.expireDays = 0
  genForm.note = noteOptions.value[0]?.value ?? ''
  genVisible.value = true
}

/* 生成结果 */
const resultVisible = ref(false)
const createdCodes = ref<string[]>([])

async function submitGenerate(): Promise<void> {
  const count = Number(genForm.count)
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    ElMessage.warning('数量要在 1 ~ 100 之间')
    return
  }
  generating.value = true
  try {
    const res = await createCards({
      count: Math.floor(count),
      days: Math.floor(Number(genForm.days)),
      level: genForm.level,
      expireDays: genForm.expireDays ? Number(genForm.expireDays) : null,
      note: genForm.note
    })
    createdCodes.value = res.created.map((c) => c.code)
    genVisible.value = false
    resultVisible.value = true
    load()
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    generating.value = false
  }
}

/* ---------------- 导出 ---------------- */

/** 一次最多导多少张。真要几万张时应该先按备注/状态收窄，而不是把浏览器拉爆 */
const EXPORT_MAX = 5000

const exporting = ref(false)

/** 文件名里的时间戳：20261028-1519 */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * 把**当前筛选条件下的卡密**导成一个 TXT，一行一个码 —— 直接能喂给发卡平台的批量导入，
 * 也能拿去手动发货。
 *
 * ⚠️ 导的是「全部页」不是「这一页」：导出本来就是为了把码整批交出去，只导 10 条等于没做。
 * ⚠️ 走列表接口循环拉（pageSize 上限 100），所以有 EXPORT_MAX 兜底。
 * ⚠️ 状态筛选是「全部」时**只导未使用且没过期**的：已用 / 作废的码发给买家会撞号，
 *    过期的码买家填了会被服务端拒 —— 这两种混进去只会变成售后。
 *    真的要导已用/作废的对账，把状态筛选选成那个状态再点导出。
 * ⚠️ 不加 BOM。码是纯 ASCII，加了 BOM 反而会让第一张码变成 `\ufeffMIMI-...`，
 *    发卡平台读进去就是一张废卡。换行用 \r\n —— 记事本和老导入工具都认。
 */
async function exportCodes(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const picked: InviteCard[] = []
    for (let page = 1; page <= Math.ceil(EXPORT_MAX / 100); page += 1) {
      const res = await fetchCards({ ...query, page, pageSize: 100 })
      picked.push(...res.list)
      if (res.list.length === 0 || picked.length >= res.total) break
    }

    const clipped = picked.slice(0, EXPORT_MAX)
    // 选「全部」→ 只留还能卖的；选了具体状态 → 就按他选的来
    const onlyUsable = query.status === ''
    const kept = onlyUsable
      ? clipped.filter((c) => c.status === 'unused' && !isExpired(c))
      : clipped
    const expired = onlyUsable ? clipped.filter((c) => c.status === 'unused' && isExpired(c)).length : 0

    if (kept.length === 0) {
      ElMessage.warning(
        expired > 0
          ? `没有可用的卡密（有 ${expired} 张已过期，先在列表里作废掉）`
          : '当前筛选下没有卡密'
      )
      return
    }

    const text = kept.map(c => c.code).join('\r\n') + '\r\n'
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `卡密-${kept.length}张-${stamp()}.txt`
    document.body.append(a)
    a.click()
    a.remove()
    // 立刻 revoke 有的浏览器会拿不到内容，等一下再收
    setTimeout(() => URL.revokeObjectURL(url), 1000)

    const skipped: string[] = []
    if (clipped.length > kept.length) {
      const usedOrVoid = clipped.filter((c) => c.status !== 'unused').length
      if (usedOrVoid > 0) skipped.push(`${usedOrVoid} 张已用/作废`)
      if (expired > 0) skipped.push(`${expired} 张已过期`)
    }
    ElMessage.success(
      `导出 ${kept.length} 张` + (skipped.length > 0 ? `（跳过 ${skipped.join('、')}）` : '')
    )
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    exporting.value = false
  }
}

/* ---------------- 复制 ---------------- */

async function copy(text: string, tip = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(tip)
  } catch {
    ElMessage.warning('浏览器不让自动复制，手动选中吧')
  }
}

/* ---------------- 作废 ---------------- */

async function doVoid(row: InviteCard): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定作废卡密「${row.code}」吗？作废后不能再用，也不能恢复。`,
      '提示',
      { confirmButtonText: '作废', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await voidCard(row.id)
    ElMessage.success('已作废')
    load()
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

/** 过期了但还没人用 —— 列表里标一下，方便批量作废 */
function isExpired(row: InviteCard): boolean {
  if (!row.expireAt || row.status !== 'unused') return false
  return Date.parse(row.expireAt) < Date.now()
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
          placeholder="搜卡密、使用者邮箱或备注"
          :prefix-icon="Search"
          clearable
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="query.status" class="status" @change="search">
          <el-option label="全部状态" value="" />
          <el-option :label="CARD_STATUS_LABEL.unused" value="unused" />
          <el-option :label="CARD_STATUS_LABEL.used" value="used" />
          <el-option :label="CARD_STATUS_LABEL.void" value="void" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <div class="spacer" />
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button :icon="Download" :loading="exporting" @click="exportCodes">导出</el-button>
        <el-button type="primary" :icon="Plus" @click="openGenerate">生成卡密</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="panel">
      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column label="卡密" width="176">
          <template #default="{ row }">
            <span class="code">{{ row.code }}</span>
          </template>
        </el-table-column>
        <el-table-column label="兑换得" width="140">
          <template #default="{ row }">
            <span class="grant">{{ dict.labelOf('membership_level', row.level) }} · {{ row.days }} 天</span>
          </template>
        </el-table-column>
        <el-table-column label="备注" width="110">
          <template #default="{ row }">{{ row.note }}</template>
        </el-table-column>
        <el-table-column label="状态" width="106">
          <template #default="{ row }">
            <span class="status-cell">
              <el-tag :type="CARD_STATUS_TAG[row.status as CardStatus]" size="small" disable-transitions>
                {{ CARD_STATUS_LABEL[row.status as CardStatus] }}
              </el-tag>
              <el-tooltip v-if="isExpired(row)" content="已过有效期，但还没被使用" placement="top">
                <span class="expired">过期</span>
              </el-tooltip>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="使用者" min-width="186" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.usedByEmail">{{ row.usedByEmail }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="生成时间" width="146">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="有效期" width="146">
          <template #default="{ row }">
            <span v-if="row.expireAt" :class="{ expired: isExpired(row) }">{{ formatTime(row.expireAt) }}</span>
            <span v-else class="muted">永久</span>
          </template>
        </el-table-column>
        <el-table-column label="使用时间" width="146">
          <template #default="{ row }">{{ formatTime(row.usedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="112" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="copy(row.code)">复制</el-button>
            <el-button v-if="row.status === 'unused'" link type="danger" @click="doVoid(row)">作废</el-button>
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

    <!-- 批量生成 -->
    <el-dialog v-model="genVisible" title="生成卡密" width="460px">
      <div class="dlg-body">
        <div class="dlg-label">生成数量</div>
        <el-input v-model.number="genForm.count" placeholder="1 ~ 100" />

        <!-- 这一组是「用了给什么」。⚠️ 和下面的「卡密有效期」是两件事，
             原来的标签只写「有效期」，看着像「这张卡值多久」，容易误会 -->
        <div class="dlg-label">兑换得什么</div>
        <div class="pair">
          <el-select v-model="genForm.level" placeholder="会员等级" class="pair-level">
            <el-option v-for="o in levelOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-input v-model.number="genForm.days" class="pair-days">
            <template #append>天</template>
          </el-input>
        </div>

        <div class="dlg-label">卡密有效期（没被用掉的话，多久后作废）</div>
        <el-select v-model="genForm.expireDays" style="width: 100%">
          <el-option label="永久有效" :value="0" />
          <el-option label="30 天" :value="30" />
          <el-option label="90 天" :value="90" />
          <el-option label="180 天" :value="180" />
          <el-option label="365 天" :value="365" />
        </el-select>
        <div class="dlg-label">备注分类</div>
        <el-select v-model="genForm.note" placeholder="选一个分类" style="width: 100%">
          <el-option v-for="o in noteOptions" :key="o.value" :label="o.label" :value="o.label" />
        </el-select>
        <div class="hint">{{ genHint }}</div>
      </div>
      <template #footer>
        <el-button @click="genVisible = false">取消</el-button>
        <el-button type="primary" :loading="generating" @click="submitGenerate">生成</el-button>
      </template>
    </el-dialog>

    <!-- 生成结果 -->
    <el-dialog v-model="resultVisible" title="生成好了" width="460px">
      <div class="dlg-body">
        <div class="hint ok">
          共 {{ createdCodes.length }} 张，状态是「未使用」。发给客户让他们注册时填。
        </div>
        <div class="codes">
          <div v-for="code in createdCodes" :key="code" class="code-row">
            <span class="mono">{{ code }}</span>
            <el-button link type="primary" @click="copy(code)">复制</el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="copy(createdCodes.join('\n'), `已复制 ${createdCodes.length} 张`)">
          复制全部
        </el-button>
        <el-button type="primary" @click="resultVisible = false">知道了</el-button>
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

.status {
  width: 130px;
}

.spacer {
  flex: 1;
}

/**
 * 卡密码 —— 这一行的**主内容**，不是配角。
 *
 * ⚠️ 原来这里是 `.mono` 覆盖成 12px，还带着一句 `font-family: var(--font-mono)`：
 *    那个变量当时根本不存在，整条 font-family 失效，码其实是用黑体渲染的。
 *    结果就是「这页的字怎么这么小、还看不出是码」。
 * ⚠️ 现在用正文字号（14px）+ 等宽字体，跟表格其它列一样大但不靠加粗抢戏 ——
 *    次级信息（备注 / 状态 / 时间）本来就靠颜色和字重退后了。
 */
.code {
  font-family: var(--font-mono);
  font-size: 14px;
  /* 等宽码本身偏散，稍微收一点字距更好成词；别收太多，否则 M 和 W 会挤 */
  letter-spacing: -0.01em;
  color: var(--text-main);
}

.grant {
  font-size: 13px;
  color: var(--text-sub);
}

.muted {
  /* 占位符也要能看清：原来的 #b4b2a9 在白色上只有 1.9:1，是「看不清」不是「低调」 */
  color: var(--text-sub);
}

.expired {
  color: #a32d2d;
  font-size: 12px;
}

.status-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pair {
  display: flex;
  gap: 8px;
}

.pair-level {
  flex: 1;
}

.pair-days {
  width: 132px;
}

.dlg-label {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 4px;
}

.hint {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
  margin-top: 4px;
}

.hint.ok {
  color: #0f6e56;
  background: #e1f5ee;
  border-radius: 8px;
  padding: 9px 11px;
  margin-top: 0;
}

.codes {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-top: 6px;
}

.code-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 11px;
  border-bottom: 1px solid var(--line);
}

.code-row:last-child {
  border-bottom: none;
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
