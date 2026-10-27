'use strict';

// ============================================================================
//  tools/test-cast.js —— 「这个世界的人」/「本局主要角色」这两段提示词的行为回归
//
//  为什么单独建一条：2026-10-27 有人把 worldbookCast 开头的 `const playerName`
//  当成「未使用变量」删掉了，而它其实还在下面拼 header 的模板字符串里。后果不是
//  「少一句话」，而是**只要书里有角色副本，组装提示词就直接抛 ReferenceError**：
//     · messages.js 每次非纯聊天请求都调它 → 角色卡 / GM 会话发不出消息
//     · worldPlay.js 生成开局也调它 → 没写开场白的卡开不了局
//  静态检查（audit）看不出这种错，只有真跑一遍才知道，所以这里真跑。
//
//  跑法：node --test tools/test-cast.js
// ============================================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 渲染层的 ESM 在裸 node 里跑不起来：去掉 import，把依赖当全局注入（同 test-chat-state.js）。
const source = (rel) =>
  fs
    .readFileSync(path.join(__dirname, '..', 'renderer/js', rel), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/\bexport /g, '');

/**
 * 载入 data/cast.js。
 * @param {object[]} characters 角色卡库
 * @param {object[]} worldbooks 世界书库（自带 characters 副本）
 * @param {object}   convo      会话
 */
function harness({ characters, worldbooks, convo }) {
  const state = { settings: {}, characters, worldbooks, conversations: [convo], activeId: convo.id };
  const ctx = vm.createContext({
    state,
    console,
    Date,
    asArray: (value) => (Array.isArray(value) ? value : []),
    characterById: (id) => characters.find((c) => c.id === id) || null,
    characterForConvo: (c) => {
      if (!c || !c.characterId) return null;
      return characters.find((x) => x.id === c.characterId) || null;
    },
    // 真实实现走「卡上绑了哪本书」，这里按同一口径回落，别改成 convo.worldbookIds。
    effectiveWorldbookIds: (c) => {
      const card = c && c.characterId ? characters.find((x) => x.id === c.characterId) : null;
      return card ? asArrayLocal(card.worldbookIds) : [];
    },
    worldbookById: (id) => worldbooks.find((w) => w.id === id) || null,
    worldbookCharacters: (book) => (book && Array.isArray(book.characters) ? book.characters : []),
    showsInPanel: (c) => !!(c && c.showInPanel === true),
    // 这两段提示词用不到面板，给空桩即可
    convoPanelFields: () => [],
    panelFieldOwner: () => '',
    isGmMode: () => true,
    api: { previewWorldbook: async () => ({}) }
  });
  vm.runInContext(source('data/cast.js'), ctx, { filename: 'data/cast.js' });
  return ctx;
}

function asArrayLocal(value) {
  return Array.isArray(value) ? value : [];
}

/** 一张绑了书的主角色卡：书里有一个 NPC + 一个和玩家同名的副本 */
function fixture() {
  const characters = [
    {
      id: 'c-main',
      name: '沈砚',
      description: '{{char}}是守夜人。',
      personality: '寡言',
      worldbookIds: ['w-1']
    }
  ];
  const worldbooks = [
    {
      id: 'w-1',
      name: '雾港',
      entries: [],
      characters: [
        { id: 'k-npc', name: '顾言', description: '{{char}}是顾言，{{user}}的朋友。', personality: '温和' },
        { id: 'k-me', name: '阿甲', description: '玩家自己的副本，不该被当成 NPC。' }
      ]
    }
  ];
  const convo = { id: 'convo-1', characterId: 'c-main', player: { name: '阿甲' }, messages: [] };
  return { characters, worldbooks, convo };
}

// ---------------------------------------------------------------------------

{
  const f = fixture();
  const ctx = harness(f);
  // 这一行就是本次回归的现场：书里有副本时必须能正常返回，而不是抛 ReferenceError。
  const cast = ctx.worldbookCast(f.convo);

  assert.equal(typeof cast, 'string', '书里有角色副本时 worldbookCast 必须返回字符串');
  assert.ok(cast.includes('【这个世界的人】'), '带上「这个世界的人」抬头');
  assert.ok(cast.includes('顾言'), 'NPC 副本被列出来');
  assert.ok(!/- 阿甲：/.test(cast), '和玩家同名的副本不算 NPC');
  assert.ok(
    cast.includes('「阿甲」是玩家本人扮演的主角'),
    'header 里要点明玩家本人的名字（playerName 被删就会在这里抛错）'
  );
  // 副本正文里的宏要换成真名，否则模型看到的是 {{char}} 这种字面量
  assert.ok(!cast.includes('{{'), '副本正文里的宏已替换');
  assert.ok(cast.includes('阿甲的朋友'), '{{user}} 换成了玩家名');
}

{
  // 没有书 / 书里没有副本：保持返回空串（这条早退分支不能被误删）
  const noBook = harness({
    characters: [{ id: 'c-free', name: '自由人' }],
    worldbooks: [],
    convo: { id: 'convo-2', characterId: 'c-free', player: { name: '阿甲' }, messages: [] }
  });
  assert.equal(noBook.worldbookCast({ id: 'convo-2', characterId: 'c-free', player: { name: '阿甲' } }), '');

  const emptyBook = harness({
    characters: [{ id: 'c-main', name: '沈砚', worldbookIds: ['w-empty'] }],
    worldbooks: [{ id: 'w-empty', name: '空书', entries: [], characters: [] }],
    convo: { id: 'convo-3', characterId: 'c-main', player: { name: '阿甲' } }
  });
  assert.equal(emptyBook.worldbookCast({ id: 'convo-3', characterId: 'c-main' }), '', '没有副本时不注入这一段');
}

{
  // 同名副本的补充资料要并进「本局主要角色」，而不是把主卡整段吞掉（另一半重构的行为）
  const f = fixture();
  f.worldbooks[0].characters[0] = { id: 'k-hero', name: '沈砚', personality: '左手有旧伤' };
  const ctx = harness(f);
  const focus = ctx.focusCharacterSection(f.convo);
  assert.ok(focus.includes('【本局主要角色】'));
  assert.ok(focus.includes('「沈砚」是这一局的核心角色'));
  assert.ok(focus.includes('守夜人'), '主卡自己的描述还在');
  assert.ok(focus.includes('左手有旧伤'), '同名副本的补充设定也并进来了');
  // 同名副本不该同时出现在 NPC 名单里，否则同一个人两份设定
  const cast = ctx.worldbookCast(f.convo);
  assert.ok(!/- 沈砚：/.test(cast), '主角色不会被重复列成 NPC');
}

console.log('cast: 世界书有副本时 worldbookCast / focusCharacterSection 均能正常组装（含宏替换与同名副本合并）');
