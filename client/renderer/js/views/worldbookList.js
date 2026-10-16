// ---------------------------------------------------------------------------
//  世界书列表页
//
//  世界书是「一个世界」：从这里点「游玩」进入，进去前先创建你自己的角色。
//  它不再是「给某个对话挂上去的设定」—— 绑到已经开始的对话上那套已经拿掉了。
//
//  这个文件只装**列表页本身**（卡片网格 + 两个按钮 + 右上角的删除 ×）。两处刻意的边界：
//
//   · 「点编辑 = 打开世界书编辑器」由入口层通过 initWorldbookList 注入。
//     那个动作要设 editingWorldbookId（编辑器弹窗的状态）并调
//     openWorldbooksModal（编辑器本体，还没拆），属于跨视图编排 ——
//     本模块若直接调，就得反过来 import 编辑器；入口层注入则两边都不用认识谁。
//     删除那一颗同理（它要一起解绑会话、收掉编辑器里的草稿）。
//
//   · 「点游玩 = 打开玩家角色弹窗」直接 import views/player.js。
//     这是**单向**依赖：player 只依赖 core 和 data 层、不认识任何视图
//     （它只是弹窗 + 一个 getPlayingBook），所以不构成循环。
//
//  重绘入口是 renderWorldbookPage()，由入口层的 refreshLibraryPage()
//  在「当前正停在世界书页」时调用（那个分发要读 currentView，属于入口层）。
//
//  ⚠️ 2026-10-14：卡片改成**封面铺满整卡**（封面 2:3 竖版），不再走 ui/build.js
//     的 `card()` —— 那个壳是「居中媒体位 + 名字 + 小字 + 按钮」竖排，给角色库
//     正合适（它上面那张图是 2:3 立绘、居中摆着就好看），但世界书要的是
//     「书名压在封面上」。两者结构不同，硬套只会让 card() 长出一堆开关。
// ---------------------------------------------------------------------------

import { el } from '../core/dom.js';
import { h, button, renderListPage } from '../ui/build.js';
import { mButton } from '../components/index.js';
import { openLightbox } from '../ui/lightbox.js';
import { worldbooks, worldbookCharacters, worldbookCover } from '../data/library.js';
import { openPlayerModal } from './player.js';

/** 打开世界书编辑器（入口层注入，见文件头说明） */
let openEditor = () => {};
/** 删掉一本书（入口层注入，和角色卡右上角那个 × 同一套路） */
let removeBook = () => {};

export function initWorldbookList({ openEditor: fn, remove: removeFn } = {}) {
  if (typeof fn === 'function') openEditor = fn;
  if (typeof removeFn === 'function') removeBook = removeFn;
}

export function renderWorldbookPage() {
  const list = worldbooks();
  renderListPage({
    grid: el.wbPageGrid,
    empty: el.wbPageEmpty,
    sub: el.wbPageSub,
    subText: list.length
      ? `共 ${list.length} 个世界 · 点「游玩」进入，进去前先创建你自己的角色`
      : '导入酒馆的 lorebook，或自己写一个世界',
    items: list,
    card: worldbookCard
  });
}

/**
 * 一张世界书卡片：**封面铺满整卡** + 书名压在封面底部 + 一行条数 + 编辑/游玩，
 * 右上角悬停浮出删除 ×。
 *
 * 没设封面的书退回「世」字占位块（深灰底，不是随机渐变色）——
 * 「一本书一个色」那套（entityTone）在 76px 的小方块上好看，铺成 2:3 的大色块
 * 就太吵了；而且没有封面的书本来就该安静，别让人误以为那是一张图。
 *
 * 封面能点开看大图（和角色库的形象一个路子）—— 卡片上只有 ~170px 宽，
 * 800×1200 的图缩得看不清细节。
 *
 * × 和角色卡那一颗是同一套（静止透明、悬停浮出、键盘 Tab 得到也能看见）。
 * 以前这里刻意没有 ×，理由是「一本书里攒了很多条目，删掉找不回来，
 * 所以删除入口只留在编辑器里」—— 但那样每次都得先点进去才删得掉，
 * 和角色库的手感不一致。现在两边一样，只是确认框里会把这本有多少条目、
 * 多少角色副本、还被几个会话用着都摆出来，再让人按「删除」。
 */
function worldbookCard(book) {
  const charCount = worldbookCharacters(book).length;
  const cover = worldbookCover(book);

  return h(
    'div',
    { class: 'char-card wb-card', role: 'listitem', title: book.name },
    button({
      class: 'char-card-del',
      text: '×',
      title: '删除这个世界书',
      ariaLabel: `删除世界书：${book.name}`,
      onClick: (event) => {
        event.stopPropagation();
        removeBook(book.id);
      }
    }),
    h(
      'div',
      { class: ['wb-card-cover', !cover && 'is-empty'] },
      cover
        ? h('img', { src: cover, alt: '', onclick: () => openLightbox(cover, { title: book.name }) })
        : h('span', { class: 'wb-card-glyph', text: '世' }),
      h('span', { class: 'wb-card-name', text: book.name })
    ),
    h('div', {
      class: 'wb-card-meta',
      text: charCount ? `${book.entries.length} 条设定 · ${charCount} 个角色` : `${book.entries.length} 条设定`
    }),
    h(
      'div',
      { class: 'wb-card-actions' },
      mButton({ variant: 'ghost', size: 'sm', text: '编辑', onClick: () => openEditor(book.id) }),
      mButton({ variant: 'primary', size: 'sm', text: '游玩', onClick: () => openPlayerModal(book.id) })
    )
  );
}
