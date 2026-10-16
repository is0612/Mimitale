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
  sm: 'mi-select--sm',
  xs: 'mi-select--xs'
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
    this._moveOptions(control);
    return control;
  }

  /** 把宿主上那些 `<option>` / `<optgroup>` 搬进里层那颗原生 select */
  _moveOptions(control) {
    if (!control) return;
    for (const child of [...this.children]) {
      if (isOptionLike(child)) control.appendChild(child);
    }
  }

  /**
   * 把**落在宿主上**的合成事件转发给里层那颗原生 select。
   *
   * 为什么要这一层：自研下拉列表（ui/select.js）是「按事件目标找 select」的
   * （`event.target.closest('select')`），而工具和测试普遍写
   * `getElementById('xxx').dispatchEvent(...)` —— 按 id 拿到的是**宿主**，
   * 于是就成了一次点了个寂寞（弹层不开、还不报错）。
   * 真人点击时目标本来就是里层那颗 select（它 width:100% 铺满宿主），
   * 这里只是把"合成事件"那条路补齐。
   */
  _wireHostEvents() {
    if (this._hostWired) return;
    this._hostWired = true;

    this.addEventListener('mousedown', (event) => {
      if (event.target !== this || !this.control) return; // 从里层冒泡上来的不再转发（会打转）
      this.control.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY
        })
      );
    });

    this.addEventListener('keydown', (event) => {
      if (event.target !== this || !this.control) return;
      this.control.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: event.key,
          bubbles: true,
          cancelable: true,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey
        })
      );
    });
  }

  connectedCallback() {
    super.connectedCallback();
    this._wireHostEvents();
    this._watchOptions();
  }

  disconnectedCallback() {
    if (this._optionObserver) {
      this._optionObserver.disconnect();
      this._optionObserver = null;
    }
  }

  /**
   * 动态加选项：**同步**转发给里面那颗原生 select。
   *
   * 不转发的话 `mSelect.appendChild(h('option', …))` 会把选项挂在宿主上 ——
   * 界面上什么都不显示、原生 select 里也什么都没有（静默失效）。而且必须**同步**：
   * 调用点紧接着就会设 `.value` / 读 `.options`（player.js 就是「清空 → 逐条 append
   * → `value = ''`」），异步搬过去的话这些操作全作用在一个还没有选项的 select 上。
   *
   * ⚠️ 光覆写 appendChild / insertBefore 接不全：`ParentNode.append()` 走的是内部
   *    pre-insert，压根不经过 appendChild（worldbookLayout.js 铺「条目状态筛选」用的
   *    正是 `filter.append(option)`）。所以这几个入口都要接住；另外再挂一个
   *    MutationObserver 兜底，见 _watchOptions()。
   */
  appendChild(node) {
    if (this._control && isOptionLike(node)) return this._control.appendChild(node);
    return super.appendChild(node);
  }

  insertBefore(node, reference) {
    if (this._control && isOptionLike(node)) return this._control.insertBefore(node, reference);
    return super.insertBefore(node, reference);
  }

  append(...nodes) {
    const options = nodes.filter(isOptionLike);
    const rest = nodes.filter((node) => !isOptionLike(node));
    if (options.length) {
      if (this._control) this._control.append(...options);
      else super.append(...options);
    }
    if (rest.length) super.append(...rest);
  }

  prepend(...nodes) {
    const options = nodes.filter(isOptionLike);
    const rest = nodes.filter((node) => !isOptionLike(node));
    if (options.length) {
      if (this._control) this._control.prepend(...options);
      else super.prepend(...options);
    }
    if (rest.length) super.prepend(...rest);
  }

  /**
   * 兜底：任何**别的**路径往宿主上塞了 option（`replaceChildren` /
   * `insertAdjacentHTML` / 手拼 DOM…）也会被搬进里层那颗 select。
   * 这条是异步的（MutationObserver 在微任务里回调），所以上面那几个同步入口不能省 ——
   * 它们担的是「紧接着就要用」的那一半。
   */
  _watchOptions() {
    if (this._optionObserver) return;
    this._optionObserver = new MutationObserver(() => this._moveOptions(this.control));
    this._optionObserver.observe(this, { childList: true });
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
