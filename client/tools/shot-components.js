'use strict';

// tools/shot-components.js —— 加载组件盘 renderer/preview/components.html，白天 / 夜间各出一张到 tools/shots/
//   跑法：npm run shot:components [-- --mode=dark | --show]
// ⚠️ 必须用 electron 跑：纯 node 下 require('electron') 给的是可执行文件路径，不是 API

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

/** ⚠️ capturePage() 只拍可见视口，而窗口内容区高度被屏幕锁死 —— 装不下就按页面高度算一档 zoom（0.6 下限），
 *  缩完还装不下当场警告；漏拍在看图上极难发现。CDP 的 captureBeyondViewport 在这个隐藏窗口上会挂住 */
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
    // 窗口高度受屏幕限制时，captureChecked 会当场警告「底下多少 px 没进图」
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

  // 出图不对劲时一眼能看出是「窗口没给够」还是「页面太高」
  const [cw, ch] = win.getContentSize();
  console.log(`  窗口内容区: ${cw}x${ch}`);

  await fitToView(win);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const mode of MODES) {
    await win.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', ${JSON.stringify(mode)}); true`
    );
    await sleep(250);
    // 出图最容易骗人的地方：图好看但其实组件没升级（那就是一堆无样式的未知元素）
    const probe = await win.webContents.executeJavaScript(`(() => {
      const up = (tag) => {
        const ctor = customElements.get(tag);
        return ctor ? ctor.name : '(没注册)';
      };
      const primary = document.querySelector('m-button[variant="primary"] .mi-btn__control');
      const input = document.querySelector('m-input .mi-input__control');
      const select = document.querySelector('m-select .mi-select__control');
      // 拿一颗老式 .btn-primary 当对照：长得不一样说明是选择器接错了，不是「主题有问题」
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
