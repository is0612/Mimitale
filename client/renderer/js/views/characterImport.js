'use strict';

// views/characterImport.js —— 「导入角色卡」这条通道
// 与「导入世界书」共用 pickImportFiles（两者只差按钮 / 忙时文案 / 落点）
// 导入的东西要重发 id（含角色 → 世界书的指向），见 data/library-reissue.js

import { CONFIG } from '../core/config.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { showToast } from '../ui/toast.js';
import { characters, worldbooks } from '../data/library.js';
import { persistCharacters } from '../data/persist.js';
import { reissueImportedIds } from '../data/library-reissue.js';
import { cropTopToDataUrl } from '../ui/imageCrop.js';
import { renderCharacterPage } from './characterList.js';

// 同一毫秒里连导几次也不会撞车
let importSeq = 0;

let actions = { openEditor: () => {} };

function reissueImported(books, chars) {
  importSeq += 1;
  return reissueImportedIds(books, chars, `${Date.now().toString(36)}-${importSeq}`);
}

// 封面按 2:3 竖版输出（和编辑器里「换封面」同一个尺寸，见 views/worldbook.js 的 WB_COVER_*）
const BOOK_COVER_ASPECT = 2 / 3;
const BOOK_COVER_WIDTH = 800;

/**
 * 角色卡自带的世界书（酒馆的 character_book）导进来时**没有封面** ——
 * 把这张卡的立绘裁成 2:3 铺上去，列表里一眼认得出是哪个世界。
 *
 * 只补空封面（书里自己带了封面的不动）；裁不出来就留空（卡片退回「世」字占位块），
 * 一张图坏掉不该连累整次导入。
 * @param {object[]} books 已重发过 id 的世界书
 * @param {object[]} chars 已重发过 id 的角色（靠 worldbookIds 找书的归属）
 * ⚠️ 导出只为冒烟测试能直接调（导入流程本身在弹窗后面，点不到中间态）。
 */
export async function seedBookCovers(books, chars) {
  for (const book of books) {
    if (!book || book.cover) continue;
    const owner = chars.find(
      (c) => Array.isArray(c.worldbookIds) && c.worldbookIds.includes(book.id)
    );
    const avatar = owner && typeof owner.avatar === 'string' ? owner.avatar : '';
    if (!avatar.startsWith('data:image/')) continue;
    try {
      book.cover = await cropTopToDataUrl(avatar, { aspect: BOOK_COVER_ASPECT, outWidth: BOOK_COVER_WIDTH });
    } catch (err) {
      console.warn('[导入] 世界书封面没能从角色形象生成', err);
    }
  }
}

// 弹文件框 → 解析 → 重发 id，两个导入入口共用
// @returns null = 取消 / 出错 / 没有内容，调用方直接 return
export async function pickImportFiles({ before, button, busyText, idleText } = {}) {
  if (before) before();

  let result = null;
  try {
    if (button) {
      // loading：转圈圈 + 期间不可点（按钮组件自带的，见 components/button.js）
      button.loading = true;
      if (busyText) button.textContent = busyText;
    }
    result = await api.importCard();
  } catch (err) {
    showToast((err && err.message) || '导入失败', 'error');
    return null;
  } finally {
    if (button) {
      button.loading = false;
      if (idleText) button.textContent = idleText;
    }
  }

  if (!result || result.canceled) return null;

  const added = Array.isArray(result.characters) ? result.characters : [];
  const addedBooks = Array.isArray(result.worldbooks) ? result.worldbooks : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];

  if (!added.length && !addedBooks.length) {
    showToast(errors.length ? errors[0] : '没有导入任何内容', 'error');
    return null;
  }

  const { books: freshBooks, chars: freshChars } = reissueImported(addedBooks, added);
  // 卡里带的世界书没封面 → 用这张卡的立绘补一张（必须在落盘之前，见 seedBookCovers）
  await seedBookCovers(freshBooks, freshChars);
  return { freshBooks, freshChars, errors };
}

// 隔一会儿再补一条，不然会被前一条提示盖掉
export function warnImportErrors(errors) {
  if (!errors.length) return;
  console.warn('部分内容导入失败：', errors);
  setTimeout(
    () => showToast(`${errors.length} 个文件没能导入：${errors[0]}`, 'error'),
    CONFIG.TOAST_DURATION_MS + 300
  );
}

async function importCards() {
  const picked = await pickImportFiles({
    before: () => actions.stashForm(),
    button: el.btnImportCard,
    busyText: '导入中…',
    idleText: '导入角色卡',
  });
  if (!picked) return;

  const { freshBooks, freshChars, errors } = picked;

  state.worldbooks = [...worldbooks(), ...freshBooks];
  state.characters = [...characters(), ...freshChars];

  renderCharacterPage();
  if (freshChars.length) actions.openEditor(freshChars[0].id);

  // 写盘失败就别报「已导入」，导入的东西留在界面上
  if (!(await persistCharacters())) return;

  const parts = [];
  if (freshChars.length) parts.push(`${freshChars.length} 个角色：${freshChars.map((c) => c.name).join('、')}`);
  if (freshBooks.length) parts.push(`${freshBooks.length} 个世界书`);
  showToast(`已导入 ${parts.join('，')}`, 'ok');

  warnImportErrors(errors);
}

export function initCharacterImport(injected) {
  actions = { openEditor: () => {}, stashForm: () => {}, ...(injected || {}) };

  el.btnImportCard.addEventListener('click', importCards);
}
