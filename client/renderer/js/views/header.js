'use strict';

// ============================================================================
//  views/header.js —— 对话头部（标题 / 元信息 / 提示 / 用量）
//
//  头部那行 Meta 是「当前这一局到底怎么跑的」的唯一汇总处，只读不写：
//    · 绑的角色 + 实际会用的服务商 / 模型
//    · 这一局真正生效的世界书，并标出来源（会话绑的 / 角色自带的 / 被谁顶了）
//    · 视角（GM、叙述模式、推进节奏），但只在偏离默认时才占位 ——
//      纯聊天（「＋ 新对话」）没有叙述模式 / 推进节奏这回事，一个标签都不显示
//    · 记忆压了几段 / 正在压
//  所以它谁都不依赖，只依赖数据层 —— 也因此是「视角设置」「记忆」这些
//  改了设置后想刷新头部的地方可以放心 import 的模块（单向，头部不认识任何视图）。
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { h } from '../ui/build.js';
import { entityTone } from '../ui/avatarTone.js';
import { currentEndpoint } from '../data/providers.js';
import { characterForConvo, convoWorldbookIds, worldbookById } from '../data/library.js';
import {
  convoPanel,
  convoPanelDef,
  convoPanelFields,
  panelFieldName,
  panelFieldOwner
} from '../data/panel.js';
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
import { convoSummaries } from '../data/memory.js';
import { onRefresh } from './refresh.js';

// ---------------------------------------------------------------------------
//  顶栏头像 + 胶囊
// ---------------------------------------------------------------------------

/**
 * 顶栏左边那颗头像：这一屏是在跟谁聊。
 *
 * 三种情形和侧栏条目、在场角色栏保持同一套判断：
 *   绑了角色 → 角色头像 / 名字首字（圆）
 *   世界书会话 → 书名首字（**方角**，形状本身就是分类）
 *   都没有 → 中性点
 *
 * 底色统一从 `entityTone` 取（名字哈希）—— 同一个角色在侧栏、消息区、
 * 右栏、顶栏四处都是同一个颜色，这是「同一个人」最便宜的视觉线索。
 */
function renderTopbarAvatar(convo, character) {
  const host = el.topbarAvatar;
  if (!host) return;

  host.className = 'topbar-avatar';
  host.textContent = '';

  if (character) {
    host.classList.add(entityTone(character.id, character.name));
    if (character.avatar) host.appendChild(h('img', { src: character.avatar, alt: '' }));
    else host.textContent = character.name.slice(0, 1);
    return;
  }

  const wbId = convoWorldbookIds(convo)[0] || '';
  const wb = wbId ? worldbookById(wbId) : null;
  if (wb) {
    host.classList.add('book', entityTone(wb.id, wb.name));
    host.textContent = wb.name.slice(0, 1);
    return;
  }

  host.classList.add('plain');
  host.textContent = convo ? '书' : '·';
}

/**
 * 找绑定角色身上第一个**有范围的数值字段**，做成「好感 41」这种一行字。
 * 只服务顶栏那颗胶囊 —— 不开状态卡也能看见最要紧的那个数。
 * 找不到（没绑角色 / 没有数值字段 / 值为空）就返回空串，胶囊整个不显示。
 */
function charMeterLabel(convo, character) {
  if (!convo || !character || !character.id) return '';
  const panel = convoPanel(convo);
  const keys = convoPanelFields(convo).filter((key) => panelFieldOwner(convo, key) === character.id);
  for (const key of keys) {
    const def = convoPanelDef(convo, key);
    if (!def || def.type !== 'meter') continue;
    const value = panel[key];
    if (value == null || String(value).trim() === '') continue;
    return `${panelFieldName(key)} ${String(value).trim()}`;
  }
  return '';
}

/**
 * 元信息行最后那一段：这次发出去用了多少上下文（`6.2k`）。
 *
 * ⚠️ 设计稿画的是 `6.2k / 128k` 这种「已用 / 上限」，但**上限现在没有数据源** ——
 * 项目里没有「模型的上下文窗口」这个配置项（settings 里的 maxTokens 是**输出**上限，
 * 不是上下文窗口）。宁可不显示，也不要拿错数凑一个好看的比值：
 * 显示成 `6.2k / 8.2k` 会把「输出上限」误当成「窗口」。
 * 真要带上限，得先在模型配置里加一项上下文窗口。
 */
function contextUsedLabel() {
  const usage = state.usage;
  if (!usage) return '';
  const n = Number(usage.prompt_tokens);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function renderHeader() {
  const convo = activeConvo();
  const settings = state.settings || {};
  el.convoTitle.textContent = (convo && convo.title) || '新对话';

  const endpoint = currentEndpoint();
  const character = characterForConvo(convo);
  renderTopbarAvatar(convo, character);
  const prefix = character ? `${character.name} · ` : '';

  if (!endpoint) {
    el.convoMeta.textContent = '还没有配置模型服务 —— 点左下角「设置」';
  } else if (!endpoint.provider.apiKey) {
    el.convoMeta.textContent = `${prefix}还没有填「${endpoint.provider.name}」的 API Key —— 点左下角「设置」`;
  } else {
    // 元信息行的构成（设计稿：`谢临舟 · deepseek-flash · 第 12 轮 · 6.2k / 128k`）。
    // ⚠️ 这里**不放世界书**了 —— 2026-10-12 挪到右侧在场角色面板的脚注
    //    （设计稿指定的位置，见 views/castPanel.js），腾出来的位置给轮数和用量。
    const bits = [];
    if (character) bits.push(character.name);
    bits.push(endpoint.model || '未选模型');
    // ⚠️ 「第 N 轮」是**轮数**，不是消息条数 —— 本项目自己的口径是
    //    「一轮 = 一问一答 = 2 条」（见 data/memory.js 的 SUMMARY_TRIGGER_MESSAGES 注释）。
    //    原来直接把 messages.length 当轮数，于是聊了 12 个来回会显示「第 24 轮」，
    //    跟设计稿的「第 12 轮」差一倍。
    //    ⚠️ dateSeparator（views/chatMessages.js）用的是同一个口径，两处要一起改。
    const rounds = convo && Array.isArray(convo.messages) ? Math.ceil(convo.messages.length / 2) : 0;
    if (rounds) bits.push(`第 ${rounds} 轮`);
    const used = contextUsedLabel();
    if (used) bits.push(used);
    el.convoMeta.textContent = bits.join(' · ');
  }

  // 世界书：**常规信息**（这一局绑了哪几本、角色自带哪本）现在显示在右侧
  // 在场角色面板的脚注里（设计稿指定的位置，见 views/castPanel.js）。
  // 这里只留**异常提示** —— 「角色自带的书这次不生效」这种事必须说出来，
  // 不能让它悄悄失效；而且那层解释塞不进脚注那一行。
  const convoBookIds = convoWorldbookIds(convo);
  const convoBooks = convoBookIds.map((id) => worldbookById(id)).filter(Boolean);
  const charBookIds = character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [];
  const charBooks = charBookIds.map((id) => worldbookById(id)).filter(Boolean);

  if (convoBooks.length && charBooks.length) {
    el.convoMeta.textContent +=
      character.worldbookEnabled === false
        ? ' · 角色自带的书已关掉'
        : ' · 角色自带的书不生效（世界优先）';
  } else if (!convoBooks.length && charBooks.length && character.worldbookEnabled === false) {
    el.convoMeta.textContent += ` · 自带世界书 ${charBooks.map((b) => b.name).join('、')}（已关掉）`;
  }

  // 视角：只在偏离默认（标准 + 一步一步 + 非 GM）时提示。
  // 2026-09-30 从 meta 那行文字里搬到了标题旁边的**小胶囊**（设计稿的 .pill-tag）——
  // 「这一局怎么跑的」和标题同级，混在服务商/模型那串信息里根本挑不出来。
  //
  // ⛔ 2026-10-13：纯聊天（「＋ 新对话」）**一个标签都不显示**。那两项对纯聊天已经
  //    完全不生效（提示词不注入、视角弹窗里也不给，见 data/messages.js 文件头），
  //    挂个「上帝视角」出来等于撒谎。
  const viewTags = [];
  if (isGmMode(convo)) viewTags.push('GM 模式');
  if (!isPlainChatConvo(convo)) {
    const narrationMode = convoNarrationMode(convo);
    if (narrationMode !== DEFAULT_NARRATION_MODE) viewTags.push(NARRATION_MODES[narrationMode].label);
    const paceMode = convoPaceMode(convo);
    if (paceMode !== DEFAULT_PACE_MODE) viewTags.push(PACE_MODES[paceMode].label);
  }

  // 胶囊的优先级：视角偏离 > 绑定角色身上第一个数值字段 > 不显示。
  // 视角排前面，因为它决定 AI 怎么说话（比某个数值更该被一眼看见）；
  // 都没有就整个收起来，不留一颗空胶囊占位置。
  const pillText = viewTags.join(' + ') || charMeterLabel(convo, character);
  if (el.convoPill) {
    el.convoPill.textContent = pillText;
    el.convoPill.classList.toggle('hidden', !pillText);
  }

  // 记忆：正在压缩时给个提示，压缩完显示覆盖了多少条
  const segCount = convoSummaries(convo).length;
  if (convo && convo.summaryBusy) el.convoMeta.textContent += ' · 正在整理记忆…';
  else if (segCount) el.convoMeta.textContent += ` · 记忆 ${segCount} 段`;

  el.hintText.textContent = settings.sendOnEnter === false
    ? 'Ctrl + Enter 发送 · Enter 换行'
    : 'Enter 发送 · Shift + Enter 换行';

  if (state.usage && settings.showUsage !== false) {
    const u = state.usage;
    let text = `本次用量：输入 ${u.prompt_tokens ?? '-'} / 输出 ${u.completion_tokens ?? '-'} tokens`;
    // 思考量单独拎出来说 —— 它是「输出被截断」时最该看的一个数：
    // 思考接近输出总量，就说明额度是被思考吃掉的；离得远则跟上限无关。
    const rt = Number(u.reasoning_tokens);
    if (Number.isFinite(rt) && rt > 0) text += `（其中思考 ${rt}）`;
    el.usageText.textContent = text;
  } else {
    el.usageText.textContent = '';
  }
}

/** 登记到刷新总线（在 init() 里按绘制顺序调用） */
export function initHeader() {
  onRefresh(renderHeader);
}
