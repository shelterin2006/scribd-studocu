// Durable Studocu orchestration. Renderers and document caches stay in their
// existing owners; a popup is only a client of this coordinator.
const StudocuTasks = (() => {
  const activeStatuses = new Set(['starting', 'scanning', 'waiting_foreground', 'downloading', 'saving']);
  function create({ chrome: api, support, sendContent, startDownload, stopDownload, downloadState, onUpdate, now = Date.now }) {
    const tasks = new Map(), locks = new Map(), clearing = new Set();
    let sequence = 0;
    const active = task => !!task && activeStatuses.has(task.status);
    const view = task => {
      if (!task) return { active: false };
      const job = downloadState(task.tabId);
      return { ...task, site: 'studocu', active: active(task), cancellable: active(task) && task.status !== 'saving' &&
        !(job?.active && job.taskId === task.taskId && job.cancellable === false) };
    };
    function serial(tabId, operation) {
      const result = (locks.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
      locks.set(tabId, result); result.finally(() => { if (locks.get(tabId) === result) locks.delete(tabId); }).catch(() => {});
      return result;
    }
    async function persist(task) {
      task.revision = (task.revision || 0) + 1;
      task.updatedAt = now();
      const previous = task.history?.at(-1);
      if (!previous || previous.status !== task.status || previous.count !== task.count || previous.downloadedCount !== task.downloadedCount) {
        task.history = [...(task.history || []), { at: task.updatedAt, status: task.status, count: task.count, downloadedCount: task.downloadedCount }].slice(-40);
      }
      await api.storage.local.set({ ['studocuTask:' + task.tabId]: { ...task } });
      await onUpdate?.(view(task));
      publish(task);
    }
    function publish(task) {
      const message = api.runtime.sendMessage({ action: 'studocuTaskUpdated', ...view(task) });
      message?.catch?.(() => {});
    }
    const current = task => !!task && tasks.get(task.tabId) === task && active(task);
    function validateState(task, state, requireTask = false) {
      if (!state || state.docId !== task.docId || state.error ||
          (task.assetId && state.assetId !== task.assetId) ||
          (task.totalPages && state.totalPages !== task.totalPages) ||
          (requireTask && state.taskId !== task.taskId)) throw Error(state?.error || 'Trình xem hoặc tài liệu đã thay đổi.');
    }
    async function fail(task, error) {
      await serial(task.tabId, async () => {
        if (!current(task)) return;
        task.status = 'error'; task.error = error.message;
        await persist(task);
      });
    }
    async function runDownload(task) {
      if (!current(task) || task.status !== 'downloading') return;
      try {
        const result = await startDownload({ tabId: task.tabId, docId: task.docId, taskId: task.taskId,
          mode: task.mode, preference: task.preference, expectedPages: task.totalPages });
        await serial(task.tabId, async () => {
          if (!current(task)) return;
          if (result?.status === 'finished') {
            task.status = 'complete'; task.downloadedCount = task.totalPages;
            task.fontFallbackCount = downloadState(task.tabId)?.fontFallbackCount || 0;
          } else { task.status = result?.status === 'cancelled' ? 'cancelled' : 'error'; task.error = result?.error || 'Không hoàn tất tải PDF.'; }
          await persist(task);
        });
      } catch (error) { await fail(task, error); }
    }
    async function advance(task, requireTask = true) {
      try {
        const state = await sendContent(task.tabId, { action: 'getScanState', mode: task.mode, docId: task.docId });
        const launch = await serial(task.tabId, async () => {
          if (!current(task) || !['starting', 'scanning', 'waiting_foreground'].includes(task.status)) return false;
          validateState(task, state, requireTask);
          if (state.isScanning || !(task.mode === 'html' ? state.complete : state.ready)) throw Error('Tài liệu chưa đủ trang để tải PDF.');
          task.status = 'downloading'; task.count = state.count; task.missingPages = [];
          await persist(task); return true;
        });
        if (launch) void runDownload(task).catch(error => console.error('Studocu task:', error.message));
      } catch (error) { await fail(task, error); }
    }
    async function drive(task) {
      try {
        const state = await sendContent(task.tabId, { action: 'getScanState', preference: task.preference, docId: task.docId });
        const command = await serial(task.tabId, async () => {
          if (!current(task)) return null;
          validateState(task, state);
          if (!Number.isSafeInteger(state.totalPages) || state.totalPages < 1 || state.totalPages > 10000 ||
              !state.assetId || !['html', 'images'].includes(state.mode)) throw Error('Chưa xác định được đầy đủ tài liệu Studocu.');
          if (state.isScanning) throw Error('Tab đang có một lượt quét khác. Hãy dừng lượt đó trước.');
          task.mode = state.mode; task.assetId = state.assetId; task.totalPages = state.totalPages;
          task.count = state.mode === 'html' ? state.count : 0; task.missingPages = state.missingPages || [];
          if (state.ready || (state.mode === 'html' && state.complete)) { await persist(task); return 'download'; }
          if (state.mode !== 'html') throw Error(state.error || 'Nguồn ảnh chưa sẵn sàng.');
          task.status = 'scanning'; await persist(task); return 'scan';
        });
        if (!current(task)) return;
        if (command === 'download') return advance(task, false);
        if (command === 'scan') {
          const response = await sendContent(task.tabId, { action: 'startScan', preference: task.mode, docId: task.docId, taskId: task.taskId });
          if (!current(task)) return;
          if (response?.status === 'error' || response?.taskId !== task.taskId) throw Error(response?.error || 'Lượt quét không khớp tác vụ hiện tại.');
        }
      } catch (error) { await fail(task, error); }
    }
    async function recover(task) {
      if (['downloading', 'saving'].includes(task.status)) {
        task.status = 'interrupted'; task.error = 'Lượt dựng PDF đã gián đoạn. Kiểm tra Downloads nếu đã mở hộp thoại lưu; có thể tải lại từ cache.';
        await persist(task); return;
      }
      try {
        const state = await sendContent(task.tabId, { action: 'getScanState', mode: task.mode || 'html', docId: task.docId });
        validateState(task, state, true);
        if (['cancelled', 'incomplete', 'error'].includes(state.scanStatus)) {
          task.status = state.scanStatus; task.count = state.count; task.missingPages = state.missingPages || [];
          task.error = state.error || ''; await persist(task); return;
        }
        if (state.complete && !state.isScanning) { void advance(task).catch(error => console.error(error)); return; }
        if (!state.isScanning) throw Error('Lượt quét cũ không còn chạy. Có thể quét bổ sung từ cache.');
        task.count = state.count; task.missingPages = state.missingPages || [];
        task.status = state.scanStatus === 'waiting_foreground' ? 'waiting_foreground' : 'scanning';
        await persist(task);
      } catch (error) { task.status = 'interrupted'; task.error = error.message; await persist(task); }
    }
    const ready = (async () => {
      const stored = await api.storage.local.get(null);
      for (const [key, task] of Object.entries(stored)) {
        if (!key.startsWith('studocuTask:') || !task || !Number.isSafeInteger(task.tabId) ||
            key !== 'studocuTask:' + task.tabId || typeof task.taskId !== 'string' || !/^\d+$/.test(task.docId)) continue;
        tasks.set(task.tabId, task);
      }
      for (const task of tasks.values()) if (active(task)) await recover(task);
    })();
    async function start(request) {
      await ready;
      if (!Number.isSafeInteger(request.tabId) || !/^\d+$/.test(request.docId) || !['auto', 'html', 'images'].includes(request.preference)) throw Error('Yêu cầu tác vụ Studocu không hợp lệ.');
      return serial(request.tabId, async () => {
        if (clearing.has(request.docId)) throw Error('Đang xóa cache tài liệu. Hãy thử lại sau.');
        const previous = tasks.get(request.tabId);
        if (active(previous) || downloadState(request.tabId)?.active) return { ...view(previous), status: 'busy' };
        const task = { version: 1, taskId: now() + '-' + (++sequence) + '-' + Math.random().toString(36).slice(2),
          tabId: request.tabId, docId: request.docId, preference: request.preference, mode: null, assetId: null,
          totalPages: 0, count: 0, downloadedCount: 0, status: 'starting', error: '', startedAt: now(), updatedAt: now() };
        tasks.set(task.tabId, task);
        try { await persist(task); } catch (error) { tasks.delete(task.tabId); throw error; }
        void drive(task).catch(error => console.error('Studocu task:', error.message));
        return view(task);
      });
    }
    async function get(tabId, docId) { await ready; return serial(tabId, () => { const task = tasks.get(tabId); return view(task?.docId === docId ? task : null); }); }
    async function cancelRecord(task, reason = '') {
      stopDownload(task.tabId, task.taskId);
      task.status = 'cancelled'; task.error = reason;
      // Send Stop before any persistence await. Failure to write storage must
      // never leave the content scanner running under stale durable intent.
      const stopping = sendContent(task.tabId, { action: 'stopScan', docId: task.docId, taskId: task.taskId }).catch(() => {});
      try { await persist(task); }
      catch (error) { task.error = (reason ? reason + ' ' : '') + 'Đã dừng nhưng không lưu được trạng thái hủy: ' + error.message; publish(task); }
      return { task, stopping };
    }
    async function stop(tabId, docId, taskId) {
      await ready;
      const result = await serial(tabId, async () => {
        const task = tasks.get(tabId);
        if (!task || task.docId !== docId || (taskId && task.taskId !== taskId) || !active(task)) return null;
        if (!view(task).cancellable) return { task };
        return cancelRecord(task);
      });
      await result?.stopping;
      return result ? view(result.task) : get(tabId, docId);
    }
    async function onScanner(message, sender) {
      await ready;
      const tabId = sender?.tab?.id;
      const task = tasks.get(tabId);
      if (!task || !['scanning', 'waiting_foreground'].includes(task.status) || message.site !== 'studocu' || message.mode !== 'html' ||
          message.taskId !== task.taskId || message.docId !== task.docId || message.assetId !== task.assetId || message.totalPages !== task.totalPages ||
          !Number.isSafeInteger(message.count) || message.count < 0 || message.count > task.totalPages) return { ignored: true };
      const shouldAdvance = await serial(tabId, async () => {
        if (!current(task) || !['scanning', 'waiting_foreground'].includes(task.status)) return false;
        task.count = message.count; task.missingPages = message.missingPages || [];
        if (message.action === 'scanError') { task.status = 'error'; task.error = message.error || 'Không hoàn tất quét.'; }
        else if (message.action === 'scanComplete' && !message.complete) task.status = 'incomplete';
        else task.status = message.scanStatus === 'waiting_foreground' ? 'waiting_foreground' : 'scanning';
        await persist(task); return message.action === 'scanComplete' && message.complete;
      });
      if (shouldAdvance) await advance(task);
      return view(task);
    }
    async function onDownload(job, message) {
      await ready;
      return serial(job.tabId, async () => {
        const task = tasks.get(job.tabId);
        if (!current(task) || job.taskId !== task.taskId || job.docId !== task.docId || !['downloading', 'saving'].includes(task.status)) return;
        task.downloadedCount = job.downloadedCount; task.fontFallbackCount = job.fontFallbackCount || 0;
        if (message.phase === 'saving') task.status = 'saving';
        await persist(task);
      });
    }
    async function invalidate(tabId, reason, change) {
      await ready;
      const result = await serial(tabId, async () => {
        const task = tasks.get(tabId); if (!active(task)) return;
        if (change && change.status !== 'loading' && (!change.url || support.getDocumentId(change.url) === task.docId)) return;
        return cancelRecord(task, reason);
      });
      await result?.stopping;
    }
    async function isDocumentBusy(docId) {
      await ready;
      return [...tasks.values()].some(task => task.docId === docId && active(task));
    }
    async function clearDocument(docId, erase) {
      if (clearing.has(docId)) throw Error('Đang xóa cache tài liệu.');
      clearing.add(docId);
      try {
        await ready;
        const matches = [...tasks.values()].filter(task => task.docId === docId);
        for (const task of matches) await serial(task.tabId, () => {
          if (active(task) || downloadState(task.tabId)?.active) throw Object.assign(Error('Tài liệu đang quét hoặc tải. Hãy dừng tác vụ trước khi xóa cache.'), { status: 'busy' });
        });
        const result = await erase();
        for (const task of matches) if (tasks.get(task.tabId) === task) tasks.delete(task.tabId);
        return result;
      } finally { clearing.delete(docId); }
    }
    return { ready, start, get, stop, onScanner, onDownload, invalidate, isDocumentBusy, clearDocument, async busy(tabId) { await ready; return active(tasks.get(tabId)); } };
  }
  return { create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StudocuTasks;
