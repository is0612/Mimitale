'use strict';

// ui/icons.js —— 图标名 → SVG path 的登记表；加新图标就是在 ICONS 里添一行
// ⚠️ 界面代码不许再直接写 <svg>：静态 HTML 写 data-icon="名字"，JS 里用 iconHtml('名字')
// 例外是标题栏那对 .icon-expand / .icon-restore；规矩由 tools/check-icons.js 守

const ICONS = {
  'book-open': '<path d="M12 7v14M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v17h-5a4 4 0 0 0-4 1 4 4 0 0 0-4-1H3z"/>',
  'panel-left': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  'panel-right': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>',
  // ⚠️ 尖角而不是 `M19 12H5` 那种带横杆的：14px 下横杆拉得老长、箭头糊成一个「←」字符
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  ellipsis: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4m-2-2h4"/>',
  search:
    '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>',
  width:
    '<path d="M8 8 5 12l3 4"/><path d="M16 8l3 4-3 4"/><line x1="12" y1="5" x2="12" y2="19"/>',
  user:
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  smile:
    '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  'map-pin':
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  'message-circle':
    '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  'messages-square':
    '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  layers:
    '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  sliders:
    '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>',
  book:
    '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.9 4.7H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  help:
    '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5"/><line x1="12" y1="17.5" x2="12.01" y2="17.5"/>',
  eye:
    '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2.5-2.5c0-.7-.3-1.3-.7-1.8-.4-.4-.7-1-.7-1.7a2.5 2.5 0 0 1 2.5-2.5H17a5 5 0 0 0 5-5c0-3.6-4.5-6-10-6Z"/>',
  bookmark:
    '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  // 账号菜单里的「退出登录」：门里伸出的箭头（Lucide log-out）
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',

  'zoom-out': '<circle cx="11" cy="11" r="7"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  'zoom-in':
    '<circle cx="11" cy="11" r="7"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  'zoom-fit':
    '<path d="M3 8V6a3 3 0 0 1 3-3h2"/><path d="M16 3h2a3 3 0 0 1 3 3v2"/><path d="M21 16v2a3 3 0 0 1-3 3h-2"/><path d="M8 21H6a3 3 0 0 1-3-3v-2"/><path d="M9 15 5 19"/><path d="M15 9l4-4"/>',
  'zoom-actual':
    '<rect x="9" y="9" width="6" height="6" rx="1"/><path d="M3 8V6a3 3 0 0 1 3-3h2"/><path d="M16 3h2a3 3 0 0 1 3 3v2"/><path d="M21 16v2a3 3 0 0 1-3 3h-2"/><path d="M8 21H6a3 3 0 0 1-3-3v-2"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',

  link:
    '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
  params: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  toggle: '<rect x="1" y="6" width="22" height="12" rx="6"/><circle cx="16" cy="12" r="3"/>',
  mask:
    '<circle cx="7" cy="8" r="2.2"/><circle cx="12" cy="6" r="2.2"/><circle cx="17" cy="8" r="2.2"/><path d="M12 10c-3.2 0-5.5 2.4-5.5 4.6 0 1.6 1.3 2.4 2.7 2.4 1 0 1.9-.5 2.8-.5s1.8.5 2.8.5c1.4 0 2.7-.8 2.7-2.4C17.5 12.4 15.2 10 12 10Z"/>',
  save:
    '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  'file-text':
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  'sliders-horizontal':
    '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/>'
};

/** 图标名 → 完整 SVG 字符串；找不到返回空串 */
export function iconSvg(name) {
  // ⚠️ 用 Object.hasOwn 而不是 ICONS[name]：后者走原型链，ICONS['constructor'] 会被拼进 DOM
  const body = Object.hasOwn(ICONS, name) ? ICONS[name] : '';
  if (!body) return '';
  return (
    '<svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body +
    '</svg>'
  );
}

/** 取一段图标 SVG；cls 用来换掉 `.field-icon` 那个 class。找不到返回空串 */
export function iconHtml(name, cls = 'field-icon') {
  const svg = iconSvg(name);
  if (!svg) return '';
  return cls && cls !== 'field-icon' ? svg.replace('class="field-icon"', `class="${cls}"`) : svg;
}

/**
 * 扫描 root 里带 `data-icon` 的元素插图标（幂等，靠 dataset.iconDone）。⚠️ 组件宿主（有 `.control`）要插到**里层控件**：底色/边框/圆角都在里层那颗上。
 */
export function applyFieldIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone === '1') continue;
    el.dataset.iconDone = '1';
    const svg = iconSvg(el.getAttribute('data-icon'));
    if (!svg) continue;
    const control = el.control;
    const target = control && control !== el ? control : el;
    target.insertAdjacentHTML('afterbegin', svg);
  }
}
