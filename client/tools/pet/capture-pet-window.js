'use strict';

// tools/pet/capture-pet-window.js —— 真起一次宠物窗口截图 + 收集页面报错；产物 tools/pet/pet-window.png
//   跑法：./node_modules/electron/dist/electron.exe --no-sandbox tools/pet/capture-pet-window.js [--skin=whale --scale=1.6]
// ⚠️ 数据在临时目录（不碰真实数据）；气泡不跟 --scale 走；截图带 alpha（照片查看器会显示成白底，别据此判断抠图坏了）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'pet-window.png');
const skinArg = process.argv.find((a) => a.startsWith('--skin='));
const SKIN = skinArg ? skinArg.slice('--skin='.length) : null;
const scaleArg = process.argv.find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? Math.max(0.4, Math.min(2, Number(scaleArg.slice('--scale='.length)) || 1)) : 1;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-pet-window-'));
process.env.MIMITALE_DATA_DIR = tmpRoot;
// 两个参数走同一条预写 config 的路：分开写的话「只想改 scale」还得先知道默认形象叫什么
if (SKIN || SCALE !== 1) {
  fs.mkdirSync(path.join(tmpRoot, 'pet'), { recursive: true });
  const config = {
    version: 1, enabled: true, activeId: 'pet1',
    pets: [{
      id: 'pet1', name: '蓝自',
      look: { kind: 'rig', source: 'assets', skin: SKIN || 'whale' },
      visible: true, scale: SCALE, bounds: { x: 900, y: 500, displayId: 0 },
      walkEnabled: true, speakEnabled: true, speakEveryTurns: 3, speakLines: 1,
      mutedUntil: 0, useMainModel: true, providerId: '', model: '',
      temperature: 0, style: '', memoryMaxItems: 30, createdAt: Date.now(),
    }],
  };
  fs.writeFileSync(path.join(tmpRoot, 'pet', 'config.json'), JSON.stringify(config, null, 1));
  console.log('形象：%s  缩放：%s×（临时 config 写在 %s）', SKIN || '(默认 whale)', SCALE, tmpRoot);
}

const pageErrors = [];

app.whenReady().then(async () => {
  const petIpc = require(path.join(ROOT, 'main', 'pet-ipc.js'));
  const petWindow = require(path.join(ROOT, 'main', 'pet-window.js'));

  petIpc.registerPetIpc();

  const win = petWindow.createPetWindow();
  if (!win) {
    console.log('❌ 宠物窗口没建出来');
    app.exit(1);
    return;
  }

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // level 3 = error
    if (level >= 2) pageErrors.push(`[${level}] ${message} (${path.basename(String(sourceId))}:${line})`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    pageErrors.push(`渲染进程挂了：${JSON.stringify(details)}`);
  });

  win.showInactive();
  await new Promise((r) => setTimeout(r, 1500));

  // 顺便验证气泡那条链路（逐句冒字）
  const LINES = (() => {
    const a = process.argv.find((x) => x.startsWith('--lines='));
    if (!a) return ['这也太甜了吧。', '*尾巴摇起来* 我磕了。', '你倒是主动点啊。'];
    return a.slice('--lines='.length).split('|');
  })();
  petWindow.sendToPet('pet:say', {
    lines: LINES,
    text: LINES.join('\n'),
    reason: 'preview'
  });
  await new Promise((r) => setTimeout(r, 2000));

  // 连拍：pivots 对不对静置看不出来，得动起来才暴露「某个部件拖着不该拖的东西」
  // --idle：手势是 idle 下十来秒随机来一次，且鼠标不动猫会睡着，所以要定时轻晃鼠标把它弄醒
  const idleArg = process.argv.find((a) => a === '--idle');
  let idleTimer = null;
  if (idleArg) {
    let n = 0;
    idleTimer = setInterval(() => {
      n += 1;
      const b = win.getBounds();
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(b.width / 2 + Math.sin(n / 3) * 30),
        y: Math.round(b.height / 2 + Math.cos(n / 5) * 30),
      });
    }, 900);
    console.log('已开启 --idle：每 0.9 秒轻晃鼠标防睡，抓偶发手势');
  }

  const framesArg = process.argv.find((a) => a.startsWith('--frames='));
  const FRAMES = framesArg ? Math.max(1, parseInt(framesArg.slice('--frames='.length), 10) || 1) : 1;
  // --burst = --gap=60：1.2 秒一帧对「抖」是严重欠采样（每帧相位都不同，看着像随机乱摆）
  const burst = process.argv.includes('--burst');
  const gapArg = process.argv.find((a) => a.startsWith('--gap='));
  const GAP = burst ? 60 : (gapArg ? Math.max(16, parseInt(gapArg.slice('--gap='.length), 10) || 1200) : 1200);
  for (let i = 0; i < FRAMES; i++) {
    if (i) await new Promise((r) => setTimeout(r, burst ? GAP : (idleArg ? 1300 : GAP)));
    const img = await win.webContents.capturePage();
    const out = FRAMES > 1 ? OUT.replace(/\.png$/, `-${i + 1}.png`) : OUT;
    fs.writeFileSync(out, img.toPNG());
    if (FRAMES <= 12 || (i + 1) % 10 === 0) console.log('  帧 %d/%d -> %s', i + 1, FRAMES, out);
  }
  if (idleTimer) clearInterval(idleTimer);

  // 看截图只能猜是哪一行；把 scrollTop / clientHeight / 每行 offsetTop 摆出来就成了算术题
  if (process.argv.includes('--probe-scroll')) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('bubble-lines');
      const kids = [...box.children].map((el) => ({
        t: el.offsetTop, h: el.offsetHeight, txt: el.textContent.slice(0, 14)
      }));
      return {
        clientHeight: box.clientHeight,
        scrollHeight: box.scrollHeight,
        scrollTop: box.scrollTop,
        maxScroll: box.scrollHeight - box.clientHeight,
        lines: kids
      };
    })()`);
    console.log('  气泡滚动框：clientHeight=%d scrollHeight=%d scrollTop=%d maxScroll=%d',
      info.clientHeight, info.scrollHeight, info.scrollTop, info.maxScroll);
    for (const l of info.lines) {
      console.log('    行 @%d 高%d  %s', l.t, l.h, l.txt);
    }
  }

  // 「间隔」到底是气泡边距还是 rig 画布的留白，光看截图分不出来（两处都是透明像素）
  if (process.argv.includes('--probe-box')) {
    const g = await win.webContents.executeJavaScript(`(() => {
      const r = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { id, x: +b.x.toFixed(1), y: +b.y.toFixed(1),
                 w: +b.width.toFixed(1), h: +b.height.toFixed(1),
                 bottom: +b.bottom.toFixed(1),
                 mb: cs.marginBottom, pos: cs.position };
      };
      const sizer = document.querySelector('.rig-sizer');
      const canvas = document.querySelector('.rig-canvas');
      const s = sizer ? sizer.getBoundingClientRect() : null;
      const c = canvas ? canvas.getBoundingClientRect() : null;
      const tail = getComputedStyle(document.getElementById('bubble'), '::before');
      return {
        win: { w: innerWidth, h: innerHeight },
        bubble: r('bubble'),
        bubbleLines: r('bubble-lines'),
        tail: tail ? { bottom: tail.bottom, borderTopWidth: tail.borderTopWidth } : null,
        spriteWrap: r('sprite-wrap'),
        sizer: s ? { y: +s.y.toFixed(1), h: +s.height.toFixed(1),
                     bottom: +s.bottom.toFixed(1),
                     w: +s.width.toFixed(1),
                     marginBottom: getComputedStyle(sizer).marginBottom } : null,
        canvas: c ? { y: +c.y.toFixed(1), h: +c.height.toFixed(1),
                      bottom: +c.bottom.toFixed(1), w: +c.width.toFixed(1) } : null
      };
    })()`);
    console.log('  窗口内容区: %dx%d', g.win.w, g.win.h);
    console.log('  bubble        :', JSON.stringify(g.bubble));
    console.log('  bubble-lines  :', JSON.stringify(g.bubbleLines));
    console.log('  bubble::before:', JSON.stringify(g.tail));
    console.log('  sprite-wrap   :', JSON.stringify(g.spriteWrap));
    console.log('  rig-sizer     :', JSON.stringify(g.sizer));
    console.log('  rig-canvas    :', JSON.stringify(g.canvas));
    if (g.bubble && g.canvas) {
      console.log('  → 气泡下沿 %s 与 canvas 顶 %s 之间：%s px',
        g.bubble.bottom, g.canvas.y, (g.canvas.y - g.bubble.bottom).toFixed(1));
    }
  }

  const bounds = win.getBounds();
  console.log('窗口：%dx%d @ (%d,%d)  可见=%s  置顶=%s',
    bounds.width, bounds.height, bounds.x, bounds.y, win.isVisible(), win.isAlwaysOnTop());
  console.log('截图：%s', OUT);
  console.log('透明通道：已保留（capturePage 带 alpha）');


  if (pageErrors.length) {
    console.log('\n❌ 宠物页面有 %d 条报错/警告：', pageErrors.length);
    for (const line of pageErrors) console.log('   ! ' + line);
  } else {
    console.log('\n✅ 宠物页面没有报错');
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    /* 临时目录没删掉也无所谓 */
  }

  app.exit(pageErrors.length ? 1 : 0);
});
