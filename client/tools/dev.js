'use strict';

// ============================================================================
//  tools/dev.js —— 开发模式启动器（npm run dev）
//
//  为什么不直接在 package.json 里写 `electron . --dev`：这个脚本多做两件事。
//
//  1. 清掉继承来的 ELECTRON_RUN_AS_NODE。
//     这个变量一存在，electron.exe 就退化成纯 node 运行 —— require('electron')
//     拿不到 app，启动即报 "Cannot read properties of undefined (reading 'whenReady')"。
//     某些终端 / IDE 的任务环境会带着它，从这儿过一道最省心。
//
//  2. 跟 Start-Mimitale.ps1 共用同一份「沙箱记忆」。
//     本机的火绒会拦 Electron 的沙箱初始化，进程在启动阶段就 STATUS_BREAKPOINT
//     （0x80000003，npm 读成 -2147483645）挂掉 —— 本项目代码一行都没跑到。
//     启动器为此做了「崩了就用 --no-sandbox 重试一次 + 落标记」的兜底，
//     而 dev 脚本以前是裸的 `electron . --dev`，绕过了那套兜底，于是同一台机器上
//     会出现「双击启动器能开、npm run dev 闪一下就没」这种自相矛盾的现象。
//
//  ⚠️ 标记文件跟启动器是**同一个**（项目根 .mimitale-no-sandbox），两边都只看
//     文件 mtime、30 天过期。别在这儿另起一个名字，否则两边判断会打架。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const markerPath = path.join(projectRoot, '.mimitale-no-sandbox');

// 跟 Start-Mimitale.ps1 的 $noSandboxMaxAge 保持一致：30 天。
// 机器修好之后（换 Electron / 安全软件更新 / 换账号）会自动回到正常路径，
// 不会永远卡在 --no-sandbox 上。
const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// STATUS_BREAKPOINT：一种读法是 0x80000003，另一种是它当有符号 32 位读出来的样子
// （npm 打印的就是后一种）。两个都收，别赌 Node 在 Windows 上给哪个。
const SANDBOX_CRASH_CODES = new Set([0x80000003, -2147483645]);

const MARKER_TEXT = [
  '# Electron 的沙箱在这台机器上起不来（STATUS_BREAKPOINT 0x80000003），',
  '# 启动时改用 --no-sandbox。由 Start-Mimitale.ps1 / tools/dev.js 自动写入，',
  '# 超过 30 天后会被忽略并重新探测。删掉这个文件等于让它下次重新试一遍正常路径。',
  ''
].join('\r\n');

/** 标记还在有效期内吗（只看 mtime，跟启动器一个口径） */
function sandboxKnownBroken() {
  try {
    return Date.now() - fs.statSync(markerPath).mtimeMs < MARKER_MAX_AGE_MS;
  } catch (err) {
    return false; // 文件不在 —— 那就是「不知道」，先按正常路径试
  }
}

/** 起一个 Electron，把它的输出和退出码原样带回来 */
function launch(noSandbox) {
  return new Promise((resolve) => {
    const args = ['.', '--dev', ...process.argv.slice(2)];
    if (noSandbox) args.push('--no-sandbox');

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(electronPath, args, {
      cwd: projectRoot,
      env,
      stdio: 'inherit'
    });

    child.on('error', (err) => {
      console.error('[dev] 起不来：', err.message);
      resolve(1);
    });

    child.on('close', (code, signal) => {
      if (signal) return resolve(1);
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

// electron 包在纯 node 里被 require 时，导出的是 electron.exe 的绝对路径
let electronPath = null;
try {
  electronPath = require('electron');
} catch (err) {
  // 下面统一报错，这里不重复
}
if (typeof electronPath !== 'string') {
  console.error('[dev] 找不到 Electron 运行时。先在 client/ 里跑一次 npm install。');
  process.exit(1);
}

(async function main() {
  const known = sandboxKnownBroken();
  if (known) {
    console.log('[dev] 这台机器的 Electron 沙箱起不来（.mimitale-no-sandbox），直接以 --no-sandbox 启动。');
  }

  let code = await launch(known);

  // 只有「没标记 + 正好是这个崩溃码」才当成沙箱问题 —— 别的报错（比如用户代码 throw）
  // 退出码不是这个，原样把它交回去，免得把所有崩溃都赖到沙箱头上、还顺手落个假标记。
  if (!known && SANDBOX_CRASH_CODES.has(code)) {
    console.log('');
    console.log('[dev] Electron 在启动阶段就崩了（0x80000003 = STATUS_BREAKPOINT），项目代码还没跑到。');
    console.log('[dev] 这是沙箱初始化被安全软件拦下，跟代码无关 —— 用 --no-sandbox 重试一次，');
    console.log('[dev] 并把结论记进 .mimitale-no-sandbox，之后每次启动都直接跳过这次崩溃。');
    console.log('');

    try {
      fs.writeFileSync(markerPath, MARKER_TEXT, 'utf8');
    } catch (err) {
      console.warn('[dev] 标记没写成（下次启动还会再崩一次）：', err.message);
    }

    code = await launch(true);
  }

  process.exit(code);
})();
