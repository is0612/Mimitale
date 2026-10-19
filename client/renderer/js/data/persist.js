'use strict';

// data/persist.js —— 把内存里的数据写回磁盘
// 会话防抖保存；角色库 / 世界书是两个文件，但主进程允许一次写入带上两者，所以走 persistLibrary() 一起落盘。
// 三个入口都在写角色库，所以 persistCharacters / persistLibrary 沉在这儿。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { CONFIG } from '../core/config.js';
import { showToast } from '../ui/toast.js';
import { characters, worldbooks, dialoguePresets } from './library.js';

let saveTimer = null;

/**
 * 写盘失败后隔 1.2 秒自动再试一次（主进程退避重试只覆盖约 0.5 秒）：resolve = 真写进去了，reject = 两次都没成。⚠️ 传进来的是**取数据的函数**而不是现成 payload —— 重试要带「重试这一刻」的最新状态。
 */
const WRITE_RETRY_DELAY_MS = 1200;

async function writeWithOneLateRetry(writeOnce) {
  try {
    return await writeOnce();
  } catch (firstErr) {
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
      api.saveConversations({ conversations: state.conversations, activeId: state.activeId })
    ).catch((err) => {
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
  worldbooksLoaded = true;
}

/** 同 worldbooksLoaded：⚠️ 读失败时必须记住，否则存一次角色 / 世界书就会把 presets.json 写空 */
let presetsLoaded = false;

/** 启动时读到预设后调用（读失败就别调，见上） */
export function markPresetsLoaded() {
  presetsLoaded = true;
}

/** 把当前预设写回磁盘（单独一个文件，不受角色 / 世界书影响）；immediate = true 时立刻写、不等下一帧 */
export function persistPresets(immediate) {
  // 没读进来就什么都别写：写下去等于把文件清空
  if (!presetsLoaded) {
    showToast('预设上次没能读出来，先别改它 —— 重启应用再试', 'error');
    return Promise.resolve(false);
  }

  const buildPayload = () => ({ presets: dialoguePresets() });

  if (immediate) {
    api.savePresetsNow(buildPayload());
    return Promise.resolve(true);
  }

  return queueWrite('presets', () => api.savePresets(buildPayload()))
    .then(() => true)
    .catch((err) => {
      console.error('保存预设失败（已自动重试过）', err);
      showToast(writeFailedText('预设', err), 'error');
      return false;
    });
}

/**
 * 把角色库写回磁盘，**返回是否真的写成功了**（调用方靠它决定要不要报「已保存」）。⚠️ 只在 worldbooksLoaded 时才带 worldbooks，否则「存一次角色」会把 worldbooks.json 写空；immediate 走 ipcRenderer.send、没有回执。
 */
export function persistCharacters(immediate) {
  const buildPayload = () => {
    const payload = { characters: characters() };
    if (worldbooksLoaded) payload.worldbooks = worldbooks();
    return payload;
  };

  if (immediate) {
    api.saveCharactersNow(buildPayload());
    return Promise.resolve(true);
  }

  return queueWrite('characters', () => api.saveCharacters(buildPayload()))
    .then(() => true)
    .catch((err) => {
      console.error('保存角色失败（已自动重试过）', err);
      showToast(writeFailedText('角色', err), 'error');
      return false;
    });
}

/** 把角色库 + 世界书写回磁盘（两个文件，主进程允许一次写入带上两者）；返回是否成功 —— 绑定失败时界面要回滚，不能假装成功 */
export async function persistLibrary() {
  // 世界书没读进来就什么都别写：写下去等于把文件清空
  if (!worldbooksLoaded) {
    showToast('世界书上次没能读出来，先别改它 —— 重启应用再试', 'error');
    return false;
  }

  try {
    // 和 persistCharacters 共用一个 key：两者写的都是 characters.json，必须互相排队
    await queueWrite('characters', () =>
      api.saveCharacters({ characters: characters(), worldbooks: worldbooks() })
    );
    return true;
  } catch (err) {
    console.error('保存世界书失败（已自动重试过）', err);
    showToast(writeFailedText('世界书', err), 'error');
    return false;
  }
}
