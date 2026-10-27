'use strict';

// ============================================================================
//  views/accountModal.js —— 登录 / 注册 / 凭证登录弹窗（2026-10-23）
//
//  四块面板共用一张卡片，一次只显示一块：
//    login    邮箱 + 密码 + 图形校验码
//    register 邮箱 + 图形校验码 + 邮箱验证码（**校验码过了才发码**）
//    setup    头像 + 用户名 + 密码（注册第二步）
//    voucher  抄 24 位凭证码登录
//
//  ⚠️ 「已登录」不再是这块弹窗的一屏：登录成功后弹窗直接关掉，侧栏那一格变成
//     头像 + 用户名；资料 / 密码 / 凭证都在**设置 → 用户信息**（views/userSettings.js）。
//
//  ⚠️ 这里只画界面、收输入，请求都在 data/account.js（它再走 preload → 主进程假后端）。
//  ⚠️ 不 import views/account.js —— 侧栏那一格的刷新由入口层注入 onSessionChange，
//     否则两个模块互相 import 会成环。
//  ⚠️ 图形校验码是**一次性**的：提交后不管对错都作废，所以每次提交完都要换一张，
//     不然会出现「明明输对了却一直说校验码不对」。
// ============================================================================

import { showToast } from '../ui/toast.js';
import { pickAvatarDataUrl } from '../ui/avatarImage.js';
import { readVoucherCodeFromImage } from '../ui/voucherCard.js';
import { isValidEmail } from '../data/account.js';
import {
  accountUser,
  newCaptcha,
  sendEmailCode,
  registerEmail,
  completeProfile,
  login,
  loginWithVoucher
} from '../data/account.js';

const PANES = ['login', 'register', 'setup', 'voucher'];

/** 每块的标题 / 副标题（标题也在弹窗体里，跟着面板换） */
const PANE_COPY = {
  login: ['登录', '登录后可以把角色卡和世界书同步到账号'],
  register: ['注册 · 第一步', '填邮箱，拿到验证码'],
  setup: ['注册 · 第二步', '给自己起个名字、设个密码'],
  voucher: ['用凭证登录', '导入那张凭证图，或者把上面那串码抄进来']
};

const nodes = {};

let onSessionChange = () => {};
/** 两块面板各自的图形校验码（{ id, image }），互不干扰 */
const captcha = { login: null, register: null };
/** 注册第一步的结果 { accountId, email } */
let pending = null;
/** 注册第二步选好的头像（data URL） */
let avatarDraft = '';
/** 再发一次的倒计时秒数与定时器 */
let resendLeft = 0;
let resendTimer = null;

// ---------------------------------------------------------------------------
//  取节点
// ---------------------------------------------------------------------------

function cacheNodes() {
  const $ = (id) => document.getElementById(id);
  nodes.modal = $('account-modal');
  nodes.title = $('account-title');
  // ⚠️ 不能叫 account-sub：侧栏账号格的副标题已经占了这个 id，
  //    getElementById 只会拿到先出现的那个（侧栏），弹窗这边就静默改不动。
  nodes.sub = $('account-modal-sub');
  nodes.btnClose = $('btn-close-account');

  // 登录
  nodes.loginEmail = $('acc-login-email');
  nodes.loginPassword = $('acc-login-password');
  nodes.loginCaptcha = $('acc-login-captcha');
  nodes.loginCaptchaImg = $('acc-login-captcha-img');
  nodes.btnLoginCaptcha = $('btn-login-captcha');
  nodes.loginError = $('acc-login-error');
  nodes.btnLogin = $('btn-account-login');
  nodes.btnGotoRegister = $('btn-goto-register');
  nodes.btnGotoVoucher = $('btn-goto-voucher');

  // 注册第一步
  nodes.regEmail = $('acc-reg-email');
  nodes.regCaptcha = $('acc-reg-captcha');
  nodes.regCaptchaImg = $('acc-reg-captcha-img');
  nodes.btnRegCaptcha = $('btn-reg-captcha');
  nodes.regCode = $('acc-reg-code');
  nodes.regHint = $('acc-reg-hint');
  nodes.regError = $('acc-reg-error');
  nodes.btnSendCode = $('btn-account-send-code');
  nodes.btnRegisterNext = $('btn-account-register-next');
  nodes.btnRegisterBack = $('btn-register-back');

  // 注册第二步
  nodes.setupAvatar = $('acc-setup-avatar');
  nodes.btnPickAvatar = $('btn-pick-avatar');
  nodes.setupName = $('acc-setup-name');
  nodes.setupPassword = $('acc-setup-password');
  nodes.setupPassword2 = $('acc-setup-password2');
  nodes.setupError = $('acc-setup-error');
  nodes.btnFinish = $('btn-account-finish');
  nodes.btnSetupBack = $('btn-setup-back');

  // 凭证登录
  nodes.voucherCode = $('acc-voucher-code');
  nodes.voucherError = $('acc-voucher-error');
  nodes.btnVoucherLogin = $('btn-account-voucher-login');
  nodes.btnVoucherImport = $('btn-voucher-import');
  nodes.btnVoucherBack = $('btn-voucher-back');

  for (const name of PANES) nodes[`pane-${name}`] = $(`account-pane-${name}`);
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

function setError(which, message) {
  const box =
    which === 'login' ? nodes.loginError
      : which === 'register' ? nodes.regError
        : which === 'setup' ? nodes.setupError
          : nodes.voucherError;
  if (box) box.textContent = String(message || '');
}

function clearErrors() {
  for (const which of ['login', 'register', 'setup', 'voucher']) setError(which, '');
}

function setBusy(button, busy) {
  if (button) button.loading = !!busy;
}

/** ⚠️ m-button 的文字在里层 .mi-btn__label 里，直接 textContent= 会把结构清掉 */
function setBtnLabel(button, text) {
  if (!button) return;
  if (typeof button.setLabel === 'function') button.setLabel(text);
  else button.textContent = text;
}

function showPane(name) {
  if (!PANES.includes(name)) return;
  for (const pane of PANES) {
    const node = nodes[`pane-${pane}`];
    if (node) node.classList.toggle('hidden', pane !== name);
  }
  const [title, sub] = PANE_COPY[name];
  if (nodes.title) nodes.title.textContent = title;
  if (nodes.sub) nodes.sub.textContent = sub;
  clearErrors();

  // 进哪一屏就把光标放在第一个该填的地方（省一次点击）
  const focusMap = {
    login: nodes.loginEmail,
    register: nodes.regEmail,
    setup: nodes.setupName,
    voucher: nodes.voucherCode
  };
  const target = focusMap[name];
  if (target) setTimeout(() => target.focus && target.focus(), 40);
}

export function isAccountModalOpen() {
  return !!(nodes.modal && !nodes.modal.classList.contains('hidden'));
}

export function closeAccountModal() {
  if (nodes.modal) nodes.modal.classList.add('hidden');
  stopResendCountdown();
}

// ---------------------------------------------------------------------------
//  图形校验码
// ---------------------------------------------------------------------------

async function refreshCaptcha(which) {
  const img = which === 'login' ? nodes.loginCaptchaImg : nodes.regCaptchaImg;
  const input = which === 'login' ? nodes.loginCaptcha : nodes.regCaptcha;
  try {
    const result = await newCaptcha();
    captcha[which] = result;
    if (img) img.src = result.image;
    // 自动测试专用钩子：主进程只在 MIMITALE_ACCOUNT_TEST=1 时才回 answer。
    // 界面上**不显示**它，只是让冒烟能填对（真后端永远不回这个字段）。
    if (input && result.answer) input.dataset.answer = String(result.answer);
    else if (input) delete input.dataset.answer;
  } catch (err) {
    captcha[which] = null;
    if (img) img.removeAttribute('src');
    setError(which === 'login' ? 'login' : 'register', (err && err.message) || '校验码加载失败');
  }
}

/** 提交后不管对错都换一张（图形码一次性） */
function consumeCaptcha(which) {
  captcha[which] = null;
  const input = which === 'login' ? nodes.loginCaptcha : nodes.regCaptcha;
  if (input) input.value = '';
  refreshCaptcha(which);
}

// ---------------------------------------------------------------------------
//  发码倒计时
// ---------------------------------------------------------------------------

function stopResendCountdown() {
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = null;
  resendLeft = 0;
  if (nodes.btnSendCode) {
    nodes.btnSendCode.loading = false;
    nodes.btnSendCode.disabled = false;
    setBtnLabel(nodes.btnSendCode, '获取验证码');
  }
}

function startResendCountdown(seconds) {
  stopResendCountdown();
  resendLeft = Math.max(1, Math.round(Number(seconds) || 60));
  const tick = () => {
    if (!nodes.btnSendCode) return;
    if (resendLeft <= 0) {
      stopResendCountdown();
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
//  头像（注册第二步）
// ---------------------------------------------------------------------------

function paintAvatarSlot(node, avatar) {
  if (!node) return;
  node.textContent = '';
  if (!avatar) return;
  const img = document.createElement('img');
  img.src = avatar;
  img.alt = '';
  img.draggable = false;
  node.appendChild(img);
}

async function pickAvatar() {
  setError('setup', '');
  try {
    const avatar = await pickAvatarDataUrl({ title: '选一张头像' });
    if (!avatar) return; // 取消了
    avatarDraft = avatar;
    paintAvatarSlot(nodes.setupAvatar, avatarDraft);
  } catch (err) {
    setError('setup', (err && err.message) || '头像处理失败');
  }
}

// ---------------------------------------------------------------------------
//  登录成功之后
// ---------------------------------------------------------------------------

function afterLogin(user, message) {
  onSessionChange(user);
  // 2026-10-23：不再跳「我的账号」面板 —— 关掉弹窗，账号相关的都在设置 → 用户信息
  closeAccountModal();
  resetForms();
  if (message) showToast(message, 'ok');
}

function resetForms() {
  pending = null;
  avatarDraft = '';
  stopResendCountdown();
  if (nodes.loginPassword) nodes.loginPassword.value = '';
  if (nodes.loginCaptcha) nodes.loginCaptcha.value = '';
  if (nodes.regCaptcha) nodes.regCaptcha.value = '';
  if (nodes.regCode) nodes.regCode.value = '';
  if (nodes.regHint) {
    nodes.regHint.textContent = '';
    nodes.regHint.classList.remove('account-hint-dev');
  }
  if (nodes.voucherCode) nodes.voucherCode.value = '';
  showPane('login');
}

// ---------------------------------------------------------------------------
//  各面板的提交
// ---------------------------------------------------------------------------

async function submitLogin() {
  setError('login', '');
  const email = nodes.loginEmail.value.trim();
  const password = nodes.loginPassword.value;
  const answer = nodes.loginCaptcha.value.trim();
  if (!email) return setError('login', '先填邮箱');
  if (!password) return setError('login', '先填密码');
  if (!answer) return setError('login', '先填图上的校验码');

  setBusy(nodes.btnLogin, true);
  try {
    const user = await login({
      email,
      password,
      captchaId: captcha.login && captcha.login.id,
      captchaAnswer: answer
    });
    consumeCaptcha('login');
    afterLogin(user, `登录成功，欢迎回来${user.username ? '，' + user.username : ''}`);
  } catch (err) {
    setError('login', (err && err.message) || '登录失败');
    consumeCaptcha('login');
  } finally {
    setBusy(nodes.btnLogin, false);
  }
}

async function requestCode() {
  setError('register', '');
  const email = nodes.regEmail.value.trim();
  const answer = nodes.regCaptcha.value.trim();
  if (!email) return setError('register', '先填邮箱');
  if (!answer) return setError('register', '先填图上的校验码');

  setBusy(nodes.btnSendCode, true);
  try {
    const result = await sendEmailCode({
      email,
      captchaId: captcha.register && captcha.register.id,
      captchaAnswer: answer
    });
    consumeCaptcha('register');
    if (nodes.regHint) {
      if (result.devCode) {
        // 服务端 DEV_ECHO_CODE=true（本地开发）时才回 devCode —— 那时邮件照发，
        // 只是额外把码给界面一份，省得去 mailpit 网页里抄。生产关掉这个开关，
        // 就只会走下面的「验证码已发出」分支。
        nodes.regHint.textContent = `演示模式：邮件没有真发出去，验证码是 ${result.devCode}`;
        nodes.regHint.classList.add('account-hint-dev');
      } else {
        nodes.regHint.textContent = `验证码已发出，${Math.round((result.expiresIn || 600) / 60)} 分钟内有效`;
        nodes.regHint.classList.remove('account-hint-dev');
      }
    }
    startResendCountdown(60);
  } catch (err) {
    setError('register', (err && err.message) || '验证码发送失败');
    consumeCaptcha('register');
  } finally {
    setBusy(nodes.btnSendCode, false);
  }
}

async function submitRegisterNext() {
  setError('register', '');
  const email = nodes.regEmail.value.trim();
  const code = nodes.regCode.value.trim();
  if (!email) return setError('register', '先填邮箱');
  if (!code) return setError('register', '先填邮件里那 6 位验证码');

  setBusy(nodes.btnRegisterNext, true);
  try {
    const result = await registerEmail({ email, code });
    pending = { accountId: result.accountId, email: result.email || email };
    avatarDraft = '';
    paintAvatarSlot(nodes.setupAvatar, '');
    nodes.setupName.value = '';
    nodes.setupPassword.value = '';
    nodes.setupPassword2.value = '';
    showPane('setup');
  } catch (err) {
    setError('register', (err && err.message) || '注册失败');
  } finally {
    setBusy(nodes.btnRegisterNext, false);
  }
}

async function submitFinish() {
  setError('setup', '');
  if (!pending) {
    showPane('register');
    return setError('register', '这一步过期了，重新填一遍邮箱');
  }
  const username = nodes.setupName.value.trim();
  const password = nodes.setupPassword.value;
  const again = nodes.setupPassword2.value;
  if (!username) return setError('setup', '先起个用户名');
  if (password.length < 8) return setError('setup', '密码至少 8 位');
  if (password !== again) return setError('setup', '两次输入的密码不一样');

  setBusy(nodes.btnFinish, true);
  try {
    const user = await completeProfile({
      accountId: pending.accountId,
      username,
      password,
      avatar: avatarDraft
    });
    pending = null;
    avatarDraft = '';
    afterLogin(user, '注册好了，欢迎');
  } catch (err) {
    setError('setup', (err && err.message) || '保存资料失败');
  } finally {
    setBusy(nodes.btnFinish, false);
  }
}

/**
 * 导入凭证图片登录。
 *
 * 那张导出的 PNG 里带着凭证码本身（PNG 的 tEXt 块，见 ui/voucherCard.js），
 * 所以这里不解图、不 OCR，直接读元数据 —— 读到了就把码填进输入框并直接登。
 * 读不到（截图 / 转发过的图会重编码、把自定义块丢掉）就老老实实让人抄。
 */
async function importVoucherImage() {
  setError('voucher', '');
  let picked = null;
  try {
    picked = await window.mimitale.pickImage({ title: '选择凭证图片' });
  } catch (err) {
    return setError('voucher', (err && err.message) || '打不开图片');
  }
  if (!picked || picked.canceled) return;
  if (picked.error) return setError('voucher', picked.error);

  const code = readVoucherCodeFromImage(picked.dataUrl || '');
  if (!code) {
    return setError('voucher', '这张图里读不出凭证码 —— 截图或转发过的图会丢信息，手动抄那串码吧');
  }

  nodes.voucherCode.value = code;
  // 走一遍输入格式化（4 位一组），跟手输出来的样子保持一致
  nodes.voucherCode.dispatchEvent(new Event('input', { bubbles: true }));
  await submitVoucherLogin();
}

async function submitVoucherLogin() {
  setError('voucher', '');
  const code = nodes.voucherCode.value.trim();
  if (!code) return setError('voucher', '先填凭证码');

  setBusy(nodes.btnVoucherLogin, true);
  try {
    const user = await loginWithVoucher({ voucher: code });
    afterLogin(user, `凭证有效，欢迎回来${user.username ? '，' + user.username : ''}`);
  } catch (err) {
    setError('voucher', (err && err.message) || '凭证登录失败');
  } finally {
    setBusy(nodes.btnVoucherLogin, false);
  }
}

// ---------------------------------------------------------------------------
//  打开 / 关闭
// ---------------------------------------------------------------------------

/**
 * 打开账号弹窗。which 只在未登录时有意义（'register' / 'voucher' 直接跳过去）。
 * ⚠️ 已登录时**不开**：那时候点左下角弹的是账号菜单，不是这个窗。
 */
export function openAccountModal(which) {
  if (accountUser()) {
    showToast('已经登录了，改资料去「设置 → 用户信息」', 'ok');
    return;
  }
  if (which === 'register') {
    showPane('register');
    refreshCaptcha('register');
  } else if (which === 'voucher') {
    showPane('voucher');
  } else {
    showPane('login');
    // 每次打开都换一张：上一次可能已经用掉了（一次性）
    refreshCaptcha('login');
  }
  if (nodes.modal) nodes.modal.classList.remove('hidden');
}

export function initAccountModal(opts = {}) {
  cacheNodes();
  if (typeof opts.onSessionChange === 'function') onSessionChange = opts.onSessionChange;

  nodes.btnClose?.addEventListener('click', closeAccountModal);
  // 点遮罩关掉；点卡片本身不关
  nodes.modal?.addEventListener('mousedown', (event) => {
    if (event.target === nodes.modal) closeAccountModal();
  });

  // 登录
  nodes.btnLogin?.addEventListener('click', submitLogin);
  nodes.btnLoginCaptcha?.addEventListener('click', () => {
    if (nodes.loginCaptcha) nodes.loginCaptcha.value = '';
    refreshCaptcha('login');
  });
  nodes.btnGotoRegister?.addEventListener('click', () => {
    showPane('register');
    // 登录框里已经写了邮箱的话顺手带过去，省得再打一遍
    if (nodes.regEmail && !nodes.regEmail.value && isValidEmail(nodes.loginEmail.value)) {
      nodes.regEmail.value = nodes.loginEmail.value.trim();
    }
    refreshCaptcha('register');
  });
  nodes.btnGotoVoucher?.addEventListener('click', () => showPane('voucher'));

  // 注册第一步
  nodes.btnSendCode?.addEventListener('click', requestCode);
  nodes.btnRegCaptcha?.addEventListener('click', () => {
    if (nodes.regCaptcha) nodes.regCaptcha.value = '';
    refreshCaptcha('register');
  });
  nodes.btnRegisterNext?.addEventListener('click', submitRegisterNext);
  nodes.btnRegisterBack?.addEventListener('click', () => resetForms());

  // 注册第二步
  nodes.btnPickAvatar?.addEventListener('click', pickAvatar);
  nodes.btnFinish?.addEventListener('click', submitFinish);
  nodes.btnSetupBack?.addEventListener('click', () => {
    showPane('register');
    refreshCaptcha('register');
  });

  // 凭证登录
  nodes.btnVoucherLogin?.addEventListener('click', submitVoucherLogin);
  nodes.btnVoucherImport?.addEventListener('click', importVoucherImage);
  nodes.btnVoucherBack?.addEventListener('click', () => {
    showPane('login');
    refreshCaptcha('login');
  });
  // 边输边排：粘一串没连字符的码也能认（后端同样会规整）
  nodes.voucherCode?.addEventListener('input', () => {
    const raw = nodes.voucherCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
    nodes.voucherCode.value = raw.replace(/(.{4})(?=.)/g, '$1-');
  });
}
