'use strict';

// ============================================================================
//  tools/audit-css-dup.js —— 找出「同一选择器被定义了多次」的规则
//
//  为什么要有它：style.css 是「**基础段 + 末尾覆盖层**」的结构 ——
//  同一条规则可能写两遍，后面那次把前面盖掉（比如 .convo-item / .convo-title
//  在 470 行和 7000 行各有一份）。后果是改样式时只改一处会出现「改了没反应」，
//  而这**不报错、测试也不红**。
//
//  这个脚本把重复列出来，并告诉你「后一次重定义了哪些属性」——
//  用于判断能不能安全合并：
//    · 后一次把前一次的属性**全覆盖**  → 可以合并（把前一次删掉，或把结论并到一处）
//    · 只是**补充**了几个属性（无重叠）→ 合并要小心，前一次的属性还得留着
//
//  ⚠️ 只看**顶层**规则：@media / @keyframes 里的重复是有意的（响应式、动画帧），
//     不算「覆盖」。
//
//  用法：node tools/audit-css-dup.js
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const CSS = path.join(__dirname, '..', 'renderer', 'style.css');

const raw = fs.readFileSync(CSS, 'utf8');
// 去注释（保留换行，行号别乱）—— 和 audit-radius / audit-font 同一套处理
const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1));
const lines = src.split('\n');

/** 选择器规范化：去多余空格、按逗号拆开再排序，方便把 `.a, .b` 和 `.b,.a` 认成同一条 */
function normalize(sel) {
  return sel
    .split(',')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort()
    .join(', ');
}

/** 收集顶层规则（行首不缩进、行尾 {），@media 内部那些缩进的规则天然被跳过 */
const rules = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (!/^\S/.test(line) || !line.trim().endsWith('{')) continue;
  const rawSel = line.replace(/\{\s*$/, '').trim();
  if (!rawSel || rawSel.startsWith('@')) continue; // @media / @keyframes / @font-face

  const decls = [];
  let j = i + 1;
  for (; j < lines.length; j += 1) {
    const l = lines[j];
    if (/^\}/.test(l)) break;
    const t = l.trim();
    if (t) decls.push(t.replace(/;$/, ''));
  }
  rules.push({ rawSel, key: normalize(rawSel), line: i + 1, decls });
  i = j;
}

const byKey = new Map();
for (const r of rules) {
  if (!byKey.has(r.key)) byKey.set(r.key, []);
  byKey.get(r.key).push(r);
}

const propName = (decl) => decl.split(':')[0].trim();
const shown = (decls) => decls.join('; ').replace(/\s+/g, ' ').slice(0, 150);

let dupCount = 0;
let mergeable = 0;
const out = [];

for (const [key, list] of byKey) {
  if (list.length < 2) continue;
  dupCount += 1;

  const first = list[0];
  const last = list[list.length - 1];
  const firstProps = new Set(first.decls.map(propName));
  const lastProps = last.decls.map(propName);
  const overlap = lastProps.filter((p) => firstProps.has(p));
  const allCovered = firstProps.size > 0 && [...firstProps].every((p) => lastProps.includes(p));
  if (allCovered) mergeable += 1;

  out.push(`\n● ${key}`);
  for (const r of list) {
    out.push(`    style.css:${r.line}  ${String(r.decls.length).padStart(2)} 条声明  ${shown(r.decls)}`);
  }
  out.push(
    `    ↳ 后一次重定义了：${overlap.length ? overlap.join(', ') : '（无重叠 —— 是「补充」不是「覆盖」）'}` +
      (allCovered ? '   ✅ 前一次被完全覆盖，可合并' : '   ⚠️ 前一次还有独有属性，合并要留着')
  );
}

console.log('=== 同一选择器定义了多次（只统计顶层）===');
if (!out.length) {
  console.log('  （无）✓');
} else {
  console.log(out.join('\n'));
}

console.log('');
console.log(`重复定义的选择器：${dupCount} 个（其中「前一次被完全覆盖、可安全合并」的：${mergeable} 个）`);
console.log(`顶层规则总数：${rules.length}`);
