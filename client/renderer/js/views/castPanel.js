'use strict';

//  views/castPanel.js —— 右侧常驻的「在场角色」面板，只读不写；改数值走状态卡。
//  与入口条（panelUi.js）、浮动卡（stateCard.js）并存，三样各管一段。
//  ⚠️ 脚注「世界书 · 书名 / N 条已触发」是设计稿指定的位置；顶栏只放「第 N 轮 · 用量」。

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

/** 每块最多 3 个字段：取 2 的话两颗 meter 就把额度吃光，文本字段永远显示不出来。 */
const MAX_FIELDS = 3;

/** 有值的排前面；同为有值时 meter 排在文本前面。sort 是稳定的，组内仍按定义顺序。 */
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

/** meter 的进度条。
 *  ⚠️ 必须和状态卡共用 fieldProgress：值是 `"63/100"` 这种字符串，`Number()` 是 NaN。 */
function meterBar(convo, key) {
  const def = convoPanelDef(convo, key);
  if (!def || def.type !== 'meter') return null;

  const progress = fieldProgress(convoPanel(convo)[key], def);
  if (!progress) return null;

  const bar = h('div', { class: 'cast-meter' });
  const fill = h('div', { class: 'cast-meter-fill' });
  // h() 的 style 只能吃整串，宽度算完直接设属性
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

  // ⚠️ 第二行只放得到在场关系（你 / 在场）：角色卡里没有「身份」这个字段。
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
      // 进度条和数值同一行：排成单独一行会把卡片撑高一截。
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
  // 脚注必须标出来源（会话绑的 / 角色自带的），否则看不出这本书是哪来的。
  const character = convo ? characterForConvo(convo) : null;
  const charBooks =
    character && Array.isArray(character.worldbookIds)
      ? character.worldbookIds.map((id) => worldbookById(id)).filter(Boolean)
      : [];

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
    // 字段种进去但还没值：说明"已启用"和"尚无信息"不能同时说，
    // 否则用户以为按钮没生效（两句话一起出现就是那个观感）。
    const tracking = convoPanelFields(convo).some((key) => (convoPanelDef(convo, key) || {}).group === '当前场景');
    if (tracking) {
      sceneBlock.appendChild(h('small', { class: 'scene-source', text: '场景追踪已启用，等待下一次回复提供信息。' }));
    } else {
      sceneBlock.appendChild(h('small', { class: 'scene-source', text: '尚无场景信息。启用后，模型将尝试随剧情更新地点、时间与天气。' }));
      sceneBlock.appendChild(mButton({
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
      }));
    }
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

  // ⚠️ 这一格是异步的：先清空，免得上一个会话的数字挂在新的会话上；
  //    回来后用 token 确认仍是最新的那次查询 —— 切会话快时会有迟到的响应。
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
      // 0（关键词没命中）和 null（这趟没问到）要分开说，别拿后者误导人。
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
