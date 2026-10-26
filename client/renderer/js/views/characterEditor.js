'use strict';

// views/characterEditor.js —— 角色编辑器（角色卡与世界书副本共用一套表单）
// 新建角色只是草稿，保存才落库；属性/表情图草稿归本模块，拆出去的两个模块拿同一份数组引用。

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { h, clear } from '../ui/build.js';
import { showView, currentViewName } from './viewSwitch.js';
import { MAX_PANEL_FIELDS } from '../data/panel.js';
import { MAX_EXPRESSIONS } from '../data/expressions.js';
import {
  characters,
  characterAttrs,
  characterWorldbooks,
  worldbooks,
  worldbookById,
  worldbookCharacters,
  newWorldbookCharId
} from '../data/library.js';
import { persistCharacters, persistConversations, persistLibrary } from '../data/persist.js';
import { currentWorldbook, renderBookCharacters, rerenderBookCharHosts, focusWorldbook, openWorldbookEditor, createWorldbook, deleteWorldbookById } from './worldbook.js';
import { renderCharacterPage } from './characterList.js';
import { draftExpressionsOf } from './charExpressions.js';
import { openAiGenModal } from './aiGen.js';
import { initCharAiFill, resetCharAiFill } from './charAiFill.js';
import { attachAutoGrow, syncAutoGrowAll } from '../ui/auto-grow.js';
import { mTextarea, hostOf } from '../components/index.js';
import { pickAndCrop } from '../ui/imageCrop.js';
import { initCharacterEditorLayout, showCharacterField, setCharSectionCount, setCharSourceChip, refreshCharSectionCounts } from './characterEditorLayout.js';
export { showCharacterField } from './characterEditorLayout.js';

// 长文本框（描述/场景/开场白/示例对话）：自动增高与拖拽记忆在 ui/auto-grow.js；
// 记忆 key 用字段名而不是角色 id —— 换角色也该沿用一个高度。

function longTextAreas() {
  const c = el.c || {};
  return [
    [c.desc, 'desc'],
    [c.scenario, 'scenario'],
    [c.first, 'first'],
    [c.example, 'example']
  ].filter((pair) => pair[0]);
}

/** 页头右侧的保存状态小胶囊：输入即「未保存」，保存成功 / 重新填表归「已保存」 */
function setCharSaveState(state) {
  if (!el.charSaveState) return;
  el.charSaveState.dataset.state = state;
  el.charSaveState.textContent = state === 'dirty' ? '有未保存的改动' : '所有更改已保存';
}

/** 给五个框接上自动增高。接线只需一次（重复调用会被 ignore） */
function wireAutoGrow() {
  for (const [node, key] of longTextAreas()) {
    attachAutoGrow(node, { key: `charform:${key}` });
  }
}

// 长文本字段的字数角标（宿主 id + '-count'）

// ⚙ 组件化后要先用 hostOf 还原成宿主：input 委托递来的是里层原生框，直接查 '-count' 查不到，
// 而「找不到角标就静默跳过」会让角标再也不刷新（不报错、没人发现）。
function charCountNode(textarea) {
  const node = hostOf(textarea);
  return node && node.id ? document.getElementById(`${node.id}-count`) : null;
}

/** 刷新一个框的角标。找不到角标（比如别的页面的 textarea）就静默跳过 */
function updateCharCount(textarea) {
  const badge = charCountNode(textarea);
  if (!badge) return;
  const n = (textarea.value || '').length;
  badge.textContent = `${n.toLocaleString()} 字`;
}

/** 页头右侧的「全文 N 字」：五个写作栏 + 高级设置三栏，和世界书页头同一种读法 */
function updateCharTotalWords() {
  if (!el.charTotalWords) return;
  let total = 0;
  for (const [node] of longTextAreas()) total += String(node.value || '').length;
  for (const id of ['c-system', 'c-post', 'c-notes']) {
    const node = document.getElementById(id);
    if (node) total += String(node.value || '').length;
  }
  el.charTotalWords.textContent = `全文 ${total.toLocaleString()} 字`;
}

/** 刷新全部五个框的角标 + 左栏徽章 + 右栏字段目录（fillCharForm 回填之后用） */
function syncAllCharCounts() {
  for (const [node] of longTextAreas()) updateCharCount(node);
  updateCharTotalWords();
  // 徽章与目录上的字数/已写圆点都从 DOM 现算，回填之后必须补一次
  refreshCharSectionCounts();
}

// 编辑器的状态

let editingCharacterId = null; // 角色卡里当前正在编辑的角色
// 作用域：'library' 角色卡；'worldbook' 当前世界书里的副本（不动角色卡）
let charEditorScope = 'library';
// 正在编辑的角色头像（dataURL，正方形），用在消息气泡和状态卡上
let charDraftAvatar = '';
// 形象（dataURL，2:3 竖版）三态，保存时必须照原样区分：
// undefined = 没设过（界面用头像顶上，别写这个键，省几 MB）；'' = 明确清掉；dataURL = 有独立形象。
let charDraftPortrait;
// 表情图草稿（深拷贝），保存角色时才写回卡上
let charExpressions = [];
// 备选开场白草稿（导入卡常带，单卡见过 29 条）；行是动态铺的，见 renderAltGreetings
let charAltGreetings = [];
// 与主进程 main/characters.js 的 MAX_ALTERNATE_GREETINGS 对齐，否则 UI 能加、保存时被悄悄砍掉
const MAX_ALT_GREETINGS = 50;
// 「新建角色」的草稿：先只活在编辑器里，不进列表、不写磁盘
let charDraft = null; // { character, scope, bookId }
// 🔴 一张卡只允许一本自带世界书（主进程 normalize 也只留一本，两边一起卡住才不会「界面能绑、重启变一本」）
const MAX_CHAR_WORLDBOOKS = 1;
// 属性草稿，保存角色时才写回
let charAttrs = [];

// 入口层注入的动作
let actions = { rerender: () => {} };

/** 当前作用域下的角色列表（角色卡或世界书副本）；编辑器所有读写都走它 */
function editorCharacterList() {
  if (charEditorScope === 'worldbook') return worldbookCharacters(currentWorldbook());
  return characters();
}

function editorCharacterById(id) {
  if (!id) return null;
  // 新建的草稿还没进任何列表，但编辑表单照样得能读写它
  if (charDraft && charDraft.character.id === id) return charDraft.character;
  return editorCharacterList().find((c) => c.id === id) || null;
}

/** 编辑器里现在放着的是一个还没保存的新角色吗？ */
function isCharDraft() {
  return !!charDraft && editingCharacterId === charDraft.character.id;
}

// 打开 / 离开

/** 进来之前停在哪一屏，离开时回到它 */
let editorReturnView = 'chars';

function openCharsModal() {
  // 谁打开它谁先设好 editingCharacterId / charEditorScope；
  // 若编辑器已指向别的角色，说明「新建」草稿被放弃了，顺手清掉。
  if (charDraft && editingCharacterId !== charDraft.character.id) discardCharDraft();

  // 长文本框的接线在 fillCharForm() 里（新建和编辑两条路都经过那儿）

  let current = editorCharacterById(editingCharacterId);

  if (!current) {
    // 兜底：没指定就退回作用域里的第一个（世界书副本也走这里）
    const list = editorCharacterList();
    editingCharacterId = list.length ? list[0].id : null;
    current = editorCharacterById(editingCharacterId);
  }

  // 记下来处；已经在编辑页里就别覆盖，否则「返回」会原地打转
  const from = currentViewName();
  if (from !== 'charEditor') editorReturnView = from;

  // 先让这一屏可见再填表：fillCharForm 会量文本框高度，display:none 下量什么都是 0
  showView('charEditor');

  if (current) {
    fillCharForm(current);
  } else {
    showCharForm(false);
  }

  updateCharEditorScopeUi();
}

/** 弹窗标题跟着作用域变，免得改半天不知道改的是哪一份 */
function updateCharEditorScopeUi() {
  const inBook = charEditorScope === 'worldbook';
  const book = inBook ? currentWorldbook() : null;
  const creating = isCharDraft();

  if (el.charsTitle) {
    if (creating) el.charsTitle.textContent = inBook ? '新建本书角色' : '新建角色卡';
    else el.charsTitle.textContent = inBook ? '编辑本书角色' : '角色卡编辑';
  }
  if (el.charsSub) {
    if (creating) {
      // 说清楚「现在还没这个东西」，免得用户以为点一下就已经建好了
      el.charsSub.textContent = inBook
        ? `填好内容点「保存」才会加进这本书${book ? ` · ${book.name}` : ''}`
        : '填好内容点「保存」，保存后才会出现在角色卡里';
    } else {
      // 保存状态胶囊（.save-pill）已提示未保存，这里说明这几栏写下去会去哪儿
      el.charsSub.textContent = inBook
        ? `这本书里的独立副本，改它不影响角色卡${book ? ` · ${book.name}` : ''}`
        : '描述每轮都会注入给 AI，改完点左栏底部的「保存」';
    }
  }
}

/**
 * 离开编辑器回到来处；页头「返回」、Esc、保存完自动走、删除后都走它。
 * force：调用方已经确认过（比如删除成功后），不再问「要不要放弃改动」。
 */
export async function leaveCharacterEditor({ force = false } = {}) {
  // 新建的角色还没保存：离开就等于放弃，先问一句，免得辛苦填的设定白写
  if (isCharDraft()) {
    const typed = el.c.name.value.trim();
    const ok = await confirmDialog({
      title: '放弃新建',
      message: `「${typed || '新角色'}」还没保存，关掉就不会创建这个角色。`,
      confirmText: '放弃',
      danger: true
    });
    if (!ok) return;
  } else if (!force && el.charSaveState && el.charSaveState.dataset.state === 'dirty') {
    // 改已有角色：没保存就返回，改动静默丢掉过一次 —— 和新建草稿一样先问一句
    const name = (el.c.name.value || '').trim() || '这个角色';
    const ok = await confirmDialog({
      title: '放弃未保存的改动',
      message: `「${name}」还有没保存的改动，返回后会丢掉。`,
      confirmText: '放弃',
      danger: true
    });
    if (!ok) return;
  }

  // 「AI 补充」还在等模型的话，走了就作废 —— 否则回来时表单会被上一张卡的内容糊上
  resetCharAiFill();
  discardCharDraft();
  // 回到来处；来处是聊天就回聊天（那种情况只可能从别处被程序调起来）
  showView(editorReturnView === 'charEditor' ? 'chars' : editorReturnView);
}

/** 左栏来源胶囊的短文案 */
function charSourceChipText(character) {
  if (isCharDraft()) return '还没保存的新角色';
  if (charEditorScope === 'worldbook') return '本书角色副本';
  if (character.source === 'png') return '酒馆 PNG 卡';
  if (character.source === 'json') return 'JSON 角色卡';
  return '手写角色';
}

/** 有角色时显示右边的编辑表单，没有就显示空状态 */
function showCharForm(show) {
  el.charForm.classList.toggle('hidden', !show);
  el.charEmpty.classList.toggle('hidden', !!show);
  // 新建的新角色还没保存，没有可删的东西
  el.btnDelChar.disabled = !show || isCharDraft();
  el.btnSaveChar.disabled = !show;
  if (el.charSaveState) el.charSaveState.hidden = !show;
}

// 头像（1:1，消息气泡/状态卡）与形象（2:3 竖版，角色卡列表）；上传都走 ui/imageCrop.js，
// 裁剪组件按目标尺寸输出，这里不再二次缩放。

// 形象输出 1024×1536（2:3），列表只显示 ~180px 宽，但点开看大图会铺满窗口。
// ⚠️ 改比例要三处一起改：这里、.char-card-avatar、.char-portrait 的 CSS。
const PORTRAIT_WIDTH = 1024;
const PORTRAIT_RATIO = 2 / 3;

/** 形象当前该显示哪张图：自己设过就用自己那张，没设过就先拿头像顶上（老卡） */
function draftPortraitImage() {
  return charDraftPortrait === undefined ? charDraftAvatar : charDraftPortrait;
}

/** 把一个上传框画成「有图 / 空」两态 */
function renderMediaBox(box, dataUrl, emptyText) {
  box.innerHTML = '';
  if (dataUrl) {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    box.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.className = 'char-avatar-empty';
    span.textContent = emptyText;
    box.appendChild(span);
  }
}

function renderCharMedia() {
  // 封面一张顶掉原来的「形象 / 头像」；头像仍由导入等路径写，本页不再编辑。
  renderMediaBox(el.charPortrait, draftPortraitImage(), '点击上传');
  if (el.btnClearPortrait) el.btnClearPortrait.classList.toggle('hidden', !draftPortraitImage());
  // 封面还是「沿用头像」时压淡，提示它不是单独设的
  if (el.charPortrait) el.charPortrait.classList.toggle('is-inherited', charDraftPortrait === undefined && !!charDraftAvatar);
}

async function pickPortrait() {
  if (!editorCharacterById(editingCharacterId)) return;

  const cropped = await pickAndCrop({
    aspect: PORTRAIT_RATIO,
    outWidth: PORTRAIT_WIDTH,
    title: '裁剪角色形象',
    hint: '竖版立绘，显示在角色卡列表上',
    pickTitle: '选一张角色形象'
  });
  if (!cropped) return;

  charDraftPortrait = cropped;
  renderCharMedia();
  showToast('形象已更换，记得点「保存」', 'ok');
}

function clearPortrait() {
  if (!draftPortraitImage()) return;
  // 必须写空串（不是退回 undefined）：用户点了清除就是不要形象，不能又拿头像顶上
  charDraftPortrait = '';
  renderCharMedia();
  showToast('形象已清除，记得点「保存」');
}

// 表单：填进去 / 收回来

function fillCharForm(character) {
  if (!character) {
    showCharForm(false);
    return;
  }

  // 进编辑器先清草稿残留：portrait 的 undefined 三态不清，会把上一张卡带进来
  charDraftAvatar = character.avatar || '';
  charDraftPortrait = typeof character.portrait === 'string' ? character.portrait : undefined;
  charExpressions = draftExpressionsOf(character);

  el.c.name.value = character.name || '';
  el.c.tags.value = (Array.isArray(character.tags) ? character.tags : []).join(', ');
  el.c.desc.value = character.description || '';
  el.c.scenario.value = character.scenario || '';
  el.c.first.value = character.firstMes || '';
  // 备选开场白：先深拷贝成草稿，再按草稿把行铺出来（条数不定，不能写死 HTML）
  charAltGreetings = draftAltGreetingsOf(character);
  renderAltGreetings();
  el.c.example.value = character.mesExample || '';
  el.c.system.value = character.systemPrompt || '';
  el.c.post.value = character.postHistoryInstructions || '';
  el.c.notes.value = character.creatorNotes || '';

  // 年龄/性别/种族不在这张表单里，归入描述文字；这里不回填这三个输入框。

  // 长文本：值由程序塞入不走 input，故显式重算高度。
  // ⚠️ 接线必须在这里（startCharDraft 不经过 openCharsModal），但不能此刻量：调用方还没摘 .hidden，display:none 下 scrollHeight 恒为 0。
  wireAutoGrow();

  renderCharMedia();

  // 上一张卡的「AI 补充」请求要作废，别让它把内容写进新卡的表单
  resetCharAiFill();

  // 角色自带的世界书：清单 + 新建
  renderCharWorldbookBox(character);

  // 属性 / 表情 / 头像本页不再编辑，保持角色对象原样（聊天、面板、导出仍会读）。
  charAttrs = characterAttrs(character);

  // 左栏来源胶囊 + 页头保存状态（刚填好的表 = 已保存）
  setCharSourceChip(charSourceChipText(character));
  setCharSaveState('saved');

  showCharForm(true);

  // 到这儿弹窗才可见，量高度才准（隐藏状态下量会永远得到 84px）
  syncAutoGrowAll(longTextAreas().map((pair) => pair[0]).concat(altGreetTextAreas()));
  syncAllCharCounts();
}

/**
 * 「AI 补充」的结果填进表单（见 views/charAiFill.js）。
 * · 只覆盖 AI 真给了内容的那几栏：模型偶尔漏一栏，别拿空串把手写的抹掉；
 * · 每填一栏派一个 input —— 和用户手打一个字走的是同一条路，角标 / 自动增高 /
 *   「有未保存的改动」胶囊会一起刷新（直接赋值不触发 input，那三样会停在旧值）；
 * · 名字 / 标签 / 属性 / 备注一律不碰：这份任务只改这四栏。
 * @returns {number} 真正填了几栏（0 = 一栏都没填，调用方要报错）
 */
function applyAiFill(fields) {
  const map = [
    ['description', el.c.desc],
    ['scenario', el.c.scenario],
    ['firstMes', el.c.first],
    ['mesExample', el.c.example]
  ];

  let written = 0;
  for (const [key, node] of map) {
    const value = fields && typeof fields[key] === 'string' ? fields[key].trim() : '';
    if (!value || !node) continue;
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    written += 1;
  }
  return written;
}

// 角色自带的世界书

/** 当前编辑角色卡绑定的那一本世界书（只能一本）；没绑返回 null。 */
function boundWorldbookOf(character) {
  const ids = character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [];
  return ids.map((id) => worldbookById(id)).filter(Boolean)[0] || null;
}

/** 绑定「人物列表」分区头部三颗按钮（识别世界书人物 / AI 生成 / ＋ 新建）。只绑一次，点的时候现取绑定书。 */
function bindCharRolesBar() {
  const btnScan = document.getElementById('btn-char-roles-scan');
  const btnAi = document.getElementById('btn-char-roles-ai');
  const btnNew = document.getElementById('btn-char-roles-new');
  if (!btnAi || !btnNew) return;

  const bound = () => boundWorldbookOf(editorCharacterById(editingCharacterId));

  if (btnScan) {
    btnScan.addEventListener('click', () => {
      const book = bound();
      if (!book) {
        showToast('这张卡还没有世界书 —— 先在「世界书」分区新建一本', 'error');
        return;
      }
      // 识别清单 / 转换都在 worldbookPerson.js，这里只负责把书递过去
      if (typeof actions.scanPersons === 'function') actions.scanPersons(book);
    });
  }

  btnAi.addEventListener('click', () => {
    const book = bound();
    if (!book) {
      showToast('这张卡还没有世界书 —— 先在「世界书」分区新建一本', 'error');
      return;
    }
    // 生成的是这本书里的 NPC 副本，结果同样落到「本书角色编辑」草稿里
    openAiGenModal({ scope: 'worldbook', bookId: book.id });
  });

  btnNew.addEventListener('click', () => {
    const book = bound();
    if (!book) {
      showToast('这张卡还没有世界书 —— 先在「世界书」分区新建一本', 'error');
      return;
    }
    // 先切到这本书，再走「本书角色」的草稿（新建副本落进这本书）
    if (!focusWorldbook(book.id)) return;
    if (typeof actions.draftInBoundBook === 'function') actions.draftInBoundBook();
  });
}

function renderCharWorldbookBox(character) {
  if (!character) return;

  const ids = character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [];
  const books = ids.map((id) => worldbookById(id)).filter(Boolean);
  setCharSectionCount('worldbook', String(books.length));

  // 「人物列表」分区：这张卡自带的那本书里的人物副本。
  const bound = books[0] || null;
  const rolesHost = document.getElementById('char-book-roles');
  if (bound) {
    renderBookCharacters(bound, rolesHost);
  } else if (rolesHost) {
    // 没书：给一条引导空态，比留一片白清楚
    rolesHost.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'wb-char-empty';
    empty.innerHTML =
      '<h3>这张卡还没有世界书</h3>' +
      '<p>人物列表来自角色自带世界书里的「本书角色」副本。先在「世界书」分区新建一本，再回来看。</p>';
    rolesHost.appendChild(empty);
  }
  const copies = bound && Array.isArray(bound.characters) ? bound.characters : [];
  setCharSectionCount('roles', bound ? String(copies.length) : '');

  // 「人物列表」头三颗按钮：没书就灰掉，提示先建一本
  const btnScan = document.getElementById('btn-char-roles-scan');
  const btnAi = document.getElementById('btn-char-roles-ai');
  const btnNew = document.getElementById('btn-char-roles-new');
  for (const btn of [btnScan, btnAi, btnNew]) {
    if (!btn) continue;
    btn.disabled = !bound;
    btn.title = bound ? '' : '先在「世界书」分区新建一本世界书';
  }

  // 🔴 只能一本：已经有书就把「＋ 新建」灰掉，否则用户点了才被告知不行
  const full = books.length >= MAX_CHAR_WORLDBOOKS;
  if (el.c.wbNewBtn) {
    el.c.wbNewBtn.disabled = full;
    el.c.wbNewBtn.title = full
      ? '自带世界书只能有一本 —— 先删掉现在这本，再新建'
      : '新建一本世界书，只给这个角色用';
  }

  // --- 已绑的清单 ---
  el.c.wbList.innerHTML = '';

  if (!books.length) {
    const empty = document.createElement('p');
    empty.className = 'field-help cwb-empty';
    empty.textContent =
      '这张卡还没有世界书 —— 点「＋ 新建」写一本。它只服务这张卡，不会和别的卡共用。';
    el.c.wbList.appendChild(empty);
  } else {
    for (const book of books) {
      const row = document.createElement('div');
      row.className = 'cwb-row';

      const name = document.createElement('span');
      name.className = 'cwb-row-name';
      name.textContent = book.name;
      name.title = book.name;

      const count = document.createElement('span');
      count.className = 'cwb-row-count';
      const n = Array.isArray(book.entries) ? book.entries.length : 0;
      count.textContent = `${n} 条`;

      // 「编辑」：不离开角色编辑器，只是切到那本书的编辑器逛一圈；返回时还回这张卡。
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'cwb-row-edit';
      edit.title = '打开这本书的编辑器（改完返回还会回到这张卡）';
      edit.setAttribute('aria-label', `编辑世界书 ${book.name}`);
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openBoundWorldbook(book.id));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cwb-row-del';
      del.title = '删除这本书（条目和角色副本会一起删掉）';
      del.setAttribute('aria-label', `删除世界书 ${book.name}`);
      del.textContent = '✕';
      del.addEventListener('click', () => deleteWorldbookFromCharacter(book.id));

      row.append(name, count, edit, del);
      el.c.wbList.appendChild(row);
    }
  }

  if (!books.length) {
    el.c.wbDesc.textContent = '';
    el.c.wbHint.textContent =
      '没有世界书也能聊：开局只有这张卡的设定和开场白。新建的这本只跟这张卡走，不会出现在别的卡上。';
    return;
  }

  const names = books.map((b) => b.name).join('、');
  const total = books.reduce((sum, b) => sum + (Array.isArray(b.entries) ? b.entries.length : 0), 0);
  el.c.wbDesc.textContent = `《${names}》· ${total} 条`;

  el.c.wbHint.textContent =
    '和这张卡开局就会进这本书的世界：条目不全部塞进去，聊到关键词才注入。';
}

/**
 * 行上的「编辑」：跳去那本书的**详情**（世界书编辑器）。
 *
 * ⚠️ 不走 leaveCharacterEditor —— 那条路会弹「放弃未保存的改动」并把编辑态收掉。
 * 这里只是切屏：角色编辑器这一屏的 DOM 原样留着，世界书编辑器点「返回」就回到
 * 这张卡（`openWorldbookEditor` 会把来处记成 charEditor）。
 * 但填在输入框里、还没进草稿的那点内容先收一份 —— 切屏期间只要别处触发一次重绘，
 * 没收过的输入就白填了（和「导入前先 stash」同一手）。
 */
function openBoundWorldbook(bookId) {
  if (!worldbookById(bookId)) return;
  stashCharForm();
  openWorldbookEditor(bookId);
}

/** 「＋ 新建」：造一本书 → 挂给这张卡 → 直接进编辑器写内容。
 *  ⚠️ 书先落盘再挂，否则角色上的 id 会指向一本盘上没有的书（见 createWorldbook）。
 *  ⚠️ 只能一本：已经有书时**不建**（否则库里会多出一本没人认领的孤儿）。 */
async function createWorldbookForCharacter() {
  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  const beforeIds = Array.isArray(character.worldbookIds) ? [...character.worldbookIds] : [];
  if (beforeIds.length) {
    showToast('自带世界书只能有一本 —— 先删掉现在这本，再新建', 'error');
    return;
  }

  const book = await createWorldbook();
  if (!book) return;

  const hadIds = Array.isArray(character.worldbookIds);
  const beforeUpdatedAt = character.updatedAt;

  character.worldbookIds = [book.id];
  character.updatedAt = now();
  renderCharWorldbookBox(character);

  // 还没保存过的新卡：内存里挂着就行，保存角色时跟着一起落盘
  if (!isCharDraft() && !(await persistLibrary())) {
    if (hadIds) character.worldbookIds = beforeIds;
    else delete character.worldbookIds;
    character.updatedAt = beforeUpdatedAt;
    renderCharWorldbookBox(character);
    showToast('世界书没挂上这张卡，回去再新建一次', 'error');
    return;
  }

  openBoundWorldbook(book.id);
}

/** 世界书编辑器逛一圈回来时用：把那块「已绑世界书」按**最新**数据重画。
 *  书名 / 条目数可能刚在那边改过，不重画就还是旧的那行。 */
export function refreshCharWorldbookBox() {
  const character = editorCharacterById(editingCharacterId);
  if (character) renderCharWorldbookBox(character);
}

/** 书行上的 ✕：真的把这本书删掉 —— 书和卡是一体的，没有「留着但不生效」这种中间态。
 *  ⚠️ 确认框和「从卡上摘掉 id」都在 deleteWorldbookById 里，这里只管草稿卡和重画。 */
async function deleteWorldbookFromCharacter(bookId) {
  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  const draftCard = isCharDraft();
  const beforeIds = Array.isArray(character.worldbookIds) ? [...character.worldbookIds] : [];

  // 草稿卡还没进 state.characters —— deleteWorldbookById 摘不到它的 id，这里先摘。
  // 删书失败要放回去，否则界面上书还在、卡却已经"没有书"。
  if (draftCard) character.worldbookIds = beforeIds.filter((id) => id !== bookId);

  const deleted = await deleteWorldbookById(bookId);

  if (!deleted) {
    if (draftCard) character.worldbookIds = beforeIds;
    return;
  }

  renderCharWorldbookBox(character);
}

// 草稿 / 保存 / 删除

/** 把表单内容写回内存里的角色对象（切走或保存前调用） */
function stashCharForm() {
  const character = editorCharacterById(editingCharacterId);
  if (!character || el.charForm.classList.contains('hidden')) return;

  character.name = el.c.name.value.trim() || '未命名角色';
  character.tags = el.c.tags.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
  character.description = el.c.desc.value;
  character.scenario = el.c.scenario.value;
  character.firstMes = el.c.first.value;
  // 空行丢掉、去重、限条数，口径与主进程 normalizeAlternateGreetings 一致
  const altGreetings = charAltGreetings
    .map((s) => String(s == null ? '' : s).trim())
    .filter((s, i, arr) => s && arr.indexOf(s) === i)
    .slice(0, MAX_ALT_GREETINGS);
  if (altGreetings.length) character.alternateGreetings = altGreetings;
  else delete character.alternateGreetings;
  character.mesExample = el.c.example.value;
  character.systemPrompt = el.c.system.value;
  character.postHistoryInstructions = el.c.post.value;
  character.creatorNotes = el.c.notes.value;
  // 年龄/性别/种族不从输入框写回，老卡的字段保留（messages.js / cast.js 仍会读）。
  // 只摘掉界面临时状态（_moreOpen），其余字段原样带走。
  character.attributes = charAttrs
    .filter((a) => a && typeof a.name === 'string' && a.name.trim())
    .map((a) => {
      const out = { ...a, name: a.name.trim().slice(0, 24), value: String(a.value == null ? '' : a.value).slice(0, 500) };
      delete out._moreOpen;
      return out;
    })
    .slice(0, MAX_PANEL_FIELDS);
  character.avatar = charDraftAvatar;
  // 形象三态：undefined 就别写这个键（否则白存一份图）；空串 / dataURL 照写。
  if (charDraftPortrait === undefined) delete character.portrait;
  else character.portrait = charDraftPortrait;
  // 表情图：没名字的条目丢掉；一条不剩就不留这个键（空表只是噪音），key / default 只写有值的。
  const expressions = charExpressions
    .filter((item) => item && String(item.name || '').trim())
    .map((item) => ({
      name: String(item.name).trim().slice(0, 24),
      keywords: (Array.isArray(item.keywords) ? item.keywords : [])
        .map((k) => String(k).trim().slice(0, 24))
        .filter(Boolean),
      ...(String(item.key || '').trim() ? { key: String(item.key).trim().toLowerCase() } : {}),
      ...(item.default === true ? { default: true } : {}),
      image: typeof item.image === 'string' && item.image.startsWith('data:image/') ? item.image : ''
    }))
    .slice(0, MAX_EXPRESSIONS);
  if (expressions.length) character.expressions = expressions;
  else delete character.expressions;
  // showInPanel 只对世界书副本写；角色卡写了也没用（单角色会话永远显示状态，见 cast.js）
  if (charEditorScope === 'worldbook' && el.c.showInPanel) {
    character.showInPanel = el.c.showInPanel.checked === true;
  } else {
    delete character.showInPanel;
  }
  character.updatedAt = now();
}

/** 角色列表页的「＋ 新建角色」：作用域钉死在角色卡（上次可能停在世界书） */
function newCharacter() {
  charEditorScope = 'library';
  startCharDraft();
}

// 新建角色：只做草稿塞进编辑器；保存前不进列表、不写磁盘，关掉就当没建过。
// preset 是 AI 生成的字段，填进来后与手填草稿没有区别，一样要点「保存角色」。
function startCharDraft(preset) {
  // 先把上一个角色的改动收进内存，再丢掉没保存完的草稿（否则留下永不创建的幽灵角色）
  stashCharForm();
  discardCharDraft();

  const scope = charEditorScope;
  const book = scope === 'worldbook' ? currentWorldbook() : null;
  if (scope === 'worldbook' && !book) return;

  const p = preset && typeof preset === 'object' ? preset : {};

  const character = {
    id: scope === 'worldbook' ? newWorldbookCharId() : uid(),
    name: p.name || '新角色',
    avatar: '',
    description: p.description || '',
    personality: p.personality || '',
    // AI 生成时连场景 / 开场白 / 示例对话一起带进来；手建角色这三项仍是空的
    scenario: p.scenario || '',
    firstMes: p.firstMes || '',
    mesExample: p.mesExample || '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    tags: Array.isArray(p.tags) ? p.tags : [],
    attributes: Array.isArray(p.attributes) ? p.attributes : [],
    // 年龄/性别/种族不作为字段，写进描述文字
    source: 'manual',
    createdAt: now(),
    updatedAt: now()
  };

  charDraft = { character, scope, bookId: book ? book.id : null };
  editingCharacterId = character.id;

  // 记来处（这条路上「保存角色」是终点，走的时候会回到它）
  const from = currentViewName();
  if (from !== 'charEditor') editorReturnView = from;

  // 先让这一屏可见再填表：隐藏状态下量高度都是 0
  showView('charEditor');
  fillCharForm(character);
  updateCharEditorScopeUi();

  showCharacterField('c-desc');
  el.c.name.focus();
  el.c.name.select();
}

/** 把新建的草稿真正写进角色卡/世界书；只有点「保存角色」会走到这里 */
function commitCharDraft() {
  if (!charDraft) return true;

  const { character, scope, bookId } = charDraft;

  if (scope === 'worldbook') {
    const book = worldbookById(bookId);
    // 书在编辑期间被删掉了，这个草稿就没有落脚的地方
    if (!book) return false;
    book.characters = worldbookCharacters(book);
    book.characters.push(character);
    book.updatedAt = now();
  } else {
    state.characters = [...characters(), character];
  }

  charDraft = null;
  return true;
}

/** 丢掉没保存的草稿：它从来没进过任何列表，忘掉就行 */
function discardCharDraft() {
  if (!charDraft) return;
  if (editingCharacterId === charDraft.character.id) editingCharacterId = null;
  charDraft = null;
}

async function saveCharacter() {
  if (!editingCharacterId) return;

  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  // 必须先校验再落内存：stashCharForm 会把空名字写成「未命名角色」
  if (!el.c.name.value.trim()) {
    showToast('给角色起个名字吧', 'error');
    el.c.name.focus();
    return;
  }

  // 「新建」还是「改已有」要在落盘前记下来：草稿一提交 charDraft 就清空
  const creating = isCharDraft();
  const scope = creating ? charDraft.scope : charEditorScope;

  stashCharForm();

  // 新建的角色到这一刻才真正被创建（进角色卡 / 进这本书）
  if (creating && !commitCharDraft()) {
    showToast('这本书已经不在了，角色没能创建', 'error');
    return;
  }

  // 新建是终点（直接离开）；改已有的留在本页，多半还要接着改
  if (creating) {
    renderCharacterPage();
    actions.rerender();
    // 改的是书里的副本，角色卡编辑页的人物列表也要跟着刷新
    if (scope === 'worldbook') rerenderBookCharHosts(currentWorldbook());
    // 写盘失败别报「已创建」：persistCharacters 已弹过提示，页面留着可直接重试
    if (!(await persistCharacters())) return;
    setCharSaveState('saved');
    showToast(`角色「${character.name}」已创建`, 'ok');
    await leaveCharacterEditor({ force: true });
    return;
  }

  // 名字可能被规整过，重新填一遍保证界面和数据一致
  renderCharacterPage();
  fillCharForm(character);
  updateCharEditorScopeUi();
  actions.rerender();

  // 改的是书里的副本，角色卡编辑页的人物列表也要跟着刷新
  if (scope === 'worldbook') rerenderBookCharHosts(currentWorldbook());

  // 失败提示由 persistCharacters 弹；成功才报「已保存」，否则后一条会盖掉前一条
  if (await persistCharacters()) {
    setCharSaveState('saved');
    showToast(`角色「${character.name}」已保存`, 'ok');
  }
}

// 删除角色（'library' 从角色卡删 / 'worldbook' 只移除本书副本），两个入口共用。
// ⚠️ 写盘失败必须把内存也退回去 —— EPERM 时若界面已移除还报「已删除」，重启就回来了。
export async function deleteCharacterById(id, scope) {
  const inBook = scope === 'worldbook';

  const character = inBook
    ? worldbookCharacters(currentWorldbook()).find((c) => c.id === id)
    : characters().find((c) => c.id === id);
  if (!character) return;

  // 书是卡的一部分：删卡就得连它自带的世界书一起删，否则留下一本谁也打不开的孤儿书
  // （世界书列表页已经撤了，界面上再没有别的地方能删它）。
  // ⚠️ 别的卡还指着同一本就别删 —— 老数据里一本书挂过多张卡（新界面造不出这种），
  //    删这张卡不该把另一张的书也带走。
  const ownBooks = inBook ? [] : characterWorldbooks(character).filter((book) => !characters().some(
    (other) => other.id !== character.id && (other.worldbookIds || []).includes(book.id)
  ));
  const entryTotal = ownBooks.reduce((n, book) => n + (Array.isArray(book.entries) ? book.entries.length : 0), 0);
  const bookText = ownBooks.length
    ? `它自带的世界书「${ownBooks.map((book) => book.name).join('、')}」（${entryTotal} 条条目）也会一起删掉。`
    : '';

  const ok = await confirmDialog({
    title: inBook ? '移除角色' : '删除角色',
    message: inBook
      ? `把「${character.name}」从这本书里移除？角色卡里的那个角色不受影响。`
      : `删除角色「${character.name}」？用到它的会话会变回通用助手。${bookText}`,
    confirmText: inBook ? '移除' : '删除',
    danger: true
  });
  if (!ok) return;

  if (inBook) {
    const book = currentWorldbook();
    if (book) {
      const beforeChars = worldbookCharacters(book);
      const beforeBookUpdatedAt = book.updatedAt;
      book.characters = beforeChars.filter((c) => c.id !== character.id);
      book.updatedAt = now();

      // 书里的副本不受会话影响，只需要刷新角色卡编辑页那边的人物列表
      rerenderBookCharHosts(book);

      if (!(await persistCharacters())) {
        // 写盘失败 → 把副本放回去，界面跟磁盘保持一致
        book.characters = beforeChars;
        book.updatedAt = beforeBookUpdatedAt;
        rerenderBookCharHosts(book);
        return;
      }
      showToast(`已移除「${character.name}」`);
      return;
    }
  }

  // --- 从角色卡删 ---
  // 记住改之前的样子，写盘失败时退回去
  const beforeChars = characters();
  const beforeBooks = worldbooks();
  const bookIds = new Set(ownBooks.map((book) => book.id));
  const unbound = [];

  state.characters = beforeChars.filter((c) => c.id !== character.id);
  if (bookIds.size) state.worldbooks = beforeBooks.filter((w) => !bookIds.has(w.id));

  // 把绑定了这个角色的会话解绑，免得留下一个指向空气的 id
  for (const convo of state.conversations) {
    if (convo.characterId === character.id) {
      convo.characterId = null;
      unbound.push(convo);
    }
  }

  actions.rerender();

  if (!(await persistLibrary())) {
    state.characters = beforeChars;
    state.worldbooks = beforeBooks;
    for (const convo of unbound) convo.characterId = character.id;
    actions.rerender();
    return;
  }

  // 编辑器正开在这个角色上就离开它；放在写盘成功之后（失败时角色还在，不该关编辑器）
  if (editingCharacterId === character.id) {
    editingCharacterId = null;
    if (currentViewName() === 'charEditor') await leaveCharacterEditor({ force: true });
  }

  persistConversations(0);
  showToast(`已删除「${character.name}」`);
}

/** 编辑弹窗底部的「删除角色」：删的就是编辑器里正在编辑的这个 */
async function deleteCharacter() {
  // 还没保存的新角色没有任何东西可删（按钮也是禁用的，这里只是兜底）
  if (isCharDraft()) return;

  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  await deleteCharacterById(character.id, charEditorScope);
}

/**
 * 批量删除角色卡：确认框只弹一次、写盘也只写一次 —— 删一半留一半再回滚比删不掉更糟。
 */
export async function deleteCharactersByIds(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const targets = characters().filter((character) => wanted.has(character.id));
  if (!targets.length) return false;

  const usedByConvo = state.conversations.filter((convo) => wanted.has(convo.characterId)).length;
  const names = targets.slice(0, 3).map((character) => `「${character.name}」`).join('、');
  const more = targets.length > 3 ? ` 等 ${targets.length} 个角色` : '';
  const tail = usedByConvo ? `用到它们的 ${usedByConvo} 个会话会变回通用助手。` : '';
  // 书跟着卡一起走（同单个删除）；别的卡还指着的书留着不动
  const ownBooks = targets
    .flatMap((character) => characterWorldbooks(character))
    .filter((book) => !characters().some(
      (other) => !wanted.has(other.id) && (other.worldbookIds || []).includes(book.id)
    ));
  const bookText = ownBooks.length
    ? `它们自带的 ${ownBooks.length} 本世界书（「${ownBooks.slice(0, 2).map((b) => b.name).join('、')}」${ownBooks.length > 2 ? ' 等' : ''}）会一起删掉。`
    : '';

  const ok = await confirmDialog({
    title: '批量删除角色',
    message: `删除 ${names}${more}？${tail}${bookText}`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return false;

  const beforeChars = characters();
  const beforeBooks = worldbooks();
  const bookIds = new Set(ownBooks.map((book) => book.id));
  const unbound = [];

  state.characters = beforeChars.filter((character) => !wanted.has(character.id));
  if (bookIds.size) state.worldbooks = beforeBooks.filter((w) => !bookIds.has(w.id));

  for (const convo of state.conversations) {
    if (wanted.has(convo.characterId)) {
      // 记下原来绑的是哪一张，写盘失败时按它退回去
      unbound.push([convo, convo.characterId]);
      convo.characterId = null;
    }
  }

  actions.rerender();

  if (!(await persistLibrary())) {
    // 写盘失败 → 内存也退回去：卡还在列表里、书也还在、会话绑定也恢复，界面和磁盘一致
    state.characters = beforeChars;
    state.worldbooks = beforeBooks;
    for (const [convo, id0] of unbound) convo.characterId = id0;
    actions.rerender();
    return false;
  }

  // 编辑器正开在被删的某一张上：没有可编辑的对象了，离开它
  if (editingCharacterId && wanted.has(editingCharacterId)) {
    editingCharacterId = null;
    if (currentViewName() === 'charEditor') await leaveCharacterEditor({ force: true });
  }

  persistConversations(0);
  showToast(`已删除 ${targets.length} 个角色`);
  return true;
}

// 给入口层 / 别的视图用的口子

/** 打开编辑器，编辑指定角色（scope 省略 = 角色卡） */
export function openCharacterEditor(id, scope = 'library') {
  const nextScope = scope === 'worldbook' ? 'worldbook' : 'library';
  const different = charEditorScope !== nextScope || editingCharacterId !== (id || null);
  charEditorScope = nextScope;
  editingCharacterId = id || null;
  openCharsModal();
  if (different) showCharacterField('c-desc');
}

/** 在当前世界书作用域下起草一个新角色（世界书编辑器里的「新建本书角色」） */
export function startCharacterDraftInBook() {
  charEditorScope = 'worldbook';
  startCharDraft();
}

/**
 * 用 AI 生成的字段起草新角色；世界书作用域要先把书切回生成时那一本（生成期间用户可能换过书）。
 */
export function startCharacterDraftFromAi(fields, scope, bookId) {
  charEditorScope = scope === 'worldbook' ? 'worldbook' : 'library';

  if (charEditorScope === 'worldbook') {
    // 生成期间用户可能换过书，切回生成时依据的那一本，副本才落对地方
    if (!focusWorldbook(bookId)) return false;
  }

  startCharDraft(fields);
  return !!charDraft;
}

/** 离开世界书作用域（世界书编辑器关掉时收尾） */
export function releaseEditorScope() {
  if (charEditorScope === 'worldbook') charEditorScope = 'library';
}

/** 把当前表单收进内存（切角色 / 导入之前调，免得填的内容白丢） */
export function stashCharacterForm() {
  stashCharForm();
}

// 开场白模板：定场 → 登场 → 留个话头（从社区角色卡归纳的三段骨架）。
// 占位是单花括号；{{user}} / {{char}} 才是会被替换的宏。
const FIRST_MES_TEMPLATE = [
  '{定场：时间 + 地点 + {{user}} 此刻正在做什么，一两句就够}',
  '',
  '{登场：{{char}} 的一个动作或神态，紧接着一句直接对 {{user}} 说出口的话}',
  '',
  '{话头：停在一个需要 {{user}} 回应的地方 —— 一个问题，或一个等着你的沉默}'
].join('\n');

/** 「套用开场白模板」：框里已经有内容就先问一句，别默默把用户写的东西冲掉 */
async function applyFirstMesTemplate() {
  const box = el.c.first;
  if (!box) return;

  if (box.value.trim()) {
    const ok = await confirmDialog({
      title: '套用开场白模板',
      message: '开场白里已经有内容，套用模板会把它覆盖掉。',
      confirmText: '覆盖',
      danger: true
    });
    if (!ok) return;
  }

  box.value = FIRST_MES_TEMPLATE;
  // 直接赋 value 不触发 input，手动派一个让角标和自动增高刷新
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

// 备选开场白：同一张卡的多个入场剧本，数据源是角色卡的 alternateGreetings。
// 行由 renderAltGreetings 动态铺；正文一律走 textContent —— 卡里的字不可信。

/** 从角色卡取一份备选开场白副本（编辑期改动不碰原数据） */
function draftAltGreetingsOf(character) {
  const list = character && Array.isArray(character.alternateGreetings) ? character.alternateGreetings : [];
  return list
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, MAX_ALT_GREETINGS);
}

/** 列表里所有备选开场白输入框（量高度 / 聚焦都用得上） */
function altGreetTextAreas() {
  return el.c.altList ? Array.from(el.c.altList.querySelectorAll('.alt-greet-text')) : [];
}

/** 把草稿铺成行；每次增删都整体重铺（条数少，不值得做增量 diff） */
function renderAltGreetings() {
  const list = el.c.altList;
  if (!list) return;

  clear(list);
  charAltGreetings.forEach((text, i) => {
    const ta = mTextarea({
      class: 'alt-greet-text',
      // id 约定见 charCountNode：宿主 id + '-count' 就是角标；组件化后 id 挂在宿主上，
      // 事件里拿到的是里层原生框，刷新角标前要先过 hostOf()。
      id: `c-alt-${i}`,
      rows: 3,
      spellcheck: 'false',
      placeholder: '第 ' + (i + 1) + ' 个入场剧本：定场 → 登场 → 留个话头',
      value: text,
      dataset: { index: i }
    });
    // 不传 key：行会重排，按字段记的高度会错位
    attachAutoGrow(ta, {});

    list.append(
      h(
        'div',
        { class: 'alt-greet-row', dataset: { index: i } },
        h(
          'div',
          { class: 'alt-greet-head' },
          h('span', { class: 'alt-greet-no', text: `备选 ${i + 1}` }),
          h('span', { class: 'field-count', id: `c-alt-${i}-count`, text: `${text.length.toLocaleString()} 字` }),
          h('button', {
            class: 'alt-greet-del',
            type: 'button',
            title: '删掉这条',
            'aria-label': `删掉备选 ${i + 1}`,
            text: '×'
          })
        ),
        ta
      )
    );
  });

  updateAltCountBadge();
}

/** 字段头那个「N 条」角标。一条都没有就留空，别显示「0 条」占地方 */
function updateAltCountBadge() {
  if (!el.c.altCount) return;
  const n = charAltGreetings.length;
  el.c.altCount.textContent = n ? `${n} 条` : '';
}

/** 「＋ 添加一条」：追加一个空行，光标落进去（空行在保存时会被丢掉） */
function addAltGreeting() {
  if (charAltGreetings.length >= MAX_ALT_GREETINGS) {
    showToast(`一张卡最多 ${MAX_ALT_GREETINGS} 条备选开场白`);
    return;
  }
  charAltGreetings.push('');
  renderAltGreetings();

  const rows = altGreetTextAreas();
  const last = rows[rows.length - 1];
  if (last) {
    last.focus();
    last.scrollIntoView({ block: 'nearest' });
  }
}

/** 删掉第 index 条（草稿级删除，点「保存角色」才落盘） */
function removeAltGreeting(index) {
  if (!Number.isInteger(index) || index < 0 || index >= charAltGreetings.length) return;
  charAltGreetings.splice(index, 1);
  renderAltGreetings();
}

/** 列表上的事件委托：删按钮 + 正文输入 */
function onAltListClick(event) {
  const del = event.target.closest('.alt-greet-del');
  if (!del) return;
  const row = del.closest('.alt-greet-row');
  removeAltGreeting(row ? Number(row.dataset.index) : NaN);
}

function onAltListInput(event) {
  // ⚙ 组件化后 target 可能是里层原生框：.alt-greet-text 和 data-index 都在宿主上，必须 hostOf
  const ta = hostOf(event.target);
  if (!ta || !ta.classList || !ta.classList.contains('alt-greet-text')) return;
  const i = Number(ta.dataset.index);
  if (Number.isInteger(i) && i >= 0 && i < charAltGreetings.length) charAltGreetings[i] = ta.value;
}

/** 绑编辑器自己的所有按钮。rerender 由入口层注入 */
export function initCharacterEditor(injected) {
  actions = { rerender: () => {}, ...(injected || {}) };
  initCharacterEditorLayout({
    onReveal: () => syncAutoGrowAll(longTextAreas().map((pair) => pair[0]).concat(altGreetTextAreas()))
  });

  el.btnCloseChars.addEventListener('click', leaveCharacterEditor);
  // 左栏底部那颗「返回」和页头左上角、Esc 是同一个动作：改完一屏手还停在栏底，
  // 不用横跨整个窗口回去（2026-10-20 补的，原来故意只留页头那一处）。
  el.btnBackChar.addEventListener('click', leaveCharacterEditor);
  el.btnNewChar.addEventListener('click', newCharacter);
  // 角色列表页的「AI 生成」：作用域钉死角色卡，直接调 aiGen 入口（经入口层转手漏传就是「点了没反应」）
  if (el.btnAiChar) {
    el.btnAiChar.addEventListener('click', () => {
      charEditorScope = 'library';
      openAiGenModal({ scope: 'library' });
    });
  }
  el.btnSaveChar.addEventListener('click', saveCharacter);
  el.btnDelChar.addEventListener('click', deleteCharacter);

  if (el.charPortrait) el.charPortrait.addEventListener('click', pickPortrait);
  if (el.btnClearPortrait) el.btnClearPortrait.addEventListener('click', clearPortrait);

  el.c.wbNewBtn.addEventListener('click', createWorldbookForCharacter);

  // 「人物列表」分区的两个按钮：AI 生成 / 新建，作用于**当前角色卡自带的那本书**。
  // 没有书时两个都先提示去「世界书」分区新建一本（副本没有落脚的书）。
  bindCharRolesBar();

  // 「AI 补充」：同样先 stash —— 模型要读的是**表单里**这张卡，刚手改的描述才带得上；
  // 结果只写回表单，点「保存」才进卡（applyAiFill 里派的 input 会顺手把胶囊打脏）。
  initCharAiFill({
    readCard: () => {
      stashCharForm();
      return editorCharacterById(editingCharacterId);
    },
    apply: applyAiFill
  });

  if (el.c.btnFirstTemplate) el.c.btnFirstTemplate.addEventListener('click', applyFirstMesTemplate);

  // 备选开场白的添加按钮 + 列表删除/输入（行是动态铺的，用委托）
  if (el.c.btnAltAdd) el.c.btnAltAdd.addEventListener('click', addAltGreeting);
  if (el.c.altList) {
    el.c.altList.addEventListener('click', onAltListClick);
    el.c.altList.addEventListener('input', onAltListInput);
  }

  // 字数角标 + 保存状态：手动输入时刷新（回填路径在 fillCharForm 里统一刷过）
  el.charForm.addEventListener('input', (event) => {
    setCharSaveState('dirty');
    // ⚙ 组件化后 input 的 target 可能是里层原生框，也可能是宿主（程序派发）；
    // 只认 instanceof HTMLTextAreaElement 会漏掉宿主，角标停在旧值 —— 两种都要认。
    const node = event.target;
    if (node instanceof HTMLTextAreaElement || (node && node.control instanceof HTMLTextAreaElement)) {
      updateCharCount(node);
    }
    // 左栏徽章（已写 x/5）与右栏字段目录的字数都跟着输入走，不然它们是开局那一刻的快照
    updateCharTotalWords();
    refreshCharSectionCounts();
  });
  // 勾选框 / 下拉不触发 input，单独挂 change（自带世界书开关、剧情选项、显示状态都走这儿）
  el.charForm.addEventListener('change', () => setCharSaveState('dirty'));

}
