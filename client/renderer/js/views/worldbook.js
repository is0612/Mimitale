// 世界书编辑器：左栏选书、中栏列条目、右栏编辑。书名 / 条目都是草稿（wbDrafts），
// 点页头「保存」才写回并落盘；跨视图编排（角色编辑）由 initWorldbook 注入。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now, activeConvo, asArray } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { h, button, clear, libraryCard } from '../ui/build.js';
import { mButton } from '../components/index.js';
import { entityTone } from '../ui/avatarTone.js';
import { openLightbox } from '../ui/lightbox.js';
import { showView, currentViewName } from './viewSwitch.js';
import { persistLibrary, persistConversations } from '../data/persist.js';
import {
  worldbooks,
  worldbookById,
  worldbookCharacters,
  characters,
  characterPortrait,
  effectiveWorldbookIds,
  WORLDBOOK_SCAN_DEPTH,
  recursiveDepthSetting
} from '../data/library.js';
// 「能扫的历史」只有一份：发送 / 右栏计数 / 这里的预览共用（见 data/cast.js）
import { worldbookScanHistory } from '../data/cast.js';
import { removePanelOwnerFields } from '../data/panel.js';
import { renderAll } from './redraw.js';
import { initWorldbookLayout, syncWorldbookLayout, resetWorldbookLayout, revealWorldbookEntry, setWorldbookPanel, worldbookEntryVisible } from './worldbookLayout.js';

function syncEditorLayout() {
  const book = currentWorldbook();
  syncWorldbookLayout(book, currentDraft(), book ? worldbookCharacters(book).length : 0);
}

// --- 入口层注入的跨视图编排动作 ---
// 切到本书某角色 / 释放作用域 / 回写草稿
let openInBook = () => {};
let releaseScope = () => {};
let stashDraft = () => {};
// 离开编辑器后通知入口层（回到角色编辑器时，那边「已绑世界书」那行要按最新数据重画）
let afterLeave = () => {};

/** 事件处理器里跑异步动作：出错统一 toast，别变成 unhandled rejection */
function runAsync(action) {
  return () => {
    Promise.resolve()
      .then(action)
      .catch((err) => {
        console.error('[worldbook] 操作失败', err);
        showToast((err && err.message) || '操作失败', 'error');
      });
  };
}

export function initWorldbook(opts = {}) {
  if (typeof opts.openInBook === 'function') openInBook = opts.openInBook;
  if (typeof opts.releaseScope === 'function') releaseScope = opts.releaseScope;
  if (typeof opts.stashDraft === 'function') stashDraft = opts.stashDraft;
  if (typeof opts.afterLeave === 'function') afterLeave = opts.afterLeave;

  initWorldbookLayout({ onFilter: () => {
    stashEntryForm();
    renderEntryList();
  } });

  // --- 编辑器本体 ---
  el.wb.btnClose.addEventListener('click', runAsync(leaveWorldbookEditor));
  el.wb.btnNewEntry.addEventListener('click', newEntry);
  if (el.wb.btnEntryTemplate) el.wb.btnEntryTemplate.addEventListener('click', applyEntryTemplate);
  if (el.wb.btnWbAddEvent) el.wb.btnWbAddEvent.addEventListener('click', addEventEntry);
  el.wb.btnDelBook.addEventListener('click', runAsync(deleteWorldbook));
  el.wb.btnDelEntry.addEventListener('click', runAsync(deleteEntry));
  el.wb.btnSave.addEventListener('click', runAsync(saveWorldbook));
  el.wb.btnPreview.addEventListener('click', runAsync(previewWorldbook));

  // 书名 / 条目都只写草稿 + 举「未保存」的旗子，点「保存」才写回并落盘。
  el.wb.name.addEventListener('input', () => {
    if (!currentDraft()) return;
    stashWorldbookName();
    markDraftDirty();
  });

  // 表单任何改动都算「这本书有未保存的改动」；fillEntryForm 是程序写 .value，
  // 不触发事件，所以不会误标。input 管文本 / 数字 / 文本域，change 管下拉和勾选框。
  el.wb.form.addEventListener('input', markDraftDirty);
  el.wb.form.addEventListener('change', markDraftDirty);
  el.wb.e.content.addEventListener('input', () => {
    stashEntryForm();
    syncEditorLayout();
    renderEntryList();
  });
  for (const control of [el.wb.e.constant, el.wb.e.recursive, el.wb.e.enabled]) {
    control.addEventListener('change', () => {
      stashEntryForm();
      renderEntryList();
    });
  }

  // 条目名 / 关键词跟着左栏那一行实时走，否则新建的条目会一直叫「新条目」，
  // 直到整本书保存才改过来。
  el.wb.e.title.addEventListener('input', () => {
    const entry = currentEntry();
    if (!entry) return;
    entry.title = el.wb.e.title.value.trim().slice(0, 200) || '未命名条目';
    renderEntryList();
  });

  el.wb.e.keys.addEventListener('input', () => {
    const entry = currentEntry();
    if (!entry) return;
    entry.keys = parseEntryKeys(el.wb.e.keys.value);
    renderEntryList();
  });
}

// --- 条目 / 编辑器状态 ---

const WB_NEW_ENTRY_DEFAULTS = {
  order: 100,
  probability: 100,
  selectiveLogic: 'AND_ANY'
};

let editingWorldbookId = null; // 世界书编辑器里当前选中的书
let editingEntryId = null; // 编辑器里当前选中的条目

/** 编辑器草稿：bookId → { name, entries, dirty }，每本书各留一份。
 *  **不含 characters**（角色副本直接改直接落盘，两边才不会互相踩）。 */
const wbDrafts = new Map();

/** 条目的深拷贝：草稿改了不能顺手改到 state 里那份 */
function cloneEntries(entries) {
  return JSON.parse(JSON.stringify(Array.isArray(entries) ? entries : []));
}

function draftFor(book) {
  if (!book) return null;
  let draft = wbDrafts.get(book.id);
  if (!draft) {
    draft = {
      name: book.name || '未命名世界书',
      entries: cloneEntries(book.entries),
      dirty: false
    };
    wbDrafts.set(book.id, draft);
  }
  return draft;
}

/** 编辑器里正在显示的那一本的草稿 */
function currentDraft() {
  return currentWorldbook() ? draftFor(currentWorldbook()) : null;
}

/** 有未保存改动的那些书（离开编辑器时用它拼提示语） */
function unsavedDrafts() {
  const out = [];
  for (const [id, draft] of wbDrafts) {
    const book = worldbookById(id);
    if (book && draft.dirty) out.push({ book, draft });
  }
  return out;
}

/** 举旗子：这本书有未保存的改动 */
function markDraftDirty() {
  const draft = currentDraft();
  if (!draft) return;
  if (!draft.dirty) draft.dirty = true;
  renderDirtyHint();
}

/** 页头右侧的保存状态胶囊：只显示当前这本，另附一句别的书还欠着几本。 */
function renderDirtyHint() {
  syncEditorLayout();
  const node = el.wb.saveState;
  if (!node) return;

  const mine = currentDraft();
  const all = unsavedDrafts().length;
  const others = all - (mine && mine.dirty ? 1 : 0);
  const dirty = !!(mine && mine.dirty) || others > 0;

  node.dataset.state = dirty ? 'dirty' : 'saved';
  node.textContent = mine && mine.dirty
    ? others ? `有未保存的改动（另有 ${others} 本）` : '有未保存的改动'
    : others ? `另有 ${others} 本有未保存的改动` : '所有更改已保存';
}

/**
 * 「AI 补条目」用：把补出来的条目并进这本书的**草稿**（不落盘）。
 *
 * ⚠️ 不能直接往 `book.entries` 里塞：世界书编辑器手里可能正压着一份脏草稿，
 *    之后点「保存」会用那份草稿整体覆盖 entries —— 直接塞的条目会被**静默吞掉**。
 *    并进草稿之后，它们就在左栏的条目列表里，和手写的条目一样受「保存 / 放弃」管。
 *
 * @param {string} bookId
 * @param {object[]} entries 世界书条目形状（和 newEntry 造出来的一致）
 * @returns {{ added: number, skipped: number }} added = 真加进去几条，skipped = 重名跳过几条
 */
export function appendEntriesToBookDraft(bookId, entries) {
  const book = worldbookById(bookId);
  const list = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && String(entry.content || '').trim()
  );
  if (!book || !list.length) return { added: 0, skipped: 0 };

  // 编辑器里可能正开着某一条：先把它收进草稿，免得下面重画列表时拿旧表单回写
  stashEntryForm();

  const draft = draftFor(book);
  // 同名跳过：再点一次「AI 补条目」时模型最爱照抄写过的标题，叠进去就是两条一样的
  const taken = new Set(draft.entries.map((e) => String((e && e.title) || '').trim()));
  const fresh = [];
  for (const entry of list) {
    const title = String(entry.title || '').trim();
    if (taken.has(title)) continue;
    taken.add(title);
    fresh.push(entry);
  }
  const skipped = list.length - fresh.length;
  if (!fresh.length) return { added: 0, skipped };

  draft.entries = [...draft.entries, ...fresh];
  if (!draft.dirty) draft.dirty = true;

  // 正编辑着这一本：左栏列表 / 条目数立刻跟着变，否则回到这一屏看到的还是旧列表
  if (editingWorldbookId === book.id) {
    el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
    renderEntryList();
  }
  renderDirtyHint();
  return { added: fresh.length, skipped };
}

/** 草稿写回世界书（点「保存」时用）。返回是否真的提交了 */
function commitDraft(bookId) {
  const book = worldbookById(bookId);
  const draft = wbDrafts.get(bookId);
  if (!book || !draft) return false;

  book.name = String(draft.name || '').trim().slice(0, 120) || '未命名世界书';
  book.entries = cloneEntries(draft.entries);
  book.updatedAt = now();

  // 草稿作废：下次进这本书会按刚保存的内容重新拷一份
  wbDrafts.delete(bookId);
  return true;
}

/** 丢掉所有草稿。书本身早就落盘了（见 createWorldbook），这里没有「连壳一起收掉」这一步。 */
function discardDrafts() {
  wbDrafts.clear();
}

/** 把「正在编辑的这本书」保存到磁盘：粒度是**整本书**（书名 + 所有条目）。
 *  条目不是独立对象，拆成「保存条目」会让人以为存过了其实没存。 */
async function saveWorldbook() {
  const book = currentWorldbook();
  const draft = currentDraft();
  if (!book || !draft) return;

  // 输入框里的内容可能还没进草稿（比如刚敲完就点保存）
  stashWorldbookName();
  stashEntryForm();

  if (!draft.dirty) {
    showToast('没有要保存的改动');
    return;
  }

  // 永远注入不了的条目，两类原因分开数（弹两条 toast 只有后一条看得见，所以并进这一条）：
  //   ① 正文是空的 —— 命中了也没东西可塞，`entryMatches` 直接判 false；
  //   ② 既没关键词也不是常驻 —— 根本不会被挑中。
  // ⚠️ 以前只数了 ②，于是「填了关键词、忘写正文」这种最常见的漏，保存后一句提示都没有。
  const noBody = draft.entries.filter((e) => !String(e.content || '').trim()).length;
  const noTrigger = draft.entries.filter(
    (e) => String(e.content || '').trim() && !e.constant && !(Array.isArray(e.keys) && e.keys.length)
  ).length;
  const reasons = [];
  if (noBody) reasons.push(`${noBody} 条正文是空的`);
  if (noTrigger) reasons.push(`${noTrigger} 条没有关键词也不是常驻`);

  const name = draft.name;
  commitDraft(book.id);

  // 保存之后才是「真的改了」：条目数、会话注入用的数据都在这一刻对齐
  renderDirtyHint();

  // 失败提示由 persistLibrary 弹（「世界书没能写进磁盘…」），
  // 这里再弹一条会把那条更具体的盖掉。
  if (!(await persistLibrary())) return;
  const tail = reasons.length ? ` · ${reasons.join('、')}，永远不会被注入` : '';
  showToast(`「${name}」已保存${tail}`, 'ok');
}

/** 世界书的条目数展示（列表头的小头条） */
function wbEntryCountText(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  const on = list.filter((e) => e.enabled !== false).length;
  const constant = list.filter((e) => e.constant).length;
  const parts = [`${total} 条`];
  parts.push(on === total ? '全部启用' : `${on} 启用`);
  if (constant) parts.push(`${constant} 常驻`);
  return parts.join(' · ');
}

export function currentWorldbook() {
  return worldbookById(editingWorldbookId);
}

function currentEntry() {
  const draft = currentDraft();
  if (!draft) return null;
  return draft.entries.find((e) => e.id === editingEntryId) || null;
}

/** 把世界书表单里的内容写进草稿（书名）。不落盘，只改内存里的那一份 */
function stashWorldbookName() {
  const draft = currentDraft();
  if (!draft || el.wb.bookWrap.classList.contains('hidden')) return;
  draft.name = (el.wb.name.value.trim() || '未命名世界书').slice(0, 120);
}

/** 关键词输入框 → 关键词数组（逗号分隔，中英文逗号都认） */
function parseEntryKeys(value) {
  return String(value || '')
    .split(/[,，]/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 200);
}

/** 把条目表单里的内容写进草稿里的那条条目 */
function stashEntryForm() {
  const entry = currentEntry();
  if (!entry || el.wb.form.classList.contains('hidden')) return;

  entry.title = el.wb.e.title.value.trim().slice(0, 200) || parseEntryKeys(el.wb.e.keys.value)[0] || '未命名条目';
  entry.keys = parseEntryKeys(el.wb.e.keys.value);
  entry.secondaryKeys = parseEntryKeys(el.wb.e.keys2.value);
  // 界面上没有「启用副关键词」开关，由「格子里有没有填」决定；必须在这里同步，
  // 否则从酒馆导入的条目会静默失效，看不出原因。
  entry.selective = entry.secondaryKeys.length > 0;
  entry.selectiveLogic = el.wb.e.logic.value;
  entry.content = el.wb.e.content.value.slice(0, 20000);

  // 空串不能走 Number('') → 0：顺序清空会变成 0（合法但意外），
  // 概率清空会变成 0（这条从此永远不触发）。空 = 用默认值。
  const orderText = el.wb.e.order.value.trim();
  const order = Number(orderText);
  entry.order = orderText !== '' && Number.isFinite(order)
    ? Math.max(0, Math.min(9999, Math.floor(order)))
    : WB_NEW_ENTRY_DEFAULTS.order;

  const probText = el.wb.e.prob.value.trim();
  const prob = Number(probText);
  entry.probability = probText !== '' && Number.isFinite(prob)
    ? Math.max(0, Math.min(100, Math.floor(prob)))
    : WB_NEW_ENTRY_DEFAULTS.probability;

  entry.constant = el.wb.e.constant.checked;
  entry.recursive = el.wb.e.recursive.checked;
  entry.enabled = el.wb.e.enabled.checked;
}

/** 把「编辑器里正在填的东西」先写进草稿 —— 导入 / 切书 / 打开角色编辑器之前要调 */
export function stashWorldbookForm() {
  stashWorldbookName();
  stashEntryForm();
}

function renderEntryList() {
  el.wb.entryList.innerHTML = '';

  const draft = currentDraft();
  if (!draft) return;

  syncEditorLayout();
  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  const entries = draft.entries.filter(worldbookEntryVisible);
  if (!entries.length) {
    el.wb.entryList.appendChild(
      h('div', { class: 'wb-list-empty', text: draft.entries.length ? '没有匹配的条目' : '这本书还没有条目' })
    );
    return;
  }

  for (const entry of entries) {
    // 两行两列：① 名称 + 状态徽章 ② 关键词 + 「字数 · 顺序」；
    // 右边那一列是 × 的**专属位置**（横跨两行、自己垂直居中）。
    // 改版前 × 是绝对定位浮在右上角、元信息贴着它 —— 看着像溢出没排好（2026-10-20）。
    const order = entry.order ?? WB_NEW_ENTRY_DEFAULTS.order;
    const words = String(entry.content || '').length;
    el.wb.entryList.appendChild(
      h(
        'div',
        {
          class: ['wb-entry', entry.id === editingEntryId && 'active', entry.enabled === false && 'disabled'],
          title: entry.title,
          tabindex: '0',
          'aria-label': `编辑条目「${entry.title}」`,
          onkeydown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectEntry(entry.id);
            }
          },
          onclick: () => selectEntry(entry.id)
        },
        h(
          'div',
          { class: 'wb-entry-title' },
          h('span', { class: 'wb-entry-name', text: entry.title }),
          entry.constant && h('span', { class: 'wb-badge', text: '常驻' }),
          entry.enabled === false && h('span', { class: 'wb-badge', text: '停用' })
        ),
        h(
          'div',
          { class: 'wb-entry-sub' },
          h('span', { class: 'wb-entry-keys', text: (entry.keys || []).join(' / ') || '（无关键词）' }),
          h('span', { class: 'wb-entry-meta', text: `${words} 字 · ${order}`, title: `${words} 字 · 插入顺序 ${order}` })
        ),
        // 行上的 ×：只删草稿所以不问确认；stopPropagation 必须加，否则这一下会同时选中该条。
        button({
          class: 'wb-entry-del',
          text: '×',
          title: '删除这条条目（点「保存」才写进磁盘）',
          ariaLabel: `删除条目「${entry.title}」`,
          onClick: (event) => {
            event.stopPropagation();
            if (removeEntry(entry.id)) {
              showToast('条目已删除，点「保存」才写进磁盘；不保存关掉就还原');
            }
          }
        })
      )
    );
  }
}

function showEntryForm(show) {
  el.wb.form.classList.toggle('hidden', !show);
  el.wb.formEmpty.classList.toggle('hidden', !!show);
  syncEditorLayout();
}

function fillEntryForm(entry) {
  if (!entry) {
    showEntryForm(false);
    return;
  }

  el.wb.e.title.value = entry.title || '';
  el.wb.e.keys.value = (entry.keys || []).join(', ');
  el.wb.e.content.value = entry.content || '';
  el.wb.e.order.value = String(entry.order ?? WB_NEW_ENTRY_DEFAULTS.order);
  el.wb.e.prob.value = String(entry.probability ?? 100);
  el.wb.e.keys2.value = (entry.secondaryKeys || []).join(', ');
  el.wb.e.logic.value = entry.selectiveLogic || 'AND_ANY';
  el.wb.e.constant.checked = entry.constant === true;
  el.wb.e.recursive.checked = entry.recursive === true;
  el.wb.e.enabled.checked = entry.enabled !== false;

  showEntryForm(true);
  syncEditorLayout();
}

/** 把编辑焦点安全地切到某一本；外部**不要自己动 editingWorldbookId**，切换前必须让
 *  selectWorldbook 先把界面表单 stash 回原来那一本。@returns {boolean} 书不存在为 false */
export function focusWorldbook(id) {
  if (!worldbookById(id)) return false;
  selectWorldbook(id);
  return true;
}

/** 选中一本世界书。⚠️ 这是**唯一**改 editingWorldbookId 的地方，且必须先 stash ——
 *  那两个 stash 读的是界面输入框，只有此时 currentWorldbook() 还指着正在显示的那本才写得对。 */
function selectWorldbook(id) {
  stashWorldbookName();
  stashEntryForm();

  editingWorldbookId = id;
  resetWorldbookLayout(id);
  const book = currentWorldbook();

  el.wb.bookEmpty.classList.toggle('hidden', !!book);
  el.wb.bookWrap.classList.toggle('hidden', !book);

  if (!book) {
    editingEntryId = null;
    showEntryForm(false);
    renderDirtyHint();
    return;
  }

  // 有草稿就显示草稿（切走再切回来不会丢没保存的改动），没有就按当前内容新拷一份
  const draft = draftFor(book);
  el.wb.name.value = draft.name;
  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  // 底部提示写的是**落盘过的**书名：一眼分得清「界面上在改什么」和「盘上是什么」
  el.wb.footHint.textContent = `「${book.name}」只保存在你自己电脑上`;

  // 上一本书选中的条目在新书里不存在，自动落到第一条
  if (!currentEntry()) {
    editingEntryId = draft.entries.length ? draft.entries[0].id : null;
  }

  renderEntryList();
  fillEntryForm(currentEntry());
  renderDirtyHint();
}

function selectEntry(id) {
  stashEntryForm();
  editingEntryId = id;
  revealWorldbookEntry(currentEntry());
  renderEntryList();
  fillEntryForm(currentEntry());
  if (currentEntry()) el.wb.e.title.focus({ preventScroll: true });
}

// 本书角色：从角色卡复制进来的独立副本（改这边不影响角色卡，反之亦然）。
// 它同时就是「这本书的 NPC 名单」——GM 提示词里的名单按它拼。
// 人物列表现在只在「角色卡编辑页」展示，这里不再画。

// 每本书 → 展示它角色副本的宿主节点列表。角色增删 / 显示状态切换后，把所有宿主一起重绘
// （现在只有角色卡编辑页的 #char-book-roles 这一个宿主）。
const bookCharHosts = new Map();

/**
 * 一个副本卡：和角色卡列表同一副骨架（2:3 封面 + 名称 + 标签行）。
 * 人物是有形象的，所以铺立绘而不是小圆头像；文字只给名称和标签，不再塞描述预览。
 * ⚠️ 「显示状态」做成封面左下角浮标：操作行按 216px 只塞得下两颗，
 *    第三颗（四个字）会把每颗挤到 43px 以下（见 .char-card-actions 的 flex 基准）。
 */
function bookCharCard(book, c) {
  const tags = (Array.isArray(c.tags) ? c.tags : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const portrait = characterPortrait(c);
  const shown = c.showInPanel === true;

  const showBtn = h('button', {
    type: 'button',
    class: `char-card-show${shown ? ' is-on' : ''}`,
    // 只写「状态栏」+ 实心/空心点：216px 的卡上写「状态栏 · 显示」会盖掉小半个封面
    text: `${shown ? '●' : '○'} 状态栏`,
    title: '在右栏「在场角色」入口条上显示这个副本的状态',
    'aria-pressed': shown ? 'true' : 'false',
    onclick: (event) => {
      // 卡片本身可点（封面开大图 / 批量选择），这一下不该连带触发
      event.stopPropagation();
      // ⚠️ runAsync(fn) 返回的是「执行闭包」，这里必须立刻调用 —— 只写 runAsync(fn)
      //    不调用就等于点了没反应（这是「状态栏浮标点不动」的根因）。
      runAsync(() => toggleWorldbookCharShowInPanel(book, c.id, !shown))();
    }
  });

  return libraryCard({
    title: c.name,
    sub: tags.join(' · ') || '还没有标签',
    media: portrait ? h('img', { src: portrait, alt: '' }) : String(c.name || '').slice(0, 1) || '?',
    mediaClass: ['art-edge', entityTone(c.id, c.name)],
    mediaTitle: `${c.name} · 点开看大图`,
    onMediaClick: portrait ? () => openLightbox(portrait, { title: c.name }) : null,
    coverExtra: showBtn,
    actions: [
      mButton({
        variant: 'ghost',
        size: 'sm',
        text: '编辑',
        title: '编辑这个副本的设定',
        onClick: () => editWorldbookCharacter(book, c.id)
      }),
      mButton({
        variant: 'ghost',
        size: 'sm',
        text: '移出本书',
        title: '从本书移除（角色卡里的不受影响）',
        onClick: () => runAsync(() => removeWorldbookCharacter(book, c.id))()
      })
    ]
  });
}

/** 把某本书的角色副本画进指定宿主（角色卡编辑页「人物列表」分区用）。
 *  ⚠️ 宿主不存在、或 book 为空时静默跳过 —— 调用方不必自己判空。 */
export function renderBookCharacters(book, host) {
  if (!host || !book) return;

  // 注册宿主：之后这本书角色一变，所有注册过的宿主一起重绘。
  let hosts = bookCharHosts.get(book.id);
  if (!hosts) bookCharHosts.set(book.id, (hosts = new Set()));
  hosts.add(host);

  clear(host);

  const copies = worldbookCharacters(book);

  // 一个副本都没有时给一张虚线引导卡，说明副本和角色卡是两回事
  if (!copies.length) {
    host.appendChild(
      h(
        'div',
        { class: 'wb-char-empty' },
        h('h3', { text: '这本书还没有人物' }),
        h('p', {
          text: '这本书里的人物只在绑定了这本书的会话里出现，和角色卡相互独立 —— 在这里改，不会动到角色卡里的原卡。'
        }),
        h('span', {
          class: 'wb-char-empty-hint',
          text: `用上面「＋ 新建」自己写一个，或「AI 生成」按这本书已有的 ${(book.entries || []).length} 条设定起一个草稿。`
        })
      )
    );
    return;
  }

  for (const c of copies) host.appendChild(bookCharCard(book, c));
}

/** 重绘某本书所有已注册的人物列表宿主（角色增删 / 显示状态切换后调） */
export function rerenderBookCharHosts(book) {
  if (!book) return;
  const hosts = bookCharHosts.get(book.id);
  if (!hosts) return;
  for (const host of hosts) {
    if (host.isConnected) renderBookCharacters(book, host);
    else hosts.delete(host);
  }
}

/** 从本书移除一个角色副本（角色卡里的角色不动） */
async function removeWorldbookCharacter(book, id) {
  if (!book) return;

  const target = worldbookCharacters(book).find((c) => c.id === id);
  if (!target) return;

  const ok = await confirmDialog({
    title: '移除角色',
    message: `把「${target.name}」从这本书里移除？角色卡里的那个角色不受影响。`,
    confirmText: '移除',
    danger: true
  });
  if (!ok) return;

  const before = worldbookCharacters(book).slice();
  const beforeUpdated = book.updatedAt;
  book.characters = worldbookCharacters(book).filter((c) => c.id !== id);
  book.updatedAt = now();

  rerenderBookCharHosts(book);
  if (!(await persistLibrary())) {
    // 写盘失败：把内存也退回去，别让界面显示「已移除」而磁盘上还在。
    book.characters = before;
    book.updatedAt = beforeUpdated;
    rerenderBookCharHosts(book);
    return;
  }
  showToast('已移除', 'ok');
}

/** 打开角色编辑器，但作用域切到这本书的角色副本。
 *  ⚠️ 先 focusWorldbook 把「当前书」切过去：角色卡编辑页里点「编辑」时世界书编辑器
 *  可能根本没打开（editingWorldbookId 还指着别的书或 null），不切过去副本会找不到。 */
function editWorldbookCharacter(book, id) {
  if (!book) return;
  if (!focusWorldbook(book.id)) return;
  openInBook(id);
}

/** 切换某个副本「在状态栏显示」：showInPanel 存在本书的副本上，同一角色放进不同的书
 *  可以各显示各的；改完立刻重绘当前会话。 */
async function toggleWorldbookCharShowInPanel(book, id, on) {
  if (!book) return;

  const target = worldbookCharacters(book).find((c) => c.id === id);
  if (!target) return;

  const beforeShow = target.showInPanel;
  const beforeTargetUpdated = target.updatedAt;
  const beforeBookUpdated = book.updatedAt;
  target.showInPanel = on === true;
  target.updatedAt = now();
  book.updatedAt = now();

  if (!(await persistLibrary())) {
    // 写盘失败：把勾选状态退回去，别让界面和磁盘两边不一致。
    target.showInPanel = beforeShow;
    target.updatedAt = beforeTargetUpdated;
    book.updatedAt = beforeBookUpdated;
    rerenderBookCharHosts(book);
    return;
  }
  // ⚠️ 先重绘人物列表：卡片上那颗「○/● 状态栏」浮标要立刻跟着切换，
  //    否则用户点完浮标还是空心、以为没点上（这是「点不动」的根因）。
  rerenderBookCharHosts(book);
  // 「当前状态」入口条按当前会话的面板画，正在玩这本书就得重绘一次，头像才会立刻增删。
  if (activeConvo() && effectiveWorldbookIds(activeConvo()).includes(book.id)) {
    renderAll();
  }
  showToast(on ? `「${target.name}」的状态会显示了` : `「${target.name}」的状态已隐藏`, 'ok');
}

/** 编辑器只负责编辑「当前这一本」；书从角色的「自带世界书」里长出来（见 createWorldbook）。 */

/** 「AI 补条目」要读的那本书：先把手写进输入框的内容收进草稿，模型读到的才是屏幕上这份。
 *  ⚠️ 别在 worldbook.js 里 import charBookAi —— 那边要从这里拿 appendEntriesToBookDraft，
 *    反过来引就成了环。接线放在入口层（main.js）。 */
export function aiBookTarget() {
  if (!currentWorldbook()) return null;
  stashWorldbookName();
  stashEntryForm();
  return currentWorldbook();
}

/** 打开编辑器并切到指定的一本（外部要跳转时用） */
export function openWorldbookEditor(id) {
  if (!worldbookById(id)) return;
  openWorldbooksModal(id);
}

/** 打开编辑器，可选地切到某一本。⚠️ 这里**只传目标 id，不先改 editingWorldbookId**：
 *  selectWorldbook 一上来会把界面表单 stash 给还没切走的那一本，抢先改就会把旧书名写进新书。 */
function openWorldbooksModal(targetId) {
  // 角色卡可能没开着，stashCharForm 内部会自己判断
  stashDraft();

  const wanted = typeof targetId === 'string' && targetId ? targetId : editingWorldbookId;
  const next = worldbookById(wanted) ? wanted : worldbooks().length ? worldbooks()[0].id : null;

  // 记下来处：Esc / 页头「返回」/ 保存完都会回到它；已经在编辑页里就别覆盖，不然「返回」会原地打转。
  const from = currentViewName();
  if (from !== 'wbEditor') editorReturnView = from;

  selectWorldbook(next);
  // 每次都落在「条目」屏（书籍设置屏已经撤了，书名改在条目左栏顶部）。
  setWorldbookPanel('entries');

  showView('wbEditor');
}

/** 进来之前停在哪一屏（离开世界书编辑器时回到它） */
let editorReturnView = 'chars';

/** 离开世界书编辑器（入口层的 Esc 链统一走它）；有草稿改动时先问一句「放弃改动？」。
 *  「保存后才生效」的另一面就是「不保存就会丢」。 */
export async function leaveWorldbookEditor() {
  stashWorldbookName();
  stashEntryForm();

  const pending = unsavedDrafts();
  if (pending.length) {
    const names = pending.map(({ draft, book }) => `「${draft.name || book.name}」`).slice(0, 3).join('、');
    const tail = pending.length > 3 ? ` 等 ${pending.length} 本` : '';
    const ok = await confirmDialog({
      title: '放弃未保存的改动',
      message: `${names}${tail}有没保存的改动，关掉就丢了。`,
      confirmText: '放弃改动',
      danger: true
    });
    if (!ok) return;
  }

  // 放弃：草稿全部清掉（书本身早就落盘了，这里不删书）
  discardDrafts();
  // ⚠️ 表单必须收起来：否则下次 selectWorldbook 先 stash 时，会把已放弃的书名 / 条目
  //    再写进一份新草稿、一点保存就落盘。两个 stash 都认「表单隐藏 → 不读」。
  el.wb.bookWrap.classList.add('hidden');
  showEntryForm(false);

  const back = editorReturnView === 'wbEditor' ? 'chars' : editorReturnView;
  showView(back);
  renderDirtyHint();
  // 回到角色编辑器时，那边「已绑世界书」那行可能刚被改名 / 加过条目 —— 交给入口层重画
  afterLeave(back);
}

/** 新建一本世界书并**立刻落盘**，返回这本新书（写盘失败回 null）。
 *  ⚠️ 不能只在内存里造个壳：调用方紧接着要把它绑到角色上，角色上的 id 必须指向盘上真有的书。 */
export async function createWorldbook() {
  const book = {
    id: `w${uid()}`,
    name: '新世界书',
    entries: [],
    characters: [],
    createdAt: now(),
    updatedAt: now()
  };

  const before = worldbooks();
  state.worldbooks = [...before, book];
  if (!(await persistLibrary())) {
    state.worldbooks = before;
    return null;
  }
  return book;
}

// 世界书条目模板：主线走向 / 主要人物 / 专有名词常驻，事件表常驻 + 固定关键词；四条都是空骨架。
// ⚠️ 不含「视角规则」「人物的变化」——那两条已是内置默认规则（data/narration.js），再种只会白占 token。
const WB_ENTRY_TEMPLATE = [
  {
    title: '主线走向',
    constant: true,
    order: 100,
    content: [
      '先定三到五步，再往下写。每步一句话，只写「发生什么」，不写细节：',
      '1. 开场：{玩家进入这个世界遇到的第一件事}',
      '2. 升级：{什么打破了原来的平衡}',
      '3. 转折：{一个不可逆的节点}',
      '4. 收束：{这件事最后按什么方向落地}',
      '每轮只推进当前这一步的一小段，不要跳步。'
    ].join('\n')
  },
  {
    title: '主要人物',
    constant: true,
    order: 100,
    content: [
      '每个 NPC 一行，写清「想要什么」和「什么挡着他」：',
      '- {名字}：{身份}；想要{…}，但{…}。',
      '（只列玩家会碰到的人。装不下的细节另开条目，用关键词触发。）'
    ].join('\n')
  },
  {
    title: '专有名词',
    constant: true,
    order: 100,
    content: [
      '这个世界特有的词，一个一个写清它是什么、怎么起作用：',
      '- {词}：{一句话定义}；{它会造成什么后果}。'
    ].join('\n')
  },
  {
    title: '事件表',
    constant: true,
    order: 888,
    content: [
      '下面这些剧情挂在固定关键词上，玩家提到关键词时就把它演出来，不要简略带过：',
      '- 「{关键词}」→ {发生什么}',
      '- 「{关键词}」→ {发生什么}',
      '- 「{关键词}」→ {发生什么}',
      '没被提到的剧情不要主动推进。'
    ].join('\n')
  }
];

/** 按模板造条目（跳过书里已经同名的，双击两下不会种出两份） */
function entriesFromTemplate(existing) {
  const taken = new Set((existing || []).map((e) => String(e.title || '').trim()));
  return WB_ENTRY_TEMPLATE.filter((t) => !taken.has(t.title)).map((t, i) => ({
    id: `e${Date.now().toString(36)}${i}${Math.floor(Math.random() * 900 + 100)}`,
    title: t.title,
    keys: [],
    secondaryKeys: [],
    selectiveLogic: WB_NEW_ENTRY_DEFAULTS.selectiveLogic,
    content: t.content,
    order: t.order,
    constant: t.constant,
    matchWholeWords: false,
    caseSensitive: false,
    probability: WB_NEW_ENTRY_DEFAULTS.probability,
    enabled: true
  }));
}

/** 「套用模板」：种入四条骨架并跳到第一条；只动草稿，点「保存」才落盘，所以不用确认框。 */
function applyEntryTemplate() {
  const draft = currentDraft();
  if (!draft) return;

  stashEntryForm();

  const made = entriesFromTemplate(draft.entries);
  if (!made.length) {
    showToast('模板条目都已经有了，没有新增');
    return;
  }

  draft.entries = [...draft.entries, ...made];
  markDraftDirty();

  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  renderEntryList();
  selectEntry(made[0].id);

  showToast(`已种入 ${made.length} 条模板骨架，改完点「保存」才会写进磁盘`);
}

function newEntry() {
  const draft = currentDraft();
  if (!draft) return;

  stashEntryForm();

  const entry = {
    id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`,
    title: '新条目',
    keys: [],
    secondaryKeys: [],
    selectiveLogic: WB_NEW_ENTRY_DEFAULTS.selectiveLogic,
    content: '',
    order: WB_NEW_ENTRY_DEFAULTS.order,
    constant: false,
    matchWholeWords: false,
    caseSensitive: false,
    probability: WB_NEW_ENTRY_DEFAULTS.probability,
    enabled: true
  };

  draft.entries = [...draft.entries, entry];
  markDraftDirty();

  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  renderEntryList();
  selectEntry(entry.id);

  el.wb.e.title.focus();
  el.wb.e.title.select();
}

// 「＋ 事件」：一条一个事件，靠关键词激活。⚠️ 和上面模板里的「事件表」配套不重复 ——
// 那条常驻、给模型一张事件地图；这条 constant=false、是开关，两个都要。
const WB_EVENT_CONTENT = [
  '触发时机：{玩家提到关键词、或者走到这里的时候}',
  '发生什么：{具体演出来什么 —— 写成能直接演的段落，别只写梗概}',
  '牵动谁：{在场的人各自的反应}',
  '',
  '（关键词填在「关键词」那一栏：把玩家可能说到的说法都列上，',
  '  比如「圣诞节, 圣诞, 平安夜」—— 命中任意一个就激活这条）'
].join('\n');

/** 「＋ 事件」：新建一条事件条目并跳过去填。和 newEntry 一样只动草稿 */
function addEventEntry() {
  const draft = currentDraft();
  if (!draft) return;

  stashEntryForm();

  const entry = {
    id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 9000 + 1000)}`,
    title: '事件：',
    keys: [],
    secondaryKeys: [],
    selectiveLogic: WB_NEW_ENTRY_DEFAULTS.selectiveLogic,
    content: WB_EVENT_CONTENT,
    // 888 = 排在主线 / 人物 / 名词（100）之后：事件要被「演出来」，压在设定后面才不被冲淡。
    order: 888,
    // 关键差异：**不常驻** —— 靠关键词激活，不是每轮都塞给模型
    constant: false,
    matchWholeWords: false,
    caseSensitive: false,
    probability: WB_NEW_ENTRY_DEFAULTS.probability,
    enabled: true
  };

  draft.entries = [...draft.entries, entry];
  markDraftDirty();

  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  renderEntryList();
  selectEntry(entry.id);

  // 标题已经填了「事件：」，光标落到末尾接着打名字；不 select，那一整段是要接着写的。
  el.wb.e.title.focus();
  el.wb.e.title.setSelectionRange(entry.title.length, entry.title.length);

  showToast('已新建一条事件条目 —— 别忘了填关键词，改完点「保存」才写进磁盘');
}

/** 从草稿里删掉一条条目（列表 × 与表单「删除条目」共用）；删的只是草稿，返回是否真的删了。 */
function removeEntry(id) {
  const draft = currentDraft();
  if (!draft) return false;
  if (!draft.entries.some((e) => e.id === id)) return false;

  // 表单里正在填的先收进草稿：不 stash 的话紧接着的 renderEntryList / fillEntryForm
  // 会把它正在打的字冲掉。
  stashEntryForm();

  draft.entries = draft.entries.filter((e) => e.id !== id);
  markDraftDirty();

  // 删的是正在编辑的那条 → 落到剩下的第一条（和整条删空时一致）
  if (editingEntryId === id) editingEntryId = draft.entries.length ? draft.entries[0].id : null;

  el.wb.entryCount.textContent = wbEntryCountText(draft.entries);
  renderEntryList();
  fillEntryForm(currentEntry());
  return true;
}

async function deleteEntry() {
  const entry = currentEntry();
  if (!entry) return;

  // 先把表单里的名字收进草稿，确认框里才是刚敲的那个（不是上次回填的）
  stashEntryForm();

  const ok = await confirmDialog({
    title: '删除条目',
    message: `删除条目「${entry.title}」？`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  removeEntry(entry.id);
  showToast('条目已删除，点「保存」才会写进磁盘');
}

/** 删掉一本书（编辑器「删除本书」和列表卡片 × 共用）；返回是否真的删了。 */
export async function deleteWorldbookById(id) {
  const book = worldbookById(id);
  if (!book) return false;
  const wasEditingBook = editingWorldbookId === book.id;

  // 表单里正在填的先收进草稿：确认框弹出时 currentWorldbook() 还指着这本，写进去才有地方落。
  if (wasEditingBook) {
    stashWorldbookName();
    stashEntryForm();
  }

  const charCount = worldbookCharacters(book).length;
  const owner = characters().find((c) => asArray(c.worldbookIds).includes(book.id)) || null;
  const usedByConvo = state.conversations.filter((c) => effectiveWorldbookIds(c).includes(book.id)).length;
  const entryCount = Array.isArray(book.entries) ? book.entries.length : 0;
  const bits = [`${entryCount} 条条目`];
  if (charCount) bits.push(`${charCount} 个角色副本`);
  const ownerText = owner ? `它是「${owner.name}」的世界书，那张卡会变成没有书。` : '';
  const tail = usedByConvo ? `正在用它的 ${usedByConvo} 个会话会失去这本书的设定。` : '';

  const ok = await confirmDialog({
    title: '删除世界书',
    message: `删除「${book.name}」？这本书里的 ${bits.join('、')}会一起删掉。${ownerText}${tail}`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return false;

  // 改之前的样子，写盘失败时按这几样退回去（理由同 characterEditor 的 deleteCharacterById）
  const beforeBooks = worldbooks();
  const beforeChars = characters();
  const unbound = [];

  state.worldbooks = beforeBooks.filter((w) => w.id !== book.id);

  // 卡上指向它的 id 一起摘掉：留着会变成悬空 id —— 卡看着「有书」，点进去打不开
  for (const character of state.characters) {
    const ids = asArray(character.worldbookIds);
    if (ids.includes(book.id)) {
      character.worldbookIds = ids.filter((wid) => wid !== book.id);
      character.updatedAt = now();
      unbound.push([character, ids]);
    }
  }

  // 角色编辑器可能正开在这本书的副本上，退回角色卡
  releaseScope();

  // ⚠️ 编辑器里正显示着这本时必须走 selectWorldbook 真正「切」走：只改 id 再重画，
  //    编辑区还留着刚删那本的字段，紧接着 stash 会把残留书名写进列表第一本（等于改名）。
  if (wasEditingBook) {
    selectWorldbook(worldbooks().length ? worldbooks()[0].id : null);
  }

  renderDirtyHint();

  if (!(await persistLibrary())) {
    // 写盘失败：把内存也退回去，界面和磁盘一致。草稿故意留到最后才删，就是为了这一下。
    state.worldbooks = beforeBooks;
    state.characters = beforeChars;
    for (const [character, ids] of unbound) character.worldbookIds = ids;
    // 只有「刚才正在编辑这本」才重新选中它；删的是另一本时别把编辑器从用户正看的那本切走。
    if (wasEditingBook) selectWorldbook(book.id);
    renderDirtyHint();
    return false;
  }

  // 真的写进磁盘了，草稿才可以丢
  wbDrafts.delete(book.id);

  persistConversations(0);
  showToast('世界书已删除');
  return true;
}

/** 编辑器底部那个「删除本书」：删的就是当前正在编辑的这本 */
async function deleteWorldbook() {
  await deleteWorldbookById(editingWorldbookId);
}

/** 预览这本书会在当前会话里命中哪些条目（用真实请求的扫描逻辑）。
 *  ⚠️ 预览跑在主进程、读的是已落盘的那份，有未保存改动就得先拒绝。 */
async function previewWorldbook() {
  const book = currentWorldbook();
  if (!book) {
    showToast('先选一本书', 'error');
    return;
  }

  const draft = currentDraft();
  if (draft && draft.dirty) {
    showToast('有未保存的改动，先点「保存」再预览命中', 'error');
    return;
  }

  const convo = activeConvo();

  if (!convo) {
    showToast('当前没有会话', 'error');
    return;
  }

  // 扫描口径和真发请求时完全一致（同一个函数）：历史里的 null 占位会被跳过，
  // 否则这里会在 try 之前抛 TypeError，用户只看到一句看不懂的报错。
  const history = worldbookScanHistory(convo);

  if (!history.length) {
    showToast('这个会话还没有消息，先聊两句再看预览', 'error');
    return;
  }

  try {
    const result = await api.previewWorldbook({
      worldbookIds: [book.id],
      scanDepth: WORLDBOOK_SCAN_DEPTH,
      recursiveDepth: recursiveDepthSetting(),
      messages: history.slice(-WORLDBOOK_SCAN_DEPTH).map((m) => ({ role: m.role, content: m.content }))
    });

    if (!result) {
      showToast('预览失败', 'error');
      return;
    }
    const hits = Array.isArray(result.hits) ? result.hits : [];
    if (!hits.length) {
      showToast(`扫了最近 ${result.scanDepth} 条消息，${result.total} 条条目一条都没命中`, 'error');
      return;
    }

    const names = hits.map((h) => h.title).join('、');
    // 递归带进来的单独说一声 —— 不然用户只会觉得「怎么突然多塞了这么多设定」
    const viaChain = Number(result && result.recursiveCount) || 0;
    const tail = viaChain ? `（其中 ${viaChain} 条是递归带进来的）` : '';
    showToast(`「${book.name}」命中 ${hits.length} 条：${names}${tail}`);
  } catch (err) {
    console.error('预览失败', err);
    showToast('预览失败', 'error');
  }
}
