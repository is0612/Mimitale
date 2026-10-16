'use strict';

// ============================================================================
//  tools/test-ui-controls.js —— 控件层那几件「眼睛很难看出来」的纯逻辑
//
//  跑法： node --test tools/test-ui-controls.js
//        （或 node tools/test-ui-controls.js）
//
//  为什么单独一份：ui/select.js 里真正容易错的不是 DOM，而是这几件事 ——
//    · 一张卡的下拉是**按服务商分组**的（optgroup），组标题什么时候该露、
//      什么时候该省（只有一个组还顶一行组名 = 白吃掉一行可见项）
//    · 上下键走到头该停住还是绕回去、禁用项要不要跳过
//    · 弹层摆哪：默认贴下面，下面装不下要翻到上面，两边都装不下要夹回视口内
//    · 连着打字定位（原生下拉的肌肉记忆：同一个字母连按 = 在几行之间循环）
//  这些错了只会表现成「列表位置怪怪的 / 少了一行 / 键盘跳过了某项」，
//  盯着界面看很难稳定复现，所以在这里钉死。
//
//  ⚠️ 这里**不碰真界面**：全部是纯数据进、纯数据出。真正的开合/点击那一段
//     由 tools/smoke-renderer.js 在真页面里点（那边才有点得到的 DOM）。
// ============================================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ui/select.js 只 import ui/build.js，而 build.js 里的 document 调用都在函数体里，
// 所以模块本身能在纯 node 下加载 —— 不用像 test-quick-phrases.js 那样塞假 document。
const SELECT_URL = pathToFileURL(
  path.join(__dirname, '..', 'renderer', 'js', 'ui', 'select.js')
).href;

let mod;
test.before(async () => {
  mod = await import(SELECT_URL);
});

// ---- 造假 DOM：readGroups 只认 tagName / children / value / textContent / disabled ----
const opt = (value, text, extra) => ({
  tagName: 'OPTION',
  value,
  textContent: text,
  disabled: false,
  ...extra
});
const grp = (label, children) => ({ tagName: 'OPTGROUP', label, children });

// ---------------------------------------------------------------------------
//  读选项
// ---------------------------------------------------------------------------

test('readGroups：没有 optgroup 的下拉 = 一组，组名空（不显示标题）', () => {
  const groups = mod.readGroups({ children: [opt('a', '甲'), opt('b', '乙')] });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, '');
  assert.deepEqual(groups[0].rows, [
    { value: 'a', label: '甲', disabled: false },
    { value: 'b', label: '乙', disabled: false }
  ]);
});

test('readGroups：optgroup 的 label 带出来，per-option 的 disabled 也带出来', () => {
  const groups = mod.readGroups({
    children: [
      grp('DeepSeek', [opt('deepseek-chat', 'deepseek-chat')]),
      grp('通义千问', [opt('qwen-max', 'qwen-max', { disabled: true })])
    ]
  });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, 'DeepSeek');
  assert.equal(groups[1].label, '通义千问');
  assert.equal(groups[1].rows[0].disabled, true);
});

test('readGroups：空下拉 / 没有 children 都给空数组，不抛错', () => {
  assert.deepEqual(mod.readGroups({ children: [] }), []);
  assert.deepEqual(mod.readGroups({}), []);
  assert.deepEqual(mod.readGroups(null), []);
});

// ---------------------------------------------------------------------------
//  显示清单
// ---------------------------------------------------------------------------

test('buildRenderList：只有一个分组时不插组标题行', () => {
  const list = mod.buildRenderList([{ label: '甲', rows: [{ value: 'a', label: 'A' }] }]);
  assert.deepEqual(list, [{ kind: 'row', value: 'a', label: 'A', disabled: false }]);
});

test('buildRenderList：两个以上分组才插标题，且按出现顺序排在各自那组前面', () => {
  const list = mod.buildRenderList([
    { label: '甲', rows: [{ value: 'a', label: 'A' }] },
    { label: '乙', rows: [{ value: 'b', label: 'B' }] }
  ]);
  assert.deepEqual(list, [
    { kind: 'group', label: '甲' },
    { kind: 'row', value: 'a', label: 'A', disabled: false },
    { kind: 'group', label: '乙' },
    { kind: 'row', value: 'b', label: 'B', disabled: false }
  ]);
});

test('buildRenderList：没名字的那个组（want 排在 optgroup 之前那种）不顶标题', () => {
  const list = mod.buildRenderList([
    { label: '', rows: [{ value: 'want', label: 'want' }] },
    { label: '甲', rows: [{ value: 'a', label: 'A' }] },
    { label: '乙', rows: [{ value: 'b', label: 'B' }] }
  ]);
  assert.equal(list[0].kind, 'row');
  assert.equal(list.filter((i) => i.kind === 'group').length, 2);
});

test('buildRenderList：空组直接丢掉（不给空下拉画一个空标题）', () => {
  const list = mod.buildRenderList([
    { label: '甲', rows: [] },
    { label: '乙', rows: [{ value: 'b', label: 'B' }] }
  ]);
  assert.deepEqual(list, [{ kind: 'row', value: 'b', label: 'B', disabled: false }]);
});

test('renderRows：组标题不是行（键盘不落在它上面）', () => {
  const list = mod.buildRenderList([
    { label: '甲', rows: [{ value: 'a', label: 'A' }] },
    { label: '乙', rows: [{ value: 'b', label: 'B' }] }
  ]);
  const rows = mod.renderRows(list);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.value), ['a', 'b']);
});

// ---------------------------------------------------------------------------
//  上下键
// ---------------------------------------------------------------------------

const three = [{}, {}, {}].map((_, i) => ({ value: String(i), label: String(i), disabled: false }));

test('stepIndex：正常上下走一格', () => {
  assert.equal(mod.stepIndex(three, 0, 1), 1);
  assert.equal(mod.stepIndex(three, 2, -1), 1);
});

test('stepIndex：到头就停住（不绕回另一头）', () => {
  assert.equal(mod.stepIndex(three, 2, 1), 2);
  assert.equal(mod.stepIndex(three, 0, -1), 0);
});

test('stepIndex：还没有高亮（-1）时落到第一个可用项', () => {
  assert.equal(mod.stepIndex(three, -1, 1), 0);
  assert.equal(mod.stepIndex(three, -1, -1), 0);
});

test('stepIndex：跳过禁用项', () => {
  const rows = [
    { value: '0', label: '0', disabled: false },
    { value: '1', label: '1', disabled: true },
    { value: '2', label: '2', disabled: false }
  ];
  assert.equal(mod.stepIndex(rows, 0, 1), 2);
  assert.equal(mod.stepIndex(rows, 2, -1), 0);
});

test('stepIndex / firstEnabled：全禁用时不死循环，给回原下标或 -1', () => {
  const rows = [{ value: '0', label: '0', disabled: true }];
  assert.equal(mod.stepIndex(rows, 0, 1), 0);
  assert.equal(mod.stepIndex(rows, -1, 1), -1);
  assert.equal(mod.stepIndex([], 0, 1), -1);
});

test('firstEnabled / lastEnabled：只认可用的那一头', () => {
  const rows = [
    { disabled: true },
    { disabled: false },
    { disabled: true },
    { disabled: false },
    { disabled: true }
  ];
  assert.equal(mod.firstEnabled(rows), 1);
  assert.equal(mod.lastEnabled(rows), 3);
  assert.equal(mod.firstEnabled([]), -1);
  assert.equal(mod.lastEnabled([]), -1);
});

// ---------------------------------------------------------------------------
//  打字定位
// ---------------------------------------------------------------------------

const words = [
  { label: 'apple', disabled: false },
  { label: 'banana', disabled: false },
  { label: 'blueberry', disabled: false },
  { label: 'cherry', disabled: true },
  { label: '苹果', disabled: false }
];

test('prefixMatch：从头找第一个以它开头的行', () => {
  assert.equal(mod.prefixMatch(words, 'b', -1), 1);
  assert.equal(mod.prefixMatch(words, 'app', -1), 0);
});

test('prefixMatch：从当前行后面接着找 —— 连按同一个字母在几行之间循环', () => {
  assert.equal(mod.prefixMatch(words, 'b', 1), 2);
  assert.equal(mod.prefixMatch(words, 'b', 2), 1); // 转一圈回到第一个
});

test('prefixMatch：大小写不管、中文按子串开头匹配', () => {
  assert.equal(mod.prefixMatch(words, 'B', -1), 1);
  assert.equal(mod.prefixMatch(words, '苹', -1), 4);
});

test('prefixMatch：跳过禁用项（cherry 是禁用的，c 找不到）', () => {
  assert.equal(mod.prefixMatch(words, 'c', -1), -1);
});

test('prefixMatch：空查询 / 没有匹配 / 空列表都是 -1', () => {
  assert.equal(mod.prefixMatch(words, '', -1), -1);
  assert.equal(mod.prefixMatch(words, 'zzz', -1), -1);
  assert.equal(mod.prefixMatch([], 'a', -1), -1);
  assert.equal(mod.prefixMatch(null, 'a', -1), -1);
});

test('typeaheadQuery：第一个键开一个新词', () => {
  assert.deepEqual(mod.typeaheadQuery(null, 'a', 1000), { text: 'a', at: 1000 });
  assert.deepEqual(mod.typeaheadQuery({}, 'a', 1000), { text: 'a', at: 1000 });
});

test('typeaheadQuery：700ms 之内接着拼（这样 b→l→u 能拼出 blueberry）', () => {
  let buf = mod.typeaheadQuery(null, 'b', 1000);
  buf = mod.typeaheadQuery(buf, 'l', 1100);
  buf = mod.typeaheadQuery(buf, 'u', 1200);
  assert.equal(buf.text, 'blu');
  assert.equal(buf.at, 1200);
});

test('typeaheadQuery：超过 700ms 就重开一个词（= 同一个字母连按去下一行）', () => {
  const first = mod.typeaheadQuery(null, 'b', 1000);
  const again = mod.typeaheadQuery(first, 'b', 1800);
  assert.deepEqual(again, { text: 'b', at: 1800 });
  // 恰好 700ms 还算同一个词（边界不抖）
  assert.deepEqual(mod.typeaheadQuery(first, 'b', 1700), { text: 'bb', at: 1700 });
});

// ---------------------------------------------------------------------------
//  弹层位置
// ---------------------------------------------------------------------------

test('popoverWidth：不窄于触发器，也不窄于 140（64px 的属性下拉列表也得能读）', () => {
  assert.equal(mod.popoverWidth(64, 1000), 140);
  assert.equal(mod.popoverWidth(300, 1000), 300);
});

test('popoverWidth：视口装不下就贴着两边（不留负宽）', () => {
  assert.equal(mod.popoverWidth(300, 100), 84); // 100 - 8*2
  assert.equal(mod.popoverWidth(300, 0), 300); // 量不到视口就按原宽
});

test('placePopover：下面放得下就贴触发器下面', () => {
  const spot = mod.placePopover(
    { left: 100, top: 100, bottom: 144, width: 200 },
    { height: 200 },
    { width: 1000, height: 800 }
  );
  assert.deepEqual(spot, { left: 100, top: 150, width: 200, above: false });
});

test('placePopover：下面放不下就翻到触发器上面', () => {
  const spot = mod.placePopover(
    { left: 100, top: 600, bottom: 644, width: 200 },
    { height: 300 },
    { width: 1000, height: 800 }
  );
  assert.deepEqual(spot, { left: 100, top: 294, width: 200, above: true });
});

test('placePopover：上下都放不下就夹在视口里（不许跑出屏幕）', () => {
  const spot = mod.placePopover(
    { left: 100, top: 60, bottom: 104, width: 200 },
    { height: 700 },
    { width: 1000, height: 800 }
  );
  assert.equal(spot.above, false);
  assert.equal(spot.top, 92); // 800 - 8 - 700
});

test('placePopover：贴右边缘的触发器，弹层往左收回来', () => {
  const spot = mod.placePopover(
    { left: 950, top: 100, bottom: 144, width: 300 },
    { height: 200 },
    { width: 1000, height: 800 }
  );
  assert.equal(spot.width, 300);
  assert.equal(spot.left, 692); // 1000 - 8 - 300
});

test('placePopover：视口比最小宽度还窄时也不给出负坐标', () => {
  const spot = mod.placePopover(
    { left: 90, top: 10, bottom: 40, width: 300 },
    { height: 100 },
    { width: 100, height: 200 }
  );
  assert.equal(spot.width, 84);
  assert.equal(spot.left, 8);
  assert.ok(spot.top >= 8);
});

// ---------------------------------------------------------------------------
//  控件规范件：ui/controls.js + ui/build.js 的 button
//
//  h() / controls.js 要 document.createElement，所以这里塞一个**只够用**的假
//  DOM（不引 jsdom）。它只实现这几件事：setAttribute / getAttribute /
//  appendChild / children / className / textContent / <select> 的 options。
// ---------------------------------------------------------------------------

function makeFakeDocument() {
  const textNode = (text) => ({ nodeType: 3, textContent: String(text) });
  const createElement = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      className: '',
      textContent: '',
      dataset: {},
      disabled: false,
      value: '',
      setAttribute(key, value) {
        this.attributes[key] = String(value);
      },
      getAttribute(key) {
        return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
      },
      addEventListener() {},
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      // build.js 的 clear() 就是 `node.innerHTML = ''`，假 DOM 得认这一下，
      // 否则「重铺之前先清空」根本测不出来（测试会假绿）
      get innerHTML() {
        return '';
      },
      set innerHTML(value) {
        if (value === '') this.children.length = 0;
      }
    };
    if (node.tagName === 'SELECT') {
      Object.defineProperty(node, 'options', {
        get() {
          const out = [];
          for (const child of this.children) {
            if (child.tagName === 'OPTION') out.push(child);
            else if (child.tagName === 'OPTGROUP') {
              for (const sub of child.children) if (sub.tagName === 'OPTION') out.push(sub);
            }
          }
          return out;
        }
      });
    }
    return node;
  };
  return { createElement, createTextNode: textNode };
}

let controls;
let build;
test.before(async () => {
  globalThis.document = makeFakeDocument();
  build = await import(
    pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'ui', 'build.js')).href
  );
  controls = await import(
    pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'ui', 'controls.js')).href
  );
});

const el = (tag) => document.createElement(tag);
const classesOf = (node) => node.className.split(' ').filter(Boolean);

test('button：语义外观参数拼出既有的那几个类名', () => {
  assert.equal(build.button({ text: '保存', variant: 'primary', size: 'sm' }).className, 'btn btn-primary btn-sm');
  assert.equal(build.button({ text: '取消', variant: 'ghost', size: 'sm' }).className, 'btn btn-ghost btn-sm');
  assert.equal(build.button({ text: '清空', variant: 'danger' }).className, 'btn btn-danger');
  assert.equal(build.button({ text: '确定', variant: 'base' }).className, 'btn');
  assert.equal(build.button({ text: '占满', variant: 'primary', block: true }).className, 'btn btn-primary btn-block');
});

test('button：不给 variant 就**不补 .btn**（那批「长得不像按钮的按钮」不能被顶掉样式）', () => {
  assert.equal(build.button({ text: '×', class: 'char-card-del' }).className, 'char-card-del');
  assert.equal(build.button({ text: '⋯', class: 'attr-tab-edit' }).className, 'attr-tab-edit');
  assert.equal(build.button({ text: '‹', class: 'variant-btn' }).className, 'variant-btn');
});

test('button：老的「整串类名」写法原样通过（不给 variant 时一个字符都不变）', () => {
  assert.equal(build.button({ text: '编辑', class: 'btn btn-ghost btn-sm' }).className, 'btn btn-ghost btn-sm');
  assert.equal(build.button({ text: '聊天', class: 'btn btn-primary btn-sm' }).className, 'btn btn-primary btn-sm');
});

test('button：条件类名里的 false 不会变成名叫 "false" 的类', () => {
  assert.equal(build.button({ text: '标签', class: ['attr-tab', false && 'active'] }).className, 'attr-tab');
  assert.equal(build.button({ text: '标签', class: ['attr-tab', true && 'active'] }).className, 'attr-tab active');
  assert.equal(build.button({ text: '标签', class: ['attr-tab', null, undefined] }).className, 'attr-tab');
});

test('button：语义参数和额外类名混着给，去重且顺序稳定', () => {
  assert.equal(
    build.button({ text: '删除', variant: 'ghost', size: 'sm', class: 'preset-row-delete' }).className,
    'btn btn-ghost btn-sm preset-row-delete'
  );
  assert.equal(build.button({ text: 'x', variant: 'primary', class: 'btn btn-primary' }).className, 'btn btn-primary');
});

test('button：认不出来的 variant / size 当场报错（不静默丢掉）', () => {
  const original = console.error;
  const seen = [];
  console.error = (msg) => seen.push(String(msg));
  try {
    build.button({ text: 'x', variant: 'primry', size: 'xl' });
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes('primry'));
  assert.ok(seen[1].includes('xl'));
});

test('button：type 固定 button（表单里的按钮不该变成提交），text 走 textContent', () => {
  const btn = build.button({ text: '<b>不是 HTML</b>', variant: 'base' });
  assert.equal(btn.getAttribute('type'), 'button');
  assert.equal(btn.textContent, '<b>不是 HTML</b>');
});

test('input：type 默认 text、拼写检查默认关，值走 property', () => {
  const box = controls.input({ id: 'wb-name', value: '带过来的值' });
  assert.equal(box.tagName, 'INPUT');
  assert.equal(box.getAttribute('type'), 'text');
  assert.equal(box.getAttribute('spellcheck'), 'false');
  assert.equal(box.value, '带过来的值');
  assert.equal(box.getAttribute('value'), null); // 是 property，不是 attribute
});

test('input：调用方给的 type / spellcheck 能盖过默认值', () => {
  const box = controls.input({ type: 'number', spellcheck: 'true', min: 1, max: 6 });
  assert.equal(box.getAttribute('type'), 'number');
  assert.equal(box.getAttribute('spellcheck'), 'true');
  assert.equal(box.getAttribute('min'), '1');
  assert.equal(box.getAttribute('max'), '6');
});

test('textarea：rows 默认 3，能覆盖', () => {
  assert.equal(controls.textarea({}).getAttribute('rows'), '3');
  assert.equal(controls.textarea({ rows: 8 }).getAttribute('rows'), '8');
});

test('field：标签 + 控件 + 说明，默认两列（不加 field-stack）', () => {
  const box = controls.field({ label: '书名', control: controls.input({ id: 'wb-name' }) });
  assert.equal(box.tagName, 'LABEL');
  assert.deepEqual(classesOf(box), ['field']);
  assert.equal(box.children.length, 2);
  assert.equal(box.children[0].className, 'field-label');
  assert.equal(box.children[0].textContent, '书名');
  assert.equal(box.children[1].tagName, 'INPUT');
});

test('field：stack / hint / icon 各自落到该落的地方', () => {
  const box = controls.field({
    label: '开场白',
    control: controls.textarea({}),
    hint: '留空就让 AI 现生成',
    stack: true,
    icon: 'message-circle'
  });
  assert.deepEqual(classesOf(box), ['field', 'field-stack']);
  assert.equal(box.children.length, 3);
  assert.equal(box.children[2].className, 'field-help');
  assert.equal(box.children[2].textContent, '留空就让 AI 现生成');
  assert.equal(box.children[0].getAttribute('data-icon'), 'message-circle');
});

test('field：不给说明就不占那一格（别留一个空 span 撑出行高）', () => {
  const box = controls.field({ label: 'x', control: controls.input({}) });
  assert.equal(box.children.length, 2);
});

test('fillSelect：铺完按 prefer 选中，并按「有没有可选项」定 disabled', () => {
  const select = el('select');
  const picked = controls.fillSelect(
    select,
    [
      { value: 'a', text: '甲' },
      { value: 'b', text: '乙' }
    ],
    { prefer: 'b' }
  );
  assert.equal(picked, 'b');
  assert.equal(select.value, 'b');
  assert.equal(select.disabled, false);
  assert.deepEqual(select.options.map((o) => [o.value, o.textContent]), [['a', '甲'], ['b', '乙']]);
});

test('fillSelect：prefer 不在列表里就落到第一项（下拉框一直以来的口径）', () => {
  const select = el('select');
  controls.fillSelect(select, [{ value: 'a', text: '甲' }, { value: 'b', text: '乙' }], { prefer: '不在' });
  assert.equal(select.value, 'a');
});

test('fillSelect：一项都没有 → 铺提示那一条并**禁用整个下拉**', () => {
  const select = el('select');
  const picked = controls.fillSelect(select, [], { emptyText: '（先在上面选一个提供商）' });
  assert.equal(picked, '');
  assert.equal(select.disabled, true);
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, '');
  assert.equal(select.options[0].textContent, '（先在上面选一个提供商）');
});

test('fillSelect：铺之前先清空（重铺不会把选项越接越多）', () => {
  const select = el('select');
  controls.fillSelect(select, [{ value: 'a', text: '甲' }]);
  controls.fillSelect(select, [{ value: 'b', text: '乙' }]);
  assert.equal(select.options.length, 1);
  assert.equal(select.value, 'b');
});

test('fillSelect：group 包成 optgroup，散项排在分组前面（不在任何服务商里的那个值）', () => {
  const select = el('select');
  controls.fillSelect(select, [
    { value: 'want', text: 'want（不在列表里）' },
    { group: 'DeepSeek', items: [{ value: 'deepseek-chat' }] },
    { group: '通义千问', items: [{ value: 'qwen-max' }] }
  ]);
  assert.deepEqual(select.children.map((c) => c.tagName), ['OPTION', 'OPTGROUP', 'OPTGROUP']);
  assert.equal(select.children[1].getAttribute('label'), 'DeepSeek');
  // text 不给就拿 value 当显示文字
  assert.equal(select.children[1].children[0].textContent, 'deepseek-chat');
  assert.deepEqual(select.options.map((o) => o.value), ['want', 'deepseek-chat', 'qwen-max']);
});

test('fillSelect：空的分组不铺一个空 optgroup', () => {
  const select = el('select');
  controls.fillSelect(select, [
    { group: '空的', items: [] },
    { group: '有货', items: [{ value: 'a', text: 'A' }] }
  ]);
  assert.deepEqual(select.children.map((c) => c.getAttribute('label')), ['有货']);
});

test('fillSelect：disabled 的那一项带着 disabled 属性铺出来', () => {
  const select = el('select');
  controls.fillSelect(select, [{ value: 'a', text: 'A', disabled: true }, { value: 'b', text: 'B' }]);
  assert.equal(select.options[0].getAttribute('disabled'), '');
  assert.equal(select.options[1].getAttribute('disabled'), null);
});

test('fillSelect：select 传 null 不抛错（拿不到节点时静默无害）', () => {
  assert.equal(controls.fillSelect(null, [{ value: 'a' }]), '');
});
