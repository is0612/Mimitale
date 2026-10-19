'use strict';

// ============================================================================
//  views/characterList.js —— 角色列表页
//
//  这份列表以前塞在编辑弹窗的左栏里，弹窗一关就看不见角色有哪些。
//  现在它是主区域里的一个独立页面，每张卡直接给「编辑」和「聊天」两个入口。
//
//  三个动作由入口层注入（卡片上的按钮要干的事都跨了别的分区）：
//    · edit   —— 用编辑弹窗打开这个角色（要设编辑器的对象和作用域）
//    · chat   —— 新建会话并绑上这个角色，然后切回聊天屏
//    · remove —— 删角色（会牵连到会话解绑，属于入口层的编排）
//
//  批量（2026-10-19）：工具条上的「批量」进入选择态，选中若干张之后导出 / 删除。
//  导出是每张一个 JSON（见 chatExport 的 exportCharactersByIds），删除要一次确认、
//  一次写盘 —— 所以这两个动作同样由入口层注入（removeMany / exportMany），
//  本模块只管选择和按钮，不碰数据。
//
//  重绘入口是 renderCharacterPage()，由 views/viewSwitch.js 在
//  「当前正停在角色页」时调用（那个分发要读 currentView）。
//
//  ⚠️ 卡片本身和世界书列表共用 ui/build.js 的 libraryCard() —— 两边只允许
//     差在「内容」上（封面 / 名字 / 一行说明 / 动作），不许再各写一份外壳。
// ============================================================================

import { el } from '../core/dom.js';
import { h, libraryCard, renderListPage } from '../ui/build.js';
// 组件库：卡片上「编辑 / 聊天」是通用按钮，走工厂建 m-button（见 components/index.js）
import { mButton } from '../components/index.js';
import { entityTone } from '../ui/avatarTone.js';
import { openLightbox } from '../ui/lightbox.js';
import { characters, characterPortrait } from '../data/library.js';
import { createBatchSelect } from './batchSelect.js';

let actions = { edit: () => {}, chat: () => {}, remove: () => {}, removeMany: null, exportMany: null };
let query = '';
/** 批量选择状态机（initCharacterList 里建，render 时读它的选择态） */
let batch = null;

const EMPTY_TITLE = '还没有角色';
const EMPTY_HINT = '点右上角「导入角色卡」选一张酒馆的 PNG / JSON 卡，或者点「＋ 新建角色」自己写一个。';

/** 卡片的来源文案：三处（卡片 / 搜索）共用同一种说法，别一边写「酒馆卡」一边写「PNG」 */
function sourceText(character) {
  return character.source === 'png' ? '酒馆角色卡' : character.source === 'json' ? 'JSON 角色卡' : '手写';
}

/** 这张卡匹不匹配搜索词（名字 / 来源 / 标签 / 描述都算） */
function matchesQuery(character, needle) {
  if (!needle) return true;
  return [
    character.name,
    character.description,
    character.personality,
    character.scenario,
    sourceText(character),
    ...(Array.isArray(character.tags) ? character.tags : [])
  ].join(' ').toLocaleLowerCase().includes(needle);
}

export function initCharacterList(injected) {
  actions = { edit: () => {}, chat: () => {}, remove: () => {}, ...(injected || {}) };
  if (el.charPageSearch) {
    el.charPageSearch.addEventListener('input', (event) => {
      query = event.target.value;
      renderCharacterPage();
    });
  }

  batch = createBatchSelect({
    nodes: {
      enter: el.btnCharBatch,
      normal: el.charBatchNormal,
      active: el.charBatchActive,
      count: el.charBatchCount,
      selectAll: el.btnCharSelectAll,
      exportBtn: el.btnCharBatchExport,
      deleteBtn: el.btnCharBatchDelete,
      exit: el.btnCharBatchExit
    },
    unit: '个',
    onRender: renderCharacterPage,
    // 这两个动作由入口层注入（角色库的导出 / 删除都要跨模块编排）
    onExport: (ids) => (actions.exportMany ? actions.exportMany(ids) : null),
    onDelete: (ids) => (actions.removeMany ? actions.removeMany(ids) : false)
  });
}

export function renderCharacterPage() {
  const all = characters();
  const needle = query.trim().toLocaleLowerCase();
  const list = all.filter((character) => matchesQuery(character, needle));

  // 告诉选择态「现在屏幕上看得见哪些」—— 全选只作用于这一批
  if (batch) batch.setVisible(list.map((character) => character.id));

  renderListPage({
    grid: el.charPageGrid,
    empty: el.charPageEmpty,
    sub: el.charsPageSub,
    subText: all.length
      ? `共 ${all.length} 个角色 · 点「聊天」先定好你是谁，再开始`
      : '导入酒馆角色卡，或自己写一个',
    items: list,
    card: characterCard
  });

  if (el.charPageCount) {
    el.charPageCount.textContent = needle ? `${list.length} / ${all.length} 个角色` : `${all.length} 个角色`;
  }

  // 空态分两种：一个角色都没有 vs 搜不到。后者不该再说「去导入一张卡」。
  const emptyTitle = el.charPageEmpty && el.charPageEmpty.querySelector('.page-empty-title');
  const emptyHint = el.charPageEmpty && el.charPageEmpty.querySelector('.page-empty-hint');
  const searching = !!needle && all.length > 0;
  if (emptyTitle) emptyTitle.textContent = searching ? '没有匹配的角色' : EMPTY_TITLE;
  if (emptyHint) emptyHint.textContent = searching ? '换个关键词再试，或者清空搜索框。' : EMPTY_HINT;
}

/** 一张角色卡：2:3 形象 + 名字 + 来源/标签 + 编辑/聊天，右上角悬停浮出删除 */
function characterCard(c) {
  // 来源 + 分类标签挤在同一行：卡片高度不变，标签也不会把卡片撑得参差不齐。
  // 标签是「这张卡属于什么类型」（作品/风格/用途），只显示前几个，多了省略。
  const subBits = [sourceText(c)];
  for (const tag of (Array.isArray(c.tags) ? c.tags : []).slice(0, 3)) {
    if (String(tag).trim()) subBits.push(String(tag).trim());
  }
  const subText = subBits.join(' · ');

  // 卡上铺的是**角色形象**（2:3 立绘），不是头像 —— 头像那么小的圆图铺在这块
  // 会糊成一片。老卡没单独设过形象，characterPortrait 会用头像顶上。
  const portrait = characterPortrait(c);

  return libraryCard({
    title: c.name,
    sub: subText,
    // 渐变圆 + 白字（设计稿的 .kface）：和侧栏 / 在场角色栏 / 消息区共用同一套色板，
    // 同一个角色在哪一屏都是同一个颜色。
    media: portrait ? h('img', { src: portrait, alt: '' }) : String(c.name || '').slice(0, 1) || '?',
    mediaClass: ['art-edge', entityTone(c.id, c.name)],
    // 点形象看大图。没有图时那块是首字色块，点了也没东西可看，索性不接。
    mediaTitle: `${c.name} · 点开看大图`,
    onMediaClick: portrait ? () => openLightbox(portrait, { title: c.name }) : null,    // 删除：静止时是透明的，鼠标移上来才浮出来 —— 跟左侧会话列表的 × 同一套。
    // 这样卡片平时还是干净的「编辑 / 聊天」两个按钮，不至于误点。
    // ⚠️ 它是**图标按钮**（靠 .char-card-del 自己定义外形），不走 m-button：
    //    套上组件宿主会多一层壳，而 .char-card-del 的内边距/圆角是直接落在
    //    `<button>` 自己身上的（components/button.js 文件头写了这条边界）。
    extra: h('button', {
      type: 'button',
      class: 'char-card-del',
      text: '×',
      title: '删除这个角色',
      'aria-label': `删除角色：${c.name}`,
      onclick: (event) => {
        event.stopPropagation();
        actions.remove(c.id, 'library');
      }
    }),
    actions: [
      mButton({ variant: 'ghost', size: 'sm', text: '编辑', onClick: () => actions.edit(c.id) }),
      mButton({ variant: 'primary', size: 'sm', text: '聊天', onClick: () => actions.chat(c.id) })
    ],
    // 批量选择态：整卡可点、左侧勾选圈；「编辑 / 聊天」和删除 × 由 CSS 藏起来
    selecting: !!(batch && batch.isActive()),
    selected: !!(batch && batch.has(c.id)),
    onSelect: () => batch && batch.toggle(c.id)
  });
}
