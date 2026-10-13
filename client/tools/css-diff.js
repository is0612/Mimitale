'use strict';

// ============================================================================
//  tools/css-diff.js —— 两份 CSS 的「渲染结果」差异对比
//
//  为什么要有它：style.css 是「基础段 + 末尾覆盖层」结构，**同一个选择器两处定义**
//  （`node tools/audit-css-dup.js` 现在列出 12 处）。合并这些重复时，
//  光看 diff、光出图都**证明不了「渲染结果没变」** —— 覆盖靠**源码顺序**决定胜负，
//  把后面那条搬到前面，很可能悄悄换了个赢家，而这**不报错、测试也不红**。
//
//  这个脚本把「渲染结果」变成可比的数据：加载同一份 `index.html` 两次，
//  分别注入两份 CSS，对**每个元素**取 computed style 的全量属性算哈希。
//  hash 全对 = 两份 CSS 对这个页面产生的效果**逐属性相同**。
//  有差异时再对差异元素单独 dump 详情（属性名 / 前 / 后）。
//
//  ⚠️ 两边必须加载**同一份 HTML** —— 差异元素用下标对齐，HTML 不同就没有意义。
//  ⚠️ 会**剥掉 HTML 里的 <script>**：只验 CSS。JS 一跑，两边的动态 DOM 就不一定
//     同步了（异步渲染、假后端缺失会报错），比出来的差异全是噪声。
//     代价：**「JS 动态加 class 之后才生效的规则」测不到** —— 那部分靠冒烟里的
//     计算样式断言 + 出图兜。
//  ⚠️ 窗口尺寸会影响布局（width/height 是 used value），所以两次用同一个尺寸。
//     要换尺寸看另一档就 `--size=WxH`。
//
//  用法：
//    unset ELECTRON_RUN_AS_NODE
//    ./node_modules/electron/dist/electron.exe --no-sandbox tools/css-diff.js A.css B.css
//    退出码：0 = 零差异，1 = 有差异，2 = 参数不对
// ============================================================================

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.disableHardwareAcceleration();

const RENDERER = path.join(__dirname, '..', 'renderer');
const INDEX = path.join(RENDERER, 'index.html');

const args = process.argv.slice(1);
const sizeArg = (args.find((a) => a.startsWith('--size=')) || '').split('=')[1];
const [W, H] = (sizeArg || '1440x900').split('x').map(Number);
// ⚠️ 别用 slice(2) 数位置：`electron --no-sandbox tools/css-diff.js a.css b.css` 里
//    argv 还夹着 electron 自己的开关和脚本路径，位置是不定的。
const files = args.filter((a) => !a.startsWith('--') && !/\.js$/i.test(a) && !/electron(\.exe)?$/i.test(a));

if (files.length !== 2) {
  console.error('用法: electron tools/css-diff.js <before.css> <after.css> [--size=1440x900]');
  process.exit(2);
}

const staged = [];

/** 把被测 CSS 拷进 renderer/ —— 临时页面的 <link> 用相对路径，必须同目录 */
function stageCss(src, tag) {
  const dst = path.join(RENDERER, `__cssdiff-${tag}.css`);
  fs.copyFileSync(src, dst);
  staged.push(dst);
  return path.basename(dst);
}

/** 造临时页面：换掉 style.css 的 link、剥掉所有 script */
function makePage(cssBase, tag) {
  const raw = fs.readFileSync(INDEX, 'utf8');
  if (!/<link[^>]*style\.css/.test(raw)) {
    console.error('没在 index.html 里找到 style.css 的 <link> —— 结构变了，脚本要跟着改');
    process.exit(2);
  }
  const out = raw
    .replace(/<link[^>]*style\.css[^>]*>/, `<link rel="stylesheet" href="${cssBase}">`)
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const file = path.join(RENDERER, `__cssdiff-${tag}.html`);
  fs.writeFileSync(file, out, 'utf8');
  staged.push(file);
  return file;
}

// 页面里跑的取样式脚本：返回 [下标, 描述, 全属性哈希]
const SNAPSHOT_JS = `(() => {
  const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) {
      s += '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.');
    }
    return s;
  };
  const els = Array.from(document.querySelectorAll('*'));
  return els.map((el, i) => {
    const cs = getComputedStyle(el);
    const parts = [];
    for (let k = 0; k < cs.length; k++) {
      const n = cs[k];
      const v = cs.getPropertyValue(n);
      if (v) parts.push(n + ':' + v);
    }
    return [i, desc(el), hash(parts.join(';'))];
  });
})()`;

/** 对指定下标的元素取全量属性详情 */
function detailOf(indexes) {
  return `(() => {
    const els = Array.from(document.querySelectorAll('*'));
    const out = {};
    ${JSON.stringify(indexes)}.forEach((i) => {
      const el = els[i];
      if (!el) { out[i] = null; return; }
      const cs = getComputedStyle(el);
      const o = {};
      for (let k = 0; k < cs.length; k++) {
        const n = cs[k];
        const v = cs.getPropertyValue(n);
        if (v) o[n] = v;
      }
      out[i] = o;
    });
    return out;
  })()`;
}

async function snap(win, pageFile) {
  await win.loadFile(pageFile);
  await new Promise((r) => setTimeout(r, 120));
  return win.webContents.executeJavaScript(SNAPSHOT_JS);
}

async function details(win, pageFile, indexes) {
  await win.loadFile(pageFile);
  await new Promise((r) => setTimeout(r, 120));
  return { pageFile, data: await win.webContents.executeJavaScript(detailOf(indexes)) };
}

app.whenReady().then(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-cssdiff-'));
  app.setPath('userData', path.join(tmpRoot, 'user-data'));

  const pageA = makePage(stageCss(path.resolve(files[0]), 'a'), 'a');
  const pageB = makePage(stageCss(path.resolve(files[1]), 'b'), 'b');

  const win = new BrowserWindow({
    width: W, height: H, useContentSize: true, show: false,
    webPreferences: { backgroundThrottling: false }
  });

  const rowsA = await snap(win, pageA);
  const rowsB = await snap(win, pageB);

  console.log(`A = ${files[0]}`);
  console.log(`B = ${files[1]}`);
  console.log(`视口 ${W}x${H} · 元素数 A=${rowsA.length} B=${rowsB.length}`);

  if (rowsA.length !== rowsB.length) {
    console.log('\n❌ 元素数量不同 —— 两份 HTML 不是同一份，比较没有意义');
    await finish(win, 1);
    return;
  }

  const changed = [];
  for (let i = 0; i < rowsA.length; i++) {
    if (rowsA[i][2] !== rowsB[i][2]) changed.push(i);
  }

  if (!changed.length) {
    console.log(`\n✅ 零差异：${rowsA.length} 个元素的 computed style 逐属性完全相同`);
    await finish(win, 0);
    return;
  }

  console.log(`\n❌ 有差异的元素：${changed.length} / ${rowsA.length}\n`);

  const da = await details(win, pageA, changed);
  const db = await details(win, pageB, changed);

  let shown = 0;
  for (const i of changed) {
    const a = da.data[i] || {};
    const b = db.data[i] || {};
    const names = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    const lines = [];
    for (const n of names) {
      if (a[n] !== b[n]) lines.push(`   ${n.padEnd(28)} ${a[n] ?? '(无)'}  →  ${b[n] ?? '(无)'}`);
    }
    if (!lines.length) continue;
    console.log(`● #${i} ${rowsA[i][1]}`);
    console.log(lines.join('\n'));
    console.log('');
    if (++shown >= 40) { console.log('（只显示前 40 个元素）'); break; }
  }

  await finish(win, 1);
});

async function finish(win, code) {
  for (const f of staged) { try { fs.unlinkSync(f); } catch { /* 清理失败不影响结论 */ } }
  win.destroy();
  app.exit(code);
}
