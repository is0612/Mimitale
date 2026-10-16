// 逐屏出图 + 自检：编辑角色 两版设计稿
// 用客户端已装的 Electron 跑（注意本机 shell 里 ELECTRON_RUN_AS_NODE=1，必须 unset）：
//   env -u ELECTRON_RUN_AS_NODE client/node_modules/electron/dist/electron.exe --no-sandbox design/char-editor-2versions/capture.cjs
// 可选：--only=v1 / --only=v2

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.setPath('userData', path.join(require('node:os').tmpdir(), 'mimitale-char-editor-2versions'));

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const W = 1440;
const H = 900;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });

  const errors = [];
  win.webContents.on('console-message', (_e, details) => {
    if (details?.level === 'error') errors.push(details.message);
  });

  await win.loadFile(path.join(__dirname, 'index.html'));
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');

  const shots = await win.webContents.executeJavaScript('window.__mock.shots');

  // ---- 自检 0：token 真的生效了吗（挡住「看着像主题、其实变量没吃到」的假图） ----
  const probe = await win.webContents.executeJavaScript(`(() => {
    const hex2rgb = (h) => {
      h = String(h).trim();
      if (h.charAt(0) === '#') {
        if (h.length === 4) h = '#' + h[1]+h[1]+h[2]+h[2]+h[3]+h[3];
        return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
      }
      const m = h.match(/\\d+/g);
      return m ? m.slice(0,3).map(Number) : [0,0,0];
    };
    const lum = (c) => { const [r,g,b] = c.map((v) => { const x = v/255;
      return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); });
      return 0.2126*r + 0.7152*g + 0.0722*b; };
    const ratio = (a,b) => { const x = lum(hex2rgb(a)), y = lum(hex2rgb(b));
      return ((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)).toFixed(2); };
    const cs = getComputedStyle(document.documentElement);
    const card = cs.getPropertyValue('--bg-card');
    return ['--bg ' + cs.getPropertyValue('--bg').trim(),
      '--bg-card ' + card.trim(),
      '--accent ' + cs.getPropertyValue('--accent').trim(),
      '--text 对卡片 ' + ratio(cs.getPropertyValue('--text'), card),
      '--text-dim 对卡片 ' + ratio(cs.getPropertyValue('--text-dim'), card),
      '--text-faint 对卡片 ' + ratio(cs.getPropertyValue('--text-faint'), card)].join(' | ');
  })()`);

  const report = [];
  for (const s of shots) {
    if (only && !s.name.startsWith(only)) continue;

    await win.webContents.executeJavaScript(
      `window.__mock.theme(${JSON.stringify(s.light ? 'light' : 'dark')}); true`
    );
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-shot]').forEach((f) => {
         if (f.dataset.shot === ${JSON.stringify(s.name)}) {
           const w = f.querySelector('.work');
           if (w) w.scrollTop = ${Number(s.scroll) || 0};
         }
       }); true`
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-shot=${JSON.stringify(s.name)}]').scrollIntoView({ block: 'start' }); true`
    );
    await new Promise((r) => setTimeout(r, 240));

    // ---- 自检 1：被「最近的裁剪祖先」切掉（只看 frame 边界会漏） ----
    const clipNote = await win.webContents.executeJavaScript(`JSON.stringify((() => {
      const f = document.querySelector('[data-shot=${JSON.stringify(s.name)}]');
      const clipped = [];
      for (const el of f.querySelectorAll('*')) {
        let a = el.parentElement, holder = f;
        while (a && a !== document.body) {
          const oy = getComputedStyle(a).overflowY;
          if (oy === 'hidden' || oy === 'auto' || oy === 'scroll') { holder = a; break; }
          a = a.parentElement;
        }
        const over = Math.round(el.getBoundingClientRect().bottom - holder.getBoundingClientRect().bottom);
        // 「栏内滚动」是设计意图，不算裁切；只有 holder 是 frame 本身才报
        if (over > 2 && holder === f) {
          clipped.push((typeof el.className === 'string' ? el.className : el.tagName) + '+' + over);
        }
      }
      let ta = '';
      for (const t of f.querySelectorAll('textarea')) {
        if (t.scrollHeight > t.clientHeight + 2) {
          ta = (t.getAttribute('placeholder') || t.value).replace(/\\s+/g, ' ').trim().slice(0, 20) + ' 溢出 ' + (t.scrollHeight - t.clientHeight) + 'px';
          break;
        }
      }
      const rail = f.querySelector('.identity-rail');
      return { clipped: clipped.slice(0, 4), ta,
        railOverflow: !!rail && rail.scrollHeight > rail.clientHeight + 1,
        hOverflow: f.scrollWidth > f.clientWidth + 1,
        title: (f.querySelector('.page-title') || {}).textContent || '' };
    })())`);

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, s.name + '.png'), img.toPNG());

    const o = JSON.parse(clipNote);
    const problems = [];
    if (o.clipped.length) problems.push('被裁: ' + o.clipped.join(', '));
    if (o.ta) problems.push('文本框装不下: ' + o.ta);
    if (o.railOverflow) problems.push('左栏出现栏内滚动');
    if (o.hOverflow) problems.push('横向溢出');
    report.push({ name: s.name, problems });
    console.log([problems.length ? 'FAIL' : ' ok ', s.name, (s.light ? 'light' : 'dark'), problems.join(' | ')].join('  '));
  }

  console.log('\n[probe] ' + probe);
  console.log('出图 ' + report.filter((r) => !r.problems.length).length + '/' + report.length + ' 通过；控制台报错 ' + errors.length + ' 条');
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  if (report.some((r) => r.problems.length) || errors.length) app.exit(1);
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
