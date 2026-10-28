'use strict';

// 输入框左边的「快捷短语」面板：点一行把整条指令插进光标处，焦点还给输入框。
// ⚠️ 是「插进去」不是「直接发出去」：带冒号的那几条只是前缀；「点一下就发」由剧情选项（views/suggestionsUi.js）负责。

import { el } from '../core/dom.js';
import { iconHtml } from '../ui/icons.js';
import { h, clear } from '../ui/build.js';

/**
 * name 面板行显示的名字；insert 真正插进输入框的文字；preview:false = 该行不显示预览。
 * group 决定分组标题（prefix = 插完接着写，sentence = 插了就能发，symbol = 符号）。
 * ⚠️ insert 整条带**全角括号**原样进输入框：不能在渲染面板时才补括号（那样发出去的没有括号）。
 * ⚠️ 前五条是前缀（末尾冒号是给用户接着写内容用的），别顺手改成整句。
 */
export const QUICK_PHRASES = [
  // —— 前缀类：插完光标停在右括号**里面**，接着写内容 ——
  { name: '旁白', insert: '（旁白：）', group: 'prefix' },
  { name: 'OOC', insert: '（OOC：）', group: 'prefix' },
  { name: '内心', insert: '（内心：）', group: 'prefix' },
  { name: '摄像机视角', insert: '（摄像机视角：）', group: 'prefix' },
  // 带破折号 = 留给用户补「过了多久」，所以它也是前缀
  { name: '时间流逝', insert: '（时间流逝——）', group: 'prefix' },
  // —— 整句指令：插进来直接发就行 ——
  { name: '描写画面', insert: '（描写当前画面）', group: 'sentence' },
  { name: '详细描写', insert: '（把这一段展开写细）', group: 'sentence' },
  { name: '继续', insert: '（继续）', group: 'sentence' },
  { name: '推进剧情', insert: '（推进剧情到下一个场景）', group: 'sentence' },
  { name: '加快节奏', insert: '（加快节奏）', group: 'sentence' },
  // —— 符号：没有可预览的指令，不显示预览那一栏 ——
  { name: '♡', insert: '♡', preview: false, group: 'symbol' },
  { name: '♡……', insert: '♡……', preview: false, group: 'symbol' },
  { name: '♪', insert: '♪', preview: false, group: 'symbol' }
];

/** 分组标题。缺 group 的行不画标题，直接接在上一组后面。 */
const GROUP_TITLE = {
  prefix: '前缀 · 插完接着写',
  sentence: '整句 · 插了就能发',
  symbol: '符号'
};

/**
 * 右侧那栏只在「insert 比名字多说了点什么」时才有意义，否则就是把左边重复一遍。
 * 末尾的冒号 / 破折号算语气，不算信息（「旁白（旁白：）」这类就是纯重复）。
 */
function hintOf(phrase) {
  if (phrase.preview === false) return '';
  const inner = String(phrase.insert)
    .replace(/^（/, '')
    .replace(/）$/, '')
    .replace(/[：—]+$/, '')
    .trim();
  return inner === String(phrase.name).trim() ? '' : phrase.insert;
}

/**
 * 纯函数（不碰 DOM，可在裸 Node 里测）：把 insert 插进 [start, end) 区间，返回新值和光标位。
 * 和 textarea 自己的行为一致：有选区是**替换选区**，没选区是光标处插入。
 * ⚠️ 插入点两侧**不加**空格 / 换行：中文里「（旁白： ）」那个尾随空格很显眼。
 */
export function applyInsert(value, start, end, insert) {
  const text = String(value == null ? '' : value);
  const added = String(insert == null ? '' : insert);

  const clamp = (n) => Math.max(0, Math.min(Number.isFinite(n) ? Math.floor(n) : 0, text.length));
  const from = clamp(start);
  // 选区反了（end < start）按「就在 from 处插入」处理，别把中间那段吃掉
  const to = Math.max(from, clamp(end));

  // ⚠️ 整条「（…）」插完光标要落在右括号**前面**：落在末尾还得自己按一次左箭头才写得进去。
  // 只认末尾那一个全角右括号（半角 / 嵌套不在这个面板里，不猜）。
  const back = added.endsWith('）') ? 1 : 0;

  return { value: text.slice(0, from) + added + text.slice(to), caret: from + added.length - back };
}

let isOpen = false;
let initialized = false;

/** 面板里的行。分组标题是 div，天然被排除在外 */
function rows() {
  return el.quickMenu ? Array.from(el.quickMenu.querySelectorAll('.quick-item')) : [];
}

function setOpen(next) {
  if (!el.btnQuick || !el.quickMenu) return;
  isOpen = next;
  el.quickMenu.classList.toggle('hidden', !next);
  el.btnQuick.setAttribute('aria-expanded', next ? 'true' : 'false');
}

/** ⚠️ 会话正在生成时**照样能插**：这里只往输入框写字，不发送（真正被拦的是发送那一步）。 */
function insertPhrase(text) {
  const input = el.input;
  if (!input) return;

  const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
  const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
  const next = applyInsert(input.value, start, end, text);

  input.value = next.value;
  // 先聚焦再定位光标：有些情况下 focus() 会把选区重置到末尾
  input.focus();
  input.setSelectionRange(next.caret, next.caret);
  // 派 input 事件而不是直接调 autoGrowInput：它是「用户改了输入框」的标准信号，谁在听谁处理。
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderRows() {
  clear(el.quickMenu);
  let group = '';
  for (const phrase of QUICK_PHRASES) {
    // 分组标题只是装饰：rows() 按 .quick-item 取行，这些 div 天然被排除
    if (phrase.group && phrase.group !== group) {
      group = phrase.group;
      if (GROUP_TITLE[group]) {
        el.quickMenu.appendChild(h('div', { class: 'quick-group', role: 'presentation', text: GROUP_TITLE[group] }));
      }
    }
    const hint = hintOf(phrase);
    el.quickMenu.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: 'menu-item quick-item',
          role: 'menuitem',
          // 悬停时说清「点了会插进什么」，长短语在面板里是看不全的
          title: phrase.insert,
          onclick: () => {
            setOpen(false);
            insertPhrase(phrase.insert);
          }
        },
        h('span', { class: 'quick-name', text: phrase.name }),
        // 右侧只在有增量信息时显示（和名字相同的就不重复第二遍）
        hint ? h('span', { class: 'quick-hint', text: hint }) : null
      )
    );
  }
}

/** 在一组行之间挪焦点。到头就停住 —— 绕回另一头反而容易点错 */
function moveFocus(from, step) {
  const list = rows();
  const index = list.indexOf(from);
  if (index < 0) return;
  const target = list[index + step];
  if (target) target.focus();
}

/** 只绑一次（入口层启动时调）；短语表是静态的，面板内容铺一次就够，开合只切 hidden。 */
export function initQuickPhrases() {
  if (initialized || !el.btnQuick || !el.quickMenu || !el.input) return;
  initialized = true;
  el.btnQuick.setAttribute('aria-controls', el.quickMenu.id);

  const icon = iconHtml('sparkles', 'quick-icon');
  if (icon) el.btnQuick.insertAdjacentHTML('afterbegin', icon);

  renderRows();

  el.btnQuick.addEventListener('click', () => {
    // document 的关闭逻辑会排除按钮本身；保留冒泡，让其它菜单正常关闭。
    setOpen(!isOpen);
  });

  // 在按钮上按上下键 = 展开并落到第一行上（原生 select / 模型弹层同一套肌肉记忆）
  el.btnQuick.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setOpen(true);
    const list = rows();
    const target = event.key === 'ArrowUp' ? list[list.length - 1] : list[0];
    if (target) target.focus();
  });

  // 行本身是 <button>，回车 / 空格不用管；这里只补上下键和 Home / End
  el.quickMenu.addEventListener('keydown', (event) => {
    const list = rows();
    if (!list.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(document.activeElement, event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? list[0] : list[list.length - 1];
      if (target) target.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (!isOpen) return;
    if (el.btnQuick.contains(event.target) || el.quickMenu.contains(event.target)) return;
    setOpen(false);
  });

  // 聚焦离开面板时也收起，不把浮层留在后台。
  document.addEventListener('focusin', (event) => {
    if (!isOpen) return;
    if (el.btnQuick.contains(event.target) || el.quickMenu.contains(event.target)) return;
    setOpen(false);
  });

  // Esc 收起，焦点还给输入框（键盘用户不至于掉到页面开头）。
  // ⚠️ 用捕获阶段拦下（同 ui/menu.js）：菜单开着时 Esc 只关菜单，不能连底下的弹窗一起关。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setOpen(false);
    el.input.focus();
  }, true);
}
