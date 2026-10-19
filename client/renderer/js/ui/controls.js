'use strict';

// ui/controls.js —— 表单控件规范件：类名只有这一个地方拼，样式照旧只归 style.css
// ⚠️ 文本一律 textContent（不提供 innerHTML 入口）；值走 property（attribute 只算初始值）

import { h, clear } from './build.js';

/** 单行输入框。type 默认 text、拼写检查默认关（中文写作场景里波浪线只会碍事） */
export function input(opts = {}) {
  const { type = 'text', class: className, spellcheck = 'false', ...rest } = opts;
  return h('input', { type, spellcheck, class: className, ...rest });
}

/**
 * 字段：标签 + 控件 + 说明（`.field` 那套两列 grid）；`stack: true` 转单列撑满。⚠️ 动态建的标签带图标时，插进文档后还得再调一次 applyFieldIcons()。
 */
export function field(opts = {}) {
  const { label, control, hint, stack, icon, class: className, for: htmlFor } = opts;
  return h(
    'label',
    { class: ['field', stack && 'field-stack', className], for: htmlFor },
    h('span', { class: 'field-label', text: label, 'data-icon': icon }),
    control,
    hint ? h('span', { class: 'field-help', text: hint }) : null
  );
}

/** 造一条 <option>；text 不给就拿 value 当显示文字 */
function optionEl(item) {
  const value = item.value == null ? '' : String(item.value);
  return h('option', {
    value,
    text: item.text == null ? value : String(item.text),
    disabled: item.disabled
  });
}

/**
 * 铺选项的目标：原生 `<select>` 或组件 `<m-select>`。⚠️ 还没进文档的 <m-select> 要先 ensureRendered() —— 铺选项常发生在挂上去之前。
 */
export function resolveSelect(node) {
  if (!node) return null;
  if (node.tagName === 'SELECT') return node;
  if (node.tagName !== 'M-SELECT') return null;
  if (!node.control && typeof node.ensureRendered === 'function') node.ensureRendered();
  const inner = node.control;
  return inner && inner.tagName === 'SELECT' ? inner : null;
}

/**
 * 铺选项：先清空、逐条 append、最后定值，返回真正选中的值。⚠️ options.prefer 要由调用方作为一项放进来；不在列表里落第一项。
 */
export function fillSelect(select, items, opts = {}) {
  const target = resolveSelect(select);
  if (!target) {
    if (select) console.error('fillSelect：给的不是 <select> 也不是 <m-select>');
    return '';
  }
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  clear(target);

  if (!list.length) {
    if (opts.emptyText != null) target.appendChild(optionEl({ value: '', text: opts.emptyText }));
    target.disabled = true;
    // ⚠️ <m-select> 的 disabled 是宿主属性；只设里层会把宿主那份留在旧状态
    if (select && select.tagName === 'M-SELECT') select.disabled = true;
    return '';
  }

  for (const item of list) {
    if (item.group != null && Array.isArray(item.items)) {
      const sub = item.items.filter(Boolean).map(optionEl);
      if (sub.length) target.appendChild(h('optgroup', { label: String(item.group) }, sub));
      continue;
    }
    target.appendChild(optionEl(item));
  }

  target.disabled = false;
  if (select && select.tagName === 'M-SELECT') select.disabled = false;
  const values = Array.from(target.options).map((o) => o.value);
  const want = opts.prefer == null ? '' : String(opts.prefer);
  target.value = values.includes(want) ? want : values[0] || '';
  return target.value;
}
