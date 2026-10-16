'use strict';

// ============================================================================
//  components/button.js —— <m-button> / mButton()
//
//  「长得不像按钮的按钮」（char-card-del / convo-del / sc-close / variant-btn…）
//  不归它管：那些是**图标按钮**，各有各的形态，硬套一个通用按钮只会把内边距和
//  圆角顶掉。通用按钮要的是「一行文字 + variant/size」这件事。
//
//  外观（含 variant / size / disabled 的观感）在 style.css 的 `.mi-btn__control`
//  那几条里 —— 而且和老的 `.btn` **共用同一段声明**（一条规则两个选择器），
//  迁移期两者并存，`.`btn` 退役时把左边那个选择器删掉就行，不会留下两份外观。
// ============================================================================

import { MiControl, applyOptions } from './base.js';

/**
 * 类名字面量表：variant / size / block 都在这儿。
 * ⚠️ 值必须写成字面量 —— 见 base.js 里 componentClass 的注释。
 */
const CLASS_TABLE = {
  primary: 'mi-btn--primary',
  ghost: 'mi-btn--ghost',
  danger: 'mi-btn--danger',
  sm: 'mi-btn--sm',
  block: 'mi-btn--block'
};

export class MiButton extends MiControl {
  static baseClass = 'mi-btn';
  static classTable = CLASS_TABLE;
  static forwardAttrs = ['aria-label', 'aria-describedby', 'title'];

  /**
   * 里层那颗原生 <button>：宿主里原有的**文本**收进 label，其余节点（图标之类）
   * 原样搬进按钮。搬完之后宿主里只剩这颗按钮，不会留下游离的文本节点。
   */
  render() {
    const control = document.createElement('button');
    control.type = 'button'; // 组件做的是「动作按钮」，不是表单提交按钮
    control.className = 'mi-btn__control';

    const text = this._label != null ? String(this._label) : this._takeText();
    for (const child of [...this.childNodes]) {
      if (child.nodeType === 3) this.removeChild(child);
      else control.appendChild(child);
    }

    const label = document.createElement('span');
    label.className = 'mi-btn__label';
    label.textContent = text;
    control.appendChild(label);

    this._control = control;
    this._labelNode = label;
    this.appendChild(control);
  }

  /** 收走宿主自己的文本子节点（`<m-button>保存</m-button>` 里那句「保存」） */
  _takeText() {
    let text = '';
    for (const node of this.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    return text.trim();
  }

  get label() {
    return this._labelNode ? this._labelNode.textContent : this._label == null ? '' : String(this._label);
  }

  set label(value) {
    this.setLabel(value);
  }

  /** 工厂入口用它（applyOptions 认这个方法）；改文字一律走这里 */
  setLabel(value) {
    const text = value == null ? '' : String(value);
    this._label = text;
    if (this._labelNode && this._labelNode.textContent !== text) this._labelNode.textContent = text;
  }

  /**
   * 接管 textContent。
   *
   * 为什么必须接管：渲染层里到处是「按钮建好之后再改字」——
   * `btn.textContent = '换一批中…'`（chatMessages / memoryUi / charExpressions…）。
   * 原生 `textContent` 的 setter 会**删掉所有子节点**，那等于把组件里那颗原生
   * 按钮一起删了：组件当场散架，而且不报错。
   */
  get textContent() {
    return this.label;
  }

  set textContent(value) {
    this.setLabel(value);
  }

  /** 同理：`clear(btn)` 走的是 `innerHTML = ''`，别让它把组件清空 */
  get innerHTML() {
    return this.label;
  }

  set innerHTML(value) {
    const text = value == null ? '' : String(value);
    if (text.includes('<')) console.error('m-button：不支持 innerHTML（文字请用 textContent / label）');
    this.setLabel(text.replace(/<[^>]*>/g, ''));
  }
}

/**
 * 工厂形态：`mButton({ variant: 'primary', size: 'sm', text: '保存', onClick })`
 * 返回的就是 `<m-button>` 元素 —— 和标签形态完全同一个东西。
 */
export function mButton(opts = {}) {
  return applyOptions(document.createElement('m-button'), opts);
}
