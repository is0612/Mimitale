'use strict';

// ============================================================================
//  views/userSettings.js —— 「个人中心」这一屏（2026-10-28 从设置页拆出来）
//
//  两件事都在这个文件里：
//    ① 内容：头像（点了就换）/ 用户名 / 邮箱（走验证码）/ 密码 / 登录凭证 / 会员 / 邀请；
//    ② 那一屏本身：打开 / 返回 / 左栏三组导航的切换（openProfile / leaveProfile /
//       showProfileSection）。骨架与设置页**完全一样**（settings-shell），
//       只是内容分了三组 —— 星宝 2026-10-28 要的「拆开后跟设置页面一样」。
//
//  ⚠️ 不 import settings.js（那边单向 import 本模块）；也不 import accountModal，
//     开登录弹窗、刷新侧栏那一格都由入口层注入。
//  ⚠️ 凭证卡的画法在 ui/voucherCard.js；这里只管「取数据 → 塞进 img → 导出」。
//  ⚠️ 三组内容的显隐靠 #view-profile 上的 data-guest 和 .hidden，别再包一层 #user-body
//     （包了之后 `.settings-content > .panel-section` 那套样式就落不上了）。
// ============================================================================

import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { iconHtml } from '../ui/icons.js';
import { pickAvatarDataUrl } from '../ui/avatarImage.js';
import { drawVoucherCard } from '../ui/voucherCard.js';
import { confirmDialog } from '../ui/confirm.js';
import { saveExport } from '../data/export.js';
// 视图切换（单向：它只登记显隐/高亮，不认识本模块）
import { showView, currentViewName } from './viewSwitch.js';
import {
  accountUser,
  refreshAccount,
  newCaptcha,
  sendEmailCode,
  updateProfile,
  changePassword,
  changeEmail,
  getVoucher,
  refreshVoucher,
  redeemCard
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

/** 进个人中心之前停在哪一屏：返回 / Esc 都回到它 */
let returnView = 'chat';
/** 这次运行里选中哪一组（存 section 的 id），默认第一组「资料」 */
let currentSectionId = 'sec-profile';

// ---------------------------------------------------------------------------
//  节点与初始化
// ---------------------------------------------------------------------------

function cacheNodes() {
  const $ = (id) => document.getElementById(id);
  // 整屏（data-guest 挂在它上面）与页头「返回」
  nodes.view = $('view-profile');
  nodes.btnBack = $('btn-back-profile');
  nodes.guest = $('user-guest');
  nodes.btnGuestLogin = $('btn-user-login');

  nodes.avatar = $('btn-user-avatar');
  nodes.avatarImg = $('user-avatar-img');
  nodes.nameView = $('user-name-view');
  nodes.emailView = $('user-email-view');
  nodes.since = $('user-since');

  nodes.nameInput = $('user-name-input');
  nodes.btnSaveName = $('btn-user-save-name');
  nodes.nameError = $('user-name-error');

  nodes.memberBadge = $('user-member-badge');
  nodes.memberLine = $('user-member-line');
  nodes.memberError = $('user-member-error');
  nodes.btnRefreshMember = $('btn-user-refresh-member');

  nodes.redeemCode = $('user-redeem-code');
  nodes.btnRedeem = $('btn-user-redeem');
  nodes.redeemMsg = $('user-redeem-msg');
  nodes.redeemError = $('user-redeem-error');

  nodes.inviteCode = $('user-invite-code');
  nodes.inviteCount = $('user-invite-count');
  nodes.inviteError = $('user-invite-error');
  nodes.btnCopyInvite = $('btn-user-copy-invite');

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
  nodes.btnRefreshVoucher = $('btn-user-refresh-voucher');
  nodes.voucherError = $('user-voucher-error');
}

export function initUserSettings(opts = {}) {
  cacheNodes();
  if (typeof opts.openLogin === 'function') openLogin = opts.openLogin;
  if (typeof opts.onUserChange === 'function') onUserChange = opts.onUserChange;

  nodes.btnBack?.addEventListener('click', leaveProfile);

  // 左栏三个分组：监听挂在**这一屏**上（不是 document），事件不会跑到别处去。
  nodes.view?.addEventListener('click', (event) => {
    const nav = event.target.closest ? event.target.closest('.settings-nav-item') : null;
    if (!nav) return;
    const target = nav.getAttribute('data-target');
    if (target) showProfileSection(target);
  });

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
  nodes.btnRefreshVoucher?.addEventListener('click', renewVoucher);
  nodes.btnRefreshMember?.addEventListener('click', refreshMembership);
  nodes.btnRedeem?.addEventListener('click', () => void submitRedeem());
  // 回车直接兑 —— 这一格唯一的动作就是它，不该让人再点一下
  nodes.redeemCode?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitRedeem();
    }
  });
  nodes.btnCopyInvite?.addEventListener('click', copyInvite);
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

function setError(which, message) {
  const box = {
    name: nodes.nameError,
    email: nodes.emailError,
    pass: nodes.passError,
    member: nodes.memberError,
    redeem: nodes.redeemError,
    invite: nodes.inviteError,
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

/**
 * 主进程 / preload 没重启时，IPC 抛的是一串技术黑话（No handler registered /
 * is not a function），直接摆给用户看等于没说。翻译成一句能照做的话。
 */
function ipcErrorText(err, fallback) {
  const raw = (err && err.message) || '';
  if (/No handler registered|is not a function/i.test(raw)) return '客户端更新过了，重启一次就好';
  return raw || fallback;
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
 * 刷新整屏账号内容。入口层在登录 / 退出时调，openProfile 进屏前也调一次
 * （未登录也要调：用户可能在弹窗里刚登录完就切过来了）。
 */
export function renderUserSection() {
  const user = accountUser();
  const guest = !user;

  // 未登录：CSS 按这个属性把左栏导航和三组内容整块藏掉，只留一块「还没登录」。
  if (nodes.view) nodes.view.dataset.guest = guest ? '1' : '0';
  if (nodes.guest) nodes.guest.classList.toggle('hidden', !guest);

  if (guest) {
    stopResend();
    return;
  }

  fillHead(user);
  renderMembership(user);
  renderInvite(user);
  // 快照里没有会员字段或邀请码（老版本存的 / 离线时写的）→ 静默补一次，别让这几块一直空着
  if (!user.membership || !user.inviteCode) void refreshMembership({ quiet: true });
  refreshCaptcha();
  renderVoucher(user);
  // 刚登录完那一刻三组都还是 hidden（HTML 里只有第一组没有 hidden），补一次显隐
  showProfileSection(currentSectionId);
}

// ---------------------------------------------------------------------------
//  这一屏本身：打开 / 返回 / 左栏切组
// ---------------------------------------------------------------------------

/** 切到某一组：左栏高亮、右栏只显示对应那组、内容滚回顶部。id 不认识就什么都不做。 */
export function showProfileSection(id) {
  if (!id || !nodes.view) return;
  const section = nodes.view.querySelector(`#${id}`);
  if (!section) return;

  currentSectionId = id;

  for (const item of nodes.view.querySelectorAll('.settings-nav-item')) {
    const on = item.getAttribute('data-target') === id;
    item.classList.toggle('active', on);
    // aria-current 没有「false」这个合法值：不选中就是移除属性
    if (on) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }

  for (const box of nodes.view.querySelectorAll('.settings-content > .panel-section')) {
    box.classList.toggle('hidden', box.id !== id);
  }

  const content = nodes.view.querySelector('.settings-content');
  if (content) content.scrollTop = 0;
}

/**
 * 打开个人中心。
 * @param {string} [section] 指定落到哪一组。⚠️ 只认字符串：调用方可能把它当 click
 *   监听器绑（那样第一个参数是 PointerEvent），写进 dataset 就是一个事件对象。
 * ⚠️ 这一屏**只对登录用户有意义**：未登录时内容区会整块换成「还没登录」+ 登录按钮，
 *    所以入口（账号菜单）只在登录后才出现，堵入口是调用方的事。
 */
export function openProfile(section) {
  const wanted = typeof section === 'string' ? section : '';

  // 已经在这一屏：不重灌内容（会把正在填的邮箱 / 密码冲掉），只切组
  if (currentViewName() === 'profile') {
    if (wanted) showProfileSection(wanted);
    return;
  }
  if (wanted) currentSectionId = wanted;

  // 记下来处：返回 / Esc 都回到它
  returnView = currentViewName();

  renderUserSection();
  showView('profile');
  // 焦点落在页头「返回」上（别聚焦输入框：type=password 一获得焦点就整段选中）
  if (nodes.btnBack) nodes.btnBack.focus();
}

/** 离开个人中心，回到进来之前那一屏 */
export function leaveProfile() {
  showView(returnView === 'profile' ? 'chat' : returnView);
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
//  会员（只读，值由后台改）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  会员 / 免费天数（只读，值由后台改）
// ---------------------------------------------------------------------------

/**
 * 纯函数：会员数据 → 文案。
 *
 * 两个钱包，谁在有效期就说谁：
 *   ① 有会员（后台发的）→「会员剩 X 天」
 *   ② 只有免费天数（注册送 30 天 + 每邀 1 人 7 天）→「免费还剩 X 天」
 *   ③ 都过期 → 说最后一次是哪天用完的
 *
 * ⚠️ 「有没有过期」只认服务端给的 `active` / `*DaysLeft`，**不要**自己拿日期和
 *    本地时钟比 —— 用户把系统时间往前调就能把自己变成永久会员。
 */
function membershipCopy(m) {
  const active = !!(m && m.active);
  const free = m && typeof m.freeDaysLeft === 'number' ? m.freeDaysLeft : null;
  const member = m && typeof m.memberDaysLeft === 'number' ? m.memberDaysLeft : null;

  let badge = '—';
  let line = '';

  if (!m) {
    line = '会员信息还没读到';
  } else if (member !== null) {
    badge = m.name || '会员';
    line = member <= 1 ? '会员今天到期' : `会员剩 ${member} 天 · ${formatDay(m.memberExpireAt)} 到期`;
  } else if (free !== null) {
    badge = '免费中';
    line = free <= 1 ? '免费天数今天用完' : `免费还剩 ${free} 天 · ${formatDay(m.freeExpireAt)} 到期`;
  } else {
    badge = '已结束';
    const last = m.memberExpireAt || m.freeExpireAt;
    line = last ? `已于 ${formatDay(last)} 用完，开通会员继续用` : '还没有开始用';
  }

  return { badge, active, line };
}

function renderMembership(user) {
  const copy = membershipCopy(user && user.membership);

  if (nodes.memberBadge) {
    nodes.memberBadge.textContent = copy.badge;
    nodes.memberBadge.dataset.active = copy.active ? '1' : '0';
  }
  if (nodes.memberLine) nodes.memberLine.textContent = copy.line;
}

// ---------------------------------------------------------------------------
//  邀请好友（码由服务端发，客户端只显示和复制）
// ---------------------------------------------------------------------------

/**
 * 纯函数：拼要复制出去的那段话。
 *
 * 不做 `mimitale://` 也不做网址 —— 现在没有域名，自定义协议还要写注册表，
 * 装不装客户端都能用的一句话最稳（用户选的就是这个）。
 */
function inviteText(code) {
  return `来试试「如我所书」，注册时填邀请码 ${code}`;
}

function renderInvite(user) {
  const code = (user && user.inviteCode) || '';
  const count = (user && user.invitedCount) || 0;

  if (nodes.inviteCode) {
    nodes.inviteCode.textContent = code || '还没生成';
    nodes.inviteCode.dataset.empty = code ? '0' : '1';
  }
  if (nodes.inviteCount) {
    // 邀请是「每邀 1 人 +7 天免费」，人数后面直接把这笔天数说出来，
    // 不然用户不知道自己赚了多少
    const bonus = (user && user.freeDaysFromInvite) || 0;
    nodes.inviteCount.textContent =
      count > 0 ? `已经邀请了 ${count} 人，多得了 ${bonus} 天免费` : '还没有人用你的码';
  }
  if (nodes.btnCopyInvite) nodes.btnCopyInvite.disabled = !code;
}

async function copyInvite() {
  setError('invite', '');
  const code = ((accountUser() || {}).inviteCode || '').trim();
  if (!code) return setError('invite', '邀请码还没生成，点上面的「刷新」试试');

  try {
    await api.copyText(inviteText(code));
    showToast('邀请链接已复制，粘给朋友就行', 'ok');
  } catch (err) {
    setError('invite', ipcErrorText(err, '复制失败'));
  }
}

/** 兑换卡密 —— 一张卡只兑一次，兑换成功服务端会回带新会员状态的 user */
let redeeming = false;

async function submitRedeem() {
  if (redeeming) return;

  const raw = nodes.redeemCode ? nodes.redeemCode.value.trim() : '';
  if (!raw) {
    setError('redeem', '先把卡密填上');
    nodes.redeemCode?.focus?.();
    return;
  }

  redeeming = true;
  setError('redeem', '');
  if (nodes.redeemMsg) nodes.redeemMsg.classList.add('hidden');
  setBusy(nodes.btnRedeem, true);

  try {
    const { user, grant } = await redeemCard(raw);
    // 码已经用掉了，清空但**保留焦点**：万一还有第二张，接着输就行
    if (nodes.redeemCode) {
      nodes.redeemCode.value = '';
      nodes.redeemCode.focus?.();
    }
    renderMembership(user);
    renderInvite(user);
    onUserChange(user);

    if (nodes.redeemMsg) {
      const days = grant && grant.days ? grant.days : 0;
      const until = grant && grant.expiresAt ? `，${formatDay(grant.expiresAt)} 到期` : '';
      // 兑换时会把还剩的免费天数并进会员，所以「买了 90 天却显示 120 天」要说清楚
      const absorbed = grant && grant.absorbedFreeDays ? grant.absorbedFreeDays : 0;
      const extra = absorbed > 0 ? `（含并入的 ${absorbed} 天免费）` : '';
      nodes.redeemMsg.textContent = `兑换成功：会员 +${days} 天${until}${extra}`;
      nodes.redeemMsg.classList.remove('hidden');
    }
  } catch (err) {
    // 服务端给的原文（「这张卡已经被用掉了」这种）比「兑换失败」有用得多
    setError('redeem', (err && err.message) || '兑换失败');
  } finally {
    redeeming = false;
    setBusy(nodes.btnRedeem, false);
  }
}

/**
 * 重拉一次 /me。发会员、补邀请码都在服务端做，客户端不会自己知道。
 * quiet = 静默（进页面时补字段用），不转圈、不弹提示。
 */
async function refreshMembership(opts = {}) {
  const quiet = opts.quiet === true;
  setError('member', '');
  if (!quiet) setBusy(nodes.btnRefreshMember, true);

  try {
    const user = await refreshAccount();
    if (!user) {
      // 只有 token 真失效才走到这儿（主进程已经清掉登录态），跟着退回未登录
      onUserChange(null);
      renderUserSection();
      return;
    }
    renderMembership(user);
    // 这里刷的是整份 /me，邀请码和人数也一起变了
    renderInvite(user);
    onUserChange(user);
    if (!quiet) showToast('会员信息已刷新', 'ok');
  } catch (err) {
    if (!quiet) setError('member', (err && err.message) || '刷新失败');
  } finally {
    if (!quiet) setBusy(nodes.btnRefreshMember, false);
  }
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

/**
 * 换一张新凭证码。
 *
 * ⚠️ 这是**不可撤销**的：服务端直接覆盖旧码，刷新成功那一刻之前导出的图 / 抄下来的码
 *    全部作废。所以必须先问一句，而且不许「顺手刷新」。
 */
async function renewVoucher() {
  setError('voucher', '');

  const ok = await confirmDialog({
    title: '刷新凭证码？',
    message: '换一张新的 24 位码，之前那张立刻失效 —— 之前导出的凭证图、抄下来的码都登不进来了。',
    confirmText: '刷新',
    danger: true
  });
  if (!ok) return;

  setBusy(nodes.btnRefreshVoucher, true);
  try {
    const info = await refreshVoucher();
    // 缓存里还是旧码，必须整份换掉，否则「复制」会复制到已经作废的那张
    voucherCache = info;
    voucherCode = info.code || '';
    if (nodes.voucher) {
      nodes.voucher.src = await drawVoucherCard(info);
      nodes.voucher.dataset.code = voucherCode;
    }
    showToast('凭证码换好了，旧的已经失效', 'ok');
  } catch (err) {
    setError('voucher', ipcErrorText(err, '刷新失败'));
  } finally {
    setBusy(nodes.btnRefreshVoucher, false);
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
