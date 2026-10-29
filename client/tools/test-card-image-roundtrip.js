'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { pngWithTextChunk, parseCharacterCardPng } = require('../main/png.js');
const { parseImportFile } = require('../main/card-import.js');
const { normalizeCharacter } = require('../main/characters.js');
const { worldbookPayload: rendererWorldbookPayload } = (() => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/data/library.js'), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/\bexport /g, '');
  const state = { characters: [], worldbooks: [] };
  const context = vm.createContext({
    state,
    uid: () => 'id',
    asArray: (value) => Array.isArray(value) ? value : [],
    normalizePanelFields: (value) => Array.isArray(value) ? value : [],
    normalizeWorldbook: (raw) => raw
  });
  vm.runInContext(source, context, { filename: 'data/library.js' });
  return { worldbookPayload: context.worldbookPayload };
})();

// Pixel payload and original source images deliberately differ. The PNG pixel
// image remains a compatibility preview; embedded Mimitale image metadata is
// the lossless source on re-import.
const pngPixels = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const image = (tail) => `data:image/png;base64,${pngPixels.toString('base64')}${tail}`;
const avatar = image('A');
const portrait = image('P');
const expressionImage = image('E');
const importCharacter = (card, ext = '.json', extraBuffer = null) => parseImportFile({
  buffer: extraBuffer || Buffer.from(JSON.stringify(card)),
  ext,
  fallbackName: 'fallback',
  makeWorldbookId: () => 'book-roundtrip',
  normalizeCharacters: (raw) => normalizeCharacter(raw, 'json')
});

function loadChatExporter() {
  const loadedImages = [];
  const drawnImages = [];
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/views/chatExport.js'), 'utf8')
    .replace(/^import\s[\s\S]*?;\s*$/gm, '')
    .replace(/\bexport /g, '');
  let saved;
  class FakeImage {
    width = 2;
    height = 3;
    set src(value) {
      this._src = value;
      loadedImages.push(value);
      queueMicrotask(() => this.onload());
    }
  }
  const context = vm.createContext({
    TextEncoder,
    Uint8Array,
    Date,
    Image: FakeImage,
    btoa,
    safeFileName: (name) => name,
    showToast() {},
    saveExport: async (options) => { saved = options; },
    saveExportMany: async () => {},
    activeConvo: () => null,
    characterForConvo: () => null,
    characters: () => [],
    effectiveWorldbookIds: () => [],
    worldbookById: () => null,
    characterBookPayload: () => null,
    characterAttrs: () => [],
    convoPanel: () => ({}),
    convoPanelFields: () => [],
    panelFieldName: (key) => key,
    panelKeyParts: () => ({ owner: '' }),
    panelOwnerLabel: () => '',
    convoPlayer: () => null,
    userName: () => '你',
    speakerName: () => '助手',
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {}, fillText() {}, drawImage(...args) { drawnImages.push(args); }
        }),
        toDataURL: () => `data:image/png;base64,${pngPixels.toString('base64')}`
      })
    }
  });
  vm.runInContext(source, context, { filename: 'views/chatExport.js' });
  return {
    exportCharacterCard: async (card) => {
      saved = null;
      loadedImages.length = 0;
      drawnImages.length = 0;
      await context.exportCharacterCard(card);
      return { saveRequest: saved, loadedImages: [...loadedImages], drawnImages: [...drawnImages] };
    }
  };
}
const exporter = loadChatExporter();
const decodePngPayload = (saveOptions) => {
  assert.ok(saveOptions && saveOptions.pngText, 'exporter produced a PNG save request');
  const embedded = Buffer.from(saveOptions.pngText.text, 'base64').toString('utf8');
  return JSON.parse(embedded);
};

test('JSON role cards preserve avatar, portrait, expression images and default portrait', () => {
  const sourceCard = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '全图角色',
      extensions: { mimitale: {
        avatar, portrait,
        expressions: [{ name: '开心', keywords: ['笑'], key: 'happy', default: true, image: expressionImage }]
      } }
    }
  };
  const result = importCharacter(sourceCard);
  assert.equal(result.kind, 'character');
  assert.equal(result.character.avatar, avatar);
  assert.equal(result.character.portrait, portrait);
  assert.equal(result.character.expressions[0].image, expressionImage);
  assert.equal(result.character.expressions[0].key, 'happy');
  assert.equal(result.character.expressions[0].default, true);
});

test('actual chatExport PNG payload round-trips all image metadata through the real importer', async () => {
  const character = {
    name: '完整导出', avatar, portrait,
    expressions: [{ name: '开心', keywords: ['笑'], key: 'happy', default: true, image: expressionImage }]
  };
  const { saveRequest, loadedImages, drawnImages } = await exporter.exportCharacterCard(character);
  assert.deepEqual(loadedImages, [avatar]);
  assert.equal(drawnImages.length, 1);
  const embedded = decodePngPayload(saveRequest);
  assert.equal(embedded.data.extensions.mimitale.avatar, avatar);
  assert.equal(embedded.data.extensions.mimitale.portrait, portrait);
  assert.equal(embedded.data.extensions.mimitale.expressions[0].image, expressionImage);

  const pixelPng = Buffer.from(saveRequest.base64, 'base64');
  const pngFile = pngWithTextChunk(pixelPng, saveRequest.pngText.keyword, saveRequest.pngText.text);
  const result = importCharacter(null, '.png', pngFile);
  assert.equal(result.kind, 'character');
  assert.equal(result.character.avatar, avatar, 'original avatar metadata wins over preview pixels');
  assert.equal(result.character.portrait, portrait);
  assert.equal(result.character.expressions[0].image, expressionImage);
});

test('PNG import prefers original Mimitale avatar metadata over raster preview pixels', () => {
  const sourceCard = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: 'PNG角色',
      extensions: { mimitale: {
        avatar, portrait,
        expressions: [{ name: '开心', image: expressionImage }]
      } }
    }
  };
  const encoded = pngWithTextChunk(pngPixels, 'chara', Buffer.from(JSON.stringify(sourceCard)).toString('base64'));
  const decoded = parseCharacterCardPng(encoded);
  assert.ok(decoded, 'real PNG text chunk parser reads card metadata');
  const result = importCharacter(null, '.png', encoded);
  assert.equal(result.kind, 'character');
  assert.equal(result.character.avatar, avatar, 'preserve original avatar rather than replacing it with PNG preview bytes');
  assert.equal(result.character.portrait, portrait);
  assert.equal(result.character.expressions[0].image, expressionImage);
});

test('portrait-only role export uses portrait preview and still embeds original portrait metadata', async () => {
  const character = { name: '手建角色', avatar: '', portrait, expressions: [{ name: '笑', image: expressionImage }] };
  const { saveRequest, loadedImages, drawnImages } = await exporter.exportCharacterCard(character);
  assert.deepEqual(loadedImages, [portrait]);
  assert.equal(drawnImages.length, 1);
  const embedded = decodePngPayload(saveRequest);
  assert.equal(embedded.data.extensions.mimitale.avatar, '');
  assert.equal(embedded.data.extensions.mimitale.portrait, portrait);
  assert.equal(embedded.data.extensions.mimitale.expressions[0].image, expressionImage);
  assert.equal(saveRequest.fileName, '手建角色.png');

  const pngFile = pngWithTextChunk(
    Buffer.from(saveRequest.base64, 'base64'), saveRequest.pngText.keyword, saveRequest.pngText.text
  );
  const imported = importCharacter(null, '.png', pngFile);
  assert.equal(imported.kind, 'character');
  assert.equal(imported.character.avatar, '', 'explicit empty avatar metadata must not be replaced by preview pixels');
  assert.equal(imported.character.portrait, portrait);
  assert.equal(imported.character.expressions[0].image, expressionImage);
});

test('PNG without Mimitale avatar metadata falls back to its pixel data', () => {
  const externalCard = {
    spec: 'chara_card_v2',
    data: {
      name: '外部卡',
      extensions: { mimitale: { portrait, expressions: [{ name: '开心', image: expressionImage }] } }
    }
  };
  const encoded = pngWithTextChunk(pngPixels, 'chara', Buffer.from(JSON.stringify(externalCard)).toString('base64'));
  const result = importCharacter(null, '.png', encoded);
  assert.equal(result.kind, 'character');
  assert.equal(result.character.avatar, `data:image/png;base64,${encoded.toString('base64')}`);
  assert.equal(result.character.portrait, portrait);
  assert.equal(result.character.expressions[0].image, expressionImage);
});

test('worldbook NPC payload and importer preserve portrait tri-state and expression images', () => {
  const book = {
    name: '三态书', entries: [], characters: [
      { name: '继承头像', avatar, expressions: [{ name: '笑', image: expressionImage }] },
      { name: '明确清空', avatar, portrait: '', expressions: [{ name: '惊讶', image: expressionImage }] },
      { name: '指定立绘', avatar, portrait, expressions: [{ name: '开心', image: expressionImage }] }
    ]
  };
  const payload = rendererWorldbookPayload(book);
  assert.equal(Object.hasOwn(payload.characters[0], 'portrait'), false, 'legacy missing key stays missing');
  assert.equal(payload.characters[1].portrait, '', 'explicitly empty portrait is serialized');
  assert.equal(payload.characters[2].portrait, portrait);

  // Export as a Tavern lorebook and pass through the real importer/normalizer.
  const imported = importCharacter({ name: '三态书', entries: {}, characters: payload.characters }, '.json');
  assert.equal(imported.kind, 'worldbook');
  const [legacy, cleared, specified] = imported.worldbook.characters;
  assert.equal(Object.hasOwn(legacy, 'portrait'), false);
  assert.equal(cleared.portrait, '');
  assert.equal(specified.portrait, portrait);
  assert.equal(cleared.avatar, avatar);
  assert.equal(cleared.expressions[0].image, expressionImage);
  assert.equal(specified.expressions[0].image, expressionImage);
});
