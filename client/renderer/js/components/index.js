'use strict';

// ============================================================================
//  components/index.js —— 组件库入口
//
//  用法（两套入口，同一个东西）：
//    · 标签：`<m-button variant="primary">保存</m-button>`（index.html 里、或
//      innerHTML 里都行 —— 自定义元素是浏览器升级的，不需要我们做启动扫描）
//    · 工厂：`mButton({ variant: 'primary', text: '保存' })`
//
//  `defineComponents()` 在启动时调一次（main.js 的 init 开头）。**必须在第一次
//  渲染之前** —— 组件元素进文档那一刻才 upgrade，晚注册的话先渲染出来的组件
//  会停在"未知元素"状态（可见但没样式、没行为）。
//
//  依赖方向：components/ **不 import 任何其它分区**（core / ui / data / views），
//  所以任何一层都能用它。反过来不行 —— 组件要是 import 了 views，就会绕出环。
//  （和 ui/select.js 的关系是**运行期**的：组件里的原生 <select> 被那层自研列表
//    接上，不是代码依赖。）
// ============================================================================

import { MiControl, MiValueControl, applyOptions, componentClass, setAttr, toggleAttr, reflectProperties, hostOf, VARIANTS, SIZES } from './base.js';
import { MiButton, mButton } from './button.js';
import { MiInput, mInput, INPUT_TYPES } from './input.js';
import { MiTextarea, mTextarea } from './textarea.js';
import { MiSelect, mSelect } from './select.js';

/** 标签名 → 类。加新组件就往这张表里添一行 */
export const COMPONENTS = [
  ['m-button', MiButton],
  ['m-input', MiInput],
  ['m-textarea', MiTextarea],
  ['m-select', MiSelect]
];

/**
 * 注册所有组件。返回这一次真正注册了几个（重复调用是安全的：已注册的跳过）。
 * 重复注册会抛 `NotSupportedError`，所以先 customElements.get 问一句。
 */
export function defineComponents() {
  let count = 0;
  for (const [tag, ctor] of COMPONENTS) {
    if (customElements.get(tag)) continue;
    customElements.define(tag, ctor);
    count += 1;
  }
  wireLabelForwarding();
  return count;
}

/**
 * 让 `label[for="…"]` 也能点出焦点 —— **组件不是可标记元素（labelable）**。
 *
 * `label` 的「点标签 = 聚焦那个控件」只对七个原生可标记元素成立
 * （button / input / meter / output / progress / select / textarea）；
 * 换成 `<m-textarea>` 之后 `label.control` 是 **null**，点标签什么都不会发生
 * （2026-10-16 实测确认；同一个页面上原生 `<textarea>` 那侧照常聚焦）。
 * 而角色编辑器那五栏就是 `label.char-sheet-label[for="c-desc"]` 的写法，
 * HTML 注释里写明「点『角色描述』四个字照样聚焦输入框」是刻意保留的行为 ——
 * 不补这一手就是**静默的功能回退**。
 *
 * 做法：document 上挂**一个**捕获段监听（不为每个组件各挂一个）。
 * 命中 `label[for]` 且那个 for 指向的是本库组件时才手动 `focus()`
 * （组件的 focus() 自己会转发到里层原生控件）；
 * `label.control` 有值（原生控件）的一律跳过 —— 那种浏览器自己会处理，
 * 我们再 focus 一次等于把浏览器的行为盖掉。
 *
 * 包在 `<label>` 里（不带 for）的写法不用管：那种情况下浏览器会转发给
 * **内部第一个可标记的后代** —— 也就是里层那颗原生控件，本来就通。
 */
function wireLabelForwarding() {
  if (wireLabelForwarding.done) return;
  wireLabelForwarding.done = true;
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      const label = target && target.closest ? target.closest('label[for]') : null;
      if (!label || label.control) return;
      const node = document.getElementById(label.getAttribute('for'));
      if (node instanceof MiControl) node.focus();
    },
    true
  );
}

export {
  // 基类：要扩展新组件时用（结构 + 行为 + 外观类名的口径都在这儿）
  MiControl,
  MiValueControl,
  // 单个组件类与工厂
  MiButton,
  mButton,
  MiInput,
  mInput,
  MiTextarea,
  mTextarea,
  MiSelect,
  mSelect,
  // m-input 支持哪些 type（调用方要自己校验时也用它，别各写一份白名单）
  INPUT_TYPES,
  // 事件委托里把里层原生控件还原成宿主（`event.target` 在组件化之后不是宿主）
  hostOf,
  // 外观词表：写新组件时对照它，别自己发明一套 variant 名字
  VARIANTS,
  SIZES,
  // 底座工具（工厂自己要用的那几个，测试也直接用）
  applyOptions,
  componentClass,
  reflectProperties,
  setAttr,
  toggleAttr
};
