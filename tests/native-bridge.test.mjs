import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(target.pathname)) for (const extension of ['.ts', '.tsx', '.js', '.mjs']) {
      const candidate = new URL(target.href + extension); if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
} });
const { createNativeBridge, createNativeData, isNativeHost } = await import('../src/nativeBridge.ts');
function fixture() {
  const sent = [], events = [], storage = new Map();
  const host = { __OOPS_NATIVE_APP__: true, OopsNative: { postMessage: data => sent.push(JSON.parse(data)), onmessage: null },
    dispatchEvent: event => { events.push(event); return true; }, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } };
  const bridge = createNativeBridge(() => host), stop = bridge.start();
  const emit = (type, payload = {}) => host.OopsNative.onmessage({ data: JSON.stringify({ type, payload }) });
  const reply = (requestType, type, payload = {}) => { const request = sent.findLast(item => item.type === requestType); assert.ok(request, requestType); emit(type, { serviceEpoch: 0, backendUrl: 'https://service.example', requestId: request.payload.requestId, ...payload }); };
  const state = { backend: 'http', backendUrl: 'https://service.example', serviceEpoch: 0, capturing: false, sessionId: '', selfName: '本人' };
  const snapshot = (extra = {}) => emit('snapshot', { state, transcript: [], ...extra });
  const account = (openId = 'account-a', revision = 1) => reply('feishu.status', 'feishu.status', { status: 'connected', account: { open_id: openId, name: '本人' }, binding_revision: revision });
  return { bridge, host, sent, events, storage, emit, reply, state, snapshot, account, stop };
}
test('native marker without a channel remains an empty real state, never website samples', () => {
  assert.equal(isNativeHost({ __OOPS_NATIVE_APP__: true }), true);
  assert.equal(isNativeHost({}), false);
  const data = createNativeData();
  for (const key of ['sessions', 'tasks', 'memories', 'people', 'projects', 'receipts', 'messages']) assert.deepEqual(data[key], []);
  assert.equal(data.settings.name, ''); assert.equal(data.settings.toggles.cloud, false);
  const bridge = createNativeBridge(() => ({ __OOPS_NATIVE_APP__: true })); bridge.start();
  assert.equal(bridge.snapshot().connected, false); assert.equal(bridge.localScope(), undefined);
});
test('start is shared and cleans up only its own listener', () => {
  const f = fixture(), second = f.bridge.start();
  assert.equal(f.sent.filter(x => x.type === 'hello').length, 1);
  f.stop(); assert.equal(typeof f.host.OopsNative.onmessage, 'function'); second(); assert.equal(f.host.OopsNative.onmessage, null);
});
test('snapshot and native messages preserve insets event for shared runtime', () => {
  const f = fixture(); f.snapshot({ insets: { top: 30, bottom: 20 } });
  assert.equal(f.bridge.snapshot().ready, true);
  assert.equal(f.events.at(-1).type, 'oops:native-message'); assert.deepEqual(f.events.at(-1).detail.payload.insets, { top: 30, bottom: 20 }); f.stop();
});
test('actual history, source utterance IDs and formal tasks project read only with no guessed person binding', () => {
  const f = fixture(); f.snapshot(); f.account();
  f.reply('history.list', 'history.list', { items: [{ session_id: 'meeting-a', title: '真实会议', started_at: '2026-10-16T10:00:00Z' }] });
  f.bridge.send('history.open', { sessionId: 'meeting-a' });
  f.reply('history.open', 'history.open', { session_id: 'meeting-a', utterances: [{ id: 'exact-source', text: '原话', speaker: '同名人物', start_ms: 1200 }] });
  f.reply('tasks.list', 'tasks.list', { items: [{ op_id: 'real-op', what: '正式任务', who: '负责人', session_id: 'meeting-a', utterance_id: 'exact-source', quote: '原话', feishu: { state: 'done' } }], parsed_items: [{ id: 'candidate', title: '未确认候选' }] });
  const data = f.bridge.project(createNativeData());
  assert.equal(data.sessions[0].transcript[0].id, 'exact-source'); assert.equal(data.sessions[0].transcript[0].personId, undefined);
  assert.equal(data.settings.retention['native-session:meeting-a'], 'readonly');
  assert.equal(data.tasks.length, 1); assert.equal(data.tasks[0].status, '已完成'); assert.equal(data.tasks[0].authorized, false);
  assert.equal(data.tasks[0].sourceId, 'exact-source'); assert.equal(data.settings.retention['native-task:real-op'], 'readonly');
  assert.equal(f.bridge.snapshot().items[0].id, 'candidate'); f.stop();
});
test('native live transcript is memory only, final updates do not duplicate and prune cannot revive sources', () => {
  const f = fixture(); f.snapshot(); f.account();
  f.emit('snapshot', { state: { ...f.state, capturing: true, sessionId: 'live', recordingMode: 'daily', sessionMs: 5000 }, transcript: [{ id: 'u1', text: '初稿', startMs: 1000 }] });
  f.emit('asr.final', { id: 'u1', text: '定稿', startMs: 1000 }); f.emit('asr.speaker', { id: 'u1', speaker: '同名人物' });
  let data = f.bridge.project(createNativeData()); assert.equal(data.sessions[0].transcript.length, 1); assert.equal(data.sessions[0].transcript[0].text, '定稿'); assert.equal(data.activeSessionId, 'live');
  f.emit('transcript.pruned', { ids: ['u1'] }); f.emit('asr.speaker', { id: 'u1', speaker: '迟到姓名' });
  data = f.bridge.project(data); assert.deepEqual(data.sessions[0].transcript, []);
  f.emit('capture.cleared', { mode: 'daily' }); assert.deepEqual(f.bridge.snapshot().transcript, []); f.stop();
});
test('service epoch switch clears projections and rejects old request replies and lower state epochs', async () => {
  const f = fixture(); f.snapshot(); f.account();
  f.reply('history.list', 'history.list', { items: [{ session_id: 'old' }] });
  const pending = f.bridge.request('history.open', { sessionId: 'old' }, 'history.open');
  const oldRequest = f.sent.at(-1).payload.requestId;
  const rejected = assert.rejects(pending, error => error.code === 'NATIVE_SCOPE_CHANGED');
  f.emit('backend.changed', { backend: 'http', backendUrl: 'https://new.example', serviceEpoch: 1 }); await rejected;
  f.emit('history.open', { requestId: oldRequest, session_id: 'old', backendUrl: 'https://service.example', serviceEpoch: 0, utterances: [{ id: 'u', text: '旧正文' }] });
  f.snapshot();
  assert.equal(f.bridge.snapshot().backendUrl, 'https://new.example'); assert.deepEqual(f.bridge.snapshot().history, []); assert.deepEqual(f.bridge.snapshot().sessions, {});
  assert.deepEqual(f.bridge.project(createNativeData()).sessions, []); f.stop();
});
test('account binding revision changes immediately clear private data and late personal replies', () => {
  const f = fixture(); f.snapshot(); f.account();
  const oldRequest = f.sent.findLast(x => x.type === 'personal.context.read').payload.requestId;
  f.bridge.send('feishu.status'); f.account('account-b', 2);
  f.emit('personal.context', { requestId: oldRequest, identity_revision: 1, context_revision: 1, memories: [{ body: '旧账号正文' }], serviceEpoch: 0, backendUrl: 'https://service.example' });
  assert.equal(f.bridge.snapshot().context, null); assert.equal(f.bridge.snapshot().account.account.open_id, 'account-b'); f.stop();
});
test('person preferences remain raw context and never refill the current users global preferences', () => {
  const f = fixture(); f.snapshot(); f.account();
  f.reply('personal.context.read', 'personal.context', { identity_revision: 1, context_revision: 1, preferences: { value: { enabled: true, tone: '会议专用语气', scenarios: ['会议'] } }, memories: [{ id: 'person-pref', status: 'current', value: { category: 'person', person_id: 'person-1', person_kind: 'preference', body: '对方希望更简短' } }] });
  const data = f.bridge.project(createNativeData()); assert.equal(data.settings.tone, ''); assert.deepEqual(data.memories, []);
  assert.equal(f.bridge.snapshot().context.memories[0].value.person_id, 'person-1'); f.stop();
});
test('source-changed minutes omit stale body and deleted history cannot retain quoted task sources', () => {
  const f = fixture(); f.snapshot(); f.account();
  f.bridge.send('history.minutes', { sessionId: 'meeting-a' });
  f.reply('history.minutes', 'history.minutes', { session_id: 'meeting-a', status: 'source_changed', minutes: { content: '旧正文' }, sources: ['旧引用'] });
  assert.equal(f.bridge.snapshot().minutes['meeting-a'].minutes, null);
  f.reply('tasks.list', 'tasks.list', { items: [{ op_id: 'op', what: '任务', session_id: 'meeting-a', quote: '原话' }] });
  f.bridge.send('history.delete', { sessionId: 'meeting-a', confirm: true }); f.reply('history.delete', 'history.delete', { session_id: 'meeting-a' });
  const task = f.bridge.project(createNativeData()).tasks[0]; assert.equal(task.description, ''); assert.equal(task.sourceSession, undefined); f.stop();
});
test('request promise resolves only exact current response; it does not retry unknown writes', async () => {
  const f = fixture(); f.snapshot(); f.account();
  const promise = f.bridge.request('settings.set', { noticeVibrate: false }, 'settings.saved');
  const id = f.sent.at(-1).payload.requestId;
  f.emit('settings.saved', { requestId: id, status: 'saved' }); assert.equal((await promise).status, 'saved');
  const write = f.bridge.request('personal.context.memory', { op_id: 'SAME-OP', value: { title: '草稿' } }, 'personal.context');
  f.emit('error', { requestId: f.sent.at(-1).payload.requestId, scope: 'personalContext', operation: 'personal.context.memory', message: '网络未知', code: 'NETWORK_ERROR' });
  await assert.rejects(write, error => error.code === 'NETWORK_ERROR');
  assert.equal(f.sent.filter(item => item.type === 'personal.context.memory').length, 1); f.stop();
});
test('all native personal 401/403 failures clear the old scope and cannot load an installation cache', () => {
  const f = fixture(); f.snapshot(); f.account(); let data = f.bridge.project(createNativeData());
  data = { ...data, memories: [{ id: 'local-note', title: '本人笔记', body: '私有', category: '记忆', visibility: '私有', tags: [], confirmed: true, updated: '今天' }] };
  f.bridge.saveLocal(data); assert.ok(f.bridge.loadLocal());
  f.bridge.send('personal.context.read'); f.emit('error', { requestId: f.sent.at(-1).payload.requestId, scope: 'personalContext', httpStatus: 403, message: '撤权' });
  assert.equal(f.bridge.localScope(), undefined); assert.equal(f.bridge.loadLocal(), null); assert.deepEqual(f.bridge.project(data).memories, []); f.stop();
});
test('native cache stores only local objects and strips source-linked copies, remote projection and connection flags', () => {
  const f = fixture(); f.snapshot(); f.account();
  f.reply('history.list', 'history.list', { items: [{ session_id: 'server-meeting', title: '不应存盘' }] });
  let data = f.bridge.project(createNativeData());
  data.memories.push({ id: 'local', title: '手写', body: '本人内容', category: '记忆', visibility: '私有', tags: [], confirmed: true, updated: '今天' });
  data.memories.push({ ...data.memories[0], id: 'derived', body: '服务来源副本', sources: [{ kind: 'session', id: 'server-meeting' }] });
  data.settings.retention.backendToken = 'never-cache'; f.bridge.saveLocal(data);
  const saved = [...f.storage.values()][0]; assert.doesNotMatch(saved, /不应存盘|server-meeting|服务来源副本|never-cache/);
  const loaded = f.bridge.loadLocal(); assert.equal(loaded.memories.length, 1); assert.equal(loaded.memories[0].id, 'local'); assert.deepEqual(loaded.settings.connections, {}); f.stop();
});
test('installation, verified accounts and services never migrate local drafts across scopes', () => {
  const f = fixture(); f.snapshot(); f.reply('feishu.status', 'feishu.status', { status: 'disconnected' });
  let data = f.bridge.project(createNativeData()); data.people.push({ id: 'manual', name: '手工人物', role: '', company: '', note: '', shared: false, voice: false });
  f.bridge.saveLocal(data); assert.equal(f.bridge.loadLocal().people.length, 1);
  f.bridge.send('feishu.status'); f.account(); assert.equal(f.bridge.loadLocal(), null);
  f.bridge.send('feishu.status'); f.account('account-b', 2); assert.equal(f.bridge.loadLocal(), null); f.stop();
});
test('unsupported pause never secretly sends stop or opens a new session', () => {
  const f = fixture(); f.snapshot(); assert.throws(() => f.bridge.send('capture.pause'), error => error.code === 'NATIVE_PAUSE_UNSUPPORTED');
  assert.equal(f.sent.some(x => x.type === 'capture.stop' || x.type === 'capture.start'), false); f.stop();
});
test('verified microphone pause capability sends real pause and resume without replacing session', () => {
  const f = fixture(); f.snapshot({ state: { ...f.state, sessionId: 'same-live-id', capturing: true, capturePauseSupported: true } });
  f.bridge.send('capture.pause'); assert.equal(f.sent.at(-1).type, 'capture.pause');
  f.emit('state', { ...f.state, sessionId: 'same-live-id', capturing: true, capturePauseSupported: true, capturePaused: true, sessionMs: 2000 });
  assert.equal(f.bridge.project(createNativeData()).sessions[0].status, '暂停');
  f.bridge.send('capture.resume'); assert.equal(f.sent.at(-1).type, 'capture.resume');
  assert.equal(f.bridge.snapshot().state.sessionId, 'same-live-id'); assert.equal(f.sent.some(item => item.type === 'capture.start' || item.type === 'capture.stop'), false); f.stop();
});
test('refresh removes old source body before response and failures cannot leave it current', () => {
  const f = fixture(); f.snapshot(); f.account();
  f.reply('history.list', 'history.list', { items: [{ session_id: 'private' }] });
  f.bridge.send('history.open', { sessionId: 'private' }); f.reply('history.open', 'history.open', { session_id: 'private', utterances: [{ id: 'u', text: '受限正文' }] });
  f.bridge.send('history.open', { sessionId: 'private' });
  assert.equal(f.bridge.project(createNativeData()).sessions[0].transcript.length, 0);
  f.emit('error', { requestId: f.sent.at(-1).payload.requestId, operation: 'history.open', sessionId: 'private', httpStatus: 403, message: '权限已撤回' });
  assert.equal(f.bridge.snapshot().sessions.private, undefined);
  f.bridge.send('tasks.list', { mine: false, status: 'all' });
  f.reply('tasks.list', 'tasks.list', { items: [{ op_id: 'op', what: '任务', quote: '受限正文', session_id: 'private' }] });
  f.bridge.send('tasks.list', { mine: false, status: 'all' });
  f.emit('error', { requestId: f.sent.at(-1).payload.requestId, operation: 'tasks.list', httpStatus: 403, message: '失败' });
  assert.deepEqual(f.bridge.snapshot().tasks, []); assert.deepEqual(f.bridge.project(createNativeData()).tasks, []); f.stop();
});
test('delete tombstone cancels in-flight source reads and blocks late success or stale list resurrection', async () => {
  const f = fixture(); f.snapshot(); f.account();
  f.reply('history.list', 'history.list', { items: [{ session_id: 'removed' }] });
  const pending = f.bridge.request('history.open', { sessionId: 'removed' }, 'history.open'); const open = f.sent.at(-1).payload.requestId;
  const rejected = assert.rejects(pending, error => error.code === 'NATIVE_SOURCE_DELETED');
  f.bridge.send('history.minutes', { sessionId: 'removed' }); const minutes = f.sent.at(-1).payload.requestId;
  f.bridge.send('history.delete', { sessionId: 'removed', confirm: true }); f.reply('history.delete', 'history.delete', { session_id: 'removed' }); await rejected;
  f.emit('history.open', { requestId: open, session_id: 'removed', utterances: [{ id: 'u', text: '不应复活' }] });
  f.emit('history.minutes', { requestId: minutes, session_id: 'removed', status: 'ready', minutes: { content: '不应复活' } });
  f.bridge.send('history.list'); f.reply('history.list', 'history.list', { items: [{ session_id: 'removed' }] });
  assert.deepEqual(f.bridge.project(createNativeData()).sessions, []); assert.equal(f.bridge.snapshot().minutes.removed, undefined);
  assert.throws(() => f.bridge.send('history.open', { sessionId: 'removed' }), error => error.code === 'NATIVE_SOURCE_DELETED'); f.stop();
});
test('new install can persist local notes before service setup and state-only level ticks reuse projection', () => {
  const f = fixture(); f.emit('snapshot', { state: { backend: 'mock', backendUrl: '', serviceEpoch: 0, capturing: false }, transcript: [] });
  let data = f.bridge.project(createNativeData()); data = { ...data, people: [{ id: 'manual', name: '本机人物', role: '', company: '', note: '', shared: false, voice: false }] };
  f.bridge.saveLocal(data); assert.equal(f.bridge.loadLocal().people[0].name, '本机人物');
  const projected = f.bridge.project(data); f.emit('state', { backend: 'mock', backendUrl: '', serviceEpoch: 0, capturing: false, level: 0.3 });
  assert.equal(f.bridge.project(projected), projected); f.stop();
});
test('removed native markers cannot make source-derived private copies eligible for local cache', () => {
  const f = fixture(); f.snapshot(); f.account(); f.reply('history.list', 'history.list', { items: [{ session_id: 'server-source' }] });
  let data = f.bridge.project(createNativeData());
  data.memories.push({ id: 'derived', title: '摘录', body: '不能离线复活的服务原话', category: '记忆', visibility: '私有', tags: [], confirmed: true, updated: '今天', sources: [{ kind: 'session', id: 'server-source' }] });
  f.bridge.send('history.list'); f.emit('error', { requestId: f.sent.at(-1).payload.requestId, operation: 'history.list', scope: 'history', httpStatus: 403 });
  data = f.bridge.project(data); assert.equal(data.settings.retention['native-session:server-source'], undefined);
  f.bridge.saveLocal(data); assert.doesNotMatch([...f.storage.values()].join(''), /不能离线复活|server-source/); assert.deepEqual(f.bridge.loadLocal().memories, []); f.stop();
});
test('explicit native self selection can filter tasks without pretending it is a verified account', () => {
  const f = fixture(); f.snapshot(); f.reply('feishu.status', 'feishu.status', { status: 'disconnected' });
  const data = f.bridge.project(createNativeData()); assert.equal(data.settings.name, '本人'); assert.equal(data.settings.connections.飞书, false); f.stop();
});
