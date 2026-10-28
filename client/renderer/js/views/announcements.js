'use strict';

// ============================================================================
//  views/announcements.js —— 通知公告（2026-10-28）
//
//  三处地方显示同一份数据，所以只在这里拉一次、渲染三次：
//    ① 聊天页顶部的横条（只显示**未读**，最多 2 条）—— 星宝选的方案
//    ② 「查看全部」弹窗
//    ③ 个人中心 →「通知」那一组
//
//  ⚠️ **不要求登录**：公告要能发给登录不进去的人（「你被停机了」这种话，
//     恰恰没法等到登录成功再告诉他）。未登录时已读只记在本机 localStorage。
//  ⚠️ 未读规则只有一条：**展开看过**才算已读。横条出现 ≠ 看过 ——
//     所以它不该一显示就把红点清掉。
//  ⚠️ 服务端不通时安静地什么都不显示，不弹报错：公告是锦上添花，
//     不该让启动过程出现一堆红色提示。
// ============================================================================

import { loadAnnouncements, markAnnouncementRead, isReadLocally, markReadLocally } from '../data/notices.js';
import { iconHtml, applyFieldIcons } from '../ui/icons.js';

/** 横条最多同时显示几条（再多就把聊天页挤没了） */
const STRIP_MAX = 2;

const LEVEL_LABEL = { normal: '公告', important: '重要', maintenance: '维护' };

const nodes = {};
/** 服务端回来的原始列表（按 pinned / 时间排好） */
let items = [];
/** 渲染用的「已读」判断：服务端说的 + 本机记的 */
function isRead(item) {
  return !!item.isRead || isReadLocally(item.id);
}

function unreadItems() {
  return items.filter((item) => !isRead(item));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 2026-10-28 */
function shortDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/** 顶部横条：只放未读，pinned 已在服务端排前面 */
function renderStrip() {
  const box = nodes.strip;
  if (!box) return;

  const list = unreadItems().slice(0, STRIP_MAX);
  if (list.length === 0) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = list
    .map(
      (item) => `
      <div class="notice-bar" data-level="${escapeHtml(item.level)}" data-id="${item.id}" role="status">
        <span class="notice-bar-icon" aria-hidden="true">${iconHtml('bell', 'notice-icon-svg')}</span>
        <div class="notice-bar-copy">
          <p class="notice-bar-title">${escapeHtml(item.title)}</p>
          <p class="notice-bar-text">${escapeHtml(item.content)}</p>
        </div>
        <button class="notice-bar-done" type="button" data-act="read" data-id="${item.id}">知道了</button>
      </div>`
    )
    .join('');
}

/** 一条公告的完整样子（弹窗和个人中心共用） */
function cardHtml(item) {
  const read = isRead(item);
  return `
    <article class="notice-item${read ? ' is-read' : ''}" data-level="${escapeHtml(item.level)}" data-id="${item.id}">
      <div class="notice-item-head">
        <span class="notice-level">${escapeHtml(LEVEL_LABEL[item.level] || '公告')}</span>
        <span class="notice-item-title">${escapeHtml(item.title)}</span>
        ${read ? '' : '<span class="notice-unread-dot" aria-label="未读"></span>'}
        <span class="notice-item-date">${escapeHtml(shortDay(item.createdAt))}</span>
      </div>
      <div class="notice-item-body">${escapeHtml(item.content)}</div>
    </article>`;
}

function renderList(container) {
  if (!container) return;
  if (items.length === 0) {
    container.innerHTML = '<p class="notice-empty">还没有公告</p>';
    return;
  }
  container.innerHTML = items.map(cardHtml).join('');
}

/**
 * 个人中心导航上那颗未读数。
 * ⚠️ 要同时改按钮的 aria-label —— 光有数字，读屏用户不知道那是什么。
 */
function renderBadge() {
  const badge = nodes.navBadge;
  const count = unreadItems().length;

  if (badge) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count === 0);
  }

  const navItem = nodes.navItem;
  if (navItem) {
    const label = count > 0 ? `通知（${count} 条未读）` : '通知';
    navItem.setAttribute('aria-label', label);
    navItem.classList.toggle('has-unread', count > 0);
  }
}

function renderAll() {
  renderStrip();
  renderList(nodes.modalList);
  renderList(nodes.profileList);
  renderBadge();
}

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

/**
 * 重新拉一次并重画。
 * @param {{silent?: boolean}} [options] silent = 失败也不打 console（启动时用）
 */
export async function refreshAnnouncements(options = {}) {
  const result = await loadAnnouncements();
  if (result.failed && options.silent) {
    // 失败就保持原样（可能是启动时没网，别把已有内容清空）
    return items;
  }

  items = result.list;
  renderAll();
  return items;
}

/** 标一条已读（先画界面，再通知服务端 —— 红点不该等网络） */
export async function markRead(id) {
  const item = items.find((it) => Number(it.id) === Number(id));
  if (!item) return;

  const already = isRead(item);
  markReadLocally(item.id);
  item.isRead = true;
  renderAll();

  if (already) return;
  await markAnnouncementRead(item.id);
}

/** 未读数（账号变化后要重算，登录前后的已读不是同一套） */
export function unreadCount() {
  return unreadItems().length;
}

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

export function isNoticeModalOpen() {
  return !!(nodes.modal && !nodes.modal.classList.contains('hidden'));
}

export function openNoticeModal() {
  if (!nodes.modal) return;
  renderList(nodes.modalList);
  nodes.modal.classList.remove('hidden');
  nodes.modal.querySelector('.modal-card')?.focus?.();
}

export function closeNoticeModal() {
  nodes.modal?.classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 绑事件、拉一次数据。
 * ⚠️ 启动时拉一次就够，不用轮询：公告是「上线那天才发一条」的东西，
 *    为它开个定时器纯属浪费电。
 */
export function initAnnouncements() {
  const $ = (id) => document.getElementById(id);

  nodes.strip = $('notice-strip');
  nodes.modal = $('notice-modal');
  nodes.modalList = $('notice-modal-list');
  nodes.profileList = $('notice-profile-list');
  nodes.navBadge = $('notice-nav-badge');
  nodes.navItem = document.querySelector('.settings-nav-item[data-target="sec-notice"]');

  $('btn-close-notice')?.addEventListener('click', closeNoticeModal);
  $('btn-notice-modal-close')?.addEventListener('click', closeNoticeModal);
  nodes.modal?.addEventListener('mousedown', (event) => {
    if (event.target === nodes.modal) closeNoticeModal();
  });

  // 横条上的按钮：整条点开看全文 / 「知道了」只标已读
  nodes.strip?.addEventListener('click', (event) => {
    const target = event.target.closest ? event.target : null;
    if (!target) return;

    const done = target.closest('[data-act="read"]');
    if (done) {
      event.stopPropagation();
      void markRead(done.getAttribute('data-id'));
      return;
    }

    const bar = target.closest('.notice-bar');
    if (bar) openNoticeModal();
  });

  // 弹窗 / 个人中心里点某一条 = 展开看过 = 已读（id 在 data-id 上）
  const bindList = (container) => {
    container?.addEventListener('click', (event) => {
      const article = event.target.closest ? event.target.closest('.notice-item') : null;
      if (!article) return;
      void markRead(article.getAttribute('data-id'));
    });
  };
  bindList(nodes.modalList);
  bindList(nodes.profileList);

  applyFieldIcons(document);

  void refreshAnnouncements({ silent: true });
}
