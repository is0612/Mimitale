'use strict';

// ============================================================================
//  ui/confirm.js —— 应用内的确认弹窗（替代 window.confirm）
//  用系统原生 confirm 会有副作用：关掉它的那一下点击会被吞掉，
//  之后点输入框要点两次才能聚焦，看起来就像「输入框点不动」。
// ============================================================================

import { el } from '../core/dom.js';

let activeCleanup = null;

export function confirmDialog(options) {
  if (activeCleanup) activeCleanup(false);
  const previousFocus = document.activeElement;
  const opts = options || {};

  el.confirmTitle.textContent = opts.title || '确认';
  el.confirmMessage.textContent = opts.message || '';
  el.confirmOk.textContent = opts.confirmText || '确定';
  el.confirmOk.className = `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`;

  el.confirmModal.classList.remove('hidden');
  el.confirmCancel.focus();

  return new Promise((resolve) => {
    function cleanup(result) {
      el.confirmOk.removeEventListener('click', onOk);
      el.confirmCancel.removeEventListener('click', onCancel);
      el.confirmModal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus, true);
      el.confirmModal.classList.add('hidden');
      activeCleanup = null;
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(event) {
      if (event.target === el.confirmModal) cleanup(false);
    }
    function onFocus(event) {
      if (!el.confirmModal.contains(event.target)) el.confirmCancel.focus({ preventScroll: true });
    }
    function onKey(event) {
      if (event.isComposing || event.keyCode === 229) return;
      if (!['Escape', 'Enter', 'Tab'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        cleanup(false);
      } else if (event.key === 'Enter') {
        if (!event.repeat) cleanup(document.activeElement === el.confirmOk);
      } else {
        const next = document.activeElement === el.confirmCancel ? el.confirmOk : el.confirmCancel;
        next.focus();
      }
    }

    activeCleanup = cleanup;
    document.addEventListener('focusin', onFocus, true);
    el.confirmOk.addEventListener('click', onOk);
    el.confirmCancel.addEventListener('click', onCancel);
    el.confirmModal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}
