'use strict';

// views/characterList.js —— 角色列表页（卡片 + 批量选择）
// edit / chat / playWorld / remove / exportOne / removeMany / exportMany 由入口层注入（都跨了别的分区）
// ⚠️ 卡片与世界书共用 ui/build.js 的 libraryCard()：两边只允许差在内容

import { el } from '../core/dom.js';
import { h, libraryAddCard, libraryCard, renderListPage } from '../ui/build.js';
import { mButton } from '../components/index.js';
import { entityTone } from '../ui/avatarTone.js';
import { openLightbox } from '../ui/lightbox.js';
import { characters, characterPortrait, characterWorldbooks } from '../data/library.js';
import { createBatchSelect } from './batchSelect.js';

let actions = {
  edit: () => {},
  chat: () => {},
  playWorld: () => {},
  remove: () => {},
  exportOne: null,
  removeMany: null,
  exportMany: null
};
let query = '';
let batch = null;

const EMPTY_TITLE = '还没有角色';
const EMPTY_HINT = '点右上角「导入角色卡」选一张酒馆的 PNG / JSON 卡，或者点「＋ 新建角色」自己写一个。';

// 三处共用同一种说法，别一边写「酒馆卡」一边写「PNG」
function sourceText(character) {
  return character.source === 'png' ? '酒馆角色卡' : character.source === 'json' ? 'JSON 角色卡' : '手写';
}

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
  actions = { edit: () => {}, chat: () => {}, playWorld: () => {}, remove: () => {}, ...(injected || {}) };
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
    onExport: (ids) => (actions.exportMany ? actions.exportMany(ids) : null),
    onDelete: (ids) => (actions.removeMany ? actions.removeMany(ids) : false)
  });
}

export function renderCharacterPage() {
  const all = characters();
  const needle = query.trim().toLocaleLowerCase();
  const list = all.filter((character) => matchesQuery(character, needle));

  // 全选只作用于当前筛选出来的这一批
  if (batch) batch.setVisible(list.map((character) => character.id));

  renderListPage({
    grid: el.charPageGrid,
    empty: el.charPageEmpty,
    sub: el.charsPageSub,
    subText: all.length
      ? `共 ${all.length} 个角色 · 点「聊天」先定好你是谁，再开始`
      : '导入酒馆角色卡，或自己写一个',
    items: list,
    card: characterCard,
    // 末尾那张「添加卡」：空列表有专门的大提示，不重复；批量选择态整卡是勾选框，也不给
    addCard: list.length && !(batch && batch.isActive()) ? characterAddCard() : null
  });

  if (el.charPageCount) {
    el.charPageCount.textContent = needle ? `${list.length} / ${all.length} 个角色` : `${all.length} 个角色`;
  }

  // 搜不到时不能再提示「去导入一张卡」
  const emptyTitle = el.charPageEmpty && el.charPageEmpty.querySelector('.page-empty-title');
  const emptyHint = el.charPageEmpty && el.charPageEmpty.querySelector('.page-empty-hint');
  const searching = !!needle && all.length > 0;
  if (emptyTitle) emptyTitle.textContent = searching ? '没有匹配的角色' : EMPTY_TITLE;
  if (emptyHint) emptyHint.textContent = searching ? '换个关键词再试，或者清空搜索框。' : EMPTY_HINT;
}

/**
 * 网格末尾那张「添加角色」卡（2026-10-20）：把页头右上角那三颗搬到手边。
 * 点击**转发**到页头那颗按钮的 click —— 业务只在原来那处写一遍，两边永远同步；
 * 以后谁给页头那颗加了 loading / 禁用，这张卡上的也跟着走。
 */
function characterAddCard() {
  const forward = (btn) => () => btn && btn.click();
  return libraryAddCard({
    actions: [
      mButton({ variant: 'ghost', size: 'sm', block: true, text: '导入角色卡', onClick: forward(el.btnImportCard) }),
      mButton({ variant: 'ghost', size: 'sm', block: true, text: 'AI 生成', onClick: forward(el.btnAiChar) }),
      mButton({ variant: 'primary', size: 'sm', block: true, text: '＋ 新建角色', onClick: forward(el.btnNewChar) })
    ]
  });
}

function characterCard(c) {
  const subBits = [sourceText(c)];
  for (const tag of (Array.isArray(c.tags) ? c.tags : []).slice(0, 3)) {
    if (String(tag).trim()) subBits.push(String(tag).trim());
  }
  const subText = subBits.join(' · ');

  // 铺 2:3 立绘不铺头像（小圆图铺开会糊）；老卡由 characterPortrait 用头像顶上
  const portrait = characterPortrait(c);

  // 自带世界书的卡多一条入口：进 TA 的世界（不带书就整颗不渲染）
  const books = characterWorldbooks(c);
  const bookNames = books.map((book) => book.name).join('、');
  const worldButton = books.length
    ? h('button', {
        type: 'button',
        class: 'char-card-world',
        text: '进入世界',
        title: books.length === 1 ? `进入「${bookNames}」` : `进入 TA 的世界（${books.length} 本：${bookNames}）`,
        'aria-label': `进入「${c.name}」的世界`,
        onclick: (event) => {
          // 选择态下整卡是勾选框，这一下不该连带勾选（CSS 里已经藏了，双保险）
          event.stopPropagation();
          actions.playWorld(c.id);
        }
      })
    : null;

  return libraryCard({
    title: c.name,
    sub: subText,
    media: portrait ? h('img', { src: portrait, alt: '' }) : String(c.name || '').slice(0, 1) || '?',
    mediaClass: ['art-edge', entityTone(c.id, c.name)],
    mediaTitle: `${c.name} · 点开看大图`,
    onMediaClick: portrait ? () => openLightbox(portrait, { title: c.name }) : null,
    coverExtra: worldButton,
    // ⚠️ 图标按钮：外形全靠 .char-card-del，套 m-button 会多一层壳
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
      // 不用进详情页就能把这张卡拿走；和批量导出同一条 PNG/JSON 通道
      actions.exportOne
        ? mButton({
            variant: 'ghost',
            size: 'sm',
            text: '导出',
            title: '导出这张角色卡（PNG / JSON）',
            onClick: () => actions.exportOne(c.id)
          })
        : null,
      mButton({ variant: 'primary', size: 'sm', text: '聊天', onClick: () => actions.chat(c.id) })
    ],
    selecting: !!(batch && batch.isActive()),
    selected: !!(batch && batch.has(c.id)),
    onSelect: () => batch && batch.toggle(c.id)
  });
}
