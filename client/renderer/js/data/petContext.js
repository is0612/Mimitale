'use strict';

// data/petContext.js —— 桌宠「该不该说话、说什么给谁听」这一层（判断放渲染层，理由见 main/pet-ipc.js 顶部）
// 三件事：缓存桌宠配置（改完会推 pet:changed 刷新）、按「每隔 N 轮」计数决定这轮说不说、把上下文打包交给主进程。
// ⚠️ 宠物说的话**永远不写进 convo.messages** —— 写进去角色下一轮就会「听见」宠物说话，扮演当场崩（记忆走 main/pet-store.js）。

import { api } from '../core/api.js';
import { activeConvo, asArray } from '../core/util.js';
import { speakerName, convoUserName } from './cast.js';
import {
  cleanAssistantText,
  convoPanel,
  convoPanelFields,
  panelGroupNames,
  panelKeyParts
} from './panel.js';
import { convoContextMessages, formatSummaryForPrompt } from './memory.js';

/** 给宠物看「刚刚发生了什么」时带几条。它不是要复盘，只是要听懂在演哪一出。 */
const RECENT_COUNT = 6;
/** 单条消息截断，免得一条长回复把上下文撑满 */
const MAX_MESSAGE_CHARS = 500;
/** 状态面板最多带几个字段 */
const MAX_PANEL_FIELDS = 8;

// --- 配置缓存 ---

let petCache = null;

/** 从主进程拉一份最新的桌宠状态（设置页打开、配置变化时都会调） */
export async function refreshPetCache() {
  try {
    petCache = await api.petGet();
  } catch (err) {
    console.error('读取桌宠状态失败', err);
    petCache = null;
  }
  return petCache;
}

export function petState() {
  return petCache;
}

// --- 上下文 ---

/** 状态面板快照：宠物靠它就能看出「刚才好感涨了」这类事，不用去啃正文 */
function panelSnapshot(convo) {
  const panel = convoPanel(convo);
  const keys = Object.keys(panel || {});
  if (!keys.length) return '';

  const out = [];
  for (const key of keys.slice(0, MAX_PANEL_FIELDS)) {
    const value = panel[key];
    if (value == null || value === '') continue;
    const parts = panelKeyParts(key);
    const name = parts && parts.name ? parts.name : key;
    out.push(`${name}：${String(value).slice(0, 40)}`);
  }
  return out.join(' / ');
}

/**
 * 打包给宠物看的上下文：给「最近 6 条 + 摘要 + 状态面板」三样现成的，**刻意不发完整历史**（O(n²) 烧钱且没必要）。⚠️ 形状要和 main/pet-brain.js 的 buildUserPrompt 对得上。
 */
export function buildPetContext() {
  const convo = activeConvo();
  if (!convo) return { convoTitle: '', characters: '', recent: [], summary: '', panel: '' };

  // 助手显示成谁交给 cast.js 的 speakerName 裁决（绑卡 → 卡名；进世界 → 世界名；都没有 → 默认人设名）。
  // ⚠️ 别直接取 assistantName：会贴上「默认人设」的名字，宠物会被绕晕。
  const charName = speakerName(convo) || '';
  const userName = convoUserName(convo) || '我';
  const panelFields = convoPanelFields(convo);
  const groups = panelGroupNames(convo);

  const messages = convoContextMessages(convo);
  const recent = messages.slice(-RECENT_COUNT).map((m) => {
    const raw = String(m.content || '');
    // 助手那条里带着状态栏和【剧情选项】，宠物不需要看这些格式垃圾
    const text =
      m.role === 'assistant' ? cleanAssistantText(raw, panelFields, groups) : raw;
    return {
      role: m.role,
      name: m.role === 'user' ? userName : charName || '角色',
      text: String(text || '').trim().slice(0, MAX_MESSAGE_CHARS)
    };
  });

  return {
    convoTitle: String(convo.title || '未命名对话'),
    characters: [userName, charName].filter(Boolean).join('、'),
    recent: recent.filter((m) => m.text),
    summary: formatSummaryForPrompt(convo),
    panel: panelSnapshot(convo)
  };
}

// --- 触发 ---

/**
 * 「已经过去几轮」按会话分开数，只在内存里。⚠️ 不落盘是刻意的：重启从头数起代价只是「刚开那一轮不说」，落盘要多维护一个文件、还要处理读失败。
 */
const turnCounters = new Map();

/** 删会话时清一下计数（views/convoActions.js 的 removeConvo 调），免得 Map 越积越多 */
export function resetPetTurns(convoId) {
  if (convoId) turnCounters.delete(convoId);
  else turnCounters.clear();
}

/** 距离下一次开口还差几轮（设置页拿它显示状态） */
export function turnsUntilNextSpeak() {
  const convo = activeConvo();
  const pet = petCache && petCache.pet;
  if (!convo || !pet) return null;
  const every = Math.max(1, Number(pet.speakEveryTurns) || 1);
  const done = turnCounters.get(convo.id) || 0;
  return Math.max(0, every - done);
}

/**
 * 一轮角色回复刚结束时调一次：① 桌宠开着 ② 主动发言没暂停 ③ 没在静音期 ④ 攒够轮数，全过了才真开口；任何一条挡下都只是「这次不说」，不报错。
 */
export async function maybePetAutoSpeak() {
  const config = petCache && petCache.config;
  const pet = petCache && petCache.pet;

  if (!config || !config.enabled || !pet) return { ok: false, skipped: true, why: 'off' };
  if (!pet.speakEnabled) return { ok: false, skipped: true, why: 'paused' };
  // 隐藏期间不攒轮数，且要把**已经攒的那部分清掉** —— 只「不计数」不够：攒到 N-1 再藏、重新显示时照样立刻开口。
  if (!pet.visible) {
    const hiddenConvo = activeConvo();
    if (hiddenConvo) turnCounters.delete(hiddenConvo.id);
    return { ok: false, skipped: true, why: 'hidden' };
  }
  if (pet.mutedUntil > Date.now()) return { ok: false, skipped: true, why: 'muted' };

  const convo = activeConvo();
  if (!convo) return { ok: false, skipped: true, why: 'no-convo' };

  const every = Math.max(1, Number(pet.speakEveryTurns) || 1);
  const done = (turnCounters.get(convo.id) || 0) + 1;
  if (done < every) {
    turnCounters.set(convo.id, done);
    return { ok: false, skipped: true, why: 'waiting', wait: every - done };
  }

  turnCounters.set(convo.id, 0);
  return speakNow('auto');
}

/** 立刻说一次（右键菜单「现在说话」走这里）；reason 决定要不要写记忆，'preview' 永远不写 */
export async function speakNow(reason) {
  const context = buildPetContext();
  try {
    const result = await api.petSpeak({ reason, context });
    // 说完记忆条数会变，顺手刷新一下缓存（设置页的状态行要跟着动）
    if (result && result.ok) await refreshPetCache();
    return result || { ok: false, error: '没有返回结果' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '生成失败' };
  }
}

/** 设置页的「预览」：与 speakNow 唯一区别是 reason = preview —— 主进程不写记忆、也不写主对话记录 */
export function previewSpeak() {
  return speakNow('preview');
}

/** 「让桌宠说出这句」：把预览框里那句话直接推给宠物窗口，不重新生成 */
export function sayThisNow(text) {
  return api.petSayNow({ text: String(text || '') }).catch((err) => ({
    ok: false,
    error: (err && err.message) || '推送失败'
  }));
}

/** 静音剩余毫秒（不在静音期就是 0） */
export function muteRemainMs() {
  const pet = petCache && petCache.pet;
  if (!pet || !pet.mutedUntil) return 0;
  return Math.max(0, pet.mutedUntil - Date.now());
}

/** 最近几条记忆（设置页打开时才拉，平时不占内存） */
export async function loadPetMemory(petId) {
  const data = await api.petMemoryGet({ petId });
  return { items: asArray(data && data.items), digest: (data && data.digest) || '' };
}
