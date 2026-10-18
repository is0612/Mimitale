'use strict';

// ============================================================================
//  角色编辑页的骨架：左栏（资料 + 分区导航）／内容列／右侧字段目录
//
//  结构：五个写作字段全部常显在「角色设定」里，上下滚就能互相参照；
//  栅格是三栏，第三列是字段目录，只在「角色设定」展开（其余分区仍是两栏）；
//  左栏底部放 .char-rail-foot（导出 / 删除角色）。
//
//  从头到尾守一条：**只搬运已有控件，绝不克隆** —— id / 值 / 监听器都得原样留着。
// ============================================================================

let layout = null;

// 分区导航的图标（内联 SVG，描边 24×24）。改动只影响这里和 CSS，不碰控件 ID。
const SECTION_ICONS = {
  writing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  state: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/></svg>',
  expressions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.6h.01M15 9.6h.01" stroke-width="2.4"/></svg>',
  worldbook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-13c-4.5 0-6.5.5-8 2Z"/><path d="M12 6.5v13"/></svg>',
  advanced: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 0-14.14 0M4.93 19.07a10 10 0 0 0 14.14 0M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>'
};

/**
 * 五个写作字段的顺序。
 * ⚠️ 三处必须一致：这里的顺序 = index.html 里 .field-no 写的序号 = 右栏目录的序号。
 */
const FIELD_SPECS = [
  ['desc', '角色描述'],
  ['personality', '性格'],
  ['scenario', '场景'],
  ['first', '开场白'],
  ['example', '示例对话']
];

/** 高级设置那三栏的 id。只用来数「填了几栏」，不搬运 */
const ADVANCED_FIELDS = ['c-system', 'c-post', 'c-notes'];

/**
 * 五个分区：[key, 标题, 标题下那句说明]。
 *
 * ⚠️ 说明只喂给内容列的标题，**不喂给左栏导航** —— 同一句话显示两处是重复，
 *    而且窄窗口下左栏那份会被媒体查询整条藏掉，可见性还会随窗口高度跳变。
 */
const SECTIONS = [
  ['writing', '角色设定', '五栏连成一页，上下滚着就能对照'],
  ['state', '属性', '管理角色的初始状态与互动选项'],
  ['expressions', '表情图', '管理角色的表情与触发词'],
  ['worldbook', '世界书', '绑定角色自带的世界设定'],
  ['advanced', '高级设置', '角色专属指令与作者备注']
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
  const text = form.querySelector('.char-text-section');
  const identityFields = form.querySelector('.char-head-fields');
  const expressions = form.querySelector('.char-expr-entry');
  const worldbook = document.getElementById('c-worldbook-box');
  const advanced = form.querySelector('.char-advanced');
  if (!media || !text || !identityFields || !expressions || !worldbook || !advanced) return;

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
    icon.innerHTML = SECTION_ICONS[key] || '';
    const count = node('span', 'char-section-count');
    button.append(icon, node('span', 'char-section-label', title), count);
    sectionCounts[key] = count;

    const panel = node('section', 'char-editor-panel');
    panel.id = `char-section-${key}`;
    panel.dataset.section = key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    const heading = node('header', key === 'writing' ? 'char-panel-heading is-work' : 'char-panel-heading');
    heading.append(node('h2', '', title), node('p', '', description));
    panel.append(heading);

    nav.append(button);
    main.append(panel);
    sections.set(key, panel);
    sectionButtons.push(button);
  }
  identity.append(nav);

  // 底部那三样（来源提示 / 导出 / 删除角色）放进左栏底部。
  // ⚠️ 搬的是**节点本身**，id 不许改 —— characterEditor.js 按 id 直接取用。
  const railFoot = document.getElementById('char-rail-foot');
  if (railFoot) identity.append(railFoot);

  // ------------------------------------------------- 五个写作字段：全部常显
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

  // 其余分区照旧：属性那块 / 表情入口 / 世界书 / 高级设置各归各位
  sections.get('state').append(text);
  sections.get('expressions').append(expressions);
  sections.get('worldbook').append(worldbook);
  sections.get('advanced').append(advanced);

  // --------------------------------------------------- 右栏：字段目录
  const index = node('aside', 'char-field-index');
  index.id = 'char-field-index';
  index.setAttribute('aria-label', '角色设定字段目录');
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
    + '<li>描述 + 性格：每轮都注入</li>'
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
    // 三栏只在「角色设定」展开（CSS 按这个属性挑栅格）
    form.dataset.editorSection = key;
    onReveal();
    if (key === 'writing') syncCurrentIndex();
    return true;
  }

  /** 高亮「当前在看的那一栏」 */
  function setCurrentIndex(key) {
    for (const item of indexItems) item.button.setAttribute('aria-current', String(item.key === key));
  }

  /**
   * 用 scroll 事件算当前栏，不用 IntersectionObserver ——
   * 一共五栏，每帧比五个 rect 更简单，也不会出现「一格都不相交就停在上一次」的僵局。
   */
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

/**
 * 刷新徽章与目录上的字数 / 已写圆点。
 *
 * **徽章只允许一种含义：这个分区里已经有多少条内容。**
 * 只有「角色设定」有天然总数（五栏），所以只有它用分数；其余报条目数。
 * 0 也要显示出来 —— 隐藏会让人以为「没有这个功能」。
 */
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

/**
 * 把某个控件带到眼前：先切到它所在的分区，再滚进视野。
 *
 * 五个写作字段现在全都可见，所以这里不再需要「翻开某个字段面板」那一步；
 * 保留的只有「折叠条要是收着就先展开」—— 不然滚过去也看不见说明。
 */
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
