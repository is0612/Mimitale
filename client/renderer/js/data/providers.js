'use strict';

// ============================================================================
//  data/providers.js —— 多模型：服务商（provider）+ 模型（model）
//
//  一个服务商 = 一套「接口地址 + API Key + 模型列表」。
//  每个会话会记住自己用的是哪个服务商的哪个模型。
//
//  纯逻辑，不碰 DOM。注意 ensureConvoEndpoint() 会**就地补全会话对象**
//  （这是有意的：老会话没有这两个字段，读到就得补上，不然下拉框里是空的）。
// ============================================================================

import { state } from '../core/state.js';
import { activeConvo, asArray } from '../core/util.js';

export function providers() {
  const s = state.settings || {};
  return asArray(s.providers);
}

export function providerById(id) {
  return providers().find((p) => p.id === id) || null;
}

/** 是不是本机酒馆桥接服务商（/chat_with_image，免 Key、非流式） */
export function isBridgeProvider(provider) {
  return !!(provider && provider.type === 'tavern-bridge');
}

/** 把会话绑定的服务商/模型补全（老会话没有这两个字段） */
export function ensureConvoEndpoint(convo) {
  if (!convo) return null;
  const list = providers();
  if (!list.length) return null;

  const s = state.settings || {};
  let provider = providerById(convo.providerId);

  if (!provider) {
    provider = providerById(s.activeProviderId) || list[0];
    convo.providerId = provider.id;
    convo.model = s.activeModel || asArray(provider.models)[0] || '';
  }
  if (!convo.model) {
    convo.model = asArray(provider.models)[0] || s.activeModel || '';
  }
  // 模型可能被用户从列表里删掉了，临时补回去，免得下拉框里找不到当前值
  const models = asArray(provider.models);
  if (convo.model && !models.includes(convo.model)) {
    provider.models = [convo.model, ...models];
  }

  return { provider, model: convo.model };
}

/** 当前会话实际会用的服务商 + 模型 */
export function currentEndpoint() {
  const convo = activeConvo();
  if (convo) return ensureConvoEndpoint(convo);

  const s = state.settings || {};
  const provider = providerById(s.activeProviderId) || providers()[0] || null;
  return provider ? { provider, model: s.activeModel || asArray(provider.models)[0] || '' } : null;
}

/** 这个端点收不收 `thinking` 参数（设置页据此决定「深度思考」说明怎么写）。
 *  ⚠️ 必须和 `main/http.js` 的 `isDeepSeekThinkingModel` 一致：那边决定**发不发**，
 *  这边只决定**说明怎么写**。两边漂移的后果是「界面说支持、实际没发」—— 静默失效。 */
export function supportsThinking(endpoint) {
  if (!endpoint || !endpoint.provider || !endpoint.model) return false;
  let host = '';
  try {
    host = new URL(String(endpoint.provider.baseUrl || '')).hostname;
  } catch (err) {
    return false;
  }
  return host === 'api.deepseek.com' && /^(deepseek-flash|deepseek-v4-pro)$/i.test(endpoint.model);
}
