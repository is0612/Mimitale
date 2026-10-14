'use strict';

// ============================================================================
//  tools/audit-css-dead.js —— 死类名 lint：style.css 里定义、但界面里再也
//  不会出现的类选择器
//
//  为什么要有它：界面反复重构（弹窗改页面、药丸标签改卡片、消息区去气泡），
//  每一次都可能留下「HTML/JS 里的类名改了、CSS 没删」的残渣。这类残渣
//  **不报错、不红测试、也不影响渲染** —— 就是躺在文件里误导下一位：
//  以为那条规则还在管某个元素，改了半天发现根本没有元素匹配它。
//  （本工具立项那天逮到的就是一条：`.provider-row`，服务商切换从
//    `.provider-tab` 改成 `.provider-card` 之后漏删的 2 处残留。）
//
//  五个现有 lint 都盖不到这个方向：
//    check-el-refs 查「JS 用的 el.* 在 DOM 里有没有」，是 JS→DOM；
//    本工具查的是 CSS→DOM：「CSS 写的类，DOM/JS 里还有没有人用」。
//
//  判据（粗筛，删之前人工再 grep 一遍）：
//    类名在引用池（renderer/js/**/*.js + renderer/index.html，含 pet）里
//    **一次都不出现**（子串匹配）→ 候选死规则。
//
//  已知误报，靠下面的豁免名单消化：
//    · 动态拼接的类名（`kind-${item.kind}` 这种），字面量在引用池里必然 0 次；
//    · 「注释里提到、代码里已删」的历史说明不算引用。
//  ⛔ 往 DYNAMIC_OK 加名字前先人工确认它真的是动态拼的 —— 豁免名单是
//    给「活着的动态类名」留的口子，不是给死类名留的后门。
//
//  用法：node tools/audit-css-dead.js       （有候选死类名时退出码 1）
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = path.join(ROOT, 'renderer', 'style.css');

/** 动态拼接的类名 —— 字面量不在任何文件里，但运行时会出现。 */
const DYNAMIC_OK = new Set([
  // petSettings.js：`kind-${item.kind}`，kind 值域钉在 main/pet-store.js 的
  // MEMORY_ITEM_KINDS = ['say', 'event', 'user']
  'kind-say',
  'kind-event',
  'kind-user'
]);

/** 去掉 CSS 注释（注释里提到的类名不算「还在用」，但也不能让注释干扰提取）。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const css = stripComments(fs.readFileSync(CSS, 'utf8'));

// 提取 CSS 里出现过的类名（.foo → foo）。伪类/伪元素前缀都会被 matchAll 摘出来。
const classes = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) classes.add(m[1]);

// 引用池：渲染层全部 JS + HTML（含 pet/，桌宠窗口的类在 petSettings.js 里）。
let refs = '';
for (const f of walk(path.join(ROOT, 'renderer', 'js'))) refs += fs.readFileSync(f, 'utf8') + '\n';
refs += fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

const dead = [];
for (const c of classes) {
  if (DYNAMIC_OK.has(c)) continue;
  if (!refs.includes(c)) dead.push(c);
}

console.log('=== CSS 里有、界面里再也不会出现的类名 ===');
if (dead.length === 0) {
  console.log('  (无) ✓');
  console.log(`\n✅ 死类名 lint 通过（共 ${classes.size} 个类名，豁免动态类名 ${DYNAMIC_OK.size} 个）`);
  process.exit(0);
}

for (const c of dead) {
  // 列出这条类名在 CSS 里的所有出现位置，方便人工确认后删。
  const lines = [];
  css.split('\n').forEach((line, i) => {
    if (line.includes('.' + c)) lines.push(`  style.css:${i + 1}  ${line.trim()}`);
  });
  console.log(`\n  .${c}`);
  console.log(lines.join('\n'));
}
console.log('\n⚠️ 上面是候选死规则（粗筛）。删之前：');
console.log('   1. grep 确认它不是动态拼接的（是的话加进 DYNAMIC_OK）');
console.log('   2. 删完跑一遍 npm run smoke + 出图兜底');
console.log(`\n❌ 死类名 lint：${dead.length} 个候选`);
process.exit(1);
