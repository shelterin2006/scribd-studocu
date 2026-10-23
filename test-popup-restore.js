const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const tasks = require('./studocu-tasks.js');
const support = require('./studocu.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const key = 'documentActivity:scribd:7:123';
const jpeg = Buffer.from([255,216,255,192,0,17,8,3,32,2,88,3,1,17,0,2,17,0,3,17,0,255,217]);
const base = 'https://html.scribdassets.com/current';
const page = n => `${base}/pages/${n}-hash.jsonp`;
const image = n => `${base}/images/${n}-hash.jpg`;
const scope = { site: 'scribd', tabId: 7, docId: '123' };
const snapshot = (extra = {}) => ({ ...scope, version: 1, revision: 7, taskId: 'JOB', startedAt: 1,
  status: 'downloading', active: true, totalPages: 3, downloadedCount: 1, count: 3, updatedAt: 100,
  logs: [{ id: 1, at: 100, message: 'Đã xử lý 1/3 trang', level: 'info' }], ...extra });

function worker(seed = {}) {
  const stored = structuredClone(seed), events = [], downloads = [], receivers = new Set(), gates = new Map();
  let listener;
  const local = { async get(keys) { return keys === null ? structuredClone(stored) : Object.fromEntries(keys.filter(k => k in stored).map(k => [k, structuredClone(stored[k])])); },
    async set(values) { Object.assign(stored, structuredClone(values)); }, async remove(keys) { for (const k of keys) delete stored[k]; } };
  const context = vm.createContext({ URL, Uint8Array, Buffer, atob, btoa, AbortController, setTimeout, clearTimeout, console,
    fetch: async url => {
      const n = Number(url.match(/\/(?:pages|images)\/(\d+)-/)[1]);
      if (url.includes('/images/')) await new Promise(resolve => gates.set(n, resolve));
      return { ok: true, headers: { get: () => 'image/jpeg' },
        text: async () => 'window.page_callback(' + JSON.stringify([`<div class="newpage" style="width:902px;height:1167px"><div class="image_layer"><img class="absimg" orig="${image(n)}" style="left:0px;top:0px;width:902px;height:1167px"/></div></div>`]) + ');',
        arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length) };
    }, chrome: { storage: { local }, runtime: { onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(m) { events.push(structuredClone(m)); for (const receive of receivers) receive(m, {}); } },
      tabs: { async query() { return [{ id: 7, url: 'https://www.scribd.com/document/123/name' }]; },
        sendMessage(tabId, m, callback) {
          if (m.action === 'getDocInfo') return callback({ docId: '123', totalPages: 3 });
          if (m.action.includes('DocumentCacheReset')) return callback({ ok: true, assetIds: ['current'] });
          throw Error('Unexpected content request ' + m.action);
        } }, downloads: { async download(value) { downloads.push(value); return 1; } } } });
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
  const send = (m, sender = {}) => new Promise(resolve => { if (!listener(m, sender, resolve)) resolve(undefined); });
  return { context, stored, local, events, downloads, receivers, send,
    state: () => send({ action: 'getDocumentActivity', ...scope }),
    start: () => send({ action: 'downloadImages', ...scope, expectedPages: 3, fast: true, urls: [page(1), page(2), page(3)] }),
    async release(n) { for (let i = 0; i < 100 && !gates.has(n); i++) await tick(); assert.ok(gates.has(n)); gates.get(n)(); await tick(); await tick(); } };
}

function popup({ local, send, receivers = new Set(), contentHeld = true, site = 'scribd' } = {}) {
  const elements = new Map(), sent = [], listeners = new Set(); let ready;
  const el = id => {
    if (!elements.has(id)) {
      let text = '', html = '';
      elements.set(id, { style: {}, disabled: false, value: '', events: {}, scrollHeight: 0,
        get textContent() { return text; }, set textContent(value) { text = value; },
        get innerHTML() { return html; }, set innerHTML(value) { html = value; if (value === '') text = ''; },
        classList: { add() {}, remove() {} }, addEventListener(n, fn) { this.events[n] = fn; },
        appendChild(n) { if (n.id) elements.set(n.id, n); text += n.textContent + '\n'; } });
    }
    return elements.get(id);
  };
  const ctx = vm.createContext({ URL, console, setTimeout, clearTimeout, StudocuSupport: support,
    document: { getElementById: el, createElement: () => ({ textContent: '' }), addEventListener(n, fn) { if (n === 'DOMContentLoaded') ready = fn; } },
    chrome: { storage: { local: local || { async get() { return {}; } } },
      runtime: { onMessage: { addListener(fn) { listeners.add(fn); receivers.add(fn); }, removeListener(fn) { listeners.delete(fn); receivers.delete(fn); } },
        async sendMessage(m) { sent.push(m); return send ? send(m) : {}; } },
      tabs: { async query() { return [{ id: 7, url: site === 'scribd' ? 'https://www.scribd.com/document/123/name' : 'https://www.studocu.vn/vn/document/a/b/123' }]; },
        sendMessage(id, m, cb) { if (!contentHeld) cb({ docId: '123', totalPages: 3, count: 3, complete: true, urls: [page(1), page(2), page(3)] }); } } } });
  vm.runInContext(fs.readFileSync('popup.js', 'utf8'), ctx);
  return { el, sent, start: () => ready(), emit(m) { for (const fn of listeners) fn(m, {}); },
    close() { for (const fn of listeners) receivers.delete(fn); } };
}

test('a reopened Scribd popup reads live progress and logs while the renderer tab cannot answer', async () => {
  const w = worker(), running = w.start();
  await w.release(1);
  assert.equal((await w.state()).downloadedCount, 1);
  await w.release(2);
  const p = popup(w); p.start(); await tick(); await tick();
  assert.equal(p.el('doc-id').textContent, '123');
  assert.equal(p.el('total-pages').textContent, 3);
  assert.equal(p.el('collected-pages').textContent, 2);
  assert.match(p.el('log').textContent, /1\/3[\s\S]*2\/3/);
  assert.equal(p.el('btn-download').disabled, true);
  assert.equal(p.sent.some(m => m.action === 'downloadImages'), false);
  await w.release(3); await running; await tick();
  assert.equal(p.el('collected-pages').textContent, 3);
  assert.match(p.el('progress-text').textContent, /3\/3/);
  assert.equal(w.downloads.length, 1);
  p.close();
  const reopened = popup(w); reopened.start(); await tick(); await tick();
  assert.match(reopened.el('log').textContent, /Hoàn tất/);
  assert.equal(reopened.el('btn-download').disabled, false);
  assert.equal(w.downloads.length, 1);
});

test('stored progress is labelled as syncing; delayed older snapshots never overwrite live events', async () => {
  let respond;
  const local = { async get() { return { [key]: snapshot() }; } };
  const p = popup({ local, send: m => m.action === 'getDocumentActivity' ? new Promise(resolve => { respond = resolve; }) : {} });
  p.start(); await tick();
  assert.equal(p.el('collected-pages').textContent, 1);
  assert.match(p.el('sync-status').textContent, /đồng bộ/i);
  assert.equal(p.el('btn-download').disabled, true);
  p.emit({ action: 'documentActivityUpdated', ...snapshot({ revision: 9, downloadedCount: 3, status: 'complete', active: false }) });
  respond(snapshot({ revision: 8, downloadedCount: 2 })); await tick(); await tick();
  assert.equal(p.el('collected-pages').textContent, 3);
  assert.equal(p.el('btn-download').disabled, false);
  assert.doesNotMatch(p.el('sync-status').textContent, /đồng bộ/i);
  p.emit({ action: 'documentActivityUpdated', ...snapshot({ tabId: 8, revision: 100, downloadedCount: 0 }) });
  p.emit({ action: 'documentActivityUpdated', ...snapshot({ docId: '999', revision: 100, downloadedCount: 0 }) });
  assert.equal(p.el('collected-pages').textContent, 3);
});

test('a restarted worker retains logs but marks an in-memory PDF job interrupted without exporting again', async () => {
  const w = worker({ [key]: snapshot() });
  const state = await w.state();
  assert.equal(state.status, 'interrupted'); assert.equal(state.active, false);
  assert.match(state.logs.map(log => log.message).join('\n'), /1\/3/);
  assert.equal(w.downloads.length, 0);
});

test('cache deletion removes the selected document activity and pending writes cannot resurrect it', async () => {
  const w = worker({ [key]: snapshot({ status: 'complete', active: false }), 'documentActivity:scribd:9:999': snapshot({ tabId: 9, docId: '999' }) });
  await w.state();
  const result = await w.send({ action: 'clearDocumentCache', ...scope });
  assert.equal(result.ok, true); await tick();
  assert.equal(w.stored[key], undefined);
  assert.ok(w.stored['documentActivity:scribd:9:999']);
  assert.equal((await w.state())?.active, false);
});

test('Studocu publishes and restores live tasks with logs from before a worker restart', async () => {
  const studocuKey = 'documentActivity:studocu:7:123';
  const w = worker({ [studocuKey]: snapshot({ site: 'studocu', status: 'complete', active: false, logs: [{ id: 1, at: 100, message: 'Lịch sử cũ được giữ', level: 'info' }] }) });
  const state = { site: 'studocu', docId: '123', assetId: 'a'.repeat(32), mode: 'html', totalPages: 3, count: 3, complete: true, ready: true, isScanning: false };
  let finish, job = { active: false };
  const manager = tasks.create({ chrome: { storage: { local: w.local }, runtime: { async sendMessage() {} } }, support,
    sendContent: async () => state, startDownload: () => new Promise(resolve => { job = { active: true, downloadedCount: 2 }; finish = resolve; }),
    stopDownload() {}, downloadState: () => job,
    onUpdate: task => w.context.recordStudocuActivity(task) });
  const started = await manager.start({ tabId: 7, docId: '123', preference: 'html' });
  for (let i = 0; i < 100 && !finish; i++) await tick();
  assert.equal(typeof finish, 'function');
  await manager.onDownload({ tabId: 7, docId: '123', taskId: started.taskId, downloadedCount: 2 }, { action: 'downloadProgress' });
  const p = popup({ ...w, site: 'studocu' }); p.start(); await tick(); await tick();
  assert.equal(p.el('collected-pages').textContent, 2);
  assert.match(p.el('log').textContent, /Lịch sử cũ được giữ[\s\S]*2\/3/);
  finish({ status: 'finished' }); await tick(); await tick();
  assert.equal(p.el('collected-pages').textContent, 3);
  assert.equal(p.sent.some(m => m.action === 'startStudocuTask'), false);
});

test('document logs remain bounded and stale content replies cannot replace a newer download snapshot', async () => {
  const w = worker();
  for (let n = 0; n < 510; n++) await w.send({ action: 'appendDocumentLog', ...scope, message: 'Dòng ' + n, level: 'info' });
  const state = await w.state();
  assert.equal(state.logs.length, 500); assert.equal(state.logs[0].message, 'Dòng 10');
  assert.equal(w.stored[key].logs.at(-1).message, 'Dòng 509');
  const p = popup({ send: () => ({}), contentHeld: true }); p.start(); await tick();
  p.emit({ action: 'documentActivityUpdated', ...snapshot({ revision: 11, downloadedCount: 2 }) });
  p.emit({ action: 'scanProgress', ...scope, collected: 1, progress: 33 });
  assert.equal(p.el('collected-pages').textContent, 2);
});

test('stopping a Scribd scan preserves its page count and remains stopped when the popup reopens', async () => {
  const w = worker(), sender = { tab: { id: 7, url: 'https://www.scribd.com/document/123/name' } };
  await w.send({ action: 'scanProgress', docId: '123', totalPages: 3, count: 1 }, sender);
  await w.send({ action: 'scanStopped', docId: '123', totalPages: 3, count: 1 }, sender);
  const state = await w.state();
  assert.equal(state.active, false); assert.equal(state.status, 'cancelled');
  const p = popup(w); p.start(); await tick(); await tick();
  assert.equal(p.el('collected-pages').textContent, 1);
  assert.match(p.el('progress-text').textContent, /dừng/i);
  assert.equal(p.el('btn-scan').disabled, false);
});

test('scan messages retain existing Scribd logs after background startup and reject other documents', async () => {
  const w = worker({ [key]: snapshot({ active: false, status: 'ready', logs: [{ id: 1, at: 100, message: 'Lịch sử quét trước', level: 'info' }] }) });
  await w.send({ action: 'scanProgress', docId: '123', totalPages: 3, count: 2 }, { tab: { id: 7, url: 'https://www.scribd.com/document/123/name' } });
  const state = await w.state();
  assert.match(state.logs.map(l => l.message).join('\n'), /Lịch sử quét trước[\s\S]*2\/3/);
  await w.send({ action: 'scanProgress', docId: '123', totalPages: 3, count: 0 }, { tab: { id: 7, url: 'https://www.scribd.com/document/999/other' } });
  assert.equal((await w.state()).count, 2);
});

test('reopening retains an unfinished stage in the log without presenting it as another completed page', async () => {
  const state = snapshot({ activeStages: [{ id: 1, stage: 'css', pageNum: 2, label: 'lấy CSS và bố cục', startedAt: Date.now() - 6000 }],
    logs: [{ id: 1, at: 100, message: 'Trang 2: Đang lấy CSS và bố cục…', level: 'info' }] });
  const p = popup({ send: () => state }); p.start(); await tick(); await tick();
  assert.match(p.el('log').textContent, /Trang 2.*CSS/);
  assert.equal(p.el('collected-pages').textContent, 1);
  p.emit({ action: 'documentActivityUpdated', ...snapshot({ revision: 8, status: 'complete', active: false, downloadedCount: 3, activeStages: [] }) });
  assert.equal(p.el('collected-pages').textContent, 3);
});
