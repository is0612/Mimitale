// Layout only: original controls retain their IDs, values and event handlers.
let layout;

export function initWorldbookLayout({ onFilter }) {
  if (layout) return;
  const root = document.getElementById('view-wb-editor');
  const wrap = document.getElementById('wb-book-wrap');
  const book = root.querySelector('.wb-book');
  const entries = root.querySelector('.wb-entries');
  const main = root.querySelector('.wb-main');
  const chars = root.querySelector('.wb-chars');
  const make = (tag, className, id, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (id) node.id = id;
    if (text) node.textContent = text;
    return node;
  };
  const bar = make('div', 'wb-bookbar', 'wb-bookbar');
  const summary = make('div', 'wb-summary');
  const cover = make('div', 'wb-summary-cover', 'wb-summary-cover');
  const summaryText = make('div', 'wb-summary-text');
  const name = make('strong', '', 'wb-summary-name');
  const count = make('small', '', 'wb-summary-count');
  summaryText.append(name, count);
  summary.append(cover, summaryText);
  const tabs = make('nav', 'wb-tabs', 'wb-tabs');
  tabs.setAttribute('aria-label', '世界书分区');
  const workspace = make('div', 'wb-workspace', 'wb-panel-entries');
  workspace.append(entries, main);
  const characterPanel = make('section', 'wb-character-panel', 'wb-panel-characters');
  characterPanel.append(chars);
  book.id = 'wb-panel-settings';
  const panels = { entries: workspace, settings: book, characters: characterPanel };
  const buttons = {};
  for (const [key, label] of [['entries', '条目'], ['settings', '书籍设置'], ['characters', '本书角色']]) {
    const tab = make('button', 'wb-tab', `wb-tab-${key}`, label);
    tab.type = 'button';
    tab.setAttribute('aria-controls', panels[key].id);
    tab.addEventListener('click', () => setWorldbookPanel(key));
    buttons[key] = tab;
    tabs.append(tab);
  }
  bar.append(summary, tabs);
  wrap.replaceChildren(bar, workspace, book, characterPanel);
  // Book-level commands stay available independently of the selected tab.
  const actions = root.querySelector('.page-actions');
  actions.insertBefore(document.getElementById('btn-preview-wb'), document.getElementById('btn-close-worldbooks'));
  actions.insertBefore(document.getElementById('btn-export-wb'), document.getElementById('btn-close-worldbooks'));
  root.querySelector('.wb-book-actions').remove();
  const search = make('input', 'wb-search', 'wb-search');
  search.type = 'search';
  search.placeholder = '搜索条目';
  search.setAttribute('aria-label', '搜索条目');
  const filter = make('select', 'wb-state', 'wb-state');
  filter.setAttribute('aria-label', '条目状态筛选');
  for (const [value, label] of [['all', '全部条目'], ['enabled', '已启用'], ['disabled', '已停用'], ['constant', '常驻条目']]) {
    const option = make('option', '', '', label);
    option.value = value;
    filter.append(option);
  }
  entries.insertBefore(search, document.getElementById('wb-entry-list'));
  entries.insertBefore(filter, document.getElementById('wb-entry-list'));
  search.addEventListener('input', onFilter);
  filter.addEventListener('change', onFilter);
  const detailHead = make('div', 'wb-detail-head');
  const back = make('button', 'btn btn-ghost btn-sm wb-list-back', 'wb-list-back', '条目列表');
  back.type = 'button';
  back.addEventListener('click', () => { workspace.dataset.mobile = 'list'; search.focus(); });
  const contentCount = make('small', 'wb-content-count', 'wb-content-count');
  detailHead.append(back, contentCount);
  main.prepend(detailHead);
  const form = document.getElementById('wb-form');
  const content = document.getElementById('wb-e-content').closest('label');
  const keys = document.getElementById('wb-e-keys').closest('label');
  const checks = root.querySelector('.wb-checks');
  content.after(keys);
  keys.after(checks);
  checks.querySelectorAll('.check-desc').forEach(desc => {
    desc.closest('label').title = desc.textContent.replace(/\s+/g, ' ').trim();
  });
  root.querySelector('.page-sub').hidden = true;
  root.querySelector('#worldbooks-title').textContent = '编辑世界书';
  form.querySelector('.wb-advanced summary').textContent = '高级选项 · 顺序、概率、附加条件';
  layout = { root, panels, buttons, workspace, name, count, cover, search, filter, contentCount, bookId: null };
  setWorldbookPanel('entries');
}

export function setWorldbookPanel(key) {
  if (!layout) return;
  for (const [name, panel] of Object.entries(layout.panels)) {
    panel.hidden = name !== key;
    layout.buttons[name].classList.toggle('active', name === key);
    if (name === key) layout.buttons[name].setAttribute('aria-current', 'page');
    else layout.buttons[name].removeAttribute('aria-current');
  }
}

export function resetWorldbookLayout(bookId) {
  if (!layout || layout.bookId === bookId) return;
  layout.bookId = bookId;
  layout.search.value = '';
  layout.filter.value = 'all';
  layout.workspace.dataset.mobile = 'list';
  setWorldbookPanel('entries');
}

export function revealWorldbookEntry(entry) {
  if (!layout) return;
  if (entry && !worldbookEntryVisible(entry)) {
    layout.search.value = '';
    layout.filter.value = 'all';
  }
  setWorldbookPanel('entries');
  layout.workspace.dataset.mobile = 'detail';
}

export function worldbookEntryVisible(entry) {
  if (!layout) return true;
  const query = layout.search.value.trim().toLocaleLowerCase();
  const mode = layout.filter.value;
  return (mode === 'all' || (mode === 'constant' ? entry.constant : mode === 'enabled' ? entry.enabled !== false : entry.enabled === false))
    && [entry.title, ...(entry.keys || []), entry.content].join(' ').toLocaleLowerCase().includes(query);
}

export function syncWorldbookLayout(book, draft, characterCount) {
  if (!layout) return;
  layout.name.textContent = draft?.name || book?.name || '世界书';
  const entries = draft?.entries || [];
  layout.count.textContent = `${entries.length} 条设定 · ${characterCount} 个角色`;
  layout.buttons.entries.textContent = `条目 ${entries.length}`;
  layout.buttons.characters.textContent = `本书角色 ${characterCount}`;
  const cover = draft?.cover || '';
  if (layout.cover.dataset.cover !== cover) {
    layout.cover.dataset.cover = cover;
    layout.cover.replaceChildren();
    if (cover) {
      const image = document.createElement('img');
      image.src = cover;
      image.alt = '';
      layout.cover.append(image);
    } else layout.cover.textContent = '世';
  }
  layout.contentCount.textContent = document.getElementById('wb-form').classList.contains('hidden')
    ? '' : `${document.getElementById('wb-e-content').value.length} 字`;
}
