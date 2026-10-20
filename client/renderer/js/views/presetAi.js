'use strict';

// ============================================================================
//  views/presetAi.js —— 预设列表页的「AI 生成」
//
//  做的事：把用户的一句「我想改善什么」写成一条完整预设 ——
//  名字 / 说明 / 标签 / 指令正文，填进预设编辑器当草稿，点「保存」才真正创建。
//
//  为什么和 aiGen.js（AI 生成角色）分开写：
//    角色那边要一次给 8 个字段 + 开场白 + 示例对话，预设只产一段「始终生效的规则」；
//    弹窗里的输入框、提示词、解析、兜底没有一处能共用。真正共用的是
//    「走哪一路模型」「桥接正文在哪」「剥围栏」这三个小件，从 aiGen.js 借来即可。
//
//  ⚠️ 生成完不落盘 —— 和「AI 生成角色」同一条规矩。
//  ⚠️ 正文会每轮拼进系统提示词：别让它写角色设定 / 开场白 / 剧情，
//     那些属于角色卡；也不要在提示词里放松「规则要具体、可检查」这条。
// ============================================================================

import { api } from '../core/api.js';
import { uid } from '../core/util.js';
import { h } from '../ui/build.js';
import { iconHtml } from '../ui/icons.js';
import { field } from '../ui/controls.js';
import { mTextarea, mButton } from '../components/index.js';
import { showToast } from '../ui/toast.js';
import { extractJsonBlock, generationText, resolveGenTarget } from './aiGen.js';

// --- 提示词 ---

// ⚠️ 认这个请求的桩在 tools/smoke-test.js：它要「写「预设」的编辑」+ "note" 两样，
//    改措辞时别把这两样一起改没了（改没了会被当成普通聊天，返回一句假回复）。
const PRESET_SYSTEM = `你是一位写「预设」的编辑。预设不是角色卡，也不是剧情 —— 它是一段始终叠在系统提示词里的写作规则，每一轮都生效，约束模型下一句回复怎么写。

用户的输入通常是这三种：
· 说一个毛病（「回复太长、太爱总结」）—— 你要先把这个问题扭过来；
· 说一种想要的写法（「古风权谋，话里有话」）—— 你要把它落成可执行的规则；
· 要一个量（「每轮 2000 字」）—— 你要把它拆成能照着做的配额，见下面第 3 条。

严格按照下面的 JSON 结构输出，不要输出任何多余的文字、解释或 Markdown 代码块标记：

{
  "name": "预设名",
  "note": "一句话说明",
  "tags": ["标签", "标签"],
  "content": "指令正文"
}

· name：2~6 个字，像一条预设的名字（「短句对白」「向前推进」「冷静叙事」），不要「预设一」这种。
· note：20~40 字，说清它约束什么、什么场次该用 —— 这句只显示在列表上，不会发给模型；写成一行，不要换行。
· tags：2~3 个短标签（「节奏」「对白」「叙事」这类）。
· content：指令正文，150~450 字（这是规则本身的长度，不是用户要的回复字数），3~6 条规则，每条单独一行；
  用第二人称 / 祈使句直接约束回复（「每轮只写一个场景，别把镜头切来切去」），
  不要写成「这个预设会让回复……」的说明。

指令正文的写法（按优先级）：

1. 先治用户说的那个毛病，把最要紧的一条放第一条；再补 1~3 条配套的，让这套规则单独拿出来也能成立。
2. 每条规则必须具体、可检查：写清「怎么做」，不写「要生动」「要有感染力」「要自然」这类空词。
   坏例子：「描写要细腻。」
   好例子：「每轮最多写一个环境细节，而且要和当前动作有关，不写全景。」
3. 用户提到字数 / 篇幅（「每轮 2000 字」「写长一点」）时，**不能只抄一句「2000 字以上」** ——
   要拆成能照着做的配额：总字数 + 段数 + 每段大致字数 + 写不够时怎么办，再加一条优先级。
   例：「每轮不少于 2000 字，至少分 5 段；每段 350~450 字，没写够就接着往下写，
   不要用一句总结或一个动作收尾。」「篇幅优先于推进节奏：这一轮先把字数写够，再交还叙述权。」
   反过来，用户说要短，就把上限也写成能检查的数（「每轮不超过 3 句话」），别写「简短一些」。
4. 一条规则只讲一件事；该划边界的时候用「……，而不是……」说清。
5. 不要和角色扮演的基础规则重复（不要出戏、不要替 {{user}} 说话、角色是谁），
   除非用户明确说要强化某一条。
6. 规则要对所有对话通用：不要写死具体人名、地名、剧情；可以用 {{char}} / {{user}}，
   但只在指代不清的地方用。
7. 不写开场白、示例对话、角色设定 —— 那些是角色卡的事。
8. 只输出 JSON 本身，不要任何解释或代码块标记。`;

/** 可选的「适用场次」：只影响用词，不该把具体人物 / 剧情带进规则 */
function sceneSection(scene) {
  const text = String(scene || '').trim();
  if (!text) return '';
  return `\n\n【适用的场次】\n${text.slice(0, 800)}\n\n规则要贴合这个场次，但不要把里面的人物、地名、具体剧情写进规则。`;
}

// --- 解析 ---

const MAX_NAME = 60;
const MAX_NOTE = 400;
const MAX_CONTENT = 8000;

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/** 标签：字符串数组、逗号串都收；空串 / 超长 / 重复的摘掉 */
function parseTags(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、]/)
      : [];
  const out = [];
  for (const item of list) {
    const tag = str(item, 40).trim();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 模型输出 → 预设字段。纯函数（不碰 DOM、不碰 state），宿主侧也拿它验形状。
 * @returns {{ ok: boolean, fields?: object, error?: string, raw?: string }}
 */
export function parseGeneratedPreset(raw) {
  const text = extractJsonBlock(raw);
  if (!text) return { ok: false, error: '模型没有返回内容', raw: String(raw || '') };

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: '模型返回的不是合法 JSON', raw: String(raw || '') };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: '模型返回的结构不对', raw: String(raw || '') };
  }

  const content = str(json.content, MAX_CONTENT).trim();
  if (!content) return { ok: false, error: '模型没有给出指令正文', raw: String(raw || '') };

  return {
    ok: true,
    fields: {
      name: str(json.name, MAX_NAME).trim() || '未命名预设',
      // 说明只占一行：换行在列表里会被压掉，先在这里收成一句
      note: str(json.note, MAX_NOTE).replace(/\s+/g, ' ').trim(),
      tags: parseTags(json.tags),
      content
    }
  };
}

// --- 弹窗 ---

let layerEl = null;
let nodes = null;
let busy = false;
let currentGenId = null;
let escHandler = null;

let startDraft = () => {
  console.error('[presetAi] startDraft 还没接线，生成的内容没法交出去');
  return false;
};

export function initPresetAi(opts = {}) {
  if (typeof opts.startDraft === 'function') startDraft = opts.startDraft;
}

export function openPresetAiModal() {
  if (layerEl) closeLayer();

  buildLayer();
  document.body.appendChild(layerEl);

  if (escHandler) document.removeEventListener('keydown', escHandler, true);
  escHandler = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    event.preventDefault();
    closeLayer();
  };
  document.addEventListener('keydown', escHandler, true);

  if (nodes.prompt) nodes.prompt.value = '';
  if (nodes.scene) nodes.scene.value = '';
  if (nodes.status) nodes.status.textContent = '说一句你想改善的地方就行 —— 它会写成能直接用的规则';
  updateButtons();

  nodes.prompt.focus();
}

function updateButtons() {
  if (!nodes) return;
  if (nodes.go) {
    nodes.go.loading = busy;
    nodes.go.textContent = busy ? '生成中…' : '开始生成';
  }
  if (nodes.stop) nodes.stop.classList.toggle('hidden', !busy);
}

function closeLayer() {
  if (busy) stopGen();
  if (escHandler) {
    document.removeEventListener('keydown', escHandler, true);
    escHandler = null;
  }
  if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
  layerEl = null;
  nodes = null;
}

function buildLayer() {
  layerEl = h('div', { class: 'modal ai-gen-modal preset-ai-modal' });

  const prompt = mTextarea({
    id: 'preset-ai-prompt',
    rows: '5',
    spellcheck: 'false',
    placeholder:
      '例如：回复总是太长、太爱总结，想让它短下来、把话说一半；或者：剧情老在原地打转，希望每一轮都往前推一步；或者：想写长文，每轮 2000 字以上'
  });

  const scene = mTextarea({
    id: 'preset-ai-scene',
    rows: '2',
    spellcheck: 'false',
    placeholder: '可选。例如：古风权谋，两个人隔着礼数试探；或者：深夜便利店里的日常闲聊。不填就写成通用的'
  });

  const status = h('p', { class: 'ai-gen-status' });

  const stopBtn = mButton({ variant: 'ghost', text: '中止', onClick: stopGen });
  stopBtn.classList.add('hidden');

  const goBtn = mButton({ variant: 'primary', text: '开始生成', onClick: generate });

  const card = h(
    'div',
    { class: 'modal-card ai-gen-card' },
    h(
      'header',
      { class: 'modal-head' },
      h(
        'div',
        { class: 'modal-heading' },
        h('h2', { text: 'AI 生成预设' }),
        h('p', {
          class: 'modal-sub',
          text: '描述你想要的效果，AI 写成一整套规则：名字、说明、标签、指令正文'
        })
      ),
      (() => {
        const btn = h('button', { class: 'icon-btn', type: 'button', title: '关闭（Esc）', 'aria-label': '关闭' });
        btn.innerHTML = iconHtml('close');
        btn.addEventListener('click', closeLayer);
        return btn;
      })()
    ),
    h(
      'div',
      { class: 'modal-body ai-gen-body' },
      field({
        label: '想要的效果',
        control: prompt,
        stack: true,
        hint: '说「现在哪里不对」比说「要什么风格」更好使：说症状，模型才知道往哪改。要篇幅就直接给数字（「每轮 2000 字」），它会拆成段数 + 每段字数。三五行就够，写太细会被它当成剧情。'
      }),
      field({
        label: '适用场次（可选）',
        control: scene,
        stack: true,
        hint: '这套规则主要用在哪类对话里。填了用词会更贴，但不会把具体人物和剧情写进规则里。'
      }),
      status
    ),
    h(
      'footer',
      { class: 'modal-foot' },
      h('span', { class: 'foot-hint', text: '生成结果会填进预设编辑器，点「保存」才真正创建' }),
      h('div', { class: 'foot-actions' }, stopBtn, goBtn)
    )
  );

  card.addEventListener('click', (event) => event.stopPropagation());
  layerEl.appendChild(card);
  layerEl.addEventListener('click', closeLayer);

  nodes = { prompt, scene, status, go: goBtn, stop: stopBtn };
}

function stopGen() {
  if (!busy) return;
  if (currentGenId) {
    api.stopChat(currentGenId).catch((err) => console.warn('[presetAi] 中止请求失败:', err));
  }
  currentGenId = null;
  busy = false;
  updateButtons();
  if (nodes && nodes.status) nodes.status.textContent = '已中止';
}

async function generate() {
  if (busy) return;

  const prompt = String((nodes.prompt && nodes.prompt.value) || '').trim();
  if (!prompt) {
    showToast('先写一句你想要的效果吧', 'error');
    if (nodes.prompt) nodes.prompt.focus();
    return;
  }

  const target = resolveGenTarget();
  if (!target) return;
  const { endpoint, bridge } = target;

  const system = PRESET_SYSTEM + sceneSection(nodes.scene && nodes.scene.value);

  const requestId = uid();
  currentGenId = requestId;
  busy = true;
  updateButtons();
  if (nodes.status) nodes.status.textContent = bridge ? '本地模型正在写规则…可能要等 30~60 秒' : '正在写规则…';

  try {
    const response = await api.sendChat({
      requestId,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `我想要的效果：${prompt}\n\n请直接输出这条预设的 JSON。` }
      ],
      noImage: true
    });

    if (currentGenId !== requestId) return;

    if (!response || response.ok !== true) {
      const message = (response && response.error) || '调用失败';
      if (/abort|中止|cancel/i.test(message)) {
        if (nodes && nodes.status) nodes.status.textContent = '已中止';
        return;
      }
      showToast(message, 'error');
      if (nodes && nodes.status) nodes.status.textContent = message;
      return;
    }

    const parsed = parseGeneratedPreset(generationText(response, bridge));
    if (!parsed.ok) {
      showToast(`${parsed.error}，已把原文放进正文里，你自己整理一下`, 'error');
      acceptDraft({ name: '未命名预设', note: '', tags: [], content: parsed.raw });
      return;
    }

    acceptDraft(parsed.fields);
  } catch (err) {
    if (currentGenId !== requestId) return;
    const message = (err && err.message) || '生成失败';
    if (/abort|中止|cancel/i.test(message)) {
      if (nodes && nodes.status) nodes.status.textContent = '已中止';
      return;
    }
    showToast(message, 'error');
  } finally {
    if (currentGenId === requestId) {
      currentGenId = null;
      busy = false;
      updateButtons();
    }
  }
}

function acceptDraft(fields) {
  const opened = startDraft(fields);
  if (!opened) {
    showToast('没能打开预设编辑器，生成的内容没保存', 'error');
    return;
  }
  closeLayer();
}
