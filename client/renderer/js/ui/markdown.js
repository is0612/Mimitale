'use strict';

// ui/markdown.js —— 极简 Markdown 渲染
// ⚠️ 先整体转义 HTML，再按块级/行内规则替换，所以内容是安全的

export function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // 单引号也转掉：现在生成的属性都用双引号，但以后谁写个 attr='…' 就立刻变成口子
    .replace(/'/g, '&#39;');
}

/**
 * 标记**单独占一行**时折成同行写法，块级判断就只用管一种形状。⚠️ 不折的话会渲染出空块、真正的内容成了普通段落，样式全丢。
 */
const SOLO_MARKER_RE = /^【(心理|内心|心声|旁白|上帝视角|全知)】$/;

function joinSoloMarkers(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!SOLO_MARKER_RE.test(trimmed)) {
      out.push(lines[i]);
      continue;
    }

    // 往后找第一行非空行当内容（中间的空行一起吞掉，免得又推出一个空块）
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;
    if (j >= lines.length) continue; // 标记后面没有内容 → 丢掉这行
    if (SOLO_MARKER_RE.test(lines[j].trim())) continue; // 紧跟着又是一个标记 → 丢掉这个空的

    out.push(`${trimmed}${lines[j].trim()}`);
    i = j; // 内容行已经并进来了，别再走一遍
  }
  return out;
}

export function renderInline(text) {
  let out = text;

  // 行内代码 `code` —— 先抽出来占位，避免里面的符号被当成格式
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  // 链接文字里也可能嵌了行内代码 —— 那部分不在 out 上，得单独还原一次
  const withCodes = (s) => s.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);

  // ⚠️ 捕获组不能禁止 `*`（否则嵌套那条整条匹配不上，外层 `**` 原样露出）；开闭标记旁边必须非空白（否则 `攻击 * 2 * 倍率` 成斜体）
  out = out.replace(/\*\*\*(?!\s)([^\n]+?)(?<!\s)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  out = out.replace(/==([^=\n]+)==/g, '<mark class="msg-em">$1</mark>');

  // 链接 / 图片：只放行 http/https 和 data:image，其他一律当普通文字
  const links = [];
  out = out
    .replace(/(!?)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/g, (_m, bang, label, href) => {
      // ⚠️ 图片只对 data:image 生效：CSP 的 img-src 是 'self' data:，外链图渲染成 <img> 只会得个破图标
      const isImage = !!bang && /^data:image\//.test(href);
      links.push(
        isImage
          ? `<img src="${href}" alt="${label}" />`
          : `<a href="${href}" target="_blank" rel="noreferrer">${withCodes(label)}</a>`
      );
      return `\u0000L${links.length - 1}\u0000`;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, raw) => {
      // 句尾的标点不算 URL 的一部分 —— 中文标点特别容易粘进来（「见 https://x.com。」）
      const url = raw.replace(/[.,;:!?。，、；：！？…"'）】》」]+$/, '');
      const tail = raw.slice(url.length);
      links.push(`<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
      return `${pre}\u0000L${links.length - 1}\u0000${tail}`;
    });

  out = out.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  out = out.replace(/\u0000L(\d+)\u0000/g, (_m, i) => links[Number(i)]);
  return out;
}

export function renderMarkdown(source, options) {
  let text = String(source == null ? '' : source).replace(/\r\n/g, '\n');

  // 流式生成中，代码块可能只来了一半：临时补个结尾，免得显示成乱码
  if (options && options.streaming) {
    const fences = (text.match(/```/g) || []).length;
    if (fences % 2 === 1) text += '\n```';
  }

  // 1. 先把 ``` 代码块抽出来，避免块内内容被解析
  const blocks = [];
  const withoutFences = text.replace(/```([\w+#.-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const cls = lang ? ` class="language-${esc(lang.toLowerCase())}"` : '';
    blocks.push(`<pre><code${cls}>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\n\u0000B${blocks.length - 1}\u0000\n`;
  });

  // 2. 逐行处理块级元素
  const lines = joinSoloMarkers(esc(withoutFences).split('\n'));
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  // 表格用：`| a | b |` 有没有两头竖线，以及把一行的格子切出来
  const isTableRow = (line) => /^\|.*\|$/.test(line.trim());
  const tableCells = (line) =>
    line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  // 用下标循环（不是 for-of）：表格要把后面的分隔行和数据行一起吃掉
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\u0000B\d+\u0000$/.test(trimmed)) {
      closeList();
      out.push(trimmed);
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    // 表格：表头行 + 分隔行（|---|---|）+ 若干数据行
    if (isTableRow(trimmed) && i + 1 < lines.length) {
      const sep = lines[i + 1].trim();
      if (/^\|[\s:|-]+\|$/.test(sep) && sep.includes('-')) {
        closeList();
        const head = tableCells(trimmed);
        const body = [];
        i += 1; // 吃掉分隔行
        while (i + 1 < lines.length && isTableRow(lines[i + 1])) {
          body.push(tableCells(lines[i + 1]));
          i += 1;
        }
        out.push(
          '<table><thead><tr>' +
            head.map((c) => `<th>${renderInline(c)}</th>`).join('') +
            '</tr></thead><tbody>' +
            body.map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('') +
            '</tbody></table>'
        );
        continue;
      }
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      out.push('<hr />');
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = trimmed.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }

    closeList();

    // ⚠️ 只认「段落以标记开头」：正文里提到「【心理】」不误伤，流式半截标记（「【心」）也匹配不上；标记本身不显示
    const inner = trimmed.match(/^【(心理|内心|心声)】\s*(.*)$/);
    if (inner) {
      out.push(`<p class="msg-inner">${renderInline(inner[2])}</p>`);
      continue;
    }

    const aside = trimmed.match(/^【(旁白|上帝视角|全知)】\s*(.*)$/);
    if (aside) {
      out.push(`<p class="msg-aside">${renderInline(aside[2])}</p>`);
      continue;
    }

    out.push(`<p>${renderInline(trimmed)}</p>`);
  }
  closeList();

  let html = out.join('\n');

  // 3. 还原代码块
  html = html.replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return html;
}
