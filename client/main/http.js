'use strict';

// 大模型 HTTP 请求：用 Node 自带模块，不依赖第三方库。
// 端点拼接与清洗、JSON 请求、二进制下载、SSE 流式对话，以及把网络 / HTTP 错误翻译成人话。

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const { DEFAULT_BASE_URL, DEFAULT_MODEL } = require('./providers.js');

// ⚠️ 只在这里写一次：部分服务商前面的 WAF 对没有 UA 的请求直接拒绝（403 / 406），
// 而不是接口错误码，所以要显式带。地址跟着仓库走 —— 换过一次仓库，当时散在三处的
// 副本只有一处跟着改了，另外两处（本机桥接的聊天和生图）一直指着旧地址。
const USER_AGENT = 'Mimitale/1.0 (+https://github.com/is0612/Mimitale)';

function buildHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': USER_AGENT
  };
  if (settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  return headers;
}

/** 剥掉接口地址末尾多余的端点路径：用户常把完整端点当接口地址粘进来，再拼一次就 404。
 *  只认自己也会拼的那几个后缀，不做「猜」的匹配 —— 免得吃掉 /v4、/api 这类正常路径。 */
const ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/images/generations',
  '/embeddings',
  '/models'
];

function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');

  // 可能连贴两次，循环剥干净
  for (let guard = 0; guard < 4; guard += 1) {
    const hit = ENDPOINT_SUFFIXES.find((s) => url.toLowerCase().endsWith(s));
    if (!hit) break;
    url = url.slice(0, -hit.length).replace(/\/+$/, '');
  }

  return url;
}

function modelsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

function chatUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

function imagesUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/images/generations`;
}

function embeddingsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/embeddings`;
}

// 本机酒馆桥接不是 OpenAI 兼容协议：聊天走 /chat_with_image，健康检查走 /health。
function bridgeChatUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat_with_image`;
}

function bridgeHealthUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/health`;
}

/** 目标协议对应的 Node transport */
function transportOf(target) {
  return target.protocol === 'http:' ? http : https;
}

/** 目标端口：URL 没写时按协议补默认端口 */
function portOf(target) {
  return target.port || (target.protocol === 'http:' ? 80 : 443);
}

/** 下载图片的体积上限 —— 远超任何正常生图结果，只拦「对面给了个巨型文件」 */
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** 下载二进制文件（生图接口有时直接给链接），响应体当 Buffer 收着。
 *  三道闸：重定向最多跟 5 跳（防环）、Location 可以是相对地址、超过 40MB 就掐断。 */
function downloadBinary(url, timeoutMs = 120000, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error('图片链接格式不对。'));
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error('图片链接只支持 http / https。'));
      return;
    }

    const transport = transportOf(target);
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: portOf(target),
        path: `${target.pathname}${target.search}`,
        method: 'GET'
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 已交给下一跳处理：旧响应体的断流不能覆盖下一跳的结果。
          res.on('error', () => {});
          res.resume(); // 3xx 的响应体不要，但得读掉，不然这条连接一直挂着
          if (redirectsLeft <= 0) {
            reject(new Error('下载图片失败：重定向次数太多。'));
            return;
          }
          let next;
          try {
            next = new URL(res.headers.location, target).toString();
          } catch (err) {
            reject(new Error('下载图片失败：重定向地址格式不对。'));
            return;
          }
          downloadBinary(next, timeoutMs, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        res.on('aborted', () => {
          reject(new Error('下载图片失败：响应被中止。'));
        });
        res.on('error', (err) => {
          reject(new Error(`下载图片失败：${normalizeNetworkError(err)}`));
        });
        const declared = Number(res.headers['content-length']);
        if (declared > MAX_DOWNLOAD_BYTES) {
          req.destroy(new Error('下载图片失败：文件太大。'));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on('data', (c) => {
          received += c.length;
          if (received > MAX_DOWNLOAD_BYTES) {
            req.destroy(new Error('下载图片失败：文件太大。'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300 && buffer.length) {
            resolve(buffer);
            return;
          }
          reject(new Error(`下载图片失败（HTTP ${res.statusCode}）。`));
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载图片超时。')));
    req.on('error', (err) => reject(new Error(normalizeNetworkError(err))));
    req.end();
  });
}

/**
 * 一个通用的 JSON 请求（非流式），用于「测试连接」和「拉取模型列表」。
 */
function requestJson({ url, method = 'GET', headers = {}, body = null, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error('接口地址格式不对，请检查「接口地址」这一项。'));
      return;
    }

    const transport = transportOf(target);
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: portOf(target),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Length': payload.length } : {})
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(text));
            } catch (err) {
              reject(new Error(`接口返回的不是合法 JSON（HTTP ${res.statusCode}）。`));
            }
            return;
          }
          reject(new Error(describeHttpError(res.statusCode, text)));
        });
        res.on('aborted', () => {
          reject(new Error('接口响应被中止。'));
        });
        res.on('error', (err) => {
          reject(new Error(normalizeNetworkError(err)));
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时：可能是网络不通，或接口地址写错了。'));
    });
    req.on('error', (err) => {
      reject(new Error(normalizeNetworkError(err)));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function describeHttpError(status, text) {
  // 保留足够长的响应体：网关 / WAF 的 HTML 错误页往往很长，截太短就排查不了。
  const raw = String(text || '').trim();
  const snippet = raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw;

  if (status === 400) return `400 请求被拒绝：多半是参数不被该模型提供商接受（比如 max_tokens 超范围、模型名不对）。\n${snippet}`;
  if (status === 401) return `401 未授权：API Key 不对或已失效。\n${snippet}`;
  if (status === 402) return `402 余额不足：账户需要充值。\n${snippet}`;
  if (status === 403) return `403 拒绝访问：Key 没有该模型的权限，或请求被网关拦截。\n${snippet}`;
  if (status === 404) return `404 找不到接口：多半是「接口地址」写错了，应类似 https://api.deepseek.com。\n${snippet}`;
  if (status === 406) {
    return (
      '406 请求不被接受：服务端（或它前面的网关）拒绝了这次请求的格式。\n' +
      '常见原因，按可能性排序：\n' +
      '  1. 「接口地址」写得不完整或多写了路径 —— 应是官方文档给的根地址（例如智谱是 https://open.bigmodel.cn/api/paas/v4）\n' +
      '  2. 公司网络 / 代理 / VPN 在中间改了请求头\n' +
      '  3. 这个 Key 没有开通该模型的权限\n' +
      '下面这段是服务端原样返回的内容，通常能看出是谁拒绝的：\n' +
      snippet
    );
  }
  if (status === 415) return `415 不支持的内容类型：请求体格式被拒绝。\n${snippet}`;
  if (status === 429) return `429 请求太频繁或超出配额，稍后再试。\n${snippet}`;
  if (status >= 500) return `${status} 服务端错误，通常稍后重试即可。\n${snippet}`;
  return `HTTP ${status}\n${snippet}`;
}

function normalizeNetworkError(err) {
  const code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败：检查网络，或接口地址是否写错。';
  if (code === 'ECONNREFUSED') return '连接被拒绝：接口地址或端口不对。';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时：网络不通，或需要代理。';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'HTTPS 证书校验失败：可能有代理在中间拦截。';
  return (err && err.message) || '未知网络错误。';
}

/** 取第一个能当数字用的值；Number(null) 是 0，所以 null/undefined/空串都得先排除 */
function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** 把服务商各写各的「思考 token」「缓存命中 token」归一：
 *  思考 → usage.reasoning_tokens（有的放 completion_tokens_details，有的在顶层）
 *  缓存 → usage.cached_tokens（DeepSeek 叫 prompt_cache_hit_tokens，OpenAI 在
 *         prompt_tokens_details.cached_tokens，Anthropic 叫 cache_read_input_tokens）
 *  ⚠️ 取错地方界面上就是空白，且看起来像「没省到钱」。 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  if (!Number.isFinite(Number(usage.reasoning_tokens))) {
    const details = usage.completion_tokens_details || usage.output_tokens_details;
    const n = Number(details && details.reasoning_tokens);
    if (Number.isFinite(n)) usage.reasoning_tokens = n;
  }
  if (!Number.isFinite(Number(usage.cached_tokens))) {
    const prompt = usage.prompt_tokens_details || usage.input_tokens_details;
    const hit = firstFinite(
      usage.prompt_cache_hit_tokens,
      prompt && prompt.cached_tokens,
      usage.cache_read_input_tokens
    );
    if (hit !== null) usage.cached_tokens = hit;
  }
  return usage;
}

/** 把服务商塞在响应里的 error 对象/字符串翻译成可读错误：错误帧里通常带真实原因
 *  （额度、权限、模型名），只说「稍后重试」会把排查线索吞掉。 */
function describeProviderError(err) {
  if (typeof err === 'string') return `模型服务返回错误：${err}`;
  const inner = err && typeof err === 'object' ? (err.error || err) : null;
  const message = inner && (inner.message || inner.msg || inner.text);
  const code = inner && (inner.code || inner.status || inner.type);
  const head = code !== undefined && code !== null && code !== '' ? `模型服务返回错误（${code}）：` : '模型服务返回错误：';
  if (message) return `${head}${message}`;
  try { return `${head}${JSON.stringify(err)}`; } catch { return head + '（无法解析的错误内容）'; }
}

/** 流式对话：SSE 逐块解析，通过 onDelta 交出增量，返回 { content, reasoning, usage, finishReason }。
 *  ⚠️ finishReason 是权威收尾信号（'length' 真截断 / 'stop' 模型自己写完），少了上层只能靠「正文为空」猜，
 *     猜错就会把「模型没落笔」说成「额度用光」。onRequest 在请求真正发出前回调一次。 */
function streamChat({ settings, messages, onDelta, onReasoning, signal, onRequest, deadlineMs = 300000, progressTimeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    let deadlineTimer = null;
    let progressTimer = null;
    let settled = false;
    let req = null;
    let res = null;
    let abortHandler = null;
    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (progressTimer) clearTimeout(progressTimer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    let target;
    try {
      target = new URL(chatUrl(settings.baseUrl));
    } catch (err) {
      reject(new Error('接口地址格式不对，请检查「接口地址」这一项。'));
      return;
    }
    if (!settings.apiKey) {
      reject(new Error('还没有填写 API Key，请点左下角「设置」填写。'));
      return;
    }

    const transport = transportOf(target);
    const body = {
      model: settings.model || DEFAULT_MODEL,
      messages,
      stream: true,
      temperature: Number(settings.temperature),
      max_tokens: Math.max(1, Number(settings.maxTokens) || 8192)
    };
    const isDeepSeekThinkingModel = target.hostname === 'api.deepseek.com' && /^(deepseek-flash|deepseek-v4-pro)$/i.test(body.model);
    const useJsonReply = settings.stream === false && !isDeepSeekThinkingModel;
    // DeepSeek flash/pro uses SSE in the tavern so generated text appears progressively.
    if (useJsonReply) body.stream = false;
    if (isDeepSeekThinkingModel) {
      body.thinking = { type: settings.thinking === false ? 'disabled' : 'enabled' };
    }
    if (settings.topP !== undefined && settings.topP !== null && settings.topP !== '') body.top_p = Number(settings.topP);
    if (typeof onRequest === 'function') {
      try { onRequest(body, target.href); } catch (err) { /* 记录失败不能拖垮请求 */ }
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    let buffer = '';
    let content = '';
    let reasoning = '';
    let usage = null;
    let finishReason = '';

    // Socket 活跃不代表模型有进展：角色帧、空增量和心跳都不能续期。
    const progressMs = Number(progressTimeoutMs);
    const resetProgressTimer = () => {
      if (progressTimer) clearTimeout(progressTimer);
      if (settled || finishReason || !Number.isFinite(progressMs) || progressMs <= 0) return;
      progressTimer = setTimeout(() => {
        settle(new Error(content || reasoning
          ? '生成停滞：模型已返回部分内容，但随后长时间没有新的模型输出，请稍后重试。'
          : '生成超时：服务端仅有心跳或空响应，没有返回任何模型输出，请稍后重试。'));
        if (res) res.destroy();
        if (req) req.destroy();
      }, progressMs);
    };
    const finish = () => settle(null, { content, reasoning, usage: normalizeUsage(usage), finishReason });
    const failResponse = (err) => settle(new Error(normalizeNetworkError(err)));
    req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: portOf(target),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: { ...buildHeaders(settings), 'Content-Length': payload.length }
    }, (response) => {
      res = response;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => settle(new Error(describeHttpError(res.statusCode, Buffer.concat(chunks).toString('utf8')))));
        res.on('aborted', () => settle(new Error('接口响应被中止。')));
        res.on('error', failResponse);
        return;
      }

      res.setEncoding('utf8');
      if (useJsonReply) {
        let jsonBody = '';
        res.on('data', chunk => { jsonBody += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(jsonBody);
            if (json.error) { settle(new Error('模型服务返回错误，请稍后重试。')); return; }
            const choice = json.choices && json.choices[0];
            content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
            reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
            usage = json.usage || null;
            finishReason = choice?.finish_reason || '';
            if (!content && !reasoning) { settle(new Error('接口没有返回任何内容。')); return; }
            if (onReasoning && reasoning) onReasoning(reasoning);
            if (onDelta && content) onDelta(content);
            finish();
          } catch { settle(new Error('接口返回的不是合法的对话 JSON。')); }
        });
        res.on('aborted', () => settle(new Error('接口响应被中止。')));
        res.on('error', failResponse);
        return;
      }
      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return true;
        let json;
        try { json = JSON.parse(data); } catch (err) { return false; }
        // 错误帧：HTTP 200 也可能包着 provider 的真实错误（额度 / 权限 / 模型名），必须 reject 而不是当增量吞掉。
        if (json.error) {
          settle(new Error(describeProviderError(json.error)));
          return true;
        }
        if (json.usage) usage = json.usage;
        const choice = json.choices && json.choices[0];
        if (!choice) return false;
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
          if (progressTimer) clearTimeout(progressTimer);
        }
        const delta = choice.delta || choice.message || {};
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          resetProgressTimer();
          if (onReasoning) onReasoning(delta.reasoning_content);
        }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          resetProgressTimer();
          if (onDelta) onDelta(delta.content);
        }
        return false;
      };
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while (!settled && (index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (handleLine(line)) {
            // 终止标记（DONE 或错误帧）：不能等待服务端关闭 keep-alive 连接。
            buffer = '';
            // 错误帧已在 handleLine 里 settle；这里只在仍是成功路径时收尾。
            if (!settled) finish();
            res.destroy();
            return;
          }
        }
      });
      res.on('end', () => {
        if (settled) return;
        if (buffer && handleLine(buffer)) {
          if (!settled) finish();
          return;
        }
        // 部分服务商发 finish_reason 后直接 EOF，不发 [DONE]；它也是权威终止标记。
        if (finishReason) { finish(); return; }
        if (!content && !reasoning) {
          settle(new Error('接口没有返回任何内容。可能是模型名不对，或该模型不支持流式输出。'));
          return;
        }
        // 有 partial 不等于生成成功：EOF 没有 DONE / finish_reason 可能是上游中断。
        settle(new Error('流式响应意外结束：服务端未发送 [DONE] 或 finish_reason，已收到的部分内容未视为成功。'));
      });
      res.on('aborted', () => settle(new Error('接口响应被中止。')));
      res.on('error', failResponse);
    });

    req.setTimeout(useJsonReply ? deadlineMs : 60000, () => req.destroy(new Error('请求超时：模型服务长时间没有响应。')));
    req.on('error', (err) => settle(new Error(signal && signal.aborted ? '已停止生成。' : normalizeNetworkError(err))));
    const ms = Number(deadlineMs);
    if (Number.isFinite(ms) && ms > 0) {
      deadlineTimer = setTimeout(() => {
        settle(new Error(`请求超时：达到 ${ms} 毫秒总时限。`));
        if (res) res.destroy();
        if (req) req.destroy();
      }, ms);
    }
    abortHandler = () => {
      settle(new Error('已停止生成。'));
      if (res) res.destroy();
      if (req) req.destroy();
    };
    if (signal) {
      if (signal.aborted) { abortHandler(); return; }
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (!useJsonReply) resetProgressTimer();
    req.write(payload);
    req.end();
  });
}

/** 本机桥接聊天：POST /chat_with_image，非流式，一次返回全文，免 API Key。
 *  响应是单个 JSON { text, image, draw_reason }；image 是 base64 PNG（null = 本轮没出图）。
 *  出图要卸文字模型再拉图像模型，一轮可能 30~40 秒，所以超时给得宽（默认 300 秒）。 */
function bridgeChat({ settings, messages, characterContext, noImage, signal, timeoutMs = 300000, onRequest }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(bridgeChatUrl(settings.baseUrl));
    } catch (err) {
      reject(new Error('接口地址格式不对，请检查「接口地址」这一项。'));
      return;
    }

    const transport = transportOf(target);

    const body = {
      messages,
      temperature: Number(settings.temperature),
      max_tokens: Math.max(1, Number(settings.maxTokens) || 8192)
    };
    // 只要文字就改打 /chat：那条不做出图判定，省掉「判断该不该画」那一步。
    // /chat 不认画风预设这些字段，只在要出图的路径上带。
    if (noImage === true) {
      target.pathname = '/chat';
    } else {
      // 关闭画风预设：长相完全由 character_context 决定，避免被固定画风钉死成同一个角色。
      body.preset = 'none';
      body.force_image = false;
      if (String(characterContext || '').trim()) {
        body.character_context = String(characterContext).trim();
      }
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    // 和 streamChat 同一个口径：请求真正发出前把定稿的 body 交出去（「请求记录」用它）。
    // ⚠️ 少了这一处，本机桥接模式下「请求记录」永远是空的 —— 界面只说「还没记录」，
    // 用户看不出这是个已知缺口，只会以为功能坏了。
    if (typeof onRequest === 'function') {
      try { onRequest(body, target.href); } catch (err) { /* 记录失败不能拖垮请求 */ }
    }

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: portOf(target),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'Content-Length': payload.length
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(describeHttpError(res.statusCode, text)));
            return;
          }

          let json;
          try {
            json = JSON.parse(text);
          } catch (err) {
            reject(new Error('接口返回的不是合法 JSON。'));
            return;
          }

          resolve({
            content: String(json.text || ''),
            image: typeof json.image === 'string' && json.image
              ? `data:image/png;base64,${json.image}`
              : null,
            drawReason: String(json.draw_reason || '')
          });
        });
        res.on('aborted', () => {
          reject(new Error(signal && signal.aborted ? '已停止生成。' : '接口响应被中止。'));
        });
        res.on('error', (err) => {
          reject(new Error(signal && signal.aborted ? '已停止生成。' : normalizeNetworkError(err)));
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时：本地桥接服务没有在限时内响应（出图可能需要 40 秒左右）。'));
    });
    req.on('error', (err) => {
      reject(new Error(normalizeNetworkError(err)));
    });

    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('已停止生成。'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('已停止生成。')), { once: true });
    }

    req.write(payload);
    req.end();
  });
}

/** 本机桥接「只出图」：POST /draw，把已写好的文字翻译成图像提示词并出图，不经过文字模型。
 *  返回 { dataUrl, drawReason, promptUsed }；没出图时 dataUrl 是 null。 */
function bridgeDraw({ baseUrl, text, characterContext, preset, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(`${normalizeBaseUrl(baseUrl)}/draw`);
    } catch (err) {
      reject(new Error('接口地址格式不对，请检查「接口地址」这一项。'));
      return;
    }

    const transport = transportOf(target);

    const body = { text: String(text || '') };
    if (String(characterContext || '').trim()) {
      body.character_context = String(characterContext).trim();
    }
    if (preset !== undefined && preset !== null) {
      body.preset = String(preset);
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: portOf(target),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'Content-Length': payload.length
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const respText = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(describeHttpError(res.statusCode, respText)));
            return;
          }

          let json;
          try {
            json = JSON.parse(respText);
          } catch (err) {
            reject(new Error('接口返回的不是合法 JSON。'));
            return;
          }

          resolve({
            dataUrl: typeof json.image === 'string' && json.image
              ? `data:image/png;base64,${json.image}`
              : null,
            drawReason: String(json.draw_reason || ''),
            promptUsed: String(json.prompt_used || '')
          });
        });
        res.on('aborted', () => {
          reject(new Error('接口响应被中止。'));
        });
        res.on('error', (err) => {
          reject(new Error(normalizeNetworkError(err)));
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时：本地桥接服务没有在限时内响应（出图可能需要 40 秒左右）。'));
    });
    req.on('error', (err) => {
      reject(new Error(normalizeNetworkError(err)));
    });

    req.write(payload);
    req.end();
  });
}

/** 本机桥接的出图进度查询：GET /draw/progress，返回 {status,value,max,prompt_id} */
function bridgeDrawProgress(baseUrl, timeoutMs = 5000) {
  return requestJson({
    url: `${normalizeBaseUrl(baseUrl)}/draw/progress`,
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs
  });
}

/** 本机桥接的健康检查：GET /health，返回两个引擎是否在线 */
function bridgeHealth(baseUrl, timeoutMs = 10000) {
  return requestJson({
    url: bridgeHealthUrl(baseUrl),
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs
  });
}

module.exports = {
  buildHeaders,
  modelsUrl,
  chatUrl,
  imagesUrl,
  embeddingsUrl,
  bridgeChatUrl,
  bridgeHealthUrl,
  bridgeChat,
  bridgeDraw,
  bridgeDrawProgress,
  bridgeHealth,
  downloadBinary,
  requestJson,
  streamChat
};
