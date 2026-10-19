'use strict';

// ============================================================================
//  data/export.js —— 统一的导出收尾
//
//  只管「调保存框、报结果」这一步，具体导出什么内容由调用方组装。
//  放在 data 层而不是 core：它要用 showToast（ui 层），而 core 不能再往上依赖 ui。
//
//  入口层的角色卡 / 对话导出、世界书编辑器里的「导出本书」都走这里 ——
//  两头都要用，所以不能跟着任何一头走。
// ============================================================================

import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';

/** 统一的导出收尾：调保存框、报结果 */
export async function saveExport(payload) {
  let result;
  try {
    result = await api.saveFile(payload);
  } catch (err) {
    showToast((err && err.message) || '导出失败', 'error');
    return;
  }

  if (!result || result.canceled) return;
  if (result.error) {
    showToast(`没能写出文件：${result.error}`, 'error');
    return;
  }
  showToast('已导出到磁盘', 'ok');
}

/**
 * 批量导出的收尾：选一个文件夹，把一组文件写进去。
 *
 * 和 saveExport 的差别不只是「多个文件」—— 它的失败是**部分失败**：
 * 写出去的那几个已经在盘上了，所以不能一句「导出失败」糊过去，
 * 要按实际写出几个报数，不然用户会以为白干。
 *
 * @param {{title?: string, files: Array<{fileName: string, text: string}>}} payload
 * @returns {Promise<{dir: string, written: string[], failed: Array}|null>} 取消 / 全失败时 null
 */
export async function saveExportMany(payload) {
  let result;
  try {
    result = await api.saveFiles(payload);
  } catch (err) {
    showToast((err && err.message) || '导出失败', 'error');
    return null;
  }

  if (!result || result.canceled) return null;

  const written = Array.isArray(result.written) ? result.written : [];
  const failed = Array.isArray(result.failed) ? result.failed : [];

  if (!written.length) {
    const reason = failed.length ? failed[0].error : '没有写入任何文件';
    showToast(`一个文件都没写出去：${reason}`, 'error');
    return null;
  }
  if (failed.length) {
    showToast(`已导出 ${written.length} 个，${failed.length} 个失败（${failed[0].fileName}）`, 'error');
  } else {
    showToast(`已导出 ${written.length} 个文件`, 'ok');
  }
  return result;
}
