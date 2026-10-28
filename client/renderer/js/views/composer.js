'use strict';

// views/composer.js —— 输入区与「发送 / 重新生成 / 继续 / 换候选」链路
// 这里管「什么时候开始、什么时候结束」；流式分片的接收端在入口层（api.onChunk）。

import { CONFIG } from '../core/config.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { el } from '../core/dom.js';
import { activeConvo, uid, now } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { iconHtml } from '../ui/icons.js';
import { h, clear } from '../ui/build.js';
// 该量/该写高度的那颗：组件（<m-textarea>）要落到里层那颗原生框上
import { controlOf } from '../ui/auto-grow.js';
import { mTextarea, mButton } from '../components/index.js';
import { persistConversations, beginConversationReplacement, endConversationReplacement } from '../data/persist.js';
import { ensureConvoEndpoint, isBridgeProvider } from '../data/providers.js';
import { isLoggedIn, consumeMessage, messageQuota, messageQuotaSnapshot, refundMessage } from '../data/account.js';
import { confirmDialog } from '../ui/confirm.js';
import { openAccountModal } from './accountModal.js';
import { openProfile } from './userSettings.js';
import { buildApiMessages, characterContextForConvo, effectiveSampling } from '../data/messages.js';
import { matchWorldbookSections } from '../data/cast.js';
import { recallSection } from '../data/rag.js';
import { invalidateSummariesForEdit } from '../data/memory.js';
import { rebuildConvoDerivedState, invalidateConvoDerivedRequests } from '../data/convoState.js';
import {
  convoFieldDisplayNames,
  convoPanelFields,
  PANEL_PROMPT_NUDGE,
  syncConvoPanel,
  syncPlayerNameFromPanel
} from '../data/panel.js';
import { syncConvoOptions } from '../data/suggestions.js';
import { createConvo } from '../data/conversations.js';
import { openSettings } from './settings.js';
import { streamPainter } from './stream.js';
import { attachGeneratedImage } from './chatImages.js';
import { renderAll } from './redraw.js';
import { maybeSummarize } from './summarize.js';
import { maybePetAutoSpeak } from '../data/petContext.js';

// Applies to the whole generation chain, including retries and panel repair requests.
let generationStopped = false;
let cancelPreparation = null;

function throwIfGenerationStopped() {
  if (generationStopped) throw new Error('已停止生成。');
}

async function prepareCompletion(convo) {
  let timeout;
  let ragTimeout;
  let preparationFinished = false;
  const interrupted = new Promise((_, reject) => {
    cancelPreparation = () => reject(new Error('已停止生成。'));
    timeout = setTimeout(() => reject(new Error('准备回复超时，请重试或检查语义检索服务。')), 45000);
  });
  try {
    return await Promise.race([
      // 语义检索的原则是「捞不到就算了」：慢到把整轮生成拖垮时降级为不带往事，
      // 但用户主动「停止生成」仍走 interrupted 抛错。世界书匹配不降级。
      (async () => {
        const worldbook = await matchWorldbookSections(convo);
        if (preparationFinished) throw new Error('回复准备已结束。');
        throwIfGenerationStopped();
        const ragSection = await Promise.race([
          recallSection(convo),
          new Promise((resolve) => { ragTimeout = setTimeout(() => resolve(''), 10000); })
        ]);
        return { worldbook, ragSection };
      })(),
      interrupted
    ]);
  } finally {
    preparationFinished = true;
    clearTimeout(timeout);
    clearTimeout(ragTimeout);
    cancelPreparation = null;
  }
}

function setStreaming(on) {
  if (on) generationStopped = false;
  state.streaming = on;
  const btn = el.btnSend;
  btn.disabled = false;
  btn.setAttribute('data-mode', on ? 'stop' : 'send');
  btn.setAttribute('aria-label', on ? '停止生成回复' : '发送消息');
  btn.setAttribute('title', on ? '停止生成' : '发送回应');
  btn.setAttribute('variant', on ? 'danger' : 'primary');
  const icon = (btn.control || btn).querySelector('.field-icon');
  if (icon) icon.outerHTML = iconHtml(on ? 'square' : 'arrow-up');
}

/** 输入框跟着内容长高；el.input 是 <m-textarea> 宿主，量/写高度都要过 controlOf 落到原生框 */
// 对宿主写 style.height 无效，症状是不报错但框永远不长高。
export function autoGrowInput() {
  const box = controlOf(el.input);
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, CONFIG.MAX_INPUT_HEIGHT)}px`;
}

// ---------------------------------------------------------------------------
//  使用权限：有会员 / 免费天数的人不限量，没有的话每天 20 条
//
//  ⚠️ 数字由服务端定（lib/quota.ts），这里只问「还能不能发」，不自己算 ——
//     本地算的话改系统时间、改本地数据就能绕。
// ---------------------------------------------------------------------------

const INPUT_PLACEHOLDER = '写下你的回应，让故事继续……';

let lockedHintBound = false;

/** 模型一个字都没吐出来时把额度退回去；错了就算了，别打扰用户 */
function refundQuietly() {
  refundMessage().catch((err) => console.warn('[quota] 退额度失败:', (err && err.message) || err));
}

/**
 * 问服务端还能不能发。
 * ⚠️ 拉不到就放行：账号服务器是自建的，不能因为它抖一下就让所有人发不出消息。
 */
async function askQuota(charge) {
  try {
    if (charge) return await consumeMessage();
    // 不扣数的入口（重新生成 / 帮我想想）只看还有没有余额；快照说还有就不打扰服务端
    const snapshot = messageQuotaSnapshot();
    if (snapshot && (snapshot.unlimited || snapshot.remaining > 0)) return { ...snapshot, allowed: true };
    const fresh = await messageQuota();
    return { ...fresh, allowed: !!fresh.unlimited || fresh.remaining > 0 };
  } catch (err) {
    console.warn('[quota] 额度接口不可用，本次放行:', (err && err.message) || err);
    return { allowed: true, degraded: true };
  }
}

function showQuotaDialog(info) {
  const limit = info && info.limit ? info.limit : 20;
  void confirmDialog({
    title: '今天的免费额度用完了',
    message: `免费用户每天 ${limit} 条，明天 0 点恢复。开通订阅或输入卡密可以立刻继续。`,
    confirmText: '去输卡密'
  }).then((go) => { if (go) openProfile('sec-member'); });
}

function showLoginDialog() {
  void confirmDialog({
    title: '登录后才能发消息',
    message: '账号用来记每天的免费额度，订阅和卡密也挂在账号上。',
    confirmText: '去登录'
  }).then((go) => { if (go) openAccountModal(); });
}

/**
 * 输入框下面那行「今天还剩 N 条」。
 * ⚠️ 有权益（会员 / 免费天数）时整行隐藏：那时候数字没意义，显示出来只会让人
 *    以为自己被限流了。
 */
function renderQuotaLine(info) {
  const line = el.quotaLine;
  if (!line) return;
  if (!info || info.unlimited || !isLoggedIn()) {
    line.classList.add('hidden');
    line.textContent = '';
    line.removeAttribute('data-state');
    return;
  }
  const left = Number.isFinite(info.remaining) ? info.remaining : 0;
  const limit = info.limit || 20;
  line.classList.remove('hidden');
  if (left > 0) {
    line.dataset.state = left <= 3 ? 'low' : 'normal';
    line.textContent = `今天还剩 ${left} 条免费消息（每天 ${limit} 条）`;
  } else {
    line.dataset.state = 'out';
    line.textContent = `今天的 ${limit} 条免费消息用完了，明天 0 点恢复 · 输入卡密可以立刻继续`;
  }
}

/** 拉一次最新额度并画出来；拉不到就保持原样（别把「服务器抖了」显示成「用完了」） */
async function refreshQuotaLine() {
  if (!isLoggedIn()) {
    renderQuotaLine(null);
    return;
  }
  try {
    renderQuotaLine(await messageQuota());
  } catch (err) {
    console.warn('[quota] 读取剩余条数失败:', (err && err.message) || err);
  }
}

let quotaHintBound = false;

/**
 * 这条能不能发出去。
 * @param {{charge?: boolean}} options charge=true 扣一条（发送 / 继续）；不传按扣一条算
 * @returns {Promise<object|null>} 放行返回额度信息（调用方可能拿它判断要不要退），拦了返回 null
 */
async function allowSend(options = {}) {
  if (!isLoggedIn()) {
    showLoginDialog();
    return null;
  }
  const info = await askQuota(options.charge !== false);
  if (info.allowed) {
    // 扣完立刻把「还剩几条」刷新掉，别等下一次启动
    if (!info.degraded) renderQuotaLine(info);
    return info;
  }
  showQuotaDialog(info);
  return null;
}

/**
 * 不扣数的生成入口（帮我想想 / 换一批）用这颗：只确认今天还有余额。
 * 由入口层注入给 views/suggestionsUi.js —— 那边不 import 这里，免得两个视图互相依赖。
 */
export function optionsAllowed() {
  return allowSend({ charge: false });
}

/**
 * 未登录时把输入框锁上。
 * ⚠️ 用 readOnly 不用 disabled：disabled 收不到点击，用户点了没反应就以为卡死了；
 *    readOnly 照样能聚焦能点，我们才有机会把登录窗递过去。
 */
export function applyComposerAccess() {
  const locked = !isLoggedIn();
  el.input.readOnly = locked;
  el.input.placeholder = locked ? '登录后才能发消息……' : INPUT_PLACEHOLDER;
  if (el.input.toggleAttribute) el.input.toggleAttribute('data-locked', locked);

  // 额度那行跟着登录态走：未登录直接收起，已登录去问一次服务端
  if (locked) renderQuotaLine(null);
  else void refreshQuotaLine();

  if (!quotaHintBound && el.quotaLine) {
    quotaHintBound = true;
    // 用完了点这一行 = 想继续用，直接送到兑换框
    el.quotaLine.addEventListener('click', () => {
      if (el.quotaLine.dataset.state === 'out') openProfile('sec-member');
    });
  }

  if (!lockedHintBound) {
    lockedHintBound = true;
    el.input.addEventListener('pointerdown', () => {
      if (!el.input.readOnly) return;
      applyComposerAccess();
      showLoginDialog();
    });
  }
}

/**
 * 发一条消息；真发出返回 true，任何早退路径返回 false，调用方必须先看返回值再清空输入框。
 */
export async function sendMessage(text) {
  const content = String(text || '').trim();
  if (!content) return false;

  if (state.streaming) {
    showToast('正在生成中，请稍候或先停止');
    return false;
  }

  // 未登录先拦住：后面那几条「登录后才能配置模型服务」对游客来说太绕了
  if (!isLoggedIn()) {
    showLoginDialog();
    return false;
  }

  // 扣额度放在建会话之前：被挡住时不该在会话列表里留一条空的「新对话」
  const quota = await allowSend({ charge: true });
  if (!quota) return false;

  let convo = activeConvo();
  if (!convo) convo = createConvo(true);

  // 用当前会话绑定的服务商 + 模型；没绑过就用全局默认
  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    // 扣了但发不了 = 这条没生成，把额度退回去（fail-open 时没扣，退了反而白送）
    if (!quota.degraded) refundQuietly();
    // 未登录进不了设置，别把人往一个不可达的地方引
    if (!isLoggedIn()) {
      showToast('登录后才能配置模型服务', 'error');
      return false;
    }
    showToast('还没有配置模型服务，请先在设置里添加', 'error');
    openSettings();
    return false;
  }
  if (!endpoint.provider.apiKey && !isBridgeProvider(endpoint.provider)) {
    if (!quota.degraded) refundQuietly();
    if (!isLoggedIn()) {
      showToast('登录后才能配置模型服务', 'error');
      return false;
    }
    showToast(`请先填写「${endpoint.provider.name}」的 API Key`, 'error');
    openSettings();
    return false;
  }

  if (!Array.isArray(convo.messages)) convo.messages = [];
  if (convo.messages.length === 0) {
    convo.title = content.slice(0, 24) || '新对话';
  }

  invalidateConvoDerivedRequests(convo);
  const message = { role: 'user', content, at: now() };
  convo.messages.push(message);

  convo.updatedAt = now();
  state.usage = null;
  renderAll({ forceScroll: true });
  persistConversations();

  await requestCompletion(convo, { charged: true });
  return true;
}

/** 清空输入框时用来比对「刚发出去的文字」 */
export function sentTextOf(text) {
  return String(text || '').trim();
}

/**
 * 发出后清空输入框；只在框里仍是刚发的那段文字时才清（中间用户可能又打了新字）。
 */
export function clearInputAfterSend(sentText) {
  if (el.input.value.trim() !== String(sentText || '').trim()) return;
  el.input.value = '';
  autoGrowInput();
}

/** 就地编辑一条消息：气泡换成 textarea，保存/取消；直接改原文，不用删除重发 */
export function editMessage(index) {
  const convo = activeConvo();
  if (!convo || state.streaming) return;

  const message = convo.messages[index];
  if (!message || message.role === 'error') return;

  const node = el.messages.querySelector(`.msg[data-index="${index}"] .msg-content`);
  const bubble = node ? node.parentElement : null;
  if (!node || !bubble) return;

  const original = String(message.content || '');

  // 就地建/就地扔的多行框用工厂形态；class 留在宿主上，keydown/value/focus 由组件代理
  const textarea = mTextarea({
    class: 'msg-edit-box',
    spellcheck: 'false',
    'aria-label': '编辑消息内容',
    value: original
  });

  const finish = (save) => {
    if (save) {
      // 流式已开始、或这条消息已被删 —— 这次编辑不能再落地，重绘把编辑框收掉
      if (state.streaming || !convo.messages.includes(message)) {
        renderAll({ forceScroll: false });
        return;
      }
      const next = textarea.value;
      if (!next.trim()) {
        showToast('内容不能为空 —— 想删掉这条就用「删除」', 'error');
        textarea.focus();
        return;
      }
      if (next !== message.content) invalidateSummariesForEdit(convo, message);
      message.content = next;
      // 改的是某条候选时，改动要落回它那个槽，否则切走再切回就变回老样子了
      if (Array.isArray(message.variants) && Number.isFinite(message.variantIndex)) {
        message.variants[message.variantIndex] = next;
      }
      convo.updatedAt = now();
      // 助手消息里可能写着状态栏，改完要重新扫一遍面板
      if (message.role === 'assistant') {
        syncConvoPanel(convo);
        syncConvoOptions(convo);
        syncPlayerNameFromPanel(convo);
      }
      persistConversations(0);
      showToast('已保存', 'ok');
    }
    renderAll({ forceScroll: false });
  };

  const save = mButton({ variant: 'primary', size: 'sm', text: '保存', onClick: () => finish(true) });
  const cancel = mButton({ variant: 'ghost', size: 'sm', text: '取消', onClick: () => finish(false) });

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish(true);
    }
  });

  clear(node);
  node.appendChild(textarea);
  node.appendChild(h('div', { class: 'msg-edit-actions' }, save, cancel));

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  // 要滚整个内容块 node：只滚 textarea 时它已完整可见，被切掉的是下面那行按钮
  node.scrollIntoView({ block: 'nearest' });
}

/** 「继续」时追加在提示词末尾的引导。只进这一次请求，不存进会话 */
const CONTINUE_NUDGE = '（接着你上一条回复继续往下写。不要重复已经写过的内容，也不要重新开头。）';

/**
 * 撞上限最多自动接着写几次：再续就再花钱，剩下的交给消息上那颗「继续」。
 */
const MAX_AUTO_CONTINUE = 2;

/**
 * 只思考没落笔时自动重试的引导：要求直接写正文、思考最多两三句（只进本次请求）。
 */
const REASONING_RETRY_NUDGE =
  '（你上一条回复只输出了思考过程，正文一个字都没写出来。不要再展开推演，思考最多两三句，' +
  '然后直接把这一轮该写的正文完整写出来。）';

/** 从一次响应的 usage 里取「思考 token」数（服务商没给、或给 0 就是 0） */
function reasoningTokensOf(usage) {
  const n = Number(usage && usage.reasoning_tokens);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 让最后一条助手消息接着往下写（「继续」和截断自动续写共用）；不新建消息，增量接在原文后面。
// ⚠️ worldbook 是 matchWorldbookSections() 返回的 { section, deepSection }，不是字符串，原样透传。
async function extendAssistantMessage(convo, endpoint, worldbook, ragSection, nudge, opts) {
  throwIfGenerationStopped();
  const last = convo.messages[convo.messages.length - 1];
  if (!last || last.role !== 'assistant') return { ok: false, error: '没有可续写的回复' };

  const requestId = uid();
  state.requestId = requestId;
  state.requestTarget = { convo, assistant: last };

  const messages = buildApiMessages(convo, worldbook, ragSection);
  messages.push({ role: 'user', content: nudge || CONTINUE_NUDGE });
  const before = String(last.content || '');

  try {
    const response = await api.sendChat({
      requestId,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages,
      characterContext: characterContextForConvo(convo),
      // opts.sampling 给「补救请求」单独压参数：面板补写只要抄一行状态表，不需要推理链。
      sampling: { ...(effectiveSampling(convo) || {}), ...((opts && opts.sampling) || {}) }
    });

    if (!response || response.ok !== true) {
      return { ok: false, error: (response && response.error) || '调用失败' };
    }
    if (response.usage) state.usage = response.usage;
    // 以新的收尾信号为准；补问状态表（keepFinishReason）例外 —— 它不是正文续写，别覆盖正文的收尾信号
    if (response.finishReason && !(opts && opts.keepFinishReason)) last.finishReason = response.finishReason;

    // 服务商不推流式分片时用整段返回兜底（正文没变说明没收到过分片）
    if (String(last.content || '') === before && String(response.content || '').trim()) {
      // 旧正文末尾常是状态行/选项行（无换行），直接接会让新正文头一行黏上去被剥掉，先补换行
      const sep = before && !before.endsWith('\n') && !String(response.content).startsWith('\n') ? '\n' : '';
      last.content = before + sep + response.content;
    }

    return { ok: true, usage: response.usage || null, finishReason: response.finishReason || '' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || '续写失败' };
  }
}

/** 这一轮有没有写状态表：按本会话已知字段行【名】：值判断，不是随便一个【】就算 */
function panelWrittenIn(convo, text) {
  const known = new Set(convoFieldDisplayNames(convo));
  if (!known.size) return true;

  for (const rawLine of String(text || '').split('\n')) {
    const m = rawLine.trim().match(/^【([^】\n]+)】[：:]/);
    if (m && known.has(m[1].trim())) return true;
  }
  return false;
}

/**
 * 整轮没提状态表 → 补问一次，把状态表接到同一条回复后面；只补一次，失败就算了。
 */
async function ensurePanelWritten(convo, endpoint, worldbook, ragSection, assistant) {
  throwIfGenerationStopped();
  if (!convoPanelFields(convo).length) return false;
  if (!String(assistant.content || '').trim()) return false;   // 空正文走别的分支
  if (panelWrittenIn(convo, assistant.content)) return false;

  const before = String(assistant.content || '');
  // keepFinishReason：补问只是一次附加的补救请求，别让它改写这条回复的收尾信号
  // thinking:false：补状态表是机械活（把这一轮的数值抄成一行），推理链在这里纯烧钱 ——
  // 一次完整请求的思考量常常比状态表本身长几十倍。截断续写不在此列，那是正文，要质量。
  const res = await extendAssistantMessage(convo, endpoint, worldbook, ragSection, PANEL_PROMPT_NUDGE, {
    keepFinishReason: true,
    sampling: { thinking: false }
  });
  return res.ok && String(assistant.content || '') !== before;
}

/** 「继续」：让模型接着最后一条回复往下写（回复被 maxTokens 截断时用） */
export async function continueLastMessage() {
  const convo = activeConvo();
  if (!convo) return;
  if (state.streaming) {
    showToast('正在生成，等它写完再继续');
    return;
  }

  const last = convo.messages[convo.messages.length - 1];
  if (!last || last.role !== 'assistant' || !String(last.content || '').trim()) {
    showToast('只能在 AI 的回复后面接着写', 'error');
    return;
  }

  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    showToast('还没有配置模型服务', 'error');
    return;
  }

  if (!(await allowSend({ charge: true }))) return;
  const contentBefore = String(last.content || '');

  invalidateConvoDerivedRequests(convo);
  setStreaming(true);
  try {
    const { worldbook, ragSection } = await prepareCompletion(convo);
    if (generationStopped) return;

    const index = convo.messages.length - 1;
    const bubble = el.messages.querySelector(`.msg[data-index="${index}"] .bubble`);
    if (bubble) bubble.classList.add('streaming');

    const res = await extendAssistantMessage(convo, endpoint, worldbook, ragSection, CONTINUE_NUDGE);
    if (!res.ok) throw new Error(res.error);
    // 续写也可能整轮不提状态表（这条路径绕开了 requestCompletion 的补问），要补一次
    await ensurePanelWritten(convo, endpoint, worldbook, ragSection, last);
  } catch (err) {
    // 一个字都没续上 = 这次等于没生成，把刚扣的那条退回去
    if (String(last.content || '') === contentBefore) refundQuietly();
    showToast((err && err.message) || '继续失败', 'error');
  } finally {
    streamPainter.stop();
    setStreaming(false);
    state.requestId = null;
    state.requestTarget = null;
    convo.updatedAt = now();
    // 续写改了正文，同样要落回当前那个候选槽
    if (Array.isArray(last.variants) && Number.isFinite(last.variantIndex)) {
      last.variants[last.variantIndex] = last.content;
    }
    syncConvoPanel(convo);
    syncConvoOptions(convo);
    renderAll({ forceScroll: true });
    persistConversations();
    el.input.focus();
  }
}

/**
 * 正文被截断时自动接着写（「设置 → 行为 → 截断后自动续写」可关）；返回 { rounds, reasoningTokens }。
 */
async function autoContinueTruncated(convo, index, endpoint, worldbook, ragSection) {
  const out = { rounds: 0, reasoningTokens: 0 };
  if ((state.settings || {}).autoContinue === false) return out;

  let tip = null;

  while (out.rounds < MAX_AUTO_CONTINUE) {
    const lastMsg = convo.messages[convo.messages.length - 1];
    if (!lastMsg || lastMsg.finishReason !== 'length' || !String(lastMsg.content || '').trim()) {
      break;
    }
    out.rounds += 1;

    // 补一条续写进度说明；挂气泡上而非 .msg-content（流式只重写 innerHTML）
    const node = el.messages.querySelector(`.msg[data-index="${index}"] .msg-content`);
    const bubble = node ? node.parentElement : null;
    if (bubble && !tip) {
      tip = document.createElement('div');
      tip.className = 'continue-tip';
      bubble.appendChild(tip);
    }
    if (tip) tip.textContent = `写到「回复上限」了，正在接着写…（第 ${out.rounds} 次）`;

    const res = await extendAssistantMessage(convo, endpoint, worldbook, ragSection, CONTINUE_NUDGE);
    if (!res.ok) break;
    out.reasoningTokens += reasoningTokensOf(res.usage);
  }

  if (tip) tip.remove();
  return out;
}

/**
 * 调一次模型，把回复流式写进界面；options.variants 有值即「重新生成」，新回复作为新候选接在后面。
 */
async function requestCompletion(convo, options) {
  // 已经在生成中就别再进来 —— 先判这个，避免 ensureConvoEndpoint 顺手改会话
  if (state.streaming) {
    if (options && options.rollback) {
      options.rollback();
      endConversationReplacement(convo);
    }
    return;
  }

  const endpoint = ensureConvoEndpoint(convo);
  if (!endpoint) {
    if (options && options.rollback) {
      options.rollback();
      endConversationReplacement(convo);
    }
    showToast('还没有配置模型服务', 'error');
    return;
  }

  setStreaming(true);
  let assistant = null;
  let index = -1;
  let waitingTimer = null;
  let completed = false;

  try {
    // 世界书在渲染层匹配（本地纯计算，省一次 IPC）；第一回合也要拿到设定
    const { worldbook, ragSection } = await prepareCompletion(convo);

    if (generationStopped) return;
    const requestId = uid();
    state.requestId = requestId;

    // 先插入一个空的助手消息，边收边填
    assistant = {
      role: 'assistant',
      content: '',
      reasoning: '',
      at: now(),
      model: endpoint.model,
      providerId: endpoint.provider.id
    };
    // 重新生成：老候选接在前面，新的一条先占位，让「2/3」计数在流式中也正确
    const seeded = options && Array.isArray(options.variants) ? options.variants.filter((v) => String(v || '').trim()) : null;
    if (seeded && seeded.length) {
      assistant.variants = [...seeded, ''];
      assistant.variantIndex = assistant.variants.length - 1;
    }

    convo.messages.push(assistant);
    state.requestTarget = { convo, assistant };

    index = convo.messages.length - 1;
    renderAll({ forceScroll: true });

    const node = el.messages.querySelector(`.msg[data-index="${index}"] .msg-content`);
    const bubble = node ? node.parentElement : null;

    if (bubble) bubble.classList.add('streaming');

    if (node) {
      const wait = document.createElement('div');
      wait.className = 'waiting';
      // 本机桥接一次返回全文、非流式，出图时整轮可能 30~40 秒 —— 提前说明别让用户干等
      wait.textContent = isBridgeProvider(endpoint.provider)
        ? '正在生成（本地模型，出图时可能需要 40 秒左右）'
        : '正在等待模型回应…';
      node.innerHTML = '';
      node.appendChild(wait);
      const started = Date.now();
      if (!isBridgeProvider(endpoint.provider)) waitingTimer = setInterval(() => {
        if (!wait.isConnected) return;
        const seconds = Math.floor((Date.now() - started) / 1000);
        wait.textContent = assistant.reasoning
          ? `模型正在深度思考…（${seconds} 秒）`
          : seconds >= 15
            ? `服务暂未输出内容，正在等待…（${seconds} 秒，可点停止）`
            : `正在等待模型回应…（${seconds} 秒）`;
      }, 1000);
    }

    const response = await api.sendChat({
      requestId,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: buildApiMessages(convo, worldbook, ragSection),
      characterContext: characterContextForConvo(convo),
      sampling: effectiveSampling(convo)
    });

    if (!response || response.ok !== true) {
      throw new Error((response && response.error) || '调用失败');
    }

    if (response.usage) state.usage = response.usage;
    // 主进程可能会把模型名规范化，以它返回的为准
    if (response.model) assistant.model = response.model;

    // 正文以攒起来的流式分片为准（onChunk 追加进 assistant.content），一片都没攒到才用整段返回兜底。
    // ⚠️ 别写成 response.content || assistant.content（会覆盖分片）；分片可能比回执后到被丢，必须兜「没攒到」。
    if (!String(assistant.content || '').trim() && String(response.content || '').trim()) {
      assistant.content = response.content;
    }
    if (!String(assistant.reasoning || '').trim() && String(response.reasoning || '').trim()) {
      assistant.reasoning = response.reasoning;
    }

    // 本机桥接的出图夹在对话响应里（base64 PNG 或 null），有图就压一档挂到这条消息上
    if (response.image) {
      await attachGeneratedImage(assistant, response.image, response.model);
    }

    // finishReason === 'length' 是服务商权威的「撞上限」信号；只凭「正文为空 + 有思考」只能猜。
    // usage 留着，事后才核得清思考吃了多少、上限有没有生效。
    assistant.finishReason = response.finishReason || '';
    assistant.usage = response.usage || null;
    // 思考量跨请求累加：第一轮的量才是元凶，只留最后一次 usage 会漏
    let reasoningTokens = reasoningTokensOf(response.usage);

    if (!assistant.content && !assistant.reasoning) {
      throw new Error('接口没有返回任何内容。可能是模型名不对，或该模型不支持流式输出。');
    }

    const truncated = assistant.finishReason === 'length';
    const contentEmpty = !String(assistant.content || '').trim();

    // 情形一：只有思考、正文没写（推理模型会把 max_tokens 全花在思考上）；先自动重试一次要求直接写正文
    if (contentEmpty && String(assistant.reasoning || '').trim()) {
      const reasoningBefore = String(assistant.reasoning || '');

      // 界面上那条「正在思考」还挂着 —— 如实改成现在的状态
      const waitNode = el.messages.querySelector(`.msg[data-index="${index}"] .waiting`);
      if (waitNode) {
        waitNode.textContent = truncated ? '思考把篇幅用光了，正在重写正文…' : '它只思考没落笔，正在重写正文…';
      }

      const retryMessages = [...buildApiMessages(convo, worldbook, ragSection)];
      retryMessages.push({ role: 'user', content: REASONING_RETRY_NUDGE });

      throwIfGenerationStopped();
      const retryId = uid();
      state.requestId = retryId;
      const retry = await api.sendChat({
        requestId: retryId,
        providerId: endpoint.provider.id,
        model: endpoint.model,
        messages: retryMessages,
        characterContext: characterContextForConvo(convo),
        sampling: effectiveSampling(convo)
      });

      if (retry && retry.ok === true) {
        if (retry.usage) state.usage = retry.usage;
        reasoningTokens += reasoningTokensOf(retry.usage);
        // 分片已直接写进 assistant.content；服务商没推分片时才用整段返回兜底
        if (!String(assistant.content || '').trim() && String(retry.content || '').trim()) {
          assistant.content = retry.content;
        }
        assistant.reasoning = reasoningBefore + String(retry.reasoning || '');
        if (retry.finishReason) assistant.finishReason = retry.finishReason;
      }

      // 重试也没救回来才留提示文案，措辞区分「真截断」和「没落笔」
      if (!String(assistant.content || '').trim()) {
        // 不再挂 truncated 标记：这段提示本身就是给用户看的说明
        assistant.content =
          assistant.finishReason === 'length'
            ? '（模型只输出了思考过程，正文被截断了 —— 这一次的思考确实把「回复上限」用光了。）\n\n' +
              '点下面这条消息的「继续」让它接着写正文；想少踩这个坑可以把上限调大，' +
              '或者换一个不那么爱长篇思考的模型。'
            : '（模型思考完，正文一个字都没写 —— 这一次不是被长度上限截断，更像它自己没接上。）\n\n' +
              '点下面这条消息的「继续」，通常就能把它逼出来。';
      }
    } else if (!contentEmpty && truncated) {
      // 情形二：正文写一半撞上限；自动续写有限次（见 MAX_AUTO_CONTINUE），撞满就停
      const cont = await autoContinueTruncated(convo, index, endpoint, worldbook, ragSection);
      assistant.autoContinued = cont.rounds;
      reasoningTokens += cont.reasoningTokens;
      // 状态表在末尾最先被截掉；续写救回正文后照样补问一次（续写里带了会自动跳过）
      await ensurePanelWritten(convo, endpoint, worldbook, ragSection, assistant);
    } else if (!contentEmpty) {
      // 情形三：正文写完了但整轮没提状态字段；补问一次，多半能要回来
      await ensurePanelWritten(convo, endpoint, worldbook, ragSection, assistant);
    }

    if (reasoningTokens > 0) assistant.reasoningTokens = reasoningTokens;

    // 「这条被截断过」：收尾信号仍是 'length'，或自动续写救回过（autoContinued > 0）；空正文不叠这个标记
    if (!contentEmpty && (assistant.finishReason === 'length' || Number(assistant.autoContinued) > 0)) {
      assistant.truncated = true;
    }

    throwIfGenerationStopped();
    if (Array.isArray(assistant.variants)) {
      assistant.variants[assistant.variantIndex] = assistant.content;
    }
    completed = true;
  } catch (err) {
    const message = (err && err.message) || '未知错误';
    const stopped = /已停止生成/.test(message);

    // 扣过额度又一个字没吐出来（Key 填错 / 断网 / 厂商 4xx）：退回这一条
    if (options && options.charged && !(assistant && String(assistant.content || '').trim())) refundQuietly();

    // Regeneration is transactional: failure or cancellation restores the original history.
    if (options && options.rollback) {
      options.rollback();
      assistant = null;
      showToast(stopped ? '已停止生成，原对话已保留' : `重新生成失败，原对话已保留：${message}`, stopped ? undefined : 'error');
      return;
    }

    // 没生成出东西，那个占位的空候选要撤掉，不然会留下一条空白候选
    if (assistant && Array.isArray(assistant.variants)) {
      assistant.variants.pop();
      if (!assistant.variants.length) delete assistant.variants;
      else assistant.variantIndex = assistant.variants.length - 1;
    }

    if (stopped) {
      if (assistant && !assistant.content) {
        convo.messages.splice(index, 1);
      }
      showToast('已停止生成');
    } else {
      // 把失败的那条助手消息换成错误提示，并留一个「重试」按钮
      if (assistant) convo.messages.splice(index, 1);
      convo.messages.push({ role: 'error', content: message, at: now(), retryable: true });
    }
  } finally {
    if (!completed && options && options.rollback) options.rollback();
    if (options && options.rollback) endConversationReplacement(convo);
    if (waitingTimer) clearInterval(waitingTimer);
    streamPainter.stop();
    setStreaming(false);
    state.requestId = null;
    state.requestTarget = null;
    convo.updatedAt = now();
    // 抽出状态栏存到会话上，下一轮由程序权威注入（历史会被 maxTurns 截断）
    syncConvoPanel(convo);
    syncConvoOptions(convo);
    // 剧情改了你的名字，消息标签和 {{user}} 要跟着改
    syncPlayerNameFromPanel(convo);
    renderAll({ forceScroll: true });
    persistConversations();
    el.input.focus();

    // 攒够未压缩对话就后台压摘要；不 await，压缩要额外调一次模型
    if (completed && !generationStopped) maybeSummarize(convo).catch((err) => console.error('后台摘要失败', err));

    // 桌宠：回复还在会话里且正文非空才问它要不要插一句（出错/被停止那条已 splice 掉）。
    // 不 await —— 这是额外一次模型调用；轮数/静音等规则全在 maybePetAutoSpeak 里。
    if (completed && !generationStopped && convo.messages.includes(assistant) && String(assistant.content || '').trim()) {
      maybePetAutoSpeak().catch((err) => console.error('桌宠自动发言失败', err));
    }
  }
}

/** 重新生成：删掉这条之后的内容再问一次；老回复作为候选留着，可用「‹ 2/3 ›」翻回 */
export async function regenerateFrom(index) {
  const convo = activeConvo();
  if (!convo || state.streaming) return;

  // 重新生成不扣条数，但「今天已经用满」的人不能再白用模型
  if (!(await allowSend({ charge: false }))) return;

  // 第一次重新生成时，当前正文就是第一个候选
  const target = convo.messages[index];
  let existing = null;
  if (target && target.role === 'assistant' && String(target.content || '').trim()) {
    existing = Array.isArray(target.variants) ? target.variants.slice() : [String(target.content)];
  }

  let cut = Math.min(index, convo.messages.length - 1);
  while (cut >= 0 && convo.messages[cut].role !== 'user') cut -= 1;

  if (cut < 0) {
    showToast('找不到对应的提问，无法重新生成', 'error');
    return;
  }

  invalidateConvoDerivedRequests(convo);
  const originalMessages = convo.messages;
  const originalState = structuredClone(Object.fromEntries(Object.entries(convo).filter(([key]) => key !== 'messages')));
  beginConversationReplacement(convo, { ...originalState, messages: originalMessages });
  let restored = false;
  const rollback = () => {
    if (restored) return;
    restored = true;
    for (const key of Object.keys(convo)) if (key !== 'messages') delete convo[key];
    Object.assign(convo, originalState);
    convo.messages = originalMessages;
  };
  // Invalidate summaries while the original message still has its context index.
  if (target) invalidateSummariesForEdit(convo, target);
  convo.messages = convo.messages.slice(0, cut + 1);
  rebuildConvoDerivedState(convo, { priorMessages: originalMessages });
  state.usage = null;
  // Do not persist the destructive cut until the replacement succeeds.
  return requestCompletion(convo, { variants: existing, rollback });
}

/** 换候选（swipe）：改 content 就等于换了一条，历史/复制/导出都读 content */
export function switchVariant(index, delta) {
  const convo = activeConvo();
  if (!convo || state.streaming) return;

  const message = convo.messages[index];
  const list = message && Array.isArray(message.variants) ? message.variants : null;
  if (!list || list.length < 2) return;

  const current = Number.isFinite(message.variantIndex) ? message.variantIndex : 0;
  const next = (current + delta + list.length) % list.length;
  if (next === current) return;

  invalidateSummariesForEdit(convo, message);
  message.variantIndex = next;
  message.content = list[next];
  convo.updatedAt = now();

  // 不同候选里写的状态栏可能不一样，换完重新扫一遍
  syncConvoPanel(convo);
  syncConvoOptions(convo);
  renderAll({ forceScroll: false });
  persistConversations(0);
}

export async function stopGenerating() {
  // 只停聊天这一路 —— 后台摘要 / AI 生成角色这些不归「停止」按钮管
  if (state.streaming) {
    generationStopped = true;
    if (cancelPreparation) cancelPreparation();
  }
  if (state.requestId) {
    // 停止失败只意味着「那边可能已经自己结束了」，不该冒成未捕获异常
    try {
      await api.stopChat(state.requestId);
    } catch (err) {
      console.error('停止生成失败', err);
    }
  }
}
