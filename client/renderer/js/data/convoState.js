'use strict';

// 删除/裁剪历史时显式重建；普通渲染仍使用 panel.js 的累积同步语义。
import {
  seedIdentity, seedPanelFromCharacters, mergePlayerOwnedFields,
  syncConvoPanel, syncPlayerNameFromPanel
} from './panel.js';
import { characterById, convoWorldbookIds, worldbookById, worldbookCharacters } from './library.js';
import { syncConvoOptions } from './suggestions.js';

// 只存在内存中，不污染持久化数据。新轮/重生/清空都能主动使旧选项请求失效。
const requestVersions = new WeakMap();
export function convoDerivedRequestVersion(convo) {
  return requestVersions.get(convo) || 0;
}
export function invalidateConvoDerivedRequests(convo) {
  if (convo) requestVersions.set(convo, convoDerivedRequestVersion(convo) + 1);
}

/**
 * 在修改 messages 之后调用；priorMessages 传入修改前快照，用于判断手改值是否已被覆盖。
 * 不落盘、不重绘、不修改消息/角色绑定；玩家显示名按重建后的面板同步。
 * 保留字段定义；动态值从当前绑定模板 + 剩余历史重建，不把被删值当初值。
 * clear=true 还重置手改值/标记。普通删除保留仍有效的手改值：若手改后已有
 * assistant 回复，现有值可能已被模型覆盖，无法恢复原手改值，退回模板/历史。
 */
export function rebuildConvoDerivedState(convo, { clear = false, priorMessages = convo && convo.messages } = {}) {
  if (!convo || !Array.isArray(convo.messages)) return false;
  invalidateConvoDerivedRequests(convo);
  const before = JSON.stringify([convo.panelFields, convo.panel, convo.panelDefs, convo.panelManual, convo.options]);
  const oldFields = Array.isArray(convo.panelFields) ? [...convo.panelFields] : [];
  const oldDefs = convo.panelDefs && typeof convo.panelDefs === 'object' ? convo.panelDefs : {};
  const oldPanel = convo.panel && typeof convo.panel === 'object' ? convo.panel : {};
  const oldManual = convo.panelManual && typeof convo.panelManual === 'object' ? convo.panelManual : {};
  const originalUpdatedAt = convo.updatedAt;
  const template = { ...convo, messages: [], panelFields: [], panel: {}, panelDefs: {}, panelManual: {} };
  const playerCard = convo.player && convo.player.characterId ? characterById(convo.player.characterId) : null;
  seedIdentity(template, convo.player && convo.player.name, 'player');
  if (playerCard) seedPanelFromCharacters(template, [playerCard], 'player');
  const bound = convo.characterId ? characterById(convo.characterId) : null;
  if (bound) {
    seedIdentity(template, bound.name, bound.id);
    seedPanelFromCharacters(template, [bound]);
  }
  for (const id of convoWorldbookIds(convo)) {
    const book = worldbookById(id);
    if (book) seedPanelFromCharacters(template, worldbookCharacters(book));
  }
  mergePlayerOwnedFields(template);

  convo.panelFields = [...new Set([...oldFields, ...template.panelFields])];
  convo.panelDefs = { ...template.panelDefs, ...oldDefs };
  convo.panel = { ...template.panel };
  convo.panelManual = {};
  if (!clear) {
    for (const key of Object.keys(oldManual)) {
      const editedAt = Number(oldManual[key]);
      // 没有原手改快照时，只保留确定尚未被后续回复覆盖的值。
      if (!Number.isFinite(editedAt) || editedAt <= 1) continue;
      if ((priorMessages || []).some((m) => m && m.role === 'assistant' && (!Number(m.at) || Number(m.at) > editedAt))) continue;
      if (oldPanel[key] !== undefined) {
        convo.panel[key] = oldPanel[key];
        convo.panelManual[key] = editedAt;
      }
    }
  }
  syncConvoPanel(convo);
  syncPlayerNameFromPanel(convo);
  // 同步选项的正常路径允许沿用上一批；回滚路径必须先丢掉被删轮次的缓存。
  convo.options = [];
  if (!clear) syncConvoOptions(convo);
  convo.updatedAt = originalUpdatedAt;
  return before !== JSON.stringify([convo.panelFields, convo.panel, convo.panelDefs, convo.panelManual, convo.options]);
}
