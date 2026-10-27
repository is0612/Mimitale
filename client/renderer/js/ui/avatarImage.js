'use strict';

// ============================================================================
//  ui/avatarImage.js —— 选头像 + 把它压成正方形
//
//  账号头像以 base64 存在本机 JSON 里，原图几 MB 会把它撑爆（角色卡的 avatar
//  就是这么肥起来的，一次教训够了）。所以一律：居中裁剪成正方形 → 256×256 → JPEG 0.8。
//  三处共用：注册第二步、设置页个人信息、以后可能的账号面板。
// ============================================================================

import { api } from '../core/api.js';

/**
 * 头像的字符预算。
 * 服务端 `MAX_AVATAR_CHARS = 60 * 1000` 是硬上限，这里留一档余量，别卡在边界上被拒。
 */
const MAX_CHARS = 50 * 1000;

/**
 * 按预算编码：从 0.8 起，超预算就一档档往下让。
 *
 * 0.8 是量过的：同一张图 256×256 下 q0.9 是 19,079 字符、q0.85 是 17,051、q0.8 是 14,259
 * —— 降到 0.85 只省一成，不值得；0.8 省四分之一，而头像实际显示在 64px 的圆里
 * （4 倍超采样），缩下去根本看不出块效应。
 */
function encodeUnderBudget(canvas) {
  let quality = 0.8;
  let out = canvas.toDataURL('image/jpeg', quality);
  while (out.length > MAX_CHARS && quality > 0.6) {
    quality -= 0.1;
    out = canvas.toDataURL('image/jpeg', quality);
  }
  return out;
}

/**
 * 把任意 data URL 压成 size×size 的 JPEG。
 * @param {string} dataUrl
 * @param {number} [size] 默认 256
 * @returns {Promise<string>} 输出 data URL
 */
export function squareAvatarDataUrl(dataUrl, size = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // 覆盖裁剪：短边铺满，长边居中切掉 —— 直接拉伸会把脸压扁
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(encodeUnderBudget(canvas));
      } catch (err) {
        reject(new Error('头像处理失败'));
      }
    };
    img.onerror = () => reject(new Error('这张图读不出来，换一张'));
    img.src = dataUrl;
  });
}

/**
 * 弹系统选图框 → 压成 256 的 JPEG。
 * @returns {Promise<string>} 取消返回空串（调用方自己判断「没选」和「出错」）
 */
export async function pickAvatarDataUrl({ title = '选一张头像' } = {}) {
  const result = await api.pickImage({ title });
  if (!result || result.canceled) {
    if (result && result.error) throw new Error(result.error);
    return '';
  }
  return squareAvatarDataUrl(result.dataUrl);
}
