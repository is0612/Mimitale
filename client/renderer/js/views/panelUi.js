'use strict';

// views/panelUi.js —— 右侧栏状态卡头像入口（本局有状态的角色）
// 字段的看和改全在状态卡里（views/stateCard.js）；「我」只在玩世界书时出现
// 解析 / 归一化 / 夹取 / 注入提示词都在 data/panel.js

import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { h, clear } from '../ui/build.js';
import { entityTone } from '../ui/avatarTone.js';
import { panelCastForDisplay } from '../data/cast.js';
import { onRefresh } from './refresh.js';
import { openStateCard } from './stateCard.js';

// 用显示版名单 panelCastForDisplay：普通聊天不列「我」
function renderPanelCast(entities) {
  const host = el.panelCast;
  if (!host) return;
  clear(host);

  // 标题上的「在场角色 N」也走这一份，两处各算一次迟早会不一致
  if (el.panelCastCount) el.panelCastCount.textContent = String(entities.length);

  for (const ent of entities) {
    const btn = h('button', {
      type: 'button',
      class: `panel-avatar ${entityTone(ent.owner, ent.name)}`,
      title: `查看「${ent.name}」的状态`,
      ariaLabel: `查看「${ent.name}」的状态`,
      onClick: () => openStateCard(ent.owner)
    });
    btn.dataset.owner = ent.owner;
    btn.dataset.kind = ent.kind;
    if (ent.avatar) btn.appendChild(h('img', { src: ent.avatar, alt: '' }));
    else btn.textContent = ent.owner === 'player' ? '我' : ent.name.slice(0, 1);
    host.appendChild(btn);
  }
}

// 空白会话 / 只剩「我」时整条收掉，别留一条空条占着
export function renderPanel() {
  const convo = activeConvo();
  const entities = convo ? panelCastForDisplay(convo) : [];

  el.panelBox.classList.toggle('hidden', !entities.length);
  // 入口条只有一行头像，不需要收起态
  el.panelBox.classList.remove('collapsed');
  renderPanelCast(entities);
}

// ⚠️ 由 main.js 的 registerRefreshListeners() 原位调用 —— 登记必须早于第一次广播
export function initPanelUi() {
  onRefresh(renderPanel);
}
