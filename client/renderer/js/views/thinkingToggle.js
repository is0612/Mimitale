'use strict';

// ============================================================================
//  views/thinkingToggle.js —— 输入区那颗「深度思考」（2026-10-28）
//
//  它原来是「设置 → 模型」里的一个全局复选框（settings.thinking）。问题在于：
//  全应用只有 DeepSeek 那两款真收 `thinking` 参数，把它摆在设置里，等于让人为了
//  切一个只在局部生效的开关翻两个界面。现在放在模型左边 —— 换到支持的模型它自己
//  就亮，点一下只影响**这一局**。
//
//  ⚠️ 能不能点，跟着**当前端点**走（`supportsThinking`）。那套规则在 main/http.js
//     的 `isDeepSeekThinkingModel` 里还有一份（那边决定**发不发**请求字段，这边
//     决定**能不能点**）。改规则必须两边一起改，否则会出现「界面能点、实际没发」。
//  ⚠️ 状态存会话（`convo.thinking`），不写全局设置：每局用的模型不同，上一局开不开
//     不该带到下一局。没设过时显示的是全局默认值，但**不往会话上写**。
// ============================================================================

import { el } from '../core/dom.js';
import { state } from '../core/state.js';
import { activeConvo } from '../core/util.js';
import { currentEndpoint, supportsThinking } from '../data/providers.js';
import { persistConversations } from '../data/persist.js';
import { onRefresh } from './refresh.js';

/** 这一局算不算「开着」：会话上没显式设过就跟随全局默认 */
function isOn(convo) {
  if (convo && typeof convo.thinking === 'boolean') return convo.thinking;
  return (state.settings || {}).thinking !== false;
}

/** 重画按钮态。模型换了、会话切了、设置改了都会走到这儿（挂在刷新总线上）。 */
function sync() {
  const btn = el.btnThinking;
  if (!btn) return;
  const convo = activeConvo();
  const supported = supportsThinking(currentEndpoint());
  const on = supported && isOn(convo);

  btn.disabled = !supported || !convo;
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('is-on', on);
  btn.title = !supported
    ? '当前模型不支持深度思考'
    : on
      ? '深度思考：开 —— 模型会先想再写，更慢'
      : '深度思考：关';
}

function toggle() {
  const convo = activeConvo();
  if (!convo) return;
  if (!supportsThinking(currentEndpoint())) return;
  // 显式切换才写进会话；此后这一局就按这个值走（effectiveSampling 会带上它）
  convo.thinking = !isOn(convo);
  persistConversations(0);
  sync();
}

export function initThinkingToggle() {
  const { btnThinking } = el;
  if (!btnThinking) return;
  btnThinking.addEventListener('click', toggle);
  onRefresh(sync);
  sync();
}
