'use strict';

// Exercise actual renderer functions and candidate/cache logic without IPC, disk writes or services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { collectCandidates, encodeVector, decodeVector, rankBySimilarity } = require('../main/vectors.js');
const source = (file) => fs.readFileSync(path.join(__dirname, '..', 'renderer/js', file), 'utf8')
  .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/\bexport /g, '');

function harness() {
  const card = { id: 'npc', name: 'Bound NPC' };
  const calls = [];
  const state = { settings: {
    ragEnabled: true,
    embeddingProviderId: 'embedding',
    // 向量模型必填：main 的 endpointFor 在模型为空时会回落到「该提供商的第一个模型」
    // （通常是聊天模型），于是每轮都往 /embeddings 打一次注定失败的请求。
    embeddingModel: 'embed-model',
    showDate: false,
    maxTurns: 20
  } };
  const context = vm.createContext({
    console, state,
    asArray: (value) => Array.isArray(value) ? value : [],
    characterForConvo: (convo) => convo && convo.characterId === card.id ? card : null,
    isPlainChatConvo: (convo) => !convo?.gmMode && convo?.characterId !== card.id,
    assistantName: () => 'Default assistant', assistantPersona: () => '', userName: () => 'User',
    convoUserName: () => 'Player', effectiveWorldbookIds: () => ['book'],
    api: { ragRecall: async (payload) => {
      calls.push(payload);
      return { ok: true, items: [
        { kind: 'worldbook', title: 'Setting', text: '{{char}} / <BOT> / {{user}} / <USER>' },
        { kind: 'message', role: 'assistant', text: '{{char}} spoke to {{user}}' },
        { kind: 'message', role: 'user', text: '{{user}} replied to {{char}}' }
      ] };
    } },
    effectiveDialoguePresets: () => [], WORLDBOOK_SCAN_DEPTH: 6,
    convoPlayer: () => null, playerProfileForPrompt: () => '', worldbookCast: () => '',
    // GM 局的主要角色段在 cast.js（这里只验宏与注入顺序，段本身由冒烟覆盖）
    focusCharacterSection: () => '',
    convoFieldDisplayNames: () => [], panelGroupNames: () => [],
    compileAssistantCleaner: () => (text) => text,
    formatPanelForPrompt: () => '', optionsInstruction: () => '', panelEntities: () => []
  });
  for (const file of ['data/narration.js', 'data/memory.js', 'data/messages.js', 'data/rag.js']) {
    vm.runInContext(source(file), context, { filename: file });
  }
  return { context, calls, state };
}

{
  const { context } = harness();
  const gm = context.gmRuleText('', 'Player', { paceMode: 'step' });
  assert.ok(gm.includes('当前镜头里最相关的 NPC'));
  assert.ok(gm.includes('一轮只给一个镜头'));
  assert.ok(!gm.includes('在场 NPC 各给一句话'));
  const solo = context.roleplayRuleText('Alice', 'Player', { paceMode: 'step' });
  assert.ok(solo.includes('你给一句话或一个动作（最多一次）'));
}

(async () => {
  const { context, calls, state } = harness();
  const history = [null, { role: 'error', content: 'error' }, { role: 'assistant', content: ' ' },
    { role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }];
  const gm = { id: 'gm', gmMode: true, characterId: 'npc', messages: history };
  const narrator = '\u53d9\u8ff0\u8005';
  // GM + 绑卡：卡就是「本局主要角色」，宏落到卡名（和 messages.js 同一口径，不再一律叙述者）
  {
    const convo = { ...gm };
    const rag = await context.recallSection(convo);
    assert.ok(rag.includes('Bound NPC / Bound NPC / Player / Player'));
    assert.ok(rag.includes('【早先 · Bound NPC】'));
    assert.ok(!rag.includes('Default assistant'));
    const messages = context.buildApiMessages(convo, '{{char}} / <BOT> / {{user}} / <USER>', rag);
    assert.ok(messages.some((message) => message.content === 'Bound NPC / Bound NPC / Player / Player'));
    assert.ok(messages.some((message) => message.content === rag));
  }
  // GM 没绑卡：宏落成叙述者，也不能回落到默认助手的人设名
  {
    const convo = { ...gm, characterId: '' };
    const rag = await context.recallSection(convo);
    assert.ok(rag.includes(`${narrator} / ${narrator} / Player / Player`));
    assert.ok(!rag.includes('Bound NPC') && !rag.includes('Default assistant'));
    assert.ok(rag.includes(`\u3010\u65e9\u5148 \u00b7 ${narrator}\u3011`));
    const messages = context.buildApiMessages(convo, '{{char}} / <BOT> / {{user}} / <USER>', rag);
    assert.ok(messages.some((message) => message.content === `${narrator} / ${narrator} / Player / Player`));
    assert.ok(messages.some((message) => message.content === rag));
  }
  assert.equal(calls[0].query, 'question\nanswer', 'null/error/blank history is excluded');
  // 排除量 = 实际会进上下文的那一段（data/memory.js 的 recentContextCount），
  // 不再写死 maxTurns * 2。这里只有 2 条有效历史，以前照样排除 40 条，
  // 等于把本来可以捞回来的旧消息白砍掉 38 条。
  assert.equal(calls[0].recentCount, 2, 'recent exclusion follows the real context window');
  const solo = await context.recallSection({ ...gm, gmMode: false });
  assert.ok(solo.includes('Bound NPC / Bound NPC / Player / Player'));
  const before = calls.length;
  assert.equal(await context.recallSection({ ...gm, gmMode: false, characterId: '' }), '');
  assert.equal(await context.recallSection(null), '');
  assert.equal(await context.recallSection({ ...gm, messages: undefined }), '');
  assert.equal(calls.length, before, 'plain chat and empty history never call embeddings');
  state.settings.ragEnabled = false;
  assert.equal(await context.recallSection(gm), '');
  assert.equal(calls.length, before);

  // 没选向量模型 = 配置没配全，连请求都不该发（以前会拿聊天模型去打 /embeddings）
  state.settings.ragEnabled = true;
  state.settings.embeddingModel = '';
  assert.equal(await context.recallSection(gm), '', '没选向量模型时不注入也不发请求');
  assert.equal(calls.length, before, 'missing embedding model never calls embeddings');
  state.settings.embeddingModel = 'embed-model';

  const candidates = (entry) => collectCandidates({ worldbookIds: ['book'], books: [{ id: 'book', entries: [entry] }] });
  assert.deepEqual(candidates({ id: 'entry', enabled: false, content: 'disabled secret' }), []);
  assert.deepEqual(candidates(null), []);
  assert.equal(candidates({ id: 'entry', enabled: true, content: 'enabled setting' }).length, 1);
  assert.equal(candidates({ id: 'entry', content: 'legacy enabled setting' }).length, 1);

  const old = candidates({ id: 'entry', content: 'volcano' })[0];
  const changed = candidates({ id: 'entry', content: 'ocean' })[0];
  assert.notEqual(old.key, changed.key, 'editing content invalidates a worldbook vector');
  assert.equal(candidates({ id: 'entry', title: 'renamed', content: 'volcano' })[0].key, old.key,
    'title-only edits can reuse the content vector');
  const store = { [`embedding::${old.key}`]: encodeVector([1, 0]) };
  const keyOf = (candidate) => `embedding::${candidate.key}`;
  const missing = [changed].filter((candidate) => !store[keyOf(candidate)]);
  assert.equal(missing.length, 1, 'IPC missing-vector detection sees edited content');
  store[keyOf(changed)] = encodeVector([0, 1]);
  const ready = [{ ...changed, vector: decodeVector(store[keyOf(changed)]) }];
  assert.equal(rankBySimilarity([1, 0], ready, { minScore: 0.32 }).length, 0,
    'old-topic query no longer recalls a changed setting through a stale vector');
  assert.equal(rankBySimilarity([0, 1], ready, { minScore: 0.32 })[0].text, 'ocean');
  console.log('PASS roleplay RAG isolation, history filtering, disabled entries and edited-vector cache invalidation');
})().catch((error) => { console.error(error); process.exitCode = 1; });
