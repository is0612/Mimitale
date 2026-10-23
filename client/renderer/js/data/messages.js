'use strict';

/** 消息数组：系统提示词、世界书、示例对话、历史、面板按固定顺序拼。
 *  ⚠️ 人设互斥：绑卡用卡 systemPrompt，纯聊天用默认人设，GM 一律不注入。 */

import { state } from '../core/state.js';
import { asArray } from '../core/util.js';
import {
  characterForConvo,
  effectiveDialoguePresets,
  WORLDBOOK_SCAN_DEPTH
} from './library.js';
import { compileAssistantCleaner, convoFieldDisplayNames, formatPanelForPrompt, panelGroupNames, PANEL_PROMPT_REMINDER } from './panel.js';
import { convoContextMessages, formatSummaryForPrompt, summarizedCount } from './memory.js';
import {
  EMPHASIS_REMINDER,
  gmRuleText,
  isGmMode,
  narrationInstruction,
  playerOwnershipReminder,
  roleplayRuleText
} from './narration.js';
import { optionsInstruction } from './suggestions.js';
import {
  isPlainChatConvo,
  convoPlayer,
  convoUserName,
  userName,
  assistantName,
  assistantPersona,
  worldbookCast,
  playerProfileForPrompt,
  panelEntities
} from './cast.js';

// 替换 {{char}}/<BOT> 与 {{user}}/<USER>；只在发给模型和插入开场白时替换，原文不动。
export function applyMacros(text, character, name, assistantFallback) {
  const charName =
    (character && character.name) || String(assistantFallback || '').trim() || assistantName();
  const me = name || userName();

  // 用函数式替换：替换串里的 $& / $1 会被当特殊序列，角色名带 $ 就替换错乱。
  return String(text == null ? '' : text)
    .replace(/\{\{char\}\}/gi, () => charName)
    .replace(/\{\{user\}\}/gi, () => me)
    .replace(/<BOT>/gi, () => charName)
    .replace(/<USER>/gi, () => me);
}

/** 拆示例对话：每行以 {{user}}: / {{char}}: 开头，<START> 分组；解析不出返回空数组 */
function parseExampleDialogue(text, charName, me) {
  const out = [];
  const raw = String(text || '');
  if (!raw.trim()) return out;

  // 正则转义，和转义 HTML 的 esc() 不是一回事
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 名字为空时不能把「空字符串」也当成一种匹配，否则任意行都会被吃掉
  const alternatives = (name, kind, extraTags) => {
    const list = [`\\{\\{${kind}\\}\\}`, ...extraTags];
    if (name && String(name).trim()) list.push(reEsc(String(name).trim()));
    return list.join('|');
  };

  const markers = [
    {
      re: new RegExp(`^\\s*(?:${alternatives(me, 'user', ['<USER>'])})\\s*[:：]\\s*(.*)$`, 'i'),
      role: 'user'
    },
    {
      re: new RegExp(
        `^\\s*(?:${alternatives(charName, 'char', ['<CHAR>', '<BOT>', '<BOT_NAME>'])})\\s*[:：]\\s*(.*)$`,
        'i'
      ),
      role: 'assistant'
    }
  ];

  let pending = null;

  const flush = () => {
    if (pending) {
      const content = pending.lines.join('\n').trim();
      if (content) out.push({ role: pending.role, content });
      pending = null;
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*<START>\s*$/i.test(line)) {
      flush();
      continue;
    }

    let matched = false;
    for (const marker of markers) {
      const m = line.match(marker.re);
      if (m) {
        flush();
        pending = { role: marker.role, lines: [m[1]] };
        matched = true;
        break;
      }
    }
    if (!matched && pending) pending.lines.push(line);
  }

  flush();
  return out;
}

/** 这条消息带的图（配图 / 桥接自动出的图） */
export function messageImages(message) {
  return asArray(message.images).filter((s) => typeof s === 'string' && s);
}

/** 给桥接的外貌上下文：图像模型只认视觉标签，得把长相写成自然语言。 */
export function characterContextForConvo(convo) {
  const character = characterForConvo(convo);
  if (!character) return '';

  const me = convoUserName(convo);
  const description = String(character.description || '').trim();

  const parts = [];
  parts.push(character.name);
  if (description) parts.push(applyMacros(description, character, me));
  return parts.join('\n');
}

// 预设拼成的注入段：每条独立成块（【预设 · 名称】），按挂载顺序拼。
// 带关键词的只在近期历史命中时带上，无关键词的（constant）每轮带。
export function dialoguePresetSection(convo, recentMessages) {
  const presets = effectiveDialoguePresets(convo);
  if (!presets.length) return '';

  // 命中只看最近几条正文，扫描深度和世界书一致；多条预设共用同一份文本。
  const haystack = asArray(recentMessages)
    .slice(-WORLDBOOK_SCAN_DEPTH)
    .map((m) => String((m && m.content) || ''))
    .join('\n')
    .toLowerCase();

  const sections = [];
  for (const preset of presets) {
    const blocks = [];
    if (String(preset.content || '').trim()) blocks.push(String(preset.content).trim());

    const entries = asArray(preset.entries);
    for (const entry of entries) {
      if (entry.enabled === false) continue;
      const text = String(entry.content || '').trim();
      if (!text) continue;
      const keys = asArray(entry.keys);
      if (!keys.length || entry.constant === true) {
        blocks.push(text);
        continue;
      }
      const hit = keys.some((k) => haystack.includes(String(k).toLowerCase()));
      if (hit) blocks.push(text);
    }

    const text = blocks.join('\n\n').trim();
    if (text) sections.push(`【预设 · ${preset.name}】\n${text}`);
  }

  return sections.join('\n\n');
}

/** 生效预设的采样参数：多项取第一条设过值的项，没设过的项不覆盖 */
export function dialoguePresetSampling(convo) {
  const presets = effectiveDialoguePresets(convo);
  const out = {};
  for (const preset of presets) {
    if (out.temperature === undefined && Number.isFinite(preset.temperature)) out.temperature = preset.temperature;
    if (out.maxTokens === undefined && Number.isFinite(preset.maxTokens)) out.maxTokens = preset.maxTokens;
    if (out.topP === undefined && Number.isFinite(preset.topP)) out.topP = preset.topP;
  }
  return Object.keys(out).length ? out : null;
}

// 本局采样参数：只传预设明确填的项（主进程按项覆盖全局设置）。
export function effectiveSampling(convo) {
  const preset = dialoguePresetSampling(convo) || {};
  const out = { ...preset };
  return Object.keys(out).length ? out : null;
}

// 世界书注入文本的取用口：兼容 { section, deepSection } 和只有 section 的字符串。
function worldbookParts(value) {
  if (value && typeof value === 'object') {
    return { section: String(value.section || ''), deep: String(value.deepSection || '') };
  }
  return { section: String(value == null ? '' : value), deep: '' };
}

/** 组装发给模型的消息数组；世界书 / 语义检索由调用方异步取好，这里保持同步。 */
export function buildApiMessages(convo, worldbook, ragSection) {
  const settings = state.settings || {};
  const me = convoUserName(convo);
  const gmMode = isGmMode(convo);
  // ⚠️ GM 没有「某个人」：即使会话上还绑着卡，也不注入卡的人设/设定/示例/对话后指令。
  const character = gmMode ? null : characterForConvo(convo);
  // 纯聊天 = 没绑卡也不是世界模式：只带人设、历史、摘要、日期和预设。
  // ⚠️ 扮演/GM 规则、世界书、玩家角色、面板、选项、表情、视角设置一个字都不注入。
  const plainChat = isPlainChatConvo(convo);

  // ⚠️ GM 不取人设名：否则「默认人设」会漏进世界书宏替换和 NPC 名单。
  const charName = (character && character.name) || (plainChat ? assistantName(convo) : '');
  // {{char}} 的替换值：GM 下没有具体角色，统一落成「叙述者」。
  const charMacro = charName || (gmMode ? '叙述者' : '');

  // 摘要覆盖点按同一份有效历史计数；空占位和无正文消息不发给模型。
  const history = convoContextMessages(convo);

  const turns = Math.max(1, Number(settings.maxTurns) || 20);
  // 摘要覆盖点失效时退回最近 N 轮，确保当前用户消息仍进入请求。
  const summarized = summarizedCount(convo);
  const covered = summarized >= history.length ? 0 : summarized;
  const uncovered = covered > 0 ? history.slice(covered) : history;
  const recent = uncovered.slice(-turns * 2);

  const messages = [];

  // ---- 1. 系统提示词 ----
  const parts = [];

  // 人设互斥：绑卡用卡 systemPrompt，纯聊天用「默认人设」，GM 两者都不用。
  const persona = plainChat ? assistantPersona(convo) : '';
  const base = character ? character.systemPrompt || '' : persona;
  if (String(base).trim()) parts.push(applyMacros(base, character, me, charName).trim());

  if (character) {
    if (character.description) parts.push(`【${charName}的设定】\n${applyMacros(character.description, character, me)}`);
    if (character.personality) parts.push(`【${charName}的性格】\n${applyMacros(character.personality, character, me)}`);
    if (character.scenario) parts.push(`【当前场景】\n${applyMacros(character.scenario, character, me)}`);
  }

  // GM 换掉「不要跳出角色」：世界模型要能写第三人称、切多个 NPC 视角。
  // 两种规则内部都带了推进节奏；纯聊天不注入这段（那是给扮演用的）。
  if (!plainChat) {
    parts.push(gmMode ? gmRuleText(charName, me, convo) : roleplayRuleText(charName, me, convo));
  }

  // 预设是独立整块，紧跟扮演规则；⚠️ 刻意放在 if 外面 —— 纯聊天也能用预设。
  // 正文 / 条目里允许写 {{char}} / {{user}}（编辑器里就是这么承诺的），所以拼完要过一遍宏，
  // 否则模型收到的是字面量 `{{char}}`。GM 下 charMacro 落成「叙述者」，和世界书段一致。
  const presetText = dialoguePresetSection(convo, history);
  if (presetText) parts.push(applyMacros(presetText, character, me, charMacro));

  // 玩家角色：只有写了设定才注入（上面那句规则已交代名字）。
  const player = convoPlayer(convo);
  const playerProfileText = playerProfileForPrompt(convo);
  if (!plainChat && player && playerProfileText) {
    // 抬头点明「玩家本人操作的主角」：紧跟着【这个世界的人】，否则主角会被当 NPC 写。
    parts.push(
      `【玩家角色：${player.name || me}】\n` +
        `（这是玩家本人操作的主角，由玩家自己驱动 —— 一律用第二人称「你」称呼 TA，` +
        `TA 的动作、台词、心理、感受和决定都不要代写。）\n` +
        playerProfileText
    );
  }

  // 这个世界有哪些 NPC：不列出来 GM 就只能现编（默认对话不带，同世界书段）
  const cast = plainChat ? '' : worldbookCast(convo);
  if (cast) parts.push(cast);

  // 叙述模式决定心理/旁白标记；⛔ 纯聊天不注入，视角弹窗里也不给这两项。
  if (!plainChat) {
    const narration = narrationInstruction(convo);
    if (narration) parts.push(narration);
  }

  // 推进节奏已由扮演 / 主持规则内部带上，这里不再补。

  if (settings.showDate !== false) {
    const today = new Date().toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    });
    parts.push(`[参考信息] 今天是 ${today}。`);
  }

  if (parts.length) messages.push({ role: 'system', content: parts.join('\n\n') });

  // ---- 2. 世界书：关键词命中的设定紧跟人设之后（After Char Defs）----
  // ⚠️ 这里只放关键词命中的；常驻条目在 6b 步，要靠生成位置近。
  const wb = worldbookParts(worldbook);
  if (!plainChat && wb.section.trim()) {
    messages.push({ role: 'system', content: applyMacros(wb.section, character, me, charMacro).trim() });
  }

  // ---- 2.2 语义检索捞回的往事 / 设定（可选）----
  if (!plainChat && String(ragSection || '').trim()) {
    messages.push({ role: 'system', content: String(ragSection).trim() });
  }

  // ---- 2.5 较早对话的摘要（先读背景再读最近对话）----
  const summaryText = formatSummaryForPrompt(convo);
  if (summaryText) messages.push({ role: 'system', content: summaryText });

  // ---- 3. 示例对话 ----
  // 正文里的宏要再替换一遍（parseExampleDialogue 只剥了行首前缀）；GM 不注入。
  if (character && !gmMode) {
    for (const example of parseExampleDialogue(character.mesExample, charName, me)) {
      messages.push({
        role: example.role,
        content: applyMacros(example.content, character, me)
      });
    }
  }

  // ---- 4. 真实对话历史（剥掉面板行，面板由程序权威注入）----
  const panelFields = convoFieldDisplayNames(convo);
  const panelGroups = [...panelGroupNames(convo)];
  const cleanHistoryText = compileAssistantCleaner(panelFields, panelGroups);
  for (const m of recent) {
    const raw = applyMacros(m.content, character, me, charMacro);
    const text = m.role === 'assistant' ? cleanHistoryText(raw) : raw;

    messages.push({ role: m.role, content: text });
  }

  // ---- 5. 面板状态：紧贴历史之后 ----
  // 历史会被 maxTurns 截断，面板被截出去模型就会编数值。
  const panelText = plainChat ? '' : formatPanelForPrompt(convo);
  if (panelText) messages.push({ role: 'system', content: panelText });

  // ---- 5b. 剧情选项：只在开了选项时注入 ----
  const optionsText = plainChat ? '' : optionsInstruction(convo);
  if (optionsText) messages.push({ role: 'system', content: optionsText });

  // ---- 5c. 表情标签：只在配了「带情绪键的表情图」时注入 ----
  const emoText = plainChat ? '' : expressionInstruction(convo);
  if (emoText) messages.push({ role: 'system', content: emoText });

  // ---- 6. 对话后指令 ----
  if (character && String(character.postHistoryInstructions || '').trim()) {
    messages.push({
      role: 'system',
      content: applyMacros(character.postHistoryInstructions, character, me).trim()
    });
  }

  // ---- 6b. 世界书常驻条目：送到离生成位置最近的地方（每轮都成立的规则）----
  // ⚠️ 必须排在 7b 主角不可代写之前，且不能挪到末尾（末尾是【标重点】和状态表提醒）。
  if (!plainChat && wb.deep.trim()) {
    messages.push({ role: 'system', content: applyMacros(wb.deep, character, me, charMacro).trim() });
  }

  // ---- 7. 状态表提醒（必须是整批 system 的最后一条）----
  // ---- 7b. 主角不可代写：⚠️ 必须排在状态表提醒之前（世界书同名设定会把主角当 NPC 写）
  if (gmMode) messages.push({ role: 'system', content: playerOwnershipReminder(me) });

  // ---- 7c. 【标重点】的最后一声 ----
  // 加粗规则离生成位置太远模型看不见；再点一次，但仍让位给状态表提醒。
  if (!plainChat) messages.push({ role: 'system', content: EMPHASIS_REMINDER });

  if (panelText) messages.push({ role: 'system', content: PANEL_PROMPT_REMINDER });

  return messages;
}

// 【表情】说明：只给规则不够，必须把现有键列出来，否则模型自己编词对不上。
function expressionInstruction(convo) {
  const rows = [];
  for (const entity of panelEntities(convo)) {
    const all = asArray(entity.card && entity.card.expressions);
    const list = all.filter((e) => e && e.key && e.image);
    if (!list.length) continue;
    rows.push(`- ${entity.name}：${list.map((e) => `${e.key}（${e.name}）`).join('、')}`);
  }
  if (!rows.length) return '';

  const lines = [
    '【表情】',
    '每轮回复的**最后一行**都单独带一个表情标签，格式：<emo>键</emo>（例如 <emo>shy</emo>），' +
      '挑一个最贴近这一轮情绪的。应用据此切换状态卡上的立绘。'
  ];
  if (rows.length > 1) {
    lines.push('场上不止一个人，写成「角色名 <emo>键</emo>」，标清楚是谁的表情。');
  }
  lines.push('可选键：', ...rows);
  lines.push('这个标签是给应用读的，不要写进正文的对白和描写里；键要照抄上面的拼写，别自己造词。');

  return lines.join('\n');
}
