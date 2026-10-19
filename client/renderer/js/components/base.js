'use strict';

// components/base.js —— 组件库极小运行时：一次定义 = 结构 + 行为 + 样式
// 宿主只管外观类名 / 属性转发 / .value 代理 / focus·click 转发，键盘与表单语义交给里层原生控件。
// ⚠️ 用 light DOM 是为了让 style.css 的全局主题生效；组件类名一律 mi- 前缀，别和页面类名混。

/** 外观变体词表 —— 和 ui/build.js 的 button() 是**同一套名字**，别再造第二套 */
export const VARIANTS = ['base', 'primary', 'ghost', 'danger'];
/**
 * 尺寸词表：md = 默认（不写），sm = 紧凑，xs = 最紧凑。
 * ⚠️ 词表里有**不等于**每个组件都实现了：没实现时 componentClass 当场报错（故意的）。 */
export const SIZES = ['md', 'sm', 'xs'];

/**
 * 拼组件类名；`table` 必须是字面量映射（拼出来的字符串源码里 grep 不到，会被 audit-css-dead 当死规则）。
 * ⚠️ 认不出来的 variant/size 当场报错，不静默丢 —— 静默的代价是「这个按钮怎么没样式」。 */
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

/**
 * 给组件补上原生控件专有属性的访问器：`host.placeholder = 'x'` → attribute → 里层控件。
 * ⚠️ `<m-input>` 不是 HTMLInputElement；不接管的话直接设 property 只挂到宿主上，里层永远收不到。 */
export function reflectProperties(ctor, names) {
  for (const name of names) {
    if (Object.getOwnPropertyDescriptor(ctor.prototype, name)) continue; // 已经有的（value / disabled…）不动
    Object.defineProperty(ctor.prototype, name, {
      configurable: true,
      get() {
        return this.getAttribute(name);
      },
      set(value) {
        setAttr(this, name, value);
      }
    });
  }
}

export function toggleAttr(node, name, on) {
  if (on) node.setAttribute(name, '');
  else node.removeAttribute(name);
}

/**
 * 工厂形态共用：把 { variant, size, block, disabled, text, class, ariaLabel, onClick, ...rest } 落到元素上。
 * rest 口径：onXxx → addEventListener；value / checked → property；dataset → el.dataset；其余 → setAttribute。 */
export function applyOptions(el, opts = {}) {
  const { variant, size, block, disabled, text, class: className, ariaLabel, onClick, ...rest } = opts;

  if (variant != null) setAttr(el, 'variant', variant);
  if (size != null) setAttr(el, 'size', size);
  // 用 != null 而不是真值判断：false 表示「明确关掉」，要能把旧属性删掉
  if (block != null) setAttr(el, 'block', block);
  if (disabled != null) setAttr(el, 'disabled', disabled);

  if (className) {
    const names = Array.isArray(className) ? className : String(className).split(/\s+/);
    for (const name of names) if (name) el.classList.add(name);
  }
  // ariaLabel → aria-label：camelCase 会落到无效属性 arialabel 上（a11y 树看不见，且不报错）
  if (ariaLabel != null) setAttr(el, 'aria-label', ariaLabel);
  if (text != null && typeof el.setLabel === 'function') el.setLabel(text);
  if (typeof onClick === 'function') el.addEventListener('click', onClick);

  for (const key of Object.keys(rest)) {
    const value = rest[key];
    if (value == null || value === false) continue;

    // 事件两种写法都收（onchange / onChange）：只认大写那种会静默丢掉 onchange 的事件。
    if (/^on[a-z]/i.test(key)) {
      if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else console.error(`applyOptions：${key} 只接受函数，收到的是 ${typeof value}`);
      continue;
    }
    if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = value;
    // data-* 走 dataset：走 setAttribute 会写成 dataset="[object Object]"，读 node.dataset.index 永远 undefined。
    else if (key === 'dataset' && typeof value === 'object') Object.assign(el.dataset, value);
    else setAttr(el, key, value);
  }
  return el;
}

/**
 * 所有组件的底座：variant / size / block / disabled + 属性转发 + focus/click 转发。
 * 子类定义 static baseClass / classTable / forwardAttrs，并实现 createControl() 或 render()。 */
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
    this._wireFocusBridge();
    this.sync();
  }

  /** focus / blur 不冒泡：不转发到宿主，「失焦才提交」的链路会静默失效；转发出去也不带 bubbles。 */
  _wireFocusBridge() {
    if (this._focusWired) return;
    const control = this.control;
    if (!control || control === this) return;
    this._focusWired = true;
    for (const type of ['focus', 'blur']) {
      control.addEventListener(type, () => {
        this.dispatchEvent(new FocusEvent(type, { bubbles: false }));
      });
    }
  }

  /** 建里层控件 + 初次同步，幂等。可以提前调：视图常先搭游离树再挂载，挂载前就要往里塞选项。 */
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

  /** 幂等：外观、禁用态、转发属性一次全重算（不做增量 diff，少一类状态没跟上）。 */
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

  /** 焦点 / 点击转发给里层；⚠️ click() 尤其重要：程序化 node.click() 在未知元素上没有原生行为。 */
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

  /** 选中文本 / 设光标位置；⚠️ 不转发的话宿主上没有这些方法，el.c.name.select() 直接 TypeError。 */
  select() {
    return this._callControlMethod('select');
  }

  setSelectionRange(start, end, direction) {
    return this._callControlMethod('setSelectionRange', start, end, direction);
  }

  /** setRangeText() 同样转发：它是「选中一段直接改写」的原生写法，且不清撤销栈。 */
  setRangeText(replacement, start, end, mode) {
    return this._callControlMethod('setRangeText', replacement, start, end, mode);
  }

  /** 转发到里层原生控件；没有这个方法就**当场报错**，不做静默空转 */
  _callControlMethod(name, ...args) {
    const control = this.control;
    if (control && control !== this && typeof control[name] === 'function') return control[name](...args);
    console.error(`<${this.tagName.toLowerCase()}> 里层控件没有 ${name}()（它不是文本输入类控件？）`);
    return undefined;
  }
}

/**
 * 把事件委托里的里层原生控件还原成组件宿主。
 * ⚠️ input/change 冒泡时 event.target 是里层控件：id、classList、dataset 都挂在宿主上，不还原会静默失效。 */
export function hostOf(node) {
  const parent = node && node.parentElement;
  return parent && parent.control === node ? parent : node;
}

/**
 * selectionStart / selectionEnd / selectionDirection 也代理到里层：quickPhrases 按光标位置插短语。
 * 口径照原生：文本控件返数字，其它返 null / undefined，不做包装。 */
function mirrorSelectionProperties(ctor) {
  for (const name of ['selectionStart', 'selectionEnd', 'selectionDirection']) {
    if (Object.getOwnPropertyDescriptor(ctor.prototype, name)) continue;
    Object.defineProperty(ctor.prototype, name, {
      configurable: true,
      get() {
        const control = this.control;
        return control && control !== this ? control[name] : null;
      },
      set(value) {
        const control = this.control;
        if (control && control !== this) control[name] = value;
      }
    });
  }
}

mirrorSelectionProperties(MiControl);

/**
 * 带值的控件（m-input / m-textarea / m-select）：.value 代理 + 初始值口径 + dirty 标记。
 * 事件不用重新派发：里层 input/change 会冒泡，再 dispatch 一次监听者会收到两遍。 */
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
