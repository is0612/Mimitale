'use strict';

// tools/test-ui-components.js —— 组件库（renderer/js/components/）的纯逻辑；跑法：node --test tools/test-ui-components.js
// 只钉「类名怎么拼 / applyOptions 口径 / 注册表幂等 / 组件元信息」；真 DOM 那一半在 tools/smoke-renderer.js 跑
// ⚠️ 纯 node 下没有 HTMLElement / customElements，先塞壳子；不实例化（super() 会炸），只读静态元信息和纯函数

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 假 HTMLElement / customElements / document：够 import 和纯函数用
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
  },
  // 组件运行时会在 document 上挂一条捕获段监听（label[for] 的焦点转发），纯 node 下记下来即可
  labelClickHandlers: [],
  addEventListener(type, fn, capture) {
    this.labelClickHandlers.push({ type, fn, capture });
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
    dataset: {},
    parentElement: null,
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

test('每个组件的类名表：键必须落在统一词表里（variant / size / block，别自创名字）', () => {
  const allowed = new Set([...M.VARIANTS, ...M.SIZES, 'block']);
  for (const [tag, ctor] of M.COMPONENTS) {
    for (const key of Object.keys(ctor.classTable)) {
      assert.ok(allowed.has(key), `${tag} 的 classTable 里有词表外的键：${key}（可用：${[...allowed].join(' / ')}）`);
    }
  }
  assert.deepEqual(M.VARIANTS, ['base', 'primary', 'ghost', 'danger']);
  assert.deepEqual(M.SIZES, ['md', 'sm', 'xs']);
});

test('size=xs：属性行那种最紧凑档（select / input / textarea 都得有）', () => {
  for (const [tag, ctor] of [
    ['m-select', M.MiSelect],
    ['m-input', M.MiInput],
    ['m-textarea', M.MiTextarea]
  ]) {
    assert.ok(ctor.classTable.xs, `${tag} 没有 xs 档的类名（属性行要用）`);
    assert.equal(M.componentClass(ctor.baseClass, ctor.classTable, { size: 'xs' }), `${ctor.baseClass} ${ctor.classTable.xs}`);
  }
  // 按钮没有 xs：词表里有 ≠ 每个组件都实现了，要的时候会当场报错而不是静默
  assert.equal(M.MiButton.classTable.xs, undefined);
});


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

test('applyOptions：小写与大写的事件键**都收**（视图里各占一半，丢一半就是静默失效）', () => {
  const node = M.applyOptions(fakeNode('m-select'), {
    onchange: () => {},
    oninput: () => {},
    onclick: () => {},
    onkeydown: () => {}
  });
  assert.deepEqual(node.listeners.map((l) => l.type).sort(), ['change', 'click', 'input', 'keydown']);
  // 值不是函数的 on* 键**不能**默默变成一个 onxxx 垃圾属性，要当场报错
  const original = console.error;
  const seen = [];
  console.error = (msg) => seen.push(String(msg));
  try {
    const bad = M.applyOptions(fakeNode('m-button'), { onchange: 'not a function' });
    assert.equal(bad.getAttribute('onchange'), null, 'onchange 不该被写成属性');
    assert.equal(bad.listeners.length, 0);
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('onchange'));
});

test('applyOptions：class 支持数组和空格串，假值不会变成名叫 "false" 的类', () => {
  assert.equal(M.applyOptions(fakeNode('m-button'), { class: ['a', false && 'b', null, 'c'] }).className, 'a c');
  assert.equal(M.applyOptions(fakeNode('m-button'), { class: 'x y' }).className, 'x y');
});

test('applyOptions：dataset 走 dataset，不是 dataset="[object Object]"', () => {
  // dataset 走 setAttribute 会写成真实属性（不报错），但 node.dataset.index 永远 undefined，事件委托静默失效
  const node = M.applyOptions(fakeNode('m-textarea'), { dataset: { index: 3 }, 'aria-label': '第 4 条' });
  assert.deepEqual(node.dataset, { index: 3 });
  assert.equal(node.getAttribute('dataset'), null);
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

test('reflectProperties：直接设 property 也落到 attribute 上（视图里到处这么写）', () => {
  class Base {
    constructor() {
      this.attrs = {};
    }
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    }
    removeAttribute(name) {
      delete this.attrs[name];
    }
  }
  class Fake extends Base {}
  M.reflectProperties(Fake, ['placeholder', 'maxLength']);
  const node = new Fake();

  node.placeholder = '属性名，比如 金币';
  assert.equal(node.attrs.placeholder, '属性名，比如 金币');
  assert.equal(node.placeholder, '属性名，比如 金币', '读回来还是同一个值');

  node.placeholder = null; // null → 删掉属性（和 setAttr 一个口径）
  assert.equal('placeholder' in node.attrs, false);

  node.maxLength = 24; // 驼峰写法：DOM 会把 attribute 名转小写，所以和 maxlength 是同一个
  assert.equal(node.attrs.maxLength, '24');
});

test('reflectProperties：已有的访问器（value / disabled）绝不能被覆盖', () => {
  class Base {
    getAttribute() {
      return null;
    }
    setAttribute() {}
    removeAttribute() {}
  }
  class WithValue extends Base {}
  Object.defineProperty(WithValue.prototype, 'value', {
    configurable: true,
    get() {
      return '自己的';
    },
    set() {}
  });
  M.reflectProperties(WithValue, ['value', 'disabled']);
  assert.equal(new WithValue().value, '自己的');
});


test('hostOf：里层那颗原生控件还原成宿主，别的原样返回', () => {
  // 事件从里层冒上来时 target 是原生控件，而 id / class / dataset 全挂在宿主上
  const control = { tagName: 'TEXTAREA' };
  const host = { tagName: 'M-TEXTAREA', control };
  control.parentElement = host;
  assert.equal(M.hostOf(control), host);
  assert.equal(M.hostOf(host), host, '宿主自己传进来原样返回');

  // 父级只是普通容器（身上没有 control）时不能误判
  const plain = { tagName: 'TEXTAREA', parentElement: { tagName: 'DIV' } };
  assert.equal(M.hostOf(plain), plain);
  assert.equal(M.hostOf(null), null);
});

test('文本方法转发：select / setSelectionRange / setRangeText 落到里层那颗原生控件上', () => {
  // 先挂自己的 `control` 再设原型 —— 反过来的话会被原型上那个同名 getter 挡住
  const calls = [];
  const control = {
    select: () => calls.push(['select']),
    setSelectionRange: (...args) => calls.push(['setSelectionRange', ...args]),
    setRangeText: (...args) => calls.push(['setRangeText', ...args])
  };
  const host = { control, tagName: 'M-TEXTAREA' };
  Object.setPrototypeOf(host, M.MiControl.prototype);
  host.select();
  host.setSelectionRange(3, 3);
  host.setRangeText('雨停了。', 0, 2, 'end');
  assert.deepEqual(calls, [
    ['select'],
    // 第三个参数是原生的可选 direction：不传时照样透传 undefined（原样转发，不替调用方编默认值）
    ['setSelectionRange', 3, 3, undefined],
    ['setRangeText', '雨停了。', 0, 2, 'end']
  ]);
});

test('文本方法转发：里层没有这个方法时**当场报错**，不静默空转', () => {
  const original = console.error;
  const seen = [];
  console.error = (msg) => seen.push(String(msg));
  let out;
  try {
    const host = { control: {}, tagName: 'M-TEXTAREA' };
    Object.setPrototypeOf(host, M.MiControl.prototype);
    out = host.setRangeText('x', 0, 0);
  } finally {
    console.error = original;
  }
  assert.equal(out, undefined);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('setRangeText'), seen[0]);
});


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
