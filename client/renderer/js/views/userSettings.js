'use strict';

// ============================================================================
//  views/userSettings.js —— 设置页第一栏「用户信息」（2026-10-23）
//
//  头像（点了就换）/ 用户名 / 邮箱（走验证码）/ 密码 / 登录凭证。
//  账号相关的界面从「账号弹窗的我的账号面板」整体搬到这儿 —— 左下角那颗按钮
//  现在只负责弹菜单（设置 / 反馈 / 退出登录），不再挂「我的账号」。
//
//  ⚠️ 不 import settings.js：settings.js 单向 import 本模块（切到这一栏时刷新），
//     反过来引用会成环。开登录弹窗、刷新侧栏那一格都由入口层注入。
//  ⚠️ 凭证卡的画法在 ui/voucherCard.js；这里只管「取数据 → 塞进 img → 导出」。
// ============================================================================

import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { iconHtml } from '../ui/icons.js';
import { pickAvatarDataUrl } from '../ui/avatarImage.js';
import { drawVoucherCard } from '../ui/voucherCard.js';
import { saveExport } from '../data/export.js';
import {
  accountUser,
  newCaptcha,
  sendEmailCode,
  updateProfile,
  changePassword,
  changeEmail,
  getVoucher
} from '../data/account.js';

const nodes = {};

/** 入口层注入：未登录时那颗「登录 / 注册」按钮开哪儿 */
let openLogin = null;
/** 入口层注入：资料变了之后刷新侧栏那一格 */
let onUserChange = () => {};

/** 邮箱那块自己的图形校验码（一次性） */
let captcha = null;
let resendTimer = null;
let resendLeft = 0;
/** 凭证数据（用户名 / 头像 / 邮箱一变就得重取重画） */
let voucherCache = null;
let voucherCode = '';

// ---------------------------------------------------------------------------
//  节点与初始化
// ---------------------------------------------------------------------------

function cacheNodes() {
  const $ = (id) => document.getElementById(id);
  nodes.section = $('sec-user');
  nodes.guest = $('user-guest');
  nodes.body = $('user-body');
  nodes.btnGuestLogin = $('btn-user-login');

  nodes.avatar = $('btn-user-avatar');
  nodes.avatarImg = $('user-avatar-img');
  nodes.nameView = $('user-name-view');
  nodes.emailView = $('user-email-view');
  nodes.since = $('user-since');

  nodes.nameInput = $('user-name-input');
  nodes.btnSaveName = $('btn-user-save-name');
  nodes.nameError = $('user-name-error');

  nodes.emailInput = $('user-email-input');
  nodes.emailCaptcha = $('user-email-captcha');
  nodes.emailCaptchaImg = $('user-email-captcha-img');
  nodes.btnEmailCaptcha = $('btn-user-email-captcha');
  nodes.emailCode = $('user-email-code');
  nodes.emailHint = $('user-email-hint');
  nodes.btnSendCode = $('btn-user-send-code');
  nodes.btnSaveEmail = $('btn-user-save-email');
  nodes.emailError = $('user-email-error');

  nodes.passCurrent = $('user-pass-current');
  nodes.passNew = $('user-pass-new');
  nodes.passConfirm = $('user-pass-confirm');
  nodes.btnSavePass = $('btn-user-save-pass');
  nodes.passError = $('user-pass-error');

  nodes.voucher = $('user-voucher');
  nodes.btnExportVoucher = $('btn-user-export-voucher');
  nodes.btnCopyVoucher = $('btn-user-copy-voucher');
  nodes.voucherError = $('user-voucher-error');
}

export function initUserSettings(opts = {}) {
  cacheNodes();
  if (typeof opts.openLogin === 'function') openLogin = opts.openLogin;
  if (typeof opts.onUserChange === 'function') onUserChange = opts.onUserChange;

  nodes.btnGuestLogin?.addEventListener('click', () => {
    if (openLogin) openLogin();
  });

  nodes.avatar?.addEventListener('click', changeAvatar);
  nodes.btnSaveName?.addEventListener('click', saveName);
  // ⚠️ 只绑一颗：图片就在这颗 button 里，别再给 img.closest('button') 也绑一次
  //    （那样点一下会换两张，前一张还被当成「用过」作废）。
  nodes.btnEmailCaptcha?.addEventListener('click', () => {
    if (nodes.emailCaptcha) nodes.emailCaptcha.value = '';
    refreshCaptcha();
  });
  nodes.btnSendCode?.addEventListener('click', requestEmailCode);
  nodes.btnSaveEmail?.addEventListener('click', saveEmail);
  nodes.btnSavePass?.addEventListener('click', savePassword);
  nodes.btnExportVoucher?.addEventListener('click', exportVoucher);
  nodes.btnCopyVoucher?.addEventListener('click', copyVoucher);
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

function setError(which, message) {
  const box = {
    name: nodes.nameError,
    email: nodes.emailError,
    pass: nodes.passError,
    voucher: nodes.voucherError
  }[which];
  if (box) box.textContent = String(message || '');
}

function setBusy(button, busy) {
  if (button) button.loading = !!busy;
}

/** m-button 的文字在里层 .mi-btn__label 里，改字必须走 setLabel */
function setBtnLabel(button, text) {
  if (!button) return;
  if (typeof button.setLabel === 'function') button.setLabel(text);
  else button.textContent = text;
}

function formatDay(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function paintAvatar(node, avatar, fallbackName) {
  if (!node) return;
  node.textContent = '';
  if (avatar) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = '';
    img.draggable = false;
    node.appendChild(img);
    return;
  }
  if (fallbackName) {
    node.textContent = Array.from(String(fallbackName))[0] || '·';
    return;
  }
  node.innerHTML = iconHtml('user', 'account-icon');
}

function stopResend() {
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = null;
  resendLeft = 0;
  if (nodes.btnSendCode) {
    nodes.btnSendCode.loading = false;
    nodes.btnSendCode.disabled = false;
    setBtnLabel(nodes.btnSendCode, '获取验证码');
  }
}

function startResend(seconds) {
  stopResend();
  resendLeft = Math.max(1, Math.round(Number(seconds) || 60));
  const tick = () => {
    if (!nodes.btnSendCode) return;
    if (resendLeft <= 0) {
      stopResend();
      return;
    }
    nodes.btnSendCode.disabled = true;
    setBtnLabel(nodes.btnSendCode, `重新获取（${resendLeft}s）`);
    resendLeft -= 1;
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
//  铺这一栏
// ---------------------------------------------------------------------------

/**
 * 刷新「用户信息」整栏。settings.js 在切到 sec-user 时调它（未登录也要调，
 * 因为用户可能在弹窗里刚登录完就切过来了）。
 */
export function renderUserSection() {
  const user = accountUser();
  const guest = !user;

  if (nodes.guest) nodes.guest.classList.toggle('hidden', !guest);
  if (nodes.body) nodes.body.classList.toggle('hidden', guest);

  if (guest) {
    stopResend();
    return;
  }

  fillHead(user);
  refreshCaptcha();
  renderVoucher(user);
}

/** 资料头 + 各表单的初值 */
function fillHead(user) {
  if (nodes.nameView) nodes.nameView.textContent = user.username || user.email || '—';
  if (nodes.emailView) nodes.emailView.textContent = user.email || '';
  if (nodes.since) nodes.since.textContent = user.createdAt ? `${formatDay(user.createdAt)} 注册` : '';
  if (nodes.nameInput) nodes.nameInput.value = user.username || '';
  paintAvatar(nodes.avatarImg, user.avatar, user.username || user.email);
}

// ---------------------------------------------------------------------------
//  头像 / 用户名
// ---------------------------------------------------------------------------

async function changeAvatar() {
  try {
    const avatar = await pickAvatarDataUrl({ title: '换一张头像' });
    if (!avatar) return; // 取消了，什么都不做
    const user = await updateProfile({ avatar });
    onUserChange(user);
    fillHead(user);
    // 卡片上印着头像，换了就得重画
    renderVoucher(user);
    showToast('头像换好了', 'ok');
  } catch (err) {
    showToast((err && err.message) || '换头像失败', 'error');
  }
}

async function saveName() {
  setError('name', '');
  const name = nodes.nameInput ? nodes.nameInput.value.trim() : '';
  if (!name) return setError('name', '先写个名字');

  const current = accountUser();
  if (current && name === (current.username || '')) return setError('name', '跟现在的一样，没改动');

  setBusy(nodes.btnSaveName, true);
  try {
    const user = await updateProfile({ username: name });
    onUserChange(user);
    fillHead(user);
    renderVoucher(user);
    showToast('用户名改好了', 'ok');
  } catch (err) {
    setError('name', (err && err.message) || '改名失败');
  } finally {
    setBusy(nodes.btnSaveName, false);
  }
}

// ---------------------------------------------------------------------------
//  邮箱（图形码 → 发码到新邮箱 → 填码 → 保存）
// ---------------------------------------------------------------------------

async function refreshCaptcha() {
  try {
    captcha = await newCaptcha();
    if (nodes.emailCaptchaImg) nodes.emailCaptchaImg.src = captcha.image;
    // 自动测试专用：主进程只在 MIMITALE_ACCOUNT_TEST=1 时回 answer，界面上不显示
    if (nodes.emailCaptcha && captcha.answer) nodes.emailCaptcha.dataset.answer = String(captcha.answer);
    else if (nodes.emailCaptcha) delete nodes.emailCaptcha.dataset.answer;
  } catch (err) {
    captcha = null;
    setError('email', (err && err.message) || '校验码加载失败');
  }
}

/** 图形码一次性：提交后不管对错都换一张 */
function consumeCaptcha() {
  captcha = null;
  if (nodes.emailCaptcha) nodes.emailCaptcha.value = '';
  refreshCaptcha();
}

async function requestEmailCode() {
  setError('email', '');
  const email = nodes.emailInput ? nodes.emailInput.value.trim() : '';
  const answer = nodes.emailCaptcha ? nodes.emailCaptcha.value.trim() : '';
  if (!email) return setError('email', '先填新邮箱');
  if (!answer) return setError('email', '先填图上的校验码');

  setBusy(nodes.btnSendCode, true);
  try {
    const result = await sendEmailCode({
      email,
      captchaId: captcha && captcha.id,
      captchaAnswer: answer
    });
    consumeCaptcha();
    if (nodes.emailHint) {
      if (result.devCode) {
        // ⚠️ 假后端专用：真后端不会回 devCode
        nodes.emailHint.textContent = `演示模式：邮件没有真发出去，验证码是 ${result.devCode}`;
        nodes.emailHint.classList.add('account-hint-dev');
      } else {
        nodes.emailHint.textContent = '验证码已发出，10 分钟内有效';
        nodes.emailHint.classList.remove('account-hint-dev');
      }
    }
    startResend(60);
  } catch (err) {
    setError('email', (err && err.message) || '验证码发送失败');
    consumeCaptcha();
  } finally {
    setBusy(nodes.btnSendCode, false);
  }
}

async function saveEmail() {
  setError('email', '');
  const email = nodes.emailInput ? nodes.emailInput.value.trim() : '';
  const code = nodes.emailCode ? nodes.emailCode.value.trim() : '';
  if (!email) return setError('email', '先填新邮箱');
  if (!code) return setError('email', '先填邮箱里收到的验证码');

  setBusy(nodes.btnSaveEmail, true);
  try {
    const user = await changeEmail({ email, code });
    onUserChange(user);
    fillHead(user);
    if (nodes.emailInput) nodes.emailInput.value = '';
    if (nodes.emailCode) nodes.emailCode.value = '';
    if (nodes.emailHint) {
      nodes.emailHint.textContent = '';
      nodes.emailHint.classList.remove('account-hint-dev');
    }
    stopResend();
    refreshCaptcha();
    renderVoucher(user);
    showToast('邮箱改好了，以后用它登录', 'ok');
  } catch (err) {
    setError('email', (err && err.message) || '改邮箱失败');
  } finally {
    setBusy(nodes.btnSaveEmail, false);
  }
}

// ---------------------------------------------------------------------------
//  密码
// ---------------------------------------------------------------------------

async function savePassword() {
  setError('pass', '');
  const current = nodes.passCurrent ? nodes.passCurrent.value : '';
  const next = nodes.passNew ? nodes.passNew.value : '';
  const again = nodes.passConfirm ? nodes.passConfirm.value : '';
  if (!current) return setError('pass', '先填当前密码');
  if (next.length < 8) return setError('pass', '新密码至少 8 位');
  if (next !== again) return setError('pass', '两次输入的新密码不一样');

  setBusy(nodes.btnSavePass, true);
  try {
    await changePassword({ currentPassword: current, password: next });
    if (nodes.passCurrent) nodes.passCurrent.value = '';
    if (nodes.passNew) nodes.passNew.value = '';
    if (nodes.passConfirm) nodes.passConfirm.value = '';
    showToast('密码改好了', 'ok');
  } catch (err) {
    setError('pass', (err && err.message) || '改密码失败');
  } finally {
    setBusy(nodes.btnSavePass, false);
  }
}

// ---------------------------------------------------------------------------
//  登录凭证
// ---------------------------------------------------------------------------

async function ensureVoucher(force) {
  if (!force && voucherCache) return voucherCache;
  voucherCache = await getVoucher();
  return voucherCache;
}

async function renderVoucher(user) {
  setError('voucher', '');
  try {
    // 资料可能刚改过（用户名 / 头像 / 邮箱都印在卡上），一律重取重画
    const info = await ensureVoucher(!!user);
    voucherCode = info.code || '';
    if (nodes.voucher) {
      nodes.voucher.src = await drawVoucherCard(info);
      nodes.voucher.dataset.code = voucherCode;
    }
  } catch (err) {
    setError('voucher', (err && err.message) || '凭证生成失败');
  }
}

async function exportVoucher() {
  setError('voucher', '');
  setBusy(nodes.btnExportVoucher, true);
  try {
    const info = await ensureVoucher(false);
    const dataUrl = await drawVoucherCard(info);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const safeName = String(info.username || 'account').replace(/[\\/:*?"<>|]/g, '_');
    await saveExport({
      title: '保存登录凭证',
      fileName: `如我所书-登录凭证-${safeName}.png`,
      base64,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
  } catch (err) {
    setError('voucher', (err && err.message) || '导出失败');
  } finally {
    setBusy(nodes.btnExportVoucher, false);
  }
}

async function copyVoucher() {
  setError('voucher', '');
  try {
    const code = voucherCode || (await ensureVoucher(false)).code;
    await api.copyText(code);
    showToast('凭证码已复制', 'ok');
  } catch (err) {
    setError('voucher', (err && err.message) || '复制失败');
  }
}

/** 退出登录后调用：把这一栏退回「还没登录」 */
export function resetUserSection() {
  voucherCache = null;
  voucherCode = '';
  stopResend();
  if (nodes.voucher) nodes.voucher.removeAttribute('src');
  renderUserSection();
}
