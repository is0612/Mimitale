'use strict';

// ============================================================================
//  preload.js —— 界面（网页）与主程序之间的「安全桥」
//  界面不能直接读文件或发网络请求，只能通过这里暴露的几个方法。
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

function applyChangesNow(channel, payload) {
  const response = ipcRenderer.sendSync(channel, payload);
  if (!response || !response.ok) throw new Error(response && response.error || '保存未收到主进程确认');
  return response.result;
}

// ---------------------------------------------------------------------------
//  主题：主进程通过启动参数把当前主题传进来。
//  在这里（而不是 renderer.js 里）打标记，是为了在首屏渲染前就生效，
//  否则深色模式下启动会先闪一下浅色。
// ---------------------------------------------------------------------------
// 2026-10-12：默认改成夜间 —— 判断方向反过来写（明确说了 'light' 才走浅色），
// 不传参或值不认识都落到 dark，和 main/providers.js 的默认保持一致。
const themeArg = (process.argv || []).find((arg) => arg.startsWith('--mimitale-theme='));
const initialTheme = themeArg && themeArg.endsWith('light') ? 'light' : 'dark';

const accentArg = (process.argv || []).find((arg) => arg.startsWith('--mimitale-accent='));
// 和 main/providers.js 的 ACCENTS 保持同步。preload 跑在渲染进程里、
// 拿不到主进程模块，所以这份小列表只能单独列一遍。
const INITIAL_ACCENTS = ['amber'];
const accentValue = accentArg ? accentArg.slice('--mimitale-accent='.length) : '';
const initialAccent = INITIAL_ACCENTS.includes(accentValue) ? accentValue : 'amber';

// 版本号：侧栏品牌行要显示它，而渲染层是无构建、无 Node 的，读不到 package.json。
// 主进程启动时用启动参数递进来（见 main/window.js 的 additionalArguments）。
const versionArg = (process.argv || []).find((arg) => arg.startsWith('--mimitale-version='));
const appVersion = versionArg ? versionArg.slice('--mimitale-version='.length) : '';

function applyInitialTheme() {
  if (document && document.documentElement) {
    document.documentElement.setAttribute('data-theme', initialTheme);
    document.documentElement.setAttribute('data-accent', initialAccent);
  }
}

applyInitialTheme();
window.addEventListener('DOMContentLoaded', applyInitialTheme);

contextBridge.exposeInMainWorld('mimitale', {
  // 应用版本号（就是 package.json 的 version）。只读的一个字符串，
  // 给侧栏品牌行用 —— 它经过启动参数传进来，不走 IPC。
  appVersion,

  // --- 设置 ---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  testConnection: (patch) => ipcRenderer.invoke('settings:test', patch),
  listModels: (patch) => ipcRenderer.invoke('models:list', patch),

  // --- 历史会话 ---
  getConversations: () => ipcRenderer.invoke('conversations:get'),
  saveConversations: (payload) => ipcRenderer.invoke('conversations:save', payload),
  saveConversationsNow: (payload) => {
    const response = ipcRenderer.sendSync('conversations:save-sync', payload);
    if (!response || !response.ok) throw new Error(response && response.error || '会话保存未收到主进程确认');
    return response.result;
  },

  applyLibraryChanges: (payload) => ipcRenderer.invoke('library:apply-changes', payload),
  applyLibraryChangesNow: (payload) => applyChangesNow('library:apply-changes-sync', payload),

  // --- 角色库 ---
  applyCharacterChanges: (payload) => ipcRenderer.invoke('characters:apply-changes', payload),
  applyCharacterChangesNow: (payload) => applyChangesNow('characters:apply-changes-sync', payload),
  applyWorldbookChanges: (payload) => ipcRenderer.invoke('worldbooks:apply-changes', payload),
  applyWorldbookChangesNow: (payload) => applyChangesNow('worldbooks:apply-changes-sync', payload),
  applyPresetChanges: (payload) => ipcRenderer.invoke('presets:apply-changes', payload),
  applyPresetChangesNow: (payload) => applyChangesNow('presets:apply-changes-sync', payload),
  getCharacters: () => ipcRenderer.invoke('characters:get'),
  getCharacter: (id) => ipcRenderer.invoke('characters:get-one', id),
  saveCharacter: (record) => ipcRenderer.invoke('characters:save-one', record),
  deleteCharacter: (id) => ipcRenderer.invoke('characters:delete-one', id),
  saveCharacters: (payload) => ipcRenderer.invoke('characters:save', payload),
  saveCharactersNow: (payload) => ipcRenderer.send('characters:save-sync', payload),
  importCard: () => ipcRenderer.invoke('characters:import'),

  // --- 世界书 ---
  getWorldbooks: () => ipcRenderer.invoke('worldbooks:get'),
  getWorldbook: (id) => ipcRenderer.invoke('worldbooks:get-one', id),
  saveWorldbook: (record) => ipcRenderer.invoke('worldbooks:save-one', record),
  deleteWorldbook: (id) => ipcRenderer.invoke('worldbooks:delete-one', id),
  saveWorldbooks: (payload) => ipcRenderer.invoke('worldbooks:save', payload),
  saveWorldbooksNow: (payload) => ipcRenderer.send('worldbooks:save-sync', payload),
  previewWorldbook: (payload) => ipcRenderer.invoke('worldbooks:preview', payload),

  // --- 预设（叠在对话上的一层指令） ---
  getPresets: () => ipcRenderer.invoke('presets:get'),
  getPreset: (id) => ipcRenderer.invoke('presets:get-one', id),
  savePreset: (record) => ipcRenderer.invoke('presets:save-one', record),
  deletePreset: (id) => ipcRenderer.invoke('presets:delete-one', id),
  savePresets: (payload) => ipcRenderer.invoke('presets:save', payload),
  savePresetsNow: (payload) => ipcRenderer.send('presets:save-sync', payload),
  // 导入预设文件（弹框 + 解析，不落盘）；导出走通用的 saveFile
  importPresets: () => ipcRenderer.invoke('presets:import'),
  // --- 图片 ---
  pickImage: (options) => ipcRenderer.invoke('images:pick', options),
  // 批量导入用：一次选多张（或选文件夹）拿到路径，再逐张读内容
  pickImages: (options) => ipcRenderer.invoke('images:pick-many', options),
  readImage: (filePath) => ipcRenderer.invoke('images:read', filePath),
  generateImage: (payload) => ipcRenderer.invoke('images:generate', payload),
  drawBridgeImage: (payload) => ipcRenderer.invoke('bridge:draw', payload),
  drawBridgeProgress: (payload) => ipcRenderer.invoke('bridge:drawProgress', payload),
  ragRecall: (payload) => ipcRenderer.invoke('rag:recall', payload),

  // --- 对话 ---
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  // 带 requestId 只停那一个；不带就全停
  stopChat: (requestId) => ipcRenderer.invoke('chat:stop', requestId),
  // 「请求记录」：最近几次实际发出去的请求（只在内存里，重启即空）
  requestLog: () => ipcRenderer.invoke('chat:requests'),
  clearRequestLog: () => ipcRenderer.invoke('chat:requests:clear'),

  // --- 流式增量（打字机效果） ---
  onChunk: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('chat:chunk', listener);
    return () => ipcRenderer.removeListener('chat:chunk', listener);
  },
  onReasoning: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('chat:reasoning', listener);
    return () => ipcRenderer.removeListener('chat:reasoning', listener);
  },

  // --- 账号（登录 / 注册 / 凭证）---
  // ⚠️ 返回形状统一：{ ok: true, ... } / { ok: false, error }，渲染层直接显示 error。
  // 现在背后是主进程里的假后端（main/account.js），接口按真后端定的。
  accountSession: () => ipcRenderer.invoke('account:session'),
  accountCaptcha: () => ipcRenderer.invoke('account:captcha'),
  accountSendCode: (payload) => ipcRenderer.invoke('account:send-code', payload),
  accountRegister: (payload) => ipcRenderer.invoke('account:register', payload),
  accountCompleteProfile: (payload) => ipcRenderer.invoke('account:complete-profile', payload),
  accountLogin: (payload) => ipcRenderer.invoke('account:login', payload),
  accountVoucherLogin: (payload) => ipcRenderer.invoke('account:voucher-login', payload),
  accountLogout: () => ipcRenderer.invoke('account:logout'),
  accountVoucher: () => ipcRenderer.invoke('account:voucher'),
  accountRefreshVoucher: () => ipcRenderer.invoke('account:refresh-voucher'),
  accountUpdateProfile: (payload) => ipcRenderer.invoke('account:update-profile', payload),
  accountChangePassword: (payload) => ipcRenderer.invoke('account:change-password', payload),
  accountChangeEmail: (payload) => ipcRenderer.invoke('account:change-email', payload),

  // --- 杂项 ---
  copyText: (text) => ipcRenderer.invoke('util:copy', text),
  saveFile: (payload) => ipcRenderer.invoke('util:saveFile', payload),
  // 批量导出：只弹一次「选文件夹」，把一组文件写进去（列表页的「导出」用）
  saveFiles: (payload) => ipcRenderer.invoke('util:saveFiles', payload),
  openDataFolder: (which) => ipcRenderer.invoke('util:openPath', which),
  // 用系统浏览器打开链接（只放行 http/https，判断在主进程）
  openExternal: (url) => ipcRenderer.invoke('util:openExternal', url),

  // --- 桌宠 ---
  // 桌宠是**另一扇窗口**里的事，这一组是主界面唯一能碰它的入口：
  // 设置页读写配置 / 预览、以及把「该说话了」通知主进程。
  // ⚠️ 注意宠物窗口用的是 preload-pet.js，那份**故意**比这份窄得多 ——
  //    宠物页面拿不到这里的 getSettings（里面是明文 API Key）。
  petGet: () => ipcRenderer.invoke('pet:get'),
  petSkins: () => ipcRenderer.invoke('pet:skins'),
  petUpdate: (payload) => ipcRenderer.invoke('pet:update', payload),
  petSpeak: (payload) => ipcRenderer.invoke('pet:speak', payload),
  petSayNow: (payload) => ipcRenderer.invoke('pet:say-now', payload),
  petStop: () => ipcRenderer.invoke('pet:stop'),
  petPersonaGet: (payload) => ipcRenderer.invoke('pet:persona:get', payload),
  petPersonaSave: (payload) => ipcRenderer.invoke('pet:persona:save', payload),
  petMemoryGet: (payload) => ipcRenderer.invoke('pet:memory:get', payload),
  petMemoryDelete: (payload) => ipcRenderer.invoke('pet:memory:delete', payload),
  petMemoryClear: (payload) => ipcRenderer.invoke('pet:memory:clear', payload),
  petMemoryExport: (payload) => ipcRenderer.invoke('pet:memory:export', payload),
  petSetVisible: (payload) => ipcRenderer.invoke('pet:window:setVisible', payload),

  // 配置在别处被改了（比如右键菜单里点了「暂停主动发言」）→ 设置页要跟着刷新
  onPetChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('pet:changed', listener);
    return () => ipcRenderer.removeListener('pet:changed', listener);
  },
  // 右键菜单点了「让桌宠现在说话」→ 主进程没有上下文，让界面自己组好再发回去
  onPetWantSpeak: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('pet:want-speak', listener);
    return () => ipcRenderer.removeListener('pet:want-speak', listener);
  },
  // 右键菜单点了「桌宠设置 / 查看记忆」→ 主窗口跳到设置页的桌宠区块
  onPetOpenSettings: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('pet:open-settings', listener);
    return () => ipcRenderer.removeListener('pet:open-settings', listener);
  }
});
