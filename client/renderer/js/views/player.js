// ---------------------------------------------------------------------------
//  开始之前：玩家角色弹窗
//
//  「跟角色聊」和「进世界」都要先问一句「你是谁」—— 名字手填，或者挑一张角色卡
//  当自己（选了只是把名字和设定**填**进输入框，填完还能改）。留空也行，那样就
//  以默认的「你」开始。
//
//  同一个弹窗服务这两条路，靠 pendingStart 记住这次是为谁开的；真正「开始」的
//  编排在 views/worldPlay.js（要建会话、种状态面板、切视图），这里只管弹窗本身
//  和「读回填进去的内容」。
//
//  不登记刷新总线：弹窗是「打开时按需重画」的，不参与全局重绘。
// ---------------------------------------------------------------------------

import { el } from '../core/dom.js';
import { characterById, characters, characterAttrs, worldbookById } from '../data/library.js';
import { playerProfileFromCharacter } from '../data/cast.js';

/** 这次弹窗是为哪次「开始」开的；关掉就清空 */
let pendingStart = null;

/**
 * 弹窗现在是为谁开的 —— 给入口层的「开始」按钮用。
 * 目标（书 / 角色）中途被删掉时返回 null，调用方直接关掉弹窗就行。
 */
export function getPlayerStart() {
  if (!pendingStart) return null;
  if (pendingStart.kind === 'world') {
    // ⚠️ 按 id 每次重新解析：弹窗开着的时候书可能被删（返回空就说明一本都不剩了）
    const books = pendingStart.bookIds.map((id) => worldbookById(id)).filter(Boolean);
    return books.length ? { kind: 'world', books, name: pendingStart.name } : null;
  }
  const character = characterById(pendingStart.characterId);
  return character ? { kind: 'chat', character } : null;
}

/** 读弹窗里填的东西（纯读，不写任何东西） */
export function readPlayerDraft() {
  return {
    name: (el.playerName.value || '').trim(),
    profile: (el.playerProfile.value || '').trim(),
    card: characterById(el.playerChar.value) || null
  };
}

/** 下拉框下面那行预览：让「会被带进去的是什么」一眼可见 */
function updatePlayerCharPreview() {
  const host = el.playerCharPreview;
  if (!host) return;

  const character = characterById(el.playerChar.value);
  host.innerHTML = '';
  if (!character) {
    host.classList.add('hidden');
    return;
  }

  const attrs = characterAttrs(character);

  if (character.avatar) {
    const img = document.createElement('img');
    img.src = character.avatar;
    img.alt = '';
    host.appendChild(img);
  }

  const text = document.createElement('span');
  text.textContent = attrs.length
    ? `会带上 ${attrs.length} 个属性：${attrs.map((a) => a.name).join('、')}`
    : '这张卡没有定义属性，只会带上名字和设定';
  host.appendChild(text);

  host.classList.remove('hidden');
}

/** 把「用角色卡当自己」的下拉填好（角色库为空时整块隐藏） */
function renderPlayerCharOptions() {
  if (!el.playerCharField) return;

  // ⚠️ 正在跟谁聊天，就别把 TA 列进「我是谁」：选了等于自己跟自己聊，
  //    开场白里的 {{user}} 会替换成同一个名字，模型也分不清谁是 TA、谁是玩家。
  const chatTarget = pendingStart && pendingStart.kind === 'chat' ? pendingStart.characterId : '';
  const list = characters().filter((c) => c.id !== chatTarget);
  el.playerCharField.classList.toggle('hidden', !list.length);

  el.playerChar.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = list.length ? '（自己写一个）' : '角色库还是空的';
  el.playerChar.appendChild(none);

  for (const c of list) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    el.playerChar.appendChild(opt);
  }

  el.playerChar.value = '';
  updatePlayerCharPreview();
}

/**
 * 选了一张角色卡：把名字和设定填到下面的输入框里。
 * 注意是「填」不是「锁」—— 填完还能改，改了就以你改的为准。
 */
export function applyPlayerCharChoice() {
  const character = characterById(el.playerChar.value);
  if (character) {
    el.playerName.value = character.name;
    el.playerProfile.value = playerProfileFromCharacter(character);
  } else {
    // 选回「自己写一个」：把自动填的东西清掉
    el.playerName.value = '';
    el.playerProfile.value = '';
  }
  updatePlayerCharPreview();
}

/** 打开弹窗并把这次的文案铺好 */
function showPlayerModal({ pending, title, sub, hint, confirmText }) {
  pendingStart = pending;

  if (el.playerTitle) el.playerTitle.textContent = title;
  if (el.playerSub) el.playerSub.textContent = sub;
  if (el.playerFootHint) el.playerFootHint.textContent = hint;
  if (el.btnStartPlay) el.btnStartPlay.textContent = confirmText;

  // 每次打开都重列一遍角色库（可能刚加过新角色），并从空白开始
  renderPlayerCharOptions();
  el.playerName.value = '';
  el.playerProfile.value = '';

  el.playerModal.classList.remove('hidden');
  el.playerName.focus();
}

/** 跟某个角色开聊之前：先定「你是谁」 */
export function openChatPlayerModal(characterId) {
  const character = characterById(characterId);
  if (!character) return;

  showPlayerModal({
    pending: { kind: 'chat', characterId },
    title: `和「${character.name}」聊天`,
    sub: '先定好你是谁，再开始',
    hint: '留空的话，TA 就称呼你「你」',
    confirmText: '开始聊天'
  });
}

/**
 * 进入世界之前：先给这个世界里的自己一个身份。
 * `input` 可以是一本书的 id，也可以是 id 数组（角色卡绑了多本时一起进，见 character.worldbookIds）；
 * `label` 只在多本时用来起名 —— 「进入『露西娅』的世界」比罗列一串书名好听。
 */
export function openPlayerModal(input, { label = '' } = {}) {
  const ids = (Array.isArray(input) ? input : [input]).filter(Boolean);
  const books = ids.map((id) => worldbookById(id)).filter(Boolean);
  if (!books.length) return;

  // 一本就用书名，多本才需要 label —— 这个名字同时也是会话标题（见 worldPlay 的 startWorldPlay）
  const name = books.length === 1
    ? books[0].name
    : (label ? `${label}的世界` : books.map((b) => b.name).join('、'));

  showPlayerModal({
    pending: { kind: 'world', bookIds: books.map((b) => b.id), name },
    title: `进入「${name}」`,
    sub: books.length > 1
      ? `先给这个世界里的自己一个身份 —— 会同时带上这 ${books.length} 本书的设定`
      : '先给这个世界里的自己一个身份，然后就可以开始了',
    hint: '进入世界后会自动打开 GM 模式',
    confirmText: '开始游玩'
  });
}

export function closePlayerModal() {
  el.playerModal.classList.add('hidden');
  pendingStart = null;
}
