# Mimitale

一个跑在自己电脑上的桌面对话 AI。支持多模型切换、角色扮演和酒馆角色卡导入。

基于 **Electron + OpenAI 兼容接口**，没有任何后台服务器 —— 主进程就是本地的 Node.js 后端，  
聊天记录和 API Key 全部只存在本机。

**当前状态**：客户端尚无账号注册、登录或云同步。`admin/` 仅为独立的 Mock 管理后台前端，`server/` 后端尚未实现；官网暂无可下载的发布包。接口契约和设计记录不等于功能已上线。

---

## 功能

### 多模型 / 多提供商

- 可以同时配置多个模型提供商，每个都有自己的**接口地址、API Key 和模型列表**。
- 内置 6 家国内常见平台预设（DeepSeek / 通义千问 / Kimi / 智谱 GLM / 腾讯混元 / MiniMax），
  其余平台（含境外）在「自定义模型API」里自己填地址即可。
- 聊天窗口右上角的下拉框按模型提供商分组列出所有模型，**选中立刻生效**。
- **每个会话记住自己用的模型**，A 会话用 `qwen-max`、B 会话用 `deepseek-chat` 互不影响。
- 每条回答上标注是哪个模型答的，方便对比。
- 支持一键「拉取可用模型」和「测试连接」。
- 所有 API Key 用系统级 `safeStorage` 加密后落盘。

### 角色扮演 / 角色卡

- **直接导入酒馆（SillyTavern）的 PNG 角色卡** —— 解析 PNG 里的 `tEXt` 数据块，  
  把设定、头像、开场白、示例对话一起读进来；也支持 JSON 卡（v1 / v2 / v3）。  
  v3 那种把开场白放进 `chat_history`（没有 `first_mes`）的变体也认。
- 内置角色编辑器，可以完全手写一个角色。
- **默认人设**：不绑角色卡的对话里 AI 是谁 —— 在**设置 → 默认人设**里改（名字 + 人设），
  **按模型各存一份**，顶栏切模型就跟着换；留空就是通用助手。
- **每个会话独立绑定角色**，新建对话会继承当前角色。
- 支持 `{{char}}` / `{{user}}` / `<BOT>` / `<USER>` 宏。
- **开场白**：空对话绑定角色时自动插入第一句话。
- **示例对话**：解析成真正的 user/assistant 消息一起发给模型，显著提升扮演质量。
- **头像可以自己上传**，会自动压成 256×256 存起来。
- **角色卡自带的世界书**：卡里内嵌的 `character_book` 会自动存进世界书库并绑到这张卡上。

### 世界书（World Info / Lorebook）

- **关键词命中才注入**，四两拨千斤：一本书几百条设定，只有相关的那几条进上下文。
- **递归扫描**：条目命中后，它的正文能再触发别的条目，一路连锁。
- 支持副关键词、选择性逻辑、概率、常驻条目、扫描深度。
- **命中预览**：用真实对话扫一遍，告诉你这轮会注入哪几条。
- 世界观和角色卡分开：**换个主角重玩同一个世界**。

### 预设（Preset）

- **叠在对话上的一层指令**：角色卡管「演谁」、世界书管「在哪儿」，预设管「**怎么回**」。
- 一段行为框架挂到某个会话上，从下一条回复生效 —— 换会话不受影响。
- **一场可挂多条**：勾几条叠几条，每条各自成块依次拼进提示词。
- **每条自带「可全局」开关**：勾上的进新对话的默认名单（多条可共存）；
  某一场手动动过勾选后，那一场就以它为准，不再自动叠全局预设。
- 管的是**写法层**：人称 / 句式 / 篇幅密度 / 用词禁区 / 固定称呼。
  「一轮推进多少」「出不出心理旁白」已经由**推进节奏 / 叙述模式**负责，不归预设。
- **说明与正文分离**：说明只给人看，正文才进提示词。
- **条目**：有关键词的按命中带，没关键词的常驻每轮都带。
- **可选采样参数**（温度 / 回复上限 / top_p），留空用全局设置。
- 能直接吃**别人分享的预设**（正文在 `content` 或 `metadata.systemPromptContent` 里都认）。

### 状态面板（数值不漂）

模型每轮输出的状态栏会被**解析出来单独保存**，下一轮由程序权威注入 ——  
所以聊再多轮，数值也不会因为历史被截断而开始乱编。

- 字段带**类型**（文本 / 数值 / 列表）
- 数值字段带**范围**，超出自动拉回（模型写 `150/100` → `100/100`）
- 数值字段自动画**进度条**
- 字段可以**分组**（「关系」「背包」各成一块）
- 字段可以带**变化规则**，原样交给模型（比如「示好时每轮最多加 10」）
- **剧情选项**：每轮给几个可点选项，点一下就当玩家回复发出去
- 导入他人卡片时，对方格式的「互动模板」会**自动映射**成这里的属性

### 长对话不丢前文

- **分段记忆摘要**：较早的对话压成摘要常驻，聊多久都不忘开局。
- **语义检索（RAG）**：按「意思」把相关的旧内容和设定捞回来，不靠关键词。
- **分支 / 存档点**：走岔了能整个退回来。

### 其他

- 多提供商 / 多模型切换，**每个会话记住自己用的模型**。
- 流式输出（打字机效果），逐帧渲染，长回答也不卡。
- 显示 `deepseek-reasoner` 这类模型的思考过程（可折叠）。
- **视角设置**：标准 / 内心描写 / 上帝视角；角色卡局固定是「世界模式」，AI 扮演整个世界和所有 NPC。
- **白天 / 夜间模式**一键切换，选择会记住。
- 单条消息删除、编辑、重新生成候选、复制全文、token 用量统计。
- **给剧情配插画**（设置 → 生图里单独配一组生图模型提供商）。
- **导出**：角色卡存成 PNG 卡（酒馆能直接导入）/ JSON，世界书存成 lorebook JSON，  
  对话存成 Markdown。
- 断点安全的本地存储：每次写入前自动留一份 `.backup`。

---

## 快速开始

### 环境要求

- **Node.js 18 或更高**（[下载 LTS 版](https://nodejs.org)）
- Windows / macOS / Linux

### 运行

```bash
cd client      # 客户端代码都在 client/ 里，先进去

# 1. 装依赖（首次大约要下载 100MB 的 Electron 运行时）
npm install

# 2. 启动
npm start
```

Windows 用户也可以直接**双击 `client\Start-Mimitale.cmd`**，它会自动检查环境、首次自动  
`npm install`，并给出中文的错误提示。启动器靠**自身所在目录**定位，因此放在哪里都能用。

### 配置

启动后点左下&#x89D2;**「设置」**，填入模型提供商的接口地址和 API Key：

| 模型提供商      | 接口地址                                                |
| -------- | --------------------------------------------------- |
| DeepSeek | `https://api.deepseek.com`                          |
| 通义千问     | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi     | `https://api.moonshot.cn/v1`                        |
| 智谱 GLM   | `https://open.bigmodel.cn/api/paas/v4`              |
| 腾讯混元     | `https://api.hunyuan.cloud.tencent.com/v1`          |
| MiniMax  | `https://api.minimaxi.com/v1`                       |

> 上面是「第三方模型提供商」里点一下就能填好的那几家。**不在这 6 家里的平台**
> （豆包 / 硅基流动 / 百度千帆 / 阶跃星辰 / 讯飞星火 / 零一万物，以及境外平台）
> 走「自定义模型API」自己填地址 —— 只要对方是 OpenAI 兼容端点就能用。

> 接口地址会先**清洗**再拼接：去掉首尾空白、去掉末尾多余的 `/`，并循环剥掉末尾
> 误粘进来的端点路径（`/chat/completions`、`/images/generations`、`/embeddings`、
> `/models`）—— 把整条端点当「接口地址」粘进来的情况很常见，不剥就会拼成
> `.../chat/completions/chat/completions` 而 404。  
> 但模型提供商要求的**版本前缀必须自己带上**（`/v1`、`/api/paas/v4`、`/compatible-mode/v1`），
> 清洗不会替你补，少了照样 404。

详细用法见 **[使用说明.md](使用说明.md)**。

---

## 开发

**这个项目没有构建步骤** —— 没有 webpack / vite / babel，`renderer/` 里的文件  
是 Chromium 直接从磁盘加载的，改完刷新就是新的。

> 下面这些命令都在 `client/` 目录下执行。

```bash
npm run dev
```

这条命令会：

- 自动打开 **DevTools**
- 监听 `renderer/` 目录，**文件一保存就自动刷新窗口**

| 改什么                                | 怎么生效                 |
| ---------------------------------- | -------------------- |
| `renderer/style.css`               | 保存即刷新                |
| `renderer/js/` 里的文件 / `index.html` | 保存即刷新（但页面状态会重置）      |
| `main.js` / `preload.js`           | **必须重启**，这两个只在启动时读一次 |

`F12` 或 `Ctrl + Shift + I` 开关 DevTools，`Ctrl + R` 刷新窗口。

> 没有热更新（HMR）。因为那需要引入打包器，会把「零构建」这个最大的便利丢掉。

---

## 项目结构

这个仓库是**多个项目共处一库**：

```
Mimitale/
├── client/          桌面客户端（Electron）—— 下面的结构图讲的就是它
├── admin/           管理后台（Vue3 + Element Plus，独立 npm 项目，有自己的 package.json）
├── 部署/            服务器选购与开箱清单、部署记录
├── 桌宠/            桌宠设计记录
├── CHANGELOG.md     变更记录
├── 使用说明.md       面向用户的详细用法
├── 故事优化提示词.md  给 AI 使用的角色卡 / 故事优化提示词
└── README.md
```

`client/` 内部 —— **下面出现的所有相对路径，根都是 `client/`**：

```
client/
├── main.js          Node.js 主进程（本地后端）：开窗口 + 注册 IPC
├── main/            主进程的模块（CommonJS，零构建）
│   ├── characters.js      角色卡归一化（哪些字段会被存下来）
│   ├── panel-fields.js    面板字段的类型 / 范围 / 变化规则 / 分组
│   ├── worldbook-*.js     世界书：解析、落盘、关键词匹配
│   ├── presets.js         预设：落盘时的归一化（说明与正文分离）
│   ├── card-import.js     导入一个文件的解析
│   ├── import-files.js    导入编排（读文件 → 解析 → 自动绑定）
│   ├── png.js             PNG 角色卡的读写（tEXt / zTXt / iTXt 里的 ccv3 / chara 块）
│   ├── vectors.js         向量 / 余弦相似度 / 排序
│   └── request-log.js     「请求记录」：只存内存的环形缓冲，最近 20 条
├── preload.js       contextBridge 安全桥，把主进程能力暴露给页面
├── package.json
├── renderer/        前端（Chromium 页面）
│   ├── index.html
│   ├── style.css
│   ├── preview/     **组件盘**（开发用页面，不属于应用界面）
│   │                components.html + preview.js —— 每个组件的每种状态摆一遍
│   │                出图：npm run shot:components
│   └── js/          界面逻辑（ES module，不需要打包器）
│       ├── main.js      入口层 · 只剩启动流程 + 事件绑定 + 跨视图编排
│       ├── core/        常量 / 状态 / DOM 引用 / preload 桥 / 工具 / 面板字段桥
│       ├── components/  **组件库**（自定义元素，见下面「组件库」一节）：
│       │                base.js 极小运行时 · button / input / textarea / select
│       ├── ui/          提示条 / 确认框 / 主题 / Markdown / 建 DOM 的小工具 /
│       │                **控件规范件**（build.js 按钮 · controls.js 输入框与字段 ·
│       │                select.js 自研下拉）
│       ├── data/        纯逻辑地基：模型提供商 / 模型 / 角色库 / 状态面板 / 叙述规则 /
│       │                记忆摘要 / 持久化 / 导出收尾 / 演出阵容 / 消息 / 语义检索 /
│       │                剧情选项 / 桌宠上下文 / 会话骨架
│       └── views/       一个功能一块（refresh 总线 / redraw 门面 / header /
│                        perspectiveUi / panelUi / worldbookList / worldbook /
│                        presetList / preset / presetIO / settings / settingsCatalog /
│                        appearance / player / memoryUi / petSettings / viewSwitch /
│                        requestLog / characterList / characterEditor / charAttributes /
│                        charExpressions / characterImport / aiGen / stream /
│                        chatImages / suggestionsUi / stateCard / convoActions /
│                        summarize / composer / chatMessages / chatList / chatExport /
│                        worldPlay）
└── tools/           冒烟测试脚手架（假后端，不动你的真实数据）
                    + 一组不需要启动程序就能跑的静态检查（见下面「自检工具」）
```

### 组件库

界面里反复要用的东西（按钮 / 输入框 / 多行框 / 下拉框）都有现成的组件，
**一次定义 = 结构 + 行为 + 样式**，页面只写「用哪个组件 + `variant` / `size`」，
不写外观样式。两套入口共用一份实现：

```html
<!-- 标签形态（index.html 里、或 innerHTML 里都行） -->
<m-button variant="primary" size="sm">保存</m-button>
<m-input placeholder="角色名" aria-label="角色名"></m-input>
<m-select aria-label="界面字体">
  <option value="default">系统默认</option>
  <option value="noto">思源黑体</option>
</m-select>
```

```js
// 工厂形态（渲染层 95% 是 JS 建 DOM，用的是这一套）
import { mButton, mInput, mSelect } from './components/index.js';
mButton({ variant: 'primary', text: '保存', onClick: save });   // → <m-button>
mInput({ placeholder: '角色名', value: '小满', onInput: fn });    // → <m-input>
mSelect({ 'aria-label': '界面字体', items: [...] });             // → <m-select>
```

每个组件都是「**宿主 + 里层一个原生控件**」（m-button→`<button>`、
m-input→`<input>`、m-textarea→`<textarea>`、m-select→`<select>`）：
键盘、禁用态、原生事件、表单语义全由里层那个原生控件提供；宿主负责外观类名、
属性转发、`.value` 代理、`focus()` / `click()` 转发。三条约定别破坏：

- **皮肤只有一份**：组件的外观住在 `style.css` 的组件段，而按钮那几条是
  `.btn, .mi-btn__control { … }` 这样**一条规则挂两个选择器** —— 老 `.btn` 退役时
  把逗号左边删掉即可，不会留下两份长得差不多的外观。
- **light DOM，不是 Shadow DOM**：整套配色/字号/圆角是 style.css 里那 125 个
  CSS 变量 + 两套主题（`data-theme` / `data-accent`）。Shadow 会把全局 CSS 挡在外面，
  样式得复制进每个影子根 —— 那等于每个组件自己养一套主题。代价是没有样式隔离，
  所以**组件类名一律 `mi-` 前缀**。
- **类名写成字面量**：`{ primary: 'mi-btn--primary' }` 这样写，别用
  `mi-btn--${variant}` 拼 —— 拼出来的字符串 grep 不到，`tools/audit-css-dead.js`
  会把 CSS 里那些类当成死规则。

想一眼看全所有状态：`renderer/preview/components.html`（`npm run shot:components`
出明暗两张图）。新增组件就写一个 `createControl()`，往 `components/index.js` 的
`COMPONENTS` 表里添一行。

### 自检工具

以下命令都在 `client/` 目录下执行（先 `cd client`）。它们都是**纯静态检查**，
不需要起 Electron、不碰你的数据，几秒跑完。输出「(无)」= 没问题；有问题时退出码非 0，方便挂进脚本。

| 命令 | 抓什么 |
| --- | --- |
| `node tools/analyze.js` | 分层与规模：分区、fan-in、疑似重复的函数对 |
| `node tools/check-imports.js` | 导入了但对面没导出（名字对不上 = 整个模块图链接失败） |
| `node tools/check-channels.js` | IPC 通道三向对齐（preload 调的 / 主进程注册的 / 主进程推的） |
| `node tools/check-dead-code.js` | 死导入、主进程死 `require`、死导出（并区分「只是多写了 export」） |
| `node tools/check-dom-ids.js` | JS 抓的 DOM id 在 HTML 里不存在 |
| `node tools/check-el-refs.js` | `el.<分组>.<字段>` 在 `core/dom.js` 里不存在 |
| `node tools/check-api-settings.js` | `api.xxx()` 没被 preload 暴露；设置键不在 `DEFAULT_SETTINGS` 白名单（会被静默丢掉） |
| `npm run test:ui` | 控件层的纯逻辑（`node --test`）：下拉的行怎么摊 / 键盘怎么走 / 弹层摆哪，`button()` 的类名拼法、`fillSelect()` 的铺选项规则，以及组件库的类名表 / 属性口径 / 注册表幂等 |
| `npm run shot:components` | 给组件盘出图（明 + 暗两张，写到 `tools/shots/`）。顺带打出「组件皮肤 vs 老 `.btn` 皮肤」的计算样式对照 —— 两者必须一模一样 |
| `npm run diag` | 页面到底起没起来（模块图链接失败时它 3 秒就能把控制台那行报错打出来） |

> 为什么值得有这一组：这个仓库的坑集中在「**不会报错，只会静默失效**」这一类 ——
> 通道名写错、id 拼错、设置键漏进白名单，症状都是「点了没反应」。
> 靠人肉 review 容易漏，靠这几条正则能稳定挡住。

> **控件的规范件在哪**（2026-10-16 抽的）：`ui/build.js` 管建 DOM 的原语和按钮，
> `ui/controls.js` 管输入框 / 多行框 / 字段 / 铺下拉选项，`ui/select.js` 管下拉怎么弹。
> 三条规矩别破坏：**类名只在 `build.js` 的 `button()` 里拼**（调用点给
> `variant / size`，别再手写 `'btn btn-primary btn-sm'`）；**文本一律 `textContent`**
> （不给 `innerHTML` 入口）；**值走 property**（`value` / `checked`）。
> 13 个静态下拉 + 4 个动态建的下拉由 `ui/select.js` 统一换掉系统那份列表 ——
> 它给原生 `<select>` 贴一层皮肤，**不替换元素**，所以各处读 `.value` /
> 监听 `'change'` 的接线一行都不用改。

> **主进程为什么拆成 `main/`**：这些模块是纯逻辑，抽出来以后冒烟测试能  
> `require` **同一份代码**去验，而不是在测试里另写一套 —— 「内嵌世界书被丢掉」  
> 「导入后绑定指向不存在的书」这两个 bug 就是这么做才被抓住的。
>
> `renderer/js/main.js` 的重构**已经收尾**：从峰值 7900 多行降到只剩入口层编排 ——  
> 启动流程（`init()`）、事件绑定（`bindEvents()`，含 Esc 的有序关闭链和  
> `api.onChunk / onReasoning` 全局监听）、刷新接线板（`registerRefreshListeners()`）、  
> 以及跨视图编排（`importWorldbooks()`）。
>
> 功能代码按 `core ← ui ← data ← views ← 入口` 单向分层：`data/` 放纯逻辑，  
> `views/` 一个功能一块，刷新走 `views/refresh.js` 总线，  
> 全量重绘统一走 `views/redraw.js` 门面。视图要用入口层的动作时，由入口层  
> `initXxx({ action })` 注入，视图不向上 import —— 这条是防循环依赖的铁律。
>
> ⚠️ 这里**故意不写「多少行 / 多少个模块」**：这类数字每次改动都会过期，  
> 而过期数字比没有数字更误导。要复核分层与规模，直接跑 `node tools/analyze.js`  
> （它按真实文件统计并列出分区、fan-in 和疑似重复函数）。

**为什么文件操作都在主进程？** 因为页面被 CSP 锁死了：

```
default-src 'none'; script-src 'self'; img-src 'self' data:;
```

页面连网络请求都发不出去，所以所有系统能力都必须走 IPC 交给主进程。  
这是刻意设计 —— 即使页面上被塞了恶意脚本，它也没法往外发数据。

---

## 数据存在哪

**就在程序旁边**（2026-10-08 起；以前在 `%APPDATA%\Mimitale`，会自动搬过来）：

```
<Mimitale 文件夹>\data\        （Windows / macOS / Linux 都一样）
├── config.json          设置（API Key 已加密）
├── conversations.json   所有聊天记录
├── characters.json      角色库
├── worldbooks.json      世界书（含从角色卡里抽出的内嵌世界书）
├── presets.json         预设（叠在对话上的那层指令）
└── vectors.json         语义检索的向量缓存
```

窗口里点**「打开数据文件夹」**可以直接跳过去。
`data\` 里还有一份程序自动生成的 **`使用说明.txt`**，就是给人看的：每个文件是什么、
能不能删、怎么备份、怎么换位置。

整个文件夹拷走，数据就跟着走 —— 换机器、放 U 盘、发给别人都不用额外配置。
想把数据放到别处（比如另一个盘），设环境变量 `MIMITALE_DATA_DIR=<目录>` 即可。

> ⚠️ 程序旁边的 `data\` **建不出来或写不进去**时（装在 `C:\Program Files` 下、
> 只读介质、权限策略…），会自动退回系统的 `%APPDATA%\Mimitale`，**不会**因此起不来。
> 想确认当前用的是哪个目录：点「数据文件夹」看跳到哪，或执行 `node tools\diag-write-lock.js`。
> Chromium 自己的缓存（`Cache` / `GPUCache` / `Local Storage` 等）**不在** `data\` 里，
> 仍留在系统默认位置 —— 那些是缓存不是你的数据，留在那边最稳。

> **数据不在仓库里，也不会跟着 git 同步**（`data/` 已在 `.gitignore` 里）。
> 换电脑 clone 代码后需要重新填 API Key，聊天记录也不会带过去 ——
> 这是「没有服务器」的代价，也是隐私的保证。

---

## 已知限制

- **发图给模型看**：当前客户端尚不支持在对话中附加图片；角色头像、立绘和背景图的图片导入不等于发送给模型。
- **让模型生图**：已经支持（鼠标悬停在 AI 回复上 → 「配图」）。需要在  
  **设置 → 生图**里单独配一组「生图提供商 + 生图模型」—— 它和聊天模型是两个东西，  
  通常还在两个端点上（`/images/generations` vs `/chat/completions`）。  
  目前只支持同步返回图片的接口（OpenAI 那套）；通义万相那种异步任务还不支持。
- 不同电脑之间无法同步聊天记录。
- **智谱没有 `GET /models` 接口**，所以「拉取可用模型」对它无效 —— 内置的模型清单  
  （`glm-5.3-flash` / `glm-5.3` / `glm-5.2`）就是为此准备的，直接用即可。
- 界面里的「导入角色卡」按钮会弹系统文件框，冒烟测试点不了它；  
  导入链路的**真代码**已由测试直接喂真卡字节覆盖（见 `tools/`）。

---

## License

MIT
