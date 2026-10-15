'use strict';

// Move existing controls, never clone them: their IDs, values and listeners stay intact.
let layout = null;

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

  const identity = node('aside', 'char-identity-pane');
  identity.setAttribute('aria-label', '角色资料与编辑导航');
  identity.append(media, identityFields);
  const tagHint = node('p', 'char-identity-hint', '使用逗号分隔标签');
  identity.append(tagHint);
  const nav = node('div', 'char-section-nav');
  nav.id = 'char-section-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', '角色编辑分区');
  nav.setAttribute('aria-orientation', 'vertical');
  identity.append(nav);
  const main = node('div', 'char-editor-content');
  const sections = new Map();
  const sectionButtons = [];
  const specs = [
    ['writing', '角色设定', '用于角色扮演的背景与表达'],
    ['state', '属性', '管理角色的初始状态与互动选项'],
    ['expressions', '表情图', '管理角色的表情与触发词'],
    ['worldbook', '世界书', '绑定角色自带的世界设定'],
    ['advanced', '高级设置', '角色专属指令与作者备注']
  ];
  for (const [key, title, description] of specs) {
    const button = node('button', 'char-section-button', title);
    button.type = 'button';
    button.id = `char-section-tab-${key}`;
    button.dataset.key = key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `char-section-${key}`);
    const panel = node('section', 'char-editor-panel');
    panel.id = `char-section-${key}`;
    panel.dataset.section = key;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    const heading = node('header', 'char-panel-heading');
    heading.append(node('h2', '', title), node('p', '', description));
    panel.append(heading);
    nav.append(button);
    main.append(panel);
    sections.set(key, panel);
    sectionButtons.push(button);
  }

  const writing = sections.get('writing');
  const writingTabs = node('div', 'char-writing-tabs');
  writingTabs.id = 'char-writing-tabs';
  writingTabs.setAttribute('role', 'tablist');
  writingTabs.setAttribute('aria-label', '角色设定字段');
  writing.append(writingTabs);
  const fields = new Map();
  const fieldButtons = [];
  for (const [key, title] of [['desc', '基本描述'], ['personality', '性格'], ['scenario', '场景'], ['first', '开场白'], ['example', '示例对话']]) {
    const control = document.getElementById(`c-${key}`);
    const field = control?.closest('label, .field');
    if (!field) continue;
    const button = node('button', 'char-writing-tab', title);
    button.type = 'button';
    button.id = `char-writing-tab-${key}`;
    button.dataset.key = key;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `char-writing-${key}`);
    const panel = node('div', 'char-writing-panel');
    panel.id = `char-writing-${key}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panel.append(field);
    if (key === 'first') {
      const alternate = document.getElementById('c-alt-field');
      if (alternate) panel.append(alternate);
    }
    writingTabs.append(button);
    writing.append(panel);
    fields.set(key, panel);
    fieldButtons.push(button);
  }
  sections.get('state').append(text);
  sections.get('expressions').append(expressions);
  sections.get('worldbook').append(worldbook);
  sections.get('advanced').append(advanced);
  form.append(identity, main);
  form.classList.add('char-editor-layout');

  function selectSection(key) {
    if (!sections.has(key)) return false;
    for (const [name, panel] of sections) panel.hidden = name !== key;
    for (const button of sectionButtons) {
      const active = button.dataset.key === key;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    if (key === 'advanced') advanced.open = true;
    form.dataset.editorSection = key;
    onReveal();
    return true;
  }
  function selectField(key) {
    if (!fields.has(key)) return false;
    for (const [name, panel] of fields) panel.hidden = name !== key;
    for (const button of fieldButtons) {
      const active = button.dataset.key === key;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    form.dataset.writingField = key;
    onReveal();
    return true;
  }
  for (const button of sectionButtons) button.addEventListener('click', () => selectSection(button.dataset.key));
  for (const button of fieldButtons) button.addEventListener('click', () => selectField(button.dataset.key));
  wireTabs(nav, sectionButtons, selectSection);
  wireTabs(writingTabs, fieldButtons, selectField);
  layout = { form, sections, fields, selectSection, selectField, onReveal };
  selectField('desc');
  selectSection('writing');
}

/** Reveal a control before focusing or interacting with a field in a hidden panel. */
export function showCharacterField(target, { focus = false } = {}) {
  const control = typeof target === 'string'
    ? document.getElementById(target.replace(/^#/, ''))
    : target;
  if (!layout || !control || !layout.form.contains(control)) return false;
  for (const [key, panel] of layout.fields) {
    if (panel.contains(control)) layout.selectField(key);
  }
  for (const [key, panel] of layout.sections) {
    if (panel.contains(control)) layout.selectSection(key);
  }
  for (let parent = control.parentElement; parent && parent !== layout.form; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  layout.onReveal();
  if (focus) control.focus();
  return true;
}
