'use strict';

// main.js —— 界面入口：画对话、发消息、流式打字机、存历史
// 依赖只能向下（core ← ui ← data ← views ← 入口），功能模块之间别互相 import。
// 只有「入口层才知道的编排」才用注入 —— initXxx({ theAction })。

import { api } from './core/api.js';
import { state } from './core/state.js';
import { el } from './core/dom.js';
import { activeConvo, asArray } from './core/util.js';

import { showToast } from './ui/toast.js';
import { applyTheme, applyAccent } from './ui/theme.js';
import { toggleModalMax, initModalMax } from './ui/modalMax.js';
import { esc } from './ui/markdown.js';
import { applyFieldIcons } from './ui/icons.js';
import { initMoreMenu } from './ui/menu.js';
import { initModelMenu } from './ui/modelMenu.js';
import { initSelects } from './ui/select.js';
import { defineComponents } from './components/index.js';

import { markCharactersLoaded, markWorldbooksLoaded, markPresetsLoaded, conversationsSavePayload, flushLibrariesNow } from './data/persist.js';
import { refreshPetCache, speakNow } from './data/petContext.js';
import { initPetSettings, openPetSection } from './views/petSettings.js';
import { currentEndpoint, isBridgeProvider } from './data/providers.js';
import { convoUserName, speakerName } from './data/cast.js';
import { characters, worldbooks, dialoguePresets } from './data/library.js';
import {
  normalizePanelDefs,
  cleanAssistantText,
  convoFieldDisplayNames,
  migrateConvoPanel,
  absorbTopLevelIntoPlayer,
  mergePlayerOwnedFields,
  panelGroupNames,
  cutTrailingStatusBlock
} from './data/panel.js';
import { createConvo } from './data/conversations.js';
import { isLoggedIn } from './data/account.js';

import { onRefresh } from './views/refresh.js';
import { initHeader } from './views/header.js';
import { initPerspectiveUi, closePerspectiveModal } from './views/perspectiveUi.js';
import { initRequestLog, closeRequestLog } from './views/requestLog.js';
import { closePlayerModal, applyPlayerCharChoice } from './views/player.js';
import { initMemoryUi, closeMemoryModal } from './views/memoryUi.js';
import { initPanelUi } from './views/panelUi.js';
import { initCastPanel } from './views/castPanel.js';
import { initStateCards } from './views/stateCard.js';
import { initPresetList } from './views/presetList.js';
import { initPresetIo, exportPreset } from './views/presetIO.js';
import {
  initPreset,
  openPresetEditor,
  newPreset,
  openPresetDraft,
  deletePresetById,
  closePresetEditor
} from './views/preset.js';
import { initSettings, setEditingProvider, openSettings, leaveSettings, closePersonaDialog, expandSettingsSection } from './views/settings.js';
import { initAppearance, applyChatAppearance } from './views/appearance.js';
import { initChatPad, syncChatPadHandles } from './views/chatPad.js';
import { streamPainter, initStreamFollow } from './views/stream.js';
import { initChatImages } from './views/chatImages.js';
import { initSuggestionsUi, pickOption } from './views/suggestionsUi.js';
import { initQuickPhrases } from './views/quickPhrases.js';
import { showView, refreshLibraryPage, initViewSwitch } from './views/viewSwitch.js';
// 侧栏左下角的账号格与账号弹窗：登录流程接好后在这里注入 openLogin
import { initAccount, renderAccount } from './views/account.js';
import {
  initAccountModal,
  openAccountModal,
  closeAccountModal,
  isAccountModalOpen
} from './views/accountModal.js';
// 设置页第一栏「用户信息」：账号资料 / 头像 / 密码 / 凭证
import { initUserSettings, renderUserSection } from './views/userSettings.js';
// 意见反馈弹窗：现在只是占位（没后端可发），点「发送」会诚实地说没发出去
import {
  initFeedbackModal,
  openFeedbackModal,
  closeFeedbackModal,
  isFeedbackModalOpen
} from './views/feedback.js';
import { initCharacterList } from './views/characterList.js';
import {
  initWorldbook,
  closeWorldbookCharPicker,
  leaveWorldbookEditor,
  stashWorldbookForm
} from './views/worldbook.js';
import {
  initCharacterEditor,
  openCharacterEditor,
  leaveCharacterEditor,
  closeWorldbookPicker,
  isWorldbookPickerOpen,
  startCharacterDraftInBook,
  startCharacterDraftFromAi,
  releaseEditorScope,
  stashCharacterForm,
  refreshCharWorldbookBox,
  deleteCharacterById,
  deleteCharactersByIds
} from './views/characterEditor.js';
import { initCharacterImport } from './views/characterImport.js';
import { initAiGen, openAiGenModal } from './views/aiGen.js';
import { initPresetAi, openPresetAiModal } from './views/presetAi.js';
import { renderAll } from './views/redraw.js';
import { renderConvoList, renderModelSwitch, applyModelChoice } from './views/chatList.js';
import { renderMessages, setOptionsLoading } from './views/chatMessages.js';
// 消息导航条（右缘刻度）：只绑一次事件，刻度由 renderMessages 重建时顺手刷。
import { initMsgRail } from './views/msgRail.js';
import {
  sendMessage,
  autoGrowInput,
  sentTextOf,
  clearInputAfterSend,
  stopGenerating
} from './views/composer.js';
import { clearConvo } from './views/convoActions.js';
import { summarizeNow } from './views/summarize.js';
import { exportCharacterById, exportConversation, exportCharactersByIds } from './views/chatExport.js';
import { startPlayerFlow, chatWithCharacter, playCharacterWorld } from './views/worldPlay.js';

// 事件监听器里跑异步动作：出错只落日志，避免变成 unhandled rejection。
function runAsync(action) {
  return () => {
    Promise.resolve()
      .then(action)
      .catch((err) => console.error('界面动作失败', err));
  };
}

/** 登记「谁需要被重绘」；顺序 = 绘制顺序。 */
function registerRefreshListeners() {
  onRefresh(renderConvoList);
  initHeader(); // → onRefresh(renderHeader)
  onRefresh(renderModelSwitch);
  initPanelUi(); // → onRefresh(renderPanel)
  initCastPanel(); // → onRefresh(renderCastPanel)
  initMemoryUi(); // → onRefresh(renderMemoryIndicator)
  onRefresh(renderMessages);
  initStateCards(); // → onRefresh(renderStateCards)
  onRefresh(refreshLibraryPage);
  // 预设列表同理：动作跨模块，由入口层注入。
  initPresetList({ openEditor: openPresetEditor, remove: deletePresetById, exportOne: exportPreset });
  // 预设编辑器保存 / 删除后要全量重绘（预设页、视角弹窗都可能跟着变）。
  initPreset({ rerender: () => renderAll() });
  // 预设页的「AI 生成」：生成完开一张填好的草稿 —— 和手建一样，保存才创建。
  initPresetAi({ startDraft: (fields) => openPresetDraft(fields) });
  initPresetIo({ rerender: () => renderAll() });
}

// ---- 事件绑定 ----

// Promise.all 任一读取失败时内存仍是初值，关窗不能拿它覆盖磁盘。
let startupDataLoaded = false;

function bindEvents() {
  // 版本号由 preload 递过来，格式化成 major.minor；拿不到就不显示。
  if (el.brandVersion) {
    const raw = String((window.mimitale && window.mimitale.appVersion) || '');
    const m = raw.match(/^(\d+)\.(\d+)/);
    if (m) {
      el.brandVersion.textContent = `v${m[1]}.${m[2]}`;
      el.brandVersion.classList.remove('hidden');
    }
  }

  // 栏头和顶栏入口共享原有收放状态。
  const applySidebarCollapsed = () => {
    const collapsed = !!(el.sidebar && el.sidebar.classList.contains('collapsed'));
    if (el.btnSidebarToggle) {
      const btn = el.btnSidebarToggle;
      btn.title = collapsed ? '展开侧栏' : '收起侧栏';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-expanded', String(!collapsed));
    }
  };
  const toggleSidebar = () => {
    if (!el.sidebar) return;
    el.sidebar.classList.toggle('collapsed');
    applySidebarCollapsed();
  };
  if (el.btnSidebarToggle) el.btnSidebarToggle.addEventListener('click', toggleSidebar);
  applySidebarCollapsed();

  // 「＋ 新对话」= 建空白会话并切到聊天屏；跟角色聊走角色库卡片上的「聊天」。
  el.btnNew.addEventListener('click', () => {
    if (state.streaming) {
      showToast('正在生成回答，先停止再新建会话');
      return;
    }
    createConvo(true);
    showView('chat');
    renderAll({ forceScroll: true });
  });

  /** 发消息统一入口：**先发再清**，只有真的发出去了才清空输入框。 */
  const submitInput = () => {
    const text = el.input.value;
    const sent = sentTextOf(text);
    return sendMessage(text)
      .then((didSend) => {
        if (didSend) clearInputAfterSend(sent);
        return didSend;
      })
      .catch((err) => {
        console.error('发送失败', err);
        showToast((err && err.message) || '发送失败', 'error');
        return false;
      });
  };

  el.btnSend.addEventListener('click', runAsync(() => {
    if (state.streaming) return stopGenerating();
    return submitInput();
  }));
  el.btnClear.addEventListener('click', runAsync(clearConvo));

  el.btnCopyAll.addEventListener('click', async () => {
    const convo = activeConvo();
    const messages = asArray(convo && convo.messages);
    if (!convo || !messages.length) {
      showToast('当前会话是空的');
      return;
    }
    // 通用助手没填名字时 speakerName 是空串，这里得有个称呼顶着
    const assistantLabel = speakerName(convo) || 'AI';
    const meLabel = convoUserName(convo);
    const text = messages
      .map((m) => {
        const role = m && m.role;
        const who = role === 'user' ? meLabel : role === 'error' ? '错误' : assistantLabel;
        return `${who}：${String((m && m.content) || '')}`;
      })
      .join('\n\n');
    try {
      await api.copyText(text);
      showToast('已复制整段对话', 'ok');
    } catch (err) {
      showToast(`复制失败：${(err && err.message) || '未知错误'}`, 'error');
    }
  });

  // 编辑器里的「导出」2026-10-20 撤了（角色库卡片右上角那颗就够），这里只剩会话导出
  el.btnExportConvo.addEventListener('click', runAsync(exportConversation));
  // 预设页右上角「＋ 新建预设」：打开空草稿（真正建出来要等点保存）
  if (el.btnNewPreset) el.btnNewPreset.addEventListener('click', newPreset);
  // 它左边那颗「AI 生成」：先弹一句描述，生成完走的也是预设编辑器草稿。
  if (el.btnAiPreset) el.btnAiPreset.addEventListener('click', openPresetAiModal);
  // 状态卡入口条不用在这里绑事件 —— 头像的点击由 views/panelUi.js 铺的时候就地挂上。

  // 记忆管理弹窗在 views/memoryUi.js；这里只留「手动压一段」。
  el.btnSummarizeNow.addEventListener('click', runAsync(summarizeNow));

  // 进入世界前创建玩家角色
  el.btnClosePlayer.addEventListener('click', closePlayerModal);
  el.btnCancelPlayer.addEventListener('click', closePlayerModal);
  el.btnStartPlay.addEventListener('click', startPlayerFlow);
  el.playerChar.addEventListener('change', applyPlayerCharChoice);
  el.playerModal.addEventListener('click', (event) => {
    if (event.target === el.playerModal) closePlayerModal();
  });

  // 主题配色 / 夜间模式在「外观」弹窗里，点击由 views/appearance.js 接。

  // ⚠️ ok:true 只代表 explorer.exe 起来了，不代表文件夹真弹出来了（见 main/ipc.js），
  //    所以路径无条件塞进剪贴板：真没弹出来，用户 Ctrl+L 一粘就进去了。
  el.btnFolder.addEventListener('click', async () => {
    let result = null;
    try {
      result = await api.openDataFolder('config');
    } catch (err) {
      showToast(`打不开数据文件夹：${(err && err.message) || '未知错误'}`, 'error');
      return;
    }
    const target = (result && result.path) || '';
    if (target) {
      // 剪贴板失败不该影响这条提示，所以单独吞掉
      try {
        await api.copyText(target);
      } catch (err) {
        console.warn('复制数据文件夹路径失败', err);
      }
    }
    if (result && result.ok === false) {
      console.error('打开数据文件夹失败', result.error);
      showToast(`打不开数据文件夹：${result.error || result.path}`, 'error');
      return;
    }
    if (target) {
      showToast(`数据文件夹：${target}（路径已复制 —— 窗口没弹出来的话，在资源管理器地址栏 Ctrl+V 回车）`, 'ok');
    }
  });

  // 必须逐个绑：tools/audit-buttons.js 按「el.xxx 同一行有 addEventListener」查漏绑。
  // 传按钮本身，模块靠 closest('.modal') 找所属弹窗，各弹窗互不影响。
  el.btnFsPreset.addEventListener('click', () => toggleModalMax(el.btnFsPreset));

  el.input.addEventListener('input', autoGrowInput);

  el.input.addEventListener('keydown', (event) => {
    // ⚠️ 输入法选词那下回车在 Chromium 里也报成 Enter（isComposing / keyCode 229），
    // 不挡会拿半截拼音发消息；两个判据都看，各家输入法不一致。
    if (event.isComposing || event.keyCode === 229) return;

    // 数字键 1~9 快捷选剧情选项：只在输入框为空、且无组合键时触发。
    if (event.key >= '1' && event.key <= '9' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const convo = activeConvo();
      const options = asArray(convo && convo.options);
      const idx = Number(event.key) - 1;
      if (!el.input.value.trim() && options[idx] && !state.streaming) {
        event.preventDefault();
        pickOption(convo, options[idx]);
        return;
      }
    }

    if (event.key !== 'Enter') return;
    const wantSend = state.settings && state.settings.sendOnEnter !== false;
    const withModifier = event.ctrlKey || event.metaKey;

    if (event.shiftKey) return; // Shift+Enter 永远换行

    if (wantSend && !event.altKey) {
      event.preventDefault();
      submitInput();
      return;
    }

    if (!wantSend && withModifier) {
      event.preventDefault();
      submitInput();
    }
  });

  // 全局快捷键 Ctrl+, = 打开设置（账号菜单里那颗「设置」右侧写的就是它，这里真认）。
  // 没做成快捷键表：项目里只有这一条全局键，为它造一层调度不划算。
  // 未登录时不响应 —— 设置只给登录用户，界面上也没有任何可见入口。
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key !== ',') return;
    event.preventDefault();
    if (!isLoggedIn()) return;
    openSettings();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 确认弹窗开着的时候，Esc 只关确认框，不要把手底下的弹窗一起关掉
    if (!el.confirmModal.classList.contains('hidden')) return;
    // 账号弹窗是最上面那层普通弹窗：先关它
    if (isAccountModalOpen()) {
      closeAccountModal();
      return;
    }
    if (isFeedbackModalOpen()) {
      closeFeedbackModal();
      return;
    }
    if (!el.requestsModal.classList.contains('hidden')) {
      closeRequestLog();
      return;
    }
    if (!el.playerModal.classList.contains('hidden')) {
      closePlayerModal();
      return;
    }
    if (!el.wbPicker.modal.classList.contains('hidden')) {
      closeWorldbookCharPicker();
      return;
    }
    // 「绑定世界书」浮层挂在 body 上、层级比编辑器高：先关它，别顺手把编辑器关了
    if (isWorldbookPickerOpen()) {
      closeWorldbookPicker();
      return;
    }
    // 角色编辑器是页面不是弹窗：Esc = 返回上一屏（同页头「返回」）。
    if (!el.viewCharEditor.classList.contains('hidden')) {
      leaveCharacterEditor();
      return;
    }
    // 人设弹窗压在设置之上：先关它，否则 Esc 会把设置页也一起离开。
    if (!el.personaModal.classList.contains('hidden')) {
      closePersonaDialog();
      return;
    }
    // 设置是页面不是弹窗：Esc = 返回上一屏。
    if (!el.viewSettings.classList.contains('hidden')) {
      leaveSettings();
      return;
    }
    // 世界书编辑器同样是**页面**而不是弹窗，判据跟着换。
    if (!el.viewWbEditor.classList.contains('hidden')) {
      leaveWorldbookEditor().catch((err) => console.error('离开世界书编辑器失败', err));
      return;
    }
    if (!el.pr.modal.classList.contains('hidden')) {
      closePresetEditor();
      return;
    }
    if (!el.memoryModal.classList.contains('hidden')) {
      closeMemoryModal();
      return;
    }
    if (!el.perspectiveModal.classList.contains('hidden')) {
      closePerspectiveModal();
    }
  });

  // 流式增量：chunkTarget 缓存写入节点，按 requestId 判失效；base / delta 拼显示文本。
  let chunkTarget = { requestId: null, node: null, base: '', delta: '' };

  api.onChunk(({ requestId, text }) => {
    if (requestId !== state.requestId) return;
    const target = state.requestTarget;
    if (!target) return;
    const { convo, assistant } = target;
    if (!state.conversations.includes(convo) || !convo.messages.includes(assistant) || assistant.role !== 'assistant') return;

    // ⚠️ 续写：旧正文末尾若是状态行 / 选项行且没换行，直接拼会黏成一条被整行剥掉，
    // 续写的头一行会凭空消失 —— 新流开始且旧正文没以换行收尾时先补一个 '\n'。
    const newStream = chunkTarget.requestId !== requestId;
    if (newStream && assistant.content && !assistant.content.endsWith('\n') && text && !text.startsWith('\n')) {
      assistant.content += '\n';
    }

    assistant.content += text;

    // 后台目标仍可收分片，但绝不绘制到另一个会话的同下标节点。
    if (state.activeId !== convo.id) {
      chunkTarget = { requestId, node: null, base: '', delta: '' };
      return;
    }

    // 缓存目标节点省掉每 token 的 DOM 查询；⚠️ 但必须认 isConnected：生成中一次整体重绘
    // 会让缓存节点成孤儿，分片写进去气泡就「卡住」，直到 finally 的 renderAll 才刷出来。
    if (chunkTarget.requestId !== requestId || !chunkTarget.node || !chunkTarget.node.isConnected) {
      const index = convo.messages.indexOf(assistant);
      // 基准 = 本轮之前的完整正文，用 cleanAssistantText 剥掉旧状态块；
      // 重绘后重查同一条路：assistant.content 减去本轮 text 即基准，delta 归零。
      const before = assistant.content.slice(0, assistant.content.length - text.length);
      chunkTarget = {
        requestId,
        node: el.messages.querySelector(`.msg[data-index="${index}"] .msg-content`),
        base: cleanAssistantText(before, convoFieldDisplayNames(convo), [...panelGroupNames(convo)]),
        delta: ''
      };
    }

    // 显示 = base + delta。不能直接 clean 整段：半截字段行匹配不上正则会闪；
    // 也不能从整段砍状态块（续写时会误砍夹在中间的正文），所以只砍 delta 的尾部。
    chunkTarget.delta += text;
    // 带上本局面板字段名 / 分组名：只有真字段与已知分组标题才砍 ——
    // 内心描写【心理】【旁白】、破折号起头的正文都不能被当成状态块吞掉。
    const display =
      chunkTarget.base +
      cutTrailingStatusBlock(chunkTarget.delta, convoFieldDisplayNames(convo), [...panelGroupNames(convo)]);
    streamPainter.push(chunkTarget.node, display);
  });

  api.onReasoning(({ requestId, text }) => {
    if (requestId !== state.requestId) return;
    const target = state.requestTarget;
    if (!target) return;
    const { convo, assistant } = target;
    if (!state.conversations.includes(convo) || !convo.messages.includes(assistant) || assistant.role !== 'assistant') return;
    assistant.reasoning = (assistant.reasoning || '') + text;
  });

  window.addEventListener('beforeunload', (event) => {
    if (!startupDataLoaded) return;
    try {
      const saved = api.saveConversationsNow(conversationsSavePayload());
      if (saved && typeof saved.catch === 'function') saved.catch(() => {});
    } catch (err) {
      event.preventDefault();
      event.returnValue = '';
      console.error('关窗前保存会话失败', err);
      showToast(`会话保存失败，窗口暂不关闭：${err.message || err}`, 'error');
    }
    try {
      flushLibrariesNow();
    } catch (err) {
      event.preventDefault();
      event.returnValue = '';
      console.error('关窗前保存库失败', err);
      showToast(`保存失败，窗口暂不关闭：${err.message || err}`, 'error');
    }
  });
}

// ---- 启动 ----

async function init() {
  // ⚠️ 必须抢在第一次渲染之前注册：组件元素进文档那一刻 upgrade，晚注册就停在「未知元素」。
  defineComponents();
  bindEvents();
  // 静态 HTML 里带 data-icon 的标签启动时挂一次；动态渲染的要自己再调一次。
  applyFieldIcons();
  // 原生 <select> 原地留着当值的地基，这里只换列表皮肤：读 .value / 监听 'change' 不用改。
  initSelects();
  // 必须在第一次 renderAll 之前登记，否则首屏一个视图都不会画。
  registerRefreshListeners();
  // 只绑事件、不参与整体重绘的模块；顶栏「⋯」菜单是纯开关（见 ui/menu.js）。
  initMoreMenu();
  // 顶栏「切换模型」弹层：内容由 renderModelSwitch 铺，选中后走 onPick（不互相 import）。
  initModelMenu({ onPick: applyModelChoice });
  initPerspectiveUi();
  // 「请求记录」：只读主进程内存、打开时现拉；不碰 state、不落盘。
  initRequestLog();
  // 外观弹窗同理：改完即时生效 + 落盘，没有需要整体重绘的 DOM。
  initAppearance();
  // 对话区宽度（顶栏弹层 + 消息流两侧的抓手）：UI 和接线都在 views/chatPad.js。
  initChatPad();
  // 弹窗「放大」状态：关弹窗时自动摘掉，下次打开回到正常大小。
  initModalMax();
  // 「用户在看历史就别自动跟随」挂在消息区上，自己绑自己。
  initStreamFollow();
  // 右缘的消息导航条：这里只绑事件（滚轮 / 悬停 / 缩放），刻度由 renderMessages 重建。
  initMsgRail();
  // 加图按钮自己绑；配图成功后要重绘对话区、没配生图要弹设置 —— 都是入口层的动作。
  initChatImages({
    rerender: (opts) => renderAll(opts),
    // 未登录没有设置可进：直接把人引到登录窗（生图本来也要登录后才有地方配）
    openSettings: () => (isLoggedIn() ? openSettings() : openAccountModal())
  });
  // 剧情选项：选用选项 = 发一条消息（入口层编排）。「帮我想想」也走这条路。
  // setOptionsLoading 由选项块自己提供（它才知道那块 DOM 在哪），这里只是转手注入。
  initSuggestionsUi({
    send: sendMessage,
    setOptionsLoading
  });
  // 快捷短语面板：只往输入框里插，不发送。
  initQuickPhrases();
  // 侧边栏的「角色库 / 世界书」入口自己绑（切屏是 viewSwitch 自己的事）。
  initViewSwitch();
  // 账号：登录成功后弹窗自己关掉，侧栏那一格和设置页「用户信息」都要跟着变。
  initAccountModal({
    onSessionChange: (user) => {
      renderAccount(user);
      if (user) renderUserSection();
    }
  });
  initUserSettings({ openLogin: () => openAccountModal(), onUserChange: renderAccount });
  initFeedbackModal();
  // 左下角那一格：未登录点开登录窗，已登录点开菜单（设置 / 意见反馈 / 退出登录）。
  // ⚠️ 菜单里的「设置」直接落到「用户信息」那一组 —— 用户点自己的头像再看设置，
  //    想看的是自己的资料，不是上次停在的模型配置。
  initAccount({
    openLogin: () => openAccountModal(),
    openSettings: () => openSettings('sec-user'),
    openFeedback: () => openFeedbackModal(),
    // 退出登录后设置页不该还留在屏幕上（未登录没有设置）
    afterLogout: () => {
      if (!el.viewSettings.classList.contains('hidden')) leaveSettings();
    }
  }).catch((err) => console.error('读取登录状态失败', err));
  // 角色卡四个按钮都跨分区，动作由入口层交给列表页。
  initCharacterList({
    edit: (id) => openCharacterEditor(id, 'library'),
    chat: chatWithCharacter,
    // 卡上那条「进入世界」：用卡自带的世界书开一局 GM
    playWorld: playCharacterWorld,
    remove: deleteCharacterById,
    // 单张导出（列表卡片上用）和批量导出（每张一个 JSON）都跨模块，见各自模块的文件头
    exportOne: exportCharacterById,
    removeMany: deleteCharactersByIds,
    exportMany: exportCharactersByIds
  });
  // 角色编辑器自己绑弹窗里的按钮；它保存 / 删除之后要全量重绘，那是入口层的编排。
  initCharacterEditor({ rerender: () => renderAll() });
  // AI 生成角色 / NPC：生成完交给编辑器开新草稿，看过、改过、保存才真正创建。
  initAiGen({
    startDraft: (fields, scope, bookId) => startCharacterDraftFromAi(fields, scope, bookId)
  });
  // 导入通道：导完打开第一个新角色（那是编辑器的事），导入前先收一回编辑器里填的内容。
  initCharacterImport({
    openEditor: (id) => openCharacterEditor(id, 'library'),
    stashForm: () => stashCharacterForm()
  });
  // 世界书编辑器要切「角色编辑器作用域」再开编辑器，动作由入口层注入。
  initWorldbook({
    stashDraft: () => stashWorldbookForm(),
    openInBook: (id) => openCharacterEditor(id, 'worldbook'),
    draftInBook: () => startCharacterDraftInBook(),
    releaseScope: () => releaseEditorScope(),
    // 「AI 生成 NPC」：带上这本书的 id，生成时拿它的条目和副本名单当上下文
    aiDraftInBook: (bookId) => openAiGenModal({ scope: 'worldbook', bookId }),
    // 从角色编辑器点行上的「编辑」跳过来逛一圈、再「返回」：那行「已绑世界书」
    // 可能已经被改名 / 加过条目，按最新数据重画一遍（不然还挂着旧的 N 条）
    afterLeave: (view) => {
      if (view === 'charEditor') refreshCharWorldbookBox();
    }
  });
  // 设置页保存后要重绘右上角切换器和消息列表，所以注入进去。
  initSettings({
    refreshModelSwitch: () => renderModelSwitch(),
    afterSettingsSave: () => {
      renderModelSwitch();
      renderMessages({ forceScroll: false });
    }
  });

  // 桌宠：设置页那块和右键菜单走同一条路（组上下文 → 生成 → 推给宠物窗口），
  // 所以注入入口层的 speakNow，别让视图自己去 import 数据层。
  initPetSettings({ speakNow });

  // 主进程不知道「现在聊到哪了」，所以右键菜单是反着的：
  // 主进程通知界面 → 界面组好上下文再发回去。
  api.onPetWantSpeak((payload) => {
    speakNow(payload && payload.reason === 'manual' ? 'manual' : 'auto').catch((err) =>
      console.error('桌宠发言失败', err)
    );
  });

  api.onPetOpenSettings((payload) => {
    // 设置只给登录用户：未登录时桌宠菜单里那几项没有可看的东西
    if (!isLoggedIn()) return;
    openSettings();
    const focus = (payload && payload.focus) || '';
    // 「查看记忆」要直接滚到桌宠那块 —— 折叠着的卡片 scrollIntoView 滚不到位。
    if (focus === 'memory') expandSettingsSection('pet-section');
    openPetSection(focus).catch((err) =>
      console.error('打开桌宠区块失败', err)
    );
  });

  // 开局先拉一份桌宠状态，不拉第一轮会被跳过；失败不影响任何事。
  refreshPetCache().catch(() => {});

  // ---- 启动数据：五份互不依赖，并行去取 ----
  // 世界书 / 预设读失败不拦启动（但要记住没读到），其余三份失败 = 启动失败。
  const soft = (p) => p.then(
    (r) => ({ ok: true, r }),
    (err) => ({ ok: false, err })
  );
  const [config, storedChars, books, presets, stored] = await Promise.all([
    api.getSettings(),
    api.getCharacters(),
    soft(api.getWorldbooks()),
    soft(api.getPresets()),
    api.getConversations()
  ]);

  state.settings = config.settings;
  state.presets = asArray(config.presets);
  // 迁移告知取走即清空，只有启动这次拿得到。
  // ⚠️ 先存着、等 init 末尾再弹：下面「填 API Key」那条会把它顶掉。
  const settingsNotices = asArray(config.notices);
  setEditingProvider(state.settings.activeProviderId);

  // 主题以设置里的值为准（preload 已经按启动参数先打过一次，这里只是对齐）
  applyTheme(state.settings.theme);
  // 配色方案同理（默认 amber；preload 已先打标记）
  applyAccent(state.settings.accent);
  applyChatAppearance();
  // ⚠️ initChatPad() 跑在 state.settings 赋值之前，那时只读得到默认值，抓手会停在 20px；
  // 这里按真实内缩值再摆一次，否则「一重启抓手就回到默认位置」。
  syncChatPadHandles();

  state.characters = asArray(storedChars && storedChars.characters);
  try { markCharactersLoaded(); } catch (err) {
    console.error('角色记录 ID 无效，本次禁用保存', err);
    showToast('角色记录 ID 无效，本次不会写回它，请先备份并修复数据', 'error');
  }

  // ⚠️ 世界书读不到要记住没读到，否则之后存一次角色就把 worldbooks.json 覆盖成空。
  if (books.ok) {
    state.worldbooks = asArray(books.r && books.r.worldbooks);
    try { markWorldbooksLoaded(); } catch (err) {
      console.error('世界书记录 ID 无效，本次禁用保存', err);
      showToast('世界书记录 ID 无效，本次不会写回它，请先备份并修复数据', 'error');
    }
  } else {
    console.error('读取世界书失败', books.err);
    showToast('世界书没能读出来，本次不会写回它（重启试试）', 'error');
  }

  // 预设同理：读失败要记住，否则之后存一次预设就把文件写空了
  if (presets.ok) {
    state.dialoguePresets = asArray(presets.r && presets.r.presets);
    try { markPresetsLoaded(); } catch (err) {
      console.error('预设记录 ID 无效，本次禁用保存', err);
      showToast('预设记录 ID 无效，本次不会写回它，请先备份并修复数据', 'error');
    }
  } else {
    console.error('读取预设失败', presets.err);
    showToast('预设没能读出来，本次不会写回它（重启试试）', 'error');
  }

  state.conversations = asArray(stored.conversations);
  state.activeId = stored.activeId || null;

  // 读盘进来的字段定义不可信（手改 / 老版本写的），过一遍归一化。
  for (const convo of state.conversations) {
    if (!convo || typeof convo !== 'object') continue;
    // ⚠️ 先迁移再归一化，顺序不能反：migrate 要从老格式 defs[name].owner 读归属，
    // 归一化后键变成复合键就取不到 owner 了（见 data/panel.js）。
    migrateConvoPanel(convo);
    if (convo.panelDefs !== undefined) convo.panelDefs = normalizePanelDefs(convo.panelDefs);
    // 老会话里 owner 为空的字段当场认领（归角色或并回主角），幂等。
    absorbTopLevelIntoPlayer(convo);
    // 「玩家挑的卡」和世界书同名副本撞了 → 并回「我」，同一个人只留一张卡（幂等）。
    mergePlayerOwnedFields(convo);
    // summaryBusy 是**纯运行态**（摘要请求正在跑），但它长在 convo 上，保存时整个会话
    // 对象一起写进 conversations.json。关窗 / 崩溃正好卡在摘要中途，磁盘上就留下 true，
    // 重开后头部常驻「正在整理记忆…」、记忆面板的「立即压缩」和「重新生成」永久禁用，
    // 界面上没有任何地方能把它解开。所以读盘时一律清掉 —— 真在跑的摘要属于当前进程，
    // 重新打开时它早就不存在了。
    delete convo.summaryBusy;
    // 选项是程序写进去的，读盘时只要保证形状对（不是数组就当没有）
    if (!Array.isArray(convo.options)) convo.options = [];
    // 剧情选项跟对话框走、默认开 4 条；老会话读盘时补一次（快照语义：false=关、已配过的不动）。
    if (convo.optionsSpec == null) {
      convo.optionsSpec = { count: 4, hint: '' };
    }
    // 预设绑定：数组 = 手动配过（空数组 = 显式「一条都不要」）；
    // 非空字符串 = 老数据，迁成一条；其它/缺失 = null，自动跟随全局预设。
    if (Array.isArray(convo.dialoguePresetIds)) {
      convo.dialoguePresetIds = convo.dialoguePresetIds
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim());
    } else if (typeof convo.dialoguePresetId === 'string' && convo.dialoguePresetId.trim()) {
      convo.dialoguePresetIds = [convo.dialoguePresetId];
    } else {
      convo.dialoguePresetIds = null;
    }
    delete convo.dialoguePresetId;
  }

  if (!state.conversations.length) {
    createConvo(true);
  } else if (!state.conversations.some((c) => c.id === state.activeId)) {
    state.activeId = state.conversations[0].id;
  }

  startupDataLoaded = true;
  renderAll({ forceScroll: true });
  el.input.focus();

  const endpoint = currentEndpoint();
  const needsKeyHint = !endpoint || (!endpoint.provider.apiKey && !isBridgeProvider(endpoint.provider));
  if (needsKeyHint) {
    setTimeout(() => showToast('先点左下角「设置」填入 API Key 就能聊了'), 500);
  }

  // 迁移告知排在「填 API Key」之后，给更长显示时间 —— 一次性内容，一闪而过等于没说。
  if (settingsNotices.length) {
    setTimeout(() => showToast(settingsNotices.join('　'), undefined, { durationMs: 9000 }),
      needsKeyHint ? 4200 : 600);
  }
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#ff9a9a">
    启动失败：${esc((err && err.message) || err)}
  </div>`;
});
