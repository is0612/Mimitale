'use strict';

// ============================================================================
//  components/input.js —— <m-input> / mInput()
//
//  它= 宿主 + 里面一个原生 <input>。**外观不用在这里写**：里面那个 input 带
//  `type` 属性，正好命中 style.css 里那条全局控件规则
//  （`input[type="text"], input[type="password"], input[type="number"], textarea, select`），
//  所以单行控件的皮肤只有一份，组件只是把它包起来 + 补一层尺寸档。
//
//  ⚠️ 这也意味着：**里层 input 必须带 type 属性**。属性选择器 `input[type="text"]`
//     不匹配"没有 type 属性的 input"，漏了它整个控件就没有皮肤（不报错的那种坏）。
// ============================================================================

import { MiValueControl, applyOptions, reflectProperties } from './base.js';

/** 支持哪些 type。滑块 / 勾选框不是"输入框"，请直接用原生 <input> */
export const INPUT_TYPES = ['text', 'password', 'number', 'search', 'email', 'url', 'tel'];

const CLASS_TABLE = {
  sm: 'mi-input--sm',
  xs: 'mi-input--xs'
};

export class MiInput extends MiValueControl {
  static baseClass = 'mi-input';
  static classTable = CLASS_TABLE;
  static forwardAttrs = [
    'type',
    'placeholder',
    'name',
    'autocomplete',
    'inputmode',
    'readonly',
    'maxlength',
    'min',
    'max',
    'step',
    'spellcheck',
    'aria-label',
    'aria-describedby',
    'title'
  ];

  /** type 的口径：缺省 text；不认识的值**报错并退回 text** */
  inputType() {
    const raw = this.getAttribute('type');
    if (raw == null) return 'text';
    if (!INPUT_TYPES.includes(raw)) {
      console.error(`m-input：不支持 type=${raw}（可用：${INPUT_TYPES.join(' / ')}）；滑块/勾选框请直接用原生 <input>`);
      return 'text';
    }
    return raw;
  }

  forwardValue(name) {
    // type 要兜底成 text（见文件头那条），spellcheck 要兜底成 false
    //（这个项目的口径：中文写作时拼写波浪线只会碍事）
    if (name === 'type') return this.inputType();
    if (name === 'spellcheck') return this.getAttribute('spellcheck') == null ? 'false' : this.getAttribute('spellcheck');
    return super.forwardValue(name);
  }

  createControl() {
    const control = document.createElement('input');
    control.className = 'mi-input__control';
    control.setAttribute('type', this.inputType());
    control.setAttribute('spellcheck', this.forwardValue('spellcheck'));
    return control;
  }
}

/** 工厂形态：`mInput({ placeholder: '角色名', value, onInput })` */
export function mInput(opts = {}) {
  return applyOptions(document.createElement('m-input'), opts);
}

// 原生 input 的专有属性：视图会**直接设 property**（`el.c.attrNew.placeholder = …`、
// `search.type = 'search'`），而 `<m-input>` 不是 HTMLInputElement ——
// 见 base.js 里 reflectProperties 的注释
reflectProperties(MiInput, [
  'type',
  'placeholder',
  'name',
  'maxlength',
  'maxLength',
  'min',
  'max',
  'step',
  'readonly',
  'readOnly',
  'autocomplete',
  'inputmode'
]);
