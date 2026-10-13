'use strict';

// ============================================================================
//  tools/audit-spacing.js —— 间距 / 行高 lint
//
//  为什么要有它：2026-10-13 星宝说「**去掉样式里的 line-height，感觉真是搞乱样式，
//  字体看着都不居中了**，然后 padding / margin / gap 这些边距的**不要单数 px**，
//  总是会有一些 `padding: 6px 11px`」。
//
//  当时全站 style.css 里躺着 **80 处 line-height**（1 到 1.9 之间什么值都有：
//  1.35 / 1.55 / 1.6 / 1.65 / 1.7 / 1.75 / 1.85 / 1.9）和 **132 处奇数边距** ——
//  全是手写时一处处冒出来的，**没有任何东西守着**，删完下次写还长回来。
//  和圆角那次（62 处写死的 6/7/14/16/24px）、字号那次（19 种档位）是同一个坑：
//  **不报错、测试全绿、每处单独看还都像是对的**，等有人去数才发现。
//
//  判据：
//    · **不许出现 line-height** —— 行高交给浏览器默认，别再一处处地改。
//    · **padding / margin / gap / row-gap / column-gap 里的 px 必须是偶数**（0 算偶数）。
//      奇数在 125% / 150% 显示缩放下会被 Chromium 抹成半像素，看着就是「没对齐」。
//
//  刻意放行的（不算错，只列出来让你确认）：
//    · `var(--x)` —— 值不在这行（`--chat-pad-left` 那种是用户滑块调的，本来就随缘）。
//    · `calc(...)` —— 整段跳过，连里面的数也不查：那是**算出来的**，不是写死的档位。
//    · `auto` / `0` 以及百分比 / em / rem / vh 等非 px 单位。
//
//  ⚠️ 和 audit-radius / audit-font 不同，这个脚本**同时查 pet.css** ——
//     行高和奇数边距那条规矩跟变量体系无关，两个窗口都该守。
//  ⚠️ `tools/mock/*.html`（设计稿）**不查**：那是稿子不是运行时样式。
//
//  用法：node tools/audit-spacing.js       （有 FAIL 时退出码 1）
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  path.join(ROOT, 'renderer', 'style.css'),
  path.join(ROOT, 'renderer', 'pet', 'pet.css')
];

// 边距类属性：这些的 px 值必须是偶数
const SPACING = /(?<![-\w])(padding|margin|gap|row-gap|column-gap)(?:-[a-z]+)?\s*:\s*([^;}]+)/g;

/** 在值里挑出「括号外面的、写死的奇数 px」——calc()/var() 内部不碰 */
function oddPxIn(value) {
  const hits = [];
  let depth = 0;
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth--; i++; continue; }
    if (depth === 0 && (ch === '-' || (ch >= '0' && ch <= '9'))) {
      const m = /^-?\d+(?:\.\d+)?px/.exec(value.slice(i));
      if (m) {
        const n = parseFloat(m[0]);
        if (Number.isInteger(n) && Math.abs(n) % 2 === 1) hits.push(m[0]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return hits;
}

let fail = 0;

for (const file of FILES) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  // 去注释（保留换行，行号别乱）—— 和 audit-radius / audit-font 同一套处理
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1));
  const lines = src.split('\n');

  const odd = [];
  const lh = [];

  lines.forEach((line, idx) => {
    const no = idx + 1;
    if (/\bline-height\s*:/.test(line)) lh.push({ no, text: line.trim() });
    SPACING.lastIndex = 0;
    let m;
    while ((m = SPACING.exec(line))) {
      const hits = oddPxIn(m[2]);
      if (hits.length) odd.push({ no, text: line.trim(), hits });
    }
  });

  if (lh.length) {
    console.log(`=== FAIL：line-height（应该删掉，交给浏览器默认行高）== ${rel} 共 ${lh.length} 处`);
    for (const h of lh) console.log(`  · ${rel}:${h.no}   ${h.text}`);
  } else {
    console.log(`=== line-height：${rel} 干净 ✓`);
  }

  if (odd.length) {
    console.log(`=== FAIL：奇数边距 px（应该是偶数）== ${rel} 共 ${odd.length} 处`);
    for (const h of odd) console.log(`  · ${rel}:${h.no}   ${h.text}      ← ${h.hits.join(' / ')}`);
  } else {
    console.log(`=== 奇数边距：${rel} 干净 ✓`);
  }

  fail += lh.length + odd.length;
  console.log('');
}

if (fail) {
  console.log(`❌ 间距 lint 失败：${fail} 处（判据与理由见本文件顶部注释）`);
  process.exit(1);
}
console.log('✅ 间距 lint 通过');
