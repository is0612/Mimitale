'use strict';

// ============================================================================
//  tools/audit-font.js —— 字号 lint：字体大小必须走 token，不许写死
//
//  为什么要有它：2026-10-12 深夜把全站字号从 **19 种**压成五档 token
//  （--fs-xs 12 / --fs-sm 14 / --fs-md 16 / --fs-lg 18 / --fs-xl 22），
//  做法是拿 sed 把 250 处写死的 font-size 一次性换掉 —— **换完没有任何东西守着它**。
//  这和圆角那次是同一个坑：`.btn` 写死 12px、62 处圆角写死、这次 19 种字号，
//  三次都是「不报错、测试全绿、每处单独看还都像是对的」，等有人去数才发现。
//
//  判据：**font-size 只允许 `var(--fs-*)`**（或 inherit / 无单位的关键字），
//  外加下面那 4 个「占位字」白名单。
//
//  刻意保留的（不算错，只列出来让你确认）—— 都是绑在**固定尺寸容器**里的占位字，
//  它们**不该**跟界面字号走（跟了就会从框里溢出来）：
//    · .convo-avatar        20px   48px 头像里的首字
//    · .worldbook-avatar    26px   世界书卡的「世」字
//    · （某处字母块）        30px
//    · .char-card-avatar    52px   2:3 立绘的占位字
//
//  ⚠️ 只查 renderer/style.css。renderer/pet/ 是**另一个窗口**的独立变量体系
//     （pet.css 有自己的 :root），要纳进来得先确认它有没有 --fs-* 这套。
//
//  用法：node tools/audit-font.js       （有 FAIL 时退出码 1）
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const CSS = path.join(__dirname, '..', 'renderer', 'style.css');

// 绑**固定尺寸容器**的占位字，写死是对的（容器不跟着 --ui-size 走，字也就不能跟）。
// ⚠️ 2026-10-13 移除了 '20px'：那是侧栏会话头像的首字，头像从 48 回到 36 之后
//    改用了 var(--fs-md) —— 留着就是一条永远用不到的豁免，以后容易误放行。
const RAW_OK = new Set(['26px', '30px', '52px']);
// 关键词（没有单位）：继承、显式归零，都不是「一个写死的档位」
const KEYWORD_OK = new Set(['inherit', 'initial', 'unset', 'revert', '0']);
// 相对单位（em / rem / %）：**它们本身就是「跟着上下文缩放」的** —— 正是我们要的东西。
// 正文里那一组（.bubble h1 1.07em、code 0.89em、table 0.93em…）全靠它：
// 「标题比正文大一点、代码比正文小一点」，而且换正文字号时它们跟着一起走。
// 硬换成 px 反而会让它们**不再跟** —— 所以这里必须放行，只列出来给人确认。
// ⚠️ 第一版 lint 没放行，一跑就报了 7 处假阳性（2026-10-12 当晚）。
const RELATIVE_OK = /^\d+(?:\.\d+)?(?:em|rem|%)$/;

const raw = fs.readFileSync(CSS, 'utf8');
// 去注释（保留换行，行号别乱）—— 和 audit-radius.js 同一套处理
const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1));
const lines = src.split('\n');

const fails = [];
const allowed = [];
const relative = [];

/** 往上找最近的选择器（够用了：这条 lint 只认「哪条规则写了多大的字」） */
function selectorAt(i) {
  for (let j = i; j >= 0 && j > i - 60; j -= 1) {
    if (lines[j].includes('{')) {
      return lines[j].split('{')[0].trim().replace(/\s+/g, ' ');
    }
  }
  return '(?)';
}

/** 把写死的 px 值映射到最接近的 token —— 报错时直接告诉你该改成哪个 */
function suggestToken(px) {
  if (px <= 12) return 'var(--fs-xs)';
  if (px <= 14) return 'var(--fs-sm)';
  if (px <= 16) return 'var(--fs-md)';
  if (px <= 18) return 'var(--fs-lg)';
  return 'var(--fs-xl)';
}

lines.forEach((line, i) => {
  const m = /font-size\s*:\s*([^;]+);/.exec(line);
  if (!m) return;
  const value = m[1].trim().replace(/\s+/g, ' ');
  if (value.includes('var(')) return; // 走 token 了，过
  if (KEYWORD_OK.has(value)) return;
  if (RELATIVE_OK.test(value)) {
    relative.push({ line: i + 1, value, sel: selectorAt(i) });
    return;
  }
  if (RAW_OK.has(value)) {
    allowed.push({ line: i + 1, value, sel: selectorAt(i) });
    return;
  }

  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  fails.push({
    line: i + 1,
    value,
    sel: selectorAt(i),
    token: px ? suggestToken(Number(px[1])) : 'var(--fs-xs) / var(--fs-sm) …'
  });
});

console.log('=== FAIL：写死的 font-size（应该走 token）===');
if (!fails.length) {
  console.log('  （无）✓');
} else {
  for (const f of fails) {
    console.log(`  ✗ style.css:${f.line}  font-size: ${f.value}   ← ${f.sel}`);
    console.log(`      建议改成 ${f.token}`);
  }
}

console.log('');
console.log('=== INFO：相对字号 em / rem / %（刻意跟着上下文缩放，确认一下）===');
if (!relative.length) {
  console.log('  （无）');
} else {
  for (const r of relative) {
    console.log(`  · style.css:${r.line}  ${r.value.padEnd(7)} ${r.sel}`);
  }
}

console.log('');
console.log('=== INFO：刻意保留的「固定容器占位字」（确认一下是不是真的刻意）===');
if (!allowed.length) {
  console.log('  （无）');
} else {
  for (const a of allowed) {
    console.log(`  · style.css:${a.line}  ${a.value.padEnd(7)} ${a.sel}`);
  }
}

console.log('');
console.log(
  `写死字号：${fails.length} 处   相对字号（em）：${relative.length} 处   占位字白名单：${allowed.length} 处`
);
if (fails.length) {
  console.log('');
  console.log('❌ 字号 lint 未通过 —— 请写 var(--fs-xs/sm/md/lg/xl)，别写死 px。');
  process.exit(1);
}
console.log('✅ 字号 lint 通过');
