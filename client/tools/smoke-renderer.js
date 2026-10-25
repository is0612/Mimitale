// ============================================================================
//  smoke-renderer.js —— 冒烟测试里「跑在页面里」的那一半
//
//  这份代码会被 tools/smoke-test.js 用 executeJavaScript 注入到真实的
//  renderer/index.html 里执行（外面包了一层 async IIFE）。
//
//  规矩（很重要，别破坏）：
//    · 只允许「点真实按钮 + 读真实 DOM + 调 window.mimitale 这个 preload 桥」
//    · 绝对不要调用 renderer.js 里的内部函数（sendMessage / newCharacter 之类）
//      因为渲染层正在往 ES module 迁移 —— 迁移之后那些函数就不再是全局的了，
//      凡是直接调它们的测试会**当场全部失效**。
//      「点按钮 + 读 DOM」这套写法能扛住整个重构。
//    · 断言「有没有落盘」一律走 window.mimitale.getXxx()，那是唯一可信的持久化视图。
//
//  跑完返回 { results, notes }。
//
//  注意：这个文件**不能单独跑**（下面用了顶层 await），它靠外面那层 async IIFE 包住，
//  所以 `node --check tools/smoke-renderer.js` 会报语法错 —— 那是正常的。
// ============================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const byId = (x) => document.getElementById(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const notes = [];
let currentScenario = '';

/** 记一条断言结果（自动带上当前场景名，报告里好分组） */
function check(name, pass, detail) {
  const full = currentScenario ? `${currentScenario} · ${name}` : name;
  results.push({ name: full, pass: !!pass, detail: pass || detail == null ? '' : String(detail) });
}

/** 轮询等待，超时抛错（比固定 sleep 稳，也比 sleep 快） */
/**
 * 轮询到条件成立，超时就抛（场景会记一条「场景没能跑完」）。
 * ⚠️ `fn` 可以是 async 的，但必须 `await` 它的结果 —— 直接 `ok = fn()` 拿到的是个
 * Promise，永远 truthy，等于「只读一次、不重试」，落盘那类跨 IPC 的条件就会偶尔跑输。
 */
async function waitFor(label, fn, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch (err) {
      /* 元素还没出现，继续等 */
    }
    if (ok) return ok;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时（${timeout}ms）：${label}`);
    await sleep(25);
  }
}

/**
 * 等「当前会话的某个面板字段」在主进程里落成期望值。改状态卡是「渲染层改内存 →
 * IPC → 主进程写文件」，固定 sleep 会偶尔跑输这条异步链，这里轮询到真落盘为止；
 * 等不到不抛错，交给调用方的断言去报。
 */
async function settlePanelValue(name, expected, timeout = 3000) {
  const t0 = Date.now();
  for (;;) {
    const cs = await window.mimitale.getConversations();
    const a = cs.conversations.find((c) => c.id === cs.activeId);
    if (a && a.panel && panelValByName(a.panel, name) === expected) return a;
    if (Date.now() - t0 > timeout) return null;
    await sleep(25);
  }
}

/**
 * 场景筛选（由宿主用 `var SMOKE_FILTER = {...}` 前置注入）。
 * 见 tools/smoke-test.js 顶部那段说明：--only / --skip 只用于迭代自查。
 */
const SCENARIO_FILTER = typeof SMOKE_FILTER === 'undefined' ? { only: [], skip: [] } : SMOKE_FILTER;

function scenarioSelected(name) {
  const only = SCENARIO_FILTER.only || [];
  const skip = SCENARIO_FILTER.skip || [];
  if (only.length && !only.some((k) => name.includes(k))) return false;
  if (skip.some((k) => name.includes(k))) return false;
  return true;
}

/** 每个场景的墙钟耗时（宿主侧报告里打「最慢的几个」） */
const timings = [];
/** 被 --only / --skip 跳过的场景名 */
const skippedScenarios = [];

/**
 * 每个场景独立 try/catch：一个崩了不影响后面的。
 * 开头 / 结尾那两行 [progress] 只在 `--progress` 时由宿主打出来
 * （跑超时时用它分清「卡死」和「只是还没跑完」）。
 */
async function scenario(name, fn) {
  if (!scenarioSelected(name)) {
    skippedScenarios.push(name);
    return;
  }
  currentScenario = name;
  const t0 = Date.now();
  const from = results.length;
  console.log(`[progress] ${results.length} 条断言 | 开始场景：${name}`);
  try {
    await fn();
  } catch (err) {
    check('场景没能跑完', false, (err && err.message) || String(err));
  }
  const ms = Date.now() - t0;
  timings.push({ name, ms, from, to: results.length });
  currentScenario = '';
  console.log(`[progress] ${results.length} 条断言 | 完成场景：${name}（${ms}ms）`);
}

function revealEditorControl(node) {
  if (node.closest('#view-wb-editor')) {
    const panel = node.closest('#wb-panel-characters, #wb-panel-entries');
    if (panel?.hidden) byId(panel.id.replace('wb-panel-', 'wb-tab-'))?.click();
  }
  if (node.closest('#char-form')) {
    const section = node.closest('.char-editor-panel');
    if (section?.hidden) byId(`char-section-tab-${section.dataset.section}`)?.click();
    // 2026-10-16 起五个写作字段**同时可见**，没有「切字段」这一步了
    // （.char-writing-tab / .char-writing-panel 已删，别再找它们）。
    const details = node.closest('details');
    if (details) details.open = true;
  }
}

function click(target) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) throw new Error(`找不到要点的元素：${target}`);
  revealEditorControl(node);
  node.click();
  return node;
}

/**
 * 点顶栏「⋯」菜单里的某一项。
 * 菜单项收在折叠菜单里，直接对着隐藏元素 click() 其实也能触发 ——
 * 但那样就绕开了「菜单到底打不打的开」这件事。这里老老实实先点开、再点项，
 * 顺手验一下点完会收起。
 */
async function clickMoreItem(sel) {
  const menu = byId('topbar-more');
  if (!menu) throw new Error('顶栏没有「⋯」菜单');
  if (menu.classList.contains('hidden')) {
    click('#btn-more');
    await waitFor('「⋯」菜单展开', () => !menu.classList.contains('hidden'));
  }
  click(sel);
  await waitFor('「⋯」菜单点完收起', () => menu.classList.contains('hidden'));
}

/**
 * 展开消息工具条末尾那颗「⋯」，让收起来的低频按钮（复制 / 重新生成 / 配图 / 分支 / 删除）显形。
 *
 * 和 clickMoreItem 同一个道理：这些按钮**一直在 DOM 里**（`.mini-extra` 只是
 * `display:none`），直接对着它们 click() 也能触发 —— 但那样就绕开了
 * 「⋯ 到底打不打得开」这件事；而 .open 挂不上去的时候，用户是真点不到那些按钮的。
 */
async function openMsgMore(node) {
  const actions = node && node.querySelector('.msg-actions');
  if (!actions) throw new Error('这条消息上没有工具条');
  const more = actions.querySelector('.mini-more');
  if (!more) throw new Error('这条消息的工具条上没有「⋯」');
  if (!actions.classList.contains('open')) {
    more.click();
    await waitFor('消息工具条展开', () => actions.classList.contains('open'));
  }
  return actions;
}

/**
 * 点角色卡上的「聊天」，并把「你是谁」那一步走完。
 *
 * 开聊前会先弹这个窗（和「进世界」共用同一个），不填就是默认的「你」；
 * 传 opts.name / opts.profile 可以顺手把身份填上。
 */
async function startChatWith(card, opts = {}) {
  click(buttonByText(card, '聊天'));
  await waitFor('「你是谁」弹窗打开', () => shown('#player-modal'));
  if (opts.name) setValue('#player-name', opts.name);
  if (opts.profile) setValue('#player-profile', opts.profile);
  click('#btn-start-play');

  // 卡上带**多条**开场白时会先弹「选一条开场白」等着（worldPlay 的
  // applyCharacterChoice 里 await 着它）。只有一条的卡不会弹 —— 那时候
  // 下面这个循环会因为身份弹窗已经关掉而立刻退出，一轮都不空转。
  for (let i = 0; i < 20 && shown('#player-modal') && !shown('#pick-modal'); i += 1) await sleep(25);
  if (shown('#pick-modal')) {
    const rows = $$('#pick-list .pick-item');
    const idx = Math.min(Math.max(Number(opts.greeting) || 0, 0), Math.max(rows.length - 1, 0));
    if (rows[idx]) rows[idx].click();
    await waitFor('「选一条开场白」关掉', () => !shown('#pick-modal'));
  }

  await waitFor('「你是谁」弹窗关掉', () => !shown('#player-modal'));
}

/** 当前激活的那条会话（读的是落盘数据；落盘是异步的，要轮询时用这个） */
const activeConvo = async () => {
  const cs = await window.mimitale.getConversations();
  return (cs.conversations || []).find((c) => c.id === cs.activeId);
};

/**
 * 拿到「里层那颗原生控件」：组件（`<m-select>` / `<m-input>` / `<m-textarea>`）
 * 返回 `node.control`，别的元素原样返回。
 *
 * 为什么需要它：组件把原生控件包了一层，**外观长在里层那颗上**（宿主管布局）。
 * 断言「它是下拉 / 圆角是多少 / 字号多少」时若直接量宿主，迁移之后会**假红**
 * （红的是断言，坏的却是测试自己）。`.value` / `.options` / `.disabled` 由组件代理，
 * 不用包；只有"看标签 / 量外观"的断言需要过一道。
 */
function asControl(node) {
  return node && typeof node.tagName === 'string' && node.tagName.startsWith('M-') && node.control ? node.control : node;
}

/** 事件目标是"下拉"（原生或组件）—— 派发 change 时用 */
function isDropdown(node) {
  return !!node && (node.tagName === 'SELECT' || node.tagName === 'M-SELECT');
}

function setValue(target, value) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) throw new Error(`找不到输入框：${target}`);
  revealEditorControl(node);
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  // 下拉框在真实浏览器里会同时触发 input 和 change，这里补齐 ——
  // 否则「换服务商 → 模型下拉跟着重填」这类只监听 change 的行为就测不到
  // （组件 m-select 也要算进来：它内部的宿主 .value 是代理，change 得自己派）
  if (isDropdown(node)) node.dispatchEvent(new Event('change', { bubbles: true }));
  return node;
}

/**
 * 勾选/取消勾选一个 checkbox。
 *
 * 不能用 setValue：checkbox 的状态在 .checked 上，.value 设了也没用；
 * 而且它只派发 input 事件，而这类开关监听的是 change。
 */
function setChecked(target, checked) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) throw new Error(`找不到勾选框：${target}`);
  revealEditorControl(node);
  node.checked = !!checked;
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return node;
}

/**
 * 给下拉补一个 option 再选中它。
 *
 * 直接用 setValue 选一个「下拉里还没有的值」是不行的 ——
 * 浏览器会把 select.value 静默变成空串，测试就会以为选上了，实际没选。
 * 这里显式补 option，确保真的选中。
 */
function addAndSelect(select, value) {
  const node = typeof select === 'string' ? $(select) : select;
  if (!node) throw new Error(`找不到下拉：${select}`);
  if (!Array.from(node.options).some((o) => o.value === value)) {
    node.appendChild(new Option(value, value));
  }
  node.value = value;
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return node;
}

/** 按按钮上的文字找按钮（卡片上的「编辑」「聊天」「游玩」都是这么找的） */
function buttonByText(root, text) {
  if (!root) return null;
  return Array.from(root.querySelectorAll('button')).find((b) => b.textContent.trim() === text) || null;
}

/** 元素存在而且没有 .hidden */
function shown(sel) {
  const node = $(sel);
  return !!node && !node.classList.contains('hidden');
}

/**
 * 打开某本世界书的编辑器。
 *
 * 世界书没有独立入口了：只能从角色的「自带世界书」进。这里开一张**草稿**角色
 * （不保存、不落盘，不给角色卡加卡）、绑上目标书，再点行上的「编辑」。
 * ⚠️ 每次调用都会换一张新草稿 —— 上一次的草稿没有改动提示，直接覆盖不会弹框。
 */
async function openWorldbookEditor(bookName) {
  click('#btn-chars');
  await waitFor('切到角色卡', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('打开角色编辑器', () => shown('#view-char-editor'));
  click('#char-section-tab-worldbook');
  await waitFor('切到世界书分区', () => !byId('char-section-worldbook').hidden);

  click('#c-wb-add-btn');
  await waitFor('绑定浮层出现', () => !!$('.cwb-picker'));
  const row = $$('.cwb-picker-row').find((r) => r.textContent.includes(bookName));
  if (!row) throw new Error(`绑定浮层里没有「${bookName}」`);
  click(row);
  await waitFor('绑定完成', () => $$('#c-wb-list .cwb-row').some((r) => r.textContent.includes(bookName)));

  const line = $$('#c-wb-list .cwb-row').find((r) => r.textContent.includes(bookName));
  click(buttonByText(line, '编辑'));
  await waitFor('世界书弹窗打开', () => shown('#view-wb-editor'));
}

/**
 * 造一张**已保存**的角色卡并绑上一本书，返回角色名。
 * 世界书没有列表页之后，卡封面那颗「进入世界」是唯一的进世界入口。
 */
async function createCharBoundTo(bookName, charName) {
  click('#btn-chars');
  await waitFor('切到角色卡', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('打开角色编辑器', () => shown('#view-char-editor'));
  setValue('#c-name', charName);

  click('#char-section-tab-worldbook');
  await waitFor('切到世界书分区', () => !byId('char-section-worldbook').hidden);
  click('#c-wb-add-btn');
  await waitFor('绑定浮层出现', () => !!$('.cwb-picker'));
  const row = $$('.cwb-picker-row').find((r) => r.textContent.includes(bookName));
  if (!row) throw new Error(`绑定浮层里没有「${bookName}」`);
  click(row);
  await waitFor('绑定完成', () => $$('#c-wb-list .cwb-row').some((r) => r.textContent.includes(bookName)));

  click('#btn-save-char');
  await waitFor('角色保存完成', () => byId('char-save-state').dataset.state === 'saved');
  click('#btn-close-chars');
  await waitFor('回到角色卡', () => shown('#view-chars'));
}

async function savedCharacters() {
  const res = await window.mimitale.getCharacters();
  return (res && res.characters) || [];
}
async function savedWorldbooks() {
  const res = await window.mimitale.getWorldbooks();
  return (res && res.worldbooks) || [];
}

// 面板字段的键现在是「字段名\u0000owner」复合键（见 data/panel.js），
// 但测试断言要按「字段名」读值/定义。这两个辅助按字段名在对象里找。
function panelValByName(panel, name) {
  if (!panel || typeof panel !== 'object') return undefined;
  for (const key of Object.keys(panel)) {
    if (key === name || key.startsWith(`${name}\u0000`)) return panel[key];
  }
  return undefined;
}
function panelDefByName(defs, name) {
  if (!defs || typeof defs !== 'object') return null;
  for (const key of Object.keys(defs)) {
    if (key === name || key.startsWith(`${name}\u0000`)) return defs[key];
  }
  return null;
}

// ---------------------------------------------------------------------------
//  进设置页的**唯一**入口。
//  设置只给登录用户：未登录时界面上没有那颗齿轮，唯一可达的是账号菜单里的「设置」
//  —— 菜单收着（hidden），click() 照样能触发，和以前点隐藏齿轮同一个手法：
//  这里测的是设置页本身，不是入口权限。
//  ⚠️ 菜单那一项落到「用户信息」组，而绝大多场景按第 1 组（模型服务）写断言，
//     所以进来后统一点回模型组。
// ---------------------------------------------------------------------------
async function openSettingsPage() {
  click('#btn-account-open-settings');
  await waitFor('切到设置页', () => shown('#view-settings'));
  click('.settings-nav-item[data-target="sec-models"]');
  await waitFor('停在模型服务组', () => shown('#sec-models'));
}

// ---------------------------------------------------------------------------
//  外观：2026-10-12 深夜从**顶栏弹窗**（#appearance-modal）搬进了
//  设置 → 外观（视图六的 #sec-appearance）。
//  下面两个小工具把「怎么进去 / 怎么出来」封起来 —— 走的是**真实用户路径**：
//  账号菜单里的「设置」→ 点左栏「外观」；出来就点页头的「返回」。
//  ⚠️ 别再写成 click('#btn-appearance')：那颗按钮已经不存在了。
// ---------------------------------------------------------------------------
async function openAppearanceSection() {
  await openSettingsPage();
  await waitFor('切到设置页', () => shown('#view-settings'));
  click('.settings-nav-item[data-target="sec-appearance"]');
  await waitFor('切到外观那一组', () => shown('#sec-appearance'));
}
async function leaveAppearanceSection() {
  // ⚠️ 离开之前先把分组**复位到第 1 组**：currentSectionId 是「本次运行内记得住」
  // （不落盘），而后面「设置页」那个场景断言「默认停在第 1 组」——
  // 不复位的话它会停在「外观」，那两条断言就假红了（2026-10-12 深夜踩过）。
  click('.settings-nav-item[data-target="sec-models"]');
  click('#btn-back-settings');
  await waitFor('离开设置页', () => !shown('#view-settings'));
}

// ---------------------------------------------------------------------------
//  场景 1：启动
// ---------------------------------------------------------------------------
await scenario('启动', async () => {
  await waitFor('主界面渲染出会话列表', () => $$('#convo-list .convo-item').length > 0);
  check('主界面已渲染', !!$('#messages') && !!$('#input') && !!$('#btn-send'));
  check('没有掉进「启动失败」兜底页', !document.body.textContent.includes('启动失败'));
  check('没有会话时自动建了一个会话', $$('#convo-list .convo-item').length === 1);
});

// ---------------------------------------------------------------------------
//  场景 2：明暗切换（顺带验证 settings 落盘）
//  控件在 设置 → 外观 里（2026-10-08 之前是左上角一颗「点一下切一下」的图标，
//  并进「外观」之后换成「白天 / 夜间」两颗 —— 点哪个是哪个，不再是盲切；
//  2026-10-12 深夜整块从顶栏弹窗搬进设置页，控件本身没变）。
// ---------------------------------------------------------------------------
await scenario('明暗切换', async () => {
  await openAppearanceSection();

  const modeBtn = (m) => $(`#appearance-modes [data-mode="${m}"]`);
  const before = document.documentElement.getAttribute('data-theme');
  const target = before === 'dark' ? 'light' : 'dark';

  click(`#appearance-modes [data-mode="${target}"]`);
  await waitFor('data-theme 变化', () => document.documentElement.getAttribute('data-theme') === target);
  check('data-theme 切过去了', document.documentElement.getAttribute('data-theme') === target, `${before} → ${target}`);
  check('选中的那颗标成 aria-checked', modeBtn(target).getAttribute('aria-checked') === 'true');
  check('另一颗没标', modeBtn(before).getAttribute('aria-checked') === 'false');

  await sleep(150);
  const settings = (await window.mimitale.getSettings()).settings;
  check('主题已落盘', settings.theme === target, `落盘的是 ${settings.theme}`);

  // 切回去，别影响后面的场景
  click(`#appearance-modes [data-mode="${before}"]`);
  await waitFor('主题切回', () => document.documentElement.getAttribute('data-theme') === before);
  check('切回后 aria-checked 也跟着换', modeBtn(before).getAttribute('aria-checked') === 'true');

  await leaveAppearanceSection();
});

// ---------------------------------------------------------------------------
//  场景 2b：主题配色（配色只剩琥珀一套：色点唯一、属性与变量一致）
//  原来是四套色点循环切换，2026-10-15 删了粉/蓝/绿三套，只留琥珀。
// ---------------------------------------------------------------------------
await scenario('主题配色', async () => {
  await openAppearanceSection();

  const swatch = (a) => $(`#appearance-accents [data-accent="${a}"]`);
  check('只剩琥珀一个色点', !!swatch('amber') && !swatch('pink') && !swatch('blue') && !swatch('matcha'));

  const readAttr = () => document.documentElement.getAttribute('data-accent');
  check('当前配色是琥珀', readAttr() === 'amber', `实际是 ${readAttr()}`);
  check('琥珀色点标了 aria-checked', swatch('amber').getAttribute('aria-checked') === 'true');

  await leaveAppearanceSection();
});

// ---------------------------------------------------------------------------
//  场景 2c：顶栏「⋯」菜单（记忆 / 复制全文 / 导出 / 纯对话视图 / 请求记录 / 清空对话）
//  收起来是为了给标题让地方。这里只验「装了哪几项、能开、能关、点项会收起」——
//  各项功能本身在别的场景里另有覆盖，不在这里重复。
// ---------------------------------------------------------------------------
await scenario('顶栏「⋯」菜单', async () => {
  const menu = byId('topbar-more');
  check('默认是收起的', menu.classList.contains('hidden'));

  click('#btn-more');
  await waitFor('菜单展开', () => !menu.classList.contains('hidden'));
  check('点一下展开', !menu.classList.contains('hidden'));
  check('按钮标成 aria-expanded=true', byId('btn-more').getAttribute('aria-expanded') === 'true');
  // 按 DOM 顺序把 id 全列出来比一次：以前这里只数「四项」，后来菜单里加了
  // 「纯对话视图」和「请求记录」，没人改它 —— 数字对不上时那句话说不清是多了谁、
  // 少了谁。列名字的写法既守「有没有变」，也顺带把顺序钉住。
  const menuIds = $$('#topbar-more .menu-item')
    .map((b) => b.id)
    .join(', ');
  check(
    '菜单里的项目齐全、顺序没变',
    // 2026-10-12 深夜：「记忆」从这份菜单**提到顶栏**了（星宝：「把记忆放出来」），
    // 所以它不再出现在这里 —— 顶栏那颗 #btn-memory 由下面那条断言守。
    menuIds === 'btn-copy-all, btn-export-convo, btn-request-log, btn-clear',
    menuIds
  );

  // 「记忆」现在和「⋯」平级，是顶栏那一排里的一颗图标按钮
  check(
    '记忆按钮已经提到顶栏（不在「⋯」里）',
    !!byId('btn-memory') && !!byId('btn-memory').closest('.topbar-actions'),
    byId('btn-memory') ? (byId('btn-memory').closest('.topbar-actions') ? '在顶栏' : '不在顶栏') : '（没有这颗按钮）'
  );

  // 点别处收起
  click('#messages');
  await waitFor('点别处收起', () => menu.classList.contains('hidden'));
  check('点到别处会收起', menu.classList.contains('hidden'));

  // Esc 收起
  click('#btn-more');
  await waitFor('菜单重新展开', () => !menu.classList.contains('hidden'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 收起', () => menu.classList.contains('hidden'));
  check('按 Esc 也会收起', menu.classList.contains('hidden'));
  check('Esc 后焦点回到菜单入口', document.activeElement === byId('btn-more'));

  const menuKey = (key) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  menuKey('ArrowDown');
  check('方向键打开菜单并聚焦首项', document.activeElement === byId('btn-copy-all'));
  menuKey('ArrowUp');
  check('向上从首项循环到末项', document.activeElement === byId('btn-clear'));
  menuKey('Home');
  check('Home 回到首项', document.activeElement === byId('btn-copy-all'));
  menuKey('End');
  check('End 到达末项', document.activeElement === byId('btn-clear'));
  byId('input').focus();
  byId('input').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  check('焦点离开菜单时自动收起', menu.classList.contains('hidden'));
  click('#btn-more');
  byId('btn-more').focus();
  click('#btn-more');
  check('再次点击入口能收起菜单', menu.classList.contains('hidden'));

  // 点某一项：动作照走 + 菜单收起（复制全文最轻，不会开弹窗打扰后面的场景）
  click('#btn-more');
  await waitFor('菜单再展开', () => !menu.classList.contains('hidden'));
  click('#btn-copy-all');
  await waitFor('点完收起', () => menu.classList.contains('hidden'));
  check('点了菜单项会收起', menu.classList.contains('hidden'));
});

// ---------------------------------------------------------------------------
//  场景 2d：顶栏「切换模型」
//
//  以前这里是原生 <select>。它的**下拉列表由系统画**（直角、系统蓝高亮、系统字体），
//  CSS 完全碰不到 —— 跟自绘弹层这套观感根本不搭，所以换成自绘弹层
//  （views/chatList.js 铺内容 + ui/modelMenu.js 管开合）。
//
//  这里钉三件事：① 它不再是原生 select；② 分组 / 当前项标得出来；
//  ③ 观感（不描边、圆角、阴影）—— 这几条 DOM 全对也可能错，
//  所以必须是**计算样式断言**（同一招用在状态卡那次体检里，翻过车）。
// ---------------------------------------------------------------------------
await scenario('顶栏：切换模型', async () => {
  const cs = (node, prop) => getComputedStyle(node)[prop];
  const trigger = byId('model-switch');
  const menu = byId('model-menu');

  check('顶栏那颗是按钮，不再是原生下拉', trigger.tagName === 'BUTTON', trigger.tagName);
  check(
    '按钮上写着当前模型',
    byId('model-switch-label').textContent === 'test-model',
    byId('model-switch-label').textContent
  );
  check('弹层默认是收起的', menu.classList.contains('hidden'));

  // --- 扁平化体检：靠阴影浮起来，不描边 ---
  check('切换模型按钮不描边（靠阴影分层）', cs(trigger, 'borderTopWidth') === '0px', cs(trigger, 'borderTopWidth'));
  check('模型按钮保持轻量无阴影', cs(trigger, 'boxShadow') === 'none', cs(trigger, 'boxShadow'));

  // --- 展开 ---
  click(trigger);
  await waitFor('模型弹层展开', () => !menu.classList.contains('hidden'));
  check('点一下展开', !menu.classList.contains('hidden'));
  check('按钮标成 aria-expanded=true', trigger.getAttribute('aria-expanded') === 'true');

  // --- 按服务商分组 ---
  const groups = $$('#model-menu .model-menu-group');
  check('列表按服务商分了组', groups.length === 3, `${groups.length} 组`);
  check(
    '分组标题就是服务商名',
    groups.map((g) => g.textContent).join('|') === '冒烟测试服务商|冒烟测试生图|冒烟测试向量',
    groups.map((g) => g.textContent).join('|')
  );
  // 分组小标题不画分隔线（扁平化第 2 条）—— 一屏十几行会变成一张表格
  check(
    '分组小标题不画分隔线',
    groups.length > 0 && cs(groups[0], 'borderBottomWidth') === '0px',
    cs(groups[0], 'borderBottomWidth')
  );

  const items = $$('#model-menu .model-menu-item');
  check('三家的模型都列上了', items.length === 3, `${items.length} 项`);
  check(
    '每一项都带完整模型名（长了也能看全）',
    items.length > 0 && items.every((b) => !!b.title && b.textContent.includes(b.title)),
    JSON.stringify(items.map((b) => b.title))
  );

  // --- 当前那一项 ---
  const active = $$('#model-menu .model-menu-item.is-active');
  check('当前用的那项标了出来，而且只有一个', active.length === 1, `${active.length} 项`);
  check('当前项 aria-checked=true', active.length === 1 && active[0].getAttribute('aria-checked') === 'true');
  check(
    '当前项就是这个会话在用的模型',
    active.length === 1 && active[0].dataset.value === 'p-test::test-model',
    active.length ? active[0].dataset.value : ''
  );

  // 勾那块位置**每行都占着**（没选中的只是透明）—— 少了它，选中那行的文字会比别人短一截
  const ticks = $$('#model-menu .model-menu-item .model-menu-check');
  check(
    '每行都留了勾的位置（选中行文字不会短一截）',
    ticks.length === items.length && ticks.every((s) => s.getBoundingClientRect().width > 0),
    ticks.map((s) => Math.round(s.getBoundingClientRect().width)).join(',')
  );

  // 弹层自己的观感：圆角 + 阴影，不是系统菜单那种直角。
  // 2026-10-12：整体圆角从 16px 压到 4px 级（酒馆式工具感），门槛跟着下调 ——
  // 这条断言的本意是「排除系统菜单那种直角」，不是钉死「大圆角」这个尺寸。
  check(
    '弹层是自绘的：有小圆角 + 阴影（不是系统菜单的样子）',
    parseFloat(cs(menu, 'borderTopLeftRadius')) >= 2 && cs(menu, 'boxShadow') !== 'none',
    `${cs(menu, 'borderTopLeftRadius')} / ${cs(menu, 'boxShadow')}`
  );

  // 弹层不能被浮动的状态卡压住：
  // .state-cards 是**整列大小**（inset:0），层级只要比顶栏高，就能把顶栏连同
  // 上面的弹层一起盖掉 —— 模型弹层比「⋯」宽得多，一压就少半截。
  check(
    '顶栏层级高过浮动状态卡（弹层不会被卡盖住）',
    Number(cs($('.topbar'), 'zIndex')) > Number(cs(byId('state-cards'), 'zIndex')),
    `顶栏 ${cs($('.topbar'), 'zIndex')} / 浮动卡 ${cs(byId('state-cards'), 'zIndex')}`
  );

  // --- 点别处 / Esc 收起 ---
  click('#messages');
  await waitFor('点别处收起模型弹层', () => menu.classList.contains('hidden'));
  check('点到别处会收起', menu.classList.contains('hidden'));

  click(trigger);
  await waitFor('模型弹层重新展开', () => !menu.classList.contains('hidden'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 收起模型弹层', () => menu.classList.contains('hidden'));
  check('按 Esc 也会收起', menu.classList.contains('hidden'));

  // --- 在按钮上按上下键就能打开（原生 select 的肌肉记忆）---
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await waitFor('上下键也能打开', () => !menu.classList.contains('hidden'));
  check('在按钮上按 ↓ 也能打开', !menu.classList.contains('hidden'));

  // --- 挑一个别的模型：按钮上的字 + 勾都要跟着走 ---
  click($$('#model-menu .model-menu-item').find((b) => b.dataset.value === 'p-emb::emb-model-x'));
  await waitFor('按钮上的字换了', () => byId('model-switch-label').textContent === 'emb-model-x');
  check('选完按钮上写的是新模型', byId('model-switch-label').textContent === 'emb-model-x');
  check('选完弹层自己收起（不用再点一下）', byId('model-menu').classList.contains('hidden'));
  // 弹层整块重铺过了，刚才抓的节点全部作废 —— 重新查
  const moved = $$('#model-menu .model-menu-item.is-active');
  check(
    '勾跟着搬到新选的那项',
    moved.length === 1 && moved[0].dataset.value === 'p-emb::emb-model-x',
    moved.length ? moved[0].dataset.value : '没找到'
  );

  // 选中就落盘（异步一次 IPC，轮询到写进去为止，别用固定 sleep 赌）
  let stored = null;
  for (let i = 0; i < 40; i++) {
    const cfg = await window.mimitale.getSettings();
    if (cfg.settings.activeModel === 'emb-model-x') { stored = cfg.settings; break; }
    await sleep(25);
  }
  check(
    '选完落盘成了新会话的默认模型',
    !!stored && stored.activeProviderId === 'p-emb' && stored.activeModel === 'emb-model-x',
    stored ? `${stored.activeProviderId}/${stored.activeModel}` : '没落盘'
  );

  // --- 收拾现场：切回原来的服务商 / 模型，别影响后面的场景 ---
  click(byId('model-switch'));
  await waitFor('模型弹层再开一次', () => !byId('model-menu').classList.contains('hidden'));
  click($$('#model-menu .model-menu-item').find((b) => b.dataset.value === 'p-test::test-model'));
  await waitFor('切回测试服务商', () => byId('model-switch-label').textContent === 'test-model');
  check('能切回原来那家', byId('model-switch-label').textContent === 'test-model');
});

// ---------------------------------------------------------------------------
//  场景 3：设置页
// ---------------------------------------------------------------------------
await scenario('设置页', async () => {
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));
  check('设置是一个视图、不是弹窗', !!$('#view-settings') && !$('#settings-modal'));
  check('设置页有页头和「返回 / 保存」两颗按钮', !!$('#view-settings .page-head') && !!byId('btn-back-settings') && !!byId('btn-save-settings'));

  // 2026-10-16：设置域 22 颗 .btn 全换 <m-button>（页头 2 + 本地数据 1 + 模型 5 +
  // 外观 4 + 桌宠 10）。除了结构，重点盯两件组件化之后最容易悄悄坏掉的事：
  //   ① 「测试中… / 获取中…」那条链路是 `btn.disabled = true` + `btn.textContent = …`
  //      直接设属性 —— 宿主上写坏了不报错，只是按钮不禁用、文案不变；
  //   ② btn-folder 的 `data-icon`：applyFieldIcons 把 svg 插进来时必须落到**里层**，
  //      否则图标会出现在按钮底色方块的外面。
  // ⚠️ btn-back-settings（返回）2026-10-19 挪到页头左上角并改成图标按钮，
  //    图标按钮按约定不套 m-button，所以从这张表里去掉（剩 21 颗）。
  const settingsBtnIds = ['btn-save-settings','btn-folder','btn-add-provider','btn-fetch-models','btn-del-provider','btn-test','btn-assistant-persona','btn-boldcolor-reset','btn-pick-bg','btn-default-bg','btn-clear-bg','btn-pet-visible','btn-pet-mute','btn-pet-speak','btn-pet-persona-reset','btn-pet-preview','btn-pet-say','btn-pet-memory-refresh','btn-pet-memory-export','btn-pet-memory-reset','btn-pet-memory-clear'];
  const notMButton = settingsBtnIds.filter((id) => byId(id)?.tagName !== 'M-BUTTON');
  check('设置域 21 颗按钮都是 m-button 宿主', notMButton.length === 0, notMButton.join(', ') || '全部是');
  // ⚠️ #panel-box（各弹窗的容器）嵌在 #view-settings 里、这批还没迁，
  //     所以「没有原生 .btn」要把 panel-box 排除掉再数。
  check('设置域不再有原生 .btn 按钮（弹窗容器 panel-box 除外）',
    ![...document.querySelectorAll('#view-settings .btn')].some((b) => !b.closest('#panel-box')));
  const folderCtrl = byId('btn-folder').control;
  check(
    'btn-folder 的图标落在了里层控件里',
    !!folderCtrl && !!folderCtrl.querySelector(':scope > svg.field-icon'),
    folderCtrl ? folderCtrl.innerHTML.slice(0, 60) : '(没有里层)'
  );
  check('禁用的桌宠按钮里层也带着 disabled', byId('btn-pet-say').control.disabled === true);
  await waitFor('桌宠形象列表加载', () => byId('s-pet-skin').value === 'assets\u0000whale');
  check('桌宠形象列表包含当前鲸鱼而非空列表兜底',
    Array.from(byId('s-pet-skin').options).some((option) => option.value === 'assets\u0000whale' && option.textContent === '鲸鱼'));
  check('桌宠形象提示能识别当前内置形象', byId('s-pet-skin-hint').textContent.includes('当前形象：whale'));
  const testBtn = byId('btn-test');
  testBtn.textContent = '测试中…';
  testBtn.disabled = true;
  check('改宿主 textContent / disabled 落到里层（「测试中…」那条链路）',
    testBtn.control.textContent === '测试中…' && testBtn.control.disabled === true,
    `文案=${testBtn.control.textContent} disabled=${testBtn.control.disabled}`);
  testBtn.textContent = '测试当前模型提供商';
  testBtn.disabled = false;
  check('还原后里层一并还原', testBtn.control.textContent === '测试当前模型提供商' && testBtn.control.disabled === false);

  // 大版块是**左导航 + 右内容**（2026-10-10）。这里是整套冒烟里第一次打开设置，
  // 所以正好验默认那一条：默认选中第一组「模型服务」、其余组收着。
  const visible = (node) => !!node && node.offsetParent !== null;
  check('左栏有一条分组导航', !!$('#view-settings .settings-nav'));
  check('默认选中第一组「模型服务」', byId('sec-models').classList.contains('active') || !!$('.settings-nav-item[data-target="sec-models"].active'));
  check('第一组的内容显示着', visible(byId('sec-models')) && visible(byId('p-baseurl')));
  check('其余组默认不显示', !visible(byId('sec-behavior')));

  // 打开设置**不再**把光标塞进输入框。以前服务商填过 Key 就 el.s.temp.focus()，
  // 而 <input type="number"> 一获得焦点就整段选中 —— 第一眼看到「温度 0.7」
  // 被高亮成一块，像是自己改了什么。
  const focused = document.activeElement;
  check(
    '打开设置时焦点不在任何输入框里',
    !focused || focused.tagName !== 'INPUT',
    focused ? `${focused.tagName}#${focused.id}` : 'null'
  );

  // 「对话轮数」2026-10-07 从 core/config.js 写死的 CONFIG.MAX_TURNS 挪到设置里。
  // 白名单断言只能证明「这个键在 DEFAULT_SETTINGS 里」，证不了「表单读得到、写得出」——
  // readSettingsForm 里漏一行就正好卡在中间，所以这里真存一次。
  check('行为一节里有「对话轮数」', !!byId('s-max-turns'));
  const turnsBefore = byId('s-max-turns').value;
  check('「对话轮数」回填了默认的 20', turnsBefore === '20', turnsBefore);

  setValue('#s-max-turns', '42');
  click('#btn-save-settings');
  await waitFor('设置已保存', () => !shown('#view-settings'));
  await sleep(150);
  const turnsSaved = ((await window.mimitale.getSettings()).settings || {}).maxTurns;
  check('改「对话轮数」能落盘', turnsSaved === 42, String(turnsSaved));

  // 改回去 —— 后面好几个场景都依赖默认的 20 轮
  await openSettingsPage();
  await waitFor('设置页再开', () => shown('#view-settings'));
  setValue('#s-max-turns', turnsBefore || '20');
  click('#btn-save-settings');
  await waitFor('设置已还原', () => !shown('#view-settings'));
  await sleep(150);
  const turnsBack = ((await window.mimitale.getSettings()).settings || {}).maxTurns;
  check('「对话轮数」还原成 20（后面的场景还等着它）', turnsBack === 20, String(turnsBack));
});

// ---------------------------------------------------------------------------
//  场景 3.5：设置的大版块是「左导航 + 右内容」
//
//  设置项越加越多，一列铺下来要滚很久。改成「左栏切组、右栏只显示一组」之后
//  要守住四件事：
//   ① 点左栏能切组（一次只显示一组，别的组是真看不见）；
//   ② 换组**不能让表单失效** —— 没显示的那一组里的值照样读得到、存得住；
//   ③ 关掉再打开，落在「用户信息」组（入口是账号菜单那一项，不记上次翻到哪）；
//   ④ 分组名 old 接口 expandSettingsSection(id) 仍能指定切到某一组。
// ---------------------------------------------------------------------------
await scenario('设置：左导航切组', async () => {
  const visible = (node) => !!node && node.offsetParent !== null;
  const beforeTokens = String(((await window.mimitale.getSettings()).settings || {}).maxTokens ?? 8192);

  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));

  const paramsNav = $('.settings-nav-item[data-target="sec-params"]');
  const modelsNav = $('.settings-nav-item[data-target="sec-models"]');
  check('左栏有「生成参数」这一项', !!paramsNav);

  // 切到「生成参数」
  click(paramsNav);
  check('点左栏就切组', byId('sec-params').classList.contains('active') || paramsNav.classList.contains('active'));
  check('切到的这一组内容显示', visible(byId('sec-params')) && visible(byId('s-temp')));
  const thinkingBefore = byId('s-thinking').checked;
  byId('s-thinking').checked = !thinkingBefore;
  byId('s-thinking').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  check('设置页深度思考可以独立保存', (await window.mimitale.getSettings()).settings.thinking === !thinkingBefore);
  byId('s-thinking').checked = thinkingBefore;
  byId('s-thinking').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(180);
  check('原来那一组（模型服务）收起来', !visible(byId('p-baseurl')));

  // 没显示的那一组里的值照样存得住（切组只是 display:none，不该让表单失效）
  setValue('#s-maxtokens', '2048');
  click('#btn-save-settings');
  await waitFor('设置已保存', () => !shown('#view-settings'));
  await sleep(150);
  const saved = ((await window.mimitale.getSettings()).settings || {});
  check('没显示的那一组里的值照样落盘', Number(saved.maxTokens) === 2048, String(saved.maxTokens));

  // 关掉再打开：入口只有账号菜单那一项，它固定落到「用户信息」组
  // （这一屏记「上次翻到哪组」的老约定随齿轮一起没了）
  click('#btn-account-open-settings');
  await waitFor('设置页再开', () => shown('#view-settings'));
  check(
    '重开落在用户信息组（账号菜单固定落这里）',
    visible(byId('sec-user')) && !visible(byId('sec-params')),
    `user=${visible(byId('sec-user'))} params=${visible(byId('sec-params'))}`
  );

  const supportNav = $('#view-settings .settings-nav .settings-nav-item[data-target="sec-support"]');
  check('本地数据入口在设置导航中', !!supportNav && visible(supportNav));
  click(supportNav);
  check('点击后显示本地数据分组', visible(byId('sec-support')));
  check('数据按钮实际可见', visible(byId('btn-folder')));

  // 收尾：把回复上限放回去（这个场景用了一个和初值不同的数字来证明「真存住了」）
  if (!visible(byId('sec-params'))) click(paramsNav);
  setValue('#s-maxtokens', beforeTokens);
  click('#btn-save-settings');
  await waitFor('回复上限已还原', () => !shown('#view-settings'));
});

// ---------------------------------------------------------------------------
//  场景 3.6：设置是**页面**，不是弹窗（2026-10-09 从弹窗搬过来）
//
//  从弹窗变成一屏之后，多出来三件必须守住的事：
//   ① 进设置时侧栏那几颗入口要灭掉 —— 页面才有「我现在在哪一屏」这件事；
//   ② 保存 / 返回 / Esc 都回到**进来之前那一屏**（弹窗时代是「关掉弹窗」，语义没变）；
//   ③ 进来之前不一定是聊天 —— 从角色卡进来就得回角色卡，别写死。
// ---------------------------------------------------------------------------
await scenario('设置：是页面，来去都记得从哪来', async () => {
  const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  // --- 从「角色卡」进去 ---
  click('#btn-chars');
  await waitFor('切到角色卡', () => shown('#view-chars'));
  await openSettingsPage();
  await waitFor('切到设置页', () => shown('#view-settings'));
  check('设置页是真的把别的视图藏起来（不是盖一层浮层）', !shown('#view-chat') && !shown('#view-chars'));
  check(
    '设置没有侧栏按钮要点亮（角色卡那颗灭着）',
    !byId('btn-settings') && !byId('btn-chars').classList.contains('active')
  );

  // --- 「返回」原路回角色卡 ---
  click('#btn-back-settings');
  await waitFor('返回角色卡', () => shown('#view-chars'));
  check('返回回到进来之前那一屏（角色卡），不是硬回聊天', shown('#view-chars') && !shown('#view-settings'));

  // --- Esc 是同一个动作 ---
  await openSettingsPage();
  await waitFor('再进设置页', () => shown('#view-settings'));
  esc();
  await waitFor('Esc 离开设置页', () => !shown('#view-settings'));
  check('在设置页按 Esc = 返回上一屏', shown('#view-chars'));

  // --- 从聊天进去 → 保存后回聊天 ---
  // 点**当前这条会话**（带 active 那个）切回聊天：换个会话会让 activeId 变，
  // 后面好几个场景都按原来那条算，别在这儿把它换掉。
  click($('#convo-list .convo-item.active') || $('#convo-list .convo-item'));
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await openSettingsPage();
  await waitFor('从聊天进设置', () => shown('#view-settings'));
  click('#btn-save-settings');
  await waitFor('保存后离开设置页', () => !shown('#view-settings'));
  check('保存后回到聊天（进来之前那一屏）', shown('#view-chat'));
});

// ---------------------------------------------------------------------------
//  场景 4：角色卡 —— 新建必须「保存后才生成」
// ---------------------------------------------------------------------------
await scenario('角色卡：新建角色', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  check('角色卡一开始是空的', shown('#char-page-empty'));
  // 空状态自己就是「去导入 / 去新建」的提示，末尾不再补一张添加卡（重复）
  check('空列表不给「添加」卡', !$('#char-page-grid .lib-add-card'));

  const before = (await savedCharacters()).length;

  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  check('标题是「新建角色」', byId('chars-title').textContent === '新建角色', byId('chars-title').textContent);
  check('保存前列表里没有多出卡片', $$('#char-page-grid .char-card').length === before);
  check('保存前「删除角色」是禁用的', byId('btn-del-char').disabled === true);

  // 关键断言：这一刻磁盘上不该有它
  const mid = (await savedCharacters()).length;
  check('保存前没有落盘', mid === before, `期望 ${before}，实际 ${mid}`);

  setValue('#c-name', '冒烟测试角色');
  setValue('#c-desc', '这是冒烟测试写进去的描述');
  setValue('#c-tags', '测试分类, 治愈');
  click('#btn-save-char');

  await waitFor('角色卡片出现', () => $$('#char-page-grid .char-card').length === before + 1);

  const saved = await savedCharacters();
  check('保存后落盘了一个角色', saved.length === before + 1, `实际 ${saved.length}`);
  const last = saved[saved.length - 1] || {};
  check('落盘的角色名正确', last.name === '冒烟测试角色', `落盘的是「${last.name}」`);
  check('落盘的描述正确', last.description === '这是冒烟测试写进去的描述', `落盘的是「${last.description}」`);

  // --- 网格末尾那张「添加角色」卡（2026-10-20）---
  // 有卡片之后才出现：翻到最后一张卡就能直接加，不用再回屏幕右上角。
  const charAdd = $('#char-page-grid .lib-add-card');
  check('有卡片之后末尾出现「添加角色」卡', !!charAdd);
  check('添加卡不算进卡片数量（故意不挂 .char-card）',
    !!charAdd && !charAdd.classList.contains('char-card') &&
    $$('#char-page-grid > *').length === $$('#char-page-grid .char-card').length + 1,
    `网格子节点 ${$$('#char-page-grid > *').length} 个 / 卡片 ${$$('#char-page-grid .char-card').length} 张`);
  check('添加卡是网格最后一项', !!charAdd && $('#char-page-grid').lastElementChild === charAdd);
  const charAddText = charAdd ? [...charAdd.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' / ') : '';
  check('添加卡里是「导入角色卡 / AI 生成 / ＋ 新建角色」三颗',
    charAddText === '导入角色卡 / AI 生成 / ＋ 新建角色', charAddText);

  // 加号和那三颗按钮得是**一组**、整组在卡里居中。
  // ⚠️ 这条守的是观感不是结构：原来加号占满上半截、按钮靠 `margin-top: auto` 钉在底部，
  //    同一行里有真卡时这张会被拉得很高，中间空一大块、上下两头各挂一样东西 ——
  //    元素都在、数量也对，只有看图（或量数字）才知道它「生硬」。
  const addGeom = (() => {
    if (!charAdd) return null;
    const box = charAdd.getBoundingClientRect();
    const plus = charAdd.querySelector('.lib-add-plus');
    const buttons = [...charAdd.querySelectorAll('.lib-add-actions m-button')];
    if (!plus || !buttons.length) return null;
    const p = plus.getBoundingClientRect();
    const last = buttons[buttons.length - 1].getBoundingClientRect();
    return {
      gap: Math.round(buttons[0].getBoundingClientRect().top - p.bottom),
      top: Math.round(p.top - box.top),
      bottom: Math.round(box.bottom - last.bottom),
      height: Math.round(box.height)
    };
  })();
  check(
    '添加卡：加号和按钮是一组、整组居中',
    !!addGeom && addGeom.gap <= 24 && Math.abs(addGeom.top - addGeom.bottom) <= 16,
    addGeom ? `上留 ${addGeom.top} / 下留 ${addGeom.bottom} / 加号到按钮 ${addGeom.gap} / 卡高 ${addGeom.height}` : '量不出来'
  );
  // 新建的角色保存完就完事了：弹窗自己关掉，回到角色列表看新卡
  check('保存后弹窗自己关掉（不用再点一次关闭）', !shown('#view-char-editor'));
  check('保存后没有多问一句「放弃新建？」', !shown('#confirm-modal'));

  const card = $$('#char-page-grid .char-card')[0];
  check(
    '卡片上有「编辑 / 导出 / 聊天」三个入口',
    !!buttonByText(card, '编辑') && !!buttonByText(card, '导出') && !!buttonByText(card, '聊天')
  );
  check(
    '卡片的「导出」不用进详情页就能点',
    !!buttonByText(card, '导出') && !shown('#view-char-editor')
  );

  // 标签是「这张卡属于什么类型」，得让人在列表页就看得见，否则分类没意义
  const subText = card.querySelector('.char-card-sub').textContent;
  check('卡片上显示了分类标签', subText.includes('测试分类') && subText.includes('治愈'), subText);
  check('卡片上仍然标着来源', subText.includes('手写'), subText);
});

// ---------------------------------------------------------------------------
//  场景 5：角色卡 —— 放弃新建不能留下东西
// ---------------------------------------------------------------------------
await scenario('角色卡：放弃新建', async () => {
  const before = (await savedCharacters()).length;
  const cardsBefore = $$('#char-page-grid .char-card').length;

  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', '半途而废');

  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  check('确认框里带了刚输入的名字', byId('confirm-message').textContent.includes('半途而废'), byId('confirm-message').textContent);
  check('确认框默认聚焦取消', asControl(document.activeElement) === asControl(byId('confirm-cancel')));
  const confirmKey = (key, shiftKey = false) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  confirmKey('Tab', true);
  check('Shift+Tab 循环到确认', asControl(document.activeElement) === asControl(byId('confirm-ok')));
  confirmKey('Tab');
  check('Tab 循环回取消', asControl(document.activeElement) === asControl(byId('confirm-cancel')));
  byId('c-name').focus();
  byId('c-name').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  check('确认框打开时焦点不会进入背景', asControl(document.activeElement) === asControl(byId('confirm-cancel')));
  confirmKey('Enter');
  await waitFor('回车取消确认', () => !shown('#confirm-modal'));
  check('取消后编辑内容保留', shown('#view-char-editor') && byId('c-name').value === '半途而废');
  click('#btn-close-chars');
  await waitFor('再次弹出放弃确认框', () => shown('#confirm-modal'));
  confirmKey('Escape');
  check('Esc 只关闭确认框', !shown('#confirm-modal') && shown('#view-char-editor'));
  click('#btn-close-chars');
  await waitFor('最后弹出放弃确认框', () => shown('#confirm-modal'));

  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#view-char-editor'));
  await sleep(150);

  const after = (await savedCharacters()).length;
  check('放弃后没有新增角色', after === before, `期望 ${before}，实际 ${after}`);
  check('放弃后卡片数量不变', $$('#char-page-grid .char-card').length === cardsBefore);
});

// ---------------------------------------------------------------------------
//  场景 5.5：角色编辑器 —— 五个写作框的高度
//
//  2026-10-16（V2 重组版）之后，这里守的已经不是「自动增高」而是**反过来**的一件事：
//    · 高度由**字段**决定，不由内容决定 —— 每格在 style.css 里按字段写了 min-height
//      （`#c-desc { min-height: 200px }` 那五行）。五栏同屏，表单总长必须是常数，
//      多写几十行不能把下面的字段顶到屏幕外。
//    · 短内容不许把框压塌（塌成一行就没法写东西了）。
//    · 装不下的内容走**框内**滚动。
//    · 手动拖过之后，输入不该把它拽回去。
//
//  ⚠️ 高度靠 getBoundingClientRect 读 —— 那是布局完成后的实高，
//     比读 style.height 可信（style 里可能写着值但被别的规则压回去）。
// ---------------------------------------------------------------------------
await scenario('按钮组件化：角色编辑器的静态按钮', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  // 2026-10-16：这一页 14 颗 .btn 全换 <m-button>。除结构外盯两件容易悄悄坏掉的：
  //   ① 左栏底部那几颗要铺满栏宽 —— width 挂宿主、里层跟着撑满，
  //      写反了不报错、只是按钮缩成一行文字那么宽；
  //   ② 三颗「清除」带着 hidden 类 —— 宿主上 `.hidden` 的 display:none !important
  //      必须照样压过 m-button 自己的 display（不然按钮删不掉地常驻）。
  // ⚠️ btn-close-chars（返回）2026-10-19 从右上角挪到了左上角，并改成**图标按钮** ——
  //    图标按钮按约定不套 m-button（见 components/button.js 文件头），所以从这张表里去掉。
  //    2026-10-20：那颗「导出」撤了（改到角色卡卡片上），左栏底部换成「返回」+「AI 补充」。
  const CHAR_BTN_IDS = ['btn-save-char','btn-clear-avatar','btn-clear-portrait','btn-first-template','btn-alt-add','btn-attr-template','btn-add-attr','btn-attr-paste','btn-attr-paste-apply','c-wb-add-btn','btn-back-char','btn-ai-fill-char','btn-del-char'];
  const bad = CHAR_BTN_IDS.filter((id) => byId(id)?.tagName !== 'M-BUTTON');
  check('角色编辑器 13 颗按钮都是 m-button 宿主', bad.length === 0, bad.join(', ') || '全部是');

  // 返回按钮应当在**标题那一块**里（左上），而不是右侧的操作簇里 ——
  // 只要有人把它挪回 .page-actions，这条就红。
  const backBtn = byId('btn-close-chars');
  check(
    '返回按钮在页头左上（贴标题，不在右上操作簇）',
    !!backBtn && !!backBtn.closest('.page-heading') && !backBtn.closest('.page-actions'),
    backBtn ? (backBtn.closest('.page-heading') ? '在标题区' : '不在标题区') : '按钮不存在'
  );
  // ⚠️ 这里**仍不能**断言「页面里没有 .btn」：属性面板那几颗**图标按钮**
  //    （attr-tab / attr-tab-edit / attr-more-btn / panel-del 等）是 JS 用
  //    `button({ class: ... })` 现渲染的（不带 variant 就不生成 .btn 底座，见
  //    ui/build.js 文件头那条「图标按钮不套组件」的边界）。「解散这一组」已迁
  //    m-button —— 它不再带 `.btn-danger`，断言里按 `#c-attr-group-edit m-button` 找。
  //
  // 左栏底部四行，顺序是固定的：保存 → 返回 → AI 补充 → 删除。
  // ⚠️ 这条替掉的是原来那句「左栏底部不再重复返回」：2026-10-20 星宝要求把返回补回来
  //    （改完一屏手还停在栏底，回页头左上太远），所以「不重复」这条规矩反过来了 ——
  //    现在要守的是**顺序**和「导出真的撤干净了」。
  const railIds = $$('#char-rail-foot m-button').map((node) => node.id);
  check(
    '左栏底部四行：保存 → 返回 → AI 补充 → 删除',
    railIds.join(' → ') === 'btn-save-char → btn-back-char → btn-ai-fill-char → btn-del-char',
    railIds.join(' → ')
  );
  check('编辑器里不再有「导出」（改到角色卡卡片上）', !byId('btn-export-char'));
  const railSave = byId('btn-save-char');
  check(
    '「保存角色」铺满左栏栏宽',
    !!railSave && railSave.getBoundingClientRect().width > 150,
    railSave ? String(Math.round(railSave.getBoundingClientRect().width)) : '按钮不存在'
  );
  check('「清除」的 hidden 照样生效', byId('btn-clear-avatar').classList.contains('hidden') && getComputedStyle(byId('btn-clear-avatar')).display === 'none');
});

await scenario('角色编辑器：五个写作框的高度', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const desc = byId('c-desc');
  const example = byId('c-example');
  check('五个长文本框都在表单里', !!desc && !!example);

  // --- 圆角体检（2026-10-12 晚补）---
  //  ⚠️ 为什么非有不可：`--radius` 从 16px 压到 4px 那轮，**62 处写死的圆角没跟着动**
  //  （弹窗卡片 16、服务商卡 14、属性行 7、消息工具条 6……），
  //  而**整套冒烟在扫前扫后都是全绿** —— 一条断言都没守圆角。
  //  这里钉几个「一眼能看见的面」：计算样式必须等于 token，不是等于某个字面数字。
  //  ⚠️ 取样点 2026-10-13 换过一次：角色编辑器从弹窗改成了页面，那张
  //     `.modal-card` 已经不存在，改用编辑器里的「属性」卡片（同样一眼能看见、
  //     同样必须读 token）。
  {
    const root = getComputedStyle(document.documentElement);
    const R = root.getPropertyValue('--radius').trim();
    const RSM = root.getPropertyValue('--radius-sm').trim();
    const radiusOf = (sel) => {
      // ⚙ 组件化之后圆角长在**里层那颗原生控件**上（宿主只是布局盒），
      // 所以要过一道 asControl() —— 直接量宿主只会得到 0px（假红）
      const node = asControl($(sel));
      return node ? getComputedStyle(node).borderTopLeftRadius : '(没有)';
    };
    check('编辑器里的卡片圆角 = --radius（不是写死的 16）', radiusOf('.char-form .attr-panel') === R, `${radiusOf('.char-form .attr-panel')} vs ${R}`);
    check('通用输入框圆角 = --radius-sm', radiusOf('#c-name') === RSM, radiusOf('#c-name'));
  }

  // ⚙ 组件化（2026-10-16）：多行框的**高**长在里层那颗原生框上（宿主管布局），
  //    量宿主会得到「宿主盒子的高」：没有地板、也不滚动 —— 三条断言一起假红。
  // ⚙ 缺口（2026-10-16 迁多行框时挖出来的）：
  //    `label[for]` 的「点标签 = 聚焦那个控件」**只对原生可标记元素成立**
  //    （button/input/meter/output/progress/select/textarea），组件是自定义元素 ——
  //    实测 `label.control === null`，点标签什么都不会发生。组件库因此在 document
  //    上挂了一条捕获段监听把这个行为补回来，这里钉住它别再掉。
  {
    const label = $('label.char-sheet-label[for="c-desc"]');
    check('写作字段的标签是 label[for]（点标题聚焦输入框）', !!label);
    if (label) label.click();
    await sleep(40);
    check(
      '点「角色描述」标签，焦点落到里层那颗原生框',
      document.activeElement === asControl(desc),
      document.activeElement ? document.activeElement.tagName : '(无)'
    );
  }

  const hOf = (node) => Math.round(asControl(node).getBoundingClientRect().height);

  // 内容少：高度应当停在「下限」附近
  setValue(desc, '一行字');
  await sleep(80);
  const hShort = hOf(desc);
  desc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  check('普通点击写作框不会误判为手动拖高', desc.dataset.growLocked !== '1');

  // 2026-10-16（V2 重组版）：字段不再靠胶囊切换，五栏同时在场。
  // 断言方向跟着反过来了 —— 原来测「只显示当前字段」，现在测「全都在」。
  // ⚠️ 这里不能用 shown()：它只看 .hidden 类，而分区面板用的是 hidden **属性**，
  //    面板藏起来时它的子元素照样会通过 shown()。用 getClientRects() 才作数。
  const WRITING_IDS = ['c-desc', 'c-personality', 'c-scenario', 'c-first', 'c-example'];
  const visible = (id) => (byId(id)?.getClientRects().length || 0) > 0;
  check('五个写作字段同时可见', WRITING_IDS.every(visible),
    WRITING_IDS.filter((id) => !visible(id)).join(','));
  check('写作区不再有字段切换胶囊', !$('#char-writing-tabs') && !$('.char-writing-tab'));
  check('右栏字段目录列出五栏', $$('#char-field-index .field-index-item').length === 5);
  check('字段目录高亮当前栏', !!$('#char-field-index .field-index-item[aria-current="true"]'));
  check('字段目录的已写圆点跟着内容走',
    $('#char-field-index .field-index-item[data-key="desc"] .field-index-dot')?.dataset.filled === 'true');
  const writingBadge = byId('char-section-tab-writing')?.querySelector('.char-section-count');
  check('角色设定徽章是「已写 / 共」，不再是恒定值',
    /^\d+\/5$/.test(writingBadge?.textContent || ''), writingBadge?.textContent);
  check('五个写作框高度各不相同（按字段分别给定）',
    new Set(WRITING_IDS.map((id) => hOf(byId(id)))).size > 1,
    WRITING_IDS.map((id) => hOf(byId(id))).join('/'));

  click('#char-section-tab-state');
  check('属性独立分区不影响写作草稿', shown('#char-section-state') && desc.value === '一行字');
  click('#char-section-tab-writing');
  check('切回写作分区保留未保存输入', desc.value === '一行字' && shown('#c-desc'));

  // 内容多：把**描述**填满 —— 它那格的地板是 200px，比 GROW_MAX(160) 高，
  // 所以它是完全刚性的：塞多少行都不动高度，多出来的在框内滚。
  // （地板低于 160 的格子会在地板和 160 之间随内容浮动，那是有意的宽松度。）
  const floorOf = (id) => Math.round(parseFloat(getComputedStyle(asControl(byId(id))).minHeight) || 0);
  setValue(desc, Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 行的内容`).join('\n'));
  await sleep(200);
  const hDescLong = hOf(desc);

  check(
    '写作框高度由字段决定，等于自己那格的 CSS 地板',
    Math.abs(hShort - floorOf('c-desc')) <= 2,
    `desc 实际 ${hShort}px / CSS 地板 ${floorOf('c-desc')}px`
  );
  check(
    '短内容不会把写作框压塌（保留足够编辑空间）',
    hShort >= 180,
    `实际 ${hShort}px`
  );
  check(
    '填满几十行也不会把框顶高（表单总长恒定，五栏才敢同屏）',
    Math.abs(hDescLong - hShort) <= 2,
    `长内容 ${hDescLong}px vs 短内容 ${hShort}px`
  );
  check(
    '超上限的内容走框内滚动（表单总长恒定）',
    // 「滚的是框自己」：量里层那颗原生框（宿主不滚）
    asControl(desc).scrollHeight > asControl(desc).clientHeight + 10,
    `scrollHeight ${asControl(desc).scrollHeight} vs clientHeight ${asControl(desc).clientHeight}`
  );

  // 手动拖过之后就锁定：再输入内容也不该被自动改回去。
  // 模拟「用户拖拽结束」——直接改高度再派发 mouseup（这是唯一能观察到的信号）。
  // ⚙ 高度写在里层那颗上（auto-grow 也量里层），mouseup 派在宿主上（监听器挂宿主）。
  asControl(example).style.height = '420px';
  example.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await sleep(50);
  setValue(example, '又变短了');
  await sleep(80);
  check(
    '拖过之后高度被锁住，输入不会拽回去',
    Math.abs(hOf(example) - 420) <= 6,
    `实际 ${hOf(example)}px（期望 ~420px）`
  );

  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#view-char-editor'));
  await sleep(150);
});

// ---------------------------------------------------------------------------
//  场景 5.6：角色编辑器 —— 字数角标
//
//  框高按字段分别给定之后（描述 200、性格 96……），「写了多少」得一眼能看到
//  （输入和回填两条路都要刷）。
//
//  2026-10-16：字段行右边那颗「↗ 放大编辑」按钮撤掉了（编辑页本来就是整屏，
//  框够大，不用再弹一层浮层），原来那一串浮层断言随之删掉；这里改成
//  反向确认「按钮真的不在了」，免得哪天又被加回来。
// ---------------------------------------------------------------------------
await scenario('角色编辑器：字数角标', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const desc = byId('c-desc');
  const badge = byId('c-desc-count');
  check('字段行上有字数角标', !!badge);
  check('空字段的角标是 0 字', !!badge && badge.textContent === '0 字', badge && badge.textContent);

  setValue(desc, '四两句话');
  await sleep(60);
  check('输入后角标跟着变', badge.textContent === '4 字', badge.textContent);

  check('字段行上已经没有放大按钮', !document.querySelector('.char-expand-btn'));
  check('放大浮层的样式类也不该再出现', !document.querySelector('.char-expand'));

  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#view-char-editor'));
  await sleep(120);
});

// ---------------------------------------------------------------------------
//  场景：角色编辑器 —— 备选开场白（增 / 删 / 存）
//    行是动态铺的（条数不定，不能写死 HTML），所以这里真点按钮、真删行，
//    验证：草稿跟着走、序号重排、字数角标联动、保存后真写进卡。
//    导入 / 导出那两个方向由 smoke-test.js 的「备选开场白 / 作者 / 版本」覆盖。
// ---------------------------------------------------------------------------
await scenario('角色编辑器：备选开场白增删改', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const list = byId('c-alt-list');
  const badge = byId('c-alt-count');
  check('备选开场白有列表容器', !!list);
  check('一条都没有时不铺行', list.querySelectorAll('.alt-greet-row').length === 0);
  check('没条目时总条数角标是空的', badge.textContent.trim() === '', JSON.stringify(badge.textContent));

  // --- 加第一条 ---
  click('#btn-alt-add');
  await sleep(60);
  let rows = $$('#c-alt-list .alt-greet-row');
  check('点「添加一条」长出一行', rows.length === 1, String(rows.length));
  check('总条数角标跟着变', badge.textContent === '1 条', badge.textContent);
  check('行上有序号', rows[0].querySelector('.alt-greet-no').textContent === '备选 1',
    rows[0].querySelector('.alt-greet-no').textContent);

  const count0 = byId('c-alt-0-count');
  check('行上带字数角标', !!count0);
  check('空行的角标是 0 字', !!count0 && count0.textContent === '0 字', count0 && count0.textContent);
  setValue(rows[0].querySelector('.alt-greet-text'), '甲条');
  await sleep(60);
  check('输入后备选的字数角标跟着变', count0.textContent === '2 字', count0.textContent);

  // --- 加第二条 ---
  click('#btn-alt-add');
  await sleep(60);
  rows = $$('#c-alt-list .alt-greet-row');
  check('再加一条变成两行', rows.length === 2, String(rows.length));
  check('总条数角标是 2 条', badge.textContent === '2 条', badge.textContent);
  setValue(rows[1].querySelector('.alt-greet-text'), '乙条');
  await sleep(40);

  // --- 删掉第一条：剩下的应该是「乙条」，序号要重排回 1 ---
  click(rows[0].querySelector('.alt-greet-del'));
  await sleep(60);
  rows = $$('#c-alt-list .alt-greet-row');
  check('删掉一行后只剩一行', rows.length === 1, String(rows.length));
  check('剩下的那条正文是第二条', rows[0].querySelector('.alt-greet-text').value === '乙条',
    rows[0].querySelector('.alt-greet-text').value);
  check('序号重排成「备选 1」', rows[0].querySelector('.alt-greet-no').textContent === '备选 1',
    rows[0].querySelector('.alt-greet-no').textContent);
  check('总条数角标回到 1 条', badge.textContent === '1 条', badge.textContent);

  // --- 保存并落盘 ---
  const NAME = '备选开场白测试';
  setValue('#c-name', NAME);
  setValue('#c-first', 'F-主开场白');
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  check(
    '备选开场白写进了卡',
    !!saved && JSON.stringify(saved.alternateGreetings) === JSON.stringify(['乙条']),
    JSON.stringify(saved && saved.alternateGreetings)
  );

  // --- 收尾：把这张卡删掉 ---
  // 后面的场景有好几处直接取 `.char-card[0]`（空会话导出 / 开聊问「你是谁」…），
  // 还留着这张卡会把「第一张卡是谁」整个带偏；而且下面的「卡片上删除」那条
  // 断言的是「删完就空了」，多一张就再也删不空。所以这里必须清干净。
  const mine = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('新建的卡出现在角色卡', !!mine);
  if (mine) {
    click(mine.querySelector('.char-card-del'));
    await waitFor('删除确认框出现', () => shown('#confirm-modal'));
    click('#confirm-ok');
    await waitFor('卡片删掉', () => !$$('#char-page-grid .char-card-name').some((n) => n.textContent === NAME));
  }
});

// ---------------------------------------------------------------------------
//  场景 6：角色卡 —— 编辑已有角色是「更新」，不是「新增」
// ---------------------------------------------------------------------------
await scenario('角色卡：编辑已有角色', async () => {
  const before = (await savedCharacters()).length;
  const cards = $$('#char-page-grid .char-card');
  check('有可编辑的卡片', cards.length > 0);

  click(buttonByText(cards[0], '编辑'));
  await waitFor('编辑器打开', () => shown('#view-char-editor'));
  check('编辑已有角色时标题是「编辑角色」', byId('chars-title').textContent === '编辑角色', byId('chars-title').textContent);
  check('「删除角色」按钮可用', byId('btn-del-char').disabled === false);

  setValue('#c-name', '改过名字的角色');
  click('#btn-save-char');
  await waitFor('卡片改名', () => $$('#char-page-grid .char-card-name').some((n) => n.textContent === '改过名字的角色'));

  const after = await savedCharacters();
  check('没有新增角色', after.length === before, `期望 ${before}，实际 ${after.length}`);
  check('落盘的名字被更新了', after.some((c) => c.name === '改过名字的角色'));

  click('#btn-close-chars');
  await sleep(120);
  check('关闭已有角色时不弹确认框', !shown('#confirm-modal'));
});

// ---------------------------------------------------------------------------
//  场景 7：角色卡 —— 角色卡右上角直接删除
// ---------------------------------------------------------------------------
await scenario('角色卡：卡片上删除', async () => {
  const before = (await savedCharacters()).length;
  check('待删的角色存在', before > 0, `实际 ${before}`);

  const delBtn = $$('#char-page-grid .char-card')[0].querySelector('.char-card-del');
  check('卡片上有删除按钮（×）', !!delBtn);
  check('删除按钮平时是透明的（悬停才浮出）', !!delBtn && getComputedStyle(delBtn).opacity === '0');

  // --- 先点「取消」：角色必须还在 ---
  click(delBtn);
  await waitFor('确认框出现', () => shown('#confirm-modal'));
  check('确认文案说明了会话会受影响', byId('confirm-message').textContent.includes('会话'), byId('confirm-message').textContent);
  click('#confirm-cancel');
  await sleep(150);
  check('点取消后角色还在', (await savedCharacters()).length === before, `实际 ${(await savedCharacters()).length}`);

  // --- 再点「删除」：角色消失并落盘 ---
  click($$('#char-page-grid .char-card')[0].querySelector('.char-card-del'));
  await waitFor('确认框出现', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('卡片消失', () => $$('#char-page-grid .char-card').length === before - 1);

  const after = (await savedCharacters()).length;
  check('删除后落盘数量正确', after === before - 1, `期望 ${before - 1}，实际 ${after}`);
  check('删空后显示空状态', shown('#char-page-empty'));
});

// ---------------------------------------------------------------------------
//  场景 8：角色属性 → 状态面板（属性模板的完整链路）
// ---------------------------------------------------------------------------
await scenario('属性：从角色卡种到状态面板', async () => {
  // --- 1) 加属性：只有手写和「粘贴文本」两条路 ---
  // （曾经还有一排行「快捷候选词」，内容来自「设置 → 状态属性」；那份全局清单
  //   2026-10-09 连同设置区块一起去掉了 —— 属性名按角色写，清单省不了几个字。
  //   所以下面顺带守一句「它别再长回来」。）
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', '属性测试角色');
  setValue('#c-desc', '属性测试角色的设定文本');
  setValue('#c-personality', '沉默寡言');
  // 年龄/性别/种族已从编辑器移除（归入描述），这里不再通过 UI 填。
  // 身份三项的流转由下方「保存后补数据」保证，见 saveCharacters 那段。

  check('角色编辑器里没有快捷候选词那一行', !byId('c-attr-quick'));

  // 手写第一个
  setValue('#c-attr-new', '金币');
  click('#btn-add-attr');
  await waitFor('属性行出现', () => $$('#c-attr-list .attr-row').length === 1);
  check('手写加进来的名字对', byId('c-attr-list').querySelector('.attr-name').textContent === '金币');

  // 手写第二个
  setValue('#c-attr-new', '上衣');
  click('#btn-add-attr');
  await waitFor('第二个属性行', () => $$('#c-attr-list .attr-row').length === 2);

  // 保留字段名要被拦下（这些是提示词自己的段落标记，当属性会打架）
  setValue('#c-attr-new', '旁白');
  click('#btn-add-attr');
  await sleep(100);
  check('保留字段名被拒绝', $$('#c-attr-list .attr-row').length === 2, `实际 ${$$('#c-attr-list .attr-row').length}`);

  // --- 圆角体检：属性行与它里面的输入框（扫前是 7px / 6px，都是写死的）---
  {
    const root = getComputedStyle(document.documentElement);
    const RSM = root.getPropertyValue('--radius-sm').trim();
    const rows = $$('#c-attr-list .attr-row');
    const radiusOf = (node) => (node ? getComputedStyle(node).borderTopLeftRadius : '(没有)');
    check('属性行圆角 = --radius-sm（不是写死的 7）', radiusOf($('#c-attr-list .attr-item')) === RSM, `${radiusOf($('#c-attr-list .attr-item'))} vs ${RSM}`);
    check(
      '属性里的值输入框圆角 = --radius-sm（不是写死的 7）',
      // ⚙ 组件化之后圆角长在**里层那颗原生 input** 上（宿主只是个布局盒）——
      // 量宿主只会得到 0px，那红的是断言、坏的却是测试自己
      radiusOf(asControl(rows[0].querySelector('.attr-value'))) === RSM,
      `${radiusOf(asControl(rows[0].querySelector('.attr-value')))} vs ${RSM}`
    );
    check(
      '属性类型下拉圆角 = --radius-sm（不是写死的 7）',
      // 同上：下拉的圆角也在里层那颗原生 select 上
      radiusOf(asControl(rows[0].querySelector('.attr-type'))) === RSM,
      `${radiusOf(asControl(rows[0].querySelector('.attr-type')))} vs ${RSM}`
    );
  }

  // 填初始值
  const attrRows = $$('#c-attr-list .attr-row');
  setValue(attrRows[0].querySelector('.attr-value'), '100');
  setValue(attrRows[1].querySelector('.attr-value'), '布衣');

  // ⚙ 属性行那三个下拉已迁成组件（<m-select size="xs">）。这里量**实测高度**：
  // 出图零差异**不能**反推"改动生效了"—— 得直接量（26px = xs 档，28px 就是没生效）。
  // 属性分区此时一定是展开的（上面几个 setValue/click 都会先 revealEditorControl）。
  {
    const typeInner = asControl(attrRows[0].querySelector('.attr-type'));
    const height = typeInner ? Math.round(typeInner.getBoundingClientRect().height) : 0;
    check(
      '属性行的类型下拉是组件、走 size="xs"（26px 高 / xs 字号）',
      !!typeInner && !!typeInner.closest('m-select') && height === 26,
      `${typeInner ? (typeInner.closest('m-select') ? 'm-select' : '原生 select') : '没找到'} / 高 ${height}px`
    );
  }

  // --- 加一个「带范围的数值」属性（吸收互动模板那套：类型 + 范围 + 变化规则）---
  setValue('#c-attr-new', '好感度');
  click('#btn-add-attr');
  await waitFor('第三个属性行', () => $$('#c-attr-list .attr-row').length === 3);

  let meterRow = $$('#c-attr-list .attr-row')[2];
  check('新属性默认是文本类型', !!meterRow.querySelector('.attr-type') && meterRow.querySelector('.attr-type').value === 'text',
    meterRow.querySelector('.attr-type') && meterRow.querySelector('.attr-type').value);
  check('文本类型下不显示范围输入框', !meterRow.parentElement.querySelector('.attr-more .attr-num'));

  setValue(meterRow.querySelector('.attr-value'), '20');
  // 选「数值」→ 重画一次，并且自动展开「更多」，范围输入框这时候才出现
  setValue(meterRow.querySelector('.attr-type'), 'meter');
  await waitFor('范围输入框出现', () => !!$('#c-attr-list .attr-more .attr-num'));

  meterRow = $$('#c-attr-list .attr-row')[2];
  const numInputs = meterRow.parentElement.querySelectorAll('.attr-more .attr-num');
  check('数值类型下有两个范围输入框', numInputs.length === 2, `实际 ${numInputs.length} 个`);
  setValue(numInputs[0], '0');
  setValue(numInputs[1], '100');
  setValue(meterRow.parentElement.querySelector('.attr-more .attr-hint'), '按剧情合理增减，单轮不超过 10');
  check('配置区里有分组下拉', !!meterRow.parentElement.querySelector('.attr-more .attr-group'));

  // 「更多」能收起，收起来之后配置不丢（草稿还在）。
  // 这一段必须跑在**填分组之前** —— 填完分组这个字段就归到「关系」组、
  // 从当前这一页搬走了，下面按下标取行就会取到别人身上。
  const moreBtn = meterRow.querySelector('.attr-more-btn');
  check('有范围时「更多」默认是展开的', String(moreBtn.textContent).includes('收起'), String(moreBtn.textContent));
  click(moreBtn);
  await waitFor('收起后配置区没了', () => !$('#c-attr-list .attr-more'));
  meterRow = $$('#c-attr-list .attr-row')[2];
  click(meterRow.querySelector('.attr-more-btn'));
  await waitFor('再展开还在', () => !!$('#c-attr-list .attr-more .attr-num'));
  check(
    '收起再展开，范围没丢',
    $$('#c-attr-list .attr-more .attr-num')[0].value === '0' && $$('#c-attr-list .attr-more .attr-num')[1].value === '100',
    JSON.stringify($$('#c-attr-list .attr-more .attr-num').map((i) => i.value))
  );

  // --- 分组：把这个字段搬进「关系」---
  const tabLabels = () => $$('#c-attr-tabs .attr-tab').map((b) => b.textContent);
  const listedNames = () => $$('#c-attr-list .attr-name').map((n) => n.textContent);
  check('三个字段都还没分组时，标签栏只有一个「未分组」', JSON.stringify(tabLabels()) === JSON.stringify(['未分组 3']), JSON.stringify(tabLabels()));

  // ⚠️ 必须重新取一次行：上面 click 触发过重画，列表整块重建，旧节点 querySelector 拿到 null。
  meterRow = $$('#c-attr-list .attr-row')[2];
  const groupSelect = meterRow.parentElement.querySelector('.attr-more .attr-group');
  // 「未分组」必须在选项里 —— 否则一旦所有属性都归了组，就再也拿不出来了
  check(
    '分组是下拉，且永远带一个「未分组」出口',
    asControl(groupSelect).tagName === 'SELECT' &&
      Array.from(groupSelect.options).some((o) => o.value === '' && o.textContent === '未分组'),
    asControl(groupSelect).tagName
  );
  // 卡里一个命名分组都没有时，下拉里唯一的选择就是「＋ 新建分组…」——
  // 走它 → 这一行临时变输入框 → 打完回车，建组 + 搬过去一步完成。
  const newOpt = Array.from(groupSelect.options).find((o) => o.textContent.includes('新建分组'));
  check('下拉末尾有「＋ 新建分组…」', !!newOpt, Array.from(groupSelect.options).map((o) => o.textContent).join('/'));
  setValue(groupSelect, newOpt.value);

  await waitFor('这一行变成新建分组输入框', () => !!$('#c-attr-list .attr-more .attr-group-new'));
  const newGroupInput = $('#c-attr-list .attr-more .attr-group-new');
  setValue(newGroupInput, '关系');
  newGroupInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  await waitFor('标签栏多出「关系」', () => tabLabels().some((t) => t.startsWith('关系')));
  check(
    '标签栏按分组铺出来了，计数也对',
    JSON.stringify(tabLabels()) === JSON.stringify(['关系 1', '未分组 2']),
    JSON.stringify(tabLabels())
  );
  check(
    '字段搬走之后，「未分组」这一页只剩两行',
    listedNames().length === 2 && !listedNames().includes('好感度'),
    JSON.stringify(listedNames())
  );

  // 切到「关系」：只铺这一组的字段
  click($$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith('关系')));
  await waitFor('切到关系组', () => $$('#c-attr-list .attr-row').length === 1);
  check(
    '切组之后只显示这一组的字段',
    listedNames().join(',') === '好感度',
    JSON.stringify(listedNames())
  );
  check('切组之后那一行的「更多」还是展开的（草稿里的展开状态没丢）', !!$('#c-attr-list .attr-more .attr-num'));

  // --- 搬到**已经存在**的分组：在下拉里直接选，不用再走「＋ 新建分组…」---
  click($$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith('未分组')));
  await waitFor('切回未分组', () => listedNames().length === 2);
  // 取行的函数要每次现查：「更多」一点开列表就整块重建，手里的节点会作废
  const shirtRow = () => $$('#c-attr-list .attr-row').find((r) => r.querySelector('.attr-name').textContent === '上衣');
  click(shirtRow().querySelector('.attr-more-btn'));
  await waitFor('上衣的「更多」展开', () => !!shirtRow().parentElement.querySelector('.attr-more .attr-group'));
  const moveSelect = shirtRow().parentElement.querySelector('.attr-more .attr-group');
  check(
    '下拉里列出了这张卡已有的分组',
    Array.from(moveSelect.options).some((o) => o.value === '关系'),
    Array.from(moveSelect.options).map((o) => o.value).join('/')
  );
  setValue(moveSelect, '关系');
  await waitFor('上衣搬进「关系」', () => tabLabels().join() === '关系 2,未分组 1');
  check('选中一个已有的分组就能把属性搬过去', listedNames().join(',') === '金币', JSON.stringify(listedNames()));

  // 再搬回「未分组」：下拉里那个出口必须一直在 ——
  // 少了它，属性一旦归了组就再也拿不出来了（纯下拉最容易丢的就是这条路）。
  // 搬回去之后夹具回到原样，下面「游玩时状态面板」那一段的预期才不受影响。
  click($$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith('关系')));
  await waitFor('切到关系组', () => $$('#c-attr-list .attr-row').length === 2);
  const backRow = () => $$('#c-attr-list .attr-row').find((r) => r.querySelector('.attr-name').textContent === '上衣');
  // 「更多」的展开状态记在草稿上（_moreOpen），上面点开过一次，这里通常是开着的
  if (!backRow().parentElement.querySelector('.attr-more .attr-group')) {
    click(backRow().querySelector('.attr-more-btn'));
    await waitFor('上衣的「更多」展开', () => !!backRow().parentElement.querySelector('.attr-more .attr-group'));
  }
  setValue(backRow().parentElement.querySelector('.attr-more .attr-group'), '');
  await waitFor('上衣退回未分组', () => tabLabels().join() === '关系 1,未分组 2');
  check('下拉里选「未分组」就把它拿出来了', listedNames().join(',') === '好感度', JSON.stringify(listedNames()));

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(150);

  const saved = await savedCharacters();
  const mine = saved.find((c) => c.name === '属性测试角色');
  check('属性已落盘到角色卡', !!mine && Array.isArray(mine.attributes) && mine.attributes.length === 3, JSON.stringify(mine && mine.attributes));
  check(
    '初始值也一起落盘了',
    !!mine && mine.attributes[0].name === '金币' && mine.attributes[0].value === '100' && mine.attributes[1].value === '布衣',
    JSON.stringify(mine && mine.attributes)
  );
  // 白名单陷阱：保存时的映射以前只搬 name/value，新字段会被静默丢掉
  check(
    '数值属性的类型/范围/规则都落盘了（没被白名单丢掉）',
    !!mine && mine.attributes[2].type === 'meter' && mine.attributes[2].min === 0 && mine.attributes[2].max === 100 &&
      mine.attributes[2].hint === '按剧情合理增减，单轮不超过 10',
    JSON.stringify(mine && mine.attributes[2])
  );
  check(
    '分组也落盘了',
    !!mine && mine.attributes[2].group === '关系',
    JSON.stringify(mine && mine.attributes[2] && mine.attributes[2].group)
  );
  check(
    '界面自己的临时状态没有写进角色卡（_moreOpen）',
    !!mine && !('_moreOpen' in mine.attributes[2]),
    JSON.stringify(mine && Object.keys(mine.attributes[2] || {}))
  );
  // 年龄/性别/种族已整体移除（身份写进角色描述即可），身份组只剩「姓名」。

  // --- 3) 点「聊天」绑定角色 → 属性应该种进状态面板 ---
  click('#btn-close-chars');
  await sleep(150);

  const card = $$('#char-page-grid .char-card').find((c) => c.textContent.includes('属性测试角色'));
  check('找到了新角色的卡片', !!card);
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'));

  await waitFor('状态卡入口条出现', () => shown('#panel-box'));

  // 「当前状态」那块折叠面板的**字段列表面板**已经去掉（一个面板只能显示一个
  // 角色的状态，是旧版单角色的遗留）—— 入口条上只留头像。
  // 标题是「在场角色 N」（2026-09-30 从「当前状态」改名，对齐设计稿的 .cast-cap）：
  // 这一块说的就是「现在场上有谁」，跟着下面那排头像读才对得上。
  check(
    '旧的状态面板字段区已经没有了',
    !byId('panel-fields') && !byId('btn-panel-collapse') && !byId('panel-hint'),
    JSON.stringify({
      fields: !!byId('panel-fields'),
      collapse: !!byId('btn-panel-collapse'),
      hint: !!byId('panel-hint')
    })
  );
  check('角色头像入口位于右栏', !!byId('panel-box').closest('#cast-panel') && !byId('panel-box').closest('.chat-col'));
  check(
    '「在场角色」是个纯标签，不是能折叠的按钮',
    (() => {
      const t = byId('cast-panel-title');
      return !!t && t.tagName === 'SPAN' && !byId('btn-panel-collapse');
    })()
  );
  // 标题上的数字必须是**数出来的**（跟下面那排头像一致），不能是写死的
  check(
    '标题上的「在场角色 N」和头像个数对得上',
    Number(byId('panel-cast-count').textContent) === $$('#panel-cast .panel-avatar').length,
    `标题=${byId('panel-cast-count').textContent} 头像=${$$('#panel-cast .panel-avatar').length}`
  );

  // --- 点入口条上的角色头像 → 打开角色状态卡 ---
  const charAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
  check('面板栏上有角色的头像', !!charAvatar);
  click(charAvatar);
  await waitFor('角色状态卡出现', () => $$('#state-cards .state-card').some((c) => c.dataset.owner !== 'player'));

  const charCard = () => $$('#state-cards .state-card').find((c) => c.dataset.owner !== 'player');
  const cardNames = () => Array.from(charCard().querySelectorAll('.sc-name')).map((n) => n.textContent);
  const cardRows = () => Array.from(charCard().querySelectorAll('.sc-row'));
  const cardRowOf = (field) => cardRows().find((r) => r.querySelector('.sc-name').textContent === field);
  const cardValue = (field) => {
    const row = cardRowOf(field);
    return row ? row.querySelector('.sc-value').textContent : null;
  };

  check('状态卡里出现了角色属性', cardNames().includes('金币') && cardNames().includes('上衣'), JSON.stringify(cardNames()));
  check('带范围的数值属性也在卡里', cardNames().includes('好感度'), JSON.stringify(cardNames()));

  // --- 扁平化体检（2026-09-30）---
  // ⚠️ 这几条**必须**是计算样式断言：DOM 结构全对、类名全在，观感照样可能是错的。
  //    「收起」那颗就翻过车 —— 它没跟 .sc-edit/.sc-close 一起写 border:0，
  //    一直带着浏览器默认的 2px outset 边框，一排卡片头上格外扎眼。
  //    规则是：**卡片、按钮靠阴影/底色分层，不靠 1px 描边和分隔线**。
  {
    const side = (node, prop) => (node ? getComputedStyle(node)[prop] : 'no-node');
    const inCard = (sel) => charCard().querySelector(sel);
    check('状态卡不描边（靠阴影分层）', side(charCard(), 'borderTopWidth') === '0px', side(charCard(), 'borderTopWidth'));
    check(
      '「收起」是纯文字按钮（没有浏览器默认边框）',
      side(inCard('.sc-toggle'), 'borderTopWidth') === '0px',
      side(inCard('.sc-toggle'), 'borderTopWidth')
    );
    check('字段行不画分隔线', side(inCard('.sc-row'), 'borderBottomWidth') === '0px', side(inCard('.sc-row'), 'borderBottomWidth'));
    check(
      '分组小标题不画下划线',
      side(inCard('.sc-group-title'), 'borderBottomWidth') === '0px',
      side(inCard('.sc-group-title'), 'borderBottomWidth')
    );
    check(
      '在场角色入口条仅底部分隔，不包围头像',
      // 2026-09-30 卡片换回悬浮后，入口条改成「一行深色底 + 无边框」，
      // 不再靠一条下划线跟下面的卡片区分（下面已经没有一列卡片了）
      !!byId('panel-box').closest('#cast-panel') && !byId('panel-box').closest('.chat-col'),
      `${side(byId('panel-box'), 'borderTopWidth')} / ${side(byId('panel-box'), 'backgroundColor')}`
    );
    check(
      '侧栏条目是渐变圆头像（不是浅色底 + 主色字）',
      (getComputedStyle($$('.convo-avatar')[0]).backgroundImage || '').includes('linear-gradient'),
      getComputedStyle($$('.convo-avatar')[0]).backgroundImage
    );
  }

  // --- 入口条上不显示「我」（2026-10-08：普通聊天不显示玩家状态）---
  // 「我」只在玩世界书时上入口条；普通聊天里只剩「我」时整条横幅都会收掉。
  // 这场绑了角色，所以横幅在、但上面只有那个角色。两张卡并排的契约挪到
  // 下面「发出一条消息」之后验 —— 玩家卡从自己消息的头像开。
  {
    const myAvatarBtn = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner === 'player');
    check('普通聊天的入口条没有「我」的头像', !myAvatarBtn);
  }

  // --- 顶栏：头像 + 标题旁的小胶囊（2026-09-30 按设计稿的 .top / .pill-tag 加的）---
  {
    const av = byId('topbar-avatar');
    check('顶栏左边有头像', !!av);
    check(
      '顶栏头像和侧栏 / 消息区共用同一套渐变',
      (getComputedStyle(av).backgroundImage || '').includes('linear-gradient'),
      getComputedStyle(av).backgroundImage
    );
    // 头像上的字 = 说话人首字（绑了角色的会话就是角色名首字）
    check(
      '顶栏头像上是这个角色的首字',
      (av.textContent || '').trim().length === 1 || !!av.querySelector('img'),
      av.textContent
    );

    const pill = byId('convo-pill');
    check('标题旁边有那颗小胶囊', !!pill);
    // 视角是默认（非 GM / 标准叙述）时，胶囊退给「绑定角色身上第一个数值字段」
    check(
      '胶囊里是绑定角色的关键数值（「好感度 20」这种）',
      /好感度\s*\d+/.test((pill.textContent || '').trim()),
      pill.textContent
    );
    const nameRow = byId('convo-title').parentElement;
    check(
      '胶囊和标题是同一行的兄弟节点（不是塞在 h1 里）',
      nameRow && nameRow.classList.contains('topbar-name') && pill.parentElement === nameRow,
      nameRow ? nameRow.className : 'no-parent'
    );
  }

  // --- 2026-10-12 晚：把「设计稿上的那几个数」逐条钉住 -------------------------
  // 为什么单开一节：这一批全是「DOM 全绿、类名全在，观感照样错」的东西 ——
  // 实际就是靠出图才看出顶栏是 68（稿子 48）、头像 44 圆（稿子 26 方角）、
  // 入口条 48（稿子 34）。数字不进断言，下次还会悄悄漂回去。
  {
    const c = (node, prop) => getComputedStyle(node)[prop];
    const r = (node) => Math.round(node.getBoundingClientRect().width);
    const h = (node) => Math.round(node.getBoundingClientRect().height);

    // 顶栏：稿子 2:82 高 48；头像 / 图标 2026-10-12 深夜放大（26 → 34 / 32），
    // 但都小于 min-height 48，所以顶栏高度**一点没变**。
    check('顶栏高 98（原型叙事布局）', Math.abs(h($('.topbar')) - 98) <= 1, String(h($('.topbar'))));
    const topAv = byId('topbar-avatar');
    check('顶栏不再显示旧头像块', c(topAv, 'display') === 'none', `${r(topAv)}×${h(topAv)}`);
    check('顶栏头像是方角 r=4（不是圆）', c(topAv, 'borderTopLeftRadius') === '4px', c(topAv, 'borderTopLeftRadius'));
    // 2026-10-12 深夜全站字号 token 化：原来的 11px 并进了最小档 --fs-xs（12px）。
    check('顶栏元信息 12px（最小档 --fs-xs）', c(byId('convo-meta'), 'fontSize') === '12px', c(byId('convo-meta'), 'fontSize'));
    check(
      '数值胶囊是方角（不是 999px 胶囊）',
      c(byId('convo-pill'), 'borderTopLeftRadius') !== '999px',
      c(byId('convo-pill'), 'borderTopLeftRadius')
    );

    // 顶栏图标按钮：稿子 2:98 / 2:468 / 2:104 / 2:108 是 26×26 + 1px 描边，
    // 2026-10-12 深夜统一放大到 **32×32**。
    const more = byId('btn-more');
    check(
      '「⋯」是 32×32 的方框按钮（放大后）',
      // ⚠️ 边框不写 `=== '1px'`：本机显示缩放 125% 时 Chromium 会把 1px 按物理像素
      //    取整成 0.8px（dpr=1.25 实测），那不是样式变了，是环境 —— 用 > 0.5 判定「有描边」。
      r(more) === 32 && h(more) === 32 && parseFloat(c(more, 'borderTopWidth')) > 0.5,
      `${r(more)}×${h(more)} border=${c(more, 'borderTopWidth')}`
    );

    // 在场角色条：稿子 2:113 高 34、2:118 头像 20 —— 2026-10-12 深夜头像 20 → 28、条高 → 46。
    // ⚠️ 2026-10-13 起是 **48**：.panel-box 的内边距原来是 9px（奇数），
    //    「边距奇数统一归偶」（见 tools/audit-spacing.js）之后成了 10px，
    //    条高 = 10 + 头像 28 + 10。**这是那次规范化的必然结果，不是回归。**
    check('角色头像在右栏内正常排布', h(byId('panel-box')) > 0 && h(byId('panel-box')) < 110, String(h(byId('panel-box'))));
    const panelAv = $('#panel-cast .panel-avatar');
    check(
      '入口条头像 28×28 方角 r=4（放大后）',
      !!panelAv && r(panelAv) === 34 && c(panelAv, 'borderTopLeftRadius') === '4px',
      panelAv ? `${r(panelAv)} r=${c(panelAv, 'borderTopLeftRadius')}` : '（没有头像）'
    );

    // 右栏：264 → 280 → 300（2026-10-12 晚起**始终跟左栏等宽**）
    check('右栏宽 286', r(byId('cast-panel')) === 286, String(r(byId('cast-panel'))));

    // ⚠️ 这条是 2026-10-12 那个真 bug 的守卫：`.cast-card-avatar` 里一旦写上
    //    `background: var(--accent)`，就会盖掉 entityTone 的 `.g1`~`.g6`（同权重、它在后），
    //    表现是「同一个人，消息区绿色、右栏琥珀色」。所以这里查的是**渐变**在不在。
    const castAv = $('#cast-panel-body .cast-card-avatar');
    check(
      '右栏卡片头像是按人配色（entityTone 没被 background 盖掉）',
      !!castAv && (c(castAv, 'backgroundImage') || '').includes('linear-gradient'),
      castAv ? c(castAv, 'backgroundImage') : '（没有卡片头像）'
    );

    // 卡片头两行：名字 / 在场（稿子 d-rightrail）
    check(
      '右栏卡片头是「名字 / 在场」两行',
      !!$('#cast-panel-body .cast-card-id .cast-card-role'),
      ($('#cast-panel-body .cast-card-id') || {}).textContent || '（没有卡片头）'
    );

    // 字段额度 3（稿子三张卡是 3 / 3 / 2 个字段；取 2 会把「心境」这类文本字段挤掉）
    const firstCard = $('#cast-panel-body .cast-card');
    const rowCount = firstCard ? firstCard.querySelectorAll('.cast-field').length : 0;
    check('右栏每张卡最多列 3 个字段', rowCount > 0 && rowCount <= 3, String(rowCount));

    // 消息工具条那排小按钮：稿子的方角语言，6px 是「药丸时代」的残留。
    // ⚠️ 只在真存在时才验 —— 这一局可能一条带工具条的消息都没有（点开 .msg-actions 看）。
    //    「找不到就跳过」在这里是可接受的，因为**圆角 lint（tools/audit-radius.js）
    //    已经在源头堵死了**：写死 4px 以上的盒状圆角会直接 FAIL。断言只是第二道。
    if ($('.mini-btn')) {
      const root = getComputedStyle(document.documentElement);
      const want = root.getPropertyValue('--radius-sm').trim();
      check('消息工具条小按钮圆角 = --radius-sm', getComputedStyle($('.mini-btn')).borderTopLeftRadius === want, getComputedStyle($('.mini-btn')).borderTopLeftRadius);
    }

    // 浮动状态卡 + 它上面的小按钮（稿子 2:476 那张卡是 r=4；小按钮走 --radius-sm）
    {
      const root = getComputedStyle(document.documentElement);
      const R = root.getPropertyValue('--radius').trim();
      const RSM = root.getPropertyValue('--radius-sm').trim();
      const radiusOf = (sel) => {
        // ⚙ 组件化之后圆角长在**里层那颗原生控件**上（宿主只是布局盒），
        // 所以要过一道 asControl() —— 直接量宿主只会得到 0px（假红）
        const node = asControl($(sel));
        return node ? getComputedStyle(node).borderTopLeftRadius : '(没有)';
      };
      check('浮动状态卡圆角 = --radius（稿子 2:476 r=4，不是写死的 14）', radiusOf('#state-cards .state-card') === R, `${radiusOf('#state-cards .state-card')} vs ${R}`);
      check('状态卡上的编辑/收起按钮圆角 = --radius-sm（不是写死的 6）', radiusOf('#state-cards .state-card .sc-edit') === RSM, `${radiusOf('#state-cards .state-card .sc-edit')} vs ${RSM}`);
    }

    // meter 和数值同一行（稿子：`好感 ▬▬▬▬ 62`）—— 进度条不该是字段下面另起的一行。
    // ⚠️ 这条**必须硬断言**，不能「找不到就跳过」：2026-10-12 晚就是靠出图发现
    //    **进度条一条都画不出来**的（值存的是 `"63/100"`，`Number()` 出来是 NaN）。
    //    当时写成「没有 meter 就跳过」，于是它安安静静地绿着，什么都没守住。
    const meterRow = $('#cast-panel-body .cast-field .cast-meter');
    check(
      '右栏的数值字段画出了进度条',
      !!meterRow,
      meterRow ? meterRow.parentElement.className : '（一个 .cast-meter 都没有）'
    );
    check(
      '进度条和数值在同一行里',
      !meterRow || meterRow.parentElement.classList.contains('cast-field'),
      meterRow ? meterRow.parentElement.className : '（无 meter）'
    );
    check(
      '进度条按「当前/上限」算对了比例（不是 0% 也不是 100%）',
      (() => {
        if (!meterRow) return false;
        const fill = meterRow.querySelector('.cast-meter-fill');
        const w = fill ? parseFloat(fill.style.width) : NaN;
        return Number.isFinite(w) && w > 0 && w < 100;
      })(),
      meterRow ? (meterRow.querySelector('.cast-meter-fill') || {}).style?.width : '（无 meter）'
    );
  }

  // 分组跟着一起搬过来（顺序 = 面板里那套：身份 → 关系 → 没分组的）
  const cardSeq = Array.from(charCard().querySelectorAll('.sc-body > *')).map((n) =>
    n.classList.contains('sc-group-title') ? `#${n.textContent}` : n.querySelector('.sc-name').textContent
  );
  // 「身份」分组已随 IDENTITY_GROUP 一起删掉：姓名不再归组，和金币/上衣一起
  // 排在已分组字段（关系）之后 —— 组内的先出，没组的跟在后头。
  check(
    '分组小标题和字段按组排好',
    cardSeq.join(',') === '#关系,好感度,姓名,金币,上衣',
    JSON.stringify(cardSeq)
  );
  // 数值行：值显示成「20/100」，带进度条
  {
    const favorRow = cardRowOf('好感度');
    const bar = favorRow && favorRow.querySelector('.sc-bar');
    check('数值字段有进度条', !!bar, favorRow ? favorRow.outerHTML.slice(0, 140) : '没找到');
    check('数值显示成「分子/满值」', cardValue('好感度') === '20/100', String(cardValue('好感度')));
    check(
      '进度条比例对（20/100 → 20%）',
      !!bar && bar.querySelector('.sc-bar-fill').style.width === '20%',
      bar ? bar.querySelector('.sc-bar-fill').style.width : '没找到'
    );
    const gold = cardRowOf('金币');
    check('文本字段没有进度条', !gold || !gold.querySelector('.sc-bar'));
  }

  check('卡里的值是角色卡上的初始值', cardValue('金币') === '100', String(cardValue('金币')));

  // 单角色对话（角色卡点「聊天」）也得把姓名带上。
  check('姓名在这张卡里', cardNames().includes('姓名'), JSON.stringify(cardNames()));
  check('姓名取的是角色名', cardValue('姓名') === '属性测试角色', String(cardValue('姓名')));

  // --- 4) 发一条：注入给模型的消息里必须真的带上面板 ---
  // 断言在宿主侧做（要看 chat:send 的 payload），这里只负责发出去
  setValue('#input', '冒烟测试：属性注入');
  click('#btn-send');
  await waitFor('收到回复', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);

  // --- 浮动卡：开两张必须**自动并排**（2026-09-30 换回悬浮卡的核心诉求）---
  // 当初「浮动卡」被换成固定右栏，就是因为两张会叠在一起。现在靠 layoutSideBySide
  // 按整卡宽铺开 —— 这条就是那个契约的守门人，别让它退化成"错开 26px 叠着"。
  // 普通聊天的入口条没有「我」，玩家卡从自己消息的头像开（普通聊天里剩下的入口）。
  {
    const myMsgAvatar = $$('#messages .msg.user .msg-avatar').pop();
    check(
      '自己消息的头像是「我」状态卡的入口',
      !!myMsgAvatar && myMsgAvatar.classList.contains('clickable')
    );
    click(myMsgAvatar);
    await waitFor('第二张状态卡也开了', () => $$('#state-cards .state-card').length >= 2);

    const host = byId('state-cards');
    const cards = $$('#state-cards .state-card');
    check(
      '状态卡是浮层（卡片绝对定位 + 容器本身不挡鼠标）',
      cards.every((c) => getComputedStyle(c).position === 'absolute') &&
        getComputedStyle(host).position === 'absolute' &&
        getComputedStyle(host).pointerEvents === 'none',
      `${getComputedStyle(cards[0]).position} / ${getComputedStyle(host).pointerEvents}`
    );

    const box = (n) => n.getBoundingClientRect();
    const [a, b] = cards.map(box);
    const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    check(
      '开两张卡时自动并排，不互相压',
      !overlap,
      `A=${Math.round(a.left)},${Math.round(a.top)} B=${Math.round(b.left)},${Math.round(b.top)}`
    );

    // 头部是拖动把手 —— 光标得给 grab，别让用户猜这里能拖
    check(
      '卡片头部是拖动把手（光标 grab）',
      getComputedStyle(cards[0].querySelector('.sc-head')).cursor === 'grab',
      getComputedStyle(cards[0].querySelector('.sc-head')).cursor
    );

    // 收掉「我」那张，别挡着后面对角色卡的编辑
    click($('#state-cards .state-card[data-owner="player"] .sc-close'));
    await sleep(150);
  }

  // --- 5) 超范围的数值要被夹回来 ---
  // 在卡片的编辑态里手填一个越界值（模拟模型写了 150/100），失焦即落盘。
  click(charCard().querySelector('.sc-edit'));
  await waitFor('卡切到编辑态', () => !!charCard().querySelector('.sc-input'));

  const favorInput = cardRowOf('好感度').querySelector('.sc-input');
  check('卡里能改「好感度」', !!favorInput);

  if (favorInput) {
    setValue(favorInput, '150');
    favorInput.dispatchEvent(new Event('blur', { bubbles: true }));
    // 等它真落盘，别用固定 sleep —— 那会偶发读到旧值，报成「没夹回」的假失败
    const clamped = await settlePanelValue('好感度', '100/100');

    const convos = await window.mimitale.getConversations();
    const active = clamped || convos.conversations.find((c) => c.id === convos.activeId);
    check(
      '越界值被夹回上限（150 → 100/100）',
      !!active && active.panel && panelValByName(active.panel, '好感度') === '100/100',
      JSON.stringify(active && active.panel)
    );
    check(
      '字段定义跟着会话一起存下来了（有范围才夹得住）',
      !!active && panelDefByName(active.panelDefs, '好感度') && panelDefByName(active.panelDefs, '好感度').max === 100,
      JSON.stringify(active && active.panelDefs)
    );
    check(
      '分组也跟着定义存下来了',
      !!active && panelDefByName(active.panelDefs, '好感度') && panelDefByName(active.panelDefs, '好感度').group === '关系',
      JSON.stringify(active && panelDefByName(active.panelDefs, '好感度'))
    );

    // 范围内的值不该被动
    setValue(favorInput, '60');
    favorInput.dispatchEvent(new Event('blur', { bubbles: true }));
    await settlePanelValue('好感度', '60/100');
    const convos2 = await window.mimitale.getConversations();
    const active2 = convos2.conversations.find((c) => c.id === convos2.activeId);
    check(
      '范围内的值不动（60 → 60/100）',
      !!active2 && active2.panel && panelValByName(active2.panel, '好感度') === '60/100',
      JSON.stringify(active2 && panelValByName(active2.panel, '好感度'))
    );
  }

  // --- 6) 模型整轮漏写状态表 → 程序补问一次，把状态表要回来 ---
  //
  // 「状态卡不跟着剧情走」最常见的形态**不是**程序没接住，是模型压根没写：
  // 实测约四分之一的回合会整段丢掉（尤其「我明天要出差几天」这种没有明显状态
  // 变化的输入）。这段验的是那条兜底链路 —— 正文非空、一个已知字段都没提、
  // 本局有状态字段 → 自动补问一次（补问语见 panel.js 的 PANEL_PROMPT_NUDGE），
  // 值真的回到面板上。假后端按两次不同返回模拟，见 smoke-test.js 的「漏状态表」。
  {
    setValue('#input', '漏状态表');
    click('#btn-send');
    const back = await settlePanelValue('金币', '88', 8000);
    check(
      '模型漏写状态表时，程序补问一次把值要了回来（100 → 88）',
      !!back,
      '等了 8 秒，金币还没变成 88'
    );

    // 补出来的状态表同样要按面板行剥掉 —— 气泡里只留正文
    const lastBubble = $$('#messages .msg').pop();
    check(
      '补写的状态表不会挂在气泡里',
      !!lastBubble && !/【金币】/.test(lastBubble.textContent || ''),
      lastBubble ? JSON.stringify(lastBubble.textContent.slice(-140)) : '没找到最后一条消息'
    );
  }

  // 收拾现场：把卡关掉 —— 下一个场景验「入口条常驻、点头像开卡」
  const closeCharCard = charCard().querySelector('.sc-close');
  if (closeCharCard) click(closeCharCard);
  await sleep(150);
});

// ---------------------------------------------------------------------------
//  场景 8b：续写路径也要把状态表要回来
//
//  「只思考没落笔 → 点继续」这条路绕开了主生成的补问分支（情形三）：正文被
//  「继续」补出来了，状态表却始终没写，状态卡就停在旧值上 —— 真实反馈里
//  「一整局都没更新过一次」就是这么来的。断言：点完继续，金币被补问要了回来。
// ---------------------------------------------------------------------------
await scenario('续写：也把状态表补回来', async () => {
  const lastAssistant = () => $$('#messages .msg.assistant').pop();

  setValue('#input', '续写找状态表');
  click('#btn-send');

  // 主生成只思考不落笔 → 落在那条「点继续」的兜底说明上（正文为空）
  await waitFor(
    '落在「只思考没落笔」的兜底说明上',
    () => {
      const node = lastAssistant();
      return !!node && /只输出了思考过程/.test(node.textContent || '');
    },
    8000
  );
  await waitFor('流式结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  const node = lastAssistant();
  check('兜底说明这条上有「继续」', !!node && !!buttonByText(node, '继续'));

  // 「继续」2026-10-20 起改成常显（不再收在「⋯」里），直接点即可
  click(buttonByText(node, '继续'));
  const back = await settlePanelValue('金币', '55', 8000);
  await waitFor('流式结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  const convosNow = await window.mimitale.getConversations();
  const act = convosNow.conversations.find((c) => c.id === convosNow.activeId);
  const lastNow = lastAssistant();
  const contentNode = lastNow ? lastNow.querySelector('.msg-content') : null;
  const tail = contentNode ? contentNode.textContent : '（没有内容节点）';
  check(
    '续写之后也会补问状态表（88 → 55）',
    !!back,
    '面板=' + JSON.stringify(act && act.panel) + ' / 气泡尾部=' + JSON.stringify(tail.slice(-160))
  );
});

// ---------------------------------------------------------------------------
//  场景 9：状态卡入口条 —— 一直在这儿，点头像开卡
// ---------------------------------------------------------------------------
await scenario('状态卡入口条：常驻 + 点头像开卡', async () => {
  await waitFor('入口条在', () => shown('#panel-box') && !!byId('panel-cast'));

  // 旧面板的折叠开关/字段区/提示行都去掉了 —— 入口条只有一行头像，没有可收的内容
  check(
    '旧面板的折叠开关 / 字段区 / 提示行都已移除',
    !byId('btn-panel-collapse') && !byId('panel-fields') && !byId('panel-hint') && !byId('btn-panel-reset'),
    JSON.stringify({
      collapse: !!byId('btn-panel-collapse'),
      fields: !!byId('panel-fields'),
      hint: !!byId('panel-hint'),
      reset: !!byId('btn-panel-reset')
    })
  );

  const boxH = Math.round(byId('panel-box').getBoundingClientRect().height);
  check('右栏头像入口正常显示', boxH > 0 && boxH < 120, `${boxH}px`);

  // 头像行就是入口。普通聊天不显示「我」（2026-10-08），
  // 这条会话绑了角色，所以头像行上只有那个角色。
  const owners = $$('#panel-cast .panel-avatar').map((b) => b.dataset.owner);
  check('普通聊天的入口条没有「我」，只有绑定的角色', owners.length === 1 && owners[0] !== 'player', JSON.stringify(owners));
  const avatarBox = $$('#panel-cast .panel-avatar')[0].getBoundingClientRect();
  check('头像可见可点', avatarBox.height > 0 && avatarBox.width > 0, `${Math.round(avatarBox.width)}×${Math.round(avatarBox.height)}`);

  // 点头像 → 开那个角色的状态卡；再点 ✕ 收掉
  const firstOwner = owners[0];
  const cardOf = () => $(`#state-cards .state-card[data-owner="${CSS.escape(firstOwner)}"]`);
  click($$('#panel-cast .panel-avatar')[0]);
  await waitFor('状态卡从入口条打开', () => !!cardOf());
  click(cardOf().querySelector('.sc-close'));
  await sleep(150);
  check('点 ✕ 把卡收掉了', !cardOf());

  // 顶栏那个「状态」按钮早就去掉了，别再回来
  check('顶栏的「状态」按钮已移除', !byId('btn-panel-toggle'));
});

// ---------------------------------------------------------------------------
//  场景 9.5：认不出归属的字段 —— 并回主角，不再单开一张「世界」卡
//
//  用户在真实对局里发现的坑：AI 输出状态栏时**不会给主角加「角色名·」前缀**，
//  于是主角的字段全解析成「无主」，跑到一张单独的卡里去了。
//  结果是「我的状态」显示的是开局初值、「世界」卡显示的是当下的真实值 ——
//  同一批字段分两份、值还对不上。
//
//  现在：扫描收尾时把无主字段**全部并回 player**（同名用 AI 那份覆盖、
//  新字段整个搬过去），入口条上不再有「世界」这个入口。
//  会话里认不出主角是谁时（既没绑卡、也没玩家角色）原样不动，不瞎认领。
//
//  ⚠️ 这一段**不发消息** —— 后面几个场景都依赖「当前会话的最后一条回复」
//     是它们自己造的那条；在这里多发一轮会把那条顶掉。所以只走数据层。
// ---------------------------------------------------------------------------
await scenario('无主状态字段：并回主角，不单开世界卡', async () => {
  await waitFor('入口条在', () => shown('#panel-box') && !!byId('panel-cast'));

  const panelMod = await import(new URL('js/data/panel.js', document.baseURI).href);
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);

  const convo = (stateMod.state.conversations || []).find((c) => c.id === stateMod.state.activeId);
  check('拿到当前会话', !!convo);
  if (!convo) return;

  const key = (name, owner) => panelMod.panelKey(name, owner);
  const ownerOf = (k) => panelMod.panelFieldOwner(convo, k);
  const nameOf = (k) => panelMod.panelFieldName(k);

  // --- 1) 认得出主角时：无主字段并回 player --------------------------------
  // 这个会话绑了角色卡（上面的场景绑的），所以主角名 = 那张卡的名字。
  const cardMod = await import(new URL('js/data/library.js', document.baseURI).href);
  const boundCard = cardMod.characterById(convo.characterId);
  check('会话绑了角色卡（主角名能从卡上认出来）', !!boundCard, String(convo.characterId));
  if (!boundCard) return;

  // 造三个无主字段（模拟 AI 没带前缀时的输出），覆盖三种认领规则：
  //   · 上衣   —— 角色卡上有这个名字 → 规则 1，归**角色**
  //   · 醉意   —— 主角那边没有、角色卡也没有 → 规则 3，归**主角**
  //   · 好感度 —— 同上（主角那边没这个名字）→ 归主角
  panelMod.appendPanelFields(convo, [
    { name: '上衣', value: '（AI 改成的新衣服）' },
    { name: '好感度', value: '63/100' },
    { name: '醉意', value: '10/100' }
  ]);
  check(
    '造出三个无主字段（模拟 AI 没带前缀时的输出）',
    convo.panelFields.filter((k) => !ownerOf(k)).length === 3,
    JSON.stringify(convo.panelFields.filter((k) => !ownerOf(k)).map((k) => [nameOf(k), ownerOf(k)]))
  );

  panelMod.absorbTopLevelIntoPlayer(convo);

  check(
    '并完之后一个无主字段都不剩',
    !convo.panelFields.some((k) => !ownerOf(k)),
    JSON.stringify(convo.panelFields.map((k) => [nameOf(k), ownerOf(k)]))
  );
  check(
    '规则1：角色卡上声明过的字段名归角色（不是归主角）',
    convo.panel[key('上衣', boundCard.id)] === '（AI 改成的新衣服）',
    JSON.stringify({
      cardOwner: boundCard.id,
      got: convo.panel[key('上衣', boundCard.id)],
      playerGot: convo.panel[key('上衣', 'player')]
    })
  );
  check(
    '规则2：单角色聊天里，AI 自己编的新字段也归那张卡（不归玩家）',
    // 这个会话绑了角色卡、没有玩家角色 → 是单角色聊天，无主字段全归那张卡。
    convo.panelFields.some((k) => ownerOf(k) === boundCard.id && nameOf(k) === '醉意') &&
      !!convo.panel[key('醉意', boundCard.id)],
    JSON.stringify(convo.panelFields.filter((k) => ownerOf(k) === boundCard.id).map(nameOf))
  );

  // --- 2) 认不出主角时：原样不动，不瞎认领 --------------------------------
  const bare = {
    id: 'bare', panel: {}, panelFields: [], panelDefs: {}, messages: [],
    player: null, characterId: null
  };
  panelMod.appendPanelFields(bare, [{ name: '天气', value: '阴' }]);
  panelMod.absorbTopLevelIntoPlayer(bare);
  check(
    '认不出主角是谁时不动无主字段（宁可留着也不瞎认领）',
    bare.panelFields.length === 1 && !panelMod.panelFieldOwner(bare, bare.panelFields[0]),
    JSON.stringify(bare.panelFields)
  );

  // --- 3) 手改优先：player 那边手改过就不被 AI 那份顶掉 --------------------
  const manualConvo = {
    id: 'mc', player: { name: '阿甲' }, characterId: null,
    panel: {}, panelFields: [], panelDefs: {}, messages: []
  };
  panelMod.appendPanelFields(manualConvo, [{ name: '金币', value: '50', owner: 'player' }]);
  panelMod.setPanelField(manualConvo, key('金币', 'player'), '88');
  panelMod.appendPanelFields(manualConvo, [{ name: '金币', value: '12' }]);
  panelMod.absorbTopLevelIntoPlayer(manualConvo);
  check(
    '手改过的值不会被无主那份顶掉',
    manualConvo.panel[key('金币', 'player')] === '88',
    JSON.stringify(manualConvo.panel)
  );
  check(
    '顶掉不成立时无主那份也要清掉（不留重复）',
    !manualConvo.panelFields.some((k) => !panelMod.panelFieldOwner(manualConvo, k)),
    JSON.stringify(manualConvo.panelFields)
  );

  // --- 4) 世界会话（有玩家角色 + 多个角色）：认不出的新字段归主角 ----------
  // 这是规则 4 的独立验证 —— 上面那个会话是单角色聊天，会走规则 2，
  // 覆盖不到「主角」这条分支。这里用一份合成数据（不碰真实会话）。
  const worldLike = {
    id: 'world-like',
    characterId: null,
    player: { name: '露西诺' },
    worldbookIds: [],
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: []
  };
  // 造一个「角色持有上衣」的形状 → 规则 1 该把无主的上衣认给这个角色
  panelMod.appendPanelFields(worldLike, [{ name: '上衣', value: '灰色外套', owner: 'wc_x' }]);
  panelMod.appendPanelFields(worldLike, [
    { name: '上衣', value: '灰色外套（搭在了椅背上）' },
    { name: '体力', value: '34/100' }
  ]);
  panelMod.absorbTopLevelIntoPlayer(worldLike);
  check(
    '世界会话里，没带前缀的字段并回主角（规则 4）',
    worldLike.panel[key('体力', 'player')] === '34/100' &&
      !worldLike.panelFields.some((k) => !panelMod.panelFieldOwner(worldLike, k)),
    JSON.stringify(worldLike.panelFields.map((k) => [panelMod.panelFieldName(k), panelMod.panelFieldOwner(worldLike, k)]))
  );

  // --- 5) 入口条上不再有「世界/场景」这个入口 ------------------------------
  const sceneBtn = $$('#panel-cast .panel-avatar').find(
    (b) => b.dataset.owner === 'scene' || b.dataset.kind === 'scene'
  );
  check(
    '入口条上没有「世界/场景」入口了',
    !sceneBtn,
    JSON.stringify($$('#panel-cast .panel-avatar').map((b) => [b.dataset.owner, b.dataset.kind]))
  );

  // --- 收拾现场：把刚才造的字段恢复原样，别影响后面的场景 -------------------
  // 上衣：规则 1 把它并给了角色卡，恢复成卡上的初始值（「布衣」是那张卡上的值）
  convo.panel[key('上衣', boundCard.id)] = '布衣';
  // 好感度 / 醉意：这次被认领了，删掉（后面 21 场景会自己扫出来）
  for (const n of ['好感度', '醉意']) {
    for (const k of [key(n, 'player'), key(n, boundCard.id)]) {
      convo.panelFields = convo.panelFields.filter((x) => x !== k);
      delete convo.panel[k];
      delete convo.panelDefs[k];
    }
  }
  delete convo.panelManual;
});

// ---------------------------------------------------------------------------
//  场景 9.6：面板字段数到顶时，不能把认领不成的无主字段删掉
//
//  真 bug：absorbTopLevelIntoPlayer 的 claim() 只在「目标键真的建出来了」时才该
//  把源字段划掉，但 remove.add(key) 是无条件执行的。字段数到了 MAX_PANEL_FIELDS(120)
//  之后目标建不出来，源字段却照样被移除 —— 于是**所有**走规则 1/2 的无主字段
//  连同值一起消失，120 个字段能当场塌成 1 个。
//  旁边的规则 3/4 是显式 else if，走不到就什么都不做，两条路本来该一个脾气。
// ---------------------------------------------------------------------------
await scenario('状态字段：字段数到顶时不能把无主的删掉', async () => {
  const panelMod = await import(new URL('js/data/panel.js', document.baseURI).href);
  const libMod = await import(new URL('js/data/library.js', document.baseURI).href);
  const key = (name, owner) => panelMod.panelKey(name, owner);

  const card = libMod.characters()[0];
  check('库里有卡可以拿来当「绑定角色」', !!card, JSON.stringify(libMod.characters().map((c) => c.name)));
  if (!card) return;

  // 合成一份「已经到顶」的会话：119 个无主字段 + 1 个角色持有字段 = 120
  const atCap = {
    id: 'panel-at-cap',
    characterId: card.id,
    player: null,
    worldbookIds: [],
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: []
  };
  panelMod.appendPanelFields(atCap, [{ name: '已归属字段', value: '1', owner: card.id }]);
  for (let i = 0; i < 119; i += 1) {
    panelMod.appendPanelFields(atCap, [{ name: `无主${i}`, value: `v${i}` }]);
  }
  check(
    '先造到 120 个字段（正好到顶）',
    atCap.panelFields.length === panelMod.MAX_PANEL_FIELDS,
    `字段数 ${atCap.panelFields.length} / 上限 ${panelMod.MAX_PANEL_FIELDS}`
  );

  const beforeCount = atCap.panelFields.length;
  const beforeValue = atCap.panel[atCap.panelFields.find((k) => panelMod.panelFieldName(k) === '无主0')];
  panelMod.absorbTopLevelIntoPlayer(atCap);

  check(
    '到顶之后字段数没有被清空',
    atCap.panelFields.length === beforeCount,
    `并完之后 ${atCap.panelFields.length} 个（原来 ${beforeCount} 个）`
  );
  check(
    '无主字段的值还在（认领不成就不动它）',
    atCap.panel[atCap.panelFields.find((k) => panelMod.panelFieldName(k) === '无主0')] === beforeValue,
    JSON.stringify({ want: beforeValue })
  );
});

// ---------------------------------------------------------------------------
//  场景 9.8：分支持久化要照搬「视角设置」
//
//  真 bug：branchSkeleton 的注释写着「戏本身的东西照搬：…视角设置」，实现却漏了
//  narrationMode / paceMode。convoNarrationMode 查不到就回落到
//  默认档 —— 从「上帝视角 + 快节奏」分出来的新线悄悄变成「标准 + 一步一步」，
//  提示词变了、顶栏档位标签没了，全程不报错。
// ---------------------------------------------------------------------------
await scenario('分支：视角设置要跟着走', async () => {
  const convMod = await import(new URL('js/data/conversations.js', document.baseURI).href);
  const key = 'branch-skeleton-source';

  const source = {
    id: key,
    title: '源会话',
    characterId: null,
    worldbookIds: [],
    dialoguePresetIds: null,
    player: { name: '阿甲' },
    panel: {},
    panelFields: [],
    panelDefs: {},
    gmMode: false,
    narrationMode: 'god',
    paceMode: 'brisk',
    messages: [
      { role: 'user', content: '一' },
      { role: 'assistant', content: '二' },
      { role: 'user', content: '三' }
    ],
    summaries: []
  };

  const branch = convMod.branchSkeleton(source, 2);
  check('叙述模式跟着分叉走（不再回落到标准）', branch.narrationMode === 'god', JSON.stringify(branch.narrationMode));
  check('推进节奏跟着分叉走（不再回落到一步一步）', branch.paceMode === 'brisk', JSON.stringify(branch.paceMode));
  check('前两条消息照常复制过去', (branch.messages || []).length === 2, String((branch.messages || []).length));
});

// ---------------------------------------------------------------------------
//  场景 9.9：数字设置框清空后不能静默变成 64 / 1 / 0
//
//  真 bug：`Number('')` 是 **0、不是 NaN**，所以 readSettingsForm 里所有
//  `isNaN(x) ? 默认值 : ...` 的分支全是死代码。把「回复上限」清空再保存，
//  存下去的是被夹到下限的 64（之后每条回复都被截断）；「对话轮数」变 1
//  （历史等于没了）；递归深度变 0。界面重开还显示那个被夹过的值。
//  现在的口径：清空 = 没改，退回原来存着的值。
// ---------------------------------------------------------------------------
await scenario('设置：清空数字框等于没改，不静默夹到下限', async () => {
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));

  const before = ((await window.mimitale.getSettings()).settings || {});
  const beforeMaxTokens = Number(before.maxTokens);
  const beforeMaxTurns = Number(before.maxTurns);

  // 先把两个框设成「一个不同于内置默认值的值」，再清空。
  // 否则「退回原来存着的值」和「退回内置默认值」这两种实现分不出来 ——
  // （回复上限的测试初值就是 512，而内置默认是 8192；对话轮数初值正好是 20=默认，
  //   所以这个场景必须自己先改一下再清空。）
  const probeTokens = beforeMaxTokens === 8192 ? 4096 : beforeMaxTokens;
  const probeTurns = beforeMaxTurns === 20 ? 33 : beforeMaxTurns;
  setValue('#s-maxtokens', String(probeTokens));
  setValue('#s-max-turns', String(probeTurns));
  click('#btn-save-settings');
  await waitFor('探针值已保存', () => !shown('#view-settings'));
  await sleep(150);

  await openSettingsPage();
  await waitFor('设置页打开（改完再清）', () => shown('#view-settings'));
  setValue('#s-maxtokens', '');
  setValue('#s-max-turns', '');
  click('#btn-save-settings');
  await waitFor('设置已保存', () => !shown('#view-settings'));
  await sleep(150);

  const after = ((await window.mimitale.getSettings()).settings || {});
  check(
    '清空「回复上限」不会变成夹取下限 64 / 内置默认 8192',
    Number(after.maxTokens) === probeTokens,
    JSON.stringify({ 探针值: probeTokens, 内置默认: 8192, after: after.maxTokens })
  );
  check(
    '清空「对话轮数」不会变成 1 / 内置默认 20',
    Number(after.maxTurns) === probeTurns,
    JSON.stringify({ 探针值: probeTurns, 内置默认: 20, after: after.maxTurns })
  );

  // 收尾：还原成进这个场景之前的值，后面的场景还等着它们
  await openSettingsPage();
  await waitFor('设置页再开', () => shown('#view-settings'));
  setValue('#s-maxtokens', String(beforeMaxTokens));
  setValue('#s-max-turns', String(beforeMaxTurns));
  click('#btn-save-settings');
  await waitFor('设置已还原', () => !shown('#view-settings'));
});

// ---------------------------------------------------------------------------
//  设置：生成参数输超范围 → 归一化层夹回，并说一句
//
//  `min` / `max` 只是原生属性，手输 99 照样进得去；以前它会原样落盘、原样发给厂商，
//  换回一个用户完全看不懂的 400（「temperature must be <= 2」）。现在夹在
//  main/providers.js 的 normalizeSettings 里（load / save 都过它）。
// ---------------------------------------------------------------------------
await scenario('设置：生成参数越界被夹回并说明', async () => {
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));

  const readSetting = async (key) => ((await window.mimitale.getSettings()).settings || {})[key];
  const beforeTemp = Number(await readSetting('temperature')) || 0.7;
  const beforeTokens = Number(await readSetting('maxTokens')) || 512;

  // 数字框的即时保存挂在 change 上（setValue 只派 input），这里自己派一次
  const commit = (id, value) => {
    const box = byId(id);
    box.value = value;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const settle = async (key, want) => {
    for (let i = 0; i < 60; i += 1) {
      if (Number(await readSetting(key)) === want) return true;
      await sleep(50);
    }
    return false;
  };

  commit('s-temp', '99');
  check('温度 99 被夹回 2', await settle('temperature', 2), `盘上现在是 ${await readSetting('temperature')}`);
  check('提示说了「超出允许范围」', /超出允许范围/.test($('#toast').textContent), $('#toast').textContent);
  check('输入框跟着显示夹回后的值', byId('s-temp').value === '2', byId('s-temp').value);

  commit('s-maxtokens', '1');
  check('回复上限 1 被夹到下限 64', await settle('maxTokens', 64), `盘上现在是 ${await readSetting('maxTokens')}`);

  // 收尾：还原成进这个场景之前的值（后面的场景还等着它们）
  commit('s-temp', String(beforeTemp));
  commit('s-maxtokens', String(beforeTokens));
  const restoredTemp = await settle('temperature', beforeTemp);
  const restoredTokens = await settle('maxTokens', beforeTokens);
  check('还原成功', restoredTemp && restoredTokens,
    `温度 ${await readSetting('temperature')} / 上限 ${await readSetting('maxTokens')}`);
});

// ---------------------------------------------------------------------------
//  场景 9.10：拉取模型列表失败时，「地址写错」不能被说成「这家没有这个接口」
//
//  真 bug：判据里除了状态码还有一段中文关键词匹配，而 main/http.js 给 404 写的
//  提示正是「404 找不到接口：多半是「接口地址」写错了」、给 400 写的是
//  「参数不被该服务商接受」—— 两个词都被撞上，于是地址写错会被当成
//  「这家不支持拉取模型列表」，弹一句成功语气的兜底提示。
// ---------------------------------------------------------------------------
await scenario('设置：地址写错不会被误诊成「没有模型列表接口」', async () => {
  const catMod = await import(new URL('js/views/settingsCatalog.js', document.baseURI).href);
  const looks = catMod.looksLikeUnsupportedModelList;

  // main/http.js 真实产出的那几句（照抄，别改口径）
  const msg404 = '404 找不到接口：多半是「接口地址」写错了，应类似 https://api.deepseek.com。';
  const msg400 = '400 请求被拒绝：多半是参数不被该服务商接受（比如 max_tokens 超范围、模型名不对）。';
  const msg401 = '401 未授权：API Key 不对或已失效。';
  const msg406 = '406 请求不被接受：服务端（或它前面的网关）拒绝了这次请求的格式。';
  const msg405 = '405 Method Not Allowed';

  check('400（参数/鉴权类）不算「没有模型列表接口」', looks(msg400) === false, JSON.stringify(msg400));
  check('401 不算「没有模型列表接口」', looks(msg401) === false, JSON.stringify(msg401));
  check('406 不算（是网关拒了，不是端点不存在）', looks(msg406) === false, JSON.stringify(msg406));

  // 这些才是真的「这个端点不存在」
  check('404 仍然算（兼容层没有 /models 就是它）', looks(msg404) === true, JSON.stringify(msg404));
  check('405 仍然算', looks(msg405) === true, JSON.stringify(msg405));
  check('501 仍然算', looks('501 Not Implemented') === true, '');
});

// ---------------------------------------------------------------------------
//  场景 9.12：发不出去的消息不能把用户打的字吃掉
//
//  真 bug：发送按钮和回车都是「先把输入框清空、再调 sendMessage」，而 sendMessage
//  有一堆早退路径（没配模型、没填 Key、正在生成中）。每一条都会把用户刚打的字丢掉，
//  而且不报错、只弹一句提示 —— 全新安装时第一条「你好」就是这么没的
//  （待发的图片反而是校验之后才清的，所以图还在、字没了）。
//  现在的口径：sendMessage 返回「到底发出去没有」，只有真发出去了才清空。
// ---------------------------------------------------------------------------
await scenario('输入框：发不出去时字要留着', async () => {
  const FILLED = '这段字不能被吃掉';

  // --- 路径一：没填 API Key（最常见的第一次发送） ---
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));
  const keyBefore = byId('p-apikey').value;
  setValue('#p-apikey', '');
  click('#btn-save-settings');
  await waitFor('设置已保存', () => !shown('#view-settings'));
  await sleep(150);

  setValue('#input', FILLED);
  click('#btn-send');
  // 走的是「请先填写 XX 的 API Key」那条早退；未登录时更早一步就挡下（提示先登录），
  // 两条都属于「发不出去」，字同样不能丢。
  await waitFor('弹出缺 Key 的提示', () => {
    const t = byId('toast');
    return t && /API Key|登录/.test(t.textContent || '');
  }, 5000);
  check(
    '没填 Key 时，输入框里的字还在（没被静默清掉）',
    byId('input').value === FILLED,
    JSON.stringify(byId('input').value)
  );
  // 那条提示确实弹出来了（不是「什么都没发生」）
  check(
    '并且说明了为什么发不出去（缺 Key / 要先登录）',
    /API Key|登录/.test((byId('toast') || {}).textContent || ''),
    JSON.stringify(((byId('toast') || {}).textContent) || '')
  );

  // 恢复 Key，别影响后面的场景
  await sleep(200);
  await openSettingsPage();
  await waitFor('设置页再开（恢复 Key）', () => shown('#view-settings'));
  setValue('#p-apikey', keyBefore || 'test-key');
  click('#btn-save-settings');
  await waitFor('Key 已恢复', () => !shown('#view-settings'));
  await sleep(150);

  // --- 路径二：正在生成中按回车（输入框在流式期间并没有禁用） ---
  setValue('#input', '正在生成时打的字');
  // 手动模拟流式状态：合并按钮保持可点并切到 stop 模式。
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const prevStreaming = stateMod.state.streaming;
  stateMod.state.streaming = true;
  byId('btn-send').setAttribute('data-mode', 'stop');
  check('生成中合并按钮仍可点且处于停止模式', !byId('btn-send').disabled && byId('btn-send').dataset.mode === 'stop');

  const composerMod = await import(new URL('js/views/composer.js', document.baseURI).href);
  const didSend = await composerMod.sendMessage('正在生成时打的字');
  check('流式期间 sendMessage 明确报告「没发出去」', didSend === false, JSON.stringify(didSend));
  check(
    '流式期间也不会把输入框清掉',
    byId('input').value === '正在生成时打的字',
    JSON.stringify(byId('input').value)
  );

  stateMod.state.streaming = prevStreaming;
  byId('btn-send').setAttribute('data-mode', 'send');
  setValue('#input', '');
});

// ---------------------------------------------------------------------------
//  场景 9.10b：输入框的快捷短语面板（点一行 = 插进输入框，不发送）
// ---------------------------------------------------------------------------
await scenario('输入框：快捷短语面板', async () => {
  await waitFor('回到聊天页', () => shown('#view-chat'));
  const menu = byId('quick-menu');
  const btn = byId('btn-quick');
  const input = byId('input');

  check('输入框左边有快捷短语按钮', !!btn && !!menu);
  check('面板一开始是收起的', menu.classList.contains('hidden'));

  // --- 打开 ---
  click('#btn-quick');
  await waitFor('面板展开', () => !menu.classList.contains('hidden'));
  check('按钮标成展开态（aria-expanded）', btn.getAttribute('aria-expanded') === 'true');

  const rows = $$('#quick-menu .quick-item');
  check('面板里铺出了快捷短语行', rows.length >= 10, String(rows.length));
  check(
    '第一行是「旁白」，右侧预览就是插进输入框的原文（连括号）',
    /旁白/.test(rows[0].textContent) && /（旁白：）/.test(rows[0].textContent),
    rows[0].textContent
  );
  // 符号行没有预览（插进去的就是符号本身，没什么可预告的）
  const heartRow = rows.find((r) => r.querySelector('.quick-name').textContent === '♡');
  check(
    '符号行（♡）不带预览',
    !!heartRow && !heartRow.querySelector('.quick-hint'),
    heartRow ? heartRow.textContent : '（没找到 ♡ 那一行）'
  );

  // 面板要**贴在输入框正上方**：盖住输入框、或者飘到窗口外，都只能靠几何量看出来
  const boxRect = $('.composer-box').getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  check(
    '面板在输入框正上方（没有盖住输入框）',
    menuRect.bottom <= boxRect.top + 1 && menuRect.top >= 0,
    `menu.bottom=${Math.round(menuRect.bottom)} box.top=${Math.round(boxRect.top)} menu.top=${Math.round(menuRect.top)}`
  );
  check('面板在窗口内、没有横向溢出', menuRect.left >= 0 && menuRect.right <= window.innerWidth + 1,
    `left=${Math.round(menuRect.left)} right=${Math.round(menuRect.right)} 窗口=${window.innerWidth}`);

  // --- 点一行：插进输入框（连括号一起）---
  const msgsBefore = $$('#messages .msg').length;
  setValue('#input', '');
  input.setSelectionRange(0, 0);
  rows[0].click();
  await waitFor('点完收起', () => menu.classList.contains('hidden'));
  check('点一行把整条指令插进了输入框（连括号，不是发出去）', input.value === '（旁白：）', JSON.stringify(input.value));
  check(
    '插入后光标停在右括号**里面**（接着就能写内容）',
    input.selectionStart === 4 && input.selectionEnd === 4,
    String(input.selectionStart)
  );
  // ⚙ 组件化之后 #input 是 `<m-textarea>` 的宿主，焦点在**里层那颗原生框**上 ——
  //    直接拿宿主比 `document.activeElement` 恒不相等（假红，坏的是断言自己）。
  check('插入后焦点回到输入框（接着就能打字）', document.activeElement === asControl(input));
  check('插入不会直接发消息', $$('#messages .msg').length === msgsBefore, `${msgsBefore} → ${$$('#messages .msg').length}`);
  check('收起后按钮不再是展开态', btn.getAttribute('aria-expanded') === 'false');

  // 光标真的在括号里：接着敲两个字，应该落在「：」和「）」之间
  input.setRangeText('雨停了。', input.selectionStart, input.selectionEnd, 'end');
  check(
    '打进去的字落在括号里（（旁白：雨停了。））',
    input.value === '（旁白：雨停了。）',
    JSON.stringify(input.value)
  );

  // --- 插到光标处（不是无脑追加到末尾）---
  setValue('#input', 'AB');
  input.setSelectionRange(1, 1);
  click('#btn-quick');
  await waitFor('面板再展开', () => !menu.classList.contains('hidden'));
  $$('#quick-menu .quick-item')[0].click();
  check('插在光标处而不是末尾', input.value === 'A（旁白：）B', JSON.stringify(input.value));

  // --- 整句指令：插进来的就是那行右侧预览的原文 ---
  setValue('#input', '');
  input.setSelectionRange(0, 0);
  click('#btn-quick');
  await waitFor('面板第三次展开', () => !menu.classList.contains('hidden'));
  const rowTexts = $$('#quick-menu .quick-item').map((r) => r.textContent);
  const pushRow = $$('#quick-menu .quick-item').find((r) => r.querySelector('.quick-name').textContent === '推进剧情');
  check('面板里有「推进剧情」这一行', !!pushRow, rowTexts.join(' | '));
  pushRow.click();
  check('整句指令原样插进来', input.value === '（推进剧情到下一个场景）', JSON.stringify(input.value));

  // --- Esc 收起 ---
  click('#btn-quick');
  await waitFor('面板展开（等 Esc）', () => !menu.classList.contains('hidden'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 收起面板', () => menu.classList.contains('hidden'));
  check('Esc 收起后焦点仍在输入框', document.activeElement === asControl(input));

  // --- 点别处收起 ---
  click('#btn-quick');
  await waitFor('面板展开（等点别处）', () => !menu.classList.contains('hidden'));
  document.body.click();
  await waitFor('点别处收起面板', () => menu.classList.contains('hidden'));
  check('点别处会收起面板', menu.classList.contains('hidden'));

  // --- 键盘、重复初始化和选区替换 ---
  const quickMod = await import(new URL('js/views/quickPhrases.js', document.baseURI).href);
  quickMod.initQuickPhrases();
  check('重复初始化不重复插入图标', btn.querySelectorAll('svg').length === 1);
  btn.focus();
  btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  check('向上键从按钮展开并聚焦最后一行', !menu.classList.contains('hidden') && document.activeElement === rows[rows.length - 1]);
  const key = (value) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  key('Home');
  check('Home 聚焦第一行', document.activeElement === rows[0]);
  key('ArrowDown');
  check('向下键聚焦下一行', document.activeElement === rows[1]);
  key('ArrowUp');
  check('向上键聚焦上一行', document.activeElement === rows[0]);
  key('End');
  check('End 聚焦最后一行', document.activeElement === rows[rows.length - 1]);
  input.focus();
  // 后台 Electron 窗口可能不派发原生 focusin，显式模拟 Tab 的焦点事件。
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  check('焦点离开菜单时自动收起', menu.classList.contains('hidden'));

  setValue('#input', '甲乙丙');
  input.setSelectionRange(1, 2);
  click('#btn-quick');
  check('重复初始化后按钮仍正常展开', !menu.classList.contains('hidden'));
  rows[0].click();
  check('选区替换保留两侧文字和完整括号', input.value === '甲（旁白：）丙' && input.selectionStart === 5);

  click('#btn-more');
  click('#btn-quick');
  check('展开快捷短语会关闭其它菜单', !shown('#topbar-more') && shown('#quick-menu'));
  document.body.click();

  // --- 输入框跟着内容长高（composer.autoGrowInput）---
  //  ⚙ 2026-10-16 组件化时**这条链路原来是零覆盖**：`autoGrowInput` 曾经读写
  //    `el.input.style.height / scrollHeight`，而组件化之后宿主不是那颗被量/被写的
  //    元素 —— 改成过 controlOf() 才继续有效。没有断言的话，这类「静默失效」
  //    （不报错、框就是不长高）只能靠人肉发现。
  {
    const box = asControl(input);
    setValue('#input', '');
    await sleep(80);
    const h0 = Math.round(box.getBoundingClientRect().height);
    setValue('#input', Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`).join('\n'));
    await sleep(80);
    const h1 = Math.round(box.getBoundingClientRect().height);
    check('输入框跟着内容长高', h1 > h0, `${h0} → ${h1}px`);
    check('长高有上限（CONFIG.MAX_INPUT_HEIGHT = 190）', h1 <= 190, `${h1}px`);
    setValue('#input', '');
    await sleep(80);
    check('清空后缩回原始高度', Math.abs(Math.round(box.getBoundingClientRect().height) - h0) <= 2,
      `${h0} → ${Math.round(box.getBoundingClientRect().height)}px`);
  }

  // 收尾：别把字留给后面的场景
  setValue('#input', '');
});

// ---------------------------------------------------------------------------
//  场景 9.11：数值字段不能把非数值内容写成「烦躁/100」
// ---------------------------------------------------------------------------
await scenario('状态字段：数值字段不吞非数值内容', async () => {
  const panelMod = await import(new URL('js/data/panel.js', document.baseURI).href);
  const key = (name, owner) => panelMod.panelKey(name, owner);

  const convo = {
    id: 'meter-guard',
    characterId: null,
    player: { name: '阿甲' },
    worldbookIds: [],
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: []
  };

  // 数值字段（0-100）却收到一个中文值 —— 属性值输入框本来就是自由文本，
  // 切类型也不会清掉已输入的内容，所以这条路很容易走到。
  panelMod.appendPanelFields(convo, [
    { name: '心情', type: 'meter', min: 0, max: 100, value: '烦躁', owner: 'player' }
  ]);
  const moodKey = convo.panelFields.find((k) => panelMod.panelFieldName(k) === '心情');
  check(
    '非数值内容不会被拼上「/100」',
    convo.panel[moodKey] === '烦躁',
    JSON.stringify(convo.panel[moodKey])
  );

  // 真的只写了分子时，仍要补齐分母（老行为不能丢）
  panelMod.appendPanelFields(convo, [
    { name: '体力', type: 'meter', min: 0, max: 100, value: '60', owner: 'player' }
  ]);
  const hpKey = convo.panelFields.find((k) => panelMod.panelFieldName(k) === '体力');
  check(
    '只写分子（60）时仍然补成 60/100',
    convo.panel[hpKey] === '60/100',
    JSON.stringify(convo.panel[hpKey])
  );

  // --- 幽灵字段：玩家没填名字时，注入用的前缀是「我」，
  //     模型照着抄回来必须还能反查成 player，不能变成一条新的无主字段 ---
  const nameless = {
    id: 'ghost-owner',
    characterId: null,
    player: { name: '' },
    worldbookIds: [],
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: []
  };
  panelMod.appendPanelFields(nameless, [
    { name: '好感度', value: '80', owner: 'player' }
  ]);
  const label = panelMod.panelOwnerLabel(nameless, 'player');
  check('没填名字时前缀是「我」', label === '我', JSON.stringify(label));

  // 关键：注入用的是这个前缀，模型会照着抄回来 —— 它必须能被反查回 player，
  // 否则「我·好感度」就成了一条新的无主字段（状态卡多一行重复、真字段停在旧值）
  const backTo = panelMod.ownerIdByLabel(nameless, label);
  check(
    '「我」这个前缀能反查回 player（不会变成幽灵字段）',
    backTo === 'player',
    JSON.stringify({ label, backTo })
  );
});

// ---------------------------------------------------------------------------
//  场景 10：聊天 —— 发一条能收到回复
// ---------------------------------------------------------------------------
await scenario('深度思考：会话参数透传', async () => {
  const { effectiveSampling } = await import('../renderer/js/data/messages.js');
  check('未设置时不强制思考参数', effectiveSampling({})?.thinking === undefined);
  check('旧会话思考开关不覆盖统一设置', effectiveSampling({ sampling: { thinking: true } })?.thinking === undefined);
  check('旧会话关闭思考不覆盖默认', effectiveSampling({ sampling: { thinking: false } })?.thinking === undefined);
  check('思考参数拒绝非布尔值', effectiveSampling({ sampling: { thinking: 'true' } })?.thinking === undefined);
});

await scenario('生成准备：停止后解除等待', async () => {
  const { sendMessage, stopGenerating } = await import('../renderer/js/views/composer.js');
  const { state: appState } = await import('../renderer/js/core/state.js');
  // 不替换冻结的preload桥；测试通过原生异步准备入口立即停止。
  const pending = sendMessage('验证准备阶段停止');
  await stopGenerating();
  await pending;
  check('准备阶段停止后恢复发送', !appState.streaming && !byId('btn-send').disabled);
  check('停止后没有悬挂请求', !appState.requestId && !appState.requestTarget);
});

await scenario('生成中导航返回并停止', async () => {
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const convoId = stateMod.state.activeId;
  const convo = stateMod.state.conversations.find((item) => item.id === convoId);
  setValue('#input', '[NAV_STOP_TEST] 测试延迟生成');
  click('#btn-send');
  await waitFor('慢流已进入停止模式', () => byId('btn-send').dataset.mode === 'stop', 5000);
  await waitFor('慢流助手占位已出现', () => !!$('#messages .msg.assistant .waiting'), 5000);

  setValue('#input', '导航期间保留的草稿');
  click('#btn-chars');
  await waitFor('生成期间进入角色卡', () => shown('#view-chars'));
  click($('#convo-list .convo-item.active'));
  await waitFor('点击当前会话返回聊天', () => shown('#view-chat'));
  check('返回后仍是原活动会话', stateMod.state.activeId === convoId);
  check('返回时生成仍在继续、停止模式可用', stateMod.state.streaming && byId('btn-send').dataset.mode === 'stop' && !byId('btn-send').disabled);

  click('#btn-send');
  await waitFor('停止完成且合并按钮恢复发送', () => !stateMod.state.streaming && byId('btn-send').dataset.mode === 'send', 8000);
  await waitFor('慢流发送内容已进入会话', () => (convo?.messages || []).some((message) => message.role === 'user' && message.content.includes('[NAV_STOP_TEST]')));
  check('停止后活动会话未切换', stateMod.state.activeId === convoId);
  check('草稿保留且未被误发', byId('input').value === '导航期间保留的草稿' && !(convo?.messages || []).some((message) => message.role === 'user' && message.content === '导航期间保留的草稿'));
  check('停止后按钮保持可点并恢复发送模式', !byId('btn-send').disabled && byId('btn-send').dataset.mode === 'send');
  setValue('#input', '');
});

await scenario('聊天：发送与回复', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  // 用「消息条数」判断新回复，而不是找某个文字 ——
  // 这个会话里可能已经有别的回复带着同样的文字了（属性场景就发过一条）
  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '冒烟测试：你好');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('助手回复出现', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);
  await waitFor('流式状态结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  check('用户消息已渲染', $('#messages').textContent.includes('冒烟测试：你好'));
  check('助手回复已渲染', $('#messages').textContent.includes('冒烟测试回复'));
  check('没有出现错误气泡', $$('#messages .msg.error').length === 0);
  check('合并按钮恢复发送模式且保持可点', byId('btn-send').getAttribute('data-mode') === 'send' && !byId('btn-send').disabled);

  // 重点的两档样式：**加粗** 和 ==高亮== 要变成真元素，而不是原样显示星号/等号
  const strong = $('#messages strong');
  check('**加粗** 渲染成了 <strong>', !!strong && strong.textContent === '这是加粗', strong ? strong.textContent : `原始文本里有没有 **：${$('#messages').textContent.includes('**')}`);
  const em = $('#messages .msg-em');
  check('==高亮== 渲染成了 .msg-em', !!em && em.textContent === '这是高亮', em ? em.textContent : '没找到 .msg-em');
  check('标记符号本身没有露出来', !$('#messages').textContent.includes('**') && !$('#messages').textContent.includes('=='), $('#messages').textContent.slice(0, 80));
});

// ---------------------------------------------------------------------------
//  场景 11：消息 —— 就地编辑 + 继续生成
// ---------------------------------------------------------------------------
await scenario('消息：编辑与继续', async () => {
  const assistantNodes = () => $$('#messages .msg.assistant');
  const lastNode = () => assistantNodes().pop();
  const actionsOf = (node) => Array.from(node.querySelectorAll('.msg-actions .mini-btn')).map((b) => b.textContent.trim());

  check('有 AI 回复可以操作', assistantNodes().length >= 1, `实际 ${assistantNodes().length} 条`);

  // --- 「继续」只该出现在最后一条，中间的回复后面早就接上别的话了 ---
  check('最后一条上有「继续」', actionsOf(lastNode()).includes('继续'), JSON.stringify(actionsOf(lastNode())));
  if (assistantNodes().length > 1) {
    const first = assistantNodes()[0];
    check('中间那条没有「继续」', !actionsOf(first).includes('继续'), JSON.stringify(actionsOf(first)));
  }
  check('每条都有「编辑」', actionsOf(lastNode()).includes('编辑'), JSON.stringify(actionsOf(lastNode())));

  // --- 「⋯」：低频按钮默认收起、点开才显形（2026-10-13「工具条收一收」）---
  // 守的是「收起来之后**还打不打得开**」。只断文字存在是不够的 ——
  // 那些按钮一直在 DOM 里（只是 display:none），.open 挂不上时断言照样全绿，
  // 而用户是真点不到「继续 / 配图 / 分支 / 删除」的。
  {
    const bar = () => lastNode().querySelector('.msg-actions');
    const extraNow = () => bar().querySelector('.mini-extra');
    const moreNow = () => bar().querySelector('.mini-more');

    check('工具条末尾有「⋯」在（低频按钮收在它后面）', !!moreNow() && !!extraNow());
    check(
      '常显的是 继续 / 重新生成 / 帮我想想 + ⋯',
      Array.from(bar().querySelectorAll('.mini-btn'))
        .filter((b) => getComputedStyle(b).display !== 'none')
        .map((b) => b.textContent.trim())
        .join(',') === '继续,重新生成,帮我想想,⋯',
      Array.from(bar().querySelectorAll('.mini-btn'))
        .filter((b) => getComputedStyle(b).display !== 'none')
        .map((b) => b.textContent.trim())
        .join(',')
    );
    check(
      '低频按钮默认是收起的',
      !!extraNow() && getComputedStyle(extraNow()).display === 'none',
      extraNow() ? getComputedStyle(extraNow()).display : '(没有低频按钮)'
    );

    check('隐藏操作按复制、编辑、删除、分支排序',
      Array.from(bar().querySelectorAll('.mini-extra')).map(b => b.textContent.trim()).filter(text => text !== '配图').join(',') === '复制,编辑,删除,分支');
    await openMsgMore(lastNode());
    check(
      '点「⋯」后低频按钮显形',
      !!extraNow() && getComputedStyle(extraNow()).display !== 'none',
      extraNow() ? getComputedStyle(extraNow()).display : '(没有低频按钮)'
    );

    click(moreNow());
    await sleep(60);
    check('再点一下「⋯」收起', !bar().classList.contains('open'));
  }

  // --- 继续：应该是「追加」，不是「替换」---
  const before = lastNode().querySelector('.msg-content').textContent;
  click(buttonByText(lastNode(), '继续'));
  await waitFor('内容变长', () => {
    const node = lastNode();
    return node && node.querySelector('.msg-content').textContent.length > before.length;
  }, 8000);
  await waitFor('流式结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  const after = lastNode().querySelector('.msg-content').textContent;
  check('继续是追加而不是替换', after.startsWith(before) && after.length > before.length, `${before.length} 字 → ${after.length} 字`);
  check('原来那段一个字没少', after.slice(0, before.length) === before);

  // --- 编辑：先试「取消」---
  click(buttonByText(lastNode(), '编辑'));
  await waitFor('出现编辑框', () => !!lastNode().querySelector('.msg-edit-box'));
  // 编辑框里必须是**原文**（带 ** == 这些标记），不能是渲染后的文本 ——
  // 给渲染后的文本一保存，标记就没了
  const boxValue = lastNode().querySelector('.msg-edit-box').value;
  check('编辑框里给的是原文而不是渲染结果', boxValue.includes('**这是加粗**') && boxValue.includes('==这是高亮=='), boxValue.slice(0, 40));
  check('原文和屏幕上显示的长度不一样（正好说明给的是源文本）', boxValue.length !== after.length, `源 ${boxValue.length} 字 / 显示 ${after.length} 字`);

  // 编辑框比原来的气泡高，展开后「保存 / 取消」可能被顶到视口外面去
  // （截图时真踩到过：只滚 textarea 没用，被切掉的是它下面那行按钮）
  const listRect = byId('messages').getBoundingClientRect();
  const actionsRect = lastNode().querySelector('.msg-edit-actions').getBoundingClientRect();
  check(
    '「保存 / 取消」在视口里（没被顶出去）',
    actionsRect.bottom <= listRect.bottom + 1,
    `按钮底 ${Math.round(actionsRect.bottom)} / 容器底 ${Math.round(listRect.bottom)}`
  );

  setValue(lastNode().querySelector('.msg-edit-box'), '不该被保存的内容');
  click(buttonByText(lastNode(), '取消'));
  await sleep(200);
  check('取消后原文没变', lastNode().querySelector('.msg-content').textContent === after);

  // --- 空内容要拦住（想删就用「删除」）---
  click(buttonByText(lastNode(), '编辑'));
  await waitFor('出现编辑框', () => !!lastNode().querySelector('.msg-edit-box'));
  setValue(lastNode().querySelector('.msg-edit-box'), '   ');
  click(buttonByText(lastNode(), '保存'));
  await sleep(200);
  check('空内容不许保存', !!lastNode().querySelector('.msg-edit-box'));

  // --- 真正保存 ---
  setValue(lastNode().querySelector('.msg-edit-box'), '改过的回复内容：**加粗**');
  click(buttonByText(lastNode(), '保存'));
  await waitFor('内容被替换', () => $('#messages').textContent.includes('改过的回复内容'), 5000);
  await sleep(250);

  check('保存后正文换成新的了', lastNode().querySelector('.msg-content').textContent.includes('改过的回复内容'));
  check('保存后编辑框收起', !lastNode().querySelector('.msg-edit-box'));
  check('新内容里的标记照样渲染', !!lastNode().querySelector('strong'), '没渲染出 <strong>');

  // --- 落盘 ---
  await sleep(450);
  const convos = (await window.mimitale.getConversations()).conversations;
  const edited = convos.find((c) => (c.messages || []).some((m) => m.content === '改过的回复内容：**加粗**'));
  check('编辑结果落盘了', !!edited);
});

// ---------------------------------------------------------------------------
//  场景 12：重新生成候选（swipe）
// ---------------------------------------------------------------------------
await scenario('消息：重新生成候选', async () => {
  const lastNode = () => $$('#messages .msg.assistant').pop();
  const navOf = (node) => node.querySelector('.variant-nav');
  const countOf = (node) => {
    const nav = navOf(node);
    return nav ? nav.querySelector('.variant-count').textContent.trim() : null;
  };
  const contentOf = (node) => node.querySelector('.msg-content').textContent;

  // 还没重新生成过：不该有候选切换
  check('只有一个版本时没有候选切换', !navOf(lastNode()), countOf(lastNode()) || '（没有）');

  const before = contentOf(lastNode());

  // --- 重新生成：应该「多出一条候选」，而不是把老的扔掉 ---
  click(buttonByText(lastNode(), '重新生成'));
  // ⚠️ 别只等 `btn-send.disabled === false` —— 那颗按钮**在流式开始之前就是可点的**：
  //    点完「重新生成」还要先 await 世界书匹配 / 语义检索两轮预检，才轮到
  //    `setStreaming(true)`。而 waitFor 是**先求值、再等**，于是这个条件当场为真、
  //    等于没等 —— 机器一忙就会在「正在思考」那一刻去断言，报出来的却是「正文不对」。
  //    （2026-10-09 实测：忙的那一次连累出 3 个场景红 —— 这条 + 后面的切会话、导出，
  //      因为流没结束 → `state.streaming` 一直是 true → 点会话条被 `switchConvo`
  //      的守卫挡下 → 视图没切回去 → 后面全歪。闲的那一次 1160/1160 绿。）
  //
  //    两个条件缺一不可：候选切换出现了（那一下是 push + renderAll 画的，
  //    但它画在 `setStreaming(true)` **之前**，所以单独用它也不够）+ 流式确实结束了。
  await waitFor(
    '生成完',
    () => !!navOf(lastNode()) && byId('btn-send').getAttribute('data-mode') === 'send',
    10000
  );
  await sleep(250);

  check('重新生成后出现候选切换', !!navOf(lastNode()));
  check('计数是 2/2（停在刚生成的那条）', countOf(lastNode()) === '2/2', countOf(lastNode()));

  const after = contentOf(lastNode());
  check('显示的是新生成的那条', after !== before && after.includes('冒烟测试回复'), after.slice(0, 24));

  // --- 往左翻：应该回到老的那条 ---
  click(navOf(lastNode()).querySelectorAll('button')[0]);
  await sleep(250);
  check('左翻后计数变 1/2', countOf(lastNode()) === '1/2', countOf(lastNode()));
  check('左翻后正文回到老的那条', contentOf(lastNode()) === before, contentOf(lastNode()).slice(0, 24));
  check('刚才那条没丢（正文不是空的）', contentOf(lastNode()).length > 0);

  // --- 往右翻回来 ---
  click(navOf(lastNode()).querySelectorAll('button')[1]);
  await sleep(250);
  check('右翻后计数变 2/2', countOf(lastNode()) === '2/2', countOf(lastNode()));
  check('右翻后正文又变回新的那条', contentOf(lastNode()) === after);

  // --- 翻回第一条收尾：后面的场景（导出）要看正文里有「改过的回复内容」---
  click(navOf(lastNode()).querySelectorAll('button')[0]);
  await sleep(250);
  check('收尾时停在第一条', countOf(lastNode()) === '1/2', countOf(lastNode()));

  // --- 落盘 ---
  await sleep(450);
  const convos = (await window.mimitale.getConversations()).conversations;
  const withVariants = convos
    .flatMap((c) => c.messages || [])
    .find((m) => Array.isArray(m.variants) && m.variants.length > 1);
  check('候选数组落盘了', !!withVariants, JSON.stringify(withVariants && withVariants.variants.map((v) => String(v).slice(0, 12))));
  check('落盘了两条候选', !!withVariants && withVariants.variants.length === 2, String(withVariants && withVariants.variants.length));
  check(
    'content 和当前选中的候选一致',
    !!withVariants && withVariants.content === withVariants.variants[withVariants.variantIndex],
    JSON.stringify({ idx: withVariants && withVariants.variantIndex })
  );
});

// ---------------------------------------------------------------------------
//  回归：摘要覆盖点越界时，不能把用户刚说的话从上下文里切掉
//
//  真 bug：buildApiMessages 里 `covered` 是在 convoContextMessages()（只认正文非空）
//  上数出来的下标，却拿去 slice 另一个数组 history（它多留「只带图不打字」的消息）。
//  两个数组一旦不等长，covered 就越界，slice 回来是空数组 ——
//  整轮请求只剩摘要 + 人设，**用户刚打的那句话都不会发出去**，模型照着旧摘要答，
//  表现得像完全没看见你说了什么。
//
//  最容易撞上的路径：一个已经被自动摘要过的老会话 → 「清空对话」→ 重新开聊。
//  消息清空了，convo.summaries 还原封不动留着，covered 就成了一个巨大的下标。
//
//  这里不依赖任何界面状态，直接用真模块算一遍。
// ---------------------------------------------------------------------------
await scenario('摘要：覆盖点越界也不能吞掉当前对话', async () => {
  let messagesMod = null;
  let stateMod = null;
  try {
    messagesMod = await import(new URL('js/data/messages.js', document.baseURI).href);
    stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
    check('上下文拼装模块能加载', typeof messagesMod.buildApiMessages === 'function');
  } catch (err) {
    check('上下文拼装模块能加载', false, (err && err.message) || String(err));
  }

  if (!messagesMod || typeof messagesMod.buildApiMessages !== 'function') return;

  const savedSettings = stateMod.state.settings;
  stateMod.state.settings = { ...(savedSettings || {}), maxTurns: 20 };

  // 「清空对话」之后的现场：摘要还留着（覆盖到第 28 条），消息只剩一条是真的。
  // 前后那两条是**老存档里遗留**的「只带图不打字」的用户消息（「发图」入口 2026-10-08
  // 已经去掉），末尾还挂着一条空的 assistant 占位 —— 这几种都不能被原样发出去。
  const convo = {
    id: 'smoke-stale-summary',
    messages: [
      { role: 'user', content: '', images: ['data:image/png;base64,AAA'] },
      { role: 'user', content: '刚打的一句话' },
      { role: 'user', content: '', images: ['data:image/png;base64,BBB'] },
      { role: 'assistant', content: '' }
    ],
    summaries: [{ start: 0, end: 28, title: '第 1 段', text: '以前的剧情…' }]
  };

  const out = messagesMod.buildApiMessages(convo, '', '', '');
  const dialogue = out.filter((m) => m.role === 'user' || m.role === 'assistant');
  const texts = dialogue.map((m) => String(m.content || ''));

  check('越界的摘要覆盖点不会把对话切空', dialogue.length > 0, `对话消息 ${dialogue.length} 条`);
  check(
    '用户刚打的那句话还在发给模型的请求里',
    texts.some((t) => t.includes('刚打的一句话')),
    JSON.stringify(texts.map((t) => t.slice(0, 16)))
  );
  // 「只带图不打字」的老消息和末尾的空占位都必须被滤掉：它们没有文字，
  // 原样发出去就是一条 content 为空的 user / assistant 消息，严格的接口直接 400。
  // （图不再转多模态数组之后，这条是唯一的防线 —— 之前靠「转成数组」顺带躲过去的。）
  check(
    '没有 content 为空的消息被发出去',
    dialogue.length > 0 && dialogue.every((m) => String(m.content || '').trim()),
    JSON.stringify(dialogue.map((m) => ({ role: m.role, len: String(m.content || '').length })))
  );
  check(
    '摘要仍然照常注入（该省的历史没白省）',
    out.some((m) => String(m.content || '').includes('以前的剧情')),
    ''
  );

  stateMod.state.settings = savedSettings;
});

// ---------------------------------------------------------------------------
//  回归：设置里的「默认人设」只能进「跟模型聊天」的会话，不许漏进世界模式 / 角色卡
//
//  真 bug：buildApiMessages 里人设原来写成 `character ? '' : assistantPersona(convo)`。
//  绑了卡时 character 为真所以没事，但**进世界（GM）时 character 是 null** ——
//  于是那段模型人设照样被拼进系统提示词。现场就是：GM 一手拿着世界书里的大学设定，
//  一手自称「鲸鱼娘」，回复里还在纠结「我到底是哪边的人」（用户报的原文）。
//
//  这条和页面侧、宿主侧的探针是三件事：
//    · 页面侧只验表单读写得对（probeAssistantPersona 那一段的界面部分）
//    · 宿主侧探针验的是**真的发出去的那份**（默认对话里带人设、且不带扮演规则）
//    · 这里补的是**反面**：世界模式 / 角色卡里一个字的模型人设都不该有
//  直接用真模块算，不依赖界面状态，最省事也最稳。
// ---------------------------------------------------------------------------
await scenario('默认人设：只进通用对话，不漏进世界模式和角色卡', async () => {
  let messagesMod = null;
  let stateMod = null;
  try {
    messagesMod = await import(new URL('js/data/messages.js', document.baseURI).href);
    stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
    check('上下文拼装模块能加载', typeof messagesMod.buildApiMessages === 'function');
  } catch (err) {
    check('上下文拼装模块能加载', false, (err && err.message) || String(err));
  }
  if (!messagesMod || typeof messagesMod.buildApiMessages !== 'function') return;

  const savedSettings = stateMod.state.settings;
  const backupChars = stateMod.state.characters;
  const MARK = '你是一只叫团子的猫';
  const PERSONA_NAME = '团子';
  const MODEL = '人设守卫模型';

  // 人设按**模型名**查表，所以给这个模型装一份，再让各条会话都用它。
  stateMod.state.settings = {
    ...(savedSettings || {}),
    maxTurns: 20,
    activeModel: MODEL,
    assistantPersonas: { [MODEL]: { name: PERSONA_NAME, persona: `${MARK}，只用喵喵叫回应。` } }
  };
  stateMod.state.characters = [
    ...(Array.isArray(backupChars) ? backupChars : []),
    {
      id: 'smoke-persona-card',
      name: '顾言',
      systemPrompt: '你是顾言，樱川大学摄影社的学长。',
      description: '',
      personality: ''
    }
  ];

  const blob = (out) => out.map((m) => String((m && m.content) || '')).join('\n');

  try {
    // --- 1) 世界模式（GM）：没有「某个人」，人设一个字都不该有 ---
    const gmConvo = {
      id: 'smoke-persona-gm',
      model: MODEL,
      gmMode: true,
      worldbookIds: [],
      player: { name: '小怡', profile: '大一女生。' },
      messages: [{ role: 'user', content: '扫完立刻通过，顺手给他改个备注' }]
    };
    // 世界书段由调用方拼好传进来：这里塞一个 {{char}} 进去，
    // 顺带验「GM 下没有具体角色，宏落成叙述者」——人设名绝不能出现在这儿。
    const gmOut = blob(messagesMod.buildApiMessages(gmConvo, '【世界设定】\n{{char}} 是这里的叙述者。', ''));
    check('世界模式：没混进「默认人设」正文', !gmOut.includes(MARK), gmOut.slice(0, 90));
    check('世界模式：也没混进人设的名字', !gmOut.includes(PERSONA_NAME), gmOut.slice(0, 90));
    check('世界模式：主持规则照常注入', gmOut.includes('【主持规则】'));
    check('世界模式：玩家角色段照常注入', gmOut.includes('【玩家角色：小怡】'));
    check(
      '世界模式：{{char}} 落成「叙述者」，不是人设名',
      gmOut.includes('叙述者 是这里的叙述者') && !gmOut.includes(`${PERSONA_NAME} 是`),
      gmOut.slice(0, 90)
    );

    // --- 2) 绑角色卡的会话：卡自己的 systemPrompt 说了算，人设不参与 ---
    const cardConvo = {
      id: 'smoke-persona-card-convo',
      model: MODEL,
      characterId: 'smoke-persona-card',
      messages: [{ role: 'user', content: '你好' }]
    };
    const cardOut = blob(messagesMod.buildApiMessages(cardConvo, '', ''));
    check('角色卡：没混进「默认人设」正文', !cardOut.includes(MARK), cardOut.slice(0, 90));
    check('角色卡：用上了卡自己的 systemPrompt', cardOut.includes('樱川大学摄影社的学长'));
    check('角色卡：扮演规则照常注入', cardOut.includes('【扮演规则】'));

    // --- 3) 通用对话（对照组）：人设必须照旧生效，别修反了 ---
    const plainConvo = {
      id: 'smoke-persona-plain',
      model: MODEL,
      messages: [{ role: 'user', content: '你好' }]
    };
    const plainOut = blob(messagesMod.buildApiMessages(plainConvo, '', ''));
    check('通用对话：人设正文照旧注入', plainOut.includes(MARK), plainOut.slice(0, 90));
    check(
      '通用对话：仍然不带扮演 / 主持规则',
      !plainOut.includes('【扮演规则】') && !plainOut.includes('【主持规则】')
    );

    // --- 3b) 纯聊天不带「视角设置」（2026-10-13 加）---
    //
    // 真 bug：新会话生下来就带着 narrationMode='standard' + paceMode='step' 两个**默认值**，
    // 而叙述模式 / 推进节奏当时对普通聊天**也注入** —— 于是「＋ 新对话」拿到的 system 里
    // 有一整套舞台指示（写环境、写动作、「一轮里至少要有一句角色直接说出口的话」），
    // 模型没有身份，就自己编一个演起来（用户报的现场：新对话里 AI 自己坐在地毯上修台灯）。
    // 默认人设里那句「像跟朋友聊天那样自然、不要写成报告」压不住它 —— 那两段排在后面，
    // 离生成位置更近。
    //
    // 这里**故意把档位设成偏离默认**（上帝视角 + 快节奏）再验：存着也不许注入 ——
    // 光验默认值是不够的，那种写法「手动改过一档就漏」。
    const plainViewOut = blob(
      messagesMod.buildApiMessages({ ...plainConvo, narrationMode: 'god', paceMode: 'brisk' }, '', '')
    );
    check(
      '通用对话：不带【叙述要求】（会话上存着「上帝视角」也不注入）',
      !plainViewOut.includes('【叙述要求】'),
      plainViewOut.slice(0, 120)
    );
    check(
      '通用对话：不带【推进节奏】（会话上存着「快节奏」也不注入）',
      !plainViewOut.includes('【推进节奏】'),
      plainViewOut.slice(0, 120)
    );

    // --- 3c) 反面：角色卡会话的视角设置一个字都不许少（别修反了）---
    check(
      '角色卡：叙述模式照常注入',
      cardOut.includes('【叙述要求】'),
      cardOut.slice(0, 120)
    );
    check(
      '角色卡：推进节奏照常注入（由【扮演规则】内部带出来）',
      cardOut.includes('【推进节奏】'),
      cardOut.slice(0, 120)
    );
  } finally {
    stateMod.state.settings = savedSettings;
    stateMod.state.characters = backupChars;
  }
});

// ---------------------------------------------------------------------------
//  世界书「常驻条目深度注入」：位置对不对
//
//  背景：社区卡把「不许代写玩家」「输出格式」这类**规则**做成常驻条目（constant），
//  在酒馆里作者能把它们放到 at depth（贴近生成位置）。我们原来的做法是把整块世界书
//  钉在人设之后（第 2 条消息），后面还压着历史 / 面板 / 后置指令 —— 几万 token 之后
//  模型早忘了，于是「同一张卡在我们这儿的约束力弱于酒馆」。
//
//  现在：关键词条目照旧跟在人设之后；常驻条目单独一块，插在**对话后指令之后、
//  「主角不可代写」之前**。这里直接用真模块算索引，不依赖界面。
//
//  ⚠️ 最后一条（deep 必须排在【主角不可代写】**之前**）是这次改动最容易修坏的地方：
//     `playerOwnershipReminder` 存在的理由就是「世界书条目太贴近生成位置，模型会把玩家
//     也当 NPC 写」。把常驻条目压到它后面 = 把这道闸拆掉，会变成「修一个坏一个」。
// ---------------------------------------------------------------------------
await scenario('世界书：常驻条目注入到靠近落笔的位置', async () => {
  let messagesMod = null;
  try {
    messagesMod = await import(new URL('js/data/messages.js', document.baseURI).href);
    check('上下文拼装模块能加载', typeof messagesMod.buildApiMessages === 'function');
  } catch (err) {
    check('上下文拼装模块能加载', false, (err && err.message) || String(err));
  }
  if (!messagesMod || typeof messagesMod.buildApiMessages !== 'function') return;

  const SECTION = 'SECTION-MARK 关键词命中的设定。';
  const DEEP = 'DEEP-MARK 每一轮都成立的规则。';
  const HIST = 'HISTORY-MARK 玩家这一轮说的话';
  const LEGACY = 'LEGACY-MARK 直接传字符串的老调用';

  // 世界模式：这样才有【主角不可代写】那条压轴提醒可当锚点。
  const conv = {
    id: 'smoke-wb-deep',
    gmMode: true,
    worldbookIds: [],
    player: { name: '小怡', profile: '大一女生。' },
    messages: [{ role: 'user', content: HIST }]
  };

  const out = messagesMod.buildApiMessages(conv, { section: SECTION, deepSection: DEEP }, '');
  const idx = (mark) => out.findIndex((m) => String((m && m.content) || '').includes(mark));

  const sectionIdx = idx('SECTION-MARK');
  const deepIdx = idx('DEEP-MARK');
  const histIdx = idx('HISTORY-MARK');
  const ownIdx = idx('【主角不可代写】');

  check('关键词块注入了', sectionIdx >= 0, String(sectionIdx));
  check('常驻块注入了', deepIdx >= 0, String(deepIdx));
  check('【主角不可代写】还在（锚点没丢）', ownIdx >= 0, String(ownIdx));

  if (sectionIdx >= 0 && deepIdx >= 0 && histIdx >= 0 && ownIdx >= 0) {
    check('关键词块排在对话历史之前（照旧紧跟人设）', sectionIdx < histIdx, `${sectionIdx} < ${histIdx}`);
    check('常驻块排在对话历史之后（这才叫深度注入）', deepIdx > histIdx, `${deepIdx} > ${histIdx}`);
    check('常驻块排在关键词块之后', deepIdx > sectionIdx, `${deepIdx} > ${sectionIdx}`);
    check(
      '常驻块压在【主角不可代写】之前 —— 不许把这道闸拆掉',
      deepIdx < ownIdx,
      `${deepIdx} < ${ownIdx}`
    );
    check(
      '常驻块正文原样传进提示词（没被改写）',
      String(out[deepIdx].content).includes(DEEP),
      String(out[deepIdx].content).slice(0, 40)
    );
  }

  // 兼容：老调用（和一堆测试）传的是**一个字符串** —— 那它就是关键词块，照旧的老位置。
  const legacyOut = messagesMod.buildApiMessages(conv, LEGACY, '');
  const legacyIdx = legacyOut.findIndex((m) => String((m && m.content) || '').includes('LEGACY-MARK'));
  const legacyHistIdx = legacyOut.findIndex((m) => String((m && m.content) || '').includes('HISTORY-MARK'));
  check('传字符串的老调用照旧生效', legacyIdx >= 0, String(legacyIdx));
  check('老调用落在对话历史之前（老位置）', legacyIdx >= 0 && legacyHistIdx >= 0 && legacyIdx < legacyHistIdx,
    `${legacyIdx} < ${legacyHistIdx}`);
  check(
    '老调用不会凭空多出常驻块',
    !legacyOut.some((m) => String((m && m.content) || '').includes('[世界设定 · 常驻]'))
  );
});

// ---------------------------------------------------------------------------
//  场景 14：给剧情配图（生图）
//
//  生图和聊天是**两套配置**，所以这里从「还没配」开始走完整条路：
//  没配 → 没有「配图」按钮 → 去设置里配一组 → 按钮出现 → 点它 → 图上到那条消息上。
// ---------------------------------------------------------------------------
await scenario('给剧情配图（生图）', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(250);

  const lastAssistant = () => $$('#messages .msg.assistant').pop();
  const actionsOf = (node) => Array.from(node.querySelectorAll('.msg-actions .mini-btn')).map((b) => b.textContent.trim());

  // 先自己发一条，拿到一条**正常的回复**再来配图 —— 别借上一个场景的残留。
  // 以前这里是蹭「给 AI 看图」场景留下的那条回复，而那个场景已经删掉；
  // 于是末条变成了「就地编辑」场景改过的内容，宿主侧那条「提示词取自回复正文」
  // 的断言（认的是「冒烟测试回复」）当场就不成立了。
  setValue('#input', '给这段剧情配张图吧');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').getAttribute('data-mode') === 'send', 10000);
  await sleep(300);

  check('没配生图时不显示「配图」', !actionsOf(lastAssistant()).includes('配图'), JSON.stringify(actionsOf(lastAssistant())));

  // --- 去设置里配一组 ---
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));
  await sleep(150);

  check('设置里有生图服务商下拉', !!byId('s-image-provider'));
  const providerCount = ((await window.mimitale.getSettings()).settings.providers || []).length;
  const imgOptions = Array.from(byId('s-image-provider').options).map((o) => o.value);
  check(
    '下拉里是「不启用」+ 全部服务商',
    imgOptions.length === providerCount + 1 && imgOptions.includes('p-img'),
    `${imgOptions.length} 项（服务商 ${providerCount} 个）：${JSON.stringify(imgOptions)}`
  );

  setValue('#s-image-provider', 'p-img');
  await sleep(200);
  // 模型下拉跟着服务商走 —— 这是这次改的重点，得钉住
  const imgModelOptions = Array.from(byId('s-image-model').options).map((o) => o.value);
  check(
    '生图模型是下拉，而且跟着服务商填好',
    asControl(byId('s-image-model')).tagName === 'SELECT' && imgModelOptions.length === 1 && imgModelOptions[0] === 'img-model-x',
    `${asControl(byId('s-image-model')).tagName} ${JSON.stringify(imgModelOptions)}`
  );

  // 注意：「生图模型下拉并入内置目录」这条不在这里测。
  // 它需要服务商的 baseUrl 命中内置目录，而这个冒烟环境里的服务商都是
  // 127.0.0.1 的假地址、命不中；临时加一个服务商又会牵动
  // settings:save 的合并与下拉重填，测起来很脆。
  // 这条逻辑由 tools 外的纯函数测试覆盖（fillModelSelect 是纯函数，用假 DOM 跑）。
  setValue('#s-image-model', 'img-model-x');
  setValue('#s-image-size', '1024x1024');
  await sleep(200);

  // 尺寸下拉：不认识的模型给通用尺寸，不能是空下拉
  const genericSizes = Array.from(byId('s-image-size').options).map((o) => o.value);
  check(
    '尺寸是下拉，未知模型给通用尺寸',
    asControl(byId('s-image-size')).tagName === 'SELECT' && genericSizes.includes('1024x1024'),
    `${asControl(byId('s-image-size')).tagName} ${JSON.stringify(genericSizes)}`
  );

  // 已知模型要给出它专属的尺寸（智谱 glm-image 就那 7 个固定值）
  addAndSelect('#s-image-model', 'glm-image');
  await sleep(200);
  const sizeSel = byId('s-image-size');
  const glmOptions = Array.from(sizeSel.options);
  const glmSizes = glmOptions.map((o) => o.value);
  const recommended = ['1280x1280', '1568x1056', '1056x1568', '1472x1088', '1088x1472', '1728x960', '960x1728'];
  check(
    '选 glm-image 时尺寸下拉是它推荐的 7 个值（顺序一致）',
    JSON.stringify(glmSizes.slice(0, 7)) === JSON.stringify(recommended),
    `实际=${JSON.stringify(glmSizes)}`
  );
  // 之前存的 1024x1024 不在推荐列表，但按官方自定义规则合法（1024-2048、32 的倍数），
  // 所以应被保留为「自定义」而不是被丢掉或纠正
  check(
    '已存的合法自定义尺寸被保留并标注（glm-image 的 1024x1024 按自定义规则合法）',
    glmSizes.length === 8 &&
      glmSizes[7] === '1024x1024' &&
      /自定义/.test(glmOptions[7].textContent),
    JSON.stringify(glmOptions.map((o) => o.textContent))
  );
  check('glm-image 的尺寸默认选中 1280x1280', sizeSel.value, '1280x1280');

  // 换回通用模型，尺寸选项也要跟着换回去
  setValue('#s-image-model', 'img-model-x');
  await sleep(200);
  const backSizes = Array.from(sizeSel.options).map((o) => o.value);
  check(
    '换回未知模型时尺寸选项回到通用列表',
    backSizes.includes('1024x1024') && !backSizes.includes('1568x1056'),
    JSON.stringify(backSizes)
  );

  // 继续后面的流程
  setValue('#s-image-size', '1024x1024');
  click('#btn-save-settings');
  await waitFor('设置关闭', () => !shown('#view-settings'));
  await sleep(400);

  const saved = (await window.mimitale.getSettings()).settings;
  check(
    '生图配置落盘了（和聊天模型是分开的两个字段）',
    saved.imageProviderId === 'p-img' && saved.imageModel === 'img-model-x' && saved.activeModel === 'test-model',
    JSON.stringify({ img: saved.imageProviderId + '/' + saved.imageModel, chat: saved.activeProviderId + '/' + saved.activeModel })
  );

  // --- 配好之后按钮才出现 ---
  await sleep(300);
  check('配好之后出现「配图」', actionsOf(lastAssistant()).includes('配图'), JSON.stringify(actionsOf(lastAssistant())));

  const before = lastAssistant().querySelectorAll('.bubble-image').length;
  click(buttonByText(lastAssistant(), '配图'));
  await waitFor('图画好了', () => lastAssistant().querySelectorAll('.bubble-image').length > before, 15000);
  check('图挂到了那条消息上', lastAssistant().querySelectorAll('.bubble-image').length === before + 1, String(lastAssistant().querySelectorAll('.bubble-image').length));

  // --- 落盘 ---
  await sleep(700);
  const withImage = (await window.mimitale.getConversations()).conversations
    .flatMap((c) => c.messages || [])
    .filter((m) => m.role === 'assistant' && Array.isArray(m.images) && m.images.length);
  check('生成的图落盘了', withImage.length >= 1, String(withImage.length));
  check('图是 data:image/ 开头（不是外链）', withImage.length ? String(withImage[0].images[0]).startsWith('data:image/') : false);
});

// ---------------------------------------------------------------------------
//  场景 15：设置 → 外观 里「只管聊天区」的那几样（字号 / 加粗颜色 / 背景图）
//  主题配色和明暗在场景 2 / 2b —— 它们和这三样在**同一组**里，只是管整个界面。
//  （2026-10-12 深夜：这一整块从顶栏弹窗搬进了设置页，见 openAppearanceSection。）
// ---------------------------------------------------------------------------
await scenario('外观：聊天区那几样', async () => {
  await openAppearanceSection();
  check(
    '聊天区三样控件都在（字号 / 颜色 / 背景）',
    !!byId('appearance-fontsize') && !!byId('appearance-boldcolor-text') && !!byId('btn-pick-bg')
  );
  check(
    '管整个界面的两样也在一起（配色 / 明暗）',
    !!byId('appearance-accents') && !!byId('appearance-modes')
  );

  const bubble = $('#messages .bubble');
  const strong = $('#messages .bubble strong');
  check('聊天里有个 <strong> 可以用来验颜色', !!bubble && !!strong);

  // --- 字号 ---
  const beforeSize = getComputedStyle(bubble).fontSize;
  setValue('#appearance-fontsize', '20');
  byId('appearance-fontsize').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  check('字号改了正文的实际大小', getComputedStyle(bubble).fontSize === '20px', `${beforeSize} → ${getComputedStyle(bubble).fontSize}`);
  check('旁边的数字也跟着变', byId('appearance-fontsize-value').textContent === '20px', byId('appearance-fontsize-value').textContent);
  check('字号落盘了', (await window.mimitale.getSettings()).settings.chatFontSize === 20);

  // 滑块的「已选比例」是自己用渐变画的（原生那条未选轨道在浅色下是黑的），
  // 所以值一变就得跟着更新 —— 12–22 的滑条拉到 20 是 80%
  const fill = byId('appearance-fontsize').style.getPropertyValue('--range-fill');
  check('滑块的已选比例跟着值走', fill === '80%', `--range-fill = ${fill}`);

  // --- 加粗颜色：手填 ---
  setValue('#appearance-boldcolor-text', '#e06c75');
  byId('appearance-boldcolor-text').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  check('加粗字真的变色了', getComputedStyle(strong).color === 'rgb(224, 108, 117)', getComputedStyle(strong).color);
  check('颜色落盘了', (await window.mimitale.getSettings()).settings.chatBoldColor === '#e06c75');

  // 不带 # 也认
  setValue('#appearance-boldcolor-text', '00aaff');
  byId('appearance-boldcolor-text').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  check('不带 # 也认', (await window.mimitale.getSettings()).settings.chatBoldColor === '#00aaff', (await window.mimitale.getSettings()).settings.chatBoldColor);

  // 乱填要挡下来，而且不能把原来的值冲掉
  setValue('#appearance-boldcolor-text', 'red');
  byId('appearance-boldcolor-text').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  check(
    '乱填的颜色被拒绝、原值不变',
    (await window.mimitale.getSettings()).settings.chatBoldColor === '#00aaff',
    (await window.mimitale.getSettings()).settings.chatBoldColor
  );

  // --- 背景图：走真实的「选图 → 压缩 → 存起来」链路 ---
  click('#btn-pick-bg');
  await waitFor('自定义背景预览出现', () => shown('#appearance-bg-preview') && $('#appearance-bg-preview img')?.src.startsWith('data:image/'), 10000);
  check('消息区挂上了背景图', getComputedStyle($('.chat-col'), '::before').backgroundImage.includes('data:image'), getComputedStyle($('#messages')).backgroundImage.slice(0, 50));
  check(
    '背景图落盘了',
    String((await window.mimitale.getSettings()).settings.chatBackground).startsWith('data:image/'),
    String((await window.mimitale.getSettings()).settings.chatBackground).slice(0, 40)
  );

  // --- 清除 ---
  click('#btn-clear-bg');
  await sleep(250);
  check('清掉之后消息区没有背景图', !getComputedStyle($('.chat-col'), '::before').backgroundImage.includes('data:image'), getComputedStyle($('#messages')).backgroundImage);
  check('没背景时「清除」是禁用的', byId('btn-clear-bg').disabled === true);
  check('清除后关闭内置皮肤', document.documentElement.dataset.chatSkin === 'plain');
  click('#btn-default-bg');
  await sleep(250);
  check('雾林皮肤覆盖整个聊天列', getComputedStyle($('.chat-col'), '::before').backgroundImage.includes('tavern-forest.jpg'));
  check('消息区不重复铺背景', getComputedStyle($('#messages')).backgroundImage === 'none');
  check('顶栏与输入区共享背景', getComputedStyle($('.topbar')).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle($('.composer')).backgroundColor === 'rgba(0, 0, 0, 0)');
  check('皮肤恢复已保存', (await window.mimitale.getSettings()).settings.chatBuiltinBackground === true);
  check('仅输入框保留轻薄玻璃质感', getComputedStyle($('.composer-box')).backdropFilter.includes('blur'));
  click('#btn-clear-bg');
  await sleep(180);

  click('#btn-boldcolor-reset');
  await sleep(250);
  check(
    '复位后加粗颜色不再自定义（留空 = 跟随主题配色）',
    (await window.mimitale.getSettings()).settings.chatBoldColor === ''
  );

  // 留空时加粗色应当等于**当前主题配色** —— 不是「跟随正文颜色」。
  // 使用说明一直写着「留空就跟随主题配色」，而样式表以前回落到 inherit（正文色），
  // 两边不一致（2026-10-08 修）。这里把「留空到底等于什么颜色」钉死。
  const accentProbe = document.createElement('span');
  accentProbe.style.color = 'var(--accent)';
  document.body.appendChild(accentProbe);
  const accentRgb = getComputedStyle(accentProbe).color;
  const accentHex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  accentProbe.remove();

  const strongNow = $('#messages .bubble strong');
  check(
    '留空时加粗色 = 主题配色（不是正文色）',
    !!strongNow && getComputedStyle(strongNow).color === accentRgb && accentRgb !== getComputedStyle($('#messages .bubble')).color,
    `${strongNow ? getComputedStyle(strongNow).color : '没有 strong'} vs 主题色 ${accentRgb}`
  );
  check(
    '没自定义时色盘显示的就是主题配色',
    byId('appearance-boldcolor').value.toLowerCase() === accentHex.toLowerCase(),
    `${byId('appearance-boldcolor').value} vs ${accentHex}`
  );

  await leaveAppearanceSection();
});

// ---------------------------------------------------------------------------
//  场景 15b：外观 →「界面字号」三档 +「字体」
//
//  这两项是 2026-10-12 深夜新加的。字号三档改的是 **--ui-size 一个变量**，
//  全站的 --fs-* 都写成 calc(基准px * var(--ui-size))，所以「点一下大、整站都变大」
//  这条链必须**验穿**：只验「设置存下来了」是不够的 —— 那只证明写了，
//  不证明真的生效（渲染层写错变量名，落盘照样是好的）。
// ---------------------------------------------------------------------------
await scenario('外观：界面字号与字体', async () => {
  await openAppearanceSection();

  const root = document.documentElement;
  const scale = () => getComputedStyle(root).getPropertyValue('--ui-size').trim();
  // 拿设置页的「设置」标题当标尺：它的字号是 var(--fs-lg)，会跟着 --ui-size 走
  const titleSize = () => parseFloat(getComputedStyle($('.page-title')).fontSize);

  const segBtn = (k) => $(`#appearance-uiscale [data-uiscale="${k}"]`);
  check(
    '三档都在（小 / 中 / 大）',
    !!segBtn('small') && !!segBtn('medium') && !!segBtn('large')
  );

  const baseSize = titleSize();

  // --- 大 ---
  click(segBtn('large'));
  await waitFor('--ui-size 变成 1.15', () => scale() === '1.15');
  check('选「大」后 --ui-size = 1.15', scale() === '1.15', scale());
  check('选中的那颗标了 aria-checked', segBtn('large').getAttribute('aria-checked') === 'true');
  const bigSize = titleSize();
  check('整站字号真的变大了（拿页面标题当标尺）', bigSize > baseSize, `${baseSize} → ${bigSize}`);

  // --- 小 ---
  click(segBtn('small'));
  await waitFor('--ui-size 变成 0.9', () => scale() === '0.9');
  const smallSize = titleSize();
  check('选「小」确实比「中」小', smallSize < baseSize, `${baseSize} → ${smallSize}`);

  // 「小」档最小字号不许低于 12（星宝：「小于 12 号的字体就不应该有」）。
  // --fs-xs/--fs-sm… 里都过了一遍 max(--fs-min, ...)，这里逐个探**实际计算值**——
  // 因为 getPropertyValue('--fs-xs') 拿到的是没解析的 token 原文，看不出 max() 的结果。
  // 小档是 0.9，没有这道闸的话 --fs-xs 会算出 10.8px。
  const tokenPx = (name) => {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.fontSize = `var(${name})`;
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return px;
  };
  const TOKENS = ['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl'];
  const smallMin = Math.min(...TOKENS.map(tokenPx));
  check('「小」档最小字号仍 ≥ 12px', smallMin >= 12, `${smallMin}px`);
  check(
    '五档字号在「小」档下全都 ≥ 12px',
    TOKENS.every((t) => tokenPx(t) >= 12),
    TOKENS.map((t) => `${t}=${tokenPx(t)}`).join(' ')
  );

  // 落盘（这条单独验：变量生效和存进 config 是两条路）
  await sleep(200);
  const savedSize = ((await window.mimitale.getSettings()).settings || {}).uiSize;
  check('界面字号落盘了', savedSize === 'small', String(savedSize));

  // --- 字体 ---
  const fontSel = byId('appearance-font');
  check('字体下拉在、至少 4 套', !!fontSel && fontSel.options.length >= 4, fontSel ? `${fontSel.options.length} 项` : '(没有)');
  const fontOf = () => getComputedStyle(document.body).fontFamily;
  const beforeFont = fontOf();
  setValue('#appearance-font', 'serif');
  fontSel.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor('字体换过去了', () => fontOf() !== beforeFont);
  check('换字体后 body 的 font-family 真的变了', fontOf() !== beforeFont, `${beforeFont} → ${fontOf()}`);

  await sleep(200);
  const savedFont = ((await window.mimitale.getSettings()).settings || {}).uiFont;
  check('字体落盘了', savedFont === 'serif', String(savedFont));

  // --- 还原：后面的场景依赖默认值（中 + 默认字体）---
  click(segBtn('medium'));
  await waitFor('字号还原成「中」', () => scale() === '1');
  setValue('#appearance-font', 'default');
  fontSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  check('还原后 body 字体也回默认了', fontOf() === beforeFont, fontOf());

  await leaveAppearanceSection();
});

// ---------------------------------------------------------------------------
//  场景：对话宽度（左右**独立**内缩）
//
//  为什么要有这条：用户要把浮动卡片放左下角，那时候对话贴边会被挡住，
//  而只该推开左边。所以这个功能的核心不是「有个宽度设置」，而是
//  **改一边另一边绝对不动** —— 那正是要断言的东西。
//  ⚠️ 断言的是 .messages 的**计算样式**（padding-left/right），不是 CSS 变量：
//     变量写对了但没接到元素上，一样是白干（这套测试里栽过好几次）。
//  ⚠️ 2026-10-12 晚：顶栏那颗「对话宽度」+ 弹层（#pad-pop / 两根滑块）**去掉了**
//     （星宝：「聊天框里已经可以调宽度了」）。所以现在**抓手是唯一入口**，
//     这条契约只能靠**拖**来验 —— 顺带把「按钮和弹层真的没了」也钉住，
//     免得哪天又被谁加回来。
// ---------------------------------------------------------------------------
await scenario('对话宽度：左右各管各的（拖动抓手）', async () => {
  check('顶栏那颗「对话宽度」按钮已经拿掉', !byId('btn-chat-pad'));
  check('宽度弹层也一起拿掉了', !byId('pad-pop'));

  // 抓手：唯一入口，少一个就等于少了一半功能
  const handleL = byId('pad-handle-left');
  const handleR = byId('pad-handle-right');
  check('消息区左右各有一个抓手', !!handleL && !!handleR);
  check(
    '两个抓手分得清左右',
    handleL.dataset.side === 'left' && handleR.dataset.side === 'right',
    `${handleL.dataset.side} / ${handleR.dataset.side}`
  );

  const msgs = byId('messages');
  const padL = () => Math.round(parseFloat(getComputedStyle(msgs).paddingLeft));
  const padR = () => Math.round(parseFloat(getComputedStyle(msgs).paddingRight));

  // ⚠️ 2026-10-13 起内缩对**输入框**也生效（.composer 和 .messages 吃同一对变量 ——
  //    星宝：「拖动输入框就可以调内缩，正好把输入框也缩小」）。
  //    两边必须同步：各留各的就会「拖了只有一边动」。
  const composer = document.querySelector('.composer');
  const composerPadL = () => Math.round(parseFloat(getComputedStyle(composer).paddingLeft));
  const composerPadR = () => Math.round(parseFloat(getComputedStyle(composer).paddingRight));

  // 拖某个抓手 dx 像素（正数往右）。mid 在「按住且已移动」那一刻跑，用来验拖动中的态。
  const drag = async (handle, dx, mid) => {
    const b = handle.getBoundingClientRect();
    const y = Math.round(b.top + b.height / 2);
    const x0 = Math.round(b.left + b.width / 2);
    const send = (type, cx) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          pointerId: 1,
          clientX: cx,
          clientY: y
        })
      );
    send('pointerdown', x0);
    send('pointermove', x0 + dx);
    await sleep(60);
    if (mid) mid();
    send('pointerup', x0 + dx);
    await sleep(220);
  };

  const startL = padL();
  const startR = padR();

  // --- 只拖左边：右边必须纹丝不动，而且拖动中要浮出小标签 + 左边的虚线 ---
  const targetL = startL + 120;
  let midOk = null;
  await drag(handleL, 120, () => {
    const badge = document.querySelector('.pad-badge');
    midOk = {
      guide: shown('#pad-guide-left') && !shown('#pad-guide-right'),
      badge: !!badge && /左内缩\s*\d+px/.test(badge.textContent || '')
    };
  });
  check('拖左边时只亮左边那条虚线', !!(midOk && midOk.guide), JSON.stringify(midOk));
  // 没有弹层之后，这个标签是**唯一**能看到准确值的地方
  check('拖动时浮出「左内缩 NNpx」小标签', !!(midOk && midOk.badge), JSON.stringify(midOk));
  check('拖左边真的把左内缩改了', padL() === targetL, `期望 ${targetL}，实际 ${padL()}`);
  check('拖左边时右边没跟着动', padR() === startR, `右边从 ${startR} 变成了 ${padR()}`);
  check(
    '输入框的左内缩同步跟着变（拖的就是它旁边那颗把手）',
    composerPadL() === targetL,
    `期望 ${targetL}，输入框实际 ${composerPadL()}`
  );
  check('松手后虚线收起来', !shown('#pad-guide-left'));
  check('松手后小标签也收起来', !shown('.pad-badge'));

  const savedAfterLeft = (await window.mimitale.getSettings()).settings;
  check('左内缩已落盘', savedAfterLeft.chatPadLeft === targetL, `落盘的是 ${savedAfterLeft.chatPadLeft}`);
  check('落左边时右内缩没被顺手改掉', savedAfterLeft.chatPadRight === startR, `落盘的是 ${savedAfterLeft.chatPadRight}`);

  // --- 再只拖右边（右边抓手往**左**拖才是内缩变大）：左边必须保持刚才的值 ---
  const targetR = startR + 80;
  await drag(handleR, -80);
  check('拖右边真的把右内缩改了', padR() === targetR, `期望 ${targetR}，实际 ${padR()}`);
  check('拖右边时左边保持不动', padL() === targetL, `左边从 ${targetL} 变成了 ${padL()}`);

  const savedAfterRight = (await window.mimitale.getSettings()).settings;
  check('右内缩已落盘', savedAfterRight.chatPadRight === targetR, `落盘的是 ${savedAfterRight.chatPadRight}`);
  check(
    '两项是分别存的，没被合成一个',
    savedAfterRight.chatPadLeft === targetL && savedAfterRight.chatPadRight === targetR,
    `${savedAfterRight.chatPadLeft} / ${savedAfterRight.chatPadRight}`
  );

  // --- 拖到头会夹在边界上，不该把人卡住 ---
  // ⚠️ 2026-10-13：下限从 0 提到 **12**（星宝：「拖动的边距最小值设为 12px」）——
  //    往内拖到底不再贴边。这两条跟着改口径，别照着 0 改回去。
  await drag(handleL, -9999);
  check('往左拖过头会夹在下限 12（不贴边）', padL() === 12, String(padL()));
  await drag(handleL, 9999);
  check('往右拖过头会夹在上限 360', padL() === 360, String(padL()));

  // 复原，别影响后面的截图和布局断言
  await drag(handleL, -(360 - startL));
  await drag(handleR, targetR - startR);
  check('复原后左右都回到原值', padL() === startL && padR() === startR, `${padL()} / ${padR()}`);

  // 输入框和消息区必须**始终同步**（内缩对两者都生效，各留各的就会「拖了只有一边动」）
  check(
    '输入框的内缩和消息区一致',
    composerPadL() === padL() && composerPadR() === padR(),
    `输入框 ${composerPadL()}/${composerPadR()} vs 消息区 ${padL()}/${padR()}`
  );
});

// ---------------------------------------------------------------------------
//  右栏仅展示角色与场景；生成参数在设置，收放仅通过栏头入口。
// ---------------------------------------------------------------------------
await scenario('简化右栏与设置参数', async () => {
  check('右栏只保留角色与场景', !byId('btn-tab-gen') && !byId('gen-body'));
  check('聊天区没有收放把手', !byId('rail-handle-left') && !byId('rail-handle-right'));
  check('设置保留全部生成参数', ['s-temp','s-topp','s-maxtokens','s-thinking'].every(id => !!byId(id)));
  const panel=byId('cast-panel');
  const main=$('.app > main');
  check('根布局为sidebar main inspector', panel.parentElement === main.parentElement && panel.previousElementSibling === main && main.previousElementSibling === byId('sidebar'));
  check('右栏不再嵌套在主内容中', !panel.closest('main'));
  const beforeWidth=main.getBoundingClientRect().width;
  await openSettingsPage(); await sleep(180);
  check('进入设置时独立右栏隐藏', getComputedStyle(panel).display === 'none');
  check('设置页释放右栏空间', main.getBoundingClientRect().width > beforeWidth);
  click('#btn-back-settings'); await sleep(180);
  check('返回聊天后独立右栏恢复', getComputedStyle(panel).display !== 'none');
  click('#btn-cast-collapse'); await sleep(180);
  check('栏头按钮可以收起右栏', panel.classList.contains('collapsed'));
  click('#btn-cast-collapse'); await sleep(180);
  check('栏头按钮可以展开右栏', !panel.classList.contains('collapsed'));
});

// ---------------------------------------------------------------------------
//  场景：侧栏（稿子的左栏）
//
//  这一批把左栏换成了稿子的语言：280 宽、底部入口 3 列 × 2 行、当前会话
//  左侧一条琥珀竖线、能收起。**圆角和间距 DOM 断言看不出来**（那得靠图），
//  但「结构和状态对不对」恰恰是最容易悄悄回退的部分 —— 这几条就守这个。
//  2026-10-12 深夜：星宝嫌三处偏小（收起态图标 / 品牌行 / 底部入口），
//  整套跟着放大一档，侧栏 280 → 300、收起态 56 → 60 —— 下面这些数也跟着走。
// ---------------------------------------------------------------------------
await scenario('当前场景：读取真实状态与归属', async () => {
  const { currentScene } = await import('../renderer/js/data/currentScene.js');
  const { panelKey } = await import('../renderer/js/data/panel.js');
  const globalPlace = panelKey('地点', 'scene');
  const playerPlace = panelKey('地点', 'player');
  const npcPlace = panelKey('地点', 'npc');
  const time = panelKey('时间', 'player');
  const fixture = { panelFields: [npcPlace, playerPlace, globalPlace, time], panel: {
    [npcPlace]: '另一座城', [playerPlace]: '旅店', [globalPlace]: '边境驿站', [time]: '深夜'
  } };
  check('空会话不虚构场景', currentScene(null).length === 0 && currentScene({}).length === 0);
  const fields = currentScene(fixture);
  check('全局地点优先于玩家地点', fields.find(f => f.label === '地点')?.value === '边境驿站');
  check('读取故事时间而不是系统时间', fields.find(f => f.label === '时间')?.value === '深夜');
  check('没有天气就不填天气', !fields.some(f => f.label === '天气'));
  check('不把 NPC 私人位置当当前场景', currentScene({ panelFields: [npcPlace], panel: fixture.panel }).length === 0);
});

await scenario('侧栏：入口网格与收起', async () => {
  const sidebar = document.querySelector('.sidebar');

  // 截图 driver（--shot=accountMe）会真的注册一个账号、把登录态留在数据目录里，
  // 下面那两条「未登录」断言就会红。这里先从账号菜单里退出，让场景自己成立。
  if (/@/.test(byId('account-sub')?.textContent || '')) {
    click('#btn-account');
    await waitFor('账号菜单打开', () => shown('#account-menu'));
    click('#btn-account-menu-logout');
    await waitFor('退出上一次的登录', () => byId('account-name')?.textContent.trim() === '未登录');
  }
  // 232 → 280（2026-10-12 晚）→ 300（底部入口图标 18 / 字 14px 之后需要的列宽）
  check('侧栏宽度 224', Math.round(sidebar.getBoundingClientRect().width) === 224, String(Math.round(sidebar.getBoundingClientRect().width)));

  const foot = $$('.sidebar-foot m-button');
  // 这一组三颗创作入口（角色卡 / 游戏卡 / 预设）—— 设置不在侧栏（入口在登录后的账号菜单里），
  // 世界书也没有独立入口了（挂在角色的「自带世界书」上）。
  check('侧栏保留三个创作入口', foot.length === 3, String(foot.length));
  check('数据按钮位于设置页', !!byId('btn-folder')?.closest('#view-settings'));
  check(
    '每颗都带图标',
    foot.every((b) => !!b.querySelector('svg')),
    foot.filter((b) => !b.querySelector('svg')).map((b) => b.id).join(', ') || '（都带着）'
  );
  check(
    '第三颗是按稿子写的「数据」',
    !!byId('btn-folder') && byId('btn-folder').textContent.trim() === '打开数据文件夹',
    byId('btn-folder') ? byId('btn-folder').textContent.trim() : '(没有)'
  );

  // --- 底部最后一行 = 账号格（设置只在登录后的账号菜单里，这里没有齿轮）---
  {
    const acct = document.querySelector('.sidebar-account');
    const acctBtn = byId('btn-account');
    check(
      '底部有账号条，而且没有常显的设置齿轮',
      !!acct && !!acctBtn && !byId('btn-settings'),
      byId('btn-settings') ? '齿轮还在' : ''
    );
    check(
      '账号条排在创作入口下面（最底那一行）',
      !!acct &&
        foot.length > 0 &&
        acct.getBoundingClientRect().top >= foot[foot.length - 1].getBoundingClientRect().bottom - 1
    );
    check(
      '未登录态写「未登录」+ 一句用途',
      byId('account-name')?.textContent.trim() === '未登录' &&
        /登录/.test(byId('account-sub')?.textContent || ''),
      `${byId('account-name')?.textContent}/${byId('account-sub')?.textContent}`
    );
    check('未登录头像位是人形图标', !!byId('account-avatar')?.querySelector('svg'));
    const a = acctBtn ? acctBtn.getBoundingClientRect() : null;
    const box = acct ? acct.getBoundingClientRect() : null;
    check(
      '账号格占满这一行（右边不再挂齿轮）',
      !!a && !!box && Math.abs(a.right - box.right) <= 1,
      a && box ? `${Math.round(a.right)} vs ${Math.round(box.right)}` : '（没有）'
    );
    check(
      '账号格没把侧栏撑宽（都在 224 之内）',
      !!acct && acct.getBoundingClientRect().right <= sidebar.getBoundingClientRect().right + 0.5,
      acct ? String(Math.round(acct.getBoundingClientRect().right)) : '（没有）'
    );
  }

  // 当前会话左侧那条短竖线是 ::before 画的
  const active = document.querySelector('.convo-item.active');
  const line = active ? getComputedStyle(active, '::before') : null;
  check('当前会话靠底色与边框标识，不生成多余竖线', !!line && (line.content === 'none' || line.display === 'none'), line ? line.content : '（没有 active 项）');

  // --- 2026-10-12 晚：把稿子上的尺寸钉住（这几条全是「不报错、只难看」那一类）---
  {
    // 「新对话」高 32（稿子 2:12）。⚠️ 曾经翻过车：文件里同时存在两条 `.btn-new`，
    // 旧的 `height:40px` 在后面、同权重 → 赢了新写的 32，而 CHANGELOG 已经写了「高 32」。
    // 所以这条断言就是那次事故的守卫。
    const btnNew = byId('btn-new');
    check(
      '「新对话」高 42（叙事布局）',
      btnNew && Math.round(btnNew.getBoundingClientRect().height) === 42,
      btnNew ? String(Math.round(btnNew.getBoundingClientRect().height)) : '(没有)'
    );

    // 会话项头像：稿子 2:24 是 20×20 r=3 → 10-12 深夜放大到 48（「一眼认人」）
    // → **10-13 回到 36**：48 配 60 高的条目，一屏只看得到 8~9 条，太占地方。
    // 这两条守的是「别再悄悄缩回去」—— 36 仍然明显大于稿子的 20，也大过最初那版 38 的头。
    const cav = document.querySelector('.convo-item .convo-avatar');
    const cbox = cav ? cav.getBoundingClientRect() : null;
    check(
      '会话项头像 36×36 方角 r=4（密度回调后）',
      !!cbox && Math.round(cbox.width) === 36 && getComputedStyle(cav).borderTopLeftRadius === '4px',
      cbox ? `${Math.round(cbox.width)} r=${getComputedStyle(cav).borderTopLeftRadius}` : '（没有头像）'
    );
    check(
      '会话项高 64（两行故事记录）',
      active && Math.round(active.getBoundingClientRect().height) === 64,
      active ? String(Math.round(active.getBoundingClientRect().height)) : '（没有 active 项）'
    );

    // 底部入口：稿子 2:47 那一组的 `fills` 和 `strokes` 都是**空数组** ——
    // 纯 ghost：没有底、也没有边框，只有图标 + 文字。
    // ⚠️ 2026-10-12 我给它们加过 1px 描边，那是**看低分辨率缩略图**看出来的；
    //    拿节点数据一对就露馅了。这条断言就是那次误判的守卫。
    check(
      '底部入口是纯 ghost（无底、无边框，稿子 2:47）',
      // 边框宽度用 > 0.5 判定：125% 显示缩放下 Chromium 会把 1px 取整成 0.8px（实测），
      // 那不是样式变了。颜色仍然必须是透明的 —— 那才是「纯 ghost」的本体。
      // ⚙ 2026-10-16 迁 m-button：边框/背景长在里层 .mi-btn__control 上，宿主本身没边框，
      //    所以要读 b.control（里层原生 button），而不是宿主（否则取到 currentColor）。
      foot.every((b) => {
        const cs = getComputedStyle(b.control);
        return (
          cs.backgroundColor === 'rgba(0, 0, 0, 0)' &&
          parseFloat(cs.borderTopWidth) > 0.5 &&
          cs.borderTopStyle === 'solid' &&
          cs.borderTopColor === 'rgba(0, 0, 0, 0)'
        );
      }),
      foot.map((b) => `${b.id}${b.classList.contains('active') ? '[active]' : ''} ` +
        `${getComputedStyle(b.control).backgroundColor}/${getComputedStyle(b.control).borderTopColor}`).join(' ')
    );
    // 这一组上面有一条**通栏**分隔线（稿子 2:28，1px #2a2e34）——
    // 用 ::before 画的，所以得读伪元素的计算样式。
    const footLine = getComputedStyle(document.querySelector('.sidebar-foot'), '::before');
    check(
      '底部不生成已移除的通栏伪元素',
      !!footLine && (footLine.content === 'none' || footLine.display === 'none'),
      footLine ? `${footLine.content} ${footLine.backgroundColor}` : '（没有）'
    );

    // 深色面板档位：稿子 2:5（侧栏）/ 2:82（顶栏）/ 2:174（右栏）都是 #16181b。
    // ⚠️ 曾经写成 #0c0d0f —— 那个值在设计稿的 6 级里根本不存在，
    // 后果是侧栏/右栏发闷、顶栏连色带都没有。
    check(
      '深色侧栏底 = 原型炭黑 #151715',
      getComputedStyle(sidebar).backgroundColor === 'rgb(21, 23, 21)',
      getComputedStyle(sidebar).backgroundColor
    );

    // 搜索会话框 2026-10-12 晚去掉了（星宝要求）—— 别再被加回来
    check('搜索会话框已经拿掉', !byId('convo-search'));

    // ⚠️ 三列里每颗的文字都不许被截断。这条是 2026-10-12 踩出来的：
    //    一行 66.67px 要装下 pad 7 + 图标 13 + gap + 文字 + pad 7，
    //    11.5px 的「角色卡」是 34.5px → 刚好卡在边界，实拍出来是「角…」。
    //    scrollWidth > clientWidth 是浏览器给的硬证据，比看图靠谱。
    check(
      '底部 6 颗的字都没被截断（角… / 世…）',
      foot.every((b) => {
        const label = b.querySelector('.foot-label');
        return !label || label.scrollWidth <= label.clientWidth + 1;
      }),
      foot
        .map((b) => {
          const l = b.querySelector('.foot-label');
          return l ? `${l.textContent}:${l.scrollWidth}/${l.clientWidth}` : '?';
        })
        .join(' ')
    );
  }

  // 收起 / 展开：收成 **60px 图标轨**、点同一颗回来
  const toggle = byId('btn-sidebar-toggle');
  check('收起按钮在', !!toggle);
  if (toggle) {
    click('#btn-sidebar-toggle');
    await sleep(150);
    check('收起后加上 collapsed', sidebar.classList.contains('collapsed'), sidebar.className);
    check('收起后为66px图标栏', Math.round(sidebar.getBoundingClientRect().width) === 66, String(Math.round(sidebar.getBoundingClientRect().width)));
    check('收起后故事记录仍可见', getComputedStyle(byId('convo-list')).display !== 'none' && byId('convo-list').getBoundingClientRect().height > 0);
    check('收起后保留加号新建', getComputedStyle(byId('btn-new')).display !== 'none' && byId('btn-new').getBoundingClientRect().height >= 34);
    check('顶栏没有重复展开按钮', !byId('btn-sidebar-reopen') && !byId('btn-cast-reopen'));
    check('故事头像仍可交互', $$('#convo-list .convo-item').every(item => item.getBoundingClientRect().height > 0));
    check('底部创作入口仍在故事记录下方', $('.sidebar-foot').getBoundingClientRect().top >= byId('convo-list').getBoundingClientRect().bottom - 1);

    // --- 稿子屏 2 的图标轨：品牌方块 + 6 颗图标 + 最底下当前会话头像 ---
    // 这一节是 2026-10-12 晚补的：之前收起态是 `> *:not(.sidebar-toggle){display:none}`，
    // 收起来就是一根**空条**，而稿子那里是一整列图标。
    // 2026-10-13 晚：品牌区那个琥珀方块 `.brand-dot` 已被图片 `.brand-logo` 取代
    // （见 index.html 的品牌区 / style.css 的 .brand-logo）。断言原来还查 .brand-dot，
    // 拿到 null 就一直白红一条 —— 功能是好的，过时的是选择器。
    // 28px 这条尺寸要求没变（.sidebar.collapsed .brand-logo 里钉着）。
    const railMark = document.querySelector('.brand-logo');
    check(
      '收起后品牌标记还在，而且放大到 28（图标轨的唯一大块）',
      !!railMark &&
        Math.round(railMark.getBoundingClientRect().width) === 28 &&
        getComputedStyle(railMark).display !== 'none',
      railMark ? String(Math.round(railMark.getBoundingClientRect().width)) : '（没有）'
    );
    check(
      '收起后 3 颗创作入口图标都还在，只是文字藏了',
      foot.length === 3 &&
        foot.every((b) => getComputedStyle(b).display !== 'none' && !!b.querySelector('svg')) &&
        foot.every((b) => {
          const label = b.querySelector('.foot-label');
          return !label || getComputedStyle(label).display === 'none';
        }),
      foot.map((b) => getComputedStyle(b).display).join(',')
    );
    check(
      '收起后入口竖成一列（稿子的图标轨就是单列）',
      getComputedStyle(document.querySelector('.sidebar-foot')).gridTemplateColumns.split(' ').length === 1,
      getComputedStyle(document.querySelector('.sidebar-foot')).gridTemplateColumns
    );
    // 收起成图标轨：账号格只剩头像那一颗，文字整块藏掉。
    {
      const acctText = document.querySelector('.account-text');
      check(
        '收起后账号格还在（头像那颗仍可点），只是文字藏了',
        !!byId('btn-account') &&
          byId('btn-account').getBoundingClientRect().width > 0 &&
          !!acctText &&
          getComputedStyle(acctText).display === 'none'
      );
      check('收起后账号颗没越出图标轨', (() => {
        const box = byId('btn-account')?.getBoundingClientRect();
        return !!box && box.width > 0 && box.right <= sidebar.getBoundingClientRect().right + 0.5;
      })());
    }

    const railAv = byId('rail-avatar');
    check(
      '底部不再重复显示当前会话头像',
      !!railAv && getComputedStyle(railAv).display === 'none',
      railAv ? `${Math.round(railAv.getBoundingClientRect().width)}×${Math.round(railAv.getBoundingClientRect().height)} display=${getComputedStyle(railAv).display}` : '（没有）'
    );
    // ⚠️ 它必须走 entityTone 那套按人配色，不许被某条 background 盖成主色
    check(
      '会话头像的按人配色没被盖掉（entityTone 生效）',
      !!railAv && (getComputedStyle(railAv).backgroundImage || '').includes('linear-gradient'),
      railAv ? getComputedStyle(railAv).backgroundImage : '（没有）'
    );

    // 图标轨里每一行都该落在 60px 之内（不许溢出）
    check(
      '图标轨内容不溢出（都在 60px 内）',
      foot.every((b) => b.getBoundingClientRect().right <= sidebar.getBoundingClientRect().right + 0.5),
      String(sidebar.getBoundingClientRect().right)
    );

    click('#btn-sidebar-toggle');
    await sleep(150);
    check('再点一下展开', !sidebar.classList.contains('collapsed'), sidebar.className);
    check('展开后又回到 224', Math.round(sidebar.getBoundingClientRect().width) === 224);
  }

  check('左侧聊天边缘把手已移除', !byId('rail-handle-left'));
});

// ---------------------------------------------------------------------------
//  场景 15b：编辑类弹窗头上的「放大到窗口」按钮
//  行为：把**那个弹窗自己**铺满应用窗口（纯渲染层：给 .modal 挂 modal-max，
//  CSS 撑满；不碰 BrowserWindow，所以这里没有假后端可验 —— 验的是
//  class + 按钮状态）。
//  ⚠️ 2026-10-09：设置那颗撤了 —— 设置从弹窗改成**页面**（视图六）。
//  ⚠️ 2026-10-13：角色卡 / 世界书那两颗也撤了 —— 两个编辑器同样改成了**页面**
//     （视图七 / 视图八），本来就占满主区域。**只剩预设还是弹窗**，所以这个场景
//     现在只测它一颗，另外两头改成「不该再有放大按钮」的断言。
//  ⚠️ 场景结束必须把弹窗都关掉、且不留 modal-max：后面的截图/布局断言
//     都按「弹窗是正常大小」算，留着放大的状态会拍出一张铺满屏幕的图。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
//  场景：账号弹窗 —— 图形校验码 → 注册两步 → 凭证卡 → 退出 → 凭证登录
//
//  ⚠️ 图形码是**图**，自动测试读不到；主进程只在 MIMITALE_ACCOUNT_TEST=1 时把答案
//     一起回给界面，渲染层把它挂在输入框的 dataset.answer 上（界面上不显示）。
//  ⚠️ 邮箱带时间戳：冒烟的数据目录是复用的，写死一个值第二次跑就会「已注册」。
//  ⚠️ 场景结束必须**退出登录并关掉弹窗** —— 后面还有布局和截图断言，
//     一个盖住界面的弹窗、一个变了的侧栏都会把它们带歪。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
//  场景：账号全流程 —— 注册 → 左下角菜单 → 设置页用户信息 → 凭证登录
//
//  ⚠️ 图形码是**图**，自动测试读不到；主进程只在 MIMITALE_ACCOUNT_TEST=1 时把答案
//     一起回给界面，渲染层挂在输入框的 dataset.answer 上（界面上不显示）。
//  ⚠️ 邮箱带时间戳：冒烟的数据目录是复用的，写死一个值第二次跑就会「已注册」。
//  ⚠️ 场景结束必须**退出登录并关掉弹窗** —— 后面还有布局和截图断言。
// ---------------------------------------------------------------------------
await scenario('账号：注册 → 左下角菜单 → 用户信息 → 凭证登录', async () => {
  const answerOf = (sel) => {
    const node = $(sel);
    return node ? String(node.dataset.answer || '') : '';
  };
  const fill = (sel, value) => {
    const node = $(sel);
    if (!node) return false;
    node.value = value;
    return true;
  };
  const errText = (sel) => ($(sel) ? $(sel).textContent.trim() : '');
  const pngSize = (src) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = src;
    });
  const loggedIn = () => /@/.test($('#account-sub')?.textContent || '');

  // 上一轮（或截图 driver）可能在数据目录里留了登录态：先走菜单退出来
  if (loggedIn()) {
    click('#btn-account');
    await waitFor('已登录时先弹出菜单', () => shown('#account-menu'));
    click('#btn-account-menu-logout');
    await waitFor('清掉上一次的登录态', () => !loggedIn());
  }
  check('未登录时没有设置入口（齿轮早就不在了）', !byId('btn-settings'));
  check('未登录时点账号格开的是登录窗', true);

  click('#btn-account');
  await waitFor('账号弹窗打开', () => shown('#account-modal'));
  await waitFor('校验码图出来', () => /^data:image\/svg\+xml/.test($('#acc-login-captcha-img')?.src || ''));
  check('未登录时先落在登录面板', shown('#account-pane-login'));
  check(
    '校验码是主进程画的 SVG',
    /^data:image\/svg\+xml/.test($('#acc-login-captcha-img')?.src || ''),
    ($('#acc-login-captcha-img')?.src || '').slice(0, 34)
  );
  check(
    '登录面板三件事都在（邮箱 / 密码 / 校验码）',
    !!$('#acc-login-email') && !!$('#acc-login-password') && !!$('#acc-login-captcha')
  );

  // --- 注册第一步 ---
  click('#btn-goto-register');
  await waitFor('切到注册面板', () => shown('#account-pane-register'));
  await waitFor('注册面板的校验码也出来了', () => !!answerOf('#acc-reg-captcha'));

  const email = `smoke${Date.now()}@example.com`;
  fill('#acc-reg-email', email);

  // 先故意填错：验「图形码没过，就不给邮箱发验证码」
  fill('#acc-reg-captcha', 'ZZZZ');
  click('#btn-account-send-code');
  await waitFor('错误提示出现', () => errText('#acc-reg-error').length > 0);
  check('图形码不对时明确拒绝', /校验码/.test(errText('#acc-reg-error')), errText('#acc-reg-error'));
  check('被拒之后提示里没有验证码', !/\d{6}/.test($('#acc-reg-hint')?.textContent || ''));
  await waitFor('换了一张新图', () => !!answerOf('#acc-reg-captcha'));

  // 这次填对
  fill('#acc-reg-captcha', answerOf('#acc-reg-captcha'));
  click('#btn-account-send-code');
  await waitFor('验证码发出（演示模式提示）', () => /演示模式/.test($('#acc-reg-hint')?.textContent || ''));
  const hint = $('#acc-reg-hint')?.textContent || '';
  check('校验通过后才发码，并且提示里给了码', /验证码是 \d{6}/.test(hint), hint);
  check('发送按钮进入倒计时', /重新获取/.test($('#btn-account-send-code')?.textContent || ''),
    $('#btn-account-send-code')?.textContent || '');

  const code = (hint.match(/(\d{6})/) || [])[1] || '';
  fill('#acc-reg-code', code);
  click('#btn-account-register-next');
  await waitFor('进注册第二步', () => shown('#account-pane-setup'));
  check(
    '第二步要头像 / 用户名 / 密码',
    !!$('#btn-pick-avatar') && !!$('#acc-setup-name') && !!$('#acc-setup-password')
  );

  // --- 注册第二步 ---
  fill('#acc-setup-name', '烟雾测试员');
  fill('#acc-setup-password', '12345678');
  fill('#acc-setup-password2', '87654321');
  click('#btn-account-finish');
  await waitFor('两次密码不一致的提示', () => errText('#acc-setup-error').length > 0);
  check('两次密码不一样会被拦下', /不一样/.test(errText('#acc-setup-error')), errText('#acc-setup-error'));

  // 选头像：假 pickImage 回一张 SVG 原图，渲染层应该压成 256×256 的 JPEG 再交给主进程
  click('#btn-pick-avatar');
  await waitFor('头像进预览', () => ($('#acc-setup-avatar img')?.src || '').startsWith('data:image/jpeg'));
  const avatarSize = await pngSize($('#acc-setup-avatar img').src);
  check('头像压到 256×256', avatarSize.w === 256 && avatarSize.h === 256, `${avatarSize.w}×${avatarSize.h}`);

  fill('#acc-setup-password2', '12345678');
  click('#btn-account-finish');
  await waitFor('注册完弹窗自己关掉', () => !shown('#account-modal'));
  check('侧栏那一格跟着变成用户名', $('#account-name')?.textContent.trim() === '烟雾测试员',
    $('#account-name')?.textContent);
  check('侧栏头像用的是刚选那张', ($('#account-avatar img')?.src || '').startsWith('data:image/jpeg'));
  check('登录后设置只在账号菜单里，侧栏没有齿轮', !byId('btn-settings'));
  check('登录后副标题（邮箱）不再占一行', getComputedStyle($('#account-sub')).display === 'none');

  // --- 左下角菜单 ---
  click('#btn-account');
  await waitFor('账号菜单弹出', () => shown('#account-menu'));
  check(
    '菜单正好三项：设置 / 意见反馈 / 退出登录',
    $$('#account-menu .menu-item').length === 3,
    String($$('#account-menu .menu-item').length)
  );
  check('菜单里有「设置」并写着快捷键', /Ctrl/.test($('#btn-account-open-settings')?.textContent || ''),
    $('#btn-account-open-settings')?.textContent?.trim());
  check('菜单往上弹（贴在账号格上方）', (() => {
    const menu = $('#account-menu')?.getBoundingClientRect();
    const btn = $('#btn-account')?.getBoundingClientRect();
    return !!menu && !!btn && menu.bottom <= btn.top + 1;
  })());

  // 意见反馈：现在只是占位，点发送要诚实地说没发出去
  click('#btn-account-feedback');
  await waitFor('意见反馈弹窗打开', () => shown('#feedback-modal'));
  check('反馈窗收起了账号菜单', !shown('#account-menu'));
  fill('#feedback-text', '冒烟用的一条反馈');
  click('#btn-feedback-send');
  await waitFor('点发送有回应', () => /还没接上/.test($('#toast')?.textContent || ''));
  check('没后端时不假装发送成功', /还没接上/.test($('#toast')?.textContent || ''), $('#toast')?.textContent);
  check('内容没被清掉（用户写的东西留着）', ($('#feedback-text')?.value || '').length > 0);
  click('#btn-close-feedback');
  await waitFor('反馈窗关掉', () => !shown('#feedback-modal'));

  // --- 设置 → 用户信息 ---
  click('#btn-account');
  await waitFor('菜单再打开', () => shown('#account-menu'));
  click('#btn-account-open-settings');
  await waitFor('切到设置页', () => shown('#view-settings'));
  await waitFor('用户信息那一栏可见', () => shown('#sec-user'));
  check('用户信息是第一栏（默认就选中它）',
    $('#sec-user')?.classList.contains('hidden') === false &&
      document.querySelector('.settings-nav-item.active')?.getAttribute('data-target') === 'sec-user');
  check('账号菜单点完自己收起', !shown('#account-menu'));
  check('资料头显示的是用户名', $('#user-name-view')?.textContent.trim() === '烟雾测试员',
    $('#user-name-view')?.textContent);

  await waitFor('凭证图生成', () => ($('#user-voucher')?.src || '').startsWith('data:image/png'), 6000);
  const voucher = await pngSize($('#user-voucher').src);
  check('凭证卡画的是 1024×640', voucher.w === 1024 && voucher.h === 640, `${voucher.w}×${voucher.h}`);
  const codeOnCard = $('#user-voucher')?.dataset.code || '';
  check('凭证码是 24 位、4 位一组', /^[A-Z0-9]{4}(-[A-Z0-9]{4}){5}$/.test(codeOnCard), codeOnCard);
  // ⚠️ 2026-10-23 真踩过：字符集只有 31 个却按 % 32 取，下标 31 拼出 "undefined"，
  //    码变成 32 位、中间夹一段字母 'ndef-ined'。上一条正则就是为它加的守卫。
  check(
    '凭证码里不会混进 undefined 这类脏字',
    !/undefined|null|nan/i.test(codeOnCard) && codeOnCard.replace(/-/g, '').length === 24,
    codeOnCard
  );

  click('#btn-user-export-voucher');
  await sleep(500);
  check('导出走的是 PNG 保存通道', /已导出/.test($('#toast')?.textContent || ''), $('#toast')?.textContent);

  // 导出的那张图里必须带着码本身（登录面板「导入凭证图片」靠它，不做 OCR）。
  // 两条一起验：脏字守卫 + 「这张真图能读回同一个码」。
  const cardMod = await import(new URL('js/ui/voucherCard.js', document.baseURI).href);
  const codeInPng = cardMod.readVoucherCodeFromImage($('#user-voucher').src);
  check(
    '凭证 PNG 里带着凭证码（导入登录靠它，不是认字）',
    codeInPng === codeOnCard.replace(/-/g, ''),
    `读回 ${codeInPng || '(空)'} / 卡面 ${codeOnCard}`
  );
  check(
    '随便一张图不会瞎读出码',
    cardMod.readVoucherCodeFromImage(
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')
    ) === '',
    '非 PNG 应当读不出'
  );

  // 改用户名：侧栏那一格要跟着变；改完再改回去
  fill('#user-name-input', '改名试一下');
  click('#btn-user-save-name');
  await waitFor('用户名改好', () => $('#account-name')?.textContent.trim() === '改名试一下');
  check('改用户名后侧栏跟着变', $('#account-name')?.textContent.trim() === '改名试一下');
  fill('#user-name-input', '烟雾测试员');
  click('#btn-user-save-name');
  await waitFor('名字改回来', () => $('#account-name')?.textContent.trim() === '烟雾测试员');

  // 改密码：当前密码错 → 拒绝；对了 → 成功（再改回原密码）
  fill('#user-pass-current', '错误的密码');
  fill('#user-pass-new', 'abcdefgh');
  fill('#user-pass-confirm', 'abcdefgh');
  click('#btn-user-save-pass');
  await waitFor('当前密码错会被拦', () => errText('#user-pass-error').length > 0);
  check('当前密码不对就改不了', /当前密码/.test(errText('#user-pass-error')), errText('#user-pass-error'));

  fill('#user-pass-current', '12345678');
  click('#btn-user-save-pass');
  await waitFor('密码改好', () => /密码改好/.test($('#toast')?.textContent || ''));
  check('密码改成功', /密码改好/.test($('#toast')?.textContent || ''), $('#toast')?.textContent);
  // 改回来，免得后面凭证登录 / 截图对不上
  fill('#user-pass-current', 'abcdefgh');
  fill('#user-pass-new', '12345678');
  fill('#user-pass-confirm', '12345678');
  click('#btn-user-save-pass');
  await sleep(400);

  // 改邮箱：新邮箱 + 图形码 + 验证码
  await waitFor('邮箱块的校验码出来', () => !!answerOf('#user-email-captcha'));
  const newEmail = `smoke${Date.now()}b@example.com`;
  fill('#user-email-input', newEmail);
  fill('#user-email-captcha', answerOf('#user-email-captcha'));
  click('#btn-user-send-code');
  await waitFor('邮箱验证码发出', () => /演示模式/.test($('#user-email-hint')?.textContent || ''));
  const emailCode = (($('#user-email-hint')?.textContent || '').match(/(\d{6})/) || [])[1] || '';
  fill('#user-email-code', emailCode);
  click('#btn-user-save-email');
  await waitFor('邮箱改好', () => ($('#user-email-view')?.textContent || '').includes(newEmail));
  check('改邮箱后资料头跟着变', ($('#user-email-view')?.textContent || '').includes(newEmail),
    $('#user-email-view')?.textContent);
  check('改邮箱后侧栏副标题也是新邮箱', ($('#account-sub')?.textContent || '').includes(newEmail),
    $('#account-sub')?.textContent);

  // --- 退出 → 用凭证码登回来 ---
  click('#btn-account');
  await waitFor('菜单打开（准备退出）', () => shown('#account-menu'));
  click('#btn-account-menu-logout');
  await waitFor('退出后侧栏回到未登录', () => $('#account-name')?.textContent.trim() === '未登录');
  check('退出登录走的是菜单那一项', $('#account-name')?.textContent.trim() === '未登录');

  click('#btn-account');
  await waitFor('未登录点开还是登录窗', () => shown('#account-modal'));
  click('#btn-goto-voucher');
  await waitFor('切到凭证面板', () => shown('#account-pane-voucher'));

  // --- 先走「导入凭证图片」：不用手抄码 ---
  // 主进程桩把刚才导出的那张 PNG 原样喂回来（见 smoke-test.js 的 images:pick）。
  check('凭证面板上有「导入凭证图片」这颗按钮', !!$('#btn-voucher-import'));
  click('#btn-voucher-import');
  await waitFor('导入凭证图后直接登进去', () => !shown('#account-modal'), 6000);
  check('导入凭证图就能登录（不用手抄）', $('#account-name')?.textContent.trim() === '烟雾测试员',
    $('#account-name')?.textContent);

  // 再退出来，验手输那条路还在（大小写不敏感）
  click('#btn-account');
  await waitFor('菜单打开（准备再退一次）', () => shown('#account-menu'));
  click('#btn-account-menu-logout');
  await waitFor('退出后可再进凭证面板', () => $('#account-name')?.textContent.trim() === '未登录');

  click('#btn-account');
  await waitFor('未登录点开还是登录窗', () => shown('#account-modal'));
  click('#btn-goto-voucher');
  await waitFor('切到凭证面板', () => shown('#account-pane-voucher'));
  fill('#acc-voucher-code', codeOnCard.toLowerCase());
  click('#btn-account-voucher-login');
  await waitFor('凭证登录成功', () => !shown('#account-modal'));
  check('凭证码不区分大小写也能登', $('#account-name')?.textContent.trim() === '烟雾测试员',
    $('#account-name')?.textContent);

  // 收尾：走菜单退出，别把登录态留给后面的场景
  click('#btn-account');
  await waitFor('菜单打开（收尾）', () => shown('#account-menu'));
  click('#btn-account-menu-logout');
  await waitFor('收尾退出', () => $('#account-name')?.textContent.trim() === '未登录');
  await waitFor('账号弹窗是关着的', () => !shown('#account-modal'));
});

await scenario('编辑弹窗的放大按钮', async () => {
  const maxed = (id) => byId(id).classList.contains('modal-max');
  check('预设头上那颗放大按钮还在', !!byId('btn-fs-preset'));
  check('设置那颗已经撤掉（它成了页面，没有「放大」这回事）', !byId('btn-fs-settings'));
  check('角色卡那颗也撤了（编辑器成了页面）', !byId('btn-fs-chars'));
  check('世界书那颗也撤了（编辑器成了页面）', !byId('btn-fs-worldbooks'));

  // --- 开一下、放大、还原（拿预设编辑器当样本）---
  click('#btn-presets');
  await waitFor('切到预设列表页', () => shown('#view-presets'));
  click(buttonByText($$('#preset-page-grid .preset-row')[0], '编辑'));
  await waitFor('预设编辑器打开', () => shown('#preset-modal'));
  check('刚打开时不是放大状态', !maxed('preset-modal'));

  click('#btn-fs-preset');
  await waitFor('弹窗放大', () => maxed('preset-modal'));
  check('点一下把弹窗放大到窗口', maxed('preset-modal'));
  // 图标是「四角向外 / 向内」两张 SVG 二选一，只看 class 验不出来；
  // aria-pressed 和 title 是读屏 / 悬停唯一能读到的状态，必须跟着走。
  check('放大后按钮标成「已按下」', byId('btn-fs-preset').getAttribute('aria-pressed') === 'true');
  check('放大后按钮改说「还原」', /还原/.test(byId('btn-fs-preset').getAttribute('title') || ''));

  click('#btn-fs-preset');
  await waitFor('弹窗还原', () => !maxed('preset-modal'));
  check('再点一下还原回正常大小', !maxed('preset-modal'));
  check('还原后按钮回到「未按下」', byId('btn-fs-preset').getAttribute('aria-pressed') === 'false');

  // --- 关掉弹窗时把放大状态摘掉，下次打开别记住 ---
  click('#btn-fs-preset');
  await waitFor('预设再放大', () => maxed('preset-modal'));
  click('#btn-close-preset');
  await waitFor('预设弹窗关闭', () => !shown('#preset-modal'));
  check('关掉弹窗时放大状态被摘掉', !maxed('preset-modal'));

  click(buttonByText($$('#preset-page-grid .preset-row')[0], '编辑'));
  await waitFor('预设编辑器重开', () => shown('#preset-modal'));
  check('重新打开回到正常大小（不记住上次放大）', !maxed('preset-modal'));
  click('#btn-close-preset');
  await waitFor('预设弹窗再关', () => !shown('#preset-modal'));

  check('收尾后弹窗没有留着放大状态', !maxed('preset-modal'));

  // --- 角色编辑器 / 世界书编辑器：换成「整页」之后不该再有任何 modal-max 的痕迹 ---
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click(buttonByText($$('#char-page-grid .char-card')[0], '编辑'));
  await waitFor('角色编辑页打开', () => shown('#view-char-editor'));
  check(
    '角色编辑页不是浮层（在文档流里，没有 z-index）',
    getComputedStyle(byId('view-char-editor')).position !== 'fixed',
    getComputedStyle(byId('view-char-editor')).position
  );

  // 左栏是「整栏固定、右列独立滚动」的布局 —— 所以它自己**不该**长出栏内滚动条。
  // 2026-10-16（V2）实测过一次：左栏内容比栏高多 18px，截图上看只是右缘一条细线，
  // 很容易漏掉；修完之后余量 38px。这条断言就是替眼睛守它。
  // ⚠️ 别改成量「余量」——栏底那三样是 margin-top:auto 钉住的，装得下时它会把余量
  //    全吃成外边距；overflow 发生的那一刻 auto 外边距归零，scrollHeight 才会超过
  //    clientHeight。所以 scrollHeight <= clientHeight 正好就是「装得下」。
  const rail = $('.char-identity-pane');
  check(
    '角色编辑页左栏没有长出栏内滚动条',
    !!rail && rail.scrollHeight <= rail.clientHeight + 1,
    rail ? `scrollHeight ${rail.scrollHeight} vs clientHeight ${rail.clientHeight}` : '(没有左栏)'
  );
  click('#btn-close-chars');
  await waitFor('回到角色卡', () => shown('#view-chars'));
});

// ---------------------------------------------------------------------------
//  场景 12：导出（角色卡 / 世界书 / 会话）
//
//  这里只负责「点按钮 + 看渲染层交了什么东西给主进程」；
//  真正的「写 PNG → 读 PNG」往返由宿主侧用同一份实现跑（见 smoke-test.js）。
// ---------------------------------------------------------------------------
await scenario('导出', async () => {
  // 说明：导出交上去的东西在页面里看不见（发给主进程了），
  // 所以具体内容由宿主侧断言（见 smoke-test.js 的 probeExports）；
  // 这里只负责点按钮 + 确认给了反馈。

  // --- 角色卡 ---
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  // 认名字不按下标：角色卡是按更新时间排的，前面几场都会把它顶到第一位。
  const exportSourceCard = $$('#char-page-grid .char-card').find((c) => c.textContent.includes('属性测试角色'));
  check('角色卡里有「属性测试角色」', !!exportSourceCard, $$('#char-page-grid .char-card').map((c) => c.textContent.slice(0, 12)).join(' / '));
  click(buttonByText(exportSourceCard, '编辑'));
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  // 先给它绑一本世界书再导出 —— 这样「导出的卡带不带 character_book」
  // 才验得到（宿主侧的 probeExports 会看导出的卡里有没有这本）。
  // ⚠️ 2026-10-20：编辑器里的「导出」撤了，卡片只能从角色卡那颗按 id 取**落盘**的那一张，
  //    所以绑定必须真的保存下去（以前不保存也能导出，因为导出的是内存里那个对象）。
  click('#c-wb-add-btn');
  await waitFor('世界书选择浮层出现', () => !!$('.cwb-picker'));
  const exportBook = $$('.cwb-picker .cwb-picker-row').find((o) =>
    String(o.textContent || '').includes('冒烟测试世界')
  );
  if (exportBook) {
    click(exportBook);
    await waitFor('导出场景：世界书绑上了', () => $$('#c-wb-list .cwb-row').length === 1);
  } else {
    check('导出场景：能选到种子世界书', false, JSON.stringify($$('.cwb-picker .cwb-picker-row').map((o) => o.textContent.trim())));
  }

  click('#btn-save-char');
  await waitFor('导出场景：绑定落盘', async () => {
    const saved = (await savedCharacters()).find((c) => c.name === '属性测试角色');
    return !!saved && Array.isArray(saved.worldbookIds) && saved.worldbookIds.length > 0;
  });

  // 制造一处没保存的改动：用左栏那颗「返回」离开时要先拦一下，别把改动静默丢掉
  // （顺便验这颗新按钮走的是和页头「返回」同一个动作，不是自己另写一套）
  setValue('#c-desc', `${byId('c-desc').value}（未保存）`);
  click('#btn-back-char');
  await waitFor('左栏「返回」遇到未保存改动会拦一下', () => shown('#confirm-modal'));
  check(
    '确认框说的是「没保存的改动」',
    byId('confirm-message').textContent.includes('没保存'),
    byId('confirm-message').textContent
  );
  click('#confirm-ok');
  await waitFor('确认放弃后回到角色卡', () => shown('#view-chars'));

  // --- 角色卡卡片上的「导出」：不用为了拿走一张卡先进详情页 ---
  const listCard = $$('#char-page-grid .char-card').find((c) => c.textContent.includes('属性测试角色')) ||
    $$('#char-page-grid .char-card')[0];
  const listExport = listCard && buttonByText(listCard, '导出');
  check('角色卡列表上有「导出」按钮', !!listExport);
  if (listExport) {
    const toast = $('#toast');
    if (toast) {
      toast.classList.add('hidden');
      toast.textContent = '';
    }
    click(listExport);
    await sleep(300);
    check('从列表导出角色卡后有提示', $('#toast').textContent.includes('已导出'), $('#toast').textContent);
  }

  // --- 会话 ---
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await clickMoreItem('#btn-export-convo');
  await sleep(300);
  check('导出会话后有提示', $('#toast').textContent.includes('已导出'), $('#toast').textContent);

  // --- 空会话不该导出：点「聊天」会新建一个还没说话的空会话 ---
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  await startChatWith($$('#char-page-grid .char-card')[0]);
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(150);
  await clickMoreItem('#btn-export-convo');
  await sleep(250);
  check('空会话不给导出', $('#toast').textContent.includes('还是空的'), $('#toast').textContent);
});

// ---------------------------------------------------------------------------
//  场景 15：世界书递归扫描
//
//  种子世界里埋了一条链：世界总览(递归) → 十二泰坦 / 火种。
//  只要会话里出现「翁法罗斯」，总览命中，它的正文再带出另外两条。
//  真实现跑在 main/worldbook-match.js，假后端直接 require 它。
// ---------------------------------------------------------------------------
await scenario('世界书：递归扫描', async () => {
  // 先让当前会话里出现触发词
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  setValue('#input', '翁法罗斯到底是个什么样的地方？');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);
  await sleep(250);

  await openWorldbookEditor('冒烟测试世界');
  await sleep(150);

  click('#btn-preview-wb');
  await sleep(400);
  const toast = $('#toast').textContent;

  check('直接命中的那条在', toast.includes('世界总览'), toast);
  check('递归把「十二泰坦」带进来了', toast.includes('十二泰坦'), toast);
  check('递归带进来的条目也能再往下带（火种）', toast.includes('火种'), toast);
  check('说明了有几条是递归来的', toast.includes('2 条是递归带进来的'), toast);
  check('没命中的条目不会被塞进来', !toast.includes('无关条目'), toast);

  // 预览失败时不该弹「命中 0 条」之外的东西
  check('预览给的是命中摘要', toast.includes('命中 3 条'), toast);
});

// ---------------------------------------------------------------------------
//  场景 16：世界书 —— 新建条目 + 「保存后才生效」
// ---------------------------------------------------------------------------
await scenario('世界书：新建条目', async () => {
  await openWorldbookEditor('冒烟测试世界');

  // 2026-10-16：这一页 14 颗 .btn 全换 <m-button>。`.wb-entry-actions` 那三颗的
  // 内边距（6px 8px）写在**里层**上 —— 写到宿主上不报错，只是按钮瘦不下来。
  // ⚠️ btn-close-worldbooks（返回）2026-10-19 挪到左上角并改成图标按钮，
  //    图标按钮按约定不套 m-button，所以从这张表里去掉。
  // ⚠️ btn-export-wb 2026-10-20 从书籍条去掉了（搬到列表卡片上），也去掉。
  const WB_BTN_IDS = ['btn-save-wb','btn-add-wb-chars','btn-ai-wb-char','btn-new-wb-char','btn-sync-wb-attrs','btn-preview-wb','btn-del-worldbook','btn-new-entry','btn-wb-entry-template','btn-wb-add-event','btn-del-entry'];
  const wbBad = WB_BTN_IDS.filter((id) => byId(id)?.tagName !== 'M-BUTTON');
  check('世界书编辑器 11 颗按钮都是 m-button 宿主', wbBad.length === 0, wbBad.join(', ') || '全部是');
  check('编辑器里没有「导出」按钮', !byId('btn-export-wb'));
  // 2026-10-20：保存从页头右上搬到书籍条右侧 —— 书籍条三屏共用，位置在任何
  // tab 都固定，且紧挨脏状态胶囊。页头只剩「返回 / 标题 / 全文 N 字」。
  const wbSaveBtn = byId('btn-save-wb');
  const wbSaveHost = wbSaveBtn.closest('.wb-bookbar-actions');
  check('保存按钮在书籍条右侧', !!wbSaveHost && !!wbSaveHost.closest('.wb-bookbar'));
  check('保存按钮不在页头', !wbSaveBtn.closest('.wb-head'));
  check('保存胶囊跟保存按钮挨在一起', byId('wb-save-state').parentElement === wbSaveHost);
  check('页头不再有面包屑', !byId('wb-crumb'));
  check('页头右侧只剩字数', [...document.querySelectorAll('#view-wb-editor .wb-head .page-actions > *')]
    .every((node) => node === byId('wb-total-words')), [...document.querySelectorAll('#view-wb-editor .wb-head .page-actions > *')].map((n) => n.id || n.className).join(','));
  // 每次进编辑器都落在「条目」屏（书籍设置屏已经撤了）
  check('进编辑器默认在「条目」屏',
    !byId('wb-panel-entries').hidden && byId('wb-panel-characters').hidden,
    `entries=${!byId('wb-panel-entries').hidden} chars=${!byId('wb-panel-characters').hidden}`);
  check('「书籍设置」屏已经不存在了', !byId('wb-panel-settings') && !byId('wb-tab-settings'));
  click('#wb-tab-entries');
  await sleep(120);
  check('切到「条目」屏', !byId('wb-panel-entries').hidden);
  // ⚠️ 同角色编辑器：JS 渲染的 .btn 还在这页上（NPC 属性面板共用同一套），
  //    「没有原生 .btn」要等 JS 侧调用点迁完才能上。
  check('条目行按钮的内边距落在里层（6px 8px）', getComputedStyle(byId('btn-new-entry').control).paddingLeft === '8px', getComputedStyle(byId('btn-new-entry').control).padding);

  click('#btn-new-entry');
  setValue('#wb-e-title', '冒烟测试条目');
  setValue('#wb-e-keys', '冒烟');
  setValue('#wb-e-content', '命中时注入的设定内容');

  // 左栏那一行跟着表单走（改了名字立刻看得到 —— 以前是点「保存条目」才回填的）
  await waitFor('条目出现在列表里', () => $('#wb-entry-list').textContent.includes('冒烟测试条目'));

  // 「保存后才生效」：改动先落在草稿里，没点保存之前磁盘上不该有它
  check('没保存的条目不会提前落盘',
    !((await savedWorldbooks())[0].entries || []).some((e) => e.title === '冒烟测试条目'),
    `落盘的是 ${JSON.stringify(((await savedWorldbooks())[0].entries || []).map((e) => e.title))}`);
  check('页头保存胶囊翻成「有未保存的改动」', byId('wb-save-state').dataset.state === 'dirty', byId('wb-save-state').textContent);

  click('#btn-save-wb');
  await sleep(300);

  const books = await savedWorldbooks();
  const titles = (books[0].entries || []).map((e) => e.title);
  check('点「保存」之后条目才落盘', titles.includes('冒烟测试条目'), `落盘的是 ${JSON.stringify(titles)}`);
  check('保存完保存胶囊回到「所有更改已保存」', byId('wb-save-state').dataset.state === 'saved', byId('wb-save-state').textContent);
  check('保存有提示', $('#toast').textContent.includes('已保存'), $('#toast').textContent);

  // --- 「条目」标题 + 行上的 × ---
  check('「条目」有自己的标题（左栏顶部那行）',
    $('.wb-side-title').textContent.includes('条目'), $('.wb-side-title').textContent);
  check('条目数挂在标题旁边（不再挂在书名下面）',
    $('.wb-side-title .wb-count') === byId('wb-entry-count'));

  // --- 布局：条目屏是三栏（列表 / 正文 / 本条属性） ---
  // 2026-10-18 按设计稿 A「条目工作台」重排：一天里九成时间在写条目，
  // 所以三个开关和两个数字搬进右栏（改完立刻看见），正文收进舒适阅读宽度。
  const wbRect = (sel) => $(sel).getBoundingClientRect();
  check('条目屏是三栏（列表 / 正文 / 属性）',
    getComputedStyle($('#wb-panel-entries')).gridTemplateColumns.split(/\s+/).length === 3,
    getComputedStyle($('#wb-panel-entries')).gridTemplateColumns);
  check('本书角色不挤占条目编辑区',
    byId('wb-panel-characters').hidden);
  check('正文列比条目列表宽（它才是主工作区）',
    wbRect('.wb-doc').width > wbRect('.wb-list').width,
    `正文 ${Math.round(wbRect('.wb-doc').width)} vs 列表 ${Math.round(wbRect('.wb-list').width)}`);
  // 舒适阅读区 30–45 字/行：14px 的汉字大约 14px 一个，420–680 折算约 30–48 字
  check('正文收进舒适阅读宽度（≤ 680）',
    wbRect('.wb-measure').width <= 680 && wbRect('.wb-measure').width >= 420,
    `${Math.round(wbRect('.wb-measure').width)}px`);
  check('三个开关和两个数字都在右栏（同一屏可见）',
    ['wb-e-enabled', 'wb-e-constant', 'wb-e-recursive', 'wb-e-order', 'wb-e-prob']
      .every((id) => $('.wb-aside').contains(byId(id))),
    ['wb-e-enabled', 'wb-e-constant', 'wb-e-recursive', 'wb-e-order', 'wb-e-prob']
      .filter((id) => !$('.wb-aside').contains(byId(id))).join(', ') || '全在右栏');
  // 元信息被 × 压住是改版前的旧账（「顺序 100」显示成「1」）——这里用几何位置钉住
  const entryMeta = $('#wb-entry-list .wb-entry .wb-entry-meta');
  const entryDel = $('#wb-entry-list .wb-entry .wb-entry-del');
  check('「字数 · 顺序」不再被 × 压住',
    !!entryMeta && !!entryDel &&
    entryMeta.getBoundingClientRect().right <= entryDel.getBoundingClientRect().left + 1,
    entryMeta && entryDel ? `元信息右 ${Math.round(entryMeta.getBoundingClientRect().right)} vs × 左 ${Math.round(entryDel.getBoundingClientRect().left)}` : '找不到元信息或 ×');
  check('条目行比改版前瘦（≤ 72px）',
    wbRect('#wb-entry-list .wb-entry').height <= 72,
    `${Math.round(wbRect('#wb-entry-list .wb-entry').height)}px`);
  // × 从「绝对定位浮在右上角」改成「右边一列、自己垂直居中」（2026-10-20）
  const entryRow = entryDel ? entryDel.closest('.wb-entry') : null;
  const rowBox = entryRow ? entryRow.getBoundingClientRect() : null;
  const delBox = entryDel ? entryDel.getBoundingClientRect() : null;
  check('行上的 × 垂直居中（上下留白相等）',
    !!rowBox && !!delBox && Math.abs((delBox.top - rowBox.top) - (rowBox.bottom - delBox.bottom)) <= 2,
    rowBox && delBox ? `上 ${Math.round(delBox.top - rowBox.top)} / 下 ${Math.round(rowBox.bottom - delBox.bottom)}` : '找不到条目行');
  check('本书角色有自己独立的分区',
    $('#wb-panel-characters').contains(byId('wb-char-list')));
  // 书名改在条目左栏顶部；删除本书也落在这里（不再有设置屏）
  check('书名改在条目左栏顶部',
    $('.wb-list').contains(byId('wb-name')) && !$('#wb-bookbar').contains(byId('wb-name')));
  check('删除本书在左栏底部',
    $('.wb-list').contains(byId('btn-del-worldbook')) &&
    byId('btn-del-worldbook').closest('.wb-list-danger') !== null);
  check('书籍条只剩「预览命中」和「保存」',
    !byId('btn-export-wb') &&
    $('#wb-bookbar').contains(byId('btn-preview-wb')) &&
    $('#wb-bookbar').contains(byId('btn-save-wb')));
  // 统计去重：全书统计只在书籍条出现一次，页头只留字数
  check('书籍条一行读完这本书（条 / 启用 / 常驻 / 角色）',
    /条/.test(byId('wb-bookbar-sub').textContent) && /角色/.test(byId('wb-bookbar-sub').textContent),
    byId('wb-bookbar-sub').textContent);
  check('页头只剩全文总字数（统计不再重复三处）',
    /^全文 [\d,]+ 字$/.test(byId('wb-total-words').textContent),
    byId('wb-total-words').textContent);
  // 右栏三张卡（三颗开关 / 两个数字 / 本条目）要一屏看完 —— 溢出就说明有卡被裁，
  // 「删除条目」会藏在滚动条下面（1440×900 是这个断言的前提，窗口尺寸变了要一起调）
  const aside = $('.wb-aside');
  check('右栏三张卡一屏放得下（不用滚）',
    aside.scrollHeight <= aside.clientHeight + 1,
    `${aside.scrollHeight} / ${aside.clientHeight}`);
  check('「＋ 条目」跟着条目列表走', $('.wb-list').contains(byId('btn-new-entry')));
  const draftText = byId('wb-e-content').value;
  click('#wb-tab-characters');
  await sleep(120);
  check('切到「本书角色」后条目屏收起来了', byId('wb-panel-characters').hidden === false && byId('wb-panel-entries').hidden);
  click('#wb-tab-entries');
  await sleep(120);
  check('世界书分区切换保留条目草稿', byId('wb-e-content').value === draftText);
  setValue('#wb-search', '世界总览');
  check('世界书搜索过滤条目列表', $$('#wb-entry-list .wb-entry').length === 1);
  setValue('#wb-search', '');
  // 页脚只有那一行状态提示（导出 / 预览这些动作都在书籍条或列表卡片上，不下来）
  check('页脚只剩那行状态提示',
    !!byId('wb-foot-hint') && $('#view-wb-editor .page-foot').querySelectorAll('button, m-button').length === 0,
    $('#view-wb-editor .page-foot').textContent.trim());

  // 两条新条目：删「甲」的时候不该把编辑焦点从「乙」抢走（× 上的 stopPropagation）
  click('#btn-new-entry');
  setValue('#wb-e-title', '甲条目');
  click('#btn-new-entry');
  setValue('#wb-e-title', '乙条目');
  await waitFor('甲、乙两条都在列表里', () =>
    $('#wb-entry-list').textContent.includes('甲条目') && $('#wb-entry-list').textContent.includes('乙条目'));
  check('正在编辑的是刚建的「乙条目」', byId('wb-e-title').value === '乙条目', byId('wb-e-title').value);

  click($$('#wb-entry-list .wb-entry').find((r) => r.textContent.includes('甲条目')).querySelector('.wb-entry-del'));
  await sleep(150);
  check('× 把那条条目删掉了', !$('#wb-entry-list').textContent.includes('甲条目'));
  check('× 删除不弹确认框', !shown('#confirm-modal'));
  check('× 不会顺手把编辑焦点抢过去', byId('wb-e-title').value === '乙条目', byId('wb-e-title').value);
  check('× 删除有「点保存才写进磁盘」的提示', $('#toast').textContent.includes('点「保存」'), $('#toast').textContent);

  // 删正在编辑的那一条 → 焦点落到剩下的第一条，不会停在一个已经不存在的条目上
  click($$('#wb-entry-list .wb-entry').find((r) => r.textContent.includes('乙条目')).querySelector('.wb-entry-del'));
  await sleep(150);
  check('删掉正在编辑的那条，焦点落到第一条', byId('wb-e-title').value === '世界总览', byId('wb-e-title').value);
  check('右栏表单还开着（条目没删空）', shown('#wb-form'));

  click('#btn-save-wb');
  await sleep(300);
  const keptTitles = ((await savedWorldbooks())[0].entries || []).map((e) => e.title);
  check('× 删掉的条目保存后没落到磁盘上',
    !keptTitles.includes('甲条目') && !keptTitles.includes('乙条目'), JSON.stringify(keptTitles));
  check('别的条目没被误删', keptTitles.includes('世界总览'), JSON.stringify(keptTitles));
});

// ---------------------------------------------------------------------------
//  场景 16b：世界书 —— 关弹窗时「没保存的改动」要拦一下
// ---------------------------------------------------------------------------
await scenario('世界书：放弃未保存的改动', async () => {
  // 世界书弹窗还开着（上一条场景留下的）
  check('世界书弹窗还开着', shown('#view-wb-editor'));

  setValue('#wb-name', '改了一半的名字');
  await sleep(120);
  check('改名之后保存胶囊翻成未保存', byId('wb-save-state').dataset.state === 'dirty', byId('wb-save-state').textContent);

  // 点关闭 → 先问一句；选「继续改」就什么都别动
  click('#btn-close-worldbooks');
  await waitFor('弹放弃确认框', () => shown('#confirm-modal'));
  check('有未保存的改动时关弹窗会问一句', shown('#confirm-modal'));
  click('#confirm-cancel');
  await sleep(120);
  check('选「继续改」弹窗留着', shown('#view-wb-editor'));
  check('名字还是改了一半的那个', byId('wb-name').value === '改了一半的名字', byId('wb-name').value);

  // 再来一次，这回真的放弃
  click('#btn-close-worldbooks');
  await waitFor('再弹一次确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('世界书弹窗关闭', () => !shown('#view-wb-editor'));

  const names = (await savedWorldbooks()).map((b) => b.name);
  check('放弃之后改的名字没落盘', !names.includes('改了一半的名字'), JSON.stringify(names));
  check('关掉之后回到角色编辑器（书是从那儿进的）', shown('#view-char-editor'));
});

// ---------------------------------------------------------------------------
//  场景 11：世界书 —— 新建「本书角色」，同时验证编辑器没被世界书弹窗盖住
// ---------------------------------------------------------------------------
await scenario('世界书：本书角色', async () => {
  // 上一条场景把弹窗关掉了，这里自己从角色的「自带世界书」开进去
  await openWorldbookEditor('冒烟测试世界');

  click('#btn-new-wb-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  check('标题是「新建本书角色」', byId('chars-title').textContent === '新建本书角色', byId('chars-title').textContent);

  // 回归测试：角色编辑器必须盖在世界书弹窗上面（否则点了跟没反应一样）
  const cx = Math.floor(innerWidth / 2);
  const cy = Math.floor(innerHeight / 2);
  const top = document.elementFromPoint(cx, cy);
  const where = top ? (top.closest('#view-char-editor') ? 'chars' : top.closest('#view-wb-editor') ? 'worldbooks' : 'other') : 'null';
  check('编辑器没有被世界书弹窗盖住', where === 'chars', `最上层是 ${where}`);

  const before = ((await savedWorldbooks())[0].characters || []).length;

  setValue('#c-name', '冒烟NPC');
  click('#btn-save-char');
  await waitFor('副本 chip 出现', () => $('#wb-char-list').textContent.includes('冒烟NPC'));

  const after = ((await savedWorldbooks())[0].characters || []).length;
  check('副本已落盘', after === before + 1, `期望 ${before + 1}，实际 ${after}`);

  click('#btn-close-chars');
  await sleep(120);
  check('副本保存后关闭不弹确认框', !shown('#confirm-modal'));
  check('本书角色复用角色卡相同的分区编辑器', !!byId('char-field-index') && !!byId('char-section-tab-state'));
  check('共享角色编辑器返回原世界书角色分区', shown('#view-wb-editor') && !byId('wb-panel-characters').hidden);

  // 2026-10-18：「本书角色」有了自己的一屏，标题那套「整块折叠」撤了
  // （那是单栏时代为了不让一排 chip 把开场白挤没才做的）。这里改成钉住新形态。
  check('副本数标在分区标签上', byId('wb-tab-characters-n').textContent === String(after),
    byId('wb-tab-characters-n').textContent);
  check('每张副本卡都标着「本书副本」',
    $$('#wb-char-list .wb-local-tag').length === after,
    `${$$('#wb-char-list .wb-local-tag').length} / ${after}`);
  check('副本卡上面那颗是「移出本书」（说的是从这本书里移出去）',
    $$('#wb-char-list .wb-char-card-btn').some((b) => b.textContent === '移出本书'));
  check('角色屏顶部那行写着「副本只属于这本书」',
    byId('wb-chars-hint').textContent.includes('副本只属于这本书'), byId('wb-chars-hint').textContent);

  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#view-wb-editor'));
});

// ---------------------------------------------------------------------------
//  场景：世界书 —— 条目字段往返 + 状态筛选 + 预览命中的前置条件
//
//  C 节那 8 行里，以前只有「有几条条目 / 保存前后有没有落盘」被点过；
//  **字段本身写没写进落盘文件**（概率 / 附加关键词 / 附加逻辑 / 顺序）没人管，
//  而落盘那边是白名单式归一化（main/worldbook-parse.js）—— 漏一个字段就是
//  「界面上填了、重启就没了」，不报错。所以这里把六个字段走一遍真实落盘 + 重开回填。
// ---------------------------------------------------------------------------
await scenario('世界书：条目字段往返与状态筛选', async () => {
  const bookName = '冒烟测试世界';
  const loadBook = async () => (await savedWorldbooks()).find((b) => b.name === bookName);
  const openEditor = async () => {
    await openWorldbookEditor(bookName);
    click('#wb-tab-entries');
    await sleep(100);
  };

  await openEditor();
  const before = (await loadBook()).entries.length;

  // --- 建一条，把六个字段都改成非默认值 ---
  click('#btn-new-entry');
  setValue('#wb-e-title', '字段往返');
  setValue('#wb-e-keys', '门, 钥匙');
  setValue('#wb-e-keys2', '夜晚');
  setValue('#wb-e-logic', 'AND_ALL');
  setValue('#wb-e-order', '410');
  setValue('#wb-e-prob', '40');
  setValue('#wb-e-content', '字段往返用的正文');
  await sleep(120);
  click('#btn-save-wb');
  await sleep(400);

  const savedEntry = ((await loadBook()).entries || []).find((e) => e.title === '字段往返');
  check('新条目落盘了', !!savedEntry);
  if (!savedEntry) return;
  check('关键词按逗号拆成数组落盘', JSON.stringify(savedEntry.keys) === JSON.stringify(['门', '钥匙']),
    JSON.stringify(savedEntry.keys));
  check('附加关键词落盘', JSON.stringify(savedEntry.secondaryKeys) === JSON.stringify(['夜晚']),
    JSON.stringify(savedEntry.secondaryKeys));
  check('附加关键词逻辑落盘（不是被退回默认的 AND_ANY）', savedEntry.selectiveLogic === 'AND_ALL', savedEntry.selectiveLogic);
  check('插入顺序落盘（空值不该兜成 100）', savedEntry.order === 410, String(savedEntry.order));
  check('触发概率落盘（空值不该兜成 100）', savedEntry.probability === 40, String(savedEntry.probability));
  check('正文落盘', savedEntry.content === '字段往返用的正文', savedEntry.content);

  // --- 重开编辑器：表单要按落盘那份回填 ---
  click('#btn-close-worldbooks');
  await waitFor('回到角色编辑器', () => shown('#view-char-editor'));
  await openEditor();
  const row = $$('#wb-entry-list .wb-entry').find((r) => r.textContent.includes('字段往返'));
  check('重开之后左栏里有刚才那条', !!row);
  if (row) click(row);
  await sleep(150);
  check('重开之后六栏都按落盘值回填',
    byId('wb-e-title').value === '字段往返' &&
    byId('wb-e-keys').value === '门, 钥匙' &&
    byId('wb-e-keys2').value === '夜晚' &&
    byId('wb-e-logic').value === 'AND_ALL' &&
    byId('wb-e-order').value === '410' &&
    byId('wb-e-prob').value === '40',
    `${byId('wb-e-keys2').value} / ${byId('wb-e-logic').value} / ${byId('wb-e-order').value} / ${byId('wb-e-prob').value}`);

  // --- 停用 + 状态筛选 ---
  setChecked('#wb-e-enabled', false);
  await sleep(150);
  const rowNow = $$('#wb-entry-list .wb-entry').find((r) => r.textContent.includes('字段往返'));
  check('停用之后行上带「停用」徽章', !!rowNow && rowNow.textContent.includes('停用'),
    rowNow ? rowNow.textContent.replace(/\s+/g, ' ') : '(找不到那一行)');

  setValue('#wb-state', 'disabled');
  await sleep(150);
  check('筛选「已停用」只剩它', $$('#wb-entry-list .wb-entry').length === 1,
    `${$$('#wb-entry-list .wb-entry').length} 行`);

  setValue('#wb-state', 'constant');
  await sleep(150);
  check('筛选「常驻条目」时一条都没有，并给出「没有匹配的条目」',
    $$('#wb-entry-list .wb-entry').length === 0 &&
    $('#wb-entry-list').textContent.includes('没有匹配的条目'),
    $('#wb-entry-list').textContent.trim());
  setValue('#wb-state', 'all');
  await sleep(150);

  // 停用是「这一条」的开关，和六个字段一样要走草稿 → 保存
  click('#btn-save-wb');
  await sleep(400);
  const disabledEntry = ((await loadBook()).entries || []).find((e) => e.title === '字段往返');
  check('停用状态落盘（enabled: false）', !!disabledEntry && disabledEntry.enabled === false,
    disabledEntry ? String(disabledEntry.enabled) : '(条目不见了)');

  // --- 预览命中：干净的草稿照跑，脏的草稿先拒绝 ---
  const t1 = $('#toast');
  t1.classList.add('hidden');
  t1.textContent = '';
  click('#btn-preview-wb');
  await sleep(400);
  check('草稿是干净的就能预览（不会被「先保存」挡住）',
    !!$('#toast').textContent.trim() && !$('#toast').textContent.includes('未保存的改动'),
    $('#toast').textContent);

  setValue('#wb-e-content', '字段往返用的正文（改了没保存）');
  await sleep(120);
  click('#btn-preview-wb');
  await sleep(400);
  check('草稿脏了就先拒绝预览、让人先保存',
    $('#toast').textContent.includes('未保存的改动'), $('#toast').textContent);

  // --- 「正文是空的」要被数进保存提示（以前只数「没关键词」那一种） ---
  click('#btn-new-entry');
  setValue('#wb-e-title', '空正文');
  setValue('#wb-e-keys', '空正文测试');
  await sleep(120);
  click('#btn-save-wb');
  await sleep(400);
  check('保存提示点名「正文是空的」',
    $('#toast').textContent.includes('正文是空的'), $('#toast').textContent);
  check('仍然报的是「已保存」（提示不拦保存）',
    $('#toast').textContent.includes('已保存'), $('#toast').textContent);

  // --- 收尾：把两条临时条目删掉，别留给后面的场景 ---
  for (const title of ['空正文', '字段往返']) {
    const target = $$('#wb-entry-list .wb-entry').find((r) => r.textContent.includes(title));
    if (target) click(target.querySelector('.wb-entry-del'));
    await sleep(120);
  }
  click('#btn-save-wb');
  await sleep(400);
  const cleaned = (await loadBook()).entries.map((e) => e.title);
  check('临时条目都删干净了，书回到原来的条目数',
    cleaned.length === before && !cleaned.includes('字段往返') && !cleaned.includes('空正文'),
    JSON.stringify(cleaned));

  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#view-wb-editor'));
});

// ---------------------------------------------------------------------------
//  场景：世界书扫描遇到 null 历史占位
//
//  导入 / 旧版本留下的历史里可能夹着 null（memory.js、suggestionsUi.js 早就加了
//  `m &&` 那一层）。世界书这条扫描路径以前没有，于是历史里只要有一个 null：
//   · 发消息直接失败（prepareCompletion 里世界书这步不降级，抛错就整轮没了）
//   · 右栏「命中 N 条」永远是空的
//   · 「预览命中」弹的是 `Cannot read properties of null (reading 'role')`
//  这里直接对着真模块喂一份带 null 的历史。
// ---------------------------------------------------------------------------
await scenario('世界书：历史里的 null 占位不炸扫描', async () => {
  const castMod = await import(new URL('js/data/cast.js', document.baseURI).href);
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);

  const convo = (stateMod.state.conversations || []).find((c) => c.id === stateMod.state.activeId);
  check('拿到当前会话', !!convo);
  if (!convo) return;

  const poisoned = {
    ...convo,
    messages: [null, { role: 'user', content: '翁法罗斯到底是个什么样的地方？' }, undefined,
      { role: 'assistant', content: '它有十二泰坦。' }, null]
  };

  const history = castMod.worldbookScanHistory(poisoned);
  check('扫描历史跳过 null / undefined 占位', history.length === 2, `拿到 ${history.length} 条`);

  let threw = null;
  try { await castMod.matchWorldbookSections(poisoned); } catch (err) { threw = err; }
  check('matchWorldbookSections 不会因为 null 历史抛错', !threw, threw && threw.message);

  let threw2 = null;
  try { await castMod.worldbookHitCount(poisoned); } catch (err) { threw2 = err; }
  check('worldbookHitCount 也不会抛错（右栏「命中 N 条」还有数）', !threw2, threw2 && threw2.message);
});

// ---------------------------------------------------------------------------
//  场景 11.5：AI 生成角色 —— 角色卡那一侧
//
//  假后端认「system 里有『你是一位角色设定师』」（见 tools/smoke-test.js）。
//  这里只验「点按钮 → 弹窗 → 生成 → 字段真的填进编辑器草稿 → 保存才落盘」这条链，
//  不验生成质量（那是提示词的事，测不了）。
// ---------------------------------------------------------------------------
await scenario('AI 生成角色：角色卡', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));

  const before = (await savedCharacters()).length;

  // 列表页确实多了一个入口，而且它不会顺手创建什么
  check('角色卡有「AI 生成」按钮', !!byId('btn-ai-char'));

  // 2026-10-16：这一页的三颗按钮换成了 <m-button>（组件库的第一批按钮用户，
  // 迁移试点的验收就落在这里）。断言的靶子是**宿主与里层对不对得上** ——
  // 按钮刚组件化时最容易静默失效的正是这一段：页面里到处是「建好之后再
  // 直接设属性」的写法（`btn.disabled = true`、`btn.textContent = '导入中…'`，
  // 见 characterImport.js 的 pickImportFiles），宿主上写坏了**不报错**，
  // 只是文案不变、禁用不生效 —— 正是本项目最怕的那类「不报错的错」。
  const importBtn = byId('btn-import-card');
  check('导入角色卡已经是 m-button 宿主', importBtn.tagName === 'M-BUTTON', importBtn.tagName);
  check(
    '外观类名落在宿主上',
    importBtn.classList.contains('mi-btn') &&
      importBtn.classList.contains('mi-btn--ghost') &&
      importBtn.classList.contains('mi-btn--sm'),
    importBtn.className
  );
  const importCtrl = importBtn.control;
  check('宿主里有一颗原生 button + label', importCtrl && importCtrl.tagName === 'BUTTON' && !!importCtrl.querySelector('.mi-btn__label'));
  importBtn.textContent = '导入中…';
  importBtn.disabled = true;
  check('改宿主 textContent 会落到里层文案', importCtrl.textContent === '导入中…', importCtrl.textContent);
  check('宿主 disabled 会落到里层', importCtrl.disabled === true);
  importBtn.textContent = '导入角色卡';
  importBtn.disabled = false;
  check('还原后里层一并还原', importCtrl.textContent === '导入角色卡' && importCtrl.disabled === false);

  // 2026-10-20：按钮自带 loading —— 转圈圈 + 期间不可点 + 告诉读屏器在忙。
  // 生成 / 导入 / 拉模型这些「等结果」的按钮都走这一套，这里钉组件本身的口径。
  importBtn.loading = true;
  const spinner = importCtrl.querySelector('.mi-btn__spinner');
  check('loading 会在文字前面插一颗转圈圈', !!spinner && importCtrl.firstElementChild === spinner);
  check('loading 期间里层不可点', importCtrl.disabled === true);
  check('loading 期间宿主 .disabled 也读成 true', importBtn.disabled === true);
  check('loading 会告诉读屏器在忙', importCtrl.getAttribute('aria-busy') === 'true');
  check('转圈圈不占按钮文字', importCtrl.textContent.trim() === '导入角色卡', importCtrl.textContent);
  importBtn.loading = false;
  check('收起 loading：转圈圈没了', !importCtrl.querySelector('.mi-btn__spinner'));
  check('收起 loading：又能点了', importCtrl.disabled === false && importCtrl.getAttribute('aria-busy') === null);
  check('收起 loading：宿主 .disabled 跟着回到 false', importBtn.disabled === false);
  check('「＋ 新建角色」是 primary 那一档', byId('btn-new-char').classList.contains('mi-btn--primary'));
  check('角色卡页不再有原生 .btn 按钮', !$('#view-chars .btn'));

  // ⚠️ 按钮组件化之后**发光的是里层**（底色 / 边框 / 圆角都在 `.mi-btn__control` 上）。
  // 卡片的动作行用 `flex: 1 1 0` 把两颗按钮平分两格 —— 里层若不跟着宿主撑满，
  // 按钮就只有「文字那么宽」：看着比槽位短一截，字还靠左，而且**不报错**。
  // 这条就是 2026-10-16 量出来那次（宿主 96 / 里层 50）的回归闸门。
  const cardRow = $('#char-page-grid .char-card .char-card-actions');
  check('角色卡页有卡片（动作行在）', !!cardRow);
  if (cardRow) {
    for (const node of cardRow.children) {
      const ctrl = node.control || node;
      const w = (n) => n.getBoundingClientRect().width;
      check(
        `卡片按钮「${node.textContent.trim()}」的里层撑满了宿主`,
        Math.abs(w(ctrl) - w(node)) <= 1,
        `宿主 ${Math.round(w(node))} / 里层 ${Math.round(w(ctrl))}`
      );
    }
  }

  // 自带世界书的卡多一条入口（封面左下角那颗），没绑书的不该有 ——
  // 它不走操作行：四颗按钮挤在 216px 里每颗只剩 43px，装不下两字标签。
  {
    const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
    const libMod = await import(new URL('js/data/library.js', document.baseURI).href);
    const liveBookIds = new Set(libMod.worldbooks().map((b) => b.id));
    const byName = new Map((stateMod.state.characters || []).map((c) => [String(c.name || '').trim(), c]));
    // 期望值自己算，不走 characterWorldbooks —— 拿被测函数当判据就等于没验
    const shouldHave = (name) => {
      const c = byName.get(name);
      if (!c) return false;
      return (Array.isArray(c.worldbookIds) ? c.worldbookIds : []).some((id) => liveBookIds.has(id));
    };

    const cards = $$('#char-page-grid .char-card');
    const names = cards.map((el) => (el.querySelector('.char-card-name') || {}).textContent || '');
    const wrong = cards.filter((el, i) => !!el.querySelector('.char-card-world') !== shouldHave(names[i].trim()));
    check(
      '「进入世界」只在绑了书的卡上出现',
      cards.length > 0 && wrong.length === 0,
      `${cards.length} 张卡，对不上：${wrong.map((el) => (el.querySelector('.char-card-name') || {}).textContent).join('、')}`
    );

    const withBook = cards.find((el) => el.querySelector('.char-card-world'));
    check('库里有绑了书的卡（不然这条入口没验到）', !!withBook, names.join(' / '));
    if (withBook) {
      check('「进入世界」压在封面里（封面的兄弟节点，不是套在封面按钮里）', !!withBook.querySelector('.wb-card-cover > .char-card-world'));

      const book = (byName.get(names[cards.indexOf(withBook)].trim()).worldbookIds || [])
        .map((id) => libMod.worldbookById(id))
        .find(Boolean);
      click(withBook.querySelector('.char-card-world'));
      await waitFor('「你是谁」弹窗打开（进世界）', () => shown('#player-modal'));
      check(
        '进世界的弹窗标题用的是书名',
        !!book && byId('player-title').textContent.includes(book.name),
        `${byId('player-title').textContent} / 期望含 ${book && book.name}`
      );
      check('确认按钮是「开始游玩」', byId('btn-start-play').textContent.trim() === '开始游玩', byId('btn-start-play').textContent);
      click('#btn-close-player');
      await waitFor('关掉「你是谁」弹窗', () => !shown('#player-modal'));
    }
  }

  click('#btn-ai-char');
  await waitFor('生成弹窗打开', () => shown('.ai-gen-modal'));
  // 角色卡这条路姓「角色」，不是「NPC」—— 两者提示词完全不同
  check('弹窗是角色卡那一版', $('.ai-gen-modal').textContent.includes('AI 生成角色'), $('.ai-gen-modal').textContent.slice(0, 40));

  const prompt = $('#ai-gen-prompt');
  check('弹窗里有描述输入框', !!prompt);
  setValue('#ai-gen-prompt', '一个话很少的守夜人');

  // 「开始生成」那颗加载态的靶子（点下去文字就变了，先抓住宿主）
  const goBtn = $$('.ai-gen-modal m-button').find((b) => b.textContent.trim() === '开始生成');
  check('生成按钮是 m-button', !!goBtn);
  click(buttonByText($('.ai-gen-modal'), '开始生成'));

  // 点下去那一瞬间就该是「生成中… + 转圈圈」，不用等模型回来 —— 这一段是同步做完的
  check('生成中：按钮文字变成「生成中…」', !!goBtn && goBtn.textContent === '生成中…', goBtn && goBtn.textContent);
  check(
    '生成中：按钮在转圈圈',
    !!goBtn && !!goBtn.control && !!goBtn.control.querySelector('.mi-btn__spinner'),
    goBtn && goBtn.control && goBtn.control.className
  );
  check('生成中：按钮点不动', !!goBtn && goBtn.control && goBtn.control.disabled === true);

  // 生成完直接把字段填进角色编辑器草稿
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  // 解析失败时也会开草稿（把原文塞进描述），光看「有没有开」分不出成功和兜底 ——
  // 所以再看一眼描述框：兜底那份的标题一定是「未命名角色」。
  check('生成后打开的是新建草稿', byId('chars-title').textContent === '新建角色', byId('chars-title').textContent);
  check(
    '走的是正常解析，不是「解析失败」兜底',
    byId('c-desc').value.length > 0 && byId('c-name').value !== '未命名角色',
    `name=${byId('c-name').value} / desc=${byId('c-desc').value.slice(0, 30)}`
  );
  check('名字已回填', byId('c-name').value === '守夜人', byId('c-name').value);
  check('描述已回填', byId('c-desc').value.includes('深夜值班'), byId('c-desc').value);
  check('标签已回填', byId('c-tags').value.includes('测试'), byId('c-tags').value);
  check('属性已回填', $('#c-attr-list') && $('#c-attr-list').textContent.includes('好感度'), $('#c-attr-list') && $('#c-attr-list').textContent);

  // 最要紧的一条：**这一步还不该落盘** —— 和「新建角色」一样，点保存才算数
  await sleep(150);
  check('生成后还没落盘（要用户点保存才创建）', (await savedCharacters()).length === before, `期望 ${before}，实际 ${(await savedCharacters()).length}`);

  click('#btn-save-char');
  await waitFor('落盘完成', async () => (await savedCharacters()).length === before + 1);
  const saved = (await savedCharacters())[before] || {};
  check('保存后角色进了角色卡', saved.name === '守夜人', saved.name);
  check('落盘的属性也跟着进来了', (saved.attributes || []).length === 2, JSON.stringify(saved.attributes));
  // ⚠️ 这两条断言故意盯着**归一化之后的形状**，不是模型给的原样：
  //   · 数值字段落盘是 meter（没有 number 这个类型）
  //   · dynamic 是默认频率，存储时那个键会被省掉（见 main/panel-fields.js）
  const attrs = saved.attributes || [];
  check('数值属性落成了 meter', attrs.some((a) => a.name === '好感度' && a.type === 'meter'), JSON.stringify(attrs));
  check('默认频率（dynamic）不写多余的键', attrs.some((a) => a.name === '好感度' && a.mode === undefined), JSON.stringify(attrs));
});

// ---------------------------------------------------------------------------
//  场景 11.55：AI 生成角色 —— 角色卡那侧的「背景 / 基调」（可选）
//
//  只有角色卡那侧有这个框（世界书自带条目 + 开场白当大纲）。
//  验两件事：① 世界书那侧不该冒出这个框；② 填了之后那段真的进了 system。
//  第 ② 条靠假后端认「【背景 / 基调】」返回不同的名字（见 tools/smoke-test.js）。
// ---------------------------------------------------------------------------
await scenario('AI 生成角色：背景/基调框', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));

  click('#btn-ai-char');
  await waitFor('生成弹窗打开', () => shown('.ai-gen-modal'));
  check('角色卡那侧有「背景 / 基调」框', !!byId('ai-gen-brief'));

  setValue('#ai-gen-prompt', '一个值夜班的店员');
  const brief = '现代都市的深夜便利店，安静、有点孤独。'.repeat(80) + '【末尾约束：店员必须记得离别时的承诺】';
  check('回归背景超过旧的 1000 字上限', brief.length > 1000);
  setValue('#ai-gen-brief', brief);
  click(buttonByText($('.ai-gen-modal'), '开始生成'));

  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  // 名字跟着「有没有基调」变 —— 还是「守夜人」就说明那段没拼进 system
  check('背景/基调确实拼进了提示词', byId('c-name').value === '便利店店员', byId('c-name').value);
  const { entries } = await window.mimitale.requestLog();
  const sent = entries.find((entry) => entry.body.messages.some((msg) =>
    msg.role === 'system' && msg.content.includes('【背景 / 基调】')));
  check('背景超过 1000 字仍完整发送，末尾约束不丢失',
    !!sent && sent.body.messages.some((msg) => msg.role === 'system' && msg.content.includes(brief)));

  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#view-char-editor'));
});

// ---------------------------------------------------------------------------
//  场景 11.6：AI 生成角色 —— 模型返回的不是干净 JSON
//
//  真模型经常多写一句「好的，我按你说的写了一个」、再把 JSON 包进 ```json 围栏。
//  这条验的是兜底：必须剥掉围栏、切出花括号块，正常生成出角色，而不是报错。
// ---------------------------------------------------------------------------
await scenario('AI 生成角色：模型输出带围栏和废话', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));

  click('#btn-ai-char');
  await waitFor('生成弹窗打开', () => shown('.ai-gen-modal'));
  setValue('#ai-gen-prompt', '冒烟：烂JSON');
  click(buttonByText($('.ai-gen-modal'), '开始生成'));

  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  check('带围栏的输出也能解析出角色', byId('c-name').value === '油烟贩子', byId('c-name').value);
  check('描述里没有残留的围栏标记', !byId('c-desc').value.includes('```'), byId('c-desc').value);

  // 这份草稿不要了 —— 关掉时弹的确认框要按「放弃」走
  click('#btn-close-chars');
  await waitFor('弹出放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#view-char-editor'));
});

// ---------------------------------------------------------------------------
//  场景 11.65：「AI 补设定」—— 角色编辑器里给一张卡现补一本世界书
//
//  假后端认「世界书编辑」+ "entries"（见 tools/smoke-test.js），回 4 条，其中一条
//  **既非常驻、又没有关键词** —— 它永远注入不到，必须被丢掉。
//  验：① 生成完只是草稿，不建书；② 点保存才建书、绑到这张卡；③ 保存后清单清空。
// ---------------------------------------------------------------------------
await scenario('AI 补设定：保存才建书', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));

  // 上一场生成并保存下来的「守夜人」：描述和性格都有，够 AI 读
  const card = $$('#char-page-grid .char-card').find((node) => node.textContent.includes('守夜人'));
  check('角色卡里有上一场存的「守夜人」', !!card);
  click(buttonByText(card, '编辑'));
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  check('编辑器里有「AI 补设定」按钮', !!byId('c-wb-ai-btn'));
  check(
    '角色卡上标着 library 作用域',
    !!byId('c-wb-ai-block') && byId('c-wb-ai-block').dataset.scope === 'library',
    byId('c-wb-ai-block') && byId('c-wb-ai-block').dataset.scope
  );

  const booksBefore = (await savedWorldbooks()).length;
  click('#c-wb-ai-btn');
  // 这颗按钮在生成时变「中止」（还能点），所以转圈圈落在状态行上
  check('补设定：生成中状态行在转圈圈', !!$('#c-wb-ai-status .spinner'));
  await waitFor('条目出现', () => $$('#c-wb-ai-list .cwb-ai-entry').length > 0);
  check('补设定：出结果后转圈圈收掉了', !$('#c-wb-ai-status .spinner'));

  const rows = $$('#c-wb-ai-list .cwb-ai-entry');
  const rowText = rows.map((r) => r.textContent).join(' / ');
  // 假后端给了 4 条，去掉那条没关键词的，应该刚好 3 条
  check('既非常驻又没关键词的那条被丢掉', rows.length === 3, `${rows.length} 条：${rowText}`);
  check('常驻条目标着「常驻」', rows.some((r) => r.textContent.includes('常驻')), rowText);
  check('非常驻条目显示关键词', rows.some((r) => r.textContent.includes('换班')), rowText);
  check('状态行说明「保存才建书」', byId('c-wb-ai-status').textContent.includes('保存'), byId('c-wb-ai-status').textContent);
  check('这次还不会有新书落盘', (await savedWorldbooks()).length === booksBefore, `${(await savedWorldbooks()).length} / ${booksBefore}`);

  // 就地改正文：点「改」展开一条，改完收起 —— 落盘的应该是改过的文字
  const firstRow = $$('#c-wb-ai-list .cwb-ai-entry')[0];
  click(firstRow.querySelector('.cwb-ai-edit-btn'));
  await waitFor('正文框展开', () => !!$('#c-wb-ai-list .cwb-ai-content'));
  const area = $('#c-wb-ai-list .cwb-ai-content');
  check('展开的是第 1 条的正文', String(area.value).includes('换班'), area.value);
  setValue('#c-wb-ai-list .cwb-ai-content', '改过的正文：换班要当面交接，缺一样都算事故。');
  check('打字不会把框重画掉', $$('#c-wb-ai-list .cwb-ai-content').length === 1);
  click($$('#c-wb-ai-list .cwb-ai-entry')[0].querySelector('.cwb-ai-edit-btn'));
  await sleep(80);
  check('再点一下收起', !$('#c-wb-ai-list .cwb-ai-content'));

  click('#btn-save-char');
  await waitFor('新书落盘', async () => (await savedWorldbooks()).length === booksBefore + 1);

  const books = await savedWorldbooks();
  const book = books.find((b) => b.name === '守夜人的世界书');
  check('建出来的书叫「守夜人的世界书」', !!book, books.map((b) => b.name).join(' / '));

  const entries = (book && book.entries) || [];
  check('书里有 3 条设定', entries.length === 3, String(entries.length));
  check('就地改的正文进了书', entries.some((e) => String(e.content).includes('改过的正文')), JSON.stringify(entries.map((e) => String(e.content).slice(0, 10))));
  check('那条没关键词的没进书', !entries.some((e) => e.title === '用不上的那条'), entries.map((e) => e.title).join(' / '));
  check('关键词按数组存下来了', entries.some((e) => (e.keys || []).includes('换班')), JSON.stringify(entries.map((e) => e.keys)));
  check('常驻那条落成了 constant', entries.filter((e) => e.constant).length === 1, JSON.stringify(entries.map((e) => [e.title, e.constant])));

  const savedChar = (await savedCharacters()).find((c) => c.name === '守夜人');
  check(
    '新建的书绑到了这张卡上',
    !!book && !!savedChar && (savedChar.worldbookIds || []).includes(book.id),
    JSON.stringify(savedChar && savedChar.worldbookIds)
  );
  check('编辑器里那块也列出了这本书', $('#c-wb-list').textContent.includes('守夜人的世界书'), $('#c-wb-list').textContent);
  check('保存之后草稿清单清空了', $$('#c-wb-ai-list .cwb-ai-entry').length === 0, String($$('#c-wb-ai-list .cwb-ai-entry').length));

  click('#btn-close-chars');
  await sleep(150);
  check('保存后关闭不弹放弃确认', !shown('#confirm-modal'));
  await waitFor('编辑器关闭', () => !shown('#view-char-editor'));
});

// ---------------------------------------------------------------------------
//  场景 11.66：「AI 补充」—— 先确认，再把五栏写回表单，点保存才进卡
//
//  假后端认「角色卡编辑」+ "mesExample"（见 tools/smoke-test.js），回五栏文字，
//  **故意不带 name**：这条任务只改那五栏，模型顺手给个新名字也不能把卡名改掉。
//  验四件：① 点错预防（先弹确认，取消就什么都不发生）；② 等的时候按钮在转圈圈
//  且点不动；③ 五栏回填、名字/标签没动、保存胶囊变脏；④ 点了保存才落盘。
// ---------------------------------------------------------------------------
await scenario('AI 补充：确认后重写五栏', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));

  // 上一场生成并保存下来的「守夜人」：五栏里描述和性格都有，够 AI 读
  const card = $$('#char-page-grid .char-card').find((node) => node.textContent.includes('守夜人'));
  check('角色卡里有上一场存的「守夜人」', !!card);
  click(buttonByText(card, '编辑'));
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const btn = byId('btn-ai-fill-char');
  check('左栏底部有「AI 补充」按钮', !!btn && String(btn.textContent).includes('AI 补充'), btn && btn.textContent);

  const nameBefore = byId('c-name').value;
  const tagsBefore = byId('c-tags').value;
  const descBefore = byId('c-desc').value;

  // ① 点错预防：先弹确认
  click('#btn-ai-fill-char');
  await waitFor('点「AI 补充」先弹确认', () => shown('#confirm-modal'));
  const confirmText = byId('confirm-message').textContent;
  check('确认框说清会覆盖哪几栏 + 保存才生效', /五栏/.test(confirmText) && confirmText.includes('保存'), confirmText);
  click('#confirm-cancel');
  await waitFor('取消后确认框收起', () => !shown('#confirm-modal'));
  await sleep(120);
  check('取消之后按钮没进 loading', !byId('btn-ai-fill-char').loading);
  check('取消之后描述一个字都没变', byId('c-desc').value === descBefore);

  // ② 真要跑：等的时候按钮转圈圈 + 不可点
  click('#btn-ai-fill-char');
  await waitFor('再次弹确认', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('按钮进入 loading', () => byId('btn-ai-fill-char').loading);
  check('loading 时有转圈圈', !!$('#btn-ai-fill-char .mi-btn__spinner'));
  check('loading 期间按钮点不动', byId('btn-ai-fill-char').disabled === true);
  check('loading 文案是「补充中…」', String(byId('btn-ai-fill-char').textContent).includes('补充中'), byId('btn-ai-fill-char').textContent);

  // ③ 五栏回填
  await waitFor('五栏都填上了', () => byId('c-desc').value.includes('AI补充后的描述'));
  check('描述换了', byId('c-desc').value.includes('AI补充后的描述'), byId('c-desc').value.slice(0, 24));
  check('性格换了', byId('c-personality').value.includes('AI补充后的性格'), byId('c-personality').value.slice(0, 24));
  check('场景换了', byId('c-scenario').value.includes('AI补充后的场景'), byId('c-scenario').value.slice(0, 24));
  check('开场白换了', byId('c-first').value.includes('AI补充后的开场白'), byId('c-first').value.slice(0, 24));
  check('示例对话换了', byId('c-example').value.includes('<START>'), byId('c-example').value.slice(0, 24));
  check('名字没被改（模型给了新名字也不能动）', byId('c-name').value === nameBefore, `${byId('c-name').value} / ${nameBefore}`);
  check('标签没被改', byId('c-tags').value === tagsBefore);
  check('出结果后按钮恢复原样', !byId('btn-ai-fill-char').loading && String(byId('btn-ai-fill-char').textContent).includes('AI 补充'));
  check('表单标成「有未保存的改动」', byId('char-save-state').dataset.state === 'dirty', byId('char-save-state').dataset.state);

  // ④ 这时候还只是表单里改过，磁盘上得还是老描述
  const beforeSave = (await savedCharacters()).find((c) => c.name === '守夜人');
  check('保存前磁盘上还是老描述', !!beforeSave && beforeSave.description === descBefore, beforeSave && beforeSave.description.slice(0, 20));

  click('#btn-save-char');
  await waitFor('保存落盘', async () => {
    const saved = (await savedCharacters()).find((c) => c.name === '守夜人');
    return !!saved && String(saved.description).includes('AI补充后的描述');
  });
  const afterSave = (await savedCharacters()).find((c) => c.name === '守夜人');
  check(
    '点保存之后新描述才进卡',
    !!afterSave && String(afterSave.description).includes('AI补充后的描述'),
    afterSave && String(afterSave.description).slice(0, 20)
  );

  click('#btn-close-chars');
  await waitFor('编辑器关闭', () => !shown('#view-char-editor'));
  check('保存后关闭不弹放弃确认', !shown('#confirm-modal'));
});

//
// ---------------------------------------------------------------------------
//  场景 11.7：AI 生成 NPC —— 世界书那一侧
//
//  和角色卡那条路共用弹窗和草稿，但上下文完全不同：它要带这本书的条目和副本名单。
//  假后端据 system 里有没有「【世界：」分辨走的是不是 NPC 那条路，返回的角色名
//  也因此不同（见 tools/smoke-test.js）—— 落盘的名字对不上就说明没带上下文。
// ---------------------------------------------------------------------------
await scenario('AI 生成 NPC：依据世界书', async () => {
  await openWorldbookEditor('冒烟测试世界');

  check('世界书里有「AI 生成」按钮', !!byId('btn-ai-wb-char'));

  const before = ((await savedWorldbooks())[0].characters || []).length;

  click('#btn-ai-wb-char');
  await waitFor('生成弹窗打开', () => shown('.ai-gen-modal'));
  check('弹窗是 NPC 那一版', $('.ai-gen-modal').textContent.includes('AI 生成 NPC'), $('.ai-gen-modal').textContent.slice(0, 40));
  check('状态行说明了依据哪本书', $('.ai-gen-status').textContent.includes('冒烟测试世界'), $('.ai-gen-status').textContent);
  // 世界书那侧不该有「背景 / 基调」框 —— 它本身就有大纲（条目 + 开场白）
  check('世界书那侧没有「背景 / 基调」框', !byId('ai-gen-brief'));

  setValue('#ai-gen-prompt', '酒馆后厨的帮工');
  click(buttonByText($('.ai-gen-modal'), '开始生成'));

  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  check('标题是「新建本书角色」', byId('chars-title').textContent === '新建本书角色', byId('chars-title').textContent);
  // 副本这条路上「AI 补设定」补的是**这本书**的条目（副本自带的书进世界时不被注入）
  check(
    '副本上的「AI 补设定」标着 worldbook 作用域',
    !!byId('c-wb-ai-block') && byId('c-wb-ai-block').dataset.scope === 'worldbook',
    byId('c-wb-ai-block') && `class=${byId('c-wb-ai-block').className} scope=${byId('c-wb-ai-block').dataset.scope}`
  );
  check(
    '副本上说明写进这本书',
    byId('c-wb-ai-status').textContent.includes('这本书'),
    byId('c-wb-ai-status').textContent
  );
  // 名字来自假后端的「带世界上下文」分支 —— 对不上就说明 system 里没带上这本书的设定
  check('生成时确实带上了这本书的上下文', byId('c-name').value === '后厨帮工', byId('c-name').value);

  await sleep(150);
  check('生成后副本还没落盘', ((await savedWorldbooks())[0].characters || []).length === before, String(((await savedWorldbooks())[0].characters || []).length));

  click('#btn-save-char');
  await waitFor('副本 chip 出现', () => $('#wb-char-list').textContent.includes('后厨帮工'));
  check('副本已落进这本书', ((await savedWorldbooks())[0].characters || []).length === before + 1, String(((await savedWorldbooks())[0].characters || []).length));

  click('#btn-close-chars');
  await sleep(120);
  check('副本保存后关闭不弹确认框', !shown('#confirm-modal'));

  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#view-wb-editor'));
});

// ---------------------------------------------------------------------------
//  场景 11.75：「AI 补设定」在副本上 —— 补进那本书的草稿
//
//  副本进世界时注入的是**那本书**（data/cast.js 的 effectiveWorldbookIds），
//  所以这里的条目既不建新书、也不直接写 book.entries（世界书编辑器可能正压着一份脏草稿，
//  之后一保存就把它整体覆盖掉）。正确落点是那本书的**草稿**：
//  回世界书编辑器能看见，点「保存」才进磁盘。这条验的就是这三步。
// ---------------------------------------------------------------------------
await scenario('AI 补设定：副本并进这本书的草稿', async () => {
  await openWorldbookEditor('冒烟测试世界');

  const bookBefore = (await savedWorldbooks()).find((b) => b.name === '冒烟测试世界');
  check('磁盘上有那本测试书', !!bookBefore);
  const entriesOnDisk = ((bookBefore && bookBefore.entries) || []).length;
  const listedBefore = $$('#wb-entry-list .wb-entry').length;

  const npc = $$('#wb-char-list .wb-char-card').find((c) => c.textContent.includes('后厨帮工'));
  check('本书角色里有「后厨帮工」', !!npc);
  click(buttonByText(npc, '编辑'));
  await waitFor('副本编辑器打开', () => shown('#view-char-editor'));
  check('编辑的是本书副本', byId('chars-title').textContent === '编辑本书角色', byId('chars-title').textContent);

  click('#c-wb-ai-btn');
  await waitFor('副本上也补出了条目', () => $$('#c-wb-ai-list .cwb-ai-entry').length > 0);
  check(
    '补出 3 条（死条目那条被丢掉）',
    $$('#c-wb-ai-list .cwb-ai-entry').length === 3,
    String($$('#c-wb-ai-list .cwb-ai-entry').length)
  );
  check(
    '状态行说明会并进这本书',
    byId('c-wb-ai-status').textContent.includes('并进'),
    byId('c-wb-ai-status').textContent
  );

  click('#btn-save-char');
  // 保存完草稿就交给那本书了：清单清空即说明 materialize 走完了
  await waitFor('副本保存完', () => $$('#c-wb-ai-list .cwb-ai-entry').length === 0, 8000);
  await sleep(250);

  // 世界书编辑器还在后台：左栏条目列表应该已经多出这 3 条（appendEntriesToBookDraft 里刷的）
  check(
    '那本书的左栏条目列表跟着长了 3 条',
    $$('#wb-entry-list .wb-entry').length === listedBefore + 3,
    `${$$('#wb-entry-list .wb-entry').length} / ${listedBefore + 3}`
  );
  // 但还没落盘 —— 保存副本不会顺手把整本书写进磁盘
  check(
    '磁盘上的条目数没变（只是草稿）',
    (((await savedWorldbooks()).find((b) => b.name === '冒烟测试世界') || {}).entries || []).length === entriesOnDisk,
    String((((await savedWorldbooks()).find((b) => b.name === '冒烟测试世界') || {}).entries || []).length)
  );

  click('#btn-close-chars');
  await waitFor('回到世界书编辑器', () => shown('#view-wb-editor'));
  check(
    '页头保存胶囊提示「有未保存的改动」',
    byId('wb-save-state').dataset.state === 'dirty',
    byId('wb-save-state').textContent
  );

  click('#btn-save-wb');
  await waitFor('这本书真的落盘', async () => {
    const book = (await savedWorldbooks()).find((b) => b.name === '冒烟测试世界');
    return !!book && (book.entries || []).length === entriesOnDisk + 3;
  });

  const savedBook = (await savedWorldbooks()).find((b) => b.name === '冒烟测试世界');
  const titles = (savedBook.entries || []).map((e) => e.title);
  check('补出来的三条进了这本书', ['夜班规矩', '街口那盏灯', '这座城的作派'].every((t) => titles.includes(t)), JSON.stringify(titles));
  const savedNpc = ((savedBook && savedBook.characters) || []).find((c) => c.name === '后厨帮工');
  check('副本没被绑上一本新书', !savedNpc || !(savedNpc.worldbookIds || []).length, JSON.stringify(savedNpc && savedNpc.worldbookIds));

  click('#btn-close-worldbooks');
  await sleep(150);
  if (shown('#confirm-modal')) click('#confirm-ok');
  await waitFor('世界书编辑器关闭', () => !shown('#view-wb-editor'));
});

// ---------------------------------------------------------------------------
//  场景 12：进入世界 —— 玩家角色弹窗
// ---------------------------------------------------------------------------
await scenario('进入世界：用角色卡当自己', async () => {
  // 书不再有列表页，「游玩」只剩角色卡封面那颗「进入世界」
  await createCharBoundTo('冒烟测试世界', '进世界的角色');
  const worldCard = $$('#char-page-grid .char-card').find((c) => c.textContent.includes('进世界的角色'));
  check('绑了书的角色卡上有「进入世界」', !!worldCard && !!worldCard.querySelector('.char-card-world'));
  click(worldCard.querySelector('.char-card-world'));
  await waitFor('玩家角色弹窗打开', () => shown('#player-modal'));
  check('弹窗里有角色名输入框', !!byId('player-name'));

  // 角色卡里有「属性测试角色」（带金币/上衣两个属性）
  const options = $$('#player-char option').map((o) => o.textContent);
  check('下拉里有「自己写一个」和角色卡的人', options.includes('（自己写一个）') && options.includes('属性测试角色'), JSON.stringify(options));

  // --- 选一张角色卡：名字和设定应该自动填进去 ---
  const cardId = $$('#player-char option').find((o) => o.textContent === '属性测试角色').value;
  setValue('#player-char', cardId).dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(80);

  check('名字被自动填上了', byId('player-name').value === '属性测试角色', byId('player-name').value);
  check('设定也带过来了', byId('player-profile').value.length > 0, `${byId('player-profile').value.length} 字`);
  check('预览说明了会带上哪些属性', shown('#player-char-preview') && byId('player-char-preview').textContent.includes('金币'), byId('player-char-preview').textContent);

  // 填完还能改 —— 改了以你改的为准
  setValue('#player-name', '改过的名字');
  check('选了之后名字仍然可改', byId('player-name').value === '改过的名字');

  // --- 开始游玩：你自己的状态挪进「我的状态」卡，入口条只留人 ---
  click('#btn-start-play');
  await waitFor('进入世界', () => shown('#view-chat') && !shown('#player-modal'));
  await waitFor('状态卡入口条出现', () => shown('#panel-box'));

  // 旧面板的**字段列表**已经不在了 —— 玩家自己的属性只在「我的状态」卡里。
  // 标题是「在场角色 N」（见上面那条断言）。
  check(
    '旧的「当前状态」字段区已经不在了',
    !byId('panel-fields') && !byId('btn-panel-collapse') && !!byId('panel-box').closest('#cast-panel')
  );

  // 顶栏头像（2026-09-30）：世界书会话**没绑角色卡**（主角在 convo.player 里），
  // 所以走的是「方角 + 书名首字」那条分支 —— 形状本身就是分类，一眼区分
  // 「跟角色聊」和「在书里玩」。只绑角色的圆头像在场景 15 里验过。
  {
    const av = byId('topbar-avatar');
    check(
      '世界书会话的顶栏头像是方角的「书」',
      !!av && av.classList.contains('book'),
      av ? av.className : 'no-node'
    );
    check(
      '世界书使用线性翻页图标',
      !!av && !!av.querySelector('svg'),
      av ? av.textContent : ''
    );
  }

  const myAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner === 'player');
  check('入口条上有「我」的头像', !!myAvatar);
  click(myAvatar);
  await waitFor('我的状态卡出现', () => !!$('#state-cards .state-card[data-owner="player"]'));

  const cardNames = $$('#state-cards .state-card[data-owner="player"] .sc-name').map((n) => n.textContent);
  const cardValue = (field) => {
    const row = $$('#state-cards .state-card[data-owner="player"] .sc-row').find(
      (r) => r.querySelector('.sc-name').textContent === field
    );
    return row ? row.querySelector('.sc-value').textContent : null;
  };

  check('「我的状态」卡里有用角色卡种下的属性', cardNames.includes('金币') && cardNames.includes('上衣'), JSON.stringify(cardNames));
  check('姓名用的是你改过的名字', cardValue('姓名') === '改过的名字', String(cardValue('姓名')));
  check('值来自角色卡的初始值', cardValue('金币') === '100', String(cardValue('金币')));

  // 收掉这张卡，别影响后面的场景
  const closeMyCard = $('#state-cards .state-card[data-owner="player"] .sc-close');
  if (closeMyCard) click(closeMyCard);

  // 会话里记下了「你用哪张卡当自己」，而且以你改过的名字为准
  await sleep(200); // persistConversations 是防抖的
  const convos = (await window.mimitale.getConversations()).conversations;
  const worldConvo = convos.find((c) => c.title === '冒烟测试世界');
  check('会话里记下了玩家角色', !!worldConvo && !!worldConvo.player, JSON.stringify(worldConvo && worldConvo.player));
  check('用的是你改过的名字', !!worldConvo && worldConvo.player.name === '改过的名字', worldConvo ? worldConvo.player.name : '');
  check('也记下了是哪张角色卡', !!worldConvo && worldConvo.player.characterId === cardId, worldConvo ? String(worldConvo.player.characterId) : '');
  check('玩家角色带上了设定文本', !!worldConvo && String(worldConvo.player.profile).length > 0);

  // 剧情选项：这张卡没在编辑器里配过 ── 按新默认应该是「开、每轮 4 条」。
  // 以前这里落的是 null，所以「世界书里自己写的主角 / 没配过的卡」全程没有选项。
  check(
    '进世界的会话也默认带上剧情选项（每轮 4 条）',
    !!worldConvo && !!worldConvo.optionsSpec && worldConvo.optionsSpec.count === 4,
    JSON.stringify(worldConvo && worldConvo.optionsSpec)
  );

  // 发一条：让「身份 + 属性真的注入给了模型」这件事也能被宿主验到
  setValue('#input', '冒烟测试：世界里的状态');
  click('#btn-send');
  await waitFor('收到回复', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);
});

notes.push(`磁盘上的角色数：${(await savedCharacters()).length}`);
notes.push(`磁盘上的世界书数：${(await savedWorldbooks()).length}`);
notes.push(`会话数：${$$('#convo-list .convo-item').length}`);

// ---------------------------------------------------------------------------
//  场景 13：角色卡 —— 每个字段都能原样存下来
//
//  主进程的 normalizeCharacter 是白名单式的，只保留显式列出的字段，漏一个就
//  静默丢掉。这里把每个可编辑字段都填上不同值，再逐个核对回来没有。
// ---------------------------------------------------------------------------
await scenario('角色卡：字段往返不丢', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const NAME = '字段往返测试';
  setValue('#c-name', NAME);
  setValue('#c-tags', '甲, 乙');
  // 年龄/性别/种族已整体移除（写进描述即可），编辑器里没有对应输入框。
  setValue('#c-desc', 'D-描述');
  setValue('#c-personality', 'P-性格');
  setValue('#c-scenario', 'S-场景');
  setValue('#c-first', 'F-开场白');
  setValue('#c-example', 'E-示例');
  setValue('#c-system', 'SP-系统提示');
  setValue('#c-post', 'PH-后指令');
  setValue('#c-notes', 'CN-备注');

  setValue('#c-attr-new', '金币');
  click('#btn-add-attr');
  await waitFor('属性行出现', () => $$('#c-attr-list .attr-row').length === 1);
  setValue($$('#c-attr-list .attr-row')[0].querySelector('.attr-value'), '777');

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);

  const expect = {
    tags: ['甲', '乙'],
    description: 'D-描述',
    personality: 'P-性格',
    scenario: 'S-场景',
    firstMes: 'F-开场白',
    mesExample: 'E-示例',
    systemPrompt: 'SP-系统提示',
    postHistoryInstructions: 'PH-后指令',
    creatorNotes: 'CN-备注'
  };
  for (const [key, want] of Object.entries(expect)) {
    const got = saved ? saved[key] : undefined;
    check(`字段 ${key} 没被丢掉`, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }
  check(
    '属性没被丢掉',
    !!saved && Array.isArray(saved.attributes) && saved.attributes.length === 1 && saved.attributes[0].value === '777',
    JSON.stringify(saved && saved.attributes)
  );
});

// ---------------------------------------------------------------------------
//  场景：角色头像 / 形象 —— 两张图各管一处
//    头像（1:1）→ 消息气泡、状态卡；形象（2:3）→ 角色卡列表，点开看大图。
//    上传走**真裁剪组件**（不是往框里直接塞图）：images:pick 的桩给一张
//    1×1 PNG，裁剪浮层照常弹、照常按目标比例输出。
// ---------------------------------------------------------------------------
await scenario('角色：头像和形象是两张图', async () => {
  const isImg = (v) => typeof v === 'string' && v.startsWith('data:image/');

  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const NAME = '双图测试角色';
  setValue('#c-name', NAME);

  // --- 两个上传框各就各位 ---
  check('编辑器里有两个上传框（头像 / 形象）', !!byId('char-avatar') && !!byId('char-portrait'));
  check(
    '两个框一开始都是「点击上传」',
    !!byId('char-avatar').querySelector('.char-avatar-empty') &&
      !!byId('char-portrait').querySelector('.char-avatar-empty')
  );

  // --- 头像 / 形象 挪到了表单最顶上，和角色名同级（不再有折叠的「图片」块）---
  check(
    '头像 / 形象 保留在角色资料栏',
    !!$('.char-media-top') && $('.char-identity-pane').contains($('.char-media-top'))
  );
  check('没有可折叠的「图片」块了', !$('.char-media-section'));

  // --- 传头像：点框 → 弹裁剪 → 「用这块」 ---
  click('#char-avatar');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  check('裁剪标题是「裁剪头像」', byId('crop-layer').textContent.includes('裁剪头像'));
  click('#crop-ok');
  // dataURL 的解码是异步的，等到尺寸出来再断言，别读到 0
  await waitFor('头像按 384 落进框里', () => {
    const i = byId('char-avatar').querySelector('img');
    return !!i && i.naturalWidth === 384;
  });

  const avImg = byId('char-avatar').querySelector('img');
  check(
    '头像按 1:1 裁（384×384）',
    !!avImg && avImg.naturalWidth === 384 && avImg.naturalHeight === 384,
    avImg ? `${avImg.naturalWidth}×${avImg.naturalHeight}` : '框里没图'
  );

  // 这张卡只有一张图 —— 形象那一栏先沿用头像，并标出「沿用」
  check(
    '还没单独设形象时，形象框先沿用头像并标记',
    !!byId('char-portrait').querySelector('img') && byId('char-portrait').classList.contains('is-inherited')
  );

  // --- 传形象 ---
  click('#char-portrait');
  await waitFor('裁剪浮层又弹出来了', () => !!byId('crop-layer'));
  check('裁剪标题是「裁剪角色形象」', byId('crop-layer').textContent.includes('裁剪角色形象'));
  click('#crop-ok');
  // 光等「框里有 img」不够 —— 还没单独设形象时，框里本来就沿用着头像那张。
  // 等到尺寸变成 1024 才说明新裁的那张真的换上了。
  await waitFor('形象换成新裁的那张', () => {
    const i = byId('char-portrait').querySelector('img');
    return !!i && i.naturalWidth === 1024;
  });
  check('设过形象之后不再标「沿用头像」', !byId('char-portrait').classList.contains('is-inherited'));

  const ptImg = byId('char-portrait').querySelector('img');
  check(
    '形象按 2:3 裁（1024×1536）',
    !!ptImg && ptImg.naturalWidth === 1024 && ptImg.naturalHeight === 1536,
    `实际 ${ptImg && ptImg.naturalWidth}×${ptImg && ptImg.naturalHeight} / 视口 ${window.innerWidth}×${window.innerHeight} / dpr ${window.devicePixelRatio}`
  );

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(200);

  // --- 落盘：两张图是两个字段，都要留下 ---
  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  check('头像存进 avatar', isImg(saved && saved.avatar), String(saved && saved.avatar).slice(0, 24));
  check('形象存进 portrait（另一个字段）', isImg(saved && saved.portrait), String(saved && saved.portrait).slice(0, 24));
  check('两张图不是同一份', !!saved && saved.avatar !== saved.portrait);

  // --- 列表上铺的是形象，点它能看大图 ---
  const card = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('列表里能找到这张卡', !!card);

  const media = card && card.querySelector('.char-card-avatar');
  check('列表卡上铺的是形象图', !!media && !!media.querySelector('img'));
  check('列表卡上的形象能点（包在按钮里）', !!media && media.tagName === 'BUTTON');
  check('角色卡不留外层内边距', !!card && ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].every((key) => getComputedStyle(card)[key] === '0px'));
  check('角色封面贴着卡片顶边与左右边', !!card && !!media && ['left', 'right', 'top'].every((key) => Math.abs(card.getBoundingClientRect()[key] - media.getBoundingClientRect()[key]) < 1));
  check('角色封面由卡片统一裁切圆角', !!card && !!media && getComputedStyle(card).overflow === 'hidden' && getComputedStyle(media).borderTopLeftRadius === '0px');
  click(media);
  await sleep(300);

  // --- 老卡兼容：只有一张图（没有 portrait 键）的卡 ---
  // 用真实交互造：新建一张卡、只传头像、保存 —— 落盘后照样没有 portrait 键，
  // 这就是老卡那种「只有一张图」的形态（不走 saveCharacters 硬塞：那样绕开了
  // 渲染层，界面上根本看不到这张卡）。
  const OLD = '只有一张图的老卡';
  click('#btn-chars');
  await waitFor('切回角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', OLD);
  click('#char-avatar');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  await waitFor('头像按 384 落进框里', () => { const i = byId('char-avatar').querySelector('img'); return !!i && i.naturalWidth === 384; });
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(200);

  const opened = (await savedCharacters()).find((c) => c.name === OLD);
  check('只传过头像的卡，落盘后没有 portrait 键', !!opened && !('portrait' in opened));

  const oldCard = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === OLD
  );
  check('只有一张图的卡，列表上显示的还是它那张图', !!oldCard && !!oldCard.querySelector('.char-card-avatar img'));
  if (!oldCard) return;

  click(buttonByText(oldCard, '编辑'));
  await waitFor('编辑器打开', () => shown('#view-char-editor'));
  check('老卡的形象框先沿用头像那张图', byId('char-portrait').classList.contains('is-inherited'));

  click('#char-avatar');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  // 换头像之后形象栏要接过原来那张，于是不再标「沿用头像」。
  // （不能等 img.src 变化：images:pick 的桩每次都给同一张 1×1 PNG，
  //   两次裁出来的字节是一样的，src 根本不变。）
  await waitFor('形象接过了旧头像', () => !byId('char-portrait').classList.contains('is-inherited'));
  click('#btn-save-char');
  // 改已有的角色不会自动关弹窗（留着接着改别的字段），这里等落盘再自己关
  await sleep(400);
  click('#btn-close-chars');
  await sleep(150);

  const fixed = (await savedCharacters()).find((c) => c.name === OLD);
  check(
    '老卡换头像时，原来那张图原封不动留成了形象',
    !!fixed && !!opened && fixed.portrait === opened.avatar,
    String(fixed && fixed.portrait).slice(0, 24)
  );
  check('老卡的头像还是有的', !!fixed && isImg(fixed.avatar));
});

// ---------------------------------------------------------------------------
//  场景 14：角色属性 —— 粘贴文本批量生成
// ---------------------------------------------------------------------------
await scenario('角色属性：粘贴文本批量生成', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', '粘贴测试角色');

  check('粘贴区一开始是收着的', !shown('#c-attr-paste'));
  click('#btn-attr-paste');
  await waitFor('粘贴区展开', () => shown('#c-attr-paste'));

  // 故意混几种写法 + 两行认不出来的（空行 / 光一个名字 / 保留字）
  setValue(
    '#c-attr-paste-text',
    ['金币：9900', '【上衣】：衬衫', '年龄 16', '- 下装：裙子', '', '籍贯', '旁白：不该收进来'].join('\n')
  );
  click('#btn-attr-paste-apply');
  await waitFor('属性行出现', () => $$('#c-attr-list .attr-row').length >= 4);
  await sleep(80);

  const names = $$('#c-attr-list .attr-name').map((n) => n.textContent);
  const valueOf = (n) => {
    const row = $$('#c-attr-list .attr-row').find((r) => r.querySelector('.attr-name').textContent === n);
    return row ? row.querySelector('.attr-value').value : null;
  };

  check('四种写法都认出来了', ['金币', '上衣', '年龄', '下装'].every((n) => names.includes(n)), JSON.stringify(names));
  check(
    '值也对',
    valueOf('金币') === '9900' && valueOf('上衣') === '衬衫' && valueOf('年龄') === '16' && valueOf('下装') === '裙子',
    JSON.stringify({ 金币: valueOf('金币'), 上衣: valueOf('上衣'), 年龄: valueOf('年龄'), 下装: valueOf('下装') })
  );
  check('认不出的行跳过（光一个名字）', !names.includes('籍贯'), JSON.stringify(names));
  check('保留字不收（旁白）', !names.includes('旁白'), JSON.stringify(names));
  check('解析完自动收起粘贴区', !shown('#c-attr-paste'));

  // 再贴一次：同名的应该覆盖值，而不是加出第二条
  click('#btn-attr-paste');
  await waitFor('粘贴区展开', () => shown('#c-attr-paste'));
  setValue('#c-attr-paste-text', '金币：1\n新字段：值');
  click('#btn-attr-paste-apply');
  await waitFor('新字段出现', () => $$('#c-attr-list .attr-name').some((n) => n.textContent === '新字段'));
  await sleep(80);

  const names2 = $$('#c-attr-list .attr-name').map((n) => n.textContent);
  check('同名没有加出第二条', names2.filter((n) => n === '金币').length === 1, JSON.stringify(names2));
  check('同名的值被覆盖了', valueOf('金币') === '1', String(valueOf('金币')));
  check('新字段加进来了', names2.includes('新字段'), JSON.stringify(names2));

  // 存盘往返（顺带再验一次白名单没漏字段）
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === '粘贴测试角色');
  check(
    '粘贴出来的属性也落盘了',
    !!saved && saved.attributes.length === 5 && saved.attributes.some((a) => a.name === '金币' && a.value === '1'),
    JSON.stringify(saved && saved.attributes)
  );
});

// ---------------------------------------------------------------------------
//  场景 14.5：角色属性 —— 套用官方互动模板
//
//  一键种入官方固定分组（状态栏 / 关系 / 背包）和默认字段，字段带好
//  类型 / 范围 / 变化规则。这是「互动模板」的核心体验：不用手动建组、
//  不用逐条填类型。
// ---------------------------------------------------------------------------
await scenario('角色属性：套用互动模板', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', '模板测试角色');

  // 空卡还没有任何分组
  const tabLabels = () => $$('#c-attr-tabs .attr-tab').map((b) => b.textContent);

  check('模板入口在属性区里', !!byId('btn-attr-template'));
  click('#btn-attr-template');
  await waitFor('模板字段种进来了', () => $$('#c-attr-list .attr-row').length >= 3);

  // 三个官方分组都出现在标签栏里（各带字段计数）
  check(
    '三个固定分组都出现了',
    ['状态栏', '关系', '背包'].every((g) => tabLabels().some((t) => t.startsWith(g))),
    JSON.stringify(tabLabels())
  );
  check('状态栏组里有 3 个字段（时间 / 地点 / 心情）', tabLabels().some((t) => t.startsWith('状态栏 3')), JSON.stringify(tabLabels()));
  check('关系组里有 2 个字段（好感度 / 关系阶段）', tabLabels().some((t) => t.startsWith('关系 2')), JSON.stringify(tabLabels()));
  check('背包组里有 1 个字段（物品）', tabLabels().some((t) => t.startsWith('背包 1')), JSON.stringify(tabLabels()));

  // 应用完停在「状态栏」，能看到刚种进来的字段
  const names = $$('#c-attr-list .attr-name').map((n) => n.textContent);
  check('应用完停在状态栏，能看到时间/地点/心情', ['时间', '地点', '心情'].every((n) => names.includes(n)), JSON.stringify(names));

  // 切到「关系」：好感度是带范围的数值，关系阶段是文本，都有变化规则
  const clickTab = (prefix) => {
    const tab = $$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith(prefix));
    if (!tab) throw new Error(`标签栏里没有「${prefix}」`);
    click(tab);
  };
  clickTab('关系');
  await waitFor('切到关系组', () => $$('#c-attr-list .attr-name').some((n) => n.textContent === '好感度'));

  // 好感度是带范围的数值字段，「更多」默认就是展开的（有范围就展开）——
  // 直接断言范围 0~100 和变化规则，不再点按钮（点了反而会收起）。
  const favorRow = () => $$('#c-attr-list .attr-row').find((r) => r.querySelector('.attr-name').textContent === '好感度');
  await waitFor('好感度的范围框可见', () => !!favorRow().parentElement.querySelector('.attr-more .attr-num'));
  const numInputs = favorRow().parentElement.querySelectorAll('.attr-more .attr-num');
  check('好感度范围是 0~100', numInputs[0].value === '0' && numInputs[1].value === '100', JSON.stringify(Array.from(numInputs).map((i) => i.value)));
  check(
    '好感度带变化规则',
    favorRow().parentElement.querySelector('.attr-more .attr-hint').value.includes('示好'),
    favorRow().parentElement.querySelector('.attr-more .attr-hint').value
  );

  // 保存后落盘：类型/范围/hint/分组都在
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === '模板测试角色');
  const byName = (n) => ((saved && saved.attributes) || []).find((a) => a.name === n) || {};
  check('模板字段都落盘了', !!saved && saved.attributes.length === 6, JSON.stringify(saved && (saved.attributes || []).map((a) => a.name)));
  check(
    '好感度类型/范围/规则/分组都对',
    byName('好感度').type === 'meter' && byName('好感度').min === 0 && byName('好感度').max === 100 &&
      String(byName('好感度').hint || '').includes('示好') && byName('好感度').group === '关系',
    JSON.stringify(byName('好感度'))
  );
  check('关系阶段带「按好感度自动」的变化规则', String(byName('关系阶段').hint || '').includes('好感度'), JSON.stringify(byName('关系阶段')));
  check('物品是列表类型、归到背包', byName('物品').type === 'list' && byName('物品').group === '背包', JSON.stringify(byName('物品')));

  // 再套一次：已存在的字段不重复加
  click('#btn-attr-template');
  await sleep(80);
  check('再套一次不会重复加字段', $$('#c-attr-list .attr-row').length === 3, `实际 ${$$('#c-attr-list .attr-row').length}`);
});

// ---------------------------------------------------------------------------
//  场景 15：角色属性 —— 分组标签栏
//
//  属性在数据上仍是一维数组（分组记在每个字段自己的 group 上），
//  分组只是视图键：点哪个标签就只铺哪一组，在某一组里加字段自动带这个分组。
//  这个场景专门盯「视图分层」，落盘的形状由上面的场景 13 / 14 把关。
// ---------------------------------------------------------------------------
await scenario('角色属性：分组标签栏', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', '分组测试角色');

  const tabLabels = () => $$('#c-attr-tabs .attr-tab').map((b) => b.textContent);
  const listedNames = () => $$('#c-attr-list .attr-name').map((n) => n.textContent);
  const clickTab = (prefix) => {
    const tab = $$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith(prefix));
    if (!tab) throw new Error(`标签栏里没有「${prefix}」`);
    click(tab);
  };

  // 空卡：总得有个地方落笔，所以默认就该有「未分组」这一桶
  check(
    '空卡默认只有一个「未分组」标签',
    JSON.stringify(tabLabels()) === JSON.stringify(['未分组 0']),
    JSON.stringify(tabLabels())
  );

  setValue('#c-attr-new', '金币');
  click('#btn-add-attr');
  await waitFor('金币出现', () => listedNames().includes('金币'));
  check('标签上的计数跟着涨', tabLabels()[0] === '未分组 1', JSON.stringify(tabLabels()));

  // 新建一个分组：回车确认，应该立刻切过去
  const newTabInput = $('#c-attr-tabs .attr-tab-new');
  check('标签栏末尾有「新建分组」入口', !!newTabInput);
  setValue(newTabInput, '背包');
  newTabInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor('切到新分组', () => tabLabels().some((t) => t.startsWith('背包')));
  check(
    '新建的空分组也在标签栏里，且排在未分组前面',
    JSON.stringify(tabLabels()) === JSON.stringify(['背包 0', '未分组 1']),
    JSON.stringify(tabLabels())
  );
  check('切到空分组后列表是空的', listedNames().length === 0, JSON.stringify(listedNames()));
  // 空组光秃秃的会让人以为界面坏了 —— 得有一句话告诉他下一步干嘛
  check(
    '空分组里有引导文案',
    !!$('#c-attr-list .attr-empty') && $('#c-attr-list .attr-empty').textContent.includes('背包'),
    ($('#c-attr-list .attr-empty') || {}).textContent
  );
  // 组名和字段数拆成了两个节点（数字做成徽标），但整串得还是「名字 空格 数字」——
  // 测试是按整串比对的，拆节点时最容易把那个空格弄丢
  check(
    '标签里的组名和计数是两个节点，中间的空格还在',
    !!$('#c-attr-tabs .attr-tab-name') && !!$('#c-attr-tabs .attr-tab-count') &&
      $('#c-attr-tabs .attr-tab').textContent === '背包 0',
    JSON.stringify(($('#c-attr-tabs .attr-tab') || {}).textContent)
  );

  // 在「背包」这一页加字段：应该自动归到背包，不用再去「更多」里填分组
  setValue('#c-attr-new', '道具');
  click('#btn-add-attr');
  await waitFor('道具出现', () => listedNames().includes('道具'));
  check('在当前分组里加字段，自动带上这个分组', tabLabels()[0] === '背包 1', JSON.stringify(tabLabels()));

  setValue('#c-attr-new', '上衣');
  click('#btn-add-attr');
  await waitFor('上衣出现', () => listedNames().includes('上衣'));
  check('继续加还是这一组', tabLabels()[0] === '背包 2', JSON.stringify(tabLabels()));

  // 切回未分组：只该看到金币
  clickTab('未分组');
  await waitFor('切回未分组', () => listedNames().length === 1);
  check('切组之后只显示那一组的字段', listedNames().join(',') === '金币', JSON.stringify(listedNames()));

  // 再切回背包：还是那两行，顺序也没变
  clickTab('背包');
  await waitFor('切回背包', () => listedNames().length === 2);
  check('切回去还是那两行、顺序不变', listedNames().join(',') === '道具,上衣', JSON.stringify(listedNames()));

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === '分组测试角色');
  const byName = (n) => ((saved && saved.attributes) || []).find((a) => a.name === n) || {};
  check('三个字段都存下来了', !!saved && saved.attributes.length === 3, JSON.stringify(saved && saved.attributes));
  check(
    '分组落在字段自己身上',
    byName('道具').group === '背包' && byName('上衣').group === '背包',
    JSON.stringify(saved && saved.attributes)
  );
  // 未分组的字段不写 group —— 数据形状要和以前完全一样，老卡的往返才不会变样
  check('未分组的字段不写 group', !!saved && saved.attributes.length === 3 && byName('金币').group === undefined, JSON.stringify(byName('金币')));
  check(
    '编辑器的视图状态没被写进角色卡（_activeGroup / _extraGroups）',
    !!saved &&
      saved.attributes.every((a) => !('_activeGroup' in a) && !('_extraGroups' in a)),
    JSON.stringify(saved && Object.keys(saved.attributes[0] || {}))
  );
});

// ---------------------------------------------------------------------------
//  场景：角色属性 —— 分组的改名 / 解散 / 顺序稳定
//
//  分组以前只能靠「在某个字段的『更多』里填 group」间接建出来，建完就没有
//  入口了 —— 改不了名，也解散不掉。另外标签栏按**字段在数组里的先后**排，
//  于是空分组会被已经有字段的组顶到后面去，看着像在按字段数量排队。
//  这个场景盯这两件事。
// ---------------------------------------------------------------------------
await scenario('角色属性：分组改名与解散', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', '分组改名角色');

  const tabLabels = () => $$('#c-attr-tabs .attr-tab').map((b) => b.textContent);
  const listedNames = () => $$('#c-attr-list .attr-name').map((n) => n.textContent);
  const clickTab = (prefix) => {
    const tab = $$('#c-attr-tabs .attr-tab').find((b) => b.textContent.startsWith(prefix));
    if (!tab) throw new Error(`标签栏里没有「${prefix}」`);
    return click(tab);
  };
  const newGroup = (name) => {
    const box = $('#c-attr-tabs .attr-tab-new');
    setValue(box, name);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return waitFor(`分组「${name}」出现`, () => tabLabels().some((t) => t.startsWith(name)));
  };
  const addAttr = (name) => {
    setValue('#c-attr-new', name);
    click('#btn-add-attr');
    return waitFor(`属性「${name}」出现`, () => listedNames().includes(name));
  };
  const openGroupEdit = () => {
    click($('#c-attr-tabs .attr-tab-edit'));
    return waitFor('分组操作条出现', () => shown('#c-attr-group-edit'));
  };
  // 改名走 change（回车 / 失焦），而 setValue 只补一个 input —— 手动补齐
  const renameTo = (name) => {
    const box = $('#c-attr-group-edit .attr-group-name');
    setValue(box, name);
    box.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // --- 顺序：先建的空分组不该被「后建的、已经填了字段的组」顶下去 ---
  await newGroup('状态');
  await newGroup('关系');
  await addAttr('好感度');
  check(
    '先建的分组留在原位，没被后面填了字段的组顶到后面',
    JSON.stringify(tabLabels()) === JSON.stringify(['状态 0', '关系 1']),
    JSON.stringify(tabLabels())
  );

  clickTab('状态');
  await addAttr('体温');
  check(
    '回头给先建的那一组填字段，顺序仍然是创建顺序',
    JSON.stringify(tabLabels()) === JSON.stringify(['状态 1', '关系 1']),
    JSON.stringify(tabLabels())
  );

  // --- 改名：空分组改名不能把它改没了 ---
  clickTab('状态');
  await openGroupEdit();
  check(
    '操作条里带出了当前分组名',
    $('#c-attr-group-edit .attr-group-name').value === '状态',
    $('#c-attr-group-edit .attr-group-name').value
  );
  renameTo('心情');
  await waitFor('改名生效', () => tabLabels().some((t) => t.startsWith('心情')));
  check(
    '改名后标签留在原来的位置（没跳到末尾）',
    JSON.stringify(tabLabels()) === JSON.stringify(['心情 1', '关系 1']),
    JSON.stringify(tabLabels())
  );
  check('改名后仍停在那一组，字段也还在', listedNames().join(',') === '体温', JSON.stringify(listedNames()));

  // --- 改名时按 Esc：只该取消改名，**不能**把整个角色编辑器一起关掉 ---
  // 以前这两个输入框的 Esc 分支只 preventDefault、没 stopPropagation，
  // 事件冒泡到入口层的全局 Esc 链（document 上）就把 charsModal 关了。
  await openGroupEdit();
  {
    const escBox = $('#c-attr-group-edit .attr-group-name');
    escBox.value = '不该生效的名字';
    escBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(120);
    check('改名时按 Esc 不会关掉角色编辑器', shown('#view-char-editor'));
    check('改名时按 Esc 也不会连弹「放弃新建」确认框', !shown('#confirm-modal'));
    check('按 Esc 是「放弃改名」，名字没被改掉', tabLabels().some((t) => t.startsWith('心情')), JSON.stringify(tabLabels()));
  }

  // --- 改成已有的名字 = 并组 ---
  clickTab('关系');
  await openGroupEdit();
  renameTo('心情');
  await waitFor('并组完成', () => listedNames().length === 2);
  check(
    '改成已有的名字就是并组，被并掉的那个位置不占坑',
    JSON.stringify(tabLabels()) === JSON.stringify(['心情 2']),
    JSON.stringify(tabLabels())
  );
  check('两组的字段合到一起，一个都没丢', listedNames().join(',') === '好感度,体温', JSON.stringify(listedNames()));

  // --- 解散：字段退回「未分组」，动之前先问一句 ---
  // 并组/改名完成后操作条会自动收起来（免得留在那儿被误点第二次），
  // 所以要重新点开「⋯」再拿里面的按钮。
  await openGroupEdit();
  click($('#c-attr-group-edit m-button'));
  await waitFor('确认弹窗出现', () => shown('#confirm-modal'));
  check(
    '确认弹窗把「属性会退回未分组」说清楚了',
    byId('confirm-message').textContent.includes('未分组') && byId('confirm-message').textContent.includes('2'),
    byId('confirm-message').textContent
  );
  click('#confirm-ok');
  await waitFor('解散完成', () => tabLabels().length === 1 && tabLabels()[0] === '未分组 2');
  check('解散之后属性退回「未分组」，一个都没少', listedNames().join(',') === '好感度,体温', JSON.stringify(listedNames()));

  // --- 空分组直接删，不该弹确认 ---
  await newGroup('临时');
  await openGroupEdit();
  click($('#c-attr-group-edit m-button'));
  await waitFor('空分组被删掉', () => tabLabels().join() === '未分组 2');
  check('删空分组不弹确认（没什么可丢的）', !shown('#confirm-modal'));

  // --- 视图状态别跟着落盘 ---
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(150);

  const saved = (await savedCharacters()).find((c) => c.name === '分组改名角色');
  check('结果落盘：两个属性都在「未分组」', !!saved && saved.attributes.length === 2, JSON.stringify(saved && saved.attributes));
  check(
    '解散过的分组没有留在数据里（字段上不写 group）',
    !!saved && saved.attributes.every((a) => a.group === undefined),
    JSON.stringify(saved && saved.attributes)
  );
  check(
    '创建顺序表也没被写进角色卡',
    !!saved && saved.attributes.every((a) => !('_groupOrder' in a) && !('_groupEditOpen' in a)),
    JSON.stringify(saved && Object.keys(saved.attributes[0] || {}))
  );
});

// ---------------------------------------------------------------------------
//  场景 19：会话分支 + 存档点
//
//  「分支」= 另开一个会话把前 N 条复制过去（当前这条线一个字节都不动）；
//  「存档点」= 当前会话内的快照，读档会整个退回去。
// ---------------------------------------------------------------------------
await scenario('会话：分支与存档点', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(250);

  const before = await window.mimitale.getConversations();
  const origin = before.conversations.find((c) => c.id === before.activeId);
  check('有一个够长的会话可以分支', !!origin && (origin.messages || []).length >= 2, `消息 ${origin && (origin.messages || []).length} 条`);

  // --- 分支 ---
  const nodes = $$('#messages .msg');
  check('消息列表够长', nodes.length >= 2, String(nodes.length));
  check('消息上有「分支」入口', !!buttonByText(nodes[1], '分支'), '没找到');

  await openMsgMore(nodes[1]);
  click(buttonByText(nodes[1], '分支'));
  await sleep(500);

  const after = await window.mimitale.getConversations();
  check('多出了一个会话', after.conversations.length === before.conversations.length + 1, `${before.conversations.length} → ${after.conversations.length}`);

  const branch = after.conversations.find((c) => c.id === after.activeId);
  check('新会话成了当前会话', !!branch && branch.id !== origin.id, branch && String(branch.id));
  check('标题标了「分支」', !!branch && String(branch.title).includes('（分支）'), branch && branch.title);
  check('前两条原样复制过去了', !!branch && branch.messages.length === 2, branch && String(branch.messages.length));
  check('消息内容也对得上', !!branch && branch.messages[1].content === origin.messages[1].content, '');
  check('绑定的世界书跟着走', !!branch && (branch.worldbookIds || []).length === (origin.worldbookIds || []).length, '');

  // 关键：原来那条线一个字都没动
  const originAfter = after.conversations.find((c) => c.id === origin.id);
  check(
    '原来那条线完好无损',
    !!originAfter && originAfter.messages.length === origin.messages.length,
    `${origin.messages.length} 条 → ${originAfter && originAfter.messages.length} 条`
  );

  // --- 存档点 ---
  await clickMoreItem('#btn-memory');
  await waitFor('记忆弹窗打开', () => shown('#memory-modal'));
  await sleep(200);

  check('记忆弹窗里有「存档点」一节', !!byId('checkpoint-list'), '没找到');
  check('一开始没有存档点', byId('checkpoint-list').textContent.includes('还没有存档点'), byId('checkpoint-list').textContent.trim().slice(0, 24));

  click('#btn-save-checkpoint');
  await sleep(350);
  check('存下了一个档', $$('#checkpoint-list .checkpoint-row').length === 1, String($$('#checkpoint-list .checkpoint-row').length));
  const rowName = $('#checkpoint-list .checkpoint-name').textContent;
  check('档名写明了存的时候有几条消息', rowName.includes('2 条消息'), rowName);

  click('#btn-close-memory');
  await sleep(250);

  // --- 存完档再聊一条，然后读档退回去 ---
  setValue('#input', '这条是存完档之后聊的，读档应该把它退掉');
  click('#btn-send');
  await waitFor('新一轮回复完成', () => $$('#messages .msg').length > 2 && byId('btn-send').getAttribute('data-mode') === 'send', 10000);
  // 落盘是防抖的（350ms），等久一点再读磁盘，否则读到的是上一步的快照
  await sleep(700);

  const grownNodes = $$('#messages .msg').length;
  check('界面上长长了（存档之后又聊了）', grownNodes > 2, `${grownNodes} 条`);

  const grown = (await window.mimitale.getConversations()).conversations.find((c) => c.id === branch.id);
  check('新消息也落盘了', grown.messages.length === grownNodes, `界面 ${grownNodes} 条 / 磁盘 ${grown.messages.length} 条`);

  await clickMoreItem('#btn-memory');
  await waitFor('记忆弹窗打开', () => shown('#memory-modal'));
  await sleep(200);

  click(buttonByText($('#checkpoint-list .checkpoint-row'), '读档'));
  await waitFor('读档前先确认', () => shown('#confirm-modal'));
  check('确认文案说明了会丢内容', $('#confirm-message').textContent.includes('回到'), $('#confirm-message').textContent.trim().slice(0, 30));
  click('#confirm-ok');
  await sleep(600);

  const restored = (await window.mimitale.getConversations()).conversations.find((c) => c.id === branch.id);
  check('读档后退回到存档时的条数', restored.messages.length === 2, `${grown.messages.length} → ${restored.messages.length}`);
  check('存档点本身还留着（能再读一次）', $$('#checkpoint-list .checkpoint-row').length === 1, String($$('#checkpoint-list .checkpoint-row').length));

  // --- 删掉存档点 ---
  click(buttonByText($('#checkpoint-list .checkpoint-row'), '删除'));
  await waitFor('删除前先确认', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await sleep(450);
  check('删掉后回到空状态', byId('checkpoint-list').textContent.includes('还没有存档点'), byId('checkpoint-list').textContent.trim().slice(0, 24));

  click('#btn-close-memory');
  await sleep(200);
});

// ---------------------------------------------------------------------------
//  场景 20：语义检索（RAG）
//
//  关键词匹配的死角：世界书里写着「十二泰坦」，但对话里问的是「那些神」——
//  按关键词永远命中不了。这里就验这件事：问「那些神」，那条设定能不能被捞回来。
//  具体注入了什么由宿主侧断言（见 smoke-test.js 的 probeRag）。
// ---------------------------------------------------------------------------
await scenario('语义检索', async () => {
  // 先在设置里打开并配好
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));
  await sleep(200);

  check('设置里有语义检索这一节', !!byId('s-rag-enabled') && !!byId('s-embedding-provider'));
  check('默认是关的（开着要额外花钱）', byId('s-rag-enabled').checked === false);

  const embOptions = Array.from(byId('s-embedding-provider').options).map((o) => o.value);
  check('向量服务商下拉把三个服务商都列上了', embOptions.length === 4 && embOptions.includes('p-emb'), JSON.stringify(embOptions));

  setValue('#s-embedding-provider', 'p-emb');
  await sleep(200);
  const embModelOptions = Array.from(byId('s-embedding-model').options).map((o) => o.value);
  check(
    '向量模型也是下拉，跟着服务商走',
    asControl(byId('s-embedding-model')).tagName === 'SELECT' && embModelOptions.length === 1 && embModelOptions[0] === 'emb-model-x',
    `${asControl(byId('s-embedding-model')).tagName} ${JSON.stringify(embModelOptions)}`
  );
  setValue('#s-embedding-model', 'emb-model-x');
  click('#s-rag-enabled');
  await sleep(120);
  click('#btn-save-settings');
  await waitFor('设置关闭', () => !shown('#view-settings'));
  await sleep(400);

  const saved = (await window.mimitale.getSettings()).settings;
  check('语义检索配置落盘了', saved.ragEnabled === true && saved.embeddingProviderId === 'p-emb' && saved.embeddingModel === 'emb-model-x', JSON.stringify({ on: saved.ragEnabled, p: saved.embeddingProviderId, m: saved.embeddingModel }));
  check('聊天模型没被动过', saved.activeProviderId === 'p-test' && saved.activeModel === 'test-model', `${saved.activeProviderId}/${saved.activeModel}`);

  // 发一条「关键词命不中、但意思相关」的话
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  await sleep(200);
  setValue('#input', '那些神到底是谁？');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').getAttribute('data-mode') === 'send', 12000);
  await sleep(400);

  // 负向对照：关掉之后不该再注入
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));
  await sleep(200);
  click('#s-rag-enabled');
  await sleep(120);
  click('#btn-save-settings');
  await waitFor('设置关闭', () => !shown('#view-settings'));
  await sleep(300);

  const off = (await window.mimitale.getSettings()).settings;
  check('关掉之后落盘也是关的', off.ragEnabled === false, String(off.ragEnabled));

  setValue('#input', '关了语义检索之后再问一句，这句不该带往事');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').getAttribute('data-mode') === 'send', 12000);
  await sleep(400);
});

// ---------------------------------------------------------------------------
//  准备悬停验证（必须放最后：它会把卡片摆好交给宿主）
// ---------------------------------------------------------------------------
let hoverProbe = null;
await scenario('准备悬停验证', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));

  // 这里可能已经有别的角色卡了（属性场景留下的），所以按「多了一张」判断
  const beforeCards = $$('#char-page-grid .char-card').length;

  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', '悬停验证角色');
  click('#btn-save-char');
  await waitFor('卡片出现', () => $$('#char-page-grid .char-card').length === beforeCards + 1);
  click('#btn-close-chars');
  await sleep(120);

  const card = $$('#char-page-grid .char-card')[0];
  const r = card.getBoundingClientRect();
  hoverProbe = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  check('卡片已就位，坐标可交给宿主', !!hoverProbe && hoverProbe.x > 0 && hoverProbe.y > 0, JSON.stringify(hoverProbe));
});

// ---------------------------------------------------------------------------
//  帮我想想：给几个下一步让你挑
//
//  它和自动剧情选项是**同一块 UI**（.msg-options）—— 区别只是手动要一次。
//  所以断言按剧情选项的口径走（序号 / 换一批 / ✕），不再有独立的建议条。
// ---------------------------------------------------------------------------
await scenario('帮我想想（补一批剧情选项）', async () => {
  // 回聊天视图，并确保末尾有一条 AI 回复（工具条上才有「帮我想想」）
  const convoItem = $('#convo-list .convo-item');
  if (convoItem) {
    click(convoItem);
    await waitFor('切回聊天视图', () => shown('#view-chat'));
    await sleep(250);
  }

  const lastAssistant = () => $$('#messages .msg.assistant').pop();
  const actionsOf = (node) =>
    node ? Array.from(node.querySelectorAll('.msg-actions .mini-btn')).map((b) => b.textContent.trim()) : [];

  check('AI 回复上有「帮我想想」', actionsOf(lastAssistant()).includes('帮我想想'), JSON.stringify(actionsOf(lastAssistant())));
  check('用户消息上没有「帮我想想」', !actionsOf($$('#messages .msg.user').pop()).includes('帮我想想'));
  check(
    '输入框上方没有独立的建议条（已并进剧情选项）',
    !byId('suggest-strip') && !byId('suggest-list') && !byId('btn-suggest-close')
  );

  // 先把已有的自动选项收掉，才能证明下面这块是「帮我想想」生出来的
  const closeBefore = $$('#messages .msg-options-close')[0];
  if (closeBefore) {
    click(closeBefore);
    await sleep(250);
  }
  check('收起之后没有选项块', $$('#messages .msg-options').length === 0, `${$$('#messages .msg-options').length} 块`);

  // 点「帮我想想」（常显，不用先展开「⋯」）→ 假后端会回 5 行带序号和引号的选项
  const trigger = Array.from(lastAssistant().querySelectorAll('.msg-actions .mini-btn'))
    .find((b) => b.textContent.trim() === '帮我想想');
  click(trigger);
  await waitFor('选项块长出来', () => $$('#messages .msg-options').length > 0, 8000);
  await sleep(200);

  const items = $$('#messages .msg-option-btn');
  const texts = items.map((b) => b.querySelector('.opt-text').textContent);

  check('渲染出 4 个选项（第 5 条被丢掉）', items.length === 4, `${items.length}: ${JSON.stringify(texts)}`);
  check('按钮都是 button 元素', items.every((b) => b.tagName === 'BUTTON'), true);
  check('序号被剥掉', !texts.some((t) => /^\d+\s*[.、)）]/.test(t)), JSON.stringify(texts));
  check('引号被剥掉', !texts.some((t) => /^[「『"']/.test(t) || /[」』"']$/.test(t)), JSON.stringify(texts));
  check('第一条内容正确', texts[0] === '我想先喝一杯，压压惊', JSON.stringify(texts[0]));
  check('四条彼此不同', new Set(texts).size === texts.length, JSON.stringify(texts));

  // 版式跟自动选项是同一套：带数字序号（输入框能按 1~9）、带「换一批」
  check(
    '选项前面带数字序号',
    items.every((b) => /^\d+$/.test((b.querySelector('.opt-index') || {}).textContent || '')),
    JSON.stringify(items.map((b) => (b.querySelector('.opt-index') || {}).textContent))
  );
  check('选项块带「换一批」（跟自动选项同一块 UI）', $$('#messages .msg-options-reroll').length > 0);
  check('选项挂在最新一条 AI 回复下面', !!lastAssistant().querySelector('.msg-options'));

  // --- 有选项块时再点「帮我想想」：也要有骨架屏（和「换一批」是同一个动作）---
  // 用户报的 bug：两个按钮能同时点，而且点「帮我想想」时没有加载态。
  {
    byId('toast').classList.add('hidden');
    byId('toast').textContent = '';

    const again = Array.from(lastAssistant().querySelectorAll('.msg-actions .mini-btn'))
      .find((b) => b.textContent.trim() === '帮我想想');
    click(again);

    check(
      '有选项块时点「帮我想想」也画骨架屏',
      $$('#messages .msg-option-skeleton').length > 0,
      `骨架条 ${$$('#messages .msg-option-skeleton').length} 条`
    );

    // 这一次还没回来，紧接着点「换一批」：必须挡下来，不能并发发第二个请求
    const rerollNow = $$('#messages .msg-options-reroll')[0];
    if (rerollNow) {
      click(rerollNow);
      check(
        '要选项期间再点「换一批」会被挡下（不并发）',
        byId('toast').textContent.includes('正在要选项'),
        byId('toast').textContent
      );
      check(
        '被挡下时骨架屏还在（不会被误换回按钮）',
        $$('#messages .msg-option-skeleton').length > 0,
        `骨架条 ${$$('#messages .msg-option-skeleton').length} 条`
      );
    }

    await waitFor(
      '这一批回来（骨架屏换回按钮）',
      () => $$('#messages .msg-option-skeleton').length === 0 && $$('#messages .msg-option-btn').length > 0,
      8000
    );
  }

  // 点第一条 → 当成玩家的话发出去（上面又重绘过一次，节点要重新抓）
  const beforeUser = $$('#messages .msg.user').length;
  click($$('#messages .msg-option-btn')[0]);
  await waitFor('选项被当成玩家消息发出', () => $$('#messages .msg.user').length === beforeUser + 1, 8000);
  check('发出去的就是选项内容',
    String($$('#messages .msg.user').pop().textContent || '').includes('我想先喝一杯，压压惊'));

  // 等这轮回复收尾，别把后面的场景搅乱
  await waitFor('这一轮回复结束', () => {
    const nodes = $$('#messages .msg.assistant');
    return nodes.length > 0 && !nodes[nodes.length - 1].querySelector('.waiting');
  }, 8000);
  await sleep(250);

  // ✕ 能收起这一批（要新内容就再点一次「帮我想想」）
  const closeAfter = $$('#messages .msg-options-close')[0];
  if (closeAfter) {
    click(closeAfter);
    await sleep(200);
    check(
      '点 ✕ 能收起这一批选项',
      $$('#messages .msg-options').length === 0,
      `${$$('#messages .msg-options').length} 块`
    );
  }
});

// ---------------------------------------------------------------------------
//  角色自带的世界书：绑定 / 解绑 / 开关 / 存盘
// ---------------------------------------------------------------------------
await scenario('角色：绑定自带的世界书', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const NAME = '自带世界书测试';
  setValue('#c-name', NAME);
  await sleep(100);

  // 没绑定时：这一块也要显示（以前是「有绑定才显示」，导致找不到入口加书）
  check('没绑定时这块也显示出来', shown('#c-worldbook-box'));
  check('没绑定时有「＋ 绑定」按钮', shown('#c-wb-add-btn'));
  check('没绑定时清单是空状态提示', $$('#c-wb-list .cwb-row').length === 0);
  // 只能绑一本、绑上就一直生效 —— 「启用」开关已经整个撤掉了
  check('没有「启用自带的世界书」开关了', !byId('c-wb-switch') && !byId('c-wb-enabled'));
  check('空状态给了引导文字', String(byId('c-wb-list').textContent || '').includes('点「＋ 新建」'));
  check('没绑定时也有「＋ 新建」按钮（世界书只能从这张卡长出来）', shown('#c-wb-new-btn'));

  // 点「＋ 绑定」→ 浮层列出可选的库
  click('#c-wb-add-btn');
  await waitFor('选择浮层出现', () => !!$('.cwb-picker'));
  const options = $$('.cwb-picker .cwb-picker-row');
  check('浮层列出了可选世界书', options.length > 0, `${options.length} 个`);
  check('浮层里有冒烟测试世界',
    options.some((o) => String(o.textContent || '').includes('冒烟测试世界')),
    JSON.stringify(options.map((o) => o.textContent.trim())));

  // 选一本 → 绑定
  const target = options.find((o) => String(o.textContent || '').includes('冒烟测试世界'));
  click(target);
  await waitFor('浮层关闭', () => !$('.cwb-picker'));
  await waitFor('清单里出现这本', () => $$('#c-wb-list .cwb-row').length === 1);
  await sleep(150);

  check('绑定后清单里有一行', $$('#c-wb-list .cwb-row').length === 1);
  check('行里是那本书的名字',
    String($$('#c-wb-list .cwb-row')[0].textContent || '').includes('冒烟测试世界'));
  // 🔴 自带世界书只能一本：绑上之后两个入口都灰掉，别再让人点出「第二本」
  check('绑了一本后「＋ 绑定」灰掉', byId('c-wb-add-btn').disabled === true);
  check('绑了一本后「＋ 新建」也灰掉', byId('c-wb-new-btn').disabled === true);
  check('灰掉时给了「先解绑」的提示',
    String(byId('c-wb-add-btn').title || '').includes('先解绑'),
    String(byId('c-wb-add-btn').title || ''));
  check('说明文字提到「单独聊天会带上」',
    String(byId('c-wb-hint').textContent || '').includes('单独跟它聊天时会带上'),
    String(byId('c-wb-hint').textContent || '').slice(0, 60));

  // --- 行上的「编辑」：一步跳到这本书的详情（2026-10-20）---
  const boundRow = $$('#c-wb-list .cwb-row')[0];
  const rowEdit = boundRow.querySelector('.cwb-row-edit');
  check('已绑的那行有「编辑」按钮', !!rowEdit);
  check('「编辑」排在解绑 ✕ 左边',
    !!rowEdit && !!rowEdit.nextElementSibling &&
    rowEdit.nextElementSibling.classList.contains('cwb-row-del'));
  if (rowEdit) {
    click(rowEdit);
    await waitFor('跳到世界书编辑器', () => shown('#view-wb-editor'), 4000);
    check('跳过去的就是绑的那一本',
      String(byId('wb-bookbar-name').textContent || '').includes('冒烟测试世界'),
      byId('wb-bookbar-name').textContent);
    // 跳转不是「离开角色编辑器」：表单内容得原样留着
    check('跳转不丢角色编辑器里填的内容', byId('c-name').value === NAME, byId('c-name').value);

    click('#btn-close-worldbooks');
    await waitFor('返回角色编辑器', () => shown('#view-char-editor'), 4000);
    await sleep(150);
    check('返回后还在那张卡上（没被弹「放弃改动」冲掉）',
      byId('c-name').value === NAME, byId('c-name').value);
    check('返回后那行「已绑世界书」还在', $$('#c-wb-list .cwb-row').length === 1);
  }

  // 存盘 → worldbookIds 要落盘（归一化白名单最容易漏）
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'), 8000);
  await sleep(200);

  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  check('worldbookIds 落盘了（没被归一化丢掉）',
    !!saved && Array.isArray(saved.worldbookIds) && saved.worldbookIds.length === 1,
    JSON.stringify(saved && saved.worldbookIds));
  // 开关撤了：磁盘上不该再有这个字段（归一化白名单里已经删除）
  check('磁盘上不再写 worldbookEnabled',
    !!saved && !('worldbookEnabled' in saved),
    JSON.stringify(saved && saved.worldbookEnabled));

  // 解绑 → 清单回到空状态
  if (saved && Array.isArray(saved.worldbookIds) && saved.worldbookIds.length) {
    click($$('#c-wb-list .cwb-row')[0].querySelector('.cwb-row-del'));
    await waitFor('解绑后清单空掉', () => $$('#c-wb-list .cwb-row').length === 0, 8000);
    await sleep(150);
    check('解绑后回到空状态提示',
      String(byId('c-wb-list').textContent || '').includes('点「＋ 新建」'));
  }
});

// ---------------------------------------------------------------------------
//  角色自带的世界书：绑上之后顶部要能看出来生效
//
//  放在最后：这个场景会通过「聊天」入口新建一条会话，
//  建完当前会话就变了 —— 排在中间会把后面场景的起点搅乱
//  （第一次放在「重新生成候选」前面，直接把那个场景弄挂了）。
// ---------------------------------------------------------------------------
await scenario('角色自带的世界书：顶部能看出生效', async () => {
  // 造一张绑了世界书的角色，存档
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  const NAME = '顶栏生效测试';
  setValue('#c-name', NAME);
  await sleep(80);

  click('#c-wb-add-btn');
  await waitFor('选择浮层出现', () => !!$('.cwb-picker'));
  const target = $$('.cwb-picker .cwb-picker-row').find((o) =>
    String(o.textContent || '').includes('冒烟测试世界')
  );
  click(target);
  await waitFor('清单里出现这本', () => $$('#c-wb-list .cwb-row').length === 1);
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'), 8000);
  await sleep(200);

  // 关掉编辑器，回聊天视图（关编辑器不会自动切页，得点会话）
  click('#btn-close-chars');
  await sleep(200);
  click('#convo-list .convo-item');
  await waitFor('回聊天视图', () => shown('#view-chat'));
  await sleep(250);

  // 头部不该无中生有：还没绑角色的会话不显示「角色自带」
  const beforeBind = String(byId('convo-meta').textContent || '');
  check('绑之前头部没有「角色自带」', !beforeBind.includes('（角色自带）'), beforeBind);

  const chars = (await savedCharacters()).filter((c) => c.name === NAME);
  const targetChar = chars[0];
  check('角色建好并且绑了世界书',
    !!targetChar && Array.isArray(targetChar.worldbookIds) && targetChar.worldbookIds.length === 1,
    JSON.stringify(targetChar && targetChar.worldbookIds));

  if (targetChar) {
    // 用角色卡上的「聊天」入口绑定角色
    // （顶部那个角色下拉在重构里已经去掉了，别再用它）
    click('#btn-chars');
    await waitFor('切到角色卡页面', () => shown('#view-chars'));
    await sleep(300);
    const card = $$('.char-card').find((c) => String(c.textContent || '').includes(NAME));
    if (!card) {
      check('角色卡出现在列表里', false, JSON.stringify($$('.char-card').map((c) => c.textContent.trim().slice(0, 20))));
    } else {
      const chatBtn = buttonByText(card, '聊天');
      if (!chatBtn) {
        check('角色卡上有「聊天」按钮', false, JSON.stringify(Array.from(card.querySelectorAll('button')).map((b) => b.textContent.trim())));
      } else {
        await startChatWith(card);
        await waitFor('回到聊天视图', () => shown('#view-chat'), 8000);
        await sleep(500);

        // ⚠️ 2026-10-12：世界书信息从顶栏的元信息行**搬到了右侧在场角色面板的脚注**
        //    （设计稿指定的位置，见 views/castPanel.js）—— 断言跟着搬，
        //    同时反过来守一条「顶栏别再重复」。
        const foot = String(byId('cast-foot-book').textContent || '');
        check('绑上角色后，右栏脚注显示它自带的世界书', foot.includes('冒烟测试世界'), foot);
        check('并且标明了是「角色自带」', foot.includes('（角色自带）'), foot);
        const meta = String(byId('convo-meta').textContent || '');
        check('元信息行不再重复世界书', !meta.includes('冒烟测试世界'), meta);
      }
    }
  }
});

// ---------------------------------------------------------------------------
//  场景 20：导入后重发 id 时，角色 → 世界书的绑定必须跟着改写
//
//  这一条是**真 bug 的回归测试**：导入时主进程把内嵌世界书自动绑到角色上，
//  渲染层随后给两边都重发 id —— 只换书的 id 不改写角色里的指向，
//  绑定就指到一本不存在的书，表现是「书在库里但就是不生效」，全程不报错。
//
//  逻辑在 renderer/js/data/library-reissue.js，是个 ES module，
//  所以这里用动态 import 拿真代码来测（不是照抄一份）。
// ---------------------------------------------------------------------------
await scenario('导入：重发 id 时绑定要跟着走', async () => {
  let mod = null;
  try {
    // 按页面 URL 解析相对路径（executeJavaScript 里没有 import.meta）
    const url = new URL('js/data/library-reissue.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('导入重发 id 的模块能加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.reissueImportedIds === 'function') {
    check('导入重发 id 的模块能加载', true);

    // 主进程刚给的那批：角色自带世界书，绑的是主进程生成的旧 id
    const out = mod.reissueImportedIds(
      [
        { id: 'w-old-1', name: '卡里自带的世界书', entries: [], characters: [{ id: 'wc-old', name: '副本' }] },
        { id: 'w-old-2', name: '另一本', entries: [] }
      ],
      [
        { id: 'c-old-1', name: '导入的角色', worldbookIds: ['w-old-1'] },
        { id: 'c-old-2', name: '没绑书的角色', worldbookIds: [] }
      ],
      'stamp1'
    );

    const book1 = out.books[0];
    const char1 = out.chars[0];

    check('书拿到了新 id', !!book1 && book1.id === 'wstamp1-0', book1 && book1.id);
    check('角色拿到了新 id', !!char1 && char1.id === 'cstamp1-0', char1 && char1.id);
    check(
      '角色指向的世界书**跟着改写**了（这是那个 bug 的关键）',
      !!char1 && Array.isArray(char1.worldbookIds) && char1.worldbookIds[0] === book1.id,
      char1 ? `worldbookIds=${JSON.stringify(char1.worldbookIds)} 书的 id=${book1 && book1.id}` : '没有角色'
    );
    check(
      '改写后的指向在库里真的能对上（不是悬空引用）',
      !!char1 && out.books.some((b) => b.id === char1.worldbookIds[0]),
      JSON.stringify(out.books.map((b) => b.id))
    );
    check('书里的角色副本也换了 id', !!book1 && book1.characters[0].id === 'wcstamp1-0-0', book1 && book1.characters[0].id);
    check('没绑书的角色不受影响', !!out.chars[1] && out.chars[1].worldbookIds.length === 0, JSON.stringify(out.chars[1] && out.chars[1].worldbookIds));
    check('原来的 id 没有被顺手改掉（只读输入）', !!out.books[0] && !!char1, '');

    // 两次导入不能撞 id
    const again = mod.reissueImportedIds([{ id: 'w-old-1', name: 'x', entries: [] }], [{ id: 'c-old-1', name: 'y', worldbookIds: ['w-old-1'] }], 'stamp2');
    check('两次导入的 id 不撞车', again.books[0].id !== book1.id && again.chars[0].id !== char1.id, `${again.books[0].id} vs ${book1.id}`);
    check(
      '第二次导入的绑定同样跟着改写',
      again.chars[0].worldbookIds[0] === again.books[0].id,
      JSON.stringify(again.chars[0].worldbookIds)
    );

    // 指向一本这次没导入的书时，别把 id 弄丢（宁可留着悬空，也不要静默清掉）
    const orphan = mod.reissueImportedIds([], [{ id: 'c-old-9', name: 'z', worldbookIds: ['w-not-imported'] }], 'stamp3');
    check(
      '指向本次没导入的书时，原样留着不吞掉',
      orphan.chars[0].worldbookIds[0] === 'w-not-imported',
      JSON.stringify(orphan.chars[0].worldbookIds)
    );

    // 没传 worldbookIds / 没传 characters 的脏数据不该崩
    let dirtyOk = true;
    let dirtyDetail = '';
    try {
      const dirty = mod.reissueImportedIds([null, { id: 'w-old-3', name: 'n' }], [{ id: 'c-old-3', name: 'm' }], 'stamp4');
      dirtyOk = dirty.books.length === 2 && dirty.chars.length === 1 && !('worldbookIds' in dirty.chars[0]);
      dirtyDetail = JSON.stringify(dirty);
    } catch (err) {
      dirtyOk = false;
      dirtyDetail = '崩了：' + ((err && err.message) || err);
    }
    check('脏数据（缺 id / 缺 worldbookIds）不崩', dirtyOk, dirtyDetail);

    let emptyOk = true;
    try {
      const empty = mod.reissueImportedIds(undefined, null, 'stamp5');
      emptyOk = empty.books.length === 0 && empty.chars.length === 0;
    } catch (err) {
      emptyOk = false;
    }
    check('空输入返回空结果', emptyOk);
  }
});

// ---------------------------------------------------------------------------
//  场景 21：剧情选项（每轮给几个可点选项，点一下就当玩家回复发出去）
//
//  这是「互动模板」里最特别的一块：选项不是一次性的建议，而是跟着最新一条
//  AI 回复走（挂在气泡下面），每轮由模型跟着状态栏一起更新，
//  玩家点一下就当作自己说了那句话；不满意还能「换一批」。
// ---------------------------------------------------------------------------
await scenario('剧情选项', async () => {
  // --- 1) 建一个角色、开一局（剧情选项不再长在角色卡上，改到「视角设置」里配）---
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const NAME = '选项测试角色';
  setValue('#c-name', NAME);
  await sleep(80);

  // 角色编辑器「属性」里不再有剧情选项这一块
  check('角色编辑器里没有剧情选项了', !byId('c-options-on') && !byId('c-options-count'));

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'), 8000);
  await sleep(150);
  click('#btn-close-chars');
  await sleep(150);
  const card = $$('#char-page-grid .char-card').find((c) => String(c.textContent || '').includes(NAME));
  check('新角色出现在列表里', !!card);
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'), 8000);
  await sleep(300);

  // --- 2) 在「视角设置」里配剧情选项（跟会话走，和角色无关）---
  click('#btn-perspective');
  await waitFor('视角设置弹窗打开', () => shown('#perspective-modal'));

  // 新会话默认就是开的（4 条）
  check('默认就开着剧情选项', byId('p-options-on').checked === true, String(byId('p-options-on').checked));
  // 数量是四颗单选框（2/3/4/5）—— 读 .value 那套不成立
  const optionRadios = () => Array.from(byId('p-options-count').querySelectorAll('input[type="radio"]'));
  check(
    '只有 2 / 3 / 4 / 5 四档',
    optionRadios().map((r) => r.value).join(',') === '2,3,4,5',
    optionRadios().map((r) => r.value).join(',')
  );
  check(
    '默认每轮给 4 条',
    byId('p-options-count').querySelector('input[value="4"]').checked === true,
    optionRadios().map((r) => `${r.value}:${r.checked}`).join(' ')
  );
  check('开着时配置区是展开的', shown('#p-options-config'));

  click('#p-options-count input[value="3"]');
  setValue('#p-options-hint', '语气轻松些，总有一条冒险的选择');
  // hint 监听的是 change（失焦才写盘），setValue 只派 input，手动补一次
  byId('p-options-hint').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);

  const convos0 = await window.mimitale.getConversations();
  const c0 = convos0.conversations.find((c) => c.id === convos0.activeId);
  check(
    '选项配置写到会话上了（不再写角色卡）',
    !!c0 && !!c0.optionsSpec && c0.optionsSpec.count === 3 && c0.optionsSpec.hint === '语气轻松些，总有一条冒险的选择',
    JSON.stringify(c0 && c0.optionsSpec)
  );
  click('#btn-close-perspective');
  await sleep(150);

  // --- 3) 发一条 → 回复里带选项 → 面板出现可点按钮 ---
  setValue('#input', '选项测试：随便说点什么');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').getAttribute('data-mode') === 'send', 12000);
  await sleep(300);

  // 剧情选项挂在最新一条 AI 回复的气泡下面（不在状态卡里）
  const optionBtns = $$('#messages .msg-option-btn');
  check('气泡下面出现了剧情选项按钮', optionBtns.length > 0, `实际 ${optionBtns.length} 个`);
  check(
    '选项块确实长在 AI 回复的气泡下面',
    $$('#messages .msg.assistant .msg-options').length > 0,
    `实际 ${$$('#messages .msg.assistant .msg-options').length} 块`
  );
  // 选项块底下有个「换一批」按钮，这批不满意可以重新让模型给一批
  check(
    '剧情选项有「换一批」按钮',
    $$('#messages .msg-options-reroll').some((n) => n.textContent.includes('换一批')),
    JSON.stringify($$('#messages .msg-options-reroll').map((n) => n.textContent))
  );

  // --- 点「换一批」→ 重新发请求、解析、写回、重绘 ---
  {
    const rerollBtn = $$('#messages .msg-options-reroll')[0];
    click(rerollBtn);
    // 点下去立刻：选项换成骨架屏、按钮禁用并显示「换一批中…」
    check(
      '点「换一批」后选项换成骨架屏',
      $$('#messages .msg-option-skeleton').length > 0,
      `骨架条 ${$$('#messages .msg-option-skeleton').length} 条`
    );
    check(
      '点「换一批」后按钮显示「换一批中…」',
      $$('#messages .msg-options-reroll').some((n) => n.textContent.includes('换一批中')),
      JSON.stringify($$('#messages .msg-options-reroll').map((n) => n.textContent))
    );
    // 点下去按钮立刻禁用；完成后整块重绘（按钮换成新的、可点）或原地恢复
    await waitFor(
      '换一批完成（按钮恢复可点且选项还在）',
      () => {
        const btn = $$('#messages .msg-options-reroll')[0];
        return !!btn && !btn.disabled && $$('#messages .msg-option-btn').length > 0;
      },
      12000
    );
    // 换一批完成后整块重绘过，要重新抓节点
    const afterReroll = $$('#messages .msg-option-btn').map((b) => b.querySelector('.opt-text').textContent);
    check(
      '换一批后选项按钮还在（写回并重绘成功）',
      afterReroll.length > 0,
      JSON.stringify(afterReroll)
    );
    // 换一批的返回也会被解析成干净的选项（没有「【」残留、没有序号）
    check(
      '换一批后的选项是干净的',
      afterReroll.every((t) => t && !t.includes('【') && !/^\d/.test(t)),
      JSON.stringify(afterReroll)
    );
  }

  const texts = optionBtns.map((b) => b.querySelector('.opt-text').textContent);
  check(
    '序号和引号都被剥掉了（模型爱带，得容忍）',
    texts.includes('我想先喝一杯，压压惊') && texts.includes('我直接问他叫什么名字'),
    JSON.stringify(texts)
  );
  check('重复的选项只留一个', texts.filter((t) => t === '我想先喝一杯，压压惊').length === 1, JSON.stringify(texts));

  // 选项行不该留在消息气泡里（它已经变成按钮了）
  const bodyText = byId('messages').textContent;
  check('消息正文里看不到「【剧情选项】：」原文', !bodyText.includes('【剧情选项】：'), bodyText.slice(-160));
  check('状态栏原文也不在气泡里', !bodyText.includes('【好感度】：63/100'), bodyText.slice(-160));

  // 这一轮的状态栏照常被收下（选项和状态栏是一起回来的）。
  // ⚠️ 状态字段现在不存在「当前状态」面板里了 —— 面板已去掉，
  // 字段按 owner 分给了各人的状态卡。这个会话是单角色聊天，所以字段归那张卡。
  {
    // 读**内存里**的会话（不是盘上那份）：面板是每轮回复后同步的，
    // 落盘有防抖，此时读盘可能还是上一次的快照（原来用 DOM 断言，读的就是内存）。
    const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
    const ca = (stateMod.state.conversations || []).find((c) => c.id === stateMod.state.activeId);
    check(
      '同一条回复里的状态栏被收下了（「好感度」进了会话状态）',
      !!ca && panelValByName(ca.panel, '好感度') === '63/100',
      JSON.stringify(ca && ca.panel)
    );

    // 「剧情选项」是**程序读的指令行**，不是状态字段。
    // 它的形状和面板行一模一样（行首【】、值也不长），所以扫描时很容易被误收 ——
    // 而 cleanAssistantText 又把它剥掉了，于是表现为「气泡里看不见、状态里却多一个字段」。
    // 这条断言盯的就是那个分裂：选项行和状态栏同一条消息回来，它绝不能进字段表。
    check(
      '「剧情选项」没被当成状态字段收下',
      !!ca && !panelValByName(ca.panel, '剧情选项') && !panelDefByName(ca.panelDefs, '剧情选项'),
      JSON.stringify({ panel: ca && Object.keys(ca.panel || {}), defs: ca && Object.keys(ca.panelDefs || {}) })
    );
  }

  // 「好感度」是模型自己输出、这个角色卡上没声明过的字段。
  // 它的值写成「63/100」，从形状就能看出是个带范围的数值 —— 该有进度条。
  // （以前只认角色卡上声明过的属性，模型自己冒出来的数值永远没有进度条。）
  // 这条现在去状态卡里验：字段归角色（owner = 本局的角色），不在面板里。
  {
    const charAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
    check('入口条上有角色头像（模型自己冒的字段归它）', !!charAvatar);
    if (charAvatar) {
      click(charAvatar);
      await waitFor('角色状态卡出现', () => $$('#state-cards .state-card').some((c) => c.dataset.owner !== 'player'));

      const charCard = () => $$('#state-cards .state-card').find((c) => c.dataset.owner !== 'player');
      const favorRow = Array.from(charCard().querySelectorAll('.sc-row')).find(
        (r) => (r.querySelector('.sc-name') || {}).textContent === '好感度'
      );
      check('模型自己给的数值字段也认出了满值（/100）', !!favorRow && !!favorRow.querySelector('.sc-bar'),
        favorRow ? favorRow.outerHTML.slice(0, 160) : '没找到「好感度」那一行');
      const inferredBar = favorRow && favorRow.querySelector('.sc-bar');
      check(
        '推断出来的满值接进了进度条（63/100 → 63%）',
        !!inferredBar && inferredBar.querySelector('.sc-bar-fill').style.width === '63%',
        inferredBar ? inferredBar.querySelector('.sc-bar-fill').style.width : '没有进度条'
      );

      // 推断出来的范围也要真的生效：在卡里手填越界值会被夹回来
      click(charCard().querySelector('.sc-edit'));
      await waitFor('卡切到编辑态', () => !!charCard().querySelector('.sc-input'));
      const input = Array.from(charCard().querySelectorAll('.sc-row')).find(
        (r) => (r.querySelector('.sc-name') || {}).textContent === '好感度'
      ).querySelector('.sc-input');
      if (input) {
        setValue(input, '150');
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(300);
        const cv = await window.mimitale.getConversations();
        const ca = cv.conversations.find((c) => c.id === cv.activeId);
        check(
          '推断出来的范围也真的夹得住（150 → 100/100）',
          !!ca && panelValByName(ca.panel, '好感度') === '100/100',
          JSON.stringify(ca && panelValByName(ca.panel, '好感度'))
        );
      }
      // 把卡关掉，别影响下面的选项断言（它们抓的是气泡里的按钮，不冲突）
      click(charCard().querySelector('.sc-close'));
      await sleep(150);
    }
  }

  // --- 4) 选一个选项 → 当作玩家回复发出去，选项消失 ---
  // （换一批重绘过整块，选项按钮要重新抓；文字取 .opt-text，别把序号/箭头算进去）
  const beforeCount = $$('#messages .msg').length;
  const pick = $$('#messages .msg-option-btn')[0];
  const pickText = pick.querySelector('.opt-text').textContent;

  // 数字键快捷选择：选项按钮印着 1、2、3… 序号，输入框为空时按数字键直接选中
  const idxLabels = $$('#messages .msg-option-btn').map((b) => (b.querySelector('.opt-index') || {}).textContent);
  const expectedIdx = idxLabels.map((_, i) => String(i + 1)).join(',');
  check('选项按钮印着连续的数字序号（1、2、3…）', idxLabels.join(',') === expectedIdx && idxLabels.length > 0, JSON.stringify(idxLabels));

  // 输入框为空时按「1」→ 应该选中第一个选项（和上面的 pick 是同一个）
  const inputEl = byId('input');
  inputEl.value = '';
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
  await waitFor('回复完成', () => byId('btn-send').getAttribute('data-mode') === 'send', 12000);
  await sleep(300);

  // 点选项/按数字键都是「直接发送」，不该把选项文字写进输入框 —— 输入框保持原样（空）
  check('选选项后输入框没有被塞进文字', byId('input').value === '', `输入框当前值：${JSON.stringify(byId('input').value)}`);

  const userMsgs = $$('#messages .msg')
    .filter((m) => m.classList.contains('user'))
    .map((m) => m.textContent);
  check(
    '按数字键真的把对应选项当玩家回复发出去了',
    userMsgs.some((t) => t.includes(pickText)),
    JSON.stringify(userMsgs.slice(-3))
  );
  check('消息确实变多了', $$('#messages .msg').length > beforeCount, `${beforeCount} → ${$$('#messages .msg').length}`);

  // 用过就清掉、然后由**新一轮**的回复重新填上 —— 所以点完之后不该还是
  // 「刚才那一批旧选项」，而应该是新一批。这里验的是「没有把旧选项留着重复点」：
  // 点完立刻发消息，假后端会再给一批，所以只能验「选项内容仍然是干净的」。
  const convos = await window.mimitale.getConversations();
  const active = convos.conversations.find((c) => c.id === convos.activeId);
  check(
    '点完选项后选项区仍然干净（要么空、要么是新一轮给的）',
    !!active && Array.isArray(active.options) && active.options.every((t) => typeof t === 'string' && t.trim() && !t.includes('【')),
    JSON.stringify(active && active.options)
  );
  check(
    '选项按钮个数没有越堆越多（被 MAX_OPTIONS 夹住）',
    !!active && active.options.length <= 6,
    `实际 ${active && active.options.length}`
  );
  check('配置本身还在（下一轮还会给新选项）', !!active && !!active.optionsSpec && active.optionsSpec.count === 3,
    JSON.stringify(active && active.optionsSpec));
});

// ---------------------------------------------------------------------------
//  场景 21b：剧情选项的默认值与「关掉」这条路
//
//  现在剧情选项跟会话走（在「视角设置」里配），新会话默认开、每轮 4 条。
//  关掉 = 在视角设置里取消勾选，写 false（不是 null —— 读盘补默认只补 null，
//  false 是「显式关」要保留）。
// ---------------------------------------------------------------------------
await scenario('剧情选项：默认开、关掉要写 false', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const NAME = '关掉选项的角色';
  setValue('#c-name', NAME);
  await sleep(80);

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'), 8000);
  await sleep(150);
  click('#btn-close-chars');
  await sleep(150);
  const card = $$('#char-page-grid .char-card').find((c) => String(c.textContent || '').includes(NAME));
  check('角色出现在列表里', !!card);
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'), 8000);
  await sleep(300);

  // 视角设置里取消勾选 = 这一场不要剧情选项
  click('#btn-perspective');
  await waitFor('视角设置弹窗打开', () => shown('#perspective-modal'));
  check('新会话默认开着剧情选项', byId('p-options-on').checked === true, String(byId('p-options-on').checked));

  click('#p-options-on'); // 取消勾选
  await sleep(80);
  check('取消勾选后配置区收起来', !shown('#p-options-config'));
  await sleep(200);

  const convo = await activeConvo();
  check(
    '「关掉」落盘成 false（不是 null/undefined）',
    !!convo && convo.optionsSpec === false,
    JSON.stringify(convo && convo.optionsSpec)
  );
  click('#btn-close-perspective');
  await sleep(120);

  // 关掉之后发一条：这条请求不该带「【剧情选项】」指令（probeInjection 靠「存在没带选项指令的请求」来验）
  setValue('#input', '关掉剧情选项后随便说一句');
  click('#btn-send');
  await waitFor('回复完成', () => byId('btn-send').getAttribute('data-mode') === 'send', 12000);
  await sleep(200);
});

// ---------------------------------------------------------------------------
//  场景 22：身份四项的分组兜底（panelFieldGroup）
//
//  身份四项（姓名/年龄/性别/种族）现在种面板时会带上「身份」分组，但**老会话**
//  种的时候还没有分组这个概念，panelDefs 里没记 group。panelFieldGroup 负责按
//  字段名兜底，让新旧会话的分组展示和提示词注入一致。
//  纯函数，动态 import 真代码来测（同场景 20 的路数）。
// ---------------------------------------------------------------------------
await scenario('面板：分组只认 defs', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.panelFieldGroup === 'function') {
    check('panelFieldGroup 能从真模块里拿到', true);

    // 身份分组兜底已经删掉：没记 group 的字段就是没分组
    const plainConvo = {
      panelFields: ['姓名', '金币'],
      panel: { 姓名: '阿莉', 金币: '100' },
      panelDefs: { 金币: { type: 'meter', min: 0, max: 100 } }
    };
    check(
      '没记 group 的字段不兜底（返回空串）',
      mod.panelFieldGroup(plainConvo, '姓名') === '' && mod.panelFieldGroup(plainConvo, '金币') === '',
      JSON.stringify([mod.panelFieldGroup(plainConvo, '姓名'), mod.panelFieldGroup(plainConvo, '金币')])
    );
    check(
      'defs 里记过 group 的以 defs 为准',
      mod.panelFieldGroup({ panelFields: ['好感度'], panel: {}, panelDefs: { 好感度: { type: 'meter', group: '关系' } } }, '好感度') === '关系'
    );

    // panelGroupNames 也只从 defs 收集，不再凭空补「身份」
    check(
      'panelGroupNames 只收集 defs 里的组名',
      mod.panelGroupNames({
        panelFields: ['姓名', '好感度'],
        panel: { 姓名: '阿莉' },
        panelDefs: { 好感度: { type: 'meter', group: '关系' } }
      }).size === 1,
      JSON.stringify([...mod.panelGroupNames({
        panelFields: ['姓名', '好感度'],
        panel: { 姓名: '阿莉' },
        panelDefs: { 好感度: { type: 'meter', group: '关系' } }
      })])
    );
  }
});

// ---------------------------------------------------------------------------
//  场景 22b：归一化定义表不能丢掉「分组」信息
//
//  这是**真 bug 的回归测试**：normalizePanelDefs 以前把「type=text 且没有
//  范围/hint」的定义当成「没意义」直接丢掉。但「状态栏」里的时间/地点/心情
//  正是这种纯文本、没有范围/hint 的字段，它们的 group 是唯一的归属依据。
//  重启后读盘走 normalizePanelDefs，group 一丢，这几个字段就散回「未分组」。
// ---------------------------------------------------------------------------
await scenario('面板：归一化不丢分组', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.normalizePanelDefs === 'function') {
    check('normalizePanelDefs 能从真模块里拿到', true);

    // 种进去之后、写盘再读回来的形状：纯文本字段只有 type + group，没有范围/hint
    const defs = mod.normalizePanelDefs({
      时间: { type: 'text', group: '状态栏' },
      地点: { type: 'text', group: '状态栏' },
      心情: { type: 'text', group: '状态栏' },
      好感度: { type: 'meter', min: 0, max: 100, group: '关系' }
    });

    check(
      '纯文本字段的 group 被保留（时间/地点/心情都还在「状态栏」里）',
      defs['时间'] && defs['时间'].group === '状态栏' &&
        defs['地点'] && defs['地点'].group === '状态栏' &&
        defs['心情'] && defs['心情'].group === '状态栏',
      JSON.stringify(defs)
    );
    check('带范围的数值字段照常保留（含 group）', defs['好感度'] && defs['好感度'].group === '关系', JSON.stringify(defs['好感度']));

    // 反过来：确实没意义的纯文本定义（连 group 都没有）还是该丢掉
    const empty = mod.normalizePanelDefs({ 随便: { type: 'text' } });
    check('没有 group 的空定义仍然被丢掉', !('随便' in empty), JSON.stringify(empty));
  }
});

// ---------------------------------------------------------------------------
//  场景 22c：流式阶段把「当前状态」那段砍掉（不抖）+ 抬头也剥掉
//
//  这是**用户体验问题的回归测试**。面板是收尾时（syncConvoPanel）才解析赋值的，
//  所以流式过程中模型正在吐的状态栏原文还躺在正文里。以前气泡会先整块冒出
//  「【当前状态】」「—— 状态栏 ——」「【时间】：夜晚」再在收尾被剥掉，忽长忽短。
//
//  修法分两半：
//    · 流式显示用 cutTrailingStatusBlock —— 从第一个状态行起**整体截断**、只进不退，
//      半截字段行不会闪（用 cleanAssistantText 的话，半截行匹配不上正则会闪一下）。
//    · cleanAssistantText 额外剥掉「[当前状态] / 【当前状态】」抬头（收尾渲染用）。
// ---------------------------------------------------------------------------
await scenario('流式：当前状态那段在显示前就砍掉', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.cutTrailingStatusBlock === 'function') {
    // 这一局的面板字段名 —— 流式截断要靠它区分「面板字段」和「正文小标题」
    const fields = ['时间', '地点', '心情', '好感度'];

    const streamed = [
      '*她抬头看向你，眼睛闪着期待。*',
      '',
      '[当前状态]',
      '—— 状态栏 ——',
      '【时间】：夜晚',
      '【地点】：图书馆四楼',
      '【心情】：烦躁',
      '',
      '—— 关系 ——',
      '【好感度】：63/100',
      '',
      '【剧情选项】：问她要不要一起走 / 帮她还书 / 假装没看见'
    ].join('\n');

    // --- 流式显示：从状态块起整体截断，正文保留 ---
    const shown = mod.cutTrailingStatusBlock(streamed, fields);
    check('流式显示只剩正文（动作描写还在）', shown.includes('她抬头看向你'), shown);
    check(
      '状态块整个被砍掉（抬头/分组/字段/选项都不在）',
      !shown.includes('当前状态') && !shown.includes('—— 状态栏 ——') &&
        !shown.includes('【时间】') && !shown.includes('【好感度】') && !shown.includes('剧情选项'),
      shown
    );

    // --- 半截字段行也不该闪：只要行首是【，哪怕还没写到冒号，也照样被砍 ---
    const partial = mod.cutTrailingStatusBlock('*正文*\n\n【时间】：夜', fields);
    check('半截字段行（【时间】：夜）也被砍掉，不会闪一下', partial.trim() === '*正文*', JSON.stringify(partial));

    // --- 回归：内心描写 / 上帝视角的【心理】【旁白】是正文小标题，不能被当状态块砍掉 ---
    // 真 bug：以前只看「行首是【】」就砍，这几段在整个流式过程中都不显示，
    // 直到最后重绘才一次性蹦出来。
    const narrated = [
      '她抬头看你。',
      '',
      '【心理】',
      '其实她很想留下。',
      '',
      '【旁白】',
      '雨还在下。'
    ].join('\n');
    const narratedShown = mod.cutTrailingStatusBlock(narrated, fields);
    check(
      '【心理】/【旁白】这种正文小标题不被砍掉',
      narratedShown.includes('其实她很想留下') && narratedShown.includes('雨还在下'),
      JSON.stringify(narratedShown)
    );

    // --- 回归：带冒号的正文小标题也不能砍 ---
    // 【心理】：她其实… 和「【字段名】：值」的形状一模一样，光看冒号会把整段吞掉。
    const narratedColon = [
      '她低头笑了一下。',
      '',
      '【心理】：她其实很想留下来。',
      '',
      '【旁白】：雨还在下。'
    ].join('\n');
    const colonShown = mod.cutTrailingStatusBlock(narratedColon, fields);
    check(
      '【心理】：/【旁白】：带冒号的正文小标题也不被砍掉',
      colonShown.includes('她其实很想留下来') && colonShown.includes('雨还在下'),
      JSON.stringify(colonShown)
    );

    // --- 回归：中文对话里破折号起头的行是正文，不是分组标题 ---
    // 真 bug：以前只要行首是「——」就整体截断，这种对话行之后的整段回复
    // 在流式期间都不显示，直到收尾重绘才蹦出来。
    const dashed = [
      '*她愣了一下。*',
      '',
      '——等等，你说什么？',
      '',
      '她把手里的书合上了。'
    ].join('\n');
    const dashShown = mod.cutTrailingStatusBlock(dashed, fields, ['状态栏', '关系']);
    check(
      '破折号起头的对话行不被砍掉',
      dashShown.includes('——等等，你说什么？') && dashShown.includes('她把手里的书合上了'),
      JSON.stringify(dashShown)
    );

    // 反向：**已知分组**的小标题仍然要砍（否则状态块会漏到气泡上）
    const groupHeader = ['*正文。*', '', '—— 关系 ——', '【好感度】：63/100'].join('\n');
    const groupShown = mod.cutTrailingStatusBlock(groupHeader, fields, ['状态栏', '关系']);
    check(
      '已知分组的「—— 关系 ——」仍然被砍掉',
      groupShown.includes('*正文。*') && !groupShown.includes('关系'),
      JSON.stringify(groupShown)
    );
    // 流式阶段收尾那个「——」还没到达：半截标题也该砍
    const halfGroup = mod.cutTrailingStatusBlock('*正文。*\n\n—— 关', fields, ['状态栏', '关系']);
    check('半截分组标题（—— 关）也砍，不会闪一下', halfGroup.trim() === '*正文。*', JSON.stringify(halfGroup));
    // 没传分组名时一律当正文（宁可多显示，也不误砍）
    const noGroups = mod.cutTrailingStatusBlock('*正文。*\n\n—— 关系 ——\n', fields);
    check('没传分组名时不砍破折号行（宁可多显示）', noGroups.includes('—— 关系 ——'), JSON.stringify(noGroups));

    // --- 收尾渲染：cleanAssistantText 也要剥掉抬头 ---
    const groups = ['状态栏', '关系'];
    const final = mod.cleanAssistantText(streamed, fields, groups);
    check('收尾渲染只剩正文', final.includes('她抬头看向你'), final);
    check(
      '抬头「[当前状态]」被剥掉',
      !final.includes('当前状态') && !final.includes('[当前状态]') && !final.includes('【当前状态】'),
      final
    );
    check(
      '字段行 / 分组小标题 / 剧情选项都被剥掉',
      !final.includes('【时间】') && !final.includes('—— 关系 ——') && !final.includes('剧情选项'),
      final
    );

    // --- 继续（continue）场景：base + delta 的组合，别把夹在中间的正文误砍 ---
    // 继续时 assistant.content 已经躺着上一轮的状态块，onChunk 里是
    // `base(cleanAssistantText 剥旧状态块) + cutTrailingStatusBlock(本轮 delta)`。
    // 这里模拟两次继续后的原文：两个旧状态块之间夹着正文，必须都保住。
    const continuedBefore = [
      '*第一轮正文。*',
      '',
      '[当前状态]',
      '【时间】：夜晚',
      '',
      '*继续后的正文。*',
      '',
      '[当前状态]',
      '【时间】：深夜'
    ].join('\n');
    const base = mod.cleanAssistantText(continuedBefore, fields, groups);
    const delta = '\n\n*再继续的正文。*\n\n【时间】：凌晨';
    const composed = base + mod.cutTrailingStatusBlock(delta, fields);
    check(
      '继续时旧状态块被剥掉、夹在中间的正文都保住、本轮状态块被砍',
      composed.includes('第一轮正文') && composed.includes('继续后的正文') &&
        composed.includes('再继续的正文') && !composed.includes('当前状态') && !composed.includes('【时间】'),
      composed
    );
  }
});

// ---------------------------------------------------------------------------
//  场景 22b：【心理】/【旁白】**单独占一行**也要认（渲染层）
//
//  模型最常见的写法是「标记单独一行、内容写在下一段」（它把标记当成小标题）：
//
//      【心理】
//      苏晴：这人原来有学长带。
//
//  而 ui/markdown.js 原来只认同行写法（`【心理】内容`），于是标记行匹配上
//  「标记 + 空内容」→ 渲染出一个**空的** `<p class="msg-inner">`，真正的内容
//  成了普通段落。用户看到的就是「选了内心描写 / 上帝视角，心理旁白一点样式都没有」
//  —— 也就是他报的「叙述模式依旧无效」（2026-10-08，拿真实回复来报的）。
//
//  下面那两段原文就是从用户 data/conversations.json 里抄出来的真实形状。
// ---------------------------------------------------------------------------
await scenario('叙述：心理/旁白标记单独一行也要认', async () => {
  let md = null;
  try {
    md = await import(new URL('js/ui/markdown.js', document.baseURI).href);
  } catch (err) {
    check('markdown 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!md || typeof md.renderMarkdown !== 'function') return;

  // --- 1) 真实形状：标记单独一行，内容在下一段（中间没有空行）---
  const separate = [
    '苏晴把钥匙翻过来看了眼标签，又翻回去。',
    '',
    '【心理】',
    '苏晴：这人原来有学长带。那也好，箱子的事有人管了。',
    '',
    '【旁白】',
    '图书馆门口正对着一条下坡路，通向东边的宿舍区。'
  ].join('\n');
  const html = md.renderMarkdown(separate);

  check(
    '标记单独一行：心理那段被包进 msg-inner，且**有内容**',
    /<p class="msg-inner">苏晴：这人原来有学长带/.test(html),
    html.slice(html.indexOf('msg-inner') - 20, html.indexOf('msg-inner') + 80)
  );
  check(
    '标记单独一行：旁白那段被包进 msg-aside，且有内容',
    /<p class="msg-aside">图书馆门口正对着一条下坡路/.test(html),
    html.slice(html.indexOf('msg-aside') - 20, html.indexOf('msg-aside') + 80)
  );
  check(
    '不能再出现空的 msg-inner / msg-aside 块',
    !/class="msg-(inner|aside)"><\/p>/.test(html),
    html.match(/class="msg-(inner|aside)">[^<]{0,20}/g)
  );
  check(
    '标记本身不显示出来',
    !html.includes('【心理】') && !html.includes('【旁白】'),
    html
  );

  // --- 2) 标记和内容之间隔了空行，同样要认 ---
  const spaced = ['【心理】', '', '', '她在心里叹了口气。'].join('\n');
  const spacedHtml = md.renderMarkdown(spaced);
  check(
    '标记与内容之间有空行也认',
    /<p class="msg-inner">她在心里叹了口气。<\/p>/.test(spacedHtml),
    spacedHtml
  );

  // --- 3) 同行写法（老形状）不能被这次改动弄坏 ---
  const inline = md.renderMarkdown('【心理】其实她很想留下。\n\n【旁白】雨还在下。');
  check(
    '同行写法照旧（【心理】内容）',
    /<p class="msg-inner">其实她很想留下。<\/p>/.test(inline) &&
      /<p class="msg-aside">雨还在下。<\/p>/.test(inline),
    inline
  );

  // --- 4) 模型忘了写内容（标记吊在整篇末尾）：不能留一个空块占位置 ---
  const empty = md.renderMarkdown('正文一段。\n\n【心理】');
  check(
    '标记吊在末尾、后面没内容 → 不留空块',
    !/class="msg-(inner|aside)"/.test(empty) && empty.includes('正文一段'),
    empty
  );
});

// ---------------------------------------------------------------------------
//  场景 23：正文剥分组小标题（—— 身份 —— / —— 状态栏 ——）
//
//  模型照着注入的格式输出状态栏时，会把「—— 组名 ——」小标题也一起抄进正文。
//  字段行被剥掉后，这些孤零零的分组标题就漏在气泡里。cleanAssistantText 要能
//  把它们一并剥掉，且不能误删正文里「—— 他顿了顿 ——」这种破折号引语。
// ---------------------------------------------------------------------------
await scenario('正文：分组小标题也要剥掉', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (!mod || typeof mod.cleanAssistantText !== 'function') return;

  const text = [
    '*她抬头看向你，眼睛里闪着期待的光。*',
    '',
    '—— 身份 ——',
    '【姓名】：莉莉娅',
    '【年龄】：18',
    '',
    '—— 状态栏 ——',
    '【时间】：夜晚',
    '【地点】：主人的家',
    '',
    '—— 关系 ——',
    '【好感度】：40/100',
    '',
    '「主人，今晚想聊点什么？」'
  ].join('\n');

  const fields = ['姓名', '年龄', '时间', '地点', '好感度'];
  const groups = ['身份', '状态栏', '关系'];

  const cleaned = mod.cleanAssistantText(text, fields, groups);

  check(
    '分组小标题被剥掉了（身份/状态栏/关系都不在）',
    !cleaned.includes('—— 身份 ——') && !cleaned.includes('—— 状态栏 ——') && !cleaned.includes('—— 关系 ——'),
    cleaned
  );
  check('字段行也被剥掉了', !cleaned.includes('【姓名】') && !cleaned.includes('【好感度】'), cleaned);
  check('正文（动作描写 + 台词）完好保留', cleaned.includes('她抬头看向你') && cleaned.includes('今晚想聊点什么'), cleaned);

  // 破折号引语不该被误删：组名不在 knownGroups 里
  const prose = ['他顿了顿，说：', '—— 我有点累了 ——', '然后就走了。'].join('\n');
  const proseCleaned = mod.cleanAssistantText(prose, [], ['身份']);
  check('正文里「—— 破折号引语 ——」不被误删', proseCleaned.includes('—— 我有点累了 ——'), proseCleaned);

  // 没传分组名时，标题保留原样（向后兼容，不会乱删）
  const noGroups = mod.cleanAssistantText(text, fields);
  check('不传分组名时不误删标题（保持旧行为）', noGroups.includes('—— 身份 ——'), noGroups);

  // 模型会在状态块最前面加一行 `【状态栏】`（第一个分组名套方括号当块标题），
  // 不是字段行、不是 `—— 组名 ——`、也不是 `【当前状态】`，需要单独剥。
  const real = [
    '她扶着门框，僵在原地，没敢回头。',
    '',
    '【状态栏】',
    '—— 状态栏 ——',
    '【露西诺·时间】：深夜',
    '【露西诺·地点】：迷夜酒馆·二楼走廊',
    '',
    '—— 穿着 ——',
    '【露西诺·披风】：已解下（搭在椅背上）',
  ].join('\n');
  const realCleaned = mod.cleanAssistantText(
    real,
    ['露西诺·时间', '露西诺·地点', '露西诺·披风'],
    ['状态栏', '穿着']
  );
  check('模型自加的「【状态栏】」标题被剥掉', !realCleaned.includes('【状态栏】'), realCleaned);
  check('「—— 状态栏 ——」小标题也剥掉', !realCleaned.includes('—— 状态栏 ——'), realCleaned);
  check('字段行照旧剥掉', !realCleaned.includes('【露西诺·时间】'), realCleaned);
  check('正文完好保留', realCleaned.includes('她扶着门框，僵在原地'), realCleaned);

  // 正文里恰好整行是「【不是组名的东西】」的，不能误删
  const quote = ['她指了指门牌。', '【迷夜酒馆·休息室】', '门牌上这么写着。'].join('\n');
  const quoteCleaned = mod.cleanAssistantText(quote, [], ['状态栏']);
  check('正文里「【非组名】」整行引用不被误删', quoteCleaned.includes('【迷夜酒馆·休息室】'), quoteCleaned);
});

// ---------------------------------------------------------------------------
//  场景 24：选项解析容忍「字母标签」
//
//  模型有时把格式示例当成要求，输出「A / 选项一 / B / 选项二 …」——
//  拆出来就是一堆孤立单字母按钮。extractOptionsFromText 要：
//  丢掉孤立字母、剥掉「A. 」前缀，内容原样保留；真选项里的多字组合不受影响。
// ---------------------------------------------------------------------------
await scenario('选项：字母标签容错', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/suggestions.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('suggestions 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (!mod || typeof mod.extractOptionsFromText !== 'function') return;

  // 截图里的实际形状：字母标签和内容交替，全在一行用「 / 」隔开
  const labeled = mod.extractOptionsFromText(
    '【剧情选项】：A / 推门进去，问她今晚打烊前还有没有空位 / B / 在吧台坐下，点一杯麦酒顺便打听镇上的传闻 / C / 把几个铜板放在桌上，预订二楼的房间'
  );
  check(
    '孤立字母标签被丢掉，只剩 3 条真选项',
    labeled.length === 3 &&
      labeled[0] === '推门进去，问她今晚打烊前还有没有空位' &&
      labeled[1] === '在吧台坐下，点一杯麦酒顺便打听镇上的传闻' &&
      labeled[2] === '把几个铜板放在桌上，预订二楼的房间',
    JSON.stringify(labeled)
  );

  // 标签贴在内容前面（A. 内容）也要剥掉
  const prefixed = mod.extractOptionsFromText('【剧情选项】：A. 走过去抱住她 / B、退后一步观察 / C: 转身离开');
  check(
    '「A. 」「A、」「A: 」前缀被剥掉',
    prefixed.join('|') === '走过去抱住她|退后一步观察|转身离开',
    JSON.stringify(prefixed)
  );

  // 真选项里的多字组合（OK / B超）不能被误伤
  const real = mod.extractOptionsFromText('【剧情选项】：打开 B超报告给她看 / 说 OK 然后走人');
  check('多字组合（B超/OK）不被当成标签', real.join('|') === '打开 B超报告给她看|说 OK 然后走人', JSON.stringify(real));

  // 模型把示例整个照抄（全是字母）→ 没有可用选项 → 空数组（保持上一轮的）
  const placeholder = mod.extractOptionsFromText('【剧情选项】：A / B / C');
  check('全是占位字母时返回空（保持上一轮选项）', placeholder.length === 0, JSON.stringify(placeholder));
});

// ---------------------------------------------------------------------------
//  场景 25：普通回复的选项指令也要「避开上一批」
//
//  用户反馈：剧情选项「卡住」，同一批 3 个选项连着出现好几次，但「换一批」回来的
//  是对的。根因是「换一批」的指令里显式要求避开上一批，普通回复的 optionsInstruction
//  没有 —— 局面没怎么变时模型会原地打转，一遍遍给同样的选项。这里锁住这个修复。
// ---------------------------------------------------------------------------
await scenario('选项：普通回复也要避开上一批', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/suggestions.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('suggestions 模块能动态加载', false, (err && err.message) || String(err));
  }

  if (mod && typeof mod.optionsInstruction === 'function') {
    const convo = {
      optionsSpec: { count: 3, hint: '' },
      options: ['先喝汤，别接她这句话', '说上次是觉得她只切一小块太亏了', '把煎蛋夹到她碗里，一句话不说']
    };
    const text = mod.optionsInstruction(convo);
    check(
      '上一轮有选项时，指令里要求避开它们',
      text.includes('上一轮已经给过') && text.includes('先喝汤，别接她这句话') && text.includes('不要重复上一轮的'),
      text
    );

    const empty = mod.optionsInstruction({ optionsSpec: { count: 3, hint: '' }, options: [] });
    check('上一轮没有选项时不画蛇添足', !empty.includes('上一轮已经给过'), empty);

    const none = mod.optionsInstruction({ optionsSpec: null, options: [] });
    check('没开剧情选项时不注入', none === '', JSON.stringify(none));

    // 「帮我想想」和「换一批」现在是同一条指令，靠「手上有没有上一批」自动切口径。
    if (typeof mod.optionsRequestInstruction === 'function') {
      const withPrev = mod.optionsRequestInstruction({
        optionsSpec: { count: 3, hint: '' },
        options: ['先喝汤，别接她这句话']
      });
      check(
        '手动要一批：有上一批时走「换一批」口径',
        withPrev.includes('【换一批剧情选项】') && withPrev.includes('先喝汤，别接她这句话'),
        withPrev
      );

      const noPrev = mod.optionsRequestInstruction({ optionsSpec: { count: 3, hint: '' }, options: [] });
      check(
        '手动要一批：没有上一批时走「补一批」口径',
        noPrev.includes('【补一批剧情选项】') && !noPrev.includes('上一轮已经给过') && !noPrev.includes('换掉'),
        noPrev
      );

      const plain = mod.optionsRequestInstruction({ optionsSpec: null, options: [] });
      check(
        '手动要一批：纯聊天也给默认 4 条（卡上关了选项同理）',
        plain.includes('给出 4 个选项'),
        plain
      );
    } else {
      check('suggestions 模块导出了 optionsRequestInstruction', false);
    }
  }
});

// ---------------------------------------------------------------------------
//  场景 26：状态卡（点「我」的头像 / 面板栏头像打开）
//
//  这张卡是「查看别人的状态」的入口：默认**只读**（纯文本展示），点「编辑」才
//  把值变成输入框。覆盖：聊天里点「我」的头像能开、面板栏的头像行、
//  只读↔编辑切换、改值落盘、加字段 / 删字段。
// ---------------------------------------------------------------------------
await scenario('状态卡：点头像查看与编辑', async () => {
  const worldItem = $$('#convo-list .convo-item').find((it) => {
    const t = it.querySelector('.convo-title');
    return t && t.textContent.trim() === '冒烟测试世界';
  });
  check('找到「冒烟测试世界」会话', !!worldItem);
  if (worldItem) click(worldItem);
  await waitFor('切到世界会话', () => shown('#view-chat'));
  await sleep(300);

  const myCard = () => $('#state-cards .state-card[data-owner="player"]');

  // --- 聊天里点「我」的头像 → 开我的状态卡 ---
  const myAvatar = $$('#messages .msg.user .msg-avatar')[0];
  check('用户消息的头像挂上了「可点」标记', !!myAvatar && myAvatar.classList.contains('clickable'));
  if (myAvatar) click(myAvatar);
  await waitFor('我的状态卡出现', () => !!myCard());

  check(
    '卡片默认是只读的（值是文本，没有输入框）',
    $$('#state-cards .state-card[data-owner="player"] .sc-value').length > 0 &&
      $$('#state-cards .state-card[data-owner="player"] .sc-input').length === 0,
    JSON.stringify({ 值: $$('#state-cards .state-card[data-owner="player"] .sc-value').length, 输入框: $$('#state-cards .state-card[data-owner="player"] .sc-input').length })
  );
  check(
    '卡里有玩家角色卡种下的属性',
    $$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '金币'),
    JSON.stringify($$('#state-cards .state-card[data-owner="player"] .sc-name').map((n) => n.textContent))
  );

  // --- 点「编辑」→ 值变成输入框 ---
  click(myCard().querySelector('.sc-edit'));
  await waitFor('编辑态出现输入框', () => $$('#state-cards .state-card[data-owner="player"] .sc-input').length > 0);
  check('编辑态下按钮变成「完成」', myCard().querySelector('.sc-edit').textContent.trim() === '完成', myCard().querySelector('.sc-edit').textContent);

  // --- 改一个值 → 落到会话面板上 ---
  const coinRow = $$('#state-cards .state-card[data-owner="player"] .sc-row').find(
    (r) => r.querySelector('.sc-name').textContent === '金币'
  );
  const coinInput = coinRow.querySelector('.sc-input');
  setValue(coinInput, '19');
  coinInput.dispatchEvent(new Event('blur', { bubbles: true }));
  await sleep(300);
  let cv = await window.mimitale.getConversations();
  let wc = cv.conversations.find((c) => c.title === '冒烟测试世界');
  check('卡片里改的值落到了会话面板上', !!wc && wc.panel && panelValByName(wc.panel, '金币') === '19', wc ? String(panelValByName(wc.panel, '金币')) : 'null');

  // --- 加一个字段 ---
  setValue($('#state-cards .state-card[data-owner="player"] .sc-new'), '心情');
  click($('#state-cards .state-card[data-owner="player"] .sc-add-btn'));
  await waitFor('新字段出现', () =>
    $$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '心情')
  );
  await sleep(200);
  cv = await window.mimitale.getConversations();
  wc = cv.conversations.find((c) => c.title === '冒烟测试世界');
  check(
    '新字段归到玩家名下（owner=player）',
    !!wc && panelDefByName(wc.panelDefs, '心情') && panelDefByName(wc.panelDefs, '心情').owner === 'player',
    JSON.stringify(wc && panelDefByName(wc.panelDefs, '心情'))
  );

  // --- 删掉它 ---
  const moodRow = $$('#state-cards .state-card[data-owner="player"] .sc-row').find(
    (r) => r.querySelector('.sc-name').textContent === '心情'
  );
  check('新字段行里有删除按钮', !!moodRow && !!moodRow.querySelector('.sc-del'));
  click(moodRow.querySelector('.sc-del'));
  await sleep(250);
  check(
    '删掉之后卡里就没了',
    !$$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '心情'),
    JSON.stringify($$('#state-cards .state-card[data-owner="player"] .sc-name').map((n) => n.textContent))
  );

  // --- 入口条：我（+ 角色）的头像都在，点角色头像开那张卡 ---
  const castOwners = $$('#panel-cast .panel-avatar').map((b) => b.dataset.owner);
  check('入口条上第一个头像是「我」', castOwners[0] === 'player', JSON.stringify(castOwners));

  // --- ✕ 收掉我那张卡 ---
  click(myCard().querySelector('.sc-close'));
  await sleep(150);
  check('点 ✕ 把卡收掉了', !myCard());

  // --- 绑了角色的会话：头像行只有那个角色（普通聊天不显示「我」），点它开卡 ---
  const charConvo = $$('#convo-list .convo-item').find((it) => {
    const t = it.querySelector('.convo-title');
    return t && t.textContent.trim().startsWith('选项测试');
  });
  if (charConvo) {
    click(charConvo);
    await sleep(400);
    const owners = $$('#panel-cast .panel-avatar').map((b) => b.dataset.owner);
    check(
      '绑了角色的会话里入口条只有那个角色（没有「我」）',
      !owners.includes('player') && owners.length === 1,
      JSON.stringify(owners)
    );

    const charBtn = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
    if (charBtn) {
      const charOwner = charBtn.dataset.owner;
      const charCard = () => $(`#state-cards .state-card[data-owner="${CSS.escape(charOwner)}"]`);
      click(charBtn);
      await waitFor('角色状态卡出现', () => !!charCard());
      check('点角色头像能开那个角色的卡', !!charCard());
      check('角色卡里也有字段', $$(`#state-cards .state-card[data-owner="${CSS.escape(charOwner)}"] .sc-name`).length > 0);
      click(charCard().querySelector('.sc-close'));
      await sleep(150);
    }

    // --- 玩家卡里加一个「角色已经占了」的名字 → 提示要说清是谁占的 ---
    // 字段名全局唯一（面板注入给模型的是「【名字】：值」，同名模型分不出是谁的），
    // 所以单角色聊天里「姓名/性别」这类名字是加不进玩家卡的。
    // ⚠️ 以前这里只查「整张面板有没有这个名字」，于是玩家卡明明没有也会报
    //    「已经有了」—— 用户会懵（「我没加啊」）。现在必须说清是**角色**占了。
    // 普通聊天的入口条没有「我」（2026-10-08），玩家卡从自己消息的头像开。
    const myMsgAvatar = $$('#messages .msg.user .msg-avatar').pop();
    if (myMsgAvatar) {
      click(myMsgAvatar);
      await waitFor('我的状态卡从自己消息的头像打开', () => !!$('#state-cards .state-card[data-owner="player"]'));
      click($('#state-cards .state-card[data-owner="player"] .sc-edit'));
      await sleep(250);

      setValue($('#state-cards .state-card[data-owner="player"] .sc-new'), '姓名');
      click($('#state-cards .state-card[data-owner="player"] .sc-add-btn'));
      await sleep(150);
      const toast = byId('toast');
      check(
        '加角色已占用的名字时，提示说的是「角色那边占了」而不是干巴巴的「已经有了」',
        !!toast && toast.textContent.includes('角色那边占了') && toast.textContent.includes('我的姓名'),
        toast ? toast.textContent : '(没有提示)'
      );
      check(
        '同名字段确实没有被加进去',
        !$$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '姓名'),
        JSON.stringify($$('#state-cards .state-card[data-owner="player"] .sc-name').map((n) => n.textContent))
      );

      // 按提示换个不冲突的名字就能加上
      setValue($('#state-cards .state-card[data-owner="player"] .sc-new'), '我的姓名');
      click($('#state-cards .state-card[data-owner="player"] .sc-add-btn'));
      await waitFor(
        '换个名字就加上了',
        () => $$('#state-cards .state-card[data-owner="player"] .sc-name').some((n) => n.textContent === '我的姓名')
      );
      check('换个名字就能加成（提示给的活路走得通）', true);
    }
  }
});

// ---------------------------------------------------------------------------
//  场景 26：改了一半关掉 —— 草稿不能粘到下一次
//
//  书名 / 开场白 / 条目都是「保存后才生效」的草稿。关编辑器时草稿整份丢掉，
//  再进来必须按**落盘那份**回填，不能拿着上一次没保存的输入。
// ---------------------------------------------------------------------------
await scenario('世界书：改一半关掉不残留草稿', async () => {
  const diskNames = async () => (await savedWorldbooks()).map((b) => b.name);

  // 打开种子那本，改名「甲书」—— 故意不保存
  await openWorldbookEditor('冒烟测试世界');
  await sleep(150);
  setValue('#wb-name', '甲书');
  await sleep(200);
  check('书名已经改成「甲书」', $('#wb-name').value === '甲书', `输入框里是「${$('#wb-name').value}」`);
  check('没保存之前磁盘上还没改名', !(await diskNames()).includes('甲书'), JSON.stringify(await diskNames()));

  // 关掉（有脏草稿会先问一句），再进来：草稿不能粘到下一次
  click('#btn-close-worldbooks');
  await waitFor('弹放弃确认框', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('编辑器关闭', () => !shown('#view-wb-editor'));

  await openWorldbookEditor('冒烟测试世界');
  await sleep(150);
  check(
    '重开时输入框是落盘过的名字（草稿没残留）',
    $('#wb-name').value === '冒烟测试世界',
    `输入框里是「${$('#wb-name').value}」`
  );

  // 这一回真的改名并保存，才算数
  setValue('#wb-name', '甲书');
  await sleep(120);
  click('#btn-save-wb');
  await sleep(350);
  check('点保存之后才落盘', (await diskNames()).includes('甲书'), JSON.stringify(await diskNames()));

  // 改回原名 —— 后面的场景都按「冒烟测试世界」找书
  setValue('#wb-name', '冒烟测试世界');
  await sleep(120);
  click('#btn-save-wb');
  await sleep(350);
  check('名字改回去了', (await diskNames()).includes('冒烟测试世界'), JSON.stringify(await diskNames()));

  click('#btn-close-worldbooks');
  await waitFor('编辑器关闭', () => !shown('#view-wb-editor'));
});

// ---------------------------------------------------------------------------
//  场景 26b：删掉一本书
//
//  列表页卡片没了，删除只剩编辑器里那颗「删除本书」。危险部分靠确认框兜 ——
//  框里会把条目数 / 角色副本数 / 被几个会话用着都摆出来。
//  顺带把「角色编辑器 → ＋ 新建」（建书 + 自动绑定 + 直接进编辑器）走一遍。
// ---------------------------------------------------------------------------
await scenario('世界书：删除本书', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('打开角色编辑器', () => shown('#view-char-editor'));
  click('#char-section-tab-worldbook');
  await waitFor('切到世界书分区', () => !byId('char-section-worldbook').hidden);
  click('#c-wb-new-btn');
  await waitFor('新书直接进编辑器', () => shown('#view-wb-editor'));
  check('新书一出场就绑在这张卡上', $$('#c-wb-list .cwb-row').length >= 1);

  setValue('#wb-name', '待删的临时世界');
  click('#btn-save-wb');
  await sleep(350);
  check('新书落盘了', (await savedWorldbooks()).some((b) => b.name === '待删的临时世界'));

  click('#btn-del-worldbook');
  await waitFor('删除先弹确认框', () => shown('#confirm-modal'));
  check('确认框里点明了删的是哪本',
    byId('confirm-message').textContent.includes('待删的临时世界'), byId('confirm-message').textContent);
  click('#confirm-ok');
  await sleep(350);

  const after = (await savedWorldbooks()).map((b) => b.name);
  check('书从磁盘上没了', !after.includes('待删的临时世界'), JSON.stringify(after));

  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#view-wb-editor'));
});

// ---------------------------------------------------------------------------
//  场景 26d：角色卡片、工具条，以及两个编辑器页头同高
//
//  卡片结构钉两件事：名字在封面**下方**（不压在图里）、封面里挂的是头像。
//  工具条钉搜索 + 计数 + 「没有匹配的角色」空态。
// ---------------------------------------------------------------------------
await scenario('角色卡：卡片、工具条与页头高度', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  check('角色卡有搜索工具条', !!$('#char-page-search') && !!$('#char-page-count'));

  const charCard = $('#char-page-grid .char-card');
  check('角色卡的结构是「封面 → 名字」', !!charCard &&
    !!charCard.querySelector('.wb-card-cover .char-card-avatar') &&
    !!charCard.querySelector('.char-card-name'));
  if (charCard) {
    const cover = charCard.querySelector('.wb-card-cover').getBoundingClientRect();
    const name = charCard.querySelector('.char-card-name').getBoundingClientRect();
    check('角色名字在封面下方（不是压在图上）', name.top >= cover.bottom - 1,
      `封面底 ${Math.round(cover.bottom)} / 名字顶 ${Math.round(name.top)}`);
  }

  const allChars = $$('#char-page-grid .char-card').length;
  const firstName = charCard && charCard.querySelector('.char-card-name').textContent;
  if (firstName) {
    setValue('#char-page-search', firstName);
    await sleep(140);
    check('搜索按名字筛掉了不匹配的角色', $$('#char-page-grid .char-card').length < allChars,
      `筛后 ${$$('#char-page-grid .char-card').length} / 全部 ${allChars}`);
    check('计数写的是「匹配 / 总数」', /^\d+ \/ \d+ 个角色$/.test($('#char-page-count').textContent),
      $('#char-page-count').textContent);
  }
  setValue('#char-page-search', '这个关键词肯定没有角色会用');
  await sleep(140);
  check('搜不到时的空态是「没有匹配的角色」',
    $('#char-page-empty').textContent.includes('没有匹配的角色'),
    $('#char-page-empty').textContent.trim());
  setValue('#char-page-search', '');
  await sleep(140);
  check('清空搜索后角色卡片都回来', $$('#char-page-grid .char-card').length === allChars,
    `${$$('#char-page-grid .char-card').length} / ${allChars}`);

  // 角色编辑页的「全文 N 字」：数字来自五个写作栏 + 高级设置三栏，别再漏一处
  click('#btn-chars');
  await waitFor('回到角色卡', () => shown('#view-chars'));
  click(buttonByText($$('#char-page-grid .char-card')[0], '编辑'));
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  const total = ['c-desc', 'c-personality', 'c-scenario', 'c-first', 'c-example', 'c-system', 'c-post', 'c-notes']
    .reduce((sum, id) => sum + String(byId(id)?.value || '').length, 0);
  check('角色页头显示全文 N 字，且和表单实际字数一致',
    byId('char-total-words').textContent === `全文 ${total.toLocaleString()} 字`,
    `${byId('char-total-words').textContent} / 实际 ${total}`);
  const charHeadHeight = Math.round($('#view-char-editor .page-head').getBoundingClientRect().height);

  click('#btn-close-chars');
  await waitFor('回到角色卡（收尾）', () => shown('#view-chars'));

  // 两个编辑器的页头同高：角色页原来是三行（78px），世界书是一行（56px）
  await openWorldbookEditor('冒烟测试世界');
  const wbHeadHeight = Math.round($('#view-wb-editor .page-head').getBoundingClientRect().height);
  check('两个编辑器的页头同高', Math.abs(charHeadHeight - wbHeadHeight) <= 2,
    `角色 ${charHeadHeight}px / 世界书 ${wbHeadHeight}px`);
  click('#btn-close-worldbooks');
  await waitFor('世界书编辑器关闭（收尾）', () => !shown('#view-wb-editor'));
});

// ---------------------------------------------------------------------------
//  场景 27：世界书里多个角色有同名字段时，各自保留、不互相挤掉。
//  修复：面板字段身份升级成「字段名 + owner」复合键，同名但归属不同的字段各自独立。
// ---------------------------------------------------------------------------
await scenario('面板：同名属性按 owner 各自保留', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.appendPanelFields !== 'function') {
    check('panel 模块能动态加载', false);
    return;
  }
  check('panel 模块能动态加载', true);

  // 造一个空会话，两个角色：姐姐（id=sis）和妹妹（id=young）都有「好感度」
  const convo = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };

  mod.seedPanelFromCharacters(
    convo,
    [{ id: 'sis', name: '姐姐', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '5/100' }] }],
    'sis'
  );
  mod.seedPanelFromCharacters(
    convo,
    [{ id: 'young', name: '妹妹', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '80/100' }] }],
    'young'
  );

  check(
    '两个角色的同名「好感度」各自种进去（两条，不是被挤成一条）',
    convo.panelFields.length === 2,
    JSON.stringify(convo.panelFields)
  );
  check(
    '按 owner 能拆开两个「好感度」',
    convo.panelFields.filter((k) => mod.panelFieldOwner(convo, k) === 'sis').length === 1 &&
      convo.panelFields.filter((k) => mod.panelFieldOwner(convo, k) === 'young').length === 1,
    JSON.stringify(convo.panelFields.map((k) => [k, mod.panelFieldOwner(convo, k)]))
  );
  check(
    '姐姐的好感度值没被妹妹盖掉',
    convo.panelFields.some((k) => mod.panelFieldOwner(convo, k) === 'sis' && convo.panel[k] === '5/100'),
    JSON.stringify(convo.panel)
  );

  // 注入提示词：同名字段有冲突 → 加「角色名·」前缀；无冲突字段保持纯名
  const withPlayer = { ...convo, player: { name: '我' } };
  // 妹妹再加一个独有字段，验证「无冲突不加前缀」
  mod.seedPanelFromCharacters(
    withPlayer,
    [{ id: 'young', name: '妹妹', attributes: [{ name: '铜板', type: 'meter', min: 0, max: 100, value: '3/100' }] }],
    'young'
  );
  const prompt = mod.formatPanelForPrompt(withPlayer);
  // 这里 owner 用的是假 id（sis/young，不在角色卡/世界书里），panelOwnerLabel
  // 查不到角色名时退回 id 本身作前缀 —— 真实场景里 owner 是世界书副本 id，
  // 能查到角色名。断言按「前缀 = 归属 id」来验冲突确实加了前缀。
  check('注入里同名「好感度」带归属前缀区分', prompt.includes('sis·好感度') && prompt.includes('young·好感度'), prompt);
  check('注入里无冲突的「铜板」保持纯字段名（不带前缀）', prompt.includes('【铜板】') && !prompt.includes('young·铜板'), prompt);

  // 描述（hint）里的 {{user}} 要展开成玩家名再注入。原样注入的话模型会看见
  // 占位符本身，然后开始猜它指谁。
  const hintConvo = {
    panel: {},
    panelFields: [],
    panelDefs: {},
    messages: [],
    player: { name: '测试者甲' }
  };
  mod.seedPanelFromCharacters(
    hintConvo,
    [
      {
        id: 'other',
        name: '对方',
        attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '0/100', hint: '对{{user}}的信赖与在意' }]
      }
    ],
    'other'
  );
  const hintPrompt = mod.formatPanelForPrompt(hintConvo);
  check(
    '字段描述里的 {{user}} 展开成玩家名，不再原样注入',
    !hintPrompt.includes('{{user}}') && hintPrompt.includes('对测试者甲的信赖与在意'),
    hintPrompt
  );

  // 模型照抄前缀（「前缀妹妹·好感度」）时要拆回给原来的 owner，不能新建一个
  // 名字里带前缀的重复字段。同名字段开始带前缀之后这条路径才第一次被走到 ——
  // 角色卡里的卡按名字反查以前是查不到的（characterById 是按 id 查的）。
  // 卡临时塞进内存 state（不走保存：那条路绕开渲染层，列表不会刷新）。
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const backupChars = stateMod.state.characters;
  stateMod.state.characters = [
    ...(Array.isArray(backupChars) ? backupChars : []),
    { id: 'pfx-sis', name: '前缀姐姐', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '5/100' }] },
    { id: 'pfx-young', name: '前缀妹妹', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '80/100' }] }
  ];

  const round = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };

  // 老数据：同一个人身上「好感度」和「前缀妹妹·好感度」两份都躺着 → 并回一份
  const dupBase = mod.panelKey('好感度', 'pfx-young');
  const dupBad = mod.panelKey('前缀妹妹·好感度', 'pfx-young');
  const legacyDup = {
    panel: { [dupBase]: '80/100', [dupBad]: '90/100' },
    panelFields: [dupBase, dupBad],
    panelDefs: {},
    messages: [],
    player: null
  };

  try {
    mod.seedPanelFromCharacters(round, stateMod.state.characters.slice(-2), (c) => c.id);
    round.messages = [{ role: 'assistant', content: '【前缀妹妹·好感度】：90/100' }];
    mod.syncConvoPanel(round);
    mod.syncConvoPanel(legacyDup);
  } finally {
    stateMod.state.characters = backupChars;
  }
  check(
    '照抄「前缀妹妹·好感度」拆回那张卡的字段，不新建带前缀的重复字段',
    mod.convoPanelFields(round).length === 2 &&
      round.panel[mod.panelKey('好感度', 'pfx-young')] === '90/100' &&
      !mod.convoPanelFields(round).some((k) => mod.panelFieldName(k).includes('·')),
    JSON.stringify(round.panelFields) + ' ' + JSON.stringify(round.panel)
  );
  check(
    '老数据里重复的「前缀妹妹·好感度」被并回「好感度」',
    mod.convoPanelFields(legacyDup).length === 1 && legacyDup.panel[dupBase] === '90/100',
    JSON.stringify(legacyDup.panelFields) + ' ' + JSON.stringify(legacyDup.panel)
  );

  // --- 手动改过的字段：重扫历史不能把旧值顶回来 ---
  // 真 bug：改了 HP 之后切候选 / 编辑消息都会重跑 syncConvoPanel，而它把**全部历史**
  // 重扫一遍 —— 历史里那句旧的「HP 50/100」又把 latest 覆盖回 50，手改当场失效。
  // 现在 panelManual 记的是「改动时刻」，比它早写的回复不许覆盖。
  const manualConvo = {
    panel: {}, panelFields: [], panelDefs: {}, player: null,
    messages: [{ role: 'assistant', content: '【HP】：50/100', at: 1000 }]
  };
  mod.syncConvoPanel(manualConvo);
  const hpKey = mod.convoPanelFields(manualConvo).find((k) => mod.panelFieldName(k) === 'HP');
  check('先扫出历史里的 HP', !!hpKey && manualConvo.panel[hpKey] === '50/100', JSON.stringify(manualConvo.panel));

  // 手动改成 80，然后重扫（模拟切候选 / 编辑消息）
  mod.setPanelField(manualConvo, hpKey, '80/100');
  mod.syncConvoPanel(manualConvo);
  check(
    '手改成 80 之后重扫历史，不会被旧的 50 顶回去',
    manualConvo.panel[hpKey] === '80/100',
    JSON.stringify(manualConvo.panel)
  );

  // 手改之后来的**新回复**仍然可以更新它（否则字段就冻死了）
  manualConvo.messages.push({ role: 'assistant', content: '【HP】：30/100', at: Date.now() + 1000 });
  mod.syncConvoPanel(manualConvo);
  check(
    '手改之后的新回复可以更新该字段（没被冻死）',
    manualConvo.panel[hpKey] === '30/100',
    JSON.stringify(manualConvo.panel)
  );

  // 单角色聊天：字段名不冲突时，注入不该加前缀（保持老行为）
  const solo = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.seedPanelFromCharacters(
    solo,
    [{ id: 'only', name: '单角', attributes: [{ name: '好感度', type: 'meter', min: 0, max: 100, value: '20/100' }] }],
    'only'
  );
  const soloPrompt = mod.formatPanelForPrompt(solo);
  check('单角色不冲突时注入保持纯字段名（【好感度】）', soloPrompt.includes('【好感度】') && !soloPrompt.includes('单角·好感度'), soloPrompt);

  // 迁移：老格式（纯字段名键 + def.owner）能就地升级成复合键
  const legacy = {
    panel: { 好感度: '20/100' },
    panelFields: ['好感度'],
    panelDefs: { 好感度: { type: 'meter', min: 0, max: 100, owner: 'oldid' } }
  };
  mod.migrateConvoPanel(legacy);
  check(
    '老格式面板能迁移成复合键（键里带 owner）',
    legacy.panelFields.length === 1 && legacy.panelFields[0] === '好感度\u0000oldid' && legacy.panel['好感度\u0000oldid'] === '20/100',
    JSON.stringify(legacy)
  );
});

// ---------------------------------------------------------------------------
//  场景 28：进世界之后才往书里加角色，新 NPC 的属性也要种进会话。
//  修复抽出 seedWorldbookCharactersIntoConvos，遍历绑定这本书的会话补种。验证：
//  绑了这本书的会种入、没绑的不碰、同名属性不盖掉已有的。
// ---------------------------------------------------------------------------
await scenario('世界书：进世界后加角色也能种进会话', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载（场景28）', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.seedWorldbookCharactersIntoConvos !== 'function') {
    check('panel 模块能动态加载（场景28）', false);
    return;
  }
  check('panel 模块能动态加载（场景28）', true);

  // 两个会话：A 绑了这本书，B 没绑
  const book = { id: 'bk1', name: '酒馆' };
  const convos = [
    { id: 'cA', worldbookIds: ['bk1'], panel: {}, panelFields: [], panelDefs: {}, messages: [] },
    { id: 'cB', worldbookIds: ['other'], panel: {}, panelFields: [], panelDefs: {}, messages: [] }
  ];
  // 新加入的副本：一个角色，带一个「生命」属性
  const copies = [
    { id: 'wc_new', name: '新来的NPC', attributes: [{ name: '生命', type: 'meter', min: 0, max: 100, value: '50/100' }] }
  ];

  const seeded = mod.seedWorldbookCharactersIntoConvos(convos, book, copies);

  check('只种进了绑了这本书的那一个会话', seeded === 1, `seeded=${seeded}`);
  check(
    '绑了这本书的会话拿到了新 NPC 的属性（归属=副本 id）',
    convos[0].panelFields.length === 1 &&
      mod.panelFieldOwner(convos[0], convos[0].panelFields[0]) === 'wc_new' &&
      convos[0].panel[convos[0].panelFields[0]] === '50/100',
    JSON.stringify(convos[0].panelFields)
  );
  check(
    '没绑这本书的会话完全没被碰',
    convos[1].panelFields.length === 0,
    JSON.stringify(convos[1].panelFields)
  );

  // 会话里已有同名的「生命」（属于另一个角色）时，新 NPC 的「生命」不该盖掉它
  const clashConvo = { id: 'cC', worldbookIds: ['bk1'], panel: {}, panelFields: [], panelDefs: {}, messages: [] };
  mod.seedPanelFromCharacters(clashConvo, [{ id: 'wc_old', name: '老角色', attributes: [{ name: '生命', type: 'meter', min: 0, max: 100, value: '90/100' }] }], 'wc_old');
  mod.seedWorldbookCharactersIntoConvos([clashConvo], book, copies);
  check(
    '同名的「生命」按 owner 并存（老角色的 90 和新 NPC 的 50 都留着）',
    clashConvo.panelFields.length === 2 &&
      clashConvo.panelFields.some((k) => mod.panelFieldOwner(clashConvo, k) === 'wc_old' && clashConvo.panel[k] === '90/100') &&
      clashConvo.panelFields.some((k) => mod.panelFieldOwner(clashConvo, k) === 'wc_new' && clashConvo.panel[k] === '50/100'),
    JSON.stringify(clashConvo.panel)
  );
});

// ---------------------------------------------------------------------------
//  场景 29：选卡当自己时，玩家设定里的 {{char}}/{{user}} 宏要替换成玩家本人。
//  修复：拼设定时不带 scenario、宏替换成角色名；注入层 playerProfileForPrompt 兜底替换。
// ---------------------------------------------------------------------------
await scenario('选卡当自己：玩家设定的宏替换成本人', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/cast.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('cast 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.playerProfileForPrompt !== 'function') {
    check('cast 模块能动态加载', false);
    return;
  }
  check('cast 模块能动态加载', true);

  // 老会话 / 手写的 profile：还带着字面的 {{char}}、{{user}}、<BOT>、<USER>
  const convo = {
    player: {
      name: '露西娅',
      profile:
        '{{char}}，十八岁的魅魔混血姑娘。被{{user}}善意对待时第一反应是慌。' +
        '开场背景：{{char}}端着托盘摔倒，<USER>这个外乡人坐在邻桌。'
    }
  };

  const out = mod.playerProfileForPrompt(convo);

  check(
    '{{char}} 被替换成玩家本人（露西娅）',
    !out.includes('{{char}}') && !out.includes('{{CHAR}}') && out.includes('露西娅，十八岁'),
    out
  );
  check(
    '{{user}} 被替换成玩家本人',
    !out.includes('{{user}}') && !out.includes('{{USER}}') && out.includes('被露西娅善意对待'),
    out
  );
  check(
    '<USER> 也被替换',
    !out.includes('<USER>') && !out.includes('<user>'),
    out
  );
  check(
    '最终文本不再含任何裸宏占位符',
    !/\{\{(char|user)\}\}/i.test(out) && !/<(BOT|USER)>/i.test(out),
    out
  );

  // 没写设定 / 没有玩家角色时返回空串，不该崩
  check('没有 player 时返回空串', mod.playerProfileForPrompt({}) === '', String(mod.playerProfileForPrompt({})));
  check('有 player 但没 profile 时返回空串', mod.playerProfileForPrompt({ player: { name: '甲' } }) === '');
});

// ---------------------------------------------------------------------------
//  场景 30：世界书的 NPC 名单不该把玩家本人（同名副本）当成 NPC。
//  修复：worldbookCast 把同名副本标成「玩家本人」，判定逻辑抽成纯函数 isPlayerCharacterCopy。
// ---------------------------------------------------------------------------
await scenario('世界书：同名副本不把玩家当 NPC', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/cast.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('cast 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.isPlayerCharacterCopy !== 'function') {
    check('cast 模块能动态加载', false);
    return;
  }
  check('cast 模块能动态加载', true);

  const convo = {
    worldbookIds: ['bk1'],
    player: { name: '姐姐', profile: '', characterId: null },
    gmMode: true
  };

  // 与玩家同名的副本 = 玩家本人
  check(
    '与玩家同名的副本被判为玩家本人',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_self', name: '姐姐' }) === true,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_self', name: '姐姐' }))
  );
  // 不同名的副本 = 真 NPC
  check(
    '不同名的副本被判为 NPC（不是玩家）',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_npc', name: '妹妹' }) === false,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_npc', name: '妹妹' }))
  );
  // 前后有空格也能识别（trim 后比较）
  check(
    '副本名字前后带空格也能识别',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_sp', name: ' 姐姐 ' }) === true,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_sp', name: ' 姐姐 ' }))
  );
  // 空 convo / 空角色不崩
  check('空 convo 返回 false', mod.isPlayerCharacterCopy(null, { name: '姐姐' }) === false);
  check('空角色返回 false', mod.isPlayerCharacterCopy(convo, null) === false);
});

// ---------------------------------------------------------------------------
//  场景 31：玩家不同名时，书里同名检测不误判
//
//  边界：玩家起的名字和书里角色都不一样时，书里角色全部是 NPC（不该误删）。
//  另一个边界：玩家没有角色卡（名字来自设置里的默认名）时也能识别。
// ---------------------------------------------------------------------------
await scenario('世界书：玩家不同名不误判', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/cast.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('cast 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.isPlayerCharacterCopy !== 'function') {
    check('cast 模块能动态加载', false);
    return;
  }

  const convo = {
    worldbookIds: ['bk2'],
    player: { name: '旅行者', profile: '', characterId: null },
    gmMode: true
  };

  check(
    '玩家名不同时，同名副本（妹妹）不当玩家本人',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_a', name: '妹妹' }) === false,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_a', name: '妹妹' }))
  );
  check(
    '玩家名匹配时（旅行者）才算玩家本人',
    mod.isPlayerCharacterCopy(convo, { id: 'wc_me', name: '旅行者' }) === true,
    String(mod.isPlayerCharacterCopy(convo, { id: 'wc_me', name: '旅行者' }))
  );
});

// ---------------------------------------------------------------------------
//  场景 32：状态字段分「每轮维护 / 变了才说」。static 给几乎不变的设定，
//  dynamic 给随剧情变的状态；措辞是「一旦变化就必须输出」。
// ---------------------------------------------------------------------------
await scenario('面板：静态字段「变了才说」，动态字段每轮维护', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.appendPanelFields !== 'function') {
    check('panel 模块能动态加载', false);
    return;
  }
  check('panel 模块能动态加载', true);

  // 造一个会话：铜板（动态）+ 生日（静态，几乎不变）
  const convo = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(convo, [
    { name: '铜板', type: 'meter', min: 0, max: 100, value: '3/100' },
    { name: '生日', type: 'text', value: '3月15日', mode: 'static' }
  ]);

  // 1) mode 落进了 panelDefs（静态字段才记 mode，动态字段不记，保持数据干净）
  check(
    '静态字段的 mode 记进 panelDefs',
    mod.convoPanelDef(convo, '生日') && mod.convoPanelDef(convo, '生日').mode === 'static',
    JSON.stringify(convo.panelDefs)
  );
  check(
    '动态字段不写 mode（默认值不落盘）',
    !mod.convoPanelDef(convo, '铜板') || mod.convoPanelDef(convo, '铜板').mode === undefined,
    JSON.stringify(convo.panelDefs && convo.panelDefs['铜板'])
  );

  // 2) 注入提示词：动态字段的规则说「每轮完整输出」；静态字段说「变了就必须说」
  const prompt = mod.formatPanelForPrompt(convo);
  check('注入里有「完整输出一遍」的动态字段规则', prompt.includes('完整输出一遍'), prompt);
  // 2026-10-13：数值「只涨不跌」病灶 —— 真实对局里好感度被冒犯了一整晚还涨到满值，
  // 因为旧规则只说「要更新」没说「会跌」。这里钉住方向（该降就降）必须写进动态规则。
  check(
    '动态字段规则点名数值「有涨就有跌」',
    prompt.includes('只涨不跌') && prompt.includes('该降就降'),
    prompt
  );
  // ⚠️ 静态字段有两处措辞，按分支不同：
  //    · 已有值的主分支：'只要剧情里发生了变化（换了、脱了、被拿走…），就必须在状态栏里输出那行新值'
  //    · 冷启动分支（一个值都还没有）：'一旦发生变化就必须输出（没变化才省略）'
  //    两条都表达了同一个意思，这里掐「必须…输出」这个核心承诺。
  check(
    '注入里点名静态字段「变化了就必须输出」',
    /必须[^。\n]{0,20}输出/.test(prompt) && prompt.includes('发生了变化'),
    prompt
  );
  // 老措辞「只在变化时输出」会把判断交给模型（自判「没变」就省掉整行），
  // 现在必须出现「判断标准」，把门槛挪到「这一轮有没有发生相关的事」。
  check(
    '静态字段的措辞把门槛挪到「有没有发生」，而不是「变没变」',
    prompt.includes('判断标准'),
    prompt
  );
  check('静态字段值仍在注入里（当前值要给模型看）', prompt.includes('3月15日'), prompt);
  check('动态字段值仍在注入里', prompt.includes('3/100'), prompt);

  // 2b) 冷启动分支（一个值都还没有）也必须带上静态字段的说法
  const coldStart = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(coldStart, [
    { name: '铜板', type: 'meter', min: 0, max: 100, value: '' },
    { name: '生日', type: 'text', value: '', mode: 'static' }
  ]);
  const coldPrompt = mod.formatPanelForPrompt(coldStart);
  check('冷启动分支里静态字段也提示「一旦发生变化就必须输出」', coldPrompt.includes('一旦发生变化就必须输出'), coldPrompt);

  // 3) 全静态字段的会话：不该出现「每轮完整输出」的动态规则（没有动态字段）
  const allStatic = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(allStatic, [
    { name: '生日', type: 'text', value: '3月15日', mode: 'static' },
    { name: '血型', type: 'text', value: 'O型', mode: 'static' }
  ]);
  const staticPrompt = mod.formatPanelForPrompt(allStatic);
  check(
    '全静态字段时不注入「每轮完整输出」的动态规则',
    !staticPrompt.includes('完整输出一遍'),
    staticPrompt
  );

  // 4) 老数据（无 mode）一律按动态处理：注入仍要求每轮维护
  const legacy = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(legacy, [{ name: '铜板', type: 'meter', min: 0, max: 100, value: '3/100' }]);
  const legacyPrompt = mod.formatPanelForPrompt(legacy);
  check('老数据（无 mode）仍按动态字段每轮维护', legacyPrompt.includes('完整输出一遍'), legacyPrompt);

  // 5) 有值字段 + 空字段混在一起：空的那几个也必须点名。
  //    「启用场景追踪」种进去的地点/时间/天气一开始没有任何值，而表里只列有值的字段 ——
  //    不点名模型就不知道它们存在，字段永远是空的（功能等于没启用）。
  const mixed = { panel: {}, panelFields: [], panelDefs: {}, messages: [], player: null };
  mod.appendPanelFields(mixed, [
    { name: '铜板', type: 'meter', min: 0, max: 100, value: '3/100' },
    { name: '地点', value: '', owner: 'player', group: '当前场景', hint: '只记录剧情明确给出的当前场景信息' },
    { name: '天气', value: '', owner: 'player', group: '当前场景' }
  ]);
  const mixedPrompt = mod.formatPanelForPrompt(mixed);
  check(
    '没值的字段也要在提示词里点名（否则永远是空的）',
    mixedPrompt.includes('地点') && mixedPrompt.includes('天气') && mixedPrompt.includes('还没有值'),
    mixedPrompt
  );
  check(
    '点名那段落在状态表之后（收尾那句「照上面那份表」才管得到它）',
    mixedPrompt.includes('【铜板】') && mixedPrompt.indexOf('还没有值') > mixedPrompt.indexOf('【铜板】'),
    mixedPrompt
  );
});

// ---------------------------------------------------------------------------
//  场景：推理模型只吐思考、正文被截断 → 给出明确提示而不是空气泡
//
//  用户反馈：有时会思考，但是不返回内容。根因是推理模型（deepseek-reasoner 等）
//  可能把 max_tokens 全花在 reasoning_content 上，正文还没开始就被截断 ——
//  界面上留下一个「只有思考过程、没有正文」的气泡。修成：content 为空但 reasoning
//  非空时，把正文替换成一句提示，告诉用户发生了什么、怎么补救。
// ---------------------------------------------------------------------------
await scenario('聊天：只思考不回答时给出提示', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '只思考不回答');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式状态结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  const assistant = $$('#messages .msg.assistant').pop();
  check('助手回复气泡存在', !!assistant);

  // 正文不该是空白 —— 应该被替换成「截断」提示
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('正文有「截断」提示，而不是空着', contentText.includes('截断'), contentText.slice(0, 60));

  // 思考过程仍保留、可展开
  const reasoningNode = assistant ? assistant.querySelector('.reasoning') : null;
  check('思考过程还在（可展开）', !!reasoningNode, reasoningNode ? '有' : '无');

  // 思考量标在折叠标题上（两次尝试各 5，累加 = 10）—— 「思考花了多少」是判断
  // 「是不是它在吃额度」最直接的一个数，光放在状态栏里太容易错过
  const summaryText = reasoningNode ? reasoningNode.querySelector('summary').textContent : '';
  check('思考标题标出了 token 数', summaryText.includes('10 tokens'), summaryText);

  // 不该出现错误气泡（这条不算错误，是正常回复 + 提示）
  check('没有错误气泡', $$('#messages .msg.error').length === 0);

  // 流式正常结束，没卡住
  check('发送按钮恢复可用', byId('btn-send').getAttribute('data-mode') === 'send');
});

// ---------------------------------------------------------------------------
//  场景：正文写了一半撞上限（finish_reason='length'）→ 自动接着写完
//
//  用户反馈：一轮里回复有时长有时短，还有一次状态栏写到一半就没了。
//  根因：撞到回复上限被截断，但界面上没有任何标记 —— 看不出这条是残缺的。
//  修成：服务商的 finish_reason='length' 记在这条消息上；有正文时自动接着写
//  （设置里可关），续写接在同一条气泡里，写完挂一行轻说明。
// ---------------------------------------------------------------------------
await scenario('聊天：正文被截断时自动接着写完', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '截断正文');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  // 自动续写会再发一次请求，得等它彻底停下来
  await waitFor('流式状态结束（含自动续写）', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);
  await sleep(400);

  const assistant = $$('#messages .msg.assistant').pop();
  check('助手回复气泡存在', !!assistant);

  // 正文照常显示（半截也是真正文，绝不能被替换成提示文字）
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('正文照常显示', contentText.includes('冒烟测试回复'), contentText.slice(0, 40));

  // 关键：自动续写的后半段被接了上来 —— 而且是同一条气泡，不是新消息
  check('自动续写接回了后半段', contentText.includes('自动接着写完的后半段'), contentText.slice(0, 80));
  check(
    '续写没有多出消息（还是同一条气泡）',
    $$('#messages .msg').length === beforeMsgs + 2,
    `期望 ${beforeMsgs + 2}，实际 ${$$('#messages .msg').length}`
  );

  // 救回来之后是「轻说明」口径：指出中间断过，但不催着点「继续」
  const note = assistant ? assistant.querySelector('.truncated-note') : null;
  check('挂了「撞过上限」说明', !!note, note ? note.textContent : '无');
  check(
    '说明是「已自动接着写完」的口径',
    note ? note.textContent.includes('自动接着写完') : false,
    note ? note.textContent : '无'
  );

  // 思考 token 要标出来（usage.reasoning_tokens 由主进程归一后带上来）
  const usageText = byId('usage-text').textContent;
  check('用量行标出了思考 token', usageText.includes('其中思考 6'), usageText);

  check('没有错误气泡', $$('#messages .msg.error').length === 0);
  check('发送按钮恢复可用', byId('btn-send').getAttribute('data-mode') === 'send');
});

// ---------------------------------------------------------------------------
//  场景：续写也撞上限 → 只续有限次就停下，剩下的交给用户
//
//  自动续写最怕变成无底洞（每续一次都要再花一次钱）。这里让续写请求也返回
//  'length'，验证它到上限就停手，并把「还能点继续 / 调大上限」说明白。
// ---------------------------------------------------------------------------
await scenario('聊天：截断续到上限后停下并提示', async () => {
  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '截断到底');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式状态结束（含两次自动续写）', () => byId('btn-send').getAttribute('data-mode') === 'send', 10000);
  await sleep(400);

  const assistant = $$('#messages .msg.assistant').pop();
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('续写的字也接上了', contentText.includes('又挤出来一点'), contentText.slice(0, 80));

  const note = assistant ? assistant.querySelector('.truncated-note') : null;
  check('仍然挂着「被截断」说明', !!note, note ? note.textContent : '无');
  check(
    '说明里写明续了 2 次仍没写完',
    note ? note.textContent.includes('自动接着写了 2 次') : false,
    note ? note.textContent : '无'
  );
  check(
    '说明里指出还能点「继续」',
    note ? note.textContent.includes('继续') : false,
    note ? note.textContent : '无'
  );
});

// ---------------------------------------------------------------------------
//  场景：关掉「截断后自动续写」→ 只挂说明，不自己花钱接着写
// ---------------------------------------------------------------------------
await scenario('设置：关掉自动续写后不再自己续', async () => {
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));
  click('#s-autocontinue');
  await sleep(150);
  click('#btn-save-settings');
  await waitFor('设置关闭', () => !shown('#view-settings'));

  const saved = (await window.mimitale.getSettings()).settings;
  check('关掉之后落盘也是关的', saved.autoContinue === false, String(saved.autoContinue));

  const beforeMsgs = $$('#messages .msg').length;
  setValue('#input', '截断正文');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式状态结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);
  await sleep(400);

  const assistant = $$('#messages .msg.assistant').pop();
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('没有自动续写（正文停在半截）', !contentText.includes('自动接着写完的后半段'), contentText.slice(0, 80));

  const note = assistant ? assistant.querySelector('.truncated-note') : null;
  check(
    '挂了「点继续」的说明',
    note ? note.textContent.includes('点「继续」') : false,
    note ? note.textContent : '无'
  );

  // 改回来，免得影响后面的场景
  await openSettingsPage();
  await waitFor('设置页重新打开', () => shown('#view-settings'));
  click('#s-autocontinue');
  await sleep(150);
  click('#btn-save-settings');
  await waitFor('设置再次关闭', () => !shown('#view-settings'));
});

// ---------------------------------------------------------------------------
//  场景：思考挤掉正文 → 自动重试一次，直接把正文救回来（用户无感）
//
//  上一个场景验证「重试也失败 → 兜底提示」，这个验证主路径：第一次只返回
//  思考，应用自动带着引导语重发一次，模型正常写出正文 —— 界面上不该出现
//  「截断」字样，第一次的思考过程也该保留。
// ---------------------------------------------------------------------------
await scenario('聊天：思考挤掉正文时自动重试救回', async () => {
  const beforeMsgs = $$('#messages .msg').length;

  setValue('#input', '思考挤掉正文');
  click('#btn-send');

  await waitFor('新回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式状态结束（含自动重试）', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  const assistant = $$('#messages .msg.assistant').pop();
  check('助手回复气泡存在', !!assistant);

  // 正文应该是重试拿回来的真回复，而不是截断提示
  const contentText = assistant ? assistant.querySelector('.msg-content').textContent : '';
  check('正文是自动重试拿回来的真回复', contentText.includes('冒烟测试回复'), contentText.slice(0, 60));
  check('没有「截断」提示', !contentText.includes('截断'), contentText.slice(0, 60));

  // 第一次的思考过程仍保留、可展开
  const reasoningNode = assistant ? assistant.querySelector('.reasoning') : null;
  check('第一次的思考过程还在（可展开）', !!reasoningNode, reasoningNode ? '有' : '无');

  // 思考量要跨请求累加（第一次 5 + 重试 12 = 17）：只看最后一次会漏掉
  // 「正是第一次的长思考把额度吃光」这个关键事实
  const summaryText = reasoningNode ? reasoningNode.querySelector('summary').textContent : '';
  check('思考量跨请求累加后标在标题上', summaryText.includes('17 tokens'), summaryText);

  // 没有错误气泡，也没多出一条消息（重写的是同一条，不是新气泡）
  check('没有错误气泡', $$('#messages .msg.error').length === 0);
  check('没有多出额外的消息', $$('#messages .msg').length === beforeMsgs + 2);
});

// ---------------------------------------------------------------------------
//  场景 33：剧情选项同步只认「最新一轮」，不回退到历史里的旧选项
//
//  用户反馈：玩世界书时剧情选项「每次第一个都是之前的，要换一批才跟着新剧情」，
//  以及「一会有一会没有，好奇怪」。根因是模型不是每轮都稳定输出选项行。两轮修复：
//    1) 从历史里往回找 → 命中几轮前旧选项（严重过时）；
//    2) 只看最新一条、没给就清空 → 选项凭空消失（时有时无闪烁）。
//  最终语义：只看最新一条 assistant，给了用新的；没给则**保留上一批**（紧邻、
//  基本贴合当前局面），不清空也不回退几轮前。这里用纯函数直测 syncConvoOptions。
// ---------------------------------------------------------------------------
await scenario('选项：同步只认最新一轮，不回退旧选项', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/suggestions.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('suggestions 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.syncConvoOptions !== 'function') {
    check('suggestions 模块能动态加载', false);
    return;
  }
  check('suggestions 模块能动态加载', true);

  // 1) 最新一条 assistant 给了选项 → 用新的
  const withOpts = {
    optionsSpec: { count: 3, hint: '' },
    options: [],
    messages: [
      { role: 'assistant', content: '【剧情选项】：老选项甲 / 老选项乙 / 老选项丙' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '正文……\n【剧情选项】：新选项一 / 新选项二 / 新选项三' }
    ]
  };
  mod.syncConvoOptions(withOpts);
  check(
    '最新一条给了选项就用新的',
    JSON.stringify(withOpts.options) === JSON.stringify(['新选项一', '新选项二', '新选项三']),
    JSON.stringify(withOpts.options)
  );

  // 2) 最新一条 assistant 没给选项 → 保留上一批（紧邻的），而不是清空、也不是
  //    回退到历史里几轮前的旧选项。选项应该常驻，不能「一会有一会没有」。
  const noOpts = {
    optionsSpec: { count: 3, hint: '' },
    options: ['残留的旧选项'],
    messages: [
      { role: 'assistant', content: '【剧情选项】：几轮前的旧选项A / 旧选项B / 旧选项C' },
      { role: 'user', content: '继续推进' },
      { role: 'assistant', content: '这一段只有正文，没写剧情选项行。' }
    ]
  };
  const changed = mod.syncConvoOptions(noOpts);
  check(
    '最新一条没给选项时保留上一批（选项常驻不断档）',
    JSON.stringify(noOpts.options) === JSON.stringify(['残留的旧选项']),
    JSON.stringify(noOpts.options)
  );
  check('保留动作被检测到（返回无变化）', changed === false, String(changed));

  // 3) 没开剧情选项 → 直接清空
  const noSpec = {
    optionsSpec: null,
    options: ['残留'],
    messages: [{ role: 'assistant', content: '【剧情选项】：甲 / 乙 / 丙' }]
  };
  mod.syncConvoOptions(noSpec);
  check('没开剧情选项时直接清空', Array.isArray(noSpec.options) && noSpec.options.length === 0, JSON.stringify(noSpec.options));

  // 4) 最后一条不是 assistant（边界，比如空历史）→ 清空、不崩
  const empty = { optionsSpec: { count: 3, hint: '' }, options: ['残留'], messages: [] };
  mod.syncConvoOptions(empty);
  check('空历史不崩且清空', Array.isArray(empty.options) && empty.options.length === 0, JSON.stringify(empty.options));

  // 5) 最后一条是用户消息（玩家刚发话、AI 还没回）→ 也没有可依附的剧情，清空
  const endsWithUser = {
    optionsSpec: { count: 3, hint: '' },
    options: ['残留'],
    messages: [
      { role: 'assistant', content: '【剧情选项】：甲 / 乙 / 丙' },
      { role: 'user', content: '我接着往下走。' }
    ]
  };
  mod.syncConvoOptions(endsWithUser);
  check(
    '最后一条是用户消息时清空',
    Array.isArray(endsWithUser.options) && endsWithUser.options.length === 0,
    JSON.stringify(endsWithUser.options)
  );
});

// ---------------------------------------------------------------------------
//  场景 33：世界书副本的「在状态栏显示」开关（showInPanel）。
//  副本有 description 照旧进 GM 名单（不受开关影响）；showInPanel（默认 false）
//  控制状态是否进「当前状态」入口条。单角色聊天绑的卡不受此开关管（TA 就是主角）。
// ---------------------------------------------------------------------------
await scenario('世界书：副本的「在状态栏显示」开关', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/cast.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('cast 模块能动态加载（场景33）', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.panelEntities !== 'function') {
    check('cast 模块能动态加载（场景33）', false);
    return;
  }
  check('cast 模块能动态加载（场景33）', true);

  const key = (name, owner) => `${name}\u0000${owner}`;
  // 造一个「进了世界」的会话：player 有字段，另有两个副本各有一个字段
  const mkConvo = () => ({
    gmMode: true,
    characterId: null,
    player: { name: '我', profile: '', characterId: null },
    worldbookIds: ['bk1'],
    panel: {
      [key('姓名', 'player')]: '我',
      [key('生命', 'wc_show')]: '80/100',
      [key('生命', 'wc_hide')]: '50/100'
    },
    panelFields: [key('姓名', 'player'), key('生命', 'wc_show'), key('生命', 'wc_hide')],
    panelDefs: {
      [key('姓名', 'player')]: { type: 'text', owner: 'player' },
      [key('生命', 'wc_show')]: { type: 'meter', min: 0, max: 100, owner: 'wc_show' },
      [key('生命', 'wc_hide')]: { type: 'meter', min: 0, max: 100, owner: 'wc_hide' }
    },
    messages: []
  });

  // 把两张副本塞进「本会话绑定的世界书」，一个勾了一个没勾。
  // 直接改真模块读的那份 state —— 和页面共用同一个模块实例。
  let lib = null;
  try {
    lib = await import(new URL('js/data/library.js', document.baseURI).href);
  } catch (err) {
    check('library 模块能动态加载（场景33）', false, (err && err.message) || String(err));
  }
  if (!lib || typeof lib.worldbooks !== 'function') return;
  check('library 模块能动态加载（场景33）', true);

  const wbList = lib.worldbooks();
  const saved = wbList.slice();
  wbList.push({
    id: 'bk1',
    name: '开关测试世界',
    entries: [],
    characters: [
      { id: 'wc_show', name: '要显示的NPC', showInPanel: true, attributes: [{ name: '生命', value: '80/100' }] },
      { id: 'wc_hide', name: '不显示的NPC', attributes: [{ name: '生命', value: '50/100' }] }
    ]
  });

  try {
    const owners = mod.panelEntities(mkConvo()).map((e) => e.owner);
    check('勾了的副本出现在入口条上', owners.includes('wc_show'), JSON.stringify(owners));
    check('没勾的副本不出现在入口条上', !owners.includes('wc_hide'), JSON.stringify(owners));
    check('「我」永远在第一个', owners[0] === 'player', JSON.stringify(owners));

    // 关键边界：单角色聊天绑的那张卡**不看开关**（TA 就是这局主角）。
    // 「wc_hide」在世界书里是 showInPanel:false，但当它成为会话的绑定卡时，
    // 依然必须出头像 —— 用户反馈里「状态栏不显示角色卡状态」就是这条被破坏了。
    const soloHide = {
      gmMode: false,
      characterId: 'wc_hide',
      player: null,
      worldbookIds: ['bk1'],
      panel: { [key('金币', 'wc_hide')]: '100' },
      panelFields: [key('金币', 'wc_hide')],
      panelDefs: { [key('金币', 'wc_hide')]: { type: 'text', owner: 'wc_hide' } },
      messages: []
    };
    const so = mod.panelEntities(soloHide).map((e) => e.owner);
    check(
      '单角色会话绑的副本即使没勾开关也显示（TA 是这局主角）',
      so.includes('wc_hide'),
      JSON.stringify(so)
    );

    // 角色卡（没有 showInPanel 字段）当单卡主角 → 同样豁免
    const libChars = lib.characters ? lib.characters() : [];
    if (libChars.length) {
      const c = libChars[0];
      const soloLib = {
        gmMode: false,
        characterId: c.id,
        player: null,
        worldbookIds: [],
        panel: { [key('金币', c.id)]: '7' },
        panelFields: [key('金币', c.id)],
        panelDefs: { [key('金币', c.id)]: { type: 'text', owner: c.id } },
        messages: []
      };
      const so2 = mod.panelEntities(soloLib).map((e) => e.owner);
      check('角色卡当单卡主角也显示（豁免开关）', so2.includes(c.id), JSON.stringify(so2));
    }
  } finally {
    // 还原世界书列表，别污染后面的场景
    wbList.length = 0;
    wbList.push(...saved);
  }
});

// ---------------------------------------------------------------------------
//  场景 33b：把「世界书同名副本」名下的字段并回「我」（mergePlayerOwnedFields）。
//
//  玩家挑一张卡当自己（convo.player.name = 卡名），而这本书里正好有个**同名副本**
//  也在显示状态 —— 同一个人会占两张状态卡、属性存两份，注入时还被拆成
//  「角色名·字段名」前缀。合并只认名字，把副本那份并到 'player' 名下。
// ---------------------------------------------------------------------------
await scenario('面板：世界书同名副本的字段并回「我」', async () => {
  let mod = null;
  try {
    mod = await import(new URL('js/data/panel.js', document.baseURI).href);
  } catch (err) {
    check('panel 模块能动态加载（场景33b）', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.mergePlayerOwnedFields !== 'function') {
    check('mergePlayerOwnedFields 可用（场景33b）', false);
    return;
  }
  check('mergePlayerOwnedFields 可用（场景33b）', true);

  const lib = await import(new URL('js/data/library.js', document.baseURI).href);
  const wbList = lib.worldbooks();
  const saved = wbList.slice();
  wbList.push({
    id: 'bk_merge',
    name: '同名副本测试',
    entries: [],
    characters: [
      { id: 'wc_dup', name: '同名人', showInPanel: true, attributes: [{ name: '好感度', value: '30' }] },
      { id: 'wc_other', name: '别人', showInPanel: true, attributes: [{ name: '好感度', value: '10' }] }
    ]
  });
  const key = (name, owner) => `${name}\u0000${owner}`;

  try {
    // 1) 副本有、玩家没有的同名字段 → 整条搬给玩家
    const c1 = {
      player: { name: '同名人', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'wc_dup')]: '30/100', [key('好感度', 'wc_other')]: '10/100' },
      panelFields: [key('好感度', 'wc_dup'), key('好感度', 'wc_other')],
      panelDefs: {
        [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' },
        [key('好感度', 'wc_other')]: { type: 'meter', max: 100, owner: 'wc_other' }
      },
      messages: []
    };
    mod.mergePlayerOwnedFields(c1);
    check(
      '同名副本的字段搬到了「我」名下',
      c1.panelFields.includes(key('好感度', 'player')) && !c1.panelFields.includes(key('好感度', 'wc_dup')),
      JSON.stringify(c1.panelFields)
    );
    check(
      '搬过去的定义 owner 也改成 player',
      c1.panelDefs[key('好感度', 'player')] && c1.panelDefs[key('好感度', 'player')].owner === 'player',
      JSON.stringify(c1.panelDefs[key('好感度', 'player')])
    );
    check(
      '不同名的角色不动',
      c1.panelFields.includes(key('好感度', 'wc_other')),
      JSON.stringify(c1.panelFields)
    );

    // 2) 两边都有同名字段 → 保留玩家那份值，副本键删掉
    const c2 = {
      player: { name: '同名人', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'player')]: '88/100', [key('好感度', 'wc_dup')]: '30/100' },
      panelFields: [key('好感度', 'player'), key('好感度', 'wc_dup')],
      panelDefs: {
        [key('好感度', 'player')]: { type: 'meter', max: 100, owner: 'player' },
        [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' }
      },
      messages: []
    };
    mod.mergePlayerOwnedFields(c2);
    check(
      '同名字段保留玩家那份值',
      c2.panel[key('好感度', 'player')] === '88/100' && !c2.panelFields.includes(key('好感度', 'wc_dup')),
      `${c2.panel[key('好感度', 'player')]} / ${JSON.stringify(c2.panelFields)}`
    );

    // 3) 手改标记跟着键一起搬
    const c3 = {
      player: { name: '同名人', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'wc_dup')]: '30/100' },
      panelFields: [key('好感度', 'wc_dup')],
      panelDefs: { [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' } },
      panelManual: { [key('好感度', 'wc_dup')]: true },
      messages: []
    };
    mod.mergePlayerOwnedFields(c3);
    check(
      '手改标记跟着搬到玩家键',
      c3.panelManual[key('好感度', 'player')] === true && !c3.panelManual[key('好感度', 'wc_dup')],
      JSON.stringify(c3.panelManual)
    );

    // 4) 幂等：再调一次什么都不动
    const before = JSON.stringify([c1.panelFields, c1.panel]);
    mod.mergePlayerOwnedFields(c1);
    check('合并是幂等的', JSON.stringify([c1.panelFields, c1.panel]) === before, '二次调用改了数据');

    // 5) 名字对不上的副本不动（没撞名就不该合并）
    const c4 = {
      player: { name: '别人不知道我是谁', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'wc_dup')]: '30/100' },
      panelFields: [key('好感度', 'wc_dup')],
      panelDefs: { [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' } },
      messages: []
    };
    mod.mergePlayerOwnedFields(c4);
    check(
      '名字对不上时保持不变',
      c4.panelFields.length === 1 && c4.panelFields[0] === key('好感度', 'wc_dup'),
      JSON.stringify(c4.panelFields)
    );

    // 6) 「我」那张卡要能找到卡对象（挑世界书副本当自己时，player.characterId 是空的，
    //    得按名字把同名副本找回来）—— 否则状态卡没立绘、没表情图。
    const castMod = await import(new URL('js/data/cast.js', document.baseURI).href);
    const withFields = {
      player: { name: '同名人', profile: '', characterId: null },
      worldbookIds: ['bk_merge'],
      panel: { [key('好感度', 'wc_dup')]: '30/100' },
      panelFields: [key('好感度', 'wc_dup')],
      panelDefs: { [key('好感度', 'wc_dup')]: { type: 'meter', max: 100, owner: 'wc_dup' } },
      messages: []
    };
    const meEnt = castMod.panelEntities(withFields).find((e) => e.owner === 'player');
    check(
      '挑同名副本当自己时，「我」能找到那张卡',
      !!meEnt && !!meEnt.card && meEnt.card.id === 'wc_dup',
      JSON.stringify(meEnt && meEnt.card && meEnt.card.id)
    );
    const foreign = { ...withFields, player: { name: '跟谁都不重名', profile: '', characterId: null } };
    const meEnt2 = castMod.panelEntities(foreign).find((e) => e.owner === 'player');
    check(
      '名字对不上时不硬塞一张卡给「我」',
      !!meEnt2 && !meEnt2.card,
      JSON.stringify(meEnt2 && meEnt2.card)
    );
  } finally {
    wbList.length = 0;
    wbList.push(...saved);
  }
});

// ---------------------------------------------------------------------------
//  场景 34：「同步属性」把角色卡同名卡的属性补进世界书副本（副本是快照，
//  角色卡后来补的属性不会回流）。钉住 syncCopyAttrsFromSource 四条语义：
//  按名字补属性、已有字段不覆盖、源卡没有的进 missing、补进去是深拷贝。
// ---------------------------------------------------------------------------
await scenario('世界书：同步属性把角色卡的属性补进副本', async () => {
  let mod = null;
  try {
    const url = new URL('js/data/panel.js', document.baseURI).href;
    mod = await import(url);
  } catch (err) {
    check('panel 模块能动态加载（场景34）', false, (err && err.message) || String(err));
  }
  if (!mod || typeof mod.syncCopyAttrsFromSource !== 'function') {
    check('panel 模块能动态加载（场景34）', false);
    return;
  }
  check('panel 模块能动态加载（场景34）', true);

  // 角色卡：露西娅有 2 个属性；「路人甲」在角色卡里没有同名卡
  const sources = [
    {
      id: 'lib_lucy',
      name: '露西娅',
      attributes: [
        { name: '生命', type: 'meter', min: 0, max: 100, value: '100/100', group: '生存' },
        { name: '心情', type: 'text', value: '闯祸了的慌', group: '状态栏' }
      ]
    }
  ];

  const copies = [
    // 空壳副本 —— 该被补满
    { id: 'wc_a', name: '露西娅', attributes: [] },
    // 副本上已经有「生命」（这本书的当前值）→ 只补缺的「心情」，不覆盖生命
    { id: 'wc_b', name: '露西娅', attributes: [{ name: '生命', value: '42/100' }] },
    // 角色卡里没有同名卡 → 进 missing，一动不动
    { id: 'wc_c', name: '路人甲', attributes: [] }
  ];

  const res = mod.syncCopyAttrsFromSource(copies, sources);

  check('补了 2 个副本（有同名卡且缺属性）', res.touched === 2, JSON.stringify(res));
  check('一共补上 3 条属性（2 + 1）', res.added === 3, JSON.stringify(res));
  check('角色卡里没同名卡的副本进 missing', res.missing.length === 1 && res.missing[0] === '路人甲', JSON.stringify(res.missing));

  check('空壳副本被补满 2 个属性', copies[0].attributes.length === 2, JSON.stringify(copies[0].attributes));
  check(
    '副本已有的「生命」不被角色卡的初始值覆盖',
    copies[1].attributes.length === 2 &&
      copies[1].attributes.find((a) => a.name === '生命').value === '42/100' &&
      copies[1].attributes.some((a) => a.name === '心情'),
    JSON.stringify(copies[1].attributes)
  );
  check('没同名卡的副本完全没被碰', copies[2].attributes.length === 0, JSON.stringify(copies[2].attributes));

  // 深拷贝：改副本上的属性值，不该影响角色卡那张卡
  copies[0].attributes[0].value = '改了副本';
  check(
    '补进去的是深拷贝（改副本不回流角色卡）',
    sources[0].attributes[0].value === '100/100',
    sources[0].attributes[0].value
  );

  // 幂等：再同步一次，已经没有可补的了
  const again = mod.syncCopyAttrsFromSource(copies, sources);
  check('再同步一次没什么可补的（幂等）', again.touched === 0 && again.added === 0, JSON.stringify(again));
});

// ---------------------------------------------------------------------------
//  场景：Markdown 渲染的边界
//
//  markdown.js 自己写着「不依赖任何别的东西，可以单独拿去测」—— 这里就单独测它。
//  下面六条都是「以前渲染错、用户一眼看得见」的：
//    嵌套强调匹配不上、`a * 2 * b` 被判成斜体、链接文字里的行内代码不还原、
//    表格完全不认（竖线原样显示）、`![](url)` 多出一个孤零零的 `!`、
//    自动链接把句尾的中文标点吞进 href。
// ---------------------------------------------------------------------------
await scenario('Markdown：渲染边界', async () => {
  const md = await import(new URL('js/ui/markdown.js', document.baseURI).href);
  const inline = (s) => md.renderInline(s);

  // 行内规则不认 `*` 的嵌套是踩过的坑：外层 ** 会原样露出来
  check(
    '加粗里面套斜体（**a *b* c**）两边都生效',
    inline('**这句话的 *重点* 部分**') === '<strong>这句话的 <em>重点</em> 部分</strong>',
    inline('**这句话的 *重点* 部分**')
  );
  check('普通加粗没受影响', inline('**加粗**') === '<strong>加粗</strong>', inline('**加粗**'));
  check('普通斜体没受影响', inline('*斜体*') === '<em>斜体</em>', inline('*斜体*'));

  // 数值公式里的孤立星号不能被当成强调
  check(
    '「伤害 = 攻击 * 2 * 倍率」不会被当成斜体',
    !inline('伤害 = 攻击 * 2 * 倍率').includes('<em>'),
    inline('伤害 = 攻击 * 2 * 倍率')
  );
  check('「2 * 3 * 4」也不会', !inline('2 * 3 * 4').includes('<em>'), inline('2 * 3 * 4'));

  // 链接文字里的行内代码：以前占位符不还原，会显示成字面的 \u0000C0\u0000
  const linkCode = inline('[`code`](https://example.com)');
  check(
    '链接文字里的行内代码能正常渲染',
    linkCode.includes('<code>code</code>') && linkCode.includes('href="https://example.com"'),
    linkCode
  );
  check('没有占位符漏出来', !linkCode.includes('\u0000'), JSON.stringify(linkCode));

  // 图片：外链图片受 CSP 限制加载不出来，退化成链接；不能留一个孤立的 `!`
  const img = inline('![图](https://example.com/y.png)');
  check('外链图片退化成链接，不留孤立的「!」', !img.startsWith('!') && img.includes('<a href='), img);

  // 自动链接别把句尾的中文标点吞进 href
  const auto = inline('见 https://example.com/x。');
  check(
    '自动链接不吞句尾的中文句号',
    auto.includes('href="https://example.com/x"') && auto.includes('。'),
    auto
  );

  // --- 块级：表格 ---
  const block = (s) => md.renderMarkdown(s);
  const table = block(['| 角色 | 好感 |', '| --- | --- |', '| 露西娅 | 41 |'].join('\n'));
  check('表格生成了 <table>', table.includes('<table>') && table.includes('</table>'), table.slice(0, 120));
  check('表头进了 <th>', table.includes('<th>角色</th>') && table.includes('<th>好感</th>'), table.slice(0, 160));
  check('数据行进 <td> 且没有残留竖线', table.includes('<td>露西娅</td>') && !table.includes('|'), table.slice(0, 200));
  check('分隔行 |---| 不会被当成正文', !table.includes('---'), table.slice(0, 200));
  check('表格里的行内格式照样生效', block('| a |\n| --- |\n| **粗** |').includes('<td><strong>粗</strong></td>'));

  // 单独一行的 `---` 仍然该是分隔线（别被表格逻辑吃掉）
  check('单独的 --- 还是 <hr />', block('---').includes('<hr />'), block('---'));
});

// ---------------------------------------------------------------------------
//  场景：Esc 链 + 浮层清理 + 删掉当前世界书之后编辑器的去向
//
//  这几条都是「以前漏了」的坑，单独钉住：
//    · 世界书 / 记忆 / 视角三个弹窗**没接进入口层的全局 Esc 链** —— 只开着它们时
//      按 Esc 毫无反应，和别的弹窗行为不一致；
//    · 角色编辑器里那个「＋ 绑定」选书浮层挂在 document.body 上、z-index 还比
//      编辑器高，关编辑器时如果不一起收掉，它就悬在屏幕上（而且盖着编辑器，
//      用户连关闭按钮都点不到了）；
//    · 删掉「当前正在编辑」的那本世界书后，编辑器里的书名输入框还留着**刚删掉那本**
//      的名字。这时关弹窗 → stashWorldbookName() 会把残留名字写进列表里第一本书
//      → 别人的书被静默改名 + 覆盖开场白，而且立刻落盘。
// ---------------------------------------------------------------------------
await scenario('Esc 链与弹窗清理', async () => {
  const openBookEditor = () => openWorldbookEditor('冒烟测试世界');

  // --- 三个以前漏掉的弹窗 ---
  await openBookEditor();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 关掉世界书弹窗', () => !shown('#view-wb-editor'));
  check('Esc 关得掉世界书弹窗', !shown('#view-wb-editor'));

  // 世界书是从角色编辑器进的，关掉它之后停在这一屏上 —— 先把这屏收掉，
  // 否则下面按 Esc 时先关的是角色编辑器（页面判定排在弹窗判定前面），记忆弹窗反而关不掉
  if (shown('#view-char-editor')) {
    click('#btn-back-char');
    await sleep(200);
    if (shown('#confirm-modal')) click('#confirm-ok');
    await waitFor('回到角色卡', () => shown('#view-chars'));
  }

  await clickMoreItem('#btn-memory');
  await waitFor('记忆弹窗打开', () => shown('#memory-modal'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 关掉记忆弹窗', () => !shown('#memory-modal'));
  check('Esc 关得掉记忆弹窗', !shown('#memory-modal'));

  click('#btn-perspective');
  await waitFor('视角弹窗打开', () => shown('#perspective-modal'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 关掉视角弹窗', () => !shown('#perspective-modal'));
  check('Esc 关得掉视角弹窗', !shown('#perspective-modal'));

  // --- 选书浮层：Esc 只关最上面那层，别顺手把编辑器也关了 ---
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  const card = $$('#char-page-grid .char-card')[0];
  if (!card) {
    check('角色卡里有一张卡可以做这个验证', false);
    return;
  }
  click(buttonByText(card, '编辑'));
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  // 🔴 自带世界书只允许一本：这张卡要是已经绑了，「＋ 绑定」是灰的点不动 —— 先解绑再测浮层
  click('#char-section-tab-worldbook');
  await sleep(150);
  const boundDel = $('#c-wb-list .cwb-row .cwb-row-del');
  if (boundDel) {
    click(boundDel);
    await waitFor('解绑完成', () => $$('#c-wb-list .cwb-row').length === 0);
  }

  click('#c-wb-add-btn');
  await waitFor('选书浮层出现', () => !!$('.cwb-picker'));
  check('「＋ 绑定」会弹出选书浮层', !!$('.cwb-picker'));

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 关掉选书浮层', () => !$('.cwb-picker'));
  check('Esc 关的是最上面那层选书浮层', !$('.cwb-picker'));
  check('浮层下面的角色编辑器还开着（没被一起关掉）', shown('#view-char-editor'));

  // --- 直接点 ✕ 关编辑器：残留的浮层也必须收掉 ---
  click('#c-wb-add-btn');
  await waitFor('选书浮层再次出现', () => !!$('.cwb-picker'));
  click('#btn-close-chars');
  await waitFor('角色编辑器关闭', () => !shown('#view-char-editor'));
  check('关编辑器时残留的选书浮层被一起收掉（没悬空）', !$('.cwb-picker'));

  // --- 删掉当前正在编辑的那本世界书：编辑器必须真的切到另一本 ---
  const namesBefore = (await savedWorldbooks()).map((w) => w.name);

  // 造一本可删的书：角色编辑器 → ＋ 新建（建书 + 绑定 + 直接进它的编辑器）
  click('#btn-chars');
  await waitFor('切到角色卡', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  click('#char-section-tab-worldbook');
  await waitFor('切到世界书分区', () => !byId('char-section-worldbook').hidden);
  click('#c-wb-new-btn');
  await waitFor('新建的世界书进编辑器', () => shown('#view-wb-editor'), 3000);
  setValue('#wb-name', '待删的书');
  click('#btn-del-worldbook');
  await waitFor('删除前先确认', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await sleep(250);

  check(
    '删完当前这本之后，书名输入框切到了另一本（不是残留的「待删的书」）',
    $('#wb-name').value !== '待删的书',
    `输入框里是「${$('#wb-name').value}」`
  );

  // 关掉弹窗 —— 以前这一步会把残留的书名写进列表里第一本书
  click('#btn-close-worldbooks');
  await waitFor('世界书弹窗关闭', () => !shown('#view-wb-editor'));
  await sleep(250);

  const namesAfter = (await savedWorldbooks()).map((w) => w.name);
  check(
    '关弹窗没把残留书名写到别的书上（落盘的书名一本没变）',
    JSON.stringify(namesAfter) === JSON.stringify(namesBefore),
    `之前 ${JSON.stringify(namesBefore)} / 之后 ${JSON.stringify(namesAfter)}`
  );
  check('新建的那本确实删掉了（数量回到原样）', namesAfter.length === namesBefore.length, `${namesAfter.length} vs ${namesBefore.length}`);
});

// ---------------------------------------------------------------------------
//  场景：记忆弹窗 —— 「清空全部摘要」必须真的能清
//
//  这是一个**纯人肉才能发现**的 bug：函数写好了、`export` 着，按钮也在
//  HTML 里、`.disabled` 还跟着摘要条数切换 —— 就是没人写过 addEventListener。
//  按钮看着一切正常，点下去毫无反应，而 使用说明.md 里明明写着有这功能。
//  DOM 断言全绿也照不出来，所以这里**真的点它**，看确认框出不出来、摘要少没少。
//
//  自己造摘要（而不是等自动压缩）：模块是页面共享的同一个实例，
//  往当前会话塞两条摘要就行。断言部分一律走真实 DOM + 落盘桥。
// ---------------------------------------------------------------------------
await scenario('记忆：清空全部摘要', async () => {
  const mod = await import(new URL('js/core/state.js', document.baseURI).href);
  const convo = mod.state.conversations.find((c) => c.id === mod.state.activeId);
  if (!convo) {
    check('有活跃会话可以做这个验证', false, 'activeId 找不到对应会话');
    return;
  }
  check('有活跃会话可以做这个验证', true);

  // 造两条摘要：范围盖住前几条消息（end 用 messages 长度封顶）
  const total = Array.isArray(convo.messages) ? convo.messages.length : 0;
  const half = Math.max(1, Math.floor(total / 2));
  convo.summaries = [
    { id: 'smoke_s1', title: '第 1 段', start: 0, end: half, text: '冒烟测试造的摘要一', at: Date.now() },
    { id: 'smoke_s2', title: '第 2 段', start: half, end: total, text: '冒烟测试造的摘要二', at: Date.now() }
  ];

  await clickMoreItem('#btn-memory');
  await waitFor('记忆弹窗打开', () => shown('#memory-modal'));

  check('两条摘要都铺出来了', $$('#memory-list .memory-card').length === 2, String($$('#memory-list .memory-card').length));
  check('摘要行显示条数', $('#memory-summary-line').textContent.includes('2 段'), $('#memory-summary-line').textContent);
  check('有摘要时「清空」按钮可用', $('#btn-memory-clear').disabled === false);

  // --- 先取消一次：危险动作不该只点一下就打出去 ---
  click('#btn-memory-clear');
  await waitFor('清空前先确认', () => shown('#confirm-modal'));
  check('点「清空」会先弹确认框', shown('#confirm-modal'));
  check(
    '确认框说清了后果（原文会回到上下文）',
    $('#confirm-title').textContent.includes('清空') && $('#confirm-message').textContent.includes('token'),
    `${$('#confirm-title').textContent} / ${$('#confirm-message').textContent}`
  );

  click('#confirm-cancel');
  await waitFor('确认框收起', () => !shown('#confirm-modal'));
  await sleep(150);
  check('取消之后摘要一条没少', $$('#memory-list .memory-card').length === 2, String($$('#memory-list .memory-card').length));

  // --- 真清空 ---
  click('#btn-memory-clear');
  await waitFor('再次弹确认', () => shown('#confirm-modal'));
  click('#confirm-ok');
  await waitFor('摘要清空（列表变空）', () => $$('#memory-list .memory-card').length === 0);

  check('清空后列表空了', $$('#memory-list .memory-card').length === 0);
  check('清空后列表给了空态文案', $('#memory-list .memory-empty') !== null);
  check('清空后摘要行回到「还没有摘要」', $('#memory-summary-line').textContent.includes('还没有摘要'), $('#memory-summary-line').textContent);
  check('摘要清零后「清空」按钮变灰', $('#btn-memory-clear').disabled === true);
  check('「⋯」上的摘要角标收起来了', $('#memory-count').classList.contains('hidden'));
  check('提示条说了摘要已清空', $('#toast').textContent.includes('摘要已清空'), $('#toast').textContent);

  // 落盘才算真清掉（渲染层清内存、主进程写文件是异步的）。
  // 注意别把这个轮询塞进 waitFor —— waitFor 里 `if (ok) return ok`，
  // 回调返回 Promise 永远为真，会当场"通过"。
  let saved = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    const cs = await window.mimitale.getConversations();
    const a = cs.conversations.find((c) => c.id === cs.activeId);
    if (a && Array.isArray(a.summaries) && a.summaries.length === 0) {
      saved = a;
      break;
    }
    await sleep(50);
  }
  check('清空真的落盘了（不是只清了界面）', !!saved, saved ? '' : '磁盘上还留着摘要');

  click('#btn-close-memory');
  await waitFor('记忆弹窗关闭', () => !shown('#memory-modal'));
});

// ---------------------------------------------------------------------------
//  场景：规则文案的段落边界
//
//  narration.js 的提示词是**拼接**出来的（【扮演规则】+ 节奏段 + 【标重点】…），
//  任何一段末尾漏掉 \n，两段就会粘成一行。2026-09-30 逮到过两处：
//  单角色拼出「…一律不要出现。【标重点】」，世界模式拼出
//  「…一律不要出现。不要提到自己是 AI、语言模型或助手。」。
//
//  这类问题**肉眼几乎看不出来** —— 都在字符串的接缝上，得 dump 出来才发现，
//  而模型读到的是一行挤在一起的指令。所以钉一条断言，以后改文案不会再漏。
// ---------------------------------------------------------------------------
await scenario('规则段：段落之间不粘连', async () => {
  let mod = null;
  try {
    mod = await import(new URL('js/data/narration.js', document.baseURI).href);
  } catch (err) {
    check('narration 模块能动态加载', false, (err && err.message) || String(err));
  }
  if (!mod) return;

  for (const pace of ['step', 'brisk']) {
    const solo = mod.roleplayRuleText('测试角色', '测试玩家', { paceMode: pace });
    check(
      `单角色(${pace})：节奏段后面换行再接【标重点】`,
      solo.includes('\n【标重点】') && !solo.includes('。【标重点】'),
      JSON.stringify(solo.slice(-70))
    );
    // 单角色模式下不能出现「NPC」，也不能点名角色自己（该用第二人称「你」）——
    // 前者会怂恿它凭空造人，后者和「第一人称扮演」的口径打架。
    check(`单角色(${pace})：不出现「NPC」`, !solo.includes('NPC'), JSON.stringify(solo.match(/.{10}NPC.{10}/g)));
    check(
      `单角色(${pace})：不出现「你替 TA」这种自我指涉`,
      !solo.includes('你替 TA'),
      JSON.stringify(solo.match(/.{10}你替.{10}/g))
    );

    const gm = mod.gmRuleText('测试角色', '测试玩家', { paceMode: pace });
    check(
      `世界(${pace})：节奏段后面换行再接「不要提到自己是 AI」`,
      gm.includes('\n不要提到自己是 AI') && !gm.includes('。不要提到'),
      JSON.stringify(gm.slice(-130))
    );
    check(
      `世界(${pace})：「不要提到自己是 AI」后面换行再接【标重点】`,
      gm.includes('\n【标重点】'),
      JSON.stringify(gm.slice(-70))
    );

    // 【细节别复读】（2026-10-13 加）：两种模式都要注入，且带着「多走一步」的判据。
    // 钉住它别被当「可有可无的一段」删掉 —— 真实对局里同一细节复读 5~8 次就是它管的。
    check(
      `单角色(${pace})：带【细节别复读】规则`,
      solo.includes('【细节别复读】') && solo.includes('多走一步'),
      JSON.stringify(solo.match(/.{0,10}细节别复读.{0,10}/))
    );
    check(
      `世界(${pace})：带【细节别复读】规则`,
      gm.includes('【细节别复读】') && gm.includes('多走一步'),
      JSON.stringify(gm.match(/.{0,10}细节别复读.{0,10}/))
    );

    // 占位符防呆：替换链里漏了哪个 {xxx}，它会**原样发给模型**（提示词里冒出一行
    // "{standByMe}" 这种），而别的断言一条都不会响 —— 所以单独钉一条。
    for (const [label, text] of [['单角色', solo], ['世界', gm]]) {
      check(
        `${label}(${pace})：没有没替换掉的占位符`,
        !/\{[a-zA-Z]+\}/.test(text),
        JSON.stringify(text.match(/\{[a-zA-Z]+\}/g))
      );
    }
  }

  // 「标准」不再是空串了（2026-09-30 补了硬约束，和 hint「只写对话和动作」对齐），
  // 但它不能含占位符 —— 那说明有东西没被替换，会原样发给模型。
  const standard = mod.narrationInstruction({ narrationMode: 'standard' });
  check(
    '标准叙述模式有约束，且不含占位符',
    standard.trim().length > 0 && !/\{[a-zA-Z]+\}/.test(standard),
    JSON.stringify(standard)
  );

  // 【标重点】的定位：加粗 = **角色说出口的台词**（2026-10-08 改的）。
  // 加粗色默认跟随主题配色，台词上色才认得出谁在说话；这条规则要是退回
  // 「关键信息用加粗」，那个颜色就白设了。
  const soloRule = mod.roleplayRuleText('测试角色', '测试玩家', { paceMode: 'step' });
  check(
    '【标重点】要求把「说出口的台词」加粗',
    soloRule.includes('说出口的台词') && soloRule.includes('加粗'),
    JSON.stringify(soloRule.slice(soloRule.indexOf('【标重点】'), soloRule.indexOf('【标重点】') + 90))
  );
  check(
    '【标重点】明确说「动作/神态/环境/心理不加粗」',
    soloRule.includes('不加粗'),
    JSON.stringify(soloRule.slice(soloRule.indexOf('【标重点】'), soloRule.indexOf('【标重点】') + 200))
  );
  // 只写「一律用加粗」模型不会照做（2026-10-08 实测：真实回复里一个 ** 都没有）——
  // 规则里必须带正反例，跟「称呼铁律」一个套路。这条钉住例子别被删掉。
  check(
    '【标重点】带 ✔/✗ 正反例（光说「要加粗」模型不照做）',
    soloRule.includes('✔') && soloRule.includes('✗'),
    JSON.stringify(soloRule.slice(soloRule.indexOf('【标重点】'), soloRule.indexOf('【标重点】') + 260))
  );

  // 人称兜底（2026-10-18 从「第一人称 + 括号」改成「第三人称连贯叙述」）：
  // 老兜底是 2026-09 之前的残留，和同一份提示词里的【叙述要求】直接对撞
  // （叙述模式那边明写「不要把整段动作括在括号里」，人称这头却让人括在括号里）。
  // 这里钉住新口径，顺便钉住正反例和「台词照常用我」那半句 —— 只写「第三人称」时
  // 模型很容易把台词也改成第三人称，那两句必须分开讲。
  const personStart = soloRule.indexOf('人称和描写格式');
  const personCut = soloRule.indexOf('【推进节奏】');
  const personRule = personStart < 0 ? '' : soloRule.slice(personStart, personCut > personStart ? personCut : personStart + 400);
  check(
    '单角色默认人称是第三人称（不是第一人称 + 括号）',
    personRule.includes('第三人称') && !personRule.includes('把动作和神态描写放在括号里'),
    JSON.stringify(personRule.slice(0, 120))
  );
  check(
    '人称规则带 ✔/✗ 正反例（和老规矩一致：光说要求模型不照做）',
    personRule.includes('✔') && personRule.includes('✗'),
    JSON.stringify(personRule)
  );
  check(
    '人称规则点明「台词里照常用我」（不然模型会把台词也改成第三人称）',
    personRule.includes('台词里照常用「我」'),
    JSON.stringify(personRule.slice(-90))
  );

  // 推进节奏现在的**唯一落点**是角色卡规则内部（roleplayRuleText / gmRuleText）。
  // 原来它还能单独注入（paceInstruction），拿来补「普通聊天」那一档 —— 2026-10-13
  // 那个导出连同纯聊天的注入一起删了（纯聊天里根本不该有「推进节奏」这回事）。
  // 这里钉住「随卡注入」这条路别断。
  const soloPace = mod.roleplayRuleText('测试角色', '测试玩家', { paceMode: 'brisk' });
  check(
    '推进节奏随角色卡规则注入（切到快节奏档能换文案）',
    soloPace.includes('【推进节奏】') &&
      soloPace.includes('多推进一些情节') &&
      !/\{[a-zA-Z]+\}/.test(soloPace),
    JSON.stringify(soloPace.slice(soloPace.indexOf('【推进节奏】'), soloPace.indexOf('【推进节奏】') + 80))
  );
});

// ---------------------------------------------------------------------------
//  看大图（lightbox）
//
//  这里只盖「逻辑」那一半：滚轮 / 按钮 / 双击 / 百分比 / Esc。
//  「真实鼠标点按钮」那条在宿主侧（probeLightboxClick）—— 页面里 dispatchEvent
//  复现不出指针捕获那套行为，而这正是这个浮层最容易踩的坑。
// ---------------------------------------------------------------------------
await scenario('看图：灯箱缩放与关闭', async () => {
  const NAME = '灯箱测试角色';

  // 走真实交互造这张卡（新建 → 传形象 → 保存）。
  // 不能拿 saveCharacters 硬塞：那绕开了渲染层，列表刷新不出来，卡在页面上根本找不到。
  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', NAME);

  click('#char-portrait');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  await waitFor('形象按 1024 落进框里', () => {
    const i = byId('char-portrait').querySelector('img');
    return !!i && i.naturalWidth === 1024;
  });

  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(200);

  const cardEl = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('有形象的卡，那块图是可点的', !!cardEl && !!cardEl.querySelector('.char-card-avatar.clickable'));
  if (!cardEl) return;

  click(cardEl.querySelector('.char-card-avatar.clickable'));
  await waitFor('灯箱打开', () => !!byId('lightbox'));

  const layer = byId('lightbox');
  const lbImg = layer.querySelector('.lightbox-img');
  check('灯箱里拿的正是这张形象', !!lbImg && !!lbImg.src && lbImg.src === cardEl.querySelector('.char-card-avatar img').src);

  // 缩放全写在 transform 上，读它是最可靠的做法
  const scaleOf = () => {
    const m = /scale\(([\d.]+)\)/.exec(lbImg.style.transform || '');
    return m ? Number(m[1]) : 1;
  };

  layer.dispatchEvent(
    new WheelEvent('wheel', { deltaY: -120, clientX: 300, clientY: 200, bubbles: true, cancelable: true })
  );
  await sleep(60);
  const afterWheelIn = scaleOf();
  check('滚轮向上 = 放大', afterWheelIn > 1.05, lbImg.style.transform);

  layer.dispatchEvent(
    new WheelEvent('wheel', { deltaY: 120, clientX: 300, clientY: 200, bubbles: true, cancelable: true })
  );
  await sleep(60);
  check('滚轮向下 = 缩回去', scaleOf() < afterWheelIn, lbImg.style.transform);

  const beforeBtnIn = scaleOf();
  click('#lightbox-in');
  await sleep(60);
  const afterBtnIn = scaleOf();
  check('点「＋」放大', afterBtnIn > beforeBtnIn, `${beforeBtnIn} → ${afterBtnIn}`);
  check('放大后百分比跟着变', /^\d+%$/.test((byId('lightbox-pct').textContent || '').trim()), byId('lightbox-pct').textContent);

  click('#lightbox-out');
  await sleep(60);
  check('点「−」缩小', scaleOf() < afterBtnIn, lbImg.style.transform);

  // 「适应窗口 / 实际大小」是同一个按钮，按当前状态在两个档位间切。
  // 一开始是适应窗口（scale = 1），按钮该显示「切到实际大小」那一档。
  check(
    '按钮初始是「切到实际大小」（图标 zoom-actual）',
    byId('lightbox-reset').classList.contains('is-actual'),
    byId('lightbox-reset').className
  );
  click('#lightbox-reset');
  await sleep(60);
  const actualScale = scaleOf();
  const pctAtActual = (byId('lightbox-pct').textContent || '').trim();
  check('切到实际大小后百分比是 100%', pctAtActual === '100%', pctAtActual);
  check(
    '切到实际大小后按钮变成「切到适应」（图标 zoom-fit）',
    byId('lightbox-reset').classList.contains('is-fit'),
    byId('lightbox-reset').className
  );
  check(
    '实际大小那一档 scale 和「适应」不同（原图与视口尺寸不等）',
    Math.abs(actualScale - 1) > 1e-6,
    `适应时 1，实际大小 ${actualScale}`
  );

  // 再点一下：回适应窗口
  click('#lightbox-reset');
  await sleep(60);
  check('再点回适应窗口（scale = 1）', Math.abs(scaleOf() - 1) < 1e-6, lbImg.style.transform);
  check('回到适应后百分比不再是 100%', (byId('lightbox-pct').textContent || '').trim() !== '100%' || actualScale === 1);
  check(
    '按钮又变回「切到实际大小」',
    byId('lightbox-reset').classList.contains('is-actual'),
    byId('lightbox-reset').className
  );

  // 按钮上不该再有文字（全是图标）
  check(
    '工具条按钮没有文字（只有图标）',
    ['#lightbox-in', '#lightbox-out', '#lightbox-reset', '#lightbox-close'].every((sel) => {
      const b = byId(sel.slice(1));
      return !!b && !!b.querySelector('svg') && !(b.textContent || '').trim();
    }),
    ['#lightbox-in', '#lightbox-out', '#lightbox-reset', '#lightbox-close']
      .map((s) => `${s}「${(byId(s.slice(1)).textContent || '').trim()}」`)
      .join(' ')
  );

  lbImg.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 300, clientY: 200 }));
  await sleep(60);
  check('双击图片放大', scaleOf() > 1.05, lbImg.style.transform);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(80);
  check('Esc 关掉灯箱', !byId('lightbox'));
  check('Esc 没顺带把角色卡页面也关掉', shown('#view-chars'));
});

// ---------------------------------------------------------------------------
//  裁剪组件的输出尺寸
//
//  这里直接调 ui/imageCrop.js 的导出入口（编辑器点上传框走的也是它）——
//  因为要喂一张**指定尺寸的小图**进去，而上传那条路的桩图尺寸是固定的。
// ---------------------------------------------------------------------------
await scenario('裁剪：原图不够大时不硬撑放大', async () => {
  const mod = await import(new URL('js/ui/imageCrop.js', document.baseURI).href);

  const small = (() => {
    const cv = document.createElement('canvas');
    cv.width = 200;
    cv.height = 200;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#cfd9e8';
    ctx.fillRect(0, 0, 200, 200);
    return cv.toDataURL('image/png');
  })();

  const done = mod.openImageCrop({ dataUrl: small, aspect: 2 / 3, outWidth: 1024, title: '裁剪角色形象' });
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  const outUrl = await done;

  const size = await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => resolve({ w: 0, h: 0 });
    im.src = outUrl;
  });

  // 200×200 的原图上，2:3 的框最多只能圈到 133×200 —— 输出就该是这么大。
  // 硬撑到 1024×1536 只会把同一份信息摊得更糊、文件还更大。
  check('输出按原图能给的最大信息量走，不放大', size.w === 133 && size.h === 200, `${size.w}×${size.h}`);

  // 存下来的格式：优先 1.0 的 webp（有损编码里已经到顶，肉眼看不出区别），
  // 体积只有 PNG 的 1/3 左右 —— 这个文件每存一次角色就要整个重写一遍。
  check(
    '用 1.0 的 webp 存（无损级别，体积比 PNG 小三倍）',
    outUrl.startsWith('data:image/webp'),
    outUrl.slice(0, 30)
  );
});

// ---------------------------------------------------------------------------
//  预设：列表页 / 编辑器 / 绑定到会话
//
//  预设是「叠在对话上的一层指令」，和角色卡、世界书同级：
//    · 列表页在侧栏「预设」里，新建/编辑/删除都走它；
//    · 编辑器和世界书编辑器同一套手感 —— 保存后才生效，没保存就关要问一句；
//    · 会话的「视角」弹窗里选一个预设绑上去，聊天时它才进系统提示词。
//  这里全程只点真实按钮、读真实 DOM、走 window.mimitale 这个桥。
// ---------------------------------------------------------------------------
await scenario('预设：列表页渲染与新建', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));

  // 两条种子预设都该在列表里
  await waitFor('列表里有种子预设', () => $$('#preset-page-grid .preset-row').length >= 2);
  const names = $$('#preset-page-grid .preset-row-name').map((n) => n.textContent.trim());
  check('列表里能看到「冒烟测试预设」', names.includes('冒烟测试预设'), names.join(' / '));
  check('列表里能看到「带条目的预设」', names.includes('带条目的预设'), names.join(' / '));
  check('预设使用无头像的文字行', $$('#preset-page-grid .char-card-avatar').length === 0 && $$('#preset-page-grid .preset-row').length >= 2);
  setValue('#preset-search', '冒烟测试预设');
  check('预设搜索筛选名称', $$('#preset-page-grid .preset-row').length === 1 && $('#preset-page-grid').textContent.includes('冒烟测试预设'));
  setValue('#preset-search', '');
  click('[data-preset-filter="disabled"]');
  check('停用筛选不显示启用预设', $$('#preset-page-grid .preset-row').every((row) => row.querySelector('.preset-row-state').textContent.includes('已停用')));
  click('[data-preset-filter="all"]');

  // 「冒烟测试预设」的说明来自 description（导入形态），列表副标题该显示它而不是正文
  const card = $$('#preset-page-grid .preset-row').find((c) => {
    const t = c.querySelector('.preset-row-name');
    return t && t.textContent.trim() === '冒烟测试预设';
  });
  check(
    '列表副标题显示说明（description），不是发给模型的正文',
    card && /测试用的说明/.test(card.textContent),
    card ? card.textContent.trim().slice(0, 60) : '没找到卡片'
  );

  // 新建：点「＋ 新建预设」
  click('#btn-new-preset');
  await waitFor('新建弹窗打开了', () => shown('#preset-modal'));
  check('新建时标题是「新建预设」', byId('preset-title').textContent.trim() === '新建预设');
  check('新建时没有可删的东西 → 删除按钮藏起来', byId('btn-del-preset').classList.contains('hidden'));

  // 名字和正文都空着，点保存要被拦下来
  click('#btn-save-preset');
  await sleep(60);
  check('没填名字时保存被拦下（弹窗还开着）', shown('#preset-modal'));

  setValue('#pr-name', '严格推进');
  click('#btn-save-preset');
  await sleep(60);
  check('没填正文时保存也被拦下', shown('#preset-modal'));

  // 补齐正文再保存
  setValue('#pr-content', '每一轮都要推进一个具体事件。');
  setValue('#pr-note', '这个说明只给人看');
  setValue('#pr-tags', '叙事, 节奏');
  click('#btn-save-preset');
  await waitFor('保存后弹窗关上', () => !shown('#preset-modal'));

  await waitFor('列表里出现新建的预设', () =>
    $$('#preset-page-grid .preset-row-name').some((n) => n.textContent.trim() === '严格推进')
  );

  // 落盘验证：走桥读回来，看主进程归一化之后还剩什么
  const saved = (await window.mimitale.getPresets()).presets || [];
  const made = saved.find((p) => p.name === '严格推进');
  check('新建的预设落盘了', !!made, JSON.stringify(saved.map((p) => p.name)));
  check('正文按原样存下来', made && made.content === '每一轮都要推进一个具体事件。', made && made.content);
  check('说明存成 note', made && made.note === '这个说明只给人看', made && made.note);
  check('标签按逗号拆开', made && Array.isArray(made.tags) && made.tags.join('|') === '叙事|节奏', made && JSON.stringify(made.tags));
  check('新建的预设默认启用', made && made.enabled !== false);
  check('新建的预设拿到了 id', made && typeof made.id === 'string' && made.id.startsWith('pr'), made && made.id);
});

// 导入形态：正文只在 metadata.systemPromptContent 里，description 是给人看的说明。
// 这是别人分享预设时最常见的形态，归一层要能认出来。
await scenario('预设：导入形态的正文来源', async () => {
  const saved = (await window.mimitale.getPresets()).presets || [];
  const imported = saved.find((p) => p.id === 'pr-test');
  check('导入来的预设还在', !!imported);
  check(
    '正文取自 metadata.systemPromptContent',
    imported && imported.content === '每一轮都要推进一个具体事件，不要停在原地。',
    imported && imported.content
  );
  check(
    'description 只当说明，不混进正文',
    imported && /测试用的说明/.test(imported.note || '') && !/测试用的说明/.test(imported.content || ''),
    imported && imported.note
  );
});

await scenario('预设：编辑已有预设并落盘', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));

  // 点开「带条目的预设」的编辑
  const card = await waitFor('找到「带条目的预设」卡', () =>
    $$('#preset-page-grid .preset-row').find((c) => {
      const t = c.querySelector('.preset-row-name');
      return t && t.textContent.trim() === '带条目的预设';
    })
  );
  click(buttonByText(card, '编辑'));
  await waitFor('编辑弹窗打开了', () => shown('#preset-modal'));
  check('编辑时标题是「编辑预设」', byId('preset-title').textContent.trim() === '编辑预设');
  check('编辑时删除按钮可见（有东西可删）', !byId('btn-del-preset').classList.contains('hidden'));
  check('表单填的是这条预设的正文', byId('pr-content').value.includes('最前面的总则'));

  // 改一下正文，看看「有未保存的改动」亮不亮
  setValue('#pr-content', '最前面的总则。（改过了）');
  check('改了之后底部亮出「有未保存的改动」', byId('pr-foot-hint').classList.contains('pr-dirty'));

  // 顺手给一条采样参数：宿主侧会拿它验「设过的温度真的跟着请求发出去了」
  setValue('#pr-temperature', '0.55');

  // 关掉要被问一句 —— 点「取消」，弹窗留着
  click('#btn-close-preset');
  await waitFor('弹出「放弃改动」确认框', () => shown('#confirm-modal'));
  click('#confirm-cancel');
  await sleep(80);
  check('点「取消」之后编辑弹窗还开着', shown('#preset-modal'));
  check('「有未保存的改动」还亮着（没被清掉）', byId('pr-foot-hint').classList.contains('pr-dirty'));

  // 这次真保存
  click('#btn-save-preset');
  await waitFor('保存后弹窗关上', () => !shown('#preset-modal'));

  const saved = (await window.mimitale.getPresets()).presets || [];
  const edited = saved.find((p) => p.id === 'pr-entries');
  check('改动落盘了', edited && edited.content.includes('改过了'), edited && edited.content);

  // 采样参数：填过的落盘，没填的留 null（null = 用全局，别兜成 0）
  check('填过的温度落盘成 0.55', edited && edited.temperature === 0.55, edited && String(edited.temperature));
  check('没填的回复上限留 null（不覆盖全局）', edited && edited.maxTokens === null, edited && String(edited.maxTokens));

  // 条目要活下来：归一化白名单漏一个字段就会被静默丢掉
  check('条目数没丢', edited && Array.isArray(edited.entries) && edited.entries.length === 2, edited && JSON.stringify(edited.entries));
  const keyEntry = edited && (edited.entries || []).find((e) => e.id === 'pe-key');
  check('关键词条目还认得「暗号」', keyEntry && (keyEntry.keys || []).includes('暗号'), keyEntry && JSON.stringify(keyEntry.keys));
  check('关键词条目没被当成常驻', keyEntry && keyEntry.constant !== true);
  const constEntry = edited && (edited.entries || []).find((e) => e.id === 'pe-const');
  check('无关键词的条目被当常驻', constEntry && constEntry.constant === true);
});

// ---------------------------------------------------------------------------
//  预设：只有条目、没有正文的（别人分享的酒馆预设常见形态）
//
//  编辑器没有条目编辑界面，所以这种预设**必须**能「只改名字 / 只改开关」存下来 ——
//  以前保存条件只认正文，于是它连改个名字都会被「指令正文是空的」拦住，
//  看上去像用户自己填错了。同时得让人知道它凭什么有效（那行「还带着 N 条条目」）。
// ---------------------------------------------------------------------------
await scenario('预设：只有条目的预设（导入形态）', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));

  const card = await waitFor('找到「只有条目的预设」卡', () =>
    $$('#preset-page-grid .preset-row').find((c) => {
      const t = c.querySelector('.preset-row-name');
      return t && t.textContent.trim() === '只有条目的预设';
    })
  );
  check('列表里有「只有条目的预设」', !!card);
  if (!card) return;
  click(buttonByText(card, '编辑'));
  await waitFor('编辑弹窗打开了', () => shown('#preset-modal'));

  check('正文那一栏是空的（这条只有条目）', byId('pr-content').value === '', byId('pr-content').value);
  const hint = byId('pr-entries-hint');
  check('有一行说明「还带着 N 条条目」',
    !!hint && !hint.classList.contains('hidden') && /1 条条目/.test(hint.textContent),
    hint ? hint.textContent : '(没有这行)');

  // 只改名字 —— 以前这一步会被「指令正文是空的」拦下
  setValue('#pr-name', '只有条目的预设（改过名）');
  click('#btn-save-preset');
  await waitFor('保存后弹窗关上', () => !shown('#preset-modal'));

  const saved = (await window.mimitale.getPresets()).presets || [];
  const renamed = saved.find((p) => p.id === 'pr-entry-only');
  check('只有条目的预设能只改名字就保存', !!renamed && renamed.name === '只有条目的预设（改过名）',
    renamed && renamed.name);
  check('正文仍然是空的（没有凭空编一段）', !!renamed && renamed.content === '', renamed && renamed.content);
  check('条目没被保存动作弄丢', !!renamed && Array.isArray(renamed.entries) && renamed.entries.length === 1,
    renamed && JSON.stringify(renamed.entries && renamed.entries.length));

  // 改回去，别影响后面读名字的断言
  click(buttonByText(
    $$('#preset-page-grid .preset-row').find((c) => c.textContent.includes('只有条目的预设')),
    '编辑'
  ));
  await waitFor('编辑弹窗重开', () => shown('#preset-modal'));
  setValue('#pr-name', '只有条目的预设');
  click('#btn-save-preset');
  await waitFor('弹窗关上', () => !shown('#preset-modal'));
});

// ---------------------------------------------------------------------------
//  预设：AI 生成
//
//  假后端认「写「预设」的编辑」+ "note"（见 tools/smoke-test.js）。
//  链路和「AI 生成角色」同一条规矩：弹窗 → 生成 → 填进预设编辑器草稿 →
//  点「保存」才落盘。名字跟着输入 / 场次变，用来证明这两段真的进了请求。
// ---------------------------------------------------------------------------
await scenario('预设：AI 生成', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));

  // 入口在「＋ 新建预设」左边，不会顺手创建什么
  const aiBtn = byId('btn-ai-preset');
  const newBtn = byId('btn-new-preset');
  check('预设页有「AI 生成」按钮', !!aiBtn);
  check(
    '「AI 生成」紧挨着排在「＋ 新建预设」左边',
    !!aiBtn && !!newBtn && aiBtn.nextElementSibling === newBtn,
    aiBtn && newBtn ? `${aiBtn.textContent.trim()} / ${newBtn.textContent.trim()}` : ''
  );

  const before = ((await window.mimitale.getPresets()).presets || []).length;

  click('#btn-ai-preset');
  await waitFor('生成弹窗打开', () => shown('.preset-ai-modal'));
  check(
    '弹窗是预设那一版（不是角色那版）',
    $('.preset-ai-modal').textContent.includes('AI 生成预设') && !byId('ai-gen-prompt'),
    $('.preset-ai-modal').textContent.slice(0, 40)
  );
  check('弹窗里有「想要的效果」输入框', !!byId('preset-ai-prompt'));
  check('弹窗里有可选的「适用场次」框', !!byId('preset-ai-scene'));

  // 空着点生成要被拦下（不发请求、弹窗不关）
  click(buttonByText($('.preset-ai-modal'), '开始生成'));
  await sleep(80);
  check('没写想要的效果时不会发请求（弹窗还开着）', shown('.preset-ai-modal'));

  setValue('#preset-ai-prompt', '冒烟：回复太长了，短一点、多留白');
  setValue('#preset-ai-scene', '深夜便利店，安静的日常');

  const goBtn = $$('.preset-ai-modal m-button').find((b) => b.textContent.trim() === '开始生成');
  check('生成按钮是 m-button', !!goBtn);
  click(buttonByText($('.preset-ai-modal'), '开始生成'));

  // 和「AI 生成角色」一样：点下去那一瞬间就该是「生成中… + 不可点」
  check('生成中：按钮文字变成「生成中…」', !!goBtn && goBtn.textContent === '生成中…', goBtn && goBtn.textContent);
  check('生成中：按钮点不动', !!goBtn && goBtn.control && goBtn.control.disabled === true);

  await waitFor('预设编辑器打开', () => shown('#preset-modal'));
  check('生成后打开的是新建草稿', byId('preset-title').textContent.trim() === '新建预设', byId('preset-title').textContent);
  // 名字里的「·夜」只有「适用场次」进了 system 才会有 —— 一并证明提示词那两段都拼上了
  check('名字已回填（含场次标记）', byId('pr-name').value === '短句对白·夜', byId('pr-name').value);
  check('说明已回填', byId('pr-note').value.includes('少总结'), byId('pr-note').value);
  check('标签已回填', byId('pr-tags').value.includes('节奏'), byId('pr-tags').value);
  check('指令正文已回填', byId('pr-content').value.includes('三句话'), byId('pr-content').value.slice(0, 40));

  // 最要紧的一条：生成完**还没落盘**，和手建一样要用户点保存
  await sleep(150);
  check(
    '生成后还没落盘（点保存才创建）',
    ((await window.mimitale.getPresets()).presets || []).length === before,
    `期望 ${before}，实际 ${((await window.mimitale.getPresets()).presets || []).length}`
  );

  click('#btn-save-preset');
  await waitFor('保存后弹窗关上', () => !shown('#preset-modal'));

  const saved = (await window.mimitale.getPresets()).presets || [];
  const made = saved.find((p) => p.name === '短句对白·夜');
  check('保存后预设进了盘上', !!made, JSON.stringify(saved.map((p) => p.name)));
  check('正文按原样存下来', made && made.content.includes('三句话'), made && made.content);
  check('说明存成 note', made && made.note.includes('少总结'), made && made.note);
  check('标签按数组存下来', made && Array.isArray(made.tags) && made.tags.join('|') === '节奏|对白', made && JSON.stringify(made.tags));
});

// ---------------------------------------------------------------------------
//  角色表情图 —— 按回复正文里的词换状态卡上的图
//
//  ⚠️ 放在预设那几条**聊天场景之前**：最后一条 chat:send 会被宿主侧的
//  probePresetInjection 拿来当「预设到底注没注入」的样本，这里插在后面会把它顶掉。
// ---------------------------------------------------------------------------
await scenario('角色：表情图按回复关键词切换', async () => {
  const isImg = (v) => typeof v === 'string' && v.startsWith('data:image/');
  // 假后端每次回复的正文里都带着这句（见 smoke-test.js 的 chat:send）
  const TRIGGER = '这是加粗';

  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const NAME = '表情测试角色';
  setValue('#c-name', NAME);

  // 状态卡的入口条只列「真的持有字段的人」，所以这张卡得有属性才看得见状态卡
  click('#btn-attr-template');
  await waitFor('模板字段种进来了', () => $$('#c-attr-list .attr-row').length >= 3);

  // 先给一张形象 —— 没命中表情时状态卡铺的就是它
  click('#char-portrait');
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  click('#crop-ok');
  await waitFor('形象按 1024 落进框里', () => {
    const i = byId('char-portrait').querySelector('img');
    return !!i && i.naturalWidth === 1024;
  });

  // --- 表情图：直接在「表情图」分区里编辑（2026-10-19 起不再弹窗） ---
  check('页面上没有表情弹窗了（编辑挪进分区）', !byId('expr-modal'));
  click('#char-section-tab-expressions');
  await waitFor('切到表情图分区', () => shown('#char-section-expressions'));
  check('分区里有「添加表情」按钮', !!byId('btn-add-expr'));
  check(
    '表情列表就在分区里，不在遮罩后面',
    !!byId('char-expr-list') && !!byId('char-expr-list').closest('#char-section-expressions')
  );
  check('还没加表情时有一句提示', /还没有表情图/.test(byId('char-expr-list').textContent));
  {
    const empty = byId('char-expr-list').querySelector('.char-expr-empty');
    check(
      '空状态横跨整行（grid-column 1 / -1，不缩在第一格）',
      !!empty && getComputedStyle(empty).gridColumn.includes('-1'),
      empty ? getComputedStyle(empty).gridColumn : '没有空状态节点'
    );
  }
  click('#btn-add-expr');
  await waitFor('多了一行表情', () => $$('#char-expr-list .char-expr-card').length === 1);
  check(
    '左栏分区导航的「表情图」跟着显示 1',
    byId('char-section-tab-expressions').querySelector('.char-section-count').textContent === '1',
    byId('char-section-tab-expressions').textContent
  );

  // 名都没起就传图要拦住 —— 没名字的条目匹配不上任何东西，存下去等于白存
  click($('#char-expr-list .char-expr-thumb'));
  await sleep(250);
  check('没起名字就传图会被拦下（不弹裁剪）', !byId('crop-layer'));

  setValue('#char-expr-list .char-expr-name', '表情甲');
  setValue('#char-expr-list .char-expr-keys', TRIGGER);

  click($('#char-expr-list .char-expr-thumb'));
  await waitFor('裁剪浮层弹出来了', () => !!byId('crop-layer'));
  check('裁剪标题是「裁剪表情图」', byId('crop-layer').textContent.includes('裁剪表情图'));
  click('#crop-ok');
  await waitFor('表情图按 640 落进缩略图', () => {
    const i = $('#char-expr-list .char-expr-thumb img');
    return !!i && i.naturalWidth === 640;
  });
  const exThumb = $('#char-expr-list .char-expr-thumb img');
  check(
    '表情图按 1:1 裁（640×640）',
    !!exThumb && exThumb.naturalWidth === 640 && exThumb.naturalHeight === 640,
    exThumb ? `${exThumb.naturalWidth}×${exThumb.naturalHeight}` : '缩略图里没图'
  );

  // 表情是分区里的常显内容，没有再要关的弹窗，直接保存
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(200);

  // --- 落盘 ---
  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  const expr = saved && Array.isArray(saved.expressions) ? saved.expressions[0] : null;
  check('表情表落在了角色卡上', !!expr, JSON.stringify(saved && saved.expressions));
  check(
    '表情名和触发词都存下来了',
    !!expr && expr.name === '表情甲' && Array.isArray(expr.keywords) && expr.keywords.includes(TRIGGER),
    JSON.stringify(expr && { name: expr.name, keywords: expr.keywords })
  );
  check('表情图是 dataURL', isImg(expr && expr.image), String(expr && expr.image).slice(0, 24));
  check('表情图和形象是两份，没互相顶掉', !!expr && isImg(saved.portrait) && expr.image !== saved.portrait);

  // --- 开一场，看状态卡上铺哪张 ---
  const card = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('列表里能找到这张卡', !!card);
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'));
  await waitFor('状态卡入口条出现', () => shown('#panel-box'));

  const charAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
  check('入口条上有这个角色', !!charAvatar);
  click(charAvatar);
  await waitFor('角色状态卡出现', () => $$('#state-cards .state-card').some((c) => c.dataset.owner !== 'player'));

  const scCard = () => $$('#state-cards .state-card').find((c) => c.dataset.owner !== 'player');

  check('状态卡上有角色图', !!scCard().querySelector('.sc-photo img'));
  check(
    '还没说过话时铺的是角色形象（没有表情标签）',
    !scCard().querySelector('.sc-photo-tag'),
    (scCard().querySelector('.sc-photo-tag') || {}).textContent
  );

  // --- 说一句：回复正文里带上了触发词，卡上的图该换过来 ---
  setValue('#input', '冒烟测试：表情');
  click('#btn-send');
  await waitFor('助手回复出现', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);
  await waitFor('流式状态结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  // 卡片在刷新时会被重建，每次都要重新拿一遍节点
  await waitFor('状态卡换上了表情图', () => {
    const node = scCard();
    return !!node && !!node.querySelector('.sc-photo-tag');
  });
  const tag = scCard().querySelector('.sc-photo-tag');
  check('卡上标出了命中的表情名', !!tag && tag.textContent === '表情甲', tag ? tag.textContent : '没有标签');
  const photo = scCard().querySelector('.sc-photo img');
  check(
    '铺的是那张表情图（不是形象）',
    !!photo && photo.getAttribute('src') === expr.image,
    photo ? `长度 ${String(photo.getAttribute('src')).length} / 表情图 ${String(expr.image).length}` : '没有图'
  );
});

// ---------------------------------------------------------------------------
//  角色表情图（词表）—— 差分文件名都得认得出情绪
//
//  认不出就退回「拿文件名当名字」，导进来一片 Char_C1_flustered_transparent：
//  图进来了，名字不能看，还得一条条手改 —— 所以词表按差分集的键逐个过一遍。
// ---------------------------------------------------------------------------
await scenario('角色：表情词典认得差分文件名', async () => {
  const mod = await import(new URL('js/views/charExpressions.js', document.baseURI).href);

  // 键 → 中文名。一套立绘差分的完整划分（基础 / 常态 / 亲密 / 状态 / 关系）
  const EXPECTED = {
    neutral: '平静', smile: '微笑', shy: '害羞', confused: '困惑', panicked: '慌张',
    sad: '难过', teary: '委屈', surprised: '惊讶', proud: '得意', angry: '生气',
    disgust: '嫌弃', curious: '好奇', smirk: '坏笑', cold: '冷漠', tired: '疲惫',
    relieved: '安心', flustered: '脸红别脸', panting: '喘气', resist: '抗拒', dazed: '迷离',
    defiant: '挑衅', pleading: '求饶', enduring: '隐忍', afterglow: '事后', happy: '开心',
    helpless: '无奈', serious: '认真', blank: '发呆', scared: '害怕', aching: '心疼',
    tipsy: '微醺', sleepy: '犯困', hopeful: '期待', clingy: '撒娇', sulky: '赌气',
    moved: '感动', jealous: '嫉妒', worried: '担忧', apologetic: '道歉', thankful: '感谢',
    peeking: '偷看', uneasy: '不安'
  };

  const keyOf = (file) => (mod.emotionFromFileName(file) || {}).key;
  const missed = [];
  const wrongName = [];
  for (const [key, name] of Object.entries(EXPECTED)) {
    // 中性占位：真差分集就是「角色_编号_英文键_transparent.png」这个形状
    const got = mod.emotionFromFileName(`Char_${key}_transparent.png`);
    if (!got) missed.push(key);
    else if (got.key !== key || got.name !== name) wrongName.push(`${key}→${got.key}/${got.name}`);
  }
  check(`${Object.keys(EXPECTED).length} 个差分键都认得出`, missed.length === 0, missed.join(','));
  check('认出来的中文名也对得上', wrongName.length === 0, wrongName.join(' '));

  // 中文文件名走另一条路，抽几个有代表性的
  check('中文文件名照样认得出', keyOf('Char_害羞_透明.png') === 'shy');
  check('中文同义词也能落到键上', keyOf('Char_吃醋_透明.png') === 'jealous');
  check('没见过的词不硬猜（退回文件名）', mod.emotionFromFileName('Char_0231.png') === null);
});

// ---------------------------------------------------------------------------
//  角色表情图（二）—— 批量导入 / 默认脸 / <emo> 标签
//
//  ⚠️ 同上：必须留在预设那几条聊天场景之前。
// ---------------------------------------------------------------------------
await scenario('角色：表情图批量导入、默认脸与 emo 标签', async () => {
  const isImg = (v) => typeof v === 'string' && v.startsWith('data:image/');

  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));

  const NAME = '批量表情测试角色';
  setValue('#c-name', NAME);

  // 状态卡入口条只列「真的持有字段的人」，所以得有属性才看得见状态卡
  click('#btn-attr-template');
  await waitFor('模板字段种进来了', () => $$('#c-attr-list .attr-row').length >= 3);

  // --- 批量导入：假后端给六个文件，前三个文件名是英文、后三个是中文 ---
  click('#char-section-tab-expressions');
  await waitFor('切到表情图分区', () => shown('#char-section-expressions'));
  check('分区里有「批量导入」按钮', !!byId('btn-batch-expr'));
  click('#btn-batch-expr');
  await waitFor(
    '六张里导进五张（末张「羞怯」和英文的 shy 撞同一个情绪键，被跳过）',
    () => $$('#char-expr-list .char-expr-card').length === 5
  );

  const rows = () => $$('#char-expr-list .char-expr-card');
  const thumbOk = rows().every((r) => {
    const img = r.querySelector('.char-expr-thumb img');
    return !!img && img.naturalWidth === 640 && img.naturalHeight === 640;
  });
  check('批量导入的图都按 1:1 裁过（640×640）', thumbOk);

  // --- 网格布局的新特性（2026-10-19 从「一条一行」改成 auto-fill 网格） ---
  {
    const cs = getComputedStyle(byId('char-expr-list'));
    const nCols = (cs.gridTemplateColumns || '').split(' ').filter(Boolean).length;
    check(
      '表情列表是网格（多列，不是一条一行）',
      cs.display === 'grid' && nCols >= 2,
      `${cs.display} / ${cs.gridTemplateColumns}`
    );
  }
  {
    const thumb = rows()[0].querySelector('.char-expr-thumb');
    check(
      '缩略图区是 1:1（立绘不会被拉扁）',
      !!thumb && getComputedStyle(thumb).aspectRatio.replace(/\s/g, '') === '1/1',
      thumb ? getComputedStyle(thumb).aspectRatio : '没有缩略图'
    );
  }
  {
    const zoom = rows()[0].querySelector('.char-expr-zoom');
    check(
      '放大镜默认藏起来（hover 才浮出）',
      !!zoom && getComputedStyle(zoom).opacity === '0',
      zoom ? getComputedStyle(zoom).opacity : '没有放大镜'
    );
  }
  {
    const del = rows()[0].querySelector('.char-expr-del');
    check(
      '删除按钮默认也藏起来（hover 才浮出）',
      !!del && getComputedStyle(del).opacity === '0',
      del ? getComputedStyle(del).opacity : '没有删除按钮'
    );
  }
  {
    const def = rows()[0].querySelector('.char-expr-default');
    check(
      '默认脸按钮常显（不跟 hover）',
      !!def && parseFloat(getComputedStyle(def).opacity) > 0.5,
      def ? getComputedStyle(def).opacity : '没有默认脸按钮'
    );
  }
  // 放大镜点开的是灯箱，不是裁剪层（缩略图是 <button>，套进去点放大镜会连带弹裁剪）
  {
    const zoom = rows()[0].querySelector('.char-expr-zoom');
    click(zoom);
    await waitFor('点放大镜打开了灯箱', () => !!byId('lightbox'));
    check('点放大镜没弹裁剪层', !byId('crop-layer'));
    click('#lightbox-close');
    await waitFor('灯箱关掉了', () => !byId('lightbox'));
  }

  const names = $$('#char-expr-list .char-expr-name').map((i) => i.value);
  check(
    '英文文件名认出了中文情绪名',
    names.slice(0, 3).join(',') === '害羞,微笑,慌张',
    names.join(',')
  );
  check(
    '中文文件名也认（正名「惊讶」+ 同义词「气愤」）',
    names.slice(3).join(',') === '惊讶,生气',
    names.join(',')
  );

  // 给「微笑」挂上一个关键词：假后端每轮回复里都有「这是加粗」，
  // 这样等会儿发 <emo> 标签时，正文关键词和标签会指向**两张不同的图**，
  // 才验得出「标签优先」。
  setValue($$('#char-expr-list .char-expr-keys')[1], '这是加粗');

  // --- 默认脸（单选） ---
  const star = (i) => rows()[i].querySelector('.char-expr-default');
  check('每行都有默认脸开关', rows().every((r) => !!r.querySelector('.char-expr-default')));
  check('一开始没人是默认脸', !star(0).classList.contains('is-on') && !star(1).classList.contains('is-on'));

  click(star(1));
  await sleep(30);
  check('点一下就把这条设成默认脸', star(1).classList.contains('is-on'));
  check(
    '别的行没被一起点亮',
    rows().every((r, i) => i === 1 || !r.querySelector('.char-expr-default').classList.contains('is-on'))
  );

  click(star(1));
  await sleep(30);
  check('再点一下取消', !star(1).classList.contains('is-on'));
  click(star(1));
  await sleep(30);
  check('重新点上', star(1).classList.contains('is-on'));

  // 表情是分区里的常显内容，没有再要关的弹窗，直接保存
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(200);

  const saved = (await savedCharacters()).find((c) => c.name === NAME);
  check('角色存下来了', !!saved);
  const exprs = (saved && saved.expressions) || [];
  check('五条表情都在卡上', exprs.length === 5, JSON.stringify(exprs.map((e) => e.name)));
  check(
    '情绪键落盘了（中文文件名映射到同一套英文键）',
    exprs.map((e) => e.key).join(',') === 'shy,smile,panicked,surprised,angry',
    JSON.stringify(exprs.map((e) => e.key))
  );
  check('每条都带了图', exprs.every((e) => isImg(e.image)));

  // 透明底立绘压在卡片底色上，轮廓得描出来（白发 + 浅底最容易糊）。
  // 描边色跟着主题反着走，所以拿的是算出来的值，不是写死的字符串。
  {
    const edgeVar = getComputedStyle(document.documentElement).getPropertyValue('--art-edge').trim();
    check('定义了立绘描边变量 --art-edge', edgeVar.startsWith('0 0 1px'), edgeVar);
    const thumb = rows()[0].querySelector('.char-expr-thumb');
    const shadow = getComputedStyle(thumb).boxShadow;
    check(
      '表情缩略图上描边生效了（不是 none）',
      !!shadow && shadow !== 'none' && shadow.includes('inset') === false,
      shadow
    );
  }
  const defEntry = exprs.find((e) => e.default === true);
  check('默认脸只落了一条，而且是「微笑」', exprs.filter((e) => e.default === true).length === 1 &&
    !!defEntry && defEntry.name === '微笑', defEntry && defEntry.name);
  const shyEntry = exprs.find((e) => e.name === '害羞');
  const smileEntry = exprs.find((e) => e.name === '微笑');

  // --- 开一场：没说过话时该铺默认脸，而不是形象图 ---
  const card = $$('#char-page-grid .char-card').find(
    (c) => c.querySelector('.char-card-name') && c.querySelector('.char-card-name').textContent === NAME
  );
  check('列表里能找到这张卡', !!card);

  // 列表卡那个圆头像也是透明底素材压底色，同一个坑（见 --art-edge 那段）
  {
    const av = card.querySelector('.char-card-avatar');
    const avShadow = av ? getComputedStyle(av).boxShadow : '';
    check('角色卡列表卡的头像有描边', !!avShadow && avShadow !== 'none', avShadow);
  }
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'));
  await waitFor('状态卡入口条出现', () => shown('#panel-box'));

  const charAvatar = $$('#panel-cast .panel-avatar').find((b) => b.dataset.owner !== 'player');
  check('入口条上有这个角色', !!charAvatar);
  click(charAvatar);
  await waitFor('角色状态卡出现', () => $$('#state-cards .state-card').some((c) => c.dataset.owner !== 'player'));

  const scCard = () => $$('#state-cards .state-card').find((c) => c.dataset.owner !== 'player');
  const scPhoto = () => scCard().querySelector('.sc-photo img');

  check(
    '没说过话时铺的是默认脸「微笑」',
    !!scPhoto() && scPhoto().getAttribute('src') === smileEntry.image,
    (scCard().querySelector('.sc-photo-tag') || {}).textContent
  );
  check('卡上标着默认脸的名字', (scCard().querySelector('.sc-photo-tag') || {}).textContent === '微笑');

  // 卡面那块 1:1 的立绘区：白发素材压在卡片底色上，就靠这条描边勾出轮廓
  {
    const photoShadow = getComputedStyle(scCard().querySelector('.sc-photo')).boxShadow;
    check('状态卡图区有描边（不是 none）', !!photoShadow && photoShadow !== 'none', photoShadow);
  }

  // --- 发一句，回复里既有「这是加粗」又有 <emo>shy</emo>：标签该赢 ---
  setValue('#input', '冒烟测试：表情标签');
  click('#btn-send');
  await waitFor('助手回复出现', () => $('#messages').textContent.includes('冒烟测试回复'), 8000);
  await waitFor('流式状态结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  await waitFor(
    '状态卡换成了标签指定的那张',
    () => {
      const tag = scCard() && scCard().querySelector('.sc-photo-tag');
      return !!tag && tag.textContent === '害羞';
    },
    6000
  );
  check(
    '<emo> 标签压过了正文关键词（害羞 赢了 微笑）',
    !!scPhoto() && scPhoto().getAttribute('src') === shyEntry.image,
    (scCard().querySelector('.sc-photo-tag') || {}).textContent
  );

  // 标签是给程序读的，不该留在气泡正文里
  check(
    '气泡正文里看不见 <emo> 标签',
    !$('#messages').textContent.includes('<emo>'),
    ($('#messages').textContent.match(/<emo>[^<]*<\/emo>/) || [''])[0]
  );
});

await scenario('预设：绑定到会话的「视角」弹窗', async () => {
  // 种子数据里没有会话，先用角色卡起一场对话
  click('#btn-chars');
  await waitFor('角色卡出来了', () => shown('#view-chars'));
  const charCard = await waitFor('角色卡里有卡可开聊', () => $$('#char-page-grid .char-card')[0]);
  check('角色卡里有卡可开聊', !!charCard);

  const chatBtn = buttonByText(charCard, '聊天');
  check('角色卡上有「聊天」按钮', !!chatBtn);
  if (chatBtn) await startChatWith(charCard);
  await waitFor('切回对话视图', () => shown('#view-chat'));

  // 打开「视角」弹窗
  click('#btn-perspective');
  await waitFor('视角弹窗打开了', () => shown('#perspective-modal'));

  // —— 预设是多选列表，不是下拉 ——
  const rows = () => $$('#p-preset-list .preset-pick-row');
  const names = () => $$('#p-preset-list .preset-pick-name').map((n) => n.textContent.trim());
  await waitFor('预设列表铺出来了', () => rows().length >= 3);

  check(
    '列表里列出了所有启用的预设',
    ['冒烟测试预设', '带条目的预设', '全局通用预设'].every((n) => names().includes(n)),
    names().join(' / ')
  );

  // 「可全局」的徽标只挂在勾了 global 的那条上
  const globalRow = () =>
    rows().find((r) => {
      const n = r.querySelector('.preset-pick-name');
      return n && n.textContent.trim() === '全局通用预设';
    });
  check(
    '勾了「可全局」的预设带徽标',
    globalRow() && !!globalRow().querySelector('.preset-pick-badge')
  );
  const plainRow = () =>
    rows().find((r) => {
      const n = r.querySelector('.preset-pick-name');
      return n && n.textContent.trim() === '带条目的预设';
    });
  check(
    '没勾「可全局」的预设不带徽标',
    plainRow() && !plainRow().querySelector('.preset-pick-badge')
  );

  // 会话是刚建的 —— 没手动配过，应该自动跟随全局预设（只勾上那一条）
  const boxState = () =>
    Object.fromEntries(
      rows().map((r) => [
        r.querySelector('.preset-pick-name').textContent.trim(),
        r.querySelector('.preset-pick-box').checked
      ])
    );
  let st = boxState();
  check('没配过的会话自动勾上「可全局」的预设', st['全局通用预设'] === true, JSON.stringify(st));
  check('没配过的会话不勾其它预设', st['带条目的预设'] === false, JSON.stringify(st));

  const stateNote = () => byId('p-preset-list').querySelector('.preset-pick-state');
  await waitFor('列表下有状态说明', () => stateNote());
  check('自动跟随全局时状态说明写「跟随全局」', /跟随全局/.test(stateNote().textContent), stateNote().textContent.trim());

  // 轮询落盘（视角弹窗是「改动即时生效」的异步链，固定 sleep 会偶尔跑输）
  const settleIds = async (want, label) => {
    const t0 = Date.now();
    for (;;) {
      const a = await activeConvo();
      const got = a ? a.dialoguePresetIds : undefined;
      if (JSON.stringify(got) === JSON.stringify(want)) return a;
      if (Date.now() - t0 > 3000) return null;
      await sleep(25);
    }
  };

  // —— 勾第二条：从「跟随全局」转成「手动配过」——
  const boxFor = (name) =>
    rows()
      .find((r) => r.querySelector('.preset-pick-name').textContent.trim() === name)
      .querySelector('.preset-pick-box');
  boxFor('带条目的预设').checked = true;
  boxFor('带条目的预设').dispatchEvent(new Event('change', { bubbles: true }));

  // 全局那条还勾着（用户没取消），加上新勾的这条 → 两条。
  // 顺序按列表里的行序来（DOM 顺序），不是按勾选先后。
  let bound = await settleIds(['pr-entries', 'pr-global'], '勾第二条');
  check(
    '勾上第二条之后会话记下两条 id',
    !!bound,
    bound ? JSON.stringify(bound.dialoguePresetIds) : `等 3 秒也没等到落盘；当前=${JSON.stringify((await activeConvo())?.dialoguePresetIds)}`
  );
  st = boxState();
  check('手动配过之后两条都勾着', st['全局通用预设'] && st['带条目的预设'], JSON.stringify(st));
  check('手动配过之后状态说明变成「这一场单独配置」', /单独配置/.test(stateNote().textContent), stateNote().textContent.trim());

  // —— 全不勾：显式「一条都不要」，存成空数组（不是 null）——
  boxFor('全局通用预设').checked = false;
  boxFor('全局通用预设').dispatchEvent(new Event('change', { bubbles: true }));
  boxFor('带条目的预设').checked = false;
  boxFor('带条目的预设').dispatchEvent(new Event('change', { bubbles: true }));
  const cleared = await settleIds([], '全不勾');
  check('全不勾时存成空数组（不是 null）', !!cleared, cleared ? JSON.stringify(cleared.dialoguePresetIds) : '等 3 秒也没等到落盘');
  check('全不勾等于「这一场一条都不用」', !!cleared && Array.isArray(cleared.dialoguePresetIds) && cleared.dialoguePresetIds.length === 0);
  check('全不勾之后状态说明挑明「一条都不用」', /一条都不用/.test(stateNote().textContent), stateNote().textContent.trim());

  // —— 关键的一条：手动配成「全不选」之后，全局预设**不该**再自动回来 ——
  // 关掉弹窗再打开，状态要从盘上重读，这时候最容易把「没配过」和「配成全不选」搞混
  click('#btn-close-perspective');
  await sleep(60);
  click('#btn-perspective');
  await waitFor('视角弹窗重新打开', () => shown('#perspective-modal'));
  await waitFor('列表重新铺出来了', () => rows().length >= 3);
  st = boxState();
  check('重开之后仍然是「一条都不勾」', !st['全局通用预设'] && !st['带条目的预设'], JSON.stringify(st));
  check('重开之后仍标「这一场单独配置」（没回落全局）', /单独配置/.test(stateNote().textContent), stateNote().textContent.trim());

  // —— 只勾「带条目的预设」一条，留给后面的「注入」场景用 ——
  boxFor('带条目的预设').checked = true;
  boxFor('带条目的预设').dispatchEvent(new Event('change', { bubbles: true }));
  await settleIds(['pr-entries'], '只勾一条');

  click('#btn-close-perspective');
  await sleep(60);
  check('关掉视角弹窗', !shown('#perspective-modal'));
});

await scenario('预设：绑好后发一轮，正文进提示词', async () => {
  setValue('#input', '准备好了吗');
  click('#btn-send');
  // 等这一轮回复落成消息（真实流式通道跑完）
  await waitFor('这一轮回复渲染出来了', () => $$('#messages .msg').length >= 2, 8000);
});

// ---------------------------------------------------------------------------
//  预设：导入 / 导出
//
//  导入的「文件」由宿主侧的 smoke:preset-import-queue 塞进来（测试没有真文件框）。
//  这里验的是渲染层那一半：导进来的要重发 id、要进库、要落盘、要有提示；
//  导出则把 util:saveFile 收到的内容交给宿主侧断言（probePresetExport）。
// ---------------------------------------------------------------------------
await scenario('预设：导入文件', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));
  await waitFor('列表有种子预设', () => $$('#preset-page-grid .preset-row').length >= 2);

  const before = $$('#preset-page-grid .preset-row').length;

  // 「文件里的东西」由宿主侧事先塞好（测试没有真文件框），这里只管点导入。
  // 第一批要拿到的是「导入的预设甲 / 乙」（见 smoke-test.js 的 seedPresetImportQueue）。
  click('#btn-import-preset');
  await waitFor('导入后列表变长了', () => $$('#preset-page-grid .preset-row').length >= before + 2, 5000);

  const names = $$('#preset-page-grid .preset-row-name').map((n) => n.textContent.trim());
  check('导入的预设进了列表', names.includes('导入的预设甲') && names.includes('导入的预设乙'), names.join(' / '));

  // 落盘 + 归一化：正文该来自 metadata.systemPromptContent，说明该是 description
  const saved = (await window.mimitale.getPresets()).presets || [];
  const a = saved.find((p) => p.name === '导入的预设甲');
  check('导入的预设落盘了', !!a, JSON.stringify(saved.map((p) => p.name)));
  check('导入时正文取自 metadata.systemPromptContent', a && a.content === '导入的正文甲。', a && a.content);
  check('导入时 description 当说明、不混进正文', a && a.note === '这是说明，不该混进正文', a && a.note);
  check('导入的预设拿到了新 id', a && typeof a.id === 'string' && a.id.startsWith('pr'), a && a.id);

  // ⚠️ id 必须重发：直接沿用文件里的 id，两条同 id 的会互相顶掉
  const ids = saved.map((p) => p.id);
  check('导入后所有预设 id 互不重复', new Set(ids).size === ids.length, JSON.stringify(ids));
});

await scenario('预设：导入时出错要把好的收下', async () => {
  const before = $$('#preset-page-grid .preset-row').length;

  // 第二批：一个能读到的 + 一条错误（见 seedPresetImportQueue）
  click('#btn-import-preset');
  await waitFor('导入的预设进了列表', () =>
    $$('#preset-page-grid .preset-row-name').some((n) => n.textContent.trim() === '导入的预设丙')
  , 5000);
  check('有错误时照样把好的导入进来', $$('#preset-page-grid .preset-row').length >= before + 1);
});

await scenario('预设：导出单条与全部', async () => {
  click('#btn-presets');
  await waitFor('预设页出来了', () => shown('#view-presets'));

  // 单条：卡片上的「导出」按钮
  const cardEl = await waitFor('找到「带条目的预设」卡', () =>
    $$('#preset-page-grid .preset-row').find((c) => {
      const t = c.querySelector('.preset-row-name');
      return t && t.textContent.trim() === '带条目的预设';
    })
  );
  check('预设卡片上有「导出」按钮', !!buttonByText(cardEl, '导出'));
  click(buttonByText(cardEl, '导出'));
  await sleep(200);

  // 全部：页面右上角
  click('#btn-export-presets');
  await sleep(200);

  // 具体内容由宿主侧看 util:saveFile 收到的 payload（probePresetExport）
  check('导出没有卡住界面', shown('#view-presets'));
});

// ---------------------------------------------------------------------------
//  开聊前先定「你是谁」
//
//  点角色卡的「聊天」不再直接建会话 —— 先弹「你是谁」（和「进世界」共用同一个
//  弹窗），填完才建；什么都不填就以默认的「你」开始（会话上不存 player）。
//
//  这个场景会**建三条新会话**，所以放在最后跑 —— 否则后面所有依赖「当前会话」
//  的场景都会跑在它新建的会话上（预设绑定那几条就是这么被顶掉的）。
// ---------------------------------------------------------------------------
await scenario('开聊前先定「你是谁」', async () => {
  const settlePlayer = async (want) => {
    const t0 = Date.now();
    for (;;) {
      const a = await activeConvo();
      const p = a && a.player;
      if (want === null ? !p : p && p.name === want.name && p.profile === want.profile) return a;
      if (Date.now() - t0 > 3000) return null;
      await sleep(25);
    }
  };

  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  const card = await waitFor('角色卡里有卡可开聊', () => $$('#char-page-grid .char-card')[0]);

  // —— 点「聊天」先弹窗，这时还没建会话 ——
  click(buttonByText(card, '聊天'));
  await waitFor('「你是谁」弹窗打开', () => shown('#player-modal'));
  check('角色卡的「聊天」会先问「你是谁」', shown('#player-modal'));
  check('名字默认是空的（留空就是「你」）', byId('player-name').value === '', JSON.stringify(byId('player-name').value));

  // —— 填好身份再开始：落到新会话上 ——
  setValue('#player-name', '测试者甲');
  setValue('#player-profile', 'P-玩家设定');
  click('#btn-start-play');
  await waitFor('弹窗关掉并进入对话', () => !shown('#player-modal') && shown('#view-chat'));

  const stored = await settlePlayer({ name: '测试者甲', profile: 'P-玩家设定' });
  check(
    '填好的身份落到新会话上',
    !!stored,
    stored ? JSON.stringify(stored.player) : '等 3 秒也没等到落盘'
  );

  // —— 再开一场、什么都不填：会话上不存 player，界面回到默认的「你」——
  click('#btn-chars');
  await waitFor('切回角色卡页面', () => shown('#view-chars'));
  await startChatWith($$('#char-page-grid .char-card')[0]);
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  const blank = await settlePlayer(null);
  check(
    '什么都不填也能开聊，player 不落盘',
    !!blank,
    blank ? JSON.stringify(blank.player) : '等 3 秒也没等到'
  );

  // —— 挑一张角色卡当自己：绑定的那个角色仍要留在入口条里 ——
  // ⚠️ 这条守着一个真 bug：玩家一旦有身份，单卡会话绑的卡就丢掉了「永远显示」
  //    的豁免，掉进 showsInPanel（默认 false）里被过滤掉 —— 入口条只剩「我」，
  //    那个角色的状态卡再也点不开，表情键也不注入。
  click('#btn-chars');
  await waitFor('切回角色卡页面', () => shown('#view-chars'));
  const soloCard = $$('#char-page-grid .char-card')[0];
  click(buttonByText(soloCard, '聊天'));
  await waitFor('「你是谁」弹窗打开（挑卡当自己）', () => shown('#player-modal'));

  const selfOptions = Array.from(byId('player-char').options).filter((o) => o.value);
  check('开聊前能从角色卡挑一张卡当自己', selfOptions.length > 0, `${selfOptions.length} 个可选`);
  // ⚠️ 正在聊的那个人不能出现在「我是谁」里：选了就成了「自己跟自己聊」，
  //    开场白里的 {{user}} 全变成 TA 的名字（真实踩过）。
  const soloName = (soloCard.querySelector('.char-card-name')?.textContent || '').trim();
  const selfNames = selfOptions.map((o) => o.textContent.trim());
  check(
    '「我是谁」下拉里不出现正在聊的那个人',
    !!soloName && !selfNames.includes(soloName),
    `TA=${soloName} 下拉=${JSON.stringify(selfNames)}`
  );
  setValue('#player-char', selfOptions[0].value);
  click('#btn-start-play');
  await waitFor('弹窗关掉并进入对话（挑卡当自己）', () => !shown('#player-modal') && shown('#view-chat'));
  await sleep(250);

  const castAvatars = $$('#panel-cast .panel-avatar');
  check(
    '挑卡当自己后，绑定的角色仍在入口条里（普通聊天不显示「我」）',
    castAvatars.some((a) => a.dataset.owner !== 'player') &&
      !castAvatars.some((a) => a.dataset.owner === 'player'),
    `入口条 ${castAvatars.length} 个：` + castAvatars.map((a) => a.dataset.owner).join('、')
  );

  // —— 身份只在开聊前定：视角弹窗里已经没有「我是谁」了 ——
  click('#btn-perspective');
  await waitFor('视角弹窗打开', () => shown('#perspective-modal'));
  check('视角弹窗里不再有「我是谁」', !byId('p-player-name') && !byId('p-player-char'));
  click('#btn-close-perspective');
  await sleep(60);
});

// ---------------------------------------------------------------------------
//  「＋ 新对话」：直接建空白会话；场上没有角色时「在场角色」整条收掉
//
//  2026-10-08 两处行为变化一起钉住：
//    · 「＋ 新对话」不再先跳角色卡，点下去就建一个空白会话并切回聊天屏；
//    · 普通聊天的入口条不显示「我」—— 空白会话名单为空，横幅整条隐藏。
// ---------------------------------------------------------------------------
await scenario('新对话：直接建空白会话，只剩「我」时入口条收起', async () => {
  const before = $$('#convo-list .convo-item').length;
  click('#btn-new');
  await waitFor('会话列表多了一条', () => $$('#convo-list .convo-item').length === before + 1);
  await waitFor('切回聊天视图', () => shown('#view-chat'));
  check('空白会话里「在场角色」入口条整条收掉', !shown('#panel-box'));
});

// ---------------------------------------------------------------------------
//  默认人设：按模型各存一份，管「没绑角色卡」的对话
//
//  这一段只负责造现场和验界面；「这段人设到底有没有拼进提示词」由宿主侧的
//  probeAssistantPersona 断言（页面读不到发给模型的消息）。
// ---------------------------------------------------------------------------
await scenario('默认人设：按模型可编辑，并注入没绑卡的对话', async () => {
  const PERSONA_TEXT = '你是一只叫团子的猫，只用喵喵叫和动作回应。';

  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const convMod = await import(new URL('js/data/conversations.js', document.baseURI).href);
  const redrawMod = await import(new URL('js/views/redraw.js', document.baseURI).href);
  const viewMod = await import(new URL('js/views/viewSwitch.js', document.baseURI).href);

  // 造一条**不绑角色卡**的会话（通用助手那一类）
  viewMod.showView('chat');
  convMod.createConvo(true);
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);

  const model = String((stateMod.state.settings || {}).activeModel || '');
  check('当前有模型可配', !!model, model || '（设置里没有 activeModel）');

  // --- 1) 「模型服务」里有一行入口，点开才进编辑弹窗 ---
  await openSettingsPage();
  await waitFor('设置页打开', () => shown('#view-settings'));

  const hintText = () => (byId('s-assistant-hint') || {}).textContent || '';
  check('模型服务里有「默认人设」入口按钮', !!byId('btn-assistant-persona'));
  check(
    '入口那行写着当前模型还没配',
    hintText().includes(model) && /未设置/.test(hintText()),
    hintText()
  );

  click('#btn-assistant-persona');
  await waitFor('人设弹窗打开', () => shown('#persona-modal'));
  check(
    '人设弹窗里能选「给哪个模型」，默认落在当前这个模型上',
    byId('persona-model').value === model,
    `${byId('persona-model').value}（可选项 ${byId('persona-model').options.length} 个）`
  );
  check(
    '这个模型还没配过人设，两个框都是空的',
    byId('persona-name').value === '' && byId('persona-text').value === '',
    `名字「${byId('persona-name').value}」`
  );

  // 先试一次「取消」：没保存的字必须丢掉，不能被之后「保存设置」顺带带走
  setValue('#persona-name', '不该留下');
  setValue('#persona-text', '这段也不该留下');
  click('#btn-cancel-persona');
  await waitFor('人设弹窗关掉', () => !shown('#persona-modal'));
  check(
    '取消后弹窗字段回填成空（草稿被丢掉）',
    byId('persona-name').value === '' && byId('persona-text').value === '',
    `名字「${byId('persona-name').value}」正文「${byId('persona-text').value}」`
  );

  // --- 1.5) 「套用聊天风格模板」：空框直接填；有内容时先问一句再覆盖 ---
  // 这段模板补的是「API 没有网页版那层官方语气」的缺口，属于默认对话的核心体验，
  // 所以顺手守住两条：空框不打扰、非空不偷改。
  click('#btn-assistant-persona');
  await waitFor('人设弹窗再开一次', () => shown('#persona-modal'));
  check('人设弹窗里有「套用聊天风格模板」', !!byId('btn-persona-template'));

  click('#btn-persona-template');
  await sleep(80);
  const tplText = byId('persona-text').value;
  check(
    '空框时点模板直接填进去，不弹确认',
    tplText.includes('【说话方式】') && !shown('#confirm-modal'),
    String(tplText).slice(0, 24)
  );

  click('#btn-persona-template');
  await waitFor('有内容时点模板要先确认', () => shown('#confirm-modal'));
  click('#confirm-cancel');
  await waitFor('确认框收起', () => !shown('#confirm-modal'));
  check('在确认框里点「取消」，正文一个字都不变', byId('persona-text').value === tplText);

  // 模板是草稿，别让它影响后面「正经配一套」那一步 —— 清掉再取消
  setValue('#persona-text', '');
  click('#btn-cancel-persona');
  await waitFor('放弃模板草稿', () => !shown('#persona-modal'));

  // --- 2) 正经配一套并保存 ---
  click('#btn-assistant-persona');
  await waitFor('人设弹窗再开', () => shown('#persona-modal'));
  setValue('#persona-name', '烟测助手');
  setValue('#persona-text', PERSONA_TEXT);
  click('#btn-save-persona');
  await waitFor('保存后人设弹窗关闭', () => !shown('#persona-modal'));
  await sleep(150);

  const saved = (await window.mimitale.getSettings()).settings;
  const map = saved.assistantPersonas || {};
  check(
    '默认人设按模型名落盘',
    !!(map[model] && map[model].name === '烟测助手'),
    JSON.stringify(map)
  );
  check(
    '人设正文也落了盘',
    !!(map[model] && map[model].persona === PERSONA_TEXT),
    (map[model] || {}).persona
  );
  check(
    '入口那行跟着变成「已设置」',
    /已设置/.test(hintText()) && hintText().includes('烟测助手'),
    hintText()
  );

  click('#btn-back-settings');
  await waitFor('离开设置页', () => !shown('#view-settings'));

  // --- 3) 空状态标题跟着人设的名字走 ---
  const emptyTitle = $('#messages .empty h2') ? $('#messages .empty h2').textContent : '';
  check('空状态标题用了默认人设的名字', emptyTitle.includes('烟测助手'), emptyTitle);

  // --- 4) 换成另一个模型：那一份是空的，刚才那份还在（= 每个模型一份）---
  const convo = stateMod.state.conversations.find((c) => c.id === stateMod.state.activeId);
  if (convo) convo.model = '另一个模型';
  await openSettingsPage();
  await waitFor('设置页再开一次', () => shown('#view-settings'));
  click('#btn-assistant-persona');
  await waitFor('人设弹窗再开', () => shown('#persona-modal'));
  check(
    '另一个模型的人设是空的（两边各自独立）',
    byId('persona-name').value === '',
    byId('persona-name').value
  );
  check(
    '切模型后弹窗顶上的下拉框跟着换了',
    byId('persona-model').value === '另一个模型',
    byId('persona-model').value
  );

  // --- 4.5) 弹窗里能**直接换编辑对象** -----------------------------------
  // 这一节守的是那个报上来的 bug：编辑对象从前跟着「会话在用的模型」走，
  // 界面上又没有任何地方能改 —— 想给另一个模型配人设就无从下手，
  // 弹窗永远只有会话那一个模型的一份。
  const personaOptions = [...byId('persona-model').options].map((o) => o.value);
  check(
    '下拉框列出了各服务商的模型，也带上当前会话在用的这个',
    personaOptions.includes(model) && personaOptions.includes('另一个模型'),
    personaOptions.join(' , ')
  );

  setValue('#persona-model', model);
  await sleep(80);
  check(
    '换到另一个模型，字段里换成那一份（不是刚才那份空的）',
    byId('persona-name').value === '烟测助手' && byId('persona-text').value === PERSONA_TEXT,
    `名字「${byId('persona-name').value}」`
  );
  check('字段里没有未保存的改动时，换编辑对象不弹确认框', !shown('#confirm-modal'));

  setValue('#persona-model', '另一个模型');
  await sleep(80);
  check(
    '换回来字段又变回那一份空草稿',
    byId('persona-name').value === '' && byId('persona-text').value === '',
    `名字「${byId('persona-name').value}」`
  );

  // 挑着模型存一份：必须进到**选中的**那个模型名下，不能覆盖另一份。
  // 拿 img-model-x 当靶子 —— 它是服务商列表里真实存在的一个模型（另一个服务商名下的），
  // 正好顺带验「跨服务商的模型都能选」。存完「另一个模型」还是干净的，
  // 下面「没配名字时空状态标题不提名字」那条断言才不会被打乱。
  const PICKED = 'img-model-x';
  setValue('#persona-model', PICKED);
  await sleep(80);
  check(
    '另一个服务商名下的模型也能选，字段同样是空的',
    byId('persona-model').value === PICKED &&
      byId('persona-name').value === '' &&
      byId('persona-text').value === '',
    byId('persona-model').value
  );

  const PERSONA_TEXT_2 = '你是只回答天气的助手。';
  setValue('#persona-name', '第二个助手');
  setValue('#persona-text', PERSONA_TEXT_2);

  // 有未保存的改动时换编辑对象：先问一句。点「取消」= 不切，草稿一个字都不动。
  // （草稿只活在字段里、没有按模型分别暂存，所以这里必须拦一下，
  //   否则「点开看看另一个模型」就会把刚写的整段吃掉。）
  setValue('#persona-model', model);
  await waitFor('有草稿时换编辑对象先弹确认', () => shown('#confirm-modal'));
  click('#confirm-cancel');
  await waitFor('确认框收起', () => !shown('#confirm-modal'));
  await sleep(80);
  check(
    '在确认框点「取消」：编辑对象退回原处，草稿还在',
    byId('persona-model').value === PICKED &&
      byId('persona-name').value === '第二个助手' &&
      byId('persona-text').value === PERSONA_TEXT_2,
    `${byId('persona-model').value} / ${byId('persona-name').value}`
  );

  click('#btn-save-persona');
  await waitFor('保存另一个模型的人设后弹窗关闭', () => !shown('#persona-modal'));
  await sleep(150);

  const savedByPick = (await window.mimitale.getSettings()).settings.assistantPersonas || {};
  check(
    '挑着模型存：这一份进了选中的那个模型，原来那份没被动',
    (savedByPick[PICKED] || {}).name === '第二个助手' &&
      (savedByPick[PICKED] || {}).persona === PERSONA_TEXT_2 &&
      (savedByPick[model] || {}).name === '烟测助手' &&
      !savedByPick['另一个模型'],
    JSON.stringify(savedByPick)
  );
  check(
    '入口那行摘要说的仍是「当前在用」那个模型，不是刚编辑的那个',
    hintText().includes('另一个模型') && /未设置/.test(hintText()),
    hintText()
  );

  click('#btn-back-settings');
  await waitFor('离开设置页', () => !shown('#view-settings'));

  // 「另一个模型」没配人设 = 通用助手连名字都没有 —— 标题不该硬套一个内置假名
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);
  const anonTitle = ($('#messages .empty h2') || {}).textContent || '';
  check('没配名字时空状态标题不提名字', anonTitle === '开始聊天吧～', anonTitle);

  if (convo) convo.model = model;
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);

  // --- 5) 真的聊一句，注入内容交给宿主侧 probe 断言 ---
  const beforeMsgs = $$('#messages .msg').length;
  setValue('#input', '你好');
  click('#btn-send');
  await waitFor('通用助手回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);
});

await scenario('消息操作按钮：平时收起来、悬停才浮出', async () => {
  const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
  const redrawMod = await import(new URL('js/views/redraw.js', document.baseURI).href);
  const viewMod = await import(new URL('js/views/viewSwitch.js', document.baseURI).href);

  viewMod.showView('chat');

  // 得切到一条**有消息**的会话上（前面场景新建的那条是空的）
  const withMsgs = stateMod.state.conversations.find((c) => (c.messages || []).length >= 2);
  check('能找到一条有消息的会话用来验按钮', !!withMsgs);
  if (!withMsgs) return;

  stateMod.state.activeId = withMsgs.id;
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);

  const actions = $('#messages .msg .msg-actions');
  check('消息上有操作栏', !!actions);
  if (!actions) return;

  // 平时是透明的（靠 .msg:hover 浮出来）。真鼠标悬停那一条在宿主侧的探针里。
  check(
    '操作按钮不悬停时不露头',
    getComputedStyle(actions).opacity === '0',
    getComputedStyle(actions).opacity
  );
  // 操作栏里那几颗按钮（复制 / 删除 / 分支）的排版 —— 数一下别是空的
  check(
    '操作栏里有按钮',
    actions.querySelectorAll('.mini-btn').length >= 2,
    String(actions.querySelectorAll('.mini-btn').length)
  );
});

// ---------------------------------------------------------------------------
//  请求记录（顶栏「⋯」→ 请求记录）
//
//  它回答的是「这几轮到底给模型发了什么」。数据在主进程内存里（main/request-log.js），
//  所以页面侧只验「列表有没有、详情是不是原文、清空管不管用」——
//  「记下来的那一份对不对」在宿主侧的 probeRequestLog 里（页面看不到真正发出去的东西）。
// ---------------------------------------------------------------------------
await scenario('请求记录：列表、原文 JSON、清空', async () => {
  const convMod = await import(new URL('js/data/conversations.js', document.baseURI).href);
  const redrawMod = await import(new URL('js/views/redraw.js', document.baseURI).href);

  // 先发一条带标记的消息：最新那条记录就认得出来是哪一次
  const MARK = '请求记录标记语';
  convMod.createConvo(true);
  redrawMod.renderAll({ forceScroll: true });
  await sleep(80);

  const beforeMsgs = $$('#messages .msg').length;
  setValue('#input', MARK);
  click('#btn-send');
  await waitFor('这一轮回复出现', () => $$('#messages .msg').length >= beforeMsgs + 2, 8000);
  await waitFor('流式结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);

  // --- 1) 从「⋯」里打开，最新一条排在最前 ---
  await clickMoreItem('#btn-request-log');
  await waitFor('请求记录弹窗打开', () => shown('#requests-modal'));

  const items = $$('#requests-list .requests-item');
  check('刚才那一轮被记下来了', items.length >= 1, `列表里 ${items.length} 条`);

  const first = items[0];
  check(
    '最新一条排在最前面，认得出是我刚发的那句',
    !!first && first.textContent.includes(MARK),
    first ? first.textContent.slice(0, 50) : '（列表是空的）'
  );

  // --- 2) 点开看原文 ---
  if (first) click(first);
  await sleep(60);
  const json = byId('requests-json').textContent;
  check('详情里是我刚那轮的原文 JSON', json.includes(MARK), json.slice(0, 70));
  // 只断言这几个字段「在」—— 它们正是和官方网页版最容易不一样的地方
  check(
    '原文里带着 stream / temperature / max_tokens',
    json.includes('"stream"') && json.includes('"temperature"') && json.includes('"max_tokens"'),
    json.slice(0, 110)
  );
  check('有内容时「复制 JSON」可用', byId('btn-copy-request').disabled === false);

  // --- 3) 清空 ---
  click('#btn-clear-requests');
  await sleep(150);
  check('清空后列表空了', $$('#requests-list .requests-item').length === 0);
  check('清空后「复制 JSON」禁用', byId('btn-copy-request').disabled === true);

  // --- 4) 关掉，别挡着后面的场景 ---
  click('#btn-close-requests');
  await waitFor('请求记录弹窗关掉', () => !shown('#requests-modal'));
});

// ---------------------------------------------------------------------------
//  场景：世界书「＋ 事件」——一条一个事件、靠关键词激活
//
//  和「套用模板」里那条**常驻**的「事件表」配套：前者给地图、后者给开关。
// ---------------------------------------------------------------------------
await scenario('世界书：＋ 事件', async () => {
  await openWorldbookEditor('冒烟测试世界');

  const before = $$('#wb-entry-list .wb-entry').length;
  click('#btn-wb-add-event');
  await waitFor('多出一条条目', () => $$('#wb-entry-list .wb-entry').length === before + 1);

  const title = byId('wb-e-title');
  check('标题预填成「事件：」', title.value.startsWith('事件：'), title.value);
  // 这一条是整个按钮的重点：事件靠关键词激活，**不常驻**
  check('新条目不是常驻（靠关键词激活）', byId('wb-e-constant').checked === false, String(byId('wb-e-constant').checked));
  check('order 预填 888（排在设定那几条之后）', byId('wb-e-order').value === '888', byId('wb-e-order').value);
  check(
    '正文带上了填写骨架（含「关键词」的提示）',
    byId('wb-e-content').value.includes('触发时机') && byId('wb-e-content').value.includes('关键词'),
    byId('wb-e-content').value.slice(0, 40)
  );
  // 焦点落在标题末尾（接着打名字），不是整段选中
  check(
    '光标落在标题末尾，不是整段选中',
    // ⚙ 组件化之后 activeElement 与 selectionStart 都在**里层那颗原生控件**上
    // （宿主用 mirrorSelectionProperties 代理了 selectionStart，所以后面那半仍然成立）
    document.activeElement === asControl(title) && title.selectionStart === title.value.length,
    `${document.activeElement && document.activeElement.id} @${title.selectionStart}`
  );
  check(
    '左栏那一行跟着出现',
    $('#wb-entry-list').textContent.includes('事件：'),
    $('#wb-entry-list').textContent.slice(0, 60)
  );

  // 和别的条目一样只动草稿：没点保存之前磁盘上不该有它
  check(
    '没点「保存」之前不落盘',
    !((await savedWorldbooks())[0].entries || []).some((e) => String(e.title || '').startsWith('事件：')),
    '磁盘上已经出现了事件条目'
  );

  // 收尾：把这条从草稿里删掉，免得影响后面还用这本书的场景
  const rows = $$('#wb-entry-list .wb-entry');
  const del = rows[rows.length - 1].querySelector('.wb-entry-del');
  check('新条目行上有 ×', !!del);
  if (del) del.click();
  await waitFor('草稿里删掉了', () => $$('#wb-entry-list .wb-entry').length === before);
});

// ---------------------------------------------------------------------------
//  场景：开场白选择器
//
//  分两半测：
//    · 组件那一半（选项渲染 / 点谁返回谁 / Esc 返回 null）—— 直接动态 import
//      真模块来调，和宿主侧调 worldbookPayload 是同一个路子；
//    · 接线那一半（只有一条开场白时**不该**弹）—— 走真实点击的开聊流程。
//  多开场白的完整点击流程需要一张「导入进来就带备选开场白」的卡，
//  冒烟里的导入夹具没有这个字段，所以那一半靠导入侧的宿主断言覆盖
//  （见 smoke-test.js 的「备选开场白 / 作者 / 版本」两条）。
// ---------------------------------------------------------------------------
await scenario('开场白：选择器组件', async () => {
  const { pickFromList } = await import(new URL('js/ui/pickList.js', document.baseURI).href);

  // 开着等，先把 DOM 看清楚，再点第二项
  const HTMLISH = '<b>粗体</b> 不该被解释';
  const picked = pickFromList({
    title: '选一条开场白',
    hint: '测试用',
    items: [{ text: '第一条' }, { text: '第二条', note: '默认' }, { text: '第三条' }, { text: HTMLISH }]
  });
  await waitFor('选择器打开', () => shown('#pick-modal'));

  const rows = $$('#pick-list .pick-item');
  check('四条候选都渲染出来了', rows.length === 4, String(rows.length));
  check('标题和说明都填上了', byId('pick-title').textContent === '选一条开场白' && byId('pick-hint').textContent === '测试用',
    `${byId('pick-title').textContent} / ${byId('pick-hint').textContent}`);
  check('角标跟着候选项走', (rows[1].querySelector('.pick-item-note') || {}).textContent === '默认',
    rows[1].textContent.slice(0, 20));
  // 候选正文一律走 textContent —— 卡里的字是不可信内容，不许当 HTML 解释
  check(
    '候选正文里的标签是原样文字（没被解释成 HTML）',
    rows[3].querySelector('b') === null && rows[3].textContent.includes(HTMLISH),
    rows[3].textContent.slice(0, 30)
  );

  click(rows[1]);
  await waitFor('选择器关掉', () => !shown('#pick-modal'));
  check('点第二条返回下标 1', (await picked) === 1, String(await picked));

  // 取消那一路：Esc 必须返回 null，而且不能把底下的弹窗一起关掉
  const cancelled = pickFromList({ title: '再选一次', items: [{ text: '甲' }, { text: '乙' }] });
  await waitFor('选择器又打开了', () => shown('#pick-modal'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor('Esc 后关掉', () => !shown('#pick-modal'));
  check('Esc 返回 null', (await cancelled) === null, String(await cancelled));
});

await scenario('导出：备选开场白 / 作者 / 版本', async () => {
  // 这三个字段在角色编辑器里**没有输入框**（导入专有），导出这一步以前把它们
  // 写死成空值/空数组 —— 一张带 4 条开场白的卡导入再导出就被抹平。直接调真正的
  // 导出函数验（和宿主侧调 worldbookPayload 是同一个路子）。
  const { characterCardPayload } = await import(new URL('js/views/chatExport.js', document.baseURI).href);
  const d = (
    characterCardPayload({
      name: '多开场白测试卡',
      firstMes: '第一条',
      alternateGreetings: ['第二条', '第三条'],
      creator: '某作者',
      characterVersion: '2.2',
      tags: []
    }) || {}
  ).data || {};

  check('备选开场白写回去了', Array.isArray(d.alternate_greetings) && d.alternate_greetings.length === 2, JSON.stringify(d.alternate_greetings));
  check('作者写回去了', d.creator === '某作者', JSON.stringify(d.creator));
  check('版本号写回去了', d.character_version === '2.2', JSON.stringify(d.character_version));
  check('卡名照旧', d.name === '多开场白测试卡', JSON.stringify(d.name));

  // 没有备选开场白的卡：导出成**空数组**（酒馆规范里那就是「没有」），不是 undefined
  const plain = (characterCardPayload({ name: 'X', firstMes: '一', tags: [] }) || {}).data || {};
  check(
    '没有备选开场白时导出空数组',
    Array.isArray(plain.alternate_greetings) && plain.alternate_greetings.length === 0,
    JSON.stringify(plain.alternate_greetings)
  );
});

await scenario('开场白：只有一条时不弹选择器', async () => {
  const NAME = '单开场白测试角色';

  click('#btn-chars');
  await waitFor('切到角色卡页面', () => shown('#view-chars'));
  click('#btn-new-char');
  await waitFor('角色编辑器打开', () => shown('#view-char-editor'));
  setValue('#c-name', NAME);
  setValue('#c-first', '只有这一条开场白');
  click('#btn-save-char');
  await waitFor('保存后弹窗自己关掉', () => !shown('#view-char-editor'));
  await sleep(200);

  const card = $$('#char-page-grid .char-card').find((c) => c.textContent.includes(NAME));
  check('找到了这张卡', !!card);

  // 开聊：只有一条开场白，整条流程里选择器一秒都不该出现
  await startChatWith(card);
  await waitFor('切到聊天视图', () => shown('#view-chat'));
  check('只有一条开场白时没有弹过选择器', !shown('#pick-modal'));

  const convo = await activeConvo();
  const first = (convo.messages || [])[0] || {};
  check(
    '开场白照旧自动插进去了',
    first.greeting === true && String(first.content).includes('只有这一条开场白'),
    JSON.stringify(String(first.content || '').slice(0, 40))
  );
});

// ---------------------------------------------------------------------------
//  控件：自研下拉（renderer/js/ui/select.js）
//
//  13 个原生 <select> 现在是「原生当地基 + 自己画那份列表」。这里走真实用户
//  路径（点一下触发器 → 键盘挪 → 选一行 → 按 Esc），验四件事：
//    · 系统那份列表被按住（mousedown 被 preventDefault）
//    · 弹层挂在 body 上、位置是算出来的、完整落在窗口里、层级在弹窗之上
//    · 键盘上下 / Home / End 挪高亮，Esc **只收弹层**、不关掉底下那一屏
//    · 选完真的写回了原生 <select>，而且它那条 'change' 链照旧生效（落盘为证）
//
//  用「设置 → 外观」里的字体下拉当样本：选项是 HTML 里写死的 4 条，
//  改完会落盘到 settings.uiFont，正好拿来当「change 真的发出去了」的证据。
//
//  ⚙ 2026-10-16 起这一格是**组件化迁移的第一个样本**：`<m-select id="appearance-font">`。
//  所以这个场景顺带把「两层怎么组合」钉住：
//    · 里层仍是原生 <select>（皮肤、自研列表、change 链都还是它）
//    · 宿主按 id 拿到的那个元素，`.value` 是代理、'change' 从里层冒泡上来
//    · 按 id 在**宿主**上派发 mousedown（工具和测试都这么干）也能打开列表
// ---------------------------------------------------------------------------
await scenario('控件：自研下拉（原生 select 与组件 m-select 两条路）', async () => {
  await openAppearanceSection();

  const host = byId('appearance-font');
  const select = host && host.control; // 里层那颗原生 select
  const rows = () => $$('.ctl-select-pop .ctl-opt');
  const activeRow = () => $('.ctl-select-pop .ctl-opt.is-active');
  const at = () => rows().indexOf(activeRow());
  const key = (k) =>
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    );

  check(
    '这一格已经是组件，里层仍是原生 <select>（值的地基没被换成假控件）',
    !!host && host.tagName === 'M-SELECT' && !!select && select.tagName === 'SELECT',
    host ? host.tagName + ' / ' + (select ? select.tagName : '(没有里层)') : '(找不到 #appearance-font)'
  );
  check('接上了自研列表（标记打里层那颗 select 上）', !!select && select.dataset.ctlSelect === 'on');
  check('宿主的 .value 代理到里层', host.value === select.value, `${host.value} / ${select.value}`);
  const before = host.value;

  // --- 批量：文档里**每一个**下拉都要能接上自研列表（不写死 id 清单，按 DOM 推）---
  //  2026-10-16 那批 12 个静态下拉一次迁完，靠的就是这条。
  //  ⚠️ 口径是「**用的时候**接得上」而不是「启动时全都打好标记」：静态那 13 个由
  //  initSelects() 在启动时打标记，动态建出来的那几个（世界书状态筛选等）是
  //  **懒接线** —— 第一次被点到才接。第一版断言写成"启动后全都带标记"，当场红了
  //  （wb-state 还没被点过），红得有道理：断言该写真实保证，不该写愿望。
  {
    const natives = $$('select');
    const unmarked = natives.filter((s) => s.dataset.ctlSelect !== 'on');
    for (const node of unmarked) {
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    }
    if (shown('.ctl-select-pop')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(60);
    }
    check(
      '文档里每个原生 select 用的时候都接得上自研列表（静态的启动就打标记，动态的懒接线）',
      natives.length > 0 && natives.every((s) => s.dataset.ctlSelect === 'on'),
      `共 ${natives.length} 个，没接上的：${natives.filter((s) => s.dataset.ctlSelect !== 'on').map((s) => s.id || s.className).join(' / ') || '(无)'}`
    );

    const hosts = $$('m-select');
    check(
      '每个 m-select 宿主都建出了里层原生控件',
      hosts.every((h) => !!h.control && h.control.tagName === 'SELECT'),
      `共 ${hosts.length} 个宿主，没建出来的：${hosts.filter((h) => !h.control).map((h) => h.id || '(无 id)').join(' / ') || '(无)'}`
    );
    check(
      '宿主的 .value 和里层那颗一致（代理没走偏）',
      hosts.every((h) => h.value === h.control.value),
      hosts.filter((h) => h.control && h.value !== h.control.value).map((h) => `${h.id}:${h.value}≠${h.control.value}`).join(' / ') || '(无)'
    );
    check(
      '宿主的 .disabled 和里层那颗一致',
      hosts.every((h) => h.disabled === h.control.disabled),
      hosts.filter((h) => h.control && h.disabled !== h.control.disabled).map((h) => h.id).join(' / ') || '(无)'
    );
  }

  // --- 点一下触发器：按 id 在**宿主**上派发（工具/测试的常规姿势）---
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  host.dispatchEvent(down);
  await waitFor('自研弹层出现', () => shown('.ctl-select-pop'));
  check('宿主上的合成 mousedown 也能打开列表（组件把它转发给了里层）', shown('.ctl-select-pop'));
  check('焦点落在里层那颗原生控件上（键盘那套连得上）', document.activeElement === select);

  const options = Array.from(select.options);
  const popRect = $('.ctl-select-pop').getBoundingClientRect();
  check('行数 = 原生 option 数', rows().length === options.length, `${rows().length} / ${options.length}`);
  check(
    '每行文字和 option 一一对应',
    rows().map((r) => r.textContent.trim()).join('|') === options.map((o) => o.textContent.trim()).join('|'),
    rows().map((r) => r.textContent.trim()).join('|')
  );
  const ticked = rows().find((r) => r.getAttribute('aria-selected') === 'true');
  check(
    '当前值那一行带勾',
    !!ticked && ticked.textContent.trim() === select.selectedOptions[0].textContent.trim(),
    ticked && ticked.textContent.trim()
  );
  check('弹层挂在 document.body 上（不被设置页的滚动容器裁掉）', $('.ctl-select-pop').parentElement === document.body);
  check(
    '弹层的位置和宽度是算出来的',
    $('.ctl-select-pop').style.left !== '' && $('.ctl-select-pop').style.top !== '' && $('.ctl-select-pop').style.width !== ''
  );
  check(
    '弹层完整落在窗口内（夹回视口那条规则生效了）',
    popRect.left >= 0 && popRect.top >= 0 && popRect.right <= window.innerWidth + 1 && popRect.bottom <= window.innerHeight + 1,
    `${Math.round(popRect.left)},${Math.round(popRect.top)} ${Math.round(popRect.width)}x${Math.round(popRect.height)} @ ${window.innerWidth}x${window.innerHeight}`
  );
  check('层级给到弹窗之上（50/70 那几层压不住它）', Number(getComputedStyle($('.ctl-select-pop')).zIndex) >= 80);

  // --- 键盘 ---
  const start = at();
  check('一打开就高亮当前值那一行', rows()[start] === ticked);
  key('ArrowDown');
  check('↓ 往下走一行', at() === Math.min(start + 1, rows().length - 1), String(at()));
  key('Home');
  check('Home 回到第一行', at() === 0);
  key('ArrowUp');
  check('到头就停住（不绕回最后一行）', at() === 0);
  key('End');
  check('End 走到最后一行', at() === rows().length - 1, String(at()));

  // --- Esc：只收弹层 ---
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitFor('Esc 收起弹层', () => !shown('.ctl-select-pop'));
  check('弹层收起了', !shown('.ctl-select-pop'));
  check('底下的设置页还开着（没被一起关掉）', shown('#view-settings'));
  check('Esc 之后值没被改掉', select.value === before);

  // --- 动态建出来的下拉：文档级懒接线（属性类型 / 更新频率 / 分组 / 世界书状态
  //     这 4 个都是渲染时现建的，启动时那次扫描扫不到它们）---
  const fresh = document.createElement('select');
  fresh.setAttribute('aria-label', '临时下拉（这条只验接线）');
  for (const value of ['甲', '乙']) fresh.appendChild(new Option(value, value));
  document.body.appendChild(fresh);
  check('刚建出来的下拉还没打过标记', !fresh.dataset.ctlSelect);
  fresh.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  await waitFor('动态下拉也弹出自己的列表', () => shown('.ctl-select-pop'));
  check('动态下拉被就地接上（懒接线生效）', fresh.dataset.ctlSelect === 'on');
  check('动态下拉的列表里就是它那两项', rows().length === 2, String(rows().length));
  fresh.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  check('再点一下触发器就收起（不留下一个悬空的列表）', !shown('.ctl-select-pop'));
  fresh.remove();

  // --- 选一行 ---
  //  页面自己的接线是「监听宿主」（appearance.js 就是 `el.appearanceFont.addEventListener('change')`），
  //  所以这里挂一个宿主上的监听，验里层那条 change 真的冒泡上来了
  let hostChanges = 0;
  host.addEventListener('change', () => {
    hostChanges += 1;
  });

  const target = options.find((o) => o.value !== select.value) || options[0];
  select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  await waitFor('弹层又开了', () => shown('.ctl-select-pop'));
  click(rows()[options.indexOf(target)]);
  check('值写回了原生 <select>', select.value === target.value, `${before} → ${select.value}`);
  check('宿主的 .value 跟着新值（代理）', host.value === target.value, host.value);
  check('里层的 change 冒泡到了宿主（页面按宿主监听照旧收得到）', hostChanges === 1, String(hostChanges));
  check('弹层自己收起（不用再点一下）', !shown('.ctl-select-pop'));
  check('焦点回到触发器上', document.activeElement === select);

  await sleep(250);
  const saved = (await window.mimitale.getSettings()).settings;
  check('change 照旧触发（外观字体已落盘）', saved.uiFont === target.value, `落盘的是 ${saved.uiFont}`);

  // 复原：别把「外观字体」留在改过的那一档，也别把设置页停在外观那一组
  setValue('#appearance-font', before);
  await sleep(150);
  await leaveAppearanceSection();
});

// ---------------------------------------------------------------------------
//  组件库：自定义元素（renderer/js/components/）
//
//  上面那个场景验的是「原生 <select> 换成自研列表」，这个场景验的是**组件层**：
//  每个组件都是「宿主 + 里层一个原生控件」，页面只挑 variant/size 和属性。
//  这里在真页面里临时搭一棵树（不碰应用自己的 DOM），跑完删掉。
//
//  三件最要紧的事：
//    · 里层原生控件的属性转发 / 事件冒泡 / .value 代理都要通
//    · m-select 里的原生 <select> 也要被自研列表接上（两层自动组合）
//   （原「组件皮肤和老 .btn 一致」那条已删：2026-10-17 `.btn` 皮肤半边退役，
//    皮肤现在只有 `.mi-btn__control` 一份定义，没有可比的第二份了。）
// ---------------------------------------------------------------------------
await scenario('组件库：自定义元素（m-button / m-input / m-textarea / m-select）', async () => {
  const tags = ['m-button', 'm-input', 'm-textarea', 'm-select'];
  check(
    '四个组件都在启动时注册了（必须在第一次渲染之前）',
    tags.every((tag) => !!customElements.get(tag)),
    tags.map((tag) => `${tag}:${customElements.get(tag) ? '✓' : '✗'}`).join(' ')
  );

  const host = document.createElement('div');
  host.className = 'smoke-component-host';
  document.body.appendChild(host);

  // ---- m-button ----
  const btn = document.createElement('m-button');
  btn.setAttribute('variant', 'primary');
  btn.textContent = '保存';
  host.appendChild(btn);
  await waitFor('m-button 升级出里层按钮', () => !!btn.querySelector('.mi-btn__control'));

  const innerBtn = btn.querySelector('.mi-btn__control');
  check('里层是原生 <button>', innerBtn.tagName === 'BUTTON');
  check('外观类名拼对了', btn.classList.contains('mi-btn') && btn.classList.contains('mi-btn--primary'), btn.className);
  check('标签形态的文字收进了 label', btn.querySelector('.mi-btn__label').textContent === '保存');
  check('宿主里只剩那颗按钮（没留下游离文本节点）', btn.childNodes.length === 1, String(btn.childNodes.length));

  let clicked = 0;
  btn.addEventListener('click', () => {
    clicked += 1;
  });
  btn.click();
  check('程序化 click() 转发到了里层原生按钮', clicked === 1, String(clicked));

  btn.textContent = '保存中…';
  check(
    'textContent 改文字之后组件没散架（原生 setter 会把里层按钮删掉）',
    !!btn.querySelector('.mi-btn__control') && btn.querySelector('.mi-btn__label').textContent === '保存中…'
  );

  btn.disabled = true;
  check('disabled 转发到里层原生按钮', innerBtn.hasAttribute('disabled'));
  btn.disabled = false;
  check('取消 disabled 也转发', !innerBtn.hasAttribute('disabled'));

  btn.classList.add('preset-row-delete');
  btn.setAttribute('variant', 'ghost');
  check(
    '切 variant 只换组件自己的类，页面自己加的类留着',
    btn.classList.contains('mi-btn--ghost') && !btn.classList.contains('mi-btn--primary') && btn.classList.contains('preset-row-delete'),
    btn.className
  );

  // ---- m-input ----
  const field = document.createElement('m-input');
  field.setAttribute('placeholder', '角色名');
  field.setAttribute('aria-label', '角色名');
  field.value = '小满'; // 还没进文档 → 走"待应用的值"
  host.appendChild(field);
  await waitFor('m-input 升级出里层输入框', () => !!field.querySelector('input'));

  const innerInput = field.querySelector('input');
  check('里层是原生 <input>，而且带 type=text（全局皮肤靠这个属性选择器命中）', innerInput.tagName === 'INPUT' && innerInput.getAttribute('type') === 'text');
  check('进文档前设的 .value 也被应用了', innerInput.value === '小满', innerInput.value);
  check('aria-label 转发到里层（h() 里写 ariaLabel 会落到无效的 arialabel，组件入口修掉了）', innerInput.getAttribute('aria-label') === '角色名');
  check('placeholder 转发', innerInput.getAttribute('placeholder') === '角色名');
  check('拼写检查默认关（这个项目的口径）', innerInput.getAttribute('spellcheck') === 'false');

  let bubbled = 0;
  field.addEventListener('input', () => {
    bubbled += 1;
  });
  innerInput.value = '改了';
  innerInput.dispatchEvent(new Event('input', { bubbles: true }));
  check('里层原生事件冒泡到宿主（不用重新派发）', bubbled === 1, String(bubbled));
  check('.value 代理到里层', field.value === '改了', field.value);

  field.disabled = true;
  check('m-input 的 disabled 也转发', innerInput.hasAttribute('disabled'));
  field.disabled = false;

  // 直接设 property（视图里到处这么写：`el.c.attrNew.placeholder = …`）。
  // `<m-input>` 不是 HTMLInputElement —— 没有 reflectProperties 的话这一行只会挂到
  // 宿主对象上，里层那颗原生 input 永远收不到（不报错、也不生效）。
  field.placeholder = '往「关系」里加一个属性';
  check(
    '`.placeholder` 这种 property 写法也桥到了里层',
    innerInput.getAttribute('placeholder') === '往「关系」里加一个属性',
    innerInput.getAttribute('placeholder')
  );

  // focus / blur **不冒泡**：页面代码在控件上监听它们（stateCard 的编辑行就靠 blur
  // 把值落盘），组件化之后监听对象变成了宿主 —— 不做桥接，这条链路会静默失效。
  {
    let focuses = 0;
    let blurs = 0;
    field.addEventListener('focus', () => {
      focuses += 1;
    });
    field.addEventListener('blur', () => {
      blurs += 1;
    });
    innerInput.focus();
    await sleep(30);
    check('focus() 转发到里层那颗原生 input 上', document.activeElement === innerInput);
    // ⚠️ 冒烟窗口是**隐藏**的，这种窗口里 Chromium 不发 focus / blur **事件**
    // （`.focus()` 仍会改 activeElement，上面那条就是这么过的）。所以桥这一层
    // 用合成事件验 —— 走的是**同一个**监听器（组件挂在里层控件上的那个），
    // 验的是"里层有 focus / blur 时宿主收得到"。
    innerInput.dispatchEvent(new FocusEvent('focus'));
    innerInput.dispatchEvent(new FocusEvent('blur'));
    check('里层的 focus 桥到了宿主', focuses === 1, String(focuses));
    check('里层的 blur 桥到了宿主（「失焦才提交」那条链路靠它）', blurs === 1, String(blurs));
  }

  // 原生控件的**方法**也要转发：页面里有 `el.c.name.select()`（打开编辑器后选中名字，
  // 一打字就整段替换）和 `setSelectionRange()`（把光标放到末尾）。
  // 不转发就是一个 TypeError —— 这轮就是这么炸出 23 条控制台报错的。
  {
    field.value = '小满';
    field.select();
    check('select() 转发到里层（选中整段）', innerInput.selectionStart === 0 && innerInput.selectionEnd === 2, `${innerInput.selectionStart}~${innerInput.selectionEnd}`);
    field.setSelectionRange(1, 1);
    check('setSelectionRange() 转发到里层（光标位置）', innerInput.selectionStart === 1 && innerInput.selectionEnd === 1, `${innerInput.selectionStart}~${innerInput.selectionEnd}`);
  }

  // ---- m-textarea ----
  const area = document.createElement('m-textarea');
  area.setAttribute('rows', '5');
  area.value = '多行\n文本';
  host.appendChild(area);
  await waitFor('m-textarea 升级出里层多行框', () => !!area.querySelector('textarea'));

  const innerArea = area.querySelector('textarea');
  check('里层是原生 <textarea>', innerArea.tagName === 'TEXTAREA');
  check('rows 转发', innerArea.getAttribute('rows') === '5', innerArea.getAttribute('rows'));
  check('值转发（含换行）', innerArea.value === '多行\n文本', JSON.stringify(innerArea.value));

  const defaultArea = document.createElement('m-textarea');
  host.appendChild(defaultArea);
  await waitFor('缺省 rows 的多行框升级', () => !!defaultArea.querySelector('textarea'));
  check('rows 缺省是 3（和 index.html 里那些多行框字段同一个口径）', defaultArea.querySelector('textarea').getAttribute('rows') === '3');

  // ---- m-select（和自研下拉列表自动组合）----
  const picker = document.createElement('m-select');
  picker.setAttribute('aria-label', '界面字体');
  picker.appendChild(new Option('系统默认', 'default'));
  picker.appendChild(new Option('思源黑体', 'noto'));
  host.appendChild(picker);
  await waitFor('m-select 升级出里层下拉', () => !!picker.querySelector('select'));

  const innerSelect = picker.querySelector('select');
  check('里层是原生 <select>', innerSelect.tagName === 'SELECT');
  check('声明式选项被搬进了里层（宿主里只剩那颗 select）', innerSelect.options.length === 2 && picker.children.length === 1, `${innerSelect.options.length} / ${picker.children.length}`);
  check('.options 代理', picker.options.length === 2);
  picker.value = 'noto';
  check('.value 代理到里层', innerSelect.value === 'noto', innerSelect.value);

  const controlsMod = await import(new URL('js/ui/controls.js', document.baseURI).href);
  controlsMod.fillSelect(picker, [
    { value: 'a', text: '甲（动态铺的）' },
    { value: 'b', text: '乙（动态铺的）' }
  ]);
  check(
    'fillSelect 认 <m-select>：选项真的进了里层 select',
    innerSelect.options.length === 2 && innerSelect.options[0].textContent === '甲（动态铺的）',
    `${innerSelect.options.length} 项，第一项 ${innerSelect.options[0] && innerSelect.options[0].textContent}`
  );

  innerSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  await waitFor('组件里的下拉也弹出自研列表', () => shown('.ctl-select-pop'));
  check('m-select 里的原生 select 被自研列表接上了（两层自动组合）', innerSelect.dataset.ctlSelect === 'on');
  check('列表里就是它那两项', $$('.ctl-select-pop .ctl-opt').length === 2, String($$('.ctl-select-pop .ctl-opt').length));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitFor('Esc 收起组件里的下拉列表', () => !shown('.ctl-select-pop'));
  check('Esc 之后值没被改掉', picker.value === 'a', picker.value);

  host.remove();
});

// ---------------------------------------------------------------------------
//  场景：列表页批量选择（角色卡 / 世界书）
//
//  只验「选得对不对、按钮切没切、跨搜索保不保得住」—— 导出会弹系统文件夹框、
//  删除会真删数据，这两步在冒烟里不点；它们的编排逻辑放在宿主侧静态断言里
//  （tools/smoke-test.js 的 probeBatchLibrary）。
// ---------------------------------------------------------------------------
await scenario('批量：角色卡与世界书的选择态', async () => {
  click('#btn-chars');
  await waitFor('切到角色卡', () => shown('#view-chars'));
  await sleep(120);

  check('常态只露「批量」一颗', shown('#char-batch-normal') && !shown('#char-batch-active'));

  // 常态下每张卡右上角那颗删除 × 必须在（静止 opacity 0，靠 hover 浮出）——
  // 2026-10-19 星宝报「删除按钮不见」，先量一遍它到底在不在 DOM 里、是不是被藏了
  const idleDel = $('#char-page-grid .char-card .char-card-del');
  check(
    '常态下卡片有删除按钮（没被藏掉）',
    !!idleDel && getComputedStyle(idleDel).display !== 'none',
    idleDel ? `display=${getComputedStyle(idleDel).display} opacity=${getComputedStyle(idleDel).opacity}` : 'DOM 里没有 .char-card-del'
  );

  click('#btn-char-batch');
  await sleep(120);
  check('点「批量」进入选择态', shown('#char-batch-active') && !shown('#char-batch-normal'));
  // 选择态里整卡就是一个勾选框，末尾那张「添加」卡跟着收起来（它勾不了，也不该混进去）
  check('选择态里「添加」卡收起来', !$('#char-page-grid .lib-add-card'));

  const cards = $$('#char-page-grid .char-card');
  check('卡片都成了可点选的格子', cards.length > 0 && cards.every((c) => c.classList.contains('is-selectable')));
  check('每张卡左上角有勾选圈', cards.length > 0 && cards.every((c) => !!c.querySelector('.char-card-check')));

  // 封面上的放大镜是挂在 img 自己身上的（.wb-card-cover img { cursor: zoom-in }），
  // 选择态里如果压不住，鼠标移到图上就变成「能放大」，和「点一下选中」打架。
  // 这条只能量计算样式 —— 光看源码里有没有 pointer 是看不出来的。
  const coverImgs = $$('#char-page-grid .char-card .wb-card-cover img');
  check(
    '选择态下封面光标跟着整卡走（不是放大镜）',
    coverImgs.every((img) => getComputedStyle(img).cursor === 'pointer'),
    coverImgs.map((img) => getComputedStyle(img).cursor).join(',') || '（这页没有封面图）'
  );

  // 选择态里 × 也要留着：一批里发现某张不该留，能直接删掉它，不用先退出再找。
  // 星宝 2026-10-19 报过「右上角的删除按钮不见」—— 当时是被 display:none 藏了。
  const selDel = $('#char-page-grid .char-card .char-card-del');
  check(
    '选择态里右上角的 × 还在，而且是看得见的（不用悬停）',
    !!selDel && getComputedStyle(selDel).display !== 'none' && getComputedStyle(selDel).opacity === '1',
    selDel ? `display=${getComputedStyle(selDel).display} opacity=${getComputedStyle(selDel).opacity}` : 'DOM 里没有 ×'
  );

  // 点第一张：DOM 会整块重绘，之后一律重新查询，别复用旧节点
  cards[0].click();
  await sleep(80);
  check('点一张 → 计数变成 1', byId('char-batch-count').textContent.includes('1'), byId('char-batch-count').textContent);
  check(
    '被点的那张画上了选中态',
    $$('#char-page-grid .char-card').filter((c) => c.classList.contains('is-selected')).length === 1
  );

  // 搜索换一批之后，选中集合要保住（批量删最常用的姿势：搜一轮选几张、再搜一轮）
  const searchHost = byId('char-page-search');
  const searchInput = searchHost.tagName === 'INPUT' ? searchHost : searchHost.querySelector('input');
  searchInput.value = 'zzz-不会命中';
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(120);
  check('搜索换一批之后，选中数没被清掉', byId('char-batch-count').textContent.includes('1'), byId('char-batch-count').textContent);
  searchInput.value = '';
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(120);

  // 全选：只作用于当前可见的这批
  const visible = $$('#char-page-grid .char-card').length;
  click('#btn-char-select-all');
  await sleep(80);
  check(
    '全选把当前可见的都选上',
    byId('char-batch-count').textContent.includes(String(visible)),
    `${byId('char-batch-count').textContent} / 可见 ${visible}`
  );
  check('全选按钮的文案变成「取消全选」', byId('btn-char-select-all').textContent.includes('取消全选'));

  click('#btn-char-select-all');
  await sleep(80);
  check('再点一次全取消', byId('char-batch-count').textContent.includes('0'), byId('char-batch-count').textContent);

  // 取消退出选择态：卡片恢复「编辑 / 聊天」
  click('#btn-char-batch-exit');
  await sleep(100);
  check('取消后退出选择态', shown('#char-batch-normal') && !shown('#char-batch-active'));
  check(
    '退出后卡片不再是选择格子',
    $$('#char-page-grid .char-card').every((c) => !c.classList.contains('is-selectable'))
  );
  check('退出选择态后「添加」卡回到末尾', !!$('#char-page-grid .lib-add-card'));
});

// ---------------------------------------------------------------------------
//  场景：消息导航条（右缘那一竖排轮次刻度）
//  ⚠️ 它是按 DeepSeek Harness 的 turn rail 做的：**一轮一根**、等距 10px、
//     框内自己滚。这里不验像素级位置（那要写死期望值、改一次样式就红），只验：
//     有没有、条数对不对、等不等距、当前那根有没有、悬停卡片弹出/收起、点得动。
// ---------------------------------------------------------------------------
await scenario('消息导航条（轮次刻度）', async () => {
  click('#convo-list .convo-item');
  await waitFor('切回聊天视图', () => shown('#view-chat'));

  const rail = byId('msg-rail');
  check('#msg-rail 存在（index.html 里那个容器）', !!rail);

  // 两轮以下不出现 —— 先把这个会话喂到够长（末尾场景，后面没人接着跑）
  let guard = 0;
  while ($$('#messages .msg').length < 5 && guard < 4) {
    const before = $$('#messages .msg').length;
    setValue('#input', `冒烟测试：导航条第 ${guard + 1} 句`);
    click('#btn-send');
    await waitFor('补一条消息', () => $$('#messages .msg').length >= before + 2, 8000);
    await waitFor('这一轮流式结束', () => byId('btn-send').getAttribute('data-mode') === 'send', 8000);
    guard += 1;
  }

  const msgNodes = $$('#messages .msg');
  check('会话里至少 5 条消息（两轮以下刻度按规矩隐藏）', msgNodes.length >= 5, `实际 ${msgNodes.length}`);
  check('轮次够了，刻度条就显示出来', shown('#msg-rail'));

  // 渲染完要等一帧：layout 是 requestAnimationFrame 排的，紧接着读会读到 0 高
  await sleep(150);

  const marks = $$('#msg-rail .msg-rail-mark');
  // 轮数 = 开头的开场白（若有）算一轮 + 每条用户消息开一轮
  let expectedTurns = 0;
  msgNodes.forEach((node, index) => {
    if (index === 0 || node.classList.contains('user')) expectedTurns += 1;
  });
  check(
    '刻度数 = 轮数（你的一句 + 它后面的回复算一轮）',
    marks.length === expectedTurns,
    `刻度 ${marks.length} / 轮 ${expectedTurns} / 消息 ${msgNodes.length}`
  );

  // 位置：框竖着居中在消息区里，且不会高到吃掉整个对话
  const railBox = rail.getBoundingClientRect();
  const msgBox = byId('messages').getBoundingClientRect();
  check(
    '框竖着居中在消息区里',
    Math.abs(railBox.top + railBox.height / 2 - (msgBox.top + msgBox.height / 2)) < 2,
    `rail 中心=${(railBox.top + railBox.height / 2).toFixed(1)} / messages 中心=${(msgBox.top + msgBox.height / 2).toFixed(1)}`
  );
  check('框最高不超过 420px（再多就在框内滚）', railBox.height <= 421, `实际 ${railBox.height.toFixed(1)}`);

  // 等距 10px：这是和「按真实高度比例」最本质的差别
  const tops = marks.map((mark) => mark.offsetTop);
  check(
    '刻度等距排（10px 一档，不是按消息高度比例）',
    tops.every((value, index) => index === 0 || value - tops[index - 1] === 10),
    tops.join(',')
  );

  // 回到底部：发完消息本来就该在底部。隐藏窗口不保证自己派 scroll 事件，
  // 这里手动派一次 —— 验的是「贴底时当前刻度是哪一根」，不是「浏览器会不会通知」。
  const messagesEl = byId('messages');
  messagesEl.scrollTop = messagesEl.scrollHeight;
  messagesEl.dispatchEvent(new Event('scroll'));
  await sleep(80);

  // 当前那一轮：只许有一根，且贴底时是最后一轮
  const active = marks.filter((mark) => mark.classList.contains('is-active'));
  check('有且只有一根「当前」刻度', active.length === 1, active.length);
  check(
    '贴底时当前刻度是最后一轮',
    marks[marks.length - 1].classList.contains('is-active'),
    `当前=${marks.findIndex((mark) => mark.classList.contains('is-active'))} / 共 ${marks.length} 根`
  );

  // 看得见才算数：默认那根细条有颜色、不是全透明；当前这根更长更实。
  // ⚠️ 隐藏窗口不推进过渡 —— 不先把 transition 关掉，量到的永远是过渡的**起点值**
  //    （试过：active 和 idle 三项一模一样，正是 .4 / scaleX(.6) 那组起始样式）。
  const noTransition = document.createElement('style');
  noTransition.textContent = '#msg-rail .msg-rail-mark::before{transition:none !important}';
  document.head.appendChild(noTransition);
  const idleBar = getComputedStyle(marks[0], '::before');
  const activeBar = getComputedStyle(active[0], '::before');
  const idleStyle = {
    color: idleBar.backgroundColor,
    opacity: idleBar.opacity,
    transform: idleBar.transform
  };
  const activeStyle = {
    color: activeBar.backgroundColor,
    opacity: activeBar.opacity,
    transform: activeBar.transform
  };
  noTransition.remove();
  check(
    '刻度有可见的颜色和透明度',
    idleStyle.color !== 'rgba(0, 0, 0, 0)' && Number(idleStyle.opacity) >= 0.3,
    `${idleStyle.color} @ opacity=${idleStyle.opacity}`
  );
  check(
    '当前刻度比其它刻度更长更实（100% / 最不透明）',
    Number(activeStyle.opacity) > Number(idleStyle.opacity) &&
      activeStyle.color !== idleStyle.color &&
      activeStyle.transform !== idleStyle.transform,
    `active=${activeStyle.color} @ ${activeStyle.opacity} ${activeStyle.transform} / idle=${idleStyle.color} @ ${idleStyle.opacity} ${idleStyle.transform}`
  );

  // 悬停浮层：你的话 + 回复摘要，贴在刻度条左边（不能盖住正文）
  marks[0].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  await waitFor('悬停后卡片出现', () => shown('#msg-rail .msg-rail-preview'));
  const preview = $('#msg-rail .msg-rail-preview');
  check('卡片里有内容（你那句话 / 回复摘要）', preview.textContent.trim().length > 0, preview.textContent);
  check(
    '卡片贴在刻度条左边，不压正文',
    preview.getBoundingClientRect().right <= railBox.left + 1,
    `card right=${preview.getBoundingClientRect().right.toFixed(1)} rail left=${railBox.left.toFixed(1)}`
  );
  $('#msg-rail .msg-rail-scroller').dispatchEvent(new PointerEvent('pointerleave'));
  await waitFor('鼠标移开后卡片收起', () => !shown('#msg-rail .msg-rail-preview'));

  // 滚到顶上，「当前刻度」要跟着换成第一轮
  messagesEl.scrollTop = 0;
  messagesEl.dispatchEvent(new Event('scroll'));
  await sleep(80);
  check(
    '滚到顶上时当前刻度换成第一轮',
    marks[0].classList.contains('is-active'),
    `当前=${marks.findIndex((mark) => mark.classList.contains('is-active'))}`
  );

  // 点刻度能不能跳到那一轮的开头。
  // ⚠️ 不断言 scrollTop：冒烟窗口是隐藏的，Chromium 不推进平滑滚动动画，
  //    这里等多久 scrollTop 都不会动 —— 那是测试环境的限制，不是功能坏了。
  //    改验同步副作用：jumpTo 命中目标后会给那条消息挂 .msg-rail-flash。
  const lastMark = marks[marks.length - 1];
  const lastIndex = Number(lastMark.dataset.index);
  const target = $(`#messages .msg[data-index="${lastIndex}"]`);
  check('最后一根刻度指得到真实的消息节点', !!target, `data-index=${lastIndex}`);
  click(lastMark);
  check('点刻度命中了那一轮的开头消息（落点会闪一下）', !!target && target.classList.contains('msg-rail-flash'));
  check('点完当前刻度也跟着切过去', lastMark.classList.contains('is-active'));
});

// 筛选一个场景都没匹配上时，「0 条断言 0 条失败」会装成通过 —— 必须显式拦下。
// （比如 --only=世界書 打成繁体、或者场景名改过之后旧参数还在。）
if ((SCENARIO_FILTER.only || []).length + (SCENARIO_FILTER.skip || []).length > 0 && !timings.length) {
  check(
    '筛选没匹配到任何场景（0 条断言不能算通过）',
    false,
    `--only=${(SCENARIO_FILTER.only || []).join(',') || '-'} --skip=${(SCENARIO_FILTER.skip || []).join(',') || '-'}` +
      ' —— 场景名用子串匹配，先跑 --list 看一眼'
  );
}

return { results, notes, hoverProbe, timings, skippedScenarios };
