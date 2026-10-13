'use strict';

// ============================================================================
//  tools/audit-radius.js —— 圆角 lint：盒状圆角必须走 token，不许写死
//
//  为什么要有它：2026-10-12 把 `--radius` 从 16px 压到 4px 那轮，
//  **CSS 里一大批 `border-radius: 6/7/14/16/24px` 没跟着动** ——
//  卡片、弹窗、输入框、属性行、消息工具条各自写着自己的数，谁都不读变量。
//  后果是「圆角改方了」这件事在**大半个界面上压根没发生**：
//  不报错、测试也不红，每处单独看还都「像是对的」。
//  （前面 `.btn` 写死 12px 那次是同一个坑，那次只逮到一颗。）
//
//  判据：**盒状圆角只允许写 0 / 1 / 2 / 3px 或 var(--radius*)**。
//  4px 以上一律走 token —— 哪怕当前 token 恰好就是 4px，
//  写死的那一刻就已经埋好了「下次改 token 它不跟」的雷。
//
//  刻意保留的（不算错，只列出来让你确认）：
//    · `50%`   —— 圆形（头像、色点、滑块拇指）
//    · `999px` —— 药丸（计数徽章、开关、滑块轨道、标签 chip）
//    · `99px`  —— 帮助页那条刻度尺
//  它们是「形状就是圆/就是药丸」的语义，不是「盒子的圆角」。
//
//  用法：node tools/audit-radius.js       （有 FAIL 时退出码 1）
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const CSS = path.join(__dirname, '..', 'renderer', 'style.css');

// 这几个值语义上就是「圆」，写死是对的
const SHAPE_OK = new Set(['50%', '999px', '99px']);
// 小于 token 档位的微圆角：进度条 2px（设计稿 2:1022 就是 r=2）、竖线 1px 等
const SMALL_OK = new Set(['0', '1px', '2px', '3px']);

const raw = fs.readFileSync(CSS, 'utf8');
// 去注释（保留换行，行号别乱）
const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1));
const lines = src.split('\n');

const fails = [];
const shapes = [];
/** 往上找最近的选择器（够用了：这条 lint 只认「哪条规则写了多大的圆角」） */
function selectorAt(i) {
  for (let j = i; j >= 0 && j > i - 60; j -= 1) {
    if (lines[j].includes('{')) {
      return lines[j].split('{')[0].trim().replace(/\s+/g, ' ');
    }
  }
  return '(?)';
}

lines.forEach((line, i) => {
  const m = /border-radius\s*:\s*([^;]+);/.exec(line);
  if (!m) return;
  const value = m[1].trim().replace(/\s+/g, ' ');
  if (value.includes('var(')) return; // 走 token 了，过
  if (SHAPE_OK.has(value)) {
    shapes.push({ line: i + 1, value, sel: selectorAt(i) });
    return;
  }
  if (SMALL_OK.has(value)) return;

  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (px) {
    fails.push({ line: i + 1, value, sel: selectorAt(i), token: Number(px[1]) >= 6 ? 'var(--radius)' : 'var(--radius-sm)' });
  } else {
    fails.push({ line: i + 1, value, sel: selectorAt(i), token: 'var(--radius) / var(--radius-sm)' });
  }
});

console.log('=== FAIL：写死的「盒状」圆角（应该走 token）===');
if (!fails.length) {
  console.log('  （无）✓');
} else {
  for (const f of fails) {
    console.log(`  ✗ style.css:${f.line}  border-radius: ${f.value}   ← ${f.sel}`);
    console.log(`      建议改成 ${f.token}`);
  }
}

console.log('');
console.log('=== INFO：刻意保留的「形状」圆角（确认一下是不是真的刻意）===');
for (const s of shapes) {
  console.log(`  · style.css:${s.line}  ${s.value.padEnd(7)} ${s.sel}`);
}

console.log('');
console.log(`盒状写死：${fails.length} 处   形状类：${shapes.length} 处`);
if (fails.length) {
  console.log('');
  console.log('❌ 圆角 lint 未通过 —— 盒状圆角请写 var(--radius) / var(--radius-sm)。');
  process.exit(1);
}
console.log('✅ 圆角 lint 通过');
