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
const { DAILY_WINDOW_MS, retentionDays, newStoragePolicy, pinSessionEvidence, finishDailySession,
  applyStorageDeadlines, archiveSafeData, switchDailyToMeeting, reconcileSavedEvidence, pinExplicitDerivations,
  availableSessionTurns } = await import('../src/storagePolicy.ts');
const { makeSourceReference, sourceAvailable, taskSourceAvailable, provenanceAvailable, findSourceTask, invalidateSessionSources } = await import('../src/sourceAccess.ts');
const { restoreSessionRevision, buildReviewItems } = await import('../src/sessionLogic.ts');
const NOW = Date.UTC(2026, 9, 12, 4), DAY = 86400000;
const RAW = 'FULL_TEXT_SENTINEL_' + '仅限临时原文'.repeat(50);

function fixture(mode = 'daily', startedAt = NOW - 60000) {
  const data = initialData(), base = data.sessions[0];
  data.sessions = [{ ...base, id: 'session-policy', title: '保存边界检查', kind: mode === 'daily' ? '日常' : '会议',
    status: '进行中', duration: '01:00', transcript: [], savedEvidence: [], summary: [], privateNotes: [], attachments: [],
    storage: newStoragePolicy(data, mode, mode === 'meeting', startedAt) }];
  data.activeSessionId = 'session-policy'; data.tasks = []; data.memories = []; data.messages = []; data.notifications = [];
  data.settings.space = '我的空间'; data.settings.retention = {}; data.settings.toggles = { memory: true };
  return data;
}
function turn(id = 'raw-1', text = RAW, at = NOW - 1000, time = '00:00:59') {
  return { id, text, time, speaker: '我', receivedAt: at };
}
function task(data, pointer) {
  return { ...initialData().tasks[1], id: 'saved-task', sourceSession: data.sessions[0].id, ...pointer,
    sourceNeedsReview: false, needsReview: false, authorized: true, generationToken: 'already-allowed',
    sources: [makeSourceReference(data, { kind: 'session', id: data.sessions[0].id, ...pointer })] };
}
function memory(pointer) {
  return { id: 'saved-memory', title: '我确认的重点', body: '独立确认的简短结论', category: '记忆', tags: [],
    visibility: '私有', updated: '今天', confirmed: true, sourceSession: 'session-policy', ...pointer };
}

test('new defaults and separate audio/text preferences do not change legacy meetings', () => {
  const data = initialData();
  data.settings.retention['meeting-audio-days'] = '7'; data.settings.retention['meeting-transcript-days'] = '90';
  const policy = newStoragePolicy(data, 'meeting', true, NOW);
  assert.equal(policy.audioRetentionDays, 7); assert.equal(policy.transcriptRetentionDays, 90);
  assert.equal(policy.cloudSaveConfirmed, true);
  assert.equal(newStoragePolicy(data, 'daily', true, NOW).cloudSaveConfirmed, false);
  assert.equal(retentionDays('unexpected'), 30);
  assert.equal(applyStorageDeadlines(data, NOW + 400 * DAY), data);
});

test('daily rolling window excludes the exact five-minute boundary and keeps explicit short evidence', () => {
  let data = fixture(); data.sessions[0].duration = '10:00';
  data.sessions[0].transcript = [turn('old', 'expired', NOW - DAILY_WINDOW_MS, '00:05:00'), turn('live', 'current', NOW - 1, '00:09:59')];
  const pinned = pinSessionEvidence(data, 'session-policy', data.sessions[0].transcript[0]); data = pinned.data;
  const next = applyStorageDeadlines(data, NOW);
  assert.deepEqual(next.sessions[0].transcript.map(t => t.id), ['live']);
  assert.equal(sourceAvailable(next, { sourceSession: 'session-policy', sourceId: pinned.source.id }), true);
  assert.equal(sourceAvailable(next, { sourceSession: 'session-policy', sourceId: 'old' }), false);
});

test('stopping daily does not retain full text in the app archive or private settings caches', () => {
  const data = fixture(); data.sessions[0].transcript = [turn()];
  data.settings.retention['session-intelligence:session-policy'] = RAW;
  data.settings.retention['session-import:session-policy'] = RAW;
  data.settings.retention['sample-index:session-policy'] = '3';
  data.settings.retention['session-space:session-policy'] = '我的空间';
  const next = finishDailySession(data, 'session-policy', ['本人另写的便签'], NOW);
  assert.equal(JSON.stringify(archiveSafeData(next, NOW)).includes(RAW), false);
  assert.equal(next.sessions[0].status, '已结束'); assert.equal(next.activeSessionId, undefined);
  assert.equal(next.sessions[0].storage.transcriptState, 'cleared');
  assert.deepEqual(next.sessions[0].privateNotes, ['本人另写的便签']);
  assert.equal(next.settings.retention['sample-index:session-policy'], '3');
  assert.equal(next.settings.retention['session-space:session-policy'], '我的空间');
  assert.equal(next.memories.length, 1); assert.equal(next.memories[0].confirmed, false);
  assert.equal(next.memories[0].body.length <= 140, true); assert.equal(next.sessions[0].savedEvidence[0].text.length <= 140, true);
});

test('reload sanitizes active daily data without mutating live in-memory content', () => {
  const data = fixture(); data.sessions[0].transcript = [turn()];
  const safe = archiveSafeData(data, NOW);
  assert.equal(safe.sessions[0].transcript.length, 0); assert.equal(safe.activeSessionId, undefined);
  assert.equal(data.sessions[0].transcript[0].text, RAW); assert.equal(data.sessions[0].status, '进行中');
});

test('stop and daily-to-meeting conversion cannot revive a stale background buffer', () => {
  const data = fixture('daily', NOW - 10 * 60000); data.sessions[0].duration = '10:00';
  data.sessions[0].transcript = [turn('stale', RAW, NOW - 6 * 60000, '00:04:00'), turn('fresh', '仍在缓冲内', NOW - 1000, '00:09:59')];
  const stopped = finishDailySession(data, 'session-policy', [], NOW);
  assert.equal(stopped.memories.some(m => m.body.includes('FULL_TEXT_SENTINEL_')), false);
  const switched = switchDailyToMeeting(data, 'session-policy', 'meeting-new', true, true, 7, 90, NOW);
  assert.equal(switched.error, undefined);
  assert.deepEqual(switched.data.sessions[0].transcript.map(t => t.text), ['仍在缓冲内']);
  assert.equal(switched.data.sessions[0].storage.audioRetentionDays, 7);
  assert.equal(switched.data.sessions[0].storage.transcriptRetentionDays, 90);
});

test('switch cancellation, missing consent, duplicate IDs and repeated conversion do not create extra sessions', () => {
  const data = fixture(); data.sessions[0].transcript = [turn()];
  assert.equal(switchDailyToMeeting(data, 'session-policy', 'meeting-new', false, true, 30, 30, NOW).data, data);
  assert.equal(switchDailyToMeeting(data, 'session-policy', 'session-policy', true, false, 30, 30, NOW).data, data);
  const switched = switchDailyToMeeting(data, 'session-policy', 'meeting-new', true, false, 30, 30, NOW).data;
  assert.equal(switched.sessions.length, 2); assert.deepEqual(switched.sessions[0].transcript, []);
  assert.equal(switchDailyToMeeting(switched, 'session-policy', 'meeting-other', true, false, 30, 30, NOW).data, switched);
  assert.equal(finishDailySession(switched, 'session-policy', [], NOW), switched);
});

test('audio expiration is separate from transcript and evidence expiration', () => {
  const data = fixture('meeting', NOW - 8 * DAY); data.sessions[0].storage.audioRetentionDays = 7; data.sessions[0].storage.transcriptRetentionDays = 30;
  data.sessions[0].transcript = [turn()];
  const next = applyStorageDeadlines(data, NOW);
  assert.equal(next.sessions[0].storage.audioState, 'expired');
  assert.equal(next.sessions[0].storage.transcriptState, 'available');
  assert.equal(next.sessions[0].transcript[0].text, RAW);
});

test('confirmed short memory and explicitly saved task stay valid after full transcript expires', () => {
  let data = fixture('meeting', NOW - 31 * DAY); const raw = turn(); data.sessions[0].transcript = [raw];
  const pinned = pinSessionEvidence(data, 'session-policy', raw); data = pinned.data;
  const pointer = { sourceId: pinned.source.id, sourceTime: pinned.source.time };
  data.tasks = [task(data, pointer)]; data.memories = [memory(pointer)];
  data.memories[0].sources = [makeSourceReference(data, { kind: 'session', id: 'session-policy', ...pointer })];
  const next = applyStorageDeadlines(data, NOW);
  assert.equal(next.tasks[0].authorized, true); assert.equal(next.tasks[0].generationToken, 'already-allowed'); assert.equal(next.tasks[0].version, data.tasks[0].version);
  assert.equal(next.memories[0].confirmed, true); assert.equal(next.memories[0].needsReview, undefined);
  assert.equal(taskSourceAvailable(next, next.tasks[0]), true);
  assert.equal(provenanceAvailable(next, next.memories[0].sources), true);
  assert.equal(next.sessions[0].transcript[0].id, pinned.source.id);
});

test('raw-only derivations lose execution permission when their source expires', () => {
  const data = fixture('meeting', NOW - 31 * DAY); data.sessions[0].transcript = [turn()];
  data.tasks = [task(data, { sourceId: 'raw-1' })];
  const next = applyStorageDeadlines(data, NOW);
  assert.equal(next.tasks[0].authorized, false); assert.equal(next.tasks[0].generationToken, undefined);
  assert.equal(next.tasks[0].sourceNeedsReview, true); assert.equal(next.tasks[0].version, data.tasks[0].version + 1);
});

test('manual conclusions survive expiry, automatic raw excerpts and adjacent session caches do not mix', () => {
  const data = fixture('meeting', NOW - 31 * DAY); data.sessions[0].transcript = [turn()];
  data.sessions[0].summary = ['人工确认的独立结论', '原话摘录 · 00:00:59 我：' + RAW];
  const reviewed = JSON.stringify([{ id: 'conclusion-1', text: '人工确认的独立结论', confirmed: true, shared: false, kind: 'conclusion' }]);
  data.settings.retention['session-review-items:session-policy'] = reviewed;
  data.settings.toggles['review-session-policy'] = false;
  data.settings.retention['session-conclusions:session-policy'] = '人工确认的独立结论';
  data.settings.retention['session-questions:session-policy'] = '保留待定问题';
  data.settings.retention['session-intelligence:session-policy2'] = '邻近ID的内容';
  const next = archiveSafeData(data, NOW);
  assert.deepEqual(next.sessions[0].summary, ['人工确认的独立结论']);
  assert.equal(next.settings.retention['session-review-items:session-policy'], reviewed);
  assert.equal(next.settings.retention['session-conclusions:session-policy'], '人工确认的独立结论');
  assert.equal(next.settings.retention['session-questions:session-policy'], '保留待定问题');
  assert.equal(next.settings.retention['session-intelligence:session-policy2'], '邻近ID的内容');
  assert.equal(next.settings.toggles['review-session-policy'], false);
  assert.equal(JSON.stringify(next).includes(RAW), false);
});

test('new task and newly confirmed memory pin selected short evidence before raw expiration', () => {
  const previous = fixture('meeting', NOW - 31 * DAY); previous.sessions[0].transcript = [turn()];
  previous.memories = [{ ...memory({ sourceId: 'raw-1' }), confirmed: false }];
  const changed = { ...previous, tasks: [task(previous, { sourceId: 'raw-1' })], memories: previous.memories.map(m => ({ ...m, confirmed: true })) };
  const pinned = pinExplicitDerivations(previous, changed);
  assert.equal(pinned.tasks[0].sourceId, 'evidence-raw-1'); assert.equal(pinned.memories[0].sourceId, 'evidence-raw-1');
  const next = applyStorageDeadlines(pinned, NOW);
  assert.equal(next.tasks[0].authorized, true); assert.equal(next.memories[0].confirmed, true);
  assert.equal(next.sessions[0].savedEvidence[0].text.length <= 140, true);
});

test('a confirmed conclusion keeps its selected short source after the full transcript expires', () => {
  const previous = fixture('meeting', NOW - 31 * DAY); previous.sessions[0].transcript = [turn()];
  const conclusion = { id: 'conclusion-1', kind: 'conclusion', text: '我确认的独立摘要', confirmed: true, shared: false, sourceId: 'raw-1' };
  const changed = { ...previous, sessions: previous.sessions.map(s => ({ ...s, summary: [conclusion.text] })),
    settings: { ...previous.settings, toggles: { ...previous.settings.toggles, 'review-session-policy': false }, retention: {
      ...previous.settings.retention, 'session-review-items:session-policy': JSON.stringify([conclusion]),
      'session-conclusions:session-policy': JSON.stringify([conclusion.text]) } } };
  const next = applyStorageDeadlines(pinExplicitDerivations(previous, changed), NOW);
  const kept = JSON.parse(next.settings.retention['session-review-items:session-policy'])[0];
  assert.equal(kept.confirmed, true);
  assert.equal(sourceAvailable(next, { sourceSession: 'session-policy', sourceId: kept.sourceId }), true);
  assert.equal(next.settings.toggles['review-session-policy'], false);
});

test('confirmed pinned conclusions can immediately be edited again while raw text still exists', () => {
  const previous = fixture('meeting'); previous.sessions[0].transcript = [turn()];
  const item = { id: 'conclusion-1', kind: 'conclusion', text: '已经核对的结论', confirmed: true, shared: false, sourceId: 'raw-1' };
  const changed = { ...previous, settings: { ...previous.settings, retention: {
    ...previous.settings.retention, 'session-review-items:session-policy': JSON.stringify([item]) } } };
  const pinned = pinExplicitDerivations(previous, changed);
  const items = JSON.parse(pinned.settings.retention['session-review-items:session-policy']);
  assert.equal(pinned.sessions[0].transcript[0].id, 'raw-1'); assert.equal(items[0].sourceId, 'evidence-raw-1');
  const savedAgain = buildReviewItems(pinned.sessions[0], items, { conclusions: item.text, questions: '', sourceId: '', sourceMode: 'preserve' }, () => 'next-conclusion');
  assert.equal(savedAgain.error, undefined);
  assert.equal(savedAgain.items[0].sourceId, 'evidence-raw-1');
});

test('editing and deleting an already retained quote cannot revive its old evidence copy', () => {
  let previous = fixture('meeting', NOW - 31 * DAY); const pinned = pinSessionEvidence(previous, 'session-policy', turn()); previous = pinned.data;
  previous.sessions[0].transcript = [pinned.source];
  const edited = { ...previous, sessions: previous.sessions.map(s => ({ ...s, transcript: [{ ...pinned.source, text: '修正后的短证据' }] })) };
  assert.equal(applyStorageDeadlines(reconcileSavedEvidence(previous, edited), NOW).sessions[0].transcript[0].text, '修正后的短证据');
  const deleted = { ...previous, sessions: previous.sessions.map(s => ({ ...s, transcript: [] })) };
  assert.deepEqual(availableSessionTurns(reconcileSavedEvidence(previous, deleted).sessions[0]), []);
  assert.deepEqual(applyStorageDeadlines(reconcileSavedEvidence(previous, deleted), NOW).sessions[0].transcript, []);
});

test('user editing or deleting raw text retracts its evidence copy and downstream authorization', () => {
  let previous = fixture('meeting'); const raw = turn(); previous.sessions[0].transcript = [raw];
  const pinned = pinSessionEvidence(previous, 'session-policy', raw); previous = pinned.data;
  previous.tasks = [task(previous, { sourceId: pinned.source.id, sourceTime: raw.time })];
  previous.memories = [memory({ sourceId: pinned.source.id, sourceTime: raw.time })];
  const invalidated = invalidateSessionSources(previous, 'session-policy', [raw.id], '原话修订');
  const edited = { ...invalidated, sessions: invalidated.sessions.map(s => ({ ...s, transcript: [{ ...raw, text: '修正后的原话', private: true }] })) };
  const reconciled = reconcileSavedEvidence(previous, edited);
  assert.deepEqual(reconciled.sessions[0].savedEvidence, []);
  assert.equal(reconciled.tasks[0].authorized, false); assert.equal(reconciled.memories[0].confirmed, false);
  const deleting = invalidateSessionSources(previous, 'session-policy', [raw.id], '原话删除');
  const deleted = { ...deleting, sessions: deleting.sessions.map(s => ({ ...s, transcript: [] })) };
  const safe = archiveSafeData(reconcileSavedEvidence(previous, deleted), NOW + 31 * DAY);
  assert.deepEqual(availableSessionTurns(safe.sessions[0]), []);
  assert.equal(safe.tasks[0].authorized, false); assert.equal(safe.memories[0].confirmed, false);
});

test('source deduplication recognizes a task pinned from the same raw selected turn', () => {
  let data = fixture('meeting'); data.sessions[0].transcript = [turn()];
  const pinned = pinSessionEvidence(data, 'session-policy', data.sessions[0].transcript[0]); data = pinned.data;
  data.tasks = [task(data, { sourceId: pinned.source.id, sourceTime: pinned.source.time })];
  assert.equal(findSourceTask(data, { sourceSession: 'session-policy', sourceId: 'raw-1' })?.id, 'saved-task');
});

test('daily revision histories cannot preserve or restore full raw text after stop', () => {
  const data = fixture(); const raw = turn(); data.sessions[0].transcript = [raw];
  data.memories = [{ ...memory({ sourceId: raw.id, sourceTime: raw.time }), id: 'revision-1', tags: ['修订历史', raw.id],
    body: '原文：' + RAW + '\n修订：修正后的文字', revision: { original: raw, action: 'edit' } }];
  const next = archiveSafeData(finishDailySession(data, 'session-policy', [], NOW), NOW);
  assert.equal(JSON.stringify(next).includes(RAW), false);
  const restored = restoreSessionRevision(next, 'session-policy', 'revision-1', 'fallback');
  assert.equal(restored.data.sessions[0].transcript.some(t => t.text === RAW), false);
});

test('expired meeting revisions cannot restore full transcript through private history', () => {
  const data = fixture('meeting', NOW - 31 * DAY); const raw = turn(); data.sessions[0].transcript = [raw];
  data.memories = [{ ...memory({ sourceId: raw.id, sourceTime: raw.time }), id: 'revision-1', tags: ['修订历史', raw.id],
    body: '原文：' + RAW + '\n修订：修正后的文字', revision: { original: raw, action: 'edit' } }];
  const next = archiveSafeData(data, NOW);
  assert.equal(JSON.stringify(next).includes(RAW), false);
  assert.equal(restoreSessionRevision(next, 'session-policy', 'revision-1', 'fallback').data.sessions[0].transcript.some(t => t.text === RAW), false);
});

test('recycle-bin meeting backups honor the same transcript deadline', () => {
  const data = fixture('meeting', NOW - 31 * DAY); data.sessions[0].status = '已结束'; data.sessions[0].transcript = [turn()];
  const deleted = data.sessions[0]; data.sessions = []; data.activeSessionId = undefined;
  data.settings.retention['deleted-session:' + deleted.id] = JSON.stringify(deleted);
  const safe = archiveSafeData(data, NOW);
  assert.equal(JSON.stringify(safe).includes(RAW), false);
  const retained = safe.settings.retention['deleted-session:' + deleted.id];
  if (retained) assert.deepEqual(JSON.parse(retained).transcript, []);
});

// Exercise the actual view-state module with lightweight React hook stubs. The
// boundary under test is persistence and exact-object cleanup, not hook rendering.
const viewSource = readFileSync(new URL('../src/viewState.tsx', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, 'const useCallback = fn => fn; const useRef = value => ({ current: value }); const useSyncExternalStore = (_subscribe, snapshot) => snapshot();\n');
const viewState = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(viewSource, { mode: 'strip' })).toString('base64'));
function fakeStorage() {
  return Object.create({
    get length() { return Object.keys(this).length; }, key(index) { return Object.keys(this)[index] ?? null; },
    getItem(key) { return Object.hasOwn(this, key) ? this[key] : null; }, setItem(key, value) { this[key] = String(value); }, removeItem(key) { delete this[key]; }
  });
}

test('temporary daily drafts never write browser storage and stop clears exact-object drafts', () => {
  globalThis.sessionStorage = fakeStorage(); viewState.clearViewState();
  sessionStorage.setItem('oops-view-v3:session-edit:session-policy:raw-1:我的空间', JSON.stringify({ text: RAW }));
  sessionStorage.setItem('oops-view-v3:session-edit:session-policy2:raw-1:我的空间', JSON.stringify({ text: '其他会话' }));
  viewState.setVolatileObjects(['session-policy']);
  assert.equal(sessionStorage.getItem('oops-view-v3:session-edit:session-policy:raw-1:我的空间'), null);
  const key = 'session-edit:session-policy:raw-1:我的空间';
  const [, setDraft] = viewState.useViewState(key, { text: '' }); setDraft({ text: RAW });
  assert.equal(Object.values(sessionStorage).some(value => value.includes(RAW)), false);
  assert.equal(viewState.useViewState(key, { text: '' })[0].text, RAW);
  viewState.clearObjectViewState('session-policy');
  assert.equal(viewState.useViewState(key, { text: '' })[0].text, '');
  assert.equal(sessionStorage.getItem('oops-view-v3:session-edit:session-policy2:raw-1:我的空间') !== null, true);
  viewState.clearViewState(); delete globalThis.sessionStorage;
});
