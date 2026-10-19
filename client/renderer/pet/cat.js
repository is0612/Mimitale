'use strict';

// rig 形象驱动层（迷你 kit）：步态生成、状态机、事件翻译、视线跟踪。
// 吃 cat-figure.js 的身体参数口径，不碰 IPC —— 事件由 pet.js 转发进来。

import { createCatFigure } from './cat-figure.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;

// ⚠️ 腿长 29 是 figure 里 lift 公式的基准，别单独改
const LEG_LEN = 29;
const WALK_CAD = 2.0;        // 步频（Hz）
const WALK_SWING = 26;       // 腿摆幅度（度）
const WALK_LIFT = 6;         // 抬脚高度（rig 单位）
const SLEEP_AFTER_MS = 90000; // 闲置多久睡着
const IDLE_TRICK_MS = [14000, 34000]; // 偶发小手势的间隔区间

// 手势时长（秒）。
// ⚠️ 删手势时同步删这里（`|| 1` 是兜底，漏删只会默默变成 1 秒）；shake 的时长要和 cat-figure 的 sin(gk*π*4) 对上。
const GESTURE_DUR = { nod: .9, shake: .8, wave: 1.4 };

// 空闲小手势的全集（用户可在设置里关掉其中几个）；挑选走 enabledGestures，别直接读这里。
const IDLE_GESTURES = ['nod', 'shake', 'wave'];

/**
 * 当前允许的空闲手势 = IDLE_GESTURES ∩ 用户勾选的。
 * ⚠️ 空数组合法：全取消就根本不挑，别写兜底把 IDLE_GESTURES 塞回去。 */
let enabledGestures = [...IDLE_GESTURES];

// ── 状态 ──

let figure = null;
let texMap = null;
let modelKey = '';          // 当前已加载的 rig 数据指纹（避免重复重建）
let container = null;

// 每帧身体参数的「外部输入」
let mode = 'idle';          // idle | walk | sleep | drag
let face = 'neutral';
let facing = 1;
let gesture = null;         // { kind, k }（k: 0→1 播放进度）
let walking = false;        // 散步开关（主进程 pet:walk）
let mouse = { x: 0, y: 0, at: 0 };
let look = [0, 0];
let legPhase = 0;           // 步态相位（累计弧度）
let lastInteraction = Date.now();
let lastTrickAt = Date.now();
let modeStart = performance.now();
let busy = false;

let rafId = 0;
let lastFrameT = null;

// ── 资源 ──

function loadImage(src) {
  return new Promise((ok, bad) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => bad(new Error(`贴图解码失败: ${src.slice(0, 48)}…`));
    im.src = src;
  });
}

let applySeq = 0;
/** 喂主进程推来的 rig 数据（{ key, model, tex }）：key 不变就跳过，GL 上下文重建有代价。 */
async function applyState(rigData) {
  if (!rigData || !rigData.model || !rigData.tex) return;
  if (rigData.key && rigData.key === modelKey && figure) {
    ++applySeq; // 返回已加载形象时也取消此前尚未完成的换肤。
    return;
  }
  const seq = ++applySeq;
  const nextKey = rigData.key || String(Date.now());

  const entries = Object.entries(rigData.tex);
  let images;
  try {
    images = await Promise.all(entries.map(([, url]) => loadImage(url)));
  } catch (err) {
    // 贴图解码失败；但若这次已被更新的一次换肤顶掉，就不能抛 —— 调用方会 dispose 掉刚挂上的新形象。
    if (seq !== applySeq) return;
    throw err;
  }
  if (seq !== applySeq) return; // 贴图解码期间又来了新数据：本次作废
  texMap = Object.fromEntries(entries.map(([name], i) => [name, images[i]]));

  figure?.dispose();
  figure = createCatFigure({ model: rigData.model, texMap });
  modelKey = nextKey;
  if (container) figure.mount(container);
  figure.setFacing(facing);
  lastFrameT = null;
  startLoop();
}

// ── 帧循环 ──

function startLoop() {
  if (rafId) return;
  const step = (now) => {
    rafId = requestAnimationFrame(step);
    if (!figure) return;
    const t = now / 1000;
    const dt = lastFrameT == null ? 1 / 60 : clamp((now - lastFrameT) / 1000, 0, 0.05);
    lastFrameT = now;

    /* --- 模式选择（外部输入 → mode） --- */
    const held = dragHeld;
    if (held) mode = 'drag';
    else if (walking) mode = 'walk';
    else if (Date.now() - lastInteraction > SLEEP_AFTER_MS) mode = 'sleep';
    else mode = 'idle';
    if (mode !== prevMode) { modeStart = now; prevMode = mode; }
    if (mode === 'sleep' && face !== 'sleep') face = 'sleep';
    if (mode !== 'sleep' && face === 'sleep') face = 'neutral';

    /* --- 步态相位 --- */
    if (mode === 'walk') legPhase += Math.PI * 2 * WALK_CAD * dt;

    /* --- 手势播放 --- */
    if (gesture) {
      gesture.k += dt / (GESTURE_DUR[gesture.kind] || 1);
      if (gesture.k >= 1) gesture = null;
    }

    /* --- 偶发小手势（醒着、没人理的时候） --- */
    if (mode === 'idle' && !gesture && !busy) {
      const since = Date.now() - lastTrickAt;
      const due = lerp(IDLE_TRICK_MS[0], IDLE_TRICK_MS[1], Math.random());
      if (since > due) {
        lastTrickAt = Date.now();
        // ⚠️ enabledGestures 为空就什么都不做，别写 `[...][0]` 之类兜底，否则用户全取消也照样动。
        if (enabledGestures.length) {
          gesture = {
            kind: enabledGestures[Math.floor(Math.random() * enabledGestures.length)],
            k: 0,
          };
        }
      }
    }

    /* --- 视线：跟鼠标；没人动 / 睡着时回中。鼠标移动不算互动，否则猫永远睡不着。 --- */
    const mouseFresh = mode !== 'sleep' && Date.now() - mouse.at < 5000;
    const target = mouseFresh ? [mouse.x, mouse.y] : [0, 0];
    look[0] = lerp(look[0], clamp(target[0], -5, 5), 1 - Math.exp(-6 * dt));
    look[1] = lerp(look[1], clamp(target[1], -5, 5), 1 - Math.exp(-6 * dt));

    /* --- 组装身体参数（kit 口径） --- */
    const o = {
      t,
      mode,
      face,
      facing,
      look,
      swing: 0,
      sit: 0,
      low: 0,
      legs: [[0, 0, 0, 0], [0, 0, 0, 0]],
      gesture,
      modeT: (now - modeStart) / 1000,
    };

    if (mode === 'walk') {
      const hipB = modelPivot('legBack'), hipF = modelPivot('legFront');
      for (let i = 0; i < 2; i++) {
        const ph = legPhase + i * Math.PI;
        const a = WALK_SWING * Math.sin(ph) * Math.PI / 180;
        const lift = Math.max(0, Math.sin(ph + Math.PI / 2)) * WALK_LIFT;
        const hip = i === 0 ? hipB : hipF;
        // 脚 = 髋 + 摆动向量；figure 从线段自己算角度和抬脚
        o.legs[i] = [hip[0], hip[1], hip[0] + LEG_LEN * Math.sin(a), hip[1] + LEG_LEN * Math.cos(a) - lift * 0.4];
      }
      o.swing = 3 * Math.sin(legPhase);           // 身体跟着步子轻微横摆
      o.low = 1.2 * Math.abs(Math.sin(legPhase)); // 髋部颠簸
    } else {
      // 站着 / 睡着：双腿直立（脚在髋正下方）
      const hipB = modelPivot('legBack'), hipF = modelPivot('legFront');
      o.legs[0] = [hipB[0], hipB[1], hipB[0] + 1, hipB[1] + LEG_LEN];
      o.legs[1] = [hipF[0], hipF[1], hipF[0] - 1, hipF[1] + LEG_LEN];
    }

    /* --- 特效开关（fx 层）：思考泡只在「想」的阶段，开口说了就收掉 --- */
    const fc = {};
    if (busy && face === 'thinking') fc.think = true;

    figure.draw(fc, o);

    // ⚠️ 等这一帧画完再回调：fitCanvas 改像素尺寸会清空缓冲，当帧读像素只能拿到全透明掩码。
    if (afterDrawOnce) {
      const run = afterDrawOnce;
      afterDrawOnce = null;
      run();
    }
  };
  rafId = requestAnimationFrame(step);
}

let prevMode = 'idle';
let dragHeld = false;

/** 下一帧 draw 完成后执行一次的回调（目前只有 pet.js 的掩码重建用）。 */
let afterDrawOnce = null;

function modelPivot(name) {
  const pv = figure && figure.model && figure.model.pivots;
  return (pv && pv[name]) || [0, 0];
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

// ── 事件翻译（pet.js 转发） ──

/** 生成中（pet:busy）→ 想事情 */
function setBusy(b) {
  busy = b === true;
  if (busy) { wake('thinking'); }
  else if (face === 'thinking') face = 'neutral';
  lastInteraction = Date.now();
}

/** 话说出来了（pet:say）→ 开心一小会儿 */
function said() {
  wake('happy');
  // ⚠️ happy 的尾巴摇幅是满值（MOOD.happy = [.8, 1]），这个时长决定说完话后尾巴还摇多久。
  setTimeout(() => { if (face === 'happy') face = 'neutral'; }, 2200);
}

/** 流式增量（pet:chunk）：第一个字冒出 = 从「想事情」转「开口说」。
 *  ⚠️ chunk 每个 token 来一次，必须节流，否则手势被反复重播成抽搐。 */
let lastChunkNodAt = 0;
function chunk() {
  if (!busy) return;
  if (face !== 'happy') wake('happy'); // 从 thinking 切到说话
  const now = performance.now();
  if (gesture || now - lastChunkNodAt < 2600) return;
  lastChunkNodAt = now;
  gesture = { kind: 'nod', k: 0 };
}

/** 被点了一下（poke 应答之后） */
function poked() {
  wake(Math.random() < 0.5 ? 'surprised' : 'shy');
  // ⚠️ 这里不看 enabledGestures：点它是交互反馈，不是「自己待着时的小动作」。
  gesture = { kind: Math.random() < 0.5 ? 'nod' : 'shake', k: 0 };
  // ⚠️ 这里的时长只影响表情维持，别拿来调尾巴（尾巴看 cat-figure.js 的 wagAmp）。
  setTimeout(() => { if (face === 'surprised' || face === 'shy') face = 'neutral'; }, 1800);
}

/** 接收「允许哪些空闲手势」；只在 IDLE_GESTURES 范围内收，混进未知名字会挑到静止手势。 */
function setGestures(list) {
  if (!Array.isArray(list)) return; // 字段缺失：保持当前值，别把它清空
  enabledGestures = IDLE_GESTURES.filter((k) => list.includes(k));
}

/** 被拎起来了 / 放下 */
function dragBegin() { dragHeld = true; wake('dragged'); }
function dragEnd() { dragHeld = false; if (face === 'dragged') face = 'neutral'; lastInteraction = Date.now(); }

/** 散步事件（主进程 pet:walk { walking, facing }） */
function walkEvent(payload) {
  const p = payload || {};
  if (typeof p.walking === 'boolean') walking = p.walking;
  if (p.facing === 1 || p.facing === -1) {
    facing = p.facing;
    figure?.setFacing(facing);
  }
  if (walking) lastInteraction = Date.now();
}

/** 鼠标移动（穿透过来的）：只更新视线原料，不算「互动」（划过不该惊醒午睡）。 */
function mouseMove(x, y) {
  mouse = { x, y, at: Date.now() };
}

function wake(nextFace) {
  lastInteraction = Date.now();
  lastTrickAt = Date.now();
  if (nextFace) face = nextFace;
  if (mode === 'sleep') legPhase = 0;
}

// ── 对外（pet.js 用） ──

export const catRig = {
  get active() { return !!figure; },
  get canvas() { return figure && figure.canvas; },
  get mirrored() { return facing < 0; },
  get mode() { return mode; },

  mount(el) {
    container = el;
    if (figure) figure.mount(el);
  },

  applyState,

  /**
   * 窗口尺寸变了：立刻重建位图。⚠️ 传了 onDrawn 就挂到「下一帧画完之后」——
   * 改 canvas 像素尺寸会清空缓冲，当帧读像素只有全透明掩码，宠物会点不动。 */
  refit(onDrawn) {
    if (!figure) {
      // 没有形象时掩码本来就该是空的，直接回调让调用方收尾
      if (onDrawn) onDrawn();
      return;
    }
    figure.refit();
    if (onDrawn) afterDrawOnce = onDrawn;
  },

  setBusy, said, chunk, poked,
  setGestures,
  dragBegin, dragEnd,
  walk: walkEvent,
  mouseMove,

  dispose() {
    stopLoop();
    // 让还在解码贴图的 applyState 作废，否则它回来会在「销毁」之后又挂出一只猫。
    applySeq += 1;
    figure?.dispose();
    figure = null; texMap = null; modelKey = '';
    mode = 'idle'; face = 'neutral'; walking = false; dragHeld = false;
    gesture = null; legPhase = 0; prevMode = 'idle';
    // 形象拆了，挂着的「下一帧重建掩码」也不能再跑（回调属于上一只形象的尺寸）
    afterDrawOnce = null;
  },
};
