'use strict';

// ============================================================================
//  views/castPanel.js —— 右侧常驻的「在场角色」面板
//
//  它和「入口条 + 左下浮动卡」**并存**，三样各管一段：
//    · 入口条（panelUi.js）：消息区上面那一行头像，点开状态卡
//    · 浮动卡（stateCard.js）：拖到任意位置的大卡，看立绘用
//    · 这一栏：常驻在右边，一眼扫完「都有谁、各自几个数」
//  所以这里**只读不写**，也不做编辑 —— 要改数值走状态卡（点一块就开）。
//
//  名单跟入口条共用 panelCastForDisplay()：普通聊天不列「我」，
//  只列真的持有字段的人。
//
//  ⚠️ 脚注那两行「世界书 · 书名 / N 条已触发」是设计稿指定的位置；
//     顶栏只放「第 N 轮 · 用量」。
// ============================================================================

import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { h, clear, button } from '../ui/build.js';
import { mButton } from '../components/index.js';
import { entityTone } from '../ui/avatarTone.js';
import { stateCardPhoto } from '../data/expressions.js';
import { currentScene } from '../data/currentScene.js';
import { persistConversations } from '../data/persist.js';
import { fieldProgress } from '../core/panel-fields.js';
import { panelCastForDisplay, worldbookHitCount } from '../data/cast.js';
import { characterForConvo, convoWorldbookIds, worldbookById } from '../data/library.js';
import {
  convoPanel,
  convoPanelDef,
  convoPanelFields,
  panelFieldName,
  panelFieldOwner,
  appendPanelFields
} from '../data/panel.js';
import { onRefresh, refreshAll } from './refresh.js';
import { openStateCard } from './stateCard.js';

/** 每块最多列几个字段：稿子三张卡分别是 3 / 3 / 2 个字段（好感·警觉·心境 / 好感·好奇·心境 /
 *  好感·态度），所以额度是 3 —— 取 2 的话两颗 meter 就把额度吃光，
 *  「心境 / 态度」这种文本字段永远显示不出来。想全看还是点开卡片。 */
const MAX_FIELDS = 3;

/** 某一个 owner 名下的字段，**有值的排前面**（空字段排在后面容易被额度截掉）；
 *  同为「有值」时**数值条（meter）排在文本前面** —— 稿子的三张卡都是这个顺序
 *  （好感 / 警觉两条 meter 在前，心境 / 态度这类文字在后）；右栏的用途就是
 *  「一眼扫完各自几个数」，数字该先露出来。sort 是稳定的，组内仍按定义顺序。 */
function ownerFields(convo, owner) {
  const panel = convoPanel(convo);
  const keys = convoPanelFields(convo).filter((key) => panelFieldOwner(convo, key) === owner);
  const textOf = (key) => String(panel[key] == null ? '' : panel[key]).trim();
  const isMeter = (key) => {
    const def = convoPanelDef(convo, key);
    return !!(def && def.type === 'meter');
  };
  return keys.slice().sort((a, b) => {
    const byFilled = (textOf(b) ? 1 : 0) - (textOf(a) ? 1 : 0);
    if (byFilled) return byFilled;
    return (isMeter(b) ? 1 : 0) - (isMeter(a) ? 1 : 0);
  });
}

function fieldValueText(convo, key) {
  const value = convoPanel(convo)[key];
  const text = value == null ? '' : String(value).trim();
  return text || '—';
}

/** 带范围的数值字段（meter）在值下面再给一条 3px 的进度条。
 *
 *  ⚠️ 这里**不能**自己 `Number(panel[key])` 算百分比：meter 的值存的是
 *  `"63/100"` 这种「当前/上限」字符串，`Number("63/100")` 是 NaN，进度条会
 *  每条都画不出来。必须和状态卡共用 `fieldProgress`（它会解析斜杠）。 */
function meterBar(convo, key) {
  const def = convoPanelDef(convo, key);
  if (!def || def.type !== 'meter') return null;

  const progress = fieldProgress(convoPanel(convo)[key], def);
  if (!progress) return null;

  const bar = h('div', { class: 'cast-meter' });
  const fill = h('div', { class: 'cast-meter-fill' });
  // 宽度只能算完再写，h() 的 style 参数只能吃整串 —— 这里直接设属性更清楚
  fill.style.width = `${progress.percent}%`;
  bar.appendChild(fill);
  return bar;
}

function cardFor(convo, ent, allowLoose) {
  const photo = ent.card ? stateCardPhoto(convo, ent.card, ent.name, allowLoose) : null;
  const card = h('div', {
    class: ['cast-card', photo && photo.src && 'has-portrait'],
    role: 'button', tabindex: '0',
    'aria-label': `打开${ent.name}的可拖动角色卡`,
    title: `点一下打开「${ent.name}」的可拖动角色卡`
  });
  if (photo && photo.src) {
    card.appendChild(h('div', { class: 'cast-portrait' },
      h('img', { src: photo.src, alt: `${ent.name}立绘`, loading: 'lazy' }),
      photo.label ? h('span', { class: 'cast-expression', text: photo.label }) : null));
  }

  const head = h('div', { class: 'cast-card-head' });
  const avatar = h('span', {
    class: `cast-card-avatar ${entityTone(ent.owner, ent.name)}`
  });
  if (ent.avatar) avatar.appendChild(h('img', { src: ent.avatar, alt: '' }));
  else avatar.textContent = ent.owner === 'player' ? '我' : String(ent.name || '?').slice(0, 1);
  head.appendChild(avatar);

  // 名字 + 身份**两行**（稿子 d-rightrail：`谢临舟` / `掌柜 · 在场`）。
  // ⚠️ 角色卡里没有「身份」这个字段，所以第二行只放得到在场关系（你 / 在场）。
  //    为凑稿子去造一个字段是另一件事 —— 真要做先动角色卡契约。
  const id = h('div', { class: 'cast-card-id' });
  id.appendChild(h('span', { class: 'cast-card-name', text: ent.name }));
  id.appendChild(
    h('span', { class: 'cast-card-role', text: ent.owner === 'player' ? '你' : '在场' })
  );
  head.appendChild(id);
  card.appendChild(head);

  const fields = h('div', { class: 'cast-fields' });
  const keys = ownerFields(convo, ent.owner).slice(0, MAX_FIELDS);
  if (!keys.length) {
    fields.appendChild(
      h('div', { class: 'cast-field' }, h('span', { class: 'cast-field-name', text: '还没有状态字段' }))
    );
  } else {
    for (const key of keys) {
      const row = h('div', { class: 'cast-field' });
      row.appendChild(h('span', { class: 'cast-field-name', text: panelFieldName(key) }));
      // 数值字段的进度条和数值**同一行**（稿子：`好感 ▬▬▬▬ 62`）——
      // 排成下面单独一行会把每块卡片撑高一截，且和稿子对不上。
      const bar = meterBar(convo, key);
      if (bar) row.appendChild(bar);
      row.appendChild(h('span', { class: 'cast-field-value', text: fieldValueText(convo, key) }));
      fields.appendChild(row);
    }
  }
  card.appendChild(fields);

  // 和入口条上的头像同一个动作：点开那张状态卡
  card.addEventListener('click', () => openStateCard(ent.owner));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openStateCard(ent.owner);
    }
  });
  return card;
}

/** 栏头和顶栏入口共享面板原有的 collapsed 状态。 */
function syncCollapseBtn() {
  const panel = el.castPanel;
  if (!panel) return;
  const collapsed = panel.classList.contains('collapsed');
  if (el.btnCastCollapse) {
    const btn = el.btnCastCollapse;
    btn.title = collapsed ? '展开这一栏' : '收起这一栏';
    btn.setAttribute('aria-label', collapsed ? '展开在场角色面板' : '收起在场角色面板');
    btn.setAttribute('aria-expanded', String(!collapsed));
  }
}

export function renderCastPanel() {
  const panel = el.castPanel;
  const host = el.castPanelBody;
  if (!panel || !host) return;

  const convo = activeConvo();
  const entities = convo ? panelCastForDisplay(convo) : [];
  const books = convo ? convoWorldbookIds(convo).map((id) => worldbookById(id)).filter(Boolean) : [];
  // 角色自带的世界书：会话没绑书时生效的就是它 —— 脚注必须标出来源，
  // 否则「这本书是哪来的」在界面上根本看不出来。
  const character = convo ? characterForConvo(convo) : null;
  const charBooks =
    character && Array.isArray(character.worldbookIds)
      ? character.worldbookIds.map((id) => worldbookById(id)).filter(Boolean)
      : [];

  // 有角色、世界书或场景信息时显示。
  const scene = currentScene(convo);
  const show = !!convo && (entities.length > 0 || books.length > 0 || charBooks.length > 0 || scene.length > 0);
  panel.classList.toggle('hidden', !show);
  syncCollapseBtn();
  if (!show) return;

  if (el.castPanelCount) el.castPanelCount.textContent = String(entities.length);

  clear(host);
  const allowLoose = entities.length === 1;
  for (const ent of entities) host.appendChild(cardFor(convo, ent, allowLoose));
  const sceneBlock = h('section', { class: 'current-scene', 'aria-label': '当前场景' },
    h('h3', { text: '当前场景' }));
  if (scene.length) {
    for (const field of scene) sceneBlock.appendChild(h('div', { class: 'scene-field' },
      h('span', { text: field.label }), h('b', { text: field.value })));
    sceneBlock.appendChild(h('small', { class: 'scene-source', text: '来自本局状态字段 · 随剧情更新' }));
  } else {
    sceneBlock.appendChild(h('small', { class: 'scene-source', text: '尚无场景信息。启用后，模型将尝试随剧情更新地点、时间与天气。' }));
    const enable = mButton({
      variant: 'ghost',
      size: 'sm',
      text: '启用场景追踪',
      onClick: () => {
        appendPanelFields(convo, ['地点', '时间', '天气'].map(name => ({
          name, value: '', owner: 'player', group: '当前场景', type: 'text', mode: 'dynamic',
          hint: '只记录剧情明确给出的当前场景信息；不确定时保留原值，不编造。'
        })));
        persistConversations(0);
        refreshAll();
      }
    });
    const tracking = convoPanelFields(convo).some(key => (convoPanelDef(convo, key) || {}).group === '当前场景');
    if (!tracking) sceneBlock.appendChild(enable);
    else sceneBlock.appendChild(h('small', { class: 'scene-source', text: '场景追踪已启用，等待下一次回复提供信息。' }));
  }
  host.appendChild(sceneBlock);

  if (el.castFootBook) {
    if (books.length) {
      el.castFootBook.textContent = `世界书 · ${books.map((b) => b.name).join('、')}`;
    } else if (charBooks.length) {
      const names = charBooks.map((b) => b.name).join('、');
      el.castFootBook.textContent =
        character.worldbookEnabled === false
          ? `世界书 · ${names}（已关掉）`
          : `世界书 · ${names}（角色自带）`;
    } else {
      // 一本都没有就空着 —— 与其写一句「没有绑定世界书」占着脚注，不如什么都不说
      el.castFootBook.textContent = '';
    }
  }

  // 「N 条已触发」：稿子脚注那颗绿字。
  // ⚠️ 它要跑一趟主进程（worldbooks:preview 是按关键词现场扫的），所以是**异步**的。
  //    先把这一格清空，避免上一个会话的数字挂在新的会话上；
  //    回来之后再用 token 确认「这仍然是最新那次查询」——切会话快的时候会有迟到的响应。
  renderHitCount(convo, books.length > 0 || charBooks.length > 0);
}

let hitToken = 0;

function renderHitCount(convo, hasBook) {
  const node = el.castFootHit;
  if (!node) return;
  node.textContent = '';
  if (!convo || !hasBook) return;

  const token = ++hitToken;
  worldbookHitCount(convo)
    .then((n) => {
      if (token !== hitToken) return;
      // 0 和「数不出来」要分开说：前者是关键词没命中（值得去改关键词），
      // 后者是这一趟没问到（别拿它误导人）。
      node.textContent = n == null ? '' : n > 0 ? `${n} 条已触发` : '本轮没触发';
    })
    .catch(() => {
      /* worldbookHitCount 自己已经吞了错，这里只是别让 unhandled rejection 出来 */
    });
}

export function initCastPanel() {
  onRefresh(renderCastPanel);

  const togglePanel = () => {
    if (!el.castPanel) return;
    el.castPanel.classList.toggle('collapsed');
    syncCollapseBtn();
  };
  if (el.btnCastCollapse) el.btnCastCollapse.addEventListener('click', togglePanel);
  syncCollapseBtn();
}
