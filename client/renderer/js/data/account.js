'use strict';

// ============================================================================
//  data/account.js —— 账号状态与动作（渲染层）
//
//  只做两件事：把 preload 的账号通道包成「抛中文错的 Promise」、记住当前登录用户。
//  ⚠️ 不碰 DOM —— 侧栏那一格在 views/account.js，弹窗在 views/accountModal.js。
//  ⚠️ 现在背后是主进程的假后端（main/account.js）。服务器到位后这一层**不用改**，
//     改的是主进程那份实现。
// ============================================================================

import { api } from '../core/api.js';

/** 当前登录用户；null = 未登录 */
let cachedUser = null;
/** 有没有问过主进程（首屏拉一次就够） */
let loaded = false;

function unwrap(result, fallback) {
  if (result && result.ok) return result;
  throw new Error((result && result.error) || fallback);
}

/**
 * 邮箱「像不像邮箱」的粗判，只给界面用（比如把登录框里填的邮箱顺手带进注册框）。
 * 真正的校验在主进程 normalizeEmail 里，两边都留着 —— 界面这层只是为了早一点提示。
 */
export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

export function accountUser() {
  return cachedUser;
}

export function isLoggedIn() {
  return !!cachedUser;
}

export function accountLoaded() {
  return loaded;
}

/** 启动时读一次登录状态；失败当未登录（不拦启动） */
export async function loadAccount() {
  try {
    const result = unwrap(await api.accountSession(), '读取登录状态失败');
    cachedUser = result.user || null;
  } catch (err) {
    console.warn('[account] 读取登录状态失败:', (err && err.message) || err);
    cachedUser = null;
  }
  loaded = true;
  return cachedUser;
}

/**
 * 重新拉一次会话（会员是后台改的，本地快照不会自己变）。
 *
 * ⚠️ 跟 loadAccount 的差别在失败时：这里**保留**已登录态、照旧返回缓存。
 *    loadAccount 是首屏判断「登没登录」，拉不到就当没登录；这颗刷新按钮
 *    如果也那样，服务器抖一下就会把正在用的人显示成未登录。
 */
export async function refreshAccount() {
  try {
    const result = unwrap(await api.accountSession(), '刷新失败');
    cachedUser = result.user || null;
  } catch (err) {
    console.warn('[account] 刷新登录状态失败，沿用本地快照:', (err && err.message) || err);
  }
  return cachedUser;
}

/** 换一张图形校验码 → { id, image, expiresIn } */
export async function newCaptcha() {
  return unwrap(await api.accountCaptcha(), '校验码获取失败');
}

/** 发邮箱验证码（后端会先验图形码）→ { email, expiresIn, deliver, devCode? } */
export async function sendEmailCode(payload) {
  return unwrap(await api.accountSendCode(payload), '验证码发送失败');
}

/** 注册第一步 → { accountId, email, needsProfile } */
export async function registerEmail(payload) {
  return unwrap(await api.accountRegister(payload), '注册失败');
}

/** 注册第二步（头像 / 用户名 / 密码）→ 登录态 user */
export async function completeProfile(payload) {
  const result = unwrap(await api.accountCompleteProfile(payload), '保存资料失败');
  cachedUser = result.user || null;
  return cachedUser;
}

export async function login(payload) {
  const result = unwrap(await api.accountLogin(payload), '登录失败');
  cachedUser = result.user || null;
  return cachedUser;
}

export async function loginWithVoucher(payload) {
  const result = unwrap(await api.accountVoucherLogin(payload), '凭证登录失败');
  cachedUser = result.user || null;
  return cachedUser;
}

export async function logout() {
  unwrap(await api.accountLogout(), '退出登录失败');
  cachedUser = null;
}

/** 取登录凭证（画卡片要的字段）→ { code, username, email, avatar, createdAt } */
export async function getVoucher() {
  return unwrap(await api.accountVoucher(), '读取登录凭证失败');
}

/**
 * 换一张新凭证码 → 同形状。⚠️ 旧码服务端直接覆盖，调用前必须让用户确认。
 * 返回的形状里没有 user，所以不动 cachedUser。
 */
export async function refreshVoucher() {
  return unwrap(await api.accountRefreshVoucher(), '刷新凭证码失败');
}

export async function updateProfile(payload) {
  const result = unwrap(await api.accountUpdateProfile(payload), '保存资料失败');
  cachedUser = result.user || null;
  return cachedUser;
}

export async function changePassword(payload) {
  const result = unwrap(await api.accountChangePassword(payload), '修改密码失败');
  cachedUser = result.user || null;
  return cachedUser;
}

/** 改邮箱：payload = { email, code } —— code 是发到**新邮箱**的那 6 位 */
export async function changeEmail(payload) {
  const result = unwrap(await api.accountChangeEmail(payload), '修改邮箱失败');
  cachedUser = result.user || null;
  return cachedUser;
}
