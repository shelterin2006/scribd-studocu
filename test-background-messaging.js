const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Run with strict rejection handling so a lost popup is observable as the
// same uncaught promise failure Chrome reports, rather than hiding it in a fake.
function runWithoutPopup(mode, tabMissing = false, unexpectedError = false) {
  const script = `
    const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
    const mode = ${JSON.stringify(mode)}, tabMissing = ${tabMissing}, unexpectedError = ${unexpectedError};
    const jpeg = Buffer.from([255,216,255,192,0,17,8,3,32,2,88,3,1,17,0,2,17,0,3,17,0,255,217]);
    const base = 'https://html.scribdassets.com/current';
    const pageUrl = base + '/pages/1-hash.jsonp', imageUrl = base + '/images/1-hash.jpg';
    const html = '<div class="newpage" style="width:902px;height:1167px"><div class="image_layer"><img class="absimg" orig="' + imageUrl + '" style="left:0px;top:0px;width:902px;height:1167px"/></div></div>';
    const messages = [], downloads = [], warnings = [];
    const runtime = {
      sendMessage(message) {
        messages.push(message);
        return Promise.reject(Error(unexpectedError ? 'Message serialization failed' : 'Could not establish connection. Receiving end does not exist.'));
      }
    };
    const context = vm.createContext({ URL, Uint8Array, Buffer, atob, btoa, AbortController, setTimeout, clearTimeout,
      console: { log() {}, warn(...args) { warnings.push(args.join(' ')); } },
      fetch: async () => ({ ok: true, headers: { get: () => 'image/jpeg' },
        text: async () => 'window.page1_callback(' + JSON.stringify([html]) + ');',
        arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length) }),
      chrome: { runtime, downloads: { async download(value) { downloads.push(value); return 1; } },
        tabs: { sendMessage(tabId, message, callback) {
          if (tabMissing) {
            runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
            callback(); delete runtime.lastError; return;
          }
          if (message.action === 'getDocInfo') callback({ docId: '123', totalPages: 1 });
          else if (message.action === 'getScribdRendererContext') callback({ ok: true, html: message.page.html, css: '' });
          else if (message.action === 'renderJsonpPageToImage') callback({ ok: true, dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
          else throw Error('Unexpected content request: ' + message.action);
        } }
      }
    });
    vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
    context.input = { urls: [mode === 'image' ? imageUrl : pageUrl], options: {
      expectedPages: mode === 'error' ? 2 : 1, tabId: mode === 'image' ? undefined : 7, fast: mode === 'fast'
    } };
    (async () => {
      await vm.runInContext('downloadAndMergePDF(input.urls, "123", () => {}, input.options)', context);
      await new Promise(resolve => setImmediate(resolve));
      const failed = mode === 'error' || tabMissing;
      assert.equal(downloads.length, failed ? 0 : 1);
      assert.equal(messages.filter(m => m.action === (failed ? 'downloadError' : 'downloadComplete')).length, 1);
      if (tabMissing) assert.match(messages.find(m => m.action === 'downloadError').error, /Receiving end does not exist/);
      if (!failed) assert.equal(messages.filter(m => m.action === 'downloadProgress').length, 1);
      if (unexpectedError) assert.ok(warnings.some(message => message.includes('Message serialization failed')));
      else assert.equal(warnings.length, 0);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  return spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
    cwd: __dirname, encoding: 'utf8', timeout: 15000
  });
}

for (const mode of ['fast', 'legacy', 'image', 'error']) {
  test(`Scribd ${mode} handles popup closure without an uncaught rejection or a duplicate PDF`, () => {
    const result = runWithoutPopup(mode);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}

test('a missing source tab still fails the download when the popup is also closed', () => {
  const result = runWithoutPopup('fast', true);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('unexpected popup messaging errors remain visible in diagnostics without breaking PDF export', () => {
  const result = runWithoutPopup('fast', false, true);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
