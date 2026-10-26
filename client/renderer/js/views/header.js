'use strict';

//  views/header.js —— 对话头部（标题 / 元信息 / 提示 / 用量），只读不写。
//  世界书的常规信息在 castPanel.js 的脚注（设计稿指定的位置），这里只留异常提示。
//  只依赖数据层、不认识任何视图，其他模块可以放心 import 它（单向）。

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { h } from '../ui/build.js';
import { iconSvg } from '../ui/icons.js';
import { currentScene } from '../data/currentScene.js';
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

// 顶栏头像 + 胶囊

/** 顶栏左边那颗头像：绑了角色 → 角色图 / 首字（圆）；世界书会话 → 书（方角）；都没有 → 中性点。 */
function renderTopbarAvatar(convo, character) {
  const host = el.topbarAvatar;
  if (!host) return;

  host.className = 'topbar-avatar';
  host.textContent = '';

  if (character) {
    host.classList.add(entityTone(character.id, character.name));
    if (character.avatar) host.appendChild(h('img', { src: character.avatar, alt: '' }));
    else host.textContent = String(character.name || '').slice(0, 1) || '?';
    return;
  }

  const wbId = convoWorldbookIds(convo)[0] || '';
  const wb = wbId ? worldbookById(wbId) : null;
  if (wb) {
    host.classList.add('book', entityTone(wb.id, wb.name));
    host.innerHTML = iconSvg('book-open');
    return;
  }

  host.classList.add('plain');
  host.innerHTML = iconSvg('book-open');
}

/** 绑定角色身上第一个有值的数值字段（「好感 41」）；找不到返回空串，胶囊整个不显示。 */
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

/** 这次发出去用了多少上下文（`6.2k`）。⚠️ 「上下文窗口」没有数据源，宁可不显示 —— settings 的 maxTokens 是**输出**上限，拿它凑比值就是把输出上限误当窗口。 */
function contextUsedLabel() {
  const usage = state.usage;
  if (!usage) return '';
  const n = Number(usage.prompt_tokens);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 缓存命中率：算出 {cached, input, rate}，服务商没返回命中量时返回 null。
 *  ⚠️ 顶栏、底部用量行都走这一份 —— 两处各算一遍迟早会出现「同一个数不一样」。 */
function hitRateOf(usage) {
  if (!usage) return null;
  const cached = Number(usage.cached_tokens);
  const input = Number(usage.prompt_tokens);
  if (!Number.isFinite(cached) || !Number.isFinite(input) || input <= 0) return null;
  return { cached, input, rate: Math.round((cached / input) * 100) };
}

/** 顶栏那颗「缓存 72%」；没有数据就返回空串，不显示比显示错的强 */
function cacheHitLabel() {
  const hit = hitRateOf(state.usage);
  return hit ? `缓存 ${hit.rate}%` : '';
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
    const bits = [];
    if (character) bits.push(character.name);
    bits.push(endpoint.model || '未选模型');
    // ⚠️ 一轮 = 一问一答 = 2 条；dateSeparator（views/chatMessages.js）同口径，两处一起改。
    const rounds = convo && Array.isArray(convo.messages) ? Math.ceil(convo.messages.length / 2) : 0;
    if (rounds) bits.push(`第 ${rounds} 轮`);
    const used = contextUsedLabel();
    if (used) bits.push(used);
    // 缓存命中率紧跟输入量：它说的就是「这一坨输入里有多少是打折的」。
    const hit = cacheHitLabel();
    if (hit) bits.push(hit);
    el.convoMeta.textContent = bits.join(' · ');
  }

  // 这里只留异常提示（「角色自带的书这次不生效」）；常规信息在 castPanel.js 的脚注。
  const convoBookIds = convoWorldbookIds(convo);
  const convoBooks = convoBookIds.map((id) => worldbookById(id)).filter(Boolean);
  const charBookIds = character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [];
  const charBooks = charBookIds.map((id) => worldbookById(id)).filter(Boolean);
  const effectiveBooks = convoBooks.length ? convoBooks : charBooks;
  const storyContext = document.getElementById('story-context');
  if (storyContext) storyContext.textContent = effectiveBooks.length
    ? `故事进行中 / ${effectiveBooks.map(book => book.name).join(' · ')}`
    : character ? `故事进行中 / ${character.name}` : '自由叙事 / 新的篇章';
  const sceneHost = document.getElementById('scene-context');
  if (sceneHost) {
    sceneHost.replaceChildren();
    const marker = h('span', { class: 'scene-marker', 'aria-hidden': 'true' });
    marker.innerHTML = iconSvg('map-pin');
    sceneHost.appendChild(marker);
    const scene = currentScene(convo);
    sceneHost.appendChild(h('span', { text: scene.length ? scene.map(field => field.value).join(' · ') : '故事场景，随你的叙述展开' }));
    if (effectiveBooks.length) {
      const books = h('span', { class: 'scene-worldbook', title: effectiveBooks.map(book => book.name).join('、') });
      const bookIcon = h('span', { 'aria-hidden': 'true' });
      bookIcon.innerHTML = iconSvg('book-open');
      books.append(bookIcon, document.createTextNode(effectiveBooks.map(book => book.name).join(' · ')));
      sceneHost.appendChild(books);
    }
  }

  if (convoBooks.length && charBooks.length) {
    el.convoMeta.textContent += ' · 角色自带的书不生效（世界优先）';
  }

  // 视角只在偏离默认时显示为标题旁的小胶囊。
  // ⛔ 纯聊天（「＋ 新对话」）一个标签都不显示：那两项对它不生效，挂出来等于撒谎。
  const viewTags = [];
  if (isGmMode(convo)) viewTags.push('GM 模式');
  if (!isPlainChatConvo(convo)) {
    const narrationMode = convoNarrationMode(convo);
    if (narrationMode !== DEFAULT_NARRATION_MODE) viewTags.push(NARRATION_MODES[narrationMode].label);
    const paceMode = convoPaceMode(convo);
    if (paceMode !== DEFAULT_PACE_MODE) viewTags.push(PACE_MODES[paceMode].label);
  }

  // 胶囊优先级：视角偏离 > 角色第一个数值字段；都没有就整个收起来。
  const pillText = viewTags.join(' + ') || charMeterLabel(convo, character);
  if (el.convoPill) {
    el.convoPill.textContent = pillText;
    el.convoPill.classList.toggle('hidden', !pillText);
  }

  const segCount = convoSummaries(convo).length;
  if (convo && convo.summaryBusy) el.convoMeta.textContent += ' · 正在整理记忆…';
  else if (segCount) el.convoMeta.textContent += ` · 记忆 ${segCount} 段`;

  el.hintText.textContent = settings.sendOnEnter === false
    ? 'Ctrl + Enter 发送 · Enter 换行'
    : 'Enter 发送 · Shift + Enter 换行';

  if (state.usage && settings.showUsage !== false) {
    const u = state.usage;
    // 服务商没返回命中量（比如没做前缀缓存的接口）就整段不写；
    // 返回了 0 就老老实实写 0% —— 那说明这一轮确实一个都没命中（冷启动必然如此）。
    const hit = hitRateOf(u);
    let text = `本次用量：输入 ${u.prompt_tokens ?? '-'}`;
    if (hit) text += `（缓存命中 ${hit.rate}%）`;
    text += ` / 输出 ${u.completion_tokens ?? '-'} tokens`;
    // 思考量单独说 —— 它接近输出总量，就说明额度是被思考吃掉的。
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
