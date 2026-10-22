'use strict';

// data/persist.js —— 把内存里的数据写回磁盘
// 会话防抖保存；三个库按已确认基线计算变更，只提交增改与显式删除。
// 角色 / 世界书共用渲染层队列；每个库的一批变更在主进程原子提交，跨库仍非事务。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { CONFIG } from '../core/config.js';
import { showToast } from '../ui/toast.js';
import { characters, worldbooks, dialoguePresets } from './library.js';
import { createLibraryChanges, isSuperseded } from './libraryChanges.js';

const characterChanges = createLibraryChanges({ records: characters,
  save: (change) => api.applyCharacterChanges(change), saveNow: (change) => api.applyCharacterChangesNow(change) });
const worldbookChanges = createLibraryChanges({ records: worldbooks,
  save: (change) => api.applyWorldbookChanges(change), saveNow: (change) => api.applyWorldbookChangesNow(change) });
const presetChanges = createLibraryChanges({ records: dialoguePresets,
  save: (change) => api.applyPresetChanges(change), saveNow: (change) => api.applyPresetChangesNow(change) });

let charactersLoaded = false;
export function markCharactersLoaded() {
  characterChanges.markLoaded();
  charactersLoaded = true;
}

function flushCharacterWorldbooks(synchronous = false) {
  const character = characterChanges.beginBatch();
  let worldbook;
  try { worldbook = worldbookChanges.beginBatch(); }
  catch (err) { character.finish(); throw err; }
  const payload = { characters: character.payload, worldbooks: worldbook.payload };
  const finish = () => { character.finish(); worldbook.finish(); };
  const acknowledge = () => { character.acknowledge(synchronous); worldbook.acknowledge(synchronous); };
  const changed = Object.values(payload).some((change) => change.upserts.length || change.deletes.length);
  if (!changed) { finish(); return; }
  if (synchronous) {
    try { api.applyLibraryChangesNow(payload); acknowledge(); } finally { finish(); }
    return;
  }
  try { return Promise.resolve(api.applyLibraryChanges(payload)).then(acknowledge).finally(finish); }
  catch (err) { finish(); throw err; }
}

let saveTimer = null;

// Keep the committed history on disk while a replacement is still in flight.
const conversationReplacements = new WeakMap();
export function beginConversationReplacement(convo, original) {
  conversationReplacements.set(convo, original);
}
export function endConversationReplacement(convo) {
  conversationReplacements.delete(convo);
}
export function conversationsSavePayload() {
  return {
    conversations: state.conversations.map((convo) => conversationReplacements.get(convo) || convo),
    activeId: state.activeId
  };
}

/**
 * 写盘失败后隔 1.2 秒自动再试一次（主进程退避重试只覆盖约 0.5 秒）：resolve = 真写进去了，reject = 两次都没成。⚠️ 传进来的是**取数据的函数**而不是现成 payload —— 重试要带「重试这一刻」的最新状态。
 */
const WRITE_RETRY_DELAY_MS = 1200;

async function writeWithOneLateRetry(writeOnce) {
  try {
    return await writeOnce();
  } catch (firstErr) {
    if (isSuperseded(firstErr)) throw firstErr;
    console.warn(`[persist] 写盘失败，${WRITE_RETRY_DELAY_MS} 毫秒后自动再试一次`, firstErr);
    await new Promise((r) => setTimeout(r, WRITE_RETRY_DELAY_MS));
    return writeOnce();
  }
}

/**
 * 同一个 key 的写入串起来，永远不并发。⚠️ 防抖只管「何时开始写」，并发时先发出的那次可能后落盘、留下旧快照；队尾必须自己吃掉异常（.then 两个处理函数都要写），否则链永久钉在 rejected、之后每次保存都被跳过。
 */
const writeChains = new Map(); // key → 队尾 Promise

function queueWrite(key, call) {
  const previous = writeChains.get(key) || Promise.resolve();
  const result = previous.then(() => writeWithOneLateRetry(call));
  writeChains.set(
    key,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

/**
 * 写盘失败时统一的说法。⚠️ 别归咎杀软 / 只读属性：真正常见的是**权限判定**（EPERM，进程被降成低完整性，见 main/store.js 文件头），所以带出真正的错误原文、只对确凿的错误码给提示。
 */
function writeFailedText(what, err) {
  const msg = String((err && err.message) || '');
  if (msg.includes('ENOSPC')) return `${what}没能写进磁盘：磁盘空间不够了`;

  // 主进程包了一层「写入失败（xxx.json）：」，这层对用户没意义，剥掉
  const detail = msg.replace(/^写入失败（[^）]*）：/, '').trim();
  const denied = /\bEPERM\b|\bEACCES\b/.test(msg);
  const hint = denied
    ? '（权限被拒 —— 常见是这个程序被沙箱限制在它自己的文件夹里（进程被降成低完整性），' +
      '或者数据目录本身不可写；不是「等一会儿再试」能好的）'
    : '';

  return `${what}没能写进磁盘，这次改动没有生效${hint}${detail ? `：${detail}` : ''}`;
}

export function persistConversations(delay) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    queueWrite('conversations', () =>
      api.saveConversations(conversationsSavePayload())
    ).catch((err) => {
      if (isSuperseded(err)) return;
      console.error('保存会话失败（已自动重试过）', err);
      showToast(writeFailedText('会话', err), 'error');
    });
  }, typeof delay === 'number' ? delay : CONFIG.SAVE_DEBOUNCE_MS);
}

/**
 * 世界书是否成功读进来了。⚠️ 读失败时必须记住：否则随便存一次角色就会把 worldbooks.json 覆盖成空文件。
 */
let worldbooksLoaded = false;

/** 启动时读到世界书后调用（读失败就别调，见上） */
export function markWorldbooksLoaded() {
  worldbookChanges.markLoaded();
  worldbooksLoaded = true;
}

/** 同 worldbooksLoaded：⚠️ 读失败时必须记住，否则存一次角色 / 世界书就会把 presets.json 写空 */
let presetsLoaded = false;

/** 启动时读到预设后调用（读失败就别调，见上） */
export function markPresetsLoaded() {
  presetChanges.markLoaded();
  presetsLoaded = true;
}

/** 关窗只提交未确认变更；带同步回执，任一库失败都阻止无声退出。 */
export function flushLibrariesNow() {
  const errors = [];
  const calls = [];
  if (charactersLoaded && worldbooksLoaded) calls.push(() => flushCharacterWorldbooks(true));
  else {
    if (charactersLoaded) calls.push(() => characterChanges.flushNow());
    if (worldbooksLoaded) calls.push(() => worldbookChanges.flushNow());
  }
  if (presetsLoaded) calls.push(() => presetChanges.flushNow());
  for (const call of calls) {
    try { call(); } catch (err) { errors.push(err.message || String(err)); }
  }
  if (errors.length) throw new Error(errors.join('；'));
}

/** 提交预设变化；immediate = true 时同步等待主进程写盘回执。 */
export function persistPresets(immediate) {
  // 没读进来就什么都别写：写下去等于把文件清空
  if (!presetsLoaded) {
    showToast('预设上次没能读出来，先别改它 —— 重启应用再试', 'error');
    return Promise.resolve(false);
  }

  if (immediate) {
    presetChanges.flushNow();
    return Promise.resolve(true);
  }

  return queueWrite('presets', () => presetChanges.flush())
    .then(() => true)
    .catch((err) => {
      if (isSuperseded(err)) return true;
      console.error('保存预设失败（已自动重试过）', err);
      showToast(writeFailedText('预设', err), 'error');
      return false;
    });
}

/**
 * 提交角色及已加载世界书的变化，返回写盘结果；未变化的记录不发回主进程。
 */
export function persistCharacters(immediate) {
  if (immediate) {
    if (worldbooksLoaded) flushCharacterWorldbooks(true);
    else characterChanges.flushNow();
    return Promise.resolve(true);
  }

  return queueWrite('characters', async () => {
    if (worldbooksLoaded) await flushCharacterWorldbooks();
    else await characterChanges.flush();
  })
    .then(() => true)
    .catch((err) => {
      if (isSuperseded(err)) return true;
      console.error('保存角色失败（已自动重试过）', err);
      showToast(writeFailedText('角色', err), 'error');
      return false;
    });
}

/** 提交角色 / 世界书变化，各文件独立原子写；跨文件失败仍须调用方处理回滚。 */
export async function persistLibrary() {
  // 世界书没读进来就什么都别写：写下去等于把文件清空
  if (!worldbooksLoaded) {
    showToast('世界书上次没能读出来，先别改它 —— 重启应用再试', 'error');
    return false;
  }

  try {
    // 和 persistCharacters 共用一个 key：两者写的都是 characters.json，必须互相排队
    await queueWrite('characters', async () => {
      await flushCharacterWorldbooks();
    });
    return true;
  } catch (err) {
    if (isSuperseded(err)) return true;
    console.error('保存世界书失败（已自动重试过）', err);
    showToast(writeFailedText('世界书', err), 'error');
    return false;
  }
}
