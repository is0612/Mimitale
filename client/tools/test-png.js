'use strict';

// tools/test-png.js —— PNG 角色卡「文字怎么藏进图里」的专项测试；跑法：node tools/test-png.js（或 npm run test:png）
// 冒烟里那条「导出 → 再导入」验的是整条链路，这里验的是「各种块的形状」本身
// ⚠️ 全程在内存里拼 Buffer，不落盘、不碰 userData（不需要 MIMITALE_DATA_DIR）

const zlib = require('node:zlib');

const { crc32, isPng, pngWithTextChunk, readTextChunk, parseCharacterCardPng } =
  require('../main/png.js');

// 测试自己造夹具，不依赖仓库里的示例图

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 一个标准 PNG 块：长度 + 类型 + 数据 + CRC32（CRC 对「类型 + 数据」算） */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

// 1×1 的灰度图头，够用了（我们不解码像素，只在乎块结构）
const IHDR = (() => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(1, 0);
  b.writeUInt32BE(1, 4);
  b[8] = 8; // bit depth
  return b;
})();

function png(chunks) {
  return Buffer.concat([SIGNATURE, chunk('IHDR', IHDR), ...chunks, chunk('IEND', Buffer.alloc(0))]);
}

/** tEXt：关键字 \0 明文（Latin-1） */
function tEXt(keyword, text) {
  return chunk('tEXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')
  ]));
}

/** zTXt：关键字 \0 压缩方法(1) zlib 数据（解压后是 Latin-1） */
function zTXt(keyword, text) {
  return chunk('zTXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]),
    zlib.deflateSync(Buffer.from(text, 'latin1'))
  ]));
}

/** iTXt：关键字 \0 压缩标志(1) 压缩方法(1) \0 语言标签 \0 译文 \0 文本（UTF-8，可压可不压） */
function iTXt(keyword, text, opts = {}) {
  const { compress = true, lang = 'zh-CN', translated = '译文' } = opts;
  const body = Buffer.from(text, 'utf8');
  return chunk('iTXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'), Buffer.from([0]),
    Buffer.from([compress ? 1 : 0, 0]), Buffer.from([0]),
    Buffer.from(lang, 'latin1'), Buffer.from([0]),
    Buffer.from(translated, 'utf8'), Buffer.from([0]),
    compress ? zlib.deflateSync(body) : body
  ]));
}

// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function ok(condition, label) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) {
    passed += 1;
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`);
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

// 夹具带中文：顺带压住 UTF-8 没解错这件事

const CARD = {
  name: '测试角色',
  description: '带中文的描述 —— émoji ✨',
  first_mes: '你好呀',
  data: { alternate_greetings: ['一', '二'] }
};
const JSON_TEXT = JSON.stringify(CARD);
const B64 = Buffer.from(JSON_TEXT, 'utf8').toString('base64');

// ---------------------------------------------------------------------------
section('三种文本块都能读出来');

eq(parseCharacterCardPng(png([tEXt('ccv3', B64)])), CARD, 'tEXt / ccv3（老行为，回归）');
eq(parseCharacterCardPng(png([zTXt('chara', B64)])), CARD, 'zTXt / chara（压缩）');
eq(parseCharacterCardPng(png([iTXt('ccv3', B64)])), CARD, 'iTXt / ccv3（压缩）');
eq(
  parseCharacterCardPng(png([iTXt('ccv3', B64, { compress: false })])),
  CARD,
  'iTXt 未压缩（压缩标志 = 0）'
);
eq(
  parseCharacterCardPng(png([iTXt('ccv3', B64, { lang: '', translated: '', compress: false })])),
  CARD,
  'iTXt 语言标签 / 译文都为空'
);

section('关键字的约定');

const oldB64 = Buffer.from(JSON.stringify({ name: '旧的 v2' }), 'utf8').toString('base64');
ok(
  parseCharacterCardPng(png([tEXt('chara', oldB64), zTXt('ccv3', B64)])).name === '测试角色',
  'ccv3 优先于 chara（两张卡数据同时存在时）'
);
ok(
  parseCharacterCardPng(png([tEXt('Comment', B64), zTXt('Software', B64)])) === null,
  '只有别的关键字（Comment / Software）-> null'
);
ok(parseCharacterCardPng(png([])) === null, '一张干净图 -> null');
ok(parseCharacterCardPng(Buffer.from('不是 PNG')) === null, '非 PNG -> null');
ok(isPng(SIGNATURE) === true && isPng(Buffer.alloc(4)) === false, 'isPng 只认那 8 字节签名');

section('内容不是 base64 时的兜底');

eq(parseCharacterCardPng(png([iTXt('ccv3', JSON_TEXT)])), CARD, '有些工具直接塞明文 JSON');
ok(
  parseCharacterCardPng(png([tEXt('ccv3', '这不是 JSON 也不是 base64')])) === null,
  '既不是 base64 也不是 JSON -> null（不抛）'
);

section('块结构上的边角');

const idat = chunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0x00])));
ok(
  parseCharacterCardPng(png([idat, tEXt('Comment', 'x'), zTXt('ccv3', B64)])).name === '测试角色',
  '文本块散在别的块之间也读得到'
);
// IEND 之后就该停 —— 继续扫会读到附加数据上去
ok(
  parseCharacterCardPng(
    Buffer.concat([png([]), zTXt('ccv3', B64)])
  ) === null,
  'IEND 之后不再继续扫'
);
// 长度字段不可信：写个超长的长度
const lying = Buffer.concat([Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('tEXt', 'latin1')]);
ok(
  parseCharacterCardPng(Buffer.concat([SIGNATURE, chunk('IHDR', IHDR), lying])) === null,
  '长度字段越界 -> 停（不读脏数据、不抛）'
);
ok(
  parseCharacterCardPng(png([chunk('tEXt', Buffer.from('ccv3没有分隔符', 'latin1'))])) === null,
  '块里没有 \\0 分隔符 -> 跳过'
);
ok(
  parseCharacterCardPng(png([chunk('iTXt', Buffer.from('ccv3\0\0\0就到这了', 'latin1'))])) === null,
  'iTXt 结构不完整 -> null'
);

section('坏数据不炸（这一节最要紧）');

const badZip = chunk('zTXt', Buffer.concat([
  Buffer.from('ccv3', 'latin1'), Buffer.from([0, 0]), Buffer.from('我不是 zlib 数据')
]));
ok(parseCharacterCardPng(png([badZip])) === null, '坏 zlib 流 -> null 而不是抛异常');
ok(
  parseCharacterCardPng(png([badZip, tEXt('chara', B64)])).name === '测试角色',
  '坏块不影响同一张图里别的块'
);
// 压缩炸弹：64MB 的 'A' 压完很小，靠 maxOutputLength 拦
const bomb = chunk('zTXt', Buffer.concat([
  Buffer.from('ccv3', 'latin1'), Buffer.from([0, 0]),
  zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x41))
]));
ok(parseCharacterCardPng(png([bomb])) === null, '压缩炸弹被解压上限拦住');

section('导出那一半');

const written = pngWithTextChunk(png([]), 'chara', B64);
eq(parseCharacterCardPng(written), CARD, '写入 tEXt 再读回来（往返）');
ok(
  written.toString('latin1', 8 + 4 + 4 + 13 + 4 + 4, 8 + 4 + 4 + 13 + 4 + 4 + 4) === 'tEXt',
  '导出的块就插在 IHDR 后面'
);
ok(readTextChunk(written, 'chara') === B64, 'readTextChunk 能直接拿到原文');
// 导出永远写 tEXt（各家都认的最小公约数），即使原图是 zTXt 也不改写原块
ok(
  readTextChunk(pngWithTextChunk(png([zTXt('ccv3', B64)]), 'chara', 'x'), 'ccv3') === B64,
  '导出不会动原有的块'
);
ok(pngWithTextChunk(Buffer.from('不是 PNG'), 'chara', B64).toString() === '不是 PNG', '不是 PNG 就原样返回（不写出坏文件）');

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败 / 共 ${passed + failures.length} 条`);
  console.log('失败项：\n  - ' + failures.join('\n  - '));
} else {
  console.log(`✓ 全部通过：${passed}/${passed}`);
}

process.exit(failures.length ? 1 : 0);
