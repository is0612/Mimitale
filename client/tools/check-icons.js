'use strict';

// ============================================================================
//  tools/check-icons.js —— 图标只准从注册表来
//
//  背景（2026-10-19）：图标原本有两个来源 —— ui/icons.js 的注册表（data-icon）
//  和直接手写的 <svg>。后者长着长着就失控了：index.html 里 24 处内联 svg 去重后
//  只有 11 种形状，光「叉号」就抄了 7 遍，注册表里其实早就有 close。
//
//  这个脚本守三件事：
//    ① 界面代码里不许再出现裸 <svg>（注册表自己除外）；
//    ② `data-icon="名字"` 的名字必须真的在注册表里（防手滑打错，那种错
//      不会报错，只是图标默默不显示）；
//    ③ 顺手报一下「注册了但没人用」的图标，方便清理。
//
//  跑法：node tools/check-icons.js        （npm run audit 里也串了这一条）
// ============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const REGISTRY = path.join(RENDERER, 'js', 'ui', 'icons.js');

/**
 * 允许保留裸 <svg> 的地方。
 *
 *  · icons.js 自己就是生成 svg 字符串的；
 *  · preview/ 是组件盘（开发时看样式用的独立页面，不是应用界面）；
 *  · 一颗按钮里要**同时**放两颗图标、由 CSS 切换显隐的（预设编辑器的放大/还原），
 *    data-icon 的「一个元素一颗图标」表达不了，只能留内联 —— 按 class 放行。
 */
const ALLOW_FILES = [REGISTRY, path.join(RENDERER, 'preview')];
const ALLOW_INLINE = [/class="icon-expand"/, /class="icon-restore"/];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (/\.(js|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 从注册表里抠出所有图标名（`ICONS = { ... }` 之间的键） */
function readRegistry() {
  const src = fs.readFileSync(REGISTRY, 'utf8');
  const start = src.indexOf('const ICONS = {');
  const end = src.indexOf('\n};', start);
  const body = src.slice(start, end);
  const names = new Set();
  // 键可能带引号（book-open / zoom-in）也可能裸写（plus / close）
  for (const m of body.matchAll(/^\s{2}'?([A-Za-z][\w-]*)'?:/gm)) names.add(m[1]);
  return names;
}

const registry = readRegistry();
const problems = [];
const used = new Set();

for (const file of walk(RENDERER)) {
  if (ALLOW_FILES.some((allow) => file === allow || file.startsWith(allow + path.sep))) continue;
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, i) => {
    // ① 裸 svg
    if (line.includes('<svg') && !ALLOW_INLINE.some((re) => re.test(line))) {
      problems.push(`${rel}:${i + 1}  手写 <svg> —— 把形状加进 ui/icons.js，这里用 data-icon / iconHtml()`);
    }
    // ② data-icon 的名字
    for (const m of line.matchAll(/data-icon="([^"]*)"/g)) {
      if (!registry.has(m[1])) problems.push(`${rel}:${i + 1}  data-icon="${m[1]}" 不在注册表里`);
      used.add(m[1]);
    }
    for (const m of line.matchAll(/iconHtml\('([^']+)'/g)) {
      if (!registry.has(m[1])) problems.push(`${rel}:${i + 1}  iconHtml('${m[1]}') 不在注册表里`);
      used.add(m[1]);
    }
  });

  // ③ 名字是当参数传的（iconButton(id, 'zoom-in', …) / SECTION_ICONS 那种映射表），
  //    静态解析认不出调用关系，这里退一步：源码里出现过这个字符串就算有人用。
  const source = lines.join('\n');
  for (const name of registry) {
    if (used.has(name)) continue;
    if (source.includes(`'${name}'`) || source.includes(`"${name}"`)) used.add(name);
  }
}

const unused = [...registry].filter((name) => !used.has(name));

console.log('=== 图标检查 ===');
console.log(`注册表：${registry.size} 个图标；界面里用到 ${used.size} 个`);
if (problems.length) {
  console.log('');
  for (const line of problems) console.log('  ✗ ' + line);
  console.log(`\n❌ ${problems.length} 处不合规`);
} else {
  console.log('  ✓ 界面代码里没有裸 <svg>，data-icon 名字都在注册表里');
}
if (unused.length) {
  console.log(`\n· 注册了但没人用（可以删，也可能是别的窗口在用）：${unused.join(', ')}`);
}
process.exitCode = problems.length ? 1 : 0;
