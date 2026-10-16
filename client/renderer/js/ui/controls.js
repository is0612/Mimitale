'use strict';

// ============================================================================
//  ui/controls.js —— 表单控件的规范件（输入框 / 多行框 / 字段 / 铺选项）
//
//  为什么要有它：控件这块以前是「每处各写一遍」——
//    · `h('input', …)` 13 处、`h('textarea', …)` 4 处，每处都得自己记得
//      `spellcheck="false"`；值要走 property 而不是 attribute（h() 里的 PROPS）
//      ⚙ 2026-10-16：多行框那半已经整批迁到组件库（`mTextarea`），本文件的
//        `textarea()` 帮手随之删掉（没有调用点了，留着就是第二套实现）；
//        `input()` 还剩一个调用点（charAttributes.js 的行内小输入框）。
//    · `.field`（标签 + 控件 + 说明）这套骨架动态建过好几遍，还得记住
//      「标签在第一列、说明在第二列」这条 grid 约定（style.css 的 `.field`）
//    · 「清空 → 逐条 append → 选中值要留着 → 一项都没有就禁用」这套铺选项的
//      流程，在 views/settings.js 和 views/settingsCatalog.js 里各写了一遍
//  收在这里之后，**类名只有这一个地方拼**；样式那半边照旧只有 style.css ——
//  这里不造第二套样式系统，只是把既有类名按语义拼出来。
//
//  和 ui/build.js 的分工：
//    · build.js —— 建 DOM 的**原语**（h / clear / append）+ 列表页骨架
//    · 本文件   —— 表单**控件**：长什么样、有哪些语义参数
//  和 ui/select.js 的分工：那边管「下拉怎么弹 / 键盘怎么走」，这边管
//  「选项怎么铺进去」—— 两边都不碰对方的活。
//
//  两条老规矩照旧：文本一律 textContent（不提供 innerHTML 入口）；
//  值走 property（value / checked），因为 attribute 只算「初始值」。
// ============================================================================

import { h, clear } from './build.js';

/**
 * 单行输入框。type 默认 text、拼写检查默认关（中文写作场景里波浪线只会碍事）。
 * 原生属性照旧透传：`input({ id: 'wb-name', placeholder: '…', onInput: fn })`。
 */
export function input(opts = {}) {
  const { type = 'text', class: className, spellcheck = 'false', ...rest } = opts;
  return h('input', { type, spellcheck, class: className, ...rest });
}

/**
 * 字段：标签 + 控件 + 说明（= style.css 里 `.field` 那套两列 grid）。
 *
 *   field({ label: '书名', control: input({ id: 'wb-name' }) })
 *   field({ label: '开场白', control: textarea({ onInput: fn }), stack: true })
 *
 * `stack: true` = 加上 `.field-stack`：单列、控件撑满 —— 长文本和多行框用它，
 * 两列那套留给「一行一个短值」。
 *
 * ⚠️ 动态建出来的标签要带图标（`icon: 'book'`）时，插进文档之后**还得对那一段
 *    再调一次** ui/icons.js 的 applyFieldIcons()：它只在启动时扫一遍静态 HTML，
 *    动态节点它看不见（main.js 里那条注释说的就是这件事）。
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

/** 造一条 <option>。text 不给就拿 value 当显示文字（十来个调用点都是这样）。 */
function optionEl(item) {
  const value = item.value == null ? '' : String(item.value);
  return h('option', {
    value,
    text: item.text == null ? value : String(item.text),
    disabled: item.disabled
  });
}

/**
 * 铺选项的目标：原生 `<select>`，或者组件 `<m-select>`（认它里面那颗原生 select）。
 *
 * 为什么要认组件：页面迁到组件库之后，调用点写的是 `fillSelect(mSelectEl, items)`，
 * 而**铺选项这件事本身**（clear + append + 定值 + 空了就禁用）只有这一份实现 ——
 * 组件不重复实现一遍，这里也不要求页面知道"组件的值是代理的"。
 *
 * 还没进文档的 `<m-select>` 会先被 ensureRendered()（组件自己的幂等方法）把里层
 * 那颗原生 select 建出来：视图经常先搭一棵游离的树、之后再挂上去，而铺选项往往
 * 发生在挂上去之前（2026-10-16 组件盘就是这么撞出来的）。
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
 * 把一列选项铺进 <select>：先清空，再逐条 append，最后把值定下来。
 *
 * items 每一项：
 *   { value, text, disabled? }                    普通一项
 *   { group: '服务商名', items: [ … ] }            要分组就包一层，铺成 <optgroup>
 * 要排在分组**前面**的散项（比如那个「不在任何服务商列表里」的值）就直接放在
 * items 数组最前面，不要包 group。
 *
 * options.prefer：铺完之后要选中的值。**调用方负责把它作为一项放进来** ——
 *   存过但已经不在列表里的值（服务商那边删过模型）走的就是这条路，
 *   见 views/settings.js 的 fillModelSelect。不在列表里就落到第一项，
 *   那是这些下拉一直以来的口径。
 * options.emptyText：一项都没有时铺这一条并**禁用整个下拉**
 *   （「（先在上面选一个提供商）」那类提示），这一族下拉的兜底形态。
 *
 * 返回真正选中的值 —— 调用方紧接着要按它重铺别的下拉时不用再读一遍。
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
  const values = Array.from(target.options).map((o) => o.value);
  const want = opts.prefer == null ? '' : String(opts.prefer);
  target.value = values.includes(want) ? want : values[0] || '';
  return target.value;
}
