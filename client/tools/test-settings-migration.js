'use strict';

// tools/test-settings-migration.js —— 设置结构迁移（config.json 的 v1 → v2）；跑法：node --test tools/test-settings-migration.js
// ⚠️ DEFAULT_SETTINGS 只对「磁盘上缺这个键」生效（每次保存都把整份归一化结果落盘），老配置只能靠版本号 + 一次性迁移
// ⚠️ 无 Electron 运行时：先往 require 缓存里塞个假 electron；写盘落在 tmpRoot 的假 userData，不碰真实数据
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mimitale-settings-mig-'));
const fakeElectron = {
  app: {
    getName: () => 'Mimitale',
    getPath: (name) => (name === 'appData' ? path.join(tmpRoot, 'a') : path.join(tmpRoot, 'a', 'M')),
    getAppPath: () => path.join(__dirname, '..'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => s,
    decryptString: (s) => s
  }
};
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const { normalizeSettings, takeSettingsNotices, DEFAULT_SETTINGS, saveSettings, ACCENTS } = require('../main/providers.js');
// 假 electron 的 userData 指在 tmpRoot 里，data-dir.js 会当成「显式改过」直接用它 —— 不碰真实数据
const { dataFile } = require('../main/store.js');

// 必须有 providers，不然会走旧版扁平配置分支（那不是这里要测的）；且不写 settingsVersion
const legacy = (depth) => ({
  providers: [{ id: 'p1', name: '测试', baseUrl: 'https://a', apiKey: '', models: ['m'] }],
  activeProviderId: 'p1',
  activeModel: 'm',
  ...(depth === undefined ? {} : { worldbookRecursiveDepth: depth })
});

test('旧配置（无版本号）+ 深度为旧默认值 3 → 收敛到新的默认值', () => {
  takeSettingsNotices(); // 清空，避免上一条用例的残留
  const out = normalizeSettings(legacy(3));
  // 目标值不写死：迁移的语义是「旧默认值 → 新默认值」，写死会在下次改默认值时对不上
  assert.equal(out.worldbookRecursiveDepth, DEFAULT_SETTINGS.worldbookRecursiveDepth, '值必须真的被改掉');
  assert.equal(DEFAULT_SETTINGS.worldbookRecursiveDepth, 1, '当前的新默认值是 1（只带一层）');
  assert.equal(out.settingsVersion, 2, '版本号要抬到 2，迁移只做一次');

  const notices = takeSettingsNotices();
  assert.equal(notices.length, 1, '迁移改的是用户的设置，必须产生一条告知');
  assert.match(notices[0], /递归深度/, '告知里要说清改了哪一项');
  assert.deepEqual(takeSettingsNotices(), [], '通知取走即清空，不该反复弹');
});

test('用户自己把深度改成 0/2/4/5 时一律不动', () => {
  takeSettingsNotices();
  for (const depth of [0, 2, 4, 5]) {
    const out = normalizeSettings(legacy(depth));
    assert.equal(out.worldbookRecursiveDepth, depth, `用户选的 ${depth} 不能被迁移覆盖`);
  }
  assert.deepEqual(takeSettingsNotices(), [], '没迁移就不该有通知');
});

test('已固化的配置（version=2）里用户又选回 3 → 必须尊重', () => {
  takeSettingsNotices();
  const saved = { ...legacy(0), settingsVersion: 2, worldbookRecursiveDepth: 3 };
  const out = normalizeSettings(saved);
  assert.equal(out.worldbookRecursiveDepth, 3, '版本号已是 2，迁移不再介入，用户的选择说了算');
  assert.deepEqual(takeSettingsNotices(), []);
});

test('迁移幂等：把迁移结果再归一化一次，值不变、也不再发通知', () => {
  takeSettingsNotices();
  const once = normalizeSettings(legacy(3));
  takeSettingsNotices();
  const twice = normalizeSettings({ ...legacy(3), ...once });
  assert.equal(twice.worldbookRecursiveDepth, DEFAULT_SETTINGS.worldbookRecursiveDepth);
  assert.equal(twice.settingsVersion, 2);
  assert.deepEqual(takeSettingsNotices(), [], '第二次不该再通知');
});

test('全新安装（没有任何配置）：用默认值，且不产生迁移通知', () => {
  takeSettingsNotices();
  const out = normalizeSettings({});
  assert.equal(out.worldbookRecursiveDepth, DEFAULT_SETTINGS.worldbookRecursiveDepth);
  assert.equal(DEFAULT_SETTINGS.worldbookRecursiveDepth, 1, '新装默认 1 层');
  assert.deepEqual(takeSettingsNotices(), [], '全新安装没什么好告知的');
});

// 新装拿到啥 / 老配置保持啥要分开钉：混在一条用例里，哪一半坏了都看不出来
test('全新安装：默认是夜间 + 琥珀灯', () => {
  const out = normalizeSettings({});
  assert.equal(out.theme, 'dark', '新装默认夜间');
  assert.equal(out.accent, 'amber', '新装默认琥珀灯');

  // DEFAULT_SETTINGS 不只是补缺键的表：window.js 拿它当首屏窗口底色，写错 = 深色应用启动先闪白底
  assert.equal(DEFAULT_SETTINGS.theme, 'dark', 'DEFAULT_SETTINGS 必须是真实的出厂默认');
  assert.equal(DEFAULT_SETTINGS.accent, 'amber', 'DEFAULT_SETTINGS 必须和 ACCENTS[0] 一致');
  // 「默认配色 = ACCENTS 第一项」被好几处 fallback 依赖（window.js / preload.js），别让它们各写各的
  assert.equal(DEFAULT_SETTINGS.accent, ACCENTS[0], '默认配色就是 ACCENTS 的第一项');
});

test('老配置写着 light / pink → 明暗原样保留；下线的配色退回默认那套', () => {
  takeSettingsNotices();
  const out = normalizeSettings({ ...legacy(1), theme: 'light', accent: 'pink' });
  assert.equal(out.theme, 'light', '老用户选的白天不能被新默认值改掉');
  // ⚠️ 和 theme 那半条不同：theme 只是改了默认值（用户选择仍有效），pink 是**这个值本身没了**
  assert.equal(out.accent, DEFAULT_SETTINGS.accent, '下线的配色退回默认那套');
  assert.deepEqual(takeSettingsNotices(), [], '改默认值 / 退配色都不是「迁移」，不该发通知');
});

test('theme 只认 light，其余（缺键 / 脏值）一律算夜间', () => {
  assert.equal(normalizeSettings({}).theme, 'dark', '缺键 → 夜间');
  assert.equal(normalizeSettings({ theme: null }).theme, 'dark', 'null → 夜间');
  assert.equal(normalizeSettings({ theme: 'DARK' }).theme, 'dark', '大小写对不上的脏值 → 夜间');
  assert.equal(normalizeSettings({ theme: 'dark' }).theme, 'dark');
  assert.equal(normalizeSettings({ theme: 'light' }).theme, 'light', '只有明确写了 light 才是白天');
});

test('accent 只认白名单里的配色，认不出来就退回默认那套', () => {
  for (const a of ACCENTS) {
    assert.equal(normalizeSettings({ accent: a }).accent, a, `${a} 是合法配色`);
  }
  // 故意钉住数量：加回一套配色时这条会红，逼着同时补 style.css 的 token 块 + window.js 的 WINDOW_BG
  assert.equal(ACCENTS.length, 1, '现在只剩一套配色');
  assert.deepEqual(ACCENTS, ['amber'], '剩下的那套是琥珀灯，且它是默认（ACCENTS[0]）');
  for (const dead of ['pink', 'blue', 'matcha']) {
    assert.equal(normalizeSettings({ accent: dead }).accent, DEFAULT_SETTINGS.accent, `${dead} 已下线 → 退回默认`);
  }
  assert.equal(normalizeSettings({ accent: 'rainbow' }).accent, DEFAULT_SETTINGS.accent, '脏值退回默认');
  assert.equal(normalizeSettings({ accent: null }).accent, DEFAULT_SETTINGS.accent, 'null 退回默认');
});

test('saveSettings：内置名（constructor / toString）混不过白名单', async () => {
  const saved = await saveSettings({ constructor: 'x', toString: 'y', theme: 'dark' });
  assert.equal(saved.theme, 'dark', '白名单里的正常键照存');
  const onDisk = JSON.parse(fs.readFileSync(dataFile('config.json'), 'utf8'));
  for (const key of ['constructor', 'toString']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(onDisk, key), `「${key}」不该被写进 config.json`);
  }
});

test('saveSettings：写盘失败要让调用方知道（返回被拒绝的 Promise，而不是假装成功）', async () => {
  const original = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('disk full');
    err.code = 'ENOSPC'; // 非瞬时锁，不重试，直接抛
    throw err;
  };
  try {
    await assert.rejects(Promise.resolve(saveSettings({ theme: 'light' })), /写入失败/);
  } finally {
    fs.renameSync = original;
  }
});

test('API Key 解不开时不再把密文当 Key（换电脑 / 换 Windows 账号）', () => {
  const { decryptApiKey } = require('../main/store.js');
  // 真 safeStorage 只认自己写出来的 blob，别的输入一律抛；这里用前缀模拟（BLOB: 能解 / FAIL 解不开）
  fakeElectron.safeStorage.isEncryptionAvailable = () => true;
  fakeElectron.safeStorage.decryptString = (buf) => {
    const text = buf.toString('utf8');
    if (text.startsWith('FAIL')) throw new Error('bad data');
    if (!text.startsWith('BLOB:')) throw new Error('not a DPAPI blob');
    return text.slice(5);
  };
  // 密文都很长：DPAPI 给短字符串包了 100 多字节的头，base64 之后 100 字符往上
  const unreadable = Buffer.from('FAIL' + 'x'.repeat(200), 'utf8').toString('base64');
  const readable = Buffer.from('BLOB:sk-' + 'y'.repeat(200), 'utf8').toString('base64');
  const hexKey = 'a1b2c3d4'.repeat(8); // 64 位十六进制：全是 base64 字符集，但是真 Key

  try {
    assert.ok(unreadable.length > 80, '前提：这个是「长密文」');
    assert.equal(decryptApiKey(unreadable), '', '解不开的长密文返回空 —— 不能把密文当 Key 发出去');
    assert.equal(decryptApiKey(hexKey), hexKey, '看着像 base64 的短明文 Key 照旧能用（不能误伤）');
    assert.equal(decryptApiKey('sk-abc123def456'), 'sk-abc123def456', '带 - 的正常 Key 原样返回');
    assert.equal(decryptApiKey(''), '', '空的还是空');
    assert.equal(decryptApiKey(readable), 'sk-' + 'y'.repeat(200), '能解开的密文照常还原');  } finally {
    // 还原成这份测试共用的假实现（没有加密能力）
    fakeElectron.safeStorage.isEncryptionAvailable = () => false;
    fakeElectron.safeStorage.decryptString = (s) => s;
  }
});

test('saveSettings: concurrent patches preserve both changes', async () => {
  // ⚠️ 两个 patch 必须改不同的键（只剩一套 accent，拼不出两个合法值）；测的是串行队列不丢改动
  await saveSettings({ theme: 'light', sendOnEnter: true });
  await Promise.all([saveSettings({ theme: 'dark' }), saveSettings({ sendOnEnter: false })]);
  const saved = JSON.parse(fs.readFileSync(dataFile('config.json'), 'utf8'));
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.sendOnEnter, false);
});

test('saveSettings: queued patches are snapshots and recover after failure', async () => {
  const patch = { theme: 'light' };
  const pending = saveSettings(patch);
  patch.theme = 'dark'; // 调用之后再改这个对象：落盘的必须是**调用那一刻**的快照
  assert.equal((await pending).theme, 'light');

  const original = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('disk full');
    err.code = 'ENOSPC';
    throw err;
  };
  try {
    await assert.rejects(saveSettings({ theme: 'light' }), /写入失败/);
  } finally {
    fs.renameSync = original;
  }
  assert.equal((await saveSettings({ theme: 'dark' })).theme, 'dark');
});

test('清理临时目录', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    // 删不掉不影响结论
  }
});
