'use strict';

// ============================================================================
//  views/chatList.js —— 左侧会话列表 + 右上角的模型切换
//
//  两样「会话级别的选择器」放在一起：
//    · 左侧列一个会话一行（点了切过去，悬停浮出 × 删除）
//    · 右上角下拉框选这个会话用哪个服务商/模型
//  另外「绑定角色」也在这儿 —— 它本质上和切模型是同一类事（改当前会话用谁），
//  以前顶部还有个角色下拉框，后来改到角色列表页用卡片上的「聊天」触发，
//  留下 applyCharacterChoice 这个入口（含自动插开场白、自动起标题）。
// ============================================================================

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo, now } from '../core/util.js';
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
  const last = [...messages].reverse().find(message => ['user', 'assistant'].includes(message.role) && String(message.content || '').trim());
  if (!last) return '故事，等待续写';
  return String(last.content).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<[^>]*>/g, '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70) || '故事，等待续写';
}

export function renderConvoList() {
  clear(el.convoList);

  // ⛔ 侧栏搜索框 2026-10-12 晚去掉（星宝要求）—— 这里不再按关键词过滤。
  //    当时的实现只匹配**标题**、不搜消息内容，而且会话本来就不多；
  //    真要做搜索就做成全局的（标题 + 正文），别留一个「搜不到内容」的错觉。
  const list = state.conversations;

  // 分区标题：平时就是「最近会话」
  if (el.convoCap) el.convoCap.textContent = `故事记录 · ${list.length}`;

  if (!list.length) {
    // 这两条内联样式是「空状态」专属的，没有别的用处（真要认真做该进样式表）
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
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              switchConvo(convo.id);
            }
          },
          onclick: () => switchConvo(convo.id)
        },
        convoAvatar(convo),
        // 一行：名字 + 时间（设计稿的写法）。
        // ⚠️ 2026-10-12 去掉了原来那行副标题（「谁 · 什么时候」）：
        //    「跟谁聊」头像已经在说，「什么时候」挪到右端 —— 两行并一行之后
        //    一屏能多放进两个会话，扫列表也快一点。
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

/**
 * 收起态图标轨最下面那颗：**当前会话**是谁（稿子屏 2 最底下那个 20px 方角图）。
 *
 * 展开态里它是 `display:none` —— 展开态「我在哪个会话」由列表的选中态说，
 * 不需要再说第二遍。
 * ⚠️ 复用 convoAvatar() 的产物（同一套 entityTone）—— 否则同一个人
 *    在列表里是绿的、在图标轨里变成主色，又会出现「同一个人两个颜色」。
 */
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

/**
 * 会话条目左边那个小圆头像：一眼看出这一条是跟谁聊的。
 *   绑了角色   → 角色头像，没传头像就取名字首字
 *   世界书会话 → 世界书名首字（浅色底，和角色区分开）
 *   都不是     → 一个中性小点，纯占位，保持每条都对齐
 */
function convoAvatar(convo) {
  const char = convo.characterId ? characterById(convo.characterId) : null;
  if (char) {
    const node = h('span', {
      class: `convo-avatar ${entityTone(char.id, char.name)}`,
      title: char.name
    });
    if (char.avatar) node.appendChild(h('img', { src: char.avatar, alt: '' }));
    else node.textContent = char.name.slice(0, 1);
    return node;
  }

  const wbId = convoWorldbookIds(convo)[0] || '';
  const wb = wbId ? worldbookById(wbId) : null;
  if (wb) {
    // 世界书会话的头像是**方的**（设计稿 .ava.book）—— 形状本身就是分类，
    // 不用再挂标签去区分「跟角色聊」和「在书里玩」。
    return h('span', {
      class: `convo-avatar book ${entityTone(wb.id, wb.name)}`,
      text: wb.name.slice(0, 1),
      title: wb.name
    });
  }

  // 2026-10-12 深夜：这里原来是个「·」—— 头像只有 20px 时，那是个不起眼的小点；
  // 放大到 48 之后，它就是一个**空落落的大方块**（出图时才看出来的，DOM 断言看不见）。
  // 改成显示**会话标题首字**：和上面两条一样是「一眼认人」，只是走中性色，
  // 不跟有角色的那几条抢注意力。标题为空时兜底还是那个「·」。
  const title = String(convo.title || '').trim();
  return h('span', {
    class: 'convo-avatar plain',
    text: title ? title.slice(0, 1) : '·',
    title: title || '空对话'
  });
}

/**
 * 会话条目右端那个时间（设计稿的写法，看的是**日历位置**不是时长）：
 *   今天   → `14:03`（给时刻比给「3 小时前」更好定位）
 *   昨天   → 「昨天」
 *   七天内 → 「周三」
 *   更早   → `10-08`
 *
 * ⚠️ 这跟原来那个 relativeTime（刚刚 / 12 分钟前 / 3 小时前…）不是一回事，
 *    那个读的是「多久以前」，所以把 2026-10-12 一起换掉了：
 *    列表右端要的是「哪天聊的」，不是「过去多少小时」。
 */
function convoTimeLabel(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86400000;
  if (t >= startOfToday) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (t >= startOfToday - dayMs) return '昨天';
  if (t >= startOfToday - 6 * dayMs) {
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

/** 选项行右边的勾。没选中的行也占着这块位置（CSS 里 opacity:0），文字不会左右跳。
 *  ⚠️ SVG 得走 createElementNS —— build.js 的 h() 是 createElement，
 *  建出来的只是「名叫 svg 的普通元素」，根本不画。 */
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
 * 右上角切换模型：按钮上写当前模型，点开是一个按服务商分组的弹层。
 *
 * 以前这里是原生 <select>。原生下拉的**列表**由系统画（直角、系统蓝高亮、
 * 系统字体），CSS 碰不到 —— 跟这套「大圆角 + 柔和阴影」完全不搭，所以换成
 * 和「⋯」共用的 .menu-pop 弹层。开合逻辑在 ui/modelMenu.js，这里只负责铺内容。
 *
 * 这个函数挂在刷新总线上，**发一条消息、点一下状态卡都会把它喊一遍**。
 * 所以先算一个「内容指纹」，没变就直接返回 —— 否则每次重绘都要把整棵列表树
 * 拆了重建（连带还得自己存还 scrollTop），纯属白干。
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

  // 指纹要盖住**所有会影响输出的东西**：当前选中、每个分组的标题（含「未填 Key」）、
  // 每组下面的模型列表。分组标题直接用最终文案，省得漏掉 isBridgeProvider 那种判断。
  const signature = [
    active,
    list.map((p) => `${p.id}~${modelGroupLabel(p)}~${(p.models || []).join(',')}`).join('|')
  ].join('\u0000');
  if (signature === lastModelSwitchSignature) return;
  lastModelSwitchSignature = signature;

  // 按钮上那行字：选了模型就写模型名，没选就写「选择模型」/「未配置模型」
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
    // 一个服务商都没有：按钮收成一块「提示」，弹层里说清楚去哪儿配
    menu.appendChild(h('div', { class: 'model-menu-empty', text: '还没有配置模型服务 —— 点左下角「设置」' }));
    trigger.disabled = true;
    closeModelMenu();
    return;
  }

  for (const p of list) {
    menu.appendChild(h('div', { class: 'model-menu-group', text: modelGroupLabel(p) }));

    if (!p.models || !p.models.length) {
      menu.appendChild(h('div', { class: 'model-menu-empty', text: '还没有模型' }));
      continue;
    }

    for (const m of p.models) {
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

/**
 * 一张卡的开场白候选：主开场白（firstMes）排最前，后面接备选开场白。
 *
 * 按文本去重 —— 作者的 `first_mes` 和 `alternate_greetings[0]` 经常一字不差
 * （复制粘贴留下的），不去重的话列表里会出现两条一模一样的，用户会以为点错了。
 * 两级都裁掉两端空白：卡里的开场白常以空行开头，留着预览第一屏是空的。
 */
function greetingChoices(character) {
  const list = [];
  const seen = new Set();
  for (const raw of [character.firstMes, ...(character.alternateGreetings || [])]) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
  }
  return list;
}

/**
 * 让用户从这张卡的开场白里挑一条。
 *
 * @returns {Promise<number>} 选中的下标；取消 / Esc / 点背景 → -1（表示「不插开场白」）
 */
async function pickGreeting(name, greetings) {
  const who = String(name || '').trim() || '这个角色';
  const index = await pickFromList({
    title: '选一条开场白',
    hint: `${who} 带了 ${greetings.length} 条开场白，它们是同一个场景的不同入场剧本 —— 挑一条作为这次对话的开头。`,
    items: greetings.map((text, i) => ({ text, note: i === 0 ? '默认' : '' }))
  });
  return index === null ? -1 : index;
}

/** 顶部的角色下拉框已经去掉：角色改成在角色列表页用卡片上的「聊天」按钮选 */
export async function applyCharacterChoice(characterId) {
  const convo = activeConvo();
  if (!convo) return;

  const next = characterId ? characterById(characterId) : null;
  if (!next) return;

  const previous = characterById(convo.characterId); // 用来判断标题是不是自动生成的

  // 自动插入的开场白会带 greeting 标记。
  // 只有「会话里一条消息都没有」时才插 —— 调用方（角色列表页的「聊天」）
  // 给的都是刚建好的空会话，所以这里不用担心覆盖掉真实对话。
  const untouched = !convo.messages.length;

  convo.characterId = next.id;
  convo.updatedAt = now();

  // 角色卡上声明过「属性」和「身份四项」就种进状态面板 —— AI 第一轮就知道
  // 这个角色是谁、要维护哪些字段，不用等它自己碰巧输出一个「【金币】：100」
  // （漏了身份那四项时，模型不知道年龄，会把 16 岁写成 21 岁）
  seedIdentity(convo, next.name, next.id);
  seedPanelFromCharacters(convo, [next]);

  // 剧情选项：角色卡上的配置跟着这个会话生效。用的是**复制**而不是引用 ——
  // 之后改角色卡不该悄悄改掉正在进行的这一局。
  // 卡上没配过的（老卡、导入的卡）按默认来：开、4 条；只有卡上明确写了 false 才不开。
  convo.optionsSpec = optionsSpecFromCharacter(next);
  if (!convo.optionsSpec) convo.options = [];

  if (untouched) {
    // 空对话绑上带开场白的角色时，自动把开场白放进去，省得每次手动开个头。
    // 卡上带多条时（语料实测 424/1341 张卡带，单卡最多 29 条）先让用户挑一条 ——
    // 那些不是冗余，是同一个场景的**不同入场剧本**（比如「男性开场 / 女性开场 /
    // NTR 开场」），永远只进第一条等于把一张卡当四分之一张用。
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

  // 顺便设为新会话的默认值
  state.settings.activeProviderId = providerId;
  state.settings.activeModel = model;

  renderHeader();
  // 以前这里是原生 select，它自己会把选中的那项显出来；现在是自绘的按钮 + 弹层，
  // 按钮上那行字和列表里的勾都得自己重画一遍。
  renderModelSwitch();
  // 「默认人设」是按模型存的，换了模型，气泡上的名字和空状态标题都要跟着换 ——
  // 所以顺带把消息区重画一次（上面已经确认不在流式状态，重画是安全的）。
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
