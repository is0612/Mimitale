'use strict';

// Execute the production panel logic without DOM, persistence, or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fieldHelpers = require('../main/panel-fields.js');
const source = fs.readFileSync(path.join(__dirname, '../renderer/js/data/panel.js'), 'utf8')
  .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/\bexport /g, '');
const npc = { id: 'npc', name: 'Alice', attributes: [{ name: 'HP', type: 'meter', min: 0, max: 100 }] };
const ctx = vm.createContext({
  ...fieldHelpers, console, Date, now: () => Date.now(),
  asArray: value => Array.isArray(value) ? value : [],
  characterAttrs: card => card && card.attributes || [],
  characterById: id => id === npc.id ? npc : null,
  characters: () => [npc], convoWorldbookIds: () => [], effectiveWorldbookIds: () => [],
  worldbookById: () => null, worldbookCharacters: () => [],
  stripEmoTags: text => text, persistConversations() {},
});
vm.runInContext(source, ctx, { filename: 'data/panel.js' });
const key = owner => `HP\0${owner}`;
const reply = (content, at) => ({ role: 'assistant', content, at });
function convo(owner = 'npc') {
  return {
    characterId: owner === 'npc' ? 'npc' : '', player: { name: 'Hero' },
    messages: [], panelFields: [key(owner)], panel: { [key(owner)]: '50/100' },
    panelDefs: { [key(owner)]: { type: 'meter', min: 0, max: 100, owner } }, panelManual: {},
  };
}

for (const owner of ['npc', 'player']) {
  const c = convo(owner);
  c.messages = [reply('【HP】：20/100', 10)];
  ctx.syncConvoPanel(c);
  ctx.setPanelField(c, key(owner), '60/100');
  const editedAt = c.panelManual[key(owner)];
  ctx.syncConvoPanel(c);
  assert.equal(c.panel[key(owner)], '60/100', `${owner}: old bare history cannot undo manual edit`);
  c.messages.push(reply('【HP】：30/100', editedAt));
  ctx.syncConvoPanel(c);
  assert.equal(c.panel[key(owner)], '60/100', `${owner}: equal timestamp cannot undo manual edit`);
  c.messages.push(reply('【HP】：40/100', editedAt + 1));
  ctx.syncConvoPanel(c);
  assert.equal(c.panel[key(owner)], '40/100', `${owner}: later bare reply supersedes manual edit`);
  assert.equal(c.panelManual[key(owner)], editedAt, `${owner}: preserve manual timestamp`);
  assert.equal(c.panelFields.length, 1, `${owner}: do not retain bare aliases`);
}

for (const owner of ['npc', 'player']) {
  const label = owner === 'npc' ? 'Alice' : 'Hero';
  for (const bareFirst of [true, false]) {
    const c = convo(owner);
    c.messages = bareFirst
      ? [reply('【HP】：20/100', 10), reply(`【${label}·HP】：80/100`, 20)]
      : [reply(`【${label}·HP】：80/100`, 10), reply('【HP】：20/100', 20)];
    ctx.syncConvoPanel(c);
    assert.equal(c.panel[key(owner)], bareFirst ? '80/100' : '20/100', `${owner}: aliases obey history order`);
    ctx.syncConvoPanel(c);
    assert.equal(c.panel[key(owner)], bareFirst ? '80/100' : '20/100', `${owner}: rescan is stable`);
  }
  const c = convo(owner);
  c.messages = [reply(`【HP】：20/100\n【${label}·HP】：80/100`, 10)];
  ctx.syncConvoPanel(c);
  assert.equal(c.panel[key(owner)], '80/100', `${owner}: aliases within one reply obey line order`);
  c.messages.push(reply('【HP】：999/100', 20));
  ctx.syncConvoPanel(c);
  assert.equal(c.panel[key(owner)], '100/100', `${owner}: resolve destination range before committing bare values`);
}

// Explicitly addressed owners must remain isolated even when field names match.
const c = convo();
ctx.appendPanelFields(c, [{ name: 'HP', owner: 'player', type: 'meter', min: 0, max: 100, value: '70/100' }]);
c.messages = [reply('【Alice·HP】：25/100\n【Hero·HP】：90/100', 10)];
ctx.syncConvoPanel(c);
assert.equal(c.panel[key('npc')], '25/100');
assert.equal(c.panel[key('player')], '90/100');
// Adding an owner prefix must not consume the 24-character field-name limit.
const longName = 'abcdefghijklmnopqrstuvwx';
const long = convo();
ctx.appendPanelFields(long, [
  { name: longName, owner: 'npc', value: 'old' },
  { name: longName, owner: 'player', value: 'old' },
]);
assert.ok(ctx.formatPanelForPrompt(long).includes(`【Alice·${longName}】：old`));
long.messages = [reply(`【Alice·${longName}】：new\n【Hero·${longName}】：other`, 10)];
ctx.syncConvoPanel(long);
assert.equal(long.panel[`${longName}\0npc`], 'new');
assert.equal(long.panel[`${longName}\0player`], 'other');
assert.equal(ctx.cleanAssistantText(`body\n【Alice·${longName}】：new`, ctx.convoFieldDisplayNames(long)), 'body');
const guards = convo();
guards.messages = [reply(`【${longName}x】：not a field\n【Unknown·${longName}】：not a field\n【Alice·${longName}】：valid`, 10)];
ctx.syncConvoPanel(guards);
assert.ok(!guards.panelFields.some(k => k.startsWith(`${longName}x`)));
assert.ok(!guards.panelFields.some(k => k.startsWith('Unknown·')));
assert.equal(guards.panel[`${longName}\0npc`], 'valid');

// A custom unique field has no card attribute declaration to recover its owner.
const custom = convo();
custom.gmMode = true;
ctx.appendPanelFields(custom, [{ name: 'Mood', owner: 'npc', value: 'happy' }]);
custom.messages = [reply('【Mood】：sad', 10)];
ctx.syncConvoPanel(custom);
assert.equal(custom.panel['Mood\0npc'], 'sad');
assert.ok(!custom.panelFields.includes('Mood\0player'));

// An explicit card declaration retains priority over a unique custom owner.
const declared = convo('player');
declared.gmMode = true;
ctx.appendPanelFields(declared, [{ name: 'Mood', owner: 'npc', value: 'happy' }]);
declared.messages = [reply('【HP】：25/100', 10)];
ctx.syncConvoPanel(declared);
assert.equal(declared.panel['HP\0npc'], '25/100');
assert.equal(declared.panel['HP\0player'], '50/100');
console.log('panel authority: manual timestamps, alias ordering, range and owner isolation passed');
