'use strict';

// Run with electron --no-sandbox tools/test-chat-scroll.js.
// Isolated real Chromium DOM; no preload, model, application startup or user-data writes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'renderer');
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mimitale-scroll-')));
let server;
let win;
const deadline = setTimeout(() => { console.error('FAIL: chat scroll test timed out'); app.exit(1); }, 45000);

function rendererTests() {
  return (async () => {
    const { state } = await import('./js/core/state.js');
    const { renderMessages } = await import('./js/views/chatMessages.js');
    const { initStreamFollow, scrollToBottom, streamPainter, isFollowingBottom } = await import('./js/views/stream.js');
    const box = document.getElementById('messages');
    box.style.cssText = 'position:fixed;inset:0;width:760px;height:500px;overflow-y:scroll;display:block;scroll-behavior:auto;z-index:999999;';
    box.tabIndex = 0;
    state.settings = {};
    const makeMessages = () => Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}\n\n` + 'Readable paragraph with enough lines to measure scrolling. '.repeat(20), at: 1700000000000 + i * 1000 }));
    const convo = { id: 'scroll-a', messages: makeMessages() };
    state.conversations = [convo, { id: 'scroll-b', messages: makeMessages() }];
    state.activeId = convo.id;
    initStreamFollow();
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))));
    const results = [];
    function check(label, pass, detail) {
      results.push({ label, pass: !!pass, detail });
      if (!pass) throw new Error(label + ': ' + JSON.stringify(detail));
    }
    const atBottom = () => box.scrollHeight - box.clientHeight - box.scrollTop < 2;
    const node = index => box.querySelector(`.msg[data-index="${index}"]`);
    const offset = n => n.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientTop;
    async function history(index = 24) { box.scrollTop += offset(node(index)) + 55; await settle(); }
    const near = (a, b) => Math.abs(a - b) <= 2;
    renderMessages({ forceScroll: true });
    await settle();
    check('initial force render reaches bottom', atBottom(), box.scrollTop);
    await history();
    check('non-wheel scroll suspends following', !isFollowingBottom(), box.scrollTop);
    const originalTop = box.scrollTop;
    renderMessages({ forceScroll: false });
    await settle();
    check('unchanged full redraw preserves original scrollTop', near(box.scrollTop, originalTop), [originalTop, box.scrollTop]);

    const beforeEdit = offset(node(24));
    convo.messages[2].content += '\n\n' + 'Earlier edit grows above the reader. '.repeat(180);
    renderMessages({ forceScroll: false });
    await settle();
    check('edit above viewport keeps visible message offset', near(offset(node(24)), beforeEdit), [beforeEdit, offset(node(24))]);

    const beforeDelete = offset(node(24));
    convo.messages.splice(3, 1);
    renderMessages({ forceScroll: false });
    await settle();
    check('delete above viewport preserves shifted message identity', near(offset(node(23)), beforeDelete), [beforeDelete, offset(node(23))]);

    const nextOffset = offset(node(24));
    convo.messages.splice(23, 1);
    renderMessages({ forceScroll: false });
    await settle();
    check('delete visible anchor preserves next surviving message', near(offset(node(23)), nextOffset), [nextOffset, offset(node(23))]);

    await history(20);
    const variantOffset = offset(node(20));
    convo.messages[1].content = 'Short candidate';
    renderMessages({ forceScroll: false });
    await settle();
    check('candidate height change keeps reader anchored', near(offset(node(20)), variantOffset), [variantOffset, offset(node(20))]);

    const streamTop = box.scrollTop;
    const tail = node(convo.messages.length - 1).querySelector('.msg-content');
    streamPainter.push(tail, 'stream token '.repeat(900));
    await settle();
    check('stream paint does not pull history to bottom', near(box.scrollTop, streamTop), [streamTop, box.scrollTop]);
    streamPainter.stop();

    renderMessages({ forceScroll: true });
    await settle();
    check('force send redraw overrides history and reaches bottom', atBottom() && isFollowingBottom(), box.scrollTop);
    // A forced scroll event must not leave following locked after the DOM grows.
    convo.messages.push({ role: 'assistant', content: 'New tail '.repeat(300) });
    renderMessages({ forceScroll: false });
    await settle();
    check('non-force redraw keeps existing bottom follow', atBottom(), box.scrollTop);
    const followTail = node(convo.messages.length - 1).querySelector('.msg-content');
    streamPainter.push(followTail, 'Continued streaming tail '.repeat(900));
    await settle();
    check('programmatic bottom scroll does not lock streaming follow', atBottom(), box.scrollTop);
    streamPainter.stop();

    await history();
    state.activeId = 'scroll-b';
    renderMessages({ forceScroll: true });
    await settle();
    check('forced conversation switch reaches bottom', atBottom(), box.scrollTop);
    state.activeId = convo.id;
    renderMessages({ forceScroll: true });
    await settle();
    box.focus();
    window.chatScrollTest = { box, results, atBottom, settle, scrollToBottom, isFollowingBottom, check, renderMessages, convo, state };
    return results;
  })();
}

app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const base = rel.startsWith('/main/') ? path.resolve(root, '..') : root;
    const target = path.resolve(base, '.' + rel);
    if (!target.startsWith(base + path.sep) && target !== base) { res.writeHead(403).end(); return; }
    fs.readFile(target === base ? path.join(base, 'index.html') : target, (err, bytes) => {
      if (err) { res.writeHead(404).end(); return; }
      const ext = path.extname(target);
      res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html');
      // Keep the actual DOM/CSS and module graph, but never run the app startup or IPC.
      if (ext === '.html') bytes = Buffer.from(bytes.toString('utf8').replace(/<script type="module" src="js\/main\.js"><\/script>/, ''));
      res.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ width: 1000, height: 760, show: true, webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } });
  win.webContents.on('render-process-gone', (_, details) => { console.error('FAIL: renderer exited', details); app.exit(1); });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/index.html`);
  await win.webContents.executeJavaScript(`(${rendererTests.toString()})()`);
  // Native Chromium keyboard scrolling (no wheel handler).
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PageUp' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'PageUp' });
  await new Promise(resolve => setTimeout(resolve, 250));
  await win.webContents.executeJavaScript(`(async () => {
    const t = window.chatScrollTest;
    t.check('native PageUp suspends following', !t.isFollowingBottom(), t.box.scrollTop);
    const top = t.box.scrollTop;
    t.scrollToBottom(false);
    await t.settle();
    t.check('following respects native keyboard history scroll', Math.abs(top - t.box.scrollTop) < 2, [top, t.box.scrollTop]);
    t.scrollToBottom(true);
    await t.settle();
  })()`);
  // Drag Chromium's real scrollbar thumb into history, without dispatching wheel.
  const dims = await win.webContents.executeJavaScript(`(() => { const b=window.chatScrollTest.box; const r=b.getBoundingClientRect(); return { x:Math.round(r.right-7), y:Math.round(r.bottom-12), top:Math.round(r.top+180) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: dims.x, y: dims.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: dims.x, y: dims.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: dims.x, y: dims.top, button: 'left' });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: dims.x, y: dims.top, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 250));
  await win.webContents.executeJavaScript(`(async () => {
    const t = window.chatScrollTest;
    t.check('native scrollbar drag suspends following', !t.isFollowingBottom(), t.box.scrollTop);
    const top = t.box.scrollTop;
    t.renderMessages({ forceScroll: false });
    await t.settle();
    t.check('scrollbar history survives full redraw', Math.abs(top - t.box.scrollTop) < 2, [top, t.box.scrollTop]);
    t.scrollToBottom(true);
    await t.settle();
  })()`);
  // DevTools touch synthesis uses the browser's native scroll path as a touchscreen would.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true });
  await win.webContents.debugger.sendCommand('Input.synthesizeScrollGesture', { x: 350, y: 240, yDistance: 300, speed: 900, gestureSourceType: 'touch' });
  win.webContents.debugger.detach();
  await new Promise(resolve => setTimeout(resolve, 250));
  const results = await win.webContents.executeJavaScript(`(async () => {
    const t = window.chatScrollTest;
    if (t.atBottom()) {
      console.warn('SKIP: Chromium touch synthesis did not move the Windows desktop scroller; physical touch hardware not exercised');
      window.chatScrollTouchSkipped = true;
    } else {
      t.check('native touch scroll suspends following', !t.isFollowingBottom(), t.box.scrollTop);
      const top = t.box.scrollTop;
      t.scrollToBottom(false);
      await t.settle();
      t.check('following respects touch history scroll', Math.abs(top - t.box.scrollTop) < 2, [top, t.box.scrollTop]);
    }
    t.box.scrollTop = 1e9;
    await t.settle();
    t.check('returning to bottom resumes follow', t.isFollowingBottom(), t.box.scrollTop);
    t.convo.messages = [];
    t.renderMessages({ forceScroll: false });
    await t.settle();
    t.check('empty redraw safely resets scroll', t.box.scrollTop === 0 && t.isFollowingBottom(), t.box.scrollTop);
    return t.results;
  })()`);
  for (const result of results) console.log('PASS: ' + result.label);
  const touchSkipped = await win.webContents.executeJavaScript('!!window.chatScrollTouchSkipped');
  if (touchSkipped) console.log('SKIP: native touch synthesis did not move the Windows desktop scroller; physical touch hardware not exercised');
  console.log(`FINAL: ${results.length}/${results.length} chat scroll regressions passed, ${touchSkipped ? 1 : 0} touch scenario skipped (real Electron ${process.versions.electron}, Chromium ${process.versions.chrome})`);
  clearTimeout(deadline);
  server.close();
  app.exit(0);
}).catch(err => {
  console.error('FAIL:', err.stack || err);
  clearTimeout(deadline);
  if (server) server.close();
  app.exit(1);
});
