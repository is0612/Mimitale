'use strict';

// ============================================================================
//  smoke-test.js —— 冒烟测试（不属于应用代码，不参与打包）
//
//  跑法： npm run smoke
//
//  它干什么：
//    开一个「不显示」的 Electron 窗口，加载**真实的** renderer/index.html，
//    但把所有 IPC 都换成内存里的假后端 —— 所以它既跑的是真界面，
//    又**不会碰你的 userData**，随便跑，不会弄坏你的角色和会话。
//
//  为什么要它：
//    界面逻辑还在往 ES module 一层层拆。有了它，每拆一步都能自动验一遍
//    「功能还在不在」—— 光靠手点，拆错了要很久以后才发现。
//
//  断言写在 tools/smoke-renderer.js 里（那部分代码跑在页面里）。
//  想肉眼核对界面（间距 / 对齐 / 配色），加 --shot=<场景>，见 README。
// ============================================================================

const { app, BrowserWindow, ipcMain } = require('electron');

// 测试只做 DOM 断言，用不到 GPU。某些环境（无独显/远程桌面/驱动异常）的 GPU
// 进程会反复崩溃把主进程一起带走，表现为「页面加载失败：ERR_FAILED」。
// 关硬件加速就没有这个噪声；另一半在 package.json 的 --no-sandbox。
// 这两个脚本不加载外部内容、IPC 全是内存假后端，关掉无副作用。
app.disableHardwareAcceleration();

const fs = require('fs');
const path = require('path');
const os = require('os');

// 数据目录隔离（2026-10-08 起数据默认放在「程序旁边的 data\」）。
// 这条必须在 require 任何 main/ 模块**之前**设好，否则这个测试会去动
// 开发机真正的 data\ 目录 —— 那里面是真实的角色卡和会话。
// 上面那句「不会碰你的 userData」的承诺就靠这一行兑现。
// （MIMITALE_DATA_DIR 的优先级低于显式 app.setPath('userData')，
//   所以下面 probeStoreWriteFailure 自己指到临时目录那套照旧生效。）
process.env.MIMITALE_DATA_DIR = path.join(os.tmpdir(), 'mimitale-smoke-data');

// 账号的图形校验码：主进程只在测试模式下把答案一起回给界面（真后端绝不回）。
// 没有它，注册 / 登录那几条链路（要填图上的 4 位）一步都走不过去。
process.env.MIMITALE_ACCOUNT_TEST = '1';

// 设置落盘归一化：和 main.js 的 settings:save 跑的是同一份。
// 假后端以前只做 Object.assign，等于**跳过**了归一化 —— 归一化里删错一个键
// （maxTurns 就被 `delete s.maxTurns` 删过）测试照样全绿，真机上却怎么改都不生效。
const { DEFAULT_SETTINGS, normalizeSettings, ACCENTS } = require('../main/providers.js');

// 关键：用**主进程真正在用的**归一化，而不是自己糊一套。
// 角色「属性」丢过一次，就是因为假后端只做存取、不做归一化 ——
// 主进程白名单漏了字段，测试却全绿。现在这段往返走的是同一份代码。
const { normalizeCharacter } = require('../main/characters.js');
// 导出 PNG 卡要插 tEXt 块、导入要读回来 —— 用同一份实现，才能测真正的往返
const { pngWithTextChunk, parseCharacterCardPng } = require('../main/png.js');
// 世界书匹配（含递归扫描）也用真实现
const { matchWorldbookEntries, formatWorldbookSections } = require('../main/worldbook-match.js');
// 导入链路的编排：读文件 → 解析 → 自动绑定。
// 以前 characters:import 在冒烟测试里是个 `{canceled:true}` 的桩，
// 所以「卡里内嵌的世界书被丢掉」「导入后绑定指到不存在的书」这类 bug 测不出来。
const { importFiles } = require('../main/import-files.js');
// 导入时的形状识别 / 归一化：和主进程 handler 跑的是同一份
const { parseImportFile } = require('../main/card-import.js');
// 世界书落盘归一化：和 main.js 的 worldbooks:save 跑的是同一份
const { createWorldbookNormalizer } = require('../main/worldbook-store.js');
// 预设落盘归一化：和 main.js 的 presets:save 跑的是同一份。
// 「描述是给人看的、正文是给模型看的」这条规则只在归一层，假后端只 clone
// 的话，「导入来的预设正文住在 metadata.systemPromptContent」就测不出来了。
const { normalizePreset } = require('../main/presets.js');
// 「请求记录」用的两样真东西：
//   · request-log.js —— 环形缓冲本身（假后端记进去、页面侧读到、上限也由它管）
//   · http.js 的 streamChat —— onRequest 是不是在请求发出去**之前**就触发了。
//     这条只能在这儿验：页面看不到真正发出去的东西，而假后端根本不发网络请求。
const { recordRequest, listRequests, clearRequests, MAX_ENTRIES: MAX_LOGGED_REQUESTS } = require('../main/request-log.js');
const { streamChat, bridgeChat } = require('../main/http.js');
// 面板字段的类型/范围/变化规则/分组：主进程和渲染层共用的那一份
const {
  clampFieldValue,
  normalizePanelField,
  normalizePanelFields,
  groupPanelFields,
  fieldProgress,
  describePanelField
} = require('../main/panel-fields.js');
// 语义检索的向量工具也用真实现（编解码 / 余弦 / topK 都是它）
const {
  hashText,
  encodeVector,
  decodeVector,
  cosineSimilarity,
  rankBySimilarity,
  collectCandidates
} = require('../main/vectors.js');

const APP_DIR = path.join(__dirname, '..');
// 兜底超时。⚠️ 它是**整套**的墙钟上限，不是单个场景的 —— 场景越加越多，
// 2026-09-30 加进「世界书：保存后才生效 / 卡片上删除」之后原来那 90 秒就不够了
// （跑到「剧情选项」正好卡线，看上去像卡死，其实只是还没跑完）。
// 2026-10-23 又顶满了：账号场景这批加进来后整套要 ~260s（流式场景每个 5-8s
// 是大头），150s 时跑到「Esc 链」正好被误杀 —— 加到 300s。
// 分辨「卡死还是慢」别靠猜：`--progress` 会按场景打印进度。
const OVERALL_TIMEOUT_MS = 300000;

// --shot-only：**只出图，不跑断言**。
//
// 为什么要有它：--shot=<场景> 原来必须等整套断言跑完才轮得到截图 ——
// 改一行 CSS 想看效果，也要先等 1 分半。这不是「测试严谨」，是**工具用错了**：
// 光看样式根本不需要 800 条断言，需要的是几秒钟出一张图。
// 加了它之后：直接灌一份给截图用的种子数据 → 打开场景 → 拍照，几秒钟的事。
//
// ⚠️ 它**不产生任何断言结果**，所以别拿它当验证 —— 出图归出图，验证还得跑整套。
// ⚠️ 依赖场景副作用搭出来的界面（会话 / 面板 / 状态卡那类）在这里是空的：
//    那种场景请老实跑整套。这里够用的是「纯布局」那批：
//    chars / charArt / charEditor / charAttrs / charTextareas / worldbook /
//    worldbookPage / settings / modelMenu / moreMenu。
const SHOT_ONLY = process.argv.includes('--shot-only');

// ---------------------------------------------------------------------------
//  场景筛选（2026-10-23）
//
//  为什么要它：整套 1871 条断言跑 90 秒，可改一行世界书代码也得等全场跑完 ——
//  和当初加 --shot-only 是同一个毛病（见上面那段）：**工具用错了**，不是严谨。
//  按场景筛过之后，「改世界书」这类活儿只跑十来个场景、两三秒出结果。
//
//  用法：
//    --only=世界书          只跑名字里含「世界书」的场景（子串匹配）
//    --only=世界书,账号     逗号分隔，命中任一即跑
//    --skip=账号,桌宠       跳过命中项，其余照跑
//    --list                 只列出所有场景名（秒出，不开窗口）
//
//  ⚠️ 场景之间有先后依赖：后面的场景会蹭前面留下的会话 / 角色 / 世界书。
//     单独跑某个场景时它是「从干净状态出发」的，断言红了先怀疑这一点，
//     别急着改代码。所以 --only 只适合**迭代时自查**，
//     提代码之前的验收仍然要跑整套（报告末尾会提醒）。
// ---------------------------------------------------------------------------
const listArg = (name) => {
  const raw = process.argv.find((a) => a.startsWith(name + '='));
  if (!raw) return [];
  return raw
    .slice(name.length + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};
const ONLY = listArg('--only');
const SKIP = listArg('--skip');
// --group=<域>：只跑一个功能域（见 tools/smoke-groups.js）。
// 走 pick（**精确名单**）而不是 only（子串）—— 域里同时有「剧情选项」和
// 「剧情选项：默认开」，子串匹配会让前者把后者一起捞进来，反过来还会捞进
// 「帮我想想（补一批剧情选项）」。精确名单才能保证「这一域就这么多条」。
const GROUPS = require('./smoke-groups.js').GROUPS;
// 两种写法都认：`--group=chat` 和 `--group chat`（npm script 只能在末尾接参数，
// 写成 `--group` 才能让 `npm run smoke:group -- chat` 拼得上）。
const GROUP_EQ = (process.argv.find((a) => a.startsWith('--group=')) || '').split('=')[1] || '';
const GROUP_POS = process.argv.indexOf('--group');
const GROUP_KEY = GROUP_EQ || (GROUP_POS >= 0 ? process.argv[GROUP_POS + 1] || '' : '');
if (GROUP_KEY === 'list') {
  console.log('\n  域（--group=<名字>）：\n');
  for (const [key, g] of Object.entries(GROUPS)) {
    console.log(`    ${key.padEnd(10)} ${g.label}（${g.scenarios.length} 个场景）`);
  }
  console.log('');
  process.exit(0);
}
if (GROUP_KEY && !GROUPS[GROUP_KEY]) {
  console.error(`\n  没有这个域：${GROUP_KEY}\n  可用的有：${Object.keys(GROUPS).join(' / ')}\n`);
  process.exit(2);
}
const PICK = GROUP_KEY ? GROUPS[GROUP_KEY].scenarios : [];
const FILTERED = ONLY.length > 0 || SKIP.length > 0 || PICK.length > 0;
// --verbose：逐条打印断言。默认只按场景打一行汇总 —— 1871 行刷屏没人看，
// 想看细节时再加这个参数。
const VERBOSE = process.argv.includes('--verbose');

// --list：光列场景名。场景名写在 smoke-renderer.js 的 await scenario('...') 上，
// 这里直接扫源码 —— 不启动窗口，秒回。
if (process.argv.includes('--list')) {
  const src = fs.readFileSync(path.join(__dirname, 'smoke-renderer.js'), 'utf8');
  const names = [...src.matchAll(/await scenario\('([^']+)'/g)].map((m) => m[1]);
  console.log(`\n  共 ${names.length} 个场景（--only= / --skip= 按名字**子串**匹配，逗号分隔可给多个）：\n`);
  names.forEach((n, i) => console.log(`  ${String(i + 1).padStart(3)}  ${n}`));
  console.log('');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------
//  假后端：所有读写都留在内存里
//  注意每个 get 都要返回深拷贝 —— 真实 IPC 是序列化的，
//  如果直接把 store 里的数组交给渲染层，两边就会共享引用，
//  「保存前不该落盘」这类断言会变成假阳性。
// ---------------------------------------------------------------------------
function makeStore() {
  return {
    // 设置的起点 = 真默认值 + 下面这几项测试专用的值（服务商、模型、采样参数…）。
    // **不要**把这里写成一份「只有测试用得到的那几个键」的小对象：
    // 假后端的保存路径要过真正的 normalizeSettings（见 settings:save），
    // 而它的白名单是「DEFAULT_SETTINGS 里有 or 磁盘上本来就有」。少一个键，
    // 那条设置就会被静默丢掉 —— 于是测试全绿，真机上却怎么改都不生效。
    // maxTurns 就是这么漏过去的：探针能证明「存 42 读回来还是 42」，
    // 而这份 store 里没有这个键时，同一件事在测试里永远是绿的。
    settings: {
      ...DEFAULT_SETTINGS,
      providers: [
        {
          id: 'p-test',
          name: '冒烟测试服务商',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'test-key',
          models: ['test-model']
        },
        // 第二个服务商专门给生图用 —— 生图和聊天是两套配置，测试也要分开验
        {
          id: 'p-img',
          name: '冒烟测试生图',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'test-key',
          models: ['img-model-x']
        },
        // 第三个给语义检索用 —— 向量模型又是一组独立配置
        {
          id: 'p-emb',
          name: '冒烟测试向量',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'test-key',
          models: ['emb-model-x']
        }
      ],
      activeProviderId: 'p-test',
      activeModel: 'test-model',
      temperature: 0.7,
      maxTokens: 512,
      topP: 0.95,
      // ⚠️ 钉在**当前出厂默认**上（夜间 + 琥珀灯），不是「以前那版的默认」。
      //    理由：整套断言和出图都应该跑在用户实际看到的那一档上 ——
      //    这里跟着旧默认走，就等于「默认值改了、测试还在验旧的那套」，
      //    出图也会拿一张浅色粉图当「默认长什么样」。
      //    「老配置不被强行改掉」那条路由 tools/test-settings-migration.js 单独守
      //    （它直接喂 raw 对象，不依赖这份夹具）。
      //    ⚠️ 这两个键必须**显式写出来**：上面 DEFAULT_SETTINGS 一改，
      //       靠 `...` 继承的话这里会跟着静默漂移。
      theme: 'dark',
      accent: 'amber',
      sendOnEnter: true,
      showDate: false,
      // 打开用量显示：头部那行「输入 / 输出（其中思考 N）」才有得测 ——
      // 「思考花了多少」是判断「是不是它在吃额度」的关键数字，值得一直摆在测试里
      showUsage: true,
      autoContinue: true,
      // ⚠️ 必须显式写出来，别依赖产品默认值：这份夹具代表「一份已经存过的 config.json」，
      //    而真实的 config.json 经过 normalizeSettings 之后一定含这个键。
      //    产品默认是 0（关递归，对齐酒馆的 Recursive Scan 默认关），
      //    而下面「世界书：递归扫描」那个场景验的是**功能本身** ——
      //    这里给 3 就是「用户自己把递归打开了」的那种配置。
      //    默认值本身由 tools/test-tavern-compat.js 里那条专门的断言守着。
      worldbookRecursiveDepth: 3,
      // 同上：这份夹具是「当前版本的配置」，必须带上结构版本号，
      // 否则会被 v1→v2 的迁移当成旧配置、把上面那个 3 改成 0（迁移见 main/providers.js）。
      settingsVersion: 2
    },
    characters: [],
    worldbooks: [
      {
        id: 'w-test',
        name: '冒烟测试世界',
        characters: [],
        opening: '',
        // 前三条是给「递归扫描」用的连锁：只提「翁法罗斯」，
        // 靠总览正文里的「十二泰坦」「火种」把另外两条带出来。
        // 第四条谁都不提它，用来验「没命中就是没命中」。
        entries: [
          {
            id: 'e-root',
            title: '世界总览',
            keys: ['翁法罗斯'],
            secondaryKeys: [],
            selectivelogic: 'AND_ANY',
            selectiveLogic: 'AND_ANY',
            // 正文只提「十二泰坦」，不提「火种」—— 这样才是一条严格的链
            content: '翁法罗斯有十二泰坦。',
            constant: false,
            recursive: true,
            probability: 100,
            order: 100,
            enabled: true
          },
          {
            id: 'e-titan',
            title: '十二泰坦',
            keys: ['十二泰坦'],
            secondaryKeys: [],
            selectiveLogic: 'AND_ANY',
            content: '十二泰坦守着火种，是这个世界的神。',
            constant: false,
            recursive: true,
            probability: 100,
            order: 100,
            enabled: true
          },
          {
            id: 'e-flame',
            title: '火种',
            keys: ['火种'],
            secondaryKeys: [],
            selectiveLogic: 'AND_ANY',
            content: '火种是泰坦留下的力量。',
            constant: false,
            recursive: false,
            probability: 100,
            order: 100,
            enabled: true
          },
          {
            id: 'e-unrelated',
            title: '无关条目',
            keys: ['完全没人提的词'],
            secondaryKeys: [],
            selectiveLogic: 'AND_ANY',
            content: '这条不该被带进来。',
            constant: false,
            recursive: true,
            probability: 100,
            order: 100,
            enabled: true
          }
        ]
      }
    ],
    conversations: [],
    activeId: null,
    // 预设：叠在对话上的一层指令。第一条故意用「别人分享的导入形态」
    // （正文在 metadata.systemPromptContent、description 是使用说明），
    // 第二条带条目（一条常驻、一条靠关键词命中），用来验两种正文来源都认得。
    // 第三条挂了 global:true —— 「没手动配过的会话自动带上它」。
    presets: [
      {
        id: 'pr-test',
        name: '冒烟测试预设',
        description: '测试用的说明，不会发给模型。',
        metadata: {
          isImported: true,
          systemPromptContent: '每一轮都要推进一个具体事件，不要停在原地。'
        },
        tags: ['测试'],
        lorebookCount: 0,
        entryCount: 0
      },
      {
        id: 'pr-entries',
        name: '带条目的预设',
        description: '',
        content: '最前面的总则。',
        tags: [],
        entries: [
          {
            id: 'pe-const',
            title: '常驻条目',
            keys: [],
            // 带两个宏：编辑器里写着「发送时会替换成角色名和你的名字」，
            // 宿主侧 probePresets 会验它到请求里已经不是字面量了。
            content: '这条每轮都带上。{{char}} 看着 {{user}} 走进来。',
            constant: true,
            enabled: true
          },
          {
            id: 'pe-key',
            title: '关键词条目',
            keys: ['暗号'],
            content: '说到「暗号」才带上这条。',
            constant: false,
            enabled: true
          }
        ]
      },
      {
        id: 'pr-global',
        name: '全局通用预设',
        description: '',
        content: '这场对话默认带上这一条。',
        global: true,
        tags: []
      },
      // 第四条：别人分享的「只有条目、没有正文」的形态（酒馆那类把规则拆成 key/content）。
      // 它连改名字都存不了的话，等于导入进来就是个死东西 —— 见 smoke-renderer 的
      // 「预设：只有条目的预设」场景。
      {
        id: 'pr-entry-only',
        name: '只有条目的预设',
        description: '',
        content: '',
        tags: [],
        entries: [
          {
            id: 'pe-only',
            title: '唯一一条',
            keys: [],
            content: '只靠这一条生效。',
            constant: true,
            enabled: true
          }
        ]
      }
    ]
  };
}

const store = makeStore();

// 起点也过一遍真归一化：这样 store.settings 的形状和主进程 loadSettings() 出来的
// 完全一致（每个默认键都在），后面 settings:save 的白名单才有东西可比。
store.settings = normalizeSettings(store.settings);

// --group=<域> 的夹具：灌「这一域第一个场景开跑前」的假后端快照。
// 快照由 `--dump-groups` 跑整套时生成（见下面 console-message 那一段）。
// 只为让这一域的场景不必依赖前面那些造数据的场景 —— 它们被跳过了，累积状态也一起没了。
// ⚠️ 整份覆盖（连 settings / presets 一起）：域内场景依赖的正是那一刻的设置，
//    只挑几项灌进去等于把「前面场景改过的设置」凭空还原成默认值。
if (PICK.length) {
  const seedPath = path.join(__dirname, `smoke-seed-${GROUP_KEY}.json`);
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    // 有个别场景要的数据是**排在它后面**的场景造的，整套跑时靠前序残留碰巧有。
    // 这类缺口的补法写在域定义里（见 smoke-groups.js 的 patch），别在场景里改断言。
    const group = GROUPS[GROUP_KEY];
    if (group.patch) {
      group.patch(seed, (key) => JSON.parse(fs.readFileSync(path.join(__dirname, `smoke-seed-${key}.json`), 'utf8')));
    }
    Object.assign(store, seed);
  } else console.warn(`\n  ⚠ 没有 ${path.basename(seedPath)}，这一域会从空状态出发（多半会红）\n`);
}

// 给截图用的种子角色 / 世界书。**只在 --shot-only 下灌**，结构照着断言场景里
// 那批卡来（属性、分组、标签都有），这样出图看到的就是真实布局该有的样子。
// 这里不做任何断言，所以它跑偏了也不会让测试变绿 —— 但也正因为如此，
// 它**不能**替断言场景里那份真实数据。改字段形状时两边都看一眼。
function seedForShots() {
  const card = (id, name, extra) =>
    Object.assign(
      {
        id,
        name,
        avatar: '',
        description: `${name}的设定文本。`,
        personality: '沉默寡言',
        scenario: '',
        firstMes: '',
        mesExample: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes: '',
        tags: ['手写'],
        attributes: [],
        source: 'manual',
        createdAt: 1,
        updatedAt: 1
      },
      extra || {}
    );

  // 出图用的占位插画（不写盘、只在 --shot-only 的种子数据里）
  const shotArt = (w, h, hue, label) =>
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<rect width="${w}" height="${h}" fill="hsl(${hue},72%,91%)"/>` +
        `<circle cx="${w / 2}" cy="${h * 0.4}" r="${Math.round(h * 0.2)}" fill="hsl(${hue},55%,68%)"/>` +
        `<text x="${w / 2}" y="${h - 16}" font-size="${Math.round(h * 0.08)}" text-anchor="middle" fill="hsl(${hue},50%,36%)">${label}</text>` +
        `</svg>`
    );

  store.characters = [
    // 状态卡上要铺一张角色图，所以这张卡带形象 + 两张表情：
    // 触发词挑假后端每轮回复里都有的那句话，出图时才稳定命中。
    card('c-shot-1', '属性测试角色', {
      description: '属性测试角色的设定文本',
      tags: ['测试分类', '治愈'],
      portrait: shotArt(300, 450, 335, '角色形象'),
      expressions: [
        { name: '表情甲', keywords: ['这是加粗'], image: shotArt(640, 640, 210, '表情甲') },
        { name: '表情乙', keywords: ['这是高亮'], image: shotArt(640, 640, 20, '表情乙') }
      ],
      attributes: [
        { name: '金币', type: 'text', value: '100' },
        { name: '上衣', type: 'text', value: '布衣' },
        { name: '好感度', type: 'meter', value: '20', min: 0, max: 100, group: '关系', hint: '按剧情合理增减' }
      ]
    }),
    card('c-shot-2', '字段往返测试', { tags: ['甲', '乙'] }),
    card('c-shot-3', '粘贴测试角色'),
    card('c-shot-4', '模板测试角色', {
      attributes: [
        { name: '好感度', type: 'meter', value: '0', min: 0, max: 100, group: '关系' },
        { name: '关系阶段', type: 'text', value: '陌生', group: '关系' },
        { name: '物品', type: 'list', value: '钥匙', group: '背包' }
      ]
    }),
    card('c-shot-5', '分组测试角色', { tags: ['原神'] }),
    card('c-shot-6', '分组改名角色'),
    card('c-shot-7', '自带世界书测试', { worldbookIds: ['w-test'] }),
    card('c-shot-8', '选项测试角色')
  ];

  // 出图用的世界书条目：世界书现在没有封面 / 开场白了，卡片里只看条目和角色副本
  const wbEntry = (id, title, keys) => ({
    id,
    title,
    keys,
    secondaryKeys: [],
    selective: false,
    selectiveLogic: 'AND_ANY',
    content: `${title}的设定正文。`,
    order: 100,
    constant: false,
    recursive: false,
    matchWholeWords: false,
    caseSensitive: false,
    probability: 100,
    enabled: true
  });

  store.worldbooks.push(
    {
      id: 'w-shot-1',
      name: '灰港',
      entries: [wbEntry('e-s1-1', '小镇广场', ['广场']), wbEntry('e-s1-2', '港口的雾', ['雾']), wbEntry('e-s1-3', '老船锚酒馆', ['酒馆'])],
      characters: [
        { id: 'wc-s1', name: '老板娘', avatar: '' },
        { id: 'wc-s2', name: '独眼水手', avatar: '' }
      ]
    },
    {
      id: 'w-shot-3',
      name: '星轨学院',
      entries: [wbEntry('e-s3-1', '天文台', ['天文台']), wbEntry('e-s3-2', '星轨课', ['星轨'])],
      characters: []
    },
    {
      id: 'w-shot-4',
      name: '沙海商路',
      entries: [wbEntry('e-s4-1', '绿洲', ['绿洲'])],
      characters: []
    }
  );

  // 两本书：一本有内容，一本空的 —— 卡片上的「N 条设定 · N 个角色 / N 条设定」两种写法都看得到
  store.worldbooks.push({ id: 'w-shot-2', name: '新世界书', entries: [], characters: [] });
}

if (SHOT_ONLY) seedForShots();

const calls = []; // 记录渲染层请求过的写操作，方便排查
let chatPayloads = []; // 每次发给模型的完整消息（按顺序留着，供宿主侧断言用）
let chatSampling = []; // 每次请求带的采样覆盖（payload.sampling）—— 预设设了温度 / top_p 的证据
// 预设导入的「待发文件」队列：预先塞几批，点一次导入消费一批。
// 真实现里这来自用户选的文件，测试没有文件框，所以改成预先摆好。
// 顺序要对上 smoke-renderer.js 里那两个导入场景的先后。
let presetImportQueue = [
  {
    presets: [
      {
        name: '导入的预设甲',
        description: '这是说明，不该混进正文',
        metadata: { systemPromptContent: '导入的正文甲。' },
        tags: ['导入']
      },
      { name: '导入的预设乙', content: '导入的正文乙。' }
    ],
    errors: []
  },
  {
    presets: [{ name: '导入的预设丙', content: '丙的正文。' }],
    errors: ['坏文件.json：不是合法的 JSON']
  }
];
let lastExport = null; // 最后一次「导出」交给主进程的东西
const exportedPayloads = []; // 按顺序留所有导出，宿主侧断言用
const imageRequests = []; // 生图请求参数
const ragRequests = []; // 语义检索请求参数

function remember(channel, payload) {
  calls.push(channel);
  if (channel === 'characters:save' && payload && Array.isArray(payload.worldbooks)) {
    store.worldbooks = clone(payload.worldbooks);
  }
}

function registerStubs() {
  // --- 设置 ---
  // 语义检索：不调真接口，但**排序用的是真的 rankBySimilarity**。
  // 假的「向量」按关键词落在哪个桶来构造，这样相似度是可控、可预期的：
  //   提到「泰坦 / 那些神」的落第 0 维，提「门 / 钟」的落第 1 维……
  // 于是「问『那些神』→ 捞出写了『十二泰坦』的设定」这件事是真排序算出来的。
  const fakeEmbed = (text) => {
    const t = String(text || '');
    return new Float32Array([
      /泰坦|那些神|神仙/.test(t) ? 1 : 0,
      /门|钟/.test(t) ? 1 : 0,
      /金币|钱/.test(t) ? 1 : 0,
      0.1
    ]);
  };

  ipcMain.handle('rag:recall', (_event, payload) => {
    remember('rag:recall');
    ragRequests.push(clone(payload));

    const req = payload || {};
    const convo = store.conversations.find((c) => c.id === req.convoId);

    // 候选收集用真实现（main/vectors.js 里的纯函数）—— 连「只捞绑定的书」
    // 和「跳过最近几条」这两条规则也一起验了
    const candidates = collectCandidates({
      messages: convo ? convo.messages : [],
      recentCount: req.recentCount,
      books: store.worldbooks,
      worldbookIds: req.worldbookIds
    }).map((c) => ({ ...c, vector: fakeEmbed(c.text) }));

    const ranked = rankBySimilarity(fakeEmbed(req.query), candidates, {
      topK: req.topK,
      minScore: req.minScore
    });

    return {
      ok: true,
      items: ranked.map((r) => ({
        kind: r.kind,
        title: r.title || '',
        role: r.role || '',
        text: r.text,
        score: Number(r.score.toFixed(4))
      })),
      embedded: 0,
      indexed: candidates.length,
      total: candidates.length
    };
  });

  ipcMain.handle('settings:get', () => ({
    settings: clone(store.settings),
    models: [],
    presets: []
  }));
  // 保存路径照抄 main/ipc.js → providers.saveSettings 的两道闸：
  //   1. 白名单（默认设置里有 or 磁盘上本来就有）；
  //   2. 真正的 normalizeSettings。
  // 少一道，测试就只证明「界面把值递出去了」，证明不了「它活了下来」。
  ipcMain.handle('settings:save', (_event, patch) => {
    remember('settings:save', patch);
    const current = store.settings || {};
    const clean = {};
    for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
      if (key in DEFAULT_SETTINGS || key in current) clean[key] = value;
    }
    store.settings = normalizeSettings({ ...current, ...clone(clean) });
    return clone(store.settings);
  });
  ipcMain.handle('settings:test', () => ({ ok: true, models: ['test-model'] }));
  ipcMain.handle('models:list', () => ({ models: ['test-model'] }));

  // --- 会话 ---
  ipcMain.handle('conversations:get', () => clone({ conversations: store.conversations, activeId: store.activeId }));
  ipcMain.handle('conversations:save', (_event, payload) => {
    remember('conversations:save', payload);
    if (payload && Array.isArray(payload.conversations)) store.conversations = clone(payload.conversations);
    if (payload && 'activeId' in payload) store.activeId = payload.activeId;
    return { ok: true };
  });
  ipcMain.on('conversations:save-sync', (event, payload) => {
    remember('conversations:save-sync', payload);
    try {
      if (payload && Array.isArray(payload.conversations)) store.conversations = clone(payload.conversations);
      if (payload && 'activeId' in payload) store.activeId = payload.activeId;
      event.returnValue = { ok: true, result: clone({ conversations: store.conversations, activeId: store.activeId }) };
    } catch (err) { event.returnValue = { ok: false, error: err.message }; }
  });

  // --- 角色卡（和 main.js 一样：一次调用可能同时带 worldbooks）---
  ipcMain.handle('characters:get', () => clone({ characters: store.characters }));
  ipcMain.handle('characters:save', (_event, payload) => {
    remember('characters:save', payload);
    // 过一遍真正的归一化 —— 白名单漏字段这种事只有跑真代码才测得出来
    if (payload && Array.isArray(payload.characters)) {
      store.characters = clone(payload.characters.map((c) => normalizeCharacter(c)));
    }
    if (payload && Array.isArray(payload.worldbooks)) store.worldbooks = clone(payload.worldbooks);
    return { ok: true };
  });
  ipcMain.on('characters:save-sync', (_event, payload) => {
    remember('characters:save-sync', payload);
    if (payload && Array.isArray(payload.characters)) {
      store.characters = clone(payload.characters.map((c) => normalizeCharacter(c)));
    }
    if (payload && Array.isArray(payload.worldbooks)) store.worldbooks = clone(payload.worldbooks);
  });
  // 导入按钮本身还是桩：界面点「导入」会弹系统文件框，测试里没法点。
  // 但导入链路的**真代码**已经被覆盖到了 ——
  //   · 编排（读文件→解析→自动绑定）：probeImport 用真 PNG 字节喂 main/import-files.js
  //   · 形状识别 / 归一化：main/card-import.js，同一份
  //   · 导出→导入的真往返：probeExports 用渲染层交出来的真实 PNG 字节
  //   · 重发 id 时改写角色→世界书的绑定：smoke-renderer 里动态 import 真模块
  // 这里返回 canceled，是为了让界面那条路径保持「用户取消」的默认行为。
  ipcMain.handle('characters:import', () => ({ canceled: true }));

  // --- 世界书 ---
  // 过一遍**真正的**落盘归一化 —— 和 main.js 的 worldbooks:save 跑同一份。
  // 以前这里只是 clone 一下就存，所以「世界书存盘再读回来字段会不会丢」
  // 在自动化里是空的（recursive / opening / characters 都是白名单字段，
  // 漏一个就会被静默重置）。
  const normalizeStoredWorldbook = createWorldbookNormalizer({
    makeId: (() => {
      let n = 0;
      return () => `w-smoke-${(n += 1)}`;
    })(),
    normalizeCharacter: (item) => normalizeCharacter(item, 'manual')
  });

  ipcMain.handle('worldbooks:get', () => clone({ worldbooks: store.worldbooks }));
  ipcMain.handle('worldbooks:save', (_event, payload) => {
    remember('worldbooks:save', payload);
    if (payload && Array.isArray(payload.worldbooks)) {
      store.worldbooks = clone(payload.worldbooks.map((w) => normalizeStoredWorldbook(w)));
    }
    return { ok: true };
  });
  ipcMain.on('worldbooks:save-sync', (_event, payload) => {
    remember('worldbooks:save-sync', payload);
    if (payload && Array.isArray(payload.worldbooks)) {
      store.worldbooks = clone(payload.worldbooks.map((w) => normalizeStoredWorldbook(w)));
    }
  });
  // 世界书匹配用**真实现**（main/worldbook-match.js），这样递归扫描、
  // 副关键词、概率这些逻辑测的是真代码。这里只补主进程 handler 里那段
  // 「取最近 N 条拼成扫描文本」——它本来就是十来行拼字符串。
  ipcMain.handle('worldbooks:preview', (_event, payload) => {
    const request = payload || {};
    const messages = Array.isArray(request.messages) ? request.messages : [];

    let scanDepth = Number(request.scanDepth);
    if (!isFinite(scanDepth) || scanDepth <= 0) scanDepth = 6;
    scanDepth = Math.min(50, Math.floor(scanDepth));

    const usable = messages.filter((m) => m && typeof m.content === 'string' && String(m.content).trim());
    const scanText = usable
      .slice(-scanDepth)
      .map((m) => String(m.content))
      .join('\n');

    const wanted = Array.isArray(request.worldbookIds) ? request.worldbookIds : [];
    const entries = [];
    for (const book of store.worldbooks) {
      if (!wanted.includes(book.id)) continue;
      for (const entry of book.entries || []) {
        entries.push({ ...entry, worldbookId: book.id, worldbookName: book.name });
      }
    }

    const matched = matchWorldbookEntries(entries, scanText, { recursiveDepth: request.recursiveDepth });

    return {
      total: entries.length,
      scanDepth,
      rounds: matched.rounds,
      recursiveCount: matched.recursiveCount,
      hits: matched.hits.map((e) => ({
        id: e.id,
        title: e.title,
        worldbookName: e.worldbookName,
        order: e.order,
        recursive: e.recursive === true,
        length: String(e.content).length
      })),
      // 和真实现（main/ipc.js 的 worldbooks:preview）一样拆两块：
      // section = 关键词命中的，deepSection = 常驻条目（每轮都成立，渲染层送到生成位置附近）。
      // ⚠️ 假后端漏掉 deepSection 的话，「常驻条目还能不能进提示词」就整条测不到了。
      ...formatWorldbookSections(matched.hits)
    };
  });

  // --- 预设 ---
  // 和世界书一样，过一遍**真正的**落盘归一化（main/presets.js）。白名单漏字段、
  // 「正文只认 content / metadata.systemPromptContent 而不回落到 description」
  // 这类规则都在归一层，假后端只 clone 就会漏测。
  //
  // get 也要归一化 —— 真实现是 main/store.js 的 loadPresets() 读盘时过一遍。
  // 只让 save 归一化的话，「别人分享的导入形态」（正文住 metadata.systemPromptContent、
  // description 只是说明）在界面上会明文不认，测试却全绿。
  // 批次路径与旧整库 save 分开：完整记录只替换同 id，绝不回落成整库覆盖。
  // 每个库有独立队列 / generation，关闭窗口的成功同步写会淘汰之前排队的批次。
  function registerLibraryChanges(key, normalize, maxItems = Infinity) {
    let pending = Promise.resolve();
    let generation = 0;
    const recordId = (id) => {
      if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
        throw new Error('Record id must be a non-empty string without outer whitespace');
      }
      return id;
    };
    const prepare = (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          !Array.isArray(payload.upserts) || !Array.isArray(payload.deletes)) {
        throw new Error('Changes require upserts and deletes arrays');
      }
      const upsertIds = new Set();
      const upserts = payload.upserts.map((record) => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error('A complete record object is required');
        }
        const id = recordId(record.id);
        if (upsertIds.has(id)) throw new Error(`Duplicate upsert id: ${id}`);
        upsertIds.add(id);
        const snapshot = clone(record);
        if (!snapshot || snapshot.id !== id) throw new Error('Record id changed during serialization');
        const item = normalize(snapshot);
        if (!item || item.id !== id) throw new Error('Record normalization changed id');
        return item;
      });
      const deleteIds = new Set();
      const deletes = payload.deletes.map((value) => {
        const id = recordId(value);
        if (deleteIds.has(id)) throw new Error(`Duplicate delete id: ${id}`);
        if (upsertIds.has(id)) throw new Error(`Record id appears in upserts and deletes: ${id}`);
        deleteIds.add(id);
        return id;
      });
      return { upserts, deletes };
    };
    const commit = (changes) => {
      const current = store[key];
      if (!Array.isArray(current)) throw new Error(`Invalid collection: ${key}`);
      const existingIds = new Set();
      for (const record of current) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error(`Invalid record in ${key}`);
        }
        const id = recordId(record.id);
        if (existingIds.has(id)) throw new Error(`Duplicate record id in ${key}: ${id}`);
        existingIds.add(id);
      }
      const deleted = new Set(changes.deletes);
      const replacements = new Map(changes.upserts.map((record) => [record.id, record]));
      const next = current.filter((record) => !deleted.has(record.id)).map((record) => replacements.get(record.id) || record);
      const added = changes.upserts.filter((record) => !existingIds.has(record.id));
      next.push(...added);
      // 旧库即便已经超限也允许改已有记录；新建必须以删后的最终容量为准。
      if (added.length && next.length > maxItems) {
        throw new Error(`Collection limit reached: ${key} (${maxItems})`);
      }
      // 所有验证 / 归一化 / 序列化都完成后才一次更新内存；失败不留下半个批次。
      const snapshot = clone(next);
      const result = clone(changes);
      store[key] = snapshot;
      return result;
    };
    ipcMain.handle(`${key}:apply-changes`, (_event, payload) => {
      remember(`${key}:apply-changes`, payload);
      const changes = prepare(payload);
      const requestedGeneration = generation;
      const operation = pending.then(() => {
        if (requestedGeneration !== generation) {
          throw new Error('ERR_SUPERSEDED: superseded by synchronous library changes');
        }
        return commit(changes);
      });
      pending = operation.catch(() => {});
      return operation;
    });
    ipcMain.on(`${key}:apply-changes-sync`, (event, payload) => {
      remember(`${key}:apply-changes-sync`, payload);
      try {
        const result = commit(prepare(payload));
        generation += 1;
        event.returnValue = { ok: true, result };
      } catch (err) {
        event.returnValue = { ok: false, error: String((err && err.message) || err) };
      }
    });
    return { prepare, commit, supersede: () => { generation += 1; } };
  }
  const characterChanges = registerLibraryChanges('characters', normalizeCharacter);
  const worldbookChanges = registerLibraryChanges('worldbooks', normalizeStoredWorldbook, 200);
  registerLibraryChanges('presets', normalizePreset, 200);
  let libraryGeneration = 0;
  let libraryQueue = Promise.resolve();
  const prepareLibrary = (payload) => ({
    characters: characterChanges.prepare(payload && payload.characters),
    worldbooks: worldbookChanges.prepare(payload && payload.worldbooks)
  });
  const commitLibrary = (changes) => {
    const originalCharacters = store.characters;
    const originalWorldbooks = store.worldbooks;
    try {
      return { characters: characterChanges.commit(changes.characters), worldbooks: worldbookChanges.commit(changes.worldbooks) };
    } catch (err) {
      store.characters = originalCharacters;
      store.worldbooks = originalWorldbooks;
      throw err;
    }
  };
  ipcMain.handle('library:apply-changes', (_event, payload) => {
    remember('library:apply-changes', payload);
    const changes = prepareLibrary(payload);
    const generation = libraryGeneration;
    const result = libraryQueue.then(() => {
      if (generation !== libraryGeneration) throw new Error('ERR_SUPERSEDED: library close flush');
      return commitLibrary(changes);
    });
    libraryQueue = result.catch(() => {});
    return result;
  });
  ipcMain.on('library:apply-changes-sync', (event, payload) => {
    remember('library:apply-changes-sync', payload);
    try {
      const result = commitLibrary(prepareLibrary(payload));
      libraryGeneration += 1;
      characterChanges.supersede();
      worldbookChanges.supersede();
      event.returnValue = { ok: true, result };
    } catch (err) { event.returnValue = { ok: false, error: err.message }; }
  });

  ipcMain.handle('presets:get', () => clone({ presets: store.presets.map((p) => normalizePreset(p)) }));
  ipcMain.handle('presets:save', (_event, payload) => {
    remember('presets:save', payload);
    if (payload && Array.isArray(payload.presets)) {
      store.presets = clone(payload.presets.map((p) => normalizePreset(p)));
    }
    return { ok: true };
  });
  ipcMain.on('presets:save-sync', (_event, payload) => {
    remember('presets:save-sync', payload);
    if (payload && Array.isArray(payload.presets)) {
      store.presets = clone(payload.presets.map((p) => normalizePreset(p)));
    }
  });

  // 导入：不弹真文件框，改由测试预先塞好一批「文件里读出来的东西」。
  // ⚠️ 这里也要过 normalizePreset —— 真实现就是这么干的（main/ipc.js 的
  //    presets:import），不过一遍就等于放过了「导入别人分享的格式」这条链路。
  ipcMain.handle('presets:import', () => {
    remember('presets:import');
    if (!presetImportQueue.length) return { canceled: true, presets: [], errors: [] };
    const queued = presetImportQueue.shift();
    return clone({
      canceled: false,
      presets: (queued.presets || []).map((p) => normalizePreset(p)),
      errors: queued.errors || []
    });
  });

  // --- 图片 / 杂项 ---
  // 生图桩沿用这张 1×1 PNG（只验链路通不通，尺寸无所谓）
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // 「选一张图」返回一张真的 1200×1800 图（2:3，和形象的画幅一致）。裁剪那条链路会按
  // **原图实际像素**决定输出尺寸（原图不够大就不放大），拿 1×1 的图去测等于所有输出都是
  // 1px，尺寸根本验不了。
  // 用 SVG 而不是 PNG：同样是张能解码的真图，但尺寸写在属性里，改起来一行的事。
  const PICK_IMAGE =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800" viewBox="0 0 1200 1800">' +
        '<rect width="1200" height="1800" fill="#dfe7f5"/>' +
        '<rect width="600" height="1800" fill="#c3d2ea"/>' +
        '<circle cx="600" cy="560" r="220" fill="#9db4d8"/>' +
        '</svg>'
    );
  ipcMain.handle('images:pick', (_event, options) => {
    // 「导入凭证图片」拿的是**刚才导出的那张凭证 PNG**（tEXt 里带着凭证码）。
    // 页面里画的卡只有渲染层有，所以这里借导出时交上来的 payload 反手喂回去 ——
    // 这样「导出 → 导入 → 登录成功」这条真实链路才算真的被跑到，
    // 不是拿一张假图糊弄过去。其它场景（换头像等）照旧返回 PICK_IMAGE。
    if (options && /凭证/.test(String(options.title || ''))) {
      const png = lastExport && String(lastExport.fileName || '').includes('凭证') ? lastExport : null;
      if (png && png.base64) return { canceled: false, dataUrl: `data:image/png;base64,${png.base64}` };
    }
    return { canceled: false, dataUrl: PICK_IMAGE };
  });

  // 批量导入表情图：六个「文件名里带情绪词」的假文件，读回同一张真图。
  // 前三个用英文、后三个用中文 —— 渲染层认情绪的两种输入都要跑到。
  // 最后一张「羞怯」是 shy 的中文别名，会和第一张撞同一个情绪键，用来验去重。
  const BATCH_EXPR_FILES = [
    { path: 'C:\\smoke\\lucia_a3_shy.png', name: 'Lucia_A3_shy_transparent.png' },
    { path: 'C:\\smoke\\lucia_a2_smile.png', name: 'Lucia_A2_smile_transparent.png' },
    { path: 'C:\\smoke\\lucia_a5_panicked.png', name: 'Lucia_A5_panicked_transparent.png' },
    { path: 'C:\\smoke\\cn_4.png', name: '露西娅_惊讶_透明.png' },
    { path: 'C:\\smoke\\cn_5.png', name: '露西娅_气愤_透明.png' },
    { path: 'C:\\smoke\\cn_6.png', name: '露西娅_羞怯_透明.png' }
  ];
  ipcMain.handle('images:pick-many', (_event, options) => {
    if (options && options.directory) return { canceled: false, files: BATCH_EXPR_FILES };
    return { canceled: true, files: [] };
  });
  ipcMain.handle('images:read', (_event, filePath) => {
    const hit = BATCH_EXPR_FILES.some((f) => f.path === filePath);
    if (!hit) return { dataUrl: '', error: '不在本次选中的文件里' };
    return { dataUrl: PICK_IMAGE, error: '' };
  });

  // 生图：记下请求参数（要验它用的是「生图」那组配置，不是聊天模型），
  // 返回一张真的 1×1 PNG，让渲染层真实的「解码 → 压缩 → 存进会话」链路跑一遍
  ipcMain.handle('images:generate', (_event, payload) => {
    remember('images:generate');
    imageRequests.push(clone(payload));
    return { ok: true, dataUrl: TINY_PNG, model: (payload && payload.model) || '' };
  });
  ipcMain.handle('util:copy', () => true);
  // 打开数据文件夹。真主进程现在回 { ok, path, error }（以前只回路径字符串，
  // 失败时界面拿不到任何信息），这里跟着给同样的形状。
  ipcMain.handle('util:openPath', () => ({ ok: true, path: 'C:\\fake\\userData' }));

  // 注意：编辑弹窗头上那颗按钮**没有 IPC** —— 「放大」是纯渲染层的
  // （给弹窗挂 .modal-max，CSS 撑满），不碰 BrowserWindow，所以这里没有对应桩。

  // 「导出」：不弹真的保存框，但把渲染层交上来的东西原样收下 ——
  // 宿主侧再拿它跑一遍真正的「写 PNG → 读 PNG」往返
  ipcMain.handle('util:saveFile', (_event, payload) => {
    remember('util:saveFile');
    lastExport = clone(payload);
    exportedPayloads.push(clone(payload));
    return { canceled: false, filePath: 'C:\\fake\\' + ((payload && payload.fileName) || 'export') };
  });

  // --- 账号（登录 / 注册 / 凭证）---
  // 直接借真主进程那份「假后端」（main/account.js），不另写一套桩：
  // 密码 scrypt 哈希、凭证码规整、图形码一次性这些真实逻辑也跟着被跑到。
  // ⚠️ 它写 account.json 到 MIMITALE_DATA_DIR（上面那个临时目录），不碰真数据。
  const accountApi = require('../main/account.js');
  const accountCall = (fn) => async (_event, payload) => {
    try {
      return { ok: true, ...(await fn(payload)) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '账号操作失败' };
    }
  };
  ipcMain.handle('account:session', accountCall(() => accountApi.getSession()));
  ipcMain.handle('account:captcha', accountCall(() => accountApi.createCaptcha()));
  ipcMain.handle('account:send-code', accountCall((payload) => accountApi.sendEmailCode(payload)));
  ipcMain.handle('account:register', accountCall((payload) => accountApi.register(payload)));
  ipcMain.handle('account:complete-profile', accountCall((payload) => accountApi.completeProfile(payload)));
  ipcMain.handle('account:login', accountCall((payload) => accountApi.login(payload)));
  ipcMain.handle('account:voucher-login', accountCall((payload) => accountApi.loginWithVoucher(payload)));
  ipcMain.handle('account:logout', accountCall(() => accountApi.logout()));
  ipcMain.handle('account:voucher', accountCall(() => accountApi.getVoucher()));
  ipcMain.handle('account:update-profile', accountCall((payload) => accountApi.updateProfile(payload)));
  ipcMain.handle('account:change-password', accountCall((payload) => accountApi.changePassword(payload)));
  ipcMain.handle('account:change-email', accountCall((payload) => accountApi.changeEmail(payload)));

  // --- 桌宠 ---
  //
  // 桌宠的「展示」在另一个窗口里（真实环境是独立 BrowserWindow），假后端起不了
  // 那个窗口，所以这里只桩**渲染层真的会调的**那几个通道：
  //   设置页打开 → pet:get（不桩它就是 19 条「No handler registered」控制台报错）
  //   改设置    → pet:update
  //   预览      → pet:speak（返回几句固定的，验「预览不写记忆」这类行为）
  //
  // ⚠️ 真主进程里 `pet:speak` 走的是**独立通道和独立 controller**，绝不是 chat:send
  //    （复用会 abort 掉正在流的角色回复）。这里也照这个形状桩，免得假后端
  //    给出一个真环境里不存在的假象。
  const petStore = {
    enabled: true,
    activeId: 'pet1',
    pets: [
      {
        id: 'pet1',
        name: '蓝自',
        look: { kind: 'rig', source: 'assets', skin: 'whale' },
        visible: true,
        scale: 1,
        bounds: null,
        speakEnabled: true,
        speakEveryTurns: 3,
        speakLines: 3,
        mutedUntil: 0,
        useMainModel: true,
        providerId: '',
        model: '',
        temperature: null,
        style: '',
        memoryMaxItems: 30,
        createdAt: Date.now()
      }
    ]
  };
  const petMemory = [];
  const petSpeaks = [];
  let petPersona = '你是「蓝自」，一只住在人家桌面上的小家伙。';

  const petPayload = () => ({
    config: { enabled: petStore.enabled, activeId: petStore.activeId },
    pet: { ...petStore.pets[0] },
    models: [
      { providerId: 'p1', providerName: 'DeepSeek', model: 'deepseek-chat', label: 'DeepSeek · deepseek-chat' },
      { providerId: 'p1', providerName: 'DeepSeek', model: 'deepseek-reasoner', label: 'DeepSeek · deepseek-reasoner' }
    ],
    memoryCount: petMemory.length,
    memoryDigest: '',
    persona: petPersona,
    mainProviderName: 'DeepSeek',
    mainModel: 'test-model'
  });

  ipcMain.handle('pet:skins', () => [{ id: 'whale', source: 'assets', label: '鲸鱼' }]);
  ipcMain.handle('pet:get', () => petPayload());
  ipcMain.handle('pet:update', (_event, payload) => {
    remember('pet:update');
    const data = payload || {};
    const patch = data.patch && typeof data.patch === 'object' ? data.patch : {};
    if (data.petId) Object.assign(petStore.pets[0], patch);
    else Object.assign(petStore, patch);
    return petPayload();
  });
  ipcMain.handle('pet:speak', (_event, payload) => {
    remember('pet:speak');
    const reason = (payload && payload.reason) || 'auto';
    petSpeaks.push({ reason, context: clone((payload && payload.context) || {}) });
    const lines = ['这也太甜了吧。', '*尾巴摇起来* 我磕了。', '你倒是主动点啊。'];
    // 预览不写记忆 —— 跟真主进程一个口径
    if (reason !== 'preview') {
      petMemory.push({ id: `m${petMemory.length + 1}`, at: Date.now(), kind: 'say', text: lines.join('\n'), convoTitle: '冒烟会话' });
      if (reason === 'manual') {
        petMemory.push({ id: `m${petMemory.length + 1}`, at: Date.now(), kind: 'event', text: '用户想让宠物多说两句', convoTitle: '冒烟会话' });
      }
    }
    return { ok: true, lines, text: lines.join('\n'), memory: reason === 'auto' ? '记一笔' : '', providerName: 'DeepSeek', model: 'test-model' };
  });
  ipcMain.handle('pet:say-now', () => ({ ok: true }));
  ipcMain.handle('pet:stop', () => true);
  ipcMain.handle('pet:persona:get', () => ({ persona: petPersona }));
  ipcMain.handle('pet:persona:save', (_event, payload) => {
    const text = String((payload && payload.text) || '');
    // 空 = 还原成默认（和真主进程一致：写空文件会让宠物变成没有性格的文字生成器）
    petPersona = text.trim() ? text : '你是「蓝自」，一只住在人家桌面上的蓝白猫娘。';
    return { ok: true, persona: petPersona, reset: !text.trim() };
  });
  ipcMain.handle('pet:memory:get', () => ({ items: petMemory.slice().reverse(), digest: '' }));
  ipcMain.handle('pet:memory:clear', (_event, payload) => {
    if (!(payload && payload.keepDigest)) petMemory.length = 0;
    else petMemory.length = 0;
    return { ok: true };
  });
  ipcMain.handle('pet:memory:export', () => ({
    ok: true,
    text: JSON.stringify({ 说明: '冒烟', 长期记忆: petMemory }, null, 2),
    fileName: '桌宠记忆-蓝自.json'
  }));
  ipcMain.handle('pet:window:setVisible', () => ({ ok: true, visible: true }));

  // --- 聊天：假装模型回了一句话，并且真的走一遍流式通道 ---
  const slowChatRequests = new Map();
  ipcMain.handle('chat:stop', (_event, requestId) => {
    const cancel = slowChatRequests.get(requestId);
    if (cancel) cancel();
    return true;
  });
  // 「请求记录」：读/清都走真模块（main/request-log.js），只是没真的发网络请求
  ipcMain.handle('chat:requests', () => ({ entries: listRequests(), max: MAX_LOGGED_REQUESTS }));
  ipcMain.handle('chat:requests:clear', () => {
    clearRequests();
    return true;
  });
  // 每次回复带个序号 —— 不然「重新生成」出来的候选和原来那条一模一样，
  // 测不出「到底是哪一条」
  let replySeq = 0;
  let aiGenSeen = 0; // 认出来的 AI 生成请求数（诊断用）
  ipcMain.handle('chat:send', async (event, payload) => {
    remember('chat:send');
    chatPayloads.push(clone((payload && payload.messages) || []));
    chatSampling.push(clone((payload && payload.sampling) || null));
    const requestId = (payload && payload.requestId) || 'req-smoke';
    const model = (payload && payload.model) || 'test-model';

    // 真 handler 是在 main/http.js 的 onRequest 里留这一份的（见 probeRequestLog）。
    // 假后端不发网络请求，所以照着那个形状补一条，页面侧的「请求记录」弹窗才有料可看。
    recordRequest({
      requestId,
      providerName: '冒烟假后端',
      url: 'https://example.invalid/v1/chat/completions',
      body: {
        model,
        messages: clone((payload && payload.messages) || []),
        stream: true,
        temperature: 0.7,
        max_tokens: 8192,
        top_p: 0.95
      }
    });

    // ⚠️ 判定必须只看「当前这一轮」，不能扫整段历史 ——
    // 这几个场景共用同一个会话，扫历史的话，前一个场景留下的关键词会污染
    // 后面所有请求（症状：新场景莫名其妙走了「只思考」那条分支）。
    //
    // 当前轮 = 最后一条 user 消息；若它后面还跟着自动重试的引导语（它是重试请求），
    // 再往回带一条原始输入 —— 这样「重试该失败」和「重试该救回」两种情形都能表达。
    // 自动续写同理：它是「在真实输入后面追一轮续写引导」，不回溯就认不出场景。
    const isRetryNudge = (s) => s.includes('直接把这一轮该写的正文完整写出来');
    const isContinueNudge = (s) => s.includes('接着你上一条回复继续往下写');
    // 状态表漏写时的补问语（panel.js 的 PANEL_PROMPT_NUDGE）。它也属于「引导语」，
    // 得回溯到真实输入，否则这一轮的关键词（「漏状态表」）就看不到了。
    // 认的是「只补这一件事」这个特征串 —— 补问语改过措辞（2026-09-30 加强成
    // 「现在只补这一件事…」），别拿开头那句当锚，改文案时就断了。
    const isPanelNudge = (s) => s.includes('只补这一件事');
    const isNudge = (s) => isRetryNudge(s) || isContinueNudge(s) || isPanelNudge(s);
    const allMsgs = (payload && payload.messages) || [];
    let turn = '';
    for (let i = allMsgs.length - 1; i >= 0; i -= 1) {
      const m = allMsgs[i] || {};
      if (m.role !== 'user') continue;
      const text = String(m.content || '');
      turn = `${text}\n${turn}`;
      if (isNudge(text)) continue; // 引导语 → 继续往回找真实的输入
      break;
    }
    const retryNudged = isRetryNudge(turn);
    const continuedNudged = isContinueNudge(turn);
    const panelNudged = isPanelNudge(turn);

    // Cancellable slow stream for navigation + merged send/stop regression; never calls a real model.
    if (turn.includes('[NAV_STOP_TEST]')) {
      return await new Promise((resolve) => {
        let count = 0;
        let content = '';
        const finish = (stopped) => {
          clearInterval(timer);
          slowChatRequests.delete(requestId);
          resolve(stopped ? { ok: false, error: '已停止生成。' } : { ok: true, content, finishReason: 'stop' });
        };
        const timer = setInterval(() => {
          const text = `测试分片${++count}。`;
          content += text;
          event.sender.send('chat:chunk', { requestId, text });
          if (count >= 80) finish(false);
        }, 150);
        slowChatRequests.set(requestId, () => finish(true));
      });
    }

    // 「AI 生成角色」：它和聊天共用 chat:send，靠 system 里的特征串认出来。
    // 用 system 而不是 user 是因为那两段的 user 文案由调用方拼，容易改；
    // 而 system 的措辞就在 aiGen.js 的常量里，改的时候一眼能看到这里。
    //
    // ⚠️ 这个桩**必须能返回真东西**，否则「界面没反应」这类问题会伪装成别处失败，
    //    而且返回空和返回垃圾都表现为「生成后字段是空的」，很难分辨。
    const allText = allMsgs.map((m) => String((m && m.content) || '')).join('\n');

    // 「AI 补设定」（角色编辑器里那块，2026-10-20）：和「AI 生成角色」共用 chat:send。
    // 认两样：人设里的「世界书编辑」+ 字段契约里的 "entries"。和下面那条互不干扰 ——
    // 那条要的是「角色设定师」+ "firstMes"。
    //
    // 特意给了一条「既非常驻、又没有关键词」的条目：它永远不会被注入，
    // 解析器必须把它丢掉（这是这块最容易出「悄悄多一条死条目」的地方）。
    if (/世界书编辑/.test(allText) && allText.includes('"entries"')) {
      const payloadText = JSON.stringify({
        entries: [
          {
            title: '夜班规矩',
            keys: ['换班', '交接'],
            content: '这栋楼换班要当面交接：上一班的记录本、钥匙、手电，缺一样都算事故。',
            constant: false
          },
          {
            title: '街口那盏灯',
            keys: ['街口', '路灯'],
            content: '街口的路灯坏了三年没人修，深夜回来的人都会绕到马路对面走。',
            constant: false
          },
          {
            title: '这座城的作派',
            keys: [],
            content: '这里的人不打听别人的来路，问得太多会被当成外人。',
            constant: true
          },
          {
            // 既非常驻又没有关键词 —— 注入时永远轮不到它，解析器要丢掉
            title: '用不上的那条',
            content: '一条没有关键词的设定。',
            constant: false
          }
        ]
      });
      for (const piece of payloadText.match(/[\s\S]{1,40}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(2);
      }
      return {
        ok: true,
        requestId,
        model,
        content: payloadText,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    // 「AI 补充」（角色编辑器左栏那颗，2026-10-20）：把它手上这张卡的五栏重写一遍。
    // 认两样：人设里的「角色卡编辑」+ 字段契约里的 "mesExample"。
    // 和「AI 生成角色」那条不冲突 —— 那条要「角色设定师」+ "firstMes"，措辞是两套。
    //
    // 故意**不返回 name**：这条任务只改五栏，模型要是顺手给了个新名字，
    // 界面也不能把卡名改掉（applyAiFill 只认这五个键）。
    if (/角色卡编辑/.test(allText) && allText.includes('"mesExample"')) {
      const payloadText = JSON.stringify({
        description: 'AI补充后的描述：守夜人靠在楼道尽头的铁梯上，手电筒夹在腋下，指节上有一道旧疤。',
        personality: 'AI补充后的性格：话少，问一句答半句；被追问急了会先沉默两秒，再蹦出一个短句。',
        scenario: 'AI补充后的场景：凌晨三点的老楼楼道，你们在两盏坏掉的声控灯之间。',
        firstMes: 'AI补充后的开场白：她把手电往你脚边一照。\\n\\n「这么晚，你上来干什么？」',
        mesExample:
          '{{user}}: 我找人。\\n{{char}}: 找哪个？这层只剩两户。\\n\\n<START>\\n\\n{{user}}: 你住这儿多久了？\\n{{char}}: 记不清了。'
      });
      // ⚠️ 切得比别的桩碎、也慢一点（24 字 / 8ms）：界面那条断言要看按钮的
      //    loading 态（转圈圈 + 不可点），一口气吐完的话轮询根本抓不到。
      for (const piece of payloadText.match(/[\s\S]{1,24}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(8);
      }
      return {
        ok: true,
        requestId,
        model,
        content: payloadText,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    // 「AI 生成预设」（预设页右上角那颗，2026-10-20）：同样共用 chat:send。
    // 认两样：人设里的「写「预设」的编辑」+ 字段契约里的 "note"。
    // 名字跟着用户描述 / 场次变 —— 对不上就说明那两段没拼进请求（user 缺描述、system 缺场次）。
    if (/写「预设」的编辑/.test(allText) && allText.includes('"note"')) {
      const asked = allText.includes('冒烟：回复太长');
      const hasScene = allText.includes('【适用的场次】');
      const payloadText = JSON.stringify({
        name: asked ? (hasScene ? '短句对白·夜' : '短句对白') : '通用预设',
        note: '让回复短下来，多留白、少总结。',
        tags: ['节奏', '对白'],
        content: '每轮回复不超过三句话。\n不解释情绪，让动作和语气自己说话。\n写场景只写一个细节，不铺全景。'
      });
      for (const piece of payloadText.match(/[\s\S]{1,40}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(2);
      }
      return {
        ok: true,
        requestId,
        model,
        content: payloadText,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    // ⚠️ 认的**不能是一整句措辞**：原来盯「你是一位角色设定师」，2026-10-19 那句改成
    //    「你是一位经验丰富的角色设定师」之后桩就认不出来了 —— 生成请求被当成普通聊天，
    //    返回一段「冒烟测试回复」，下游十几条断言（名字没回填、落盘没属性……）连带全红，
    //    而真正的原因跟它们一点关系都没有。
    //    现在同时要两样：人设里的「角色设定师」+ 字段契约里的键（字段名是契约，改措辞不会动它）。
    // ⚠️ 2026-10-26：本书角色（NPC）那条路的合同改成只有 name/description/tags/attributes，
    //    把 "firstMes" 去掉了 —— 只认 "firstMes" 会让 NPC 生成整条被当成普通聊天全红。
    //    所以两条合同任认一个键：角色卡有 firstMes，NPC 有 attributes。
    if (/角色设定师/.test(allText) && (allText.includes('"firstMes"') || allText.includes('"attributes"'))) {
      // 认出来的 AI 生成请求数 —— 只在诊断时打出来（见下面的 TMP 输出），
      // 用来区分「请求没发出来」和「发出来了但没认出来」。
      aiGenSeen += 1;
      // 世界书那条路会把书的设定一起塞进 system —— 用它验证「NPC 描述确实按书生成」
      const knownBook = allText.includes('【世界：');
      // 「烂 JSON」场景：模型多写了一句开场白、还把 JSON 包在 ``` 里。
      // 解析器要能剥掉围栏、切出花括号块，正常生成出角色。
      const messy = allText.includes('冒烟：烂JSON');
      // 角色卡那侧的「背景 / 基调」是可选的：填了才会拼进 system。
      // 名字跟着基调变 —— 对不上就说明那段没注入。
      const withBrief = allText.includes('【背景 / 基调】');
      const payloadText = messy
        ? '好的，我按你说的写了一个：\n\n```json\n{"name":"油烟贩子","description":"' +
          '常在酒馆后巷支摊卖炸物的小贩，围裙上全是油渍，嗓门大。",' +
          '"personality":"见谁都自来熟，爱打听闲话换点好处。",' +
          '"tags":["市井","NPC"],"attributes":[{"name":"好感度","type":"number","value":10,"mode":"dynamic"}]}\n```\n\n需要我再调整吗？'
        : JSON.stringify({
            name: knownBook ? '后厨帮工' : withBrief ? '便利店店员' : '守夜人',
            description: knownBook
              ? '酒馆后厨的帮工，负责洗碗和备料，手上常年有烫伤的疤。'
              : withBrief
                ? '深夜便利店的店员，值夜班时总把收音机开得很轻。'
                : '一个总在深夜值班的人，习惯把话咽回去一半。',
            personality: '话少，但记得住每个人点过什么。',
            tags: ['冒烟', '测试'],
            attributes: [
              { name: '好感度', type: 'number', value: 5, mode: 'dynamic' },
              { name: '身份', type: 'text', value: '帮工', mode: 'static' }
            ]
          });
      for (const piece of payloadText.match(/[\s\S]{1,40}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(2);
      }
      return {
        ok: true,
        requestId,
        model,
        content: payloadText,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    const askedToOnlyThink = turn.includes('只思考不回答');
    const askedThinkBurn = turn.includes('思考挤掉正文');
    const askedTruncatedBody = turn.includes('截断正文');
    const askedTruncatedForever = turn.includes('截断到底');
    const askedPanelMiss = turn.includes('漏状态表');
    const askedResumeMiss = turn.includes('续写找状态表');

    // 「漏状态表」：正文写得好好的，但整轮一个状态字段都没提 —— 状态卡"不跟着
    // 剧情走"最常见的形态。上层应当自动补问一次；补问那一次（panelNudged）
    // 才把状态表交出来。两次返回不同内容，才验得出「补问真的发生了」。
    if (askedPanelMiss) {
      const body = panelNudged
        ? '嗯，正文就写到这里。\n\n【金币】：88\n【上衣】：斗篷'
        : '冒烟测试回复：这一段正文写得挺顺，可这一轮我什么状态都没提。';
      for (const piece of body.match(/[\s\S]{1,6}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(4);
      }
      return {
        ok: true,
        requestId,
        model,
        content: body,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    // 「续写找状态表」：先「只思考没落笔」（正文一个字都没有），再把正文交给
    // 「继续」补出来 —— 但续写出来的正文照样不提状态表。验证**续写路径**也会补问。
    //
    // 为什么单独测这条：主生成那条路（情形三）本来就会补问，但「只思考没落笔 →
    // 点继续」绕过了它 —— 而「状态卡一整局都不更新」的反馈正是从这条路来的。
    if (askedResumeMiss) {
      // ① 主生成（含自动重试）：只思考、不落笔。
      // 判据要同时排除「继续」和「补问」两种引导语 —— 注意 **CONTINUE_NUDGE 不进历史**，
      // 所以补问那一次请求里看不到它（continuedNudged 会是 false），光靠它区分不开。
      if (!continuedNudged && !panelNudged) {
        const thinking = '我先想想该怎么接，想着想着又扯远了……';
        for (const piece of thinking.match(/[\s\S]{1,8}/g) || []) {
          if (!event.sender.isDestroyed()) event.sender.send('chat:reasoning', { requestId, text: piece });
          await sleep(4);
        }
        return {
          ok: true,
          requestId,
          model,
          content: '',
          reasoning: thinking,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 5 },
          finishReason: 'length'
        };
      }

      // ② 「继续」补出正文（照旧不提状态表）／③ 补问才交出状态表
      const body = panelNudged
        ? '接着往下写。\n\n【金币】：55'
        : '冒烟测试回复：正文被「继续」补出来了，可这一轮照样一个状态都没提。';
      for (const piece of body.match(/[\s\S]{1,6}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(4);
      }
      return {
        ok: true,
        requestId,
        model,
        content: body,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    // 「只思考不回答」：模拟推理模型把 max_tokens 全花在思考上、正文被截断的情形。
    // 只发 reasoning 增量、不发正文增量，最终返回 content 为空、reasoning 非空。
    // 连自动重试也一样失败 —— 用来验证「重试也救不回来」时的兜底提示。
    // 「思考挤掉正文」是同一情形的另一种输入，但它带自动重试引导的第二次请求
    // 会正常回复 —— 用来验证「自动重试把正文救回来」。
    if (askedToOnlyThink || (askedThinkBurn && !retryNudged)) {
      const thinking = '我在想这件事到底该怎么办，越想越觉得……';
      for (const piece of thinking.match(/[\s\S]{1,8}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:reasoning', { requestId, text: piece });
        await sleep(4);
      }
      return {
        ok: true,
        requestId,
        model,
        content: '',
        reasoning: thinking,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 5 },
        // 这一路模拟的正是「思考把 max_tokens 花光、正文还没开始就被截断」，
        // 服务商会给 finish_reason='length' —— 上层据此才敢断定是长度截断。
        finishReason: 'length'
      };
    }

    // 「截断正文」：正文写了一半撞上限（真实形态是状态栏写到一半断掉）。
    // 有正文、但 finishReason 是 'length' —— 用来验证两件事：
    //   · 气泡里会挂一行说明，而不是让残缺无声地过去；
    //   · 应用会自动接着写（带续写引导语的第二次请求正常收尾）。
    // 「截断到底」是同一情形的顽固版：续写请求照样撞上限 —— 用来验证
    // 「只续有限次就停下、剩下交给用户按继续」，不会变成一个无底洞。
    if (askedTruncatedBody || askedTruncatedForever) {
      const body = continuedNudged
        ? askedTruncatedForever
          ? '又挤出来一点，还是撞上限'
          : '……自动接着写完的后半段。'
        : '冒烟测试回复：写到这儿就：';
      for (const piece of body.match(/[\s\S]{1,6}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(6);
      }
      // 续写请求里「截断正文」正常收尾（stop），其余一律仍是 length
      const stopped = continuedNudged && !askedTruncatedForever;
      return {
        ok: true,
        requestId,
        model,
        content: body,
        reasoning: '',
        // 带 reasoning_tokens：界面要把它标在思考折叠标题和用量行上。
        // 带 cached_tokens：顶栏和用量行都要显示缓存命中率（10 个输入里命中 7 → 70%）。
        usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19, reasoning_tokens: 6, cached_tokens: 7 },
        finishReason: stopped ? 'stop' : 'length'
      };
    }

    // 「帮我想想」会带一条特殊的指令（补一批剧情选项）；这时给回几个选项，好让测试能验证解析与渲染。
    // 故意让模型「不听话」带序号和引号、也不带「【剧情选项】：」标记 —— 测试要能容忍（走按行兜底）。
    const askedForSuggestions = ((payload && payload.messages) || []).some((m) =>
      String((m && m.content) || '').includes('补一批剧情选项')
    );
    if (askedForSuggestions) {
      const suggestions = [
        '1. 「我想先喝一杯，压压惊」',
        '2. 我直接问他叫什么名字',
        '3. 我假装什么都没听见，继续吃',
        '4. 我站起来准备走',
        '5. 这条应该被丢掉（只取前 4 个）'
      ].join('\n');

      for (const piece of suggestions.match(/[\s\S]{1,20}/g) || []) {
        if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
        await sleep(4);
      }

      return {
        ok: true,
        requestId,
        model,
        content: suggestions,
        reasoning: '',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finishReason: 'stop'
      };
    }

    replySeq += 1;
    let CONTENT = `冒烟测试回复 #${replySeq}：我收到了。**这是加粗**，==这是高亮==。`;
    let pieces = [`冒烟测试回复 #${replySeq}`, '：我收到了。', '**这是加粗**，', '==这是高亮==。'];


    // 开了「剧情选项」的会话：多回一行状态栏 + 一行选项。
    // 顺带故意写几个「不听话」的地方（编号、引号、多余空格、重复项），
    // 测试要能容忍 —— 真模型就是会这么写。
    const askedForOptions = ((payload && payload.messages) || []).some((m) =>
      String((m && m.content) || '').includes('【剧情选项】')
    );    if (askedForOptions) {
      // 故意不带方括号（写成「剧情选项：」而不是「【剧情选项】：」）——
      // 指令是让模型带方括号的，但真模型经常漏，解析要两边都认。
      //
      // ⚠️ 但这两种形态有个关键区别：**带方括号的那行长得和面板字段一模一样**
      // （行首【】），不带方括号的则天然匹配不上 PANEL_LINE_RE。
      // 所以只测不带方括号的形态，是测不到「选项被误收成面板字段」这个 bug 的
      // （见 renders 场景里那两条断言）—— 这里两种都发出来。
      const optionsLine =
        '剧情选项：1.「我想先喝一杯，压压惊」 / 我直接问他叫什么名字 / ' +
        '3） 我假装什么都没听见，继续吃 / 我想先喝一杯，压压惊 / 这条应该被丢掉（只取前几个）';
      const bracketedOptionsLine = '【剧情选项】：我想先喝一杯，压压惊 / 我直接问他叫什么名字 / 我假装什么都没听见';
      CONTENT = `${CONTENT}\n\n【好感度】：63/100\n${optionsLine}\n${bracketedOptionsLine}`;
      pieces = [...pieces, '\n\n【好感度】：63/100\n', optionsLine, '\n', bracketedOptionsLine];
    }

    // 用户发「表情标签」时，回复末尾带一个 <emo> 标签。
    // 顺带验「标签优先于关键词」：正文里同时有「这是加粗」（会命中「表情甲」），
    // 标签说的是 shy，最终该以标签为准。按 role 过滤，别被提示词里的 <emo> 字样误触发。
    // 出图（--shot=chat）用：用户消息里带「心理」时，回复补一段心理描写 + 一段旁白。
    // 这两块现在是**左侧 2px 竖条**（心理实线 / 旁白虚线），「元素在不在」能断言，
    // 「竖条位置、缩进、跟正文的间距对不对」只能靠图 —— 所以留个稳定的触发词。
    const askedForVO = ((payload && payload.messages) || []).some(
      (m) => m && m.role === 'user' && String(m.content || '').includes('心理')
    );
    if (askedForVO) {
      const vo = '\n\n【心理】他嘴上说得轻巧，指尖却在袖口里蜷了一下。\n\n【旁白】雨从后半夜起就没停过。';
      CONTENT = `${CONTENT}${vo}`;
      pieces = [...pieces, vo];
    }

    const askedEmoTag = ((payload && payload.messages) || []).some(
      (m) => m && m.role === 'user' && String(m.content || '').includes('表情标签')
    );
    if (askedEmoTag) {
      CONTENT = `${CONTENT}\n<emo>shy</emo>`;
      pieces = [...pieces, '\n<emo>shy</emo>'];
    }

    for (const piece of pieces) {
      if (!event.sender.isDestroyed()) event.sender.send('chat:chunk', { requestId, text: piece });
      await sleep(8);
    }

    return {
      ok: true,
      requestId,
      model,
      content: CONTENT,
      reasoning: '',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        // 带重试引导语的这次请求 = 「思考挤掉正文」的第二次尝试：给它带上
        // reasoning_tokens，好覆盖「思考量跨请求累加、并标在消息标题上」。
        ...(retryNudged ? { reasoning_tokens: 12 } : {})
      },
      finishReason: 'stop'
    };
  });
}

// ---------------------------------------------------------------------------
//  跑测试
// ---------------------------------------------------------------------------
function report(result, consoleErrors, consoleWarnings, crashed) {
  const allResults = (result && result.results) || [];
  const notes = (result && result.notes) || [];
  const timings = (result && result.timings) || [];
  const skippedScenarios = (result && result.skippedScenarios) || [];

  // --only / --skip 时把宿主侧那批「事后翻记录」的断言整段排除：
  // 它们依赖被跳过场景攒下的请求 / 导出记录，在这里必然红，红了也不代表回归。
  const hostSkipped = FILTERED ? allResults.filter((r) => r.scope === 'host').length : 0;
  const results = FILTERED ? allResults.filter((r) => r.scope !== 'host') : allResults;

  const failed = results.filter((r) => !r.pass);
  const width = results.reduce((m, r) => Math.max(m, r.name.length), 0);

  // 场景名 → 耗时（渲染侧按场景执行顺序记的，和断言的顺序一致）
  const msOf = new Map(timings.map((t) => [t.name, t.ms]));
  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');

  // 断言按场景聚合：默认每个场景打一行（✓ 3/3 · 420ms）。
  // 1871 条逐条刷屏，真要那一屏得加 --verbose —— 平时只需要知道「哪个场景红了」。
  const groups = [];
  for (const r of results) {
    const name = r.name.split(' · ')[0];
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, items: [] };
      groups.push(g);
    }
    g.items.push(r);
  }

  console.log('');
  console.log('────────────── 冒烟测试 ──────────────');

  // 全绿时只打一行 —— 136 行「✓ 每个场景」没人看，滚过去只剩最后那行有用。
  // 有红的场景才逐场景展开（这样能看出它前后是哪个场景），想看全量加 --verbose。
  const showGroups = VERBOSE || failed.length > 0 || !!crashed;
  if (showGroups) {
    for (const g of groups) {
      const bad = g.items.filter((r) => !r.pass);
      const ms = msOf.has(g.name) ? ` · ${fmtMs(msOf.get(g.name))}` : '';
      console.log(`  ${bad.length ? '✗' : '✓'} 【${g.name}】 ${g.items.length - bad.length}/${g.items.length}${ms}`);
      const show = VERBOSE ? g.items : bad;
      for (const r of show) {
        const label = r.name.includes(' · ') ? r.name.split(' · ').slice(1).join(' · ') : r.name;
        console.log(`      ${r.pass ? '✓' : '✗'} ${label.padEnd(width)}${r.pass ? '' : '   ← ' + r.detail}`);
      }
    }
  } else {
    console.log(`  ✓ ${timings.length} 个场景全部通过（想看每个场景的条数和耗时加 --verbose）`);
  }
  // 筛选模式下把「到底跑了哪几个」列出来 —— 一行汇总看不出筛得对不对。
  // 只列得下 30 个（--skip 时动辄 130 个，全列等于刷屏），再多就让人加 --verbose。
  if (FILTERED && !VERBOSE && timings.length) {
    const names = timings.map((t) => t.name);
    console.log(
      names.length <= 30
        ? `    跑的 ${names.length} 个场景：${names.join('、')}`
        : `    跑了 ${names.length} 个场景（名单加 --verbose 看）`
    );
  }

  console.log('');
  if (consoleWarnings.length) {
    console.log(`  控制台警告 ${consoleWarnings.length} 条：`);
    consoleWarnings.slice(0, 5).forEach((w) => console.log('    ! ' + w));
    console.log('');
  }
  notes.forEach((n) => console.log('  · ' + n));

  const consoleOk = consoleErrors.length === 0;
  if (!consoleOk) {
    console.log('');
    console.log(`  控制台报错 ${consoleErrors.length} 条：`);
    consoleErrors.slice(0, 10).forEach((e) => console.log('    ! ' + e));
  }

  // 最慢的场景：整套慢的时候，先看这几个在干什么（固定 sleep 是大头）。
  const totalMs = timings.reduce((s, t) => s + t.ms, 0);
  const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 8).filter((t) => t.ms >= 300);
  console.log('');
  if (timings.length) {
    console.log(
      `  场景耗时：${timings.length} 个场景合计 ${(totalMs / 1000).toFixed(1)}s` +
        (slowest.length ? '，最慢的几个：' : '（每个都在 300ms 以内）')
    );
    slowest.forEach((t) => console.log(`    ${fmtMs(t.ms).padStart(6)}  ${t.name}`));
  }

  console.log('');
  const passed = results.length - failed.length;
  console.log(`  断言：${passed}/${results.length} 通过` + (failed.length ? `，${failed.length} 条失败` : ''));
  console.log(`  控制台报错：${consoleErrors.length} 条`);
  console.log(`  写操作记录：${calls.length} 次（${[...new Set(calls)].join(', ')}）`);
  if (crashed) console.log(`  ⚠ ${crashed}`);
  if (skippedScenarios.length) {
    console.log('');
    const filterText = PICK.length
      ? `--group=${GROUP_KEY}（${GROUPS[GROUP_KEY].label}，${PICK.length} 个场景）`
      : `--only=${ONLY.join(',') || '-'}${SKIP.length ? ' --skip=' + SKIP.join(',') : ''}`;
    console.log(
      `  ⚠ 跳过了 ${skippedScenarios.length} 个场景（${filterText}）—— 这**不是**整套验证，` +
        '提代码前请跑一次完整的 `npm run smoke`。'
    );
    if (hostSkipped) console.log(`      （另外排除了 ${hostSkipped} 条场景外的公共断言：它们靠前序场景的状态，这里本来就不成立）`);
    if (VERBOSE) skippedScenarios.forEach((n) => console.log(`      - ${n}`));
  }

  const ok = failed.length === 0 && consoleOk && !crashed;
  console.log('');
  console.log(ok ? '  ✅ 冒烟测试通过' : '  ❌ 冒烟测试失败');
  console.log('──────────────────────────────────────');
  console.log('');
  return ok;
}

/**
 * 悬停验证：卡片上的删除按钮必须「鼠标移上去才浮出来」。
 *
 * 为什么放宿主侧：:hover 只认真实指针，页面里 dispatchEvent 不算；隐藏窗口
 * 也不算 hover，所以走 CDP 的 CSS.forcePseudoState 强制加 :hover。
 * 注意：删除按钮有 transition，隐藏窗口不产生动画帧、过渡永不推进，
 * 所以先临时关掉过渡让计算值直接跳到位（真实窗口里过渡正常播放）。
 */
async function probeHover(win, result) {
  const probe = result && result.hoverProbe;
  if (!probe) return;

  const run = (code) => win.webContents.executeJavaScript(code);
  const readOpacity = () =>
    run("getComputedStyle(document.querySelector('#char-page-grid .char-card .char-card-del')).opacity");

  const before = await readOpacity();

  let after = before;
  let note = '';
  const dbg = win.webContents.debugger;

  try {
    // 关掉过渡：隐藏窗口里过渡不会推进，计算值会永远停在起点
    await run("document.querySelector('#char-page-grid .char-card .char-card-del').style.transition = 'none'");

    dbg.attach('1.3');
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');

    const { root } = await dbg.sendCommand('DOM.getDocument');
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#char-page-grid .char-card'
    });
    if (!nodeId) throw new Error('找不到角色卡节点');

    await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    await sleep(150);
    after = await readOpacity();

    await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    dbg.detach();

    // 复原，别影响后续（虽然之后也没别的断言了）
    await run("document.querySelector('#char-page-grid .char-card .char-card-del').style.transition = ''");
    // elementFromPoint 要有**真实布局**：探针跑到这里时页面早就不在角色卡了
    //（前面几十个场景切来切去），隐藏视图里的卡片 rect 全是 0 —— 直接点会点到侧栏。
    // 先切回角色卡再量。
    await run("document.querySelector('#btn-chars').click()");
    await sleep(350);

    // 窗口是隐藏的，但布局照算 —— 顺便确认它**没被封面盖住**：
    // opacity 变成 1 不等于看得见，绝对定位的 × 如果被后面的封面压住，
    // elementFromPoint 会返回 img 而不是按钮（2026-10-19 查「× 不见了」时加）。
    const hit = await run(`(() => {
      const btn = document.querySelector('#char-page-grid .char-card .char-card-del');
      if (!btn) return 'no-btn';
      const r = btn.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el ? (el.closest('.char-card-del') ? 'self' : el.tagName + '.' + (el.className || '')) : 'none';
    })()`);

    result.results.push({
      name: '角色卡：卡片上删除 · 悬停时真的浮在最上层（没被封面盖住）',
      pass: hit === 'self',
      detail: `命中元素：${hit}${note}`
    });
  } catch (err) {
    note = '（CDP 出错：' + ((err && err.message) || err) + '）';
    try { if (dbg.isAttached()) dbg.detach(); } catch (e) { /* 忽略 */ }
  }

  result.results.push({
    name: '角色卡：卡片上删除 · 鼠标移上去才会浮出来',
    pass: before === '0' && after === '1',
    detail: `移入前 opacity=${before}，移入后 opacity=${after}${note}`
  });
}

/**
 * 看大图浮层：用**真实鼠标**依次点工具条按钮、点图片、点背景。
 *
 * 为什么非得走真实输入：浮层把 pointerdown 挂在整层上做拖动，顺手对整层调了
 * setPointerCapture。指针一旦被夺走，浏览器算出来的 click 目标就变成「整层」而不是
 * 按钮 —— 按钮的 click 收不到，还会被当成「点了背景」把浮层一并关掉。
 * 这套行为只在真实指针下出现，页面里 dispatchEvent 复现不出来。
 */
const window_shape = (pair) => `${pair[0]}×${pair[1]}`;

async function probeLightboxClick(win, result) {
  const run = (code) => win.webContents.executeJavaScript(code);
  const read = () =>
    run(`(() => {
      const lb = document.getElementById('lightbox');
      const img = lb && lb.querySelector('.lightbox-img');
      return { open: !!lb, transform: (img && img.style.transform) || '' };
    })()`);
  const scaleOf = (t) => {
    const m = /scale\(([\d.]+)\)/.exec(t || '');
    return m ? Number(m[1]) : 0;
  };

  // 打开灯箱，顺手把「＋」按钮和图片的中心坐标量出来
  const spots = await run(`(async () => {
    const $$ = (s) => Array.from(document.querySelectorAll(s));
    const $ = (s) => document.querySelector(s);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const view = $('#view-chars');
    if (!view || view.classList.contains('hidden')) {
      const b = $('#btn-chars');
      if (b) b.click();
      await nap(400);
    }
    const card = $$('#char-page-grid .char-card').find((c) => c.querySelector('.char-card-avatar.clickable'));
    if (!card) return null;
    card.querySelector('.char-card-avatar.clickable').click();
    for (let i = 0; i < 60 && !$('#lightbox'); i++) await nap(50);
    const btn = $('#lightbox-in');
    const img = $('#lightbox .lightbox-img');
    if (!btn || !img) return null;
    const mid = (n) => {
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    return { btn: mid(btn), img: mid(img), fit: mid($('#lightbox-reset')) };
  })()`);

  if (!spots) {
    result.results.push({ name: '看大图：真实鼠标点击', pass: false, detail: '页面里没能打开灯箱' });
    return;
  }

  const dbg = win.webContents.debugger;
  let note = '';
  let afterBtn = null;
  let afterImg = null;
  let afterBackdrop = null;

  try {
    dbg.attach('1.3');
    const clickAt = async (x, y) => {
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
      });
      await sleep(40);
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1
      });
      await sleep(180);
    };

    const before = await read();
    await clickAt(spots.btn.x, spots.btn.y);
    afterBtn = await read();

    result.results.push({
      name: '看大图：真实鼠标点「＋」能放大，且不会把浮层关掉',
      pass: afterBtn.open && scaleOf(afterBtn.transform) > scaleOf(before.transform),
      detail: `点前 scale=${scaleOf(before.transform)}，点后 scale=${scaleOf(afterBtn.transform)}，浮层${
        afterBtn.open ? '还在' : '被关掉了'
      }${note}`
    });

    // 点图片本身不该关：只有按在图片外那圈上才算「点背景」
    await clickAt(spots.img.x, spots.img.y);
    afterImg = await read();
    result.results.push({
      name: '看大图：真实鼠标点图片本身不会误关',
      pass: afterImg.open,
      detail: `点完浮层${afterImg.open ? '还在' : '被关掉了'}${note}`
    });

    // 「适应 / 实际大小」那个切换按钮也得用真实鼠标点一遍 —— 它和「＋」同处一条
    // 工具条，被指针捕获吞掉的毛病是一样的。
    const readFit = () =>
      run(`(() => {
        const b = document.getElementById('lightbox-reset');
        return b ? { cls: b.className, label: b.getAttribute('aria-label') || '' } : null;
      })()`);
    const fitBefore = await readFit();
    await clickAt(spots.fit.x, spots.fit.y);
    const fitAfter = await readFit();
    const imgAfterFit = await read();
    const toggled = !!fitBefore && !!fitAfter && fitBefore.cls !== fitAfter.cls;
    result.results.push({
      name: '看大图：真实鼠标点「适应/实际大小」能切档，且不会把浮层关掉',
      pass: imgAfterFit.open && toggled,
      detail:
        `切前 ${fitBefore && fitBefore.label}（${fitBefore && fitBefore.cls}）→ ` +
        `切后 ${fitAfter && fitAfter.label}（${fitAfter && fitAfter.cls}），浮层${imgAfterFit.open ? '还在' : '被关掉了'}${note}`
    });
    // 切回适应，好让后面「点背景关闭」那步从 1 倍开始
    await clickAt(spots.fit.x, spots.fit.y);
    await sleep(80);

    // 回到 1 倍再点左上角空白 —— 这才是该关的时候
    await run("document.getElementById('lightbox-reset')?.click(); true");
    await sleep(80);
    // ⚠️ 点「背景」有两个坑，2026-10-12 一次踩齐：
    //   ① 不能写死 (6,6) —— 那是赌「左上角一定有背景」；
    //   ② 也不能按图片元素的 rect 去找「外面」—— 图片一旦停在「实际大小」档，
    //      它的 rect 就会铺满整个浮层，于是点哪都在图片上，浮层当然不关。
    // 可靠做法：先把缩放档**确认回「适应」**（scale 回到 1）。这时 2:3 的图
    // 在 1008×689 的视口里只有 ~386 宽、居中，左右各留三百来像素的真空白。
    for (let i = 0; i < 4; i++) {
      const scaleText = await run(`(() => {
        const img = document.querySelector('#lightbox .lightbox-img');
        return (img && img.style.transform) || '';
      })()`);
      const m = /scale\(([\d.]+)\)/.exec(scaleText);
      if (!m || Number(m[1]) <= 1.001) break;   // 没有 scale、或已经是 1 倍
      await run("document.getElementById('lightbox-reset')?.click(); true");
      await sleep(150);
    }

    const outside = await run(`(() => {
      const img = document.querySelector('#lightbox .lightbox-img');
      const r = img ? img.getBoundingClientRect() : null;
      const mid = Math.round(window.innerHeight / 2);
      if (!r || r.left < 40) return { x: 8, y: mid, where: '图片贴着左边，退回 8px' };
      return { x: Math.max(8, Math.round(r.left) - 16), y: mid, where: '图片左侧的留白' };
    })()`);
    await clickAt(outside.x, outside.y);
    afterBackdrop = await read();

    // 这几个数是「窗口到底多大」的唯一实证。写在这里不是凑数：
    // 灯箱是 fixed;inset:0，它的 rect 就等于视口 —— 视口不对，后面所有
    // 按坐标点的断言都会跟着错，而且错得很像「功能坏了」。
    const winInfo = await run(`({
      inner: [window.innerWidth, window.innerHeight],
      outer: [window.outerWidth, window.outerHeight],
      dpr: window.devicePixelRatio,
      scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight]
    })`);
    console.log(
      '  [窗口探针] 视口', window_shape(winInfo.inner),
      '外框', window_shape(winInfo.outer),
      'dpr', winInfo.dpr,
      '内容', window_shape(winInfo.scroll),
      '· 点的是', outside.where, `(${outside.x},${outside.y})`
    );
    result.results.push({
      name: '看大图：真实鼠标点背景能关掉',
      pass: !afterBackdrop.open,
      detail: `点完浮层${afterBackdrop.open ? '还开着' : '关掉了'}${note}`
    });
  } catch (err) {
    note = '（CDP 出错：' + ((err && err.message) || err) + '）';
    result.results.push({ name: '看大图：真实鼠标点击', pass: false, detail: note });
  } finally {
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch (e) {
      /* 忽略 */
    }
    // 别把浮层留在页面上，后面还有截图
    try {
      await run("document.getElementById('lightbox-close')?.click(); true");
    } catch (e) {
      /* 忽略 */
    }
  }
}

/**
 * 注入内容验证：看**真正发给模型的消息**里有没有该有的东西。
 *
 * 这是唯一能确认「注入真的生效」的地方 —— 页面上看不出模型收到了什么，
 * 而这条链路（角色卡属性 → 会话面板 → 系统提示词）正是这个功能的全部意义。
 *
 * 注意：不看「最后一条」，而是把每次请求都收进来找。
 * 因为进世界会立刻多发一次「生成开局」的请求（开场白已经撤了，开局一律现生成），
 * 那次是不带状态面板的 —— 只认最后一条会误判。
 */
function probeInjection(result) {
  if (!result) return;

  // 状态表注入块那句「归属声明」——用它认面板段在不在，**不用** `[当前状态]`。
  // 那个方括号抬头本身就是要修掉的毛病：实测（真实 API）有安全对齐的模型会把它
  // 读成「外部塞进来的一段指令」并明确拒绝执行（thinking 里写着
  // "…an artifact/injection. I should not execute it"），整轮一个状态字段都不写。
  const PANEL_HEAD = '这是本局的状态表';
  const panelFrom = (b) => {
    const i = b.indexOf(PANEL_HEAD);
    return i >= 0 ? i : 0;
  };

  const blobs = chatPayloads.map((msgs) => msgs.map((m) => String((m && m.content) || '')).join('\n'));

  const panelOk = blobs.some(
    (b) => b.includes(PANEL_HEAD) && b.includes('【金币】：100') && b.includes('【上衣】：布衣')
  );
  result.results.push({
    name: '属性：注入给模型的消息里带上了状态面板',
    pass: panelOk,
    detail: panelOk ? '' : `翻了 ${blobs.length} 次请求都没找到完整面板`
  });

  // 抬头必须是「由你在每轮回复的末尾维护」这种归属声明，而不是 `[当前状态]` 块标记；
  // 同时末尾要有格式承诺（行怎么写、必须落在正文之后）。这两条一起决定模型写不写。
  const promptShapeOk = blobs.some(
    (b) => b.includes(PANEL_HEAD) && b.includes('由你在每轮回复的末尾维护') && b.includes('必须写在正文末尾')
  );
  result.results.push({
    name: '属性：面板段用「你在维护」的口吻，并带末尾格式承诺',
    pass: promptShapeOk,
    detail: promptShapeOk ? '' : '注入里没找到归属声明 / 末尾格式承诺'
  });
  const noMarker = !blobs.some((b) => b.includes('[当前状态]'));
  result.results.push({
    name: '属性：面板段不再带 [当前状态] 这种「外部注入」标记',
    pass: noMarker,
    detail: noMarker ? '' : '注入里又出现了 [当前状态] —— 模型会把它当成外部注入拒掉'
  });

  // 提醒段要落在**整批 system 的最后**（离生成位置最近）。角色卡的
  // post_history_instructions 排在面板段之后时，最容易把状态表的要求挤掉 ——
  // 实测同一输入下「漏写状态表」的主因就是这个位置。
  const reminderLast = chatPayloads.some((msgs) => {
    const sys = msgs.filter((m) => m && m.role === 'system');
    const last = sys.length ? String(sys[sys.length - 1].content || '') : '';
    return last.startsWith('（提醒：这一次回复的最后');
  });
  result.results.push({
    name: '属性：状态表的末尾提醒是最后一条 system',
    pass: reminderLast,
    detail: reminderLast ? '' : '最后一条 system 不是那句提醒'
  });

  // 【标重点】的最后一声（EMPHASIS_REMINDER）要排在状态表提醒**之前** ——
  // 它是在最靠近生成位置的地方再点一次「台词要加粗」（那条规则排在扮演/主持规则里，
  // 离得太远，模型经常当没看见）。但状态表那句必须仍是最后一条，别被它挤下去。
  const emphasisBeforePanel = chatPayloads.some((msgs) => {
    const sys = msgs.filter((m) => m && m.role === 'system');
    if (sys.length < 2) return false;
    const last = String(sys[sys.length - 1].content || '');
    const prev = String(sys[sys.length - 2].content || '');
    return last.startsWith('（提醒：这一次回复的最后') && prev.includes('【最后提醒】');
  });
  result.results.push({
    name: '标重点：【最后提醒】排在状态表提醒之前、且没把它挤下最后一位',
    pass: emphasisBeforePanel,
    detail: emphasisBeforePanel ? '' : `共 ${chatPayloads.length} 次请求都没找到这个组合`
  });

  // 模型整轮没写状态表时的补问：请求的最后一条 user 必须就是那句补问语。
  // 假后端在「漏状态表」场景里第一次故意不回状态表，靠这条断言确认
  // 「程序真的补问了一次」，而不只是碰巧拿到了值。
  // 认「只补这一件事」这个特征串（panel.js 的 PANEL_PROMPT_NUDGE 同理），
  // 别拿会被改写的句子开头当锚。
  // chatPayloads 与 chatSampling 是同一次请求里并排 push 的，下标一一对应 ——
  // 靠下标把「这次请求要了什么参数」和「这次请求发了什么内容」对起来。
  const nudgedIdx = chatPayloads.findIndex((msgs) => {
    const users = msgs.filter((m) => m && m.role === 'user');
    const last = users.length ? String(users[users.length - 1].content || '') : '';
    return last.includes('只补这一件事');
  });
  result.results.push({
    name: '属性：漏写状态表时程序补问了一次',
    pass: nudgedIdx >= 0,
    detail: nudgedIdx >= 0 ? '' : '没找到带补问引导语的请求'
  });

  // 补问只是把这一轮的数值抄成一行，推理链在这里纯烧钱（实测一次补问的思考量
  // 常比状态表本身长几十倍），所以必须带 thinking:false。
  const nudgedSampling = nudgedIdx >= 0 ? chatSampling[nudgedIdx] : null;
  const panelNoThink = !!(nudgedSampling && nudgedSampling.thinking === false);
  result.results.push({
    name: '属性：补问状态表时关掉了深度思考',
    pass: panelNoThink,
    detail: panelNoThink ? '' : `补问请求的 sampling 是 ${JSON.stringify(nudgedSampling)}`
  });

  // 反向：截断续写/「继续」是正文，要质量，不能跟着降温。这条断言防的是
  // 「顺手把 thinking:false 提到 extendAssistantMessage 里」那种一刀切改法。
  const continueIdx = chatPayloads.findIndex((msgs) => {
    const users = msgs.filter((m) => m && m.role === 'user');
    const last = users.length ? String(users[users.length - 1].content || '') : '';
    return last.includes('接着你上一条回复继续往下写');
  });
  const continueSampling = continueIdx >= 0 ? chatSampling[continueIdx] : null;
  const continueKeepsThinking = !(continueSampling && continueSampling.thinking === false);
  result.results.push({
    name: '属性：续写正文不会被一起关掉深度思考',
    pass: continueKeepsThinking,
    detail: continueKeepsThinking
      ? ''
      : `续写请求带了 thinking:false：${JSON.stringify(continueSampling)}`
  });

  // 带范围的数值字段：注入时要告诉模型范围，并明确「超了会被拉回」。
  // 只说「好感度：20」的话，模型不知道 0~100 这回事，写 150 也没人管。
  const rangeBlob = blobs.find((b) => b.includes('【好感度】：20'));
  const rangeOk = !!rangeBlob && rangeBlob.includes('0~100') && rangeBlob.includes('按剧情合理增减，单轮不超过 10');
  result.results.push({
    name: '属性：数值字段的范围和变化规则被注入给模型',
    pass: rangeOk,
    detail: rangeOk
      ? ''
      : rangeBlob
        ? `找到了面板行但缺范围/规则：${JSON.stringify(rangeBlob.slice(panelFrom(rangeBlob), panelFrom(rangeBlob) + 300))}`
        : `翻了 ${blobs.length} 次请求都没找到「【好感度】：20」`
  });
  const warnOk = !!rangeBlob && rangeBlob.includes('超出范围会被程序拉回');
  result.results.push({
    name: '属性：注入里说明了超范围会被拉回',
    pass: warnOk,
    detail: warnOk ? '' : '没找到那句提醒'
  });

  // 分组：注入给模型的状态栏里要有分组小标题，而且**不能**用【】包，
  // 否则会被自己的面板解析器当成一个名叫「关系」的字段。
  const groupBlob = rangeBlob || '';
  const hasHeader = groupBlob.includes('—— 关系 ——');
  result.results.push({
    name: '属性：分组小标题被注入给模型',
    pass: hasHeader,
    detail: hasHeader ? '' : `没找到「—— 关系 ——」：${JSON.stringify(groupBlob.slice(panelFrom(groupBlob), panelFrom(groupBlob) + 300))}`
  });
  result.results.push({
    name: '属性：分组小标题刻意不用【】（否则会被当成字段）',
    pass: hasHeader && !groupBlob.includes('【关系】'),
    detail: hasHeader && !groupBlob.includes('【关系】') ? '' : '注入里出现了【关系】形状的分组标题'
  });
  const groupNote = groupBlob.includes('不要当成字段输出');
  result.results.push({
    name: '属性：注入里交代了小标题不要当字段输出',
    pass: groupNote,
    detail: groupNote ? '' : '没找到那句交代'
  });

  // 剧情选项：开了选项的会话要收到「给几个、怎么给、额外要求」这条指令。
  // ⚠️ 现在**所有角色默认都开**选项，所以带「【剧情选项】」的请求不止这一条 ——
  // 必须按「额外要求那半句」找那一次，不能拿第一条带选项指令的请求来比（那条是默认 4 条）。
  const optBlob = blobs.find(
    (b) => b.includes('【剧情选项】') && b.includes('语气轻松些，总有一条冒险的选择')
  );
  const optOk =
    !!optBlob &&
    optBlob.includes('给出 3 个选项') &&
    optBlob.includes('语气轻松些，总有一条冒险的选择') &&
    optBlob.includes('用「 / 」隔开');
  result.results.push({
    name: '剧情选项：数量和额外要求被注入给模型',
    pass: optOk,
    detail: optOk ? '' : optBlob ? JSON.stringify(optBlob.slice(optBlob.indexOf('【剧情选项】'), optBlob.indexOf('【剧情选项】') + 200)) : `翻了 ${blobs.length} 次请求都没有选项指令`
  });

  // 没开选项的会话不该收到这条指令（否则每个会话都白烧 token）
  const suggestOnly = blobs.filter((b) => !b.includes('【剧情选项】'));
  result.results.push({
    name: '剧情选项：没开的会话不会被注入选项指令',
    pass: suggestOnly.length > 0,
    detail: `共 ${blobs.length} 次请求，其中 ${suggestOnly.length} 次没带选项指令`
  });

  const playerOk = blobs.some((b) => b.includes('【玩家角色：改过的名字】'));
  result.results.push({
    name: '角色卡开局：注入的是你选/改过的玩家角色',
    pass: playerOk,
    detail: playerOk ? '' : `翻了 ${blobs.length} 次请求都没找到「【玩家角色：改过的名字】」`
  });

  // 身份三件套（年龄/性别/种族）已整体移除，注入链路上只剩姓名
  const identityOk = blobs.some((b) => b.includes('【姓名】：改过的名字'));
  result.results.push({
    name: '角色卡开局：面板里的姓名被注入给模型',
    pass: identityOk,
    detail: identityOk ? '' : `翻了 ${blobs.length} 次请求都没找到「【姓名】：改过的名字」`
  });

  // 角色卡开局 = GM 局：卡要作为「本局主要角色」进提示词，否则叙述者不知道这一局围着谁开
  const focusOk = blobs.some((b) => b.includes('【本局主要角色】') && b.includes('「进世界的角色」'));
  result.results.push({
    name: '角色卡开局：卡作为「本局主要角色」注入了 GM 提示词',
    pass: focusOk,
    detail: focusOk ? '' : `翻了 ${blobs.length} 次请求都没找到「本局主要角色 / 进世界的角色」`
  });
}

/**
 * 预设验证。
 *
 * 「预设 = 叠在对话上的一层指令」，存下来、选上都不算数，**最后有没有拼进
 * 发给模型的消息**才是这个功能的落点 —— 而 chat:send 记下的真实 messages
 * 只有宿主侧看得到（页面里没有这条数据），所以这几条断言的宿主侧版本在这里。
 *
 * 前两条（正文来源）验证归一层认得「别人分享的导入形态」：正文住在
 * metadata.systemPromptContent 里，description 只是给人看的说明。smoke-renderer
 * 那边读的是经假后端归一化之后落盘的样子，这里读的是它拼进提示词的样子。
 */
function probePresets(result) {
  if (!result) return;

  const blobs = chatPayloads.map((msgs) => msgs.map((m) => String((m && m.content) || '')).join('\n'));

  // 绑了预设的那一轮：整块应该在，正文 + 常驻条目都在
  const presetBlob = blobs.find((b) => b.includes('【预设 · 带条目的预设】'));
  result.results.push({
    name: '预设：绑定的预设正文被拼进了提示词',
    pass: !!presetBlob && presetBlob.includes('最前面的总则。（改过了）'),
    detail: presetBlob ? '没找到正文' : `翻了 ${blobs.length} 次请求都没有【预设 · 带条目的预设】`
  });

  // 每条预设各自成一块（`【预设 · 名称】`），名字要出现在块头 ——
  // 多条一起挂的时候，光看正文分不清哪句是谁说的。
  const hasHeading = !!presetBlob && /【预设 · 带条目的预设】/.test(presetBlob);
  result.results.push({
    name: '预设：每条预设各自成一个带名字的块',
    pass: hasHeading,
    detail: hasHeading ? '' : '找不到【预设 · 带条目的预设】这个块头'
  });

  // 无关键词的条目 = 常驻，每轮都该带上
  const constOk = !!presetBlob && presetBlob.includes('这条每轮都带上。');
  result.results.push({
    name: '预设：常驻条目每轮都进提示词',
    pass: constOk,
    detail: constOk ? '' : '常驻条目的正文没进提示词'
  });

  // 宏：编辑器里明确写着「可以用 {{char}} / {{user}}，发送时会替换成角色名和你的名字」。
  // 模型收到字面量，就是这句承诺没兑现 —— 而它在界面上看不出任何异常（要翻请求记录才发现）。
  const macroLeft = !!presetBlob && presetBlob.includes('{{char}} 看着');
  result.results.push({
    name: '预设：正文 / 条目里的宏在注入前被替换成真名',
    pass: !!presetBlob && !macroLeft && /看着 你 走进来/.test(presetBlob),
    detail: macroLeft
      ? '提示词里还留着 {{char}} 字面量'
      : presetBlob
        ? '宏换掉了，但没换成 `你`（{{user}} 的默认值）'
        : '没找到预设那一块'
  });

  // 有关键词但这一轮没提到的条目不该带上（否则整份预设每轮全烧一遍 token）
  const keySkipped = !!presetBlob && !presetBlob.includes('说到「暗号」才带上这条。');
  result.results.push({
    name: '预设：没命中的关键词条目不进提示词',
    pass: keySkipped,
    detail: keySkipped ? '' : '没提到的关键词条目还是被带上了'
  });

  // 说明（description / note）是给人看的，绝不能混进正文发给模型 ——
  // 这是「描述与正文分离」这条设计的底线。
  const noteLeaked = blobs.some(
    (b) => b.includes('【预设 ·') && (b.includes('测试用的说明') || b.includes('这个说明只给人看'))
  );
  result.results.push({
    name: '预设：说明不会被发给模型',
    pass: !noteLeaked,
    detail: noteLeaked ? '预设的说明混进了提示词' : ''
  });

  // 导入形态的预设（正文只在 metadata.systemPromptContent）也要能用；
  // 它这一轮没被绑上（绑的是「带条目的预设」），所以不该出现 —— 反过来说，
  // 一旦它出现了就说明绑定逻辑没生效，全场都收到了所有预设。
  const unboundLeaked = blobs.some((b) => b.includes('每一轮都要推进一个具体事件，不要停在原地。'));
  result.results.push({
    name: '预设：没绑的预设不会被带上',
    pass: !unboundLeaked,
    detail: unboundLeaked ? '没绑定到会话的预设也被拼进了提示词' : ''
  });

  // ⭐ 多选的核心断言：会话说的是「手动配成只勾一条」，
  // 那么**勾了「可全局」的那条不能偷偷跟着进来** ——
  // 「没配过就跟随全局」和「配过了就按配的来」是两回事，搞混的话
  // 用户永远关不掉某条全局预设，这正是这套设计要解决的问题。
  //
  // ⚠️ 别扫全部 payload：几十次发送发生在别的会话上，那些会话「没配过」时
  // 带上全局预设是**对的**。也**别只看最后一次** —— 这句话从前写在这里，但
  // 它是靠「预设那一轮正好是最后发的」这个巧合成立的：后来加了「请求记录」
  // 场景，它在末尾新建会话再发一条（那条会带上全局预设，完全正确），
  // 于是这条断言就误报了。**改用内容认领**：凡是被拼进了「带条目的预设」
  // 的那些请求，就是那个手动配过的会话发出去的，一条都不许夹带全局预设。
  const presetBound = blobs.filter((b) => b.includes('【预设 · 带条目的预设】'));
  const globalLeaked = presetBound.some(
    (b) => b.includes('【预设 · 全局通用预设】') || b.includes('这场对话默认带上这一条。')
  );
  result.results.push({
    name: '预设：手动配过的会话不受「可全局」预设影响',
    // 认领不到任何请求也算失败：否则这段变成空跑，等于这条断言被悄悄取消
    pass: presetBound.length > 0 && !globalLeaked,
    detail: globalLeaked
      ? `会话只勾了一条，可全局的预设还是被带上了（查了 ${presetBound.length} 次请求）`
      : presetBound.length
        ? ''
        : '没有任何请求带上「带条目的预设」—— 这条断言没法判断了'
  });

  // 采样参数：预设没设过就不该覆盖全局。这里只在「没设过」的方向断言
  // ——设过的那条要真调 API 才看得出，冒烟里验的是「不设 = 不干预」。
  const fakeEndpointSampling = chatPayloads.some((msgs) =>
    msgs.some((m) => m && m.role === 'system' && /temperature|top_p|采样/.test(String(m.content || '')))
  );
  result.results.push({
    name: '预设：采样参数走请求参数，不往消息里塞',
    pass: !fakeEndpointSampling,
    detail: fakeEndpointSampling ? '采样参数被当成文本塞进了消息' : ''
  });

  // 「设过」的方向：smoke-renderer 在编辑「带条目的预设」时把温度填成 0.55，
  // 绑上它的那一轮请求里就必须带着 temperature=0.55。
  // ⚠️ 以前这里只验了「不设 = 不干预」，而「设了到底有没有生效」没人看 ——
  //    `dialoguePresetSampling` 接错字段（比如把 maxTokens 写成 max_tokens）也不会红。
  const tempValues = chatSampling.filter((s) => s && Number.isFinite(s.temperature)).map((s) => s.temperature);
  result.results.push({
    name: '预设：设过的温度会跟着请求发出去',
    pass: tempValues.length > 0 && tempValues.every((v) => v === 0.55),
    detail: tempValues.length
      ? `请求里的温度：${tempValues.join(' / ')}`
      : '没有任何一次请求带 temperature —— 预设的采样没生效'
  });
}

/**
 * 导出验证。放在宿主侧的原因：渲染层把内容交给主进程之后自己就看不见了。
 *
 * 最有价值的一条是**真往返**：拿渲染层生成的 PNG 字节，用主进程真正在用的
 * pngWithTextChunk 把卡数据插进去，再用 parseCharacterCardPng 读回来 ——
 * 这两步都是真代码（main/png.js），所以「导出的卡能不能被导入」是真验过的。
 */
function probeExports(result) {
  // 按内容找，不按下标 —— 以后调整场景顺序时不会连带把断言搞错。
  // ⚠️ 世界书那条要认准「独立导出的 lorebook」：角色卡里也有 entries，
  // 而且导出的卡也可能内嵌 character_book，光看 `"entries"` 会误配到角色卡上。
  // 独立导出的书顶层是 name + entries 对象，且没有 chara_card_v2 那套字段。
  const charExport = exportedPayloads.find((p) => p.text && p.text.includes('chara_card_v2'));
  const convoExport = exportedPayloads.find((p) => String(p.fileName || '').endsWith('.md'));

  // --- 角色卡 ---
  let cardOk = false;
  let cardDetail = '没有导出记录';
  if (charExport) {
    try {
      const png = Buffer.from(String(charExport.base64 || ''), 'base64');
      const withText = pngWithTextChunk(png, charExport.pngText.keyword, charExport.pngText.text);
      const card = parseCharacterCardPng(withText);
      const ext = (card && card.data && card.data.extensions && card.data.extensions.mimitale) || {};
      const attrs = Array.isArray(ext.attributes) ? ext.attributes : [];
      // 属性已归本书角色（副本）：角色卡自身不再带属性，导出的卡 attributes 为空。
      // 属性的 PNG 往返（范围/规则）改由世界书副本那一路覆盖（见 smoke-renderer.js 的属性场景）。
      cardOk =
        !!card &&
        card.spec === 'chara_card_v2' &&
        card.data.name === '属性测试角色' &&
        attrs.length === 0;
      cardDetail = card ? `读回来的是「${card.data.name}」 ext=${JSON.stringify(ext)}` : 'PNG 里没读回卡数据';
    } catch (err) {
      cardDetail = '往返崩了：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：角色卡 PNG 写进去还能读回来（真往返）',
    pass: cardOk,
    detail: cardOk ? '' : cardDetail
  });
  result.results.push({
    name: '导出：角色卡文件名默认 .png',
    pass: !!charExport && String(charExport.fileName).endsWith('.png'),
    detail: String(charExport && charExport.fileName)
  });

  // --- 世界书 ---
  // 世界书没有导出入口了（书只能从角色的「自带世界书」进，不再有列表页卡片），
  // 酒馆 lorebook 形状的验证由上面那组「导出 → 导入真往返」负责（它直接调 worldbookPayload）。

  // --- 会话 ---
  const md = String((convoExport && convoExport.text) || '');
  const convoOk =
    !!convoExport &&
    String(convoExport.fileName).endsWith('.md') &&
    md.startsWith('# ') &&
    md.includes('改过的回复内容') &&
    md.includes('## 对话');
  result.results.push({
    name: '导出：会话是能读的 Markdown',
    pass: convoOk,
    detail: convoOk ? '' : md.slice(0, 80)
  });

  // --- 导出的角色卡里得带上「这张卡绑定的世界书」 ---
  // 这条以前写死 null，表现是「导出再导入，背景设定全丢」。
  // 注意：卡里带的是 character_book（v2 规范字段），不是应用内的 worldbookIds ——
  // 后者是我们的内部记录，本来就不该写进卡里。
  let boundOk = false;
  let boundDetail = '没有角色卡导出记录';
  if (charExport) {
    try {
      const card = JSON.parse(String(charExport.text || '{}'));
      const book = card.data && card.data.character_book;
      boundOk = !!book && !!book.name;
      boundDetail = `character_book=${book ? `「${book.name}」` : 'null'}`;
    } catch (err) {
      boundDetail = '角色卡 JSON 解析失败：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：角色卡带上了它绑定的世界书',
    pass: boundOk,
    detail: boundOk ? '' : boundDetail
  });

  // --- 导出 → **真导入**：卡里那本书过一遍真实导入链路还能回来 ---
  // 上面那条只证明「导出的 JSON 里有这个字段」，这条证明「这字段真能被读回来」。
  // 中间隔着 PNG 编码、base64、形状识别、归一化、自动绑定 —— 全是真代码。
  let roundOk = false;
  let roundDetail = '没有角色卡导出记录';
  if (charExport) {
    try {
      const png = Buffer.from(String(charExport.base64 || ''), 'base64');
      const cardPng = pngWithTextChunk(png, charExport.pngText.keyword, charExport.pngText.text);
      const back = importFiles({
        paths: ['D:\\roundtrip\\card.png'],
        readFile: () => cardPng,
        parseImportFile,
        makeWorldbookId: () => 'w-roundtrip'
      });
      const c = (back.characters || [])[0];
      const b = (back.worldbooks || [])[0];
      roundOk =
        !!c &&
        !!b &&
        Array.isArray(c.worldbookIds) &&
        c.worldbookIds[0] === b.id &&
        (b.entries || []).length > 0;
      roundDetail = `角色=${c && c.name} 书=${b && b.name} 条目=${b ? (b.entries || []).length : 0} 绑定=${JSON.stringify(
        c && c.worldbookIds
      )} errors=${JSON.stringify(back.errors)}`;
    } catch (err) {
      roundDetail = '往返崩了：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出 → 导入：卡里自带的世界书真的能读回来（真往返）',
    pass: roundOk,
    detail: roundOk ? '' : roundDetail
  });

  // --- 备选开场白 / 作者 / 版本：**真导入链路**读得进 ---
  // 这三个字段在角色编辑器里没有输入框（导入专有），所以只能手搓一张 v2 卡
  // 过一遍真的 parseImportFile + normalizeCharacter。
  // 「导出写得回」那半在渲染层（probeExports 不是 async，调不了 executeJavaScript），
  // 见 smoke-renderer.js 的「导出：备选开场白 / 作者 / 版本」。
  let metaOk = false;
  let metaDetail = '';
  try {
    const withAlt = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '多开场白测试卡',
        first_mes: '第一条',
        // 第二条故意重复、第三条两端带空白 —— 归一化必须去重 + 剪掉两端空白
        alternate_greetings: ['第二条', '第二条', '   第三条   '],
        creator: '某作者',
        character_version: '2.2'
      }
    };
    const imported = parseImportFile({
      buffer: Buffer.from(JSON.stringify(withAlt), 'utf8'),
      ext: '.json',
      fallbackName: 'x',
      makeWorldbookId: () => 'w-alt',
      normalizeCharacters: (raw) => normalizeCharacter(raw, 'json')
    });
    const c = imported.character || {};

    // 没有备选开场白的卡：不该凭空多出这个键（和 expressions 同理，省存储）
    const plain = parseImportFile({
      buffer: Buffer.from(JSON.stringify({ data: { name: '单开场白', first_mes: '一' } }), 'utf8'),
      ext: '.json',
      fallbackName: 'x',
      makeWorldbookId: () => 'w-plain',
      normalizeCharacters: (raw) => normalizeCharacter(raw, 'json')
    });
    const p = plain.character || {};

    metaOk =
      imported.kind === 'character' &&
      c.creator === '某作者' &&
      c.characterVersion === '2.2' &&
      Array.isArray(c.alternateGreetings) &&
      c.alternateGreetings.length === 2 &&
      c.alternateGreetings[0] === '第二条' &&
      c.alternateGreetings[1] === '第三条' &&
      !('alternateGreetings' in p) &&
      p.creator === '';
    metaDetail = `kind=${imported.kind} creator=${JSON.stringify(c.creator)} version=${JSON.stringify(
      c.characterVersion
    )} alt=${JSON.stringify(c.alternateGreetings)} 没有备选的卡多出键=${'alternateGreetings' in p}`;
  } catch (err) {
    metaDetail = '崩了：' + ((err && err.message) || err);
  }
  result.results.push({
    name: '备选开场白 / 作者 / 版本：真导入链路读得进（去重 + 剪空白）',
    pass: metaOk,
    detail: metaOk ? '' : metaDetail
  });

  // --- 世界书导出 → 真导入：**开场白和书里的 NPC 也不能丢** ---------------
  // 见 probeWorldbookExportRoundTrip()：那条用的是页面里真实的 worldbookPayload()，
  // 而 worldbookPayload 住在渲染层（ESM），宿主侧 require 不到 —— 所以放在那儿，
  // 不在这儿再糊一份假的导出函数（那样只会测到测试自己）。

  // --- 预设导出 ---
  // 单条导出写的是**对象本身**，全部导出才是 { presets: [...] } ——
  // 这两种形状自己的导入都认，所以「导出去的文件能原样导回来」是真成立的。
  // 另外要认准「不带 id」：带了 id，导回来的那条会在库里跟原来那条打架。
  const oneExport = exportedPayloads.find((p) => {
    if (!p.text || String(p.fileName || '') !== '带条目的预设.json') return false;
    try {
      const parsed = JSON.parse(p.text);
      return !!parsed && !Array.isArray(parsed) && !parsed.presets && typeof parsed.name === 'string';
    } catch (err) {
      return false;
    }
  });
  const allExport = exportedPayloads.find((p) => {
    if (!p.text || String(p.fileName || '') !== 'presets.json') return false;
    try {
      const parsed = JSON.parse(p.text);
      return !!parsed && Array.isArray(parsed.presets);
    } catch (err) {
      return false;
    }
  });

  let oneOk = false;
  let oneDetail = '没有单条预设的导出记录';
  if (oneExport) {
    try {
      const p = JSON.parse(oneExport.text);
      oneOk =
        p.name === '带条目的预设' &&
        typeof p.content === 'string' &&
        p.content.length > 0 &&
        Array.isArray(p.entries) &&
        p.entries.length > 0 &&
        !('id' in p) &&
        !('createdAt' in p) &&
        !('updatedAt' in p);
      oneDetail = `name=${p.name} entries=${(p.entries || []).length} 字段=${Object.keys(p).join(',')}`;
    } catch (err) {
      oneDetail = 'JSON 解析失败：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：单条预设写的是对象本身，且不带运行期字段',
    pass: oneOk,
    detail: oneOk ? '' : oneDetail
  });

  let allOk = false;
  let allDetail = '没有「导出全部」的记录';
  if (allExport) {
    try {
      const { presets } = JSON.parse(allExport.text);
      const one = presets.find((p) => p.name === '带条目的预设');
      allOk =
        presets.length >= 2 &&
        !!one &&
        presets.every((p) => p && typeof p.name === 'string' && !('id' in p)) &&
        String(allExport.fileName).endsWith('.json');
      allDetail = `条数=${presets.length} 名单=${presets.map((p) => p.name).join(' / ')}`;
    } catch (err) {
      allDetail = 'JSON 解析失败：' + ((err && err.message) || err);
    }
  }
  result.results.push({
    name: '导出：全部预设写的是 { presets: [...] }，每条都不带 id',
    pass: allOk,
    detail: allOk ? '' : allDetail
  });
}

/**
 * 导入链路的端到端验证 —— 用真 PNG 字节喂**真实的** importFiles。
 *
 * 要跑通的是整条链：文件字节 → 形状识别 → 归一化 → 落库 → **自动绑到角色上**。
 * 最后那步最关键也最隐蔽：绑定断了不会有任何报错，表现只是「书在库里，
 * 但聊起来就是不生效」。以前 characters:import 在测试里是个桩，
 * 这条链路在自动化里完全是空的。
 */
function probeImport(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  // 一张 1x1 的真 PNG，拿来当角色卡的底图
  const basePng = (() => {
    try {
      const exported = exportedPayloads.find((p) => String(p.fileName || '').endsWith('.png') && p.base64);
      if (exported) return Buffer.from(String(exported.base64), 'base64');
    } catch (err) {
      /* 落到下面的手工 PNG */
    }
    return Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    );
  })();

  const entries = {
    0: {
      uid: 0,
      comment: '导入测试条目',
      key: ['导入关键词'],
      keysecondary: [],
      content: '这条设定是从角色卡里带出来的。',
      constant: false,
      selective: false,
      selectiveLogic: 'AND_ANY',
      order: 100,
      probability: 100,
      disable: false,
      excludeRecursion: true,
      matchWholeWords: false,
      caseSensitive: false
    }
  };

  const cardJson = JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '导入测试角色',
      description: '一个用来验导入链路的角色',
      personality: '安静',
      scenario: '测试场景',
      first_mes: '你好。',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: [],
      character_book: { name: '卡里自带的世界书', entries },
      extensions: { mimitale: { attributes: [] } }
    }
  });

  const pngCard = pngWithTextChunk(basePng, 'chara', Buffer.from(cardJson, 'utf8').toString('base64'));
  const lorebookJson = JSON.stringify({ name: '独立世界书', entries });

  const fakeFs = (files) => ({
    readFile: (p) => {
      if (p in files) return files[p];
      throw new Error('ENOENT');
    },
    basename: (p) => String(p).split(/[\\/]/).pop(),
    extname: (p) => {
      const base = String(p).split(/[\\/]/).pop();
      const i = base.lastIndexOf('.');
      return i > 0 ? base.slice(i) : '';
    }
  });

  const idGen = (() => {
    let n = 0;
    return () => `w-import-${(n += 1)}`;
  })();

  // ⚠️ 注入项要和 main/ipc.js 里那条真链路**逐项对齐**。少一项，测试就绿着，
  // 而真机上那条路是断的 —— 下面「书里自带的 NPC」就是这么漏掉的：
  // 以前这里没传 normalizeCharacters，于是书里那份 characters 被静默丢掉，
  // 测试却一直全绿。加新的注入项时，两边一起加。
  const run = (files, paths) =>
    importFiles({
      paths,
      parseImportFile,
      makeWorldbookId: idGen,
      normalizeCharacters: (raw) => normalizeCharacter(raw, 'json'),
      ...fakeFs(files)
    });

  let out = null;
  try {
    out = run(
      {
        'D:\\tmp\\导入测试角色.png': pngCard,
        'D:\\tmp\\独立世界书.json': Buffer.from(lorebookJson, 'utf8'),
        'D:\\tmp\\随便一个文件.txt': Buffer.from('这不是卡也不是书', 'utf8')
      },
      ['D:\\tmp\\导入测试角色.png', 'D:\\tmp\\独立世界书.json', 'D:\\tmp\\随便一个文件.txt']
    );
  } catch (err) {
    push('导入：链路不崩', false, (err && err.stack) || String(err));
  }

  if (out) {
    // 这一批里还会多出一张「世界书包出来的卡」，所以按名字找，别拿 [0]
    const char = (out.characters || []).find((c) => c.name === '导入测试角色');
    const book = (out.worldbooks || []).find((b) => b.name === '卡里自带的世界书');
    const standalone = (out.worldbooks || []).find((b) => b.name === '独立世界书');

    push('导入：PNG 卡读出来了', !!char && char.name === '导入测试角色',
      char ? `roles=${out.characters.length} name=${char.name}` : JSON.stringify(out.errors));
    push('导入：卡里内嵌的世界书被存下来了（以前整本丢掉）', !!book,
      book ? `「${book.name}」${(book.entries || []).length} 条` : JSON.stringify((out.worldbooks || []).map((b) => b.name)));
    push('导入：内嵌世界书的条目内容对得上',
      !!book && (book.entries || []).length === 1 && book.entries[0].content === '这条设定是从角色卡里带出来的。' &&
        book.entries[0].keys[0] === '导入关键词',
      book ? JSON.stringify(book.entries && book.entries[0]) : '没有这本书');
    push('导入：内嵌世界书自动绑到了这张卡上',
      !!char && !!book && Array.isArray(char.worldbookIds) && char.worldbookIds.length === 1 &&
        char.worldbookIds[0] === book.id,
      char ? `worldbookIds=${JSON.stringify(char.worldbookIds)} bookId=${book && book.id}` : '没有角色');
    push('导入：不再写 worldbookEnabled（开关已撤）', !char || !('worldbookEnabled' in char),
      char ? Object.keys(char).join(',') : '没有角色');
    push('导入：temp 字段 worldbook 没有留在角色上', !!char && !('worldbook' in char),
      char ? Object.keys(char).join(',') : '没有角色');

    const promotedCard = (out.characters || []).find((c) => c.name === '独立世界书');
    push('导入：单独的 lorebook 会被包成一张同名角色卡（书没有卡就没人能打开它）',
      !!promotedCard && !!standalone && (promotedCard.worldbookIds || [])[0] === standalone.id,
      `cards=${JSON.stringify((out.characters || []).map((c) => c.name))} worldbookIds=${JSON.stringify(promotedCard && promotedCard.worldbookIds)}`);
    push('导入：包出来的卡记在被包名单里（界面要单独说一句）',
      (out.promoted || []).includes('独立世界书'),
      JSON.stringify(out.promoted));
    push('导入：World Info 的字段映射没丢（key → keys）',
      !!standalone && (standalone.entries || []).length === 1 && standalone.entries[0].keys[0] === '导入关键词',
      standalone ? JSON.stringify(standalone.entries && standalone.entries[0]) : '没有这本书');

    push('导入：认不出来的文件只记一条错误、不影响别的文件',
      (out.errors || []).length === 1 && String(out.errors[0]).includes('随便一个文件.txt'),
      JSON.stringify(out.errors));
    push('导入：PNG 卡一个 + 世界书包出来的一个 = 2', (out.characters || []).length === 2,
      `roles=${(out.characters || []).length}`);
  }

  // --- 世界书自带的 NPC（`characters`）不能丢 -------------------------------
  // 这是「分享一份世界书」最常带的东西（例子：樱川大学 v4.0 里那 5 个 NPC）。
  // 真实链路上如果 ipc.js 忘了注入 normalizeCharacters，这些副本会被**静默丢掉**：
  // 书导进来了、条目一条不少，进世界却发现一个 NPC 都不在场，全程不报错。
  const castBook = {
    name: '带 NPC 的世界书',
    description: '验证书里的角色副本能不能跟着进来',
    entries: {
      0: { uid: 0, comment: '规则', key: [], content: '玩家不是世界中心。', constant: true, order: 5 }
    },
    characters: [
      { id: 'npc-1', name: '顾言', description: '大三，学生会成员', personality: '温和可靠' },
      { id: 'npc-2', name: '林夏', description: '新闻学院', personality: '外向活泼', age: '20', gender: '女' }
    ]
  };

  const castOut = run(
    { 'D:\\tmp\\带NPC的世界书.json': Buffer.from(JSON.stringify(castBook), 'utf8') },
    ['D:\\tmp\\带NPC的世界书.json']
  );
  const castImported = (castOut.worldbooks || [])[0];

  push('导入：世界书里自带的 NPC 收进来了（以前整份 characters 静默丢掉）',
    !!castImported && (castImported.characters || []).length === 2,
    castImported ? `characters=${(castImported.characters || []).length}` : JSON.stringify(castOut.errors));
  push('导入：书里 NPC 的设定做了归一化（名字 / 性格都在）',
    !!castImported && castImported.characters[0] &&
      castImported.characters[0].name === '顾言' &&
      castImported.characters[0].personality === '温和可靠' &&
      typeof castImported.characters[0].id === 'string' && !!castImported.characters[0].id,
    castImported && castImported.characters[0] ? JSON.stringify(castImported.characters[0]) : '没有书');
  push('导入：书里的 NPC 不会被当成新角色卡（只包出书本身那一张）',
    (castOut.characters || []).length === 1 &&
      (castOut.characters || [])[0].name === '带 NPC 的世界书',
    `roles=${JSON.stringify((castOut.characters || []).map((c) => c.name))}`);
  push('导入：书里没有 characters 时也不会凭空造副本',
    (out.worldbooks || []).length > 0 && (out.worldbooks || []).every((b) => Array.isArray(b.characters)),
    `books=${(out.worldbooks || []).map((b) => `${b.name}:${(b.characters || []).length}`).join(' ')}`);

  // 取消 / 一个文件都没有时，不能凭空造出东西来
  let emptyOk = false;
  let emptyDetail = '';
  try {
    const none = run({}, []);
    emptyOk = (none.characters || []).length === 0 && (none.worldbooks || []).length === 0;
    emptyDetail = JSON.stringify(none);
  } catch (err) {
    emptyDetail = '崩了：' + ((err && err.message) || err);
  }
  push('导入：没选文件时什么都不发生', emptyOk, emptyDetail);

  // --- v3 变体：开场白在 chat_history 里，不在 first_mes ---
  // 这一段是**真卡踩出来的**：某个站点导出的 v3 卡没有 first_mes，
  // 开场白被放进了 chat_history[0].messages。以前只读 first_mes，
  // 结果导入后开场白是**空的**（连带第一条消息里那段状态栏一起丢）。
  // 标准 v3 规范里并没有 chat_history，所以两种形态都得认。
  const v3Card = (extra) =>
    JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: Object.assign(
        {
          name: 'v3 变体角色',
          description: '描述',
          extensions: {},
          character_book: { entries: [], extensions: {} },
          chat_history: [
            {
              id: 's1',
              name: '开场对话',
              messages: [
                { role: 'assistant', content: '这是 v3 开场白。\n\n---\n好感度：0/100' }
              ]
            },
            {
              id: 's2',
              name: '示例对话',
              messages: [{ role: 'assistant', content: '这段是示例对话，不该被当成开场白。' }]
            }
          ]
        },
        extra || {}
      )
    });

  const v3Only = run({ 'D:\\tmp\\v3.json': Buffer.from(v3Card(), 'utf8') }, ['D:\\tmp\\v3.json']);
  const v3char = (v3Only.characters || [])[0];
  push(
    '导入：v3 变体的开场白从 chat_history 里读出来了（以前是空的）',
    !!v3char && String(v3char.firstMes || '').includes('这是 v3 开场白'),
    v3char ? JSON.stringify(String(v3char.firstMes || '').slice(0, 60)) : JSON.stringify(v3Only.errors)
  );
  push(
    '导入：v3 开场白里的状态栏一起带过来了',
    !!v3char && String(v3char.firstMes || '').includes('好感度：0/100'),
    v3char ? JSON.stringify(String(v3char.firstMes || '').slice(-40)) : '没有角色'
  );
  push(
    '导入：只取第一个 session，第二个（示例对话）不混进来',
    !!v3char && !String(v3char.firstMes || '').includes('这段是示例对话'),    v3char ? JSON.stringify(String(v3char.firstMes || '')) : '没有角色'
  );

  // first_mes 才是权威的：两个都有时必须用它
  const v3Both = run(
    { 'D:\\tmp\\v3b.json': Buffer.from(v3Card({ first_mes: '标准 first_mes 优先' }), 'utf8') },
    ['D:\\tmp\\v3b.json']
  );
  push(
    '导入：first_mes 和 chat_history 都在时，用 first_mes',
    !!v3Both.characters[0] && String(v3Both.characters[0].firstMes).includes('标准 first_mes 优先'),
    JSON.stringify(String((v3Both.characters[0] || {}).firstMes || '').slice(0, 40))
  );

  // 第一条是媒体条目（多模态卡）时要跳过，别把图片当文本
  const v3Media = run(
    {
      'D:\\tmp\\v3c.json': Buffer.from(
        JSON.stringify({
          spec: 'chara_card_v3',
          data: {
            name: '多模态卡',
            description: 'd',
            chat_history: [
              {
                id: 's1',
                messages: [
                  { type: 'image', content: 'https://example.com/a.png' },
                  { role: 'user', content: '用户先说了一句' },
                  { role: 'assistant', content: '真正的开场白在第二条 assistant。' }
                ]
              }
            ]
          }
        }),
        'utf8'
      )
    },
    ['D:\\tmp\\v3c.json']
  );
  push(
    '导入：chat_history 里的媒体条目被跳过，取第一条 assistant 文本',
    !!v3Media.characters[0] && String(v3Media.characters[0].firstMes).includes('真正的开场白在第二条'),
    JSON.stringify(String((v3Media.characters[0] || {}).firstMes || ''))
  );

  // 只有 user 消息时不能瞎编开场白
  const v3NoAssistant = run(
    {
      'D:\\tmp\\v3d.json': Buffer.from(
        JSON.stringify({
          spec: 'chara_card_v3',
          data: {
            name: '没有开场白的卡',
            description: 'd',
            chat_history: [{ id: 's1', messages: [{ role: 'user', content: '只有用户消息' }] }]
          }
        }),
        'utf8'
      )
    },
    ['D:\\tmp\\v3d.json']
  );
  push(
    '导入：chat_history 里没有 assistant 消息时，开场白留空而不是瞎编',
    !!v3NoAssistant.characters[0] && v3NoAssistant.characters[0].firstMes === '',
    JSON.stringify(String((v3NoAssistant.characters[0] || {}).firstMes || ''))
  );

  // chat_history 是脏数据（不是数组 / 里面是空对象）时不能崩
  let v3DirtyOk = true;
  let v3DirtyDetail = '';
  try {
    const dirtyCard = (chat) =>
      JSON.stringify({ spec: 'chara_card_v3', data: { name: '脏卡', description: 'd', chat_history: chat } });
    const cases = [
      run({ 'D:\\tmp\\d1.json': Buffer.from(dirtyCard('不是数组'), 'utf8') }, ['D:\\tmp\\d1.json']),
      run({ 'D:\\tmp\\d2.json': Buffer.from(dirtyCard([]), 'utf8') }, ['D:\\tmp\\d2.json']),
      run({ 'D:\\tmp\\d3.json': Buffer.from(dirtyCard([null, {}, { messages: '不是数组' }]), 'utf8') }, [
        'D:\\tmp\\d3.json'
      ])
    ];
    v3DirtyOk = cases.every((o) => o.characters.length === 1 && o.characters[0].firstMes === '');
    v3DirtyDetail = JSON.stringify(cases.map((o) => (o.characters[0] || {}).firstMes));
  } catch (err) {
    v3DirtyOk = false;
    v3DirtyDetail = '崩了：' + ((err && err.message) || err);
  }
  push('导入：chat_history 是脏数据时不崩，开场白留空', v3DirtyOk, v3DirtyDetail);

  // --- v3 变体回归样本（没有 first_mes） ---
  // 上面那些是自造卡，这条用的是**仓库里的完整样本字节**，
  // 形状照着真实导出文件构造（含 chat_history、extensions.status_template），
  // 文本内容是中性占位 —— 仓库里不夹带任何剧情文本。
  // 夹具就放在 tools/fixtures/ 下，改坏了会直接红。
  let realOk = false;
  let realDetail = '';
  try {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'v3-card-chat-history.json'));
    const real = run({ 'D:\\tmp\\real.json': fixture }, ['D:\\tmp\\real.json']);
    const rc = (real.characters || [])[0];
    realOk =
      !!rc &&
      rc.name === '图书馆的义工' &&
      String(rc.firstMes || '').includes('图书馆的义工') &&
      String(rc.firstMes || '').includes('好感度：0/100') &&
      String(rc.description || '').includes('数值系统');
    realDetail = rc
      ? `name=${rc.name} firstMes=${(rc.firstMes || '').length}字 含状态栏=${String(rc.firstMes || '').includes('好感度：0/100')}`
      : JSON.stringify(real.errors);
  } catch (err) {
    realDetail = '读夹具失败：' + ((err && err.message) || err);
  }
  push('导入：真 v3 变体卡（仓库里的回归样本）开场白能读出来', realOk, realDetail);

  // 同一张样本卡还要验「互动模板 → 角色属性」的映射。
  // 卡里 extensions.status_template 有 7 个字段（含一个带范围的 meter），
  // 以前整个被忽略，导入后属性是空的。
  let tplOk = false;
  let tplDetail = '';
  try {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'v3-card-chat-history.json'));
    const real = run({ 'D:\\tmp\\real.json': fixture }, ['D:\\tmp\\real.json']);
    const rc = (real.characters || [])[0];
    const attrs = (rc && rc.attributes) || [];
    const favor = attrs.find((a) => a.name === '好感度');
    const stage = attrs.find((a) => a.name === '关系阶段');
    const bag = attrs.find((a) => a.name === '背包');
    // 卡里的 template id 要翻译成分组标题（status_bar → 状态栏）
    const groupOf = (n) => (attrs.find((a) => a.name === n) || {}).group;
    const groups = [...new Set(attrs.map((a) => a.group).filter(Boolean))].sort();
    tplOk =
      attrs.length === 7 &&
      !!favor &&
      favor.type === 'meter' &&
      favor.min === 0 &&
      favor.max === 100 &&
      favor.value === '20' &&
      String(favor.hint || '').includes('单轮变化不超过 10') &&
      // 派生规则那种纯文本 hint 也要留下来（模型要靠它算关系阶段）
      !!stage &&
      String(stage.hint || '').includes('按好感度自动') &&
      // 列表型字段的初始值是个数组，要拍平成字符串
      !!bag &&
      bag.type === 'list' &&
      bag.value === '衣服' &&
      // 分组：官方模板翻译成中文标题，自定义面板用卡里 panels 的 title
      groupOf('时间') === '状态栏' &&
      groupOf('好感度') === '关系' &&
      groupOf('关系阶段') === '关系' &&
      groupOf('背包') === '背包' &&
      groupOf('自定义面板') === '自定义面板' &&
      groups.join(',') === '关系,背包,状态栏,自定义面板'.split(',').sort().join(',');
    tplDetail =
      `属性 ${attrs.length} 个：${JSON.stringify(attrs.map((a) => `${a.name}/${a.type}/${a.group || '无组'}`))}` +
      (favor ? ` 好感度=${JSON.stringify(favor)}` : ' 没有好感度');
  } catch (err) {
    tplDetail = '读夹具失败：' + ((err && err.message) || err);
  }
  push('导入：真卡的「互动模板」被映射成角色属性（类型/范围/规则/初始值）', tplOk, tplDetail);

  // 读文件失败得是「一条错误」，而不是整批炸掉
  let failOk = false;
  let failDetail = '';
  try {
    const bad = run({ 'D:\\tmp\\好的.json': Buffer.from(lorebookJson, 'utf8') }, [
      'D:\\tmp\\不存在的.png',
      'D:\\tmp\\好的.json'
    ]);
    failOk = (bad.errors || []).length === 1 && (bad.worldbooks || []).length === 1;
    failDetail = JSON.stringify(bad.errors);
  } catch (err) {
    failDetail = '崩了：' + ((err && err.message) || err);
  }
  push('导入：某个文件读不到时，其余文件照样导入', failOk, failDetail);
}

/**
 * 面板字段的「类型 / 范围 / 变化规则」。
 *
 * 三件事要验：
 *   1. 归一化：类型认不出来要退回 text（而不是丢字段），范围写反要换正；
 *   2. 夹取：模型写 150/100、-5/100 要被拉回范围内，但**保留原来的写法**；
 *   3. 描述：范围和变化规则要能拼成给模型看的一句话。
 * 这些都是纯函数，跑的是主进程和渲染层共用的那一份 main/panel-fields.js。
 */
function probePanelFields(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  // --- 归一化 ---
  const norm = (raw) => normalizePanelField(raw);

  const textField = norm({ name: ' 心情 ', value: '平静' });
  push('面板字段：名字去空白、缺省类型是文本', !!textField && textField.name === '心情' && textField.type === 'text',
    JSON.stringify(textField));
  push('面板字段：文本字段不带范围键', !!textField && !('min' in textField) && !('max' in textField),
    JSON.stringify(textField));

  const meter = norm({ name: '好感度', type: 'meter', min: 0, max: 100, value: 20, hint: '每轮最多加 10' });
  push('面板字段：数值字段的范围/hint 都留下了',
    !!meter && meter.type === 'meter' && meter.min === 0 && meter.max === 100 && meter.hint === '每轮最多加 10',
    JSON.stringify(meter));
  push('面板字段：初始值被转成字符串（面板值只能是字符串）', !!meter && meter.value === '20', JSON.stringify(meter && meter.value));

  const reversed = norm({ name: '血', type: 'meter', min: 100, max: 0 });
  push('面板字段：范围写反了会被换正', !!reversed && reversed.min === 0 && reversed.max === 100, JSON.stringify(reversed));

  const badType = norm({ name: '怪', type: '进度条', value: 'x' });
  push('面板字段：类型认不出来退回文本，而不是丢掉字段', !!badType && badType.type === 'text', JSON.stringify(badType));

  push('面板字段：没有名字的直接丢掉', norm({ value: 'x' }) === null);
  push('面板字段：脏输入返回 null 而不是崩', norm(null) === null && norm('字符串') === null && norm([]) === null);

  const noName = normalizePanelFields([{ name: 'A', value: '1' }, { value: '2' }, null, { name: 'A', value: '3' }]);
  push('面板字段：整表归一化会丢掉无名项和重名项', noName.length === 1 && noName[0].value === '1',
    JSON.stringify(noName));

  // --- 夹取 ---
  const range = { type: 'meter', min: 0, max: 100 };
  const clamp = (v) => clampFieldValue(v, range);

  push('面板夹取：150/100 → 100/100（保留斜杠写法）', clamp('150/100').value === '100/100', JSON.stringify(clamp('150/100')));
  push('面板夹取：-5/100 → 0/100', clamp('-5/100').value === '0/100', JSON.stringify(clamp('-5/100')));
  push('面板夹取：范围内的原样不动', clamp('50/100').value === '50/100' && clamp('50/100').clamped === false,
    JSON.stringify(clamp('50/100')));
  push('面板夹取：纯数字也认', clamp('150').value === '100', JSON.stringify(clamp('150')));
  push('面板夹取：小数保留（不粗暴取整）', clamp('100.7/100').value === '100/100' && clamp('99.5/100').value === '99.5/100',
    `${JSON.stringify(clamp('100.7/100'))} ${JSON.stringify(clamp('99.5/100'))}`);
  push('面板夹取：不是数字就原样放行（不能把中文值抹掉）', clamp('很累').value === '很累' && clamp('很累').clamped === false,
    JSON.stringify(clamp('很累')));
  push('面板夹取：空值不报错', clamp('').value === '' && clamp(null).value === '');

  const lower = { type: 'meter', min: 10, max: 100 };
  push('面板夹取：只有下限时也夹', clampFieldValue('3', lower).value === '10', JSON.stringify(clampFieldValue('3', lower)));
  push('面板夹取：没有范围的数值字段不夹', clampFieldValue('999', { type: 'meter' }).value === '999',
    JSON.stringify(clampFieldValue('999', { type: 'meter' })));
  push('面板夹取：文本字段不夹（就算值是数字）', clampFieldValue('999', { type: 'text', min: 0, max: 100 }).value === '999');
  push('面板夹取：没有定义就原样返回', clampFieldValue('999', null).value === '999');

  // 分母不动：它是这个字段的满值，改了会更怪
  push('面板夹取：分母原样保留', clampFieldValue('150/999', range).value === '100/999',
    JSON.stringify(clampFieldValue('150/999', range)));

  // --- 描述（注入给模型的那句话）---
  const desc = describePanelField(meter);
  push('面板描述：范围和变化规则都在里面', desc.includes('0~100') && desc.includes('每轮最多加 10'), desc);
  push('面板描述：列表字段说明怎么分隔', describePanelField({ type: 'list' }).includes('、'),
    describePanelField({ type: 'list' }));
  push('面板描述：纯文本字段没有多余说明', describePanelField({ type: 'text' }) === '',
    describePanelField({ type: 'text' }));

  // --- 分组（命名面板）---
  const grouped = normalizePanelFields([
    { name: '时间', group: '状态栏' },
    { name: '好感度', group: '关系', type: 'meter', min: 0, max: 100 },
    { name: '零散' },
    { name: '背包', group: '背包' }
  ]);
  push('面板分组：group 被留下来', !!grouped[0].group && grouped[0].group === '状态栏', JSON.stringify(grouped[0]));
  push('面板分组：没写 group 的字段就是没分组', !('group' in grouped[2]), JSON.stringify(grouped[2]));
  push('面板分组：纯空白的分组名当没有', !('group' in normalizePanelField({ name: 'x', group: '   ' })));

  const buckets = groupPanelFields(grouped);
  push(
    '面板分组：按第一次出现的顺序分组、顺序保留',
    buckets.map((b) => b.id).join(',') === '状态栏,关系,背包,',
    JSON.stringify(buckets.map((b) => b.id))
  );
  push(
    '面板分组：没分组的排最后',
    buckets[buckets.length - 1].id === '' && buckets[buckets.length - 1].fields.length === 1,
    JSON.stringify(buckets.map((b) => ({ id: b.id, n: b.fields.length })))
  );
  push(
    '面板分组：每个桶里的字段对得上',
    buckets[0].fields[0].name === '时间' && buckets[1].fields[0].name === '好感度' && buckets[2].fields[0].name === '背包',
    JSON.stringify(buckets.map((b) => b.fields.map((f) => f.name)))
  );
  push('面板分组：全都没分组时只有一个空桶', groupPanelFields([{ name: 'a' }, { name: 'b' }]).length === 1);
  push('面板分组：脏输入不崩', groupPanelFields(null).length === 0 && groupPanelFields([null, undefined]).length === 0);

  // --- 数值字段的进度（他那边的「带范围的进度条」）---
  const meterDef = { type: 'meter', min: 0, max: 100 };
  push('进度：60/100 → 60%', JSON.stringify(fieldProgress('60/100', meterDef)) === JSON.stringify({ n: 60, total: 100, percent: 60 }),
    JSON.stringify(fieldProgress('60/100', meterDef)));
  push('进度：裸数字也能算（用 max 当满值）', (fieldProgress('20', meterDef) || {}).percent === 20,
    JSON.stringify(fieldProgress('20', meterDef)));
  push('进度：越界会被夹在 0~100', (fieldProgress('150/100', meterDef) || {}).percent === 100 &&
    (fieldProgress('-5/100', meterDef) || {}).percent === 0,
    `${JSON.stringify(fieldProgress('150/100', meterDef))} ${JSON.stringify(fieldProgress('-5/100', meterDef))}`);
  push('进度：有下限时按区间算（20~80 里的 50 → 50%）',
    (fieldProgress('50/80', { type: 'meter', min: 20, max: 80 }) || {}).percent === 50,
    JSON.stringify(fieldProgress('50/80', { type: 'meter', min: 20, max: 80 })));
  push('进度：文本字段没有进度', fieldProgress('60', { type: 'text' }) === null);
  push('进度：算不出数字就没有进度（不瞎画）', fieldProgress('很累', meterDef) === null && fieldProgress('', meterDef) === null);
  push('进度：没有范围也没有分母时不给进度', fieldProgress('60', { type: 'meter' }) === null);
  push('进度：范围是个点（max==min）不除零', (fieldProgress('5/5', { type: 'meter', min: 5, max: 5 }) || {}).percent === 0);
}

/**
 * 世界书存盘归一化的白名单验证。normalizeWorldbook 是白名单式的：没列的字段
 * 直接消失。这里用真的落盘归一化跑一遍往返。
 */
function probeWorldbookStore(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  const normalize = createWorldbookNormalizer({
    makeId: () => 'w-fixed',
    normalizeCharacter: (item) => normalizeCharacter(item, 'manual')
  });

  const original = {
    id: 'w-keep',
    name: '字段保全测试书',
    opening: '进来就会看到的第一句话',
    entries: [      {
        id: 'e-keep',
        title: '会递归的条目',
        keys: ['关键词'],
        content: '正文',
        recursive: true,
        constant: false,
        enabled: true,
        matchWholeWords: false,
        caseSensitive: false,
        priority: 100
      },
      {
        id: 'e-off',
        title: '被停用的条目',
        keys: ['停用'],
        content: '不该生效',
        recursive: false,
        // 老写法 disable:true = 停用
        disable: true
      }
    ],
    characters: [{ id: 'wc-1', name: '书里的角色副本', description: '副本设定', attributes: [{ name: '体力', value: '10' }] }]
  };

  let back = null;
  try {
    back = normalize(original);
  } catch (err) {
    push('世界书落盘：归一化不崩', false, (err && err.stack) || String(err));
    return;
  }

  const e0 = (back.entries || [])[0] || {};
  const e1 = (back.entries || [])[1] || {};

  push('世界书落盘：书本身的 id / name 保留', back.id === 'w-keep' && back.name === '字段保全测试书',
    `id=${back.id} name=${back.name}`);
  push('世界书落盘：opening 已经撤掉（白名单不再收）', !('opening' in back), JSON.stringify(back.opening));
  push('世界书落盘：条目数对', (back.entries || []).length === 2, `entries=${(back.entries || []).length}`);
  push('世界书落盘：recursive 没被重置成 false（白名单漏过）', e0.recursive === true, `recursive=${e0.recursive}`);
  push('世界书落盘：disable:true 读成 enabled:false', e1.enabled === false, `enabled=${e1.enabled}`);
  push('世界书落盘：书里的角色副本没被丢掉', (back.characters || []).length === 1 && back.characters[0].name === '书里的角色副本',
    JSON.stringify((back.characters || []).map((c) => c.name)));
  push('世界书落盘：副本的 attributes 也回来了',
    !!back.characters[0] && Array.isArray(back.characters[0].attributes) && back.characters[0].attributes.length === 1,
    JSON.stringify(back.characters[0] && back.characters[0].attributes));

  // 子进程真的读回来过（渲染层存过盘）
  const loaded = store.worldbooks.find((w) => w.id === 'w-test');
  push('世界书落盘：内存里那本种子的 recursive 还在（真存过盘）',
    !!loaded && (loaded.entries || []).some((e) => e.recursive === true),
    loaded ? `recursive=${JSON.stringify((loaded.entries || []).map((e) => e.recursive))}` : '内存里找不到种子书');
}

/**
 * 递归扫描的引擎级验证。直接打 main/worldbook-match.js —— 比隔着界面点
 * 「预览命中」更精确，能把深度 0/1/3 和「哪条允许往下带」分开验。
 */
function probeRecursion(result) {
  const entry = (id, title, keys, content, recursive) => ({
    id,
    title,
    keys,
    secondaryKeys: [],
    selectiveLogic: 'AND_ANY',
    content,
    constant: false,
    recursive,
    probability: 100,
    order: 100,
    enabled: true
  });

  // 严格链：总览 → 十二泰坦 → 火种。每一条的正文只提下一层的关键词，
  // 所以深度几层就该带出几条 —— 如果总览正文里同时写了「火种」，
  // 那就成了扇出（深度 1 就全出来），验不出「逐层接力」。
  const entries = [
    entry('a', '世界总览', ['翁法罗斯'], '翁法罗斯有十二泰坦。', true),
    entry('b', '十二泰坦', ['十二泰坦'], '十二泰坦守着火种。', true),
    entry('c', '火种', ['火种'], '火种是泰坦留下的力量。', false),
    entry('d', '无关条目', ['没人提的词'], '不该出现。', true)
  ];

  const run = (depth) => matchWorldbookEntries(entries, '翁法罗斯是个什么样的地方？', { recursiveDepth: depth });

  const zero = run(0);
  const one = run(1);
  const three = run(3);

  const titles = (r) => r.hits.map((h) => h.title).join('、');
  const ok =
    zero.hits.length === 1 &&
    zero.recursiveCount === 0 &&
    one.hits.length === 2 &&
    one.recursiveCount === 1 &&
    three.hits.length === 3 &&
    three.recursiveCount === 2 &&
    !titles(three).includes('无关条目') &&
    three.rounds === 3;
  result.results.push({
    name: '递归扫描：深度 0 只给直接命中的那一条',
    pass: zero.hits.length === 1 && zero.recursiveCount === 0,
    detail: `${titles(zero)}（${zero.hits.length} 条）`
  });
  result.results.push({
    name: '递归扫描：深度 1 带出第一层',
    pass: one.hits.length === 2 && one.recursiveCount === 1,
    detail: `${titles(one)}（${one.hits.length} 条）`
  });
  result.results.push({
    name: '递归扫描：逐层接力直到没得带（深度 3 → 3 条 3 轮）',
    pass: ok,
    detail: `${titles(three)}（${three.hits.length} 条 / ${three.rounds} 轮 / 递归 ${three.recursiveCount}）`
  });
  result.results.push({
    name: '递归扫描：命中过的条目不会被重复带进来',
    pass: new Set(three.hits.map((h) => h.id)).size === three.hits.length,
    detail: titles(three)
  });

  // 递归关闭的条目：它的正文不该参与下一轮
  const gated = matchWorldbookEntries(
    [entry('a', '总览', ['翁法罗斯'], '里面写了十二泰坦。', false), entry('b', '十二泰坦', ['十二泰坦'], '细节。', false)],
    '翁法罗斯',
    { recursiveDepth: 3 }
  );
  result.results.push({
    name: '递归扫描：没勾「递归」的条目不会往下带',
    pass: gated.hits.length === 1,
    detail: titles(gated)
  });
}

/**
 * 生图的验证。关键一条：**它用的是「生图」那一组配置，而不是聊天模型** —— * 用错了的话界面照样出图，但你的对话模型会被当成画图模型去打 /images/generations，
 * 只会得到一个莫名其妙的报错。
 */
function probeImageGen(result) {
  const req = imageRequests[0];

  result.results.push({
    name: '生图：用的是「生图」那一组配置，不是聊天模型',
    pass: !!req && req.providerId === 'p-img' && req.model === 'img-model-x',
    detail: req ? `providerId=${req.providerId} model=${req.model}` : '没收到生图请求'
  });

  result.results.push({
    name: '生图：提示词取自那条回复的正文',
    pass: !!req && String(req.prompt).includes('冒烟测试回复'),
    detail: req ? `"${String(req.prompt).slice(0, 36)}…"` : ''
  });

  result.results.push({
    name: '生图：请求里带上了尺寸',
    pass: !!req && req.size === '1024x1024',
    detail: req ? String(req.size) : ''
  });
}

/**
 * 向量工具的单测。直接打 main/vectors.js —— 相似度算错了，整套语义检索就是
 * 「随机捞几条塞进上下文」，而且界面上完全看不出来。
 */
function probeVectors(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  // 编解码往返
  const original = new Float32Array([0.125, -0.5, 0.75, 1e-3]);
  const back = decodeVector(encodeVector(original));
  push(
    '向量：编码再解码能原样回来',
    back && back.length === original.length && original.every((v, i) => Math.abs(back[i] - v) < 1e-7),
    back ? `[${Array.from(back).join(', ')}]` : '解码失败'
  );

  // base64 比 JSON 数字省得多
  push(
    '向量：存成 base64 比 JSON 数字省',
    encodeVector(original).length < JSON.stringify(Array.from(original)).length,
    `base64 ${encodeVector(original).length} 字节 vs JSON ${JSON.stringify(Array.from(original)).length} 字节`
  );

  push('向量：坏数据解码返回 null', decodeVector('不是base64!!') === null && decodeVector('') === null);

  // 余弦相似度：同向 1、正交 0、反向 -1
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([0, 1]);
  const c = new Float32Array([-1, 0]);
  push(
    '向量：余弦相似度对（同向 1 / 正交 0 / 反向 -1）',
    Math.abs(cosineSimilarity(a, a) - 1) < 1e-6 &&
      Math.abs(cosineSimilarity(a, b)) < 1e-6 &&
      Math.abs(cosineSimilarity(a, c) + 1) < 1e-6,
    [cosineSimilarity(a, a), cosineSimilarity(a, b), cosineSimilarity(a, c)].join(' / ')
  );

  // 没归一化的向量也要能比（各家服务商不一样）
  const un = new Float32Array([10, 0]);
  push('向量：没归一化也算得对', Math.abs(cosineSimilarity(a, un) - 1) < 1e-6, String(cosineSimilarity(a, un)));
  push('向量：维度不一样返回 0（不瞎算）', cosineSimilarity(new Float32Array([1, 2, 3]), a) === 0);

  // 排序：topK / 阈值 / 排除
  const candidates = [
    { key: 'high', vector: new Float32Array([1, 0, 0.1]) },
    { key: 'mid', vector: new Float32Array([0.7, 0.7, 0.1]) },
    { key: 'low', vector: new Float32Array([0, 1, 0.1]) },
    { key: 'excluded', vector: new Float32Array([1, 0, 0.1]) }
  ];
  const ranked = rankBySimilarity(new Float32Array([1, 0, 0.1]), candidates, { topK: 2, minScore: 0.9 });
  push(
    '向量：topK 和阈值都生效',
    ranked.length === 2 && ranked[0].key === 'high' && ranked[1].key === 'excluded' && ranked[0].score >= ranked[1].score,
    ranked.map((r) => `${r.key}=${r.score.toFixed(3)}`).join(', ')
  );

  const excluded = rankBySimilarity(new Float32Array([1, 0, 0.1]), candidates, {
    topK: 5,
    minScore: 0,
    exclude: new Set(['excluded'])
  });
  push(
    '向量：exclude 里的不会被捞回来',
    excluded.length === 3 && !excluded.some((r) => r.key === 'excluded'),
    excluded.map((r) => r.key).join(', ')
  );

  push(
    '向量：全都不够像时宁可一条都不给',
    rankBySimilarity(new Float32Array([0, 0, 1]), candidates, { topK: 4, minScore: 0.9 }).length === 0,
    ''
  );

  push('向量：内容指纹随内容变', hashText('甲') !== hashText('乙') && hashText('甲') === hashText('甲'));

  // 候选收集：跳过最近几条、只捞绑定的书、空内容不要
  const collected = collectCandidates({
    messages: [
      { role: 'user', content: '很早以前说过的话' },
      { role: 'assistant', content: '很早以前的回复' },
      { role: 'user', content: '刚说的这句' },
      { role: 'user', content: '   ' },
      { role: 'error', content: '出错了' }
    ],
    recentCount: 2,
    books: [
      { id: 'b1', entries: [{ id: 'e1', title: '甲条', content: '甲的内容' }, { id: 'e2', title: '空条', content: '  ' }] },
      { id: 'b2', entries: [{ id: 'e9', title: '没绑的书', content: '不该被捞' }] }
    ],
    worldbookIds: ['b1']
  });
  const keys = collected.map((c) => c.key).join(' | ');
  push(
    '向量：候选收集跳过最近几条消息',
    !collected.some((c) => c.text === '刚说的这句') && collected.some((c) => c.text === '很早以前说过的话'),
    keys
  );
  push(
    '向量：候选收集只捞绑定了的那本书',
    collected.some((c) => c.text === '甲的内容') && !collected.some((c) => c.text === '不该被捞'),
    keys
  );
  push(
    '向量：空白内容和 error 消息都不收',
    !collected.some((c) => c.text === '出错了') && collected.every((c) => c.text.trim()),
    keys
  );
}

/**
 * 语义检索注入链路的验证（宿主侧，看真正发出去的消息）。
 * 光看界面上「有没有反应」是验不出这个功能的 —— 它本来就没有可见反应。
 */
function probeRag(result) {
  const fromSystem = (messages) =>
    (messages || []).find((m) => m.role === 'system' && String(m.content || '').includes('[可能相关的往事]'));

  const withRag = chatPayloads.map(fromSystem).filter(Boolean);
  const section = withRag.length ? String(withRag[withRag.length - 1].content) : '';

  result.results.push({
    name: 'RAG：把相关的设定捞回来注入了',
    pass: !!section && section.includes('十二泰坦'),
    detail: section ? section.replace(/\s+/g, ' ').slice(0, 70) : '所有请求里都没有 [可能相关的往事] 这一段'
  });

  result.results.push({
    name: 'RAG：不像的没被硬凑进来',
    pass: !!section && !section.includes('这条不该被带进来'),
    detail: section.includes('这条不该被带进来') ? '把不相关的条目也塞进来了' : ''
  });

  result.results.push({
    name: 'RAG：注入的是一段独立的 system 消息',
    pass: !!section && section.trim().startsWith('[可能相关的往事]'),
    detail: section ? section.trim().slice(0, 20) : '没找到这一段'
  });

  // 负向对照：关掉之后不该再出现
  const last = chatPayloads[chatPayloads.length - 1];
  result.results.push({
    name: 'RAG：关掉之后就不再注入了',
    pass: !fromSystem(last),
    detail: fromSystem(last) ? '关了还在注入' : ''
  });

  // 渲染层确实把配置传下去了
  const req = ragRequests[0];
  result.results.push({
    name: 'RAG：检索用的是「向量」那组配置',
    pass: !!req && req.providerId === 'p-emb' && req.model === 'emb-model-x',
    detail: req ? `${req.providerId}/${req.model}` : '没收到检索请求'
  });
}

/**
 * 批量导出 / 批量删除的静态体检。
 *
 * 为什么不在真窗口里点这两颗按钮：导出会弹系统「选文件夹」框（自动化点不了），
 * 删除会真删数据（冒烟跑完还要留一套干净样本）。这两条链路的要害是「接线有没有断」——
 * 主进程有没有选目录的通道、preload 有没有暴露、JSON 导出有没有把头像带上、
 * 导入读不读得回来、批量删除有没有做回滚。这些全是源码里的事实，直接读文件断言最划算。
 */
function probeBatchLibrary(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
    } catch (err) {
      return '';
    }
  };

  const ipc = read('main/ipc.js');
  const preload = read('preload.js');
  const chatExport = read('renderer/js/views/chatExport.js');
  const cardImport = read('main/card-import.js');
  const editor = read('renderer/js/views/characterEditor.js');
  const charList = read('renderer/js/views/characterList.js');
  const page = read('renderer/index.html');

  push('批量导出：主进程有「选文件夹 + 逐个写」的通道', /ipcMain\.handle\('util:saveFiles'/.test(ipc), ipc ? '' : '读不到 main/ipc.js');
  push('批量导出：preload 暴露了 saveFiles', /saveFiles:\s*\(payload\)/.test(preload));
  push('批量导出：同目录重名会自动加序号（不覆盖已有文件）', /while \(taken\.has/.test(ipc));
  push(
    '批量导出：角色卡 JSON 带头像 / 立绘（withImages → extensions.mimitale）',
    chatExport.includes('withImages') && chatExport.includes('portrait')
  );
  push('导入侧：能读回扩展位里的头像 / 立绘', cardImport.includes('ext.avatar') && cardImport.includes('ext.portrait'));
  push(
    '角色卡：批量按钮接了三件事（进入 / 导出 / 删除）',
    /btnCharBatch/.test(charList) && /exportMany/.test(charList) && /removeMany/.test(charList)
  );
  push(
    '批量删除角色：一次写盘 + 失败按原绑定回滚',
    /export async function deleteCharactersByIds/.test(editor) && /unbound\.push\(\[convo, convo\.characterId\]\)/.test(editor)
  );
  push(
    '角色卡工具条写了批量按钮组',
    /id="char-batch-active"/.test(page)
  );
}

/**
 * AI 生成的解析体检：把「模型返回的原文」直接喂给 aiGen 的解析函数，
 * 看它到底能不能解析出字段。这条链路（原文 → 剥围栏 → JSON.parse → 字段）
 * 跑在渲染层里、又是纯函数，最适合直接 import 进来单测 ——
 * 真点按钮那条路会掺进「弹窗有没有开、草稿有没有建」等一堆无关变量。
 */
async function probeAiGenParse(win, result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  try {
    const out = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import(new URL('js/views/aiGen.js', document.baseURI).href);
      if (typeof mod.parseGeneratedCharacter !== 'function') return { exported: false };

      const clean = JSON.stringify({
        name: '守夜人',
        description: '一个总在深夜值班的人。',
        personality: '话少。',
        scenario: '图书馆的深夜，只有值班灯亮着。',
        firstMes: '{{char}} 抬头看了你一眼：\\n\\n还不走？',
        mesExample: '{{user}}: 还不睡？\\n{{char}}: 还没。',
        tags: ['冒烟'],
        attributes: [{ name: '好感度', type: 'number', value: 5, mode: 'dynamic' }]
      });
      const fenced = '好的，我按你说的写了一个：\\n\\n\\\`\\\`\\\`json\\n' + clean + '\\n\\\`\\\`\\\`\\n\\n需要我再调整吗？';
      // 下划线写法（酒馆卡常见）：场景给了，开场白/示例对话用 snake_case
      const snake = JSON.stringify({
        name: '守夜人',
        description: '一个总在深夜值班的人。',
        personality: '话少。',
        scenario: '图书馆的深夜。',
        first_mes: '{{char}} 抬头。',
        mes_example: '{{user}}: 早。\\n{{char}}: 早。',
        attributes: [{ name: '好感度', type: 'number', value: 5, mode: 'dynamic' }]
      });

      const a = mod.parseGeneratedCharacter(clean);
      const b = mod.parseGeneratedCharacter(fenced);
      const c = mod.parseGeneratedCharacter(snake);
      const f = (r) => r.fields || {};
      return {
        exported: true,
        clean: {
          ok: a.ok,
          name: f(a).name,
          attrs: (f(a).attributes || []).length,
          scenario: !!f(a).scenario,
          firstMes: !!f(a).firstMes,
          mesExample: !!f(a).mesExample,
          err: a.error
        },
        fenced: { ok: b.ok, name: f(b).name, attrs: (f(b).attributes || []).length, err: b.error },
        snake: { ok: c.ok, scenario: !!f(c).scenario, firstMes: !!f(c).firstMes, mesExample: !!f(c).mesExample, err: c.error }
      };
    })()`);

    if (!out || !out.exported) {
      push('AI 生成：解析函数可以从模块里拿到', false, JSON.stringify(out));
      return;
    }
    push(
      'AI 生成：干净的 JSON 能解析出角色',
      out.clean.ok && out.clean.name === '守夜人' && out.clean.attrs === 1,
      JSON.stringify(out.clean)
    );
    push(
      'AI 生成：场景 / 开场白 / 示例对话都能解析出来',
      out.clean.scenario && out.clean.firstMes && out.clean.mesExample,
      JSON.stringify(out.clean)
    );
    push(
      'AI 生成：带围栏和废话的输出也能解析出角色',
      out.fenced.ok && out.fenced.name === '守夜人' && out.fenced.attrs === 1,
      JSON.stringify(out.fenced)
    );
    push(
      'AI 生成：下划线写法（first_mes / mes_example）也认',
      out.snake.ok && out.snake.firstMes && out.snake.mesExample,
      JSON.stringify(out.snake)
    );
  } catch (err) {
    push('AI 生成：解析体检能跑起来', false, (err && err.message) || String(err));
  }
}

/**
 * 「AI 补设定」（角色编辑器里那块）的解析体检。和 probeAiGenParse 一个道理：
 * 纯函数，直接 import 进来喂原文，不经过「点按钮 → 等假后端 → 看界面」那一堆变量。
 * 重点盯两处容易静默出错的：
 *   · 既非常驻、又没关键词的条目必须丢掉 —— 留着永远不会被注入，用户以为它生效了；
 *   · 关键词写成「逗号串」是模型最常见的偷懒写法，得拆成数组。
 */
async function probeBookEntries(win, result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  try {
    const out = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import(new URL('js/views/charBookAi.js', document.baseURI).href);
      if (typeof mod.parseBookEntries !== 'function') return { exported: false };

      const clean = JSON.stringify({
        entries: [
          { title: '夜班规矩', keys: ['换班', '交接'], content: '换班要当面交接。', constant: false },
          { title: '这座城的作派', keys: [], content: '不打听别人的来路。', constant: true },
          { title: '用不上的那条', content: '既非常驻也没有关键词。', constant: false }
        ]
      });
      const commaKeys = JSON.stringify({
        entries: [{ title: '街口', keys: '街口，路灯', content: '路灯坏了三年。', constant: false }]
      });
      const fenced = '好的：\\n\\n\\\`\\\`\\\`json\\n' + clean + '\\n\\\`\\\`\\\`';

      const a = mod.parseBookEntries(clean);
      const b = mod.parseBookEntries(commaKeys);
      const c = mod.parseBookEntries(fenced);
      const d = mod.parseBookEntries('这不是 JSON');
      return {
        exported: true,
        clean: {
          ok: a.ok,
          n: (a.entries || []).length,
          unusable: a.unusable || 0,
          constant: (a.entries || []).filter((e) => e.constant).length,
          dropped: !(a.entries || []).some((e) => e.title === '用不上的那条')
        },
        comma: { ok: b.ok, keys: ((b.entries || [])[0] || {}).keys, err: b.error },
        fenced: { ok: c.ok, n: (c.entries || []).length },
        junk: { ok: d.ok, err: d.error }
      };
    })()`);

    if (!out || !out.exported) {
      push('AI 补设定：解析函数可以从模块里拿到', false, JSON.stringify(out));
      return;
    }
    push('AI 补设定：能解析出条目', out.clean.ok && out.clean.n === 2, JSON.stringify(out.clean));
    push('AI 补设定：既非常驻又没关键词的条目被丢掉', out.clean.dropped && out.clean.unusable === 1, JSON.stringify(out.clean));
    push('AI 补设定：常驻条目没被当成关键词条目', out.clean.constant === 1, JSON.stringify(out.clean));
    push('AI 补设定：关键词写成逗号串也认', out.comma.ok && (out.comma.keys || []).length === 2, JSON.stringify(out.comma));
    push('AI 补设定：带围栏的输出也能解析', out.fenced.ok && out.fenced.n === 2, JSON.stringify(out.fenced));
    push('AI 补设定：乱码不抛错、给出错误', !out.junk.ok && !!out.junk.err, JSON.stringify(out.junk));
  } catch (err) {
    push('AI 补设定：解析体检能跑起来', false, (err && err.message) || String(err));
  }
}

/**
 * 「AI 补充」（角色编辑器左栏那颗）的解析体检：同上，纯函数直接喂原文。
 * 盯两处：
 *   · 模型偷懒写 first_mes / mes_example（下划线写法）也得认，否则那两栏会被静默丢掉；
 *   · 一栏都没解析出来时必须报错 —— 否则界面上「点了一下什么都没发生」。
 */
async function probeCardFillParse(win, result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  try {
    const out = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import(new URL('js/views/charAiFill.js', document.baseURI).href);
      if (typeof mod.parseCardFill !== 'function') return { exported: false };

      const clean = JSON.stringify({
        description: '描述', scenario: '场景', firstMes: '开场白', mesExample: '示例'
      });
      const snake = JSON.stringify({ first_mes: '开场白', mes_example: '示例' });
      const fenced = '好的：\\n\\n\\\`\\\`\\\`json\\n' + clean + '\\n\\\`\\\`\\\`';
      const empty = JSON.stringify({ description: '', scenario: '   ' });

      const a = mod.parseCardFill(clean);
      const b = mod.parseCardFill(snake);
      const c = mod.parseCardFill(fenced);
      const d = mod.parseCardFill('这不是 JSON');
      const e = mod.parseCardFill(empty);
      return {
        exported: true,
        clean: { ok: a.ok, filled: a.filled },
        snake: { ok: b.ok, firstMes: (b.fields || {}).firstMes, mesExample: (b.fields || {}).mesExample },
        fenced: { ok: c.ok, filled: c.filled },
        junk: { ok: d.ok, err: d.error },
        empty: { ok: e.ok, err: e.error }
      };
    })()`);

    if (!out || !out.exported) {
      push('AI 补充：解析函数可以从模块里拿到', false, JSON.stringify(out));
      return;
    }
    push('AI 补充：四栏都能解析出来', out.clean.ok && out.clean.filled === 4, JSON.stringify(out.clean));
    push('AI 补充：下划线写法（first_mes / mes_example）也认', out.snake.ok && out.snake.firstMes && out.snake.mesExample, JSON.stringify(out.snake));
    push('AI 补充：带围栏的输出也能解析', out.fenced.ok && out.fenced.filled === 4, JSON.stringify(out.fenced));
    push('AI 补充：乱码不抛错、给出错误', !out.junk.ok && !!out.junk.err, JSON.stringify(out.junk));
    push('AI 补充：一栏都没给就算失败', !out.empty.ok && !!out.empty.err, JSON.stringify(out.empty));
  } catch (err) {
    push('AI 补充：解析体检能跑起来', false, (err && err.message) || String(err));
  }
}

/**
 * 「AI 生成预设」的解析体检：同上，纯函数直接喂原文。
 * 重点盯两处：正文空了不能算成功（否则会开一张只有名字的空预设）；
 * 名字缺失要有兜底名（保存按钮靠名字非空才放行，空名字会让「保存」变成没反应）。
 */
async function probePresetGenParse(win, result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  try {
    const out = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import(new URL('js/views/presetAi.js', document.baseURI).href);
      if (typeof mod.parseGeneratedPreset !== 'function') return { exported: false };

      const clean = JSON.stringify({
        name: '短句对白',
        note: '让回复短下来，多留白。',
        tags: ['节奏', '对白'],
        content: '每轮不超过三句话。\\n不解释情绪。'
      });
      const fenced = '好的，我按你说的写了：\\n\\n\\\`\\\`\\\`json\\n' + clean + '\\n\\\`\\\`\\\`\\n\\n还需要再短吗？';
      const commaTags = JSON.stringify({ name: '短句对白', note: '说明', tags: '节奏，对白', content: '一条规则。' });
      const noContent = JSON.stringify({ name: '空壳', note: '只有说明', content: '   ' });
      const noName = JSON.stringify({ note: '没名字', content: '一条规则。' });

      const a = mod.parseGeneratedPreset(clean);
      const b = mod.parseGeneratedPreset(fenced);
      const c = mod.parseGeneratedPreset(commaTags);
      const d = mod.parseGeneratedPreset(noContent);
      const e = mod.parseGeneratedPreset(noName);
      const f = (r) => r.fields || {};
      return {
        exported: true,
        clean: {
          ok: a.ok,
          name: f(a).name,
          tags: f(a).tags || [],
          content: !!f(a).content,
          err: a.error
        },
        fenced: { ok: b.ok, name: f(b).name, err: b.error },
        comma: { ok: c.ok, tags: f(c).tags || [], err: c.error },
        noContent: { ok: d.ok, err: d.error },
        noName: { ok: e.ok, name: f(e).name }
      };
    })()`);

    if (!out || !out.exported) {
      push('AI 生成预设：解析函数可以从模块里拿到', false, JSON.stringify(out));
      return;
    }
    push(
      'AI 生成预设：干净的 JSON 能解析出全部字段',
      out.clean.ok && out.clean.name === '短句对白' && out.clean.content && out.clean.tags.length === 2,
      JSON.stringify(out.clean)
    );
    push(
      'AI 生成预设：带围栏和废话的输出也能解析',
      out.fenced.ok && out.fenced.name === '短句对白',
      JSON.stringify(out.fenced)
    );
    push('AI 生成预设：标签写成逗号串也认', out.comma.ok && out.comma.tags.length === 2, JSON.stringify(out.comma));
    push('AI 生成预设：正文是空的就不算成功', !out.noContent.ok && !!out.noContent.err, JSON.stringify(out.noContent));
    push('AI 生成预设：没给名字时有个兜底名', out.noName.ok && out.noName.name === '未命名预设', JSON.stringify(out.noName));
  } catch (err) {
    push('AI 生成预设：解析体检能跑起来', false, (err && err.message) || String(err));
  }
}

/**
 * 文案体检：属性编辑器的「更新频率」提示不该硬编码具体字段名（字段是用户
 * 卡片/世界书的数据）。放宿主侧用 fs 读源码，是因为渲染层 CSP 拦 fetch file://。
 */
function probeAttrModeWording(result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  let src = '';
  try {
    src = fs.readFileSync(path.join(APP_DIR, 'renderer', 'js', 'views', 'charAttributes.js'), 'utf8');
  } catch (err) {
    push('文案体检：能读到 charAttributes.js', false, (err && err.message) || String(err));
    return;
  }

  // 「更新频率」的文案应该是抽象描述：不出现「…这类」的字段举例。
  const badExamples = src.split('\n').filter((line) => /每轮维护|变了才说/.test(line) && /这类/.test(line));
  push(
    '文案体检：「更新频率」文案是抽象描述、不含字段举例',
    badExamples.length === 0,
    badExamples.join(' | ')
  );
}

/**
 * 设置白名单体检：界面能写进 config.json 的每个键，都必须登记在 DEFAULT_SETTINGS 里。
 *
 * 为什么要有这条：main/providers.js 的 saveSettings 只收「DEFAULT_SETTINGS 里有」
 * 或「磁盘上本来就有」的键（挡住往配置里塞垃圾）。**「磁盘上本来就有」这半条会掩盖
 * 漏登记** —— 老用户的 config.json 里早写过了，于是漏了也一直不出事；
 * 直到全新装一份，第一次保存就被静默丢掉，只在主进程打一行看不见的 warn。
 * autoContinue / commonAttributes 就是这么漏的（快捷候选词、自动续写，
 * 界面里怎么改都不生效，而且只在"干净机器"上复现）。
 *
 * ⚠️ 新增设置项时：先把它加进 main/providers.js 的 DEFAULT_SETTINGS，
 *    再来这里补一行 —— 这条断言就是用来逼你想起前一步的。
 */
function probeSettingsWhitelist(result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  const UI_WRITABLE_SETTINGS = [
    // settings.js 的表单
    'providers', 'activeProviderId', 'activeModel', 'temperature', 'maxTokens',
    'sendOnEnter', 'showDate', 'showUsage',
    'autoContinue', 'worldbookRecursiveDepth', 'maxTurns',
    'imageProviderId', 'imageModel', 'imageSize',
    'ragEnabled', 'embeddingProviderId', 'embeddingModel',
    'assistantPersonas',
    // appearance.js / theme.js
    'chatFontSize', 'chatBoldColor', 'chatBackground', 'theme', 'accent'
  ];

  let defaults = null;
  try {
    ({ DEFAULT_SETTINGS: defaults } = require('../main/providers.js'));
  } catch (err) {
    push('设置白名单：能读到 main/providers.js', false, (err && err.message) || String(err));
    return;
  }
  push('设置白名单：能读到 main/providers.js', !!defaults);

  const missing = UI_WRITABLE_SETTINGS.filter((key) => !(key in defaults));
  push(
    '设置白名单：界面能写的键都在 DEFAULT_SETTINGS 里',
    missing.length === 0,
    missing.length ? `漏登记：${missing.join(', ')}` : ''
  );

  // 反向：白名单必须真的拦得住完全没见过的键，别把闸门开成摆设
  const unknown = ['__definitely_not_a_setting__'];
  const leaked = unknown.filter((key) => key in defaults);
  push('设置白名单：没见过的键确实不在默认表里', leaked.length === 0, leaked.join(', '));
}

/**
 * 默认人设（设置 → 默认人设）：管的是**没绑角色卡**的会话，而且按模型各存一份。
 *
 * 页面侧只能验「表单读写得对、标题跟着变」，这里补上真正的效果 ——
 * 那段人设有没有被拼进发给模型的消息。
 *
 * ⚠️ 这里同时守着一条设计：默认对话是「跟 AI 模型聊天」，**不是**扮演酒馆角色，
 * 所以只该带用户自己写的人设，不能再叠一层【扮演规则】—— 那份人设是自足的，
 * 多一层规则只会跟它打架（这条是 2026-10-07 用户明确要求的）。
 */
function probeAssistantPersona(result) {
  if (!result) return;
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  // 认这句特征串（smoke-renderer 里配的那段人设）
  const MARK = '你是一只叫团子的猫';
  const blobs = chatPayloads.map((msgs) =>
    msgs.map((m) => String((m && m.content) || '')).join('\n')
  );

  const hit = blobs.filter((b) => b.includes(MARK));
  push(
    '默认人设：配了人设的通用对话把它拼进了系统提示词',
    hit.length >= 1,
    hit.length ? '' : `翻了 ${blobs.length} 次请求都没找到那段人设`
  );

  const plain = hit.length > 0 && hit.every((b) => !b.includes('【扮演规则】') && !b.includes('【主持规则】'));
  push(
    '默认对话：只带人设，不再注入酒馆的扮演规则',
    plain,
    plain ? '' : '默认对话里混进了扮演/主持规则 —— 那会和用户自己写的人设打架'
  );

  // 「不是酒馆会话」不止扮演规则那一条。世界 NPC 名单 / 玩家角色这两段
  // 是 buildApiMessages **自己从 convo 里读**的（不像世界书那样由参数传进来），
  // 所以最容易被漏掉：漏了不报错，只是悄悄混进提示词。这里一起守着。
  //
  // ⚠️ 2026-10-08 → **2026-10-13 又反了一次，结论以现在为准**：
  //   【叙述要求】/【推进节奏】一度从这份名单里**拿掉**过（改成「普通聊天也注入」，
  //   为的是修「视角弹窗能选、却不生效」）。但它们是**默认开着**的 —— 于是
  //   「＋ 新对话」天生带着一整套舞台指示（写环境、写动作、「必须有角色说出口的台词」），
  //   模型没有身份就自己编一个演起来（用户报的现场：新对话里 AI 自己坐在地毯上修台灯）。
  //   现在这两段**彻底不进纯聊天**，连视角弹窗里的入口都摘了（views/perspectiveUi.js）——
  //   所以它们回到这份「不许出现」的名单里。
  const TAVERN_MARKS = [
    '【扮演规则】',
    '【主持规则】',
    '【这个世界的人】',
    '【玩家角色',
    '【叙述要求】',
    '【推进节奏】'
  ];
  const leaked = hit.length ? TAVERN_MARKS.filter((mark) => hit.some((b) => b.includes(mark))) : [];
  push(
    '默认对话：扮演/主持规则、玩家角色、NPC 名单、叙述模式、推进节奏都没混进来',
    hit.length > 0 && leaked.length === 0,
    leaked.length ? `混进了：${leaked.join('、')}` : `翻了 ${blobs.length} 次请求都没找到那段人设`
  );
}

/**
 * 世界书命中条目要拆成两块：关键词命中的（`section`）和常驻的（`deepSection`）。
 *
 * 为什么值得单独钉：拆块本身是纯函数（main/worldbook-match.js 的
 * `formatWorldbookSections`），但**谁落在哪一块**决定了常驻条目还能不能被人送到
 * 靠近生成位置的地方（渲染层 messages.js 第 6b 步）。
 * 判据如果写成「keys 为空」就会把「不带关键词、又没勾常驻」的条目也当成常驻 ——
 * 而那种条目在 `entryMatches` 里恒不命中（`[].some()` 永远是 false），根本不会走到这里，
 * 于是错判永远不报错、只是偶尔把东西放错位置。所以这里把边界钉死。
 *
 * 位置那一半（第 6b 步到底插在哪儿）在页面侧，见 smoke-renderer.js 的
 * 「世界书：常驻条目注入到靠近落笔的位置」。
 */
function probeWorldbookDeepSplit(result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  const hits = [
    { id: 'a', title: '常驻规则', content: '玩家不是世界中心。', constant: true, order: 5 },
    { id: 'b', title: '拳馆', content: '月费十二镑。', constant: false, order: 10, keys: ['拳馆'] },
    { id: 'c', title: '教派', content: '只在周日开门。', order: 20, keys: ['教派'] }
  ];

  let out;
  try {
    out = formatWorldbookSections(hits);
  } catch (err) {
    push('世界书拆块：纯函数跑得通', false, (err && err.message) || String(err));
    return;
  }

  push(
    '世界书拆块：section 只装关键词命中那批',
    out.section.includes('拳馆') && out.section.includes('教派') && !out.section.includes('常驻规则'),
    out.section.slice(0, 60)
  );
  push(
    '世界书拆块：deepSection 只装常驻条目',
    out.deepSection.includes('常驻规则') && !out.deepSection.includes('拳馆') && !out.deepSection.includes('教派'),
    out.deepSection.slice(0, 60)
  );
  push(
    '世界书拆块：两块抬头不一样',
    out.section.startsWith('[世界设定]') && out.deepSection.startsWith('[世界设定 · 常驻]'),
    `${out.section.slice(0, 12)} / ${out.deepSection.slice(0, 14)}`
  );

  const odd = formatWorldbookSections([{ id: 'd', title: '没关键词也没勾常驻', content: 'x', keys: [] }]);
  push(
    '世界书拆块：不勾常驻的条目不会被误当常驻',
    odd.section.includes('没关键词也没勾常驻') && odd.deepSection === '',
    `section=${odd.section.slice(0, 26)} deep=${JSON.stringify(odd.deepSection)}`
  );

  const empty = formatWorldbookSections([]);
  push(
    '世界书拆块：没命中时两块都是空串',
    empty.section === '' && empty.deepSection === '',
    JSON.stringify(empty)
  );
}

/**
 * 世界书「导出 → 导入」的**真**往返：导出的字节由页面里真实的
 * `worldbookPayload()`（renderer/js/data/library.js）生成，再喂给主进程真实的
 * `importFiles` —— 中间隔着进程边界和两层归一化，两边都换不掉。
 *
 * 为什么非要这么绕：`worldbookPayload` 住在渲染层（导出按钮按的是它），
 * 而 `importFiles` 住在主进程（导入按钮走的是它），宿主侧没法直接 require
 * 渲染层的 ESM。以前这条断言根本不存在，于是「导出只写 name/description/entries」
 * 一直没被发现 —— 表现是**导出一本带 NPC 的世界书再导回来，书里的 NPC 一个不剩**，
 * 而那正是分享一份世界书时最想要的。
 *
 * 同时验「书里的 NPC 不会被当成新的角色卡塞进角色卡」：导入结果里
 * `characters` 是「新增的角色卡」，世界书的 NPC 只该住在书里。
 */
async function probeWorldbookExportRoundTrip(win, result) {
  const push = (name, pass, detail) => result.results.push({ name, pass: !!pass, detail: detail || '' });

  const source = {
    name: '往返用世界书',
    entries: [
      {
        title: '世界规则（常驻）',
        keys: [],
        secondaryKeys: [],
        content: '玩家不是世界中心。',
        constant: true,
        order: 5,
        enabled: true,
        probability: 100
      },
      {
        title: '食堂',
        keys: ['食堂'],
        secondaryKeys: [],
        content: '中午人最多。',
        constant: false,
        order: 10,
        enabled: true,
        probability: 100
      }
    ],
    characters: [
      { name: '顾言', description: '大三，学生会成员', personality: '温和可靠' },
      { name: '林夏', description: '新闻学院', personality: '外向活泼', age: '20', gender: '女' }
    ]
  };

  let text = '';
  let exportDetail = '';
  try {
    text = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import(new URL('js/data/library.js', document.baseURI).href);
      const book = ${JSON.stringify(source)};
      book.id = 'w-roundtrip-src';
      return JSON.stringify(mod.worldbookPayload(book));
    })()`);
  } catch (err) {
    exportDetail = '页面里导出失败：' + ((err && err.message) || err);
  }

  let shapeOk = false;
  let shapeDetail = exportDetail || '没拿到导出的 JSON';
  if (!exportDetail) {
    try {
      const payload = JSON.parse(text);
      const cast = Array.isArray(payload.characters) ? payload.characters : [];
      shapeOk =
        Object.keys(payload.entries || {}).length === 2 &&
        cast.length === 2 &&
        cast[0].name === '顾言' &&
        cast[1].name === '林夏';
      shapeDetail = `条目=${Object.keys(payload.entries || {}).length} characters=${cast
        .map((c) => c.name)
        .join('、')}`;
    } catch (err) {
      shapeDetail = '导出的 JSON 解析失败：' + ((err && err.message) || err);
    }
  }
  push('导出：世界书带上了书里的 NPC', shapeOk, shapeOk ? '' : shapeDetail);

  // 把页面刚导出的那份字节喂进真实的导入链路
  let backOk = false;
  let backDetail = shapeOk ? '没跑起来' : `导出的形状就不对（${shapeDetail}），往返没意义`;
  if (shapeOk) {
    try {
      const back = importFiles({
        paths: ['D:\\roundtrip\\worldbook.json'],
        readFile: () => Buffer.from(text, 'utf8'),
        parseImportFile,
        makeWorldbookId: () => 'w-roundtrip-back',
        normalizeCharacters: (raw) => normalizeCharacter(raw, 'json')
      });
      const b = (back.worldbooks || [])[0];
      const cast = b && Array.isArray(b.characters) ? b.characters : [];
      const cards = back.characters || [];
      // 单独一份书的文件进来会被包成**一张**同名卡（书只能跟着卡走）；
      // 书里那 2 个 NPC 不该各自变成一张卡。
      backOk =
        !!b &&
        (b.entries || []).length === 2 &&
        cast.length === 2 &&
        cast[0].name === '顾言' &&
        cast[0].personality === '温和可靠' &&
        cards.length === 1 &&
        cards[0].name === b.name &&
        (cards[0].worldbookIds || [])[0] === b.id;
      backDetail = `书=${b && b.name} 条目=${b ? (b.entries || []).length : 0} NPC=${cast.map((c) => c.name).join('、')} 新增角色卡=${cards.map((c) => c.name).join('、')} errors=${JSON.stringify(
        back.errors
      )}`;
    } catch (err) {
      backDetail = '往返崩了：' + ((err && err.message) || err);
    }
  }
  push('导出 → 导入：世界书的 NPC 都还在（真往返）', backOk, backOk ? '' : backDetail);

  // NPC 的 id 在导入时要重发（同一毫秒里连导两次会撞车），而且两个 NPC 不能重号 ——
  // 不然同一次导入里的两个副本会互相顶掉。这段逻辑住在渲染层，所以在这儿验。
  let reissueOk = false;
  let reissueDetail = exportDetail || '没跑起来';
  try {
    reissueDetail = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import(new URL('js/data/library-reissue.js', document.baseURI).href);
      const books = [{ id: 'w-old', name: 'x', characters: [{ id: 'old-1', name: '顾言' }, { id: 'old-2', name: '林夏' }] }];
      const out = mod.reissueImportedIds(books, [], 'stampX');
      const chars = (out.books[0] && out.books[0].characters) || [];
      const ids = chars.map((c) => c.id);
      return JSON.stringify({
        ok: ids.length === 2 && new Set(ids).size === 2 && ids.every((id) => typeof id === 'string' && !!id) &&
          !!out.books[0] && out.books[0].id !== 'w-old',
        ids,
        kept: chars.map((c) => c.name)
      });
    })()`);
    const parsed = JSON.parse(reissueDetail);
    reissueOk = parsed.ok === true && parsed.kept.join('、') === '顾言、林夏';
  } catch (err) {
    reissueDetail = '重发 id 崩了：' + ((err && err.message) || err);
  }
  push('导入：重发 id 之后书里每个 NPC 的 id 都不重号', reissueOk, reissueOk ? '' : reissueDetail);
}

/**
 * 写盘失败必须浮上来（真 bug 的回归测试）。
 *
 * 以前 store.js 的 writeJsonNow 出错只 `return false`，writeJson 把 false 当结果
 * resolve，而 saveConversations 这些函数返回的是自己那份 payload、根本不看写没写成功。
 * 于是一路「成功」到界面：用户看到「已保存」，磁盘上还是旧文件，
 * 下次启动读回旧数据，中间改的全没了 —— renderer/js/data/persist.js 里那几个
 * 「保存失败，请检查磁盘空间」的提示因此全是死代码。
 *
 * 这里在**临时 userData** 里制造一次必然失败的写入（把目标路径占成一个目录），
 * 验三件事：同步路径要抛、排队路径要 reject、失败之后队列还得能用。
 * 最后那条是防「修一个坑挖一个新坑」：如果队尾被 rejection 钉住，
 * 一次失败就会让**之后所有**保存静默不写，比原来还糟。
 */
async function probeStoreWriteFailure(result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  const realUserData = app.getPath('userData');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-smoke-store-'));
  app.setPath('userData', tmp);

  // ⚠️ dataDir() 是**带缓存**的。2026-10-23 加账号场景后，界面那边会写 account.json，
  //    缓存早就指向冒烟的数据目录了 —— 不重置的话 saveConversations 会写到那边去，
  //    下面「把 conversations.json.tmp 占成目录让写失败」就完全不起作用（这条断言白跑）。
  const { resetDataDirCache } = require('../main/data-dir.js');
  resetDataDirCache();

  try {
    const { writeJson, writeJsonNow, saveConversations } = require('../main/store.js');

    // 正常路径：先证明这套工具本身是好的
    const okFile = path.join(tmp, 'ok.json');
    writeJsonNow(okFile, { a: 1 });
    push('写盘探针：正常写入成功', fs.existsSync(okFile));

    // 把目标路径占成一个目录 —— 写入必然失败（EISDIR / EPERM）
    const blocked = path.join(tmp, 'blocked.json');
    fs.mkdirSync(blocked);

    let syncDetail = '';
    try {
      writeJsonNow(blocked, { a: 1 });
      syncDetail = '没抛 —— 还是被吞了';
    } catch (err) {
      syncDetail = '抛了：' + ((err && err.message) || err);
    }
    push(
      '写盘失败：同步路径会抛（不再只 return false）',
      syncDetail.startsWith('抛了'),
      syncDetail
    );

    // 排队路径要 reject —— 界面那几个「保存失败」的提示全靠它
    let queuedDetail = '';
    try {
      await writeJson(blocked, { a: 1 });
      queuedDetail = '没 reject —— 还是被吞了';
    } catch (err) {
      queuedDetail = 'reject 了：' + ((err && err.message) || err);
    }
    push(
      '写盘失败：排队路径会 reject（界面才收得到）',
      queuedDetail.startsWith('reject'),
      queuedDetail
    );

    // immediate 路径（关窗口前那次保存）同样要抛
    let immediateDetail = '';
    try {
      // 目标文件占成目录，写入必然失败
      fs.mkdirSync(path.join(tmp, 'conversations.json.tmp'));
      saveConversations({ conversations: [{ id: 'x' }], activeId: 'x' }, { immediate: true });
      immediateDetail = '没抛';
    } catch (err) {
      immediateDetail = '抛了：' + ((err && err.message) || err);
    }
    push(
      '写盘失败：saveConversations({immediate:true}) 会抛',
      immediateDetail.startsWith('抛了'),
      immediateDetail
    );

    // 失败之后队列不能被钉死：下一次写入必须真的落地
    const afterFile = path.join(tmp, 'after.json');
    await writeJson(afterFile, { b: 2 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    push(
      '写盘失败之后，队列没被钉死（后续写入仍落地）',
      fs.existsSync(afterFile),
      afterFile
    );
  } catch (err) {
    push('写盘探针能跑起来', false, (err && err.message) || String(err));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (err) {
      /* ignore */
    }
    app.setPath('userData', realUserData);
    // 恢复真实目录之后同样要清缓存，后面的 probe 才看得到真实数据目录
    resetDataDirCache();
  }
}

/**
 * 请求记录（顶栏「⋯」→ 请求记录）。
 *
 * 这个功能的落点是「把真正发出去的那一份留下」，而**留下来的到底对不对**
 * 页面里看不到 —— 所以两条关键断言在宿主侧：
 *
 *   1. main/http.js 是不是在请求**发出去之前**就把定稿的 body 交给 onRequest。
 *      用 127.0.0.1:1（保留端口，必连不上）也够 —— 回调在建立连接之前就触发了，
 *      我们要的是那份 body，不是响应。
 *   2. 环形缓冲是不是真的在转、上限认不认。塞满再塞，看最旧的有没有被挤掉。
 *
 * ⚠️ 这里会清空缓冲。渲染层那边的场景**已经跑完了**（场景全部跑完才轮到宿主侧 probe），
 *    所以不会影响它。
 */
async function probeRequestLog(result) {
  const push = (name, pass, detail) =>
    result.results.push({ name, pass: !!pass, detail: detail || '' });

  // --- 1) http.js 的 onRequest 接线 ---
  // 关键：streamChat 的函数体是 `return new Promise((resolve,reject)=>{...})`，
  // **executor 是同步跑的** —— 所以 onRequest 在 streamChat() 这一下里就触发了，
  // 不用等 socket。后面那句 race 只是让连接错误走完、别把句柄留着，
  // 顺手给它 2 秒上限，万一这个环境不立刻 ECONNREFUSED 也不会拖住整个测试。
  let seen = null;
  const pending = streamChat({
    settings: {
      baseUrl: 'http://127.0.0.1:1',
      model: 'smoke-request-log',
      apiKey: 'smoke-key',
      temperature: 0.31,
      maxTokens: 1234,
      topP: 0.87
    },
    messages: [{ role: 'user', content: '记录我' }],
    onRequest: (body, url) => {
      seen = { body, url };
    }
  }).catch(() => {
    // 连不上正是这条用例的预期：要看的是 seen，不是响应
  });
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 2000))]);

  push(
    '请求记录：发出去之前就把定稿的 body 交了出来',
    !!(seen && seen.body),
    seen ? '' : 'onRequest 没被调用 —— 弹窗里会是空的'
  );
  push(
    '请求记录：交出来的就是最终要发的那份（模型 + 三个采样参数）',
    !!seen &&
      seen.body.model === 'smoke-request-log' &&
      seen.body.temperature === 0.31 &&
      seen.body.max_tokens === 1234 &&
      seen.body.top_p === 0.87 &&
      seen.body.stream === true,
    seen
      ? JSON.stringify({
          model: seen.body.model,
          temperature: seen.body.temperature,
          max_tokens: seen.body.max_tokens,
          top_p: seen.body.top_p
        })
      : '没有拿到 body'
  );

  // --- 1b) 本机桥接这条路也要交出来 ---
  // 桥接是另一条完全独立的请求路径（POST /chat_with_image，非流式），以前没接 onRequest，
  // 于是用桥接的机器打开「请求记录」永远是空的，界面只说「还没记录」，看不出是缺口。
  let bridgeSeen = null;
  const bridgePending = bridgeChat({
    settings: { baseUrl: 'http://127.0.0.1:1', temperature: 0.42, maxTokens: 2048 },
    messages: [{ role: 'user', content: '桥接记录我' }],
    noImage: true,
    onRequest: (body, url) => {
      bridgeSeen = { body, url };
    }
  }).catch(() => {
    // 连不上是预期：要看的是 body
  });
  await Promise.race([bridgePending, new Promise((resolve) => setTimeout(resolve, 2000))]);

  push(
    '请求记录：本机桥接这条路也交了 body（不然用桥接的人打开永远是空的）',
    !!(bridgeSeen && Array.isArray(bridgeSeen.body.messages) && bridgeSeen.body.temperature === 0.42),
    bridgeSeen ? JSON.stringify(bridgeSeen.body).slice(0, 120) : 'onRequest 没被调用'
  );
  push(
    '请求记录：桥接交出来的是它真正发的那个地址',
    !!bridgeSeen && /\/chat$/.test(String(bridgeSeen.url || '')),
    bridgeSeen ? String(bridgeSeen.url) : '没有拿到 url'
  );

  // --- 1c) User-Agent 只有一处定义 ---
  // 换仓库时散在三处的副本只改了一处（本机桥接的聊天和生图一直指着旧地址）。
  // 这属于「字符串对不上、不报错」那类，只能靠断言钉住。
  const httpSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'http.js'), 'utf8');
  const uaHits = httpSrc.match(/Mimitale\/1\.0 \(\+https:\/\/github\.com\/[^)]*\)/g) || [];
  push(
    '请求头：User-Agent 只有一处定义（散成副本就会各自漂走）',
    uaHits.length === 1,
    `找到 ${uaHits.length} 处`
  );
  push(
    '请求头：User-Agent 不再指向旧仓库',
    uaHits.length > 0 && !uaHits.some((ua) => ua.includes('ls546280821')),
    uaHits.join(' / ') || '没找到'
  );

  // --- 2) 环形缓冲 ---
  clearRequests();
  for (let i = 0; i < MAX_LOGGED_REQUESTS + 5; i += 1) {
    recordRequest({
      requestId: `smoke-${i}`,
      providerName: 'smoke',
      url: 'http://x/v1/chat/completions',
      body: { model: `m${i}` }
    });
  }
  const list = listRequests();
  const newest = list[0] && list[0].body && list[0].body.model;
  const oldest = list[list.length - 1] && list[list.length - 1].body && list[list.length - 1].body.model;
  push(
    `请求记录：最多留 ${MAX_LOGGED_REQUESTS} 条，超了挤掉最旧的`,
    list.length === MAX_LOGGED_REQUESTS &&
      newest === `m${MAX_LOGGED_REQUESTS + 4}` &&
      oldest === 'm5',
    `长度 ${list.length}，最新 ${newest}，最旧 ${oldest}`
  );

  clearRequests();
  push('请求记录：能清空', listRequests().length === 0, String(listRequests().length));
}

app.whenReady().then(async () => {
  registerStubs();

  // 窗口尺寸从 main/window.js 读，别在这儿写死 —— 写死过一次（1180×800），
  // 窗口改成 1440×900 之后没人记得改这里，于是截图一直比真机窄两百多像素，
  // 照着截图调的间距全是错的。
  const { WINDOW_SIZE } = require('../main/window.js');
  const win = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    useContentSize: true,
    autoHideMenuBar: true, // 和真实窗口一致：菜单栏不占内容高度
    show: false, // 不弹窗，跑测试不打扰你
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false, // 窗口不可见时不要限制定时器/动画帧
      // 版本号跟真实窗口一样从启动参数递进去（见 main/window.js 的 additionalArguments）。
      // ⚠️ 不传的话，侧栏品牌行那个「v1.0」在**出图里永远空着** ——
      //    功能是好的，但「到底显示对了没有」只能靠猜（2026-10-12 就这么疑惑过一轮）。
      // 主题 / 配色**故意不在这里传**：测试要自己控制它们，传了会跟测试的切换打架。
      additionalArguments: [`--mimitale-version=${require('../package.json').version}`]
    }
  });

  const consoleErrors = [];
  const consoleWarnings = [];
  // --progress 才把页面里「跑到第几个场景」打出来。
  // 没有它的时候，「跑超时了」分不清是**卡死**还是**只是还没跑完** ——
  // 加场景把总时长顶过兜底超时那次，就是靠它一眼看出停在哪个场景（见 OVERALL_TIMEOUT_MS）。
  const showProgress = process.argv.includes('--progress');

  // --dump-groups：跑整套时，趁每个域「第一个场景刚要开始」把假后端状态存成
  // smoke-seed-<域名>.json，当这一域的夹具。
  // 为什么按「域起始」而不是按「跑完」：场景断言的多半是**演变**（「角色卡一开始
  // 是空的」「删空后显示空状态」），拿终态当起点，这些必红。
  const dumpGroups = process.argv.includes('--dump-groups');
  const groupStarts = new Map(); // 场景名 → 域名
  if (dumpGroups) {
    const order = [...fs.readFileSync(path.join(__dirname, 'smoke-renderer.js'), 'utf8')
      .matchAll(/await scenario\('([^']+)'/g)].map((m) => m[1]);
    const seen = new Set();
    for (const name of order) {
      for (const [key, g] of Object.entries(GROUPS)) {
        if (seen.has(key) || !g.scenarios.includes(name)) continue;
        groupStarts.set(name, key);
        seen.add(key);
      }
    }
  }

  win.webContents.on('console-message', (...args) => {
    // 新旧 Electron 的事件签名不一样，两种都兜住
    const first = args[0];
    const level = typeof args[1] === 'number' ? args[1] : first && first.level;
    const message = typeof args[2] === 'string' ? args[2] : first && first.message;
    const text = String(message == null ? '' : message);
    if (showProgress && text.startsWith('[progress]')) console.log('    ' + text);
    // 场景开头那行 [progress] 是**无条件**打的（--progress 只管要不要显示），
    // 所以这里能拿到「哪个场景刚开始」。此刻 store 还没被这个场景碰过。
    if (dumpGroups && text.startsWith('[progress]') && text.includes('开始场景：')) {
      const name = text.split('开始场景：')[1].trim();
      const key = groupStarts.get(name);
      if (key) {
        fs.writeFileSync(path.join(__dirname, `smoke-seed-${key}.json`), JSON.stringify(store, null, 2));
        console.log(`    [夹具] ${key} ← 「${name}」开跑前的状态`);
      }
    }
    if (level === 3 || level === 'error') consoleErrors.push(text);
    else if (level === 2 || level === 'warning') consoleWarnings.push(text);
  });

  let crashed = '';
  try {
    await win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));
  } catch (err) {
    crashed = '页面加载失败：' + ((err && err.message) || err);
  }

  let result = null;
  if (!crashed && !SHOT_ONLY) {
    const domScript = fs.readFileSync(path.join(__dirname, 'smoke-renderer.js'), 'utf8');
    // 场景筛选靠一个前置变量递进去（渲染侧是注入的脚本，没有 process.argv）。
    // 用 var 声明：渲染侧那段代码在同一个闭包里，var 不受 TDZ 影响。
    const prelude = `var SMOKE_FILTER = ${JSON.stringify({ only: ONLY, skip: SKIP, pick: PICK })};\n`;
    try {
      result = await win.webContents.executeJavaScript(`(async () => {\n${prelude}${domScript}\n})()`);
    } catch (err) {
      crashed = '页面内脚本执行失败：' + ((err && err.message) || err);
    }
  }

  if (!crashed && result) {
    // 宿主侧这批 probe 是**事后**翻请求记录 / 导出记录做校验的 —— 它们全都依赖
    // 前面场景攒下来的副作用（chatPayloads、导出记录、灯箱里那张图…）。
    // 所以给这一段产生的断言打上 scope='host'：--only / --skip 时整段跳过统计，
    // 否则「只跑世界书」会带出 38 条假失败，看着像回归（2026-10-23 实测）。
    const hostBase = result.results.length;
    try {
      probeInjection(result);
      probePresets(result);
      probeExports(result);
      probeImport(result);
      probeWorldbookStore(result);
      probePanelFields(result);
      probeRecursion(result);
      probeImageGen(result);
      probeVectors(result);
      probeRag(result);
      probeAttrModeWording(result);
      probeAssistantPersona(result);
      await probeRequestLog(result);
      probeSettingsWhitelist(result);
      await probeStoreWriteFailure(result);
      await probeAiGenParse(win, result);
      await probeBookEntries(win, result);
      await probeCardFillParse(win, result);
      await probePresetGenParse(win, result);
      probeBatchLibrary(result);
      await probeWorldbookExportRoundTrip(win, result);
      probeWorldbookDeepSplit(result);
      await probeHover(win, result);
      await probeLightboxClick(win, result);
    } catch (err) {
      crashed = '宿主侧验证失败：' + ((err && err.message) || err);
    }
    for (const r of result.results.slice(hostBase)) r.scope = 'host';
  }

  // --shot=<场景>：把窗口显示出来、切到指定界面再截图到 tools/shots/。
  // 结构和逻辑测试盖不住的「看着对不对」（间距、对齐、配色）得靠这个看，
  // 不用每次都临时加代码再删。
  // 用法：electron tools/smoke-test.js --no-sandbox --shot=settings
  // 精确匹配 --shot=，别让 --shot-only 也命中（它没有 =，会被误当成截图场景）
  const shotArg = (process.argv.find((a) => a.startsWith('--shot=')) || '').split('=')[1];
  // --shot-dark / --shot-light：指定出图用哪一档明暗，文件名带对应后缀。
  // ⚠️ 2026-10-12 起出厂默认是**夜间**，所以这两个都不给时出的是暗色图 ——
  //    要核对「浅色底配浅色字」这类只在白天露头的毛病，必须显式加 --shot-light。
  //    暗色和浅色是两套变量，只验一档等于只验了一半。
  const shotMode = process.argv.includes('--shot-light')
    ? 'light'
    : process.argv.includes('--shot-dark')
      ? 'dark'
      : '';
  if (shotArg) {
    try {
      // 出图**默认不弹窗**（2026-10-16）。
      // 以前这里是 `win.show()`，窗口会真的冒到屏幕上、抢走焦点 —— 一边在玩全屏游戏
      // 一边让会话跑核对，等于每出一张图就被踢出游戏一次。
      // 但**不能只是不 show**：Chromium 不给隐藏窗口出帧，capturePage 抓到的是空白
      // （这正是当初写成 show() 的原因）。
      // 所以走「隐形显示」：真的 show（有帧可比），但
      //   · setOpacity(0)   整窗全透明，屏幕上什么都不出现
      //   · showInactive()  不激活、不抢焦点（正在打字/玩游戏的手不被拽走）
      //   · skipTaskbar     不在任务栏闪一下
      // 要真的看着它跑（调布局时偶尔需要）就加 `--shot-visible`。
      const shotVisible = process.argv.includes('--shot-visible');
      if (shotVisible) {
        win.show();
      } else {
        win.setOpacity(0);
        win.setSkipTaskbar(true);
        win.showInactive();
      }
      const viewport = process.argv.find((arg) => arg.startsWith('--shot-viewport='))?.split('=')[1]?.match(/^(\d+)x(\d+)$/);
      if (viewport) win.setContentSize(Number(viewport[1]), Number(viewport[2]));
      if (shotMode) {
        // 点真实的明暗按钮（只点按钮，不调内部函数）。
        // 控件在外观弹窗里 —— 不用先把弹窗打开，click() 对隐藏元素照样生效。
        await win.webContents.executeJavaScript(
          `document.querySelector('#appearance-modes [data-mode="${shotMode}"]')?.click(); true`
        );
        await new Promise((r) => setTimeout(r, 300));
      }
      // --shot-accent=amber：切到指定配色再截图。
      // 配色只剩琥珀一套，传别的色名会找不到按钮、no-op（保持琥珀）。
      const shotAccent = (process.argv.find((a) => a.startsWith('--shot-accent')) || '').split('=')[1];
      if (shotAccent) {
        const accentSel = `#appearance-accents [data-accent="${shotAccent}"]`;
        await win.webContents.executeJavaScript(`
          (async () => {
            const btn = document.querySelector(${JSON.stringify(accentSel)});
            if (btn) btn.click();
            await new Promise((r) => setTimeout(r, 150));
            return document.documentElement.getAttribute('data-accent');
          })()
        `);
        await new Promise((r) => setTimeout(r, 300));
      }
      // 每个场景 = 打开哪个界面。只点真实按钮，不调内部函数。
      const DRIVERS = {
        // 设置页（视图六，2026-10-09 从弹窗改的、2026-10-10 改成左导航 + 右内容）：
        // 左栏导航 + 右栏限宽居中的整体排版（页头那颗「返回/保存」、卡片间距）
        // 只靠 DOM 断言看不出来。
        settings: `
          document.querySelector('#btn-account-open-settings')?.click();
          await new Promise(r => setTimeout(r, 700));
          document.querySelector('.settings-nav-item[data-target="sec-models"]')?.click();
          await new Promise(r => setTimeout(r, 250));`,
        // 行为开关分组：主要验证「开关行卡片 + 开关靠右 + 头部统计」。
        settingsBehavior: `
          document.querySelector('#btn-account-open-settings')?.click();
          await new Promise(r => setTimeout(r, 700));
          document.querySelector('.settings-nav-item[data-target="sec-behavior"]')?.click();
          await new Promise(r => setTimeout(r, 250));`,
        // 语义检索分组：验证开关行卡片的另一种长说明形态。
        settingsRag: `
          document.querySelector('#btn-account-open-settings')?.click();
          await new Promise(r => setTimeout(r, 700));
          document.querySelector('.settings-nav-item[data-target="sec-rag"]')?.click();
          await new Promise(r => setTimeout(r, 250));`,
        // 自研下拉（renderer/js/ui/select.js）：**把弹层打开**再出图。
        // 位置 / 宽度 / 圆角 / 高亮那一行的观感 / 右边那个 ✓ —— 全是 DOM 断言
        // 看不出来的东西，只有图能核。
        // 顺带把这一格的几何量出来塞进 window.__selProbe：控件从原生 select 换成
        // 组件之后，最容易悄悄变的就是**宽度**（外层多了一个宿主盒），而"窄了一截"
        // 在看图上不一定第一眼认出来，有数字就一眼可见。
        selectPop: `
          document.querySelector('#btn-account-open-settings')?.click();
          await new Promise(r => setTimeout(r, 700));
          document.querySelector('.settings-nav-item[data-target="sec-appearance"]')?.click();
          await new Promise(r => setTimeout(r, 300));
          const trigger = document.getElementById('appearance-font');
          const inner = trigger && trigger.tagName === 'SELECT' ? trigger : trigger && trigger.querySelector('select');
          const field = trigger && trigger.closest('.field');
          const rect = (n) => {
            if (!n) return '(无)';
            const r = n.getBoundingClientRect();
            return Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top);
          };
          const cs = (n, p) => (n ? getComputedStyle(n)[p] : '(无)');
          window.__selProbe = {
            触发器标签: trigger ? trigger.tagName : '(没找到)',
            触发器盒: rect(trigger),
            里层select盒: rect(inner),
            field盒: rect(field),
            field显示: cs(field, 'display') + ' / ' + cs(field, 'flexDirection'),
            触发器宽度: cs(trigger, 'width') + ' min=' + cs(trigger, 'minWidth'),
            里层宽度: cs(inner, 'width'),
            label盒: rect(field && field.querySelector('.field-label')),
            // 「宿主有没有铺满」这件事出问题时要靠这几项定位：父容器是不是 .field、
            // 它的对齐方式、宿主的 display / align-self / flex 参数
            宿主父节点: trigger && trigger.parentElement
              ? trigger.parentElement.tagName + '.' + (trigger.parentElement.className || '(无类)')
              : '(无)',
            宿主display: cs(trigger, 'display'),
            field对齐: cs(field, 'alignItems') + ' / ' + cs(field, 'justifyContent'),
            宿主alignSelf: cs(trigger, 'alignSelf'),
            宿主flex: cs(trigger, 'flexGrow') + '/' + cs(trigger, 'flexShrink') + '/' + cs(trigger, 'flexBasis')
          };
          trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
          await new Promise(r => setTimeout(r, 400));`,
        // 属性行那三个下拉（类型 / 更新频率 / 分组）住在编辑器的**「属性」分区**里，
          // 而那个分区默认不是打开的那个 —— 不切过去，出图里根本看不到它们
          //（2026-10-16 踩过：控件量出来高度 0，说明它压根没显示）。
          charAttrsState: `
            const $$ = (s) => Array.from(document.querySelectorAll(s));
            const $ = (s) => document.querySelector(s);
            const nap = (ms) => new Promise(r => setTimeout(r, ms));
            const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

            document.querySelector('#btn-chars')?.click();
            await nap(400);
            document.querySelector('#btn-new-char')?.click();
            await nap(500);
            const nameBox = $('#c-name');
            if (nameBox) { nameBox.value = '属性行示例'; fire(nameBox, 'input'); }

            // 加两条属性：一条留在未分组（看类型下拉），一条展开「更多」（看更新频率 / 分组）
            for (const [name, value] of [['好感度', '20'], ['金币', '9900']]) {
              const box = $('#c-attr-new');
              box.value = name;
              $('#btn-add-attr').click();
              await nap(140);
              const rows = $$('#c-attr-list .attr-row');
              const last = rows[rows.length - 1];
              const val = last && last.querySelector('.attr-value');
              if (val) { val.value = value; fire(val, 'input'); }
            }
            $('#char-section-tab-state')?.click();
            await nap(350);
            const more = $$('#c-attr-list .attr-more-btn')[0];
            if (more) more.click();
            await nap(300);
            const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 生图分组：三个下拉（服务商 / 模型 / 尺寸）。迁移成组件之后「宽度」最容易变，
        // 出图 + 像素对比是唯一靠谱的核法。
        settingsImage: `
          document.querySelector('#btn-account-open-settings')?.click();
          await new Promise(r => setTimeout(r, 700));
          document.querySelector('.settings-nav-item[data-target="sec-image"]')?.click();
          await new Promise(r => setTimeout(r, 300));`,
        // 视角弹窗：叙述模式 / 推进节奏两个下拉（都在弹窗里，顺便验「组件里的下拉
        // 在弹窗里也吃得上自研列表」）。
        perspective: `
          document.querySelector('#btn-perspective')?.click();
          await new Promise(r => setTimeout(r, 450));`,
        // 世界书条目的「附加条件」下拉住在**条目表单**里 —— 得先选一条条目表单才出来
        wbEntryForm: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          // 世界书没有列表页：从角色的「自带世界书」进
          $('#btn-chars')?.click(); await nap(400);
          const wbCard = $$('#char-page-grid .char-card').find(c => c.textContent.includes('自带世界书测试')) || $$('#char-page-grid .char-card')[0];
          const wbEditBtn = wbCard && Array.from(wbCard.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbEditBtn) wbEditBtn.click();
          await nap(550);
          $('#char-section-tab-worldbook')?.click(); await nap(250);
          if (!$$('#c-wb-list .cwb-row').length) {
            // 绑定入口撤了（2026-10-26）：卡上没书就现场新建一本，建完直接进编辑器
            $('#c-wb-new-btn')?.click(); await nap(800);
          }
          const wbLine = $$('#c-wb-list .cwb-row')[0];
          const wbGo = wbLine && Array.from(wbLine.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbGo) wbGo.click();
          await nap(700);
          const entry = $('#wb-entry-list .wb-entry');
          if (entry) entry.click();
          await nap(450);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 桌宠区块（设置页最下面那一段）：预览框、人格、记忆列表 ——
        // 全是排版密集的地方，「挤成一行」「按钮换行」这类问题 DOM 断言看不出来，
        // 只能靠图。顺手点一次「生成一句」，让预览框里真的有内容（空框看不出高矮）。
        petSettings: `
          document.querySelector('#btn-account-open-settings')?.click();
          await new Promise(r => setTimeout(r, 900));
          // 2026-10-10 起设置分成「左导航 + 右内容」，桌宠是最后一组 ——
          // 不先切到它，右栏显示的还是「模型服务」（图就白截了）。
          document.querySelector('.settings-nav-item[data-target="pet-section"]')?.click();
          await new Promise(r => setTimeout(r, 250));
          document.querySelector('#btn-pet-preview')?.click();
          await new Promise(r => setTimeout(r, 1000));
          document.querySelector('#btn-pet-memory-refresh')?.click();
          await new Promise(r => setTimeout(r, 500));
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          // 滚到「大小」那一块：滑块 + 紧跟其后的「空闲小动作」三个勾要一起入镜
          //（只建空目录是认不到的，所以这里顺带确认下拉里不是「（没找到任何形象）」）
          document.querySelector('#s-pet-scale-field')?.scrollIntoView({ block: 'start' });
          await new Promise(r => setTimeout(r, 300));`,
        // 外观那一组（2026-10-12 深夜从顶栏弹窗搬进了设置页）：
        // 主题配色 + 明暗 + 聊天区那几样都在这里，
        // 布局（色点会不会换行、分段按钮会不会被 grid 拉满）得靠图看。
        appearance: `
          document.querySelector('#btn-account-open-settings')?.click();
          await new Promise(r => setTimeout(r, 700));
          document.querySelector('.settings-nav-item[data-target="sec-appearance"]')?.click();
          await new Promise(r => setTimeout(r, 300));`,
        // 世界书编辑器的左栏：封面块在最上面（书的脸），下面才是书名 / 开场白 / 本书角色。
        // 打开一本**带封面的**，否则看到的还是空框。
        worldbookEditor: `
          const t = document.querySelector('#toast');
          if (t) { t.classList.add('hidden'); t.textContent = ''; }
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          // 世界书没有列表页了：从角色的「自带世界书」进
          $('#btn-chars')?.click(); await nap(400);
          const wbCard = $$('#char-page-grid .char-card').find(c => c.textContent.includes('自带世界书测试')) || $$('#char-page-grid .char-card')[0];
          const wbEditBtn = wbCard && Array.from(wbCard.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbEditBtn) wbEditBtn.click();
          await nap(550);
          $('#char-section-tab-worldbook')?.click(); await nap(250);
          if (!$$('#c-wb-list .cwb-row').length) {
            // 绑定入口撤了（2026-10-26）：卡上没书就现场新建一本，建完直接进编辑器
            $('#c-wb-new-btn')?.click(); await nap(800);
          }
          const line = $$('#c-wb-list .cwb-row')[0];
          const go = line && Array.from(line.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (go) go.click();
          await nap(700);
          // 进编辑器就落在「条目」屏（设置屏撤了），不用再切
          await new Promise(r => setTimeout(r, 300));`,
        // 角色卡编辑页的「人物列表」：动作行 + 卡片网格 / 空态引导卡。
        // （世界书编辑器里的「本书角色」屏已撤，这里只留角色卡这一侧的入口。）
        wbChars: `
          const t = document.querySelector('#toast');
          if (t) { t.classList.add('hidden'); t.textContent = ''; }
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click(); await nap(400);
          const wbCard = $$('#char-page-grid .char-card').find(c => c.textContent.includes('自带世界书测试')) || $$('#char-page-grid .char-card')[0];
          const wbEditBtn = wbCard && Array.from(wbCard.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbEditBtn) wbEditBtn.click();
          await nap(550);
          $('#char-section-tab-roles')?.click();
          await nap(350);
          if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 本书角色编辑页（worldbook → 本书角色 → 编辑）：和角色卡编辑页是两套页面，
        // 出图用来核对左栏四个分区 / 底栏四颗按钮 / 单栏写作纸（没有右栏目录）。
        bookCharEditor: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click(); await nap(400);
          const card = $$('#char-page-grid .char-card').find(c => c.textContent.includes('自带世界书测试')) || $$('#char-page-grid .char-card')[0];
          const editBtn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (editBtn) editBtn.click();
          await nap(550);
          $('#char-section-tab-roles')?.click(); await nap(250);
          const copy = $$('#char-book-roles .char-card')[0];
          if (copy) {
            const open = Array.from(copy.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
            if (open) open.click();
          } else {
            $('#btn-char-roles-new')?.click();
          }
          await nap(700);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        panel: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          // 找「状态卡入口条上有多个头像」的会话（多人才看得出这一条的意义）
          for (const it of $$('#convo-list .convo-item')) {
            it.click();
            await new Promise(r => setTimeout(r, 500));
            if ($$('#panel-cast .panel-avatar').length > 1) break;
          }
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 输入框左边的快捷短语面板展开的样子（行距 / 括注颜色 / 面板与输入框的间距）
        quickPhrases: `
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          document.querySelector('#btn-quick')?.click();
          await new Promise(r => setTimeout(r, 350));`,
        // 顶栏「切换模型」弹层展开的样子（自绘列表，不是系统菜单那种直角 + 系统蓝）
        modelMenu: `
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          document.querySelector('#model-switch')?.click();
          await new Promise(r => setTimeout(r, 350));`,
        // 顶栏「⋯」展开的样子（记忆 / 复制全文 / 导出 / 清空对话 收在里面）
        moreMenu: `
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          document.querySelector('#btn-more')?.click();
          await new Promise(r => setTimeout(r, 350));`,
        // 顶栏（2026-09-30）：顶栏头像 + 视角胶囊。
        // 角色卡开局（GM 局）之后，头像走「绑了角色」那一支。
        // （原来这里找的是「没绑卡、绑了书」的世界会话；那条入口已并进「对话」，
        //  现在所有开局会话都绑着卡 —— 找一条头像不是中性点的即可。）
        topbarBook: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          for (const it of $$('#convo-list .convo-item')) {
            it.click();
            await new Promise(r => setTimeout(r, 450));
            const av = $('#topbar-avatar');
            if (av && !av.classList.contains('plain')) break;
          }
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        chars: `
          document.querySelector('#btn-chars')?.click();
          await new Promise(r => setTimeout(r, 500));`,
        // 「你是谁」弹窗里的开场白选择区：卡带**两条以上**才出现，挑中的那条才是会话开头。
        // 种子卡只有一条，所以这里先塞两条进去（走真模块 + 落盘，和真实数据同一条路）。
        // 要看的是「一屏装不装得下」：列表自己有 216px 上限，加上 7 行设定别把弹窗撑破。
        playerModal: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click(); await nap(500);

          const card = $$('#char-page-grid .char-card')
            .find(c => ((c.querySelector('.char-card-name') || {}).textContent || '').trim() === '属性测试角色');
          const stateMod = await import(new URL('js/core/state.js', document.baseURI).href);
          const persistMod = await import(new URL('js/data/persist.js', document.baseURI).href);
          const target = (stateMod.state.characters || []).find(c => c.name === '属性测试角色');
          if (target) {
            target.alternateGreetings = [
              '第二条：雨停之后，镇口的告示换了一张，墨迹还没干透。',
              '第三条：你在图书馆的地下室里醒过来，桌上那盏油灯快烧完了。'
            ];
            await persistMod.persistLibrary();
          }
          const go = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '对话');
          if (go) { go.click(); await nap(700); }`,
        // 角色卡：卡片上铺的是**角色形象**（2:3 竖版立绘），点开还能看大图。
        // 测试里的角色都没有图（上传那条路被 images:pick 的桩挡着），
        // 所以这里给每张卡塞一个 2:3 的 SVG 占位立绘 —— 只为看清裁切和排版；
        // 上传那条**真路径**在「角色：头像和形象是两张图」场景里（走 ui/imageCrop.js）。
        charArt: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const art = (hue, label) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450">' +
            '<rect width="300" height="450" fill="hsl(' + hue + ',70%,90%)"/>' +
            '<circle cx="150" cy="144" r="60" fill="hsl(' + hue + ',55%,68%)"/>' +
            '<path d="M42 450c0-92 48-151 108-151s108 59 108 151z" fill="hsl(' + hue + ',55%,68%)"/>' +
            '<text x="150" y="434" font-size="24" text-anchor="middle" fill="hsl(' + hue + ',50%,36%)">' + label + '</text>' +
            '</svg>');

          $('#btn-chars')?.click();
          await nap(550);
          $$('#char-page-grid .char-card').forEach((card, i) => {
            const face = card.querySelector('.char-card-avatar');
            if (!face || face.querySelector('img')) return;
            const name = card.querySelector('.char-card-name');
            face.innerHTML = '';
            const img = document.createElement('img');
            img.alt = '';
            img.src = art((i * 71 + 335) % 360, (name ? name.textContent : '角色').slice(0, 2));
            face.appendChild(img);
          });
          await nap(250);
          // 删除 × 平时是 opacity:0、悬停才浮出来 —— 截图没有指针，
          // 这里拨上去只为核对它压在人设图上够不够清楚（不动生产样式）。
          const del = $('#char-page-grid .char-card .char-card-del');
          if (del) del.style.opacity = '1';
          await nap(150);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 看大图浮层（ui/lightbox.js）：遮罩 + 底部工具条。
        // 测试里的角色没有形象（上传那条路被 images:pick 的桩挡着），所以这里
        // 直接调浮层模块递一张占位立绘进去 —— 出图只为核对工具条的排版和字号，
        // 真实入口（点卡片上的形象）在「看图：灯箱缩放与关闭」和宿主侧的真实鼠标探针里。
        lightbox: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const art = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">' +
            '<rect width="300" height="450" fill="hsl(335,70%,90%)"/>' +
            '<circle cx="150" cy="144" r="60" fill="hsl(335,55%,68%)"/>' +
            '<path d="M42 450c0-92 48-151 108-151s108 59 108 151z" fill="hsl(335,55%,68%)"/>' +
            '<text x="150" y="434" font-size="24" text-anchor="middle" fill="hsl(335,50%,36%)">示例角色</text>' +
            '</svg>');
          const mod = await import(new URL('js/ui/lightbox.js', document.baseURI).href);
          mod.openLightbox(art, { title: '示例角色' });
          await nap(450);
          // 放大两档：让工具条上的百分比不是 100%，一眼能看出缩放是活的
          $('#lightbox-in')?.click();
          $('#lightbox-in')?.click();
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 世界书编辑器：列表页 → 第一本书的「编辑」。
        // 这个弹窗是「左栏书名 + 本书角色 + 开场白 + 条目列表 / 右栏条目表单」，
        // 栏宽、间距、「内容」框和底部按钮的位置只有截图能核对。
        // 最后在内容框上派一次 input（内容一个字没改）—— 让底部那颗
        // 「有未保存的改动」也进画面，否则那条状态永远没人看过。
        worldbook: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          // 世界书没有列表页：从角色的「自带世界书」进
          $('#btn-chars')?.click(); await nap(400);
          const wbCard = $$('#char-page-grid .char-card').find(c => c.textContent.includes('自带世界书测试')) || $$('#char-page-grid .char-card')[0];
          const wbEditBtn = wbCard && Array.from(wbCard.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbEditBtn) wbEditBtn.click();
          await nap(550);
          $('#char-section-tab-worldbook')?.click(); await nap(250);
          if (!$$('#c-wb-list .cwb-row').length) {
            // 绑定入口撤了（2026-10-26）：卡上没书就现场新建一本，建完直接进编辑器
            $('#c-wb-new-btn')?.click(); await nap(800);
          }
          const wbLine = $$('#c-wb-list .cwb-row')[0];
          const wbGo = wbLine && Array.from(wbLine.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbGo) wbGo.click();
          await nap(700);
          $('#wb-e-content')?.dispatchEvent(new Event('input', { bubbles: true }));
          await nap(200);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 预设列表页（卡片 + 右上角删除 ×）与预设编辑器（字段一列、采样参数折叠区）
        presets: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-presets')?.click();
          await nap(500);
          const card = $$('#preset-page-grid .preset-row')[0];
          const del = card && card.querySelector('.char-card-del');
          if (del) del.style.opacity = '1';
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        presetEditor: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-presets')?.click();
          await nap(500);
          const card = $$('#preset-page-grid .preset-row')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(650);
          // 把采样参数那块展开：折叠着的话这块样式永远没人看过
          const det = $('#preset-modal details.preset-sampling');
          if (det) det.open = true;
          await nap(200);
          // 在正文框上派一次 input（内容一个字没改）—— 让底部那颗「有未保存的改动」也进画面
          $('#pr-content')?.dispatchEvent(new Event('input', { bubbles: true }));
          await nap(200);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 视角弹窗里的预设勾选列表（多选 + 「可全局」徽标 + 底部状态说明）。
        // 这一块是纯排版（行高、勾选框对齐、徽标位置、列表的滚动边界），
        // 断言只能验「勾没勾」，看不出「挤不挤」。
        presetPick: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-perspective')?.click();
          await nap(600);
          // 弹窗没开（比如种子数据里没有会话）就自己造一场，别出一张空白图
          if (!$('#perspective-modal') || $('#perspective-modal').classList.contains('hidden')) {
            const first = $$('#char-page-grid .char-card')[0]
              || (() => { $('#btn-chars')?.click(); return null; })();
            await nap(400);
            const card = $$('#char-page-grid .char-card')[0];
            const chat = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '对话');
            if (chat) chat.click();
            await nap(600);
            $('#btn-perspective')?.click();
            await nap(500);
          }
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          await nap(150);`,
        // 生成参数：在**设置页**（左导航「生成参数」）。⚠️ 别按老代码再找「⋯ 菜单 → 生成参数」
        // 或右栏页签 —— 那一套已经下线了，选择器不存在时出图是静默退化的（截当前屏，不报错）。
        // 这张图要看的：四格里数字框的尺寸、勾选框和数字框混排时的行对齐。
        genParams: `
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          // ⚠️ 别再找 #btn-gen-params —— 右栏那套「生成参数页签」已经下线了（点它是空操作，
          //    出图会悄悄退化成「原样截当前屏」）。现在唯一的入口是设置页左导航。
          $('#btn-account-open-settings')?.click();
          await nap(400);
          $('[data-target="sec-params"]')?.click();
          await nap(350);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 剧情选项：整条测试跑完正好停在场景 21 的会话里（最新回复带选项），
        // 这里只需要确认在聊天视图、把 toast 收掉，就能截到「消息下面的选项块」。
        msgOptions: `
          const t = document.querySelector('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }
          await new Promise(r => setTimeout(r, 300));`,
        // 聊天主页：消息流本体 —— 消息头（角色名 / 模型牌 / 时间）、通栏正文、方角头像、
        // 心理 / 旁白那两根 2px 竖条，还有最要紧的「用户侧右对齐」。
        // ⚠️ 现有 driver 几乎全是弹层，消息区只有这里能系统性地看到。去气泡改造后
        // 「左右还分不分得清」「多行正文的换行位置对不对」是**只有肉眼能判**的，
        // 所以这个场景必须自己开一个会话（--shot-only 不跑断言，不会替你建会话）。
        // 账号弹窗 · 登录面板：邮箱 / 密码 / 校验码三行 + 底部两个入口的版式，
        // 还有那张 SVG 校验码在深色底上到底认不认得出来 —— 只有出图能核。
        account: `
          document.querySelector('#btn-account')?.click();
          await new Promise(r => setTimeout(r, 800));`,
        // 账号弹窗 · 已登录面板：一路注册到底，看凭证卡预览长什么样。
        // ⚠️ 这段是模板字符串：注释里不能有反引号，正则里的反斜杠要写两条。
        // ⚠️ 它会真的往冒烟数据目录写一个账号（邮箱带时间戳，不撞）——
        //    冒烟场景开头会先退出登录，所以不会影响断言。
        // 账号弹窗 · 已登录之后：走菜单进「设置 → 用户信息」，顺便看凭证卡在设置页里的样子。
        // ⚠️ 这段是模板字符串：注释里不能有反引号，正则里的反斜杠要写两条。
        // ⚠️ 它会真的往冒烟数据目录写一个账号（邮箱带时间戳，不撞）——
        //    冒烟场景开头会先退出登录，所以不会影响断言。
        accountMe: `
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fill = (sel, v) => { const n = $(sel); if (n) n.value = v; };
          const loggedIn = () => /@/.test(($('#account-sub') || {}).textContent || '');

          if (loggedIn()) {
            $('#btn-account')?.click();
            await nap(400);
            $('#btn-account-menu-logout')?.click();
            await nap(700);
          }
          $('#btn-account')?.click();
          await nap(700);
          $('#btn-goto-register')?.click();
          await nap(800);
          fill('#acc-reg-email', 'shot' + Date.now() + '@example.com');
          fill('#acc-reg-captcha', $('#acc-reg-captcha')?.dataset.answer || '');
          $('#btn-account-send-code')?.click();
          await nap(1000);
          const hint = $('#acc-reg-hint')?.textContent || '';
          fill('#acc-reg-code', (hint.match(/(\\d{6})/) || [])[1] || '');
          $('#btn-account-register-next')?.click();
          await nap(800);
          fill('#acc-setup-name', '星宝');
          fill('#acc-setup-password', 'mimitale2026');
          fill('#acc-setup-password2', 'mimitale2026');
          $('#btn-account-finish')?.click();
          await nap(1400);
          // 走菜单进设置页的用户信息
          $('#btn-account')?.click();
          await nap(400);
          $('#btn-account-open-settings')?.click();
          await nap(1600);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 左下角账号菜单本身（登录后点账号格弹出来的那层）
        accountMenu: `
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fill = (sel, v) => { const n = $(sel); if (n) n.value = v; };
          const loggedIn = () => /@/.test(($('#account-sub') || {}).textContent || '');

          if (!loggedIn()) {
            $('#btn-account')?.click();
            await nap(700);
            $('#btn-goto-register')?.click();
            await nap(800);
            fill('#acc-reg-email', 'shot' + Date.now() + '@example.com');
            fill('#acc-reg-captcha', $('#acc-reg-captcha')?.dataset.answer || '');
            $('#btn-account-send-code')?.click();
            await nap(1000);
            const hint = $('#acc-reg-hint')?.textContent || '';
            fill('#acc-reg-code', (hint.match(/(\\d{6})/) || [])[1] || '');
            $('#btn-account-register-next')?.click();
            await nap(800);
            fill('#acc-setup-name', '星宝');
            fill('#acc-setup-password', 'mimitale2026');
            fill('#acc-setup-password2', 'mimitale2026');
            $('#btn-account-finish')?.click();
            await nap(1400);
          }
          $('#btn-account')?.click();
          await nap(500);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 凭证登录面板：要看的是「手输码 / 或者 / 导入凭证图片」这三段的间距
        // 和那颗 ghost 按钮的观感 —— DOM 断言只能说它们在，看着舒不舒服只有图能核。
        accountVoucher: `
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const loggedIn = () => /@/.test(($('#account-sub') || {}).textContent || '');

          if (loggedIn()) {
            $('#btn-account')?.click();
            await nap(400);
            $('#btn-account-menu-logout')?.click();
            await nap(700);
          }
          $('#btn-account')?.click();
          await nap(700);
          $('#btn-goto-voucher')?.click();
          await nap(600);
          const code = $('#acc-voucher-code');
          if (code) { code.value = 'ABCD-EFGH-JKMN'; code.dispatchEvent(new Event('input', { bubbles: true })); }
          await nap(200);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        chat: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const go = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '对话');
          if (go) { go.click(); await nap(700); }

          // 第一次开这个角色的会话会先弹「创建你的角色」。⚠️ 要点「开始对话」
          // （btn-start-play）**进会话** —— 点「取消」等于放弃这次聊天，
          // 视图会退角色卡，截出来就是一张角色卡图（踩过）。
          // ⚠️ 这个 driver 整段是**模板字符串**：注释里千万别写反引号，
          //    一个就把字符串提前闭合了，报「Unexpected identifier」。
          //    要找元素就写纯文字名字，别写 CSS 选择器的引号形式。
          if (!$('#player-modal')?.classList.contains('hidden')) {
            $('#btn-start-play')?.click();
            await nap(600);
          }

          const send = async (text) => {
            const input = $('#input');
            if (!input) return;
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            $('#btn-send')?.click();
            await nap(2600);
          };

          // 第一轮：一句够长的正文 —— 看用户侧右对齐之后多行怎么折
          await send('这一句故意写得长一点，用来核对用户消息右对齐之后，多行正文的换行位置是不是还正常。');

          // 第二轮：带「心理」触发假后端补上【心理】/【旁白】两段，好核对那两根竖条
          await send('再说说它心里在想什么，我要看心理描写。');

          // 想让图里顺带报一下「分隔 / 消息 / 抓手」三个数？在 URL 上加 #probe。
          // 为什么要有它：日期分隔和两侧抓手都很小，消息一多分隔还会被滚到可视区外，
          // 光看缩略图分不清「没渲染」和「滚上去了」（2026-10-12 就误判过一次）。
          // ⚠️ 这整段在一个**模板字符串**里：反引号会把字符串提前闭合、
          //    美元花括号会被当成插值 —— 要拼字符串就用加号。
          if (location.hash === '#probe') {
            const sep = document.querySelectorAll('.msg-date-sep').length;
            const msg = document.querySelectorAll('.msg').length;
            const handle = document.querySelectorAll('.pad-handle').length;
            const hint = $('#hint-text');
            if (hint) hint.textContent = '分隔 ' + sep + ' / 消息 ' + msg + ' / 抓手 ' + handle;
          }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 消息导航条（右缘轮次刻度，对齐 DSH 的 turn rail）：普通截图里只有一排细条，
        // 「当前那根更长更实」「悬停卡片长什么样」光看断言没用 —— 所以这里发三轮，
        // 再手动触发一次 pointerover 把卡片钉在屏幕上（截图里没有鼠标）。
        // ⚠️ 模板字符串：注释里不能有反引号，也不能有美元花括号。
        msgNav: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const go = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '对话');
          if (go) { go.click(); await nap(700); }
          if (!$('#player-modal')?.classList.contains('hidden')) {
            $('#btn-start-play')?.click();
            await nap(600);
          }

          const send = async (text) => {
            const input = $('#input');
            if (!input) return;
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            $('#btn-send')?.click();
            await nap(2400);
          };
          await send('第一轮：导航条要两根以上刻度才出现。');
          await send('第二轮：现在能看出等距的刻度和「当前这一轮」了。');
          await send('第三轮：这一句写长一点，好看清悬停卡片里那句摘要怎么截。');

          // 悬停卡片：手动派一个 pointerover，卡片会一直留在图上（没有真实指针去移开它）
          const marks = $$('#msg-rail .msg-rail-mark');
          if (marks.length > 1) {
            marks[1].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            await nap(400);
          }
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 收起态的**图标轨**（设计稿屏 2）：点一下收起按钮，然后拍左栏那 52px。
        // ⚠️ 这个场景是 2026-10-12 晚补的 —— 那之前收起态是一条**空条**
        //    （`> *:not(.sidebar-toggle){display:none}`），稿子那里却是一整列图标；
        //    没有这个 driver，「图标轨到底长出来没有」只能靠 DOM 断言猜。
        // ⚠️ 模板字符串：注释里不能有反引号，也不能有美元花括号。
        rail: `
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-sidebar-toggle')?.click();
          await nap(400);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 消息工具条：它为**悬停**服务，平时是 opacity: 0 —— 不强制显形的话，
        // 任何一张普通截图里它都是空的，「8 颗收成 3 颗 + ⋯」之后长什么样只能靠断言猜。
        // 所以这里先塞一条 style 把它钉成可见，再发两轮：第 1 条留**收起态**、
        // 点开第 2 条的「⋯」—— 一张图里同时能看到两种状态。
        // ⚠️ 模板字符串：注释里不能有反引号，也不能有美元花括号。
        msgActions: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const go = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '对话');
          if (go) { go.click(); await nap(700); }
          if (!$('#player-modal')?.classList.contains('hidden')) {
            $('#btn-start-play')?.click();
            await nap(600);
          }

          const send = async (text) => {
            const input = $('#input');
            if (!input) return;
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            $('#btn-send')?.click();
            await nap(2600);
          };
          await send('第一条：这一条留收起态，看常用的那三颗 + ⋯。');
          await send('第二条：这一条点开 ⋯，看多出来的那几颗换行换得整不整齐。');

          // ⚠️ 用**行内样式**而不是注入 style 标签：这套应用是 CSP default-src none，
          //    插进来的 style 元素会被直接丢掉（第一版就是这么白跑的，还看不到任何报错）。
          //    el.style 走 CSSOM，不受 style-src 管。
          $$('.msg-actions').forEach(el => { el.style.opacity = '1'; });

          const last = $$('#messages .msg.assistant').pop();
          const more = last ? last.querySelector('.msg-actions .mini-more') : null;
          if (more) more.click();
          await nap(250);

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 角色编辑器：点左栏上传框会走真实的 shrinkAvatar → 落盘那条路
        // （images:pick 的桩给的是 1×1 PNG，裁完是一片纯色 —— 看不出裁切效果）。
        // 所以出图时直接往两个上传框里各塞一张 SVG 占位图，只为核对框子比例：
        // 头像是 1:1 圆，形象是 2:3 竖版。
        charEditor: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click();
          await nap(400);
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(600);

          const fill = (sel, w, h) => {
            const box = $(sel);
            if (!box || box.querySelector('img')) return;
            box.innerHTML = '';
            const img = document.createElement('img');
            img.alt = '';
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '">' +
              '<rect width="' + w + '" height="' + h + '" fill="hsl(335,70%,90%)"/>' +
              '<circle cx="' + (w / 2) + '" cy="' + (h * 0.32) + '" r="' + (w * 0.2) + '" fill="hsl(335,55%,68%)"/>' +
              '<path d="M' + (w * 0.14) + ' ' + h + 'c0-' + (h * 0.2) + ' ' + (w * 0.16) + '-' + (h * 0.33) + ' ' + (w * 0.36) + '-' + (h * 0.33) +
              's' + (w * 0.36) + ' ' + (h * 0.13) + ' ' + (w * 0.36) + ' ' + (h * 0.33) + 'z" fill="hsl(335,55%,68%)"/>' +
              '</svg>');
            box.appendChild(img);
          };
          fill('#char-avatar', 300, 300);    // 头像：1:1
          fill('#char-portrait', 300, 450);  // 形象：2:3
          // 直接塞图绕过了 renderCharMedia，手动把两颗「清除」也露出来 ——
          // 截图要核对的正是它们的尺寸和间距
          $('#btn-clear-avatar')?.classList.remove('hidden');
          $('#btn-clear-portrait')?.classList.remove('hidden');
          await nap(200);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 角色编辑器里「世界书」那一块：一行 = 书名 + 条目数 + 编辑 + 删除 ✕。
        // 2026-10-20 加了「编辑」—— 要核的是这一行没被挤成两行、四样东西的间距还匀。
        charWorldbook: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click();
          await nap(400);
          const cards = $$('#char-page-grid .char-card');
          const card = cards.find(c => (c.textContent || '').includes('自带世界书测试')) || cards[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(600);
          document.querySelector('#char-section-tab-worldbook')?.click();
          await nap(400);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 「AI 补条目」补完之后的形态（2026-10-26 从角色编辑器搬到世界书编辑页）：
        // 补出来的条目直接进左栏列表，状态行说明「点保存才写进磁盘」。
        wbAi: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click(); await nap(400);
          const wbCard = $$('#char-page-grid .char-card').find(c => c.textContent.includes('自带世界书测试')) || $$('#char-page-grid .char-card')[0];
          const wbEditBtn = wbCard && Array.from(wbCard.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbEditBtn) wbEditBtn.click();
          await nap(550);
          $('#char-section-tab-worldbook')?.click(); await nap(250);
          const wbLine = $$('#c-wb-list .cwb-row')[0];
          const wbGo = wbLine && Array.from(wbLine.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbGo) wbGo.click();
          await nap(700);
          $('#btn-wb-ai')?.click();
          await nap(1500);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 按钮的 loading 态（2026-10-20）：转圈圈 + 文案 + 变灰，核的是圈圈大小 / 和文字的距离。
        // 真跑一次生成太快抓不稳这一帧，所以直接给按钮置位（和 aiGen 里点完「开始生成」同一形状）。
        btnLoading: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click();
          await nap(450);
          const pair = [$('#btn-import-card'), $('#btn-new-char')];
          if (pair[0]) { pair[0].loading = true; pair[0].textContent = '导入中…'; }
          if (pair[1]) { pair[1].loading = true; pair[1].textContent = '生成中…'; }
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 角色编辑页（视图七）：整个主区域就是表单。
        // ⚠️ 2026-10-13 起它是**页面**不再是弹窗，所以这里没有「点放大」那一步 ——
        //    要看的正是「它本来就铺满主区域」这件事（页头 / 滚动区 / 页脚三段）。
        charEditorPage: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click();
          await nap(400);
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(600);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 角色编辑页 · 开场白分区：这一区比「角色卡设定」多了模板条和备选列表，
        // 三张卡各带一条折叠说明 —— 调这一区块的视觉时专门看它。
        charOpening: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-chars')?.click();
          await nap(400);
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(700);
          $('#char-section-tab-opening')?.click();
          await nap(300);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 世界书编辑页（视图八）：左条目列表 / 右条目编辑，两栏各自铺满这一屏的高度。
        // 同样不再有「放大」那一步 —— 它自己就占满主区域。
        wbEditorPage: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          // 世界书没有列表页：从角色的「自带世界书」进
          $('#btn-chars')?.click(); await nap(400);
          const wbCard = $$('#char-page-grid .char-card').find(c => c.textContent.includes('自带世界书测试')) || $$('#char-page-grid .char-card')[0];
          const wbEditBtn = wbCard && Array.from(wbCard.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbEditBtn) wbEditBtn.click();
          await nap(550);
          $('#char-section-tab-worldbook')?.click(); await nap(250);
          if (!$$('#c-wb-list .cwb-row').length) {
            // 绑定入口撤了（2026-10-26）：卡上没书就现场新建一本，建完直接进编辑器
            $('#c-wb-new-btn')?.click(); await nap(800);
          }
          const wbLine = $$('#c-wb-list .cwb-row')[0];
          const wbGo = wbLine && Array.from(wbLine.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (wbGo) wbGo.click();
          await nap(700);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 同上，换成预设编辑器 —— 它的卡片是 `width: min(720px, 94vw)`，
        // 「放大宽度没铺满」就是这么来的，单独留一张盯着宽度。
        modalMaxPreset: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          $('#btn-presets')?.click();
          await nap(500);
          const card = $$('#preset-page-grid .preset-row')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(650);
          $('#btn-fs-preset')?.click();
          await nap(400);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 属性区的分组标签栏：新建一张卡，按真实交互铺出几个分组再截图 ——
        // 空卡只有一个「未分组」标签，看不出分层的样子。
        charAttrs: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '分组示例'; fire(nameBox, 'input'); }

          const addTo = async (group, label, value) => {
            if (group) {
              const tabNew = $('#c-attr-tabs .attr-tab-new');
              tabNew.value = group;
              tabNew.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await nap(120);
            }
            const input = $('#c-attr-new');
            input.value = label;
            $('#btn-add-attr').click();
            await nap(120);
            const row = $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);
            if (row && value) { const v = row.querySelector('.attr-value'); v.value = value; fire(v, 'input'); }
          };

          await addTo('关系', '好感度', '20');
          await addTo('关系', '信任度', '0');
          await addTo('关系', '亲密度', '0');
          await addTo('背包', '金币', '9900');
          await addTo('背包', '道具', '钥匙、手电筒');
          await addTo('状态', '心情', '平静');
          await addTo('状态', '体温', '36.5');

          const rel = $$('#c-attr-tabs .attr-tab').find(b => b.textContent.startsWith('关系'));
          if (rel) rel.click();
          await nap(250);
          const tabs = $('#c-attr-tabs');
          if (tabs) tabs.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 属性展开「更多」面板：更新频率下拉 / 分组 / 变化规则，只有截图能确认
        // 标签文案改长后会不会被截、下拉能不能正常展开。
        charAttrsMore: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '更新频率示例'; fire(nameBox, 'input'); }

          // 加一条属性，再点它的「更多」展开
          const input = $('#c-attr-new');
          input.value = '好感度';
          $('#btn-add-attr').click();
          await nap(150);

          const row = $$('#c-attr-list .attr-row')[0];
          const more = row && Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === '更多');
          if (more) more.click();
          await nap(250);

          // 把「更多」面板滚到视野里
          const morePanel = row && row.querySelector('.attr-more');
          if (morePanel) morePanel.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 长文本框：自动增高 + 右下角拖拽把手。
        // 这两件事全是**纯视觉**的 —— DOM 断言只能说「高度变了」，
        // 说不清把手看不看得见、长高之后上下留白对不对。
        // 故意做成两种内容并存好一次看完：
        //   · 「角色描述」留短内容 → 展示短内容不占地方（停在下限）
        //   · 「示例对话」填一长段 → 展示自动增高（应该明显高于其他框）
        charTextareas: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(600);

          const setVal = (node, v) => { if (!node) return; node.value = v; fire(node, 'input'); };

          // 短内容（自动增高应当停在下限附近）
          setVal($('#c-desc'), '一个爱在图书馆泡到闭馆的中文系女生。');
          // 长内容（应当长高，但不该顶爆表单 —— 有 GROW_MAX 兜着）
          setVal($('#c-example'), [
            '{{user}}：这么晚了还不回去？',
            '{{char}}：……还差两页。你先走吧。',
            '',
            '{{user}}：我看你昨天也没去食堂。',
            '{{char}}：（把书往怀里按了按）不饿。',
            '',
            '{{user}}：这本书你借了三次了吧？',
            '{{char}}：……第四次。图书馆要罚款的。'
          ].join('\\n'));

          // 焦点落到「示例对话」自己身上再滚过去 —— 让长高的那个框连同
          // 右下角的把手一起进画面（不要在别的框上留焦点，
          // 免得让人误以为「其他框被压扁了」）。
          const example = $('#c-example');
          if (example) example.focus();
          await nap(300);

          const desc = $('#c-desc');
          if (desc) desc.scrollIntoView({ block: 'start' });
          await nap(300);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 长描述塞满文本框：框**不会**跟着长高，多出来的字在框里滚 ——
        // 这个「矮框 + 框内滚动」的观感只有截图能看出来。
        // ⚠️ 2026-10-16（V2 重组版）起，角色编辑页五个框的高度是 style.css 里
        //    `#c-desc{min-height:264px}` 那五行按字段写死的，不再走 GROW_MAX。
        // 2026-10-16：原来这里点 ↗ 弹放大浮层看浮层的排版，浮层撤了，改成直接看矮框。
        charDescFull: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          const card = $$('#char-page-grid .char-card')[0];
          const btn = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (btn) btn.click();
          await nap(600);

          const desc = $('#c-desc');
          if (desc) {
            desc.value = Array.from({ length: 26 }, (_, i) =>
              '第' + (i + 1) + '段：她总在闭馆前十分钟才把书放回原位，指尖压着书脊，像怕惊动谁。'
            ).join('\\n');
            fire(desc, 'input');
          }
          await nap(200);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 同上，但停在**空分组**上 —— 空态文案、计数徽标上的 0、
        // 以及「卡身只剩一行提示」时的留白，只有截图能看出好不好看。
        charAttrsEmpty: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '空分组示例'; fire(nameBox, 'input'); }

          const addTo = async (group, label, value) => {
            if (group) {
              const tabNew = $('#c-attr-tabs .attr-tab-new');
              tabNew.value = group;
              tabNew.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              await nap(120);
            }
            const input = $('#c-attr-new');
            input.value = label;
            $('#btn-add-attr').click();
            await nap(120);
            const row = $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);
            if (row && value) { const v = row.querySelector('.attr-value'); v.value = value; fire(v, 'input'); }
          };

          await addTo('关系', '好感度', '20');
          await addTo('关系', '信任度', '0');
          await addTo('关系', '亲密度', '0');
          // 建一个空分组并切过去（不加任何字段）
          const tabNew = $('#c-attr-tabs .attr-tab-new');
          tabNew.value = '背包';
          tabNew.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await nap(250);

          const tabs = $('#c-attr-tabs');
          if (tabs) tabs.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 分组操作条（改名 / 解散）：从「⋯」点开的状态。
        // 这个小面板的间距、按钮配色只有截图能核对。
        charGroupEdit: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '分组管理示例'; fire(nameBox, 'input'); }

          const newGroup = async (name) => {
            const box = $('#c-attr-tabs .attr-tab-new');
            box.value = name;
            box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await nap(140);
          };
          const addAttr = async (label, value) => {
            const input = $('#c-attr-new');
            input.value = label;
            $('#btn-add-attr').click();
            await nap(140);
            const row = $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);
            if (row && value) { const v = row.querySelector('.attr-value'); v.value = value; fire(v, 'input'); }
          };

          await newGroup('关系');
          await addAttr('好感度', '20');
          await addAttr('信任度', '0');
          await newGroup('背包');
          await addAttr('金币', '9900');
          await newGroup('状态');

          // 停在「状态」上，把操作条点开
          const stateTab = $$('#c-attr-tabs .attr-tab').find(b => b.textContent.startsWith('状态'));
          if (stateTab) stateTab.click();
          await nap(200);
          $('#c-attr-tabs .attr-tab-edit')?.click();
          await nap(250);

          const tabs = $('#c-attr-tabs');
          if (tabs) tabs.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 「更多」里的分组行：下拉态 + 「＋ 新建分组…」的临时输入框态。
        // 两种形态排在一起才看得出高度对不对齐（这一行最容易和上面
        // 「数值范围」那条错位）。
        charGroupMove: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));
          const fire = (node, type) => node.dispatchEvent(new Event(type, { bubbles: true }));

          document.querySelector('#btn-chars')?.click();
          await nap(400);
          document.querySelector('#btn-new-char')?.click();
          await nap(500);

          const nameBox = $('#c-name');
          if (nameBox) { nameBox.value = '分组搬运示例'; fire(nameBox, 'input'); }

          const newGroup = async (name) => {
            const box = $('#c-attr-tabs .attr-tab-new');
            box.value = name;
            box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await nap(140);
          };
          const clickTab = async (prefix) => {
            const tab = $$('#c-attr-tabs .attr-tab').find(b => b.textContent.startsWith(prefix));
            if (tab) tab.click();
            await nap(160);
          };
          const addAttr = async (label, value) => {
            const input = $('#c-attr-new');
            input.value = label;
            $('#btn-add-attr').click();
            await nap(140);
            const row = $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);
            if (row && value) { const v = row.querySelector('.attr-value'); v.value = value; fire(v, 'input'); }
          };
          const rowOf = (label) => $$('#c-attr-list .attr-row').find(r => r.querySelector('.attr-name').textContent === label);

          // ⚠️ 顺序有讲究：**先**往「未分组」里加两个（新卡默认就停在那一桶），
          // **再**建「关系」并往里加 —— 反过来的话，建组会切走，
          // 而这时「未分组」还不存在（bucketsOf 只在真有零散字段时才铺它），
          // 于是字段会全掉进「关系」，夹具就和场景名对不上了。
          await addAttr('金币', '9900');
          await addAttr('上衣', '布衣');
          await newGroup('关系');
          await addAttr('好感度', '20');
          await clickTab('未分组');

          // 金币这一行：展开「更多」，露出分组下拉
          const coin = rowOf('金币');
          if (coin && !coin.parentElement.querySelector('.attr-more select.attr-group')) coin.querySelector('.attr-more-btn').click();
          await nap(200);

          // 再加一个字段，把它的那一行切到「＋ 新建分组…」的输入框态
          await addAttr('上衣', '布衣');
          const shirt = rowOf('上衣');
          if (shirt && !shirt.parentElement.querySelector('.attr-more select.attr-group')) shirt.querySelector('.attr-more-btn').click();
          await nap(220);
          const shirt2 = rowOf('上衣');
          const sel = shirt2 && shirt2.parentElement.querySelector('.attr-more select.attr-group');
          if (sel) {
            const newOpt = Array.from(sel.options).find(o => o.textContent.includes('新建分组'));
            if (newOpt) { sel.value = newOpt.value; fire(sel, 'change'); }
          }
          await nap(260);

          const panel = $('.attr-panel');
          if (panel) panel.scrollIntoView({ block: 'center' });
          await nap(250);
          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 状态卡（只读态）：点面板栏「我」的头像打开「我的状态」卡。
        // 卡片位置/层级/进度条/文字排版这些都是纯视觉的，DOM 断言看不出来。
        stateCard: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          // 优先「冒烟测试世界」（那里的玩家状态最全），没有就找第一个有头像的会话
          let chosen = $$('#convo-list .convo-item').find(it => {
            const t = it.querySelector('.convo-title');
            return t && t.textContent.trim() === '冒烟测试世界';
          });
          if (!chosen) {
            for (const it of $$('#convo-list .convo-item')) {
              it.click();
              await nap(400);
              if ($$('#panel-cast .panel-avatar').length) { chosen = it; break; }
            }
          }
          if (chosen) { chosen.click(); await nap(500); }

          const avatars = $$('#panel-cast .panel-avatar');
          const mine = avatars.find(b => b.dataset.owner === 'player') || avatars[0];
          if (mine) { mine.click(); await nap(320); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 状态卡（编辑态）：同一张卡点「编辑」之后的样子 —— 值变输入框、
        // 右边出现删除、底部出现「＋ 添加」。输入框的边框/内边距最容易
        // 被通用 input 规则盖掉，必须看真图。
        stateCardEdit: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          let chosen = $$('#convo-list .convo-item').find(it => {
            const t = it.querySelector('.convo-title');
            return t && t.textContent.trim() === '冒烟测试世界';
          });
          if (!chosen) {
            for (const it of $$('#convo-list .convo-item')) {
              it.click();
              await nap(400);
              if ($$('#panel-cast .panel-avatar').length) { chosen = it; break; }
            }
          }
          if (chosen) { chosen.click(); await nap(500); }

          const avatars = $$('#panel-cast .panel-avatar');
          const mine = avatars.find(b => b.dataset.owner === 'player') || avatars[0];
          if (mine) { mine.click(); await nap(320); }

          const eb = $('#state-cards .state-card .sc-edit');
          if (eb) { eb.click(); await nap(360); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 状态卡上的角色图：标题下面横铺一张，右下角是命中的表情名小标签。
        // 走的是**真实路径**（角色卡点「对话」→ 真发一轮 → 点入口条头像），
        // 种子卡的触发词写在假后端每轮回复都带的那句话上，所以必定命中表情甲。
        stateExpr: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const chat = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '对话');
          if (chat) { chat.click(); await nap(700); }

          const input = $('#input');
          if (input) {
            input.value = '你好';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          $('#btn-send')?.click();
          await nap(2400);

          const av = $$('#panel-cast .panel-avatar').find(b => b.dataset.owner !== 'player');
          if (av) { av.click(); await nap(450); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 角色编辑器顶部的图片区：头像 / 形象 + 表情图入口行（表情的编辑在独立弹窗里）
        charExpr: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const edit = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (edit) { edit.click(); await nap(700); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 表情图弹窗：一张卡几十条表情，现在单独一个弹窗编
        //（缩略图 + 名称 + 触发词 + 默认脸 + 删除）
        charExprSection: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          $('#btn-chars')?.click();
          await nap(550);
          const card = $$('#char-page-grid .char-card').find(c => {
            const n = c.querySelector('.char-card-name');
            return n && n.textContent.trim() === '属性测试角色';
          });
          const edit = card && Array.from(card.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑');
          if (edit) { edit.click(); await nap(700); }

          // 表情图现在是分区里的常显内容，切过去就行 —— 没有弹窗要点
          $('#char-section-tab-expressions')?.click();
          await nap(300);

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 状态卡入口条：一行头像（我 / 各角色）。旧面板的收起态已经没有了，
        // 「世界」那个入口也去掉了（无主字段要么并回主角、要么丢掉）。
        panelCast: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          const items = $$('#convo-list .convo-item');
          const target = items.find(it => {
            const t = it.querySelector('.convo-title');
            return t && t.textContent.trim().startsWith('选项测试');
          });
          if (target) { target.click(); await nap(550); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`,
        // 在场角色多开几张：把入口条上的头像**逐个点一遍**，看「同时看多张面板」
        // 到底成不成立（右栏够不够高、展开几张之后会不会把后面的挤没）。
        // 单张卡的形态在 stateCard 场景里已经看过了，这里看的是**多张并存**。
        panelMulti: `
          const $$ = (s) => Array.from(document.querySelectorAll(s));
          const $ = (s) => document.querySelector(s);
          const nap = (ms) => new Promise(r => setTimeout(r, ms));

          // 挑一个在场人数最多的会话
          let best = null, bestN = 0;
          for (const it of $$('#convo-list .convo-item')) {
            it.click();
            await nap(420);
            const n = $$('#panel-cast .panel-avatar').length;
            if (n > bestN) { bestN = n; best = it; }
          }
          if (best) { best.click(); await nap(500); }

          // 逐个点头像 = 逐个打开并展开
          for (const b of $$('#panel-cast .panel-avatar')) { b.click(); await nap(260); }

          const t = $('#toast'); if (t) { t.classList.add('hidden'); t.textContent = ''; }`
      };
      const driver = DRIVERS[shotArg];
      if (!driver) {
        console.log(`  未知截图场景「${shotArg}」，可用：${Object.keys(DRIVERS).join(' / ')}`);
      } else {
        await win.webContents.executeJavaScript(`(async () => { ${driver}\n return true; })()`);
        const panel = process.argv.find((arg) => arg.startsWith('--shot-panel='))?.split('=')[1];
        if (panel) {
          await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(panel)})?.click(); true`);
        }
        await new Promise((r) => setTimeout(r, 700));
        // 出图前把主题和几个关键底色打出来。截图最容易骗人的地方就是
        // 「看着像暗色、其实没切过去」—— 那是白跑一趟，而且会让人照着
        // 一张错图去调配色。这里直接问浏览器要算完的值，比肉眼看可靠。
        const probe = await win.webContents.executeJavaScript(`(() => {
          const bg = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).backgroundColor : '(无)'; };
          const h = (sel) => { const n = document.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().height) : 0; };
          // 「宿主/里层」两段的实高（见下面 desc 那几行的注释）
          const pair = (sel) => {
            const n = document.querySelector(sel);
            if (!n) return '(无)';
            const inner = n.control ? n.control : n;
            return Math.round(n.getBoundingClientRect().height) + '/' + Math.round(inner.getBoundingClientRect().height);
          };
          return {
            theme: document.documentElement.getAttribute('data-theme') || 'light',
            accent: document.documentElement.getAttribute('data-accent') || '(没设)',
            // 出图场景自己量的东西（目前是 selectPop 的下拉几何）
            selProbe: window.__selProbe || null,
            // ⚙ 2026-10-19 内联 svg 收进 ui/icons.js 的注册表之后留下这张网：
            // 「宿主写了 data-icon / 调了 iconHtml，最后却没插进 svg」这类事故肉眼扫不出来
            // （页面不报错、位置也不塌），所以每次出图都数一遍。
            // 「裸svg」是有意为之的 13 个 —— 它们是 JS 里 iconHtml() 的产物，
            // 宿主本身没挂 data-icon（.field-icon / .model-menu-check / .char-section-icon 等），
            // 数目突然变了才需要回头看。
            iconProbe: (() => {
              const list = (s) => Array.from(document.querySelectorAll(s));
              const hosts = list('[data-icon]');
              return {
                带dataIcon: hosts.length,
                没插进svg: hosts.filter((n) => !n.querySelector('svg')).map((n) => n.id || n.getAttribute('data-icon')),
                裸svg: list('svg').filter(
                  (s) => !s.closest('[data-icon]') && !s.classList.contains('icon-expand') && !s.classList.contains('icon-restore')
                ).length,
                svg总数: list('svg').length
              };
            })(),
            // 状态卡 / 世界书工具条那几个控件的实测尺寸（迁移前后对照用）
            cardProbe: (() => {
              const innerOf = (n) =>
                n && typeof n.tagName === 'string' && n.tagName.startsWith('M-') && n.control ? n.control : n;
              const h = (n) => (n ? Math.round(n.getBoundingClientRect().height) : null);
              const w = (n) => (n ? Math.round(n.getBoundingClientRect().width) : null);
              const cs = (n, p) => (n ? getComputedStyle(n)[p] : null);
              const sc = document.querySelector('.state-card .sc-input');
              const search = document.querySelector('#wb-search');
              const state = document.querySelector('.wb-state');
              if (!sc && !search) return null;
              return {
                状态卡输入框: sc
                  ? {
                      宿主: h(sc),
                      里层: h(innerOf(sc)),
                      宽: w(sc),
                      字号: cs(innerOf(sc), 'fontSize'),
                      底色: cs(innerOf(sc), 'backgroundColor')
                    }
                  : null,
                世界书搜索: search
                  ? {
                      宿主: h(search),
                      里层: h(innerOf(search)),
                      宽: w(search),
                      字号: cs(innerOf(search), 'fontSize'),
                      底色: cs(innerOf(search), 'backgroundColor'),
                      边框色: cs(innerOf(search), 'borderTopColor')
                    }
                  : null,
                条目筛选下拉: h(state)
              };
            })(),
            // 属性行那几个下拉/输入框的实测几何（迁移成 xs / sm 之后应该能对上预期值）。
            // "出图零差异"这件事**不能**用来证明"改动生效了"—— 反过来也一样：
            // 得直接量，否则可能整批样式压根没应用，而图看着一模一样。
            attrProbe: (() => {
              const type = document.querySelector('#c-attr-list .attr-type');
              const inner = type && type.querySelector('select');
              const h = (n) => (n ? Math.round(n.getBoundingClientRect().height) : null);
              const w = (n) => (n ? Math.round(n.getBoundingClientRect().width) : null);
              const group = document.querySelector('#c-attr-list .attr-more .attr-group');
              const mode = document.querySelector('#c-attr-list .attr-more .attr-mode');
              const value = document.querySelector('#c-attr-list .attr-value');
              const num = document.querySelector('#c-attr-list .attr-more .attr-num');
              const hint = document.querySelector('#c-attr-list .attr-more .attr-hint');
              const addNew = document.querySelector('#c-attr-new');
              if (!type && !group && !mode && !value) return null;
              // ⚠️ 探针跑在**页面**上下文里，冒烟脚本（另一个注入上下文）里的 asControl 用不了，
              //    这里内联一份同样口径的：组件 → 里层那颗原生控件
              const innerOf = (n) =>
                n && typeof n.tagName === 'string' && n.tagName.startsWith('M-') && n.control ? n.control : n;
              const row = (n) => (n ? { 宿主: h(n), 里层: h(innerOf(n)), 宽: w(n) } : null);
              return {
                类型下拉: h(type),
                类型里层: h(inner),
                类型字号: inner ? getComputedStyle(inner).fontSize : null,
                分组下拉: h(group),
                频率下拉: h(mode),
                值输入框: row(value),
                范围输入框: row(num),
                规则输入框: row(hint),
                新增属性框: row(addNew),
                状态筛选: h(document.querySelector('.wb-state')),
                状态里层: h(document.querySelector('.wb-state select')),
                属性行高: Array.from(document.querySelectorAll('#c-attr-list .attr-row')).map((n) => Math.round(n.getBoundingClientRect().height)).join('/'),
                更多框高: h(document.querySelector('#c-attr-list .attr-more')),
                新增行高: h(document.querySelector('.attr-add-row')),
                属性区滚动高: (() => {
                  const panel = document.querySelector('#char-section-state');
                  return panel ? panel.scrollHeight : null;
                })()
              };
            })(),
            card: bg('.modal-card'),
            panel: bg('.attr-panel'),
            tabs: bg('.attr-tabs'),
            value: bg('.attr-row input.attr-value'),
            // 长文本框的实高：光看截图分不清「自动长高了」和「本来就这个高」，
            // 这里把五个框的量出来，一眼能看出收窄/增高有没有真的发生。
            // ⚙ 2026-10-16 多行框组件化之后，「框自己的高」在里层那颗原生框上
            //   （宿主只占位），所以这里量的是**宿主/里层**两个数 —— 两个数不一致
            //   就说明宿主多出了一层行高的空隙（那种坑截图上看不出来）。
            desc: pair('#c-desc'),
            personality: pair('#c-personality'),
            scenario: pair('#c-scenario'),
            first: pair('#c-first'),
            example: pair('#c-example'),
            // 左栏「有没有长出栏内滚动条」：这是 V2 布局的一条硬要求
            // （左栏固定、右列独立滚动），光看截图那根细细的滚动条很容易看漏。
            // scrollHeight > clientHeight 就是长了，给数字比看图可靠。
            railScroll: (() => {
              const n = document.querySelector('#view-char-editor .char-identity-pane');
              return n ? n.scrollHeight + '/' + n.clientHeight : '(无)';
            })(),
            // 开场白选择区：显示了没 / 铺了几行 / 列表自身的高 vs 内容高
            //（前者小于后者 = 列表内部在滚，正是长卡该有的样子）
            opening: (() => {
              const field = document.querySelector('#player-opening-field');
              const list = document.querySelector('#player-opening-list');
              if (!field || !list) return '(无)';
              if (field.classList.contains('hidden')) return '隐藏';
              const no = list.querySelector('.opening-item-no');
              return '显示 行=' + list.children.length +
                ' 列表 ' + Math.round(list.getBoundingClientRect().height) + '/' + list.scrollHeight +
                ' 序号底=' + (no ? getComputedStyle(no).backgroundColor : '(无)') +
                ' 勾=' + ((list.querySelector('.opening-item-mark') || {}).textContent || '(无)');
            })(),
            // 当前那个可见弹窗的卡片实测尺寸 vs 内容区。放大状态应该刚好等于
            // window.innerWidth × innerHeight —— 「差几 px 没铺满」在缩略图上
            // **根本看不出来**，所以这里给数字。
            modal: (() => {
              const m = document.querySelector('.modal:not(.hidden)');
              if (!m) return '(无弹窗)';
              const c = m.querySelector('.modal-card');
              if (!c) return '(无卡片)';
              const r = c.getBoundingClientRect();
              const tag = m.classList.contains('modal-max') ? '已放大' : '常规';
              // ⚠️ 这里**不能**再写一层反引号模板 —— 整段是嵌在宿主的模板字符串里的，
              // 里面的反引号会当场把外层字符串截断（tools/smoke-test.js 直接语法错误，
              // npm run smoke 一行都跑不出来）。只用字符串拼接。
              return Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + tag +
                '（内容区 ' + window.innerWidth + 'x' + window.innerHeight + '）';
            })()
          };
        })()`);
        console.log(`  主题=${probe.theme} 配色=${probe.accent} 弹窗底=${probe.card} 属性卡=${probe.panel} 标签栏=${probe.tabs} 值框=${probe.value}`);
        console.log(`  弹窗卡片=${probe.modal}`);
        if (shotArg === 'playerModal') console.log(`  开场白选择区=${probe.opening}`);
        if (probe.selProbe) console.log(`  下拉几何=${JSON.stringify(probe.selProbe)}`);
        if (probe.attrProbe) console.log(`  属性行控件=${JSON.stringify(probe.attrProbe)}`);
        if (probe.iconProbe) console.log(`  图标注入=${JSON.stringify(probe.iconProbe)}`);
        if (probe.cardProbe) console.log(`  卡片/工具条控件=${JSON.stringify(probe.cardProbe)}`);
        if (shotArg === 'charTextareas') {
          console.log(`  长文本框实高(px) 宿主/里层 描述=${probe.desc} 性格=${probe.personality} 场景=${probe.scenario} 开场白=${probe.first} 示例对话=${probe.example}`);
        }
        if (probe.railScroll) {
          const [sh, ch] = String(probe.railScroll).split('/');
          console.log(`  左栏 scrollHeight/clientHeight = ${probe.railScroll}${Number(sh) > Number(ch) ? '  ⚠ 左栏长出了栏内滚动条' : '  ✓ 没有栏内滚动'}`);
        }
        const dir = path.join(__dirname, 'shots');
        fs.mkdirSync(dir, { recursive: true });
        // 配色不是默认那套（ACCENTS 第一项）时把配色名缀进文件名，
        // 免得几套配色的图互相覆盖。默认从 providers.js 取，别在这儿再写死一遍。
        const defaultAccent = ACCENTS[0];
        const accentTag = shotAccent && shotAccent !== defaultAccent ? `-${shotAccent}` : '';
        // 明暗同理：显式指定了哪一档就缀上哪一档（-dark / -light），
        // 都不给 = 出厂默认档，不加后缀。
        const modeTag = shotMode ? `-${shotMode}` : '';
        const viewportTag = viewport ? `-${viewport[0]}` : '';
        const panelTag = panel ? `-${panel.replace(/[^a-z0-9-]/gi, '')}` : '';
        const shotName = `${shotArg}${panelTag}${accentTag}${modeTag}${viewportTag}.png`;
        fs.writeFileSync(path.join(dir, shotName), (await win.webContents.capturePage()).toPNG());
        console.log(`  截图: tools/shots/${shotName}`);
      }
    } catch (err) {
      console.log('  截图失败:', (err && err.message) || err);
    }
  }

  // --shot-only 没跑断言，别打那份「0/0 通过」的报告 —— 那会让人以为验证过了。
  if (SHOT_ONLY) {
    console.log('');
    console.log('  ℹ --shot-only：只出图，**一条断言都没跑**（验证请去掉这个参数跑整套）');
    if (consoleErrors.length) {
      console.log(`  ⚠ 不过页面里有 ${consoleErrors.length} 条控制台报错：`);
      consoleErrors.slice(0, 5).forEach((e) => console.log('    ! ' + e));
    }
    app.exit(0);
    return;
  }

  // --dump-store=<路径>：把假后端跑完后的状态原样导出来。
  // 只有一个用途 —— 抄这份真实数据当「域夹具」的种子（见 tools/smoke-groups.js）。
  // 手写种子字段一定会漏（会话有十几个字段），漏一个就等着断言莫名其妙地红。
  const dumpArg = (process.argv.find((a) => a.startsWith('--dump-store=')) || '').split('=')[1];
  if (dumpArg) {
    fs.writeFileSync(path.resolve(dumpArg), JSON.stringify(clone(store), null, 2));
    console.log(`  已导出假后端状态：${dumpArg}`);
  }

  const ok = report(result, consoleErrors, consoleWarnings, crashed);
  app.exit(ok ? 0 : 1);
});
// 兜底：万一卡住（窗口没起来 / executeJavaScript 不返回），别让终端一直挂着
setTimeout(() => {
  console.error(`\n  ⏱ 冒烟测试超过 ${Math.round(OVERALL_TIMEOUT_MS / 1000)} 秒没有结束，判定失败\n`);
  app.exit(2);
}, OVERALL_TIMEOUT_MS).unref();
