const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These regressions need a real layout engine: a DOM stub cannot verify that
// serialized text keeps its width and does not overlap the next text run.
let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) {
  try { ({ chromium } = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'))); }
  catch (_) {}
}
let browser;
before(async () => {
  if (!chromium) return;
  const installedChrome = path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe');
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(installedChrome) ? { executablePath: installedChrome } : {}) });
});
after(async () => { await browser?.close(); });

async function compareLayout(markup, inspect) {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><meta charset="utf-8">');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    return await page.evaluate(({ markup, inspectSource }) => {
      const inspect = (0, eval)('(' + inspectSource + ')');
      const css = buildRendererCss(902, 1167, 'div.ff18 span{font-family:Arial}');
      document.body.innerHTML = '<style>' + css + '</style>' + markup;
      const original = inspect(document);
      const svg = buildSvgDocument(902, 1167, css, markup);
      document.body.innerHTML = svg;
      return { original, exported: inspect(document) };
    }, { markup, inspectSource: inspect.toString() });
  } finally { await page.close(); }
}

test('Scribd SVG export preserves letter and word spacing so adjacent text runs do not overlap', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  // Reduced from page 2 of document 787150258. Removing -12px letter spacing
  // expands the run into the adjacent VÀ text even though both lefts stay fixed.
  const result = await compareLayout('<div class="newpage"><div class="text_layer"><div class="ff18" style="font-size:93px"><span class="a" id="run" style="left:1057px;top:1758px;word-spacing:4px;letter-spacing:-12px">&nbsp;175cc </span><span class="a" style="left:1340px;top:1758px">VÀ</span></div></div></div>', doc => {
    const el = doc.querySelector('#run'), style = getComputedStyle(el);
    return { width: el.getBoundingClientRect().width, letterSpacing: style.letterSpacing, wordSpacing: style.wordSpacing, left: style.left, top: style.top };
  });
  assert.equal(result.exported.letterSpacing, '-12px');
  assert.equal(result.exported.wordSpacing, '4px');
  assert.ok(Math.abs(result.original.width - result.exported.width) < 0.01);
  assert.equal(result.exported.left, '1057px');
  assert.equal(result.exported.top, '1758px');
});

test('Scribd SVG export keeps class-based spacers and nested negative kerning', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const result = await compareLayout('<div class="text_layer"><div style="font-size:93px"><span class="a" style="left:1093px;top:565px;letter-spacing:-6px">A<span class="w10"></span>1<span class="l8">-A<span class="w12"></span>2<span class="l6">-A3</span></span></span></div></div>', doc => ({
    spacerWidths: ['.w10', '.w12'].map(selector => { const el = doc.querySelector(selector); return el ? getComputedStyle(el).width : null; }),
    kerning: ['.l8', '.l6'].map(selector => { const el = doc.querySelector(selector); return el ? getComputedStyle(el).marginLeft : null; }),
    width: doc.querySelector('.a').getBoundingClientRect().width,
    text: doc.querySelector('.a').textContent
  }));
  assert.deepEqual(result.exported.spacerWidths, ['10px', '12px']);
  assert.deepEqual(result.exported.kerning, ['-8px', '-6px']);
  assert.equal(result.exported.text, 'A1-A2-A3');
  assert.ok(Math.abs(result.original.width - result.exported.width) < 0.01);
});

test('Scribd SVG export preserves nested font formatting inside spaced text', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const result = await compareLayout('<div class="text_layer"><div><span class="a" style="letter-spacing:-2px">Text <span id="emphasis" style="font-weight:bold;font-style:italic;color:rgb(200,0,0)">175cc</span></span></div></div>', doc => {
    const el = doc.querySelector('#emphasis');
    if (!el) return null;
    const style = getComputedStyle(el);
    return { text: el.textContent, weight: style.fontWeight, italic: style.fontStyle, color: style.color };
  });
  assert.deepEqual(result.exported, { text: '175cc', weight: '700', italic: 'italic', color: 'rgb(200, 0, 0)' });
});

test('Scribd SVG export retains absolute group offsets and their positioned children', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const result = await compareLayout('<div class="text_layer"><div><span class="g" id="group" style="left:300px;top:100px"><span class="a" id="child" style="left:20px;letter-spacing:-2px">Indented</span></span></div></div>', doc => ({
    groupLeft: getComputedStyle(doc.querySelector('#group')).left,
    childLeft: getComputedStyle(doc.querySelector('#child')).left,
    childX: doc.querySelector('#child').getBoundingClientRect().left
  }));
  assert.equal(result.exported.groupLeft, '300px');
  assert.equal(result.exported.childLeft, '20px');
  assert.equal(result.exported.childX, result.original.childX);
});

test('Scribd captures arbitrary document CSS and original ff0 formatting without fixed font rules', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<style>div.ff0 span{font-family:Arial;font-weight:bold;font-style:italic}.custom-run{font-size:40px;color:red;letter-spacing:-1px}.custom-run::before{content:"*";color:blue}</style><div id="document_container"></div>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      const captured = captureScribdPageStyles({ width: 902, height: 1167, html: '<div class="newpage"><div class="text_layer"><div class="ff0"><span class="a custom-run" id="run">175cc</span></div></div></div>' });
      document.head.innerHTML = '';
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      const el = document.querySelector('#run'), style = getComputedStyle(el);
      return { size: style.fontSize, color: style.color, family: style.fontFamily, weight: style.fontWeight, italic: style.fontStyle, letter: style.letterSpacing, pseudo: getComputedStyle(el, '::before').content };
    });
    assert.deepEqual(result, { size: '40px', color: 'rgb(255, 0, 0)', family: 'Arial', weight: '700', italic: 'italic', letter: '-1px', pseudo: '"*"' });
  } finally { await page.close(); }
});

test('Scribd retains styles from a stylesheet whose cssRules cannot be read', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.route('https://example.test/document.css', route => route.fulfill({ contentType: 'text/css', body: '.custom-run{color:rgb(3,4,5);font-size:37px}' }));
    await page.setContent('<link rel="stylesheet" href="https://example.test/document.css"><div id="document_container"></div>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      let unreadable = false; try { document.styleSheets[0].cssRules; } catch (_) { unreadable = true; }
      const captured = captureScribdPageStyles({ width: 902, height: 1167, html: '<div class="newpage"><span class="custom-run" id="run">CSS</span></div>' });
      document.head.innerHTML = '';
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      const style = getComputedStyle(document.querySelector('#run'));
      return { unreadable, color: style.color, size: style.fontSize };
    });
    assert.deepEqual(result, { unreadable: true, color: 'rgb(3, 4, 5)', size: '37px' });
  } finally { await page.close(); }
});

test('an undecodable embedded font uses the document fallback and still renders the complete page', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<style>.ff4 span{font-family:ff4,Arial,sans-serif}</style><div id="document_container"></div>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => new Promise(resolve => renderJsonpPageToImage({ page: { pageNum: 2, width: 300, height: 100,
      html: '<div class="newpage"><div class="ff4"><span>Keep every word 175cc</span></div></div>',
      fontCss: '@font-face{font-family:ff4;src:url("data:font/woff2;base64,aW52YWxpZA==")}' }, scale: 1 }, resolve)));
    assert.equal(result.ok, true);
    assert.ok(result.dataUrl.startsWith('data:image/jpeg;base64,'));
    assert.equal(result.fontFallbacks?.length, 1);
    assert.equal(result.fontFallbacks[0].family, 'ff4');
  } finally { await page.close(); }
});

test('style snapshot retains child resets to default font size and color beneath styled parents', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<style>.parent{font-size:40px;color:red}.child{font-size:16px;color:black}</style>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      const captured = captureScribdPageStyles({ width: 902, height: 1167, html: '<div class="parent"><span class="child" id="child">Reset</span></div>' });
      document.head.innerHTML = '';
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      const s = getComputedStyle(document.querySelector('#child'));
      return { color: s.color, size: s.fontSize };
    });
    assert.deepEqual(result, { color: 'rgb(0, 0, 0)', size: '16px' });
  } finally { await page.close(); }
});

test('snapshot preserves direct reader-child selectors and fonts used by generated content', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<style>#document_container > .outer_page > .newpage:first-child .custom-run{color:red}.custom-run::before{content:"X";font-family:ff33,Arial}</style><div id="document_container"></div>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      const captured = captureScribdPageStyles({ pageNum: 1, width: 902, height: 1167, html: '<div class="newpage"><span class="custom-run" id="run">Text</span></div>' });
      document.head.innerHTML = '';
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      return { color: getComputedStyle(document.querySelector('#run')).color, families: captured.fontFamilies.map(font => font.family) };
    });
    assert.equal(result.color, 'rgb(255, 0, 0)');
    assert.deepEqual(result.families, ['ff33']);
  } finally { await page.close(); }
});

test('snapshot preserves the text layer scale even when the reader has no layout box', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="document_container" style="display:none"></div>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      const captured = captureScribdPageStyles({ width: 902, height: 1167, html: '<div class="newpage"><div class="text_layer"><div style="font-size:100px"><span class="a" id="run" style="left:100px;top:100px">175cc</span></div></div></div>' });
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      const run = document.querySelector('#run');
      return { transform: getComputedStyle(document.querySelector('.text_layer')).transform, x: run.getBoundingClientRect().left - document.querySelector('.newpage').getBoundingClientRect().left };
    });
    assert.equal(result.transform, 'matrix(0.2, 0, 0, 0.2, 0, 0)');
    assert.ok(Math.abs(result.x - 20) < 0.01);
  } finally { await page.close(); }
});

test('snapshot retains generated transforms, custom properties and selector precedence while hidden', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<style>#run::before{--shift:10px;transform:translate(var(--shift),5px) scale(.5)!important}.custom::before{content:"*";display:inline-block;transform:scale(.8)}</style><div id="document_container" style="display:none"></div>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      const captured = captureScribdPageStyles({ width: 902, height: 1167, html: '<div class="newpage"><span class="custom" id="run">Text</span></div>' });
      document.head.innerHTML = '';
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      return getComputedStyle(document.querySelector('#run'), '::before').transform;
    });
    assert.equal(result, 'matrix(0.5, 0, 0, 0.5, 10, 5)');
  } finally { await page.close(); }
});

for (const [name, css, expected] of [
  ['layer order', '@layer high,low;@layer low{.custom::before{content:"*";display:inline-block;transform:scale(.5)}}@layer high{.custom::before{transform:scale(.8)}}', 'matrix(0.5, 0, 0, 0.5, 0, 0)'],
  ['all reset', '.custom::before{content:"*";display:inline-block;transform:scale(.5)}.custom::before{all:unset;content:"*";display:inline-block}', 'none'],
  ['transform inheritance', '.custom{transform:scale(.5)}span::before{content:"*";display:inline-block;transform:inherit!important}', 'matrix(0.5, 0, 0, 0.5, 0, 0)']
]) test('generated transform snapshot respects ' + name, { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<style>' + css + '</style><div id="document_container" style="display:none"></div>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      const captured = captureScribdPageStyles({ width: 902, height: 1167, html: '<div class="newpage"><span class="custom" id="run">Text</span></div>' });
      document.head.innerHTML = '';
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      return getComputedStyle(document.querySelector('#run'), '::before').transform;
    });
    assert.equal(result, expected);
  } finally { await page.close(); }
});

test('unloaded Scribd fonts keep declared weight/style and font-loading hiders do not remove page text', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<script type="text/plain">docManager.addFont(4,"","ff4","Arial, sans-serif","bold","italic");</script><style>div.ff4 span{font-family:ff4,Arial,sans-serif;font-weight:bold;font-style:italic}.ff4{display:none}</style><div id="document_container"></div>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      const captured = captureScribdPageStyles({ width: 902, height: 1167, html: '<div class="newpage"><div class="text_layer"><div class="ff4" id="font"><span>Keep unloaded text</span></div></div></div>' });
      document.head.innerHTML = '';
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      return { descriptor: captured.fontFamilies.find(font => font.family === 'ff4'), display: getComputedStyle(document.querySelector('#font')).display, text: document.querySelector('#font').textContent };
    });
    assert.equal(result.descriptor.weight, 'bold');assert.equal(result.descriptor.style, 'italic');
    assert.equal(result.display, 'block');assert.equal(result.text, 'Keep unloaded text');
  } finally { await page.close(); }
});

test('a loaded font container retains its actual display instead of receiving a font-loading override', { skip: !chromium && 'Playwright is required for layout verification' }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<script type="text/plain">docManager.addFont(4,"","ff4","Arial","normal","normal");</script><style>.ff4{display:inline-block}div.ff4 span{font-family:ff4,Arial}</style>');
    await page.addScriptTag({ path: path.join(__dirname, 'content.js') });
    const result = await page.evaluate(() => {
      const captured = captureScribdPageStyles({ html: '<div class="newpage"><div class="ff4" id="run"><span>Text</span></div></div>' });
      document.head.innerHTML = '';
      document.body.innerHTML = buildSvgDocument(902, 1167, captured.css, captured.html);
      return getComputedStyle(document.querySelector('#run')).display;
    });
    assert.equal(result, 'inline-block');
  } finally { await page.close(); }
});
