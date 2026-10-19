'use strict';

// ============================================================================
//  views/viewSwitch.js —— 主区域显示哪一屏
//
//  以前整个 main 只有聊天一屏，所有功能都靠弹窗盖在上面；
//  角色库 / 世界书 / 预设变成页面之后就需要这一层了。
//
//  它同时管两件相关的事：
//    · showView(name)        切屏（侧边栏高亮 + 隐藏另外几屏 + 必要时补画一次）
//    · refreshLibraryPage()  数据变了之后，若正停在那几个列表页就重画它
//  两件事都要读「现在在哪一屏」，所以放在一起 —— 那个状态不export，
//  外面只通过这几个函数跟它打交道。
//
//  （2026-10-09 补了一个只读的 currentViewName()：设置从弹窗改成页面之后，
//    views/settings.js 要「保存 / 返回时回到进来之前那一屏」，得先知道来处。）
//
//  它单向 import 那几个列表页（那些都不认识本模块），所以不构成循环。
//  ⚠️ 设置页**不**在这里 import：它的显隐虽然也归这张表管，但「切过去要先刷新
//     表单 / 记住来处」都在 views/settings.js 里，那边单向 import 本模块。
// ============================================================================

import { el } from '../core/dom.js';
import { characters, worldbooks, dialoguePresets } from '../data/library.js';
import { renderCharacterPage } from './characterList.js';
import { renderWorldbookPage } from './worldbookList.js';
import { renderPresetPage } from './presetList.js';

/** 当前主区域显示的是哪个视图 */
let currentView = 'chat';

const VIEWS = ['chat', 'chars', 'charEditor', 'worldbooks', 'wbEditor', 'presets', 'help', 'settings'];

/** 「哪一屏对应哪个容器、哪个侧栏按钮」—— 加视图只要往这张表里加一行 */
const VIEW_PARTS = [
  { name: 'chat', view: 'viewChat', btn: null },
  { name: 'chars', view: 'viewChars', btn: 'btnChars' },
  // 编辑器也是视图，只是侧边栏上没有自己那颗按钮 —— 它们是从角色库 / 世界书
  // 点卡片进来说的（2026-10-13 从弹窗改成页面，跟设置页一个路子）。
  { name: 'charEditor', view: 'viewCharEditor', btn: null },
  { name: 'worldbooks', view: 'viewWorldbooks', btn: 'btnWorldbooks' },
  { name: 'wbEditor', view: 'viewWbEditor', btn: null },
  { name: 'presets', view: 'viewPresets', btn: 'btnPresets' },
  // 设置页：内容是现成的，切过去之前**先由 views/settings.js 刷新**（它自己调
  // showView），这里只管显隐 + 把侧边栏那颗「设置」点亮。
  { name: 'settings', view: 'viewSettings', btn: 'btnSettings' }
];

/** 现在停在哪一屏（只读）。给设置页算「来处」用，别拿它去改视图 */
export function currentViewName() {
  return currentView;
}

/**
 * 侧栏三颗入口右边的数量。
 *
 * 数字就是各自列表的长度（角色卡 / 世界书 / 对话预设）——
 * ⚠️ 预设用 dialoguePresets()，别拿 state.presets（那是服务商的内置模板，另一回事）。
 * 收起态（56px 图标轨）整条藏掉，见 CSS 的 .sidebar.collapsed .foot-count。
 */
function renderFootCounts() {
  const parts = [
    [el.footCharsCount, characters().length],
    [el.footWorldbooksCount, worldbooks().length],
    [el.footPresetsCount, dialoguePresets().length]
  ];
  for (const [node, count] of parts) {
    if (node) node.textContent = String(count);
  }
}

export function showView(name) {
  if (!VIEWS.includes(name)) return;
  currentView = name;
  const app = el.viewChat?.closest('.app');
  if (app) app.dataset.view = name;

  for (const part of VIEW_PARTS) {
    const view = el[part.view];
    if (view) view.classList.toggle('hidden', name !== part.name);
    // 侧边栏那一项高亮，让人知道自己在哪个页面
    const btn = part.btn ? el[part.btn] : null;
    if (btn) btn.classList.toggle('active', name === part.name);
  }

  if (name === 'chars') renderCharacterPage();
  else if (name === 'worldbooks') renderWorldbookPage();
  else if (name === 'presets') renderPresetPage();
  // help 是静态页，切过去不用做任何事；只有回到聊天才把光标放回输入框
  else if (name === 'chat') el.input.focus();
  renderFootCounts();
}

/** 停在图书区那几个列表页时也要跟着刷新（改名、删除、导入都会走到这里） */
export function refreshLibraryPage() {
  if (currentView === 'chars') renderCharacterPage();
  else if (currentView === 'worldbooks') renderWorldbookPage();
  else if (currentView === 'presets') renderPresetPage();
  // 删 / 导入 / 新建都会改变数量，而这时可能根本没切屏
  renderFootCounts();
}

/** 侧边栏那几个入口（切屏属于本模块自己的事，自己绑） */
export function initViewSwitch() {
  // 角色库 → 切到角色列表页
  el.btnChars.addEventListener('click', () => showView('chars'));
  // 世界书 → 切到世界书列表页
  el.btnWorldbooks.addEventListener('click', () => showView('worldbooks'));
  // 预设 → 切到预设列表页
  if (el.btnPresets) el.btnPresets.addEventListener('click', () => showView('presets'));
}
