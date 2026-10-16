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
  const crumb = document.getElementById('wb-crumb');

  // 书籍头：封面 + 书名 + 统计行 + 书级动作（预览命中 / 导出）。
  // 预览命中、导出是「这本书自己的动作」，贴着书名放 —— 页头只留「返回 / 保存」。
  const bar = make('div', 'wb-bookbar', 'wb-bookbar');
  const summary = make('div', 'wb-summary');
  const cover = make('div', 'wb-summary-cover', 'wb-summary-cover');
  const summaryText = make('div', 'wb-summary-text');
  const name = make('strong', '', 'wb-summary-name');
  const stats = make('ul', 'wb-stats', 'wb-summary-stats');
  summaryText.append(name, stats);
  summary.append(cover, summaryText);
  const actions = make('div', 'wb-bookbar-actions');
  actions.append(document.getElementById('btn-preview-wb'), document.getElementById('btn-export-wb'));
  bar.append(summary, actions);

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
  wrap.replaceChildren(bar, tabs, workspace, book, characterPanel);
  // 原来嵌在「本书设置」里的那个动作条（预览命中）已被搬进书籍头，空壳收掉
  root.querySelector('.wb-book-actions').remove();

  // ⚙ 组件化（2026-10-16）：它被同一行 stretch 成 44px（= 组件的默认档），
  // 字号从 xs 变成正文级（和旁边那个筛选下拉一致）。
  // 下面 search.type / search.placeholder 是**直接设 property** 的写法，
  // 靠组件的 reflectProperties 桥到里层原生 input（base.js 有注释）。
  const search = make('m-input', 'wb-search', 'wb-search');
  search.type = 'search';
  search.placeholder = '搜索条目';
  search.setAttribute('aria-label', '搜索条目');
  // ⚙ 组件化（2026-10-16）：状态筛选从原生 <select> 换成 <m-select>。
  // 按标签名建就行 —— 组件在启动时注册过，createElement('m-select') 拿到的已经是
  // 升级好的自定义元素；里面的 <option> 由组件搬进里层那颗原生 select。
  // 类名 `.wb-state` 留在宿主上，所以 style.css 里那两条（min-width / flex 宽度）
  // 一个字都不用改。
  const filter = make('m-select', 'wb-state', 'wb-state');
  filter.setAttribute('aria-label', '条目状态筛选');
  for (const [value, label] of [['all', '全部条目'], ['enabled', '已启用'], ['disabled', '已停用'], ['constant', '常驻条目']]) {
    const option = make('option', '', '', label);
    option.value = value;
    filter.append(option);
  }
  // 搜索 + 筛选并排一行；列表头上的「N 条 · N 启用 · N 常驻」小头条由 worldbook.js 铺
  const listTools = make('div', 'wb-list-tools');
  listTools.append(search, filter);
  entries.insertBefore(listTools, document.getElementById('wb-entry-list'));
  search.addEventListener('input', onFilter);
  filter.addEventListener('change', onFilter);

  const detailHead = make('div', 'wb-detail-head');
  const back = make('button', 'btn btn-ghost btn-sm wb-list-back', 'wb-list-back', '条目列表');
  back.type = 'button';
  back.addEventListener('click', () => { workspace.dataset.mobile = 'list'; search.focus(); });
  const headTitle = make('strong', 'wb-detail-title', '', '条目设定');
  const contentCount = make('small', 'wb-content-count', 'wb-content-count');
  detailHead.append(back, headTitle, contentCount);
  main.prepend(detailHead);

  // 检查项（启用 / 常驻 / 递归）留在表单 DOM 里（change 才能冒泡到表单的脏标记），
  // 位置交给 CSS order 提到最顶 —— 和正文同屏，写完不用往回滚。
  root.querySelector('.page-sub').hidden = true;
  root.querySelector('#worldbooks-title').textContent = '编辑世界书';
  const form = document.getElementById('wb-form');
  form.querySelector('.wb-advanced summary').textContent = '高级选项 · 顺序、概率、附加条件';
  layout = { root, panels, buttons, workspace, name, stats, cover, search, filter, contentCount, crumb, bookId: null };
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

/** 统计行的一项：数字加粗 + 灰色单位 */
function statItem(num, label) {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = num;
  li.append(b, ' ' + label);
  return li;
}

export function syncWorldbookLayout(book, draft, characterCount) {
  if (!layout) return;
  const bookName = draft?.name || book?.name || '世界书';
  layout.name.textContent = bookName;
  if (layout.crumb) {
    layout.crumb.textContent = `世界书 / ${bookName}`;
    layout.crumb.hidden = false;
  }
  const entries = draft?.entries || [];
  const on = entries.filter((entry) => entry.enabled !== false).length;
  const constant = entries.filter((entry) => entry.constant).length;
  const words = entries.reduce((sum, entry) => sum + String(entry.content || '').length, 0);
  layout.stats.replaceChildren(
    statItem(String(entries.length), '条设定'),
    statItem(String(on), '启用'),
    statItem(String(constant), '常驻'),
    statItem(String(characterCount), '角色'),
    statItem(words.toLocaleString(), '字')
  );
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
