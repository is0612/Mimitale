'use strict';

// preview/preview.js —— 组件盘搭建脚本（开发用，不属于应用界面，也给 tools/shot-components.js 出图）
// ⚠️ 整份文件不写外观样式：用户要的只有挑 variant / size，然后设属性 / 读 .value
// ⚠️ 必须 import ui/select.js 并调 initSelects()：组件里的原生 <select> 靠它接上自研列表

import { h } from '../js/ui/build.js';
import { defineComponents, mButton, mInput, mTextarea, mSelect } from '../js/components/index.js';
import { initSelects } from '../js/ui/select.js';
import { fillSelect } from '../js/ui/controls.js';

defineComponents();
initSelects(); // 让组件里的原生 <select> 也接上自研列表

const root = document.querySelector('.pv-root');
const headHost = document.querySelector('.pv-head');
if (!root || !headHost) throw new Error('组件盘缺少 .pv-root / .pv-head 容器（components.html 结构变了？）');

// --- 页面脚手架（.pv-* 只属于这一页）---

const logLines = [];
const logBox = h('div', { class: 'pv-log' });
const valueBox = h('div', { class: 'pv-values' });
/** 要实时读出 `.value` 的控件：`[标签, 元素]` */
const watched = [];
/** 必须等元素进了文档才能算的东西（比如里层原生控件才存在） */
const afterConnect = [];

function card(title, desc, wide, ...body) {
  return h(
    'section',
    { class: ['pv-card', wide && 'pv-card-wide'] },
    h('h3', { class: 'pv-card-title', text: title }),
    desc ? h('p', { class: 'pv-card-desc', text: desc }) : null,
    ...body
  );
}

function line(label, ...nodes) {
  return h(
    'div',
    { class: 'pv-line' },
    h('span', { class: 'pv-label', text: label }),
    h('div', { class: 'pv-line-body' }, ...nodes)
  );
}

/** 往日志里塞一行 —— 「组件有没有真的派发原生事件」一眼可见 */
function record(kind, text) {
  logLines.unshift(`${kind.padEnd(6)} ${text}`);
  logLines.length = Math.min(logLines.length, 60);
  logBox.textContent = '';
  for (const entry of logLines) logBox.appendChild(h('div', { text: entry }));
  renderValues();
}

function renderValues() {
  valueBox.textContent = '';
  for (const [label, el] of watched) {
    valueBox.appendChild(h('div', { text: `${label.padEnd(24)} = ${JSON.stringify(el.value)}` }));
  }
}

/** 把控件接到日志上：监听**宿主**（里层原生控件的 input/change 会冒泡上来） */
function wire(label, el, kinds = ['input', 'change']) {
  for (const kind of kinds) {
    el.addEventListener(kind, (event) => {
      record(kind, `${label}（target=${event.target.tagName.toLowerCase()}）`);
    });
  }
  watched.push([label, el]);
  return el;
}

// --- 按钮 ---

let clicks = 0;
const counter = mButton({
  variant: 'primary',
  text: '点我 0 次',
  onClick: () => {
    clicks += 1;
    // ⚠️ 改文字走 textContent —— 组件接管了它（原生 setter 会把里层按钮整个删掉）
    counter.textContent = `点我 ${clicks} 次`;
    record('click', 'm-button 被点，文字是用 textContent 改的');
  }
});

const puppet = mButton({
  variant: 'ghost',
  text: '我是被点的那个',
  onClick: () => record('click', '程序化 .click() 转发到了里层原生按钮')
});
const puppeteer = mButton({
  variant: 'base',
  text: '程序化点左边那颗',
  onClick: () => puppet.click()
});

const ariaSample = mInput({ ariaLabel: '角色名', placeholder: '读里层 input 的 aria-label' });
const ariaReadout = h('span', { class: 'pv-card-desc' });
afterConnect.push(() => {
  const inner = ariaSample.querySelector('input');
  ariaReadout.textContent = `里层 input 的 aria-label = ${JSON.stringify(inner && inner.getAttribute('aria-label'))}`;
});

const buttons = card(
  '按钮 m-button',
  '四种外观 × 两档尺寸。这一格一个样式都没写：外观词表在 components/button.js，皮肤在 style.css 的组件段（和老的 .btn 共用同一份声明）。',
  false,
  line(
    'variant',
    mButton({ variant: 'base', text: 'base' }),
    mButton({ variant: 'primary', text: 'primary' }),
    mButton({ variant: 'ghost', text: 'ghost' }),
    mButton({ variant: 'danger', text: 'danger' })
  ),
  line(
    'size=sm',
    mButton({ variant: 'primary', size: 'sm', text: '主按钮 sm' }),
    mButton({ variant: 'ghost', size: 'sm', text: '次按钮 sm' })
  ),
  line(
    '禁用',
    mButton({ text: '禁用（点了没反应）', disabled: true, onClick: () => record('click', '不该出现：禁用的按钮被点到了') })
  ),
  line('改文字', counter),
  line('转发点击', puppeteer, puppet),
  line('block', mButton({ variant: 'primary', block: true, text: 'block 撑满一行' }))
);

// --- 单行输入框 ---

const inputs = card(
  '输入框 m-input',
  '里层是原生 <input>：type / placeholder / maxlength 直接转发，值走 .value，事件从里层冒泡上来。',
  false,
  line('text', wire('m-input[text]', mInput({ placeholder: '例如 小满', value: '小满' }))),
  line('password', wire('m-input[password]', mInput({ type: 'password', value: 'hunter2' }))),
  line('number', wire('m-input[number]', mInput({ type: 'number', min: 1, max: 6, value: 4 }))),
  line('size=sm', wire('m-input[sm]', mInput({ size: 'sm', placeholder: '紧凑档' }))),
  line('size=xs', wire('m-input[xs]', mInput({ size: 'xs', placeholder: '属性行那种最紧凑档' }))),
  line('禁用 / 只读', mInput({ value: '禁用', disabled: true }), mInput({ value: '只读', readonly: true })),
  line('无障碍', ariaSample, ariaReadout)
);

// --- 多行框 ---

const textareas = card(
  '多行框 m-textarea',
  'rows 默认 3（和 ui/controls.js 的 textarea() 同一个口径）；能不能拖拽改变大小由全局 textarea 规则提供。',
  false,
  line('rows=2', wire('m-textarea[2]', mTextarea({ rows: 2, placeholder: '写点什么……' }))),
  line('rows=5', wire('m-textarea[5]', mTextarea({ rows: 5, value: '多行\n文本' }))),
  line('size=sm', wire('m-textarea[sm]', mTextarea({ size: 'sm', rows: 2, placeholder: '紧凑档' }))),
  line('禁用', mTextarea({ rows: 2, value: '禁用', disabled: true }))
);

// --- 下拉框 ---

function selectWithOptions(opts, items) {
  const el = mSelect(opts);
  // ⚠️ 选项挂在宿主上，render 时会搬进里层那颗原生 <select>（= 声明式写法）
  for (const item of items) el.appendChild(h('option', { value: item.value, text: item.text }));
  return el;
}

const declarative = wire('m-select[声明式]', selectWithOptions({ 'aria-label': '声明式选项' }, [
  { value: 'apple', text: '苹果' },
  { value: 'banana', text: '香蕉' },
  { value: 'cherry', text: '樱桃' }
]), ['change']);

const grouped = mSelect({ 'aria-label': '按服务商分组' });
grouped.appendChild(
  h('optgroup', { label: 'DeepSeek' }, [h('option', { value: 'deepseek-chat', text: 'deepseek-chat' })])
);
grouped.appendChild(
  h('optgroup', { label: '通义千问' }, [
    h('option', { value: 'qwen-max', text: 'qwen-max' }),
    h('option', { value: 'qwen-plus', text: 'qwen-plus' })
  ])
);
wire('m-select[分组]', grouped, ['change']);

// ⚠️ 动态铺走 ui/controls.js 的 fillSelect：它认 <m-select>，页面不用管里层那颗 select
const dynamic = wire('m-select[动态]', mSelect({ 'aria-label': '动态铺选项' }), ['change']);
fillSelect(dynamic, [
  { value: 'a', text: '甲（动态铺的）' },
  { value: 'b', text: '乙（动态铺的）' },
  { value: 'c', text: '丙（动态铺的）' }
]);

const selects = card(
  '下拉框 m-select',
  '点开看看：弹的是自研列表（ui/select.js），不是系统那份。选项可以写在标签里，也可以 fillSelect 动态铺。',
  false,
  line('声明式', declarative),
  line('optgroup', grouped),
  line('动态铺', dynamic),
  line('size=sm', wire('m-select[sm]', selectWithOptions({ size: 'sm', 'aria-label': '紧凑档' }, [
    { value: '1', text: '一' },
    { value: '2', text: '二' }
  ]), ['change'])),
  line('size=xs', wire('m-select[xs]', selectWithOptions({ size: 'xs', 'aria-label': '属性行最紧凑档' }, [
    { value: 'text', text: '文本' },
    { value: 'meter', text: '数值' }
  ]), ['change'])),
  line('禁用', selectWithOptions({ disabled: true, 'aria-label': '禁用' }, [{ value: '1', text: '禁用' }]))
);

// --- 事件日志 + 值读出 ---

const inspect = card(
  '事件与值',
  '监听的是**宿主**：里层原生控件的 input / change 冒泡上来，event.target 是里层那个原生控件；.value 是代理到同一个值的。',
  true,
  logBox,
  line('当前值', valueBox)
);

// --- 挂到页面上 ---

const theme = (mode) => document.documentElement.setAttribute('data-theme', mode);

// ⚠️ 页头进 .pv-head（不能进 .pv-root：那是四栏 grid，页头会占掉第一格）
headHost.append(
  h(
    'div',
    {},
    h('h1', { class: 'pv-title', text: '组件盘 · Mimitale 组件库' }),
    h('p', {
      class: 'pv-note',
      text:
        '开发用页面，不属于应用界面。每一格都是组件的真实实例，页面这边一个外观样式都没写 —— '
        + '只有 variant / size 和属性。'
    })
  ),
  h(
    'div',
    { class: 'pv-theme' },
    mButton({ variant: 'ghost', size: 'sm', text: '白天', onClick: () => theme('light') }),
    mButton({ variant: 'ghost', size: 'sm', text: '夜间', onClick: () => theme('dark') })
  )
);

root.appendChild(buttons);
root.appendChild(inputs);
root.appendChild(textareas);
root.appendChild(selects);
root.appendChild(inspect);

// ⚠️ 元素进文档之后才有的东西（里层原生控件是 connectedCallback 里建的）
for (const fn of afterConnect) fn();
renderValues();
record('ready', '组件盘就绪 —— 点了什么、改了什么都会记在这里');
