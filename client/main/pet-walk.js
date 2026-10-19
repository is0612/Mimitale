'use strict';

// 桌宠散步（让蓝白猫在桌面上自己溜达）。放在主进程是因为窗口位置只有主进程能动，且和拖动走同一套「16ms 轮询」。
// ⚠️ 只往左或往右走、纵向完全不动（见 startTrip）；拖拽中不散，由 pet-ipc 的 pause/resume 控制。

const { screen } = require('electron');

const { loadPetConfig, findPet } = require('./pet-store.js');
const { getPetWindow, sendToPet, ensureSize, movePetWindow } = require('./pet-window.js');

/** 等待间隔（秒）：两次散步之间 */
const WAIT_MIN = 90;
const WAIT_MAX = 360;
/** 单趟距离（px）与速度（px/s） */
const TRIP_MIN = 120;
const TRIP_MAX = 420;
const SPEED = 40;
/** 步进间隔（ms）—— 和拖动同款 */
const STEP_MS = 16;

let planTimer = null;   // 等待下一趟的定时器
let walkTimer = null;   // 一趟中的 16ms 步进
let target = null;      // { x, y } 目标窗口左上角
let walkPosition = null; // 浮点位置；窗口 API 只接受四舍五入后的坐标
let paused = false;     // 拖拽等临时暂停（不拆整个循环）

// 条件与生命周期

/** 散步的总开关条件：功能开着 + 这只猫可见 + 允许散步 + 窗口在 */
function walkAllowed() {
  const config = loadPetConfig();
  if (!config.enabled) return false;
  const pet = findPet(config, config.activeId);
  if (!pet || !pet.visible || pet.walkEnabled === false) return false;
  const win = getPetWindow();
  return !!(win && !win.isDestroyed() && win.isVisible());
}

/** 状态变化后调：条件满足就保证循环在跑，不满足就整个停下 */
function refreshWalk() {
  if (walkAllowed()) {
    if (!planTimer && !walkTimer) scheduleNextTrip();
  } else {
    stopTrip(false);
    clearTimeout(planTimer);
    planTimer = null;
  }
}

// 一趟散步

function scheduleNextTrip() {
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    planTimer = null;
    // ⚠️ 暂停 / 条件不满足时不自动重排：等外部状态变化再排，避免暂停期间空转
    if (paused || !walkAllowed()) return;
    startTrip();
  }, (WAIT_MIN + Math.random() * (WAIT_MAX - WAIT_MIN)) * 1000);
}

function startTrip() {
  const win = getPetWindow();
  if (!win || win.isDestroyed()) return;

  const bounds = win.getBounds();
  const work = screen.getDisplayMatching(bounds).workArea;
  const margin = 24; // 离屏幕边至少留这么多，别贴边或压任务栏

  /** ⚠️ 只左右走，纵向完全不动：斜一点点观感上就是「飘着走」，和「贴着桌面溜达」是两回事。
   *  `y` 一律沿用当前值，连 clamp 都不做 —— clamp 也会造成纵向位移。 */
  const dist = TRIP_MIN + Math.random() * (TRIP_MAX - TRIP_MIN);
  const dir = Math.random() < 0.5 ? -1 : 1; // 左右各半

  const maxX = work.x + work.width - bounds.width - margin;
  const x = Math.round(Math.max(work.x + margin, Math.min(maxX, bounds.x + dir * dist)));

  // ⚠️ 判据只看横向 dx（纵向恒为 0）；贴着屏幕边缘时目标会被 clamp 回原地，取消这趟是对的。
  const dx = x - bounds.x;
  if (Math.abs(dx) < 24) { stopTrip(true); return; }
  target = { x, y: bounds.y };

  walkPosition = { x: bounds.x, y: bounds.y };
  // 只左右走 → 朝向恒由横向分量定。
  const facing = dx > 0 ? 1 : -1;
  sendToPet('pet:walk', { walking: true, facing });

  let last = Date.now();
  clearInterval(walkTimer);
  walkTimer = setInterval(() => {
    const w = getPetWindow();
    if (!w || w.isDestroyed() || paused || !target) { stopTrip(false); return; }
    const now = Date.now();
    const step = SPEED * Math.max(0.001, (now - last) / 1000);
    last = now;
    const b = w.getBounds();
    // ⚠️ 别在这里调 walkAllowed()：它要 loadPetConfig()（同步读盘 + 归一化），16ms 一次 = 几百次主线程读盘。
    //    配置那几项一改，pet-ipc 都会调 refreshWalk() 把这趟停掉。
    if (!w.isVisible()) { stopTrip(true); return; }
    if (!walkPosition) walkPosition = { x: b.x, y: b.y };
    // 只左右走：纵向一列不动，横向推进到目标即可（不做 hypot/向量分解）。
    const ddx = target.x - walkPosition.x;
    const d = Math.abs(ddx);
    if (d <= Math.max(2, step)) {
      walkPosition.x = target.x;
      movePetWindow(target.x, target.y);
      stopTrip(true);
      return;
    }
    walkPosition.x += (ddx > 0 ? 1 : -1) * step;
    // ⚠️ 走 movePetWindow（带尺寸）而不是 setPosition：连续移动时系统会重算内容区尺寸，
    //    不带尺寸挪「散步时越来越大」就会悄悄回来。
    movePetWindow(walkPosition.x, walkPosition.y);
  }, STEP_MS);
}

/** 结束当前这趟（或取消还没开始的这趟）；notify=true 时告诉渲染层「停下了」（猫从步态回站立）。 */
function stopTrip(notify) {
  clearInterval(walkTimer);
  walkTimer = null;
  target = null;
  walkPosition = null;
  // ⚠️ 一趟走完纠一次尺寸：连续移动后某些平台会把内容区尺寸算歪（「散步时越来越大」）。
  //    moved 事件不保证每次都送，这里兜一道。
  ensureSize();
  if (notify) sendToPet('pet:walk', { walking: false });
  if (!planTimer && !paused && walkAllowed()) scheduleNextTrip();
}

// 对外

/** 启动散步循环（pet-ipc 注册时调） */
function startWalkLoop() {
  paused = false;
  refreshWalk();
}

/** 整个停下（退出桌宠 / 关软件） */
function stopWalkLoop() {
  paused = false;
  stopTrip(false);
  clearTimeout(planTimer);
  planTimer = null;
}

/** 临时暂停（拖拽中）：取消当前趟，条件恢复后重新等下一趟 */
function pauseWalk() {
  if (!planTimer && !walkTimer) return;
  paused = true;
  if (walkTimer) stopTrip(true); // 推 walking:false，猫停下步态
}

function resumeWalk() {
  paused = false;
  refreshWalk();
}

module.exports = {
  startWalkLoop,
  stopWalkLoop,
  pauseWalk,
  resumeWalk,
  refreshWalk
};
