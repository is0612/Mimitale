'use strict';

// 「状态卡」：浮在对话上的属性卡，可拖。一张卡 = 某个人（owner）的状态字段；位置 / 开合 /
// 编辑态挂在 openCards 上，**不落盘**。⚠️ 必须浮动：固定右栏会让对话区永久少 300px。

import { el } from '../core/dom.js';
import { activeConvo, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { h, button, clear } from '../ui/build.js';
import { entityTone } from '../ui/avatarTone.js';
import { fieldProgress, groupPanelFields } from '../core/panel-fields.js';
import {
  convoPanel,
  convoPanelDef,
  convoPanelDefs,
  convoPanelFields,
  panelFieldAllowed,
  panelFieldGroup,
  panelFieldName,
  panelFieldOwner,
  setPanelField,
  appendPanelFields
} from '../data/panel.js';
import { panelEntities } from '../data/cast.js';
import { stateCardPhoto } from '../data/expressions.js';
import { persistConversations } from '../data/persist.js';
import { onRefresh, refreshAll } from './refresh.js';
// 组件库：编辑行里的输入框（见 components/index.js）；hostOf 用来把里层 input 还原成宿主
import { mInput, hostOf } from '../components/index.js';

// 卡片尺寸常量：定位和「并排铺开」都按这几个数算，改宽度要一起改。320 是为了铺得下角色图。
const CARD_W = 320;
const CARD_GAP = 12;
const EDGE = 20;      // 离对话列左右边缘至少留这么多
const TOP = 130;      // 第一排的 y：正好落在入口条下面，不压住标题
const ROW_STEP = 320; // 换行时往下错这么多（不是整屏，上一排还露着一点）

// owner -> { open, editing, x, y, z, slot, moved }；只是「此刻怎么摆」，不落盘。
const openCards = new Map();
// 上面这批卡属于哪个会话 —— 换会话一律清掉（卡里的字段是那一局的）
let cardsConvoId = null;
// 拖动 / 点击时把卡片提到最前
let topZ = 1;

/** 这张卡头上该铺哪张图：有表情表就按最近几条助手回复挑，挑不到就铺角色形象。allowLoose
 *  只在场上就他一个角色时开（正文常写「她脸红了」不带名字，多个人就必须点名）。 */
function cardPhoto(convo, entity, charCount) {
  if (!entity || !entity.card) return { src: '', label: '' };
  const allowLoose = entity.kind === 'character' && charCount <= 1;
  return stateCardPhoto(convo, entity.card, entity.name, allowLoose);
}

/** 某个人拥有的字段（按面板里的先后顺序）。返回的是复合键。 */
function ownerFields(convo, owner) {
  return convoPanelFields(convo).filter((key) => panelFieldOwner(convo, key) === owner);
}

/** 换会话就把开着的卡收掉 —— 卡里是上一局的字段 */
function syncCardsForConvo(convo) {
  const id = convo ? convo.id : null;
  if (id === cardsConvoId) return;
  cardsConvoId = id;
  openCards.clear();
}

// 自动落点：并排铺开，不互相压

/** 一行的实际步进：取现在场上最高的那张卡 + 间距。⚠️ 不能写死成 ROW_STEP —— 卡片高度
 *  跟着字段走，行距比卡片矮时两张卡会上下叠着压一起。量不到就退回默认值。 */
function rowStep() {
  const host = el.stateCards;
  if (!host) return ROW_STEP;
  let tallest = 0;
  for (const card of host.children) {
    const h = card.getBoundingClientRect().height;
    if (h > tallest) tallest = h;
  }
  return Math.max(ROW_STEP, Math.round(tallest) + CARD_GAP);
}

/** 第 index 张卡的落点：整卡宽 + 间距横向铺开，一行装不下才换行；从右往左铺（右边最不挡字）。
 *  @param {number} index 这张卡占的位（0 是第一张） */
function layoutSideBySide(index) {
  const host = el.stateCards;
  const w = host && host.clientWidth ? host.clientWidth : 900;

  const usable = Math.max(CARD_W, w - EDGE * 2);
  // 一行能放几张。至少 1（窄窗口时允许超出，用户可以拖）
  const perRow = Math.max(1, Math.floor((usable + CARD_GAP) / (CARD_W + CARD_GAP)));
  const col = index % perRow;
  const row = Math.floor(index / perRow);

  const x = Math.max(EDGE, w - EDGE - CARD_W - col * (CARD_W + CARD_GAP));
  const y = TOP + row * rowStep();
  return { x, y };
}

/** 找一个**没人占**的位子。⚠️ 不能直接用 `openCards.size` —— 关掉中间那张再开新的会撞号，
 *  两张卡叠在同一个落点上。这里挑最小的空位，既不会撞，也不让已有卡位移。 */
function nextSlot() {
  const used = new Set();
  for (const state of openCards.values()) used.add(state.slot);
  let i = 0;
  while (used.has(i)) i += 1;
  return i;
}

/** 打开某个人的状态卡（已经开着就提到最前面） */
export function openStateCard(owner) {
  const convo = activeConvo();
  if (!convo || !owner) return;

  const state = openCards.get(owner);
  if (state) {
    state.open = true;
    state.editing = false;
    state.z = ++topZ;
  } else {
    const slot = nextSlot();
    openCards.set(owner, {
      open: true,
      editing: false,
      slot,
      // moved: 用户拖过之后就不再用自动落点（下次重绘回到他放的地方）
      moved: false,
      ...layoutSideBySide(slot),
      z: ++topZ
    });
  }
  cardsConvoId = convo.id;
  renderStateCards();
}

/** 收掉整张卡（卡片上的 ✕）。字段本身不动，只是不在这里显示了。 */
function closeStateCard(owner) {
  if (!openCards.has(owner)) return;
  openCards.delete(owner);
  renderStateCards();
}

/** 把一张卡在「展开 / 收起」之间翻面。收起只是一行标题，卡片不会消失。 */
function toggleStateCard(owner) {
  const state = openCards.get(owner);
  if (!state) return;
  state.open = !state.open;
  // 收起时退出编辑态：下次展开回来是干净的只读态，不会一打开就是一排输入框
  if (!state.open) state.editing = false;
  renderStateCards();
}

/** 顶部的批量开关：只要还有一张是展开的，就全部收起；否则全部展开。 */
function setAllStateCards(open) {
  let changed = false;
  for (const state of openCards.values()) {
    if (state.open !== open) {
      state.open = open;
      changed = true;
    }
    if (!open) state.editing = false;
  }
  if (changed) renderStateCards();
}

/** 点卡片自身时提到最前 */
function bringToFront(owner) {
  const state = openCards.get(owner);
  if (state) state.z = ++topZ;
}

// 画三种行

/** 只读行：字段名 + 值（数值补进度条）。这是卡片的默认样子。 */
function viewRow(convo, key) {
  const name = panelFieldName(key);
  const value = String(convoPanel(convo)[key] == null ? '' : convoPanel(convo)[key]);
  const row = h(
    'div',
    { class: 'sc-row' },
    h('span', { class: 'sc-name', text: name, title: name }),
    h('span', { class: 'sc-value', text: value || '—', title: value })
  );

  const progress = fieldProgress(value, convoPanelDef(convo, key));
  if (progress) {
    row.classList.add('has-bar');
    const bar = h('div', { class: 'sc-bar' }, h('div', { class: 'sc-bar-fill' }));
    bar.querySelector('.sc-bar-fill').style.width = `${progress.percent}%`;
    row.appendChild(bar);
  }
  return row;
}

/** 编辑行：值变成输入框，右边一个删除。改完走 setPanelField（和面板同一条路）。 */
function editRow(convo, key) {
  const name = panelFieldName(key);
  // 28px + 正文级字号正好是组件的 size="sm" 档
  const input = mInput({
    class: 'sc-input',
    size: 'sm',
    value: String(convoPanel(convo)[key] == null ? '' : convoPanel(convo)[key]),
    'aria-label': name
  });
  input.addEventListener('input', () => {
    clearTimeout(input._scTimer);
    input._scTimer = setTimeout(() => setPanelField(convo, key, input.value), 400);
  });
  input.addEventListener('blur', () => {
    clearTimeout(input._scTimer);
    setPanelField(convo, key, input.value);
  });

  return h(
    'div',
    { class: 'sc-row editing' },
    h('span', { class: 'sc-name', text: name, title: name }),
    input,
    button({
      class: 'sc-del',
      text: '✕',
      title: '从状态里删掉这个字段',
      onClick: () => removeField(convo, key)
    })
  );
}

/** 编辑态底部：加一个新字段 */
function addRow(convo, owner) {
  const input = mInput({
    class: ['sc-input', 'sc-new'],
    size: 'sm',
    placeholder: '新字段名',
    'aria-label': '新字段名'
  });

  const tryAdd = () => {
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }

    if (!panelFieldAllowed(name)) {
      showToast(`「${name}」是状态栏的保留字段名，换一个吧`, 'error');
      input.focus();
      return;
    }

    // 同一个人身上字段名唯一；不同 owner 可以有同名字段，但在这张卡里手动加一个别人占用的
    // 名字会分不清是哪一份，所以拦下来并说清原因。
    const holders = convoPanelFields(convo).filter((key) => panelFieldName(key) === name);
    if (holders.some((key) => panelFieldOwner(convo, key) === owner)) {
      showToast(`这张卡里已经有「${name}」了`, 'error');
      input.focus();
      return;
    }
    if (holders.length) {
      const whose = panelFieldOwner(convo, holders[0]) === 'player' ? '你自己那边' : '角色那边';
      showToast(`「${name}」已经被${whose}占了（同名只能有一个）—— 换个名字，比如「我的${name}」`, 'error');
      input.focus();
      return;
    }

    appendPanelFields(convo, [{ name, value: '', owner }]);
    // 加完清空并失焦：否则「值输入框有焦点就不重建」的重绘保护会挡掉这次刷新。
    input.value = '';
    input.blur();
    persistConversations(0);
    renderStateCards();
    refreshAll();
  };

  const add = button({
    class: 'sc-add-btn',
    text: '＋ 添加',
    title: '加一个状态字段',
    onClick: tryAdd
  });

  // 回车即添加
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      tryAdd();
    }
  });

  return h('div', { class: 'sc-add' }, input, add);
}

function removeField(convo, key) {
  convo.panelFields = convoPanelFields(convo).filter((n) => n !== key);
  const panel = { ...convoPanel(convo) };
  delete panel[key];
  convo.panel = panel;
  const defs = { ...convoPanelDefs(convo) };
  delete defs[key];
  convo.panelDefs = defs;
  convo.updatedAt = now();
  persistConversations(0);
  renderStateCards();
  refreshAll();
}

// 拖动

/** 把卡片头部做成拖动把手。⚠️ 拖动期间**只改 style.left/top，不重绘** —— 重绘会重建 DOM，
 *  指针捕获和这次拖动就断了（表现是「拖一下就脱手」）。松手才写回 state.x / state.y。 */
function wireDrag(card, head, state) {
  head.addEventListener('pointerdown', (event) => {
    // 卡片头部里的按钮（编辑 / 收起 / ✕）不参与拖动
    if (event.target.closest('button')) return;
    event.preventDefault();
    bringToFront(card.dataset.owner);
    card.style.zIndex = String(topZ);

    const startX = event.clientX;
    const startY = event.clientY;
    const originX = state.x;
    const originY = state.y;

    head.setPointerCapture(event.pointerId);

    const move = (e) => {
      const host = el.stateCards;
      const maxX = Math.max(0, (host ? host.clientWidth : 0) - 60);
      const maxY = Math.max(0, (host ? host.clientHeight : 0) - 40);
      state.x = Math.max(-card.offsetWidth + 60, Math.min(maxX, originX + (e.clientX - startX)));
      state.y = Math.max(0, Math.min(maxY, originY + (e.clientY - startY)));
      // 拖过之后就不再用自动落点，位置一直跟着他放的地方
      state.moved = true;
      card.style.left = `${state.x}px`;
      card.style.top = `${state.y}px`;
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
    };

    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
}

// 画卡片

function buildCard(convo, entity, state, charCount) {
  const owner = entity.owner;
  const name = entity.name || owner;

  const card = h('div', { class: `state-card${state.open ? ' open' : ''}` });
  card.dataset.owner = owner;
  card.style.left = `${state.x}px`;
  card.style.top = `${state.y}px`;
  card.style.zIndex = String(state.z || 1);
  card.addEventListener('pointerdown', () => bringToFront(owner));

  const avatar = h('span', { class: `sc-avatar ${entityTone(owner, name)}` });
  if (entity && entity.avatar) {
    avatar.appendChild(h('img', { src: entity.avatar, alt: '' }));
  } else {
    avatar.textContent = owner === 'player' ? '我' : String(name || '').slice(0, 1) || '?';
  }

  // 头部按钮随开合变：收起态两枚、展开三枚；浮卡宽度有限，再多名字就被挤成省略号。
  const headBits = [
    avatar,
    h('span', { class: 'sc-title', text: name, title: name }),
    state.open
      ? button({
          class: 'sc-edit',
          text: state.editing ? '完成' : '编辑',
          title: state.editing ? '退出编辑（回到只读展示）' : '编辑这张卡（默认只读）',
          onClick: () => {
            state.editing = !state.editing;
            renderStateCards();
          }
        })
      : null,
    button({
      class: 'sc-toggle',
      text: state.open ? '收起' : '展开',
      title: state.open ? '收起这张卡（只留一行标题）' : '展开这张卡看状态',
      onClick: () => toggleStateCard(owner)
    }),
    button({
      class: 'sc-close',
      text: '✕',
      title: '关闭这张状态卡',
      onClick: () => closeStateCard(owner)
    })
  ].filter(Boolean);

  const head = h('div', { class: 'sc-head' }, ...headBits);
  card.appendChild(head);
  // 头部就是拖动把手
  wireDrag(card, head, state);

  // 收起时只画标题行，图和字段连 DOM 都不生成。
  if (!state.open) return card;

  // 角色图横铺在标题下；表情命中时右下角挂标签写表情名。
  const photo = cardPhoto(convo, entity, charCount);
  if (photo.src) {
    const wrap = h('div', { class: 'sc-photo art-edge' }, h('img', { src: photo.src, alt: '' }));
    if (photo.label) wrap.appendChild(h('span', { class: 'sc-photo-tag', text: photo.label }));
    card.appendChild(wrap);
  }

  const body = h('div', { class: 'sc-body' });
  const fields = ownerFields(convo, owner);
  if (!fields.length) {
    body.appendChild(
      h('div', {
        class: 'sc-empty',
        text: state.editing ? '还没有字段，在下面加一个' : '还没有状态字段 —— 点「编辑」可以加'
      })
    );
  } else {
    // 按分组铺（和面板同一套分组键）；有分组的先给小标题，没分组的直接铺。
    const buckets = groupPanelFields(fields.map((name) => ({ name, group: panelFieldGroup(convo, name) })));
    for (const bucket of buckets) {
      if (bucket.id) {
        body.appendChild(h('div', { class: 'sc-group-title', text: bucket.id, title: bucket.id }));
      }
      for (const { name } of bucket.fields) {
        body.appendChild(state.editing ? editRow(convo, name) : viewRow(convo, name));
      }
    }
  }
  if (state.editing) body.appendChild(addRow(convo, owner));
  card.appendChild(body);
  return card;
}

/** 重画所有开着的卡（登记在刷新总线上）。卡片里正有**值输入框**在编辑时不重建 DOM，
 *  否则每敲一个字都会断光标。⚠️ 只挡值输入框：底部「新字段名」框不挡，否则加完不显示。 */
export function renderStateCards() {
  const host = el.stateCards;
  if (!host) return;

  const convo = activeConvo();
  syncCardsForConvo(convo);

  const active = document.activeElement;
  // 组件化后焦点落在里层原生 input 上，类挂在宿主上；只查 active.classList 会永远判 false。
  const activeHost = hostOf(active);
  const typingValue =
    active &&
    active.tagName === 'INPUT' &&
    activeHost &&
    activeHost.classList.contains('sc-input') &&
    !activeHost.classList.contains('sc-new') &&
    host.contains(activeHost);
  if (typingValue) return;

  clear(host);
  if (!convo || !openCards.size) {
    syncBatchButton();
    return;
  }

  // 已经不在场的人收掉那张卡。player 永远在 panelEntities 里，所以删角色字段就会关掉它的卡（合理）。
  const entities = panelEntities(convo);
  const live = new Set(entities.map((e) => e.owner));
  for (const owner of [...openCards.keys()]) {
    if (!live.has(owner)) openCards.delete(owner);
  }
  if (!openCards.size) {
    syncBatchButton();
    return;
  }

  // 铺的顺序按 panelEntities(convo)：玩家永远第一，后面按出场顺序。**不用 openCards 的插入
  // 顺序** —— 那样点了谁谁就跳到前面。charCount 只有一个人时，表情匹配可以不要求点名。
  const charCount = entities.filter((e) => e.kind === 'character').length;

  for (const entity of entities) {
    const state = openCards.get(entity.owner);
    if (state) host.appendChild(buildCard(convo, entity, state, charCount));
  }
  syncBatchButton();
}

/** 批量开关的文案：只要还有一张是展开的，按钮给的就是「全部收起」。 */
function syncBatchButton() {
  const btn = el.btnCardsAll;
  if (!btn) return;
  const anyOpen = [...openCards.values()].some((s) => s.open);
  btn.textContent = anyOpen ? '全部收起' : '全部展开';
  btn.title = anyOpen ? '把在场角色都收成一行' : '把在场角色都展开看状态';
}

/** 登记重绘 + 绑批量开关。由 main.js 的 registerRefreshListeners() 调用。 */
export function initStateCards() {
  onRefresh(renderStateCards);
  if (el.btnCardsAll) {
    el.btnCardsAll.addEventListener('click', () => {
      const anyOpen = [...openCards.values()].some((s) => s.open);
      setAllStateCards(!anyOpen);
    });
  }
}
