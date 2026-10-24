// 角色库 / 世界书：只读访问器。
// 界面和组装提示词两头共用，所以放共享数据层。
// 只读：写入走 persist.js（落盘）和各处的编辑逻辑。

import { state } from '../core/state.js';
import { uid, asArray } from '../core/util.js';
import { normalizePanelFields } from '../core/panel-fields.js';

// --- 角色库 ---

export function characters() {
  return asArray(state.characters);
}

export function characterById(id) {
  if (!id) return null;
  return characters().find((c) => c.id === id) || null;
}

/** 当前会话绑定的角色（没绑就是 null，走通用助手） */
export function characterForConvo(convo) {
  return convo ? characterById(convo.characterId) : null;
}

/** 容错老数据：老数据只有 {name, value}，归一化补出 type/min/max/hint（type 默认 text） */
export function characterAttrs(character) {
  if (!character || !Array.isArray(character.attributes)) return [];
  return normalizePanelFields(character.attributes);
}

/** showInPanel 只对世界书副本有意义（true 才显示，默认 false）；单角色会话里 TA 就是主角，不受此开关管（见 cast.js 的 panelEntities） */
export function showsInPanel(character) {
  return !!(character && character.showInPanel === true);
}

/**
 * 角色形象（列表上那张 2:3 竖版图），和头像 character.avatar 是两个字段。⚠️ 判「键在不在」而非值真假：空串 = 用户要这块空着、别拿头像顶上；缺键才是老卡、用头像兜底。
 */
export function characterPortrait(character) {
  if (!character) return '';
  return typeof character.portrait === 'string' ? character.portrait : character.avatar || '';
}

// --- 世界书 ---

export function worldbooks() {
  return asArray(state.worldbooks);
}

export function worldbookById(id) {
  if (!id) return null;
  return worldbooks().find((w) => w.id === id) || null;
}

/** 本书角色 = 从角色库复制来的独立副本：改这边不影响那边 */
export function worldbookCharacters(book) {
  return asArray(book && book.characters);
}

/** 世界书封面（2:3 竖版 dataURL）。⚠️ 和 characterPortrait 不同，这里只看值：没设过就是没有，退回「世」字占位块 */
export function worldbookCover(book) {
  const cover = book && book.cover;
  return typeof cover === 'string' ? cover : '';
}

/** 世界书角色副本 id：单独前缀，避免和角色库 / 会话的 id 看混 */
export function newWorldbookCharId() {
  return `wc${uid()}`;
}

/** 会话绑定了哪些世界书（id 列表，容错老数据） */
export function convoWorldbookIds(convo) {
  return asArray(convo && convo.worldbookIds);
}

/**
 * 角色自带的世界书（按 id 解析成书）。
 * ⚠️ 停用（worldbookEnabled === false）一律当没有；绑过但已删的 id 也滤掉。
 */
export function characterWorldbooks(character) {
  if (!character || character.worldbookEnabled === false) return [];
  return asArray(character.worldbookIds).map(worldbookById).filter(Boolean);
}

// --- 预设 ---

/** 用户自建的「预设」。⚠️ 别和 state.presets 搞混 —— 那是第三方模型提供商的内置模板（DeepSeek / 通义 / Kimi…），另一回事 */
export function dialoguePresets() {
  return asArray(state.dialoguePresets);
}

export function dialoguePresetById(id) {
  if (!id) return null;
  return dialoguePresets().find((p) => p.id === id) || null;
}

/** 会话绑定的预设 id 列表（**没手动配过** = null；显式全不选 = 空数组，容错老数据） */
export function convoDialoguePresetIds(convo) {
  const raw = convo && convo.dialoguePresetIds;
  // 老数据是单值字符串（dialoguePresetId），这里一并兜住，读到就当「配过一条」
  if (!Array.isArray(raw)) {
    const legacy = convo && convo.dialoguePresetId;
    if (typeof legacy === 'string' && legacy.trim()) return [legacy];
    return null;
  }
  return raw
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
}

/**
 * 会话实际生效的预设（可能多条，按列表顺序拼进提示词）。⚠️ 手动配过（数组）就用它配的几条，显式 [] = 这一场不用、不回落全局；没配过（null）才自动带所有「可全局」的；被删掉 / 停用的 id 静默跳过。
 */
export function effectiveDialoguePresets(convo) {
  const picked = convoDialoguePresetIds(convo);
  const ids = picked === null ? globalDialoguePresets().map((p) => p.id) : picked;
  const out = [];
  for (const id of ids) {
    const preset = dialoguePresetById(id);
    if (preset && preset.enabled !== false) out.push(preset);
  }
  return out;
}

/** 勾了「可全局」的预设（新对话默认带上的那几条） */
export function globalDialoguePresets() {
  return dialoguePresets().filter((p) => p.enabled !== false && p.global === true);
}

/** 能给会话选用的预设（关掉的仍然保留数据，只是不出现在列表里） */
export function selectableDialoguePresets() {
  return dialoguePresets().filter((p) => p.enabled !== false);
}

/** 扫一遍近期消息拼注入块时，往回看几条消息 */
export const WORLDBOOK_SCAN_DEPTH = 6;

/** 递归最多连锁几层（设置里调，0 = 关掉）。⚠️ 默认 1，须与 main/providers.js 的 DEFAULT_SETTINGS 一致 */
export function recursiveDepthSetting() {
  const value = Number((state.settings || {}).worldbookRecursiveDepth);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? Math.floor(value) : 1;
}

/** 角色副本的导出形状：只带设定、属性和已有图片，省去绑定 id / 时间戳等运行字段 */
function worldbookCharacterPayload(character) {
  const c = character && typeof character === 'object' ? character : {};
  const out = {
    name: c.name || '',
    description: c.description || '',
    personality: c.personality || '',
    scenario: c.scenario || '',
    firstMes: c.firstMes || '',
    mesExample: c.mesExample || '',
    systemPrompt: c.systemPrompt || '',
    postHistoryInstructions: c.postHistoryInstructions || '',
    creatorNotes: c.creatorNotes || '',
    tags: asArray(c.tags)
  };
  if (Array.isArray(c.attributes) && c.attributes.length) out.attributes = c.attributes;
  if (typeof c.avatar === 'string' && c.avatar) out.avatar = c.avatar;
  if (typeof c.portrait === 'string' && c.portrait) out.portrait = c.portrait;
  if (c.showInPanel === true) out.showInPanel = true;
  return out;
}

/**
 * 世界书导出成酒馆 lorebook 的形状（导入那边认的就是这个）。⚠️ opening / characters / cover 也一起导出（酒馆规范没有这几个键，别家会忽略）：少了它们「导出再导回」会丢开场白和全部 NPC。
 */
export function worldbookPayload(book) {
  const entries = {};
  asArray(book.entries).forEach((entry, index) => {
    entries[String(index)] = {
      uid: index,
      comment: entry.title || '',
      key: asArray(entry.keys),
      keysecondary: asArray(entry.secondaryKeys),
      content: entry.content || '',
      constant: entry.constant === true,
      selective: entry.selective !== false && Array.isArray(entry.secondaryKeys) && entry.secondaryKeys.length > 0,
      selectiveLogic: { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 }[entry.selectiveLogic] ?? 0,
      order: Number.isFinite(entry.order) ? entry.order : 100,
      probability: Number.isFinite(entry.probability) ? entry.probability : 100,
      disable: entry.enabled === false,
      // ST 将“正文能否继续触发”与“能否作为递归目标”分开保存。
      preventRecursion: entry.recursive !== true,
      excludeRecursion: entry.excludeRecursion === true,
      recursive: entry.recursive === true,
      matchWholeWords: entry.matchWholeWords === true,
      caseSensitive: entry.caseSensitive === true
    };
  });

  const payload = { name: book.name || '未命名世界', description: book.description || '', entries };
  if (typeof book.opening === 'string' && book.opening) payload.opening = book.opening;
  if (typeof book.cover === 'string' && book.cover) payload.cover = book.cover;
  const cast = asArray(book.characters);
  if (cast.length) payload.characters = cast.map(worldbookCharacterPayload);
  return payload;
}

/** v2 角色卡内嵌书使用数组条目；与独立 ST 世界书的对象条目格式分开。 */
export function characterBookPayload(book) {
  const lorebook = worldbookPayload(book);
  const { opening, characters: cast, cover } = lorebook;
  return {
    name: lorebook.name,
    description: lorebook.description,
    // mimitale 私有字段：酒馆不认，但导入链路认（见 main/worldbook-parse.js）；少了 cover 导回来就没封面
    extensions: {
      mimitale: {
        ...(opening ? { opening } : {}),
        ...(cast ? { characters: cast } : {}),
        ...(cover ? { cover } : {})
      }
    },
    entries: Object.values(lorebook.entries).map((entry) => ({
      id: entry.uid,
      comment: entry.comment,
      keys: entry.key,
      secondary_keys: entry.keysecondary,
      content: entry.content,
      enabled: !entry.disable,
      insertion_order: entry.order,
      constant: entry.constant,
      selective: entry.selective,
      case_sensitive: entry.caseSensitive,
      position: 'after_char',
      extensions: {
        selectiveLogic: entry.selectiveLogic,
        probability: entry.probability,
        useProbability: true,
        prevent_recursion: entry.recursive !== true,
        exclude_recursion: entry.excludeRecursion === true,
        match_whole_words: entry.matchWholeWords,
        case_sensitive: entry.caseSensitive,
        mimitale: { recursive: entry.recursive }
      }
    }))
  };
}
