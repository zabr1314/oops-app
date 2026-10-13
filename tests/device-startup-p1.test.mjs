import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(url.pathname)) for (const ext of ['.ts', '.tsx']) if (existsSync(new URL(url.href + ext))) return next(url.href + ext, context);
  }
  return next(specifier, context);
} });
const store = readFileSync(new URL('../src/store.tsx', import.meta.url), 'utf8');
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(store.slice(store.indexOf('export function initialData')), { mode: 'strip' })).toString('base64'));
const { autoListenEnabled, deviceStartupStatus, initialDeviceRuntime, pairStartupDevice, setAutoListenPreference,
  transitionDeviceStartup, unpairStartupDevice, reconcileDeviceStartupHolds } = await import('../src/deviceStartupLogic.ts');
const { finishDailySession, archiveSafeData, switchDailyToMeeting, applyStorageDeadlines } = await import('../src/storagePolicy.ts');
const DEVICE = '录音豆', NOW = new Date('2026-10-12T04:00:00Z');
const READY = { condition: 'ready', recoveryRequired: false };
const event = (data, runtime = READY, type = 'signal', sessionId = 'device-daily-1') => transitionDeviceStartup(data, runtime, DEVICE, { type }, { sessionId, now: NOW });
const paired = (enabled = true) => pairStartupDevice(initialData(), DEVICE, enabled);
const active = data => data.sessions.filter(s => ['进行中', '暂停'].includes(s.status));

test('unpaired and untouched devices have no automatic-listening permission or fake runtime state', () => {
  const data = initialData(), before = structuredClone(data);
  assert.equal(autoListenEnabled(data, DEVICE), false);
  assert.deepEqual(initialDeviceRuntime(), { condition: 'off', recoveryRequired: false });
  assert.equal(event(data).data, data); assert.deepEqual(data, before);
});
test('pairing requires a separate explicit choice and never starts a session or expands voice, memory, sharing or cloud permissions', () => {
  const data = initialData(), before = structuredClone(data);
  for (const selected of [false, true]) {
    const next = pairStartupDevice(data, DEVICE, selected);
    assert.equal(autoListenEnabled(next, DEVICE), selected);
    assert.deepEqual(next.sessions, data.sessions); assert.equal(next.activeSessionId, data.activeSessionId);
    for (const key of ['voice', 'memory', 'cloud', 'ownVoiceShare']) assert.equal(next.settings.toggles[key], data.settings.toggles[key]);
    assert.deepEqual(next.people, data.people); assert.deepEqual(next.receipts, data.receipts);
  }
  assert.deepEqual(data, before);
});
test('preference off means boot only connects; preference edits themselves never start recordings', () => {
  const data = paired(false);
  assert.equal(event(data).data, data);
  const changed = setAutoListenPreference(data, DEVICE, true);
  assert.deepEqual(changed.sessions, data.sessions);
  assert.equal(active(changed).length, 0);
  assert.equal(autoListenEnabled(changed, '桌面伙伴'), false);
});
for (const condition of ['off', 'permission', 'background', 'disconnected', 'quiet', 'service']) test(`a ${condition} signal cannot start or resume a daily recording`, () => {
  const data = paired(), runtime = { condition, recoveryRequired: false };
  for (const action of ['signal', 'recover']) assert.equal(event(data, runtime, action).data, data);
  assert.equal(deviceStartupStatus(data, DEVICE, runtime, NOW).phase, 'blocked');
});
test('recording privacy choice and actual configured quiet hours independently block a ready signal', () => {
  const data = paired(); data.settings.toggles.recordingAllowed = false;
  assert.equal(event(data).data, data);
  data.settings.toggles.recordingAllowed = true;
  data.settings.retention['listening-config:我的空间'] = JSON.stringify({ quietEnabled: true, quietStart: '11:00', quietEnd: '13:00' });
  assert.equal(event(data).data, data);
});
test('one eligible boot creates one private daily session with the existing five-minute storage policy', () => {
  const result = event(paired()), session = result.data.sessions[0];
  assert.equal(session.kind, '日常'); assert.equal(session.status, '进行中');
  assert.equal(session.storage.mode, 'daily'); assert.equal(session.storage.cloudSaveConfirmed, false);
  assert.equal(result.data.settings.space, '我的空间');
  assert.equal(result.data.settings.toggles['shared-' + session.id], false);
  assert.deepEqual(session.transcript, []); assert.deepEqual(session.savedEvidence, undefined);
  const repeated = event(result.data, READY, 'signal', 'different-request');
  assert.equal(repeated.data, result.data); assert.equal(active(repeated.data).length, 1);
});
test('a meeting or another active daily record always takes precedence, preserving ID, mode, storage contract and data', () => {
  for (const kind of ['会议', '日常']) {
    const data = paired(); data.sessions[0].kind = kind; data.sessions[0].status = '进行中'; data.activeSessionId = data.sessions[0].id;
    const before = structuredClone(data);
    for (const type of ['signal', 'recover', 'pause']) assert.equal(event(data, READY, type).data, data);
    assert.equal(deviceStartupStatus(data, DEVICE, READY, NOW).phase, 'occupied'); assert.deepEqual(data, before);
  }
});
test('multiple active or mismatched current session records cannot cause a duplicate startup', () => {
  const data = event(paired()).data; data.activeSessionId = undefined;
  assert.equal(event(data).data, data);
  data.activeSessionId = data.sessions[0].id; data.sessions[1].status = '暂停';
  assert.equal(event(data).data, data);
});
test('after a permission failure ready and reconnect leave recovery pending; explicit recovery starts once', () => {
  let result = transitionDeviceStartup(paired(), READY, DEVICE, { type: 'condition', condition: 'permission' }, { sessionId: '', now: NOW });
  result = transitionDeviceStartup(result.data, result.runtime, DEVICE, { type: 'condition', condition: 'ready' }, { sessionId: '', now: NOW });
  assert.equal(result.runtime.recoveryRequired, true);
  assert.equal(event(result.data, result.runtime).data, result.data);
  const recovered = event(result.data, result.runtime, 'recover');
  assert.equal(active(recovered.data).length, 1); assert.equal(recovered.runtime.recoveryRequired, false);
});
test('losing connectivity pauses only the owning daily; explicit recovery resumes that same ID', () => {
  const started = event(paired());
  const blocked = transitionDeviceStartup(started.data, READY, DEVICE, { type: 'condition', condition: 'disconnected' }, { sessionId: '', now: NOW });
  assert.equal(blocked.data.sessions[0].status, '暂停');
  const ready = { condition: 'ready', recoveryRequired: true };
  assert.equal(event(blocked.data, ready).data, blocked.data);
  const resumed = event(blocked.data, ready, 'recover', 'should-not-be-created');
  assert.equal(resumed.sessionId, started.sessionId); assert.equal(resumed.data.sessions[0].status, '进行中'); assert.equal(active(resumed.data).length, 1);
});
test('manual pause through shared controls prevents reconnect, and explicit continue uses the same session', () => {
  const started = event(paired()).data;
  const manuallyPaused = { ...started, sessions: started.sessions.map(s => s.id === started.activeSessionId ? { ...s, status: '暂停' } : s) };
  const paused = reconcileDeviceStartupHolds(started, manuallyPaused);
  assert.equal(event(paused).data, paused);
  const resumed = event(paused, READY, 'recover');
  assert.equal(resumed.sessionId, started.activeSessionId); assert.equal(active(resumed.data).length, 1);
});
test('stop and daily full-text cleanup preserve the user hold even when source metadata is removed', () => {
  const started = event(paired()).data;
  started.sessions[0].transcript = [{ id: 'temp', text: 'TEMP_SENTINEL_FULL_TEXT', speaker: '我', time: '00:00:01', receivedAt: NOW.getTime() }];
  const stopped = reconcileDeviceStartupHolds(started, finishDailySession(started, started.activeSessionId, [], NOW.getTime()));
  assert.equal(stopped.settings.retention['device-startup-hold:录音豆'], 'stopped');
  assert.equal(event(stopped).data, stopped);
  const restarted = event(stopped, READY, 'recover', 'new-device-daily');
  assert.equal(restarted.sessionId, 'new-device-daily'); assert.equal(active(restarted.data).length, 1);
  assert.equal(stopped.sessions[0].status, '已结束');
});
test('daily-to-meeting conversion and reconnect never turn the formal archive back into daily or start a second session', () => {
  const started = event(paired()).data;
  const switched = switchDailyToMeeting(started, started.activeSessionId, 'formal', true, false, 7, 90, NOW.getTime()).data;
  const next = reconcileDeviceStartupHolds(started, switched), before = structuredClone(next);
  assert.equal(event(next).data, next);
  assert.equal(next.sessions[0].storage.mode, 'meeting'); assert.equal(next.sessions[0].storage.audioRetentionDays, 7);
  assert.equal(next.sessions[0].storage.transcriptRetentionDays, 90); assert.deepEqual(next, before);
});
test('unpair closes automatic startup selection and pauses current daily without deleting saved content', () => {
  const started = event(paired()).data, next = unpairStartupDevice(started, DEVICE);
  assert.equal(autoListenEnabled(next, DEVICE), false); assert.equal(next.settings.devices[DEVICE], false);
  assert.equal(next.sessions[0].status, '暂停'); assert.equal(next.sessions.length, started.sessions.length);
  assert.equal(event(next).data, next);
});
test('refresh-safe archive drops transient full text and running state; subsequent signal still waits for explicit recovery', () => {
  const started = event(paired()).data, safe = archiveSafeData(started, NOW.getTime());
  assert.equal(safe.activeSessionId, undefined); assert.equal(safe.sessions[0].status, '已结束');
  assert.equal(event(safe).data, safe);
  const view = readFileSync(new URL('../src/viewState.tsx', import.meta.url), 'utf8');
  assert.match(view, /key\.startsWith\('device-startup-runtime:'\)/);
});
test('five-minute source cleanup keeps device ownership, so pause and recovery remain available', () => {
  const started = event(paired()).data;
  started.sessions[0].transcript = [{ id: 'old-buffer', text: 'expired daily full text', speaker: '我', time: '00:00:00', receivedAt: NOW.getTime() }];
  const cleaned = applyStorageDeadlines(started, NOW.getTime() + 301000);
  assert.equal(cleaned.sessions[0].transcript.length, 0);
  assert.equal(deviceStartupStatus(cleaned, DEVICE, READY, NOW).phase, 'listening');
  const paused = event(cleaned, READY, 'pause');
  assert.equal(paused.data.sessions[0].status, '暂停');
  assert.equal(event(paused.data, READY, 'recover').sessionId, started.activeSessionId);
});
test('switching the viewed content scope cannot bypass the personal device quiet schedule', () => {
  const data = paired(); data.settings.space = 'Oops 产品团队';
  data.settings.retention['listening-config:我的空间'] = JSON.stringify({ quietEnabled: true, quietStart: '11:00', quietEnd: '13:00' });
  data.settings.retention['listening-config:Oops 产品团队'] = JSON.stringify({ quietEnabled: false });
  assert.equal(event(data).data, data);
  assert.equal(deviceStartupStatus(data, DEVICE, READY, NOW).title, '现在是安静时段');
});
