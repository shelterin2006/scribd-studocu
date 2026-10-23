// Static verification harness for content.js URL-collector helpers and the
// background.js low-resolve threshold. Loads the pure helper modules from
// content.js and background.js (via their module.exports guards) and
// exercises:
//   - isCandidateUrl, extractUrlsFromDom, extractUrlsFromScripts, sortUrls,
//     extractPageNumber (existing coverage)
//   - countDomPageIds, countPageNumbersFromUrls, computeProgress (new)
//   - shouldAcceptResolveCount (new, from background.js)

const assert = require('assert');
const fs = require('fs');

// Intercept require('./background.js') so loading the background module
// does not execute its chrome.runtime.onMessage registration (Node has no
// `chrome` global).
const originalRequire = require('./background.js') || {};
const backgroundHelpers = originalRequire;
const helpers = require('./content.js');
const vm = require('vm');

async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${err.message}`);
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${err.message}`);
    }
  }

  console.log('scanned Scribd documents');

  test('accepts legacy Scribd page images in both collector and downloader', () => {
    const url = 'http://html.scribd.com/yg0vdqgjkbdsawe/images/5-53f961534c.jpg';
    assert.strictEqual(helpers.isCandidateUrl(url), true);
    assert.strictEqual(backgroundHelpers.isDirectImageUrl(url), true);
  });

  test('rejects page JSONP on unrelated hosts', () => {
    for (const url of ['https://example.com/pages/1-a.jsonp', 'https://html.scribd.com.evil.test/doc/pages/1-a.jsonp']) {
      assert.strictEqual(helpers.isCandidateUrl(url), false);
      assert.strictEqual(backgroundHelpers.isScribdJsonpPageUrl(url), false);
    }
  });

  test('reads the image page number before hash and token digits', () => {
    const url = 'https://html.scribdassets.com/yg0vdqgjkbdsawe/images/5-53f961534c.jpg?token=test987';
    assert.strictEqual(helpers.extractPageNumber(url), 5);
    assert.strictEqual(backgroundHelpers.extractPageNumber(url), 5);
  });

  test('collects orig URLs from unloaded scanned images', () => {
    const orig = 'http://html.scribd.com/yg0vdqgjkbdsawe/images/2-cbb36b38cd.jpg';
    const root = { querySelectorAll: selector => selector.startsWith('img,') ? [{
      getAttribute: attr => attr === 'orig' ? orig : null
    }] : [] };
    assert.deepStrictEqual(helpers.extractUrlsFromDom(root), [orig]);
  });

  test('keeps the signed loaded image over its unsigned orig URL in either order', () => {
    const orig = 'http://html.scribd.com/yg0vdqgjkbdsawe/images/5-53f961534c.jpg';
    const signed = 'https://html.scribdassets.com/yg0vdqgjkbdsawe/images/5-53f961534c.jpg?token=test987';
    assert.deepStrictEqual(helpers.uniqueUrlsByPageNumber([orig, signed], 85), [signed]);
    assert.deepStrictEqual(helpers.uniqueUrlsByPageNumber([signed, orig], 85), [signed]);
  });

  test('normalizes legacy image hosts to HTTPS assets without losing the query', () => {
    assert.deepStrictEqual(helpers.uniqueUrlsByPageNumber([
      'http://html.scribd.com/yg0vdqgjkbdsawe/images/2-cbb36b38cd.jpg?token=test&v=1'
    ], 85), [
      'https://html.scribdassets.com/yg0vdqgjkbdsawe/images/2-cbb36b38cd.jpg?token=test&v=1'
    ]);
  });

  test('filters other document assets before deduplicating page numbers', () => {
    const current = 'https://html.scribdassets.com/yg0vdqgjkbdsawe/images/1-7d746a06b0.jpg?token=test';
    assert.deepStrictEqual(helpers.uniqueUrlsByPageNumber([
      'https://html.scribdassets.com/aaa-related/pages/1-x.jsonp', current,
      'https://html.scribdassets.com/aaa-related/pages/2-x.jsonp'
    ], 85, 'yg0vdqgjkbdsawe'), [current]);
  });

  test('background preserves JSONP text layers when the image-layer URL is signed', () => {
    const image = { pageNum: 5, type: 'image', url: 'https://html.scribdassets.com/doc/images/5-hash.jpg?token=test' };
    const jsonp = { pageNum: 5, type: 'jsonp', url: 'https://html.scribdassets.com/doc/pages/5-hash.jsonp' };
    assert.deepStrictEqual(backgroundHelpers.uniqueImagesByPageNumber([image, jsonp], 85), [jsonp]);
  });

  test('collector preserves full JSONP rather than exporting only a signed image layer', () => {
    const jsonp = 'https://html.scribdassets.com/doc/pages/5-hash.jsonp';
    const image = 'https://html.scribdassets.com/doc/images/5-hash.jpg?token=test';
    assert.deepStrictEqual(helpers.uniqueUrlsByPageNumber([jsonp, image], 85), [jsonp]);
  });

  // Only browser/network boundaries are faked; parsing, selection, rendering
  // orchestration and PDF construction run from the actual extension source.
  function loadScript(file, globals) {
    const context = vm.createContext({ console: { log() {} }, URL, Uint8Array, Buffer, atob, btoa, setTimeout, clearTimeout, ...globals });
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return context;
  }

  function scanHarness({ pages = [1, 2, 3], expected = 3, cache = {}, docId = '123' } = {}) {
    const stored = structuredClone(cache);
    const messages = [];
    const scrolls = [];
    let listener;
    let visible = pages;
    let beforeSleep = () => {};
    const pageUrl = n => `https://html.scribdassets.com/current/images/${n}-hash.jpg?token=test`;
    const root = {
      querySelectorAll(selector) {
        if (selector.startsWith('img,')) return visible.map(n => ({ getAttribute: attr => attr === 'src' ? pageUrl(n) : null }));
        if (selector.includes('outer_page')) return Array.from({ length: expected }, (_, i) => ({ id: 'outer_page_' + (i + 1) }));
        return [];
      },
      querySelector(selector) {
        const n = Number((selector.match(/outer_page_(\d+)/) || [])[1]);
        return n > 0 && n <= expected ? { getBoundingClientRect: () => ({ top: n * 1000 }), scrollIntoView() { scrolls.push(n); } } : null;
      }
    };
    const context = loadScript('./content.js', {
      setTimeout(fn) { beforeSleep(); queueMicrotask(fn); return 1; },
      window: {
        location: { href: `https://www.scribd.com/document/${docId}/example` }, innerHeight: 800, scrollY: 0,
        scrollTo(x, y) { scrolls.push(y); this.scrollY = y; }, addEventListener() {}
      },
      document: {
        querySelector: selector => selector === '#document_container' ? root : null,
        querySelectorAll: selector => selector === 'script' ? [] : root.querySelectorAll(selector),
        createElement: () => ({ remove() {} }),
        body: { scrollHeight: 10000 },
        documentElement: { scrollHeight: 10000, appendChild() {} }
      },
      chrome: {
        runtime: {
          onMessage: { addListener(fn) { listener = fn; } },
          getURL: file => 'chrome-extension://test/' + file,
          sendMessage(message) { messages.push(message); return Promise.resolve(); }
        },
        storage: { local: {
          async get(keys) { return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])])); },
          async set(values) { Object.assign(stored, structuredClone(values)); }
        } }
      }
    });
    return { context, stored, messages, scrolls, pageUrl,
      setPages(value) { visible = value; }, setBeforeSleep(fn) { beforeSleep = fn; },
      message(request) {
        let timer;
        return Promise.race([
          new Promise(resolve => listener(request, {}, resolve)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Content message did not respond')), 1000); })
        ]).finally(() => clearTimeout(timer));
      }
    };
  }

  await testAsync('quick inspection marks all consecutive pages ready without scrolling and persists outside popup', async () => {
    const harness = scanHarness();
    const state = await harness.message({ action: 'getScanState' });
    assert.strictEqual(state.complete, true);
    assert.strictEqual(state.count, 3);
    assert.strictEqual(state.docId, '123');
    assert.strictEqual(harness.scrolls.length, 0);
    assert.strictEqual(harness.stored['scribdScan:123'].complete, true);
  });

  await testAsync('a new content script restores the same document after tab reload', async () => {
    const first = scanHarness();
    await first.message({ action: 'getScanState' });
    const reopened = scanHarness({ pages: [1], cache: first.stored });
    const state = await reopened.message({ action: 'getScanState' });
    assert.strictEqual(state.complete, true);
    assert.deepStrictEqual(Array.from(state.urls, helpers.extractPageNumber), [1, 2, 3]);
    assert.strictEqual(reopened.scrolls.length, 0);
  });

  await testAsync('same count with a missing page is partial and unrelated document cache is ignored', async () => {
    const harness = scanHarness({ pages: [1, 3, 4], cache: {
      'scribdScan:999': { docId: '999', totalPages: 3, assetId: 'current', urls: [1, 2, 3].map(n => `https://html.scribdassets.com/current/images/${n}-x.jpg`) }
    } });
    const state = await harness.message({ action: 'getScanState' });
    assert.strictEqual(state.complete, false);
    assert.deepStrictEqual(Array.from(state.missingPages), [2]);
    assert.strictEqual(harness.stored['scribdScan:999'].docId, '999');
  });

  await testAsync('starting an already complete scan skips scrolling and emits completion', async () => {
    const harness = scanHarness();
    await vm.runInContext('startScanning(3, () => {})', harness.context);
    assert.strictEqual(harness.scrolls.length, 0);
    assert.strictEqual(harness.messages.at(-1).action, 'scanComplete');
    assert.strictEqual(harness.stored['scribdScan:123'].complete, true);
  });

  await testAsync('partial cache supplements only missing page and retains existing page URLs', async () => {
    const harness = scanHarness({ pages: [1, 3] });
    await harness.message({ action: 'getScanState' });
    harness.setBeforeSleep(() => harness.setPages([1, 2, 3]));
    await vm.runInContext('startScanning(3, () => {})', harness.context);
    assert.strictEqual(harness.stored['scribdScan:123'].complete, true);
    assert.deepStrictEqual(harness.stored['scribdScan:123'].urls.map(helpers.extractPageNumber), [1, 2, 3]);
    assert.ok(harness.scrolls.length > 0);
    assert.ok(harness.scrolls.length <= 3, 'complete coverage should stop the scan promptly');
  });

  await testAsync('stopping a scan saves partial progress and never emits scanComplete', async () => {
    const harness = scanHarness({ pages: [1] });
    harness.setBeforeSleep(() => vm.runInContext('stopScanning()', harness.context));
    await vm.runInContext('startScanning(3, () => {})', harness.context);
    assert.strictEqual(harness.messages.some(message => message.action === 'scanComplete'), false);
    assert.deepStrictEqual(harness.stored['scribdScan:123'].urls.map(helpers.extractPageNumber), [1]);
  });

  await testAsync('stop during cache initialization cancels the scan before any scroll or completion', async () => {
    const harness = scanHarness({ pages: [1] });
    let release;
    harness.context.chrome.storage.local.get = () => new Promise(resolve => { release = resolve; });
    const running = vm.runInContext('startScanning(3, () => {})', harness.context);
    vm.runInContext('stopScanning()', harness.context);
    release({});
    await running;
    assert.strictEqual(harness.scrolls.length, 0);
    assert.strictEqual(harness.messages.some(message => message.action === 'scanComplete'), false);
  });

  await testAsync('expired signed cache stays partial and retains all other usable pages', async () => {
    const token = 'header.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.signature';
    const expired = `https://html.scribdassets.com/current/images/2-hash.jpg?token=${token}`;
    const harness = scanHarness({ pages: [1, 3], cache: {
      'scribdScan:123': { docId: '123', assetId: 'current', totalPages: 3, complete: true,
        urls: ['https://html.scribdassets.com/current/images/1-hash.jpg?token=test', expired,
          'https://html.scribdassets.com/current/images/3-hash.jpg?token=test'] }
    } });
    const state = await harness.message({ action: 'getScanState' });
    assert.strictEqual(state.complete, false);
    assert.deepStrictEqual(Array.from(state.missingPages), [2]);
    assert.deepStrictEqual(harness.stored['scribdScan:123'].urls.map(helpers.extractPageNumber), [1, 3]);
  });

  await testAsync('an unavailable page URL refreshes only that page and preserves other cached pages', async () => {
    const harness = scanHarness();
    await harness.message({ action: 'getScanState' });
    const state = await harness.message({ action: 'refreshScanPage', pageNum: 2,
      candidateUrl: 'https://html.scribdassets.com/current/images/2-hash.jpg?token=old' });
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.url, harness.pageUrl(2));
    assert.deepStrictEqual(harness.stored['scribdScan:123'].urls.map(helpers.extractPageNumber), [1, 2, 3]);
    assert.ok(harness.scrolls.length <= 1, 'a fresh URL already present should not trigger a scan');
  });

  await testAsync('a text page refresh observes a new JSONP network URL rather than replacing it with an image layer', async () => {
    const harness = scanHarness();
    const original = 'https://html.scribdassets.com/current/pages/2-hash.jsonp?token=old';
    const fresh = 'https://html.scribdassets.com/current/pages/2-hash.jsonp?token=fresh';
    let entries = [{ name: original }];
    harness.context.performance = { getEntriesByType: () => entries };
    await harness.message({ action: 'getScanState' });
    harness.setBeforeSleep(() => { entries = [{ name: original }, { name: fresh }]; });
    const state = await harness.message({ action: 'refreshScanPage', pageNum: 2, candidateUrl: original });
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.url, fresh);
    assert.strictEqual(harness.stored['scribdScan:123'].complete, true);
  });

  await testAsync('failed JSONP refresh keeps the page missing instead of caching only its image layer', async () => {
    const harness = scanHarness();
    const original = 'https://html.scribdassets.com/current/pages/2-hash.jsonp?token=old';
    harness.context.performance = { getEntriesByType: () => [{ name: original }] };
    await harness.message({ action: 'getScanState' });
    const state = await harness.message({ action: 'refreshScanPage', pageNum: 2, candidateUrl: original });
    assert.strictEqual(state.ok, false);
    assert.strictEqual(harness.stored['scribdScan:123'].complete, false);
    assert.deepStrictEqual(harness.stored['scribdScan:123'].missingPages, [2]);
  });

  await testAsync('invalidating a rejected replacement persists partial state without scrolling', async () => {
    const harness = scanHarness();
    await harness.message({ action: 'getScanState' });
    const state = await harness.message({ action: 'invalidateScanPage', pageNum: 2, candidateUrl: harness.pageUrl(2) });
    assert.strictEqual(state.complete, false);
    assert.deepStrictEqual(Array.from(state.missingPages), [2]);
    assert.strictEqual(harness.scrolls.length, 0);
    const reopened = scanHarness({ pages: [1, 3], cache: harness.stored });
    assert.strictEqual((await reopened.message({ action: 'getScanState' })).complete, false);
  });

  function popupHarness(state) {
    const elements = new Map();
    const sent = [];
    const requested = [];
    let ready;
    const listeners = [];
    const context = loadScript('./popup.js', {
      document: {
        addEventListener(name, fn) { if (name === 'DOMContentLoaded') ready = fn; },
        createElement() { return { textContent: '' }; },
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, {
            style: {}, disabled: id === 'btn-download', textContent: '', innerHTML: '',
            classList: { add() {}, remove() {} }, addEventListener() {},
            appendChild(child) { this.innerHTML += child.textContent; }
          });
          return elements.get(id);
        }
      },
      chrome: {
        tabs: {
          async query() { return [{ id: 7, windowId: 1, url: 'https://www.scribd.com/document/123/example' }]; },
          sendMessage(tabId, request, callback) {
            requested.push(request.action);
            callback(request.action === 'getDocInfo' ? { docId: '123', totalPages: 3 } : state);
          }
        },
        runtime: {
          onMessage: { addListener(fn) { listeners.push(fn); }, removeListener() {} },
          sendMessage(request) { if (request.action === 'getDocumentCacheStatus') return Promise.resolve({ ok: true, busy: false }); sent.push(request); return Promise.resolve(); }
        },
        storage: { local: {
          async get() { return { docId: '999', collectedUrls: ['https://html.scribdassets.com/wrong/images/1-x.jpg'], totalPages: 1 }; },
          set(data, callback) { if (callback) callback(); }
        } }
      }
    });
    return { context, elements, sent, requested, listeners, async open() { await ready(); await Promise.resolve(); } };
  }

  const readyState = { docId: '123', totalPages: 3, count: 3, complete: true, isScanning: false,
    urls: [1, 2, 3].map(n => `https://html.scribdassets.com/current/images/${n}-hash.jpg?token=test`) };

  await testAsync('reopened popup restores complete coverage and enables download without starting a scan', async () => {
    const harness = popupHarness(readyState);
    await harness.open();
    assert.strictEqual(harness.elements.get('btn-download').disabled, false);
    assert.strictEqual(harness.elements.get('collected-pages').textContent, 3);
    assert.match(harness.elements.get('log').innerHTML, /3\/3/);
    assert.strictEqual(harness.requested.includes('startScan'), false);
    assert.strictEqual(harness.sent.filter(m => m.action === 'downloadImages').length, 0);
  });

  await testAsync('Scribd popup requests the fast path and displays actual download progress separately from URL readiness', async () => {
    const harness = popupHarness(readyState);
    await harness.open();
    await vm.runInContext('downloadPDF()', harness.context);
    assert.strictEqual(harness.sent.at(-1).fast, true);
    assert.strictEqual(harness.elements.get('progress-fill').style.width, '0%');
    for (const listener of harness.listeners) listener({ action: 'downloadProgress', docId: '123', phase: 'pdf', current: 1, total: 3, percent: 33 }, {});
    assert.strictEqual(harness.elements.get('progress-fill').style.width, '33%');
    assert.strictEqual(harness.elements.get('collected-pages').textContent, 1);
  });

  await testAsync('download uses current document state rather than another document in legacy storage', async () => {
    const harness = popupHarness(readyState);
    await harness.open();
    await vm.runInContext('downloadPDF()', harness.context);
    const request = harness.sent.find(message => message.action === 'downloadImages');
    assert.strictEqual(request.docId, '123');
    assert.deepStrictEqual(Array.from(request.urls), readyState.urls);
    assert.strictEqual(harness.requested.includes('startScan'), false);
  });

  await testAsync('popup ignores scan completion from another tab or document', async () => {
    const harness = popupHarness({ ...readyState, count: 1, complete: false, urls: readyState.urls.slice(0, 1) });
    await harness.open();
    harness.listeners[0]({ action: 'scanComplete', ...readyState, docId: '999' }, { tab: { id: 8 } });
    await Promise.resolve();
    assert.strictEqual(harness.elements.get('btn-download').disabled, true);
    assert.strictEqual(harness.sent.filter(m => m.action === 'downloadImages').length, 0);
  });

  await testAsync('unknown total never marks a nonempty scan complete or starts a download', async () => {
    const harness = popupHarness({ ...readyState, totalPages: 0, complete: false });
    await harness.open();
    harness.listeners[0]({ action: 'scanComplete', ...readyState, totalPages: 0, complete: false }, { tab: { id: 7 } });
    await Promise.resolve();
    assert.strictEqual(harness.elements.get('btn-download').disabled, true);
    assert.notStrictEqual(harness.elements.get('progress-text').textContent, '100%');
    assert.strictEqual(harness.sent.filter(m => m.action === 'downloadImages').length, 0);
    await vm.runInContext('downloadPDF()', harness.context);
    assert.strictEqual(harness.sent.filter(m => m.action === 'downloadImages').length, 0);
  });

  await testAsync('legacy candidate count is not treated as a reliable expected page count', async () => {
    const harness = scanHarness({ pages: [1], expected: 0, cache: {
      docId: '123', totalPages: 1,
      collectedUrls: ['https://html.scribdassets.com/current/images/1-hash.jpg?token=test']
    } });
    const state = await harness.message({ action: 'getScanState' });
    assert.strictEqual(state.totalPages, 0);
    assert.strictEqual(state.complete, false);
  });

  test('document info counts all 85 page wrappers rather than four loaded images', () => {
    let listener;
    const context = loadScript('./content.js', {
      window: { location: { href: 'https://www.scribd.com/document/668265620/example' } },
      document: {
        querySelector: () => null,
        querySelectorAll: selector => selector.includes('outer_page')
          ? Array.from({ length: 85 }, (_, i) => ({ id: 'outer_page_' + (i + 1) }))
          : selector === '[id^="page"]' ? Array(4).fill({}) : []
      },
      chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } }
    });
    let info;
    listener({ action: 'getDocInfo' }, {}, result => { info = result; });
    assert.strictEqual(info.docId, '668265620');
    assert.strictEqual(info.totalPages, 85);
  });

  await testAsync('downloader refuses a partial 4-page collection for an 85-page document', async () => {
    let listener;
    const messages = [];
    let networkCalls = 0;
    let downloads = 0;
    const completed = new Promise(resolve => {
      loadScript('./background.js', {
        fetch: async () => { networkCalls++; throw new Error('Unexpected network request'); },
        chrome: {
          runtime: {
            onMessage: { addListener(fn) { listener = fn; } },
            sendMessage(message) { messages.push(message); resolve(); return Promise.resolve(); }
          },
          downloads: { async download() { downloads++; return 1; } }
        }
      });
    });
    listener({ action: 'downloadImages', docId: '668265620', expectedPages: 85,
      urls: [1, 2, 3, 4].map(n => `https://html.scribdassets.com/doc/images/${n}-hash.jpg?token=test`) }, {}, () => {});
    await completed;
    assert.strictEqual(messages[0].action, 'downloadError');
    assert.match(messages[0].error, /4\/85/);
    assert.strictEqual(networkCalls, 0);
    assert.strictEqual(downloads, 0);
  });

  test('final collection uses only current document assets and the latest loaded signed src', () => {
    const signed = 'https://html.scribdassets.com/yg0vdqgjkbdsawe/images/5-53f961534c.jpg?token=current987';
    const old = signed.replace('current987', 'old123');
    const image = { getAttribute: attr => ({ src: signed,
      orig: 'http://html.scribd.com/yg0vdqgjkbdsawe/images/5-53f961534c.jpg' })[attr] || null };
    const root = { querySelectorAll: selector => selector.startsWith('img,') ? [image] : [] };
    const context = loadScript('./content.js', {
      document: {
        querySelector: () => root,
        querySelectorAll: selector => selector === 'script' ? [{ textContent:
          `var a = "${old}"; var b = "https://html.scribdassets.com/related/pages/5-x.jsonp?token=other";`
        }] : []
      },
      performance: { getEntriesByType: () => [] }
    });
    const result = vm.runInContext('totalPages = 85; collectAllUrlsAfterScroll(); [...collectedUrls]', context);
    assert.deepStrictEqual(Array.from(result), [signed]);
  });

  test('retained signed URLs beat stale history when a loaded page leaves the DOM', () => {
    const current = 'https://html.scribdassets.com/doc/images/5-hash.jpg?token=current';
    const tail = 'https://html.scribdassets.com/doc/images/85-hash.jpg?token=tail';
    const makeRoot = url => ({ querySelectorAll: selector => selector.startsWith('img,') ? [{
      getAttribute: attr => attr === 'src' ? url : null
    }] : [] });
    let root = makeRoot(current);
    const context = loadScript('./content.js', {
      document: { querySelector: () => root, querySelectorAll: () => [] },
      performance: { getEntriesByType: () => [
        { name: current.replace('current', 'old') }, { name: current }
      ] }
    });
    vm.runInContext('estimateLoadedPages()', context);
    root = makeRoot(tail);
    const result = vm.runInContext('totalPages = 85; collectAllUrlsAfterScroll(); [...collectedUrls]', context);
    assert.deepStrictEqual(Array.from(result), [current, tail]);
  });

  await testAsync('popup blocks automatic download and shows a warning for missing pages', async () => {
    const elements = new Map();
    const classes = new Set();
    const sent = [];
    let listener;
    let stored = {};
    const context = loadScript('./popup.js', {
      document: {
        addEventListener() {},
        createElement() { return { textContent: '' }; },
        getElementById(id) {
          if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', innerHTML: '',
            classList: { add: name => classes.add(name), remove: (...names) => names.forEach(n => classes.delete(n)) },
            appendChild(child) { this.innerHTML += child.textContent; }
          });
          return elements.get(id);
        }
      },
      chrome: {
        runtime: {
          onMessage: { addListener(fn) { listener = fn; } },
          sendMessage(message) { sent.push(message); }
        },
        storage: { local: {
          set(data, callback) { stored = data; if (callback) callback(); },
          async get() { return stored; }
        } }
      }
    });
    vm.runInContext('totalPages = 85', context);
    listener({ action: 'scanComplete', urls: [1, 2, 3, 4].map(n => `https://html.scribdassets.com/doc/images/${n}-x.jpg`), count: 4 });
    await Promise.resolve();
    assert.strictEqual(elements.get('btn-download').disabled, true);
    assert.match(elements.get('log').innerHTML, /4\/85/);
    assert.strictEqual(classes.has('log-warn'), true);
    assert.strictEqual(sent.length, 0);
  });

  await testAsync('complete scanned-image download fetches signed URLs in page order and builds a PDF', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 32, 2, 88, 3,
      1, 17, 0, 2, 17, 0, 3, 17, 0, 0xff, 0xd9]);
    const fetched = [];
    const downloads = [];
    const messages = [];
    let listener;
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    loadScript('./background.js', {
      fetch: async url => {
        fetched.push(url);
        return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => jpeg.buffer };
      },
      chrome: {
        runtime: {
          onMessage: { addListener(fn) { listener = fn; } },
          sendMessage(message) { messages.push(message); if (['downloadComplete', 'downloadError'].includes(message.action)) finish(); return Promise.resolve(); }
        },
        tabs: { sendMessage(tabId, message, callback) {
          assert.strictEqual(tabId, 7);
          assert.strictEqual(message.action, 'renderJsonpPageToImage');
          callback({ ok: true, dataUrl: 'data:image/jpeg;base64,' + Buffer.from(jpeg).toString('base64') });
        } },
        downloads: { async download(options) { downloads.push(options); return 1; } }
      }
    });
    listener({ action: 'downloadImages', docId: '668265620', expectedPages: 2, tabId: 7, urls: [
      'http://html.scribd.com/yg0vdqgjkbdsawe/images/2-cbb36b38cd.jpg?token=two987',
      'https://html.scribdassets.com/yg0vdqgjkbdsawe/images/1-7d746a06b0.jpg?token=one123'
    ] }, {}, () => {});
    await finished;
    assert.deepStrictEqual(fetched, [
      'https://html.scribdassets.com/yg0vdqgjkbdsawe/images/1-7d746a06b0.jpg?token=one123',
      'https://html.scribdassets.com/yg0vdqgjkbdsawe/images/2-cbb36b38cd.jpg?token=two987'
    ]);
    assert.strictEqual(downloads.length, 1);
    assert.strictEqual(downloads[0].filename, 'scribd_668265620/document.pdf');
    const pdf = Buffer.from(downloads[0].url.split(',')[1], 'base64').toString('latin1');
    assert.match(pdf, /^%PDF-1\.4/);
    assert.match(pdf, /\/Count 2\b/);
    assert.strictEqual(messages.at(-1).action, 'downloadComplete');
    assert.strictEqual(messages.at(-1).pdfPages, 2);
  });

  await testAsync('HTTP 403 refreshes only the failed page URL and retries once without rescanning', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 32, 2, 88, 3,
      1, 17, 0, 2, 17, 0, 3, 17, 0, 0xff, 0xd9]);
    const fetched = [];
    const refreshed = [];
    let listener;
    let finish;
    let result;
    let downloads = 0;
    const finished = new Promise(resolve => { finish = resolve; });
    loadScript('./background.js', {
      fetch: async url => {
        fetched.push(url);
        return { ok: !url.includes('token=old'), status: url.includes('token=old') ? 403 : 200,
          headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => jpeg.buffer };
      },
      chrome: {
        runtime: {
          onMessage: { addListener(fn) { listener = fn; } },
          sendMessage(message) { if (['downloadComplete', 'downloadError'].includes(message.action)) { result = message; finish(); } return Promise.resolve(); }
        },
        tabs: { sendMessage(tabId, request, callback) {
          if (request.action === 'refreshScanPage') {
            refreshed.push(request.pageNum);
            callback({ ok: true, url: 'https://html.scribdassets.com/current/images/2-hash.jpg?token=fresh' });
          } else {
            assert.strictEqual(request.action, 'renderJsonpPageToImage');
            callback({ ok: true, dataUrl: 'data:image/jpeg;base64,' + Buffer.from(jpeg).toString('base64') });
          }
        } },
        downloads: { async download() { downloads++; return 1; } }
      }
    });
    listener({ action: 'downloadImages', docId: '123', tabId: 7, expectedPages: 2, urls: [
      'https://html.scribdassets.com/current/images/1-hash.jpg?token=valid',
      'https://html.scribdassets.com/current/images/2-hash.jpg?token=old'
    ] }, {}, () => {});
    await finished;
    assert.strictEqual(result.action, 'downloadComplete');
    assert.deepStrictEqual(refreshed, [2]);
    assert.deepStrictEqual(fetched, [
      'https://html.scribdassets.com/current/images/1-hash.jpg?token=valid',
      'https://html.scribdassets.com/current/images/2-hash.jpg?token=old',
      'https://html.scribdassets.com/current/images/2-hash.jpg?token=fresh'
    ]);
    assert.strictEqual(downloads, 1);
  });

  await testAsync('a failed retry invalidates its replacement and never loops or downloads a partial PDF', async () => {
    let listener;
    let finish;
    const terminal = new Promise(resolve => { finish = resolve; });
    const actions = [];
    let fetches = 0;
    let downloads = 0;
    loadScript('./background.js', {
      fetch: async () => { fetches++; return { ok: false, status: 403 }; },
      chrome: {
        runtime: {
          onMessage: { addListener(fn) { listener = fn; } },
          sendMessage(message) { if (['downloadComplete', 'downloadError'].includes(message.action)) finish(message); return Promise.resolve(); }
        },
        tabs: { sendMessage(tabId, request, callback) {
          actions.push(request.action);
          callback({ ok: true, url: 'https://html.scribdassets.com/current/images/1-hash.jpg?token=fresh' });
        } },
        downloads: { async download() { downloads++; } }
      }
    });
    listener({ action: 'downloadImages', docId: '123', tabId: 7, expectedPages: 1,
      urls: ['https://html.scribdassets.com/current/images/1-hash.jpg?token=old'] }, {}, () => {});
    const result = await terminal;
    assert.strictEqual(result.action, 'downloadError');
    assert.deepStrictEqual(actions, ['refreshScanPage', 'invalidateScanPage']);
    assert.strictEqual(fetches, 2);
    assert.strictEqual(downloads, 0);
  });

  console.log('isCandidateUrl');

  test('accepts Scribd jsonp /pages/ URL', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('https://html.scribdassets.com/2kj4lk/pages/1-abc.jsonp'),
      true
    );
  });

  test('rejects scribdassets embeds path without a page JSONP/image', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('https://html.scribdassets.com/2kj4lk/embeds/1-abc'),
      false
    );
  });

  test('accepts direct Scribd document page image URL', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('https://html.scribdassets.com/2kj4lk/images/1-abc123.jpg?token=xyz'),
      true
    );
  });

  test('rejects unrelated .png with query string', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('https://example.com/foo/bar.png?v=1'),
      false
    );
  });

  test('rejects unrelated .webp with fragment', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('https://example.com/img.webp#frag'),
      false
    );
  });

  test('rejects Scribd UI/app-store assets and fallback ad images', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('https://s-f.scribdassets.com/webpack/assets/images/shared/app_store/play_store_en.52ebe950.svg'),
      false
    );
    assert.strictEqual(
      helpers.isCandidateUrl('https://s-f.scribdassets.com/webpack/assets/images/fallbacks/scribd_inhouse_dunning_728x90_en@1x.e9858146.png'),
      false
    );
  });

  test('rejects non-http URL', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('data:image/png;base64,AAAA'),
      false
    );
  });

  test('rejects empty string', () => {
    assert.strictEqual(helpers.isCandidateUrl(''), false);
  });

  test('rejects unrelated host without image ext', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('https://example.com/index.html'),
      false
    );
  });

  test('rejects scribd.com path without image ext', () => {
    assert.strictEqual(
      helpers.isCandidateUrl('https://www.scribd.com/document/12345'),
      false
    );
  });

  console.log('extractPageNumber');

  test('parses pages/N- pattern', () => {
    assert.strictEqual(
      helpers.extractPageNumber('https://x/pages/7-abc.jsonp'),
      7
    );
  });

  test('falls back to trailing number', () => {
    assert.strictEqual(
      helpers.extractPageNumber('https://x/page/003'),
      3
    );
  });

  test('returns large number when no number found', () => {
    const n = helpers.extractPageNumber('https://x/foo');
    assert.ok(n >= 1e15);
  });

  console.log('sortUrls');

  test('dedupes and orders by page number', () => {
    const sorted = helpers.sortUrls([
      'https://x/pages/3-a.jsonp',
      'https://x/pages/1-a.jsonp',
      'https://x/pages/2-a.jsonp',
      'https://x/pages/1-a.jsonp'
    ]);
    assert.deepStrictEqual(
      sorted.map(helpers.extractPageNumber),
      [1, 2, 3]
    );
    assert.strictEqual(new Set(sorted).size, sorted.length);
  });

  test('uniqueUrlsByPageNumber keeps one URL per page number', () => {
    const urls = [
      'https://html.scribdassets.com/doc/images/1-a.jpg?token=old',
      'https://html.scribdassets.com/doc/images/1-a.jpg?token=new',
      'https://html.scribdassets.com/doc/images/2-b.jpg?token=x',
      'https://html.scribdassets.com/doc/images/204-z.jpg?token=x'
    ];
    const unique = helpers.uniqueUrlsByPageNumber(urls);
    assert.deepStrictEqual(unique.map(helpers.extractPageNumber), [1, 2, 204]);
  });

  test('uniqueUrlsByPageNumber can cap URLs to expected document page count', () => {
    const urls = [
      'https://html.scribdassets.com/current/pages/1-a.jsonp',
      'https://html.scribdassets.com/current/pages/2-b.jsonp',
      'https://html.scribdassets.com/related/pages/7-c.jsonp',
      'https://html.scribdassets.com/related/pages/8-d.jsonp'
    ];
    const unique = helpers.uniqueUrlsByPageNumber(urls, 6);
    assert.deepStrictEqual(unique.map(helpers.extractPageNumber), [1, 2]);
  });

  console.log('extractUrlsFromDom');

  test('collects src, data-src, data-original, and background-image', () => {
    const fakeEl = (attrs) => ({
      getAttribute: (name) => (attrs[name] != null ? attrs[name] : null),
      querySelectorAll: () => []
    });
    const root = {
      querySelectorAll: (selector) => {
        if (selector === 'img, source, a, link, [style], [data-src], [data-original]') {
          return [
            fakeEl({ src: 'https://x/pages/1-a.jpg' }),
            fakeEl({ 'data-src': 'https://x/pages/2-a.jpg' }),
            fakeEl({ 'data-original': 'https://x/pages/3-a.jpg' }),
            fakeEl({ style: "background-image: url('https://x/pages/4-a.jpg')" })
          ];
        }
        if (selector === '.page, .document_page, [data-page-number], [data-page], [id^="page"]') {
          return [];
        }
        return [];
      }
    };
    const urls = helpers.extractUrlsFromDom(root);
    assert.deepStrictEqual(urls, [
      'https://x/pages/1-a.jpg',
      'https://x/pages/2-a.jpg',
      'https://x/pages/3-a.jpg',
      'https://x/pages/4-a.jpg'
    ]);
  });

  test('collects URLs from Scribd page containers too', () => {
    const root = {
      querySelectorAll: (selector) => {
        if (selector === 'img, source, a, link, [style], [data-src], [data-original]') {
          return [];
        }
        if (selector === '.page, .document_page, [data-page-number], [data-page], [id^="page"]') {
          const innerImg = {
            getAttribute: (n) => (n === 'src' ? 'https://x/pages/5-a.jpg' : null),
            querySelectorAll: () => []
          };
          return [{
            getAttribute: () => null,
            querySelectorAll: () => [innerImg]
          }];
        }
        return [];
      }
    };
    const urls = helpers.extractUrlsFromDom(root);
    assert.deepStrictEqual(urls, ['https://x/pages/5-a.jpg']);
  });

  console.log('extractUrlsFromScripts');

  test('extracts image URLs and jsonp URLs from inline scripts', () => {
    const root = {
      querySelectorAll: () => [{
        textContent: 'var a = "https://x/pages/1-a.jpg"; var b = "https://x/2.jsonp"; var c = "https://www.scribd.com/document/123";'
      }]
    };
    const urls = helpers.extractUrlsFromScripts(root);
    assert.ok(urls.includes('https://x/pages/1-a.jpg'));
    assert.ok(urls.some(u => u.includes('2.jsonp')));
  });

  console.log('countDomPageIds');

  test('counts unique page identifiers from data-page-number', () => {
    const root = {
      querySelectorAll: (selector) => {
        if (selector !== '[data-page-number], [data-page], [id^="page"], .page, .document_page') {
          return [];
        }
        return [
          { getAttribute: (n) => (n === 'data-page-number' ? '1' : null), classList: { contains: () => false } },
          { getAttribute: (n) => (n === 'data-page-number' ? '2' : null), classList: { contains: () => false } },
          { getAttribute: (n) => (n === 'data-page-number' ? '2' : null), classList: { contains: () => false } },
          { getAttribute: (n) => (n === 'data-page-number' ? '3' : null), classList: { contains: () => false } }
        ];
      }
    };
    assert.strictEqual(helpers.countDomPageIds(root), 3);
  });

  test('counts unique ids and data-page too', () => {
    const root = {
      querySelectorAll: (selector) => {
        if (selector !== '[data-page-number], [data-page], [id^="page"], .page, .document_page') {
          return [];
        }
        return [
          { getAttribute: (n) => (n === 'data-page' ? '5' : null), classList: { contains: () => false } },
          { getAttribute: (n) => (n === 'id' ? 'page7' : null), classList: { contains: () => false } },
          { getAttribute: (n) => (n === 'id' ? 'page9' : null), classList: { contains: () => false } }
        ];
      }
    };
    assert.strictEqual(helpers.countDomPageIds(root), 3);
  });

  console.log('countPageNumbersFromUrls');

  test('counts unique page numbers from candidate URLs', () => {
    const urls = [
      'https://x/pages/1-a.jsonp',
      'https://x/pages/2-a.jsonp',
      'https://x/pages/2-b.jsonp',
      'https://x/pages/4-a.jsonp',
      'https://x/foo' // ignored: no page number
    ];
    assert.strictEqual(helpers.countPageNumbersFromUrls(urls), 3);
  });

  console.log('computeProgress');

  test('uses estimated / expected when expectedPages > 0', () => {
    const p = helpers.computeProgress(50, 200, 0.9);
    assert.strictEqual(p, 25);
  });

  test('caps below 99 during scroll even when estimated >= expected', () => {
    const p = helpers.computeProgress(250, 200, 1.0);
    assert.ok(p <= 99, 'progress should be capped below 100');
    assert.strictEqual(p, 99);
  });

  test('falls back to scroll fraction when expectedPages is 0', () => {
    assert.strictEqual(helpers.computeProgress(0, 0, 0.5), 50);
    assert.strictEqual(helpers.computeProgress(10, 0, 0.0), 0);
  });

  test('clamps negative or out-of-range inputs', () => {
    assert.strictEqual(helpers.computeProgress(-1, 0, -1), 0);
    assert.strictEqual(helpers.computeProgress(0, 0, 2), 99);
  });

  console.log('background.shouldAcceptResolveCount');

  if (!backgroundHelpers || typeof backgroundHelpers.shouldAcceptResolveCount !== 'function') {
    test('exports shouldAcceptResolveCount', () => {
      throw new Error('shouldAcceptResolveCount not exported by background.js');
    });
  } else {
    test('user-reported 9/216 case fails the threshold', () => {
      assert.strictEqual(backgroundHelpers.shouldAcceptResolveCount(9, 216), false);
    });

    test('small total (<20) only needs >0 resolved', () => {
      assert.strictEqual(backgroundHelpers.shouldAcceptResolveCount(1, 5), true);
      assert.strictEqual(backgroundHelpers.shouldAcceptResolveCount(0, 5), false);
    });

    test('large total passes when >= max(10, 25%)', () => {
      // 216 * 0.25 = 54, threshold = max(10, 54) = 54
      assert.strictEqual(backgroundHelpers.shouldAcceptResolveCount(54, 216), true);
      assert.strictEqual(backgroundHelpers.shouldAcceptResolveCount(53, 216), false);
    });

    test('boundary at exactly 20 total with 4 resolved passes', () => {
      // 20 * 0.25 = 5, threshold = max(10, 5) = 10
      assert.strictEqual(backgroundHelpers.shouldAcceptResolveCount(10, 20), true);
      assert.strictEqual(backgroundHelpers.shouldAcceptResolveCount(9, 20), false);
    });

    test('background direct-image resolver only accepts real Scribd page images', () => {
      assert.strictEqual(
        backgroundHelpers.isDirectImageUrl('https://html.scribdassets.com/2kj4lk/images/1-abc123.jpg?token=xyz'),
        true
      );
      assert.strictEqual(
        backgroundHelpers.isDirectImageUrl('https://s-f.scribdassets.com/webpack/assets/images/fallbacks/scribd_inhouse_dunning_728x90_en@1x.e9858146.png'),
        false
      );
      assert.strictEqual(
        backgroundHelpers.isDirectImageUrl('https://s-f.scribdassets.com/webpack/assets/images/shared/app_store/play_store_en.52ebe950.svg'),
        false
      );
    });

    test('background uniqueImagesByPageNumber keeps one image per page', () => {
      const unique = backgroundHelpers.uniqueImagesByPageNumber([
        { pageNum: 1, url: 'old' },
        { pageNum: 1, url: 'new' },
        { pageNum: 2, url: 'two' }
      ]);
      assert.deepStrictEqual(unique, [
        { pageNum: 1, url: 'old' },
        { pageNum: 2, url: 'two' }
      ]);
    });

    test('background uniqueImagesByPageNumber caps to expected page count', () => {
      const unique = backgroundHelpers.uniqueImagesByPageNumber([
        { pageNum: 1, url: 'one' },
        { pageNum: 6, url: 'six' },
        { pageNum: 7, url: 'related-seven' },
        { pageNum: 8, url: 'related-eight' }
      ], 6);
      assert.deepStrictEqual(unique, [
        { pageNum: 1, url: 'one' },
        { pageNum: 6, url: 'six' }
      ]);
    });

    test('derives direct page image URL from Scribd JSONP URL and preserves token', () => {
      assert.strictEqual(typeof backgroundHelpers.imageUrlFromJsonpPageUrl, 'function');
      assert.strictEqual(
        backgroundHelpers.imageUrlFromJsonpPageUrl(
          'https://html.scribdassets.com/4u81nfne0wc7mksz/pages/5-31793894e5.jsonp?token=abc'
        ),
        'https://html.scribdassets.com/4u81nfne0wc7mksz/images/5-31793894e5.jpg?token=abc'
      );
    });

    test('extracts direct image from escaped Scribd JSONP orig attribute', () => {
      assert.strictEqual(typeof backgroundHelpers.extractImageUrlFromJsonpText, 'function');
      const text = 'window.page5_callback(["<img orig=\\\\\\"http://html.scribd.com/4u81nfne0wc7mksz/images/5-31793894e5.jpg\\\\\\"/>"]);';
      assert.strictEqual(
        backgroundHelpers.extractImageUrlFromJsonpText(text),
        'https://html.scribd.com/4u81nfne0wc7mksz/images/5-31793894e5.jpg'
      );
    });

    test('parses Scribd JSONP into page HTML and dimensions', () => {
      assert.strictEqual(typeof backgroundHelpers.parseScribdJsonpPage, 'function');
      const text = 'window.page1_callback(["<div class=\\"newpage\\" id=\\"page1\\" style=\\"width: 902px; height:1167px\\"><div class=\\"text_layer\\"></div><div class=\\"image_layer\\"></div></div>"]);';
      const page = backgroundHelpers.parseScribdJsonpPage(text, 'https://html.scribdassets.com/abc/pages/1-hash.jsonp');
      assert.strictEqual(page.pageNum, 1);
      assert.strictEqual(page.width, 902);
      assert.strictEqual(page.height, 1167);
      assert.match(page.html, /text_layer/);
      assert.match(page.html, /image_layer/);
    });

    test('maps detected Scribd font classes to document font URLs', () => {
      assert.strictEqual(typeof backgroundHelpers.buildFontUrlsForPage, 'function');
      const page = {
        url: 'https://html.scribdassets.com/334456n3uob6vjms/pages/1-37b556f198.jsonp',
        html: '<div class="ff3"><span>x</span></div><div class="ff0"><span>y</span></div>'
      };
      assert.deepStrictEqual(backgroundHelpers.buildFontUrlsForPage(page), [
        { family: 'ff0', url: 'https://html.scribdassets.com/334456n3uob6vjms/fonts/0000.woff2' },
        { family: 'ff3', url: 'https://html.scribdassets.com/334456n3uob6vjms/fonts/0003.woff2' }
      ]);
    });

    test('parseJpegSize reads SOF0 dimensions', () => {
      assert.strictEqual(typeof backgroundHelpers.parseJpegSize, 'function');
      const jpeg = new Uint8Array([
        0xff, 0xd8,
        0xff, 0xc0, 0x00, 0x11,
        0x08,
        0x03, 0x20,
        0x02, 0x58,
        0x03,
        0x01, 0x11, 0x00,
        0x02, 0x11, 0x00,
        0x03, 0x11, 0x00,
        0xff, 0xd9
      ]);
      assert.deepStrictEqual(backgroundHelpers.parseJpegSize(jpeg), {
        width: 600,
        height: 800
      });
    });

    test('buildPdfFromJpegs creates a multi-page PDF with DCT images', () => {
      assert.strictEqual(typeof backgroundHelpers.buildPdfFromJpegs, 'function');
      const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      const pdfBytes = backgroundHelpers.buildPdfFromJpegs([
        { pageNum: 1, width: 600, height: 800, bytes: imageBytes },
        { pageNum: 2, width: 600, height: 800, bytes: imageBytes }
      ]);
      const pdfText = Buffer.from(pdfBytes).toString('latin1');
      assert.match(pdfText, /^%PDF-1\.4/);
      assert.match(pdfText, /\/Count 2/);
      assert.match(pdfText, /\/DCTDecode/);
    });

    test('uint8ToBase64 encodes generated PDF bytes for data URL downloads', () => {
      assert.strictEqual(backgroundHelpers.uint8ToBase64(new Uint8Array([0x41, 0x42, 0x43])), 'QUJD');
    });
  }

  console.log('');
  console.log('content script wiring');

  test('registers chrome runtime message listener for popup actions', () => {
    const source = fs.readFileSync('./content.js', 'utf8');
    assert.match(source, /chrome\.runtime\.onMessage\.addListener/);
    assert.match(source, /case\s+['"]getDocInfo['"]/);
    assert.match(source, /case\s+['"]startScan['"]/);
    assert.match(source, /case\s+['"]stopScan['"]/);
    assert.match(source, /case\s+['"]getCollectedUrls['"]/);
  });

  test('uses a slower scroll delay (no longer 300)', () => {
    const source = fs.readFileSync('./content.js', 'utf8');
    assert.doesNotMatch(source, /scrollDelay\s*=\s*300\b/);
    assert.match(source, /scrollDelay\s*=\s*\d{3,4}/);
  });

  test('autoScroll breaks only after multiple stable checks at bottom', () => {
    const source = fs.readFileSync('./content.js', 'utf8');
    assert.match(source, /bottomStableCount/);
    assert.match(source, /STABLE_REQUIRED\s*=\s*\d+/);
  });

  test('autoScroll recalculates document height while walking to the bottom', () => {
    const source = fs.readFileSync('./content.js', 'utf8');
    assert.match(source, /Math\.max\(\s*document\.body\.scrollHeight,\s*document\.documentElement\.scrollHeight\s*\)/);
    assert.match(source, /scrollY\s*=\s*Math\.min\(window\.scrollY \+ scrollStep/);
  });

  test('scroll step mirrors working script at 0.7 viewport and no longer uses 0.8', () => {
    const source = fs.readFileSync('./content.js', 'utf8');
    assert.doesNotMatch(source, /innerHeight\s*\*\s*0\.8/);
    assert.match(source, /viewportHeight\s*\*\s*0\.7/);
  });

  test('uses expected-page progress capped below 99', () => {
    const source = fs.readFileSync('./content.js', 'utf8');
    assert.match(source, /computeProgress/);
  });

  console.log('');
  console.log('background wiring');

  test('background.js has the low-resolve failure threshold', () => {
    const source = fs.readFileSync('./background.js', 'utf8');
    assert.match(source, /shouldAcceptResolveCount/);
    assert.match(source, /downloadError/);
  });

  test('popup labels URLs as candidate URLs (URL ứng viên)', () => {
    const source = fs.readFileSync('./popup.js', 'utf8');
    assert.match(source, /URL ứng viên/);
  });

  await testAsync('popup separates saving the PDF from the number of processed pages', async () => {
    const h = popupHarness(readyState); await h.open();
    h.listeners[0]({ action: 'downloadProgress', docId: '123', phase: 'saving', current: 3, total: 3, percent: 100 }, {});
    assert.match(h.elements.get('progress-text').textContent, /lưu PDF/);
    assert.strictEqual(h.elements.get('collected-pages').textContent, 3);
  });

  await testAsync('popup automatically starts PDF download after successful scan', async () => {
    const harness = popupHarness(readyState);
    await harness.open();
    harness.listeners[0]({ action: 'scanComplete', ...readyState }, { tab: { id: 7 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(harness.sent.filter(request => request.action === 'downloadImages').length, 1);
  });

  test('background downloads only the generated PDF, not loose images or helper files', () => {
    const source = fs.readFileSync('./background.js', 'utf8');
    assert.match(source, /document\.pdf/);
    assert.doesNotMatch(source, /filename:\s*`[^`]*document\.html/);
    assert.doesNotMatch(source, /filename:\s*`[^`]*README\.txt/);
    assert.doesNotMatch(source, /filename:\s*`[^`]*images\/page_/);
  });

  test('JSONP renderer pipeline replaces viewport capture', () => {
    const manifest = JSON.parse(fs.readFileSync('./manifest.json', 'utf8'));
    const background = fs.readFileSync('./background.js', 'utf8');
    const content = fs.readFileSync('./content.js', 'utf8');
    const popup = fs.readFileSync('./popup.js', 'utf8');
    assert.ok(manifest.permissions.includes('activeTab'));
    assert.ok(!manifest.permissions.includes('tabs'));
    assert.match(popup, /tabId:\s*currentTabId/);
    assert.match(popup, /expectedPages:\s*expectedPages/);
    assert.match(background, /parseScribdJsonpPage/);
    assert.match(background, /renderJsonpPageToImage/);
    assert.match(content, /renderJsonpPageToImage/);
    assert.match(content, /foreignObject/);
    assert.match(content, /data:image\/svg\+xml/);
    assert.doesNotMatch(background, /captureVisibleTab/);
    assert.doesNotMatch(background, /setZoom|getZoom/);
    assert.doesNotMatch(content, /preparePageCapture|cropPageScreenshot/);
    assert.doesNotMatch(content, /URL\.createObjectURL|new Blob/);
  });

  test('renderer preserves Scribd text-layer spacing helpers', () => {
    const content = fs.readFileSync('./content.js', 'utf8');
    assert.match(content, /\.text_layer span\.w1\s*\{\s*width:\s*1px/);
    assert.match(content, /\.text_layer span\.w12\s*\{\s*width:\s*12px/);
    assert.match(content, /\.text_layer span\.l1\s*\{\s*margin:\s*0px 0px 0px -1px/);
    assert.match(content, /\.text_layer span\.l12\s*\{[^}]*margin:\s*0px 0px 0px -12px/);
    assert.doesNotMatch(content, /letter-spacing:\s*normal/);
    assert.doesNotMatch(content, /\.text_layer span\.w\{[^}]*color:\s*transparent/);
    assert.doesNotMatch(content, /\.text_layer span\.l\{[^}]*position:\s*relative/);
  });

  // Spacing, nested formatting and group offsets are verified with the real
  // browser layout engine in test-scribd-layout.js.

  test('no remote JS / CDN references added to any script', () => {
    for (const file of ['content.js', 'background.js', 'popup.js', 'page-interceptor.js']) {
      const src = fs.readFileSync('./' + file, 'utf8');
      assert.doesNotMatch(src, /https?:\/\/[^"'\s)]+\.js\b/i, file + ' should not reference remote .js');
    }
  });

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
