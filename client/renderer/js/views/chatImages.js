'use strict';

// views/chatImages.js —— 给 AI 回复配图（生图）+ 气泡里的图
// 出图用生图的独立配置（服务商 + 模型），和聊天模型无关
// rerender / openSettings 由入口层注入（视图不向上 import 入口）

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { now, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { h } from '../ui/build.js';
import { openLightbox } from '../ui/lightbox.js';
import { persistConversations } from '../data/persist.js';
import { cleanAssistantText, convoFieldDisplayNames, panelGroupNames } from '../data/panel.js';
import { messageImages, characterContextForConvo } from '../data/messages.js';
import { providerById, isBridgeProvider } from '../data/providers.js';

// 视觉模型内部也就缩到这个量级，传原图只是白烧 token
const CHAT_IMAGE_MAX_EDGE = 1024;
const CHAT_IMAGE_MAX_CHARS = 1600000;
let actions = { rerender: () => {}, openSettings: () => {} };

// 只缩不裁（裁了内容就变了）
function shrinkChatImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      try {
        const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        // ⚠️ 判断必须认 `data:image/webp` —— 只看 `data:image/` 时 PNG 也匹配，fallback 永不触发
        let out = canvas.toDataURL('image/webp', 0.82);
        if (!out.startsWith('data:image/webp')) {
          out = canvas.toDataURL('image/jpeg', 0.85);
        }
        if (out.length > CHAT_IMAGE_MAX_CHARS && out.startsWith('data:image/webp')) {
          out = canvas.toDataURL('image/webp', 0.6);
        }
        resolve(out.startsWith('data:image/') ? out : dataUrl);
      } catch (err) {
        resolve(dataUrl);
      }
    };

    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function buildMessageImages(message) {
  const images = messageImages(message);
  if (!images.length) return null;

  const wrap = h('div', { class: 'bubble-images' });
  for (const src of images) {
    wrap.appendChild(
      h('img', {
        class: 'bubble-image',
        src,
        alt: '图片',
        title: '点开看大图',
        onclick: () => openLightbox(src)
      })
    );
  }
  return wrap;
}

// ⚠️ 生成图（PNG 通常一两 MB）不压缩直接存会把 conversations.json 撑爆
export async function attachGeneratedImage(message, dataUrl, model) {
  if (!dataUrl) return;
  const shrunk = await shrinkChatImage(dataUrl);
  if (!Array.isArray(message.images)) message.images = [];
  message.images.push(shrunk);
  if (model) message.imageModel = model;
}

// 提示词取这条回复的正文（剥掉状态栏那几行）
export async function illustrateMessage(index) {
  const convo = activeConvo();
  if (!convo) return;
  if (state.streaming) {
    showToast('正在生成，等它写完再配图');
    return;
  }

  const message = Array.isArray(convo.messages) ? convo.messages[index] : null;
  if (!message || message.role !== 'assistant') return;

  const settings = state.settings || {};

  const panelFields = convoFieldDisplayNames(convo);
  const raw = cleanAssistantText(String(message.content || ''), panelFields, [...panelGroupNames(convo)]);
  // 剥掉 markdown 标记，让提示词更像一句画面描述
  const prompt = raw
    .replace(/\*\*|==|~~|[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);

  if (!prompt) {
    showToast('这条回复没有可用来配图的文字', 'error');
    return;
  }

  const node = el.messages.querySelector(`.msg[data-index="${index}"]`);
  if (node) node.classList.add('illustrating');

  showToast('正在画…（可能要等十几秒）');

  try {
    let dataUrl = null;
    let model = '';

    // 本地桥接走 /draw（本地 ComfyUI），其余走云生图
    const imageProvider = providerById(settings.imageProviderId);
    const useLocalDraw = isBridgeProvider(imageProvider);

    if (useLocalDraw) {
      // 本地 ComfyUI 出图要几分钟，加一个进度条
      const progressEl = document.createElement('div');
      progressEl.style.cssText = 'margin-top:8px;font-size:12px;color:#9ca3af;';
      progressEl.textContent = '正在画… 准备中';
      if (node) node.appendChild(progressEl);

      const progressTimer = setInterval(async () => {
        try {
          const p = await api.drawBridgeProgress({ providerId: settings.imageProviderId });
          if (p && p.ok === true && p.status === 'running' && Number(p.max) > 0) {
            const value = Number(p.value || 0);
            const max = Number(p.max || 1);
            const pct = Math.round((value / max) * 100);
            progressEl.textContent = `正在画… ${pct}%（第 ${value}/${max} 步）`;
          }
        } catch (e) { /* 静默：进度查询失败不影响出图 */ }
      }, 1500);

      try {
        const result = await api.drawBridgeImage({
          text: prompt,
          characterContext: characterContextForConvo(convo),
          providerId: settings.imageProviderId
        });
        if (!result || result.ok !== true) {
          throw new Error((result && result.error) || '配图失败');
        }
        if (!result.dataUrl) {
          throw new Error((result && result.drawReason) || '没有生成出图片');
        }
        dataUrl = result.dataUrl;
      } finally {
        clearInterval(progressTimer);
        if (progressEl && progressEl.parentNode) progressEl.remove();
      }
    } else {
      if (!settings.imageProviderId) {
        showToast('还没有配置生图，请到「设置 → 生图」里选一个提供商', 'error');
        actions.openSettings();
        return;
      }
      const result = await api.generateImage({
        providerId: settings.imageProviderId,
        model: settings.imageModel,
        size: settings.imageSize,
        prompt
      });
      if (!result || result.ok !== true) {
        throw new Error((result && result.error) || '生图失败');
      }
      dataUrl = result.dataUrl;
      model = result.model || settings.imageModel;
    }

    await attachGeneratedImage(message, dataUrl, model);

    convo.updatedAt = now();
    persistConversations(0);
    actions.rerender({ forceScroll: false });
    showToast('画好了', 'ok');
  } catch (err) {
    showToast((err && err.message) || '生图失败', 'error');
  } finally {
    if (node) node.classList.remove('illustrating');
  }
}

export function initChatImages(injected) {
  actions = { rerender: () => {}, openSettings: () => {}, ...(injected || {}) };
}
