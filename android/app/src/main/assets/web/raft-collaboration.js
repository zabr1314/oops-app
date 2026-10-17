/* Private Android Raft collaboration. HTTP credentials remain in the native shell. */
((root) => {
  'use strict';
  const OPS = { read: 'collaboration.read', submit: 'collaboration.submit', find: 'collaboration.find',
    continue: 'collaboration.continue', review: 'collaboration.review', cancel: 'collaboration.cancel',
    taskCreate: 'task.create', taskList: 'task.list', taskGet: 'task.get', sourceRead: 'source.read', sourceLinks: 'source.links' };
  const A1234_AGENT_ID = 'a56dbb7c-5efa-4e1f-9fbb-ad50f2393ce7';
  const CANDIDATE_PREFIX = '未人工确认的会议候选事项。请先在本线程澄清范围、负责人和时间，明确后执行；进展与成果回复本线程。此派工不修改原事项核对或业务完成状态。';
  const DEFINITE_WRITE_REJECTIONS = ['SOURCE_TASK_EXISTS', 'TASK_HANDOFF_EXISTS', 'SOURCE_DISPATCH_UNRESOLVED'];
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const clone = value => JSON.parse(JSON.stringify(value));
  const stable = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
  const ownerLabel = value => value === 'collective' ? '大家' : value === 'unknown' ? '待人工确认' : String(value || '未记录');
  const uid = prefix => prefix + '-' + root.crypto.randomUUID();
  const statusText = { queued: '等待发送', preparing: '等待登记', dispatching: '正在发送', sent: 'Raft 已接收',
    unknown: '送达未知', failed: '发送失败', cancelled: '已取消', unavailable: '回执暂不可读', replied: '收到回复' };
  const groupText = { available: '群成员已核对', ready: '群成员已核对', expired: '群成员快照已过期',
    unavailable: '群成员暂不可读', not_configured: '协作群尚未配置', not_connected: '尚未读取协作群' };
  const groupErrorText = { GROUP_READ_EXPIRED: '刷新后重新核对当前群成员。', GROUP_ROSTER_UNAVAILABLE: '暂时无法核对群成员，恢复读取后再派工。',
    GROUP_NOT_JOINED: 'Oops 尚未加入共用群。', GROUP_ARCHIVED: '共用群已归档。', GROUP_READ_FAILED: '读取群成员失败。' };

  function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务回包不完整'); return value; }
  function text(value, required = false) { if (typeof value === 'string') return value; if (required) throw new Error('服务回包缺少标识或正文'); return ''; }
  function list(value) { if (!Array.isArray(value)) throw new Error('服务未返回可核对的列表'); return value; }
  function errorText(error) { return String(error?.message || error || '服务请求失败').slice(0, 500); }
  function sourceLocator(value) {
    const row = object(value), kind = text(row.kind, true);
    if (!['meeting_item', 'label_review'].includes(kind)) throw new Error('该事项来源尚未接入协作');
    const meetingKey = kind === 'meeting_item' ? 'session_id' : 'source_meeting_id';
    const result = { kind, [meetingKey]: text(row[meetingKey], true), item_id: text(row.item_id, true) };
    if (![result[meetingKey], result.item_id].every(id => /^[A-Za-z0-9_-]{1,100}$/.test(id))) throw new Error('会议或事项编号无效');
    if (row.fingerprint !== undefined) { if (!/^[a-f0-9]{64}$/.test(row.fingerprint)) throw new Error('事项指纹缺失或无效'); result.fingerprint = row.fingerprint; }
    return result;
  }
  const sourceKey = row => row ? JSON.stringify([row.kind, row.session_id || row.source_meeting_id, row.item_id]) : '';
  function taskResult(value) {
    const outer = object(value), row = outer.task ? object(outer.task) : outer;
    const id = text(row.id, true); if (!/^raft-task:[a-f0-9]{32}$/i.test(id)) throw new Error('后端没有返回已保存的 Oops 任务编号');
    const permitted = row.permitted === true && typeof row.title === 'string' && typeof row.text === 'string';
    return { ...row, id, title: permitted ? row.title : '', text: permitted ? row.text : '', permitted, request_id: text(row.request_id, true) };
  }
  function handoffResult(value) {
    const row = object(value);
    if (!/^[a-f0-9]{32}$/i.test(text(row.id, true))) throw new Error('协作交接编号无效');
    const readable = row.body_unavailable !== true;
    return { ...row, title: readable ? text(row.title, true) : '来源暂不可读', text: readable ? text(row.text, true) : '', request_id: text(row.request_id, true),
      member_ids: list(row.member_ids || []).map(id => text(id, true)), replies: readable ? list(row.replies || []) : [],
      reviews: readable ? list(row.reviews || []) : [], communications: readable ? list(row.communications || []) : [] };
  }
  function groupUrl(group, messageId) {
    if (!group || !UUID.test(group.id) || typeof group.url !== 'string') return null;
    try {
      const url = new URL(group.url);
      if (url.protocol !== 'https:' || !['app.raft.build', 'app.slock.ai'].includes(url.hostname) || url.port
        || url.username || url.password || url.search || url.hash || !/^\/s\/[^/]+\/channel\/[a-f0-9-]+$/i.test(url.pathname)
        || !url.pathname.toLowerCase().endsWith('/channel/' + group.id.toLowerCase())) return null;
      if (messageId) { if (!UUID.test(messageId)) return null; url.searchParams.set('thread', group.id + ':' + messageId); }
      return url.href;
    } catch { return null; }
  }

  function create(options) {
    const state = { active: false, group: null, groupStatus: 'not_connected', groupVersion: 0, groupError: '', bridgeOnline: false,
      tasks: [], handoffs: [], selected: '', draft: { title: '', text: '', members: [], confirm: false, task: null },
      follow: { text: '', members: [], confirm: false }, source: null, review: null, busy: '', error: '', notice: '', lastWrite: null, transientReadFailure: false };
    const pending = new Map();
    let epoch = 0, serial = 0, context = '', loaded = false, sourceTimer = null, sourcePollBusy = false;
    const nativeState = () => options.getState?.() || {};
    const contextKey = () => JSON.stringify([nativeState().backend, nativeState().backendUrl, options.getEpoch?.() ?? nativeState().serviceEpoch ?? null, options.getIdentity?.() ?? null]);
    const open = () => state.active && options.isOpen?.() !== false && !root.document?.hidden;
    function enabled() {
      const params = new URLSearchParams(root.location?.search || '');
      if (root.location?.origin !== 'https://appassets.androidplatform.net' || !root.OopsNative
        || ['preview', 'board-preview', 'tour', 'mock'].some(key => params.has(key))) return false;
      const native = nativeState();
      if (!native.backend || native.backend === 'mock' || native.mockBackend === true) return false;
      try { const url = new URL(native.backendUrl); return url.protocol === 'https:' && !url.username && !url.password; }
      catch { return false; }
    }
    function selected() { return state.handoffs.find(row => row.id === state.selected); }
    function members() { return (state.group?.members || []).filter(row => row.type === 'agent' && row.id !== state.group.bridge_agent_id); }
    function candidateSource(value = state.source?.data) { return value?.source_policy === 'candidate_dispatch' && value.review_status === 'unreviewed' && value.self_review?.status === 'unreviewed' && value.source_contract?.domain === 'oops-raft-candidate.v1' && value.source_contract.candidate_state?.review_status === 'unreviewed' && value.source_contract.candidate_state?.responsibility === 'unverified'; }
    function sourcePayload() { return { ...state.source.locator, ...(state.source.compact ? { mode: 'delegate' } : {}) }; }
    function sourceBrief(value) {
      const item = value.item;
      if (candidateSource(value)) return {
        title: ('待核对：' + text(item.title)).slice(0, 200),
        text: ['候选标题：' + text(item.title), text(item.detail), '负责人：待核对', item.owner_hint ? '模型建议负责人（待核对）：' + ownerLabel(item.owner_hint) : '', item.due ? '候选时间约定（待核对）：' + text(item.due) : ''].filter(Boolean).join('\n'),
      };
      return { title: text(item.title), text: [text(item.title), text(item.detail), item.owner ? '原负责人：' + ownerLabel(item.owner) : '', item.due ? '原时间约定：' + text(item.due) : ''].filter(Boolean).join('\n') };
    }
    function sourceReadable() {
      if (!state.source) return true;
      const value = state.source.data, contract = value?.source_contract;
      return !!value && ['current', 'retained'].includes(value.source_status)
        && (value.source_policy === 'confirmed_source' && value.review_status === 'confirmed' && contract?.domain === 'oops-raft-source.v1' || state.source.compact === true && candidateSource(value))
        && value.item?.kind === 'task' && contract?.version === 1 && typeof contract.proof === 'string' && !!contract.proof;
    }
    function sourceReady() { if (!state.source) return true; const value = state.source.data; return sourceReadable() && value.dispatch_allowed === true && Number.isFinite(Date.parse(value.source_contract.expires_at)) && Date.parse(value.source_contract.expires_at) > Date.now(); }
    function ready() { return enabled() && sourceReady() && !sourceHasBlockingDispatch() && ['available', 'ready'].includes(state.groupStatus) && !!state.group && !state.busy && !sourcePollBusy && pending.size === 0 && state.lastWrite?.state !== 'unknown'; }
    function transientReadError(error) { return ['UNCONFIRMED', 'BUSY', 'READ_TIMEOUT', 'NETWORK_ERROR'].includes(error.code) || !error.code && /timeout|尚未收到原生服务回执/i.test(errorText(error)); }
    function notify(message) { state.notice = message; options.toast?.(message); }
    function redraw() {
      if (!open()) return;
      const field = root.document?.activeElement;
      const key = field?.getAttribute?.('data-raft-field');
      const cursor = key && typeof field.selectionStart === 'number' ? [field.selectionStart, field.selectionEnd] : null;
      const scroll = root.document?.getElementById('scroll'), position = scroll?.scrollTop;
      options.render?.();
      if (scroll && typeof position === 'number') scroll.scrollTop = position;
      if (key) {
        const next = [...(root.document?.querySelectorAll('[data-raft-field]') || [])].find(node => node.getAttribute('data-raft-field') === key);
        if (next && !next.disabled) { next.focus(); if (cursor) next.setSelectionRange?.(...cursor); }
      }
    }
    function taskShell(task) { let ref = null; try { ref = task.task_ref ? sourceLocator(task.task_ref) : null; } catch { /* Retain transport IDs even when an older reference type cannot be read. */ } return { id: task.id, request_id: task.request_id, kind: task.kind, status: task.status, source_status: task.source_status, source_version: task.source_version, source_error: task.source_error, permitted: false, title: '', text: '', task_ref: ref, handoffs: task.handoffs?.map(row => ({ handoff_id: row.handoff_id || row.id, outbox_id: row.outbox_id })) || [] }; }
    function handoffShell(row) { return { id: row.id, request_id: row.request_id, task_id: row.task_id, outbox_id: row.outbox_id, status: row.status, transport_status: row.transport_status || row.status, group_channel_id: row.group_channel_id, raft_message_id: row.raft_message_id, source_error: row.source_error, operation_request_id: row.operation_request_id, operation: row.operation ? { kind: row.operation.kind, id: row.operation.id, handoff_id: row.operation.handoff_id } : undefined, body_unavailable: true, title: '来源暂不可读', text: '', member_ids: [], replies: [], reviews: [], communications: [] }; }
    function clearPrivate(preserveHistory = !!state.source, keepNavigation = false) {
      state.group = keepNavigation && state.group ? { id: state.group.id, url: state.group.url, name: state.group.name, members: [], bridge_agent_id: state.group.bridge_agent_id } : null;
      state.groupStatus = 'not_connected'; state.groupVersion = 0; state.groupError = ''; state.bridgeOnline = false;
      state.tasks = preserveHistory ? state.tasks.map(taskShell) : []; state.handoffs = preserveHistory ? state.handoffs.map(handoffShell) : []; state.review = null; loaded = false;
      if (state.source) { state.source.data = null; state.source.confirm = false; state.draft.title = ''; state.draft.text = ''; }
      if (state.source && state.draft.task) state.draft.task = taskShell(state.draft.task);
    }
    function retire(reason, resetDrafts) {
      clearTimeout(sourceTimer); sourceTimer = null; sourcePollBusy = false;
      if (state.lastWrite?.state === 'sending') state.lastWrite.state = 'unknown';
      epoch++;
      for (const row of pending.values()) { clearTimeout(row.timer); row.reject(new Error(reason)); }
      pending.clear(); state.busy = ''; state.draft.confirm = false; state.follow.confirm = false; clearPrivate(!resetDrafts && !!state.source);
      state.transientReadFailure = false;
      if (resetDrafts) { state.draft = { title: '', text: '', members: [], confirm: false, task: null }; state.follow = { text: '', members: [], confirm: false }; state.lastWrite = null; state.selected = ''; state.source = null; }
    }
    function syncContext() {
      const next = contextKey();
      if (next !== context) { if (context) resetSourceIntent('服务或本人身份已变化，请从原任务重新进入'); context = next; }
    }
    function resetSourceIntent(reason) {
      const sourceMode = !!state.source, compact = state.source?.compact === true;
      retire(reason, true);
      if (sourceMode) state.source = { locator: null, returnRoute: null, data: null, confirm: false, initialized: false, unavailableIntent: true, compact };
      state.error = sourceMode ? reason : '';
    }
    function bridge(operation, payload) {
      const beforeEpoch = epoch;
      syncContext();
      if (beforeEpoch !== epoch) return Promise.reject(new Error('服务或本人身份已变化，旧请求不会发送到新连接'));
      if (!enabled() || !open()) return Promise.reject(new Error('真实协作只在已配置 HTTPS 服务的安装版中开放'));
      const requestId = `raft-h5-${epoch}-${++serial}-${root.crypto.randomUUID()}`, atEpoch = epoch, atContext = context;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('尚未收到原生服务回执，请查询原请求')); }, 25000);
        pending.set(requestId, { requestId, operation, epoch: atEpoch, context: atContext, resolve, reject, timer });
        try { options.send('raft.request', { requestId, operation, payload: clone(payload || {}) }); }
        catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
      });
    }
    function receive(type, packet) {
      if (type === 'backend.changed') { resetSourceIntent('服务已变化，请从原任务重新进入'); context = ''; return false; }
      if (type !== 'raft.result') return false;
      const row = pending.get(packet.requestId);
      if (!row) return true;
      pending.delete(packet.requestId); clearTimeout(row.timer);
      if (!open() || row.epoch !== epoch || row.context !== contextKey()
        || packet.operation !== row.operation || packet.backendUrl && packet.backendUrl !== nativeState().backendUrl
        || packet.serviceEpoch !== undefined && options.getEpoch?.() != null && packet.serviceEpoch !== options.getEpoch()) {
        row.reject(new Error('连接或页面已变化，旧回执不再应用')); return true;
      }
      if (packet.error || packet.ok === false) { const failure = new Error(errorText(packet.error || '服务请求失败')); failure.code = packet.error?.code; row.reject(failure); }
      else if (!Object.prototype.hasOwnProperty.call(packet, 'data')) row.reject(new Error('原生没有返回服务回执'));
      else row.resolve(packet.data);
      return true;
    }
    function snapshot(value) {
      const row = object(value), groupStatus = text(row.group_status, true), group = row.group ? object(row.group) : null;
      if (group) {
        if (!UUID.test(text(group.id, true))) throw new Error('群组稳定编号无效');
        group.members = list(group.members).map(value => { const member = object(value); if (!UUID.test(text(member.id, true)) || !['agent', 'human', 'user'].includes(member.type)) throw new Error('群成员编号或类型未核对'); return member; });
      }
      if (['available', 'ready'].includes(groupStatus) && (!group || !Number.isInteger(row.group_version) || row.group_version < 1)) throw new Error('群成员或版本尚未核对');
      state.group = group; state.groupStatus = groupStatus; state.groupVersion = row.group_version || 0;
      state.groupError = text(row.group_error); state.bridgeOnline = row.bridge_online === true;
      if (!state.source) state.handoffs = list(row.items || []).map(handoffResult); loaded = true;
      const ids = members().map(member => member.id); state.draft.members = state.draft.members.filter(id => ids.includes(id)); state.follow.members = state.follow.members.filter(id => ids.includes(id));
      state.draft.confirm = false; state.follow.confirm = false;
      if (state.review) { const actual = state.handoffs.find(item => item.id === state.review.handoffId)?.replies.find(item => item.reply_id === state.review.reply.reply_id); if (!actual || JSON.stringify(actual) !== JSON.stringify(state.review.reply)) state.review = null; else state.review.confirm = false; }
    }
    function mergeTask(row) { state.tasks = [row, ...state.tasks.filter(item => item.id !== row.id)]; }
    function mergeHandoff(row) { state.handoffs = [row, ...state.handoffs.filter(item => item.id !== row.id)]; }
    function hasRequest(row, id) { return row.request_id === id || row.communications.some(item => item.request_id === id) || row.reviews.some(item => item.request_id === id)
      || row.operation_request_id === id && row.operation?.handoff_id === row.id && /^[a-f0-9]{32}$/i.test(row.operation?.id || '') && ['handoff', 'continuation', 'review'].includes(row.operation?.kind); }
    function usableTask(task) {
      if (!task || task.permitted !== true || ['closed', 'completed', 'cancelled', 'rejected', 'source_invalidated'].includes(task.status)) return false;
      return state.source ? task.kind === (candidateSource() ? 'candidate_collaboration' : 'source_collaboration') && sourceKey(task.task_ref) === sourceKey(state.source.locator) && task.source_version === state.source.data?.source_version && sourceReady() : task.kind === 'manual_collaboration';
    }
    function applySource(value) {
      const row = object(value), canonical = sourceLocator(row.source_ref), source = state.source;
      if (!source?.locator || sourceKey(canonical) !== sourceKey(source.locator)
        || source.locator.fingerprint && canonical.fingerprint !== source.locator.fingerprint) throw new Error('来源已变化，请回原任务重新读取并核对');
      const item = object(row.item), contract = object(row.source_contract);
      if (item.kind !== 'task' || contract.version !== 1 || typeof contract.proof !== 'string' || !contract.proof || typeof contract.expires_at !== 'string') throw new Error('来源尚未提供本次派工的核对合同');
      if (!/^[a-f0-9]{64}$/.test(row.source_version || '')) throw new Error('服务未提供已核对的来源版本，请更新服务后从原任务进入');
      const revision = JSON.stringify([row.source_ref, row.source_version, row.review_revision, item.title, item.detail, item.owner, item.due, row.source_status]);
      const changed = !!source.revision && source.revision !== revision;
      source.data = { ...row, item, source_contract: contract, evidence: list(row.evidence || []) }; source.confirm = false;
      source.blockingDispatch = Array.isArray(row.blocking_dispatch) ? row.blocking_dispatch.length > 0 : !!row.blocking_dispatch;
      if (changed) source.newVersion = false;
      if (!source.initialized || changed || !state.draft.title && !state.draft.text && !state.draft.task && !state.tasks.length && !state.handoffs.length) {
        text(item.title, true); const brief = sourceBrief(row);
        state.draft.title = brief.title; state.draft.text = brief.text;
        if (changed) { state.draft.confirm = false; state.review = null; if (state.draft.task) state.draft.task = taskShell(state.draft.task); notify('来源或核对版本发生变化，旧稿已撤下；既有任务编号保留，请回原任务核对'); }
      }
      if (!source.initialized) { state.draft.members = members().some(member => member.id === A1234_AGENT_ID) ? [A1234_AGENT_ID] : []; source.initialized = true; }
      if (source.compact) state.draft.members = members().some(member => member.id === A1234_AGENT_ID) ? [A1234_AGENT_ID] : [];
      source.revision = revision;
      if (!sourceReadable()) throw new Error('当前来源或本人读取许可不可用，请回原任务核对');
    }
    function applySourceLinks(value, transportOnly = false) {
      const row = object(value);
      if (!state.source?.locator || sourceKey(sourceLocator(row.source_ref)) !== sourceKey(state.source.locator)) throw new Error('执行结果不属于当前原任务');
      state.source.blockingDispatch = Array.isArray(row.blocking_dispatch) ? row.blocking_dispatch.length > 0 : !!row.blocking_dispatch;
      const sameRevision = !state.source.data || stable(row.source_ref) === stable(state.source.data.source_ref) && row.source_version === state.source.data.source_version;
      const available = sameRevision && /^[a-f0-9]{64}$/.test(row.source_version || '') && ['current', 'retained'].includes(row.source_status);
      const tasks = list(row.items).map(taskResult), handoffs = tasks.flatMap(task => list(task.collaborations || []).map(handoffResult));
      if (!available) {
        state.source.data = null; state.source.confirm = false; state.draft.confirm = false; state.follow.confirm = false; state.review = null;
        state.draft.title = ''; state.draft.text = ''; if (state.draft.task) state.draft.task = taskShell(state.draft.task);
        state.tasks = tasks.map(taskShell); state.handoffs = handoffs.map(handoffShell);
        state.error = '原任务来源已变化或不可用，仅保留真实任务编号与送达回执；旧正文、回复和许可已撤下';
        state.transientReadFailure = false;
      } else {
        state.tasks = tasks; state.handoffs = handoffs;
        if (!state.draft.task && tasks.length === 1 && usableTask(tasks[0]) && !tasks[0].handoffs?.length && !handoffs.length) {
          state.draft.task = tasks[0]; state.draft.title = tasks[0].title; state.draft.text = tasks[0].text; state.draft.confirm = false;
        }
      }
      if (handoffs.some(item => item.group_status === 'unavailable')) { state.group = null; state.groupStatus = 'unavailable'; state.groupVersion = 0; state.draft.confirm = false; state.follow.confirm = false; }
      if (!state.selected || !state.handoffs.some(item => item.id === state.selected)) state.selected = state.handoffs[0]?.id || '';
      if (state.source.compact && selected()?.body_unavailable) state.selected = state.handoffs.find(item => !item.body_unavailable)?.id || state.selected;
      if (!transportOnly && !available) notify('原请求与送达事实已保留；先回原任务重新核对');
      return available;
    }
    async function resolveOriginal(at) {
      if (state.lastWrite?.state !== 'unknown') return;
      const action = state.lastWrite, operation = action.operation === OPS.taskCreate ? OPS.taskList : OPS.find;
      const found = object(await bridge(operation, { request_id: action.payload.request_id })); if (at !== epoch) return;
      const items = list(found.items).map(action.operation === OPS.taskCreate ? taskResult : handoffResult);
      if (items.length > 1 || items.some(item => action.operation === OPS.taskCreate ? item.request_id !== action.payload.request_id : !hasRequest(item, action.payload.request_id))) throw new Error('服务未按原请求编号精确核对，暂不重发');
      if (!items[0]) { action.state = 'retryable'; notify('原请求尚未入库。重新确认后可用同一编号手动重试'); return; }
      if (state.source && !sourceReadable()) {
        if (action.operation === OPS.taskCreate) { const shell = taskShell(items[0]); mergeTask(shell); state.draft.task = shell; }
        else { const shell = handoffShell(items[0]); mergeHandoff(shell); state.selected = shell.id; }
        state.lastWrite = null; notify('已定位原任务或交接编号并保留真实回执；来源仍不可用，停止继续派工'); return;
      }
      if (action.operation === OPS.taskCreate) {
        mergeTask(items[0]);
        if (state.draft.title.trim() === items[0].title && state.draft.text.trim() === items[0].text) state.draft.task = items[0];
      } else {
        mergeHandoff(items[0]); state.selected = items[0].id;
        if (action.operation === OPS.submit && state.draft.task?.id === action.payload.task_id
          && state.draft.title.trim() === action.payload.title && state.draft.text.trim() === action.payload.text) state.draft = { title: '', text: '', members: [], confirm: false, task: null };
        if (action.operation === OPS.continue && state.follow.text.trim() === action.payload.text) state.follow = { text: '', members: [], confirm: false };
        if (action.operation === OPS.review && state.review?.handoffId === action.payload.handoff_id
          && state.review.reply.reply_id === action.payload.reply_id && state.review.note.trim() === action.payload.note) state.review = null;
      }
      state.lastWrite = null; notify(action.operation === OPS.taskCreate ? '任务已保存；重新确认后可派工，不会重复新建' : '已恢复原请求的真实回执');
    }
    async function refresh() {
      syncContext(); if (state.busy || sourcePollBusy || pending.size || !enabled() || !open()) return;
      const at = epoch; let linksReadAttempted = false;
      state.busy = '正在读取群、任务与回执'; state.error = ''; state.transientReadFailure = false; redraw();
      try {
        const value = await bridge(OPS.read, {}); if (at !== epoch) return; snapshot(value);
        if (state.source) {
          if (!state.source.locator) throw new Error('服务或本人身份已变化，请从原任务重新进入；不能改成手写任务绕过');
          const source = await bridge(OPS.sourceRead, sourcePayload()); if (at !== epoch) return; applySource(source);
          linksReadAttempted = true;
          const links = await bridge(OPS.sourceLinks, sourcePayload()); if (at !== epoch) return; applySourceLinks(links);
        } else {
          const tasks = object(await bridge(OPS.taskList, {})); if (at !== epoch) return; state.tasks = list(tasks.items).map(taskResult);
        }
        if (state.draft.task) { const currentTask = state.tasks.find(item => item.id === state.draft.task.id); if (currentTask) state.draft.task = currentTask; else state.draft.task = { ...state.draft.task, permitted: false, title: '', text: '' }; }
        await resolveOriginal(at);
      } catch (error) {
        if (at === epoch) {
          const temporary = transientReadError(error);
          clearPrivate(!!state.source, temporary); state.groupStatus = 'unavailable'; state.transientReadFailure = temporary;
          state.error = temporary ? '暂时读不到进展，原交办未取消。请稍后刷新。' : errorText(error);
          if (state.source?.locator && !linksReadAttempted && error.code !== 'BUSY') {
            try { const history = await bridge(OPS.sourceLinks, sourcePayload()); if (at === epoch && applySourceLinks(history) && state.transientReadFailure) { state.error = ''; state.transientReadFailure = false; } }
            catch (historyError) { if (at === epoch) state.error += '；原任务执行历史仍不可读取：' + errorText(historyError); }
          }
          if (state.lastWrite?.state === 'unknown') {
            try { await resolveOriginal(at); } catch (queryError) { if (at === epoch) state.error += '；原请求仍待核对：' + errorText(queryError); }
          }
        }
      }
      finally { if (at === epoch) { state.busy = ''; redraw(); scheduleSourcePoll(); } }
    }
    function scheduleSourcePoll() {
      clearTimeout(sourceTimer); sourceTimer = null;
      if (!open() || !state.source?.locator || !selected()?.id) return;
      sourceTimer = setTimeout(pollSourceResult, 9000);
    }
    async function pollSourceResult() {
      sourceTimer = null;
      if (!open() || !state.source?.locator || !selected()?.id) return;
      const editing = root.document?.activeElement?.matches?.('[data-raft-field], textarea, input, select');
      if (state.busy || sourcePollBusy || pending.size || editing || state.review || state.draft.confirm || state.follow.confirm) { scheduleSourcePoll(); return; }
      const at = epoch, locator = sourcePayload(), before = JSON.stringify([state.tasks, state.handoffs]); sourcePollBusy = true;
      syncControls();
      let stop = false;
      try {
        const value = await bridge(OPS.sourceLinks, locator); if (at !== epoch || !open()) return;
        stop = !applySourceLinks(value, true);
        const recovered = !stop && state.transientReadFailure;
        if (recovered) { state.error = ''; state.transientReadFailure = false; }
        const editingNow = root.document?.activeElement?.matches?.('[data-raft-field], textarea, input, select');
        if ((recovered || before !== JSON.stringify([state.tasks, state.handoffs])) && (!editingNow || !sourceReadable())) redraw();
      } catch (error) {
        if (at === epoch) { const temporary = transientReadError(error); clearPrivate(!!state.source, temporary); state.groupStatus = 'unavailable'; state.transientReadFailure = temporary; state.error = temporary ? '暂时读不到进展，原交办未取消。请稍后刷新。' : '执行结果读取失败，旧正文已撤下：' + errorText(error); redraw(); stop = ['UNAUTHORIZED', 'USER_SESSION_INVALID', 'SOURCE_IDENTITY_MISMATCH', 'TASK_ACCOUNT_REQUIRED', 'TASK_BINDING_CHANGED', 'TASK_SOURCE_FORBIDDEN'].includes(error.code); }
      } finally { if (at === epoch) { sourcePollBusy = false; syncControls(); if (!stop) scheduleSourcePoll(); } }
    }
    async function mutate(operation, fields) {
      const signature = JSON.stringify([operation, fields]);
      if (state.lastWrite?.state === 'unknown') throw new Error('先查询尚未确认的原请求，暂不重新发送');
      let action = state.lastWrite;
      if (!action || action.state !== 'retryable' || action.signature !== signature) action = { operation, signature, payload: { ...clone(fields), request_id: uid('oops-phone-raft') }, state: 'sending' };
      action.state = 'sending'; state.lastWrite = action;
      try {
        const value = await bridge(operation, action.payload);
        const row = operation === OPS.taskCreate ? taskResult(value) : handoffResult(value);
        if (operation === OPS.taskCreate ? row.request_id !== action.payload.request_id : !hasRequest(row, action.payload.request_id)) throw new Error('回执未匹配本次请求编号');
        if (state.lastWrite === action) state.lastWrite = null;
        return row;
      } catch (error) {
        if (state.lastWrite === action) { if (DEFINITE_WRITE_REJECTIONS.includes(error.code)) state.lastWrite = null; else action.state = 'unknown'; }
        throw error;
      }
    }
    function validMembers(ids) { return ids.length > 0 && ids.length <= 16 && ids.every(id => members().some(member => member.id === id)); }
    function sourceHasBlockingDispatch() { return !!state.source && (state.source.blockingDispatch === true || state.handoffs.some(row => ['unknown', 'dispatching', 'preparing'].includes(row.transport_status || row.status))); }
    function oldVersionSent() { return state.handoffs.some(row => row.body_unavailable && (row.transport_status || row.status) === 'sent'); }
    function sourceHasDispatch() { return !!state.source && (state.tasks.some(task => task.status !== 'source_invalidated' && task.handoffs?.length > 0) || state.handoffs.some(row => !row.body_unavailable)); }
    function sourceNewVersionPossible() { return !!state.source && sourceReady() && !sourceHasBlockingDispatch() && !!state.tasks.length && state.tasks.every(task => task.status === 'source_invalidated' && !!task.source_version && task.source_version !== state.source.data.source_version); }
    function draftValid() { return (!state.source || sourceReady() && state.source.confirm && !sourceHasDispatch() && !sourceHasBlockingDispatch() && (!state.tasks.length || !!state.draft.task || state.source.newVersion === true && sourceNewVersionPossible())) && (!state.draft.task || usableTask(state.draft.task)) && !!state.draft.title.trim() && state.draft.title.trim().length <= 200 && !!state.draft.text.trim() && state.draft.text.length <= 12000 && validMembers(state.draft.members); }
    function compactRequest() {
      const source = state.source, item = source?.data?.item;
      if (!source?.compact || !item) return null;
      if (sourceNewVersionPossible()) return { ...sourceBrief(source.data), task: null, newVersion: true };
      return { title: state.draft.title, text: state.draft.text, task: state.draft.task, newVersion: false };
    }
    function compactCanSend() {
      const draft = compactRequest();
      return !!draft && ready() && !sourceHasDispatch() && !sourceHasBlockingDispatch() && members().some(member => member.id === A1234_AGENT_ID)
        && (!state.tasks.length || !!draft.task || draft.newVersion) && (!draft.task || usableTask(draft.task))
        && !!draft.title.trim() && draft.title.trim().length <= 200 && !!draft.text.trim() && draft.text.length <= 12000;
    }
    function dispatchCompact() {
      if (!compactCanSend()) return;
      const draft = compactRequest();
      state.source.newVersion = draft.newVersion; state.source.confirm = true;
      state.draft = { title: draft.title, text: draft.text, task: draft.task, members: [A1234_AGENT_ID], confirm: true };
      void dispatch();
    }
    async function dispatch() {
      if (!ready() || !draftValid() || !state.draft.confirm) return;
      const at = epoch, draft = clone(state.draft), group = state.group, version = state.groupVersion;
      state.busy = draft.task ? '正在派工' : '正在保存 Oops 任务'; state.error = ''; state.draft.confirm = false; redraw();
      try {
        let task = draft.task;
        if (!task) {
          const sourceFields = state.source ? { task_ref: clone(state.source.data.source_ref), source_contract: clone(state.source.data.source_contract), source_confirm: true } : {};
          const retry = state.lastWrite;
          if (state.source && retry?.state === 'retryable' && retry.operation === OPS.taskCreate
            && retry.payload.title === draft.title.trim() && retry.payload.text === draft.text.trim()
            && stable(retry.payload.task_ref) === stable(sourceFields.task_ref)
            && retry.payload.source_contract?.snapshot_hash === sourceFields.source_contract.snapshot_hash
            && retry.payload.source_contract?.review_hash === sourceFields.source_contract.review_hash
            && Date.parse(retry.payload.source_contract?.expires_at) > Date.now()) sourceFields.source_contract = clone(retry.payload.source_contract);
          task = await mutate(OPS.taskCreate, { title: draft.title.trim(), text: draft.text.trim(), confirm: true, ...sourceFields }); if (at !== epoch) return;
          mergeTask(task); state.draft.task = task; state.busy = '任务已保存，正在登记派工'; redraw();
        }
        if (!usableTask(task)) throw new Error('任务来源或许可已失效，停止派工，不自动改成另一份手写任务');
        const row = await mutate(OPS.submit, { title: task.title, text: task.text, task_id: task.id, confirm: true, group_channel_id: group.id, group_version: version, member_ids: draft.members }); if (at !== epoch) return;
        mergeHandoff(row); state.selected = row.id; state.draft = { title: '', text: '', members: [], confirm: false, task: null }; state.follow = { text: '', members: [], confirm: false };
        if (state.source) state.source.confirm = false;
        notify('Oops 任务已保存，派工已登记。实际送达与结果分别查看');
      } catch (error) {
        if (at === epoch) {
          if (DEFINITE_WRITE_REJECTIONS.includes(error.code)) {
            state.draft.confirm = false; if (state.source) state.source.confirm = false;
            if (error.code === 'SOURCE_DISPATCH_UNRESOLVED' && state.source) state.source.blockingDispatch = true;
            try {
              if (state.source?.locator) { const links = await bridge(OPS.sourceLinks, sourcePayload()); if (at !== epoch) return; applySourceLinks(links); }
              else if (error.code === 'TASK_HANDOFF_EXISTS' && state.draft.task?.id) { const task = taskResult(await bridge(OPS.taskGet, { id: state.draft.task.id })); if (at !== epoch) return; if (task.id !== state.draft.task.id) throw new Error('原任务回包编号不一致'); mergeTask(task); for (const row of list(task.collaborations || []).map(handoffResult)) { if (row.task_id !== task.id) throw new Error('原线程不属于这件已保存任务'); mergeHandoff(row); } }
              else { const overview = await bridge(OPS.read, {}); if (at !== epoch) return; snapshot(overview); }
              const existing = state.handoffs.find(item => item.task_id === state.draft.task?.id) || (state.source ? state.handoffs.find(item => !item.body_unavailable) : null);
              if (existing) { state.selected = existing.id; state.draft = { title: '', text: '', members: [], confirm: false, task: null }; }
              state.error = ''; notify(error.code === 'SOURCE_DISPATCH_UNRESOLVED' ? '原派工仍等待明确回执，请核对原线程；本次未创建或发送新任务' : '这件任务已有保存或派工记录，已读取原线程；本次未重复创建');
            } catch (readError) { if (at === epoch) { clearPrivate(); state.error = '服务器已阻止重复创建，原记录读取暂未成功，请刷新；不会自动重发。' + errorText(readError); } }
          } else state.error = (state.lastWrite?.state === 'unknown' ? '本次回执未确认，先刷新查询原请求。' : '') + errorText(error);
        }
      }
      finally { if (at === epoch) { state.busy = ''; redraw(); scheduleSourcePoll(); } }
    }
    async function continueThread() {
      const row = selected(); if (!ready() || !row || row.body_unavailable || row.status !== 'sent' || !state.follow.confirm || !state.follow.text.trim() || state.follow.text.length > 12000 || !validMembers(state.follow.members)) return;
      const at = epoch, fields = { handoff_id: row.id, text: state.follow.text.trim(), group_version: state.groupVersion, member_ids: [...state.follow.members], confirm: true };
      state.busy = '正在登记续发'; state.follow.confirm = false; state.error = ''; redraw();
      try { const value = await mutate(OPS.continue, fields); if (at !== epoch) return; mergeHandoff(value); state.follow = { text: '', members: [], confirm: false }; notify('补充简报已登记在原任务线程'); }
      catch (error) { if (at === epoch) state.error = '续发回执未知，先查询原请求。' + errorText(error); }
      finally { if (at === epoch) { state.busy = ''; redraw(); scheduleSourcePoll(); } }
    }
    async function saveReview() {
      const review = state.review; if (!ready() || selected()?.body_unavailable || !review?.confirm || !review.note.trim() || review.note.length > 1000) return;
      const at = epoch; state.busy = '正在保存人工核对'; state.error = ''; review.confirm = false; redraw();
      try { const row = await mutate(OPS.review, { handoff_id: review.handoffId, reply_id: review.reply.reply_id, kind: review.kind, note: review.note.trim(), confirm: true }); if (at !== epoch) return; mergeHandoff(row); state.review = null; notify('人工核对已保存；业务完成仍需单独确认'); }
      catch (error) { if (at === epoch) state.error = '核对回执未知，先查询原请求。' + errorText(error); }
      finally { if (at === epoch) { state.busy = ''; redraw(); scheduleSourcePoll(); } }
    }
    async function cancel() {
      const row = selected(); if (!ready() || !row || row.body_unavailable || row.status !== 'queued') return;
      const at = epoch; state.busy = '正在取消待发请求'; state.error = ''; redraw();
      try { const value = handoffResult(await bridge(OPS.cancel, { handoff_id: row.id, confirm: true })); if (at !== epoch) return; if (value.id !== row.id) throw new Error('取消回执编号不一致'); mergeHandoff(value); notify('取消回执：' + (statusText[value.status] || value.status)); }
      catch (error) { if (at === epoch) state.error = '取消尚未确认，请刷新原线程。' + errorText(error); }
      finally { if (at === epoch) { state.busy = ''; redraw(); scheduleSourcePoll(); } }
    }

    const button = (act, label, disabled, tone = 'secondary', data = '') => `<button class="button ${tone}" type="button" data-raft-act="${act}" ${disabled ? 'disabled' : ''} ${data}><span>${esc(label)}</span></button>`;
    const check = (field, label, checked, disabled, data = '') => `<label class="check-row"><input type="checkbox" data-raft-field="${field}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${data}><span>${esc(label)}</span></label>`;
    const field = (name, label, value, max, multiline = false) => { const locked = !!state.busy || !!state.source && (name === 'title' || name === 'text') && (!!state.draft.task || sourceHasDispatch() || !state.source.locator); return `<label class="form-field"><span>${esc(label)}</span>${multiline ? `<textarea data-raft-field="${name}" rows="4" maxlength="${max}" ${locked ? 'disabled' : ''}>${esc(value)}</textarea>` : `<input data-raft-field="${name}" value="${esc(value)}" maxlength="${max}" ${locked ? 'disabled' : ''}>`}</label>`; };
    function memberChecks(name, ids) { return members().map(member => check(name, `${member.name || member.handle} · ${member.handle}${member.id === A1234_AGENT_ID ? ' · a1234 执行 Agent' : ''}`, ids.includes(member.id), !!state.busy, `data-raft-id="${esc(member.id)}"`)).join(''); }
    function feedback() { return `${state.busy ? `<p class="meta" role="status">${esc(state.busy)}…</p>` : ''}${state.error ? `<p class="error-text" role="alert">${esc(state.error)}</p>` : ''}${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ''}${state.lastWrite?.state === 'unknown' ? `<div class="notice warning">请求回执未知，不能重复发送。<p class="meta">${esc(state.lastWrite.payload.request_id)}</p>${button('refresh', '查询原请求回执', !!state.busy)}</div>` : ''}`; }
    function compactHtml() {
      const source = state.source, data = source.data, draft = compactRequest(), row = selected();
      const readableRecord = row && !row.body_unavailable;
      const candidate = candidateSource(data);
      const agent = members().find(member => member.id === A1234_AGENT_ID);
      const blocked = sourceHasBlockingDispatch(), delivery = row?.transport_status || row?.status;
      const previewText = draft?.text || data?.item?.detail || '', outgoingText = candidate && !sourceHasDispatch() ? (agent?.handle ? agent.handle + '\n\n' : '') + CANDIDATE_PREFIX + '\n' + previewText : previewText;
      const taskNav = row && (!row.body_unavailable && row.status === 'sent' || blocked) && row.group_channel_id === state.group?.id ? groupUrl(state.group, row.raft_message_id) : null;
      const pendingSource = !sourceReadable() && !readableRecord;
      return `<div class="stack" data-raft-page="1">
        <section class="card"><div class="card-head"><h2>${sourceHasDispatch() || blocked ? 'Oops 处理进展' : '交给 Oops'}</h2>${row ? `<span class="badge ${['unknown', 'failed'].includes(delivery) ? 'orange' : ''}">${esc(delivery === 'sent' ? '已送达' : statusText[delivery] || delivery)}</span>` : candidate ? '<span class="badge orange">候选未确认</span>' : ''}</div>
          ${data ? `<h3>${esc(draft?.title || data.item.title)}</h3><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(outgoingText)}</p><p class="meta">${candidate ? '负责人待核对；本次交办不改变原事项确认状态。' : '原负责人：' + esc(ownerLabel(data.item.owner)) + (data.item.due ? ' · ' + esc(data.item.due) : '')}</p>` : readableRecord ? `<h3>${esc(row.title)}</h3><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(row.text)}</p>` : `<p>${state.busy ? '正在读取当前任务。' : '当前任务信息暂时不可读。'}</p>`}
          ${!sourceHasDispatch() ? `<p class="meta">协作处理：${agent ? 'a1234 · ' + esc(agent.name || agent.handle) : 'a1234（尚未核对就绪）'}</p>` : ''}
        </section>
        ${pendingSource && !state.busy ? '<div class="notice warning">当前任务或本人来源许可尚未就绪。请刷新或回原任务核对后再发送。</div>' : ''}
        ${!agent && !state.busy && !sourceHasDispatch() && !blocked ? '<div class="notice warning">暂时无法核对 a1234 的实际 Agent，恢复读取后再发送。</div>' : ''}
        ${blocked ? '<div class="notice warning">原任务的派工回执尚未明确。先查询原请求或查看已有处理任务，不能另建任务重发。</div>' : !sourceHasDispatch() ? `${draft?.newVersion ? `<div class="notice warning">${oldVersionSent() ? '旧版本已经发送，原回执与线程保留。' : '旧版本已失效，原记录保留。'}本次将为重新核对的当前版本另建协作任务。</div>` : ''}<p class="meta">${candidate ? '将这条候选交给 Oops，由 a1234 先澄清再处理。原事项仍为待核对。' : '将上方任务简报交给 Oops，由 a1234 协作处理。'}${state.group?.name ? '群内成员可见。' : ''}</p>${button('compact-dispatch', '确认交给 Oops 处理', !compactCanSend(), 'primary')}` : '<p class="meta">任务已交办，进展和成果会关联这件任务。</p>'}
        ${row ? `<section class="card"><h3>处理进展</h3><p>${esc(delivery === 'sent' ? '已送达' : statusText[delivery] || delivery)}${row.body_unavailable ? ' · 来源暂不可读' : ` · ${row.replies.length} 条回复 · ${row.reviews.filter(review => review.kind === 'artifact').length} 条人工成果`}</p>${row.transport_error || row.last_error ? `<p class="error-text">${esc(row.transport_error || row.last_error)}</p>` : ''}${taskNav ? button('thread-open', '查看处理进展', false, 'primary') : row.status === 'queued' && !row.body_unavailable ? button('cancel', '取消尚未发出的任务', !ready(), 'quiet') : ''}</section>` : ''}
        ${button('refresh', state.lastWrite?.state === 'unknown' ? '查询原请求' : '刷新任务状态', !!state.busy)}
        <button class="button quiet" type="button" data-act="back">回到原任务</button>
        ${feedback()}
      </div>`;
    }
    function html() {
      syncContext();
      if (!enabled()) return '<div class="stack"><section class="card"><h2>Oops 多人协作</h2><p>共用一个 Raft 群，每个任务独立推进。</p></section><div class="notice warning">浏览器、公开预览与 Mock 不连接真实协作。请在安装版配置 HTTPS 后端后使用。</div></div>';
      if (state.source?.compact) return compactHtml();
      const group = state.group, row = selected(), actualTask = state.draft.task;
      const source = state.source, sourceData = source?.data;
      const canDraft = ready() && draftValid() && state.draft.confirm;
      const nav = groupUrl(group), taskNav = !row?.body_unavailable && row?.status === 'sent' && row.group_channel_id === group?.id ? groupUrl(group, row.raft_message_id) : null;
      const memberList = (group?.members || []).map(member => `<div class="list-row"><span class="row-copy"><strong>${esc(member.name || member.handle || '群成员')}</strong><small>${esc(member.handle || '')} · ${member.type !== 'agent' ? '群成员' : member.id === group.bridge_agent_id ? 'Oops 任务入口' : 'Agent'}</small></span></div>`).join('');
      return `<div class="stack" data-raft-page="1">
        <section class="card"><div class="card-head"><h2>${esc(group?.name || 'Oops 共用协作群')}</h2><span class="badge gray">${esc(groupText[state.groupStatus] || state.groupStatus)}</span></div><p>${source ? '先以本人身份重新核对这件会议任务，再向选定 Agent 派工。原负责人保持不变。' : '本人手写简报，先保存 Oops 任务，再向明确选择的 Agent 派工。'}</p>${source && memberList ? `<details><summary>查看群成员（${group.members.length}位）</summary>${memberList}</details>` : memberList}${nav ? button('group-open', '进入 Raft 群聊', false) : ''}</section>
        <div class="notice ${group && state.bridgeOnline ? '' : 'warning'}">${esc(groupText[state.groupStatus] || state.groupStatus)}${group ? state.bridgeOnline ? ' · 桥接在线' : ' · 桥接离线，登记后等待发送' : ''}${state.groupError ? `<p>${esc(groupErrorText[state.groupError] || state.groupError)}</p>` : ''}</div>
        ${button('refresh', loaded ? '刷新群、任务与回复' : '读取协作群与任务', !!state.busy)}
        ${source ? `<section class="card"><h3>当前原任务</h3>${source.locator ? `<p class="meta">${esc(source.locator.kind === 'label_review' ? source.locator.source_meeting_id : source.locator.session_id)} · ${esc(source.locator.item_id)}</p>` : '<div class="notice warning">服务或本人身份已变化，请从原任务重新进入并读取。此次来源派工已失效。</div>'}${sourceData ? `<h3>${esc(sourceData.item.title)}</h3><p>${esc(sourceData.item.detail || '')}</p><p class="meta">原负责人：${esc(ownerLabel(sourceData.item.owner))}${sourceData.item.due ? ' · 原时间约定：' + esc(sourceData.item.due) : ''} · 核对版本 ${esc(sourceData.review_revision ?? '未提供')}</p><p class="meta">${sourceData.self_review?.status === 'confirmed' ? '服务器已核对本账号的原事项确认；本次派工还需单独允许。' : '历史整体核对不代表本人此次派工许可，请重新核对。'}</p><details><summary>查看原话依据（${sourceData.evidence.length}句）</summary>${sourceData.evidence.map(evidence => `<blockquote><p>${esc(evidence.text || evidence.quote || '')}</p><cite>${esc(evidence.speaker || '说话人待核对')} · 原话 ${esc(evidence.id || '')}</cite></blockquote>`).join('')}</details>${check('source-confirm', '我已核对当前原任务、负责人和本次简报，以本人账号确认此次派工', source.confirm, !!state.busy || !sourceReady() || sourceHasDispatch())}` : '<div class="notice warning">原任务正文与本人核对合同尚未就绪。来源失效时仅保留历史编号与实际送达事实。</div>'}<button class="button quiet" type="button" data-act="back">回到原任务</button></section>` : ''}
        <div class="section-title"><h2>${source ? '本次派工简报' : '手写协作任务'}</h2></div>
        ${actualTask ? `<div class="notice ${usableTask(actualTask) ? '' : 'warning'}">Oops 任务已保存：${esc(actualTask.id)}。${usableTask(actualTask) ? '重新确认后只派工，不重复新建。' : '来源或许可不可用，停止派工，不另建任务绕过。'}</div>` : ''}
        ${sourceHasDispatch() ? '<div class="notice">这件原任务已有协作线程。查看下方执行回复，补充内容继续发到原线程。</div>' : source && state.tasks.length && !actualTask ? '<div class="notice warning">已保留这件原任务的协作编号，请先查看已有记录或回原任务核对，不重复新建。</div>' : ''}
        ${sourceNewVersionPossible() ? check('source-new-version', '旧版本来源已失效；我选择为当前重新核对的来源版本另建协作任务，旧回执保留', source.newVersion === true, !!state.busy || state.lastWrite?.state === 'unknown') : ''}
        ${field('title', '任务标题', state.draft.title, 200)}${field('text', '任务简报', state.draft.text, 12000, true)}
        <p class="meta">${source ? '仅发送本次明确核对后的简报；原话只供本人核对，不附入整场会议或录音。' : '只发送本次填写的标题与正文，不附入会议、录音或任务资料。'}群内成员可能看到线程内容。</p>
        ${source && !members().some(member => member.id === A1234_AGENT_ID) ? '<div class="notice warning">当前群尚未核对到 a1234 的实际 Agent，不能按同名成员替代发送。</div>' : ''}
        <section class="card"><h3>本次参与 Agent</h3>${memberChecks('members', state.draft.members) || '<p class="meta">先读取并核对群成员。</p>'}</section>
        ${check('confirm', '确认保存这份 Oops 任务，并允许把简报发送到共用群、通知所选 Agent', state.draft.confirm, !!state.busy)}
        ${button('dispatch', actualTask ? '将已保存任务派工' : state.lastWrite?.state === 'retryable' ? '用原编号重试保存并派工' : '保存 Oops 任务并派工', !canDraft, 'primary')}
        <div class="section-title"><h2>${source ? '回到原任务的协作记录' : '已保存的 Oops 任务'}</h2></div>
        ${state.tasks.length ? state.tasks.map(task => `<section class="card"><h3>${esc(task.title || '任务来源已失效')}</h3><p class="meta">${esc(task.id)} · ${esc(task.status || '已保存')}</p><p>${esc(task.text)}</p>${task.kind === 'manual_collaboration' || source ? button('task-use', state.handoffs.some(row => row.task_id === task.id) || task.handoffs?.length ? '查看已有任务线程' : '为这份任务选择 Agent', !usableTask(task) || !!state.busy || state.lastWrite?.state === 'unknown', 'quiet', `data-raft-id="${esc(task.id)}"`) : '<p class="meta">请从原任务入口核对后派工，不能降为手写任务。</p>'}</section>`).join('') : `<p class="meta">${source ? '这件原任务尚未读取到协作记录。' : '尚未读取到手写任务。'}</p>`}
        <div class="section-title"><h2>任务线程</h2></div>
        ${state.handoffs.length ? state.handoffs.map(item => `<button type="button" class="card clickable" data-raft-act="select" data-raft-id="${esc(item.id)}"><div class="card-head"><strong>${esc(item.title)}</strong><span class="badge ${['unknown', 'failed'].includes(item.status) ? 'orange' : ''}">${esc(statusText[item.status] || item.status)}</span></div><p class="meta">${item.replies.length} 条回复 · ${item.reviews.length} 条人工核对</p></button>`).join('') : '<p class="meta">尚未读取到协作线程；送达或收到回复不等于业务完成。</p>'}
        ${row ? `<div class="section-title"><h2>${esc(row.title)}</h2></div><section class="card"><span class="badge">${esc(statusText[row.status] || row.status)}</span><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(row.text)}</p><p class="meta">${esc(row.task_id || '')}</p>${row.transport_error || row.last_error ? `<p class="error-text">${esc(row.transport_error || row.last_error)}</p>` : ''}</section>${taskNav ? button('thread-open', '在 Raft 中打开本任务', false) : ''}${row.status === 'queued' ? button('cancel', '取消尚未发出的简报', !ready(), 'quiet') : ''}
          ${row.replies.map(reply => `<section class="card"><p class="meta">${esc(reply.sender || 'Raft 回复')} · ${esc(reply.created_at || '')}</p><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(reply.text)}</p><div class="action-grid">${button('review-progress', '核对为进展', !ready(), 'secondary', `data-raft-id="${esc(reply.reply_id)}"`)}${button('review-artifact', '核对为成果', !ready(), 'secondary', `data-raft-id="${esc(reply.reply_id)}"`)}</div></section>`).join('') || '<div class="notice">尚未收到这个任务线程的真实回复。</div>'}
          ${row.reviews.map(review => `<section class="card"><span class="badge gray">${review.kind === 'artifact' ? '人工核对成果' : '人工核对进展'}</span><p>${esc(review.note || '')}</p><p class="meta">${esc(review.confirmed_at || '')} · 原回复单独保留</p></section>`).join('')}
          ${row.communications.map(message => `<section class="card"><span class="badge">${esc(statusText[message.status] || message.status)}</span><p>${esc(message.text)}</p></section>`).join('')}
          ${!row.body_unavailable ? `${field('follow-text', '同一线程的补充简报', state.follow.text, 12000, true)}<section class="card"><h3>通知 Agent</h3>${memberChecks('follow-members', state.follow.members)}</section>${check('follow-confirm', '允许把本次补充简报发送到当前任务线程', state.follow.confirm, !!state.busy)}${button('continue', '发送到原任务线程', !ready() || row.status !== 'sent' || !state.follow.confirm || !state.follow.text.trim() || state.follow.text.length > 12000 || !validMembers(state.follow.members), 'primary')}` : '<div class="notice warning">当前仅显示已保存的真实送达事实；旧正文、回复和派工许可不可用。</div>'}` : ''}
        ${state.review ? `<section class="card"><h3>${state.review.kind === 'artifact' ? '核对并记录成果' : '核对并记录进展'}</h3><p class="meta">来源：${esc(state.review.reply.sender || 'Raft')} · ${esc(state.review.reply.reply_id)}</p><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(state.review.reply.text)}</p>${field('review-note', '本次人工核对说明', state.review.note, 1000, true)}${check('review-confirm', '已核对原回复与本次说明，确认单独保存', state.review.confirm, !!state.busy)}${button('review-save', '保存人工核对记录', !ready() || !state.review.confirm || !state.review.note.trim(), 'primary')}${button('review-close', '暂不保存这次核对', !!state.busy, 'quiet')}<p class="meta">不自动验收、交付或完成业务任务。</p></section>` : ''}
        ${feedback()}
      </div>`;
    }
    function syncControls() {
      if (!open()) return;
      const rootNode = root.document?.querySelector('[data-raft-page]'); if (!rootNode) return;
      for (const refreshButton of rootNode.querySelectorAll('[data-raft-act="refresh"]')) refreshButton.disabled = !!state.busy || sourcePollBusy || pending.size > 0;
      const confirm = rootNode.querySelector('[data-raft-field="confirm"]'); if (confirm) confirm.checked = state.draft.confirm;
      const follow = rootNode.querySelector('[data-raft-field="follow-confirm"]'); if (follow) follow.checked = state.follow.confirm;
      const review = rootNode.querySelector('[data-raft-field="review-confirm"]'); if (review) review.checked = !!state.review?.confirm;
      const source = rootNode.querySelector('[data-raft-field="source-confirm"]'); if (source) { source.checked = !!state.source?.confirm; source.disabled = !!state.busy || !sourceReady() || sourceHasDispatch(); }
      const newVersion = rootNode.querySelector('[data-raft-field="source-new-version"]'); if (newVersion) newVersion.checked = state.source?.newVersion === true;
      const send = rootNode.querySelector('[data-raft-act="dispatch"]'); if (send) send.disabled = !ready() || !draftValid() || !state.draft.confirm;
      const compactSend = rootNode.querySelector('[data-raft-act="compact-dispatch"]'); if (compactSend) compactSend.disabled = !compactCanSend();
      const next = rootNode.querySelector('[data-raft-act="continue"]'); if (next) next.disabled = !ready() || selected()?.body_unavailable || selected()?.status !== 'sent' || !state.follow.confirm || !state.follow.text.trim() || state.follow.text.length > 12000 || !validMembers(state.follow.members);
      const save = rootNode.querySelector('[data-raft-act="review-save"]'); if (save) save.disabled = !ready() || !state.review?.confirm || !state.review.note.trim() || state.review.note.length > 1000;
    }
    function input(node) {
      const name = node?.getAttribute?.('data-raft-field'); if (!name || !enabled()) return false;
      if (state.busy) return true;
      if (name === 'title' || name === 'text') { if (state.source && (state.draft.task || sourceHasDispatch() || !state.source.locator)) return true; if (state.draft[name] !== node.value) { state.draft[name] = node.value; state.draft.confirm = false; state.draft.task = null; if (state.source) state.source.confirm = false; if (state.lastWrite?.state === 'retryable') state.lastWrite = null; } }
      else if (name === 'members' || name === 'follow-members') {
        const draft = name === 'members' ? state.draft : state.follow, id = node.getAttribute('data-raft-id');
        if (!members().some(member => member.id === id)) return true;
        draft.members = node.checked ? [...new Set([...draft.members, id])] : draft.members.filter(value => value !== id); draft.confirm = false;
        if (state.lastWrite?.state === 'retryable') state.lastWrite = null;
      } else if (name === 'source-new-version' && state.source) {
        if (!sourceNewVersionPossible() || state.lastWrite?.state === 'unknown') return true;
        state.source.newVersion = node.checked; state.source.confirm = false; state.draft.confirm = false;
        if (node.checked) { const brief = sourceBrief(state.source.data); state.draft.task = null; state.draft.title = brief.title; state.draft.text = brief.text; }
        redraw();
      } else if (name === 'source-confirm' && state.source) { state.source.confirm = node.checked && sourceReady() && !sourceHasDispatch(); state.draft.confirm = false; }
      else if (name === 'confirm') state.draft.confirm = node.checked;
      else if (name === 'follow-text') { state.follow.text = node.value; state.follow.confirm = false; if (state.lastWrite?.state === 'retryable') state.lastWrite = null; }
      else if (name === 'follow-confirm') state.follow.confirm = node.checked;
      else if (name === 'review-note' && state.review) { state.review.note = node.value; state.review.confirm = false; if (state.lastWrite?.state === 'retryable') state.lastWrite = null; }
      else if (name === 'review-confirm' && state.review) state.review.confirm = node.checked;
      syncControls(); return true;
    }
    function action(node) {
      const name = node?.getAttribute?.('data-raft-act'); if (!name) return false;
      if (node.disabled || !enabled() || !open()) return true;
      const id = node.getAttribute('data-raft-id');
      if (name === 'refresh') void refresh();
      else if (name === 'compact-dispatch') dispatchCompact();
      else if (name === 'dispatch') void dispatch();
      else if (name === 'continue') void continueThread();
      else if (name === 'cancel') void cancel();
      else if (name === 'review-save') void saveReview();
      else if (name === 'review-close') { state.review = null; redraw(); }
      else if (name === 'select') { state.selected = id; state.follow = { text: '', members: [], confirm: false }; state.review = null; redraw(); scheduleSourcePoll(); }
      else if (name === 'task-use') {
        const task = state.tasks.find(value => value.id === id); if (!usableTask(task) || state.lastWrite?.state === 'unknown') return true;
        const existing = state.handoffs.find(row => row.task_id === task.id);
        if (existing) { state.selected = existing.id; state.follow = { text: '', members: [], confirm: false }; state.review = null; }
        else if (task.handoffs?.length) notify('此任务已有协作线程，请刷新查询原记录，不重复派工');
        else state.draft = { title: task.title, text: task.text, task, members: [], confirm: false };
        redraw(); scheduleSourcePoll();
      }
      else if (name === 'review-progress' || name === 'review-artifact') { const row = selected(), reply = row?.replies.find(value => value.reply_id === id); if (!reply) return true; state.review = { handoffId: row.id, reply: clone(reply), kind: name === 'review-artifact' ? 'artifact' : 'progress', note: '', confirm: false }; redraw(); }
      else if (name === 'group-open' || name === 'thread-open') { const row = selected(), url = name === 'group-open' ? groupUrl(state.group) : row && (!row.body_unavailable && row.status === 'sent' || state.source?.compact && sourceHasBlockingDispatch()) && row.group_channel_id === state.group?.id ? groupUrl(state.group, row.raft_message_id) : null; if (url) options.send('open.url', { url }); }
      return true;
    }
    root.document?.addEventListener('visibilitychange', () => {
      if (!state.active) return;
      if (root.document.hidden) retire('页面已进入后台，请回来后查询原回执并重新核对', false);
      else { syncContext(); if (enabled()) void refresh(); }
    });
    return {
      html, action, input, receive,
      enter() { state.active = true; syncContext(); if (!enabled()) { resetSourceIntent('当前环境不允许真实协作，请在安装版重新从原任务进入'); return; } if (!loaded && !state.busy) void refresh(); },
      leave() { state.active = false; retire('已离开协作页面，请回到页面查询原回执', false); },
      reset() { resetSourceIntent('服务或本人身份已变化，请从原任务重新进入'); context = ''; state.notice = ''; },
      openSource(reference, returnRoute, mode = {}) {
        syncContext();
        let locator;
        try { locator = sourceLocator(reference); }
        catch (error) { if (state.busy || state.lastWrite?.state === 'unknown') { notify('原请求仍待核对，不能切换来源：' + errorText(error)); return false; } resetSourceIntent(errorText(error)); state.source = { locator: null, returnRoute: null, data: null, confirm: false, initialized: false, unavailableIntent: true, compact: mode.compact === true }; state.error = errorText(error); return false; }
        if (state.busy || state.lastWrite?.state === 'unknown') {
          if (!state.busy && state.source?.locator && stable(state.source.locator) === stable(locator)) { state.source.returnRoute = clone(returnRoute || { name: 'tasks' }); state.source.compact = mode.compact === true; return true; }
          notify('先查询当前原请求的回执，暂不切换或新建另一件任务'); return false;
        }
        retire('已切换原任务，旧核对许可已撤下', true);
        state.source = { locator, returnRoute: clone(returnRoute || { name: 'tasks' }), data: null, confirm: false, initialized: false, revision: null, newVersion: false, compact: mode.compact === true };
        state.error = ''; state.notice = ''; context = contextKey(); return true;
      },
      openManual() {
        syncContext(); if (!state.source) return true;
        if (state.busy || state.lastWrite?.state === 'unknown') { notify('先查询原任务的未知回执，暂不转为新的手写任务'); return false; }
        retire('已明确切换到独立手写协作', true); state.error = ''; state.notice = ''; context = contextKey(); return true;
      },
      sourceReturnRoute() { return state.source?.returnRoute ? clone(state.source.returnRoute) : null; },
      refresh,
    };
  }
  root.OopsRaftCollaboration = { create };
})(typeof window !== 'undefined' ? window : globalThis);
