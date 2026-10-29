'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness() {
  const node = (value = '') => ({ value, dataset: {}, textContent: '', classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, focus() {} });
  const el = { charForm: node(), charSaveState: node(), c: {} };
  for (const field of ['name', 'tags', 'desc', 'scenario', 'first', 'example', 'system', 'post', 'notes']) el.c[field] = node();
  const state = { characters: [{ id: 'c1', name: '原名', description: '原文', avatar: '', updatedAt: 1 }], worldbooks: [], conversations: [] };
  let view = 'charEditor';
  let success = true;
  let bookWrites = true;
  let persisted;
  const ctx = vm.createContext({
    console, structuredClone, state, el,
    characters: () => state.characters,
    worldbooks: () => state.worldbooks,
    worldbookById: (id) => state.worldbooks.find((b) => b.id === id),
    worldbookCharacters: (book) => book?.characters || [],
    currentWorldbook: () => state.worldbooks[0],
    currentViewName: () => view,
    showView: (name) => { view = name; },
    now: () => 10,
    MAX_PANEL_FIELDS: 100, MAX_EXPRESSIONS: 100,
    persistCharacters: async () => { persisted = structuredClone(state); return success; },
    persistLibrary: async () => bookWrites,
    confirmDialog: async () => true,
    showToast() {}, resetCharAiFill() {}, renderCharacterPage() {}, rerenderBookCharHosts() {},
    document: { getElementById: () => null }
  });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/views/characterEditor.js'), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*from[^;]*;\s*$/gm, '')
    .replace(/\bexport /g, '');
  vm.runInContext(source, ctx);
  // UI rendering is tested through Electron smoke; here run the actual state transitions.
  vm.runInContext(`fillCharForm = () => setCharSaveState('saved'); updateCharEditorScopeUi = () => {}; showCharForm = () => {}; renderCharWorldbookBox = () => {}; editingCharacterId = 'c1'; editingCharacterDraft = cloneCharacter(state.characters[0]);`, ctx);
  el.c.name.value = '新名'; el.c.desc.value = '新文';
  return { ctx, state, el, run: (s) => vm.runInContext(s, ctx), failSave: () => { success = false; }, passSave: () => { success = true; }, failBooks: () => { bookWrites = false; }, passBooks: () => { bookWrites = true; }, setView: (v) => { view = v; }, getPersisted: () => persisted };
}

test('stash is isolated and abandonment prevents later stale-form writes', async () => {
  const h = harness();
  h.run('stashCharForm()');
  assert.equal(h.state.characters[0].description, '原文');
  assert.equal(h.run('editingCharacterDraft.description'), '新文');
  await h.run('leaveCharacterEditor()');
  h.run('stashCharForm()');
  assert.equal(h.state.characters[0].description, '原文');
  assert.equal(h.run('editingCharacterId'), null);
});

test('failed existing save rolls back formal state and keeps input dirty for retry', async () => {
  const h = harness(); h.failSave();
  await h.run('saveCharacter()');
  assert.equal(h.state.characters[0].name, '原名');
  assert.equal(h.el.c.name.value, '新名');
  assert.equal(h.el.charSaveState.dataset.state, 'dirty');
  h.passSave(); await h.run('saveCharacter()');
  assert.equal(h.state.characters[0].name, '新名');
  assert.equal(h.getPersisted().characters[0].description, '新文');
  assert.equal(h.el.charSaveState.dataset.state, 'saved');
});

test('new character save failure restores draft and retry creates exactly one record', async () => {
  const h = harness();
  h.run(`editingCharacterId = 'new'; editingCharacterDraft = null; charDraft = { character: {id: 'new', name: '新名', avatar: ''}, scope: 'library', bookId: null };`);
  h.failSave(); await h.run('saveCharacter()');
  assert.equal(h.state.characters.length, 1);
  assert.equal(h.run('charDraft.character.id'), 'new');
  assert.equal(h.el.charSaveState.dataset.state, 'dirty');
  h.passSave(); await h.run('saveCharacter()');
  assert.equal(h.state.characters.filter((c) => c.id === 'new').length, 1);
  assert.equal(h.run('charDraft'), null);
});

test('abandoning a draft deletes its persisted book; cleanup failure retains ownership for retry', async () => {
  const h = harness();
  h.state.worldbooks.push({ id: 'new-book', characters: [] });
  h.run(`editingCharacterId = 'new'; charDraft = { character: {id:'new', worldbookIds:['new-book']}, scope:'library', createdWorldbookId:'new-book' };`);
  h.failBooks();
  assert.equal(await h.run('discardCharDraft()'), false);
  assert.equal(h.state.worldbooks.length, 1);
  assert.equal(h.run('charDraft.createdWorldbookId'), 'new-book');
  h.passBooks();
  assert.equal(await h.run('discardCharDraft()'), true);
  assert.equal(h.state.worldbooks.length, 0);
  assert.equal(h.run('charDraft'), null);
});

test('failed binding deletes its newly persisted book and rolls back character references', async () => {
  const h = harness();
  h.ctx.createWorldbook = async () => {
    const book = { id: 'binding-book', characters: [] };
    h.state.worldbooks.push(book);
    return book;
  };
  let writes = 0;
  h.ctx.persistLibrary = async () => ++writes > 1;
  await h.run('createWorldbookForCharacter()');
  assert.equal(h.state.worldbooks.length, 0);
  assert.equal((h.state.characters[0].worldbookIds || []).length, 0);
  assert.equal(h.run('pendingWorldbookCleanup.size'), 0);
});

test('binding and cleanup failure remain tracked until leaving successfully retries cleanup', async () => {
  const h = harness();
  h.ctx.createWorldbook = async () => {
    const book = { id: 'pending-book', characters: [] };
    h.state.worldbooks.push(book);
    return book;
  };
  h.failBooks();
  await h.run('createWorldbookForCharacter()');
  assert.equal(h.state.worldbooks.length, 1);
  assert.equal(h.run('pendingWorldbookCleanup.size'), 1);
  await h.run('leaveCharacterEditor()');
  assert.equal(h.run('editingCharacterId'), 'c1');
  h.passBooks();
  await h.run('leaveCharacterEditor()');
  assert.equal(h.state.worldbooks.length, 0);
  assert.equal(h.run('pendingWorldbookCleanup.size'), 0);
  assert.equal(h.run('editingCharacterId'), null);
});

test('cleanup preserves books referenced by another character or conversation', async () => {
  const h = harness();
  h.state.worldbooks.push({ id: 'shared', characters: [] });
  h.state.characters[0].worldbookIds = ['shared'];
  await h.run("cleanupDraftWorldbook('shared')");
  assert.equal(h.state.worldbooks.length, 1);
  delete h.state.characters[0].worldbookIds;
  h.state.conversations.push({ worldbookIds: ['shared'] });
  await h.run("cleanupDraftWorldbook('shared')");
  assert.equal(h.state.worldbooks.length, 1);
});
