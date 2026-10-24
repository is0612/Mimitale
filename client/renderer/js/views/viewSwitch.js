'use strict';

// views/viewSwitch.js —— 主区域显示哪一屏
// 它单向 import 那几个列表页（那些都不认识本模块）
// ⚠️ 设置页不在这里 import：那边单向 import 本模块

import { el } from '../core/dom.js';
import { characters, dialoguePresets } from '../data/library.js';
import { renderCharacterPage } from './characterList.js';
import { renderPresetPage } from './presetList.js';

let currentView = 'chat';

const VIEWS = ['chat', 'chars', 'charEditor', 'wbEditor', 'presets', 'settings'];

const VIEW_PARTS = [
  { name: 'chat', view: 'viewChat', btn: null },
  { name: 'chars', view: 'viewChars', btn: 'btnChars' },
  { name: 'charEditor', view: 'viewCharEditor', btn: null },
  { name: 'wbEditor', view: 'viewWbEditor', btn: null },
  { name: 'presets', view: 'viewPresets', btn: 'btnPresets' },
  // 切换之前先由 views/settings.js 刷新；设置没有侧栏按钮（入口在账号菜单里）
  { name: 'settings', view: 'viewSettings', btn: null }
];

// 只读：别拿它去改视图
export function currentViewName() {
  return currentView;
}

// ⚠️ 预设用 dialoguePresets()，别拿 state.presets（那是服务商的内置模板）
// 收起态整条藏掉，见 CSS 的 .sidebar.collapsed .foot-count
function renderFootCounts() {
  const parts = [
    [el.footCharsCount, characters().length],
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
    const btn = part.btn ? el[part.btn] : null;
    if (btn) btn.classList.toggle('active', name === part.name);
  }

  if (name === 'chars') renderCharacterPage();
  else if (name === 'presets') renderPresetPage();
  else if (name === 'chat') el.input.focus();
  renderFootCounts();
}

export function refreshLibraryPage() {
  if (currentView === 'chars') renderCharacterPage();
  else if (currentView === 'presets') renderPresetPage();
  // 数量变了但没切屏时也要更新
  renderFootCounts();
}

export function initViewSwitch() {
  el.btnChars.addEventListener('click', () => showView('chars'));
  if (el.btnPresets) el.btnPresets.addEventListener('click', () => showView('presets'));
}
