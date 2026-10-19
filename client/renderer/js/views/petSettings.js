'use strict';

// 设置页里的「桌宠」区块：改的是宠物窗口的配置，改动**即时生效**、不走「点保存」。
// ⚠️ 攒着等保存会和右键菜单同时存在两个真相；预览按 reason='preview' 走，不写记忆和对话记录。

import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import { h, clear } from '../ui/build.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { saveExport } from '../data/export.js';
import {
  refreshPetCache,
  petState,
  loadPetMemory,
  muteRemainMs,
  turnsUntilNextSpeak,
  previewSpeak,
  sayThisNow
} from '../data/petContext.js';

let previewText = '';

/** ⚠️ 三个数字框共用一份待提交表：各留一个定时器时，先改 A 再改 B，重画会把 B 的输入冲掉。 */
let numberTimer = null;
const pendingNumbers = new Map();

/** 「大小」滑块的落盘防抖（拖动中只本地预览，停手才写盘） */
let scaleTimer = null;

function flushPendingNumbers() {
  clearTimeout(numberTimer);
  numberTimer = null;
  if (!pendingNumbers.size) return null;
  const patch = Object.fromEntries(pendingNumbers);
  pendingNumbers.clear();
  return patch;
}

function currentPet() {
  const cache = petState();
  return cache && cache.pet ? cache.pet : null;
}

function currentConfig() {
  return (petState() && petState().config) || null;
}

async function patchPet(patch) {
  const pet = currentPet();
  if (!pet) return;
  // ⚠️ 必须先把待提交的数字并进来：随后的重画按缓存重填输入框，漏掉就等于抹掉用户刚敲的值。
  const pending = flushPendingNumbers();
  const merged = { ...(pending || {}), ...(patch || {}) };
  try {
    await api.petUpdate({ petId: pet.id, patch: merged });
    await refreshPetCache();
    renderPetSettings();
    return true;
  } catch (err) {
    // 调用点多是 fire-and-forget，不接住就是 unhandled rejection；按缓存重画把界面拉回真实状态。
    showToast(`保存桌宠设置失败：${(err && err.message) || '未知错误'}`, 'error');
    renderPetSettings();
    return false;
  }
}

function renderStatusLine() {
  const config = currentConfig();
  const pet = currentPet();
  const node = el.pet.status;
  if (!node) return;

  if (!config || !pet) {
    node.textContent = '还没有可用的桌宠配置';
    return;
  }
  if (!config.enabled) {
    node.textContent = '已关闭 —— 打开上面的开关它才会回到桌面';
    return;
  }

  const bits = [pet.visible ? '在桌面上' : '已隐藏'];
  if (!pet.speakEnabled) bits.push('主动发言已暂停');
  const remain = muteRemainMs();
  if (remain > 0) {
    bits.push(`静音中，还剩 ${Math.ceil(remain / 60000)} 分钟`);
  } else {
    bits.push(`每 ${pet.speakEveryTurns} 轮说 ${pet.speakLines} 句`);
    // turnsUntilNextSpeak 无会话时返回 null：那时不显示，而不是显示「还差 0 轮」（那像是马上要说）。
    const wait = turnsUntilNextSpeak();
    if (Number.isFinite(wait)) bits.push(wait > 0 ? `还差 ${wait} 轮开口` : '下一轮就开口');
  }
  bits.push(`记忆 ${(petState() && petState().memoryCount) || 0} 条`);

  node.textContent = bits.join(' · ');
}

function renderModelSelect() {
  const cache = petState();
  const pet = currentPet();
  const select = el.pet.model;
  if (!select || !pet) return;

  const useMain = pet.useMainModel !== false;
  el.pet.useMainModel.checked = useMain;
  el.pet.modelField.classList.toggle('hidden', useMain);

  const mainHint = `当前主模型：${(cache && cache.mainModel) || '未配置'}`;
  el.pet.mainHint.textContent = mainHint;

  clear(select);
  for (const item of (cache && cache.models) || []) {
    select.appendChild(h('option', { value: `${item.providerId}\u0000${item.model}`, text: item.label }));
  }
  if (!select.options.length) {
    select.appendChild(h('option', { value: '', text: '（先去上面配置提供商）' }));
  }
  select.value = `${pet.providerId || ''}\u0000${pet.model || ''}`;
  if (!select.value || select.selectedIndex < 0) select.selectedIndex = 0;
}

// 形象候选只在设置页打开时拉一次，每次重画都读盘没必要
let skinCache = null;

/** ⚠️ 下拉 value 用 `source\0skin` 两段拼：assets 和 user 下可能重名，只存 skin 名会切到另一张卡。 */
async function renderSkinSelect(force) {
  const select = el.pet.skin;
  const pet = currentPet();
  if (!select || !pet) return;

  if (!skinCache || force) {
    try {
      skinCache = await api.petSkins();
    } catch (err) {
      skinCache = [];
    }
  }

  const items = Array.isArray(skinCache) ? skinCache : [];
  clear(select);
  for (const item of items) {
    const where = item.source === 'user' ? '（自己导入的）' : '';
    select.appendChild(
      h('option', { value: `${item.source}\u0000${item.id}`, text: `${item.label}${where}` })
    );
  }
  if (!select.options.length) {
    select.appendChild(h('option', { value: '', text: '（没找到任何形象）' }));
  }

  const look = pet.look || {};
  select.value = `${look.source || 'assets'}\u0000${look.skin || 'whale'}`;
  if (select.selectedIndex < 0) select.selectedIndex = 0;

  if (el.pet.skinHint) {
    const found = items.some((i) => i.id === look.skin && i.source === (look.source || 'assets'));
    el.pet.skinHint.textContent = found
      ? `当前形象：${look.skin}（${look.source === 'user' ? 'data/pet/skins' : 'assets/pet'}）—— 切换后桌宠窗口会立刻换`
      : `形象「${look.skin}」没找到，桌宠会显示占位框。放好自己的角色后在 assets/pet/<名字>/ 里加 model.json 就能在这里选它`;
  }
}

function renderMemory(items, digest) {
  const box = el.pet.memory;
  if (!box) return;
  clear(box);

  if (digest) {
    box.appendChild(
      h('div', { class: 'pet-memory-digest' }, h('b', { text: '更早以前的折叠摘要：' }), digest)
    );
  }

  if (!items.length) {
    box.appendChild(
      h('div', { class: 'field-help', text: '还没有记忆。它说过的话、记下的事都会出现在这儿。' })
    );
    return;
  }

  for (const item of items) {
    const at = Number(item.at);
    const when = Number.isFinite(at) && at > 0
      ? new Date(at).toLocaleString('zh-CN', { hour12: false })
      : '';
    const kind = item.kind === 'say' ? '说过' : item.kind === 'user' ? '偏好' : '记事';
    // ⚠️ 记 item.id 而不是数组下标：列表随时可能被追加，下标会错位。
    const del = h('button', {
      class: 'pet-memory-del',
      type: 'button',
      title: '删掉这一条',
      'aria-label': '删掉这一条记忆'
    }, '×');
    del.addEventListener('click', () => removeMemoryItem(item, del));
    box.appendChild(
      h(
        'div',
        { class: ['pet-memory-item', `kind-${item.kind || 'event'}`] },
        h('span', { class: 'pet-memory-head' },
          h('span', { class: 'pet-memory-meta', text: `${kind} · ${when}` }),
          del),
        h('span', { class: 'pet-memory-text', text: item.text })
      )
    );
  }
}

async function removeMemoryItem(item, btn) {
  const ok = await confirmDialog({
    title: '删掉这条记忆？',
    message: `「${String(item.text || '').slice(0, 60)}」\n\n删掉之后它就记不得这件事了，也没法撤销。`,
    confirmText: '删掉',
    danger: true
  });
  if (!ok) return;

  btn.disabled = true;
  const pet = currentPet();
  const result = await api.petMemoryDelete({ petId: pet && pet.id, itemId: item.id })
    .catch((err) => ({ ok: false, error: err && err.message }));
  if (!result || !result.ok) {
    btn.disabled = false;
    showToast(`删除失败：${(result && result.error) || '未知原因'}`, 'error');
    return;
  }
  await refreshPetCache();  // 状态行里的「记忆 N 条」要跟着变
  renderStatusLine();
  await refreshMemory();
}

/** ⚠️ --range-fill 是滑块轨道的填充比例（样式在 style.css）：不给的话轨道跟当前值对不上。 */
function renderScale() {
  const pet = currentPet();
  const input = el.pet.scale;
  const badge = el.pet.scaleValue;
  if (!input || !pet) return;

  const pct = Math.round(Math.max(0.6, Math.min(1.6, Number(pet.scale) || 1)) * 100);
  // 拖动中不回填 value —— 否则鼠标还按着的时候会被缓存值拽回去
  if (document.activeElement !== input) input.value = String(pct);
  input.style.setProperty('--range-fill', `${((pct - 60) / (160 - 60)) * 100}%`);
  if (badge) badge.textContent = `${Math.round((Number(pet.scale) || 1) * 100)}%`;
}

/**
 * ⚠️ 正在操作的那一个不能回填：勾选即时生效会触发重画，快速连点两下会被中间那次重画冲掉。
 * ⚠️ 「三个全不勾」是合法状态（= 安静待着），不要兜底「至少留一个」。
 */
const GESTURE_FIELDS = [
  ['nod', 'gestureNod'],
  ['shake', 'gestureShake'],
  ['wave', 'gestureWave']
];

function renderGestures() {
  const pet = currentPet();
  if (!pet || !el.pet.gestureField) return;
  // 字段缺失（老配置没写过）按「全开」显示 —— 和主进程 defaultPet 一个口径
  const enabled = Array.isArray(pet.gestureEnabled) ? pet.gestureEnabled : GESTURE_FIELDS.map((g) => g[0]);
  for (const [kind, key] of GESTURE_FIELDS) {
    const input = el.pet[key];
    if (!input) continue;
    if (document.activeElement === input) continue;
    input.checked = enabled.includes(kind);
  }
}


export function renderPetSettings() {
  const config = currentConfig();
  const pet = currentPet();
  if (!el.pet.section) return;

  if (!config || !pet) {
    el.pet.section.classList.add('pet-missing');
    renderStatusLine();
    return;
  }
  el.pet.section.classList.remove('pet-missing');

  el.pet.enabled.checked = config.enabled !== false;
  el.pet.speakEnabled.checked = pet.speakEnabled !== false;
  // 还没提交的数字改动不要用缓存值冲掉（其他操作也会触发重画）
  const setNumber = (input, key, value) => {
    if (pendingNumbers.has(key)) return;
    input.value = String(value);
  };
  setNumber(el.pet.every, 'speakEveryTurns', pet.speakEveryTurns);
  setNumber(el.pet.lines, 'speakLines', pet.speakLines);
  // temperature 为 null 表示「跟随全局」，输入框留空
  if (!pendingNumbers.has('temperature')) {
    el.pet.temp.value = Number.isFinite(pet.temperature) ? String(pet.temperature) : '';
  }
  setNumber(el.pet.memoryMax, 'memoryMaxItems', pet.memoryMaxItems);
  el.pet.style.value = pet.style || '';

  // 只在框里为空时才覆盖，免得冲掉用户正在编辑的人格
  if (!el.pet.persona.value && petState().persona) {
    el.pet.persona.value = petState().persona;
  }

  el.pet.btnVisible.textContent = pet.visible ? '隐藏桌宠' : '显示桌宠';
  const remain = muteRemainMs();
  el.pet.btnMute.textContent = remain > 0 ? `取消静音（剩 ${Math.ceil(remain / 60000)} 分）` : '静音 1 小时';

  renderModelSelect();
  renderSkinSelect();
  renderScale();
  renderGestures();
  renderStatusLine();
}

function setPreview(text, isError) {
  if (!el.pet.preview) return;
  el.pet.preview.textContent = text || '';
  el.pet.preview.classList.toggle('is-error', !!isError);
  el.pet.btnSay.disabled = !text || !!isError;
}

async function doPreview() {
  el.pet.btnPreview.disabled = true;
  setPreview('它正在想…');
  try {
    const result = await previewSpeak();
    if (!result.ok) {
      setPreview(`没能生成：${result.error || '未知原因'}`, true);
      return;
    }
    previewText = result.text || '';
    const via = result.fellBack ? `（宠物自己那个模型没成，用了主模型：${result.model}）` : '';
    setPreview(result.lines.join('\n') + (via ? `\n${via}` : ''));
    el.pet.btnSay.disabled = false;
  } finally {
    el.pet.btnPreview.disabled = false;
    renderStatusLine();
  }
}

async function refreshMemory() {
  const pet = currentPet();
  if (!pet || !el.pet.memory) return;
  try {
    const { items, digest } = await loadPetMemory(pet.id);
    renderMemory(items, digest);
    el.pet.memoryHint.textContent =
      `保留上限 ${pet.memoryMaxItems} 条，现在 ${items.length} 条` +
      (digest ? '（更早的已经折进摘要）' : '') +
      '。记忆存在 data/pet/memory/ 里，和主对话的记忆完全分开。';
  } catch (err) {
    el.pet.memoryHint.textContent = `读取记忆失败：${(err && err.message) || '未知错误'}`;
  }
}

async function exportMemory() {
  const result = await api.petMemoryExport({}).catch((err) => ({ ok: false, error: err && err.message }));
  if (!result || !result.ok) {
    showToast(`导出失败：${(result && result.error) || '未知原因'}`, 'error');
    return;
  }
  await saveExport({
    fileName: result.fileName,
    text: result.text,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
}

export function initPetSettings(opts) {
  const options = opts || {};
  if (!el.pet.section) return;

  // ---- 开关 / 数字 ----

  el.pet.enabled.addEventListener('change', async () => {
    try {
      await api.petUpdate({ patch: { enabled: el.pet.enabled.checked } });
      await refreshPetCache();
    } catch (err) {
      showToast(`切换桌宠失败：${(err && err.message) || '未知错误'}`, 'error');
    } finally {
      renderPetSettings();
    }
  });

  el.pet.speakEnabled.addEventListener('change', () => patchPet({ speakEnabled: el.pet.speakEnabled.checked }));

  const bindNumber = (input, key, min, max) => {
    input.addEventListener('input', () => {
      const n = Number(input.value);
      if (!Number.isFinite(n)) return;
      const clamped = Math.max(min, Math.min(max, Math.round(n)));
      if (clamped !== n) input.value = String(clamped);

      pendingNumbers.set(key, clamped);
      clearTimeout(numberTimer);
      numberTimer = setTimeout(() => {
        const patch = flushPendingNumbers();
        if (patch) patchPet(patch);
      }, 600);
    });
  };
  bindNumber(el.pet.every, 'speakEveryTurns', 1, 50);
  bindNumber(el.pet.lines, 'speakLines', 1, 5);
  bindNumber(el.pet.memoryMax, 'memoryMaxItems', 0, 200);

  // 温度允许留空 = 跟随全局，所以不能走上面那套「必须是数字」
  el.pet.temp.addEventListener('change', () => {
    const raw = el.pet.temp.value.trim();
    const n = Number(raw);
    patchPet({ temperature: raw === '' || !Number.isFinite(n) ? null : Math.max(0, Math.min(2, n)) });
  });

  el.pet.style.addEventListener('change', () => patchPet({ style: el.pet.style.value.trim() }));

  // ---- 形象 ----

  // ⚠️ 换形象必须重建整张卡：主进程 rigSkinDir() 按 look.skin 指新目录，rig key 变了才重载贴图。
  // ⚠️ 人格跟着形象走：切之前必须清空人格框，否则 renderPetSettings 会因「框里已有内容」跳过回填。
  if (el.pet.skin) {
    el.pet.skin.addEventListener('change', async () => {
      const [source, skin] = String(el.pet.skin.value || '').split('\u0000');
      if (!skin) return;
      el.pet.persona.value = '';       // 让下一步的重画把新形象的人格装进来
      const saved = await patchPet({ look: { kind: 'rig', source: source || 'assets', skin } });
      if (saved) showToast('形象已切换（人格也跟着这张形象走）', 'ok');
    });
  }

  // ---- 大小 ----

  // 停手 250ms 才落盘：不防抖的话一次拖动几十条 pet:update，窗口会一顿一顿地跳。
  if (el.pet.scale) {
    el.pet.scale.addEventListener('input', () => {
      const pct = Number(el.pet.scale.value) || 100;
      el.pet.scale.style.setProperty('--range-fill', `${((pct - 60) / (160 - 60)) * 100}%`);
      if (el.pet.scaleValue) el.pet.scaleValue.textContent = `${pct}%`;
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(() => patchPet({ scale: pct / 100 }), 250);
    });
    // 松手（或键盘调完）立刻补一次，免得最后那一下还在防抖里就被别的重画冲掉
    el.pet.scale.addEventListener('change', () => {
      clearTimeout(scaleTimer);
      scaleTimer = null;
      patchPet({ scale: (Number(el.pet.scale.value) || 100) / 100 });
    });
  }

  // ---- 空闲小动作 ----
  const onGestureToggle = () => {
    const enabled = GESTURE_FIELDS
      .filter(([, key]) => el.pet[key] && el.pet[key].checked)
      .map(([kind]) => kind);
    patchPet({ gestureEnabled: enabled });
  };
  for (const [, key] of GESTURE_FIELDS) {
    if (el.pet[key]) el.pet[key].addEventListener('change', onGestureToggle);
  }

  // ---- 模型 ----

  el.pet.useMainModel.addEventListener('change', () => {
    if (el.pet.useMainModel.checked) patchPet({ useMainModel: true });
    else {
      // 取消跟随时把下拉当前值一起写回，否则会出现「取消了跟随、但没有模型」的空档
      const value = String(el.pet.model.value || '');
      const [providerId, model] = value.split('\u0000');
      patchPet({ useMainModel: false, providerId: providerId || '', model: model || '' });
    }
  });

  el.pet.model.addEventListener('change', () => {
    const [providerId, model] = String(el.pet.model.value || '').split('\u0000');
    patchPet({ useMainModel: false, providerId: providerId || '', model: model || '' });
  });

  // ---- 人格 ----

  el.pet.persona.addEventListener('change', async () => {
    const pet = currentPet();
    if (!pet) return;
    try {
      await api.petPersonaSave({ petId: pet.id, text: el.pet.persona.value });
      showToast('人格设定已保存', 'ok');
    } catch (err) {
      showToast(`人格保存失败：${(err && err.message) || '未知错误'}`, 'error');
    }
  });

  el.pet.btnPersonaReset.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '还原人格设定',
      message: '把桌宠的人格还原成内置的那一份？你改过的内容会丢掉。',
      confirmText: '还原',
      danger: true
    });
    if (!ok) return;
    const pet = currentPet();
    if (!pet) return;
    // 传空文本 = 让主进程把内置那份重新写出来（主进程那边把空当「还原」处理）
    let result;
    try {
      result = await api.petPersonaSave({ petId: pet.id, text: '' });
    } catch (err) {
      showToast(`还原失败：${(err && err.message) || '未知错误'}`, 'error');
      return;
    }
    await refreshPetCache();
    el.pet.persona.value = (result && result.persona) || petState().persona || '';
    renderPetSettings();
    showToast('已还原成内置人格', 'ok');
  });

  // ---- 状态按钮 ----

  el.pet.btnSpeak.addEventListener('click', async () => {
    el.pet.btnSpeak.disabled = true;
    try {
      // 走入口层注入的 options.speakNow，和右键菜单「现在说话」是同一条路
      await options.speakNow?.('manual');
    } catch (err) {
      showToast(`让它说话失败：${(err && err.message) || '未知错误'}`, 'error');
    } finally {
      el.pet.btnSpeak.disabled = false;
      await refreshPetCache();
      renderPetSettings();
    }
  });

  el.pet.btnMute.addEventListener('click', () => {
    const remain = muteRemainMs();
    patchPet({ mutedUntil: remain > 0 ? 0 : Date.now() + 60 * 60 * 1000 });
  });

  el.pet.btnVisible.addEventListener('click', async () => {
    const pet = currentPet();
    if (!pet) return;
    try {
      await api.petSetVisible({ visible: !pet.visible });
    } catch (err) {
      showToast(`切换显示失败：${(err && err.message) || '未知错误'}`, 'error');
    }
    await refreshPetCache();
    renderPetSettings();
  });

  // ---- 预览 ----

  el.pet.btnPreview.addEventListener('click', () => doPreview());

  el.pet.btnSay.addEventListener('click', async () => {
    if (!previewText) return;
    const result = await sayThisNow(previewText);
    if (result && result.ok) showToast('让它说出来了', 'ok');
    else showToast(`没能说出来：${(result && result.error) || '未知原因'}`, 'error');
  });

  // ---- 记忆 ----

  el.pet.btnMemoryRefresh.addEventListener('click', () => refreshMemory());

  el.pet.btnMemoryExport.addEventListener('click', () => exportMemory());

  el.pet.btnMemoryReset.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '重置桌宠记忆',
      message: '清掉它记得的每一条，但保留更早以前折叠成的摘要。',
      confirmText: '重置',
      danger: true
    });
    if (!ok) return;
    try {
      await api.petMemoryClear({ keepDigest: true });
    } catch (err) {
      showToast(`重置失败：${(err && err.message) || '未知错误'}`, 'error');
      return;
    }
    await refreshPetCache();
    renderPetSettings();
    await refreshMemory();
    showToast('桌宠记忆已重置', 'ok');
  });

  el.pet.btnMemoryClear.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空桌宠记忆',
      message: '连折叠摘要一起清掉，等于让它把你忘干净。这个操作没法撤销。',
      confirmText: '清空',
      danger: true
    });
    if (!ok) return;
    try {
      await api.petMemoryClear({ keepDigest: false });
    } catch (err) {
      showToast(`清空失败：${(err && err.message) || '未知错误'}`, 'error');
      return;
    }
    await refreshPetCache();
    renderPetSettings();
    await refreshMemory();
    showToast('桌宠记忆已清空', 'ok');
  });

  // 右键菜单改了配置 → 主进程广播 pet:changed → 这里重画。
  // 人不在这一屏时不画：为看不见的界面反复重排，还会冲掉正在编辑的内容。
  api.onPetChanged(async () => {
    // ⚠️ 缓存永远要刷：maybePetAutoSpeak 的闸门读的是 petCache，不刷的话
    //    「隐藏桌宠」「暂停主动发言」要等下一次成功说话才生效。
    await refreshPetCache();
    // 判据是「在不在这一屏」，不是弹窗显不显示。
    if (el.viewSettings && el.viewSettings.classList.contains('hidden')) return;
    onPetStateChanged();
  });
}

export async function openPetSection(focus) {
  await refreshPetCache();
  renderPetSettings();
  await refreshMemory();
  if (focus === 'memory' && el.pet.section) {
    el.pet.section.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

export function onPetStateChanged() {
  renderPetSettings();
  refreshMemory();
}
