'use strict';

import { iconHtml } from '../ui/icons.js';

//  角色编辑页的骨架：左栏（资料 + 分区导航）／内容列。
//  ⚠️ 只搬运已有控件，绝不克隆 —— id / 值 / 监听器都得原样留着。
//  2026-10-27：开场白从「角色卡设定」里独立成一个分区，右栏字段目录随之撤掉
//  （设定只剩两栏，目录没有意义了）。

let layout = null;

// 分区导航的图标：只留名字，形状在 ui/icons.js 的注册表里。
const SECTION_ICONS = {
  writing: 'file-text',
  opening: 'message-circle',
  roles: 'users',
  worldbook: 'book-open',
  advanced: 'settings'
};

/** 顺序 = 字段在每个分区里的排列顺序。第三个元素是「归哪个分区」——
    搬运时按它往不同 panel 里放。
    ⚠️ 示例对话归 writing 不是 opening（2026-10-27 改）：它在 messages.js 里是**每轮**
       作为 user/assistant 样例塞在历史前面的，和「描述」同类（常驻设定）；
       开场白只在绑定时当第一条消息用，两者不是一回事。 */
const FIELD_SPECS = [
  ['desc', '角色卡描述', 'writing'],
  ['scenario', '场景', 'writing'],
  ['example', '示例对话', 'writing'],
  ['first', '开场白', 'opening']
];

/** 高级设置那三栏的 id。只用来数「填了几栏」，不搬运 */
const ADVANCED_FIELDS = ['c-system', 'c-post', 'c-notes'];

/** 五个分区：[key, 标题, 说明]。⚠️ 说明只喂给内容列的标题，不喂给左栏导航。 */
const SECTIONS = [
  // writing 原来的说明是「几栏连成一页，上下滚着就能对照」—— 在解释布局。
  // 界面不该解释自己的摆法（用户看一眼就知道能滚），换成这个分区真正有用的信息。
  ['writing', '角色卡设定', '描述和示例对话每轮都带给 AI，场景只在开场用一次'],
  ['opening', '开场白', '绑定角色时插进对话当第一条；可以多写几条备选让人挑'],
  ['roles', '人物列表', '这本书里的人物副本，和角色卡相互独立'],
  ['worldbook', '世界书', '这张卡自带的世界设定'],
  ['advanced', '高级设置', '角色卡专属指令与作者备注']
];

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}

function wireTabs(bar, buttons, select) {
  bar.addEventListener('keydown', (event) => {
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    select(buttons[next].dataset.key);
    buttons[next].focus();
  });
}

export function initCharacterEditorLayout({ onReveal = () => {} } = {}) {
  const form = document.getElementById('char-form');
  if (!form || layout) return;
  const media = form.querySelector('.char-media-top');
  const textSection = form.querySelector('.char-text-section');
  const identityFields = form.querySelector('.char-head-fields');
  const worldbook = document.getElementById('c-worldbook-box');
  const advanced = form.querySelector('.char-advanced');
  if (!media || !identityFields || !worldbook || !advanced) return;

  // ---------------------------------------------------------------- 左栏
  const identity = node('aside', 'char-identity-pane');
  identity.setAttribute('aria-label', '角色资料与编辑导航');
  // ⚠️ 这里原来还塞了一条来源胶囊（`<span class="chip char-source-chip">酒馆 PNG 卡</span>`），
  //    2026-10-27 星宝要求去掉 —— 它说的是「这个角色从哪儿来的」，写卡时没用，
  //    而且「本书角色副本 / 还没保存的新角色」这两个状态页头标题已经说清楚了。
  identity.append(media, identityFields);

  const nav = node('div', 'char-section-nav');
  nav.id = 'char-section-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', '角色编辑分区');
  nav.setAttribute('aria-orientation', 'vertical');

  const main = node('div', 'char-editor-content');
  const sections = new Map();
  const sectionButtons = [];
  const sectionCounts = {};
  for (const [key, title, description] of SECTIONS) {
    const button = node('button', 'char-section-button');
    button.type = 'button';
    button.id = `char-section-tab-${key}`;
    button.dataset.key = key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `char-section-${key}`);
    const icon = node('span', 'char-section-icon');
    icon.innerHTML = iconHtml(SECTION_ICONS[key]);
    const count = node('span', 'char-section-count');
    button.append(icon, node('span', 'char-section-label', title), count);
    sectionCounts[key] = count;

    const panel = node('section', 'char-editor-panel');
    panel.id = `char-section-${key}`;
    panel.dataset.section = key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    // is-work 五个分区都挂：否则切分区时标题会突然变成两行。
    const heading = node('header', 'char-panel-heading is-work');
    heading.append(node('h2', '', title), node('p', '', description));
    panel.append(heading);

    // 「人物列表」分区：正文是一个卡片网格，由 characterEditor.js 换卡时经
    // renderBookCharacters 填。这里只留宿主，别在标题下再放别的节点。
    if (key === 'roles') {
      const bar = node('div', 'char-book-roles-bar');
      const btnScan = node('button', 'char-book-roles-btn', '识别世界书人物');
      btnScan.type = 'button';
      btnScan.id = 'btn-char-roles-scan';
      const btnAi = node('button', 'char-book-roles-btn', 'AI 生成');
      btnAi.type = 'button';
      btnAi.id = 'btn-char-roles-ai';
      const btnNew = node('button', 'char-book-roles-btn', '＋ 新建');
      btnNew.type = 'button';
      btnNew.id = 'btn-char-roles-new';
      bar.append(btnScan, btnAi, btnNew);
      const roles = node('div', 'char-book-roles');
      roles.id = 'char-book-roles';
      roles.setAttribute('aria-label', '本书人物列表');
      panel.append(bar, roles);
    }

    nav.append(button);
    main.append(panel);
    sections.set(key, panel);
    sectionButtons.push(button);
  }
  identity.append(nav);

  // ⚠️ 搬的是节点本身，id 不许改 —— characterEditor.js 按 id 直接取用。
  const railFoot = document.getElementById('char-rail-foot');
  if (railFoot) identity.append(railFoot);

  // ------------------------------------------------- 写作字段：按分区分组
  const fieldItems = [];
  for (const [key, title, section] of FIELD_SPECS) {
    const control = document.getElementById(`c-${key}`);
    const field = control ? control.closest('.char-sheet') : null;
    if (!field) continue;
    sections.get(section).append(field);
    fieldItems.push({ key, title, section, field, control });
  }
  // 备选开场白跟着「开场白」走（它是那一栏的一部分，不单独占序号）
  const alt = document.getElementById('c-alt-field');
  const firstItem = fieldItems.find((item) => item.key === 'first');
  if (alt && firstItem) firstItem.field.after(alt);

  // 字段（.char-sheet）都搬进 writing 分区后，.char-text-section 成了空容器 ——
  // 它还留在 form 顶层会占掉 grid 第一列，把 identity/main/index 全挤错位，必须摘掉。
  if (textSection) textSection.remove();

  sections.get('worldbook').append(worldbook);
  sections.get('advanced').append(advanced);

  // 右栏字段目录 2026-10-27 撤掉：开场白独立成区之后，「角色卡设定」只剩两栏，
  // 给两栏配一份目录不如直接把两栏摆开。原来这里还有一块「这一页会进到哪里」的说明，
  // 跟着目录一起没了 —— 那只在栏数多、需要导航时才有价值。
  form.append(identity, main);
  form.classList.add('char-editor-layout');

  // ---------------------------------------------------------------- 交互
  function selectSection(key) {
    if (!sections.has(key)) return false;
    for (const [name, panel] of sections) panel.hidden = name !== key;
    for (const button of sectionButtons) {
      const active = button.dataset.key === key;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    // 记一下当前分区（原来 CSS 靠它挑三栏栅格、露出字段目录，两样都没了；
    // 留着当 DOM 状态标记，调试时能一眼看出在哪一屏）
    form.dataset.editorSection = key;
    onReveal();
    return true;
  }

  for (const button of sectionButtons) button.addEventListener('click', () => selectSection(button.dataset.key));
  wireTabs(nav, sectionButtons, selectSection);

  layout = { form, main, sections, fieldItems, selectSection, onReveal, sectionCounts };

  selectSection('writing');
  refreshCharSectionCounts();
}

/** 刷新徽章。⚠️ 徽章只表示「已有多少条内容」：两个写作分区各报「已写 / 共」，高级设置报条数，0 也显示。 */
export function refreshCharSectionCounts() {
  if (!layout) return;
  // 原来靠字段目录的 indexItems 数一份总账（4 栏合一），目录撤掉后没有单一列表了 ——
  // 改成按分区筛：FIELD_SPECS 第三个元素就是它归属的分区。
  for (const key of ['writing', 'opening']) {
    const items = layout.fieldItems.filter((item) => item.section === key);
    if (!items.length) continue;
    const filled = items.filter((item) => (item.control.value || '').trim()).length;
    setCharSectionCount(key, `${filled}/${items.length}`);
  }

  const advanced = ADVANCED_FIELDS
    .map((id) => document.getElementById(id))
    .filter((el) => el && (el.value || '').trim()).length;
  setCharSectionCount('advanced', String(advanced));
}

/** 分区导航右侧的计数徽章：空串就整条藏起来（视图层按草稿实时喂） */
export function setCharSectionCount(key, text) {
  const badge = layout && layout.sectionCounts[key];
  if (!badge) return;
  badge.textContent = text;
  badge.hidden = !text;
}

/** 把控件带到眼前：先切到它所在的分区，再滚进视野（折叠条收着就先展开）。 */
export function showCharacterField(target, { focus = false } = {}) {
  const control = typeof target === 'string'
    ? document.getElementById(target.replace(/^#/, ''))
    : target;
  if (!layout || !control || !layout.form.contains(control)) return false;
  for (const [key, panel] of layout.sections) {
    if (panel.contains(control)) layout.selectSection(key);
  }
  for (let parent = control.parentElement; parent && parent !== layout.form; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  layout.onReveal();
  if (typeof control.scrollIntoView === 'function') control.scrollIntoView({ block: 'center' });
  if (focus) control.focus();
  return true;
}
