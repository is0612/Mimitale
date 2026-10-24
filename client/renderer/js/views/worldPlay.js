'use strict';

// 「开始」按下之后的事：谁来建会话、种状态面板、切视图（「进世界」/「跟角色聊」两条路）。
// 开局那段用独立 requestId 调接口，流式分片不会被聊天窗口接住 —— 写完才一次性落进去。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { characterById, characterWorldbooks, worldbookCharacters } from '../data/library.js';
import { seedIdentity, seedPanelFromCharacters, mergePlayerOwnedFields } from '../data/panel.js';
import { applyMacros } from '../data/messages.js';
import { optionsSpecFromCharacter } from '../data/suggestions.js';
import { convoUserName, convoPlayer, worldbookCast } from '../data/cast.js';
import { gmRuleText } from '../data/narration.js';
import { ensureConvoEndpoint } from '../data/providers.js';
import { createConvo } from '../data/conversations.js';
import { persistConversations } from '../data/persist.js';
import { getPlayerStart, readPlayerDraft, closePlayerModal, openChatPlayerModal, openPlayerModal } from './player.js';
import { showView } from './viewSwitch.js';
import { renderAll } from './redraw.js';
import { renderMessages, setOpeningBusy } from './chatMessages.js';
import { applyCharacterChoice } from './chatList.js';

/** 名字和设定都留空 = 不设：界面和提示词都回到默认的「你」。 */
function applyPlayerIdentity(convo, draft) {
  if (!convo) return;
  // 选了卡但名字/设定都留空也是有效的身份 —— 不能把刚挑的卡丢掉。
  const hasIdentity = draft && (draft.name || draft.profile || draft.card);
  convo.player = hasIdentity
    ? { name: draft.name || '', profile: draft.profile || '', characterId: draft.card ? draft.card.id : null }
    : null;
  convo.updatedAt = now();
}

/** 按这次弹窗为谁开分流到「进世界」或「开聊」；目标中途被删（getPlayerStart 返回 null）直接关窗。 */
export function startPlayerFlow() {
  const start = getPlayerStart();
  if (!start) {
    closePlayerModal();
    return;
  }
  if (start.kind === 'world') startWorldPlay(start.books, start.name);
  else {
    // ⚠️ startCharacterChat 是 async：不接住 rejection 会变成 unhandled rejection。
    startCharacterChat(start.character).catch((err) => {
      console.error('开始聊天失败', err);
      showToast((err && err.message) || '开始聊天失败', 'error');
    });
  }
}

/**
 * 建会话、装上这个世界、存下玩家自己的角色；世界由 GM 叙述，所以顺手开 GM 模式。
 * `books` 是一组世界书（角色卡可能绑了好几本，一起进同一个世界）；`name` 是会话标题。
 */
export function startWorldPlay(input, name = '') {
  const books = (Array.isArray(input) ? input : [input]).filter(Boolean);
  if (!books.length) return;

  const draft = readPlayerDraft() || {};

  const convo = createConvo(true);
  convo.worldbookIds = books.map((book) => book.id);
  convo.gmMode = true;
  convo.title = name || books.map((book) => book.name).join('、');
  convo.updatedAt = now();

  // 选了角色卡就记住是哪张（名字 / 设定仍以输入框为准，选完还能改）
  applyPlayerIdentity(convo, draft);
  const pickedCard = draft.card;

  // ⚠️ 用复制（和绑卡那套一致）：改卡不该悄悄改掉正在玩的这一局。
  // 没选卡（自己写的主角或留空）也给默认的 4 条。
  convo.optionsSpec = optionsSpecFromCharacter(pickedCard);
  if (!convo.optionsSpec) convo.options = [];

  // ⚠️ 先种「你自己」再种书里角色：同名以先出现的为准，自己卡上的「金币」不会被书里的盖掉。
  seedIdentity(convo, draft.name, 'player');
  if (pickedCard) seedPanelFromCharacters(convo, [pickedCard], 'player');
  for (const book of books) seedPanelFromCharacters(convo, worldbookCharacters(book));

  // ⚠️ 种完字段再并：挑的卡可能也在书里当 NPC 副本，撞名时把副本那份收回来，
  //    否则同一个人占两张状态卡、属性存两份。
  mergePlayerOwnedFields(convo);

  // 开场：书里写了就用书里的（多本取第一本写了的）；都没写就让模型按设定现生成一段
  const opening = books.map((book) => String(book.opening || '').trim()).find(Boolean) || '';
  if (opening) {
    convo.messages = [
      {
        role: 'assistant',
        content: applyMacros(opening, null, draft.name, '叙述者'),
        at: now(),
        greeting: true
      }
    ];
  }

  closePlayerModal();
  showView('chat');
  renderAll({ forceScroll: true });
  persistConversations(0);

  showToast(`进入「${convo.title}」—— 你是「${convoUserName(convo)}」`, 'ok');
  el.input.focus();

  // 没写开场白就去生成一段。失败也不影响玩，只是开局空着
  if (!opening) generateWorldOpening(convo, books);
}

/** ⚠️ 身份要在绑卡**之前**落到会话上：自动插入的开场白里 {{user}} 得用刚填的名字。 */
async function startCharacterChat(character) {
  if (!character) return;

  const draft = readPlayerDraft() || {};

  // ⚠️ 玩家名和 TA 同名 = 自己跟自己聊：开场白里的 {{user}} 会替换成同一个名字，
  //    模型分不清谁是 TA、谁是玩家（表现是「我本来在第三者位置，怎么成了角色本人」）。
  //    这里只挡下来，弹窗还开着，改个名字再点开始就行。
  if (draft.name && character.name && draft.name.trim() === String(character.name).trim()) {
    showToast(`「${character.name}」是你正在聊的人 —— 换成你自己的名字再开始`, 'error');
    el.playerName.focus();
    return;
  }

  createConvo(true);
  const convo = activeConvo();
  applyPlayerIdentity(convo, draft);

  if (draft.card) {
    seedIdentity(convo, draft.name, 'player');
    seedPanelFromCharacters(convo, [draft.card], 'player');
  }

  // ⚠️ 必须 await：卡上多条开场白时这里会开「选一条开场白」的弹窗等着，后面的关窗 /
  //    切视图 / 抢焦点得等它选完，否则底下的弹窗先关、焦点被抢走，弹窗的键盘操作就废了。
  await applyCharacterChoice(character.id);

  // 绑定之后才并：同上，把副本那份合并成「我」一份。
  mergePlayerOwnedFields(convo);

  closePlayerModal();
  showView('chat');
  renderAll({ forceScroll: true });
  persistConversations(0);

  showToast(`开始和「${character.name}」聊天`, 'ok');
  el.input.focus();
}

/** 先问一句「你是谁」，按了开始才建会话；身份开聊前定好，中途不能换（想换就另开一个会话）。 */
export function chatWithCharacter(id) {
  const character = characterById(id);
  if (!character) return;

  if (state.streaming) {
    showToast('正在生成回答，先点「停止生成」再开新会话');
    return;
  }

  openChatPlayerModal(id);
}

/**
 * 角色卡的第二条入口：进 TA 的世界。
 * 用的是这张卡自带的世界书（可能好几本，一起进）；一本都没有就不该走到这儿 ——
 * 卡片上那颗「进入世界」只在有书时才渲染。
 */
export function playCharacterWorld(id) {
  const character = characterById(id);
  if (!character) return;

  if (state.streaming) {
    showToast('正在生成回答，先点「停止生成」再开新世界');
    return;
  }

  const books = characterWorldbooks(character);
  if (!books.length) {
    showToast('这张卡还没有绑世界书 —— 先去编辑里绑一本', 'error');
    return;
  }

  openPlayerModal(books.map((book) => book.id), { label: character.name });
}

/** 让模型按世界设定写一段开局场景，作为第一条消息放进会话（独立 requestId，不进聊天窗口的流式监听）。 */
async function generateWorldOpening(convo, books) {
  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint || !endpoint.provider.apiKey) {
    // 还没配好模型，就别硬来了 —— 用户配好之后可以自己开个头
    return;
  }

  setOpeningBusy(convo.id);
  renderMessages({ forceScroll: true });

  try {
    const me = convoUserName(convo);
    const parts = [gmRuleText('', me, convo)];
    const player = convoPlayer(convo);
    if (player && player.profile) parts.push(`【玩家角色：${player.name || me}】\n${player.profile}`);
    const cast = worldbookCast(convo);
    if (cast) parts.push(cast);
    // 开局这段不按关键词，把这几本书的设定尽量都带上，免得开局世界是空的
    const lore = books
      .flatMap((book) => (Array.isArray(book.entries) ? book.entries : []))
      .filter((e) => e && e.enabled !== false && String(e.content || '').trim())
      .slice(0, 40)
      .map((e) => `【${e.title}】\n${String(e.content).trim()}`)
      .join('\n\n');
    if (lore) parts.push(`[世界设定]\n${lore.slice(0, 12000)}`);

    const response = await api.sendChat({
      requestId: `opening-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: [
        { role: 'system', content: parts.join('\n\n') },
        {
          role: 'user',
          content: `（开场）故事开始了。请用一段具体的场景开场：交代「${player && player.name ? player.name : me}」此刻在哪里、正遇到什么，并留下可以行动的方向。不要替玩家做决定。`
        }
      ]
    });

    if (!response || response.ok !== true) throw new Error((response && response.error) || '调用失败');

    const text = String(response.content || '').trim();
    if (!text) return;

    // 生成期间用户可能已经自己说了话，那就别把开局硬插到后面
    if (activeConvo() !== convo || convo.messages.length) return;

    convo.messages = [{ role: 'assistant', content: text, at: now(), greeting: true }];
    convo.updatedAt = now();
    persistConversations(0);
    if (activeConvo() === convo) renderAll({ forceScroll: true });
  } catch (err) {
    console.error('生成开局失败', err);
    if (activeConvo() === convo) showToast('开局没生成出来，直接开始也行', 'error');
  } finally {
    setOpeningBusy(null);
    if (activeConvo() === convo) renderMessages({ forceScroll: true });
  }
}
