'use strict';

// views/characterList.js —— 角色列表页（卡片 + 批量选择）
// edit / chat / remove / removeMany / exportMany 由入口层注入（都跨了别的分区）
// ⚠️ 卡片与世界书共用 ui/build.js 的 libraryCard()：两边只允许差在内容

import { el } from '../core/dom.js';
import { h, libraryCard, renderListPage } from '../ui/build.js';
import { mButton } from '../components/index.js';
import { entityTone } from '../ui/avatarTone.js';
import { openLightbox } from '../ui/lightbox.js';
import { characters, characterPortrait } from '../data/library.js';
import { createBatchSelect } from './batchSelect.js';

let actions = { edit: () => {}, chat: () => {}, remove: () => {}, removeMany: null, exportMany: null };
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
    card: characterCard
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

function characterCard(c) {
  const subBits = [sourceText(c)];
  for (const tag of (Array.isArray(c.tags) ? c.tags : []).slice(0, 3)) {
    if (String(tag).trim()) subBits.push(String(tag).trim());
  }
  const subText = subBits.join(' · ');

  // 铺 2:3 立绘不铺头像（小圆图铺开会糊）；老卡由 characterPortrait 用头像顶上
  const portrait = characterPortrait(c);

  return libraryCard({
    title: c.name,
    sub: subText,
    media: portrait ? h('img', { src: portrait, alt: '' }) : String(c.name || '').slice(0, 1) || '?',
    mediaClass: ['art-edge', entityTone(c.id, c.name)],
    mediaTitle: `${c.name} · 点开看大图`,
    onMediaClick: portrait ? () => openLightbox(portrait, { title: c.name }) : null,
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
      mButton({ variant: 'primary', size: 'sm', text: '聊天', onClick: () => actions.chat(c.id) })
    ],
    selecting: !!(batch && batch.isActive()),
    selected: !!(batch && batch.has(c.id)),
    onSelect: () => batch && batch.toggle(c.id)
  });
}
