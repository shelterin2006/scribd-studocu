// Popup script
let currentTabId = null;
let currentWindowId = null;
let totalPages = 0;
let autoDownloadStarted = false;
let currentDocId = null;
let currentSite = 'scribd';
let studocuState = null;
let studocuDownloading = false;
let activeStudocuJobId = null;
let pendingStudocuStart = null;
let studocuCanCancel = true;
let studocuMessageVersion = 0;
let studocuPreference = 'auto';
let studocuScanning = false;
let studocuScanRequested = false;
let studocuScanTicket = 0;
let studocuInspectionVersion = 0;
let studocuJobMode = null;
let studocuScanCancelled = false;
let studocuTask = null;
let studocuTaskLog = '';
let clearingCache = false, cacheBackendBusy = false, scribdBusy = false, cacheStatusVersion = 0, cacheEpoch = 0;
let ignoreScribdScanEvents = false, ignoreScribdDownloadEvents = false;
const clearedStudocuTasks = new Set();
let documentActivity = null, documentActivityLive = false, scribdStartPending = false, activityResetAt = 0;

function activityIdentity() { return { site: currentSite, docId: currentDocId, tabId: currentTabId }; }
function activityStorageKey() { return `documentActivity:${currentSite}:${currentTabId}:${currentDocId}`; }

function applyDocumentActivity(state, live = true) {
  if (clearingCache || !state?.logs || state.site !== currentSite || state.tabId !== currentTabId || state.docId !== currentDocId) return false;
  if (state.updatedAt < activityResetAt) return false;
  if (documentActivity && (state.revision < documentActivity.revision || (!live && documentActivityLive))) return false;
  documentActivity = state; documentActivityLive = live;
  document.getElementById('doc-id').textContent = currentDocId;
  const logEl = document.getElementById('log');
  logEl.innerHTML = '';
  if (state.droppedLogs) {
    const notice = document.createElement('div');
    notice.textContent = `… Hiển thị ${state.logs.length} dòng log gần nhất; đã lược ${state.droppedLogs} dòng cũ.`;
    logEl.appendChild(notice);
  }
  for (const log of state.logs) {
    const line = document.createElement('div');
    line.textContent = `[${new Date(log.at).toLocaleTimeString()}] ${log.message}`;
    logEl.appendChild(line);
  }
  const sync = document.createElement('div');
  sync.id = 'sync-status';
  sync.setAttribute?.('role', 'status');
  sync.textContent = live ? '' : 'Đang đồng bộ tiến độ mới nhất…';
  logEl.appendChild(sync);
  logEl.scrollTop = logEl.scrollHeight;
  resetLogStyle();
  if (state.status === 'error') setLogStyle('error');
  else if (state.fontFallbackCount || state.logs.at(-1)?.level === 'warn') setLogStyle('warn');
  if (state.status === 'idle') return false;
  if (scribdStartPending && !state.active) return true;
  if (state.active) scribdStartPending = false;
  totalPages = state.totalPages || totalPages;
  document.getElementById('total-pages').textContent = totalPages || 'Đang tìm…';
  if (currentSite === 'studocu' && state.task) {
    applyStudocuTask(state.task, true);
    if (!live) {
      document.getElementById('btn-download').disabled = true;
      document.getElementById('btn-scan').disabled = true;
    }
    return true;
  }
  if (currentSite !== 'scribd') return false;
  const scanning = state.status === 'scanning', collected = state.phase === 'scan' || ['scanning', 'ready', 'cancelled'].includes(state.status);
  const count = collected ? state.count || 0 : state.downloadedCount || 0;
  setScribdActivity(!!state.active || !live);
  document.getElementById('collected-label').textContent = collected ? 'Đã thu thập:' : 'Đã xử lý:';
  updateProgress(totalPages ? Math.min(100, Math.floor(count / totalPages * 100)) : 0, count);
  document.getElementById('progress-text').textContent = state.status === 'saving' ? 'Đang lưu PDF…'
    : state.status === 'interrupted' ? 'Tác vụ đã gián đoạn; có thể tải lại từ cache'
    : state.status === 'cancelled' ? `Đã dừng quét; giữ ${count}/${totalPages || '?'} trang`
    : state.status === 'error' ? 'Tải gặp lỗi: ' + (state.error || '')
    : `${state.status === 'complete' ? 'Hoàn tất' : scanning ? 'Đã thu thập' : 'Đã xử lý'} ${count}/${totalPages || '?'} trang`;
  document.getElementById('btn-download').disabled = !live || !!state.active || !(totalPages > 0 && (state.count >= totalPages || state.status === 'complete'));
  document.getElementById('btn-download').textContent = state.active && !scanning ? '⏳ Đang tải…' : '📥 Tải PDF';
  document.getElementById('btn-scan').disabled = !!state.active || !live;
  document.getElementById('btn-scan').style.display = scanning ? 'none' : 'block';
  document.getElementById('btn-scan').textContent = '🔍 Kiểm tra / Quét bổ sung';
  document.getElementById('btn-stop').style.display = scanning ? 'block' : 'none';
  document.getElementById('reader-hint').textContent = 'Tải trực tiếp không cần cuộn, tự giữ đầy đủ chữ và ảnh. Có thể đóng popup; giữ tab tài liệu mở trong lúc tải.';
  return true;
}

async function restoreDocumentActivity() {
  const identity = activityIdentity(), key = activityStorageKey(), epoch = cacheEpoch;
  const saved = chrome.storage?.local?.get?.([key]);
  saved?.then?.(values => { if (epoch === cacheEpoch && !documentActivityLive && values?.[key]) applyDocumentActivity(values[key], false); }).catch(() => {});
  try {
    const state = await chrome.runtime.sendMessage({ action: 'getDocumentActivity', ...identity });
    if (epoch !== cacheEpoch) return false;
    if (state?.error) throw Error(state.error);
    const applied = applyDocumentActivity(state, true);
    // A newer live event may already have beaten this snapshot response.
    return applied || (!!documentActivityLive && documentActivity?.status !== 'idle');
  } catch (error) {
    const sync = document.getElementById('sync-status');
    if (sync && !documentActivityLive) sync.textContent = 'Chưa đồng bộ được tiến độ. Dữ liệu hiển thị là lần lưu gần nhất.';
    return !!documentActivity;
  }
}

function updateClearCacheButton() {
  const button = document.getElementById('btn-clear-cache');
  if (button) button.disabled = !currentDocId || clearingCache || cacheBackendBusy || scribdBusy ||
    studocuDownloading || studocuScanning || !!pendingStudocuStart;
}

function setScribdActivity(active) {
  scribdBusy = active; cacheBackendBusy = active; cacheStatusVersion++;
  updateClearCacheButton();
}

async function refreshCacheStatus() {
  const version = cacheStatusVersion;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'getDocumentCacheStatus', site: currentSite, docId: currentDocId, tabId: currentTabId });
    if (version !== cacheStatusVersion) return;
    cacheBackendBusy = result?.ok === false || result?.busy === true;
  } catch (_) { if (version === cacheStatusVersion) cacheBackendBusy = true; }
  updateClearCacheButton();
}

async function clearCurrentDocumentCache() {
  if (clearingCache || cacheBackendBusy || scribdBusy || studocuDownloading || studocuScanning || pendingStudocuStart) return;
  const previousDownloadDisabled = document.getElementById('btn-download').disabled;
  const previousScanDisabled = document.getElementById('btn-scan').disabled;
  clearingCache = true; cacheStatusVersion++; cacheEpoch++; studocuInspectionVersion++; studocuMessageVersion++;
  updateClearCacheButton();
  document.getElementById('btn-download').disabled = true;
  document.getElementById('btn-scan').disabled = true;
  document.getElementById('studocu-mode').disabled = true;
  let state, cleared = false;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'clearDocumentCache', site: currentSite, docId: currentDocId, tabId: currentTabId });
    if (!result?.ok) {
      if (result?.status === 'busy') cacheBackendBusy = true;
      throw Error(result?.error || 'Không xóa được cache tài liệu.');
    }
    cleared = true;
    documentActivity = null; documentActivityLive = false; activityResetAt = Date.now();
    for (const taskId of result.clearedTaskIds || []) clearedStudocuTasks.add(taskId);
    if (studocuTask?.taskId) clearedStudocuTasks.add(studocuTask.taskId);
    studocuTask = null; studocuTaskLog = ''; studocuState = null; activeStudocuJobId = null;
    studocuScanRequested = false; studocuScanCancelled = true; autoDownloadStarted = false;
    ignoreScribdScanEvents = true; ignoreScribdDownloadEvents = true;
    cacheBackendBusy = false;
    clearLog(); resetLogStyle();
    state = await restoreScanState();
    addLog('✅ Đã xóa cache tài liệu này. Dữ liệu trên tab được đọc lại từ đầu; PDF đã tải và tài liệu khác vẫn được giữ.');
  } catch (error) {
    setLogStyle('error'); addLog('❌ ' + error.message);
  } finally {
    clearingCache = false;
    if (currentSite === 'studocu') setStudocuBusy(studocuDownloading);
    else {
      document.getElementById('btn-scan').disabled = scribdBusy || (!cleared && previousScanDisabled);
      document.getElementById('btn-download').disabled = scribdBusy || (state ? !state.complete : cleared || previousDownloadDisabled);
    }
    document.getElementById('studocu-mode').disabled = studocuDownloading || studocuScanning;
    updateClearCacheButton();
  }
}

function setLogStyle(style) {
  const logEl = document.getElementById('log');
  if (!logEl) return;
  logEl.classList.remove('log-warn', 'log-error');
  if (style === 'warn') logEl.classList.add('log-warn');
  if (style === 'error') logEl.classList.add('log-error');
}

function resetLogStyle() {
  setLogStyle(null);
}

function isMissingContentScriptError(error) {
  return error && (
    error.message.includes('Receiving end does not exist') ||
    error.message.includes('Could not establish connection')
  );
}

function injectContentScript(callback) {
  chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    files: ['studocu.js', 'content.js']
  }, () => {
    callback(chrome.runtime.lastError || null);
  });
}

function sendContentMessage(message, callback, retry = true) {
  chrome.tabs.sendMessage(currentTabId, message, (response) => {
    const error = chrome.runtime.lastError;
    if (!error) {
      callback(response, null);
      return;
    }

    if (!retry || !isMissingContentScriptError(error)) {
      callback(null, error);
      return;
    }

    injectContentScript((injectError) => {
      if (injectError) {
        callback(null, injectError);
        return;
      }

      sendContentMessage(message, callback, false);
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  currentWindowId = tab.windowId;

  document.getElementById('btn-scan').addEventListener('click', startScan);
  document.getElementById('btn-download').addEventListener('click', downloadPDF);
  document.getElementById('btn-stop').addEventListener('click', stopScan);
  document.getElementById('btn-clear-cache').addEventListener('click', clearCurrentDocumentCache);

  const studocuId = typeof StudocuSupport !== 'undefined' && StudocuSupport.getDocumentId(tab.url);
  let scribdId = null;
  try {
    const url = new URL(tab.url);
    if (url.protocol === 'https:' && url.hostname === 'www.scribd.com') {
      scribdId = (url.pathname.match(/^\/document\/(\d+)/) || [])[1] || null;
    }
  } catch (_) {}
  if (studocuId || scribdId) {
    currentSite = studocuId ? 'studocu' : 'scribd';
    currentDocId = studocuId || scribdId;
    document.getElementById('doc-id').textContent = currentDocId;
    if (currentSite === 'studocu') {
      const key = 'studocuMode:' + currentDocId;
      try {
        const saved = await chrome.storage?.local?.get?.([key]);
        if (['auto', 'html', 'images'].includes(saved?.[key])) studocuPreference = saved[key];
      } catch (_) {}
      document.getElementById('studocu-options').style.display = 'block';
      document.getElementById('studocu-mode').value = studocuPreference;
      document.getElementById('studocu-mode').addEventListener('change', changeStudocuMode);
    }
    document.getElementById('status-not-ready').style.display = 'none';
    document.getElementById('status-ready').style.display = 'block';
    const restored = await restoreDocumentActivity();
    if (!restored) await getDocumentInfo();
    await refreshCacheStatus();
  } else {
    document.getElementById('status-not-ready').style.display = 'block';
    document.getElementById('status-ready').style.display = 'none';
  }

});

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.site && request.site !== currentSite) return;
  if (sender && sender.tab && currentTabId !== null && sender.tab.id !== currentTabId) return;
  if (request.docId && currentDocId && request.docId !== currentDocId) return;
  if (request.tabId !== undefined && request.tabId !== currentTabId) return;
  if (clearingCache || (request.taskId && clearedStudocuTasks.has(request.taskId))) return;
  if (request.action === 'documentActivityUpdated') { applyDocumentActivity(request); return; }
  if (currentSite === 'scribd' && request.action.startsWith('download') && request.taskId) return;
  if (currentSite === 'scribd') {
    if (request.action.startsWith('download')) {
      if (ignoreScribdDownloadEvents) return;
      if (request.action === 'downloadProgress') setScribdActivity(true);
      if (['downloadComplete', 'downloadError'].includes(request.action)) setScribdActivity(false);
    }
    if (request.action.startsWith('scan') && ignoreScribdScanEvents) return;
    if (request.action.startsWith('scan') && documentActivityLive && ['downloading', 'saving', 'complete'].includes(documentActivity?.status)) return;
  }
  if (request.site === 'studocu' && request.action === 'studocuTaskUpdated') {
    studocuMessageVersion++; applyStudocuTask(request); return;
  }
  if (request.site === 'studocu' && ['images', 'html'].includes(request.mode) && request.action.startsWith('download')) {
    if (request.taskId) return; // Managed jobs publish durable task updates.
    handleStudocuDownloadMessage(request); return;
  }
  if (request.site === 'studocu' && request.mode === 'html' && ['scanProgress', 'scanComplete', 'scanError'].includes(request.action)) {
    return; // The background owns scan completion and the PDF handoff.
  }
  switch (request.action) {
    case 'downloadProgress':
      document.getElementById('collected-label').textContent = 'Đã xử lý:';
      updateProgress(request.percent, request.current);
      document.getElementById('progress-text').textContent = request.phase === 'saving' ? 'Đang lưu PDF…' : `${request.current}/${request.total} trang (${request.percent}%)`;
      addLog(`Đã xử lý ${request.current}/${request.total} trang`);
      break;
    case 'downloadComplete':
    case 'downloadError':
      scribdStartPending = false;
      document.getElementById('btn-download').disabled = false;
      document.getElementById('btn-download').textContent = '📥 Tải PDF';
      if (request.action === 'downloadComplete') {
        updateProgress(100, request.pdfPages ?? request.totalPages);
        addLog('✅ Hoàn tất: PDF đã được tạo và tải xuống.');
        showStudocuFontWarning(request.fontFallbackCount);
      } else { setLogStyle('error'); addLog('❌ ' + request.error); }
      break;
    case 'scanProgress':
      if (currentSite === 'scribd') setScribdActivity(true);
      updateProgress(request.progress, request.collected);
      break;
    case 'newUrlCollected':
      updateCollectedCount(request.count);
      addLog(`✓ Thu thập URL ứng viên mới (${request.count} tổng)`);
      break;
    case 'scanComplete':
      if (request.totalPages > 0) {
        totalPages = request.totalPages;
        document.getElementById('total-pages').textContent = totalPages;
      }
      onScanComplete(request.urls, request.count, request.complete);
      break;
    case 'scanError':
      if (currentSite === 'scribd') setScribdActivity(false);
      document.getElementById('btn-scan').disabled = false;
      document.getElementById('btn-scan').style.display = 'block';
      document.getElementById('btn-stop').style.display = 'none';
      setLogStyle('error');
      addLog('❌ Không hoàn tất quét: ' + request.error);
      break;
  }
});

async function getDocumentInfo() {
  try {
    const response = await new Promise((resolve, reject) => {
      sendContentMessage({ action: 'getDocInfo', preference: currentSite === 'studocu' ? studocuPreference : undefined }, (info, error) => error ? reject(error) : resolve(info));
    });
    if (documentActivityLive && documentActivity?.active) return;
    if (response) {
      currentDocId = response.docId || currentDocId;
      document.getElementById('doc-id').textContent = response.docId || 'Không xác định';
      totalPages = response.totalPages || 0;
      document.getElementById('total-pages').textContent = totalPages || 'Đang tìm...';
    }
    await restoreScanState();
  } catch (error) {
    setLogStyle('warn');
    addLog('⚠ Không đọc được kết quả quét đã lưu: ' + error.message);
  }
}

function requestScanState() {
  return new Promise((resolve, reject) => {
    sendContentMessage({ action: 'getScanState', preference: currentSite === 'studocu' ? studocuPreference : undefined }, (state, error) => {
      if (error || !state || (state.error && !['images', 'html'].includes(state.mode))) {
        reject(error || new Error((state && state.error) || 'Không đọc được trạng thái tài liệu.'));
        return;
      }
      if (state.docId !== currentDocId || (state.site && state.site !== currentSite)) {
        reject(new Error('Tab đã chuyển sang tài liệu khác. Hãy mở lại popup.'));
        return;
      }
      resolve(state);
    });
  });
}

async function restoreScanState() {
  const inspection = ++studocuInspectionVersion;
  const messageVersion = studocuMessageVersion;
  const state = await requestScanState();
  if (currentSite === 'scribd' && documentActivityLive && ['downloading', 'saving', 'complete'].includes(documentActivity?.status)) return state;
  if (inspection !== studocuInspectionVersion || messageVersion !== studocuMessageVersion) return { ...state, stale: true };
  if (currentSite === 'studocu' && ['images', 'html'].includes(state.mode)) {
    studocuState = state;
    studocuScanning = !!state.isScanning;
    if (studocuScanning) { studocuScanRequested = true; studocuScanCancelled = false; }
    totalPages = state.totalPages || 0;
    document.getElementById('total-pages').textContent = totalPages || 'Chưa xác định';
    showStudocuMode(state);
    const task = await chrome.runtime.sendMessage({ action: 'getStudocuTask', docId: currentDocId, tabId: currentTabId }) || {};
    // Live job events can arrive while this snapshot response is in flight.
    if (messageVersion !== studocuMessageVersion || inspection !== studocuInspectionVersion) return state;
    if (task.status === 'error' && !task.taskId) throw Error(task.error);
    if (task.taskId && (task.active || task.mode === state.mode)) { applyStudocuTask(task); return state; }
    const job = { active: false };
    activeStudocuJobId = job.jobId || null;
    studocuJobMode = job.active ? job.mode || state.mode : null;
    studocuCanCancel = job.cancellable !== false;
    setStudocuBusy(!!job.active);
    const full = state.mode === 'html';
    const showJob = job.active || (job.status === 'complete' && job.mode === state.mode);
    const count = showJob ? job.downloadedCount || 0 : full ? state.count : 0;
    document.getElementById('collected-label').textContent = full && !showJob ? 'Đã thu thập:' : 'Đã tải:';
    updateProgress(totalPages ? Math.floor(count / totalPages * 100) : 0, count);
    if (job.active) {
      const unit = studocuJobMode === 'html' ? 'trang' : 'ảnh';
      document.getElementById('progress-text').textContent = job.status === 'saving' ? 'Đang lưu PDF...' : `Đã tải ${count}/${totalPages} ${unit}`;
      addLog(`📥 Đang tải ${count}/${totalPages} ${unit}. Có thể đóng popup; hãy giữ tab tài liệu mở.`);
    } else if (studocuScanning) {
      document.getElementById('progress-text').textContent = `Đang thu thập ${count}/${totalPages} trang`;
      addLog(`📜 Đang quét bổ sung ${count}/${totalPages} trang. Hãy giữ tab tài liệu mở.`);
    } else if (state.ready) {
      document.getElementById('progress-text').textContent = full ? `Sẵn sàng tải đầy đủ ${totalPages} trang` : showJob ? `Đã tải ${count}/${totalPages} ảnh` : `Sẵn sàng tải ${totalPages} ảnh`;
      addLog(full ? `✅ Đã có đủ ${state.count}/${totalPages} trang. Có thể tải PDF đầy đủ ngay.` : `✅ Sẵn sàng tải ${totalPages} ảnh trực tiếp, không cần quét hay cuộn trang.`);
    } else if (full && !state.error) {
      document.getElementById('progress-text').textContent = `Đã thu thập ${count}/${totalPages || '?'} trang`;
      addLog(`📜 Cần thu đủ ${totalPages || '?'} trang để giữ chữ và ảnh. Nhấn Quét bổ sung để lấy các trang còn thiếu.`);
    } else {
      document.getElementById('progress-text').textContent = 'Nguồn tài liệu chưa sẵn sàng';
      setLogStyle('warn'); addLog('⚠ ' + (state.error || 'Chưa có đủ thông tin tài liệu. Hãy tải lại tab rồi kiểm tra lại.'));
    }
    if (job.error) { setLogStyle('error'); addLog('❌ ' + job.error); }
    showStudocuFontWarning(job.fontFallbackCount);
    if (state.cacheWarning) addLog('⚠ ' + state.cacheWarning);
    return state;
  }
  totalPages = state.totalPages || 0;
  scribdBusy = !!state.isScanning; updateClearCacheButton();
  document.getElementById('reader-hint').textContent = state.complete
    ? 'Tải trực tiếp không cần cuộn, tự giữ đầy đủ chữ và ảnh. Giữ tab tài liệu mở trong lúc tải.'
    : 'Chỉ cuộn bổ sung các trang còn thiếu địa chỉ. Giữ tab tài liệu mở trong lúc quét và tải.';
  document.getElementById('collected-label').textContent = 'URL trang:';
  document.getElementById('total-pages').textContent = totalPages || 'Chưa xác định';
  const percent = state.complete ? 100 : totalPages > 0 ? Math.min(99, Math.round(state.count / totalPages * 100)) : 0;
  updateProgress(percent, state.count);
  document.getElementById('btn-download').disabled = !state.complete || state.isScanning;
  document.getElementById('btn-scan').disabled = !!state.isScanning;
  document.getElementById('btn-scan').style.display = state.isScanning ? 'none' : 'block';
  document.getElementById('btn-stop').style.display = state.isScanning ? 'block' : 'none';
  document.getElementById('btn-scan').textContent = '🔍 Kiểm tra / Quét bổ sung';
  if (state.cacheWarning) addLog('⚠ ' + state.cacheWarning);
  if (state.complete && !state.isScanning) {
    resetLogStyle();
    addLog(`✅ Có đủ địa chỉ ${state.count}/${totalPages} trang. Tải nhanh không cần cuộn; tự giữ chữ và ảnh nếu có.`);
  } else if (state.count) {
    addLog(`ℹ Đã giữ ${state.count}/${totalPages || '?'} trang. ${state.isScanning ? 'Đang quét bổ sung...' : 'Quét bổ sung để lấy các trang còn thiếu.'}`);
  }
  return state;
}

async function startScan() {
  if (clearingCache || (currentSite === 'scribd' && scribdBusy)) return;
  if (currentSite === 'studocu') {
    clearLog(); resetLogStyle();
    if (studocuDownloading || studocuScanning) return;
    if (studocuState?.mode !== 'html') {
      try { await restoreScanState(); } catch (error) { setLogStyle('error'); addLog('❌ ' + error.message); }
      return;
    }
    return downloadStudocuDocument(true);
  }
  const btnScan = document.getElementById('btn-scan');
  scribdStartPending = true;
  ignoreScribdScanEvents = false; setScribdActivity(true);
  const btnStop = document.getElementById('btn-stop');
  const btnDownload = document.getElementById('btn-download');

  btnScan.disabled = true;
  btnScan.style.display = 'none';
  btnStop.style.display = 'block';
  btnDownload.disabled = true;
  autoDownloadStarted = false;

  clearLog();
  resetLogStyle();
  addLog('🚀 Bắt đầu quét trang...');
  addLog('🔍 Kiểm tra kết quả đã lưu và nội dung đang có trên tab...');
  addLog('📜 Chỉ cuộn bổ sung khi còn thiếu trang.');

  sendContentMessage({
    action: 'startScan',
    totalPages: totalPages
  }, (response, error) => {
    if (error) {
      scribdStartPending = false;
      setScribdActivity(false);
      btnScan.disabled = false;
      btnScan.style.display = 'block';
      btnStop.style.display = 'none';
      btnDownload.disabled = true;
      setLogStyle('error');
      addLog('❌ Không kết nối được content script: ' + error.message);
      addLog('ℹ Hãy reload tab tài liệu rồi thử lại nếu lỗi vẫn còn.');
      return;
    }

    if (response && response.status === 'started') {
      addLog(`📄 Số trang dự kiến (nếu có): ${response.totalPages}`);
    }
  });
}

function stopScan() {
  if (currentSite === 'studocu' && ['images', 'html'].includes(studocuState?.mode)) {
    studocuInspectionVersion++;
    if (pendingStudocuStart) {
      pendingStudocuStart.cancelled = true;
      if (!pendingStudocuStart.sent) {
        pendingStudocuStart = null; studocuScanning = false; setStudocuBusy(false);
        addLog('⏹ Đã dừng trước khi bắt đầu tác vụ.'); return Promise.resolve();
      }
    }
    if (!studocuCanCancel) return Promise.resolve();
    document.getElementById('btn-stop').disabled = true;
    return chrome.runtime.sendMessage({ action: 'stopStudocuTask', docId: currentDocId, tabId: currentTabId, taskId: studocuTask?.taskId }).then(state => {
      if (state?.taskId) { applyStudocuTask(state); return; }
      if (state?.cancellable === false && state.active) {
        studocuCanCancel = false;
        document.getElementById('progress-text').textContent = 'Đang lưu PDF...';
      }
    }).catch(error => {
      document.getElementById('btn-stop').disabled = false; setLogStyle('error'); addLog('❌ Không dừng được lượt tải: ' + error.message);
    });
  }
  sendContentMessage({ action: 'stopScan' }, () => {});
  setScribdActivity(false);

  document.getElementById('btn-scan').disabled = false;
  document.getElementById('btn-scan').style.display = 'block';
  document.getElementById('btn-stop').style.display = 'none';

  addLog('⏹ Đã dừng quét');
}

function updateProgress(progress, collected) {
  document.getElementById('progress-fill').style.width = progress + '%';
  document.getElementById('progress-text').textContent = Math.round(progress) + '%';
  document.getElementById('collected-pages').textContent = collected;
}

function updateCollectedCount(count) {
  document.getElementById('collected-pages').textContent = count;
}

function onScanComplete(urls, count, complete) {
  if (currentSite === 'scribd') setScribdActivity(false);
  document.getElementById('btn-scan').disabled = false;
  document.getElementById('btn-scan').style.display = 'block';
  document.getElementById('btn-stop').style.display = 'none';

  document.getElementById('progress-fill').style.width = '100%';
  document.getElementById('progress-text').textContent = '100%';
  document.getElementById('collected-pages').textContent = count;

  if (!(totalPages > 0)) {
    document.getElementById('btn-download').disabled = true;
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').textContent = `${count}/? trang`;
    setLogStyle('warn');
    addLog(`⚠ Đã giữ ${count} URL ứng viên nhưng chưa xác định tổng số trang. Chưa thể xác nhận tài liệu đã đủ.`);
    return;
  }

  if (!count || count === 0) {
    document.getElementById('btn-download').disabled = true;
    setLogStyle('error');
    addLog('⚠ Quét hoàn tất nhưng không tìm thấy URL ứng viên nào sau khi scroll (0 URL).');
    addLog('ℹ Hãy thử cuộn trang thủ công rồi nhấn "Quét" lại.');
    return;
  }

  if (complete === false || count < totalPages) {
    document.getElementById('btn-download').disabled = true;
    const percent = Math.round(count / totalPages * 100);
    document.getElementById('progress-fill').style.width = percent + '%';
    document.getElementById('progress-text').textContent = `${count}/${totalPages} trang`;
    setLogStyle('warn');
    addLog(`⚠ Mới thu thập được ${count}/${totalPages} trang. Chưa tạo PDF vì tài liệu còn thiếu trang.`);
    addLog('ℹ Hãy chờ nội dung tải xong rồi quét lại.');
    return;
  }

  document.getElementById('btn-download').disabled = false;
  resetLogStyle();
  addLog(currentSite === 'studocu' ? `✅ Đã thu thập đủ ${count}/${totalPages} trang Studocu.` : `✅ Quét hoàn tất! Tìm thấy ${count} URL ứng viên sau khi scroll.`);
  if (currentSite !== 'studocu') addLog('ℹ Con số này là số URL ứng viên, có thể nhiều hơn số trang thật.');
  addLog('📥 Đang tự động chuyển sang bước 2: tải PDF...');

  if (currentSite === 'studocu') {
    if (!autoDownloadStarted) { autoDownloadStarted = true; downloadPDF(); }
    return;
  }

  // Content owns the document cache. A second asynchronous legacy writer here
  // could restore deleted data and auto-download after a cache reset.
  if (!autoDownloadStarted) {
    autoDownloadStarted = true;
    downloadPDF();
  }
}

async function downloadPDF() {
  if (clearingCache || (currentSite === 'scribd' && scribdBusy)) return;
  if (currentSite === 'studocu' && ['images', 'html'].includes(studocuState?.mode)) return downloadStudocuDocument();
  scribdStartPending = true;
  ignoreScribdDownloadEvents = false; setScribdActivity(true);
  const btnDownload = document.getElementById('btn-download');
  btnDownload.disabled = true;
  btnDownload.textContent = '⏳ Đang tải...';

  addLog(currentSite === 'studocu' ? '📥 Bắt đầu dựng tài liệu Studocu thành PDF...' : '📥 Đang tải nhanh Scribd, tự giữ đầy đủ chữ và ảnh...');

  let data;
  try {
    data = await requestScanState();
  } catch (error) {
    scribdStartPending = false;
    setScribdActivity(false);
    setLogStyle('error');
    addLog('❌ ' + error.message);
    btnDownload.disabled = false;
    btnDownload.textContent = '📥 Bước 2: Tải PDF';
    return;
  }
  const urls = data.urls || [];
  const docId = data.docId;
  const expectedPages = data.totalPages || 0;

  if (data.isScanning || !data.complete) {
    scribdStartPending = false;
    setScribdActivity(!!data.isScanning);
    setLogStyle('warn');
    addLog(`⚠ Hiện có ${data.count}/${expectedPages || '?'} trang. Hãy quét bổ sung trước khi tải.`);
    btnDownload.textContent = '📥 Bước 2: Tải PDF';
    return;
  }

  if (urls.length === 0 && currentSite !== 'studocu') {
    scribdStartPending = false;
    setScribdActivity(false);
    addLog('❌ Không có URL ứng viên! Hãy quét trước');
    btnDownload.disabled = false;
    btnDownload.textContent = '📥 Bước 2: Tải PDF';
    return;
  }

  document.getElementById('collected-label').textContent = 'Đã tải:';
  updateProgress(0, 0);

  const epoch = cacheEpoch;
  chrome.runtime.sendMessage({
    action: 'downloadImages', site: currentSite, urls: urls, docId: docId,
    fast: currentSite === 'scribd',
    expectedPages: expectedPages, tabId: currentTabId, windowId: currentWindowId
  }).then(result => {
    if (epoch !== cacheEpoch || clearingCache) return;
    if (result?.status === 'busy') return restoreDocumentActivity();
    if (result?.status === 'error') throw Error(result.error);
  }).catch(error => {
    if (epoch !== cacheEpoch || clearingCache) return;
    scribdStartPending = false; setScribdActivity(false);
    setLogStyle('error'); addLog('❌ ' + error.message);
    btnDownload.textContent = '📥 Tải PDF'; btnDownload.disabled = false;
  });
}

function setStudocuBusy(active) {
  studocuDownloading = active;
  if (!active) studocuCanCancel = true;
  const blocked = active || studocuScanning || clearingCache;
  document.getElementById('studocu-mode').disabled = blocked;
  document.getElementById('btn-download').disabled = blocked || !studocuState?.ready;
  document.getElementById('btn-download').textContent = active ? '⏳ Đang tải...' : studocuState?.mode === 'html' ? '📥 Tải PDF đầy đủ' : '📥 Tải PDF từ ảnh';
  document.getElementById('btn-scan').disabled = blocked;
  document.getElementById('btn-scan').style.display = blocked ? 'none' : 'block';
  document.getElementById('btn-stop').style.display = blocked ? 'block' : 'none';
  document.getElementById('btn-stop').disabled = active && !studocuCanCancel;
  updateClearCacheButton();
}

function handleStudocuDownloadMessage(request) {
  if (activeStudocuJobId && request.jobId && activeStudocuJobId !== request.jobId && request.action !== 'downloadStarted') return;
  studocuMessageVersion++;
  if (request.jobId) activeStudocuJobId = request.jobId;
  studocuJobMode = request.mode || studocuState?.mode;
  if (request.action === 'downloadStarted' || request.action === 'downloadProgress') {
    studocuCanCancel = request.cancellable !== false;
    setStudocuBusy(true);
    const count = request.current ?? request.downloadedCount ?? 0, total = request.total ?? request.totalPages ?? totalPages;
    updateProgress(total ? Math.floor(count / total * 100) : 0, count);
    const unit = studocuJobMode === 'html' ? 'trang' : 'ảnh';
    document.getElementById('collected-label').textContent = 'Đã tải:';
    document.getElementById('progress-text').textContent = request.phase === 'saving' ? 'Đang lưu PDF...' : request.phase === 'pdf' ? 'Đang ghép PDF...' : `Đã tải ${count}/${total} ${unit}`;
    if (request.action === 'downloadProgress' && ['images', 'pages'].includes(request.phase)) addLog(`📥 Đã tải ${count}/${total} ${unit}`);
    return;
  }
  setStudocuBusy(false);
  if (request.action === 'downloadComplete') {
    const count = request.resolvedCount ?? request.totalPages;
    updateProgress(100, count);
    document.getElementById('progress-text').textContent = `Đã tải ${count}/${count} ${studocuJobMode === 'html' ? 'trang' : 'ảnh'}`;
    resetLogStyle(); addLog(studocuJobMode === 'html' ? `✅ Đã tạo PDF đầy đủ ${count}/${count} trang, gồm chữ và ảnh.` : `✅ Đã tải ${count}/${count} ảnh và tạo PDF đủ ${count} trang.`);
    showStudocuFontWarning(request.fontFallbackCount);
  } else if (request.action === 'downloadCancelled') {
    addLog('⏹ Đã dừng tải. Chưa xuất PDF.');
  } else if (request.action === 'downloadError') {
    setLogStyle('error'); addLog('❌ ' + request.error);
  }
}

function showStudocuFontWarning(count) {
  if (!(count > 0)) return;
  setLogStyle('warn');
  addLog(`⚠ ${count} font gốc không tải hoặc không giải mã được; dùng font dự phòng của tài liệu. Kiểu chữ và khoảng cách có thể khác bản gốc.`);
}

async function downloadStudocuDocument(allowScan = false) {
  if (clearingCache || studocuDownloading || studocuScanning) return;
  studocuInspectionVersion++;
  const start = { cancelled: false, sent: false };
  pendingStudocuStart = start;
  activeStudocuJobId = null;
  // A completed earlier task may have left its non-cancellable save state in
  // the popup.  A new request is cancellable as soon as it is queued.
  studocuCanCancel = true;
  setStudocuBusy(true); resetLogStyle();
  try {
    const state = await requestScanState();
    if (start.cancelled) return;
    studocuState = state;
    showStudocuMode(state);
    if (!state.ready && !(allowScan && state.mode === 'html' && !state.error)) throw new Error(state.error || (state.mode === 'html' ? 'Chưa thu đủ trang. Hãy quét bổ sung trước khi tải đầy đủ.' : 'Nguồn ảnh chưa sẵn sàng. Hãy kiểm tra lại.'));
    totalPages = state.totalPages;
    updateProgress(0, 0);
    addLog('📜 Giao tác vụ cho background. Có thể đóng popup; giữ tab tài liệu mở.');
    start.sent = true;
    const response = await chrome.runtime.sendMessage({ action: 'startStudocuTask', preference: studocuPreference, docId: currentDocId, tabId: currentTabId });
    if (start.cancelled) {
      if (response?.taskId) applyStudocuTask(await chrome.runtime.sendMessage({ action: 'stopStudocuTask', docId: currentDocId, tabId: currentTabId, taskId: response.taskId }));
      return;
    }
    pendingStudocuStart = null;
    if (!response?.taskId || response.error || response.docId !== currentDocId) throw Error(response?.error || 'Không bắt đầu được tác vụ Studocu.');
    applyStudocuTask(response.status === 'busy' ? { ...response, status: response.mode === 'html' && response.downloadedCount === 0 ? 'scanning' : 'downloading' } : response);
  } catch (error) {
    if (start.cancelled) return;
    pendingStudocuStart = null; setStudocuBusy(false); setLogStyle('error'); addLog('❌ ' + error.message);
  }
}

function showStudocuMode(state) {
  const full = state.mode === 'html';
  document.getElementById('mode-description').textContent = studocuPreference === 'auto'
    ? `Tự chọn: ${full ? 'Đầy đủ (chữ + ảnh)' : 'Chỉ ảnh'}. ${state.detection?.reason || ''}`
    : full ? 'Giữ chữ, hình và công thức. Chỉ cuộn bổ sung khi còn thiếu trang.' : 'Chỉ ghép ảnh nền để tải nhanh; chữ nằm riêng trên web sẽ không được ghép.';
  document.getElementById('reader-hint').textContent = full
    ? 'Có thể đóng popup hoặc đổi tab. Nếu Studocu ngừng nạp nội dung ở nền, tác vụ tự tiếp tục khi bạn quay lại tab. Giữ tab tài liệu mở.'
    : 'Tải ảnh trực tiếp, không cần cuộn. Giữ tab mở trong lúc tải; PDF chỉ gồm ảnh nền.';
  document.getElementById('btn-scan').textContent = full ? '🔍 Quét bổ sung các trang còn thiếu' : '🔍 Kiểm tra lại nguồn ảnh';
}

async function changeStudocuMode() {
  const select = document.getElementById('studocu-mode');
  if (studocuDownloading || studocuScanning) { select.value = studocuPreference; return; }
  studocuPreference = ['auto', 'html', 'images'].includes(select.value) ? select.value : 'auto';
  select.value = studocuPreference;
  studocuInspectionVersion++; studocuScanTicket++; studocuScanRequested = false; studocuScanCancelled = true;
  document.getElementById('btn-download').disabled = true; document.getElementById('btn-scan').disabled = true; select.disabled = true;
  try {
    try { await chrome.storage.local.set({ ['studocuMode:' + currentDocId]: studocuPreference }); }
    catch (_) { addLog('⚠ Không lưu được lựa chọn chế độ. Lựa chọn vẫn áp dụng trong popup này.'); }
    clearLog(); resetLogStyle(); await restoreScanState();
  } catch (error) { setLogStyle('error'); addLog('❌ ' + error.message); }
  finally { select.disabled = studocuDownloading || studocuScanning; document.getElementById('btn-scan').disabled = studocuDownloading || studocuScanning; }
}

function applyStudocuTask(task, restored = false) {
  if (clearingCache || clearedStudocuTasks.has(task?.taskId)) return;
  if (!task?.taskId || task.docId !== currentDocId || task.tabId !== currentTabId) return;
  if (studocuTask && ((task.taskId === studocuTask.taskId && (task.revision || 0) < (studocuTask.revision || 0)) ||
      (task.taskId !== studocuTask.taskId && task.startedAt < studocuTask.startedAt))) return;
  studocuTask = task;
  cacheBackendBusy = !!task.active; cacheStatusVersion++;
  const scanning = ['starting', 'scanning', 'waiting_foreground'].includes(task.status);
  studocuScanning = task.active && scanning; studocuCanCancel = task.cancellable !== false;
  totalPages = task.totalPages || totalPages;
  const mode = task.mode || studocuState?.mode || 'html';
  studocuState = { ...studocuState, mode, totalPages, count: task.count || 0,
    ready: mode === 'html' ? task.count === totalPages : studocuState?.ready };
  showStudocuMode(studocuState); setStudocuBusy(!!task.active && !scanning);
  const count = scanning || ['incomplete', 'cancelled', 'interrupted'].includes(task.status) ? task.count || 0 : task.downloadedCount || 0;
  document.getElementById('total-pages').textContent = totalPages || 'Đang tìm...';
  document.getElementById('collected-label').textContent = scanning || task.status === 'incomplete' ? 'Đã thu thập:' : 'Đã tải:';
  updateProgress(totalPages ? Math.floor(count / totalPages * 100) : 0, count);
  const text = { starting: 'Đang bắt đầu tác vụ...', scanning: `Đang thu thập ${count}/${totalPages} trang`,
    waiting_foreground: 'Đang chờ — tự tiếp tục khi bạn quay lại tab tài liệu', downloading: `Đã tải ${count}/${totalPages} ${mode === 'html' ? 'trang' : 'ảnh'}`,
    saving: 'Đang lưu PDF...', complete: `Đã tải ${count}/${totalPages} ${mode === 'html' ? 'trang' : 'ảnh'}`,
    incomplete: `Còn thiếu ${task.missingPages?.length || totalPages - count} trang — cần quét bổ sung`, cancelled: 'Đã dừng tác vụ; giữ lại các trang đã thu thập',
    interrupted: 'Tác vụ đã gián đoạn; có thể tiếp tục từ cache', error: task.error || 'Tác vụ gặp lỗi' }[task.status] || task.status;
  document.getElementById('progress-text').textContent = text;
  const logKey = [task.taskId, task.status, count, task.fontFallbackCount].join(':');
  if (restored || documentActivity?.taskId === task.taskId) { studocuTaskLog = logKey; return; }
  if (logKey !== studocuTaskLog) {
    studocuTaskLog = logKey; resetLogStyle();
    if (task.status === 'error') setLogStyle('error');
    else if (['waiting_foreground', 'incomplete', 'interrupted'].includes(task.status)) setLogStyle('warn');
    addLog(`[${task.taskId}] ${task.status === 'complete' ? '✅ ' : ''}${text}`);
    if (task.error && task.status !== 'error') addLog('⚠ ' + task.error);
    if (task.status === 'incomplete') addLog('Trang còn thiếu: ' + (task.missingPages || []).join(', '));
    if (task.status === 'complete') showStudocuFontWarning(task.fontFallbackCount);
  }
}

function addLog(message) {
  const logEl = document.getElementById('log');
  const timestamp = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.textContent = `[${timestamp}] ${message}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  if (currentDocId && currentTabId !== null && !clearingCache) {
    const level = message.includes('❌') ? 'error' : message.includes('⚠') ? 'warn' : 'info';
    chrome.runtime.sendMessage({ action: 'appendDocumentLog', ...activityIdentity(), message, level }).catch(() => {});
  }
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
}
