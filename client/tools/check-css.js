'use strict';
// ============================================================================
//  tools/check-css.js —— 样式表体检：重复选择器 + 失效的覆盖规则
//
//  为什么需要它：style.css 是一张手写的大表，同一屏的样式常常分散在好几段里
//  （基础排版一段、响应式一段、后来又补一段覆盖）。写着写着就会出现**同一个
//  选择器在同一个作用域里出现两次** —— 后一条只覆盖前一条的个别属性，剩下的
//  属性是「碰巧继承下来的」。这种半覆盖最难查：改一处没反应，因为真正生效的
//  值在另一段里（2026-10-13 整合角色/世界书编辑样式时就踩到过）。
//
//  跑法： node tools/check-css.js
//  输出「(无)」就是好的；有问题时退出码 1（可以挂进 CI）。
//
//  ⚠️ 只比对「选择器文本完全相同」的情况（含所在 @media 作用域）。选择器不同
//     但碰巧互相覆盖（`.a` 和 `#x .a`）不在这里报 —— 那需要真的算优先级，误报
//     会比漏报更烦人。
// ============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'renderer');
const files = fs.readdirSync(root).filter((n) => n.endsWith('.css')).sort();

/**
 * 把样式表切成「带作用域的规则」。
 * 大括号配对要跳过注释和字符串 —— CSS 里的 content: "}" 会骗过朴素的计数。
 */
function rules(source, scope = '') {
  const out = [];
  let start = 0;
  let open = -1;
  let depth = 0;
  let quote = '';
  let comment = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];
    if (comment) {
      if (c === '*' && n === '/') { comment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '*') { comment = true; i += 1; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') {
      if (depth === 0) open = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const prelude = source.slice(start, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
          out.push(...rules(source.slice(open + 1, i), `${scope}${prelude} `));
        } else if (prelude) {
          out.push({ scope, selector: prelude, index: start });
        }
        start = i + 1;
      }
    }
  }
  return out;
}

let duplicates = 0;
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const seen = new Map();
  const found = [];
  for (const rule of rules(source)) {
    // 一条规则可以写好几个选择器（逗号分隔），每个都算一次出现
    for (const selector of rule.selector.split(',').map((s) => s.replace(/\s+/g, ' ').trim())) {
      if (!selector) continue;
      const key = `${rule.scope}${selector}`;
      if (seen.has(key)) found.push(key);
      else seen.set(key, true);
    }
  }
  console.log(`=== ${file}（${seen.size} 条选择器）===`);
  if (found.length) {
    duplicates += found.length;
    for (const key of found) console.log(`  重复：${key}`);
  } else {
    console.log('  (无)');
  }
}

console.log(duplicates ? `\n共 ${duplicates} 处重复选择器` : '\n(无)');
process.exit(duplicates ? 1 : 0);
