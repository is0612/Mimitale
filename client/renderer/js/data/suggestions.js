'use strict';

// data/suggestions.js —— 「剧情选项」的纯逻辑，一行 DOM 都不碰（按钮 / 交互在 views/suggestionsUi.js）
//
// 这里只有一个东西：**玩家下一步能做什么**的那批选项。两个来源、一个动作：
//   ① 自动（optionsInstruction）—— 模型每轮跟着回复带出来；
//   ② 手动（optionsRequestInstruction）—— 用户点「帮我想想」或「换一批」时要一次。
//      这两个按钮是同一个动作的两个位置：没有上一批 → 补一批，有 → 换一批，措辞自动切。
// ⚠️ 两个来源**产出同一样东西**（写回 convo.options），所以界面上也只有一块 UI（.msg-options）。
//    以前「帮我想想」另起了一套临时建议条，等于把同一件事做了两遍：没有序号、按不了 1~9、
//    不能换一批、关窗口就没了 —— 2026-10-20 合并掉。

import { OPTIONS_LABEL, OPTIONS_LINE_RE } from './panel.js';
import { asArray } from '../core/util.js';

// 一条选项最多多少字 —— 点下去要当消息发出去，不能变成小作文
const MAX_OPTION_CHARS = 120;
// 一屏最多几个（模型给多了会挤爆面板）
const MAX_OPTIONS = 6;
// 默认给几个 —— 须和 main/characters.js 的 DEFAULT_OPTIONS 对齐（角色卡没配过时按这个数走）
export const DEFAULT_OPTIONS_COUNT = 4;

// --- 解析 ---

/**
 * 格式全崩时的兜底：一行一个，容忍序号 / 引号 / 项目符号。
 * 正常路径走 extractOptionsFromText（认「【剧情选项】：a / b / c」），这个只接「模型干脆没按格式写」的场。
 */
export function parseSuggestions(text, limit) {
  const max = Math.max(1, Math.min(MAX_OPTIONS, Math.round(Number(limit) || DEFAULT_OPTIONS_COUNT)));
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
    if (line.length > MAX_OPTION_CHARS) line = `${line.slice(0, MAX_OPTION_CHARS)}…`;

    if (!out.includes(line)) out.push(line);
    if (out.length >= max) break;
  }

  return out;
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

// --- 指令 ---
// 三个入口（每轮 / 换一批 / 补一批）只有开头那句「什么时候给」不同，格式要求走同一份。

/** 格式那一行：怎么摆、几个、别加什么。 */
function optionShapeLine(count) {
  return (
    `用「【${OPTIONS_LABEL}】：选项内容 / 选项内容 / 选项内容」的格式给出 ${count} 个选项，` +
    '每个选项之间用「 / 」隔开（就这一行，不要编号、不要加 A/B/C 字母标签、不要再分多行）。'
  );
}

/** 内容要求那几行：写什么、多长、几条之间要不一样。示例用真实内容而非「A / B / C」—— 占位字母会被照抄成单字母标签。 */
function optionBodyLines() {
  return [
    '每个选项是玩家接下来可以**直接说出口或做出来**的动作/台词，用玩家第一人称，' +
      `每条一句话以内（不超过 ${MAX_OPTION_CHARS} 字）。`,
    `例如：【${OPTIONS_LABEL}】：走过去抱住她 / 退后一步问她怎么了 / 假装没看见，继续做自己的事。`,
    '选项之间要明显不同（不同的态度、做法或对象），不要是同一件事的不同说法。'
  ];
}

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

/** 「上一批已经给过哪些」—— 不写这句，模型会原地打转给同一批。 */
function avoidPreviousLine(convo) {
  const previous = convoOptions(convo).filter(Boolean);
  if (!previous.length) return '';
  return `上一轮已经给过：${previous.map((t) => `「${t}」`).join('、')}。这次给明显不同的新选项，不要重复上一轮的（局面有推进就更该换）。`;
}

/** 注入给模型的选项指令（有配置时才注入） */
export function optionsInstruction(convo) {
  const spec = convoOptionsSpec(convo);
  if (!spec) return '';

  const lines = [
    '【剧情选项】',
    '每轮回复的末尾都**必须**带上这一行，紧跟正文和状态栏之后，不要因为正文长就省略：',
    optionShapeLine(spec.count),
    ...optionBodyLines()
  ];
  if (spec.hint) lines.push(`额外要求：${spec.hint}`);

  const avoid = avoidPreviousLine(convo);
  if (avoid) lines.push(avoid);

  return lines.join('\n');
}

/**
 * 手动要一批选项 —— 「帮我想想」和「换一批」点的是**同一个动作**：
 * 再要一批，避开手上已有的那批。唯一的变量是「手上有没有上一批」，措辞跟着变：
 *   · 有 → 「换一批」（把上面那批换掉）
 *   · 没有 → 「补一批」（这轮压根没给，别写正文）
 * ⚠️ 所以别再拆成两个函数 —— 拆了就会漂：一边改了格式，另一边忘了。
 */
export function optionsRequestInstruction(convo) {
  const spec = convoOptionsSpec(convo);
  const count = spec ? spec.count : DEFAULT_OPTIONS_COUNT;
  const hasPrevious = convoOptions(convo).filter(Boolean).length > 0;

  const lines = hasPrevious
    ? [
        '【换一批剧情选项】',
        '把上面刚给出的那批剧情选项换掉，重新另起一行，别再重复旧的：',
        optionShapeLine(count),
        ...optionBodyLines()
      ]
    : [
        '【补一批剧情选项】',
        '上面这轮没有给剧情选项，玩家不知道接下来能怎么做。这一次**不要写正文、不要写旁白、不要重复之前的剧情**，' +
          '只把玩家接下来可以做的事给出来：',
        optionShapeLine(count),
        ...optionBodyLines()
      ];

  const avoid = avoidPreviousLine(convo);
  if (avoid) lines.push(avoid);
  if (spec && spec.hint) lines.push(`额外要求：${spec.hint}`);

  return lines.join('\n');
}

// --- 会话上的选项 ---

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
    // 这一局不出自动选项：手动补的那批（帮我想想）到此为止 —— 它就是一次性的
    found = [];
  }

  convo.options = found;
  return before !== JSON.stringify(convo.options);
}
