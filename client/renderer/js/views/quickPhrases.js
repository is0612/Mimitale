'use strict';

// ============================================================================
//  views/quickPhrases.js —— 输入框左边的「快捷短语」面板
//
//  点一下面板里的某一行，把那一整条指令**插进输入框的光标处**，焦点还给
//  输入框，接着往下打字。就这一件事，别的什么都不做。
//
//  为什么是「插进去」而不是「直接发出去」：
//    前四条（（旁白：）/（OOC：）/（内心：）/（摄像机视角：））是**前缀** ——
//    插完本来就要在里面接着写内容，直接发出去只会得到一条半截指令。
//    「点一下就发」那条路已经由建议条（#suggest-strip，见 views/suggestionsUi.js）
//    负责，两个入口别抢同一件事：一个补全句子，一个替你把话说完。
//
//  开合与键盘照着 ui/modelMenu.js 那一套（点按钮开合 / 点别处关 / Esc 关 /
//  上下键走行 + Home / End）：用户在这两个弹层上的肌肉记忆是同一套。
// ============================================================================

import { el } from '../core/dom.js';
import { iconHtml } from '../ui/icons.js';
import { h, clear } from '../ui/build.js';

/**
 * 快捷短语表。
 *
 *   name     面板行上显示的名字
 *   insert   真正插进输入框的文字 —— **连括号一起**，它在输入框里长什么样，
 *            在面板右侧那行淡色预览里就长什么样（两者是同一个字符串）
 *   preview  false = 该行右侧不显示预览（只对符号那几行用）
 *
 * 加一条短语：照下面加一行即可，面板的行数是跟着这张表走的，别处不用改。
 *
 * ⚠️ 为什么整条都用**全角括号**包起来：这是「场外指令」的老写法（酒馆那套）——
 *    括号里的内容是说给模型听的，不是剧情里的台词。所以它必须原样进输入框，
 *    不能在渲染面板时才补上括号（那样发出去的就没有括号了）。
 * ⚠️ 前四条是**前缀**（末尾那个冒号就是给你接着写内容用的），别顺手改成整句。
 */
export const QUICK_PHRASES = [
  // —— 前缀类：插完光标停在右括号**里面**，接着写内容 ——
  { name: '旁白', insert: '（旁白：）' },
  { name: 'OOC', insert: '（OOC：）' },
  { name: '内心', insert: '（内心：）' },
  { name: '摄像机视角', insert: '（摄像机视角：）' },
  // —— 整句指令：插进来直接发就行 ——
  { name: '描写画面', insert: '（描写当前画面）' },
  { name: '详细描写', insert: '（详细描写）' },
  { name: '继续', insert: '（继续）' },
  { name: '推进剧情', insert: '（推进剧情到下一个场景）' },
  { name: '时间流逝', insert: '（时间流逝——）' },
  { name: '加快节奏', insert: '（加快节奏）' },
  // —— 符号：插一个语气 / 心情符号。它没有「可预览的指令」，所以不要预览那一栏 ——
  { name: '♡', insert: '♡', preview: false },
  { name: '♡……', insert: '♡……', preview: false },
  { name: '♪', insert: '♪', preview: false }
];

/**
 * 纯函数：把 `insert` 插进 `value` 的 [start, end) 区间，返回新值和插入后的光标位。
 *
 * 单独抽出来（不碰 DOM）是为了能在裸 Node 里测：这段的边界条件 ——
 * 选区反了、下标越界、输入框是空串 —— 都是 DOM 里难复现、但一错就插错地方的地方。
 * 和 textarea 自己的行为一致：有选区就是**替换选区**，没选区就是在光标处插入。
 *
 * ⚠️ 插入点两侧都**不加**空格 / 换行：中文里「（旁白： ）」那个尾随空格很显眼，
 *    而用户想接着写什么只有他自己知道。要分开就自己敲。
 */
export function applyInsert(value, start, end, insert) {
  const text = String(value == null ? '' : value);
  const added = String(insert == null ? '' : insert);

  const clamp = (n) => Math.max(0, Math.min(Number.isFinite(n) ? Math.floor(n) : 0, text.length));
  const from = clamp(start);
  // 选区反了（end < start）按「就在 from 处插入」处理，别把中间那段吃掉
  const to = Math.max(from, clamp(end));

  // 插的是一整条「（…）」时，光标落在**右括号前面**：插完就是要接着写内容，
  // 落在最末尾还得自己按一次左箭头才写得进去（「（旁白：）雨停了。」是错的）。
  // 只认末尾那一个全角右括号 —— 半角 / 嵌套那些不在这个面板里，不猜。
  const back = added.endsWith('）') ? 1 : 0;

  return { value: text.slice(0, from) + added + text.slice(to), caret: from + added.length - back };
}

let isOpen = false;
let initialized = false;

/** 面板里的行。占位文字（将来若加分组标题）是 div，天然被排除在外 */
function rows() {
  return el.quickMenu ? Array.from(el.quickMenu.querySelectorAll('.quick-item')) : [];
}

function setOpen(next) {
  if (!el.btnQuick || !el.quickMenu) return;
  isOpen = next;
  el.quickMenu.classList.toggle('hidden', !next);
  el.btnQuick.setAttribute('aria-expanded', next ? 'true' : 'false');
}

/**
 * 把文字插进输入框的光标处。
 *
 * 会话正在生成时**照样能插** —— 这里只是往输入框里写字，不发送；
 * 真正会被拦的是发送那一步（见 composer.js 的 sendMessage）。
 */
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
  // 让输入框自己长高 —— 派一个 input 事件而不是直接调 composer 的 autoGrowInput：
  // 这是「用户改了输入框」的标准信号，谁在听谁处理（composer.js 就在听），
  // 这里不用反过来 import 一整个聊天链路。
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderRows() {
  clear(el.quickMenu);
  for (const phrase of QUICK_PHRASES) {
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
        // 右侧那行淡色预览 = **插入内容的原文**（同一个字符串，不另存一份 ——
        // 两处各写一遍迟早对不上）。名字和它一样时也照显（图上「继续（继续）」），
        // 因为它是「点了会插进什么」的预览，不是解释。
        phrase.preview === false ? null : h('span', { class: 'quick-hint', text: phrase.insert })
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

/**
 * 绑按钮和面板。只绑一次（入口层在启动时调）。
 * 面板内容在**这里**铺一次就够 —— 短语表是静态的，开合只切 hidden。
 */
export function initQuickPhrases() {
  if (initialized || !el.btnQuick || !el.quickMenu || !el.input) return;
  initialized = true;
  el.btnQuick.setAttribute('aria-controls', el.quickMenu.id);

  // 按钮上的图标：和顶栏那几颗一样走 data-icon 那套（见 ui/icons.js），
  // 但那是给静态标签用的扫描，这里直接插一次更省事。
  const icon = iconHtml('braces', 'quick-icon');
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

  // 点别处收起
  document.addEventListener('click', (event) => {
    if (!isOpen) return;
    if (el.btnQuick.contains(event.target) || el.quickMenu.contains(event.target)) return;
    setOpen(false);
  });

  // Tab 或程序化聚焦离开面板时也收起，不把浮层留在后台。
  document.addEventListener('focusin', (event) => {
    if (!isOpen) return;
    if (el.btnQuick.contains(event.target) || el.quickMenu.contains(event.target)) return;
    setOpen(false);
  });

  // Esc 收起，焦点还给输入框（键盘用户不至于掉到页面开头）
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen) return;
    setOpen(false);
    el.input.focus();
  });
}
