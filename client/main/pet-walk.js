'use strict';

// ============================================================================
//  main/pet-walk.js —— 桌宠散步（让蓝白猫在桌面上自己溜达）
//
//  为什么放在主进程：窗口的位置只有主进程能动（渲染层只知道自己窗口内的事），
//  而且和拖动走的是同一套「16ms 轮询 setPosition」机制 —— 不经过渲染层转发
//  坐标，就不会抖、也不会跟系统缩放打架（见 pet-window.js 文件头）。
//
//  行为节奏（一期刻意从简）：
//    等 90~360 秒（随机） → 在**当前显示器的工作区**里挑一个相距 120~420px 的
//    目标点（**只往左或往右，纵向完全不动**，见 startTrip）→ 以 40px/s 匀速走过去
//    → 到达即停 → 回到等待。
//
//  中断规则：
//    · 拖拽中不散（用户拎着它呢）—— pet-ipc 的 drag-start / drag-end 会调 pause/resume
//    · 隐藏 / 退出桌宠 / walkEnabled 关掉 → 循环整个停下（条件恢复时重新起）
//    · 说话不打断：边走边吐槽是它的自由
//
//  对渲染层只推一个事件：pet:walk { walking, facing } —— 猫切步态 / 转身。
//  散步期间的窗口移动会连发 'moved' → pet-window 的防抖存位在停步后落一次盘，
//  正好把散步终点记下来（重启后猫从上次溜达完的地方出现）。
// ============================================================================

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

// ---------------------------------------------------------------------------
//  条件与生命周期
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
//  一趟散步
// ---------------------------------------------------------------------------

function scheduleNextTrip() {
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    planTimer = null;
    // 暂停 / 条件不满足时**不自动重排**——等外部（resumeWalk / refreshWalk）
    // 在状态变化时再排，避免暂停期间每几分钟空转一次
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

  /**
   * 挑目标点：**只左右走，纵向完全不动**（用户明确要求「不要斜着移动」）。
   *
   * ⚠️ 别把纵向那一项加回来（哪怕乘以一个小系数）—— 哪怕斜一点点，
   *    观感上就是「飘着走」，和「贴着桌面溜达」是两回事。
   *    `y` 一律沿用当前值，连 clamp 都不做：clamp 也会造成纵向位移。
   */
  const dist = TRIP_MIN + Math.random() * (TRIP_MAX - TRIP_MIN);
  const dir = Math.random() < 0.5 ? -1 : 1; // 左右各半

  const maxX = work.x + work.width - bounds.width - margin;
  const x = Math.round(Math.max(work.x + margin, Math.min(maxX, bounds.x + dir * dist)));

  /**
   * 目标离得够远才值得走。
   *
   * ⚠️ 只左右走了以后，判据自然是横向位移 dx（纵向恒为 0）。
   *    贴着屏幕左/右边缘时目标会被 clamp 回原地，这时取消这一趟是合理的。
   */
  const dx = x - bounds.x;
  if (Math.abs(dx) < 24) { stopTrip(true); return; }
  target = { x, y: bounds.y };

  walkPosition = { x: bounds.x, y: bounds.y };
  // 只左右走 → 朝向恒由横向分量定，不需要「dx 太小就不发 facing」那套兜底。
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
    // ⚠️ 这里只看窗口还在不在、可不可见，**别调 walkAllowed()** —— 它要 loadPetConfig()
    //    （同步读盘 + JSON.parse + 归一化），16ms 一次 = 一趟散步几百次主线程读盘。
    //    配置那几项（enabled / visible / walkEnabled）一改，pet-ipc 都会调 refreshWalk()
    //    把这趟停掉，用不着在这里每帧重查。
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
    // 走 movePetWindow（setContentBounds 带尺寸）而不是 setPosition：
    // 散步也是连续移动，系统同样会在每步后重算内容区尺寸 —— 不带尺寸挪，
    // 「散步时越来越大」就会悄悄回来；带上尺寸它连漂的机会都没有。
    movePetWindow(walkPosition.x, walkPosition.y);
  }, STEP_MS);
}

/**
 * 结束当前这趟（或取消还没开始的这趟）。
 * notify=true 时告诉渲染层「停下了」（猫从步态回站立）。
 */
function stopTrip(notify) {
  clearInterval(walkTimer);
  walkTimer = null;
  target = null;
  walkPosition = null;
  // 一趟走完纠一次尺寸：透明窗口被连续 setPosition 之后，某些平台上系统会把
  // 内容区尺寸算歪一点，几次下来就是用户说的「散步的时候越来越大」。
  // moved 事件按理也会触发纠正，但那个事件不保证每次都送，这里兜一道。
  ensureSize();
  if (notify) sendToPet('pet:walk', { walking: false });
  if (!planTimer && !paused && walkAllowed()) scheduleNextTrip();
}

// ---------------------------------------------------------------------------
//  对外
// ---------------------------------------------------------------------------

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
