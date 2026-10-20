'use strict';

// views/characterEditor.js —— 角色编辑器（角色库与世界书副本共用一套表单）
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
  worldbooks,
  worldbookById,
  worldbookCharacters,
  newWorldbookCharId
} from '../data/library.js';
import { persistCharacters, persistConversations, persistLibrary } from '../data/persist.js';
import { optionsSpecFromCharacter, DEFAULT_OPTIONS_COUNT } from '../data/suggestions.js';
import { currentWorldbook, renderWorldbookChars, focusWorldbook, openWorldbookEditor } from './worldbook.js';
import { renderWorldbookPage } from './worldbookList.js';
import { renderCharacterPage } from './characterList.js';
import { renderCharAttrs, initCharAttrsUi } from './charAttributes.js';
import {
  renderCharExpressions,
  draftExpressionsOf,
  initCharExpressionsUi
} from './charExpressions.js';
import { openAiGenModal } from './aiGen.js';
import { initCharBookAi, resetCharBookAi, materializeCharBook, setCharBookScope } from './charBookAi.js';
import { attachAutoGrow, syncAutoGrowAll } from '../ui/auto-grow.js';
import { mTextarea, hostOf } from '../components/index.js';
import { pickAndCrop } from '../ui/imageCrop.js';
import { initCharacterEditorLayout, showCharacterField, setCharSectionCount, setCharSourceChip, refreshCharSectionCounts } from './characterEditorLayout.js';
export { showCharacterField } from './characterEditorLayout.js';

// 长文本框（描述/性格/场景/开场白/示例对话）：自动增高与拖拽记忆在 ui/auto-grow.js；
// 记忆 key 用字段名而不是角色 id —— 换角色也该沿用一个高度。

function longTextAreas() {
  const c = el.c || {};
  return [
    [c.desc, 'desc'],
    [c.personality, 'personality'],
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

let editingCharacterId = null; // 角色库里当前正在编辑的角色
// 作用域：'library' 角色库；'worldbook' 当前世界书里的副本（不动角色库）
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
// 自带世界书开关的草稿，保存时才写回角色卡
let charDraftWbEnabled = true;
// 「新建角色」的草稿：先只活在编辑器里，不进列表、不写磁盘
let charDraft = null; // { character, scope, bookId }
// 属性草稿，保存角色时才写回
let charAttrs = [];
// 给角色绑世界书的浮层（自己起一个，不复用世界书页的选择器）
let worldbookPickerEl = null;

// 入口层注入的动作
let actions = { rerender: () => {} };

/** 当前作用域下的角色列表（角色库或世界书副本）；编辑器所有读写都走它 */
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
    if (creating) el.charsTitle.textContent = inBook ? '新建本书角色' : '新建角色';
    else el.charsTitle.textContent = inBook ? '编辑本书角色' : '编辑角色';
  }
  if (el.charsSub) {
    if (creating) {
      // 说清楚「现在还没这个东西」，免得用户以为点一下就已经建好了
      el.charsSub.textContent = inBook
        ? `填好内容点「保存」才会加进这本书${book ? ` · ${book.name}` : ''}`
        : '填好内容点「保存」，保存后才会出现在角色库里';
    } else {
      // 保存状态胶囊（.save-pill）已提示未保存，这里说明这几栏写下去会去哪儿
      el.charsSub.textContent = inBook
        ? `这本书里的独立副本，改它不影响角色库${book ? ` · ${book.name}` : ''}`
        : '描述与性格每轮都会注入给 AI，改完点左栏底部的「保存」';
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

  // 选书浮层挂在 body 上、z-index 比编辑页高，不收就成了悬在屏幕上的孤儿
  closeWorldbookPicker();
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

// 头像（1:1，消息气泡/状态卡）与形象（2:3 竖版，角色库列表）；上传都走 ui/imageCrop.js，
// 裁剪组件按目标尺寸输出，这里不再二次缩放。

// 头像输出 384×384（小圆图最大 ~48px，2 倍屏也够）
const AVATAR_SIZE = 384;
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
  renderMediaBox(el.charAvatar, charDraftAvatar, '点击上传');
  renderMediaBox(el.charPortrait, draftPortraitImage(), '点击上传');

  el.btnClearAvatar.classList.toggle('hidden', !charDraftAvatar);
  el.btnClearPortrait.classList.toggle('hidden', !draftPortraitImage());
  // 形象还是「沿用的头像」时标记一下 —— 否则用户会以为这张卡本来就有独立形象
  el.charPortrait.classList.toggle('is-inherited', charDraftPortrait === undefined && !!charDraftAvatar);
}

/** 选一张本地图 → 裁剪 → dataURL；取消或出错返回 null（实现在 ui/imageCrop.js） */
async function pickAvatar() {
  // 用编辑器那套查找：正在新建的草稿不在角色库里，但一样要能传头像
  if (!editorCharacterById(editingCharacterId)) return;

  const cropped = await pickAndCrop({
    aspect: 1,
    outWidth: AVATAR_SIZE,
    title: '裁剪头像',
    hint: '消息气泡和状态卡上显示的就是这一块',
    pickTitle: '选一张头像'
  });
  if (!cropped) return;

  // 老卡只有一张图：换头像前先把旧的留作形象，否则立绘会被顶掉、形象变成 1:1 方图
  if (charDraftPortrait === undefined && charDraftAvatar) charDraftPortrait = charDraftAvatar;

  charDraftAvatar = cropped;
  renderCharMedia();
  showToast('头像已更换，记得点「保存」', 'ok');
}

async function pickPortrait() {
  if (!editorCharacterById(editingCharacterId)) return;

  const cropped = await pickAndCrop({
    aspect: PORTRAIT_RATIO,
    outWidth: PORTRAIT_WIDTH,
    title: '裁剪角色形象',
    hint: '竖版立绘，显示在角色库列表上',
    pickTitle: '选一张角色形象'
  });
  if (!cropped) return;

  charDraftPortrait = cropped;
  renderCharMedia();
  showToast('形象已更换，记得点「保存」', 'ok');
}

function clearAvatar() {
  if (!charDraftAvatar) return;
  charDraftAvatar = '';
  renderCharMedia();
  showToast('头像已清除，记得点「保存」');
}

function clearPortrait() {
  if (!draftPortraitImage()) return;
  // 必须写空串（不是退回 undefined）：用户点了清除就是不要形象，不能又拿头像顶上
  charDraftPortrait = '';
  renderCharMedia();
  showToast('形象已清除，记得点「保存」');
}

// 表情图：编辑界面在 views/charExpressions.js，这里只持有草稿，保存时由 stashCharForm 写回卡上

/** 表情草稿变了：只刷分区导航上的条目数（列表由 charExpressions.js 自己重铺） */
function updateExprSummary() {
  // 0 也照显示，藏起来会以为没这个功能
  setCharSectionCount('expressions', String(charExpressions.length));
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
  el.c.personality.value = character.personality || '';
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
  renderCharExpressions(charExpressions);
  updateExprSummary();

  // 开关的草稿要从这张卡的当前值起算（老数据没这个字段 = 开）
  charDraftWbEnabled = character.worldbookEnabled !== false;

  // 换了一张卡：上一张还没落盘的 AI 设定草稿不能跟过来
  resetCharBookAi();

  // 角色自带的世界书：清单 + 绑定按钮 + 开关
  renderCharWorldbookBox(character);

  // 属性：复制一份当草稿，保存时才写回角色卡
  charAttrs = characterAttrs(character);
  renderCharAttrs(charAttrs);

  // 剧情选项：没配过的卡（老卡/导入/新建）也算开、默认 4 条，只有卡上明确 `false` 才是关。
  // 见 data/suggestions.js 的 optionsSpecFromCharacter。
  const optSpec = optionsSpecFromCharacter(character);
  el.c.optionsOn.checked = !!optSpec;
  setOptionsCount((optSpec && optSpec.count) || DEFAULT_OPTIONS_COUNT);
  el.c.optionsHint.value = optSpec ? optSpec.hint || '' : '';
  renderOptionsConfig();

  // 「在状态栏显示」只有世界书副本用得上；角色库的卡绑进单角色会话时永远显示状态，整块收起来
  el.c.showInPanel.checked = character.showInPanel === true;
  renderShowInPanelBox();

  // 左栏来源胶囊 + 页头保存状态（刚填好的表 = 已保存）
  setCharSourceChip(charSourceChipText(character));
  setCharSaveState('saved');

  showCharForm(true);

  // 到这儿弹窗才可见，量高度才准（隐藏状态下量会永远得到 84px）
  syncAutoGrowAll(longTextAreas().map((pair) => pair[0]).concat(altGreetTextAreas()));
  syncAllCharCounts();
}

/** 剧情选项的配置区：开关关着就整块收起来（省得看着以为在生效） */
function renderOptionsConfig() {
  if (!el.c.optionsConfig) return;
  el.c.optionsConfig.classList.toggle('hidden', !el.c.optionsOn.checked);
}

/** 「每轮给几个」的档位；1 条没得选、6 条会把输入框那一行顶掉，只留 2~5 */
const OPTION_COUNT_CHOICES = [2, 3, 4, 5];

/**
 * 老卡可能存着 1 或 6（旧版是 1~6 数字输入），夹到最近的档而不是一律重置成 4。
 */
function setOptionsCount(value) {
  const wanted = Number(value);
  const target = OPTION_COUNT_CHOICES.reduce(
    (best, n) => (Math.abs(n - wanted) < Math.abs(best - wanted) ? n : best),
    OPTION_COUNT_CHOICES[0]
  );
  const radios = el.c.optionsCount
    ? el.c.optionsCount.querySelectorAll('input[type="radio"]')
    : [];
  for (const radio of radios) radio.checked = Number(radio.value) === target;
}

/** 读当前选中的档位；一个都没选中（标记被别处改坏）时兜回默认值 */
function optionsCountValue() {
  const checked = el.c.optionsCount
    ? el.c.optionsCount.querySelector('input[type="radio"]:checked')
    : null;
  const value = Number(checked && checked.value);
  return OPTION_COUNT_CHOICES.includes(value) ? value : DEFAULT_OPTIONS_COUNT;
}

/** 「在状态栏显示」只给世界书作用域用；角色库的卡永远显示状态，整块收起 */
function renderShowInPanelBox() {
  if (!el.c.showInPanelBox) return;
  el.c.showInPanelBox.classList.toggle('hidden', charEditorScope !== 'worldbook');
}

// 角色自带的世界书

/** 角色自带世界书：清单 + 绑定按钮 + 开关；没绑定也始终显示（入口要一直在） */
function renderCharWorldbookBox(character) {
  if (!character) return;

  // 「AI 补设定」：角色库的卡保存时建一本自己的书；世界书里的副本并进**这本书的草稿**
  // （副本自己带的世界书进世界时不会被注入，见 data/cast.js 的 effectiveWorldbookIds）
  setCharBookScope(charEditorScope, currentWorldbook() ? currentWorldbook().name : '');

  const ids = character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [];
  const books = ids.map((id) => worldbookById(id)).filter(Boolean);
  setCharSectionCount('worldbook', String(books.length));
  // 开关的当前值以草稿为准（用户可能刚切过还没保存）
  const enabled = charDraftWbEnabled;

  // --- 已绑的清单 ---
  el.c.wbList.innerHTML = '';

  if (!books.length) {
    const empty = document.createElement('p');
    empty.className = 'field-help cwb-empty';
    empty.textContent =
      '还没有绑定。点「＋ 绑定」从世界书库里挑一本 —— 单独跟这个角色聊天时会带上它。';
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
      // 2026-10-20 星宝要的（原来想改书得先返回 → 世界书页 → 找书 → 点编辑，四步）。
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
      del.title = '解绑（不会删掉世界书本身）';
      del.setAttribute('aria-label', `解绑 ${book.name}`);
      del.textContent = '✕';
      del.addEventListener('click', () => unbindWorldbookFromCharacter(book.id));

      row.append(name, count, edit, del);
      el.c.wbList.appendChild(row);
    }
  }

  // --- 开关：没有绑定时藏起来（开着也没意义）---
  const hasBooks = books.length > 0;
  el.c.wbSwitch.classList.toggle('hidden', !hasBooks);
  el.c.wbEnabled.checked = enabled;

  if (!hasBooks) {
    el.c.wbDesc.textContent = '';
    el.c.wbHint.textContent =
      '绑定之后，这张卡单独聊天会带上这本书的设定；被绑进某个世界当角色时不生效（那条会话有自己的世界观）。';
    return;
  }

  const names = books.map((b) => b.name).join('、');
  const total = books.reduce((sum, b) => sum + (Array.isArray(b.entries) ? b.entries.length : 0), 0);
  el.c.wbDesc.textContent = `已绑 ${books.length} 本（共 ${total} 条）：${names}`;

  el.c.wbHint.textContent = enabled
    ? '现在生效。单独跟它聊天时会带上这些设定；但绑进某个世界当角色时不生效 —— 那条会话已经有自己的世界观了。'
    : '已停用。无论单独聊天、还是绑进某个世界当角色，都不会带入这几本书 —— 这张卡保持干净（绑定关系留着，随时能再打开）。';
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

/** 世界书编辑器逛一圈回来时用：把那块「已绑世界书」按**最新**数据重画。
 *  书名 / 条目数可能刚在那边改过，不重画就还是旧的那行。 */
export function refreshCharWorldbookBox() {
  const character = editorCharacterById(editingCharacterId);
  if (character) renderCharWorldbookBox(character);
}

/** 只刷新开关下面的说明文字（切换开关时用，不动清单） */
function updateCharWorldbookHint(character) {
  const books = (character && Array.isArray(character.worldbookIds) ? character.worldbookIds : [])
    .map((id) => worldbookById(id))
    .filter(Boolean);
  if (!books.length) return;

  const enabled = character.worldbookEnabled !== false;
  const names = books.map((b) => b.name).join('、');
  const total = books.reduce((sum, b) => sum + (Array.isArray(b.entries) ? b.entries.length : 0), 0);
  el.c.wbDesc.textContent = `已绑 ${books.length} 本（共 ${total} 条）：${names}`;

  el.c.wbHint.textContent = enabled
    ? '现在生效。单独跟它聊天时会带上这些设定；但绑进某个世界当角色时不生效 —— 那条会话已经有自己的世界观了。'
    : '已停用。无论单独聊天、还是绑进某个世界当角色，都不会带入这几本书 —— 这张卡保持干净（绑定关系留着，随时能再打开）。';
}

async function bindWorldbookToCharacter(bookId) {
  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  const ids = Array.isArray(character.worldbookIds) ? [...character.worldbookIds] : [];
  if (ids.includes(bookId)) {
    showToast('这本已经绑上了');
    return;
  }

  // 写盘失败要能退回去；新建草稿还没进任何列表，只改草稿、等保存角色时一起落盘
  const hadIds = Array.isArray(character.worldbookIds);
  const beforeIds = hadIds ? [...character.worldbookIds] : [];
  const beforeEnabled = character.worldbookEnabled;
  const beforeDraftWbEnabled = charDraftWbEnabled;
  const beforeUpdatedAt = character.updatedAt;

  ids.push(bookId);
  character.worldbookIds = ids;
  // 刚绑上就默认启用；草稿开关要一起改，否则保存时会按旧值写回 false
  if (character.worldbookEnabled === false && ids.length === 1) {
    character.worldbookEnabled = true;
    charDraftWbEnabled = true;
  }
  character.updatedAt = now();
  renderCharWorldbookBox(character);

  if (isCharDraft()) {
    showToast('已绑定世界书，保存后生效');
    return;
  }

  if (!(await persistLibrary())) {
    if (hadIds) character.worldbookIds = beforeIds;
    else delete character.worldbookIds;
    character.worldbookEnabled = beforeEnabled;
    charDraftWbEnabled = beforeDraftWbEnabled;
    character.updatedAt = beforeUpdatedAt;
    renderCharWorldbookBox(character);
    return;
  }
  showToast('已绑定世界书');
}

/** 解绑（不删世界书本身） */
async function unbindWorldbookFromCharacter(bookId) {
  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  const book = worldbookById(bookId);
  const beforeIds = Array.isArray(character.worldbookIds) ? [...character.worldbookIds] : [];
  const beforeUpdatedAt = character.updatedAt;

  character.worldbookIds = beforeIds.filter((id) => id !== bookId);
  character.updatedAt = now();
  renderCharWorldbookBox(character);

  if (isCharDraft()) {
    showToast(book ? `已解绑「${book.name}」（世界书还在库里）` : '已解绑');
    return;
  }

  if (!(await persistLibrary())) {
    character.worldbookIds = beforeIds;
    character.updatedAt = beforeUpdatedAt;
    renderCharWorldbookBox(character);
    return;
  }
  showToast(book ? `已解绑「${book.name}」（世界书还在库里）` : '已解绑');
}

/** 点「＋ 绑定」列出还没绑的世界书；自起浮层，不复用世界书页那个方向相反、绑了模块级状态的选择器 */
function openWorldbookPicker() {
  const character = editorCharacterById(editingCharacterId);
  if (!character) return;

  const bound = new Set(Array.isArray(character.worldbookIds) ? character.worldbookIds : []);
  const all = worldbooks();
  const candidates = all.filter((b) => !bound.has(b.id));

  if (!all.length) {
    showToast('世界书库还是空的 —— 先去「世界书」页新建或导入一本', 'error');
    return;
  }
  if (!candidates.length) {
    showToast('所有世界书都已经绑上了');
    return;
  }

  closeWorldbookPicker();

  const overlay = document.createElement('div');
  overlay.className = 'cwb-picker';

  const card = document.createElement('div');
  card.className = 'cwb-picker-card';

  const head = document.createElement('div');
  head.className = 'cwb-picker-head';
  const title = document.createElement('span');
  title.className = 'cwb-picker-title';
  title.textContent = `给「${character.name}」绑定世界书`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn icon-btn-sm';
  close.title = '关闭';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '✕';
  close.addEventListener('click', closeWorldbookPicker);
  head.append(title, close);

  const list = document.createElement('div');
  list.className = 'cwb-picker-list';

  for (const book of candidates) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cwb-picker-row';

    const name = document.createElement('span');
    name.className = 'cwb-picker-name';
    name.textContent = book.name;

    const meta = document.createElement('span');
    meta.className = 'cwb-picker-meta';
    const n = Array.isArray(book.entries) ? book.entries.length : 0;
    const chars = Array.isArray(book.characters) ? book.characters.length : 0;
    meta.textContent = chars ? `${n} 条 · ${chars} 个角色` : `${n} 条`;

    row.append(name, meta);
    row.addEventListener('click', () => {
      closeWorldbookPicker();
      bindWorldbookToCharacter(book.id);
    });
    list.appendChild(row);
  }

  card.append(head, list);
  overlay.appendChild(card);

  // 点浮层空白处关掉
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeWorldbookPicker();
  });

  document.body.appendChild(overlay);
  worldbookPickerEl = overlay;
}

// Esc 链用：浮层挂在 body 上、z-index(60) 高于编辑器(50)，按 Esc 应先关它
export function isWorldbookPickerOpen() {
  return !!worldbookPickerEl;
}

export function closeWorldbookPicker() {
  if (worldbookPickerEl) {
    worldbookPickerEl.remove();
    worldbookPickerEl = null;
  }
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
  character.personality = el.c.personality.value;
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
  // 剧情选项关掉要写 `false`（不是 null）：主进程把「没这个字段」当成默认开 4 条
  if (el.c.optionsOn.checked) {
    character.optionsSpec = { count: optionsCountValue(), hint: el.c.optionsHint.value.trim().slice(0, 200) };
  } else {
    character.optionsSpec = false;
  }
  // 没绑书就不写 worldbookEnabled，别给没书的角色平白加属性
  if (Array.isArray(character.worldbookIds) && character.worldbookIds.length) {
    character.worldbookEnabled = charDraftWbEnabled;
  }
  // showInPanel 只对世界书副本写；角色库的卡写了也没用（单角色会话永远显示状态，见 cast.js）
  if (charEditorScope === 'worldbook') {
    character.showInPanel = el.c.showInPanel.checked === true;
  } else {
    delete character.showInPanel;
  }
  character.updatedAt = now();
}

/** 角色列表页的「＋ 新建角色」：作用域钉死在角色库（上次可能停在世界书） */
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

/** 把新建的草稿真正写进角色库/世界书；只有点「保存角色」会走到这里 */
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
  // 副本作用域要写进哪本书：草稿提交之后 charDraft 就没了，先记下来
  const draftBookId = charDraft ? charDraft.bookId : null;

  stashCharForm();

  // 新建的角色到这一刻才真正被创建（进角色库 / 进这本书）
  if (creating && !commitCharDraft()) {
    showToast('这本书已经不在了，角色没能创建', 'error');
    return;
  }

  // 「AI 补设定」补出来的条目：角色库的卡 → 建一本书并绑上（跟着同一次写盘落地）；
  // 副本 → 并进这本书的草稿，等世界书编辑器那边点「保存」
  const madeBook = await materializeCharBook(character, {
    scope,
    bookId: scope === 'worldbook'
      ? draftBookId || (currentWorldbook() ? currentWorldbook().id : null)
      : null
  });
  if (madeBook && !madeBook.draft) {
    // 刚补的设定默认是开着的 —— 用户刚要的东西，别让它一上来就是停用态
    charDraftWbEnabled = true;
    character.worldbookEnabled = true;
    renderCharWorldbookBox(character);
  }

  // 新建是终点（直接离开）；改已有的留在本页，多半还要接着改
  if (creating) {
    renderCharacterPage();
    actions.rerender();
    // 改的是书里的副本，那本书的角色排和世界书列表页也要跟着刷新
    if (scope === 'worldbook') {
      renderWorldbookChars();
      renderWorldbookPage();
    }
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

  // 改的是书里的副本，书名旁边那排和左栏计数都要跟着刷新
  if (scope === 'worldbook') {
    renderWorldbookChars();
    renderWorldbookPage();
  }

  // 失败提示由 persistCharacters 弹；成功才报「已保存」，否则后一条会盖掉前一条
  if (await persistCharacters()) {
    setCharSaveState('saved');
    showToast(`角色「${character.name}」已保存`, 'ok');
  }
}

// 删除角色（'library' 从角色库删 / 'worldbook' 只移除本书副本），两个入口共用。
// ⚠️ 写盘失败必须把内存也退回去 —— EPERM 时若界面已移除还报「已删除」，重启就回来了。
export async function deleteCharacterById(id, scope) {
  const inBook = scope === 'worldbook';

  const character = inBook
    ? worldbookCharacters(currentWorldbook()).find((c) => c.id === id)
    : characters().find((c) => c.id === id);
  if (!character) return;

  const ok = await confirmDialog({
    title: inBook ? '移除角色' : '删除角色',
    message: inBook
      ? `把「${character.name}」从这本书里移除？角色库里的那个角色不受影响。`
      : `删除角色「${character.name}」？用到它的会话会变回通用助手。`,
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

      // 书里的副本不受会话影响，只需要刷新书那边的界面
      renderWorldbookChars();
      renderWorldbookPage();

      if (!(await persistCharacters())) {
        // 写盘失败 → 把副本放回去，界面跟磁盘保持一致
        book.characters = beforeChars;
        book.updatedAt = beforeBookUpdatedAt;
        renderWorldbookChars();
        renderWorldbookPage();
        return;
      }
      showToast(`已移除「${character.name}」`);
      return;
    }
  }

  // --- 从角色库删 ---
  // 记住改之前的样子，写盘失败时退回去
  const beforeChars = characters();
  const unbound = [];

  state.characters = beforeChars.filter((c) => c.id !== character.id);

  // 把绑定了这个角色的会话解绑，免得留下一个指向空气的 id
  for (const convo of state.conversations) {
    if (convo.characterId === character.id) {
      convo.characterId = null;
      unbound.push(convo);
    }
  }

  actions.rerender();

  if (!(await persistCharacters())) {
    state.characters = beforeChars;
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

  const ok = await confirmDialog({
    title: '批量删除角色',
    message: `删除 ${names}${more}？${tail}`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return false;

  const beforeChars = characters();
  const unbound = [];

  state.characters = beforeChars.filter((character) => !wanted.has(character.id));

  for (const convo of state.conversations) {
    if (wanted.has(convo.characterId)) {
      // 记下原来绑的是哪一张，写盘失败时按它退回去
      unbound.push([convo, convo.characterId]);
      convo.characterId = null;
    }
  }

  actions.rerender();

  if (!(await persistCharacters())) {
    // 写盘失败 → 内存也退回去：卡还在列表里、会话绑定也恢复，界面和磁盘一致
    state.characters = beforeChars;
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

/** 打开编辑器，编辑指定角色（scope 省略 = 角色库） */
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

/** 编辑器里正在编辑的那个角色（导出角色卡要用） */
export function currentEditorCharacter() {
  return editorCharacterById(editingCharacterId);
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
  el.btnNewChar.addEventListener('click', newCharacter);
  // 角色列表页的「AI 生成」：作用域钉死角色库，直接调 aiGen 入口（经入口层转手漏传就是「点了没反应」）
  if (el.btnAiChar) {
    el.btnAiChar.addEventListener('click', () => {
      charEditorScope = 'library';
      openAiGenModal({ scope: 'library' });
    });
  }
  el.btnSaveChar.addEventListener('click', saveCharacter);
  el.btnDelChar.addEventListener('click', deleteCharacter);

  el.charAvatar.addEventListener('click', pickAvatar);
  el.btnClearAvatar.addEventListener('click', clearAvatar);
  el.charPortrait.addEventListener('click', pickPortrait);
  el.btnClearPortrait.addEventListener('click', clearPortrait);

  // 表情图：加 / 批量导入的接线在 charExpressions 模块里（initCharExpressionsUi）

  // 自带世界书开关：先更新草稿再刷新说明；不能直接读 editorCharacterById（卡上还是旧值，点了说明不变）
  el.c.wbEnabled.addEventListener('change', () => {
    charDraftWbEnabled = el.c.wbEnabled.checked;
    const character = editorCharacterById(editingCharacterId);
    if (character) {
      updateCharWorldbookHint({ ...character, worldbookEnabled: charDraftWbEnabled });
    }
  });

  el.c.wbAddBtn.addEventListener('click', openWorldbookPicker);

  // 「AI 补设定」：要读**表单里当前**的卡 —— 先 stash 进草稿，刚手改的描述才带得上；
  // 拿到条目算「有未保存的改动」，和手改走同一条路（点保存才建书、才落盘）。
  initCharBookAi({
    readCard: () => {
      stashCharForm();
      return editorCharacterById(editingCharacterId);
    },
    onChange: () => setCharSaveState('dirty')
  });

  if (el.c.optionsOn) el.c.optionsOn.addEventListener('change', renderOptionsConfig);

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

  // 属性区按钮（分组标签栏是渲染时就带的）
  initCharAttrsUi({ getList: () => charAttrs });

  // 表情图按钮：草稿仍是本模块的 charExpressions，经 getList 传过去，改动后刷新摘要
  initCharExpressionsUi({ getList: () => charExpressions, onChange: updateExprSummary });
}
