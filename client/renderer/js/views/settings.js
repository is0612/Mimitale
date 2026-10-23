// 设置页：左侧分组导航 + 右侧内容（服务商编辑 / 生成参数 / 生图 / 语义检索 / 桌宠 / 外观）。
// 导出 openSettings / leaveSettings / expandSettingsSection；模型切换器与「保存后重绘消息」由入口层注入。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { activeConvo, asArray } from '../core/util.js';
import { el } from '../core/dom.js';
import { h, clear } from '../ui/build.js';
// 下拉框铺选项的规范件（清空 → 铺 → 定值 → 空了就禁用）。见 ui/controls.js
import { fillSelect } from '../ui/controls.js';
// 桌宠区块（单向 import，不成环）
import { openPetSection } from './petSettings.js';
// 外观那一组（见 index.html 的 #sec-appearance），同样单向 import
import { renderAppearanceForm } from './appearance.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { providers, providerById, isBridgeProvider } from '../data/providers.js';
import { renderHeader } from './header.js';
// 视图切换（单向：它只登记显隐/高亮，不认识本模块）
import { showView, currentViewName } from './viewSwitch.js';
import {
  catalogForBaseUrl,
  imageCatalogModels,
  looksLikeUnsupportedModelList,
  preferImageModel,
  fillImageSizeOptions
} from './settingsCatalog.js';

/** 设置页里当前正在编辑的服务商 */
let editingProviderId = null;

/** 默认人设弹窗里，字段中那份草稿属于哪个模型（换编辑对象时的脏检查要靠它） */
let personaShownModel = '';

/**
 * 进设置页之前停在哪一屏：保存 / 返回 / Esc 都回到它，别让它变成永远回聊天。
 */
let returnView = 'chat';

// --- 入口层注入的重绘动作 ---
// refreshModelSwitch()：模型切换器；afterSettingsSave()：保存后连带重绘消息（日期分隔、配图按钮跟着设置走）。
let refreshModelSwitch = () => {};
let afterSettingsSave = () => {};

export function initSettings(opts = {}) {
  if (typeof opts.refreshModelSwitch === 'function') refreshModelSwitch = opts.refreshModelSwitch;
  if (typeof opts.afterSettingsSave === 'function') afterSettingsSave = opts.afterSettingsSave;

  el.btnSettings.addEventListener('click', openSettings);
  // 「返回」= 不保存直接走
  el.btnBackSettings.addEventListener('click', leaveSettings);
  el.btnSaveSettings.addEventListener('click', () => saveSettings(false));
  el.btnTest.addEventListener('click', testConnection);
  el.btnFetchModels.addEventListener('click', fetchModels);
  document.addEventListener('mimitale:generation-settings-changed', () => {
    const s = state.settings || {};
    el.s.temp.value = s.temperature ?? 0.7;
    el.s.maxTokens.value = s.maxTokens ?? 8192;
    el.s.topP.value = s.topP ?? 0.95;
    el.s.thinking.checked = s.thinking !== false;
  });
  for (const [key, input] of [['temperature', el.s.temp], ['maxTokens', el.s.maxTokens], ['topP', el.s.topP], ['thinking', el.s.thinking]]) {
    input?.addEventListener('change', async () => {
      const value = key === 'thinking' ? input.checked : Number(input.value);
      if (key !== 'thinking' && (!input.value.trim() || !Number.isFinite(value))) return;
      try {
        const saved = await api.saveSettings({ [key]: value });
        state.settings = saved;
        // 越界值由主进程归一化夹回合法范围（温度 0–2 / top_p 0–1 / 回复上限 64–32000）。
        // 不说一句的话，输入 99 会悄悄变成 2，用户只会觉得「我填的东西被吃了」。
        const stored = saved[key];
        if (key !== 'thinking' && Number(stored) !== value) {
          showToast(`超出允许范围，已按 ${stored} 保存`, 'ok');
        }
        document.dispatchEvent(new CustomEvent('mimitale:generation-settings-changed'));
      } catch (err) { showToast((err && err.message) || '生成参数保存失败', 'error'); }
    });
  }

  // 换服务商 → 模型下拉跟着换（新服务商的列表里没有老模型，所以从第一个开始）
  el.s.imageProvider.addEventListener('change', () => {
    const provider = providerById(el.s.imageProvider.value);
    // 并上内置生图模型：服务商列表里往往只有文本模型，不并就选不到 glm-image
    fillModelSelect(
      el.s.imageModel,
      el.s.imageProvider.value,
      '',
      '（先在左边选一个提供商）',
      false,
      imageCatalogModels(el.s.imageProvider.value)
    );
    preferImageModel(provider);
    // 换了模型，尺寸的可选项也要跟着换
    fillImageSizeOptions(el.s.imageModel.value, el.s.imageSize.value);
  });

  // 换生图模型 → 尺寸可选项跟着换（不同模型支持的尺寸不一样）
  el.s.imageModel.addEventListener('change', () => {
    fillImageSizeOptions(el.s.imageModel.value, el.s.imageSize.value);
  });

  el.s.embeddingProvider.addEventListener('change', () => {
    fillModelSelect(el.s.embeddingModel, el.s.embeddingProvider.value, '', '（先在上面选一个提供商）', false);
  });

  // 「第三方模型提供商」展开预设列表
  el.btnAddProvider.addEventListener('click', () => {
    const hidden = el.providerPresets.classList.toggle('hidden');
    el.btnAddProvider.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });

  el.btnDelProvider.addEventListener('click', removeProvider);

  // 默认人设：设置页里只有一行入口，正文放在弹窗里编辑
  el.btnAssistantPersona.addEventListener('click', openPersonaDialog);
  el.btnClosePersona.addEventListener('click', closePersonaDialog);
  el.btnCancelPersona.addEventListener('click', closePersonaDialog);
  el.btnSavePersona.addEventListener('click', savePersonaDialog);
  el.btnPersonaTemplate.addEventListener('click', applyPersonaTemplate);
  // 换「给哪个模型」= 换编辑对象，字段整个重灌一遍
  el.persona.model.addEventListener('change', switchPersonaModel);
  el.personaModal.addEventListener('click', (event) => {
    if (event.target === el.personaModal) closePersonaDialog();
  });

  // 分组导航：监听挂在**设置这一屏**上（不是 document），事件不会跑到别处去。
  el.viewSettings.addEventListener('click', (event) => {
    const nav = event.target.closest ? event.target.closest('.settings-nav-item') : null;
    if (!nav) return;
    const target = nav.getAttribute('data-target');
    if (target) showSettingsSection(target);
  });

  // 勾选框一动就重算头部统计（「已开 3 / 8 项」）；挂 change 而不是 click，键盘空格也要跟着更新。
  el.viewSettings.addEventListener('change', (event) => {
    const target = event.target;
    if (target && target.matches && target.matches('input[type="checkbox"]')) renderSectionStats();
  });
}

/** 启动时把「当前服务商」带进设置弹窗（入口层拿到配置之后调） */
export function setEditingProvider(id) {
  editingProviderId = id || null;
}

// 分组导航：一个版块 = 一组，点左栏只显示那一组。当前选中不落盘（只是「刚才翻到哪了」），
// 但同一次运行里离开再进来会回到原样（currentSectionId）。

/** 这次运行里选中哪一组（存 section 的 id）。默认第一组「模型服务」 */
let currentSectionId = 'sec-models';

/** 切到某一组：左栏高亮、右栏只显示对应卡片、内容滚回顶部。id 不认识就什么都不做。 */
export function showSettingsSection(id) {
  if (!id) return;
  const section = el.viewSettings.querySelector(`#${id}`);
  if (!section) return;

  currentSectionId = id;

  for (const item of el.viewSettings.querySelectorAll('.settings-nav-item')) {
    const on = item.getAttribute('data-target') === id;
    item.classList.toggle('active', on);
    // aria-current 的合法值里没有「false」：不选中就是**移除**这个属性，写 false 是无效值。
    if (on) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  }

  for (const box of el.viewSettings.querySelectorAll('.settings-content > .panel-section')) {
    box.classList.toggle('hidden', box.id !== id);
  }

  // 换了一组 = 换了一页内容，滚动条回到顶部（否则会保留上一组的滚动位置）
  const content = el.viewSettings.querySelector('.settings-content');
  if (content) content.scrollTop = 0;

  // 切到「外观」时回填一次：它读的是内存里的设置，不填会留着上一次的颜色。
  if (id === 'sec-appearance') renderAppearanceForm();
}

/** 兼容名：外部一直按这个名字调用，语义是「切到那一组」 */
export function expandSettingsSection(id) {
  showSettingsSection(id);
}

/** 切到设置页时按记下的那一组铺一遍（内容是进屏时刷的，这里只管选中态 / 显隐） */
function syncSettingsSection() {
  showSettingsSection(currentSectionId || 'sec-models');
  // 头部统计读的是刚填好的表单 / 服务商列表，必须排在 fillSettingsForm 和切屏之后。
  renderSectionStats();
}

// --- 设置表单 ---

/** 填一个「模型」下拉：模型来自对应服务商的「可用模型」。keepMissing：保存过的模型不在列表里时
 *  补一个选项（打开设置 true，主动换服务商 false）。catalogModels：可选，把内置目录模型并进来。 */
function fillModelSelect(select, providerId, current, emptyHint, keepMissing = true, catalogModels = null) {
  const provider = providerById(providerId);
  const models = provider && Array.isArray(provider.models) ? provider.models.filter(Boolean) : [];
  const extra = (Array.isArray(catalogModels) ? catalogModels : []).filter((m) => m && !models.includes(m));
  const all = [...models, ...extra];
  const value = String(current || '').trim();

  if (!all.length) {
    fillSelect(select, [], { emptyText: emptyHint });
    return;
  }

  const items = [];
  // 存过的值不在列表里也保留，别让用户的选择凭空消失；它要排最前面，所以不包 group。
  if (keepMissing && value && !all.includes(value)) items.push({ value, text: `${value}（不在列表里）` });
  for (const model of models) items.push({ value: model, text: model });
  for (const model of extra) items.push({ value: model, text: `${model}（内置）` });

  // 有保存过的就用它；没有就挑第一个，别让下拉是空的（这条口径在 fillSelect 里）
  fillSelect(select, items, { prefer: value || all[0] });
}

// ------------------------------ 默认人设 ------------------------------

/** 「默认人设」按**模型名**存：这里算「生效时取哪一条」（会话自己的模型优先，没有会话
 *  才退回当前模型）；弹窗正在编辑的是哪条由 editingAssistantModel() 另算。 */
function defaultAssistantModel() {
  const convo = activeConvo();
  const own = convo && String(convo.model || '').trim();
  if (own) return own;
  return String((state.settings || {}).activeModel || '').trim();
}

/** 设置里的默认人设表（形状不对就当空的） */
function assistantPersonaMap(settings) {
  const map = (settings || {}).assistantPersonas;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

/** 弹窗「给哪个模型」下拉的可选项 = 顶栏能选到的那些（按服务商分组）。want 是会话记着但
 *  服务商列表里已删的模型，也必须能选中，否则会静默落到别的模型上。 */
function fillPersonaModelOptions(want) {
  const select = el.persona.model;
  if (!select) return;

  const groups = [];
  const seen = new Set();
  let hasWant = false;

  for (const provider of providers()) {
    const models = [];
    for (const raw of asArray(provider.models)) {
      const model = String(raw || '').trim();
      if (!model || seen.has(model)) continue;
      seen.add(model);
      if (model === want) hasWant = true;
      models.push(model);
    }
    if (models.length) groups.push({ name: provider.name || '未命名提供商', models });
  }

  clear(select);
  // 选不中的那个模型单独放最前面，别让它藏进某个服务商的分组里
  if (want && !hasWant) select.appendChild(h('option', { value: want, text: want }));

  for (const group of groups) {
    const box = document.createElement('optgroup');
    box.label = group.name;
    for (const model of group.models) {
      box.appendChild(h('option', { value: model, text: model }));
    }
    select.appendChild(box);
  }

  if (select.options.length) {
    const hasOption = [...select.options].some((o) => o.value === want);
    select.value = hasOption ? want : select.options[0].value;
  }
}

/** 弹窗现在编辑的是哪个模型（下拉框说了算；下拉框还没铺出来时才退回默认口径） */
function editingAssistantModel() {
  const select = el.persona.model;
  const picked = select && String(select.value || '').trim();
  return picked || defaultAssistantModel();
}

/** 把下拉框选中那个模型的人设灌进弹窗字段，并刷新设置页入口摘要。打开设置 / 打开弹窗 /
 *  关弹窗 / 换编辑对象都要调；关弹窗时调 = 丢掉没保存的改动。target 传值则强制换对象。 */
function syncPersonaFields(settings, target) {
  const source = settings || state.settings || {};
  fillPersonaModelOptions(target === undefined ? editingAssistantModel() : target);

  const model = editingAssistantModel();
  const entry = model ? assistantPersonaMap(source)[model] || {} : {};

  el.persona.name.value = entry.name || '';
  el.persona.text.value = entry.persona || '';
  // 记下这份草稿属于谁：change 时下拉框已是新值，再问会问到新模型上，脏检查就成了假阳性。
  personaShownModel = model;

  updatePersonaHint(source);
}

/** 「模型服务」里那行入口右侧的状态说明：**当前在用的**那个模型到底配没配 */
function updatePersonaHint(settings) {
  const source = settings || state.settings || {};
  const model = defaultAssistantModel();

  if (!model) {
    el.assistantHint.textContent = '还没选模型 —— 先在顶栏选一个';
    return;
  }

  const entry = assistantPersonaMap(source)[model] || {};
  const name = String(entry.name || '').trim();
  const hasText = !!String(entry.persona || '').trim();

  // 顺手说一句「还存着别的模型的人设」：否则用户会以为人设只跟当前模型绑死。
  const configured = Object.keys(assistantPersonaMap(source)).length;
  const others = configured - (name || hasText ? 1 : 0);
  const tail = others > 0 ? ` · 另有 ${others} 个模型配过` : '';

  // 说清生效范围：这份人设只管没绑角色卡、也没进世界的通用对话。
  el.assistantHint.textContent =
    (name || hasText
      ? `「${model}」已设置：${name || '（没写名字）'}`
      : `「${model}」未设置，是通用助手`) +
    ' · 只用于没绑角色卡的对话' +
    tail;
}

/** 弹窗字段里这份草稿跟已保存的那份有没有差别（换编辑对象前要据此问一句） */
function personaDraftDirty() {
  if (!personaShownModel) return false;

  const entry = assistantPersonaMap(state.settings)[personaShownModel] || {};
  return (
    el.persona.name.value.trim() !== String(entry.name || '').trim() ||
    el.persona.text.value.trim() !== String(entry.persona || '').trim()
  );
}

/** 换编辑对象：把另一个模型那一份重新灌进字段 */
async function switchPersonaModel() {
  if (!personaDraftDirty()) {
    syncPersonaFields();
    return;
  }

  // 草稿只活在字段里（没有按模型分别暂存），所以换对象前先把话说清楚
  const from = personaShownModel;
  const ok = await confirmDialog({
    title: '换一个模型编辑',
    message: `「${from}」这份还没保存，切走就丢了。继续吗？`,
    confirmText: '丢掉并切换'
  });

  if (ok) {
    syncPersonaFields();
    return;
  }

  // 不切了：下拉框退回原来那个，字段里还是刚才那份草稿（本来就没动过）
  el.persona.model.value = from;
}

function openPersonaDialog() {
  // 先把服务商表单收进内存：用户可能刚敲了新模型名还没保存，不收下拉框里就没有它。
  stashProviderForm();
  syncPersonaFields();
  el.personaModal.classList.remove('hidden');
  el.persona.text.focus();
}

export function closePersonaDialog() {
  // 从 settings 重新回填 = 丢掉没保存的改动
  syncPersonaFields();
  el.personaModal.classList.add('hidden');
}

async function savePersonaDialog() {
  if (!editingAssistantModel()) {
    showToast('先在顶栏选一个模型，人设才知道该存给谁', 'error');
    return;
  }

  // 走和设置页同一条保存链路（白名单 / 归一化 / 重绘都在里面）；silent=true 不关设置页、不弹「已保存」。
  const savedModel = personaShownModel || editingAssistantModel();
  const prev = state.settings;
  // 保存失败时别关弹窗：关了等于把用户刚写的草稿一起丢掉。
  if (!(await saveSettings(true))) return;
  closePersonaDialog();

  // 保存成功才会换成一个新对象（见 saveSettings 里的赋值）
  if (state.settings !== prev) showToast(`已保存「${savedModel}」的默认人设`, 'ok');
}

/** 「套用聊天风格模板」的正文：只讲说话方式、不设定人格。默认对话的 system 提示词只有
 *  用户写的这段，不写清楚模型就退回「完成模式」，读起来像在填表格。 */
const PERSONA_TEMPLATE = [
  '（在这里写「你是谁」：名字、性格、说话习惯 —— 想怎么设定都行。写完可以把这一行删掉。）',
  '',
  '【说话方式】',
  '- 像跟朋友聊天那样自然：可以不完整、可以插话，不要写成一份分点的报告。',
  '- 不要动不动就列 1. 2. 3.，也别堆标题和小标题 —— 除非我明确要一份清单。',
  '- 长短按内容来：一句话能说清就一句话，不用硬凑字数。',
  '- 可以用语气词，但别每句都加。',
  '- 有不同意见就直说，不必一味附和；不确定就说不确定，别编。'
].join('\n');

/** 一键填入聊天风格模板。已有内容时先问一句：直接盖掉撤不回来
 *  （程序改 textarea.value 会清掉浏览器的撤销栈，Ctrl+Z 救不回）。 */
async function applyPersonaTemplate() {
  if (String(el.persona.text.value || '').trim()) {
    const ok = await confirmDialog({
      title: '覆盖现在的人设？',
      message: '这个框里已经有内容了。套用模板会把它整段换掉，而且撤不回来。',
      confirmText: '覆盖',
      danger: true
    });
    if (!ok) return;
  }

  el.persona.text.value = PERSONA_TEMPLATE;
  el.persona.text.focus();
  // 选中第一行空位，用户直接打字就替换掉占位文字；范围在改 value 之后设所以一定生效。
  el.persona.text.setSelectionRange(0, PERSONA_TEMPLATE.indexOf('\n'));
  showToast('模板已填入 —— 改完记得点「保存」', 'ok');
}

// ------------------------------ 填表单 ------------------------------

/** 读一个已保存的数字。⚠️ `Number(null)` / `Number('')` 都是 0，不能直接用它判断「有没有存过」，
 *  那会把 null 当成 0 填进表单；这里显式把空值当缺失。 */
function savedNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fillSettingsForm(settings) {
  el.s.temp.value = savedNumber(settings.temperature, 0.7);
  el.s.maxTokens.value = Math.floor(savedNumber(settings.maxTokens, 8192));
  if (el.s.topP) el.s.topP.value = savedNumber(settings.topP, 0.95);
  if (el.s.thinking) el.s.thinking.checked = settings.thinking !== false;
  el.s.sendOnEnter.checked = settings.sendOnEnter !== false;
  el.s.showDate.checked = settings.showDate !== false;
  el.s.showUsage.checked = settings.showUsage !== false;
  el.s.autoContinue.checked = settings.autoContinue !== false;
  el.s.wbDepth.value = String(
    Math.min(5, Math.max(0, Math.floor(savedNumber(settings.worldbookRecursiveDepth, 1))))
  );
  const turns = savedNumber(settings.maxTurns, 20);
  el.s.maxTurns.value = String(turns >= 1 ? Math.floor(turns) : 20);

  // 弹窗字段跟着设置表单一起刷新，「设置里点保存」读到的才是当前这份；每次都把编辑对象
  // 拨回当前在用的模型。名字留空合法（= 不提名字），原样回填、不替用户补。
  syncPersonaFields(settings, defaultAssistantModel());

  // 生图：下拉里放一个「不启用」+ 所有服务商
  fillSelect(
    el.s.imageProvider,
    [
      { value: '', text: '（不启用生图）' },
      // 本机桥接有独立的 /draw（走本地 ComfyUI），可以选进生图；配图时按是不是桥接分流。
      ...providers().map((provider) => ({ value: provider.id, text: provider.name }))
    ],
    { prefer: providers().some((p) => p.id === settings.imageProviderId) ? settings.imageProviderId : '' }
  );
  el.s.imageModel.value = settings.imageModel || '';
  // 生图模型下拉同样要并上内置目录，否则选不到 glm-image
  fillModelSelect(
    el.s.imageModel,
    el.s.imageProvider.value,
    settings.imageModel,
    '（先在左边选一个提供商）',
    true,
    imageCatalogModels(el.s.imageProvider.value)
  );
  // 尺寸的可选项跟着生图模型走，且会纠正该模型不支持的旧值
  fillImageSizeOptions(el.s.imageModel.value, settings.imageSize);

  // 语义检索：同样是一个「不启用」+ 全部服务商
  el.s.ragEnabled.checked = settings.ragEnabled === true;
  fillSelect(
    el.s.embeddingProvider,
    [
      { value: '', text: '（不选）' },
      // 本机桥接没有 /embeddings 接口，不能选进语义检索
      ...providers()
        .filter((provider) => !isBridgeProvider(provider))
        .map((provider) => ({ value: provider.id, text: provider.name }))
    ],
    { prefer: providers().some((p) => p.id === settings.embeddingProviderId) ? settings.embeddingProviderId : '' }
  );
  fillModelSelect(el.s.embeddingModel, el.s.embeddingProvider.value, settings.embeddingModel, '（先在上面选一个提供商）');

}

// ------------------------------ 服务商编辑 ------------------------------

function parseModels(text) {
  return [...new Set(String(text || '').split(/[\n,，]/).map((m) => m.trim()).filter(Boolean))];
}

/** 把表单里当前编辑的服务商写回内存（还没落盘） */
function stashProviderForm() {
  const p = providerById(editingProviderId);
  if (!p) return;
  p.name = el.p.name.value.trim() || p.name || '未命名提供商';
  p.baseUrl = el.p.baseUrl.value.trim() || p.baseUrl;
  p.apiKey = el.p.apiKey.value.trim();
  p.models = parseModels(el.p.models.value);
}

/** 把内存里的服务商填进表单 */
function fillProviderForm() {
  const p = providerById(editingProviderId);
  el.p.name.value = p ? p.name || '' : '';
  el.p.baseUrl.value = p ? p.baseUrl || '' : '';
  el.p.apiKey.value = p ? p.apiKey || '' : '';
  el.p.models.value = p ? asArray(p.models).join('\n') : '';
  el.btnDelProvider.disabled = providers().length <= 1;
}

/** 服务商卡片那行状态：挑服务商要判断的信息直接写进卡片，别塞 title（触屏和键盘读不到）。 */
function providerMeta(p) {
  if (isBridgeProvider(p)) return '本地桥接 · 免 Key';
  const models = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
  const first = models[0] ? models[0] : '';
  if (!p.apiKey) return first ? `${first} · 还没有填 Key` : '还没有填 API Key';
  return first ? `${first} · 已连接` : '已连接';
}

/** 徽标里放一个字：优先取名字首字母，中文名就取第一个字 */
function providerBadgeText(p) {
  const name = String(p.name || '').trim();
  if (!name) return '＋';
  const first = name[0];
  return /[a-zA-Z0-9]/.test(first) ? first.toUpperCase() : first;
}

function renderProviderTabs() {
  el.providerTabs.innerHTML = '';

  for (const p of providers()) {
    const active = p.id === editingProviderId;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = `provider-card${active ? ' active' : ''}`;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', active ? 'true' : 'false');

    const badge = document.createElement('span');
    badge.className = 'provider-card-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = providerBadgeText(p);

    const body = document.createElement('span');
    body.className = 'provider-card-body';

    const name = document.createElement('span');
    name.className = 'provider-card-name';
    name.textContent = p.name || '未命名';

    const meta = document.createElement('span');
    meta.className = 'provider-card-meta';
    meta.textContent = providerMeta(p);

    body.appendChild(name);
    body.appendChild(meta);

    const radio = document.createElement('span');
    radio.className = 'provider-card-radio';
    radio.setAttribute('aria-hidden', 'true');

    card.appendChild(badge);
    card.appendChild(body);
    card.appendChild(radio);

    card.addEventListener('click', () => {
      if (p.id === editingProviderId) return;
      stashProviderForm();
      editingProviderId = p.id;
      renderProviderTabs();
      fillProviderForm();
    });

    el.providerTabs.appendChild(card);
  }

  renderSectionStats();
}

/** 分组头部那颗统计小胶囊：只给数得出来的组填，填不出就留空（.section-stat:empty 自己隐藏）。 */
function renderSectionStats() {
  const set = (node, text) => {
    if (!node) return;
    node.textContent = text || '';
  };

  const list = providers();
  set(el.statModels, `${list.length} 家提供商`);

  const behavior = el.viewSettings.querySelectorAll('#sec-behavior input[type="checkbox"]:checked');
  const behaviorTotal = el.viewSettings.querySelectorAll('#sec-behavior input[type="checkbox"]');
  set(el.statBehavior, `已开 ${behavior.length} / ${behaviorTotal.length} 项`);

  const ragOn = el.viewSettings.querySelector('#s-rag-enabled');
  set(el.statRag, ragOn && ragOn.checked ? '已启用' : '未启用');

  const petOn = el.viewSettings.querySelector('#s-pet-enabled');
  set(el.statPet, petOn && petOn.checked ? '已开启' : '已关闭');
}

function renderPresets() {
  el.providerPresets.innerHTML = '';

  for (const preset of asArray(state.presets)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-chip';
    btn.textContent = String(preset.name || '');
    btn.title = preset.baseUrl ? preset.baseUrl : '自己填写接口地址';
    btn.addEventListener('click', () => addProvider(preset));
    el.providerPresets.appendChild(btn);
  }
}

function addProvider(preset) {
  stashProviderForm();

  const provider = {
    id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}`,
    name: preset.name || '新提供商',
    baseUrl: preset.baseUrl || '',
    apiKey: '',
    models: [...asArray(preset.models)],
    type: preset.type || 'openai'
  };

  state.settings.providers = [...providers(), provider];
  editingProviderId = provider.id;

  el.providerPresets.classList.add('hidden');
  el.btnAddProvider.setAttribute('aria-expanded', 'false');

  renderProviderTabs();
  fillProviderForm();

  showToast(
    provider.type === 'tavern-bridge'
      ? `已添加「${provider.name}」，本地桥接免 Key，点保存即可用`
      : `已添加「${provider.name}」，填入 API Key 后点保存`,
    'ok'
  );
  if (provider.type === 'tavern-bridge') {
    el.p.baseUrl.focus();
  } else {
    el.p.apiKey.focus();
  }
}

async function removeProvider() {
  const provider = providerById(editingProviderId);
  if (!provider) return;

  if (providers().length <= 1) {
    showToast('至少要保留一个提供商', 'error');
    return;
  }
  const ok = await confirmDialog({
    title: '删除模型提供商',
    message: `删除「${provider.name}」？它的 API Key 和模型列表会一起删掉。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;

  // 写盘失败要能退回去：下面会先改内存里的服务商列表，再走保存链路
  const before = {
    providers: state.settings.providers,
    activeProviderId: state.settings.activeProviderId,
    activeModel: state.settings.activeModel,
    editingProviderId
  };

  state.settings.providers = providers().filter((p) => p.id !== provider.id);
  const next = state.settings.providers[0];
  editingProviderId = next.id;

  // 删掉的正好是当前用的服务商，就切到剩下的第一个
  if (state.settings.activeProviderId === provider.id) {
    state.settings.activeProviderId = next.id;
    state.settings.activeModel = asArray(next.models)[0] || '';
  }

  // 关键：先把表单切到下一个服务商，否则紧接着的 saveSettings → stashProviderForm 会拿
  // 被删服务商的旧表单值覆盖掉幸存服务商的名称 / 地址 / API Key。
  renderProviderTabs();
  fillProviderForm();

  // 写盘失败时 saveSettings 已经弹过错误：这里不能再说「已删除」，内存里的删除也要退回去。
  if (!(await saveSettings(true))) {
    state.settings.providers = before.providers;
    state.settings.activeProviderId = before.activeProviderId;
    state.settings.activeModel = before.activeModel;
    editingProviderId = before.editingProviderId;
    renderProviderTabs();
    fillProviderForm();
    return;
  }
  showToast(`已删除「${provider.name}」`);
}

// ------------------------------ 保存 ------------------------------

/** 把数字输入框读成一个数。⚠️ 不能只用 `Number(v)` + isNaN 兜底：空输入的 `Number('')` 是 0，
 *  清空会静默变成「回复上限 64 / 轮数 1 / 递归深度 0 / 温度 0」。空 → 退回原来存着的值。 */
function numberFrom(input, fallback, min, max, integer) {
  const rawText = String((input && input.value) || '').trim();
  const raw = Number(rawText);
  if (!rawText || !Number.isFinite(raw)) return fallback;
  const clamped = Math.max(min, Math.min(max, raw));
  return integer ? Math.floor(clamped) : clamped;
}

function readSettingsForm() {
  stashProviderForm();

  const saved = state.settings || {};

  return {
    providers: providers(),
    activeProviderId: saved.activeProviderId,
    activeModel: saved.activeModel,
    // 兜底用**原来存着的值**而不是硬编码 8192：清空 = 没改，用常量兜底会把磁盘上的 512 悄悄改成 8192。
    temperature: numberFrom(
      el.s.temp,
      savedNumber(saved.temperature, 0.7),
      0,
      2,
      false
    ),
    maxTokens: numberFrom(
      el.s.maxTokens,
      savedNumber(saved.maxTokens, 8192),
      64,
      32000,
      true
    ),
    thinking: el.s.thinking ? el.s.thinking.checked : saved.thinking !== false,
    topP: numberFrom(
      el.s.topP,
      savedNumber(saved.topP, 0.95),
      0,
      1,
      false
    ),
    sendOnEnter: el.s.sendOnEnter.checked,
    showDate: el.s.showDate.checked,
    showUsage: el.s.showUsage.checked,
    autoContinue: el.s.autoContinue.checked,
    worldbookRecursiveDepth: numberFrom(
      el.s.wbDepth,
      savedNumber(saved.worldbookRecursiveDepth, 1),
      0,
      5,
      true
    ),
    maxTurns: numberFrom(
      el.s.maxTurns,
      savedNumber(saved.maxTurns, 20),
      1,
      200,
      true
    ),
    imageProviderId: el.s.imageProvider.value || '',
    imageModel: el.s.imageModel.value.trim(),
    imageSize: el.s.imageSize.value || '',
    ragEnabled: el.s.ragEnabled.checked,
    embeddingProviderId: el.s.embeddingProvider.value || '',
    embeddingModel: el.s.embeddingModel.value.trim(),
    // 默认人设：只动**当前模型**那一条；名字和人设都清空 = 删掉这条，别在 config.json 里留空壳。
    assistantPersonas: (() => {
      const map = { ...assistantPersonaMap(state.settings) };
      const model = editingAssistantModel();
      // 还没选模型（一个服务商都没配）时没地方存，原样带回
      if (!model) return map;
      const name = el.persona.name.value.trim();
      const persona = el.persona.text.value.trim();
      if (!name && !persona) delete map[model];
      else map[model] = { name, persona };
      return map;
    })()
  };
}

export function openSettings() {
  // 已经在这一屏了：**别重灌表单**，那会把没保存的改动当场冲掉。什么都不做即可。
  if (currentViewName() === 'settings') return;

  // 记下来处：保存 / 返回 / Esc 都回到它
  returnView = currentViewName();

  if (!editingProviderId || !providerById(editingProviderId)) {
    editingProviderId = (state.settings || {}).activeProviderId || (providers()[0] || {}).id;
  }

  fillSettingsForm(state.settings || {});
  renderProviderTabs();
  fillProviderForm();
  renderPresets();
  el.providerPresets.classList.add('hidden');
  el.btnAddProvider.setAttribute('aria-expanded', 'false');

  // 先把内容填好再切屏（反了的话，切过去那一瞬间显示的是上一次的旧值）
  showView('settings');

  // 分组选中态要等这一屏可见后再铺，顺序反了会先按旧状态闪一下。
  syncSettingsSection();

  // 桌宠区块要现拉状态（改的是另一个窗口里的东西）；不 await —— 切屏不该等 IPC 往返。
  openPetSection().catch((err) => console.error('桌宠区块加载失败', err));

  // 外观那一组也回填一遍：它读的是 state.settings 里的字号 / 加粗色 / 背景，不是上面那张表单。
  renderAppearanceForm();

  // 焦点落在页头「返回」上。⚠️ **不要**聚焦任何输入框：<input type="number"> 一获得焦点
  // 就整段选中，而且它可能还在 display:none 的分组里。
  if (el.btnBackSettings) el.btnBackSettings.focus();
}

/** 离开设置页，回到进来之前那一屏（保存 / 返回 / Esc 都走它）。
 *  只保证回到视图：旁边开着的弹窗不管，它自己那套 Esc / 关闭按钮照旧。 */
export function leaveSettings() {
  showView(returnView === 'settings' ? 'chat' : returnView);
}

async function saveSettings(silent) {
  const patch = readSettingsForm();

  try {
    state.settings = await api.saveSettings(patch);
  } catch (err) {
    showToast((err && err.message) || '保存失败', 'error');
    return null;
  }

  // 主进程可能重新整理了服务商，这里同步回界面
  const kept = providerById(editingProviderId);
  editingProviderId = kept ? kept.id : state.settings.activeProviderId;
  renderProviderTabs();
  fillProviderForm();

  if (!silent) {
    showToast('设置已保存', 'ok');
    leaveSettings();
  }

  renderHeader();
  // renderModelSwitch + renderMessages 都在入口层，一并交给它
  afterSettingsSave();

  return state.settings;
}

// 内置目录兜底：目录数据和尺寸规则在 views/settingsCatalog.js，这里只留「往服务商表单里写字」
// 那一步 —— 拉取模型失败且像是「这家没有模型列表接口」（常见 406）时把已知模型填进来。

/**
 * 把内置目录里的模型填进模型输入框；replace=false 时只补空缺，不动用户已写好的内容。
 */
function applyCatalogModels(catalog, replace) {
  if (!catalog) return 0;

  const existing = String(el.p.models.value || '')
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const models = asArray(catalog.models);
  const next = replace ? [...models] : [...existing];
  if (!replace) {
    for (const m of models) {
      if (!next.includes(m)) next.push(m);
    }
  }

  el.p.models.value = next.join('\n');
  stashProviderForm();
  refreshModelSwitch();
  return next.length;
}

// ------------------------------ 网络动作 ------------------------------

async function testConnection() {
  stashProviderForm();
  const provider = providerById(editingProviderId);
  if (!provider) return;

  el.btnTest.loading = true;
  el.btnTest.textContent = '测试中…';
  try {
    const result = await api.testConnection({ provider });
    showToast(result.message || '连接成功', 'ok');
  } catch (err) {
    showToast((err && err.message) || '连接失败', 'error');
  } finally {
    el.btnTest.loading = false;
    el.btnTest.textContent = '测试当前模型提供商';
  }
}

async function fetchModels() {
  stashProviderForm();
  const provider = providerById(editingProviderId);
  if (!provider) return;

  el.btnFetchModels.loading = true;
  el.btnFetchModels.textContent = '获取中…';
  try {
    const models = asArray(await api.listModels({ provider }));

    // 模型可能上百个，填太多反而难挑，只取前 120 个
    const capped = models.slice(0, 120);
    el.p.models.value = capped.join('\n');
    stashProviderForm();
    refreshModelSwitch();

    // 模型列表变了，生图 / 向量两组下拉也要跟着刷新
    fillModelSelect(
      el.s.imageModel,
      el.s.imageProvider.value,
      el.s.imageModel.value,
      '（先在左边选一个提供商）',
      true,
      imageCatalogModels(el.s.imageProvider.value)
    );
    fillModelSelect(el.s.embeddingModel, el.s.embeddingProvider.value, el.s.embeddingModel.value, '（先在上面选一个提供商）');

    showToast(
      models.length > capped.length
        ? `拿到 ${models.length} 个模型，已填入前 ${capped.length} 个`
        : `拿到 ${models.length} 个模型，已填入列表`,
      'ok'
    );
  } catch (err) {
    const message = (err && err.message) || '获取模型列表失败';

    // 该服务商没有模型列表接口时（智谱就是），直接把已知模型填上，让流程能继续走。
    // ⚠️ 但要把**原始报错**一起带上：404 也可能是地址写错，只报「不支持拉取」会带偏方向。
    const catalog = catalogForBaseUrl(provider.baseUrl);
    if (catalog && looksLikeUnsupportedModelList(message)) {
      const hasExisting = String(el.p.models.value || '').trim().length > 0;
      const count = applyCatalogModels(catalog, !hasExisting);
      showToast(
        `${catalog.name}可能没有「模型列表」接口，已${hasExisting ? '补充' : '填入'} ${count} 个已知模型。` +
          `若地址填错请先改地址 —— 服务端原话：${message}`,
        'ok'
      );
    } else {
      showToast(message, 'error');
    }
  } finally {
    el.btnFetchModels.loading = false;
    el.btnFetchModels.textContent = '拉取可用模型';
  }
}


