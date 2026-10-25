// ---------------------------------------------------------------------------
//  世界书编辑页的「壳」：分区切换 + 搜索筛选 + 那几个数字
//
//  2026-10-18 按设计稿 A「条目工作台」重写（design/wb-editor-2versions）。
//  和上一版最大的区别：**结构全在 index.html 里了**。上一版这里用 createElement
//  现拼书籍头 / 分区标签 / 两栏工作区（因为当时 HTML 里还是「弹窗时代」的平铺结构）；
//  现在三屏各自的结构都是定死的（三栏 / 两栏 / 卡片网格），JS 再拼一遍只会让
//  「HTML 里看到的」和「跑起来看到的」对不上。所以这里只做三件事：
//
//    ① 分区标签 → setWorldbookPanel（三屏互斥，siblings 用 hidden 收）
//    ② 搜索框 / 状态筛选 → onFilter（过滤逻辑仍是 worldbookEntryVisible）
//    ③ 把草稿里的数字铺到页面上：书籍条统计、分区标签角标、字数角标、本书信息
//
//  ⚠️ 三个面板（条目 / 书籍设置 / 本书角色）都是 #wb-book-wrap 的直接子级，
//     同一个时刻只有一个不带 hidden —— 它们各自内部再分栏。
// ---------------------------------------------------------------------------

let layout;

const PANEL_KEYS = [
  ['entries', '条目'],
  ['characters', '本书角色']
];

export function initWorldbookLayout({ onFilter }) {
  if (layout) return;
  const root = document.getElementById('view-wb-editor');
  const panels = {};
  const buttons = {};
  for (const [key] of PANEL_KEYS) {
    panels[key] = document.getElementById(`wb-panel-${key}`);
    buttons[key] = document.getElementById(`wb-tab-${key}`);
    buttons[key].addEventListener('click', () => setWorldbookPanel(key));
  }

  // ⚙ 搜索框和状态筛选都是组件（m-input / m-select），HTML 里已经写好 ——
  //   组件在启动时注册过，静态标记照样会被升级，`<option>` 由组件自己搬进
  //   里层那颗原生 select（见 components/select.js 的 _moveOptions）。
  const search = document.getElementById('wb-search');
  const filter = document.getElementById('wb-state');
  search.addEventListener('input', onFilter);
  filter.addEventListener('change', onFilter);

  layout = {
    root,
    panels,
    buttons,
    search,
    filter,
    bookWrap: document.getElementById('wb-book-wrap'),
    name: document.getElementById('wb-bookbar-name'),
    sub: document.getElementById('wb-bookbar-sub'),
    totalWords: document.getElementById('wb-total-words'),
    tabEntryCount: document.getElementById('wb-tab-entries-n'),
    tabCharCount: document.getElementById('wb-tab-characters-n'),
    contentCount: document.getElementById('wb-content-count'),
    keysCount: document.getElementById('wb-keys-count'),
    entryWords: document.getElementById('wb-e-words'),
    entryKeyCount: document.getElementById('wb-e-keycount'),
    charHint: document.getElementById('wb-chars-hint'),
    bookId: null
  };
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
  setWorldbookPanel('entries');
}

/** 选中某条条目后把视图切到「条目」屏（外部点条目、新建条目都走这里） */
export function revealWorldbookEntry(entry) {
  if (!layout) return;
  if (entry && !worldbookEntryVisible(entry)) {
    layout.search.value = '';
    layout.filter.value = 'all';
  }
  setWorldbookPanel('entries');
}

export function worldbookEntryVisible(entry) {
  if (!layout) return true;
  const query = layout.search.value.trim().toLocaleLowerCase();
  const mode = layout.filter.value;
  return (mode === 'all' || (mode === 'constant' ? entry.constant : mode === 'enabled' ? entry.enabled !== false : entry.enabled === false))
    && [entry.title, ...(entry.keys || []), entry.content].join(' ').toLocaleLowerCase().includes(query);
}

/** 把草稿里的数字铺到页面上（书名 / 统计 / 角标 / 封面缩略 / 本书信息） */
export function syncWorldbookLayout(book, draft, characterCount) {
  if (!layout) return;
  const bookName = draft?.name || book?.name || '世界书';
  layout.name.textContent = bookName;

  const entries = Array.isArray(draft?.entries) ? draft.entries : [];
  const on = entries.filter((entry) => entry.enabled !== false).length;
  const constant = entries.filter((entry) => entry.constant).length;
  const words = entries.reduce((sum, entry) => sum + String(entry.content || '').length, 0);
  const total = entries.length;
  const chars = Number(characterCount) || 0;

  // 书籍条：一行读完这本书的全貌（统计只在这里出现）
  layout.sub.textContent = `${total} 条 · ${on} 启用 · ${constant} 常驻 · ${chars} 角色`;
  layout.totalWords.textContent = `全文 ${words.toLocaleString()} 字`;

  // 分区标签上的角标：数字挂在哪一屏，就是在说「那一屏里有几个」
  layout.tabEntryCount.textContent = String(total);
  layout.tabCharCount.textContent = String(chars);

  // 「本书角色」屏右上角那句：数字 + 一句「副本是副本」
  if (layout.charHint) {
    layout.charHint.textContent = chars
      ? `${chars} 个角色 · 副本只属于这本书，改它不动角色卡`
      : '副本只属于这本书，改它不动角色卡';
  }

  syncEntryCounts();
}

/**
 * 条目屏那三处字数：内容稿纸右上角、识别卡右上角的关键词数、右栏「本条目」两行。
 *
 * 读的是**表单里的值**而不是草稿里那条条目 —— 用户正在打字时草稿每敲一下都会
 * 重新 stash（见 worldbook.js 的 input 监听），但那是异步落在另一处的；表单值
 * 永远是当前可见的那一份，页面上显示的数字必须和框里看到的一致。
 */
function syncEntryCounts() {
  if (!layout) return;
  const form = document.getElementById('wb-form');
  const open = form && !form.classList.contains('hidden');
  const content = document.getElementById('wb-e-content');
  const keys = String(document.getElementById('wb-e-keys')?.value || '');
  const words = open ? String(content?.value || '').length : 0;
  const keyCount = keys.split(/[,，]/).map((k) => k.trim()).filter(Boolean).length;

  if (layout.contentCount) layout.contentCount.textContent = open ? `${words} 字` : '';
  if (layout.keysCount) layout.keysCount.textContent = open ? `关键词 ${keyCount} 个` : '';
  if (layout.entryWords) layout.entryWords.textContent = open ? String(words) : '—';
  if (layout.entryKeyCount) layout.entryKeyCount.textContent = open ? String(keyCount) : '—';
}
