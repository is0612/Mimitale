'use strict';

// 世界书的匹配引擎：只做纯匹配，不认识文件、不认识 IPC —— 条目从哪来由调用方决定。
// 独立成模块供 tools/smoke-test.js require 同一份代码（和 characters.js / png.js 同理）。

/** 中日韩文字没有空格分词，只能子串匹配；纯拉丁关键词默认也是子串，
 *  只有条目显式勾了 matchWholeWords（酒馆的「Match Whole Words」）才走词边界 ——
 *  否则 king 会命中 liking，而那是酒馆里另一个开关的事。 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 缓存编译过的正则：匹配每轮对每个条目每个关键词都跑，不缓存就要重新编译几百次。
 *  用户改关键词时字符串会变，键自然失配，不用担心过期。 */
const keywordRegexCache = new Map();
const MAX_KEYWORD_REGEX_CACHE = 4000;

/** 解析 /re/flags 写法；不是正则就返回 null */
function parseRegexKeyword(keyword) {
  if (keyword.length <= 2 || !keyword.startsWith('/')) return null;

  const cached = keywordRegexCache.get(keyword);
  if (cached !== undefined) return cached;

  let compiled = null;
  const lastSlash = keyword.lastIndexOf('/');
  if (lastSlash > 0) {
    const body = keyword.slice(1, lastSlash);
    const flags = keyword.slice(lastSlash + 1);
    if (/^[gimsuy]*$/.test(flags)) {
      try {
        compiled = new RegExp(body, flags);
      } catch (err) {
        // 正则写错了就当普通文本处理，别让一条坏正则废掉整本书
        compiled = null;
      }
    }
  }

  // 上限只是防止畸形文件把缓存撑爆；简单粗暴地整体清空即可
  if (keywordRegexCache.size >= MAX_KEYWORD_REGEX_CACHE) keywordRegexCache.clear();
  keywordRegexCache.set(keyword, compiled);
  return compiled;
}

/** 全词匹配的正则同样值得缓存（中文默认不走这条，主要是英文世界书） */
const wordBoundaryCache = new Map();

function wordBoundaryRegex(keyword) {
  const cached = wordBoundaryCache.get(keyword);
  if (cached !== undefined) return cached;

  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`, 'u');
  if (wordBoundaryCache.size >= MAX_KEYWORD_REGEX_CACHE) wordBoundaryCache.clear();
  wordBoundaryCache.set(keyword, re);
  return re;
}

function keywordHit(haystack, rawKeyword, entry) {
  const keyword = String(rawKeyword || '').trim();
  if (!keyword) return false;

  // 关键词写成 /re/flags 就当正则处理，和酒馆一致
  const asRegex = parseRegexKeyword(keyword);
  if (asRegex) {
    // g / y 正则的 test 会推进 lastIndex；缓存复用时每次都从文本起点匹配。
    asRegex.lastIndex = 0;
    return asRegex.test(haystack);
  }

  const text = entry && entry.caseSensitive ? haystack : haystack.toLowerCase();
  const needle = entry && entry.caseSensitive ? keyword : keyword.toLowerCase();

  if (CJK_RE.test(needle)) return text.includes(needle);
  if (entry && entry.matchWholeWords) return wordBoundaryRegex(needle).test(text);
  return text.includes(needle);
}

/** 把某条目的所有关键词拼成一个正则，用来判断「至少命中一个」还是「全部命中」 */
function anyKeywordHit(haystack, keywords, entry) {
  return keywords.some((k) => keywordHit(haystack, k, entry));
}

function allKeywordsHit(haystack, keywords, entry) {
  return keywords.length > 0 && keywords.every((k) => keywordHit(haystack, k, entry));
}

/**
 * 条目在「一次扫描」里的身份。
 *
 * id 只在**一本书内**唯一：一个会话可以同时绑好几本书，两本书里的条目完全可能撞 id
 * （同一个 lorebook 文件导两次、或者导出工具写了固定 id）。以前直接拿 id 去重，撞了
 * 之后第二本书那条永远不会被带出来 —— 而且不报错，只是「设定怎么没生效」。
 * 调用方给条目带上 worldbookId 时就和书一起认；没带（单元测试 / 单书场景）仍旧按 id。
 */
function entryKey(entry) {
  const id = entry && entry.id;
  if (id == null) return entry;
  return entry.worldbookId ? `${entry.worldbookId}::${id}` : id;
}

/** 单条 entry 是否应该被注入 */
function entryMatches(entry, haystack, probabilityCache) {
  if (!entry || entry.enabled === false) return false;
  if (!String(entry.content || '').trim()) return false;

  const hasPrimaryHit = entry.constant || anyKeywordHit(haystack, entry.keys || [], entry);
  if (!hasPrimaryHit) return false;

  // 常驻条目只跳过关键词过滤；概率仍然适用，和 ST 的 verifyProbability 一致。
  if (!entry.constant && entry.selective !== false && (entry.secondaryKeys || []).length) {
    switch (entry.selectiveLogic) {
      case 'AND_ALL':
        if (!allKeywordsHit(haystack, entry.secondaryKeys, entry)) return false;
        break;
      case 'NOT_ANY':
        if (anyKeywordHit(haystack, entry.secondaryKeys, entry)) return false;
        break;
      case 'NOT_ALL':
        if (allKeywordsHit(haystack, entry.secondaryKeys, entry)) return false;
        break;
      case 'AND_ANY':
      default:
        if (!anyKeywordHit(haystack, entry.secondaryKeys, entry)) return false;
        break;
    }
  }

  // 概率在关键词条件合格后才抽；同一次递归扫描只抽一次，避免失败后被后续轮次复活。
  const probability = Number.isFinite(Number(entry.probability)) ? Number(entry.probability) : 100;
  if (probability < 100) {
    const key = entryKey(entry);
    let allowed = probabilityCache && probabilityCache.get(key);
    if (allowed === undefined) {
      allowed = Math.random() * 100 < probability;
      if (probabilityCache) probabilityCache.set(key, allowed);
    }
    if (!allowed) return false;
  }

  return true;
}

/** 扫描文本返回命中条目。**递归扫描**：命中一条勾了递归的条目后，把它的正文并进扫描文本再扫一遍，连锁下去。
 *  代价是 token，所以只有 `recursive === true` 的条目才往下带，且最多 recursiveDepth 层。
 *  返回 { hits, rounds, recursiveCount } —— 后两个给「预览命中」显示用。 */
function matchWorldbookEntries(entries, scanText, options) {
  const opts = options || {};
  const chainLimit = Math.max(0, Math.min(5, Math.floor(Number(opts.recursiveDepth) || 0)));

  const hits = [];
  const seen = new Set();
  let rounds = 0;
  let recursiveCount = 0;
  let text = String(scanText == null ? '' : scanText);
  const probabilityCache = new Map();

  for (let round = 0; round <= chainLimit; round += 1) {
    const fresh = [];
    for (const entry of entries) {
      if (seen.has(entryKey(entry)) || entry.excludeRecursion && round > 0) continue;
      if (entryMatches(entry, text, probabilityCache)) fresh.push(entry);
    }
    if (!fresh.length) break;

    rounds = round + 1;
    if (round > 0) recursiveCount += fresh.length;
    for (const entry of fresh) {
      seen.add(entryKey(entry));
      hits.push(entry);
    }

    // 下一轮的扫描文本 = 原来的 + 这一轮里勾了递归的条目正文
    const carried = fresh
      .filter((e) => e.recursive === true)
      .map((e) => String(e.content || '').trim())
      .filter(Boolean);
    if (!carried.length) break;

    text = `${text}\n${carried.join('\n')}`;
  }

  hits.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return String(a.title).localeCompare(String(b.title));
  });

  return { hits, rounds, recursiveCount };
}

// ⚠️ 两种抬头刻意分开：模型对抬头最敏感 —— 关键词条目是「这一轮才相关」，常驻条目是「每一轮都成立」。
const WORLDBOOK_HEADER = '[世界设定]\n以下资料与当前对话相关，请自然地运用，不要直接复述：';
const WORLDBOOK_DEEP_HEADER =
  '[世界设定 · 常驻]\n以下是这个世界每一轮都成立的设定与规则，请始终遵守，不要直接复述：';

function formatWorldbookSection(hits, header) {
  if (!hits || !hits.length) return '';
  const lines = hits.map((e) => `【${e.title}】\n${String(e.content).trim()}`);
  return `${header || WORLDBOOK_HEADER}\n\n${lines.join('\n\n')}`;
}

/** 把命中条目拆成两块：section（关键词命中，紧跟人设之后）、deepSection（常驻条目，送到贴近生成位置）。
 *  常驻条目多是规则类，钉在人设之后几万 token 就失去约束力，所以要拆。
 *  ⚠️ 判据只认 `constant === true`，不是「keys 为空」：不带关键词又没勾常驻的条目根本不会命中。 */
function formatWorldbookSections(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const constant = list.filter((e) => e && e.constant === true);
  const keyword = list.filter((e) => !e || e.constant !== true);
  return {
    section: formatWorldbookSection(keyword),
    deepSection: formatWorldbookSection(constant, WORLDBOOK_DEEP_HEADER)
  };
}

module.exports = {
  entryMatches,
  matchWorldbookEntries,
  formatWorldbookSection,
  formatWorldbookSections,
  keywordHit
};
