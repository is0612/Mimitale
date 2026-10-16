'use strict';

// ============================================================================
//  components/textarea.js —— <m-textarea> / mTextarea()
//
//  和 m-input 同一套路：宿主 + 里面一个原生 <textarea>，皮肤由 style.css 里
//  那条全局控件规则提供（`textarea` 是元素选择器，不需要 type 属性那类口径）。
//
//  rows 默认 3 —— 和 ui/controls.js 的 textarea() 同一个口径，别在组件里再定一个。
// ============================================================================

import { MiValueControl, applyOptions, reflectProperties } from './base.js';

const CLASS_TABLE = {
  sm: 'mi-textarea--sm',
  xs: 'mi-textarea--xs'
};

/** rows 的默认值（两处口径必须一致：这里和 ui/controls.js 的 textarea()） */
const DEFAULT_ROWS = '3';

export class MiTextarea extends MiValueControl {
  static baseClass = 'mi-textarea';
  static classTable = CLASS_TABLE;
  static forwardAttrs = [
    'rows',
    'wrap',
    'placeholder',
    'name',
    'readonly',
    'maxlength',
    'spellcheck',
    'aria-label',
    'aria-describedby',
    'title'
  ];

  forwardValue(name) {
    if (name === 'rows') return this.getAttribute('rows') == null ? DEFAULT_ROWS : this.getAttribute('rows');
    if (name === 'spellcheck') return this.getAttribute('spellcheck') == null ? 'false' : this.getAttribute('spellcheck');
    return super.forwardValue(name);
  }

  createControl() {
    const control = document.createElement('textarea');
    control.className = 'mi-textarea__control';
    control.setAttribute('rows', this.forwardValue('rows'));
    control.setAttribute('spellcheck', this.forwardValue('spellcheck'));
    return control;
  }
}

/** 工厂形态：`mTextarea({ rows: 6, value, onInput })` */
export function mTextarea(opts = {}) {
  return applyOptions(document.createElement('m-textarea'), opts);
}

// 原生 textarea 的专有属性（property 写法也要能生效，见 base.js 的 reflectProperties）
reflectProperties(MiTextarea, ['placeholder', 'name', 'rows', 'wrap', 'maxlength', 'maxLength', 'readonly', 'readOnly']);
