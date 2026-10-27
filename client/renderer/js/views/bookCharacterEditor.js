'use strict';

// views/bookCharacterEditor.js —— 本书角色编辑页（世界书 → 本书角色 → 编辑）
// 从 characterEditor.js 复制的一份，但只负责介绍角色内容：只有「角色描述」一栏，
// 没有场景 / 开场白 / 示例对话 / 性格，也不自带世界书（世界书是角色卡的）。
// 新建角色只是草稿，保存才落库；属性/表情图草稿归本模块，拆出去的两个模块拿同一份数组引用。

import { state } from '../core/state.js';
import { el } from './bookCharEditorDom.js';
import { uid, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { showView, currentViewName } from './viewSwitch.js';
import { MAX_PANEL_FIELDS, seedPanelFromCharacters, suppressPanelOwners } from '../data/panel.js';
import { MAX_EXPRESSIONS } from '../data/expressions.js';
import {
  characters,
  characterAttrs,
  worldbookById,
  worldbookCharacters,
  effectiveWorldbookIds,
  newWorldbookCharId
} from '../data/library.js';
import { persistCharacters, persistConversations } from '../data/persist.js';
import { currentWorldbook, rerenderBookCharHosts, focusWorldbook } from './worldbook.js';
import { renderCharacterPage } from './characterList.js';
import { renderCharAttrs, initCharAttrsUi } from './bookCharAttributes.js';
import {
  renderCharExpressions,
  draftExpressionsOf,
  initCharExpressionsUi
} from './bookCharExpressions.js';
import { openAiGenModal } from './aiGen.js';
import { initCharAiFill, resetCharAiFill } from './bookCharAiFill.js';
import { attachAutoGrow, syncAutoGrowAll } from '../ui/auto-grow.js';
import { hostOf } from '../components/index.js';
import { pickAndCrop } from '../ui/imageCrop.js';
import { initCharacterEditorLayout, showCharacterField, setCharSectionCount, setCharSourceChip, refreshCharSectionCounts } from './bookCharacterEditorLayout.js';
export { showCharacterField } from './bookCharacterEditorLayout.js';

// 长文本框（描述）：自动增高与拖拽记忆在 ui/auto-grow.js；
// 记忆 key 用字段名而不是角色 id —— 换角色也该沿用一个高度。

function longTextAreas() {
  const c = el.c || {};
  return [
    [c.desc, 'desc']
  ].filter((pair) => pair[0]);
}

/** 页头右侧的保存状态小胶囊：输入即「未保存」，保存成功 / 重新填表归「已保存」 */
function setCharSaveState(state) {
  if (!el.charSaveState) return;
  el.charSaveState.dataset.state = state;
  el.charSaveState.textContent = state === 'dirty' ? '有未保存的改动' : '所有更改已保存';
  // 同步给表单根（data-save-state）：左栏那颗「保存」跟着亮/熄，理由同 characterEditor.js
  if (el.charForm) el.charForm.dataset.saveState = state;
}

/** 给这一个框接上自动增高。接线只需一次（重复调用会被 ignore） */
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

/** 页头右侧的「全文 N 字」：一个写作栏 + 高级设置三栏，和世界书页头同一种读法 */
function updateCharTotalWords() {
  if (!el.charTotalWords) return;
  let total = 0;
  for (const [node] of longTextAreas()) total += String(node.value || '').length;
  for (const id of ['bc-c-system', 'bc-c-post', 'bc-c-notes']) {
    const node = document.getElementById(id);
    if (node) total += String(node.value || '').length;
  }
  el.charTotalWords.textContent = `全文 ${total.toLocaleString()} 字`;
}

/** 刷新这一个框的角标 + 左栏徽章（fillCharForm 回填之后用） */
function syncAllCharCounts() {
  for (const [node] of longTextAreas()) updateCharCount(node);
  updateCharTotalWords();
  // 徽章与目录上的字数/已写圆点都从 DOM 现算，回填之后必须补一次
  refreshCharSectionCounts();
}

// 编辑器的状态

let editingCharacterId = null; // 这本书里当前正在编辑的副本
// 本页恒为 'worldbook' 作用域：只读写当前这本书的副本，永远不碰角色卡
let charEditorScope = 'worldbook';
// 正在编辑的角色头像（dataURL，正方形），用在消息气泡和状态卡上
let charDraftAvatar = '';
// 形象（dataURL，2:3 竖版）三态，保存时必须照原样区分：
// undefined = 没设过（界面用头像顶上，别写这个键，省几 MB）；'' = 明确清掉；dataURL = 有独立形象。
let charDraftPortrait;
// 表情图草稿（深拷贝），保存角色时才写回卡上
let charExpressions = [];
// 「新建角色」的草稿：先只活在编辑器里，不进列表、不写磁盘
let charDraft = null; // { character, scope, bookId }
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
let editorReturnView = 'wbEditor';

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
  if (from !== 'bookCharEditor') editorReturnView = from;

  // 先让这一屏可见再填表：fillCharForm 会量文本框高度，display:none 下量什么都是 0
  showView('bookCharEditor');

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
  showView(editorReturnView === 'bookCharEditor' ? 'wbEditor' : editorReturnView);
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
  // 用编辑器那套查找：正在新建的草稿不在角色卡里，但一样要能传头像
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
    hint: '竖版立绘，显示在角色卡列表上',
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
  el.c.system.value = character.systemPrompt || '';
  el.c.post.value = character.postHistoryInstructions || '';
  el.c.notes.value = character.creatorNotes || '';

  // 年龄/性别/种族不在这张表单里，归入描述文字；这里不回填这几个输入框。

  // 长文本：值由程序塞入不走 input，故显式重算高度。
  // ⚠️ 接线必须在这里（startCharDraft 不经过 openCharsModal），但不能此刻量：调用方还没摘 .hidden，display:none 下 scrollHeight 恒为 0。
  wireAutoGrow();

  renderCharMedia();
  renderCharExpressions(charExpressions);
  updateExprSummary();

  // 换了一张卡：上一张还没落盘的 AI 设定草稿不能跟过来
  // 上一张卡的「AI 补充」请求也一样要作废，别让它把内容写进新卡的表单
  resetCharAiFill();

  // 属性：复制一份当草稿，保存时才写回角色卡
  charAttrs = characterAttrs(character);
  renderCharAttrs(charAttrs);

  // 「在状态栏显示」只有世界书副本用得上；角色卡绑进单角色会话时永远显示状态，整块收起来
  el.c.showInPanel.checked = character.showInPanel === true;
  renderShowInPanelBox();

  // 左栏来源胶囊 + 页头保存状态（刚填好的表 = 已保存）
  setCharSourceChip(charSourceChipText(character));
  setCharSaveState('saved');

  showCharForm(true);

  // 到这儿弹窗才可见，量高度才准（隐藏状态下量会永远得到 84px）
  syncAutoGrowAll(longTextAreas().map((pair) => pair[0]));
  syncAllCharCounts();
}

/**
 * 「AI 补充」的结果填进表单（见 views/bookCharAiFill.js）。
 * · 只覆盖 AI 真给了内容的那几栏：模型偶尔漏一栏，别拿空串把手写的抹掉；
 * · 每填一栏派一个 input —— 和用户手打一个字走的是同一条路，角标 / 自动增高 /
 *   「有未保存的改动」胶囊会一起刷新（直接赋值不触发 input，那三样会停在旧值）；
 * · 名字 / 标签 / 属性 / 备注一律不碰：这份任务只改这一栏。
 * @returns {number} 真正填了几栏（0 = 一栏都没填，调用方要报错）
 */
function applyAiFill(fields) {
  const map = [
    ['description', el.c.desc]
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

/** 「在状态栏显示」只给世界书作用域用；角色卡永远显示状态，整块收起 */
function renderShowInPanelBox() {
  if (!el.c.showInPanelBox) return;
  el.c.showInPanelBox.classList.toggle('hidden', charEditorScope !== 'worldbook');
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
  // 本书角色编辑器不暴露性格 / 场景 / 开场白 / 示例对话输入框；
  // 但导入副本可能带这些兼容字段，未在界面编辑的字段必须原样保留。
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
  if (charEditorScope === 'worldbook') {
    character.showInPanel = el.c.showInPanel.checked === true;
  } else {
    delete character.showInPanel;
  }
  character.updatedAt = now();
}

/** 新建副本：作用域恒为本页（世界书副本） */
function newCharacter() {
  charEditorScope = 'worldbook';
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
    // 本书角色只介绍角色内容，不带性格 / 场景 / 开场白 / 示例对话；AI 生成时也只填描述
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
  if (from !== 'bookCharEditor') editorReturnView = from;

  // 先让这一屏可见再填表：隐藏状态下量高度都是 0
  showView('bookCharEditor');
  fillCharForm(character);
  updateCharEditorScopeUi();

  showCharacterField('bc-c-desc');
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

/** 把新建副本的属性补种进「已经开着、正玩这本书」的会话（新建会话那边自己会 seed）。
 *  只对本书角色（worldbook 作用域）有意义；角色卡是单角色会话，本来就全套注入。 */
function seedNewCharacterIntoOpenConvos(character, bookId) {
  if (!character || !bookId) return;
  let touched = 0;
  for (const convo of state.conversations) {
    if (!effectiveWorldbookIds(convo).includes(bookId)) continue;
    if (seedPanelFromCharacters(convo, [character])) touched += 1;
  }
  if (touched) persistConversations(0);
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
  const bookId = creating ? charDraft.bookId : null;

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
    if (scope === 'worldbook') {
      rerenderBookCharHosts(currentWorldbook());
      // 已经开着的会话不会重新 seed（那一步只在建会话时做）：新副本的属性手动补进去
      seedNewCharacterIntoOpenConvos(character, bookId);
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

  const ok = await confirmDialog({
    title: inBook ? '移除角色' : '删除角色',
    message: inBook
      ? `把「${character.name}」从这本书里移除？角色卡里的那个角色不受影响。`
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

      // 书里的副本不受会话影响，只需要刷新角色卡编辑页那边的人物列表
      rerenderBookCharHosts(book);

      if (!(await persistCharacters())) {
        // 写盘失败 → 把副本放回去，界面跟磁盘保持一致
        book.characters = beforeChars;
        book.updatedAt = beforeBookUpdatedAt;
        rerenderBookCharHosts(book);
        return;
      }
      // 清除这个副本名下的面板字段，但不删除聊天历史内容。
      for (const convo of state.conversations) {
        suppressPanelOwners(convo, [{ id: character.id, name: character.name }]);
      }
      persistConversations(0);
      showToast(`已移除「${character.name}」`);
      return;
    }
  }

  // --- 从角色卡删 ---
  // 记住改之前的样子，写盘失败时退回去
  const beforeChars = characters();
  const unbound = [];
  const playerBindings = [];

  state.characters = beforeChars.filter((c) => c.id !== character.id);

  // 删除卡时同时清理会话里的卡引用；玩家已复制到会话的名字和设定不变。
  for (const convo of state.conversations) {
    if (convo.characterId === character.id) {
      convo.characterId = null;
      unbound.push(convo);
    }
    if (convo.player && convo.player.characterId === character.id) {
      convo.player = { ...convo.player, characterId: null };
      playerBindings.push(convo);
    }
  }

  actions.rerender();

  if (!(await persistCharacters())) {
    state.characters = beforeChars;
    for (const convo of unbound) convo.characterId = character.id;
    for (const convo of playerBindings) if (convo.player) convo.player.characterId = character.id;
    actions.rerender();
    return;
  }

  // 删除成功后才清理面板 owner；写盘失败的回滚路径不会碰会话状态。
  for (const convo of state.conversations) {
    suppressPanelOwners(convo, [{ id: character.id, name: character.name }]);
  }

  // 编辑器正开在这个角色上就离开它；放在写盘成功之后（失败时角色还在，不该关编辑器）
  if (editingCharacterId === character.id) {
    editingCharacterId = null;
    if (currentViewName() === 'bookCharEditor') await leaveCharacterEditor({ force: true });
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

  // 多张卡一起删除时一次性传入 owner 集合，避免同名字段被误判为仍在场。
  const removedOwners = targets.map((character) => ({ id: character.id, name: character.name }));
  for (const convo of state.conversations) {
    suppressPanelOwners(convo, removedOwners);
  }

  // 编辑器正开在被删的某一张上：没有可编辑的对象了，离开它
  if (editingCharacterId && wanted.has(editingCharacterId)) {
    editingCharacterId = null;
    if (currentViewName() === 'bookCharEditor') await leaveCharacterEditor({ force: true });
  }

  persistConversations(0);
  showToast(`已删除 ${targets.length} 个角色`);
  return true;
}

// 给入口层 / 别的视图用的口子

/** 打开编辑器，编辑这本书里的一个副本 */
export function openCharacterEditor(id) {
  const different = editingCharacterId !== (id || null);
  charEditorScope = 'worldbook';
  editingCharacterId = id || null;
  openCharsModal();
  if (different) showCharacterField('bc-c-desc');
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
  charEditorScope = 'worldbook';

  // 生成期间用户可能换过书，切回生成时依据的那一本，副本才落对地方
  if (!focusWorldbook(bookId)) return false;

  startCharDraft(fields);
  return !!charDraft;
}

/** 本页只有一个作用域，收尾时把编辑目标清掉即可（世界书删书时调） */
export function releaseEditorScope() {
  editingCharacterId = null;
}

/** 把当前表单收进内存（切角色 / 导入之前调，免得填的内容白丢） */
export function stashCharacterForm() {
  stashCharForm();
}

/** 绑编辑器自己的所有按钮。rerender 由入口层注入 */
export function initCharacterEditor(injected) {
  actions = { rerender: () => {}, ...(injected || {}) };
  initCharacterEditorLayout({
    onReveal: () => syncAutoGrowAll(longTextAreas().map((pair) => pair[0]))
  });

  el.btnCloseChars.addEventListener('click', leaveCharacterEditor);
  // 左栏底部那颗「返回」和页头左上角、Esc 是同一个动作：改完一屏手还停在栏底，
  // 不用横跨整个窗口回去（2026-10-20 补的，原来故意只留页头那一处）。
  el.btnBackChar.addEventListener('click', leaveCharacterEditor);
  if (el.btnNewChar) el.btnNewChar.addEventListener('click', newCharacter);
  // 角色列表页的「AI 生成」：作用域钉死角色卡，直接调 aiGen 入口（经入口层转手漏传就是「点了没反应」）
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

  // 「AI 补充」：同样先 stash —— 模型要读的是**表单里**这张卡，刚手改的描述才带得上；
  // 结果只写回表单，点「保存」才进卡（applyAiFill 里派的 input 会顺手把胶囊打脏）。
  initCharAiFill({
    readCard: () => {
      stashCharForm();
      return editorCharacterById(editingCharacterId);
    },
    apply: applyAiFill
  });

  // 字数角标 + 保存状态：手动输入时刷新（回填路径在 fillCharForm 里统一刷过）
  el.charForm.addEventListener('input', (event) => {
    setCharSaveState('dirty');
    // ⚙ 组件化后 input 的 target 可能是里层原生框，也可能是宿主（程序派发）；
    // 只认 instanceof HTMLTextAreaElement 会漏掉宿主，角标停在旧值 —— 两种都要认。
    const node = event.target;
    if (node instanceof HTMLTextAreaElement || (node && node.control instanceof HTMLTextAreaElement)) {
      updateCharCount(node);
    }
    // 左栏徽章（已填几栏）跟着输入走，不然它是开局那一刻的快照
    updateCharTotalWords();
    refreshCharSectionCounts();
  });
  // 勾选框 / 下拉不触发 input，单独挂 change（「在状态栏显示」走这儿）
  el.charForm.addEventListener('change', () => setCharSaveState('dirty'));

  // 属性区按钮（分组标签栏是渲染时就带的）
  initCharAttrsUi({ getList: () => charAttrs });

  // 表情图按钮：草稿仍是本模块的 charExpressions，经 getList 传过去，改动后刷新摘要
  initCharExpressionsUi({ getList: () => charExpressions, onChange: updateExprSummary });
}
