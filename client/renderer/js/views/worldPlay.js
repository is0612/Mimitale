'use strict';

// 「开始对话」按下之后的事：建会话、种状态面板、切视图。
// 角色卡开局 = GM 局：卡自带的世界书一起装上，开场白用卡上的（没有就让模型现写一段）。
// 开局那段用独立 requestId 调接口，流式分片不会被聊天窗口接住 —— 写完才一次性落进去。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { characterById, characterWorldbooks, worldbookCharacters, characterForConvo } from '../data/library.js';
import { seedIdentity, seedPanelFromCharacters, mergePlayerOwnedFields } from '../data/panel.js';
import { convoUserName, convoPlayer, worldbookCast, focusCharacterSection } from '../data/cast.js';
import { gmRuleText } from '../data/narration.js';
import { ensureConvoEndpoint } from '../data/providers.js';
import { createConvo } from '../data/conversations.js';
import { persistConversations } from '../data/persist.js';
import { getPlayerStart, readPlayerDraft, closePlayerModal, openChatPlayerModal } from './player.js';
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

/** 弹窗「开始」按下去：读回这次为谁开的；目标中途被删（getPlayerStart 返回 null）直接关窗。 */
export function startPlayerFlow() {
  const start = getPlayerStart();
  if (!start) {
    closePlayerModal();
    return;
  }
  // ⚠️ startCharacterChat 是 async：不接住 rejection 会变成 unhandled rejection。
  startCharacterChat(start.character).catch((err) => {
    console.error('开始对话失败', err);
    showToast((err && err.message) || '开始对话失败', 'error');
  });
}

/**
 * 角色卡开局：进了对话就是 GM 局 —— 叙述者带着这张卡（和卡自带的世界书）讲故事。
 * 开场白用卡上的（多条在「你是谁」弹窗里挑）；一条都没有再让模型现写。
 */
async function startCharacterChat(character) {
  if (!character) return;

  const draft = readPlayerDraft() || {};

  // ⚠️ 玩家名和 TA 同名 = 自己跟自己聊：模型分不清谁是 TA、谁是玩家（表现是「我本来在第三者位置，怎么成了角色本人」）。
  //    这里只挡下来，弹窗还开着，改个名字再点开始就行。
  if (draft.name && character.name && draft.name.trim() === String(character.name).trim()) {
    showToast(`「${character.name}」是这一局的主要角色 —— 换成你自己的名字再开始`, 'error');
    el.playerName.focus();
    return;
  }

  createConvo(true);
  const convo = activeConvo();
  applyPlayerIdentity(convo, draft);

  // ⚠️ 先种「你自己」再种别的卡：同名以先出现的为准，自己卡上的「金币」不会被书里的盖掉。
  if (draft.card) {
    seedIdentity(convo, draft.name, 'player');
    seedPanelFromCharacters(convo, [draft.card], 'player');
  }

  // 角色卡局固定是世界（GM）模式 —— 视角里已经没有开关可关，isGmMode 也认「有卡即 GM」。
  // 字段照样写：磁盘上的数据得和行为对得上（导出 / 排查都看它）。
  // 卡自带的世界书由 effectiveWorldbookIds 回落取到，不拷进 convo.worldbookIds ——
  // 拷了就成了快照，卡上换书后老会话不再跟随。
  convo.gmMode = true;
  const books = characterWorldbooks(character);
  for (const book of books) seedPanelFromCharacters(convo, worldbookCharacters(book));

  // ⚠️ 开场白在「你是谁」弹窗里就挑好了（多条才有那一块），这里只把下标带过去。
  //    必须等它跑完再关弹窗：renderAll 里会重铺界面，弹窗还开着的时候切视图会留下残影。
  await applyCharacterChoice(character.id, draft.opening);

  // 绑定之后才并：挑的卡可能也在书里当 NPC 副本，撞名时把副本那份收回来，
  // 否则同一个人占两张状态卡、属性存两份。
  mergePlayerOwnedFields(convo);

  closePlayerModal();
  showView('chat');
  renderAll({ forceScroll: true });
  persistConversations(0);

  showToast(`进入「${character.name}」的故事 —— 你是「${convoUserName(convo)}」`, 'ok');
  el.input.focus();

  // 卡上没写开场白：交给模型按设定现写一段（失败也不影响玩，只是开局空着）
  if (!convo.messages.length) generateWorldOpening(convo, books);
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

/** 让模型按卡和世界的设定写一段开局场景，作为第一条消息放进会话（独立 requestId，不进聊天窗口的流式监听）。 */
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
    // 主要角色和世界 NPC 走正式对话同一套注入，开局里的人不会凭空出现
    const focus = focusCharacterSection(convo);
    if (focus) parts.push(focus);
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

    // 主要角色在场时点名 TA，开局才知道围绕谁来写；没绑卡就只交代玩家
    const hero = characterForConvo(convo);
    const playerLabel = player && player.name ? player.name : me;
    const who = hero && hero.name ? `「${hero.name}」与「${playerLabel}」` : `「${playerLabel}」`;

    const response = await api.sendChat({
      requestId: `opening-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: [
        { role: 'system', content: parts.join('\n\n') },
        {
          role: 'user',
          content: `（开场）故事开始了。请用一段具体的场景开场：交代${who}此刻在哪里、正遇到什么，并留下可以行动的方向。不要替玩家做决定。`
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
