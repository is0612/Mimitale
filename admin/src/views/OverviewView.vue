<script setup lang="ts">
/**
 * 概览 —— 打开后台第一眼该看到的东西。
 *
 * 这个页面存在的唯一理由：客户列表回答不了「今天注册了几个」。
 * 三个数字要一眼可见：今天新增多少、会员还剩多少、谁快到期该催了。
 *
 * ⚠️ 「今天」是**北京时间**的今天，由后端算好再给。
 *    前端不要自己拿 new Date() 算日期去对比 —— 用户机器时区不一定对。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { fetchOverview } from '@/api/overview'
import type { OverviewRes } from '@/types'

const router = useRouter()

const data = ref<OverviewRes | null>(null)
const loading = ref(true)
const failed = ref(false)

async function load(): Promise<void> {
  loading.value = true
  failed.value = false
  try {
    data.value = await fetchOverview()
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** 今天比昨天多几个（负数是少了） */
const delta = computed(() => {
  if (!data.value) return 0
  return data.value.todayRegistered - data.value.yesterdayRegistered
})

/** 柱状图的最大高度基准。全是 0 的时候给 1，别除以 0 */
const trendMax = computed(() => Math.max(1, ...(data.value?.trend ?? []).map((t) => t.count)))

/** 趋势里最后一天（今天）高亮 */
const todayKey = computed(() => data.value?.trend?.at(-1)?.day ?? '')

/** 会员续费比例，用来做进度条 */
const memberRate = computed(() => {
  const total = data.value?.memberTotal ?? 0
  const active = data.value?.activeMembers ?? 0
  if (total === 0) return 0
  return Math.round((active / total) * 100)
})

function shortDay(day: string): string {
  // '2026-10-27' → '10-27'
  return day.slice(5)
}

function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

function goCustomer(id: number): void {
  router.push(`/customers/${id}`)
}
</script>

<template>
  <div v-loading="loading" class="overview">
    <el-alert
      v-if="failed"
      type="error"
      :closable="false"
      show-icon
      title="概览数据拉不到"
      description="后端起来了吗？确认 server 在 8080 上跑着，然后点下面的刷新。"
    >
      <template #default>
        <div style="margin-top: 8px">
          <el-button size="small" @click="load">重新加载</el-button>
        </div>
      </template>
    </el-alert>

    <template v-if="data">
      <!-- 四个数字：今天新增 / 总客户 / 生效会员 / 该催的 -->
      <div class="stat-row">
        <div class="stat-card stat-card--accent">
          <div class="stat-label">今日新增</div>
          <div class="stat-value">{{ data.todayRegistered }}</div>
          <div class="stat-foot">
            <span v-if="delta > 0" class="up">比昨天多 {{ delta }} 个</span>
            <span v-else-if="delta < 0" class="down">比昨天少 {{ -delta }} 个</span>
            <span v-else class="flat">和昨天一样</span>
            <span class="dim">· 昨天 {{ data.yesterdayRegistered }}</span>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-label">总客户</div>
          <div class="stat-value">{{ data.totalCustomers }}</div>
          <div class="stat-foot">
            <span class="dim">其中 {{ data.bannedCustomers }} 个被封禁</span>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-label">生效会员</div>
          <div class="stat-value">{{ data.activeMembers }}</div>
          <div class="stat-foot">
            <span class="dim">发过会员的一共 {{ data.memberTotal }} 个</span>
            <el-progress
              v-if="data.memberTotal > 0"
              :percentage="memberRate"
              :stroke-width="3"
              :show-text="false"
              style="margin-top: 6px"
            />
          </div>
        </div>

        <div class="stat-card" :class="{ 'stat-card--warn': data.expiringIn7Days > 0 }">
          <div class="stat-label">7 天内到期</div>
          <div class="stat-value">{{ data.expiringIn7Days }}</div>
          <div class="stat-foot">
            <span v-if="data.expiringIn7Days > 0" class="warn">这批该催续费了</span>
            <span v-else class="dim">暂时没人到期</span>
          </div>
        </div>
      </div>

      <div class="overview-grid">
        <!-- 近 7 天注册 -->
        <section class="panel">
          <header class="panel-head">
            <h3>近 7 天注册</h3>
            <span class="dim">共 {{ data.trend.reduce((s, t) => s + t.count, 0) }} 个新号</span>
          </header>
          <div class="chart">
            <div v-for="t in data.trend" :key="t.day" class="bar-col">
              <div class="bar-wrap">
                <div
                  class="bar"
                  :class="{ 'bar--today': t.day === todayKey, 'bar--zero': t.count === 0 }"
                  :style="{ height: `${Math.max(2, (t.count / trendMax) * 100)}%` }"
                  :title="`${t.day}：${t.count} 个`"
                >
                  <span v-if="t.count > 0" class="bar-value">{{ t.count }}</span>
                </div>
              </div>
              <div class="bar-label" :class="{ 'bar-label--today': t.day === todayKey }">
                {{ shortDay(t.day) }}
              </div>
            </div>
          </div>
        </section>

        <!-- 最近注册的 5 个 -->
        <section class="panel">
          <header class="panel-head">
            <h3>最近注册</h3>
            <el-button link type="primary" size="small" @click="router.push('/customers')">
              全部客户
            </el-button>
          </header>

          <div v-if="data.recent.length === 0" class="empty">还没有客户</div>

          <ul v-else class="recent-list">
            <li v-for="c in data.recent" :key="c.id" class="recent-item" @click="goCustomer(c.id)">
              <div class="recent-main">
                <span class="recent-name">{{ c.nickname }}</span>
                <span class="recent-email">{{ c.email }}</span>
              </div>
              <div class="recent-side">
                <el-tag v-if="c.status === 'banned'" type="danger" size="small" effect="light">已封禁</el-tag>
                <el-tag v-else-if="c.membershipLevel !== 'none'" size="small" effect="light">会员</el-tag>
                <span class="dim">{{ timeAgo(c.createdAt) }}</span>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <div class="footnote">
        今天有 <strong>{{ data.todayActive }}</strong> 个客户登录过 ·
        还能发 <strong>{{ data.unusedCards }}</strong> 张卡密
        <el-button link type="primary" size="small" style="margin-left: 8px" @click="load">
          刷新
        </el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 200px;
}

/* ---------- 四个数字卡 ---------- */

.stat-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.stat-card {
  padding: 18px 20px;
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 6px;
}

.stat-card--accent {
  border-color: #c6e2ff;
  background: linear-gradient(180deg, #f2f8ff 0%, #fff 60%);
}

.stat-card--warn {
  border-color: #f5dab1;
  background: linear-gradient(180deg, #fdf6ec 0%, #fff 60%);
}

.stat-label {
  font-size: 13px;
  color: #909399;
}

.stat-value {
  margin-top: 6px;
  font-size: 30px;
  font-weight: 600;
  line-height: 1.1;
  color: #303133;
  font-variant-numeric: tabular-nums;
}

.stat-foot {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: #909399;
}

.up {
  color: #1a9c58;
}
.down {
  color: #e0674b;
}
.flat {
  color: #909399;
}
.warn {
  color: #c17f2a;
}
.dim {
  color: #a8abb2;
}

/* ---------- 图表 + 最近注册 ---------- */

.overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 16px;
}

.panel {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 16px 20px 18px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.panel-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

/* 柱状图：纯 CSS，不为一张 7 根柱子的图去引 echarts */
.chart {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  height: 150px;
}

.bar-col {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  height: 100%;
}

.bar-wrap {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.bar {
  position: relative;
  width: 60%;
  max-width: 34px;
  min-height: 2px;
  background: #c6e2ff;
  border-radius: 3px 3px 0 0;
  transition: background 0.15s;
}

.bar--today {
  background: #409eff;
}

.bar--zero {
  background: #f0f2f5;
}

.bar-value {
  position: absolute;
  top: -18px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: #606266;
  font-variant-numeric: tabular-nums;
}

.bar-label {
  margin-top: 8px;
  font-size: 11px;
  color: #a8abb2;
  font-variant-numeric: tabular-nums;
}

.bar-label--today {
  color: #409eff;
  font-weight: 600;
}

/* 最近注册 */
.recent-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.recent-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.recent-item + .recent-item {
  border-top: 1px solid #f5f7fa;
}

.recent-item:hover {
  background: #f5f9ff;
}

.recent-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.recent-name {
  font-size: 13px;
  color: #303133;
}

.recent-email {
  font-size: 12px;
  color: #a8abb2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-side {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  font-size: 12px;
}

.empty {
  padding: 32px 0;
  text-align: center;
  font-size: 13px;
  color: #a8abb2;
}

.footnote {
  font-size: 12px;
  color: #909399;
}

.footnote strong {
  color: #606266;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
