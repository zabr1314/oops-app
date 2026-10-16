import type { AppData, Session, Task, Transcript } from './store';
import { archiveSafeData } from './storagePolicy';

// Native JSON remains separate from the local domain: a server receipt is not a local save.
export type NativeRecord = Record<string, any>;
export type NativeBridgeSnapshot = {
  ready: boolean; connected: boolean; state: NativeRecord; backendUrl: string;
  serviceEpoch: number | null; scopeVersion: number; history: NativeRecord[];
  sessions: Record<string, NativeRecord>; minutes: Record<string, NativeRecord>;
  items: NativeRecord[]; tasks: NativeRecord[]; account: NativeRecord | null;
  context: NativeRecord | null; transcript: NativeRecord[]; partial: string;
  summary: NativeRecord | null; board: NativeRecord | null; error: NativeRecord | null;
  capabilities: { pause: boolean };
};
type NativeChannel = { postMessage(message: string): void; onmessage?: ((event: { data: string }) => void) | null };
export type NativeHost = {
  __OOPS_NATIVE_APP__?: boolean; OopsNative?: NativeChannel;
  dispatchEvent?: (event: Event) => boolean; localStorage?: Pick<Storage, 'getItem' | 'setItem'>;
};
const hostWindow = (): NativeHost | undefined => typeof window === 'undefined' ? undefined : window as unknown as NativeHost;
export function isNativeHost(host = hostWindow()): boolean { return !!(host?.__OOPS_NATIVE_APP__ || host?.OopsNative); }

/** Android never inherits the website's sample identities, meetings or browser cache. */
export function createNativeData(): AppData {
  return { sessions: [], tasks: [], memories: [], people: [], projects: [], receipts: [], notifications: [], messages: [],
    recallCleared: false, settings: { name: '', role: '', space: '我的空间', tone: '', avatar: '',
      toggles: { cloud: false, memory: false, voice: false, notifications: true }, connections: {}, devices: {},
      retention: { Recall: '5分钟', 'personal-assistant-v1': JSON.stringify({ version: 1, personalizationEnabled: false, learningEnabled: false, candidates: [], rejectedKeys: [] }) } } };
}
const object = (value: unknown): value is NativeRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const rows = (value: unknown): NativeRecord[] => Array.isArray(value) ? value.filter(object).slice(0, 3000) : [];
const string = (value: unknown, max = 12000): string => typeof value === 'string' ? value.slice(0, max) : '';
const idOf = (row: NativeRecord): string => string(row.session_id || row.sessionId || row.id, 200);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const formatTime = (ms: unknown): string => {
  const value = Number(ms || 0), seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value / 1000)) : 0;
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const emptySnapshot = (): NativeBridgeSnapshot => ({ ready: false, connected: false, state: {}, backendUrl: '', serviceEpoch: null,
  scopeVersion: 0, history: [], sessions: {}, minutes: {}, items: [], tasks: [], account: null, context: null,
  transcript: [], partial: '', summary: null, board: null, error: null, capabilities: { pause: false } });
const responseFor = (type: string) => type.startsWith('personal.context.') ? 'personal.context' :
  type === 'feishu.disconnect' ? 'feishu.status' : type === 'feishu.connect' ? 'feishu.authorization' :
  type === 'items.review' ? 'items.saved' : type;
const remoteType = (type: string) => /^(history\.|tasks\.|items\.|projects\.|project\.|meeting\.|feishu\.|personal\.context|assistant\.|calendar\.|minutes\.)/.test(type);
const identityKey = (account: NativeRecord | null) => account?.status === 'connected' && object(account.account)
  ? JSON.stringify([account.binding_revision, account.account.open_id || account.account.openId, account.account.tenant_key || '']) : JSON.stringify([account?.status || 'unknown']);
const requestKey = (type: string, payload: NativeRecord) => JSON.stringify([type, payload.sessionId || payload.session_id || '',
  type === 'tasks.list' ? !!payload.mine : '', type === 'tasks.list' ? payload.status || 'open' : '']);

export class NativeBridgeError extends Error {
  code: string; payload?: NativeRecord;
  constructor(message: string, code = 'NATIVE_REQUEST_FAILED', payload?: NativeRecord) { super(message); this.name = 'NativeBridgeError'; this.code = code; this.payload = payload; }
}
type Request = { type: string; response: string; scope: number; epoch: number | null; key: string; payload: NativeRecord;
  resolve?: (value: NativeRecord) => void; reject?: (error: NativeBridgeError) => void; timer?: ReturnType<typeof setTimeout> };

/** Injectable transport for tests; the singleton below is the only listener used by the shared UI. */
export function createNativeBridge(getHost: () => NativeHost | undefined = hostWindow) {
  let current = emptySnapshot(), serial = 0, users = 0, activeChannel: NativeChannel | undefined;
  let previousHandler: NativeChannel['onmessage'];
  const listeners = new Set<() => void>(), requests = new Map<string, Request>(), latest = new Map<string, string>();
  const deletedSessions = new Set<string>();
  const knownNativeIds = new Set<string>(); // Scope-local provenance tombstones, never quotations.
  const notify = () => { for (const listener of listeners) listener(); };
  const rejectAll = () => { for (const request of requests.values()) { if (request.timer) clearTimeout(request.timer); request.reject?.(new NativeBridgeError('服务或账号已变化，请重新读取核对。', 'NATIVE_SCOPE_CHANGED')); } requests.clear(); latest.clear(); };
  const clearScope = () => {
    rejectAll();
    deletedSessions.clear();
    knownNativeIds.clear();
    current = { ...current, scopeVersion: current.scopeVersion + 1, history: [], sessions: {}, minutes: {}, items: [], tasks: [],
      account: null, context: null, transcript: [], partial: '', summary: null, board: null, error: null };
  };
  function dropSession(id: string, deleted = false) {
    if (!id) return;
    const sessions = { ...current.sessions }, minutes = { ...current.minutes };
    delete sessions[id]; delete minutes[id];
    current = { ...current, sessions, minutes, history: deleted ? current.history.filter(item => idOf(item) !== id) : current.history,
      tasks: current.tasks.map(item => item.session_id === id ? { ...item, quote: null, meeting: null, source_status: 'unavailable' } : item),
      items: current.items.filter(item => item.session_id !== id && item.source_meeting?.session_id !== id),
      ...(current.state.sessionId === id ? { transcript: [], summary: null, board: null } : {}) };
    if (deleted) {
      deletedSessions.add(id);
      for (const [requestId, pending] of requests) if ((pending.payload.sessionId || pending.payload.session_id) === id) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject?.(new NativeBridgeError('这场会议已删除，请返回重新读取。', 'NATIVE_SOURCE_DELETED'));
        requests.delete(requestId);
      }
    }
  }
  function invalidateRead(type: string, payload: NativeRecord) {
    const id = string(payload.sessionId || payload.session_id, 200);
    if (type === 'history.open') dropSession(id);
    if (type === 'history.minutes') { const minutes = { ...current.minutes }; delete minutes[id]; current = { ...current, minutes }; }
    if (type === 'history.list') current = { ...current, history: [], sessions: {}, minutes: {}, items: [],
      tasks: current.tasks.map(item => ({ ...item, quote: null, meeting: null, source_status: 'unavailable' })) };
    if (type === 'tasks.list') current = { ...current, tasks: [], items: [] };
  }
  function post(type: string, payload: NativeRecord = {}, callbacks?: Pick<Request, 'resolve' | 'reject'>, response = responseFor(type)): string {
    const channel = getHost()?.OopsNative;
    if (!channel) throw new NativeBridgeError('原生连接尚未就绪，请重新打开 App。', 'NATIVE_UNAVAILABLE');
    if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/.test(type) || !object(payload)) throw new NativeBridgeError('原生操作格式无效。', 'NATIVE_INVALID_REQUEST');
    if (/^history\.(open|minutes)$/.test(type) && deletedSessions.has(payload.sessionId || payload.session_id)) throw new NativeBridgeError('这场会议已删除，不能继续读取旧内容。', 'NATIVE_SOURCE_DELETED');
    // The real engine currently has no pause contract; never translate pause into stop.
    if ((type === 'capture.pause' || type === 'capture.resume') && !current.capabilities.pause) throw new NativeBridgeError('当前录音源尚不支持暂停，请结束本次记录。', 'NATIVE_PAUSE_UNSUPPORTED');
    const requestId = string(payload.requestId, 160) || `shared-${Date.now().toString(36)}-${++serial}`;
    if (requests.has(requestId)) throw new NativeBridgeError('这条请求仍在核对中。', 'NATIVE_REQUEST_PENDING');
    const key = requestKey(type, payload), request: Request = { type, response, scope: current.scopeVersion, epoch: current.serviceEpoch, key, payload: clone(payload), ...callbacks };
    invalidateRead(type, payload); // A refresh is unverified until its own successful reply.
    requests.set(requestId, request); latest.set(key, requestId);
    if (callbacks) request.timer = setTimeout(() => {
      requests.delete(requestId);
      callbacks.reject?.(new NativeBridgeError('尚未收到本次操作结果，请核对原操作；不会自动重新提交。', 'NATIVE_RESULT_UNKNOWN'));
    }, 25000);
    // Bound metadata only. No personal content or credential is persisted by the transport.
    if (requests.size > 300) for (const [id, item] of requests) if (!item.resolve) { requests.delete(id); if (requests.size <= 240) break; }
    try { channel.postMessage(JSON.stringify({ type, payload: { ...payload, requestId } })); }
    catch (error) { requests.delete(requestId); if (request.timer) clearTimeout(request.timer); throw error; }
    if (/^(history\.(list|open|minutes)|tasks\.list)$/.test(type)) notify();
    return requestId;
  }
  const readLists = () => { post('history.list'); post('tasks.list', { mine: false, status: 'all' }); };
  function accept(type: string, payload: NativeRecord): boolean {
    if (!remoteType(type) && type !== 'error') return true;
    if ('backendUrl' in payload && current.backendUrl && payload.backendUrl !== current.backendUrl) return false;
    if (Number.isSafeInteger(payload.serviceEpoch) && current.serviceEpoch !== null && payload.serviceEpoch !== current.serviceEpoch) return false;
    const request = requests.get(payload.requestId);
    const session = string(payload.sessionId || payload.session_id || request?.payload.sessionId || request?.payload.session_id, 200);
    if (type !== 'history.delete' && session && deletedSessions.has(session)) return false;
    if (payload.requestId && !request) return false;
    if (request && (request.scope !== current.scopeVersion || request.epoch !== null && request.epoch !== current.serviceEpoch || latest.get(request.key) !== payload.requestId)) return false;
    if (request && type !== 'error' && type !== request.response) return false;
    return true;
  }
  function receive(type: string, payload: NativeRecord) {
    const incomingState = type === 'snapshot' && object(payload.state) ? payload.state : payload;
    if ((type === 'state' || type === 'snapshot') && Number.isSafeInteger(incomingState.serviceEpoch) && current.serviceEpoch !== null && incomingState.serviceEpoch < current.serviceEpoch) return;
    if (!accept(type, payload)) return;
    const request = requests.get(payload.requestId);
    // Personal response identity must match the native verified binding; payload names cannot establish it.
    if (type === 'personal.context' && (current.account?.status !== 'connected' || payload.identity_revision !== current.account.binding_revision)) return;
    if (request) { if (request.timer) clearTimeout(request.timer); requests.delete(payload.requestId); }
    if (type === 'snapshot' || type === 'state') {
      const state = type === 'snapshot' && object(payload.state) ? payload.state : payload;
      const nextUrl = string(state.backendUrl, 2000), nextEpoch = Number.isSafeInteger(state.serviceEpoch) ? state.serviceEpoch : current.serviceEpoch;
      if (current.ready && (nextUrl !== current.backendUrl || nextEpoch !== current.serviceEpoch || state.backend !== current.state.backend)) clearScope();
      const nextSession = string(state.sessionId, 200);
      if (nextSession !== string(current.state.sessionId, 200)) current = { ...current, transcript: [], partial: '', summary: null, board: null };
      current = { ...current, ready: true, connected: true, state: { ...current.state, ...state }, backendUrl: nextUrl,
        serviceEpoch: nextEpoch, capabilities: { pause: state.capturePauseSupported === true } };
      if (type === 'snapshot') current = { ...current, transcript: rows(payload.transcript), summary: object(payload.summary) ? payload.summary : null,
        board: object(payload.board) ? payload.board : null };
      if (type === 'snapshot' || !current.account && ![...requests.values()].some(item => item.type === 'feishu.status')) post('feishu.status');
    } else if (type === 'backend.changed') {
      if (payload.serviceEpoch !== current.serviceEpoch || payload.backendUrl !== current.backendUrl || payload.backend !== current.state.backend) {
        clearScope(); current = { ...current, backendUrl: string(payload.backendUrl, 2000), serviceEpoch: Number.isSafeInteger(payload.serviceEpoch) ? payload.serviceEpoch : null,
          state: { ...current.state, backend: payload.backend, backendUrl: payload.backendUrl, sessionId: '' } };
        post('hello');
      }
    } else if (type === 'feishu.status') {
      const connected = payload.status === 'connected' && object(payload.account) && Number.isSafeInteger(payload.binding_revision) && !!string(payload.account.open_id || payload.account.openId);
      const next = connected ? payload : { ...payload, account: null };
      const changed = identityKey(current.account) !== identityKey(next);
      if (changed) clearScope();
      current = { ...current, account: clone(next) };
      if (changed) post('hello'); // Re-read native data under the newly verified scope, never revive an old cache.
      readLists();
      if (connected) post('personal.context.read');
    } else if (type === 'history.list') {
      const history = rows(payload.items).filter(item => !deletedSessions.has(idOf(item)));
      history.forEach(row => { const id = idOf(row); if (id) knownNativeIds.add(id); });
      const allowed = new Set(history.map(idOf));
      current = { ...current, history, sessions: Object.fromEntries(Object.entries(current.sessions).filter(([id]) => allowed.has(id))),
        minutes: Object.fromEntries(Object.entries(current.minutes).filter(([id]) => allowed.has(id))) };
    } else if (type === 'history.open') {
      const id = idOf(payload); if (id && (!request?.payload.sessionId || request.payload.sessionId === id)) { knownNativeIds.add(id); current = { ...current, sessions: { ...current.sessions, [id]: clone(payload) }, items: rows(payload.items?.items || payload.items) }; }
    } else if (type === 'history.minutes') {
      const id = idOf(payload); if (id) current = { ...current, minutes: { ...current.minutes, [id]: ['source_changed', 'unavailable', 'expired'].includes(payload.status) ? { ...payload, minutes: null, sources: [] } : clone(payload) } };
    } else if (type === 'history.delete') {
      const id = idOf(payload) || string(request?.payload.sessionId, 200); dropSession(id, true);
    } else if (type === 'tasks.list') {
      if (!payload.mine || payload.selfName === current.state.selfName) {
        const tasks = rows(payload.items); tasks.forEach(row => { const id = string(row.op_id || row.task_guid || row.id, 200); if (id) knownNativeIds.add(id); });
        current = { ...current, tasks, items: [...rows(payload.parsed_items), ...rows(payload.meeting_items)] };
      }
    } else if (type === 'items.saved') {
      const id = idOf(payload), existing = current.sessions[id];
      current = { ...current, items: rows(payload.items?.items || payload.items), sessions: existing ? { ...current.sessions, [id]: { ...existing, items: payload.items, review_queue: payload.review_queue } } : current.sessions };
    } else if (type === 'personal.context') {
      // Mutation receipts don't replace a full read with a partial item payload.
      if (Array.isArray(payload.memories)) current = { ...current, context: clone(payload) };
      else if (object(payload.item)) { current = { ...current, context: null }; post('personal.context.read'); }
    } else if (type === 'asr.partial') current = { ...current, partial: string(payload.text) };
    else if (type === 'asr.final') current = { ...current, partial: '', transcript: [...current.transcript.filter(item => item.id !== payload.id), clone(payload)].slice(-3000) };
    else if (type === 'asr.speaker' || type === 'asr.tag') current = { ...current, transcript: current.transcript.map(item => item.id === payload.id ? { ...item, ...payload } : item) };
    else if (type === 'transcript.pruned') { const ids = new Set(Array.isArray(payload.ids) ? payload.ids : []); current = { ...current, transcript: current.transcript.filter(item => !ids.has(item.id)), partial: '', summary: null }; }
    else if (type === 'capture.cleared' || type === 'capture.assetsExpired') current = { ...current, transcript: [], partial: '', summary: null, board: null };
    else if (type === 'session.summary') current = { ...current, summary: clone(payload) };
    else if (type === 'tasks.board') current = { ...current, board: clone(payload) };
    else if (type === 'error') {
      const operation = string(payload.operation || request?.type, 100);
      invalidateRead(operation, { ...request?.payload, ...payload });
      if (operation === 'history.open' || operation === 'history.minutes' && ([401, 403, 404, 410].includes(payload.httpStatus) || /SOURCE_CHANGED|IDENTITY_CHANGED/.test(payload.code || ''))) {
        const id = string(payload.sessionId || payload.session_id || request?.payload.sessionId, 200);
        dropSession(id); current = { ...current, history: current.history.filter(row => idOf(row) !== id) };
      }
      if (['items.review', 'review.set', 'speaker.correct'].includes(operation) && (payload.changed || payload.httpStatus === 409 || /SOURCE_CHANGED|IDENTITY_CHANGED/.test(payload.code || ''))) dropSession(string(payload.sessionId || request?.payload.sessionId, 200));
      if ([401, 403].includes(payload.httpStatus) && (payload.scope === 'personalContext' || payload.scope === 'feishu')) { clearScope(); current = { ...current, account: { status: 'expired', account: null } }; }
      current = { ...current, error: clone(payload) };
    }
    if (type === 'error') request?.reject?.(new NativeBridgeError(string(payload.message) || '本次操作未完成。', string(payload.code) || 'NATIVE_REQUEST_FAILED', payload));
    else request?.resolve?.(clone(payload));
    notify();
    const host = getHost();
    if (host?.dispatchEvent && typeof CustomEvent !== 'undefined') host.dispatchEvent(new CustomEvent('oops:native-message', { detail: { type, payload: clone(payload) } }));
  }
  const handler = (event: { data: string }) => {
    let message: unknown; try { message = JSON.parse(event.data); } catch { return; }
    if (object(message) && typeof message.type === 'string' && object(message.payload || {})) receive(message.type, message.payload || {});
  };
  function start(): () => void {
    users += 1;
    if (users === 1) {
      activeChannel = getHost()?.OopsNative;
      if (activeChannel) { previousHandler = activeChannel.onmessage; activeChannel.onmessage = handler; post('hello'); }
      else { current = { ...current, connected: false, error: { code: 'NATIVE_UNAVAILABLE', message: '原生连接尚未就绪，请重新打开 App。' } }; notify(); }
    }
    let stopped = false;
    return () => { if (stopped) return; stopped = true; if (--users === 0) { if (activeChannel?.onmessage === handler) activeChannel.onmessage = previousHandler; activeChannel = undefined; rejectAll(); } };
  }
  function localScope(): string | undefined {
    if (!current.ready) return undefined;
    if (!current.backendUrl) return JSON.stringify([current.state.backend || 'unconfigured', '', 'installation']);
    if (!current.account) return undefined;
    const account = current.account;
    if (!['connected', 'disconnected', 'unconfigured', 'unbound'].includes(account.status)) return undefined;
    if (account.status === 'connected' && (!object(account.account) || !Number.isSafeInteger(account.binding_revision))) return undefined;
    // No binding_revision in the persistent key: same verified account remains stable across relogin.
    return JSON.stringify([current.state.backend, current.backendUrl, account.status === 'connected' ? [account.account.open_id || account.account.openId, account.account.tenant_key || ''] : 'installation']);
  }
  function localData(data: AppData): AppData {
    const retention = data.settings.retention, remote = new Set([...knownNativeIds, ...Object.keys(retention).filter(key => /^native-(session|task|memory|person):/.test(key)).map(key => key.replace(/^native-(session|task|memory|person):/, ''))]);
    const localIds = { session: new Set(data.sessions.filter(row => !remote.has(row.id)).map(row => row.id)), task: new Set(data.tasks.filter(row => !remote.has(row.id)).map(row => row.id)), memory: new Set(data.memories.filter(row => !remote.has(row.id)).map(row => row.id)) };
    const unavailableSource = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(unavailableSource);
      if (!object(value)) return false;
      if (typeof value.sourceSession === 'string' && !localIds.session.has(value.sourceSession)) return true;
      if (typeof value.sourceMemoryId === 'string' && !localIds.memory.has(value.sourceMemoryId)) return true;
      if (Array.isArray(value.sources) && value.sources.some(ref => object(ref) && ['session', 'task', 'memory'].includes(ref.kind) && !localIds[ref.kind as keyof typeof localIds].has(ref.id))) return true;
      return Object.values(value).some(unavailableSource);
    };
    const linked = (item: NativeRecord) => remote.has(item.id) || unavailableSource(item) || [...remote].some(id => JSON.stringify(item).includes(JSON.stringify(id)));
    let safe = archiveSafeData(data);
    safe = { ...safe, sessions: safe.sessions.filter(item => !linked(item)), tasks: safe.tasks.filter(item => !linked(item)), memories: safe.memories.filter(item => !linked(item)),
      people: safe.people.filter(item => !linked(item)), messages: safe.messages.filter(item => !linked(item)), receipts: safe.receipts.filter(item => !remote.has(item.taskId)), notifications: [], activeSessionId: undefined,
      settings: { ...safe.settings, connections: {}, devices: {}, retention: Object.fromEntries(Object.entries(safe.settings.retention).filter(([key, value]) =>
        !key.startsWith('native-') && !/token|credential|password|backend|feishu/i.test(key) && ![...remote].some(id => key.includes(id) || value.includes(id)))) } };
    return safe;
  }
  function saveLocal(data: AppData): void {
    const scope = localScope(); if (!scope || data.settings.retention['native-scope-version'] !== String(current.scopeVersion)) return;
    getHost()?.localStorage?.setItem('oops-native-local-v1:' + scope, JSON.stringify({ version: 1, scope, data: localData(data) }));
  }
  function loadLocal(): AppData | null {
    const scope = localScope(); if (!scope) return null;
    try {
      const raw = getHost()?.localStorage?.getItem('oops-native-local-v1:' + scope); if (!raw || raw.length > 4000000) return null;
      const saved = JSON.parse(raw); if (saved?.version !== 1 || saved.scope !== scope || !object(saved.data?.settings?.retention) || !['sessions','tasks','memories','people','projects','receipts','messages','notifications'].every(key => Array.isArray(saved.data[key]))) return null;
      const data = localData(saved.data);
      return { ...data, settings: { ...data.settings, retention: { ...data.settings.retention, 'native-scope-version': String(current.scopeVersion) } } };
    } catch { return null; }
  }
  let projection: { data: AppData; result: AppData; parts: unknown[] } | undefined;
  function project(data: AppData): AppData {
    // Audio level/asr connection notifications are frequent; they do not rebuild every domain row.
    const parts = [current.scopeVersion, current.history, current.sessions, current.minutes, current.tasks, current.transcript,
      current.account, current.state.sessionId, current.state.capturing, current.state.capturePaused, current.state.recordingMode,
      current.state.transcriptExpired, Math.floor(Number(current.state.sessionMs || 0) / 1000)];
    if (projection && (projection.data === data || projection.result === data) && parts.every((part, index) => part === projection!.parts[index])) return projection.result;
    let base = data;
    if (data.settings.retention['native-scope-version'] !== String(current.scopeVersion)) base = createNativeData();
    const retention = { ...base.settings.retention }, nativeSessions = new Set(Object.keys(retention).filter(key => key.startsWith('native-session:')).map(key => key.slice(15))), nativeTasks = new Set(Object.keys(retention).filter(key => key.startsWith('native-task:')).map(key => key.slice(12)));
    for (const key of Object.keys(retention)) if (key.startsWith('native-session:') || key.startsWith('native-task:')) delete retention[key];
    retention['native-scope-version'] = String(current.scopeVersion);
    const mapTranscript = (row: NativeRecord): Transcript => ({ id: string(row.id, 200), speaker: string(row.speaker || row.manual_speaker, 100) || '待确认',
      text: string(row.display || row.text), time: formatTime(row.startMs ?? row.start_ms) });
    const rawLiveId = string(current.state.sessionId, 200), liveId = deletedSessions.has(rawLiveId) ? '' : rawLiveId, records = new Map(current.history.map(row => [idOf(row), row]));
    if (liveId) knownNativeIds.add(liveId);
    for (const [id, row] of Object.entries(current.sessions)) records.set(id, { ...records.get(id), ...row });
    if (liveId) records.set(liveId, { ...records.get(liveId), session_id: liveId });
    const sessions: Session[] = [];
    for (const [id, row] of records) {
      if (!id) continue;
      const live = id === liveId, transcript = live ? current.transcript : rows(row.utterances);
      const archived = !live || current.state.recordingMode === 'meeting';
      const textAvailable = !(live ? current.state.transcriptExpired : row.transcript_expired);
      const session: Session = { id, title: string(row.display_title || row.title || row.goal, 300) || (live ? current.state.recordingMode === 'meeting' ? '正在记录的会议' : '日常记录' : '往期会议'),
        kind: live && !archived ? '日常' : '会议', status: live && current.state.capturing ? current.state.capturePaused ? '暂停' : '进行中' : '已结束',
        date: string(row.started_at, 100), duration: live ? formatTime(current.state.sessionMs) : formatTime(row.duration_ms || (row.ended_at && row.started_at ? Date.parse(row.ended_at) - Date.parse(row.started_at) : 0)),
        transcript: textAvailable ? transcript.filter(turn => !turn.filler).map(mapTranscript) : [], summary: [], agenda: [], participants: [...new Set(transcript.map(turn => string(turn.speaker, 100)).filter(Boolean))],
        attachments: [], privateNotes: [], project: string(typeof row.project === 'string' ? row.project : row.project?.name, 200) };
      const minutes = current.minutes[id];
      if (minutes?.status === 'ready' && object(minutes.minutes)) session.summary = rows(minutes.minutes.sections).map(section => string(section.content || section.text)).filter(Boolean);
      retention['native-session:' + id] = 'readonly'; retention['session-space:' + id] = '我的空间'; sessions.push(session);
    }
    const tasks: Task[] = current.tasks.flatMap(row => {
      const id = string(row.op_id || row.task_guid || row.id, 200); if (!id) return [];
      const sourceSession = string(row.session_id, 200), sourceId = string(row.utterance_id, 200), sourceValid = !['unavailable','changed','source_changed','expired'].includes(row.source_status);
      retention['native-task:' + id] = 'readonly'; retention['task-space:' + id] = '我的空间';
      return [{ id, title: string(row.what || row.title, 500), description: sourceValid ? string(row.quote) : '', owner: string(row.who || row.owner, 100), requester: '',
        due: string(row.when_raw || row.when_iso || row.due, 100), priority: row.overdue ? '高' : '中', status: row.feishu?.state === 'done' ? '已完成' : row.feishu?.state === 'deleted' ? '已取消' : '已承接', aiStatus: '未启动',
        sourceSession: sourceValid && sourceSession ? sourceSession : undefined, sourceId: sourceValid && sourceId ? sourceId : undefined,
        activities: ['从已连接服务读取，编辑与外部操作请在原生任务中核对。'], results: [], authorized: false, version: Number.isSafeInteger(row.revision) ? row.revision : 1 } as Task];
    });
    const result: AppData = { ...base, sessions: [...base.sessions.filter(item => !nativeSessions.has(item.id) && !records.has(item.id)), ...sessions],
      tasks: [...base.tasks.filter(item => !nativeTasks.has(item.id) && !tasks.some(task => task.id === item.id)), ...tasks],
      activeSessionId: liveId && current.state.capturing ? liveId : undefined,
      settings: { ...base.settings, name: base.settings.name || string(current.account?.account?.name || current.state.selfName, 80), avatar: base.settings.avatar || string(current.account?.account?.name || current.state.selfName, 1),
        connections: { ...base.settings.connections, 飞书: current.account?.status === 'connected' }, retention } };
    projection = { data, result, parts }; return result;
  }
  return { start, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot: () => current,
    send: (type: string, payload: NativeRecord = {}) => post(type, payload),
    request: (type: string, payload: NativeRecord = {}, responseType = responseFor(type)): Promise<NativeRecord> => new Promise((resolve, reject) => { try { post(type, payload, { resolve, reject }, responseType); } catch (error) { reject(error); } }),
    project, localScope, loadLocal, saveLocal };
}
export const nativeBridge = createNativeBridge();
