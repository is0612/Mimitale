'use strict';

// ============================================================================
//  views/genParams.js —— 生成参数（右侧那一栏的第二个页签）
//
//  参数**按会话存**（`convo.sampling`）。整条优先级是「**会话覆盖 → 预设 → 全局**」：
//    · 全局：settings.temperature / topP / maxTokens（设置页里那份）
//    · 预设：dialoguePresetSampling(convo)（data/messages.js）
//    · 会话：convo.sampling —— 就是这个页签改的那份
//  前两层合并在 data/messages.js 的 effectiveSampling() 里，合并结果随 `chat:send`
//  发出去，由主进程逐项覆盖全局（main/ipc.js 的白名单）。
//  ⚠️ 所以这里**不能**把空项也写进 convo.sampling —— 空项要**删掉**这个键，
//     留着 null 会被当成「明确设成 null」而顶掉预设和全局。
//
//  ⚠️ 2026-10-12 晚：它原来是**右侧一个浮层抽屉**（#gen-drawer，320px，从右边盖住
//     「在场角色」那一栏，开的时候还要把对话列挤窄 264px）。两者抢同一个右边缘 ——
//     稿子自己也没解决（屏 2 画抽屉、屏 1/3 画在场角色栏）。
//     现在改成**同一栏的两个页签**（见 views/castPanel.js 的 showRailTab）：
//     对话列宽度一点不变，开参数不会让正文跳一下。
//
//  ⚠️ 交互上有个必须交代的坑：**滑块没法表达「没设过」**。
//     所以滑块**永远显示当前生效的值**（会话值 → 预设 → 全局），
//     拖过之后才写进 convo.sampling；「这一局自己定了」用数值的**主色**标出来。
//     这也是「恢复默认」存在的理由 —— 把三项都退回「跟随」。
//
//  ⚠️ 只放**真的会进请求**的参数。稿子上还有「重复惩罚 / 状态表扫描 /
//     心理描写 / 流式输出 / 正则」几项，它们要么现在没有对应实现、要么已经有
//     别的入口（比如「心理描写」就是「视角」里的叙述模式）——
//     摆一排点了没反应的控件比不画更糟。
// ============================================================================

import { el } from '../core/dom.js';
import { state } from '../core/state.js';
import { activeConvo } from '../core/util.js';
import { showToast } from '../ui/toast.js';
import { dialoguePresetById } from '../data/library.js';
import { persistConversations } from '../data/persist.js';
import { syncRangeFill } from './appearance.js';
import { onRefresh } from './refresh.js';
import { showRailTab, isRailTab } from './castPanel.js';

/** 三项参数：DOM 引用、范围、以及「拿不到会话值 / 预设值 / 全局值时」的兜底 */
const FIELDS = [
  { key: 'temperature', min: 0, max: 2, step: 0.01, fallback: 0.7, digits: 2 },
  { key: 'topP', min: 0, max: 1, step: 0.01, fallback: 0.95, digits: 2 },
  { key: 'maxTokens', min: 64, max: 32000, step: 64, fallback: 8192, digits: 0 }
];

function inputOf(key) {
  if (key === 'temperature') return el.genTemperature;
  if (key === 'topP') return el.genTopP;
  return el.genMaxTokens;
}

function valueOf(key) {
  if (key === 'temperature') return el.genTemperatureValue;
  if (key === 'topP') return el.genTopPValue;
  return el.genMaxTokensValue;
}

function convoSampling(convo) {
  const raw = convo && convo.sampling;
  return raw && typeof raw === 'object' ? raw : {};
}

/** 会话值 → 预设值 → 全局值。返回 { value, from: 'convo' | 'preset' | 'global' } */
function effectiveField(convo, field) {
  const own = convoSampling(convo)[field.key];
  if (Number.isFinite(own)) return { value: Number(own), from: 'convo' };

  const preset = presetSampling(convo);
  if (Number.isFinite(preset[field.key])) return { value: Number(preset[field.key]), from: 'preset' };

  const global = Number((state.settings || {})[field.key]);
  if (Number.isFinite(global)) return { value: global, from: 'global' };

  return { value: field.fallback, from: 'global' };
}

/** 这一局挂的预设里写了的采样值（多个预设时取第一个写了的） */
function presetSampling(convo) {
  const ids = Array.isArray(convo && convo.dialoguePresetIds)
    ? convo.dialoguePresetIds
    : convo && convo.dialoguePresetId
      ? [convo.dialoguePresetId]
      : [];
  for (const id of ids) {
    const preset = dialoguePresetById(id);
    const s = preset && preset.sampling;
    if (s && typeof s === 'object' && Object.keys(s).length) return s;
  }
  return {};
}

/** 改一项：值给 null 就是「清掉这一项，回到跟随预设 / 全局」 */
function writeSampling(key, value) {
  const convo = activeConvo();
  if (!convo) return;

  const next = { ...convoSampling(convo) };
  if (value == null) delete next[key];
  else next[key] = value;

  // 三项都清空就把整个 sampling 删掉 —— 留一个空对象会让「这一局改过参数」
  // 这种判断误判（而且写盘时也多一份没用的字段）
  if (Object.keys(next).length) convo.sampling = next;
  else delete convo.sampling;
}

function persist() {
  persistConversations();
}

function presetLabel(convo) {
  const ids = Array.isArray(convo && convo.dialoguePresetIds)
    ? convo.dialoguePresetIds
    : convo && convo.dialoguePresetId
      ? [convo.dialoguePresetId]
      : [];
  const first = ids.map((id) => dialoguePresetById(id)).filter(Boolean)[0];
  if (!first) return '没有挂预设';
  return ids.length > 1 ? `预设：${first.name} +${ids.length - 1}` : `预设：${first.name}`;
}

/** 数值文案：温度 / 核采样要两位小数，最大长度是整数 */
function formatValue(field, value) {
  return field.digits ? Number(value).toFixed(field.digits) : String(Math.round(value));
}

export function renderGenParams() {
  // 页签没打开就不刷：一来看不见白费劲，二来全量重绘频繁（发一条消息刷好几次），
  // 会把你正在拖的那根滑块顶回去。
  if (!isRailTab('gen')) return;

  const convo = activeConvo();

  for (const field of FIELDS) {
    const input = inputOf(field.key);
    const out = valueOf(field.key);
    if (!input) continue;

    const { value, from } = effectiveField(convo, field);
    const clamped = Math.min(field.max, Math.max(field.min, value));
    input.value = String(clamped);
    syncRangeFill(input);

    if (out) {
      out.textContent = formatValue(field, clamped);
      // 「这一局自己定了」用主色标出来；跟随预设 / 全局就是灰的
      out.classList.toggle('is-own', from === 'convo');
      out.title =
        from === 'convo' ? '这一局自己定的' : from === 'preset' ? '跟随预设' : '跟随全局设置';
    }
  }

  if (el.genPreset) el.genPreset.textContent = presetLabel(convo);
}

function resetAll() {
  for (const field of FIELDS) writeSampling(field.key, null);
  persist();
  renderGenParams();
  showToast('这一局的三项都回到跟随预设 / 全局设置了');
}

export function initGenParams() {
  // 换会话、切视图、发消息之后都要跟着刷（页签开着时显示别的会话的值就糟了）
  onRefresh(renderGenParams);

  // 「⋯」菜单里那一项 = 切到生成参数页签（顺手把收起的右栏展开）
  if (el.btnGenParams) {
    el.btnGenParams.addEventListener('click', () => showRailTab('gen'));
  }
  if (el.btnGenReset) el.btnGenReset.addEventListener('click', resetAll);

  for (const field of FIELDS) {
    const input = inputOf(field.key);
    if (!input) continue;

    // input = 拖动中预览（不落盘，跟外观那几根滑块同一套接线）、change = 松手落盘
    input.addEventListener('input', () => {
      const n = Math.min(field.max, Math.max(field.min, Number(input.value)));
      if (!Number.isFinite(n)) return;
      const out = valueOf(field.key);
      if (out) {
        out.textContent = formatValue(field, n);
        out.classList.add('is-own');
        out.title = '这一局自己定的';
      }
      syncRangeFill(input);
      writeSampling(field.key, n);
    });
    input.addEventListener('change', () => {
      persist();
      renderGenParams();
    });
  }
}
