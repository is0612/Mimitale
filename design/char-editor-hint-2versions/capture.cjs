// 逐屏出图 + 自检：角色卡编辑 ·「这一栏怎么写」两版设计稿
// 跑法（本机 shell 里 ELECTRON_RUN_AS_NODE=1，必须 unset）：
//   env -u ELECTRON_RUN_AS_NODE client/node_modules/electron/dist/electron.exe --no-sandbox \
//     design/char-editor-hint-2versions/capture.cjs
// 可选：--only=A / --only=B

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(os.tmpdir(), 'mimitale-char-hint-2versions'));

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const W = 1440;
const H = 900;

const js = async (win, code, label) => {
  try {
    return await win.webContents.executeJavaScript(code);
  } catch (error) {
    console.error('[FAIL] ' + label + ' — ' + (error && error.message));
    throw error;
  }
};

const PROBE = `(() => {
  const hex2rgb = (h) => {
    h = String(h).trim();
    if (h.charAt(0) === '#') {
      if (h.length === 4) h = '#' + h[1]+h[1]+h[2]+h[2]+h[3]+h[3];
      return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    }
    const m = h.match(/[0-9.]+/g);
    return m ? m.slice(0,3).map(Number) : [0,0,0];
  };
  const lum = (c) => { const [r,g,b] = c.map((v) => { const x = v/255;
    return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); });
    return 0.2126*r + 0.7152*g + 0.0722*b; };
  const ratio = (a,b) => { const x = lum(hex2rgb(a)), y = lum(hex2rgb(b));
    return ((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)).toFixed(2); };
  const out = [];
  for (const mode of ['dark','light']) {
    window.__mock.theme(mode);
    const cs = getComputedStyle(document.querySelector('.frame'));
    const card = cs.getPropertyValue('--bg-card');
    const elev = cs.getPropertyValue('--bg-elev');
    out.push(mode
      + ' 卡底' + card.trim()
      + ' | text ' + ratio(cs.getPropertyValue('--text'), card)
      + ' | dim ' + ratio(cs.getPropertyValue('--text-dim'), card)
      + ' | faint ' + ratio(cs.getPropertyValue('--text-faint'), card)
      + ' | faint@浮层 ' + ratio(cs.getPropertyValue('--text-faint'), elev));
  }
  return out;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    // ⚠️ 不能在建窗时直接给 1440×900：本机屏幕只有 1024×768，Windows 会把窗口
    //    钳到屏幕内（实测内容区被压成 1008×689，图右侧整块被裁）。
    //    先建一个更小的窗、再 setContentSize —— SetContentSize 不钳，视口才真的是 1440×900。
    width: 900,
    height: 700,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setContentSize(W, H);

  const errors = [];
  win.webContents.on('console-message', (event) => {
    const level = event && event.level;
    if (level === 'error' || level === 3) errors.push(String(event.message || ''));
  });

  await win.loadFile(path.join(__dirname, 'index.html'));
  await js(win, 'document.fonts.ready.then(() => true)', 'fonts');
  const bootErr = await js(win, 'JSON.stringify(window.__err || [])', 'boot errors');
  if (bootErr !== '[]') console.log('[renderer error] ' + bootErr);

  const shots = await js(win, 'window.__mock.shots', 'read shots');
  const probe = await js(win, PROBE, 'probe');

  const report = [];
  for (const s of shots) {
    if (only && !s.name.startsWith(only)) continue;

    const sel = '[data-shot="' + s.name + '"]';
    await js(win, 'window.__mock.theme(' + JSON.stringify(s.light ? 'light' : 'dark') + '); true', 'theme ' + s.name);
    await js(win, 'document.querySelector(' + JSON.stringify(sel) + ').scrollIntoView({ block: "start" }); true', 'scroll ' + s.name);
    await new Promise((r) => setTimeout(r, 240));

    // ---- 自检：被「最近的裁剪祖先」切掉（只看 frame 边界会漏） ----
    const clipNote = await js(win, `JSON.stringify((() => {
      const f = document.querySelector(${JSON.stringify(sel)});
      const clipped = [];
      for (const el of f.querySelectorAll('*')) {
        let a = el.parentElement, holder = f;
        while (a && a !== document.body) {
          const oy = getComputedStyle(a).overflowY;
          if (oy === 'hidden' || oy === 'auto' || oy === 'scroll') { holder = a; break; }
          a = a.parentElement;
        }
        const over = Math.round(el.getBoundingClientRect().bottom - holder.getBoundingClientRect().bottom);
        // 「栏内滚动」是设计意图（.work 会滚），不算裁切；只有 holder 是 frame 本身才报
        if (over > 2 && holder === f) {
          clipped.push((typeof el.className === 'string' ? el.className : el.tagName) + '+' + over);
        }
      }
      const work = f.querySelector('.work');
      return { clipped: clipped.slice(0, 4),
        frameOverflow: f.scrollWidth > f.clientWidth + 1,
        workClient: work ? Math.round(work.clientHeight) : 0,
        workScroll: work ? Math.round(work.scrollHeight) : 0,
        sheetsBottom: Math.round((f.querySelector('.sheets') || f).getBoundingClientRect().bottom - f.getBoundingClientRect().top) };
    })())`, 'probe ' + s.name);

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, s.name + '.png'), img.toPNG());

    const o = JSON.parse(clipNote);
    const problems = [];
    if (o.clipped.length) problems.push('被裁: ' + o.clipped.join(', '));
    if (o.frameOverflow) problems.push('横向溢出');
    report.push({ name: s.name, problems });
    const grow = o.workScroll - o.workClient;
    console.log(
      (problems.length ? 'FAIL ' : ' ok  ') + s.name.padEnd(20) + (s.light ? 'light' : 'dark').padEnd(6) +
      ('稿纸底 ' + o.sheetsBottom + 'px / 可视 ' + o.workClient + 'px').padEnd(30) +
      (grow > 2 ? '栏内需滚 ' + grow + 'px' : '一屏放下 ') +
      (problems.length ? '  ← ' + problems.join(' | ') : '')
    );
  }

  console.log('\n[probe]\n' + probe.join('\n'));
  console.log('\n出图 ' + report.filter((r) => !r.problems.length).length + '/' + report.length + ' 通过；控制台报错 ' + errors.length + ' 条');
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  if (report.some((r) => r.problems.length) || errors.length) app.exit(1);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
