'use strict';

// ============================================================================
//  main/worldbook-store.js —— 世界书落盘时的那一层归一化
//
//  归一化本身在 main/worldbook-parse.js。这里只负责「落盘时怎么调它」，
//  把主进程特有的两样东西注进去：
//    · makeId              —— 怎么发世界书 id
//    · normalizeCharacter  —— 书里「角色副本」的归一化器（characters.js 那个）
//
//  单独一层是为了让冒烟测试的假后端也能 require 同一份归一化逻辑：
//  Electron 入口不能直接 require，而落盘白名单必须两边一致，
//  所以把「落盘时怎么调归一化」抽到这里。
//
//  ⚠️ normalizeWorldbook 是白名单式的：加字段时记得同步 worldbook-parse.js。
// ============================================================================

const { normalizeWorldbook } = require('./worldbook-parse.js');

/**
 * 造一个归一化器。
 * @param {object} deps
 * @param {function} deps.makeId             生成世界书 id
 * @param {function} deps.normalizeCharacter 归一化书里的角色副本
 */
function createWorldbookNormalizer(deps) {
  const d = deps || {};
  const makeId = typeof d.makeId === 'function' ? d.makeId : undefined;
  const normalizeCharacter = typeof d.normalizeCharacter === 'function' ? d.normalizeCharacter : undefined;

  return function normalizeStoredWorldbook(raw, fallbackName) {
    return normalizeWorldbook(raw, fallbackName, makeId, normalizeCharacter);
  };
}

module.exports = { createWorldbookNormalizer };
