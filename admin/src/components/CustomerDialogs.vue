<script setup lang="ts">
/**
 * 客户的三个操作弹层：发会员 / 封禁 / 解封。
 *
 * 抽成组件是因为**列表页和详情页都要用** —— 抄两遍必然会走样
 * （改了一处忘另一处，是后台项目最常见的烂法）。
 *
 * 用法：父组件放 `<CustomerDialogs ref="dialogs" @done="load" />`，
 *      然后在按钮里调 `dialogs.value?.openMembership(row)`。
 *
 * 封禁原因和会员等级都来自**字典**，所以运营在字典页加一条，
 * 这里的下拉立刻多一个选项。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { updateCustomer } from '@/api/customer'
import { useDictStore } from '@/stores/dict'
import { formatTime, membershipState } from '@/config/labels'
import type { Customer } from '@/types'

const emit = defineEmits<{ done: [] }>()
const dict = useDictStore()

/* ---------------- 封禁 ---------------- */

const banVisible = ref(false)
const banTarget = ref<Customer | null>(null)
/** 从字典 ban_reason 里选的值 */
const banReason = ref('')
/** 选了「其他」时手填的内容 —— 它会直接作为原因存下来 */
const banCustom = ref('')

/** 字典 ban_reason —— 只有启用的会出现在这里 */
const banReasonOptions = computed(() => dict.optionsOf('ban_reason'))
const isOther = computed(() => banReason.value === 'other')

function openBan(row: Customer): void {
  banTarget.value = row
  banReason.value = ''
  banCustom.value = ''
  banVisible.value = true
}

async function submitBan(): Promise<void> {
  const target = banTarget.value
  if (!target) return

  let reason = banReason.value
  if (!reason) {
    ElMessage.warning('选一个封禁原因')
    return
  }
  if (isOther.value) {
    reason = banCustom.value.trim()
    if (!reason) {
      ElMessage.warning('选「其他」的话，请把原因写一下')
      return
    }
  }

  try {
    await updateCustomer(target.id, { status: 'banned', banReason: reason })
    ElMessage.success(`已封禁「${target.nickname}」`)
    banVisible.value = false
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

async function submitUnban(row: Customer): Promise<void> {
  try {
    await updateCustomer(row.id, { status: 'active' })
    ElMessage.success(`已解封「${row.nickname}」`)
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

/* ---------------- 发会员 ---------------- */

const memberVisible = ref(false)
const memberTarget = ref<Customer | null>(null)
/** 目标等级 —— 字典 membership_level 的 value，默认初级会员 */
const memberLevel = ref('basic')
const memberDays = ref(30)

/** 快捷时长 —— 按月续费是 30 天，其余给常用档位省得手打 */
const MEMBER_PRESETS = [
  { label: '1 个月', days: 30 },
  { label: '3 个月', days: 90 },
  { label: '6 个月', days: 180 },
  { label: '1 年', days: 365 }
]

/** 等级下拉 —— 字典里加一档这里立刻多一档 */
const memberLevelOptions = computed(() => dict.optionsOf('membership_level'))

const memberSummary = computed(() => {
  const t = memberTarget.value
  if (!t) return ''
  const s = membershipState(t)
  if (s === 'none') return '当前：非会员，开通后从今天起算'
  if (s === 'expired') return `当前：已过期（${formatTime(t.membershipExpireAt)}），续费从今天起算`
  return `当前：${dict.labelOf('membership_level', t.membershipLevel)}，${formatTime(
    t.membershipExpireAt
  )} 到期（续费从到期日顺延）`
})

const memberHint = computed(() => {
  const n = Number(memberDays.value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return '请填正整数天数'
  return `顺延 ${n} 天`
})

function openMembership(row: Customer): void {
  memberTarget.value = row
  memberLevel.value = 'basic'
  memberDays.value = 30
  memberVisible.value = true
}

async function submitMembership(): Promise<void> {
  const target = memberTarget.value
  if (!target) return
  if (!memberLevel.value) {
    ElMessage.warning('选一个会员等级')
    return
  }
  const n = Number(memberDays.value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    ElMessage.warning('天数要填正整数')
    return
  }
  try {
    await updateCustomer(target.id, { membershipLevel: memberLevel.value, membershipDays: n })
    ElMessage.success(
      `已给「${target.nickname}」发 ${n} 天${dict.labelOf('membership_level', memberLevel.value)}`
    )
    memberVisible.value = false
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

defineExpose({ openBan, submitUnban, openMembership })
</script>

<template>
  <!-- 封禁 -->
  <el-dialog v-model="banVisible" title="封禁客户" width="440px">
    <div v-if="banTarget" class="dlg-body">
      <div class="dlg-target">
        {{ banTarget.nickname }}
        <span class="dlg-mail">{{ banTarget.email }}</span>
      </div>
      <div class="dlg-label">封禁原因</div>
      <el-select v-model="banReason" placeholder="选一个原因" style="width: 100%">
        <el-option v-for="o in banReasonOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <template v-if="isOther">
        <div class="dlg-label">具体原因</div>
        <el-input v-model="banCustom" placeholder="写清楚，会记进操作日志" />
      </template>
      <div class="hint warn">
        封禁后客户无法使用客户端。这个动作会记进操作日志，原因也会留在客户详情里。
      </div>
    </div>
    <template #footer>
      <el-button @click="banVisible = false">取消</el-button>
      <el-button type="danger" @click="submitBan">确定封禁</el-button>
    </template>
  </el-dialog>

  <!-- 发会员 -->
  <el-dialog v-model="memberVisible" title="发会员" width="460px">
    <div v-if="memberTarget" class="dlg-body">
      <div class="dlg-target">
        {{ memberTarget.nickname }}
        <span class="dlg-mail">{{ memberTarget.email }}</span>
      </div>
      <div class="member-summary">{{ memberSummary }}</div>
      <div class="dlg-label">等级</div>
      <el-select v-model="memberLevel" style="width: 100%">
        <el-option v-for="o in memberLevelOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <div class="dlg-label">时长</div>
      <div class="presets">
        <el-button
          v-for="p in MEMBER_PRESETS"
          :key="p.days"
          size="small"
          :type="Number(memberDays) === p.days ? 'primary' : 'default'"
          @click="memberDays = p.days"
        >
          {{ p.label }}
        </el-button>
      </div>
      <div class="dlg-label">或者手填天数</div>
      <el-input v-model.number="memberDays" placeholder="30 = 一个月" />
      <div class="hint">{{ memberHint }}</div>
      <div class="hint warn">
        现在没有收费功能 —— 客户到期后找你开会员，就靠这里手动给他续。这个动作会记进操作日志。
      </div>
    </div>
    <template #footer>
      <el-button @click="memberVisible = false">取消</el-button>
      <el-button type="primary" @click="submitMembership">发会员</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dlg-target {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
}

.dlg-mail {
  font-weight: 400;
  font-size: 12px;
  color: var(--text-sub);
  margin-left: 8px;
}

.member-summary {
  font-size: 12px;
  color: var(--text-sub);
  background: #f1efe8;
  border-radius: 8px;
  padding: 8px 11px;
  margin-bottom: 4px;
  line-height: 1.6;
}

.dlg-label {
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 4px;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.presets :deep(.el-button + .el-button) {
  margin-left: 0;
}

.hint {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
}

.hint.warn {
  color: #854f0b;
  background: #faeeda;
  border-radius: 8px;
  padding: 9px 11px;
  margin-top: 6px;
}
</style>
