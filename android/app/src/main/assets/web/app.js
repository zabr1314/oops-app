/* Oops H5 UI. Talks to the native shell through window.OopsNative ({type, payload} JSON, see docs/bridge.md).
   In a desktop browser, bridge-mock.js provides a stand-in. Pages use the design prototype's markup and
   class names (proto.css) so they look the same; the data and actions are ours. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const native = window.OopsDemoTransport || window.OopsNative;
  const send = (type, payload = {}) => {
    if (READ_TYPES.has(type) && payload.requestId) {
      readRequestGenerations.set(payload.requestId, readGeneration);
      if (readRequestGenerations.size > 1000) readRequestGenerations.delete(readRequestGenerations.keys().next().value);
    }
    native.postMessage(JSON.stringify({ type, payload }));
  };
  const params = new URLSearchParams(location.search);
  const deviceDemo = window.OopsDeviceListeningDemo;
  let deviceState = deviceDemo?.create();
  // The live transcript nodes live in index.html and move between pages. Keep handles to them: a page re-render
  // detaches them from the document, after which getElementById can no longer find them.
  const LINES = $('lines'), PARTIAL = $('partial'), HOLDER = $('holder');

  const ASR_TEXT = {
    off: ['识别未连接', ''],
    simulated: ['浏览器模拟识别', 'warn'],
    unconfigured: ['未配置识别密钥', 'bad'],
    connecting: ['识别连接中…', 'warn'],
    live: ['实时识别中', 'live'],
    reconnecting: ['识别重连中…', 'warn'],
    finishing: ['等待最后转写与结束确认…', 'warn'],
    error: ['识别出错', 'bad'],
  };
  const SOURCE_TEXT = { mic: '手机麦克风', wav: '测试音频', remote: 'Mac 收音', bean: '录音豆', bean_sim: '录音豆模拟' };
  const TAG_LABELS = { commitment: '待办', decision: '决定', idea: '想法', constraint: '约束', chitchat: '寒暄', uncertain: '待判断' };
  const MANUAL_OTHER = { other: '其他人', multi: '多人同时说', unclear: '听不清' };

  const S = {
    state: { capturing: false, sessionMs: 0, bufferedMs: 0, retentionMs: 300000, asr: 'off', level: 0, savedCount: 0, asrGaps: [] },
    lines: new Map(), // utterance id → transcript card element
    records: new Map(),
    commitments: [],
    ownerEdits: new Map(), // manual selections remain visible when model hints refresh
    summary: {}, notices: new Map(), activeNotices: [], board: null, expiredBoardSession: null,
    sheet: null, card: null, draft: null, captureError: null,
    playingKey: null, loadingKey: null, latency: null, autoScroll: true, dailyCandidates: [],
    dailyOverview: null, dailyResults: null, dailyRequest: null, dailySerial: 0, dailyStopSession: null, dailyAutoBlocked: false,
    voiceprintName: '', voiceprintDelete: null,
    team: [],
    route: { name: 'home' },
    liveTab: 'live', meetingTab: 'overview', memoryTab: 'meetings', memoryView: 'meetings', memoryQuery: '',
    personal: { items: null, kind: '全部', query: '', listRequest: null, serial: 0, error: null, mutation: null, drafts: new Map(), editKey: null, mock: false },
    personalAuto: { items: null, listRequest: null, mutation: null, error: null, drafts: new Map(), editKey: null, processingStatus: null },
    history: null, historyItems: null, historyFilter: '', historyShowEmpty: false, historyMeta: null, historyTimer: null, transcriptFilter: { speaker: null, query: '' },
    tasks: { scope: 'review', mine: false, status: 'all', items: null, parsedItems: null, meetingItems: null, parsedStatus: null, parsedSerial: 0, reviewFilter: 'all', query: '', cache: new Map(), expanded: new Set(), requests: new Map(), pending: new Set(), timers: new Map(), serial: 0, refreshedAt: null, archived: [], candidateRequest:null, candidateCompat:false }, openTaskCount: 0,
    taskReview: null, taskReviewDrafts: new Map(), taskReviewSerial: 0,
    homeTasks: null, homeTasksState: { loading: false, error: null },
    requests: { history: {}, projects: {}, project: {}, tasks: {} }, pendingMeetingId: null, meetingRequest: null,
    feishu: {status:'loading', account:null, capabilities:{}, recipients:[], knownRecipients:{}, busy:false}, deliveries: new Map(), feishuSerial:0,
    minutes: new Map(), minutesRequest: 0, remoteEpoch: null, pendingRetention: null, retentionRequest: 0,
    projects: { items: null, open: null, section: 'decisions' }, liveProject: null,
    review: null, pendingReview: null, itemTaskRequest: null, itemTaskSerial: 0, sessionsQuery: '', homeQuery: '',
    historySerial: 0, historyRequestId: null, searchRequestId: null, pendingDelete: null, deletedSessions: new Set(), pendingReviewReturn: false, externalReviewHidden: false, settingsSave: null,
  };

  // Read previews live only as long as the native source lease. A cached first reply never
  // settles its request; the following checked reply owns timers, mutations and ready notices.
  const readLeases = new Map(), readRequestGenerations = new Map(), checkedReadKeys = new Set(), unavailableReadSources = new Set();
  const READ_TYPES = new Set(['history.list','history.open','history.minutes','projects.list','project.open','tasks.list','tasks.candidates']);
  let readGeneration = 0, readNeedsCheck = false, invalidatingReadSource = false;
  let readLeaseTimer = null;
  const readFinal = p => p.read_cache?.state !== 'cached' && p.read_cache?.final !== false;
  const readCached = p => p.read_cache?.state === 'cached';
  const readValid = key => (readLeases.get(key)?.until || 0) > Date.now();
  const readInvalid = p => p.sourceInvalid === true || [401, 403, 404, 410].includes(Number(p.httpStatus));
  function forgetReadLease(key) { readLeases.delete(key); scheduleReadLeases(); }
  function clearReadLeases() { clearTimeout(readLeaseTimer); readLeaseTimer = null; readLeases.clear(); }
  function scheduleReadLeases() {
    clearTimeout(readLeaseTimer); readLeaseTimer = null;
    if (!readLeases.size) return;
    const foreground = !document.hidden && navigator.onLine !== false;
    const until = Math.min(...[...readLeases.values()].map(value => foreground && value.renew && !value.renewed ? Math.min(value.until, value.renewAt) : value.until));
    readLeaseTimer = setTimeout(expireReadLeases, Math.max(0, until - Date.now()));
  }
  function expireReadLeases() {
    const at = Date.now();
    for (const [key, lease] of readLeases) {
      if (lease.until <= at) { readLeases.delete(key); lease.expire(); }
      else if (!document.hidden && navigator.onLine !== false && lease.renew && !lease.renewed && lease.renewAt <= at) {
        lease.renewed = true; lease.renew();
      }
    }
    scheduleReadLeases();
  }
  function acceptRead(key, p, expire, renew = null) {
    // A response started before a known invalidation cannot restore any derived source copy.
    if (p.requestId && readRequestGenerations.get(p.requestId) !== readGeneration) return false;
    if (readNeedsCheck && (!p.requestId || readCached(p) && !checkedReadKeys.has(key))) return false;
    const meta = p.read_cache;
    if (!meta) { if (readFinal(p)) checkedReadKeys.add(key); forgetReadLease(key); return true; } // Older backends and isolated browser examples.
    const checked = Number(meta.checked_at_ms), expires = Number(meta.expires_at_ms);
    const until = Math.min(expires, checked + 60000);
    if (!Number.isFinite(checked) || checked <= 0 || !Number.isFinite(until) || until <= Date.now()) return false;
    if (readFinal(p)) checkedReadKeys.add(key);
    readLeases.set(key, { until, expire, renew, renewAt: Math.max(Date.now(), until - 5000), renewed: false }); scheduleReadLeases(); return true;
  }
  function invalidateReadSource(p) {
    if (!readInvalid(p)) return false;
    if (invalidatingReadSource) return true;
    invalidatingReadSource = true;
    try {
      const unauthorized = [401,403].includes(Number(p.httpStatus));
      const sid = p.sessionId || p.session_id;
      if (sid) unavailableReadSources.add(sid);
      readGeneration++; readNeedsCheck = true; checkedReadKeys.clear(); readRequestGenerations.clear(); clearReadLeases();
      clearTimeout(S.historyTimer); S.historyTimer = null; clearTimeout(S.meetingRequest?.timer);
      minutesSync?.reset(); clearTimeout(minutesReadyTimer); minutesReadyCount = 0;
      const message = p.message || (unauthorized ? '访问权限已变化，请重新连接后读取。' : '会议来源已失效，请重新读取当前内容。');
      S.history = null; S.historyItems = null; S.historyMeta = null; S.minutes.clear();
      S.projects.items = null; S.projects.open = null; S.liveProject = null;
      S.historyRequestId = null; S.searchRequestId = null; S.meetingRequest = {active:false};
      S.pendingMeetingId = null; S.pendingReview = null; S.pendingTools = null;
      S.requests.history = {error:message}; S.requests.projects = {error:message}; S.requests.project = {error:message};
      for (const timer of S.tasks.timers.values()) clearTimeout(timer);
      S.tasks.timers.clear(); S.tasks.requests.clear(); S.tasks.pending.clear();
      clearTimeout(S.tasks.candidateRequest?.timer); S.tasks.candidateRequest = null;
      S.tasks.parsedItems = null; S.tasks.meetingItems = null; S.tasks.parsedSerial = 0; S.tasks.refreshedAt = null; S.tasks.reviewer = null;
      S.tasks.parsedStatus = {state:'unavailable',meetings:[],message}; S.tasks.candidateError = message; S.tasks.candidateCompat = false;
      // Formal task receipts are independent business records; withdraw their old meeting evidence.
      const receipt = item => ({...item,quote:null,meeting:null,source_status:'unavailable',source_reason:'source_unavailable',feishu:{...item.feishu,stale:true}});
      if (unauthorized) { S.tasks.items = null; S.tasks.archived = []; S.tasks.cache.clear(); S.homeTasks = null; S.openTaskCount = 0; }
      else {
        S.tasks.items = S.tasks.items?.map(receipt) || null; S.tasks.archived = S.tasks.archived.map(receipt); S.homeTasks = S.homeTasks?.map(receipt) || null;
        for (const cached of S.tasks.cache.values()) {
          cached.items = cached.items.map(receipt); cached.archived = cached.archived.map(receipt);
          cached.parsedItems = null; cached.meetingItems = null; cached.parsedStatus = S.tasks.parsedStatus;
        }
      }
      S.requests.tasks = {error:message}; S.homeTasksState = {error:message};
      const review = S.taskReview;
      if (review && (review.payload || ['saving','unconfirmed'].includes(review.status))) {
        review.data = null; review.readInvalidated = true; review.error = message;
        clearTimeout(review.recheckTimer); review.recheckRequestId = null;
        // The original write ID, exact payload and its pending timer remain available for reconciliation.
      } else { clearTimeout(review?.timer); S.taskReview = null; }
      if (S.board && (unauthorized || !sid || S.board.session_id === sid)) S.board = null;
      if (S.card?.data?.readOnly) S.card = null;
      if (S.playingKey || S.loadingKey) send('clip.stop'); S.playingKey = null; S.loadingKey = null;
      const close = ['minutesSource','projectPick','pending','requestError','review','items','rename','retain','card'].includes(S.sheet?.kind)
        || S.sheet?.kind === 'tools' && !S.sheet.live || S.sheet?.kind === 'taskReview' && !S.taskReview;
      if (close) closeSheet();
      if (S.route.name === 'meeting') S.route = {name:'sessions'};
      if (S.route.name === 'project') S.route = {name:'memory'};
      renderNav(); refreshReadUi();
      return true;
    } finally { invalidatingReadSource = false; }
  }
  function refreshReadUi() {
    const top = $('scroll').scrollTop; render(); $('scroll').scrollTop = top;
    if (S.sheet) renderSheet();
  }
  function expireHistoryList() {
    S.historyItems = null; S.historyMeta = null;
    S.requests.history = { ...S.requests.history, error: '上次内容已过期，请重新读取当前会议列表。' };
    refreshReadUi();
  }
  function expireMeeting(sid) {
    if (S.history?.session_id !== sid) return;
    S.history = null; S.minutes.delete(sid); S.deliveries.delete(sid);
    if (S.card?.data?.readOnly && (S.card.data.sessionId === sid || S.card.data.pool?.some(row => row.sessionId === sid))) { S.card = null; if (S.sheet?.kind === 'card') closeSheet(); }
    if (S.draft && !S.draft.submitted && S.draft.sourceSessionId === sid) { S.draft = null; if (S.sheet?.kind === 'draft') closeSheet(); }
    if (S.playingKey || S.loadingKey) send('clip.stop'); S.playingKey = null; S.loadingKey = null;
    if (S.sheet && ['tools','review','items','minutesSource','rename','retain','itemTaskPending'].includes(S.sheet.kind)) closeSheet();
    if (S.route.name === 'meeting') { S.route = { name: 'sessions' }; S.requests.history = { ...S.requests.history, error: '会议内容需要重新核对，已收起上次正文。' }; renderNav(); }
    refreshReadUi();
  }
  function expireMinutes(sid) {
    const entry = S.minutes.get(sid);
    if (entry) S.minutes.set(sid, { requestId: entry.requestId, loading: entry.loading, automatic: entry.automatic, error: '上次纪要已过期，请重新查询当前结果。' });
    if (S.sheet?.kind === 'minutesSource' && S.sheet.sessionId === sid) closeSheet();
    patchMinutesUi(sid);
  }
  function expireProjects() { S.projects.items = null; S.requests.projects = { ...S.requests.projects, error: '上次项目列表已过期，请重新读取。' }; refreshReadUi(); }
  function expireProject(name) {
    if (S.projects.open?.name === name) S.projects.open = null;
    if (S.route.name === 'project' && S.route.name_ === name) S.requests.project = { ...S.requests.project, error: '上次项目内容已过期，请重新读取。' };
    refreshReadUi();
  }
  function expireTaskList(key, mine, status) {
    S.tasks.cache.delete(key);
    if (key === taskKey(S.tasks.mine, S.tasks.status)) { S.tasks.items = null; S.tasks.archived = []; S.requests.tasks = { ...S.requests.tasks, error: '上次任务列表已过期，请重新读取。' }; }
    if (mine && status === 'open') { S.homeTasks = null; S.openTaskCount = 0; S.homeTasksState = { ...S.homeTasksState, error: '上次任务列表已过期，请重新读取。' }; renderNav(); }
    refreshReadUi();
  }
  function expireTaskCandidates() {
    S.tasks.parsedItems = null; S.tasks.meetingItems = null; S.tasks.refreshedAt = null; S.tasks.reviewer = null;
    S.tasks.parsedStatus = { state: 'unavailable', meetings: [], message: '上次会议候选已过期，请重新读取。' };
    for (const cached of S.tasks.cache.values()) { cached.parsedItems = null; cached.meetingItems = null; cached.parsedStatus = S.tasks.parsedStatus; }
    if (S.sheet?.kind === 'taskReview') {
      if (S.taskReview?.payload || ['saving','unconfirmed'].includes(S.taskReview?.status)) { S.taskReview.data = null; S.taskReview.readInvalidated = true; S.taskReview.error = '依据需要重新读取；原保存请求仍保留。'; }
      else { clearTimeout(S.taskReview?.timer); S.taskReview = null; closeSheet(); }
    }
    refreshReadUi();
  }

  const projectListVisible = () => S.route.name === 'memory' && S.memoryTab !== 'personal' && S.memoryView === 'projects' || S.sheet?.kind === 'projectPick';
  const taskListVisible = (mine, status) => S.route.name === 'tasks' && !!mine === S.tasks.mine && status === S.tasks.status
    || S.route.name === 'home' && mine && status === 'open'
    || S.route.name === 'memory' && S.memoryTab !== 'personal' && S.memoryView === 'projects' && !mine && status === 'all';
  const candidatesVisible = () => ['home','tasks'].includes(S.route.name) || S.route.name === 'memory' && S.memoryTab !== 'personal';
  function renewVisibleMeeting(sid) {
    if (S.route.name !== 'meeting' || S.route.id !== sid || S.history?.session_id !== sid || S.meetingRequest?.active) return;
    const requestId = `open-${++S.historySerial}`;
    const request = { sessionId: sid, requestId, active: true, background: true, previewShown: true, memoryOrigin: validMemoryOrigin(S.route.memoryOrigin) };
    S.meetingRequest = request;
    request.timer = setTimeout(() => {
      if (S.meetingRequest === request && request.active) onError({ scope: 'history', operation: 'history.open', sessionId: sid, requestId, message: '会议内容尚未更新，请重新读取。' });
    }, 25000);
    send('history.open', { sessionId: sid, requestId });
  }

  // ---- helpers --------------------------------------------------------------------------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const hms = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  };
  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分 ${s % 60} 秒前`;
  };
  const speakerLabel = (id) => {
    if (id == null || id === '') return '';
    const n = parseInt(id, 10);
    return Number.isNaN(n) ? String(id) : `说话人 ${String.fromCharCode(65 + n)}`;
  };
  const manualLabel = (v) => MANUAL_OTHER[v] || speakerLabel(v);
  const initial = (name) => (name ? [...String(name)][0] : '?');
  // Avatars: "说话人 B" shows B rather than 说; the user is always colour 1, everyone else keeps a stable colour 2–6.
  const avatarText = (name) => /^说话人 ([A-Z])$/.exec(name || '')?.[1] || initial(name);
  function speakerTone(key) {
    if (key == null || key === '' || MANUAL_OTHER[key]) return '';
    if (S.state.selfName && key === S.state.selfName) return 'spk-1';
    let h = 0;
    for (const c of String(key)) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return `spk-${(/^\d+$/.test(String(key)) ? Number(key) : h) % 5 + 2}`;
  }
  const levelMeter = (id) => `<span class="level-meter is-idle" id="${id}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;
  const hasTimeZone = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const originalDate = value => /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(String(value))
    ? `原记录时间 ${String(value).replace('T', ' ')} · 时区未记录` : '原记录时间无效 · 时区未记录';
  const formatDate = (iso) => {
    if (iso && !hasTimeZone(iso)) return originalDate(iso);
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const shortDate = (iso) => {
    if (iso && !hasTimeZone(iso)) return originalDate(iso);
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // Icons are drawn as a mask over the text colour (oops-design.css), so they follow selected, disabled and danger states.
  const icon = (name, size = 22) => `<span class="icon" aria-hidden="true" style="--icon:url(icons/${name}.svg);--icon-size:${size}px"></span>`;
  // Pupu (pupu.js) appears only at emotional moments: empty, not found, done, waiting. Plain icon if the script is missing.
  const pupu = (mood, fallback, opts) => window.OopsPupu ? window.OopsPupu.svg(mood, opts) : icon(fallback, 28);
  const emptyArt = (mood, fallback, opts) => `<span class="empty-art">${pupu(mood, fallback, opts)}</span>`;
  const meetingName = (m) => m.title || m.display_title || m.goal || '会议';
  const reviewPending = (i) => Object.values(i.review_pending || {}).reduce((a, b) => a + b, 0);
  // Meetings over an hour read 1:23:04, shorter ones 18:24, as in the prototype.
  const duration = (m) => {
    if (!m.ended_at || !hasTimeZone(m.started_at) || !hasTimeZone(m.ended_at)) return '';
    const ms = new Date(m.ended_at) - new Date(m.started_at);
    return ms >= 3600000 ? `${Math.floor(ms / 3600000)}:${mmss(ms % 3600000)}` : mmss(ms);
  };

  let toastTimer = null;
  /** 设计语言 Toast: a small slip (a failed request, missing input, a changed source) brings Pupu's oops; a finished
      save brings happy. Deleting, clearing, stopping and plain notices stay neutral, without the mascot. */
  function toastTone(message, bad) {
    if (bad || /^(先|请|选择)|填写|不能|不允许|无法|失败|未能|已变化|缺失/.test(message)) return 'oops';
    if (/删除|移除|撤销|撤回|关闭|清除|清空|停止|结束|取消|解除|忽略|需要|重新|待|未/.test(message)) return 'neutral';
    return /已保存|保存成功|已确认|已核对|已创建|已建|已添加|已更新|已记录|已开始|已复制|已恢复|已采纳|已标记|已连接|已配对/.test(message) ? 'success' : 'neutral';
  }
  function toast(message, bad = false) {
    const t = $('toast');
    const tone = toastTone(message, bad);
    const mascot = tone !== 'neutral' && window.OopsPupu ? window.OopsPupu.svg(tone === 'oops' ? 'oops' : 'happy', { still: true }).replace('class="pupu', 'class="toast-pupu pupu') : '';
    t.innerHTML = `${mascot}<span>${esc(message)}</span>`;
    t.setAttribute('role', tone === 'oops' ? 'alert' : 'status');
    t.classList.toggle('bad', bad);
    t.classList.toggle('is-oops', tone === 'oops');
    t.classList.toggle('is-success', tone === 'success');
    t.hidden = true;
    void t.offsetWidth; // a new message pops in again even if the last one is still showing
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  function applyInsets(i) {
    if (!i) return;
    const root = $('root');
    root.style.setProperty('--mobile-status-bar-height', `${i.top || 0}px`);
    root.style.setProperty('--mobile-safe-area-height', `${i.bottom || 0}px`);
  }
  // ?frame=ios lays the page out like the prototype's iPhone frame, for side-by-side screenshots.
  if (params.get('frame') === 'ios') applyInsets({ top: 54, bottom: 34 });
  else applyInsets({ top: 0, bottom: 0 });

  // ---- messages from native -------------------------------------------------------------

  native.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    try { handle(msg.type, msg.payload || {}); } catch (e) { console.error(e); }
  };

  const raft = (window.OopsDemoRaft || window.OopsRaftCollaboration).create({send, getState:()=>S.state, getEpoch:()=>S.remoteEpoch, getIdentity:()=>feishuAccountKey(), isOpen:()=>S.route.name==='raft', render, toast});
  function handle(type, p) {
    if (raft.receive(type, p)) return;
    const remote = ['feishu.status', 'feishu.authorization', 'feishu.recipients', 'minutes.delivery', 'history.list', 'history.open', 'history.minutes', 'history.delete', 'history.search', 'history.renamed', 'projects.list', 'project.open', 'meeting.project', 'meeting.retained', 'speaker.corrected', 'review.saved', 'items.saved', 'tasks.list', 'tasks.candidates', 'tasks.review.open', 'tasks.review.saved', 'tasks.board'].includes(type)
      || type === 'error' && ['history', 'minutes', 'projects', 'review', 'items', 'items.task', 'tasks', 'taskCandidates', 'taskReview', 'retention', 'feishu', 'minutes.delivery'].includes(p.scope);
    if (remote) {
      if ('backendUrl' in p && S.state.backendUrl !== undefined && p.backendUrl !== S.state.backendUrl) return;
      if (p.serviceEpoch !== undefined && S.remoteEpoch !== null && p.serviceEpoch !== S.remoteEpoch) return;
      if (p.serviceEpoch !== undefined && S.remoteEpoch === null) S.remoteEpoch = p.serviceEpoch;
      if (type !== 'history.delete' && S.deletedSessions.has(p.sessionId || p.session_id)) return;
    }
    if (minutesSync?.receive(type, p)) return;
    switch (type) {
      case 'snapshot':
        if (params.get('frame') !== 'ios') applyInsets(p.insets);
        resetTranscript();
        S.state.sessionId = p.state.sessionId; // the snapshot already is this session's transcript
        S.team = p.team || S.team;
        (p.transcript || []).forEach(addLine);
        setState(p.state);
        if (p.summary) setSummary(p.summary);
        S.board = acceptedTaskBoard(p.board);
        if (p.pendingActions?.length) {
          openDraft(p.pendingActions[0].draft);
          onActionResult(p.pendingActions[0].result);
        }
        enter();
        render();
        resumeMinutesSync();
        break;
      case 'state': setState(p); break;
      case 'capture.assetsExpired': {
        S.expiredBoardSession = S.state.sessionId;
        const retainedBoard = acceptedTaskBoard(S.board);
        closeSheet(); resetTranscript(); S.board = retainedBoard; S.card=null;
        if(S.draft && !S.draft.submitted) S.draft=null;
        toast('完整文字已按期限清理，独立确认的任务与短依据保留'); render(); break;
      }
      case 'capture.cleared':
        if (p.session_id && S.state.sessionId && p.session_id !== S.state.sessionId) break;
        if (!['dailyResults','dailyConfirm'].includes(S.sheet?.kind)) closeSheet();
        resetTranscript(); S.card = null; S.draft = null;
        setState({capturing:false,sessionId:'',sessionMs:0,bufferedMs:0,analysisPending:0}); render(); break;
      case 'daily.candidates':
        if (p.requestId && p.requestId === S.dailyRequest?.requestId) break;
        if (p.requestId || S.dailyRequest || S.sheet?.kind === 'dailyResults') break;
        S.dailyCandidates = p.items || []; openSheet({kind:'dailyCandidates'}); break;
      case 'daily.results': onDailyResults(p); break;
      case 'daily.ended': {
        S.dailyOverview = p;
        const expected = S.dailyStopSession;
        S.dailyStopSession = null;
        if (p.auto_open && !S.dailyAutoBlocked && !S.state.capturing && !S.sheet && !S.dailyRequest && (!expected || expected === p.session_id)) {
          S.dailyRequest = null; S.dailyResults = p; S.dailyCandidates = p.candidates || [];
          openSheet({kind:'dailyResults', sessionId:p.session_id});
        }
        render(); break;
      }
      case 'backend.changed': {
        const changed = S.remoteEpoch !== p.serviceEpoch;
        const urlChanged = p.backend !== S.state.backend || p.backendUrl !== S.state.backendUrl;
        setState({ backend: p.backend, backendUrl: p.backendUrl });
        S.remoteEpoch = p.serviceEpoch;
        if (changed && !urlChanged) { clearRemoteState(); enter(); render(); }
        resumeMinutesSync();
        break;
      }
      case 'notice': showNotice(p); break;
      case 'personal.result': onPersonalResult(p); break;
      case 'personal.candidates.result': onPersonalCandidatesResult(p); break;
      case 'personal.candidates.changed':
        if ((S.route.name === 'memory' && S.memoryTab === 'personal' || ['personalAutoReview','personalAutoDiscard'].includes(S.sheet?.kind)) && !personalBusy()) { loadPersonalCandidates(); loadPersonal(); }
        break;
      case 'history.list':
        if (p.requestId && p.requestId !== S.historyRequestId) break;
        if (!S.requests.history.loading) break;
        if (!Array.isArray(p.items)) { onError({ scope: 'history', operation: 'history.list', requestId: p.requestId, message: '会议列表回包不完整，请重新读取。' }); break; }
        if (!acceptRead('history.list', p, expireHistoryList)) break;
        if (readFinal(p)) { clearTimeout(S.historyTimer); S.historyTimer = null; S.requests.history = {}; }
        S.historyItems = p.items.filter(x => !S.deletedSessions.has(x.session_id)); S.historyMeta = p;
        if (readFinal(p) && readNeedsCheck) resumeMinutesSync();
        if (['home', 'sessions', 'memory'].includes(S.route.name)) render(); if (S.sheet?.kind === 'history') renderSheet(); break;
      case 'history.open': historyOpen(p); break;
      case 'history.minutes': onMinutes(p); break;
      case 'feishu.status': onFeishuStatus(p); break;
      case 'feishu.authorization': onFeishuAuthorization(p); break;
      case 'feishu.recipients':
        if (p.requestId !== S.feishu.recipientRequestId) break;
        S.feishu.recipientSource = p.source; S.feishu.recipientSearched = true; S.feishu.recipients = p.items || []; S.feishu.knownRecipients ||= {}; S.feishu.recipients.forEach(person => { S.feishu.knownRecipients[deliveryPersonId(person)] = person; }); S.feishu.recipientsLoading = false; S.feishu.recipientsError = p.message || null;
        if (S.sheet?.kind === 'minutesDelivery') renderSheet(); break;
      case 'minutes.delivery': onMinutesDelivery(p); break;
      case 'meeting.retained': {
        const pending=S.pendingRetention;
        if (!pending || pending.requestId!==p.requestId || pending.sessionId!==p.sessionId) break;
        S.pendingRetention=null;
        if (S.history?.session_id===p.sessionId) { S.history.retained_evidence=p.retained_evidence || [];S.history.retained_summaries=p.retained_summaries || []; }
        if (S.sheet?.kind==='retain') closeSheet();
        toast('已单独保留本人确认的内容');render();break;
      }
      case 'history.delete': onHistoryDeleted(p); break;
      case 'history.search': if (!p.requestId || p.requestId === S.searchRequestId) historySearch(p); break;
      case 'history.renamed': onRenamed(p); break;
      case 'projects.list':
        if (p.requestId && p.requestId !== S.requests.projects.requestId) break;
        if (!acceptRead('projects.list', p, expireProjects, () => { if (projectListVisible()) loadProjects(); })) break;
        S.projects.items = p.items || []; if (readFinal(p)) S.requests.projects = {};
        if (S.route.name === 'memory') render(); if (S.sheet?.kind === 'projectPick') renderSheet(); break;
      case 'project.open':
        if (p.name !== S.route.name_ || p.requestId && p.requestId !== S.requests.project.requestId) break;
        if (!acceptRead(`project.open:${p.name}`, p, () => expireProject(p.name), () => { if (S.route.name === 'project' && S.route.name_ === p.name) loadProject(); })) break;
        S.projects.open = visibleProject(p); if (readFinal(p)) S.requests.project = {};
        if (S.route.name === 'project') render(); break;
      case 'meeting.project': onMeetingProject(p); break;
      case 'speaker.corrected': onSpeakerCorrected(p); break;
      case 'review.saved': onReviewSaved(p); break;
      case 'items.saved': onItemsSaved(p); break;
      case 'tasks.list': onTasks(p); break;
      case 'tasks.candidates': onTaskCandidates(p); break;
      case 'tasks.review.open': onTaskReview(p, false); break;
      case 'tasks.review.saved': onTaskReview(p, true); break;
      case 'settings.saved':
        if (S.settingsSave?.requestId !== p.requestId) break;
        S.settingsSave = { ...S.settingsSave, status: 'saved' }; updateSettingsSaveStatus(); break;
      case 'voiceprint.open': openSheet({ kind: 'voiceprint' }); break;
      case 'insets': if (params.get('frame') !== 'ios') applyInsets(p); break;
      case 'asr.partial':
        PARTIAL.textContent = p.text ? `… ${p.text}` : '';
        scrollToEnd();
        break;
      case 'asr.final':
        PARTIAL.textContent = '';
        if (!S.lines.has(p.id)) { addLine(p); markNew(S.lines.get(p.id)); }
        renderLiveRecent();
        break;
      case 'asr.speaker': setLineSpeaker(p.id, p.speaker, p.segments, p.score, p.speakerState, p.speakerPreview, p.candidates, p.trialSegments); break;
      case 'asr.tag':
        if (S.records.has(p.id)) {
          // A tag can land after the speaker answer; it must not reset speaker, split or hint fields.
          S.records.set(p.id, { ...S.records.get(p.id), tag: p.tag, tagProb: p.tagProb, tagEngine: p.tagEngine });
          renderLine(p.id);
        }
        break;
      case 'session.summary': setSummary(p); break;
      case 'tasks.board':
        if (!taskBoardAllowed(p.session_id)) break;
        if (typeof p.sourceRevision === 'number' && p.sourceRevision < (S.state.boardSourceRevision || 0)) break;
        if (typeof p.sourceRevision === 'number') S.state.boardSourceRevision = p.sourceRevision;
        if ('invalidatedSourceIds' in p) {
          if (p.invalidatedSourceIds === null) invalidateDraftEvidence(p.session_id);
          else if (Array.isArray(p.invalidatedSourceIds)) p.invalidatedSourceIds.forEach(id => invalidateDraftEvidence(p.session_id, id));
        } else if (p.invalidated) invalidateDraftEvidence(p.session_id);
        S.board = p.invalidated ? null : acceptedTaskBoard(p);
        if (S.route.name === 'live' && S.liveTab !== 'transcript') render();
        break;
      case 'transcript.pruned':
        const removed = new Set(p.ids || []);
        (p.ids || []).forEach(removeLine);
        if (S.state.recordingMode !== 'meeting') {
          S.board = null;
          let close = false;
          if (S.card?.data.pool?.some(u => removed.has(u.id))) { S.card = null; close = S.sheet?.kind === 'card'; }
          if (S.draft && !S.draft.submitted && S.draft.data.evidence?.utteranceIds?.some(id => removed.has(id))) { S.draft = null; close ||= S.sheet?.kind === 'draft'; }
          if (close) closeSheet();
          (p.ids || []).forEach(id => S.ownerEdits.delete(id));
        }
        S.pruned = true;
        break;
      case 'recall.pending':
        setBusy(true);
        openSheet({ kind: 'pending', title: '找回原话', sub: '按时间和语义定位刚才的原话' });
        break;
      case 'recall.card':
        setBusy(false);
        openCard(p);
        break;
      case 'recall.notFound':
        setBusy(false);
        openSheet({ kind: 'notFound', reason: p.reason });
        break;
      case 'clip.state': onClip(p); break;
      case 'recall.saved':
        S.state.savedCount = p.savedCount;
        renderStatus();
        toast('已保存到长期记忆');
        if (S.sheet?.kind === 'card' && S.card?.data.id === p.cardId) closeSheet();
        break;
      case 'action.draft': if (p.requestId || p.sourceItemId) onItemTaskDraft(p); else openDraft(p); break;
      case 'action.suggestion':
        if (window.OopsDraftState.merge(S.draft, p) && S.sheet?.kind === 'draft') renderSheet();
        break;
      case 'action.result': onActionResult(p); break;
      case 'latency': S.latency = p; break;
      case 'saved.items': openSheet({ kind: 'saved', items: p.items || [] }); break;
      case 'toast': toast(p.message); break;
      case 'error': onError(p); break;
      default: break;
    }
  }

  // ---- state ----------------------------------------------------------------------------

  function setState(s) {
    // A new capture session starts an empty timeline; old lines and cards no longer apply.
    if (s.sessionId && s.sessionId !== S.state.sessionId) {
      S.captureError = null;
      resetTranscript(); S.dailyStopSession = null;
      if (['dailyResults', 'dailyConfirm'].includes(S.sheet?.kind)) closeSheet();
      S.dailyRequest = null;
    }
    const before = { capturing: S.state.capturing, control: S.state.captureControl, asr: S.state.asr, controlError: S.state.captureControlError, sessionId: S.state.sessionId, selfName: S.state.selfName, recordingMode: S.state.recordingMode, transcriptExpired: S.state.transcriptExpired, voiceprint: voiceprintViewKey(S.state.voiceprint),
      preview: S.state.speakerPreviewEnabled, ready: S.state.sourceReady, boardSourceRevision: S.state.boardSourceRevision,
      recordingArchiveMessage: S.state.recordingArchiveMessage, recordingsBlocked: S.state.recordingsBlocked };
    const serverChanged = ('backend' in s && S.state.backend !== undefined && s.backend !== S.state.backend)
      || ('backendUrl' in s && S.state.backendUrl !== undefined && s.backendUrl !== S.state.backendUrl);
    if (serverChanged) { clearRemoteState(); S.remoteEpoch = null; }
    if ('selfName' in s && s.selfName !== S.state.selfName) clearTaskIdentity();
    S.state = { ...S.state, ...s };
    if (s.capturing) S.dailyAutoBlocked=false;
    if (S.state.transcriptExpired) S.expiredBoardSession = S.state.sessionId;
    S.board = acceptedTaskBoard(S.board);
    if (deviceState && S.state.capturing) deviceState = deviceDemo.reduce(deviceState, { type: 'occupied' },
      { activeSessionId: S.state.sessionId || 'native-pending' });
    if (serverChanged) enter();
    if (before.selfName !== S.state.selfName) {
      if (S.route.name === 'home' && canReadMyTasks()) loadHomeTasks();
      if (S.route.name === 'tasks') openTasks();
    }
    if (s.notices) { S.notices = new Map(s.notices.map(n => [n.id,n])); S.activeNotices = S.activeNotices.filter(id => S.notices.has(id)); renderNoticeBanners(); }
    if (before.preview !== S.state.speakerPreviewEnabled) S.records.forEach((_, id) => renderLine(id));
    if (S.sheet?.kind === 'voiceprint' && before.voiceprint !== voiceprintViewKey(S.state.voiceprint)) renderSheet();
    if (S.sheet?.kind === 'memoryPeople' && before.voiceprint !== voiceprintViewKey(S.state.voiceprint)) renderSheet();
    // Starting or stopping changes which controls a page shows; level and time only update text in place.
    if (serverChanged || before.control !== S.state.captureControl || before.controlError !== S.state.captureControlError || before.recordingMode !== S.state.recordingMode || before.transcriptExpired !== S.state.transcriptExpired || before.capturing !== S.state.capturing || before.sessionId !== S.state.sessionId || before.ready !== S.state.sourceReady || before.selfName !== S.state.selfName || before.boardSourceRevision !== S.state.boardSourceRevision || S.route.name === 'settings' && (before.recordingArchiveMessage !== S.state.recordingArchiveMessage || before.recordingsBlocked !== S.state.recordingsBlocked)) {
      // Starting voice enrollment must not navigate away and cancel its sheet.
      if (S.state.capturing && !before.capturing && S.route.name !== 'live' && S.sheet?.kind !== 'voiceprint') go('live');
      else render();
    } else {
      if (before.asr !== S.state.asr && S.state.captureControl === 'paused') renderRecordingControls();
      renderStatus();
    }
  }

  function resetTranscript() {
    S.liveProject = null;
    LINES.innerHTML = '';
    S.lines.clear();
    S.records.clear();
    S.commitments = []; S.summary = {}; S.board = null; S.notices.clear(); S.activeNotices = []; S.noticesShown = new Set(); renderNoticeBanners();
    S.ownerEdits.clear();
    PARTIAL.textContent = '';
    S.pruned = false;
    S.autoScroll = true;
  }

  function setSummary(p) {
    if (p.sessionId !== S.state.sessionId) return;
    p = { ...p, commitments: (p.commitments || []).map((u) => u.reviewStatus === 'confirmed' ? u : { ...u, ...(S.ownerEdits.get(u.id) || {}) }) };
    S.summary = p; S.commitments = p.commitments || [];
    if (S.route.name === 'live' && S.liveTab !== 'transcript') render();
    if (S.sheet?.kind === 'commitments') renderSheet();
  }

  /** Text that changes many times a second (time, status) is patched in place so forms and scroll survive. */
  function renderStatus() {
    const s = S.state;
    const set = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };
    updateVoiceprintProgress();
    set('rc-time', mmss(s.sessionMs));
    set('live-elapsed', mmss(s.sessionMs));
    const [text] = liveStatus();
    set('live-rec-title', text);
    set('live-rec-sub', liveDetail());
    set('rc-status', s.capturing ? captureSourceLabel() : '已停止');
    set('rc-saved', `已保存 ${s.savedCount ?? 0}`);
    set('home-record-time', mmss(s.sessionMs));
    set('home-record-status', captureSourceLabel());
    set('home-record-people', homePeopleSummary());
    // Input level from native (0–1, twice a second) drives the meters; flat while nothing is coming in.
    const level = Math.max(0, Math.min(1, Number(s.level) || 0)).toFixed(2), idle = !s.capturing || !s.sourceReady;
    const navRecord = $('nav-record');
    if (navRecord && navRecord.style) navRecord.style.setProperty('--level', idle ? '0' : level);
    for (const id of ['home-level', 'rc-level']) {
      const el = $(id);
      if (el) { el.style.setProperty('--level', level); el.classList.toggle('is-idle', idle); }
    }
    document.querySelectorAll('.pupu-listening').forEach((el) => el.style.setProperty('--level', idle ? '0' : level));
    const warn = $('live-warn');
    if (warn) { const w = warnings(); warn.hidden = !w.length; warn.textContent = w.join('；'); }
    if (S.route.name === 'settings') set('diag', diagText());
    if (S.sheet?.kind === 'card') {
      const el = $('card-ago');
      if (el) el.textContent = ago(s.sessionMs - S.card.data.items[S.card.sel].endMs);
    }
  }

  function homePeopleSummary() {
    const speakers = new Set([...S.records.values()].map(u => u.manualSpeaker || u.speaker).filter(v => v != null && v !== ''));
    return speakers.size ? `${speakers.size}位发言人 · 身份可在原文核对`
      : S.records.size ? `已收到${S.records.size}段对话 · 说话人待识别` : '等待第一段对话';
  }

  function captureSourceLabel() {
    const s = S.state;
    if (s.captureControl === 'pausing') return '正在暂停';
    if (s.captureControl === 'draining') return '已暂停·收尾中';
    if (s.captureControl === 'paused') return '已暂停';
    if (s.captureControl === 'resuming') return s.sourceDetail?.includes('启动') ? '启动录音豆' : '正在继续';
    if (s.captureControl === 'unknown') return '状态待确认';
    if (s.sourceReady) return '收音中';
    if (s.source !== 'bean') return '等待收音';
    if (s.sourceDetail?.includes('按录音豆')) return '请按录音键';
    if (s.sourceDetail?.includes('寻找')) return '寻找录音豆';
    if (s.sourceDetail?.includes('暂停')) return '录音豆已暂停';
    if (s.sourceDetail?.includes('停止')) return '录音豆已停止';
    return '连接录音豆';
  }
  function liveStatus() {
    const s = S.state;
    if (!s.capturing) return s.asr === 'finishing' ? ASR_TEXT.finishing
      : s.asr === 'error' ? ['已停止收音 · 转写结束未确认', 'bad'] : ['已停止收音', ''];
    if (!s.sourceReady && !['error', 'unconfigured'].includes(s.asr)) return [captureSourceLabel(), 'warn'];
    const [text, cls] = ASR_TEXT[s.asr] || [s.asr, ''];
    return [`正在收音 · ${text}`, cls];
  }
  function liveDetail() {
    const s = S.state;
    const source = s.capturing && s.sourceDetail ? s.sourceDetail : SOURCE_TEXT[s.source] || s.source || '';
    return `${s.recordingMode === 'meeting' ? '正式会议 · 已选择云保存' : '日常临时聆听'} · ${source} · 缓存 ${clock(s.bufferedMs)} / ${clock(s.retentionMs)}`;
  }
  function warnings() {
    const s = S.state, w = [];
    if (S.captureError) w.push(S.captureError);
    if (s.captureControlError) w.push(s.captureControlError);
    const gaps = s.asrGaps || [];
    if (s.asr === 'unconfigured' || s.asr === 'error') w.push(s.asrDetail || (ASR_TEXT[s.asr] || [s.asr])[0]);
    else if (gaps.length) { const g = gaps[gaps.length - 1]; w.push(`识别中断过 ${gaps.length} 次，最近一次 ${clock(g.fromMs)}–${clock(g.toMs)} 没有转写`); }
    if (s.capturing && s.micBusy) w.push('麦克风被其他应用占用，这段时间没有声音进来');
    if (s.capturing && s.recordingCapped) w.push('录音已达 3 小时上限，之后只保留文字');
    if (s.recordingMode === 'meeting') {
      if (!s.memorySync) w.push('会议文字同步已关闭');
      else if (s.syncStatus === 'failed') w.push('文字同步已停止，请检查服务器');
      else if (s.syncStatus === 'unsupported') w.push('当前后端不支持会议文字同步');
    }
    if (s.capturing && s.speakerPreviewEnabled && s.liveOverlap) w.push('疑似多人同时说话（试验检测）');
    return w;
  }

  // ---- live transcript ------------------------------------------------------------------

  function addLine(u) {
    if (S.lines.has(u.id)) return;
    // A lone interjection ('嗯', '呃') carries nothing; it stays in the archive and the sync, just not on screen.
    if (u.filler) return;
    const card = document.createElement('div');
    card.className = 'card clickable session-transcript live-line';
    card.dataset.id = u.id;
    card.dataset.start = u.startMs;
    const list = LINES;
    // Keep time order: finals may interleave after an ASR reconnect.
    const next = [...list.children].find((el) => Number(el.dataset.start) > u.startMs) || null;
    list.insertBefore(card, next);
    S.lines.set(u.id, card);
    S.records.set(u.id, u);
    renderLine(u.id);
    scrollToEnd();
  }

  /** The voiceprint answer arrives after the caption; replace the name in place. */
  function setLineSpeaker(id, speaker, segments = [], score = null, state = null, preview = null, candidates = [], trial = []) {
    const u = S.records.get(id);
    if (!u) return;
    Object.assign(u, { speaker, speakerCandidates: candidates || [], trialSegments: trial || [], segments, speakerScore: score,
      speakerState: state, speakerPreview: preview });
    renderLine(id);
    renderLiveRecent();
  }

  // Below-threshold voiceprint ranking, shown only as a grey guess; it never fills an owner.
  const HINT_FLOOR = 0.35, HINT_MARGIN = 0.05;
  function speakerGuess(u) {
    const c = (u.speakerCandidates || []).filter((x) => x && typeof x.score === 'number' && Number.isFinite(x.score));
    if (u.speakerState !== 'unconfirmed' || !c.length || c[0].score < HINT_FLOOR) return '';
    return c.length < 2 || c[0].score - c[1].score >= HINT_MARGIN
      ? `可能是 ${speakerLabel(c[0].name)}` : `${speakerLabel(c[0].name)} / ${speakerLabel(c[1].name)}？`;
  }
  function trialGuess(s) {
    const c = (s.candidates || []).filter((x) => x && typeof x.score === 'number' && Number.isFinite(x.score));
    return c.length && c[0].score >= HINT_FLOOR && (c.length < 2 || c[0].score - c[1].score >= HINT_MARGIN)
      ? `可能是 ${speakerLabel(c[0].name)}` : '身份待确认';
  }
  const SPEAKER_STATE = { pending: '声纹识别中', unconfirmed: '身份待确认', too_short: '语音太短', busy: '声纹请求拥挤',
    audio_unavailable: '声纹音频不可用', unsupported: '声纹服务不可用', error: '声纹请求失败' };

  /** One transcript card: who (with how sure), when, what, and the value tag. */
  function lineHtml(u) {
    const name = u.manualSpeaker ? manualLabel(u.manualSpeaker) : speakerLabel(u.speaker);
    const who = u.manualSpeaker ? `${name} · 已改` : name ? `${name}${u.segments?.some((s) => s.tier === 'A') ? '' : ' · 待核对'}` :
      speakerGuess(u) || SPEAKER_STATE[u.speakerState] || '身份待确认';
    // A joined phone number no longer matches the segments' text, so such a line is shown whole.
    const stitched = !!u.display && u.display !== u.text;
    let body;
    if (!u.manualSpeaker && u.segments?.length && !stitched) {
      body = u.segments.map((s) => {
        const status = s.overlap ? '多人同时说' : s.tier === 'A' ? '高可信' : '建议 · 待核对';
        const names = s.overlap ? (s.candidates || []).map((c) => c.name).join(' / ') : speakerLabel(s.speaker) || '身份待确认';
        return `<span class="speaker-segment"><span class="segment-who">${esc(names)} · ${status}</span>${esc(s.text)}</span>`;
      }).join('');
    } else if (!u.manualSpeaker && u.trialSegments?.length > 1 && !stitched) {
      body = `<span class="segment-note">按人拆分（试验 · 建议）</span>` + u.trialSegments.map((s) => {
        const names = s.overlap ? (s.candidates || []).map((c) => speakerLabel(c.name)).join(' / ') + ' · 多人同时说'
          : s.speaker ? `${speakerLabel(s.speaker)} · 建议` : trialGuess(s);
        return `<span class="speaker-segment"><span class="segment-who">${esc(names)}</span>${esc(s.text)}</span>`;
      }).join('');
    } else body = esc(u.display || u.text);
    const tag = TAG_LABELS[u.tag] && !['chitchat', 'uncertain'].includes(u.tag) ? ` <span class="badge ${u.tag === 'decision' ? 'green' : u.tag === 'commitment' ? 'purple' : 'gray'}">${TAG_LABELS[u.tag]}</span>` : '';
    return `<div class="session-speaker"><span class="avatar ${name ? speakerTone(u.manualSpeaker || u.speaker) : ''}">${esc(name ? avatarText(name) : '?')}</span><strong class="${u.manualSpeaker ? 'manual-name' : name ? '' : 'unknown-name'}">${esc(who)}</strong><span>${hms(u.startMs)}</span></div>
      <p>${body}${tag}</p>`;
  }
  function renderLine(id) {
    const u = S.records.get(id), el = S.lines.get(id);
    if (!u || !el) return;
    el.innerHTML = lineHtml(u);
    el.hidden = !!(S.transcriptFilter.speaker && (u.manualSpeaker || u.speaker) !== S.transcriptFilter.speaker);
  }
  function removeLine(id) {
    const el = S.lines.get(id);
    if (el) el.remove();
    S.lines.delete(id);
    S.records.delete(id);
  }
  function highlight(ids) {
    ids.forEach((id, i) => {
      const el = S.lines.get(id);
      if (!el) return;
      el.classList.add('hit');
      if (i === 0 && el.isConnected) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => el.classList.remove('hit'), 2600);
    });
  }
  function scrollToEnd() {
    if (!S.autoScroll || S.route.name !== 'live' || S.liveTab !== 'transcript') return;
    const t = $('scroll');
    t.scrollTop = t.scrollHeight;
  }
  $('scroll').addEventListener('scroll', () => {
    const t = $('scroll');
    S.autoScroll = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  });
  function setBusy(busy) {
    const b = $('rc-recall');
    if (b) b.classList.toggle('busy', busy);
  }
  /** A sentence that was just heard slides up once (oops-design.css .is-new). The class is taken off again so that
      moving the transcript between pages does not replay it. */
  function markNew(el) {
    if (!el) return;
    el.classList.add('is-new');
    setTimeout(() => el.classList.remove('is-new'), 600);
  }
  /** The live overview shows the last few sentences; it is redrawn as they arrive. */
  function renderLiveRecent() {
    const box = $('live-recent');
    if (!box || S.route.name !== 'live' || S.liveTab !== 'live') return;
    const recent = [...S.records.values()].filter((u) => !u.filler).sort((a, b) => a.startMs - b.startMs).slice(-3);
    const lastId = recent.length ? recent[recent.length - 1].id : null;
    const fresh = lastId !== null && S.recentLast !== undefined && lastId !== S.recentLast;
    S.recentLast = lastId;
    box.innerHTML = recent.map((u) => `<div><button class="card clickable session-transcript${fresh && u.id === lastId ? ' is-new' : ''}" data-act="line-speaker" data-id="${esc(u.id)}">${lineHtml(u)}</button></div>`).join('') ||
      `<p class="meta">${S.state.capturing ? '开始说话后，原话会出现在这里。' : '开始收音后，最近 5 分钟的对话会出现在这里；事后点「找回刚才」就能找回原话。'}</p>`;
  }

  // ---- routing ----------------------------------------------------------------------------

  // Four entries around the record button (设计语言 TabBar, 2 | ● | 2); Settings ("me") opens from the home header (2026-10-13).
  const NAV = [['home', '首页', 'house'], ['sessions', '会话', 'chat-circle'], ['tasks', '任务', 'check-square'], ['memory', '记忆', 'bookmark-simple']];
  const SETTINGS_ENTRY = ['me', '设置', 'gear-six'];
  const NAV_OF = { home: 'home', sessions: 'sessions', live: 'sessions', meeting: 'sessions', tasks: 'tasks', memory: 'memory', project: 'memory', me: 'me', settings: 'me', device: 'me', raft: 'tasks' };

  function go(name, extra = {}) {
    if (S.sheet && S.sheet.kind !== 'pending') closeSheet();
    const from = S.route.name;
    if (from === 'raft' && name !== 'raft') raft.leave();
    if (name === 'raft' && extra.fromSource !== true) raft.openManual?.();
    S.route = { name, ...extra };
    enter();
    render();
    $('scroll').scrollTop = 0;
    if (from !== name || Object.keys(extra).length) playEnter(NAV_OF[from] !== NAV_OF[name]);
  }
  /** A page or tab change rises in once; a new main tab also pops (oops-design.css). render() keeps the classes while they play. */
  let enterTimer = null;
  function playEnter(navChanged) {
    const root = $('root');
    clearTimeout(enterTimer);
    root.classList.remove('route-enter', 'nav-enter');
    void root.offsetWidth; // restart the animation when pages change quickly
    S.enterClasses = navChanged ? 'route-enter nav-enter' : 'route-enter';
    root.classList.add(...S.enterClasses.split(' '));
    enterTimer = setTimeout(() => { S.enterClasses = ''; root.classList.remove('route-enter', 'nav-enter'); }, 420);
  }
  /** What a page needs from native or the server each time it is opened. */
  function enter() {
    const r = S.route.name;
    if (r === 'home') { loadHistory(); if (canReadMyTasks()) loadHomeTasks(); else requestTasks(false, 'all'); }
    if (r === 'sessions') loadHistory();
    if (['home','sessions','memory'].includes(r)) send('daily.results');
    if (r === 'tasks') openTasks();
    if (r === 'raft') raft.enter();
    if (r === 'memory') {
      if (S.memoryTab === 'personal') { loadPersonal(); loadPersonalCandidates(); }
      else if (S.memoryView === 'projects') { loadProjects(); requestTasks(false, 'all'); }
      else loadHistory();
    }
    if (r === 'live') { S.transcriptFilter = { speaker: null, query: '' }; S.autoScroll = true; }
  }

  function render() {
    const r = S.route.name;
    const root = $('root');
    const tabs = ['live', 'meeting'].includes(r);
    root.dataset.route = r;
    root.className = `oops-root ${r === 'home' ? 'is-home' : ''} ${tabs ? 'has-session-tabs' : ''} ${S.state.capturing ? 'has-recording-controls' : ''} ${S.enterClasses || ''}`;
    $('hdr').className = `app-header ${r === 'home' ? 'home-header' : ''}`;
    $('hdr').innerHTML = headerHtml(r);
    $('tabs').hidden = !tabs;
    if (tabs) $('tabs').innerHTML = tabsHtml(r);
    const html = ({ home: homeHtml, sessions: sessionsHtml, live: liveHtml, meeting: meetingHtml, tasks: tasksHtml,
      memory: memoryHtml, project: projectHtml, me: meHtml, settings: settingsHtml, device: deviceHtml, raft:()=>raft.html() })[r];
    $('screen').setAttribute('aria-label', [...NAV, SETTINGS_ENTRY].find((n) => n[0] === NAV_OF[r])?.[1] || '');
    $('screen').className = `screen-content ${r === 'home' ? 'home-main' : ''}`;
    $('screen').innerHTML = html ? html() : '';
    mountTranscript();
    renderLiveRecent();
    renderNav();
    renderRecordingControls();
    renderStatus();
    slideSegments();
  }

  /** 设计语言 SegmentedControl: a raised thumb (oops-design.css .segmented::before) slides to the selected view. Pages are
      redrawn as HTML, so a control that changed selection starts its thumb at the old place and then springs across. */
  const segmentLast = new Map();
  function slideSegments() {
    document.querySelectorAll('.oops-root .segmented').forEach((seg) => {
      const buttons = [...seg.children].filter((b) => b.tagName === 'BUTTON');
      const index = buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
      const key = `${seg.parentElement?.id || ''}:${buttons[0]?.dataset.act || ''}:${buttons.length}`;
      const last = segmentLast.get(key);
      segmentLast.set(key, index);
      seg.style.setProperty('--n', String(Math.max(1, buttons.length)));
      seg.classList.toggle('has-thumb', index >= 0);
      if (index < 0) return;
      if (last === undefined || last < 0 || last === index) { seg.style.setProperty('--i', String(index)); return; }
      seg.style.setProperty('--i', String(last));
      void getComputedStyle(seg, '::before').transform; // start from the old place, then move
      (window.requestAnimationFrame || setTimeout)(() => seg.style.setProperty('--i', String(index)));
    });
  }

  function mountTranscript() {
    const slot = $('slot-lines');
    if (!slot) { HOLDER.appendChild(LINES); HOLDER.appendChild(PARTIAL); return; }
    slot.appendChild(LINES);
    slot.appendChild(PARTIAL);
    S.records.forEach((_, id) => renderLine(id));
    scrollToEnd();
  }

  function headerHtml(r) {
    const button = (act, label, name, size = 22) => `<button class="icon-button" data-act="${act}" aria-label="${label}">${icon(name, size)}</button>`;
    const spacer = '<span class="icon-button" aria-hidden="true"></span>';
    if (r === 'home') {
      const unread = [...S.notices.values()].some((n) => !n.dismissed);
      return `<img class="wordmark" alt="Oops" src="brand/wordmark.png"><div class="header-tools">
        <button class="icon-button notification-button" data-act="notices-open" aria-label="提醒">${icon('bell', 25)}${unread ? '<i></i>' : ''}</button>
        <button class="icon-button" aria-label="${SETTINGS_ENTRY[1]}" data-act="go" data-route="${SETTINGS_ENTRY[0]}">${icon(SETTINGS_ENTRY[2], 24)}</button></div>`;
    }
    const title = { sessions: '会话', live: '会话', meeting: '会话', tasks: '任务', memory: '记忆', project: '项目', me: '设置', settings: '收音与服务', device: '设备与自动聆听', raft:S.route.compact ? '交给 Oops' : 'Oops 协作群' }[r];
    const left = ['live', 'meeting', 'project', 'me', 'settings', 'device', 'raft'].includes(r) ? button('back', '返回上一页', 'caret-left', 23)
      : button('ask-open', '搜索全部内容', 'magnifying-glass', 23);
    const right = r === 'sessions' || r === 'live' || r === 'meeting' ? (S.state.capturing ? spacer : button('capture-start', '新建记录', 'plus'))
      : ['memory', 'me', 'project', 'settings', 'device', 'raft'].includes(r) ? button('go', '回到首页', 'house').replace('data-act="go"', 'data-act="go" data-route="home"') : spacer;
    return `${left}<h1>${title}</h1>${right}`;
  }

  function tabsHtml(r) {
    const items = r === 'live' ? [['live', '现场'], ['transcript', '原文'], ['actions', '行动']] : [['overview', '概览'], ['transcript', '原文'], ['actions', '行动']];
    const current = r === 'live' ? S.liveTab : S.meetingTab;
    return `<div class="segmented" role="tablist">${items.map(([k, label]) => `<button role="tab" aria-selected="${k === current}" data-act="tab" data-tab="${k}">${label}</button>`).join('')}</div>`;
  }

  /** 设计语言 RecordButton, raised in the middle of the tab bar: it starts a record, and while one runs it ends it after a
      one-step confirmation (a daily capture clears its temporary full text when it stops). The halo follows the real
      input level that renderStatus() writes into --level. */
  function navRecordHtml() {
    const on = !!S.state.capturing;
    return `<span class="app-nav-center"><button type="button" class="record-button ${on ? 'is-recording' : 'is-idle'}" id="nav-record" data-act="record-button" aria-label="${on ? '结束记录' : '开始记录'}" style="--size:64px">`
      + '<span class="record-button-ring outer" aria-hidden="true"></span><span class="record-button-ring" aria-hidden="true"></span>'
      + `<span class="record-button-core" aria-hidden="true">${on ? '<span class="record-button-stop"></span>' : icon('microphone-bold', 26)}</span></button></span>`;
  }
  function renderNav() {
    const current = NAV_OF[S.route.name];
    const tabs = NAV.map(([k, label, ic]) => `<button aria-label="${label}" class="${k === current ? 'selected' : ''}" ${k === current ? 'aria-current="page"' : ''} data-act="go" data-route="${k}">${icon(k === current ? `${ic}-duotone` : ic, 24)}<span>${label}</span>${k === 'tasks' && S.openTaskCount ? `<b>${S.openTaskCount}</b>` : ''}</button>`);
    const html = tabs.slice(0, 2).join('') + navRecordHtml() + tabs.slice(2).join('');
    // Only redraw when something changed, so the selected tab's pop (oops-design.css) is not restarted by data arriving.
    if (S.navHtml !== html) { $('nav').innerHTML = html; S.navHtml = html; }
  }

  // The live scene keeps the full controls. Every other page gets a compact bar where "找回刚才" and "结束" stay one tap
  // away and the rest can be expanded. The expanded state belongs to one page and tab, so it never carries over.
  const rcContext = () => JSON.stringify([S.state.sessionId, S.route.name, S.route.id ?? S.route.name_ ?? '', S.route.name === 'live' ? S.liveTab : S.route.name === 'meeting' ? S.meetingTab : '']);
  function capturePauseButton(compact = false) {
    if (S.state.source !== 'bean') return '';
    const c = S.state.captureControl, resume = ['paused','unknown'].includes(c);
    const busy = ['pausing','draining','resuming'].includes(c) || resume && S.state.asr === 'finishing';
    const disabled = busy || !['recording','paused','unknown'].includes(c);
    const label = c === 'pausing' ? '暂停中' : c === 'resuming' ? '继续中' : c === 'draining' || resume && S.state.asr === 'finishing' ? '收尾中' : resume ? '继续' : '暂停';
    return `<button id="rc-pause" data-act="capture-${resume?'resume':'pause'}" aria-label="${label}" ${disabled?'disabled':''}>${compact ? icon(resume?'play':'pause',19) : `<span class="rc-action-icon">${icon(resume?'play':'pause',20)}</span><span>${label}</span>`}</button>`;
  }
  function renderRecordingControls() {
    const rc = $('rc');
    rc.hidden = !S.state.capturing;
    if (!S.state.capturing) { rc.innerHTML = ''; S.rcExpanded = null; $('root').classList.remove('rc-compact'); return; }
    const onsite = S.route.name === 'live' && S.liveTab === 'live', key = rcContext();
    if (S.rcExpanded !== key) S.rcExpanded = null;
    const expanded = onsite || !!S.rcExpanded;
    rc.classList.toggle('is-compact', !expanded);
    $('root').classList.toggle('rc-compact', !expanded);
    const status = `<span class="rec-indicator ${S.state.sourceReady ? '' : 'is-paused'}"><i aria-hidden="true"></i><span id="rc-status">${captureSourceLabel()}</span><time id="rc-time">${mmss(S.state.sessionMs)}</time>${levelMeter('rc-level')}</span>`;
    const toggle = onsite ? '' : `<button class="rc-expand" data-act="rc-expand" aria-expanded="${expanded}" aria-label="${expanded ? '收起记录控制' : '展开记录控制'}">${icon(expanded ? 'caret-down' : 'caret-up', 16)}</button>`;
    if (!expanded) {
      rc.innerHTML = `<div class="rc-heading">
          <button class="rc-session" data-act="go" data-route="live" aria-label="回到记录现场"><strong>${esc(liveTitle())}</strong>${status}</button>
          <div class="rc-compact-actions">
            ${capturePauseButton(true)}<button class="rc-end" data-act="capture-stop" aria-label="结束记录">${icon('stop',19)}</button></div>${toggle}</div>`;
      return;
    }
    rc.innerHTML = `<div class="rc-heading">
        <div class="rc-session"><strong>${esc(liveTitle())}</strong>${status}</div>
        ${onsite ? '' : `<button class="rc-scene" data-act="go" data-route="live">现场${icon('caret-right', 13)}</button>`}${toggle}</div>
      <div class="rc-actions ${S.state.source==='bean'?'with-pause':''}">
        <button id="rc-recall" data-act="recall"><span class="rc-action-icon">${icon('clock-counter-clockwise', 20)}</span><span>找回刚才</span></button>
        ${capturePauseButton()}
        <button class="rc-saved" data-act="saved-list"><span class="rc-action-icon">${icon('bookmark-simple', 20)}</span><span id="rc-saved">已保存 ${S.state.savedCount ?? 0}</span></button>
        <button class="rc-end" data-act="capture-stop"><span class="rc-action-icon">${icon('stop', 20)}</span><span>结束</span></button></div>`;
  }

  const recordingModeLabel = () => S.state.recordingMode === 'meeting' ? '正式会议' : '日常临时聆听';

  function liveStartedAt() {
    if (!S.state.sessionId) return null;
    // Native reports elapsed session time, not the clock time it began; good to the minute.
    S.liveStartedAt = S.liveStartedAt?.id === S.state.sessionId ? S.liveStartedAt : { id: S.state.sessionId, at: new Date(Date.now() - (S.state.sessionMs || 0)) };
    return S.liveStartedAt.at;
  }
  function liveTitle() {
    const a = S.state.agenda || {};
    if (a.goal) return a.goal;
    const at = liveStartedAt();
    return at ? `${recordingModeLabel()} · ${shortDate(at.toISOString())}` : recordingModeLabel();
  }

  // ---- 首页 ---------------------------------------------------------------------------------

  const listRow = ({ act, data = '', ic, title, sub, badge = '', chevron = true, cls = '' }) =>
    `<button class="list-row ${cls}" data-act="${act}" ${data}><span class="row-icon">${icon(ic)}</span><span class="row-copy"><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${badge}${chevron ? icon('caret-right', 18) : ''}</button>`;
  const sectionTitle = (title, action = '', act = '', data = '') =>
    `<div class="section-title"><h2>${title}</h2>${action ? `<button class="text-action" data-act="${act}" ${data}>${esc(action)}${icon('caret-right', 14)}</button>` : ''}</div>`;

  /** The hero's Pupu shows only what is visibly true: it listens (sound waves moving) while this capture is taking in
      sound, holds still while waiting for the source, and is the official artwork otherwise. Never proof that a model ran. */
  function heroMascot() {
    if (S.state.capturing && window.OopsPupu) return window.OopsPupu.svg('listening', { still: !S.state.sourceReady, label: 'Oops伙伴' });
    return '<img class="hero-mascot" alt="Oops伙伴" src="brand/mascot.png" draggable="false">';
  }

  function homeHtml() {
    const now = new Date();
    const week = '日一二三四五六'[now.getDay()];
    const recent = historyRows(false).slice(0, 2);
    const live = S.state.sessionId && (S.state.capturing || S.state.asr === 'finishing' || S.records.size);
    const myTasksEnabled = canReadMyTasks();
    const tasks = (myTasksEnabled ? (S.homeTasks || []) : []).filter((t) => ['open', 'unknown'].includes(t.feishu?.state)).slice(0, 3);
    const pendingMeeting = historyRows(false).find((i) => reviewPending(i));
    const pendingTotal = historyRows(false).reduce((a, i) => a + reviewPending(i), 0);
    return `<div class="home-content">
      <div class="home-date">${now.getMonth() + 1}/${now.getDate()}星期${week}</div>
      <p class="home-positioning">记住对话里的重点，陪你把下一步做好。</p>
      <section class="native-record-hero ${S.state.capturing ? 'is-active' : ''}" aria-label="记录状态">
        <div class="native-record-heading"><div><small>${S.state.capturing ? `本场记录${liveStartedAt() ? ` · ${shortDate(liveStartedAt().toISOString())} 开始` : ''}` : '从这一刻开始'}</small>
          <h1>${S.state.capturing ? esc(S.state.agenda?.goal || recordingModeLabel()) : '重要的话，<br>交给 Oops 记住。'}</h1></div>${heroMascot()}</div>
        ${S.state.capturing ? `<div class="native-record-status"><span class="rec-indicator ${S.state.sourceReady ? '' : 'is-paused'}"><i aria-hidden="true"></i><strong id="home-record-status">${S.state.sourceReady ? '正在记录' : '等待收音'}</strong></span>${levelMeter('home-level')}<time id="home-record-time">${mmss(S.state.sessionMs)}</time></div>
          <p class="meta" id="home-record-people">${homePeopleSummary()}</p>
          <button class="button primary" type="button" data-act="go" data-route="live">${icon('waveform')}<span>回到记录现场</span></button>`
          : `<button class="button primary" type="button" data-act="capture-start">${icon('microphone')}<span>开始记录</span></button>`}
        <div class="record-under"><span>${S.state.capturing ? recordingModeLabel() : S.state.source === 'bean' ? '录音豆 · 正式会议' : '默认日常临时聆听'} · ${esc(SOURCE_TEXT[S.state.source] || '手机麦克风')}</span><button data-act="go" data-route="settings">收音与保存设置</button></div>
      </section>
      ${dailyEntryHtml()}
      ${sectionTitle('问 Oops')}
      <div class="ask-card">
        <textarea id="home-ask" aria-label="想问 Oops 的问题" placeholder="问问刚才或往期会议里说过什么…" rows="2" maxlength="500">${esc(S.homeQuery)}</textarea>
        <div class="ask-footer"><small>${icon('lock-key', 13)}${S.homeAskHistory ? '已存会议原话' : S.state.recordingMode === 'meeting' ? '本场会议原话' : '本场临时原话'}</small>
          <button class="input-text" data-act="home-ask-scope">${S.homeAskHistory ? '查往期会议' : '查本场'}</button>
          <button class="mic-button" data-act="home-ask" aria-label="提问">${icon('paper-plane-tilt', 23)}</button></div></div>
      ${listRow({ act: 'go', data: 'data-route="settings"', ic: 'waveform', title: '智能聆听', sub: `${SOURCE_TEXT[S.state.source] || '手机麦克风'} · ${S.state.voiceTrigger !== false ? '说「Oops」找回刚才' : '语音唤醒已关闭'}` })}
      ${sectionTitle('接着聊', '全部', 'go', 'data-route="sessions"')}
      <div class="home-recent">
        ${requestNotice(S.requests.history, 'history-retry', !!S.historyItems)}
        ${live ? listRow({ act: 'go', data: 'data-route="live"', ic: 'waveform', title: liveTitle(), sub: `${S.state.capturing ? '正在收音' : '本场已停止'} · ${S.commitments.length}项待办` }) : ''}
        ${recent.map((m) => listRow({ act: 'meeting-open', data: `data-id="${esc(m.session_id)}"`, ic: 'users-three', title: meetingName(m),
          sub: `${formatDate(m.started_at)} · ${reviewPending(m) ? `${reviewPending(m)}项待核对` : `${m.utterance_count}句`}` })).join('')}
        ${!live && !recent.length && !S.requests.history.error ? `<p class="meta">${S.historyItems ? '还没有已存会议。正式会议需单独选择云端保存；日常重点可从上方直接查看。' : '正在读取…'}</p>` : ''}
      </div>
      ${sectionTitle('需要你处理', myTasksEnabled ? S.homeTasks == null ? S.homeTasksState.error ? '查看任务' : '读取中' : `${S.homeTasks.length + (pendingMeeting ? 1 : 0)}项待处理` : '选择本人', 'go', `data-route="${myTasksEnabled ? 'tasks' : 'me'}"`)}
      ${myTasksEnabled ? requestNotice(S.homeTasksState, 'home-tasks-retry', !!S.homeTasks) : ''}
      ${tasks.map((t) => listRow({ act: 'task-open', data: `data-url="${esc(t.url || '')}"`, ic: 'check-square', title: t.what,
        sub: t.overdue ? '期限已到，核对进度' : t.feishu?.due_ms ? `截止 ${shortDate(new Date(t.feishu.due_ms).toISOString()).split(' ')[0]}` : '在飞书里推进' })).join('')}
      ${pendingMeeting ? listRow({ act: 'review-start', data: `data-id="${esc(pendingMeeting.session_id)}"`, ic: 'check-circle', title: `会后核对 · ${meetingName(pendingMeeting)}`,
        sub: `${reviewPending(pendingMeeting)}项待核对` }) : ''}
      ${!tasks.length && !pendingMeeting ? `<p class="meta">${myTasksEnabled ? S.homeTasks == null ? S.homeTasksState.error ? '暂时无法确认你的正式任务。' : '正在读取你的正式任务…' : '没有待处理的本人飞书正式任务。' : '在「设置」里选择本人后，这里会列出你负责的飞书任务。'}</p>` : ''}
      ${meetingWorkEntryHtml()}
      ${sectionTitle('刚才说过什么？', '问已有记录', 'ask-open')}
      <button class="card clickable recall-entry" data-act="recall">${icon('clock-counter-clockwise')}<div><strong>找回最近5分钟</strong><p>选择重要的片段，再决定是否留下</p></div>${icon('caret-right', 17)}</button>
      ${pendingTotal ? listRow({ act: 'go', data: 'data-route="sessions"', ic: 'bookmark-simple', title: '核对会后结果', sub: `${pendingTotal}项待核对 · 确认后才会用于冲突提醒` }) : ''}
    </div>`;
  }

  // ---- 会话列表 ------------------------------------------------------------------------------

  // Reversible list filtering only: zero sentences do not mean no recording or saved results.
  // The current local recording/finish flow retains its separate activity entry.
  function hiddenEmptyMeeting(m) {
    return m.history_visibility?.hidden_by_default === true
      && !(m.session_id === S.state.sessionId && (S.state.capturing || S.state.asr === 'finishing'));
  }
  function historyRows(showEmpty = S.historyShowEmpty) {
    return (S.historyItems || []).filter(m => showEmpty || !hiddenEmptyMeeting(m));
  }
  function historyFilterHtml() {
    const hidden = Math.max((S.historyItems || []).filter(hiddenEmptyMeeting).length, Number(S.historyMeta?.hidden_empty_count) || 0);
    const unreadable = Number(S.historyMeta?.unreadable_count) || 0;
    const unreadableOps = Number(S.historyMeta?.unreadable_operations_count) || 0;
    return `${hidden || S.historyShowEmpty ? `<button class="chip ${S.historyShowEmpty ? 'selected' : ''}" data-act="history-empty-toggle" aria-pressed="${S.historyShowEmpty}">${S.historyShowEmpty ? '恢复默认筛选' : `查看全部（含${hidden}场已隐藏）`}</button>` : ''}
      ${unreadable || unreadableOps ? `<section class="card service-error" role="status"><h3>部分内容暂时无法读取</h3><p>${unreadable ? `${unreadable}场档案需要检查，已显示其余可读会议。` : ''}${unreadableOps ? '部分任务回执未读全，任务关联状态需重新核对。' : ''}</p><button class="button secondary" data-act="history-retry">重新读取</button></section>` : ''}`;
  }
  function sessionCard(m) {
    const pending = reviewPending(m);
    const counts = m.digest_counts || {};
    const count = m.effective_utterance_count ?? m.utterance_count;
    const noText = hiddenEmptyMeeting(m) ? '0句原话 · 可查看已保存内容' : m.transcript_status === 'expired' ? '完整文字已到期 · 查看保留结果'
      : ['incomplete', 'cancelled'].includes(m.asr_closure) ? '转写未完整结束 · 请核对保存内容' : !m.ended_at ? '等待原话同步' : '暂无原话 · 查看会议';
    const preview = [counts.decision ? `决定 ${counts.decision}` : '', counts.commitment ? `待办 ${counts.commitment}` : '', counts.constraint ? `约束 ${counts.constraint}` : ''].filter(Boolean).join(' · ') || (count > 0 ? `${count} 句原话` : noText);
    return `<div class="session-list-item"><button class="card clickable" data-act="meeting-open" data-id="${esc(m.session_id)}">
      <div class="session-card-top"><span class="session-kind">${icon('users-three')}</span>${pending ? `<span class="badge amber">待核对 ${pending}</span>` : '<span class="badge gray">已保存</span>'}${minutesBadge(m)}</div>
      <h3>${esc(meetingName(m))}</h3>
      <p class="meta">${formatDate(m.started_at)}${duration(m) ? ` · ${duration(m)}` : ''} · 会议${m.history_visibility?.reason === 'short_meeting' ? ' · 不足3分钟' : ''}</p>
      <p class="session-preview">${esc(preview)}</p>
      <div class="session-card-bottom"><span>${esc(m.project || '未归项目')}</span><strong>${pending ? '查看并核对' : '查看'}</strong></div></button>
      <button class="session-more" data-act="meeting-tools" data-id="${esc(m.session_id)}" aria-label="管理${esc(meetingName(m))}">${icon('dots-three')}</button></div>`;
  }

  function sessionsHtml() {
    const all = S.historyItems == null ? null : historyRows();
    const q = S.sessionsQuery.trim();
    const items = (all || []).filter((m) => !q || meetingName(m).includes(q) || (m.project || '').includes(q));
    const pending = items.filter((m) => reviewPending(m)), done = items.filter((m) => !reviewPending(m));
    const live = S.state.sessionId && (S.state.capturing || S.state.asr === 'finishing' || S.records.size);
    return `<div class="stack sessions-feature">
      ${S.state.capturing ? `<button class="button primary" type="button" data-act="go" data-route="live">${icon('waveform')}<span>回到正在进行的记录</span></button>`
        : `<button class="button primary" type="button" data-act="capture-start">${icon('microphone')}<span>开始记录</span></button>`}
      ${dailyEntryHtml()}
      <div class="session-list-search"><div class="search-input">${icon('magnifying-glass', 18)}<input id="sessions-search" aria-label="搜索记录" placeholder="搜索会议名称或项目" value="${esc(S.sessionsQuery)}"></div>
        <button class="session-filter-button" data-act="ask-open" aria-label="问已有记录">${icon('quotes')}</button></div>
      <div class="session-list-secondary"><button data-act="saved-list">${icon('bookmark-simple', 18)}已保存片段</button><span>${all ? `${all.length}段记录` : ''}</span></div>
      ${historyFilterHtml()}
      ${live ? `<section class="session-list-group">${sectionTitle('正在记录')}<div class="session-list-item"><button class="card clickable" data-act="go" data-route="live">
        <div class="session-card-top"><span class="session-kind">${icon('waveform')}</span><span class="badge purple">${S.state.capturing ? '进行中' : '已停止'}</span></div>
        <h3>${esc(liveTitle())}</h3><p class="meta">${S.state.capturing ? `收音中 · ${mmss(S.state.sessionMs)}` : '本场已停止'} · ${recordingModeLabel()}</p>
        <p class="session-preview">${S.records.size} 句原话 · 待办 ${S.commitments.length}</p>
        <div class="session-card-bottom"><span>${esc(S.liveProject || '未归项目')}</span><strong>${S.state.capturing ? '回到现场' : '查看'}</strong></div></button></div></section>` : ''}
      ${requestNotice(S.requests.history, 'history-retry', !!all)}
      ${all == null ? S.requests.history.error ? '' : spinnerHtml('正在读取会议…', '团队服务器') : `
        ${pending.length ? `<section class="session-list-group">${sectionTitle('待核对')}${pending.map(sessionCard).join('')}</section>` : ''}
        ${done.length ? `<section class="session-list-group">${sectionTitle('已保存')}${done.map(sessionCard).join('')}</section>` : ''}
        ${!items.length ? `<div class="empty-state">${emptyArt(q ? 'thinking' : 'sleepy', 'chat-circle-text')}<strong>${q ? '没有找到' : S.historyMeta?.hidden_empty_count || S.historyItems?.length ? '暂无符合条件的会议' : '还没有会议'}</strong><p>${q ? '换个名称或项目再试试。' : S.historyMeta?.hidden_empty_count || S.historyItems?.length ? '不足3分钟或0句的会议已隐藏，可点上方查看全部。' : '明确选择云端保存的正式会议会出现在这里；日常临时聆听不归档整场。'}</p></div>` : ''}`}
      <p class="meta">新正式会议经本次确认后云端保存，原音与全文分别保留所选7、30或90天；已确认摘要、任务和短依据单独保留。历史会议沿用原保存规则。</p>
    </div>`;
  }

  // ---- 现场（本场会议） ------------------------------------------------------------------------

  function sessionHeading(title, meta, act) {
    return `<div class="session-heading"><div><h2>${esc(title)}</h2><p class="meta">${meta}</p></div>
      <button class="session-filter-button" data-act="${act}" aria-label="本次会话工具">${icon('dots-three')}</button></div>`;
  }
  const p0Grid = (items) => `<section class="card session-p0-entry"><div class="session-p0-grid">${items.map(([ic, label, act, data = '']) =>
    `<button data-act="${act}" ${data}>${icon(ic)}<span>${label}</span></button>`).join('')}</div></section>`;

  function liveHtml() {
    const s = S.state;
    const heading = sessionHeading(liveTitle(), `${recordingModeLabel()} · ${esc(S.liveProject || '个人记录')} · <span id="live-elapsed">${mmss(s.sessionMs)}</span>`, 'live-tools');
    const stage = `<div class="session-stage"><span class="badge ${s.capturing ? 'purple' : 'gray'}">${s.capturing ? '进行中' : s.sessionId ? '已停止 · 可会后核对' : '未开始'}</span></div>`;
    if (S.liveTab === 'transcript') return liveTranscriptHtml(heading, stage);
    if (S.liveTab === 'actions') return liveActionsHtml(heading, stage);
    const counts = s.digestCounts || {};
    const notices = [...S.notices.values()].filter((n) => !n.dismissed).length;
    const speakers = new Set([...S.records.values()].map((u) => u.manualSpeaker || u.speaker).filter(Boolean));
    const a = s.agenda || {};
    const current = (a.items || []).find((i) => i.id === a.currentItemId);
    const covered = (a.items || []).filter((i) => i.coveredMs > 0).length;
    const w = warnings();
    return `<div class="stack sessions-feature">${heading}${stage}
      <div class="session-recording"><span class="recording-dot ${s.capturing && s.sourceReady ? '' : 'idle'}"></span>
        <div><strong id="live-rec-title">${esc(liveStatus()[0])}</strong><small id="live-rec-sub">${esc(liveDetail())}</small>
          <small class="live-warn" id="live-warn" ${w.length ? '' : 'hidden'}>${esc(w.join('；'))}</small></div>
        ${s.capturing ? '' : `<button class="button secondary" type="button" data-act="capture-start">${icon('microphone', 18)}<span>开始</span></button>`}</div>
      <div class="session-live-summary">
        <button data-act="tab" data-tab="transcript">${icon('user-circle')}<strong>${speakers.size ? `${speakers.size}位发言人` : '发言人待识别'}</strong></button>
        <button data-act="tab" data-tab="actions">${icon('check-square')}<strong>${boardOpen().length ? `本次任务 ${boardOpen().length} · P0 ${boardOpen().filter((t) => t.priority === 'P0').length}` : `本次行动 ${counts.commitment || 0}`}</strong></button></div>
      ${listRow({ act: 'agenda-open', ic: 'list-checks', title: '本次议程', sub: a.goal || a.items?.length
        ? `${covered}/${a.items?.length || 0} 项已讨论 · ${current?.title || a.goal || '等待讨论'}${a.plannedMs ? ` · 计划 ${clock(a.plannedMs)}` : ''}` : '没有预设议题，也可以继续记录' })}
      ${current ? `<div class="native-current-topic"><small>当前议题</small><strong>${esc(current.title)}</strong><span>已讨论不代表结论已确认</span></div>` : ''}
      ${sectionTitle('本次发现', '查看全部', 'commitments-open')}
      ${[...(S.summary.decisions || []), ...(S.summary.constraints || []), ...(S.summary.ideas || [])].slice(0, 3).map(u => listRow({act: 'commitment-open', data: `data-id="${esc(u.id)}"`, ic: u.tag === 'decision' ? 'check-circle' : 'sparkle', title: u.text, sub: `${hms(u.startMs ?? u.start_ms)} · ${speakerLabel(u.manualSpeaker || u.speaker) || '说话人待确认'} · 待核对`})).join('') || '<p class="meta">有新的决定、约束或想法时会整理在这里。原话仍可单独查看。</p>'}
      ${sectionTitle('最近原话', '完整原文', 'tab', 'data-tab="transcript"')}
      <div class="stack live-recent" id="live-recent"></div>
      ${p0Grid([['check-circle', '本场纪要', 'commitments-open'], ['bell', notices ? `会议提醒 ${notices}` : '会议提醒', 'notices-open'],
        ['list-checks', '议程与时间', 'agenda-open'], ['folder-simple', S.liveProject ? `项目：${S.liveProject}` : '所属项目', 'live-project']])}
      <div class="action-grid">
        <button class="button secondary" type="button" data-act="ask-open">${icon('magnifying-glass')}<span>问本场</span></button>
        <button class="button secondary" type="button" data-act="saved-list">${icon('bookmark-simple')}<span>已保存 ${s.savedCount ?? 0}</span></button></div>
      ${!s.capturing && s.sessionId ? `<section class="card session-review-entry"><div><h3>会后核对</h3><p class="meta">逐条确认待办、决定和不知道谁说的话；确认后的决定会用于之后的冲突提醒。</p></div>
        <button class="button primary" type="button" data-act="review-start" data-id="${esc(s.sessionId)}"><span>开始 / 继续核对</span></button></section>` : ''}
      ${s.capturing && s.recordingMode !== 'meeting' ? '<button class="button secondary" type="button" data-act="capture-meeting"><span>从现在转为正式会议</span></button>' : ''}
      ${s.capturing ? '<button class="button quiet" type="button" data-act="capture-stop"><span>结束当前记录</span></button>' : ''}
    </div>`;
  }

  function speakerChips(names, selected) {
    return `<div class="mobile-carousel chip-carousel" role="region" aria-label="筛选"><div class="mobile-carousel-content chip-track">
      <button class="chip ${!selected ? 'selected' : ''}" aria-pressed="${!selected}" data-act="filter-speaker" data-name="">全部</button>
      ${names.map((n) => `<button class="chip ${selected === n ? 'selected' : ''}" aria-pressed="${selected === n}" data-act="filter-speaker" data-name="${esc(n)}">${esc(manualLabel(n))}</button>`).join('')}</div></div>`;
  }

  function liveTranscriptHtml(heading, stage) {
    const names = [...new Set([...S.records.values()].map((u) => u.manualSpeaker || u.speaker).filter(Boolean))];
    return `<div class="stack sessions-feature">${heading}${stage}
      <div class="search-input">${icon('magnifying-glass', 18)}<input id="live-ask" aria-label="问这场会" placeholder="问这场会：预算上限是多少？" maxlength="500"></div>
      ${names.length ? speakerChips(names, S.transcriptFilter.speaker) : ''}
      <p class="meta">点一句可以改说话人。${S.pruned ? (S.state.recordingMode === 'meeting' ? '更早的字幕已移出列表，已存会议按选择期限保留。' : '超过5分钟的原音和临时全文已清除；私人候选仅保留必要短依据。') : '最近 5 分钟的原声可以在「找回刚才」里回听。'}</p>
      <div class="stack" id="slot-lines"></div>
      ${!S.records.size ? `<div class="empty-state">${S.state.capturing ? emptyArt('listening', 'waveform', { still: !S.state.sourceReady }) : emptyArt('sleepy', 'waveform')}<strong>还没有原话</strong><p>${S.state.capturing ? '开始说话后，转写会一句句出现在这里。' : '开始收音后，最近 5 分钟的对话会出现在这里。'}</p></div>` : ''}
      ${S.state.capturing ? '<button class="button quiet" type="button" data-act="capture-stop"><span>结束当前记录</span></button>' : ''}
    </div>`;
  }

  function commitmentCard(u, act) {
    const reviewed = u.reviewStatus === 'confirmed' || u.review_status === 'confirmed' || u.review?.verdict === 'confirmed';
    const created = u.taskStatus === 'created' || u.task_status === 'created';
    const owner = u.review?.owner || u.ownerHint || u.owner_hint || u.suggestedOwner || u.suggested_owner;
    const badge = created ? '<span class="badge green">已建飞书任务</span>' : reviewed ? '<span class="badge purple">人工已确认</span>' : '<span class="badge gray">待核对</span>';
    return `<button class="card clickable" data-act="${act}" data-id="${esc(u.id)}"><div class="session-task-top"><h3>${esc(u.text)}</h3>${badge}</div>
      <p class="meta">${esc(owner || '负责人待定')} · ${esc(u.whenRaw || u.when_raw || '期限未定')}</p>
      <p class="meta">${hms(u.startMs ?? u.start_ms)} · ${esc(speakerLabel(u.speaker) || '说话人待确认')}${created ? '' : ' · 点开可建飞书任务'}</p></button>`;
  }

  // The server's running task list (task_board): drafts merged and ranked P0–P3 as the meeting goes.
  // Only P0 asks for confirmation now; confirming still opens the sentence and goes through the usual draft.
  function taskBoardAllowed(sessionId) {
    return !!sessionId && sessionId === S.state.sessionId && S.state.recordingMode === 'meeting';
  }
  function sourceBindingValid(binding, ids, sessionId) {
    if (!binding || binding.version !== 1 || binding.session_id !== sessionId || !Array.isArray(ids) || !ids.length
      || new Set(ids).size !== ids.length || !Array.isArray(binding.sources) || binding.sources.length !== ids.length) return false;
    const sources = binding.sources;
    const daily = binding.scope === 'daily';
    if (daily && (typeof binding.proof !== 'string' || !/^[a-f0-9]{64}$/.test(binding.proof))) return false;
    const valid = sources.every((s, i) => s && s.id === ids[i] && (daily ? s.kind === 'daily_excerpt' : ['transcript', 'saved_excerpt'].includes(s.kind))
      && typeof s.text_hash === 'string' && /^[a-f0-9]{64}$/.test(s.text_hash)
      && typeof s.source_revision === 'string' && s.source_revision.length > 0
      && typeof s.quote === 'string' && s.quote.length > 0 && Array.from(s.quote).length <= 280);
    if (!valid || 'context_sources' in binding && !Array.isArray(binding.context_sources)) return false;
    const context = binding.context_sources || [];
    const all = [...sources, ...context];
    if (daily && (all.length > 20 || all.some(s => !s || typeof s.quote !== 'string')
      || all.reduce((length, s) => length + Array.from(s.quote).length, Math.max(0, all.length - 1)) > 280)) return false;
    if (!context.length) return true;
    const contextIds = context.map(source => source?.id);
    return contextIds.every(id => !ids.includes(id)) && sourceBindingValid(
      {...binding, sources: context, context_sources: []}, contextIds, sessionId);
  }
  function acceptedTaskBoard(board) {
    if (!board || !taskBoardAllowed(board.session_id) || !Array.isArray(board.tasks)) return null;
    if ('backendUrl' in board && board.backendUrl !== S.state.backendUrl
      || board.serviceEpoch !== undefined && S.remoteEpoch !== null && board.serviceEpoch !== S.remoteEpoch
      || typeof board.sourceRevision === 'number' && board.sourceRevision < (S.state.boardSourceRevision || 0)) return null;
    const expired = S.state.transcriptExpired || S.expiredBoardSession === board.session_id;
    const tasks = board.tasks.filter(t => t && typeof t.what === 'string' && t.what.trim()
      && Array.isArray(t.sources) && t.sources.length && t.sources.every(id => typeof id === 'string' && id)
      && ['P0', 'P1', 'P2', 'P3'].includes(t.priority) && ['open', 'done', 'dropped'].includes(t.status)
      && (!expired || !t.source_error && sourceBindingValid(t.source_binding, t.sources, board.session_id)
        && [...t.source_binding.sources, ...(t.source_binding.context_sources || [])].every(source => source.kind === 'saved_excerpt')));
    const review_queue = expired ? [] : (Array.isArray(board.review_queue) ? board.review_queue : []).filter(t => t
      && typeof t.what === 'string' && t.what.trim() && Array.isArray(t.sources) && t.sources.length
      && t.sources.every(id => typeof id === 'string' && id) && t.status === 'needs_review');
    if (expired && !tasks.length) return null;
    return { ...board, tasks, review_queue };
  }
  const PRIORITY_TEXT = { P0: '会上确认', P1: '会后几天内', P2: '可以排期', P3: '琐事或待定' };
  const boardOpen = () => (S.board?.tasks || []).filter((t) => t.status === 'open');

  function boardTaskCard(t) {
    const source = t.sources?.[t.sources.length - 1];
    const done = S.commitments.some((u) => (t.sources || []).includes(u.id) && u.taskStatus === 'created');
    const badge = done ? '<span class="badge green">已建飞书任务</span>' : `<span class="badge ${t.priority === 'P0' ? 'purple' : 'gray'}">${esc(t.priority)}</span>`;
    return `<button class="card clickable board-task" data-act="commitment-open" data-id="${esc(source || '')}" ${t.source_error ? 'disabled' : ''}><div class="session-task-top"><h3>${esc(t.what)}</h3>${badge}</div>
      <p class="meta">${esc(t.owner || '负责人待定')}${t.reason ? ` · ${esc(t.reason)}` : ''}</p>
      ${t.source_error ? '<p class="error-text">原话依据已变化或暂不可核验，请重新读取会议后核对。</p>' : ''}
      ${t.priority === 'P0' && !done ? '<p class="meta">点开核对原话，确认后建飞书任务</p>' : ''}</button>`;
  }

  function boardHtml() {
    const tasks = S.board?.tasks || [];
    const review = S.board?.review_queue || [];
    const generation = S.board?.generation_status;
    const unconfirmed = generation === 'unconfirmed';
    const open = boardOpen(), closed = tasks.filter((t) => t.status !== 'open');
    const groups = ['P0', 'P1', 'P2', 'P3'].map((p) => [p, open.filter((t) => t.priority === p)]).filter(([, xs]) => xs.length);
    return `<section class="session-list-group">${sectionTitle(`本场任务清单 ${open.length}`)}
      ${unconfirmed ? '<p class="warn-text">本次任务整理结果未确认，显示此前已有清单；请核对原话。</p>' : ''}
      <p class="meta">Oops 边听边合并重复的说法，按影响排出优先级；会上只请大家确认 P0，其余会后统一处理。${S.board.pending || generation === 'pending' ? '正在整理刚才的话…' : ''}</p>
      ${groups.map(([p, xs]) => `<div class="stack"><p class="meta"><strong>${p}</strong> · ${PRIORITY_TEXT[p]}</p>${xs.map(boardTaskCard).join('')}</div>`).join('')
        || `<p class="meta">${unconfirmed ? '本次整理未完成，任务结果待核对。' : generation === 'pending' ? '正在整理刚才的话，任务结果待核对。' : '还没有需要跟进的任务。'}</p>`}
      ${review.length ? `<details><summary class="meta">原话待核对 ${review.length} 条</summary><p class="meta">以下内容尚未作为任务，需回听确认具体安排。</p>${review.map(t =>
        `<button class="card clickable" data-act="commitment-open" data-id="${esc(t.sources[t.sources.length - 1])}"><h3>${esc(t.what)}</h3><p class="warn-text">${esc((t.quality?.issues || []).join('；') || (t.quality?.reason === 'example_or_hypothesis' ? '举例或假设，未列为待办' : t.quality?.reason === 'generic_principle' ? '沟通原则，未列为待办' : '回听原话后再核对'))}</p></button>`).join('')}</details>` : ''}
      ${closed.length ? `<details><summary class="meta">已合并、作废或完成 ${closed.length} 条</summary>${closed.map((t) =>
        `<p class="meta">${esc(t.what)}${t.reason ? ` · ${esc(t.reason)}` : ''}</p>`).join('')}</details>` : ''}</section>`;
  }

  function liveActionsHtml(heading, stage) {
    const rows = S.commitments;
    const created = rows.filter((u) => u.taskStatus === 'created'), open = rows.filter((u) => u.taskStatus !== 'created');
    const unfinished = ['unconfirmed', 'pending'].includes(S.board?.generation_status);
    const board = S.board?.tasks?.length || S.board?.review_queue?.length || unfinished;
    return `<div class="stack sessions-feature">${heading}${stage}
      ${board ? boardHtml() : listRow({ act: 'commitments-open', ic: 'sparkle', title: '识别到的任务建议', sub: '按原话核对负责人、期限，确认后才建飞书任务' })}
      ${open.length ? (board ? `<details class="session-list-group"><summary class="meta">逐句识别的原始建议 ${open.length} 条</summary>${open.map((u) => commitmentCard(u, 'commitment-open')).join('')}</details>`
        : `<section class="session-list-group">${sectionTitle('待承接')}${open.map((u) => commitmentCard(u, 'commitment-open')).join('')}</section>`) : ''}
      ${created.length ? `<section class="session-list-group">${sectionTitle('已建任务')}${created.map((u) => commitmentCard(u, 'commitment-open')).join('')}</section>` : ''}
      ${!rows.length && !unfinished ? `<div class="empty-state">${emptyArt('sleepy', 'check-square')}<strong>还没有识别到待办</strong><p>有人说"我来做""你周五前给我"这类话时，会出现在这里。</p></div>` : ''}
      <button class="button primary" type="button" data-act="recall">${icon('clock-counter-clockwise')}<span>从刚才的话整理行动</span></button>
      <button class="button quiet" type="button" data-act="go" data-route="tasks"><span>查看全部任务</span></button>
    </div>`;
  }

  // ---- 往期会议 ------------------------------------------------------------------------------

  function meetingHtml() {
    const h = S.history;
    if (!h) return spinnerHtml('正在打开会议…', '团队服务器');
    const pending = (h.review_queue || []).length;
    const heading = sessionHeading(meetingName(h), `会议 · ${esc(h.project || '未归项目')} · ${formatDate(h.started_at)}${duration(h) ? ` · ${duration(h)}` : ''}`, 'meeting-tools');
    const cacheNotice = S.meetingRequest?.sessionId === h.session_id && S.meetingRequest.error ? `<p class="warn-text">${esc(S.meetingRequest.error)} · 暂显示上次内容，尚未更新。</p>` : readCached(h) || S.meetingRequest?.background && S.meetingRequest.active && S.meetingRequest.sessionId === h.session_id ? '<p class="meta" role="status">先显示本机内容，正在核对是否有更新…</p>' : '';
    const stage = `${cacheNotice}<div class="session-stage"><span class="badge gray">${h.transcript_status === 'expired' ? '完整文字已到期' : ['incomplete', 'cancelled'].includes(h.asr_closure) ? '已保存 · 转写结束未确认' : pending ? '已保存 · 待核对' : '已保存'}</span></div>${['incomplete', 'cancelled'].includes(h.asr_closure) ? '<p class="warn-text">已保留收到的文字，转写可能不完整。请结合原声核对会后结果。</p>' : ''}`;
    if (S.meetingTab === 'transcript') return meetingTranscriptHtml(heading, stage);
    if (S.meetingTab === 'actions') return meetingActionsHtml(heading, stage);
    if (h.transcript_status === 'expired') {
      const retained=[...(h.retained_summaries || []),...(h.retained_evidence || [])].filter(x=>x.confirmed && x.source_status!=='changed');
      return `<div class="stack sessions-feature">${heading}${stage}<section class="card"><h3>完整原文已按期限清理</h3><p class="meta">这里只显示独立确认的摘要和必要短依据，不恢复完整原文，也不表示所有内容已经核对。</p>${retained.map(x=>`<p>${esc(x.text)}</p>`).join('') || '<p class="meta">没有独立确认保留的内容。</p>'}</section><button class="button secondary" data-act="go" data-route="tasks">查看独立保存的任务</button><button class="button quiet" data-act="tab" data-tab="transcript">查看全文到期状态</button></div>`;
    }
    const decisions = (h.digest?.decision || []).filter(u => u.review?.verdict !== 'rejected'), constraints = (h.digest?.constraint || []).filter(u => u.review?.verdict !== 'rejected');
    const confirmed = [...decisions, ...constraints].filter((u) => u.review?.verdict === 'confirmed');
    const unconfirmed = [...decisions, ...constraints].filter((u) => u.review?.verdict !== 'confirmed');
    const todos = (h.digest?.commitment || []).filter(u => u.review?.verdict !== 'rejected');
    // The meeting's minutes lead; per-sentence tags are only candidates for review, kept folded away.
    const created = todos.filter((u) => u.task_status === 'created'), open = todos.filter((u) => u.task_status !== 'created');
    const ideas = h.digest?.idea || [];
    const rawCount = unconfirmed.length + open.length + ideas.length;
    const minutesReady = S.minutes.get(h.session_id)?.data?.status === 'ready';
    const retained = [...(h.retained_summaries || []), ...(h.retained_evidence || [])].filter(x=>x.confirmed && x.source_status !== 'changed');
    return `<div class="stack sessions-feature">${heading}${stage}
      ${h.transcript_status === 'expired' ? `<section class="card"><h3>完整原文已按期限清理</h3><p class="meta">下方仅保留另行确认的摘要、任务和短依据；不会恢复完整原文。</p>${retained.map(x=>`<p>${esc(x.text)}</p>`).join('') || '<p class="meta">没有独立确认保留的内容。</p>'}</section>` : ''}
      ${p0Grid([['sparkle', pending ? `会后核对 ${pending}` : '会后核对', 'review-start', `data-id="${esc(h.session_id)}"`], ['bell', `会议提醒 ${(h.notices || []).length}`, 'meeting-notices'],
        ['quotes', '全文与说话人', 'tab', 'data-tab="transcript"'], ['folder-simple', h.project ? `项目：${h.project}` : '所属项目', 'history-project']])}
      <div class="stack session-overview">
        ${itemsOverviewHtml(h)}
        ${minutesHtml(h.session_id)}
        ${h.transcript_status !== 'expired' ? `<section class="card"><h3>独立保留的确认结果</h3><p class="meta">原音和全文到期后，仅保留你在这里明确核对的摘要和短依据。</p>${retained.map(x=>`<p>${esc(x.text)}</p>`).join('') || '<p class="meta">还没有独立确认的内容。</p>'}<button class="button secondary" data-act="retain-open">选择短依据 / 编辑摘要</button></section>` : ''}
        ${rawCount && !Array.isArray(h.items) ? `<details class="card raw-tags"><summary><strong>Oops 整理出的候选 ${rawCount} 条</strong><span class="meta">逐句识别，逐条核对后才成为确认的结论。${minutesReady ? '纪要已从中挑出有用的内容。' : '还没有会议纪要。'}</span></summary>
          ${unconfirmed.length ? `<h3>决定与约束候选</h3>${unconfirmed.map(u => listRow({act: 'history-quote', data: `data-id="${esc(u.id)}"`, ic: u.tag === 'constraint' ? 'flag' : 'check-circle', title: u.text, sub: `${hms(u.start_ms)} · ${u.review?.speaker || speakerLabel(u.speaker) || '说话人待确认'} · 待核对`})).join('')}` : ''}
          ${open.length ? `<h3>待办候选</h3>${open.map((u) => listRow({ act: 'history-quote', data: `data-id="${esc(u.id)}"`, ic: 'check-square', title: u.text,
            sub: `${u.review?.owner || u.owner_hint || '负责人待定'} · ${u.when_raw || '期限待定'} · ${u.review?.verdict === 'confirmed' ? '人工已确认' : '待核对'}` })).join('')}` : ''}
          ${ideas.length ? `<h3>想法</h3>${ideas.map((u) => `<p class="meta">· ${esc(u.text)}</p>`).join('')}` : ''}</details>` : ''}
        ${confirmed.length ? `<section class="card session-result-card"><h3>本次确认的结论</h3>${confirmed.map((u) => `<p class="confirmed-line"><span class="badge ${u.tag === 'constraint' ? 'gray' : 'green'}">${u.tag === 'constraint' ? '约束' : '决定'}</span> ${esc(u.text)}</p>`).join('')}</section>` : ''}
        ${created.length ? `${sectionTitle('已建飞书任务')}${created.map((u) => listRow({ act: 'history-quote', data: `data-id="${esc(u.id)}"`, ic: 'check-square', title: u.text,
          sub: `${u.review?.owner || u.owner_hint || '负责人待定'} · ${u.when_raw || '期限待定'}`, badge: '<span class="badge green">已建任务</span>' })).join('')}` : ''}
        ${pending ? `<section class="card session-review-entry"><div><h3>${pending}项可以逐项核对</h3><p class="meta">待办、决定与不知道谁说的话分别处理，也可以稍后再说。</p></div>
          <button class="button primary" type="button" data-act="review-start" data-id="${esc(h.session_id)}"><span>开始 / 继续核对</span></button></section>` : ''}
        <div class="action-grid">
          <button class="button secondary" type="button" data-act="rename-open"><span>改名</span></button>
          <button class="button secondary" type="button" data-act="tab" data-tab="transcript">${icon('quotes')}<span>查看完整原文</span></button></div>
      </div></div>`;
  }

  function meetingTranscriptHtml(heading, stage) {
    const h = S.history;
    if (h.transcript_status === 'expired') return `<div class="stack sessions-feature">${heading}${stage}<section class="card"><h3>完整文字已到期清理</h3><p>另行确认的摘要、任务及必要短依据仍可在概览查看；它们不等于完整原文。</p></section></div>`;
    const rows = (h.utterances || []).filter((u) => (u.text || '').trim());
    const who = (u) => u.review?.speaker || u.speaker;
    const names = [...new Set(rows.map(who).filter(Boolean))];
    const q = S.transcriptFilter.query.trim();
    const folded = new Set(h.transcript_view?.folded_ids || []);
    const shown = rows.filter((u) => (S.transcriptFilter.showAll || q || S.transcriptFilter.speaker || !folded.has(u.id)) && (!S.transcriptFilter.speaker || who(u) === S.transcriptFilter.speaker) && (!q || u.text.includes(q)));
    return `<div class="stack sessions-feature">${heading}${stage}
      <div class="search-input">${icon('magnifying-glass', 18)}<input id="meeting-search" aria-label="搜索这次原文" placeholder="搜索这次原文" value="${esc(S.transcriptFilter.query)}"></div>
      ${names.length ? speakerChips(names, S.transcriptFilter.speaker) : ''}
      ${folded.size ? `<button class="chip" data-act="transcript-mode">${S.transcriptFilter.showAll ? '只看重点原话' : '查看全部原文（含收起 '+folded.size+' 段）'}</button>` : ''}
      <p class="meta">点一句可以改说话人，▶ 从服务器回听原声（会后录音上传完才有）。</p>
      ${shown.map((u) => {
        const manual = u.review?.speaker;
        const name = manual ? manualLabel(manual) : speakerLabel(u.speaker);
        return `<div><div class="card clickable session-transcript" data-act="history-speaker" data-id="${esc(u.id)}">
          <div class="session-speaker"><span class="avatar ${name ? speakerTone(manual || u.speaker) : ''}">${esc(name ? avatarText(name) : '?')}</span><strong class="${manual ? 'manual-name' : name ? '' : 'unknown-name'}">${esc(name ? (manual ? `${name} · 已改` : name) : '未识别')}</strong>
            <span>${hms(u.start_ms)}</span><button class="play-mini" data-act="history-play" data-id="${esc(u.id)}" data-key="h-${esc(u.id)}" aria-label="回听原声">${icon('play', 16)}</button></div>
          <p>${esc(u.text)}${TAG_LABELS[u.tag] && !['chitchat', 'uncertain'].includes(u.tag) ? ` <span class="badge ${u.tag === 'decision' ? 'green' : u.tag === 'commitment' ? 'purple' : 'gray'}">${TAG_LABELS[u.tag]}</span>` : ''}</p></div></div>`;
      }).join('') || `<div class="empty-state"><strong>${q || S.transcriptFilter.speaker ? '没有符合条件的原话' : '这场会议没有文字'}</strong></div>`}
    </div>`;
  }

  function meetingActionsHtml(heading, stage) {
    const h = S.history;
    if (Array.isArray(h.items)) {
      const tasks = h.items.filter((it) => itemView(it).kind === 'task' && itemState(it) !== 'out');
      const row = (it) => { const v = itemView(it); return listRow({ act: 'item-open', data: `data-id="${esc(it.id)}"`, ic: 'check-square', title: v.title,
        sub: `${itemState(it) === 'todo' ? '待核对' : '负责人 ' + (v.owner || '未定')}${v.due ? ' · ' + v.due : ''}${it.task_status === 'created' ? ' · 已建飞书任务' : ''}` }); };
      return `<div class="stack sessions-feature">${heading}${stage}
        ${tasks.length ? `<section class="session-list-group">${sectionTitle('待核对')}${tasks.filter((it) => itemState(it) === 'todo').map(row).join('')}</section>
          <section class="session-list-group">${sectionTitle('已确认')}${tasks.filter((it) => itemState(it) === 'done').map(row).join('') || '<p class="meta">还没有确认的待办。</p>'}</section>`
          : `<div class="empty-state">${emptyArt('sleepy', 'check-square')}<strong>纪要里没有待办</strong></div>`}
        <button class="button quiet" type="button" data-act="go" data-route="tasks"><span>查看全部任务</span></button></div>`;
    }
    const todos = h.digest?.commitment || [];
    const created = todos.filter((u) => u.task_status === 'created'), open = todos.filter((u) => u.task_status !== 'created');
    return `<div class="stack sessions-feature">${heading}${stage}
      ${listRow({ act: 'review-start', data: `data-id="${esc(h.session_id)}"`, ic: 'sparkle', title: '识别到的任务建议', sub: '会后核对：是否是待办、谁负责' })}
      ${open.length ? `<section class="session-list-group">${sectionTitle('待承接')}${open.map((u) => commitmentCard(u, 'history-quote')).join('')}</section>` : ''}
      ${created.length ? `<section class="session-list-group">${sectionTitle('已建任务')}${created.map((u) => commitmentCard(u, 'history-quote')).join('')}</section>` : ''}
      ${!todos.length ? `<div class="empty-state">${emptyArt('sleepy', 'check-square')}<strong>这场会议没有识别到待办</strong></div>` : ''}
      <button class="button quiet" type="button" data-act="go" data-route="tasks"><span>查看全部任务</span></button>
    </div>`;
  }

  // ---- 任务 ---------------------------------------------------------------------------------

  const TASK_STATE = { done: ['已完成', 'green'], deleted: ['飞书里已删除', 'gray'], unknown: ['状态未知', 'gray'], open: ['未完成', 'purple'] };
  const usesPersonalTaskIdentity = () => S.state.backend === 'http';
  const canReadMyTasks = () => usesPersonalTaskIdentity() || !!S.state.selfName;
  const taskKey = (mine, status) => `${mine ? S.state.selfName || '' : '*'}:${status}`;
  function clearTaskIdentity() {
    for (const key of [...readLeases.keys()]) if (key.startsWith('tasks.')) forgetReadLease(key);
    for (const timer of S.tasks.timers.values()) clearTimeout(timer);
    S.tasks.timers.clear();
    clearTimeout(S.tasks.candidateRequest?.timer); S.tasks.candidateRequest = null; S.tasks.candidateCompat = false;
    clearTimeout(S.taskReview?.timer); S.taskReview = null; S.taskReviewDrafts.clear();
    if (S.sheet?.kind === 'taskReview') closeSheet();
    S.tasks.cache.clear(); S.tasks.requests.clear(); S.tasks.pending.clear(); S.tasks.expanded.clear();
    S.tasks.items = null; S.tasks.mineAssignee = null; S.tasks.archived = []; S.tasks.parsedItems = null; S.tasks.meetingItems = null; S.tasks.parsedStatus = null; S.tasks.parsedSerial = 0; S.tasks.refreshedAt = null; S.tasks.candidateError = null; S.homeTasks = null; S.openTaskCount = 0;
    S.homeTasksState = {}; S.requests.tasks = {};
  }
  function clearRemoteState() {
    readGeneration++; readNeedsCheck = false; checkedReadKeys.clear(); readRequestGenerations.clear(); unavailableReadSources.clear();
    clearReadLeases();
    clearTimeout(S.historyTimer); S.historyTimer = null; clearTimeout(S.meetingRequest?.timer);
    minutesSync?.reset();
    clearTimeout(minutesReadyTimer); minutesReadyCount = 0;
    const remoteCard = !!S.card?.data?.readOnly;
    if (S.playingKey || S.loadingKey) send('clip.stop');
    S.playingKey = null; S.loadingKey = null;
    S.history = null; S.historyItems = null; S.historyMeta = null; S.historyShowEmpty = false; S.projects.items = null; S.projects.open = null; S.liveProject = null;
    S.minutes.clear(); S.deliveries.clear(); S.feishu = {status:'loading',account:null,recipients:[],knownRecipients:{},capabilities:{},busy:false}; S.board = null; clearTaskIdentity();
    S.requests = { history: {}, projects: {}, project: {}, tasks: {} };
    S.pendingMeetingId = null; S.pendingReview = null; S.pendingTools = null; S.review = null; S.pendingRetention=null;
    S.itemReview = null; S.itemTaskRequest = null; S.pendingDelete = null; S.deletedSessions.clear(); S.pendingReviewReturn = false;
    S.historyRequestId = null; S.searchRequestId = null;
    // A cancelled intent prevents an old response from opening the same session on the new server.
    S.meetingRequest = { active: false };
    S.draft = null;
    if (remoteCard) S.card = null;
    if (['feishu', 'minutesDelivery', 'pending', 'requestError', 'review', 'minutesSource', 'projectPick', 'rename', 'draft', 'draftPending', 'result', 'retain', 'itemTaskPending'].includes(S.sheet?.kind) || S.sheet?.kind === 'tools' && !S.sheet.live || remoteCard && S.sheet?.kind === 'card') closeSheet();
    if (S.route.name === 'meeting') S.route = { name: 'sessions' };
    if (S.route.name === 'project') S.route = { name: 'memory' };
    renderNav();
  }
  function loadHistory(force = false) {
    if (S.requests.history.loading && !force) return;
    const requestId = `history-${++S.historySerial}`;
    S.historyRequestId = requestId; S.requests.history = { loading: true };
    clearTimeout(S.historyTimer);
    S.historyTimer = setTimeout(() => {
      if (S.historyRequestId === requestId && S.requests.history.loading)
        onError({ scope: 'history', operation: 'history.list', requestId, message: '会议列表读取超时，请重新读取。' });
    }, 25000);
    send('history.list', { requestId, includeEmpty: S.historyShowEmpty });
  }
  function loadProjects() {
    const requestId = `projects-${++S.historySerial}`;
    S.requests.projects = { loading: true, requestId }; send('projects.list', { requestId });
  }
  function loadProject() {
    const requestId = `project-${++S.historySerial}`;
    S.requests.project = { loading: true, requestId }; send('project.open', { name: S.route.name_, requestId });
  }
  function loadHomeTasks() {
    S.homeTasksState = { loading: true }; requestTasks(true, 'open');
  }
  function requestTasks(mine, status, formalOnly = false) {
    if (!formalOnly) requestTaskCandidates();
    const key = taskKey(mine, status);
    if (S.tasks.pending.has(key)) return;
    const requestId = `tasks-${++S.tasks.serial}`;
    S.tasks.requests.set(key, requestId); S.tasks.pending.add(key);
    S.tasks.timers.set(requestId, setTimeout(() => {
      if (S.tasks.requests.get(key) !== requestId || !S.tasks.pending.has(key)) return;
      onError({scope:'tasks',mine,status,requestId,message:'正式任务读取超时，请重新读取；会议候选单独加载。'});
      S.tasks.requests.delete(key);
    }, 25000));
    send('tasks.list', { mine, status, requestId });
  }
  function requestTaskCandidates(force = false) {
    if (S.tasks.candidateRequest?.pending && !force) return;
    clearTimeout(S.tasks.candidateRequest?.timer);
    const requestId = `candidates-${++S.tasks.serial}`;
    S.tasks.candidateRequest = {requestId,pending:true};
    if (!readValid('tasks.candidates')) { S.tasks.parsedItems = null; S.tasks.meetingItems = null; S.tasks.parsedStatus = {state:'loading',meetings:[]}; S.tasks.refreshedAt = null; }
    S.tasks.candidateCompat = false;
    S.tasks.candidateRequest.timer = setTimeout(() => onError({scope:'taskCandidates',requestId,message:'会议候选读取超时，请重新读取。'}),25000);
    send('tasks.candidates',{requestId});
  }
  function setTaskCandidates(p) {
    if (readFinal(p)) for (const item of [...(p.parsed_items || []),...(p.meeting_items || [])]) if (['current','retained'].includes(item.source_status)) unavailableReadSources.delete(candidateSession(item));
    S.tasks.candidateError = null;
    S.tasks.parsedItems = (Array.isArray(p.parsed_items) ? p.parsed_items : []).filter(candidateCurrent);
    S.tasks.meetingItems = (Array.isArray(p.meeting_items) ? p.meeting_items : []).filter(candidateCurrent);
    S.tasks.parsedStatus = p.parsed_status || {state:'unsupported',meetings:[]};
    S.tasks.reviewer = p.reviewer || null;
    S.tasks.refreshedAt = new Date(Number(p.read_cache?.checked_at_ms) || Date.now()).toISOString();
  }
  function onTaskCandidates(p) {
    if (p.requestId !== S.tasks.candidateRequest?.requestId || !S.tasks.candidateRequest.pending) return;
    if (!acceptRead('tasks.candidates', p, expireTaskCandidates, () => { if (candidatesVisible()) requestTaskCandidates(); })) return;
    if (readFinal(p)) { clearTimeout(S.tasks.candidateRequest.timer); S.tasks.candidateRequest.pending = false; }
    setTaskCandidates(p);
    if (['tasks','home','memory'].includes(S.route.name)) render();
  }
  function currentTaskReply(p) {
    if (p.mine && !usesPersonalTaskIdentity() && p.selfName !== S.state.selfName) return false;
    return !p.requestId || S.tasks.requests.get(taskKey(!!p.mine, p.status || 'open')) === p.requestId;
  }
  function resumeReviewReturn(force = false) {
    if (!S.pendingReviewReturn || !force && (document.hidden || !S.externalReviewHidden)) return;
    S.pendingReviewReturn = false; S.externalReviewHidden = false;
    if (S.route.name === 'tasks') openTasks();
    else if (S.route.name === 'home' && canReadMyTasks()) loadHomeTasks();
    else requestTasks(false, 'all');
    render();
  }
  function openTasks() {
    const saved = S.tasks.cache.get(taskKey(S.tasks.mine, S.tasks.status));
    S.tasks.items = saved?.items || null; S.tasks.archived = saved?.archived || [];
    if (S.tasks.mine) S.tasks.mineAssignee = saved?.mineAssignee || null;
    S.requests.tasks = { loading: true };
    if (!S.tasks.mine || canReadMyTasks()) requestTasks(S.tasks.mine, S.tasks.status);
  }
  function onTasks(p) {
    // A delayed reply for another filter or another selected person never becomes the visible list.
    if (!currentTaskReply(p)) return;
    const key = taskKey(!!p.mine, p.status || 'open');
    if (!acceptRead(`tasks.list:${key}`, p, () => expireTaskList(key, !!p.mine, p.status || 'open'), () => { if (taskListVisible(!!p.mine, p.status || 'open')) requestTasks(!!p.mine, p.status || 'open', true); })) return;
    if (readFinal(p)) { clearTimeout(S.tasks.timers.get(p.requestId)); S.tasks.timers.delete(p.requestId); S.tasks.pending.delete(key); }
    if (readFinal(p)) for (const item of [...(p.items || []),...(p.archived_items || [])]) if (['current','retained'].includes(item.source_status)) unavailableReadSources.delete(item.session_id);
    const items = (p.items || []).map(visibleTaskSource);
    const archived = (p.archived_items || []).map(visibleTaskSource);
    const serial = Number(String(p.requestId || '').replace(/^tasks-/, '')) || 0;
    // Candidate reads are independent of Feishu filters. A newly observed withdrawal must clear every cached scope.
    if (Array.isArray(p.parsed_items) && (!p.requestId || serial >= S.tasks.parsedSerial)) {
      if (!acceptRead('tasks.candidates', p, expireTaskCandidates, () => { if (candidatesVisible()) requestTaskCandidates(); })) return;
      S.tasks.candidateCompat = true;
      S.tasks.parsedSerial = serial;
      S.tasks.parsedItems = Array.isArray(p.parsed_items) ? p.parsed_items.filter(candidateCurrent) : [];
      S.tasks.meetingItems = Array.isArray(p.meeting_items) ? p.meeting_items.filter(candidateCurrent) : [];
      S.tasks.parsedStatus = p.parsed_status || { state: 'unsupported', meetings: [] };
      S.tasks.refreshedAt = new Date(Number(p.read_cache?.checked_at_ms) || Date.now()).toISOString();
      for (const saved of S.tasks.cache.values()) { saved.parsedItems = S.tasks.parsedItems; saved.meetingItems = S.tasks.meetingItems; saved.parsedStatus = S.tasks.parsedStatus; }
    }
    const mineAssignee = p.mine ? usesPersonalTaskIdentity() ? p.mine_assignee || null : p.selfName || S.state.selfName : null;
    if (p.mine) S.tasks.mineAssignee = mineAssignee;
    S.tasks.cache.set(taskKey(!!p.mine, p.status || 'open'), { items, archived, mineAssignee, parsedItems: S.tasks.parsedItems, meetingItems: S.tasks.meetingItems, parsedStatus: S.tasks.parsedStatus });
    if (p.mine && p.status === 'open') {
      S.homeTasks = items; if (readFinal(p)) S.homeTasksState = {}; S.openTaskCount = items.length;
    }
    if (!!p.mine === S.tasks.mine && p.status === S.tasks.status) {
      S.tasks.items = items; S.tasks.archived = archived; if (readFinal(p)) S.requests.tasks = {};
    }
    renderNav();
    if (['tasks', 'home', 'memory'].includes(S.route.name)) render();
  }
  const candidateSession = item => item.session_id || item.source_meeting?.session_id || (item.source === 'meeting_review' ? item.source_meeting?.id : null);
  function raftSourceRef(item) {
    if (!item || !candidateCurrent(item)) return null;
    if (item.source === 'meeting_review' && candidateSession(item)) return {kind:'meeting_item',session_id:candidateSession(item),item_id:item.item_id,fingerprint:item.fingerprint};
    if (item.source === 'label_review' && item.source_meeting?.id) return {kind:'label_review',source_meeting_id:item.source_meeting.id,item_id:item.item_id,fingerprint:item.fingerprint};
    return null;
  }
  function openTaskCollaboration(reference, origin, options = {}) {
    if (!reference || !raft.openSource) return toast('当前安装版尚未接入会议任务协作，请更新后重新读取。',true);
    raft.openSource(reference, origin || {name:'tasks'}, options);
    go('raft',{fromSource:true,compact:options.compact===true});
  }
  const candidateSourceVisible = item => !S.deletedSessions.has(candidateSession(item)) && !unavailableReadSources.has(candidateSession(item));
  const candidateCurrent = item => candidateSourceVisible(item) && (item.source_status === 'current' || item.source === 'meeting_review' && item.source_status === 'retained');
  const visibleTaskSource = item => S.deletedSessions.has(item.session_id) || unavailableReadSources.has(item.session_id) ? { ...item, quote: null, meeting: null, source_status: 'unavailable', source_reason: S.deletedSessions.has(item.session_id) ? 'source_deleted' : 'source_unavailable' } : item;
  function meetingWorkEntryHtml() {
    const t = S.tasks, loading = t.parsedItems === null || t.meetingItems === null;
    const labelCount = (t.parsedItems || []).length, meetingCount = (t.meetingItems || []).filter(x => !x.linked_created).length;
    const title = loading ? '正在读取会议待办…' : `核对站候选 ${labelCount} · 会后已确认待办 ${meetingCount}`;
    const sub = t.candidateError && !loading ? `${t.candidateError} · 暂显示上次内容，尚未更新` : t.candidateRequest?.pending && !loading ? '先显示本机内容，正在核对是否有更新' : loading ? '正在读取当前会议候选' : ['unavailable', 'disabled', 'unsupported'].includes(t.parsedStatus?.state)
      ? '核对站暂不可读取，点击查看具体状态并重试' : '与本人飞书正式任务分别记录 · 未分配也可查看';
    return `<section class="meeting-work-entry">${listRow({ act: 'meeting-work-open', ic: 'check-circle', title, sub })}</section>`;
  }
  function taskCard(t) {
    const [label, tone] = t.overdue ? ['逾期', 'rose'] : TASK_STATE[t.feishu?.state] || TASK_STATE.open;
    const due = t.feishu?.due_ms ? `${new Date(t.feishu.due_ms).getMonth() + 1}月${String(new Date(t.feishu.due_ms).getDate()).padStart(2, '0')}日` : t.when?.raw || '无固定期限';
    return `<button class="card clickable task-card task-list-card" data-act="task-open" data-url="${esc(t.url || '')}">
      <div class="section-title"><span class="badge ${tone === 'rose' ? 'red' : tone}">${label}</span>${t.feishu?.stale ? '<span class="badge gray">可能不是最新</span>' : ''}</div>
      <h3>${esc(t.what)}</h3>
      <p class="meta">${esc(t.who || '负责人待定')}负责 · ${esc(due)}${t.meeting ? ` · ${esc(t.meeting.title || t.meeting.goal || formatDate(t.meeting.started_at))}` : ''}</p>
      ${t.quote ? `<p class="meta">“${esc(t.quote)}”</p>` : ''}
      ${['changed', 'unavailable'].includes(t.source_status) ? '<p class="warn-text">会议来源已变化或不可读取；正式任务状态保留，旧依据不再展示。</p>' : ''}
      <div class="task-card-next">${icon('flag', 18)}<span>${t.feishu?.state === 'done' ? '在飞书里查看' : t.overdue ? '期限已到，核对进度' : '在飞书里推进'}</span></div></button>`;
  }
  const PARSED_REVIEW = { unreviewed: '待核对', confirmed: '已确认内容', rejected: '已排除', merged: '已合并', source_changed: '依据已变更' };
  const PARSED_FILTER = { all: '全部候选', pending: '待核对', confirmed: '内容已确认', disputed: '有分歧', excluded: '已排除 / 合并', changed: '来源已失效' };
  function parsedReviewState(item) {
    if (!candidateCurrent(item)) return 'changed';
    const reviews = item.reviews || [], confirmed = reviews.filter(r => r.verdict === 'confirmed');
    const owners = new Set(confirmed.filter(r => r.kind === 'task' && r.owner).map(r => r.owner));
    const forms = new Set(confirmed.map(r => JSON.stringify([r.kind, r.title || item.title, r.owner || '', r.due || ''])));
    if (item.review_conflict || item.owner_conflict || forms.size > 1 || owners.size > 1 || confirmed.length && reviews.some(r => ['rejected', 'merged'].includes(r.verdict))) return 'disputed';
    if (confirmed.some(r => r.kind === 'task')) return 'confirmed';
    if (confirmed.length || reviews.length && reviews.every(r => ['rejected', 'merged'].includes(r.verdict))) return 'excluded';
    return 'pending';
  }
  function parsedOwner(item) {
    if (!candidateCurrent(item) || parsedReviewState(item) === 'disputed') return null;
    const confirmed = (item.reviews || []).filter(r => r.verdict === 'confirmed' && r.kind === 'task' && r.owner && r.owner !== 'unknown');
    const owners = [...new Set(confirmed.map(r => r.owner))];
    return owners.length === 1 ? owners[0] : null;
  }
  const parsedOwnerLabel = owner => owner === 'collective' ? '大家' : owner === 'unknown' ? '待人工确认' : owner;
  function parsedCard(item) {
    const state = parsedReviewState(item), owner = parsedOwner(item), expanded = S.tasks.expanded.has(item.id);
    const current = candidateCurrent(item), meetingSource = item.source === 'meeting_review';
    const canForward = current && ['label_review','meeting_review'].includes(item.source) && !['changed','excluded'].includes(state);
    const reviews = item.reviews || [];
    const reviewRows = reviews.map(r => {
      const label = PARSED_REVIEW[r.verdict] || '待核对';
      const revised = r.verdict === 'confirmed' && (r.title && r.title !== item.title || r.kind && r.kind !== 'task');
      return `<div class="parsed-review-row"><span>${esc(r.by || '核对者未记录')}</span><span class="badge ${r.verdict === 'confirmed' ? 'purple' : 'gray'}">${esc(label)}</span>
        ${r.verdict === 'confirmed' ? `<small>${esc(r.kind === 'task' ? r.owner ? `负责人：${parsedOwnerLabel(r.owner)}` : '负责人待确认' : ({ decision: '改为决定', open: '改为待定' }[r.kind] || '类别待核对'))}</small>` : ''}
        ${revised ? `<p class="meta">${esc(r.title || item.title)}</p>` : ''}
        ${expanded && r.detail ? `<p class="meta">${esc(r.detail)}</p>` : ''}${expanded && r.due ? `<p class="meta">时间：${esc(r.due)}</p>` : ''}
        ${expanded && r.into ? `<p class="meta">合并至：${esc(r.into)}</p>` : ''}
        ${expanded && r.updated_at ? `<p class="meta">${esc(formatDate(r.updated_at))}${r.revision != null ? ` · 核对版本 ${esc(r.revision)}` : ''}</p>` : ''}</div>`;
    }).join('');
    return `<article class="card parsed-task-card" data-parsed-id="${esc(item.id)}">
      <div class="section-title"><span class="badge ${state === 'confirmed' ? 'purple' : 'gray'}">${esc(PARSED_FILTER[state])}</span><span class="meta">${meetingSource ? '会后核对结果' : '会议候选'}</span></div>
      <h3>${esc(item.title || item.what)}</h3><p class="meta">来源：${esc(item.source_meeting?.title || item.source_meeting?.id || '会议未记录')}${item.source_meeting?.started_at ? ` · ${esc(formatDate(item.source_meeting.started_at))}` : ''}</p>
      ${item.source_status === 'retained' ? '<p class="meta">完整原文已到期，依据为独立确认保留的短原话。</p>' : ''}
      <p class="parsed-owner">${owner ? `人工负责人：${esc(parsedOwnerLabel(owner))}` : state === 'disputed' ? '核对有分歧，负责人尚未统一' : '负责人待人工确认'}${item.due ? ` · ${esc(item.due)}` : ''}</p>
      ${item.detail ? `<p class="meta">${esc(item.detail)}</p>` : ''}
      ${expanded ? reviewRows ? `<div class="parsed-reviews" aria-label="各人核对状态">${reviewRows}</div>` : '<p class="meta">尚无人工核对记录</p>' : ''}
      ${!current ? '<p class="error-text">来源已失效，请重新读取任务。</p>' : ''}
      <div class="inline-actions parsed-actions">
        <button class="button primary" type="button" data-act="parsed-raft-send" data-id="${esc(item.id)}" ${canForward ? '' : 'disabled'}>交给 Oops</button>
        <button class="chip" type="button" data-act="parsed-expand" data-id="${esc(item.id)}" aria-expanded="${expanded}">${expanded ? '收起核对记录' : '核对记录'}</button>
        ${current && meetingSource && candidateSession(item) && !item.linked_created ? `<button class="chip" type="button" data-act="meeting-item-task-draft" data-id="${esc(item.id)}">整理成飞书任务</button>` : ''}
        ${current && meetingSource && candidateSession(item) ? `<button class="chip selected" type="button" data-act="meeting-open" data-id="${esc(candidateSession(item))}">到原会话查看与核对</button>`
          : current && item.source === 'label_review' ? `<button class="chip" type="button" data-act="parsed-review-open" data-id="${esc(item.id)}">修改任务</button>` : '<span class="meta">核对入口暂不可用</span>'}</div>
    </article>`;
  }
  function parsedStatusHtml(status) {
    if (!status) return '';
    const state = status.state;
    const all = status.meetings || [], ready = m => ['ready', 'current'].includes(m.status);
    const sourceMeetings = all.filter(m => m.id !== 'app-meetings'), projection = all.find(m => m.id === 'app-meetings');
    const sourcesReady = sourceMeetings.length > 0 && sourceMeetings.every(ready);
    const sourceCount = sourcesReady && sourceMeetings.every(m => Number.isInteger(m.count) && m.count >= 0) ? sourceMeetings.reduce((sum,m) => sum + m.count,0) : null;
    const projectionOnly = sourcesReady && projection && !ready(projection);
    const message = projectionOnly ? `核对站的${sourceMeetings.length}场会议候选已读到${sourceCount == null ? '' : `，共${sourceCount}条`}；App 会后已确认待办暂未读到。`
      : { loading: '正在读取当前核对状态，旧候选暂不展示或操作。', partial: '部分会议来源暂不可用；下方只显示当前有效的候选。', unavailable: '暂时读不到核对站事项，请重新读取。', disabled: '当前服务未连接核对站。', unsupported: '当前服务尚未提供核对站事项，请更新服务后重试。' }[state];
    const meetings = all.filter(m => !ready(m));
    const label = { source_changed: '来源已变化', stale: '来源已失效', expired: '依据已到期', withdrawn: '来源已撤回', unavailable: '读取失败', failed: '读取失败', waiting_summary: '等待纪要', waiting_transcript: '等待原话' };
    const reason = { meeting_read_busy: '读取通道忙，另一次读取尚未结束', meeting_read_timeout: '本次读取超时，当前数量未知', meeting_read_failed: '本次读取失败，当前数量未知' };
    return message || meetings.length ? `<section class="card parsed-source-state" role="status">${message ? `<p>${esc(message)}</p>` : ''}${meetings.map(m => `<p class="meta">${esc(m.title || m.id)} · ${esc(reason[m.reason_code] || label[m.status] || '来源暂不可用')}</p>`).join('')}${projectionOnly ? '<p class="meta">上方数量只表示已读到的候选；App 会后待办未读到不表示为0，也不代表业务完成。</p>' : ''}<button class="button quiet" type="button" data-act="candidates-retry">重新读取核对状态</button></section>` : '';
  }
  function startTaskReview(item, reload = false) {
    if (!item || item.source !== 'label_review' || !candidateCurrent(item)) return;
    const old = S.taskReview;
    if (old?.readInvalidated && old.payload) { openSheet({kind:'taskReview'}); if (reload) recheckTaskReview(); return; }
    if (!reload && old?.source.id === item.id && ['saving','unconfirmed'].includes(old.status)) return openSheet({kind:'taskReview'});
    clearTimeout(old?.timer);
    const requestId = `task-review-${++S.taskReviewSerial}`;
    const key = `${feishuAccountKey()}:${item.id}:${item.fingerprint}`;
    S.taskReview = {source:item,key,requestId,account:feishuAccountKey(),status:'loading',draft:S.taskReviewDrafts.get(key)};
    openSheet({kind:'taskReview'});
    send('tasks.review.open',{source_meeting_id:item.source_meeting.id,item_id:item.item_id,requestId});
    armTaskReviewTimeout(S.taskReview);
  }
  function armTaskReviewTimeout(r) {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      if (S.taskReview !== r || !['loading','saving'].includes(r.status)) return;
      onError({scope:'taskReview',requestId:r.requestId,message:r.payload?'保存回执尚未确认，请重新读取或重试同一次保存。':'核对依据读取超时，请重新读取。'});
    },25000);
  }
  function recheckTaskReview() {
    const r = S.taskReview;
    if (!r || r.recheckRequestId || r.account !== feishuAccountKey()) return;
    const requestId = `task-review-${++S.taskReviewSerial}`;
    r.recheckRequestId = requestId;
    send('tasks.review.open',{source_meeting_id:r.source.source_meeting.id,item_id:r.source.item_id,requestId});
    r.recheckTimer = setTimeout(() => onError({scope:'taskReview',requestId,message:'当前依据尚未读到；原保存请求仍保留。'}),25000);
    if (S.sheet?.kind === 'taskReview') renderSheet();
  }
  function onTaskReview(p, saved) {
    const r = S.taskReview, recheck = !saved && r?.recheckRequestId === p.requestId;
    if (!r || !recheck && r.requestId !== p.requestId || r.account !== feishuAccountKey()
      || p.source_meeting_id !== r.source.source_meeting.id || p.item_id !== r.source.item_id
      || p.fingerprint !== r.source.fingerprint || p.source_status !== 'current'
      || !p.reviewer || !Number.isInteger(p.revision) || !p.item) return;
    if (recheck) {
      clearTimeout(r.recheckTimer); r.recheckRequestId = null; r.readInvalidated = false; r.data = p; r.error = null;
      unavailableReadSources.delete(candidateSession(r.source));
      if (!r.payload) r.status = 'ready';
      else if (r.status !== 'saving') r.status = 'unconfirmed';
      if (S.sheet?.kind === 'taskReview') renderSheet();
      return;
    }
    const needsCheckedRead = r.readInvalidated;
    clearTimeout(r.timer); r.data = needsCheckedRead ? null : p; r.status = 'ready'; r.error = needsCheckedRead ? '原保存结果已收到，请重新读取当前依据。' : null; r.payload = null;
    if (!r.draft || saved) {
      const own = p.item.review?.status === 'confirmed' ? p.item.review : {};
      r.draft = {kind:own.kind || p.item.kind,title:own.title || p.item.title,detail:own.detail ?? p.item.detail ?? '',due:own.due ?? p.item.due ?? '',owner:own.owner || '',into:''};
    }
    S.taskReviewDrafts.set(r.key,r.draft);
    if (saved) { requestTaskCandidates(true); toast('你的核对已保存'); }
    if (S.sheet?.kind === 'taskReview') renderSheet();
  }
  function taskReviewHtml() {
    const r = S.taskReview;
    if (!r) return frame('核对会议待办','<p>请重新选择当前事项。</p>');
    const d = r.draft || {}, data = r.data, saving = ['saving','loading'].includes(r.status);
    if (r.readInvalidated) return frame('核对会议待办', `<p class="error-text">${esc(r.error || '依据已失效，旧原话已收起。')}</p>${r.payload ? `<p class="meta">${r.status === 'saving' ? '原保存仍在等待回执。' : '原保存结果仍待核对。'}原请求保留，重新读取不会发送新的答案。</p>` : ''}<button class="button secondary" data-act="task-review-reload" ${r.recheckRequestId ? 'disabled' : ''}>${r.recheckRequestId ? '正在读取当前依据…' : '重新读取当前依据'}</button>`);
    if (!data || r.status === 'changed') return frame('核对会议待办',`${saving?spinnerHtml('正在读取原话与我的核对…'):''}${r.error?`<p class="error-text">${esc(r.error)}</p>`:''}${!saving?'<button class="button primary" data-act="task-review-reload">重新读取当前依据</button>':''}`);
    const locked = saving || r.status === 'unconfirmed';
    const own = data.item.review, status = PARSED_REVIEW[own?.status] || '待核对';
    const options = (data.owners || []).map(name=>`<option value="${esc(name)}" ${d.owner===name?'selected':''}>${esc(parsedOwnerLabel(name))}</option>`).join('');
    const merge = (S.tasks.parsedItems || []).filter(x=>x.source_meeting?.id===r.source.source_meeting.id&&x.id!==r.source.id&&candidateCurrent(x));
    const evidence = (data.evidence || []).map(e=>`<blockquote><p>${esc(e.text)}</p><cite>${esc(e.speaker || '说话人待核对')} · ${clock(e.start_ms || 0)}</cite></blockquote>`).join('');
    return frame('核对会议待办',`<p class="meta">${esc(r.source.source_meeting.title)} · 以 ${esc(data.reviewer)} 的身份核对</p><span class="badge purple">${esc(status)}</span>
      ${r.error?`<p class="error-text" role="status">${esc(r.error)}</p>`:''}
      ${r.status==='unconfirmed'?'<div class="inline-actions"><button class="button primary" data-act="task-review-retry">重试同一次保存</button><button class="button secondary" data-act="task-review-reload">重新读取核对结果</button></div>':''}
      <fieldset class="review-answer" ${locked?'disabled':''}>
        <label class="form-field"><span>类别</span><select id="task-review-kind">${[['task','待办'],['decision','决定'],['open','待定']].map(([k,v])=>`<option value="${k}" ${d.kind===k?'selected':''}>${v}</option>`).join('')}</select></label>
        <label class="form-field"><span>事项</span><input id="task-review-title" maxlength="80" value="${esc(d.title || '')}"></label>
        <label class="form-field"><span>补充说明</span><textarea id="task-review-detail" maxlength="400">${esc(d.detail || '')}</textarea></label>
        <label class="form-field"><span>时间约定</span><input id="task-review-due" maxlength="40" placeholder="原话没有约定时留空" value="${esc(d.due || '')}"></label>
        ${d.kind==='task'?`<label class="form-field"><span>负责人</span><select id="task-review-owner"><option value="">请明确选择</option>${options}</select></label>`:''}
        <div class="inline-actions"><button class="button primary" data-act="task-review-save" data-action="confirm">确认并保存我的答案</button><button class="button secondary" data-act="task-review-save" data-action="reject">排除这件事</button>${own?'<button class="button quiet" data-act="task-review-save" data-action="reopen">撤回我的核对</button>':''}</div>
        ${merge.length?`<label class="form-field"><span>与同一会议中的其他事项合并</span><select id="task-review-into"><option value="">选择合并目标</option>${merge.map(x=>`<option value="${esc(x.item_id)}" ${d.into===x.item_id?'selected':''}>${esc(x.title)}</option>`).join('')}</select></label><button class="button secondary" data-act="task-review-save" data-action="merge">合并到选定事项</button>`:''}
      </fieldset>
      <p class="meta">这里只保存你的核对答案，其他人的答案分别保留。确认内容后，创建飞书任务与业务完成仍需分别操作。</p>
      ${!locked && own?.status === 'confirmed' && own.kind === 'task' ? '<button class="button primary" data-act="task-review-raft-open">派给 a1234 / 查看执行结果</button><p class="meta">按已保存的本人答案继续核对本次派工；修改后请先保存。</p>' : ''}
      ${sectionTitle('依据原话')}${evidence || '<p class="error-text">依据暂不可读取</p>'}`);
  }
  function captureTaskReviewDraft() {
    const r = S.taskReview;
    if (!r?.draft) return;
    for (const key of ['kind','title','detail','due','owner','into']) {
      const el = $(`task-review-${key}`);
      if (el) r.draft[key] = el.value;
    }
    S.taskReviewDrafts.set(r.key,r.draft);
  }
  function saveTaskReview(action) {
    const r = S.taskReview;
    if (!r?.data || r.status !== 'ready' || r.account !== feishuAccountKey()) return;
    captureTaskReviewDraft();
    const d = r.draft;
    if (action==='confirm' && ((d.title?.trim().length || 0)<2 || d.kind==='task'&&!d.owner)) return toast('请填写事项并明确选择负责人',true);
    if (action==='merge' && !d.into) return toast('请先选择合并目标',true);
    const requestId = `task-save-${Date.now()}-${++S.taskReviewSerial}`;
    r.requestId = requestId;
    r.payload = {source_meeting_id:r.source.source_meeting.id,item_id:r.source.item_id,fingerprint:r.source.fingerprint,
      revision:r.data.revision,request_id:requestId,requestId,action,...d};
    retryTaskReview();
  }
  function retryTaskReview() {
    const r = S.taskReview;
    if (!r?.payload || r.readInvalidated || r.account!==feishuAccountKey() || r.status==='saving') return;
    r.status = 'saving'; r.error = null; send('tasks.review.save',r.payload); armTaskReviewTimeout(r); renderSheet();
  }
  function tasksHtml() {
    const t = S.tasks;
    const needSelf = t.mine && !canReadMyTasks();
    const mineAssignee = usesPersonalTaskIdentity() ? t.mineAssignee || t.reviewer : S.state.selfName;
    const q = t.query.trim().toLocaleLowerCase();
    const matches = value => !q || String(value || '').toLocaleLowerCase().includes(q);
    const items = (t.items || []).filter(x => matches([x.what, x.who, x.quote, x.meeting?.title, x.meeting?.goal].join(' ')));
    const archived = (t.archived || []).filter(x => matches([x.what, x.who, x.quote, x.meeting?.title, x.meeting?.goal].join(' ')));
    const available = [...(t.parsedItems || []), ...(t.meetingItems || []).filter(x => !x.linked_created)].filter(x => !t.mine || !!mineAssignee && parsedOwner(x) === mineAssignee);
    const parsed = available.filter(x => (t.reviewFilter === 'all' || parsedReviewState(x) === t.reviewFilter)
      && matches([x.title, x.what, x.detail, x.source_meeting?.title, ...(x.evidence || []).map(e => e.text), ...(x.reviews || []).flatMap(r => [r.by, r.owner, r.title])].join(' ')));
    const overdue = items.filter((x) => x.overdue), open = items.filter((x) => !x.overdue && ['open', 'unknown'].includes(x.feishu?.state));
    const done = items.filter((x) => x.feishu?.state === 'done'), gone = items.filter((x) => x.feishu?.state === 'deleted');
    const group = (title, rows) => rows.length ? `<section class="stack task-group"><div class="section-title"><h2>${title} <span class="meta">${rows.length}</span></h2></div>${rows.map(taskCard).join('')}</section>` : '';
    return `<div class="stack task-list">
      <section class="card">${listRow({act:'go',data:'data-route="raft"',ic:'chat-circle',title:'Oops 协作群',sub:'手写任务、Agent 派工与回复结果'})}</section>
      <div class="section-title"><div><h1 class="title">把事情往前推进</h1><p class="meta">先核对会议待办，再分别推进正式任务</p></div><button class="chip" type="button" data-act="tasks-retry" aria-label="刷新任务和核对状态">刷新</button></div>
      <div class="segmented" role="tablist">${[['review', '待核对'], ['mine', '我的任务'], ['all', '团队任务']].map(([k, label]) => `<button role="tab" aria-selected="${k === t.scope}" data-act="tasks-scope" data-value="${k}">${label}</button>`).join('')}</div>
      <div class="task-search-row"><div class="search-input">${icon('magnifying-glass', 18)}<input id="tasks-search" aria-label="搜索任务、原话或会议" placeholder="搜索任务、原话或会议" value="${esc(t.query)}"></div></div>
      ${needSelf ? `<section class="card"><h3>先选你是谁</h3><p class="meta">选好后，这里只列你负责的任务。</p><div class="inline-actions">${S.team.map((n) => `<button class="chip" data-act="tasks-self" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div></section>`
        : `${t.parsedItems === null ? spinnerHtml('正在读取会议待办…', '正式任务单独加载')
        : `<section class="stack task-group parsed-task-group"><div class="section-title"><h2>${t.mine ? '明确由我负责的会议候选' : '会议待办候选'} <span class="meta">${parsed.length}${parsed.length !== available.length ? ` / ${available.length}` : ''}</span></h2></div>
          <p class="meta">${t.mine ? '只显示人工明确指定本人、且核对没有分歧的候选。' : '未分配的待办也在这里。'}确认内容不代表业务完成；原话中的说话人与人工负责人分别记录。${t.refreshedAt ? ` · 本次读取 ${esc(formatDate(t.refreshedAt))}` : ''}</p>
          <div class="parsed-filters" aria-label="候选核对状态">${Object.entries(PARSED_FILTER).map(([key, label]) => `<button class="chip ${t.reviewFilter === key ? 'selected' : ''}" type="button" data-act="parsed-filter" data-value="${key}" aria-pressed="${t.reviewFilter === key}">${label}</button>`).join('')}</div>
          ${parsedStatusHtml(t.parsedStatus)}${[['label_review', '会议待核对'], ['meeting_review', 'App 会后已确认待办']].map(([source, title]) => { const rows = parsed.filter(x => x.source === source); return rows.length ? `<h3 class="parsed-source-heading">${title} · ${rows.length}</h3>${rows.map(parsedCard).join('')}` : ''; }).join('')}
          ${!parsed.length && !['loading', 'unavailable', 'disabled', 'unsupported'].includes(t.parsedStatus?.state) ? `<p class="meta">${t.mine ? '暂没有明确由你负责且符合筛选的会议候选；未分配或有分歧的内容可在「待核对」查看。' : '没有符合筛选的当前候选。可清除搜索或切换核对状态。'}</p>` : ''}</section>`}
          ${requestNotice(S.requests.tasks, 'formal-tasks-retry', t.items !== null)}${t.items === null ? S.requests.tasks.error ? '' : spinnerHtml('正在读取飞书正式任务…', '会议候选和核对入口可以独立使用') : `
          <section class="stack task-group formal-task-group"><div class="section-title"><h2>飞书正式任务 <span class="meta">${items.length}</span></h2><button class="chip" type="button" data-act="tasks-status-cycle" aria-label="筛选飞书业务状态">${{ open: '未完成', done: '已完成', all: '全部状态' }[t.status]}</button></div>
          <p class="meta">${t.mine ? `${esc(mineAssignee || '当前个人飞书账号')}负责` : '团队全部负责人'} · 已创建的飞书任务，业务状态单独读取</p>
          ${group('需要跟进', overdue)}${group('进行中', open)}${group('已完成', done)}${group('飞书里已删除', gone)}
          ${!items.length ? '<p class="meta">没有符合条件的飞书正式任务。上方候选尚不等于已创建任务。</p>' : ''}
          ${archived.length ? `<details><summary>已收起的验收记录 ${archived.length} 条</summary><p class="meta">保留原记录，已移出业务待办，不计入正式任务数量。</p>${archived.map(taskCard).join('')}</details>` : ''}</section>`}
        `}
    </div>`;
  }

  // Daily results contain only retained short excerpts, never a second temporary transcript.
  function dailyEntryHtml() {
    const p = S.dailyOverview, total = p?.total_candidate_count;
    const detail = total == null ? '查看私人候选与已确认的片段' : `${total} 条私人候选待核对`;
    return `<button class="card clickable ms-pending" data-act="daily-results"><span class="badge purple">私人重点</span><h3>日常聆听留下的重点</h3><p class="meta">${esc(detail)} · 按每次聆听查看</p><strong>查看重点 ${icon('caret-right',16)}</strong></button>`;
  }
  function requestDailyResults(sessionId = null) {
    const requestId = `daily-${++S.dailySerial}`;
    S.dailyRequest = {requestId,sessionId,loading:true};
    openSheet({kind:'dailyResults',sessionId});
    send('daily.results',{requestId,...(sessionId ? {sessionId} : {})});
  }
  function onDailyResults(p) {
    // Unsolicited hello/overview responses must not replace a chosen session or an edit.
    if (!p.requestId) {
      const changed = JSON.stringify(S.dailyOverview) !== JSON.stringify(p);
      S.dailyOverview=p;
      if (changed) refreshDailyOverview();
      return;
    }
    const pending = S.dailyRequest;
    if (!pending || pending.requestId !== p.requestId || pending.sessionId && pending.sessionId !== p.session_id) return;
    S.dailyRequest=null; S.dailyResults=p; S.dailyCandidates=p.candidates || []; S.dailyOverview=p;
    if (['dailyResults','dailyConfirm'].includes(S.sheet?.kind)) openSheet({kind:'dailyResults',sessionId:p.session_id});
    render();
  }
  function refreshDailyOverview() {
    if (document.activeElement?.matches('input,textarea,select')) {
      const panel=document.querySelector('[data-personal-daily-overview]');
      if (panel) { const top=$('scroll').scrollTop; panel.outerHTML=personalDailyOverviewHtml(); $('scroll').scrollTop=top; }
      return;
    }
    const top=$('scroll').scrollTop; render(); $('scroll').scrollTop=top;
  }
  function mutateDailyCandidate(type,payload) {
    if (S.dailyRequest?.mutation) return;
    const requestId=`daily-${++S.dailySerial}`, sessionId=S.sheet?.sessionId || payload.sessionId;
    S.dailyRequest={requestId,sessionId,loading:true,mutation:true}; renderSheet();
    send(type,{...payload,scopeSessionId:sessionId,requestId});
  }
  function dailyEvidenceHtml(item) {
    const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
    const quotes = evidence.length ? evidence.map(x => x.quote).filter(Boolean) : [item?.quote].filter(Boolean);
    return quotes.length ? `<div class="meta"><strong>原话短依据</strong>${quotes.map(q => `<p>“${esc(q)}”</p>`).join('')}</div>` : '<p class="meta">短依据暂未读到，请重新读取后核对。</p>';
  }
  const dailyCandidateText = item => item?.summary || item?.quote || '';
  const savedMemoryText = item => item.confirmed_text || item.quote || item.text || item.utterances?.map(u=>u.text).join(' ') || item.title || '已保存片段';
  function dailyResultsHtml() {
    const pending=S.dailyRequest, p=S.dailyResults;
    if (pending?.loading) return frame('日常聆听重点',spinnerHtml(pending.mutation?'正在更新重点…':'正在读取本机重点…','只读取已经留下的内容'));
    if (pending?.error) return frame('暂时无法读取重点',`<p class="error-text">${esc(pending.error)}</p><button class="button primary" data-act="daily-results-retry">重新读取</button>`);
    if (!p) return frame('日常聆听重点','<p>还没有读取到本机结果。</p><button class="button primary" data-act="daily-results-retry">读取重点</button>');
    const ended=p.receipt, cleanup=p.cleanup || ended?.cleanup;
    const items=(p.candidates || []).filter(x=>x.session_id === p.session_id);
    const saved=(p.saved_items || []).filter(x=>x.session_id === p.session_id);
    const count = value => value == null ? '暂未读到' : String(value);
    const errors=(p.errors || []).map(x=>`<p class="error-text">${esc(x.message)}</p>`).join('');
    const summary = ended ? `<section class="card"><p><strong>留下了什么：</strong>${count(ended.candidate_count_at_end)} 条私人候选重点，${count(ended.saved_count_at_end)} 条你单独确认保存的片段。</p><p><strong>清除了什么：</strong>${cleanup?.temporary_audio_cleared && cleanup?.temporary_transcript_cleared ? '最近5分钟的临时原音和全文已清除。' : '临时内容的清理结果尚未确认。'}${cleanup?.source_stopped === false ? '收音端清理未完成，请检查收音设备。' : ''}</p>${ended.pending_analysis_at_stop ? `<p class="warn-text">${ended.pending_analysis_at_stop} 条分析在结束时尚未完成，未计入留下的重点。</p>` : ''}</section>` : `<section class="card"><h3>${p.session_id ? '此前留下的重点' : '还没有留下的重点'}</h3><p>${p.session_id ? '这里只显示本机已有的私人候选与已确认片段。' : '日常聆听结束后，留下的重点会直接显示在这里。'}</p>${p.session_id ? '<p class="meta">这次聆听的结束时间与清理回执未记录。</p>' : ''}</section>`;
    const history=(p.sessions || []).filter(x=>x.session_id !== p.session_id);
    return frame(ended ? '日常聆听已结束' : '日常聆听重点', `<p class="meta">${p.ended_at ? formatDate(p.ended_at)+' 结束' : p.session_id ? '结束时间未记录' : '本机暂无日常聆听结果'}</p>
      ${errors}${summary}${errors ? '<button class="button secondary" data-act="daily-results-retry">重新读取本机结果</button>' : ''}
      ${sectionTitle(`待你核对的重点 · ${count(p.candidate_count)}`)}
      ${items.length ? items.map(x=>`<section class="card"><span class="badge gray">${esc(TAG_LABELS[x.tag] || '重点')} · 私人待核对</span><p>${esc(dailyCandidateText(x))}</p>${x.summary ? dailyEvidenceHtml(x) : '<p class="meta">原话摘录 · 未作摘要'+(x.excerpt_truncated ? '，只保留部分短原话' : '')+'</p>'}${x.related_candidate_id && items.some(other=>other.id === x.related_candidate_id) ? '<p class="meta">可能与本次另一条重点重复，两条仍需分别核对。</p>' : ''}${x.occurrences > 1 ? `<p class="meta">相同文字出现 ${esc(x.occurrences)} 次，未据此判断说话人或共识。</p>` : ''}<div class="action-grid"><button class="button secondary" data-act="daily-confirm-open" data-id="${esc(x.id)}" data-session="${esc(x.session_id)}">核对并保存</button><button class="button quiet" data-act="daily-discard" data-id="${esc(x.id)}" data-session="${esc(x.session_id)}">舍弃</button></div></section>`).join('') : `<p>${p.candidate_count == null ? '暂时无法读取候选，请重新读取。' : '这次没有待核对的候选重点。'}</p>`}
      ${saved.length ? `${sectionTitle('已单独确认保存 · '+count(p.saved_count))}${saved.map(x=>`<section class="card"><span class="badge purple">已确认 · 私人</span><p>${esc(savedMemoryText(x))}</p>${x.evidence ? dailyEvidenceHtml(x) : ''}</section>`).join('')}` : ''}
      <p class="meta">候选仍待核对，不自动创建任务或共享；日常聆听不生成整场会议档案。只显示已整理并留下的内容。</p>
      ${history.length ? `${sectionTitle('其他日常聆听')}${history.map(x=>listRow({act:'daily-results',data:`data-session="${esc(x.session_id)}"`,ic:'bookmark-simple',title:x.ended_at ? formatDate(x.ended_at) : '此前的日常重点',sub:`${count(x.candidate_count)}条待核对 · ${count(x.saved_count)}条已保存${x.ended_at ? '' : ' · 结束时间未记录'}`})).join('')}` : ''}
      <button class="button quiet" data-act="close">完成，稍后可从首页查看</button>`);
  }

  // ---- 记忆 ---------------------------------------------------------------------------------

  function memoryHtml() {
    const seg = `<div class="segmented" role="tablist" aria-label="记忆范围">${[['meetings', '会议／项目'], ['personal', '个人']].map(([k, label]) => `<button role="tab" aria-selected="${k === S.memoryTab}" data-act="memory-tab" data-value="${k}">${label}</button>`).join('')}</div>`;
    if (S.memoryTab === 'personal') return `<div class="stack memory-settings memory-hub">${seg}${personalMemoryHtml()}</div>`;
    const chips = `<div class="memory-view-chips" aria-label="会议与项目">${[['meetings', '会议'], ['projects', '项目']].map(([key, title]) => `<button class="chip ${S.memoryView === key ? 'selected' : ''}" data-act="memory-view" data-value="${key}" aria-pressed="${S.memoryView === key}">${title}</button>`).join('')}</div>`;
    if (S.memoryView === 'meetings') {
      const query = S.memoryQuery.trim().toLocaleLowerCase();
      const items = historyRows().filter(m => !query || `${meetingName(m)} ${m.project || ''}`.toLocaleLowerCase().includes(query));
      return `<div class="stack memory-settings memory-hub">${seg}${chips}
        <div class="memory-page-heading"><div><h2>每次会议，都有来处</h2><p class="meta">原文、总结纪要与核对结果</p></div>${icon('books', 28)}</div>
        <div class="search-input">${icon('magnifying-glass', 18)}<input id="memory-meeting-search" aria-label="搜索已载入会议" placeholder="搜索已载入会议" value="${esc(S.memoryQuery)}"></div>
        <div class="memory-list-heading"><h3>最近会议</h3><span class="meta">${S.historyItems ? `显示 ${historyRows().length} 场 · 最近30场范围` : '最近30场范围'}</span></div>
        ${historyFilterHtml()}
        ${requestNotice(S.requests.history, 'history-retry', !!S.historyItems)}
        ${S.historyItems == null ? S.requests.history.error ? '' : spinnerHtml('正在读取会议…', '读取已保存的会议与结果状态') : items.map(sessionCard).join('') || `<div class="empty-state">${emptyArt(query ? 'thinking' : 'sleepy', 'books')}<strong>${query ? '没有找到对应会议' : S.historyMeta?.hidden_empty_count ? '暂无符合条件的会议' : '还没有保存的会议'}</strong><p>${query ? '可换个名称，或在会话中查找原话。' : S.historyMeta?.hidden_empty_count ? '不足3分钟或0句的会议已隐藏，可点上方查看全部。' : '明确选择云端保存的正式会议会出现在这里。'}</p></div>`}
        <p class="meta">会议结果沿用本场保存期限与核对状态。日常重点在「个人」中单独核对保存。</p></div>`;
    }
    const items = S.projects.items, demo = !!window.OopsDemoTransport;
    return `<div class="stack memory-settings memory-hub">${seg}${chips}
      <div class="memory-page-heading"><div><h2>把同一件事接着记</h2><p class="meta">${demo ? '汇集项目的改编讨论、候选与演示任务' : '汇集项目的会议、确认决定与行动'}</p></div>${icon('folder-simple', 28)}</div>
      ${meetingWorkEntryHtml()}
      ${sectionTitle('项目')}
      ${requestNotice(S.requests.projects, 'projects-retry', !!items)}
      ${items == null ? S.requests.projects.error ? '' : spinnerHtml('正在读取项目…', '团队服务器') : items.map((p) => `<button class="card clickable" data-act="project-open" data-name="${esc(p.name)}">
        <div class="ms-card-heading"><span class="badge purple">项目</span>${icon('folder-simple', 18)}</div><h3>${esc(p.name)}</h3>
        <p class="ms-preview">${p.meeting_count} 场会议 · ${demo ? '讨论要点候选（示例）' : `已确认决定 ${p.confirmed_decisions}`}</p><p class="meta">最近 ${formatDate(p.last_started_at)}</p></button>`).join('')
        || `<div class="empty-state">${emptyArt('sleepy', 'folder-simple')}<strong>还没有项目</strong><p>打开一场会议，点「所属项目」新建或选择项目。</p></div>`}
    </div>`;
  }

  const PERSONAL_KINDS = ['身份', '偏好', '目标', '经历', '日常'];
  const PERSONAL_ICONS = { 身份: 'user-circle', 偏好: 'sliders-horizontal', 目标: 'target', 经历: 'clock-counter-clockwise', 日常: 'bookmark-simple' };
  const personalDate = value => typeof value === 'number' && value > 0 ? formatDate(new Date(value).toISOString()) : typeof value === 'string' && value ? formatDate(value) : '时间未记录';
  const personalOrder = (a, b) => (Number(b.updatedAt) || Date.parse(b.updatedAt) || 0) - (Number(a.updatedAt) || Date.parse(a.updatedAt) || 0);
  const personalBusy = () => !!S.personal.mutation || !!S.personalAuto.mutation;
  const personalSourceLabel = item => item.demo || item.synthetic ? '演示档案 · 非本人已确认事实' : item.source === 'daily_personal_confirmed' ? item.source_status === 'changed' ? '日常来源已变化 · 待重核' : '日常对话 · 本人已确认' : '本人手写';
  const personalId = () => `personal-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16); })}`;
  function personalItem(value) {
    return value && typeof value.id === 'string' && typeof value.title === 'string' && value.title.trim() &&
      typeof value.body === 'string' && value.body.trim() && PERSONAL_KINDS.includes(value.kind) ? value : null;
  }
  function personalRequestId() { return `personal-${Date.now().toString(36)}-${++S.personal.serial}`; }
  function refreshPersonalUi() {
    if (S.route.name === 'memory' && S.memoryTab === 'personal') {
      if (document.activeElement?.matches('input,textarea,select')) {
        const panel=document.querySelector('[data-personal-auto-candidates]');
        if (panel) { const top=$('scroll').scrollTop; panel.outerHTML=personalAutoHtml(); $('scroll').scrollTop=top; }
      } else render();
    }
    const reviewed=S.sheet?.kind === 'personalAutoReview' ? (S.personalAuto.items || []).find(item => item.id === S.sheet.id) : null;
    const reviewDraft=S.sheet?.kind === 'personalAutoReview' ? S.personalAuto.drafts.get(S.sheet.id) : null;
    const changedReview=S.sheet?.kind === 'personalAutoReview' && (!reviewed || !reviewDraft || reviewed.version !== reviewDraft.version || reviewed.source_fingerprint !== reviewDraft.source_fingerprint);
    if (['personalDetail', 'personalEdit', 'personalDelete', 'personalAutoReview', 'personalAutoDiscard'].includes(S.sheet?.kind)
        && (changedReview || !document.activeElement?.matches('#sheet input,#sheet textarea,#sheet select'))) renderSheet();
  }
  function loadPersonal() {
    const p = S.personal;
    if (p.listRequest || p.mutation?.status === 'saving') return;
    const request = { requestId: personalRequestId() };
    p.listRequest = request; p.error = null;
    request.timer = setTimeout(() => {
      if (p.listRequest !== request) return;
      p.listRequest = null; p.error = '本机记忆暂未返回，请重新读取。'; refreshPersonalUi();
    }, 12000);
    send('personal.list', { requestId: request.requestId });
    return request.requestId;
  }
  function personalMatches(item, operation) {
    return item && item.id === operation.id && ['title', 'body', 'kind'].every(key => item[key] === operation[key]);
  }
  function finishPersonalMutation(item) {
    const p = S.personal, operation = p.mutation;
    if (!operation) return;
    clearTimeout(operation.timer);
    if (p.listRequest) { clearTimeout(p.listRequest.timer); p.listRequest = null; }
    if (operation.action === 'delete') p.items = (p.items || []).filter(x => x.id !== operation.id);
    else {
      p.items = [item, ...(p.items || []).filter(x => x.id !== item.id)].sort(personalOrder);
    }
    p.drafts.delete(operation.id);
    p.mutation = null; p.error = null;
    if (S.sheet?.kind === 'personalEdit' && p.editKey === operation.id || ['personalDelete', 'personalDetail'].includes(S.sheet?.kind) && S.sheet.id === operation.id) closeSheet();
    toast(operation.action === 'delete' ? p.mock ? '已删除当前示例记忆' : '已删除本机个人记忆' : p.mock ? '已保存在当前示例，刷新清空' : '已保存到本机个人记忆');
    refreshPersonalUi();
  }
  function onPersonalResult(result) {
    const p = S.personal;
    if (result.action === 'list') {
      const request = p.listRequest;
      if (!request || result.requestId !== request.requestId) return;
      clearTimeout(request.timer); p.listRequest = null;
      if (result.ok !== true || !Array.isArray(result.items) || result.items.some(item => !personalItem(item))) {
        p.error = String(result.error || '本机个人记忆读取失败，请重试。'); refreshPersonalUi(); return;
      }
      p.mock = result.mock === true;
      p.items = result.items.slice().sort(personalOrder); p.error = null;
      if (S.personalAuto.mutation?.memoryReadRequestId === result.requestId) {
        S.personalAuto.mutation.memoryChecked=true;
        if (resolvePersonalCandidateOutcome()) return;
      }
      const operation = p.mutation;
      if (operation?.status === 'unknown') {
        const item = p.items.find(x => x.id === operation.id);
        if (operation.action === 'delete' ? !item : personalMatches(item, operation)) { finishPersonalMutation(item); return; }
        if (operation.finished) {
          p.mutation = null; p.error = `${operation.error || '本次修改未完成。'} 已重新读取本机内容，未将本次草稿标成已保存。`;
          refreshPersonalUi(); return;
        }
        operation.error = '尚未读到本次修改的结果。请稍后再读取；当前没有重新写入。';
      }
      refreshPersonalUi(); return;
    }
    const operation = p.mutation;
    if (!operation || operation.requestId !== result.requestId || operation.action !== result.action) return;
    clearTimeout(operation.timer);
    if (result.ok === true && (result.action === 'delete' || personalMatches(personalItem(result.item), operation))) {
      finishPersonalMutation(result.item); return;
    }
    if (result.ok === false) {
      operation.status = 'unknown'; operation.finished = true;
      operation.error = String(result.error || '本机修改结果未确认，请先重新读取核对。');
      refreshPersonalUi(); return;
    }
    operation.status = 'unknown'; operation.error = '回执尚不能确认结果，请重新读取本机内容核对。'; refreshPersonalUi();
  }
  function personalMutation(action, payload) {
    const p = S.personal;
    if (personalBusy()) return;
    if (p.listRequest) { clearTimeout(p.listRequest.timer); p.listRequest = null; }
    const operation = { ...payload, action, requestId: personalRequestId(), status: 'saving' };
    p.mutation = operation; p.error = null;
    operation.timer = setTimeout(() => {
      if (p.mutation !== operation) return;
      operation.status = 'unknown'; operation.error = '本机回执未确认，请先重新读取。不会自动重复保存或删除。'; refreshPersonalUi();
    }, 12000);
    refreshPersonalUi();
    send(`personal.${action}`, { ...payload, requestId: operation.requestId });
  }
  function personalMutationHtml() {
    const p = S.personal, operation = p.mutation;
    if (!operation) return '';
    return `<section class="card memory-save-status" role="status"><strong>${operation.status === 'saving' ? '正在等待本机回执…' : '这次修改的结果待核对'}</strong><p class="meta">${esc(operation.error || '确认写入成功后才会更新已保存内容。')}</p>${operation.status === 'unknown' ? `<button class="button secondary" data-act="personal-reload" ${p.listRequest ? 'disabled' : ''}>${p.listRequest ? '正在读取…' : '重新读取本机结果'}</button>` : ''}</section>`;
  }
  function personalCandidate(value) {
    return value && typeof value.id === 'string' && typeof value.session_id === 'string' &&
      Number.isInteger(value.version) && value.version > 0 && /^[a-f0-9]{64}$/.test(value.source_fingerprint || '') &&
      value.status === 'candidate' && PERSONAL_KINDS.includes(value.kind) && typeof value.title === 'string' && value.title.trim() &&
      typeof (value.summary || value.text) === 'string' && (value.summary || value.text).trim() &&
      Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(part => part && typeof part.quote === 'string' && part.quote.trim());
  }
  function loadPersonalCandidates() {
    const a=S.personalAuto;
    if (a.listRequest || a.mutation?.status === 'saving') return;
    const request={requestId:personalRequestId()}; a.listRequest=request; a.error=null;
    request.timer=setTimeout(() => {
      if (a.listRequest !== request) return;
      a.listRequest=null; a.items=null; a.error='自动整理暂时无法读取，请重新读取。'; refreshPersonalUi();
    },12000);
    const operation=a.mutation;
    const check=operation?.status === 'unknown' ? {action:operation.action,id:operation.id,version:operation.version,source_fingerprint:operation.source_fingerprint,
      ...(operation.action === 'confirm' ? {kind:operation.kind,title:operation.title,text:operation.text} : {})} : null;
    send('personal.candidates',{requestId:request.requestId,...(check ? {check} : {})});
    return request.requestId;
  }
  function personalCandidateOrigin(item, operation) {
    return personalItem(item) && item.source === 'daily_personal_confirmed' && ['current','changed'].includes(item.source_status) &&
      item.confirmed === true && item.subject_confirmed === true && item.candidate_id === operation.id && item.candidate_version === operation.version && item.source_fingerprint === operation.source_fingerprint;
  }
  function personalCandidateSaved(item, operation) {
    return personalCandidateOrigin(item,operation) &&
      item.kind === operation.kind && item.title === operation.title && (item.confirmed_text || item.body) === operation.text;
  }
  function invalidatePersonalCandidateDrafts() {
    const a=S.personalAuto;
    for (const [id,draft] of a.drafts) {
      const item=(a.items || []).find(value => value.id === id);
      if (!item || item.version !== draft.version || item.source_fingerprint !== draft.source_fingerprint) {
        draft.subject_confirmed=false; draft.content_confirmed=false;
      }
    }
  }
  function finishPersonalCandidate(memory, outcome = 'applied') {
    const a=S.personalAuto, operation=a.mutation;
    if (!operation) return;
    clearTimeout(operation.timer);
    if (a.listRequest) { clearTimeout(a.listRequest.timer); a.listRequest=null; }
    if (S.personal.listRequest) { clearTimeout(S.personal.listRequest.timer); S.personal.listRequest=null; }
    a.items=(a.items || []).filter(item => item.id !== operation.id || item.version !== operation.version || item.source_fingerprint !== operation.source_fingerprint);
    a.drafts.delete(operation.id); a.mutation=null; a.error=null;
    if (memory) S.personal.items=[memory,...(S.personal.items || []).filter(item => item.id !== memory.id)].sort(personalOrder);
    else if (outcome === 'saved_missing' && operation.receiptMemoryId) S.personal.items=(S.personal.items || []).filter(item => item.id !== operation.receiptMemoryId);
    if (['personalAutoReview','personalAutoDiscard'].includes(S.sheet?.kind) && S.sheet.id === operation.id) closeSheet();
    toast(outcome === 'saved_missing' ? '本次保存已核实，该条记忆后来已移除' : operation.action === 'confirm'
      ? memory?.source_status === 'changed' ? '保存已核实；日常来源已变化，请重新核对'
        : memory && !personalCandidateSaved(memory,operation) ? '本次保存已核实，当前内容已有更新，请查看' : '已核对并保存为本机个人记忆' : '已舍弃这条个人候选');
    refreshPersonalUi();
    if (operation.action === 'confirm') loadPersonal();
  }
  function resolvePersonalCandidateOutcome() {
    const a=S.personalAuto, operation=a.mutation;
    if (operation?.status !== 'unknown') return false;
    if (operation.memoryChecked && operation.action === 'confirm') {
      const memory=(S.personal.items || []).find(item => personalCandidateSaved(item,operation));
      if (memory) { finishPersonalCandidate(memory); return true; }
    }
    const resolution=operation.resolution;
    const exact=resolution && resolution.id === operation.id && resolution.version === operation.version && resolution.source_fingerprint === operation.source_fingerprint && resolution.action === operation.action;
    if (exact && operation.action === 'discard' && resolution.status === 'discarded') { finishPersonalCandidate(null); return true; }
    if (exact && operation.action === 'confirm' && resolution.status === 'confirmed') {
      operation.receiptMemoryId=resolution.memory_id;
      if (operation.resolvedMemory && operation.resolvedMemory.id === resolution.memory_id && personalCandidateOrigin(operation.resolvedMemory,operation)) {
        finishPersonalCandidate(operation.resolvedMemory); return true;
      }
      if (resolution.memory_missing === true) { finishPersonalCandidate(null,'saved_missing'); return true; }
    }
    if (!operation.candidatesChecked || !operation.memoryChecked) return false;
    const candidate=(a.items || []).find(item => item.id === operation.id);
    if (!candidate) {
      operation.error='候选已不在待核对列表，保存或舍弃回执尚未核实。请继续只读核对，不会重复提交。';
      return false;
    }
    operation.error='尚未核实本次修改结果。保留原请求与编辑稿，请稍后重新读取；不会重复提交。';
    return false;
  }
  function onPersonalCandidatesResult(result) {
    const a=S.personalAuto;
    if (result.action === 'list') {
      const request=a.listRequest;
      if (!request || request.requestId !== result.requestId) return;
      clearTimeout(request.timer); a.listRequest=null;
      if (result.ok !== true || result.capabilities?.typed_candidates !== true || !['not_observed','supported'].includes(result.processing_status) || !Array.isArray(result.items) || result.items.some(item => !personalCandidate(item))) {
        a.items=null; a.error=String(result.error || '自动个人候选读取失败，请重新读取。'); refreshPersonalUi(); return;
      }
      a.items=result.items.slice(); a.processingStatus=result.processing_status; a.error=null; invalidatePersonalCandidateDrafts();
      if (a.mutation?.candidateReadRequestId === result.requestId) {
        a.mutation.candidatesChecked=true; a.mutation.resolution=result.resolution || null; a.mutation.resolvedMemory=result.memory || null;
        if (resolvePersonalCandidateOutcome()) return;
      }
      refreshPersonalUi(); return;
    }
    const operation=a.mutation;
    if (!operation || operation.requestId !== result.requestId || operation.action !== result.action) return;
    clearTimeout(operation.timer);
    if (result.ok === false && result.write_status === 'not_applied') {
      a.mutation=null; a.items=null; invalidatePersonalCandidateDrafts();
      if (['personalAutoReview','personalAutoDiscard'].includes(S.sheet?.kind) && S.sheet.id === operation.id) closeSheet();
      toast(String(result.error || '本次未写入，请重新读取并核对后再操作。'),true);
      loadPersonalCandidates(); loadPersonal(); refreshPersonalUi(); return;
    }
    if (result.ok === true && Array.isArray(result.items) && result.items.every(personalCandidate)
        && !result.items.some(item => item.id === operation.id && item.version === operation.version && item.source_fingerprint === operation.source_fingerprint)
        && (operation.action === 'discard' || personalCandidateSaved(result.memory,operation))) {
      a.items=result.items; finishPersonalCandidate(result.memory); return;
    }
    operation.status='unknown'; operation.finished=result.ok === false;
    operation.error=String(result.error || '原生回执尚不能确认结果，请只读核对本次候选与已保存记忆。');
    refreshPersonalUi();
  }
  function readPersonalCandidateOutcome() {
    const a=S.personalAuto, operation=a.mutation;
    if (!operation || operation.status !== 'unknown') { loadPersonalCandidates(); loadPersonal(); refreshPersonalUi(); return; }
    if (a.listRequest || S.personal.listRequest) return;
    operation.candidatesChecked=false; operation.memoryChecked=false; operation.resolution=null; operation.resolvedMemory=null;
    operation.candidateReadRequestId=loadPersonalCandidates(); operation.memoryReadRequestId=loadPersonal();
    refreshPersonalUi();
  }
  function personalCandidateMutation(action, payload) {
    const a=S.personalAuto;
    if (personalBusy()) return;
    if (a.listRequest) { clearTimeout(a.listRequest.timer); a.listRequest=null; }
    if (S.personal.listRequest) { clearTimeout(S.personal.listRequest.timer); S.personal.listRequest=null; }
    const operation={...payload,action,requestId:personalRequestId(),status:'saving'}; a.mutation=operation; a.error=null;
    operation.timer=setTimeout(() => {
      if (a.mutation !== operation) return;
      operation.status='unknown'; operation.error='本次原生回执未确认。请重新读取核对，不会自动保存、舍弃或换请求重发。'; refreshPersonalUi();
    },12000);
    if (['personalAutoReview','personalAutoDiscard'].includes(S.sheet?.kind)) renderSheet();
    refreshPersonalUi();
    send(`personal.candidate.${action}`,{...payload,requestId:operation.requestId});
  }
  function personalAutoMutationHtml() {
    const operation=S.personalAuto.mutation;
    if (!operation) return '';
    return `<section class="card memory-save-status" role="status"><strong>${operation.status === 'saving' ? '正在等待本机保存回执…' : '这次操作结果待核对'}</strong><p class="meta">${esc(operation.error || '尚未计入已保存个人记忆。')}</p>${operation.status === 'unknown' ? `<button class="button secondary" data-act="personal-auto-recheck" ${S.personalAuto.listRequest || S.personal.listRequest ? 'disabled' : ''}>重新读取本次结果</button>` : ''}</section>`;
  }
  function personalCandidateEvidenceHtml(item) {
    return `<div class="personal-auto-evidence"><strong>原话短依据</strong>${item.evidence.map(part => `<blockquote>“${esc(part.quote)}”<small>${Number.isFinite(part.start_ms) ? hms(part.start_ms) : '时间未记录'}${part.speaker ? ` · 原记录说话人：${esc(manualLabel(part.speaker))}` : ' · 说话人未记录'}</small></blockquote>`).join('')}</div>`;
  }
  function personalAutoHtml() {
    const a=S.personalAuto;
    const heading=`<div class="memory-list-heading"><h3>从日常对话整理 · 待核对${a.items ? ` ${a.items.length}` : ''}</h3><button class="text-action" data-act="personal-auto-reload" ${a.listRequest || a.mutation?.status === 'saving' ? 'disabled' : ''}>重新读取</button></div>`;
    return `<section class="personal-auto-panel" data-personal-auto-candidates>${heading}<p class="meta">关于你的身份、偏好、目标、经历与日常线索，先核对本人归属和原话，再保存。</p>${personalAutoMutationHtml()}
      ${a.error ? `<p class="error-text" role="status">${esc(a.error)}</p>` : ''}${a.listRequest ? '<p class="meta" role="status">正在读取本机已整理的个人候选…</p>' : ''}
      ${a.items == null ? a.error ? '' : '<p class="meta">自动整理结果暂未读到。</p>' : a.items.map(item => `<button class="card clickable personal-auto-card" data-act="personal-auto-open" data-id="${esc(item.id)}" ${personalBusy() ? 'disabled' : ''}><div class="ms-card-heading"><span class="badge purple">建议：${esc(item.kind)}</span><span class="badge gray">本人归属待核对</span></div><h3>${esc(item.title)}</h3><p>${esc(item.summary || item.text)}</p><blockquote class="memory-source-quote">“${esc(item.evidence[0].quote)}”</blockquote><p class="meta">来自日常对话 · ${item.updatedAt ? esc(personalDate(item.updatedAt)) : '整理时间未记录'} · 未确认</p><strong class="text-action">核对这条个人线索 ${icon('caret-right',14)}</strong></button>`).join('') || `<section class="memory-handwritten-empty"><strong>${a.processingStatus === 'not_observed' ? '等待发现关于你的新线索' : '目前没有待核对的个人线索'}</strong><p class="meta">${a.processingStatus === 'not_observed' ? '日常聆听中出现关于你的明确线索后，会在这里等你核对。' : '新的身份、偏好、目标或经历线索会先放在这里。'}</p></section>`}</section>`;
  }
  function openPersonalCandidate(id) {
    const a=S.personalAuto, item=(a.items || []).find(value => value.id === id);
    if (!item || a.error || personalBusy()) return toast('请先重新读取当前个人候选',true);
    const previous=a.drafts.get(id);
    if (!previous || previous.version !== item.version || previous.source_fingerprint !== item.source_fingerprint) {
      a.drafts.set(id,{id:item.id,version:item.version,source_fingerprint:item.source_fingerprint,kind:item.kind,title:item.title,text:item.summary || item.text,subject_confirmed:false,content_confirmed:false});
    }
    a.editKey=id; openSheet({kind:'personalAutoReview',id});
  }
  function capturePersonalCandidateDraft() {
    if (S.sheet?.kind !== 'personalAutoReview' || personalBusy()) return;
    const draft=S.personalAuto.drafts.get(S.personalAuto.editKey);
    if (!draft) return;
    for (const [id,key] of [['personal-auto-kind','kind'],['personal-auto-title','title'],['personal-auto-text','text']]) if ($(id)) draft[key]=$(id).value;
    draft.subject_confirmed=$('personal-auto-subject')?.checked === true; draft.content_confirmed=$('personal-auto-confirmed')?.checked === true;
  }
  function resetPersonalCandidateChecks() {
    const draft=S.personalAuto.drafts.get(S.personalAuto.editKey);
    if (!draft || personalBusy()) return;
    draft.subject_confirmed=false; draft.content_confirmed=false;
    if ($('personal-auto-subject')) $('personal-auto-subject').checked=false;
    if ($('personal-auto-confirmed')) $('personal-auto-confirmed').checked=false;
  }
  function personalCandidateReviewHtml() {
    const a=S.personalAuto, item=(a.items || []).find(value => value.id === S.sheet.id), draft=a.drafts.get(S.sheet.id);
    if (!item || !draft || item.version !== draft.version || item.source_fingerprint !== draft.source_fingerprint) return frame('请重新读取个人候选',`${personalAutoMutationHtml()}<p>这条候选已变化或不在当前列表，旧稿不能直接保存。</p><button class="button secondary" data-act="personal-auto-reload">重新读取</button>`);
    const locked=personalBusy();
    return frame('核对关于我的这条线索',`${personalAutoMutationHtml()}${a.error ? `<p class="error-text">${esc(a.error)}</p>` : ''}<span class="badge gray">自动整理 · 未确认</span>${personalCandidateEvidenceHtml(item)}
      <label class="form-field"><span>保存分类，可修改</span><select id="personal-auto-kind" ${locked ? 'disabled' : ''}>${PERSONAL_KINDS.map(kind => `<option ${draft.kind === kind ? 'selected' : ''}>${kind}</option>`).join('')}</select></label>
      <label class="form-field"><span>标题</span><input id="personal-auto-title" maxlength="100" value="${esc(draft.title)}" ${locked ? 'disabled' : ''}></label>
      <label class="form-field"><span>要记住的内容，可改写</span><textarea id="personal-auto-text" rows="4" maxlength="280" ${locked ? 'disabled' : ''}>${esc(draft.text)}</textarea></label>
      <label class="check-row"><input id="personal-auto-subject" type="checkbox" ${draft.subject_confirmed ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>我确认这条内容确实与我本人有关，并非他人、引用或假设</span></label>
      <label class="check-row"><input id="personal-auto-confirmed" type="checkbox" ${draft.content_confirmed ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>我已核对原话、分类及保存内容，同意存为本机个人记忆</span></label>
      <p class="meta">自动整理、本人改写和短原话分别保留。此处确认不登记声音身份、不共享，也不把资料自动提供给助手。</p>
      <button class="button primary" data-act="personal-auto-confirm" ${locked ? 'disabled' : ''}>核对并保存个人记忆</button><button class="button quiet" data-act="personal-auto-discard-prompt" ${locked ? 'disabled' : ''}>舍弃这条候选</button><button class="button quiet" data-act="close">${locked ? '稍后查看结果' : '返回，保留本次编辑'}</button>`);
  }
  function personalCandidateDiscardHtml() {
    return frame('舍弃这条个人候选？',`${personalAutoMutationHtml()}<p>只移除这条尚未确认的个人线索，不改会议、普通日常重点或已保存的个人记忆。</p><button class="button danger" data-act="personal-auto-discard" ${personalBusy() ? 'disabled' : ''}>确认舍弃候选</button><button class="button quiet" data-act="close">返回</button>`);
  }
  function personalDailyOverviewHtml() {
    const p=S.dailyOverview;
    if (!p) return `<section class="card memory-source-panel" data-personal-daily-overview><h3>日常聆听留下的重点</h3><p class="meta">本机结果暂未读到。</p><button class="button secondary" data-act="daily-results">读取已有重点</button></section>`;
    const sid=typeof p.session_id === 'string' ? p.session_id : '';
    const known=value => Number.isInteger(value) && value >= 0;
    const count=value => known(value) ? String(value) : '暂未读到';
    const pending=p.storage?.candidates === 'failed' ? null : p.candidate_count;
    const confirmed=p.storage?.saved === 'failed' ? null : p.saved_count;
    const candidates=known(pending) && sid ? (p.candidates || []).filter(x => x.session_id === sid && !x.confirmed).slice(0,3) : [];
    const saved=known(confirmed) && sid ? (p.saved_items || []).filter(x => x.session_id === sid).slice(0,3) : [];
    const histories=(p.sessions || []).filter(x => x.session_id !== sid);
    const quote=item => (item.evidence || []).find(x => typeof x.quote === 'string' && x.quote)?.quote || item.quote || '';
    return `<section class="memory-source-panel" data-personal-daily-overview>
      <div class="memory-list-heading"><h3>日常聆听留下的重点</h3><span class="meta">${p.ended_at ? `${esc(formatDate(p.ended_at))} 结束` : sid ? '结束时间未记录' : '尚无日常记录'}</span></div>
      <div class="memory-source-counts"><span><strong>${count(pending)}</strong>待你核对 · 未确认</span><span><strong>${count(confirmed)}</strong>本次已单独确认</span></div>
      ${(p.errors || []).map(error => `<p class="error-text" role="status">${esc(error.message || '本机结果读取失败，请重新读取')}</p>`).join('')}
      ${candidates.map(item => `<button class="card clickable memory-source-preview" data-act="daily-results" data-session="${esc(sid)}"><span class="badge gray">私人候选 · 未确认${TAG_LABELS[item.tag] ? ` · ${esc(TAG_LABELS[item.tag])}` : ''}</span><p class="memory-body-preview">${esc(dailyCandidateText(item))}</p>${item.summary && quote(item) ? `<blockquote class="memory-source-quote">“${esc(quote(item))}”</blockquote>` : '<p class="meta">原话摘录，尚未确认为个人记忆</p>'}<strong class="text-action">重新读取并核对 ${icon('caret-right',14)}</strong></button>`).join('')}
      ${known(pending) && pending === 0 ? '<p class="meta">这次没有待核对的私人候选。</p>' : !known(pending) ? '<p class="meta">候选数量暂未读到，请重新读取核对。</p>' : `<p class="meta">${pending > candidates.length ? `先展示${candidates.length}条；共${pending}条` : `这${pending}条`}仍待你逐项核对，尚未进入已确认记忆。</p>`}
      ${saved.map(item => `<section class="card memory-source-preview"><span class="badge purple">本人已单独确认 · 私人</span><p class="memory-body-preview">${esc(savedMemoryText(item))}</p>${item.evidence ? dailyEvidenceHtml(item) : ''}</section>`).join('')}
      ${known(confirmed) && confirmed === 0 ? '<p class="meta">本次已单独确认的片段为0；上方候选仍未确认。</p>' : !known(confirmed) ? '<p class="meta">已确认片段数量暂未读到。</p>' : ''}
      <button class="button secondary" data-act="daily-results" ${sid ? `data-session="${esc(sid)}"` : ''}>${known(pending) && pending > 0 ? `查看并核对本次${pending}条重点` : '重新读取本次重点'}</button>
      ${histories.length ? `<details class="memory-source-history"><summary>其他日常聆听 · ${histories.length}次</summary>${histories.map(item => listRow({act:'daily-results',data:`data-session="${esc(item.session_id)}"`,ic:'bookmark-simple',title:item.ended_at ? formatDate(item.ended_at) : '此前的日常重点',sub:`${known(item.candidate_count) ? `${item.candidate_count}条待核对` : '待核对数量暂未读到'} · ${known(item.saved_count) ? `${item.saved_count}条已单独确认` : '已确认数量暂未读到'}`})).join('')}</details>` : ''}
      ${listRow({act:'saved-list',ic:'bookmark-simple',title:'所有已单独保存的短片段',sub:'与待核对候选、手写档案分别保留'})}
    </section>`;
  }
  function personalMemoryHtml() {
    const p = S.personal, query = p.query.trim().toLocaleLowerCase();
    const items = (p.items || []).filter(item => (p.kind === '全部' || item.kind === p.kind) && (!query || `${item.title} ${item.body}`.toLocaleLowerCase().includes(query)));
    return `<div class="memory-page-heading"><div><h2>关于我，慢慢记住</h2><p class="meta">从对话整理，由你核对后留下</p></div><button class="button secondary memory-add" data-act="personal-new" ${personalBusy() || p.items === null || p.error ? 'disabled' : ''}>${icon('plus', 18)}<span>手动补充</span></button></div>
      <p class="memory-private-note">${icon('lock-key', 16)}${p.mock ? '浏览器内存示例 · 刷新后清空' : '个人记忆保存在本机 · 候选核对后才保存'}</p>
      ${personalAutoHtml()}
      <div class="memory-list-heading"><h3>已保存的个人记忆</h3><span class="meta">${p.items ? `共 ${p.items.length} 条` : '数量暂未读到'}</span></div>
      <div class="search-input">${icon('magnifying-glass', 18)}<input id="personal-search" aria-label="搜索已保存个人记忆" placeholder="搜索已保存的标题或内容" value="${esc(p.query)}"></div>
      <div class="memory-kind-grid" aria-label="已保存个人记忆分类">${['全部', ...PERSONAL_KINDS].map(kind => `<button class="chip ${p.kind === kind ? 'selected' : ''}" aria-pressed="${p.kind === kind}" data-act="personal-kind" data-value="${kind}">${kind}${p.items ? ` <span>${kind === '全部' ? p.items.length : p.items.filter(x => x.kind === kind).length}</span>` : ''}</button>`).join('')}</div>
      ${personalMutationHtml()}${requestNotice({loading:!!p.listRequest,error:p.error}, 'personal-reload', !!p.items)}
      ${p.items == null ? p.error ? '' : spinnerHtml('正在读取已保存个人记忆…', '本机私人档案') : `<div class="memory-list-heading"><h3>${p.kind === '全部' ? '全部已保存内容' : p.kind}</h3><button class="text-action" data-act="personal-reload" ${p.listRequest || personalBusy() ? 'disabled' : ''}>重新读取</button></div>${items.map(item => `<button class="card clickable memory-personal-card" data-act="personal-open" data-id="${esc(item.id)}"><div class="ms-card-heading"><span class="badge purple">${esc(item.kind)}</span>${icon(PERSONAL_ICONS[item.kind] || 'bookmark-simple', 18)}</div><h3>${esc(item.title)}</h3><p class="memory-body-preview">${esc(item.body)}</p><p class="meta">${item.updatedAt ? `${esc(personalDate(item.updatedAt))} 更新` : '更新时间未记录'} · ${esc(personalSourceLabel(item))}</p></button>`).join('') || `<section class="memory-handwritten-empty"><strong>${query ? '没有匹配的已保存记忆' : p.kind === '全部' ? '尚无已确认保存的个人记忆' : `尚无已保存的${p.kind}记忆`}</strong><p class="meta">${query ? '换个关键词或分类试试。' : '上方自动候选仍待本人核对；也可手动补充。'}</p></section>`}`}
      <details class="personal-auto-auxiliary"><summary>普通日常重点与已保存片段</summary>${personalDailyOverviewHtml()}</details>
      ${listRow({act:'self-pick',ic:'user-circle',title:'本机选择的称呼',sub:S.state.selfName ? `${S.state.selfName} · 仅为本机选择，未经身份核验` : '尚未选择 · 不作为已确认身份记忆'})}
      ${listRow({act:'memory-people',ic:'users',title:'人物与声音身份',sub:'查看成员与声纹目录，声音许可单独管理'})}
      <p class="meta">云同步与助手长期上下文尚未接入。会议纪要保留在「会议／项目」，不自动写成关于你的记忆。</p>`;
  }
  function openPersonalEdit(id) {
    const p = S.personal;
    if (personalBusy() || p.items === null || p.error) return toast('请先读取并核对本机内容', true);
    const current = id ? p.items.find(item => item.id === id) : null;
    if (id && !current) return toast('这条本机记忆已不在当前列表，请重新读取', true);
    let draft;
    if (current) {
      draft = p.drafts.get(id) || { ...current, create: false };
      draft.create = false; // A successful read established this ID already exists; editing is explicit.
      p.drafts.set(id, draft);
    } else {
      draft = [...p.drafts.values()].find(item => item.create);
      if (!draft) { draft = {id:personalId(),title:'',body:'',kind:p.kind === '全部' ? '日常' : p.kind,create:true}; p.drafts.set(draft.id,draft); }
    }
    p.editKey = draft.id; openSheet({kind:'personalEdit'});
  }
  function capturePersonalDraft() {
    if (S.sheet?.kind !== 'personalEdit' || personalBusy()) return;
    const draft = S.personal.drafts.get(S.personal.editKey);
    if (!draft) return;
    draft.title = $('personal-title')?.value ?? draft.title; draft.body = $('personal-body')?.value ?? draft.body; draft.kind = $('personal-kind')?.value ?? draft.kind;
  }
  function personalEditHtml() {
    const p = S.personal, draft = p.drafts.get(p.editKey);
    if (!draft) return frame('个人记忆', '<p>草稿已关闭，请返回个人记忆。</p>');
    const locked = personalBusy();
    return frame(draft.create ? '记一条关于我的事' : '修改个人记忆', `${personalMutationHtml()}${p.error ? `<p class="error-text" role="alert">${esc(p.error)}</p>` : ''}
      <label class="form-field"><span>分类</span><select id="personal-kind" ${locked ? 'disabled' : ''}>${PERSONAL_KINDS.map(kind => `<option ${draft.kind === kind ? 'selected' : ''}>${kind}</option>`).join('')}</select></label>
      <label class="form-field"><span>标题</span><input id="personal-title" maxlength="100" placeholder="用一句话标记这件事" value="${esc(draft.title)}" ${locked ? 'disabled' : ''}></label>
      <label class="form-field"><span>关于我的内容</span><textarea id="personal-body" rows="6" maxlength="5000" placeholder="写下你希望保留的身份、偏好、目标、经历或日常事情" ${locked ? 'disabled' : ''}>${esc(draft.body)}</textarea></label>
      <p class="meta">${p.mock ? '仅保存在当前浏览器内存示例，刷新清空。' : draft.source === 'daily_personal_confirmed' ? '本次修改更新本人改写，原自动整理和短依据分别保留。' : '由本人填写，仅保存到本机私人档案。'}不会自动上传或作为助手长期上下文使用。</p>
      <button class="button primary" data-act="personal-save" ${locked ? 'disabled' : ''}>保存到本机</button><button class="button quiet" data-act="close">${locked ? '稍后查看结果' : '返回，保留本次草稿'}</button>${!locked && draft.create ? '<button class="button quiet" data-act="personal-draft-discard">舍弃未保存草稿</button>' : ''}`);
  }
  function personalDetailHtml() {
    const item = (S.personal.items || []).find(x => x.id === S.sheet.id);
    if (!item) return frame('个人记忆', '<p>这条记忆已不在当前列表，请返回重新读取。</p>');
    const provenance=item.source === 'daily_personal_confirmed' ? `${item.summary ? `<section class="card"><h3>当时自动整理</h3><p>${esc(item.summary)}</p></section>` : ''}${Array.isArray(item.evidence) && item.evidence.length ? personalCandidateEvidenceHtml(item) : '<p class="meta">短依据暂未读到。</p>'}` : '';
    return frame(esc(item.title), `<span class="badge purple">${esc(item.kind)} · ${esc(personalSourceLabel(item))}</span><p class="memory-detail-body">${esc(item.body)}</p>${provenance}<p class="meta">${item.createdAt ? `创建于 ${esc(personalDate(item.createdAt))}` : '创建时间未记录'}<br>${item.updatedAt ? `更新于 ${esc(personalDate(item.updatedAt))}` : '更新时间未记录'}</p><p class="meta">${S.personal.mock ? '仅保存在当前浏览器内存示例，刷新清空。' : '保存在本机私人档案。'}尚未接云同步或助手长期上下文。</p>${personalMutationHtml()}<button class="button primary" data-act="personal-edit" data-id="${esc(item.id)}" ${personalBusy() || S.personal.error ? 'disabled' : ''}>修改内容</button><button class="button quiet danger" data-act="personal-delete-prompt" data-id="${esc(item.id)}" ${personalBusy() || S.personal.error ? 'disabled' : ''}>删除这条记忆</button>`);
  }
  function personalDeleteHtml() {
    const item = (S.personal.items || []).find(x => x.id === S.sheet.id);
    return frame('删除这条个人记忆？', `${personalMutationHtml()}${S.personal.error ? `<p class="error-text">${esc(S.personal.error)}</p>` : ''}<p>将从本机私人档案删除「${esc(item?.title || '')}」。</p><p class="meta">原会议、录音与已经单独保存的短片段不受影响。</p><button class="button danger" data-act="personal-delete-confirm" data-id="${esc(S.sheet.id)}" ${personalBusy() ? 'disabled' : ''}>确认删除</button><button class="button quiet" data-act="close">返回</button>`);
  }
  function memoryPeopleHtml() {
    const v = S.state.voiceprint || {}, people = v.catalog?.people || [];
    return frame('人物与声音身份', `<button class="card clickable ms-pending" data-act="vp-open"><span class="badge purple">声音身份</span><h3>声纹录入与匹配测试</h3><p class="meta">由本人朗读 30 秒；声音许可单独确认。</p></button>${sectionTitle('团队成员')}${people.map(person => `<section class="card"><div class="ms-person-head"><span class="avatar">${esc(initial(person.name))}</span><div><h3>${esc(person.name)}</h3><p class="meta">${person.registered ? `已录入声纹 · ${esc(SOURCE_TEXT[person.source] || person.source || '')} · ${person.seconds} 秒` : '还没有录入声纹'}</p></div></div></section>`).join('') || `<p class="meta">${v.phase === 'loading' ? '正在读取…' : '还没有读到成员名单，可重新读取。'}</p>`}<button class="button secondary" data-act="vp-refresh">重新读取声音目录</button>`);
  }

  function projectHtml() {
    const p = S.projects.open;
    if (!p) return requestNotice(S.requests.project, 'project-retry', false) || spinnerHtml('正在读取项目…', S.route.name_ || '');
    const sec = S.projects.section, demo = !!window.OopsDemoTransport;
    const meetingTasks = (p.meeting_items || []).filter(x => !x.linked_created && candidateCurrent(x));
    const seg = `<div class="segmented" role="tablist">${[['decisions', `${demo ? '讨论要点' : '决定'} ${p.decisions.length}`], ['tasks', `任务 ${p.tasks.length + meetingTasks.length}`], ['meetings', `会议 ${p.meetings.length}`]]
      .map(([k, label]) => `<button role="tab" aria-selected="${k === sec}" data-act="project-section" data-value="${k}">${label}</button>`).join('')}</div>`;
    const body = sec === 'decisions'
      ? `${demo ? '<p class="meta">讨论要点候选（示例）仅来自改编内容，不代表原会议已确认决定。</p>' : p.source_filtered ? '<p class="warn-text">已撤回删除会议的旧依据；请重新读取项目以更新统计。</p>' : p.unreviewed_decisions ? `<p class="meta">另有 ${p.unreviewed_decisions} 条决定还没会后核对。核对确认后会出现在这里，并用于开会时的冲突提醒。</p>` : ''}
        ${p.decisions.map((d) => `<button class="card clickable" data-act="meeting-open" data-id="${esc(d.session_id)}"><div class="ms-card-heading"><span class="badge ${d.tag === 'constraint' ? 'gray' : 'green'}">${demo ? d.tag === 'constraint' ? '条件／限制（示例）' : '讨论要点（示例）' : d.tag === 'constraint' ? '约束' : '决定'}</span></div>
          <h3>${esc(d.text)}</h3><p class="meta">${esc(formatDate(d.started_at))} ·《${esc(d.meeting_title || '会议')}》${d.speaker ? ` · ${esc(manualLabel(d.speaker))}` : ''}</p>
          ${!demo && d.source === 'meeting_review' ? `<p class="meta">来自会后事项人工确认${d.review?.by ? ` · ${esc(d.review.by)}` : ''}${d.source_status === 'retained' ? ' · 独立保留短依据' : ''}</p>${d.evidence?.length ? `<p class="parsed-decision-quote">“${esc(d.evidence[0].text)}”</p>` : ''}` : ''}</button>`).join('')
          || `<div class="empty-state">${emptyArt('sleepy', 'check-circle')}<strong>${demo ? '暂无讨论要点示例' : '还没有确认过的决定'}</strong><p>${demo ? '可回到改编讨论查看内容。' : '在会后核对里点「是决定」。'}</p></div>`}`
      : sec === 'tasks' ? `${meetingTasks.length ? `<h3 class="parsed-source-heading">${demo ? '待办候选（示例）' : '会后已确认待办'} · ${meetingTasks.length}</h3>${meetingTasks.map(parsedCard).join('')}` : ''}
        ${p.tasks.length ? `<h3 class="parsed-source-heading">${demo ? '演示任务' : '飞书正式任务'} · ${p.tasks.length}</h3>${p.tasks.map(taskCard).join('')}` : ''}
        ${!meetingTasks.length && !p.tasks.length ? `<div class="empty-state"><strong>${demo ? '此项目暂无演示任务' : '这个项目还没有当前有效的确认待办或飞书正式任务'}</strong></div>` : ''}`
      : p.meetings.map(sessionCard).join('');
    return `<div class="stack memory-settings"><div class="section-title"><div><h1 class="title">${esc(p.name)}</h1><p class="meta">${p.meetings.length} 场会议 · ${demo ? '讨论要点候选（示例）' : '已确认决定'} ${p.decisions.length}</p></div></div>${requestNotice(S.requests.project, 'project-retry', true)}${seg}${body}</div>`;
  }

  // ---- 设置（保留旧 me 路由） ----------------------------------------------------------------

  function meHtml() {
    const s = S.state;
    const group = (title, rows) => `<div>${sectionTitle(title)}<section class="card">${rows.join('')}</section></div>`;
    return `<div class="stack">
      <section class="card ms-profile"><div class="ms-person-head"><span class="avatar">${esc(s.selfName ? initial(s.selfName) : '?')}</span>
        <div><h2>${esc(s.selfName || '还没选择本人')}</h2><p class="meta">${usesPersonalTaskIdentity() ? '本机显示名 · 我的任务以个人飞书账号为准' : s.selfName ? '当前任务身份 · 不授予声音或共享权限' : '选择任务身份，分别管理声音与共享许可'}</p></div></div>
        <button class="ms-space" data-act="self-pick">${esc(s.selfName ? '切换本人' : '选择本人')}${icon('caret-down', 13)}</button></section>
      ${group('账户与身份', [
        listRow({ act: 'self-pick', ic: 'user-circle', title: '当前身份', sub: s.selfName || '未选择' }),
        listRow({ act: 'vp-open', ic: 'waveform', title: '声音身份与许可', sub: '单独同意录入，姓名核对不代表声纹授权' })])}
      ${group('聆听与设备', [
        listRow({ act: 'go', data: 'data-route="device"', ic: 'bluetooth', title: '设备与开机自动聆听', sub: '首配独立选择 · 暂停与停止优先 · 设备示例' }),
        listRow({ act: 'go', data: 'data-route="settings"', ic: 'microphone', title: '收音、唤醒与提醒偏好', sub: `${SOURCE_TEXT[s.source] || s.source || '未设置音源'} · ${s.voiceTrigger !== false ? '语音唤醒开' : '语音唤醒关'}` })])}
      ${group('连接与数据', [
        listRow({act:'go',data:'data-route="raft"',ic:'chat-circle',title:'Oops 协作群',sub:'群成员、任务派工、回复与结果'}),
        listRow({ act: 'feishu-open', ic: 'plugs-connected', title: '我的飞书', sub: S.feishu.status === 'connected' ? S.feishu.account?.name || '已绑定我的账号' : '每人授权自己的账号 · 纪要确认后才发送' }),
        listRow({ act: 'go', data: 'data-route="settings"', ic: 'plugs-connected', title: '服务连接', sub: s.backend === 'mock' ? 'Mock 后端（不连服务器）' : s.backendUrl || '未配置' }),
        listRow({ act: 'privacy-open', ic: 'shield-check', title: '隐私、保存与共享', sub: '日常临时5分钟；正式会议每次单独确认' })])}
      ${group('运行信息', [
        listRow({ act: 'go', data: 'data-route="settings"', ic: 'chart-bar', title: '诊断与召回耗时', sub: S.latency?.recentMs?.length ? `召回中位数 ${(S.latency.medianMs / 1000).toFixed(1)} 秒` : '还没有召回记录' })])}
      <p class="meta ms-center">会议、项目与个人内容在「记忆」中查看</p>
    </div>`;
  }

  const DEVICE_CONDITIONS = {
    ready: ['服务就绪', '权限、连接与后台条件就绪。恢复仍需要你明确操作。', 'plugs-connected'],
    permission: ['权限缺失', '示例缺少收音权限。补齐权限后仍需点恢复。', 'shield-check'],
    background: ['后台受限', '示例后台服务不可运行。解除限制后仍需点恢复。', 'moon'],
    disconnected: ['设备断连', '示例设备未连接。重新连接不会越过你的暂停或停止。', 'bluetooth'],
    quiet: ['安静时段', '示例正在安静时段内。结束后不自动恢复被中断的聆听。', 'moon'],
    service: ['服务未就绪', '示例聆听服务尚不可用。恢复服务后仍需点恢复。', 'plugs-connected'],
  };
  const realSessionActive = () => S.state.capturing ? S.state.sessionId || 'native-pending' : null;
  function deviceStatusText() {
    if (realSessionActive()) return `现有${S.state.recordingMode === 'meeting' ? '正式会议' : '日常记录'}继续`;
    if (!deviceState?.paired) return '还未进行示例配对';
    if (deviceState.condition !== 'ready') return DEVICE_CONDITIONS[deviceState.condition][0];
    return { listening: '日常临时聆听中 · 示例', paused: '你已暂停 · 示例', stopped: '你已停止 · 示例',
      interrupted: '条件已恢复，等待你恢复', idle: deviceState.autoListen ? '等待示例设备开机' : '开机自动聆听未开启' }[deviceState.status];
  }
  function deviceHtml() {
    if (!deviceState) return '<div class="empty-state"><strong>设备示例暂不可用</strong><p>请重新打开页面；真实录音不受影响。</p></div>';
    const d = deviceState, external = realSessionActive(), info = DEVICE_CONDITIONS[d.condition];
    const active = d.status === 'listening', ready = d.paired && d.condition === 'ready' && !external;
    return `<div class="stack native-device-page">
      <div class="native-device-boundary"><span class="badge purple">独立设备示例</span><p>尚未连接真实录音豆；以下状态和选择只保留在本页体验内，不控制真实录音。</p></div>
      <section class="card native-device-hero"><span class="row-icon">${icon('bluetooth', 28)}</span><h2>Oops 录音豆</h2><p class="meta">${d.paired ? '已完成示例配对' : '首次配对时，单独选择是否开机聆听'}</p>
        <strong role="status">${esc(deviceStatusText())}</strong>
        ${external ? '<p class="meta">已有记录优先。示例不会新建重复会话、改变保存方式或控制现有会议。</p>' : ''}
        ${d.paired ? `<div class="native-device-preferences"><p>开机自动聆听：<strong>${d.autoListen ? '已选择（仅示例）' : '未开启'}</strong></p><p>安静时段：${d.quietEnabled ? `${d.quietStart}–${d.quietEnd}（仅示例）` : '未设置'}</p><button class="button secondary" data-act="device-preferences">编辑聆听偏好</button></div>` : '<button class="button primary" data-act="device-pair">开始示例配对</button>'}
      </section>
      ${d.paired ? `<section class="card"><h3>设备状态演示</h3><p class="meta">选择一种示例条件；不会读取或修改系统权限。</p><div class="native-device-conditions" role="group" aria-label="示例设备条件">${Object.entries(DEVICE_CONDITIONS).map(([key,[title,,ic]]) => `<button class="chip ${d.condition === key ? 'selected' : ''}" data-act="device-condition" data-value="${key}" aria-pressed="${d.condition === key}">${icon(ic, 16)}${title}</button>`).join('')}</div><p class="meta" role="status">${esc(info[1])}</p>
        <button class="button secondary" data-act="device-power" ${external ? 'disabled' : ''}>模拟设备开机 / 重连</button>
      </section>
      <section class="card native-device-controls"><h3>本次示例聆听</h3><p class="meta">${d.sessionId ? `示例会话 ${esc(d.sessionId)} · 临时5分钟 · 不云端归档` : '每次新的示例聆听只进入日常模式，不继承正式会议保存许可。'}</p>
        ${active && !external ? '<button class="button secondary" data-act="device-pause">暂停示例聆听</button>' : `<button class="button primary" data-act="device-resume" ${ready ? '' : 'disabled'}>${d.needsResume || d.hold ? '明确恢复示例聆听' : '手动开始示例日常聆听'}</button>`}
        <button class="button quiet" data-act="device-stop" ${external ? 'disabled' : ''}>停止示例聆听</button>
        <p class="meta">暂停、停止与安静时段优先；恢复条件、修改偏好或重连不会解除你的暂停／停止。</p>
      </section>` : ''}
      <button class="button quiet" data-act="device-reset">重新体验首次配对</button>
    </div>`;
  }
  function devicePairHtml() {
    return frame('首次配对 · 设备示例', `<p>Oops 录音豆（示例）</p><p class="meta">配对与开机聆听是两个独立选择，取消不保存。</p>
      <label class="toggle-row"><span><strong>设备开机后自动日常聆听</strong><small>仅在权限、连接与后台服务就绪且非安静时段时进入临时聆听</small></span><input id="device-pair-auto" type="checkbox"></label>
      <p class="meta">默认未开启。日常原音与临时全文最多5分钟，停止清除；不自动开始正式会议、注册声纹或共享。实时识别可能使用云端ASR。</p>
      <button class="button primary" data-act="device-pair-confirm">完成示例配对</button><button class="button quiet" data-act="close">取消</button>`);
  }
  function devicePreferencesHtml() {
    const d = deviceState;
    return frame('聆听偏好 · 设备示例', `<label class="toggle-row"><span><strong>开机后自动日常聆听</strong><small>更改只影响后续示例开机，不开始或结束当前记录</small></span><input id="device-auto" type="checkbox" ${d.autoListen ? 'checked' : ''}></label>
      <label class="toggle-row"><span><strong>安静时段</strong><small>当前页手动模拟时段内状态，不按系统时钟自动切换</small></span><input id="device-quiet" type="checkbox" ${d.quietEnabled ? 'checked' : ''}></label>
      <div class="native-device-times"><label class="form-field"><span>开始</span><input id="device-quiet-start" type="time" value="${d.quietStart}"></label><label class="form-field"><span>结束</span><input id="device-quiet-end" type="time" value="${d.quietEnd}"></label></div>
      <p class="meta">偏好仅在当前独立示例中保留，安静状态由你在设备页选择；不会写入真实设备或扩大录音、声纹、共享权限。</p><button class="button primary" data-act="device-preferences-save">保存示例偏好</button><button class="button quiet" data-act="close">取消</button>`);
  }
  function privacyHtml() {
    return frame('隐私、保存与共享', `<section class="card"><h3>日常临时聆听</h3><p>最近5分钟原音与临时全文滚动覆盖，停止清除，不归档整场或同步团队。私人候选需核对后单独保存。</p><button class="button secondary" data-act="daily-candidates">核对私人候选</button></section>
      <section class="card"><h3>正式会议</h3><p>每次明确选择云保存，原音与全文分别选择7/30/90天。已确认摘要、任务和短依据独立保留；历史按原规则处理。</p></section>
      <section class="card"><h3>声音与共享分别确认</h3><p>姓名核对不等于声音身份许可；设备配对、开机聆听也不代表团队共享。已有团队会议内容仍按原范围读取，删除与核对从具体会议进入。</p><button class="button quiet" data-act="vp-open">管理声音身份许可</button><button class="button quiet" data-act="go" data-route="sessions">查看具体会议</button></section>
      <p class="meta">即时语音识别可能使用云端ASR；不归档不代表音频完全不上云。</p>`);
  }
  function applyDeviceEvent(event) {
    if (!deviceState) return;
    deviceState = deviceDemo.reduce(deviceState, event, { activeSessionId: realSessionActive() || null });
    render();
  }

  function settingsHtml() {
    const s = S.state;
    const l = S.latency;
    const latency = l && l.recentMs && l.recentMs.length
      ? `中位数 ${(l.medianMs / 1000).toFixed(2)} 秒 · 最近 ${l.recentMs.map((ms) => (ms / 1000).toFixed(1)).join(' / ')} 秒` : '还没有召回记录';
    const toggle = (id, title, sub, on) => `<label class="toggle-row"><span><strong>${title}</strong>${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}></label>`;
    return `<div class="stack">
      <section class="card"><h3>收音</h3>
        <label class="form-field"><span>音源（保存后立即切换，保留本场记录）</span><select id="set-source">
          <option value="mic" ${s.source === 'mic' ? 'selected' : ''}>手机麦克风</option>
          <option value="wav" ${s.source === 'wav' ? 'selected' : ''}>测试 WAV（预录音频）</option>
          <option value="remote" ${s.source === 'remote' ? 'selected' : ''}>Mac 收音（经 USB 接收电脑上的麦克风）</option>
          ${s.beanSdk ? `<option value="bean" ${s.source === 'bean' ? 'selected' : ''}>录音豆（App 开始后自动尝试开录）</option>` : ''}
          <option value="bean_sim" ${s.source === 'bean_sim' ? 'selected' : ''}>录音豆模拟（内置对话，测试解码链路）</option></select></label>
        ${s.beanSdk ? `<p class="${s.beanAuthorized ? 'meta' : 'warn-text'}">${s.beanAuthorized ? `录音豆授权有效至 ${formatDate(new Date(s.beanLicenseExpiresAt * 1000).toISOString())}` : '录音豆需要更新设备授权'}。当前使用原生 SDK 连接；开始后自动尝试启动设备，失败会显示原因。</p>` : ''}
        <label class="form-field"><span>Mac 收音地址</span><input id="set-remote" inputmode="url" placeholder="127.0.0.1:7790" value="${esc(s.remoteAddress || '127.0.0.1:7790')}"><small>配合 adb reverse 用 127.0.0.1</small></label>
        <p class="meta">测试音频：${esc(s.testWavName || '内置合成对话')} · 需要 PCM 16kHz / 单声道 / 16bit WAV</p>
        <div class="inline-actions"><button class="chip" data-act="pick-audio">选择测试 WAV</button><button class="chip" data-act="reset-audio">恢复内置音频</button></div>
        ${toggle('set-voice', '说「Oops」触发找回/提问', '', s.voiceTrigger !== false)}
        ${toggle('set-vibrate', '提醒短震动', '', s.noticeVibrate !== false)}</section>
      <section class="card"><h3>保存方式</h3><p>日常原音与临时全文只滚动保留5分钟，停止清除。明确选择正式会议后才云端归档；原音与全文分别选7/30/90天。</p><p class="meta">实时识别可能使用云端ASR，不归档不代表音频完全不上云。历史记录不追溯删除。</p><button class="button secondary" type="button" data-act="daily-candidates">查看私人待核对候选</button><p class="meta">${s.recordingsPending || 0} 场会议资产待上传到当前来源服务</p>${s.recordingArchiveMessage ? `<p class="warn-text" role="status">${esc(s.recordingArchiveMessage)}${s.recordingsBlocked ? `（${s.recordingsBlocked} 场）` : ''}</p><button class="button quiet" type="button" data-act="archive-retry" ${s.capturing || s.asr === 'finishing' ? 'disabled' : ''}>重试当前服务的恢复 / 上传</button>` : ''}<input type="checkbox" id="set-sync" hidden ${s.memorySync !== false ? 'checked' : ''}><input type="checkbox" id="set-record" hidden ${s.recordSession ? 'checked' : ''}></section>
      <section class="card"><h3>团队服务器</h3>
        ${toggle('set-mock', '使用 Mock 后端', '只在本机模拟，不连服务器', s.backend === 'mock')}
        <label class="form-field"><span>后端地址</span><input id="set-url" inputmode="url" placeholder="https://…" value="${esc(s.backendUrl || '')}"></label>
        <label class="form-field"><span>服务访问凭据</span><input id="set-token" type="password" autocomplete="off" placeholder="${s.hasBackendToken ? '已配置；留空保留原凭据' : '远程服务提供的访问凭据'}"></label>
        ${toggle('set-clear-token', '清除当前地址的访问凭据', '', false)}</section>
      <section class="card"><h3>试验功能</h3>
        ${toggle('set-spk', '说话人区分', '实验：测试中会丢句', s.speakerInfo)}
        ${toggle('set-preview', '实时换人拆分与重叠提示', '试验', s.speakerPreviewEnabled)}</section>
      <p id="settings-save-state" class="${S.settingsSave?.error ? 'error-text' : 'meta'}" role="status">${esc(S.settingsSave?.error || (S.settingsSave?.status === 'saving' ? '正在保存设置…' : S.settingsSave?.status === 'saved' ? '设置已保存' : ''))}</p>
      <button class="button primary" type="button" data-act="apply-settings" ${S.settingsSave?.status === 'saving' ? 'disabled' : ''}><span>保存设置</span></button>
      <section class="card"><h3>召回耗时</h3><p class="meta">${esc(latency)}（验收：中位数 ≤ 5 秒）</p>
        <h3>诊断</h3><pre class="diag" id="diag">${esc(diagText())}</pre></section>
    </div>`;
  }

  function diagText() {
    const s = S.state;
    return [
      `session  ${clock(s.sessionMs)}   buffer ${clock(s.bufferedMs)}`,
      `source   ${s.source}${s.sourceDetail ? ` — ${s.sourceDetail}` : ''}`,
      `asr      ${s.asr}${s.asrDetail ? ` — ${s.asrDetail}` : ''}`,
      `backend  ${s.backend}${s.backend === 'http' ? ` ${s.backendUrl}` : ''}`,
      `gaps     ${(s.asrGaps || []).length}`,
      ...(s.recordingArchiveMessage ? [`archive  ${s.recordingArchiveMessage}`] : []),
    ].join('\n');
  }

  function applySettings() {
    if (S.settingsSave?.status === 'saving') return;
    const settings = {
      requestId: `settings-${++S.historySerial}`,
      voiceTrigger: $('set-voice').checked, noticeVibrate: $('set-vibrate').checked, memorySync: $('set-sync').checked,
      source: $('set-source').value,
      remoteAddress: $('set-remote').value.trim(),
      mockBackend: $('set-mock').checked,
      backendBaseUrl: $('set-url').value.trim(),
      speakerInfo: $('set-spk').checked,
      speakerPreview: $('set-preview').checked,
      recordSession: $('set-record').checked,
    };
    if ($('set-clear-token').checked) settings.backendToken = '';
    else if ($('set-token').value.trim()) settings.backendToken = $('set-token').value.trim();
    S.settingsSave = { requestId: settings.requestId, status: 'saving' }; updateSettingsSaveStatus();
    send('settings.set', settings);
  }
  function updateSettingsSaveStatus() {
    const status = $('settings-save-state'), button = document.querySelector('[data-act="apply-settings"]');
    if (status) { status.textContent = S.settingsSave?.error || (S.settingsSave?.status === 'saving' ? '正在保存设置…' : S.settingsSave?.status === 'saved' ? '设置已保存' : ''); status.className = S.settingsSave?.error ? 'error-text' : 'meta'; }
    if (button) button.disabled = S.settingsSave?.status === 'saving';
  }

  // ---- sheets -----------------------------------------------------------------------------

  function openSheet(sheet) {
    if (S.sheet?.kind === 'personalEdit') capturePersonalDraft();
    if (S.sheet?.kind === 'personalAutoReview') capturePersonalCandidateDraft();
    if (S.sheet?.kind === 'voiceprint' && sheet.kind !== 'voiceprint') {
      if (['saving', 'testing'].includes(S.state.voiceprint?.phase)) return toast('请等待当前请求结束');
      send('voiceprint.cancel');
    }
    if (S.sheet?.kind === 'itemTaskPending' && sheet.kind !== 'itemTaskPending') S.itemTaskRequest = null;
    S.sheet = sheet;
    renderSheet();
    $('sheet').hidden = false;
    $('backdrop').hidden = false;
  }

  function closeSheet(preserveMeetingRead = false) {
    if (S.sheet?.kind === 'personalEdit') capturePersonalDraft();
    if (S.sheet?.kind === 'personalAutoReview') capturePersonalCandidateDraft();
    if (S.sheet?.kind === 'taskReview') captureTaskReviewDraft();
    if (S.sheet?.kind === 'voiceprint') {
      if (['saving', 'testing'].includes(S.state.voiceprint?.phase)) return toast('请等待当前请求结束');
      send('voiceprint.cancel');
    }
    if (S.playingKey) send('clip.stop');
    if (S.sheet?.kind === 'itemTaskPending') S.itemTaskRequest = null;
    if (preserveMeetingRead !== true && ['pending', 'requestError'].includes(S.sheet?.kind) && S.pendingMeetingId) {
      clearTimeout(S.meetingRequest?.timer);
      if (S.meetingRequest) S.meetingRequest.active = false;
      S.pendingMeetingId = null; S.pendingReview = null; S.pendingTools = null;
    }
    S.sheet = null;
    $('sheet').hidden = true;
    $('backdrop').hidden = true;
  }

  const frame = (title, body, desc = '') => `<div class="sheet-handle-zone" data-act="close"><div class="sheet-handle"></div></div>
    <div class="sheet-header"><h2 class="sheet-title">${title}</h2>${desc ? `<p class="sheet-description">${desc}</p>` : ''}</div>
    <div class="sheet-content"><div class="sheet-content">${body}</div></div>`;
  const spinnerHtml = (title, sub) => `<div class="empty-state oops-loading" role="status">${window.OopsPupu ? emptyArt('thinking') : '<div class="oops-spinner"></div>'}<strong>${esc(title)}</strong><p>${esc(sub)}</p></div>`;
  function requestNotice(request, act, hasData) {
    if (request?.error) return `<section class="card service-error" role="status"><h3>${hasData ? '刷新未成功' : '暂时无法读取'}</h3><p>${esc(request.error)}</p>${hasData ? '<p class="meta">下方保留上次读取的内容，可能不是最新。</p>' : ''}<button class="button secondary" type="button" data-act="${act}"><span>重新读取</span></button></section>`;
    return request?.loading && hasData ? '<p class="meta" role="status">正在刷新，先显示上次读取的内容…</p>' : '';
  }

  function renderSheet() {
    const k = S.sheet?.kind;
    const fresh = $('sheet').dataset.kind !== (k || '');
    $('sheet').dataset.kind = k || '';
    const html = {
      pending: () => frame(esc(S.sheet.title || '请稍等'), spinnerHtml(S.sheet.title || '请稍等', S.sheet.sub || '')),
      itemTaskPending: itemTaskPendingHtml,
      draftPending: () => frame('整理行动草稿', spinnerHtml('正在整理行动草稿…', '提取负责人、事项、截止时间和约束')),
      notFound: notFoundHtml,
      card: cardHtml,
      draft: draftHtml,
      result: resultHtml,
      voiceprint: voiceprintHtml,
      personalEdit: personalEditHtml,
      personalDetail: personalDetailHtml,
      personalDelete: personalDeleteHtml,
      personalAutoReview: personalCandidateReviewHtml,
      personalAutoDiscard: personalCandidateDiscardHtml,
      memoryPeople: memoryPeopleHtml,
      saved: savedHtml,
      commitments: commitmentsHtml,
      ask: askHtml,
      agenda: agendaHtml,
      notices: () => frame('会议提醒', noticeRecordsHtml(S.sheet.rows || [...S.notices.values()], !!S.sheet.rows)),
      speaker: speakerPickHtml,
      review: reviewHtml,
      items: itemReviewHtml,
      taskReview: taskReviewHtml,
      minutesSource: minutesSourceHtml,
      feishu: feishuHtml,
      minutesDelivery: minutesDeliveryHtml,
      requestError: () => frame('暂时无法读取', `<p class="error-text">${esc(S.sheet.error)}</p><button class="button primary" type="button" data-act="meeting-retry"><span>重新打开会议</span></button>`),
      projectPick: projectPickHtml,
      rename: renameHtml,
      tools: toolsHtml,
      retain: retentionHtml,
      devicePair: devicePairHtml,
      devicePreferences: devicePreferencesHtml,
      privacy: privacyHtml,
      captureMode: captureModeHtml,
      dailyResults: dailyResultsHtml,
      stopConfirm: () => frame(S.state.recordingMode === 'meeting' ? '结束这次记录？' : '结束日常聆听？', `<p>${S.state.recordingMode === 'meeting' ? '已收到的原话和标记会保留，结束后可以在会后核对里整理。' : '结束后直接查看本次留下的重点。已整理的私人候选和你单独确认保存的片段会保留；最近 5 分钟的临时原音和全文会清除，不生成整场会议档案。'}</p>
        <button class="button primary" type="button" data-act="capture-stop-confirm"><span>结束记录</span></button><button class="button quiet" type="button" data-act="close"><span>继续记录</span></button>`),
      dailyCandidates: () => frame('私人待核对候选', S.dailyCandidates.length ? S.dailyCandidates.map(x => `<section class="card"><span class="badge">私有 · 未确认</span><p>${esc(dailyCandidateText(x))}</p>${x.summary ? dailyEvidenceHtml(x) : '<p class="meta">原话摘录 · 未作摘要</p>'}<p class="meta">${formatDate(x.updated_at)} · 完整原音/全文已不保留</p><button class="button secondary" data-act="daily-confirm-open" data-id="${esc(x.id)}" data-session="${esc(x.session_id)}">核对这条内容</button><button class="button quiet" data-act="daily-discard" data-id="${esc(x.id)}" data-session="${esc(x.session_id)}">舍弃候选</button></section>`).join('') : '<p>还没有私人候选；不会保存整场全文来填充这里。</p>'),
      dailyConfirm: () => frame('核对并保存私人记忆', `${S.dailyRequest?.mutation ? '<p class="meta" role="status">正在保存，等待本机回执…</p>' : ''}${S.dailyRequest?.error ? `<p class="error-text">${esc(S.dailyRequest.error)}</p>` : ''}${dailyEvidenceHtml(S.sheet.item)}<label class="form-field"><span>要留下的内容，可编辑</span><textarea id="daily-quote" maxlength="560">${esc(S.sheet.quoteDraft ?? dailyCandidateText(S.sheet.item))}</textarea></label><label class="toggle-row"><span>我已核对原话依据及要留下的内容，单独保存为私人记忆</span><input id="daily-confirmed" type="checkbox"></label><p class="meta">编辑内容与原话短依据分别保留。不自动创建任务、关联身份或共享；完整原音和全文不会恢复。</p><button class="button primary" data-act="daily-confirm-save" ${S.dailyRequest?.mutation ? 'disabled' : ''}>保存私人记忆</button><button class="button quiet" data-act="daily-confirm-back">返回重点</button>`),
      selfPick: selfPickHtml,
    }[k];
    // Re-rendering the same sheet (a play state, a late result) keeps its scroll; a different sheet starts at the top.
    const scroller = $('sheet').querySelector ? $('sheet').querySelector('.sheet-content') : null;
    const keep = !fresh && scroller ? scroller.scrollTop : 0;
    $('sheet').innerHTML = html ? html() : '';
    const next = $('sheet').querySelector ? $('sheet').querySelector('.sheet-content') : null;
    if (next) next.scrollTop = keep;
    syncPlayButtons();
    slideSegments();
  }

  function retentionHtml() {
    const sheet=S.sheet,rows=S.history?.utterances || [],pending=S.pendingRetention;
    const loading=pending?.status==='saving';
    if(pending?.status==='stale') return frame('来源需要重新核对', `<p>${esc(pending.error)}</p><button class="button primary" data-act="retain-reopen">重新读取会议</button><button class="button quiet" data-act="close">返回</button>`);
    return frame('单独保留确认结果', `<p class="meta">全文到期会清理；只保留本次手选的短原话与本人填写的摘要，不自动保留AI总结。</p>
      ${rows.map(u=>`<button class="card clickable" data-act="retain-pick" data-id="${esc(u.id)}" aria-pressed="${sheet.selected.includes(u.id)}" ${loading?'disabled':''}><span class="badge ${sheet.selected.includes(u.id)?'purple':'gray'}">${sheet.selected.includes(u.id)?'已选择':'选择短依据'}</span><p>${esc(u.text.slice(0,280))}</p><p class="meta">${hms(u.start_ms)} · 最多保留280字${u.text.length>280?'，已截取可见部分':''}</p></button>`).join('')}
      <label class="form-field"><span>本人核对的摘要（可不填）</span><textarea id="retain-summary" maxlength="2000" ${loading?'disabled':''}>${esc(sheet.summary || '')}</textarea></label>
      <label class="toggle-row"><span>我已核对所选短依据和摘要，同意独立保留</span><input id="retain-confirmed" type="checkbox" ${loading?'disabled':''}></label>
      ${pending?.error?`<p class="warn-text">${esc(pending.error)}</p><button class="button secondary" data-act="retain-retry">重试保存相同内容</button>`:''}
      <button class="button primary" data-act="retain-save" ${loading?'disabled':''}>${loading?'正在等待保存回执…':'确认并单独保留'}</button><button class="button quiet" data-act="close">取消 / 返回</button>`);
  }

  function captureModeHtml() {
    const switching = S.sheet.switching, bean = S.state.source === 'bean', meeting = switching || bean || S.sheet.mode === 'meeting';
    const days = (id,title) => `<label class="form-field"><span>${title}</span><select id="${id}">${[7,30,90].map(n=>`<option value="${n}" ${n===30?'selected':''}>${n}天</option>`).join('')}</select></label>`;
    return frame(switching ? '从现在开始正式会议' : '选择记录方式', `<div class="action-grid">${switching?'':`<button class="chip" data-act="capture-mode" data-mode="daily" aria-pressed="${!meeting}" ${bean?'disabled':''}>日常临时聆听</button><button class="chip" data-act="capture-mode" data-mode="meeting" aria-pressed="${meeting}">正式会议</button>`}</div>
      ${bean ? '<p><strong>确认开始后，Oops 会连接录音豆并尝试启动录音。</strong>设备需先开机，并断开其他应用的连接；未确认启动或未收到音频会明确提示失败。录音中可在 Oops 暂停和继续；暂停保留蓝牙与本场记录，结束会关闭连接。</p><p>当前音源为录音豆，使用正式会议模式；请确认本次云端保存。日常五分钟临时聆听请在设置中选择手机麦克风。</p>' : ''}
      ${meeting ? `${days('capture-audio-days','原始录音保留')}${days('capture-transcript-days','完整文字保留')}<label class="toggle-row"><span>我选择将本次正式会议原音和完整文字保存到云端</span><input id="capture-cloud" type="checkbox"></label><p class="meta">到期分别清理本机与服务端副本；摘要、任务和另行确认的短依据单独保留。</p>${switching?'<p>从切换时刻重新开始；此前缓冲不会自动归档。需要留下刚才片段时，请先选择并单独保存。</p><button class="button quiet" data-act="capture-before-recall">先选择刚才的片段</button>':''}` : '<p>最近5分钟原音和临时全文滚动覆盖，停止即清除；不归档整场，不同步团队。可整理私有候选，确认后才成为长期记忆。</p>'}
      <p class="meta">实时识别可能由云端ASR处理；不归档不代表音频完全不上云。</p><button class="button primary" data-act="capture-confirm">${switching?'确认并从现在开始':'开始本次记录'}</button><button class="button quiet" data-act="close">取消</button>`);
  }

  function notFoundHtml() {
    return frame('没找到', `<div class="empty-state">${emptyArt('oops', 'magnifying-glass')}<strong>没找到</strong><p>${esc(S.sheet.reason)}</p></div>
      <div class="action-grid"><button class="button secondary" type="button" data-act="close"><span>知道了</span></button>
        <button class="button primary" type="button" data-act="retry-recall"><span>再试一次</span></button></div>`);
  }

  // ---- 本场纪要 ------------------------------------------------------------------------------

  function commitmentsHtml() {
    const summary = S.summary;
    function group(title, rows, todo = false, ideas = false) {
      const shown = ideas ? rows.slice(0, S.showAllIdeas ? rows.length : 5) : rows;
      return `${sectionTitle(`${title} <span class="meta">${rows.length}</span>`)}${shown.map((u) => {
        const reviewed = u.review?.verdict === 'confirmed';
        const hint = todo ? `${u.review?.owner || u.ownerHint || u.owner_hint || '负责人待定'}${!reviewed && (u.suggestedOwner || u.suggested_owner) ? ' · 建议 ' + (u.suggestedOwner || u.suggested_owner) : ''} · ${reviewed || u.reviewStatus === 'confirmed' ? '人工已确认' : u.ownerReviewStatus === 'selected' ? '人工已选择，待确认任务' : '待核对'} · ${u.whenRaw || u.when_raw || '截止待定'}${u.taskStatus === 'created' ? ' · 已建飞书任务' : ''}` : '';
        return `<button class="list-row" data-act="commitment-open" data-id="${esc(u.id)}"><span class="row-copy"><strong>${esc(u.text)}</strong>
          <small>${hms(u.startMs)}${u.speaker ? ' · ' + esc(speakerLabel(u.speaker)) : ''}${u.audioExpired ? ' · 原声未保留' : ''}${hint ? `<br>${esc(hint)}` : ''}</small></span>${icon('caret-right', 18)}</button>`;
      }).join('') || '<p class="meta">暂无</p>'}${ideas && rows.length > 5 && !S.showAllIdeas ? '<button class="button quiet" type="button" data-act="ideas-all"><span>展开全部想法</span></button>' : ''}`;
    }
    return frame('本场纪要', `${S.state.tagsSupported === false ? '<p class="meta">当前后端不支持标签分析。</p>' : ''}
      ${S.state.sessionTruncated ? '<p class="meta">文字索引已达上限，较早条目已移出。</p>' : ''}
      ${group('决定', summary.decisions || [])}${group('待办', summary.commitments || [], true)}${group('约束', summary.constraints || [])}${group('想法', summary.ideas || [], false, true)}
      ${!S.state.capturing && S.state.sessionId ? `<button class="button primary" type="button" data-act="review-start" data-id="${esc(S.state.sessionId)}"><span>会后核对（待办、决定、说话人）</span></button>` : ''}
      <p class="meta">本场索引保留到下次收音。开启文字同步后可在会话里查看；原声最多暂存 50 段。</p>`, '点一条可以回听原话，或整理成飞书任务。');
  }

  // ---- recall card --------------------------------------------------------------------------

  function openCard(card) {
    if (S.deletedSessions.has(card.sessionId || card.sourceSessionId) || card.items?.some(x => S.deletedSessions.has(x.sessionId))) return;
    S.card = { data: card, sel: 0, before: 0, after: 0 };
    openSheet({ kind: 'card' });
    highlight(card.items.map((i) => i.id));
  }

  /** Selected candidate widened by `before` / `after` neighbouring sentences. */
  function selected() {
    const { data, sel, before, after } = S.card;
    const pool = data.pool;
    const idx = Math.max(0, pool.findIndex((u) => u.id === data.items[sel].id));
    return pool.slice(Math.max(0, idx - before), Math.min(pool.length, idx + after + 1));
  }
  function selectedRange() {
    const sel = selected();
    return { startMs: sel[0].startMs, endMs: sel[sel.length - 1].endMs };
  }
  const cardClipKey = () => `${S.card.data.id}:${S.card.sel}:${S.card.before}:${S.card.after}`;

  function cardHtml() {
    const c = S.card;
    const d = c.data;
    const item = d.items[c.sel];
    const idx = d.pool.findIndex((u) => u.id === item.id);
    const canPrev = !d.readOnly && idx - c.before > 0;
    const canNext = !d.readOnly && idx + c.after < d.pool.length - 1;
    const quote = selected().map((u) => (u.id === item.id ? esc(u.text) : `<span class="ctx">${esc(u.text)}</span>`)).join(' ');
    const range = selectedRange();
    const speaker = speakerLabel(item.speaker);
    const title = d.query ? `问答 · 「${esc(d.query)}」` : d.trigger === 'digest' ? '本场原话' : d.trigger === 'conflict' ? '冲突原话' : d.readOnly ? '往期原话' : '找回刚才的原话';
    const when = item.startedAt ? `${esc(formatDate(item.startedAt))} 会议` : `<span id="card-ago">${ago(S.state.sessionMs - item.endMs)}</span>`;
    const candidates = d.single ? '' : `<p class="meta">${d.trigger === 'conflict' ? '对照这两句原话：' : `有 ${d.items.length} 条接近，选一条：`}</p>
      ${d.items.map((it, i) => `<button class="card clickable recall-cand ${i === c.sel ? 'selected' : ''}" data-act="cand" data-i="${i}">
        <p class="recall-cand-text">${esc(it.text)}</p>
        <p class="meta">${it.startedAt ? esc(formatDate(it.startedAt)) + ' 会议 · ' : ''}${clock(it.startMs)}${it.speaker != null ? ` · ${esc(speakerLabel(it.speaker))}` : ''}</p>
        ${it.prob == null ? '<p class="meta">原话候选</p>' : `<span class="prob"><i style="width:${Math.round(it.prob * 100)}%"></i></span>`}</button>`).join('')}`;
    return frame(title, `${candidates}
      <section class="card recall-quote-card"><p class="recall-quote">“${quote}”</p>
        <p class="meta">${speaker ? `${esc(speaker)} · ` : ''}${clock(range.startMs)}–${clock(range.endMs)} · 语音转写</p></section>
      <div class="inline-actions">
        <button class="chip selected" data-act="play" data-key="${esc(cardClipKey())}" ${item.audioAvailable === false || d.readOnly ? 'disabled' : ''}>${item.audioAvailable === false || d.readOnly ? '原声未保留' : '▶ 回听原声'}</button>
        <button class="chip" data-act="prev" ${canPrev ? '' : 'disabled'}>＋前一句</button>
        <button class="chip" data-act="next" ${canNext ? '' : 'disabled'}>＋后一句</button>
        ${c.before || c.after ? '<button class="chip" data-act="reset">还原</button>' : ''}</div>
      ${d.readOnly ? '' : `<div class="action-grid"><button class="button secondary" type="button" data-act="save"><span>保存</span></button>
        <button class="button primary" type="button" data-act="draft"><span>生成行动</span></button></div>
        <button class="button quiet" type="button" data-act="dismiss"><span>丢弃</span></button>`}
      <p class="meta">${d.readOnly ? '往期文字 · 只读' : '本场原话 · 可保存或起草行动'} · 召回 ${(d.latencyMs / 1000).toFixed(1)} 秒 · ${esc(d.engine)}</p>`, when);
  }

  // ---- clips --------------------------------------------------------------------------------

  function toggleClip(key, range, sessionId) {
    if (S.playingKey === key) send('clip.stop');
    else send('clip.play', { key, startMs: range.startMs, endMs: range.endMs, ...(sessionId ? { sessionId } : {}) });
  }
  function onClip(p) {
    if (p.state === 'playing') S.playingKey = p.key;
    else if (S.playingKey === p.key) S.playingKey = null;
    if (p.state === 'expired') toast('原声已过期（只保留最近 5 分钟）', true);
    if (p.state === 'loading') S.loadingKey = p.key; else if (S.loadingKey === p.key) S.loadingKey = null;
    syncPlayButtons();
  }
  /** Updates play buttons in place so form edits in the sheet survive. */
  function syncPlayButtons() {
    document.querySelectorAll('[data-key]').forEach((btn) => {
      const playing = S.playingKey === btn.dataset.key;
      if (btn.disabled) return;
      if (btn.dataset.act === 'play') btn.textContent = playing ? '■ 停止' : '▶ 回听原声';
      else if (btn.classList.contains('play-mini')) btn.innerHTML = playing ? icon('stop', 16) : S.loadingKey === btn.dataset.key ? '…' : icon('play', 16);
      else btn.textContent = playing ? '■' : S.loadingKey === btn.dataset.key ? '…' : '▶';
    });
  }

  // ---- action draft -----------------------------------------------------------------------

  function openDraft(d) {
    const itemId = d.sourceItemId || (d.evidence?.sourceBinding || d.evidence?.source_binding)?.item_id;
    if (itemId && !d.sourceItemId) d = {...d, sourceItemId:itemId};
    const sourceSessionId = d.sessionId || d.session_id || (d.evidence?.sourceBinding || d.evidence?.source_binding)?.session_id || S.card?.data.sessionId || S.card?.data.sourceSessionId
      || (d.evidence?.utteranceIds?.some(id => S.records.has(id)) ? S.state.sessionId : null);
    if (S.deletedSessions.has(sourceSessionId)) return;
    S.draft = window.OopsDraftState.create(d);
    S.draft.sourceSessionId = sourceSessionId;
    if (d.sourceItemId) {
      // The owner came from a human-reviewed item; this is still a fresh, unsent task draft.
      S.draft.data.who = d.who === COLLECTIVE || d.who === 'collective' ? '' : d.who || '';
      S.draft.dirty.who = true;
    }
    openSheet({ kind: 'draft' });
  }
  function draftSourceValid(d) {
    const evidence = d?.evidence;
    const binding = evidence?.sourceBinding || evidence?.source_binding;
    return !d?.sourceError && !d?.source_error && !!binding
      && sourceBindingValid(binding, evidence.utteranceIds, d.sessionId || binding.session_id);
  }
  function invalidateDraftEvidence(sessionId, utteranceId) {
    if (!S.draft || S.draft.submitted) return;
    const d = S.draft.data, binding = d.evidence?.sourceBinding || d.evidence?.source_binding;
    const dependencies = [...(binding?.sources || []), ...(binding?.context_sources || [])].map(source => source.id);
    if (binding?.session_id !== sessionId || utteranceId && !dependencies.includes(utteranceId)) return;
    d.sourceError = 'source_changed';
    if (S.sheet?.kind === 'draft') renderSheet();
  }
  function editDraftField(field, value) {
    const previousOwner = S.draft?.data?.who || '';
    if (!window.OopsDraftState.edit(S.draft, field, value)) return false;
    if (field === 'who' && previousOwner !== (value || '')) {
      const model = S.draft.model;
      const ids = S.draft.data.evidence?.utteranceIds || [];
      ids.forEach((id) => S.ownerEdits.set(id, { ownerHint: value || null, suggestedOwner: model?.suggestedOwner || null, ownerReviewStatus: value ? 'selected' : null }));
      S.commitments = S.commitments.map((u) => ids.includes(u.id) ? { ...u, ...S.ownerEdits.get(u.id) } : u);
    }
    return true;
  }
  function taskContextHtml(c) {
    if (!c) return '';
    const role = { speaker: '说话人自己承诺', addressee: '说话人要求对方去做', named: '原话点名', unknown: '负责人未定' }[c.ownerRole] || '负责人未定';
    const who = c.clauseSpeaker ? `这句由 ${esc(c.clauseSpeaker)} 说（试验拆分，待核对）· ` : '';
    return `<section class="card task-context"><p class="meta">任务原话：“${esc(c.quote)}” · ${who}${esc(role)}</p>
      ${(c.resolutions || []).map((r) => `<p class="meta">“${esc(r.phrase)}”→ ${esc(r.meaning)}（依据：“${esc(r.evidence)}”）</p>`).join('')}
      ${(c.missing || []).length ? `<p class="warn-text">还缺：${c.missing.map(esc).join('；')}</p>` : ''}
      ${(c.otherTasks || []).length ? `<p class="meta">这句还提到：${c.otherTasks.map(esc).join('；')}</p>` : ''}</section>`;
  }
  function draftHtml() {
    const { data: d, status, error } = S.draft;
    const sourceChanged = S.draft.errorCode === 'SOURCE_CHANGED' || S.draft.sourceInvalidated || S.draft.sourceBlocked;
    const sourceRejected = sourceChanged && status === 'failed' && !S.draft.sourceBlocked;
    const names = [...new Set([...(d.ownerCandidates || []).map((c) => c.name), ...(d.assigneeCandidates || []), ...(d.who ? [d.who] : []), ...(d.suggestedOwner ? [d.suggestedOwner] : [])])];
    const options = ['<option value="">请选择负责人</option>'].concat(names.map((n) => `<option ${n === d.who ? 'selected' : ''}>${esc(n)}</option>`)).join('');
    const sending = status === 'sending';
    const submitted = status === 'waiting' || status === 'failed' || sending;
    const validSource = draftSourceValid(d);
    const dailyUnavailable = !validSource && S.state.recordingMode === 'daily' && (d.sourceError || d.source_error);
    const tier = d.sourceItemId ? ['会后事项 · 人工已核对', 'purple'] : d.tier === 'A' ? ['A · 模型高可信', 'green'] : d.tier === 'B' ? ['B · 建议，请核对', 'amber'] : ['C · 模型未确认负责人', 'gray'];
    const suggestions = [...new Set([d.suggestedOwner, ...(d.ownerCandidates || []).map((c) => c.name)].filter(Boolean))].slice(0, 2);
    return frame('整理成飞书任务', `<div class="inline-actions"><span class="badge ${tier[1]}">${tier[0]}</span><span class="badge ${sourceChanged ? 'gray' : S.draft.reviewStatus === 'confirmed' ? 'green' : 'purple'}">${sourceChanged ? '来源已变化 · 原操作记录' : S.draft.reviewStatus === 'confirmed' ? '人工已确认' : '待你确认'}</span></div>
      <p class="meta">${esc(d.reason || '请核对负责人')}${typeof d.ownerConfidence === 'number' ? ` · 模型建议可信度 ${(d.ownerConfidence * 100).toFixed(0)}%` : ''}</p>
      ${suggestions.length ? `<div class="inline-actions">${suggestions.map((n) => `<button class="chip" data-act="choose-owner" data-name="${esc(n)}" ${submitted ? 'disabled' : ''}>建议 ${esc(n)}</button>`).join('')}</div>` : ''}
      ${sourceChanged ? '<p class="warn-text">旧依据已撤回，不能据此重新执行。创建结果尚未知时，只能查询原操作。</p>' : `<section class="card evidence-card"><button class="play-mini" data-act="play-evidence" data-key="ev-${esc(d.draftId)}" aria-label="回听原声">${icon('play', 16)}</button><p>“${esc(d.evidence.quote)}”</p></section>${taskContextHtml(d.taskContext)}`}
      <label class="form-field"><span>负责人</span><select id="f-who" ${submitted ? 'disabled' : ''}>${options}</select></label>
      <label class="form-field"><span>事项</span><textarea id="f-what" rows="3" ${submitted ? 'disabled' : ''}>${esc(d.what)}</textarea></label>
      <label class="form-field"><span>截止时间</span><input type="date" id="f-when" ${submitted ? 'disabled' : ''} value="${esc(d.whenIso || '')}">${d.whenRaw ? `<small>原话：${esc(d.whenRaw)}</small>` : ''}</label>
      <label class="form-field"><span>约束</span><input id="f-constraint" ${submitted ? 'disabled' : ''} value="${esc(d.constraint || '')}" placeholder="例如：预算不超过 10 万"></label>
      <p class="meta">只有你点确认后才会写入飞书；同一次确认只会建一条任务。</p>
      ${!validSource && !S.draft.submitted ? `<p class="error-text">${dailyUnavailable ? '这段日常原话仅在本机临时保留，当前不能核验并创建飞书任务。可先保存私人候选，或在飞书手工记录。' : d.sourceError || d.source_error ? '原话依据已变化或不可用，请重新读取后核对。' : '原话依据尚未核验，请重新读取原话并整理任务。'}</p>` : ''}
      ${error ? `<p class="error-text">${esc(error)}</p>` : ''}
      ${!validSource && !sourceRejected && status !== 'waiting' && !sending ? dailyUnavailable ? '<button class="button secondary" type="button" data-act="daily-candidates"><span>查看私人候选</span></button>' : '<button class="button secondary" type="button" data-act="draft-source-reload"><span>重新核对原话</span></button>' : ''}
      <button class="button primary" type="button" data-act="${sourceRejected ? 'draft-source-reopen' : status === 'waiting' ? 'query-action' : 'confirm'}" ${sending || !sourceRejected && status !== 'waiting' && !validSource ? 'disabled' : ''}><span>${sending ? '正在查询…' : sourceRejected ? '重新核对当前原话' : status === 'waiting' ? '查询原操作创建结果' : status === 'failed' ? '重试同一操作' : '确认创建飞书任务'}</span></button>
      <button class="button quiet" type="button" data-act="close"><span>取消</span></button>`);
  }
  function confirmDraft() {
    if (['sending', 'waiting', 'done'].includes(S.draft?.status)) return;
    if (S.draft?.errorCode === 'SOURCE_CHANGED' || S.draft?.sourceInvalidated || S.draft?.sourceBlocked) return toast('旧依据已撤回，请核对当前原话；未知创建结果只查询原操作', true);
    if (!S.draft || !draftSourceValid(S.draft.data)) { toast('原话依据尚未核验或已经变化，请重新读取后核对', true); return; }
    const d = S.draft.data;
    const who = $('f-who').value.trim();
    const what = $('f-what').value.trim();
    if (!who || !what) { toast('请先选负责人、填写事项', true); return; }
    // Keep the edits on the draft so a re-render (e.g. after an error) doesn't lose them.
    Object.assign(d, { who, what, whenIso: $('f-when').value || null, constraint: $('f-constraint').value.trim() || null });
    window.OopsDraftState.confirm(S.draft);
    S.draft.error = null;
    renderSheet();
    send('action.confirm', {
      draftId: d.draftId, who, what, whenIso: d.whenIso || '', whenRaw: d.whenRaw || '', constraint: d.constraint || '',
      ownerSelectionSource: d.ownerSelectionSource,
    });
  }
  function onActionResult(p) {
    if (!S.draft || S.draft.data.draftId !== p.draftId) return;
    S.draft.sourceBlocked = p.sourceBlocked === true || p.source_blocked === true || !!S.draft.sourceBlocked && p.status !== 'created';
    S.draft.sourceInvalidated = p.sourceInvalidated === true || p.source_invalidated === true;
    if (S.draft.sourceInvalidated || S.draft.sourceBlocked || p.errorCode === 'SOURCE_CHANGED') S.draft.data.sourceError = 'source_changed';
    S.draft.submitted = true;
    S.draft.errorCode = p.errorCode || null;
    if (p.status === 'pending' || S.draft.sourceBlocked && p.status !== 'created') {
      S.draft.status = p.polling && !S.draft.sourceBlocked ? 'sending' : 'waiting';
      S.draft.error = p.message || null;
      if (S.sheet?.kind === 'draft') renderSheet();
      return;
    }
    if (p.status === 'created') {
      S.draft.status = 'done';
      S.draft.result = p;
      if (S.draft.data.sourceItemId) {
        const item = S.history?.session_id === S.draft.sourceSessionId && S.history.items?.find(it => it.id === S.draft.data.sourceItemId);
        if (item) { item.task_status = 'created'; item.task_url = p.taskUrl || null; }
        requestTasks(S.tasks.mine && canReadMyTasks(), S.tasks.status);
        if (S.sheet?.kind === 'draft') openSheet({ kind: 'result' });
        else { toast(p.mock ? '模拟任务已生成' : '已创建飞书任务'); render(); }
      } else openSheet({ kind: 'result' });
    } else {
      S.draft.status = 'failed';
      S.draft.error = p.message || '后端报告创建失败；本次确认内容已冻结，可查询状态';
      if (S.sheet?.kind === 'draft') renderSheet();
      else if (!S.draft.data.sourceItemId) openSheet({ kind: 'draft' });
    }
  }
  function resultHtml() {
    const d = S.draft.data;
    const r = S.draft.result;
    return frame(r.mock ? 'Mock 任务已生成' : '已创建飞书任务', `<div class="empty-state">${emptyArt('happy', 'check-circle')}<strong>${esc(d.what)}</strong>
        <p>${esc(d.who)} · ${esc(d.whenIso || '未设截止时间')}</p>${r.message ? `<p>${esc(r.message)}</p>` : ''}</div>
      <button class="button primary" type="button" data-act="open-task" ${r.taskUrl && !r.mock ? '' : 'disabled'}><span>在飞书中打开</span></button>
      <button class="button quiet" type="button" data-act="close"><span>完成</span></button>
      <p class="meta">操作编号 ${esc(String(r.opId).slice(0, 8))} · ${r.readBackConfirmed ? '已回读确认' : '尚未回读核验'}</p>`);
  }

  // ---- voiceprint ---------------------------------------------------------------------------

  const ENROLL_TEXT = '现在录入我的声纹，这段话只用于声音测试。早晨的阳光照进房间，窗外有人散步，远处传来汽车的声音。桌上放着一本书、一杯水和一支笔。我用平时说话的声音朗读，保持自然的语速和音量。读完后稍作停顿，再从头朗读一次。';
  const TEST_TEXT = '午后的公园很安静，树叶随着微风轻轻摇动。小路旁有几朵花，远处的孩子正在玩耍。我现在用另一段文字测试声音匹配。';

  // Audio arrives many times a second. Only phase/content changes rebuild the form.
  function voiceprintViewKey(voiceprint) {
    const { elapsedMs, ...content } = voiceprint || {};
    return JSON.stringify(content);
  }
  function updateVoiceprintProgress() {
    if (S.sheet?.kind !== 'voiceprint' || S.state.voiceprint?.phase !== 'recording') return;
    const v = S.state.voiceprint;
    const limit = v.mode === 'test' ? 10 : 30;
    const time = $('vp-time'), progress = $('vp-progress'), audio = $('vp-audio');
    if (time) time.textContent = `已录 ${clock(v.elapsedMs)} / 0:${limit}`;
    if (progress) progress.value = Math.min(limit, Math.max(0, Number(v.elapsedMs) / 1000 || 0));
    if (audio) audio.textContent = S.state.sourceReady ? '正在收到音频' : '等待麦克风连接';
  }

  function voiceprintHtml() {
    const v = S.state.voiceprint || { phase: 'idle' };
    const busy = ['loading', 'saving', 'testing', 'checking'].includes(v.phase);
    const recording = v.phase === 'recording';
    const name = ['recording', 'checking', 'review', 'saving', 'testing'].includes(v.phase) ? (v.name || S.voiceprintName) : (S.voiceprintName || v.name);
    const people = v.catalog?.people || [];
    const limit = v.mode === 'test' ? 10 : 30;
    const locked = busy || recording || v.phase === 'review';
    const message = busy ? ({ loading: '正在读取声纹列表…', saving: '正在检查并保存声纹…', testing: '正在比较四人的声纹…', checking: '正在检查录音质量…' })[v.phase] : v.message;
    const results = v.diagnosis ? `${sectionTitle('这段测试录音的结果')}
      <section class="card"><p class="meta">${esc(v.diagnosis.speaker ? '当前判断：' + v.diagnosis.speaker : '当前判断：未知')}<br>
      最接近：${esc(v.diagnosis.closest || '暂无声纹')} · 相似度 ${Number(v.diagnosis.score).toFixed(3)}<br>${esc(v.diagnosis.reason)}</p>
      ${(v.diagnosis.scores || []).map((x) => `<p class="meta">${esc(x.name)} · ${Number(x.score).toFixed(3)}</p>`).join('')}
      <p class="meta">当前门槛 ${v.diagnosis.accept}，领先幅度至少 ${v.diagnosis.required_margin}；相似度不是正确概率，请核对真实说话人。</p></section>` : '';
    return frame('声纹录入与测试', `<label class="form-field"><span>本人姓名</span><select id="vp-name" ${locked ? 'disabled' : ''}>
        <option value="">请选择正在朗读的人</option>${people.map((p) => `<option value="${esc(p.name)}" ${name === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <p class="meta">${recording ? '正在使用' : '录入音源'}：${esc(SOURCE_TEXT[v.source || S.state.source || 'mic'] || '手机麦克风')}。请仅由本人朗读，避免旁人讲话或播放录音。</p>
      ${sectionTitle(v.mode === 'test' ? '测试朗读文字（约 10 秒）' : '录入朗读文字（约 30 秒）')}
      <section class="card"><p class="read-aloud">${v.mode === 'test' ? TEST_TEXT : `我是${esc(name || '（请先选姓名）')}。${ENROLL_TEXT}`}</p></section>
      ${recording ? `<h3 class="section-title" id="vp-time">已录 ${clock(v.elapsedMs)} / 0:${limit}</h3>
        <progress id="vp-progress" aria-label="声纹录音进度" max="${limit}" value="${Math.min(limit, Math.max(0, Number(v.elapsedMs) / 1000 || 0))}" style="width:100%;accent-color:var(--primary, #7853db)"></progress>
        <p class="meta" id="vp-audio">${S.state.sourceReady ? '正在收到音频' : '等待麦克风连接'}</p>
        <button class="button secondary" type="button" data-act="vp-stop"><span>结束这段录音</span></button>
        <button class="button quiet" type="button" data-act="vp-cancel"><span>放弃这段录音</span></button>` : ''}
      ${v.phase === 'review' ? `<p class="meta">已录 ${clock(v.elapsedMs)}。${v.mode === 'test' ? '测试只比较声音，不会更新声纹。' : `保存后替换 ${esc(name)} 的现有声纹，其他成员保留。`}</p>
        <div class="action-grid"><button class="button secondary" type="button" data-act="vp-cancel"><span>放弃并重录</span></button>
          <button class="button primary" type="button" data-act="vp-save" ${(v.mode === 'test' ? v.elapsedMs < 1000 : !v.qualityPassed) ? 'disabled' : ''}><span>${v.mode === 'test' ? '重试匹配' : '保存声纹'}</span></button></div>` : ''}
      ${!recording && !busy && v.phase !== 'review' ? `<label class="toggle-row"><span><strong>由本人单独朗读</strong><small>并同意上传声音用于声纹匹配</small></span><input id="vp-consent" type="checkbox"></label>
        <div class="action-grid"><button class="button primary" type="button" data-act="vp-record" ${people.length ? '' : 'disabled'}><span>开始录入 · 30 秒</span></button>
          <button class="button secondary" type="button" data-act="vp-test" ${people.length ? '' : 'disabled'}><span>测试匹配 · 10 秒</span></button></div>` : ''}
      ${v.quality ? `<p class="meta">录音 ${v.quality.seconds} 秒 · 有效音量片段 ${v.quality.active_seconds} 秒</p>` : ''}
      ${message ? `<p class="meta" role="status">${esc(message)}</p>` : ''}
      ${results}
      ${sectionTitle('已注册成员')}
      ${people.map((p) => `<div class="list-row"><span class="avatar">${esc(initial(p.name))}</span><span class="row-copy"><strong>${esc(p.name)}</strong>
        <small>${p.registered ? `${esc(SOURCE_TEXT[p.source] || p.source || '')} · ${p.seconds} 秒` : '未注册'}</small></span>
        ${p.registered ? `<button class="chip" data-act="vp-delete-prompt" data-name="${esc(p.name)}" ${locked ? 'disabled' : ''}>删除</button>` : ''}</div>`).join('')}
      ${S.voiceprintDelete ? `<p class="meta">确认删除 ${esc(S.voiceprintDelete)} 的声纹？删除后需重新录入才能匹配此人。</p>
        <button class="button danger" type="button" data-act="vp-delete-confirm"><span>确认删除 ${esc(S.voiceprintDelete)}</span></button>` : ''}
      <button class="button quiet" type="button" data-act="vp-refresh" ${locked ? 'disabled' : ''}><span>刷新列表</span></button>
      <p class="meta">服务器只保存声纹特征，临时录音用于提取或测试后清除。音量、时长及片段一致性检查不能验证本人身份，也不能保证识别准确。关闭本页会放弃尚未保存的录入；日常收音不受影响。</p>`);
  }
  function recordVoiceprint(mode) {
    const name = $('vp-name').value;
    if (mode === 'enroll' && !name) return toast('请先选择本人姓名');
    if (!$('vp-consent').checked) return toast('请先确认本人同意上传声音');
    S.voiceprintName = name;
    S.voiceprintDelete = null;
    send('voiceprint.record', { name, consent: true, mode });
  }

  // ---- saved, ask, agenda, notices --------------------------------------------------------

  function savedHtml() {
    const items = S.sheet.items;
    return frame('已保存 · 长期记忆', items.length
      ? items.map((it) => `<section class="card"><p class="recall-quote">${esc(savedMemoryText(it))}</p>${it.evidence ? dailyEvidenceHtml(it) : ''}
          <p class="meta">${esc(formatDate(it.saved_at))} · ${it.audio_expired ? '原声已过期' : '含原声'}</p></section>`).join('')
      : `<div class="empty-state">${emptyArt('sleepy', 'bookmark-simple')}<strong>还没有保存的片段</strong><p>找回原话后点「保存」才会留在这里。</p></div>`);
  }
  function askHtml() {
    return frame('问已有记录', `<label class="form-field"><span>范围</span><select id="ask-scope"><option value="session">本场</option><option value="history" ${S.sheet.history ? 'selected' : ''}>往期会议</option></select></label>
      <label class="form-field"><span>想问什么？</span><textarea id="ask-query" rows="3" maxlength="500" placeholder="预算上限是多少？谁负责新方案？">${esc(S.sheet.query || '')}</textarea></label>
      <div class="inline-actions"><button class="chip" data-act="ask-example" data-query="预算上限是多少？">预算上限</button><button class="chip" data-act="ask-example" data-query="谁负责新方案？">谁来负责</button></div>
      <button class="button primary" type="button" data-act="ask-submit"><span>查找原话</span></button>
      <p class="meta">答案只引用已记录的原话。本场停止收音后仍可提问，下一场开始会清空本场索引。</p>`);
  }
  function agendaHtml() {
    const a = S.state.agenda || {};
    return frame('本场目标与议程', `<label class="form-field"><span>本场目标</span><input id="agenda-goal" maxlength="500" value="${esc(a.goal || '')}" placeholder="确认上线方案与负责人"></label>
      <label class="form-field"><span>议程 · 每行一项，可加分钟数</span><textarea id="agenda-items" rows="6" placeholder="方案评审 10&#10;负责人确认（5分钟）">${esc((a.items || []).map((i) => i.title + (i.plannedMs ? ` ${i.plannedMs / 60000}` : '')).join('\n'))}</textarea></label>
      <label class="form-field"><span>会议计划时长（分钟，可留空）</span><input id="agenda-minutes" type="number" min="1" max="480" value="${a.plannedMs ? a.plannedMs / 60000 : ''}"></label>
      <p class="meta">最多 20 项，每项标题 60 字，时长 1–480 分钟。收音中也可以修改；已讨论时长会保留。</p>
      <div class="action-grid"><button class="button secondary" type="button" data-act="agenda-clear"><span>清除议程</span></button><button class="button primary" type="button" data-act="agenda-save"><span>保存议程</span></button></div>`);
  }
  function saveAgenda() {
    const lines = $('agenda-items').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.length > 20) return toast('最多 20 项议程', true);
    const items = lines.map((line) => {
      const m = line.match(/^(.*?)(?:[（(]\s*(\d+)\s*分钟\s*[）)]|\s+(\d+))\s*$/);
      return { title: m ? m[1].trim() : line, minutes: m ? Number(m[2] || m[3]) : null };
    });
    const minutes = $('agenda-minutes').value ? Number($('agenda-minutes').value) : null;
    if (items.some((i) => !i.title || i.title.length > 60) || [...items.map((i) => i.minutes), minutes].some((n) => n !== null && (!Number.isInteger(n) || n < 1 || n > 480))) return toast('请检查标题和分钟数', true);
    send('agenda.set', { goal: $('agenda-goal').value.trim(), items, minutes }); closeSheet();
  }
  let noticeTimer;
  function showNotice(n) {
    S.notices.set(n.id, n);
    S.activeNotices = [...S.activeNotices.filter((x) => x !== n.id), n.id].slice(-2);
    renderNoticeBanners();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { S.activeNotices = []; renderNoticeBanners(); }, 12000);
  }
  function noticeButtons(n) {
    return `<div class="inline-actions">${n.evidenceIds?.length ? `<button class="chip selected" data-act="notice-open" data-id="${esc(n.id)}">查看原话</button>` : ''}
      <button class="chip" data-act="notice-useful" data-id="${esc(n.id)}" ${n.useful === true ? 'disabled' : ''}>有用</button><button class="chip" data-act="notice-wrong" data-id="${esc(n.id)}" ${n.useful === false ? 'disabled' : ''}>不准</button>
      <button class="chip" data-act="notice-dismiss" data-id="${esc(n.id)}" aria-label="关闭提醒">收起</button></div>`;
  }
  function renderNoticeBanners() {
    // Banners are redrawn whenever state arrives; only a notice shown for the first time drops in (oops-design.css).
    const shown = S.noticesShown || (S.noticesShown = new Set());
    const banners = S.activeNotices.map((id) => S.notices.get(id)).filter((n) => n && !n.dismissed);
    $('notices').innerHTML = banners.map((n) =>
      `<section class="card notice-banner${shown.has(n.id) ? '' : ' is-new'}"><span class="badge amber">${esc(n.kind === 'conflict' ? '可能冲突' : '会议提醒')}</span><h3>${esc(n.title)}</h3><p>${esc(n.detail)}</p>${noticeButtons(n)}</section>`).join('');
    banners.forEach((n) => shown.add(n.id));
  }
  function noticeRecordsHtml(rows, readonly = false) {
    return rows.length ? rows.map((n) => `<section class="card"><h3>${esc(n.title)}</h3><p>${esc(n.detail)}</p>
      <p class="meta">${clock(n.atMs ?? n.at_ms)}${n.useful === false ? ' · 已反馈不准' : n.useful === true ? ' · 已反馈有用' : ''}${n.dismissed ? ' · 已收起' : ''}</p>${readonly ? '' : noticeButtons(n)}</section>`).join('')
      : `<div class="empty-state">${emptyArt('sleepy', 'bell')}<strong>暂无提醒</strong><p>议程超时、跑题、和之前的决定冲突时会提醒。</p></div>`;
  }

  // ---- past meetings ------------------------------------------------------------------------

  function visibleProject(project) {
    const meetings = (project.meetings || []).filter(x => !S.deletedSessions.has(x.session_id));
    const decisions = (project.decisions || []).filter(x => !S.deletedSessions.has(x.session_id) && !['changed', 'unavailable'].includes(x.source_status));
    return { ...project, meetings, decisions, tasks: (project.tasks || []).map(visibleTaskSource), meeting_items: (project.meeting_items || []).filter(candidateSourceVisible),
      source_filtered: meetings.length !== (project.meetings || []).length || decisions.length !== (project.decisions || []).length };
  }
  function deleteHistory() {
    const sessionId = S.history?.session_id;
    if (!sessionId || S.pendingDelete?.status === 'saving') return;
    const requestId = `delete-${++S.historySerial}`;
    S.pendingDelete = { sessionId, requestId, status: 'saving' };
    renderSheet(); send('history.delete', { sessionId, requestId, confirm: true });
  }
  function onHistoryDeleted(p) {
    const pending = S.pendingDelete;
    if (!pending || p.sessionId !== pending.sessionId || p.requestId !== pending.requestId || p.deleted !== true) return;
    const sid = pending.sessionId;
    const wasVisible = S.route.name === 'meeting' && S.route.id === sid || S.history?.session_id === sid && S.sheet?.kind === 'tools';
    S.deletedSessions.add(sid); S.pendingDelete = null;
    forgetReadLease(`history.open:${sid}`); forgetReadLease(`minutes:${sid}`);
    S.historyItems = S.historyItems?.filter(x => x.session_id !== sid) || null;
    S.minutes.delete(sid); S.deliveries.delete(sid); S.projects.items = null;
    minutesSync?.remove(sid);
    if (S.projects.open) S.projects.open = visibleProject(S.projects.open);
    if (S.history?.session_id === sid) S.history = null;
    if (S.meetingRequest?.sessionId === sid) { S.meetingRequest.active = false; S.pendingMeetingId = null; }
    if (S.pendingReview === sid) S.pendingReview = null;
    if (S.pendingTools === sid) S.pendingTools = null;
    if (S.pendingRetention?.sessionId === sid) S.pendingRetention = null;
    if (S.review?.sessionId === sid) S.review = null;
    if (S.itemReview?.sessionId === sid) S.itemReview = null;
    if (S.card && (S.card.data.sessionId === sid || S.card.data.sourceSessionId === sid || S.card.data.pool?.some(x => x.sessionId === sid))) S.card = null;
    if (S.draft && !S.draft.submitted && S.draft.sourceSessionId === sid) S.draft = null;
    if (sid === S.state.sessionId) { resetTranscript(); S.expiredBoardSession = sid; S.board = null; }
    if (S.playingKey || S.loadingKey) { send('clip.stop'); S.playingKey = null; S.loadingKey = null; }
    S.tasks.items = S.tasks.items?.map(visibleTaskSource) || null; S.tasks.archived = (S.tasks.archived || []).map(visibleTaskSource); S.homeTasks = S.homeTasks?.map(visibleTaskSource) || null;
    S.tasks.parsedItems = S.tasks.parsedItems?.filter(candidateSourceVisible) || null;
    S.tasks.meetingItems = S.tasks.meetingItems?.filter(candidateSourceVisible) || null;
    for (const cached of S.tasks.cache.values()) {
      cached.items = cached.items.map(visibleTaskSource); cached.archived = (cached.archived || []).map(visibleTaskSource);
      cached.parsedItems = cached.parsedItems?.filter(candidateSourceVisible) || null;
      cached.meetingItems = cached.meetingItems?.filter(candidateSourceVisible) || null;
    }
    toast('会议与原始录音已删除；正式任务回执独立保留');
    if (wasVisible) { closeSheet(); go('sessions'); } else render();
    requestTasks(false, 'all');
  }
  function historyOpen(p) {
    if (S.deletedSessions.has(p.session_id) || p.requestId && p.requestId !== S.meetingRequest?.requestId) return;
    if (S.meetingRequest && (!S.meetingRequest.active || S.meetingRequest.sessionId !== p.session_id)) return;
    if (!acceptRead(`history.open:${p.session_id}`, p, () => expireMeeting(p.session_id), () => renewVisibleMeeting(p.session_id))) return;
    if (readFinal(p)) unavailableReadSources.delete(p.session_id);
    const request = S.meetingRequest;
    const memoryOrigin = p.requestId === request?.requestId ? validMemoryOrigin(request?.memoryOrigin) : null;
    const returnItemId = p.requestId === request?.requestId ? request?.returnItemId : null;
    const stayOnPage = !request?.previewShown || S.route.name === 'meeting' && S.route.id === p.session_id;
    if (readFinal(p)) {
      clearTimeout(request?.timer); if (request) { request.active = false; request.error = null; }
      S.pendingMeetingId = null;
    } else if (request) request.previewShown = true;
    S.history = p;
    minutesSync?.select(p);
    if (!S.minutes.get(p.session_id)?.loading && (!S.minutes.get(p.session_id)?.data || !readValid(`minutes:${p.session_id}`))) requestMinutes(p.session_id);
    if (readFinal(p) && S.pendingReview === p.session_id) { S.pendingReview = null; return startReview(p); }
    if (S.sheet?.kind === 'pending') closeSheet(!readFinal(p));
    if (stayOnPage && (S.route.name !== 'meeting' || S.route.id !== p.session_id)) { S.meetingTab = 'overview'; S.transcriptFilter = { speaker: null, query: '' }; go('meeting', { id: p.session_id, ...(memoryOrigin ? { memoryOrigin } : {}) }); }
    else if (S.route.name === 'meeting' && S.route.id === p.session_id) render();
    if (readFinal(p) && stayOnPage && returnItemId && (p.items || []).some(item=>item.id===returnItemId)) return startItemReview(p,returnItemId);
    if (readFinal(p) && stayOnPage && S.pendingTools === p.session_id) { S.pendingTools = null; openSheet({ kind: 'tools', live: false }); }
  }
  function historySearch(p) {
    const source = (p.items || []).filter(i => !S.deletedSessions.has(i.session_id));
    if (!source.length) return openSheet({ kind: 'notFound', reason: '往期会议原话里没有找到答案' });
    const items = source.map((i) => ({ id: i.id, sessionId: i.session_id, text: i.text, startMs: i.start_ms, endMs: i.end_ms, speaker: i.speaker, prob: i.prob, audioAvailable: false, startedAt: i.started_at }));
    openCard({ id: 'history-search', trigger: 'ask', query: p.query, nowMs: 0, items, pool: items, single: items.length === 1, engine: p.engine, latencyMs: 0, readOnly: true });
  }

  // ---- Personal Feishu binding and explicitly confirmed minutes delivery -------------------
  const feishuAccountKey = () => JSON.stringify(S.feishu.account ? [S.feishu.bindingRevision || S.feishu.account.binding_id || S.feishu.account.bindingId || '', S.feishu.account.open_id || S.feishu.account.openId || '', S.feishu.account.tenant_key || ''] : null);
  const deliveryBusy = d => !!d?.busy || ['pending', 'sending', 'partial', 'unknown'].includes(d?.status);
  const deliverySent = d => ['sent', 'completed', 'succeeded'].includes(d?.status);
  const deliveryBlocked = d => ['source_changed', 'stale', 'unavailable', 'waiting_minutes', 'unconfigured', 'expired', 'not_found', 'forbidden', 'invalidated'].includes(d?.status) || ['source_changed', 'stale'].includes(d?.data?.reason);
  const activeDelivery = () => S.sheet?.kind === 'minutesDelivery' ? S.deliveries.get(S.sheet.sessionId) : null;
  const missingFeishuCapabilities = () => [['documents_write','创建纪要文档'],['sharing','设置文档权限'],['messages_send','发送纪要通知']].filter(([key]) => S.feishu.capabilities?.[key] === false).map(([,label]) => label);
  const deliveryCanConfirm = d => !!d?.draft && !deliveryBusy(d) && !deliverySent(d) && !deliveryBlocked(d) && !d.dirty && d.accountKey === feishuAccountKey() && S.feishu.status === 'connected' && !missingFeishuCapabilities().length && d.draft.title?.trim() && d.draft.content?.trim() && d.draft.recipients?.length > 0 && d.draft.recipients.every(person => typeof person === 'object' && person.name || S.feishu.knownRecipients?.[deliveryPersonId(person)]?.name);
  const deliveryPersonId = p => typeof p === 'string' ? p : p.open_id || p.id || '';
  const deliveryPersonName = p => typeof p === 'string' ? S.feishu.knownRecipients?.[p]?.name || `待核对联系人（${p}）` : p.name || p.display_name || '飞书联系人';
  function feishuRequest(type, payload = {}) {
    const requestId = `feishu-${++S.feishuSerial}`;
    S.feishu.requestId = requestId; S.feishu.busy = true; S.feishu.error = null;
    send(type, {...payload, requestId});
    setTimeout(() => { if (S.feishu.requestId === requestId && S.feishu.busy) { S.feishu.busy = false; S.feishu.error = '尚未收到授权状态，请返回后刷新确认。'; if (S.sheet?.kind === 'feishu') renderSheet(); } }, 20000);
    return requestId;
  }
  function openFeishu() { openSheet({kind:'feishu'}); feishuRequest('feishu.status'); }
  function onFeishuStatus(p) {
    if (p.requestId && p.requestId !== S.feishu.requestId) return;
    const before = feishuAccountKey(), wasAuthorizing = S.feishu.status === 'authorizing';
    Object.assign(S.feishu, {bindingRevision:p.binding_revision, status:({bound:'connected',unbound:'disconnected'}[p.status] || p.status || 'disconnected'), account:p.account || null, capabilities:p.capabilities || {}, busy:false, error:p.message || null});
    if (wasAuthorizing && S.feishu.status === 'disconnected') S.feishu.status = 'cancelled';
    if (before !== feishuAccountKey() || S.feishu.status !== 'connected') {
      raft.reset();
      if (S.route.name === 'raft') render();
      if (usesPersonalTaskIdentity()) {
        clearTaskIdentity();
        if (S.route.name === 'tasks') openTasks();
        else if (S.route.name === 'home') loadHomeTasks();
        if (['tasks', 'home', 'memory'].includes(S.route.name)) render();
      }
      S.feishu.recipients = []; S.feishu.knownRecipients = {}; S.feishu.recipientSource = null; S.feishu.recipientSearched = false; S.feishu.recipientRequestId = null;
      for (const d of S.deliveries.values()) d.confirmed = false;
    }
    const blocked = activeDelivery();
    if (before !== feishuAccountKey() && S.feishu.status === 'connected' && blocked?.status === 'forbidden' && blocked.data?.code === 'MEETING_ACCOUNT_MISMATCH') {
      blocked.status = 'loading'; blocked.data = null;
      deliveryRequest('minutes.delivery.open', blocked.sessionId);
    }
    if (['feishu','minutesDelivery'].includes(S.sheet?.kind)) renderSheet();
    if (S.route.name === 'me') render();
  }
  function onFeishuAuthorization(p) {
    if (p.requestId && p.requestId !== S.feishu.requestId) return;
    S.feishu.busy = false; S.feishu.status = p.status || 'authorizing';
    S.feishu.error = p.message || (p.authorization_url ? '请在飞书官方授权页确认，完成后返回并刷新状态。' : '未获得可用授权页面，请刷新后重试。');
    // The native shell validates and opens the official HTTPS URL. Never open an arbitrary URL here.
    if (S.sheet?.kind === 'feishu') renderSheet();
  }
  function feishuHtml() {
    const f = S.feishu, labels = {loading:'正在读取', disconnected:'尚未绑定', connected:'已绑定我的账号', authorizing:'等待飞书授权', cancelled:'本次授权已取消', expired:'授权已过期', unconfigured:'应用尚未配置', unavailable:'飞书应用暂不可用'};
    return frame('我的飞书', `${S.state.backend === 'mock' ? '<p class="notice">隔离模拟，不会访问真实飞书或发送消息。</p>' : ''}<section class="card"><span class="badge ${f.status === 'connected' ? 'green' : 'gray'}">${labels[f.status] || esc(f.status)}</span><h3>${esc(f.account?.name || f.account?.display_name || '绑定你自己的飞书')}</h3><p class="meta">${esc(f.account?.tenant_name || '在手机发起飞书官方授权，确认账号和权限后返回 Oops。')}</p></section>
      ${f.error ? `<p class="meta" role="status">${esc(f.error)}</p>` : ''}
      ${f.status === 'connected' ? `<section class="card"><h3>已授权能力</h3>${[['documents_write','创建纪要文档'],['sharing','设置选定收件人的文档权限'],['messages_send','发送纪要通知']].map(([key,label]) => `<p class="meta">${label}：${f.capabilities?.[key] === false ? '未获授权' : f.capabilities?.[key] === true ? '已获授权' : '以服务核对结果为准'}</p>`).join('')}</section>${missingFeishuCapabilities().length ? '<button class="button secondary" data-act="feishu-connect">补充授权我的飞书</button>' : ''}<p>已绑定不代表同意自动发送。每份纪要仍需核对正文、收件人和文档权限。</p><button class="button danger" data-act="feishu-disconnect-prompt" ${f.busy ? 'disabled' : ''}>断开我的飞书</button>` : `<button class="button primary" data-act="feishu-connect" ${f.busy || ['unconfigured','unavailable'].includes(f.status) ? 'disabled' : ''}>${f.busy ? '正在读取…' : f.status === 'expired' ? '重新授权我的飞书' : '连接我的飞书'}</button>`}
      ${['unconfigured','unavailable'].includes(f.status) ? '<p class="meta">管理员需要配置飞书应用和官方回调，当前不能发起授权。</p>' : ''}
      <button class="button secondary" data-act="feishu-refresh" ${f.busy ? 'disabled' : ''}>返回授权后，刷新状态</button>
      ${S.sheet.disconnectConfirm ? '<section class="card"><p>断开后停止后续访问，未发送草稿保留，原发送确认失效。已交付的文档权限需在飞书中管理。</p><button class="button danger" data-act="feishu-disconnect">确认断开</button></section>' : ''}
      ${S.feishuReturnSession ? '<button class="button quiet" data-act="delivery-return">返回核对纪要</button>' : ''}`);
  }
  function openMinutesDelivery(sessionId) {
    if (!sessionId || S.deletedSessions.has(sessionId)) return;
    openSheet({kind:'minutesDelivery',sessionId});
    feishuRequest('feishu.status');
    if (!S.deliveries.has(sessionId)) deliveryRequest('minutes.delivery.open', sessionId);
  }
  function deliveryRequest(type, sessionId, extra = {}) {
    const d = S.deliveries.get(sessionId) || {sessionId, status:'loading', dirty:false, confirmed:false};
    const requestId = `delivery-${++S.feishuSerial}`;
    d.busy = true; d.requestId = requestId; d.requestAccountKey = feishuAccountKey(); d.requestType = type; d.error = null;
    if (type !== 'minutes.delivery.status') d.confirmed = false;
    S.deliveries.set(sessionId, d);
    send(type, {sessionId, requestId, ...extra});
    if (S.sheet?.kind === 'minutesDelivery' && S.sheet.sessionId === sessionId) renderSheet();
    setTimeout(() => { if (d.requestId === requestId && d.busy) { d.busy = false; d.error = type === 'minutes.delivery.confirm' ? '发送结果尚未确认，请查询原操作结果，勿重复发送。' : '暂未收到回执，请重试读取。'; if (type === 'minutes.delivery.confirm') d.status = 'unknown'; if (activeDelivery() === d) renderSheet(); } }, 20000);
  }
  const ownershipRecovery = {
    MEETING_OWNER_UNVERIFIED: {title:'这场会议的记录人尚未核实', message:'请先核实这场会议的记录人和原始记录。重新绑定飞书不会自动认领旧会议。'},
    MEETING_OWNER_MISMATCH: {title:'这场会议不属于当前本人', message:'请打开本人记录的会议，或由该会议的记录人核对并发送。'},
    MEETING_ACCOUNT_MISMATCH: {title:'原会议绑定的飞书账号不同', message:'请在“我的飞书”重新连接这场会议原来绑定的账号。'},
  };
  function blockDeliveryOwnership(d, p) {
    d.busy = false; d.status = 'forbidden'; d.error = p.message || null;
    d.draft = null; d.dirty = false; d.confirmed = false; d.accountKey = null; d.opId = null;
    d.data = {...p, status:'forbidden', draft:null, delivery:null};
    // Retire the failed request and contact lookup so late receipts cannot revive its draft or selection.
    d.requestId = null;
    S.feishu.recipients = []; S.feishu.knownRecipients = {}; S.feishu.recipientRequestId = null;
    S.feishu.recipientQuery = ''; S.feishu.recipientSearched = false; S.feishu.recipientsLoading = false;
    S.feishu.recipientsError = null; S.feishu.recipientSource = null;
  }
  function onMinutesDelivery(p) {
    const sid = p.session_id || p.sessionId, d = S.deliveries.get(sid);
    if (!d || !p.requestId || p.requestId !== d.requestId || S.deletedSessions.has(sid)) return;
    if (p.status === 'forbidden' || ownershipRecovery[p.code] || p.ownership?.can_send === false) {
      blockDeliveryOwnership(d, p);
      if (activeDelivery() === d) renderSheet();
      return;
    }
    d.busy = false; d.data = p;
    const operation = p.delivery;
    d.status = p.status || (operation && (operation.revision === p.draft?.revision || ['unknown','sending','partial'].includes(operation.status)) ? operation.status : 'ready'); d.error = p.message || null; d.confirmed = false;
    if (p.draft) { d.draft = {...p.draft, recipients:[...(p.draft.recipients || [])], permission:p.draft.permission || 'view'}; d.dirty = false; d.accountKey = (p.draft.account_open_id !== undefined && p.draft.account_open_id !== S.feishu.account?.open_id || p.draft.binding_revision !== undefined && p.draft.binding_revision !== S.feishu.bindingRevision) ? 'outdated-account' : p.draft.binding_revision !== undefined && p.draft.account_open_id !== undefined ? feishuAccountKey() : d.requestAccountKey; }
    if (p.op_id || p.opId || operation?.op_id) d.opId = p.op_id || p.opId || operation.op_id;
    if (activeDelivery() === d) renderSheet();
  }
  function deliveryEdit(field, value) {
    const d = activeDelivery(); if (!d?.draft || deliveryBusy(d) || deliverySent(d) || deliveryBlocked(d)) return;
    d.draft[field] = value; d.dirty = true; d.confirmed = false;
    const box = $('delivery-confirmed'); if (box) box.checked = false;
    const btn = $('delivery-send'); if (btn) btn.disabled = true;
    const save = $('delivery-save'); if (save) save.disabled = !d.draft.title.trim() || !d.draft.content.trim() || S.feishu.status !== 'connected';
  }
  function deliveryRecipientsRequest() {
    const d = activeDelivery();
    if (!d?.draft || deliveryBusy(d) || deliverySent(d) || deliveryBlocked(d)) return;
    const requestId = `recipient-${++S.feishuSerial}`;
    S.feishu.recipientRequestId = requestId; S.feishu.recipientsLoading = true; S.feishu.recipientsError = null;
    send('feishu.recipients', {query:$('delivery-search')?.value || '',requestId});
  }
  function minutesDeliveryHtml() {
    const d = activeDelivery();
    if (!d) return frame('核对并发送纪要', '<p>正在读取待发送草稿…</p>');
    if (d.status === 'forbidden') {
      const recovery = ownershipRecovery[d.data?.code] || {title:'当前账号不能发送这场会议', message:'请回到会议核对记录来源，或查看当前本人绑定的飞书账号。'};
      return frame('核对并发送纪要', `<section class="card"><span class="badge gray">暂不能发送</span><h3>${esc(recovery.title)}</h3><p>${esc(d.error || '服务端尚未确认当前本人可以发送这场会议。')}</p><p class="meta">${esc(d.data?.recovery?.message || recovery.message)}</p></section><p class="meta">仍可回到会议查看原文和已保存的纪要。</p><button class="button primary" data-act="close">回到会议</button><button class="button secondary" data-act="delivery-connect">${d.data?.code === 'MEETING_ACCOUNT_MISMATCH' ? '查看并连接原飞书账号' : '查看我的飞书'}</button>`);
    }
    const draft = d.draft, locked = deliveryBusy(d) || deliverySent(d) || deliveryBlocked(d), f = S.feishu;
    const selected = draft?.recipients || [], ids = selected.map(deliveryPersonId);
    const statuses = {invalidated:'账号或来源已变化，原操作失效',pending:'发送中，等待回执',sending:'发送中，等待回执',unknown:'发送结果待确认',partial:'部分交付，先核对原操作回执',sent:'发送成功',completed:'发送成功',succeeded:'发送成功',source_changed:'来源已变化，请重新核对',stale:'来源已失效',waiting_minutes:'等待会议纪要',unavailable:'纪要暂不可用',expired:'授权已过期',unconfigured:'应用尚未配置',failed:'操作失败，先核对结果',ready:'等待你核对',draft:'等待你核对'};
    return frame('核对并发送纪要', `${S.state.backend === 'mock' ? '<span class="badge gray">隔离发送模拟</span>' : ''}<p class="meta">发送账号：${esc(f.status === 'connected' ? f.account?.name || '我的飞书' : '尚未绑定或授权已失效')}</p>
      ${f.status !== 'connected' ? '<button class="button secondary" data-act="delivery-connect">连接我的飞书</button>' : ''}
      ${missingFeishuCapabilities().length ? `<p class="error-text">当前授权缺少：${missingFeishuCapabilities().map(esc).join('、')}。请到我的飞书补充授权后重新核对。</p><button class="button secondary" data-act="delivery-connect">补充飞书授权</button>` : ''}<p class="meta" role="status">${d.busy ? '正在读取或等待服务器回执…' : statuses[d.status] || esc(d.status)}</p>${d.error ? `<p class="error-text" role="alert">${esc(d.error)}</p>` : ''}
      ${draft ? `<label class="form-field"><span>纪要标题</span><input id="delivery-title" value="${esc(draft.title)}" ${locked ? 'disabled' : ''}></label><label class="form-field"><span>核对纪要正文</span><textarea id="delivery-content" rows="10" ${locked ? 'disabled' : ''}>${esc(draft.content)}</textarea></label>
      <h3>选择收件人 · ${selected.length}人</h3><p class="meta">参会人只是线索，不会自动勾选。已选：${selected.length ? selected.map(deliveryPersonName).map(esc).join('、') : '无，请明确选择'}</p>
      ${!locked ? `<p class="meta">已选联系人须能核对姓名；待核对联系人请搜索确认或移除后重新选择。</p><label class="form-field"><span>搜索飞书联系人</span><input id="delivery-search" value="${esc(S.feishu.recipientQuery || '')}" placeholder="输入姓名"></label><button class="button quiet" data-act="delivery-search" ${f.status !== 'connected' || f.recipientsLoading ? 'disabled' : ''}>${f.recipientsLoading ? '正在查询…' : '查询联系人'}</button>
      ${f.recipientSource === 'bound_accounts' ? `<p class="meta">${f.capabilities?.recipients_search ? '先显示同组织已绑定的账号；输入姓名可查询飞书联系人。收件人无需绑定 Oops。' : '当前授权未包含联系人搜索，仅列出已绑定的同组织账号。'}</p>` : ''}${f.recipientSearched && !f.recipientsLoading && !f.recipients.length && !f.recipientsError ? '<p class="meta">没有符合条件的账号，可调整姓名后重新查询。</p>' : ''}${f.recipientsError ? `<p class="error-text">${esc(f.recipientsError)}</p>` : ''}${f.recipients.map(person => `<label class="check-row"><input type="checkbox" data-delivery-recipient="${esc(deliveryPersonId(person))}" ${ids.includes(deliveryPersonId(person)) ? 'checked' : ''}><span>${esc(person.name)} · ${esc(deliveryPersonId(person).slice(-8))}${person.department ? ' · ' + esc(person.department) : ''}</span></label>`).join('')}
      ${selected.filter(p => !f.recipients.some(x => deliveryPersonId(x) === deliveryPersonId(p))).map(p => `<label class="check-row"><input type="checkbox" data-delivery-recipient="${esc(deliveryPersonId(p))}" checked><span>${esc(deliveryPersonName(p))} · 已选</span></label>`).join('')}` : ''}
      <label class="form-field"><span>收件人的文档权限</span><select id="delivery-permission" ${locked ? 'disabled' : ''}><option value="view" ${draft.permission === 'view' ? 'selected' : ''}>仅查看</option><option value="edit" ${draft.permission === 'edit' ? 'selected' : ''}>可编辑</option></select></label>
      ${!locked ? `<button id="delivery-save" class="button secondary" data-act="delivery-save" ${!draft.title?.trim() || !draft.content?.trim() || f.status !== 'connected' ? 'disabled' : ''}>${d.dirty ? '保存待发送草稿' : '保存本版草稿，继续核对'}</button><label class="check-row"><input id="delivery-confirmed" type="checkbox" ${d.confirmed ? 'checked' : ''} ${deliveryCanConfirm(d) ? '' : 'disabled'}><span>我已核对正文、${selected.length}位收件人与${draft.permission === 'view' ? '查看' : '编辑'}权限，同意发送本版本</span></label><button id="delivery-send" class="button primary" data-act="delivery-confirm" ${deliveryCanConfirm(d) && d.confirmed ? '' : 'disabled'}>确认发送</button><p class="meta">修改正文、收件人、权限或绑定账号后，需保存并重新核对。</p>` : ''}` : ''}
      ${d.opId ? `<button class="button secondary" data-act="delivery-status" ${d.busy ? 'disabled' : ''}>查询原操作结果</button><p class="meta">操作记录：${esc(d.opId)}。查询不会重新发送。</p>` : ''}
      ${d.data?.delivery ? `<section class="card"><h3>交付回执</h3><p>${esc(d.data.delivery.message || statuses[d.data.delivery.status] || '服务器已记录本次交付结果。')}</p></section>` : ''}
      ${d.data?.delivery?.status === 'sent' && /^https:\/\/[^/]+\.(feishu\.cn|larksuite\.com)\/docx\//i.test(d.data.delivery.doc_url || '') ? '<button class="button secondary" data-act="delivery-doc">在飞书查看已发送纪要</button>' : ''}
      ${d.data?.receipt ? `<section class="card"><h3>交付回执</h3><p>${esc(d.data.receipt.message || '服务器已记录本次交付结果。')}</p></section>` : ''}
      ${!d.opId || deliveryBlocked(d) ? `<button class="button quiet" data-act="delivery-reload" ${d.busy ? 'disabled' : ''}>重新读取当前草稿</button>` : ''}`);
  }

  // ---- read-only AI minutes: query stored results, never generate or send --------------------

  let minutesReadyTimer = null, minutesReadyCount = 0, minutesReadyLastAt = 0;
  const minutesSync = window.OopsMinutesSync?.create({
    send,
    listPayload: () => ({ includeEmpty: S.historyShowEmpty }),
    isBusy: sid => S.minutes.get(sid)?.loading && Date.now() - (S.minutes.get(sid).startedAt || 0) < 25000,
    onStart(sid, requestId) {
      const old = S.minutes.get(sid);
      S.minutes.set(sid, { ...old, requestId, automatic: true, loading: !old?.data, startedAt: Date.now() });
    },
    onList(p) {
      if (typeof p.include_empty === 'boolean' && p.include_empty !== S.historyShowEmpty) return false;
      if (!acceptRead('history.list', p, expireHistoryList)) return false;
      const next = p.items.filter(r => !S.deletedSessions.has(r.session_id));
      const metaKey = m => JSON.stringify([m?.hidden_empty_count, m?.unreadable_count, m?.unreadable_operations_count, m?.include_empty]);
      const changed = JSON.stringify(next) !== JSON.stringify(S.historyItems) || metaKey(p) !== metaKey(S.historyMeta)
        || S.requests.history.loading || S.requests.history.error;
      S.historyItems = next; S.historyMeta = p;
      // A fresh foreground sync satisfies an overlapping page read too.
      if (readFinal(p)) { clearTimeout(S.historyTimer); S.historyTimer = null; S.requests.history = {}; }
      if (changed && !S.sheet && ['home', 'sessions', 'memory'].includes(S.route.name)
          && !document.activeElement?.matches('input,textarea')) {
        const top = $('scroll').scrollTop; render(); $('scroll').scrollTop = top;
      } else patchMinutesUi();
    },
    onResult: p => onMinutes(p),
    onListFailure(p) {
      if (invalidateReadSource(p || {})) return;
      if (!readValid('history.list')) { S.historyItems = null; S.historyMeta = null; }
      S.requests.history = { ...S.requests.history, error: p?.message || '会议列表尚未更新，将自动重试。' };
      for (const [sid, old] of S.minutes) if (!readValid(`minutes:${sid}`)) S.minutes.set(sid, { requestId: old.requestId, error: '暂未同步成功，将自动重试。', automatic: true });
      if (!S.sheet && ['home', 'sessions', 'memory'].includes(S.route.name)) render(); else patchMinutesUi();
    },
    onFailure(sid, message, detail) {
      if (invalidateReadSource({...detail,sessionId:sid,message})) return;
      const old = S.minutes.get(sid);
      S.minutes.set(sid, { ...(readValid(`minutes:${sid}`) ? old : {}), requestId: old?.requestId, error: message, loading: false, automatic: true });
      patchMinutesUi(sid);
    },
    onRemove(sid) { forgetReadLease(`minutes:${sid}`); S.minutes.delete(sid); patchMinutesUi(sid); },
    onInvalidate(sid) { forgetReadLease(`minutes:${sid}`); S.minutes.delete(sid); patchMinutesUi(sid); },
    onReady() {
      minutesReadyCount++;
      clearTimeout(minutesReadyTimer);
      minutesReadyTimer = setTimeout(() => {
        if (!document.hidden && Date.now() - minutesReadyLastAt > 30000) {
          toast(`${minutesReadyCount}份会后结果已同步，可在会话中查看`);
          minutesReadyLastAt = Date.now();
        }
        minutesReadyCount = 0;
      }, 1500);
    },
  });
  function resumeMinutesSync() {
    if (!document.hidden && navigator.onLine !== false && S.state.backend && S.state.backend !== 'mock') minutesSync?.start();
    else minutesSync?.pause();
  }
  function pauseMinutesSync() {
    minutesSync?.pause(); expireReadLeases();
    clearTimeout(minutesReadyTimer); minutesReadyCount = 0;
    patchMinutesUi();
  }
  function minutesBadge(m) {
    if (!m.ended_at || Number(m.utterance_count) < 5 || m.transcript_status === 'expired') return '';
    const p = S.minutes.get(m.session_id), status = p?.data?.status;
    const label = p?.error ? '纪要尚未更新' : status === 'ready' ? readCached(p.data) ? '本机纪要 · 核对中' : '纪要已同步' : status === 'pending' ? '整理中' : status === 'unavailable' ? '暂无当前纪要' : '纪要自动同步';
    return `<span class="badge gray" data-minutes-status="${esc(m.session_id)}">${label}</span>`;
  }
  function patchMinutesUi(sid) {
    document.querySelectorAll('[data-minutes-status]').forEach(el => {
      const row = S.historyItems?.find(r => r.session_id === el.dataset.minutesStatus);
      if (row) el.outerHTML = minutesBadge(row);
    });
    if (S.route.name === 'meeting' && S.history && (!sid || S.history.session_id === sid)) {
      const box = document.querySelector('.native-minutes');
      if (box) box.outerHTML = minutesHtml(S.history.session_id);
      if (S.sheet?.kind === 'minutesSource' && S.minutes.get(S.history.session_id)?.data?.status !== 'ready') closeSheet();
    }
  }

  function requestMinutes(sessionId) {
    const requestId = `minutes-${++S.minutesRequest}`;
    const old = S.minutes.get(sessionId);
    S.minutes.set(sessionId, { ...(readValid(`minutes:${sessionId}`) ? old : {}), loading: true, error: null, requestId, startedAt: Date.now() });
    send('history.minutes', { sessionId, requestId });
  }
  function onMinutes(p) {
    const current = S.minutes.get(p.session_id);
    if (!current || p.requestId !== current.requestId) return false;
    if (!acceptRead(`minutes:${p.session_id}`, p, () => expireMinutes(p.session_id), () => { if (S.route.name === 'meeting' && S.history?.session_id === p.session_id && !S.minutes.get(p.session_id)?.loading) requestMinutes(p.session_id); })) return false;
    S.minutes.set(p.session_id, { requestId: current.requestId, startedAt: current.startedAt, automatic: current.automatic, loading: !readFinal(p), data: p });
    if (readFinal(p)) minutesSync?.observe(p);
    patchMinutesUi(p.session_id);
    return true;
  }
  function refreshMinutesAfterReview(sessionId) {
    if (S.sheet?.kind === 'minutesSource' && S.sheet.sessionId === sessionId) closeSheet();
    const d = S.deliveries.get(sessionId); if (d) { d.confirmed = false; if (!d.opId) d.status = 'source_changed'; }
    requestMinutes(sessionId);
    if (S.route.name === 'meeting' && S.history?.session_id === sessionId) render();
  }
  function minutesHtml(sessionId) {
    const entry = S.minutes.get(sessionId), p = entry?.data;
    const refresh = `<button class="text-action" type="button" data-act="minutes-refresh">${entry?.loading ? '正在查询…' : '重新查询'}</button>`;
    let body;
    if (entry?.loading && !p) body = '<p class="meta" role="status">正在读取已保存的 AI 纪要…</p>';
    else if (entry?.error && !p) body = `<p class="error-text">${esc(entry.error)}</p><p class="meta">${entry.automatic ? '会自动重试，也可点重新查询。' : '查询失败，未展示旧正文。可以重新查询。'}</p>`;
    else if (!p) body = '<p class="meta">会后结果会自动同步到这里。</p>';
    else if (p.status === 'ready' && p.minutes && typeof p.minutes === 'object') {
      const m = p.minutes;
      const source = (ids) => (Array.isArray(ids) ? ids : []).filter(id => p.sources?.[id]).map(id => `<button class="chip" type="button" data-act="minutes-source" data-id="${esc(id)}">查看原话 ${hms(p.sources[id].start_ms)}</button>`).join('');
      const rows = (title, items, content, ids) => Array.isArray(items) && items.length ? `<h3>${title}</h3>${items.map(item => `<div class="minutes-item"><p>${esc(content(item))}</p>${source(ids(item))}</div>`).join('')}` : '';
      // Like real minutes: the topic, the main-line work, decisions, then everything else. Older minutes have no
      // priority; their tasks all count as main line.
      const actions = Array.isArray(m.actions) ? m.actions : [];
      const main = actions.filter((x) => (x.priority || 'main') === 'main'), other = actions.filter((x) => x.priority === 'other');
      const task = (x) => `${x.owner ? `${x.owner}：` : ''}${x.task || ''}${x.due ? `（${x.due}）` : ''}${x.owner ? '' : '（负责人待定）'}`;
      const itemsLead = S.history?.session_id === sessionId && Array.isArray(S.history.items) && S.history.items.length;
      body = `${m.theme ? `<p class="minutes-theme"><small>会议主题</small><strong>${esc(m.theme)}</strong></p>` : ''}
        ${m.overview ? `<p class="minutes-overview">${esc(m.overview)}</p>` : ''}
        ${itemsLead ? '<p class="meta">待办、决定和还没定的事已整理在上方「会后事项」里核对。</p>' : `${rows('主线任务', main, task, x => x.ids)}
        ${rows('决定', m.decisions, x => x.text, x => x.ids)}
        ${rows('其他事项', other, task, x => x.ids)}`}
        ${rows('讨论要点', m.topics, x => `${x.topic || ''}：${Array.isArray(x.points) ? x.points.join('；') : x.points || ''}`, () => [])}
        ${itemsLead ? '' : rows('待确认问题', m.open_questions, x => x.question, x => [x.id])}
        ${rows('后续跟进建议', m.follow_ups, x => `${x.title || ''}${x.start ? ' · ' + x.start : ''}`, () => [])}
        ${m.substantive === false ? '<p class="meta">这场对话没有需要整理的实质内容。</p>' : ''}
        <button class="button secondary" type="button" data-act="delivery-open"><span>核对并发送飞书纪要</span></button>
        ${p.doc_url ? `<button class="button secondary" type="button" data-act="minutes-doc"><span>查看飞书纪要文档</span></button>` : ''}`;
    } else if (p.status === 'pending') {
      body = `<p>${p.reason === 'in_progress' ? '会议仍在进行，AI 纪要尚未整理。' : '会后纪要正在整理，完成后会自动同步到这里。'}</p><p class="meta">也可继续使用App，稍后会提示结果已同步。</p>`;
    } else {
      const messages = { source_changed: '来源已经变化，旧版纪要不能作为当前结果继续使用。', bot_off: '服务器尚未启用纪要机器人。', before_bot: '这场会议早于纪要机器人启用，暂无 AI 纪要。', no_end: '会议结束状态尚不明确，暂无 AI 纪要。', failed: '服务暂时没有生成可用纪要。', unsupported: '当前服务尚未提供 AI 纪要。', mock: '浏览器仅展示流程，不生成真实 AI 纪要。' };
      body = `<p>${esc(p.message || messages[p.reason] || '当前没有可用的 AI 纪要。')}</p>${p.reason === 'source_changed' ? '<p class="meta">请以最新原文和人工核对结果为准；旧文档仅供查看历史。</p>' : ''}
        ${p.reason === 'source_changed' && p.historical_doc_url ? `<button class="button quiet" type="button" data-act="minutes-history-doc"><span>查看旧版历史文档</span></button>` : ''}`;
    }
    const notice = p && (entry?.error ? `<p class="warn-text">${esc(entry.error)} · 暂显示上次内容，尚未更新。</p>` : entry?.loading || readCached(p) ? '<p class="meta" role="status">先显示本机内容，正在核对是否有更新…</p>' : '');
    return `<section class="card native-minutes"><div class="section-title"><h2>会议纪要</h2>${entry?.loading ? '<span class="meta">读取中</span>' : refresh}</div>${notice}${body}</section>`;
  }
  function minutesSourceHtml() {
    const p = S.minutes.get(S.sheet.sessionId)?.data;
    const source = p?.status === 'ready' && p.sources?.[S.sheet.id];
    return frame('纪要引用的原话', source ? `<p class="meta">${hms(source.start_ms)} · ${esc(manualLabel(source.speaker) || '说话人待确认')}</p><section class="card evidence-card"><p>“${esc(source.text)}”</p></section>` : '<p>来源已经更新，请返回重新查询当前纪要。</p>');
  }
  function onRenamed(p) {
    if (S.history?.session_id === p.session_id) { S.history.display_title = p.title; S.history.title_source = p.title_source; }
    const item = (S.historyItems || []).find((i) => i.session_id === p.session_id);
    if (item) { item.title = p.title; item.title_source = p.title_source; }
    closeSheet();
    render();
    toast(p.title_source === 'manual' ? '已改名' : '已恢复自动名称');
  }
  function renameHtml() {
    const h = S.history, source = { manual: '手动命名', agenda: '议程目标', minutes: '纪要主题', generated: 'AI 概括', auto: '按原话自动取', short: '内容较少', none: '' }[h.title_source] || '';
    return frame('会议名称', `<label class="form-field"><span>会议名称（留空恢复自动名称）</span><input id="rename-input" maxlength="40" value="${esc(h.title_source === 'manual' ? h.display_title : '')}" placeholder="${esc(h.display_title || '例如：安卓版本排期')}"><small>现在的名称：${esc(meetingName(h))}${source ? ` · ${source}` : ''}</small></label>
      <button class="button primary" type="button" data-act="rename-save"><span>保存名称</span></button>`);
  }
  function toolsHtml() {
    const live = S.sheet.live;
    const deletion = S.pendingDelete?.sessionId === S.history?.session_id ? S.pendingDelete : null;
    const rows = live ? [
      listRow({ act: 'commitments-open', ic: 'check-circle', title: '本场纪要', sub: '决定、待办、约束与想法' }),
      listRow({ act: 'agenda-open', ic: 'list-checks', title: '议程与时间' }),
      listRow({ act: 'live-project', ic: 'folder-simple', title: '所属项目', sub: S.liveProject || '未归项目' }),
      listRow({ act: 'notices-open', ic: 'bell', title: '全部会议提醒' }),
      listRow({ act: 'ask-open', ic: 'magnifying-glass', title: '问本场' }),
      listRow({ act: 'saved-list', ic: 'bookmark-simple', title: '已保存片段' }),
    ] : [
      listRow({ act: 'delivery-open', ic: 'share-network', title: '核对并发送飞书纪要', sub: '先核对内容、收件人与文档权限' }),
      listRow({ act: 'rename-open', ic: 'pencil-simple', title: '名称', sub: meetingName(S.history || {}) }),
      listRow({ act: 'history-project', ic: 'folder-simple', title: '所属项目', sub: S.history?.project || '未归项目' }),
      listRow({ act: 'review-start', data: `data-id="${esc(S.history?.session_id || '')}"`, ic: 'check-circle', title: '会后核对', sub: `${(S.history?.review_queue || []).length}项待核对` }),
      listRow({ act: 'meeting-notices', ic: 'bell', title: '会议提醒' }),
      listRow({ act: 'history-delete-prompt', ic: 'trash', title: '删除这场会议', sub: '团队成员将无法再查看，录音一并删除' }),
    ];
    return frame(live ? '本次会话工具' : '会议工具', `${rows.join('')}
      ${S.sheet.deleteConfirm ? `<p class="meta">团队成员将无法再查看这场会议，原始录音一并删除。确认删除？</p>${deletion?.error ? `<p class="error-text">${esc(deletion.error)}</p>` : ''}<button class="button danger" type="button" data-act="history-delete-confirm" ${deletion?.status === 'saving' ? 'disabled' : ''}><span>${deletion?.status === 'saving' ? '正在删除…' : '确认删除'}</span></button>` : ''}`);
  }
  function selfPickHtml() {
    return frame('选择本人', `<p class="meta">${usesPersonalTaskIdentity() ? '用于本机显示；我的任务按本人绑定的飞书账号核对，选名不会切换账号。' : '用于“我的任务”和首页的待处理。'}</p>
      <div class="inline-actions">${S.team.map((n) => `<button class="chip ${n === S.state.selfName ? 'selected' : ''}" data-act="self-set" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      ${S.state.selfName ? '<button class="button quiet" type="button" data-act="self-set" data-name=""><span>不指定本人</span></button>' : ''}`);
  }

  // ---- who said it ------------------------------------------------------------------------

  function openSpeakerPick(pick) {
    openSheet({ kind: 'speaker', ...pick });
  }
  function speakerPickHtml() {
    const p = S.sheet;
    const options = [...S.team.map((n) => [n, n]), ...Object.entries(MANUAL_OTHER)];
    return frame('这句是谁说的', `<section class="card evidence-card"><button class="play-mini" data-act="speaker-play" data-key="spk-${esc(p.id)}" aria-label="回听原声">${icon('play', 16)}</button><p>“${esc(p.text)}”</p></section>
      <p class="meta">模型判断：${esc(speakerLabel(p.model) || '未识别')}${p.current ? ` · 已改为 ${esc(manualLabel(p.current))}` : ''}</p>
      <div class="inline-actions">${options.map(([v, label]) => `<button class="chip ${v === p.current ? 'selected' : ''}" data-act="speaker-set" data-name="${esc(v)}">${esc(label)}</button>`).join('')}</div>
      ${p.current ? '<button class="button quiet" type="button" data-act="speaker-undo"><span>撤销修改，恢复模型结果</span></button>' : ''}
      <p class="meta">改动存到团队服务器，任务草稿会改用你选的人来建议负责人（仍需确认）。</p>`);
  }
  function setSpeakerFromPick(value) {
    const p = S.sheet;
    send('speaker.correct', { sessionId: p.sessionId, utteranceId: p.id, speaker: value });
    closeSheet();
  }
  function onSpeakerCorrected(p) {
    invalidateDraftEvidence(p.sessionId, p.utteranceId);
    if (p.sessionId === S.state.sessionId) {
      const u = S.records.get(p.utteranceId);
      if (u) { u.manualSpeaker = p.speaker; renderLine(p.utteranceId); renderLiveRecent(); }
    }
    if (p.status === 'saved' && S.history?.session_id === p.sessionId) {
      const u = (S.history.utterances || []).find((x) => x.id === p.utteranceId);
      if (u) {
        u.review = { ...(u.review || {}), speaker: p.speaker };
        if (p.speaker == null) delete u.review.speaker;
      }
      S.history.review_queue = (S.history.review_queue || []).filter(item => item.id !== p.utteranceId || item.kind !== 'speaker');
      if (u && p.speaker == null && !u.speaker && [...String(u.text || '').replace(/[^\p{L}\p{N}]/gu, '')].length >= 4) {
        S.history.review_queue.push({ kind: 'speaker', id: p.utteranceId });
      }
      if (S.route.name === 'meeting' && S.meetingTab === 'transcript') render();
    }
    if (p.status === 'saved') toast(p.speaker == null ? '已恢复模型结果' : `已改为 ${manualLabel(p.speaker)}`);
    if (p.status === 'saved') {
      refreshMinutesAfterReview(p.sessionId);
      finishReviewSave(p, 'speaker.correct');
    } else if (reviewSaveMatches(p, 'speaker.correct')) {
      S.review.pending.localOnly = true;
      if (S.sheet?.kind === 'review') renderSheet();
    }
  }

  // ---- after the meeting: one sentence at a time ----------------------------------------------

  const REVIEW_KIND = { commitment: '待办', decision: '决定', speaker: '说话人' };
  function startReview(row, itemId) {
    // With minutes, people check things to do / decided / still open — not sentences.
    if (Array.isArray(row.items)) return startItemReview(row, itemId);
    if (S.review?.sessionId === row.session_id && S.review.pending) return openSheet({ kind: 'review' });
    S.review = { sessionId: row.session_id, items: row.review_queue || [], i: 0, done: new Set(), ownerStep: false };
    openSheet({ kind: 'review' });
  }
  function reviewHtml() {
    const r = S.review, row = S.history;
    if (r.i >= r.items.length) {
      return frame('会后核对', `<div class="empty-state">${emptyArt(r.items.length ? 'cheer' : 'happy', 'check-circle')}<strong>${r.items.length ? '核对完了' : '没有需要核对的内容'}</strong>
        <p>已核对 ${r.done.size} 条${r.items.length - r.done.size ? `，跳过 ${r.items.length - r.done.size} 条（下次打开还会出现）` : ''}。</p></div>
        <button class="button primary" type="button" data-act="review-finish"><span>回到会议</span></button>`);
    }
    const item = r.items[r.i], at = row.utterances.findIndex((u) => u.id === item.id), u = row.utterances[at];
    const before = row.utterances.slice(Math.max(0, at - 2), at);
    const who = (x) => x.review?.speaker ? `${manualLabel(x.review.speaker)} · 已改` : speakerLabel(x.speaker) || '未识别';
    const live = r.sessionId === S.state.sessionId;
    const saving = r.pending?.status === 'saving';
    const selected = r.pending?.payload;
    let answer;
    if (item.kind === 'speaker') {
      answer = `${sectionTitle('这句是谁说的？')}<div class="inline-actions">${[...S.team.map((n) => [n, n]), ...Object.entries(MANUAL_OTHER)]
        .map(([v, label]) => `<button class="chip" data-act="review-speaker" data-name="${esc(v)}">${esc(label)}</button>`).join('')}</div>`;
    } else if (item.kind === 'commitment' && r.ownerStep) {
      const hint = u.owner_hint;
      answer = `${sectionTitle('谁负责？')}<div class="inline-actions">${S.team.map((n) => `<button class="chip ${n === hint ? 'selected' : ''}" data-act="review-owner" data-name="${esc(n)}">${esc(n)}</button>`).join('')}
        <button class="chip" data-act="review-owner" data-name="">不确定</button></div>${live ? '<p class="meta">选完负责人后可以在本场纪要里建飞书任务。</p>' : ''}`;
    } else {
      const [yes, no] = item.kind === 'commitment' ? ['是待办', '不是待办'] : ['是决定', '不是决定'];
      answer = `${item.kind === 'commitment' ? `<p class="meta">${esc(u.owner_hint ? '原话里的负责人：' + u.owner_hint : '负责人待定')} · ${esc(u.when_raw || '截止待定')}</p>` : ''}
        <div class="action-grid"><button class="button secondary" type="button" data-act="review-verdict" data-value="rejected"><span>${no}</span></button><button class="button primary" type="button" data-act="review-verdict" data-value="confirmed"><span>${yes}</span></button></div>`;
    }
    const saveState = r.pending ? `<section class="review-save-state" role="status"><p class="${r.pending.error ? 'error-text' : 'meta'}">${esc(r.pending.error || (r.pending.localOnly ? '本机显示已修改，正在等待服务器保存…' : '正在保存本条核对…'))}</p>
      <p class="meta">本次选择：${esc(selected?.speaker ? manualLabel(selected.speaker) : selected?.fields?.owner || (selected?.fields?.verdict === 'rejected' ? '不是' + REVIEW_KIND[item.kind] : selected?.fields?.verdict === 'confirmed' ? '是' + REVIEW_KIND[item.kind] + ' · 负责人待定' : '待确认'))}</p>
      ${r.pending.error ? '<button class="button primary" type="button" data-act="review-retry"><span>重试保存本条</span></button><p class="meta">尚未计入已核对；也可以重新选择或稍后再处理。</p>' : ''}</section>` : '';
    return frame(`会后核对 · ${r.i + 1} / ${r.items.length}`, `<div class="inline-actions"><span class="badge purple">${REVIEW_KIND[item.kind]}</span><span class="meta">${hms(u.start_ms)} · ${esc(who(u))}</span></div>
      ${before.map((x) => `<p class="meta review-context">${esc(who(x))}：${esc(x.text)}</p>`).join('')}
      <section class="card evidence-card"><button class="play-mini" data-act="review-play" data-key="rv-${esc(u.id)}" aria-label="回听原声">${icon('play', 16)}</button><p>“${esc(u.text)}”</p></section>
      <fieldset class="review-answer" ${saving ? 'disabled' : ''}>${answer}</fieldset>${saveState}
      <div class="inline-actions review-nav"><button class="chip" data-act="review-prev" ${r.i && !saving ? '' : 'disabled'}>上一条</button><button class="chip" data-act="review-skip" ${saving ? 'disabled' : ''}>跳过</button></div>
      <p class="meta">核对结果存到团队服务器；界面显示了模型的判断，所以这些结果只用于改进，不作为验收标准。</p>`);
  }
  function reviewCurrent() {
    const r = S.review, item = r.items[r.i];
    return { r, item, u: S.history.utterances.find((x) => x.id === item.id) };
  }
  function reviewNext(answered = true) {
    const r = S.review;
    if (r.pending?.status === 'saving') return;
    if (answered) r.done.add(r.i);
    r.i += 1; r.ownerStep = false; r.pending = null;
    if (S.sheet?.kind === 'review') renderSheet();
  }
  function saveReview(type, payload) {
    const r = S.review;
    if (r.pending?.status === 'saving') return;
    r.pending = { type, payload, status: 'saving', index: r.i };
    if (S.sheet?.kind === 'review') renderSheet();
    send(type, payload);
  }
  function reviewSaveMatches(p, type) {
    const pending = S.review?.pending;
    return pending?.type === type && pending.payload.sessionId === p.sessionId && pending.payload.utteranceId === p.utteranceId;
  }
  function finishReviewSave(p, type) {
    if (!reviewSaveMatches(p, type)) return;
    const r = S.review;
    r.pending = null;
    reviewNext();
    // The server is authoritative for the remaining queue and derived results.
    loadHistory();
  }
  function reviewVerdict(verdict) {
    const { r, item, u } = reviewCurrent();
    if (r.pending?.status === 'saving') return;
    if (item.kind === 'commitment' && verdict === 'confirmed') { r.pending = null; r.ownerStep = true; return renderSheet(); }
    saveReview('review.set', { sessionId: r.sessionId, utteranceId: u.id, fields: { verdict } });
  }
  function reviewOwner(owner) {
    const { r, u } = reviewCurrent();
    saveReview('review.set', { sessionId: r.sessionId, utteranceId: u.id, fields: { verdict: 'confirmed', owner: owner || null } });
  }
  function onReviewSaved(p) {
    invalidateDraftEvidence(p.sessionId, p.utteranceId);
    if (S.history?.session_id !== p.sessionId) return;
    const u = (S.history.utterances || []).find((x) => x.id === p.utteranceId);
    if (u) u.review = p.review || undefined;
    Object.values(S.history.digest || {}).forEach(rows => (rows || []).filter(x => x.id === p.utteranceId).forEach(x => { x.review = p.review || undefined; }));
    if (p.review?.verdict) S.history.review_queue = (S.history.review_queue || []).filter(item => item.id !== p.utteranceId || item.kind === 'speaker');
    refreshMinutesAfterReview(p.sessionId);
    finishReviewSave(p, 'review.set');
  }

  // ---- after the meeting: one item at a time (from the minutes) --------------------------------

  const ITEM_KIND = { task: ['待办', 'purple'], decision: ['决定', 'green'], open: ['待定', 'amber'] };
  const COLLECTIVE = '大家';
  const itemState = (it) => it.stale ? 'stale' : !it.review ? 'todo' : it.review.status === 'confirmed' ? 'done' : 'out';
  const itemView = (it) => it.review?.status === 'confirmed' ? { ...it, kind: it.review.kind, title: it.review.title, due: it.review.due, owner: it.review.owner } : { ...it, owner: '' };
  function startItemReview(row, itemId) {
    const items = row.items || [], todo = items.filter((it) => itemState(it) === 'todo');
    const first = itemId ? items.findIndex((it) => it.id === itemId) : items.indexOf(todo[0]);
    S.itemReview = { sessionId: row.session_id, i: Math.max(0, first), done: new Set(), editing: false, owner: {}, draft: null, pending: null };
    openSheet({ kind: 'items' });
  }
  function itemReviewHtml() {
    const r = S.itemReview, row = S.history, items = row?.items || [];
    const left = items.filter((it) => itemState(it) === 'todo').length;
    const it = items[r.i];
    if (!it) return frame('会后核对', `<div class="empty-state">${emptyArt(items.length ? 'cheer' : 'sleepy', 'check-circle')}<strong>${items.length ? '这场会的事项都看完了' : '纪要里没有需要核对的事项'}</strong>
      <p>本次处理 ${r.done.size} 件${left ? `，还有 ${left} 件待核对` : ''}。</p></div><button class="button primary" type="button" data-act="items-finish"><span>回到会议</span></button>`);
    const v = itemView(it), st = itemState(it), [kindLabel, tone] = ITEM_KIND[v.kind] || ['事项', 'gray'];
    const saving = r.pending?.status === 'saving';
    const quotes = (it.evidence || []).map((e) => `<section class="card evidence-card"><button class="play-mini" data-act="item-play" data-id="${esc(e.id)}" aria-label="回听原声">${icon(S.playingKey === 'it-' + e.id ? 'stop' : 'play', 16)}</button><p><span class="meta">${hms(e.start_ms)} · ${esc(e.speaker ? speakerLabel(e.speaker) || e.speaker : '说话人未识别')}</span><br>“${esc(e.text)}”</p></section>`).join('');
    const ownerChips = (selected) => `${sectionTitle('谁负责？')}<div class="inline-actions">${[...S.team, COLLECTIVE].map((n) => `<button class="chip ${n === selected ? 'selected' : ''}" type="button" data-act="item-owner" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      ${it.owner_hint && st === 'todo' ? `<p class="meta">原话里有人认领：${esc(it.owner_hint)}（请听原话确认，不会自动选上）</p>` : ''}`;
    let body;
    if (r.editing) {
      const d = r.draft;
      body = `<label class="form-field"><span>类别</span><select id="item-kind">${Object.entries(ITEM_KIND).map(([k, [label]]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="form-field"><span>一句话说清这件事</span><input id="item-title" maxlength="120" value="${esc(d.title)}"></label>
        <label class="form-field"><span>截止（原话提到才填）</span><input id="item-due" maxlength="40" value="${esc(d.due)}"></label>
        ${d.kind === 'task' ? ownerChips(d.owner) : ''}
        <div class="action-grid"><button class="button secondary" type="button" data-act="item-edit-cancel"><span>取消</span></button><button class="button primary" type="button" data-act="item-save"><span>保存并确认</span></button></div>`;
    } else if (st === 'stale') {
      body = '<p class="meta">纪要依据的原话已经变化，这条旧事项只能查看，不能再确认。</p>';
    } else if (st === 'todo') {
      const others = items.filter((x) => x.id !== it.id && itemState(x) !== 'out' && !x.stale);
      body = `${v.kind === 'task' ? ownerChips(r.owner[it.id] || '') : ''}
        <div class="action-grid"><button class="button secondary" type="button" data-act="item-reject"><span>不是事项</span></button><button class="button primary" type="button" data-act="item-confirm"><span>确认这件事</span></button></div>
        <div class="inline-actions"><button class="chip" type="button" data-act="item-edit">改写</button>${others.length ? `<select id="item-merge" class="chip" aria-label="和另一件是同一件事"><option value="">和另一件重复…</option>${others.map((x) => `<option value="${esc(x.id)}">${esc(itemView(x).title.slice(0, 24))}</option>`).join('')}</select>` : ''}</div>`;
    } else if (st === 'done') {
      body = `<p class="confirmed-line"><span class="badge green">已确认</span> ${v.kind === 'task' && v.owner ? `负责人 ${esc(v.owner)}` : ''}${it.review.edited ? ' · 已改写' : ''}</p>
        <div class="inline-actions"><button class="chip" type="button" data-act="item-edit">改写</button><button class="chip" type="button" data-act="item-reopen">撤回确认</button></div>
        ${v.kind === 'task' ? '<button class="button primary" type="button" data-act="item-raft-open">派给 a1234 / 查看执行结果</button>' : ''}
        ${v.kind === 'task' ? it.task_status === 'created' ? '<p class="meta">已建飞书任务，可到任务页查看。</p>' : `<button class="button primary" type="button" data-act="item-task-draft" data-id="${esc(it.id)}">整理成飞书任务</button><p class="meta">使用本次已确认内容，不重新调用模型；核对后才创建。</p>` : ''}`;
    } else {
      const into = items.find((x) => x.id === it.review.into);
      body = `<p class="meta">${it.review.status === 'merged' ? `已合并到「${esc(into ? itemView(into).title : '另一件事项')}」` : '已标为不是事项'}</p><button class="chip" type="button" data-act="item-reopen">重新核对</button>`;
    }
    const saveState = r.pending ? `<section class="review-save-state" role="status"><p class="${r.pending.error ? 'error-text' : 'meta'}">${esc(r.pending.error || '正在保存…')}</p>
      ${r.pending.error ? '<button class="button primary" type="button" data-act="item-retry"><span>重试保存</span></button>' : ''}</section>` : '';
    return frame(`会后核对 · ${r.i + 1} / ${items.length}`, `<div class="inline-actions"><span class="badge ${tone}">${kindLabel}</span>${st !== 'todo' && st !== 'stale' ? '' : `<span class="meta">还有 ${left} 件待核对</span>`}</div>
      ${r.editing ? '' : `<h3 class="item-title">${esc(v.title)}</h3>${it.detail ? `<p class="meta">${esc(it.detail)}</p>` : ''}${v.due ? `<p class="meta">截止：${esc(v.due)}</p>` : ''}`}
      <fieldset class="review-answer" ${saving ? 'disabled' : ''}>${body}</fieldset>${saveState}
      ${sectionTitle(`依据原话 · ${(it.evidence || []).length} 句`)}${quotes}
      <div class="inline-actions review-nav"><button class="chip" data-act="item-prev" ${r.i && !saving ? '' : 'disabled'}>上一件</button><button class="chip" data-act="item-next" ${saving ? 'disabled' : ''}>${st === 'todo' ? '跳过' : '下一件'}</button></div>
      <p class="meta">AI 根据整场会整理；确认后才算数。负责人由你来选。</p>`);
  }
  function startItemTask(item, fromTasks = false) {
    if (S.itemTaskRequest?.status === 'loading') return;
    const view = item && itemView(item);
    const sessionId = fromTasks ? candidateSession(item) : S.history?.session_id;
    if (!item || !sessionId || S.deletedSessions.has(sessionId) || item.stale || item.task_status === 'created' || item.linked_created
      || fromTasks && (!candidateCurrent(item) || item.source !== 'meeting_review')
      || !fromTasks && (itemState(item) !== 'done' || view.kind !== 'task') || !item.fingerprint) return;
    const requestId = `item-task-${++S.itemTaskSerial}`;
    const payload = {sessionId, itemId: fromTasks ? item.item_id : item.id, fingerprint:item.fingerprint, requestId};
    if (!payload.itemId) return;
    S.itemTaskRequest = {payload, title:item.title || view.title, status:'loading'};
    openSheet({kind:'itemTaskPending'});
    sendItemTaskRequest();
  }
  function sendItemTaskRequest() {
    const request = S.itemTaskRequest;
    if (!request || request.status !== 'loading') return;
    send('items.task.draft', request.payload);
    setTimeout(() => {
      if (S.itemTaskRequest !== request || request.status !== 'loading') return;
      request.status = 'failed'; request.error = '暂未收到草稿回执，可以重新读取；尚未创建飞书任务。';
      if (S.sheet?.kind === 'itemTaskPending') renderSheet();
    }, 20000);
  }
  function itemTaskPendingHtml() {
    const request = S.itemTaskRequest;
    return frame('整理成飞书任务', `${request?.status === 'loading' ? spinnerHtml('正在读取已确认事项…', '复用人工确认内容，不重新调用模型') : `<p class="error-text">${esc(request?.error || '读取未完成')}</p><button class="button primary" data-act="${request?.status === 'stale' ? 'item-task-reopen' : 'item-task-retry'}">${request?.status === 'stale' ? '重新打开当前事项' : '重试读取草稿'}</button>`}<p class="meta">确认创建前不会写入飞书。</p><button class="button quiet" data-act="close">取消</button>`);
  }
  function onItemTaskDraft(data) {
    const request = S.itemTaskRequest, payload = request?.payload;
    if (!payload || data.requestId !== payload.requestId || (data.sessionId || data.session_id) !== payload.sessionId
      || data.sourceItemId !== payload.itemId || S.sheet?.kind !== 'itemTaskPending' || S.deletedSessions.has(payload.sessionId)) return;
    S.itemTaskRequest = null;
    openDraft(data);
  }
  function itemCurrent() { const r = S.itemReview; return { r, it: (S.history?.items || [])[r.i] }; }
  function itemMove(step) {
    const r = S.itemReview;
    if (r.pending?.status === 'saving') return;
    r.i = Math.max(0, r.i + step); r.editing = false; r.draft = null; r.pending = null;
    if (S.sheet?.kind === 'items') renderSheet();
  }
  function itemSend(action, extra = {}) {
    const { r, it } = itemCurrent();
    if (!it || r.pending?.status === 'saving') return;
    const payload = { sessionId: r.sessionId, itemId: it.id, fingerprint: it.fingerprint, action, ...extra };
    r.pending = { status: 'saving', itemId: it.id, payload, advance: itemState(it) === 'todo' && action !== 'reopen' };
    if (S.sheet?.kind === 'items') renderSheet();
    send('items.review', payload);
  }
  function onItemsSaved(p) {
    const r = S.itemReview;
    if (S.history?.session_id !== p.sessionId || !Array.isArray(p.items)) return;
    S.history.items = p.items; S.history.review_queue = p.review_queue || [];
    if (S.draft?.data?.sourceItemId && S.draft.sourceSessionId === p.sessionId && !S.draft.submitted) {
      S.draft.data.sourceError = 'source_changed';
      if (S.sheet?.kind === 'draft') renderSheet();
    }
    if (r?.pending && r.pending.itemId === p.itemId && r.sessionId === p.sessionId) {
      const advance = r.pending.advance;
      r.done.add(p.itemId); r.pending = null; r.editing = false; r.draft = null;
      const at = p.items.findIndex((x) => x.id === p.itemId);
      if (at >= 0) r.i = at;
      if (advance) { const next = p.items.findIndex((x, i) => i > r.i && itemState(x) === 'todo'); r.i = next >= 0 ? next : p.items.length; }
    }
    loadHistory();
    S.projects.items = null;
    if (S.projects.open?.meetings?.some(x => x.session_id === p.sessionId)) S.projects.open = null;
    requestTasks(S.tasks.mine && canReadMyTasks(), S.tasks.status);
    if (S.sheet?.kind === 'items') renderSheet();
    if (S.route.name === 'meeting') render();
  }
  function itemsOverviewHtml(h) {
    const items = h.items || [];
    if (!items.length) return '';
    const groups = [['task', '待办'], ['decision', '决定'], ['open', '还没定的事']];
    const line = (it) => { const v = itemView(it), st = itemState(it);
      const sub = st === 'todo' ? '待核对' : st === 'stale' ? '依据已变化' : st === 'out' ? (it.review.status === 'merged' ? '已合并' : '不是事项') : v.kind === 'task' ? `负责人 ${v.owner || '未定'}${it.task_status === 'created' ? ' · 已建飞书任务' : ''}` : '已确认';
      return listRow({ act: 'item-open', data: `data-id="${esc(it.id)}"`, ic: v.kind === 'task' ? 'check-square' : v.kind === 'decision' ? 'check-circle' : 'clock', title: v.title, sub: `${sub}${v.due ? ' · ' + v.due : ''}` }); };
    const shown = items.filter((it) => itemState(it) !== 'out');
    const out = items.length - shown.length;
    return `<section class="card session-items"><div class="section-title"><h2>会后事项</h2><span class="meta">${items.filter((it) => itemState(it) === 'todo').length} 件待核对</span></div>
      ${groups.map(([k, title]) => { const list = shown.filter((it) => itemView(it).kind === k); return list.length ? `<h3>${title}</h3>${list.map(line).join('')}` : ''; }).join('')}
      ${out ? `<p class="meta">另有 ${out} 件已排除或合并。</p>` : ''}</section>`;
  }

  // ---- projects -----------------------------------------------------------------------------

  function openProjectPick(sessionId, current) {
    openSheet({ kind: 'projectPick', sessionId, current });
    loadProjects(); renderSheet();
  }
  function projectPickHtml() {
    const p = S.sheet, names = (S.projects.items || []).map((x) => x.name);
    return frame('所属项目', `<p class="meta">同一项目里确认过的决定，会用来提醒这场会里"和之前定的不一样"。</p>
      ${requestNotice(S.requests.projects, 'projects-retry', !!S.projects.items)}
      <div class="inline-actions">${names.map((n) => `<button class="chip ${n === p.current ? 'selected' : ''}" data-act="project-set" data-name="${esc(n)}">${esc(n)}</button>`).join('') || `<span class="meta">${S.projects.items == null ? S.requests.projects.error ? '可重试读取项目，或填写新项目。' : '正在读取项目…' : '还没有项目'}</span>`}</div>
      <label class="form-field"><span>新项目</span><input id="project-new" maxlength="30" placeholder="例如：安卓 App"></label>
      <button class="button primary" type="button" data-act="project-create"><span>用这个新项目</span></button>
      ${p.current ? '<button class="button quiet" type="button" data-act="project-set" data-name=""><span>移出项目</span></button>' : ''}`);
  }
  function onMeetingProject(p) {
    if (S.history?.session_id === p.session_id) S.history.project = p.project;
    if (p.session_id === S.state.sessionId) S.liveProject = p.project;
    const item = (S.historyItems || []).find((i) => i.session_id === p.session_id);
    if (item) item.project = p.project;
    S.projects.items = null;
    if (S.sheet?.kind === 'projectPick') closeSheet();
    render();
    toast(p.project ? `已归入「${p.project}」` : '已移出项目');
  }

  // ---- errors -------------------------------------------------------------------------------

  function onError(p) {
    const readError = READ_TYPES.has(p.operation) || !p.operation && ['history','minutes','projects','tasks','taskCandidates'].includes(p.scope);
    if (readError && p.requestId && readRequestGenerations.get(p.requestId) !== readGeneration) return;
    if (p.scope === 'taskCandidates') {
      const r = S.tasks.candidateRequest;
      if (!r?.pending || p.requestId !== r.requestId) return;
      clearTimeout(r.timer); r.pending = false;
      if (invalidateReadSource(p)) return;
      S.tasks.candidateError = p.message;
      if (readInvalid(p)) { forgetReadLease('tasks.candidates'); expireTaskCandidates(); }
      else if (!readValid('tasks.candidates') && !(p.unsupported && S.tasks.candidateCompat)) {
        S.tasks.parsedItems = []; S.tasks.meetingItems = [];
        S.tasks.parsedStatus = {state:p.unsupported?'unsupported':'unavailable',message:p.message,meetings:[]};
        S.tasks.refreshedAt = null;
      }
      if (['tasks','home','memory'].includes(S.route.name)) render();
      return;
    }
    if (p.scope === 'taskReview') {
      const r = S.taskReview;
      if (!r || p.requestId !== r.requestId && p.requestId !== r.recheckRequestId) return;
      if (readInvalid(p)) {
        if (p.requestId === r.requestId) { clearTimeout(r.timer); if (r.payload) r.status = 'unconfirmed'; }
        invalidateReadSource(p); return;
      }
      if (p.requestId === r.recheckRequestId) {
        clearTimeout(r.recheckTimer); r.recheckRequestId = null; r.error = p.message;
        if (readInvalid(p)) invalidateReadSource(p);
        if (S.sheet?.kind === 'taskReview') renderSheet(); return;
      }
      if (r.readInvalidated && r.payload) {
        clearTimeout(r.timer); r.status = 'unconfirmed'; r.error = p.message; r.data = null;
        if (readInvalid(p)) invalidateReadSource(p);
        if (S.sheet?.kind === 'taskReview') renderSheet(); return;
      }
      clearTimeout(r.timer); r.error = p.message; r.status = p.changed ? 'changed' : r.payload ? 'unconfirmed' : 'failed';
      if (['BAD_REQUEST','TASK_OWNER_REQUIRED'].includes(p.code) && r.data) {r.status='ready';r.payload=null;}
      if (['TASK_ACCOUNT_REQUIRED','TASK_REVIEWER_UNVERIFIED','TASK_SOURCE_FORBIDDEN','OOPS_USER_UNAUTHORIZED'].includes(p.code)) {r.status='failed';r.data=null;r.payload=null;}
      if (p.changed) { r.payload = null; requestTaskCandidates(true); }
      if (S.sheet?.kind === 'taskReview') renderSheet();
      return;
    }
    if (p.scope === 'capture') {
      S.captureError = p.message;
      render();
    }
    if (p.requestId && p.requestId === S.dailyRequest?.requestId) {
      S.dailyRequest={...S.dailyRequest,loading:false,mutation:false,error:p.message};
      if (['dailyResults','dailyConfirm'].includes(S.sheet?.kind)) renderSheet();
    }
    if (p.scope === 'items.task') {
      const r = S.itemTaskRequest;
      if (!r || p.requestId !== r.payload.requestId || p.sessionId !== r.payload.sessionId || p.itemId !== r.payload.itemId) return;
      r.status = p.sourceChanged || ['SOURCE_CHANGED','ITEM_SOURCE_CHANGED','ITEM_REVIEW_CHANGED'].includes(p.code) ? 'stale' : 'failed';
      r.error = p.message;
      if (S.sheet?.kind === 'itemTaskPending') renderSheet();
      return;
    }
    if (p.scope === 'tasks' && !currentTaskReply(p)) return;
    if (p.scope === 'tasks' && invalidateReadSource(p)) return;
    if (p.scope === 'history' && p.requestId) {
      const expected = { 'history.list': S.historyRequestId, 'history.open': S.meetingRequest?.requestId, 'history.search': S.searchRequestId, 'history.delete': S.pendingDelete?.requestId }[p.operation];
      if (p.requestId !== expected) return;
      if (p.operation === 'history.list' && !S.requests.history.loading || p.operation === 'history.open' && !S.meetingRequest?.active) return;
    }
    toast(p.message, true);
    if (p.scope === 'settings.set' && S.settingsSave && (!p.requestId || p.requestId === S.settingsSave.requestId)) {
      S.settingsSave = { ...S.settingsSave, status: 'failed', error: p.message }; updateSettingsSaveStatus();
    }
    const operation = p.operation || '';
    if (p.scope === 'history') {
      if (invalidateReadSource(p)) return;
      if (operation === 'history.delete' && S.pendingDelete?.sessionId === p.sessionId && (!p.requestId || p.requestId === S.pendingDelete.requestId)) {
        S.pendingDelete.status = 'failed'; S.pendingDelete.error = p.message;
        if (S.sheet?.kind === 'tools') renderSheet();
      } else if ((operation === 'history.open' || !operation && S.pendingMeetingId) && (!p.sessionId || p.sessionId === S.pendingMeetingId || p.sessionId === S.meetingRequest?.sessionId)) {
        clearTimeout(S.meetingRequest?.timer);
        if (S.meetingRequest) S.meetingRequest.active = false;
        if (readInvalid(p) && S.history?.session_id === p.sessionId) {
          forgetReadLease(`history.open:${p.sessionId}`); forgetReadLease(`minutes:${p.sessionId}`);
          S.history = null; S.minutes.delete(p.sessionId); S.deliveries.delete(p.sessionId);
          if (S.playingKey || S.loadingKey) send('clip.stop');
          S.playingKey = null; S.loadingKey = null;
          if (S.route.name === 'meeting') { S.route = { name: 'sessions' }; renderNav(); render(); }
        }
        if (!readInvalid(p) && S.history?.session_id === p.sessionId && readValid(`history.open:${p.sessionId}`)) { S.meetingRequest.error = p.message; if (S.route.name === 'meeting') render(); }
        else openSheet({ kind: 'requestError', error: p.message, sessionId: S.pendingMeetingId || p.sessionId });
      } else if (operation === 'history.list' || !operation && S.requests.history.loading) {
        clearTimeout(S.historyTimer); S.historyTimer = null;
        if (readInvalid(p) || !readValid('history.list')) { forgetReadLease('history.list'); S.historyItems = null; S.historyMeta = null; }
        S.requests.history = { error: p.message };
        if (['sessions', 'home', 'memory'].includes(S.route.name)) render();
      } else if (operation === 'history.search' && S.sheet?.kind === 'pending') {
        closeSheet();
      }
    } else if (p.scope === 'projects') {
      if ((operation === 'project.open' || !operation && S.route.name === 'project') && (!p.name || p.name === S.route.name_)) {
        if (p.requestId && p.requestId !== S.requests.project.requestId) return;
        if (invalidateReadSource(p)) return;
        if (readInvalid(p) || !readValid(`project.open:${p.name || S.route.name_}`)) { forgetReadLease(`project.open:${p.name || S.route.name_}`); S.projects.open = null; }
        S.requests.project = { error: p.message };
      } else if (operation === 'projects.list' || !operation && S.requests.projects.loading) {
        if (p.requestId && p.requestId !== S.requests.projects.requestId) return;
        if (invalidateReadSource(p)) return;
        if (readInvalid(p) || !readValid('projects.list')) { forgetReadLease('projects.list'); S.projects.items = null; }
        S.requests.projects = { error: p.message };
      }
      if (['memory', 'project'].includes(S.route.name)) render();
      if (S.sheet?.kind === 'projectPick') renderSheet();
    } else if (p.scope === 'tasks') {
      clearTimeout(S.tasks.timers.get(p.requestId)); S.tasks.timers.delete(p.requestId);
      S.tasks.pending.delete(taskKey(!!p.mine, p.status || 'open'));
      if (p.mine && !usesPersonalTaskIdentity() && p.selfName && p.selfName !== S.state.selfName) return;
      const key = taskKey(!!p.mine, p.status || 'open');
      if (readInvalid(p) || !readValid(`tasks.list:${key}`)) { forgetReadLease(`tasks.list:${key}`); expireTaskList(key, !!p.mine, p.status || 'open'); }
      if ((!('mine' in p) || !!p.mine === S.tasks.mine) && (!p.status || p.status === S.tasks.status)) S.requests.tasks = { error: p.message };
      if ((!('mine' in p) || p.mine) && (!p.status || p.status === 'open')) S.homeTasksState = { error: p.message };
      if (['tasks', 'home', 'memory'].includes(S.route.name)) render();
    } else if (p.scope === 'retention') {
      const pending=S.pendingRetention;
      if (pending && (!p.requestId || pending.requestId===p.requestId) && (!p.sessionId || pending.sessionId===p.sessionId)) {
        pending.status=p.sourceChanged?'stale':'failed';pending.error=p.message;
        if (S.sheet?.kind==='retain') renderSheet();
      }
    } else if (p.scope === 'feishu' || p.scope === 'minutes.delivery') {
      const d = S.deliveries.get(p.session_id || p.sessionId);
      const matching = d && p.requestId === d.requestId || p.requestId === S.feishu.recipientRequestId || p.requestId === S.feishu.requestId;
      if (matching && ['FEISHU_AUTH_EXPIRED','FEISHU_NOT_CONNECTED','FEISHU_OAUTH_UNAVAILABLE','FEISHU_CREDENTIAL_LOCKED'].includes(p.code)) {
        S.feishu.status = p.code === 'FEISHU_AUTH_EXPIRED' || p.code === 'FEISHU_CREDENTIAL_LOCKED' ? 'expired' : p.code === 'FEISHU_NOT_CONNECTED' ? 'disconnected' : 'unconfigured';
        for (const draft of S.deliveries.values()) draft.confirmed = false;
      }
      if (d && p.requestId === d.requestId) { d.busy = false; d.error = p.message; d.confirmed = false; if (ownershipRecovery[p.code]) blockDeliveryOwnership(d, p); else if (d.opId) d.status = 'unknown'; else if (p.sourceChanged || ['SOURCE_CHANGED','MINUTES_SOURCE_CHANGED','FEISHU_BINDING_CHANGED','REVIEW_REVISION_CHANGED'].includes(p.code)) d.status = 'source_changed'; else d.status = 'failed'; if (activeDelivery() === d) renderSheet(); }
      else if (p.requestId === S.feishu.recipientRequestId) { S.feishu.recipientsLoading = false; S.feishu.recipientsError = p.message; if (S.sheet?.kind === 'minutesDelivery') renderSheet(); }
      else if (p.requestId === S.feishu.requestId) { S.feishu.busy = false; S.feishu.error = p.message; if (S.sheet?.kind === 'feishu') renderSheet(); }
    } else if (p.scope === 'minutes') {
      const entry = S.minutes.get(p.sessionId);
      if (entry && (!p.requestId || p.requestId === entry.requestId)) {
        if (invalidateReadSource(p)) return;
        S.minutes.set(p.sessionId, { ...(readValid(`minutes:${p.sessionId}`) ? entry : {}), requestId: entry.requestId, loading: false, error: p.message });
        if (S.route.name === 'meeting' && S.history?.session_id === p.sessionId) render();
      }
    } else if (p.scope === 'items') {
      const r = S.itemReview;
      if (r?.pending && (!p.sessionId || p.sessionId === r.sessionId) && (!p.itemId || p.itemId === r.pending.itemId)) {
        r.pending = { ...r.pending, status: 'failed', error: p.message };
        if (p.changed && S.history?.session_id === r.sessionId) { r.pending = null; openMeeting(r.sessionId); }
        else if (S.sheet?.kind === 'items') renderSheet();
      }
    } else if (p.scope === 'review') {
      const pending = S.review?.pending;
      if (pending && (!p.operation || p.operation === pending.type) && (!p.sessionId || p.sessionId === pending.payload.sessionId) && (!p.utteranceId || p.utteranceId === pending.payload.utteranceId)) {
        pending.status = 'failed'; pending.error = p.message;
        if (S.sheet?.kind === 'review') renderSheet();
      }
    }
    if (p.scope === 'recall') {
      setBusy(false);
      if (S.sheet?.kind === 'pending') closeSheet();
    } else if (p.scope === 'action') {
      if (S.sheet?.kind === 'draftPending') closeSheet();
      if (S.draft && S.draft.status === 'sending') {
        S.draft.status = S.draft.submitted ? 'waiting' : 'editing';
        S.draft.error = p.message;
        if (S.sheet?.kind === 'draft') renderSheet();
      }
    } else if (p.scope === 'save' && S.sheet?.kind === 'card') {
      renderSheet();
    }
  }

  // ---- interactions -------------------------------------------------------------------------

  function validMemoryOrigin(origin) {
    const route = origin?.route;
    if (!['memory', 'project'].includes(route?.name) || !Number.isFinite(origin.scrollTop) || origin.scrollTop < 0) return null;
    if (route.name === 'project' && (typeof route.name_ !== 'string' || !route.name_.trim() || route.name_.length > 30)) return null;
    return { route: { ...route }, scrollTop: origin.scrollTop };
  }
  function back() {
    if (S.route.name === 'raft') {
      const origin = raft.sourceReturnRoute?.();
      if (origin?.name === 'meeting' && origin.id) { openMeeting(origin.id,origin.item_id); return; }
      if (origin?.name === 'project' && origin.name_) { go('project',{name_:origin.name_}); loadProject(); return; }
      go('tasks'); return;
    }
    const r = S.route.name;
    const memoryOrigin = r === 'meeting' ? validMemoryOrigin(S.route.memoryOrigin) : null;
    if (memoryOrigin) {
      const { name, ...extra } = memoryOrigin.route;
      go(name, extra);
      if (name === 'project') loadProject();
      $('scroll').scrollTop = memoryOrigin.scrollTop;
      return;
    }
    if (r === 'project') return go('memory');
    if (['settings', 'device'].includes(r)) return go('me');
    if (r === 'me') return go('home'); // Settings opens from the home header
    go('sessions');
  }
  function noticeFeedback(id, useful) {
    send('notice.feedback', { id, useful }); const n = S.notices.get(id); if (n) n.useful = useful;
    renderNoticeBanners(); if (['notices', 'commitments'].includes(S.sheet?.kind)) renderSheet();
  }
  function askSubmit(query, history) {
    if (!query) return toast('请输入问题');
    openSheet({ kind: 'pending', title: '查找原话', sub: history ? '在往期会议里找' : '在本场里找' });
    if (history) { S.searchRequestId = `search-${++S.historySerial}`; send('history.search', { query, requestId: S.searchRequestId }); }
    else send('ask.session', { query });
  }
  function openMeeting(id, returnItemId = null) {
    if (!id || S.deletedSessions.has(id)) return toast('这场会议已删除，不能重新打开', true);
    if (S.meetingRequest?.active && S.meetingRequest.sessionId === id) return;
    clearTimeout(S.meetingRequest?.timer);
    S.pendingMeetingId = id;
    const requestId = `open-${++S.historySerial}`;
    const memoryOrigin = ['memory', 'project'].includes(S.route.name)
      ? validMemoryOrigin({ route: { ...S.route }, scrollTop: $('scroll').scrollTop })
      : S.route.name === 'meeting' ? validMemoryOrigin(S.route.memoryOrigin) : null;
    S.meetingRequest = { sessionId: id, requestId, active: true, memoryOrigin, returnItemId };
    S.meetingRequest.timer = setTimeout(() => {
      if (S.meetingRequest?.requestId === requestId && S.meetingRequest.active)
        onError({ scope: 'history', operation: 'history.open', sessionId: id, requestId, message: '打开会议超时，请重新读取。' });
    }, 25000);
    openSheet({ kind: 'pending', title: '打开会议', sub: '团队服务器' });
    send('history.open', { sessionId: id, requestId });
  }

  const ACTIONS = {
    go: (el) => go(el.dataset.route),
    back,
    'rc-expand': () => { const key = rcContext(); S.rcExpanded = S.rcExpanded === key ? null : key; renderRecordingControls(); renderStatus(); },
    tab: (el) => {
      const before = S.route.name === 'live' ? S.liveTab : S.meetingTab;
      if (S.route.name === 'live') S.liveTab = el.dataset.tab; else S.meetingTab = el.dataset.tab;
      S.transcriptFilter = { speaker: null, query: '' };
      render(); $('scroll').scrollTop = 0;
      if (before !== el.dataset.tab) playEnter(false);
      if (S.route.name === 'live' && S.liveTab === 'transcript') { S.autoScroll = true; scrollToEnd(); }
    },
    close: closeSheet,
    'history-retry': () => { loadHistory(); render(); },
    'history-empty-toggle': () => {
      S.historyShowEmpty = !S.historyShowEmpty;
      S.historyItems = null; const top = $('scroll').scrollTop;
      loadHistory(true); minutesSync?.refreshList(); render(); $('scroll').scrollTop = top;
    },
    'tasks-retry': () => { openTasks(); render(); },
    'formal-tasks-retry': () => { S.requests.tasks={loading:true}; requestTasks(S.tasks.mine,S.tasks.status,true); render(); },
    'candidates-retry': () => { requestTaskCandidates(true); render(); },
    'home-tasks-retry': () => { loadHomeTasks(); render(); },
    'projects-retry': () => { loadProjects(); render(); if (S.sheet?.kind === 'projectPick') renderSheet(); },
    'project-retry': () => { loadProject(); render(); },
    'meeting-retry': () => openMeeting(S.sheet.sessionId),
    'feishu-open': openFeishu,
    'feishu-connect': () => { if (!S.feishu.busy) { feishuRequest('feishu.connect'); S.feishu.status = 'authorizing'; renderSheet(); } },
    'feishu-refresh': () => { feishuRequest('feishu.status'); renderSheet(); },
    'feishu-disconnect-prompt': () => { S.sheet.disconnectConfirm = true; renderSheet(); },
    'feishu-disconnect': () => { for (const d of S.deliveries.values()) d.confirmed = false; feishuRequest('feishu.disconnect'); renderSheet(); },
    'delivery-open': () => openMinutesDelivery(S.history?.session_id),
    'delivery-connect': () => { S.feishuReturnSession = S.sheet.sessionId; openFeishu(); },
    'delivery-return': () => { const sid = S.feishuReturnSession; S.feishuReturnSession = null; openMinutesDelivery(sid); },
    'delivery-search': deliveryRecipientsRequest,
    'delivery-reload': () => { const d = activeDelivery(); if (d && !deliveryBusy(d)) deliveryRequest('minutes.delivery.open', d.sessionId); },
    'delivery-save': () => { const d = activeDelivery(); if (!d?.draft || deliveryBusy(d) || deliverySent(d) || S.feishu.status !== 'connected') return; const a = d.draft; deliveryRequest('minutes.delivery.save', d.sessionId, {revision:a.revision, title:a.title, content:a.content, recipients:a.recipients.map(deliveryPersonId), permission:a.permission}); },
    'delivery-confirm': () => { const d = activeDelivery(); if (!deliveryCanConfirm(d) || !d.confirmed) return; d.opId = `minutes-send-${Date.now().toString(36)}-${++S.feishuSerial}`; d.status = 'pending'; deliveryRequest('minutes.delivery.confirm', d.sessionId, {revision:d.draft.revision, opId:d.opId, confirmed:true}); },
    'delivery-doc': () => { const d = activeDelivery(), url = d?.data?.delivery?.doc_url; if (d?.data?.delivery?.status === 'sent' && /^https:\/\/[^/]+\.(feishu\.cn|larksuite\.com)\/docx\//i.test(url || '')) send('open.url', {url}); },
    'delivery-status': () => { const d = activeDelivery(); if (d?.opId && !d.busy) deliveryRequest('minutes.delivery.status', d.sessionId, {opId:d.opId}); },
    'minutes-refresh': () => { if (S.history) { requestMinutes(S.history.session_id); render(); } },
    'minutes-source': (el) => openSheet({ kind: 'minutesSource', sessionId: S.history.session_id, id: el.dataset.id }),
    'minutes-doc': () => { const p = S.minutes.get(S.history?.session_id)?.data; if (p?.status === 'ready' && p.doc_url) send('open.url', { url: p.doc_url }); },
    'minutes-history-doc': () => { const p = S.minutes.get(S.history?.session_id)?.data; if (p?.reason === 'source_changed' && p.historical_doc_url) send('open.url', { url: p.historical_doc_url }); },
    'retain-reopen': () => { const id=S.pendingRetention?.sessionId;S.pendingRetention=null;closeSheet();if(id)openMeeting(id); },
    'retain-open': () => {
      if (!S.history || S.history.transcript_status==='expired') return toast('全文已到期，不能补造未核对的原文依据',true);
      S.pendingRetention=null;openSheet({kind:'retain',selected:[],summary:''});
    },
    'retain-pick': el => {
      if (S.pendingRetention?.status==='saving') return;
      S.sheet.summary=$('retain-summary').value || '';
      const ids=S.sheet.selected,id=el.dataset.id;
      if(ids.includes(id))S.sheet.selected=ids.filter(x=>x!==id);else if(ids.length<10)ids.push(id);else return toast('一次最多选择10条必要短依据',true);
      S.pendingRetention=null;renderSheet();
    },
    'retain-save': () => {
      if (S.pendingRetention?.status==='saving') return;
      if (!$('retain-confirmed').checked) return toast('请核对后单独确认保留',true);
      const selected=S.sheet.selected,summary=($('retain-summary').value || '').trim();S.sheet.summary=summary;
      const rows=(S.history?.utterances || []).filter(u=>selected.includes(u.id));
      if (!rows.length || rows.length!==selected.length || S.history.transcript_status==='expired') return toast('请重新选择当前可核对的短原话',true);
      if(summary.length>2000 || rows.some(u=>u.text.length>10000))return toast('摘要或来源超出本次保留范围',true);
      const requestId='retain-'+(++S.retentionRequest),sessionId=S.history.session_id;
      const payload={sessionId,requestId,confirm:true,evidence:rows.map(u=>({id:u.id,quote:u.text.slice(0,280),sourceText:u.text})),
        summaries:summary?[{id:'summary-'+Date.now(),text:summary,source_ids:rows.map(u=>u.id)}]:[]};
      S.pendingRetention={sessionId,requestId,status:'saving',payload};renderSheet();send('meeting.retain',payload);
    },
    'retain-retry': () => { const pending=S.pendingRetention;if(!pending || pending.status!=='failed')return;pending.status='saving';pending.error=null;renderSheet();send('meeting.retain',pending.payload); },
    'privacy-open': () => openSheet({kind:'privacy'}),
    'device-pair': () => openSheet({kind:'devicePair'}),
    'device-pair-confirm': () => { const autoListen=$('device-pair-auto').checked;closeSheet();applyDeviceEvent({type:'pair',autoListen}); },
    'device-preferences': () => openSheet({kind:'devicePreferences'}),
    'device-preferences-save': () => {
      const quietStart=$('device-quiet-start').value,quietEnd=$('device-quiet-end').value;
      if(!deviceDemo.timeValid(quietStart)||!deviceDemo.timeValid(quietEnd)||quietStart===quietEnd)return toast('请填写有效且不同的安静时段起止时间',true);
      const event={type:'preferences',autoListen:$('device-auto').checked,quietEnabled:$('device-quiet').checked,quietStart,quietEnd};
      closeSheet();applyDeviceEvent(event);toast('仅保存了当前设备示例偏好');
    },
    'device-condition': el => applyDeviceEvent({type:'condition',condition:el.dataset.value}),
    'device-power': () => applyDeviceEvent({type:'power'}),
    'device-pause': () => applyDeviceEvent({type:'pause'}),
    'device-stop': () => applyDeviceEvent({type:'stop'}),
    'device-resume': () => applyDeviceEvent({type:'resume'}),
    'device-reset': () => applyDeviceEvent({type:'reset'}),
    'capture-start': () => openSheet({kind:'captureMode',mode:'daily'}),
    'capture-pause': () => send('capture.pause'),
    'capture-resume': () => send('capture.resume'),
    'record-button': () => S.state.capturing ? ACTIONS['capture-stop']() : ACTIONS['capture-start'](),
    'capture-stop-confirm': () => {
      if (!S.state.capturing || S.sheet?.kind !== 'stopConfirm') return;
      S.dailyStopSession = S.state.recordingMode === 'meeting' ? null : S.state.sessionId;
      S.dailyAutoBlocked=false;
      closeSheet(); send('capture.stop');
    },
    'capture-meeting': () => openSheet({kind:'captureMode',mode:'meeting',switching:true}),
    'capture-mode': el => { S.sheet.mode = el.dataset.mode; renderSheet(); },
    'capture-before-recall': () => { closeSheet(); send('recall.trigger'); },
    'capture-confirm': () => {
      const meeting = S.sheet.switching || S.state.source === 'bean' || S.sheet.mode === 'meeting';
      if (meeting && !$('capture-cloud').checked) return toast('请明确选择本次云端保存',true);
      const payload = {recordingMode:meeting?'meeting':'daily',cloudSaveConfirmed:meeting,
        audioRetentionDays:meeting?Number($('capture-audio-days').value):30,
        transcriptRetentionDays:meeting?Number($('capture-transcript-days').value):30};
      if (![7,30,90].includes(payload.audioRetentionDays) || ![7,30,90].includes(payload.transcriptRetentionDays)) return toast('请选择7、30或90天',true);
      const action = S.sheet.switching?'capture.meeting':'capture.start'; S.dailyStopSession = null; S.dailyRequest = null; S.dailyAutoBlocked=true; closeSheet(); send(action,payload);
    },
    'daily-candidates': () => requestDailyResults(),
    'daily-results': el => requestDailyResults(el?.dataset?.session || null),
    'daily-results-retry': () => requestDailyResults(S.sheet?.sessionId || S.dailyRequest?.sessionId),
    'daily-discard': el => mutateDailyCandidate('daily.candidate.discard', {sessionId:el.dataset.session,id:el.dataset.id}),
    'daily-confirm-open': el => {
      const item=S.dailyCandidates.find(x=>x.id===el.dataset.id && x.session_id===el.dataset.session);
      if(item)openSheet({kind:'dailyConfirm',item,sessionId:S.sheet?.sessionId || item.session_id});
    },
    'daily-confirm-back': () => { if (!S.dailyRequest?.mutation) requestDailyResults(S.sheet?.sessionId || S.sheet?.item?.session_id); },
    'daily-confirm-save': () => {
      if (S.dailyRequest?.mutation) return;
      if(!$('daily-confirmed').checked)return toast('请核对后再确认保存',true);
      const item=S.sheet.item, quote=($('daily-quote').value || '').trim();
      if(!quote || [...quote].length > 280)return toast('请填写280字以内的重点',true);
      S.sheet.quoteDraft=quote; mutateDailyCandidate('daily.candidate.confirm',{sessionId:item.session_id,id:item.id,quote,confirmed:true});
    },
    'capture-stop': () => { if (S.state.capturing) openSheet({kind:'stopConfirm'}); },
    recall: () => send('recall.trigger'),
    'saved-list': () => send('saved.list'),
    'ask-open': () => openSheet({ kind: 'ask', history: S.route.name !== 'live' && !S.state.capturing }),
    'ask-example': (el) => { $('ask-query').value = el.dataset.query; },
    'ask-submit': () => askSubmit($('ask-query').value.trim(), $('ask-scope').value === 'history'),
    'home-ask-scope': () => { S.homeAskHistory = !S.homeAskHistory; render(); },
    'home-ask': () => askSubmit($('home-ask').value.trim(), !!S.homeAskHistory),
    'agenda-open': () => openSheet({ kind: 'agenda' }),
    'agenda-save': saveAgenda,
    'agenda-clear': () => { send('agenda.clear'); closeSheet(); },
    'commitments-open': () => openSheet({ kind: 'commitments' }),
    'ideas-all': () => { S.showAllIdeas = true; renderSheet(); },
    'transcript-mode': () => { S.transcriptFilter.showAll = !S.transcriptFilter.showAll; render(); },
    'notices-open': () => openSheet({ kind: 'notices' }),
    'meeting-notices': () => openSheet({ kind: 'notices', rows: S.history?.notices || [] }),
    'live-tools': () => openSheet({ kind: 'tools', live: true }),
    'meeting-tools': (el) => {
      if (el.dataset.id && S.history?.session_id !== el.dataset.id) { S.pendingTools = el.dataset.id; return openMeeting(el.dataset.id); }
      openSheet({ kind: 'tools', live: false });
    },
    'live-project': () => openProjectPick(S.state.sessionId, S.liveProject),
    'history-project': () => openProjectPick(S.history.session_id, S.history.project || null),
    'project-set': (el) => send('meeting.project', { sessionId: S.sheet.sessionId, project: el.dataset.name }),
    'project-create': () => { const name = $('project-new').value.trim(); if (!name) return toast('请输入项目名称'); send('meeting.project', { sessionId: S.sheet.sessionId, project: name }); },
    'project-open': (el) => { if (S.projects.open?.name !== el.dataset.name) S.projects.open = null; S.projects.section = 'decisions'; go('project', { name_: el.dataset.name }); loadProject(); render(); },
    'project-section': (el) => { S.projects.section = el.dataset.value; render(); },
    'memory-tab': (el) => { if (!['meetings','personal'].includes(el.dataset.value)) return; S.memoryTab = el.dataset.value; enter(); render(); },
    'memory-view': (el) => { if (!['meetings','projects'].includes(el.dataset.value)) return; S.memoryView = el.dataset.value; enter(); render(); },
    'memory-people': () => { openSheet({kind:'memoryPeople'}); send('voiceprint.list'); },
    'personal-reload': () => { if (S.personalAuto.mutation?.status === 'unknown') readPersonalCandidateOutcome(); else { loadPersonal(); refreshPersonalUi(); } },
    'personal-auto-reload': () => { if (S.personalAuto.mutation?.status === 'unknown') readPersonalCandidateOutcome(); else { loadPersonalCandidates(); refreshPersonalUi(); } },
    'personal-auto-recheck': readPersonalCandidateOutcome,
    'personal-auto-open': el => openPersonalCandidate(el.dataset.id),
    'personal-auto-confirm': () => {
      if (personalBusy()) return;
      capturePersonalCandidateDraft();
      const a=S.personalAuto, draft=a.drafts.get(a.editKey), item=(a.items || []).find(value => value.id === a.editKey);
      if (!item || !draft || a.error || draft.version !== item.version || draft.source_fingerprint !== item.source_fingerprint) return toast('候选已变化，请重新读取核对',true);
      const title=draft.title.trim(),text=draft.text.trim();
      if (!PERSONAL_KINDS.includes(draft.kind) || !title || title.length > 100 || !text || text.length > 280) return toast('请选择分类，填写100字以内标题和280字以内内容',true);
      if (!draft.subject_confirmed || !draft.content_confirmed) return toast('请分别核对本人归属、原话及保存内容',true);
      personalCandidateMutation('confirm',{id:item.id,version:item.version,source_fingerprint:item.source_fingerprint,kind:draft.kind,title,text,subject_confirmed:true,content_confirmed:true});
    },
    'personal-auto-discard-prompt': () => {
      if (personalBusy()) return;
      capturePersonalCandidateDraft();
      const a=S.personalAuto, draft=a.drafts.get(a.editKey), item=(a.items || []).find(value => value.id === a.editKey);
      if (!item || !draft || draft.version !== item.version || draft.source_fingerprint !== item.source_fingerprint) return toast('候选已变化，请重新读取后选择',true);
      openSheet({kind:'personalAutoDiscard',id:item.id,version:item.version,source_fingerprint:item.source_fingerprint});
    },
    'personal-auto-discard': () => {
      if (personalBusy() || S.sheet?.kind !== 'personalAutoDiscard') return;
      const item=(S.personalAuto.items || []).find(value => value.id === S.sheet.id);
      if (!item || item.version !== S.sheet.version || item.source_fingerprint !== S.sheet.source_fingerprint) return toast('候选已变化，请重新读取后选择',true);
      personalCandidateMutation('discard',{id:item.id,version:item.version,source_fingerprint:item.source_fingerprint});
    },
    'personal-kind': (el) => { if (!['全部',...PERSONAL_KINDS].includes(el.dataset.value)) return; S.personal.kind=el.dataset.value; render(); },
    'personal-new': () => openPersonalEdit(),
    'personal-open': (el) => { if ((S.personal.items || []).some(item => item.id === el.dataset.id)) openSheet({kind:'personalDetail',id:el.dataset.id}); },
    'personal-edit': (el) => openPersonalEdit(el.dataset.id),
    'personal-save': () => {
      if (personalBusy()) return;
      capturePersonalDraft();
      const p=S.personal, draft=p.drafts.get(p.editKey);
      if (!draft) return;
      if (p.error) return toast('请先返回个人页，重新读取后再保存',true);
      const title=draft.title.trim(),body=draft.body.trim();
      if (!title || title.length > 100 || !body || body.length > 5000 || !PERSONAL_KINDS.includes(draft.kind)) return toast('请填写100字以内标题和5000字以内内容，并选择分类',true);
      personalMutation('save',{id:draft.id,create:draft.create,title,body,kind:draft.kind});
    },
    'personal-draft-discard': () => { if (!personalBusy()) { S.personal.drafts.delete(S.personal.editKey); closeSheet(); } },
    'personal-delete-prompt': (el) => { if (!personalBusy() && !S.personal.error && (S.personal.items || []).some(item=>item.id===el.dataset.id)) openSheet({kind:'personalDelete',id:el.dataset.id}); },
    'personal-delete-confirm': (el) => { if (!personalBusy() && !S.personal.error && (S.personal.items || []).some(item=>item.id===el.dataset.id)) personalMutation('delete',{id:el.dataset.id}); },
    'meeting-open': (el) => openMeeting(el.dataset.id),
    'rename-open': () => openSheet({ kind: 'rename' }),
    'rename-save': () => send('history.rename', { sessionId: S.history.session_id, title: $('rename-input').value.trim() }),
    'history-delete-prompt': () => { S.sheet.deleteConfirm = true; renderSheet(); },
    'history-delete-confirm': deleteHistory,
    'history-quote': (el) => {
      const u = S.history.utterances.find((x) => x.id === el.dataset.id);
      if (u) historySearch({ query: '', engine: 'archive', items: [{ ...u, session_id: S.history.session_id, prob: 1, started_at: S.history.started_at }] });
    },
    'history-speaker': (el) => {
      const u = S.history.utterances.find((x) => x.id === el.dataset.id);
      if (u) openSpeakerPick({ live: false, sessionId: S.history.session_id, id: u.id, text: u.text, model: u.speaker,
        current: u.review?.speaker || null, startMs: u.start_ms, endMs: u.end_ms });
    },
    'history-play': (el) => {
      const u = S.history.utterances.find((x) => x.id === el.dataset.id), key = `h-${el.dataset.id}`;
      if (S.playingKey === key) send('clip.stop');
      else if (u) send('clip.remote', { key, sessionId: S.history.session_id, startMs: u.start_ms, endMs: u.end_ms });
    },
    'line-speaker': (el) => {
      const u = S.records.get(el.dataset.id);
      if (u) openSpeakerPick({ live: true, sessionId: S.state.sessionId, id: u.id, text: u.display || u.text, model: u.speaker,
        current: u.manualSpeaker || null, startMs: u.startMs, endMs: u.endMs });
    },
    'filter-speaker': (el) => {
      S.transcriptFilter.speaker = el.dataset.name || null;
      if (S.route.name === 'live') { S.records.forEach((_, id) => renderLine(id)); document.querySelectorAll('[data-act="filter-speaker"]').forEach((b) => { b.classList.toggle('selected', (b.dataset.name || null) === S.transcriptFilter.speaker); b.setAttribute('aria-pressed', String((b.dataset.name || null) === S.transcriptFilter.speaker)); }); }
      else render();
    },
    'speaker-set': (el) => setSpeakerFromPick(el.dataset.name),
    'speaker-undo': () => setSpeakerFromPick(null),
    'speaker-play': () => {
      const p = S.sheet, key = `spk-${p.id}`;
      if (S.playingKey === key) send('clip.stop');
      else if (p.live) send('clip.play', { key, startMs: p.startMs, endMs: p.endMs });
      else send('clip.remote', { key, sessionId: p.sessionId, startMs: p.startMs, endMs: p.endMs });
    },
    'review-start': (el) => { S.pendingReview = el.dataset.id; openMeeting(el.dataset.id); },
    'review-verdict': (el) => reviewVerdict(el.dataset.value),
    'review-owner': (el) => reviewOwner(el.dataset.name),
    'review-speaker': (el) => {
      const { r, u } = reviewCurrent();
      saveReview('speaker.correct', { sessionId: r.sessionId, utteranceId: u.id, speaker: el.dataset.name });
    },
    'review-retry': () => { const pending = S.review?.pending; if (pending?.status === 'failed') saveReview(pending.type, pending.payload); },
    'review-skip': () => reviewNext(false),
    'review-prev': () => { if (S.review.pending?.status === 'saving') return; S.review.i = Math.max(0, S.review.i - 1); S.review.ownerStep = false; S.review.pending = null; renderSheet(); },
    'review-play': () => {
      const { r, u } = reviewCurrent(), key = `rv-${u.id}`;
      if (S.playingKey === key) send('clip.stop');
      // This meeting's audio may still be on the phone; otherwise it comes from the server archive.
      else send('clip.play', { key, sessionId: r.sessionId, startMs: u.start_ms, endMs: u.end_ms });
    },
    'review-finish': () => openMeeting(S.review.sessionId),
    'items-finish': () => { closeSheet(); render(); },
    'item-task-draft': (el) => startItemTask((S.history?.items || []).find(item => item.id === el.dataset.id)),
    'meeting-item-task-draft': (el) => startItemTask((S.tasks.meetingItems || []).find(item => item.id === el.dataset.id), true),
    'item-task-retry': () => { const r = S.itemTaskRequest; if (!r || r.status !== 'failed') return; r.payload = {...r.payload, requestId:`item-task-${++S.itemTaskSerial}`}; r.status='loading'; r.error=null; renderSheet(); sendItemTaskRequest(); },
    'item-task-reopen': () => { const sid=S.itemTaskRequest?.payload.sessionId; closeSheet(); if (sid) openMeeting(sid); },
    'item-open': (el) => { if (S.history) startItemReview(S.history, el.dataset.id); },
    'item-owner': (el) => { const { r, it } = itemCurrent(); if (!it) return; if (r.editing) r.draft.owner = el.dataset.name; else r.owner[it.id] = el.dataset.name; renderSheet(); },
    'item-confirm': () => { const { r, it } = itemCurrent(); if (!it) return; if (it.kind === 'task' && !r.owner[it.id]) return toast('待办需要先选负责人', true); itemSend('confirm', it.kind === 'task' ? { owner: r.owner[it.id] } : {}); },
    'item-reject': () => itemSend('reject'),
    'item-reopen': () => itemSend('reopen'),
    'item-retry': () => { const r = S.itemReview; if (r?.pending?.status === 'failed') { const p = r.pending.payload; r.pending = { ...r.pending, status: 'saving', error: null }; renderSheet(); send('items.review', p); } },
    'item-edit': () => { const { r, it } = itemCurrent(); if (!it) return; const v = itemView(it); r.editing = true; r.draft = { kind: v.kind, title: v.title, due: v.due || '', owner: v.owner || r.owner[it.id] || '' }; renderSheet(); },
    'item-edit-cancel': () => { const r = S.itemReview; r.editing = false; r.draft = null; renderSheet(); },
    'item-save': () => { const r = S.itemReview, d = r.draft; d.title = ($('item-title')?.value || '').trim(); d.due = ($('item-due')?.value || '').trim();
      if (d.title.length < 2) return toast('请用一句话写清这件事', true); if (d.kind === 'task' && !d.owner) return toast('待办需要先选负责人', true);
      itemSend('confirm', { kind: d.kind, title: d.title, due: d.due, ...(d.kind === 'task' ? { owner: d.owner } : {}) }); },
    'item-prev': () => itemMove(-1),
    'item-next': () => itemMove(1),
    'item-play': (el) => { const { r } = itemCurrent(), e = (itemCurrent().it?.evidence || []).find((x) => x.id === el.dataset.id); if (!e) return; const key = `it-${e.id}`;
      if (S.playingKey === key) send('clip.stop'); else send('clip.play', { key, sessionId: r.sessionId, startMs: e.start_ms, endMs: e.end_ms }); },
    'tasks-scope': (el) => { S.tasks.scope = el.dataset.value; S.tasks.mine = el.dataset.value === 'mine'; if (S.tasks.scope === 'review') S.tasks.status = 'all'; openTasks(); render(); },
    'tasks-status-cycle': () => { S.tasks.status = { open: 'done', done: 'all', all: 'open' }[S.tasks.status]; openTasks(); render(); },
    'tasks-self': (el) => { clearTaskIdentity(); S.state.selfName = el.dataset.name; send('settings.set', { selfName: el.dataset.name }); openTasks(); render(); },
    'parsed-filter': (el) => { if (el.dataset.value in PARSED_FILTER) { S.tasks.reviewFilter = el.dataset.value; render(); } },
    'parsed-expand': (el) => { const id = el.dataset.id; if (S.tasks.expanded.has(id)) S.tasks.expanded.delete(id); else S.tasks.expanded.add(id); render(); },
    'meeting-work-open': () => { S.tasks.scope = 'review'; S.tasks.mine = false; S.tasks.status = 'all'; S.tasks.reviewFilter = 'all'; S.tasks.query = ''; go('tasks'); },
    'parsed-review-open': (el) => {
      const item = (S.tasks.parsedItems || []).find(x => x.id === el.dataset.id);
      startTaskReview(item);
    },
    'task-review-reload': () => { if (S.taskReview?.readInvalidated) recheckTaskReview(); else if (S.taskReview) startTaskReview(S.taskReview.source,true); },
    'task-review-save': el => saveTaskReview(el.dataset.action),
    'task-review-raft-open': () => {
      const r=S.taskReview, own=r?.data?.item?.review;
      if (!r || r.status!=='ready' || r.account!==feishuAccountKey() || own?.status!=='confirmed' || own.kind!=='task') return toast('请先用本人账号确认并保存这件任务。',true);
      captureTaskReviewDraft();
      if (['kind','title','detail','due','owner'].some(key=>String(r.draft?.[key] || '')!==String(own[key] ?? r.data.item[key] ?? ''))) return toast('核对内容已修改，请先保存后再派工。',true);
      openTaskCollaboration(raftSourceRef(r.source),{name:'tasks'});
    },
    'parsed-raft-open': el => {
      const item=[...(S.tasks.meetingItems || []),...(S.projects.open?.meeting_items || [])].find(x=>x.id===el.dataset.id);
      if (!item || parsedReviewState(item)!=='confirmed') return toast('请先重新读取并确认这件会议任务。',true);
      openTaskCollaboration(raftSourceRef(item),S.route.name==='project'?{name:'project',name_:S.route.name_}:{name:'tasks'});
    },
    'parsed-raft-send': el => {
      const item=[...(S.tasks.parsedItems || []),...(S.tasks.meetingItems || []),...(S.projects.open?.meeting_items || [])].find(x=>x.id===el.dataset.id);
      if (!item || !candidateCurrent(item) || ['changed','excluded'].includes(parsedReviewState(item))) return toast('这件任务当前不可派工，请重新读取或修改任务。',true);
      openTaskCollaboration(raftSourceRef(item),S.route.name==='project'?{name:'project',name_:S.route.name_}:{name:'tasks'},{compact:true});
    },
    'item-raft-open': () => {
      const r=S.itemReview, row=S.history, it=(row?.items || [])[r?.i];
      if (!r || r.sessionId!==row?.session_id || r.pending || !it || itemState(it)!=='done' || itemView(it).kind!=='task') return toast('请先保存并重新读取这件会议任务。',true);
      openTaskCollaboration({kind:'meeting_item',session_id:row.session_id,item_id:it.id,fingerprint:it.fingerprint},{name:'meeting',id:row.session_id,item_id:it.id});
    },
    'task-review-retry': retryTaskReview,
    'task-open': (el) => {
      if (window.OopsDemoTransport && el.dataset.url?.startsWith('demo-task:')) {
        raft.openTask?.(el.dataset.url.slice('demo-task:'.length)); go('raft', {fromSource:true}); return;
      }
      if (el.dataset.url) send('open.url', { url: el.dataset.url });
    },
    'self-pick': () => openSheet({ kind: 'selfPick' }),
    'self-set': (el) => { clearTaskIdentity(); S.state.selfName = el.dataset.name; send('settings.set', { selfName: el.dataset.name }); closeSheet(); enter(); render(); },
    'notice-open': (el) => { const n = S.notices.get(el.dataset.id); if (n?.evidenceIds?.length) send('digest.openMany', { ids: n.evidenceIds }); },
    'notice-useful': (el) => noticeFeedback(el.dataset.id, true),
    'notice-wrong': (el) => noticeFeedback(el.dataset.id, false),
    'notice-dismiss': (el) => { send('notice.dismiss', { id: el.dataset.id }); const n = S.notices.get(el.dataset.id); if (n) n.dismissed = true; renderNoticeBanners(); },
    'commitment-open': (el) => send('digest.open', { utteranceId: el.dataset.id }),
    'draft-source-reload': () => {
      if (S.draft?.data.sourceItemId) { const sid=S.draft.sourceSessionId; closeSheet(); if (sid) openMeeting(sid); return; }
      const sourceId = S.draft?.data?.evidence?.utteranceIds?.[0];
      if (!sourceId) { closeSheet(); go('sessions'); return; }
      closeSheet(); send('digest.open', { utteranceId: sourceId });
    },
    'retry-recall': () => { closeSheet(); send('recall.trigger'); },
    cand: (el) => { S.card.sel = Number(el.dataset.i); S.card.before = 0; S.card.after = 0; renderSheet(); },
    prev: () => { S.card.before += 1; renderSheet(); },
    next: () => { S.card.after += 1; renderSheet(); },
    reset: () => { S.card.before = 0; S.card.after = 0; renderSheet(); },
    play: () => toggleClip(cardClipKey(), selectedRange()),
    dismiss: () => { send('recall.dismiss', { cardId: S.card.data.id }); closeSheet(); },
    save: (el) => {
      el.disabled = true;
      const sel = selected();
      send('recall.save', { cardId: S.card.data.id, utteranceIds: sel.map((u) => u.id), ...selectedRange() });
    },
    draft: () => {
      const sel = selected();
      send('action.draft', { cardId: S.card.data.id, utteranceIds: sel.map((u) => u.id) });
      openSheet({ kind: 'draftPending' });
    },
    'play-evidence': () => {
      const ev = S.draft.data.evidence;
      toggleClip(`ev-${S.draft.data.draftId}`, { startMs: ev.startMs, endMs: ev.endMs }, S.draft.sourceSessionId);
    },
    confirm: confirmDraft,
    'draft-source-reopen': () => {
      if (S.draft?.status !== 'failed' || S.draft.sourceBlocked || !S.draft.sourceInvalidated && S.draft.errorCode !== 'SOURCE_CHANGED') return;
      const sid = S.draft.sourceSessionId;
      S.draft = null; closeSheet();
      if (sid && !S.deletedSessions.has(sid) && sid !== S.state.sessionId) openMeeting(sid);
      else go(sid === S.state.sessionId && S.records.size ? 'live' : 'sessions');
      toast('请重新选择当前有效原话后起草');
    },
    'query-action': () => {
      S.draft.status = 'sending'; renderSheet();
      send('action.status', { draftId: S.draft.data.draftId });
    },
    'open-task': () => send('open.url', { url: S.draft.result.taskUrl }),
    'choose-owner': (el) => { if (editDraftField('who', el.dataset.name)) renderSheet(); },
    'vp-open': () => { S.voiceprintDelete = null; openSheet({ kind: 'voiceprint' }); send('voiceprint.list'); },
    'vp-refresh': () => send('voiceprint.list'),
    'vp-record': () => recordVoiceprint('enroll'),
    'vp-test': () => recordVoiceprint('test'),
    'vp-stop': () => send('voiceprint.stop'),
    'vp-save': () => send('voiceprint.save'),
    'vp-cancel': () => send('voiceprint.cancel'),
    'vp-delete-prompt': (el) => { S.voiceprintDelete = el.dataset.name; renderSheet(); },
    'vp-delete-confirm': () => { send('voiceprint.delete', { name: S.voiceprintDelete, confirm: true }); S.voiceprintDelete = null; },
    'apply-settings': applySettings,
    'archive-retry': () => { if (!S.state.capturing && S.state.asr !== 'finishing') send('archive.retry', { requestId: `archive-${++S.historySerial}` }); },
    'pick-audio': () => send('testAudio.pick'),
    'reset-audio': () => send('testAudio.reset'),
  };

  // Stop before an action replaces sheet markup: the browser's event path still reaches root
  // even after the clicked node no longer has #sheet as an ancestor.
  $('sheet').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = ACTIONS[el.dataset.act];
    if (act) { e.stopPropagation(); act(el); }
  });
  $('sheet').addEventListener('change', (e) => {
    if (['personal-auto-kind','personal-auto-subject','personal-auto-confirmed'].includes(e.target.id)) {
      capturePersonalCandidateDraft();
      if (e.target.id === 'personal-auto-kind') resetPersonalCandidateChecks();
    }
    if (e.target.id === 'personal-kind') capturePersonalDraft();
    if (e.target.id.startsWith('task-review-')) {
      captureTaskReviewDraft();
      if (e.target.id === 'task-review-kind') renderSheet();
    }
    if (e.target.id === 'delivery-permission') { deliveryEdit('permission', e.target.value); renderSheet(); }
    if (e.target.dataset?.deliveryRecipient) {
      const d = activeDelivery(); if (d?.draft && !deliveryBusy(d) && !deliverySent(d)) {
        const id = e.target.dataset.deliveryRecipient, selected = d.draft.recipients.filter(p => deliveryPersonId(p) !== id);
        if (e.target.checked) selected.push(S.feishu.recipients.find(p => deliveryPersonId(p) === id) || id);
        deliveryEdit('recipients', selected); renderSheet();
      }
    }
    if (e.target.id === 'delivery-confirmed') { const d = activeDelivery(); if (d) { d.confirmed = !!e.target.checked && !!deliveryCanConfirm(d); const btn = $('delivery-send'); if (btn) btn.disabled = !d.confirmed; } }
    if (e.target.id === 'vp-name') { S.voiceprintName = e.target.value; renderSheet(); }
    if (e.target.id === 'f-who') editDraftField('who', e.target.value);
    if (e.target.id === 'item-merge' && e.target.value) itemSend('merge', { into: e.target.value });
    if (e.target.id === 'item-kind' && S.itemReview?.draft) {
      const d = S.itemReview.draft; d.title = $('item-title')?.value ?? d.title; d.due = $('item-due')?.value ?? d.due; d.kind = e.target.value; renderSheet();
    }
  });
  $('sheet').addEventListener('input', (e) => {
    if (['personal-auto-title','personal-auto-text'].includes(e.target.id)) { capturePersonalCandidateDraft(); resetPersonalCandidateChecks(); }
    if (['personal-title','personal-body'].includes(e.target.id)) capturePersonalDraft();
    if (e.target.id.startsWith('task-review-')) captureTaskReviewDraft();
    if (e.target.id === 'delivery-title') deliveryEdit('title', e.target.value);
    if (e.target.id === 'delivery-content') deliveryEdit('content', e.target.value);
    if (e.target.id === 'delivery-search') S.feishu.recipientQuery = e.target.value;
    const field = { 'f-who': 'who', 'f-what': 'what', 'f-when': 'whenIso', 'f-constraint': 'constraint' }[e.target.id];
    if (field) editDraftField(field, e.target.value || (field === 'whenIso' ? null : ''));
  });
  $('backdrop').addEventListener('click', closeSheet);
  // Swiping down from the handle or the title closes the sheet.
  let sheetDrag = null;
  $('sheet').addEventListener('touchstart', (e) => { sheetDrag = e.target.closest('.sheet-handle-zone, .sheet-header') ? e.touches[0].clientY : null; }, { passive: true });
  $('sheet').addEventListener('touchend', (e) => {
    if (sheetDrag !== null && e.changedTouches[0].clientY - sheetDrag > 60) closeSheet();
    sheetDrag = null;
  }, { passive: true });
  // The system back key/gesture: close the sheet, then step back through the pages. false = nothing left to go back to.
  window.OopsBack = () => {
    if (S.sheet) { closeSheet(); return true; }
    if (!$('sheet').hidden) { closeSheet(); return true; }
    const r = S.route.name;
    if (['live', 'meeting', 'project', 'settings', 'device'].includes(r)) { back(); return true; }
    if (r !== 'home') { go('home'); return true; }
    return false;
  };
  $('root').addEventListener('click', (e) => {
    if (e.target.closest('#sheet')) return;
    const raftControl = e.target.closest('[data-raft-act]');
    if (raftControl && raft.action(raftControl)) { e.stopPropagation(); return; }
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = ACTIONS[el.dataset.act];
    if (act) { e.stopPropagation(); act(el); }
  });
  // A live transcript card opens "who said it"; it is built outside the page templates.
  LINES.addEventListener('click', (e) => {
    const card = e.target.closest('[data-id]');
    if (card) ACTIONS['line-speaker'](card);
  });
  $('root').addEventListener('change', (e) => { raft.input(e.target); });
  $('root').addEventListener('input', (e) => {
    if (raft.input(e.target)) return;
    if (['memory-meeting-search','personal-search'].includes(e.target.id)) {
      const id=e.target.id, pos=e.target.selectionStart;
      if (id==='personal-search') S.personal.query=e.target.value; else S.memoryQuery=e.target.value;
      render(); const input=$(id); if (input) { input.focus(); input.setSelectionRange(pos,pos); }
    }
    if (e.target.id === 'home-ask') S.homeQuery = e.target.value;
    if (e.target.id === 'sessions-search') { S.sessionsQuery = e.target.value; const pos = e.target.selectionStart; render(); const i = $('sessions-search'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
    if (e.target.id === 'tasks-search') { S.tasks.query = e.target.value; const pos = e.target.selectionStart; render(); const i = $('tasks-search'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
    if (e.target.id === 'meeting-search') { S.transcriptFilter.query = e.target.value; const pos = e.target.selectionStart; render(); const i = $('meeting-search'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
  });

  window.OopsResume = () => { expireReadLeases(); resumeReviewReturn(true); resumeMinutesSync(); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseMinutesSync();
    else { expireReadLeases(); resumeMinutesSync(); }
    if (document.hidden && S.pendingReviewReturn) S.externalReviewHidden = true;
    else resumeReviewReturn();
  });
  window.addEventListener('focus', () => resumeReviewReturn());
  window.addEventListener('online', resumeMinutesSync);
  window.addEventListener('offline', pauseMinutesSync);
  $('root').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.target.id === 'live-ask') { e.preventDefault(); askSubmit(e.target.value.trim(), false); }
    if (e.target.id === 'home-ask' && !e.shiftKey) { e.preventDefault(); askSubmit(e.target.value.trim(), !!S.homeAskHistory); }
  });

  if (window.OopsDemoTransport) {
    window.OopsDemoNavigate = (page, id) => {
      closeSheet();
      if (page === 'personal') { S.memoryTab = 'personal'; go('memory'); }
      else if (page === 'projects') { S.memoryTab = 'meetings'; S.memoryView = 'projects'; go('memory'); }
      else if (page === 'meeting' && id) openMeeting(id);
      else if (page === 'daily') send('daily.results', { autoOpen: true });
      else if (['home', 'sessions', 'tasks', 'memory', 'raft', 'live'].includes(page)) go(page);
    };
  }
  render();
  send('hello');
})();
