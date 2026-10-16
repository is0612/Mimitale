'use strict';

// 两版稿的切换逻辑。只动 .active / aria-selected / hidden / 文案，不改结构。
//   地址栏写法：#a/desc · #a/attrs · #b/writing/desc · #b/attributes
//
// 说明：B 稿中间只有「一格」编辑面，五个字段靠换文案演示 —— 稿子要看的是版式，
// 不是五份不同的 DOM。

const viewA = document.getElementById('view-a');
const viewB = document.getElementById('view-b');

// B 稿五个写作字段的示例内容（和客户端里的示例卡同一份）
const FIELDS = {
  desc: {
    name: '基本描述',
    count: '174 字',
    text: '{{char}}住在雾林边缘的一间旧木屋里，替往来的人保管那些最终能送出的信。\n\n她有一头浅色长发，习惯把袖口挽起，腰后挂着一串旧铜钥匙。说话时会先看一眼对方的眼睛，再慢慢开口。衣袋里总放着一支铅笔和折好的纸。\n\n很少有人知道她从哪里来。她记得每位寄信人的名字，却从不主动谈论自己的过去。遇到陌生人时，她保持礼貌的距离；一旦答应了什么，就会认真做到。',
    help: '想一句话把角色立住，可以在最前面加一行 <code>((…))</code>，里面按 <b>动机 → 障碍 → 代价 → 奖励</b> 写全。障碍写成「玩家本人」的话，你一出现故事就结束了 —— 让障碍落在角色自己身上。'
  },
  personality: {
    name: '性格',
    count: '62 字',
    text: '寡言、守信、慢热。认死理，答应过的事一定做完；对陌生人客气但不亲热。讨厌被催促，被催的时候会更慢。',
    help: '写「她会怎么做」，别写「她很善良」这类评价词 —— 模型照着后者演，容易演成谁都不得罪的老好人。'
  },
  scenario: {
    name: '场景',
    count: '41 字',
    text: '雾林边缘的旧木屋，傍晚。{{user}} 敲门进来，手里攥着一封没写地址的信。',
    help: '交代清时间、地点和 {{user}} 正在做什么。这三样齐了，第一轮就不用模型替你补设定。'
  },
  first: {
    name: '开场白',
    count: '96 字',
    text: '门轴响了一声，她没抬头，只把灯往门口推了推。\n\n“信放桌上就行。”\n\n等了一会儿，她才抬起眼，看了看你手里的东西。',
    help: '骨架三段：<b>定场</b> → <b>登场</b> → <b>话头</b>。最后一段别写满 —— 给出去的话语权越明确，第一轮越好接。'
  },
  example: {
    name: '示例对话',
    count: '0 字',
    text: '',
    help: '每行以 <code>{{user}}:</code> 或 <code>{{char}}:</code> 开头，用 <code>&lt;START&gt;</code> 分隔不同组。'
  }
};

// B 稿分区标题
const SECTION_TITLE = {
  writing: '角色设定',
  attributes: '属性',
  expressions: '表情图',
  worldbook: '世界书',
  advanced: '高级设置'
};

const bSeg = document.getElementById('b-seg');
const bNav = document.getElementById('b-nav');
const bBody = document.getElementById('b-body');
const bFieldInput = document.getElementById('b-field-input');
const bFieldName = document.getElementById('b-field-name');
const bFieldCount = document.getElementById('b-field-count');
const bFieldHelp = document.getElementById('b-field-help');
const bWorkTitle = document.getElementById('b-work-title');

const writingPanel = document.getElementById('b-panel-writing');
const otherPanels = {
  attributes: document.getElementById('b-panel-attributes'),
  expressions: document.getElementById('b-panel-expressions'),
  worldbook: document.getElementById('b-panel-worldbook'),
  advanced: document.getElementById('b-panel-advanced')
};

/** 把哈希里的 A 稿锚点滚进视野（直接改 scrollTop，不用平滑滚动，截图才准） */
function scrollToAnchor(key) {
  const doc = document.getElementById('a-doc');
  const target = document.getElementById('a-' + key);
  if (!doc || !target) return;
  // 让目标段落在滚动容器的内容区顶边对齐（doc.scrollTop 在调用前已被归零）
  const pad = parseFloat(getComputedStyle(doc).paddingTop) || 0;
  doc.scrollTop = Math.max(0, target.getBoundingClientRect().top - doc.getBoundingClientRect().top - pad);
  for (const item of doc.parentElement.querySelectorAll('.outline-item')) item.classList.remove('is-current');
  const link = document.querySelector(`.outline-item[data-anchor="${key}"]`);
  if (link) link.classList.add('is-current');
}

function showWritingField(key) {
  const data = FIELDS[key] || FIELDS.desc;
  bFieldName.textContent = data.name;
  bFieldCount.textContent = data.count;
  bFieldHelp.innerHTML = data.help;
  bFieldInput.value = data.text;
  for (const button of bSeg.querySelectorAll('[data-field]')) {
    button.setAttribute('aria-selected', String(button.dataset.field === key));
  }
}

function showSection(key) {
  const writing = key === 'writing';
  writingPanel.hidden = !writing;
  writingPanel.classList.toggle('hidden', !writing);
  for (const [name, panel] of Object.entries(otherPanels)) {
    if (!panel) continue;
    const on = name === key;
    panel.hidden = !on;
    panel.classList.toggle('hidden', !on);
  }
  bWorkTitle.textContent = SECTION_TITLE[key] || '角色设定';
  bSeg.style.display = writing ? '' : 'none';
  for (const button of bNav.querySelectorAll('[data-section]')) {
    button.setAttribute('aria-selected', String(button.dataset.section === key));
  }
}

function apply() {
  const parts = (location.hash.replace(/^#/, '') || 'a/desc').split('/');
  const key = parts[0] === 'b' ? 'b' : 'a';
  viewA.classList.toggle('active', key === 'a');
  viewB.classList.toggle('active', key === 'b');

  if (key === 'a') {
    // 切过来先把滚动位置归零，再按锚点滚 —— 否则上一张图的滚动位置会带过来
    const doc = document.getElementById('a-doc');
    doc.scrollTop = 0;
    if (parts[1]) requestAnimationFrame(() => scrollToAnchor(parts[1]));
  } else {
    const section = parts[1] || 'writing';
    showSection(section);
    showWritingField(section === 'writing' ? (parts[2] || 'desc') : 'desc');
  }
}

window.__mock = {
  theme(value) { document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark'; },
  a(anchor) { location.hash = `#a/${anchor || 'desc'}`; },
  b(section, field) { location.hash = `#b/${section}${field ? '/' + field : ''}`; },
  hideMirror(on) { bBody.classList.toggle('is-mirror-hidden', !!on); }
};

document.addEventListener('click', (event) => {
  const anchor = event.target.closest('[data-anchor]');
  if (anchor) {
    event.preventDefault();
    location.hash = `#a/${anchor.dataset.anchor}`;
    return;
  }
  const section = event.target.closest('[data-section]');
  if (section) { location.hash = `#b/${section.dataset.section}`; return; }
  const field = event.target.closest('[data-field]');
  if (field) { location.hash = `#b/writing/${field.dataset.field}`; return; }
  if (event.target.closest('#b-mirror-toggle')) {
    bBody.classList.toggle('is-mirror-hidden');
  }
});

window.addEventListener('hashchange', apply);
apply();
