'use strict';

// ============================================================================
//  views/feedback.js —— 意见反馈弹窗
//
//  2026-10-23 先留了个占位（点「发送」老实说「服务器还没接上」）。
//  10-28 接上真服务器：POST /api/client/feedback。
//
//  ⚠️ **不登录也能发**。连登录都进不去的时候，恰恰是这个弹窗最该派上用场的时候 ——
//     所以它不在任何登录判断后面。未登录时靠设备指纹限频
//     （服务端 60 秒一条、一天 10 条），连着点会被告知等着。
//  ⚠️ 发失败时内容**必须留在框里**：清空等于让人重写一遍。
//  ⚠️ 登录了就顺手带上邮箱，省得让人再敲一次；未登录留空也行。
// ============================================================================

import { showToast } from '../ui/toast.js';
import { submitFeedback } from '../data/notices.js';
import { accountUser } from '../data/account.js';

const KIND_LABEL = { bug: '问题', idea: '建议', other: '其它' };

/** 默认那行小字（发送失败后要能恢复回来） */
const DEFAULT_HINT = '会附上版本号与系统信息（不用自己写）';

const nodes = {};
let kind = 'bug';
/** 正在发 —— 防连点（按钮的 loading 也会挡，这里是第二道） */
let sending = false;

export function isFeedbackModalOpen() {
  return !!(nodes.modal && !nodes.modal.classList.contains('hidden'));
}

export function openFeedbackModal() {
  if (!nodes.modal) return;
  nodes.modal.classList.remove('hidden');
  // 每次打开都把提示恢复成默认值 —— 上次失败那句话不该一直挂着
  if (nodes.hint) nodes.hint.textContent = DEFAULT_HINT;
  // 打开就把光标放进输入框：这个弹窗只有一个地方能写字
  setTimeout(() => nodes.text?.focus?.(), 40);
}

export function closeFeedbackModal() {
  nodes.modal?.classList.add('hidden');
}

async function sendFeedback() {
  if (sending) return;

  const text = nodes.text ? nodes.text.value.trim() : '';
  if (!text) {
    showToast('先写两句再发', 'error');
    nodes.text?.focus?.();
    return;
  }

  const user = accountUser();
  sending = true;
  if (nodes.btnSend) nodes.btnSend.loading = true;
  if (nodes.hint) nodes.hint.textContent = '正在发…';

  try {
    await submitFeedback({
      kind,
      content: text,
      contactEmail: user && user.email ? user.email : ''
    });

    // ⚠️ 只有真的发出去了才清空并关窗
    if (nodes.text) nodes.text.value = '';
    closeFeedbackModal();
    showToast(`收到了，「${KIND_LABEL[kind] || '反馈'}」我们会看`, 'ok');
    if (nodes.hint) nodes.hint.textContent = DEFAULT_HINT;
  } catch (err) {
    // 内容一个字都不动 —— 让人能直接再点一次
    showToast((err && err.message) || '没发出去，稍后再试', 'error');
    if (nodes.hint) {
      nodes.hint.textContent = '没发出去（网络或服务器的问题），内容还留着，可以再点一次。';
    }
  } finally {
    sending = false;
    if (nodes.btnSend) nodes.btnSend.loading = false;
  }
}

export function initFeedbackModal() {
  const $ = (id) => document.getElementById(id);
  nodes.modal = $('feedback-modal');
  nodes.text = $('feedback-text');
  nodes.hint = $('feedback-hint');
  nodes.btnClose = $('btn-close-feedback');
  nodes.btnCancel = $('btn-feedback-cancel');
  nodes.btnSend = $('btn-feedback-send');
  nodes.kinds = nodes.modal ? nodes.modal.querySelector('.feedback-kinds') : null;

  nodes.btnClose?.addEventListener('click', closeFeedbackModal);
  nodes.btnCancel?.addEventListener('click', closeFeedbackModal);
  nodes.btnSend?.addEventListener('click', sendFeedback);
  nodes.modal?.addEventListener('mousedown', (event) => {
    if (event.target === nodes.modal) closeFeedbackModal();
  });

  // 类型：三颗普通按钮当单选用（不为这点东西引入 radio）
  nodes.kinds?.addEventListener('click', (event) => {
    const button = event.target.closest ? event.target.closest('.feedback-kind') : null;
    if (!button) return;
    kind = button.getAttribute('data-kind') || 'bug';
    for (const item of nodes.kinds.querySelectorAll('.feedback-kind')) {
      const on = item === button;
      item.classList.toggle('active', on);
      item.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  });
}
