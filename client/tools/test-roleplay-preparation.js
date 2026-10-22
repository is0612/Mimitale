'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/js/views/composer.js'), 'utf8');
const start = source.indexOf('async function prepareCompletion(convo) {');
const end = source.indexOf('\nfunction setStreaming', start);
const writtenStart = source.indexOf('function panelWrittenIn(convo, text) {');
const writtenEnd = source.indexOf('\n/**', writtenStart);
const writtenContext = vm.createContext({ convoFieldDisplayNames: () => ['Alice·abcdefghijklmnopqrstuvwx'] });
vm.runInContext(source.slice(writtenStart, writtenEnd), writtenContext);
assert.equal(writtenContext.panelWrittenIn({}, '【Alice·abcdefghijklmnopqrstuvwx】：80/100'), true);
assert.equal(writtenContext.panelWrittenIn({}, '【Unknown·abcdefghijklmnopqrstuvwx】：80/100'), false);

function harness(recall) {
  const timers = new Map();
  const ctx = vm.createContext({
    matchWorldbookSections: async () => 'worldbook', recallSection: recall, throwIfGenerationStopped() {},
    setTimeout(fn, ms) { const id = {}; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext('let cancelPreparation = null;\n' + source.slice(start, end), ctx);
  return { ctx, timers };
}
(async () => {
  let h = harness(async () => 'memories');
  let result = await h.ctx.prepareCompletion({});
  assert.equal(result.worldbook, 'worldbook');
  assert.equal(result.ragSection, 'memories');
  assert.equal(h.timers.size, 0);
  h = harness(() => new Promise(() => {}));
  const pending = h.ctx.prepareCompletion({});
  await new Promise(setImmediate);
  [...h.timers.values()].find(t => t.ms === 10000).fn();
  result = await pending;
  assert.equal(result.worldbook, 'worldbook');
  assert.equal(result.ragSection, '', 'slow optional retrieval cannot block chat');
  assert.equal(h.timers.size, 0);
  h = harness(() => new Promise(() => {}));
  const stopped = h.ctx.prepareCompletion({});
  const rejected = assert.rejects(stopped, /已停止生成/);
  vm.runInContext('cancelPreparation()', h.ctx);
  await rejected;
  assert.equal(h.timers.size, 0, 'stop cleans timers');
  console.log('PASS optional RAG timeout degrades, successful retrieval stays and explicit stop rejects');
})().catch(err => { console.error(err); process.exitCode = 1; });
