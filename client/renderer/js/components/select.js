'use strict';

// ============================================================================
//  components/select.js —— <m-select> / mSelect()
//
//  宿主 + 里面一个原生 <select>。两件现成的东西因此**直接复用到**：
//    · 皮肤：全局 `select` 那条规则（去掉系统箭头、换成 --select-arrow）
//    · 下拉列表：ui/select.js 那层自研列表 —— 它接的是文档里任意原生 <select>，
//      而组件里面正好就是一个原生 <select>，所以**不用为组件再写一遍弹层**。
//
//  标签形态就是把原生写法包一层：
//    <m-select aria-label="界面字体">
//      <option value="default">系统默认</option>
//      <option value="noto">思源黑体</option>
//    </m-select>
//  里面的 <option> / <optgroup> 会被搬进那颗原生 <select>；之后再用
//  appendChild / innerHTML 加选项，也会转发进去（= 原生 select 的行为）。
// ============================================================================

import { MiValueControl, applyOptions } from './base.js';

const CLASS_TABLE = {
  sm: 'mi-select--sm'
};

function isOptionLike(node) {
  return !!node && (node.tagName === 'OPTION' || node.tagName === 'OPTGROUP');
}

export class MiSelect extends MiValueControl {
  static baseClass = 'mi-select';
  static classTable = CLASS_TABLE;
  static forwardAttrs = ['name', 'autocomplete', 'aria-label', 'aria-describedby', 'title'];

  createControl() {
    const control = document.createElement('select');
    control.className = 'mi-select__control';
    // 宿主里原来那些 <option> / <optgroup> 搬进里面那颗原生 select
    for (const child of [...this.children]) {
      if (isOptionLike(child)) control.appendChild(child);
    }
    return control;
  }

  /**
   * 动态加选项转发给里面那颗原生 select。
   * 不转发的话 `mSelect.appendChild(h('option', …))` 会把选项挂到宿主上 ——
   * 界面上什么都不显示，原生 select 里也什么都没有（静默失效）。
   */
  appendChild(node) {
    if (this._control && isOptionLike(node)) return this._control.appendChild(node);
    return super.appendChild(node);
  }

  insertBefore(node, reference) {
    if (this._control && isOptionLike(node)) return this._control.insertBefore(node, reference);
    return super.insertBefore(node, reference);
  }

  /**
   * `clear(select)` / `select.innerHTML = ''` 必须落到里面那颗 select 上。
   * 落到宿主上会把组件自己（那颗 select）一起清掉，之后这个下拉就是个空壳。
   */
  get innerHTML() {
    return this.control ? this.control.innerHTML : super.innerHTML;
  }

  set innerHTML(value) {
    if (this.control) this.control.innerHTML = String(value == null ? '' : value);
    else super.innerHTML = String(value == null ? '' : value);
  }

  // 代理原生的这几样：外面按原生 select 写的代码（读 options / selectedOptions）照旧能跑
  get options() {
    return this.control ? this.control.options : [];
  }

  get selectedOptions() {
    return this.control ? this.control.selectedOptions : [];
  }

  get selectedIndex() {
    return this.control ? this.control.selectedIndex : -1;
  }

  set selectedIndex(value) {
    if (this.control) this.control.selectedIndex = value;
  }
}

/** 工厂形态：`mSelect({ 'aria-label': '界面字体', items: [...] })` —— items 见 ui/controls.js 的 fillSelect */
export function mSelect(opts = {}) {
  return applyOptions(document.createElement('m-select'), opts);
}
