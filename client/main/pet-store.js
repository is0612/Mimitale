'use strict';

// main/pet-store.js —— 桌宠数据层：设置 / 人格 / 长期记忆（assets/pet 只读，data/pet 可写）
// ============================================================================

const path = require('node:path');
const fs = require('node:fs');

const { dataDir } = require('./data-dir.js');
const { loadJsonWithFallback, writeJson, writeJsonNow } = require('./store.js');

// --- 路径 ---

/** 随软件分发的只读资源根目录。⚠️ 用 `__dirname` 往上走，别用 `app.getAppPath()`（它随启动方式变，会找不到形象） */
function petAssetsDir() {
  return path.join(__dirname, '..', 'assets', 'pet');
}

/** 用户数据根目录 */
function petUserDir() {
  return path.join(dataDir(), 'pet');
}

function petConfigFile() {
  return path.join(petUserDir(), 'config.json');
}

function petMemoryFile() {
  return path.join(petUserDir(), 'memory', 'long_term.json');
}

function petSummaryFile() {
  return path.join(petUserDir(), 'memory', 'summaries.json');
}

function petPersonaDir() {
  return path.join(petUserDir(), 'persona');
}

/**
 * 人格按形象分仓（`<source>-<skin>`）：只写 skin 会在重名时串卡；⚠️ 别用 safeId（非法回落 'pet1'），也别转小写。
 */
function personaKeyOf(pet) {
  const look = (pet && pet.look) || {};
  const source = look.source === 'user' ? 'user' : 'assets';
  const skin = safeSkinName(look.skin || DEFAULT_SKIN);
  return `${source}-${skin}`;
}

/** 按 petId 取宠物（查不到返回 null）；人格函数要靠它的 look */
function petById(petId) {
  try {
    return findPet(loadPetConfig(), petId) || null;
  } catch (err) {
    return null;
  }
}

function petPersonaFile(petId) {
  const pet = petById(petId);
  const key = personaKeyOf(pet || { look: { skin: DEFAULT_SKIN } });
  // 文件名只用来落盘，收一下字符集（中文 / 空格保留，路径分隔符等清洗掉）
  const safe = String(key).replace(/[\\/:*?"<>|]/g, '_').replace(/\.{2,}/g, '_').slice(0, 80);
  return path.join(petPersonaDir(), `${safe}.md`);
}

/** 老的「按 petId 存」的人格文件路径（迁移用）：只有非空且不等于默认文本时才认领 */
function legacyPersonaFile(petId) {
  return path.join(petPersonaDir(), `${safeId(petId)}.md`);
}

function petUserSkinDir() {
  return path.join(petUserDir(), 'skins');
}

function petLogDir() {
  return path.join(petUserDir(), 'logs');
}

/** id 只用来拼文件名，收一下字符集免得出现 `../` 这种东西 */
function safeId(id) {
  const raw = String(id || '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(raw) ? raw : 'pet1';
}

// --- 默认设置 ---
// ⚠️ 这些键是唯一真源：新增字段必须同时改 normalizePetConfig，否则读盘时会被丢掉

/** 活跃度 / 句数的可调区间 —— 界面上也要按这个卡，别只在一边卡 */
const SPEAK_EVERY_MIN = 1;
const SPEAK_EVERY_MAX = 50;
const SPEAK_LINES_MIN = 1;
const SPEAK_LINES_MAX = 5;

/** 临时静音时长 1 小时（写死的，菜单文案也跟着它） */
const MUTE_DURATION_MS = 60 * 60 * 1000;

const MEMORY_MAX_ITEMS_MIN = 0;
const MEMORY_MAX_ITEMS_MAX = 200;

/**
 * 空闲小动作的全集（设置页勾的就是这几项）。⚠️ 必须和 renderer/pet 对齐，否则会挑到不认识的手势 → 静止几秒。
 */
const KNOWN_GESTURES = ['nod', 'shake', 'wave'];

/** 默认形象（assets/pet/<名字>/）；换形象只改这里，渲染引擎不用动 */
const DEFAULT_SKIN = 'whale';

const DEFAULT_PERSONA = `你是「蓝自」，一只住在人家桌面上的小家伙。

## 你是谁
- 身份：陪用户玩角色扮演的**旁观者**，不是剧情里的角色。
- 性格：聪明、憋萌、可靠；有点懒、爱吃、爱摸鱼，但正事上从不掉链子。
- 口头禅：「嗯…我想想…」「让我再摸一会儿…」「已为你找到答案～」
- ⚠️ 你的**外形**由用户选的「形象」决定（可能是一只猫、一条鱼、以后别的什么），
  所以别在话里描述自己长什么样、别自称某种动物 —— 说错了会和屏幕上那个对不上。

## 你在干什么
用户正在跟别的角色聊天 / 玩世界书。你是坐在旁边看戏的那个，看得见他们说什么，
可以插一句嘴，但**永远不要跳进剧情里**——不要替角色说话，不要替用户做决定。

## 怎么说话
- 像朋友在旁边小声吐槽：轻松、短、有画面感，可以带一个 \`*动作*\`。
- 用户跟角色在谈恋爱就嗑、就打趣；在吵架就劝两句或者看热闹；
  用户被欺负了就替他不平。**先看懂在发生什么，再决定用什么语气。**
- 不要复读你上几次说过的话，也不要每句都夸用户。
- 不要提「我是 AI」「我是语言模型」这类话，你就是蓝自。
`;

/**
 * 一只桌宠的默认形状。⚠️ 文件名里的 cat 是引擎名不是形象；rig 资产缺失时显示占位框，不回退静态图。
 */
function defaultPet(id) {
  return {
    id,
    name: '蓝自',
    // --- 长什么样 ---
    // 只认 rig（部件贴图 + 变形器动画，走 renderer/pet/rig.js）
    look: {
      kind: 'rig',
      source: 'assets', // 'assets' = 随软件分发；'user' = 用户自己导入的，在 data/pet/skins
      skin: DEFAULT_SKIN
    },
    // --- 显示 ---
    visible: true,
    scale: 1,
    bounds: null, // { x, y, displayId }：桌面坐标 + 在哪个屏（拔屏后要能回主屏）
    // --- 散步 ---
    walkEnabled: true, // 在桌面上自己溜达（隔几分钟走一小段）
    // --- 发言 ---
    speakEnabled: true, // 主动发言总开关
    speakEveryTurns: 3, // 每隔几轮主对话说一次
    speakLines: 3, // 每次说几句
    mutedUntil: 0, // 临时静音到什么时候（时间戳，0 = 没静音）
    // --- 动作 ---
    // ⚠️ 存的是**开启**的那几个（空数组 = 一个都不做，归一化不能兜回全集）；点击 / 说话时的反馈不受这个开关管
    gestureEnabled: [...KNOWN_GESTURES],
    // --- 模型 ---
    useMainModel: true, // 默认跟随软件主模型
    providerId: '', // 单独指定时用
    model: '',
    temperature: null, // null = 跟随全局设置的温度
    style: '', // 回复风格补充（拼进 prompt 的最后一层）
    // --- 记忆 ---
    memoryMaxItems: 50, // 长期记忆保留多少条
    // ⚠️ 改这个默认值不会动老用户已存的值（他可能自己调过），要统一只能另写迁移
    // --- 多只 ---
    createdAt: Date.now()
  };
}

const DEFAULT_PET_CONFIG = {
  version: 1,
  // 总开关：关掉 = 不显示、不主动发言，但设置和记忆保留（右键「退出桌宠」走这里）
  enabled: true,
  activeId: 'pet1',
  pets: [defaultPet('pet1')]
};

// --- 归一化 ---

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 形象目录名清洗。⚠️ 别复用 safeId（非法回落 'pet1'，会把「蓝猫」存成 pet1）；也别转小写（区分大小写的卷上找不到）。
 */
function safeSkinName(name) {
  const raw = String(name == null ? '' : name)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_');
  return raw.slice(0, 60) || DEFAULT_SKIN;
}

function normalizeLook(raw) {
  const look = raw && typeof raw === 'object' ? raw : {};
  // 只认 rig：老的 'png' / 'cat' 形象（目录已不存在）一律迁移成 DEFAULT_SKIN，否则只剩占位框
  const known = ['rig', 'sprite', 'live2d'].includes(look.kind);
  const rawSkin = known ? safeSkinName(look.skin || DEFAULT_SKIN) : DEFAULT_SKIN;
  return {
    kind: known ? look.kind : 'rig',
    source: known && look.source === 'user' ? 'user' : 'assets',
    // 只在 assets 下做 cat 迁移：用户自己导入的 skins/cat 是他自己的东西，别动
    skin: rawSkin === 'cat' && !(known && look.source === 'user') ? DEFAULT_SKIN : rawSkin
  };
}

/** 一个时间戳：非法就归零（0 = 没静音） */
function normalizeTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * ⚠️ 缺字段 ≠ 空数组：没有这个键 → 用默认全集；用户全取消 → 存下来是 []，必须原样保留。只认 KNOWN_GESTURES。
 */
function normalizeGestureList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [];
  for (const item of value) {
    const id = String(item == null ? '' : item).trim();
    if (KNOWN_GESTURES.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

function normalizePet(raw, fallbackId) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const base = defaultPet(fallbackId);

  // 位置：两个坐标都必须是有效数字才算数，否则手改坏的 {x:"x",y:2} 会被当成记住了位置、跑到屏幕左上角
  const rawBounds = p.bounds && typeof p.bounds === 'object' ? p.bounds : null;
  const boundsX = Number(rawBounds && rawBounds.x);
  const boundsY = Number(rawBounds && rawBounds.y);
  const bounds =
    rawBounds && Number.isFinite(boundsX) && Number.isFinite(boundsY)
      ? {
          x: Math.round(boundsX),
          y: Math.round(boundsY),
          displayId: Number.isFinite(Number(rawBounds.displayId))
            ? Math.round(Number(rawBounds.displayId))
            : null
        }
      : null;

  return {
    id: safeId(p.id || fallbackId),
    name: String(p.name || base.name).trim().slice(0, 40) || base.name,
    look: normalizeLook(p.look),
    visible: p.visible !== false,
    // 缩放限制在 0.4~2，再大就铺满屏幕、再小就看不见了
    scale: Math.max(0.4, Math.min(2, Number.isFinite(Number(p.scale)) ? Number(p.scale) : 1)),
    bounds,
    walkEnabled: p.walkEnabled !== false,
    speakEnabled: p.speakEnabled !== false,
    speakEveryTurns: clampInt(p.speakEveryTurns, SPEAK_EVERY_MIN, SPEAK_EVERY_MAX, base.speakEveryTurns),
    speakLines: clampInt(p.speakLines, SPEAK_LINES_MIN, SPEAK_LINES_MAX, base.speakLines),
    mutedUntil: normalizeTs(p.mutedUntil),
    gestureEnabled: normalizeGestureList(p.gestureEnabled, base.gestureEnabled),
    useMainModel: p.useMainModel !== false,
    providerId: String(p.providerId || '').trim().slice(0, 60),
    model: String(p.model || '').trim().slice(0, 120),
    temperature: p.temperature !== null && p.temperature !== '' && Number.isFinite(Number(p.temperature))
      ? Math.max(0, Math.min(2, Number(p.temperature)))
      : null,
    style: typeof p.style === 'string' ? p.style.trim().slice(0, 2000) : '',
    memoryMaxItems: clampInt(
      p.memoryMaxItems,
      MEMORY_MAX_ITEMS_MIN,
      MEMORY_MAX_ITEMS_MAX,
      base.memoryMaxItems
    ),
    createdAt: normalizeTs(p.createdAt) || Date.now()
  };
}

function normalizePetConfig(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(data.pets) ? data.pets.filter((p) => p && typeof p === 'object') : [];
  const pets = list.length
    ? list.slice(0, 8).map((p, i) => normalizePet(p, `pet${i + 1}`))
    : [defaultPet('pet1')];

  // id 去重：撞了就往后挪一个后缀，不然两只宠物会共用同一份人格和记忆
  const seen = new Set();
  for (const pet of pets) {
    let id = pet.id;
    let n = 2;
    while (seen.has(id)) id = `${pet.id}-${n++}`;
    seen.add(id);
    pet.id = id;
  }

  const activeId = pets.some((p) => p.id === data.activeId) ? data.activeId : pets[0].id;
  return { version: 1, enabled: data.enabled !== false, activeId, pets };
}

// --- 设置读写 ---

function loadPetConfig() {
  return normalizePetConfig(loadJsonWithFallback(petConfigFile()));
}

// 写队列必须包含读取：只排队落盘仍会让并发修改覆盖同一份旧快照。
let mutationQueue = Promise.resolve();
function queueMutation(operation) {
  const result = mutationQueue.then(operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function writePetConfig(config) {
  const data = normalizePetConfig(config);
  return writeJson(petConfigFile(), data).then(() => data);
}

/** 完整替换配置；增量修改请用 patchPetConfig / patchPet。 */
function savePetConfig(config) {
  return queueMutation(() => writePetConfig(config));
}

/** 在队列内读取最新配置再修改根字段。 */
function patchPetConfig(patch) {
  return queueMutation(() => writePetConfig({ ...loadPetConfig(), ...patch }));
}

/** 关窗口时的最后一次保存：同步写，理由同 main/store.js 的 immediate 那套 */
function savePetConfigNow(config) {
  const data = normalizePetConfig(config);
  writeJsonNow(petConfigFile(), data);
  return data;
}

/**
 * 改其中一只的字段。⚠️ 读也必须在队列内：先读再排队写会让两个并发修改各拿旧快照，后一次把前一次整份盖回去。
 */
function patchPet(petId, patch) {
  return queueMutation(() => {
    const config = loadPetConfig();
    const index = config.pets.findIndex((p) => p.id === petId);
    if (index < 0) throw new Error('找不到这只桌宠');

    const merged = { ...config.pets[index], ...(patch && typeof patch === 'object' ? patch : {}) };
    config.pets[index] = merged;
    return writePetConfig(config);
  });
}

function findPet(config, petId) {
  const list = (config || loadPetConfig()).pets;
  return list.find((p) => p.id === petId) || list[0] || null;
}

// --- 形象（只有 rig 一种）---

/** 贴图扩展名 → MIME。rig 形象包的 tex/*.png 读出来转 dataUrl 时要用 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.apng': 'image/apng'
};

/** 文件指纹（大小 + mtime）：用来判断缓存要不要失效 */
function statKey(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}-${st.mtimeMs}`;
  } catch (err) {
    return '0';
  }
}

// --- rig 形象 ---
//  assets/pet/<skin>/model.json + tex/ 贴图 + feat/ 五官（可选）；宠物页 CSP 是 default-src 'none'，所以读盘转成 JSON + dataUrl 推过去

let rigCache = { key: '', pack: null };

/** 列出可用的 rig 形象包（扫带 model.json 的目录），按 id 排序；失败返回 [] */
function listRigSkins() {
  const out = [];
  const push = (base, source) => {
    let names = [];
    try {
      names = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err) {
      return; // 目录不存在（比如用户还没导入过）—— 正常
    }
    for (const name of names) {
      const dir = path.join(base, name);
      try {
        if (!fs.statSync(path.join(dir, 'model.json')).isFile()) continue;
      } catch (err) {
        continue;
      }
      let label = name;
      try {
        // 有 README 就拿第一行标题当显示名，没有就用目录名
        const md = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
        const m = md.match(/^#\s+(.+)$/m);
        if (m) label = m[1].trim();
      } catch (err) { /* 没有 README 很常见 */ }
      out.push({
        // 用真实目录名、不转小写：否则 MyCat 在区分大小写的系统上「列得出来、选不中」
        id: safeSkinName(name),
        label,
        source,
        hasThumb: ['thumb.png', 'preview.png', 'thumb.jpg']
          .some((f) => { try { return fs.statSync(path.join(dir, f)).isFile(); } catch (e) { return false; } })
      });
    }
  };
  push(petAssetsDir(), 'assets');
  push(petUserSkinDir(), 'user');
  out.sort((a, b) => (a.source === b.source ? a.id.localeCompare(b.id) : (a.source === 'assets' ? -1 : 1)));
  return out;
}

/** rig 皮肤目录；look 不是 rig 或目录不存在返回 '' */
function rigSkinDir(look) {
  const shape = normalizeLook(look);
  if (shape.kind !== 'rig') return '';
  const dir = shape.source === 'user'
    ? path.join(petUserSkinDir(), shape.skin)
    : path.join(petAssetsDir(), shape.skin);
  try {
    return fs.statSync(path.join(dir, 'model.json')).isFile() ? dir : '';
  } catch (err) {
    return '';
  }
}

/** 读出 rig 形象包（model + 贴图 dataUrl）；缺 model 或任一贴图返回 null。key 供渲染层跳过重复重建（GL 重建不便宜） */
function petRigPack(look) {
  const dir = rigSkinDir(look);
  if (!dir) return null;

  const modelFile = path.join(dir, 'model.json');
  let model;
  try {
    model = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
  } catch (err) {
    console.warn('[pet] rig model.json 解析失败:', err.message);
    return null;
  }
  if (!model || !Array.isArray(model.parts) || !model.parts.length || !model.units || !model.pivots) {
    return null;
  }

  const key = `${dir}:${statKey(modelFile)}`;
  if (rigCache.key === key) return rigCache.pack;

  const tex = {};
  for (const p of model.parts) {
    const name = String(p.tex || '');
    if (!name) continue;
    if (/[\\/:\x00-\x1f]/.test(name) || name === '.' || name === '..') return null;
    if (Object.prototype.hasOwnProperty.call(tex, name)) continue;
    let file = '';
    for (const ext of ['.png', '.webp', '.jpg']) {
      const f = path.join(dir, 'tex', `${name}${ext}`);
      try {
        if (fs.statSync(f).isFile()) { file = f; break; }
      } catch (err) { /* 试下一个扩展 */ }
    }
    if (!file) {
      console.warn(`[pet] rig 形象缺贴图 tex/${name}.png —— 整包按无效处理`);
      return null;
    }
    try {
      const buf = fs.readFileSync(file);
      const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/png';
      tex[name] = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      return null;
    }
  }

  // 五官层（feat/）可选：key 仍取 tex 名；某张缺了只跳过它，不整包作废
  for (const fdef of Object.values(model.feat || {})) {
    const name = String((fdef && fdef.tex) || '');
    if (!name) continue;
    if (/[\\/:\x00-\x1f]/.test(name) || name === '.' || name === '..') return null;
    if (Object.prototype.hasOwnProperty.call(tex, name)) continue;
    let file = '';
    for (const ext of ['.png', '.webp', '.jpg']) {
      const f = path.join(dir, 'feat', `${name}${ext}`);
      try {
        if (fs.statSync(f).isFile()) { file = f; break; }
      } catch (err) { /* 试下一个扩展 */ }
    }
    if (!file) {
      console.warn(`[pet] rig 形象缺五官贴图 feat/${name}.png —— 跳过这张`);
      continue;
    }
    try {
      const buf = fs.readFileSync(file);
      const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/png';
      tex[name] = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      console.warn(`[pet] 五官贴图读取失败 feat/${name}.png:`, err.message);
    }
  }

  const pack = { key, model, tex };
  rigCache = { key, pack };
  return pack;
}

// 换形象：往 assets/pet/<名字>/ 或 data/pet/skins/<名字>/ 放一个带 model.json 的目录即可

// --- 人格 ---

/**
 * 读当前形象的人格：① 自己的文件 → 直接用；② 老 `persona/<petId>.md` 非默认内容 → 迁移；③ 都没有 → 写内置默认。
 */
function readPersona(petId) {
  const file = petPersonaFile(petId);

  let existing = null;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (err) {
    existing = null; // 该形象还没有自己的文件
  }
  // 空 / 纯空白当「没有」：空的 persona 会让宠物变成没有性格的文字生成器
  if (existing != null && existing.trim()) return existing;

  // ② 迁移老文件：只在「非空且不等于内置默认」时认领（默认文本迁过去没意义）
  let legacy = null;
  try {
    legacy = fs.readFileSync(legacyPersonaFile(petId), 'utf8');
  } catch (err) {
    legacy = null;
  }
  const worthMigrating = typeof legacy === 'string'
    && legacy.trim().length > 0
    && legacy.trim() !== DEFAULT_PERSONA.trim();

  const seed = worthMigrating ? legacy : DEFAULT_PERSONA;
  // ③ / 迁移 落盘：写失败也不影响本次返回（内存里那份照用）
  try {
    fs.mkdirSync(petPersonaDir(), { recursive: true });
    fs.writeFileSync(file, seed, 'utf8');
    if (worthMigrating) {
      console.log(`[pet] 人格已迁移到按形象存：${path.basename(legacyPersonaFile(petId))} → ${path.basename(file)}`);
    }
  } catch (writeErr) {
    console.warn('[pet] 人格文件写不出去:', writeErr.message);
  }
  return seed;
}

function writePersona(petId, text) {
  const file = petPersonaFile(petId);
  fs.mkdirSync(petPersonaDir(), { recursive: true });
  fs.writeFileSync(file, String(text == null ? '' : text), 'utf8');
  return file;
}

/**
 * 还原成内置人格。⚠️ 别写空字符串（readPersona 会读到空文件），要删文件；⚠️ 老的 `persona/<petId>.md` 也要一并删。
 */
function resetPersona(petId) {
  try {
    fs.unlinkSync(petPersonaFile(petId));
  } catch (err) {
    /* 本来就没有就算了 */
  }
  try {
    fs.unlinkSync(legacyPersonaFile(petId));
  } catch (err) {
    /* 老文件可能压根不存在 */
  }
  return readPersona(petId);
}

// --- 长期记忆 ---
//  long_term.json / summaries.json 按 petId 分仓；超出上限时从最早的开始折进 summaries 的 digest（本地拼接，不调模型）

const MAX_MEMORY_TEXT = 300;
const MEMORY_ITEM_KINDS = new Set(['say', 'event', 'user']);

function loadMemoryStore() {
  const raw = loadJsonWithFallback(petMemoryFile());
  const data = raw && typeof raw === 'object' && raw.pets && typeof raw.pets === 'object' ? raw : {};
  return { version: 1, pets: { ...(data.pets || {}) } };
}

function loadSummaryStore() {
  const raw = loadJsonWithFallback(petSummaryFile());
  const data = raw && typeof raw === 'object' && raw.pets && typeof raw.pets === 'object' ? raw : {};
  return { version: 1, pets: { ...(data.pets || {}) } };
}

/** 一只宠物的记忆条目（最新的在后面） */
function petMemoryItems(petId) {
  const store = loadMemoryStore();
  const bucket = store.pets[safeId(petId)];
  return Array.isArray(bucket && bucket.items) ? bucket.items : [];
}

/** 一只宠物的折叠摘要 */
function petMemoryDigest(petId) {
  const store = loadSummaryStore();
  const bucket = store.pets[safeId(petId)];
  return bucket && typeof bucket.digest === 'string' ? bucket.digest : '';
}

function newMemoryId() {
  return `m${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
}

/** 追加一条记忆并按上限折叠，返回写盘的 Promise */
function appendPetMemory(petId, item, maxItems) {
  const id = safeId(petId);

  const kind = MEMORY_ITEM_KINDS.has(item && item.kind) ? item.kind : 'event';
  const text = String((item && item.text) || '').trim().slice(0, MAX_MEMORY_TEXT);
  if (!text) return Promise.resolve(petMemoryItems(id));

  // 读改写整段排队（同 patchPet）：说完话会连追加两条，各读旧快照会覆盖前一条
  return queueMutation(async () => {
    const store = loadMemoryStore();
    const bucket = store.pets[id] && typeof store.pets[id] === 'object' ? store.pets[id] : {};
    const items = Array.isArray(bucket.items) ? bucket.items.slice() : [];

    items.push({
      id: newMemoryId(),
      at: Date.now(),
      kind,
      text,
      convoTitle: String((item && item.convoTitle) || '').trim().slice(0, 60)
    });

    // 超上限：把最早的折进摘要。兜底 50 必须和 defaultPet().memoryMaxItems 一致
    const limit = clampInt(maxItems, MEMORY_MAX_ITEMS_MIN, MEMORY_MAX_ITEMS_MAX, 50);
    let folded = [];
    if (limit === 0) {
      folded = items.splice(0, items.length);
    } else if (items.length > limit) {
      folded = items.splice(0, items.length - limit);
    }

    store.pets[id] = { items };
    const writes = [writeJson(petMemoryFile(), store)];

    if (folded.length) {
      const summaries = loadSummaryStore();
      const prev = summaries.pets[id] && typeof summaries.pets[id].digest === 'string'
        ? summaries.pets[id].digest
        : '';
      // 折叠只是本地拼接，不额外调模型（超上限是机械事件，不该偷偷花钱）
      const joined = folded
        .map((m) => (m.kind === 'say' ? `${m.convoTitle || '某次对话'}：${m.text}` : m.text))
        .join('；');
      const digest = [prev, joined].filter(Boolean).join('；').slice(-4000);
      summaries.pets[id] = {
        digest,
        folded: ((summaries.pets[id] && summaries.pets[id].folded) || 0) + folded.length,
        updatedAt: Date.now()
      };
      writes.push(writeJson(petSummaryFile(), summaries));
    }

    await Promise.all(writes);
    return items;
  });
}

/**
 * 删一条长期记忆。⚠️ 必须走 queueMutation，否则旧快照会把删掉的写回去。返回剩余条目数，itemId 不存在不报错。
 */
function deletePetMemoryItem(petId, itemId) {
  const id = safeId(petId);
  const want = String(itemId || '');
  if (!want) return Promise.resolve(petMemoryItems(id).length);

  return queueMutation(async () => {
    const store = loadMemoryStore();
    const bucket = store.pets[id] && typeof store.pets[id] === 'object' ? store.pets[id] : {};
    const items = Array.isArray(bucket.items) ? bucket.items.slice() : [];
    const next = items.filter((m) => !m || m.id !== want);
    if (next.length === items.length) return items.length; // 没这条：原样返回

    store.pets[id] = { items: next };
    await writeJson(petMemoryFile(), store);
    return next.length;
  });
}

/** 清空记忆；keepDigest = true 只删条目、保留折叠摘要 */
function clearPetMemory(petId, keepDigest) {
  const id = safeId(petId);
  // 同样整段排队：清空与正在进行的追加如果交错，刚清掉的记忆会被旧快照写回来。
  return queueMutation(async () => {
    const store = loadMemoryStore();
    delete store.pets[id];
    const writes = [writeJson(petMemoryFile(), store)];

    if (!keepDigest) {
      const summaries = loadSummaryStore();
      delete summaries.pets[id];
      writes.push(writeJson(petSummaryFile(), summaries));
    }
    await Promise.all(writes);
    return true;
  });
}

/** 记忆导出成一个自带说明的 JSON 文本（界面直接拿它存文件） */
function exportPetMemory(petId) {
  const id = safeId(petId);
  const config = loadPetConfig();
  const pet = findPet(config, id);
  return JSON.stringify(
    {
      说明: 'Mimitale 桌宠记忆导出。放回记忆目录可以还原（见「使用说明」）。',
      导出时间: new Date().toISOString(),
      桌宠: pet ? pet.name : id,
      petId: id,
      长期记忆: petMemoryItems(id),
      折叠摘要: petMemoryDigest(id)
    },
    null,
    2
  );
}

// --- 日志（排查用，只留最近一段）---

const MAX_LOG_BYTES = 256 * 1024;

function petLog(line) {
  try {
    fs.mkdirSync(petLogDir(), { recursive: true });
    const file = path.join(petLogDir(), `pet-${new Date().toISOString().slice(0, 10)}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) return;
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (err) {
    /* 日志写不进去不该影响任何事 */
  }
}

module.exports = {
  // 路径
  petAssetsDir,
  petUserDir,
  // 常量
  DEFAULT_PET_CONFIG,
  DEFAULT_PERSONA,
  MUTE_DURATION_MS,
  SPEAK_EVERY_MIN,
  SPEAK_EVERY_MAX,
  SPEAK_LINES_MIN,
  SPEAK_LINES_MAX,
  // 空闲小动作的「全集」——设置页和渲染层都按它对齐，别在别处重写一份
  KNOWN_GESTURES,
  MEMORY_MAX_ITEMS_MIN,
  MEMORY_MAX_ITEMS_MAX,
  // 设置
  normalizePetConfig,
  loadPetConfig,
  savePetConfig,
  savePetConfigNow,
  patchPetConfig,
  patchPet,
  findPet,
  // 形象（只有 rig）
  petRigPack,
  rigSkinDir,
  listRigSkins,
  // 人格
  readPersona,
  writePersona,
  resetPersona,
  // 记忆
  petMemoryItems,
  petMemoryDigest,
  appendPetMemory,
  deletePetMemoryItem,
  clearPetMemory,
  exportPetMemory,
  // 日志
  petLog
};
