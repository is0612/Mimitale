'use strict';

// node --test tools/test-http-stream.js
// 本地HTTP模拟仅校验流生命周期，不打印请求体或对话内容。
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return {
    app: { getName: () => 'Mimitale', getPath: () => path.join(os.tmpdir(), 'mimitale-http-test-unused'), getAppPath: () => path.join(__dirname, '..'), isPackaged: false },
    safeStorage: { isEncryptionAvailable: () => false }
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { streamChat } = require('../main/http.js');
Module._load = originalLoad;

let server;
let base;
const active = new Set();
const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;

test.before(async () => {
  server = http.createServer((req, res) => {
    active.add(res);
    res.on('close', () => active.delete(res));
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const route = pathname.split('/')[1];
    if (route === 'done-open') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }));
      res.write('data: [DONE]\n\n');
      const timer = setInterval(() => res.write(': keepalive\n\n'), 10);
      res.on('close', () => clearInterval(timer));
    } else if (route === 'reasoning-open') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse({ choices: [{ delta: { reasoning_content: 'thinking' }, finish_reason: null }] }));
      const timer = setInterval(() => res.write(': keepalive\n\n'), 10);
      res.on('close', () => clearInterval(timer));
    } else if (route === 'comments-open' || route === 'empty-role-open') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = route === 'comments-open' ? ': keepalive\n\n' : sse({ choices: [{ delta: { role: 'assistant', content: '', reasoning_content: '' }, finish_reason: null }] });
      res.write(frame);
      const timer = setInterval(() => res.write(frame), 10);
      res.on('close', () => clearInterval(timer));
    } else if (route === 'delta-resets' || route === 'reasoning-resets') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const field = route === 'delta-resets' ? 'content' : 'reasoning_content';
      res.write(sse({ choices: [{ delta: { [field]: 'a' } }] }));
      let count = 0;
      const timer = setInterval(() => {
        res.write(sse({ choices: [{ delta: { [field]: 'b' } }] }));
        count += 1;
        if (count === 4) {
          clearInterval(timer);
          res.end('data: [DONE]\n\n');
        }
      }, 50);
      res.on('close', () => clearInterval(timer));
    } else if (route === 'finish-open') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      const timer = setTimeout(() => res.end('data: [DONE]\n\n'), 220);
      res.on('close', () => clearTimeout(timer));
    } else if (route === 'error-cut') {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.write('partial error');
      setTimeout(() => res.destroy(), 15);
    } else if (route === 'success-cut') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse({ choices: [{ delta: { content: 'partial' } }] }));
      setTimeout(() => res.destroy(), 15);
    } else if (route === 'json-reply') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: 'complete' }, finish_reason: 'stop' }], usage: { completion_tokens: 1 } })), 100);
    } else if (route === 'success-end') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`${sse({ choices: [{ delta: { content: 'complete' }, finish_reason: 'stop' }] })}data: [DONE]\n\n`);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  for (const res of active) res.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const call = (route, deadlineMs = 1000, signal, progressTimeoutMs = 60000) => streamChat({
  settings: { baseUrl: `${base}/${route}`, apiKey: 'test-only', model: 'test' },
  messages: [], deadlineMs, signal, progressTimeoutMs
});

test('DONE立即完成，即使服务端保持心跳连接', async () => {
  const result = await call('done-open');
  assert.equal(result.content, 'ok');
  assert.equal(result.finishReason, 'stop');
});

test('非2xx响应中断后reject而不挂起', async () => {
  await assert.rejects(call('error-cut'), /响应被中止|401/);
});

test('2xx服务端中途断开后reject而不挂起', async () => {
  await assert.rejects(call('success-cut'), /响应被中止|中断/);
});

test('用户取消2xx响应后reject而不挂起', async () => {
  const controller = new AbortController();
  const pending = call('reasoning-open', 1000, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /已停止生成/);
});

test('持续reasoning心跳受绝对deadline约束', async () => {
  const start = Date.now();
  await assert.rejects(call('reasoning-open', 80), /总时限/);
  assert.ok(Date.now() - start < 1000);
});

for (const route of ['comments-open', 'empty-role-open']) {
  test(`${route}持续活跃但无模型输出时触发进展超时并关闭连接`, async () => {
    const start = Date.now();
    await assert.rejects(call(route, 1000, undefined, 100), /仅有心跳或空响应.*没有返回任何模型输出.*稍后重试/);
    assert.ok(Date.now() - start < 800);
    // 等待服务器观察客户端关闭，避免把 promise reject 误当作连接已清理。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active.size, 0);
  });
}

for (const route of ['delta-resets', 'reasoning-resets']) {
  test(`${route}真实增量重置进展计时器`, async () => {
    const start = Date.now();
    const result = await call(route, 1000, undefined, 140);
    assert.ok(Date.now() - start >= 180);
    assert.equal(route === 'delta-resets' ? result.content : result.reasoning, 'abbbb');
  });
}

test('已有思考输出后停滞与仅心跳错误不同', async () => {
  await assert.rejects(call('reasoning-open', 1000, undefined, 100), /已返回部分内容.*没有新的模型输出.*稍后重试/);
});

test('finish信号停止进展计时，仍等DONE正常收尾', async () => {
  const result = await call('finish-open', 1000, undefined, 100);
  assert.equal(result.finishReason, 'stop');
});

test('DONE完成后清除进展计时器及取消监听', async () => {
  const controller = new AbortController();
  const result = await call('done-open', 1000, controller.signal, 40);
  assert.equal(result.content, 'ok');
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(active.size, 0);
});

test('DeepSeek官方flash/pro显式发送thinking，其他模型和域名不发送', async () => {
  const cases = [
    ['https://api.deepseek.com', 'deepseek-flash', undefined, 'enabled'],
    ['https://api.deepseek.com', 'deepseek-v4-pro', true, 'enabled'],
    ['https://api.deepseek.com', 'DEEPSEEK-FLASH', false, 'disabled'],
    ['https://api.deepseek.com', 'deepseek-chat', true, undefined],
    ['https://api.deepseek.com', 'deepseek-reasoner', true, undefined],
    ['https://api.deepseek.com.example.org', 'deepseek-flash', true, undefined],
    [base, 'deepseek-v4-pro', true, undefined]
  ];
  for (const [baseUrl, model, thinking, expected] of cases) {
    const controller = new AbortController();
    controller.abort();
    let body;
    await assert.rejects(streamChat({
      settings: { baseUrl, model, thinking, apiKey: 'test-only' },
      messages: [], signal: controller.signal,
      // 请求构造后、发送前检查请求体；预先取消以避免访问真实服务。
      onRequest: (value) => { body = value; }
    }), /已停止生成/);
    assert.deepEqual(body.thinking, expected === undefined ? undefined : { type: expected });
    assert.equal(body.stream, true, 'DeepSeek也必须默认使用流式输出');
  }
});

test('完整JSON兼容回复不受流式首字超时限制', async () => {
  let sent;
  const result = await streamChat({ settings: { baseUrl: `${base}/json-reply`, apiKey: 'test', model: 'test', stream: false }, messages: [], deadlineMs: 1000, progressTimeoutMs: 40, onRequest: body => { sent = body.stream; } });
  assert.equal(sent, false);
  assert.equal(result.content, 'complete');
  assert.equal(result.finishReason, 'stop');
});

test('正常结束流解析结果正确', async () => {
  const result = await call('success-end');
  assert.equal(result.content, 'complete');
  assert.equal(result.finishReason, 'stop');
});
