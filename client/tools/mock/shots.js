'use strict';

// ============================================================================
//  tools/mock/shots.js —— 把设计稿逐页截成 PNG
//
//  设计稿里每个页面是一个固定尺寸的 .frame（= 真实窗口尺寸），带
//  data-shot="文件名"。这个脚本把窗口内容区设成同样大小，逐个滚到页首再截
//  整个视口 —— 于是截出来的图就是「这个页面在真窗口里的样子」，不是缩略图。
//
//  用法（本机默认带 ELECTRON_RUN_AS_NODE，必须 unset）：
//    cd <项目根目录>（有 package.json 的那一层）
//    export MSYS_NO_PATHCONV=1 && unset ELECTRON_RUN_AS_NODE
//    ./node_modules/electron/dist/electron.exe --no-sandbox tools/mock/shots.js \
//        [--src=wb-list.html] [--size=1440x900]
//
//  ⚠️ --size 必须**正好**等于源文件里 .frame 的宽高。frame 尺寸跟着窗口走，
//     窗口尺寸跟着屏幕限制走 —— 对不上就会截到半张或一片空白。
//     真窗口尺寸查 main/window.js 的 WINDOW_SIZE（当前 1440x900）。
//
//  产物：tools/shots/mock/*.png（tools/shots/ 已在 .gitignore 里）
// ============================================================================

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// 只做离屏截图，不需要 GPU；关掉可以避开「GPU 进程崩溃带走主进程」的环境噪声
app.disableHardwareAcceleration();

const argv = process.argv.slice(1);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const SRC = argOf('src', 'redesign.html');
const [W, H] = argOf('size', '1180x800').split('x').map((n) => Number(n) || 0);

const FILE = path.isAbsolute(SRC) ? SRC : path.join(__dirname, SRC);
const OUT = path.join(__dirname, '..', 'shots', 'mock');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`[src] ${FILE}  ${W}x${H}`);

  const win = new BrowserWindow({
    width: W,
    height: H,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false }
  });

  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    const message = typeof args[2] === 'string' ? args[2] : first && first.message;
    console.log(`[console] ${message}`);
  });

  await win.loadFile(FILE);

  // 字体没就绪就截，雅黑/楷体会退成别的 —— 字感就假了，评审等于白看
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 400));

  const frames = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[data-shot]')).map((el) => el.dataset.shot)`
  );

  if (!frames.length) {
    console.log('[warn] 一个 [data-shot] 都没找到');
    app.quit();
    return;
  }

  // ---- 自检 1：token 真的生效了吗 + 三级文字对比度（WCAG AA 要 4.5:1）----
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
    const lum = (c) => {
      const [r,g,b] = c.map((v) => { const x = v/255;
        return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); });
      return 0.2126*r + 0.7152*g + 0.0722*b;
    };
    const ratio = (a,b) => { const x = lum(hex2rgb(a)), y = lum(hex2rgb(b));
      return ((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)).toFixed(2); };
    const root = getComputedStyle(document.documentElement);
    return [
      '# 卡片底 ' + root.getPropertyValue('--bg-card').trim()
        + ' 正文 ' + ratio(root.getPropertyValue('--text'), root.getPropertyValue('--bg-card'))
        + ' 次要 ' + ratio(root.getPropertyValue('--text-dim'), root.getPropertyValue('--bg-card'))
        + ' 最次 ' + ratio(root.getPropertyValue('--text-faint'), root.getPropertyValue('--bg-card')),
      '# 页面底 ' + root.getPropertyValue('--bg').trim()
        + ' 正文 ' + ratio(root.getPropertyValue('--text'), root.getPropertyValue('--bg'))
        + ' 最次 ' + ratio(root.getPropertyValue('--text-faint'), root.getPropertyValue('--bg'))
    ];
  })()`);
  probe.forEach((l) => console.log('[probe] ' + l));

  for (let i = 0; i < frames.length; i += 1) {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('[data-shot]')[${i}].scrollIntoView({ block: 'start' }); true`
    );
    await new Promise((r) => setTimeout(r, 220));

    // ---- 自检 2：有没有元素被「最近的裁剪祖先」切掉 ----
    // 必须 JSON.stringify 往返：直接把 DOM 对象丢回主进程会抛 UnknownVizError
    const note = await win.webContents.executeJavaScript(`JSON.stringify((() => {
      const f = document.querySelectorAll('[data-shot]')[${i}];
      let worst = 0, sel = '', clip = '';
      for (const el of f.querySelectorAll('*')) {
        let a = el.parentElement, holder = f;
        while (a && a !== document.body) {
          const oy = getComputedStyle(a).overflowY;
          if (oy === 'hidden' || oy === 'auto' || oy === 'scroll') { holder = a; break; }
          a = a.parentElement;
        }
        const over = Math.round(
          el.getBoundingClientRect().bottom - holder.getBoundingClientRect().bottom
        );
        if (over > worst) {
          worst = over;
          sel = typeof el.className === 'string' ? el.className : el.tagName;
          clip = String(holder.className || holder.tagName);
        }
      }
      let ta = '';
      for (const t of f.querySelectorAll('textarea')) {
        if (t.scrollHeight > t.clientHeight + 2) {
          ta = String(t.value).replace(/\\s+/g, ' ').trim().slice(0, 22);
          break;
        }
      }
      // 卡片是不是铺满了网格宽度（顺带量一下每张卡的实际宽高，方便核对列数）
      const g = f.querySelector('.grid6, .grid3');
      const cards = g ? g.querySelectorAll('.card') : [];
      const box = cards.length ? cards[0].getBoundingClientRect() : { width: 0, height: 0 };
      return { worst, sel: String(sel).slice(0, 34), clip: clip.slice(0, 28), ta,
               n: cards.length, w: Math.round(box.width), h: Math.round(box.height) };
    })())`);

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, frames[i] + '.png'), img.toPNG());
    const o = JSON.parse(note);
    const bits = [`卡 ${o.n} 张 ${o.w}x${o.h}`];
    if (o.worst > 2) bits.push(`⚠ 被裁 ${o.worst}px @ ${o.sel}  ← ${o.clip}`);
    if (o.ta) bits.push(`⚠ 文本框装不下: "${o.ta}…"`);
    console.log(`[shot] ${frames[i]}  ${W}x${H}  ${bits.join('  |  ')}`);
  }

  console.log(`[done] ${frames.length} 张 → ${OUT}`);
  app.quit();
}).catch((err) => {
  console.error('[fail]', err);
  app.quit();
});
