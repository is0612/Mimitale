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
//  重绘入口是 renderCharacterPage()，由 views/viewSwitch.js 在
//  「当前正停在角色页」时调用（那个分发要读 currentView）。
// ============================================================================

import { el } from '../core/dom.js';
import { card, h, renderListPage } from '../ui/build.js';
// 组件库：卡片上「编辑 / 聊天」是通用按钮，走工厂建 m-button（见 components/index.js）
import { mButton } from '../components/index.js';
import { entityTone } from '../ui/avatarTone.js';
import { openLightbox } from '../ui/lightbox.js';
import { characters, characterPortrait } from '../data/library.js';

let actions = { edit: () => {}, chat: () => {}, remove: () => {} };

export function initCharacterList(injected) {
  actions = { edit: () => {}, chat: () => {}, remove: () => {}, ...(injected || {}) };
}

export function renderCharacterPage() {
  const list = characters();
  renderListPage({
    grid: el.charPageGrid,
    empty: el.charPageEmpty,
    sub: el.charsPageSub,
    subText: list.length
      ? `共 ${list.length} 个角色 · 点「聊天」先定好你是谁，再开始`
      : '导入酒馆角色卡，或自己写一个',
    items: list,
    card: characterCard
  });
}

/** 一张角色卡：角色形象 + 名字 + 来源 + 编辑/聊天，右上角悬停浮出删除 */
function characterCard(c) {
  // 来源 + 分类标签挤在同一行：卡片高度不变，标签也不会把卡片撑得参差不齐。
  // 标签是「这张卡属于什么类型」（作品/风格/用途），只显示前几个，多了省略。
  const subBits = [c.source === 'png' ? '酒馆角色卡' : c.source === 'json' ? 'JSON 角色卡' : '手写'];
  for (const tag of (Array.isArray(c.tags) ? c.tags : []).slice(0, 3)) {
    if (String(tag).trim()) subBits.push(String(tag).trim());
  }
  const subText = subBits.join(' · ');

  // 卡上铺的是**角色形象**（2:3 立绘），不是头像 —— 头像那么小的圆图铺在这块
  // 会糊成一片。老卡没单独设过形象，characterPortrait 会用头像顶上。
  const portrait = characterPortrait(c);

  return card({
    title: c.name,
    sub: subText,
    avatar: portrait,
    avatarText: c.name.slice(0, 1),
    // 渐变圆 + 白字（设计稿的 .kface）：和侧栏 / 在场角色栏 / 消息区共用同一套色板，
    // 同一个角色在哪一屏都是同一个颜色。
    avatarClass: entityTone(c.id, c.name),
    // 点形象看大图。没有图时那块是首字色块，点了也没东西可看，索性不接。
    mediaTitle: `${c.name} · 点开看大图`,
    onMediaClick: portrait ? () => openLightbox(portrait, { title: c.name }) : null,
    // 删除：静止时是透明的，鼠标移上来才浮出来 —— 跟左侧会话列表的 × 同一套。
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
    ]
  });
}
