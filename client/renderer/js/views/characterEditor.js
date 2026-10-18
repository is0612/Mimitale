'use strict';

// ============================================================================
//  views/characterEditor.js —— 角色编辑器（视图七的本体）
//
//  一屏编辑「一张角色卡」，两处复用：
//    · 作用域 'library'    改的是角色库里的角色
//    · 作用域 'worldbook'  改的是当前世界书里的那个独立副本（不动角色库）
//  所以这里所有读写都走 editorCharacterById() —— 同一套表单才能编辑两份数据。
//
//  「新建角色」是个**草稿**：它先只活在编辑器里，不进任何列表、也不写磁盘，
//  点了「保存角色」才真正被创建（commitCharDraft）。离开编辑器就等于放弃。
//
//  角色编辑器是主区域里的一屏，走 viewSwitch 的 showView('charEditor')；
//  离开时回到进来之前那一屏（角色库，或从世界书编辑器点进来时的那一屏）。
//  页头的「返回」和 Esc 管离开。
//
//  表单里的改动是「读的时候填进去、保存/切走的时候收回来」（fillCharForm /
//  stashCharForm）—— 中途不写回角色卡，所以填到一半离开不会留下半个改动。
//
//  属性区（字段类型 / 范围 / 分组 / 批量粘贴）搬去了 views/charAttributes.js，
//  它接收本模块的草稿数组（传引用），保存时由本模块一起写回角色卡。
//
//  表情图（几十条的大列表）也搬出去、并单独做了个弹窗：views/charExpressions.js。
//  它同样接收本模块的草稿数组（charExpressions），角色编辑器里只留一行入口 + 已设条数。
//  （那个弹窗是**真的**弹窗 —— 它盖在编辑页上，不改。）
//
//  入口层只从这儿取六样东西：
//    openCharacterEditor / startCharacterDraftInBook / releaseEditorScope /
//    stashCharacterForm / currentEditorCharacter / deleteCharacterById
//  动作注入：rerender（保存和删除之后要全量重绘，那属于入口层的编排）。
// ============================================================================

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
import { currentWorldbook, renderWorldbookChars, focusWorldbook } from './worldbook.js';
import { renderWorldbookPage } from './worldbookList.js';
import { renderCharacterPage } from './characterList.js';
import { renderCharAttrs, initCharAttrsUi } from './charAttributes.js';
import {
  renderCharExpressions,
  draftExpressionsOf,
  initCharExpressionsUi,
  openCharExpressionsEditor,
  closeCharExpressionsEditor,
  expressionsSummaryText
} from './charExpressions.js';
import { openAiGenModal } from './aiGen.js';
import { attachAutoGrow, syncAutoGrowAll } from '../ui/auto-grow.js';
// 组件库：备选开场白那几行是动态铺的，用工厂建多行框（见 components/index.js）
import { mTextarea, hostOf } from '../components/index.js';
import { pickAndCrop } from '../ui/imageCrop.js';
import { initCharacterEditorLayout, showCharacterField, setCharSectionCount, setCharSourceChip, refreshCharSectionCounts } from './characterEditorLayout.js';
export { showCharacterField } from './characterEditorLayout.js';

// ---------------------------------------------------------------------------
//  长文本框：自动增高 + 拖拽高度记忆
//
//  这五个框（描述 / 性格 / 场景 / 开场白 / 示例对话）有时会填很多，
//  固定 rows 的框看不全内容。行为细节都在 ui/auto-grow.js 里，
//  这里只负责「哪些框」和「什么时候重算」。
//
//  key 用**字段名**而不是角色 id：拖高是「我习惯把示例对话拖这么高」，
//  换个角色也该沿用 —— 按角色记的话，每换一张卡都要重拖一遍。
// ---------------------------------------------------------------------------

/** 五个长文本框 + 各自的记忆 key */
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

// ---------------------------------------------------------------------------
//  长文本字段：字数角标
//
//  五个框的高度上限压到 160px 之后（auto-grow 的 GROW_MAX），框矮了，
//  「里面到底写了多少」得有个一眼能看到的信号 —— 角标干这个。
// ---------------------------------------------------------------------------

/**
 * 一个长文本框的字数角标节点（id 约定：宿主 id + `-count`）。
 *
 * ⚙ 组件化之后这个函数会被两种东西叫到：`longTextAreas()` 给的是**宿主**，
 * 而 input 事件委托递过来的是**里层那颗原生框**（id 挂在宿主上，里层那颗没有 id）。
 * 不还原成宿主就会去查 `.getElementById('-count')` —— 查不到，而这里写的是
 * 「找不到角标就静默跳过」，于是角标**再也不刷新**（不报错、没人发现）。
 */
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

/** 刷新全部五个框的角标 + 左栏徽章 + 右栏字段目录（fillCharForm 回填之后用） */
function syncAllCharCounts() {
  for (const [node] of longTextAreas()) updateCharCount(node);
  // 徽章与目录上的字数/已写圆点都从 DOM 现算，回填之后必须补一次
  refreshCharSectionCounts();
}

// ---------------------------------------------------------------------------
//  编辑器的状态
// ---------------------------------------------------------------------------

let editingCharacterId = null; // 角色库里当前正在编辑的角色
// 角色编辑器的作用域：'library' = 角色库；'worldbook' = 当前世界书里的角色副本。
// 同一个编辑器两处复用 —— 从世界书里点「编辑」改的是书里那份副本，不动角色库。
let charEditorScope = 'library';
// 正在编辑的角色头像（dataURL，正方形）。用在消息气泡和状态卡上。
let charDraftAvatar = '';
// 正在编辑的角色形象（dataURL，2:3 竖版）。角色库列表上铺的就是它。
// 三态，保存时必须照原样区分开：
//   · undefined —— 这张卡没单独设过形象。老卡只有一张图（在 avatar 里），
//     界面上先拿头像顶上，保存时**别写这个键**，省得白白多存一份几 MB 的图。
//   · ''        —— 用户明确清掉了形象（列表上就显示首字色块）。
//   · dataURL   —— 有独立形象。
let charDraftPortrait;
// 正在编辑的表情图草稿：[{ name, keywords, image }]。和形象一样是深拷贝 ——
// 编辑期间改了不算数，点「保存角色」才写回卡上（见 draftExpressionsOf）。
let charExpressions = [];
// 正在编辑的「备选开场白」草稿：同一张卡的多个入场剧本（导入卡常带，单卡最多见过 29 条）。
// 和表情图一个套路 —— 编辑期改动只留在数组里，点「保存角色」才写回卡上。
// 上面这些行是动态铺的（条数不定），渲染见 renderAltGreetings。
let charAltGreetings = [];
// 条数上限。和主进程那份（main/characters.js 的 MAX_ALTERNATE_GREETINGS）对齐 ——
// 两边不一致的话，UI 里能加、保存时会被悄悄砍掉，用户会以为丢数据了。
const MAX_ALT_GREETINGS = 50;
// 正在编辑的角色「自带世界书」开关。跟头像一样是草稿：改动先留在这里，
// 保存时才写回角色卡 —— 这样切换开关能立刻反映到界面上。
let charDraftWbEnabled = true;
// 「新建角色」做出来的草稿：它先只活在编辑器里，不进任何列表、也不写磁盘，
// 点了「保存角色」才真正被创建。关掉编辑器就等于放弃这次新建。
let charDraft = null; // { character, scope, bookId }
// 编辑器打开期间的属性草稿，点「保存角色」才写回角色卡（和 charDraftAvatar 一个套路）
let charAttrs = [];
// 角色编辑器里「给角色绑世界书」那个浮层（自己起一个，不复用世界书页的选择器）
let worldbookPickerEl = null;

// 入口层注入的动作
let actions = { rerender: () => {} };

/**
 * 角色编辑器当前能看到的角色列表：角色库，或者某本世界书里的角色副本。
 * 编辑器里所有读写都走这两个函数，副本才能被同一套表单编辑。
 */
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

// ---------------------------------------------------------------------------
//  打开 / 离开
// ---------------------------------------------------------------------------

/**
 * 进来之前停在哪一屏。离开时（返回 / Esc / 保存完自动走）都回到它。
 */
let editorReturnView = 'chars';

function openCharsModal() {
  // 编辑器现在只是「编辑某一个角色」的表单，没有列表了。
  // 谁打开它谁负责先设好 editingCharacterId / charEditorScope。
  // 编辑器的入口指向了别的角色，说明「新建」那个草稿已经被放弃了，顺手清掉。
  if (charDraft && editingCharacterId !== charDraft.character.id) discardCharDraft();

  // 长文本框的接线在 fillCharForm() 里（新建和编辑两条路都经过那儿）

  let current = editorCharacterById(editingCharacterId);

  if (!current) {
    // 兜底：没指定就退回作用域里的第一个（世界书副本也走这里）
    const list = editorCharacterList();
    editingCharacterId = list.length ? list[0].id : null;
    current = editorCharacterById(editingCharacterId);
  }

  // 记下来处。已经在编辑页里就别覆盖 —— 那样「返回」会原地打转，
  // 而这时真正的来处（角色库 / 世界书编辑器）正是该回去的地方。
  const from = currentViewName();
  if (from !== 'charEditor') editorReturnView = from;

  // 先让这一屏可见再填表：fillCharForm 最后会量文本框高度，
  // 而隐藏状态下（display:none）量什么都是 0。
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
        ? `填好内容点「保存角色」才会加进这本书${book ? ` · ${book.name}` : ''}`
        : '填好内容点「保存角色」，保存后才会出现在角色库里';
    } else {
      // 保存状态胶囊（.save-pill）已经会说「有未保存的改动」，这里改成说一件
      // 用户看不出来的事：这几栏写下去会去哪儿。
      el.charsSub.textContent = inBook
        ? `这本书里的独立副本，改它不影响角色库${book ? ` · ${book.name}` : ''}`
        : '描述与性格每轮都会注入给 AI，改完在右上角保存';
    }
  }
  if (el.charCrumb) {
    // 面包屑：角色库 / 名字（世界书作用域标出来处）。textContent，不吃 HTML。
    const character = editorCharacterById(editingCharacterId);
    const name = character ? character.name : el.c.name.value.trim() || '新角色';
    el.charCrumb.textContent = `${inBook ? '世界书' : '角色库'} / ${name}`;
  }
}

/**
 * 离开编辑器：回到进来之前那一屏。
 *
 * 页头的「返回」、Esc、保存完自动走，三条路都走它。
 * 保存、删除、导出之后也调它。
 */
export async function leaveCharacterEditor() {
  // 表情弹窗挂在 body 上、盖着编辑页，编辑页走了不能留着
  closeCharExpressionsEditor();

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
  }

  // 草稿从没进过任何列表，丢掉它不用刷新界面
  // 选书浮层也要一起收掉：它挂在 body 上、z-index 还比编辑页高，
  // 不收就成了悬在屏幕上的孤儿。
  closeWorldbookPicker();
  discardCharDraft();
  // 回到来处；来处是聊天就回聊天（那种情况只可能从别处被程序调起来）
  showView(editorReturnView === 'charEditor' ? 'chars' : editorReturnView);
}

/** 底部提示：跟着编辑器作用域变，免得不知道改的是哪一份 */
function charFootHintText(character) {
  // 还没保存的新角色没什么来源好说的，先提醒它还不存在
  if (isCharDraft()) return '还没保存 · 点右上角「保存角色」才会创建这个角色';
  if (charEditorScope === 'worldbook') return '改的是世界书里的副本，角色库里的那个角色不受影响';
  if (!character) return '角色卡只保存在你自己电脑上';
  if (character.source === 'png') return '来自酒馆 PNG 角色卡';
  if (character.source === 'json') return '来自 JSON 角色卡';
  return '这是你自己写的角色';
}

/** 左栏来源胶囊的短文案（foot 那条是长文案，管两件事） */
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
  if (el.charCrumb) el.charCrumb.hidden = !show;
  if (el.charSaveState) el.charSaveState.hidden = !show;
  if (!show) el.charFootHint.textContent = charFootHintText(null);
}

// ---------------------------------------------------------------------------
//  头像 / 形象
//
//  两张图，各管一处：
//    · 头像（1:1）—— 消息气泡、状态卡、在场角色栏上那个小圆图
//    · 形象（2:3）—— 角色库列表上铺的那张竖版图，点开还能看大图
//  两个上传框都走 ui/imageCrop.js：选完图先框一块，框出来的那块直接就是存下来
//  的图（裁剪组件按目标尺寸输出，这里不再二次缩放）。
// ---------------------------------------------------------------------------

// 头像输出 384×384。小圆图最大也就显示 ~48px（2 倍屏 ≈ 96px），384 已经绰绰有余 ——
// 头像没有「点开放大」的入口，再往上加只是白占体积。
const AVATAR_SIZE = 384;
// 形象输出 1024×1536（2:3 竖版）。列表卡上只有 ~180px 宽，但**点开看大图会铺满窗口**，
// 再小就看出糊了。存的时候按 1.0 的 webp 压（肉眼看不出区别，体积只有 PNG 的 1/3）——
// 这个文件每存一次角色就要整个重写一遍，体积是实打实的成本。
// ⚠️ 2:3 才对应 1024×1536。3:4 在 1024 宽下是 1365 —— 除不尽，存出来永远差那一截。
//    改比例要三处一起改：这里、.char-card-avatar、.char-portrait 的 CSS。
// 另外裁剪组件会按原图实际像素封顶：原图不够大就不硬撑，不会凭空放大出一份糊图。
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

  // 没有图就没有可清除的东西
  el.btnClearAvatar.classList.toggle('hidden', !charDraftAvatar);
  el.btnClearPortrait.classList.toggle('hidden', !draftPortraitImage());
  // 形象还是「沿用的头像」时标记一下 —— 否则用户会以为这张卡本来就有独立形象
  el.charPortrait.classList.toggle('is-inherited', charDraftPortrait === undefined && !!charDraftAvatar);
}

/** 选一张本地图 → 裁剪 → 返回最终 dataURL；取消或出错返回 null（实现在 ui/imageCrop.js） */

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

  // 老卡只有一张图。换头像之前先把旧的留作形象 —— 不留的话，那张立绘就被新头像
  // 顶掉了，形象那一栏从此变成一个 1:1 的小方图，在列表上被拉成竖版。
  if (charDraftPortrait === undefined && charDraftAvatar) charDraftPortrait = charDraftAvatar;

  charDraftAvatar = cropped;
  renderCharMedia();
  showToast('头像已更换，记得点「保存角色」', 'ok');
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
  showToast('形象已更换，记得点「保存角色」', 'ok');
}

function clearAvatar() {
  if (!charDraftAvatar) return;
  charDraftAvatar = '';
  renderCharMedia();
  showToast('头像已清除，记得点「保存角色」');
}

function clearPortrait() {
  if (!draftPortraitImage()) return;
  // 显式写成空串（而不是退回 undefined）：用户点了清除就是不要形象，
  // 不能因为「头像还在」又把头像当成形象显示回来。
  charDraftPortrait = '';
  renderCharMedia();
  showToast('形象已清除，记得点「保存角色」');
}

// ---------------------------------------------------------------------------
//  表情图
//
//  一张卡可以带几十条表情图（名称 + 触发词 + 一张图），编辑在**独立弹窗**里
//  （views/charExpressions.js）—— 几十行塞进这张表单会把文字字段挤没。
//  这里只持有草稿（charExpressions）+ 维护入口那行摘要；点「保存角色」时
//  由 stashCharForm 一起写回卡上。弹窗里改了草稿会经 onChange 回调过来。
// ---------------------------------------------------------------------------

const EXPR_PREVIEW_MAX = 8;

/** 刷新编辑器入口那行「表情图 · 已设 N 条」，同步分区计数，并铺前几张预览 */
function updateExprSummary() {
  if (el.charExprSummary) el.charExprSummary.textContent = expressionsSummaryText(charExpressions);
  // 0 也照显示 —— 藏起来会让人以为「这角色没有表情图这个功能」
  setCharSectionCount('expressions', String(charExpressions.length));
  renderExprPreview();
}

/**
 * 前几张表情的预览网格：点任意一张进管理弹窗（增删改 / 设默认脸都在那边）。
 * 缩略图只读 —— 不想在这里长出第二套编辑交互。
 */
function renderExprPreview() {
  const host = el.charExprPreview;
  if (!host) return;
  clear(host);
  const items = Array.isArray(charExpressions) ? charExpressions : [];
  host.hidden = items.length === 0;
  if (!items.length) return;
  for (const expr of items.slice(0, EXPR_PREVIEW_MAX)) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'char-expr-preview-cell art-edge';
    cell.title = `管理表情图（${expr.name || '未命名'}）`;
    cell.setAttribute('aria-label', `管理表情图（${expr.name || '未命名'}）`);
    if (expr.image) {
      const img = document.createElement('img');
      img.src = expr.image;
      img.alt = '';
      cell.appendChild(img);
    } else {
      cell.textContent = expr.name || '?';
    }
    cell.addEventListener('click', openCharExpressionsEditor);
    host.appendChild(cell);
  }
  if (items.length > EXPR_PREVIEW_MAX) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'char-expr-preview-cell char-expr-preview-more';
    more.textContent = `+${items.length - EXPR_PREVIEW_MAX}`;
    more.title = `还有 ${items.length - EXPR_PREVIEW_MAX} 张，打开管理`;
    more.addEventListener('click', openCharExpressionsEditor);
    host.appendChild(more);
  }
}

// ---------------------------------------------------------------------------
//  表单：填进去 / 收回来
// ---------------------------------------------------------------------------

function fillCharForm(character) {
  if (!character) {
    showCharForm(false);
    return;
  }

  // 进编辑器先清一次草稿残留：形象是「undefined = 沿用头像」的三态，
  // 不清的话上一张卡的草稿会跟着漏进来。
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

  // 长文本框：值刚被程序塞进去，不走 input 事件 —— 所以这里显式重算一次高度。
  // 漏了这一步的表现是「框里明明写着两千字，高度还是两行」，得手动敲一下才展开。
  //
  // ⚠️ 接线必须**在这里**、而不是只在 openCharsModal 里：
  //    新建角色的路径（startCharDraft）是自己调 fillCharForm 的，
  //    不经过 openCharsModal —— 少接一次线的表现是「新建角色时框不会长高」。
  //    attachAutoGrow 自带幂等（认 dataset.autoGrow），重复调用没有代价。
  //
  // ⚠️ 但**量高度不能在这一刻做**：调用方（openCharsModal / startCharDraft）
  //    都还没把弹窗的 .hidden 摘掉，而 display:none 的元素 scrollHeight 是 0 ——
  //    量出来永远是下限 84px。所以这里只接线，真正的重算放在
  //    showCharForm(true) 之后（那时弹窗已经可见）。
  wireAutoGrow();

  // 两张图的草稿在 fillCharForm 里跟着一起重置了，这里只负责画出来
  renderCharMedia();
  // 表情图同理：上面刚深拷贝出新草稿（弹窗里铺），入口那行摘要跟着刷一下
  renderCharExpressions(charExpressions);
  updateExprSummary();

  // 开关的草稿要从这张卡的当前值起算（老数据没这个字段 = 开）
  charDraftWbEnabled = character.worldbookEnabled !== false;

  // 角色自带的世界书：清单 + 绑定按钮 + 开关
  renderCharWorldbookBox(character);

  // 属性：复制一份当草稿，保存时才写回角色卡
  charAttrs = characterAttrs(character);
  renderCharAttrs(charAttrs);

  // 剧情选项：这张卡开没开、给几个、有什么额外要求。
  // ⚠️ 没配过的卡（老卡、导入的卡、新建的草稿）也算**开**，默认 4 条 ——
  // 只有卡上明确写了 `false` 才是关。见 data/suggestions.js 的 optionsSpecFromCharacter。
  const optSpec = optionsSpecFromCharacter(character);
  el.c.optionsOn.checked = !!optSpec;
  el.c.optionsCount.value = String((optSpec && optSpec.count) || DEFAULT_OPTIONS_COUNT);
  el.c.optionsHint.value = optSpec ? optSpec.hint || '' : '';
  renderOptionsConfig();

  // 在状态栏显示（`showInPanel`）：只有**世界书副本**用得上。
  // 角色库的卡是「你自己建来玩的」，绑进单角色会话时永远显示状态 ——
  // 那个开关对它们没意义，整块收起来，免得以为「不勾就没状态」。
  el.c.showInPanel.checked = character.showInPanel === true;
  renderShowInPanelBox();

  el.charFootHint.textContent = charFootHintText(character);

  // 左栏来源胶囊 + 页头保存状态（刚填好的表 = 已保存）
  setCharSourceChip(charSourceChipText(character));
  setCharSaveState('saved');

  showCharForm(true);

  // 长文本框的最后一步：到这儿弹窗才是可见的（上面那些调用方刚摘掉 .hidden），
  // 这时候量高度才量得准。见上面那段注释 —— 在隐藏状态下量会永远得到 84px。
  syncAutoGrowAll(longTextAreas().map((pair) => pair[0]).concat(altGreetTextAreas()));
  // 角标也一样：值是程序塞进去的，得显式刷一次
  syncAllCharCounts();
}

/** 剧情选项的配置区：开关关着就整块收起来（省得看着以为在生效） */
function renderOptionsConfig() {
  if (!el.c.optionsConfig) return;
  el.c.optionsConfig.classList.toggle('hidden', !el.c.optionsOn.checked);
}

/**
 * 「在状态栏显示」这个开关：只给**世界书作用域**用。
 *
 * 角色库的卡绑进单角色会话时，TA 就是这局的主角，状态栏必须显示 ——
 * 那种场景下这个开关没意义，整块收起来（省得用户以为不勾就看不到状态）。
 * 这里按当前编辑作用域（`charEditorScope`）决定显示与否。
 */
function renderShowInPanelBox() {
  if (!el.c.showInPanelBox) return;
  el.c.showInPanelBox.classList.toggle('hidden', charEditorScope !== 'worldbook');
}

// ---------------------------------------------------------------------------
//  角色自带的世界书
// ---------------------------------------------------------------------------

/**
 * 角色自带世界书那一块。
 *
 * 这块**始终显示**：没绑定过的角色也要有入口加书。
 * 没绑定时列出空状态提示，开关和说明照常给（开关此时是隐藏的）。
 */
function renderCharWorldbookBox(character) {
  if (!character) return;

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

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cwb-row-del';
      del.title = '解绑（不会删掉世界书本身）';
      del.setAttribute('aria-label', `解绑 ${book.name}`);
      del.textContent = '✕';
      del.addEventListener('click', () => unbindWorldbookFromCharacter(book.id));

      row.append(name, count, del);
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
  // 刚绑上就默认启用 —— 绑了却因为开关关着不生效，会让人以为是 bug。
  // 草稿开关也要一起改，否则 renderCharWorldbookBox / stashCharForm 还会按旧值
  // 把刚打开的开关写回 false。
  if (character.worldbookEnabled === false && ids.length === 1) {
    character.worldbookEnabled = true;
    charDraftWbEnabled = true;
  }
  character.updatedAt = now();
  renderCharWorldbookBox(character);

  if (isCharDraft()) {
    showToast('已绑定世界书，保存角色后生效');
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

/**
 * 点「＋ 绑定」：列出还没绑的世界书让用户挑。
 *
 * 自己起一个轻量浮层，而不是复用世界书页那个角色选择器 ——
 * 那个是「角色 → 加进世界书」，方向相反，而且绑了一堆模块级状态，
 * 硬套进来会互相干扰。
 */
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

/**
 * 选书浮层开着没有。
 * Esc 链要用：这个浮层**挂在 document.body 上**，而且 z-index(60) 比角色编辑器(50) 还高，
 * 所以按 Esc 时它是「最上面那一层」，该先关它，而不是把整个编辑器一起关掉。
 */
export function isWorldbookPickerOpen() {
  return !!worldbookPickerEl;
}

export function closeWorldbookPicker() {
  if (worldbookPickerEl) {
    worldbookPickerEl.remove();
    worldbookPickerEl = null;
  }
}

// ---------------------------------------------------------------------------
//  草稿 / 保存 / 删除
// ---------------------------------------------------------------------------

/** 把表单里的内容写回内存里的角色对象（切走或保存前调用） */
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
  // 备选开场白：空行直接丢掉（多半是「点了添加又没写」）。
  // 去两端空白 + 去重 + 限条数，口径和主进程的 normalizeAlternateGreetings 一致，
  // 免得 UI 里存的形状和导入卡不一样。
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
  // 年龄/性别/种族不从输入框写回；老卡上已有的字段保留不动
  //（messages.js / cast.js 仍会读）。
  // 属性是编辑期间的草稿（charAttrs），保存时才写回角色卡。
  // 只摘掉界面自己的临时状态（_moreOpen），其余字段原样带走。
  character.attributes = charAttrs
    .filter((a) => a && typeof a.name === 'string' && a.name.trim())
    .map((a) => {
      const out = { ...a, name: a.name.trim().slice(0, 24), value: String(a.value == null ? '' : a.value).slice(0, 500) };
      delete out._moreOpen;
      return out;
    })
    .slice(0, MAX_PANEL_FIELDS);
  character.avatar = charDraftAvatar;
  // 形象是三态，必须原样区分（见 charDraftPortrait 的声明）：
  //   undefined —— 老卡，从头到尾没碰过形象那一栏，别写这个键（写了就白存一份图）。
  //   其余（空串 / dataURL）—— 用户的选择，照写。
  if (charDraftPortrait === undefined) delete character.portrait;
  else character.portrait = charDraftPortrait;
  // 表情图：没名字的条目存下去也匹配不上，直接丢掉；一条不剩就不留这个键
  // （和 portrait 一个思路：空表留在数据里只是噪音）。
  // key / default 只写有值的 —— 落盘归一化本来也会把空的丢掉，这里少写一份更干净。
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
  // 剧情选项：**关掉要写成 `false`**（不是 null）—— 主进程归一化把「没有这个字段」
  // 当成「默认开 4 条」，只有明确的 false 才活得过存盘，否则关掉的角色一重启又开了。
  // 数量夹在 1~6，和注入时用的上限保持一致。
  if (el.c.optionsOn.checked) {
    const rawText = String(el.c.optionsCount.value || '').trim();
    const raw = Number(rawText);
    // 空输入框的 Number('') 是 0，不能让它悄悄变成 1 条；空 = 用默认 4 条
    const count = rawText && Number.isFinite(raw)
      ? Math.max(1, Math.min(6, Math.round(raw)))
      : DEFAULT_OPTIONS_COUNT;
    character.optionsSpec = { count, hint: el.c.optionsHint.value.trim().slice(0, 200) };
  } else {
    character.optionsSpec = false;
  }
  // 角色自带世界书的开关（草稿）。没有绑书时不写这个字段，
  // 免得给没有书的角色平白加一个属性。
  if (Array.isArray(character.worldbookIds) && character.worldbookIds.length) {
    character.worldbookEnabled = charDraftWbEnabled;
  }
  // 在状态栏显示：**只对世界书副本写**。角色库的卡写了也没用（单角色会话
  // 永远显示状态，见 cast.js 的 panelEntities），索性不落这个字段，
  // 免得数据里一片 showInPanel:false 看着像「关了」。
  if (charEditorScope === 'worldbook') {
    character.showInPanel = el.c.showInPanel.checked === true;
  } else {
    delete character.showInPanel;
  }
  character.updatedAt = now();
}

/**
 * 角色列表页的「＋ 新建角色」。
 * 先把作用域钉死在角色库 —— 上一次可能是在世界书里编辑副本，作用域还留着。
 */
function newCharacter() {
  charEditorScope = 'library';
  startCharDraft();
}

/**
 * 新建角色：只做一个「草稿」塞进编辑器给用户填。
 * 保存之前它不进角色库 / 世界书，也不写磁盘；关掉编辑器就当没建过。
 *
 * @param {object} [preset] AI 生成的角色字段（name / description / personality /
 *                 tags / attributes）。填进来之后和用户手填的草稿没有区别 ——
 *                 一样要点「保存角色」才会真正创建。
 */
function startCharDraft(preset) {
  // 上一个角色的表单里可能还有没保存的改动，先收进内存，
  // 再把上一份没保存完的草稿丢掉，免得留下一个永远不会被创建的幽灵角色。
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
    scenario: '',
    firstMes: '',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    tags: Array.isArray(p.tags) ? p.tags : [],
    attributes: Array.isArray(p.attributes) ? p.attributes : [],
    // 年龄/性别/种族不再单独建字段：写进描述文字即可，这里不再预设默认值。
    source: 'manual',
    createdAt: now(),
    updatedAt: now()
  };

  charDraft = { character, scope, bookId: book ? book.id : null };
  editingCharacterId = character.id;

  // 同样要记来处（这条路上「保存角色」是终点，走的时候会回到它）
  const from = currentViewName();
  if (from !== 'charEditor') editorReturnView = from;

  // 先让这一屏可见再填表：fillCharForm 最后会量文本框高度，
  // 而隐藏状态下（display:none）量什么都是 0。
  showView('charEditor');
  fillCharForm(character);
  updateCharEditorScopeUi();

  showCharacterField('c-desc');
  el.c.name.focus();
  el.c.name.select();
}

/**
 * 把新建的草稿真正写进角色库 / 世界书。
 * 只有点「保存角色」会走到这里 —— 这就是「保存后才生成」那一步。
 */
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

  // 必须先校验再落内存：stashCharForm 会把空名字写成「未命名角色」，
  // 放在它后面校验就晚了 —— 弹了提示，内存却已经被改名，列表也没重绘。
  if (!el.c.name.value.trim()) {
    showToast('给角色起个名字吧', 'error');
    el.c.name.focus();
    return;
  }

  // 这一下到底是「新建」还是「改已有的」，要在落盘前记下来：
  // 草稿一提交 charDraft 就清空了，后面就分不出来了。
  const creating = isCharDraft();
  const scope = creating ? charDraft.scope : charEditorScope;

  stashCharForm();

  // 新建的角色到这一刻才真正被创建（进角色库 / 进这本书）
  if (creating && !commitCharDraft()) {
    showToast('这本书已经不在了，角色没能创建', 'error');
    return;
  }

  // 新建的角色：点「保存角色」就是这件事的终点 —— 直接离开编辑页，回到角色列表 /
  // 世界书编辑器看新卡。改已有的角色则留在这一页里（多半还要接着改别的字段）。
  if (creating) {
    renderCharacterPage();
    actions.rerender();
    // 改的是书里的副本，那本书的角色排和世界书列表页也要跟着刷新
    if (scope === 'worldbook') {
      renderWorldbookChars();
      renderWorldbookPage();
    }
    // 写盘失败就别报「已创建」—— 提示已经由 persistCharacters 弹过了，
    // 页面也留着，用户能直接再点一次「保存角色」重试。
    if (!(await persistCharacters())) return;
    setCharSaveState('saved');
    showToast(`角色「${character.name}」已创建`, 'ok');
    // 草稿已经提交（charDraft 清空），这里不会再弹「放弃新建？」那个确认框
    await leaveCharacterEditor();
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

  // 失败提示由 persistCharacters 弹（界面上的改动留着，用户能直接再存一次）；
  // 成功了才报「已保存」—— 两条都弹的话后一条会把前一条盖掉。
  if (await persistCharacters()) {
    setCharSaveState('saved');
    showToast(`角色「${character.name}」已保存`, 'ok');
  }
}

/**
 * 删除一个角色。
 * scope：'library' = 从角色库删掉（默认）；'worldbook' = 只从当前这本书里移除副本。
 *
 * 两个入口共用这一份逻辑：角色卡右上角的 ×，和编辑页底部的「删除角色」。
 *
 * ⚠️ 写盘失败时**要把内存也退回去**，不能只弹个提示就完了。
 *    characters.json 被拒写（EPERM，常见是进程低完整性，见 main/store.js 开头）时，
 *    界面若已经把卡片移掉、还弹了「已删除」，用户会以为删干净了，重启又回来了
 *    （而且中间的会话解绑也白做）。「写不进磁盘 = 没删掉」才和用户看到的一致。
 */
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

  // --- 从角色库删 ---------------------------------------------------------
  // 记住改之前的样子，写盘失败时按这几样退回去
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

  // 编辑器如果正开在这个角色上，就没有可编辑的对象了 —— 离开它。
  // 从卡片删的时候编辑器根本没开，这一段会跳过。
  // 放在写盘成功之后：失败时角色还在，编辑器不该被关掉。
  if (editingCharacterId === character.id) {
    editingCharacterId = null;
    if (currentViewName() === 'charEditor') await leaveCharacterEditor();
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

// ---------------------------------------------------------------------------
//  给入口层 / 别的视图用的口子
// ---------------------------------------------------------------------------

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
 * 用 AI 生成好的字段起草一个新角色，直接打开编辑器让用户过目。
 *
 * 作用域必须在这里钉死：`startCharDraft` 读的是模块内的 `charEditorScope`，
 * 而世界书那条路还要额外把「哪本书」写进 editingWorldbookId —— 生成期间用户
 * 可能已经切到别的书去了，只传 bookId 进来是不够的。
 *
 * @returns {boolean} 编辑器有没有真的打开（书不在了就是 false）
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

// ---------------------------------------------------------------------------
//  开场白模板：一键填进「定场 → 登场 → 留个话头」三段骨架
//
//  这套骨架是从社区角色卡里归纳出来的（抽样 150 张开场白，约九成都是这个形状）：
//  先用一两句把时间、地点、玩家此刻手上在做的事定住；再让角色带着一句**说出口的话**
//  登场；最后把话头交出去 —— 停在只有玩家能接的地方（一个问题，或一个等着他的沉默）。
//
//  它只填空、不做创作：三段用 { } 圈起来当占位，用户一眼看得出哪段还没写。
//  （注意是单花括号 —— 双花括号 {{user}} / {{char}} 才是会被替换的宏，别写混。）
// ---------------------------------------------------------------------------
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
  // 字数角标挂在 charForm 的 input 委托上（见 initCharacterEditor），
  // 直接赋 value 不触发事件 —— 手动派一个，让角标和自动增高自己刷。
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

// ---------------------------------------------------------------------------
//  备选开场白：同一张卡的多个入场剧本
//
//  数据源是角色卡上的 `alternateGreetings`（导出时写回卡里的 `alternate_greetings`）。
//  导入侧（main/card-import.js）把 `alternate_greetings` 和 `group_only_greetings`
//  合并进来；绑定角色时若不止一条，会话页会弹一个选择器让玩家挑。
//
//  这里只做纯文本的增删改：条数不定，所以行由 renderAltGreetings 动态铺，
//  HTML 里只留「列表容器 + 总条数角标 + 添加按钮」三个壳。
//  行上的字少（序号 / 字数 / ×），正文一律走 textContent —— 卡里的字是不可信内容。
// ---------------------------------------------------------------------------

/** 从角色卡里取一份备选开场白的**副本**（编辑期改动不碰原数据） */
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

/** 把草稿铺成行。每次增删都整体重铺 —— 条数少，不值得做增量 diff */
function renderAltGreetings() {
  const list = el.c.altList;
  if (!list) return;

  clear(list);
  charAltGreetings.forEach((text, i) => {
    const ta = mTextarea({
      class: 'alt-greet-text',
      // id 约定见 charCountNode：`<textarea id>-count` 就是它的字数角标，
      // 这样 charForm 的 input 委托能顺手把角标刷掉，不用另接一套。
      // ⚙ 组件化之后 id 挂在**宿主**上，事件里拿到的是里层那颗原生框 ——
      //   所以下面刷新角标时得先过一道 hostOf()（见 updateCharCount 那里）。
      id: `c-alt-${i}`,
      rows: 3,
      spellcheck: 'false',
      placeholder: '第 ' + (i + 1) + ' 个入场剧本：定场 → 登场 → 留个话头',
      value: text,
      dataset: { index: i }
    });
    // 自动增高：不传 key —— 高度记忆是按「字段」记的，而这里行会重排，
    // 记了反而会错位（删掉第 2 行，第 3 行会继承它的高度）。
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
  // ⚙ 组件化之后 `event.target` 是里层那颗原生框：`.alt-greet-text` 与 `data-index`
  //   都在**宿主**上 —— 不还原成宿主，这里会直接 return（静默把改动丢了）。
  const ta = hostOf(event.target);
  if (!ta || !ta.classList || !ta.classList.contains('alt-greet-text')) return;
  const i = Number(ta.dataset.index);
  if (Number.isInteger(i) && i >= 0 && i < charAltGreetings.length) charAltGreetings[i] = ta.value;
  // 字数角标由 charForm 的 input 委托统一刷（靠 id 约定），自动增高由 attachAutoGrow 管。
}

/** 绑编辑器自己的所有按钮。rerender 由入口层注入 */
export function initCharacterEditor(injected) {
  actions = { rerender: () => {}, ...(injected || {}) };
  initCharacterEditorLayout({
    onReveal: () => syncAutoGrowAll(longTextAreas().map((pair) => pair[0]).concat(altGreetTextAreas()))
  });

  el.btnCloseChars.addEventListener('click', leaveCharacterEditor);
  el.btnNewChar.addEventListener('click', newCharacter);
  // 角色列表页的「AI 生成」：作用域同样钉死在角色库，生成结果落到编辑器草稿。
  // 这里直接调 aiGen 的入口 —— 生成弹窗怎么开是它自己的事，没必要经入口层转一手：
  // 那种转手一旦漏传就是「点了没反应」，而且只有真点到这个按钮才会发现。
  if (el.btnAiChar) {
    el.btnAiChar.addEventListener('click', () => {
      charEditorScope = 'library';
      openAiGenModal({ scope: 'library' });
    });
  }
  el.btnSaveChar.addEventListener('click', saveCharacter);
  el.btnDelChar.addEventListener('click', deleteCharacter);

  // 点头像/形象换图，或者清除
  el.charAvatar.addEventListener('click', pickAvatar);
  el.btnClearAvatar.addEventListener('click', clearAvatar);
  el.charPortrait.addEventListener('click', pickPortrait);
  el.btnClearPortrait.addEventListener('click', clearPortrait);

  // 表情图：编辑都在独立弹窗里（加/删/批量导入的按钮接线在 charExpressions 模块内），
  // 这里只接「管理表情图」这个入口。
  if (el.btnManageExpr) el.btnManageExpr.addEventListener('click', openCharExpressionsEditor);

  // 自带世界书的开关：先更新草稿，再按草稿刷新说明文字。
  // 注意不能直接读 editorCharacterById —— 那时角色卡上还是旧值（还没保存），
  // 结果就是「点了开关但说明没变」。
  el.c.wbEnabled.addEventListener('change', () => {
    charDraftWbEnabled = el.c.wbEnabled.checked;
    const character = editorCharacterById(editingCharacterId);
    if (character) {
      updateCharWorldbookHint({ ...character, worldbookEnabled: charDraftWbEnabled });
    }
  });

  // 「＋ 绑定」：挑一本世界书加到这个角色上
  el.c.wbAddBtn.addEventListener('click', openWorldbookPicker);

  // 剧情选项的开关：只切配置区的显示，值在保存时才写回角色卡
  if (el.c.optionsOn) el.c.optionsOn.addEventListener('change', renderOptionsConfig);

  // 「套用开场白模板」：把「定场 → 登场 → 留个话头」三段骨架填进开场白框
  if (el.c.btnFirstTemplate) el.c.btnFirstTemplate.addEventListener('click', applyFirstMesTemplate);

  // 备选开场白：添加按钮 + 列表上的删除/输入（行是动态铺的，所以用委托）
  if (el.c.btnAltAdd) el.c.btnAltAdd.addEventListener('click', addAltGreeting);
  if (el.c.altList) {
    el.c.altList.addEventListener('click', onAltListClick);
    el.c.altList.addEventListener('input', onAltListInput);
  }

  // 字数角标 + 保存状态：手动输入时刷新（回填路径在 fillCharForm 里统一刷过）
  el.charForm.addEventListener('input', (event) => {
    setCharSaveState('dirty');
    // ⚙ 多行框组件化之后 input 有两个来源：真人敲字时 target 是**里层那颗原生框**，
    //    程序派发（比如快捷短语往宿主上 dispatch input）时 target 是**宿主**。
    //    只认 `instanceof HTMLTextAreaElement` 的话后者会被漏掉，角标就停在旧值 ——
    //    这种 bug 没人会立刻发现（界面看着一切正常）。判据写成「它自己就是多行框，
    //    或它的里层控件是多行框」，不写 tagName 字面量。
    const node = event.target;
    if (node instanceof HTMLTextAreaElement || (node && node.control instanceof HTMLTextAreaElement)) {
      updateCharCount(node);
    }
    // 左栏徽章（已写 x/5）与右栏字段目录的字数都跟着输入走，不然它们是开局那一刻的快照
    refreshCharSectionCounts();
  });
  // 勾选框 / 下拉不触发 input，单独挂 change（自带世界书开关、剧情选项、显示状态都走这儿）
  el.charForm.addEventListener('change', () => setCharSaveState('dirty'));

  // 属性区的按钮（分组标签栏是渲染时就带的）
  initCharAttrsUi({ getList: () => charAttrs });

  // 表情弹窗的按钮：草稿仍是本模块的 charExpressions，通过 getList 传过去；
  // 弹窗里改动后经 onChange 回来刷新入口那行摘要。
  initCharExpressionsUi({ getList: () => charExpressions, onChange: updateExprSummary });
}
