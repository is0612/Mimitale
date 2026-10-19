'use strict';

// main/providers.js —— 服务商与模型列表 + config.json 的读写（归一化、旧配置升级、Key 加解密）
// ============================================================================

const {
  dataFile,
  loadJsonWithFallback,
  writeJson,
  encryptApiKey,
  decryptApiKey
} = require('./store.js');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * 待告知用户的设置迁移通知：normalizeSettings 是纯函数、会被频繁调用，所以用队列 + 去重，由 settings:get 取走弹 toast。
 */
let pendingSettingsNotices = [];
function takeSettingsNotices() {
  const out = pendingSettingsNotices;
  pendingSettingsNotices = [];
  return out;
}

// 内置服务商预设（「第三方模型提供商」按钮一键填充）。
// ⚠️ baseUrl 一律用各家公开的 OpenAI 兼容端点，别换成 SDK 文档里的原生协议地址；models 不保证最新，可「拉取可用模型」。
const PROVIDER_PRESETS = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    key: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo']
  },
  {
    key: 'kimi',
    name: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2.6', 'kimi-k2-thinking', 'moonshot-v1-8k']
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.7-flash', 'glm-4-flash']
  },
  {
    key: 'hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbos-latest', 'hunyuan-lite']
  },
  {
    key: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed']
  },
  // 其它 OpenAI 兼容平台（豆包 / 硅基流动 / 境外平台 …）一律走下面「自定义模型API」自己填地址
  {
    key: 'tavern-bridge',
    name: '本地 AI 桥接',
    baseUrl: 'http://127.0.0.1:8000',
    // 桥接走自己的 /chat_with_image（非 OpenAI 兼容、免 Key），模型名只是给界面看的
    models: ['本地模型'],
    type: 'tavern-bridge'
  },
  {
    key: 'custom',
    name: '自定义模型API',
    baseUrl: '',
    models: []
  }
];

// 所有预设里出现过的模型（去重），仅用于界面提示
const COMMON_MODELS = [...new Set(PROVIDER_PRESETS.flatMap((p) => p.models))];

const DEFAULT_PROVIDER_ID = 'p1';

// 背景图上限：config.json 每次改设置都整份重写，必须限长
const MAX_CHAT_BACKGROUND_CHARS = 4000000;

// 默认人设上限：它每轮都拼进系统提示词，太长白白吃上下文
const MAX_ASSISTANT_PERSONA_CHARS = 20000;

// 配色可选值（加新配色要同时改 style.css / ui/theme.js / preload.js）。
// ⚠️ 第一项就是默认配色（多处 fallback 写成 ACCENTS[0]），换默认 = 换顺序。
const ACCENTS = ['amber'];

const DEFAULT_SETTINGS = {
  providers: [
    {
      id: DEFAULT_PROVIDER_ID,
      name: 'DeepSeek',
      baseUrl: DEFAULT_BASE_URL,
      apiKey: '',
      models: ['deepseek-chat', 'deepseek-reasoner']
    }
  ],
  activeProviderId: DEFAULT_PROVIDER_ID,
  activeModel: DEFAULT_MODEL,
  temperature: 0.7,
  // 回复上限：推理模型的思考过程也计入这个额度，设小了会「思考没写完、正文一个字没出」
  maxTokens: 8192,
  topP: 0.95,
  thinking: true,
  // 界面主题：light / dark。
  // ⚠️ 必须是真实的出厂默认：main/window.js 拿它当首屏窗口底色，写错会先闪一下白底。
  theme: 'dark',
  // 配色方案（与明暗正交；不认识的值在归一化时退回 ACCENTS[0]）
  accent: 'amber',
  sendOnEnter: true,
  showDate: true,
  showUsage: true,
  // 世界书递归最多连锁几层，0 = 完全关掉。
  // ⚠️ 默认 1：条目级缺省即可递归，默认必须小；没有 token 预算，深度是唯一刹车，导入互引很多的大书就调成 0。
  worldbookRecursiveDepth: 1,
  // 最多带多少轮对话进请求（调大更记得住，但每轮都重发，更早的内容归记忆摘要管）
  maxTurns: 20,
  // --- 生图（和聊天是两套：不同端点，通常也是不同模型）---
  imageProviderId: '',
  imageModel: '',
  imageSize: '1024x1024',
  // --- 语义检索（RAG）：又是一组独立配置，走 /embeddings ---
  ragEnabled: false,
  embeddingProviderId: '',
  embeddingModel: '',
  // --- 对话窗口外观（只影响显示，不进提示词）---
  chatFontSize: 14,     // 消息正文字号（px）
  // 界面字号三档（small 0.9 / medium 1 / large 1.15），全站字号 token 都乘它
  uiSize: 'medium',
  // 界面字体：key 对应 renderer 那边 UI_FONTS 里的一套字体栈。
  uiFont: 'default',
  chatBoldColor: '',    // **加粗** 用什么颜色，空 = 跟随主题
  chatBackground: '',   // 自定义聊天背景（dataURL）
  chatBuiltinBackground: true, // 无自定义图时使用内置雾林皮肤；清除背景可关闭
  // 左右内边距是两个独立的值：浮动卡片常占左下角，只需推开左边，用一个对称值会让右边白缩。
  // 20 = 设计稿的消息流内边距。
  chatPadLeft: 20,
  chatPadRight: 20,
  // --- 界面能写的键必须列在这儿 ---
  // ⚠️ 新设置项只从界面保存、却没列进 DEFAULT_SETTINGS，全新安装时第一次保存就会被静默丢掉。
  autoContinue: true,       // 正文被 maxTokens 截断时自动接着写完
  // --- 默认人设：没绑角色卡的会话用，按模型各存一份 ---
  // 结构 { [模型名]: { name, persona } }；没有条目 = 通用助手。绑了角色卡的会话完全不参与。
  assistantPersonas: {},
  // --- 设置结构版本：只用来做一次性迁移（1 = 旧结构；2 = 递归深度已收敛）---
  // saveSettings 会把整份结果落盘，老配置里每个键都是显式写着的，光改默认值对他们完全无效。
  settingsVersion: 2
};

function newProviderId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`;
}

/** 把任意来源的服务商对象整理成统一形状 */
function normalizeProvider(raw, fallbackId) {
  const p = raw && typeof raw === 'object' ? raw : {};

  const rawModels = Array.isArray(p.models)
    ? p.models
    : typeof p.models === 'string'
      ? p.models.split(/[\n,，]/)
      : [];

  return {
    id: p.id || fallbackId || newProviderId(),
    name: String(p.name || '').trim() || '未命名提供商',
    baseUrl: String(p.baseUrl || '').trim() || DEFAULT_BASE_URL,
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : '',
    models: [...new Set(rawModels.map((m) => String(m || '').trim()).filter(Boolean))],
    // 协议类型：'openai'（默认，OpenAI 兼容）或 'tavern-bridge'（本机桥接，免 Key、非流式）
    type: p.type === 'tavern-bridge' ? 'tavern-bridge' : 'openai'
  };
}

/** 是不是本机酒馆桥接服务商（协议与 OpenAI 兼容那套完全不同） */
function isBridgeProvider(provider) {
  return !!(provider && provider.type === 'tavern-bridge');
}

/** 把磁盘上的设置整理成当前结构（旧的扁平 baseUrl/apiKey/model 会自动升级成一个服务商） */
function normalizeSettings(saved) {
  const raw = saved && typeof saved === 'object' ? saved : {};
  const s = { ...DEFAULT_SETTINGS, ...raw };

  // --- 设置结构迁移（一次性）---
  // ⚠️ 判据一律基于 `raw`（磁盘原样），不能用合并后的 `s`；⚠️ 只改内存不落盘，落盘必须走 saveSettings（只有它会加密 Key）。
  const settingsVersion = Number.isFinite(Number(raw.settingsVersion)) ? Number(raw.settingsVersion) : 1;

  // v1 → v2：条目语义改成酒馆口径后旧的「深度 3」更激进，把恰好等于旧默认值 3 的收敛到新默认值（用户改的 0/2/4/5 不碰）。
  // ⚠️ 目标写 DEFAULT_SETTINGS.worldbookRecursiveDepth；⚠️ 这里只算标志位、不改 s，否则会被后面的字段归一化覆盖。
  const migrateRecursiveDepth = settingsVersion < 2 && Number(raw.worldbookRecursiveDepth) === 3;
  s.settingsVersion = DEFAULT_SETTINGS.settingsVersion;

  // 判断磁盘上有没有 providers，不能看合并后的 s（默认值自带，旧配置永远进不了迁移分支）
  const hasProviders = Array.isArray(raw.providers) && raw.providers.length > 0;

  if (!hasProviders) {
    // ---- 旧版扁平配置（或全新安装）：整体搬进 providers[0] ----
    const legacyUrl = String(raw.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    const preset = PROVIDER_PRESETS.find(
      (p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '') === legacyUrl
    );
    const legacyModels = raw.model ? [String(raw.model).trim()].filter(Boolean) : [];
    // 自定义地址匹配不到预设时，别硬套「DeepSeek」这个名字
    const fallbackName = raw.baseUrl ? '自定义模型API' : DEFAULT_SETTINGS.providers[0].name;

    s.providers = [
      normalizeProvider(
        {
          id: DEFAULT_PROVIDER_ID,
          name: preset ? preset.name : fallbackName,
          baseUrl: raw.baseUrl || DEFAULT_BASE_URL,
          apiKey: raw.apiKey || '',
          // 旧配置里没写模型就用默认列表，别留下一个空列表
          models: legacyModels.length ? legacyModels : [...DEFAULT_SETTINGS.providers[0].models]
        },
        DEFAULT_PROVIDER_ID
      )
    ];
    s.activeProviderId = DEFAULT_PROVIDER_ID;
    s.activeModel = raw.model || DEFAULT_SETTINGS.activeModel;
  } else {
    s.providers = s.providers.map((p, i) => normalizeProvider(p, `p${i + 1}`));
  }

  // 当前服务商必须真实存在
  if (!s.providers.some((p) => p.id === s.activeProviderId)) {
    s.activeProviderId = s.providers[0].id;
  }

  // 当前模型必须真实存在，否则退回第一个可用模型
  const allModels = s.providers.flatMap((p) => p.models);
  if (!s.activeModel || !allModels.includes(s.activeModel)) {
    const current = s.providers.find((p) => p.id === s.activeProviderId);
    s.activeModel = current.models[0] || allModels[0] || DEFAULT_MODEL;
  }

  // 当前服务商跟着当前模型走，但先尊重已经选好的那一对。
  // ⚠️ 模型名跨服务商会重复，不能直接 find(models.includes(activeModel))：那是「谁先有归谁」，用户显式切到 B 会被静默改回 A。
  const current = s.providers.find((p) => p.id === s.activeProviderId);
  const currentHasModel = !!(current && current.models.includes(s.activeModel));
  if (!currentHasModel) {
    // 当前服务商确实没有这个模型 → 才去找有它的那家
    const owner = s.providers.find((p) => p.models.includes(s.activeModel));
    if (owner) {
      s.activeProviderId = owner.id;
    } else if (current) {
      current.models = [s.activeModel, ...current.models];
    }
  }

  // 界面主题：默认夜间，只有明确写了 'light' 才走浅色。
  s.theme = raw.theme === 'light' ? 'light' : 'dark';

  // 配色方案（不认识的值退回默认方案，见 ACCENTS 第一项：琥珀灯）
  s.accent = ACCENTS.includes(raw.accent) ? raw.accent : ACCENTS[0];

  // 生图配置只做格式清洗：不存在的服务商 id 也留着（用户可能还没保存那个服务商）
  s.imageProviderId = typeof raw.imageProviderId === 'string' ? raw.imageProviderId.trim().slice(0, 60) : '';
  s.imageModel = typeof raw.imageModel === 'string' ? raw.imageModel.trim().slice(0, 120) : '';
  const imgSize = String(raw.imageSize || '').trim();
  // 尺寸各家不一样，不写死白名单，只要求是「数字x数字」
  s.imageSize = /^\d{2,4}x\d{2,4}$/i.test(imgSize) ? imgSize.toLowerCase() : DEFAULT_SETTINGS.imageSize;

  // 语义检索默认关：开着时每轮多调一次向量接口，第一轮还要补索引，得让用户明确知道在花钱
  s.ragEnabled = raw.ragEnabled === true;
  s.embeddingProviderId = typeof raw.embeddingProviderId === 'string' ? raw.embeddingProviderId.trim().slice(0, 60) : '';
  s.embeddingModel = typeof raw.embeddingModel === 'string' ? raw.embeddingModel.trim().slice(0, 120) : '';

  // 世界书递归深度，0 = 关（条目勾了也不连锁）。
  // ⚠️ 迁移优先于磁盘上的值：旧配置里这个键一定是显式的 3，不在这里拦，migrateRecursiveDepth 就白算了。
  const depth = Number(raw.worldbookRecursiveDepth);
  if (migrateRecursiveDepth) {
    s.worldbookRecursiveDepth = DEFAULT_SETTINGS.worldbookRecursiveDepth;
    const notice =
      '世界书递归深度的旧默认值（3 层）在新的条目语义下会比以前更激进，' +
      `已收敛到新的默认值 ${DEFAULT_SETTINGS.worldbookRecursiveDepth} 层（只带一层）。` +
      '点一次「保存设置」就会固化；想恢复多层就在「设置 → 行为」里调大，想全关就填 0。';
    if (!pendingSettingsNotices.includes(notice)) pendingSettingsNotices.push(notice);
  } else {
    s.worldbookRecursiveDepth =
      Number.isFinite(depth) && depth >= 0 && depth <= 5
        ? Math.floor(depth)
        : DEFAULT_SETTINGS.worldbookRecursiveDepth;
  }

  // 对话轮数：上限给到 200（用户自己的选择，拦太死像 bug），只管下限和非数字
  const turns = Number(raw.maxTurns);
  s.maxTurns =
    Number.isFinite(turns) && turns >= 1 && turns <= 200
      ? Math.floor(turns)
      : DEFAULT_SETTINGS.maxTurns;

  // 外观项只影响显示，值不合法退回默认是安全的
  const fontSize = Number(raw.chatFontSize);
  s.chatFontSize =
    Number.isFinite(fontSize) && fontSize >= 12 && fontSize <= 22
      ? Math.round(fontSize)
      : DEFAULT_SETTINGS.chatFontSize;

  const boldColor = typeof raw.chatBoldColor === 'string' ? raw.chatBoldColor.trim() : '';
  // 只收 #rgb / #rrggbb / #rrggbbaa，别的当没设过（防止塞 `red; background:url(...)`）
  s.chatBoldColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(boldColor) ? boldColor : '';

  // 界面字号 / 字体：白名单，不能把任意字符串透进 CSS 变量（--ui-size / --font-ui）。
  // ⚠️ 白名单要和 renderer/js/views/appearance.js 的 UI_SCALES / UI_FONTS 手改同步。
  s.uiSize = ['small', 'medium', 'large'].includes(raw.uiSize) ? raw.uiSize : DEFAULT_SETTINGS.uiSize;
  s.uiFont = ['default', 'noto', 'simhei', 'serif'].includes(raw.uiFont) ? raw.uiFont : DEFAULT_SETTINGS.uiFont;

  s.chatBuiltinBackground = raw.chatBuiltinBackground !== false;
  const bg = typeof raw.chatBackground === 'string' ? raw.chatBackground : '';
  s.chatBackground =
    bg.startsWith('data:image/') && bg.length <= MAX_CHAT_BACKGROUND_CHARS ? bg : '';

  // 内边距夹到 12–360：拖到头就是头，不该忽然弹回默认 20（上限再大消息区就窄得没法读）。
  // ⚠️ 和 renderer/js/views/appearance.js 的 CHAT_PAD_MIN / CHAT_PAD_MAX 是同一套值，改一处必须手改另一处。
  for (const key of ['chatPadLeft', 'chatPadRight']) {
    const n = Number(raw[key]);
    s[key] = Number.isFinite(n) ? Math.min(360, Math.max(12, Math.round(n))) : DEFAULT_SETTINGS[key];
  }

  // 清掉旧版遗留键：保存白名单是「默认里有 or 磁盘上有」，光从 DEFAULT_SETTINGS 撤掉拦不住它。
  delete s.commonAttributes;

  // 默认人设逐条清洗：键为空 / 超长的丢掉，名字和人设都空的丢掉（空壳只会在 config.json 里越积越多）
  const personas = {};
  const rawPersonas = raw.assistantPersonas;
  if (rawPersonas && typeof rawPersonas === 'object' && !Array.isArray(rawPersonas)) {
    for (const [key, value] of Object.entries(rawPersonas)) {
      const model = String(key || '').trim().slice(0, 120);
      if (!model) continue;
      const entry = value && typeof value === 'object' ? value : {};
      const name = String(entry.name || '').trim().slice(0, 40);
      const persona =
        typeof entry.persona === 'string'
          ? entry.persona.trim().slice(0, MAX_ASSISTANT_PERSONA_CHARS)
          : '';
      if (!name && !persona) continue;
      personas[model] = { name, persona };
    }
  }
  s.assistantPersonas = personas;

  // 清掉旧版本的扁平字段，避免文件里同时存在两套数据
  delete s.baseUrl;
  delete s.apiKey;
  delete s.model;
  // 旧版「全局人设」键留着会在 config.json 里积两套数据。
  // ⚠️ maxTurns 不是遗留键，别顺手 delete —— 会把刚归一化好的值删掉，改轮数不生效。
  delete s.systemPrompt;
  delete s.userName;

  return s;
}

/** 取出指定服务商；找不到就退回当前 / 第一个 */
function resolveProvider(settings, providerId) {
  const list = Array.isArray(settings.providers) ? settings.providers : [];
  if (!list.length) return null;
  return (
    list.find((p) => p.id === providerId) ||
    list.find((p) => p.id === settings.activeProviderId) ||
    list[0]
  );
}

/** 把「服务商 + 模型」拼成 streamChat 需要的扁平设置 */
function endpointFor(settings, providerId, model) {
  const provider = resolveProvider(settings, providerId);
  if (!provider) return null;

  const chosen =
    String(model || '').trim() || provider.models[0] || settings.activeModel || DEFAULT_MODEL;

  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: chosen,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    topP: settings.topP,
    thinking: settings.thinking !== false
  };
}

function loadSettings() {
  const saved = loadJsonWithFallback(dataFile('config.json')) || {};
  const settings = normalizeSettings(saved);

  // 内存里始终是明文 Key
  settings.providers = settings.providers.map((p) => ({
    ...p,
    apiKey: p.apiKey ? decryptApiKey(p.apiKey) : ''
  }));

  return settings;
}

let settingsSaveQueue = Promise.resolve();

function saveSettings(patch) {
  const snapshot = structuredClone(patch && typeof patch === 'object' ? patch : {});
  const task = settingsSaveQueue.then(() => saveSettingsPatch(snapshot));
  settingsSaveQueue = task.catch(() => {});
  return task;
}

function saveSettingsPatch(patch) {
  const current = loadSettings();

  // 白名单：只收「默认设置里有」或「磁盘上本来就有」的键，否则任何能调到这个通道的人都能把垃圾键永久写进 config.json。
  // ⚠️ 用 hasOwn 而不是 `in`：`in` 会走原型链，constructor / toString 这类内置名能混过去、一旦落盘就永远留着。
  const clean = {};
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (hasOwn(DEFAULT_SETTINGS, key) || hasOwn(current, key)) clean[key] = value;
    else console.warn(`保存设置时忽略了未知字段「${key}」`);
  }

  const merged = normalizeSettings({ ...current, ...clean });

  // 落盘前把每个服务商的 Key 都加密
  const toSave = {
    ...merged,
    providers: merged.providers.map((p) => ({
      ...p,
      apiKey: p.apiKey ? encryptApiKey(p.apiKey) : ''
    }))
  };

  // ⚠️ 返回**写盘的 Promise**：写失败必须让调用方接住，否则界面照样弹「设置已保存」，重启后 Key / 服务商全没了。
  return writeJson(dataFile('config.json'), toSave).then(() => merged); // 明文版本供界面使用
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  PROVIDER_PRESETS,
  COMMON_MODELS,
  DEFAULT_SETTINGS,
  ACCENTS,
  normalizeProvider,
  normalizeSettings,
  resolveProvider,
  endpointFor,
  isBridgeProvider,
  loadSettings,
  saveSettings,
  takeSettingsNotices
};
