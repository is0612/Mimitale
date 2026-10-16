// 逐屏出图 + 自检：A 稿「长卷」/ B 稿「工坊」各截几张。
// 用客户端已装的 Electron 跑：
//   env -u ELECTRON_RUN_AS_NODE client/node_modules/electron/dist/electron.exe --no-sandbox design/editor-v2/capture.cjs
// 可选过滤：--only=a  只出 A 稿；--only=b  只出 B 稿

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(require('node:os').tmpdir(), 'mimitale-editor-v2'));

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

const SHOTS = [
  // ---------- A 稿「长卷」----------
  ['a-01-document',      1440, 900, 'dark',  '#a/desc'],   // 真窗口就是 1440×900
  ['a-02-other-parts',   1440, 900, 'dark',  '#a/attrs'],
  ['a-03-light',         1440, 900, 'light', '#a/desc'],
  ['a-04-tall',          1440, 960, 'dark',  '#a/desc'],
  ['a-05-laptop',        1180, 820, 'dark',  '#a/desc'],
  ['a-06-mobile',        390, 844, 'dark',   '#a/desc'],
  // ---------- B 稿「工坊」----------
  ['b-01-workbench',     1440, 900, 'dark',  '#b/writing/desc'],
  ['b-02-attributes',    1440, 900, 'dark',  '#b/attributes'],
  ['b-03-light',         1440, 900, 'light', '#b/writing/desc'],
  ['b-04-laptop',        1280, 820, 'dark',  '#b/writing/desc'],
  ['b-05-mobile',        390, 844, 'dark',   '#b/writing/desc']
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  const errors = [];
  win.webContents.on('console-message', (_event, details) => {
    if (details?.level === 'error') errors.push(details.message);
  });

  await win.loadFile(path.join(__dirname, 'index.html'));

  const report = [];
  for (const [name, width, height, theme, hash] of SHOTS) {
    if (only && !name.startsWith(only)) continue;
    win.setContentSize(width, height);
    await win.webContents.executeJavaScript(`window.__mock.theme(${JSON.stringify(theme)}); location.hash = ${JSON.stringify(hash)}; new Promise(r => setTimeout(r, 200));`);
    await win.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(i => i.decode().catch(() => null)))');

    const check = await win.webContents.executeJavaScript(`({
      size: innerWidth + 'x' + innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      railOverflow: (() => {
        const rail = document.querySelector('.view.active .rail');
        return !!rail && rail.scrollHeight > rail.clientHeight + 1;
      })(),
      mirrorOverflow: (() => {
        const mirror = document.querySelector('.view.active .mirror');
        if (!mirror || !mirror.offsetParent) return false;
        return mirror.scrollWidth > mirror.clientWidth + 1;
      })(),
      images: Array.from(document.images).filter(i => !(i.complete && i.naturalWidth > 0)).map(i => i.getAttribute('src')),
      scrollTop: (() => {
        const sc = document.querySelector('.view.active .doc, .view.active .work');
        return sc ? sc.scrollTop : -1;
      })(),
      visiblePanels: Array.from(document.querySelectorAll('.view.active [role=tabpanel], .view.active .sheet, .view.active .band'))
        .filter(n => n.offsetParent !== null).map(n => n.id || n.className.split(' ')[0]),
      offscreen: (() => {
        const inScroller = (n) => {
          for (let p = n.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
          }
          return false;
        };
        return Array.from(document.querySelectorAll('.view.active button, .view.active input, .view.active textarea'))
          .filter(n => n.getClientRects().length)
          .filter(n => { const r = n.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; })
          .filter(n => !inScroller(n))
          .map(n => n.className || n.tagName);
      })()
    })`);

    const problems = [];
    if (check.overflowX) problems.push('横向溢出');
    if (check.railOverflow) problems.push('左栏出现栏内滚动');
    if (check.mirrorOverflow) problems.push('右栏出现横向滚动');
    if (check.images.length) problems.push('图片未加载: ' + check.images.join(', '));
    if (check.offscreen.length) problems.push('控件出界: ' + check.offscreen.join(', '));
    if (!check.visiblePanels.length) problems.push('没有任何可见内容');

    fs.writeFileSync(path.join(__dirname, name + '.png'), (await win.webContents.capturePage()).toPNG());
    report.push({ name, ...check, problems });
    console.log([problems.length ? 'FAIL' : ' ok ', name, check.size, '滚动 ' + check.scrollTop, check.visiblePanels.length + ' 块可见', problems.join(' | ')].join('  '));
  }

  console.log('\n截图 ' + report.filter((r) => !r.problems.length).length + '/' + report.length + ' 通过；控制台报错 ' + errors.length + ' 条');
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  if (report.some((r) => r.problems.length) || errors.length) app.exit(1);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
