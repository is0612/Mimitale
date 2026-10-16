'use strict';

// ============================================================================
//  tools/shot-components.js —— 给组件库出图（组件盘那一页）
//
//  跑法： npm run shot:components                   白天 + 夜间各出一张
//        npm run shot:components -- --mode=dark     只出夜间
//        npm run shot:components -- --show          把窗口显示出来（自己点着看）
//
//  ⚠️ 必须用 electron 跑（`node tools/shot-components.js` 会报
//     `Cannot read properties of undefined (reading 'disableHardwareAcceleration')`
//     —— 纯 node 下 require('electron') 给的是可执行文件路径，不是 API）。
//
//  它干什么：开一个（默认不显示的）窗口，加载 **renderer/preview/components.html**
//  ——那是组件盘，不属于应用界面。然后分别切白天/夜间各出一张图到 tools/shots/。
//
//  为什么要单独一个脚本：应用那边的出图（smoke-test.js 的 --shot=）只加载
//  index.html，而组件盘是独立页面。两边都不改对方的加载逻辑。
// ============================================================================

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// 只做截图，用不到 GPU（避开「GPU 进程崩溃把主进程带走」那类环境噪声）
app.disableHardwareAcceleration();

const APP_DIR = path.join(__dirname, '..');
const PAGE = path.join(APP_DIR, 'renderer', 'preview', 'components.html');
const OUT_DIR = path.join(__dirname, 'shots');

const modeArg = (process.argv.find((a) => a.startsWith('--mode=')) || '').split('=')[1];
const MODES = modeArg ? [modeArg] : ['light', 'dark'];
const SHOW = process.argv.includes('--show');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 整页截图（不只是可见视口）。
 *
 * ⚠️ 别用 `win.webContents.capturePage()`：它只拍**可见视口**，而窗口高度受屏幕
 * 物理高度限制 —— 组件盘 1749px 高，窗口要到 1860px 才装得下，在这台机器上会被
 * 系统压到 ~975px，于是底下「下拉框 / 事件与值」两格**整块拍不到**，而且看图时
 * 很容易以为"组件就这么多"。
 * 走 CDP 的 `Page.captureScreenshot` + `captureBeyondViewport` 才拿得到整页。
 */
async function wholePagePng(win) {
  const metrics = await win.webContents.executeJavaScript(`(() => {
    const doc = document.documentElement;
    return {
      width: Math.ceil(Math.max(doc.scrollWidth, document.body.scrollWidth)),
      height: Math.ceil(Math.max(doc.scrollHeight, document.body.scrollHeight))
    };
  })()`);

  try {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: metrics.width, height: metrics.height, scale: 1 }
    });
    return { buffer: Buffer.from(shot.data, 'base64'), size: metrics, via: 'cdp' };
  } catch (err) {
    console.warn('  CDP 整页截图失败，退回只拍可见视口：', err.message);
    return { buffer: (await win.webContents.capturePage()).toPNG(), size: metrics, via: 'viewport' };
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    // 高度按屏幕能给多少算（见下面 wholePagePng 的注释：整页靠 CDP 拍，不靠窗口高）
    height: 1000,
    show: SHOW,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.webContents.on('console-message', (...args) => {
    const level = typeof args[1] === 'number' ? args[1] : args[0] && args[0].level;
    const message = typeof args[2] === 'string' ? args[2] : args[0] && args[0].message;
    console.log(`[console:${level}] ${message}`);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[fail-load]', code, desc, url));

  await win.loadFile(PAGE);
  await sleep(400); // 等组件升级 + 首帧排版稳定

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const mode of MODES) {
    await win.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', ${JSON.stringify(mode)}); true`
    );
    await sleep(250);
    // 顺手报一下"组件到底升级了没有、样式有没有生效"——出图最容易骗人的地方就是
    // 图好看但其实组件没升级（那样看到的是一堆无样式的未知元素）
    const probe = await win.webContents.executeJavaScript(`(() => {
      const up = (tag) => {
        const ctor = customElements.get(tag);
        return ctor ? ctor.name : '(没注册)';
      };
      const btn = document.querySelector('m-button .mi-btn__control');
      const input = document.querySelector('m-input .mi-input__control');
      const select = document.querySelector('m-select .mi-select__control');
      return {
        主题: document.documentElement.getAttribute('data-theme'),
        注册: [up('m-button'), up('m-input'), up('m-textarea'), up('m-select')].join(' / '),
        按钮底色: btn ? getComputedStyle(btn).backgroundColor : '(没有里层按钮)',
        输入框边框: input ? getComputedStyle(input).borderTopWidth + ' ' + getComputedStyle(input).borderTopColor : '(没有里层 input)',
        下拉宽度: select ? Math.round(select.getBoundingClientRect().width) + 'px' : '(没有里层 select)',
        页面高: document.body.scrollHeight + 'px'
      };
    })()`);
    console.log(`  ${mode}: ${JSON.stringify(probe, null, 0)}`);

    const file = path.join(OUT_DIR, `components-${mode}.png`);
    const shot = await wholePagePng(win);
    fs.writeFileSync(file, shot.buffer);
    console.log(`  截图: tools/shots/components-${mode}.png（${shot.size.width}x${shot.size.height}，${shot.via}）`);
  }

  app.quit();
});
