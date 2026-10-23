// Studocu DOM adapters: direct signed page images and the legacy HTML renderer.
var StudocuSupport = (() => {
  function getDocumentId(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/^(?:www\.)?studocu\.(?:com|vn)$/.test(url.hostname)) return null;
      return (url.pathname.match(/\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?document\/(?:[^/]+\/)+(\d+)\/?$/i) || [])[1] || null;
    } catch (_) { return null; }
  }

  function assetIdFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'doc-assets.studocu.com') return null;
      return (url.pathname.match(/^\/([a-f0-9]{32})\/html\//i) || [])[1] || null;
    } catch (_) { return null; }
  }

  function documentMetadata(doc, win) {
    const docId = getDocumentId(win.location.href);
    let metadata;
    try { metadata = JSON.parse((doc.querySelector('#__NEXT_DATA__') || {}).textContent || '{}').props?.pageProps?.document; } catch (_) {}
    if (metadata?.id !== undefined && String(metadata.id) !== docId) throw new Error('Tài liệu trong trình xem đang thay đổi. Hãy chờ trang tải xong rồi kiểm tra lại.');
    if (metadata?.numberOfPages > 10000) throw new Error('Tài liệu vượt giới hạn 10.000 trang mỗi lần tải.');
    return { docId, totalPages: metadata && String(metadata.id) === docId && Number.isSafeInteger(metadata.numberOfPages) && metadata.numberOfPages > 0 ? metadata.numberOfPages : 0 };
  }

  function detectDownloadMode(doc, win) {
    const result = { mode: 'html', reason: 'Chưa đủ dữ liệu để xác nhận mọi trang là ảnh; ưu tiên tải đầy đủ.', inspectedPages: 0, totalPages: 0 };
    try {
      const metadata = documentMetadata(doc, win), root = doc.querySelector('#document-wrapper');
      result.totalPages = metadata.totalPages || Number(((root?.parentElement?.innerText || '').match(/unlock all\s+(\d+)\s+pages/i) || [])[1]) || 0;
      if (!root) return result;
      const nodes = Array.from(root.querySelectorAll('[data-page-index]'));
      const inspected = new Set();
      for (const node of nodes) {
        const pageNum = Number(node.getAttribute('data-page-index')) + 1;
        if (!Number.isSafeInteger(pageNum) || pageNum < 1 || !node.querySelector('.pc')) continue;
        for (const text of Array.from(node.querySelectorAll('.t'))) {
          const value = (text.textContent || '').replace(/\s+/g, ' ').trim();
          if (!value) continue;
          const style = win.getComputedStyle(text);
          const transparent = color => color === 'transparent' || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color || '') || /^#[0-9a-f]{6}00$/i.test(color || '');
          if (Number(style.opacity) === 0 || style.display === 'none') continue;
          const runs = [text, ...Array.from(text.querySelectorAll?.('*') || [])];
          const visible = runs.some(run => {
            if (!(run.textContent || '').trim()) return false;
            const runStyle = win.getComputedStyle(run);
            if (Number(runStyle.opacity) === 0 || runStyle.display === 'none') return false;
            const fill = runStyle.webkitTextFillColor && !/^(?:currentcolor|inherit|initial|unset)$/i.test(runStyle.webkitTextFillColor) ? runStyle.webkitTextFillColor : runStyle.color;
            return !transparent(fill) || parseFloat(runStyle.webkitTextStrokeWidth) > 0 ||
              ((runStyle.backgroundClip === 'text' || runStyle.webkitBackgroundClip === 'text') && runStyle.backgroundImage && runStyle.backgroundImage !== 'none');
          });
          if (visible) return { ...result, inspectedPages: inspected.size + 1, reason: 'Có chữ nằm riêng trong HTML; chọn tải đầy đủ để giữ chữ, hình và công thức.' };
        }
        const png = Array.from(node.querySelectorAll('img')).some(img => {
          try { const url = new URL(img.currentSrc || img.src); return assetIdFromUrl(url.href) && url.pathname.endsWith('/bg' + pageNum.toString(16) + '.png'); } catch (_) { return false; }
        });
        if (png) inspected.add(pageNum);
      }
      result.inspectedPages = inspected.size;
      if (result.totalPages > 0 && result.totalPages <= 10000 && inspected.size === result.totalPages &&
          Array.from({ length: result.totalPages }, (_, i) => i + 1).every(n => inspected.has(n))) {
        return { ...result, mode: 'images', reason: 'Đã kiểm tra đủ các trang: có ảnh PNG và không có lớp chữ hiển thị riêng.' };
      }
      return result;
    } catch (error) { return { ...result, error: error.message, reason: error.message }; }
  }

  function createDownloadController(options) {
    const html = options.html || createController(options), images = options.images || createImageController(options);
    let startGeneration = 0;
    const cancelledTasks = new Set();
    async function inspect(preference = 'auto') {
      if (!['auto', 'html', 'images'].includes(preference)) throw new Error('Chế độ tải không hợp lệ.');
      const detection = detectDownloadMode(options.document, options.window);
      const mode = preference === 'auto' ? detection.mode : preference;
      const state = await (mode === 'html' ? html.inspect() : images.inspect());
      const ready = !detection.error && (mode === 'html' ? state.complete : state.ready);
      return { ...state, mode, preference, detection, ready: !!ready, ...(detection.error ? { error: detection.error } : {}) };
    }
    async function start(preference, onStarted = () => {}, options = {}) {
      if (cancelledTasks.has(options.taskId)) { onStarted({ status: 'stopped', taskId: options.taskId }); return; }
      const ticket = ++startGeneration;
      const state = await inspect(preference);
      if (ticket !== startGeneration || cancelledTasks.has(options.taskId)) { onStarted({ status: 'stopped', taskId: options.taskId }); return; }
      if (state.error && state.detection.error) { onStarted({ status: 'error', error: state.error }); return; }
      if (state.mode === 'html') return html.start(response => onStarted({ ...response, mode: 'html' }), options);
      onStarted({ status: state.ready ? 'ready' : 'error', ...state });
    }
    async function getImageManifest(request) {
      if (request.preference === 'auto' && detectDownloadMode(options.document, options.window).mode !== 'images') {
        throw new Error('Phát hiện lớp chữ hoặc trang chưa rõ cấu trúc. Hãy chọn tải đầy đủ để tránh thiếu nội dung.');
      }
      return images.getManifest(request);
    }
    function stop(taskId) {
      if (taskId) { cancelledTasks.add(taskId); if (cancelledTasks.size > 100) cancelledTasks.delete(cancelledTasks.values().next().value); }
      const result = html.stop(taskId); if (result.status !== 'ignored') startGeneration++; return result;
    }
    return { inspect, start, stop, getImageManifest };
  }

  function imageSource(value) {
    const url = new URL(decodeAttribute(value));
    const assetId = assetIdFromUrl(url.href);
    if (url.origin !== 'https://doc-assets.studocu.com' || url.username || url.password ||
        !assetId || !/^bg[0-9a-f]+\.png$/i.test(url.pathname.split('/').pop()) ||
        !url.searchParams.get('Signature') || !url.searchParams.get('Key-Pair-Id')) {
      throw new Error('Không tìm thấy URL ảnh PNG có đủ tham số của tài liệu.');
    }
    const policy = JSON.parse(atob((url.searchParams.get('Policy') || '').replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/')));
    const statement = policy.Statement && policy.Statement.length === 1 && policy.Statement[0];
    const prefix = `https://doc-assets.studocu.com/${assetId}/html/`;
    const expiresAt = statement && statement.Condition && statement.Condition.DateLessThan && statement.Condition.DateLessThan['AWS:EpochTime'];
    const startsAt = statement && statement.Condition && statement.Condition.DateGreaterThan && statement.Condition.DateGreaterThan['AWS:EpochTime'];
    if (!statement || ![prefix + '*.png', prefix + 'bg*.png'].includes(statement.Resource) ||
        !Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now() || (startsAt && startsAt * 1000 > Date.now())) {
      throw new Error('URL ảnh đã hết hạn hoặc Policy không áp dụng cho các ảnh PNG của tài liệu. Hãy tải lại tab.');
    }
    return { url, assetId, prefix, expiresAt };
  }

  function imageUrl(source, pageNum) {
    // Preserve the signed query verbatim: URLSearchParams would re-encode it.
    return source.prefix + 'bg' + pageNum.toString(16) + '.png' + source.url.search;
  }

  function assertImageManifest(manifest, expected = {}) {
    if (!manifest || !manifest.ready || !manifest.docId ||
        !Number.isSafeInteger(manifest.totalPages) || manifest.totalPages < 1 || manifest.totalPages > 10000 ||
        !Array.isArray(manifest.pages) || manifest.pages.length !== manifest.totalPages) {
      throw new Error('Danh sách ảnh Studocu chưa đủ hoặc không hợp lệ.');
    }
    for (const key of ['docId', 'assetId', 'totalPages']) {
      if (expected[key] !== undefined && manifest[key] !== expected[key]) throw new Error('Tài liệu hoặc số trang đã thay đổi. Hãy mở lại popup.');
    }
    const source = imageSource(manifest.sourceUrl);
    if (source.assetId !== manifest.assetId) throw new Error('Ảnh không thuộc tài liệu Studocu hiện tại.');
    manifest.pages.forEach((page, index) => {
      if (page.pageNum !== index + 1 || page.url !== imageUrl(source, index + 1)) {
        throw new Error('Danh sách ảnh sai thứ tự hoặc không thuộc nguồn tài liệu.');
      }
    });
    return manifest;
  }

  function readImageManifest(doc, win, cached) {
    const docId = getDocumentId(win.location.href);
    const result = { site: 'studocu', mode: 'images', docId, assetId: null, totalPages: 0, pages: [], ready: false };
    try {
      if (!docId) throw new Error('Tab đã chuyển sang tài liệu khác.');
      const root = doc.querySelector('#document-wrapper');
      if (!root) throw new Error('Trình xem Studocu chưa sẵn sàng. Hãy chờ tài liệu tải xong.');
      result.totalPages = documentMetadata(doc, win).totalPages;
      if (!result.totalPages) result.totalPages = Number(((root.parentElement?.innerText || '').match(/unlock all\s+(\d+)\s+pages/i) || [])[1]) || 0;
      const nodes = Array.from(root.querySelectorAll('[data-page-index]'));
      const candidates = [], geometry = new Map(), assets = new Set();
      for (const node of nodes) {
        const pageNum = Number(node.getAttribute('data-page-index')) + 1;
        if (!Number.isSafeInteger(pageNum) || pageNum < 1) continue;
        const pf = node.querySelector('.pf');
        if (pf) {
          const size = win.getComputedStyle(pf), width = parseFloat(size.width), height = parseFloat(size.height);
          if (width > 0 && height > 0) geometry.set(pageNum, { pdfWidth: width, pdfHeight: height });
        }
        for (const img of Array.from(node.querySelectorAll('img'))) {
          const value = img.currentSrc || img.src;
          let url; try { url = new URL(value); } catch (_) { continue; }
          const assetId = assetIdFromUrl(url.href);
          if (!assetId || !/\/bg[0-9a-f]+\.png$/i.test(url.pathname)) continue;
          assets.add(assetId);
          if (url.pathname !== `/${assetId}/html/bg${pageNum.toString(16)}.png`) {
            throw new Error(`Tên ảnh trang ${pageNum} không khớp quy tắc hệ 16. Chưa thể tạo danh sách ảnh.`);
          }
          try { candidates.push(imageSource(value)); } catch (_) {}
        }
      }
      if (assets.size !== 1) throw new Error('Chưa xác định được nguồn ảnh của đúng tài liệu. Hãy tải lại tab.');
      result.assetId = [...assets][0];
      if (!result.totalPages && cached?.docId === docId && cached.assetId === result.assetId) result.totalPages = cached.totalPages;
      if (!Number.isSafeInteger(result.totalPages) || result.totalPages < 1 || result.totalPages > 10000) {
        throw new Error('Chưa xác định được tổng số trang hợp lệ (tối đa 10.000 trang). Không tải bằng cách dò ảnh.');
      }
      if (nodes.some(node => Number(node.getAttribute('data-page-index')) >= result.totalPages)) {
        throw new Error('Tổng số trang và các khung trang chưa khớp. Hãy tải lại tab.');
      }
      const source = candidates.sort((a, b) => b.expiresAt - a.expiresAt)[0];
      if (!source) throw new Error('Không có URL PNG còn hạn với Policy phù hợp. Hãy tải lại tab tài liệu.');
      result.sourceUrl = source.url.href;
      result.pages = Array.from({ length: result.totalPages }, (_, i) => ({ pageNum: i + 1, url: imageUrl(source, i + 1), ...geometry.get(i + 1) }));
      result.ready = true;
      return assertImageManifest(result);
    } catch (error) { return { ...result, pages: [], ready: false, error: error.message }; }
  }

  function createImageController({ document: doc, window: win, chrome: api }) {
    let inspection = Promise.resolve();
    async function inspectNow() {
      const docId = getDocumentId(win.location.href), key = 'studocuImages:' + docId;
      let saved; try { saved = (await api.storage.local.get([key]))[key]; } catch (_) {}
      if (docId !== getDocumentId(win.location.href)) return inspectNow();
      const manifest = readImageManifest(doc, win, saved?.version === 1 ? saved : null);
      let cacheWarning = '';
      if (manifest.ready) {
        try { await api.storage.local.set({ [key]: { ...manifest, version: 1, updatedAt: Date.now() } }); }
        catch (_) { cacheWarning = 'Không lưu được danh sách ảnh. Có thể tải trong tab hiện tại.'; }
      }
      return { ...manifest, ok: manifest.ready, count: manifest.pages.length, urls: [], complete: false, isScanning: false, cacheWarning };
    }
    function inspect() {
      const next = inspection.catch(() => {}).then(inspectNow); inspection = next; return next;
    }
    async function getManifest(request = {}) {
      const state = await inspect();
      if (request.docId && state.docId !== request.docId) throw new Error('Tab đã chuyển sang tài liệu khác.');
      if (!state.ready) throw new Error(state.error);
      return state;
    }
    return { inspect, getManifest };
  }

  function allowedAsset(value, assetId) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return false;
      if (url.hostname === 'doc-assets.studocu.com') {
        return assetIdFromUrl(value) === assetId && /\/[^/]+\.(?:png|jpe?g|webp|woff2?)$/i.test(url.pathname);
      }
      return ['website-assets.studocu.com', 'd20ohkaloyme4g.cloudfront.net'].includes(url.hostname) &&
        url.pathname.startsWith('/fonts/document_fonts/' + assetId + '/') && /\/[^/]+\.woff2?$/i.test(url.pathname);
    } catch (_) { return false; }
  }

  function decodeAttribute(value) {
    return value.replace(/&(?:amp|#38|#x26);/gi, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  function normalizeCss(css, baseUrl) {
    return css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi,
      (_, value) => `url("${new URL(value, baseUrl).href}")`);
  }

  function pageAssetUrls(page, css, stylesheets = []) {
    const urls = [...stylesheets];
    for (const match of page.html.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)) urls.push(decodeAttribute(match[1]));
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      if (/^https?:/i.test(match[1])) urls.push(match[1]);
    }
    return [...new Set(urls)].sort();
  }

  function pageFingerprint(page, css, stylesheets) {
    return JSON.stringify(pageAssetUrls(page, css, stylesheets));
  }

  async function preparePage(page, css, fetchDataUrl) {
    if (!page || !/^[a-f0-9]{32}$/i.test(page.assetId) || !Number.isSafeInteger(page.pageNum) ||
        page.pageNum < 1 || !(page.width > 0) || !(page.height > 0) || typeof page.html !== 'string') {
      throw new Error('Dữ liệu trang Studocu không hợp lệ.');
    }
    const replacements = new Map(), missingFonts = [];
    const imagePattern = /\bsrc\s*=\s*["']([^"']+)["']/gi;
    const cssPattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    const add = value => {
      const url = decodeAttribute(value.trim());
      if (/^data:(?:image\/|font\/|application\/(?:font|x-font))/i.test(url)) return;
      if (!allowedAsset(url, page.assetId)) throw new Error('Asset không thuộc tài liệu Studocu hiện tại.');
      if (!replacements.has(url)) replacements.set(url, null);
    };
    for (const match of page.html.matchAll(imagePattern)) add(match[1]);
    for (const match of String(css || '').matchAll(cssPattern)) add(match[1]);
    for (const url of replacements.keys()) {
      try { replacements.set(url, await fetchDataUrl(url)); }
      catch (error) {
        // A failed font uses the document's existing CSS fallback stack.
        // Missing images still fail export; cancellation must also propagate.
        const fontFace = String(css || '').match(/@font-face\s*\{[^{}]*\}/gi) || [];
        if (error.name !== 'AbortError' && /\.woff2?$/i.test(new URL(url).pathname) &&
            fontFace.some(rule => Array.from(rule.matchAll(cssPattern)).some(match => decodeAttribute(match[1].trim()) === url))) {
          missingFonts.push(url);
        } else { error.assetUrl = url; throw error; }
      }
    }
    const replace = value => replacements.get(decodeAttribute(value.trim())) || value;
    const html = page.html.replace(imagePattern, (_, url) => `src="${replace(url)}"`)
      .replace(/\bloading\s*=\s*["']lazy["']/gi, 'loading="eager"');
    const fontCss = String(css || '').replace(/@font-face\s*\{[^{}]*\}/gi, rule =>
      Array.from(rule.matchAll(cssPattern)).some(match => missingFonts.includes(decodeAttribute(match[1].trim()))) ? '' : rule)
      .replace(cssPattern, (_, url) => `url("${replace(url)}")`) +
      '\n.p2hv .page-content{display:block!important}.p2hv .pf{margin:0!important;box-shadow:none!important}';
    return { ...page, site: 'studocu', html: `<div class="p2hv">${html}</div>`, fontCss, missingFonts };
  }

  function readDocument(doc, win) {
    let metadata;
    try { metadata = documentMetadata(doc, win); }
    catch (error) { return { docId: getDocumentId(win.location.href), assetId: null, totalPages: 0, pages: [], blockedPages: [], styleSheets: [], readerAvailable: false, error: error.message }; }
    const root = doc.querySelector('#document-wrapper');
    const nodes = root ? Array.from(root.querySelectorAll('[data-page-index]')) : [];
    const notice = (root && root.parentElement && root.parentElement.innerText) || '';
    let readerHidden = false;
    for (let current = root; current; current = current.parentElement) {
      const style = win.getComputedStyle(current);
      if (/blur\(/i.test(style.filter) || style.visibility === 'hidden' || style.display === 'none') readerHidden = true;
    }
    const indices = nodes.map(node => Number(node.getAttribute('data-page-index'))).filter(n => Number.isSafeInteger(n) && n >= 0);
    const declared = Number((notice.match(/unlock all\s+(\d+)\s+pages/i) || [])[1]) || 0;
    const totalPages = Math.max(metadata.totalPages, declared, indices.length ? Math.max(...indices) + 1 : 0);
    let assetId = null, css = '', stylesheetUrl = '';
    const stylesheetUrls = [];
    const styleSheets = [];
    const sheets = Array.from(doc.styleSheets || []).filter(sheet => assetIdFromUrl(sheet.href));
    for (const node of nodes) {
      const image = Array.from(node.querySelectorAll('img')).find(img => assetIdFromUrl(img.currentSrc || img.src));
      if (image) { assetId = assetIdFromUrl(image.currentSrc || image.src); break; }
    }
    assetId = assetId || (sheets[0] && assetIdFromUrl(sheets[0].href));
    for (const sheet of sheets) {
      if (assetIdFromUrl(sheet.href) !== assetId) continue;
      stylesheetUrl = sheet.href;
      try {
        const sheetCss = Array.from(sheet.cssRules || []).map(rule => normalizeCss(rule.cssText, sheet.href)).join('\n');
        if (!sheetCss.trim()) throw new Error('Stylesheet chưa tải xong');
        css += sheetCss + '\n'; styleSheets.push({ url: sheet.href, css: sheetCss });
      } catch (_) { stylesheetUrls.push(sheet.href); styleSheets.push({ url: sheet.href, css: null }); }
    }
    const pages = [];
    const blockedPages = [];
    const blocked = node => {
      for (let current = node; current; current = current.parentElement) {
        const style = win.getComputedStyle(current);
        const virtualized = current.classList && current.classList.contains('page-content');
        if (/blur\(/i.test(style.filter) || style.visibility === 'hidden' ||
            (style.display === 'none' && (readerHidden || !virtualized))) return true;
      }
      return false;
    };
    for (const node of nodes) {
      const pageNum = Number(node.getAttribute('data-page-index')) + 1;
      const pf = node.querySelector('.pf');
      const pc = node.querySelector('.pc');
      if (!pf || !pc) continue;
      const images = Array.from(node.querySelectorAll('img'));
      if (blocked(node) || blocked(pf) || blocked(pc) || images.some(blocked)) {
        blockedPages.push(pageNum); continue;
      }
      const text = Array.from(node.querySelectorAll('.t')).some(n => (n.textContent || '').trim());
      // Collection stores HTML and original asset URLs. The PDF worker fetches
      // and decodes every image before export, so lazy image loading in the
      // viewer must not prevent an otherwise complete HTML page being cached.
      if ((!images.length && !text) || images.some(img =>
          !allowedAsset(img.currentSrc || img.src, assetId))) continue;
      const size = win.getComputedStyle(pf);
      const width = parseFloat(size.width), height = parseFloat(size.height);
      if (!(width > 0) || !(height > 0)) continue;
      const clone = pf.cloneNode(true);
      for (const item of Array.from(clone.querySelectorAll('script,iframe,object,embed,link,base,form'))) item.remove();
      for (const item of Array.from(clone.querySelectorAll('*'))) {
        for (const attr of Array.from(item.attributes || [])) {
          if (/^on/i.test(attr.name) || attr.name === 'srcset') item.removeAttribute(attr.name);
        }
      }
      Array.from(clone.querySelectorAll('img')).forEach((img, i) => {
        img.setAttribute('src', images[i].currentSrc || images[i].src);
        img.setAttribute('loading', 'eager');
      });
      pages.push({ pageNum, assetId, width, height, html: clone.outerHTML });
    }
    return { docId: getDocumentId(win.location.href), totalPages, assetId, css, stylesheetUrl, stylesheetUrls, styleSheets,
      pages, blockedPages, readerAvailable: !!(root && nodes.length && assetId && !readerHidden) };
  }

  function createController({ document: doc, window: win, chrome: api }) {
    let docId = null, assetId = null, totalPages = 0, css = '', stylesheetUrl = '', stylesheetUrls = [];
    let pages = new Map(), restored = false, running = false, runId = 0;
    let rejectedPages = new Map(), readerAvailable = false, readerError = '';
    let styleSheets = new Map();
    let cacheWarning = '', inspection = Promise.resolve();
    let taskId = null, scanStatus = 'idle', scanPass = 0, currentPage = null, wakeScan = null;
    const cancelledTasks = new Set();
    const wait = () => new Promise(resolve => win.setTimeout(resolve, 1000));
    const now = () => win.performance?.now?.() ?? Date.now();
    const scanWait = () => new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; win.clearTimeout?.(timer); if (wakeScan === finish) wakeScan = null; resolve(); };
      const timer = win.setTimeout(finish, 1000);
      wakeScan = finish;
    });
    const currentAssetUrls = page => pageAssetUrls(page, css, stylesheetUrls.length ? stylesheetUrls : (!css && stylesheetUrl ? [stylesheetUrl] : []));
    const snapshot = () => {
      const missingPages = [];
      for (let n = 1; n <= totalPages; n++) if (!pages.has(n)) missingPages.push(n);
      return { version: 1, site: 'studocu', mode: 'html', docId, assetId, totalPages, count: pages.size, urls: [], missingPages,
        readerAvailable, cacheWarning, isScanning: running, taskId, scanStatus, scanPass, currentPage,
        ...(readerError ? { error: readerError } : {}),
        complete: !!(readerAvailable && totalPages && (css || stylesheetUrl) && pages.size === totalPages && !missingPages.length) };
    };
    const notify = (action, extra = {}) => {
      const state = snapshot();
      const result = api.runtime.sendMessage({ action, ...state, collected: state.count,
        progress: state.complete ? 100 : totalPages ? Math.min(99, Math.round(state.count / totalPages * 100)) : 0, ...extra });
      if (result && result.catch) result.catch(() => {});
    };
    async function save() {
      if (!docId) return;
      const state = snapshot();
      try {
        await api.storage.local.set({ ['studocuScan:' + docId]: {
          ...state, isScanning: false, css, stylesheetUrl, stylesheetUrls, styleSheets: [...styleSheets.values()], rejectedPages: [...rejectedPages],
          pages: [...pages.values()], updatedAt: Date.now()
        } });
        cacheWarning = '';
      } catch (_) {
        cacheWarning = 'Không đủ bộ nhớ để lưu toàn bộ lần quét. Có thể tải trong tab hiện tại; mở lại tab sẽ cần quét bổ sung.';
      }
    }
    async function inspectNow() {
      const observed = readDocument(doc, win);
      readerError = observed.error || '';
      if (docId !== observed.docId || (assetId && observed.assetId && assetId !== observed.assetId)) {
        if (docId !== null) { running = false; runId++; }
        docId = observed.docId; assetId = observed.assetId; restored = false;
        pages = new Map(); rejectedPages = new Map(); totalPages = 0;
        styleSheets = new Map();
        css = ''; stylesheetUrl = ''; stylesheetUrls = []; cacheWarning = '';
      }
      assetId = observed.assetId || assetId;
      totalPages = Math.max(totalPages, observed.totalPages);
      readerAvailable = observed.readerAvailable;
      if (!restored && docId && assetId) {
        const requestedDoc = docId;
        const key = 'studocuScan:' + docId;
        const data = await api.storage.local.get([key]);
        if (getDocumentId(win.location.href) !== requestedDoc) return inspectNow();
        const saved = data[key];
        if (saved && saved.version === 1 && saved.docId === docId && saved.assetId === assetId) {
          if (Number.isSafeInteger(saved.totalPages) && saved.totalPages > 0) totalPages = Math.max(totalPages, saved.totalPages);
          rejectedPages = new Map(Array.isArray(saved.rejectedPages) ? saved.rejectedPages : []);
          for (const page of Array.isArray(saved.pages) ? saved.pages : []) {
            if (Number.isSafeInteger(page.pageNum) && page.pageNum > 0 && page.pageNum <= totalPages && page.assetId === assetId &&
                page.width > 0 && page.height > 0 && typeof page.html === 'string') pages.set(page.pageNum, page);
          }
          css = saved.css || ''; stylesheetUrl = saved.stylesheetUrl || '';
          stylesheetUrls = saved.stylesheetUrls || [];
          for (const sheet of Array.isArray(saved.styleSheets) ? saved.styleSheets : []) {
            if (assetIdFromUrl(sheet.url) === assetId) styleSheets.set(new URL(sheet.url).pathname, sheet);
          }
        }
        restored = true;
      }
      // Cache each observed stylesheet separately. A temporarily absent sheet
      // must not erase required CSS, and renewed query tokens replace old URLs.
      for (const sheet of observed.styleSheets) styleSheets.set(new URL(sheet.url).pathname, sheet);
      if (styleSheets.size) {
        const sheets = [...styleSheets.values()];
        css = sheets.filter(sheet => sheet.css !== null).map(sheet => sheet.css).join('\n');
        stylesheetUrls = sheets.filter(sheet => sheet.css === null).map(sheet => sheet.url);
        stylesheetUrl = sheets[sheets.length - 1].url;
      }
      for (const page of observed.pages) {
        if (page.pageNum < 1 || page.pageNum > totalPages) continue;
        const rejected = rejectedPages.get(page.pageNum);
        const urls = currentAssetUrls(page);
        if (rejected && (rejected.assetUrl
          ? urls.includes(rejected.assetUrl) || (rejected.unknownTarget && JSON.stringify(urls) === rejected.fingerprint)
          : JSON.stringify(urls) === rejected.fingerprint)) {
          pages.delete(page.pageNum); continue;
        }
        rejectedPages.delete(page.pageNum);
        pages.set(page.pageNum, page);
      }
      for (const n of observed.blockedPages) pages.delete(n);
      // Rejected cached pages must stay missing even if virtualization removed
      // their DOM node, until the reader provides a genuinely fresh asset.
      for (const n of rejectedPages.keys()) pages.delete(n);
      for (const n of pages.keys()) if (n > totalPages) pages.delete(n);
      await save();
      return snapshot();
    }
    function inspect() {
      const task = inspection.catch(() => {}).then(inspectNow);
      inspection = task;
      return task;
    }
    function stop(expectedTaskId) {
      if (expectedTaskId) { cancelledTasks.add(expectedTaskId); if (cancelledTasks.size > 100) cancelledTasks.delete(cancelledTasks.values().next().value); }
      if (expectedTaskId && expectedTaskId !== taskId) return { status: 'ignored', taskId };
      running = false; runId++; scanStatus = 'cancelled'; wakeScan?.(); return { status: 'stopped', taskId };
    }
    async function start(onStarted = () => {}, options = {}) {
      if (cancelledTasks.has(options.taskId)) { onStarted({ status: 'stopped', taskId: options.taskId }); return; }
      if (running) { onStarted({ status: 'started', totalPages, taskId }); return; }
      running = true;
      taskId = options.taskId || null; scanStatus = 'scanning'; scanPass = 0; currentPage = null;
      const ticket = ++runId;
      let visibleTotal = 0, visibilityAt = now(), wasVisible = !doc.hidden;
      const visibleClock = () => visibleTotal + (wasVisible ? Math.max(0, now() - visibilityAt) : 0);
      const visibility = () => {
        const time = now();
        if (wasVisible) visibleTotal += Math.max(0, time - visibilityAt);
        visibilityAt = time; wasVisible = !doc.hidden; wakeScan?.();
      };
      doc.addEventListener?.('visibilitychange', visibility);
      const Observer = win.MutationObserver;
      const observer = Observer ? new Observer(() => wakeScan?.()) : null;
      const observedRoot = doc.querySelector('#document-wrapper');
      if (observedRoot) observer?.observe(observedRoot, { childList: true, subtree: true, attributes: true, characterData: true });
      let responded = false;
      const respond = value => { if (!responded) { responded = true; onStarted(value); } };
      try {
        let state = await inspect();
        if (ticket !== runId || !running) return;
        // A manual scan may retry a dependency only visible inside unreadable
        // CSS; ordinary inspection keeps its failure, including after reload.
        let retryUnknown = false;
        for (const [n, rejected] of rejectedPages) {
          if (rejected.unknownTarget) { rejectedPages.delete(n); retryUnknown = true; }
        }
        if (retryUnknown) state = await inspect();
        if (ticket !== runId || !running) return;
        respond({ status: 'started', totalPages, taskId });
        if (!state.complete && state.readerAvailable) {
          let lastProgress = now(), lastCount = state.count;
          for (scanPass = 1; scanPass <= 2 && !state.complete; scanPass++) {
          for (const n of state.missingPages) {
            if (ticket !== runId || !running) return;
            if (!snapshot().missingPages.includes(n)) continue;
            currentPage = n;
            const root = doc.querySelector('#document-wrapper');
            const node = root && root.querySelector(`[data-page-index="${n - 1}"]`);
            if (!node) continue;
            node.scrollIntoView({ block: 'center' });
            const visibleStart = visibleClock();
            while (true) {
              await scanWait();
              if (ticket !== runId || !running) return;
              state = await inspect();
              if (ticket !== runId || !running) return;
              if (state.count !== lastCount) { lastProgress = now(); lastCount = state.count; }
              scanStatus = doc.hidden && now() - lastProgress >= 10000 ? 'waiting_foreground' : 'scanning';
              notify('scanProgress');
              if (!state.readerAvailable || !state.missingPages.includes(n)) break;
              if (!doc.hidden && visibleClock() - visibleStart >= 15000) break;
            }
            if (!state.readerAvailable || state.complete) break;
          }
          if (!state.readerAvailable) break;
          }
        }
        if (ticket !== runId || !running) return;
        running = false; scanStatus = state.complete ? 'complete' : 'incomplete'; currentPage = null;
        await save();
        if (ticket === runId) notify('scanComplete');
      } catch (error) {
        respond({ status: 'error', error: error.message });
        if (ticket === runId) { running = false; scanStatus = 'error'; notify('scanError', { error: error.message }); }
      } finally {
        observer?.disconnect(); doc.removeEventListener?.('visibilitychange', visibility);
        if (ticket === runId) running = false;
        respond({ status: 'stopped', totalPages });
      }
    }
    async function getPage(request, refresh = false) {
      await inspect();
      if (request.docId !== docId || !Number.isSafeInteger(request.pageNum) || request.pageNum < 1 || request.pageNum > totalPages) {
        throw new Error('Trang không thuộc tài liệu Studocu hiện tại.');
      }
      if (!readerAvailable) throw new Error('Trình xem tài liệu Studocu chưa sẵn sàng.');
      if (refresh) {
        rejectPage(request);
        pages.delete(request.pageNum);
        const root = doc.querySelector('#document-wrapper');
        const node = root && root.querySelector(`[data-page-index="${request.pageNum - 1}"]`);
        if (node) node.scrollIntoView({ block: 'center' });
        for (let i = 0; node && i < 3; i++) {
          await wait(); await inspect();
          if (request.docId !== docId || !readerAvailable) throw new Error('Trình xem hoặc tài liệu đã thay đổi.');
          if (pages.has(request.pageNum)) break;
        }
      }
      const page = pages.get(request.pageNum);
      if (!page) throw new Error('Trang chưa tải xong. Hãy quét bổ sung.');
      return { ok: true, site: 'studocu', docId, assetId, page, css, stylesheetUrl, stylesheetUrls };
    }
    function rejectPage(request) {
      const page = pages.get(request.pageNum);
      const previous = rejectedPages.get(request.pageNum);
      const urls = page ? currentAssetUrls(page) : [];
      const failed = request.rejectedUrl || (previous && previous.assetUrl);
      const fingerprint = request.rejectedFingerprint || (previous && previous.fingerprint) || (page ? JSON.stringify(urls) : '');
      let failedSource = [];
      try { failedSource = JSON.parse(fingerprint); } catch (_) {}
      rejectedPages.set(request.pageNum, {
        assetUrl: failed || null,
        unknownTarget: !!(failed && request.rejectedFingerprint && !failedSource.includes(failed)),
        fingerprint
      });
    }
    async function invalidate(request) {
      await inspect();
      if (request.docId !== docId) throw new Error('Tab đã chuyển tài liệu.');
      rejectPage(request); pages.delete(request.pageNum); await save(); return snapshot();
    }
    return { inspect, start, stop, getPage, invalidate, getInfo: () => ({ ...readDocument(doc, win), site: 'studocu', pages: undefined }) };
  }
  return { getDocumentId, assetIdFromUrl, preparePage, pageFingerprint, createController,
    readImageManifest, assertImageManifest, createImageController, detectDownloadMode, createDownloadController };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StudocuSupport;
