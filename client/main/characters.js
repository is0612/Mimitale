'use strict';

// 角色卡的数据整理。独立成模块供 tools/smoke-test.js require 真实现。
// ⚠️ normalizeCharacter 是白名单式的：只保留显式列出的字段，漏一个就静默丢失；加字段时同步加一行。

// ⚠️ 上限必须大于「导入上限 × 4/3」（base64 膨胀约 1.34 倍），否则合法导入的 PNG 会在保存时被丢掉头像。
const MAX_AVATAR_CHARS = 18000000; // ≈ 13MB 的 PNG，留足余量

// 属性归一化用共享的那一份（主进程 / 渲染层 / 冒烟测试同一份）
const { normalizePanelFields } = require('./panel-fields.js');

// 剧情选项：每轮给几个。上下限和渲染层的 MAX_OPTIONS 对齐。
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 6;
// 默认 4 条；想彻底关掉得在角色编辑器里取消开关（那时存的是 `false`）。
const DEFAULT_OPTIONS = 4;

// 每张表情图都是 base64，所以要有上限。
const MAX_EXPRESSIONS = 60;
const MAX_EXPRESSION_NAME = 24;
const MAX_EXPRESSION_KEYWORDS = 8;
// 情绪键（英文短标识），给 <emo> 标签用
const MAX_EXPRESSION_KEY = 16;

// 🔴 角色的「自带世界书」只允许一本（2026-10-24 星宝要求）：多出来的写盘时直接丢掉，
// 别让界面能绑、重启后又只剩一本。
const MAX_CHARACTER_WORLDBOOKS = 1;

// 语料实测单卡最多 29 条，给 50 足够宽松。
const MAX_ALTERNATE_GREETINGS = 50;
// 和 firstMes 对齐（都是「一段正文」）
const MAX_GREETING_CHARS = 10000;
const MAX_META_CHARS = 100;

/** 世界书 id 列表：去重、去空、限条数。 */
function normalizeWorldbookIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_CHARACTER_WORLDBOOKS) break;
  }
  return out;
}

/** 备选开场白：去空、去重、限条数、限长度。数组内去重，和 firstMes 的重合由调用方再滤。 */
function normalizeAlternateGreetings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    // 两端空白先剪掉：卡里的开场白常以空行开头，留着会让预览第一屏是空的
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.slice(0, MAX_GREETING_CHARS));
    if (out.length >= MAX_ALTERNATE_GREETINGS) break;
  }
  return out;
}

function newCharacterId() {
  return `c${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
}

/** 剧情选项的配置归一化。
 * ⚠️ `false` 必须原样返回：它是「这张卡不要选项」的唯一记号，丢了会让关掉的角色存盘后变回默认开。 */
function normalizeOptionsSpec(value) {
  if (value === false) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { count: DEFAULT_OPTIONS, hint: '' };
  }

  // ⚠️ 不能直接 Number()：Number(null) 和 Number('') 都是 0，会被夹成 1 条。
  const rawCount =
    value.count === null || value.count === undefined || value.count === ''
      ? NaN
      : Number(value.count);
  const count = Number.isFinite(rawCount)
    ? Math.max(MIN_OPTIONS, Math.min(MAX_OPTIONS, Math.round(rawCount)))
    : DEFAULT_OPTIONS;
  const hint = typeof value.hint === 'string' ? value.hint.trim().slice(0, 200) : '';

  return { count, hint };
}

/** 属性归一化交给 main/panel-fields.js（三方共用一份，条数上限也在那边）。 */
function normalizeAttributes(value) {
  return normalizePanelFields(value);
}

/** 表情图：{ name, keywords, key, default, image }，名字去重、顺序保留。
 *  key 是英文情绪键，模型写 <emo>shy</emo> 时按它精确比对；default 整张卡只留一条。 */
function normalizeExpressions(value) {
  if (!Array.isArray(value)) return [];
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  const out = [];
  const seen = new Set();
  let hasDefault = false;
  for (const item of value) {
    const r = item && typeof item === 'object' ? item : {};
    const name = str(r.name, MAX_EXPRESSION_NAME);
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const keywords = Array.isArray(r.keywords)
      ? r.keywords
          .map((k) => str(k, MAX_EXPRESSION_NAME))
          .filter((k) => k && k !== name)
          .filter((k, i, list) => list.indexOf(k) === i)
          .slice(0, MAX_EXPRESSION_KEYWORDS)
      : [];

    // ⚠️ 情绪键只留字母数字下划线连字符：夹进空格或标点会让 <emo> 比对永远落空。
    const key = str(r.key, MAX_EXPRESSION_KEY).toLowerCase().replace(/[^a-z0-9_-]/g, '');

    // 默认脸只认第一条：留多个兜底会让「没命中时显示哪张」取决于顺序。
    const isDefault = r.default === true && !hasDefault;
    if (isDefault) hasDefault = true;

    const image = typeof r.image === 'string' && r.image.startsWith('data:image/') ? r.image : '';

    out.push({
      name,
      keywords,
      ...(key ? { key } : {}),
      ...(isDefault ? { default: true } : {}),
      image: image.length <= MAX_AVATAR_CHARS ? image : ''
    });
    if (out.length >= MAX_EXPRESSIONS) break;
  }
  return out;
}

/** 把任意来源的角色数据整理成内部统一格式，顺便挡住非法值 */
function normalizeCharacter(raw, source) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const id = typeof r.id === 'string' ? r.id.trim() : '';

  const avatar = typeof r.avatar === 'string' && r.avatar.startsWith('data:image/') ? r.avatar : '';
  // 形象是 2:3 立绘（角色库那张竖版图），和头像（气泡上的小圆图）分开存。
  const portrait = typeof r.portrait === 'string' && r.portrait.startsWith('data:image/') ? r.portrait : '';
  const expressions = normalizeExpressions(r.expressions);
  const alternateGreetings = normalizeAlternateGreetings(r.alternateGreetings);
  // `source` 来自调用方，脏值别原样写进数据里
  const fallbackSource = ['png', 'json', 'manual'].includes(source) ? source : 'manual';

  return {
    id: id || newCharacterId(),
    name: str(r.name, 120).trim() || '未命名角色',
    avatar: avatar.length <= MAX_AVATAR_CHARS ? avatar : '',
    // ⚠️ 只在输入里本来就有这个键时才写出来：写成 portrait: '' 会把老卡全变成「没有形象」。
    ...(typeof r.portrait === 'string' ? { portrait: portrait.length <= MAX_AVATAR_CHARS ? portrait : '' } : {}),
    ...(expressions.length ? { expressions } : {}),
    description: str(r.description, 20000),
    personality: str(r.personality, 10000),
    scenario: str(r.scenario, 10000),
    firstMes: str(r.firstMes, 10000),
    mesExample: str(r.mesExample, 30000),
    systemPrompt: str(r.systemPrompt, 10000),
    postHistoryInstructions: str(r.postHistoryInstructions, 10000),
    creatorNotes: str(r.creatorNotes, 5000),
    // 空数组就不落这个键 —— 否则老卡存盘后都多一个空数组，白白撑大 characters.json。
    ...(alternateGreetings.length ? { alternateGreetings } : {}),
    // 作者与版本号：用来分辨同一角色的不同作者 / 版本。
    creator: str(r.creator, MAX_META_CHARS).trim(),
    characterVersion: str(r.characterVersion, MAX_META_CHARS).trim(),
    tags: Array.isArray(r.tags)
      ? r.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 20)
      : [],
    // ⚠️ 少了这一行，界面上填的属性一存盘就没了。
    attributes: normalizeAttributes(r.attributes),
    // 只有 `false` 才表示「这张卡明确不要剧情选项」。
    optionsSpec: normalizeOptionsSpec(r.optionsSpec),
    // 导入带 character_book 的角色卡时自动绑上，之后用户也能自己加/删。只能一本，绑上就一直生效。
    worldbookIds: normalizeWorldbookIds(r.worldbookIds),
    // ⚠️ 白名单式，必须显式保留否则一存盘就丢；只在显式 true 时写出来。
    ...(r.showInPanel === true ? { showInPanel: true } : {}),
    source: ['png', 'json', 'manual'].includes(r.source) ? r.source : fallbackSource,
    createdAt: Number(r.createdAt) || Date.now(),
    updatedAt: Number(r.updatedAt) || Date.now()
  };
}

module.exports = {
  normalizeCharacter,
  normalizeAttributes,
  normalizeExpressions,
  normalizeAlternateGreetings,
  normalizeOptionsSpec,
  normalizeWorldbookIds,
  newCharacterId,
  MAX_AVATAR_CHARS,
  MAX_CHARACTER_WORLDBOOKS,
  MAX_EXPRESSIONS,
  DEFAULT_OPTIONS
};
