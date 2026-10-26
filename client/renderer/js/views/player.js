// ---------------------------------------------------------------------------
//  开始之前：玩家角色弹窗
//
//  「和角色卡开局」要先问一句「你是谁」—— 名字手填，或者挑一张角色卡
//  当自己（选了只是把名字和设定**填**进输入框，填完还能改）。留空也行，那样就
//  以默认的「你」开始。
//
//  弹窗只记 pendingStart 里这一次开的是哪张卡；真正「开始」的编排在
//  views/worldPlay.js（要建会话、种状态面板、切视图），这里只管弹窗本身
//  和「读回填进去的内容」。
//
//  不登记刷新总线：弹窗是「打开时按需重画」的，不参与全局重绘。
// ---------------------------------------------------------------------------

import { el } from '../core/dom.js';
import { characterById, characters, characterAttrs, greetingChoices } from '../data/library.js';
import { playerProfileFromCharacter } from '../data/cast.js';

/** 这次弹窗是为哪张卡开的；关掉就清空 */
let pendingStart = null;

/** 这次选中的开场白下标（0 = 第一条）。只有一条时它恒为 0，用户看不到选择区 */
let openingIndex = 0;

// 开场白预览截断到多少个字。**只截显示、不截数据** —— 真正插进会话的是完整原文。
const OPENING_PREVIEW_CHARS = 140;

/**
 * 弹窗现在是为谁开的 —— 给入口层的「开始」按钮用。
 * 目标卡中途被删掉时返回 null，调用方直接关掉弹窗就行。
 */
export function getPlayerStart() {
  if (!pendingStart) return null;
  const character = characterById(pendingStart.characterId);
  return character ? { kind: 'chat', character } : null;
}

/** 读弹窗里填的东西（纯读，不写任何东西） */
export function readPlayerDraft() {
  return {
    name: (el.playerName.value || '').trim(),
    profile: (el.playerProfile.value || '').trim(),
    card: characterById(el.playerChar.value) || null,
    opening: openingIndex
  };
}

/**
 * 铺开场白候选。
 * 一条就不出现（那是单选题，摆出来只是让人多点一下）；0 条更不用说 —— 那时候开局交给模型现写。
 */
function renderPlayerOpenings(character) {
  const field = el.playerOpeningField;
  const list = el.playerOpeningList;
  if (!field || !list) return;

  const greetings = greetingChoices(character);
  openingIndex = 0;
  list.textContent = '';
  field.classList.toggle('hidden', greetings.length < 2);
  if (greetings.length < 2) return;

  if (el.playerOpeningHelp) {
    el.playerOpeningHelp.textContent = `这张卡带了 ${greetings.length} 条开场白 —— 同一个场景的不同入场方式，挑一条当这次的开头。`;
  }

  greetings.forEach((text, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'opening-item';
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', index === 0 ? 'true' : 'false');
    row.dataset.index = String(index);

    const head = document.createElement('span');
    head.className = 'opening-item-head';

    const no = document.createElement('span');
    no.className = 'opening-item-no';
    no.textContent = String(index + 1);
    head.appendChild(no);

    if (index === 0) {
      const note = document.createElement('span');
      note.className = 'opening-item-note';
      note.textContent = '默认';
      head.appendChild(note);
    }

    // 选中标记靠字符而不是只靠颜色：暗色主题下「淡底 + 亮边框」在缩略图里几乎看不出来
    const mark = document.createElement('span');
    mark.className = 'opening-item-mark';
    mark.textContent = '✓';
    head.appendChild(mark);

    const body = document.createElement('span');
    body.className = 'opening-item-text';
    // ⚠️ 卡里的文字是不可信内容，一律 textContent（老规矩：不许开 HTML 注入面）
    const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
    body.textContent = flat.length > OPENING_PREVIEW_CHARS ? `${flat.slice(0, OPENING_PREVIEW_CHARS)}…` : flat;

    row.appendChild(head);
    row.appendChild(body);
    list.appendChild(row);
  });
}

/** 点了一条开场白：换选中态（单选，同一时间只有一条 aria-checked） */
export function applyPlayerOpeningChoice(event) {
  const list = el.playerOpeningList;
  const row = event.target && event.target.closest ? event.target.closest('.opening-item') : null;
  if (!list || !row) return;

  openingIndex = Number(row.dataset.index) || 0;
  for (const item of list.children) {
    item.setAttribute('aria-checked', item === row ? 'true' : 'false');
  }
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

/** 把「用角色卡当自己」的下拉填好（角色卡为空时整块隐藏） */
function renderPlayerCharOptions() {
  if (!el.playerCharField) return;

  // ⚠️ 正在跟谁开局，就别把 TA 列进「我是谁」：选了等于自己跟自己聊，
  //    开场白里的 {{user}} 会替换成同一个名字，模型也分不清谁是 TA、谁是玩家。
  const chatTarget = pendingStart ? pendingStart.characterId : '';
  const list = characters().filter((c) => c.id !== chatTarget);
  el.playerCharField.classList.toggle('hidden', !list.length);

  el.playerChar.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = list.length ? '（自己写一个）' : '角色卡还是空的';
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
function showPlayerModal({ pending, title, sub, hint, confirmText, character }) {
  pendingStart = pending;

  if (el.playerTitle) el.playerTitle.textContent = title;
  if (el.playerSub) el.playerSub.textContent = sub;
  if (el.playerFootHint) el.playerFootHint.textContent = hint;
  if (el.btnStartPlay) el.btnStartPlay.textContent = confirmText;

  // 每次打开都重列一遍角色卡（可能刚加过新角色），并从空白开始
  renderPlayerCharOptions();
  renderPlayerOpenings(character);
  el.playerName.value = '';
  el.playerProfile.value = '';

  el.playerModal.classList.remove('hidden');
  el.playerName.focus();
}

/** 和某张角色卡开局之前：先定「你是谁」 */
export function openChatPlayerModal(characterId) {
  const character = characterById(characterId);
  if (!character) return;

  showPlayerModal({
    pending: { kind: 'chat', characterId },
    character,
    title: `和「${character.name}」对话`,
    sub: '先定好你是谁，再开始',
    hint: '进入对话后会自动打开 GM 模式',
    confirmText: '开始对话'
  });
}

export function closePlayerModal() {
  el.playerModal.classList.add('hidden');
  pendingStart = null;
}
