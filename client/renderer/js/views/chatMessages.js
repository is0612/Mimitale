'use strict';

// 对话区（消息列表 + 空状态）：负责画消息、把按钮接到动作上。
// 编辑 / 重新生成在 composer.js，删除 / 分支在 convoActions.js，配图在 chatImages.js，建议在 suggestionsUi.js。

import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo } from '../core/util.js';
import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { esc, renderMarkdown } from '../ui/markdown.js';
import { h, button } from '../ui/build.js';
import { entityTone } from '../ui/avatarTone.js';
import { characterForConvo, convoWorldbookIds, worldbookById } from '../data/library.js';
import { convoPlayer, convoUserName, userName, speakerName, assistantName } from '../data/cast.js';
import { cleanAssistantText, convoFieldDisplayNames, panelGroupNames } from '../data/panel.js';
import { scrollToBottom } from './stream.js';
import { buildMessageImages, illustrateMessage } from './chatImages.js';
import { suggestNextActions, pickOption, rerollOptions, closeOptions } from './suggestionsUi.js';
import { switchVariant, editMessage, regenerateFrom, continueLastMessage } from './composer.js';
import { removeMessage, branchFromMessage } from './convoActions.js';
import { openStateCard } from './stateCard.js';

/** 正在生成开局的那个会话 id；同一时间只允许一个 */
let openingBusyId = null;

/** 消息头右端的时间（24 小时制，22:41）。读不到 at 就返回空串，不要用 new Date() 编一个假的。 */
function formatClock(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 一天的分组键（`2026-10-12`）；读不到时间返回空串，不参与跨天判断。 */
function dayKeyOf(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 给人看的日期：今天 / 昨天 / M 月 D 日 */
function dayLabel(at) {
  const d = new Date(Number(at));
  const now = new Date();
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return '今天';
  if (sameDay(d, new Date(now.getTime() - 86400000))) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 日期分隔（「——— 今天 · 第 12 轮 ———」），只在跨天时插一条。
 *  ⚠️ 「第 N 轮」按一问一答算一轮（一轮 = 2 条），要和顶栏 renderHeader 同口径。 */
function dateSeparator(message, index) {
  const at = Number(message.at);
  const when = Number.isFinite(at) && at > 0 ? dayLabel(at) : '';
  const round = `第 ${Math.floor(index / 2) + 1} 轮`;
  return h(
    'div',
    { class: 'msg-date-sep' },
    h('span', { class: 'msg-date-line' }),
    h('span', { class: 'msg-date-text', text: when ? `${when} · ${round}` : round }),
    h('span', { class: 'msg-date-line' })
  );
}

// ---- Markdown 渲染缓存 ----
// 整棵重建时用 WeakMap 以消息对象为键，正文 / 字段名 / 分组名没变就复用上次的 HTML（几百条长会话才不卡）。
const markdownCache = new WeakMap();

function cachedMarkdown(message, ctx) {
  const hit = markdownCache.get(message);
  if (
    hit &&
    hit.content === message.content &&
    hit.fieldsKey === ctx.fieldsKey &&
    hit.groupsKey === ctx.groupsKey
  ) {
    return hit.html;
  }
  const html = renderMarkdown(cleanAssistantText(message.content, ctx.panelFields, ctx.panelGroups));
  markdownCache.set(message, {
    content: message.content,
    fieldsKey: ctx.fieldsKey,
    groupsKey: ctx.groupsKey,
    html
  });
  return html;
}

/** 由 views/worldPlay.js 在「按世界设定生成开局」前后设置 */
export function setOpeningBusy(id) {
  openingBusyId = id;
}

/** 剧情选项块：每行一个选项（点一下当作玩家说了这句话），底下有「换一批」和「✕」。
 *  按钮动作都在 suggestionsUi.js，这里只管接线。 */
function buildOptionsBlock(options) {
  const box = h('div', { class: 'msg-options' });

  // 选项按钮包一层容器：点「换一批」时把里面换成骨架屏，等模型返回再换回来
  const list = h('div', { class: 'msg-options-list' });
  box.appendChild(list);

  function renderButtons() {
    list.textContent = '';
    options.forEach((text, i) => {
      list.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'msg-option-btn',
            title: '点一下，就当你说这句话发出去',
            onClick: () => pickOption(activeConvo(), text)
          },
          // 数字序号：输入框里按 1~9 也能选，序号印在按钮上对上号
          h('span', { class: 'opt-index', text: String(i + 1), 'aria-hidden': 'true' }),
          // h('span', { class: 'opt-arrow', text: '↩', 'aria-hidden': 'true' }),
          h('span', { class: 'opt-text', text })
        )
      );
    });
  }

  // 骨架屏：几条闪烁灰条占住选项位置；条数跟着选项个数走，高度用「一行」的样式，过渡才不跳。
  function renderSkeleton() {
    list.textContent = '';
    const n = Math.max(2, Math.min(options.length || 3, 4));
    for (let i = 0; i < n; i += 1) {
      const bar = h('div', { class: 'msg-option-skeleton', 'aria-hidden': 'true' });
      bar.style.width = `${[52, 68, 76, 61][i % 4]}%`;
      list.appendChild(bar);
    }
  }

  renderButtons();

  // 「换一批」：先换骨架屏并禁用按钮，等模型返回；失败时原地把旧选项画回来
  // （成功时 refreshAll 已整块重绘）。
  const reroll = h(
    'button',
    {
      type: 'button',
      class: 'msg-options-reroll',
      text: '⟳ 换一批',
      title: '这批没有想要的？让 AI 再给一批',
      onClick: async (event) => {
        const btn = event.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = '换一批中…';
        renderSkeleton();
        try {
          const ok = await rerollOptions(activeConvo());
          // 失败时 rerollOptions 已把旧选项写回，这里换回旧按钮；成功时 refreshAll 已整块重绘。
          if (!ok) renderButtons();
        } finally {
          btn.disabled = false;
          btn.textContent = original;
        }
      }
    }
  );

  const close = h('button', {
    type: 'button',
    class: 'msg-options-close',
    text: '✕',
    title: '收起这一批选项（下一轮回复会带新的）',
    onClick: () => closeOptions(activeConvo())
  });

  box.appendChild(h('div', { class: 'msg-options-foot' }, reroll, close));
  return box;
}

function messageNode(message, index, character, labels, ctx) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';
  // 角色只标识助手侧：用户消息和错误提示绝不能套角色的头像和名字。
  const speaker = isUser || isError ? null : character;

  // 说话人显示名：助手侧是角色名 / 世界名，自己侧是会话上的玩家名（没设就是「你」）。
  const userLabel = (labels && labels.user) || userName();
  const assistantLabel = String((speaker ? speaker.name : labels && labels.assistant) || 'AI');

  const wrap = document.createElement('div');
  wrap.className = `msg ${isError ? 'error' : isUser ? 'user' : 'assistant'}`;
  wrap.dataset.index = String(index);

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  // 底色跟会话条目 / 状态卡 / 在场角色栏共用一套渐变；「我」固定那支蓝（.gme）。
  avatar.classList.add(isUser ? 'gme' : entityTone(character && character.id, assistantLabel));

  if (speaker && speaker.avatar) {
    const img = document.createElement('img');
    img.src = speaker.avatar;
    img.alt = speaker.name;
    avatar.appendChild(img);
    avatar.classList.add('has-image');
    avatar.title = speaker.name;
  } else {
    avatar.textContent = isError ? '!' : isUser ? '我' : assistantLabel.slice(0, 1);
  }

  // 点「我」的头像打开我的状态卡（普通聊天没有「在场角色」条，这里是唯一入口）；
  // AI 那侧不挂 —— 消息里既有角色又有场景，算谁的说不清。
  if (isUser) {
    avatar.classList.add('clickable');
    avatar.title = '查看我的状态';
    avatar.setAttribute('role', 'button');
    avatar.setAttribute('tabindex', '0');
    avatar.setAttribute('aria-label', '查看我的状态');
    avatar.addEventListener('click', () => openStateCard('player'));
    avatar.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openStateCard('player');
      }
    });
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  // 消息头整行 flex：左端名字，右端候选翻页和时间。
  const role = document.createElement('div');
  role.className = 'msg-role';

  const name = document.createElement('span');
  name.className = 'msg-role-name';
  name.textContent = isError ? '出错了' : isUser ? userLabel : assistantLabel;
  role.appendChild(name);

  // 助手消息上标出是哪个模型答的，方便对比多个模型
  if (!isUser && !isError && message.model) {
    const tag = document.createElement('span');
    tag.className = 'msg-model';
    tag.textContent = message.model;
    role.appendChild(tag);
  }

  // 弹性空隙：把候选翻页 / 时间顶到最右。⚠️ 用户那侧要**隐藏**它 —— 自己的消息头整体靠右，
  // 靠 .msg.user .msg-role .msg-spacer 那条规则实现。
  role.appendChild(h('span', { class: 'msg-spacer' }));

  // 候选切换放消息头而不是操作栏：操作栏悬停才浮出，看不出这条有几个版本。
  const variants = Array.isArray(message.variants) ? message.variants : null;
  if (!isUser && !isError && variants && variants.length > 1) {
    const at = Number.isFinite(message.variantIndex)
      ? Math.max(0, Math.min(variants.length - 1, Math.trunc(message.variantIndex)))
      : 0;
    role.appendChild(
      h(
        'span',
        { class: 'variant-nav' },
        button({
          class: 'variant-btn',
          text: '‹',
          title: '上一条候选',
          ariaLabel: '上一条候选',
          onClick: () => switchVariant(index, -1)
        }),
        h('span', { class: 'variant-count', text: `${at + 1}/${variants.length}` }),
        button({
          class: 'variant-btn',
          text: '›',
          title: '下一条候选',
          ariaLabel: '下一条候选',
          onClick: () => switchVariant(index, 1)
        })
      )
    );
  }

  // 时间放最后（右端）。没有 `at` 就不画 —— 见 formatClock 的说明。
  const clock = formatClock(message.at);
  if (clock) {
    role.appendChild(h('span', { class: 'msg-time', text: clock }));
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (message.reasoning) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    const summary = document.createElement('summary');
    // 标题上写思考花了多少：有精确 token 就用，没有退回字数。
    const rt = Number(message.reasoningTokens);
    summary.textContent =
      Number.isFinite(rt) && rt > 0
        ? `思考过程 · ${rt} tokens`
        : `思考过程 · ${String(message.reasoning).length} 字`;
    const pre = document.createElement('div');
    pre.className = 'reasoning-text';
    pre.textContent = message.reasoning;
    details.appendChild(summary);
    details.appendChild(pre);
    bubble.appendChild(details);
  }

  const content = document.createElement('div');
  content.className = 'msg-content';
  if (isUser || isError) {
    content.textContent = String(message.content == null ? '' : message.content);
  } else {
    // 气泡里剥掉「状态栏行」和「剧情选项行」：状态值由面板权威持有，选项已变成按钮。
    // 渲染结果走上面的缓存，没改过的消息不重跑正则。
    content.innerHTML = cachedMarkdown(message, ctx);
  }

  // 图片放在文字上面 —— 先看图再看说话，跟聊天软件的习惯一致
  const imageBlock = buildMessageImages(message);
  if (imageBlock) bubble.appendChild(imageBlock);
  // 只带图没打字的，就不要留一个空段落了
  if (String(message.content || '').trim() || !imageBlock) bubble.appendChild(content);

  // 撞到回复上限、被服务商截断的回复：明说一句，别让残缺悄悄过去。
  if (!isUser && !isError && message.truncated && String(message.content || '').trim()) {
    const note = document.createElement('div');
    note.className = 'truncated-note';
    const auto = Number(message.autoContinued) || 0;
    if (message.finishReason === 'length') {
      // 还在截断状态：自动续写没救回来，或者这个开关是关的
      note.textContent =
        auto > 0
          ? `这一条撞到「回复上限」，已经自动接着写了 ${auto} 次还是没写完 —— 可以点「继续」，或把上限调大`
          : '这一条撞到「回复上限」被截断了，可以点「继续」让它接着写';
    } else {
      // finishReason 已经不是 length = 自动续写救回来了。中间断过一次，但文本不残缺
      note.textContent = '这一条中间撞到过「回复上限」，已经自动接着写完了';
    }
    bubble.appendChild(note);
  }

  body.appendChild(role);
  body.appendChild(bubble);

  // 剧情选项挂在**最新一条** AI 回复下面；你是最后一条或正在生成时不挂（旧选项只会碍事）。
  if (!isUser && !isError && index === ctx.lastIndex && ctx.options && ctx.options.length) {
    body.appendChild(buildOptionsBlock(ctx.options));
  }

  // 操作按钮：低频操作（继续 / 配图 / 帮我想想 / 分支 / 删除）收进「⋯」，常用只留复制 / 编辑 / 重新生成。
  // ⚠️ 收的是**视觉**不是 DOM：低频按钮仍在 .msg-actions 里（display:none），冒烟按 `.mini-btn` 文字找按钮。
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const extras = [];

  if (!isError && message.content) {
    const copy = document.createElement('button');
    copy.className = 'mini-btn';
    copy.textContent = '复制';
    copy.title = '复制这条消息';
    copy.setAttribute('aria-label', '复制这条消息');
    copy.addEventListener('click', async () => {
      try {
        await api.copyText(message.content);
        showToast('已复制到剪贴板', 'ok');
      } catch (err) {
        showToast(`复制失败：${(err && err.message) || '未知错误'}`, 'error');
      }
    });
    actions.appendChild(copy);

    const edit = document.createElement('button');
    edit.className = 'mini-btn';
    edit.textContent = '编辑';
    edit.title = '直接改这条消息的内容';
    edit.setAttribute('aria-label', '编辑这条消息');
    edit.addEventListener('click', () => editMessage(index));
    actions.appendChild(edit);
  }

  if (!isUser) {
    const regen = document.createElement('button');
    regen.className = 'mini-btn';
    regen.textContent = isError ? '重试' : '重新生成';
    regen.title = isError ? '重新发送上一条消息' : '重新生成这条回复';
    regen.setAttribute('aria-label', isError ? '重新发送上一条消息' : '重新生成这条回复');
    regen.addEventListener('click', () => regenerateFrom(index));
    actions.appendChild(regen);

    // 「继续」只对最后一条有意义 —— 中间的回复后面早就接上别的话了
    const isLast = index === ctx.lastIndex;
    if (isLast && String(message.content || '').trim()) {
      const cont = document.createElement('button');
      cont.className = 'mini-btn';
      cont.textContent = '继续';
      cont.title = '让 AI 接着这条往下写（回复被截断时用）';
      cont.setAttribute('aria-label', '继续生成');
      cont.addEventListener('click', continueLastMessage);
      extras.push(cont);
    }

    // 配图：配了生图服务商（云生图或本地桥接）才显示，免得点了才知道没配
    if (String(message.content || '').trim() && (state.settings || {}).imageProviderId) {
      const draw = document.createElement('button');
      draw.className = 'mini-btn';
      draw.textContent = '配图';
      draw.title = '用生图模型给这段配一张插画';
      draw.setAttribute('aria-label', '给这条回复配图');
      draw.addEventListener('click', () => illustrateMessage(index));
      extras.push(draw);
    }

    // 帮我想想：卡住不知道说什么时，让 AI 给几个下一步让你挑
    if (isLast && String(message.content || '').trim()) {
      const suggest = document.createElement('button');
      suggest.className = 'mini-btn';
      suggest.textContent = '帮我想想';
      suggest.title = '让 AI 给几个下一步，点一下就直接发出去';
      suggest.setAttribute('aria-label', '让 AI 帮我想下一步');
      suggest.addEventListener('click', () => suggestNextActions(suggest));
      extras.push(suggest);
    }
  }

  // 删除这一条消息（会先弹确认框）
  const del = document.createElement('button');
  del.className = 'mini-btn danger';
  del.textContent = '删除';
  del.title = '删除这条消息';
  del.setAttribute('aria-label', '删除这条消息');
  del.addEventListener('click', () => removeMessage(index));
  extras.push(del);

  // 从这条分出一条新线：不动当前会话，另外复制一个出来
  if (!isError) {
    const branch = document.createElement('button');
    branch.className = 'mini-btn';
    branch.textContent = '分支';
    branch.title = '从这条起另开一个会话（当前这条线原样保留）';
    branch.setAttribute('aria-label', '从这条消息分支');
    branch.addEventListener('click', () => branchFromMessage(index));
    extras.push(branch);
  }

  appendExtras(actions, extras);
  body.appendChild(actions);

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  return wrap;
}

/** 把低频操作收进「⋯」。收起纯粹是 CSS 切 display —— **按钮一直在 DOM 里**，所以冒烟按文字
 *  找按钮不用改、展开收起也不重渲染。@param {HTMLElement} actions 工具条 @param {HTMLElement[]} extras 要收起的按钮 */
function appendExtras(actions, extras) {
  if (!extras.length) return;

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'mini-btn mini-more';
  more.textContent = '⋯';
  // 提示按这条消息实际有的按钮列出来，写死一份会念出不存在的项。
  more.title = `更多操作（${extras.map((b) => b.textContent.trim()).join(' / ')}）`;
  more.setAttribute('aria-label', '更多操作');
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', (event) => {
    // 别冒到 document：将来若加「点别处收起」，这一下会被当成「点了别处」
    event.stopPropagation();
    const open = actions.classList.toggle('open');
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  actions.appendChild(more);

  extras.forEach((btn) => {
    btn.classList.add('mini-extra');
    actions.appendChild(btn);
  });
}

export function renderMessages(options) {
  const opts = options || {};
  const convo = activeConvo();
  const character = characterForConvo(convo);
  el.messages.innerHTML = '';

  if (!convo || !Array.isArray(convo.messages) || !convo.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';

    const book = convo
      ? convoWorldbookIds(convo).map((id) => worldbookById(id)).find(Boolean)
      : null;
    const player = convoPlayer(convo);

    if (book) {
      // 进了世界的空会话：主角是你自己，AI 是这个世界
      const busy = convo && openingBusyId === convo.id;
      empty.innerHTML = busy
        ? `
      <h2>正在生成开局…</h2>
      <p class="hint">AI 正在按「${esc(book.name)}」的设定写开场场景，稍等一下。</p>
    `
        : `
      <h2>进入「${esc(book.name)}」</h2>
      <p>你是「${esc((player && player.name) || '旅行者')}」。在下面输入框里说点什么，然后按 Enter。</p>
      <p class="hint">这个世界由 GM 叙述：环境、NPC、剧情走向都归它写。</p>
      <p class="hint">想调整叙述方式，点右上角「视角」。</p>
    `;
    } else if (character) {
      empty.innerHTML = `
      <h2>开始和${esc(character.name)}聊天吧～</h2>
      <p>在下面输入框里说点什么，然后按 Enter。</p>
      <p class="hint">当前扮演的是「${esc(character.name)}」。想换角色，去左下角「角色库」点另一张卡上的「聊天」。</p>
    `;
    } else {
      // 名字取自「默认人设」里当前模型那一份；没写名字就不提名字，别硬塞内置假名
      const who = assistantName(convo);
      empty.innerHTML = `
      <h2>${who ? `开始和${esc(who)}聊天吧～` : '开始聊天吧～'}</h2>
      <p>在下面输入框里说点什么，然后按 Enter。</p>
      <p class="hint">第一次使用请先点左下角「设置」，填入接口地址和 API Key。</p>
      <p class="hint">想玩角色扮演？点左下角「角色库」导入角色卡，再点卡片上的「聊天」。</p>
    `;
    }

    el.messages.appendChild(empty);
    scrollToBottom(true);
    return;
  }

  // 每条消息都要用的几样东西，在循环外算一次。
  const labels = {
    user: convoUserName(convo),
    assistant: speakerName(convo)
  };
  const lastMsg = convo.messages[convo.messages.length - 1];
  // 剧情选项挂在最新一条 AI 回复下面：你刚发了话、或正在流式生成就先不挂
  const showOptions =
    !state.streaming &&
    !!lastMsg &&
    lastMsg.role === 'assistant' &&
    Array.isArray(convo.options) &&
    convo.options.length > 0;
  const panelFields = convoFieldDisplayNames(convo);
  const panelGroups = [...panelGroupNames(convo)];
  const ctx = {
    panelFields,
    panelGroups,
    // 缓存签名的两把钥匙：字段名 / 分组名变了（比如编辑面板定义），旧消息的剥离结果也得跟着变。
    fieldsKey: panelFields.join('\u0000'),
    groupsKey: panelGroups.join('\u0000'),
    lastIndex: convo.messages.length - 1,
    options: showOptions ? convo.options : null
  };

  // 先攒进 fragment 再一次性挂上：逐条 append 到已挂载的列表会让样式反复失效。
  const frag = document.createDocumentFragment();
  // 跨天时插日期分隔；第一条前面也插（「今天 · 第 1 轮」是这一段抬头，不是两条之间的东西）。
  let lastDay = null;
  convo.messages.forEach((message, index) => {
    const day = dayKeyOf(message.at);
    if (day && day !== lastDay) frag.appendChild(dateSeparator(message, index));
    if (day) lastDay = day;
    frag.appendChild(messageNode(message, index, character, labels, ctx));
  });
  el.messages.appendChild(frag);

  scrollToBottom(!!opts.forceScroll);
}
