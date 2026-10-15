const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(require('node:os').tmpdir(), 'mimitale-library-preview'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 960, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, details) => { if (details?.level === 'error') errors.push(details.message); });
  await win.loadFile(path.join(__dirname, 'index.html'));
  for (const [name, width, height, view] of [
    ['editor-desktop', 1440, 960, 'editor'], ['presets-desktop', 1440, 960, 'presets'],
    ['characters-desktop', 1440, 960, 'characters'], ['worldbooks-desktop', 1440, 960, 'worldbooks'],
    ['editor-mobile', 390, 844, 'editor'], ['presets-mobile', 390, 844, 'presets'],
    ['worldbook-editor-desktop', 1440, 960, 'worldbook-editor'],
    ['worldbook-editor-laptop', 1100, 800, 'worldbook-editor'],
    ['worldbook-editor-mobile', 390, 844, 'worldbook-editor']
  ]) {
    if (process.argv.includes('--worldbook-only') && view !== 'worldbook-editor') continue;
    win.setContentSize(width, height);
    await win.webContents.executeJavaScript(`location.hash=${JSON.stringify('#' + view)}; new Promise(r => setTimeout(r, 150));`);
    await win.webContents.executeJavaScript('Promise.all(Array.from(document.images).map(i => i.decode().catch(() => null)))');
    const check = await win.webContents.executeJavaScript(`({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,images:Array.from(document.images).map(i=>({ok:i.complete&&i.naturalWidth>0,src:i.getAttribute('src')})),text:document.querySelector('main').innerText.slice(0,120),offscreenControls:Array.from(document.querySelectorAll('main button,main input,main textarea,main select')).filter(n=>n.getClientRects().length).filter(n=>{const r=n.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1}).map(n=>n.id||n.getAttribute('aria-label')||n.textContent.trim().slice(0,30))})`);
    console.log(name, JSON.stringify(check));
    fs.writeFileSync(path.join(__dirname, name + '.png'), (await win.webContents.capturePage()).toPNG());
    if (check.overflow || check.images.some(i => !i.ok)) throw Error('Layout or asset check failed: ' + name);
  }
  for (const [panel, selector] of [['settings', '[data-wb-panel="settings"]'], ['characters', '[data-wb-panel="characters"]']]) {
    win.setContentSize(1440, 960);
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click(); new Promise(r => setTimeout(r, 100));`);
    fs.writeFileSync(path.join(__dirname, 'worldbook-' + panel + '-desktop.png'), (await win.webContents.capturePage()).toPNG());
  }
  win.setContentSize(1440, 960);
  const interactions = await win.webContents.executeJavaScript(`(async () => {
    const assert = (ok, name) => { if (!ok) throw Error(name); };
    location.hash = '#editor'; await new Promise(r => setTimeout(r, 100));
    document.querySelector('[data-tab="personality"]').click();
    const text = document.querySelector('#writing-text');
    const before = text.value; text.value = before + '\\n预览交互检查'; text.dispatchEvent(new Event('input', { bubbles: true }));
    assert(document.querySelector('#save-status').textContent === '未保存', 'Editor dirty state');
    document.querySelector('[data-tab="description"]').click(); document.querySelector('[data-tab="personality"]').click();
    assert(document.querySelector('#writing-text').value.includes('预览交互检查'), 'Tab draft retention');
    document.querySelector('#writing-text').value = before; document.querySelector('#writing-text').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#save-char').click(); assert(document.querySelector('#save-status').textContent === '所有更改已保存', 'Save state');
    location.hash = '#presets'; await new Promise(r => setTimeout(r, 100));
    document.querySelector('[data-filter="disabled"]').click(); assert(document.querySelectorAll('.preset-row').length === 1, 'Disabled filter');
    document.querySelector('[data-filter="all"]').click();
    const search = document.querySelector('#preset-search'); search.value = '自然'; search.dispatchEvent(new Event('input', { bubbles: true }));
    assert(document.querySelectorAll('.preset-row').length === 1, 'Preset search');
    document.querySelector('[data-edit-preset]').click(); assert(!!document.querySelector('.drawer'), 'Preset drawer');
    const note = document.querySelector('[data-preset="note"]'); note.value = '编辑后的预设说明'; note.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-save-preset]').click(); assert(document.querySelector('#preset-list').textContent.includes('编辑后的预设说明'), 'Preset save');
    document.querySelector('[data-preset-more]').click(); assert(!!document.querySelector('.menu'), 'Preset action menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { editorTabs: true, draftRetention: true, save: true, presetFilter: true, presetSearch: true, presetEdit: true, presetMenu: true };
  })()`);
  const worldbookInteractions = await win.webContents.executeJavaScript(`(async () => {
    const assert = (ok, name) => { if (!ok) throw Error(name); };
    location.hash = '#worldbook-editor'; await new Promise(r => setTimeout(r, 100));
    document.querySelector('[data-wb-panel="entries"]').click();
    const rows = [...document.querySelectorAll('[data-wb-select]')]; assert(rows.length > 1, 'Worldbook entries');
    const first = rows[0].getAttribute('data-wb-select'); rows[0].click();
    const content = document.querySelector('#wb-e-content'), before = content.value;
    content.value = before + '\\n世界书草稿检查'; content.dispatchEvent(new Event('input', { bubbles: true }));
    assert(document.querySelector('#wb-save-status').textContent.includes('未保存'), 'Worldbook dirty');
    document.querySelectorAll('[data-wb-select]')[1].click();
    document.querySelector('[data-wb-select="'+first+'"]').click();
    assert(document.querySelector('#wb-e-content').value.includes('世界书草稿检查'), 'Worldbook draft retention');
    const restored = document.querySelector('#wb-e-content'); restored.value = before; restored.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#wb-save').click(); assert(!document.querySelector('#wb-save-status').textContent.includes('未保存'), 'Worldbook save');
    document.querySelector('[data-wb-panel="settings"]').click(); assert(document.querySelector('main').innerText.includes('开场白'), 'Book settings');
    document.querySelector('[data-wb-panel="characters"]').click(); assert(document.querySelector('main').innerText.includes('角色'), 'Book characters');
    document.querySelector('#wb-preview').click(); assert(!!document.querySelector('#wb-preview-text'), 'Match preview');
    document.querySelector('#wb-preview-text').value = '雾林中的旧邮局';
    document.querySelector('#wb-run-preview').click(); assert(!!document.querySelector('#wb-preview-results').textContent.trim(), 'Match results');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { entries: true, draftRetention: true, save: true, bookSettings: true, bookCharacters: true, matchPreview: true };
  })()`);
  console.log('worldbookInteractions', JSON.stringify(worldbookInteractions));
  console.log('interactions', JSON.stringify(interactions));
  console.log('errors', JSON.stringify(errors));
  if (errors.length) throw Error('Preview console errors');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
