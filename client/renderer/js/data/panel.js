'use strict';

// 状态栏（世界模型的状态）：解析 / 归一化 / 夹取 / 注入，纯逻辑，不碰 DOM。
// 字段身份 = 字段名 + owner；类型/范围规则由 main/panel-fields.js 定义（主进程同一份）。

import { now, asArray } from '../core/util.js';
import {
  clampFieldValue,
  normalizePanelField,
  groupPanelFields,
  describePanelField,
  trimNumber
} from '../core/panel-fields.js';
// 写入口改完值要落盘：data 层里 panel → persist 是单向依赖，不成环。
import { persistConversations } from './persist.js';
// 种字段要读卡上的 attributes；复合键还要「owner id → 角色名」的解析。
import {
  characterAttrs,
  characterById,
  characters,
  convoWorldbookIds,
  worldbookById,
  worldbookCharacters
} from './library.js';
// 表情标签也要从正文剥掉，「长什么样」只有 expressions.js 知道。
import { stripEmoTags } from './expressions.js';

// 字段行：全角/半角冒号都认；字段名限 24 字内，避免长句被误认成字段。
const PANEL_LINE_RE = /^【([^】\n]+)】[：:]\s*(.*)$/;
// 超过 200 字的行更像正文，不当面板
const PANEL_LINE_MAX = 200;
// 未知字段的值超过 60 字就不当面板（首轮扫描的兜底）
const PANEL_GUESS_VALUE_MAX = 60;

// 明确不当面板的字段名：注入的提示词段落或渲染标记。
// ⚠️「剧情选项」必须在这里（程序读的指令行），且只能写字面量：OPTIONS_LABEL 在下面，提前引用会触发 TDZ。
const PANEL_RESERVED = new Set([
  '心理', '内心', '心声', '旁白', '上帝视角', '全知',
  '扮演规则', '主持规则', '当前场景', '世界设定', '参考信息', '叙述要求',
  '剧情选项'
]);

export const MAX_PANEL_FIELDS = 120;

// 字段身份 = 字段名 + owner（owner 空 = 场景字段，键为纯字段名，兼容老数据）。
// ⚠️ 键里用 \u0000 分隔：它不会出现在字段名或角色 id 里，天然不撞。
const OWNER_SEP = '\u0000';

export function panelKey(name, owner) {
  const n = String(name == null ? '' : name);
  const o = typeof owner === 'string' && owner ? owner : '';
  return o ? `${n}${OWNER_SEP}${o}` : n;
}

export function panelKeyParts(key) {
  const k = String(key == null ? '' : key);
  const i = k.indexOf(OWNER_SEP);
  return i < 0 ? { name: k, owner: '' } : { name: k.slice(0, i), owner: k.slice(i + 1) };
}

export function panelFieldName(key) {
  return panelKeyParts(key).name;
}

/** owner id → 显示名：'player' → 玩家名（没进世界退回「我」），空/查不到 → 空串 */
export function panelOwnerLabel(convo, owner) {
  const o = String(owner == null ? '' : owner);
  if (!o) return '';

  if (o === 'player') {
    const p = convo && convo.player;
    const n = String((p && p.name) || '').trim();
    return n || '我';
  }

  const card = findCardForOwner(convo, o);
  return (card && card.name) || o;
}

/** owner id → 卡对象：先角色库，再本会话世界书副本（不能 import cast，会成环） */
function findCardForOwner(convo, id) {
  const target = String(id || '').trim();
  if (!target) return null;

  // 'player' 不是卡 id：挑一张卡当自己后，要顺着它找到那张卡。
  if (target === 'player') {
    const picked = convo && convo.player && convo.player.characterId;
    return picked ? findCardForOwner(convo, picked) : null;
  }

  const direct = characterById(target);
  if (direct) return direct;

  if (convo) {
    for (const bookId of convoWorldbookIds(convo)) {
      const book = worldbookById(bookId);
      const found = book ? worldbookCharacters(book).find((c) => c && c.id === target) : null;
      if (found) return found;
    }
  }
  return null;
}

/** 注入用显示名：仅当同名字段被多个 owner 共用时才拼「角色名·字段名」 */
function panelFieldDisplayName(convo, key, hasClash) {
  const { name, owner } = panelKeyParts(key);
  if (!owner) return name;
  if (!hasClash || !hasClash(name)) return name;
  const label = panelOwnerLabel(convo, owner);
  return label ? `${label}·${name}` : name;
}

function clashingFieldNames(convo) {
  const owners = new Map();
  for (const key of convoPanelFields(convo)) {
    const { name, owner } = panelKeyParts(key);
    if (!owner) continue;
    if (!owners.has(name)) owners.set(name, new Set());
    owners.get(name).add(owner);
  }
  const clash = new Set();
  for (const [name, set] of owners) {
    if (set.size > 1) clash.add(name);
  }
  return clash;
}

/** 分隔角色名和字段名的点（注入时用「·」拼，扫描时按它拆） */
const OWNER_LABEL_SEP = '·';

/** 把「角色名·字段名」拆成 { owner, name }：拆不开就当无归属，不丢数据 */
function parseFieldLabel(convo, label) {
  const text = String(label == null ? '' : label).trim();
  const i = text.indexOf(OWNER_LABEL_SEP);
  if (i <= 0) return { owner: '', name: text };

  const head = text.slice(0, i).trim();
  const name = text.slice(i + 1).trim();
  if (!head || !name) return { owner: '', name: text };

  // 反查：head 是某个在场角色的名字（或玩家名）吗？
  const owner = ownerIdByLabel(convo, head);
  return owner ? { owner, name } : { owner: '', name: text };
}

export function ownerIdByLabel(convo, label) {
  const text = String(label || '').trim();
  if (!text || !convo) return '';

  const p = convo.player;
  if (p && String(p.name || '').trim() === text) return 'player';

  // ⚠️ 玩家没填名字时前缀是「我」，必须认回来 —— 否则会多出一条重复的无主字段。
  // 放在按名字找角色之前：真有角色叫「我」时按玩家优先，回读才自洽。
  if (!p || !String(p.name || '').trim()) {
    if (text === panelOwnerLabel(convo, 'player')) return 'player';
  }

  for (const key of convoPanelFields(convo)) {
    const owner = panelKeyParts(key).owner;
    if (owner && owner !== 'player' && panelOwnerLabel(convo, owner) === text) return owner;
  }

  // 绑定的卡优先：角色库里可能有同名卡。
  const boundId = String(convo.characterId || '').trim();
  if (boundId) {
    const bound = characterById(boundId);
    if (bound && String(bound.name || '').trim() === text) return bound.id;
  }

  // ⚠️ 角色库必须按名字找（characterById 只认 id），否则前缀永远拆不开。
  const inLibrary = characters().find((c) => c && String(c.name || '').trim() === text);
  if (inLibrary) return inLibrary.id;

  for (const bookId of convoWorldbookIds(convo)) {
    const book = worldbookById(bookId);
    if (!book) continue;
    const found = worldbookCharacters(book).find((c) => c && String(c.name || '').trim() === text);
    if (found) return found.id;
  }
  return '';
}

/** 字段分组名：只认 panelDefs 里的 group，没有就是空串 */
export function panelFieldGroup(convo, key) {
  return (convoPanelDef(convo, key) || {}).group || '';
}

export const OPTIONS_LABEL = '剧情选项';
// 方括号可有可无：模型偶尔漏写「【剧情选项】」，两种都要能解析。
export const OPTIONS_LINE_RE = /^【?剧情选项】?[：:]\s*(.*)$/;

export function panelFieldAllowed(name) {
  return !PANEL_RESERVED.has(name) && !name.includes('的设定') && !name.includes('的性格');
}

/** 裸字段仍限 24 字；已知 owner 前缀不占字段名额度。 */
function panelLabelAllowed(label, known, convo) {
  if (!panelFieldAllowed(label)) return false;
  if (label.length <= 24) return true;
  if (known && known.has(label)) {
    const i = label.indexOf(OWNER_LABEL_SEP);
    if (i > 0 && label.slice(i + 1).trim().length <= 24) return true;
  }
  if (!convo) return false;
  const parsed = parseFieldLabel(convo, label);
  return !!parsed.owner && parsed.name.length <= 24 && panelFieldAllowed(parsed.name);
}

/** 抽面板字段（保序）：给了 knownFields 就只收这些名字，首轮才按「值短」猜 */
function extractPanelFromText(text, knownFields, convo) {
  const known = knownFields && knownFields.length ? new Set(knownFields) : null;
  const found = new Map();

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim().replace(/^[-*+]\s+/, '');
    if (line.length > PANEL_LINE_MAX) continue;

    const m = line.match(PANEL_LINE_RE);
    if (!m) continue;

    const name = m[1].trim();
    if (!name || !panelLabelAllowed(name, known, convo)) continue;

    const value = m[2].trim();

    if (!known && value.length > PANEL_GUESS_VALUE_MAX) continue;
    if (known && !known.has(name) && value.length > PANEL_GUESS_VALUE_MAX) continue;

    found.set(name, value.slice(0, 500));
    if (found.size >= MAX_PANEL_FIELDS) break;
  }

  return found;
}

function compileStripContext(fields, groups) {
  const fieldSet = fields && fields.length ? new Set(fields) : null;
  const groupSet = groups && groups.length ? new Set(groups) : null;
  return { fieldSet, groupSet };
}

function stripPanelLinesWith(text, known) {
  const source = String(text || '');
  if (!source.trim()) return source;

  const out = source
    .split('\n')
    .filter((rawLine) => {
      const line = rawLine.trim().replace(/^[-*+]\s+/, '');
      if (line.length > PANEL_LINE_MAX) return true;

      const m = line.match(PANEL_LINE_RE);
      if (!m) return true;

      const name = m[1].trim();
      if (!name || !panelLabelAllowed(name, known)) return true;

      if (known) return !known.has(name);

      return m[2].trim().length > PANEL_GUESS_VALUE_MAX;
    });

  return collapseBlankLines(out.join('\n')).trim();
}

/** 剥掉面板行：面板由程序权威注入，历史里再留一份只会烧 token 并可能冲突 */
export function stripPanelLines(text, knownFields) {
  const known = knownFields && knownFields.length ? new Set(knownFields) : null;
  return stripPanelLinesWith(text, known);
}

/** 会话里的分组名（注入 `—— 组名 ——` 小标题的来源）；只剥已知组名，避免误删正文 */
export function panelGroupNames(convo) {
  const names = new Set();
  const defs = convoPanelDefs(convo);
  for (const key of Object.keys(defs)) {
    const g = (defs[key] || {}).group;
    if (g) names.add(g);
  }
  return names;
}

const GROUP_HEADER_RE = /^——\s*([^—\n]{1,24})\s*——$/;

/** 裸方括号组名 `【组名】`：模型写回的变体，同样只剥 knownGroups 里的 */
const GROUP_BRACKET_RE = /^【\s*([^】【\n]{1,24})\s*】$/;

// 状态块抬头：注入用 ASCII `[当前状态]`，模型可能写成全角 `【当前状态】`。
const STATUS_HEADER_RE = /^[\[【]\s*当前状态\s*[\]】]$/;

/** 剥分组小标题：`—— 组名 ——` 和 `【组名】`，只剥 knownGroups 里的 */
function stripPanelGroupHeadersWith(text, known) {
  const source = String(text || '');
  if (!source.trim()) return source;
  if (!known || !known.size) return source;

  const out = source.split('\n').filter((rawLine) => {
    const line = rawLine.trim();
    let m = line.match(GROUP_HEADER_RE);
    if (m) return !known.has(m[1].trim());
    m = line.match(GROUP_BRACKET_RE);
    if (m) return !known.has(m[1].trim());
    return true;
  });

  return collapseBlankLines(out.join('\n')).trim();
}

function collapseBlankLines(text) {
  return String(text || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** 剥掉「【剧情选项】：…」行 —— 已解析成按钮，正文再留一份是重复 */
function stripOptionsLine(text) {
  const source = String(text || '');
  if (!source.includes(OPTIONS_LABEL)) return source;

  const out = source.split('\n').filter((rawLine) => !OPTIONS_LINE_RE.test(rawLine.trim()));
  return collapseBlankLines(out.join('\n')).trim();
}

/** 剥掉「[当前状态] / 【当前状态】」抬头（程序注入的块标题） */
function stripStatusHeader(text) {
  const source = String(text || '');
  if (!source.trim()) return source;
  const out = source.split('\n').filter((rawLine) => !STATUS_HEADER_RE.test(rawLine.trim()));
  return collapseBlankLines(out.join('\n')).trim();
}

/** 给模型/界面看的正文：剥掉抬头、面板行、分组标题、剧情选项行、表情标签 */
export function cleanAssistantText(text, panelFields, knownGroups) {
  return compileAssistantCleaner(panelFields, knownGroups)(text);
}

/** 编译清理函数；各步的清理顺序不能改 */
export function compileAssistantCleaner(panelFields, knownGroups) {
  const { fieldSet, groupSet } = compileStripContext(panelFields, knownGroups);
  return (text) => stripEmoTags(
    stripStatusHeader(
      stripOptionsLine(stripPanelGroupHeadersWith(stripPanelLinesWith(text, fieldSet), groupSet))
    )
  );
}

/** 状态块行：【…】、—— … ——、[当前状态、剧情选项、<emo> 开头 */
function isStatusBlockLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('【')) return true;
  if (t.startsWith('——')) return true;
  if (t.startsWith('[当前状态')) return true;
  if (t.startsWith('剧情选项')) return true;
  if (/^<\s*emo\b/i.test(t)) return true;
  return false;
}

/** 流式显示：从第一个状态行起整体截断（逐 token 走 cleanAssistantText 会抖动）。
 *  ⚠️ knownFields 不可省 —— 否则【心理】起头的正文段落会被整段砍掉。 */
export function cutTrailingStatusBlock(text, knownFields, knownGroups) {
  const lines = String(text || '').split('\n');

  // 只认会话里真实存在的字段名；没传就退回「不砍」—— 宁可多显示，也不误砍正文。
  const known = new Set(
    asArray(knownFields)
      .map((n) => String(n || '').trim())
      .filter(Boolean)
      .map((n) => n.replace(/^【|】$/g, ''))
  );

  // 分组名同理：没传就一律当正文，宁可多显示。
  const groups = new Set(
    asArray(knownGroups)
      .map((n) => String(n || '').trim())
      .filter(Boolean)
  );

  const isPanelFieldLine = (line) => {
    const t = line.trim();
    const m = t.match(/^【([^】]+)】(.*)$/);
    if (!m) return false;
    const name = m[1].trim();
    const rest = m[2].trim();
    // 有值、有冒号，或这个名字本来就是本局的字段 → 状态行。
    // ⚠️ 带冒号时必须再判 panelFieldAllowed：否则【心理】：… 会把正文整段吞掉。
    if (/^[:：]/.test(rest)) return panelFieldAllowed(name);
    return known.has(name);
  };

  // 只认已知分组的小标题：中文正文常以「——」开头，见「——」就砍会吞掉正文。
  // 流式时收尾的「——」可能还没到，所以已知组名的前缀也算。
  const isGroupHeaderLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('——')) return false;
    if (!groups.size) return false;
    const m = t.match(GROUP_HEADER_RE);
    const name = m ? m[1].trim() : t.replace(/^——\s*/, '').replace(/\s*——$/, '').trim();
    if (!name) return false;
    if (groups.has(name)) return true;
    for (const g of groups) {
      if (g.startsWith(name)) return true;
    }
    return false;
  };

  let cut = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith('——')) {
      if (isGroupHeaderLine(line)) {
        cut = i;
        break;
      }
      continue;
    }
    // 【】开头交给字段名判定（正文小标题不砍）
    if (t.startsWith('【')) {
      if (isPanelFieldLine(line)) {
        cut = i;
        break;
      }
      continue;
    }
    if (isStatusBlockLine(line)) {
      cut = i;
      break;
    }
  }
  // 正文里（不在末尾）出现标签时行级截断兜不住，这里再抹一道
  return stripEmoTags(lines.slice(0, cut).join('\n'));
}

export function convoPanelFields(convo) {
  return asArray(convo && convo.panelFields);
}

export function convoPanel(convo) {
  return convo && convo.panel && typeof convo.panel === 'object' ? convo.panel : {};
}

/** 字段定义表（名字 → {type,min,max,hint}）；存在会话上，老会话没有就是 {} */
export function convoPanelDefs(convo) {
  return convo && convo.panelDefs && typeof convo.panelDefs === 'object' ? convo.panelDefs : {};
}

// 只留真正能用的定义：坏定义会让夹取算出乱值。
// 兼容纯字段名键（owner 在 def.owner）和复合键，两种都归一成复合键。
export function normalizePanelDefs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const out = {};
  let count = 0;
  for (const rawKey of Object.keys(value)) {
    if (count >= MAX_PANEL_FIELDS) break;
    const raw = value[rawKey];
    if (!raw || typeof raw !== 'object') continue;

    const { name, owner: keyOwner } = panelKeyParts(rawKey);
    const owner = (raw.owner && typeof raw.owner === 'string' ? raw.owner : keyOwner) || '';

    const def = normalizePanelField({ ...raw, name, owner, value: '' });
    if (!def) continue;
    // 纯 text 且无范围/hint 的定义等价于没有；但 group / owner 本身有意义，不能丢。
    // ⚠️ 丢了 group/owner，重启后字段会散回「未分组」、玩家字段也拆不出来。
    const hasRange = typeof def.min === 'number' || typeof def.max === 'number';
    const hasMode = def.mode && def.mode !== 'dynamic';
    if (def.type === 'text' && !def.hint && !hasRange && !def.group && !def.owner && !hasMode) continue;

    const key = panelKey(def.name, def.owner);
    out[key] = {
      type: def.type,
      ...(typeof def.min === 'number' ? { min: def.min } : {}),
      ...(typeof def.max === 'number' ? { max: def.max } : {}),
      ...(def.hint ? { hint: def.hint } : {}),
      ...(def.group ? { group: def.group } : {}),
      ...(def.owner ? { owner: def.owner } : {}),
      ...(def.mode && def.mode !== 'dynamic' ? { mode: def.mode } : {})
    };
    count += 1;
  }
  return out;
}

export function convoPanelDef(convo, name) {
  const def = convoPanelDefs(convo)[name];
  return def && typeof def === 'object' ? def : null;
}

// 归属以存储键里的 owner 为准；老数据（纯字段名键）退回 def.owner。
export function panelFieldOwner(convo, key) {
  const fromKey = panelKeyParts(key).owner;
  if (fromKey) return fromKey;
  const owner = (convoPanelDef(convo, key) || {}).owner;
  return typeof owner === 'string' && owner ? owner : '';
}

/** 会话里去重的显示名（有归属冲突才是「角色名·字段名」），用作 knownFields */
export function convoFieldDisplayNames(convo) {
  const clash = clashingFieldNames(convo);
  const seen = new Set();
  const out = [];
  for (const key of convoPanelFields(convo)) {
    const dn = panelFieldDisplayName(convo, key, (name) => clash.has(name));
    if (dn && !seen.has(dn)) {
      seen.add(dn);
      out.push(dn);
    }
  }
  return out;
}

/** 按字段范围夹值；没有定义 / 非数值原样返回。defs 可显式传入（同步历史时用新的） */
function clampPanelValue(convo, name, value, defs) {
  const table = defs && typeof defs === 'object' ? defs : convoPanelDefs(convo);
  const def = table[name];
  if (!def || typeof def !== 'object') return value;
  return clampFieldValue(value, def).value;
}

// 累积而非重建：角色卡种入的和手动加的字段，这一轮模型没提到也要留着。
// 自愈：把落盘的「角色名·好感度」并回复合键，只在 owner 对得上且目标键已存在时合并。
function healPrefixedKeys(convo) {
  const fields = convoPanelFields(convo);
  if (!fields.length) return false;

  const panel = { ...convoPanel(convo) };
  const remove = new Set();
  const manual =
    convo.panelManual && typeof convo.panelManual === 'object' ? convo.panelManual : null;

  for (const key of fields) {
    const { name, owner } = panelKeyParts(key);
    if (!name.includes(OWNER_LABEL_SEP)) continue;

    const i = name.indexOf(OWNER_LABEL_SEP);
    const head = name.slice(0, i).trim();
    const rest = name.slice(i + 1).trim();
    if (!head || !rest) continue;

    // 老数据键里 owner 可能为空：按前缀反查；已有 owner 时仍核对前缀，避免误并。
    let resolvedOwner = owner;
    if (!resolvedOwner) {
      resolvedOwner = ownerIdByLabel(convo, head);
    } else if (ownerIdByLabel(convo, head) !== resolvedOwner) {
      continue;
    }
    if (!resolvedOwner) continue;

    const target = panelKey(rest, resolvedOwner);
    if (!fields.includes(target)) continue;

    // 手改过的以面板里的为准；否则用这份 —— 它是模型最近写进来的
    if (!(manual && manual[target]) && String(panel[key] || '').trim()) {
      panel[target] = panel[key];
    }
    if (manual && manual[key] && !manual[target]) manual[target] = manual[key];
    if (manual) delete manual[key];
    remove.add(key);
  }

  if (!remove.size) return false;

  const defs = { ...convoPanelDefs(convo) };
  convo.panelFields = fields.filter((key) => !remove.has(key));
  convo.panel = panel;
  for (const key of remove) {
    delete panel[key];
    delete defs[key];
  }
  convo.panelDefs = defs;
  return true;
}

export function syncConvoPanel(convo) {
  if (!convo || !Array.isArray(convo.messages)) return false;

  // 先并把老数据里重复的字段，再按正常流程扫
  healPrefixedKeys(convo);

  const beforeFields = convoPanelFields(convo).join('\u0001');
  const beforePanel = JSON.stringify(convoPanel(convo));

  const existingFields = convoPanelFields(convo);
  const existingPanel = convoPanel(convo);

  // 先保留已有字段，新字段追加在后；顺手剔掉保留名（老会话脏字段自愈）。
  const order = existingFields.filter((key) => panelFieldAllowed(panelFieldName(key)));
  const defs = { ...convoPanelDefs(convo) };
  // 定义表也要清：留着脏字段的定义，剥旧消息时还会被当成已知字段。
  for (const key of Object.keys(defs)) {
    if (!panelFieldAllowed(panelFieldName(key))) delete defs[key];
  }

  const keySet = new Set(order);
  // knownFields 必须用显示名：注入和模型照抄的都是它，否则带前缀的字段会被误 skip。
  const clash = clashingFieldNames(convo);
  const knownNames = [];
  const known = new Set();
  for (const key of order) {
    const dn = panelFieldDisplayName(convo, key, (name) => clash.has(name));
    if (dn && !known.has(dn)) {
      known.add(dn);
      knownNames.push(dn);
    }
  }
  const latest = new Map();
  let updateOrder = 0;
  // 手改过的字段 → 改动时刻。重扫历史时，比它早写的回复不许覆盖（见 markPanelManual）
  const manualTable = convo.panelManual && typeof convo.panelManual === 'object' ? convo.panelManual : {};

  for (const msg of convo.messages) {
    if (!msg || msg.role !== 'assistant') continue;
    const content = String(msg.content || '');
    if (!content.includes('【')) continue;

    const found = extractPanelFromText(content, knownNames, convo);
    for (const [rawName, value] of found) {
      // 模型可能带「角色名·字段名」前缀：拆出归属，拆不开就退回无主字段。
      const { owner, name } = parseFieldLabel(convo, rawName);
      const key = panelKey(name, owner);

      if (!keySet.has(key)) {
        if (order.length >= MAX_PANEL_FIELDS) continue;
        order.push(key);
        keySet.add(key);
        // 新字段按值形状补定义（「63/100」→ meter），否则永远没有进度条/范围。
        if (!defs[key]) {
          const inferred = inferPanelDef(value);
          if (inferred) {
            const d = { ...inferred };
            if (owner) d.owner = owner;
            defs[key] = d;
          }
        }
        if (!known.has(rawName)) {
          known.add(rawName);
          knownNames.push(rawName);
        }
      }
      // 手改过的字段只认改动之后的回复；时间戳缺失 / 老的 true 按 0＝不设限。
      const editedAt = Number(manualTable[key]) || 0;
      if (!editedAt || Number(msg.at || 0) > editedAt) {
        latest.set(key, { value, at: Number(msg.at || 0), order: ++updateOrder });
      }
    }
  }

  // 历史值优先，没扫到就沿用现有；数值在这里夹回范围，否则下一轮会照抄越界值。
  const panel = {};
  for (const key of order) {
    const value = latest.has(key) ? latest.get(key).value : existingPanel[key];
    if (value !== undefined) panel[key] = clampPanelValue(convo, key, value, defs);
  }

  convo.panelFields = order;
  convo.panel = panel;
  convo.panelDefs = defs;

  // 收尾：AI 没带前缀的无主字段并回主角（入口条已无「世界」卡）。
  absorbTopLevelIntoPlayer(convo, latest);

  const afterFields = convoPanelFields(convo).join('\u0001');
  return beforeFields !== afterFields || beforePanel !== JSON.stringify(convoPanel(convo));
}

// 无主字段认领顺序：卡上声明过→那张卡；单角色聊天→绑卡；其余→主角。
// 认不出主角时原样不动；幂等，返回是否改动。
export function absorbTopLevelIntoPlayer(convo, latest) {
  if (!convo) return false;
  if (!absorbingOwnerName(convo)) return false;

  const ownerOf = (key) => panelFieldOwner(convo, key);
  const orphans = convoPanelFields(convo).filter((key) => !ownerOf(key));
  if (!orphans.length) return false;

  // 只算本局真实持有字段的 owner，避免把没进这局的卡也算进来。
  const ownerByFieldName = new Map();
  const activeOwners = new Set(convoPanelFields(convo).map(ownerOf).filter(Boolean));
  // 「我」最后认领：同名字段历史上归角色，但玩家卡写死的字段名不能被别人认走。
  const claimOrder = [...activeOwners].filter((owner) => owner !== 'player');
  claimOrder.push('player');
  for (const owner of claimOrder) {
    const card = findCardForOwner(convo, owner);
    if (!card) continue;
    for (const attr of characterAttrs(card)) {
      const n = String((attr && attr.name) || '').trim();
      if (n && !ownerByFieldName.has(n)) ownerByFieldName.set(n, owner);
    }
  }

  // 手加字段不一定在卡模板里：裸名只对应一个既有 owner 时保留归属。
  const uniqueOwnerByName = new Map();
  for (const key of convoPanelFields(convo)) {
    const owner = ownerOf(key);
    if (!owner) continue;
    const name = panelFieldName(key);
    if (!uniqueOwnerByName.has(name)) uniqueOwnerByName.set(name, owner);
    else if (uniqueOwnerByName.get(name) !== owner) uniqueOwnerByName.set(name, '');
  }

  // 单角色聊天（绑卡且非 GM）→ 无主字段全归那张卡；不要求它已持有字段。
  const soloCard =
    convo.characterId && convo.gmMode !== true
      ? findCardForOwner(convo, convo.characterId)
      : null;
  const soloOwner = soloCard ? String(convo.characterId) : '';

  const fields = [...convoPanelFields(convo)];
  const panel = { ...convoPanel(convo) };
  const defs = { ...convoPanelDefs(convo) };
  const remove = new Set();
  const canReplace = (key, target) => {
    const source = latest && latest.get(key);
    const current = latest && latest.get(target);
    // 历史顺序决定新旧；裸名只是同一字段的别名，不能在归属时压过较新的前缀记录。
    if (current && (!source || current.order >= source.order)) return false;
    const editedAt = Number(convo.panelManual && convo.panelManual[target]) || 0;
    return !editedAt || !!(source && source.at > editedAt);
  };

  const claim = (key, owner) => {
    const fieldName = panelFieldName(key);
    const value = panel[key];
    const target = panelKey(fieldName, owner);
    if (fields.includes(target)) {
      // 已有同名字段：用这一轮的无主值覆盖，手改过的除外
      if (canReplace(key, target) && String(value || '').trim()) {
        panel[target] = clampPanelValue(convo, target, value, defs);
      }
    } else if (fields.length < MAX_PANEL_FIELDS) {
      fields.push(target);
      if (value !== undefined) panel[target] = value;
      if (defs[key]) defs[target] = { ...defs[key], owner };
    } else {
      // ⚠️ 字段数到顶时认领不成立，必须直接 return 不能 remove：
      // 否则无主字段会被直接删掉（曾把 120 个字段塌成 1 个）。
      return;
    }
    remove.add(key);
  };

  for (const key of orphans) {
    const fieldName = panelFieldName(key);

    const cardOwner = ownerByFieldName.get(fieldName);
    if (cardOwner) {
      claim(key, cardOwner);
      continue;
    }

    const existingOwner = uniqueOwnerByName.get(fieldName);
    if (existingOwner) {
      claim(key, existingOwner);
      continue;
    }

    if (soloOwner) {
      claim(key, soloOwner);
      continue;
    }

    const target = panelKey(fieldName, 'player');
    if (fields.includes(target)) {
      // 主角已有同名字段：空的用无主值填；玩家手改过保留；否则这一轮的值覆盖。
      const had = String(panel[target] || '').trim();
      const now = String(panel[key] || '').trim();
      if (canReplace(key, target) && (had || now)) {
        panel[target] = clampPanelValue(convo, target, panel[key], defs);
      }
      remove.add(key);
    } else if (fields.length < MAX_PANEL_FIELDS) {
      const newKey = panelKey(fieldName, 'player');
      fields.push(newKey);
      if (panel[key] !== undefined) panel[newKey] = panel[key];
      if (defs[key]) defs[newKey] = { ...defs[key], owner: 'player' };
      remove.add(key);
    }
  }

  if (!remove.size) return false;

  convo.panelFields = fields.filter((key) => !remove.has(key));
  convo.panel = panel;
  for (const key of remove) delete panel[key];
  for (const key of remove) delete defs[key];
  convo.panelDefs = defs;
  return true;
}

/** 主角的名字：绑卡用卡名，否则用玩家名；都拿不到返回空（不做合并） */
function absorbingOwnerName(convo) {
  const cardId = convo && convo.characterId;
  if (cardId) {
    const card = findCardForOwner(convo, cardId);
    const cardName = card && String(card.name || '').trim();
    if (cardName) return cardName;
  }
  const p = convo && convo.player;
  const playerName = p && String(p.name || '').trim();
  return playerName || '';
}

/** 手改字段值，并打上「手动改过」标记（下一轮扫描不会把它顶掉） */
export function setPanelField(convo, name, value) {
  if (!convo) return;
  const fields = [...convoPanelFields(convo)];
  if (!fields.includes(name)) fields.push(name);
  convo.panelFields = fields.slice(0, MAX_PANEL_FIELDS);

  const prev = String(convoPanel(convo)[name] == null ? '' : convoPanel(convo)[name]);
  const text = String(value == null ? '' : value).trim().slice(0, 500);
  // 输入框里只有分子，存的时候要把分母拼回去，否则改一次分母就永久丢了。
  const merged = mergeMeterValue(text, prev, convoPanelDef(convo, name));

  convo.panel = { ...convoPanel(convo), [name]: clampPanelValue(convo, name, merged) };
  markPanelManual(convo, name);
  convo.updatedAt = now();
  persistConversations(0);
}

// 记「手改时刻」而不是 true：全量重扫历史时，改之前那句旧值不许把手改打回去。
// 老会话里是 true → 读作 0＝不设限，等下次手改自然带上时刻。
function markPanelManual(convo, key) {
  if (!convo) return;
  const table = convo.panelManual && typeof convo.panelManual === 'object' ? convo.panelManual : {};
  convo.panelManual = { ...table, [key]: Date.now() };
}

/** 把纯分子和分母拼回「60/100」；只对 meter 且有 max 的字段生效 */
function mergeMeterValue(value, prev, def) {
  const text = String(value == null ? '' : value).trim();
  if (!text || !def || def.type !== 'meter' || typeof def.max !== 'number') return text;
  if (text.includes('/')) return text;

  // ⚠️ 先确认真的只是分子：否则「烦躁」会被存成「烦躁/100」，值坏掉、进度条也没了。
  if (!/^[-+]?\d+(?:\.\d+)?\s*[^\d\s]*$/.test(text)) return text;

  // 分母优先用旧值里的（可能和 max 不同，比如按比例的分数字段），没有就用 max
  const m = String(prev == null ? '' : prev).match(/^[-+]?\d+(?:\.\d+)?\s*\/\s*([-+]?\d+(?:\.\d+)?)$/);
  const total = m ? m[1] : trimNumber(def.max);
  return `${text}/${total}`;
}

/** 这一局绑定角色的名字（世界会话没绑卡 → 空） */
function boundCharacterLabel(convo) {
  const id = String((convo && convo.characterId) || '').trim();
  if (!id) return '';
  const card = findCardForOwner(convo, id);
  return (card && String(card.name || '').trim()) || '';
}

// 展开描述里的 {{char}}/<BOT>（字段主人）和 {{user}}/<USER>（对话另一方）。
// 玩家字段的「另一方」= 本局绑定角色，否则卡作者按 NPC 写的描述会指错人。
function panelMacroText(convo, owner, text) {
  const raw = String(text || '');
  if (!raw) return '';

  const self = panelOwnerLabel(convo, owner) || '';
  const playerLabel = panelOwnerLabel(convo, 'player') || '你';
  const other = owner === 'player' ? boundCharacterLabel(convo) || playerLabel : playerLabel;

  return raw
    .replace(/\{\{char\}\}/gi, () => self || other)
    .replace(/<BOT>/gi, () => self || other)
    .replace(/\{\{user\}\}/gi, () => other)
    .replace(/<USER>/gi, () => other);
}

function panelFieldLegend(convo, fields) {
  const clash = clashingFieldNames(convo);
  const lines = [];
  for (const key of fields) {
    const def = convoPanelDef(convo, key);
    if (!def) continue;
    const desc = describePanelField(def);
    if (!desc) continue;
    // 图例里也用「角色名·字段名」的显示名（有冲突时），和正文保持一致
    const name = panelFieldDisplayName(convo, key, (n) => clash.has(n));
    lines.push(`- ${name}：${panelMacroText(convo, panelKeyParts(key).owner, desc)}`);
  }
  return lines;
}

// 分组标题刻意用「—— 组名 ——」不用【】：用【关系】：会被面板解析器当成字段。
function panelGroupHeader(title) {
  return `—— ${title} ——`;
}

/** 从「63/100」的形状推断 meter 定义；刻意不推 min（分母只知道上限） */
function inferPanelDef(value) {
  const m = String(value == null ? '' : value).trim().match(/^([-+]?\d+(?:\.\d+)?)\s*\/\s*([-+]?\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const total = Number(m[2]);
  if (!Number.isFinite(total) || total <= 0) return null;

  return { type: 'meter', max: total };
}

// 状态表的开场白和收尾要求。
// ⚠️ 抬头刻意不做成【】/[] 标记：那种形状会被模型读成外部注入的指令，直接拒绝执行。
const PANEL_PROMPT_LEAD = '这是本局的状态表，由你在每轮回复的末尾维护 —— 下面是当前的值。';

/** 收尾的格式承诺：放在整块的最末（离生成位置最近，权重最高） */
const PANEL_PROMPT_TAIL =
  '正文写完后，另起一行接着把更新过的状态表写出来 —— 每行都是「【字段名】：新值」的写法，\n' +
  '冒号用全角「：」，字段名和顺序照上面那份表原样保留：\n' +
  '动态字段一个都不能少；静态字段只在发生变化时写。\n' +
  // 值防膨胀：不加这条，模型会往值里塞括号补充，状态表会慢慢长回十几二十行。
  '每行的值要短（十几个字以内）—— 不要用括号补充说明，细节写进正文，不要堆进状态值。\n' +
  '状态表是你这轮回复的一部分，必须写在正文末尾。';

// 最后一声提醒：注入在所有 system 段的末尾，只负责「别忘了」，不重复格式细节。
export const PANEL_PROMPT_REMINDER =
  '（提醒：这一次回复的最后，一定要接着写出上面那张状态表，一行都不能少。）';

// 整轮没提状态表时补问一次（不进历史）。必须说死「落在回复里」，
// 否则思考型模型只在思考中列出、正文一个字不写。
export const PANEL_PROMPT_NUDGE =
  '（你这条回复的末尾没有状态表。现在只补这一件事：不要重写正文、不要解释，' +
  '直接给出下面这张表 —— 每行「【字段名】：新值」，字段名照上面那份原样，一行都不能少。' +
  '这几行要落在回复里，别只在思考中列出。）';


/** 面板拼成注入块；没有面板就返回空串 */
export function formatPanelForPrompt(convo) {
  const fields = convoPanelFields(convo);
  if (!fields.length) return '';

  const panel = convoPanel(convo);
  const clash = clashingFieldNames(convo);
  const label = (key) => panelFieldDisplayName(convo, key, (name) => clash.has(name));

  // 按更新频率分两组：动态每轮维护，静态变了才写；老数据无 mode 一律当动态。
  const isStatic = (key) => {
    const def = convoPanelDef(convo, key);
    return !!def && def.mode === 'static';
  };
  const dynamicKeys = fields.filter((key) => !isStatic(key));
  const staticKeys = fields.filter(isStatic);

  const grouped = (keys) =>
    groupPanelFields(
      keys.map((key) => ({ key, name: panelFieldName(key), group: panelFieldGroup(convo, key) }))
    );

  const renderGroups = (keys) => {
    const lines = [];
    const shown = new Set();
    let groupCount = 0;
    for (const bucket of grouped(keys)) {
      const filled = bucket.fields.filter((f) => {
        const v = panel[f.key];
        return v !== undefined && v !== '';
      });
      if (!filled.length) continue;

      if (bucket.id) {
        groupCount += 1;
        lines.push(panelGroupHeader(bucket.id));
      }
      for (const f of filled) {
        lines.push(`【${label(f.key)}】：${panel[f.key]}`);
        shown.add(f.key);
      }
    }
    return { lines, grouped: groupCount > 0, shown };
  };

  const dyn = renderGroups(dynamicKeys);
  const stat = renderGroups(staticKeys);

  const legend = panelFieldLegend(convo, fields);
  const legendBlock = legend.length
    ? '\n\n字段的取值范围与变化规则（务必遵守，数值超出范围会被程序拉回）：\n' + legend.join('\n')
    : '';
  // 有分组时交代一句 —— 否则模型看不懂那些破折号标题是干什么的
  const groupNote = dyn.grouped || stat.grouped
    ? '\n（「—— 组名 ——」是状态分组的小标题，照抄即可，不要当成字段输出。）'
    : '';

  // 还没有任何值（刚按属性模板开局）：也要列出字段名，否则模型不知道维护什么。
  const dynamicNames = dynamicKeys.map(label);
  const staticNames = staticKeys.map(label);
  if (!dyn.lines.length && !stat.lines.length) {
    const parts = [
      '这是本局的状态表，从这一轮开始由你在每次回复的末尾维护 —— 现在还不知道里面该填什么。'
    ];
    parts.push(`需要维护这些状态字段：${dynamicNames.join('、')}`);
    parts.push('请在每次回复的末尾，用「【字段】：值」的格式把它们完整输出一遍' +
      '（还不知道的写「未知」）；之后每轮照抄并更新，不要凭空改动已有数值。');
    if (staticNames.length) {
      parts.push(`下面这些字段平时不变，但**一旦发生变化就必须输出**（没变化才省略）：${staticNames.join('、')}`);
    }
    return (
      parts.join('\n') + groupNote + legendBlock + '\n\n' + PANEL_PROMPT_TAIL
    );
  }

  const rules = [];
  if (dynamicKeys.length) {
    rules.push(
      '正文里发生了什么，状态表就跟着变：时间推进、地点挪动、心情起伏、数值增减都要如实更新，\n' +
      '不要照抄旧值 —— 剧情里只要发生了消耗或获得（花钱、付账、受伤、进食、休息、喝酒、\n' +
      '还债……），对应的数值就**必须**在状态表里更新成新的数。\n' +
      '数值类字段（好感、信任、体力、金钱这类）有涨就有跌：被冒犯、被强迫、被辜负了，\n' +
      '这一轮该降就降，不要因为剧情在推进就只涨不跌。幅度跟事件的分量走 —— 客套话动一点，\n' +
      '真正付出代价的事才配大变动。数值还要跟正文里演出来的态度一致：正文里还在戒备，\n' +
      '数值不该悄悄涨满。\n' +
      '每次回复末尾都要把下面列出的字段完整输出一遍，不得省略、不得用「（状态略）」\n' +
      '「同上」之类带过 —— 没有变化的字段照抄原值即可。'
    );
  }
  if (staticKeys.length) {
    // 措辞必须是「一旦变化就必须输出」，不能写「只在变化时输出」——后者把判断交给模型，会整行省略。
    rules.push(
      '另外这些字段平时不用照抄（几乎不变的设定），但**只要剧情里发生了变化\n' +
      '（换了、脱了、被拿走、受伤、状态改变），就必须在状态栏里输出那行新值**，不能省。\n' +
      '判断标准是「这一轮有没有发生跟它有关的事」，不是「你还记不记得它原来是什么」。'
    );
  }

  // ⚠️ 只把「有值」的字段列进上面那张表，所以没值的字段得单独点名 ——
  //    否则模型压根不知道它存在，永远是空的（「启用场景追踪」就是这么失效的：
  //    种进去的地点/时间/天气一个值没有，表里连名字都不出现）。
  // ⚠️ 这段必须落在表**后面**：末尾那句「字段名和顺序照上面那份表原样保留」离生成位置最近，
  //    只说「照上面的表」而不把新字段补进这句话里，模型就会跳过它们。
  const pending = [];
  const pendingDynamic = dynamicKeys.filter((key) => !dyn.shown.has(key)).map(label);
  const pendingStatic = staticKeys.filter((key) => !stat.shown.has(key)).map(label);
  if (pendingDynamic.length) {
    pending.push(`这些字段还没有值，这一轮起一并补上（剧情里还没交代的写「未知」），格式同上：${pendingDynamic.join('、')}`);
  }
  if (pendingStatic.length) {
    pending.push(`这些字段同样还没有值，剧情里出现相关内容时补一行：${pendingStatic.join('、')}`);
  }

  const body = [
    PANEL_PROMPT_LEAD,
    rules.join('\n\n'),
    dyn.lines.join('\n'),
    stat.lines.join('\n'),
    pending.join('\n')
  ].filter(Boolean);

  return body.join('\n') + groupNote + legendBlock + '\n\n' + PANEL_PROMPT_TAIL;
}

// ---- 写入：把字段种进会话面板 ----

// 往面板补字段：已存在的跳过（保留当前值），初始值只在刚种进去时落地。
// pairs 可以是 [name, value] 或完整定义对象 {name,value,type,min,max,hint}。
export function appendPanelFields(convo, pairs) {
  if (!convo || !pairs.length) return false;

  const fields = [...convoPanelFields(convo)];
  const panel = { ...convoPanel(convo) };
  const defs = { ...convoPanelDefs(convo) };
  // 去重键是「字段名 + owner」：同名不同归属的字段各自存在。
  const known = new Set(fields);
  let changed = false;

  for (const pair of pairs) {
    const raw = Array.isArray(pair) ? { name: pair[0], value: pair[1] } : pair || {};
    const name = String(raw.name == null ? '' : raw.name).trim();
    if (!name || !panelFieldAllowed(name)) continue;
    if (fields.length >= MAX_PANEL_FIELDS) break;

    // 归一化：范围写反会换正，未知类型退回 text，owner 也在这里取。
    const def = normalizePanelField({ ...raw, name });
    if (!def) continue;

    const owner = typeof def.owner === 'string' ? def.owner : '';
    const key = panelKey(name, owner);
    if (known.has(key)) continue;

    fields.push(key);
    known.add(key);
    changed = true;

    if (def.type !== 'text' || def.hint || def.group || def.owner || def.mode) {
      defs[key] = {
        type: def.type,
        ...(typeof def.min === 'number' ? { min: def.min } : {}),
        ...(typeof def.max === 'number' ? { max: def.max } : {}),
        ...(def.hint ? { hint: def.hint } : {}),
        ...(def.group ? { group: def.group } : {}),
        ...(def.owner ? { owner: def.owner } : {}),
        ...(def.mode && def.mode !== 'dynamic' ? { mode: def.mode } : {})
      };
    }

    // 初始值也过范围，并统一成「分子/满值」格式（卡里 initial 常是裸数字）。
    const text = String(def.value == null ? '' : def.value).trim();
    if (text) panel[key] = clampFieldValue(mergeMeterValue(text, '', def), def).value.slice(0, 500);
  }

  if (!changed) return false;

  convo.panelFields = fields;
  convo.panel = panel;
  convo.panelDefs = defs;
  convo.updatedAt = now();
  return true;
}

// 把角色卡上的属性种进面板（连类型/范围/hint）。
// ownerFor 决定归属：'player' = 玩家，默认 = 这张卡自己的 id。
export function seedPanelFromCharacters(convo, list, ownerFor) {
  if (!convo || !Array.isArray(list)) return false;

  const pairs = [];
  for (const character of list) {
    const owner =
      typeof ownerFor === 'function'
        ? ownerFor(character)
        : ownerFor != null
          ? String(ownerFor)
          : (character && character.id) || '';
    for (const attr of characterAttrs(character)) {
      pairs.push(owner ? { ...attr, owner } : attr);
    }
  }
  return appendPanelFields(convo, pairs);
}

// 把「归在别人名下、其实是玩家本人」的字段并到 'player'：只按名字判定（副本名 = 玩家名）。
// 目标已存在则保留目标值、只删多余键；panelManual 标记跟着搬。幂等。
export function mergePlayerOwnedFields(convo) {
  if (!convo) return false;

  const playerName = String((convo.player && convo.player.name) || '').trim();
  if (!playerName) return false;

  // 本会话绑定的世界书里，名字和玩家名一样的副本 → owner 要并过来
  const aliases = new Set();
  for (const bookId of convoWorldbookIds(convo)) {
    const book = worldbookById(bookId);
    for (const copy of worldbookCharacters(book)) {
      const id = copy && copy.id ? String(copy.id) : '';
      if (id && String(copy.name || '').trim() === playerName) aliases.add(id);
    }
  }
  // 玩家自己挑的那张卡本来就是 player 的 owner，不算别名。
  if (!aliases.size) return false;

  const fields = [...convoPanelFields(convo)];
  const panel = { ...convoPanel(convo) };
  const defs = { ...convoPanelDefs(convo) };
  const manual = convo.panelManual && typeof convo.panelManual === 'object'
    ? { ...convo.panelManual }
    : null;

  const remove = new Set();
  let changed = false;

  // 遍历用快照：循环里会往 fields 里 push 目标键，直接遍历会被新加的键带着跑
  for (const key of [...fields]) {
    const { name, owner } = panelKeyParts(key);
    if (!owner || !aliases.has(owner)) continue;

    const target = panelKey(name, 'player');
    const hasTarget = fields.includes(target) && !remove.has(target);
    if (!hasTarget) {
      // 到顶了：目标键建不出来，这条源字段必须原样留着 —— 不能只删不搬。
      if (fields.length + 1 - remove.size > MAX_PANEL_FIELDS) continue;
      if (panel[key] !== undefined) panel[target] = panel[key];
      if (defs[key]) defs[target] = { ...defs[key], owner: 'player' };
      fields.push(target);
    }
    // 目标已存在：保留玩家那份值（先种的玩家卡属性优先），只删多余键。
    delete panel[key];
    delete defs[key];
    if (manual && manual[key]) {
      // 手改时刻要跟着搬；目标已有手改记录时保留目标那份。
      if (!manual[target]) manual[target] = manual[key];
      delete manual[key];
    }
    remove.add(key);
    changed = true;
  }

  if (!changed) return false;

  convo.panelFields = fields.filter((key) => !remove.has(key));
  convo.panel = panel;
  convo.panelDefs = defs;
  if (manual) convo.panelManual = manual;
  convo.updatedAt = now();
  return true;
}

/** 把「姓名」种进面板，标 static（偶尔才变） */
export function seedIdentity(convo, name, owner) {
  const pairs = [];
  const trimmed = String(name || '').trim();
  if (trimmed) pairs.push({ name: '姓名', value: trimmed, owner, mode: 'static' });

  return appendPanelFields(convo, pairs);
}

/** 面板里的「姓名」改了 → 同步会话上的玩家名，否则消息标签 / {{user}} 会对不上。 */
export function syncPlayerNameFromPanel(convo) {
  const player = convo && convo.player;
  if (!player || typeof player !== 'object') return false;

  // 优先取玩家那份（「姓名\u0000player」），取不到再退回纯字段名（老数据）。
  const name = String(
    convoPanel(convo)[panelKey('姓名', 'player')] || convoPanel(convo)['姓名'] || ''
  ).trim();
  if (!name || name === player.name) return false;

  player.name = name.slice(0, 40);
  convo.updatedAt = now();
  return true;
}

// 把老格式面板就地升级成复合键（owner 原本只在 def.owner 里）。
// 幂等，应用启动读盘后每个会话调一次。
export function migrateConvoPanel(convo) {
  if (!convo || typeof convo !== 'object') return;

  const fields = asArray(convo.panelFields);
  const panel = convo.panel && typeof convo.panel === 'object' ? convo.panel : {};
  const defs = convo.panelDefs && typeof convo.panelDefs === 'object' ? convo.panelDefs : {};

  const alreadyMigrated = fields.some((k) => String(k).includes(OWNER_SEP));
  if (alreadyMigrated) return;

  const newFields = [];
  const newPanel = {};
  const newDefs = {};

  for (const raw of fields) {
    const name = String(raw == null ? '' : raw);
    if (!name) continue;
    const owner = String((defs[name] && defs[name].owner) || '');
    const key = panelKey(name, owner);
    if (newFields.includes(key)) continue;
    newFields.push(key);
    if (panel[name] !== undefined) newPanel[key] = panel[name];
    if (defs[name]) newDefs[key] = defs[name];
  }

  convo.panelFields = newFields;
  convo.panel = newPanel;
  convo.panelDefs = newDefs;
}

/** 把新角色副本的属性种进所有玩这本书的会话（纯函数，不落盘），返回种入的会话数 */
export function seedWorldbookCharactersIntoConvos(conversations, book, copies) {
  if (!Array.isArray(conversations) || !book || !Array.isArray(copies) || !copies.length) return 0;

  let seeded = 0;
  for (const convo of conversations) {
    if (!convo || !convoWorldbookIds(convo).includes(book.id)) continue;
    if (seedPanelFromCharacters(convo, copies)) seeded += 1;
  }
  return seeded;
}

/** 把角色库同名卡的属性补进世界书副本（只补没有的字段，不覆盖已有值）。
 *  纯函数，只改传入的 copies；返回 { touched, added, missing }。 */
export function syncCopyAttrsFromSource(copies, sources) {
  const empties = { touched: 0, added: 0, missing: [] };
  if (!Array.isArray(copies) || !copies.length) return empties;

  const byName = new Map();
  for (const s of asArray(sources)) {
    const n = String((s && s.name) || '').trim();
    if (n && !byName.has(n)) byName.set(n, s);
  }

  let touched = 0;
  let added = 0;
  const missing = [];

  for (const copy of copies) {
    if (!copy) continue;
    const src = byName.get(String(copy.name || '').trim());
    if (!src) {
      missing.push(copy.name);
      continue;
    }
    const srcAttrs = characterAttrs(src);
    if (!srcAttrs.length) continue;

    if (!Array.isArray(copy.attributes)) copy.attributes = [];
    const have = new Set(copy.attributes.map((a) => String((a && a.name) || '').trim()));
    const fresh = srcAttrs.filter((a) => a && a.name && !have.has(String(a.name).trim()));
    if (!fresh.length) continue;

    // 深拷贝一份再塞（别把角色库的数组引进来，两边要各自独立）
    for (const a of fresh) copy.attributes.push(JSON.parse(JSON.stringify(a)));
    touched += 1;
    added += fresh.length;
  }

  return { touched, added, missing };
}
