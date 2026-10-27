'use strict';

//  views/chatExport.js —— 角色卡（PNG / JSON）与当前会话（Markdown）的导出。
//  世界书的导出在世界书编辑器里（views/worldbook.js），不在这儿。
//  格式对齐导入链能读的形状，导出的东西能再导回来。

import { activeConvo, safeFileName } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { saveExport, saveExportMany } from '../data/export.js';
import {
  characterAttrs,
  characterForConvo,
  characters,
  effectiveWorldbookIds,
  worldbookById,
  characterBookPayload
} from '../data/library.js';
import { convoPanel, convoPanelFields, panelFieldName, panelKeyParts, panelOwnerLabel } from '../data/panel.js';
import { convoPlayer, userName, speakerName } from '../data/cast.js';

/** 不能用裸 btoa：它只吃 Latin-1，中文会直接抛错 */
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 角色卡（酒馆 v2 规范）：自家字段放 extensions.mimitale。⚠️ 导出是 smoke-test 验「备选开场白 / 作者 / 版本」能被写回的唯一入口；withImages：JSON 必须带图（否则导回来全丢），PNG 不带。 */
export function characterCardPayload(character, options = {}) {
  const withImages = options.withImages === true;
  // 只带第一本：v2 规范里 character_book 是单本（酒馆同样只导出主世界书）
  const boundId = Array.isArray(character.worldbookIds) ? character.worldbookIds[0] : null;
  const boundBook = boundId ? worldbookById(boundId) : null;

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: character.name || '',
      description: character.description || '',
      personality: character.personality || '',
      scenario: character.scenario || '',
      first_mes: character.firstMes || '',
      mes_example: character.mesExample || '',
      creator_notes: character.creatorNotes || '',
      system_prompt: character.systemPrompt || '',
      post_history_instructions: character.postHistoryInstructions || '',
      tags: Array.isArray(character.tags) ? character.tags : [],
      // ⚠️ 写死成 `[]` 的话，导入再导出会把备选开场白抹成 0 条
      alternate_greetings: Array.isArray(character.alternateGreetings) ? character.alternateGreetings : [],
      ...(boundBook ? { character_book: characterBookPayload(boundBook) } : {}),
      // 同上：creator / character_version 也从角色上带出来，别写死空串
      creator: character.creator || '',
      character_version: character.characterVersion || '',
      extensions: {
        mimitale: {
          attributes: characterAttrs(character),
          ...(Array.isArray(character.expressions) && character.expressions.length
            ? { expressions: character.expressions }
            : {}),
          // 只有 JSON 导出才带图（见函数头：PNG 导出时图就是文件本身）
          ...(withImages && typeof character.avatar === 'string' && character.avatar
            ? { avatar: character.avatar }
            : {}),
          ...(withImages && typeof character.portrait === 'string' ? { portrait: character.portrait } : {})
        }
      }
    }
  };
}

/** 当前会话导出成 Markdown */
function conversationMarkdown(convo) {
  const lines = [];
  const character = characterForConvo(convo);
  const player = convoPlayer(convo);

  lines.push(`# ${convo.title || '对话'}`);
  lines.push('');
  const meta = [];
  if (character) meta.push(`角色：${character.name}`);
  if (player && player.name) meta.push(`我：${player.name}`);
  const book = effectiveWorldbookIds(convo)
    .map((id) => worldbookById(id))
    .find(Boolean);
  if (book) meta.push(`世界：${book.name}`);
  meta.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(`> ${meta.join(' · ')}`);
  lines.push('');

  // 状态面板单独列一段：正文里那几行注入时会被剥掉，导出的快照留着更有用
  const panelFields = convoPanelFields(convo);
  const panel = convoPanel(convo);
  const filled = panelFields.filter((key) => String(panel[key] || '').trim());
  if (filled.length) {
    lines.push('## 当前状态');
    lines.push('');
    for (const key of filled) {
      const { owner } = panelKeyParts(key);
      const label = owner ? `${panelOwnerLabel(convo, owner)}·` : '';
      lines.push(`- ${label}${panelFieldName(key)}：${panel[key]}`);
    }
    lines.push('');
  }

  lines.push('## 对话');
  lines.push('');
  for (const message of convo.messages || []) {
    const content = String(message.content || '').trim();
    if (!content) continue;
    if (message.role === 'user') lines.push(`**${player && player.name ? player.name : userName()}：**`);
    else if (message.role === 'error') lines.push('**（出错了）**');
    else lines.push(`**${character ? character.name : speakerName(convo) || 'AI'}：**`);
    lines.push('');
    lines.push(content);
    lines.push('');
  }

  return lines.join('\n');
}

/** 角色头像 → PNG 数据（没有头像就画一张带首字母的占位图） */
function avatarPngDataUrl(character) {
  return new Promise((resolve) => {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      resolve('');
      return;
    }

    const placeholder = () => {
      ctx.fillStyle = '#4a86e8';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${Math.round(size * 0.42)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((character.name || '?').slice(0, 1), size / 2, size / 2 + 8);
      resolve(canvas.toDataURL('image/png'));
    };

    if (!character.avatar) {
      placeholder();
      return;
    }

    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        const out = canvas.toDataURL('image/png');
        if (out.startsWith('data:image/png')) resolve(out);
        else placeholder();
      } catch (err) {
        placeholder();
      }
    };
    img.onerror = placeholder;
    img.src = character.avatar;
  });
}

/** 把一张角色卡写成 .png / .json：角色卡卡片右上角的「导出」和批量导出共用。
 *  ⚠️ 编辑器里那颗「导出」2026-10-20 撤了 —— 同一张卡在列表上就能拿走，
 *  两个入口并列只会让人以为它们导出的东西不一样。 */
export async function exportCharacterCard(character) {
  if (!character) return;

  const name = safeFileName(character.name);
  // 两份 JSON：带图那份给 .json（导回来才不丢头像），不带图那份塞 PNG 的 tEXt 块
  const json = JSON.stringify(characterCardPayload(character, { withImages: true }), null, 2);
  const pngJson = JSON.stringify(characterCardPayload(character), null, 2);
  const png = await avatarPngDataUrl(character);
  // 空 base64 别当 PNG 存出去；直接切成导出 JSON，别让用户再点一次同一个按钮
  if (!png) {
    showToast('头像生成失败，改为导出 JSON 角色卡', 'error');
    await saveExport({
      title: '导出角色卡（JSON）',
      fileName: `${name}.json`,
      filters: [{ name: 'JSON 角色卡（纯数据，方便改）', extensions: ['json'] }],
      text: json
    });
    return;
  }

  await saveExport({
    title: '导出角色卡',
    fileName: `${name}.png`,
    filters: [
      { name: 'PNG 角色卡（带数据，酒馆可直接导入）', extensions: ['png'] },
      { name: 'JSON 角色卡（纯数据，方便改）', extensions: ['json'] }
    ],
    // 用户把后缀改回 .json 时走的是这一份 —— 带图，别丢
    text: json,
    base64: String(png).split(',')[1] || '',
    pngText: { keyword: 'chara', text: base64Utf8(pngJson) }
  });
}

/** 角色卡卡片上的「导出」：按 id 取已落盘的那一张，不用先进详情页 */
export async function exportCharacterById(id) {
  const character = characters().find((c) => c.id === id);
  if (!character) {
    showToast('找不到这个角色，可能刚被删除', 'error');
    return;
  }
  return exportCharacterCard(character);
}

/** 批量导出：每张一个 .json（带头像 / 立绘）。单张 PNG 走编辑器或角色卡卡片上的「导出」。 */
export async function exportCharactersByIds(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const list = characters().filter((c) => wanted.has(c.id));
  if (!list.length) {
    showToast('没有选中任何角色', 'error');
    return null;
  }

  return saveExportMany({
    title: `导出 ${list.length} 个角色卡`,
    files: list.map((character) => ({
      fileName: `${safeFileName(character.name || '未命名角色')}.json`,
      text: JSON.stringify(characterCardPayload(character, { withImages: true }), null, 2)
    }))
  });
}

/** 导出当前会话为 Markdown */
export async function exportConversation() {
  const convo = activeConvo();
  if (!convo || !(convo.messages || []).length) {
    showToast('当前会话还是空的', 'error');
    return;
  }

  await saveExport({
    title: '导出对话',
    fileName: `${safeFileName(convo.title || '对话')}.md`,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '纯文本', extensions: ['txt'] }
    ],
    text: conversationMarkdown(convo)
  });
}
