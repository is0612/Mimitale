'use strict';

// ui/build.js —— 建 DOM 的小工具
// ⚠️ 文本一律 textContent，这里不提供 innerHTML 入口：很多内容来自模型，不能让它们变成 HTML
// children 里的 null / false / undefined 直接跳过，方便写「有才渲染」

const CLASS_JOIN = ' ';
// ⚠️ 这几个得设 property 而不是 attribute：attribute 只算初始值，用户改了 DOM 后两者对不上
const PROPS = new Set(['value', 'checked']);

export function append(node, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(node, child);
    else if (typeof child === 'object') node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.innerHTML = '';
  return node;
}

/**
 * 建一个元素。特殊字段：class（可给数组，假的会滤掉）、text、dataset、on*（事件）；其余 setAttribute。
 */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  const map = props || {};

  for (const key of Object.keys(map)) {
    const value = map[key];
    if (value == null || value === false) continue;

    if (key === 'class') {
      const list = Array.isArray(value) ? value.filter(Boolean) : [value];
      node.className = list.join(CLASS_JOIN);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROPS.has(key)) {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(node, children);
  return node;
}

/**
 * 按钮。外观给语义参数（variant / size / block）或直接给类名。⚠️ 只有给了 variant / size / block 才补 `.btn` 底座 —— 有一批「长得不像按钮的按钮」靠自己的类定义外形，多一个 `.btn` 会把内边距和圆角顶掉；类名只在下面这张表里拼。
 */
const BUTTON_VARIANTS = { base: '', primary: 'btn-primary', ghost: 'btn-ghost', danger: 'btn-danger' };
const BUTTON_SIZES = { sm: 'btn-sm' };

export function button({ class: className, text, title, ariaLabel, disabled, onClick, variant, size, block, ...rest }) {
  const names = [];
  const push = (name) => {
    // false / true 是「条件类名」（`cond && 'active'`）留下的假值，不能变成名叫 "false" 的类
    if (name == null || name === false || name === true) return;
    const value = String(name).trim();
    if (value && !names.includes(value)) names.push(value);
  };

  if (variant || size || block) {
    // 认不出来的外观当场报出来：静默丢掉只会变成「这个按钮怎么没样式」
    if (variant && !(variant in BUTTON_VARIANTS)) console.error(`button()：不认识的外观 variant=${variant}`);
    if (size && !(size in BUTTON_SIZES)) console.error(`button()：不认识的尺寸 size=${size}`);
    push('btn');
    push(BUTTON_VARIANTS[variant]);
    push(BUTTON_SIZES[size]);
    if (block) push('btn-block');
  }
  for (const name of Array.isArray(className) ? className : String(className == null ? '' : className).split(/\s+/)) {
    push(name);
  }

  return h('button', {
    type: 'button',
    class: names.join(CLASS_JOIN),
    text,
    title,
    'aria-label': ariaLabel,
    disabled,
    onclick: onClick,
    ...rest
  });
}

/** 列表页骨架：清空网格 → 切空状态 → 更新副标题 → 铺卡片 */
export function renderListPage({ grid, empty, sub, subText, items, card }) {
  clear(grid);
  if (empty) empty.classList.toggle('hidden', !!items.length);
  if (sub) sub.textContent = subText || '';
  for (const item of items) grid.appendChild(card(item));
}

/**
 * 角色库 / 世界书共用的卡片外壳。`onMediaClick` 给了说明图能点开大图（封面包 button，测试按 `.char-card-avatar.clickable` 找）。⚠️ 书名 / 说明 / 操作行同时带两套类名：样式只有一份，旧选择器和冒烟断言别改。
 */
export function libraryCard({
  title,
  sub,
  subTitle,
  media,
  mediaText,
  mediaClass,
  coverClass,
  actions,
  extra,
  onMediaClick,
  mediaTitle,
  selecting = false,
  selected = false,
  onSelect
}) {
  const content = media || mediaText;
  const boxClass = ['char-card-avatar', ...(Array.isArray(mediaClass) ? mediaClass : mediaClass ? [mediaClass] : [])];
  // ⚠️ 选择态下封面不再是按钮：它的 click 会冒泡到卡片上，一下同时开大图 + 勾选
  const mediaBox = onMediaClick && !selecting
    ? h(
        'button',
        {
          type: 'button',
          class: [...boxClass, 'clickable'],
          title: mediaTitle || title,
          'aria-label': mediaTitle || title,
          onclick: onMediaClick
        },
        content
      )
    : h('div', { class: boxClass }, content);

  const card = h(
    'div',
    {
      class: ['char-card', selecting ? 'is-selectable' : '', selected ? 'is-selected' : ''],
      role: 'listitem',
      title
    },
    extra,
    h('div', { class: ['wb-card-cover', coverClass] }, mediaBox),
    h('div', { class: 'char-card-name wb-card-name', text: title }),
    h('div', { class: 'char-card-sub wb-card-meta', text: sub, title: subTitle || sub }),
    h('div', { class: 'char-card-actions wb-card-actions' }, actions)
  );

  if (selecting) {
    card.insertBefore(h('span', { class: 'char-card-check', 'aria-hidden': 'true' }), card.firstChild);
    card.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (typeof onSelect === 'function') {
      card.tabIndex = 0;
      card.addEventListener('click', () => onSelect());
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect();
      });
    }
  }

  return card;
}
