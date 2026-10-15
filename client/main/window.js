'use strict';

// ============================================================================
//  main/window.js —— 主窗口 + 开发模式热重载
//
//  跑 `npm run dev` 时会自动打开 DevTools，并按「让改动生效要多大代价」分两档监听：
//
//    · 界面层（renderer/** 和根目录的 preload.js）
//        保存即刷新窗口。这些文件每次 reload 都会重新加载 / 重新注入，本来就不用重启。
//        用 reloadIgnoringCache() 而不是 reload()：file:// 下的脚本/样式会被 Chromium
//        记住，普通 reload() 偶尔仍吃旧代码 —— 「改了怎么没生效」多半是这么来的。
//
//    · 主进程（main.js、main/**、preload-pet.js）
//        整进程重启（app.relaunch + app.quit()）。主进程代码只在启动时读一次，
//        Electron 也没有「只重启主进程」这回事，只能重开一个进程。
//        ⚠️ 用 quit() 不用 exit()：exit() 跳过 before-quit，而桌宠位置落盘和单实例
//           标记清理都挂在 before-quit 上（见 main.js）。
//
//  改动有没有被接住，看终端里的 [dev] 行。
// ============================================================================

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { DEFAULT_SETTINGS, loadSettings, ACCENTS } = require('./providers.js');

let mainWindow = null;

// 窗口底色跟着主题 + 配色方案走，启动时就不会先闪一下别的颜色。
// 这两个值必须和 style.css 里 --bg 保持一致（改配色时两边一起改）——
// 之前是 #1a1d23，但 style.css 的夜间 --bg 是 #17161b，启动会闪一下，这里对齐掉。
// ⚠️ 2026-10-12：夜间 --bg 从紫调 #17161b 换成了**中性灰 #101113**，
//    三套配色的 dark 值跟着一起改 —— 不改就等于每次启动先闪一下旧紫底。
//    同一天加了第 4 套配色 amber（默认），这里必须一起补，否则
//    `WINDOW_BG['amber']` 是 undefined，会兜回 pink 的粉色底。
const WINDOW_BG = {
  amber: { light: '#f4f5f7', dark: '#101113' }
};

// 窗口尺寸 —— **只有这一处定义**。
//
// 用 useContentSize，所以这几个数就是「画布」的尺寸，和设计稿的 frame 一一对应。
// 冒烟测试的截图窗口也从这里读（tools/smoke-test.js）——
// 那边原来自己写死 1180×800，改完窗口之后就一直照着旧尺寸出图，
// 结果「设计稿 1440、真机截图 1164」两张图对不上，白白照着挤压的顶栏调了半天。
const WINDOW_SIZE = {
  width: 1440,
  height: 900,
  minWidth: 1040,
  minHeight: 680
};

const DEV_MODE =
  process.argv.includes('--dev') || process.env.MIMITALE_OPEN_DEVTOOLS === '1';

// 编辑器保存一次往往触发好几个事件（写临时文件 → rename），稍微微防抖一下。
const DEV_DEBOUNCE_MS = 150;

let devWatchers = [];
let devReloadTimer = null;
let devRelaunchTimer = null;
let devRelaunching = false;

function addDevWatcher(target, options, onChange) {
  try {
    const watcher = fs.watch(target, options, (eventType, filename) => onChange(filename || ''));
    // watcher 自己也可能是错误来源，不接住这个事件就是进程级未捕获异常
    watcher.on('error', (err) => console.warn('[dev] 监听中断:', target, '-', err.message));
    devWatchers.push(watcher);
  } catch (err) {
    console.warn('[dev] 监听不了', target, '- 自动刷新对它不生效:', err.message);
  }
}

/** 界面层改动：刷新窗口就够，不必重启 */
function scheduleDevReload(reason) {
  clearTimeout(devReloadTimer);
  devReloadTimer = setTimeout(() => {
    if (devRelaunching) return; // 整进程都要重启了，这次刷新没意义
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.log(`[dev] ${reason} 有改动，刷新窗口`);
    mainWindow.webContents.reloadIgnoringCache();
  }, DEV_DEBOUNCE_MS);
}

/** 主进程改动：没有别的办法，只能重开一个进程 */
function scheduleDevRelaunch(reason) {
  clearTimeout(devRelaunchTimer);
  devRelaunchTimer = setTimeout(() => {
    if (devRelaunching) return;
    devRelaunching = true; // 已经排上队了，后面的改动不用再排一次
    console.log(`[dev] ${reason} 有改动，重启应用`);
    // 显式把当前 argv 传下去，--dev 和 --no-sandbox 才不会丢
    app.relaunch({ args: process.argv.slice(1) });
    app.quit();
  }, DEV_DEBOUNCE_MS);
}

// 项目根下这几个文件的代价不一样：
//   preload.js      每次窗口 reload 都会重新注入 —— 刷新就生效
//   preload-pet.js  属于宠物窗口那一侧 —— 跟着整进程重启最省事
// 监听方式是「监听根目录 + 按文件名过滤」，不用 fs.watch 盯单个文件：
// 编辑器保存是「写临时文件再改名」，盯单文件的 watcher 会跟丢目标。
const ROOT_RELOAD_FILES = new Set(['preload.js']);
const ROOT_RELAUNCH_FILES = new Set(['main.js', 'preload-pet.js']);

function watchRendererForDev() {
  if (!DEV_MODE || devWatchers.length) return;

  const rootDir = path.join(__dirname, '..');

  // 界面层：整个 renderer/ 目录，递归
  addDevWatcher(path.join(rootDir, 'renderer'), { recursive: true }, () => scheduleDevReload('renderer/'));

  // 主进程：main/ 目录递归
  addDevWatcher(path.join(rootDir, 'main'), { recursive: true }, () => scheduleDevRelaunch('main/'));

  // 根目录：**非递归** —— 只报直接子项的变化，data/ 里的读写（会话、角色、宠物位置）
  // 打不进来。即便如此也还是按文件名白名单过滤一遍，因为根目录下还住着
  // assets/、node_modules/、generated-images/ 这些会被频繁碰的东西。
  addDevWatcher(rootDir, { recursive: false }, (filename) => {
    if (ROOT_RELOAD_FILES.has(filename)) return scheduleDevReload(filename);
    if (ROOT_RELAUNCH_FILES.has(filename)) return scheduleDevRelaunch(filename);
  });
}

function stopDevWatcher() {
  clearTimeout(devReloadTimer);
  clearTimeout(devRelaunchTimer);
  devReloadTimer = null;
  devRelaunchTimer = null;
  for (const watcher of devWatchers) {
    try {
      watcher.close();
    } catch (err) {
      // 关不掉无所谓 —— 能走到这儿一般就是进程要退了
    }
  }
  devWatchers = [];
}

function createWindow() {
  let theme = DEFAULT_SETTINGS.theme;
  let accent = DEFAULT_SETTINGS.accent;
  try {
    const saved = loadSettings();
    theme = saved.theme === 'dark' ? 'dark' : 'light';
    // 兜底要和 providers.js 的 normalizeSettings / preload.js / ui/theme.js 三处一致，
    // 别在这儿写死一个旧配色名（以前写的是 'pink'）。
    accent = ACCENTS.includes(saved.accent) ? saved.accent : ACCENTS[0];
  } catch (err) {
    // 读不到设置就用默认主题，不影响启动
  }

  mainWindow = new BrowserWindow({
    // 1440×900 的内容区：三栏（224 对话列表 / 对话 / 300 在场角色）在 1180 宽下太挤，
    // 对话区只剩六百多像素，中文字一行放不下十来个字。
    // 本机屏幕 1920×1080、工作区 1920×1040，边框再吃掉一点也放得下。
    ...WINDOW_SIZE,
    useContentSize: true,
    backgroundColor: (WINDOW_BG[accent] || WINDOW_BG[ACCENTS[0]])[theme],
    title: '如我所书',
    // 窗口 / 任务栏图标。图标真源在 图片/logo.jpg（1040×1040 深蓝底），
    // 这里用的是 client/assets/icon.ico（16~256 七档尺寸），由脚本一次性生成。
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 把主题提前告诉 preload，让它在首屏渲染前就打好标记
      additionalArguments: [
        `--mimitale-theme=${theme}`,
        `--mimitale-accent=${accent}`,
        // 版本号同路：侧栏品牌行要显示它，而渲染层是无构建、无 Node 的，
        // 读不到 package.json —— 只能在启动时从主进程递进去。
        `--mimitale-version=${app.getVersion()}`
      ]
    }
  });

  if (DEV_MODE) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    watchRendererForDev();
  }

  // F12 开/关 DevTools。
  // Electron 默认只绑了 Ctrl+Shift+I，从浏览器过来的人会习惯性按 F12，
  // 那一下在 Electron 里是没反应的，所以这里补上。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    if (input.key === 'F12') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  /**
   * 窗口只准停在本地界面这一个文档上。
   *
   * 为什么必须有这条：preload 是**每个文档**都会注入的，而它把 window.mimitale
   * 整个暴露出去（getSettings 会返回所有服务商的 API Key 明文）。没有这道守卫时，
   * 往窗口里拖一个 .html 或一个链接（聊天区、侧栏都行，不只是输入框）就会让窗口
   * **导航到那个文档**，外来页面于是拿到了同一套特权接口 —— 拖放等于把钥匙递出去。
   *
   * 允许的只有「同文档内的锚点跳转」（帮助页目录是 <a href="#xxx">）：
   * 那种情况 url 和应用自己的地址就只差一个 hash，不换文档，也就不会重新注入 preload。
   * 这里按「路径是不是那个 index.html」判断，不去拼 URL 字符串比 ——
   * index.html 的 file URL 里中文/空格会被百分号编码，字符串比较容易出假阴性。
   * 其余一律拦掉：拖进来的文件、外站链接、重定向。
   */
  const appIndexPath = path.join(__dirname, '..', 'renderer', 'index.html');

  const isOwnDocument = (url) => {
    try {
      const target = new URL(String(url || ''));
      if (target.protocol !== 'file:') return false;
      const decoded = decodeURIComponent(target.pathname).replace(/^\//, '');
      return path.resolve(decoded) === path.resolve(appIndexPath);
    } catch (err) {
      return false;
    }
  };

  const blockForeignNavigation = (event, url) => {
    if (isOwnDocument(url)) return;
    event.preventDefault();
    console.warn('[window] 拦下了一次窗口导航（只允许本地界面）:', url);
  };

  mainWindow.webContents.on('will-navigate', blockForeignNavigation);
  mainWindow.webContents.on('will-redirect', blockForeignNavigation);

  // 外部链接用系统浏览器打开，不在应用内跳转
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopDevWatcher();
  });
}

function getMainWindow() {
  return mainWindow;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

module.exports = {
  createWindow,
  getMainWindow,
  sendToRenderer,
  // 冒烟测试的截图窗口读它，保证「设计稿 / 真机 / 出图」三边尺寸一致
  WINDOW_SIZE
};
