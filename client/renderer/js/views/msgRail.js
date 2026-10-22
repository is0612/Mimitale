'use strict';

// ============================================================================
//  views/msgRail.js —— 消息区右缘那一竖排刻度（轮次导航条 / turn navigator）
//
//  对齐 DeepSeek Harness 的 turn rail：
//    · 一根刻度 = 一轮（你的一句 + 对它的回复），**等距**排（10px 一档），
//      不再按真实高度比例 —— 等距才扫得动；轮数多到框里装不下时框内自己滚，
//      能滚的那一端渐隐 24px，提示「这里还有」。
//    · 框竖着居中在消息区里（最多 420px 高），不跟正文抢地方；
//      消息区太矮（< 40px）或不到两轮就不出现 —— 一根孤零零的刻度没有信息量。
//    · 读到哪一轮，那根刻度就**变长变实**（默认 60% 长、半透明；悬停 90%；
//      当前 100% 且最实）。滚正文时自动把当前刻度带回框内，但只带过渐隐带
//      就停 —— 小幅滚动时整排刻度不能来回抽动。指针停在条上时不动条，免得从手底下跑掉。
//    · 悬停刻度 → 左边浮出一张卡片：你那句话（1 行，50 字）+ 回复摘要
//      （3 行，120 字）。就地截，不调模型、不花 token。
//
//  ⚠️ 消息序号只认节点上的 `data-index`（chatMessages.js 的 messageNode 挂的）。
//     别按 children 序号数 —— 中间还夹着 `.msg-date-sep`，数错就跳错人。
//  ⚠️ 单位是「轮」不是「条」：用户消息是轮的开头，后面连续的 AI 回复算同一轮；
//     会话开头的 AI 开场白自己算一轮（没有提示词，预览只显示轮次号 + 回复）。
//  ⚠️ 本模块不往 state 里存任何东西，只读当前会话 + 量 DOM。重绘时机由 renderMessages 决定。
// ============================================================================

import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { CONFIG } from '../core/config.js';

const TURN_GAP = 10; // 相邻刻度中心距（px）
const RAIL_INSET = 6; // 第一根 / 最后一根刻度中心到框边的留白
const FADE = 24; // 框内可滚时两端的渐隐带；也是「自动跟随时不挪条」的安全带
const MARK_H = 10; // 刻度（按钮）高度，整行都是点击区
const MIN_TURNS = 2; // 少于两轮不显示 —— 一轮的会话一眼就看完了
const MAX_FRAME_H = 420; // 框最高这么高，再高就在框内滚
const FRAME_MARGIN = 64; // 框与消息区上下沿至少留这么多，别顶到场景栏 / 输入框
const PROMPT_CHARS = 50; // 预览卡第一行截多少字
const REPLY_CHARS = 120; // 预览卡回复截多少字（CSS 再夹到 3 行）

let bound = false;
let railEl = null;
let scrollerEl = null;
let marksEl = null;
let previewEl = null;
let previewPromptEl = null;
let previewReplyEl = null;

let turns = []; // [{ turn, startIndex, node, prompt, reply }]
let markEls = []; // 与 turns 一一对应
let activeTurn = null; // 阅读线落在哪一轮
let previewTurn = null; // 悬停 / 聚焦中的那一轮
let pointerInside = false; // 指针在条上时，自动跟随不挪条
let layoutRaf = 0;
let syncRaf = 0;

/** 绑 DOM 与事件。只绑一次，入口层在启动时调。 */
export function initMsgRail() {
  if (bound) return;
  railEl = document.getElementById('msg-rail');
  if (!railEl) return;
  bound = true;

  railEl.textContent = '';

  scrollerEl = document.createElement('div');
  scrollerEl.className = 'msg-rail-scroller';
  marksEl = document.createElement('div');
  marksEl.className = 'msg-rail-marks';
  scrollerEl.appendChild(marksEl);
  railEl.appendChild(scrollerEl);

  previewEl = document.createElement('div');
  previewEl.className = 'msg-rail-preview hidden';
  previewEl.id = 'msg-rail-preview';
  previewEl.setAttribute('role', 'tooltip');
  previewPromptEl = document.createElement('div');
  previewPromptEl.className = 'msg-rail-preview-prompt';
  previewReplyEl = document.createElement('div');
  previewReplyEl.className = 'msg-rail-preview-reply';
  previewEl.append(previewPromptEl, previewReplyEl);
  railEl.appendChild(previewEl);

  // 挂在 scroller 上而不是 rail 上：框本身 pointer-events: none，只让刻度收鼠标
  scrollerEl.addEventListener('pointerenter', () => {
    pointerInside = true;
  });
  scrollerEl.addEventListener('pointerleave', () => {
    pointerInside = false;
    hidePreview();
  });

  scrollerEl.addEventListener('click', (event) => {
    const mark = event.target.closest ? event.target.closest('.msg-rail-mark') : null;
    if (mark) jumpTo(Number(mark.dataset.turn));
  });

  marksEl.addEventListener('pointerover', (event) => {
    const mark = event.target.closest ? event.target.closest('.msg-rail-mark') : null;
    if (mark) showPreview(Number(mark.dataset.turn));
  });

  // 框内自己滚：更新渐隐；悬停中的预览卡跟着那根刻度走
  scrollerEl.addEventListener(
    'scroll',
    () => {
      updateFades();
      positionPreview();
    },
    { passive: true }
  );

  railEl.addEventListener('keydown', onKeyDown);

  // 正文滚动只改「哪一轮是当前」和框内滚动位置，不碰刻度间距
  el.messages.addEventListener(
    'scroll',
    () => {
      const box = el.messages;
      if (!box || !turns.length) return;
      // 两头不用量几何就能定：贴底 = 最后一轮（哪怕整段短到滚不动），回到顶 = 第一轮。
      // 先兜住这两头是为了跟随不出那一帧的延迟 —— 中间位置才值得量阅读线。
      if (box.scrollHeight - box.scrollTop - box.clientHeight <= CONFIG.SCROLL_BOTTOM_THRESHOLD) {
        setActive(turns[turns.length - 1].turn, false);
        return;
      }
      if (box.scrollTop <= 1) {
        setActive(turns[0].turn, false);
        return;
      }
      scheduleSync();
    },
    { passive: true }
  );

  // 窗口缩放 / 左右内缩拖动 / 场景栏换行 / 输入框长高 —— 都会改消息区高度，
  // 框的位置和预览卡宽度都得跟着重算。
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(scheduleLayout).observe(el.messages);
  }
  window.addEventListener('resize', scheduleLayout);
}

/**
 * 按当前会话重建刻度。由 chatMessages.js 的 renderMessages 在整棵消息树挂好之后调。
 * ⚠️ 必须放在消息节点已经进 DOM 之后 —— 要拿节点量「读到哪一轮」。
 */
export function renderMsgRail() {
  if (!bound || !railEl) return;

  const convo = activeConvo();
  const msgs = convo && Array.isArray(convo.messages) ? convo.messages : [];
  turns = buildTurns(msgs);

  for (const mark of markEls) mark.remove();
  markEls = [];
  activeTurn = null;
  previewTurn = null;
  hidePreview();

  if (turns.length < MIN_TURNS) {
    railEl.classList.add('hidden');
    return;
  }
  railEl.classList.remove('hidden');

  // 每轮挂到它开头那条消息节点上：跳转和「读到哪一轮」都靠它
  for (const turn of turns) {
    turn.node = el.messages.querySelector(`.msg[data-index="${turn.startIndex}"]`);
  }

  // 容器高度按条数撑开：刻度是绝对定位、不占位，不撑开就滚不动
  marksEl.style.height = `${RAIL_INSET * 2 + (turns.length - 1) * TURN_GAP}px`;

  const frag = document.createDocumentFragment();
  turns.forEach((turn, index) => {
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'msg-rail-mark';
    mark.dataset.turn = String(turn.turn);
    mark.dataset.index = String(turn.startIndex);
    mark.style.top = `${RAIL_INSET - MARK_H / 2 + index * TURN_GAP}px`;
    mark.tabIndex = -1; // 只有「当前这一轮」进 Tab 序列（roving tabindex），否则 Tab 会被几百根刻度困住
    mark.setAttribute('aria-label', `跳到第 ${turn.turn} 轮`);
    frag.appendChild(mark);
    markEls.push(mark);
  });
  marksEl.appendChild(frag);

  layout();
}

/** 把消息序列切成轮：用户消息开头，后面连续的回复算同一轮。 */
function buildTurns(msgs) {
  const out = [];
  let current = null;

  for (let i = 0; i < msgs.length; i += 1) {
    const message = msgs[i];
    if (!message) continue;
    const isUser = message.role === 'user';

    if (isUser || current === null) {
      current = {
        turn: out.length + 1,
        startIndex: i,
        node: null,
        prompt: isUser ? String(message.content || '') : '',
        reply: isUser ? '' : String(message.content || '')
      };
      out.push(current);
    } else if (!current.reply) {
      // 只拿这一轮的第一条回复做预览：后面继续写的不再挤进卡片
      current.reply = String(message.content || '');
    }
  }

  return out;
}

/** 合并到下一帧再排 —— 拖动内缩时 ResizeObserver 会连发好几次 */
function scheduleLayout() {
  if (layoutRaf) return;
  layoutRaf = requestAnimationFrame(() => {
    layoutRaf = 0;
    layout();
  });
}

/** 量消息区、定框、更新预览卡宽度，再把当前刻度带进框里。 */
function layout() {
  if (!bound || !railEl) return;
  const box = el.messages;
  const col = railEl.parentElement;
  if (!box || !col) return;

  // 框竖着居中在消息区里，上下各让出 FRAME_MARGIN
  const boxRect = box.getBoundingClientRect();
  const colRect = col.getBoundingClientRect();
  const frameH = Math.max(0, Math.min(MAX_FRAME_H, boxRect.height - FRAME_MARGIN));
  railEl.style.top = `${Math.round(boxRect.top - colRect.top + (boxRect.height - frameH) / 2)}px`;
  railEl.style.height = `${Math.round(frameH)}px`;

  // 预览卡宽度跟着正文实际可用宽度收，窗口拖窄时不许顶出左边
  const cs = getComputedStyle(box);
  const avail =
    box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  railEl.style.setProperty(
    '--msg-rail-preview-w',
    `${Math.round(Math.max(180, Math.min(300, avail - 120)))}px`
  );

  // 两轮以下或消息区太矮都不露面
  railEl.classList.toggle('hidden', turns.length < MIN_TURNS || frameH < 40);
  if (turns.length < MIN_TURNS || frameH < 40) return;

  updateFades();
  syncActive(true);
}

/** 滚动合并到下一帧 —— 一帧只量一次，别让每次 scroll 事件都碰 DOM。 */
function scheduleSync() {
  if (syncRaf) return;
  syncRaf = requestAnimationFrame(() => {
    syncRaf = 0;
    syncActive(false);
  });
}

/** 算出「阅读线落在哪一轮」，把它设成当前。 */
function syncActive(immediate) {
  if (!turns.length) return;
  const box = el.messages;
  if (!box) return;

  // 贴底时直接认最后一轮：底部那点余量不算「翻上去了」
  const atBottom =
    box.scrollHeight - box.scrollTop - box.clientHeight <= CONFIG.SCROLL_BOTTOM_THRESHOLD;
  let turn = turns[turns.length - 1].turn;

  if (!atBottom) {
    // 阅读线：消息区上沿往下 min(96, 20%)。落在谁身上就是读到谁。
    const line = box.getBoundingClientRect().top + Math.min(96, box.clientHeight * 0.2);
    let low = 0;
    let high = turns.length;
    let found = 0;
    // 每轮首节点的纵向位置单调不减，二分就够，不必每次量几百个
    while (low < high) {
      const mid = (low + high) >> 1;
      const node = turns[mid].node;
      if (node && node.getBoundingClientRect().top <= line) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    turn = turns[found].turn;
  }

  setActive(turn, immediate);
}

/** 切换当前刻度：高亮、Tab 焦点，并（指针不在条上时）把它带回框内。 */
function setActive(turn, immediate) {
  if (activeTurn === turn) {
    if (immediate) reveal(turn, true);
    return;
  }
  activeTurn = turn;

  for (const mark of markEls) {
    const on = Number(mark.dataset.turn) === turn;
    mark.classList.toggle('is-active', on);
    mark.tabIndex = on ? 0 : -1;
    if (on) mark.setAttribute('aria-current', 'true');
    else mark.removeAttribute('aria-current');
  }

  if (!pointerInside) reveal(turn, !!immediate);
}

/** 把某一轮带到框里：只在越过渐隐带时才动，居中停下。 */
function reveal(turn, instant) {
  const index = turns.findIndex((item) => item.turn === turn);
  if (index < 0 || !scrollerEl) return;
  const viewH = scrollerEl.clientHeight;
  if (viewH <= 0) return;

  const center = RAIL_INSET + index * TURN_GAP;
  const current = scrollerEl.scrollTop;
  // 已经在「非渐隐区」里就不动 —— 否则每滚一下整排刻度都在抽
  if (center >= current + FADE && center <= current + viewH - FADE) return;

  const max = Math.max(0, scrollerEl.scrollHeight - viewH);
  const top = Math.max(0, Math.min(max, center - viewH / 2));
  if (Math.abs(top - current) < 1) return;

  if (instant || prefersReducedMotion()) scrollerEl.scrollTop = top;
  else scrollerEl.scrollTo({ top, behavior: 'smooth' });
}

/** 两端还能不能滚 → 渐隐开 / 关；整排装得下时不接管滚轮。 */
function updateFades() {
  if (!scrollerEl) return;
  const rest = scrollerEl.scrollHeight - scrollerEl.clientHeight;
  const scrollable = rest > 1;
  scrollerEl.classList.toggle('is-scrollable', scrollable);
  scrollerEl.classList.toggle('is-fade-top', scrollable && scrollerEl.scrollTop > 1);
  scrollerEl.classList.toggle('is-fade-bottom', scrollable && scrollerEl.scrollTop < rest - 1);
}

/** 悬停浮层：你那句话 1 行 + 回复摘要 3 行。 */
function showPreview(turn) {
  const index = turns.findIndex((item) => item.turn === turn);
  if (index < 0 || !previewEl) return;
  const item = turns[index];
  previewTurn = turn;

  const prompt = flatText(item.prompt);
  previewPromptEl.textContent = prompt ? cutText(prompt, PROMPT_CHARS) : `第 ${item.turn} 轮`;
  const reply = flatText(item.reply);
  previewReplyEl.textContent = cutText(reply, REPLY_CHARS);
  previewReplyEl.classList.toggle('hidden', !reply);

  for (const mark of markEls) {
    const on = Number(mark.dataset.turn) === turn;
    mark.classList.toggle('is-preview', on && turn !== activeTurn);
    // 只有真正弹出卡片的那一根把卡片挂成自己的描述（屏幕阅读器才念得出来）
    if (on) mark.setAttribute('aria-describedby', previewEl.id);
    else mark.removeAttribute('aria-describedby');
  }

  previewEl.classList.remove('hidden');
  // 贴在框左边，纵向对齐那根刻度；贴顶 / 贴底时由 CSS 的 clamp 夹回框里
  positionPreview();
}

/** 预览卡的纵向锚点 = 悬停那根刻度的中心（相对框顶）。 */
function positionPreview() {
  if (!previewEl || previewTurn === null || !railEl) return;
  const index = turns.findIndex((item) => item.turn === previewTurn);
  if (index < 0) return;
  railEl.style.setProperty(
    '--msg-rail-preview-center',
    `${RAIL_INSET + index * TURN_GAP - scrollerEl.scrollTop}px`
  );
}

function hidePreview() {
  previewTurn = null;
  if (previewEl) previewEl.classList.add('hidden');
  for (const mark of markEls) {
    mark.classList.remove('is-preview');
    mark.removeAttribute('aria-describedby');
  }
}

/** 键盘：上下 / Home / End 在刻度间走，Enter 或空格跳过去。 */
function onKeyDown(event) {
  if (!turns.length) return;
  const focused = document.activeElement;
  const current = focused && focused.dataset ? Number(focused.dataset.turn) : NaN;
  const at = turns.findIndex((item) => item.turn === current);

  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    if (at < 0) return;
    event.preventDefault();
    jumpTo(turns[at].turn);
    return;
  }

  let next = -1;
  if (event.key === 'ArrowDown') next = Math.min(turns.length - 1, (at < 0 ? -1 : at) + 1);
  else if (event.key === 'ArrowUp') next = Math.max(0, at < 0 ? turns.length - 1 : at - 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = turns.length - 1;
  else return;

  if (next < 0) return;
  event.preventDefault();
  const mark = markEls[next];
  if (!mark) return;
  mark.focus();
  showPreview(turns[next].turn);
}

/** 跳到第 turn 轮开头那条消息。smooth 是因为跳跃幅度可能几千像素，瞬移会丢失方向感。 */
function jumpTo(turn) {
  const item = turns.find((entry) => entry.turn === turn);
  const node = item && item.node;
  if (!node) return;
  const box = el.messages;
  const offset = node.getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.scrollTo({
    top: Math.max(0, box.scrollTop + offset - 24),
    behavior: prefersReducedMotion() ? 'auto' : 'smooth'
  });

  flashNode(node);
  setActive(turn, true);
}

/** 落点闪一下，不然几千像素跳过去不知道落在哪条上。 */
function flashNode(node) {
  node.classList.remove('msg-rail-flash');
  void node.offsetWidth; // 强制回流，否则连续两次跳同一条不会重放动画
  node.classList.add('msg-rail-flash');
  setTimeout(() => node.classList.remove('msg-rail-flash'), 1000);
}

function prefersReducedMotion() {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** 摘要用：剥掉 markdown 记号（不然卡片里会出现一堆 `**`）、压平空白。 */
function flatText(content) {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#|]+/g, ' ')
    .replace(/\{\{\s*(char|user)\s*\}\}/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cutText(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
