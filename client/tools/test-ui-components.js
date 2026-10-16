'use strict';

// ============================================================================
//  tools/test-ui-components.js —— 组件库（renderer/js/components/）的纯逻辑
//
//  跑法： node --test tools/test-ui-components.js
//
//  这一份管的是「不碰真界面也能钉死」的那部分：
//    · 类名怎么拼（variant / size / block / 认不出来的取值要报错而不是静默丢）
//    · applyOptions 的口径（ariaLabel → aria-label、value 走 property、
//      onXxx → 事件、class 数组里的假值不能变成名叫 "false" 的类）
//    · 注册表的幂等（重复 defineComponents 不能抛 NotSupportedError）
//    · 每个组件的元信息（baseClass / 类名表 / 要转发的属性）自洽
//
//  真 DOM 那一半（升级、属性转发、.value 代理、和自研下拉列表的组合）在
//  tools/smoke-renderer.js 的场景里跑 —— 那边才有真实的浏览器。
//
//  ⚠️ components/ 里是 `class X extends HTMLElement`，纯 node 下没有这两个全局，
//     所以先塞壳子。**不实例化**（super() 会炸），只读静态元信息和纯函数。
// ============================================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ---- 假 HTMLElement / customElements / document（够 import 和纯函数用） ----
globalThis.HTMLElement = class {};

const registry = new Map();
globalThis.customElements = {
  define(tag, ctor) {
    if (registry.has(tag)) throw new Error(`Already defined: ${tag}`);
    registry.set(tag, ctor);
  },
  get(tag) {
    return registry.get(tag) || null;
  }
};

globalThis.document = {
  createElement(tag) {
    return fakeNode(tag);
  },
  createTextNode(text) {
    return { nodeType: 3, textContent: String(text) };
  }
};

/** 只够 applyOptions / 工厂用的一小块节点 */
function fakeNode(tag) {
  const classes = [];
  const attrs = {};
  const listeners = [];
  return {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    value: '',
    checked: false,
    listeners,
    get classList() {
      return {
        add: (...names) => {
          for (const name of names) if (name && !classes.includes(name)) classes.push(name);
        },
        contains: (name) => classes.includes(name),
        get length() {
          return classes.length;
        }
      };
    },
    get className() {
      return classes.join(' ');
    },
    set className(value) {
      classes.length = 0;
      for (const name of String(value).split(/\s+/)) if (name) classes.push(name);
    },
    classNames: classes,
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    attributes: attrs,
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    }
  };
}

const COMPONENTS_URL = pathToFileURL(
  path.join(__dirname, '..', 'renderer', 'js', 'components', 'index.js')
).href;

let M;
test.before(async () => {
  M = await import(COMPONENTS_URL);
});

// ---------------------------------------------------------------------------
//  类名怎么拼
// ---------------------------------------------------------------------------

const BTN_LIKE = {
  primary: 'mi-btn--primary',
  ghost: 'mi-btn--ghost',
  sm: 'mi-btn--sm',
  block: 'mi-btn--block'
};

test('componentClass：默认档不写任何修饰类', () => {
  assert.equal(M.componentClass('mi-btn', BTN_LIKE, {}), 'mi-btn');
  assert.equal(M.componentClass('mi-btn', BTN_LIKE, { variant: 'base', size: 'md' }), 'mi-btn');
});

test('componentClass：variant / size / block 各拼一个类', () => {
  assert.equal(M.componentClass('mi-btn', BTN_LIKE, { variant: 'primary' }), 'mi-btn mi-btn--primary');
  assert.equal(M.componentClass('mi-btn', BTN_LIKE, { variant: 'primary', size: 'sm' }), 'mi-btn mi-btn--primary mi-btn--sm');
  assert.equal(M.componentClass('mi-btn', BTN_LIKE, { block: true }), 'mi-btn mi-btn--block');
  assert.equal(
    M.componentClass('mi-btn', BTN_LIKE, { variant: 'ghost', size: 'sm', block: true }),
    'mi-btn mi-btn--ghost mi-btn--sm mi-btn--block'
  );
});

test('componentClass：认不出来的 variant / size 当场报错，也不硬塞一个类', () => {
  const original = console.error;
  const seen = [];
  console.error = (msg) => seen.push(String(msg));
  try {
    assert.equal(M.componentClass('mi-btn', BTN_LIKE, { variant: 'primry' }), 'mi-btn');
    assert.equal(M.componentClass('mi-btn', BTN_LIKE, { size: 'xl' }), 'mi-btn');
    // 词表里有、但这个组件没实现的外观：也要报（不然是「怎么没样式」的静默失效）
    assert.equal(M.componentClass('mi-input', { sm: 'mi-input--sm' }, { variant: 'primary' }), 'mi-input');
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 3);
  assert.ok(seen[0].includes('primry'));
  assert.ok(seen[1].includes('xl'));
  assert.ok(seen[2].includes('primary'));
});

test('componentClass：四个词表的取值都以自己的 baseClass 打头（CSS 里才认得出归属）', () => {
  for (const [tag, ctor] of M.COMPONENTS) {
    const base = ctor.baseClass;
    assert.ok(base && base.startsWith('mi-'), `${tag} 的 baseClass 要以 mi- 打头`);
    for (const [key, value] of Object.entries(ctor.classTable)) {
      assert.ok(
        value.startsWith(`${base}--`),
        `${tag} 的 classTable.${key} = ${value}，应该以 ${base}-- 打头`
      );
    }
  }
});

// ---------------------------------------------------------------------------
//  applyOptions 的口径
// ---------------------------------------------------------------------------

test('applyOptions：ariaLabel 写成 aria-label（不是那个无效的 arialabel）', () => {
  const node = M.applyOptions(fakeNode('m-input'), { ariaLabel: '角色名' });
  assert.equal(node.getAttribute('aria-label'), '角色名');
  assert.equal(node.getAttribute('arialabel'), null);
});

test('applyOptions：value / checked 走 property，剩下的走 attribute', () => {
  const node = M.applyOptions(fakeNode('m-input'), {
    value: '带过来的值',
    checked: true,
    placeholder: '例如 小满',
    maxlength: 24,
    rows: 5
  });
  assert.equal(node.value, '带过来的值');
  assert.equal(node.checked, true);
  assert.equal(node.getAttribute('value'), null);
  assert.equal(node.getAttribute('placeholder'), '例如 小满');
  assert.equal(node.getAttribute('maxlength'), '24');
  assert.equal(node.getAttribute('rows'), '5');
});

test('applyOptions：onXxx 变成事件，别的 on 开头的字符串不当事件', () => {
  const node = M.applyOptions(fakeNode('m-button'), { onInput: () => {}, onclick: 'ignored', onClick: () => {} });
  assert.deepEqual(node.listeners.map((l) => l.type).sort(), ['click', 'input']);
});

test('applyOptions：class 支持数组和空格串，假值不会变成名叫 "false" 的类', () => {
  assert.equal(M.applyOptions(fakeNode('m-button'), { class: ['a', false && 'b', null, 'c'] }).className, 'a c');
  assert.equal(M.applyOptions(fakeNode('m-button'), { class: 'x y' }).className, 'x y');
});

test('applyOptions：disabled / block 是「存在即真」', () => {
  const node = M.applyOptions(fakeNode('m-button'), { disabled: true, block: true });
  assert.ok(node.hasAttribute('disabled'));
  assert.ok(node.hasAttribute('block'));
});

test('applyOptions：text 交给 setLabel（组件支持才给），不支持就忽略', () => {
  const calls = [];
  const withLabel = fakeNode('m-button');
  withLabel.setLabel = (text) => calls.push(text);
  M.applyOptions(withLabel, { text: '保存' });
  assert.deepEqual(calls, ['保存']);
  // 不支持 setLabel 的元素（比如 m-input）不该被塞进一个孤儿文本节点
  const plain = M.applyOptions(fakeNode('m-input'), { text: '不该出现' });
  assert.equal(plain.children.length, 0);
});

test('setAttr / toggleAttr：null、false 删掉，true 是空属性', () => {
  const node = fakeNode('div');
  M.setAttr(node, 'a', 1);
  M.setAttr(node, 'b', true);
  M.setAttr(node, 'c', null);
  M.setAttr(node, 'd', false);
  assert.equal(node.getAttribute('a'), '1');
  assert.equal(node.getAttribute('b'), '');
  assert.equal(node.hasAttribute('c'), false);
  assert.equal(node.hasAttribute('d'), false);
  M.toggleAttr(node, 'a', false);
  assert.equal(node.hasAttribute('a'), false);
  M.toggleAttr(node, 'a', true);
  assert.equal(node.hasAttribute('a'), true);
});

// ---------------------------------------------------------------------------
//  注册表
// ---------------------------------------------------------------------------

test('defineComponents：注册四个基础件，重复调用安全且返回 0', () => {
  assert.equal(M.defineComponents(), 4);
  assert.equal(M.defineComponents(), 0, '第二次调用不该重复注册（那会抛 NotSupportedError）');
  for (const tag of ['m-button', 'm-input', 'm-textarea', 'm-select']) {
    assert.ok(customElements.get(tag), `${tag} 没注册上`);
  }
});

test('COMPONENTS 表：标签名合法（自定义元素必须带连字符）、类名对得上', () => {
  assert.equal(M.COMPONENTS.length, 4);
  for (const [tag, ctor] of M.COMPONENTS) {
    assert.ok(tag.includes('-'), `${tag} 不是合法的自定义元素名（必须有连字符）`);
    assert.equal(typeof ctor, 'function');
    assert.ok(ctor.prototype instanceof Object);
  }
  assert.equal(M.COMPONENTS[0][0], 'm-button');
  assert.equal(M.COMPONENTS[0][1], M.MiButton);
});

test('每个组件：observedAttributes 覆盖外观 + 转发属性，且不重复', () => {
  for (const [tag, ctor] of M.COMPONENTS) {
    const observed = ctor.observedAttributes;
    for (const name of ['variant', 'size', 'block', 'disabled']) {
      assert.ok(observed.includes(name), `${tag} 没观察 ${name}`);
    }
    assert.equal(new Set(observed).size, observed.length, `${tag} 的 observedAttributes 有重复`);
    for (const name of observed) {
      assert.ok(/^[a-z-]+$/.test(name), `${tag} 的观察属性 ${name} 应该是小写 + 连字符（HTML 里就长这样）`);
    }
  }
});

test('值控件：m-input / m-textarea / m-select 都从 MiValueControl 下来（.value 代理在同一处）', () => {
  for (const ctor of [M.MiInput, M.MiTextarea, M.MiSelect]) {
    assert.ok(ctor.prototype instanceof M.MiValueControl, `${ctor.name} 不在 MiValueControl 这一支上`);
  }
  assert.ok(M.MiButton.prototype instanceof M.MiControl);
  assert.ok(!(M.MiButton.prototype instanceof M.MiValueControl), '按钮没有「值」，别放错支');
});

test('两个基类：value 只在值控件上有（不支持的组件别假装支持）', () => {
  assert.equal(typeof Object.getOwnPropertyDescriptor(M.MiValueControl.prototype, 'value').get, 'function');
  assert.equal(Object.getOwnPropertyDescriptor(M.MiControl.prototype, 'value'), undefined);
});

test('工厂：mButton / mInput / mTextarea / mSelect 各建出对应的标签', () => {
  assert.equal(M.mButton({ variant: 'primary', text: '保存' }).tagName, 'M-BUTTON');
  assert.equal(M.mInput({ placeholder: '角色名' }).tagName, 'M-INPUT');
  assert.equal(M.mTextarea({ rows: 6 }).tagName, 'M-TEXTAREA');
  assert.equal(M.mSelect({ 'aria-label': '字体' }).tagName, 'M-SELECT');
});

test('工厂：属性落在该落的地方（组件标签 + attribute）', () => {
  const btn = M.mButton({ variant: 'ghost', size: 'sm', disabled: true, class: 'preset-row-delete', ariaLabel: '删除预设' });
  assert.equal(btn.getAttribute('variant'), 'ghost');
  assert.equal(btn.getAttribute('size'), 'sm');
  assert.ok(btn.hasAttribute('disabled'));
  assert.ok(btn.classList.contains('preset-row-delete'));
  assert.equal(btn.getAttribute('aria-label'), '删除预设');
});

test('m-input：type 的口径是白名单（滑块/勾选框不在里面，别硬塞）', () => {
  assert.deepEqual(M.INPUT_TYPES, ['text', 'password', 'number', 'search', 'email', 'url', 'tel']);
});
