'use strict';
// tools/test-store-lock.js —— 落盘撞上文件锁的容错（monkey-patch fs 演出来）
//   跑法：unset ELECTRON_RUN_AS_NODE; ./node_modules/electron/dist/electron.exe --no-sandbox tools/test-store-lock.js
// ⚠️ 全程在临时目录里跑，不碰真实的 %APPDATA%\Mimitale

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

// ⚠️ 必须在 require store 之前设：data-dir.js 里「userData 被显式改过」优先级最高
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-store-lock-'));
app.setPath('userData', tmpDir);

const store = require('../main/store.js');

const convoFile = path.join(tmpDir, 'conversations.json');
const convoBackup = convoFile + '.backup';
const convoBackupTmp = convoBackup + '.tmp';

let pass = 0;
const failures = [];

function check(desc, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${desc}`);
  } else {
    failures.push(desc + (extra ? `（${extra}）` : ''));
    console.log(`  ✗ ${desc}${extra ? `（${extra}）` : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}


/** 模拟 Windows 上那种瞬时文件锁 */
function eperm() {
  const err = new Error('EPERM: operation not permitted');
  err.code = 'EPERM';
  return err;
}

/** store.js 拿的是同一个 fs 模块对象，改属性立刻生效；返回还原函数 */
function patchFs(name, wrap) {
  const original = fs[name];
  fs[name] = wrap(original);
  return () => {
    fs[name] = original;
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function save(convo) {
  return store.saveConversations({ conversations: [convo], activeId: convo.id }, { immediate: true });
}

section('① 正常写入');
save({ id: 'a', title: 'A', messages: [] });
check('主文件写入成功', (readJson(convoFile) || {}).conversations?.[0]?.id === 'a');
check('首次写入（主文件本来不存在）不产生备份', !fs.existsSync(convoBackup));
check('没有留下 .tmp', !fs.existsSync(convoFile + '.tmp'));

section('② 备份失败不拖垮主写入（EPERM 常驻）');
{
  const restore = patchFs('copyFileSync', () => () => {
    throw eperm();
  });
  let threw = null;
  try {
    save({ id: 'b', title: 'B', messages: [] });
  } catch (err) {
    threw = err;
  } finally {
    restore();
  }

  check('保存没有抛异常', !threw, threw && threw.message);
  check('数据仍然落到了主文件', (readJson(convoFile) || {}).conversations?.[0]?.id === 'b');
  check('没有留下半截的 .backup.tmp', !fs.existsSync(convoBackupTmp));
}

section('③ 瞬时锁重试（copy 前 2 次失败）');
{
  let calls = 0;
  const restore = patchFs('copyFileSync', (orig) => (...args) => {
    calls += 1;
    if (calls <= 2) throw eperm();
    return orig(...args);
  });
  try {
    save({ id: 'c', title: 'C', messages: [] });
  } finally {
    restore();
  }

  check('copyFileSync 真的重试了（调用 3 次）', calls === 3, `实际 ${calls} 次`);
  check('主文件是新内容', (readJson(convoFile) || {}).conversations?.[0]?.id === 'c');
  // 写 c 之前主文件是 b，所以这次的备份内容应该是 b
  check('备份被更新成上一版（b）', (readJson(convoBackup) || {}).conversations?.[0]?.id === 'b');
}

// 只对「写到 conversations.json」那次生效，免得误伤 tryBackup 里对 .backup 的 rename
section('④ 主写入 rename 撞锁重试');
{
  let locked = 0;
  const restore = patchFs('renameSync', (orig) => (from, to) => {
    if (to === convoFile && locked < 1) {
      locked += 1;
      throw eperm();
    }
    return orig(from, to);
  });
  try {
    save({ id: 'd', title: 'D', messages: [] });
  } finally {
    restore();
  }

  check('rename 撞锁后重试成功', (readJson(convoFile) || {}).conversations?.[0]?.id === 'd');
  check('没有留下 .tmp', !fs.existsSync(convoFile + '.tmp'));
}

section('⑤ 备份失败时 .backup 不被写坏');
{
  const before = readJson(convoBackup);
  const restore = patchFs('renameSync', (orig) => (from, to) => {
    if (to === convoBackup) throw eperm();
    return orig(from, to);
  });
  try {
    save({ id: 'e', title: 'E', messages: [] });
  } finally {
    restore();
  }

  check('主文件照常写入', (readJson(convoFile) || {}).conversations?.[0]?.id === 'e');
  check('备份仍是可解析的完整 JSON', !!readJson(convoBackup));
  check(
    '备份内容没被这次写入动过',
    JSON.stringify(readJson(convoBackup)) === JSON.stringify(before)
  );
  check('中转的 .backup.tmp 被清理掉', !fs.existsSync(convoBackupTmp));
}

section('⑥ 备份回填失败仍能读出数据');
{
  const good = { conversations: [{ id: 'backup-1', title: '来自备份', messages: [] }], activeId: 'backup-1' };
  fs.writeFileSync(convoBackup, JSON.stringify(good, null, 2), 'utf8');
  fs.writeFileSync(convoFile, '{ 这不是 JSON', 'utf8');

  const restore = patchFs('copyFileSync', () => () => {
    throw eperm();
  });
  let loaded = null;
  try {
    loaded = store.loadConversations();
  } finally {
    restore();
  }

  check('备份里的数据被读出来了', loaded && loaded.conversations.length === 1, JSON.stringify(loaded));
  check('读出来的就是备份那一条', loaded && loaded.conversations[0].id === 'backup-1');
}

// ⚠️ 报错原文一样 ≠ 原因一样：EPERM 也可能是进程被降成低完整性（见 main/store.js 开头）
section('⑦ .backup 带只读属性时的真实 EPERM');
{
  const oldData = { conversations: [{ id: 'old', title: '旧', messages: [] }], activeId: 'old' };
  fs.writeFileSync(convoBackup, JSON.stringify(oldData, null, 2), 'utf8');
  fs.chmodSync(convoBackup, 0o444);

  let threw = null;
  try {
    save({ id: 'f', title: 'F', messages: [] });
  } catch (err) {
    threw = err;
  } finally {
    fs.chmodSync(convoBackup, 0o666); // 先解锁，免得后面清不掉目录
  }

  check('只读的备份没让保存失败', !threw, threw && threw.message);
  check('主文件仍然写到了最新', (readJson(convoFile) || {}).conversations?.[0]?.id === 'f');
  check('只读的备份保持原样（也就没被写坏）', (readJson(convoBackup) || {}).conversations?.[0]?.id === 'old');
}

section('⑧ 长会话读回不截断');
{
  const messages = Array.from({ length: 450 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `第 ${i} 条`
  }));
  const summaries = [{ id: 's1', title: '第 1 段', text: '前情', start: 0, end: 300 }];
  save({ id: 'long', title: '长会话', messages, summaries });

  const loaded = store.loadConversations();
  const convo = loaded.conversations.find((c) => c.id === 'long');
  // ⚠️ 全用 ?.：截断回归时 messages[300] 是 undefined，直接 .content 会抛异常，主进程弹框卡住不退出
  const msgs = (convo && convo.messages) || [];
  const end = convo?.summaries?.[0]?.end;
  check('450 条消息全部读回', msgs.length === 450, `实际 ${msgs.length} 条`);
  check('第一条还是最早那条', msgs[0]?.content === '第 0 条');
  check('摘要覆盖点对应的消息没变', msgs[end]?.content === '第 300 条');
}

console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log(`失败 ${failures.length} 条 / 通过 ${pass} 条`);
  for (const f of failures) console.log(`  · ${f}`);
} else {
  console.log(`全部通过：${pass} 条`);
}
console.log('='.repeat(60));

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (err) {
  /* 清不掉就算了 */
}

app.exit(failures.length ? 1 : 0);
