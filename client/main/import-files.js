'use strict';

// ============================================================================
//  main/import-files.js —— 导入链路的编排（一串文件 → 要落盘的角色 / 世界书）
//
//  导入链路单独成模块，才能在没有文件对话框的情况下测：
//  如果这段夹在「对话框 + fs.readFileSync + 闭包」中间，只有人手点一次导入才跑得到，
//  自动化测试里就只能拿一个 `{canceled:true}` 的桩糊过去。
//
//  最值得测的一条是**自动绑定**：角色卡里内嵌的 character_book 会被存成一本
//  独立世界书，并自动绑到这张卡上。这个绑定是「导入即可用」的关键，
//  断了的话表现是「卡导进来了、书也在库里，但就是不生效」——
//  不报错、不提示，只能靠人发现。
//
//  ⚠️ 反过来，**独立的世界书文件**会被包成一张同名角色卡：书只能跟着卡走，
//  没有「一本躺着的书」这种形态（世界书列表页已撤）。见 cardForWorldbook。
//
//  这里只负责编排：读文件、大小闸门、分派、绑定。
//  真正的形状识别和归一化在 main/card-import.js。
//  fs 由调用方注入，测试能喂内存里的假文件系统。
// ============================================================================

// 单文件大小上限（12MB），调用方可以覆盖。
const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
// 一次导入的文件数上限，防止手滑全选整个目录
const MAX_IMPORT_FILES = 100;

/**
 * 把一本**独立的**世界书包成一张角色卡（卡名 = 书名，书挂在卡上）。
 *
 * 书和卡现在是同一个东西的两半，没有「一本躺着的书」这种形态：脱离了卡，它既没有
 * 打开入口也没法挂到别的卡上。卡上除书名外全是空的 —— 描述 / 开场白要用户自己补。
 *
 * @returns {object|null} 归一化后的角色；没有归一化器时返回 null（调用方只收书）
 */
function cardForWorldbook(book, normalizeCharacters) {
  if (typeof normalizeCharacters !== 'function') return null;
  const name = String((book && book.name) || '').trim() || '未命名角色';
  return normalizeCharacters({ name, worldbookIds: [(book && book.id) || ''].filter(Boolean), source: 'json' });
}

/**
 * 把一批文件解析成「角色 + 世界书」。
 *
 * @param {object}   opts
 * @param {string[]} opts.paths      文件绝对路径
 * @param {function} opts.readFile   (path) => Buffer
 * @param {function} opts.parseImportFile  见 main/card-import.js
 * @param {function} opts.makeWorldbookId  生成世界书 id
 * @param {function} [opts.normalizeCharacters]  书里「角色副本」的归一化器
 *        （main/characters.js 的 normalizeCharacter）。**导入链路必须传**：
 *        不传的话，外部世界书里那份 `characters`（世界书自带的 NPC）会被
 *        静默丢掉 —— 书导进来了、条目都在，进世界却发现一个 NPC 都不在场。
 * @param {function} opts.basename   (path) => string；不传就按分隔符切
 * @param {function} opts.extname    (path) => string
 * @param {number}   [opts.maxBytes]
 * @returns {{characters: object[], worldbooks: object[], errors: string[], promoted: string[]}}
 *          `promoted` = 被包成角色卡的那些世界书的书名
 */
function importFiles(opts) {
  const o = opts || {};
  const paths = Array.isArray(o.paths) ? o.paths.filter((p) => typeof p === 'string' && p) : [];
  const readFile = o.readFile;
  const parseImportFile = o.parseImportFile;
  const makeWorldbookId = o.makeWorldbookId;
  const normalizeCharacters = o.normalizeCharacters;
  const basename = typeof o.basename === 'function' ? o.basename : (p) => String(p).split(/[\\/]/).pop();
  const extname =
    typeof o.extname === 'function'
      ? o.extname
      : (p) => {
          const base = basename(p);
          const i = base.lastIndexOf('.');
          return i > 0 ? base.slice(i) : '';
        };
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : MAX_IMPORT_BYTES;

  const characters = [];
  const worldbooks = [];
  const errors = [];
  // 被包成角色卡的世界书（书名）：渲染层要拿它单独说一句，不然用户不知道卡是哪来的
  const promoted = [];

  if (typeof readFile !== 'function' || typeof parseImportFile !== 'function') {
    return { characters, worldbooks, errors: ['导入链路没有配好（缺少 readFile / parseImportFile）'], promoted };
  }

  for (const file of paths.slice(0, MAX_IMPORT_FILES)) {
    const base = basename(file);
    let buffer;
    try {
      buffer = readFile(file);
    } catch (err) {
      errors.push(`${base}：${(err && err.message) || '读取失败'}`);
      continue;
    }

    if (!buffer || !buffer.length) {
      errors.push(`${base}：读不到内容`);
      continue;
    }
    if (buffer.length > maxBytes) {
      errors.push(`${base}：文件太大（${(buffer.length / 1048576).toFixed(1)}MB，上限 ${maxBytes / 1048576}MB）`);
      continue;
    }

    let parsed;
    try {
      parsed = parseImportFile({
        buffer,
        ext: extname(file).toLowerCase(),
        fallbackName: base.replace(/\.[^.]+$/, ''),
        makeWorldbookId,
        normalizeCharacters
      });
    } catch (err) {
      errors.push(`${base}：${(err && err.message) || '解析失败'}`);
      continue;
    }

    if (!parsed || parsed.kind === 'error') {
      errors.push(`${base}：${(parsed && parsed.error) || '解析失败'}`);
      continue;
    }

    if (parsed.kind === 'worldbook') {
      worldbooks.push(parsed.worldbook);
      // 🔴 书只能跟着卡走（世界书列表页已撤）：孤立的一本书进来没有任何入口能打开它，
      //    也没法挂到别的卡上。所以包成一张同名卡，书挂在这张卡上。
      const card = cardForWorldbook(parsed.worldbook, normalizeCharacters);
      if (card) {
        characters.push(card);
        promoted.push(card.name);
      }
      continue;
    }

    // 角色卡。内嵌世界书：给它一个正式 id 存进世界书库，并**自动绑到这个角色**上。
    // 一张卡自带的书就是给这张卡用的，导入即可用；不想要的话在角色编辑器里解绑。
    if (parsed.worldbook) {
      worldbooks.push(parsed.worldbook);
      parsed.character.worldbookIds = [parsed.worldbook.id];
    }
    characters.push(parsed.character);
  }

  if (paths.length > MAX_IMPORT_FILES) {
    errors.push(`一次最多导入 ${MAX_IMPORT_FILES} 个文件，剩下的被跳过了`);
  }

  return { characters, worldbooks, errors, promoted };
}

module.exports = { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, importFiles };
