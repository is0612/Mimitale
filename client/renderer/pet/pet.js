'use strict';

// 宠物窗口渲染层，只管「演」：显示形象、气泡逐句冒字、拖动、右键菜单；判断全在主进程。
// ⚠️ 鼠标穿透必须按图片 alpha 逐像素判，不能按窗口矩形判，否则宠物周围的透明区是死区。

const spriteWrap = document.getElementById('sprite-wrap');
const spriteEmpty = document.getElementById('sprite-empty');
const bubble = document.getElementById('bubble');
const bubbleLines = document.getElementById('bubble-lines');

// rig 动态形象：部件贴图渲染，引擎在 cat.js / cat-figure.js
import { catRig } from './cat.js';

// 低于 16 视为透明：图片边缘半透明的抗锯齿像素不该咬住鼠标。
const ALPHA_THRESHOLD = 16;

// ── 状态 ──

/** 缓存，否则每次 mousemove 都会跨进程发一遍 */
let clickThroughApplied = null;

/** 形象的不透明掩码：{ w, h, alpha }；读不到像素时为 null */
let mask = null;

/** 宠物头顶在 sprite-wrap 坐标系里的 y（px），由掩码扫出，用于贴气泡；读不到为 null */
let spriteTopInWrap = null;

/** 气泡收起 / 逐句冒字定时器 */
let bubbleTimer = null;
let lineTimer = null;

let streaming = false;
let streamBuffer = '';

// ── 和主进程的来往 ──

function applyState(payload) {
  if (!payload) return;

  const pet = payload.pet || {};
  const scale = Math.max(0.4, Math.min(2, Number(pet.scale) || 1));
  document.documentElement.style.setProperty('--scale', String(scale));

  // ⚠️ 必须放在下面几个提前 return 之前：rig 缺失时也要把用户的动作开关传下去。
  catRig.setGestures(pet.gestureEnabled);

  // 模型和贴图由主进程转成 dataUrl 推来（CSP 拦 fetch）；资产缺失时 rig 为 null → 露出占位。
  const rigData = pet.rig || null;
  if (!rigData || !rigData.model) {
    catRig.dispose();
    spriteEmpty.hidden = false;
    mask = null;
    return;
  }

  spriteEmpty.hidden = true;
  catRig.mount(spriteWrap);
  catRig.applyState(rigData)
    .then(() => {
      // 贴图解码 + 首帧渲染之后才有像素可读，延迟重建掩码
      setTimeout(() => requestAnimationFrame(rebuildMask), 150);
    })
    .catch((err) => {
      // 初始化失败：露出占位框，别让窗口空着
      console.warn('[pet] 动态形象初始化失败:', err && err.message);
      catRig.dispose();
      spriteEmpty.hidden = false;
      mask = null;
    });
  mask = null;
}

async function pullState() {
  try {
    applyState(await window.petBridge.getState());
  } catch (err) {
    console.warn('[pet] 取状态失败', err);
  }
}

// ── 不透明掩码 ──

/** 掩码的像素源：rig 的 canvas（preserveDrawingBuffer 开着，能读像素） */
function maskSource() {
  return catRig.active ? catRig.canvas || null : null;
}

/**
 * 把形象按显示尺寸画进离屏 canvas，取 alpha 存成掩码。
 * ⚠️ 必须在 fitCanvas 改过 canvas 像素尺寸的下一帧之后调用：当帧读到的是全透明。 */
function rebuildMask() {
  const previous = mask;
  spriteTopInWrap = null;
  const src = maskSource();
  if (!src) { mask = null; return; }

  const rect = src.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (w <= 0 || h <= 0) { mask = null; return; }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;

    const alpha = new Uint8Array(w * h);
    let solid = 0;
    for (let i = 0; i < w * h; i += 1) {
      const a = pixels[i * 4 + 3];
      alpha[i] = a;
      if (a >= ALPHA_THRESHOLD) solid += 1;
    }

    // 整张画布全透明 = 像素还没画上去（缓冲刚被清空）。别拿它当掩码，否则命中全落空；
    // 这里兜底保留上一份可用掩码。
    if (!solid && previous) {
      mask = previous;
      syncBubbleAnchor();
      return;
    }

    mask = { w, h, alpha };

    // ⚠️ 头顶不能只判 alpha > 0：半透明发梢会零星落在很上面，要求一行至少 2% 宽度的实心像素。
    const need = Math.max(2, Math.round(w * 0.02));
    for (let y = 0; y < h; y += 1) {
      let n = 0;
      const base = y * w;
      for (let x = 0; x < w; x += 1) {
        if (alpha[base + x] > 128) {
          n += 1;
          if (n >= need) break;
        }
      }
      if (n >= need) {
        spriteTopInWrap = rect.top - spriteWrap.getBoundingClientRect().top + y;
        break;
      }
    }
  } catch (err) {
    console.warn('[pet] 算不出不透明掩码，退化成整块矩形:', err && err.message);
    mask = null;
    spriteTopInWrap = null;
  }
  syncBubbleAnchor();
}

/**
 * 把气泡下沿锚到宠物头顶上方：窗口 300×380 直接钉在顶部会留出随气泡高度变化的空隙。
 * 拿不到头顶就退回 CSS 默认位置。 */
function syncBubbleAnchor() {
  const wrap = spriteWrap.getBoundingClientRect();
  if (!wrap.height) return;
  if (spriteTopInWrap == null) {
    bubble.style.removeProperty('--bubble-bottom');
    return;
  }

  // ⚠️ 气泡框的下沿不是视觉下沿：尾巴和装饰点挂在框外，要补上这段外挂高度，否则会压在宠物头上。
  const tailDrop = overhangBelowBubble();
  const gap = 8;
  let fromBottom = wrap.height - (spriteTopInWrap - gap - tailDrop);

  // ⚠️ 顶部预留量必须按气泡自身高度算，不能写死：0.7× 时窗口只有 266px、气泡约 98px。
  const reserve = bubble.offsetHeight + tailDrop + 6;
  const maxFromBottom = Math.max(0, wrap.height - reserve);
  fromBottom = Math.min(fromBottom, maxFromBottom);
  bubble.style.setProperty('--bubble-bottom', `${fromBottom.toFixed(1)}px`);
}

/**
 * 气泡框外往下伸的那一截高度。尾巴是旋转圆角方块，探出量读不出来，
 * 优先用 :root 的 --tail-overhang，缺失时退回从 ::before 量 bottom。 */
function overhangBelowBubble() {
  const rootCs = getComputedStyle(document.documentElement);
  const declared = parseFloat(rootCs.getPropertyValue('--tail-overhang'));
  if (Number.isFinite(declared) && declared > 0) return declared;

  const cs = getComputedStyle(bubble, '::before');
  if (cs && cs.content && cs.content !== 'none') {
    const off = parseFloat(cs.bottom);
    if (Number.isFinite(off) && off < 0) return Math.abs(off);
    const bw = parseFloat(cs.borderTopWidth);
    if (Number.isFinite(bw)) return bw;
  }
  return 0;
}

// 窗口尺寸变化：立刻按新尺寸重建位图，并把掩码重建挂到「下一帧画完」之后。
// ⚠️ 绝不能在改 canvas 像素尺寸的同一帧读像素：缓冲已清空，掩码整张透明 → 看得见但点不动。
/** 拖动期间攒下的「尺寸变了，等松手再重建」标记 */
let refitPending = false;

/** 按当前窗口尺寸重建位图 + 命中掩码（掩码必须等下一帧画完，见 cat.js 的 refit） */
function refitNow() {
  refitPending = false;
  catRig.refit(rebuildMask);
}

window.addEventListener('resize', () => requestAnimationFrame(() => {
  // 拖动中先不重建：一次拖动会触发几十次 resize，每次重建都在清缓冲 → 一直闪；攒到松手补一次。
  if (dragging) { refitPending = true; return; }
  refitNow();
}));
// 气泡一改高就重新对一次头顶（底边锚定）
if (window.ResizeObserver) {
  new ResizeObserver(() => requestAnimationFrame(syncBubbleAnchor)).observe(bubble);
}

// ── 命中判断 + 穿透 ──

/** 点是否落在气泡上（实心矩形，不查掩码） */
function inBubble(x, y) {
  if (bubble.hidden) return false;
  const r = bubble.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** 点是否落在宠物的实体像素上 */
function inSprite(x, y) {
  if (!catRig.active) {
    // rig 起不来时露出的是实心占位框，必须照常接鼠标，否则用户连右键菜单都调不出来。
    if (spriteEmpty.hidden) return false;
    const r = spriteEmpty.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  const src = catRig.canvas;
  if (!src) return false;
  const mirrored = catRig.mirrored;
  const r = src.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
  if (!mask) return true;

  let px = Math.floor(((x - r.left) / r.width) * mask.w);
  // 镜像时 canvas 像素没翻、显示翻了，掩码索引要跟着反，否则命中区左右错位
  if (mirrored) px = mask.w - 1 - px;
  const py = Math.floor(((y - r.top) / r.height) * mask.h);
  if (px < 0 || py < 0 || px >= mask.w || py >= mask.h) return false;
  return mask.alpha[py * mask.w + px] >= ALPHA_THRESHOLD;
}

function setClickThrough(ignore) {
  if (clickThroughApplied === ignore) return;
  clickThroughApplied = ignore;
  try {
    window.petBridge.setClickThrough(ignore);
  } catch (err) {
    /* 主进程还没准备好就忽略这一次 */
  }
}

// ── 气泡 ──

function clearBubbleTimers() {
  clearTimeout(bubbleTimer);
  clearTimeout(lineTimer);
  bubbleTimer = null;
  lineTimer = null;
}

function hideBubble() {
  bubble.hidden = true;
  bubbleLines.replaceChildren();
  spriteWrap.classList.remove('talking');
}

/** 把 `*动作*` 渲染成斜体（用 DOM 拼，绝不走 innerHTML —— 内容是模型给的） */
function renderLine(text) {
  const p = document.createElement('p');
  p.className = 'bubble-line';

  for (const part of String(text || '').split(/(\*[^*\n]{1,40}\*)/g)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      const em = document.createElement('em');
      em.textContent = part.slice(1, -1);
      p.appendChild(em);
    } else {
      p.appendChild(document.createTextNode(part));
    }
  }
  return p;
}

/** 按内容长度决定挂多久：短句 4 秒起，长句多留一会儿，最多 20 秒 */
function hideDelayFor(text) {
  const len = String(text || '').length;
  return Math.min(20000, Math.max(4000, 1800 + len * 130));
}

/** 两句之间的停顿（ms） */
const LINE_GAP_MS = 460;

/**
 * 把气泡滚到「最后一句尽量完整可见」：先滚到底，再在最后一行能整行装下时吸附到行顶。
 * ⚠️ 最后一行高于可视区时不能吸附，否则最新那句话的底部会被切掉。 */
function scrollToLastLine() {
  const view = bubbleLines.clientHeight;
  if (!view) return;

  bubbleLines.scrollTop = bubbleLines.scrollHeight;
  const max = bubbleLines.scrollTop;
  if (max <= 0) return;

  const kids = bubbleLines.children;
  const last = kids[kids.length - 1];
  if (!last) return;

  const lastTop = last.offsetTop;
  const lastBottom = lastTop + last.offsetHeight;
  if (lastBottom <= lastTop + view && lastTop <= max) {
    bubbleLines.scrollTop = lastTop;
  }
}

/** 一句句往外冒；收起时机按最后一句算，每加一句就把定时器往后推 */
function showLines(lines) {
  clearBubbleTimers();
  hideBubble();

  const list = (Array.isArray(lines) ? lines : [lines])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  if (!list.length) return;

  bubble.hidden = false;
  spriteWrap.classList.add('talking');

  let index = 0;
  const next = () => {
    if (index >= list.length) {
      scheduleHide(list.join(''));
      return;
    }
    bubbleLines.appendChild(renderLine(list[index]));
    index += 1;
    scrollToLastLine();
    lineTimer = setTimeout(next, LINE_GAP_MS);
  };
  next();
}

function scheduleHide(text) {
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, hideDelayFor(text));
}

function showOne(text) {
  showLines([text]);
}

// ── 收到主进程推来的消息 ──

window.petBridge.onState((payload) => {
  applyState(payload);
  requestAnimationFrame(rebuildMask);
});

window.petBridge.onWalk?.((payload) => catRig.walk(payload));

/** 本轮是否真收到 pet:say：成功与失败的收尾都是 busy:false，用它区分 */
let saidThisCycle = false;

window.petBridge.onBusy((busy) => {
  catRig.setBusy(busy === true);
  spriteWrap.classList.toggle('busy', busy === true);
  if (busy === true) {
    saidThisCycle = false;
    streaming = true;
    streamBuffer = '';
    clearBubbleTimers();
    bubble.hidden = false;
    bubbleLines.replaceChildren();
    const p = document.createElement('p');
    p.className = 'bubble-line typing';
    p.textContent = '嗯…我想想…';
    bubbleLines.appendChild(p);
  } else {
    streaming = false;
    // ⚠️ 失败时主进程只发 busy:false 不发 pet:say，必须在这里收掉气泡，否则「嗯…我想想…」一直挂着；
    // 成功路径先 say 再 busy:false，用 saidThisCycle 避开。
    if (!saidThisCycle) hideBubble();
  }
});

window.petBridge.onChunk((text) => {
  catRig.chunk();
  if (!streaming) {
    // 没收到 busy 就先来增量时补一个占位节点，否则 firstElementChild 为 null，整段增量都不显示。
    streaming = true;
    streamBuffer = '';
    bubble.hidden = false;
    bubbleLines.replaceChildren();
    const p = document.createElement('p');
    p.className = 'bubble-line typing';
    bubbleLines.appendChild(p);
  }
  streamBuffer += String(text || '');
  const node = bubbleLines.firstElementChild;
  if (node) {
    node.textContent = streamBuffer;
    node.classList.add('typing');
    // ⚠️ 流式故意滚到最底而不是 scrollToLastLine()：正在写的字永远在末尾，切掉末尾等于切掉刚说的话。
    bubbleLines.scrollTop = bubbleLines.scrollHeight;
  }
});

window.petBridge.onSay((payload) => {
  saidThisCycle = true;
  streaming = false;
  catRig.said();
  spriteWrap.classList.remove('busy');
  const lines = payload && Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length) showLines(lines);
  else if (payload && payload.text) showOne(payload.text);
  // 空回复收掉气泡，别留一个空气泡
  else hideBubble();
});

// ── 拖动 / 点一下 / 右键 ──

let dragging = false;

/** 最后一次指针位置：blur 不带坐标，没有它重算不了穿透，窗口会卡在死区 */
let lastPointer = null;

spriteWrap.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  // 只有按在宠物实体像素上才算拖：sprite-wrap 铺满窗口，否则透明区按一下也会拖走。
  if (!inSprite(event.clientX, event.clientY)) return;
  dragging = true;
  catRig.dragBegin();
  spriteWrap.classList.add('dragging');
  window.petBridge.dragStart();
  event.preventDefault();
});

document.addEventListener('mousemove', (event) => {
  lastPointer = { x: event.clientX, y: event.clientY };
  // 视线跟踪原料：相对窗口中心的偏移（cat.js 内部会 clamp / 衰减）
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  catRig.mouseMove((event.clientX - cx) / 40, (event.clientY - cy) / 40);
  // 拖动中一律不穿透：中途一穿透就可能把 mouseup 弄丢
  if (dragging) {
    setClickThrough(false);
    return;
  }
  setClickThrough(!(inBubble(event.clientX, event.clientY) || inSprite(event.clientX, event.clientY)));
});

document.addEventListener('mouseup', async (event) => {
  if (!dragging || event.button !== 0) return;
  dragging = false;
  catRig.dragEnd();
  spriteWrap.classList.remove('dragging');
  // 补上拖动中攒下的重建（拖动里尺寸变过，那时故意没重建）
  if (refitPending) requestAnimationFrame(refitNow);
  // 拖完光标可能停在透明区，主动重算一次
  setClickThrough(!(inBubble(event.clientX, event.clientY) || inSprite(event.clientX, event.clientY)));

  let moved = false;
  try {
    // 「点」和「拖」只能由主进程判：窗口跟着光标跑，这里的 clientX/Y 拖动时几乎不变
    moved = (await window.petBridge.dragEnd()) === true;
  } catch (err) {
    /* 拿不到就当没拖动 */
  }

  if (!moved) {
    // 摸它一下：主进程在本地给一句应声，不调模型、不花钱
    try {
      const res = await window.petBridge.poke();
      if (res && res.text) { catRig.poked(); showOne(res.text); }
    } catch (err) {
      /* 摸不到不该报错 */
    }
  }
});

// 拖出窗口可能收不到 mouseup，失焦即当作拖完。
// ⚠️ 复位拖动必须同时重算穿透（用最后指针位置），否则整块矩形变成点不动的死区。
window.addEventListener('blur', () => {
  if (!dragging) return;
  dragging = false;
  catRig.dragEnd();
  spriteWrap.classList.remove('dragging');
  window.petBridge.dragEnd();
  // 和 mouseup 同口径补上攒下的重建
  if (refitPending) requestAnimationFrame(refitNow);
  const p = lastPointer;
  setClickThrough(!(p && (inBubble(p.x, p.y) || inSprite(p.x, p.y))));
});

// 右键交给主进程弹原生菜单（理由见 preload-pet.js）
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  setClickThrough(false);
  window.petBridge.openMenu();
});

// 滚轮不做任何事：透明窗口上的默认滚轮行为只会让人一脸问号
document.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });

// ── 起步 ──

// 一进来先按全穿透算，等鼠标第一次划过再校正；反过来会让窗口一出现就咬住桌面。
setClickThrough(true);
window.petBridge.ready();
pullState();
