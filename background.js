// Background service worker (Manifest V3 - no remote importScripts allowed).
// The extension fetches Scribd page JSONP in memory, asks the content script to
// render each page to a high-resolution JPEG, then downloads only document.pdf.
const SCRIBD_DIRECT_PAGE_IMAGE_PATTERN = /^https?:\/\/html\.(?:scribdassets|scribd)\.com\/[^/?#]+\/images\/[1-9]\d*-[^/?#]+\.(?:jpe?g|png|webp)(?:\?|#|$)/i;
const RENDER_SCALE = 2;

const fontDataUrlCache = new Map();
const imageDataUrlCache = new Map();
const studocuImageJobs = new Map();
const scribdFastJobs = new Map();
const scribdDownloads = new Map();
const clearingDocumentCaches = new Set();
let studocuJobSequence = 0;
const documentActivities = new Map(), documentActivityWrites = new Map(), documentActivityLoads = new Map();
let documentActivitySequence = 0;

function documentActivityKey({ site, tabId, docId }) {
  if (!['scribd', 'studocu'].includes(site) || !Number.isSafeInteger(tabId) || !/^\d+$/.test(docId)) return null;
  return `documentActivity:${site}:${tabId}:${docId}`;
}

function saveDocumentActivity(state) {
  const key = documentActivityKey(state);
  if (!key || !chrome.storage?.local) return Promise.resolve();
  // Take the snapshot now; serialized writes cannot put an older revision last.
  const snapshot = { ...state, logs: [...state.logs] };
  const write = (documentActivityWrites.get(key) || Promise.resolve()).catch(() => {}).then(() => chrome.storage.local.set({ [key]: snapshot }));
  documentActivityWrites.set(key, write);
  write.catch(error => console.warn?.('Không lưu được tiến độ tài liệu:', error.message));
  return write;
}

function updateDocumentActivity(identity, patch = {}, message, level = 'info', details = {}) {
  const key = documentActivityKey(identity);
  if (!key || clearingDocumentCaches.has(identity.site + ':' + identity.docId)) return null;
  const previous = documentActivities.get(key) || { version: 1, ...identity, revision: 0, logs: [], active: false, status: 'idle', count: 0, downloadedCount: 0 };
  const state = { ...previous, ...patch, revision: previous.revision + 1, updatedAt: Date.now(), logs: previous.logs };
  if (message) {
    state.droppedLogs = (previous.droppedLogs || 0) + (previous.logs.length >= 500 ? 1 : 0);
    state.logs = [...previous.logs, { ...details, id: state.revision, at: state.updatedAt, message, level }].slice(-500);
  }
  documentActivities.set(key, state);
  saveDocumentActivity(state);
  notifyPopup({ action: 'documentActivityUpdated', ...state });
  return state;
}

function createDocumentStages(identity, taskId, signal) {
  const active = new Map(), timers = new Map();
  let sequence = 0, closed = false;
  const duration = ms => (ms / 1000).toFixed(1).replace('.', ',') + ' giây';
  function emit(message, level, details) {
    const state = documentActivities.get(documentActivityKey(identity));
    if (closed || !state?.active || state.taskId !== taskId || signal?.aborted) return;
    updateDocumentActivity(identity, { activeStages: [...active.values()] }, message, level, details);
  }
  async function run(stage, label, pageNum, operation) {
    const id = ++sequence, startedAt = Date.now();
    const entry = { id, stage, label, pageNum, startedAt };
    active.set(id, entry);
    const prefix = pageNum ? `Trang ${pageNum}` : 'Tài liệu';
    const details = event => ({ event, stage, pageNum, elapsedMs: Date.now() - startedAt });
    emit(`${prefix}: Đang ${label}…`, 'info', details('stageStart'));
    const wait = () => {
      if (closed || !active.has(id) || signal?.aborted) return;
      const elapsedMs = Date.now() - startedAt;
      emit(`${prefix}: Vẫn đang chờ ${label} — ${duration(elapsedMs)}, chưa nhận kết quả.`, elapsedMs >= 30000 ? 'warn' : 'info', details('stageWait'));
      timers.set(id, setTimeout(wait, 5000));
    };
    timers.set(id, setTimeout(wait, 5000));
    try {
      const result = await operation();
      if (result?.ok === false) throw Error(result.error || 'Không hoàn tất bước xử lý.');
      active.delete(id);
      emit(`${prefix}: Xong ${label} (${duration(Date.now() - startedAt)}).`, 'info', details('stageComplete'));
      return result;
    } catch (error) {
      active.delete(id);
      emit(`${prefix}: Lỗi khi ${label} sau ${duration(Date.now() - startedAt)}: ${error.message}`, 'error', details('stageError'));
      throw error;
    } finally { clearTimeout(timers.get(id)); timers.delete(id); }
  }
  function close() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear(); active.clear();
    emit(null, 'info'); closed = true;
    signal?.removeEventListener('abort', close);
  }
  signal?.addEventListener('abort', close, { once: true });
  return { run, close, log: (message, details, level = 'info') => emit(message, level, details) };
}

async function loadDocumentActivity(identity) {
  const key = documentActivityKey(identity);
  if (!key) throw Error('Tài liệu không hợp lệ.');
  if (documentActivities.has(key)) return documentActivities.get(key);
  if (!documentActivityLoads.has(key)) {
    const load = (async () => {
      const stored = await chrome.storage?.local?.get?.([key]);
      const saved = stored?.[key];
      if (!documentActivities.has(key) && saved && documentActivityKey(saved) === key && Array.isArray(saved.logs)) {
        documentActivities.set(key, saved);
        if (identity.site === 'scribd' && saved.active && ['downloading', 'saving'].includes(saved.status)) {
          updateDocumentActivity(identity, { status: 'interrupted', active: false, activeStages: [] }, '⚠ Lượt dựng PDF đã gián đoạn khi background khởi động lại. Kiểm tra Downloads trước khi tải lại từ cache.', 'warn');
        }
      }
    })();
    documentActivityLoads.set(key, load);
    load.catch(() => { documentActivityLoads.delete(key); });
  }
  await documentActivityLoads.get(key);
  return documentActivities.get(key);
}

async function recordStudocuActivity(task) {
  if (!task?.taskId) return;
  const identity = { site: 'studocu', tabId: task.tabId, docId: task.docId };
  await loadDocumentActivity(identity);
  const previous = documentActivities.get(documentActivityKey(identity));
  if (previous?.taskId === task.taskId && previous.sourceRevision >= task.revision) return;
  const scanning = ['starting', 'scanning', 'waiting_foreground', 'incomplete'].includes(task.status);
  const count = scanning ? task.count || 0 : task.downloadedCount || 0;
  const text = { starting: 'Đang bắt đầu tác vụ', scanning: `Đang thu thập ${count}/${task.totalPages} trang`,
    waiting_foreground: 'Đang chờ — tự tiếp tục khi quay lại tab tài liệu', downloading: `Đã xử lý ${count}/${task.totalPages} trang`,
    saving: 'Đang lưu PDF…', complete: `Hoàn tất: đã tạo PDF đủ ${count}/${task.totalPages} trang`,
    incomplete: 'Còn thiếu trang: ' + (task.missingPages || []).join(', '), cancelled: 'Đã dừng tác vụ',
    interrupted: task.error || 'Tác vụ đã gián đoạn', error: task.error || 'Tác vụ gặp lỗi' }[task.status] || task.status;
  const changed = !previous || previous.taskId !== task.taskId || previous.status !== task.status || previous.count !== task.count || previous.downloadedCount !== task.downloadedCount || previous.fontFallbackCount !== task.fontFallbackCount;
  return updateDocumentActivity(identity, { taskId: task.taskId, sourceRevision: task.revision, task: { ...task, history: undefined },
    status: task.status, active: task.active, mode: task.mode, totalPages: task.totalPages, count: task.count || 0,
    ...(!task.active ? { activeStages: [] } : {}),
    downloadedCount: task.downloadedCount || 0, fontFallbackCount: task.fontFallbackCount || 0, error: task.error || '' },
    changed ? text + (task.status === 'complete' && task.fontFallbackCount ? `; ⚠ ${task.fontFallbackCount} font dùng font dự phòng.` : '') : null,
    task.status === 'error' ? 'error' : ['interrupted', 'waiting_foreground', 'incomplete'].includes(task.status) || task.fontFallbackCount ? 'warn' : 'info');
}

async function getDocumentActivity(identity) {
  await loadDocumentActivity(identity);
  if (identity.site === 'studocu' && studocuTaskManager) await recordStudocuActivity(await studocuTaskManager.get(identity.tabId, identity.docId));
  return documentActivities.get(documentActivityKey(identity)) || { ...identity, active: false };
}

async function recordScribdScan(message, sender) {
  const tabId = sender?.tab?.id, identity = { site: 'scribd', tabId, docId: message.docId };
  if (!documentActivityKey(identity) || (message.site && message.site !== 'scribd')) return;
  const source = cacheDocumentIdentity(sender.tab.url || sender.url);
  if (!source || source.site !== 'scribd' || source.docId !== message.docId) return;
  await loadDocumentActivity(identity);
  const previous = documentActivities.get(documentActivityKey(identity));
  if (previous?.active && ['downloading', 'saving'].includes(previous.status)) return;
  const count = message.count ?? message.collected ?? 0, total = message.totalPages || previous?.totalPages || 0;
  const status = message.action === 'scanError' ? 'error' : message.action === 'scanStopped' ? 'cancelled' : message.action === 'scanComplete' ? 'ready' : 'scanning';
  updateDocumentActivity(identity, { status, phase: 'scan', active: status === 'scanning', totalPages: total, count, error: message.error || '' },
    status === 'error' ? '❌ ' + message.error : `${status === 'cancelled' ? '⏹ Đã dừng quét; giữ ' : 'Đã thu thập '}${count}/${total || '?'} trang`, status === 'error' ? 'error' : 'info');
}

if (typeof StudocuSupport === 'undefined' && typeof importScripts === 'function') {
  importScripts('studocu.js');
}
if (typeof StudocuTasks === 'undefined' && typeof importScripts === 'function') importScripts('studocu-tasks.js');
const studocuTaskManager = typeof StudocuTasks !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage?.local
  ? StudocuTasks.create({ chrome, support: StudocuSupport, sendContent: sendStudocuTaskMessage, onUpdate: recordStudocuActivity,
    startDownload: request => request.mode === 'images' ? downloadStudocuImagesPDF(request)
      : downloadStudocuPDF(request.docId, request.tabId, request.expectedPages, request.taskId),
    downloadState: tabId => { const job = studocuImageJobs.get(tabId); return studocuJobState(job, job?.docId); },
    stopDownload: (tabId, taskId) => { const job = studocuImageJobs.get(tabId); if (job?.active && job.taskId === taskId && job.status !== 'saving') { job.cancelled = true; job.controller.abort(); } }
  }) : null;
studocuTaskManager?.ready.catch(error => console.error('Studocu task storage:', error.message));

async function sendStudocuTaskMessage(tabId, message) {
  async function send(retry) {
    try { return await sendTabMessage(tabId, message); }
    catch (error) {
      if (!retry || !/Receiving end does not exist|Could not establish connection/.test(error.message) || !chrome.scripting) throw error;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['studocu.js', 'content.js'] });
      return send(false);
    }
  }
  let timer;
  try { return await Promise.race([send(true), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Tab Studocu không phản hồi. Hãy quay lại tab hoặc tải lại tab.')), 30000); })]); }
  finally { clearTimeout(timer); }
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getDocumentActivity' || request.action === 'appendDocumentLog') {
      (async () => {
        await loadDocumentActivity(request);
        if (request.action === 'appendDocumentLog') {
          if (typeof request.message !== 'string' || request.message.length > 2000) throw Error('Log không hợp lệ.');
          updateDocumentActivity({ site: request.site, docId: request.docId, tabId: request.tabId }, {}, request.message, request.level);
        }
        return getDocumentActivity(request);
      })().then(sendResponse).catch(error => sendResponse({ error: error.message }));
      return true;
    }
    if (request.action === 'clearDocumentCache' || request.action === 'getDocumentCacheStatus') {
      const operation = request.action === 'clearDocumentCache' ? clearDocumentCache(request) : getDocumentCacheStatus(request);
      operation.then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (['startStudocuTask', 'downloadImages'].includes(request.action) &&
        clearingDocumentCaches.has((request.site === 'studocu' || request.action === 'startStudocuTask' ? 'studocu' : 'scribd') + ':' + request.docId)) {
      sendResponse({ status: 'busy', error: 'Đang xóa cache tài liệu.' }); return false;
    }
    if (['startStudocuTask', 'getStudocuTask', 'stopStudocuTask'].includes(request.action)) {
      if (!studocuTaskManager) { sendResponse({ status: 'error', error: 'Bộ điều phối Studocu chưa sẵn sàng.' }); return false; }
      const operation = request.action === 'startStudocuTask' ? studocuTaskManager.start(request)
        : request.action === 'getStudocuTask' ? studocuTaskManager.get(request.tabId, request.docId)
        : studocuTaskManager.stop(request.tabId, request.docId, request.taskId);
      operation.then(sendResponse).catch(error => sendResponse({ status: 'error', error: error.message }));
      return true;
    }
    if (studocuTaskManager && request.site === 'studocu' && ['scanProgress', 'scanComplete', 'scanError'].includes(request.action)) {
      studocuTaskManager.onScanner(request, sender).then(sendResponse).catch(error => sendResponse({ status: 'error', error: error.message }));
      return true;
    }
    if (['scanProgress', 'scanComplete', 'scanError', 'scanStopped'].includes(request.action)) {
      recordScribdScan(request, sender).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ error: error.message }));
      return true;
    }
    if (request.action === 'getStudocuDownloadState') {
      sendResponse(studocuJobState(studocuImageJobs.get(request.tabId), request.docId));
      return false;
    }
    if (request.action === 'stopStudocuDownload') {
      const job = studocuImageJobs.get(request.tabId);
      if (job && job.active && job.status !== 'saving' && job.docId === request.docId) { job.cancelled = true; job.controller.abort(); }
      sendResponse(studocuJobState(job, request.docId));
      return false;
    }
    if (request.action === 'downloadImages') {
      const operation = (async () => {
        if (request.site === 'studocu' && studocuTaskManager && await studocuTaskManager.busy(request.tabId)) return { status: 'busy' };
        return request.site === 'studocu'
        ? (request.mode === 'images' ? downloadStudocuImagesPDF(request) : downloadStudocuPDF(request.docId, request.tabId, request.expectedPages))
        : downloadAndMergePDF(request.urls, request.docId, sendResponse, {
        tabId: request.tabId,
        expectedPages: request.expectedPages,
        fast: request.fast === true
      });
      })();
      operation.then(result => sendResponse(result || { status: 'finished' })).catch(error => sendResponse({ status: 'error', error: error.message }));
      return true;
    }
  });
}

function cacheDocumentIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.hostname === 'www.scribd.com') {
      const docId = (url.pathname.match(/^\/document\/(\d+)(?:\/|$)/) || [])[1];
      return docId ? { site: 'scribd', docId } : null;
    }
    if (typeof StudocuSupport !== 'undefined') {
      const docId = StudocuSupport.getDocumentId(value);
      if (docId) return { site: 'studocu', docId };
    }
  } catch (_) {}
  return null;
}

async function getDocumentCacheStatus({ site, docId }) {
  if (!['scribd', 'studocu'].includes(site) || !/^\d+$/.test(docId)) throw Error('Tài liệu không hợp lệ.');
  const busy = clearingDocumentCaches.has(site + ':' + docId) || (site === 'scribd' ? (scribdDownloads.get(docId) || 0) > 0
    : [...studocuImageJobs.values()].some(job => job.docId === docId && job.active) || await studocuTaskManager?.isDocumentBusy(docId));
  return { ok: true, busy: !!busy };
}

async function sendCacheResetMessage(tabId, message) {
  let timer;
  try {
    return await Promise.race([sendTabMessage(tabId, message), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Tab không phản hồi lệnh xóa cache. Hãy tải lại tab rồi thử lại.')), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

async function clearDocumentCache(request) {
  const { site, docId, tabId } = request, key = site + ':' + docId;
  if (!['scribd', 'studocu'].includes(site) || !/^\d+$/.test(docId) || !Number.isSafeInteger(tabId)) return { ok: false, error: 'Tài liệu không hợp lệ.' };
  if (clearingDocumentCaches.has(key)) return { ok: false, status: 'busy', error: 'Đang xóa cache tài liệu.' };
  if ((await getDocumentCacheStatus(request)).busy) return { ok: false, status: 'busy', error: 'Tài liệu đang quét hoặc tải. Hãy dừng tác vụ trước khi xóa cache.' };
  // Recheck after the async status read, then reserve the document before any
  // further awaits. New starts cannot race storage deletion.
  if (clearingDocumentCaches.has(key)) return { ok: false, status: 'busy', error: 'Đang xóa cache tài liệu.' };
  clearingDocumentCaches.add(key);
  const resetId = Date.now() + '-' + Math.random().toString(36).slice(2), prepared = [];
  let committed = false;
  try {
    if ((site === 'scribd' && (scribdDownloads.get(docId) || 0) > 0) ||
        (site === 'studocu' && [...studocuImageJobs.values()].some(job => job.docId === docId && job.active))) {
      throw Object.assign(Error('Tài liệu đang tải. Hãy chờ tải xong hoặc dừng tác vụ trước.'), { status: 'busy' });
    }
    const erase = async () => {
      const tabs = await chrome.tabs.query({});
      const source = tabs.find(tab => tab.id === tabId), identity = cacheDocumentIdentity(source?.url);
      if (!identity || identity.site !== site || identity.docId !== docId) throw Error('Tab đã chuyển sang tài liệu khác. Hãy mở lại popup.');
      const matching = tabs.filter(tab => { const id = cacheDocumentIdentity(tab.url); return id?.site === site && id.docId === docId; });
      const assetIds = new Set();
      for (const tab of matching) {
        const reply = await sendCacheResetMessage(tab.id, { action: 'prepareDocumentCacheReset', site, docId, resetId });
        if (!reply?.ok) throw Object.assign(Error(reply?.error || 'Một tab tài liệu đang bận hoặc chưa sẵn sàng. Hãy tải lại tab rồi thử lại.'), { status: reply?.status || 'error' });
        prepared.push(tab.id);
        for (const id of reply.assetIds || []) assetIds.add(id);
      }
      await Promise.allSettled([...documentActivityWrites].filter(([key]) => key.startsWith(`documentActivity:${site}:`) && key.endsWith(':' + docId)).map(([, write]) => write));
      const stored = await chrome.storage.local.get(null), keys = [], clearedTaskIds = [];
      for (const [key, state] of Object.entries(stored)) if (key.startsWith(`documentActivity:${site}:`) && state?.docId === docId) keys.push(key);
      const cacheKeys = site === 'scribd' ? ['scribdScan:' + docId] : ['studocuScan:' + docId, 'studocuImages:' + docId];
      for (const cacheKey of cacheKeys) {
        keys.push(cacheKey);
        const state = stored[cacheKey];
        if (state?.assetId) assetIds.add(state.assetId);
        if (site === 'scribd') for (const url of state?.urls || []) {
          try { assetIds.add(new URL(url).pathname.split('/')[1]); } catch (_) {}
        }
      }
      if (site === 'scribd' && stored.docId === docId) keys.push('collectedUrls', 'docId', 'totalPages');
      if (site === 'studocu') for (const [cacheKey, task] of Object.entries(stored)) {
        if (/^studocuTask:\d+$/.test(cacheKey) && task?.docId === docId) {
          keys.push(cacheKey); if (task.taskId) clearedTaskIds.push(task.taskId); if (task.assetId) assetIds.add(task.assetId);
        }
      }
      await chrome.storage.local.remove(keys);
      for (const key of keys) if (key.startsWith('documentActivity:')) {
        documentActivities.delete(key); documentActivityWrites.delete(key); documentActivityLoads.delete(key);
      }
      committed = true;
      for (const cache of [fontDataUrlCache, imageDataUrlCache]) for (const url of cache.keys()) {
        try { const asset = new URL(url).pathname.split('/')[1];
          if ((site === 'scribd' && /^https?:\/\/html\.(?:scribdassets|scribd)\.com\//i.test(url) ||
              site === 'studocu' && typeof StudocuSupport !== 'undefined' && StudocuSupport.assetIdFromUrl(url)) && assetIds.has(asset)) cache.delete(url);
        } catch (_) {}
      }
      if (site === 'studocu') for (const [id, job] of studocuImageJobs) if (job.docId === docId && !job.active) studocuImageJobs.delete(id);
      return { ok: true, site, docId, clearedTaskIds };
    };
    const result = site === 'studocu' && studocuTaskManager ? await studocuTaskManager.clearDocument(docId, erase) : await erase();
    const finishes = await Promise.all(prepared.map(id => sendCacheResetMessage(id, { action: 'finishDocumentCacheReset', docId, resetId, commit: true })));
    if (finishes.some(reply => !reply?.ok)) throw Error('Đã xóa dữ liệu lưu nhưng một tab chưa đặt lại cache. Hãy tải lại các tab tài liệu rồi thử lại.');
    prepared.length = 0;
    return result;
  } catch (error) { return { ok: false, status: error.status || 'error', error: error.message }; }
  finally {
    await Promise.allSettled(prepared.map(id => sendCacheResetMessage(id, { action: 'finishDocumentCacheReset', docId, resetId, commit: committed })));
    clearingDocumentCaches.delete(key);
  }
}

function studocuJobState(job, docId) {
  if (!job || job.docId !== docId) return { active: false, downloadedCount: 0 };
  return { site: 'studocu', mode: job.mode || 'images', jobId: job.id, taskId: job.taskId, tabId: job.tabId, docId: job.docId,
    active: job.active, cancellable: job.active && job.status !== 'saving', status: job.status, totalPages: job.totalPages, downloadedCount: job.downloadedCount, fontFallbackCount: job.fontFallbackCount || 0, error: job.error || '' };
}

// Popup notifications are optional: closing the UI must not reject a download.
// Requests to the source tab use sendTabMessage and still propagate failures.
async function notifyPopup(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    const reason = error?.message || String(error);
    if (!/^(?:Could not establish connection\. Receiving end does not exist\.|The message port closed before a response was received\.)$/.test(reason)) {
      console.warn(`Popup notification (${message.action}): ${reason}`);
    }
  }
}

function reportStudocuJob(job, message) {
  if (job.taskId) studocuTaskManager?.onDownload(job, message).catch(error => console.error('Studocu task progress:', error.message));
  else {
    updateDocumentActivity({ site: 'studocu', tabId: job.tabId, docId: job.docId }, {
      taskId: job.id, mode: job.mode, totalPages: job.totalPages, downloadedCount: job.downloadedCount,
      active: job.active, status: job.status, error: job.error || '', ...(!job.active ? { activeStages: [] } : {})
    }, message.action === 'downloadComplete' ? `✅ Hoàn tất: đã tạo PDF đủ ${job.downloadedCount}/${job.totalPages} trang`
      : message.action === 'downloadError' ? '❌ ' + message.error : message.action === 'downloadCancelled' ? '⏹ Đã dừng tải.' : null);
  }
  notifyPopup({ ...studocuJobState(job, job.docId), ...message });
}

async function initializeStudocuStages(job) {
  const identity = { site: 'studocu', tabId: job.tabId, docId: job.docId };
  await loadDocumentActivity(identity);
  updateDocumentActivity(identity, { taskId: job.taskId || job.id, active: true, status: 'downloading', mode: job.mode,
    totalPages: job.totalPages, downloadedCount: 0, activeStages: [] });
  job.stages = createDocumentStages(identity, job.taskId || job.id, job.controller.signal);
  return job.stages;
}

async function fetchStudocuAsset(job, url, asText = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    ensureStudocuJob(job);
    const controller = new AbortController(), signal = job.controller.signal;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) { const error = new Error(`HTTP ${response.status}`); error.status = response.status; throw error; }
      if (asText) {
        const text = await response.text();
        if (!text.trim() || /^\s*</.test(text)) throw new Error('Máy chủ không trả về CSS hợp lệ.');
        return text;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return `data:${response.headers.get('content-type') || guessMimeType(url)};base64,${uint8ToBase64(bytes)}`;
    } catch (error) {
      ensureStudocuJob(job);
      error.assetUrl = url;
      if (attempt === 0 && (error.status >= 500 || error.name === 'TypeError' || error.name === 'AbortError')) {
        job.stages?.log(`↻ Nạp ${new URL(url).pathname.split('/').pop()} gặp lỗi; đang thử lại lần 1/1.`, { event: 'resourceRetry' });
        continue;
      }
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}

function ensureStudocuJob(job) {
  if (job.failure) throw job.failure;
  if (job.controller.signal.aborted) throw new Error('Đã dừng tải ảnh Studocu.');
}

function studocuJobMessage(job, request) {
  ensureStudocuJob(job);
  return new Promise((resolve, reject) => {
    const signal = job.controller.signal;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(job.failure || new Error('Đã dừng tải ảnh Studocu.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Tab Studocu không phản hồi. Hãy tải lại tab.')); }, 30000);
    signal.addEventListener('abort', abort, { once: true });
    sendTabMessage(job.tabId, { site: 'studocu', ...request, docId: job.docId }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function fetchStudocuPng(job, url) {
  ensureStudocuJob(job);
  const controller = new AbortController(), parent = job.controller.signal;
  const abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`); error.status = response.status; throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const magic = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!magic.every((byte, index) => bytes[index] === byte)) throw new Error('Máy chủ trả về dữ liệu không phải ảnh PNG.');
    return 'data:image/png;base64,' + uint8ToBase64(bytes);
  } catch (error) {
    ensureStudocuJob(job);
    if (!error.status && (error instanceof TypeError || error.name === 'AbortError' || error.name === 'TypeError')) error.retryable = true;
    throw error;
  } finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
}

async function downloadStudocuImagesPDF(request) {
  const { tabId, docId, expectedPages } = request;
  const previous = studocuImageJobs.get(tabId);
  if (previous?.active) return { ...studocuJobState(previous, previous.docId), status: 'busy' };
  const job = { id: Date.now() + '-' + (++studocuJobSequence), tabId, docId, taskId: request.taskId, mode: 'images', totalPages: expectedPages,
    downloadedCount: 0, active: true, status: 'downloading', controller: new AbortController(), cancelled: false };
  studocuImageJobs.set(tabId, job);
  const report = message => reportStudocuJob(job, message);
  try {
    if (!Number.isSafeInteger(tabId) || !/^\d+$/.test(docId) || !Number.isSafeInteger(expectedPages) || expectedPages < 1) throw new Error('Yêu cầu tải ảnh Studocu không hợp lệ.');
    const stages = await initializeStudocuStages(job);
    const manifestRequest = { action: 'getStudocuImageManifest', preference: request.preference || 'images' };
    let manifest = StudocuSupport.assertImageManifest(await stages.run('document_check', 'đọc tổng trang và danh sách URL ảnh', null, () => studocuJobMessage(job, manifestRequest)), { docId, totalPages: expectedPages });
    const identity = { docId, totalPages: expectedPages, assetId: manifest.assetId };
    let renewal;
    const refresh = () => {
      if (!renewal) renewal = stages.run('refresh', 'cập nhật URL ảnh sau lỗi 401/403', null, () => studocuJobMessage(job, manifestRequest)).then(value => {
        manifest = StudocuSupport.assertImageManifest(value, identity); return manifest;
      });
      return renewal;
    };
    report({ action: 'downloadStarted' });
    const images = new Array(expectedPages);
    let nextPage = 1;
    async function worker() {
      while (nextPage <= expectedPages) {
        ensureStudocuJob(job);
        const pageNum = nextPage++;
        try {
          let dataUrl, networkRetries = 0, authRetried = false;
          while (true) {
            const url = manifest.pages[pageNum - 1].url;
            try { dataUrl = await stages.run('images', 'tải ảnh PNG', pageNum, () => fetchStudocuPng(job, url)); break; }
            catch (error) {
              ensureStudocuJob(job);
              if (error.status === 401 || error.status === 403) {
                if (authRetried) throw new Error('URL ảnh bị từ chối. Hãy tải lại tab tài liệu rồi tải lại PDF.');
                authRetried = true;
                const renewed = await refresh();
                if (renewed.pages[pageNum - 1].url === url) throw new Error('URL ảnh đã hết hạn hoặc bị từ chối. Hãy tải lại tab tài liệu.');
                continue;
              }
              if (error.status === 404) throw new Error('Không tìm thấy ảnh (HTTP 404).');
              if ((error.retryable || error.status >= 500) && networkRetries++ === 0) {
                job.stages.log(`↻ Trang ${pageNum}: Lỗi tải ảnh; đang thử lại lần 1/1.`, { event: 'resourceRetry', pageNum });
                continue;
              }
              throw error;
            }
          }
          ensureStudocuJob(job);
          const rendered = await stages.run('render', 'giải mã PNG và chuyển JPEG', pageNum, () => studocuJobMessage(job, { action: 'renderStudocuImage', pageNum, dataUrl }));
          dataUrl = null;
          if (!rendered?.ok || rendered.pageNum !== pageNum) throw new Error(rendered?.error || 'Không giải mã được ảnh.');
          const bytes = dataUrlToUint8Array(rendered.dataUrl), size = parseJpegSize(bytes);
          if (!size) throw new Error('Ảnh sau chuyển đổi không hợp lệ.');
          ensureStudocuJob(job);
          const page = manifest.pages[pageNum - 1];
          images[pageNum - 1] = { pageNum, bytes, width: size.width, height: size.height, pdfWidth: page.pdfWidth, pdfHeight: page.pdfHeight };
          job.downloadedCount++;
          report({ action: 'downloadProgress', phase: 'images', current: job.downloadedCount, total: expectedPages, percent: Math.floor(job.downloadedCount / expectedPages * 100) });
        } catch (error) {
          if (!job.failure && !job.cancelled) job.failure = new Error(`Trang ${pageNum}: ${error.message}`);
          job.controller.abort(); throw error;
        }
      }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, expectedPages) }, worker));
    ensureStudocuJob(job);
    if (results.some(result => result.status === 'rejected') || job.downloadedCount !== expectedPages || images.some(image => !image)) throw new Error('Chưa tải đủ tất cả ảnh của tài liệu.');
    StudocuSupport.assertImageManifest(await studocuJobMessage(job, manifestRequest), identity);
    ensureStudocuJob(job);
    job.status = 'pdf';
    report({ action: 'downloadProgress', phase: 'pdf', current: expectedPages, total: expectedPages, percent: 100 });
    const pdf = await stages.run('pdf', `ghép ${expectedPages} trang thành PDF`, null, () => buildPdfFromJpegs(images));
    ensureStudocuJob(job);
    // Export commits here. The native Save dialog owns the operation afterward;
    // an abort cannot retract a file that Chrome may already have saved.
    job.status = 'saving';
    report({ action: 'downloadProgress', phase: 'saving', current: expectedPages, total: expectedPages, percent: 100 });
    await stages.run('saving', 'gửi PDF tới trình duyệt để lưu', null, () => chrome.downloads.download({ url: 'data:application/pdf;base64,' + uint8ToBase64(pdf), filename: `studocu_${docId}/document.pdf`, saveAs: true }));
    job.active = false; job.status = 'complete';
    report({ action: 'downloadComplete', pdfOnly: true, totalPages: expectedPages, pdfPages: expectedPages, resolvedCount: expectedPages, candidateCount: expectedPages });
    return { status: 'finished' };
  } catch (error) {
    job.active = false; job.status = job.cancelled ? 'cancelled' : 'error'; job.error = job.cancelled ? '' : error.message;
    report({ action: job.cancelled ? 'downloadCancelled' : 'downloadError', error: job.error });
    return { status: job.status, error: job.error };
  } finally {
    job.stages?.close();
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  const invalidate = (tabId, reason) => {
    const job = studocuImageJobs.get(tabId);
    if (job?.active && job.status !== 'saving') { job.failure = new Error(reason); job.controller.abort(); }
  };
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    studocuTaskManager?.invalidate(tabId, 'Tab tài liệu đã thay đổi hoặc đang tải lại. Hãy mở lại popup.', change).catch(error => console.error(error));
    const job = studocuImageJobs.get(tabId);
    if (job?.active && ((change.url && StudocuSupport.getDocumentId(change.url) !== job.docId) || change.status === 'loading')) {
      invalidate(tabId, 'Tab tài liệu đã thay đổi hoặc đang tải lại. Hãy mở lại popup.');
    }
  });
  chrome.tabs.onRemoved?.addListener(tabId => { invalidate(tabId, 'Tab tài liệu đã đóng.'); studocuTaskManager?.invalidate(tabId, 'Tab tài liệu đã đóng.').catch(error => console.error(error)); studocuImageJobs.delete(tabId); });
}

async function downloadStudocuPDF(docId, tabId, expectedPages, taskId) {
  const previous = studocuImageJobs.get(tabId);
  if (previous?.active) return { ...studocuJobState(previous, previous.docId), status: 'busy' };
  const job = { id: Date.now() + '-' + (++studocuJobSequence), tabId, docId, taskId, mode: 'html', totalPages: expectedPages,
    downloadedCount: 0, active: true, status: 'downloading', controller: new AbortController(), cancelled: false };
  studocuImageJobs.set(tabId, job);
  const report = message => reportStudocuJob(job, message);
  try {
    const stages = await initializeStudocuStages(job);
    const checkState = async expectedAsset => {
      const state = await stages.run('document_check', 'kiểm tra đủ trang và đúng tài liệu', null, () => studocuJobMessage(job, { action: 'getScanState', mode: 'html' }));
      if (!state || state.site !== 'studocu' || state.docId !== docId || state.isScanning ||
          !state.complete || !Number.isSafeInteger(expectedPages) || expectedPages < 1 || expectedPages > 10000 || state.totalPages !== expectedPages ||
          (expectedAsset && state.assetId !== expectedAsset)) {
        throw new Error('Tài liệu Studocu chưa đủ trang hoặc tab đã thay đổi. Hãy kiểm tra / quét bổ sung.');
      }
      return state;
    };
    const initial = await checkState();
    report({ action: 'downloadStarted' });
    const fonts = new Map(), styles = new Map(), missingFonts = new Set();
    const images = [];
    async function render(pageNum, refresh, rejectedUrl, rejectedFingerprint) {
      const data = await stages.run(refresh ? 'refresh' : 'html', refresh ? 'cập nhật nội dung trang sau lỗi tài nguyên' : 'đọc HTML và CSS đã thu thập', pageNum,
        () => studocuJobMessage(job, { action: refresh ? 'refreshStudocuPage' : 'getStudocuPage', pageNum, rejectedUrl, rejectedFingerprint }));
      if (!data || !data.ok || data.docId !== docId || data.assetId !== initial.assetId ||
          !data.page || data.page.pageNum !== pageNum || data.page.assetId !== initial.assetId) {
        throw new Error((data && data.error) || 'Trang không thuộc tài liệu Studocu đang tải.');
      }
      let css = data.css || '';
      const missingStyles = data.stylesheetUrls && data.stylesheetUrls.length ? data.stylesheetUrls : (!css ? [data.stylesheetUrl] : []);
      const fingerprint = StudocuSupport.pageFingerprint(data.page, css, missingStyles);
      try {
      for (const styleUrl of missingStyles) {
        const url = new URL(styleUrl);
        if (StudocuSupport.assetIdFromUrl(url.href) !== initial.assetId || !/\.css$/i.test(url.pathname)) {
          throw new Error('Không tìm thấy CSS của tài liệu Studocu.');
        }
        if (!styles.has(url.href)) styles.set(url.href, await stages.run('css', 'tải CSS còn thiếu', pageNum, () => fetchStudocuAsset(job, url.href, true)));
        css += '\n' + styles.get(url.href).replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi,
          (_, value) => `url("${new URL(value, url.href).href}")`);
      }
      const page = await stages.run('assets', 'nạp ảnh và font, chuẩn bị bố cục trang', pageNum, () => StudocuSupport.preparePage(data.page, css,
        async url => {
          if (/\.woff2?$/i.test(new URL(url).pathname)) {
            // Cache failures as well as successful fonts for this job. A 404
            // must not be requested again for every page in the document.
            if (!fonts.has(url)) fonts.set(url, stages.run('fonts', 'tải font ' + new URL(url).pathname.split('/').pop(), pageNum, () => fetchStudocuAsset(job, url)));
            return fonts.get(url);
          }
          return stages.run('images', 'tải ảnh trong trang', pageNum, () => fetchStudocuAsset(job, url));
        }));
      for (const url of page.missingFonts || []) missingFonts.add(url);
      job.fontFallbackCount = missingFonts.size;
      const rendered = await stages.run('render', 'giải mã font và dựng trang thành ảnh JPEG', pageNum, () => studocuJobMessage(job, { action: 'renderJsonpPageToImage', page, scale: RENDER_SCALE }));
      if (!rendered || !rendered.ok) throw new Error((rendered && rendered.error) || `Không dựng được trang ${pageNum}.`);
      for (const font of rendered.fontFallbacks || []) if (!missingFonts.has(font.family)) missingFonts.add('decoded:' + font.family);
      job.fontFallbackCount = missingFonts.size;
      const bytes = dataUrlToUint8Array(rendered.dataUrl);
      const size = parseJpegSize(bytes);
      if (!size) throw new Error(`Ảnh trang ${pageNum} không hợp lệ.`);
      return { pageNum, bytes, width: size.width, height: size.height, pdfWidth: data.page.width, pdfHeight: data.page.height };
      } catch (error) {
        error.rejectedFingerprint = fingerprint; throw error;
      }
    }
    for (let pageNum = 1; pageNum <= expectedPages; pageNum++) {
      ensureStudocuJob(job);
      try {
        images.push(await render(pageNum, false));
      } catch (error) {
        if (!/HTTP (?:401|403|404)\b/.test(error.message)) throw error;
        try {
          images.push(await render(pageNum, true, error.assetUrl, error.rejectedFingerprint));
        } catch (retryError) {
          ensureStudocuJob(job);
          await studocuJobMessage(job, { action: 'invalidateStudocuPage', pageNum,
            rejectedUrl: retryError.assetUrl || error.assetUrl,
            rejectedFingerprint: retryError.rejectedFingerprint || error.rejectedFingerprint }).catch(() => {});
          throw new Error(`Không tải được trang ${pageNum}: ${retryError.message}`);
        }
      }
      ensureStudocuJob(job);
      job.downloadedCount = pageNum;
      report({ action: 'downloadProgress', phase: 'pages', current: pageNum, total: expectedPages,
        percent: Math.round(pageNum / expectedPages * 100) });
    }
    await checkState(initial.assetId);
    ensureStudocuJob(job);
    const pdf = await stages.run('pdf', `ghép ${expectedPages} trang thành PDF`, null, () => buildPdfFromJpegs(images));
    ensureStudocuJob(job);
    job.status = 'saving';
    report({ action: 'downloadProgress', phase: 'saving', current: expectedPages, total: expectedPages, percent: 100 });
    await stages.run('saving', 'gửi PDF tới trình duyệt để lưu', null, () => chrome.downloads.download({ url: 'data:application/pdf;base64,' + uint8ToBase64(pdf),
      filename: `studocu_${docId}/document.pdf`, saveAs: true }));
    job.active = false; job.status = 'complete';
    report({ action: 'downloadComplete', pdfOnly: true, totalPages: images.length, pdfPages: images.length,
      resolvedCount: images.length, candidateCount: expectedPages });
    return { status: 'finished' };
  } catch (error) {
    job.active = false; job.status = job.cancelled ? 'cancelled' : 'error'; job.error = job.cancelled ? '' : error.message;
    report({ action: job.cancelled ? 'downloadCancelled' : 'downloadError', error: job.error });
    return { status: job.status, error: job.error };
  } finally {
    job.stages?.close();
  }
}

async function downloadAndMergePDF(urls, docId, sendResponse, options = {}) {
  let fastJob, stages;
  const startedAt = Date.now();
  const identity = { site: 'scribd', docId, tabId: options.tabId };
  const taskId = Date.now() + '-' + (++documentActivitySequence);
  const report = message => {
    const status = message.action === 'downloadComplete' ? 'complete' : message.action === 'downloadError' ? 'error' : 'downloading';
    const previous = documentActivities.get(documentActivityKey(identity));
    if (previous && previous.taskId !== taskId) return;
    const count = message.current ?? message.pdfPages ?? previous?.downloadedCount ?? 0;
    updateDocumentActivity(identity, { taskId, status, active: status === 'downloading', downloadedCount: count,
      ...(status !== 'downloading' ? { activeStages: [], elapsedMs: Date.now() - startedAt } : {}),
      totalPages: message.total ?? message.totalPages ?? previous?.totalPages ?? options.expectedPages,
      error: message.error || '', fontFallbackCount: message.fontFallbackCount ?? previous?.fontFallbackCount ?? 0 },
      status === 'complete' ? `✅ Hoàn tất: đã tạo PDF đủ ${count}/${message.totalPages} trang (${((Date.now() - startedAt) / 1000).toFixed(1).replace('.', ',')} giây)` + (message.fontFallbackCount ? `; ⚠ ${message.fontFallbackCount} font dùng font dự phòng.` : '')
        : status === 'error' ? '❌ ' + message.error : `Đã xử lý ${count}/${message.total} trang`,
      status === 'error' ? 'error' : message.fontFallbackCount ? 'warn' : 'info');
    notifyPopup({ ...message, ...identity, taskId });
  };
  if (options.fast) {
    if (scribdFastJobs.has(options.tabId)) return { status: 'busy' };
    fastJob = { controller: new AbortController(), resources: new Map(), activeRequests: 0, pending: [] };
    scribdFastJobs.set(options.tabId, fastJob);
  }
  scribdDownloads.set(docId, (scribdDownloads.get(docId) || 0) + 1);
  try {
    if (documentActivityKey(identity)) await loadDocumentActivity(identity);
    const initial = updateDocumentActivity(identity, { taskId, phase: 'pages', status: 'downloading', active: true, startedAt: Date.now(),
      totalPages: options.expectedPages || 0, downloadedCount: 0, error: '', fontFallbackCount: 0, activeStages: [] }, '📥 Bắt đầu tải và dựng PDF.');
    if (initial) await documentActivityWrites.get(documentActivityKey(identity));
    stages = createDocumentStages(identity, taskId, fastJob?.controller.signal);
    if (fastJob) fastJob.stages = stages;
    const candidates = Array.isArray(urls) ? urls : [];
    const pages = uniqueImagesByPageNumber(
      candidates
        .map((url, index) => createPageCandidate(url, index))
        .filter(Boolean),
      options.expectedPages
    );

    const expected = Number(options.expectedPages);
    if (Number.isSafeInteger(expected) && expected > 0 &&
        (pages.length !== expected || pages.some((page, index) => page.pageNum !== index + 1))) {
      throw new Error(
        `Chỉ thu thập được ${pages.length}/${expected} trang. Tài liệu còn thiếu trang; hãy quét lại sau khi nội dung tải xong.`
      );
    }

    if (!shouldAcceptResolveCount(pages.length, candidates.length)) {
      report({
        action: 'downloadError',
        docId,
        error:
          'Chi trich xuat duoc ' + pages.length + '/' + candidates.length +
          ' URL trang hop le. Qua it trang hop le - hay quet lai.'
      });
      return;
    }

    if (options.fast && (!Number.isSafeInteger(expected) || expected < 1 || expected > 10000 ||
        !Number.isSafeInteger(options.tabId) || !/^\d+$/.test(docId) ||
        new Set(pages.map(page => new URL(page.url).pathname.split('/')[1])).size !== 1)) {
      throw new Error('Danh sách trang Scribd không hợp lệ hoặc thuộc nhiều tài liệu.');
    }
    updateDocumentActivity(identity, { count: pages.length, totalPages: pages.length });
    const pdfImages = options.fast
      ? await loadScribdPagesFast(pages, options.tabId, docId, fastJob, report)
      : options.tabId
      ? await renderPdfImagesFromJsonpPages(pages, options.tabId, docId, report)
      : await fetchSourcePdfImages(pages, docId, report);

    if (pdfImages.length === 0) {
      throw new Error('Khong co trang hop le de ghep PDF.');
    }

    if (pdfImages.length !== pages.length) {
      throw new Error(
        'Chi ghep duoc ' + pdfImages.length + '/' + pages.length +
        ' trang vao PDF. Hay quet lai de tranh tao PDF thieu trang.'
      );
    }

    const pdfUrl = await stages.run('pdf', `ghép ${pdfImages.length} trang và đóng gói PDF`, null, () =>
      'data:application/pdf;base64,' + uint8ToBase64(buildPdfFromJpegs(pdfImages)));
    if (options.fast) await stages.run('document_check', 'kiểm tra lại tab tài liệu trước khi lưu', null, () => assertScribdSource(options.tabId, docId));

    updateDocumentActivity(identity, { status: 'saving', active: true }, 'Đang lưu PDF…');

    await stages.run('saving', 'gửi PDF tới trình duyệt để lưu', null, () => chrome.downloads.download({
      url: pdfUrl,
      filename: `scribd_${docId}/document.pdf`,
      saveAs: true
    }));

    report({
      action: 'downloadComplete',
      docId,
      totalPages: pages.length,
      pdfPages: pdfImages.length,
      resolvedCount: pages.length,
      candidateCount: candidates.length,
      pdfOnly: true,
      fontFallbacks: pdfImages.flatMap(page => (page.fontFallbacks || []).map(font => ({ ...font, pageNum: page.pageNum }))),
      fontFallbackCount: new Set(pdfImages.flatMap(page => (page.fontFallbacks || []).map(font => font.family))).size
    });
  } catch (error) {
    report({
      action: 'downloadError',
      docId,
      error: error.message
    });
  } finally {
    stages?.close();
    const count = (scribdDownloads.get(docId) || 1) - 1;
    if (count) scribdDownloads.set(docId, count); else scribdDownloads.delete(docId);
    if (fastJob) {
      fastJob.controller.abort();
      fastJob.resources.clear();
      if (scribdFastJobs.get(options.tabId) === fastJob) scribdFastJobs.delete(options.tabId);
    }
    await documentActivityWrites.get(documentActivityKey(identity))?.catch(() => {});
  }
}

async function assertScribdSource(tabId, docId) {
  const info = await sendTabMessage(tabId, { action: 'getDocInfo' });
  if (!info || info.docId !== docId) throw new Error('Tab đã đóng, tải lại hoặc chuyển sang tài liệu khác.');
}

// Four requests including their response bodies, shared by page HTML, images
// and fonts. Resource promises are scoped to this download and evicted on error.
async function fetchScribdResource(url, kind, job) {
  if (job.activeRequests < 4) job.activeRequests++;
  else await new Promise(resolve => job.pending.push(resolve));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (job.controller.signal.aborted) throw new Error('Đã dừng tải tài liệu.');
      try {
        const response = await fetch(url, { signal: job.controller.signal });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return kind === 'text' ? await response.text() : {
          bytes: new Uint8Array(await response.arrayBuffer()),
          mime: response.headers.get('content-type') || guessMimeType(url)
        };
      } catch (error) {
        if (attempt || job.controller.signal.aborted || (error.status && error.status < 500)) throw error;
        const name = new URL(url).pathname.split('/').pop();
        job.stages?.log(`↻ Tải ${name} gặp ${error.status ? 'HTTP ' + error.status : 'lỗi mạng'}; đang thử lại lần 1/1.`, { event: 'resourceRetry' });
      }
    }
  } finally {
    const next = job.pending.shift();
    if (next) next(); else job.activeRequests--;
  }
}

async function loadScribdPagesFast(pages, tabId, docId, job, report = notifyPopup) {
  const stages = job.stages || { run: (stage, label, pageNum, operation) => operation() };
  await stages.run('document_check', 'kiểm tra kết nối và đúng tài liệu', null, () => assertScribdSource(tabId, docId));
  const output = new Array(pages.length), failures = [];
  let next = 0, completed = 0;
  const dataUrl = url => {
    const normalized = normalizeScribdAssetUrl(url);
    if (!job.resources.has(normalized)) {
      const promise = fetchScribdResource(normalized, 'bytes', job)
        .then(value => `data:${value.mime};base64,${uint8ToBase64(value.bytes)}`)
        .catch(error => { if (!/\.woff2?(?:\?|$)/i.test(normalized)) job.resources.delete(normalized); throw error; });
      job.resources.set(normalized, promise);
    }
    return job.resources.get(normalized);
  };
  async function prepare(candidate) {
    if (candidate.type !== 'jsonp') {
      const source = await stages.run('images', 'nạp ảnh trang', candidate.pageNum, () => dataUrl(candidate.url)), bytes = dataUrlToUint8Array(source);
      if (isJpegBytes(bytes)) {
        const size = parseJpegSize(bytes, true);
        if (size.colorSpace) return { pageNum: candidate.pageNum, bytes, ...size };
      }
      const rendered = await stages.run('render', 'giải mã ảnh và chuyển JPEG', candidate.pageNum, () => sendTabMessage(tabId, { action: 'renderScribdImage', docId, pageNum: candidate.pageNum, dataUrl: source }));
      if (!rendered?.ok) throw new Error(rendered?.error || 'Không giải mã được ảnh.');
      const converted = dataUrlToUint8Array(rendered.dataUrl);
      if (!isJpegBytes(converted)) throw new Error('Renderer trả về ảnh không hợp lệ.');
      return { pageNum: candidate.pageNum, bytes: converted, ...parseJpegSize(converted) };
    }
    const text = await stages.run('html', 'tải HTML', candidate.pageNum, () => fetchScribdResource(candidate.url, 'text', job));
    const page = parseScribdJsonpPage(text, candidate.url);
    const id = page.html.match(/\bid=["']page(\d+)["']/);
    if (id && Number(id[1]) !== candidate.pageNum) throw new Error('Nội dung trang không khớp URL.');
    const imagePage = readScribdImagePage(page);
    if (imagePage) {
      const source = await stages.run('images', 'nạp ảnh trang', page.pageNum, () => dataUrl(imagePage.url)), bytes = dataUrlToUint8Array(source);
      if (isJpegBytes(bytes)) {
        const size = parseJpegSize(bytes, true);
        if (size.colorSpace) return { pageNum: page.pageNum, bytes, ...size,
          pdfWidth: page.width, pdfHeight: page.height, placements: imagePage.placements };
      }
    }
    const assets = { strict: true, dataUrl, assetBase: getScribdAssetBase(candidate.url) };
    page.html = await stages.run('images', 'kiểm tra và nạp ảnh trong trang', page.pageNum, () => inlinePageImages(page.html, assets));
    const context = await stages.run('css', 'lấy CSS và bố cục từ tab tài liệu', page.pageNum, () => sendTabMessage(tabId, { action: 'getScribdRendererContext', docId, page }));
    if (!context?.ok) throw Error(context?.error || 'Không thu được CSS của trang Scribd.');
    page.html = context.html; page.rendererCss = context.css || ''; page.fontFamilies = context.fontFamilies; page.styled = true;
    await stages.run('css_images', 'nạp ảnh trong CSS', page.pageNum, () => inlineScribdCssImages(page, assets));
    page.missingFonts = [];
    assets.onFontFallback = font => {
      page.missingFonts.push(font.family);
      job.stages?.log(`⚠ Trang ${page.pageNum}: Không tải được font ${font.family}; dùng font dự phòng.`, { event: 'fontFallback', pageNum: page.pageNum }, 'warn');
    };
    page.fontCss = await stages.run('fonts', `nạp ${buildFontUrlsForPage(page).length} font của tài liệu`, page.pageNum, () => buildFontCssForPage(page, assets));
    const rendered = await stages.run('render', 'giải mã font và dựng trang thành ảnh JPEG', page.pageNum, () => sendTabMessage(tabId, { action: 'renderJsonpPageToImage', docId, page, scale: RENDER_SCALE, site: 'scribd' }));
    if (!rendered?.ok) throw new Error(rendered?.error || 'Không dựng được trang đầy đủ.');
    const bytes = dataUrlToUint8Array(rendered.dataUrl);
    if (!isJpegBytes(bytes)) throw new Error('Renderer trả về ảnh không hợp lệ.');
    return { pageNum: page.pageNum, bytes, ...parseJpegSize(bytes), pdfWidth: page.width, pdfHeight: page.height, fontFallbacks: rendered.fontFallbacks || [] };
  }
  async function worker() {
    while (next < pages.length && !job.controller.signal.aborted) {
      const index = next++, candidate = pages[index];
      try {
        let result;
        try { result = await prepare(candidate); }
        catch (error) {
          if (!/HTTP (?:401|403)\b/.test(error.message)) throw error;
          const fresh = await stages.run('refresh', 'cập nhật URL sau lỗi quyền truy cập 401/403', candidate.pageNum, () => sendTabMessage(tabId, { action: 'refreshScanPage', docId,
            pageNum: candidate.pageNum, candidateUrl: candidate.url, noScroll: true }));
          const replacement = fresh?.ok && createPageCandidate(fresh.url, candidate.pageNum - 1);
          if (!replacement || replacement.pageNum !== candidate.pageNum || replacement.type !== candidate.type ||
              new URL(replacement.url).pathname !== new URL(candidate.url).pathname || replacement.url === candidate.url) throw error;
          result = await prepare(replacement);
        }
        if (job.controller.signal.aborted) return;
        output[index] = result;
        completed++;
        report({ action: 'downloadProgress', docId, tabId, phase: 'pdf',
          current: completed, total: pages.length, percent: Math.round(completed / pages.length * 100) });
      } catch (error) {
        if (!job.controller.signal.aborted) failures.push(`trang ${candidate.pageNum}: ${error.message}`);
        job.controller.abort();
      }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(4, pages.length) }, worker));
  if (failures.length || completed !== pages.length) throw new Error('Không tải đủ tài liệu: ' + (failures.join('; ') || 'tác vụ đã dừng.'));
  return output;
}

function normalizeScribdAssetUrl(url) {
  return upgradeToHttps(url).replace(/^https:\/\/html\.scribd\.com\//i, 'https://html.scribdassets.com/');
}

// Only the simple scanned-page structure is eligible. Anything else keeps the
// existing complete HTML renderer; this deliberately rejects unknown styling.
function readScribdImagePage(page) {
  if (!page.hasImageLayer || page.hasTextLayer) return null;
  const placements = [], sources = new Set();
  const tags = page.html.match(/<[^>]+>/g) || [];
  if (page.html.replace(/<[^>]+>/g, '').trim()) return null;
  function attrs(tag) {
    const result = {};
    for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
    return result;
  }
  for (const tag of tags) {
    if (/^<\/div\s*>$/i.test(tag)) continue;
    if (!/^<(?:div|img)\b/i.test(tag)) return null;
    const a = attrs(tag), style = new Map();
    if (Object.keys(a).some(key => !['id','class','style','src','orig','alt'].includes(key))) return null;
    for (const declaration of (a.style || '').split(';').filter(value => value.trim())) {
      const at = declaration.indexOf(':');
      if (at < 0) return null;
      const name = declaration.slice(0, at).trim().toLowerCase(), value = declaration.slice(at + 1).trim();
      if (style.has(name)) return null;
      style.set(name, value);
    }
    if (/^<div\b/i.test(tag)) {
      if (!['newpage', 'image_layer', 'ie_fix'].includes(a.class) ||
          [...style.keys()].some(key => !['width', 'height', 'z-index'].includes(key))) return null;
      if (a.class !== 'newpage' && (style.has('width') || style.has('height'))) return null;
      continue;
    }
    if (a.class !== 'absimg' || [...style.keys()].some(key => !['left','top','width','height','clip'].includes(key))) return null;
    const rect = {};
    for (const key of ['left','top','width','height']) {
      const match = (style.get(key) || '').match(/^(-?\d+(?:\.\d+)?)px$/);
      if (!match) return null;
      rect[key] = Number(match[1]);
    }
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const clip = style.get('clip')?.match(/^rect\(\s*(-?\d+(?:\.\d+)?)px[\s,]+(-?\d+(?:\.\d+)?)px[\s,]+(-?\d+(?:\.\d+)?)px[\s,]+(-?\d+(?:\.\d+)?)px\s*\)$/);
    if (style.has('clip') && !clip) return null;
    if (clip) {
      rect.clip = clip.slice(1).map(Number);
      if (rect.clip[1] <= rect.clip[3] || rect.clip[2] <= rect.clip[0]) return null;
    }
    const source = normalizeScribdAssetUrl(decodeHtmlEntities(a.src || a.orig || ''));
    if (!isDirectImageUrl(source) || new URL(source).pathname.split('/')[1] !== new URL(page.url).pathname.split('/')[1] ||
        extractPageNumber(source, 0) !== page.pageNum) return null;
    sources.add(source); placements.push(rect);
  }
  return sources.size === 1 && placements.length ? { url: [...sources][0], placements } : null;
}

function createPageCandidate(url, fallbackIndex) {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }
  if (!isScribdJsonpPageUrl(url) && !isDirectImageUrl(url)) {
    return null;
  }
  return {
    pageNum: extractPageNumber(url, fallbackIndex + 1),
    url: upgradeToHttps(url).replace(/^https:\/\/html\.scribd\.com\//i, 'https://html.scribdassets.com/'),
    type: isScribdJsonpPageUrl(url) ? 'jsonp' : 'image'
  };
}

// Minimum acceptable resolved fraction: when total >= 20 we require at
// least max(10, floor(total * 0.25)) successfully resolved pages.
function shouldAcceptResolveCount(resolved, total) {
  const r = Number(resolved) || 0;
  const t = Number(total) || 0;
  if (t < 20) {
    return r > 0;
  }
  const threshold = Math.max(10, Math.floor(t * 0.25));
  return r >= threshold;
}

function uniqueImagesByPageNumber(images, maxPage) {
  const max = Number(maxPage) || 0;
  const byPage = new Map();
  for (const image of images.slice().sort((a, b) => a.pageNum - b.pageNum)) {
    if (max > 0 && image.pageNum > max) {
      continue;
    }
    if (!byPage.has(image.pageNum)) {
      byPage.set(image.pageNum, image);
      continue;
    }
    const existing = byPage.get(image.pageNum);
    if (pageCandidatePriority(image) > pageCandidatePriority(existing)) {
      byPage.set(image.pageNum, image);
    }
  }
  return [...byPage.values()];
}

function pageCandidatePriority(page) {
  return (page.type === 'jsonp' ? 8 : 0) + (/[?&]token=[^&#]+/.test(page.url || '') ? 4 : 0);
}

async function renderPdfImagesFromJsonpPages(pages, tabId, docId, report = notifyPopup) {
  const pdfImages = [];
  const failedPages = [];

  for (let i = 0; i < pages.length; i++) {
    const candidate = pages[i];
    try {
      const pdfImage = await renderPageWithRefresh(candidate, tabId, docId);
      pdfImages.push(pdfImage);

      report({
        action: 'downloadProgress',
        docId,
        phase: 'pdf',
        current: i + 1,
        total: pages.length,
        percent: Math.round(((i + 1) / pages.length) * 100)
      });
    } catch (error) {
      failedPages.push(candidate.pageNum);
      console.log(`Khong render duoc trang ${candidate.pageNum}: ${error.message}`);
    }
  }

  if (failedPages.length) {
    throw new Error(`Không tải được trang ${failedPages.join(', ')}. Kết quả quét các trang khác vẫn được giữ; hãy kiểm tra lại các trang lỗi.`);
  }

  return pdfImages;
}

async function renderPageWithRefresh(candidate, tabId, docId) {
  const render = page => page.type === 'jsonp'
    ? renderJsonpCandidate(page, tabId) : renderDirectImageCandidate(page, tabId);
  try {
    return await render(candidate);
  } catch (error) {
    if (!/HTTP (?:401|403|404)\b/.test(error.message)) throw error;
    // Ask the authorized reader for a new URL for this page only. Never invent
    // tokens or start a document-wide rescan after an access failure.
    const refreshed = await sendTabMessage(tabId, { action: 'refreshScanPage', docId,
      pageNum: candidate.pageNum, candidateUrl: candidate.url });
    const replacement = refreshed && refreshed.ok && createPageCandidate(refreshed.url, candidate.pageNum - 1);
    if (!replacement || replacement.pageNum !== candidate.pageNum ||
        new URL(replacement.url).pathname.split('/')[1] !== new URL(candidate.url).pathname.split('/')[1] ||
        (candidate.type === 'jsonp' && replacement.type !== 'jsonp')) throw error;
    Object.assign(candidate, replacement);
    try {
      return await render(candidate);
    } catch (retryError) {
      if (/HTTP (?:401|403|404)\b/.test(retryError.message)) {
        await sendTabMessage(tabId, { action: 'invalidateScanPage', docId,
          pageNum: candidate.pageNum, candidateUrl: candidate.url }).catch(() => {});
      }
      throw retryError;
    }
  }
}

async function renderJsonpCandidate(candidate, tabId) {
  const response = await fetch(candidate.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} khi tai JSONP trang ${candidate.pageNum}`);
  }

  const text = await response.text();
  const page = parseScribdJsonpPage(text, candidate.url);
  page.html = await inlinePageImages(page.html);
  page.missingFonts = [];
  page.fontCss = await buildFontCssForPage(page, { onFontFallback: font => page.missingFonts.push(font.family) });

  const rendered = await sendTabMessage(tabId, {
    action: 'renderJsonpPageToImage',
    page,
    scale: RENDER_SCALE
  });
  if (!rendered || !rendered.ok) {
    throw new Error((rendered && rendered.error) || `Khong render duoc trang ${candidate.pageNum}`);
  }

  const bytes = dataUrlToUint8Array(rendered.dataUrl);
  if (!isJpegBytes(bytes)) {
    throw new Error(`Renderer tra ve anh khong phai JPEG cho trang ${candidate.pageNum}`);
  }
  const size = parseJpegSize(bytes);
  return {
    pageNum: page.pageNum,
    url: candidate.url,
    bytes,
    width: size.width,
    height: size.height,
    fontFallbacks: rendered.fontFallbacks || []
  };
}

async function renderDirectImageCandidate(candidate, tabId) {
  const dataUrl = await fetchAsDataUrl(candidate.url);
  const rendered = await sendTabMessage(tabId, {
    action: 'renderJsonpPageToImage',
    page: {
      pageNum: candidate.pageNum,
      width: 902,
      height: 1167,
      html: `<div class="newpage" id="page${candidate.pageNum}" style="width:902px;height:1167px"><img class="absimg" src="${dataUrl}" style="position:absolute;left:0;top:0;width:902px;height:1167px"/></div>`,
      fontCss: ''
    },
    scale: RENDER_SCALE
  });
  if (!rendered || !rendered.ok) {
    throw new Error((rendered && rendered.error) || `Khong render duoc anh trang ${candidate.pageNum}`);
  }
  const bytes = dataUrlToUint8Array(rendered.dataUrl);
  const size = parseJpegSize(bytes);
  return {
    pageNum: candidate.pageNum,
    url: candidate.url,
    bytes,
    width: size.width,
    height: size.height
  };
}

async function fetchSourcePdfImages(pages, docId, report = notifyPopup) {
  const pdfImages = [];
  for (let i = 0; i < pages.length; i++) {
    const img = pages[i];
    if (img.type !== 'image') {
      continue;
    }
    try {
      pdfImages.push(await fetchPdfImage(img));
      report({
        action: 'downloadProgress',
        docId,
        phase: 'pdf',
        current: i + 1,
        total: pages.length,
        percent: Math.round(((i + 1) / pages.length) * 100)
      });
    } catch (e) {
      console.log(`Khong the them trang ${img.pageNum} vao PDF: ${e.message}`);
    }
  }
  return pdfImages;
}

function parseScribdJsonpPage(text, url) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('JSONP rong');
  }

  const start = text.indexOf('([');
  const end = text.lastIndexOf('])');
  if (start < 0 || end < start) {
    throw new Error('Khong doc duoc mang HTML trong JSONP');
  }

  let parts;
  try {
    parts = JSON.parse(text.slice(start + 1, end + 1));
  } catch (error) {
    throw new Error('Khong parse duoc JSONP HTML: ' + error.message);
  }

  const html = parts.join('');
  const pageNum = extractPageNumber(url, 1);
  const newpageMatch = html.match(/<div\b[^>]*class=["'][^"']*\bnewpage\b[^"']*["'][^>]*>/i);
  const tag = newpageMatch ? newpageMatch[0] : '';
  const styleMatch = tag.match(/style=["']([^"']+)["']/i) || html.match(/style=["']([^"']*width\s*:\s*\d+px[^"']*)["']/i);
  const style = styleMatch ? styleMatch[1] : '';
  const widthMatch = style.match(/width\s*:\s*(\d+(?:\.\d+)?)px/i);
  const heightMatch = style.match(/height\s*:\s*(\d+(?:\.\d+)?)px/i);
  const width = widthMatch ? Math.round(Number(widthMatch[1])) : 902;
  const height = heightMatch ? Math.round(Number(heightMatch[1])) : 1167;

  return {
    pageNum,
    url: upgradeToHttps(url),
    html,
    width,
    height,
    hasTextLayer: /\btext_layer\b/.test(html),
    hasImageLayer: /\bimage_layer\b/.test(html)
  };
}

function buildFontUrlsForPage(page) {
  const base = getScribdAssetBase(page && page.url);
  if (!base || !page || typeof page.html !== 'string') {
    return [];
  }

  if (Array.isArray(page.fontFamilies)) return page.fontFamilies.filter(font => /^ff\d+$/.test(font.family)).map(font => ({ ...font,
    url: `${base}/fonts/${font.family.slice(2).padStart(4, '0')}.woff2` }));
  const fonts = new Set();
  const re = /\bff(\d+)\b/g;
  let match;
  while ((match = re.exec(page.html)) !== null) {
    fonts.add(Number(match[1]));
  }

  return [...fonts]
    .sort((a, b) => a - b)
    .map((n) => ({
      family: 'ff' + n,
      url: `${base}/fonts/${String(n).padStart(4, '0')}.woff2`
    }));
}

async function buildFontCssForPage(page, options = {}) {
  const urls = buildFontUrlsForPage(page);
  const rules = [];
  for (const font of urls) {
    try {
      const dataUrl = options.dataUrl ? await options.dataUrl(font.url) : await fetchAsDataUrl(font.url, fontDataUrlCache);
      rules.push(`@font-face{font-family:${font.family};src:url("${dataUrl}") format("woff2");font-weight:${font.weight || 'normal'};font-style:${font.style || 'normal'};font-display:block}`);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      options.onFontFallback?.(font);
      console.log(`Khong tai duoc font ${font.family}: ${error.message}`);
    }
  }
  return rules.join('\n');
}

async function inlineScribdCssImages(page, options) {
  const css = decodeHtmlEntities(page.html + '\n' + page.rendererCss);
  const sources = new Set([...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map(match => match[1]).filter(url => !url.startsWith('data:')));
  for (const source of sources) {
    const url = normalizeScribdAssetUrl(source);
    if (!url.startsWith(options.assetBase + '/images/') || !/\.(?:png|jpe?g|webp)(?:\?|$)/i.test(url)) throw Error('Ảnh CSS không thuộc tài liệu Scribd hiện tại.');
    const embedded = await options.dataUrl(url);
    page.html = page.html.split(source.replaceAll('&', '&amp;')).join(embedded).split(source).join(embedded);
    page.rendererCss = page.rendererCss.split(source).join(embedded);
  }
}

async function inlinePageImages(html, options = {}) {
  if (typeof html !== 'string' || html.length === 0) {
    return html;
  }
  if (options.strict) {
    // Validate the entire page before starting any promises. Select one source
    // per element so an obsolete orig cannot defeat the reader's signed src.
    const tags = [...html.matchAll(/<img\b[^>]*>/gi)];
    const items = tags.map(match => {
      const attrs = {};
      for (const a of match[0].matchAll(/\s(orig|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) attrs[a[1].toLowerCase()] = decodeHtmlEntities(a[2] ?? a[3]);
      const raw = /^https?:\/\//i.test(attrs.src || '') ? attrs.src : attrs.orig || attrs.src || '';
      if (/^data:image\/(?:jpeg|png|webp);base64,/i.test(raw)) return { index: match.index, tag: match[0], source: raw };
      const source = normalizeScribdAssetUrl(raw);
      if (!isDirectImageUrl(source) || !source.startsWith(options.assetBase + '/images/')) throw new Error('Ảnh không thuộc tài liệu Scribd hiện tại.');
      return { index: match.index, tag: match[0], source };
    });
    const replacements = await Promise.all(items.map(async item => {
      const embedded = item.source.startsWith('data:') ? item.source : await options.dataUrl(item.source);
      return { ...item, replacement: item.tag.replace(/\s(?:orig|src)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
        .replace(/\/?\s*>$/, ` src="${embedded}"/>`) };
    }));
    for (const item of replacements.reverse()) html = html.slice(0, item.index) + item.replacement + html.slice(item.index + item.tag.length);
    return html;
  }

  const replacements = new Map();
  const attrRe = /\b(?:orig|src)=["'](https?:\/\/[^"']+\.(?:jpe?g|png|webp)(?:\?[^"']*)?)["']/gi;
  let match;
  while ((match = attrRe.exec(html)) !== null) {
    const rawUrl = decodeHtmlEntities(match[1]);
    if (!/scribd/i.test(rawUrl) && !options.strict) {
      continue;
    }
    const httpsUrl = options.strict ? normalizeScribdAssetUrl(rawUrl) : upgradeToHttps(rawUrl);
    if (options.strict && (!isDirectImageUrl(httpsUrl) || !httpsUrl.startsWith(options.assetBase + '/images/'))) {
      throw new Error('Ảnh không thuộc tài liệu Scribd hiện tại.');
    }
    if (!replacements.has(httpsUrl)) {
      replacements.set(httpsUrl, options.dataUrl ? options.dataUrl(httpsUrl) : fetchAsDataUrl(httpsUrl, imageDataUrlCache).catch(() => null));
    }
  }

  const dataUrls = new Map();
  await Promise.all([...replacements].map(async ([url, promise]) => {
    const dataUrl = await promise;
    if (dataUrl) {
      dataUrls.set(url, dataUrl);
    }
  }));

  return html.replace(attrRe, (full, rawUrl) => {
    const decoded = decodeHtmlEntities(rawUrl);
    const dataUrl = dataUrls.get(options.strict ? normalizeScribdAssetUrl(decoded) : upgradeToHttps(decoded));
    if (!dataUrl) {
      return full;
    }
    return `src="${dataUrl}"`;
  });
}

async function fetchAsDataUrl(url, cache) {
  const normalized = upgradeToHttps(url);
  if (cache && cache.has(normalized)) {
    return cache.get(normalized);
  }

  const response = await fetch(normalized);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || guessMimeType(normalized);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const dataUrl = `data:${contentType};base64,${uint8ToBase64(bytes)}`;
  if (cache) {
    cache.set(normalized, dataUrl);
  }
  return dataUrl;
}

function getScribdAssetBase(url) {
  const match = String(url || '').match(/^(https?:\/\/html\.scribdassets\.com\/[^/?#]+)\/pages\//i);
  return match ? upgradeToHttps(match[1]) : null;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function guessMimeType(url) {
  const ext = pickExtension(url);
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (/\.woff2(?:\?|#|$)/i.test(url)) return 'font/woff2';
  return 'image/jpeg';
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function dataUrlToUint8Array(dataUrl) {
  const commaIndex = String(dataUrl).indexOf(',');
  if (commaIndex < 0) {
    throw new Error('Invalid data URL');
  }
  const base64 = dataUrl.slice(commaIndex + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function fetchPdfImage(image) {
  const response = await fetch(image.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isJpegBytes(bytes)) {
    throw new Error('Chi ho tro anh JPEG/JPG khi ghep PDF truc tiep.');
  }

  const size = parseJpegSize(bytes);
  return {
    pageNum: image.pageNum,
    url: image.url,
    bytes,
    width: size.width,
    height: size.height
  };
}

function isJpegBytes(bytes) {
  return bytes instanceof Uint8Array &&
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9;
}

function parseJpegSize(bytes, withColorSpace = false) {
  if (!isJpegBytes(bytes)) {
    throw new Error('Invalid JPEG data');
  }

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) {
      break;
    }

    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const size = {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8]
      };
      if (withColorSpace) size.colorSpace = bytes[offset + 9] === 1 ? 'DeviceGray' : bytes[offset + 9] === 3 ? 'DeviceRGB' : null;
      return size;
    }

    offset += 2 + length;
  }

  throw new Error('Cannot read JPEG dimensions');
}

function buildPdfFromJpegs(images) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('No images to build PDF');
  }

  const objects = [];
  const pageIds = [];

  function addObject(id, parts) {
    objects.push({ id, parts: Array.isArray(parts) ? parts : [parts] });
  }

  let nextId = 3;
  for (const image of images) {
    const pageId = nextId++;
    const imageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);

    const width = Math.max(1, Math.round(image.width));
    const height = Math.max(1, Math.round(image.height));
    const pdfWidth = Number.isFinite(image.pdfWidth) && image.pdfWidth > 0 ? image.pdfWidth : width;
    const pdfHeight = Number.isFinite(image.pdfHeight) && image.pdfHeight > 0 ? image.pdfHeight : height;
    const imageName = `Im${pageIds.length}`;
    const content = image.placements ? image.placements.map(rect => {
      const clip = rect.clip;
      const crop = clip ? `${rect.left + clip[3]} ${pdfHeight - rect.top - clip[2]} ${clip[1] - clip[3]} ${clip[2] - clip[0]} re W n\n` : '';
      return `q\n0 0 ${pdfWidth} ${pdfHeight} re W n\n${crop}${rect.width} 0 0 ${rect.height} ${rect.left} ${pdfHeight - rect.top - rect.height} cm\n/${imageName} Do\nQ\n`;
    }).join('') : `q\n${pdfWidth} 0 0 ${pdfHeight} 0 0 cm\n/${imageName} Do\nQ\n`;

    addObject(pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfWidth} ${pdfHeight}] ` +
      `/Resources << /XObject << /${imageName} ${imageId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`
    );
    addObject(imageId, [
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /${image.colorSpace || 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${image.bytes.length} >>\nstream\n`,
      image.bytes,
      '\nendstream'
    ]);
    addObject(contentId, [
      `<< /Length ${asciiBytes(content).length} >>\nstream\n`,
      content,
      'endstream'
    ]);
  }

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(2, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
  objects.sort((a, b) => a.id - b.id);

  const parts = [asciiBytes('%PDF-1.4\n')];
  const offsets = [0];

  for (const object of objects) {
    offsets[object.id] = totalLength(parts);
    parts.push(asciiBytes(`${object.id} 0 obj\n`));
    for (const part of object.parts) {
      parts.push(typeof part === 'string' ? asciiBytes(part) : part);
    }
    parts.push(asciiBytes('\nendobj\n'));
  }

  const xrefOffset = totalLength(parts);
  const maxId = objects[objects.length - 1].id;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    xref += `${String(offsets[id] || 0).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(asciiBytes(xref));

  return concatUint8Arrays(parts);
}

function asciiBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function totalLength(parts) {
  return parts.reduce((sum, part) => sum + part.length, 0);
}

function concatUint8Arrays(parts) {
  const output = new Uint8Array(totalLength(parts));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function uint8ToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function resolveImageUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }
  if (isDirectImageUrl(url)) {
    return upgradeToHttps(url);
  }
  if (!isScribdJsonpPageUrl(url)) {
    return null;
  }
  const response = await fetch(url);
  const text = await response.text();
  return extractImageUrlFromJsonpText(text);
}

function isDirectImageUrl(url) {
  return typeof url === 'string' && SCRIBD_DIRECT_PAGE_IMAGE_PATTERN.test(url);
}

function isScribdJsonpPageUrl(url) {
  return typeof url === 'string' &&
    /^https?:\/\/html\.(?:scribdassets|scribd)\.com\/[^/?#]+\/pages\/[1-9]\d*-[^/?#]+\.jsonp(?:\?|#|$)/i.test(url);
}

function imageUrlFromJsonpPageUrl(url) {
  if (!isScribdJsonpPageUrl(url)) {
    return null;
  }

  const match = String(url).match(/^(https?:\/\/html\.scribdassets\.com\/[^/?#]+)\/pages\/(\d+-[^/?#]+)\.jsonp([?#].*)?$/i);
  if (!match) {
    return null;
  }

  return upgradeToHttps(`${match[1]}/images/${match[2]}.jpg${match[3] || ''}`);
}

function extractImageUrlFromJsonpText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }

  const unescaped = text.replace(/\\+(["'\/])/g, '$1');
  const imgUrlMatch = unescaped.match(/orig=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp))["']/i);
  if (!imgUrlMatch) {
    return null;
  }

  return upgradeToHttps(imgUrlMatch[1]);
}

function upgradeToHttps(url) {
  if (typeof url !== 'string') {
    return url;
  }
  return url.replace(/^http:\/\//i, 'https://');
}

function pickExtension(url) {
  const m = String(url || '').match(/\.(jpe?g|png|webp)(?:\?|#|$)/i);
  if (!m) {
    return 'jpg';
  }
  const ext = m[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

function extractPageNumber(url, fallbackIndex) {
  if (typeof url === 'string') {
    const match = url.match(/pages\/(\d+)-/);
    if (match) {
      return parseInt(match[1], 10);
    }
    const imageMatch = url.match(/images\/(\d+)-/);
    if (imageMatch) {
      return parseInt(imageMatch[1], 10);
    }
    const numMatch = url.match(/(\d+)(?:\D*$)/);
    if (numMatch) {
      return parseInt(numMatch[1], 10);
    }
  }
  return fallbackIndex;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    shouldAcceptResolveCount,
    uniqueImagesByPageNumber,
    extractPageNumber,
    isDirectImageUrl,
    isScribdJsonpPageUrl,
    imageUrlFromJsonpPageUrl,
    extractImageUrlFromJsonpText,
    parseScribdJsonpPage,
    buildFontUrlsForPage,
    upgradeToHttps,
    pickExtension,
    isJpegBytes,
    parseJpegSize,
    buildPdfFromJpegs,
    uint8ToBase64
  };
}
