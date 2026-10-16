'use strict';

// ============================================================================
//  ui/build.js —— 建 DOM 的小工具
//
//  这个项目没有框架，也不打算引：界面就这些（9 个弹窗 + 3 个页面），
//  引一套组件库要付出构建步骤的代价，而「零构建」是这个项目写在 README 里的卖点。
//  真正缺的只是把 createElement 的样板收掉 —— 渲染层原来有 94 处 createElement，
//  光是「建一个按钮」那个五连击就重复了 20 遍。
//
//  两条约定（别破坏）：
//    · 文本一律走 textContent，**这里不提供 innerHTML 入口** ——
//      渲染层里很多内容来自模型，绝不能让它们有机会变成 HTML
//    · children 里的 null / false / undefined 直接跳过，方便写「有才渲染」
// ============================================================================

const CLASS_JOIN = ' ';
// 这几个得设 property 而不是 attribute：attribute 只算「初始值」，
// 之后用户改了 DOM，两者就对不上了
const PROPS = new Set(['value', 'checked']);

/** 把子节点接上去：数组摊平，假值跳过，字符串变文本节点 */
export function append(node, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(node, child);
    else if (typeof child === 'object') node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
  return node;
}

/** 清空一个节点 */
export function clear(node) {
  node.innerHTML = '';
  return node;
}

/**
 * 建一个元素。
 *
 *   h('div', { class: ['row', isActive && 'on'], title: '提示' },
 *     h('span', { text: '名字' }),
 *     '纯文本')
 *
 * 特殊字段：class（可给数组，假的会滤掉）、text、dataset、on*（事件）
 * 其余一律走 setAttribute；值为 false / null 的字段直接跳过。
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
 * 按钮。渲染层里最常见的一段样板：
 * 以前是「createElement + type + className + textContent + addEventListener」五连击。
 *
 * 外观可以给**语义参数**，也可以直接给类名：
 *
 *   button({ text: '保存', variant: 'primary', size: 'sm' })   → btn btn-primary btn-sm
 *   button({ text: '×', class: 'char-card-del' })              → char-card-del（原样）
 *
 * ⚠️ 只有给了 variant / size / block 才会补上 `.btn` 底座。
 *    这一条是**故意的**：渲染层里有一大批「长得不像按钮的按钮」
 *    （char-card-del / convo-del / sc-close / variant-btn …），它们靠自己的类
 *    定义外形，凭空多一个 `.btn` 会把内边距和圆角全顶掉。
 *    类名只在下面这张表里拼 —— 调用点别再手写 'btn btn-primary btn-sm' 这种串。
 */
const BUTTON_VARIANTS = { base: '', primary: 'btn-primary', ghost: 'btn-ghost', danger: 'btn-danger' };
const BUTTON_SIZES = { sm: 'btn-sm' };

export function button({ class: className, text, title, ariaLabel, disabled, onClick, variant, size, block, ...rest }) {
  const names = [];
  const push = (name) => {
    // false / true 是「条件类名」写法留下的假值（`cond && 'active'`），
    // 不能变成名叫 "false" 的类
    if (name == null || name === false || name === true) return;
    const value = String(name).trim();
    if (value && !names.includes(value)) names.push(value);
  };

  if (variant || size || block) {
    // 认不出来的外观**当场报出来**：静默丢掉只会变成「这个按钮怎么没样式」，
    // 那种问题要翻半天（见 README 里「不会报错，只会静默失效」那一段）
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

/**
 * 列表页骨架。角色库页和世界书页原来各抄了一份，结构一模一样：
 * 清空网格 → 切空状态 → 更新副标题 → 铺卡片。
 */
export function renderListPage({ grid, empty, sub, subText, items, card }) {
  clear(grid);
  if (empty) empty.classList.toggle('hidden', !!items.length);
  if (sub) sub.textContent = subText || '';
  for (const item of items) grid.appendChild(card(item));
}

/**
 * 列表页的卡片外壳：头像 + 名字 + 一行小字 + 操作区。
 * 角色卡和世界书卡长得一样，只是内容不同；`extra` 用来塞角色卡右上角那个删除按钮。
 *
 * `onMediaClick` 给了就说明这张图能点开看大图（角色库的立绘）——
 * 那时候图外面包一个 button，键盘也能按到。
 */
export function card({ title, sub, subTitle, avatar, avatarText, avatarClass, actions, extra, onMediaClick, mediaTitle }) {
  const media = avatar ? h('img', { src: avatar, alt: '' }) : avatarText;
  const mediaBox = onMediaClick
    ? h(
        'button',
        {
          type: 'button',
          class: ['char-card-avatar', 'clickable', 'art-edge', avatarClass],
          title: mediaTitle || title,
          'aria-label': mediaTitle || title,
          onclick: onMediaClick
        },
        media
      )
    : h('div', { class: ['char-card-avatar', 'art-edge', avatarClass] }, media);

  return h(
    'div',
    { class: 'char-card', role: 'listitem', title },
    extra,
    mediaBox,
    h('div', { class: 'char-card-name', text: title }),
    h('div', { class: 'char-card-sub', text: sub, title: subTitle || sub }),
    h('div', { class: 'char-card-actions' }, actions)
  );
}
