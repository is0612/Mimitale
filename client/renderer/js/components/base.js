'use strict';

// ============================================================================
//  components/base.js —— 组件库的极小运行时
//
//  目标（和 Element Plus 一样的那件事）：**一次定义 = 结构 + 行为 + 样式**，
//  页面只写「用哪个组件 + variant/size」，不写外观样式。
//
//  为什么是「自定义元素 + light DOM」，不是 Shadow DOM：
//    · 这套界面的配色 / 字号 / 圆角全是 style.css 里那 125 个 CSS 变量加两套
//      主题（`data-theme` / `data-accent`）。Shadow DOM 会把全局 CSS 挡在外面，
//      样式得复制进每个影子根一份 —— 那等于每个组件自己养一套主题，正好反着来。
//    · light DOM 下组件外观仍然只有一份（style.css 的 .mi-* 段），代价是没有
//      样式隔离，所以**组件类名一律 mi- 前缀**，别和页面类名混。
//
//  两套入口，**一份实现**（这条是铁律，别让它们各长一套）：
//    · 标签形态：`<m-button variant="primary">保存</m-button>`
//    · 工厂形态：`mButton({ variant: 'primary', text: '保存' })`
//    工厂 = 建元素 + 设属性/属性值，渲染逻辑只有 MiButton/MiInput… 里那一份。
//
//  每个组件都是「宿主 + 里面一个**原生控件**」：
//    m-button → <button> · m-input → <input> · m-textarea → <textarea>
//    · m-select → <select>
//  键盘、禁用态、原生事件、表单语义全由里面那个原生控件提供；宿主负责
//  外观类名、属性转发、`.value` 代理、focus/click 转发。
//
//  ⚠️ 两件在 h() 时代踩过的坑，这里一次修掉：
//    1. `ariaLabel` 这种 camelCase 会落到无效属性 `arialabel` 上（a11y 树看不见，
//       而且不报错）。组件入口统一收 `ariaLabel` 并写成 `aria-label`。
//    2. `value` 的 attribute 和 property 是两件事。口径照原生 `<input>`：
//       attribute 是**初始值**，用户改过之后（dirty）再改 attribute 不再改值。
// ============================================================================

/** 外观变体词表 —— 和 ui/build.js 的 button() 是**同一套名字**，别再造第二套 */
export const VARIANTS = ['base', 'primary', 'ghost', 'danger'];
/** 尺寸词表：md = 不写（默认那档），sm = 紧凑档 */
export const SIZES = ['md', 'sm'];

/**
 * 拼组件类名：`mi-btn mi-btn--primary mi-btn--sm`。
 *
 * `table` 必须是**字面量映射**：
 *   { primary: 'mi-btn--primary', sm: 'mi-btn--sm', block: 'mi-btn--block' }
 * 不用 `mi-btn--${variant}` 拼 —— 拼出来的字符串在源码里 grep 不到，
 * tools/audit-css-dead.js 会把 CSS 里那些类当成死规则（只能往豁免名单里塞）。
 *
 * 认不出来的 variant/size **当场报错**，不静默丢：静默的后果是「这个按钮怎么
 * 没样式」，而样式问题要翻半天（README 里「不会报错，只会静默失效」那一段）。
 */
export function componentClass(base, table, state = {}) {
  const names = [base];
  const variant = state.variant == null ? 'base' : String(state.variant);
  const size = state.size == null ? 'md' : String(state.size);

  if (variant !== 'base') {
    if (!VARIANTS.includes(variant)) console.error(`${base}：不认识的外观 variant=${variant}（可用：${VARIANTS.join(' / ')}）`);
    else if (!table[variant]) console.error(`${base}：还没有 variant=${variant} 的外观`);
    else names.push(table[variant]);
  }
  if (size !== 'md') {
    if (!SIZES.includes(size)) console.error(`${base}：不认识的尺寸 size=${size}（可用：${SIZES.join(' / ')}）`);
    else if (!table[size]) console.error(`${base}：还没有 size=${size} 的尺寸`);
    else names.push(table[size]);
  }
  if (state.block) {
    if (!table.block) console.error(`${base}：还没有 block 的外观`);
    else names.push(table.block);
  }
  return names.join(' ');
}

/** 设属性：null / false 表示「删掉」，true 表示「存在即真」 */
export function setAttr(node, name, value) {
  if (value == null || value === false) node.removeAttribute(name);
  else if (value === true) node.setAttribute(name, '');
  else node.setAttribute(name, String(value));
}

export function toggleAttr(node, name, on) {
  if (on) node.setAttribute(name, '');
  else node.removeAttribute(name);
}

/**
 * 工厂形态共用的一段：把
 *   { variant, size, block, disabled, text, class, ariaLabel, onClick, ...rest }
 * 落到元素上。**只有这一份** —— 标签形态（HTML 属性）和工厂形态最后都落在同一批
 * 属性/属性值上，不存在第二套渲染逻辑。
 *
 * rest 的口径：
 *   · `onXxx` → addEventListener('xxx')
 *   · `value` / `checked` → **property**（attribute 只算初始值）
 *   · 其余 → setAttribute（`maxlength`、`rows`、`placeholder`、`aria-label`…）
 */
export function applyOptions(el, opts = {}) {
  const { variant, size, block, disabled, text, class: className, ariaLabel, onClick, ...rest } = opts;

  if (variant != null) setAttr(el, 'variant', variant);
  if (size != null) setAttr(el, 'size', size);
  if (block) setAttr(el, 'block', true);
  if (disabled) setAttr(el, 'disabled', true);

  if (className) {
    const names = Array.isArray(className) ? className : String(className).split(/\s+/);
    for (const name of names) if (name) el.classList.add(name);
  }
  // ariaLabel → aria-label：见文件头那条坑
  if (ariaLabel != null) setAttr(el, 'aria-label', ariaLabel);
  if (text != null && typeof el.setLabel === 'function') el.setLabel(text);
  if (typeof onClick === 'function') el.addEventListener('click', onClick);

  for (const key of Object.keys(rest)) {
    const value = rest[key];
    if (value == null || value === false) continue;
    if (/^on[A-Z]/.test(key) && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = value;
    else setAttr(el, key, value);
  }
  return el;
}

/**
 * 所有组件的底座：variant / size / block / disabled + 属性转发 + focus/click 转发。
 *
 * 子类要做三件事：
 *   · `static baseClass`  组件基础类名（mi-btn …）
 *   · `static classTable` 类名字面量表（variant / size / block）
 *   · `static forwardAttrs` 要原样转发给里面那个原生控件的属性
 *   以及实现 `createControl()`（值控件）或 `render()`（自定稿的组件）。
 */
export class MiControl extends HTMLElement {
  static baseClass = 'mi';
  static classTable = {};
  static forwardAttrs = [];

  static get observedAttributes() {
    return ['variant', 'size', 'block', 'disabled', ...this.forwardAttrs];
  }

  /** 里面那个原生控件（button / input / textarea / select）；render 之前是 null */
  get control() {
    return this._control || null;
  }

  get variant() {
    return this.getAttribute('variant') || 'base';
  }
  set variant(value) {
    setAttr(this, 'variant', value);
  }

  get size() {
    return this.getAttribute('size') || 'md';
  }
  set size(value) {
    setAttr(this, 'size', value);
  }

  get block() {
    return this.hasAttribute('block');
  }
  set block(value) {
    toggleAttr(this, 'block', value);
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }
  set disabled(value) {
    toggleAttr(this, 'disabled', value);
  }

  connectedCallback() {
    this.ensureRendered();
    this.sync();
  }

  /**
   * 建里层控件 + 初次同步，**幂等**。
   *
   * 单独抽出来是因为它必须能在**还没进文档**时提前调：视图常常先搭好一棵游离的
   * 树再挂上去，而 `fillSelect(mSelect, items)` 这类操作在挂上去之前就要往里塞
   * 选项 —— 那时候里层那颗原生控件还不存在，只能提前把它建出来。
   */
  ensureRendered() {
    if (this._rendered) return;
    this._rendered = true;
    this.render();
  }

  attributeChangedCallback() {
    // 还没 render（元素还没进文档）就不用管：render 时会把属性读一遍
    if (!this._rendered) return;
    this.sync();
  }

  /** 子类覆盖：把里面那个原生控件建出来。默认什么也不做 */
  render() {}

  /**
   * 幂等：外观、禁用态、转发属性一次全重算。
   * 组件很小，不做增量 diff —— 少一个分支就少一类「切了 variant 但某个状态没跟上」。
   */
  sync() {
    this.syncClass();
    this.syncDisabled();
    this.syncForward();
  }

  /** 重排外观类名：**只动本组件管的那些**，页面自己加的类（如 hidden）留着 */
  syncClass() {
    const base = this.constructor.baseClass;
    const owned = (name) => name === base || name.startsWith(`${base}--`);
    const keep = [...this.classList].filter((name) => !owned(name));
    const built = componentClass(base, this.constructor.classTable, {
      variant: this.variant,
      size: this.size,
      block: this.block
    });
    this.className = [...keep, ...built.split(' ')].join(' ');
  }

  syncDisabled() {
    const control = this.control;
    if (!control || control === this) return;
    toggleAttr(control, 'disabled', this.disabled);
  }

  /** 转发某个属性时取值。子类可以改口径（m-input 的 type 要兜底成 text 等） */
  forwardValue(name) {
    return this.getAttribute(name);
  }

  syncForward() {
    const control = this.control;
    if (!control || control === this) return;
    for (const name of this.constructor.forwardAttrs) {
      const value = this.forwardValue(name);
      if (value == null) control.removeAttribute(name);
      else control.setAttribute(name, value);
    }
  }

  /**
   * 焦点 / 点击都转发给里面那个原生控件。
   * `click()` 尤其重要：程序化 `node.click()` 在未知元素上是**没有原生行为**的，
   * 不转发的话「点一下按钮」的自动测试会静默地点了个寂寞（tools/smoke-renderer.js
   * 大量用 node.click()）。
   */
  focus(options) {
    const control = this.control;
    if (control && control !== this) control.focus(options);
    else super.focus(options);
  }

  blur() {
    const control = this.control;
    if (control && control !== this) control.blur();
    else super.blur();
  }

  click() {
    const control = this.control;
    if (control && control !== this && typeof control.click === 'function') control.click();
    else super.click();
  }
}

/**
 * 带「值」的控件（m-input / m-textarea / m-select）：`.value` 代理 + 初始值口径 + dirty 标记。
 *
 * 事件不用重新派发：里面那个原生控件的 input/change **会冒泡**到宿主上，
 * 监听宿主就够了（`event.target` 是里面那个原生控件，读 `.value` 照样对）。
 * 自己再 dispatch 一遍只会让监听者收到两次。
 */
export class MiValueControl extends MiControl {
  static forwardAttrs = ['aria-label', 'aria-describedby', 'title'];

  /** 子类实现：建里面那个原生控件 */
  createControl() {
    return null;
  }

  get value() {
    const control = this.control;
    if (control) return String(control.value == null ? '' : control.value);
    return this._pendingValue == null ? '' : this._pendingValue;
  }

  set value(next) {
    const value = next == null ? '' : String(next);
    this._pendingValue = value;
    const control = this.control;
    if (control) control.value = value;
  }

  render() {
    const control = this.createControl();
    if (!control) return;
    this._control = control;

    // 初始值：工厂给的 .value 优先，其次 value 属性（和原生 <input> 的 value 属性同义）
    const initial = this._pendingValue != null ? this._pendingValue : this.getAttribute('value');
    if (initial != null) control.value = String(initial);

    // 用户动过之后，再改 value 属性就不改值了 —— 和原生 <input> 的 dirty 口径一致
    this.addEventListener('input', () => {
      this._dirty = true;
    });
    this.addEventListener('change', () => {
      this._dirty = true;
    });

    this.appendChild(control);
  }

  attributeChangedCallback(name) {
    super.attributeChangedCallback(name);
    if (name !== 'value' || this._dirty) return;
    const control = this.control;
    if (control) control.value = this.getAttribute('value') == null ? '' : this.getAttribute('value');
  }
}
