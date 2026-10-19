'use strict';

//  main/pet-window.js —— 桌宠自己的透明置顶窗口（创建 / 摆位 / 拖动 / 尺寸自愈）。
//  ⚠️ 五个窗口参数不能动：transparent / frame:false / alwaysOnTop 'screen-saver' /
//     skipTaskbar / hasShadow:false —— 改任一个就是白板、标题栏、被盖住、任务栏条目、方形阴影。

const path = require('node:path');
const { BrowserWindow, screen, shell } = require('electron');

const { loadPetConfig, findPet, petRigPack } = require('./pet-store.js');

/** 1 倍缩放下的窗口尺寸（内容区） */
const BASE_WIDTH = 300;
const BASE_HEIGHT = 380;

/** 默认摆位：主屏工作区右下角的边距 */
const DEFAULT_MARGIN = 24;

let petWindow = null;
let dragTimer = null;
let dragOffset = null;
let dragStartBounds = null;
let moveSaveTimer = null;
// 尺寸纠正自身会再送一次 'resize'：同步调即递归、连调即事件风暴，所以先攒一下再纠。
let sizeFixTimer = null;
// 上一次真正纠尺寸的时刻（节流用，见 throttledEnsureSize）
let sizeFixAt = 0;
// 内容区尺寸对应的缩放：我们自己维护「应该多大」，不从 getBounds 反推
let currentScale = 1;
// 拖动期间收到的新缩放，拖完再应用（拖动中改尺寸会让锚点错位）
let pendingScale = null;

function petPagePath() {
  return path.join(__dirname, '..', 'renderer', 'pet', 'pet.html');
}

function petPreloadPath() {
  return path.join(__dirname, '..', 'preload-pet.js');
}

function getPetWindow() {
  return petWindow && !petWindow.isDestroyed() ? petWindow : null;
}

/** 往宠物窗口推消息；窗口不在就忽略（宠物是可选功能） */
function sendToPet(channel, payload) {
  const win = getPetWindow();
  if (win) win.webContents.send(channel, payload);
}

// ---- 摆位 ----

/** 尺寸按缩放算，四舍五入到整数（否则 Windows 上可能出一像素白边） */
function sizeFor(scale) {
  const s = Math.max(0.4, Math.min(2, Number(scale) || 1));
  return {
    width: Math.round(BASE_WIDTH * s),
    height: Math.round(BASE_HEIGHT * s)
  };
}

/** ⚠️ 只用 getContentBounds / setContentBounds：Windows 上含边框↔内容尺寸按 DPI 换算且取整，
 *  跨屏往返会越变越大；content 版不参与那套换算，往返恒等。 */
function contentBoundsOf(win) {
  try {
    return win.getContentBounds();
  } catch (err) {
    return win.getBounds();
  }
}

/** 内容区尺寸是否符合当前缩放（容 1px 取整误差） */
function sizeMatchesScale(win, scale) {
  const want = sizeFor(scale);
  const now = contentBoundsOf(win);
  return Math.abs(now.width - want.width) <= 1 && Math.abs(now.height - want.height) <= 1;
}

/** 算出窗口该摆在哪：记住的位置若已不在屏内（拔了副屏 / 改了分辨率），
 *  退回主屏右下角 —— 宁可位置变，也不能让宠物「存在但看不见」。 */
function resolveBounds(pet) {
  const { width, height } = sizeFor(pet && pet.scale);
  const saved = pet && pet.bounds;

  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const area = { x: saved.x, y: saved.y, width, height };
    const display = screen.getDisplayMatching(area);
    const work = display.workArea;
    // 至少 20px 与工作区相交才算可见（猫的命中区小于窗口，压到边角也还能拖回来）
    const visible =
      saved.x + width > work.x + 20 &&
      saved.x < work.x + work.width - 20 &&
      saved.y + height > work.y + 20 &&
      saved.y < work.y + work.height - 20;
    if (visible) return { x: saved.x, y: saved.y, width, height };
  }

  const work = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(work.x + work.width - width - DEFAULT_MARGIN),
    y: Math.round(work.y + work.height - height - DEFAULT_MARGIN),
    width,
    height
  };
}

/** 缩放变了就重摆，保持右下角不动 */
function applyScale(pet) {
  const win = getPetWindow();
  if (!win) return;
  const next = Math.max(0.4, Math.min(2, Number(pet && pet.scale) || 1));
  if (Math.abs(next - currentScale) < 0.001) return;

  // 拖动 / 散步中改尺寸会让「窗口跟光标跑」的锚点错位，拖完再应用
  if (dragTimer) {
    pendingScale = next;
    return;
  }
  commitScale(win, next);
}

/** 把缩放落到窗口上（applyScale 与 stopDrag 共用） */
function commitScale(win, next) {
  if (!win || win.isDestroyed()) return;
  const before = contentBoundsOf(win);
  const { width, height } = sizeFor(next);
  // 保持右下角不动：左上角跟着尺寸差平移
  const x = before.x + (before.width - width);
  const y = before.y + (before.height - height);
  currentScale = next;
  win.setContentBounds({ x, y, width, height });
}

/** 尺寸自愈：移动 / 跨 DPI 时 Chromium 会重算内容区尺寸（每次长一点 = 「慢慢变大」），
 *  不猜它的换算，每次移动后按 sizeFor(currentScale) 拉回即可。 */
function ensureSize() {
  const win = getPetWindow();
  if (!win || !win.isVisible()) return;
  if (sizeMatchesScale(win, currentScale)) return;
  const now = contentBoundsOf(win);
  const { width, height } = sizeFor(currentScale);
  win.setContentBounds({
    x: now.x + (now.width - width),
    y: now.y + (now.height - height),
    width,
    height
  });
}

/** ⚠️ 必须用 setContentBounds 并带上尺寸，绝不能用 setPosition：系统每移动一次会按 DPI 重算内容区，
 *  只挪位置就一次涨一点；每步写「位置 + currentScale 该有的尺寸」才不漂、也不会每帧振荡。 */
function movePetWindow(x, y) {
  const win = getPetWindow();
  if (!win || win.isDestroyed()) return;
  const { width, height } = sizeFor(currentScale);
  win.setContentBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

/** ⚠️ resize 的尺寸纠正必须**节流**、不能防抖：持续 resize 会把「停下才执行」饿死
 *  （表现是长按拖动一直变大、松手才变回去），节流保证每 SIZE_FIX_MS 至少纠一次。 */
const SIZE_FIX_MS = 80;
function throttledEnsureSize() {
  const now = Date.now();
  const wait = SIZE_FIX_MS - (now - sizeFixAt);
  if (wait <= 0) {
    clearTimeout(sizeFixTimer);
    sizeFixTimer = null;
    sizeFixAt = now;
    ensureSize();
    return;
  }
  if (sizeFixTimer) return; // 已排了一个在等，别插队
  sizeFixTimer = setTimeout(() => {
    sizeFixTimer = null;
    sizeFixAt = Date.now();
    ensureSize();
  }, wait);
}

/** 记下当前位置（防抖：moved 会连发几十次，不能每次都写盘） */
function scheduleSaveBounds() {
  clearTimeout(moveSaveTimer);
  moveSaveTimer = setTimeout(() => {
    const win = getPetWindow();
    if (!win) return;
    const bounds = contentBoundsOf(win);
    const display = screen.getDisplayMatching(bounds);
    // 位置只有主进程知道，直接写配置
    const saved = require('./pet-ipc.js').rememberBounds({
      x: bounds.x,
      y: bounds.y,
      displayId: display.id
    });
    // 写盘失败只影响「下次从哪出现」，别变成 unhandled rejection
    if (saved && typeof saved.catch === 'function') {
      saved.catch((err) => console.warn('[pet] 保存窗口位置失败:', err.message));
    }
  }, 500);
}

// ---- 拖动 ----

/** 开始拖：offset = 按下时光标离窗口左上角的距离，之后窗口摆在「光标 - offset」，光标咬住同一点。
 *  轮询光标而非用渲染层增量 —— 增量在多屏 / 缩放下会累积误差、越拖越偏、过屏边界还会跳。 */
function startDrag() {
  const win = getPetWindow();
  if (!win || dragTimer) return;

  const winBounds = contentBoundsOf(win);
  const cursor = screen.getCursorScreenPoint();
  dragOffset = { x: cursor.x - winBounds.x, y: cursor.y - winBounds.y };
  dragStartBounds = winBounds;

  dragTimer = setInterval(() => {
    const w = getPetWindow();
    if (!w) return stopDrag();
    const point = screen.getCursorScreenPoint();
    // 走 movePetWindow（带尺寸）而不是 setPosition：每步都写「位置 + 正确尺寸」，
    // 系统没机会漂，不用「挪完再纠」，也就没有两个值之间的每帧振荡。
    movePetWindow(point.x - dragOffset.x, point.y - dragOffset.y);
  }, 16);
}

/** 结束拖动，**返回窗口是否真的被挪动过** —— 不能用渲染层的 clientX/clientY：窗口跟着光标跑，
 *  那对坐标几乎是常量。改由主进程比较按下与松手时的窗口位置。 */
function stopDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  dragOffset = null;

  const win = getPetWindow();
  let moved = false;
  if (win && dragStartBounds) {
    const now = contentBoundsOf(win);
    moved =
      Math.abs(now.x - dragStartBounds.x) > 3 || Math.abs(now.y - dragStartBounds.y) > 3;
  }
  dragStartBounds = null;
  if (win) {
    // 拖完先纠一次尺寸（拖动期间系统可能改过），再应用拖动中攒下的缩放
    ensureSize();
    if (pendingScale !== null) {
      const next = pendingScale;
      pendingScale = null;
      commitScale(win, next);
    }
    scheduleSaveBounds();
  }
  return moved;
}

// ---- 创建 / 销毁 ----

function createPetWindow() {
  const existing = getPetWindow();
  if (existing) return existing;

  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  const bounds = resolveBounds(pet);
  currentScale = Math.max(0.4, Math.min(2, Number(pet && pet.scale) || 1));

  petWindow = new BrowserWindow({
    ...bounds,
    useContentSize: true,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 允许拿焦点：右键菜单和拖动都靠它，否则点一下先「激活」再处理事件、菜单会闪
    focusable: true,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    // ⚠️ show: false 必须留着：默认建出即显示，而显示常伴随一次激活，宠物会在启动瞬间
    //    把光标从输入框挤走。三处显示都走 showInactive：可以冒出来，不能抢焦点。
    show: false,
    title: '桌宠',
    // 默认穿透 + 转发移动事件；页面用 elementFromPoint 判断何时关掉穿透（renderer/pet/pet.js）
    webPreferences: {
      preload: petPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // contextIsolation + sandbox 全开：宠物窗口权限本就比主窗口窄，不能更宽松
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  // 置顶级别用 'screen-saver'：普通 alwaysOnTop 会被别的置顶窗口盖住
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWindow.setIgnoreMouseEvents(true, { forward: true });

  petWindow.loadFile(petPagePath()).catch((err) => {
    console.warn('[pet] 宠物页面加载失败（窗口会停在空白）:', err.message);
  });

  // ⚠️ 绝不能导航到别的文档：preload 每个文档都会注入，拖一个 html 进去 = 把接口递出去。
  const ownPath = path.resolve(petPagePath());
  const isOwnDocument = (url) => {
    try {
      const target = new URL(String(url || ''));
      if (target.protocol !== 'file:') return false;
      const decoded = decodeURIComponent(target.pathname).replace(/^\//, '');
      return path.resolve(decoded) === ownPath;
    } catch (err) {
      return false;
    }
  };
  const blockForeignNavigation = (event, url) => {
    if (isOwnDocument(url)) return;
    event.preventDefault();
    console.warn('[pet] 拦下了一次宠物窗口导航:', url);
  };
  petWindow.webContents.on('will-navigate', blockForeignNavigation);
  petWindow.webContents.on('will-redirect', blockForeignNavigation);
  petWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 宠物窗口里出现外链一律丢给系统浏览器，不在应用内开新窗
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 移动后：① 防抖记位置；② 纠尺寸 —— 透明窗口移动时系统可能悄悄改内容区大小，
  // 不纠就是「拖着拖着越来越大」
  petWindow.on('moved', () => {
    scheduleSaveBounds();
    ensureSize();
  });
  // ⚠️ 只挂 'moved' 挡不住：Windows 重算内容区时位置可能完全不变（只把尺寸改大），'moved' 不送。
  // ⚠️ 但事件里不能同步调 ensureSize：它自己会再送 'resize'，同步即递归、连调即风暴 → 走节流。
  petWindow.on('resize', () => throttledEnsureSize());
  petWindow.on('closed', () => {
    stopDrag();
    clearTimeout(moveSaveTimer);
    clearTimeout(sizeFixTimer);
    petWindow = null;
  });

  return petWindow;
}

/** 关掉宠物窗口（退出桌宠 / 关软件时） */
function destroyPetWindow() {
  stopDrag();
  clearTimeout(moveSaveTimer);
  clearTimeout(sizeFixTimer);
  pendingScale = null;
  const win = getPetWindow();
  petWindow = null;
  if (win) win.destroy();
}

/** 显示 / 隐藏，返回最终是不是可见 */
function setPetVisible(visible) {
  if (!visible) {
    const win = getPetWindow();
    if (win) win.hide();
    return false;
  }
  const win = createPetWindow();
  win.showInactive(); // 别抢焦点：宠物冒出来不该打断正在打字的手
  // 隐藏期间配置可能被改过（缩放 / 换形象），显示后按当前缩放纠一次尺寸
  ensureSize();
  return true;
}

/** 给宠物窗口的状态载荷：ready 推送与 pet:state:get 拉取共用，形状必须一致（尤其 rig）。
 *  rig 的 model + 贴图要转 dataUrl（CSP 是 default-src 'none'，fetch 被拦），页面刷新会重来，须幂等。 */
function buildPetStatePayload() {
  const config = loadPetConfig();
  const pet = findPet(config, config.activeId);
  const rig = pet ? petRigPack(pet.look) : null;
  return {
    config: { enabled: config.enabled, activeId: config.activeId },
    pet: pet ? { ...pet, rig } : null
  };
}

function pushPetState() {
  sendToPet('pet:state', buildPetStatePayload());
}

module.exports = {
  BASE_WIDTH,
  BASE_HEIGHT,
  petPagePath,
  createPetWindow,
  destroyPetWindow,
  getPetWindow,
  sendToPet,
  setPetVisible,
  pushPetState,
  // ⚠️ 必须导出：main/pet-ipc.js 的 pet:state:get 直接调它，漏掉就每次抛 TypeError
  buildPetStatePayload,
  applyScale,
  // 散步循环每趟走完也调它兜底（有些平台 moved 不送）
  ensureSize,
  // 拖动 / 散步的 16ms 步进用它挪窗口（必须带尺寸，防漂）
  movePetWindow,
  sizeFor,
  startDrag,
  stopDrag,
  scheduleSaveBounds
};
