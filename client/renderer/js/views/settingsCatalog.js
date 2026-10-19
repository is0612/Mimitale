// 内置模型目录 + 生图尺寸规则：服务商没有 GET /models（常见 406）时的兜底。
// 往表单里写字的那一步（applyCatalogModels）在 views/settings.js。

import { el } from '../core/dom.js';
import { h } from '../ui/build.js';
import { fillSelect } from '../ui/controls.js';
import { showToast } from '../ui/toast.js';
import { providerById } from '../data/providers.js';

// ------------------------------ 模型目录 ------------------------------

/**
 * ⚠️ 按接口地址里的**域名**匹配，不按服务商名字（名字用户可以随便改）。
 * ⚠️ 和 main/providers.js 的 PROVIDER_PRESETS 是两件事：那边是一键填充的起步值，这里是内置目录。
 * imageModels 单列：文本模型不能拿来生图，选错接口报 404。
 */
const MODEL_CATALOG = [
  {
    match: /dashscope\.aliyuncs\.com/i,
    name: '通义千问',
    note: '通义的 OpenAI 兼容模式对部分 Key 不返回模型列表，可先手填',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    imageModels: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wanx-v1']
  },
  {
    // ⚠️ 智谱没有 GET /models（网关直接 406），只能靠这份目录；改模型名必须同步这里。
    match: /bigmodel\.cn/i,
    name: '智谱 GLM',
    note: '智谱不提供模型列表接口（会返回 406），这里的清单是内置的',
    models: ['glm-4.6', 'glm-4.7-flash', 'glm-4-flash'],
    imageModels: ['glm-image', 'cogview-3-flash']
  },
  {
    match: /moonshot\.cn/i,
    name: 'Kimi',
    note: 'Moonshot 支持模型列表；若拉取失败可从下面挑',
    models: ['kimi-k2.6', 'kimi-k2-thinking', 'moonshot-v1-8k', 'moonshot-v1-32k'],
    imageModels: []
  },
  {
    match: /deepseek\.com/i,
    name: 'DeepSeek',
    note: 'DeepSeek 支持模型列表；若拉取失败可从下面挑',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    // DeepSeek 目前没有生图模型
    imageModels: []
  },
  {
    match: /hunyuan\.cloud\.tencent\.com/i,
    name: '腾讯混元',
    note: '混元支持模型列表；向量检索可以试试 hunyuan-embedding',
    models: ['hunyuan-turbos-latest', 'hunyuan-lite', 'hunyuan-t1-latest'],
    imageModels: []
  },
  {
    match: /minimax/i,
    name: 'MiniMax',
    note: 'MiniMax 支持模型列表；若拉取失败可从下面挑',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'],
    imageModels: []
  }
];

export function catalogForBaseUrl(baseUrl) {
  const url = String(baseUrl || '');
  return MODEL_CATALOG.find((c) => c.match.test(url)) || null;
}

/** 某个服务商的内置生图模型（用来并进生图模型下拉） */
export function imageCatalogModels(providerId) {
  const provider = providerById(providerId);
  if (!provider) return [];
  const catalog = catalogForBaseUrl(provider.baseUrl);
  return catalog && Array.isArray(catalog.imageModels) ? catalog.imageModels : [];
}

/**
 * ⚠️ 只能看**状态码**，不能拿中文文案模糊匹配：404 / 400 的提示文案里「找不到接口」「不被接受」
 *    会被下面的关键词撞上，接口地址写错也会被当成「这家没有模型列表接口」。
 *    只认 404 / 405 / 501；不含 400 / 406 / 401 / 403 —— 那些是「地址对但请求被拒」，照实报错更有用。
 */
export function looksLikeUnsupportedModelList(message) {
  const text = String(message || '');
  return /\b(404|405|501)\b/.test(text);
}

// ------------------------------ 生图尺寸规则 ------------------------------

/**
 * 尺寸必须按模型区分：一律发 1024x1024 在只收固定档的模型上会被拒（智谱错误码 1210「参数有误」）。
 * ⚠️ glm-image 的自定义下限是 **512**，不是推荐尺寸里最小的 1024 —— 512x512 是合法尺寸，不能被判成非法。
 */
const MAX_CUSTOM_PIXELS = 2 ** 21; // CogView 的硬上限：总像素不超过 2^21

const IMAGE_SIZE_RULES = [
  {
    match: /^glm-image$/i,
    label: 'GLM-Image',
    sizes: ['1280x1280', '1568x1056', '1056x1568', '1472x1088', '1088x1472', '1728x960', '960x1728'],
    custom: { min: 512, max: 2048, step: 32 },
    note: '推荐 1280x1280。自定义需在 512-2048 之间、且长宽均为 32 的整数倍'
  },
  {
    match: /^cogview/i,
    label: 'CogView',
    sizes: ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'],
    custom: { min: 512, max: 2048, step: 16, maxPixels: MAX_CUSTOM_PIXELS },
    note: '推荐 1024x1024。自定义需在 512-2048 之间、长宽被 16 整除，且总像素不超过 2^21'
  }
];

const DEFAULT_IMAGE_SIZES = ['1024x1024', '1024x1792', '1792x1024', '512x512'];

function imageSizeRule(model) {
  const name = String(model || '').trim();
  return IMAGE_SIZE_RULES.find((r) => r.match.test(name)) || null;
}

function sizesForImageModel(model) {
  const rule = imageSizeRule(model);
  return rule ? rule.sizes : DEFAULT_IMAGE_SIZES;
}

/** 尺寸是否合法：已知模型按规则校验，未知模型只做基本格式检查 */
function isValidImageSize(model, size) {
  const value = String(size || '').trim().toLowerCase();
  if (!/^\d{2,4}x\d{2,4}$/.test(value)) return false;

  const rule = imageSizeRule(model);
  if (!rule) return true;

  if (rule.sizes.includes(value)) return true;

  // 不在推荐列表里也可能合法（自定义尺寸），按规则体检
  if (!rule.custom) return false;
  const [w, hgt] = value.split('x').map(Number);
  const { min, max, step, maxPixels } = rule.custom;
  const inRange = (n) => n >= min && n <= max && n % step === 0;
  if (!inRange(w) || !inRange(hgt)) return false;
  // CogView 还限总像素：长宽各自合法、乘起来仍可能超上限
  if (typeof maxPixels === 'number' && w * hgt > maxPixels) return false;
  return true;
}

// ------------------------------ 铺进设置界面 ------------------------------

/**
 * ⚠️ provider.models 里通常全是文本模型：生图下拉直接沿用会把文本模型发给 /images/generations，报 404。
 * 有内置生图目录时主动切过去；用户自己选了看着像生图模型的不抢。
 */
export function preferImageModel(provider) {
  if (!provider) return;
  const select = el.s && el.s.imageModel;
  if (!select) return;

  const imageModels = imageCatalogModels(provider.id);
  if (!imageModels.length) return;

  const available = Array.isArray(provider.models) ? provider.models.filter(Boolean) : [];
  const current = String(select.value || '').trim();

  // 当前已经是这家已知的生图模型 —— 不用动
  if (current && imageModels.includes(current)) return;
  // 用户自己在模型列表里放了生图模型并选中了它 —— 尊重用户
  if (current && current !== available[0] && /image|cogview|dall-e|wanx|flux|sd|stable/i.test(current)) return;

  const target = imageModels[0];
  if (target === current) return;

  const option = Array.from(select.options || []).find((o) => o.value === target);
  if (option) {
    select.value = target;
  } else {
    select.appendChild(h('option', { value: target, text: `${target}（内置）` }));
    select.value = target;
  }

  showToast(
    `这家提供商的生图模型是 ${imageModels.join(' / ')}，` +
      `已从「${current || '文本模型'}」切到「${target}」——` +
      '文本模型不能用来生图，选错会报 404',
    'ok'
  );
}

/** 按当前生图模型重建尺寸下拉，尽量保留用户原来的选择；模型不认识时用通用尺寸，不拦着。 */
export function fillImageSizeOptions(model, current) {
  const select = el.s && el.s.imageSize;
  if (!select) return;

  const sizes = sizesForImageModel(model);
  const wanted = String(current || '').trim();
  const items = sizes.map((size) => ({ value: size, text: size }));

  // 已保存尺寸不在列表里分两种：非法 → 切默认值；合法自定义 → 补一项并选中（不静默改掉用户选择）。
  if (wanted && !sizes.includes(wanted) && !isValidImageSize(model, wanted)) {
    const fallback = sizes[0];
    fillSelect(select, items, { prefer: fallback });
    const rule = imageSizeRule(model);
    if (rule) {
      showToast(
        `${rule.label} 不支持 ${wanted}，已改成 ${fallback}` + (rule.note ? `（${rule.note}）` : ''),
        'ok'
      );
    }
    return;
  }

  if (wanted && !sizes.includes(wanted)) items.push({ value: wanted, text: `${wanted}（自定义）` });
  fillSelect(select, items, { prefer: wanted || sizes[0] });
}
