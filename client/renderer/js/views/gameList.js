'use strict';

// views/gameList.js —— 游戏卡列表页
// 2026-10-25 起：先复制角色卡列表页的布局，编辑器 / 数据模型 / 增删改后续再接。
// 现阶段只有一个空态 + 三个占位按钮（点了给一句「还在搭」）。

import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';

const NOT_READY = '游戏卡还在搭，先看看布局';

export function initGameList() {
  if (el.gamePageSearch) {
    el.gamePageSearch.addEventListener('input', renderGamePage);
  }
  // 页头三颗按钮现阶段只是占位：点了给个反馈，别看着像坏掉
  for (const btn of [el.btnNewGame, el.btnImportGame, el.btnAiGame]) {
    if (btn) btn.addEventListener('click', () => showToast(NOT_READY, 'info'));
  }
}

export function renderGamePage() {
  // 还没有游戏数据：网格清空、空态显示、计数归零
  if (el.gamePageGrid) el.gamePageGrid.replaceChildren();
  if (el.gamePageEmpty) el.gamePageEmpty.classList.remove('hidden');
  if (el.gamePageCount) el.gamePageCount.textContent = '0 个游戏';
  if (el.gamesPageSub) el.gamesPageSub.textContent = '一个可玩的游戏或剧本，进对话开玩';
}
