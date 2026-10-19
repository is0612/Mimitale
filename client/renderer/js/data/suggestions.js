'use strict';

// data/suggestions.js —— 「帮我想想」和「剧情选项」的纯逻辑，一行 DOM 都不碰（按钮 / 交互在 views/suggestionsUi.js）
// 「帮我想想」= 额外发一次请求的一次性建议；「剧情选项」= 面板的一部分，跟状态栏一起在正文里输出、每轮更新。

import { OPTIONS_LABEL, OPTIONS_LINE_RE } from './panel.js';
import { asArray } from '../core/util.js';

// --- 帮我想想 ---

// 一次给几个选项
const SUGGEST_COUNT = 4;
// 单个选项的字数上限，免得点下去变成一大段
const MAX_SUGGEST_CHARS = 120;

export function suggestInstruction() {
  return (
    '请基于上面这段对话，替「玩家」想几个接下来可以怎么做 / 怎么说的选项。\n' +
    '\n' +
    '要求：\n' +
    `1. 给 ${SUGGEST_COUNT} 个，每一个都要贴着当前局面，不要泛泛而谈。\n` +
    '2. 每个选项要明显不同 —— 可以是不同的态度、不同的做法、或者不同的对象，\n' +
    '   不要四个都是同一件事的不同说法。\n' +
    '3. 用玩家第一人称，写他实际会说的话或会做的动作，\n' +
    `   每条控制在一句话内（不超过 ${MAX_SUGGEST_CHARS} 字），不要写成小作文。\n` +
    '4. 直接输出选项本身，不要序号、不要引号、不要解释、不要标题。\n' +
    '5. 每行一个，不要套用任何「剧情选项」标记或分隔线，就干干脆脆几行选项。'
  );
}

/** 从模型回复里解析出选项：一行一个，容忍它带了序号或引号 */
export function parseSuggestions(text) {
  const lines = String(text || '').split('\n');
  const out = [];

  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;

    // 容忍「1. 」「1、」「- 」「• 」这类前缀
    line = line.replace(/^[-*•·]\s*/, '').replace(/^\d+\s*[.、)）:：]\s*/, '');
    // 容忍整行被引号包起来
    line = line.replace(/^[「『"'“”‘’]+/, '').replace(/[」』"'“”‘’]+$/, '').trim();

    if (!line) continue;
    if (line.length > MAX_SUGGEST_CHARS) line = `${line.slice(0, MAX_SUGGEST_CHARS)}…`;

    if (!out.includes(line)) out.push(line);
    if (out.length >= SUGGEST_COUNT) break;
  }

  return out;
}

// --- 剧情选项 ---

// 选项行标记（OPTIONS_LABEL / OPTIONS_LINE_RE）在 data/panel.js：剥选项行和剥状态栏行是同一件事
// 一条选项最多多少字 —— 点下去要当消息发出去，不能变成小作文
const MAX_OPTION_CHARS = 120;
// 一屏最多几个（模型给多了会挤爆面板）
const MAX_OPTIONS = 6;
// 默认给几个 —— 须和 main/characters.js 的 DEFAULT_OPTIONS 对齐（角色卡没配过时按这个数走）
export const DEFAULT_OPTIONS_COUNT = 4;

/** 默认的剧情选项配置（没在角色卡上关掉的角色都用它） */
export function defaultOptionsSpec() {
  return { count: DEFAULT_OPTIONS_COUNT, hint: '' };
}

/**
 * 角色卡上的剧情选项配置 → 这个会话该用的配置。⚠️ 卡上明确关了（optionsSpec === false）→ null；配过 → 复制一份（改卡不该动到进行中的这一局）；没配过 / 没卡 → 默认 4 条。
 */
export function optionsSpecFromCharacter(character) {
  const spec = character && character.optionsSpec;
  if (spec === false) return null;
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) return { ...spec };
  return defaultOptionsSpec();
}

/** 当前会话要不要每轮出剧情选项（存在会话上，跟面板走） */
function convoOptionsSpec(convo) {
  const spec = convo && convo.optionsSpec;
  if (!spec || typeof spec !== 'object') return null;
  const count = Math.max(1, Math.min(MAX_OPTIONS, Math.round(Number(spec.count) || DEFAULT_OPTIONS_COUNT)));
  return { count, hint: String(spec.hint || '').trim().slice(0, 200) };
}

/** 会话当前的剧情选项列表（容错：老会话可能没有这个字段） */
function convoOptions(convo) {
  return asArray(convo && convo.options);
}

// 孤立的拉丁字母片段（模型把示例里的「A / B / C」当成标签抄出来了）；只丢**单个**字母，「OK」「B超」不受影响
const STANDALONE_LABEL_RE = /^[A-Za-z]$/;
// 「A. 」「A: 」这类字母前缀 —— 标签贴在选项内容前面时剥掉
const LETTER_PREFIX_RE = /^[A-Za-z]\s*[.、,，)）:：．]\s*/;

/**
 * 从模型回复里抽选项；返回空数组表示这轮没给（那就保持上一轮）。⚠️ 只认**最后一段**「【剧情选项】：」—— 模型有时先说一遍再重写，取最后的才是最终答案。
 */
export function extractOptionsFromText(text) {
  const lines = String(text || '').split('\n');
  let tail = null;

  for (const raw of lines) {
    const m = raw.trim().match(OPTIONS_LINE_RE);
    if (m) tail = m[1];
  }
  if (tail === null) return [];

  const out = [];
  // 只认「/」「｜」这类明确的分隔符，不拿顿号/逗号切（选项本身是中文句子，带「，」）。
  for (const piece of tail.split(/[\/｜|]/)) {
    let item = piece.trim();
    if (!item) continue;
    // 孤立字母标签先丢（模型把「A / B / C」示例当成要编号时就是这样输出的）
    if (STANDALONE_LABEL_RE.test(item)) continue;
    // 容忍「1. 」「A. 」「① 」「- 」这类前缀和包在引号里
    item = item.replace(/^[-*•·]\s*/, '');
    item = item.replace(/^[①-⑳]\s*/, '');
    item = item.replace(/^\d+\s*[.、)）:：]\s*/, '').replace(LETTER_PREFIX_RE, '');
    item = item.replace(/^[「『"'“”‘’]+/, '').replace(/[」』"'“”‘’]+$/, '').trim();
    if (!item) continue;
    if (item.length > MAX_OPTION_CHARS) item = `${item.slice(0, MAX_OPTION_CHARS)}…`;
    if (!out.includes(item)) out.push(item);
    if (out.length >= MAX_OPTIONS) break;
  }

  return out;
}

/**
 * 「换一批」的指令：按同一套设定再给一批，格式和 optionsInstruction 一致。⚠️ 必须把上一批列出来要求避开，否则点了等于没点；示例给真实内容而非「A / B / C」—— 占位字母会被照抄成单字母标签。
 */
export function rerollOptionsInstruction(convo) {
  const spec = convoOptionsSpec(convo);
  const count = spec ? spec.count : DEFAULT_OPTIONS_COUNT;

  const previous = convoOptions(convo).filter(Boolean);
  const avoid = previous.length
    ? `上一批选项是：${previous.map((t) => `「${t}」`).join('、')}。换一批时请避开这些（或至少别原样照搬），给几个明显不一样的做法。\n`
    : '';

  const lines = [
    '【换一批剧情选项】',
    `把上面刚给出的那批剧情选项换掉，重新另起一行，用「【剧情选项】：选项内容 / 选项内容 / 选项内容」的格式给 ${count} 个选项，` +
      '每个选项之间用「 / 」隔开（就这一行，不要编号、不要加 A/B/C 字母标签、不要再分多行）。',
    '每个选项是玩家接下来可以**直接说出口或做出来**的动作/台词，用玩家第一人称，' +
      `每条一句话以内（不超过 ${MAX_OPTION_CHARS} 字）。`,
    '例如：【剧情选项】：走过去抱住她 / 退后一步问她怎么了 / 假装没看见，继续做自己的事。',
    '选项之间要明显不同（不同的态度、做法或对象），不要是同一件事的不同说法。'
  ];
  if (avoid) lines.push(avoid.trim());
  if (spec && spec.hint) lines.push(`额外要求：${spec.hint}`);
  return lines.join('\n');
}

/** 注入给模型的选项指令（有配置时才注入） */
export function optionsInstruction(convo) {
  const spec = convoOptionsSpec(convo);
  if (!spec) return '';

  const lines = [
    '【剧情选项】',
    `每轮回复的末尾都**必须**带上「【${OPTIONS_LABEL}】：选项内容 / 选项内容 / 选项内容」这一行，` +
      `给出 ${spec.count} 个选项，每个选项之间用「 / 」隔开。` +
      '就这一行、紧跟正文和状态栏之后，不要编号、不要加 A/B/C 字母标签、不要再分多行，也不要因为正文长就省略这一行。',
    '每个选项是玩家接下来可以**直接说出口或做出来**的动作/台词，用玩家第一人称，' +
      `每条一句话以内（不超过 ${MAX_OPTION_CHARS} 字）。`,
    `例如：【${OPTIONS_LABEL}】：走过去抱住她 / 退后一步问她怎么了 / 假装没看见，继续做自己的事。`,
    '选项之间要明显不同（不同的态度、做法或对象），不要是同一件事的不同说法。'
  ];
  if (spec.hint) lines.push(`额外要求：${spec.hint}`);

  // 显式要求避开上一批，否则模型会「原地打转」给出同一批选项。
  const previous = convoOptions(convo).filter(Boolean);
  if (previous.length) {
    lines.push(
      `上一轮已经给过：${previous.map((t) => `「${t}」`).join('、')}。` +
        '这次给明显不同的新选项，不要重复上一轮的（局面有推进就更该换）。'
    );
  }

  return lines.join('\n');
}

/**
 * 把最新一条回复里的选项同步到会话上，返回是否变化。⚠️ 只看最新一条 assistant：这轮没给就**保留上一批**（不清空）；兜底只退到紧邻上一批、不往回扫历史（会命中好几轮前的过时选项）。
 */
export function syncConvoOptions(convo) {
  if (!convo || !Array.isArray(convo.messages)) return false;

  const before = JSON.stringify(convo.options || []);
  const previous = convoOptions(convo);
  let found = previous;

  if (convoOptionsSpec(convo)) {
    // 只取**第一条 assistant**（就是刚生成完的那条），不再往前翻。
    const last = convo.messages[convo.messages.length - 1];
    if (last && last.role === 'assistant') {
      const content = String(last.content || '');
      if (content.includes(OPTIONS_LABEL)) {
        const items = extractOptionsFromText(content);
        if (items.length) found = items;
      }
    } else {
      // 最后一条不是 assistant（空历史 / 停在用户或错误消息上）：没有「最新一轮剧情」可依附，清空
      found = [];
    }
  } else {
    found = [];
  }

  convo.options = found;
  return before !== JSON.stringify(convo.options);
}
