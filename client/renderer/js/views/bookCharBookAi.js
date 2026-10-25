'use strict';

// ============================================================================
//  views/bookCharBookAi.js —— 本书角色编辑页里那块「AI 补设定」
//
//  做的事：拿编辑器里**当前**这张卡（可能是刚手改过的），让模型补一份设定集；
//  结果先摆在编辑器里当草稿，点「保存」时才真正落地（角色卡建书、副本并进那本书）。
//
//  为什么不在「AI 生成角色」那一次里一起给：一次调用同时出 8 个卡字段 + 10 条设定，
//  模型会在后半段稀释（甚至被截断）；拆成两次，每次只盯一件事，条目也更贴卡。
//
//  ⚠️ 两处作用域，两个落点：
//     · 角色卡 —— 保存时建一本「XX的世界书」并绑到这张卡上；
//     · 世界书里的副本 —— 保存时并进**那本书的草稿**（副本进世界时注入的是那本书，
//       自带的书不生效，见 data/cast.js 的 effectiveWorldbookIds），回世界书编辑器点「保存」才落盘。
//  ⚠️ 生成完不落盘 —— 和「AI 生成角色」同一条规矩：保存角色那一刻才生效。
// ============================================================================

import { state } from '../core/state.js';
import { el } from './bookCharEditorDom.js';
import { uid, now } from '../core/util.js';
import { CONFIG } from '../core/config.js';
import { api } from '../core/api.js';
import { h } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { worldbooks, worldbookById } from '../data/library.js';
import { extractJsonBlock, generationText, resolveGenTarget } from './aiGen.js';
import { appendEntriesToBookDraft } from './worldbook.js';

// --- 提示词 ---

// 上限：一本书里条目再多，这一次也只收这么多；单条正文按世界书的注入上限再留余量。
const MAX_ENTRIES = 12;
const MAX_ENTRY_CONTENT = 1200;
const MAX_ENTRY_KEYS = 6;
const MAX_KEY_CHARS = 24;

// ⚠️ 认这个请求的桩在 tools/smoke-test.js：它同时要「世界书编辑」和 "entries" 两个特征，
//    改措辞时别把这两样一起改没了（改没了请求会被当成普通聊天）。
const BOOK_SYSTEM = `你是一位世界书编辑，负责给一个角色补一份「设定集」（酒馆里的世界书 / lorebook）。

【这份东西怎么用】接下来会有一个玩家只跟这个角色聊天。模型只知道角色卡上的描述和性格；
你写的条目平时不在上下文里，只有当玩家的某句话里出现了条目上的关键词时，这一条才会被塞进去。
所以你要写的是「卡上没写、但聊到那儿迟早得知道」的事，不是把角色卡换个说法再写一遍。

严格按照下面的 JSON 结构输出，不要任何多余的文字、解释或 Markdown 代码块标记：

{
  "entries": [
    { "title": "条目名", "keys": ["关键词", "关键词"], "content": "正文", "constant": false }
  ]
}

每条包含 title / keys / content / constant 四个键：

· title：这条讲什么，四到八个字，别用「设定一」这种。
· keys：2~5 个玩家真的会说出口的短词 —— 地名、人名、外号、物件、机构、事件名。
  不要整句，不要「她」「那个」这种谁都能套的词；同一个词不要出现在两条里。
· content：60~200 字，写成能直接拿去演的设定：它是什么、怎么运转、会带来什么后果。
  禁止「这里很有趣」「氛围很神秘」这种只有形容、没有信息的句子。
· constant：false 表示靠关键词触发（绝大多数都该是 false）；
  true 表示每一轮都注入 —— 只给「任何一句对话都该知道的背景」，全篇最多 2 条。

写作要求（按优先级）：

1. 共 6~10 条；constant 最多 2 条，其余全部 false。常驻太多等于每轮把设定灌满上下文，比不写还糟。
2. 和角色卡严丝合缝：地点、时代、行业、和玩家的关系，都要和 description / scenario / firstMes 对得上。
   不要重复卡里已经写过的东西（描述、性格、开场白里写过的人和事），也不要改写这个角色本人。
3. 条目之间要能互相咬合：人物条目里提到的地盘，和地名条目里说的要是同一个地方，名字写法一致。
4. 合起来要像一个世界的切片，大致按这个配额：
   · 2 条左右写地方 / 环境（这里的规矩、它的作息、外人不知道的门道）
   · 1~2 条写人物关系（和这个角色有牵扯的人、欠过谁、被谁盯着）
   · 1~2 条写门槛 / 忌讳 / 代价（做某件事要付什么、碰什么会出事）
   · 1 条写接下来可能发生的事（constant:false，挂上玩家可能提到的关键词）
5. 允许留白，不要为了凑数把同一件事拆成两条。
6. 只输出 JSON 本身。`;

/** 把卡里真正影响设定的几段拼给模型；太长的一律截断，别让设定任务把上下文吃满 */
function cardContext(character) {
  const cut = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const parts = [];

  const push = (label, value, max) => {
    const text = cut(value, max);
    if (text) parts.push(`【${label}】\n${text}`);
  };

  parts.push(`【名字】${cut(character.name, 60) || '未命名角色'}`);
  push('描述', character.description, 1600);
  push('性格', character.personality, 800);
  push('场景', character.scenario, 600);
  push('开场白', character.firstMes, 900);

  const tags = (Array.isArray(character.tags) ? character.tags : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 10);
  if (tags.length) parts.push(`【标签】${tags.join('、')}`);

  const attrs = (Array.isArray(character.attributes) ? character.attributes : [])
    .filter((a) => a && String(a.name || '').trim())
    .slice(0, 8)
    .map((a) => `${String(a.name).trim()}：${String(a.value == null ? '' : a.value).trim() || '（空）'}`);
  if (attrs.length) parts.push(`【角色身上会变的字段】\n${attrs.join('\n')}`);

  return parts.join('\n\n');
}

// --- 解析 ---

/** 关键词：数组或逗号串都收；空串、超长、重复的都摘掉 */
function parseKeys(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、;；\n]+/)
      : [];

  const out = [];
  for (const item of list) {
    const key = String(item == null ? '' : item).trim().slice(0, MAX_KEY_CHARS);
    if (!key || out.includes(key)) continue;
    out.push(key);
    if (out.length >= MAX_ENTRY_KEYS) break;
  }
  return out;
}

/** 一条模型给的条目 → 世界书条目（形状和世界书编辑器里新建的那条一致） */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const content = String(raw.content == null ? '' : raw.content).trim().slice(0, MAX_ENTRY_CONTENT);
  if (!content) return null;

  const title = String(raw.title == null ? '' : raw.title).trim().slice(0, 60) || '未命名条目';
  const keys = parseKeys(raw.keys == null ? raw.key : raw.keys);
  const constant = raw.constant === true;

  // 既非常驻、又没有关键词 = 永远不会被注入，留着只会让人以为它生效了
  if (!constant && !keys.length) return null;

  return {
    // ⚠️ 必须带随机后缀：一批条目是在同一毫秒里造出来的，只用时间戳会撞成同一个 id
    id: `e${uid()}`,
    title,
    keys,
    secondaryKeys: [],
    selectiveLogic: 'AND_ANY',
    content,
    order: 100,
    constant,
    matchWholeWords: false,
    caseSensitive: false,
    probability: 100,
    enabled: true
  };
}

/**
 * 模型输出 → 条目列表。纯函数（不碰 DOM、不碰 state），宿主侧也拿它验形状。
 * @returns {{ ok: boolean, entries?: object[], unusable?: number, error?: string, raw?: string }}
 */
export function parseBookEntries(raw) {
  const text = extractJsonBlock(raw);
  if (!text) return { ok: false, error: '模型没有返回内容', raw: String(raw || '') };

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    // extractJsonBlock 只切花括号块；模型偶尔直接回一个裸数组，这里补一刀
    const from = text.indexOf('[');
    const to = text.lastIndexOf(']');
    if (from < 0 || to <= from) return { ok: false, error: '模型返回的不是合法 JSON', raw: String(raw || '') };
    try {
      json = JSON.parse(text.slice(from, to + 1));
    } catch (err2) {
      return { ok: false, error: '模型返回的不是合法 JSON', raw: String(raw || '') };
    }
  }

  // 顶层可以是 { entries: [...] }、{ worldbook: [...] }，也容忍直接给一个数组
  const list = Array.isArray(json)
    ? json
    : json && Array.isArray(json.entries)
      ? json.entries
      : json && Array.isArray(json.worldbook)
        ? json.worldbook
        : [];

  const entries = [];
  let unusable = 0;
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (!entry) {
      unusable += 1;
      continue;
    }
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES) break;
  }

  if (!entries.length) {
    return { ok: false, error: list.length ? '模型给的条目都不能用（缺正文，或既非常驻又没关键词）' : '模型没有给出条目', unusable, raw: String(raw || '') };
  }
  return { ok: true, entries, unusable };
}

// --- 草稿状态 ---

let pending = []; // 还没落盘的条目（保存角色时才建书）
let expandedId = ''; // 正在就地改正文的那一条（同时只开一条）
let busy = false;
let currentGenId = null;
let readCard = () => null; // 由 characterEditor 注入：先把表单收进内存，再取那张卡
let onChange = () => {}; // 条目变化时告诉编辑器「有未保存的改动」
let madeFor = null; // { charId, bookId } 本次会话给哪张卡建过书 —— 再生成只追加，不叠第二本
// 当前作用域：角色卡 = 建自己的书；世界书里的副本 = 并进那本书的草稿
let scopeInfo = { scope: 'library', bookName: '' };

function nodes() {
  return el && el.c ? { btn: el.c.wbAiBtn, list: el.c.wbAiList, status: el.c.wbAiStatus } : null;
}

// --- 渲染 ---

/**
 * 告诉这块当前在哪个作用域（由 characterEditor 在画「自带世界书」时调）。
 * 角色卡：保存时建一本自己的书并绑上；
 * 世界书里的副本：保存时并进**这本书的草稿** —— 副本自带的书进世界时不会被注入。
 */
export function setCharBookScope(scope, bookName) {
  scopeInfo = {
    scope: scope === 'worldbook' ? 'worldbook' : 'library',
    bookName: String(bookName || '')
  };
  // 块上留个记号：两处作用域的落点不一样，调试 / 冒烟一眼能看出现在在哪条路上
  if (el.c && el.c.wbAiBlock) el.c.wbAiBlock.dataset.scope = scopeInfo.scope;
  if (!busy && !pending.length) setStatus('');
}

/** 空闲时的说明文字：没有条目时讲它能干什么，有条目时讲保存后会怎样。
 *  extra 用于把「哪几条被丢掉了」这种尾巴接在第二句前面（别接在句号后面）。 */
function idleText(extra) {
  const inBook = scopeInfo.scope === 'worldbook';
  if (!pending.length) {
    return inBook
      ? '点「AI 补设定」，它会读这张副本，补几条这本书用得上的设定（地方、人、规矩、事件）。保存时并进这本书的草稿。'
      : '点「AI 补设定」，它会读这张卡，补几条聊起来用得上的设定（地方、人、规矩、事件）。保存角色时才会建书。';
  }
  const constant = pending.filter((e) => e.constant).length;
  const tail = constant ? `，其中 ${constant} 条常驻` : '';
  const where = inBook
    ? `保存会把它们并进《${scopeInfo.bookName || '这本书'}》的草稿 —— 回世界书编辑器点「保存」才落盘。`
    : '点左栏底部的「保存」才会建成本书并绑到这张卡上。';
  return `已补 ${pending.length} 条${tail}${extra || ''}。${where}`;
}

function render() {
  const node = nodes();
  if (!node) return;

  if (node.btn) {
    node.btn.disabled = false;
    node.btn.textContent = busy ? '中止' : pending.length ? '再补几条' : 'AI 补设定';
    node.btn.title = busy ? '停掉这一次生成' : '读这张卡，补几条这个世界用得上的设定';
  }

  // ⚠️ 状态行只在流程里写（开始 / 中止 / 出错 / 成功），render 不管它 ——
  //    否则收尾那一下 render 会把刚写上去的错误提示盖成「点按钮开始」。
  if (!node.list) return;
  node.list.innerHTML = '';
  node.list.classList.toggle('hidden', !pending.length);

  for (const entry of pending) {
    const expanded = entry.id === expandedId;
    const meta = entry.constant ? '常驻' : `关键词：${entry.keys.join('、')}`;

    const editBtn = h('button', {
      class: 'cwb-ai-edit-btn',
      type: 'button',
      title: expanded ? '收起正文' : '展开正文，就地改',
      'aria-label': `${expanded ? '收起' : '展开'}设定「${entry.title}」的正文`,
      text: expanded ? '收起' : '改',
      onclick: () => toggleEdit(entry.id)
    });

    const del = h('button', {
      class: 'cwb-ai-del',
      type: 'button',
      title: '不要这一条',
      'aria-label': `删掉设定 ${entry.title}`,
      text: '✕',
      onclick: () => removeEntry(entry.id)
    });

    const row = h(
      'div',
      { class: ['cwb-ai-entry', expanded && 'is-open'] },
      h(
        'div',
        { class: 'cwb-ai-line' },
        h('span', { class: 'cwb-ai-title', text: entry.title, title: entry.title }),
        h('span', { class: 'cwb-ai-meta', text: meta, title: meta }),
        editBtn,
        del
      )
    );

    if (expanded) {
      // ⚠️ 这里**不能**在 input 里 render()：一渲染就把正在打字的框换掉，焦点和光标全丢。
      const area = h('textarea', {
        class: 'cwb-ai-content',
        rows: '4',
        spellcheck: 'false',
        'aria-label': `设定「${entry.title}」的正文`,
        oninput: (event) => {
          entry.content = String((event.target && event.target.value) || '');
          onChange();
        }
      });
      area.value = entry.content || '';
      row.append(area);
    }

    node.list.append(row);
  }
}

/** 展开 / 收起某一条的正文（同时只开一条，列表短，不值得做多开） */
function toggleEdit(id) {
  expandedId = expandedId === id ? '' : id;
  render();

  const node = nodes();
  const area = expandedId && node && node.list ? node.list.querySelector('.cwb-ai-content') : null;
  if (area) {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }
}

/** 写状态行。传空串 = 回到空闲说明 */
function setStatus(text) {
  const node = nodes();
  if (!node || !node.status) return;
  node.status.textContent = text || idleText();
  node.status.removeAttribute('aria-busy');
}

/** 生成中：转圈圈 + 文字。按钮这时是「中止」，所以在状态行里转，而不是按钮上 */
function setBusyStatus(text) {
  const node = nodes();
  if (!node || !node.status) return;
  node.status.textContent = '';
  node.status.setAttribute('aria-busy', 'true');
  node.status.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), document.createTextNode(text));
}

function removeEntry(id) {
  const before = pending.length;
  pending = pending.filter((e) => e.id !== id);
  if (pending.length === before) return;
  if (expandedId === id) expandedId = '';
  setStatus('');
  render();
  onChange();
}

/** 新条目并进草稿：同名条目以新的为准（再生成一次不该叠出两份「夜班规矩」） */
function mergePending(entries) {
  const byTitle = new Map(pending.map((e) => [e.title, e]));
  for (const entry of entries) byTitle.set(entry.title, entry);
  pending = [...byTitle.values()].slice(0, MAX_ENTRIES);
  // 被顶掉的那条如果正开着，展开态跟着失效
  if (expandedId && !pending.some((e) => e.id === expandedId)) expandedId = '';
}

// --- 生成 ---

function abort() {
  if (currentGenId) api.stopChat(currentGenId).catch((err) => console.warn('[charBookAi] 中止请求失败:', err));
  currentGenId = null;
  busy = false;
}

async function generate() {
  if (busy) {
    abort();
    setStatus('已中止');
    render();
    return;
  }

  const character = readCard();
  if (!character) return;

  const hasCard = String(character.description || '').trim() || String(character.personality || '').trim();
  if (!hasCard) {
    showToast('先给角色写点描述，AI 才知道该补什么设定', 'error');
    return;
  }

  const target = resolveGenTarget();
  if (!target) return;

  // 副本那一路：条目会并进这本书，写「身边人和事」比写「世界总纲」有用
  const scopeTail = scopeInfo.scope === 'worldbook'
    ? `\n\n【额外要求】这个角色是《${scopeInfo.bookName || '这个世界'}》里的一个配角：你补的条目会并进那本书。` +
      '玩家可能在跟 TA 说话、也可能只是路过 —— 优先写 TA 身边的人和事（外号、地盘、旧账、忌讳），别把整个世界重写一遍。'
    : '';

  const requestId = uid();
  currentGenId = requestId;
  busy = true;
  render();
  setBusyStatus(target.bridge ? '本地模型正在读这张卡…可能要等 30~60 秒' : '正在读这张卡…');

  try {
    const response = await api.sendChat({
      requestId,
      providerId: target.endpoint.provider.id,
      model: target.endpoint.model,
      messages: [
        {
          role: 'system',
          content: `${BOOK_SYSTEM}${scopeTail}\n\n以下是这个角色的卡：\n\n${cardContext(character)}`
        },
        { role: 'user', content: '请直接输出这份设定集的 JSON。' }
      ],
      noImage: true
    });

    // 生成期间用户可能中途中止、或换了张卡 —— 作废的回执不许再改进编辑器
    if (currentGenId !== requestId) return;

    if (!response || response.ok !== true) {
      const message = (response && response.error) || '调用失败';
      if (/abort|中止|cancel/i.test(message)) {
        setStatus('已中止');
        return;
      }
      setStatus(message);
      showToast(message, 'error');
      return;
    }

    const parsed = parseBookEntries(generationText(response, target.bridge));
    if (!parsed.ok) {
      setStatus(parsed.error);
      showToast(`${parsed.error}，这次没补上`, 'error');
      return;
    }

    mergePending(parsed.entries);
    render();
    onChange();

    const dropped = parsed.unusable ? `；另有 ${parsed.unusable} 条缺正文或没关键词，已丢掉` : '';
    setStatus(idleText(dropped));
    showToast(`补了 ${parsed.entries.length} 条设定，点「保存」才落盘`, 'ok');
  } catch (err) {
    if (currentGenId !== requestId) return;
    const message = (err && err.message) || '生成失败';
    if (/abort|中止|cancel/i.test(message)) {
      setStatus('已中止');
      return;
    }
    setStatus(message);
    showToast(message, 'error');
  } finally {
    if (currentGenId === requestId) {
      currentGenId = null;
      busy = false;
      render();
    }
  }
}

// --- 对外 ---

/** 绑定按钮。readCard 由编辑器注入（它才知道表单在哪、草稿怎么收） */
export function initCharBookAi(opts) {
  const o = opts || {};
  if (typeof o.readCard === 'function') readCard = o.readCard;
  if (typeof o.onChange === 'function') onChange = o.onChange;

  const node = nodes();
  if (node && node.btn) {
    node.btn.addEventListener('click', () => {
      generate().catch((err) => console.error('[charBookAi] 生成失败', err));
    });
  }

  render();
  setStatus('');
}

/**
 * 换了一张卡（或刚保存完）：草稿清空、进行中的请求作废。
 * ⚠️ 保存流程里也会走到这里 —— 那时待落盘的条目已经被 materializeCharBook 取走了。
 */
export function resetCharBookAi() {
  if (busy) abort();
  pending = [];
  expandedId = '';
  render();
  setStatus('');
}

/** 世界书里重名时往后挂序号：「XX的世界书 2」 */
function uniqueBookName(base) {
  const taken = new Set(worldbooks().map((b) => String(b.name || '')));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 50; i += 1) {
    const name = `${base} ${i}`;
    if (!taken.has(name)) return name;
  }
  return `${base} ${Date.now().toString(36)}`;
}

/**
 * 把草稿里的条目真的变成一本书，并绑到这张卡上（**保存角色时调用**）。
 * 同一张卡这一次会话里已经建过书，就往后追加，不会再叠第二本。
 *
 * @param {object} character
 * @param {{ scope?: string, bookId?: string }} [options]
 *   副本作用域（scope === 'worldbook'）不建书：条目并进**那本书的草稿**
 *   （见 worldbook.js 的 appendEntriesToBookDraft）。
 * @returns {Promise<{ book: object | null, count: number, draft?: boolean } | null>}
 */
export async function materializeCharBook(character, options) {
  if (!character || !pending.length) return null;

  const o = options || {};
  if (o.scope === 'worldbook') {
    if (!o.bookId) return null;
    const book = worldbookById(o.bookId);
    const ok = appendEntriesToBookDraft(o.bookId, pending);
    if (!ok) {
      // 书在编辑期间被删了：别静默 —— 条目还留在草稿里，用户能看见、能删
      showToast('这本书已经不在了，补的设定没能写进去', 'error');
      return null;
    }
    const count = pending.length;
    pending = [];
    expandedId = '';
    render();
    setStatus('');
    // 延后一拍再报：保存角色自己那条 toast 马上就来，同时弹只会看见后一条
    setTimeout(() => {
      showToast(`已并进《${book ? book.name : '这本书'}》的草稿 —— 回世界书编辑器点「保存」才落盘`);
    }, CONFIG.TOAST_DURATION_MS + 300);
    return { book, count, draft: true };
  }

  let book = null;
  if (madeFor && madeFor.charId === character.id) {
    book = worldbooks().find((b) => b.id === madeFor.bookId) || null;
  }

  // 🔴 自带世界书只能有一本（2026-10-24）：这张卡已经绑了一本，就把补的设定并进那一本，
  // 不再另建 —— 另建的话主进程写盘时会把新 id 裁掉，界面显示 2 本、重启变 1 本。
  if (!book) {
    const boundId = (Array.isArray(character.worldbookIds) ? character.worldbookIds : [])[0];
    book = boundId ? worldbooks().find((b) => b.id === boundId) || null : null;
    if (book) madeFor = { charId: character.id, bookId: book.id };
  }

  if (book) {
    book.entries = [...(Array.isArray(book.entries) ? book.entries : []), ...pending];
    book.updatedAt = now();
  } else {
    book = {
      id: `w${uid()}`,
      name: uniqueBookName(`${String(character.name || '角色').trim() || '角色'}的世界书`),
      entries: pending.slice(),
      characters: [],
      createdAt: now(),
      updatedAt: now()
    };
    state.worldbooks = [...worldbooks(), book];
    madeFor = { charId: character.id, bookId: book.id };
  }

  const ids = Array.isArray(character.worldbookIds) ? [...character.worldbookIds] : [];
  if (!ids.includes(book.id)) {
    ids.push(book.id);
    character.worldbookIds = ids;
  }

  const count = pending.length;
  pending = [];
  expandedId = '';
  render();
  setStatus('');
  return { book, count };
}
