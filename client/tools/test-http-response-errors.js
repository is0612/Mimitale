'use strict';

// node --test tools/test-http-response-errors.js
// 只用本地 Node HTTP server，Electron 依赖按既有下载测试的方式注入。
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return {
    app: {
      getName: () => 'Mimitale',
      getPath: () => path.join(os.tmpdir(), 'mimitale-http-test-unused'),
      getAppPath: () => path.join(__dirname, '..'),
      isPackaged: false
    },
    safeStorage: { isEncryptionAvailable: () => false }
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { requestJson, downloadBinary, bridgeChat, bridgeDraw } = require('../main/http.js');
Module._load = originalLoad;

let server;
let base;
let cancelOnResponse;
const completeBody = JSON.stringify({ text: 'ok', image: 'cG5n', draw_reason: 'draw', prompt_used: 'prompt' });

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/ok' });
      res.write('partial redirect body');
      setTimeout(() => res.destroy(), 20);
    } else if (url.pathname === '/ok' || url.pathname === '/success' || url.pathname.startsWith('/success/')) {
      // 延迟下一跳成功，确保旧的 302 响应先断流。
      setTimeout(() => res.end(completeBody), 40);
    } else if (url.pathname === '/cancel/chat_with_image') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"text":');
      cancelOnResponse();
    } else {
      res.writeHead(Number(url.searchParams.get('status')) || (url.pathname.startsWith('/broken-500') ? 500 : 200), {
        'Content-Type': 'application/json',
        ...(url.searchParams.has('length') ? { 'Content-Length': '1000' } : {})
      });
      // flush + 延迟销毁，保证客户端已收到响应头和部分 body。
      res.write('{"text":"partial');
      setTimeout(() => res.destroy(), 20);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

// Promise.race 给旧实现的永久 pending 明确的失败结果，而非让测试也悬挂。
async function settles(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('response remained pending')), 1500);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const calls = {
  requestJson: (suffix) => requestJson({ url: `${base}${suffix}`, timeoutMs: 10000 }),
  downloadBinary: (suffix) => downloadBinary(`${base}${suffix}`, 10000),
  bridgeChat: (suffix) => bridgeChat({ settings: { baseUrl: `${base}${suffix}` }, messages: [], timeoutMs: 10000 }),
  bridgeDraw: (suffix) => bridgeDraw({ baseUrl: `${base}${suffix}`, text: 'draw', timeoutMs: 10000 })
};

for (const [name, call] of Object.entries(calls)) {
  for (const status of [200, 500]) {
    test(`${name}: HTTP ${status} 响应 body 断流及时 reject`, async () => {
      // 桥接端点会追加路径，因此用 base path 区分状态。
      const suffix = name.startsWith('bridge') ? `/broken-${status}` : `/broken?status=${status}`;
      await assert.rejects(settles(call(suffix)), /响应被中止|aborted|ECONNRESET/);
    });
  }
  test(`${name}: 完整响应正常 resolve`, async () => {
    const result = await settles(call('/success'));
    if (name === 'requestJson') assert.equal(result.text, 'ok');
    if (name === 'downloadBinary') assert.equal(result.toString(), completeBody);
    if (name === 'bridgeChat') assert.equal(result.content, 'ok');
    if (name === 'bridgeDraw') assert.equal(result.dataUrl, 'data:image/png;base64,cG5n');
  });
}

test('声明 Content-Length 的 JSON 半截响应也及时 reject', async () => {
  await assert.rejects(settles(calls.requestJson('/broken?length=1')), /响应被中止|aborted|ECONNRESET/);
});

test('下载重定向的旧响应断流不覆盖下一跳结果', async () => {
  assert.equal((await settles(downloadBinary(`${base}/redirect`, 10000))).toString(), completeBody);
});

test('bridgeChat 收到部分响应后取消仍返回已停止生成', async () => {
  const controller = new AbortController();
  cancelOnResponse = () => setTimeout(() => controller.abort(), 20);
  await assert.rejects(settles(bridgeChat({
    settings: { baseUrl: `${base}/cancel` }, messages: [], signal: controller.signal, timeoutMs: 10000
  })), /已停止生成/);
});

test('bridgeChat 预先取消仍返回已停止生成', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(settles(bridgeChat({
    settings: { baseUrl: base }, messages: [], signal: controller.signal, timeoutMs: 10000
  })), /已停止生成/);
});
