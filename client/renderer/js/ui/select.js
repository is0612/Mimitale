'use strict';

// ui/select.js —— 自研下拉皮肤：只在原生 <select> 上罩一层自己的列表
// ⚠️ 原生 <select> 必须原地留着当值的地基：30+ 处 select.value、CSS 子选择器、closest('.field') 都靠它。
// 弹层挂 body + position:fixed（祖先滚动容器会裁切）；监听是文档级 + 首点懒标记，动态下拉不用逐个接。

import { h, clear } from './build.js';

/** 弹层与触发器 / 视口边缘之间留的空隙 */
const GAP = 6;
const EDGE = 8;
/** 弹层最窄多宽：角色编辑器里那些属性下拉只有 64px，列表跟着那么窄没法读 */
const MIN_WIDTH = 140;
/** 连打同一个键多久之内算同一个词；超过重开一个词（原生下拉：连按 = 循环切换）。 */
const TYPEAHEAD_RESET = 700;

/** 唯一那个弹层（懒建）和当前开着的那一个 */
let pop = null;
let active = null;
/** 行的 DOM，下标与 active.rows 一一对应 */
let nodes = [];
let index = -1;
/** 打字定位的缓冲：{ text, at } */
let typed = null;
/** 文档级监听只装一次 */
let wired = false;

// ---- 纯逻辑 ----

/** <option> 显示的文字（label 属性优先，和浏览器一致） */
function optionText(opt) {
  const explicit = opt.label;
  if (explicit != null && String(explicit) !== '') return String(explicit);
  return String(opt.textContent == null ? '' : opt.textContent).trim();
}

/** 把 <select> 下的 option / optgroup 读成「分组 + 行」；没有 optgroup 就是一组，组名空串。 */
export function readGroups(select) {
  const groups = [];
  let plain = null;
  for (const child of Array.from((select && select.children) || [])) {
    if (child.tagName === 'OPTGROUP') {
      const rows = [];
      for (const opt of Array.from(child.children || [])) {
        if (opt.tagName !== 'OPTION') continue;
        rows.push({ value: String(opt.value), label: optionText(opt), disabled: !!opt.disabled });
      }
      if (rows.length) {
        groups.push({ label: String(child.label || ''), rows });
        // 分组后再出现的散项要另起一组，否则会被并回前一组，顺序和原生 DOM 不一致。
        plain = null;
      }
    } else if (child.tagName === 'OPTION') {
      if (!plain) {
        plain = { label: '', rows: [] };
        groups.push(plain);
      }
      plain.rows.push({ value: String(child.value), label: optionText(child), disabled: !!child.disabled });
    }
  }
  return groups;
}

/** 铺进弹层的显示清单：只有两个以上分组时才插组标题（单组再顶一行组名白吃一行可见项）。 */
export function buildRenderList(groups) {
  const named = (groups || []).filter((g) => g && g.label && g.rows && g.rows.length);
  const out = [];
  let lastLabel = null;
  for (const g of groups || []) {
    if (!g || !Array.isArray(g.rows) || !g.rows.length) continue;
    if (named.length > 1 && g.label && g.label !== lastLabel) {
      out.push({ kind: 'group', label: g.label });
      lastLabel = g.label;
    }
    for (const r of g.rows) {
      out.push({ kind: 'row', value: String(r.value), label: String(r.label), disabled: !!r.disabled });
    }
  }
  return out;
}

/** 显示清单里的「行」（组标题不是行，键盘不落在它上面） */
export function renderRows(list) {
  return (list || []).filter((item) => item && item.kind === 'row');
}

/** 第一个可用项（全禁用时给 -1） */
export function firstEnabled(rows) {
  const list = rows || [];
  for (let i = 0; i < list.length; i += 1) if (!list[i].disabled) return i;
  return -1;
}

/** 最后一个可用项 */
export function lastEnabled(rows) {
  const list = rows || [];
  for (let i = list.length - 1; i >= 0; i -= 1) if (!list[i].disabled) return i;
  return -1;
}

/**
 * 上下键：到头就停住（绕回另一头容易点错），跳过禁用项；index 传 -1 时落到第一个可用项。
 */
export function stepIndex(rows, index, step) {
  const list = rows || [];
  const count = list.length;
  if (!count) return -1;
  let i = index < 0 ? -1 : index;
  for (;;) {
    const next = i + step;
    if (next < 0 || next >= count) return index < 0 ? firstEnabled(list) : index;
    i = next;
    if (!list[i].disabled) return i;
  }
}

/** 打字定位：从 from 后面找以 query 开头的行，转一圈没有就 -1（从 from+1 起 = 原生肌肉记忆）。 */
export function prefixMatch(rows, query, from) {
  const list = rows || [];
  const q = String(query == null ? '' : query).toLowerCase();
  const count = list.length;
  if (!q || !count) return -1;
  const start = Number.isFinite(from) ? from : -1;
  for (let step = 1; step <= count; step += 1) {
    const idx = (((start + step) % count) + count) % count;
    const row = list[idx];
    if (!row || row.disabled) continue;
    if (String(row.label || '').toLowerCase().startsWith(q)) return idx;
  }
  return -1;
}

/** 连打的字符怎么拼成查询词：TYPEAHEAD_RESET 内接着拼，超过就重开一个（重开 = 循环切换的来源）。 */
export function typeaheadQuery(prev, key, now) {
  const text = String(key == null ? '' : key);
  if (!prev || typeof prev.text !== 'string' || !Number.isFinite(prev.at)) return { text, at: now };
  return now - prev.at > TYPEAHEAD_RESET ? { text, at: now } : { text: prev.text + text, at: now };
}

/** 弹层多宽：不窄于触发器，也不窄于 MIN_WIDTH；视口装不下就贴着两边 */
export function popoverWidth(anchorWidth, viewWidth) {
  const vw = Math.max(0, Number(viewWidth) || 0);
  const room = Math.max(0, vw - EDGE * 2);
  const want = Math.max(Number(anchorWidth) || 0, MIN_WIDTH);
  return room > 0 ? Math.min(want, room) : want;
}

/** 弹层摆哪：默认贴触发器下面，装不下翻到上面，两边都装不下贴视口底（宁盖触发器也不出视口）。 */
export function placePopover(anchor, size, view) {
  const box = anchor || {};
  const vw = Math.max(0, Number(view && view.width) || 0);
  const vh = Math.max(0, Number(view && view.height) || 0);
  const width = popoverWidth(box.width, vw);
  const height = Math.max(0, Number(size && size.height) || 0);
  const left = Math.max(EDGE, Math.min(Number(box.left) || 0, Math.max(EDGE, vw - EDGE - width)));
  const below = (Number(box.bottom) || 0) + GAP;
  const above = (Number(box.top) || 0) - GAP - height;
  const useAbove = below + height > vh - EDGE && above >= EDGE;
  const top = Math.max(EDGE, Math.min(useAbove ? above : below, Math.max(EDGE, vh - EDGE - height)));
  return { left, top, width, above: useAbove };
}

// ---- 小工具 ----

function ensurePop() {
  if (pop) return pop;
  pop = h('div', { class: 'menu-pop ctl-select-pop hidden', role: 'listbox' });
  // 点弹层别让焦点跑掉：焦点留在 <select> 上键盘才连得上（行只做高亮，Tab 一下就能走开）
  pop.addEventListener('mousedown', (event) => event.preventDefault());
  pop.addEventListener('click', onPopClick);
  document.body.appendChild(pop);
  return pop;
}

function isAnchorVisible(select) {
  return !!select && select.isConnected && select.getClientRects().length > 0;
}

/** 能不能当「下拉框」用：多选和列表式（size > 1）本来就是展开的，不是下拉 */
function isDropdown(select) {
  return !!select && !select.multiple && !(select.size > 1);
}

/** 事件目标落在哪个 <select> 上（点的是它自己，或它里面的 option） */
function closestSelect(node) {
  if (!node || typeof node.closest !== 'function') return null;
  const select = node.closest('select');
  return isDropdown(select) ? select : null;
}

/**
 * 打上「已接手」标记。只标记不挂监听（监听全在文档级）；调试时一眼看出哪些接上了。
 */
function markEnhanced(select) {
  if (!isDropdown(select) || select.dataset.ctlSelect === 'on') return false;
  select.dataset.ctlSelect = 'on';
  return true;
}

/** 把高亮行滚进可视区；手算 scrollTop —— scrollIntoView 会连外层可滚动祖先一起滚。 */
function revealRow(node) {
  if (!pop || pop.scrollHeight <= pop.clientHeight) return;
  const top = node.offsetTop;
  const bottom = top + node.offsetHeight;
  if (top < pop.scrollTop) pop.scrollTop = Math.max(0, top - 6);
  else if (bottom > pop.scrollTop + pop.clientHeight) pop.scrollTop = bottom - pop.clientHeight + 6;
}

function highlight(next) {
  const list = active ? active.rows : [];
  if (!list.length) return;
  const target = Math.max(0, Math.min(next, list.length - 1));
  if (nodes[index]) nodes[index].classList.remove('is-active');
  index = target;
  const node = nodes[index];
  if (!node) return;
  node.classList.add('is-active');
  revealRow(node);
}

function place() {
  if (!active || !pop) return;
  const rect = active.select.getBoundingClientRect();
  const view = { width: window.innerWidth, height: window.innerHeight };
  // 先定宽再量高：宽度决定换行、换行决定高度；高度由 CSS max-height 封顶。
  pop.style.width = `${popoverWidth(rect.width, view.width)}px`;
  const spot = placePopover(
    { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
    { height: pop.offsetHeight },
    view
  );
  pop.style.left = `${spot.left}px`;
  pop.style.top = `${spot.top}px`;
}

// ---- 开合 ----

function open(select) {
  if (!select || select.disabled || !isDropdown(select)) return;
  if (active && active.select === select) return;
  // 不可见的（藏起来的弹窗 / 折叠分组）不开：没有位置可依，弹出来只会贴左上角。
  if (!isAnchorVisible(select)) return;
  close(false);

  const list = buildRenderList(readGroups(select));
  const rows = renderRows(list);
  if (!rows.length) return;

  const node = ensurePop();
  clear(node);
  nodes = [];
  for (const item of list) {
    if (item.kind === 'group') {
      node.appendChild(h('div', { class: 'ctl-group', text: item.label }));
      continue;
    }
    const at = nodes.length;
    const row = h(
      'button',
      {
        type: 'button',
        class: ['menu-item', 'ctl-opt', item.disabled && 'is-disabled'],
        role: 'option',
        'aria-selected': String(item.value === String(select.value)),
        disabled: item.disabled,
        'data-index': String(at),
        title: item.label
      },
      h('span', { class: 'ctl-opt-text', text: item.label })
    );
    nodes.push(row);
    node.appendChild(row);
  }

  active = { select, rows };
  index = -1;
  typed = null;
  node.classList.remove('hidden');
  node.scrollTop = 0;
  select.classList.add('ctl-open');

  // 顺序要紧：先定宽 + 定位，再算高亮行的滚动 —— 反过来的话 offsetTop 是按上一个宽度算的。
  place();
  // 当前值是禁用项时落到第一个可用项，不能让高亮停在按 Enter 也选不了的行上。
  const current = rows.findIndex((row) => row.value === String(select.value));
  const initial = current >= 0 && !rows[current].disabled ? current : firstEnabled(rows);
  if (initial >= 0) highlight(initial);
}

function close(refocus) {
  if (!active) return;
  const { select } = active;
  if (pop) {
    pop.classList.add('hidden');
    clear(pop);
  }
  select.classList.remove('ctl-open');
  active = null;
  nodes = [];
  index = -1;
  typed = null;
  if (refocus) select.focus({ preventScroll: true });
}

/** 选中 = 改那个原生 <select> 再派发 input + change（顺序同浏览器），现有接线一行都不用改。 */
function commit(value) {
  const select = active ? active.select : null;
  close(false);
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  select.focus({ preventScroll: true });
}

// ---- 文档级监听 ----

function onPopClick(event) {
  const row = event.target && event.target.closest ? event.target.closest('.ctl-opt') : null;
  if (!row || !active) return;
  const item = active.rows[Number(row.dataset.index)];
  if (!item || item.disabled) return;
  commit(item.value);
}

function onDocDown(event) {
  const target = event.target;
  const select = closestSelect(target);
  if (select) markEnhanced(select);

  if (pop && pop.contains(target)) return;

  const onActive = !!select && !!active && select === active.select;
  if (active) {
    // 点别处 → 收起；点在同一个触发器上但它已不可见 → 也收起，否则列表孤零零悬在半空。
    const anchorGone = onActive && !isAnchorVisible(active.select);
    if (!onActive || anchorGone) {
      close(false);
      if (!select) return; // 点的是别处，没别的事要做了
    }
  }

  if (!select || event.button !== 0) return;
  // preventDefault 之后浏览器不弹系统列表、也不给 select 焦点，所以下面自己补一次 focus。
  event.preventDefault();
  select.focus({ preventScroll: true });
  if (select.disabled) return;
  if (onActive) close(false);
  else open(select);
}

/** Space / Enter / Alt+上下 —— 原生 <select> 用来展开的那几个键 */
function isExpandKey(event) {
  return (
    event.key === 'Enter' ||
    event.key === ' ' ||
    (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
  );
}

function onDocKey(event) {
  if (active) {
    const list = active.rows;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        // 捕获阶段拦下：底下设置页 / 编辑器 / 视角弹窗也在听 Esc，不拦会连它们一起关掉。
        event.stopPropagation();
        close(true);
        return;
      case 'Tab':
        close(false); // 交给浏览器，焦点自己走开
        return;
      case 'ArrowDown':
        event.preventDefault();
        highlight(stepIndex(list, index, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        highlight(stepIndex(list, index, -1));
        return;
      case 'Home':
        event.preventDefault();
        highlight(firstEnabled(list));
        return;
      case 'End':
        event.preventDefault();
        highlight(lastEnabled(list));
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        // 和鼠标点击同一条口径：禁用项不能提交
        if (list[index] && !list[index].disabled) commit(list[index].value);
        return;
      default:
        break;
    }
    // 可打印的单字符 = 打字定位（原生下拉也认这个，别丢）
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typed = typeaheadQuery(typed, event.key, Date.now());
      const found = prefixMatch(list, typed.text, index);
      if (found >= 0) {
        event.preventDefault();
        highlight(found);
      }
    }
    return;
  }

  // 没开着时：在 select 上按 Space / Enter / Alt+上下 = 展开；单按上下键不拦
  //（原生会直接换值并派发 change，也会自己重画选中那行）。
  if (!isExpandKey(event)) return;
  const select = closestSelect(event.target);
  if (!select || select.disabled) return;
  markEnhanced(select);
  if (!isAnchorVisible(select)) return;
  event.preventDefault();
  open(select);
}

/** 焦点被别的东西拿走（程序化 focus、切屏）就收起，免得列表孤零零挂在半空 */
function onDocFocusOut(event) {
  if (active && event.target === active.select) close(false);
}

/** 视口一变就重新摆一次位置（滚动、改窗口大小） */
function onViewportChange() {
  if (active) place();
}

/**
 * 文档级监听只装一次：动态建出来的下拉不用逐个挂，漏一个就是「这个还是系统样式」且不报错。
 */
function wireOnce() {
  if (wired) return;
  wired = true;
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onDocKey, true);
  document.addEventListener('focusout', onDocFocusOut, true);
  document.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
}

/** 装文档级监听 + 给现有 <select> 打标记；之后动态建的会在首点时自动接上。返回标记个数。 */
export function initSelects(root = document) {
  wireOnce();
  const scope = root || document;
  const list = scope.querySelectorAll ? scope.querySelectorAll('select') : [];
  let count = 0;
  for (const select of Array.from(list)) if (markEnhanced(select)) count += 1;
  return count;
}
