'use strict';

import { iconHtml } from '../ui/icons.js';

//  本书角色编辑页的骨架：左栏（资料 + 分区导航）／内容列。
//  从 characterEditorLayout.js 复制；DOM id 全部走 bc- 前缀。
//  ⚠️ 只搬运已有控件，绝不克隆 —— id / 值 / 监听器都得原样留着。
//  右栏字段目录已撤：本书角色只负责介绍角色内容，就一栏写作字段，目录没意义。
//  「世界书」分区也撤了：世界书是角色卡的，人物不自带书。

let layout = null;

// 分区导航的图标：只留名字，形状在 ui/icons.js 的注册表里。
const SECTION_ICONS = {
  writing: 'file-text',
  state: 'sliders-horizontal',
  expressions: 'smile',
  advanced: 'settings'
};

/** ⚠️ 顺序两处一致：这里 = index.html 里 .field-no 写的序号。 */
const FIELD_SPECS = [
  ['desc', '角色描述']
];

/** 高级设置那三栏的 id。只用来数「填了几栏」，不搬运 */
const ADVANCED_FIELDS = ['bc-c-system', 'bc-c-post', 'bc-c-notes'];

/** 四个分区：[key, 标题, 说明]。⚠️ 说明只喂给内容列的标题，不喂给左栏导航。 */
const SECTIONS = [
  ['writing', '角色描述', '这一栏交代角色的身份、外貌、经历与性格'],
  ['state', '属性', '管理角色的初始状态与互动选项'],
  ['expressions', '表情图', '管理角色的表情与触发词'],
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
  const form = document.getElementById('bc-char-form');
  if (!form || layout) return;
  const media = form.querySelector('.char-media-top');
  const text = form.querySelector('.char-text-section');
  const identityFields = form.querySelector('.char-head-fields');
  const expressions = form.querySelector('.char-expr-entry');
  const advanced = form.querySelector('.char-advanced');
  if (!media || !text || !identityFields || !expressions || !advanced) return;

  // ---------------------------------------------------------------- 左栏
  const identity = node('aside', 'char-identity-pane');
  identity.setAttribute('aria-label', '角色资料与编辑导航');
  // 来源胶囊 2026-10-27 去掉（理由同 characterEditorLayout.js）
  identity.append(media, identityFields);

  const nav = node('div', 'char-section-nav');
  nav.id = 'bc-char-section-nav';
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
    button.id = `bc-char-section-tab-${key}`;
    button.dataset.key = key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `char-section-${key}`);
    const icon = node('span', 'char-section-icon');
    icon.innerHTML = iconHtml(SECTION_ICONS[key]);
    const count = node('span', 'char-section-count');
    button.append(icon, node('span', 'char-section-label', title), count);
    sectionCounts[key] = count;

    const panel = node('section', 'char-editor-panel');
    panel.id = `bc-char-section-${key}`;
    panel.dataset.section = key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    // is-work 五个分区都挂：否则切分区时标题会突然变成两行。
    const heading = node('header', 'char-panel-heading is-work');
    heading.append(node('h2', '', title), node('p', '', description));
    panel.append(heading);

    nav.append(button);
    main.append(panel);
    sections.set(key, panel);
    sectionButtons.push(button);
  }
  identity.append(nav);

  // ⚠️ 搬的是节点本身，id 不许改 —— characterEditor.js 按 id 直接取用。
  const railFoot = document.getElementById('bc-char-rail-foot');
  if (railFoot) identity.append(railFoot);

  // ------------------------------------------------- 一个写作字段：常显
  const writing = sections.get('writing');
  const fieldItems = [];
  for (const [key, title] of FIELD_SPECS) {
    const control = document.getElementById(`bc-c-${key}`);
    const field = control ? control.closest('.char-sheet') : null;
    if (!field) continue;
    writing.append(field);
    fieldItems.push({ key, title, field, control });
  }

  sections.get('state').append(text);
  sections.get('expressions').append(expressions);
  sections.get('advanced').append(advanced);

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

/** 刷新徽章与字数。⚠️ 徽章只表示「已有多少条内容」：只有「角色描述」用分数；0 也要显示。 */
export function refreshCharSectionCounts() {
  if (!layout) return;
  const filled = layout.fieldItems.filter((item) => (item.control.value || '').trim()).length;
  setCharSectionCount('writing', `${filled}/${layout.fieldItems.length}`);

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
