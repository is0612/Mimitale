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
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createCustomer, deleteCustomer, updateCustomer } from '@/api/customer'
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
const memberDays = ref(30)

/** 快捷时长 —— 按月续费是 30 天，其余给常用档位省得手打 */
const MEMBER_PRESETS = [
  { label: '1 个月', days: 30 },
  { label: '3 个月', days: 90 },
  { label: '6 个月', days: 180 },
  { label: '1 年', days: 365 }
]


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
  memberDays.value = 30
  memberVisible.value = true
}

async function submitMembership(): Promise<void> {
  const target = memberTarget.value
  if (!target) return
  const n = Number(memberDays.value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    ElMessage.warning('天数要填正整数')
    return
  }
  try {
    await updateCustomer(target.id, { membershipLevel: 'basic', membershipDays: n })
    ElMessage.success(
      `已给「${target.nickname}」发 ${n} 天会员`
    )
    memberVisible.value = false
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  }
}

/* ---------------- 新增客户（等价于注册） ---------------- */

const createVisible = ref(false)
const creating = ref(false)
const createForm = reactive({
  email: '',
  nickname: '',
  password: '',
  trialDays: 30
})

/** 随机密码：去掉 0/O/1/l/I，免得口头报给对方时念错 */
function randomPassword(length = 12): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (n) => chars[n % chars.length]).join('')
}

/** 邮箱随便填的时候，昵称给个能改的默认值（邮箱前缀） */
function suggestNickname(): void {
  if (createForm.nickname.trim()) return
  const prefix = createForm.email.split('@')[0]?.trim() ?? ''
  if (prefix) createForm.nickname = prefix.slice(0, 20)
}

function openCreate(): void {
  createForm.email = ''
  createForm.nickname = ''
  createForm.password = randomPassword()
  createForm.trialDays = 30
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  const email = createForm.email.trim()
  const nickname = createForm.nickname.trim()
  const password = createForm.password

  if (!email || !email.includes('@')) {
    ElMessage.warning('填一个能收信的邮箱')
    return
  }
  if (nickname.length < 2 || nickname.length > 20) {
    ElMessage.warning('用户名 2~20 字')
    return
  }
  if (password.length < 8) {
    ElMessage.warning('密码至少 8 位')
    return
  }

  creating.value = true
  try {
    const row = await createCustomer({ email, nickname, password, trialDays: createForm.trialDays })
    // ⚠️ 密码只有这里能看到一次 —— 提示里带上，运营好照着发给本人
    ElMessageBox.alert(
      `账号已建好：${email}\n初始密码：${password}\n\n把这组信息发给本人，让他登录后到「个人中心 → 账号安全」改掉。`,
      `已创建「${row.nickname}」`,
      { confirmButtonText: '知道了', customClass: 'create-done-box' }
    ).catch(() => {})
    createVisible.value = false
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    creating.value = false
  }
}

/* ---------------- 删除客户 ---------------- */

const deleteVisible = ref(false)
const deleting = ref(false)
const deleteTarget = ref<Customer | null>(null)
/** 必须打一遍完整邮箱才能删 —— 防手滑，也防「点错了行」 */
const deleteConfirmText = ref('')

/**
 * 两段文字算不算「一样」。
 *
 * ⚠️ 别用 `===` 硬比。中文输入法很容易打出全角的 `＠` 和 `．`，
 *    复制时还会带进看不见的空格 —— 结果就是邮箱明明打对了、按钮一直灰着，
 *    用户只会认定「按钮坏了」。NFKC 把全角压成半角，再抹掉所有空白，最后忽略大小写。
 * ⚠️ 但**不能松到「包含就行」**：这一关的意义是让人真的看过那个邮箱。
 */
function sameText(a: string, b: string): boolean {
  const norm = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  const left = norm(a)
  return left.length > 0 && left === norm(b)
}

const deleteConfirmOk = computed(() => {
  const t = deleteTarget.value
  if (!t) return false
  return sameText(deleteConfirmText.value, t.email)
})

function openDelete(row: Customer): void {
  deleteTarget.value = row
  deleteConfirmText.value = ''
  deleteVisible.value = true
}

async function submitDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target || !deleteConfirmOk.value) return

  deleting.value = true
  try {
    await deleteCustomer(target.id)
    ElMessage.success(`已删除「${target.nickname}」`)
    deleteVisible.value = false
    emit('done')
  } catch {
    // 错误提示已在 request 层统一处理
  } finally {
    deleting.value = false
  }
}

defineExpose({ openBan, submitUnban, openMembership, openCreate, openDelete })
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
      <div class="dlg-label">发多少天</div>
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

  <!-- 新增客户：等价于注册 -->
  <el-dialog v-model="createVisible" title="新增客户" width="480px">
    <div class="dlg-body">
      <div class="hint">
        建出来的号和客户端自己注册的<b>完全一样</b> —— 有凭证码、有邀请码、有试用天数，
        也会算进「今日注册」。区别只有一条：不发邮件验验证码。
      </div>

      <div class="dlg-label">邮箱（就是登录账号）</div>
      <el-input v-model="createForm.email" placeholder="someone@example.com" @blur="suggestNickname" />

      <div class="dlg-label">用户名</div>
      <el-input v-model="createForm.nickname" maxlength="20" placeholder="2~20 字，客户端里显示的名字" />

      <div class="dlg-label">初始密码</div>
      <div class="pw-row">
        <el-input v-model="createForm.password" placeholder="至少 8 位" />
        <el-button @click="createForm.password = randomPassword()">随机生成</el-button>
      </div>

      <div class="dlg-label">赠送免费天数</div>
      <el-input-number v-model="createForm.trialDays" :min="0" :max="3650" :step="5" controls-position="right" />
      <div class="hint">默认 30 天，和真注册送的一样。填 0 = 不送。这是<b>免费天数</b>，不是会员。</div>

      <div class="hint warn">
        建完只会显示一次密码 —— 记得复制下来发给本人，让他登录后自己改。
      </div>
    </div>
    <template #footer>
      <el-button @click="createVisible = false">取消</el-button>
      <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
    </template>
  </el-dialog>

  <!-- 删除客户：真删，要求手打邮箱 -->
  <el-dialog v-model="deleteVisible" title="删除客户" width="500px">
    <div class="dlg-body">
      <div class="dlg-target" v-if="deleteTarget">
        {{ deleteTarget.nickname }} · {{ deleteTarget.email }}
      </div>
      <div class="hint warn">
        <b>这个操作不可恢复。</b> 会一起删掉：他的登录记录、使用会话、会员流水、公告已读。
        他发过的意见反馈会<b>保留正文但抹掉身份和联系方式</b>。用过的卡密不回收。
      </div>
      <div class="dlg-label">确认删除，请手打一遍这个邮箱</div>
      <el-input
        v-model="deleteConfirmText"
        :placeholder="deleteTarget?.email ?? ''"
        :class="{ 'confirm-ok': deleteConfirmOk, 'confirm-bad': !!deleteConfirmText && !deleteConfirmOk }"
        @keyup.enter="deleteConfirmOk && submitDelete()"
      />
      <div class="hint" :class="{ 'hint-ok': deleteConfirmOk }">
        <template v-if="deleteConfirmOk">对上了，可以删。</template>
        <template v-else-if="!deleteConfirmText">照上面的邮箱打一遍 —— 大小写不用管，空格和全角也认。</template>
        <template v-else>还差一点：要和上面的邮箱<b>逐字一致</b>（大小写、空格、全角半角都不挑）。</template>
      </div>
    </div>
    <template #footer>
      <el-button @click="deleteVisible = false">取消</el-button>
      <el-button type="danger" :disabled="!deleteConfirmOk" :loading="deleting" @click="submitDelete">
        删除
      </el-button>
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

/* 密码框 + 「随机生成」并排 */
.pw-row {
  display: flex;
  gap: 8px;
}

.pw-row :deep(.el-button) {
  flex: none;
}

.hint {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
}

/* 输入框的两种校验态：对上了（绿）/ 还没对上（红） */
.confirm-ok :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px #67c23a inset;
}

.confirm-bad :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px #f56c6c inset;
}

.hint-ok {
  color: #3a8f3a;
}

.hint.warn {
  color: #854f0b;
  background: #faeeda;
  border-radius: 8px;
  padding: 9px 11px;
  margin-top: 6px;
}
</style>
