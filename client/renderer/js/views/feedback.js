'use strict';

// ============================================================================
//  views/feedback.js —— 意见反馈弹窗（2026-10-23 预留）
//
//  ⚠️ 现在**没有后端可发**（星宝：「等接入服务器再写这个功能，可以预留个弹窗」）。
//     所以「发送」只给一句诚实的提示，内容留在框里不清空 —— 不假装发送成功。
//     接服务器时只改 sendFeedback() 那一处（换成一次 IPC / HTTP），结构别动。
// ============================================================================

import { showToast } from '../ui/toast.js';

const KIND_LABEL = { bug: '问题', idea: '建议', other: '其它' };

const nodes = {};
let kind = 'bug';

export function isFeedbackModalOpen() {
  return !!(nodes.modal && !nodes.modal.classList.contains('hidden'));
}

export function openFeedbackModal() {
  if (!nodes.modal) return;
  nodes.modal.classList.remove('hidden');
  // 打开就把光标放进输入框：这个弹窗只有一个地方能写字
  setTimeout(() => nodes.text?.focus?.(), 40);
}

export function closeFeedbackModal() {
  nodes.modal?.classList.add('hidden');
}

async function sendFeedback() {
  const text = nodes.text ? nodes.text.value.trim() : '';
  if (!text) {
    showToast('先写两句再发', 'error');
    return;
  }

  // ⚠️ 真后端：POST /feedback { kind, text, version, platform }。
  //    现在一个字节都没发出去 —— 提示要诚实，别让人以为已经报上去了。
  showToast(`服务器还没接上，「${KIND_LABEL[kind] || '反馈'}」先留在框里了`, 'ok');
  if (nodes.hint) nodes.hint.textContent = '接上服务器后这里会直接发出去；现在这条没有发出去。';
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
