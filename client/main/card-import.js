'use strict';

//  main/card-import.js —— 导入文件的形状识别 + 归一化（纯函数，不碰磁盘）。
//  单独成模块，是为了让 tools/smoke-test.js 能用真实 PNG 字节跑完整导入链路。

const { parseCharacterCardPng } = require('./png.js');
const { normalizeCharacter } = require('./characters.js');
const {
  worldbookFromCharacterBook,
  worldbookFromLorebook,
  looksLikeLorebook,
  MAX_IMPORTED_WORLDBOOK_CHARACTERS
} = require('./worldbook-parse.js');

/** 头像字段 → dataURL：可能是完整 dataURL、裸 base64，或表示无头像的 'none'。 */
function cardAvatarToDataUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  if (value.startsWith('data:image/')) return value;
  // 'none' 是酒馆表示无头像的写法；太短的也不可能是图片
  if (value === 'none' || value.length < 64) return '';
  return `data:image/png;base64,${value}`;
}

/** 互动模板 id → 分组中文名（status_bar → 状态栏）；认不出来的 id 走 panels 里的 title。 */
const TEMPLATE_GROUP_LABELS = {
  status_bar: '状态栏',
  relationship: '关系',
  inventory: '背包',
  options: '剧情选项'
};

function statusTemplateGroupTitles(tpl) {
  const map = new Map();
  const panels = tpl && Array.isArray(tpl.panels) ? tpl.panels : [];
  for (const panel of panels) {
    if (!panel || typeof panel !== 'object') continue;
    const id = String(panel.id || '').trim();
    const title = String(panel.title || '').trim();
    if (id && title) map.set(id, title);
  }
  for (const [id, label] of Object.entries(TEMPLATE_GROUP_LABELS)) {
    if (!map.has(id)) map.set(id, label);
  }
  return map;
}

/** 互动模板的字段定义 → 角色属性：用 label 当字段名（要注入给模型），重名加序号；
 *  initial 是数组时用「、」拼成字符串（面板值只能是字符串），template 翻成分组标题。 */
function attributesFromStatusTemplate(tpl) {
  const fields = tpl && Array.isArray(tpl.fields) ? tpl.fields : null;
  if (!fields || !fields.length) return [];

  const groupTitles = statusTemplateGroupTitles(tpl);
  const out = [];
  const used = new Set();

  for (const raw of fields) {
    if (!raw || typeof raw !== 'object') continue;

    let name = String(raw.label || raw.key || '').trim();
    if (!name) continue;

    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name} ${n}`) && n < 50) n += 1;
      name = `${name} ${n}`;
    }
    used.add(name);

    const initial = raw.initial;
    const value = Array.isArray(initial)
      ? initial.filter((v) => typeof v === 'string' && v.trim()).join('、')
      : initial == null
        ? ''
        : String(initial);

    const field = { name, value, type: raw.type };
    if (raw.min !== undefined) field.min = raw.min;
    if (raw.max !== undefined) field.max = raw.max;
    if (raw.hint) field.hint = raw.hint;
    const group = groupTitles.get(String(raw.template || '').trim());
    if (group) field.group = group;

    out.push(field);
  }

  return out;
}

/** 备选开场白：alternate_greetings 与 group_only_greetings 并进来（我们不做群聊，
 *  但同样是入场剧本）；只负责取出，去重 / 限长在 normalizeCharacter 里做。 */
function alternateGreetingsFromCard(d) {
  const out = [];
  for (const src of [d.alternate_greetings, d.group_only_greetings]) {
    if (!Array.isArray(src)) continue;
    out.push(...src);
  }
  return out;
}

/** 从 chat_history[0] 的第一条 assistant 消息取开场白（部分站点导出变体这样存）；
 *  只认纯文本，media 条目不能当文本用。 */
function firstMesFromChatHistory(d) {
  const sessions = d && Array.isArray(d.chat_history) ? d.chat_history : null;
  if (!sessions || !sessions.length) return '';

  const first = sessions[0];
  const messages = first && Array.isArray(first.messages) ? first.messages : [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content !== 'string') continue;
    if (!msg.content.trim()) continue;
    return msg.content;
  }
  return '';
}

/** 角色卡（v1 扁平 / v2、v3 包一层 data）→ 内部格式；无角色名时用文件名兜底。
 *  ⚠️ normalizeOpts 必须传，否则卡里那本书的 characters 会被丢掉。 */
function characterFromCard(card, avatar, source, fallbackName, makeWorldbookId, normalizeOpts) {
  if (!card || typeof card !== 'object') return null;

  // v2 / v3 把真正的数据放在 data 里；v1 是直接铺在顶层
  const d = card.data && typeof card.data === 'object' ? card.data : card;

  // 没有任何可识别字段就返回 null，界面才能报「解析失败」而不是收下空白角色
  const recognizable = d.name || d.char_name || d.description || d.first_mes || d.personality;
  if (!recognizable) return null;

  // 私有扩展位 extensions.mimitale（酒馆规范里 extensions 留给各家，别的软件会原样忽略）
  const ext =
    d.extensions && typeof d.extensions === 'object' && d.extensions.mimitale && typeof d.extensions.mimitale === 'object'
      ? d.extensions.mimitale
      : {};

  // ⚠️ 顺序不能反：标准字段存在时才是权威，全空才去翻 chat_history 变体
  const firstMes =
    d.first_mes || d.first_message || d.greeting || d.char_greeting || firstMesFromChatHistory(d);

  // 属性优先取 extensions.mimitale.attributes，没有才映射 extensions.status_template
  const ownAttrs = Array.isArray(ext.attributes) ? ext.attributes : [];
  const templateAttrs =
    ownAttrs.length || !d.extensions || typeof d.extensions !== 'object'
      ? []
      : attributesFromStatusTemplate(d.extensions.status_template);
  const attributes = ownAttrs.length ? ownAttrs : templateAttrs;

  // 空串要原样保留（= 这张卡明确不要形象，normalizeCharacter 的三态约定）；
  // 不是空串也不是 data:image/ 的垃圾值直接不认，别把老卡变成「无形象」。
  const extAvatarOk = typeof ext.avatar === 'string' && (ext.avatar === '' || ext.avatar.startsWith('data:image/'));
  const extAvatar = extAvatarOk && ext.avatar.startsWith('data:image/') ? ext.avatar : '';
  const extPortraitOk =
    typeof ext.portrait === 'string' && (ext.portrait === '' || ext.portrait.startsWith('data:image/'));

  const character = normalizeCharacter(
    {
      name: d.name || d.char_name || fallbackName,
      // PNG 像素是供外部软件识别的预览图；扩展若明确带 avatar（包括空串）就按元数据还原，
      // 只有旧卡或外部 PNG 缺少有效的私有 avatar 时，才用整张像素图作为头像 fallback。
      avatar: source === 'png'
        ? (extAvatarOk ? extAvatar : avatar)
        : (avatar || extAvatar),
      ...(extPortraitOk ? { portrait: ext.portrait } : {}),
      // 兼容 TavernAI 的 char_* / world_scenario 字段名
      description: d.description || d.char_persona,
      personality: d.personality,
      scenario: d.scenario || d.world_scenario,
      firstMes,
      // 备选开场白；语料里 424/1341 张卡带，单卡最多 29 条
      alternateGreetings: alternateGreetingsFromCard(d),
      mesExample: d.mes_example || d.example_dialogue || d.char_example_dialogue,
      systemPrompt: d.system_prompt,
      postHistoryInstructions: d.post_history_instructions,
      creatorNotes: d.creator_notes || d.creatorcomment,
      // 作者与版本号，用来分辨同一角色的不同作者 / 版本
      creator: d.creator,
      characterVersion: d.character_version,
      tags: d.tags,
      attributes,
      expressions: Array.isArray(ext.expressions) ? ext.expressions : d.expressions
    },
    source
  );

  // v2 卡把世界书放在 data.character_book；也有工具放在顶层
  character.worldbook = worldbookFromCharacterBook(
    d.character_book || card.character_book,
    character.name,
    makeWorldbookId,
    normalizeOpts
  );

  return character;
}

/** 解析导入的文件（PNG 或 JSON 文本）：返回 { kind: 'character'|'worldbook'|'error' }。
 *  ⚠️ 必须先判世界书：酒馆世界书也带 name/description，先走角色卡会被当成空角色、条目全丢。 */
function parseImportFile({ buffer, ext, fallbackName, makeWorldbookId, normalizeCharacters }) {
  const isPng = ext === '.png';
  // 书的角色副本归一化器 + 导入时更严的副本数上限
  const bookOpts = { normalizeCharacters, maxCharacters: MAX_IMPORTED_WORLDBOOK_CHARACTERS };

  let card = null;
  let avatar = '';

  if (isPng) {
    card = parseCharacterCardPng(buffer);
    if (card) avatar = `data:image/png;base64,${buffer.toString('base64')}`;
  } else {
    try {
      card = JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      return { kind: 'error', error: '不是合法的 JSON' };
    }
  }

  if (!card) {
    return { kind: 'error', error: isPng ? '这张 PNG 里没有角色卡数据（没有 chara 信息？）' : '解析失败' };
  }

  // 有些 JSON 卡自带头像：顶层或 data 里，可能是完整 dataURL 或裸 base64（无头像为 'none'）
  if (!avatar) {
    avatar = cardAvatarToDataUrl((card.data && card.data.avatar) || card.avatar);
  }

  // 独立世界书先判（理由见上）
  if (looksLikeLorebook(card)) {
    const book = worldbookFromLorebook(card, fallbackName, makeWorldbookId, bookOpts);
    if (book) return { kind: 'worldbook', worldbook: book };
  }

  const character = characterFromCard(card, avatar, isPng ? 'png' : 'json', fallbackName, makeWorldbookId, bookOpts);
  if (!character) {
    // 不是角色卡再试一次世界书（裸数组等更松的形状）
    const book = worldbookFromLorebook(card, fallbackName, makeWorldbookId, bookOpts);
    if (book) return { kind: 'worldbook', worldbook: book };
    return { kind: 'error', error: '既不是角色卡也不是世界书' };
  }

  const worldbook = character.worldbook || null;
  delete character.worldbook;
  return { kind: 'character', character, worldbook };
}

module.exports = {
  cardAvatarToDataUrl,
  characterFromCard,
  parseImportFile
};
