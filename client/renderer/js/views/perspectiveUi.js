'use strict';

//  views/perspectiveUi.js —— 视角设置弹窗（叙述模式 / 推进节奏 / GM / 预设），最终只往系统提示词拼一段文本。
//  改动即时生效 + 即时落盘，没有保存按钮，所以每次 change 都要顺手刷新头部。
//  单向 import header.js（header 只依赖数据层，不认识任何视图）。

import { el } from '../core/dom.js';
import { now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { h, clear } from '../ui/build.js';
import { persistConversations } from '../data/persist.js';
import {
  selectableDialoguePresets,
  convoDialoguePresetIds,
  globalDialoguePresets
} from '../data/library.js';
import {
  DEFAULT_NARRATION_MODE,
  DEFAULT_PACE_MODE,
  NARRATION_MODES,
  PACE_MODES,
  convoNarrationMode,
  convoPaceMode,
  isGmMode
} from '../data/narration.js';
import { isPlainChatConvo } from '../data/cast.js';
import { renderHeader } from './header.js';

/** 铺预设勾选列表。⚠️ `dialoguePresetIds` 为 null = 没手动配过（照全局预勾），动一格即转手动；已删 / 停用的 id 静默跳过，只留一行提示。 */
function fillPresetList(convo) {
  if (!el.pPresetList) return;
  clear(el.pPresetList);

  const list = selectableDialoguePresets();
  if (!list.length) {
    el.pPresetList.appendChild(
      h('p', { class: 'preset-pick-empty', text: '还没有预设。左侧「预设」页里新建。' })
    );
    return;
  }

  const picked = convoDialoguePresetIds(convo); // null = 没配过
  const auto = picked === null;
  const checked = new Set(auto ? globalDialoguePresets().map((p) => p.id) : picked);

  const alive = new Set(list.map((p) => p.id));
  const goneIds = auto ? [] : picked.filter((id) => !alive.has(id));

  for (const preset of list) {
    const row = h('label', { class: 'preset-pick-row' }, [
      h('input', {
        type: 'checkbox',
        class: 'preset-pick-box',
        'data-preset-id': preset.id,
        checked: checked.has(preset.id) ? 'checked' : null
      }),
      h('span', { class: 'preset-pick-text' }, [
        h('span', { class: 'preset-pick-name', text: preset.name }),
        preset.global
          ? h('span', { class: 'preset-pick-badge', text: '可全局' })
          : null
      ])
    ]);
    el.pPresetList.appendChild(row);
  }

  const note = h('span', {
    class: `preset-pick-state${auto ? '' : ' is-manual'}`,
    text: auto
      ? checked.size
        ? `跟随全局（自动带上了 ${checked.size} 条，改动任意一条就变成这一场专用）`
        : '跟随全局（当前没有「可全局」的预设）'
      : '这一场单独配置（不受全局预设影响）'
  });
  el.pPresetList.appendChild(note);

  if (goneIds.length) {
    el.pPresetList.appendChild(
      h('span', { class: 'preset-pick-gone', text: `有 ${goneIds.length} 条已删除或停用的预设被跳过` })
    );
  }
}

/** 一动手就转成「手动配过」。⚠️ 只在 initPerspectiveUi 里绑一次；挪回 fillPresetList 会开 N 次弹窗后点一下存 N 次盘。 */
function commitPresetChoice() {
  const convo = activeConvo();
  if (!convo) return;

  const boxes = Array.from(el.pPresetList.querySelectorAll('.preset-pick-box'));
  const ids = boxes.filter((box) => box.checked).map((box) => box.getAttribute('data-preset-id'));

  // 保留已删 / 已停用的 id：预设只是临时停用时，重新启用还能回来
  const alive = new Set(selectableDialoguePresets().map((p) => p.id));
  const kept = convoDialoguePresetIds(convo) || [];
  const goneIds = kept.filter((id) => !alive.has(id));

  writePresetSelection(convo, [...ids, ...goneIds]);

  // 状态说明跟着刷新（但不要重铺整个列表，否则点击时 DOM 被换掉、勾选会闪）
  const stateNote = el.pPresetList.querySelector('.preset-pick-state');
  if (stateNote) {
    stateNote.classList.add('is-manual');
    stateNote.textContent = ids.length
      ? '这一场单独配置（不受全局预设影响）'
      : '这一场单独配置：一条都不用';
  }
}

/** 把勾选结果写回会话并落盘 */
function writePresetSelection(convo, ids) {
  convo.dialoguePresetIds = Array.isArray(ids) ? ids : null;
  convo.updatedAt = now();
  renderHeader();
  persistConversations(0);
}

function openPerspectiveModal() {
  const convo = activeConvo();
  if (!convo) {
    showToast('当前没有会话', 'error');
    return;
  }

  // ⚠️ 纯聊天（没绑角色卡、也不是世界模式）没有叙述模式 / 推进节奏这回事：
  //    留着才是 bug —— 能选、能存、顶栏还显示标签，对模型却一个字都不影响。
  const plain = isPlainChatConvo(convo);

  el.pNarration.value = convoNarrationMode(convo);
  el.pPace.value = convoPaceMode(convo);
  el.pGm.checked = isGmMode(convo);
  setFieldVisible(el.pNarration, !plain);
  setFieldVisible(el.pPace, !plain);
  fillPresetList(convo);

  el.perspectiveModal.classList.remove('hidden');
}

/** 显示 / 隐藏控件所在的**整组**（`label.field`）。 */
function setFieldVisible(input, visible) {
  const field = input && typeof input.closest === 'function' ? input.closest('.field') : null;
  if (field) field.classList.toggle('hidden', !visible);
}

/** 关视角弹窗。导出是为了让入口层的 Esc 链统一关它（见 main.js） */
export function closePerspectiveModal() {
  el.perspectiveModal.classList.add('hidden');
  el.input.focus();
}

/** 把面板里的设置写回会话；即时生效、即时保存 */
function applyPerspectiveFromForm() {
  const convo = activeConvo();
  if (!convo) return;

  const mode = el.pNarration.value;
  convo.narrationMode = Object.prototype.hasOwnProperty.call(NARRATION_MODES, mode) ? mode : DEFAULT_NARRATION_MODE;

  const pace = el.pPace.value;
  convo.paceMode = Object.prototype.hasOwnProperty.call(PACE_MODES, pace) ? pace : DEFAULT_PACE_MODE;

  convo.gmMode = el.pGm.checked;

  convo.updatedAt = now();

  renderHeader();
  persistConversations(0);
}

/** 事件绑定（在 init() 里调用） */
export function initPerspectiveUi() {
  el.btnPerspective.addEventListener('click', openPerspectiveModal);
  el.btnClosePerspective.addEventListener('click', closePerspectiveModal);
  el.btnClosePerspective2.addEventListener('click', closePerspectiveModal);
  el.perspectiveModal.addEventListener('click', (event) => {
    if (event.target === el.perspectiveModal) closePerspectiveModal();
  });
  el.pNarration.addEventListener('change', applyPerspectiveFromForm);
  el.pPace.addEventListener('change', applyPerspectiveFromForm);
  el.pGm.addEventListener('change', applyPerspectiveFromForm);
  // 预设列表的勾选自己管落盘 —— 只在这里绑一次（见 commitPresetChoice 上的注释）
  el.pPresetList.addEventListener('change', commitPresetChoice);
}

