'use strict';

/* ==========================================================================
   Mimitale · 角色卡编辑 · 「这一栏怎么写」两版设计稿（2026-10-28）
   一份内容模型 → 两套结构。两版**字段文案逐字一致**，差异只在「写法说明」这件事上：
     A 就地版：卡底折叠条撤掉 → 字段头栏一枚 ? 按钮 + 覆盖式浮层
     B 旁注版：说明搬出卡片 → 右列常驻旁注，跟着正在写的字段切换
   基准窗口 1440 × 900（client/main/window.js 的真实值）。
   ========================================================================== */

const ICON = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="3.5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  say: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h9"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.4"/><path d="M2.5 20v-1.4a3.6 3.6 0 0 1 3.6-3.6h5.8a3.6 3.6 0 0 1 3.6 3.6V20"/><path d="M17 5.2a3.4 3.4 0 0 1 0 5.6M18.4 15.2A3.6 3.6 0 0 1 21.5 18.6V20"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-13c-4.5 0-6.5.5-8 2Z"/><path d="M12 6.5v13"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.6M12 18.9v2.6M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12h2.6M18.9 12h2.6M4.2 19.8 6 18M18 6l1.8-1.8"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  tip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .8 1.6v.6h5.6v-.6c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3Z"/></svg>'
};

/* ------------------------------ 内容模型 ------------------------------ */

const CH = { name: '小满', tags: '治愈, 日常' };

const F = {
  desc: {
    label: '角色卡描述', icon: 'user', count: '132 字', h: 200,
    text: '{{char}}是中文系大三的学生，在旧馆二楼做闭馆前的整理。头发总是随便扎着，袖口常年沾着一点墨。\n\n她话不多，习惯先看一眼对方再开口；被问到家里的事，会把话题轻轻转到书上。\n\n她讨厌被打断阅读，但答应过的事一定做到 —— 哪怕只是「明天帮你留个座」。',
    help: [
      '想一句话把角色立住，可以在最前面加一行 <code>((…))</code>，里面按 <b>动机 → 障碍 → 代价 → 奖励</b> 写全。',
      '障碍写成「玩家本人」的话，你一出现故事就结束了 —— 让障碍落在角色自己身上。'
    ],
    example: '((她察觉你在撩她，因此讨厌你；但你要是真能动摇她，她会极度顺从。))'
  },
  scenario: {
    label: '场景', icon: 'pin', count: '0 字', h: 84,
    text: '', placeholder: '你们正在哪里、干什么',
    help: ['交代「你们正在哪里、干什么」即可，一两句话就够 —— 事件本身交给开场白写。'],
    example: '闭馆前二十分钟的旧馆二楼，窗外在下雨。'
  },
  example: {
    label: '示例对话', icon: 'list', count: '78 字', h: 160,
    text: '{{user}}：这么晚了还不回去？\n{{char}}：……还差两页。你先走吧。\n{{user}}：我看你昨天也没去食堂。\n{{char}}：（把书往怀里按了按）不饿。',
    help: ['照这个格式写几组，能明显提升扮演时的语气准确度。每行以 <code>{{user}}:</code> 或 <code>{{char}}:</code> 开头，用 <code>&lt;START&gt;</code> 分隔不同组。'],
    example: '{{user}}: 你好\n{{char}}: 你好呀～今天感觉怎么样？'
  },
  first: {
    label: '开场白', icon: 'say', count: '96 字', h: 128,
    text: '闭馆的铃声响过第二遍，她还没动。\n\n你把伞靠在桌边坐下，她抬头看了你一会儿，把手里那本翻旧了的诗集往你这边推了推：「……你要看吗？我看完了。」',
    template: true,
    help: [
      '骨架三段：<b>定场</b>（时间 / 地点 / {{user}} 正在做什么）→ <b>登场</b>（{{char}} 的动作或神态 + 一句说出口的话）→ <b>话头</b>（停在一个需要 {{user}} 回应的地方）。',
      '最后一段别写满 —— <b>给出去的话语权越明确，第一轮越好接</b>。同一张卡可以多写几条不同状态的开场白（干活 / 闲暇 / 压力下 / 剧情后期）。'
    ],
    example: '她没有抬头，只说：「门在那边。」'
  },
  alt: {
    label: '备选开场白', icon: 'layers', count: '2 条',
    items: [
      '雨天，她把伞落在阅览室，正站在门口犹豫要不要冲出去。',
      '期末周的凌晨，图书馆只剩她这一盏灯还亮着。'
    ],
    help: ['同上一条开场白，但可以写好几条（日常 / 忙碌 / 剧情后期……）。<b>绑定角色时会弹出来让你挑一条</b>；一条都不加就只用上面那条。'],
    example: '（同上一条的骨架，换个时间地点即可）'
  }
};

const SECTIONS = [
  ['writing', '角色卡设定', 'doc'],
  ['opening', '开场白', 'say'],
  ['roles', '人物列表', 'people'],
  ['worldbook', '世界书', 'book'],
  ['advanced', '高级设置', 'gear']
];

/* ------------------------------ 通用件 ------------------------------ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function appNav() {
  return `<aside class="app-nav">
    <div class="brand"><img src="assets/brand-logo.png" alt=""><span class="brand-name">如我所书<small>MIMITALE</small></span></div>
    <button type="button" class="new-convo">＋ 新对话</button>
    <div class="space-label">对话记录 · 1</div>
    <button type="button" class="convo-item" aria-current="true">
      <span class="convo-name">新对话</span><span class="convo-preview">故事，等待续写</span>
    </button>
    <div class="nav-groups">
      <button type="button" aria-current="page">${ICON.user}<span>角色卡</span><i>8</i></button>
      <button type="button">${ICON.doc}<span>游戏卡</span><i>0</i></button>
      <button type="button">${ICON.key}<span>预设</span><i>4</i></button>
    </div>
    <div class="nav-foot">
      <button type="button">${ICON.gear}<span>设置</span></button>
      <button type="button" class="account"><span class="ava">A</span><span class="acc-text">未登录<small>登录后同步角色卡</small></span></button>
    </div>
  </aside>`;
}

function pageHead(activeLabel) {
  return `<header class="page-head">
    <div class="head-left">
      <button type="button" class="back-link">${ICON.back}<span>返回</span></button>
      <h1 class="page-title">角色卡编辑</h1>
    </div>
    <div class="head-right">
      <span class="total">全文 149 字</span>
      <span class="save-pill" data-state="dirty">有未保存的改动</span>
    </div>
  </header>`;
}

function identityRail(badges, active) {
  const nav = SECTIONS.map(([key, label, icon]) => {
    const badge = badges[key];
    return `<button type="button" class="sec-btn" data-key="${key}" aria-selected="${key === active}">
      ${ICON[icon]}<span class="sec-label">${label}</span>${badge ? `<span class="sec-count">${badge}</span>` : ''}
    </button>`;
  }).join('');

  return `<aside class="identity-rail">
    <div class="portrait-wrap">
      <img class="portrait" src="assets/portrait.jpg" alt="">
      <button type="button" class="portrait-x" aria-label="清除封面">${ICON.x}</button>
    </div>
    <div class="rail-field"><span class="field-label">角色卡标题</span><div class="inp">${CH.name}</div></div>
    <div class="rail-field"><span class="field-label">标签</span><div class="inp">${CH.tags}</div></div>
    <nav class="section-nav" aria-label="角色编辑分区">${nav}</nav>
    <div class="rail-foot">
      <button type="button" class="btn btn-primary btn-block">保存</button>
      <button type="button" class="btn btn-block">返回</button>
      <button type="button" class="btn btn-block">AI 补充</button>
      <button type="button" class="btn-danger-quiet">删除</button>
    </div>
  </aside>`;
}

/* 字段卡：两版共用一个壳，差异只在头栏那颗 ? 和时间线 */
function sheet(key, { dir, focus = false, pop = false } = {}) {
  const f = F[key];
  const empty = !f.text && !f.items;
  const body = f.items
    ? `<div class="alt-list">${f.items.map((t, i) => `<div class="alt-item"><span class="alt-no">${i + 1}</span><span class="alt-text">${esc(t)}</span></div>`).join('')}</div>`
    : `<div class="sheet-body${empty ? ' is-empty' : ''}" style="min-height:${f.h}px">${empty ? esc(f.placeholder) : esc(f.text)}${focus ? '<i class="caret"></i>' : ''}</div>`;

  const templateBar = f.template
    ? `<div class="template-bar"><button type="button" class="btn btn-ghost btn-sm">套用开场白模板</button><span class="template-hint">定场 · 登场 · 留个话头</span></div>`
    : '';
  const addBar = f.items
    ? `<div class="template-bar"><button type="button" class="btn btn-ghost btn-sm">＋ 添加一条</button></div>`
    : '';

  const hintBtn = dir === 'a'
    ? `<button type="button" class="hint-btn" aria-expanded="${pop}" title="这一栏怎么写" aria-label="这一栏怎么写">?</button>`
    : '';

  const popover = pop
    ? `<div class="hint-pop" role="dialog" aria-label="${f.label}：这一栏怎么写">
        <div class="hint-pop-head">
          <span class="hint-pop-grip" aria-hidden="true"></span>
          <span class="hint-pop-title">${f.label} · 这一栏怎么写</span>
          <button type="button" class="hint-pop-close" aria-label="关闭">${ICON.x}</button>
        </div>
        <div class="hint-pop-body">
          ${f.help.map((p) => `<p>${p}</p>`).join('')}
          <div class="hint-pop-ex"><b>例</b><span>${esc(f.example)}</span></div>
        </div>
      </div>`
    : '';

  return `<section class="sheet${focus ? ' is-focus' : ''}${pop ? ' has-pop' : ''}">
    <div class="sheet-head">
      <span class="sheet-icon">${ICON[f.icon]}</span>
      <span class="sheet-title">${f.label}</span>
      <span class="sheet-count">${f.count}</span>
      ${hintBtn}
    </div>
    ${body}${templateBar}${addBar}${popover}
  </section>`;
}

/* ------------------------------ 主体 ------------------------------ */

function writingSheets(dir, focusKey, popKey) {
  return ['desc', 'scenario', 'example']
    .map((k) => sheet(k, { dir, focus: k === focusKey, pop: k === popKey }))
    .join('');
}

function openingSheets(dir, focusKey) {
  return ['first', 'alt'].map((k) => sheet(k, { dir, focus: k === focusKey })).join('');
}

function panelHead(title, desc, right = '') {
  return `<div class="panel-head"><h2>${title}</h2><p>${desc}</p>${right}</div>`;
}
/* 编辑页真机的标题行：「角色卡设定」在左，「描述和示例对话每轮都带给 AI…」贴右 */
function workHead(title, desc) {
  return `<div class="work-head"><h2>${title}</h2><p>${desc}</p></div>`;
}

const HEAD_TEXT = {
  writing: ['角色卡设定', '描述和示例对话每轮都带给 AI，场景只在开场用一次'],
  opening: ['开场白', '绑定角色时插进对话当第一条；可以多写几条备选让人挑']
};

function frameA({ name, section, focusKey, popKey, light }) {
  const [t, d] = HEAD_TEXT[section];
  const inner = section === 'writing' ? writingSheets('a', focusKey, popKey) : openingSheets('a', focusKey);
  return `<div class="frame" data-dir="a" data-shot="${name}" data-theme="${light ? 'light' : 'dark'}" data-accent="amber">
    <div class="shell">
      ${appNav()}
      <div class="stage">
        ${pageHead()}
        <div class="char-body">
          ${identityRail({ writing: '2/3', opening: section === 'opening' ? '1/1' : '0/1', worldbook: '0', advanced: '0' }, section)}
          <main class="work scroll-y">
            ${workHead(t, d)}
            <div class="sheets">${inner}</div>
          </main>
        </div>
      </div>
    </div>
  </div>`;
}

function frameB({ name, section, focusKey, light }) {
  const [t, d] = HEAD_TEXT[section];
  const key = focusKey || 'desc';
  const f = F[key];
  const note = `<aside class="notes">
    <div class="note">
      <div class="note-eyebrow">${ICON.tip}<span>这一栏怎么写</span></div>
      <h3>${f.label}</h3>
      ${f.help.map((p) => `<p>${p}</p>`).join('')}
      <div class="note-ex"><b>例</b><span>${esc(f.example)}</span></div>
    </div>
  </aside>`;
  const inner = section === 'writing' ? writingSheets('b', key) : openingSheets('b', key);
  return `<div class="frame" data-dir="b" data-shot="${name}" data-theme="${light ? 'light' : 'dark'}" data-accent="amber">
    <div class="shell">
      ${appNav()}
      <div class="stage">
        ${pageHead()}
        <div class="char-body">
          ${identityRail({ writing: '2/3', opening: section === 'opening' ? '1/1' : '0/1', worldbook: '0', advanced: '0' }, section)}
          <main class="work scroll-y">
            ${workHead(t, d)}
            <div class="b-wrap">
              <div class="sheets">${inner}</div>
              ${note}
            </div>
          </main>
        </div>
      </div>
    </div>
  </div>`;
}

const SHOTS = [
  { name: 'A1-writing', dir: 'a', section: 'writing' },
  { name: 'A2-popover', dir: 'a', section: 'writing', focusKey: 'desc', popKey: 'desc' },
  { name: 'A3-opening', dir: 'a', section: 'opening' },
  { name: 'B1-writing', dir: 'b', section: 'writing', focusKey: 'desc' },
  { name: 'B2-scenario', dir: 'b', section: 'writing', focusKey: 'scenario' },
  { name: 'B3-opening', dir: 'b', section: 'opening', focusKey: 'first' },
  { name: 'A4-writing-light', dir: 'a', section: 'writing', light: true },
  { name: 'B4-writing-light', dir: 'b', section: 'writing', focusKey: 'desc', light: true }
];

const html = SHOTS.map((s) => (s.dir === 'a' ? frameA(s) : frameB(s))).join('\n');
document.body.insertAdjacentHTML('beforeend', html);

window.__mock = {
  shots: SHOTS.map((s) => ({ name: s.name, light: !!s.light })),
  theme(mode) {
    document.querySelectorAll('.frame').forEach((f) => {
      f.setAttribute('data-theme', mode === 'light' ? 'light' : 'dark');
    });
  }
};
