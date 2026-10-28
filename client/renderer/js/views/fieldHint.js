'use strict';

//  角色编辑页的「这一栏怎么写」浮窗（2026-10-28）。
//  ─────────────────────────────────────────────────────────────────────
//  在这之前：每张稿纸卡底部一条 <details class="char-fold">，五张卡五条一模一样
//  的「▸ 这一栏怎么写」。默认收起 = 常驻占位但零信息量，三张卡连读时是五条同频灰带
//  （Refactoring UI §2.4 / §3.6）。
//  现在：卡片只剩「头栏 + 正文」，说明收进头栏那颗 ?，点开才出现在这一个浮窗里。
//
//  ⚠️ 全局只有一个浮窗。说明正文按字段存在 index.html 的
//     <template class="char-hint-src" data-hint="…">，打开时把那一份拷进来 ——
//     五个浮窗各自记位置反而更乱，也没人想同时看两栏的写法。
//  ⚠️ 位置**任何时候都不保留**：换字段（点另一颗 ?）会重新贴到那一颗下面，
//     关掉再开也重新贴，窗口缩放也重新贴。拖走只是「这一次打开期间先躲一下」——
//     2026-10-28 星宝先要「关掉就忘」，紧接着又要「换帮助也重置」，合起来就是别记位置。
//  ⚠️ position: fixed，挂在 #view-char-editor 里：视图一隐藏它跟着不渲染，
//     所以不用在切视图时专门关它。祖先链上没有 transform，fixed 不会退化。

const GAP = 8; // 浮窗和那颗 ? 之间的竖向间距
const EDGE = 8; // 浮窗离窗口边缘的最小距离
const KEEP_X = 88; // 拖动时左右至少留这么多在窗口内（不然就抓不回来了）
const KEEP_Y = 34; // 上下至少留一条标题栏的高度

let root = null;
let bodyEl = null;
let titleEl = null;
let gripEl = null;
let closeBtn = null;

let anchorBtn = null; // 当前那颗 ?，用来同步 aria-expanded
let openKey = ''; // 当前显示的字段键；'' = 关着
let drag = null; // 拖动中的临时状态
let last = null; // { left, top } —— 当前位置，只给「松手夹回窗口内」用，不作记忆

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function inWindow(left, top, width, height) {
  const maxLeft = window.innerWidth - width - EDGE;
  const maxTop = window.innerHeight - height - EDGE;
  return {
    left: clamp(left, EDGE, Math.max(EDGE, maxLeft)),
    top: clamp(top, EDGE, Math.max(EDGE, maxTop))
  };
}

function applyPos(point) {
  root.style.left = `${point.left}px`;
  root.style.top = `${point.top}px`;
  last = point;
}

/** 贴着这颗 ? 摆：默认在它正下方、右缘对齐卡片右侧；下方放不下就翻到上方。 */
function placeNear(btn) {
  const rect = btn.getBoundingClientRect();
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  const top = rect.bottom + GAP;
  const point = top + height > window.innerHeight - EDGE
    ? { left: rect.right - width, top: rect.top - height - GAP }
    : { left: rect.right - width, top };
  applyPos(inWindow(point.left, point.top, width, height));
}

function labelOf(btn) {
  const sheet = btn.closest('.char-sheet');
  const label = sheet && sheet.querySelector('.field-label');
  const text = label ? label.textContent.replace(/\s+/g, ' ').trim() : '';
  return text || '这一栏';
}

function open(key, btn) {
  const src = document.querySelector(`.char-hint-src[data-hint="${key}"]`);
  if (!src) return false;
  // 上一次的 ? 先收掉 aria-expanded（换字段时它可能已经不在文档里了）
  if (anchorBtn) anchorBtn.setAttribute('aria-expanded', 'false');
  bodyEl.replaceChildren(src.content.cloneNode(true));
  titleEl.textContent = `${labelOf(btn)} · 这一栏怎么写`;
  root.hidden = false;
  anchorBtn = btn;
  openKey = key;
  btn.setAttribute('aria-expanded', 'true');
  // offsetWidth 要显示之后才量得到，所以定位放在这里、不放前面。
  // ⚠️ 无条件 placeNear：换字段（点了另一颗 ?）也要重新贴到那一颗下面 ——
  //    上一轮拖到哪儿都不带走，否则「点了新帮助、面板还停在老地方」很莫名其妙。
  placeNear(btn);
  return true;
}

function close() {
  if (!root || root.hidden) return;
  root.hidden = true;
  openKey = '';
  if (anchorBtn) anchorBtn.setAttribute('aria-expanded', 'false');
  anchorBtn = null;
  // 关掉就把位置一起忘掉（下次打开重新贴着那颗 ? 摆）。
  // ⚠️ 只清 root 的 style.left/top 不够 —— last 还留着上一轮的位置，见 applyPos。
  last = null;
  drag = null;
  root.classList.remove('is-dragging');
}

/** 点同一颗 ? = 关；点别的 = 换内容（不先关再开，那样会闪一下）。 */
function toggle(btn) {
  const key = btn.dataset.hint;
  if (!key) return;
  if (openKey === key && !root.hidden) {
    close();
    return;
  }
  open(key, btn);
}

// ------------------------------------------------------------------ 拖拽

function onPointerDown(event) {
  if (event.button !== 0) return;
  // 关闭按钮不参与拖动
  if (event.target.closest('.char-hint-close')) return;
  const rect = root.getBoundingClientRect();
  drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, active: false };
  // 合成事件（冒烟里模拟拖拽）没有真实指针，捕获它会抛 NotFoundError —— 忽略即可
  try {
    root.setPointerCapture(event.pointerId);
  } catch {
    /* 没有真实指针，拖拽照旧按 clientX/clientY 走 */
  }
  event.preventDefault();
}

function onPointerMove(event) {
  if (!drag) return;
  // pointermove 只有真的动了才触发 —— 点一下标题栏不会走到这儿
  drag.active = true;
  root.classList.add('is-dragging');
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  applyPos({
    left: clamp(event.clientX - drag.dx, KEEP_X - width, window.innerWidth - KEEP_X),
    top: clamp(event.clientY - drag.dy, 0, window.innerHeight - KEEP_Y)
  });
}

function onPointerUp(event) {
  if (!drag) return;
  if (drag.active) {
    // 松手时夹回窗口内：拖动中可以半出界（好甩），松手后必须完整可见
    applyPos(inWindow(last.left, last.top, root.offsetWidth, root.offsetHeight));
  }
  drag = null;
  root.classList.remove('is-dragging');
  if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
}

// ------------------------------------------------------------------ 初始化

export function initFieldHint() {
  if (root) return;
  root = document.getElementById('char-hint-pop');
  const view = document.getElementById('view-char-editor');
  if (!root || !view) return;
  bodyEl = document.getElementById('char-hint-body');
  titleEl = document.getElementById('char-hint-title');
  gripEl = document.getElementById('char-hint-grip');
  closeBtn = document.getElementById('btn-char-hint-close');
  if (!bodyEl || !titleEl || !gripEl || !closeBtn) return;

  // 委托：五颗 ? 都是静态的，但角色卡编辑页 DOM 会被重绘，绑到 view 上最省事
  view.addEventListener('click', (event) => {
    const btn = event.target.closest('.char-hint-btn');
    if (!btn) return;
    // ⚠️ 这颗按钮在 <label class="char-sheet-label" for="c-…"> 里面。
    //    不拦住默认行为的话，点 ? 会顺带把焦点送进 textarea（label 的点击转发）。
    event.preventDefault();
    toggle(btn);
  });

  closeBtn.addEventListener('click', close);
  gripEl.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);

  // Esc 只关浮窗，不要顺手把编辑页也退了（main.js 那条冒泡监听排在后面）。
  // 用捕获阶段 + stopPropagation：先于我，且不继续往下传。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || root.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, true);

  // 切分区时收起来：浮窗是 fixed 的，留在屏幕上会和刚换出来的那一屏对不上。
  const nav = document.getElementById('char-section-nav');
  if (nav) nav.addEventListener('click', close);

  // 窗口缩放：位置本来就不记，直接重新贴合当前那颗 ?（按钮可能已经挪位了）。
  window.addEventListener('resize', () => {
    if (root.hidden) return;
    if (anchorBtn && document.contains(anchorBtn)) placeNear(anchorBtn);
    else close();
  });
}

/** 关浮窗（换卡、离开编辑页时由入口层顺手调一下，避免回来时还挂着上一张卡的说明） */
export function closeFieldHint() {
  close();
}
