'use strict';

// data/memory.js —— 分段记忆摘要：把较早的对话按段压成摘要常驻上下文、原文丢弃
// 摘要由程序管理（和状态面板同一个思路：记忆不能交给模型自己维持）。
// 这里只放「怎么算区间、怎么写提示词、怎么调模型」；「什么时候压、压完怎么通知界面」属调度，在 main.js。

import { api } from '../core/api.js';
import { uid, asArray } from '../core/util.js';
import { stripPanelLines } from './panel.js';
import { ensureConvoEndpoint } from './providers.js';
import { characterForConvo } from './library.js';

// 未覆盖的消息达到这个数就压一段（一轮 = 一问一答 = 2 条，约每 12 轮压一段）
const SUMMARY_TRIGGER_MESSAGES = 24;
// 少于这个数不值得单独压一段
const SUMMARY_MIN_MESSAGES = 12;
// 单段摘要的长度上限
const MAX_SUMMARY_CHARS = 4000;
// 一次送给模型压缩的原文长度上限，超了就从最早的开始截
const MAX_SUMMARY_INPUT_CHARS = 24000;
// 连续失败这么多次就暂停自动摘要，避免每轮都白烧一次请求
const MAX_SUMMARY_FAILURES = 3;
// 失败后至少隔这么久再试（毫秒）
const SUMMARY_RETRY_COOLDOWN_MS = 60000;

/** 真正会进入上下文的消息（和 buildApiMessages 的口径保持一致） */
export function convoContextMessages(convo) {
  if (!convo || !Array.isArray(convo.messages)) return [];
  return convo.messages.filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
}

export function convoSummaries(convo) {
  return asArray(convo && convo.summaries);
}

/** 摘要覆盖到了第几条（未压缩的历史从这里开始） */
export function summarizedCount(convo) {
  const list = convoSummaries(convo);
  if (!list.length) return 0;
  let max = 0;
  for (const seg of list) {
    const end = Number(seg.end) || 0;
    if (end > max) max = end;
  }
  return max;
}

/**
 * 真正发给模型的最近一段历史：摘要覆盖点之后，再按「批式」窗口截尾。
 * ⚠️ messages.js 发什么、rag.js 就排除什么，必须由这一家算。两处口径一分叉，
 * 近期消息就会被当成「早先的回忆」捞回来，和原文重复还白占 topK。
 * ⚠️ 只能截尾、不能每轮滑动：窗口每移一条，「历史第一句」就换成下一条，
 * 上游的前缀缓存从历史开头整段作废（长对话里那是上万 token 按原价重算）。
 * 攒到 2 倍预算才砍回目标窗口；摘要正常工作时 uncovered 只有 12~24 条，
 * 砍这一步基本走不到。
 */
export function recentContextMessages(convo, maxTurns) {
  const history = convoContextMessages(convo);
  const covered = summarizedCount(convo);
  // 摘要覆盖点失效（>= 历史长度）时退回 0，确保当前用户消息仍进入请求。
  const uncovered = covered > 0 && covered < history.length ? history.slice(covered) : history;
  const windowSize = Math.max(1, Number(maxTurns) || 20) * 2;
  return uncovered.length > windowSize * 2 ? uncovered.slice(-windowSize) : uncovered;
}

/** 最近一段历史的条数，rag.js 用来排除「反正会进上下文」的消息 */
export function recentContextCount(convo, maxTurns) {
  return recentContextMessages(convo, maxTurns).length;
}

/**
 * 删掉 convo.messages[messageIndex] 之前调：把摘要的 start/end 跟着挪（挪完缩成空的段丢掉）。⚠️ start/end 是 convoContextMessages 的下标，不挪的话紧邻覆盖点那条**没被压缩过**的消息会滑进「已覆盖」区间，从此既不进摘要也不进上下文。
 */
export function shiftSummariesForRemoval(convo, messageIndex) {
  const list = convoSummaries(convo);
  if (!list.length || !convo || !Array.isArray(convo.messages)) return;

  const removed = convo.messages[messageIndex];
  const context = convoContextMessages(convo);
  const ci = context.indexOf(removed);
  if (ci < 0) return;

  for (const seg of list) {
    const start = Number(seg.start) || 0;
    const end = Number(seg.end) || 0;
    if (ci < start) seg.start = start - 1;
    if (ci < end) seg.end = end - 1;
  }
  convo.summaries = list.filter((s) => s.end > s.start);
}

/**
 * 压缩请求回来、记覆盖范围之前调：[start, start+count) 还是不是当初送去压的那几条？⚠️ 摘要要等模型几秒到几十秒，期间用户可能删了消息、start 已过期 —— 对不上就放弃这一段，下轮按新位置重压。
 */
export function summaryRangeIntact(convo, start, sent, count, snapshot) {
  if (summarizedCount(convo) !== start) return false;
  const context = convoContextMessages(convo);
  for (let i = 0; i < count; i += 1) {
    const current = context[start + i];
    const sentItem = sent[i];
    if (!current || !sentItem || current !== sentItem) return false;
    if (snapshot) {
      const snapItem = snapshot[i];
      if (!snapItem || sentItem.role !== snapItem.role || sentItem.content !== snapItem.content) return false;
    }
  }
  return true;
}

export function invalidateSummariesForEdit(convo, message) {
  const index = convoContextMessages(convo).indexOf(message);
  if (index < 0) return;
  const list = convoSummaries(convo);
  const affected = list.findIndex((seg) => index >= (Number(seg.start) || 0) && index < (Number(seg.end) || 0));
  // 后面的摘要都是把这一段当「上文」生成的；这一段改了，它们也站不住。
  if (affected >= 0) convo.summaries = list.slice(0, affected);
}

export function nextSegmentTitle(convo) {
  return `第 ${convoSummaries(convo).length + 1} 段`;
}

/** 摘要拼成注入块；没有摘要就返回空串 */
export function formatSummaryForPrompt(convo) {
  const list = convoSummaries(convo);
  if (!list.length) return '';

  const parts = [];
  for (const seg of list) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    parts.push(`【${seg.title || '对话摘要'}】\n${text}`);
  }
  if (!parts.length) return '';

  return (
    '[前面的剧情]\n' +
    '以下是本次对话较早部分的摘要，作为已经发生过的剧情参考，' +
    '保持人物、地点和事件前后一致；不要向对方复述这份摘要。\n\n' +
    parts.join('\n\n')
  );
}

/** 摘要提示词。⚠️ 明确要求「只记事实、不要文学化」—— 摘要常驻上下文，写成抒情散文既费 token 又容易被当成剧情续写 */
function buildSummaryPrompt(previousSummary, transcriptText) {
  const parts = [
    '你在帮一个长篇角色扮演对话做剧情摘要。',
    '下面是一段已经发生过的对话原文，请把它压缩成简洁的剧情摘要。',
    '',
    '要求：',
    '1. 只记录事实：发生了什么、到了哪里、见了谁、关系或状态有什么变化、答应过什么、埋了什么伏笔。',
    '2. 不要文学化描写，不要复述对话原文，不要加入评论。',
    '3. 按时间顺序写，用短句或分条，控制在 300 字以内。',
    '4. 直接输出摘要正文，不要任何前言、标题或「摘要：」之类的字样。'
  ];

  if (previousSummary) {
    parts.push(
      '',
      '此前已有的更早剧情摘要（只作为背景，不要重复它的内容）：',
      previousSummary
    );
  }

  parts.push('', '需要压缩的对话原文：', transcriptText);
  return parts.join('\n');
}

/** 一条消息在压缩原文里的样子 */
function transcriptLine(m, charName) {
  const who = m.role === 'user' ? '对方' : charName || '角色';
  // 摘要不需要状态栏，剥掉省 token
  const text = String(m.content || '').trim();
  return `${who}：${m.role === 'assistant' ? stripPanelLines(text) : text}`;
}

/**
 * 给「往后压一段」用的原文：**从最早那条往后**装，装满为止；返回 { text, count }，摘要的 end 必须按 count 记。⚠️ 从后往前装时超长砍掉的是最早几条，而调用方按 slice.length 记覆盖范围 —— 那几条既不在摘要里、又被挡在上下文外，永久消失。
 */
export function buildTranscriptFromStart(messages, charName) {
  const lines = [];
  let total = 0;

  for (const m of messages) {
    const line = transcriptLine(m, charName);
    // join('\n\n') 每两条之间还要占 2 个字符，预算里一起算。
    const nextTotal = total + (lines.length ? 2 : 0) + line.length;
    if (nextTotal > MAX_SUMMARY_INPUT_CHARS && lines.length) break;
    total = nextTotal;
    lines.push(line);
  }

  return { text: lines.join('\n\n'), count: lines.length };
}

/**
 * 需要压缩的消息区间。⚠️ 用「总数 - 已覆盖数」算而不用固定下标 —— 用户删掉中间某条后数组整体前移，固定下标会错位。
 */
export function pendingSummaryRange(convo) {
  const messages = convoContextMessages(convo);
  const covered = summarizedCount(convo);
  const start = Math.min(covered, messages.length);
  const pending = messages.slice(start);
  return { messages, start, pending, covered };
}

/** 摘要的「运行态」：后台调度（main.js 的 maybeSummarize）判断该不该压，记忆面板（views/memoryUi.js）判断有没有在跑 */
// 正在压缩的会话 id，防止同一会话并发触发
export const summarizingConvos = new Set();
// 会话 id -> 连续失败次数
export const summaryFailures = new Map();

/** 摘要里怎么称呼「对面那位」—— 没绑角色就当作通用助手 */
export function charNameForSummary(convo) {
  const character = characterForConvo(convo);
  return character ? character.name : '你';
}

/** 调一次模型生成摘要；失败或返回异常时返回 null */
export async function generateSummary(convo, transcript, previousSummary) {
  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) return null;

  const summaryMessages = [
    { role: 'system', content: buildSummaryPrompt(previousSummary, transcript) }
  ];

  const response = await api.sendChat({
    requestId: `summary-${uid()}`,
    providerId: endpoint.provider.id,
    model: endpoint.model,
    messages: summaryMessages
  });

  if (!response || response.ok !== true) {
    throw new Error((response && response.error) || '摘要请求失败');
  }

  let text = String(response.content || '').trim();
  if (!text) throw new Error('摘要返回为空');

  // 有些模型会固执地加个前缀，剥掉
  text = text.replace(/^(剧情)?摘要[：:]\s*/, '').trim();

  if (text.length > MAX_SUMMARY_CHARS) {
    text = `${text.slice(0, MAX_SUMMARY_CHARS)}…`;
  }

  return text;
}

export {
  SUMMARY_TRIGGER_MESSAGES,
  SUMMARY_MIN_MESSAGES,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_INPUT_CHARS,
  MAX_SUMMARY_FAILURES,
  SUMMARY_RETRY_COOLDOWN_MS
};
