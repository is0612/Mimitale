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

/** 收集顶层规则。
 *
 *  ⚠️ 2026-10-13 修：**不能只认「选择器独占一行、行尾就是 `{`」的写法**。
 *  本项目里大量小规则是**单行**写的（`.suggest-title { font-size: …; }`、
 *  `.composer-box:focus-within { box-shadow: …; }`），旧版把这些**全漏了** ——
 *  于是 `.suggest-title` / `.suggest-list` / `.composer-box:focus-within` 这几对
 *  「基础段 + 覆盖层」的重复一直没被列出来，报告里那个「12 个」是**偏小**的。
 *  现在改成先扫一遍括号深度，再逐个匹配叶子规则块。
 */
const depthAt = new Int32Array(src.length + 1);
{
  let d = 0;
  for (let i = 0; i < src.length; i += 1) {
    depthAt[i] = d;
    if (src[i] === '{') d += 1;
    else if (src[i] === '}') d -= 1;
  }
  depthAt[src.length] = d;
}

const rules = [];
const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = RULE_RE.exec(src))) {
  const braceAt = m.index + m[1].length;      // 这个规则的 `{` 在原文的位置
  if (depthAt[braceAt] !== 0) continue;        // @media / @keyframes 里面的不算「顶层」
  const rawSel = m[1].trim().replace(/\s+/g, ' ');
  if (!rawSel || rawSel.startsWith('@')) continue;

  const lead = m[1].search(/\S/);
  const selAt = m.index + (lead === -1 ? 0 : lead);
  const decls = m[2].split(';').map((t) => t.trim()).filter(Boolean);
  rules.push({ rawSel, key: normalize(rawSel), line: src.slice(0, selAt).split('\n').length, decls });
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

// ----------------------------------------------------------------------------
// 第二遍：声明级重复 ——「同一组声明，换个选择器前缀又写一遍」。
// 这正是 audit-css-dup 原本查不出来的那种：选择器不同，所以 byKey 把它们分开了；
// 但属性逐字相同（或排序后相同），属于「换皮重抄」，是该合并的对象。
//
// 判据：把每条规则的声明排序去空格做成签名，签名相同的规则聚成一簇，
// 簇里 ≥2 条、且声明 ≥2 条（单声明太容易撞，没意义）才报。
// 排序是为了把 `a;b` 和 `b;a` 认成同一份（写声明顺序不同但效果一样）。
// ----------------------------------------------------------------------------
const sigOf = (decls) =>
  decls
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort()
    .join(' | ');

const bySig = new Map();
for (const r of rules) {
  if (r.decls.length < 2) continue; // 单声明不报，全是噪声
  const sig = sigOf(r.decls);
  if (!bySig.has(sig)) bySig.set(sig, []);
  bySig.get(sig).push(r);
}

const sigClusters = [...bySig.values()].filter((list) => list.length >= 2);
// 按簇大小降序，大的（重复最多）排前面
sigClusters.sort((a, b) => b.length - a.length);

console.log('');
console.log('=== 声明级重复（同一组声明、不同选择器 —— 该合并的候选）===');
if (!sigClusters.length) {
  console.log('  （无）✓');
} else {
  for (const list of sigClusters) {
    const decls = list[0].decls;
    console.log(`\n● ${list.length} 处共用同一组声明（${decls.length} 条）：`);
    console.log(`    ${shown(decls)}`);
    for (const r of list) {
      console.log(`    style.css:${r.line}  ${r.rawSel}`);
    }
  }
}
console.log(`\n声明级重复簇：${sigClusters.length} 个（共 ${sigClusters.reduce((n, l) => n + l.length, 0)} 条规则）`);
