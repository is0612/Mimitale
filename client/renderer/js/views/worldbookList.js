//  世界书列表页：世界书是「一个世界」，点「游玩」进入，进去前先创建自己的角色。
//  ⚠️ 打开编辑器 / 删除由入口层注入（跨视图编排，本模块不必反向 import 编辑器）。
//  重绘入口 renderWorldbookPage()，由入口层在「当前正停在世界书页」时调用。

import { el } from '../core/dom.js';
import { h, libraryCard, renderListPage } from '../ui/build.js';
import { mButton } from '../components/index.js';
import { openLightbox } from '../ui/lightbox.js';
import { worldbooks, worldbookCharacters, worldbookCover } from '../data/library.js';
import { openPlayerModal } from './player.js';
import { createBatchSelect } from './batchSelect.js';

/** 打开世界书编辑器（入口层注入，见文件头说明） */
let openEditor = () => {};
/** 删掉一本书（入口层注入，和角色卡右上角那个 × 同一套路） */
let removeBook = () => {};
/** 批量：删几本 / 导出几本。同样跨模块（要切走编辑器、解绑会话），由入口层注入 */
let removeBooks = null;
let exportBooks = null;
/** 批量选择状态机（initWorldbookList 里建） */
let batch = null;
let query = '';

const EMPTY_TITLE = '还没有世界书';
const EMPTY_HINT = '点右上角「导入世界书」选一个酒馆的 lorebook JSON，或者点「＋ 新建世界书」自己写一个世界。';

/** 这本书匹不匹配搜索词（书名 / 条目名 / 关键词都算） */
function matchesQuery(book, needle) {
  if (!needle) return true;
  const entries = Array.isArray(book.entries) ? book.entries : [];
  return [
    book.name,
    ...entries.flatMap((entry) => [entry.title, ...(Array.isArray(entry.keys) ? entry.keys : [])])
  ].join(' ').toLocaleLowerCase().includes(needle);
}

export function initWorldbookList({ openEditor: fn, remove: removeFn, removeMany, exportMany } = {}) {
  if (typeof fn === 'function') openEditor = fn;
  if (typeof removeFn === 'function') removeBook = removeFn;
  if (typeof removeMany === 'function') removeBooks = removeMany;
  if (typeof exportMany === 'function') exportBooks = exportMany;
  if (el.wbPageSearch) {
    el.wbPageSearch.addEventListener('input', (event) => {
      query = event.target.value;
      renderWorldbookPage();
    });
  }

  batch = createBatchSelect({
    nodes: {
      enter: el.btnWbBatch,
      normal: el.wbBatchNormal,
      active: el.wbBatchActive,
      count: el.wbBatchCount,
      selectAll: el.btnWbSelectAll,
      exportBtn: el.btnWbBatchExport,
      deleteBtn: el.btnWbBatchDelete,
      exit: el.btnWbBatchExit
    },
    unit: '本',
    onRender: renderWorldbookPage,
    onExport: (ids) => (exportBooks ? exportBooks(ids) : null),
    onDelete: (ids) => (removeBooks ? removeBooks(ids) : false)
  });
}

export function renderWorldbookPage() {
  const all = worldbooks();
  const needle = query.trim().toLocaleLowerCase();
  const list = all.filter((book) => matchesQuery(book, needle));

  // 全选只作用于当前筛选结果
  if (batch) batch.setVisible(list.map((book) => book.id));

  renderListPage({
    grid: el.wbPageGrid,
    empty: el.wbPageEmpty,
    sub: el.wbPageSub,
    subText: all.length
      ? `共 ${all.length} 个世界 · 点「游玩」进入，进去前先创建你自己的角色`
      : '导入酒馆的 lorebook，或自己写一个世界',
    items: list,
    card: worldbookCard
  });

  if (el.wbPageCount) {
    el.wbPageCount.textContent = needle ? `${list.length} / ${all.length} 个世界` : `${all.length} 个世界`;
  }

  const emptyTitle = el.wbPageEmpty && el.wbPageEmpty.querySelector('.page-empty-title');
  const emptyHint = el.wbPageEmpty && el.wbPageEmpty.querySelector('.page-empty-hint');
  const searching = !!needle && all.length > 0;
  if (emptyTitle) emptyTitle.textContent = searching ? '没有匹配的世界' : EMPTY_TITLE;
  if (emptyHint) emptyHint.textContent = searching ? '换个关键词再试，或者清空搜索框。' : EMPTY_HINT;
}

/** 一张世界书卡片。没封面退回「世」字占位块（深灰底）；封面可点开看大图（卡片上只有 ~220px 宽）。 */
function worldbookCard(book) {
  const charCount = worldbookCharacters(book).length;
  const cover = worldbookCover(book);
  const entryCount = Array.isArray(book.entries) ? book.entries.length : 0;

  return libraryCard({
    title: book.name,
    sub: charCount ? `${entryCount} 条设定 · ${charCount} 个角色` : `${entryCount} 条设定`,
    media: cover ? h('img', { src: cover, alt: '' }) : h('span', { class: 'wb-card-glyph', text: '世' }),
    mediaClass: 'wb-card-media',
    coverClass: cover ? '' : 'is-empty',
    mediaTitle: `${book.name} · 点开看大图`,
    onMediaClick: cover ? () => openLightbox(cover, { title: book.name }) : null,
    extra: h('button', {
      type: 'button',
      class: 'char-card-del',
      text: '×',
      title: '删除这个世界书',
      'aria-label': `删除世界书：${book.name}`,
      onclick: (event) => {
        event.stopPropagation();
        removeBook(book.id);
      }
    }),
    actions: [
      mButton({ variant: 'ghost', size: 'sm', text: '编辑', onClick: () => openEditor(book.id) }),
      mButton({ variant: 'primary', size: 'sm', text: '游玩', onClick: () => openPlayerModal(book.id) })
    ],
    // 批量选择态（同角色卡）：整卡可点、左侧勾选圈
    selecting: !!(batch && batch.isActive()),
    selected: !!(batch && batch.has(book.id)),
    onSelect: () => batch && batch.toggle(book.id)
  });
}
