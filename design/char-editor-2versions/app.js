'use strict';

/* ==========================================================================
   Mimitale · 编辑角色 两版设计稿 · 渲染层
   一份内容模型 → 两套结构。两版**文案逐字一致**，差异只在结构与版式。
   ========================================================================== */

const ICON = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  face: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.6h.01M15 9.6h.01" stroke-width="2.4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  say: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h9"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-13c-4.5 0-6.5.5-8 2Z"/><path d="M12 6.5v13"/></svg>',
  attr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 0-14.14 0M4.93 19.07a10 10 0 0 0 14.14 0M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  tip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8 1 .8 1.6v.6h5.6v-.6c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3Z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="3.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
};

/* ------------------------------ 内容模型 ------------------------------ */

const CH = { name: '林间的守信人', tags: '原创, 奇幻, 慢叙事', source: '酒馆 PNG 卡' };

const FIELDS = [
  {
    key: 'desc', label: '角色描述', icon: 'doc', count: 174, filled: true, tag: '纯文本',
    v1Height: 340, v2Height: 264,
    text: '{{char}}住在雾林边缘的一间旧木屋里，替往来旅人保管那些终能送出的信。\n\n她有一头浅色长发，习惯把袖口挽起，腰后挂着一串旧铜钥匙。说话时会先看一眼对方的眼睛，再慢慢开口。衣袋里总放着一支铅笔和折好的纸。\n\n很少有人知道她从哪里来。她记得每位寄信人的名字，却从不主动谈论自己的过去。遇到陌生人时，她保持礼貌的距离；一旦答应了什么，就会认真做到。',
    help: '想一句话把角色立住，可以在最前面加一行 ((…))，按 动机 → 障碍 → 代价 → 奖励 写全。障碍写成「玩家本人」的话，你一出现故事就结束了 —— 让障碍落在角色自己身上。{{char}} 是角色自己，{{user}} 是你。',
    where: '每次对话开场时作为「角色描述」注入，从头跟到尾。'
  },
  {
    key: 'personality', label: '性格', icon: 'face', count: 62, filled: true, tag: '纯文本',
    v1Height: 200, v2Height: 120,
    text: '沉稳、细心、重承诺。对熟悉的人会露出不动声色的温柔；被追问自己的过去时，会安静地把话题转开。',
    help: '写「行为倾向」比写形容词管用：她遇到压力会怎样、被冒犯会怎样、高兴时什么样。',
    where: '紧跟在描述之后注入，用来约束她说话和做事的方式。'
  },
  {
    key: 'scenario', label: '场景', icon: 'pin', count: 41, filled: true, tag: '纯文本',
    v1Height: 180, v2Height: 100,
    text: '雾林边缘的旧木屋，黄昏。雨刚停，屋里的灯亮着，你推门进来时，她正低头封一只信封。',
    help: '交代「你们正在哪里、干什么」即可。事件本身交给开场白写。',
    where: '决定对话开场时「你们在哪、在干什么」。'
  },
  {
    key: 'first', label: '开场白', icon: 'say', count: 96, filled: true, tag: '绑定角色时自动发出',
    v1Height: 260, v2Height: 160, template: '套用开场白模板',
    text: '雨刚停，林间小径上浮着薄雾。木屋门口的灯还亮着，一封没有署名的信静静躺在门槛上。\n\n她弯腰把信拾起来，抬眼看见你，微微侧了侧头：「你是来寄信的，还是来取信的？」',
    help: '骨架三段：定场（时间 / 地点 / 你在做什么）→ 登场（动作或神态 + 一句说出口的话）→ 话头（停在一个需要你回应的地方）。最后一段别写满 —— 话头越明确，第一轮越好接。',
    where: '绑定角色时，如果对话还是空的，会作为她的第一条消息自动发出。'
  },
  {
    key: 'example', label: '示例对话', icon: 'list', count: 0, filled: false, tag: '还没写',
    v1Height: 240, v2Height: 140,
    text: '',
    placeholder: '{{user}}: 你好\n{{char}}: 你好呀～今天感觉怎么样？',
    help: '照这个格式写几组，能明显提升扮演时的语气准确度。每行以 {{user}}: 或 {{char}}: 开头，用 <START> 分隔不同组。',
    where: '作为「语气样例」注入；没有它，语气只能靠描述和性格推。'
  }
];

/* 徽章统一口径 = 「已配置条目数」；只有字段有自然总数的用「已写 / 共」 */
const SECTIONS = [
  { key: 'writing', label: '角色设定', icon: 'doc', count: '4/5' },
  { key: 'attributes', label: '属性', icon: 'attr', count: '9' },
  { key: 'expressions', label: '表情图', icon: 'face', count: '3' },
  { key: 'worldbook', label: '世界书', icon: 'book', count: '1' },
  { key: 'advanced', label: '高级设置', icon: 'gear', count: '0' }
];

const ATTR_GROUPS = [
  { name: '状态栏', count: 4, rows: [['体力', '72 / 100'], ['情绪', '平静'], ['信任度', '12'], ['未寄出的信', '3 封']] },
  { name: '关系', count: 2, rows: [['与你的信任', '友善'], ['与商队的关系', '生疏']] },
  { name: '背包', count: 3, rows: [['旧铜钥匙', '1 串'], ['铅笔', '1 支'], ['折好的纸', '几张']] }
];

const EXPRESSIONS = [
  { name: '平静 · 默认', pos: '50% 18%' },
  { name: '微笑', pos: '50% 34%' },
  { name: '困惑', pos: '20% 30%' }
];

const ADVANCED = [
  { title: '角色专属系统提示词', tag: '留空则用通用扮演规则', h: 120, placeholder: '这张卡专属的开场设定与扮演约束', help: '会和通用扮演规则一起发出去。想强调「回答长度」「称呼方式」这类稳定要求，写在这里比写进描述更有效。' },
  { title: '对话后指令', tag: '放在整段对话的最后', h: 96, placeholder: '用来强调格式或语气要求', help: '位置在提示词最末，模型的注意力最高。适合放输出格式要求。' },
  { title: '作者备注', tag: '只给你自己看', h: 96, placeholder: '不会发给模型', help: '不会发送给模型，写给自己看的备忘。' }
];

/* ------------------------------ 通用件 ------------------------------ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function appNav() {
  return `<aside class="app-nav">
    <div class="brand"><img src="assets/brand-logo.png" alt=""><span class="brand-name">如我所书<small>MIMITALE</small></span></div>
    <div class="space-label">创作空间</div>
    <nav aria-label="主导航">
      <button type="button">${ICON.user}<span>角色库</span></button>
      <button type="button">${ICON.book}<span>世界书</span></button>
      <button type="button">${ICON.attr}<span>预设</span></button>
    </nav>
    <div class="nav-foot"><span class="dot"></span><span>本地工作空间</span></div>
  </aside>`;
}

function pageHead(dirty) {
  const state = dirty
    ? '<span class="save-state" data-state="dirty">有未保存的改动</span>'
    : '<span class="save-state" data-state="saved">所有更改已保存</span>';
  const save = dirty
    ? '<button type="button" class="btn btn-primary">保存角色</button>'
    : '<button type="button" class="btn btn-primary" aria-disabled="true">保存角色</button>';
  return `<header class="page-head">
    <div>
      <p class="breadcrumb">角色库 <span>/</span> ${CH.name}</p>
      <h1 class="page-title">编辑角色</h1>
    </div>
    <div class="page-head-right">
      ${state}
      <div class="head-actions">
        <button type="button" class="btn btn-ghost">返回</button>
        ${save}
      </div>
    </div>
  </header>`;
}

function identityRail(dir, section) {
  const nav = SECTIONS.map((s) => `<button type="button" ${s.key === section ? 'aria-selected="true"' : 'aria-selected="false"'}>
      ${ICON[s.icon]}<span class="nav-label">${s.label}</span><span class="nav-count">${s.count}</span>
    </button>`).join('');
  return `<aside class="identity-rail">
    <div class="identity-media">
      <figure class="media-cell">
        <button type="button" class="m-portrait" title="点击上传角色形象"><img src="assets/portrait.jpg" alt="角色形象"></button>
        <figcaption>形象</figcaption>
      </figure>
      <figure class="media-cell">
        <button type="button" class="m-avatar" title="点击上传头像"><img src="assets/portrait.jpg" alt="头像"></button>
        <figcaption>头像</figcaption>
        <button type="button" class="media-clear">清除</button>
      </figure>
    </div>
    <span class="chip chip-accent">${CH.source}</span>
    <label class="field rail-field"><span class="field-label">角色名</span><input type="text" value="${CH.name}"></label>
    <label class="field rail-field"><span class="field-label">标签</span><input type="text" value="${CH.tags}"></label>
    <nav class="section-nav" role="tablist" aria-label="角色编辑分区">${nav}</nav>
    <div class="rail-danger">
      <button type="button" class="btn btn-ghost btn-sm">导出为 PNG 卡</button>
      <button type="button" class="btn btn-ghost btn-sm btn-danger">${ICON.trash}删除角色</button>
    </div>
  </aside>`;
}

function sheet(f, { numbered, index, height, fold = false } = {}) {
  const head = numbered
    ? `<header class="sheet-head"><span class="sheet-num">${index}</span><span class="sheet-title">${f.label}</span>
        <span class="sheet-count">${f.count} 字</span><span class="sheet-tag">${f.tag}</span></header>`
    : `<header class="sheet-head">${ICON[f.icon]}<span class="sheet-title">${f.label}</span>
        <span class="sheet-count">${f.count} 字</span><span class="sheet-tag">${f.tag}</span></header>`;
  const ta = `<textarea spellcheck="false" style="min-height:${height}px" placeholder="${esc(f.placeholder || '')}">${esc(f.text)}</textarea>`;
  const foldHtml = fold
    ? `<details class="v2-fold"><summary>这一栏怎么写</summary><div class="fold-body">${esc(f.help)}</div></details>`
    : '';
  return `<article class="sheet${f.filled ? '' : ' is-empty'}">${head}${ta}${foldHtml}</article>`;
}

/* ==========================================================================
   V1 · 精修版
   结构不动：左栏（身份 + 分区导航）+ 右列。改动集中在右列内部 ——
   顶部胶囊仍在（一次一个字段），但稿纸定型 672px，右侧多一列旁注。
   ========================================================================== */

function v1Notes(f) {
  const i = FIELDS.indexOf(f);
  const prev = FIELDS[i - 1];
  const next = FIELDS[i + 1];
  const step = `<div class="note">
      <div class="note-title">${ICON.arrow}这一步</div>
      <div class="note-steps">
        <button type="button" class="btn btn-ghost btn-sm" ${prev ? '' : 'aria-disabled="true"'}>← ${prev ? prev.label : '已是第一个'}</button>
        <button type="button" class="btn btn-ghost btn-sm" ${next ? '' : 'aria-disabled="true"'}>${next ? next.label : '已是最后一个'} →</button>
      </div>
      <p style="margin-top:8px">第 ${i + 1} / ${FIELDS.length} 栏 · 五个字段随时可以回来改</p>
    </div>`;
  const template = f.template
    ? `<div class="note"><div class="note-title">${ICON.doc}模板</div><button type="button" class="btn btn-soft btn-sm" style="width:100%">${f.template}</button></div>`
    : '';
  return `<div class="v1-notes">
    <div class="note"><div class="note-title">${ICON.tip}这一栏写什么</div><p>${esc(f.help)}</p></div>
    ${template}
    ${step}
    <div class="note"><div class="note-title">${ICON.arrow}会进到哪里</div><p>${esc(f.where)}</p></div>
  </div>`;
}

function v1Writing(activeKey) {
  const tabs = FIELDS.map((f) => `<button type="button" data-field="${f.key}" aria-selected="${f.key === activeKey}" class="${f.filled ? '' : 'tab-empty'}">${f.label} <i>${f.count}</i></button>`).join('');
  const f = FIELDS.find((x) => x.key === activeKey) || FIELDS[0];
  return `<div class="panel-head">
      <div>
        <h2>角色设定</h2>
        <p>五个字段各管一件事，写完这一页，这张卡就立住了</p>
      </div>
      <button type="button" class="btn btn-soft btn-sm">AI 辅助</button>
    </div>
    <div class="segmented" role="tablist" aria-label="角色设定字段">${tabs}</div>
    <div class="v1-grid">
      ${sheet(f, { height: f.v1Height })}
      ${v1Notes(f)}
    </div>`;
}

function v1Attributes() {
  const tabs = ATTR_GROUPS.map((g, i) => `<button type="button" class="attr-tab" aria-selected="${i === 0}">${g.name} <i>${g.count}</i></button>`).join('')
    + '<button type="button" class="attr-tab attr-tab-add">＋ 新分组</button>';
  const rows = ATTR_GROUPS[0].rows.map(([n, v]) => `<div class="attr-row"><span class="attr-name">${n}</span><input type="text" value="${v}"><button type="button" class="icon-btn" title="删除">${ICON.x}</button></div>`).join('');
  return `<div class="panel-head">
      <div><h2>属性</h2><p>这些会进游玩时的「状态」面板，每轮由程序注入给 AI，数值不会漂</p></div>
      <button type="button" class="btn btn-soft btn-sm">套用互动模板</button>
    </div>
    <div class="card">
      <div class="attr-tabs" role="tablist" aria-label="属性分组">${tabs}</div>
      <div class="attr-rows">${rows}</div>
      <div class="attr-add">
        <input type="text" placeholder="加进「状态栏」，比如 金币">
        <button type="button" class="btn btn-ghost btn-sm">添加</button>
        <button type="button" class="btn btn-ghost btn-sm">粘贴文本</button>
      </div>
    </div>
    <div class="card">
      <label class="check">
        <input type="checkbox" checked>
        <span class="check-text">
          <span class="check-title">剧情选项 <span class="state-pill" data-on="true">已启用</span></span>
          <span class="check-desc">每轮让 AI 给几个可点选项，点一下就当你说这句话发出去。取消勾选就是这张卡不要选项。</span>
        </span>
      </label>
      <div class="opt-config">
        <label class="field"><span class="field-label">每轮给几个</span><input type="number" value="4"></label>
        <label class="field"><span class="field-label">额外要求（可选）</span><input type="text" placeholder="比如：语气轻松些、总有一条冒险的选择"></label>
      </div>
    </div>
    <div class="card">
      <label class="check">
        <input type="checkbox">
        <span class="check-text">
          <span class="check-title">在状态栏显示 <span class="state-pill">未启用</span></span>
          <span class="check-desc">勾上之后，这张卡的状态会出现在右栏「在场角色」入口条上。<b>不勾不影响人设</b> —— 描述和性格照样进提示词，只是不占头像位。</span>
        </span>
      </label>
    </div>`;
}

function v1Expressions() {
  const cells = EXPRESSIONS.map((e) => `<figure class="expr-cell"><button type="button"><img src="assets/portrait.jpg" alt="${e.name}" style="object-position:${e.pos}"></button><figcaption>${e.name}</figcaption></figure>`).join('');
  return `<div class="panel-head">
      <div><h2>表情图</h2><p>已设 3 张 · 按触发词自动切换，没命中的用默认脸</p></div>
      <div class="head-actions"><button type="button" class="btn btn-ghost btn-sm">批量导入</button><button type="button" class="btn btn-soft btn-sm">管理表情图</button></div>
    </div>
    <div class="card">
      <div class="expr-grid">${cells}
        <figure class="expr-cell"><button type="button" class="expr-add">${ICON.plus}添加</button></figure>
        <figure class="expr-cell"><button type="button" class="expr-add">${ICON.doc}批量</button></figure>
      </div>
      <p class="help-line" style="margin-top:14px">表情触发词写在「管理表情图」里：AI 回复中带了对应词，气泡旁的头像就换成那张脸。一张卡几十张表情很正常，这里只显示前几张。</p>
    </div>`;
}

function v1Worldbook() {
  return `<div class="panel-head">
      <div><h2>世界书</h2><p>角色自带的世界设定，单独聊或进世界都会一起带上</p></div>
      <button type="button" class="btn btn-soft btn-sm">＋ 绑定世界书</button>
    </div>
    <div class="bound-book">
      <img src="assets/forest.jpg" alt="">
      <div class="bound-main"><div class="bound-title">雾林来信</div><div class="bound-meta">7 条设定 · 5 启用 · 2 常驻</div></div>
      <button type="button" class="btn btn-ghost btn-sm">打开</button>
      <button type="button" class="btn btn-ghost btn-sm">解绑</button>
    </div>
    <div class="card" style="margin-top:14px">
      <label class="check">
        <input type="checkbox" checked>
        <span class="check-text">
          <span class="check-title">启用自带的世界书 <span class="state-pill" data-on="true">已启用</span></span>
          <span class="check-desc">关掉之后，这张角色无论单独聊天、还是被绑进某个世界当角色，都不会带入它自己的世界书（绑定的关系还在，随时可以再打开）。</span>
        </span>
      </label>
    </div>
    <p class="help-line" style="margin-top:14px">导入带 <code>character_book</code> 的角色卡时会自动绑上，也可以在这里手动绑定。一本书可以绑给多张卡。</p>`;
}

function v1Advanced() {
  const cards = ADVANCED.map((a) => `<article class="sheet" style="margin-bottom:14px">
      <header class="sheet-head"><span class="sheet-title">${a.title}</span><span class="sheet-tag">${a.tag}</span></header>
      <textarea spellcheck="false" style="min-height:${a.h}px" placeholder="${a.placeholder}"></textarea>
      <footer class="sheet-foot"><span class="field-help">${a.help}</span></footer>
    </article>`).join('');
  return `<div class="panel-head">
      <div><h2>高级设置</h2><p>角色专属指令与作者备注 —— 多数卡留空就行</p></div>
    </div>
    <div class="v1-grid"><div>${cards}</div>
      <div class="v1-notes">
        <div class="note"><div class="note-title">${ICON.tip}该不该填</div><p>三栏都留空时，这张卡会用全局的通用扮演规则 —— 对多数卡来说这就是最好的选择。</p></div>
        <div class="note"><div class="note-title">${ICON.arrow}会进到哪里</div><p>前两栏会进提示词（第 2 栏在最末，注意力最高）；作者备注永远不发出去。</p></div>
      </div>
    </div>`;
}

const V1 = {
  writing: (s) => v1Writing(s.field || 'desc'),
  attributes: v1Attributes,
  expressions: v1Expressions,
  worldbook: v1Worldbook,
  advanced: v1Advanced
};

/* ==========================================================================
   V2 · 重组版
   五个字段连成一张长稿（不做 tab 切换），右侧多一列「字段目录」。
   写「性格」时能同时看见「描述」——这是这一版存在的理由。
   ========================================================================== */

function v2Writing(s) {
  const flow = FIELDS.map((f, i) => sheet(f, { numbered: true, index: i + 1, height: f.v2Height, fold: true })).join('');
  return `<div class="work-head">
      <h2>角色设定</h2>
      <span class="work-hint">五栏连成一页 · 上下滚着就能对照，不用来回切</span>
    </div>
    <div class="v2-flow">${flow}</div>
    <div class="v2-tail">写到这里就是一张完整的卡了。属性、表情图、世界书都在左栏，需要时再过去 —— 写作顺序建议就按 1 到 5。</div>`;
}

function v2Attributes() {
  const cards = ATTR_GROUPS.map((g, gi) => `<div class="card">
      <div class="card-head"><h3>${g.name}</h3><span class="card-note">${g.count} 项</span></div>
      <div class="attr-rows">${g.rows.map(([n, v]) => `<div class="attr-row"><span class="attr-name">${n}</span><input type="text" value="${v}"><button type="button" class="icon-btn" title="删除">${ICON.x}</button></div>`).join('')}</div>
      <div class="attr-add"><input type="text" placeholder="加进「${g.name}」"><button type="button" class="btn btn-ghost btn-sm">添加</button></div>
      ${gi === 0 ? '<p class="help-line" style="margin-top:10px">也可以用「粘贴文本」把一整段设定一次贴进来，每行一条。</p>' : ''}
    </div>`).join('');
  return `<div class="work-head"><h2>属性</h2><span class="work-hint">三个分组共 9 项 · 每轮由程序注入，数值不会漂</span></div>
    ${cards}
    <div class="card">
      <label class="check"><input type="checkbox" checked><span class="check-text">
        <span class="check-title">剧情选项 <span class="state-pill" data-on="true">已启用</span></span>
        <span class="check-desc">每轮让 AI 给几个可点选项，点一下就当你说这句话发出去。</span></span></label>
      <div class="opt-config">
        <label class="field"><span class="field-label">每轮给几个</span><input type="number" value="4"></label>
        <label class="field"><span class="field-label">额外要求（可选）</span><input type="text" placeholder="比如：语气轻松些"></label>
      </div>
    </div>
    <div class="card">
      <label class="check"><input type="checkbox"><span class="check-text">
        <span class="check-title">在状态栏显示 <span class="state-pill">未启用</span></span>
        <span class="check-desc">勾上之后，这张卡的状态会出现在右栏「在场角色」入口条上。<b>不勾不影响人设</b>。</span></span></label>
    </div>`;
}

function v2Expressions() {
  const cells = EXPRESSIONS.map((e) => `<figure class="expr-cell"><button type="button"><img src="assets/portrait.jpg" alt="${e.name}" style="object-position:${e.pos}"></button><figcaption>${e.name}</figcaption></figure>`).join('');
  return `<div class="work-head"><h2>表情图</h2><span class="work-hint">已设 3 张 · 按触发词自动切换</span></div>
    <div class="card">
      <div class="expr-grid">${cells}
        <figure class="expr-cell"><button type="button" class="expr-add">${ICON.plus}添加</button></figure>
        <figure class="expr-cell"><button type="button" class="expr-add">${ICON.doc}批量</button></figure>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>触发词</h3><span class="card-note">写在管理表情图里</span></div>
      <div class="attr-rows">
        <div class="attr-row"><span class="attr-name">微笑</span><input type="text" value="笑 / 弯起眼睛 / 抿嘴"><button type="button" class="icon-btn">${ICON.x}</button></div>
        <div class="attr-row"><span class="attr-name">困惑</span><input type="text" value="皱眉 / 不解 / 侧过头"><button type="button" class="icon-btn">${ICON.x}</button></div>
      </div>
    </div>`;
}

function v2Worldbook() {
  return `<div class="work-head"><h2>世界书</h2><span class="work-hint">角色自带的世界设定</span></div>
    <div class="bound-book">
      <img src="assets/forest.jpg" alt="">
      <div class="bound-main"><div class="bound-title">雾林来信</div><div class="bound-meta">7 条设定 · 5 启用 · 2 常驻</div></div>
      <button type="button" class="btn btn-ghost btn-sm">打开</button>
      <button type="button" class="btn btn-ghost btn-sm">解绑</button>
    </div>
    <div class="card" style="margin-top:14px">
      <label class="check"><input type="checkbox" checked><span class="check-text">
        <span class="check-title">启用自带的世界书 <span class="state-pill" data-on="true">已启用</span></span>
        <span class="check-desc">关掉之后，这张角色无论单独聊天、还是被绑进某个世界当角色，都不会带入它自己的世界书（绑定的关系还在，随时可以再打开）。</span></span></label>
    </div>
    <div class="card">
      <div class="card-head"><h3>其他可绑定的世界书</h3><span class="card-note">共 3 本</span></div>
      <div class="attr-rows">
        <div class="attr-row"><span class="attr-name">锈钉酒馆</span><input type="text" value="12 条设定 · 已启用 9" readonly><button type="button" class="btn btn-ghost btn-sm">绑定</button></div>
        <div class="attr-row"><span class="attr-name">雨港档案</span><input type="text" value="4 条设定 · 未启用" readonly><button type="button" class="btn btn-ghost btn-sm">绑定</button></div>
      </div>
    </div>`;
}

function v2Advanced() {
  const cards = ADVANCED.map((a) => `<article class="sheet" style="margin-bottom:14px">
      <header class="sheet-head"><span class="sheet-title">${a.title}</span><span class="sheet-tag">${a.tag}</span></header>
      <textarea spellcheck="false" style="min-height:${a.h}px" placeholder="${a.placeholder}"></textarea>
    </article>`).join('');
  return `<div class="work-head"><h2>高级设置</h2><span class="work-hint">多数卡留空就行</span></div>${cards}`;
}

const V2 = {
  writing: v2Writing,
  attributes: v2Attributes,
  expressions: v2Expressions,
  worldbook: v2Worldbook,
  advanced: v2Advanced
};

/* ------------------------------ V2 右栏 ------------------------------ */

function v2FieldIndex(s) {
  const items = FIELDS.map((f, i) => `<button type="button" class="index-item" ${f.key === s.activeField ? 'aria-current="true"' : ''}>
      <span class="idx-no">${i + 1}</span>
      <span class="idx-name">${f.label}</span>
      <span class="idx-len">${f.count}</span>
      <span class="idx-state" data-filled="${f.filled}"></span>
    </button>`).join('');
  return `<aside class="field-index">
    <div class="index-title">字段目录</div>
    ${items}
    <div class="index-block">
      <h3>这一页会进到哪里</h3>
      <ul class="index-inject">
        <li>描述 + 性格：每轮都注入</li>
        <li>场景：只在开场注入一次</li>
        <li>开场白：绑定时作为第一条消息</li>
        <li>示例对话：作为语气样例注入</li>
      </ul>
    </div>
    <div class="index-block">
      <h3>还没写</h3>
      <p>「示例对话」是空的。它不影响能不能玩，但补上之后语气会准很多。</p>
    </div>
  </aside>`;
}

function v2SidePanel(s) {
  if (s.section === 'writing') return v2FieldIndex(s);
  const blocks = {
    attributes: `<div class="preview-card">
        <h3>状态栏长这样</h3>
        <div class="preview-row"><span>体力</span><span>72 / 100</span></div>
        <div class="preview-bar"><i></i></div>
        <div class="preview-row"><span>情绪</span><span>平静</span></div>
        <div class="preview-row"><span>信任度</span><span>12</span></div>
        <div class="preview-row"><span>未寄出的信</span><span>3 封</span></div>
      </div>
      <div class="index-block"><h3>分组一览</h3><ul class="index-inject">
        <li>状态栏 · 4 项（会显示）</li><li>关系 · 2 项（会显示）</li><li>背包 · 3 项（会显示）</li>
      </ul></div>
      <div class="index-block"><h3>剧情选项</h3><p>已启用，每轮 4 个。想让选项更冒险，可以在「额外要求」里写一句。</p></div>`,
    expressions: `<div class="index-block"><h3>命中规则</h3><p>AI 回复中带触发词 → 换那张脸；多张同时命中时取最靠前的一张。</p></div>
      <div class="index-block"><h3>已设 3 张</h3><ul class="index-inject"><li>平静 · 默认（一定命中）</li><li>微笑 · 3 个触发词</li><li>困惑 · 3 个触发词</li></ul></div>
      <div class="index-block"><h3>没设的表情</h3><p>没命中的时候统一用默认脸，不会突然换脸。</p></div>`,
    worldbook: `<div class="index-block"><h3>本书摘要</h3><ul class="index-inject"><li>雾林来信 · 7 条</li><li>启用 5 · 常驻 2</li><li>导入时自动绑定</li></ul></div>
      <div class="index-block"><h3>什么时候生效</h3><p>单独跟这张卡聊天、或把它绑进某个世界当角色，都会带上。关掉开关就都不带。</p></div>`,
    advanced: `<div class="index-block"><h3>三栏的区别</h3><ul class="index-inject"><li>专属提示词：进系统提示</li><li>对话后指令：进最末，注意力最高</li><li>作者备注：只给自己看</li></ul></div>
      <div class="index-block"><h3>留空也没关系</h3><p>多数卡这三栏都是空的，会用全局的通用扮演规则。</p></div>`
  };
  return `<aside class="field-index">${blocks[s.section] || ''}</aside>`;
}

/* ------------------------------ frame 组装 ------------------------------ */

function buildFrame(s) {
  const el = document.createElement('div');
  el.className = 'frame';
  el.dataset.shot = s.name;
  el.dataset.dir = s.dir;
  const render = s.dir === 'v1' ? V1 : V2;
  const work = render[s.section](s);
  const wrap = s.dir === 'v1' && s.section === 'writing' ? '' : s.dir === 'v1' ? ' style="max-width:880px"' : '';
  const side = s.dir === 'v2' ? v2SidePanel(s) : '';
  el.innerHTML = `<div class="shell">
    ${appNav()}
    <div class="stage">
      ${pageHead(!!s.dirty)}
      <div class="char-body">
        ${identityRail(s.dir, s.section)}
        <div class="work scroll-y"${wrap}>${work}</div>
        ${side}
      </div>
    </div>
  </div>`;
  document.body.append(el);
  if (s.scroll) {
    const w = el.querySelector('.work');
    w.scrollTop = s.scroll;
  }
  return el;
}

/* ------------------------------ 出图清单 ------------------------------ */

const SHOTS = [
  // ---------- V1 · 精修版 ----------
  { name: 'v1-01-writing-desc', dir: 'v1', section: 'writing', field: 'desc', dirty: true },
  { name: 'v1-02-writing-personality', dir: 'v1', section: 'writing', field: 'personality', dirty: true },
  { name: 'v1-03-writing-scenario', dir: 'v1', section: 'writing', field: 'scenario', dirty: true },
  { name: 'v1-04-writing-first', dir: 'v1', section: 'writing', field: 'first', dirty: true },
  { name: 'v1-05-writing-example', dir: 'v1', section: 'writing', field: 'example', dirty: false },
  { name: 'v1-06-attributes', dir: 'v1', section: 'attributes', dirty: true },
  { name: 'v1-07-expressions', dir: 'v1', section: 'expressions', dirty: false },
  { name: 'v1-08-worldbook', dir: 'v1', section: 'worldbook', dirty: true },
  { name: 'v1-09-advanced', dir: 'v1', section: 'advanced', dirty: false },
  // ---------- V2 · 重组版 ----------
  { name: 'v2-01-writing-top', dir: 'v2', section: 'writing', activeField: 'desc', dirty: true },
  { name: 'v2-02-writing-mid', dir: 'v2', section: 'writing', activeField: 'scenario', dirty: true, scroll: 430 },
  { name: 'v2-03-writing-bottom', dir: 'v2', section: 'writing', activeField: 'example', dirty: true, scroll: 9999 },
  { name: 'v2-04-attributes', dir: 'v2', section: 'attributes', dirty: true },
  { name: 'v2-05-expressions', dir: 'v2', section: 'expressions', dirty: false },
  { name: 'v2-06-worldbook', dir: 'v2', section: 'worldbook', dirty: true },
  { name: 'v2-07-advanced', dir: 'v2', section: 'advanced', dirty: false },
  // ---------- 白天主题对照 ----------
  { name: 'v1-10-writing-desc-light', dir: 'v1', section: 'writing', field: 'desc', dirty: true, light: true },
  { name: 'v1-11-attributes-light', dir: 'v1', section: 'attributes', dirty: true, light: true },
  { name: 'v2-08-writing-top-light', dir: 'v2', section: 'writing', activeField: 'desc', dirty: true, light: true },
  { name: 'v2-09-attributes-light', dir: 'v2', section: 'attributes', dirty: true, light: true }
];

SHOTS.forEach(buildFrame);

window.__mock = {
  theme(value) { document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark'; },
  shots: SHOTS.map((s) => ({ name: s.name, light: !!s.light, scroll: s.scroll || 0 }))
};
