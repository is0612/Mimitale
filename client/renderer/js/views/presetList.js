'use strict';

import { el } from '../core/dom.js';
import { button, h, renderListPage } from '../ui/build.js';
import { mButton } from '../components/index.js';
import { dialoguePresets } from '../data/library.js';

let openEditor = () => {};
let removePreset = () => {};
let exportOne = () => {};
let query = '';
let status = 'all';

export function initPresetList(injected) {
  openEditor = injected?.openEditor || (() => {});
  removePreset = injected?.remove || (() => {});
  exportOne = injected?.exportOne || (() => {});
  const page = el.presetPageGrid.closest('#view-presets');
  page.querySelector('#preset-search').addEventListener('input', (event) => {
    query = event.target.value;
    renderPresetPage();
  });
  page.querySelectorAll('[data-preset-filter]').forEach((item) => {
    item.addEventListener('click', () => {
      status = item.dataset.presetFilter;
      renderPresetPage();
    });
  });
}

export function renderPresetPage() {
  const all = dialoguePresets();
  const needle = query.trim().toLocaleLowerCase();
  const list = all.filter((preset) => {
    const enabled = preset.enabled !== false;
    return (status === 'all' || enabled === (status === 'enabled')) &&
      [preset.name, preset.note, ...(Array.isArray(preset.tags) ? preset.tags : [])].join(' ').toLocaleLowerCase().includes(needle);
  });
  renderListPage({
    grid: el.presetPageGrid,
    empty: el.presetPageEmpty,
    sub: el.presetPageSub,
    subText: `共 ${all.length} 个预设 · 在会话的「视角」里选用`,
    items: list,
    card: presetRow
  });
  const page = el.presetPageGrid.closest('#view-presets');
  page.querySelectorAll('[data-preset-filter]').forEach((item) => {
    const active = item.dataset.presetFilter === status;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
  const title = el.presetPageEmpty.querySelector('.page-empty-title');
  const hint = el.presetPageEmpty.querySelector('.page-empty-hint');
  title.textContent = all.length ? '没有匹配的预设' : '还没有预设';
  hint.textContent = all.length ? '调整搜索词或筛选条件。' : '新建或导入预设。';
}

function presetRow(preset) {
  const summary = preset.note || String(preset.content || '').split('\n').map((line) => line.trim()).find(Boolean) || '（空预设）';
  const tags = (Array.isArray(preset.tags) ? preset.tags : []).filter(Boolean);
  const heading = h('div', { class: 'preset-row-heading' },
    h('span', { class: 'preset-row-name', text: preset.name }),
    preset.global === true && h('span', { class: 'preset-row-badge', text: '全局' })
  );
  return h('article', { class: 'preset-row', role: 'listitem' },
    h('div', { class: 'preset-row-main' }, heading,
      h('p', { class: 'preset-row-summary', text: summary, title: String(preset.content || '') }),
      tags.length > 0 && h('div', { class: 'preset-row-tags', text: tags.join(' · ') })
    ),
    h('div', { class: 'preset-row-state' },
      h('span', { text: preset.enabled === false ? '已停用' : '已启用' }),
      h('small', { text: preset.global === true ? '未配置的会话自动带上' : '按会话选用' })
    ),
    h('div', { class: 'preset-row-actions' },
      mButton({ variant: 'ghost', size: 'sm', text: '编辑', onClick: () => openEditor(preset.id) }),
      mButton({ variant: 'ghost', size: 'sm', text: '导出', onClick: () => exportOne(preset.id) }),
      mButton({
        variant: 'ghost',
        size: 'sm',
        class: 'preset-row-delete',
        text: '删除',
        ariaLabel: `删除预设：${preset.name}`,
        onClick: () => removePreset(preset.id)
      })
    )
  );
}
