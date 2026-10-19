'use strict';

// views/suggestionsUi.js —— 建议条 + 剧情选项的动作
// 纯逻辑（解析 / 拼指令）在 data/suggestions.js，composer 也要用
// send 由入口层注入

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { uid, activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { ensureConvoEndpoint } from '../data/providers.js';
import { persistConversations } from '../data/persist.js';
import { buildApiMessages } from '../data/messages.js';
import { matchWorldbookSections } from '../data/cast.js';
import { recallSection } from '../data/rag.js';
import {
  suggestInstruction,
  parseSuggestions,
  rerollOptionsInstruction,
  extractOptionsFromText
} from '../data/suggestions.js';
import { refreshAll } from './refresh.js';

// 切走会话时要清掉
let suggestionsConvoId = null;

let actions = { send: () => {} };

function hideSuggestions() {
  el.suggestStrip.classList.add('hidden');
  el.suggestList.innerHTML = '';
  suggestionsConvoId = null;
}

export function dropSuggestionsIfConvoChanged() {
  const convoNow = activeConvo();
  if (suggestionsConvoId && suggestionsConvoId !== (convoNow ? convoNow.id : null)) {
    hideSuggestions();
  }
}

export function pickOption(convo, text) {
  if (!convo || !text) return;
  if (state.streaming) {
    showToast('正在生成，等它写完再选');
    return;
  }
  convo.options = [];
  hideSuggestions();
  refreshAll();
  // 直接发送，不把文字写进输入框
  actions.send(text);
}

export function closeOptions(convo) {
  if (!convo) return;
  if (state.streaming) return;
  if (!Array.isArray(convo.options) || !convo.options.length) return;
  convo.options = [];
  persistConversations(0);
  refreshAll();
}

function renderSuggestions(options) {
  el.suggestList.innerHTML = '';

  if (!options || !options.length) {
    hideSuggestions();
    return;
  }

  const convo = activeConvo();
  suggestionsConvoId = convo ? convo.id : null;

  options.forEach((text) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggest-btn';
    btn.textContent = text;
    btn.title = '点一下，就当你说这句话发出去';
    btn.addEventListener('click', () => {
      if (state.streaming) {
        showToast('正在生成，等它写完再用');
        return;
      }
      hideSuggestions();
      // 直接发送，不把文字写进输入框
      actions.send(text);
    });
    el.suggestList.appendChild(btn);
  });

  el.suggestStrip.classList.remove('hidden');
}

export async function suggestNextActions(trigger) {
  const convo = activeConvo();
  if (!convo) return;

  if (state.streaming) {
    showToast('正在生成，等它写完再想');
    return;
  }

  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务', 'error');
    return;
  }

  const history = (convo.messages || []).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
  if (!history.length) {
    showToast('还没有对话内容，先聊两句', 'error');
    return;
  }

  const label = trigger || null;
  const originalText = label ? label.textContent : '';
  if (label) {
    label.disabled = true;
    label.textContent = '在想…';
  }

  try {
    // 复用 buildApiMessages（带人设 / 世界书 / 面板），否则模型只看到一截裸对话
    const worldbook = await matchWorldbookSections(convo);
    const ragSection = await recallSection(convo);
    const messages = buildApiMessages(convo, worldbook, ragSection);
    messages.push({ role: 'user', content: suggestInstruction() });

    const response = await api.sendChat({
      requestId: `suggest-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages
    });

    if (!response || response.ok !== true) {
      throw new Error((response && response.error) || '想不出来');
    }

    const options = parseSuggestions(response.content);
    if (!options.length) {
      showToast('这次没想出可用的选项，再点一次试试', 'error');
      return;
    }

    renderSuggestions(options);
  } catch (err) {
    showToast((err && err.message) || '想不出来，稍后再试', 'error');
  } finally {
    if (label) {
      label.disabled = false;
      label.textContent = originalText || '帮我想想';
    }
  }
}

// 与「帮我想想」不同：结果写回 convo.options，是剧情选项的延续，不是临时建议条
export async function rerollOptions(convo) {
  if (!convo) return false;
  if (state.streaming) {
    showToast('正在生成，等它写完再换');
    return false;
  }

  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务', 'error');
    return false;
  }

  // 存住旧的：这次失败要回滚，别把按钮清空
  const previous = Array.isArray(convo.options) ? convo.options.slice() : [];

  try {
    const worldbook = await matchWorldbookSections(convo);
    const ragSection = await recallSection(convo);

    const messages = buildApiMessages(convo, worldbook, ragSection);
    messages.push({ role: 'user', content: rerollOptionsInstruction(convo) });

    const response = await api.sendChat({
      requestId: `reroll-${uid()}`,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages
    });

    if (!response || response.ok !== true) {
      throw new Error((response && response.error) || '换一批失败');
    }

    // 模型偶尔漏掉「【剧情选项】：」标记，退化成按行解析兜底
    let items = extractOptionsFromText(String(response.content || ''));
    if (!items.length) items = parseSuggestions(response.content);
    if (!items.length) {
      showToast('这次没生成出可用选项，再换一次试试', 'error');
      return false;
    }

    // ⚠️ 请求期间用户可能切走会话，写回前确认还是这一个
    const current = activeConvo();
    if (!current || current.id !== convo.id) return false;

    convo.options = items;
    // 不落盘的话，换完一批直接关窗口，新选项在磁盘上就不存在
    persistConversations(0);
    refreshAll();
    return true;
  } catch (err) {
    convo.options = previous;
    showToast((err && err.message) || '换一批失败，稍后再试', 'error');
    return false;
  }
}

export function initSuggestionsUi(injected) {
  actions = { send: () => {}, ...(injected || {}) };
  el.btnSuggestClose.addEventListener('click', hideSuggestions);
}
