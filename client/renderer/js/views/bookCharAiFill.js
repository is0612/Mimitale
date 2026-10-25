'use strict';

// ============================================================================
//  views/bookCharAiFill.js —— 本书角色编辑页左栏那颗「AI 补充」
//
//  做的事：拿编辑器里**当前**这张卡（含刚手改还没保存的字），让模型把角色描述
//  重写一遍，然后直接填回表单。
//
//  和「AI 生成角色」的区别（aiGen.js）：那边是**造**一个新人（连名字、标签、属性一起出）；
//  这边是**改**手上这张卡，只动描述这一栏，身份 / 世界观 / 语气 / 名字一律沿用。
//  所以提示词没有复用 aiGen 的 LIBRARY_SYSTEM —— 那份里的「取个好名字 / 给 3~8 条属性」
//  在这儿全是噪音。
//
//  ⚠️ 不落盘：结果只进表单，用户再点「保存」才写进卡里（和「AI 补设定」同一条规矩）。
//  ⚠️ 一定要先确认再跑：它会把已经写好的文字盖掉，点错一次损失的是手感 —— 见 confirm。
// ============================================================================

import { el } from './bookCharEditorDom.js';
import { uid } from '../core/util.js';
import { api } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { confirmDialog } from '../ui/confirm.js';
import { extractJsonBlock, generationText, resolveGenTarget } from './aiGen.js';

// --- 提示词 ---

const FILL_SYSTEM = `你是一位角色卡编辑，负责把玩家**已经写好**的角色描述改好 —— 不是另写一张新卡。

【这次只动这一栏】
description（角色描述）。

【改法】
· 身份、世界观、时代、性格、语气、和 {{user}} 的关系，一律沿用卡里已有的设定；只有卡上完全没写的才由你补。
  不要推翻重设，也不要换一个人。
· 已经写过的内容保留原意，往「更具体、更能演」的方向改：空泛形容词换成看得出性格的说话方式和习惯，
  重复的细节合并，前后矛盾的地方按更具体的那一处统一。
· 名字 / 标签 / 属性 / 作者备注一概不动，也不要出现在输出里。

【这一栏怎么写】
· 第三人称，交代身份、外貌、年龄、处境、性格，有画面感；挑 1~2 个最能体现角色的细节，
  不要把所有特点列成清单。性格可以融进描述里（她怎么说话、有什么执念、对 {{user}} 什么态度），
  不用单独拆出来。

【输出格式】严格按下面的 JSON 输出，不要任何解释文字或 Markdown 代码块标记；
字符串里的换行写成 \\n：
{
  "description": "..."
}
这一栏一定要给，不许省 —— 卡上原本空着的，也按其它内容补一个能用的版本。`;

// 单栏上限：够长，但别让一张几万字的卡把上下文吃满（超出的部分模型也改不动）
const MAX_INPUT = {
  description: 2400
};

/** 把卡里这一栏拼给模型看。空栏显式写「（还没写）」，模型才知道那是要补的地方 */
function cardContext(character) {
  const cut = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const block = (label, key) => {
    const text = cut(character[key], MAX_INPUT[key]);
    return `【${label}】\n${text || '（还没写）'}`;
  };

  const parts = [`【名字】${cut(character.name, 60) || '未命名角色'}`];
  parts.push(block('角色描述', 'description'));

  const tags = (Array.isArray(character.tags) ? character.tags : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 10);
  if (tags.length) parts.push(`【标签】${tags.join('、')}`);

  return parts.join('\n\n');
}

// --- 解析 ---

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

/** 按顺序找第一个非空字符串 */
function pick(json, keys, max) {
  for (const key of keys) {
    const value = text(json[key], max);
    if (value) return value;
  }
  return '';
}

/**
 * 模型输出 → 一个字段。纯函数（不碰 DOM、不碰 state），宿主侧拿它验形状。
 * @returns {{ ok: boolean, fields?: object, filled?: number, error?: string, raw?: string }}
 */
export function parseCardFill(raw) {
  const body = extractJsonBlock(raw);
  if (!body) return { ok: false, error: '模型没有返回内容', raw: String(raw || '') };

  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return { ok: false, error: '模型返回的不是合法 JSON', raw: String(raw || '') };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: '模型返回的结构不对', raw: String(raw || '') };
  }

  const fields = {
    description: pick(json, ['description', 'desc'], 20000)
  };

  const filled = Object.values(fields).filter(Boolean).length;
  if (!filled) return { ok: false, error: '模型没有给出可用的内容', raw: String(raw || '') };
  return { ok: true, fields, filled };
}

// --- 按钮 ---

let busy = false;
let currentGenId = null;
let readCard = () => null; // 由 characterEditor 注入：先把表单收进内存，再取那张卡
let apply = () => 0; // 由 characterEditor 注入：把这一栏填回表单，返回真正写了几栏

function button() {
  return el.btnAiFillChar || null;
}

/** loading 自带「不可点」（见 components/button.js）：转圈圈 + 文字一起变，一眼知道在等 */
function setBusy(on) {
  busy = on;
  const btn = button();
  if (!btn) return;
  btn.loading = on;
  btn.textContent = on ? '补充中…' : 'AI 补充';
}

export function initCharAiFill(opts) {
  const o = opts || {};
  if (typeof o.readCard === 'function') readCard = o.readCard;
  if (typeof o.apply === 'function') apply = o.apply;

  if (el.btnAiFillChar) {
    el.btnAiFillChar.addEventListener('click', () => {
      run().catch((err) => console.error('[charAiFill] 补充失败', err));
    });
  }
}

async function run() {
  if (busy) return;

  const character = readCard();
  if (!character) return;

  const hasCard = String(character.description || '').trim();
  if (!hasCard) {
    showToast('先给角色写点描述，AI 才有东西可补', 'error');
    return;
  }

  // 先问一句：这一下会把已经写好的描述换成 AI 的版本（虽然还要点保存才进卡，
  // 但表单里的手稿是当场就没了），点错一次修不回来。
  const name = String(character.name || '').trim() || '这个角色';
  const ok = await confirmDialog({
    title: '用 AI 补充这张卡',
    message:
      `AI 会读「${name}」现有的内容，重写角色描述这一栏，` +
      '覆盖表单里现在写着的东西（点「保存」才真正写进卡里）。名字、标签、属性不动。',
    confirmText: '开始补充'
  });
  if (!ok) return;

  const target = resolveGenTarget();
  if (!target) return;

  const requestId = uid();
  currentGenId = requestId;
  setBusy(true);
  showToast(target.bridge ? 'AI 正在重写这张卡，本地模型可能要 30~60 秒' : 'AI 正在重写这张卡…');

  try {
    const response = await api.sendChat({
      requestId,
      providerId: target.endpoint.provider.id,
      model: target.endpoint.model,
      messages: [
        { role: 'system', content: `${FILL_SYSTEM}\n\n以下是这张卡现在的样子：\n\n${cardContext(character)}` },
        { role: 'user', content: '请按上面的规则把这一栏改好，直接输出 JSON。' }
      ],
      noImage: true
    });

    // 生成期间用户可能换了张卡 / 关掉了编辑器 —— 作废的回执不许再改进表单
    if (currentGenId !== requestId) return;

    if (!response || response.ok !== true) {
      showToast((response && response.error) || '调用失败', 'error');
      return;
    }

    const parsed = parseCardFill(generationText(response, target.bridge));
    if (!parsed.ok) {
      showToast(`${parsed.error}，这次没补上`, 'error');
      return;
    }

    const written = apply(parsed.fields);
    if (!written) {
      showToast('AI 回了内容，但没能填进表单', 'error');
      return;
    }
    showToast(`AI 补了 ${written} 栏，点「保存」才写进卡里`, 'ok');
  } catch (err) {
    if (currentGenId !== requestId) return;
    showToast((err && err.message) || '补充失败', 'error');
  } finally {
    if (currentGenId === requestId) {
      currentGenId = null;
      setBusy(false);
    }
  }
}

/** 编辑器关了 / 换了张卡：进行中的请求作废，按钮回到常态 */
export function resetCharAiFill() {
  if (currentGenId) {
    api.stopChat(currentGenId).catch((err) => console.warn('[charAiFill] 中止请求失败:', err));
    currentGenId = null;
  }
  setBusy(false);
}
