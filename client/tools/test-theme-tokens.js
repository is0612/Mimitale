'use strict';

// ============================================================================
//  tools/test-theme-tokens.js —— 「默认主题 / 配色」那几处副本必须说同一件事
//
//  为什么要有它：主题是三份数据（明暗 / 配色 / 窗口底色）散在**五个文件**里：
//    main/providers.js  DEFAULT_SETTINGS.theme / accent + ACCENTS
//    main/window.js     WINDOW_BG（BrowserWindow 的 backgroundColor，首屏底色）
//    preload.js         INITIAL_ACCENTS（第一帧之前就设属性，抢在样式前）
//    renderer/js/ui/theme.js  ACCENT_NAME / DEFAULT_ACCENT（界面上那颗色点的名字）
//    renderer/style.css       [data-accent='amber'] / [data-theme='dark'] 的 --bg
//
//  少同步一处的表现**不是报错**，而是「有的地方变了、有的地方没变」：
//  真踩过的就是 WINDOW_BG.dark = #101113 与 style.css 的 #171a18 差一档 ——
//  启动时先黑一下再变亮，谁都说不清是哪来的。所以这几条比对写成测试。
//
//  跑法：node --test tools/test-theme-tokens.js
// ============================================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// main/providers.js 会顺着 ./store.js 去要 electron（要 app / safeStorage）。
// 这里塞个假的，把数据目录指到临时目录 —— 只为了拿常量，不碰真实配置。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-theme-'));
const fakeElectron = {
  app: {
    getName: () => 'Mimitale',
    getPath: (name) => (name === 'appData' ? path.join(tmpRoot, 'a') : path.join(tmpRoot, 'a', 'M')),
    getAppPath: () => path.join(__dirname, '..'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => s,
    decryptString: (s) => s
  }
};
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 从 CSS 里抠某个选择器块里的一个变量值。
 *  ⚠️ 必须按「整行就是这个选择器」来找：文件开头的注释里也写着 `[data-theme='dark']`
 *  （解释两套配色各自覆盖什么），用 indexOf 会先撞上那段注释，读到别的块的 --bg。 */
function cssVarBlock(css, selector, name) {
  const lines = css.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${selector} {`);
  assert.ok(start >= 0, `style.css 里找不到独立成行的 ${selector} {`);
  let end = start;
  while (end < lines.length && lines[end].trim() !== '}') end += 1;
  const block = lines.slice(start, end).join('\n');
  const hit = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(block);
  assert.ok(hit, `${selector} 里没有 --${name}`);
  return hit[1].trim().toLowerCase();
}

const { ACCENTS, DEFAULT_SETTINGS } = require('../main/providers.js');

test('配色名单：main / preload / 渲染层三份副本一致', () => {
  const preload = read('preload.js');
  const initial = /const INITIAL_ACCENTS = \[([^\]]*)\]/.exec(preload);
  assert.ok(initial, 'preload.js 里找不到 INITIAL_ACCENTS');
  const initialList = [...initial[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(initialList, ACCENTS, 'preload 的 INITIAL_ACCENTS 要跟 main 的 ACCENTS 一样');

  // preload 里那句「认不出来退回谁」也得是同一个默认值
  const fallback = /includes\(accentValue\) \? accentValue : '([^']+)'/.exec(preload);
  assert.ok(fallback, 'preload.js 的 accent 兜底写法变了，记得同步这条断言');
  assert.equal(fallback[1], DEFAULT_SETTINGS.accent, '首屏兜底色要和默认配色一致');

  const theme = read('renderer/js/ui/theme.js');
  const names = /const ACCENT_NAME = \{([\s\S]*?)\n\};/.exec(theme);
  assert.ok(names, 'ui/theme.js 里找不到 ACCENT_NAME');
  const accentKeys = [...names[1].matchAll(/^\s*([a-zA-Z][\w-]*)\s*:/gm)].map((m) => m[1]);
  assert.deepEqual(accentKeys.sort(), [...ACCENTS].sort(), 'ACCENT_NAME 的键要和 ACCENTS 一一对应（少一个就是选不到）');

  const defaultAccent = /const DEFAULT_ACCENT = '([^']+)'/.exec(theme);
  assert.ok(defaultAccent, 'ui/theme.js 里找不到 DEFAULT_ACCENT');
  assert.equal(defaultAccent[1], ACCENTS[0], '渲染层的默认配色 = ACCENTS 第一项');
});

test('明暗默认值：夜间，且渲染层认的也是这两个值', () => {
  assert.equal(DEFAULT_SETTINGS.theme, 'dark', '出厂默认夜间');
  const theme = read('renderer/js/ui/theme.js');
  // theme.js 的口径是「只有 dark 算夜间，其余都算白天」
  assert.match(theme, /getAttribute\('data-theme'\) === 'dark' \? 'dark' : 'light'/, 'theme.js 的明暗判定变了？');
});

test('窗口首屏底色 = style.css 里两套主题的 --bg（差一档就是启动先闪一下）', () => {
  const windowSrc = read('main/window.js');
  const block = /const WINDOW_BG = \{([\s\S]*?)\n\};/.exec(windowSrc);
  assert.ok(block, 'main/window.js 里找不到 WINDOW_BG');

  const css = read('renderer/style.css');
  for (const accent of ACCENTS) {
    const entry = new RegExp(`${accent}\\s*:\\s*\\{\\s*light:\\s*'(#[0-9a-fA-F]{6})',\\s*dark:\\s*'(#[0-9a-fA-F]{6})'`).exec(block[1]);
    assert.ok(entry, `WINDOW_BG 里缺少配色 ${accent}（缺了就是 undefined，窗口底色会变成默认黑）`);
    const [, light, dark] = entry;
    assert.equal(
      light.toLowerCase(),
      cssVarBlock(css, `[data-accent='${accent}']`, 'bg'),
      `${accent} 的白天底色和 style.css 对不上（窗口会先闪一下再变）`
    );
    assert.equal(
      dark.toLowerCase(),
      cssVarBlock(css, '[data-theme="dark"]'.replace(/"/g, "'"), 'bg'),
      `${accent} 的夜间底色和 style.css 的 [data-theme='dark'] 对不上（窗口会先闪一下再变）`
    );
  }
});

test('清理临时目录', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    // 删不掉不影响结论
  }
});
