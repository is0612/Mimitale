'use strict';

// data/conversations.js —— 会话的「出生」：新建一个、或从某条消息分出一条
// 只做纯逻辑（拼对象、塞进 state、落盘），不碰 DOM、不重绘 —— 长什么样、放哪一行是 views/ 的事。
// 「分支」= 另开一个会话、把前 N 条原样复制过去，不是真正的消息树：当前会话一个字节都不动。

import { state } from '../core/state.js';
import { uid, now } from '../core/util.js';
import { convoDialoguePresetIds } from './library.js';
import { convoPanel, convoPanelDefs, convoPanelFields } from './panel.js';
import {
  DEFAULT_NARRATION_MODE,
  DEFAULT_PACE_MODE,
  convoNarrationMode,
  convoPaceMode
} from './narration.js';
import { persistConversations } from './persist.js';

/**
 * 新建一个会话并（默认）切过去。⚠️ 不继承上一个会话的角色：建出来就是「还没选角色」的空白会话，绑角色走 applyCharacterChoice。
 */
export function createConvo(activate) {
  const convo = {
    id: uid(),
    title: '新对话',
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    characterId: null,
    // 会话绑的预设（可挂多条）：null = 没配过 → 自动带所有「可全局」的；[] = 显式一条都不用 → 真不注入、不回落全局。
    dialoguePresetIds: null,
    // 状态面板：fields = 字段顺序，panel = 当前值，panelDefs = 类型/范围/变化规则（可选）。
    // ⚠️ panelManual 记「哪些字段是玩家手动改过的」—— AI 每轮重发状态栏，不记的话手改的值下轮就被顶掉。
    panel: {},
    panelFields: [],
    panelDefs: {},
    panelManual: {},
    // 剧情选项：options = 这轮的可点选项（点完就清），optionsSpec = 每轮给几个 + 额外要求。
    // 跟**对话框**走、和角色无关（在视角设置里配）；新会话默认开 4 条，关掉存 false。
    // count 默认 4 须和 suggestions.js 的 DEFAULT_OPTIONS_COUNT 对齐。
    options: [],
    optionsSpec: { count: 4, hint: '' },
    // 视角设置：叙述模式、推进节奏；gmMode 是「世界模式」的落盘记录。
    // ⚠️ 纯聊天用不上前两个档（见 data/messages.js 文件头），但仍写默认值：绑上卡之后直接可用。
    // gmMode 建出来是 false，「＋ 新对话」= 单纯聊天；绑卡开局会写 true（isGmMode 也认「有卡即 GM」）。
    narrationMode: DEFAULT_NARRATION_MODE,
    // 默认「一步一步」：不这样的话模型会一口气把整场戏演完，玩家只剩看的份
    paceMode: DEFAULT_PACE_MODE,
    gmMode: false,
    // 分段记忆摘要：每段 { id, title, text, start, end, at }
    summaries: []
  };
  state.conversations.unshift(convo);
  if (activate !== false) state.activeId = convo.id;
  persistConversations(0);
  return convo;
}

/** 从某条消息分出一条新线的「骨架」：前 cut 条消息及其戏本身的东西照搬过去。只拼对象、不落盘、不切会话 */
export function branchSkeleton(convo, cut) {
  return {
    id: uid(),
    title: `${convo.title || '新对话'}（分支）`,
    createdAt: now(),
    updatedAt: now(),
    // 戏本身的东西照搬：绑的角色、预设、玩家、状态面板、视角设置
    // （世界书不是会话的东西 —— 它跟着卡走，分叉自然跟着卡）
    characterId: convo.characterId || null,
    // 分叉出来的新会话算「已配过」：照搬原会话的选择（含 null=跟随全局）
    dialoguePresetIds: (() => {
      const ids = convoDialoguePresetIds(convo);
      return ids === null ? null : [...ids];
    })(),
    gmMode: convo.gmMode === true,
    // ⚠️ 视角设置也要照搬：不照搬的话，从「上帝视角 + 快节奏」分出来的新线会悄悄变回「标准 + 一步一步」，且不报任何错。
    narrationMode: convoNarrationMode(convo),
    paceMode: convoPaceMode(convo),
    player: convo.player ? { ...convo.player } : null,
    panelFields: [...convoPanelFields(convo)],
    panel: { ...convoPanel(convo) },
    // 字段的范围/hint 也要跟着分叉走，否则新线的数值从此不再受约束
    panelDefs: JSON.parse(JSON.stringify(convoPanelDefs(convo))),
    // 「手改过」的标记也跟着走 —— 新线里那些手改的值同样不该被 AI 顶掉
    panelManual: { ...(convo.panelManual || {}) },
    // 剧情选项配置跟着走（false = 关也要原样带过去）；这一轮的选项本身不搬（新线还没生成过）
    optionsSpec: convo.optionsSpec ? { ...convo.optionsSpec } : false,
    options: [],
    messages: JSON.parse(JSON.stringify(convo.messages.slice(0, cut))),
    // 摘要不搬：它压的是「最早那批消息」，而新会话里这批是原样留着的，搬过去等于同一段被记两遍。
    summaries: [],
    checkpoints: []
  };
}
