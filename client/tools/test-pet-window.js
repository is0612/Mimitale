'use strict';

// tools/test-pet-window.js —— 桌宠「接线」的静态核对（纯 Node，不起 Electron）；跑法：node tools/test-pet-window.js
// ⚠️ 只读源码、只用 `node --check` 解析（不执行），绝不碰真实 userData（出过覆盖 conversations.json 的事故）

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PET_DIR = path.join(ROOT, 'renderer', 'pet');

let passed = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** ⚠️ 断言「代码里不该出现 X」前必须剥注释：注释解释「我们没做 X」时本身就含 X，断言必然失败 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // [^:] 是为了避开 http:// 里的 ://
}

function destructuredFrom(src, modulePath) {
  const at = src.indexOf(`require('${modulePath}')`);
  if (at < 0) return null;
  const open = src.lastIndexOf('{', at);
  const close = src.lastIndexOf('}', at);
  if (open < 0 || close < 0 || close > at) return null;
  return src
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

/** 只认「一层花括号、逗号分隔的标识符」：写法一变由「至少抠出一个名字」那条断言暴露，不静默失效 */
function exportedNames(src) {
  const at = src.indexOf('module.exports');
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return null;
  return src
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

/** ⚠️ 不能用 process.execPath：在 electron.exe 里跑时它不认 --check，会把每个文件都判成解析失败 */
// 用 --check 而不是 import()：import() 会真执行模块（pet.js 摸 document 必崩），分不清「语法坏了」和「环境跑不起来」
function findNodeForCheck() {
  if (process.env.MIMITALE_NODE) return process.env.MIMITALE_NODE;

  if (!/electron/i.test(path.basename(process.execPath))) return process.execPath;

  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'node.exe'),
    process.env.NODE_EXE,
    'node'
  ].filter(Boolean);

  for (const c of candidates) {
    const probe = spawnSync(c, ['--version'], { encoding: 'utf8' });
    // ⚠️ probe.error = 子进程根本没起来（沙箱直接 EBUSY）：立刻返回 null 表示「查不了」，
    //    别当成「这个候选不好用」挨个试，更别当成「文件有语法错」
    if (probe.error) return null;
    if (probe.status === 0) return c;
  }
  return null;
}

const NODE_FOR_CHECK = findNodeForCheck();

/** ⚠️ ok:true + skipped:true = 没查（子进程起不来）。沙箱禁 spawn 时注入语法错也全绿，结尾必须单独吼一声 */
function syntaxCheck(file) {
  if (!NODE_FOR_CHECK) return { ok: true, skipped: true, detail: '没找到可用的 node' };

  const result = spawnSync(NODE_FOR_CHECK, ['--check', file], { encoding: 'utf8' });

  if (result.error) {
    // 探测阶段起得来、这里起不来 —— 同样不是语法问题，不许赖文件
    return { ok: true, skipped: true, detail: `子进程起不来（${result.error.code}）` };
  }
  if (result.status === 0) return { ok: true, skipped: false, detail: '' };

  const detail = String(result.stderr || '')
    .split('\n')
    .find((line) => /Error|error/.test(line)) || '解析失败';
  return { ok: false, skipped: false, detail: detail.trim() };
}

const petIpcSrc = read('main/pet-ipc.js');
const petWindowSrc = read('main/pet-window.js');
const preloadPetSrc = read('preload-pet.js');
const preloadMainSrc = read('preload.js');
const petContextSrc = read('renderer/js/data/petContext.js');
const petSettingsSrc = read('renderer/js/views/petSettings.js');
const petJs = read('renderer/pet/pet.js');

// ---------------------------------------------------------------------------
section('main/pet-ipc.js ⇄ main/pet-window.js 的导出对得上');

const wanted = destructuredFrom(petIpcSrc, './pet-window.js');
ok(Array.isArray(wanted) && wanted.length > 0, '能在 pet-ipc.js 里找到 pet-window.js 的解构块');

const exported = exportedNames(petWindowSrc);
ok(Array.isArray(exported) && exported.length > 0, '能解析出 pet-window.js 的 module.exports');

if (Array.isArray(wanted) && Array.isArray(exported)) {
  const missing = wanted.filter((name) => !exported.includes(name));
  ok(
    missing.length === 0,
    `pet-ipc.js 解构的每个名字都被导出了${missing.length ? `（缺：${missing.join(', ')}）` : ''}`
  );
  // 回归：漏导出会让 pet:state:get 每次抛 TypeError，宠物页永远拿不到状态
  ok(
    wanted.includes('buildPetStatePayload') && exported.includes('buildPetStatePayload'),
    'buildPetStatePayload 两边都有（pet:state:get 直接调它）'
  );
}

// ---------------------------------------------------------------------------
section('preload-pet.js ⇄ main/pet-ipc.js 的通道对得上');

const channelsFromPreload = [
  ...new Set(
    [...preloadPetSrc.matchAll(/ipcRenderer\.(?:send|invoke)\(\s*'([^']+)'/g)].map((m) => m[1])
  )
];
ok(channelsFromPreload.length > 0, '能从 preload-pet.js 里读出宠物页面用的通道');

for (const channel of channelsFromPreload) {
  const handled =
    petIpcSrc.includes(`ipcMain.handle('${channel}'`) || petIpcSrc.includes(`ipcMain.on('${channel}'`);
  ok(handled, `通道 ${channel} 在主进程注册过 handler`);
}

// 反向：注册了却没人调的宠物通道 = 白注册（名字打错就会这样），也查一遍
const registered = [
  ...new Set(
    [...petIpcSrc.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)]
      .map((m) => m[1])
      .filter((c) => c.startsWith('pet:'))
  )
];
ok(registered.length > 0, '能从 pet-ipc.js 里读出注册过的宠物通道');
for (const channel of registered) {
  // 宠物通道分两处出口：宠物窗口走 preload-pet.js，主界面走 preload.js
  const outlet = channelsFromPreload.includes(channel) || preloadMainSrc.includes(`'${channel}'`);
  ok(outlet, `通道 ${channel} 有出口（宠物窗口或主界面）`);
}

// ---------------------------------------------------------------------------
section('宠物页面的模块能被解析（语法错误会让整页失效）');

const petModules = fs
  .readdirSync(PET_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();
ok(petModules.length > 0, 'renderer/pet 下有可检查的模块');

let syntaxSkipped = 0;
for (const file of petModules) {
  const result = syntaxCheck(path.join(PET_DIR, file));
  ok(result.ok, `${file} 能被解析${result.ok ? '' : `：${result.detail}`}`);
  if (result.skipped) syntaxSkipped += 1;
}

// 一条都查不了 = 这节没生效（环境的错不是代码的错），但不能悄悄混在满屏 ✓ 里
if (syntaxSkipped === petModules.length && petModules.length > 0) {
  console.log(
    `\n  ⚠️⚠️  ${petModules.length} 个模块**一个都没真正检查**（${syntaxCheck(petModules[0]).detail || '子进程起不来'}）` +
      `\n  ⚠️⚠️  上面这一节的 ✓ 是没有意义的 —— 换一个能 spawn 子进程的终端重跑，` +
      `或用 MIMITALE_NODE=<node 绝对路径> 指定。\n`
  );
}

// ---------------------------------------------------------------------------
section('宠物窗口那五个「改了就坏」的窗口参数');

const createSrc = petWindowSrc.slice(
  petWindowSrc.indexOf('function createPetWindow'),
  petWindowSrc.indexOf('function destroyPetWindow')
);
ok(createSrc.length > 0, '能定位到 createPetWindow');

ok(/transparent:\s*true/.test(createSrc), 'transparent:true（关掉会变成白底方板）');
ok(/frame:\s*false/.test(createSrc), 'frame:false（关掉会多一条标题栏）');
ok(/skipTaskbar:\s*true/.test(createSrc), 'skipTaskbar:true（关掉任务栏会多一条）');
ok(/hasShadow:\s*false/.test(createSrc), 'hasShadow:false（关掉会投出一圈方形阴影）');
ok(
  /setAlwaysOnTop\(true,\s*'screen-saver'\)/.test(createSrc),
  "置顶级别是 'screen-saver'（普通 alwaysOnTop 会被别的窗口盖住）"
);
ok(
  /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(createSrc),
  '默认穿透 + 转发移动事件（不做就在桌面上留一块点击死区）'
);
ok(/contextIsolation:\s*true/.test(createSrc), 'contextIsolation:true');
ok(/nodeIntegration:\s*false/.test(createSrc), 'nodeIntegration:false');
ok(/sandbox:\s*true/.test(createSrc), 'sandbox:true（和设计记录一致，别比主窗口更宽松）');
ok(!/sandbox:\s*false/.test(createSrc), 'sandbox 没有被关掉');

// ⚠️ resize 必须节流：同步调 ensureSize 会递归，防抖会被持续的 resize 饿死（= 长按拖动时一直变大）
ok(
  /on\('resize',[\s\S]{0,500}?throttledEnsureSize\(\)/.test(createSrc),
  "窗口 resize 走节流纠尺寸（同步=递归、防抖=被饿死）"
);
ok(
  /function throttledEnsureSize\(\)/.test(petWindowSrc),
  '有 throttledEnsureSize（节流实现）'
);
ok(
  !/setTimeout\(ensureSize,\s*60\)/.test(petWindowSrc),
  '没有退回「防抖 60ms」那个会被持续 resize 饿死的写法'
);
// ⚠️ 挪窗口必须走 movePetWindow（带尺寸的 setContentBounds）：setPosition 之后系统会重算内容区尺寸，
//   拖着拖着就变大；「挪完再 ensureSize 纠回去」= 每帧在两个值之间振荡 = 抖
ok(/function movePetWindow\(x, y\)/.test(petWindowSrc), '有 movePetWindow（带尺寸挪窗口，防漂）');
{
  const dragBlock = (petWindowSrc.match(/dragTimer = setInterval[\s\S]*?\}, 16\);/) || [''])[0];
  ok(/movePetWindow\(/.test(dragBlock), '拖动循环走 movePetWindow');
  ok(!/setPosition\(/.test(dragBlock), '拖动循环里没有 setPosition');
  ok(!/ensureSize\(/.test(dragBlock), '拖动循环里不再事后纠（不「挪完再纠」= 不振荡）');
}
{
  const walkSrc = read('main/pet-walk.js');
  const walkBlock = (walkSrc.match(/walkTimer = setInterval[\s\S]*?\}, STEP_MS\);/) || [''])[0];
  ok(/movePetWindow\(/.test(walkBlock), '散步循环也走 movePetWindow（「散步时越来越大」不许回归）');
  ok(!/setPosition\(/.test(walkBlock), '散步循环里没有 setPosition');
}

// ---------------------------------------------------------------------------
section('「隐藏 = 不说话」这条口径');

ok(/if\s*\(!pet\.visible\)/.test(petContextSrc), 'maybePetAutoSpeak 里有 pet.visible 这道闸门');
// 闸门必须排在轮数计数之前：否则隐藏期间照攒轮数，重新显示时立刻蹦一句
{
  const gateAt = petContextSrc.indexOf('if (!pet.visible)');
  const countAt = petContextSrc.indexOf('turnCounters.set(convo.id, done)');
  ok(gateAt > 0 && countAt > gateAt, 'visible 闸门排在轮数计数之前（隐藏期间不攒轮数）');
}
// 主进程再挡一道：主界面那份缓存可能晚一拍，而这里读的是刚落盘的 config
ok(
  /reason === 'auto' && !pet\.visible/.test(petIpcSrc),
  'speakOnce 对 auto 再挡一道（隐藏时不说话，也不把猫顶出来）'
);
// 缓存必须跟着 pet:changed 刷 —— 右键菜单改配置时设置弹窗通常是关着的
{
  const at = petSettingsSrc.indexOf('api.onPetChanged');
  const block = at < 0 ? '' : petSettingsSrc.slice(at, at + 800);
  ok(
    /refreshPetCache\(\)/.test(block),
    'pet:changed 处理器会刷新缓存（弹窗关着也刷，否则闸门读的是旧值）'
  );
}

// ---------------------------------------------------------------------------
section('生成失败 / 流式兜底不会留下假气泡');

ok(/if \(!saidThisCycle\) hideBubble\(\)/.test(petJs), '生成失败时收掉「嗯…我想想…」占位');
ok(/else hideBubble\(\)/.test(petJs), '空回复也收掉气泡（不留空气泡）');
{
  const at = petJs.indexOf('window.petBridge.onChunk');
  const block = at < 0 ? '' : petJs.slice(at, at + 800);
  // 少了 appendChild，兜底分支里的 firstElementChild 就是 null，增量一个字都不显示
  ok(/bubbleLines\.appendChild\(p\)/.test(block), 'onChunk 兜底分支真的补了占位节点');
}

// ---------------------------------------------------------------------------
section('宠物页面用到的 DOM 节点在 pet.html 里存在');

const petHtml = read('renderer/pet/pet.html');
for (const id of ['sprite-wrap', 'sprite-empty', 'bubble', 'bubble-lines']) {
  const used = new RegExp(`getElementById\\('${id}'\\)`).test(petJs);
  const declared = petHtml.includes(`id="${id}"`);
  ok(used === declared, `#${id} 用得到也声明了（用=${used} 声明=${declared}）`);
}

// 红线：宠物说的话绝不进会话历史（写进去角色下一轮就会「听见」它说话）
ok(
  !/convo\.messages\s*\.\s*push/.test(petContextSrc),
  'petContext.js 不往 convo.messages 里塞东西（宠物的话绝不进会话历史）'
);

// ---------------------------------------------------------------------------
section('气泡：有尾巴、长句不撑破、逐句淡入');

{
  const cssSrc = read('renderer/pet/pet.css');

  ok(/\.bubble::before/.test(cssSrc), '气泡有指向宠物的小尾巴');
  ok(
    /transform:\s*rotate\(45deg\)/.test(cssSrc),
    '尾巴是旋转方块做法（不是两层 CSS 三角，那个放大有锯齿）'
  );
  // 尾巴画在框外，父容器一裁就没了
  ok(/\.bubble\s*\{[^}]*overflow:\s*visible/.test(cssSrc), '气泡不裁剪（否则尾巴被切掉）');
  // 尾巴的实际探出量要声明给 pet.js（旋转方块探出量读不出 bottom 偏移）
  ok(/--tail-overhang/.test(cssSrc), '有 --tail-overhang 给 pet.js 的气泡锚点用');

  {
    const m = cssSrc.match(/\.bubble\s*\{[^}]*border-radius:\s*(\d+)px/);
    ok(m && Number(m[1]) >= 16, '气泡圆角 >= 16px（软，不是对话框那种小圆角）');
  }
  ok(/--bubble-edge/.test(cssSrc), '气泡描边用带主题色的 --bubble-edge（不是纯灰）');
  ok(
    /\.bubble\s*\{[^}]*background:\s*var\(--bubble-bg\)/.test(cssSrc),
    '气泡是纯白底（--bubble-bg），不再用渐变'
  );
  ok(
    !/\.bubble\s*\{[^}]*background:\s*linear-gradient/.test(cssSrc),
    '.bubble 背景没有退回渐变'
  );
  ok(
    /\.bubble\s*\{[^}]*animation:\s*bubble-in[^;]*cubic-bezier\(\s*0\.34\s*,\s*1\.5/,
    '气泡进场带回弹（cubic-bezier 过冲）'
  );
  ok(
    !/\.bubble-line\s*\+\s*\.bubble-line\s*\{[^}]*border-top:\s*1px\s+dashed/.test(cssSrc),
    '句间分隔不再是 dashed 虚线'
  );
  ok(
    /\.bubble-line em\s*\{[^}]*color:\s*var\(--accent\)/.test(cssSrc),
    '动作（em）用主题色，不是灰'
  );
  // 字体优先圆体、且必须有兜底（圆体不是 Windows 自带，没装不能变成方块/报错）
  ok(
    /--bubble-font-family/.test(cssSrc) && /YaHei|微软雅黑/.test(cssSrc),
    '气泡字体优先圆体、但兜底里有雅黑（没装圆体也不能坏）'
  );

  ok(
    /\.bubble-lines\s*\{[^}]*max-height/.test(cssSrc),
    '气泡正文有 max-height（长句在气泡里滚，不撑破）'
  );
  ok(
    /\.bubble-lines\s*\{[^}]*overflow-y:\s*auto/.test(cssSrc),
    '气泡正文能滚（有 max-height 就必须配 overflow-y）'
  );

  ok(/@keyframes line-in/.test(cssSrc), '逐句冒出来有淡入动画');
  ok(
    /\.bubble-line\s*\{[^}]*animation:\s*line-in/.test(cssSrc),
    '.bubble-line 用上了 line-in'
  );

  // 冒到超出可视区时要跟着滚，否则用户以为它只说了一两句
  ok(/bubbleLines\.scrollTop\s*=\s*bubbleLines\.scrollHeight/.test(petJs), '逐句冒出来时跟着滚到底');

  // 气泡尺寸故意不跟 --scale：缩到小档时乘上去会把字缩到读不出来
  ok(
    /\.bubble-line\s*\{[^}]*font-size:\s*var\(--bubble-font\)/.test(cssSrc),
    '气泡字号走 --bubble-font（固定基准，不乘 --scale）'
  );
  ok(
    !/\.bubble-line\s*\{[^}]*font-size:[^;}]*var\(--scale\)/.test(cssSrc),
    '气泡字号没有乘 --scale（缩到 70% 时字还得能看清）'
  );
  ok(
    /\.bubble-lines\s*\{[^}]*max-height:\s*\d+vh/.test(cssSrc),
    '气泡高度上限用 vh（跟着窗口走，不是写死像素）'
  );
  // 35vh 是下限：0.7× 档下再小只放得下 3.8 行，「说三句」会被切掉
  {
    const m = cssSrc.match(/\.bubble-lines\s*\{[^}]*max-height:\s*(\d+)vh/);
    ok(m && Number(m[1]) >= 35, '气泡高度上限 >= 35vh（太小会把最后一句切掉）');
  }
  ok(
    !/\.bubble\s*\{[^}]*padding:[^;}]*var\(--scale\)/.test(cssSrc),
    '气泡内边距不乘 --scale'
  );
  // 滚到底会切半行顶边，无脑吸附末行顶边又会让新说的那句底部出界 —— 两头都要防
  ok(/function scrollToLastLine\s*\(/.test(petJs), '有 scrollToLastLine() 处理行边界');
  ok(
    /scrollToLastLine\(\)/.test(petJs),
    'showLines 走 scrollToLastLine（不是裸的 scrollTop = scrollHeight）'
  );
  ok(
    /lastTop\s*<=\s*max/.test(petJs),
    '吸附前校验「最后一行对上顶边不会超出」（否则保持滚到底）'
  );
  // 流式那条**故意**滚到底 —— 正在写的字在末尾，切末尾比切开头严重
  ok(
    /onChunk[\s\S]*?bubbleLines\.scrollTop\s*=\s*bubbleLines\.scrollHeight/.test(petJs),
    '流式增量仍然滚到底（正在写的字不能被切）'
  );

  // 气泡底边锚定在宠物头顶：钉在窗口顶部的话，一长一短的话会让间隔跟着变
  ok(
    /\.bubble\s*\{[^}]*bottom:\s*var\(--bubble-bottom/.test(cssSrc),
    '气泡是底边锚定（bottom: var(--bubble-bottom)）'
  );
  ok(
    !/\.bubble\s*\{[^}]*top:\s*4px/.test(cssSrc),
    '气泡不再钉死在窗口顶部'
  );
  ok(
    /--bubble-bottom/.test(cssSrc) && /\.bubble\s*\{[^}]*bottom:\s*var\(--bubble-bottom,\s*\d+%/.test(cssSrc),
    '--bubble-bottom 有 % 兜底（掩码读不出时也别跑到窗外）'
  );
  ok(/function syncBubbleAnchor\s*\(/.test(petJs), '有 syncBubbleAnchor() 摆气泡');
  // ⚠️ 框的下沿 ≠ 视觉下沿（尾巴挂在框外往下伸），不补这截尾巴会压在宠物头发上
  ok(
    /function overhangBelowBubble\s*\(/.test(petJs),
    '有 overhangBelowBubble() 量尾巴探出的高度'
  );
  ok(
    /spriteTopInWrap\s*-\s*gap\s*-\s*tailDrop/.test(petJs),
    '摆气泡时把尾巴的外挂高度算进气口（不然尾巴压头发）'
  );
  ok(
    /getComputedStyle\(bubble,\s*'::before'\)/.test(petJs),
    '尾巴外挂高度实测（不是写死常量）'
  );
  ok(
    /spriteTopInWrap/.test(petJs) && /alpha\[base \+ x\]\s*>\s*128/.test(petJs),
    '头顶由掩码实测（实心像素行），不是写死的常数'
  );
  ok(
    /spriteTopInWrap\s*==\s*null/.test(petJs) || /spriteTopInWrap\s*===?\s*null/.test(petJs),
    '读不到头顶时退回 CSS 默认位置（不硬摆）'
  );
  // ⚠️ 防出界按气泡自身高度预留：写死一个小数字会让顶边跑出窗口（实测 -19px）
  ok(
    /bubble\.offsetHeight/.test(petJs),
    '防出界按气泡自身高度预留（不是写死的常数）'
  );
  ok(
    /ResizeObserver/.test(petJs),
    '气泡变高后重新对一次头顶（ResizeObserver）'
  );
}

// ---------------------------------------------------------------------------
section('「形象」下拉这条链路四层都接上了');

// 这条链任何一层漏了都是静默失效（下拉空白 / 切了没反应），所以逐层断言
{
  const petStoreSrc = read('main/pet-store.js');

  ok(/function listRigSkins\s*\(/.test(petStoreSrc), 'pet-store.js 有 listRigSkins()');
  ok(/^\s*listRigSkins,?\s*$/m.test(petStoreSrc), 'pet-store.js 把它导出了');

  // 空目录不能进下拉：选中就是占位框
  ok(
    /statSync\s*\(\s*path\.join\(dir,\s*'model\.json'\)\s*\)/.test(petStoreSrc),
    'listRigSkins 用 model.json 存在与否筛目录（空目录不进下拉）'
  );

  ok(/ipcMain\.handle\(\s*'pet:skins'/.test(petIpcSrc), "pet-ipc.js 注册了 'pet:skins'");
  ok(
    /petSkins:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('pet:skins'\)/.test(preloadMainSrc),
    'preload.js 暴露了 petSkins'
  );
}
{
  const domSrc = read('renderer/js/core/dom.js');
  ok(/skin:\s*\$\('s-pet-skin'\)/.test(domSrc), 'core/dom.js 把 #s-pet-skin 收进了 el.pet');

  const htmlSrc = read('renderer/index.html');
  ok(htmlSrc.includes('id="s-pet-skin"'), 'index.html 里有 #s-pet-skin 下拉');

  // value 必须带 source 前缀 —— assets 和 user 下可能重名，只存 skin 名会切错卡
  ok(
    /value=[`'"][^`'"]*\\u0000/.test(petSettingsSrc) || /source\}\s*\\u0000\s*\$\{/.test(petSettingsSrc),
    '下拉 value 用 source\\0skin 两段拼（避免重名切错卡）'
  );

  // 切形象必须整块换 look，而不是只改 skin —— patchPet 是浅合并
  ok(
    /look:\s*\{\s*kind:\s*'rig'/.test(petSettingsSrc),
    '切换时整块传 look（patchPet 是浅合并，只传 skin 会把 source 丢掉）'
  );
}

// ---------------------------------------------------------------------------
section('缩放入口：设置页滑块 + 右键菜单「大小」');

// 右键菜单 / 设置页滑块 / 落盘三处漏一处就是「点了没反应」
{
  ok(/function scaleSubmenu\s*\(/.test(petIpcSrc), 'pet-ipc.js 有 scaleSubmenu()');
  ok(/label:\s*'大小'/.test(petIpcSrc), '右键菜单里有「大小」这一项');
  // 必须真的走 patchPet 落盘，不能只改内存里的窗口尺寸
  ok(/patchPet\([^)]*\{\s*scale:/.test(petIpcSrc), '改缩放会 patchPet({ scale })（不然重启就丢）');
  ok(/applyScale\(/.test(petIpcSrc), '改完立刻 applyScale，窗口当场跟着变');
}
{
  const domSrc = read('renderer/js/core/dom.js');
  ok(/scale:\s*\$\('s-pet-scale'\)/.test(domSrc), 'core/dom.js 把 #s-pet-scale 收进了 el.pet');

  const htmlSrc = read('renderer/index.html');
  ok(htmlSrc.includes('id="s-pet-scale"'), 'index.html 里有 #s-pet-scale 滑块');
  ok(/id="s-pet-scale"[^>]*type="range"/.test(htmlSrc), '#s-pet-scale 是 range 输入');

  // 拖动中只本地预览、停手才落盘 —— 不防抖的话一次拖动会发几十条 IPC
  ok(/scaleTimer/.test(petSettingsSrc), '滑块改动有防抖（拖动中不逐条发 IPC）');
  ok(/addEventListener\('input'/.test(petSettingsSrc), '滑块绑的是 input（拖动中就有反馈）');
}

// ---------------------------------------------------------------------------
section('默认形象是大肥鱼，且老的 cat 配置会被迁移');

// 配置里存着 'cat' 的老用户必须被迁移，否则升级上来就是一个占位框
{
  const petStoreSrc = read('main/pet-store.js');
  ok(/const DEFAULT_SKIN\s*=\s*'whale'/.test(petStoreSrc), '默认形象常量是 whale');
  ok(/skin:\s*DEFAULT_SKIN/.test(petStoreSrc), 'defaultPet 的 look.skin 用 DEFAULT_SKIN（不是写死的名字）');
  ok(/rawSkin === 'cat'/.test(petStoreSrc), 'normalizeLook 会把老的 cat 迁移掉');
  ok(
    !fs.existsSync(path.join(ROOT, 'assets', 'pet', 'cat')),
    'assets/pet/cat 已经不在了（蓝白猫形象包已移出）'
  );
  ok(
    fs.existsSync(path.join(ROOT, 'assets', 'pet', 'whale', 'model.json')),
    'assets/pet/whale 还在（默认形象得有真资产）'
  );
}

// ---------------------------------------------------------------------------
section('形象包里「靠运行时 alpha 才不显示」的部件不许出现');

// 靠运行时 alpha 才不显示的部件（源模型的站/坐二选一）必须被转换脚本删掉，不是留着让 renderer 关
// 成品 model.json 里出现这些 id = 回归（会和正主重叠）
{
  const converterSrc = read('tools/pet/pipeline/convert_whale.py');

  for (const id of ['skirt_sit', 'waist_bow_sit_front', 'eye_creases']) {
    ok(converterSrc.includes(`"${id}"`), `convert_whale.py 把 ${id} 列进了删除表`);
  }

  // 幂等的前提：必须从 source/ 原始件读，不能从成品读
  ok(
    /SRC_MODEL|model-original\.json/.test(converterSrc) && /SRC\s*=\s*os\.path\.join\(DST,\s*"source"\)/.test(converterSrc),
    'convert_whale.py 从 source/model-original.json 读输入（否则重跑会叠在成品上）'
  );

  const whaleModelPath = path.join(ROOT, 'assets', 'pet', 'whale', 'model.json');
  if (fs.existsSync(whaleModelPath)) {
    let whale = null;
    try {
      whale = JSON.parse(fs.readFileSync(whaleModelPath, 'utf8'));
    } catch (err) {
      ok(false, `whale/model.json 能解析（${err.message}）`);
    }
    if (whale && Array.isArray(whale.parts)) {
      const ids = whale.parts.map((p) => p.id);
      for (const gone of ['skirt_sit', 'waist_bow_sit_front', 'eye_creases']) {
        ok(!ids.includes(gone), `whale 成品里没有 ${gone}（有 = 会和正主重叠）`);
      }
      // 正主还得在（别删过头把站姿裙也删了）
      for (const keep of ['skirt', 'waist_bow_front', 'brows', 'face']) {
        ok(ids.includes(keep), `whale 成品里保留了 ${keep}`);
      }

      // 删了部件忘了删贴图 → 永远加载不到的孤儿文件；转换脚本会清，这里兜一道
      // ⚠️ parts[].tex 在 tex/，feat[].tex 在 feat/ —— 两个目录，别查错
      const texDir = path.join(ROOT, 'assets', 'pet', 'whale', 'tex');
      const featDir = path.join(ROOT, 'assets', 'pet', 'whale', 'feat');
      if (fs.existsSync(texDir) && fs.existsSync(featDir)) {
        const partTex = new Set(whale.parts.map((p) => p.tex));
        const featTex = new Set(Object.values(whale.feat || {}).map((f) => f.tex));

        const orphans = fs.readdirSync(texDir)
          .filter((f) => f.endsWith('.png'))
          .map((f) => f.slice(0, -4))
          .filter((stem) => !partTex.has(stem));
        ok(orphans.length === 0, `whale/tex 没有孤儿贴图${orphans.length ? `（多余：${orphans.join(', ')}）` : ''}`);

        const missingParts = [...partTex].filter((t) => !fs.existsSync(path.join(texDir, `${t}.png`)));
        ok(missingParts.length === 0, `parts 引用的贴图都在 tex/${missingParts.length ? `（缺：${missingParts.join(', ')}）` : ''}`);
        const missingFeat = [...featTex].filter((t) => !fs.existsSync(path.join(featDir, `${t}.png`)));
        ok(missingFeat.length === 0, `feat 引用的贴图都在 feat/${missingFeat.length ? `（缺：${missingFeat.join(', ')}）` : ''}`);
      }

      // ⚠️ feat 的 box[1] 必须是 V(顶边)：取成底边会让整组五官上移一个自身高度（眼睛飘到发际线）
      // 几何兜底：五官竖直范围被脸包住、且眼在上嘴在下
      const face = whale.parts.find((p) => p.id === 'face');
      if (face && face.box && whale.feat) {
        const fLo = face.box[1];
        const fHi = face.box[1] + face.box[3];
        for (const key of Object.keys(whale.feat)) {
          const b = whale.feat[key].box;
          const lo = b[1];
          const hi = b[1] + b[3];
          ok(
            lo >= fLo - 1 && hi <= fHi + 1,
            `feat「${key}」落在脸的竖直范围内（${lo.toFixed(1)}~${hi.toFixed(1)} ⊂ ${fLo.toFixed(1)}~${fHi.toFixed(1)}）`
          );
        }
        // ⚠️ V 向下增长：「更高」= 更小的 V，写反就是 y 轴取错边
        if (whale.feat.eye_open && whale.feat.mouth) {
          const eyeLo = whale.feat.eye_open.box[1];
          const mouthLo = whale.feat.mouth.box[1];
          ok(eyeLo < mouthLo, `眼睛在嘴上方（眼 V=${eyeLo.toFixed(1)} < 嘴 V=${mouthLo.toFixed(1)}，V 越小越靠上）`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
section('空闲手势：只有点头/摇头/招手，没有遗留的「鞠躬」');

// bow 散在三处（挑手势数组 / GESTURE_DUR / 渲染），漏删一处就是「代码里没了、还能做出来」
{
  const catJs = read('renderer/pet/cat.js');
  const figJs = read('renderer/pet/cat-figure.js');

  ok(!/['"]bow['"]/.test(catJs), 'cat.js 里没有 bow 这个手势了');
  ok(!/['"]bow['"]/.test(figJs), 'cat-figure.js 里没有 bow 这个手势了');
  // 时长表也要跟着删：漏删不报错（有 `|| 1` 兜底），只会让手势默默变成 1 秒
  ok(
    !/GESTURE_DUR\s*=\s*\{[^}]*\bbow\b/.test(catJs),
    'GESTURE_DUR 里也删掉了 bow（漏删会被 `|| 1` 悄悄兜住，不报错）'
  );
  // 手势列表只在一处维护：挑的那行只引用变量，别就地写死数组（两边会不同步）
  ok(
    /(IDLE_GESTURES|enabledGestures)\[Math\.floor\(Math\.random\(\)\s*\*\s*(IDLE_GESTURES|enabledGestures)\.length\)\]/.test(catJs),
    '挑手势读的是变量（IDLE_GESTURES / enabledGestures），不是就地写死的数组'
  );
  ok(/const IDLE_GESTURES\s*=\s*\[/.test(catJs), 'cat.js 有 IDLE_GESTURES 常量（全集）');
  // 剩下三个都得在，别删过头
  {
    const m = catJs.match(/const IDLE_GESTURES\s*=\s*\[([^\]]*)\]/);
    const list = m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
    ok(list.length === 3, `IDLE_GESTURES 有 3 个手势（实际 ${list.length}）`);
    for (const k of ['nod', 'shake', 'wave']) {
      ok(list.includes(k), `IDLE_GESTURES 保留了 ${k}`);
    }
  }
  // 每个手势都得有时长，否则播放速度会掉进 `|| 1` 兜底
  {
    const dur = catJs.match(/const GESTURE_DUR\s*=\s*\{([^}]*)\}/);
    const keys = dur ? [...dur[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]) : [];
    ok(keys.length === 3, `GESTURE_DUR 正好 3 项（实际 ${keys.join('/')}）`);
  }
  // `bowing` 那个表情是鞠躬手势的残留（全仓没人把 face 设成它），一并清掉
  ok(!/bowing/.test(figJs), '没有 bowing 这个没人用的遗留表情');
  // waist 这个 deformer **必须留着**（部件靠它挂在骨架上），只是不再给它状态
  ok(
    /waist:\s*\{\s*kind:\s*'rot'/.test(figJs),
    'waist deformer 保留（删了部件会散架）'
  );
  ok(
    !/st\.waist\s*=/.test(figJs),
    '不再给 waist 写状态（没有状态 = 恒等变换，rig.js 的 applyChain 会跳过）'
  );
}

// ---------------------------------------------------------------------------
section('「空闲小动作」开关：设置页 → 主进程 → 宠物窗口这条链路接上了');

// 手势由宠物窗口自己挑、配置却在主进程和设置页：跨两个边界，断一层就是「勾了没反应」且不报错
{
  // ---- 第一层：pet-store 有字段、且缺字段 / 空数组两种情形分开处理 ----
  const storeSrc = read('main/pet-store.js');
  ok(/const KNOWN_GESTURES\s*=\s*\[/.test(storeSrc), 'pet-store 有 KNOWN_GESTURES 常量（全集）');
  ok(/gestureEnabled:\s*\[\.\.\.KNOWN_GESTURES\]/.test(storeSrc), 'defaultPet 里 gestureEnabled 默认全集');
  ok(/gestureEnabled:\s*normalizeGestureList\(/.test(storeSrc), 'normalizePet 会收 gestureEnabled');
  ok(/function normalizeGestureList\s*\(/.test(storeSrc), '有 normalizeGestureList 归一化函数');
  // ⚠️ 空数组必须原样保留：写成 `value || fallback` 会让「三个全取消」被兜回全集
  {
    const fnSrc = storeSrc.match(/function normalizeGestureList[\s\S]*?\n\}/);
    ok(!!fnSrc, '能抠出 normalizeGestureList 的实现');
    if (fnSrc) {
      const KNOWN_GESTURES = ['nod', 'shake', 'wave'];
      const fn = new Function('KNOWN_GESTURES', fnSrc[0] + '; return normalizeGestureList;')(KNOWN_GESTURES);
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      ok(eq(fn(undefined, KNOWN_GESTURES), KNOWN_GESTURES), '缺字段 → 用默认全集（升级上来的不掉功能）');
      ok(eq(fn([], KNOWN_GESTURES), []), '空数组 → 保留成空数组（三个全取消 = 我要它安静待着）');
      ok(eq(fn(['nod', 'wave'], KNOWN_GESTURES), ['nod', 'wave']), '正常勾选原样保留');
      ok(eq(fn(['nod', 'bow'], KNOWN_GESTURES), ['nod']), '丢掉不认识的 id（含已删的 bow）');
      ok(eq(fn(['nod', 'nod'], KNOWN_GESTURES), ['nod']), '去重');
      ok(eq(fn('nod', KNOWN_GESTURES), KNOWN_GESTURES), '不是数组 → 用默认全集');
      // 别把调用方传进来的默认值数组改掉（返回的是新数组）
      const def = ['nod'];
      fn(['wave'], def);
      ok(eq(def, ['nod']), '不修改调用方传入的默认数组（返回新数组）');
    }
  }

  // ---- 第二层：宠物页面把它转给 cat.js；cat.js 按它挑手势 ----
  const petJs = read('renderer/pet/pet.js');
  ok(/catRig\.setGestures\(pet\.gestureEnabled\)/.test(petJs), 'pet.js 把 pet.gestureEnabled 转给 catRig');
  // ⚠️ 这行必须在「rig 缺失就 return」之前：放后面，形象没加载出来时设置永远传不到渲染层
  {
    const gestureLine = petJs.indexOf('catRig.setGestures');
    const rigReturn = petJs.indexOf('if (!rigData || !rigData.model)');
    ok(
      gestureLine > 0 && rigReturn > 0 && gestureLine < rigReturn,
      'setGestures 在「rig 缺失就 return」之前（否则形象缺失时设置传不下去）'
    );
  }

  const catJs = read('renderer/pet/cat.js');
  ok(/function setGestures\s*\(/.test(catJs), 'cat.js 有 setGestures()');
  ok(/setGestures\s*,/.test(catJs), 'setGestures 挂进了 catRig 的导出');
  ok(/let enabledGestures\s*=\s*\[\.\.\.IDLE_GESTURES\]/.test(catJs), 'enabledGestures 默认全集（字段缺失时不缩水）');
  // ⚠️ 断言要落在「真的当条件用」上：只搜 `enabledGestures.length` 的话改成 if (true) 也照样通过
  {
    const code = stripComments(catJs);
    ok(
      /if\s*\(\s*enabledGestures\.length\s*\)/.test(code),
      '挑手势前先判集合非空（空集合 = 不挑，别给它兜一个回去）'
    );
    ok(
      /enabledGestures\[Math\.floor\(Math\.random\(\)/.test(code),
      '挑手势从 enabledGestures 里挑（不是直接从 IDLE_GESTURES）'
    );
    ok(
      /enabledGestures\s*=\s*IDLE_GESTURES\.filter\(/.test(code),
      'setGestures 用 IDLE_GESTURES ∩ 传入列表（不认识的名字进不来）'
    );
  }
  // 关掉动作 ≠ 点它没反应（poked() 不看这个开关）；先剥注释再查，注释里提到这个词会让断言假绿
  {
    const code = stripComments(catJs);
    const poked = code.match(/function poked\s*\(\)\s*\{[\s\S]*?\n\}/);
    ok(!!poked, '能抠出 poked() 的实现');
    ok(
      poked && !/enabledGestures/.test(poked[0]),
      'poked() 不看 enabledGestures（关掉动作 ≠ 点它也没反应）'
    );
  }

  // ---- 第三层：设置页那三个勾存在、且改了就落盘 ----
  const htmlSrc = read('renderer/index.html');
  for (const id of ['s-pet-gesture-nod', 's-pet-gesture-shake', 's-pet-gesture-wave']) {
    ok(htmlSrc.includes(`id="${id}"`), `index.html 有 #${id}`);
  }
  ok(/id="s-pet-gestures-field"/.test(htmlSrc), 'index.html 有 #s-pet-gestures-field 这一组');
  const domSrc = read('renderer/js/core/dom.js');
  for (const key of ['gestureNod', 'gestureShake', 'gestureWave']) {
    ok(new RegExp(`${key}:\\s*\\$\\(`).test(domSrc), `core/dom.js 把 ${key} 收进了 el.pet`);
  }
  ok(/gestureEnabled:\s*enabled/.test(petSettingsSrc), 'petSettings.js 改动会 patchPet({ gestureEnabled })');
  ok(/renderGestures\(\)/.test(petSettingsSrc), 'renderPetSettings 里调了 renderGestures（否则重画时勾会丢）');
  // ⚠️ 三个全不勾是合法状态，别做「至少留一个」兜底；剥注释再查（注释里那句话本身就含这个词）
  ok(
    !/至少[^。\n]{0,6}一个[^。\n]{0,6}(勾|选)/.test(stripComments(petSettingsSrc)),
    '设置页没有「至少留一个」的兜底（那会让用户取消最后一个勾时看着没反应）'
  );
}

// ---------------------------------------------------------------------------
section('散步：只能左右走（不许斜着 / 纵向移动）');

{
  const walkSrc = read('main/pet-walk.js');
  const code = stripComments(walkSrc);

  // ⚠️ 只许左右走：别把纵向分量加回来（「斜一点点好看」也不行）
  ok(!/Math\.sin\(/.test(code), '挑目标点不再用 sin（没有纵向分量）');
  ok(!/Math\.PI\s*\*\s*\d+\s*\/\s*180/.test(code), '不再按角度求点（角度那套已删）');
  ok(
    /target\s*=\s*\{\s*x,\s*y:\s*bounds\.y\s*\}/.test(code),
    '目标 y 锁死当前纵向位置（连 clamp 都不做，免得又飘起来）'
  );
  ok(
    !/dy\s*=/.test(code),
    '代码里不存在 dy —— 有 dy 就说明纵向又回来了'
  );

  ok(/Math\.abs\(dx\)\s*<\s*\d+/.test(code), '按横向位移 dx 判「这一趟值不值得走」');
  ok(/Math\.random\(\)\s*<\s*0\.5\s*\?\s*-1\s*:\s*1/.test(code), '左右方向各半，不偏向一侧');
  ok(
    /sendToPet\('pet:walk',\s*\{\s*walking:\s*true,\s*facing\s*\}\)/.test(code),
    '每趟都发 facing（没有「dx 太小就不发」那套兜底了）'
  );
  ok(!/facing\s*={2,3}\s*null/.test(code), '不再有「朝向可能为 null」的分支');
}

// ---------------------------------------------------------------------------
section('参数口径：尾巴摇动 / 缩放重算，别改回会「抖」的旧值');

{
  const figSrc = read('renderer/pet/cat-figure.js');

  // ⚠️ 尾巴频率 + 弹簧阻尼是「抖」的根因，别调回去；sin() 里是 rad/s，别当 Hz
  // 手感参数抽成了可调常量，所以查「公式用了常量」+「常量取值」，不匹配内联字面量（改数值不算回归）
  ok(
    !/Math\.sin\(t \* \(4 \+ 5 \* wagAmp\)\)/.test(stripComments(figSrc)),
    '尾巴摇动不再用最初的 4 + 5 * wagAmp'
  );
  ok(
    /Math\.sin\(t \* \(TAIL_FREQ \+ TAIL_FREQ_K \* wagAmp\)\)/.test(figSrc),
    '尾巴频率走 TAIL_FREQ + TAIL_FREQ_K * wagAmp 这两个可调常量'
  );
  // 常量本身必须有定义、且在「还能看出在摇」的区间里（别被调到 0 或负数）
  const numOf = (name) => {
    const m = figSrc.match(new RegExp(`const\\s+${name}\\s*=\\s*(-?[\\d.]+)`));
    return m ? parseFloat(m[1]) : NaN;
  };
  const fq = numOf('TAIL_FREQ'), fk = numOf('TAIL_FREQ_K'), sw = numOf('TAIL_SWING');
  ok(Number.isFinite(fq) && fq > 0 && fq < 4, `TAIL_FREQ 在 (0,4) rad/s 内（当前 ${fq}）`);
  ok(Number.isFinite(fk) && fk >= 0 && fk < 4, `TAIL_FREQ_K 在 [0,4) 内（当前 ${fk}）`);
  ok(Number.isFinite(sw) && sw > 2 && sw < 20, `TAIL_SWING 在 (2,20) 度内，摇得出来（当前 ${sw}）`);
  ok(
    /tail:\s*spring\(40,\s*TAIL_DAMP,\s*32\)/.test(figSrc),
    '尾巴弹簧走 TAIL_DAMP 常量（k=40 固定）'
  );
  const dmp = numOf('TAIL_DAMP');
  ok(Number.isFinite(dmp) && dmp >= 8, `TAIL_DAMP ≥ 8，别调回欠阻尼（当前 ${dmp}，ζ≈${(dmp / (2 * Math.sqrt(40))).toFixed(2)}）`);
  ok(/tail \* TAIL_BEND_K \* u \* u/.test(figSrc), 'tailBend 放大系数走 TAIL_BEND_K');
  ok(!/spring\(40,\s*5,/.test(stripComments(figSrc)), '旧的尾巴弹簧 (40,5) 已清掉');

  ok(/Math\.sin\(gk \* Math\.PI \* 4\)/.test(figSrc), '摇头手势改成 π*4（2.5Hz，不再是 7.5Hz 的打摆子）');
  ok(!/Math\.sin\(gk \* Math\.PI \* 6\)/.test(stripComments(figSrc)), '旧的 π*6 摇头已经清掉');

  ok(/function fitCanvas\(force\)/.test(figSrc), 'fitCanvas 支持 force（绕过 8% 容差）');
  ok(/refit\(\)\s*\{\s*fitCanvas\(true\)/.test(figSrc), 'figure 暴露 refit() = 强制重算');

  const catSrc = read('renderer/pet/cat.js');
  ok(
    /refit\(onDrawn\)\s*\{[\s\S]{0,500}figure\.refit\(\)/.test(catSrc),
    'catRig 把 refit 转出去，并支持 onDrawn 回调'
  );
  ok(/\bafterDrawOnce\b/.test(catSrc), 'cat.js 有「下一帧 draw 之后执行一次」的回调机制');

  const petSrc = read('renderer/pet/pet.js');
  /** ⚠️ 掩码重建必须挂在 refit 的「下一帧画完」回调上：fitCanvas 给 canvas.width/height 赋新值会清空
   * WebGL 绘制缓冲，当帧读到的是空白画布 → 掩码全透明 → 鼠标穿透 → 宠物看得见却点不动 */
  const resizeBlock = (petSrc.match(/addEventListener\('resize'[\s\S]{0,400}/) || [''])[0];
  ok(/refitNow\(\)/.test(resizeBlock), 'pet.js 的 resize 回调走 refitNow()');
  ok(
    /dragging[\s\S]{0,60}refitPending/.test(resizeBlock),
    '拖动中只标记待补、不当场重建（拖动中重建画布 = 一直闪）'
  );
  ok(
    /function refitNow\(\)[\s\S]{0,200}catRig\.refit\(rebuildMask\)/.test(petSrc),
    'refitNow 把掩码重建挂在 refit 的「下一帧画完」回调上（当帧读像素只会拿到空白画布）'
  );
  ok(
    !/catRig\.refit\(\)\s*;\s*\n\s*rebuildMask\(\)/.test(petSrc),
    '没有退回「同一帧 refit 完就 rebuildMask」的老写法'
  );
  ok(/if \(!solid && previous\)/.test(petSrc), 'rebuildMask 读到全透明画布时保留旧掩码（兜底）');
  // 拖动攒下的重建要在 mouseup / blur 两条收尾路上都补
  ok(
    (petSrc.match(/if \(refitPending\) requestAnimationFrame\(refitNow\)/g) || []).length === 2,
    'mouseup 和 blur 都补了拖动中攒下的重建'
  );
  // canvas 像素尺寸只在真变了才重设：重设会清空绘制缓冲 → 那一帧是空的 = 闪
  ok(
    /Math\.abs\(canvas\.width - wantPx\) > 1/.test(figSrc),
    'canvas 像素尺寸差 1px 不重设（重设会清空 → 闪）'
  );

  // blur 兜底还要重算穿透状态：少这步会卡在「不穿透」那侧，整块变成点不动的死区
  const blurBlock = (petSrc.match(/addEventListener\('blur'[\s\S]{0,700}/) || [''])[0];
  ok(/setClickThrough\(/.test(blurBlock), 'blur 兜底复位拖动时也重算穿透状态');
  ok(/lastPointer/.test(petSrc), '有 lastPointer 记录，blur 才知道该按哪一点重算');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
} else {
  console.log(`✓ 全部通过：${passed}/${passed}`);
}
process.exit(failures.length ? 1 : 0);
