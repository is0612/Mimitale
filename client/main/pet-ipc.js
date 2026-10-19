'use strict';

//  main/pet-ipc.js —— 桌宠编排层：IPC 通道 + 右键菜单 + 「让宠物说话」流程。
//  ⚠️ 该不该说话由渲染层判断（会话上下文都在那边），主进程只负责「说」；
//     右键「现在说话」也只是通知渲染层组好上下文再发回来。

const { ipcMain, Menu } = require('electron');

const { loadSettings } = require('./providers.js');
const { getMainWindow, sendToRenderer } = require('./window.js');
const {
  loadPetConfig,
  savePetConfigNow,
  patchPetConfig,
  patchPet,
  findPet,
  petMemoryItems,
  petMemoryDigest,
  appendPetMemory,
  deletePetMemoryItem,
  clearPetMemory,
  exportPetMemory,
  readPersona,
  writePersona,
  resetPersona,
  listRigSkins,
  petLog,
  MUTE_DURATION_MS,
  SPEAK_EVERY_MIN,
  SPEAK_EVERY_MAX,
  SPEAK_LINES_MIN,
  SPEAK_LINES_MAX
} = require('./pet-store.js');
const { generatePetSpeech } = require('./pet-brain.js');
const { startWalkLoop, stopWalkLoop, pauseWalk, resumeWalk, refreshWalk } = require('./pet-walk.js');
const {
  createPetWindow,
  destroyPetWindow,
  getPetWindow,
  sendToPet,
  setPetVisible,
  pushPetState,
  buildPetStatePayload,
  applyScale,
  startDrag,
  stopDrag
} = require('./pet-window.js');

// 宠物自己的「正在生成」控制器
// ⚠️ 与 main/ipc.js 的 activeControllers 是两套，别合并：合并后宠物一开口会 abort 掉正在流的角色回复

let petController = null;

/** 点一下宠物时的应声：本地模板，不调模型、不进记忆 */
const POKE_LINES = [
  '…干嘛呀，正看着呢。',
  '*耳朵抖了一下* 嗯？',
  '摸鱼被抓到了…',
  '别戳了别戳了，我听着呢。',
  '*甩了甩尾巴* 有事说事～',
  '我在这儿呢，你继续聊。',
  '哼哼，我可不只是好看。',
  '想吃小鱼干…算了，你先聊。'
];

function focusMainWindow() {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 把模型列表摊平，供「切换模型」子菜单用 */
function flattenModels(settings) {
  const out = [];
  for (const provider of (settings && settings.providers) || []) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const model of models) {
      out.push({
        providerId: provider.id,
        providerName: provider.name,
        model,
        label: `${provider.name} · ${model}`
      });
    }
  }
  return out;
}

// ---- 状态打包 / 广播 ----

/** 给主界面（设置页）的完整状态：比宠物窗口那份多出人格正文、记忆条数（宠物页不该知道人格）。 */
function mainStatePayload() {
  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  const settings = loadSettings();

  return {
    config,
    pet: pet || null,
    models: flattenModels(settings),
    memoryCount: pet ? petMemoryItems(pet.id).length : 0,
    memoryDigest: pet ? petMemoryDigest(pet.id) : '',
    persona: pet ? readPersona(pet.id) : '',
    mainProviderName: settings.activeProviderId
      ? (settings.providers.find((p) => p.id === settings.activeProviderId) || {}).name || ''
      : '',
    mainModel: settings.activeModel || ''
  };
}

/** 设置变了就两边都刷（设置页与右键菜单要同步） */
function broadcastState() {
  sendToRenderer('pet:changed', mainStatePayload());
  const win = getPetWindow();
  if (win) pushPetState();
}

/** 宠物窗口那份状态统一走 buildPetStatePayload */

// ---- 说话 ----

/** 真的让宠物说一次。@param payload { reason: 'auto'|'manual'|'preview', context, petId }
 *  ⚠️ preview 永远不写记忆：设置页反复点预览会把记忆灌满。 */
async function speakOnce(payload) {
  const request = payload || {};
  const reason = request.reason === 'preview' ? 'preview' : request.reason === 'manual' ? 'manual' : 'auto';

  const config = loadPetConfig();
  if (!config.enabled) return { ok: false, error: '桌宠已关闭（到设置里重新打开）' };

  const pet = findPet(config, request.petId || config.activeId);
  if (!pet) return { ok: false, error: '没有可用的桌宠' };

  // 静音只挡自动触发；手动「现在说话」和预览不受影响，否则用户点了没反应会以为坏了
  if (reason === 'auto' && pet.mutedUntil > Date.now()) {
    return { ok: false, skipped: true, error: '正在静音' };
  }

  // 隐藏 = 不说话。这里再挡一道：主界面缓存可能晚一拍，而这里读的是刚落盘的 config，最准。
  // 少了这一道，后面那句 setPetVisible(true) 会把用户刚藏起来的猫重新顶到桌面上。
  if (reason === 'auto' && !pet.visible) {
    return { ok: false, skipped: true, error: '桌宠已隐藏' };
  }

  // 上一次还没说完就直接掐掉重来（不排队）
  if (petController) petController.abort();
  petController = new AbortController();
  const { signal } = petController;

  // ⚠️ 被 abort 的那次请求仍会跑完 finally / onDelta：它们若照常推送，会搅乱新请求的流式与
  //    「思考中」状态（旧的 finally 会把新请求的气泡关掉）。abort 只取消网络，不取消已排的回调。
  const isCurrent = () => petController !== null && petController.signal === signal;

  const win = getPetWindow();
  const petVisible = !!(win && win.isVisible());
  if (win) {
    if (!petVisible) setPetVisible(true);
    sendToPet('pet:busy', true);
  }

  try {
    const result = await generatePetSpeech({
      pet,
      request: request.context || {},
      signal,
      onDelta: (text) => { if (isCurrent()) sendToPet('pet:chunk', text); }
    });

    if (!result.ok) {
      petLog(`说话失败（${reason}）：${result.error}`);
      return { ok: false, error: result.error };
    }

    // 已被新一次请求顶掉时不再推送
    if (isCurrent()) {
      sendToPet('pet:say', {
        lines: result.lines,
        text: result.text,
        reason,
        providerName: result.providerName,
        model: result.model
      });
    }

    if (reason !== 'preview') {
      const convoTitle = String((request.context && request.context.convoTitle) || '').slice(0, 60);
      try {
        await appendPetMemory(
          pet.id,
          { kind: 'say', text: result.text.slice(0, 300), convoTitle },
          pet.memoryMaxItems
        );
        if (result.memory) {
          await appendPetMemory(
            pet.id,
            { kind: 'event', text: result.memory, convoTitle },
            pet.memoryMaxItems
          );
        }
      } catch (err) {
        // 记忆写失败不该把「已经说出口的话」变成一次失败
        petLog(`记忆写入失败：${(err && err.message) || '未知错误'}`);
      }
    }

    return {
      ok: true,
      lines: result.lines,
      text: result.text,
      memory: result.memory,
      providerName: result.providerName,
      model: result.model,
      fellBack: result.tried > 1
    };
  } finally {
    // 只有还是当前这一次才关思考状态，否则旧请求会吹灭新请求刚点亮的思考气泡
    if (isCurrent()) {
      sendToPet('pet:busy', false);
      petController = null;
    }
    broadcastState();
  }
}

/** 让主界面组好上下文再来找我们（主进程手里没有「现在聊到哪了」） */
function askRendererToSpeak(reason) {
  focusMainWindow();
  sendToRenderer('pet:want-speak', { reason: reason === 'manual' ? 'manual' : 'auto' });
}

// ---- 静音 ----

function muteRemainMs(pet) {
  return Math.max(0, (pet.mutedUntil || 0) - Date.now());
}

function setMute(pet, until) {
  return patchPet(pet.id, { mutedUntil: until }).then(() => broadcastState());
}

// 原生右键菜单：宠物窗口只有 300×380，带二级菜单的自绘菜单铺不下，
// 用 Electron Menu 白拿二级菜单、单选勾、禁用项、分隔线。

function everyTurnsSubmenu(pet) {
  const options = [1, 2, 3, 5, 10].filter((n) => n >= SPEAK_EVERY_MIN && n <= SPEAK_EVERY_MAX);
  return options.map((n) => ({
    label: `每隔 ${n} 轮`,
    type: 'radio',
    checked: pet.speakEveryTurns === n,
    click: () => patchPet(pet.id, { speakEveryTurns: n }).then(broadcastState)
  }));
}

/** 「大小」子菜单：五档 0.7 → 2 倍，「标准」= 1。用离散档位而非「放大 / 缩小」按钮 ——
 *  菜单点一下就关、看不到反馈；勾选态按 pet.scale 判，容差 0.01 免得滑块值一档都不高亮。 */
const SCALE_STEPS = [
  { scale: 0.7, label: '小' },
  { scale: 1, label: '标准' },
  { scale: 1.3, label: '大' },
  { scale: 1.6, label: '更大' },
  { scale: 2, label: '巨大' }
];

function scaleSubmenu(pet) {
  const current = Number(pet.scale) || 1;
  return SCALE_STEPS.map((step) => ({
    label: `${step.label}（${Math.round(step.scale * 100)}%）`,
    type: 'radio',
    checked: Math.abs(current - step.scale) < 0.01,
    click: () => setPetScale(step.scale)
  }));
}

/** 改缩放：落盘 + 立即应用到窗口 + 广播 */
function setPetScale(scale) {
  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  if (!pet) return Promise.resolve();
  const value = Math.max(0.4, Math.min(2, Number(scale) || 1));
  return patchPet(pet.id, { scale: value }).then(() => {
    // 再读一次，确保拿到队列写完的最终值
    applyScale(findPet(loadPetConfig(), pet.id));
    broadcastState();
  });
}

function linesSubmenu(pet) {
  const options = [];
  for (let n = SPEAK_LINES_MIN; n <= SPEAK_LINES_MAX; n += 1) options.push(n);
  return options.map((n) => ({
    label: `每次 ${n} 句`,
    type: 'radio',
    checked: pet.speakLines === n,
    click: () => patchPet(pet.id, { speakLines: n }).then(broadcastState)
  }));
}

function modelSubmenu(pet, settings) {
  const items = [
    {
      label: `跟随主模型（${settings.activeModel || '未配置'}）`,
      type: 'radio',
      checked: pet.useMainModel === true,
      click: () => patchPet(pet.id, { useMainModel: true }).then(broadcastState)
    }
  ];

  const models = flattenModels(settings);
  if (models.length) items.push({ type: 'separator' });

  for (const item of models) {
    items.push({
      label: item.label,
      type: 'radio',
      checked: pet.useMainModel === false && pet.providerId === item.providerId && pet.model === item.model,
      click: () =>
        patchPet(pet.id, { useMainModel: false, providerId: item.providerId, model: item.model }).then(
          broadcastState
        )
    });
  }
  return items;
}

function memorySubmenu(pet) {
  return [
    { label: '查看记忆…', click: () => openSettingsInMain('memory') },
    {
      label: '导出记忆…',
      click: () => {
        focusMainWindow();
        sendToRenderer('pet:open-settings', { section: 'pet', focus: 'memory', action: 'export' });
      }
    },
    { type: 'separator' },
    {
      label: '重置记忆（保留折叠摘要）',
      click: () => clearPetMemory(pet.id, true).then(broadcastState)
    },
    {
      label: '清空记忆（连摘要一起）',
      click: () => clearPetMemory(pet.id, false).then(broadcastState)
    }
  ];
}

function openSettingsInMain(focus) {
  focusMainWindow();
  sendToRenderer('pet:open-settings', { section: 'pet', focus: focus || '' });
}

function popupPetMenu() {
  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  if (!pet) return;

  const settings = loadSettings();
  const muted = pet.mutedUntil > Date.now();
  const mins = Math.ceil(muteRemainMs(pet) / 60000);

  const template = [
    {
      label: `${pet.name} · 每 ${pet.speakEveryTurns} 轮说 ${pet.speakLines} 句`,
      enabled: false
    }
  ];

  // 静音 / 暂停状态摆最上面 —— 用户右键第一件事就是想知道「它为什么不说话了」
  if (muted) template.push({ label: `已静音，还剩 ${mins} 分钟`, enabled: false });
  if (!pet.speakEnabled) template.push({ label: '主动发言已暂停', enabled: false });

  template.push(
    { type: 'separator' },
    { label: '让桌宠现在说话', click: () => askRendererToSpeak('manual') },
    muted
      ? { label: '恢复主动发言（取消静音）', click: () => setMute(pet, 0) }
      : { label: '今天别再说了（临时静音 1 小时）', click: () => setMute(pet, Date.now() + MUTE_DURATION_MS) },
    { type: 'separator' },
    {
      label: pet.speakEnabled ? '暂停主动发言' : '开启主动发言',
      click: () => patchPet(pet.id, { speakEnabled: !pet.speakEnabled }).then(broadcastState)
    },
    {
      label: '发言频率',
      submenu: [
        { label: '每隔几轮说一次', enabled: false },
        ...everyTurnsSubmenu(pet),
        { type: 'separator' },
        { label: '每次说几句', enabled: false },
        ...linesSubmenu(pet)
      ]
    },
    { label: '切换模型', submenu: modelSubmenu(pet, settings) },
    { label: '大小', submenu: scaleSubmenu(pet) },
    { type: 'separator' },
    { label: '桌宠设置…', click: () => openSettingsInMain('') },
    { label: '记忆', submenu: memorySubmenu(pet) },
    { type: 'separator' },
    {
      label: pet.walkEnabled ? '暂停散步（原地待着）' : '允许散步（在桌面上溜达）',
      click: () => patchPet(pet.id, { walkEnabled: !pet.walkEnabled }).then(() => {
        refreshWalk();
        broadcastState();
      })
    },
    pet.visible
      ? { label: '隐藏桌宠', click: () => setVisibleAndRemember(pet, false) }
      : { label: '显示桌宠', click: () => setVisibleAndRemember(pet, true) },
    {
      label: '退出桌宠',
      click: () => {
        stopWalkLoop();
        destroyPetWindow();
        patchPetConfig({ enabled: false }).then(broadcastState);
      }
    }
  );

  const win = getPetWindow();
  Menu.buildFromTemplate(template).popup({ window: win || undefined });
}

function setVisibleAndRemember(pet, visible) {
  setPetVisible(visible);
  return patchPet(pet.id, { visible }).then(() => {
    refreshWalk();
    broadcastState();
  });
}

// 换形象下拉走 pet:skins / listRigSkins（扫 assets/pet/ 与 data/pet/skins/ 下带 model.json 的目录）。

// ---- 窗口位置记忆（pet-window.js 里懒 require 调过来） ----

function rememberBounds(bounds) {
  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  if (!pet) return Promise.resolve();
  return patchPet(pet.id, { bounds });
}

// ---- 注册 ----

function registerPetIpc() {
  // ---- 来自主界面（设置页 / 触发） ----

  ipcMain.handle('pet:get', () => mainStatePayload());

  /** 列出可用形象包（换肤下拉用）：扫 assets/pet/ 与 data/pet/skins/ 下带 model.json 的目录。 */
  ipcMain.handle('pet:skins', () => listRigSkins());

  /** 改配置：{ patch } 改根上的，{ petId, patch } 改某一只的；返回最新完整状态。 */
  ipcMain.handle('pet:update', async (_event, payload) => {
    const data = payload || {};
    const patch = data.patch && typeof data.patch === 'object' ? data.patch : {};

    if (data.petId) {
      await patchPet(data.petId, patch);
    } else {
      // 走队列内的读改写：先读再写会让并发的字段修改互相覆盖。
      await patchPetConfig(patch);
    }

    // 几个字段改完要跟上副作用
    const config = loadPetConfig();
    const pet = findPet(config, config.activeId);
    if (pet) {
      applyScale(pet);
      if (!config.enabled) { stopWalkLoop(); destroyPetWindow(); }
      else setPetVisible(pet.visible);
    }

    refreshWalk(); // walkEnabled / visible / enabled 都可能刚被改
    broadcastState();
    return mainStatePayload();
  });

  ipcMain.handle('pet:speak', (_event, payload) => speakOnce(payload));

  // 把已生成好的那句话直接推过去：不重新生成、不写记忆（它本来就是预览的产物）
  ipcMain.handle('pet:say-now', (_event, payload) => {
    const text = String((payload && payload.text) || '').trim();
    if (!text) return { ok: false, error: '没有可说的内容' };
    const config = loadPetConfig();
    // 用户点过「退出桌宠」就别把窗口又拉起来（setPetVisible 会重建窗口）
    if (!config.enabled) return { ok: false, error: '桌宠已关闭' };
    const pet = findPet(config, config.activeId);
    if (pet && !pet.visible) setPetVisible(true);
    sendToPet('pet:say', { lines: [text], text, reason: 'preview' });
    return { ok: true };
  });

  ipcMain.handle('pet:stop', () => {
    if (!petController) return false;
    petController.abort();
    petController = null;
    sendToPet('pet:busy', false);
    return true;
  });

  ipcMain.handle('pet:persona:get', (_event, payload) => {
    const config = loadPetConfig();
    const pet = findPet(config, (payload && payload.petId) || config.activeId);
    return { persona: pet ? readPersona(pet.id) : '' };
  });

  ipcMain.handle('pet:persona:save', (_event, payload) => {
    const data = payload || {};
    const config = loadPetConfig();
    const pet = findPet(config, data.petId || config.activeId);
    if (!pet) return { ok: false, error: '没有可用的桌宠' };

    const text = String(data.text == null ? '' : data.text);
    // 清空当「还原成默认」：空人格会让宠物变成没有性格的生成器，别用写空文件实现（见 pet-store 的 resetPersona）
    if (!text.trim()) {
      return { ok: true, persona: resetPersona(pet.id), reset: true };
    }
    writePersona(pet.id, text);
    return { ok: true, persona: text };
  });

  ipcMain.handle('pet:memory:get', (_event, payload) => {
    const config = loadPetConfig();
    const pet = findPet(config, (payload && payload.petId) || config.activeId);
    if (!pet) return { items: [], digest: '' };
    return {
      items: petMemoryItems(pet.id).slice().reverse(), // 界面从新到旧看
      digest: petMemoryDigest(pet.id)
    };
  });

  ipcMain.handle('pet:memory:clear', async (_event, payload) => {
    const data = payload || {};
    const config = loadPetConfig();
    const pet = findPet(config, data.petId || config.activeId);
    if (!pet) return { ok: false, error: '没有可用的桌宠' };
    await clearPetMemory(pet.id, data.keepDigest === true);
    broadcastState();
    return { ok: true };
  });

  // 删**一条**记忆；和 clear 一样广播一次（状态行的「记忆 N 条」要跟着变）
  ipcMain.handle('pet:memory:delete', async (_event, payload) => {
    const data = payload || {};
    const config = loadPetConfig();
    const pet = findPet(config, data.petId || config.activeId);
    if (!pet) return { ok: false, error: '没有可用的桌宠' };
    if (!data.itemId) return { ok: false, error: '没指定要删哪一条' };
    const remain = await deletePetMemoryItem(pet.id, data.itemId);
    broadcastState();
    return { ok: true, remain };
  });

  ipcMain.handle('pet:memory:export', (_event, payload) => {
    const config = loadPetConfig();
    const pet = findPet(config, (payload && payload.petId) || config.activeId);
    if (!pet) return { ok: false, error: '没有可用的桌宠' };
    return {
      ok: true,
      text: exportPetMemory(pet.id),
      fileName: `桌宠记忆-${pet.name}-${new Date().toISOString().slice(0, 10)}.json`
    };
  });

  ipcMain.handle('pet:window:setVisible', async (_event, payload) => {
    const visible = !(payload && payload.visible === false);
    const config = loadPetConfig();
    const pet = findPet(config, config.activeId);
    if (!pet) return { ok: false, error: '没有可用的桌宠' };
    await setVisibleAndRemember(pet, visible);
    refreshWalk(); // 猫刚藏起来/冒出来，散步条件变了
    return { ok: true, visible };
  });

  // ---- 来自宠物窗口 ----

  ipcMain.on('pet:ready', () => pushPetState());

  ipcMain.handle('pet:state:get', () => buildPetStatePayload());

  ipcMain.on('pet:drag-start', () => { pauseWalk(); startDrag(); });
  ipcMain.handle('pet:drag-end', () => { resumeWalk(); return stopDrag(); });

  ipcMain.on('pet:set-click-through', (_event, ignore) => {
    const win = getPetWindow();
    if (!win) return;
    // forward 只在穿透时有意义：忽略鼠标的同时仍转发移动事件，页面才判得出鼠标回到了宠物上
    if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });

  ipcMain.on('pet:open-menu', () => popupPetMenu());

  ipcMain.handle('pet:poke', () => {
    const config = loadPetConfig();
    const pet = findPet(config, config.activeId);
    if (!config.enabled || !pet || !pet.visible) return { ok: false };
    const text = POKE_LINES[Math.floor(Math.random() * POKE_LINES.length)];
    return { ok: true, text };
  });
}

/** 启动桌宠。⚠️ 必须在主窗口建好之后才调 —— 注册 IPC 时调的话宠物会先于主界面冒出来。 */
function startPet() {
  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  if (!pet) return;
  if (!config.enabled || !pet.visible) return;

  const win = createPetWindow();
  // 用 showInactive：启动时宠物不该抢焦点，否则用户一开软件光标就被从输入框挤走
  if (win) win.showInactive();
  startWalkLoop(); // 散步循环跟窗口一起起（条件不满足时自己不动）
}

/** 关软件时的收尾：把位置同步写下去（异步写盘可能来不及） */
function shutdownPet() {
  stopWalkLoop();
  const config = loadPetConfig();
  const win = getPetWindow();
  if (win && !win.isDestroyed()) {
    const bounds = win.getBounds();
    const { screen } = require('electron');
    const display = screen.getDisplayMatching(bounds);
    const pet = findPet(config, config.activeId);
    if (pet) {
      pet.bounds = { x: bounds.x, y: bounds.y, displayId: display.id };
      try {
        savePetConfigNow(config);
      } catch (err) {
        console.warn('[pet] 退出时保存位置失败:', err.message);
      }
    }
  }
  destroyPetWindow();
}

module.exports = {
  registerPetIpc,
  startPet,
  shutdownPet,
  rememberBounds,
  broadcastState,
  // 给别的地方（比如设置页预览）复用的两个小工具
  mainStatePayload,
  askRendererToSpeak
};
