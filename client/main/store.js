'use strict';

// ============================================================================
//  main/store.js —— 本地数据读写：设置以外的全部数据
//
//  所有 JSON 都写在**数据目录**里（位置由 main/data-dir.js 决定：默认是程序
//  旁边的 data\，不再是 C 盘的 %APPDATA%），整份重写，带 backup 兜底。
//  落盘走「先写 .tmp 再 rename」的原子写：写入中途崩溃/断电时，
//  主文件要么是旧的完整内容，要么是新的完整内容，不会出现写了一半的截断文件。
// ============================================================================

const { safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { dataDir } = require('./data-dir.js');
const { normalizeCharacter } = require('./characters.js');
const { createWorldbookNormalizer } = require('./worldbook-store.js');
const { normalizePreset, MAX_PRESETS } = require('./presets.js');

/**
 * 数据目录里某个文件的全路径。
 *
 * ⚠️ 数据**未必**在 Electron 的 userData 里（默认是程序旁边的 data\，
 *    见 main/data-dir.js），所以别照名字去 %APPDATA% 找。
 */
function dataFile(name) {
  return path.join(dataDir(), name);
}

let writeQueue = Promise.resolve();

// ---------------------------------------------------------------------------
//  写入失败的重试
//
//  Windows 上真的会有短暂占用（索引服务、同步盘、杀软扫描、另一个实例刚好在写
//  同一个文件）—— 这时 copy / rename 会吃到 EPERM / EBUSY / EACCES，过一会儿再试
//  就好。不重试的话，表现是「偶尔一次保存失败」：随机弹框 + 随机丢数据。
//
//  退避表：30 / 70 / 150 / 250 ms，合计约 0.5 秒。不能无限拉长：immediate 那条路
//  （关窗口时的最后一次保存）是同步的，主进程会一直卡在这里等 —— 所以那条路另有
//  一张更短的（见下）。
// ---------------------------------------------------------------------------

const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 第 n 次失败之后等多久（毫秒） */
const RETRY_BACKOFF_MS = [30, 70, 150, 250];

// ---------------------------------------------------------------------------
//  ⚠️ 「每次」都失败的 EPERM 不是瞬时占用，而是**权限判定**
//
//  实测形态：错误发生在 open `.tmp`（连新建文件都不让），同一份程序换个目录就恢复；
//  机制是**进程完整性级别被降到 Low**（工作区/沙箱给 exe 目录打了 Low 标签），
//  低完整性进程写不了中完整性对象，和 ACL / 只读属性无关。
//  这类失败重试再久也没用，只会把「关闭卡」拖长。再遇到先做两步：
//    ① 跑 probeDirWritable()，看进程能不能在数据目录里建出文件；
//    ② 不能写就查 **exe 所在目录的完整性标签**（是 Low 就又是它）。
// ---------------------------------------------------------------------------

/**
 * 关窗口那一次（immediate）用的短退避表。
 *
 * 为什么必须比上面那张短：这条路的写是**同步**的（sleepSync 就卡在主进程里），
 * 关窗口时会连写四个文件（会话 / 角色 / 世界书 / 预设）。按 30·70·150·250 走，
 * 一个文件失败要烧 500ms，实测四个文件加起来 **约 2.5 秒主进程完全卡死** ——
 * 用户看到的就是「关闭软件的时候卡」。
 *
 * 而这条路本来就只有「尽力而为」的语义（窗口已经没了，失败也没人看得到提示），
 * 拿两秒多的卡顿去赌一次瞬时占用并不划算：真的瞬时占用一般几十毫秒内就放开，
 * 而「写不进去」这种权限判定（低完整性 / 沙箱）等两秒照样写不进去。用户点保存 / 删卡
 * 那几条**异步**路仍然走完整的退避表，外加渲染层那次 1.2 秒的补试。
 */
const CLOSE_RETRY_BACKOFF_MS = [10, 30];

/** 同步睡一会儿。Atomics.wait 在 Node 主线程可用，别写成忙等烧 CPU。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 同步重试。只对「像是被临时锁住」的错误码重试 ——
 * 磁盘满、路径不存在这类重试一万次也没用，原样抛出去。
 */
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
 * 给主文件留一份备份。**整体吞错，只 warn。**
 *
 * ⚠️ 备份失败绝不能拖垮主写入。备份只是「主文件坏了时的兜底」，为了它让本次保存
 *    整个失败，等于拿「旧数据 + 没备份」换「新数据根本没落盘」—— 明显更亏。
 *    异常一旦冒到 writeJsonNow 外面，整个保存作废，还可能在主进程弹崩溃框。
 *
 * 备份也走「先 copy 到 .tmp 再 rename 顶掉」，跟主文件同一个道理：
 * 直接 copyFileSync 覆盖 .backup，写到一半失败会留下半个 JSON —— 兜底就废了，
 * 而且下次 loadJsonWithFallback 真会读到它。
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
 * 真正落盘的同步实现：先备份旧文件，再写入新内容。
 * 同步是故意的 —— 关窗口时的「最后一次保存」必须在这一个事件循环里写完，
 * 否则程序可能在微任务执行前就退出了。
 *
 * ⚠️ 失败时**必须抛**，不能只 return false：
 *   save* 那几个函数返回的是自己那份 payload、根本不看写没写成功 ——
 *   只 return false 会一路成功到界面，用户看到「已保存」，磁盘上却还是旧文件，
 *   下次启动读回旧数据，中间改的全没了。
 *   最常见的触发条件不是「磁盘满」，而是进程根本不被允许在数据目录里建文件
 *   （低完整性 / 沙箱，见本文件开头）。
 */
function writeJsonNow(file, data, delays) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // 写入前保留一份备份（失败不影响本次写入，见 tryBackup）
    tryBackup(file, delays);

    // 原子写：先写临时文件再 rename —— 写入中途崩溃/断电时，
    // 主文件要么是旧的完整内容，要么是新的完整内容，不会出现写了一半的截断文件。
    // （Node 的 rename 在 Windows 上也是替换语义，目标已存在也能盖。）
    // 整段重试：索引 / 同步盘 / 另一个实例可能刚好在这一刻锁着文件（EPERM / EBUSY）。
    // delays 只由「关窗口」那条同步路传 CLOSE_RETRY_BACKOFF_MS（见那段注释）。
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
 * 排队写入：把并发的保存请求串起来，避免互相覆盖。失败会 reject。
 *
 * ⚠️ 队尾必须自己把异常吃掉（写成 .then(ok, err) 的**两个**处理函数），
 *    否则一次失败会把 writeQueue 永久钉在 rejected 状态：之后每次
 *    writeQueue.then(...) 都直接跳过成功回调、原样继续拒绝 ——
 *    等于「写坏一次，从此以后所有保存都静默不写」，而且界面上完全看不出来。
 *    这里把错误「复制」一份给调用方，队尾本身恢复成正常状态。
 */
function writeJson(file, data) {
  const result = writeQueue.then(() => writeJsonNow(file, data));
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// 数据目录的挑选、能不能写（probeDirWritable）都在 main/data-dir.js ——
// 那是「数据放哪」的问题，不归落盘逻辑管。

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
        // 顺手把备份回填成主文件，下次就不用再走这条兜底路了。
        // ⚠️ 回填失败**不能**连累已经读到手里的数据：辅助动作失败不该把主流程带走。
        //    否则「备份明明读得出来」也会被判成读失败，界面就会报「上次没能读出来，先别改它」。
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
 * 密文的 base64 有多长 —— 用来把「解不开的密文」和「看着像 base64 的老明文 Key」分开。
 *
 * Windows 的 DPAPI 会给短字符串包上 100 多字节的头，base64 之后最少也在 100 字符往上；
 * 而真 Key 就算全是 base64 字符集（比如 64 位十六进制），也就几十字符。
 * 分不开的后果是**把好 Key 当密文丢掉**，所以阈值刻意取得比任何真 Key 都长。
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
    // 解不开。短的当「看着像 base64 的老明文 Key」照旧用；长的才是真密文。
    //
    // ⚠️ 真密文必须返回空，**不能把密文当 Key 交出去**：否则界面是一串乱码、
    //    请求报「401 Key 不对」，用户完全看不出是「这把 Key 本机读不出来了」。
    //    DPAPI 把钥匙绑在本机本账号上，换电脑 / 换 Windows 账号就会这样 ——
    //    唯一正确的做法是让他重填一次。返回空之后，发请求时会明确提示
    //    「还没有填写「X」的 API Key」，而且下次保存不会把这个密文再加密一遍。
    if (encrypted.length < CIPHERTEXT_MIN_CHARS) return encrypted;
    console.warn(
      '[crypto] API Key 解不开（换过电脑 / 换过 Windows 账号？），需要重新填一次:',
      err.message
    );
    return '';
  }
}

// ---------------------------------------------------------------------------
//  会话
// ---------------------------------------------------------------------------

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

  // ⚠️ 这里**不能**截断单个会话的消息：
  //   ① 截掉的消息下次保存就从磁盘上永久消失，用户毫不知情；
  //   ② 摘要的 start/end 是按消息数组下标记的（见 renderer/js/data/memory.js），
  //      从头部砍掉 N 条后覆盖点整体错位 —— 一批**从没压缩过**的消息被当成
  //      「已被摘要覆盖」，从上下文里静默消失。
  //   发给模型的长度由 maxTurns + 摘要控制，不靠这里砍。

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

// ---------------------------------------------------------------------------
//  角色库
//  一个角色 = 一张角色卡。支持两种来源：
//    · 酒馆（SillyTavern）的 PNG 角色卡：元数据以 base64 JSON 藏在 PNG 的 tEXt 块里
//    · 普通 JSON 角色卡
//  也可以完全手写。数据存在数据目录里的 characters.json。
// ---------------------------------------------------------------------------

function charactersFile() {
  return dataFile('characters.json');
}

function loadCharacters() {
  const data = loadJsonWithFallback(charactersFile());
  if (!data || !Array.isArray(data.characters)) return { characters: [] };
  return { characters: data.characters.map((c) => normalizeCharacter(c)) };
}

/**
 * 保存角色库。
 *
 * ⚠️ 返回值是**写盘的 Promise**，不是那份 data —— 这一条是必须的，别改回去。
 *
 * 如果发起 writeJson 就立刻 return data，写盘失败时那个 Promise 没有接管方
 * （unhandled rejection），而 ipcMain.handle 已经拿着 data 成功返回了 ——
 * ipcRenderer.invoke 正常 resolve，渲染层那些 `.catch(() => showToast('没能保存到磁盘'))`
 * 全成了死代码：磁盘一个字节没动，界面照样弹「已删除 / 已保存」。
 * 端到端复现见 tools/mp-e2e-delete.js 的 E 段。
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

// ---------------------------------------------------------------------------
//  世界书 / World Info（Lorebook）
//  数据存在数据目录里的 worldbooks.json。词条生效范围只由「会话绑定了哪本书」决定；
//  每本书还能装若干「角色副本」，这些副本与角色库里的角色互相独立、互不影响。
// ---------------------------------------------------------------------------

function worldbooksFile() {
  return dataFile('worldbooks.json');
}

function newWorldbookId() {
  return newId('w');
}

/**
 * 落盘时走一遍归一化。
 * 归一化本身在 main/worldbook-parse.js（导入链路 require 的是同一份），
 * 这里只把主进程特有的两样东西注进去：id 生成规则、角色副本的归一化器。
 * 具体实现在 main/worldbook-store.js —— 冒烟测试的假后端 require 的是同一份。
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

// ---------------------------------------------------------------------------
//  预设（Preset）
//  数据存在数据目录里的 presets.json。预设是「叠在对话上的一层指令」——
//  只由「会话绑定了哪一个」决定生效，和角色卡、世界书互不影响。
// ---------------------------------------------------------------------------

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
  // ⚠️ 归一化 + 补 id 一起做：normalizePreset 不认识没有 id 的对象，
  //    漏掉这一步会让界面新建的预设每次存盘都换一个 id（绑定关系当场断掉）。
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

// ---------------------------------------------------------------------------
//  语义检索（RAG）的向量仓库
//
//  存在数据目录的 vectors.json：{ version, items: { "<model>::<key>": "<base64 float32>" } }
//  键里带上**模型名**，所以换 embedding 模型不会污染 —— 不同模型的向量空间根本不可比，
//  带上模型名之后老向量自然用不上，也就不会算出一堆假相似度。
// ---------------------------------------------------------------------------

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
  // 向量只是加速用的缓存，存不下去也不该影响聊天（也别让 reject 变成
  // unhandled rejection —— writeJson 是异步的，写在这个 try 里接不住）。
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
