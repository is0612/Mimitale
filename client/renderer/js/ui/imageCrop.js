'use strict';

// ui/imageCrop.js —— 选好图之后、存下来之前，框一下要哪一块
// 视口用 canvas 直接绘制：屏幕上看到的和输出的像素是同一套坐标
// 返回 Promise<string|null>：确定得 dataURL，取消（按钮 / Esc / 点空白）得 null

import { h } from './build.js';
import { mButton } from '../components/index.js';
import { api } from '../core/api.js';
import { showToast } from './toast.js';

// 视口宽度上限（还会按窗口高度再收一档）
const VIEW_MAX_W = 340;
// 最多放大到「刚好铺满视口」的几倍
const ZOOM_RANGE = 4;

/** ⚠️ 宽高比一律拆成整数对：浮点做除法取整会带歪比例（340/0.75=453.33→453，453/340≠4/3，输出成 1024×1364） */
function ratio(aspect) {
  const a = Number(aspect);
  if (!Number.isFinite(a) || a <= 0) return [1, 1];
  // 常见比例直接给整数，省得靠浮点反推
  for (let h = 1; h <= 16; h += 1) {
    const w = a * h;
    if (Math.abs(w - Math.round(w)) < 1e-9) return [Math.round(w), h];
  }
  // 兜底：放大 1000 倍再取整
  return [Math.round(a * 1000), 1000];
}

/**
 * 不弹界面直接按比例裁好、缩到 outWidth 转 dataURL（批量导入表情图用）。⚠️ 从顶部对齐：立绘头顶对齐，从上往下裁才不切脸（解不开时 reject）。
 */
export function cropTopToDataUrl(dataUrl, options) {
  const opts = options || {};
  const outWidth = Math.max(16, Math.round(Number(opts.outWidth) || 512));
  const [rw, rh] = ratio(Number(opts.aspect) || 1);
  const target = rw / rh;

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const srcW = Math.max(1, image.naturalWidth);
      const srcH = Math.max(1, image.naturalHeight);

      // 原图里取比例正确的最大矩形：先按宽度铺满，太高就反过来按高度定
      let cw = srcW;
      let ch = Math.round(cw / target);
      if (ch > srcH) {
        ch = srcH;
        cw = Math.round(ch * target);
      }
      const ox = Math.round((srcW - cw) / 2);
      const oy = 0; // 顶部对齐，脸留在框里

      // ⚠️ 输出高度从宽度按整数比算，不借道裁剪框的取整结果（比例会歪）
      const w = Math.max(1, Math.min(outWidth, cw));
      const h = Math.max(1, Math.round((w * rh) / rw));

      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, ox, oy, cw, ch, 0, 0, w, h);

      let url = out.toDataURL('image/webp', 0.85);
      if (url.startsWith('data:image/')) return resolve(url);

      // 浏览器不支持编码 webp 时会回一张 PNG，那就用它
      url = out.toDataURL('image/png');
      resolve(url.startsWith('data:image/') ? url : dataUrl);
    };
    image.onerror = () => reject(new Error('这张图解不开'));
    image.src = dataUrl;
  });
}

/** 打开裁剪浮层。@returns {Promise<string|null>} 裁剪后的 dataURL，取消为 null */
export function openImageCrop({ dataUrl, aspect = 1, outWidth = 512, title = '裁剪图片', hint = '' }) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => build(img);
    img.src = dataUrl;

    function build(image) {
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      // ⚠️ 比例一律按整数算（2:3 → [2,3]）：视口比例一歪，输出尺寸跟着歪（1024×1536 会变成 1024×1364）
      const [rw, rh] = ratio(aspect);

      // 按窗口高度再收一档 —— 太高的竖图不能顶到屏幕外
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.52, 460));
      let vw = Math.round(Math.min(VIEW_MAX_W, Math.max(180, window.innerWidth - 120)));
      let vh = Math.round((vw * rh) / rw);
      if (vh > maxH) {
        vh = Math.round(maxH);
        vw = Math.round((vh * rw) / rh);
      }

      // scale = 原图 1px 在视口里占几 px；minScale 是「刚够铺满视口」，再低就露白
      const minScale = Math.max(vw / image.width, vh / image.height);
      // 上限：取景框最小到原图 1px（再小是凭空放大），且不超过目标输出的像素数
      const fitForOutput = vw / outWidth;
      const maxScale = Math.max(minScale, Math.min(1, fitForOutput) * ZOOM_RANGE);

      let scale = minScale;

      let ox = (vw - image.width * scale) / 2;
      let oy = (vh - image.height * scale) / 2;

      const canvas = h('canvas', { class: 'crop-canvas' });
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;

      const ctx = canvas.getContext('2d');

      // 图片永远铺满视口（不留空白边）：位移夹在「图片边缘贴着视口边缘」之间
      function clamp() {
        const w = image.width * scale;
        const hh = image.height * scale;
        ox = Math.min(0, Math.max(vw - w, ox));
        oy = Math.min(0, Math.max(vh - hh, oy));
      }

      function draw() {
        clamp();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, vw, vh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, ox, oy, image.width * scale, image.height * scale);
      }

      /** 以视口内某点为锚缩放：那个点下面的画面保持不动 */
      function zoomTo(next, anchorX, anchorY) {
        const from = scale;
        const to = Math.min(maxScale, Math.max(minScale, next));
        if (Math.abs(to - from) < 1e-6) return;
        ox = anchorX - (anchorX - ox) * (to / from);
        oy = anchorY - (anchorY - oy) * (to / from);
        scale = to;
        draw();
        syncZoomInput();
      }

      // --- 视口：拖拽平移 + 滚轮缩放 ---
      const view = h('div', { class: 'crop-view', id: 'crop-view' }, canvas);

      let drag = null;
      view.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        drag = { x: event.clientX, y: event.clientY, ox, oy, id: event.pointerId };
        view.classList.add('dragging');
        if (view.setPointerCapture) view.setPointerCapture(event.pointerId);
      });
      view.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        ox = drag.ox + (event.clientX - drag.x);
        oy = drag.oy + (event.clientY - drag.y);
        draw();
      });
      const endDrag = (event) => {
        if (!drag || (event && event.pointerId !== drag.id)) return;
        drag = null;
        view.classList.remove('dragging');
      };
      view.addEventListener('pointerup', endDrag);
      view.addEventListener('pointercancel', endDrag);

      view.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          const rect = view.getBoundingClientRect();
          zoomTo(scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX - rect.left, event.clientY - rect.top);
        },
        { passive: false }
      );

      // --- 缩放滑块：和滚轮共用 zoomTo，两者永远一致 ---
      const zoomInput = h('input', {
        id: 'crop-zoom',
        class: 'crop-zoom',
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        'aria-label': '缩放'
      });

      function syncZoomInput() {
        const range = maxScale - minScale;
        const value = range > 0
          ? Math.round(((scale - minScale) / range) * 100)
          : 100;
        if (Number(zoomInput.value) !== value) zoomInput.value = String(value);
      }

      zoomInput.addEventListener('input', () => {
        const range = maxScale - minScale;
        const next = range > 0
          ? minScale + range * (Number(zoomInput.value) / 100)
          : minScale;
        zoomTo(next, vw / 2, vh / 2);
      });

      // --- 输出：按视口这块直接缩放画到目标尺寸 ---
      function output() {
        // 视口框住的这块在原图上有多少像素；目标尺寸比它大就按原样输出（放大补不出细节）
        const srcWidth = Math.max(1, Math.round(vw / scale));
        const srcHeight = Math.max(1, Math.round(vh / scale));
        let w = Math.max(1, Math.min(outWidth, srcWidth));
        // ⚠️ 高度直接从 w 按整数比算：借道 vw/vh 的取整结果比例会歪（算出来 1365 而不是 1536）
        let h = Math.max(1, Math.round((w * rh) / rw));
        // ⚠️ h 可能比原图那块高 1px：收高度再按比例回算宽度 —— 不放大是硬约束，宁可改宽不改比
        if (h > srcHeight) {
          h = srcHeight;
          w = Math.max(1, Math.min(outWidth, Math.round((h * rw) / rh)));
        }

        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;

        // ⚠️ 取两个方向里较大的比例：上面「h 超了收窄 w」会把 k 带小，落笔够不到画布底、底边留缝
        const k = Math.max(w / vw, h / vh);
        const octx = out.getContext('2d');
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(image, ox * k, oy * k, image.width * scale * k, image.height * scale * k);

        // webp 只有 PNG 的 1/3 体积，而这个文件每存一次角色就要整个重写一遍
        let url = out.toDataURL('image/webp', 1);
        if (url.startsWith('data:image/')) return url;

        // 浏览器不支持编码 webp 时回的是 PNG，直接用它（少重编码一次，不掉细节）
        url = out.toDataURL('image/png');
        return url.startsWith('data:image/') ? url : dataUrl;
      }

      // --- 组装浮层 ---
      const head = h(
        'div',
        { class: 'crop-head' },
        h('div', { class: 'crop-heading' },
          h('span', { class: 'crop-title', text: title }),
          hint ? h('span', { class: 'crop-hint', text: hint }) : null
        )
      );

      const zoomRow = h(
        'div',
        { class: 'crop-zoom-row' },
        h('span', { class: 'crop-zoom-label', text: '小' }),
        zoomInput,
        h('span', { class: 'crop-zoom-label', text: '大' })
      );

      const btnCancel = mButton({ id: 'crop-cancel', variant: 'ghost', size: 'sm', text: '取消' });
      const btnOk = mButton({ id: 'crop-ok', variant: 'primary', size: 'sm', text: '用这块' });

      const foot = h(
        'div',
        { class: 'crop-foot' },
        h('span', { class: 'field-help', text: '拖动画面移动，滚轮或滑块缩放。' }),
        h('span', { class: 'crop-foot-btns' }, btnCancel, btnOk)
      );

      const overlay = h(
        'div',
        { class: 'crop-layer', id: 'crop-layer' },
        h('div', { class: 'crop-card', role: 'dialog', 'aria-modal': 'true' }, head, view, zoomRow, foot)
      );

      function shut(result) {
        document.removeEventListener('keydown', keyHandler, true);
        overlay.remove();
        resolve(result);
      }

      // ⚠️ Esc 用捕获阶段拦下：底下的角色编辑器也在听 Esc（冒泡阶段），不拦会连它一起关掉
      const keyHandler = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        shut(null);
      };

      btnCancel.addEventListener('click', () => shut(null));
      btnOk.addEventListener('click', () => shut(output()));
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) shut(null);
      });
      document.addEventListener('keydown', keyHandler, true);

      document.body.appendChild(overlay);
      draw();
      syncZoomInput();
      view.focus?.();
    }
  });
}

/** 选一张本地图 → 裁剪 → dataURL；取消或出错（已弹过 toast）返回 null */
export async function pickAndCrop({ aspect, outWidth, title, hint, pickTitle }) {
  let result;
  try {
    result = await api.pickImage({ title: pickTitle });
  } catch (err) {
    showToast((err && err.message) || '选择图片失败', 'error');
    return null;
  }
  if (!result || result.canceled) return null;
  if (!result.dataUrl) {
    showToast(result.error || '这张图片用不了', 'error');
    return null;
  }
  return openImageCrop({ dataUrl: result.dataUrl, aspect, outWidth, title, hint });
}
