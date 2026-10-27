'use strict';

// 「谁在说话」：把会话 + 角色卡/世界书读成「谁是谁」，纯读不写。
// 口径只在这里维护（提示词、气泡标签、导出共用），否则各处会互相打架。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { asArray } from '../core/util.js';
import {
  characterForConvo,
  characterById,
  effectiveWorldbookIds,
  worldbookById,
  worldbookCharacters,
  showsInPanel,
  WORLDBOOK_SCAN_DEPTH,
  recursiveDepthSetting
} from './library.js';
import { convoPanelFields, panelFieldOwner } from './panel.js';
import { isGmMode } from './narration.js';


function mergePromptText(preferred, fallback) {
  const a = String(preferred || '').trim();
  const b = String(fallback || '').trim();
  if (!a) return b;
  if (!b || a === b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}\n\n${b}`;
}

// 定义搬到了 data/library.js（panel.js / convoState.js 也要用，而它们不能反向 import 这里 —— 会成环）。
// 这里保留再导出：调用方一直是从 cast.js 拿的，别为了「整齐」把它们全改一遍。
// ⚠️ 必须是「import 进来 + 再 export」，写成 `export {} from` 的话本模块自己就拿不到这个名字了。
export { effectiveWorldbookIds };

export function userName() {
  return '你';
}

/** 纯聊天 = 没绑卡也不是 GM。判定只此一处：messages 和视角弹窗都来问它。
 *  ⚠️ 两边各判各的会出现「界面上有开关、提示词里却不认」的错位。 */
export function isPlainChatConvo(convo) {
  return !characterForConvo(convo) && !isGmMode(convo);
}

// 默认人设按模型各存一份：会话自己的模型优先，没有会话才退回设置里的当前模型。
// 纯读，别在这儿补全会话对象 —— data 层不产生副作用。
function assistantModelKey(convo) {
  const own = convo && String(convo.model || '').trim();
  if (own) return own;
  const s = state.settings || {};
  return String(s.activeModel || '').trim();
}

function assistantPersonaEntry(convo) {
  const s = state.settings || {};
  const map = s.assistantPersonas;
  if (!map || typeof map !== 'object') return null;
  const entry = map[assistantModelKey(convo)];
  return entry && typeof entry === 'object' ? entry : null;
}

/** 通用助手的名字（按会话当前模型取默认人设）；没写名字就是空串，不兜内置假名 */
export function assistantName(convo) {
  const entry = assistantPersonaEntry(convo);
  return String((entry && entry.name) || '').trim();
}

/** 通用助手的设定正文；空串是正常状态（这个模型没配人设 = 不扮演） */
export function assistantPersona(convo) {
  const entry = assistantPersonaEntry(convo);
  return String((entry && entry.persona) || '').trim();
}

/** 世界书两块注入文本的空值：调用方拿到的形状永远一致 */
const EMPTY_WORLDBOOK = { section: '', deepSection: '' };

/**
 * 参与世界书扫描的近期正文：只认有内容的对白，**跳过历史里的 null 占位**。
 *
 * ⚠️ 口径和 `memory.js` / `suggestionsUi.js` 一致（都写 `m &&`）：导入 / 旧版本留下的
 *    历史里可能夹着 null，少了这一下，`.filter` 直接抛 TypeError —— 表现是**整条消息发不出去**
 *    （`prepareCompletion` 没有兜世界书这一步）、右栏「命中 N 条」永远空着、
 *    「预览命中」弹出 `Cannot read properties of null (reading 'role')`。
 *    所以三处扫描共用这一个函数，别再各写一份 filter。
 */
export function worldbookScanHistory(convo) {
  return asArray(convo && convo.messages).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
}

// 匹配世界书，返回 { section, deepSection }。⚠️ 调用方必须两块都传给 buildApiMessages，
// 只传 section 常驻条目就丢了（表现是卡里的规则一条都不生效，且不报错）。
export async function matchWorldbookSections(convo) {
  const allIds = [...new Set(effectiveWorldbookIds(convo))];
  if (!allIds.length) return { ...EMPTY_WORLDBOOK };

  const history = worldbookScanHistory(convo);

  try {
    const result = await api.previewWorldbook({
      worldbookIds: allIds,
      scanDepth: WORLDBOOK_SCAN_DEPTH,
      recursiveDepth: recursiveDepthSetting(),
      messages: history.slice(-WORLDBOOK_SCAN_DEPTH).map((m) => ({ role: m.role, content: m.content }))
    });
    return {
      section: (result && result.section) || '',
      deepSection: (result && result.deepSection) || ''
    };
  } catch (err) {
    // 世界书挂了不该拦住正常聊天
    console.error('世界书匹配失败', err);
    return { ...EMPTY_WORLDBOOK };
  }
}

// 这一轮命中几条（右栏脚注用）：和 matchWorldbookSections 同一套扫描口径，取 hits.length。
// 失败返回 null，不抛错。
export async function worldbookHitCount(convo) {
  const allIds = [...new Set(effectiveWorldbookIds(convo))];
  if (!allIds.length) return 0;

  const history = worldbookScanHistory(convo);

  try {
    const result = await api.previewWorldbook({
      worldbookIds: allIds,
      scanDepth: WORLDBOOK_SCAN_DEPTH,
      recursiveDepth: recursiveDepthSetting(),
      messages: history.slice(-WORLDBOOK_SCAN_DEPTH).map((m) => ({ role: m.role, content: m.content }))
    });
    if (!result || !Array.isArray(result.hits)) return null;
    return result.hits.length;
  } catch (err) {
    console.error('世界书命中统计失败', err);
    return null;
  }
}

/** 玩家在这个世界里的角色（老的会话没有这个字段） */
export function convoPlayer(convo) {
  const p = convo && convo.player;
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').trim();
  const profile = String(p.profile || '').trim();
  // ⚠️ characterId 必须带出去：panelEntities 要靠它找玩家挑的那张卡（立绘 / 表情）。
  const characterId = typeof p.characterId === 'string' ? p.characterId.trim() : '';
  if (!name && !profile && !characterId) return null;
  return { name, profile, characterId };
}

/** 把 {{char}}/{{user}}/<BOT>/<USER> 都换成玩家名（挑一张卡当自己时，这些宏都指本人） */
function substituteSelf(text, name) {
  const who = String(name || '').trim() || '你';
  return String(text)
    .replace(/\{\{char\}\}/gi, () => who)
    .replace(/\{\{user\}\}/gi, () => who)
    .replace(/<BOT>/gi, () => who)
    .replace(/<USER>/gi, () => who);
}

/** 玩家角色设定里的宏换成玩家名，拼成可注入的文本（纯函数） */
export function playerProfileForPrompt(convo) {
  const player = convoPlayer(convo);
  if (!player || !player.profile) return '';
  return substituteSelf(player.profile, player.name || convoUserName(convo));
}

// 把角色卡拼成「玩家角色」设定：描述 + 性格。不带 scenario —— 那是「这张卡当 NPC」的场景。
export function playerProfileFromCharacter(character) {
  if (!character) return '';
  const name = String(character.name || '').trim() || '你';
  const bits = [];
  const desc = String(character.description || '').trim();
  const personality = String(character.personality || '').trim();
  if (desc) bits.push(substituteSelf(desc, name));
  if (personality) bits.push(`【性格】${substituteSelf(personality, name)}`);
  return bits.join('\n');
}

/** {{user}} 的替换值：进了世界的会话用玩家角色的名字，其它会话用设置里的名字 */
export function convoUserName(convo) {
  const player = convoPlayer(convo);
  return player && player.name ? player.name : userName();
}

// 按 id 找卡：先角色卡，再本会话世界书里的副本（面板 owner 存的就是这两类 id）。
export function findCardById(convo, id) {
  const target = String(id || '').trim();
  if (!target) return null;

  const direct = characterById(target);
  if (direct) return direct;

  for (const bookId of effectiveWorldbookIds(convo)) {
    const book = worldbookById(bookId);
    const found = book
      ? worldbookCharacters(book).find((c) => c && c.id === target)
      : null;
    if (found) return found;
  }
  return null;
}

// 已停用的场景 owner：老数据读到 'scene' 按无主处理，别再新增。
const SCENE_OWNER = 'scene';

// 本局有状态的每个人：玩家永远第一，其余是要显示的角色卡（世界书副本看 showInPanel）。
// card 给状态卡取立绘/表情；入口条别直接用，走 panelCastForDisplay。
export function panelEntities(convo) {
  if (!convo) return [];

  const out = [];
  const seen = new Set();

  const player = convoPlayer(convo);
  // 「我」的卡：优先玩家挑的角色卡卡；挑的是世界书副本时按名字在本会话书里找回。
  let playerCard = player && player.characterId ? characterById(player.characterId) : null;
  if (!playerCard && player) {
    const playerName = convoUserName(convo);
    for (const bookId of effectiveWorldbookIds(convo)) {
      const book = worldbookById(bookId);
      const copy = book
        ? worldbookCharacters(book).find((c) => c && String(c.name || '').trim() === playerName)
        : null;
      if (copy) {
        playerCard = copy;
        break;
      }
    }
  }
  out.push({
    owner: 'player',
    kind: 'player',
    name: convoUserName(convo),
    avatar: (playerCard && playerCard.avatar) || '',
    card: playerCard || null
  });
  seen.add('player');

  // 单卡会话绑的卡永远显示。⚠️ 不能拿「玩家有没有设身份」当条件 —— 否则它会掉进
  // showsInPanel（默认 false）被过滤，入口条只剩「我」。
  // ⚠️ 也不能只做「豁免」：这里遍历的是**字段**，卡一个字段都不持有时（属性归副本后很常见）
  //    根本不会被遍历到，得在下面补一次。
  const soloCardId = convo.characterId ? String(convo.characterId) : '';

  for (const name of convoPanelFields(convo)) {
    const owner = panelFieldOwner(convo, name);
    // 无主字段不归任何人（老数据里的 'scene' 也当无主跳过）。
    if (!owner || owner === SCENE_OWNER) continue;
    if (seen.has(owner)) continue;

    const card = findCardById(convo, owner);
    // 世界书副本要勾了「在状态栏显示」才出头像；单卡会话绑的那张豁免。
    if (owner !== soloCardId && !showsInPanel(card)) continue;

    seen.add(owner);
    out.push({
      owner,
      kind: 'character',
      name: (card && card.name) || owner,
      avatar: (card && card.avatar) || '',
      card: card || null
    });
  }

  if (soloCardId && !seen.has(soloCardId)) {
    const card = findCardById(convo, soloCardId);
    seen.add(soloCardId);
    out.push({
      owner: soloCardId,
      kind: 'character',
      name: (card && card.name) || soloCardId,
      avatar: (card && card.avatar) || '',
      card: card || null
    });
  }

  return out;
}

// 入口条显示名单：「我」只出现在世界（GM）局，普通聊天是「跟模型对话」，玩家不是场上角色。
export function panelCastForDisplay(convo) {
  if (!convo) return [];
  const entities = panelEntities(convo);
  if (isGmMode(convo)) return entities;
  return entities.filter((e) => e.owner !== 'player');
}

// 助手那侧显示成谁：绑卡 → 角色名（GM 局的卡是主角）；没绑卡 → 默认人设的名字。
export function speakerName(convo) {
  const character = characterForConvo(convo);
  if (character) return character.name;
  return assistantName(convo);
}

// 名单太长会吃掉上下文，给个总预算；单个 NPC 的描述也截一下
const MAX_CAST_CHARS = 3000;
const MAX_CAST_PER_NPC = 160;

// 副本是不是玩家本人：只按名字判定，同名的副本不当 NPC，否则 GM 名单出现两个同名。
export function isPlayerCharacterCopy(convo, character) {
  if (!convo || !character) return false;
  const playerName = convoUserName(convo);
  return String(character.name || '').trim() === playerName;
}

// 「这个世界的人」：把书里的副本列给 GM（有长度上限）；与玩家同名的副本标成玩家扮演。
// ⚠️ 书的范围走 effectiveWorldbookIds：角色卡开局不把书拷进会话，这里不回落就会漏掉整本书的人。
export function worldbookCast(convo) {
  const books = effectiveWorldbookIds(convo)
    .map((id) => worldbookById(id))
    .filter(Boolean);
  const cast = books.flatMap((b) => worldbookCharacters(b));
  if (!cast.length) return '';

  const playerName = convoUserName(convo);
  const heroName = String((characterForConvo(convo) || {}).name || '').trim();
  const npcCopies = cast.filter((c) =>
    !isPlayerCharacterCopy(convo, c) &&
    !(heroName && String(c && c.name || '').trim() === heroName)
  );
  const npcTotal = npcCopies.length;

  const lines = [];
  let total = 0;
  let npcCount = 0;

  for (const c of npcCopies) {
    npcCount += 1;

    const bits = [c.description, c.personality]
      .map((s) => String(s || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .join(' ');
    const line = `- ${c.name}：${bits.slice(0, MAX_CAST_PER_NPC) || '（没写设定）'}`;

    if (total + line.length > MAX_CAST_CHARS) {
      const remaining = npcTotal - npcCount + 1;
      lines.push(`- （还有 ${remaining} 人没列出）`);
      break;
    }
    lines.push(line);
    total += line.length;
  }

  // 玩家本人明确点出来，和 NPC 名单分开 —— 免得模型把主角当 NPC 之一
  const header =
    `【这个世界的人】\n` +
    `「${playerName}」是玩家本人扮演的主角，不是 NPC —— 不要把他/她当成别的 NPC 来描写或替他说话。\n` +
    (lines.length ? `以下角色是你扮演的 NPC，各自有各自的立场、语气和说话习惯：\n` : '');
  return header + lines.join('\n');
}

// GM 局给主要角色的设定上限：卡描述可能几千字，比 NPC 名单宽，但仍要有顶
const MAX_FOCUS_CHARS = 4000;

/**
 * GM 局里绑定的角色卡 = 本局主要角色。单列一段给叙述者 —— 不列的话 GM 不知道这一局围绕谁开。
 * 卡自带的书里已有同名副本时**让位**（副本带属性/形象更全，cast 名单已覆盖），再写就是同一个人两份设定。
 * 单角色扮演（非 GM）不走这里：那条路在 messages.js 里整卡注入。
 */
export function focusCharacterSection(convo) {
  if (!isGmMode(convo)) return '';
  const character = characterForConvo(convo);
  if (!character) return '';

  const cardName = String(character.name || '').trim();
  if (!cardName) return '';

  const matchingCopies = effectiveWorldbookIds(convo)
    .map((id) => worldbookById(id))
    .filter(Boolean)
    .flatMap((book) => worldbookCharacters(book))
    .filter((copy) => copy && String(copy.name || '').trim() === cardName);

  const me = convoUserName(convo);
  // 卡正文里的宏：{{char}} 指这张卡，{{user}} 指玩家（和单角色扮演同一套口径）
  const fix = (s) =>
    String(s || '')
      .trim()
      .replace(/\{\{char\}\}/gi, () => cardName)
      .replace(/\{\{user\}\}/gi, () => me)
      .replace(/<BOT>/gi, () => cardName)
      .replace(/<USER>/gi, () => me);

  const bits = [];
  const copyField = (field) => matchingCopies
    .map((copy) => String(copy[field] || '').trim())
    .reduce((merged, value) => mergePromptText(merged, value), '');
  const desc = fix(mergePromptText(copyField('description'), character.description));
  const personality = fix(mergePromptText(copyField('personality'), character.personality));
  const scenario = fix(mergePromptText(copyField('scenario'), character.scenario));
  if (desc) bits.push(desc.slice(0, MAX_FOCUS_CHARS));
  if (personality) bits.push(`【性格】${personality}`);
  if (scenario) bits.push(`【当前场景】${scenario}`);

  // 只有名字的卡也要列出来 —— 不列的话叙述者根本不知道这一局围着谁开
  return (
    `【本局主要角色】\n` +
    `「${cardName}」是这一局的核心角色，由你扮演（不是玩家本人）：\n` +
    (bits.length ? bits.join('\n') : '（这张卡没写设定，按名字和对话即兴）')
  );
}
