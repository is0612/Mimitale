// ---------------------------------------------------------------------------
//  内置目录兜底：服务商模型清单 + 生图尺寸规则
//
//  「服务商没提供模型列表接口时怎么办」这件事的完整实现。拉取模型走的是：
//
//      OpenAI 那套 GET /models
//
//  但不少国内服务商根本没有这个接口（智谱就是），请求会被网关拒掉（常见 406）。
//  本模块的答案是不让用户卡在一个看不懂的错误码上 —— 改把已知模型直接填进表单。
//  往表单里写字的那一步（applyCatalogModels）**不在这里**，留在 views/settings.js：
//  它要用那边的 stashProviderForm() 和入口层注入的 refreshModelSwitch()。
//
//  导出的五个名字就是本模块对外的全部接口：
//   · catalogForBaseUrl / imageCatalogModels  查有哪些内置模型
//   · looksLikeUnsupportedModelList           判断失败原因是不是「这家没有这个接口」
//   · preferImageModel / fillImageSizeOptions 把上面这些铺进设置界面
// ---------------------------------------------------------------------------

import { el } from '../core/dom.js';
import { h } from '../ui/build.js';
import { fillSelect } from '../ui/controls.js';
import { showToast } from '../ui/toast.js';
import { providerById } from '../data/providers.js';

// ------------------------------ 模型目录 ------------------------------

/**
 * 各服务商的已知模型目录。
 *
 * 按接口地址里的域名匹配，而不是按服务商名字 —— 名字用户可以随便改。
 *
 * ⚠️ 这份清单和 main/providers.js 的 PROVIDER_PRESETS **是两件事**：
 *    · PRESETS 是「第三方模型提供商」点开时一键填充的**起步值**（可以随便改）；
 *    · 这里是拉取失败时兜底填进去的**内置目录**（本质是「这家有哪些模型」的知识）。
 *    两边都只收国内平台（对不上时以 PRESETS 为准）。
 *
 * imageModels 是「生图」那一组能用的模型。文本模型不能拿来生图，
 * 选错了接口会报 404 —— 这个坑很容易踩，所以单独列出来。
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
    // ⚠️ 智谱没有 GET /models（网关直接 406），所以它**只能**靠这份目录填模型。
    //    改了模型名一定要同步这里，否则用户点「拉取」永远拿不到东西。
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
  // 没列进来的国内平台（豆包 / 硅基流动 / 百度千帆 / 阶跃星辰 / 讯飞星火 /
  // 零一万物）都支持 GET /models，点一次「拉取可用模型」就是真实清单，
  // 不需要内置兜底 —— 所以这里只留「拉不动」的（智谱）和预设里那几家。
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
 * 拉取失败时，判断是不是「这个服务商压根没有模型列表接口」。
 *
 * ⚠️ 这里只能看**状态码**，不能拿中文文案去模糊匹配：main/http.js 给 404 写的提示是
 *    「404 找不到接口：多半是「接口地址」写错了」，给 400 写的是「参数不被该服务商接受」——
 *    「找不到接口」「不被接受」这两个词都被下面的关键词撞上，于是**接口地址写错**
 *    也会被当成「这家没有模型列表接口」，弹一句成功语气的兜底提示，把人带到错误的方向。
 *
 *    哪些码算「这个端点不存在」：
 *      · 404 Not Found      —— 大部分兼容层没有 /models 就是这个
 *      · 405 / 501          —— 方法不允许 / 没实现
 *    刻意**不含** 400 / 406 / 401 / 403：那些是「地址对、但请求本身被拒」
 *    （Key 没权限、网关拦了），不是端点不存在，照实报错更有用。
 */
export function looksLikeUnsupportedModelList(message) {
  const text = String(message || '');
  return /\b(404|405|501)\b/.test(text);
}

// ------------------------------ 生图尺寸规则 ------------------------------

/**
 * 各生图模型支持的图片尺寸。
 *
 * 这个必须按模型区分：两家都只认自己那份「推荐尺寸 + 自定义区间」，
 * 一律发 1024x1024 在只收固定档的模型上会被接口拒掉
 * （智谱错误码 1210「参数有误」）。参数照各自官方文档抄：
 *   · GLM-Image  推荐 7 档，自定义 512-2048、长宽均为 32 的整数倍
 *   · CogView-3  推荐 7 档，自定义 512-2048、长宽均被 16 整除，且总像素 ≤ 2^21
 *
 * ⚠️ glm-image 的自定义下限是 **512**，不是推荐尺寸里最小的 1024：
 *    512x512、800x800 这类合法尺寸不能被自家校验判成非法而悄悄换掉；
 *    1024x1024 本来就在 512-2048 内、也是 32 的倍数，不需要被「纠正」。
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

/** 某个生图模型可选的尺寸列表 */
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
 * 生图模型优先选对的。
 *
 * 坑：provider.models 里通常全是文本模型，生图那一组下拉如果直接沿用，
 * 就会把 glm-5.3 这种文本模型发给 /images/generations，接口报 404。
 * 所以有内置生图目录时，主动切过去并说明原因；
 * 用户自己指定了生图模型（模型名看着像生图模型）就不抢。
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

/**
 * 按当前生图模型重建尺寸下拉，并尽量保留用户原来的选择。
 * 模型不认识时用通用尺寸，不拦着用户。
 */
export function fillImageSizeOptions(model, current) {
  const select = el.s && el.s.imageSize;
  if (!select) return;

  const sizes = sizesForImageModel(model);
  const wanted = String(current || '').trim();
  const items = sizes.map((size) => ({ value: size, text: size }));

  // 已保存的尺寸不在这个模型的列表里，分两种：
  //   · 非法（比如 glm-image 配 1024x1024）——切到默认值，别让它再撞一次
  //   · 合法自定义尺寸 —— 补一项摆在列表后面，并且**选中它**（不静默改掉用户的选择）
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
