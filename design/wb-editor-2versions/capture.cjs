// 逐屏出图 + 自检：A 稿「条目工作台」/ B 稿「书籍工作台」各截几张。
// 用客户端已装的 Electron 跑：
//   env -u ELECTRON_RUN_AS_NODE client/node_modules/electron/dist/electron.exe \
//     --no-sandbox design/wb-editor-2versions/capture.cjs
// 可选过滤：--only=a 只出 A 稿；--only=b 只出 B 稿

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(require('node:os').tmpdir(), 'mimitale-wb-editor-v2'));

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';

// 真窗口就是 1440×900。窄屏取 1180（这台机常见的小窗），高屏 1440×1024。
const SHOTS = [
  // ---------- A 稿「条目工作台」----------
  ['a-01-entries',       1440, 900,  'dark',  '#a/entries'],
  ['a-02-book',          1440, 900,  'dark',  '#a/book'],
  ['a-03-characters',    1440, 900,  'dark',  '#a/chars'],
  ['a-04-entries-light', 1440, 900,  'light', '#a/entries'],
  ['a-05-narrow',        1180, 820,  'dark',  '#a/entries'],
  ['a-06-tall',          1440, 1024, 'dark',  '#a/entries'],
  // ---------- B 稿「书籍工作台」----------
  ['b-01-entries',       1440, 900,  'dark',  '#b/entries'],
  ['b-02-book',          1440, 900,  'dark',  '#b/book'],
  ['b-03-characters',    1440, 900,  'dark',  '#b/chars'],
  ['b-04-entries-light', 1440, 900,  'light', '#b/entries'],
  ['b-05-narrow',        1180, 820,  'dark',  '#b/entries']
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
    await win.webContents.executeJavaScript(
      `window.__mock.theme(${JSON.stringify(theme)}); location.hash = ${JSON.stringify(hash)}; new Promise(r => setTimeout(r, 220));`
    );
    await win.webContents.executeJavaScript(
      'Promise.all(Array.from(document.images).map(i => i.decode().catch(() => null)))'
    );

    const check = await win.webContents.executeJavaScript(`({
      size: innerWidth + 'x' + innerHeight,
      theme: document.documentElement.getAttribute('data-theme'),
      overflowX: document.documentElement.scrollWidth > innerWidth + 1,

      // 顶栏三件套吃掉多少高度 —— 本稿的核心指标之一（现状 225）
      chromeHeight: (() => {
        const view = document.querySelector('.view.active');
        let h = 0;
        for (const sel of ['.page-head', '.a-bookbar', '.b-bookhead', '.a-tabs']) {
          const e = view.querySelector(sel);
          if (e && getComputedStyle(e).display !== 'none') h += e.getBoundingClientRect().height;
        }
        return Math.round(h);
      })(),

      // 正文列的实际字宽与估算「每行几个汉字」（--fs-sm 是 14px，汉字 1em）
      measure: (() => {
        const ta = document.querySelector('.view.active .sheet-lead .sheet-input');
        if (!ta) return null;
        const cs = getComputedStyle(ta);
        const w = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return { col: Math.round(w), chars: Math.round(w / 14) };
      })(),

      // 条目列表：行数 / 列宽 / 别名有没有被截断（现状 279px 下是截断的）
      list: (() => {
        const rows = document.querySelectorAll('.view.active .entry-row');
        if (!rows.length) return null;
        const box = rows[0].getBoundingClientRect();
        const trunc = Array.from(document.querySelectorAll('.view.active .entry-row-keys'))
          .filter(n => n.scrollWidth > n.clientWidth + 1).length;
        return { rows: rows.length, rowW: Math.round(box.width), rowH: Math.round(box.height), trunc };
      })(),

      // 左栏是否长出栏内滚动条（现状踩过一次：左栏自己滚）
      railOverflow: (() => {
        const rail = document.querySelector('.view.active .a-list, .view.active .b-rail');
        return !!rail && rail.scrollHeight > rail.clientHeight + 1;
      })(),

      images: Array.from(document.images).filter(i => !(i.complete && i.naturalWidth > 0)).map(i => i.getAttribute('src')),

      // 有几块「看得见的内容」，防止出成一张空图
      blocks: Array.from(document.querySelectorAll('.view.active .sheet, .view.active .a-aside-card, .view.active .char-card, .view.active .empty-card, .view.active .b-strip, .view.active .danger-zone'))
        .filter(n => getComputedStyle(n).display !== 'none').length,

      // 控件被挤出视口（在横向滚动容器里的不算）
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
    if (check.chromeHeight > 200) problems.push('顶栏吃掉 ' + check.chromeHeight + 'px（预算 164）');
    if (check.measure && check.measure.chars > 48) problems.push('正文 ' + check.measure.chars + ' 字/行（舒适区上限 45）');
    // 现状基线：1440×900 下 51 条里有 **19 条**别名被截断（列表行只有 253px）。
    // 门槛 10 = 至少比现状好一半；1440 各屏实际是 1 行，窄屏 A 稿是 9 行。
    if (check.list && check.list.trunc > 10) problems.push('条目别名截断 ' + check.list.trunc + '/51 行（现状 19）');
    if (check.railOverflow) problems.push('左栏出现栏内滚动');
    if (check.images.length) problems.push('图片未加载: ' + check.images.join(', '));
    if (check.offscreen.length) problems.push('控件出界: ' + check.offscreen.join(', '));
    if (!check.blocks) problems.push('没有任何可见内容');

    // 顺带取三个像素点当证据：capturePage 有可能拿到合成器没重绘的陈旧帧
    // （白天主题那次就差一点被误判成「侧栏没跟着变」）。
    const shot = await win.webContents.capturePage();
    const bmp = shot.toBitmap();
    const sz = shot.getSize();
    const px = (x, y) => { const i = (y * sz.width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]].join(','); };
    check.px = { 侧栏_20_400: px(20, 400), 正文_700_600: px(700, 600), 列表_300_600: px(300, 600) };
    fs.writeFileSync(path.join(__dirname, name + '.png'), shot.toPNG());
    report.push({ name, ...check, problems });
    console.log([
      problems.length ? 'FAIL' : ' ok ',
      name.padEnd(20),
      check.size.padEnd(9),
      check.theme.padEnd(6),
      ('顶栏 ' + check.chromeHeight).padEnd(9),
      (check.measure ? check.measure.col + 'px ≈ ' + check.measure.chars + ' 字/行' : '无正文卡').padEnd(18),
      (check.list ? '行 ' + check.list.rowW + 'x' + check.list.rowH + ' 截断 ' + check.list.trunc + '/51' : '无列表').padEnd(24),
      check.blocks + ' 块',
      JSON.stringify(check.px) + '  ' + problems.join(' | ')
    ].join('  '));
  }

  console.log('\n截图 ' + report.filter((r) => !r.problems.length).length + '/' + report.length + ' 通过；控制台报错 ' + errors.length + ' 条');
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  if (report.some((r) => r.problems.length) || errors.length) app.exit(1);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
