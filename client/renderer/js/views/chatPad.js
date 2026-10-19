'use strict';

// 这个视图负责对话区宽度：两侧可拖的抓手、拖动时的数值标签（唯一能看到准确值的地方，别删）、预览落点的虚线。
// ⚠️ 左右各写各的键：动左边时右边那个值连读都不会被读到 —— 用户明确要求过不要「一调节就左右一起收缩」。
// ⚠️ 抓手挂在 .composer 上：挂进 .messages 会被 overflow-y:auto 一起滚走，挂 .chat-col 则因输入框 auto-grow 对不准。

import { el } from '../core/dom.js';
import { state } from '../core/state.js';
import { iconSvg } from '../ui/icons.js';
import {
  applyChatAppearance,
  persistAppearance,
  CHAT_PAD_DEFAULT,
  CHAT_PAD_MAX,
  CHAT_PAD_MIN
} from './appearance.js';

const KEYS = { left: 'chatPadLeft', right: 'chatPadRight' };

/** 坏值退回默认，夹取口径与 applyChatAppearance 一致 */
function padValue(side) {
  const n = Number((state.settings || {})[KEYS[side]]);
  if (!Number.isFinite(n)) return CHAT_PAD_DEFAULT;
  return Math.min(CHAT_PAD_MAX, Math.max(CHAT_PAD_MIN, Math.round(n)));
}

/** 拖动中的实时值夹同一套边界：下限 12，往内拖到底也不贴边（见 CHAT_PAD_MIN） */
function clamp(px) {
  return Math.min(CHAT_PAD_MAX, Math.max(CHAT_PAD_MIN, Math.round(px)));
}

/** 只改内存里的值 + 立刻重刷 CSS 变量：拖动过程中的预览，不落盘 */
function preview(side, px) {
  // 就地改，别替换 state.settings 对象 —— 别处可能已经持有它的引用
  state.settings = state.settings || {};
  state.settings[KEYS[side]] = px;
  applyChatAppearance();
}

// --- 拖动时的小标签 ---

let badge = null;

function showBadge(side, px) {
  const col = el.messages && el.messages.parentElement;
  if (!col) return;
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'pad-badge';
    col.appendChild(badge);
  }
  const label = side === 'left' ? '左' : '右';
  badge.textContent = `${label}内缩 ${px}px · 可拖动`;
  badge.style.left = side === 'left' ? '28px' : 'auto';
  badge.style.right = side === 'left' ? 'auto' : '28px';
  badge.style.top = '50%';
  badge.style.transform = 'translateY(-50%)';
  badge.classList.remove('hidden');
}

function hideBadge() {
  if (badge) badge.classList.add('hidden');
}

// --- 拖动时那条虚线 ---

// 画在松手后会落到的地方（= 当前内缩值），不是跟着鼠标跑 —— 要回答的是「松手之后正文会缩到哪」。
// ⚠️ 竖直范围按消息区算：定位基准是 .chat-col（含顶栏和输入框），不夹一下会从顶栏一直裂到底部。

function guideFor(side) {
  return side === 'left' ? el.padGuideLeft : el.padGuideRight;
}

function showGuide(side, px) {
  const msgs = el.messages;
  const guide = guideFor(side);
  if (!msgs || !guide) return;

  // ⚠️ 竖直范围从消息区顶一直到对话列底：内缩对消息区和输入框都生效，只画消息区那段会让人以为输入框不会动
  const col = msgs.parentElement; // .chat-col
  const top = msgs.offsetTop;
  const height = col ? Math.max(0, col.clientHeight - top) : msgs.offsetHeight;
  guide.style.top = `${top}px`;
  guide.style.height = `${height}px`;
  if (side === 'left') {
    guide.style.left = `${px}px`;
    guide.style.right = 'auto';
  } else {
    guide.style.right = `${px}px`;
    guide.style.left = 'auto';
  }
  guide.classList.remove('hidden');
}

function hideGuides() {
  if (el.padGuideLeft) el.padGuideLeft.classList.add('hidden');
  if (el.padGuideRight) el.padGuideRight.classList.add('hidden');
}

// 抓手跟着虚线走，减 8 = 抓手宽 16px 的中心对齐 0 宽虚线（不是左边缘贴线）。
// ⚠️ 直接赋值即对齐：.chat-col 无 padding、.composer 是它贴边且无 border 的直接子元素，两把尺是同一把。
function moveHandleTo(handle, side, px) {
  if (!handle) return;
  const offset = px - 8;
  if (side === 'left') {
    handle.style.left = `${offset}px`;
    handle.style.right = 'auto';
  } else {
    handle.style.right = `${offset}px`;
    handle.style.left = 'auto';
  }
}

// --- 抓手 ---

function bindHandle(handle, side) {
  if (!handle) return;
  // 图标得自己插：这些按钮是空标签 + data-icon，applyFieldIcons 只扫一遍静态 HTML
  if (!handle.querySelector('svg')) {
    const svg = iconSvg('width');
    if (svg) handle.insertAdjacentHTML('afterbegin', svg);
  }

  let startX = 0;
  let startPad = 0;

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    startX = event.clientX;
    startPad = padValue(side);
    handle.classList.add('dragging');
    try {
      handle.setPointerCapture(event.pointerId);
    } catch (err) {
      /* 没有指针捕获也能拖，忽略 */
    }
    document.body.classList.add('pad-dragging');
    showBadge(side, startPad);
    showGuide(side, startPad);
    moveHandleTo(handle, side, startPad);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!handle.classList.contains('dragging')) return;
    // 左边跟着指针往右走 = 内缩变大；右边反过来（往左拖才是变宽）。
    const delta = event.clientX - startX;
    const px = clamp(side === 'left' ? startPad + delta : startPad - delta);
    preview(side, px);
    showBadge(side, px);
    showGuide(side, px);
    moveHandleTo(handle, side, px);
  });

  const finish = () => {
    if (!handle.classList.contains('dragging')) return;
    handle.classList.remove('dragging');
    document.body.classList.remove('pad-dragging');
    hideBadge();
    hideGuides();
    // 只在松手时落盘一次（拖动过程中每帧写配置是没有必要的）
    const px = padValue(side);
    // 松手后抓手**停在新内缩线上**（跟虚线同一处），而不是弹回 CSS 的 4px 贴边 ——
    // 抓手代表的就是「正文从这里缩进去」的那条边界，它该一直骑在那条线上。
    moveHandleTo(handle, side, px);
    Promise.resolve(persistAppearance({ [KEYS[side]]: px })).catch(() => {});
  };

  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

// ---------------------------------------------------------------------------

/**
 * 把两侧抓手摆到**当前设置里**的内缩线上。
 *
 * ⚠️ 这个函数必须能在「设置加载完之后」再被调一次 —— 这是修「重启后抓手回原位」的关键。
 *    initChatPad() 跑在 main.js 里 state.settings 赋值**之前**（事件绑定属于启动早期），
 *    那一刻 padValue() 只能读到默认值 20，于是抓手被摆到 20px 处；
 *    而正文 / 输入框的缩进是稍后 applyChatAppearance() 按**真实值**（比如 196px）刷的 ——
 *    两边就此错开，看起来就是「一重启抓手就重置了」。见 main.js 里 applyChatAppearance() 之后那次调用。
 */
export function syncChatPadHandles() {
  moveHandleTo(el.padHandleLeft, 'left', padValue('left'));
  moveHandleTo(el.padHandleRight, 'right', padValue('right'));
}

export function initChatPad() {
  bindHandle(el.padHandleLeft, 'left');
  bindHandle(el.padHandleRight, 'right');
  // 先摆一次兜底：CSS 只给了 4px 的贴边默认值，跟内缩值（默认 20px）错开，
  // 不摆的话进软件第一眼抓手就骑在错误的位置。
  // ⚠️ 此刻 state.settings 可能还没加载（见 syncChatPadHandles 的注释），
  //    摆的是默认值 —— 设置到位后由 syncChatPadHandles() 再摆一次修正。
  syncChatPadHandles();
}
