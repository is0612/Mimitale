'use strict';

// main/ipc.js —— IPC 通道注册：界面通过这里调用主进程能力（实现分散在 store / providers / http / window）
// ============================================================================

const { ipcMain, shell, clipboard, dialog, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const {
  dataFile,
  applyLibraryChanges, applyLibraryChangesNow,
  applyCharacterChanges, applyCharacterChangesNow,
  applyWorldbookChanges, applyWorldbookChangesNow,
  applyPresetChanges, applyPresetChangesNow,
  writeJson,
  loadJsonWithFallback,
  loadConversations,
  saveConversations,
  loadCharacters,
  saveCharacters,
  loadCharacter,
  saveCharacter,
  deleteCharacter,
  newWorldbookId,
  loadWorldbooks,
  saveWorldbooks,
  loadWorldbook,
  saveWorldbook,
  deleteWorldbook,
  worldbookEntriesByIds,
  loadPresets,
  savePresets,
  loadPreset,
  savePreset,
  deletePreset,
  loadVectors,
  saveVectors
} = require('./store.js');
const {
  COMMON_MODELS,
  PROVIDER_PRESETS,
  normalizeProvider,
  resolveProvider,
  endpointFor,
  isBridgeProvider,
  loadSettings,
  saveSettings,
  takeSettingsNotices
} = require('./providers.js');
const {
  buildHeaders,
  modelsUrl,
  imagesUrl,
  embeddingsUrl,
  downloadBinary,
  requestJson,
  streamChat,
  bridgeChat,
  bridgeDraw,
  bridgeDrawProgress,
  bridgeHealth
} = require('./http.js');
const { getMainWindow, sendToRenderer } = require('./window.js');
// 数据目录（默认是程序旁边的 data\）归 main/data-dir.js 管
const { dataDir, dataDirInfo, probeDirWritable } = require('./data-dir.js');

// 关键词命中判定与递归扫描在 main/worldbook-match.js
const { matchWorldbookEntries, formatWorldbookSections } = require('./worldbook-match.js');
const { parseImportFile } = require('./card-import.js');
const { importFiles, MAX_IMPORT_BYTES } = require('./import-files.js');
// 世界书自带的 NPC 也要过角色归一化器，否则会被静默丢掉
const { normalizeCharacter } = require('./characters.js');
// 预设导入用落盘时那份归一化器，导进来就是内部形状
const { normalizePreset } = require('./presets.js');
// 角色卡要能导出成「酒馆 PNG 卡」—— 卡数据 base64 后塞进 PNG 的 tEXt 块。
const { pngWithTextChunk } = require('./png.js');
// 记忆检索的向量编解码与排序（纯函数，独立成模块便于测试）
const { encodeVector, decodeVector, rankBySimilarity, collectCandidates } = require('./vectors.js');
// 账号体系（现在是假后端；服务器到位后把这一个 require 换成走网络的实现）
const accountApi = require('./account.js');
// 「这一轮到底发出去了什么」—— 只存内存的环形缓冲，见 main/request-log.js
const { recordRequest, listRequests, clearRequests, MAX_ENTRIES: MAX_LOGGED_REQUESTS } = require('./request-log.js');
// 桌宠：通道注册在这里，实现都在 main/pet-*.js（窗口 / 数据 / 发言）
const { registerPetIpc } = require('./pet-ipc.js');

// 「停止生成」按 requestId 各管各的。
// ⚠️ 不能退回单个 activeController：后台摘要 / 剧情选项 / AI 生成 / 聊天流会互相掐断（桌宠同理）。
const activeControllers = new Map(); // requestId → AbortController

// 允许当头像的图片格式（扩展名 → MIME）
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
};

// 一次最多补 32 条向量（分几轮补，一次全塞既慢又容易被限流）
const MAX_EMBED_PER_CALL = 32;
// 一次请求最多多少条文本（查询 + 补索引共用）
const MAX_EMBED_INPUTS = 64;

// --- 文件选择框的「上次位置」：记在 dialog-state.json，下次作为 defaultPath ---

let lastDialogDir = '';
let lastDialogDirLoaded = false;

function dialogStateFile() {
  return dataFile('dialog-state.json');
}

/** 目录还存在吗？被删/被移走后不能再拿来当默认位置 */
function isUsableDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (err) {
    return false;
  }
}

/** 取上次用过的目录（懒加载一次，读到的目录要还在才用） */
function lastDirForDialog() {
  if (!lastDialogDirLoaded) {
    lastDialogDirLoaded = true;
    try {
      const data = loadJsonWithFallback(dialogStateFile());
      const dir = data && typeof data.lastDir === 'string' ? data.lastDir : '';
      if (dir && isUsableDir(dir)) lastDialogDir = dir;
    } catch (err) {
      // 记不住位置不是致命问题：静默退回系统默认目录
    }
  }
  return lastDialogDir;
}

/** 记住这次选中的路径所在目录（给下一次弹框用） */
function rememberDialogDir(chosenPath) {
  rememberChosenDir(chosenPath ? path.dirname(chosenPath) : '');
}

/** 记住「选中的目录本身」：saveFile 传来的是文件路径（取 dirname），批量导出传目录 */
function rememberChosenDir(dir) {
  if (!dir || dir === lastDialogDir || !isUsableDir(dir)) return;
  lastDialogDir = dir;
  lastDialogDirLoaded = true;
  // 落盘失败只影响「下次记不住」，但 Promise 必须接住，否则会变成 unhandled rejection
  writeJson(dialogStateFile(), { lastDir: dir }).catch((err) => {
    console.warn('[ipc] 记录文件对话框位置失败（不影响本次操作）:', err.message);
  });
}

/** 弹框的默认目录（没记录过就返回 undefined，交给系统默认） */
function dialogDefaultDir() {
  return lastDirForDialog() || undefined;
}

/** 保存框的默认路径：上次目录 + 文件名（fileName 已是绝对路径就直接用） */
function dialogDefaultSavePath(fileName) {
  const base = String(fileName || 'export');
  if (path.isAbsolute(base)) return base;
  const dir = dialogDefaultDir();
  return dir ? path.join(dir, base) : base;
}

/** 读一张本地图片并转成 dataURL；过大/读失败返回 { dataUrl:'', error } */
function readImageAsDataUrl(file, mime) {
  try {
    const buffer = fs.readFileSync(file);
    if (buffer.length > MAX_IMPORT_BYTES) {
      return {
        dataUrl: '',
        error: `图片太大（${(buffer.length / 1048576).toFixed(1)}MB，上限 ${MAX_IMPORT_BYTES / 1048576}MB）`
      };
    }
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, error: '' };
  } catch (err) {
    return { dataUrl: '', error: `读取失败：${(err && err.message) || '未知错误'}` };
  }
}

/** 调一次 /embeddings，返回向量数组（顺序和输入一一对应） */
async function embedTexts(endpoint, texts) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t || '').slice(0, 8000));
  if (!list.length) return [];

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  const json = await requestJson({
    url: embeddingsUrl(endpoint.baseUrl),
    method: 'POST',
    headers,
    body: { model: endpoint.model, input: list },
    timeoutMs: 60000
  });

  const data = Array.isArray(json && json.data) ? json.data : null;
  if (!data || data.length !== list.length) {
    throw new Error('向量接口返回的条数和请求对不上。');
  }

  // 有的服务商不保证顺序，按 index 排一下更稳
  const sorted = data.slice().sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  return sorted.map((d) => d.embedding);
}

/** 世界书 / 会话里所有够格的候选文本（收集逻辑在 main/vectors.js，那边是纯函数） */
function ragCandidates(request) {
  const { conversations } = loadConversations();
  const convo = conversations.find((c) => c.id === request.convoId);
  const { worldbooks } = loadWorldbooks();

  return collectCandidates({
    messages: convo ? convo.messages : [],
    recentCount: request.recentCount,
    books: worldbooks,
    worldbookIds: request.worldbookIds
  });
}

/**
 * 关窗口前的最后一次保存：同步写（immediate），走 ipcMain.on。⚠️ 回调抛异常没人接，会弹 Electron 原生错误框，必须自己兜住。
 */
function registerSyncSave(channel, save) {
  ipcMain.on(channel, (_event, payload) => {
    try {
      save(payload, { immediate: true });
    } catch (err) {
      console.error(`[ipc] ${channel} 写入失败（关窗口路径，静默降级）:`, err.message);
    }
  });
}

/**
 * 用资源管理器打开目录；返回 null = 成功，字符串 = 错误原因。⚠️ 别改回 shell.openPath：实测时成时败，失败还会弹系统框。
 */
function openFolderInExplorer(dir) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      resolve(err || null);
    };

    let child;
    try {
      child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
    } catch (err) {
      finish((err && err.message) || '无法启动资源管理器');
      return;
    }

    child.once('error', (err) => finish((err && err.message) || '无法启动资源管理器'));
    child.once('spawn', () => {
      child.unref();
      finish(null);
    });
    // explorer 有时候不把 spawn 事件回给调用方（复用了已有窗口），
    // 别把调用方吊死在那里
    setTimeout(() => finish(null), 1500);
  });
}

function registerIpc() {
  function registerLibraryChanges(channel, syncChannel, apply, applyNow) {
    ipcMain.handle(channel, (_event, payload) => apply(payload));
    ipcMain.on(syncChannel, (event, payload) => {
      try { event.returnValue = { ok: true, result: applyNow(payload) }; }
      catch (err) { event.returnValue = { ok: false, error: String(err.message || err) }; }
    });
  }
  registerLibraryChanges('library:apply-changes', 'library:apply-changes-sync', applyLibraryChanges, applyLibraryChangesNow);
  registerLibraryChanges('characters:apply-changes', 'characters:apply-changes-sync', applyCharacterChanges, applyCharacterChangesNow);
  registerLibraryChanges('worldbooks:apply-changes', 'worldbooks:apply-changes-sync', applyWorldbookChanges, applyWorldbookChangesNow);
  registerLibraryChanges('presets:apply-changes', 'presets:apply-changes-sync', applyPresetChanges, applyPresetChangesNow);
  ipcMain.handle('settings:get', () => {
    const settings = loadSettings();
    // notices 取走即清空，只有界面启动那一次拉取拿得到（迁移改过用户设置，不能只在日志里说）
    return { settings, models: COMMON_MODELS, presets: PROVIDER_PRESETS, notices: takeSettingsNotices() };
  });

  ipcMain.handle('settings:save', (_event, patch) => saveSettings(patch));

  /** 优先用传进来的 provider（界面上还没保存的内容），其次才用已保存的设置 */
  function providerFromPayload(payload) {
    const p = payload || {};
    if (p.provider && typeof p.provider === 'object') {
      return normalizeProvider(p.provider, p.provider.id);
    }
    return resolveProvider(loadSettings(), p.providerId);
  }

  /**
   * 桥接没有 /models，改从 /health 取当前文字模型；其余走 OpenAI 兼容的 /models。返回 { models, health }。
   */
  async function fetchProviderModels(provider) {
    if (isBridgeProvider(provider)) {
      const health = await bridgeHealth(provider.baseUrl);
      const model = String(health.text_model || '').trim();
      return { models: model ? [model] : [], health };
    }

    if (!provider.apiKey) throw new Error(`请先填写「${provider.name}」的 API Key。`);

    const data = await requestJson({
      url: modelsUrl(provider.baseUrl),
      headers: buildHeaders(provider),
      timeoutMs: 20000
    });
    const models = Array.isArray(data && data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
    return { models, health: null };
  }

  ipcMain.handle('settings:test', async (_event, payload) => {
    const provider = providerFromPayload(payload);
    if (!provider) throw new Error('还没有配置任何模型提供商。');

    const { models, health } = await fetchProviderModels(provider);

    // 本机桥接：顺带把两个引擎的在线状态一起报出来
    if (health) {
      const textOk = health.text_engine === true;
      const imageOk = health.image_engine === true;
      const model = models[0] || '';
      return {
        ok: true,
        count: models.length,
        models,
        message: `桥接服务在线（文字引擎${textOk ? '在线' : '离线'}、图像引擎${imageOk ? '在线' : '离线'}${model ? `，模型 ${model}` : ''}）。`
      };
    }

    return {
      ok: true,
      count: models.length,
      models: models.slice(0, 200),
      message: models.length
        ? `连接成功，${provider.name} 提供 ${models.length} 个模型。`
        : `连接成功（${provider.name} 未返回模型列表，可以直接对话试试）。`
    };
  });

  ipcMain.handle('models:list', async (_event, payload) => {
    const provider = providerFromPayload(payload);
    if (!provider) throw new Error('还没有配置任何模型提供商。');

    try {
      const { models } = await fetchProviderModels(provider);
      return models.sort((a, b) => a.localeCompare(b));
    } catch (err) {
      // 桥接服务没起来时给一句人话；其它服务商的错误原样抛（里面有具体 HTTP 信息）
      if (isBridgeProvider(provider)) throw new Error((err && err.message) || '桥接服务未启动');
      throw err;
    }
  });

  ipcMain.handle('conversations:get', () => loadConversations());

  ipcMain.handle('conversations:save', (_event, payload) => saveConversations(payload));

  // Conversation close-save is synchronous so renderer can keep the window open on failure.
  ipcMain.on('conversations:save-sync', (event, payload) => {
    try {
      saveConversations(payload, { immediate: true });
      event.returnValue = { ok: true, result: loadConversations() };
    } catch (err) {
      event.returnValue = { ok: false, error: String(err && (err.message || err)) };
    }
  });

  // --- 角色卡 ---

  ipcMain.handle('characters:get', () => loadCharacters());

  ipcMain.handle('characters:save', (_event, payload) => saveCharacters(payload));
  ipcMain.handle('characters:get-one', (_event, id) => loadCharacter(id));
  ipcMain.handle('characters:save-one', (_event, record) => saveCharacter(record));
  ipcMain.handle('characters:delete-one', (_event, id) => deleteCharacter(id));

  registerSyncSave('characters:save-sync', saveCharacters);

  // --- 世界书 ---

  ipcMain.handle('worldbooks:get', () => loadWorldbooks());

  ipcMain.handle('worldbooks:save', (_event, payload) => saveWorldbooks(payload));
  ipcMain.handle('worldbooks:get-one', (_event, id) => loadWorldbook(id));
  ipcMain.handle('worldbooks:save-one', (_event, record) => saveWorldbook(record));
  ipcMain.handle('worldbooks:delete-one', (_event, id) => deleteWorldbook(id));

  registerSyncSave('worldbooks:save-sync', saveWorldbooks);

  // --- 预设 ---
  // 叠在对话上的一层指令，各自一个文件，靠 convo.dialoguePresetIds 决定生效（可多条）

  ipcMain.handle('presets:get', () => loadPresets());

  ipcMain.handle('presets:save', (_event, payload) => savePresets(payload));
  ipcMain.handle('presets:get-one', (_event, id) => loadPreset(id));
  ipcMain.handle('presets:save-one', (_event, record) => savePreset(record));
  ipcMain.handle('presets:delete-one', (_event, id) => deletePreset(id));

  registerSyncSave('presets:save-sync', savePresets);

  /**
   * 导入预设：弹框、读 JSON、归一化后返回，不落盘；单条 / 数组 / { presets } 三种形态都认。
   */
  ipcMain.handle('presets:import', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择预设文件',
      buttonLabel: '导入',
      defaultPath: dialogDefaultDir(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '预设文件（JSON）', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, presets: [], errors: [] };
    }
    rememberDialogDir(result.filePaths[0]);

    const out = [];
    const errors = [];

    for (const file of result.filePaths) {
      try {
        const stat = fs.statSync(file);
        // 和角色卡导入同一个上限（12MB）—— 预设是纯文本，正常远小于这个数
        if (stat.size > MAX_IMPORT_BYTES) {
          errors.push(`${path.basename(file)}：文件太大了（${Math.round(stat.size / 1024 / 1024)}MB）`);
          continue;
        }

        const text = fs.readFileSync(file, 'utf8');
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          errors.push(`${path.basename(file)}：不是合法的 JSON`);
          continue;
        }

        // 三种常见形态：单条对象 / 数组 / { presets: [...] }
        let items = [];
        if (Array.isArray(data)) items = data;
        else if (data && Array.isArray(data.presets)) items = data.presets;
        else if (data && typeof data === 'object') items = [data];

        if (!items.length) {
          errors.push(`${path.basename(file)}：里面没有预设`);
          continue;
        }

        for (const item of items) {
          // ⚠️ 导入时不带 id：撞了会顶掉已有预设，由界面重新发一批
          const preset = normalizePreset(item);
          if (!preset) continue;
          preset.id = undefined;
          out.push(preset);
        }
      } catch (err) {
        errors.push(`${path.basename(file)}：${(err && err.message) || '读取失败'}`);
      }
    }

    return { canceled: false, presets: out, errors };
  });

  /**
   * 世界书预览：按当前会话的近期消息跑一遍匹配，返回命中的条目（界面用来显示这一轮会注入哪些设定）。
   */
  ipcMain.handle('worldbooks:preview', (_event, payload) => {
    const request = payload || {};
    const messages = Array.isArray(request.messages) ? request.messages : [];

    // 只取 role/content 参与匹配，和真实请求时的扫描范围保持一致
    let scanDepth = Number(request.scanDepth);
    if (!Number.isFinite(scanDepth) || scanDepth <= 0) scanDepth = 6;
    scanDepth = Math.min(50, Math.floor(scanDepth));

    const usable = messages.filter(
      (m) => m && typeof m.content === 'string' && String(m.content).trim()
    );
    const scanText = usable
      .slice(-scanDepth)
      .map((m) => String(m.content))
      .join('\n');

    // 注入哪些书完全由渲染层传来的 id 决定（effectiveWorldbookIds 负责算），这里不做「按角色自动带上」的判断
    const convoIds = Array.isArray(request.worldbookIds) ? request.worldbookIds : [];
    const entries = worldbookEntriesByIds(convoIds);

    const result = matchWorldbookEntries(entries, scanText, {
      recursiveDepth: request.recursiveDepth
    });
    const hits = result.hits;

    // section = 关键词命中的那批（排在对话历史之后）；deepSection = 常驻条目（更靠近生成位置）
    return {
      total: entries.length,
      scanDepth,
      rounds: result.rounds,
      recursiveCount: result.recursiveCount,
      hits: hits.map((e) => ({
        id: e.id,
        title: e.title,
        worldbookName: e.worldbookName,
        order: e.order,
        recursive: e.recursive === true,
        length: String(e.content).length
      })),
      ...formatWorldbookSections(hits)
    };
  });

  /**
   * 导入角色卡 / 世界书：弹框解析 PNG / JSON 后返回，不落盘（格式判断与归一化在 main/card-import.js）。
   */
  ipcMain.handle('characters:import', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择角色卡或世界书',
      buttonLabel: '导入',
      defaultPath: dialogDefaultDir(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '角色卡 / 世界书（PNG / JSON）', extensions: ['png', 'json'] },
        { name: '酒馆 PNG 角色卡', extensions: ['png'] },
        { name: 'JSON 角色卡 / 世界书', extensions: ['json'] }
      ]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, characters: [], worldbooks: [], errors: [] };
    }
    rememberDialogDir(result.filePaths[0]);

    const imported = importFiles({
      paths: result.filePaths,
      readFile: (file) => fs.readFileSync(file),
      parseImportFile,
      makeWorldbookId: newWorldbookId,
      // 世界书里带的 NPC 也要一起收
      normalizeCharacters: (raw) => normalizeCharacter(raw, 'json'),
      // 和主进程别处保持一致：单文件 12MB
      maxBytes: MAX_IMPORT_BYTES
    });

    return { canceled: false, ...imported };
  });

  // images:read 只认这一批路径 —— 不让渲染层借这条通道去读盘上任意文件
  let pickedImagePaths = new Set();

  /** 选一张本地图当头像：CSP 挡着页面读文件，所以由主进程读成 dataURL（img-src 已放行 data:） */
  ipcMain.handle('images:pick', async (_event, options) => {
    const opts = options || {};
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: opts.title || '选择图片',
      buttonLabel: '使用这张',
      defaultPath: dialogDefaultDir(),
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: Object.keys(IMAGE_MIME).map((e) => e.slice(1)) }]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, dataUrl: '', error: '' };
    }
    rememberDialogDir(result.filePaths[0]);

    const file = result.filePaths[0];
    const ext = path.extname(file).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) {
      return { canceled: false, dataUrl: '', error: `不支持的图片格式：${ext || '未知'}` };
    }

    return { canceled: false, ...readImageAsDataUrl(file, mime) };
  });

  /**
   * 一次选多张图（或整个文件夹），只回路径不回内容 —— 一套差分二十几张，全塞回来会顶爆 IPC。
   */
  ipcMain.handle('images:pick-many', async (_event, options) => {
    const opts = options || {};
    const useDirectory = opts.directory === true;
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: opts.title || (useDirectory ? '选择图片文件夹' : '选择图片（可多选）'),
      buttonLabel: '导入',
      defaultPath: dialogDefaultDir(),
      properties: useDirectory ? ['openDirectory'] : ['openFile', 'multiSelections'],
      ...(useDirectory
        ? {}
        : {
            filters: [
              { name: '图片', extensions: Object.keys(IMAGE_MIME).map((e) => e.slice(1)) }
            ]
          })
    });

    if (result.canceled || !result.filePaths.length) return { canceled: true, files: [] };
    rememberDialogDir(result.filePaths[0]);

    let paths = [];
    if (useDirectory) {
      for (const dir of result.filePaths) {
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch (err) {
          continue;
        }
        // 按文件名自然序（A1 < A2 < A10），差分的顺序才不会乱
        for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
          const full = path.join(dir, name);
          if (!IMAGE_MIME[path.extname(name).toLowerCase()]) continue;
          let isFile = false;
          try {
            isFile = fs.statSync(full).isFile();
          } catch (err) {
            isFile = false;
          }
          if (isFile) paths.push(full);
        }
      }
    } else {
      paths = result.filePaths.slice();
    }

    // images:read 只认这批路径（防止渲染层读任意文件）
    pickedImagePaths = new Set(paths);
    return { canceled: false, files: paths.map((p) => ({ path: p, name: path.basename(p) })) };
  });

  /** 读一张刚选进来的图，转成 dataURL（页面被 CSP 挡着，读不了本地文件） */
  ipcMain.handle('images:read', async (_event, filePath) => {
    const target = String(filePath || '');
    if (!pickedImagePaths.has(target)) {
      return { dataUrl: '', error: '这张图不在本次选中的文件里，请重新选择' };
    }

    const ext = path.extname(target).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) return { dataUrl: '', error: `不支持的图片格式：${ext || '未知'}` };

    return readImageAsDataUrl(target, mime);
  });

  ipcMain.handle('chat:stop', (_event, requestId) => {
    // 带 id：只停那一个请求。不带：全停（兼容不传 id 的调用方）。
    const ids = requestId ? [String(requestId)] : [...activeControllers.keys()];
    let stopped = false;
    for (const id of ids) {
      const controller = activeControllers.get(id);
      if (!controller) continue;
      controller.abort();
      activeControllers.delete(id);
      stopped = true;
    }
    return stopped;
  });

  ipcMain.handle('chat:send', async (event, payload) => {
    const request = payload || {};
    const settings = loadSettings();
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const requestId = request.requestId || `req-${Date.now()}`;

    // 界面指定了服务商，但磁盘上没有 —— 说明还没保存，宁可报错也不要发错服务商
    const requestedId = String(request.providerId || '').trim();
    if (requestedId && !settings.providers.some((p) => p.id === requestedId)) {
      return { ok: false, requestId, error: '这个提供商还没有保存，请到设置里点一下「保存」。' };
    }

    const endpoint = endpointFor(settings, request.providerId, request.model);

    if (!endpoint) {
      return { ok: false, requestId, error: '还没有配置模型服务，请点左下角「设置」添加。' };
    }

    // 会话预设填过的采样参数逐项覆盖全局（渲染层只传「确实设过」的项）
    const sampling = request.sampling && typeof request.sampling === 'object' ? request.sampling : null;
    if (sampling) {
      if (Number.isFinite(sampling.temperature)) endpoint.temperature = sampling.temperature;
      if (Number.isFinite(sampling.maxTokens)) endpoint.maxTokens = Math.round(sampling.maxTokens);
      if (Number.isFinite(sampling.topP)) endpoint.topP = sampling.topP;
      if (typeof sampling.thinking === 'boolean') endpoint.thinking = sampling.thinking;
    }

    // 本机桥接服务免 Key；其余 OpenAI 兼容服务商照旧要求
    const isBridge = isBridgeProvider(resolveProvider(settings, request.providerId));
    if (!isBridge && !endpoint.apiKey) {
      return { ok: false, requestId, error: `还没有填写「${endpoint.providerName}」的 API Key。` };
    }

    // 同一个 requestId 重发（理论上不会）才顶掉旧的；别的请求一概不碰
    const previous = activeControllers.get(requestId);
    if (previous) previous.abort();
    const controller = new AbortController();
    activeControllers.set(requestId, controller);
    const { signal } = controller;

    try {
      if (isBridge) {
        const result = await bridgeChat({
          settings: endpoint,
          messages,
          characterContext: request.characterContext,
          // noImage：只要文字的场景传它，否则桥接可能卸模型出图再热回来，白等几十秒还占显存
          noImage: request.noImage === true,
          // 桥接模式一样要留一份「发出去的原文」，否则「请求记录」在这条路上永远是空的
          onRequest: (body, url) =>
            recordRequest({
              requestId,
              providerName: endpoint.providerName,
              url,
              body
            }),
          signal
        });
        return {
          ok: true,
          requestId,
          providerId: endpoint.providerId,
          providerName: endpoint.providerName,
          model: endpoint.model,
          ...result
        };
      }

      const result = await streamChat({
        settings: endpoint,
        messages,
        signal,
        // 留一份发出去的原文（http.js 在拼好 body 后回调，即服务端收到的原样内容）
        onRequest: (body, url) =>
          recordRequest({
            requestId,
            providerName: endpoint.providerName,
            url,
            body
          }),
        onDelta: (text) => sendToRenderer('chat:chunk', { requestId, text }),
        onReasoning: (text) => sendToRenderer('chat:reasoning', { requestId, text })
      });
      return {
        ok: true,
        requestId,
        providerId: endpoint.providerId,
        providerName: endpoint.providerName,
        model: endpoint.model,
        ...result
      };
    } catch (err) {
      return { ok: false, requestId, error: (err && err.message) || '未知错误' };
    } finally {
      if (activeControllers.get(requestId) === controller) {
        activeControllers.delete(requestId);
      }
    }
  });

  /**
   * 最近几次实际发出去的请求：只读内存（main/request-log.js），不进 settings，重启就空。
   */
  ipcMain.handle('chat:requests', () => ({
    entries: listRequests(),
    max: MAX_LOGGED_REQUESTS
  }));

  ipcMain.handle('chat:requests:clear', () => {
    clearRequests();
    return true;
  });

  ipcMain.handle('util:copy', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  /**
   * 导出文件：由用户选的后缀决定写 text（utf8）还是 base64（.png，pngText 先插成 tEXt 块）。
   */
  ipcMain.handle('util:saveFile', async (_event, payload) => {
    const request = payload || {};
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: request.title || '保存',
      defaultPath: dialogDefaultSavePath(request.fileName),
      filters: Array.isArray(request.filters) ? request.filters : []
    });

    if (result.canceled || !result.filePath) return { canceled: true };
    rememberDialogDir(result.filePath);

    const ext = path.extname(result.filePath).toLowerCase();
    try {
      if (ext === '.png' && request.base64) {
        let buffer = Buffer.from(String(request.base64), 'base64');
        if (request.pngText && request.pngText.keyword) {
          buffer = pngWithTextChunk(buffer, request.pngText.keyword, request.pngText.text || '');
        }
        fs.writeFileSync(result.filePath, buffer);
      } else {
        fs.writeFileSync(result.filePath, String(request.text == null ? '' : request.text), 'utf8');
      }
    } catch (err) {
      return { canceled: false, error: (err && err.message) || '写文件失败' };
    }

    return { canceled: false, filePath: result.filePath };
  });

  /**
   * 批量导出：只弹一次框，重名自动加序号。部分失败不回滚，界面按 written / failed 报数。
   */
  ipcMain.handle('util:saveFiles', async (_event, payload) => {
    const request = payload || {};
    const files = Array.isArray(request.files) ? request.files : [];
    if (!files.length) return { canceled: true };

    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: request.title || '选择导出到哪个文件夹',
      defaultPath: dialogDefaultDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) {
      return { canceled: true };
    }

    const dir = result.filePaths[0];
    rememberChosenDir(dir);

    // Windows 的文件名不区分大小写，去重集合也按小写比
    const taken = new Set();
    const uniqueName = (raw) => {
      const fixed = String(raw || '未命名.json').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名.json';
      const ext = path.extname(fixed);
      const stem = ext ? path.basename(fixed, ext) : fixed;
      let name = ext ? fixed : `${fixed}.json`;
      let n = 2;
      while (taken.has(name.toLowerCase())) {
        name = ext ? `${stem} (${n++})${ext}` : `${stem} (${n++}).json`;
      }
      taken.add(name.toLowerCase());
      return name;
    };

    const written = [];
    const failed = [];
    for (const file of files) {
      const name = uniqueName(file && file.fileName);
      try {
        if (file && file.base64) {
          let buffer = Buffer.from(String(file.base64), 'base64');
          if (file.pngText && file.pngText.keyword) {
            buffer = pngWithTextChunk(buffer, file.pngText.keyword, file.pngText.text || '');
          }
          fs.writeFileSync(path.join(dir, name), buffer);
        } else {
          fs.writeFileSync(path.join(dir, name), String((file && file.text) == null ? '' : file.text), 'utf8');
        }
        written.push(name);
      } catch (err) {
        failed.push({ fileName: name, error: (err && err.message) || '写文件失败' });
      }
    }

    return { canceled: false, dir, written, failed };
  });

  /**
   * 语义检索：收集候选 → 增量补向量 → 算查询向量 → 余弦排序取前 K；只负责捞出文本，注入格式交给渲染层。
   */
  ipcMain.handle('rag:recall', async (_event, payload) => {
    const request = payload || {};
    const settings = loadSettings();

    const endpoint = endpointFor(settings, request.providerId, request.model);
    if (!endpoint) return { ok: false, error: '还没有配置向量模型，请到「设置 → 语义检索」里选一个。' };
    if (!endpoint.apiKey) return { ok: false, error: `还没有填写「${endpoint.providerName}」的 API Key。` };

    const query = String(request.query || '').trim();
    if (!query) return { ok: false, error: '没有可用来检索的内容。' };

    const candidates = ragCandidates(request);
    if (!candidates.length) return { ok: true, items: [], embedded: 0, indexed: 0, total: 0 };

    const store = loadVectors();
    const keyOf = (c) => `${endpoint.model}::${c.key}`;

    try {
      // ---- 补齐缺的向量（增量）----
      const missing = candidates.filter((c) => !store.items[keyOf(c)]);
      const pending = missing.slice(0, Math.min(MAX_EMBED_PER_CALL, MAX_EMBED_INPUTS - 1));

      if (pending.length) {
        const vectors = await embedTexts(endpoint, pending.map((c) => c.text));
        pending.forEach((c, i) => {
          if (vectors[i]) store.items[keyOf(c)] = encodeVector(vectors[i]);
        });
        saveVectors(store);
      }

      // ---- 查询向量 ----
      const queryVector = (await embedTexts(endpoint, [query]))[0];
      if (!queryVector) return { ok: false, error: '向量接口没有返回查询向量。' };

      // ---- 排序 ----
      const ready = [];
      for (const c of candidates) {
        const raw = store.items[keyOf(c)];
        const vector = raw ? decodeVector(raw) : null;
        if (vector) ready.push({ ...c, vector });
      }

      const ranked = rankBySimilarity(Float32Array.from(queryVector), ready, {
        topK: request.topK,
        minScore: request.minScore
      });

      return {
        ok: true,
        items: ranked.map((r) => ({
          kind: r.kind,
          title: r.title || '',
          role: r.role || '',
          text: r.text,
          score: Number(r.score.toFixed(4))
        })),
        embedded: pending.length,
        indexed: ready.length,
        total: candidates.length
      };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '语义检索失败' };
    }
  });

  /**
   * 用系统浏览器打开链接。⚠️ 只放行 http / https，否则这条通道就成了任意启动器。
   */
  ipcMain.handle('util:openExternal', async (_event, url) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '只支持打开 http / https 链接' };
    try {
      await shell.openExternal(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '打开链接失败' };
    }
  });

  /**
   * --- 账号（登录 / 注册 / 凭证）---
   * 背后是真服务器（server/src/routes/client/auth.ts），main/account.js 只负责 HTTP
   * 和本地登录态的落盘。通道名和返回形状从一开始就是按真后端定的，所以 10-27 接服务器
   * 时 preload 与渲染层一个字没动。
   * 统一形状：成功 { ok: true, ... } / 失败 { ok: false, error: '中文原因' } ——
   * 渲染层直接把 error 拿去显示，不用自己翻译。
   */
  const accountCall = (fn) => async (_event, payload) => {
    try {
      const result = await fn(payload);
      return { ok: true, ...(result || {}) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '账号操作失败' };
    }
  };

  ipcMain.handle('account:session', accountCall(() => accountApi.getSession()));
  ipcMain.handle('account:captcha', accountCall(() => accountApi.createCaptcha()));
  ipcMain.handle('account:send-code', accountCall((payload) => accountApi.sendEmailCode(payload)));
  ipcMain.handle('account:register', accountCall((payload) => accountApi.register(payload)));
  ipcMain.handle('account:complete-profile', accountCall((payload) => accountApi.completeProfile(payload)));
  ipcMain.handle('account:login', accountCall((payload) => accountApi.login(payload)));
  ipcMain.handle('account:voucher-login', accountCall((payload) => accountApi.loginWithVoucher(payload)));
  ipcMain.handle('account:logout', accountCall(() => accountApi.logout()));
  ipcMain.handle('account:voucher', accountCall(() => accountApi.getVoucher()));
  ipcMain.handle('account:refresh-voucher', accountCall(() => accountApi.refreshVoucher()));
  ipcMain.handle('account:update-profile', accountCall((payload) => accountApi.updateProfile(payload)));
  ipcMain.handle('account:change-password', accountCall((payload) => accountApi.changePassword(payload)));
  ipcMain.handle('account:change-email', accountCall((payload) => accountApi.changeEmail(payload)));

  /**
   * --- 消息（意见反馈 / 通知公告）---
   * ⚠️ 这三个通道**不要求登录**（服务端那边也没挂 clientGuard）：
   *    连登录都进不去的人，恰恰最需要报错和看公告。
   *    版本号在这里补上 —— account.js 是纯 HTTP 模块，不碰 electron。
   */
  ipcMain.handle('account:redeem', accountCall((payload) => accountApi.redeemCard(payload)));
  ipcMain.handle('account:submit-feedback', accountCall((payload) => accountApi.submitFeedback(payload, { appVersion: app.getVersion() })));
  ipcMain.handle('account:announcements', accountCall(() => accountApi.listAnnouncements()));
  ipcMain.handle('account:announcement-read', accountCall((id) => accountApi.markAnnouncementRead(id)));

  /**
   * 生图：走 OpenAI 的 /images/generations，只支持「同步返回图片」的服务商（和聊天是两套配置）。
   */
  ipcMain.handle('images:generate', async (_event, payload) => {
    const request = payload || {};
    const settings = loadSettings();

    const endpoint = endpointFor(settings, request.providerId, request.model);
    if (!endpoint) {
      return { ok: false, error: '还没有配置生图提供商，请到「设置 → 生图」里选一个。' };
    }
    if (!endpoint.apiKey) {
      return { ok: false, error: `还没有填写「${endpoint.providerName}」的 API Key。` };
    }

    const prompt = String(request.prompt || '').trim().slice(0, 2000);
    if (!prompt) return { ok: false, error: '没有可用的提示词。' };

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

    // 智谱的图片接口不认 response_format / n，反而要求 quality；参数给错只回「参数有误」（错误码 1210）
    const isZhipuImage = /bigmodel\.cn/i.test(String(endpoint.baseUrl || ''));
    const imageBody = {
      model: endpoint.model,
      prompt,
      size: String(request.size || settings.imageSize || '1024x1024')
    };
    if (isZhipuImage) {
      // glm-image 只支持 hd；cogview 系列默认 standard，不传就是默认值
      if (/^glm-image$/i.test(String(endpoint.model || ''))) imageBody.quality = 'hd';
    } else {
      imageBody.n = 1;
      imageBody.response_format = 'b64_json';
    }

    try {
      const json = await requestJson({
        url: imagesUrl(endpoint.baseUrl),
        method: 'POST',
        headers,
        body: imageBody,
        // 生图比聊天慢得多，给两分钟
        timeoutMs: 120000
      });

      const item = Array.isArray(json && json.data) ? json.data[0] : null;
      if (!item) return { ok: false, error: '接口没有返回图片（data 是空的）。' };

      if (item.b64_json) {
        return { ok: true, dataUrl: `data:image/png;base64,${item.b64_json}`, model: endpoint.model };
      }
      if (item.url) {
        // 有的服务商无视 response_format 直接给链接；CSP 的 img-src 不含外链，所以在主进程下载回来
        const buffer = await downloadBinary(String(item.url));
        const mime = /\.jpe?g($|\?)/i.test(String(item.url)) ? 'image/jpeg' : 'image/png';
        return {
          ok: true,
          dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
          model: endpoint.model
        };
      }
      return { ok: false, error: '接口返回里既没有 b64_json 也没有 url。' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '生图失败' };
    }
  });

  /**
   * 本机桥接的「配图」：文字直接调 /draw 出图（走本地 ComfyUI，不是云生图）。
   */
  ipcMain.handle('bridge:draw', async (_event, payload) => {
    const request = payload || {};
    const settings = loadSettings();

    const provider = resolveProvider(settings, request.providerId);
    const endpoint = endpointFor(settings, request.providerId, request.model);
    if (!endpoint || !isBridgeProvider(provider)) {
      return { ok: false, error: '生图提供商不是本机桥接，无法用本地模型配图。' };
    }

    const text = String(request.text || '').trim();
    if (!text) return { ok: false, error: '没有可用来配图的文字。' };

    try {
      const result = await bridgeDraw({
        baseUrl: endpoint.baseUrl,
        text,
        characterContext: request.characterContext,
        // 和聊天保持一致：画风预设关掉，长相完全由角色卡决定
        preset: 'none'
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '出图失败' };
    }
  });

  /** 本机桥接出图进度：GET /draw/progress（酒馆配图时轮询） */
  ipcMain.handle('bridge:drawProgress', async (_event, payload) => {
    const request = payload || {};
    const settings = loadSettings();
    const endpoint = endpointFor(settings, request.providerId, request.model);
    if (!endpoint) return { ok: false, error: '还没有配置生图提供商。' };
    try {
      const result = await bridgeDrawProgress(endpoint.baseUrl);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '查询进度失败' };
    }
  });

  ipcMain.handle('util:openPath', async (_event, which) => {
    // 打开真正的数据目录（默认是程序旁边的 data\，见 main/data-dir.js）。
    // ⚠️ 别改回 app.getPath('userData')：那是 Chromium profile，用户会看到一个没有角色卡的文件夹。
    const dir = dataDir();
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      return { ok: false, path: dir, error: `数据文件夹不存在，也建不出来：${err.message}` };
    }

    // 先探这个进程能不能往数据目录里写字。
    // ⚠️ spawn 出 explorer.exe 不等于文件夹真的打开了：沙箱进程继承受限令牌，请求递不到已开的资源管理器，用户看到「没反应」这边却返回 ok。
    const writable = probeDirWritable(dir);
    const info = dataDirInfo();

    // 失败时要把「打不开」和原因一起交回界面，不能只递回一个路径让用户对着 Windows 弹框猜
    if (process.platform === 'win32') {
      const error = await openFolderInExplorer(dir);
      if (error) {
        return {
          ok: false,
          path: dir,
          info,
          error: writable.ok ? error : `${error}（另外，这个进程也写不进这个目录：${writable.error}）`
        };
      }
      if (!writable.ok) {
        return {
          ok: false,
          path: dir,
          info,
          writable: false,
          error:
            `资源管理器已启动，但这个进程写不进数据目录（${writable.error}）—— 保存会全部失败。` +
            '常见原因：程序所在的文件夹被沙箱限制住了（文件夹被打了低完整性标签，里面的 exe ' +
            '跑起来就被降级，只能写这个文件夹），或者那个目录本身没有写权限。' +
            '处理：清掉这个文件夹上的低完整性标签，或者把整个 Mimitale 文件夹复制到别处再启动。'
        };
      }
      return { ok: true, path: dir, info, writable: true };
    }

    // 非 Windows：shell.openPath 是常规做法，它的返回值就是错误信息
    const error = await shell.openPath(dir);
    return error ? { ok: false, path: dir, info, error } : { ok: true, path: dir, info, writable: writable.ok };
  });

  // 桌宠的通道在 main/pet-ipc.js（独立窗口 / 模型调用 / 控制器），但仍在这里统一注册
  registerPetIpc();
}

module.exports = { registerIpc };
