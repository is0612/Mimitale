'use strict';

// ============================================================================
//  main/png.js —— 酒馆 PNG 角色卡里那点「元数据藏在图片里」的活
//
//  酒馆（SillyTavern）的角色卡其实是一张 PNG：卡数据 base64 之后塞在 PNG 的
//  文本块里，关键字 chara（v2）或 ccv3（v3）。所以导入要会读，导出要会写。
//
//  三种文本块都认（见 readTextChunk 上面的注释）：标准里给了 tEXt / zTXt / iTXt，
//  不同工具写的位置不一样，只认 tEXt 会遇到「明明是张卡却导入不出来」。
//  导出仍然写 tEXt —— 那是各家都认的最小公约数。
//
//  独立成模块的原因和 main/characters.js 一样：tools/smoke-test.js 要 require 它，
//  这样「导出 → 再导入」的往返能跑**同一份真代码**，而不是测试里自己糊一套。
// ============================================================================

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 解压后的文本块上限。卡里那段是 JSON（最多几 MB），给 8MB 的余量；
// 超过就是别人塞进来的压缩炸弹，直接当读不出来处理
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

// PNG 每个数据块末尾跟一个 CRC32（对「块类型 + 数据」算）。标准查表实现
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * 往 PNG 里插一个 tEXt 块。
 * 位置放在 IHDR 之后 —— 规范允许放在任何块之间，但紧挨头部最不容易踩到别人的解析器。
 * 不是合法 PNG 就原样返回：宁可导出一张没有数据的图，也不要写出个坏文件。
 */
function pngWithTextChunk(png, keyword, text) {
  if (!isPng(png)) return png;

  const ihdrLength = png.readUInt32BE(8);
  const insertAt = 8 + 4 + 4 + ihdrLength + 4;
  if (insertAt > png.length) return png;

  const type = Buffer.from('tEXt', 'latin1');
  // tEXt 规定用 Latin-1：关键字 + \0 + 文本。调用方传的是 base64，纯 ASCII，安全
  const data = Buffer.concat([
    Buffer.from(String(keyword), 'latin1'),
    Buffer.from([0]),
    Buffer.from(String(text), 'latin1')
  ]);

  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);

  return Buffer.concat([png.subarray(0, insertAt), chunk, png.subarray(insertAt)]);
}

/**
 * 解压一个 zlib 流。坏数据 / 超过上限都返回 null —— 文本块只是「可选元数据」，
 * 解不开最多少读一份信息，不该把整个导入流程炸掉。
 */
function inflateText(buffer) {
  try {
    return zlib.inflateSync(buffer, { maxOutputLength: MAX_TEXT_BYTES });
  } catch (err) {
    return null;
  }
}

/**
 * 把一个文本块拆成 { keyword, text }。三种块的布局：
 *
 *   tEXt  关键字 \0 明文                               Latin-1
 *   zTXt  关键字 \0 压缩方法(1) zlib 压缩数据           Latin-1
 *   iTXt  关键字 \0 压缩标志(1) 压缩方法(1) \0
 *         语言标签 \0 翻译后的关键字 \0 文本            UTF-8（可压缩）
 *
 * 认不出来（够长却没有分隔符、解压失败）返回 null。
 */
function decodeTextChunk(type, chunk) {
  const head = chunk.indexOf(0);
  if (head <= 0) return null; // 没有关键字分隔符，或者关键字是空的
  const keyword = chunk.toString('latin1', 0, head);

  if (type === 'tEXt') {
    // Latin-1：卡数据是 base64，纯 ASCII，怎么解都一样；按标准来而已
    return { keyword, text: chunk.toString('latin1', head + 1) };
  }

  if (type === 'zTXt') {
    if (head + 2 > chunk.length) return null;
    const raw = inflateText(chunk.subarray(head + 2));
    return raw ? { keyword, text: raw.toString('latin1') } : null;
  }

  if (type === 'iTXt') {
    // [head+1] 压缩标志 / [head+2] 压缩方法 / [head+3] 必须是 0（语言标签前的分隔符）
    if (head + 4 > chunk.length || chunk[head + 3] !== 0) return null;
    const langEnd = chunk.indexOf(0, head + 4);
    if (langEnd < 0) return null;
    const translatedEnd = chunk.indexOf(0, langEnd + 1);
    if (translatedEnd < 0) return null;

    let payload = chunk.subarray(translatedEnd + 1);
    if (chunk[head + 1] === 1) {
      const raw = inflateText(payload);
      if (!raw) return null;
      payload = raw;
    }
    // iTXt 明文规定是 UTF-8 —— 这里才真的可能有非 ASCII
    return { keyword, text: payload.toString('utf8') };
  }

  return null;
}

/**
 * 读一个文本块的值（找不到就返回 null）。
 * tEXt / zTXt / iTXt 都看：官方规范里三种都合法，出图工具各有偏好，
 * 只认 tEXt 的话一张正常的卡会读成「图里没有卡数据」。
 */
function readTextChunk(buffer, wantedKeyword) {
  if (!isPng(buffer)) return null;

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    // 长度字段不可信，越界就停，避免读到别的数据
    if (length < 0 || dataEnd + 4 > buffer.length) break;

    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const decoded = decodeTextChunk(type, buffer.subarray(dataStart, dataEnd));
      if (decoded && decoded.keyword === wantedKeyword) return decoded.text;
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  return null;
}

/**
 * 从 PNG 里读出角色卡数据。ccv3（v3）优先于老的 chara（v2）。
 * 解析不出对象就返回 null —— 调用方据此报「这张图里没有卡数据」。
 */
function parseCharacterCardPng(buffer) {
  // ccv3 是 v3 卡，优先于老的 chara
  const charaText = readTextChunk(buffer, 'ccv3') || readTextChunk(buffer, 'chara');
  if (!charaText) return null;

  // 正常是 base64；有些工具直接塞了明文 JSON，两种都试
  try {
    return JSON.parse(Buffer.from(charaText, 'base64').toString('utf8'));
  } catch (err) {
    try {
      return JSON.parse(charaText);
    } catch (err2) {
      return null;
    }
  }
}

module.exports = { crc32, pngWithTextChunk, readTextChunk, parseCharacterCardPng, isPng };
