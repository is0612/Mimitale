'use strict';

// ============================================================================
//  ui/pickList.js —— 「从一列里挑一个」的单选弹窗
//
//  第一处用途是**备选开场白**：一张卡可能带好几条入场剧本
//  （语料实测 424/1341 张卡带，共 1916 条，单卡最多 29 条），
//  绑定角色时得让用户挑一条，而不是永远只进第一条。
//
//  两点讲究：
//    · 候选项正文**一律走 textContent** —— 卡里的文字是不可信内容，
//      走 innerHTML 等于给导入的卡开一个 HTML 注入面（本项目的老规矩）。
//    · Esc 用**捕获阶段**拦下：这个弹窗开的时候，底下往往还压着一个
//      「你是谁」的身份弹窗（开聊流程里它还没关），不拦住的话一下 Esc
//      会把两个一起关掉 —— 和 lightbox.js 同样的处理。
// ============================================================================

import { el } from '../core/dom.js';

// 预览截断到多少个字。**只截显示、不截数据** —— 交给调用方的仍是完整原文。
const PREVIEW_CHARS = 140;

// 当前开着的那个弹窗的关闭函数（同一时间只允许一层）
let pendingClose = null;

/**
 * 开一个单选弹窗。
 *
 * @param {object} options
 * @param {string} options.title   标题
 * @param {string} [options.hint]  标题下面那句说明（不给就整行藏起来）
 * @param {Array<{text: string, note?: string}>} options.items 候选项，按显示顺序
 * @returns {Promise<number|null>} 选中的下标；取消 / Esc / 点背景 → null
 */
export function pickFromList(options) {
  const opts = options || {};
  const items = Array.isArray(opts.items) ? opts.items : [];
  if (!items.length) return Promise.resolve(null);

  // 已经开着一个就先把它按「取消」结掉（它的 cleanup 会摘掉自己那套监听）
  if (pendingClose) pendingClose(null);

  el.pickTitle.textContent = opts.title || '请选择';
  el.pickHint.textContent = opts.hint || '';
  el.pickHint.classList.toggle('hidden', !opts.hint);

  el.pickList.textContent = ''; // 清掉上一个弹窗留下的行
  items.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pick-item';
    row.dataset.index = String(index);

    const head = document.createElement('span');
    head.className = 'pick-item-head';

    const no = document.createElement('span');
    no.className = 'pick-item-no';
    no.textContent = String(index + 1);
    head.appendChild(no);

    const noteText = item.note || '';
    if (noteText) {
      const note = document.createElement('span');
      note.className = 'pick-item-note';
      note.textContent = noteText;
      head.appendChild(note);
    }

    const body = document.createElement('span');
    body.className = 'pick-item-text';
    const text = String(item.text || '');
    // 预览里把换行压成空格：多行预览会把列表撑得忽高忽低，扫起来很累
    const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
    body.textContent = flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;

    row.appendChild(head);
    row.appendChild(body);
    el.pickList.appendChild(row);
  });

  el.pickModal.classList.remove('hidden');
  // 焦点落在第一项上：键盘 Tab / 回车就能选，不用先摸鼠标
  const first = el.pickList.querySelector('.pick-item');
  if (first && first.focus) first.focus();

  return new Promise((resolve) => {
    function cleanup(result) {
      if (pendingClose === cleanup) pendingClose = null;
      el.pickList.removeEventListener('click', onClick);
      el.pickCancel.removeEventListener('click', onCancel);
      el.pickModal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      el.pickModal.classList.add('hidden');
      resolve(result);
    }

    function onCancel() {
      cleanup(null);
    }

    function onClick(event) {
      const row = event.target && event.target.closest ? event.target.closest('.pick-item') : null;
      if (!row) return;
      cleanup(Number(row.dataset.index));
    }

    function onBackdrop(event) {
      if (event.target === el.pickModal) cleanup(null);
    }

    function onKey(event) {
      if (event.key !== 'Escape') return;
      // 捕获阶段拦下：底下压着的弹窗也在听 Esc，不 stop 会一起关
      event.preventDefault();
      event.stopPropagation();
      cleanup(null);
    }

    pendingClose = cleanup;
    el.pickList.addEventListener('click', onClick);
    el.pickCancel.addEventListener('click', onCancel);
    el.pickModal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}
