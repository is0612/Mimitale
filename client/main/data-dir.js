'use strict';

//  main/data-dir.js —— 「用户数据放哪」只在这里决定一次：默认是程序旁边的 data\（便携）。
//  ⚠️ 只搬 DATA_FILES 里的用户数据，Chromium 的 Cache / profile 不搬 —— 装在只读目录里也能起得来。
//  顺序：显式改过的 userData → MIMITALE_DATA_DIR → 程序旁 data\ → 回退 %APPDATA%（宁可回 C 盘也不能起不来）。

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR_NAME = 'data';

/** 哪些才算「用户的数据」：搬家、判空、诊断三处共用；加新数据文件时记得同步加一行（.backup 由后缀循环带上）。 */
const DATA_FILES = [
  'config.json',
  'conversations.json',
  'characters.json',
  'worldbooks.json',
  'presets.json',
  'vectors.json'
];

let cachedDir = null;
let cachedInfo = null;

/** Electron 默认的 userData（%APPDATA%\<应用名>） */
function defaultUserDataDir() {
  return path.join(app.getPath('appData'), app.getName());
}

/** userData 被显式改过（测试 / --user-data-dir）就以它为准 */
function userDataWasOverridden() {
  try {
    return path.resolve(app.getPath('userData')) !== path.resolve(defaultUserDataDir());
  } catch (err) {
    return false;
  }
}

/** 程序所在的文件夹：打包后 = exe 同级；免安装 = 项目根目录 */
function appFolder() {
  try {
    if (app.isPackaged) return path.dirname(app.getPath('exe'));
  } catch (err) {
    /* 读不到就退回下面那条 */
  }
  return app.getAppPath();
}

/** 程序旁边的 data 目录 */
function portableDataDir() {
  return path.join(appFolder(), DATA_DIR_NAME);
}

/** 探目录能不能写。⚠️ 必须真写一个文件：existsSync 只证明读得通，沙箱 / 权限策略下
 *  常见「目录在、能列、能读，但建不出文件」，只看 existsSync 会以为一切正常。 */
function probeDirWritable(dir) {
  const probe = path.join(dir, `.mimitale-write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return { ok: true, error: '' };
  } catch (err) {
    try {
      fs.unlinkSync(probe);
    } catch (cleanupErr) {
      /* 删不掉也无所谓 */
    }
    return { ok: false, error: err.message };
  }
}

/** 新目录里有没有数据文件（有一个就算非空） */
function hasAnyDataFile(dir) {
  return DATA_FILES.some((name) => {
    try {
      return fs.existsSync(path.join(dir, name));
    } catch (err) {
      return false;
    }
  });
}

/** 把老位置的数据拷到新位置。⚠️ 只拷不删（新位置那张盘坏了还能捞回），
 *  且只在新位置一个数据文件都没有时才动手，免得盖掉用户后来的改动。 */
function migrateFromLegacy(toDir) {
  const legacy = defaultUserDataDir();
  if (path.resolve(legacy) === path.resolve(toDir)) return 0;
  if (!fs.existsSync(legacy)) return 0;
  // 新位置已有数据 → 别再拿老的盖上去
  if (hasAnyDataFile(toDir)) return 0;

  let copied = 0;
  for (const name of DATA_FILES) {
    for (const suffix of ['', '.backup']) {
      const src = path.join(legacy, name + suffix);
      const dst = path.join(toDir, name + suffix);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      try {
        fs.copyFileSync(src, dst);
        copied += 1;
      } catch (err) {
        console.warn('[data] 老数据拷贝失败（跳过这一份）:', path.basename(src), err.message);
      }
    }
  }
  return copied;
}

// 数据目录里的「使用说明.txt」：⚠️ 必须程序生成（data/ 在 .gitignore 里，不会随代码带上），
// 且必须 UTF-8 带 BOM —— Windows 记事本对无 BOM 的 UTF-8 中文会按 ANSI/GBK 解、全乱码。

const README_FILE_NAME = '使用说明.txt';

/** 说明正文（开头那个 \uFEFF 就是 BOM） */
function dataDirReadmeText() {
  return (
    '\uFEFF' +
    [
      'Mimitale 数据文件夹 —— 说明',
      '================================',
      '',
      '这里放的是你自己的东西：角色卡、聊天记录、世界书、预设和设置。',
      '程序把数据放在这里（而不是 C 盘），所以：',
      '',
      '  · 整个 Mimitale 文件夹拷走 = 角色卡 / 聊天记录 / 世界书 / 预设都跟着走',
      '    （API Key 除外：它由 Windows 绑在本机加密，换电脑或换 Windows 账号要重新填一次）',
      '  · 想备份：把整个 data 文件夹复制一份就行',
      '  · 想清空重来：先关掉程序，再删掉这个文件夹，下次启动会重建一个空的',
      '',
      '各文件是什么',
      '--------------------------------',
      '  characters.json     角色库：导入或新建的角色卡都在这（含头像和立绘）',
      '  worldbooks.json     世界书（含从角色卡里抽出来的内嵌世界书）',
      '  conversations.json  所有聊天记录',
      '  presets.json        预设：叠在对话上的那层指令',
      '  config.json         设置。⚠️ 里面有 API Key（已加密），别把这个文件发人',
      '  vectors.json        语义检索的向量缓存。删了不影响聊天，会自己重建',
      '  dialog-state.json   文件选择框「上次打开的目录」。删了没影响',
      '',
      '  *.backup            每个文件上一次保存前的自动备份。',
      '                      主文件万一损坏，程序会自动从它恢复，所以别删。',
      '  *.tmp               写入过程中的临时文件，正常情况下看不到。',
      '                      如果看到了、而且程序没在运行，那它是残留，可以删。',
      '',
      '几条注意',
      '--------------------------------',
      '  · 程序运行的时候别手改这些 .json —— 退出时会被内存里的内容覆盖回去。',
      '  · 想换个位置放（比如 D 盘、U 盘），启动前设一个环境变量：',
      '        set MIMITALE_DATA_DIR=D:\\我的人设库',
      '  · Chromium 的缓存（Cache / GPUCache / Local Storage 等）不在这里，',
      '    仍留在系统盘。那些是缓存不是你的内容，删掉只会让下次启动稍慢一点。',
      '  · 别把这个文件夹设成只读，也别长期放在网盘/同步目录里用。',
      '',
      '本文件由程序自动生成：内容有变化会在下次启动时更新，删掉也会自动重建。',
      ''
    ].join('\r\n')
  );
}

/** 确保数据目录里有一份说明。⚠️ 失败只记日志，绝不能影响启动或保存；
 *  内容没变就不写（免得每次启动都刷新 mtime）。 */
function ensureDataDirReadme(dir) {
  const file = path.join(dir, README_FILE_NAME);
  const text = dataDirReadmeText();
  try {
    // 兜底路径下目录可能还不存在，先建出来（后面写数据也要用）
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      try {
        if (fs.readFileSync(file, 'utf8') === text) return false;
      } catch (readErr) {
        /* 读不动就照写一遍 */
      }
    }
    fs.writeFileSync(file, text, 'utf8');
    return true;
  } catch (err) {
    console.warn('[data] 写数据目录说明失败（不影响使用）:', err.message);
    return false;
  }
}

/** 决定数据目录放哪，返回 { dir, info }（不缓存、不写说明） */
function resolveDataDir() {
  // ① 调用方显式改过 userData（测试 / --user-data-dir）
  if (userDataWasOverridden()) {
    return { dir: app.getPath('userData'), info: { source: 'userData-override', fallback: false } };
  }

  // ② 环境变量指定
  const envDir = String(process.env.MIMITALE_DATA_DIR || '').trim();
  if (envDir) {
    const probe = probeDirWritable(envDir);
    if (probe.ok) {
      return { dir: path.resolve(envDir), info: { source: 'env', fallback: false } };
    }
    console.warn('[data] MIMITALE_DATA_DIR 写不进去，忽略它并改用默认位置:', envDir, probe.error);
  }

  // ③ 程序旁边的 data\（默认）
  const portable = portableDataDir();
  const probe = probeDirWritable(portable);
  if (probe.ok) {
    const copied = migrateFromLegacy(portable);
    if (copied) {
      console.log(
        `[data] 数据目录已迁到程序旁边：${portable}` +
          `（从 ${defaultUserDataDir()} 拷了 ${copied} 个文件，老文件保留没删）`
      );
    }
    return { dir: portable, info: { source: 'portable', fallback: false, migrated: copied } };
  }

  // ④ 兜底：老位置
  console.warn(
    '[data] 程序旁边的 data 目录写不进去，退回系统默认数据目录:',
    portable,
    probe.error
  );
  return {
    dir: app.getPath('userData'),
    info: { source: 'fallback', fallback: true, error: probe.error }
  };
}

/** 当前生效的数据目录（懒加载 + 缓存；首次调用时决定、搬一次家、放一份说明）。
 *  ⚠️ 必须在任何读写数据文件之前调用才算数（store.js 的 dataFile() 是调用时才取目录）。 */
function dataDir() {
  if (cachedDir) return cachedDir;

  const { dir, info } = resolveDataDir();
  cachedDir = dir;
  cachedInfo = { dir, ...info };

  // 顺手放一份说明（失败不影响任何功能）
  ensureDataDirReadme(dir);

  return cachedDir;
}

/** 给界面 / 诊断用的一句话：数据在哪、为什么在那儿 */
function dataDirInfo() {
  if (!cachedInfo) dataDir();
  return {
    ...cachedInfo,
    portable: portableDataDir(),
    legacy: defaultUserDataDir()
  };
}

/** 只在测试里用：忘掉缓存，下次重新解析 */
function resetDataDirCache() {
  cachedDir = null;
  cachedInfo = null;
}

module.exports = {
  dataDir,
  dataDirInfo,
  probeDirWritable,
  portableDataDir,
  defaultUserDataDir,
  resetDataDirCache,
  DATA_DIR_NAME,
  DATA_FILES,
  README_FILE_NAME
};
