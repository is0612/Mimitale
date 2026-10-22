'use strict';

// 这个视图负责「AI 生成角色」弹窗：角色库入口生成通用角色，世界书入口按这本书的设定生成 NPC；生成完不落盘，交给角色编辑器开草稿。
// ⚠️ 不要用 data/messages.js 的 buildApiMessages：它会带上对话历史和世界书命中，拿来写生成任务是错的。
// ⚠️ 本机桥接返回 { text, image }，文字在 text 里而非 choices[].message；生成期间 force_image 一律关（出图 30~40 秒）。

import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { uid } from '../core/util.js';
import { h } from '../ui/build.js';
import { iconHtml } from '../ui/icons.js';
import { field } from '../ui/controls.js';
import { mTextarea, mButton } from '../components/index.js';
import { showToast } from '../ui/toast.js';
import { currentEndpoint, isBridgeProvider } from '../data/providers.js';
import { worldbookCharacters } from '../data/library.js';

// --- 提示词 ---

// ⚠️ 措辞必须是「一旦变化就必须输出」：写成「只在变化时输出」，模型会自行判断「这轮没变」把整行省掉，状态栏就再不更新。
const MODE_RULE = 'mode 用 static 表示平时几乎不动的（身高、体重、身份这类），' +
  '用 dynamic 表示会随剧情变动的（好感度、金钱、穿着这类）——' +
  'dynamic 的字段一旦这一轮发生了跟它有关的事就必须输出。拿不准就写 dynamic。';

const FIELDS_SPEC = `严格按照下面的 JSON 结构输出，不要输出任何多余的文字、解释或 Markdown 代码块标记：

{
  "name": "角色名",
  "description": "角色描述，交代身份、外貌、年龄、处境。第三人称，具体有画面感",
  "personality": "性格、说话方式、立场、与玩家的关系。要写出辨识度，避免空泛形容词堆砌",
  "scenario": "你们此刻在哪里、正在做什么，一两句",
  "firstMes": "开场白，按下面「写法」那一段的要求写",
  "mesExample": "{{user}}: ……\\n{{char}}: ……\\n\\n<START>\\n\\n{{user}}: ……\\n{{char}}: ……",
  "tags": ["标签", "标签"],
  "attributes": [
    { "name": "字段名", "type": "text", "value": "初始值", "mode": "dynamic" }
  ]
}

attributes 给 3~8 条，每条包含 name / type / value / mode 四个键。
type 只能是 text（文字）、meter（数值，可另带 min / max）、list（多项用「、」隔开）三种。
${MODE_RULE}
字段名要贴合这个角色的身份和处境，禁止用「属性1」「好感度」这种泛称（可以是「对你的戒心」「口袋里的铜板」「今日穿着」这类）。

【同一场戏硬约束】
scenario、firstMes、mesExample 必须是**同一时间、同一地点、同一件正在发生的事**。
禁止三者时间或地点错位，禁止 mesExample 另起一个新场景。

字符串里的换行一律写成 \\n —— 这是 JSON，值里不能直接断行：

· description：第三人称。必须有画面感，并包含外貌特征与至少一个动态细节；不要把所有特点一次列成清单。
  从走路姿态、随身物件、与环境的互动、一个习惯性动作等细节里挑重点，通常选 1~2 个最能体现角色的即可。
  这些细节用于让读者认识角色，不代表角色之后每轮都必须重复做同一个动作。
· personality：用具体说话方式、判断习惯、情绪处理方式和关系态度体现性格，禁止堆砌「温柔善良」「认真努力」这类空泛词。
  必须写清楚：
  - 她平时怎么说话（口头禅、句式、紧张时语速或措辞会怎样）
  - 她的一个明显小缺点或执念
  - 对 {{user}} 的具体态度（她最希望从你这里得到什么反馈/对待方式）
  - 如有标志性小动作，要写清它通常在什么情境下出现；它是偶尔流露的习惯，不是每次回应都要执行的固定动作。
  description 与 personality 分工补充信息，不要把同一个小动作在两处重复描述或同时列出一串相似动作。
· 描写密度与细节去重（重要）：
  - 角色鲜明不等于每句话都要配动作。动作只在推动情节、表达情绪变化或补充必要信息时使用。
  - 一次普通回应通常突出 0~1 个有意义的动作/神态即可；确有连续动作或明确因果时才继续写，不要把搓衣角、抿嘴、低头、抬眼、捏物件等小动作串成流水账。
  - 同一个标志性动作不要连续几轮原样复现。再次使用时必须有当前情境的理由，或让它体现出不同的情绪/含义；没有必要就直接写台词或推进事情。
  - 不要为了体现性格而每轮强行安排环境描写、心理解释或动作。信息已经由台词表达清楚时，不再用旁白换种说法解释一遍。
· scenario：只交代「你们现在在哪儿、正在做什么」，一两句话。别写事件经过 —— 那是开场白的活。
· firstMes：一幕登场，分三段、段与段之间空一行（即用 \\n\\n 分隔）：
  ① 定场 —— 时间 + 地点 + {{user}} 此刻在做的事，一两句，要有画面，但不必铺满环境细节
  ② 登场 —— 选择 {{char}} 一个最能表现当下状态的动作或神态，紧接着一句直接对 {{user}} 说出口的话
  ③ 话头 —— **必须停在一个明确需要 {{user}} 立刻回应的具体请求或问题上**。
     禁止软绵绵的开放式结尾（例如「你想聊什么都可以」「随便坐坐」「有空再来玩」）。
     好的话头方向：请对方指出具体问题、帮忙做一件眼前的事、回答她正在纠结的点、对她刚才的行为给出真实评价。
  双方一律用 {{char}} 和 {{user}} 这两个占位符，不要写死名字。整段 200~400 字；不得为了凑字数重复动作、景物或心理。
  禁止流水账、禁止大段内心独白、禁止直接总结性格。
· mesExample：2~3 组示范，每组严格两行、以占位符加冒号开头：
  {{user}}: 玩家说的话
  {{char}}: 角色的回应（可以带动作描写，但不要求每条都带）
  组与组之间用单独一行 <START> 隔开。
  **所有示例必须发生在 firstMes 停住的那个瞬间之后**，继续同一场景里的互动，禁止跳到别的时间或地点。
  示例要展示不同的回应节奏：至少一组以自然台词为主，不靠动作撑篇幅；其它组如需动作，也只写与当下反应相关的重点。不要在每组里重复同一个标志性动作。
  要能听出这个人的说话习惯、口头禅、态度，不要写任何旁白说明。`;

const LIBRARY_SYSTEM = `你是一位经验丰富的角色设定师，负责把一个简短的描述扩写成一张完整、好用的角色卡。

${FIELDS_SPEC}

质量要求（按优先级）：
1. 先想清楚这个角色处在什么世界、什么基调里，再动笔 —— 描写用词必须和那个基调一致
   （日常治愈、黑暗奇幻、现代都市、克苏鲁、赛博朋克的写法完全不同）。
2. 角色辨识度靠少量准确的细节建立，不靠动作数量堆起来。description 与 personality 各司其职，避免重复罗列同一习惯。
3. 角色可以有 1~2 个标志性习惯，但必须有触发情境；不要把它写成每轮必做的动作。普通回应可以直接说话、思考或做事，不必强行加动作。
4. firstMes 和 mesExample 要示范自然的描写密度：避免连续堆叠细小动作；示例之间应有变化，至少一组以台词和信息推进为主。
5. personality 必须用具体说话方式、判断和情绪处理习惯体现，禁止空泛形容词。必须写出对 {{user}} 的具体态度。
6. **scenario / firstMes / mesExample 必须是同一场戏**：时间、地点、正在发生的事完全一致。
   firstMes 的结尾必须是一个具体的、需要立刻回应的请求或问题，不能软着陆。
7. 角色要有「可互动性」：不是完美无缺的偶像，要有小缺点、小执念、小矛盾，方便后续剧情推进。
8. 只输出 JSON 本身，不要任何解释或代码块标记。`;

function briefSection(brief) {
  const text = String(brief || '').trim();
  if (!text) return '';
  return `\n\n【背景 / 基调】\n${text}\n\n角色的设定、用词、世界观必须严格贴合上面这个背景，不要另起一套。`;
}

const BOOK_SYSTEM_TAIL = `这是一位要在「世界」里出场的配角（NPC），不是主角，也不是玩家自己。

额外要求：
· 先读已有的角色名单和世界设定，新角色必须和它们明显区分开，不要重复或改写已有的人。
· description 和 personality 加起来的前 160 字必须写全最重要的信息
  （身份、立场、说话方式、和玩家的关系）—— 超出部分在注入时会被截掉，所以前 160 字要精炼。
· attributes 写这个角色身上会变的东西（好感度、钱、状态、随身物品这类），3~8 条，字段名要贴身份。
· scenario / firstMes / mesExample 必须是同一场戏，按「他第一次和 {{user}} 打交道」的那一刻写；
  firstMes 结尾必须是明确需要立刻回应的具体请求或问题，不能软着陆。
· 只输出 JSON 本身。`;

// 上限：世界书单本最多 5000 条，全喂进去输入就爆了
const MAX_ENTRY_CHARS = 2400;
const MAX_ENTRY_COUNT = 12;

function keywordsOf(text) {
  return String(text || '')
    .split(/[\s,，、。.；;：:！!？?（）()【】\[\]"'“”‘’]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 30);
}

function pickEntries(book, prompt, budget) {
  const entries = (Array.isArray(book.entries) ? book.entries : []).filter(
    (e) => e && e.enabled !== false && String(e.content || '').trim()
  );
  if (!entries.length) return [];

  const words = keywordsOf(prompt);
  const score = (entry) => {
    const title = String(entry.title || '');
    const content = String(entry.content || '');
    let hits = entry.constant === true ? 1 : 0;
    for (const w of words) {
      if (title.includes(w)) hits += 3;
      if (content.includes(w)) hits += 1;
    }
    return hits;
  };

  const ranked = entries
    .map((entry, index) => ({ entry, index, hits: score(entry) }))
    .sort((a, b) => (b.hits - a.hits) || (a.index - b.index));

  const out = [];
  for (const item of ranked) {
    if (item.hits <= 0 && out.length) break;
    out.push(item.entry);
    if (out.length >= MAX_ENTRY_COUNT) break;
  }

  const picked = [];
  let used = 0;
  for (const entry of out) {
    const text = `【${entry.title}】\n${String(entry.content).trim()}`;
    if (used + text.length > budget) break;
    picked.push(text);
    used += text.length;
  }
  return picked;
}

function buildBookContext(book, prompt) {
  const parts = [`【世界：${book.name}】`];

  const opening = String(book.opening || '').trim();
  if (opening) parts.push(`【开场白】\n${opening.slice(0, 800)}`);

  const copies = worldbookCharacters(book);
  if (copies.length) {
    const names = copies.map((c) => c.name).filter(Boolean).join('、');
    if (names) parts.push(`【这个世界已有的角色】\n${names}\n请生成一个和上面这些人都明显不同的新角色，不要重复或改写他们。`);
  }

  const entries = pickEntries(book, prompt, MAX_ENTRY_CHARS);
  if (entries.length) parts.push(`【世界设定】\n${entries.join('\n\n')}`);

  return parts.join('\n\n');
}

// --- 取模型返回的正文 ---

/** 桥接返回 { text, image }，直连返回 { content } —— 两种形状都在这里收口 */
export function generationText(response, bridge) {
  if (!response) return '';
  if (bridge) return String(response.text || '');
  return typeof response.content === 'string' ? response.content : '';
}

/**
 * 生成任务要打哪一路：没配服务 / 没填 Key 时弹提示并返回 null。
 * ⚠️ 「AI 生成角色」和编辑器里的「AI 补设定」共用这一份 —— 两边各写一遍，
 *    迟早有一边漏掉桥接判断（桥接 provider 没有 apiKey，照样能生成）。
 */
export function resolveGenTarget() {
  const endpoint = currentEndpoint();
  if (!endpoint || !endpoint.provider) {
    showToast('还没有配置模型服务，请先在设置里添加', 'error');
    return null;
  }
  const bridge = isBridgeProvider(endpoint.provider);
  if (!bridge && !endpoint.provider.apiKey) {
    showToast(`还没有填写「${endpoint.provider.name}」的 API Key`, 'error');
    return null;
  }
  return { endpoint, bridge };
}

// --- 解析模型输出 ---

/** 去掉 ```json 围栏和正文前后的解释文字，只留下最外面那个花括号块 */
export function extractJsonBlock(raw) {
  let text = String(raw || '').trim();

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  return text;
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 按顺序找第一个非空字符串（兼容 first_mes / greeting 等变体） */
function pickStr(json, keys, max) {
  for (const key of keys) {
    const text = str(json[key], max);
    if (text.trim()) return text;
  }
  return '';
}

/** 标签：字符串数组，逗号串也收 */
function parseTags(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、]/)
      : [];
  return list
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim().slice(0, 40))
    .slice(0, 20);
}

/** 只留 normalizePanelField 认得的键，形状不对的整条丢掉 */
function parseAttrs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = str(item.name, 40).trim();
    if (!name) continue;
    if (out.some((a) => a.name === name)) continue;

    const rawType = String(item.type || '').toLowerCase();
    const type = rawType === 'number' || rawType === 'meter' ? 'meter' : rawType === 'list' ? 'list' : 'text';
    const value0 = item.value;
    let fieldValue = value0;
    if (type === 'text' && typeof value0 !== 'string') {
      fieldValue = String(value0 == null ? '' : value0);
    } else if (type === 'list' && Array.isArray(value0)) {
      fieldValue = value0
        .filter((v) => typeof v === 'string' && v.trim())
        .map((v) => v.trim())
        .join('、');
    }

    const field = { name, type, value: fieldValue == null ? '' : fieldValue };
    const finiteNumber = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string' && v.trim() === '') return null;
      return Number(v);
    };
    if (type === 'meter') {
      const max = finiteNumber(item.max);
      const min = finiteNumber(item.min);
      if (Number.isFinite(max)) field.max = max;
      if (Number.isFinite(min)) field.min = min;
    }
    if (String(item.mode || '').trim().toLowerCase() === 'static') field.mode = 'static';

    out.push(field);
    if (out.length >= 40) break;
  }
  return out;
}

export function parseGeneratedCharacter(raw) {
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

  const name = str(json.name, 120).trim();
  const description = str(json.description, 20000);
  const personality = str(json.personality, 10000);
  if (!name && !description.trim()) {
    return { ok: false, error: '模型没有给出可用的角色内容', raw: String(raw || '') };
  }

  return {
    ok: true,
    fields: {
      name: name || '未命名角色',
      description,
      personality,
      scenario: pickStr(json, ['scenario'], 10000),
      firstMes: pickStr(json, ['firstMes', 'first_mes', 'greeting'], 10000),
      mesExample: pickStr(json, ['mesExample', 'mes_example', 'exampleDialogue', 'example'], 30000),
      tags: parseTags(json.tags),
      attributes: parseAttrs(json.attributes)
    }
  };
}

// --- 弹窗 ---

let layerEl = null;
let nodes = null;
let busy = false;
let currentGenId = null;
let escHandler = null;
let scope = 'library';
let targetBook = null;

let startDraft = () => {
  console.error('[aiGen] startDraft 还没接线，生成的内容没法交出去');
  return false;
};

export function initAiGen(opts = {}) {
  if (typeof opts.startDraft === 'function') startDraft = opts.startDraft;
}

function bookFor(id) {
  const list = Array.isArray(state.worldbooks) ? state.worldbooks : [];
  return list.find((w) => w.id === id) || null;
}

export function openAiGenModal(options = {}) {
  if (layerEl) closeLayer();

  scope = options.scope === 'worldbook' ? 'worldbook' : 'library';
  targetBook = scope === 'worldbook' ? bookFor(options.bookId) : null;

  if (scope === 'worldbook' && !targetBook) {
    showToast('找不到这本书，先在世界书列表里打开它', 'error');
    return;
  }

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
  if (nodes.brief) nodes.brief.value = '';
  if (nodes.status) {
    nodes.status.textContent =
      scope === 'worldbook' ? `将依据《${targetBook.name}》的设定生成 NPC` : '把你想做的角色大致描述一下就行';
  }
  updateButtons();

  nodes.prompt.focus();
}

function updateButtons() {
  if (!nodes) return;
  if (nodes.go) {
    // loading 自带「不可点」：转圈圈 + 文字一起变，用户一眼知道在等
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
  layerEl = h('div', { class: 'modal ai-gen-modal' });

  const prompt = mTextarea({
    id: 'ai-gen-prompt',
    rows: '5',
    spellcheck: 'false',
    placeholder:
      scope === 'worldbook'
        ? '例如：酒馆里跑堂的小二，嘴碎爱偷听客人讲话；或者咖啡店的老板娘，性子冷淡但记得每个熟客的口味'
        : '例如：一只在图书馆值夜班的猫，说话爱绕弯子，喜欢用比喻'
  });

  const brief = scope === 'library'
    ? mTextarea({
        id: 'ai-gen-brief',
        rows: '2',
        spellcheck: 'false',
        placeholder: '可选。例如：现代都市的深夜便利店；或者中世纪魔法学院。不填就由 AI 自己定'
      })
    : null;

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
        h('h2', { text: scope === 'worldbook' ? 'AI 生成 NPC' : 'AI 生成角色' }),
        h('p', {
          class: 'modal-sub',
          text:
            scope === 'worldbook'
              ? '按这本书的设定生成一个配角（含描述、性格、场景、开场白、示例对话），生成完还可以自己改'
              : '描述一下你想做的角色，AI 补全成一张角色卡：描述、性格、场景、开场白、示例对话都有'
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
      brief ? field({ label: '背景 / 基调（可选）', control: brief, stack: true }) : null,
      field({ label: '角色描述', control: prompt, stack: true }),
      status
    ),
    h(
      'footer',
      { class: 'modal-foot' },
      h('span', { class: 'foot-hint', text: '生成结果会填进角色编辑器，点「保存」才真正创建' }),
      h('div', { class: 'foot-actions' }, stopBtn, goBtn)
    )
  );

  card.addEventListener('click', (event) => event.stopPropagation());
  layerEl.appendChild(card);
  layerEl.addEventListener('click', closeLayer);

  nodes = { prompt, brief, status, go: goBtn, stop: stopBtn };
}

function stopGen() {
  if (!busy) return;
  if (currentGenId) {
    api.stopChat(currentGenId).catch((err) => console.warn('[aiGen] 中止请求失败:', err));
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
    showToast('先写一句角色描述吧', 'error');
    if (nodes.prompt) nodes.prompt.focus();
    return;
  }

  const target = resolveGenTarget();
  if (!target) return;
  const { endpoint, bridge } = target;

  const system =
    scope === 'worldbook' && targetBook
      ? `${LIBRARY_SYSTEM}\n\n${BOOK_SYSTEM_TAIL}\n\n以下是这本书的设定：\n\n${buildBookContext(targetBook, prompt)}`
      : LIBRARY_SYSTEM + briefSection(nodes.brief && nodes.brief.value);

  const requestId = uid();
  currentGenId = requestId;
  busy = true;
  updateButtons();
  if (nodes.status) nodes.status.textContent = bridge ? '本地模型正在生成…可能要等一会儿（约 30~60 秒）' : '正在生成…';

  try {
    const response = await api.sendChat({
      requestId,
      providerId: endpoint.provider.id,
      model: endpoint.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `角色描述：${prompt}\n\n请直接输出那张角色卡的 JSON。` }
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

    const parsed = parseGeneratedCharacter(generationText(response, bridge));
    if (!parsed.ok) {
      showToast(`${parsed.error}，已把原文放进描述里，你自己整理一下`, 'error');
      acceptDraft({
        name: '未命名角色',
        description: parsed.raw,
        personality: '',
        tags: [],
        attributes: []
      });
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
  const opened = startDraft(fields, scope, targetBook ? targetBook.id : null);
  if (!opened) {
    showToast('没能打开角色编辑器，生成的内容没保存', 'error');
    return;
  }
  closeLayer();
}