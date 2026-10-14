'use strict';

// ============================================================================
//  tools/test-quick-phrases.js —— 输入框「快捷短语」的插入逻辑
//
//  跑法： node --test tools/test-quick-phrases.js
//        （或 node tools/test-quick-phrases.js）
//
//  为什么单独一份：插入那句话是「纯字符串运算 + 一个光标位」，
//  而它出错的方式在界面上**很难复现也很难看出来** ——
//  选区反了会把中间几个字吃掉、下标越界会插到末尾（或抛错），
//  插错地方只能靠人眼盯着输入框发现。抽成纯函数就是为了在这里钉住。
//
//  ⚠️ views/quickPhrases.js 是渲染层的 ES module，import 链上会碰 core/dom.js
//     的 `document.getElementById`，所以先塞一个只认这一件事的假 document。
//     这里**不碰真界面**，也不加载 composer（插入后用派发 input 事件通知它）。
// ============================================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// core/dom.js 在加载时就把 el.* 抓齐了（`document.getElementById(id)` 一串），
// 这里给个恒返回 null 的壳就够了 —— 本文件只测纯函数，不用元素。
globalThis.document = { getElementById: () => null };

const MODULE_URL = pathToFileURL(
  path.join(__dirname, '..', 'renderer', 'js', 'views', 'quickPhrases.js')
).href;

let mod;
test.before(async () => {
  mod = await import(MODULE_URL);
});

test('短语表：每行都有名字和插入文本，名字不重样', () => {
  const list = mod.QUICK_PHRASES;
  assert.ok(Array.isArray(list) && list.length > 0, '短语表不能是空的');
  const names = new Set();
  for (const phrase of list) {
    assert.ok(String(phrase.name || '').trim(), `有一行没有名字：${JSON.stringify(phrase)}`);
    assert.ok(String(phrase.insert || '').length, `「${phrase.name}」没有插入文本`);
    assert.ok(!names.has(phrase.name), `名字重了：${phrase.name}`);
    names.add(phrase.name);
  }
});

test('短语表：前缀类指令整条带全角括号（括号是内容的一部分，要原样进输入框）', () => {
  const prefixes = ['旁白', 'OOC', '内心', '摄像机视角'];
  for (const name of prefixes) {
    const phrase = mod.QUICK_PHRASES.find((p) => p.name === name);
    assert.ok(phrase, `前缀类短语少了「${name}」`);
    assert.ok(
      phrase.insert.startsWith('（') && phrase.insert.endsWith('：）'),
      `「${name}」应该是「（…：）」，实际是 ${phrase.insert}`
    );
  }
});

test('短语表：除符号外都整条带括号，符号那几行不要预览', () => {
  for (const phrase of mod.QUICK_PHRASES) {
    if (phrase.preview === false) {
      assert.ok(!phrase.insert.includes('（'), `「${phrase.name}」不要预览，插进去的就不该带括号`);
    } else {
      assert.ok(
        phrase.insert.startsWith('（') && phrase.insert.endsWith('）'),
        `「${phrase.name}」要整条带括号，实际是 ${phrase.insert}`
      );
    }
  }
});

test('插入：空输入框 → 就是插入文本，光标落在末尾', () => {
  assert.deepEqual(mod.applyInsert('', 0, 0, '旁白：'), { value: '旁白：', caret: 3 });
});

test('插入：整条「（…）」插完，光标停在右括号**里面**（好接着写内容）', () => {
  // 「（旁白：）」共 5 个字符，光标应该在第 4 个字符之前（= 右括号前）
  assert.deepEqual(mod.applyInsert('', 0, 0, '（旁白：）'), { value: '（旁白：）', caret: 4 });
  // 整句指令同样：光标在右括号前，直接回车发出去的内容一个字都不会少
  assert.deepEqual(mod.applyInsert('', 0, 0, '（继续）'), { value: '（继续）', caret: 3 });
});

test('插入：不是以右括号收尾的内容，光标就在末尾（不瞎往前挪）', () => {
  assert.deepEqual(mod.applyInsert('', 0, 0, '♡'), { value: '♡', caret: 1 });
  assert.deepEqual(mod.applyInsert('', 0, 0, 'AB)'), { value: 'AB)', caret: 3 }); // 半角括号不算
});

test('插入：光标在中间 → 插在光标处，光标跟到插入内容后面', () => {
  assert.deepEqual(mod.applyInsert('AB', 1, 1, 'x'), { value: 'AxB', caret: 2 });
});

test('插入：有选区 → 替换掉选区（和输入框自己的行为一致）', () => {
  assert.deepEqual(mod.applyInsert('ABCD', 1, 3, 'x'), { value: 'AxD', caret: 2 });
});

test('插入：选区反了（end < start）不吃掉中间那几个字', () => {
  assert.deepEqual(mod.applyInsert('ABC', 2, 0, 'x'), { value: 'ABxC', caret: 3 });
});

test('插入：下标越界 / 不是数字都夹回合法范围，不抛错', () => {
  assert.deepEqual(mod.applyInsert('AB', 99, 99, 'x'), { value: 'ABx', caret: 3 });
  assert.deepEqual(mod.applyInsert('AB', -5, -5, 'x'), { value: 'xAB', caret: 1 });
  assert.deepEqual(mod.applyInsert('AB', NaN, NaN, 'x'), { value: 'xAB', caret: 1 });
  assert.deepEqual(mod.applyInsert('AB', undefined, undefined, 'x'), { value: 'xAB', caret: 1 });
});

test('插入：空插入文本不改变内容，光标不动', () => {
  assert.deepEqual(mod.applyInsert('AB', 1, 1, ''), { value: 'AB', caret: 1 });
});

test('插入：输入值不是字符串时按空串处理（别把 undefined 拼进去）', () => {
  assert.deepEqual(mod.applyInsert(null, 0, 0, 'x'), { value: 'x', caret: 1 });
  assert.deepEqual(mod.applyInsert(undefined, 0, 0, 'x'), { value: 'x', caret: 1 });
});

test('插入：面板上点一行，插进去的就是那行的 insert 原文', () => {
  // 抽查几条形状不一样的：整句指令 / 带破折号 / 纯符号
  const cases = [
    ['推进剧情', '（推进剧情到下一个场景）'],
    ['时间流逝', '（时间流逝——）'],
    ['♡……', '♡……']
  ];
  for (const [name, expected] of cases) {
    const phrase = mod.QUICK_PHRASES.find((p) => p.name === name);
    assert.ok(phrase, `短语表里少了「${name}」`);
    assert.equal(phrase.insert, expected);
    // 走一遍真正的插入路径：插到空框里应该是原文
    assert.equal(mod.applyInsert('', 0, 0, phrase.insert).value, expected);
  }
});
