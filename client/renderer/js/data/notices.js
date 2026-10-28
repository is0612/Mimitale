'use strict';

// ============================================================================
//  data/notices.js —— 消息：意见反馈 / 通知公告（2026-10-28）
//
//  和 data/account.js 分开的原因：这两件事**不要求登录**。
//  连登录都进不去的人才最需要报错，公告也要能发给登不进去的人
//  （「你被停机了」这种话，恰恰没法在登录成功之后才告诉他）。
//
//  ⚠️ 不碰 DOM：弹窗在 views/feedback.js，横条和列表在 views/announcements.js。
// ============================================================================

import { api } from '../core/api.js';

function unwrap(result, fallback) {
  if (result && result.ok) return result;
  throw new Error((result && result.error) || fallback);
}

/* ------------------------------------------------------------------ */
/* 意见反馈                                                            */
/* ------------------------------------------------------------------ */

/**
 * 发一条反馈 → { id, createdAt }
 * @param {{kind?: string, content: string, contactEmail?: string}} payload
 */
export async function submitFeedback(payload) {
  return unwrap(await api.accountSubmitFeedback(payload || {}), '反馈没发出去');
}

/* ------------------------------------------------------------------ */
/* 通知公告                                                            */
/* ------------------------------------------------------------------ */

/**
 * 拉此刻该显示的公告 → { list, unread }
 *
 * ⚠️ 服务端不通时**返回空列表而不是抛错**：公告是锦上添花，
 *    不能因为它把启动流程搞出一堆红色报错。真正的错误只写 console。
 */
export async function loadAnnouncements() {
  try {
    const result = unwrap(await api.accountAnnouncements(), '读取公告失败');
    return {
      list: Array.isArray(result.list) ? result.list : [],
      unread: Number(result.unread) || 0,
      failed: false
    };
  } catch (err) {
    console.warn('[notices] 读取公告失败:', (err && err.message) || err);
    return { list: [], unread: 0, failed: true };
  }
}

/** 标一条已读 → 最新未读数。未登录时服务端回 0，由本地记录兜底 */
export async function markAnnouncementRead(id) {
  try {
    const result = unwrap(await api.accountAnnouncementRead(id), '标记已读失败');
    return Number(result.unread) || 0;
  } catch (err) {
    console.warn('[notices] 标记已读失败（本地照样记）:', (err && err.message) || err);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 未登录时的本地已读记录                                                */
/* ------------------------------------------------------------------ */

/**
 * 未登录的人在服务端没有身份，已读只能记在本机。
 *
 * ⚠️ 用 localStorage 而不是 data/*.json：这条记录丢了只是「再看一遍公告」，
 *    不值得为它多一次 IPC 和一次写盘。
 * ⚠️ 和登录态的已读**是两套**，别合并：同一个人先匿名看过、后来登录，
 *    服务端那份是空白的 —— 那时候 list 里的 isRead 才说了算。
 */
const LOCAL_READ_KEY = 'mimitale_notice_read';
const LOCAL_READ_MAX = 200;

function localReadIds() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_READ_KEY) || '[]');
    return Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

export function isReadLocally(id) {
  return localReadIds().includes(Number(id));
}

export function markReadLocally(id) {
  const num = Number(id);
  if (!Number.isInteger(num) || num <= 0) return;
  const ids = localReadIds();
  if (ids.includes(num)) return;
  // 只留最近 200 条：公告总量不大，但别让它无限长
  const next = [...ids, num].slice(-LOCAL_READ_MAX);
  try {
    localStorage.setItem(LOCAL_READ_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式下写不进去就算了，最多下次再看一遍
  }
}
