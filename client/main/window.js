'use strict';

// 主窗口 + 开发模式热重载。跑 `npm run dev` 时开 DevTools，并按「让改动生效要多大代价」分两档监听。
// ⚠️ 界面层用 reloadIgnoringCache() 而不是 reload()（file:// 下普通 reload 偶尔仍吃旧代码）；主进程改动只能整进程重启，且用 quit() 不用 exit() —— exit() 跳过 before-quit，桌宠落盘和单实例清理都挂在上面。

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { DEFAULT_SETTINGS, loadSettings, ACCENTS } = require('./providers.js');

let mainWindow = null;

// 窗口底色跟着主题 + 配色走，启动时就不会先闪一下别的颜色。
// ⚠️ 值必须和 style.css 里各配色的 --bg 一致（夜间是 `[data-theme='dark']` 段里的 --bg）；
//    加新配色时这里同步补，否则 `WINDOW_BG[accent]` 是 undefined。
// ⚠️ dark 曾经写成 #101113，而 style.css 是 #171a18 —— 差这一档就是「启动先黑一下再变亮」。
//    这条约束现在由 tools/test-theme-tokens.js 直接从两个文件里读值比对，别再靠肉眼。
const WINDOW_BG = {
  amber: { light: '#f4f5f7', dark: '#171a18' }
};

// ⚠️ 窗口尺寸只有这一处定义：useContentSize 下这几个数就是画布尺寸，和设计稿 frame 一一对应。
//    冒烟测试的截图窗口也从这里读，别再另写一份，否则「设计稿 / 真机 / 出图」会各用各的。
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

// ⚠️ 根目录用「非递归监听 + 文件名过滤」而不是 fs.watch 盯单文件：编辑器保存是「写临时文件再改名」，
//    盯单文件的 watcher 会跟丢目标。preload.js 刷新即生效，preload-pet.js 跟着整进程重启。
const ROOT_RELOAD_FILES = new Set(['preload.js']);
const ROOT_RELAUNCH_FILES = new Set(['main.js', 'preload-pet.js']);

function watchRendererForDev() {
  if (!DEV_MODE || devWatchers.length) return;

  const rootDir = path.join(__dirname, '..');

  addDevWatcher(path.join(rootDir, 'renderer'), { recursive: true }, () => scheduleDevReload('renderer/'));

  addDevWatcher(path.join(rootDir, 'main'), { recursive: true }, () => scheduleDevRelaunch('main/'));

  // ⚠️ 根目录非递归（data/ 里的读写打不进来），但仍按白名单过滤：assets/、node_modules/ 等会被频繁碰。
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
  // 已经有一个活窗口就别再建第二个：只会多出一个渲染进程和一套 preload 特权接口。
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  let theme = DEFAULT_SETTINGS.theme;
  let accent = DEFAULT_SETTINGS.accent;
  try {
    const saved = loadSettings();
    theme = saved.theme === 'dark' ? 'dark' : 'light';
    // ⚠️ 兜底配色要和 providers.js / preload.js / ui/theme.js 三处一致，别在这儿写死配色名。
    accent = ACCENTS.includes(saved.accent) ? saved.accent : ACCENTS[0];
  } catch (err) {
    // 读不到设置就用默认主题，不影响启动
  }

  mainWindow = new BrowserWindow({
    ...WINDOW_SIZE,
    useContentSize: true,
    backgroundColor: (WINDOW_BG[accent] || WINDOW_BG[ACCENTS[0]])[theme],
    title: '如我所书',
    // 图标真源是 图片/logo.jpg；这里用的是 client/assets/icon.ico（16~256 七档），由脚本一次性生成。
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
        // 渲染层无构建、无 Node，读不到 package.json —— 版本号只能启动时从主进程递进去。
        `--mimitale-version=${app.getVersion()}`
      ]
    }
  });

  if (DEV_MODE) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    watchRendererForDev();
  }

  // Electron 默认只绑了 Ctrl+Shift+I 和 Ctrl+R；F12 / F5 在 Electron 里没反应，这里补上。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // 长按会自动连发，刷一次就够了
    if (input.isAutoRepeat) return;

    if (input.key === 'F12') {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
      return;
    }

    // ⚠️ 用 reloadIgnoringCache 而不是 reload：file:// 下脚本/样式被 Chromium 缓存，普通 reload 偶尔吃旧代码。
    const isReload =
      input.key === 'F5' ||
      (input.control && !input.shift && !input.alt && (input.key === 'r' || input.key === 'R'));

    if (isReload) {
      event.preventDefault();
      mainWindow.webContents.reloadIgnoringCache();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  /** ⚠️ 窗口只准停在本地界面这一个文档：preload 每个文档都注入，且 window.mimitale 暴露了 API Key 明文，
   *  拖 .html 或链接进来就会导航过去，外来页面于是拿到同一套特权接口。
   *  只允许同文档锚点跳转；按路径比，不拼 URL 字符串 —— file URL 里中文 / 空格会被百分号编码。 */
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
