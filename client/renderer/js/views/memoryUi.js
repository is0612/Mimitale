'use strict';

// 这个视图负责「记忆管理」弹窗：上面的分段记忆摘要列表 + 下面的存档点列表（共用一个容器、互相触发重画）。
// 只做界面与面板动作；「何时自动压一段」在 views/summarize.js，摘要的纯逻辑与运行态在 data/memory.js。

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { h, clear } from '../ui/build.js';
import { mTextarea, mButton } from '../components/index.js';
import { persistConversations } from '../data/persist.js';
import { convoPanel, convoPanelDefs, convoPanelFields, normalizePanelDefs } from '../data/panel.js';
import {
  SUMMARY_TRIGGER_MESSAGES,
  SUMMARY_MIN_MESSAGES,
  MAX_SUMMARY_CHARS,
  convoContextMessages,
  convoSummaries,
  buildTranscriptFromStart,
  pendingSummaryRange,
  generateSummary,
  summarizingConvos,
  summaryFailures,
  charNameForSummary
} from '../data/memory.js';
import { onRefresh, refreshAll } from './refresh.js';

// --- 记忆指示器（头部那个小圆点 + 段数） ---

let memoryEditingId = null; // 正在编辑的摘要段

export function renderMemoryIndicator() {
  const convo = activeConvo();
  const count = convo ? convoSummaries(convo).length : 0;

  el.memoryCount.classList.toggle('hidden', count === 0);
  el.memoryCount.textContent = String(count);
  el.btnMemory.title = count
    ? `已压缩 ${count} 段早期剧情`
    : '较早的对话会自动压成摘要';
}

// --- 弹窗开关 ---

function openMemoryModal() {
  const convo = activeConvo();
  if (!convo) {
    showToast('当前没有会话', 'error');
    return;
  }

  memoryEditingId = null;
  renderMemoryModal();
  el.memoryModal.classList.remove('hidden');
}

export function closeMemoryModal() {
  el.memoryModal.classList.add('hidden');
  el.input.focus();
}

// --- 摘要列表 ---

export function renderMemoryModal() {
  const convo = activeConvo();
  if (!convo) return;

  const { messages, pending, covered } = pendingSummaryRange(convo);
  const list = convoSummaries(convo);

  el.memorySummaryLine.textContent = list.length
    ? `已压缩 ${list.length} 段，覆盖前 ${covered} / ${messages.length} 条消息`
    : '还没有摘要';
  el.memoryPendingLine.textContent = convo.summaryBusy
    ? '正在压缩…'
    : `未压缩 ${pending.length} 条（达到 ${SUMMARY_TRIGGER_MESSAGES} 条会自动压缩）`;

  el.btnSummarizeNow.disabled = pending.length < SUMMARY_MIN_MESSAGES || !!convo.summaryBusy;
  el.btnMemoryClear.disabled = list.length === 0;
  el.memoryFootHint.textContent = `「${convo.title || '新对话'}」的摘要只保存在你自己电脑上`;

  // ⚠️ 必须放在「没有摘要就 return」之前：存档点在下面那一节，跟摘要没关系
  renderCheckpoints(convo);

  el.memoryList.textContent = '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'memory-empty';
    empty.textContent =
      `还没有摘要。聊到 ${SUMMARY_TRIGGER_MESSAGES} 条未压缩消息时会自动压一段，` +
      '也可以点上面的按钮手动压。';
    el.memoryList.appendChild(empty);
    return;
  }

  list.forEach((seg, index) => {
    el.memoryList.appendChild(buildMemoryCard(convo, seg, index, list.length));
  });
}

function buildMemoryCard(convo, seg, index, total) {
  const card = document.createElement('div');
  card.className = 'memory-card';

  const head = document.createElement('div');
  head.className = 'memory-card-head';

  const title = document.createElement('span');
  title.className = 'memory-card-title';
  title.textContent = seg.title || `第 ${index + 1} 段`;

  const meta = document.createElement('span');
  meta.className = 'memory-card-meta';
  const when = seg.at ? new Date(seg.at).toLocaleString('zh-CN', { hour12: false }) : '';
  meta.textContent = `第 ${seg.start + 1}–${seg.end} 条 · ${String(seg.text || '').length} 字${when ? ' · ' + when : ''}`;

  head.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'memory-card-actions';

  const isEditing = memoryEditingId === seg.id;

  const editBtn = mButton({
    variant: 'ghost',
    size: 'sm',
    class: isEditing ? 'active' : '',
    text: isEditing ? '取消编辑' : '编辑',
    onClick: () => {
      memoryEditingId = isEditing ? null : seg.id;
      renderMemoryModal();
    }
  });

  const regenBtn = mButton({
    variant: 'ghost',
    size: 'sm',
    text: '重新生成',
    title: '用这段对应的原文重新压一次',
    disabled: !!convo.summaryBusy,
    onClick: async () => {
      regenBtn.loading = true;
      regenBtn.textContent = '生成中…';
      const ok = await regenerateSummary(convo, seg.id);
      renderMemoryModal();
      if (ok) showToast('已重新生成', 'ok');
    }
  });

  const delBtn = mButton({
    variant: 'danger',
    size: 'sm',
    text: '删除',
    title: '删掉这段摘要，对应的原文会重新进入上下文',
    onClick: () => deleteSummarySegment(convo, seg.id)
  });

  actions.append(editBtn, regenBtn, delBtn);

  const body = document.createElement('div');
  body.className = 'memory-card-body';

  if (isEditing) {
    // .memory-edit-box 留在宿主持布局，观感规则落在里层 `> textarea` 上
    const box = mTextarea({
      class: 'memory-edit-box',
      value: String(seg.text || ''),
      spellcheck: 'false'
    });

    const editActions = document.createElement('div');
    editActions.className = 'memory-card-actions';

    const saveBtn = mButton({
      variant: 'primary',
      size: 'sm',
      text: '保存',
      onClick: async () => {
        const target = convoSummaries(convo).find((s) => s.id === seg.id);
        if (!target) return;
        let text = box.value.trim();
        if (text.length > MAX_SUMMARY_CHARS) text = `${text.slice(0, MAX_SUMMARY_CHARS)}…`;
        if (!text) {
          showToast('摘要不能为空，要删就点「删除」', 'error');
          return;
        }
        target.text = text;
        target.at = now();
        convo.updatedAt = now();
        memoryEditingId = null;
        persistConversations(0);
        renderMemoryModal();
        showToast('摘要已保存', 'ok');
      }
    });

    editActions.appendChild(saveBtn);
    body.append(box, editActions);
  } else {
    const text = document.createElement('div');
    text.className = 'memory-card-text';
    text.textContent = seg.text || '';
    body.appendChild(text);
  }

  card.append(head, actions, body);
  return card;
}

async function regenerateSummary(convo, segmentId) {
  const list = convoSummaries(convo);
  const index = list.findIndex((s) => s.id === segmentId);
  if (index < 0) return false;

  const seg = list[index];
  const messages = convoContextMessages(convo);
  const slice = messages.slice(seg.start, seg.end);
  if (!slice.length) {
    showToast('这段对应的原文已经不在了，无法重新生成', 'error');
    return false;
  }

  if (summarizingConvos.has(convo.id)) {
    showToast('正在压缩中，稍等一下', 'error');
    return false;
  }

  summarizingConvos.add(convo.id);
  // ⚠️ 这里不重画弹窗：那颗按钮正显示「生成中…」，重画会把状态冲掉（调用方结束后会重画）
  convo.summaryBusy = true;
  try {
    // ⚠️ 必须用 buildTranscriptFromStart（从最早那条往后装），别用 buildTranscript：它超长时砍的是最早几条，
    //    会让这段摘要只覆盖后半截，前半截原文又被 end 挡在上下文外，等于静默丢消息
    const transcript = buildTranscriptFromStart(slice, charNameForSummary(convo)).text;
    const previous = list
      .slice(0, index)
      .map((s) => String(s.text || ''))
      .join('\n\n');

    const text = await generateSummary(convo, transcript, previous);
    if (!text) return false;

    const fresh = convoSummaries(convo);
    const target = fresh.find((s) => s.id === segmentId);
    if (!target) return false;
    target.text = text;
    target.at = now();
    convo.updatedAt = now();

    summaryFailures.delete(convo.id);
    persistConversations(0);
    return true;
  } catch (err) {
    console.error('重新生成摘要失败', err);
    showToast((err && err.message) || '重新生成失败', 'error');
    return false;
  } finally {
    convo.summaryBusy = false;
    summarizingConvos.delete(convo.id);
  }
}

async function deleteSummarySegment(convo, segmentId) {
  const list = convoSummaries(convo);
  const index = list.findIndex((s) => s.id === segmentId);
  if (index < 0) return;
  const seg = list[index];
  const later = list.length - index - 1;

  // ⚠️ 删中间一段不能只把后面的往前挪：被删段的原文仍被挡在上下文外，后面的摘要覆盖的是另一段原文 = 静默丢消息。
  //    所以删目标段时把它之后的摘要一起删掉
  const ok = await confirmDialog({
    title: '删除摘要',
    message: later
      ? `删除「${seg.title}」以及它后面的 ${later} 段摘要？这些摘要对应的原文会重新进入上下文，占用更多 token。`
      : `删除「${seg.title}」？对应的原文会重新进入上下文，占用更多 token。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  convo.summaries = list.slice(0, index);
  convo.updatedAt = now();
  persistConversations(0);
  renderMemoryModal();
  renderMemoryIndicator();
  showToast('摘要已删除，原文重新进入上下文');
}

async function clearAllSummaries() {
  const convo = activeConvo();
  if (!convo) return;

  const list = convoSummaries(convo);
  if (!list.length) return;

  const ok = await confirmDialog({
    title: '清空全部摘要',
    message: `删除全部 ${list.length} 段摘要？对应的原文会重新进入上下文，token 占用会明显上升。`,
    confirmText: '清空',
    danger: true
  });
  if (!ok) return;

  convo.summaries = [];
  memoryEditingId = null;
  convo.updatedAt = now();
  summaryFailures.delete(convo.id);
  persistConversations(0);
  renderMemoryModal();
  renderMemoryIndicator();
  showToast('摘要已清空，原文重新进入上下文');
}

// --- 存档点 ---

// ⚠️ 读档 = 整个退回去，存完之后聊的会没；「分支」才是什么都不丢 —— 界面必须说清，不然用户以为读档也能反悔
// 上限：每份都是一整段对话的副本，攒多了会把 conversations.json 撑大
const MAX_CHECKPOINTS = 12;

function snapshotConvo(convo) {
  return {
    messages: JSON.parse(JSON.stringify(convo.messages || [])),
    panel: { ...(convoPanel(convo) || {}) },
    panelFields: [...convoPanelFields(convo)],
    panelDefs: JSON.parse(JSON.stringify(convoPanelDefs(convo))),
    options: [...(Array.isArray(convo.options) ? convo.options : [])],
    // false 是「这张卡明确不要剧情选项」，不能被吞成 null（null = 没配过）
    optionsSpec: convo.optionsSpec === false ? false : convo.optionsSpec ? { ...convo.optionsSpec } : null,
    summaries: JSON.parse(JSON.stringify(convoSummaries(convo))),
    player: convo.player ? { ...convo.player } : null
  };
}

function saveCheckpoint() {
  const convo = activeConvo();
  if (!convo) return;

  const count = (convo.messages || []).length;
  if (!count) {
    showToast('这个会话还是空的，没什么可存的', 'error');
    return;
  }

  if (!Array.isArray(convo.checkpoints)) convo.checkpoints = [];

  const summaries = convoSummaries(convo).length;
  const name = `${count} 条消息${summaries ? ` · ${summaries} 段摘要` : ''}`;
  convo.checkpoints.unshift({ id: uid(), at: now(), name, ...snapshotConvo(convo) });

  if (convo.checkpoints.length > MAX_CHECKPOINTS) convo.checkpoints.length = MAX_CHECKPOINTS;

  persistConversations(0);
  renderMemoryModal();
  showToast(`已存档（${name}）`, 'ok');
}

async function restoreCheckpoint(id) {
  const convo = activeConvo();
  if (!convo) return;

  const point = (convo.checkpoints || []).find((c) => c.id === id);
  if (!point) return;

  const ok = await confirmDialog({
    title: '读档',
    message:
      `回到「${point.name}」？\n\n` +
      '这段时间聊的内容会丢掉。存档点本身还留着，可以再回到这里。\n' +
      '想「保住现在这条线」的话，用消息上的「分支」更稳。',
    confirmText: '读档'
  });
  if (!ok) return;

  const data = JSON.parse(JSON.stringify(point));
  convo.messages = data.messages || [];
  convo.panel = data.panel || {};
  convo.panelFields = data.panelFields || [];
  convo.panelDefs = normalizePanelDefs(data.panelDefs);
  convo.options = Array.isArray(data.options) ? data.options : [];
  // 保持三态：false = 明确关掉，null/缺省 = 没配过，对象 = 具体配置
  convo.optionsSpec = data.optionsSpec === false ? false : data.optionsSpec || null;
  convo.summaries = data.summaries || [];
  // 存档时是 null 就恢复成 null，不能因为「现在有玩家角色」把存档前的状态留错
  convo.player = data.player || null;
  convo.updatedAt = now();
  state.usage = null;

  persistConversations(0);
  refreshAll({ forceScroll: true });
  renderMemoryModal();
  showToast('已回到存档点', 'ok');
}

async function deleteCheckpoint(id) {
  const convo = activeConvo();
  if (!convo) return;

  const ok = await confirmDialog({
    title: '删掉这个存档点',
    message: '删掉之后就回不到这个时间点了。',
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  convo.checkpoints = (convo.checkpoints || []).filter((c) => c.id !== id);
  persistConversations(0);
  renderMemoryModal();
  showToast('已删掉存档点', 'ok');
}

function renderCheckpoints(convo) {
  clear(el.checkpointList);

  const points = Array.isArray(convo.checkpoints) ? convo.checkpoints : [];
  el.btnSaveCheckpoint.disabled = !(convo.messages || []).length;

  if (!points.length) {
    el.checkpointList.appendChild(
      h('div', { class: 'memory-empty', text: '还没有存档点。想「先存一下再往前写」就点上面的按钮。' })
    );
    return;
  }

  for (const point of points) {
    const when = new Date(point.at || Date.now()).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    el.checkpointList.appendChild(
      h(
        'div',
        { class: 'checkpoint-row' },
        h(
          'div',
          { class: 'checkpoint-info' },
          h('div', { class: 'checkpoint-name', text: point.name }),
          h('div', { class: 'checkpoint-time', text: when })
        ),
        mButton({ variant: 'primary', size: 'sm', text: '读档', onClick: () => restoreCheckpoint(point.id) }),
        mButton({ variant: 'ghost', size: 'sm', text: '删除', onClick: () => deleteCheckpoint(point.id) })
      )
    );
  }
}

// --- 接线：事件绑定 + 登记刷新总线 ---

export function initMemoryUi() {
  el.btnMemory.addEventListener('click', openMemoryModal);
  el.btnCloseMemory.addEventListener('click', closeMemoryModal);
  el.btnCloseMemory2.addEventListener('click', closeMemoryModal);
  el.memoryModal.addEventListener('click', (event) => {
    if (event.target === el.memoryModal) closeMemoryModal();
  });
  el.btnMemoryClear.addEventListener('click', clearAllSummaries);
  el.btnSaveCheckpoint.addEventListener('click', saveCheckpoint);

  onRefresh(renderMemoryIndicator);
}
