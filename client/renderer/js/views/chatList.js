'use strict';

// 左侧会话列表 + 右上角的模型切换。
// 「绑定角色」也在这儿：它本质和切模型是同一类事（改当前会话用谁）。

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo, now, asArray } from '../core/util.js';
import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { pickFromList } from '../ui/pickList.js';
import { h, button, clear } from '../ui/build.js';
import { closeModelMenu } from '../ui/modelMenu.js';
import { entityTone } from '../ui/avatarTone.js';
import { providers, providerById, currentEndpoint, isBridgeProvider } from '../data/providers.js';
import { characterById, worldbookById, convoWorldbookIds } from '../data/library.js';
import { seedIdentity, seedPanelFromCharacters } from '../data/panel.js';
import { applyMacros } from '../data/messages.js';
import { convoUserName } from '../data/cast.js';
import { persistConversations } from '../data/persist.js';
import { optionsSpecFromCharacter } from '../data/suggestions.js';
import { renderHeader } from './header.js';
import { renderAll } from './redraw.js';
import { switchConvo, removeConvo } from './convoActions.js';

function storyPreview(convo) {
  const messages = Array.isArray(convo.messages) ? convo.messages : [];
  const last = [...messages].reverse().find((message) => message && ['user', 'assistant'].includes(message.role) && String(message.content || '').trim());
  if (!last) return '故事，等待续写';
  return String(last.content).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<[^>]*>/g, '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70) || '故事，等待续写';
}

export function renderConvoList() {
  clear(el.convoList);

  const list = Array.isArray(state.conversations) ? state.conversations : [];

  if (el.convoCap) el.convoCap.textContent = `故事记录 · ${list.length}`;

  if (!list.length) {
    const empty = h('div', {
      class: 'convo-title',
      text: '（还没有会话）'
    });
    empty.style.padding = '8px 9px';
    empty.style.color = 'var(--text-faint)';
    el.convoList.appendChild(empty);
    renderRailAvatar();
    return;
  }

  for (const convo of list) {
    const label = convo.title || '新对话';

    el.convoList.appendChild(
      h(
        'div',
        {
          class: ['convo-item', convo.id === state.activeId && 'active'],
          role: 'listitem',
          title: label,
          'aria-label': `打开故事：${label}`,
          tabindex: '0',
          onkeydown: (event) => {
            // 内嵌删除按钮保留原生 Enter/Space 激活，不能被父条目抢走。
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              switchConvo(convo.id);
            }
          },
          onclick: () => switchConvo(convo.id)
        },
        convoAvatar(convo),
        h('span', { class: 'convo-story-text' },
          h('span', { class: 'convo-title', text: label, title: label }),
          h('small', { class: 'convo-preview', text: storyPreview(convo) })),
        h('span', { class: 'convo-time', text: convoTimeLabel(convo.updatedAt) }),
        button({
          class: 'convo-del',
          text: '×',
          title: '删除这个会话',
          ariaLabel: `删除会话：${label}`,
          onClick: (event) => {
            event.stopPropagation();
            removeConvo(convo.id);
          }
        })
      )
    );
  }

  renderRailAvatar();
}

/** ⚠️ 复用 convoAvatar() 的产物（同一套 entityTone）：否则同一个人列表里绿的、图标轨里变主色。 */
function renderRailAvatar() {
  const host = el.railAvatar;
  if (!host) return;

  const convo = activeConvo();
  const node = convo ? convoAvatar(convo) : null;

  host.className = 'rail-avatar';
  host.textContent = '';
  host.removeAttribute('title');
  if (!node) return;

  for (const cls of String(node.className || '').split(/\s+/)) {
    if (cls && cls !== 'convo-avatar') host.classList.add(cls);
  }
  if (node.title) host.title = node.title;
  const img = node.querySelector('img');
  if (img) host.appendChild(h('img', { src: img.getAttribute('src'), alt: '' }));
  else host.textContent = node.textContent;
}

/** 条目左边的小圆头像：绑了角色 → 角色头像；世界书会话 → 书名首字（方角）；都没有 → 会话标题首字（中性色）。 */
function convoAvatar(convo) {
  const char = convo.characterId ? characterById(convo.characterId) : null;
  if (char) {
    const node = h('span', {
      class: `convo-avatar ${entityTone(char.id, char.name)}`,
      title: char.name
    });
    if (char.avatar) node.appendChild(h('img', { src: char.avatar, alt: '' }));
    else node.textContent = String(char.name || '').slice(0, 1) || '?';
    return node;
  }

  const wbId = convoWorldbookIds(convo)[0] || '';
  const wb = wbId ? worldbookById(wbId) : null;
  if (wb) {
    return h('span', {
      class: `convo-avatar book ${entityTone(wb.id, wb.name)}`,
      text: String(wb.name || '').slice(0, 1) || '世',
      title: wb.name
    });
  }

  const title = String(convo.title || '').trim();
  return h('span', {
    class: 'convo-avatar plain',
    text: title ? title.slice(0, 1) : '·',
    title: title || '空对话'
  });
}

/** 条目右端的时间看**日历位置**不是时长：今天 `14:03` / 昨天 / 周三（七天内）/ `10-08`。 */
function convoTimeLabel(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // ⚠️ 减天数走 Date 构造器，不要减 86400000：夏令时那天不是 24 小时，「昨天」会判错。
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const startOfSixDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  if (t >= startOfToday) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (t >= startOfYesterday) return '昨天';
  if (t >= startOfSixDaysAgo) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 当前端点的 `服务商id::模型名`，没选就空串（和选项的 value 同一套写法） */
function modelChoiceValue() {
  const endpoint = currentEndpoint();
  if (!endpoint || !endpoint.provider || !endpoint.model) return '';
  return `${endpoint.provider.id}::${endpoint.model}`;
}

/** ⚠️ SVG 必须走 createElementNS：h() 是 createElement，建出来只是「名叫 svg 的普通元素」，根本不画。 */
function checkIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'model-menu-check');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'm4 12.5 5.5 5.5L20 6.5');
  svg.appendChild(path);
  return svg;
}

/** 分组小标题：服务商名，没填 Key 的标出来（本机桥接免 Key，别误标） */
function modelGroupLabel(p) {
  return isBridgeProvider(p) || p.apiKey ? p.name : `${p.name}（未填 Key）`;
}

/** 上一次铺出来的「内容指纹」—— 没变就不重建 DOM（见 renderModelSwitch） */
let lastModelSwitchSignature = null;

/**
 * 右上角切换模型（开合逻辑在 ui/modelMenu.js，这里只铺内容）。
 * ⚠️ 挂在刷新总线上（发消息、点状态卡都会喊一遍）：先算内容指纹，没变就直接返回。
 */
export function renderModelSwitch() {
  const trigger = el.modelSwitch;
  const menu = el.modelMenu;
  if (!trigger || !menu) return;

  const label = el.modelSwitchLabel;
  const endpoint = currentEndpoint();
  const list = providers();
  const active = modelChoiceValue();
  const scrollTop = menu.scrollTop;

  // 指纹要盖住所有影响输出的东西（当前选中 + 分组标题 + 每组模型列表）；标题直接用最终文案。
  const signature = [
    active,
    list.map((p) => `${p.id}~${modelGroupLabel(p)}~${asArray(p.models).join(',')}`).join('|')
  ].join('\u0000');
  if (signature === lastModelSwitchSignature) return;
  lastModelSwitchSignature = signature;

  if (label) {
    label.textContent = endpoint && endpoint.model
      ? endpoint.model
      : list.length
        ? '选择模型'
        : '未配置模型';
  }
  trigger.title = `切换当前会话使用的模型（当前：${label ? label.textContent : '未选'}）`;

  clear(menu);

  if (!list.length) {
    menu.appendChild(h('div', { class: 'model-menu-empty', text: '还没有配置模型服务 —— 点左下角「设置」' }));
    trigger.disabled = true;
    closeModelMenu();
    return;
  }

  for (const p of list) {
    const models = asArray(p.models);
    menu.appendChild(h('div', { class: 'model-menu-group', text: modelGroupLabel(p) }));

    if (!models.length) {
      menu.appendChild(h('div', { class: 'model-menu-empty', text: '还没有模型' }));
      continue;
    }

    for (const m of models) {
      const value = `${p.id}::${m}`;
      const isActive = value === active;
      menu.appendChild(h('button', {
        type: 'button',
        class: ['model-menu-item', isActive && 'is-active'],
        role: 'menuitemradio',
        'aria-checked': isActive ? 'true' : 'false',
        dataset: { value },
        // 模型名可能很长，截断之后靠 title 兜底看全名
        title: m
      },
        h('span', { class: 'model-menu-name', text: m }),
        checkIcon()
      ));
    }
  }

  trigger.disabled = false;
  menu.scrollTop = scrollTop;
}

/** ⚠️ 按文本去重：作者常把 first_mes 和 alternate_greetings[0] 写成一字不差，不去重会有两条一样的。 */
function greetingChoices(character) {
  const list = [];
  const seen = new Set();
  for (const raw of [character.firstMes, ...asArray(character.alternateGreetings)]) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
  }
  return list;
}

/** @returns {Promise<number>} 选中的下标；取消 / Esc / 点背景 → -1（= 不插开场白）。 */
async function pickGreeting(name, greetings) {
  const who = String(name || '').trim() || '这个角色';
  const index = await pickFromList({
    title: '选一条开场白',
    hint: `${who} 带了 ${greetings.length} 条开场白，它们是同一个场景的不同入场剧本 —— 挑一条作为这次对话的开头。`,
    items: greetings.map((text, i) => ({ text, note: i === 0 ? '默认' : '' }))
  });
  return index === null ? -1 : index;
}

/** 角色在角色列表页用卡片上的「聊天」按钮选 */
export async function applyCharacterChoice(characterId) {
  const convo = activeConvo();
  if (!convo) return;

  const next = characterId ? characterById(characterId) : null;
  if (!next) return;

  const previous = characterById(convo.characterId); // 用来判断标题是不是自动生成的

  // 只有「会话里一条消息都没有」时才插开场白
  if (!Array.isArray(convo.messages)) convo.messages = [];
  const untouched = convo.messages.length === 0;

  convo.characterId = next.id;
  convo.updatedAt = now();

  // 卡上声明过属性 / 身份四项就种进状态面板：漏了身份四项，模型不知道年龄（会把 16 岁写成 21 岁）
  seedIdentity(convo, next.name, next.id);
  seedPanelFromCharacters(convo, [next]);

  // ⚠️ 用**复制**而不是引用：之后改角色卡不该悄悄改掉正在进行的这一局。
  // 卡上没配过的（老卡、导入的卡）按默认来：开、4 条；只有卡上明确写了 false 才不开。
  convo.optionsSpec = optionsSpecFromCharacter(next);
  if (!convo.optionsSpec) convo.options = [];

  if (untouched) {
    // ⚠️ 多条开场白（语料里 424/1341 张卡都有）先让用户挑：那是同一个场景的不同入场剧本，
    //    永远只进第一条等于把一张卡当四分之一张用。
    const greetings = greetingChoices(next);
    let pick = 0;
    if (greetings.length > 1) {
      pick = await pickGreeting(next.name, greetings);
    }
    if (greetings.length && pick >= 0) {
      convo.messages = [
        {
          role: 'assistant',
          content: applyMacros(greetings[pick], next, convoUserName(convo)),
          at: now(),
          greeting: true
        }
      ];
    }
  }

  // 标题是跟着角色自动起的话，换角色时一起换掉
  const autoTitle = !convo.title || convo.title === '新对话' || (previous && convo.title === previous.name);
  if (autoTitle) convo.title = next.name;

  renderAll({ forceScroll: true });
  persistConversations(0);
}

/** 切换当前会话用的模型，同时记成「新会话」的默认模型 */
export function applyModelChoice(value) {
  const raw = String(value || '');
  const sep = raw.indexOf('::');
  if (sep < 0) return;

  const providerId = raw.slice(0, sep);
  const model = raw.slice(sep + 2);
  const provider = providerById(providerId);

  if (!provider || !model) {
    renderModelSwitch();
    return;
  }

  if (state.streaming) {
    showToast('正在生成回答，先点「停止生成」再切换模型');
    renderModelSwitch();
    return;
  }

  const convo = activeConvo();
  if (convo) {
    convo.providerId = providerId;
    convo.model = model;
    convo.updatedAt = now();
  }

  state.settings = state.settings || {};
  state.settings.activeProviderId = providerId;
  state.settings.activeModel = model;

  renderHeader();
  // 自绘的按钮 + 弹层不会自己显示选中项，按钮文字和列表勾都得重画。
  renderModelSwitch();
  // 「默认人设」按模型存，换模型气泡名字 / 空状态标题要跟着换；上面已确认不在流式，重画安全。
  renderAll();
  persistConversations(0);

  api
    .saveSettings({
      // 连 providers 一起存：这样刚添加、还没点「保存」的服务商不会被丢掉
      providers: providers(),
      activeProviderId: providerId,
      activeModel: model
    })
    .catch((err) => {
      console.error('保存模型选择失败', err);
      showToast('模型选择没能写入配置，重启后会回到默认值', 'error');
    });

  showToast(`已切换为 ${provider.name} · ${model}`, 'ok');
}
