// Content script - communicates with the Scribd page and popup.
console.log('Scribd Downloader: Content script loaded');

let collectedUrls = new Set();
let pendingNetworkUrls = new Set();
let isScanning = false;
let isCollectingPhase = false;
let totalPages = 0;
let interceptorInjected = false;
let scanDocId = null;
let scanAssetId = null;
let cacheLoaded = false;
let scanStarting = false;
let scanRunId = 0;
let persistenceQueue = Promise.resolve();
let rejectedPageUrls = new Set();
let scanRequestId = 0;
let refreshingPages = new Set();

const SCRIBD_JSONP_PAGE_PATTERN = /^https?:\/\/html\.(?:scribdassets|scribd)\.com\/[^/?#]+\/pages\/[1-9]\d*-[^/?#]+\.jsonp(?:\?|#|$)/i;
const SCRIBD_DIRECT_PAGE_IMAGE_PATTERN = /^https?:\/\/html\.(?:scribdassets|scribd)\.com\/[^/?#]+\/images\/[1-9]\d*-[^/?#]+\.(?:jpe?g|png|webp)(?:\?|#|$)/i;

function isCandidateUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }

  if (!/^https?:\/\//i.test(url)) {
    return false;
  }

  if (isScribdJsonpPageUrl(url)) {
    return true;
  }

  if (isScribdDirectPageImageUrl(url)) {
    return true;
  }

  return false;
}

function isScribdJsonpPageUrl(url) {
  return typeof url === 'string' &&
    SCRIBD_JSONP_PAGE_PATTERN.test(url);
}

function normalizePageUrl(url) {
  return url.replace(/^http:\/\//i, 'https://')
    .replace(/^https:\/\/html\.scribd\.com\//i, 'https://html.scribdassets.com/');
}

function getPageAssetId(url) {
  if (!isCandidateUrl(url)) return null;
  const match = url.match(/^https?:\/\/[^/]+\/([^/?#]+)\//i);
  return match ? match[1] : null;
}

function pageTokenExpired(url) {
  try {
    const token = new URL(url).searchParams.get('token');
    const payload = token && token.split('.')[1];
    if (!payload) return false;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now() + 30000;
  } catch (_) {
    // Opaque tokens have no readable expiry; the server validates them at fetch.
    return false;
  }
}

function isUsablePageUrl(url) {
  if (!isCandidateUrl(url) || pageTokenExpired(url) || rejectedPageUrls.has(normalizePageUrl(url))) return false;
  // An unsigned orig attribute must not hide an expired/rejected signed URL.
  for (const rejected of rejectedPageUrls) {
    if (getPageAssetId(rejected) !== getPageAssetId(url) || extractPageNumber(rejected) !== extractPageNumber(url)) continue;
    // A failed JSONP page still needs its text, even when its image layer loads.
    if (isScribdJsonpPageUrl(rejected) && !isScribdJsonpPageUrl(url)) return false;
    if (/[?&]token=/.test(rejected) && !/[?&]token=/.test(url)) return false;
  }
  return true;
}

function pageUrlPriority(url) {
  // JSONP carries text as well as images; a direct image may be only one layer.
  // Within the same representation, preserve the site's signed URL.
  return (isScribdJsonpPageUrl(url) ? 8 : 0) + (/[?&]token=[^&#]+/.test(url) ? 4 : 0);
}

function getDocumentRoot() {
  return document.querySelector('#document_container') || document;
}

function isScribdDirectPageImageUrl(url) {
  return typeof url === 'string' &&
    SCRIBD_DIRECT_PAGE_IMAGE_PATTERN.test(url);
}

function extractUrlsFromPerformance() {
  const urls = [];
  try {
    if (typeof performance === 'undefined' || !performance || !performance.getEntriesByType) {
      return urls;
    }
    const entries = performance.getEntriesByType('resource');
    for (const entry of entries) {
      if (entry && typeof entry.name === 'string') {
        urls.push(entry.name);
      }
    }
  } catch (_) {
    // Ignore performance API failures in restricted contexts.
  }
  return urls;
}

function extractUrlsFromDom(root) {
  const urls = [];
  if (!root || !root.querySelectorAll) {
    return urls;
  }

  const elements = root.querySelectorAll('img, source, a, link, [style], [data-src], [data-original]');
  for (const el of elements) {
    const directAttrs = ['src', 'orig', 'href', 'data-src', 'data-original', 'data-lazy-src', 'data-hi-res-src'];
    for (const attr of directAttrs) {
      const value = el.getAttribute && el.getAttribute(attr);
      if (value) {
        urls.push(value);
      }
    }

    const styleAttr = el.getAttribute && el.getAttribute('style');
    if (styleAttr) {
      const bgMatches = styleAttr.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi);
      if (bgMatches) {
        for (const match of bgMatches) {
          const inner = match.replace(/url\(\s*['"]?|['"]?\s*\)/gi, '');
          if (inner) {
            urls.push(inner);
          }
        }
      }
    }
  }

  // Scribd page containers: anything that looks like a page wrapper.
  const pageContainers = root.querySelectorAll('.page, .document_page, [data-page-number], [data-page], [id^="page"]');
  for (const container of pageContainers) {
    const innerImgs = container.querySelectorAll('img, [style]');
    for (const inner of innerImgs) {
      const src = inner.getAttribute && inner.getAttribute('src');
      if (src) {
        urls.push(src);
      }
      const orig = inner.getAttribute && inner.getAttribute('orig');
      if (orig) {
        urls.push(orig);
      }
      const ds = inner.getAttribute && inner.getAttribute('data-src');
      if (ds) {
        urls.push(ds);
      }
      const doAttr = inner.getAttribute && inner.getAttribute('data-original');
      if (doAttr) {
        urls.push(doAttr);
      }
    }
  }

  return urls;
}

function extractUrlsFromScripts(root) {
  const urls = [];
  if (!root || !root.querySelectorAll) {
    return urls;
  }

  const urlRegex = /https?:\/\/[^\s"'<>)]+\.(?:jpe?g|png|webp)(?:\?[^\s"'<>)]*)?/gi;
  const jsonpRegex = /https?:\/\/[^\s"'<>)]*\.jsonp[^\s"'<>)]*/gi;
  const scribdPathRegex = /https?:\/\/[^\s"'<>)]*(?:scribdassets\.com|scribd\.com|scribdusercontent\.com)[^\s"'<>)]*/gi;

  const scripts = root.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent;
    if (!text) {
      continue;
    }

    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      urls.push(match[0]);
    }
    urlRegex.lastIndex = 0;

    while ((match = jsonpRegex.exec(text)) !== null) {
      urls.push(match[0]);
    }
    jsonpRegex.lastIndex = 0;

    while ((match = scribdPathRegex.exec(text)) !== null) {
      urls.push(match[0]);
    }
    scribdPathRegex.lastIndex = 0;
  }

  return urls;
}

function sortUrls(urls) {
  const unique = [...new Set(urls)];
  unique.sort((a, b) => {
    const pa = extractPageNumber(a);
    const pb = extractPageNumber(b);
    if (pa !== pb) {
      return pa - pb;
    }
    return a.localeCompare(b);
  });
  return unique;
}

function uniqueUrlsByPageNumber(urls, maxPage, assetId) {
  const max = Number(maxPage) || 0;
  const byPage = new Map();
  for (const rawUrl of urls) {
    if (typeof rawUrl !== 'string') continue;
    if (assetId && getPageAssetId(rawUrl) !== assetId) continue;
    const url = isCandidateUrl(rawUrl) ? normalizePageUrl(rawUrl) : rawUrl;
    const pageNum = extractPageNumber(url);
    if (pageNum === Number.MAX_SAFE_INTEGER || pageNum <= 0) {
      continue;
    }
    if (max > 0 && pageNum > max) {
      continue;
    }
    const existing = byPage.get(pageNum);
    if (!existing || pageUrlPriority(url) >= pageUrlPriority(existing)) {
      byPage.set(pageNum, url);
    }
  }
  return sortUrls([...byPage.values()]);
}

function extractPageNumber(url) {
  if (typeof url !== 'string') {
    return Number.MAX_SAFE_INTEGER;
  }
  const path = url.split(/[?#]/)[0];
  const match = path.match(/\/(?:pages|images)\/(\d+)-/);
  if (match) {
    return parseInt(match[1], 10);
  }
  const numMatch = path.match(/(\d+)(?:\D*$)/);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }
  return Number.MAX_SAFE_INTEGER;
}

// Count unique DOM page identifiers from any of the standard Scribd page
// containers. Used to estimate how many pages have actually rendered.
function countDomPageIds(root) {
  if (!root || !root.querySelectorAll) {
    return 0;
  }
  const seen = new Set();
  const selector = '[data-page-number], [data-page], [id^="page"], .page, .document_page';
  const nodes = root.querySelectorAll(selector);
  for (const node of nodes) {
    let key = null;
    const pn = node.getAttribute && node.getAttribute('data-page-number');
    const dp = node.getAttribute && node.getAttribute('data-page');
    const id = node.getAttribute && node.getAttribute('id');
    if (pn) {
      key = 'pn:' + pn;
    } else if (dp) {
      key = 'dp:' + dp;
    } else if (id && id.indexOf('page') === 0) {
      key = 'id:' + id;
    } else if (node.classList && node.classList.contains('page')) {
      key = 'cls:page:' + (pn || dp || id || seen.size);
    } else if (node.classList && node.classList.contains('document_page')) {
      key = 'cls:document_page:' + (pn || dp || id || seen.size);
    }
    if (key) {
      seen.add(key);
    }
  }
  return seen.size;
}

// Count unique page numbers extracted from candidate URLs (both pending
// network URLs and DOM-discovered URLs). Used to estimate how many pages
// Scribd has streamed.
function countPageNumbersFromUrls(urls) {
  if (!urls) {
    return 0;
  }
  const seen = new Set();
  const arr = Array.isArray(urls) ? urls : [...urls];
  for (const url of arr) {
    if (typeof url !== 'string') continue;
    const n = extractPageNumber(url);
    if (n !== Number.MAX_SAFE_INTEGER && n > 0) {
      seen.add(n);
    }
  }
  return seen.size;
}

// Best estimate of how many pages have loaded so far. Combines DOM count
// and URL-derived page numbers; returns the max.
function estimateLoadedPages() {
  const root = getDocumentRoot();
  const domUrls = extractUrlsFromDom(root).filter(isCandidateUrl);
  // Image requests do not pass through fetch/XHR. Retain signed src URLs as
  // they appear, including pages a virtualized reader may later remove.
  for (const url of domUrls) {
    pendingNetworkUrls.delete(url);
    pendingNetworkUrls.add(url);
  }
  const assetId = domUrls.map(getPageAssetId).find(Boolean);
  const domCount = countDomPageIds(root);
  const urlCount = countPageNumbersFromUrls([
    ...pendingNetworkUrls,
    ...domUrls
  ].filter(url => !assetId || getPageAssetId(url) === assetId));
  return Math.max(domCount, urlCount);
}

// Pure progress helper exposed for tests. expectedPages may be 0 to fall
// back to scroll-position percentage; estimated is current best estimate.
function computeProgress(estimated, expectedPages, scrollFraction) {
  const e = Number(estimated) || 0;
  const expected = Number(expectedPages) || 0;
  const frac = Math.max(0, Math.min(1, Number(scrollFraction) || 0));

  if (expected > 0) {
    const pct = (e / expected) * 100;
    // Never claim 100% during scroll; reserve that for final completion.
    return Math.max(0, Math.min(99, Math.round(pct)));
  }

  return Math.max(0, Math.min(99, Math.round(frac * 100)));
}

function collectAllUrlsAfterScroll() {
  const candidate = new Set(collectedUrls);
  const root = getDocumentRoot();
  const domUrls = extractUrlsFromDom(root);
  const assetId = domUrls.map(getPageAssetId).find(Boolean) || scanAssetId;
  if (assetId) scanAssetId = assetId;

  // Source A: inline <script> text where practical.
  for (const url of extractUrlsFromScripts(document)) {
    if (isCandidateUrl(url)) {
      candidate.add(url);
    }
  }

  // Source B: performance resource entries available after load.
  for (const url of extractUrlsFromPerformance()) {
    if (isCandidateUrl(url)) {
      candidate.add(url);
    }
  }

  // Source C: observations retained during scrolling take precedence over
  // historical URLs, including pages no longer present in a virtualized DOM.
  for (const url of pendingNetworkUrls) {
    if (isCandidateUrl(url)) {
      candidate.delete(url);
      candidate.add(url);
    }
  }

  // Source D: prefer the reader's current URLs over equally ranked stale
  // tokens from scripts, performance history or an earlier scroll position.
  for (const url of domUrls) {
    if (isCandidateUrl(url)) {
      candidate.delete(url);
      candidate.add(url);
    }
  }

  for (const url of candidate) {
    if (isCandidateUrl(url) && pageTokenExpired(url)) rejectedPageUrls.add(normalizePageUrl(url));
  }
  collectedUrls = new Set(uniqueUrlsByPageNumber([...candidate].filter(isUsablePageUrl), totalPages, assetId));
}

function getScanSnapshot() {
  const urls = sortUrls([...collectedUrls]);
  const pageNumbers = new Set(urls.map(extractPageNumber));
  const missingPages = [];
  if (Number.isSafeInteger(totalPages) && totalPages > 0) {
    for (let page = 1; page <= totalPages; page++) {
      if (!pageNumbers.has(page)) missingPages.push(page);
    }
  }
  return { version: 1, docId: scanDocId, assetId: scanAssetId,
    totalPages, urls, count: urls.length, missingPages,
    rejectedUrls: [...rejectedPageUrls],
    complete: totalPages > 0 && missingPages.length === 0 && urls.length === totalPages,
    isScanning: isScanning || scanStarting };
}

async function persistScanState() {
  const state = getScanSnapshot();
  if (!state.docId || typeof chrome === 'undefined' || !chrome.storage) return state;
  // Never restore a stale running flag after the tab or browser was closed.
  const saved = { ...state, isScanning: false, updatedAt: Date.now() };
  const write = persistenceQueue.catch(() => {}).then(() =>
    chrome.storage.local.set({ ['scribdScan:' + state.docId]: saved }));
  persistenceQueue = write;
  await write;
  return state;
}

async function inspectScanState() {
  let info;
  getDocumentInfo(value => { info = value; });
  if (scanDocId !== info.docId) {
    scanRunId++;
    isScanning = false;
    scanDocId = info.docId;
    scanAssetId = null;
    totalPages = 0;
    cacheLoaded = false;
    collectedUrls.clear();
    pendingNetworkUrls.clear();
    rejectedPageUrls.clear();
  }
  totalPages = info.totalPages || totalPages;
  const observedAsset = extractUrlsFromDom(getDocumentRoot()).map(getPageAssetId).find(Boolean);
  if (observedAsset) scanAssetId = observedAsset;
  if (!cacheLoaded && scanDocId && typeof chrome !== 'undefined' && chrome.storage) {
    const docId = scanDocId;
    const key = 'scribdScan:' + docId;
    const data = await chrome.storage.local.get([key, 'collectedUrls', 'docId', 'totalPages']);
    if (docId !== scanDocId || (window.location.href.match(/\/document\/(\d+)/) || [])[1] !== docId) return inspectScanState();
    // Migrate the old single-document entry only when its document ID matches.
    const saved = data[key] || (data.docId === docId
      ? { docId, urls: data.collectedUrls, totalPages: data.totalPages } : null);
    if (saved && saved.docId === docId && (!scanAssetId || !saved.assetId || saved.assetId === scanAssetId)) {
      for (const url of Array.isArray(saved.rejectedUrls) ? saved.rejectedUrls : []) {
        if (isCandidateUrl(url)) rejectedPageUrls.add(normalizePageUrl(url));
      }
      const urls = Array.isArray(saved.urls) ? saved.urls.filter(isCandidateUrl) : [];
      scanAssetId = scanAssetId || saved.assetId || urls.map(getPageAssetId).find(Boolean) || null;
      // Old entries sometimes stored candidate count as totalPages.
      totalPages = totalPages || (saved.version === 1 ? saved.totalPages : 0) || 0;
      collectedUrls = new Set(uniqueUrlsByPageNumber([...urls, ...collectedUrls], totalPages, scanAssetId));
    }
    cacheLoaded = true;
  }
  collectAllUrlsAfterScroll();
  await persistScanState();
  return getScanSnapshot();
}

async function refreshScanPage(request) {
  await inspectScanState();
  const original = validateScanPageRequest(request);
  const pageNum = request.pageNum;
  rejectedPageUrls.add(normalizePageUrl(original));
  const findFresh = () => uniqueUrlsByPageNumber([
    ...extractUrlsFromPerformance(), ...pendingNetworkUrls, ...extractUrlsFromDom(getDocumentRoot())
  ].filter(url => isUsablePageUrl(url) && extractPageNumber(url) === pageNum &&
    isScribdJsonpPageUrl(url) === isScribdJsonpPageUrl(original)), totalPages, scanAssetId)[0];
  let fresh = findFresh();
  if (!fresh && !request.noScroll) {
    const root = getDocumentRoot();
    const node = root.querySelector && root.querySelector('#outer_page_' + pageNum);
    if (node) {
      refreshingPages.add(pageNum);
      try {
        interceptNetworkRequests();
        node.scrollIntoView({ block: 'center' });
        for (let attempt = 0; attempt < 3 && !fresh; attempt++) {
          await sleep(1000);
          fresh = findFresh();
        }
      } finally {
        refreshingPages.delete(pageNum);
      }
    }
  }
  collectAllUrlsAfterScroll();
  if (fresh) {
    pendingNetworkUrls.delete(fresh);
    pendingNetworkUrls.add(fresh);
    collectedUrls = new Set([...collectedUrls].filter(url => extractPageNumber(url) !== pageNum));
    collectedUrls.add(fresh);
  }
  await persistScanState();
  return { ok: !!fresh, url: fresh || null, ...getScanSnapshot() };
}

function validateScanPageRequest(request) {
  const url = request.candidateUrl;
  if ((request.docId && request.docId !== scanDocId) || !isCandidateUrl(url) ||
      extractPageNumber(url) !== request.pageNum || (scanAssetId && getPageAssetId(url) !== scanAssetId)) {
    throw new Error('Trang cần làm mới không thuộc tài liệu hiện tại.');
  }
  return url;
}

async function invalidateScanPage(request) {
  await inspectScanState();
  rejectedPageUrls.add(normalizePageUrl(validateScanPageRequest(request)));
  collectAllUrlsAfterScroll();
  await persistScanState();
  return getScanSnapshot();
}

function notifyScanState(action) {
  const state = getScanSnapshot();
  const message = { action, ...state, collected: state.count,
    progress: state.complete ? 100 : computeProgress(state.count, state.totalPages, 0) };
  const result = chrome.runtime.sendMessage(message);
  if (result && result.catch) result.catch(() => {});
}

async function scanMissingPages(expectedPages, delay, runId) {
  if (!(expectedPages > 0)) return false;
  const missing = getScanSnapshot().missingPages;
  const root = getDocumentRoot();
  if (!root.querySelector) return false;
  const targets = missing.map(page => ({ page, node: root.querySelector('#outer_page_' + page) }));
  if (targets.some(target => !target.node)) return false;
  for (const target of targets) {
    if (!isScanning || runId !== scanRunId) return true;
    if (!getScanSnapshot().missingPages.includes(target.page)) continue;
    target.node.scrollIntoView({ block: 'center' });
    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(delay);
      if (!isScanning || runId !== scanRunId) return true;
      estimateLoadedPages();
      collectAllUrlsAfterScroll();
      await persistScanState();
      notifyScanState('scanProgress');
      if (!getScanSnapshot().missingPages.includes(target.page)) break;
    }
    if (getScanSnapshot().complete) return true;
  }
  return true;
}

// During-scroll recording: stores observed URLs in a pending set only.
// No newUrlCollected messages are sent from here; final count is reported after collection.
function recordPendingNetworkUrl(url) {
  if (typeof url !== 'string') {
    return;
  }

  if (!isScanning && refreshingPages.size === 0) {
    return;
  }

  if (isCandidateUrl(url)) {
    pendingNetworkUrls.delete(url);
    pendingNetworkUrls.add(url);
  }
}

function interceptNetworkRequests() {
  if (interceptorInjected) {
    return;
  }

  interceptorInjected = true;

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'scribd-downloader-page') {
      return;
    }

    if (event.data.type === 'pageRequestUrl') {
      recordPendingNetworkUrl(event.data.url);
    }
  });

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-interceptor.js');
  script.onload = () => script.remove();
  (document.documentElement || document.head || document.body).appendChild(script);
}

function getDocumentInfo(sendResponse) {
  const urlMatch = window.location.href.match(/\/document\/(\d+)/);
  const docId = urlMatch ? urlMatch[1] : null;
  let pageCount = 0;

  // Outer wrappers include unloaded pages; .newpage only counts loaded HTML.
  const wrappers = getDocumentRoot().querySelectorAll('.outer_page[id^="outer_page_"]');
  if (wrappers.length) pageCount = wrappers.length;

  const metaPages = document.querySelector('meta[name="page_count"]');
  if (!pageCount && metaPages) {
    pageCount = parseInt(metaPages.getAttribute('content'), 10);
  }

  if (!pageCount) {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const match = script.textContent.match(/"page_count"\s*:\s*(\d+)/);
      if (match) {
        pageCount = parseInt(match[1], 10);
        break;
      }
    }
  }

  sendResponse({
    docId: docId,
    totalPages: pageCount,
    url: window.location.href
  });
}

async function startScanning(expectedPages, sendResponse) {
  if (isScanning || scanStarting) {
    sendResponse({ status: 'started', totalPages });
    return;
  }
  scanStarting = true;
  const requestId = ++scanRequestId;
  const requestedDoc = (window.location.href.match(/\/document\/(\d+)/) || [])[1];
  let runId;
  try {
    await inspectScanState();
    if (requestId !== scanRequestId || requestedDoc !== scanDocId) return;
    totalPages = totalPages || Math.max(0, Number(expectedPages) || 0);
    sendResponse({ status: 'started', totalPages });
    scanStarting = false;
    if (getScanSnapshot().complete) {
      await persistScanState();
      if (requestId !== scanRequestId) return;
      notifyScanState('scanComplete');
      return;
    }
    isScanning = true;
    runId = ++scanRunId;
    interceptNetworkRequests();
    const scrollDelay = 1000;
    const targeted = await scanMissingPages(totalPages, scrollDelay, runId);
    if (!targeted) await autoScroll(totalPages, scrollDelay, runId);
    if (!isScanning || runId !== scanRunId) return;
    if (!getScanSnapshot().complete) await sleep(4000);
    if (!isScanning || runId !== scanRunId) return;
    collectAllUrlsAfterScroll();
    isScanning = false;
    await persistScanState();
    if (requestId !== scanRequestId) return;
    notifyScanState('scanComplete');
  } catch (error) {
    notifyScanError(error);
  } finally {
    if (requestId === scanRequestId) {
      scanStarting = false;
      if (!runId || runId === scanRunId) isScanning = false;
    }
    await persistScanState().catch(error => notifyScanError(error));
  }
}

function notifyScanError(error) {
  const result = chrome.runtime.sendMessage({ action: 'scanError', docId: scanDocId, error: error.message });
  if (result && result.catch) result.catch(() => {});
}

function stopScanning(sendResponse) {
  isScanning = false;
  scanStarting = false;
  scanRunId++;
  scanRequestId++;
  isCollectingPhase = false;
  notifyScanState('scanStopped');
  if (sendResponse) sendResponse({ status: 'stopped' });
}

function getActiveDocumentId(site) {
  const studocuId = typeof StudocuSupport !== 'undefined' && StudocuSupport.getDocumentId
    ? StudocuSupport.getDocumentId(window.location.href)
    : null;
  if (site === 'studocu') {
    if (studocuId) return studocuId;
    try {
      const url = new URL(window.location.href);
      if (/^(?:www\.)?studocu\.(?:com|vn)$/.test(url.hostname)) {
        return (url.pathname.match(/\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?document\/(?:[^/]+\/)+(\d+)\/?$/i) || [])[1] || null;
      }
    } catch (_) {}
    return null;
  }
  const scribdId = (window.location.href.match(/\/document\/(\d+)/) || [])[1] || null;
  if (site === 'scribd') return scribdId;
  return studocuId || scribdId;
}

async function renderJsonpPageToImage(request, sendResponse) {
  try {
    const site = request.site || request.page?.site;
    const checkDocument = () => {
      const actualId = getActiveDocumentId(site);
      if (request.docId && actualId !== request.docId) {
        throw new Error('Tab đã chuyển sang tài liệu khác.');
      }
    };
    checkDocument();
    const page = request.page || {};
    const scale = Math.max(1, Math.min(4, Number(request.scale) || 2));
    const isStudocu = site === 'studocu' || page.site === 'studocu';
    const width = Math.max(1, isStudocu ? Number(page.width) || 902 : Math.round(Number(page.width) || 902));
    const height = Math.max(1, isStudocu ? Number(page.height) || 1167 : Math.round(Number(page.height) || 1167));
    const captured = isStudocu || page.styled ? { html: page.html || '', css: page.rendererCss || '' }
      : captureScribdPageStyles({ ...page, width, height });
    const fonts = await validateRendererFonts(page.fontCss || '');
    const fontFallbacks = [...(isStudocu ? [] : page.missingFonts || []).map(family => ({ family, reason: 'Không tải được font gốc.' })), ...fonts.failures];
    const css = `${fonts.css}\n${captured.css}\nhtml,body{margin:0;padding:0;background:#fff}.scribd-render-root{width:${width}px;height:${height}px;background:#fff;overflow:hidden}`;
    const svg = buildSvgDocument(width, height, css, captured.html);
    const image = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
    checkDocument();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    sendResponse({
      ok: true,
      pageNum: page.pageNum,
      dataUrl: canvas.toDataURL('image/jpeg', 0.96),
      width: canvas.width,
      height: canvas.height,
      fontFallbacks
    });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
}

async function renderStudocuImage(request, sendResponse) {
  try {
    const site = request.site || (request.page && request.page.site);
    const checkDocument = () => {
      const actualId = getActiveDocumentId(site || 'studocu');
      if (request.docId && actualId !== request.docId) {
        throw new Error('Tab đã chuyển sang tài liệu khác.');
      }
    };
    checkDocument();
    const allowed = request.site === 'scribd' ? /^data:image\/(?:jpeg|png|webp);base64,/ : /^data:image\/png;base64,/;
    if (!allowed.test(request.dataUrl || '')) throw new Error('Dữ liệu ảnh không hợp lệ.');
    const image = await loadImage(request.dataUrl);
    checkDocument();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!(width > 0) || !(height > 0)) throw new Error('Ảnh không có kích thước hợp lệ.');
    const canvas = document.createElement('canvas');
    try {
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.96);
      if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Không chuyển được ảnh sang JPEG.');
      sendResponse({ ok: true, pageNum: request.pageNum, dataUrl, width, height });
    } finally { canvas.width = 0; canvas.height = 0; image.src = ''; }
  } catch (error) { sendResponse({ ok: false, error: error.message }); }
}

function buildRendererCss(width, height, fontCss) {
  return `
${fontCss || ''}
html,body{margin:0;padding:0;background:#fff;width:${width}px;height:${height}px;overflow:hidden}
.scribd-render-root{width:${width}px;height:${height}px;background:#fff;overflow:hidden}
.outer_page,.outer_page_container{position:relative}
.newpage{white-space:nowrap;position:relative;top:0;left:0;text-rendering:auto;color:#000;background:#fff;overflow:hidden}
.image_layer{width:0;height:0;position:absolute;top:0;left:0}
.image_layer .absimg,.absimg{position:absolute;pointer-events:none;border:none;left:0;-webkit-user-drag:none}
.link_layer,.text_layer{width:0;height:0;position:absolute;top:0;left:0}
.text_layer{transform:scale(.2);transform-origin:top left}
.text_layer div,.text_layer span{white-space:nowrap;padding:0;margin:0;border:none;line-height:1}
.text_layer span{height:1px}
.text_layer span.a,.text_layer span.g{position:absolute;border:none;left:0}
.text_layer span.w{white-space:nowrap;padding:0;margin:0;border:none;height:1px;line-height:1;display:inline-block}
.text_layer span.l{margin:0}
.text_layer span.l,.text_layer span.l1{white-space:nowrap;padding:0;border:none;height:1px;line-height:1;display:inline}
.text_layer span.l1{margin:0px 0px 0px -1px}
.text_layer span.l2{margin:0px 0px 0px -2px}
.text_layer span.l2,.text_layer span.l3{white-space:nowrap;padding:0;border:none;height:1px;line-height:1;display:inline}
.text_layer span.l3{margin:0px 0px 0px -3px}
.text_layer span.l4{margin:0px 0px 0px -4px}
.text_layer span.l4,.text_layer span.l5{white-space:nowrap;padding:0;border:none;height:1px;line-height:1;display:inline}
.text_layer span.l5{margin:0px 0px 0px -5px}
.text_layer span.l6{margin:0px 0px 0px -6px}
.text_layer span.l6,.text_layer span.l7{white-space:nowrap;padding:0;border:none;height:1px;line-height:1;display:inline}
.text_layer span.l7{margin:0px 0px 0px -7px}
.text_layer span.l8{margin:0px 0px 0px -8px}
.text_layer span.l8,.text_layer span.l9{white-space:nowrap;padding:0;border:none;height:1px;line-height:1;display:inline}
.text_layer span.l9{margin:0px 0px 0px -9px}
.text_layer span.l10{margin:0px 0px 0px -10px}
.text_layer span.l10,.text_layer span.l11{white-space:nowrap;padding:0;border:none;height:1px;line-height:1;display:inline}
.text_layer span.l11{margin:0px 0px 0px -11px}
.text_layer span.l12{white-space:nowrap;padding:0;border:none;height:1px;line-height:1;display:inline;margin:0px 0px 0px -12px}
.text_layer span.w1{width:1px}
.text_layer span.w1,.text_layer span.w2{white-space:nowrap;padding:0;margin:0;border:none;height:1px;line-height:1;display:inline-block}
.text_layer span.w2{width:2px}
.text_layer span.w3{width:3px}
.text_layer span.w3,.text_layer span.w4{white-space:nowrap;padding:0;margin:0;border:none;height:1px;line-height:1;display:inline-block}
.text_layer span.w4{width:4px}
.text_layer span.w5{width:5px}
.text_layer span.w5,.text_layer span.w6{white-space:nowrap;padding:0;margin:0;border:none;height:1px;line-height:1;display:inline-block}
.text_layer span.w6{width:6px}
.text_layer span.w7{width:7px}
.text_layer span.w7,.text_layer span.w8{white-space:nowrap;padding:0;margin:0;border:none;height:1px;line-height:1;display:inline-block}
.text_layer span.w8{width:8px}
.text_layer span.w9{width:9px}
.text_layer span.w9,.text_layer span.w10{white-space:nowrap;padding:0;margin:0;border:none;height:1px;line-height:1;display:inline-block}
.text_layer span.w10{width:10px}
.text_layer span.w11{width:11px}
.text_layer span.w11,.text_layer span.w12{white-space:nowrap;padding:0;margin:0;border:none;height:1px;line-height:1;display:inline-block}
.text_layer span.w12{width:12px}
*{box-sizing:content-box}
`;
}

function captureScribdPageStyles(page) {
  const holder = document.createElement('div'), baselineHost = document.createElement('div');
  const token = 's' + Math.random().toString(36).slice(2);
  holder.setAttribute('data-scribd-snapshot', token);
  holder.style.setProperty('display', 'none', 'important');
  baselineHost.style.cssText = 'all:initial;display:none!important';
  const baselineRoot = baselineHost.attachShadow({ mode: 'closed' });
  const defaults = new Map(), fontFamilies = new Map(), pseudoRules = [];
  const tree = holder;
  tree.className = 'outer_page';
  tree.id = 'outer_page_' + (page.pageNum || 1);
  tree.innerHTML = page.html || '';
  const declaredFonts = new Map();
  for (const script of document.querySelectorAll('script')) for (const match of (script.textContent || '').matchAll(/\bdocManager\.addFont\(([^)]*)\)/g)) {
    try {
      const args = JSON.parse('[' + match[1] + ']');
      if (/^ff\d+$/.test(args[2])) declaredFonts.set(args[2], { family: args[2], weight: args[4], style: args[5] });
    } catch (_) {}
  }
  // The reader hides bare ffN containers until its scroll-driven font loader
  // finishes. Our own font loader/fallback renders those containers directly;
  // explicit inline display:none and other hidden content remain unchanged.
  // Snapshotting must not execute active document content or start extra image
  // requests. The background embeds images before requesting this snapshot.
  for (const item of tree.querySelectorAll('script,iframe,object,embed,link,base,form')) item.remove();
  for (const el of tree.querySelectorAll('*')) for (const attr of [...el.attributes]) {
    if (/^on/i.test(attr.name) || attr.name === 'srcset') el.removeAttribute(attr.name);
  }
  const fallback = new CSSStyleSheet();
  fallback.replaceSync(buildRendererCss(page.width || 902, page.height || 1167, ''));
  const scoped = [...fallback.cssRules].map(rule => {
    if (!rule.selectorText) return '';
    return rule.selectorText.split(',').map(selector => `[data-scribd-snapshot="${token}"] ${selector}`).join(',') + '{' + rule.style.cssText + '}';
  }).join('\n');
  const style = document.createElement('style');
  // Anonymous cascade layer supplies only structural defaults. Every real
  // unlayered document rule, including cross-origin CSS, takes precedence.
  style.textContent = '@layer {' + scoped + '}';
  // Keep the sampled reader tree's child order intact (:first-child, etc.).
  document.head.prepend(style);
  const parent = document.querySelector('#document_container') || document.body;
  parent.append(holder); document.documentElement.append(baselineHost);
  try {
    for (const el of tree.querySelectorAll('[class]')) if (el.classList.length === 1 && declaredFonts.has(el.className) && !el.style.display && getComputedStyle(el).display === 'none') {
      el.style.setProperty('display', 'revert', 'important');
    }
    const baseline = element => {
      const key = element.namespaceURI + ':' + element.localName;
      if (!defaults.has(key)) {
        const sample = document.createElementNS(element.namespaceURI, element.localName);
        baselineRoot.append(sample);
        const computed = getComputedStyle(sample);
        defaults.set(key, new Map([...computed].map(name => [name, computed.getPropertyValue(name)])));
      }
      return defaults.get(key);
    };
    const snapshot = (computed, base, parentStyle) => {
      const result = document.createElement('span').style;
      for (const name of computed) {
        const value = computed.getPropertyValue(name);
        if (value !== base.get(name) || value !== parentStyle.getPropertyValue(name)) result.setProperty(name, value);
      }
      return result.cssText;
    };
    const recordFonts = computed => {
      for (const family of computed.fontFamily.split(',').map(value => value.trim().replace(/^['"]|['"]$/g, ''))) {
        if (/^ff\d+$/.test(family)) fontFamilies.set(family, declaredFonts.get(family) || { family });
      }
    };
    // Capture everything before assigning styles: assigning to a parent first
    // would change what its descendants inherit during the same traversal.
    const copies = [...tree.querySelectorAll('*')].map((el, index) => {
      const base = baseline(el), computed = getComputedStyle(el);
      const parentStyle = getComputedStyle(el.parentElement);
      recordFonts(computed);
      for (const pseudo of ['::before', '::after']) {
        const generated = getComputedStyle(el, pseudo);
        if (generated.content && !['none', 'normal'].includes(generated.content)) {
          recordFonts(generated);
          el.setAttribute('data-scribd-node', token + index);
          const pseudoStyle = document.createElement('span').style;
          pseudoStyle.cssText = snapshot(generated, base, computed);
          const transform = readGeneratedTransform(el, pseudo, generated, baselineRoot);
          if (transform) pseudoStyle.setProperty('transform', transform);
          pseudoRules.push(`[data-scribd-node="${token + index}"]${pseudo}{${pseudoStyle.cssText}}`);
        }
      }
      const css = document.createElement('span').style;
      css.cssText = snapshot(computed, base, parentStyle);
      // CSSOM's resolved transform becomes "none" under display:none even
      // though the declared scale still applies when exported. Typed OM keeps
      // the computed transform without needing a visible layout or scrolling.
      const transform = el.computedStyleMap().get('transform');
      if (transform) css.setProperty('transform', transform.toString());
      return [el, css.cssText];
    });
    for (const [el, css] of copies) el.setAttribute('style', css);
    for (const el of tree.querySelectorAll('style')) el.remove();
    // Actual FontFace descriptors belong to this document; ff0/ff1 are not
    // universal names for a particular typeface, weight or italic setting.
    for (const face of document.fonts || []) {
      const family = face.family.replace(/^['"]|['"]$/g, '');
      if (fontFamilies.has(family)) fontFamilies.set(family, { family, weight: face.weight, style: face.style });
    }
    return { html: tree.innerHTML, css: pseudoRules.join('\n'), fontFamilies: [...fontFamilies.values()] };
  } finally { holder.remove(); baselineHost.remove(); style.remove(); }
}

function readGeneratedTransform(element, pseudo, computed, sandbox) {
  // A pseudo-element has no Typed OM API. Resolve readable transform rules on
  // an inert shadow proxy, preserving native selector specificity/importance.
  const rules = [];
  const selectors = text => {
    const result = []; let start = 0, depth = 0, quote = '';
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (quote) { if (text[i] === quote) quote = ''; continue; }
      if (/["']/.test(text[i])) quote = text[i];
      else if ('(['.includes(text[i])) depth++;
      else if (')]'.includes(text[i])) depth--;
      else if (text[i] === ',' && !depth) { result.push(text.slice(start, i)); start = i + 1; }
    }
    result.push(text.slice(start)); return result;
  };
  const visit = (cssRules, wrappers = []) => {
    for (const rule of cssRules) {
      if (rule.cssText.startsWith('@layer ') && !rule.cssRules) {
        let text = rule.cssText;
        for (const wrapper of [...wrappers].reverse()) text = wrapper + '{' + text + '}';
        rules.push(text);
      } else if (rule.type === CSSRule.STYLE_RULE && (rule.style.getPropertyValue('transform') || rule.style.getPropertyValue('all'))) {
        const declarations = ['transform', ...[...rule.style].filter(name => name.startsWith('--'))].filter(name => rule.style.getPropertyValue(name)).map(name =>
          name + ':' + rule.style.getPropertyValue(name) + (rule.style.getPropertyPriority(name) ? '!important' : '') + ';').join('');
        for (const selector of selectors(rule.selectorText)) {
          const suffix = selector.trim().match(/::?(before|after)$/);
          if (!suffix || '::' + suffix[1] !== pseudo) continue;
          const base = selector.trim().slice(0, -suffix[0].length) || '*';
          try { if (!element.matches(base)) continue; } catch (_) { continue; }
          let text = `:where([data-pseudo-proxy]):is(${base},:where([data-pseudo-proxy])):is(span,:where([data-pseudo-proxy])){${declarations}}`;
          for (const wrapper of [...wrappers].reverse()) text = wrapper + '{' + text + '}';
          rules.push(text);
        }
      } else if (rule.cssRules && rule.type !== CSSRule.STYLE_RULE) {
        visit(rule.cssRules, [...wrappers, rule.cssText.slice(0, rule.cssText.indexOf('{'))]);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    if (sheet.disabled) continue;
    try { visit(sheet.cssRules, sheet.media?.mediaText ? ['@media ' + sheet.media.mediaText] : []); } catch (_) {}
  }
  if (!rules.length) return null;
  const parent = document.createElement('span'), proxy = document.createElement('span'), style = document.createElement('style');
  parent.style.transform = element.computedStyleMap().get('transform').toString();
  proxy.setAttribute('data-pseudo-proxy', '');
  proxy.style.fontSize = computed.fontSize;
  for (const name of computed) if (name.startsWith('--')) proxy.style.setProperty(name, computed.getPropertyValue(name));
  style.textContent = rules.join('\n'); parent.append(proxy); sandbox.append(style, parent);
  try { return proxy.computedStyleMap().get('transform').toString(); }
  finally { style.remove(); parent.remove(); }
}

const rendererFontChecks = new Map();
async function validateRendererFonts(css) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const failures = [], rules = [];
  for (const rule of sheet.cssRules) {
    if (rule.type !== CSSRule.FONT_FACE_RULE) { rules.push(rule.cssText); continue; }
    const family = rule.style.getPropertyValue('font-family').replace(/^['"]|['"]$/g, '');
    const src = rule.style.getPropertyValue('src');
    const key = rule.cssText;
    if (!rendererFontChecks.has(key)) {
      const descriptors = { weight: rule.style.getPropertyValue('font-weight') || 'normal', style: rule.style.getPropertyValue('font-style') || 'normal' };
      const check = Promise.resolve().then(() => new FontFace(family, src, descriptors).load()).then(() => true, () => false);
      rendererFontChecks.set(key, check);
      if (rendererFontChecks.size > 128) rendererFontChecks.delete(rendererFontChecks.keys().next().value);
    }
    if (await rendererFontChecks.get(key)) rules.push(rule.cssText);
    else failures.push({ family, reason: 'Font gốc không giải mã được; dùng dãy font dự phòng của tài liệu.' });
  }
  return { css: rules.join('\n'), failures };
}

function buildSvgDocument(width, height, css, html) {
  const root = document.createElement('div');
  root.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  root.setAttribute('class', 'scribd-render-root');

  const style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  const body = document.createElement('div');
  body.innerHTML = html;
  // Scribd positions text with explicit spacing, nested kerning and spacer
  // classes. Preserve that DOM: flattening it changes run widths and makes
  // independently positioned runs overlap in the exported page.
  while (body.firstChild) {
    root.appendChild(body.firstChild);
  }

  const serializedRoot = new XMLSerializer().serializeToString(root);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <foreignObject width="${width}" height="${height}">
    ${serializedRoot}
  </foreignObject>
</svg>`;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Khong render duoc SVG page'));
    image.src = url;
  });
}

function initContentScriptMessaging() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
    return;
  }

  let studocuController, studocuImages, studocuDownload, resetReservation = null, resetTimer;
  const cacheRequests = new Set();
  const track = operation => {
    const task = Promise.resolve(operation); cacheRequests.add(task);
    task.then(() => cacheRequests.delete(task), () => cacheRequests.delete(task));
    return task;
  };
  const resetMemory = () => {
    rendererFontChecks.clear();
    scanRunId++; scanRequestId++;
    collectedUrls.clear(); pendingNetworkUrls.clear(); rejectedPageUrls.clear();
    scanDocId = null; scanAssetId = null; totalPages = 0; cacheLoaded = false;
    studocuController = null; studocuImages = null; studocuDownload = null;
  };
  const checkResetReservation = async () => {
    const reservation = resetReservation;
    if (!reservation) return;
    let state;
    try { state = await chrome.runtime.sendMessage({ action: 'getDocumentCacheStatus', site: reservation.site, docId: reservation.docId }); }
    catch (_) { /* Keep the reservation until the worker can confirm its state. */ }
    if (resetReservation !== reservation) return;
    if (state?.ok && !state.busy) {
      // Recover after a worker restart without reviving pre-reset memory.
      resetMemory(); resetReservation = null;
    } else resetTimer = setTimeout(checkResetReservation, 30000);
  };
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'prepareDocumentCacheReset') {
      const studocuId = typeof StudocuSupport !== 'undefined' && StudocuSupport.getDocumentId(window.location.href);
      const site = studocuId ? 'studocu' : 'scribd';
      const docId = studocuId || (window.location.href.match(/\/document\/(\d+)/) || [])[1];
      if (site !== request.site || docId !== request.docId || typeof request.resetId !== 'string') {
        sendResponse({ ok: false, error: 'Tab đã chuyển sang tài liệu khác.' }); return false;
      }
      if (resetReservation || cacheRequests.size || isScanning || scanStarting) {
        sendResponse({ ok: false, status: 'busy', error: 'Tab đang quét, tải hoặc đọc dữ liệu. Hãy chờ xong rồi xóa cache.' }); return false;
      }
      const assets = new Set([scanAssetId]);
      if (site === 'scribd') for (const url of [...collectedUrls, ...extractUrlsFromDom(getDocumentRoot())]) {
        const id = getPageAssetId(url); if (id) assets.add(id);
      }
      if (site === 'studocu' && studocuController) assets.add(studocuController.getInfo().assetId);
      resetReservation = { site, docId, resetId: request.resetId };
      // Slow storage or other tabs must not let old cache be read mid-reset.
      resetTimer = setTimeout(checkResetReservation, 30000);
      sendResponse({ ok: true, docId, assetIds: [...assets].filter(Boolean) }); return false;
    }
    if (request.action === 'finishDocumentCacheReset') {
      if (!resetReservation || resetReservation.docId !== request.docId || resetReservation.resetId !== request.resetId) {
        sendResponse({ ok: false, error: 'Lượt xóa cache không khớp.' }); return false;
      }
      clearTimeout(resetTimer);
      if (request.commit) resetMemory();
      resetReservation = null;
      sendResponse({ ok: true }); return false;
    }
    if (resetReservation) { sendResponse({ ok: false, error: 'Đang xóa cache tài liệu. Hãy thử lại sau.' }); return false; }
    if (typeof StudocuSupport !== 'undefined' && StudocuSupport.getDocumentId(window.location.href) &&
        request.action !== 'renderJsonpPageToImage' && request.action !== 'renderStudocuImage') {
      if (!studocuController) studocuController = StudocuSupport.createController({ document, window, chrome });
      if (!studocuImages) studocuImages = StudocuSupport.createImageController({ document, window, chrome });
      if (!studocuDownload) studocuDownload = StudocuSupport.createDownloadController({ document, window, chrome, html: studocuController, images: studocuImages });
      const reply = task => track(task).then(sendResponse).catch(error => sendResponse({ error: error.message, ok: false }));
      switch (request.action) {
        case 'getDocInfo': reply(studocuDownload.inspect(request.preference || 'auto')); break;
        case 'getScanState': reply(request.mode === 'html' ? studocuController.inspect() : request.mode === 'images' ? studocuImages.inspect() : studocuDownload.inspect(request.preference || 'auto')); break;
        case 'getStudocuImageManifest': reply(studocuDownload.getImageManifest(request)); break;
        case 'startScan': track(studocuDownload.start(request.preference || request.mode || 'auto', sendResponse, { taskId: request.taskId })).catch(error => sendResponse({ status: 'error', error: error.message })); break;
        case 'stopScan': sendResponse(studocuDownload.stop(request.taskId)); break;
        case 'getStudocuPage': reply(studocuController.getPage(request)); break;
        case 'refreshStudocuPage': reply(studocuController.getPage(request, true)); break;
        case 'invalidateStudocuPage': reply(studocuController.invalidate(request)); break;
        default: return false;
      }
      return true;
    }
    switch (request.action) {
      case 'getDocInfo':
        getDocumentInfo(sendResponse);
        break;
      case 'startScan':
        track(startScanning(request.totalPages, sendResponse));
        break;
      case 'stopScan':
        stopScanning(sendResponse);
        break;
      case 'getCollectedUrls':
        sendResponse({
          urls: [...collectedUrls],
          count: collectedUrls.size
        });
        break;
      case 'getScanState':
        track(inspectScanState()).then(sendResponse).catch(error => sendResponse({ error: error.message }));
        break;
      case 'refreshScanPage':
        track(refreshScanPage(request)).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
        break;
      case 'invalidateScanPage':
        track(invalidateScanPage(request)).then(sendResponse).catch(error => sendResponse({ error: error.message }));
        break;
      case 'renderJsonpPageToImage':
        track(renderJsonpPageToImage(request, sendResponse));
        break;
      case 'getScribdRendererContext':
        try {
          if (request.docId && (window.location.href.match(/\/document\/(\d+)/) || [])[1] !== request.docId) throw Error('Tab đã chuyển sang tài liệu khác.');
          sendResponse({ ok: true, ...captureScribdPageStyles(request.page) });
        } catch (error) { sendResponse({ ok: false, error: error.message }); }
        break;
      case 'renderStudocuImage':
        track(renderStudocuImage(request, sendResponse));
        break;
      case 'renderScribdImage':
        track(renderStudocuImage({ ...request, site: 'scribd' }, sendResponse));
        break;
    }
    return true;
  });
}

// Auto-scroll down the full document. This intentionally mirrors the working
// downloader script: use a viewport-relative step and only consider stopping
// after actually reaching the current bottom. While scrolling, recalculate
// document height because Scribd expands the page as lazy content loads.
async function autoScroll(expectedPages, delay, runId = scanRunId) {
  const viewportHeight = window.innerHeight;
  const scrollStep = viewportHeight * 0.7;
  let scrollY = 0;
  let bottomStableCount = 0;
  let lastBottomHeight = 0;
  let lastBottomEstimated = 0;
  let lastBottomPendingCount = 0;
  const STABLE_REQUIRED = 3;

  for (let i = 0; i < 1000 && isScanning && runId === scanRunId; i++) {
    const totalHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const maxScrollY = Math.max(0, totalHeight - viewportHeight);
    scrollY = Math.min(scrollY, maxScrollY);
    window.scrollTo(0, scrollY);

    const estimated = estimateLoadedPages();
    collectAllUrlsAfterScroll();
    await persistScanState();
    if (getScanSnapshot().complete) break;
    const scrollFrac = maxScrollY > 0 ? Math.min(1, scrollY / maxScrollY) : 1;
    const progress = computeProgress(estimated, expectedPages, scrollFrac);

    chrome.runtime.sendMessage({
      action: 'scanProgress',
      progress: progress,
      docId: scanDocId,
      totalPages,
      collected: collectedUrls.size,
      estimatedPages: estimated
    }).catch(() => {});

    await sleep(delay);

    const currentHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const currentMaxScrollY = Math.max(0, currentHeight - viewportHeight);
    const atBottom = window.scrollY >= currentMaxScrollY - 100;

    if (atBottom) {
      await sleep(delay);
      const heightAfter = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      );
      const estimatedAfter = estimateLoadedPages();
      const pendingAfter = pendingNetworkUrls.size;
      const stillStable =
        heightAfter === lastBottomHeight &&
        estimatedAfter === lastBottomEstimated &&
        pendingAfter === lastBottomPendingCount;

      if (stillStable) {
        bottomStableCount++;
      } else {
        bottomStableCount = 0;
        lastBottomHeight = heightAfter;
        lastBottomEstimated = estimatedAfter;
        lastBottomPendingCount = pendingAfter;
      }

      if (bottomStableCount >= STABLE_REQUIRED) {
        break;
      }

      scrollY = Math.min(window.scrollY + scrollStep, Math.max(0, heightAfter - viewportHeight));
    } else {
      bottomStableCount = 0;
      scrollY = Math.min(window.scrollY + scrollStep, currentMaxScrollY);
    }
  }

  window.scrollTo(0, 0);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

initContentScriptMessaging();

// Expose pure helpers for static verification harnesses.
// Only used by Node-based tests; the extension itself does not rely on it.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isCandidateUrl,
    isScribdJsonpPageUrl,
    isScribdDirectPageImageUrl,
    extractUrlsFromPerformance,
    extractUrlsFromDom,
    extractUrlsFromScripts,
    sortUrls,
    uniqueUrlsByPageNumber,
    extractPageNumber,
    countDomPageIds,
    countPageNumbersFromUrls,
    estimateLoadedPages,
    computeProgress
  };
}
