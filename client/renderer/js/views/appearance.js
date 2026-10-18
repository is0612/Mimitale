'use strict';

// ============================================================================
//  views/appearance.js —— 对话窗口外观（字号 / 加粗颜色 / 背景图）
//
//  这三样只影响「怎么显示」，一个字都不会进提示词。
//  实现上都是往 <html> 上写 CSS 变量，样式表里用 var() 取 ——
//  这样换主题、换背景都不用重写一套规则。
//
//  外观控件在 设置 → 外观（#sec-appearance）里。只挪容器、不碰 id，
//  所以下面的接线保持原样。入口层只从这儿取两个：
//    · applyChatAppearance()  启动时把设置里的外观刷到 CSS 变量上
//    · renderAppearanceForm() 设置页切到「外观」这一组时回填控件
//  其余（落盘、选图、滑块、配色、明暗）都由 initAppearance() 内部接线。
// ============================================================================

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';
import { setAccent, setTheme } from '../ui/theme.js';

const CHAT_FONT_MIN = 12;
const CHAT_FONT_MAX = 22;
const CHAT_FONT_DEFAULT = 14;

// ---------------------------------------------------------------------------
//  界面字号：三档 → 一个 --ui-size 系数
//
//  为什么是「一个系数 × 一组 token」而不是「三张字号表」：
//  样式表里所有字号只认 --fs-xs/sm/md/lg/xl 五个 token，而这五个 token 本身就写成
//  `calc(基准px * var(--ui-size))`（见 style.css 的 :root）。所以这里只写一个数，
//  整站（标题 / 按钮 / 列表 / 弹窗）等比缩放，层次一格不乱。
//
//  ⚠️ 「小」档会让最小的那个 token 落到 10.8px —— 那是用户自己选的紧凑档；
//     默认的「中」严格 ≥12px（界面字号不小于 12、不要小数、用双数）。
// ---------------------------------------------------------------------------
export const UI_SCALES = { small: 0.9, medium: 1, large: 1.15 };
const UI_SCALE_DEFAULT = 'medium';

// 界面字体：这几套都是**本机实测装了的**，每条都带满回退 ——
// 就算真选到没装的那套，也只是回退到雅黑，不会出现方框。
export const UI_FONTS = {
  default: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
  noto: '"Noto Sans SC", "Source Han Sans CN", "Microsoft YaHei", sans-serif',
  simhei: '"SimHei", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif SC", "SimSun", "Songti SC", serif'
};
const UI_FONT_DEFAULT = 'default';
// 对话宽度的左右内缩。20 = 设计稿的消息流内边距；360 是上限，
// 再大消息区就窄得没法读了（1440 的窗口两侧各 360 只剩 470）。
// 这两个常量是 export 的：宽度那套 UI（顶栏弹层 + 两侧抓手）在 views/chatPad.js，
// 两边必须同一个上限 —— 别再各写一份。
export const CHAT_PAD_DEFAULT = 20;
export const CHAT_PAD_MAX = 360;
// 下限 12：拖到头正文会**紧贴窗口边缘**，看着像没排过版。
// ⚠️ 主进程 main/providers.js 存盘时也夹同一个下限；它在主进程里，import 不到这里，
//    那份数值得**手动对齐**（两边都夹一次是故意的：手改 config.json 能绕过保存那条路）。
export const CHAT_PAD_MIN = 12;
// 读不到主题色时给色盘一个兜底值（正常情况走 currentAccentHex()）
const BOLD_COLOR_FALLBACK = '#409eff';

/**
 * 当前主题配色的实际色值（给色盘当初始值）。
 *
 * 「加粗」默认是跟随主题配色的（见 style.css 的 `--chat-bold-color` 回落到 `--accent`）——
 * 所以没自己设过颜色时，色盘该显示的是**这一套配色现在的主色**，
 * 而不是写死一个蓝（那样和任何一套配色都对不上，看着像已设过一个奇怪的颜色）。
 * 换主题 / 换明暗后这个值会变，调用方负责重刷（见 initAppearance 里的配色与明暗点击）。
 */
function currentAccentHex() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : BOLD_COLOR_FALLBACK;
  } catch (err) {
    return BOLD_COLOR_FALLBACK;
  }
}

/** 从设置里取可用的聊天背景：只认 data:image/ 和内置图，避免把任意字符串拼进 CSS url() */
function chatBackgroundValue(settings) {
  const s = settings || {};
  const stored = typeof s.chatBackground === 'string' ? s.chatBackground.trim() : '';
  if (stored.startsWith('data:image/')) return stored;
  return s.chatBuiltinBackground !== false ? 'assets/tavern-forest.jpg' : '';
}

/** 把当前设置里的外观写到 CSS 变量上（值空就删掉变量，退回样式表里的默认） */
export function applyChatAppearance() {
  const s = state.settings || {};
  const root = document.documentElement;

  const size = Number(s.chatFontSize);
  const px = Number.isFinite(size) && size >= CHAT_FONT_MIN && size <= CHAT_FONT_MAX ? size : CHAT_FONT_DEFAULT;
  root.style.setProperty('--chat-font-size', `${px}px`);

  // 界面字号 / 字体：这两样是**整个界面**的，和上面那些只管聊天区的分开走。
  // 值不认识就回落默认 —— 手改过 config.json 也拉得回来（主进程那边还会再洗一遍）。
  root.style.setProperty('--ui-size', String(UI_SCALES[s.uiSize] || UI_SCALES[UI_SCALE_DEFAULT]));
  root.style.setProperty('--font-ui', UI_FONTS[s.uiFont] || UI_FONTS[UI_FONT_DEFAULT]);

  if (s.chatBoldColor) root.style.setProperty('--chat-bold-color', s.chatBoldColor);
  else root.style.removeProperty('--chat-bold-color');

  // 对话宽度：左右各一个变量，样式表里分别落在 .messages 的左右 padding 上。
  // 写成同一个值就会「一调两边一起缩」—— 那正是用户不要的行为。
  // 夹取放在这里再做一遍（主进程已经夹过）：手改过的 config.json 可能绕过保存那条路。
  for (const [key, cssVar] of [['chatPadLeft', '--chat-pad-left'], ['chatPadRight', '--chat-pad-right']]) {
    const n = Number(s[key]);
    const v = Number.isFinite(n)
      ? Math.min(CHAT_PAD_MAX, Math.max(CHAT_PAD_MIN, Math.round(n)))
      : CHAT_PAD_DEFAULT;
    root.style.setProperty(cssVar, `${v}px`);
  }

  // dataURL 里不会出现引号，包一层更保险
  const background = chatBackgroundValue(s);
  if (background) root.style.setProperty('--chat-bg-image', `url("${background}")`);
  else root.style.removeProperty('--chat-bg-image');
  root.dataset.chatSkin = background ? 'image' : 'plain';
}

/** 滑块的「已选比例」是 CSS 渐变画的，所以值一变就得把 --range-fill 同步过去 */
export function syncRangeFill(input) {
  if (!input) return;

  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value);
  const pct = max > min && Number.isFinite(value)
    ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
    : 0;
  input.style.setProperty('--range-fill', `${pct}%`);
}

/**
 * 外观那一组控件的当前值（从内存里的设置读，不读 DOM）。
 *
 * ⚠️ 这一块在设置页里：「什么时候回填」不由这里决定 —— views/settings.js 在进设置页 /
 * 切到「外观」那一组时会调它（见 initSettings 里那两处调用）。
 */
export function renderAppearanceForm() {
  const s = state.settings || {};

  const size = Number(s.chatFontSize);
  const px = Number.isFinite(size) && size >= CHAT_FONT_MIN && size <= CHAT_FONT_MAX ? Math.round(size) : CHAT_FONT_DEFAULT;
  el.appearanceFontSize.value = String(px);
  el.appearanceFontSizeValue.textContent = `${px}px`;
  syncRangeFill(el.appearanceFontSize);

  // ⚠️ 对话宽度由 views/chatPad.js 管（顶栏弹层 + 两侧抓手）；
  //    「外观」只管长什么样，宽度管的是版面。
  // 界面字号（三档单选）+ 字体（下拉）
  const uiSize = UI_SCALES[s.uiSize] ? s.uiSize : UI_SCALE_DEFAULT;
  if (el.appearanceUiScale) {
    for (const btn of el.appearanceUiScale.querySelectorAll('[data-uiscale]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.uiscale === uiSize));
    }
  }
  if (el.appearanceFont) el.appearanceFont.value = UI_FONTS[s.uiFont] ? s.uiFont : UI_FONT_DEFAULT;

  el.appearanceBoldColorText.value = s.chatBoldColor || '';
  el.appearanceBoldColor.value = s.chatBoldColor || currentAccentHex();

  const bg = chatBackgroundValue(s);
  el.appearanceBgPreview.innerHTML = '';
  if (bg) {
    const img = document.createElement('img');
    img.src = bg;
    img.alt = '';
    el.appearanceBgPreview.appendChild(img);
  }
  el.appearanceBgPreview.classList.toggle('hidden', !bg);
  el.btnClearBg.disabled = !bg;
}

/** 改一项外观：立刻生效 + 落盘 */
export async function persistAppearance(patch) {
  state.settings = { ...(state.settings || {}), ...patch };
  applyChatAppearance();
  renderAppearanceForm();

  try {
    // 主进程会把不合法/超限的值洗掉，所以用它的返回值覆盖本地
    state.settings = await api.saveSettings(patch);
  } catch (err) {
    console.error('保存外观设置失败', err);
    showToast('外观没能保存到磁盘', 'error');
    return;
  }
  applyChatAppearance();
  renderAppearanceForm();
}

/**
 * 背景图先压到最长边 1920 再存。
 * 头像那套是「居中裁成正方形」，背景不能裁 —— 裁了就变形，所以只等比缩。
 */
function shrinkBackground(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      try {
        const max = 1920;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        // 背景图不需要透明，webp 有透明通道也不亏；压到 0.82 体积和观感比较平衡
        const out = canvas.toDataURL('image/webp', 0.82);
        resolve(out.startsWith('data:image/') ? out : dataUrl);
      } catch (err) {
        resolve(dataUrl);
      }
    };

    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function pickChatBackground() {
  let result;
  try {
    result = await api.pickImage();
  } catch (err) {
    showToast((err && err.message) || '选择图片失败', 'error');
    return;
  }

  if (!result || result.canceled) return;
  if (!result.dataUrl) {
    showToast(result.error || '这张图片用不了', 'error');
    return;
  }

  showToast('正在压缩背景图…');
  const shrunk = await shrinkBackground(result.dataUrl);
  await persistAppearance({ chatBackground: shrunk });
  showToast('背景图已换上', 'ok');
}

/**
 * 文本框里可能是 #abc / #aabbcc / #aabbccdd，也可能带不带 #。
 * 认不出来就返回 null（调用方提示一下，不要静默丢掉）。
 */
function normalizeHexColor(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  if (!t.startsWith('#')) t = `#${t}`;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t) ? t.toLowerCase() : null;
}

/** 绑定外观那一组的所有控件（配色 / 明暗 / 字号 / 加粗色 / 背景图） */
export function initAppearance() {
  // 这一组**改完立即生效 + 落盘**，所以没有「保存」按钮
  // （页头那颗「保存」管的是上面几组配置，不碰这里）。

  // 主题配色 / 明暗：整块界面的东西，放在这一组的上面。
  // 用事件委托而不是逐个绑 —— 以后加配色不用回来补绑定。
  // 选中态由 ui/theme.js 统一刷。
  if (el.appearanceAccents) {
    el.appearanceAccents.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-accent]');
      if (!btn) return;
      setAccent(btn.dataset.accent);
      // 换配色后色盘要跟着走 —— 没自定义过加粗色时它显示的就是主题色
      renderAppearanceForm();
    });
  }
  if (el.appearanceModes) {
    el.appearanceModes.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-mode]');
      if (!btn) return;
      setTheme(btn.dataset.mode);
      // 明暗也一样：暗色下的主色是另一组值
      renderAppearanceForm();
    });
  }

  // 界面字号：三档单选，点一下 = 落盘 + 立刻生效（改的是 --ui-size 一个变量）
  if (el.appearanceUiScale) {
    el.appearanceUiScale.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-uiscale]');
      if (!btn) return;
      persistAppearance({ uiSize: btn.dataset.uiscale });
    });
  }
  // 字体：原生 <select>，change 就落盘（没有拖动过程，不用像滑块那样分 input/change）
  if (el.appearanceFont) {
    el.appearanceFont.addEventListener('change', () => {
      persistAppearance({ uiFont: el.appearanceFont.value });
    });
  }

  // 字号：拖动时实时预览，松手才落盘 —— 不然拖一次要写几十遍配置文件
  el.appearanceFontSize.addEventListener('input', () => {
    const px = Number(el.appearanceFontSize.value);
    el.appearanceFontSizeValue.textContent = `${px}px`;
    syncRangeFill(el.appearanceFontSize);
    state.settings = { ...(state.settings || {}), chatFontSize: px };
    applyChatAppearance();
  });
  el.appearanceFontSize.addEventListener('change', () => {
    persistAppearance({ chatFontSize: Number(el.appearanceFontSize.value) });
  });

  // ⚠️ 对话宽度那两根滑块在 views/chatPad.js（顶栏弹层 + 消息区两侧可拖的线），
  //    不在外观这一组。
  // 加粗颜色：和字号一个道理 —— 色盘拖动时 input 每帧都触发，
  // 只预览不落盘（不然拖一次色盘要写几十次配置文件），松手（change）才落盘。
  // 手填的等回车/失焦再认
  el.appearanceBoldColor.addEventListener('input', () => {
    const hex = el.appearanceBoldColor.value;
    state.settings = { ...(state.settings || {}), chatBoldColor: hex };
    el.appearanceBoldColorText.value = hex;
    applyChatAppearance();
  });
  el.appearanceBoldColor.addEventListener('change', () => {
    persistAppearance({ chatBoldColor: el.appearanceBoldColor.value });
  });
  el.appearanceBoldColorText.addEventListener('change', () => {
    const hex = normalizeHexColor(el.appearanceBoldColorText.value);
    if (hex === null) {
      showToast('颜色要写成 #rgb 或 #rrggbb，比如 #e06c75', 'error');
      renderAppearanceForm();
      return;
    }
    persistAppearance({ chatBoldColor: hex });
  });
  el.btnBoldColorReset.addEventListener('click', () => persistAppearance({ chatBoldColor: '' }));

  el.btnPickBg.addEventListener('click', pickChatBackground);
  el.btnClearBg.addEventListener('click', () => persistAppearance({ chatBackground: '', chatBuiltinBackground: false }));
  document.getElementById('btn-default-bg')?.addEventListener('click', () => persistAppearance({ chatBackground: '', chatBuiltinBackground: true }));
}
