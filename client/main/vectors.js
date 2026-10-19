'use strict';

// 语义检索用的向量小工具：怎么存（Float32 ↔ base64）、怎么比（余弦相似度）、怎么挑（topK + 阈值）。
// 纯计算，不碰网络也不碰文件 —— tools/smoke-test.js 能 require 同一份代码来测。

const crypto = require('node:crypto');

/** 内容指纹：内容变了指纹就变，缓存自然失效，不用手动清 */
function hashText(text) {
  return crypto.createHash('sha1').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/** 向量存成 base64 的 Float32：1536 维按 JSON 数字存要 20KB，Float32 只要 6KB —— 存几百条差距很明显。 */
function encodeVector(values) {
  const array = values instanceof Float32Array ? values : Float32Array.from(values || []);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
}

function decodeVector(text) {
  const buffer = Buffer.from(String(text || ''), 'base64');
  // 长度必须是 4 的倍数，否则根本不是我们存的东西
  if (!buffer.length || buffer.length % 4 !== 0) return null;
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/** 余弦相似度。用余弦而不是欧氏距离，是因为不用管向量归没归一化 —— 各家服务商不一样。 */
function cosineSimilarity(a, b) {
  if (!a || !b || !a.length || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 按相似度挑前 K 个；exclude 里的 key 跳过（比如最近几条消息，它们本来就会进上下文）。
 *  ⚠️ minScore 阈值这道闸很重要：语义检索最怕「硬凑」，沾不上边的东西进上下文比不检索还差。 */
function rankBySimilarity(queryVector, candidates, options) {
  const opts = options || {};
  const topK = Math.max(1, Math.floor(Number(opts.topK) || 4));
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 0.3;
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);

  // 只维护当前 top K：长会话里候选越来越多而 K 很小，每命中一个就全量排序是浪费。
  const heap = [];
  const isWorse = (a, b) => a.score < b.score || (a.score === b.score && a.index > b.index);
  const swap = (a, b) => {
    const value = heap[a];
    heap[a] = heap[b];
    heap[b] = value;
  };
  const siftUp = (index) => {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!isWorse(heap[index], heap[parent])) break;
      swap(index, parent);
      index = parent;
    }
  };
  const siftDown = (index) => {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && isWorse(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && isWorse(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) break;
      swap(index, smallest);
      index = smallest;
    }
  };

  let index = 0;
  for (const item of candidates || []) {
    if (!item || exclude.has(item.key)) continue;
    const score = cosineSimilarity(queryVector, item.vector);
    if (!Number.isFinite(score) || score < minScore) continue;

    const ranked = { item, score, index };
    index += 1;
    if (heap.length < topK) {
      heap.push(ranked);
      siftUp(heap.length - 1);
    } else if (isWorse(heap[0], ranked)) {
      heap[0] = ranked;
      siftDown(0);
    }
  }

  return heap
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score }) => ({ ...item, score }));
}

/** 收集语义检索的候选文本。纯函数（不读文件），输入是已读出的会话和世界书 —— 测试能直接喂数据。
 *  recentCount 末尾几条要跳过：它们本来就会进上下文，捞回来是白占位置。 */
function collectCandidates(options) {
  const opts = options || {};
  const out = [];

  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const skip = Math.max(0, Math.floor(Number(opts.recentCount) || 0));

  // ⚠️ 先挑出可用消息再按 skip 切尾巴：直接对原始数组 slice 会被 error / 空白消息带偏，
  //    结果「最近的内容」被当成往事捞回来。
  const usable = messages.filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
  for (const m of usable.slice(0, Math.max(0, usable.length - skip))) {
    const text = String(m.content).trim();
    out.push({ kind: 'message', key: `m:${hashText(text)}`, text, role: m.role });
  }

  const wanted = new Set(
    (Array.isArray(opts.worldbookIds) ? opts.worldbookIds : [])
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean)
  );
  const books = Array.isArray(opts.books) ? opts.books : [];
  for (const book of books) {
    if (!book || !wanted.has(book.id)) continue;
    for (const entry of book.entries || []) {
      const text = String(entry && entry.content ? entry.content : '').trim();
      if (!text) continue;
      out.push({
        kind: 'worldbook',
        key: `w:${book.id}:${entry.id}`,
        text,
        title: String(entry.title || '')
      });
    }
  }

  return out;
}

module.exports = {
  hashText,
  encodeVector,
  decodeVector,
  cosineSimilarity,
  rankBySimilarity,
  collectCandidates
};
