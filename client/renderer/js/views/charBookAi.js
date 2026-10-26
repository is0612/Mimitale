'use strict';

// ============================================================================
//  views/charBookAi.js —— 世界书编辑器里那颗「AI 补条目」
//
//  读这本书（书名 / 已有条目 / 书里的角色副本；书挂在某张卡上时再加上那张卡），
//  让模型补几条还没写到的设定，结果直接并进**这本书的草稿**。
//
//  ⚠️ 不落盘、不另开一份「待采纳」清单：并进草稿之后它们就和手写条目一样躺在左栏，
//     改 / 删 / 放弃只有一套操作（点「保存」才写盘）。旧版养了一份 pending 列表
//     外加一套就地编辑 UI，等于给同一件事做第二个编辑器。
//  ⚠️ 文件名沿用 charBookAi.js（历史名）：改名要新增文件、旧文件还删不掉，
//     公开仓库里不值当。看到这个名字别以为它还管角色卡。
// ============================================================================

import { el } from '../core/dom.js';
import { uid } from '../core/util.js';
import { api } from '../core/api.js';
import { h } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { characters, worldbookCharacters } from '../data/library.js';
import { extractJsonBlock, generationText, resolveGenTarget } from './aiGen.js';
import { appendEntriesToBookDraft } from './worldbook.js';

// --- 提示词 ---

// 上限：一本书里条目再多，这一次也只收这么多；单条正文按世界书的注入上限再留余量。
const MAX_ENTRIES = 12;
const MAX_ENTRY_CONTENT = 1200;
const MAX_ENTRY_KEYS = 6;
const MAX_KEY_CHARS = 24;
// 已有的条目只报「标题 + 关键词」：既让模型知道别重复，又别把整本书塞回给它
const MAX_EXISTING = 40;

// ⚠️ 认这个请求的桩在 tools/smoke-test.js：它同时要「世界书编辑」和 "entries" 两个特征，
//    改措辞时别把这两样一起改没了（改没了请求会被当成普通聊天）。
const BOOK_SYSTEM = `你是一位世界书编辑，负责给一本书补「设定集」（酒馆里的世界书 / lorebook）。

【这份东西怎么用】这本书会跟着一局对话用起来。模型平时看不到条目：只有玩家的某句话里出现了条目上的关键词，这一条才会被塞进上下文。
所以你要写的是「这本书还没写、但聊到那儿迟早得知道」的事 —— 不是把已有的条目换个说法再写一遍，也不是把书名解释一遍。

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
2. 别和已有条目的标题、关键词撞车；已有条目提过的人和地方，写法和设定都要对得上。
   书里已经有的角色，别从头介绍一遍，写 TA 身上还没写的部分。
3. 条目之间要能互相咬合：人物条目里提到的地盘，和地名条目里说的要是同一个地方，名字写法一致。
4. 合起来要像一个世界的切片，大致按这个配额：
   · 2 条左右写地方 / 环境（这里的规矩、它的作息、外人不知道的门道）
   · 1~2 条写人物关系（谁和谁有牵扯、欠过谁、被谁盯着）
   · 1~2 条写门槛 / 忌讳 / 代价（做某件事要付什么、碰什么会出事）
   · 1 条写接下来可能发生的事（constant:false，挂上玩家可能提到的关键词）
5. 允许留白，不要为了凑数把同一件事拆成两条。
6. 只输出 JSON 本身。`;

/** 把书里真正影响「该补什么」的几段拼给模型；太长的一律截断 */
function bookContext(book) {
  const cut = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const parts = [];

  parts.push(`【这本书】《${cut(book.name, 80) || '未命名世界书'}》`);

  // 已有条目：只报标题和关键词。这是模型最容易翻车的地方（把写过的再写一遍）。
  const entries = (Array.isArray(book.entries) ? book.entries : [])
    .filter((e) => e && String(e.title || '').trim())
    .slice(0, MAX_EXISTING);
  if (entries.length) {
    const lines = entries.map((e) => {
      const keys = (Array.isArray(e.keys) ? e.keys : []).filter(Boolean).join('、');
      return `· ${cut(e.title, 40)}${e.constant ? '（常驻）' : keys ? `（${cut(keys, 60)}）` : ''}`;
    });
    parts.push(`【已有条目】\n${lines.join('\n')}`);
  } else {
    parts.push('【已有条目】（这本还是空的，你就是第一个写它的人）');
  }

  // 书里的角色副本：写人物条目时不能和副本里的设定打架
  const copies = worldbookCharacters(book)
    .filter((c) => c && String(c.name || '').trim())
    .slice(0, 8)
    .map((c) => `${cut(c.name, 40)}：${cut(c.description || c.personality, 160) || '（没写设定）'}`);
  if (copies.length) parts.push(`【这本书里已有的角色】\n${copies.join('\n')}`);

  // 这本书挂在某张角色卡上：条目要和那张卡严丝合缝（这是旧版「读卡补设定」留的底子）
  const card = characters().find(
    (c) => c && Array.isArray(c.worldbookIds) && c.worldbookIds.includes(book.id)
  );
  if (card) {
    const bits = [];
    const push = (label, value, max) => {
      const text = cut(value, max);
      if (text) bits.push(`【${label}】\n${text}`);
    };
    bits.push(`【名字】${cut(card.name, 60) || '未命名角色'}`);
    push('描述', card.description, 1400);
    push('性格', card.personality, 700);
    push('场景', card.scenario, 500);
    const tags = (Array.isArray(card.tags) ? card.tags : []).filter(Boolean).slice(0, 10);
    if (tags.length) bits.push(`【标签】${tags.join('、')}`);
    parts.push(`这张书是「${cut(card.name, 60)}」这张角色卡自带的，条目要和这张卡对得上：\n\n${bits.join('\n\n')}`);
  }

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
    return {
      ok: false,
      error: list.length ? '模型给的条目都不能用（缺正文，或既非常驻又没关键词）' : '模型没有给出条目',
      unusable,
      raw: String(raw || '')
    };
  }
  return { ok: true, entries, unusable };
}

// --- 状态 ---

let busy = false;
let currentGenId = null;
let getBook = () => null; // 由世界书编辑器注入：它会先把书名 / 条目表单收进草稿

function nodes() {
  return el && el.wb ? { btn: el.wb.btnAi, status: el.wb.aiStatus } : null;
}

/** 写状态行。传空串 = 收起（空闲时不占地方） */
function setStatus(text) {
  const node = nodes();
  if (!node || !node.status) return;
  node.status.textContent = text || '';
  node.status.classList.toggle('hidden', !text);
  node.status.removeAttribute('aria-busy');
}

function setBusyStatus(text) {
  const node = nodes();
  if (!node || !node.status) return;
  node.status.textContent = '';
  node.status.classList.remove('hidden');
  node.status.setAttribute('aria-busy', 'true');
  node.status.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), document.createTextNode(text));
}

/** 按钮只改字和禁用态，状态行只在流程里写 —— 让 render 顺手写的话，收尾那一下会把刚报的错盖掉 */
function renderButton() {
  const node = nodes();
  if (!node || !node.btn) return;
  node.btn.textContent = busy ? '中止' : 'AI 补条目';
  node.btn.title = busy ? '停掉这一次生成' : '读这本书，补几条还没写到的设定';
}

function abort() {
  if (currentGenId) api.stopChat(currentGenId).catch((err) => console.warn('[charBookAi] 中止请求失败:', err));
  currentGenId = null;
  busy = false;
}

// --- 生成 ---

async function generate() {
  if (busy) {
    abort();
    setStatus('已中止');
    renderButton();
    return;
  }

  const book = getBook();
  if (!book) return;

  const target = resolveGenTarget();
  if (!target) return;

  const requestId = uid();
  currentGenId = requestId;
  busy = true;
  renderButton();
  setBusyStatus(target.bridge ? '本地模型正在读这本书…可能要等 30~60 秒' : '正在读这本书…');

  try {
    const response = await api.sendChat({
      requestId,
      providerId: target.endpoint.provider.id,
      model: target.endpoint.model,
      messages: [
        { role: 'system', content: `${BOOK_SYSTEM}\n\n以下是这本书现在的样子：\n\n${bookContext(book)}` },
        { role: 'user', content: '请直接输出这份设定集的 JSON。' }
      ],
      noImage: true
    });

    // 生成期间用户可能中途中止、或换了另一本书 —— 作废的回执不许再改进草稿
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

    const result = appendEntriesToBookDraft(book.id, parsed.entries);
    if (!result || !result.added) {
      // 全是同名条目（模型照抄了已有的）—— 这不算成功，别报「补了 N 条」
      setStatus(result && result.skipped ? '补回来的条目这本书已经有了' : '这本书已经不在了');
      return;
    }

    const dropped = parsed.unusable ? `，另有 ${parsed.unusable} 条缺正文或没关键词已丢掉` : '';
    const skipped = result.skipped ? `，${result.skipped} 条和已有条目重名略过` : '';
    setStatus(`补了 ${result.added} 条，已经在左栏了 —— 点「保存」才写进磁盘。`);
    showToast(`补了 ${result.added} 条条目${dropped}${skipped}`, 'ok');
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
      renderButton();
    }
  }
}

// --- 对外 ---

/** 接线。getBook 由世界书编辑器注入（它才知道当前编辑的是哪本、草稿怎么收） */
export function initBookAi(opts) {
  const o = opts || {};
  if (typeof o.getBook === 'function') getBook = o.getBook;

  const node = nodes();
  if (node && node.btn) {
    node.btn.addEventListener('click', () => {
      generate().catch((err) => console.error('[charBookAi] 生成失败', err));
    });
  }

  renderButton();
  setStatus('');
}
