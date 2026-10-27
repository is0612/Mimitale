'use strict';

//  main/worldbook-parse.js —— 世界书的归一化与形状识别（纯解析：不碰磁盘、不生成 id）。
//  ⚠️ normalizeWorldbook 是白名单式的：加字段时记得同步，否则静默丢失。

// 条目数上限：匹配每轮同步跑，上万条会让每句话都卡一下。
const MAX_WORLDBOOK_ENTRIES = 5000;
// 一条注入内容的最大长度，防止畸形文件把上下文撑爆
const MAX_WORLDBOOK_CONTENT = 20000;
const MAX_WORLDBOOK_KEYS = 200;
// 角色副本上限：副本自带头像（base64），不能不限量
const MAX_WORLDBOOK_CHARACTERS = 50;
// 导入外部文件用更严的副本数上限（自己库里仍是 50）
const MAX_IMPORTED_WORLDBOOK_CHARACTERS = 30;

/** 把一条 entry 的不同写法（ST 的 key/keys、constant…）归一化成内部格式 */
function normalizeWorldbookEntry(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ext = r.extensions && typeof r.extensions === 'object' ? r.extensions : {};
  const own = ext.mimitale && typeof ext.mimitale === 'object' ? ext.mimitale : {};
  const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

  // ST 内部是 key + keysecondary；导出到 character_book 时叫 keys / secondary_keys
  const pickKeys = (a, b) => {
    const value = Array.isArray(a) ? a : Array.isArray(b) ? b : typeof a === 'string' ? [a] : [];
    return value
      .filter((k) => typeof k === 'string' && k.trim())
      .map((k) => k.trim().slice(0, 200))
      .slice(0, MAX_WORLDBOOK_KEYS);
  };

  const keys = pickKeys(r.keys, r.key);
  const secondaryKeys = pickKeys(r.secondaryKeys, r.secondary_keys ?? r.keysecondary);
  // ST 可保留副关键词但关闭 selective；缺省按「有副关键词即启用」
  const selective = typeof r.selective === 'boolean' ? r.selective : secondaryKeys.length > 0;
  const content = str(r.content, MAX_WORLDBOOK_CONTENT);
  // 无内容且无关键词的条目直接丢掉
  if (!content.trim() && !keys.length) return null;

  // ST 数值枚举顺序与编辑器选项顺序不同；内部仍保存可读名称。
  const logicNames = ['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'];
  const logic = String(r.selectiveLogic ?? r.selective_logic ?? ext.selectiveLogic ?? 'AND_ANY').toUpperCase();
  const selectiveLogic = logicNames.includes(logic) ? logic : logicNames[logic] || 'AND_ANY';

  const useProbability = r.useProbability ?? ext.useProbability;
  let probability = useProbability === false ? 100 : Number(r.probability ?? ext.probability);
  if (!Number.isFinite(probability)) probability = 100;
  probability = Math.max(0, Math.min(100, probability));

  let order = Number(r.order ?? r.insertion_order);
  if (!Number.isFinite(order)) order = 100;

  // 酒馆新版用 enabled、旧版/部分导出工具用 disable（true = 停用）；都认，否则旧书停用条目会全部复活。
  const enabled = typeof r.enabled === 'boolean' ? r.enabled : r.disable === true ? false : true;
  // 递归按酒馆语义：preventRecursion / excludeRecursion 都是限制项、缺省 false。
  // ⚠️ 条目级默认必须「可递归」否则和 ST 对不上；深度由全局 wordbookRecursiveDepth（默认 1）控制。
  const preventRecursion = r.preventRecursion ?? r.prevent_recursion ?? ext.preventRecursion ?? ext.prevent_recursion;
  const recursive = typeof r.recursive === 'boolean'
    ? r.recursive
    : typeof own.recursive === 'boolean'
      ? own.recursive
      : preventRecursion !== true;

  return {
    id: typeof r.id === 'string' && r.id ? r.id : `e${Math.random().toString(36).slice(2, 10)}`,
    // comment 是酒馆的条目备注；没有就退回首关键词
    title: str(r.title || r.comment, 200).trim() || keys[0] || '未命名条目',
    keys,
    secondaryKeys,
    selective,
    selectiveLogic,
    content,
    order,
    // 蓝圈：无条件注入
    constant: r.constant === true || r.strategy === 'constant',
    // 命中后正文也参与下一轮扫描
    recursive,
    // excludeRecursion 只禁止作为递归目标，不能替代 recursive
    excludeRecursion: r.excludeRecursion === true
      || r.exclude_recursion === true
      || ext.excludeRecursion === true
      || ext.exclude_recursion === true,
    // 全词匹配对无空格分词的中日文不适用，只有显式启用才生效。
    matchWholeWords: bool(
      r.matchWholeWords ?? r.match_whole_words ?? ext.matchWholeWords ?? ext.match_whole_words,
      false
    ),
    caseSensitive: bool(
      r.caseSensitive ?? r.case_sensitive ?? ext.caseSensitive ?? ext.case_sensitive,
      false
    ),
    probability,
    enabled
  };
}

/** 世界书条目列表：可能是数组，也可能是酒馆导出时以索引为键的对象 */
function worldbookEntryList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];

  const values = Object.values(raw);
  // 对象形式 { "0": {...} }：只认「所有值都是对象」，免得把单个 entry 误当一本书
  if (values.length && values.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    return values;
  }
  return [];
}

/** 世界书（数组或带 entries 的对象）→ 内部格式。
 *  ⚠️ 白名单式：加字段时创建与导出两处都要同步，否则静默丢失。 */
function normalizeWorldbook(raw, fallbackName, makeId, normalizeCharacters, maxCharacters) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const own = r.extensions && r.extensions.mimitale || {};
  const rawEntries = Array.isArray(raw) ? raw : worldbookEntryList(r.entries);
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const name =
    String(r.name || r.title || (typeof fallbackName === 'string' ? fallbackName : '') || '').trim() || '未命名世界书';

  const entries = [];
  for (const item of rawEntries) {
    const entry = normalizeWorldbookEntry(item);
    if (entry) entries.push(entry);
    if (entries.length >= MAX_WORLDBOOK_ENTRIES) break;
  }

  // 书里的角色是独立副本（从角色卡复制，之后两边各改各的）。
  // ⚠️ 导入外部世界书必须注入 normalizeCharacters，否则副本被静默丢掉（书进来了、NPC 全不在）。
  const characters = [];
  if (typeof normalizeCharacters === 'function') {
    const rawChars = Array.isArray(r.characters) ? r.characters : Array.isArray(own.characters) ? own.characters : [];
    const limit = Number.isFinite(maxCharacters) && maxCharacters > 0
      ? Math.floor(maxCharacters)
      : MAX_WORLDBOOK_CHARACTERS;
    for (const item of rawChars) {
      const character = normalizeCharacters(item);
      if (!character) continue;
      characters.push(character);
      if (characters.length >= limit) break;
    }
  }

  const genId = typeof makeId === 'function' ? makeId : () => `w${Date.now().toString(36)}`;
  return {
    id: id || genId(),
    name: name.slice(0, 120),
    // 书自己的简介（酒馆 lorebook / character_book 都带）。导出时读的就是它，
    // 这里不保留的话「导入 → 存盘 → 导出」会静默变成空串。
    description: String(r.description || '').slice(0, 20000),
    entries,
    characters,
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Number(r.updatedAt) || Date.now()
  };
}

/** 角色卡里内嵌的世界书：ST 导出时把绑定的书塞进 character_book；
 *  内嵌那份也可能带 characters（我们自己导的卡就带），两个注入项照传。 */
function worldbookFromCharacterBook(raw, characterName, makeId, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const o = opts || {};
  const book = normalizeWorldbook(
    raw,
    `${characterName || '角色'}的世界书`,
    makeId,
    o.normalizeCharacters,
    o.maxCharacters
  );
  if (!book.entries.length && !book.characters.length) return null;
  return book;
}

/** 单独的 lorebook 文件（{entries:[...]} 或裸数组）→ 世界书。
 *  ⚠️ 导入链路必须传 opts.normalizeCharacters，否则书里的 characters 会被静默丢掉，
 *  表现是「书导进来了、条目都在，进世界却发现一个 NPC 都没有」。 */
function worldbookFromLorebook(raw, fallbackName, makeId, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const o = opts || {};
  const book = normalizeWorldbook(raw, fallbackName, makeId, o.normalizeCharacters, o.maxCharacters);
  if (!book.entries.length && !book.characters.length) return null;
  return book;
}

/** 这个 JSON 是「独立世界书」而不是角色卡吗？
 *  ⚠️ 必须单独判断：酒馆世界书也带 name/description，characterFromCard 见到 name 就认成角色卡，
 *  整本书会被导入成一个空角色。顶层有 entries、且无角色卡专属字段的按世界书处理。 */
function looksLikeLorebook(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
  if (!card.entries) return false;
  return !card.first_mes && !card.char_name && !card.personality && !card.mes_example;
}

// 只导出外部真正要用的，内部步骤（normalizeWorldbookEntry / worldbookEntryList）不外露
module.exports = {
  MAX_WORLDBOOK_ENTRIES,
  MAX_WORLDBOOK_CHARACTERS,
  MAX_IMPORTED_WORLDBOOK_CHARACTERS,
  normalizeWorldbook,
  worldbookFromCharacterBook,
  worldbookFromLorebook,
  looksLikeLorebook
};
