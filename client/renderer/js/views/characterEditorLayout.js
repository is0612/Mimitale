'use strict';

import { iconHtml } from '../ui/icons.js';

//  角色编辑页的骨架：左栏（资料 + 分区导航）／内容列／右栏字段目录。
//  ⚠️ 只搬运已有控件，绝不克隆 —— id / 值 / 监听器都得原样留着。
//  第三列（字段目录）只在「角色卡设定」展开。

let layout = null;

// 分区导航的图标：只留名字，形状在 ui/icons.js 的注册表里。
const SECTION_ICONS = {
  writing: 'file-text',
  roles: 'users',
  worldbook: 'book-open',
  advanced: 'settings'
};

/** ⚠️ 顺序三处一致：这里 = index.html 里 .field-no 写的序号 = 右栏目录的序号。 */
const FIELD_SPECS = [
  ['desc', '角色卡描述'],
  ['scenario', '场景'],
  ['first', '开场白'],
  ['example', '示例对话']
];

/** 高级设置那三栏的 id。只用来数「填了几栏」，不搬运 */
const ADVANCED_FIELDS = ['c-system', 'c-post', 'c-notes'];

/** 四个分区：[key, 标题, 说明]。⚠️ 说明只喂给内容列的标题，不喂给左栏导航。 */
const SECTIONS = [
  ['writing', '角色卡设定', '几栏连成一页，上下滚着就能对照'],
  ['roles', '人物列表', '这本书里的人物副本，和角色卡相互独立'],
  ['worldbook', '世界书', '绑定角色自带的世界设定'],
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
  const sourceChip = node('span', 'chip char-source-chip');
  identity.append(media, sourceChip, identityFields);

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
      const btnAi = node('button', 'char-book-roles-btn', 'AI 生成');
      btnAi.type = 'button';
      btnAi.id = 'btn-char-roles-ai';
      const btnNew = node('button', 'char-book-roles-btn', '＋ 新建');
      btnNew.type = 'button';
      btnNew.id = 'btn-char-roles-new';
      bar.append(btnAi, btnNew);
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

  // ------------------------------------------------- 写作字段：全部常显
  const writing = sections.get('writing');
  const fieldItems = [];
  for (const [key, title] of FIELD_SPECS) {
    const control = document.getElementById(`c-${key}`);
    const field = control ? control.closest('.char-sheet') : null;
    if (!field) continue;
    writing.append(field);
    fieldItems.push({ key, title, field, control });
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

  // --------------------------------------------------- 右栏：字段目录
  const index = node('aside', 'char-field-index');
  index.id = 'char-field-index';
  index.setAttribute('aria-label', '角色卡设定字段目录');
  index.append(node('div', 'field-index-title', '字段目录'));
  const indexItems = [];
  for (let i = 0; i < fieldItems.length; i += 1) {
    const item = fieldItems[i];
    const button = node('button', 'field-index-item');
    button.type = 'button';
    button.dataset.key = item.key;
    const len = node('span', 'field-index-len', '—');
    const dot = node('span', 'field-index-dot');
    dot.dataset.filled = 'false';
    button.append(
      node('span', 'field-index-no', String(i + 1)),
      node('span', 'field-index-name', item.title),
      len,
      dot
    );
    button.addEventListener('click', () => {
      item.field.scrollIntoView({ block: 'start' });
      setCurrentIndex(item.key);
    });
    index.append(button);
    indexItems.push({ key: item.key, title: item.title, field: item.field, control: item.control, button, len, dot });
  }
  const inject = node('div', 'field-index-block');
  inject.innerHTML = '<h3>这一页会进到哪里</h3><ul class="field-index-list">'
    + '<li>角色卡描述：每轮都注入</li>'
    + '<li>场景：只在开场注入一次</li>'
    + '<li>开场白：绑定时作为第一条消息</li>'
    + '<li>示例对话：作为语气样例注入</li>'
    + '</ul>';
  index.append(inject);

  form.append(identity, main, index);
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
    // 三栏只在「角色卡设定」展开（CSS 按这个属性挑栅格）
    form.dataset.editorSection = key;
    onReveal();
    if (key === 'writing') syncCurrentIndex();
    return true;
  }

  /** 高亮「当前在看的那一栏」 */
  function setCurrentIndex(key) {
    for (const item of indexItems) item.button.setAttribute('aria-current', String(item.key === key));
  }

  /** 用 scroll 而非 IntersectionObserver 算当前栏：五栏比 rect 更简单，也不会僵在上一次。 */
  function syncCurrentIndex() {
    if (!indexItems.length || form.dataset.editorSection !== 'writing') return;
    const line = main.getBoundingClientRect().top + 12;
    let current = indexItems[0];
    for (const item of indexItems) {
      if (item.field.getBoundingClientRect().top <= line) current = item;
    }
    setCurrentIndex(current.key);
  }

  main.addEventListener('scroll', syncCurrentIndex, { passive: true });

  for (const button of sectionButtons) button.addEventListener('click', () => selectSection(button.dataset.key));
  wireTabs(nav, sectionButtons, selectSection);

  layout = { form, main, sections, indexItems, selectSection, onReveal, sourceChip, sectionCounts };

  selectSection('writing');
  refreshCharSectionCounts();
}

/** 刷新徽章与字数 / 圆点。⚠️ 徽章只表示「已有多少条内容」：只有「角色卡设定」用分数；0 也要显示。 */
export function refreshCharSectionCounts() {
  if (!layout) return;
  const filled = layout.indexItems.filter((item) => (item.control.value || '').trim()).length;
  setCharSectionCount('writing', `${filled}/${layout.indexItems.length}`);

  const advanced = ADVANCED_FIELDS
    .map((id) => document.getElementById(id))
    .filter((el) => el && (el.value || '').trim()).length;
  setCharSectionCount('advanced', String(advanced));

  for (const item of layout.indexItems) {
    const value = item.control.value || '';
    // 字数口径与字段角标一致：value.length（不 trim）
    item.len.textContent = value.length ? String(value.length) : '—';
    item.dot.dataset.filled = String(!!value.trim());
  }
}

/** 分区导航右侧的计数徽章：空串就整条藏起来（视图层按草稿实时喂） */
export function setCharSectionCount(key, text) {
  const badge = layout && layout.sectionCounts[key];
  if (!badge) return;
  badge.textContent = text;
  badge.hidden = !text;
}

/** 左栏的来源胶囊（酒馆 PNG 卡 / JSON 角色卡 / 手写）：空串就整条藏起来 */
export function setCharSourceChip(text) {
  if (!layout) return;
  layout.sourceChip.textContent = text;
  layout.sourceChip.hidden = !text;
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
