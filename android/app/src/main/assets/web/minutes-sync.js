/* Foreground-only, read-only delivery of stored meeting minutes through the native bridge. */
((root) => {
  'use strict';
  function create(options) {
    const now = options.now || Date.now;
    const rows = new Map(), pending = new Map(), seen = new Set();
    let active = false, epoch = 0, serial = 0, timer = null, list = null, nextList = 0, listFailures = 0, listHealthy = false;
    const id = () => `minutes-sync-${epoch}-${++serial}`;
    const final = p => p.read_cache?.state !== 'cached' && p.read_cache?.final !== false;
    const notify = (name, ...args) => options[name]?.(...args);
    const eligible = r => r?.session_id && r.ended_at && r.transcript_status !== 'expired' && Number(r.utterance_count ?? r.utterances?.length) >= 5;
    const fingerprint = r => JSON.stringify([r.ended_at, r.utterance_count, r.title, r.review_pending, r.transcript_status]);
    function watch(row) {
      if (!eligible(row)) return;
      const old = rows.get(row.session_id), revision = fingerprint(row);
      if (old && old.revision !== revision) notify('onInvalidate', row.session_id);
      rows.set(row.session_id, { ...old, row, revision, next: !old || old.revision !== revision ? 0 : old.next });
    }
    function observe(p) {
      const row = rows.get(p.session_id);
      if (!row) return;
      row.status = p.status;
      row.failures = 0;
      row.next = p.status === 'pending' ? now() + 10000 : p.status === 'ready' ? now() + 60000 : Infinity;
    }
    function failed(sid, message, detail) {
      const r = rows.get(sid);
      if (r) { r.failures = (r.failures || 0) + 1; r.next = now() + Math.min(10000 * 2 ** r.failures, 120000); }
      notify('onFailure', sid, message, detail);
    }
    function tick() {
      clearTimeout(timer);
      if (!active) return;
      const at = now();
      if (list && at - list.at >= 25000) {
        list = null; nextList = at + Math.min(10000 * 2 ** ++listFailures, 120000);
        listHealthy = false; pending.clear(); notify('onListFailure', { message: '会议列表同步超时，请重新读取。' });
      }
      for (const [requestId, request] of pending) {
        if (at - request.at < 25000) continue;
        pending.delete(requestId); failed(request.sid, '同步暂未收到回包，将自动重试。');
      }
      if (!list && at >= nextList) {
        list = { requestId: id(), at };
        options.send('history.list', { ...options.listPayload?.(), requestId: list.requestId });
      }
      for (const [sid, r] of rows) {
        if (!listHealthy) break;
        if (pending.size >= 2) break;
        if (at < r.next || [...pending.values()].some(p => p.sid === sid) || options.isBusy?.(sid)) continue;
        const requestId = id();
        pending.set(requestId, { sid, at, revision: r.revision });
        notify('onStart', sid, requestId);
        options.send('history.minutes', { sessionId: sid, requestId });
      }
      timer = setTimeout(tick, 1000);
    }
    function receive(type, p) {
      if (!String(p.requestId || '').startsWith('minutes-sync-')) return false;
      // Retired replies are consumed, never passed to the page's manual-request handlers.
      if (!active) return true;
      if (list?.requestId === p.requestId) {
        if (type === 'history.list' && Array.isArray(p.items)) {
          if (!final(p)) { notify('onList', p); return true; }
          const visible = new Set(p.items.map(r => r.session_id));
          for (const [sid, value] of rows) if (!visible.has(sid) && !value.selected) {
            rows.delete(sid); notify('onRemove', sid);
          }
          for (const r of p.items) {
            if (eligible(r)) watch(r);
            else if (rows.has(r.session_id)) { rows.delete(r.session_id); notify('onRemove', r.session_id); }
          }
          listHealthy = true;
          listFailures = 0; nextList = now() + 20000;
          if (notify('onList', p) === false) { listHealthy = false; nextList = now() + 10000; }
        } else {
          nextList = now() + Math.min(10000 * 2 ** ++listFailures, 120000);
          listHealthy = false; pending.clear(); notify('onListFailure', p);
        }
        list = null;
        return true;
      }
      const request = pending.get(p.requestId);
      if (!request) return true;
      if (final(p) || type !== 'history.minutes') pending.delete(p.requestId);
      const r = rows.get(request.sid);
      if (!r || request.revision !== r.revision) return true;
      if (type !== 'history.minutes' || p.session_id !== request.sid) {
        failed(request.sid, p.message || '暂未同步成功，恢复连接后会自动重试。', p);
        return true;
      }
      const ready = p.status === 'ready';
      const fresh = final(p) && p.read_cache?.state !== 'unchanged' && ready && !seen.has(request.sid);
      if (notify('onResult', p) === false) { r.next = now() + 10000; return true; }
      if (ready) seen.add(request.sid); // Restoring a cached result is never a new-result notification.
      if (!final(p)) return true;
      observe(p);
      if (fresh) notify('onReady', request.sid);
      return true;
    }
    function pause() {
      active = false; epoch++; clearTimeout(timer); timer = null; list = null; pending.clear(); listHealthy = false;
    }
    return {
      receive, observe,
      select(row) { for (const r of rows.values()) r.selected = false; watch(row); if (rows.has(row?.session_id)) rows.get(row.session_id).selected = true; },
      remove(sid) { rows.delete(sid); seen.delete(sid); for (const [key, p] of pending) if (p.sid === sid) pending.delete(key); },
      start() { if (active) return; active = true; nextList = 0; tick(); },
      refreshList() { list = null; nextList = 0; if (active) tick(); },
      pause,
      reset() { pause(); rows.clear(); seen.clear(); listFailures = 0; },
    };
  }
  root.OopsMinutesSync = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})(typeof window !== 'undefined' ? window : globalThis);
