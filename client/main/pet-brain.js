'use strict';

// 桌宠「说话」：拼提示词、调模型、把回复切成几句。
// ⚠️ 绝不能改成复用 ipcMain 的 chat:send：那条链路固定往 chat:chunk 推，宠物的字会混进角色气泡；上下文是主界面递进来的一小包（renderer/js/data/petContext.js）。

const { endpointFor, isBridgeProvider, loadSettings } = require('./providers.js');
const { streamChat, bridgeChat } = require('./http.js');
const { recordRequest } = require('./request-log.js');
const { readPersona, petMemoryItems, petMemoryDigest } = require('./pet-store.js');

/** 宠物回复的 token 上限。它只说几句话，给多了纯粹是让模型自由发挥 + 多花钱。 */
const PET_MAX_TOKENS = 2048;
/** 一条记忆最多留多少字（超出截断，别让一条长回复把记忆撑爆） */
const MAX_MEMORY_TEXT = 300;
/** 最近说过几句要带上（防复读） */
const RECENT_SAY_LIMIT = 5;

// 输出解析

/** 「【记住】：xxx」和「剧情选项」同一套写法（见 renderer/js/data/suggestions.js），模型已被训练出这个习惯。 */
const REMEMBER_RE = /^[【\[]\s*记住\s*[】\]]\s*[：:]\s*(.+)$/;

function cleanLine(raw) {
  let line = String(raw || '').trim();
  if (!line) return '';
  // ⚠️ `*` 只当加粗 / 项目符号处理，条件是后面跟着空格：写成 `^[-*•·]\s*` 会把 `*歪头*` 的开头星号吃掉，
  //    渲染层（pet.js 的 *…* 正则）再也匹配不上，动作会原样显示成带星号的怪文字。
  line = line.replace(/^(?:[-•·]\s*|\*\s+)/, '');
  line = line.replace(/^\d+\s*[.、)）:：]\s*/, '');
  // 模型爱把整句包在引号里
  line = line.replace(/^[「『"'“”‘’]+/, '').replace(/[」』"'“”‘’]+$/, '');
  // 加粗标记在气泡里会原样显示，直接抹掉（`*…*` 不在此列，那是动作标记）
  line = line.replace(/\*\*/g, '');
  return line.trim();
}

/** 把回复切成几句：先按换行取，不够再按句末标点切 —— 模型常写成一大段。
 *  谁切出来的句子多用谁，目标是「用户要 3 句就真的有 3 句」。 */
function splitIntoLines(text, count) {
  const want = Math.max(1, Math.min(20, Math.round(Number(count) || 1)));
  const body = String(text || '')
    .split('\n')
    .filter((line) => !REMEMBER_RE.test(line.trim()))
    .join('\n');

  let parts = body.split('\n').map(cleanLine).filter(Boolean);
  if (parts.length < want) {
    const sentences = body.split(/(?<=[。！？!?…])/).map(cleanLine).filter(Boolean);
    if (sentences.length > parts.length) parts = sentences;
  }
  return parts.slice(0, want);
}

/** 抽出「【记住】：xxx」那行（没有就返回空串） */
function extractMemory(text) {
  for (const raw of String(text || '').split('\n')) {
    const m = raw.trim().match(REMEMBER_RE);
    if (m) return m[1].trim().slice(0, MAX_MEMORY_TEXT);
  }
  return '';
}

// 提示词

function formatRecent(recent) {
  const list = Array.isArray(recent) ? recent : [];
  if (!list.length) return '（还没有开始聊）';

  return list
    .map((m) => {
      const who = String((m && m.name) || '').trim() || (m && m.role === 'user' ? '用户' : '角色');
      const text = String((m && m.text) || '').trim().slice(0, 400);
      return text ? `${who}：${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function formatMemoryItems(petId) {
  const items = petMemoryItems(petId);
  const recent = items.slice(-12);
  if (!recent.length) return '';
  return recent
    .map((m) => `- ${m.kind === 'say' ? '我说过：' : ''}${m.text}`)
    .join('\n');
}

function formatRecentSays(petId) {
  const says = petMemoryItems(petId)
    .filter((m) => m.kind === 'say')
    .slice(-RECENT_SAY_LIMIT);
  if (!says.length) return '';
  return says.map((m) => `- ${m.text}`).join('\n');
}

function buildSystemPrompt(persona, pet) {
  const lines = [
    String(persona || '').trim(),
    '',
    '──── 你现在要做的 ────',
    `用户正在用「如我所书」跟角色聊天 / 玩世界书。看下面给你的「刚刚发生了什么」，` +
      `以你自己的身份说 ${pet.speakLines} 句话，像坐在旁边看戏的朋友随口搭一句。`,
    '',
    '要求：',
    `1. 正好 ${pet.speakLines} 句，**一句一行**，不要编号、不要引号、不要小标题。`,
    '2. 每句短一点（6~30 字），是搭话不是总结，别写成作文。',
    '3. 可以偶尔加一个 *动作*（比如 *歪头*），但不要每句都加。',
    '4. 先看懂在发生什么：用户在谈恋爱就嗑、在吵架就劝或看热闹、被欺负了就替他不平。',
    '5. **不要跳进剧情**：不替角色说话、不替用户做决定、不要写成小说旁白。',
    '6. 不要复读下面列出的「你最近说过的话」。',
    '7. 不要提「我是 AI / 语言模型」这类话。'
  ];

  if (pet.style) {
    lines.push('', '──── 用户给你定的说话风格（优先遵守）────', String(pet.style).trim());
  }

  lines.push(
    '',
    '──── 可选：记一笔 ────',
    '说完之后，如果你确实观察到值得长期记住的事（用户的偏好、正在发生的大事），',
    '另起一行写 `【记住】：<一句话>`。没有就不写这一行 —— **不要为了写而写**。'
  );

  return lines.join('\n');
}

function buildUserPrompt({ pet, request }) {
  const ctx = request || {};
  const blocks = [];

  const head = [];
  if (ctx.convoTitle) head.push(`会话：${String(ctx.convoTitle).slice(0, 80)}`);
  if (ctx.characters) head.push(`在场：${String(ctx.characters).slice(0, 120)}`);
  if (head.length) blocks.push(`【现在在聊什么】\n${head.join('\n')}`);

  const digest = petMemoryDigest(pet.id);
  const items = formatMemoryItems(pet.id);
  if (digest || items) {
    blocks.push(
      `【你记得的事（这是你的长期记忆，只在真的相关时提一句，别硬塞）】\n` +
        [digest ? `更早以前的印象：${digest}` : '', items].filter(Boolean).join('\n')
    );
  }

  const says = formatRecentSays(pet.id);
  if (says) blocks.push(`【你最近说过的话（别重复）】\n${says}`);

  if (ctx.summary) {
    blocks.push(`【更早之前发生了什么（剧情摘要）】\n${String(ctx.summary).slice(0, 1500)}`);
  }

  blocks.push(`【刚刚发生了什么】\n${formatRecent(ctx.recent)}`);

  if (ctx.panel) blocks.push(`【当前状态】\n${String(ctx.panel).slice(0, 400)}`);

  return blocks.join('\n\n');
}

// 端点选择（含回退）

/** 宠物可用的端点，按优先级排。⚠️ 最后一定垫着主模型 —— 单独指定的那个挂了，宠物不该从此变哑巴。 */
function petEndpoints(settings, pet) {
  const list = [];
  if (!pet.useMainModel) {
    const own = endpointFor(settings, pet.providerId, pet.model);
    if (own) list.push(own);
  }
  const main = endpointFor(settings, null, null);
  if (main && !list.some((e) => e.providerId === main.providerId && e.model === main.model)) {
    list.push(main);
  }
  return list;
}

function endpointReady(settings, endpoint) {
  if (!endpoint) return false;
  const provider = (settings.providers || []).find((p) => p.id === endpoint.providerId);
  if (isBridgeProvider(provider)) return true; // 本机桥接免 Key
  return !!endpoint.apiKey;
}

// 生成

/** 让桌宠说一次话。onDelta 是流式回调 —— 调用方负责把它接到 pet:chunk。 */
async function generatePetSpeech({ pet, request, onDelta, signal }) {
  if (!pet) return { ok: false, error: '没有可用的桌宠' };

  const settings = loadSettings();
  const candidates = petEndpoints(settings, pet);
  const usable = candidates.filter((e) => endpointReady(settings, e));

  if (!usable.length) {
    return { ok: false, error: '还没有配置可用的模型服务，宠物不知道该怎么说话。' };
  }

  const persona = readPersona(pet.id);
  const messages = [
    { role: 'system', content: buildSystemPrompt(persona, pet) },
    { role: 'user', content: buildUserPrompt({ pet, request }) }
  ];

  const errors = [];

  for (let index = 0; index < usable.length; index += 1) {
    const endpoint = usable[index];
    // 温度比聊天略高是刻意的：宠物要的是「有个性」，不是「准确」。
    const temperature = Number.isFinite(pet.temperature) ? pet.temperature : settings.temperature;
    const tuned = {
      ...endpoint,
      temperature: Number.isFinite(temperature) ? temperature : 0.85,
      maxTokens: Math.max(512, Math.min(Number(endpoint.maxTokens) || PET_MAX_TOKENS, PET_MAX_TOKENS))
    };

    const provider = (settings.providers || []).find((p) => p.id === endpoint.providerId);
    const bridge = isBridgeProvider(provider);
    const requestId = `pet-${Date.now().toString(36)}`;

    try {
      let text = '';

      if (bridge) {
        // 桥接默认会判定要不要出图（卸模型 + 出图 + 热回来），宠物只说一句话不值得等；noImage 跳过这段。
        const result = await bridgeChat({
          settings: tuned,
          messages,
          characterContext: '',
          noImage: true,
          signal
        });
        text = String((result && result.content) || '');
      } else {
        const result = await streamChat({
          settings: tuned,
          messages,
          signal,
          // 宠物也在花钱，请求记录里留一份（记的是最终 body）。
          onRequest: (body, url) => recordRequest({ requestId, providerName: `桌宠 · ${tuned.providerName}`, url, body }),
          onDelta: (delta) => {
            if (typeof onDelta === 'function') onDelta(delta);
          }
        });
        text = String((result && result.content) || '');
      }

      const lines = splitIntoLines(text, pet.speakLines);
      if (!lines.length) {
        errors.push(`${endpoint.providerName}/${endpoint.model} 没有返回内容`);
        continue;
      }

      return {
        ok: true,
        lines,
        text: lines.join('\n'),
        memory: extractMemory(text),
        providerName: endpoint.providerName,
        model: endpoint.model,
        tried: index + 1
      };
    } catch (err) {
      const message = (err && err.message) || '未知错误';
      if (signal && signal.aborted) return { ok: false, error: '已停止' };
      errors.push(`${endpoint.providerName}/${endpoint.model}：${message}`);
    }
  }

  return { ok: false, error: errors.join('；') || '生成失败' };
}

module.exports = {
  generatePetSpeech,
  // 导出这几个是为了能在裸 node 里单独测「切句」和「抽记忆」这两条纯逻辑
  splitIntoLines,
  extractMemory,
  petEndpoints
};
