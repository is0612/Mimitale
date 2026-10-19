'use strict';

// ui/auto-grow.js —— 文本框自动长高 + 拖拽高度记忆
// ⚠️ 组件化后「量」和「写」都必须过 controlOf()：宿主只占位，描边 / 内边距 / 高度都在里层原生框上。
// 长高上限 GROW_MAX，塞不下的交给框内滚动（表单总长恒定）；拖过之后锁定，不再自动长高。

// 自动长高上限（px）：刻意压低，表单总长恒定，塞不下的交给框内滚动。
const GROW_MAX = 160;
// 每次重算的最小高度（px）：太矮的话一行都没有，看着像坏了。
const GROW_MIN = 84;

/**
 * 「该量、该写高度的那颗元素」—— 组件化后不是传进来的那个：宿主只占位，高度全在里层原生框上。
 * ⚠️ 拿宿主量 scrollHeight 拿到的是渲染高度，写 style.height 也压不到里层 —— 不报错，框就是不长高。 */
export function controlOf(node) {
  return node && node.control ? node.control : node;
}

/**
 * 量一次内容需要多高：height 先设 auto 再读 scrollHeight（直接读拿到的是当前高度下的滚动高度）。
 * ⚠️ 还要先摘掉 rows：height:auto 会退回 rows 撑出的行数；border-box 下要补上下边框。 */
function measureHeight(el) {
  const box = controlOf(el);
  const prevH = box.style.height;
  const rows = box.getAttribute('rows');

  box.style.height = 'auto';
  if (rows !== null) box.removeAttribute('rows');
  const scroll = box.scrollHeight;
  if (rows !== null) box.setAttribute('rows', rows);
  box.style.height = prevH;

  const cs = window.getComputedStyle(box);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  return scroll + border;
}

/** 按内容应有多高：量内容后夹进 [max(GROW_MIN, CSS min-height), max(下限, min(GROW_MAX, CSS max-height))]。 */
function naturalHeight(el) {
  const style = window.getComputedStyle(controlOf(el));
  const minimum = Math.max(GROW_MIN, parseFloat(style.minHeight) || 0);
  const maximum = Math.max(minimum, Math.min(GROW_MAX, parseFloat(style.maxHeight) || Infinity));
  return Math.min(maximum, Math.max(minimum, measureHeight(el)));
}

/** 按内容调整高度；已锁定（手动拖过）的框直接跳过。内部用，外面用 attachAutoGrow。 */
function autoGrow(el) {
  const box = controlOf(el);
  if (!el || el.dataset.growLocked === '1' || !box.getClientRects().length) return;

  const next = naturalHeight(el);

  // 只在真的变了才写 —— 否则每次输入都触发一次样式重算
  if (box.style.height !== `${next}px`) box.style.height = `${next}px`;
}

/**
 * 给文本框接上自动增高。opts.key = 高度记忆的键（建议用字段名，不传就不记忆）。
 */
export function attachAutoGrow(el, opts) {
  if (!el || el.dataset.autoGrow === '1') return;
  el.dataset.autoGrow = '1';

  const key = opts && opts.key ? String(opts.key) : '';

  // 先按上次拖过的位置恢复，没有就走内容自适应
  const saved = heightOf(key);
  if (saved) {
    controlOf(el).style.height = `${saved}px`;
    el.dataset.growLocked = '1';
  }

  el.addEventListener('input', () => {
    // 用户开始打字 = 从这一刻起由内容说了算（手动拖过的框除外）
    autoGrow(el);
  });

  // 拖拽结束用 mouseup 而不是 resize：没有 resize 事件可用，能观察到的信号就是鼠标松开。
  el.addEventListener('mouseup', () => {
    const box = controlOf(el);
    const h = Math.round(box.getBoundingClientRect().height);
    if (h <= 0) return;
    // 和「内容自适应应该得到的高度」不一样 → 说明用户手动调过
    const natural = naturalHeight(el);
    if (Math.abs(h - natural) > 4) {
      el.dataset.growLocked = '1';
      box.style.height = `${h}px`;
      rememberHeight(key, h);
    }
  });

  autoGrow(el);
}

/**
 * 重算一批文本框的高度（忽略锁定）。程序回填不走 input，所以打开编辑器后要显式来一次。
 * ⚠️ 必须在元素可见之后调：display:none 的 scrollHeight 是 0，量出来永远是下限 84px。 */
export function syncAutoGrowAll(list) {
  for (const el of list || []) {
    if (!el) continue;
    if (el.dataset.growLocked === '1') continue;
    controlOf(el).style.height = '';
    autoGrow(el);
  }
}

/**
 * 「这个框上次拖到多高」—— 只活在内存里，不落盘（高度不是角色设定，写进卡里会变成垃圾字段）。
 * key 用字段名（charform:desc），记忆属于「习惯」；上限 40 条，超出整体清空（不做 LRU）。 */
const heightStore = new Map();
const HEIGHT_STORE_MAX = 40;

function rememberHeight(key, px) {
  if (!key) return;
  if (heightStore.size >= HEIGHT_STORE_MAX) heightStore.clear();
  heightStore.set(String(key), Math.round(px));
}

function heightOf(key) {
  return key ? heightStore.get(String(key)) || 0 : 0;
}
