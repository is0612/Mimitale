'use strict';

// ============================================================================
//  views/batchSelect.js —— 列表页的「批量」选择态
//
//  角色库和世界书列表页共用这一套状态机：点工具条上的「批量」进入选择态，
//  卡片左侧浮出勾选圈、整张卡点击 = 选中；工具条右侧换成
//  「已选 N 项 · 全选 · 导出 · 删除 · 取消」。退出选择态时清空。
//
//  几个刻意的约定：
//   · 选中集合按 **id** 存，**跨搜索保留** —— 先搜「女仆」勾几张、再搜「骑士」
//     勾几张，是批量删最常用的姿势。搜索框在选择态里照常能用。
//   · 「全选」只作用于**当前筛选结果**：看不见的卡片不该被一起选上，
//     否则用户以为自己选了 3 张，实际删了 30 张。
//   · 本模块只管选择与按钮，**导出 / 删除的具体做法由调用方注入** ——
//     角色库要解绑会话、世界书要切走编辑器，那些是跨模块编排（入口层的事）。
// ============================================================================

import { showToast } from '../ui/toast.js';

/**
 * @param {object} options
 * @param {object} options.nodes 工具条上的节点（见 core/dom.js 的 charBatch* / wbBatch*）
 * @param {() => void} options.onRender 选择态变化后重画列表（卡片要跟着变）
 * @param {(ids: string[]) => Promise<any>} options.onExport
 * @param {(ids: string[]) => Promise<boolean|any>} options.onDelete
 * @param {string} [options.unit] 「已选 N 项」里的量词（个角色 / 本世界书）
 */
export function createBatchSelect({ nodes, onRender, onExport, onDelete, unit = '项' }) {
  let active = false;
  const selected = new Set();
  let visibleIds = [];

  const paint = () => {
    if (!nodes) return;
    if (nodes.normal) nodes.normal.classList.toggle('hidden', active);
    if (nodes.active) nodes.active.classList.toggle('hidden', !active);

    const n = selected.size;
    if (nodes.count) nodes.count.textContent = `已选 ${n} ${unit}`;

    // 全选按钮的文案跟着「当前可见的是不是都选上了」变
    const allPicked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    if (nodes.selectAll) nodes.selectAll.textContent = allPicked ? '取消全选' : '全选';

    // 列表页要重画卡片（勾选圈 / 选中描边）
    if (typeof onRender === 'function') onRender();
  };

  const api = {
    isActive: () => active,

    has: (id) => active && selected.has(id),

    /** 每次列表重绘时告诉它「现在屏幕上看得见哪些」—— 只记录，不触发重绘 */
    setVisible(ids) {
      visibleIds = Array.isArray(ids) ? ids.slice() : [];
      // 选择态下「全选」的文案依赖可见集合，所以要补一次按钮文案（不重画列表）
      if (active && nodes && nodes.selectAll) {
        const allPicked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
        nodes.selectAll.textContent = allPicked ? '取消全选' : '全选';
      }
    },

    toggle(id) {
      if (!active || !id) return;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      paint();
    },

    ids: () => [...selected],

    exit() {
      if (!active) return;
      active = false;
      selected.clear();
      paint();
    },

    enter() {
      if (active) return;
      active = true;
      selected.clear();
      paint();
    }
  };

  if (nodes) {
    if (nodes.enter) nodes.enter.addEventListener('click', api.enter);
    if (nodes.exit) nodes.exit.addEventListener('click', api.exit);

    if (nodes.selectAll) {
      nodes.selectAll.addEventListener('click', () => {
        const allPicked = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
        if (allPicked) for (const id of visibleIds) selected.delete(id);
        else for (const id of visibleIds) selected.add(id);
        paint();
      });
    }

    if (nodes.exportBtn) {
      nodes.exportBtn.addEventListener('click', async () => {
        const ids = api.ids();
        if (!ids.length) {
          showToast('先勾选几项再导出', 'error');
          return;
        }
        const result = await onExport(ids);
        // 取消保存框（返回 null / canceled）时**留在选择态** —— 用户多半是想换个位置再导
        if (result) api.exit();
      });
    }

    if (nodes.deleteBtn) {
      nodes.deleteBtn.addEventListener('click', async () => {
        const ids = api.ids();
        if (!ids.length) {
          showToast('先勾选几项再删除', 'error');
          return;
        }
        const deleted = await onDelete(ids);
        if (deleted) api.exit();
      });
    }
  }

  return api;
}
