'use strict';

// ============================================================================
//  ui/voucherCard.js —— 画那张「登录凭证」卡片（1024×640 PNG）
//
//  2026-10-23 从 views/accountModal.js 抽出来：账号面板搬进设置页之后，
//  只有「个人中心」一处画它，但画法跟会话 / 账号面板都无关，属界面件。
//
//  ⚠️ 用 canvas 现画而不是预先存一张底图：换配色 / 换文案时不用重新导资源，
//     而且头像、用户名、凭证码全是动态的。
//  ⚠️ 凭证码是「24 位 + 手动拉开字距」，38px 下会顶出右边缘（出图核过），
//     所以按可用宽度往回缩字号 —— 别改回固定字号。
//
//  2026-10-23 起这张 PNG 里**还写着凭证码本身**（PNG 的 tEXt 块），
//  登录面板「导入凭证图片」靠它把码读回来 —— 见文件末尾那节说明。
// ============================================================================

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function formatDate(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * @param {{code: string, username?: string, email?: string, avatar?: string, createdAt?: string}} info
 * @returns {Promise<string>} PNG 的 data URL
 */
export async function drawVoucherCard(info) {
  const data = info || {};
  const W = 1024;
  const H = 640;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 底：深色渐变（跟应用夜间底色同一档）
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#171a18');
  bg.addColorStop(0.55, '#1b1f1c');
  bg.addColorStop(1, '#121512');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 一圈细描边 + 内层暖色线
  ctx.strokeStyle = 'rgba(203, 184, 143, 0.28)';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, W - 48, H - 48);
  ctx.strokeStyle = 'rgba(203, 184, 143, 0.10)';
  ctx.lineWidth = 1;
  ctx.strokeRect(36, 36, W - 72, H - 72);

  // 顶部：产品名（左）+ 用途（右）
  ctx.fillStyle = '#e8e4d8';
  ctx.font = '600 26px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('如我所书', 64, 96);
  ctx.fillStyle = 'rgba(203, 184, 143, 0.75)';
  ctx.font = '500 14px Consolas, "Courier New", monospace';
  ctx.fillText('M I M I T A L E', 66, 122);

  ctx.fillStyle = 'rgba(232, 228, 216, 0.45)';
  ctx.font = '500 13px Consolas, "Courier New", monospace';
  ctx.textAlign = 'right';
  ctx.fillText('SIGN-IN PASS', W - 64, 96);
  ctx.textAlign = 'left';

  // 头像：圆形，没设头像就画名字首字
  const cx = 128;
  const cy = 258;
  const r = 52;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const avatarImg = await loadImage(data.avatar);
  if (avatarImg) {
    // 覆盖裁剪（和界面里那颗头像同一套算法）
    const scale = Math.max((r * 2) / avatarImg.width, (r * 2) / avatarImg.height);
    const w = avatarImg.width * scale;
    const h = avatarImg.height * scale;
    ctx.drawImage(avatarImg, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = '#2a2f2a';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = 'rgba(232, 228, 216, 0.7)';
    ctx.font = '600 40px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Array.from(data.username || '·')[0] || '·', cx, cy + 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(203, 184, 143, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // 用户名 / 邮箱
  ctx.fillStyle = '#f0ede4';
  ctx.font = '600 34px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(data.username || '未命名', 208, 250);
  ctx.fillStyle = 'rgba(232, 228, 216, 0.55)';
  ctx.font = '400 18px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(data.email || '', 208, 284);

  // 分隔线
  ctx.strokeStyle = 'rgba(203, 184, 143, 0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(64, 350);
  ctx.lineTo(W - 64, 350);
  ctx.stroke();

  // 凭证码：等宽 + 拉开字距，方便手抄
  ctx.fillStyle = 'rgba(232, 228, 216, 0.45)';
  ctx.font = '500 13px "Microsoft YaHei UI", sans-serif';
  ctx.fillText('登录凭证码', 64, 398);

  const code = String(data.code || '');
  // 手动拉开字距（ctx.letterSpacing 在旧 Chromium 上不一定有）
  const spaced = code.split('').join(' ');
  const maxCodeWidth = W - 128;
  let codeSize = 38;
  ctx.font = `600 ${codeSize}px Consolas, "Courier New", monospace`;
  while (codeSize > 18 && ctx.measureText(spaced).width > maxCodeWidth) {
    codeSize -= 2;
    ctx.font = `600 ${codeSize}px Consolas, "Courier New", monospace`;
  }
  ctx.fillStyle = '#e8e4d8';
  ctx.fillText(spaced, 64, 450);

  // 底部说明
  ctx.fillStyle = 'rgba(232, 228, 216, 0.38)';
  ctx.font = '400 14px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('凭这串码可以在其它设备登录，不需要密码 —— 别把它发给别人', 64, 546);

  ctx.textAlign = 'right';
  ctx.fillText(`签发于 ${formatDate(data.createdAt)}`, W - 64, 546);
  ctx.textAlign = 'left';

  ctx.fillStyle = 'rgba(203, 184, 143, 0.45)';
  ctx.font = '500 12px Consolas, "Courier New", monospace';
  ctx.fillText('THIS PASS CONTAINS NO PASSWORD', 64, 578);

  return embedVoucherCodeInPng(canvas.toDataURL('image/png'), code);
}

// ---------------------------------------------------------------------------
//  把凭证码写进 PNG —— 「导入凭证图片登录」就是靠这个
//
//  为什么不用识别图上的字：OCR 要拖一套模型进来，还会认错（0/O、1/I 本来就是
//  凭证码里被剔掉的字符，但 B/8、G/6 照样能看错）。而这张卡**是我们自己画的**，
//  把码写进 PNG 的 tEXt 块最省事：导出 → 导入 完全无损，不用认字。
//
//  ⚠️ 只对 PNG **原图**有效。截图、微信/QQ 转发、任何「另存为」都会重编码图片，
//     自定义块会被丢掉 —— 那种情况界面必须老实提示「手动抄码」，别假装能读。
//  ⚠️ 这不是加密：卡面上本来就印着这串码，写进元数据不多泄露一个字。
//  ⚠️ 走 canvas.toDataURL 之后必须**在渲染层**拼块。交给主进程的 nativeImage
//     会重新编码，元数据当场没了。
// ---------------------------------------------------------------------------

const VOUCHER_TEXT_KEYWORD = 'MimitaleVoucher';

let crcTable = null;

/** PNG 规定每块末尾一个 CRC32（多项式 0xEDB88320，反序计算） */
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dataUrlToBytes(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  if (!/^data:[^,]*,/.test(text) || !/^data:[^;]*;base64,/i.test(text)) return null;
  const binary = atob(text.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToDataUrl(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasPngSignature(bytes) {
  if (!bytes || bytes.length < 8) return false;
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeUint32(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** 遍历 PNG 块：回调拿到 { type, dataStart, dataLength, next }，返回 true 可提前停 */
function walkChunks(bytes, visit) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const next = dataStart + length + 4;
    if (next > bytes.length) break;
    if (visit({ type, length, dataStart, next, offset }) === true) return;
    offset = next;
  }
}

/**
 * 把凭证码写进 PNG 的 tEXt 块（插在 IHDR 后面）。
 * 失败（不是 PNG / data URL 解不开）就原样返回，绝不让「导出」挂掉。
 * @param {string} dataUrl
 * @param {string} code
 * @returns {string}
 */
export function embedVoucherCodeInPng(dataUrl, code) {
  const text = String(code || '').trim();
  if (!text) return dataUrl;
  const bytes = dataUrlToBytes(dataUrl);
  if (!hasPngSignature(bytes)) return dataUrl;

  // tEXt 的内容是 latin1：关键字 + \0 + 文本
  const payload = [];
  for (const ch of VOUCHER_TEXT_KEYWORD) payload.push(ch.charCodeAt(0));
  payload.push(0);
  for (const ch of text) payload.push(ch.charCodeAt(0) & 0xff);

  const chunk = new Uint8Array(12 + payload.length);
  writeUint32(chunk, 0, payload.length);
  chunk[4] = 0x74; // t
  chunk[5] = 0x45; // E
  chunk[6] = 0x58; // X
  chunk[7] = 0x74; // t
  chunk.set(payload, 8);
  writeUint32(chunk, 8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)));

  // 插在 IHDR 之后：块顺序要求 IHDR 必须第一，别的随便放
  let insertAt = 8 + 12 + readUint32(bytes, 8);
  if (!(insertAt > 8 && insertAt <= bytes.length)) insertAt = bytes.length;

  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + chunk.length);
  return bytesToDataUrl(out);
}

/**
 * 从凭证图里读回凭证码。读不出（不是 PNG / 被重新编码过 / 压根不是凭证图）返回 ''。
 * @param {string} dataUrl
 * @returns {string}
 */
export function readVoucherCodeFromImage(dataUrl) {
  const bytes = dataUrlToBytes(dataUrl);
  if (!hasPngSignature(bytes)) return '';
  let found = '';
  walkChunks(bytes, (chunk) => {
    if (chunk.type !== 'tEXt') return false;
    const data = bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
    const zero = data.indexOf(0);
    if (zero <= 0) return false;
    let keyword = '';
    for (let i = 0; i < zero; i += 1) keyword += String.fromCharCode(data[i]);
    if (keyword !== VOUCHER_TEXT_KEYWORD) return false;
    let value = '';
    for (let i = zero + 1; i < data.length; i += 1) value += String.fromCharCode(data[i]);
    found = value.trim();
    return true;
  });
  if (!found) return '';
  // 只认凭证码的形状：24 位字母数字（卡上带连字符，规整掉）
  const raw = found.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 24 ? raw : '';
}
