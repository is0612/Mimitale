'use strict';

// ============================================================================
//  ui/select.js —— 自研下拉：把「系统画的那份列表」换成自己的那份
//
//  为什么要有这个文件：渲染层里还有一批原生 <select>（静态 13 个 + 动态 4 个）。
//  原生下拉的**列表**是系统画的（直角、系统蓝高亮、系统字体），CSS 完全碰不到 ——
//  顶栏「切换模型」当初就是为这个才手写成 .menu-pop 的（见 ui/modelMenu.js）。
//  这里把那套做法变成**贴在任意 <select> 上的一层皮肤**，一次解决全部。
//
//  做法（关键，别改成「另建一个 DOM 控件来替代 select」）：
//    · 原生 <select> **原地不动、照样可见**：它就是那颗"关着的"下拉框。
//      宽度、内边距、选中那行文字、禁用态、focus 环，全交给它现有那套 CSS。
//    · 只在 mousedown 上 preventDefault()，把系统那份列表按住不让它弹出来，
//      再自己补一次 focus()（preventDefault 之后浏览器不再给它焦点）。
//      然后弹我们自己的 .menu-pop 列表。
//    · 选中那一下 = 给**那个原生 <select>** 赋值 + 派发冒泡的 input/change。
//      于是现有接线一行都不用改：读 `.value`、`clear()`、`appendChild(h('option'))`、
//      监听 'change' —— 各处下拉全是这么写的（见 views/settings.js 的
//      fillModelSelect 一类）。
//    · 弹层挂在 document.body 上、position: fixed：设置页和几个弹窗内部的
//      滚动容器都有 overflow，挂在原地会被裁掉一半。
//
//  接线方式是**文档级 + 懒标记**，不给每个 select 挂监听：
//    · 13 个静态下拉由 initSelects() 打上标记
//    · 动态建出来的那 4 个（属性类型 / 更新频率 / 分组 / 世界书状态）由文档级
//      mousedown 第一次点到时接上 —— 不用 MutationObserver 盯着整棵树
//      （流式渲染时每个 chunk 都会产生 DOM 变更，盯树的代价不值），也不会
//      出现「新加的下拉忘了接线，于是它一个人还是系统样式」这种漏网。
//
//  ⚠️ 别改成「把 select 藏起来 + 另画一颗触发器」，三条都会炸：
//     ① `.field > select` / `.settings-content > .panel-section .field > select`
//        这类子选择器会成片失配（style.css 里有一整段）；
//     ② 全仓 30 多处 `select.value = x`（设置回填、切提供商重铺模型…）都得再手动
//        同步到那颗假触发器上，漏一处就是「显示的和实际用的不是同一个」；
//     ③ views/perspectiveUi.js 的 setFieldVisible() 走的是 `input.closest('.field')`，
//        藏起来反而要多绕一层。
//
//  纯逻辑（行怎么摊、上下键怎么走、弹层摆哪、连打的字怎么拼词）都抽成下面
//  那几个导出函数，tools/test-ui-controls.js 用 node --test 直接钉住 ——
//  这几件事出错只会表现成「列表位置怪怪的 / 少了一行」，靠肉眼看界面很难复现。
// ============================================================================

import { h, clear } from './build.js';

/** 弹层与触发器 / 视口边缘之间留的空隙 */
const GAP = 6;
const EDGE = 8;
/** 弹层最窄多宽：角色编辑器里那些属性下拉只有 64px，列表跟着那么窄没法读 */
const MIN_WIDTH = 140;
/** 连打同一个键，多久之内算「还在打同一个词」。超过就重开一个词 ——
 *  效果就是原生下拉那个「同一个字母连按 = 在那几行之间循环」。 */
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

// ---------------------------------------------------------------------------
//  纯逻辑
// ---------------------------------------------------------------------------

/** <option> 显示的文字（label 属性优先，和浏览器一致） */
function optionText(opt) {
  const explicit = opt.label;
  if (explicit != null && String(explicit) !== '') return String(explicit);
  return String(opt.textContent == null ? '' : opt.textContent).trim();
}

/**
 * 把 <select> 底下的 option / optgroup 读成「分组 + 行」的纯数据。
 * 没有 optgroup 的下拉就是一组，组名是空字符串（不显示标题）。
 */
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
        // 分组后面再出现的散项要另起一组：否则它们会被并回分组**前面**那组，
        // 显示顺序就和原生 <select> 的 DOM 顺序不一致了。
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

/**
 * 铺进弹层用的「显示清单」：只有**两个以上**分组时才插组标题行 ——
 * 一个分组的下拉再顶一行组名，等于白吃掉一行可见项。
 */
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

/** 显示清单里的「行」（组标题不是行：键盘不落在它上面，和 modelMenu 里
 *  那些占位 div 天然选不中是同一个处理） */
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
 * 上下键：**到头就停住**（绕回另一头容易点错，和 ui/modelMenu.js 一个规矩），
 * 跳过禁用项。index 传 -1（还没有高亮）时落到第一个可用项。
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

/**
 * 打字定位：从 from 后面开始找**以 query 开头**的那一行，转一圈都没有就给 -1。
 * 从 from + 1 开始（而不是 from）是原生下拉的肌肉记忆：连按同一个字母时，
 * 光标在几行之间循环，而不是死在第 1 个匹配上。
 */
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

/**
 * 连打的字符怎么拼成一个查询词：TYPEAHEAD_RESET 之内接着拼，超过就重开一个词。
 * 「重开」正是循环切换的来源 —— 连按两下 s 且间隔够久 = 去找下一个 s 开头的那行。
 */
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

/**
 * 弹层摆哪：默认贴在触发器下面；下面装不下就翻到上面；两边都装不下就贴着视口底
 * （宁愿盖住触发器，也不要超出视口看不见）。
 * anchor / size / view 都是纯数据（getBoundingClientRect 那一套），所以能直接测。
 */
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

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

function ensurePop() {
  if (pop) return pop;
  pop = h('div', { class: 'menu-pop ctl-select-pop hidden', role: 'listbox' });
  // 点在弹层上别让焦点跑掉：焦点始终留在 <select> 上，键盘那一套才连得上
  // （弹层自己不是焦点容器，行只做高亮 —— 这样 Tab 一下就能走开）
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
 * 打上「已接手」的标记。**只标记、不挂监听** —— 监听全在文档级（见 wireOnce）。
 * 标记的用处有两个：调试时一眼看出哪些下拉接上了；以及将来要按它写 CSS 钩子。
 */
function markEnhanced(select) {
  if (!isDropdown(select) || select.dataset.ctlSelect === 'on') return false;
  select.dataset.ctlSelect = 'on';
  return true;
}

/** 把高亮那行滚进可视区。手算 scrollTop：scrollIntoView 会把外层可滚动祖先
 *  一起滚（modelMenu.js 里同一条理由）。 */
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
  // 先定宽再量高：宽度决定换行，换行决定高度。高度由 CSS 的 max-height 封顶，
  // 所以这里量到的就是最终高度。
  pop.style.width = `${popoverWidth(rect.width, view.width)}px`;
  const spot = placePopover(
    { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
    { height: pop.offsetHeight },
    view
  );
  pop.style.left = `${spot.left}px`;
  pop.style.top = `${spot.top}px`;
}

// ---------------------------------------------------------------------------
//  开合
// ---------------------------------------------------------------------------

function open(select) {
  if (!select || select.disabled || !isDropdown(select)) return;
  if (active && active.select === select) return;
  // 不可见的（藏在收起来的弹窗 / 折叠分组里）不开：没有位置可依，
  // 弹出来只会贴在左上角。真人点不到它，但程序化的 click/mousedown 能。
  if (!isAnchorVisible(select)) return;
  close(false);

  const list = buildRenderList(readGroups(select));
  const rows = renderRows(list);
  // 一个可选项都没有：原生下拉也是空的，不弹一个空壳
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

  // 顺序要紧：**先定宽 + 定位，再算高亮那行的滚动**。
  // 反过来的话，第一行的 offsetTop 是按上一个宽度算的（宽度决定换行 → 决定行高），
  // 「一打开就滚到当前项」偶尔会差一两行。
  place();
  // 一打开就先落在「我现在选的是哪个」上，不用自己在十几行里找。
  // 当前值如果是禁用项（原生 select 允许“选中但禁用”），就落到第一个可用项，
  // 不能让键盘高亮停在一个按 Enter 也选不了的行上。
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

/**
 * 选中：改的是**那个原生 <select>**，再派发 input + change（顺序和浏览器一致），
 * 于是现有接线一行都不用改。重选同一个值也照发 —— 用户点了就该生效，
 * 而现有那几个处理函数都是幂等的（回填 / 落盘）。
 */
function commit(value) {
  const select = active ? active.select : null;
  close(false);
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  select.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
//  文档级监听
// ---------------------------------------------------------------------------

function onPopClick(event) {
  const row = event.target && event.target.closest ? event.target.closest('.ctl-opt') : null;
  if (!row || !active) return;
  const item = active.rows[Number(row.dataset.index)];
  if (!item || item.disabled) return;
  commit(item.value);
}

function onDocDown(event) {
  const target = event.target;
  // 动态建出来的下拉：第一次被点到就地打标记（静态那批在 initSelects 里标好了）
  const select = closestSelect(target);
  if (select) markEnhanced(select);

  // 点在弹层自己身上：什么都不做（选哪一行由 onPopClick 负责）
  if (pop && pop.contains(target)) return;

  const onActive = !!select && !!active && select === active.select;
  if (active) {
    // 点别处 → 收起；点在**同一个**触发器上但触发器已经不可见（底下那屏被关了）
    // → 也收起，否则列表会孤零零悬在半空
    const anchorGone = onActive && !isAnchorVisible(active.select);
    if (!onActive || anchorGone) {
      close(false);
      if (!select) return; // 点的是别处，没别的事要做了
    }
  }

  if (!select || event.button !== 0) return;
  // 按住系统那份列表：preventDefault 之后浏览器不会弹它，也不会给 select 焦点，
  // 所以下面自己补一次 focus。
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
        // 捕获阶段拦下：底下（设置页 / 角色编辑器 / 视角弹窗）也在听 Esc，
        // 不拦会连它们一起关掉 —— 和 ui/pickList.js 同一个处理
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

  // 没开着的时候：在 select 上按 Space / Enter / Alt+上下 = 展开。
  // 单按上下键**不拦** —— 原生会直接换值并派发 change，那正是我们要的
  //（原生 <select> 自己会重画选中那行字，不用我们同步）。
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
 * 文档级监听只装一次。
 * 为什么不是「每个 select 各挂一套」：动态建出来的下拉（属性类型 / 更新频率 /
 * 分组 / 世界书状态）也要一样能用，一个个挂就得记住在每个创建点补一行 ——
 * 漏一个就是「这一个下拉还是系统样式」，而且不报错。
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

/**
 * 接上自研下拉：装文档级监听 + 给页面上现有的 <select> 打标记。
 * 之后**动态建出来的也不用管** —— 点它那一下会自动接上（见 wireOnce 的注释）。
 * 返回打上标记的个数，给启动日志和 tools 用。
 */
export function initSelects(root = document) {
  wireOnce();
  const scope = root || document;
  const list = scope.querySelectorAll ? scope.querySelectorAll('select') : [];
  let count = 0;
  for (const select of Array.from(list)) if (markEnhanced(select)) count += 1;
  return count;
}
