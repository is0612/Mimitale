'use strict';

// main/store.js —— 本地数据读写（整份重写 + backup；落盘走 .tmp 再 rename 的原子写）
// ============================================================================

const { safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { dataDir } = require('./data-dir.js');
const { normalizeCharacter } = require('./characters.js');
const { createWorldbookNormalizer } = require('./worldbook-store.js');
const { normalizePreset, MAX_PRESETS } = require('./presets.js');

/** 数据目录里某个文件的全路径。⚠️ 数据不在 userData 里（默认程序旁边的 data\），别去 %APPDATA% 找 */
function dataFile(name) {
  return path.join(dataDir(), name);
}

let writeQueue = Promise.resolve();

// --- 写入失败的重试 ---
//  Windows 短暂占用（索引 / 同步盘 / 杀软 / 另一实例）会吃 EPERM / EBUSY / EACCES，退避 30 / 70 / 150 / 250 ms 重试；关窗口那条同步路另有更短的表。

const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 第 n 次失败之后等多久（毫秒） */
const RETRY_BACKOFF_MS = [30, 70, 150, 250];

// --- ⚠️ EPERM 是权限判定 ---
//  「每次」都失败的 EPERM 不是瞬时占用（进程完整性被降到 Low），重试没用；先跑 probeDirWritable()，再查 exe 目录的完整性标签。

/**
 * 关窗口那次（immediate）的短退避表：同步 sleep 卡在主进程，四个文件按完整表走实测卡死约 2.5 秒；10 / 30 ms 就够。
 */
const CLOSE_RETRY_BACKOFF_MS = [10, 30];

/** 同步睡一会儿。Atomics.wait 在 Node 主线程可用，别写成忙等烧 CPU。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 同步重试：只对 EPERM / EBUSY / EACCES 重试，磁盘满、路径不存在这类原样抛出 */
function withRetry(fn, delays = RETRY_BACKOFF_MS) {
  let lastErr = null;
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT_LOCK_CODES.has(err && err.code)) throw err;
      if (i < delays.length) sleepSync(delays[i]);
    }
  }
  throw lastErr;
}

/**
 * 给主文件留一份备份，整体吞错只 warn：备份失败不能拖垮主写入。备份也走 .tmp + rename，否则半个 JSON 会挡下次读取。
 */
function tryBackup(file, delays) {
  const backup = file + '.backup';
  const tmp = backup + '.tmp';
  try {
    if (!fs.existsSync(file)) return;
    withRetry(() => {
      fs.copyFileSync(file, tmp);
      fs.renameSync(tmp, backup);
    }, delays);
  } catch (err) {
    console.warn(
      '[store] 备份失败（不影响本次写入）:',
      path.basename(backup),
      err.message,
      '——常见原因：这个进程不被允许在数据目录里建文件（低完整性 / 沙箱限制），不是等一会儿就能好的'
    );
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      /* 没有就算了 */
    }
  }
}

/**
 * 同步落盘：先备份再写（关窗口的最后一次保存必须在这一轮事件循环里写完）。⚠️ 失败必须抛，否则界面会误报「已保存」。
 */
function writeJsonNow(file, data, delays) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 写入前保留一份备份（失败不影响本次写入，见 tryBackup）
    tryBackup(file, delays);

    // 原子写：先写 .tmp 再 rename（Windows 上也是替换语义），崩溃时主文件只会是完整的新旧内容。
    // 整段重试：索引 / 同步盘 / 另一个实例可能刚好在这一刻锁着文件。
    const tmpFile = file + '.tmp';
    const text = JSON.stringify(data, null, 2);
    withRetry(() => {
      fs.writeFileSync(tmpFile, text, 'utf8');
      fs.renameSync(tmpFile, file);
    }, delays);
    return true;
  } catch (err) {
    console.error('[store] 写入失败:', file, err.message);
    // 顺手清掉可能留下的半截临时文件，别让它挡住下次写入
    try {
      fs.unlinkSync(file + '.tmp');
    } catch (cleanupErr) {
      /* 没有就算了 */
    }
    throw new Error(`写入失败（${path.basename(file)}）：${err.message}`);
  }
}

/**
 * 排队写入，失败会 reject。⚠️ 队尾必须自己把异常吃掉（.then 的两个处理函数），否则一次失败会把 writeQueue 永久钉在 rejected，从此所有保存静默不写。
 */
function writeJson(file, data) {
  const result = writeQueue.then(() => writeJsonNow(file, data));
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// 数据目录的挑选与可写探测（probeDirWritable）在 main/data-dir.js

function loadJsonWithFallback(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // 主文件失败，尝试备份
    const backupFile = file + '.backup';
    if (fs.existsSync(backupFile)) {
      try {
        const raw = fs.readFileSync(backupFile, 'utf8');
        const data = JSON.parse(raw);
        // 把备份回填成主文件。
        // ⚠️ 回填失败不能连累已经读到的数据，否则「备份读得出来」也会被判成读失败。
        try {
          withRetry(() => fs.copyFileSync(backupFile, file));
        } catch (restoreErr) {
          console.warn('[store] 备份回填失败（数据已读到）:', path.basename(file), restoreErr.message);
        }
        return data;
      } catch (backupErr) {
        // 备份也失败
      }
    }
    return null;
  }
}

function encryptApiKey(plaintext) {
  if (!plaintext || !safeStorage.isEncryptionAvailable()) {
    return plaintext;
  }
  try {
    const buffer = safeStorage.encryptString(plaintext);
    return buffer.toString('base64');
  } catch (err) {
    console.error('[crypto] 加密失败:', err.message);
    return plaintext;
  }
}

/**
 * 密文 base64 的长度门槛：DPAPI 给短串包 100+ 字节头，base64 后至少 100 字符往上，而真 Key 只有几十字符。阈值刻意取长，免得把好 Key 当密文丢掉。
 */
const CIPHERTEXT_MIN_CHARS = 80;

function decryptApiKey(encrypted) {
  if (!encrypted) return '';
  // 不像 base64 的（正常 API Key 里都有 - 或 _）：老数据里的明文，直接当明文用
  if (!/^[A-Za-z0-9+/]+=*$/.test(encrypted)) return encrypted;
  // 本机没有加密能力（某些精简系统 / 非 Windows）：无从判断，保持原样
  if (!safeStorage.isEncryptionAvailable()) return encrypted;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch (err) {
    // 解不开：短的当「看着像 base64 的老明文 Key」照旧用，长的才是真密文。
    // ⚠️ 真密文必须返回空，不能当 Key 交出去 —— DPAPI 绑本机本账号，换电脑 / 换账号就会解不开，只能让用户重填。
    if (encrypted.length < CIPHERTEXT_MIN_CHARS) return encrypted;
    console.warn(
      '[crypto] API Key 解不开（换过电脑 / 换过 Windows 账号？），需要重新填一次:',
      err.message
    );
    return '';
  }
}

// --- 会话 ---

// 会话数量上限：防止 conversations.json 无限增长。超出时保留最近更新的。
const MAX_CONVERSATIONS = 100;

// 世界书数量上限：防止角色卡反复导入把 worldbooks.json 撑到几十 MB。
const MAX_WORLDBOOKS = 200;

/** 各数据文件共用的 id 生成：前缀 + 时间戳 + 三位随机数 */
function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`;
}

/** 截到上限；不修改传入数组（sort 会就地排序，这里先复制一份） */
function limitConversations(list) {
  const all = Array.isArray(list) ? list : [];
  if (all.length <= MAX_CONVERSATIONS) return all;
  return [...all]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_CONVERSATIONS);
}

function loadConversations() {
  const data = loadJsonWithFallback(dataFile('conversations.json'));
  if (!data || !Array.isArray(data.conversations)) {
    return { conversations: [], activeId: null };
  }

  const conversations = limitConversations(data.conversations);

  // ⚠️ 不能截断单个会话的消息：截掉的会永久消失，且摘要的 start/end 按数组下标记，
  //    砍头部会让覆盖点错位、没压缩的消息被当成已覆盖而静默消失；长度由 maxTurns + 摘要控制。

  // 截断后 activeId 可能指向被丢掉的旧会话 —— 退到最近一条，别把界面指到不存在的会话。
  const activeId = conversations.some((c) => c.id === data.activeId)
    ? data.activeId
    : (conversations[0] && conversations[0].id) || null;

  return { conversations, activeId };
}

function saveConversations(payload, options) {
  const limited = limitConversations(payload && payload.conversations);
  const requestedActiveId = payload && payload.activeId;
  // 只写真实存在的 activeId；传空就保持空（loadConversations 会回落到第一条）。
  const activeId = limited.some((c) => c.id === requestedActiveId) ? requestedActiveId : null;

  const file = dataFile('conversations.json');
  const data = { conversations: limited, activeId };

  // 关窗口时的最后一次保存必须立刻落盘，不能排队等微任务
  if (options && options.immediate) {
    writeJsonNow(file, data, CLOSE_RETRY_BACKOFF_MS);
    return Promise.resolve(data);
  }
  // ⚠️ 返回的是**写盘的 Promise**，不是 data —— 见 saveCharacters 那段注释。
  return writeJson(file, data).then(() => data);
}

// --- 角色库：一个角色 = 一张卡，支持酒馆 PNG 卡（元数据藏在 tEXt 块）和 JSON，存在 characters.json ---

function charactersFile() {
  return dataFile('characters.json');
}

function loadCharacters() {
  const data = loadJsonWithFallback(charactersFile());
  if (!data || !Array.isArray(data.characters)) return { characters: [] };
  return { characters: data.characters.map((c) => normalizeCharacter(c)) };
}

/**
 * 保存角色库。⚠️ 返回写盘的 Promise，不是 data：否则写盘失败没人接，invoke 正常 resolve，渲染层的 catch 全成死代码。
 */
function saveCharacters(payload, options) {
  const opts = options || {};
  const list = payload && Array.isArray(payload.characters) ? payload.characters : [];
  const data = { characters: list.map((c) => normalizeCharacter(c)) };
  // 导入角色卡时可能顺带解析出内嵌世界书，跟角色同一次写入落盘
  const hasWorldbooks = payload && Array.isArray(payload.worldbooks);
  const books = hasWorldbooks
    ? { worldbooks: payload.worldbooks.slice(-MAX_WORLDBOOKS).map((w) => normalizeStoredWorldbook(w)) }
    : null;

  if (opts.immediate) {
    writeJsonNow(charactersFile(), data, CLOSE_RETRY_BACKOFF_MS);
    if (books) writeJsonNow(worldbooksFile(), books, CLOSE_RETRY_BACKOFF_MS);
    return Promise.resolve(data);
  }

  return writeJson(charactersFile(), data)
    .then(() => (books ? writeJson(worldbooksFile(), books) : undefined))
    .then(() => data);
}

// --- 世界书（World Info / Lorebook）：存在 worldbooks.json，生效范围只由「会话绑定了哪本书」决定 ---

function worldbooksFile() {
  return dataFile('worldbooks.json');
}

function newWorldbookId() {
  return newId('w');
}

/**
 * 落盘前过一遍归一化（实现在 main/worldbook-store.js，这里只注入 id 生成规则和角色副本归一化器）。
 */
const normalizeStoredWorldbook = createWorldbookNormalizer({
  makeId: newWorldbookId,
  normalizeCharacter: (item) => normalizeCharacter(item, 'manual')
});

function loadWorldbooks() {
  const data = loadJsonWithFallback(worldbooksFile());
  if (!data || !Array.isArray(data.worldbooks)) return { worldbooks: [] };
  // 保留最近的若干本，防止无限增长
  const list = data.worldbooks.slice(-MAX_WORLDBOOKS);
  return { worldbooks: list.map((w) => normalizeStoredWorldbook(w)) };
}

/** 保存世界书。返回值是写盘的 Promise（理由见 saveCharacters 上面那段）。 */
function saveWorldbooks(payload, options) {
  const opts = options || {};
  const list = payload && Array.isArray(payload.worldbooks) ? payload.worldbooks : [];
  const data = { worldbooks: list.slice(-MAX_WORLDBOOKS).map((w) => normalizeStoredWorldbook(w)) };

  if (opts.immediate) {
    writeJsonNow(worldbooksFile(), data, CLOSE_RETRY_BACKOFF_MS);
    return Promise.resolve(data);
  }
  return writeJson(worldbooksFile(), data).then(() => data);
}

/** 一组世界书 id 对应的全部条目（去重，同一个 id 只取一次） */
function worldbookEntriesByIds(ids) {
  const wanted = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ];
  if (!wanted.length) return [];

  const { worldbooks } = loadWorldbooks();
  const byId = new Map(worldbooks.map((w) => [w.id, w]));

  const entries = [];
  for (const bookId of wanted) {
    const book = byId.get(bookId);
    if (!book) continue;
    for (const entry of book.entries) {
      entries.push({ ...entry, worldbookId: book.id, worldbookName: book.name });
    }
  }
  return entries;
}

// --- 预设（Preset）：存在 presets.json，是叠在对话上的一层指令，只由会话绑定决定生效 ---

function presetsFile() {
  return dataFile('presets.json');
}

/** 给一个没有 id 的预设补 id（界面新建时不一定带） */
function newPresetId() {
  return newId('pr');
}

function loadPresets() {
  const data = loadJsonWithFallback(presetsFile());
  if (!data || !Array.isArray(data.presets)) return { presets: [] };
  const list = data.presets.slice(-MAX_PRESETS);
  return { presets: list.map((p) => normalizePreset(p)) };
}

function savePresets(payload, options) {
  const opts = options || {};
  const list = payload && Array.isArray(payload.presets) ? payload.presets : [];
  // ⚠️ 归一化 + 补 id 一起做，漏了会让新建的预设每次存盘都换一个 id，绑定关系当场断掉
  const data = {
    presets: list
      .slice(-MAX_PRESETS)
      .map((p) => {
        const preset = normalizePreset(p);
        if (!preset.id) preset.id = newPresetId();
        return preset;
      })
  };

  if (opts.immediate) {
    writeJsonNow(presetsFile(), data, CLOSE_RETRY_BACKOFF_MS);
    return Promise.resolve(data);
  }
  return writeJson(presetsFile(), data).then(() => data);
}

// --- RAG 向量仓库：vectors.json 的 items 键是 "<model>::<key>" —— 带模型名，换 embedding 模型自然不污染 ---

const VECTORS_VERSION = 1;

function vectorsFile() {
  return dataFile('vectors.json');
}

function loadVectors() {
  const data = loadJsonWithFallback(vectorsFile());
  if (!data || data.version !== VECTORS_VERSION || !data.items || typeof data.items !== 'object') {
    return { version: VECTORS_VERSION, items: {} };
  }
  return { version: VECTORS_VERSION, items: data.items };
}

function saveVectors(store) {
  // 向量只是缓存，写不进去也不影响聊天；writeJson 是异步的，必须自己接住 reject
  writeJson(vectorsFile(), store).catch((err) => {
    console.error('向量缓存写入失败', err && err.message);
  });
}

module.exports = {
  dataFile,
  writeJson,
  writeJsonNow,
  loadJsonWithFallback,
  encryptApiKey,
  decryptApiKey,
  loadConversations,
  saveConversations,
  loadCharacters,
  saveCharacters,
  newWorldbookId,
  loadWorldbooks,
  saveWorldbooks,
  worldbookEntriesByIds,
  newPresetId,
  loadPresets,
  savePresets,
  loadVectors,
  saveVectors
};
