'use strict';

// views/suggestionsUi.js —— 剧情选项的动作：选用 / 再要一批 / 收起
// 纯逻辑（解析 / 拼指令）在 data/suggestions.js
//
// ⚠️ 产出只有**一条**路径：结果一律写回 convo.options，界面上也只有一块 .msg-options
//    （画在 views/chatMessages.js）。
//    工具条的「帮我想想」和选项块里的「⟳ 换一批」是**同一个动作**（requestMoreOptions），
//    只是两个位置 + 两种 loading 反馈 —— 别再拆成两套请求/解析。
//    2026-10-20 之前还有一条独立的临时建议条（#suggest-strip），已经合并掉了，别复活。
//
// send 由入口层注入（选用选项 = 把你选的那句当消息发出去）。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { uid, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { ensureConvoEndpoint } from '../data/providers.js';
import { persistConversations } from '../data/persist.js';
import { buildApiMessages } from '../data/messages.js';
import { matchWorldbookSections } from '../data/cast.js';
import { recallSection } from '../data/rag.js';
import {
  optionsRequestInstruction,
  extractOptionsFromText,
  parseSuggestions
} from '../data/suggestions.js';
import { refreshAll } from './refresh.js';
import { convoDerivedRequestVersion } from '../data/convoState.js';

let actions = { send: () => {}, setOptionsLoading: () => {} };

// 同一时刻只允许一个「要选项」请求在跑。
// 两个按钮是**同一个动作**，并发点会回来两批（后到的盖掉先到的），骨架屏也会被两边争着画。
// ⚠️ 对话流式生成走 state.streaming，手动请求选项不走那条状态 —— 所以必须单独上锁。
let pendingConvoId = null;

/** 点一颗选项 = 把它的文字当成你说的话发出去（输入框里按 1~9 走的也是这条路）。 */
export function pickOption(convo, text) {
  if (!convo || !text) return;
  // 正在要选项时这批已经被骨架屏换掉了，按数字键还能摸到内存里那份 —— 别让它发出去
  if (pendingConvoId) {
    showToast('正在要选项，等它回来');
    return;
  }
  if (state.streaming) {
    showToast('正在生成，等它写完再选');
    return;
  }
  convo.options = [];
  refreshAll();
  // 直接发送，不把文字写进输入框
  actions.send(text);
}

/** ✕：收起这一批。下次要新内容就再点一次「帮我想想」或「换一批」。 */
export function closeOptions(convo) {
  if (!convo) return;
  if (state.streaming) return;
  // 正在要选项时收起，回来的结果又会把它写出来 —— 等于没点，直接不响应
  if (pendingConvoId) return;
  if (!Array.isArray(convo.options) || !convo.options.length) return;
  convo.options = [];
  persistConversations(0);
  refreshAll();
}

/**
 * 向模型再要一批选项，成功就写回 convo.options（重绘会把 .msg-options 画出来）。
 *
 * 「帮我想想」和「换一批」走的都是这里 —— 指令也只有一份（`optionsRequestInstruction`，
 * 按手上有没有上一批自动切成「补一批 / 换一批」）。两个按钮的区别只剩：
 *   · trigger：传了就把那颗按钮改成「在想…」（工具条那颗）；选项块里那颗自己改文案，不传。
 *   · tag / failText：请求 id 前缀和报错文案。
 *
 * 骨架屏、互斥都在这儿统一处理 —— 以前两处各画一遍、又没有锁，能同时点出两个请求。
 *
 * 返回：true 成功 / false 失败（**调用方要自己把骨架屏换回按钮**）/ 'busy' 被另一次挡住了。
 */
export async function requestMoreOptions(convo, { trigger = null, tag = 'options', failText = '再要一批失败' } = {}) {
  if (!convo) return false;

  // 互斥：另一个入口还在等模型，这次直接不响应（两个按钮点的是同一个动作）。
  // ⚠️ 返回 'busy' 而不是 false —— 调用方靠 false 判断「要不要把骨架屏换回按钮」，
  //    被挡下的那次根本没动骨架屏，不该去重画。
  if (pendingConvoId) {
    showToast('正在要选项，等它回来');
    return 'busy';
  }

  if (state.streaming) {
    showToast('正在生成，等它写完再试');
    return false;
  }

  const history = (convo.messages || []).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
  if (!history.length) {
    showToast('还没有对话内容，先聊两句', 'error');
    return false;
  }

  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务', 'error');
    return false;
  }

  // 存住旧的：这次失败要回滚，别把已经画出来的那批吞掉
  const previous = Array.isArray(convo.options) ? convo.options.slice() : [];

  const label = trigger || null;
  const originalText = label ? label.textContent : '';
  if (label) {
    label.disabled = true;
    label.textContent = '在想…';
  }

  pendingConvoId = convo.id;
  const version = convoDerivedRequestVersion(convo);
  const historySnapshot = convo.messages.map((message) => ({ message, role: message.role, content: message.content, at: message.at }));
  const optionsSnapshot = JSON.stringify(convo.options || []);
  const isCurrent = () => activeConvo() === convo && state.conversations.includes(convo) &&
    !state.streaming && convoDerivedRequestVersion(convo) === version &&
    JSON.stringify(convo.options || []) === optionsSnapshot &&
    convo.messages.length === historySnapshot.length && historySnapshot.every((entry, index) => {
      const message = convo.messages[index];
      return message === entry.message && message.role === entry.role && message.content === entry.content && message.at === entry.at;
    });

  try {
    // 骨架屏在这里统一画：两个入口走的是同一个动作，反馈不该一个有、一个没有。
    // ⭐ 没有选项块时（纯聊天 / 卡上关了选项，第一次要）**刻意什么都不画**，
    //    只留按钮上的「在想…」。凭空长出一块占位再收缩，反而像闪了一下
    //    （星宝 2026-10-20 定的：没选项就跟以前一样）。
    // ⚠️ 必须在第一个 await 之前 —— 否则要等一拍才闪出来。
    actions.setOptionsLoading(true);

    // 复用 buildApiMessages（带人设 / 世界书 / 面板），否则模型只看到一截裸对话
    const worldbook = await matchWorldbookSections(convo);
    if (!isCurrent()) return false;
    const ragSection = await recallSection(convo);
    if (!isCurrent()) return false;
    const messages = buildApiMessages(convo, worldbook, ragSection);
    messages.push({ role: 'user', content: optionsRequestInstruction(convo) });

    const response = await api.sendChat({
      requestId: `${tag}-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages
    });

    if (!isCurrent()) return false;
    if (!response || response.ok !== true) {
      throw new Error((response && response.error) || failText);
    }

    // 模型偶尔漏掉「【剧情选项】：」标记，退化成按行解析兜底（条数跟这一局配的一致）
    let items = extractOptionsFromText(String(response.content || ''));
    if (!items.length) items = parseSuggestions(response.content, convo.optionsSpec && convo.optionsSpec.count);
    if (!items.length) {
      convo.options = previous;
      showToast('这次没生成出可用选项，再试一次', 'error');
      return false;
    }

    // ⚠️ 请求期间用户可能切走会话，写回前确认还是这一个
    if (!isCurrent()) return false;

    convo.options = items;
    // 不落盘的话，生成完直接关窗口，这批选项在磁盘上就不存在
    persistConversations(0);
    refreshAll();
    return true;
  } catch (err) {
    if (!isCurrent()) return false;
    convo.options = previous;
    showToast((err && err.message) || `${failText}，稍后再试`, 'error');
    return false;
  } finally {
    pendingConvoId = null;
    // 失败时把骨架屏换回旧按钮；成功时 refreshAll 已经重建过整块，这里作用的可能是新块（重画一次按钮，无副作用）
    actions.setOptionsLoading(false);
    // 成功时整块重绘已经把按钮换成新的了，这里恢复的是旧节点 —— 无害
    if (label) {
      label.disabled = false;
      label.textContent = originalText || '帮我想想';
    }
  }
}

export function initSuggestionsUi(injected) {
  // 这个模块自己不绑任何 DOM：只注入「发送」（选用选项时用）和「选项块切骨架屏」
  // （由 views/chatMessages.js 提供 —— 反过来 import 会绕成循环依赖）
  actions = { send: () => {}, setOptionsLoading: () => {}, ...(injected || {}) };
}
