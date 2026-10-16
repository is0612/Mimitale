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
 * 拍一张，并**核对有没有拍漏**。
 *
 * `capturePage()` 只拍**可见视口**，而窗口内容区的高度被屏幕物理高度锁死
 * （这台机器上不管申请多高都是 1544x975）。组件盘比它高就会整块漏拍底下几格，
 * 而"漏拍"在看图上极难发现 —— 这次就踩了：页面 1214px，底下「事件与值」整格没了。
 *
 * 所以两条一起用：
 *   · 先按页面高度**算一档 zoom** 把整页缩进可见区（0.6 是下限，再小就没法看了）
 *   · 缩完还装不下就**当场警告**，别让图默默缺一块
 * （试过 CDP 的 Page.captureScreenshot + captureBeyondViewport 拍整页，在这个
 *   隐藏窗口上会直接挂住，不划算。）
 */
const MIN_ZOOM = 0.6;

async function pageMetrics(win) {
  return win.webContents.executeJavaScript(`(() => {
    const doc = document.documentElement;
    return {
      pageHeight: Math.ceil(Math.max(doc.scrollHeight, document.body.scrollHeight)),
      pageWidth: Math.ceil(Math.max(doc.scrollWidth, document.body.scrollWidth)),
      viewHeight: window.innerHeight,
      viewWidth: window.innerWidth
    };
  })()`);
}

async function fitToView(win) {
  win.webContents.setZoomFactor(1);
  const before = await pageMetrics(win);
  if (before.pageHeight <= before.viewHeight) return before;

  const zoom = Math.max(MIN_ZOOM, Math.floor((before.viewHeight / before.pageHeight) * 100) / 100);
  win.webContents.setZoomFactor(zoom);
  console.log(`  页面 ${before.pageHeight}px 高于可见区 ${before.viewHeight}px，缩到 zoom=${zoom} 出图`);
  await sleep(250);
  return pageMetrics(win);
}

async function captureChecked(win) {
  const metrics = await pageMetrics(win);
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  if (metrics.pageHeight > metrics.viewHeight + 2) {
    console.warn(
      `  ⚠ 缩到下限还有 ${metrics.pageHeight - metrics.viewHeight}px 没进图（页面 ${metrics.pageHeight}px / ` +
        `可见 ${metrics.viewHeight}px，CSS px 口径）—— 把组件盘压短一点，或者把窗口调宽让卡片更矮。`
    );
  }
  return { image, metrics, size };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // 宽一点、高一点：组件盘是四栏布局。窗口高度受屏幕限制时下面的 captureChecked
    // 会当场警告「底下多少 px 没进图」，别让图默默缺一块。
    width: 1560,
    height: 1320,
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

  // 窗口到底给了多大内容区：屏幕会限制窗口高度，而 capturePage 只拍可见视口 ——
  // 先把它打出来，出图不对劲时一眼能看出是"窗口没给够"还是"页面太高"。
  const [cw, ch] = win.getContentSize();
  console.log(`  窗口内容区: ${cw}x${ch}`);

  // 屏幕会把窗口内容区压到一屏高，而组件盘比一屏高 —— 先算一档 zoom 把整页装进去
  await fitToView(win);

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
      const primary = document.querySelector('m-button[variant="primary"] .mi-btn__control');
      const input = document.querySelector('m-input .mi-input__control');
      const select = document.querySelector('m-select .mi-select__control');
      // 拿一颗老式 .btn-primary 当对照：组件和它必须**长得一模一样**
      //（皮肤是共用的一份声明；不一样就说明我的选择器接错了，而不是"主题有问题"）
      const legacy = document.createElement('button');
      legacy.className = 'btn btn-primary';
      document.body.appendChild(legacy);
      const cs = (node) => {
        if (!node) return '(没有)';
        const s = getComputedStyle(node);
        return s.color + ' / ' + s.backgroundColor;
      };
      const pairs = {
        '组件 primary（字/底）': cs(primary),
        '老 .btn-primary（字/底）': cs(legacy)
      };
      legacy.remove();
      return {
        主题: document.documentElement.getAttribute('data-theme'),
        注册: [up('m-button'), up('m-input'), up('m-textarea'), up('m-select')].join(' / '),
        对照: pairs,
        输入框边框: input ? getComputedStyle(input).borderTopWidth + ' ' + getComputedStyle(input).borderTopColor : '(没有里层 input)',
        下拉宽度: select ? Math.round(select.getBoundingClientRect().width) + 'px' : '(没有里层 select)',
        页面高: document.body.scrollHeight + 'px',
        各卡片高: [...document.querySelectorAll('.pv-card')]
          .map((c) => {
            const t = c.querySelector('.pv-card-title');
            return (t ? t.textContent.split(' ')[0] : '?') + '=' + Math.round(c.getBoundingClientRect().height);
          })
          .join(' ')
      };
    })()`);
    console.log(`  ${mode}: ${JSON.stringify(probe, null, 0)}`);

    const file = path.join(OUT_DIR, `components-${mode}.png`);
    const shot = await captureChecked(win);
    fs.writeFileSync(file, shot.image.toPNG());
    console.log(`  截图: tools/shots/components-${mode}.png（${shot.size.width}x${shot.size.height}）`);
  }

  app.quit();
});
