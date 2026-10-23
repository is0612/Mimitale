'use strict';

// ============================================================================
//  views/account.js —— 侧栏左下角那一格「我是谁」
//
//  未登录：人形图标 + 「未登录 / 登录后同步角色卡」，点一下开登录弹窗；
//          右边那颗齿轮直接进设置（这时候还没有菜单，齿轮得留着）。
//  已登录：整行只剩「头像 + 用户名」（齿轮收进菜单里），点一下往上弹出账号菜单：
//          设置 / 意见反馈 / 退出登录 —— 对着 DeepSeek 那种左下角做的（2026-10-23）。
//
//  ⚠️ 这一格自己**不发请求**：菜单三个动作由入口层注入，退出登录走 data/account.js。
//  ⚠️ 别 import accountModal.js —— 它反过来要用这里的 renderAccount，互相 import 会成环。
//     开登录是入口层塞进来的 openLogin。
//  ⚠️ 头像如果来自服务器 URL，会被 index.html 的 CSP（img-src 'self' data: file:）拦掉；
//     现在存的都是本地压缩后的 data URL。
// ============================================================================

import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';
import { iconHtml } from '../ui/icons.js';
import { loadAccount, logout } from '../data/account.js';
// 设置页那一栏和这一格显示的是同一个人，退出之后要一起退回「还没登录」
import { resetUserSection } from './userSettings.js';

/** 入口层注入的动作 */
const actions = {
  openLogin: null,
  openSettings: null,
  openFeedback: null
};

let menuOpen = false;

const LOGGED_OUT_NAME = '未登录';
const LOGGED_OUT_SUB = '登录后同步角色卡';

// ---------------------------------------------------------------------------
//  账号菜单
// ---------------------------------------------------------------------------

function setMenuOpen(next) {
  if (!el.accountMenu || !el.btnAccount) return;
  menuOpen = !!next;
  el.accountMenu.classList.toggle('hidden', !menuOpen);
  el.btnAccount.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
}

export function closeAccountMenu() {
  setMenuOpen(false);
}

function toggleMenu() {
  setMenuOpen(!menuOpen);
}

async function doLogout() {
  try {
    await logout();
    renderAccount(null);
    resetUserSection();
    showToast('已退出登录', 'ok');
  } catch (err) {
    showToast((err && err.message) || '退出失败', 'error');
  }
}

// ---------------------------------------------------------------------------
//  初始化
// ---------------------------------------------------------------------------

export function initAccount(opts = {}) {
  if (typeof opts.openLogin === 'function') actions.openLogin = opts.openLogin;
  if (typeof opts.openSettings === 'function') actions.openSettings = opts.openSettings;
  if (typeof opts.openFeedback === 'function') actions.openFeedback = opts.openFeedback;
  if (!el.btnAccount) return undefined;

  el.btnAccount.addEventListener('click', (event) => {
    // 别让这一下继续冒到 document —— 否则「点别处关菜单」会当场把刚开的菜单关掉
    event.stopPropagation();
    if (el.sidebarAccount && el.sidebarAccount.dataset.loggedIn === '1') {
      toggleMenu();
      return;
    }
    if (actions.openLogin) {
      actions.openLogin();
      return;
    }
    showToast('登录界面没接上，先把位置占住', 'ok');
  });

  el.btnAccountSettings?.addEventListener('click', () => {
    closeAccountMenu();
    if (actions.openSettings) actions.openSettings();
  });
  el.btnAccountFeedback?.addEventListener('click', () => {
    closeAccountMenu();
    if (actions.openFeedback) actions.openFeedback();
  });
  el.btnAccountMenuLogout?.addEventListener('click', () => {
    closeAccountMenu();
    doLogout();
  });

  // 菜单里任何一项点下去都收起（动作各自在上面绑）
  el.accountMenu?.addEventListener('click', () => closeAccountMenu());

  // 点别处关
  document.addEventListener('click', (event) => {
    if (!menuOpen) return;
    if (el.sidebarAccount && el.sidebarAccount.contains(event.target)) return;
    closeAccountMenu();
  });

  // 焦点跑出这一格也收起（纯键盘操作时，别留一个开着却拿不到焦点的菜单）
  document.addEventListener('focusin', (event) => {
    if (!menuOpen) return;
    if (el.sidebarAccount && el.sidebarAccount.contains(event.target)) return;
    closeAccountMenu();
  });

  // Esc 先关菜单：捕获阶段吃掉，别让 main.js 的「关弹窗」链跟着跑
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menuOpen) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAccountMenu();
  }, true);

  // 开局先画成未登录，再去主进程问一次真实登录态（失败当未登录，不拦启动）
  renderAccount(null);
  return loadAccount()
    .then((user) => renderAccount(user))
    .catch(() => renderAccount(null));
}

// ---------------------------------------------------------------------------
//  画那一格
// ---------------------------------------------------------------------------

/**
 * 画账号格。传 null = 未登录。
 * @param {{username?: string, email?: string, avatar?: string}|null} user
 */
export function renderAccount(user) {
  const logged = !!user;
  const name = logged ? user.username || user.email || LOGGED_OUT_NAME : LOGGED_OUT_NAME;
  const sub = logged ? user.email || '已登录' : LOGGED_OUT_SUB;

  // 状态挂在容器上：CSS 要同时「藏副标题」和「藏齿轮」，挂在按钮上够不着兄弟节点
  if (el.sidebarAccount) el.sidebarAccount.dataset.loggedIn = logged ? '1' : '0';

  if (el.accountName) el.accountName.textContent = name;
  if (el.accountSub) el.accountSub.textContent = sub;

  if (el.btnAccount) {
    const label = logged ? `账号：${name}` : '账号（未登录）';
    el.btnAccount.setAttribute('aria-label', label);
    el.btnAccount.title = label;
    el.btnAccount.dataset.loggedIn = logged ? '1' : '0';
  }

  // 退出登录之后菜单不该还开着（那时候里面三项都没意义）
  if (!logged) closeAccountMenu();

  if (el.accountAvatar) {
    el.accountAvatar.textContent = '';
    if (logged && user.avatar) {
      const img = document.createElement('img');
      img.src = user.avatar;
      img.alt = '';
      img.draggable = false;
      el.accountAvatar.appendChild(img);
    } else if (logged) {
      // 没设头像就用名字首字
      el.accountAvatar.textContent = Array.from(name)[0] || '·';
    } else {
      el.accountAvatar.innerHTML = iconHtml('user', 'account-icon');
    }
  }
}
