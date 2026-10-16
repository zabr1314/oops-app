import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(url.pathname)) for (const ext of ['.ts', '.tsx']) if (existsSync(new URL(url.href + ext))) return next(url.href + ext, context);
  }
  return next(specifier, context);
} });
const {
  PERSONAL_ASSISTANT_STATE_KEY, buildPersonalContext, personalContextCurrent, personalContextSources,
  readPersonalAssistantState, setPersonalizationEnabled, setPersonalLearning, collectPersonalHabitCandidates,
  reviewPersonalHabitCandidate, setPersonalContextScope,
  reconcilePersonalAssistantState,
} = await import('../src/personalAssistant.ts');
const { makeSourceReference, invalidateSessionSources } = await import('../src/sourceAccess.ts');
const { archiveSafeData, newStoragePolicy, finishDailySession } = await import('../src/storagePolicy.ts');
const NOW = new Date('2026-10-16T04:00:00.000Z');
const turn = (id, text, extra = {}) => ({ id, text, time: '00:00:' + id.slice(1).padStart(2, '0'), speaker: '我', ...extra });
function fixture(turns = [turn('u1', '我喜欢先说结论，再说明依据。')]) {
  return {
    sessions: [{ id: 's1', title: '私人记录', kind: '会议', date: '今天', duration: '00:10', status: '已结束',
      transcript: turns, summary: [], agenda: [], participants: [], attachments: [], privateNotes: [], project: '' }],
    tasks: [], people: [], projects: [], receipts: [], messages: [], memories: [], notifications: [], recallCleared: false,
    settings: { name: '本人', role: '产品负责人', space: '我的空间', tone: '先结论后依据',
      retention: { roleContext: 'Oops 首版', answerLength: '简短', focus: '完成首版', avoid: '未经确认发送' },
      toggles: Object.fromEntries(turns.map(value => [`speaker-confirmed:s1:${value.id}`, true])), connections: {}, devices: {}, avatar: '' },
  };
}
const collect = data => collectPersonalHabitCandidates(setPersonalLearning(data, true), { scenario: '会议', now: NOW });
const first = data => readPersonalAssistantState(data).candidates[0];
function confirmed(data) {
  const next = collect(data), candidate = first(next);
  return reviewPersonalHabitCandidate(next, candidate.id, { action: 'confirm', expectedFingerprint: candidate.fingerprint, now: NOW }).data;
}
const memory = (id, extra = {}) => ({ id, title: '已核对背景', body: '先做产品验证。', category: '记忆', tags: ['角色背景'],
  visibility: '私有', updated: NOW.toISOString(), confirmed: true, ...extra });

test('existing personal settings can be used while optional learning defaults off and never starts itself', () => {
  const data = fixture(), before = structuredClone(data);
  assert.equal(readPersonalAssistantState(data).personalizationEnabled, true);
  assert.equal(readPersonalAssistantState(data).learningEnabled, false);
  assert.equal(collectPersonalHabitCandidates(data, { scenario: '会议', now: NOW }), data);
  const context = buildPersonalContext(data, { scenario: '会议' });
  assert.equal(context.enabled, true);
  assert.equal(context.identity.role, '产品负责人');
  assert.equal(context.preferences.answerLength, '简短');
  assert.ok(context.entries.every(entry => entry.sources.length && entry.sources.every(ref => ref.fingerprint)));
  assert.deepEqual(data, before);
});

test('the entire snapshot and candidate projection disappear in team spaces even when caller requests personal space', () => {
  const data = confirmed(fixture());
  data.settings.space = 'Oops 产品团队';
  const context = buildPersonalContext(data, { scenario: '会议', space: '我的空间' });
  assert.equal(context.enabled, false); assert.deepEqual(context.entries, []); assert.deepEqual(context.sources, []);
  assert.equal(context.identity, undefined); assert.equal(context.preferences, undefined);
  assert.deepEqual(readPersonalAssistantState(data).candidates, []);
  assert.equal(collect(data), data);
  assert.equal(setPersonalLearning(data, false), data);
});

test('a private task may not attach personal context when destination scope is a team', () => {
  const context = buildPersonalContext(fixture(), { space: 'Oops 产品团队' });
  assert.equal(context.enabled, false); assert.deepEqual(personalContextSources(context), []);
});

test('turn attribution must be explicitly checked; anonymous, other people, namesakes and quoting another person are excluded', () => {
  const data = fixture([
    turn('u1', '我喜欢先说结论。'),
    turn('u2', '我希望用三点概括。', { speaker: '王宁' }),
    turn('u3', '我喜欢给出完整背景。', { speaker: '待确认' }),
    turn('u4', '我喜欢简短回复。', { personId: 'other' }),
    turn('u5', '他说“我喜欢详细分析”。'),
    turn('u6', '我希望回答简短。'),
  ]);
  data.settings.toggles['speaker-confirmed:s1:u6'] = false;
  const next = collect(data);
  assert.deepEqual(readPersonalAssistantState(next).candidates.map(value => value.text), ['我喜欢先说结论。']);
  assert.equal(first(next).status, 'pending');
  assert.equal(buildPersonalContext(next, { scenario: '会议' }).entries.some(entry => entry.kind === 'habit'), false);
});

test('personality descriptions and ordinary factual repetition never become habit candidates', () => {
  const data = fixture([turn('u1', '我是一个内向的人。'), turn('u2', '今天产品会在十点开始。'), turn('u3', '今天产品会在十点开始。'),
    turn('u4', '王宁喜欢先说结论。'), turn('u5', '我需要把文件发给你。')]);
  assert.deepEqual(readPersonalAssistantState(collect(data)).candidates, []);
});

test('one explicit preference can be proposed, while repeated work expressions need two independent checked turns', () => {
  const data = fixture([turn('u1', '我通常先列提纲再写正文。')]);
  assert.deepEqual(readPersonalAssistantState(collect(data)).candidates, []);
  data.sessions[0].transcript.push(turn('u2', '我通常先列提纲再写正文。'));
  data.settings.toggles['speaker-confirmed:s1:u2'] = true;
  const next = collect(data), candidate = first(next);
  assert.equal(candidate.reason, 'repeated'); assert.equal(candidate.sources.length, 2);
  assert.deepEqual(readPersonalAssistantState(collect(next)).candidates, [candidate]);
});

test('confirming a pending habit keeps evidence fingerprints and applies only to its selected scenario', () => {
  const data = collect(fixture()), candidate = first(data), before = structuredClone(data);
  const result = reviewPersonalHabitCandidate(data, candidate.id, { action: 'confirm', expectedFingerprint: candidate.fingerprint, now: NOW });
  assert.equal(result.error, undefined); assert.equal(first(result.data).status, 'confirmed');
  const context = buildPersonalContext(result.data, { scenario: '会议' });
  const habit = context.entries.find(entry => entry.kind === 'habit');
  assert.equal(habit.text, candidate.text); assert.ok(habit.sources.some(ref => ref.kind === 'session' && ref.sourceId === 'evidence-u1'));
  assert.ok(habit.sources.some(ref => ref.kind === 'profile' && ref.profileScope === 'preferences'));
  assert.equal(buildPersonalContext(result.data, { scenario: '写作' }).entries.some(entry => entry.kind === 'habit'), false);
  assert.deepEqual(data, before);
});

test('correcting a habit changes the wording and explicit scenario without rewriting the original transcript', () => {
  const data = confirmed(fixture()), candidate = first(data), quote = data.sessions[0].transcript[0].text;
  const result = reviewPersonalHabitCandidate(data, candidate.id, { action: 'correct', text: '请先列三点，再按需展开。', scenario: '写作',
    expectedFingerprint: candidate.fingerprint, now: NOW });
  assert.equal(result.error, undefined); assert.equal(first(result.data).status, 'corrected');
  assert.equal(result.data.sessions[0].transcript[0].text, quote);
  assert.equal(buildPersonalContext(result.data, { scenario: '写作' }).entries.find(entry => entry.kind === 'habit').text, '请先列三点，再按需展开。');
  assert.ok(first(result.data).sources[0].fingerprint);
});

test('confirming or correcting a scenario-specific preference does not propose it again during default automatic collection', () => {
  for (const action of ['confirm', 'correct']) {
    const data = collectPersonalHabitCandidates(setPersonalLearning(fixture(), true), { scenario: '汇报', now: NOW });
    const candidate = first(data);
    const reviewed = reviewPersonalHabitCandidate(data, candidate.id, { action, text: '先给我三点，再附依据。', scenario: '汇报', now: NOW }).data;
    const automatic = collectPersonalHabitCandidates(reviewed, { now: NOW });
    assert.equal(automatic, reviewed);
    assert.equal(readPersonalAssistantState(automatic).candidates.length, 1);
    assert.equal(first(automatic).scenario, '汇报');
    assert.equal(first(automatic).status, action === 'confirm' ? 'confirmed' : 'corrected');
  }
});

test('pending preferences, repeated expressions and source tombstones remain deduplicated across scenario switches', () => {
  let data = collect(fixture());
  assert.equal(collectPersonalHabitCandidates(data, { scenario: '写作', now: NOW }), data);
  data.sessions[0].transcript.push(turn('u2', data.sessions[0].transcript[0].text));
  data.settings.toggles['speaker-confirmed:s1:u2'] = true;
  assert.equal(collectPersonalHabitCandidates(data, { scenario: '研究', now: NOW }), data);
  data.sessions[0].transcript[0].text = '我希望先整理问题，再展开说明。';
  data = reconcilePersonalAssistantState(data);
  assert.equal(first(data).stale, true);
  assert.equal(first(data).text, '');
  assert.equal(collectPersonalHabitCandidates(data, { scenario: '通用', now: NOW }), data);
});

test('reject and disable preserve suppression keys and never automatically restore the same expression', () => {
  for (const action of ['reject', 'disable']) {
    const data = collect(fixture()), candidate = first(data);
    const next = reviewPersonalHabitCandidate(data, candidate.id, { action, now: NOW }).data;
    assert.ok(readPersonalAssistantState(next).rejectedKeys.includes(candidate.key));
    assert.equal(buildPersonalContext(next, { scenario: '会议' }).entries.some(entry => entry.kind === 'habit'), false);
    assert.equal(reviewPersonalHabitCandidate(next, candidate.id, { action: 'confirm', now: NOW }).data, next);
    assert.deepEqual(readPersonalAssistantState(collect(next)).candidates.map(value => value.status), [action === 'reject' ? 'rejected' : 'disabled']);
  }
});

test('declining the same source prevents a new proposal in another scenario or after the visible history is removed', () => {
  const data = collect(fixture()), candidate = first(data);
  const rejected = reviewPersonalHabitCandidate(data, candidate.id, { action: 'reject', now: NOW }).data;
  const state = readPersonalAssistantState(rejected);
  rejected.settings.retention[PERSONAL_ASSISTANT_STATE_KEY] = JSON.stringify({ ...state, candidates: [] });
  assert.equal(collectPersonalHabitCandidates(rejected, { scenario: '写作', now: NOW }), rejected);
});

test('source revision, identity uncheck, removal, and expiry immediately redact a stored habit instead of retaining stale quotation text', () => {
  const base = confirmed(fixture());
  const mutations = [
    data => { data.sessions[0].transcript[0].text = '新的原话'; },
    data => { data.settings.toggles['speaker-confirmed:s1:u1'] = false; },
    data => { data.sessions[0].transcript = []; },
    data => { data.sessions[0].transcript[0].deleted = true; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(base); mutate(data);
    const candidate = first(data);
    assert.equal(candidate.stale, true); assert.equal(candidate.text, ''); assert.deepEqual(candidate.sources, []);
    assert.equal(buildPersonalContext(data, { scenario: '会议' }).entries.some(entry => entry.kind === 'habit'), false);
    assert.ok(reviewPersonalHabitCandidate(data, candidate.id, { action: 'confirm', now: NOW }).error);
  }
});

test('confirming a daily habit retains only its explicit short evidence and survives stopping or browser reload', () => {
  const base = fixture();
  base.sessions[0].status = '进行中'; base.activeSessionId = 's1';
  base.sessions[0].storage = newStoragePolicy(base, 'daily', false, NOW.getTime());
  const data = confirmed(base), kept = data.sessions[0].savedEvidence;
  assert.equal(kept.length, 1); assert.equal(kept[0].id, 'evidence-u1'); assert.equal(kept[0].text, base.sessions[0].transcript[0].text);
  const stopped = finishDailySession(data, 's1', [], NOW.getTime());
  const restored = archiveSafeData(stopped, NOW.getTime());
  assert.equal(first(restored).stale, undefined);
  assert.ok(buildPersonalContext(restored, { scenario: '会议' }).entries.some(entry => entry.kind === 'habit'));
});

test('a naturally expired meeting keeps independent confirmed habit evidence, while active original deletion revokes it', () => {
  const data = confirmed(fixture());
  data.sessions[0].storage = newStoragePolicy(data, 'meeting', true, NOW.getTime());
  data.sessions[0].storage.transcriptState = 'expired'; data.sessions[0].transcript = [];
  assert.ok(buildPersonalContext(data, { scenario: '会议' }).entries.some(entry => entry.kind === 'habit'));
  const deleted = invalidateSessionSources(data, 's1', ['u1'], '主动删除原话');
  assert.equal(first(deleted).stale, true);
  assert.equal(buildPersonalContext(deleted, { scenario: '会议' }).entries.some(entry => entry.kind === 'habit'), false);
});

test('short evidence cannot cut a long expression or exceed a total of 280 characters', () => {
  const data = collect(fixture([turn('u1', '我喜欢' + '完整观点'.repeat(36) + '。')]));
  assert.ok(first(data));
  const result = reviewPersonalHabitCandidate(data, first(data).id, { action: 'confirm', now: NOW });
  assert.match(result.error, /不会截断/); assert.equal(result.data, data);
  assert.equal(data.sessions[0].savedEvidence, undefined);
  const repeated = confirmed(fixture([turn('u1', '我通常先列提纲再写正文。'), turn('u2', '我通常先列提纲再写正文。')]));
  assert.equal(repeated.sessions[0].savedEvidence.length, 2);
  assert.ok(repeated.sessions[0].savedEvidence.reduce((sum, quote) => sum + quote.text.length, 0) <= 280);
});

test('suppression survives redaction of its source and does not require keeping the old text', () => {
  const data = collect(fixture()), candidate = first(data);
  const next = reviewPersonalHabitCandidate(data, candidate.id, { action: 'reject', now: NOW }).data;
  next.sessions[0].transcript = [];
  const state = readPersonalAssistantState(next);
  assert.equal(state.candidates[0].text, ''); assert.ok(state.rejectedKeys.includes(candidate.key));
  const sanitized = setPersonalLearning(next, false);
  assert.equal(sanitized.settings.retention[PERSONAL_ASSISTANT_STATE_KEY].includes('我喜欢先说结论'), false);
});

test('persisted state reconciliation keeps valid private candidates when a team is visible and removes only invalid evidence', () => {
  const data = collect(fixture()); data.settings.space = 'Oops 产品团队';
  const valid = reconcilePersonalAssistantState(data);
  assert.equal(JSON.parse(valid.settings.retention[PERSONAL_ASSISTANT_STATE_KEY]).candidates[0].text, '我喜欢先说结论，再说明依据。');
  data.sessions[0].transcript = [];
  const stale = reconcilePersonalAssistantState(data), stored = JSON.parse(stale.settings.retention[PERSONAL_ASSISTANT_STATE_KEY]);
  assert.equal(stale.settings.space, 'Oops 产品团队');
  assert.equal(stored.candidates[0].text, ''); assert.deepEqual(stored.candidates[0].sources, []); assert.equal(stored.candidates[0].stale, true);
});

test('browser archives never retain a pending daily quotation after temporary transcripts are removed', () => {
  const data = collect(fixture());
  data.sessions[0].storage = newStoragePolicy(data, 'daily', false, NOW.getTime());
  const safe = archiveSafeData(data, NOW.getTime());
  assert.equal(safe.settings.retention[PERSONAL_ASSISTANT_STATE_KEY].includes('我喜欢先说结论'), false);
  const stored = JSON.parse(safe.settings.retention[PERSONAL_ASSISTANT_STATE_KEY]);
  assert.equal(stored.candidates[0].stale, true); assert.deepEqual(stored.candidates[0].sources, []);
  assert.equal(data.sessions[0].transcript[0].text, '我喜欢先说结论，再说明依据。');
});

test('stale UI confirmation cannot silently approve a corrected candidate', () => {
  const data = collect(fixture()), candidate = first(data);
  const next = reviewPersonalHabitCandidate(data, candidate.id, { action: 'correct', text: '先列三点，再给出处。', now: NOW }).data;
  assert.ok(reviewPersonalHabitCandidate(next, candidate.id, { action: 'confirm', expectedFingerprint: candidate.fingerprint, now: NOW }).error);
});

test('learning opt out stops discovery while already confirmed preferences stay separately manageable', () => {
  const data = setPersonalLearning(confirmed(fixture()), false);
  data.sessions[0].transcript.push(turn('u2', '我希望把不确定的地方列出来。'));
  data.settings.toggles['speaker-confirmed:s1:u2'] = true;
  assert.equal(collectPersonalHabitCandidates(data, { scenario: '会议', now: NOW }), data);
  assert.ok(buildPersonalContext(data, { scenario: '会议' }).entries.some(entry => entry.kind === 'habit'));
  assert.equal(first(reviewPersonalHabitCandidate(data, first(data).id, { action: 'disable', now: NOW }).data).status, 'disabled');
});

test('personalization switch removes all private context and invalidates a frozen snapshot', () => {
  const data = confirmed(fixture()), context = buildPersonalContext(data, { scenario: '会议' });
  assert.equal(personalContextCurrent(data, context), true);
  const next = setPersonalizationEnabled(data, false);
  assert.equal(buildPersonalContext(next).enabled, false); assert.deepEqual(buildPersonalContext(next).entries, []);
  assert.equal(personalContextCurrent(next, context), false);
  assert.equal(collectPersonalHabitCandidates(next, { scenario: '会议', now: NOW }), next);
});

test('only confirmed current backgrounds and goals enter a snapshot; withdrawn, deleted and historical memories are excluded', () => {
  const data = fixture();
  data.memories = [memory('good'), memory('goal', { category: '目标', tags: [] }), memory('pending', { confirmed: false }),
    memory('deleted', { deleted: true }), memory('history', { tags: ['角色背景', '修订历史'] }), memory('disabled', { tags: ['角色背景', '已停用'] }),
    memory('missing', { sourceSession: 'missing', sourceId: 'u1' })];
  const context = buildPersonalContext(data);
  assert.deepEqual(context.entries.filter(entry => ['background', 'goal'].includes(entry.kind)).map(entry => entry.id), ['good', 'goal']);
  assert.ok(context.entries.find(entry => entry.id === 'good').sources.some(ref => ref.kind === 'memory' && ref.id === 'good'));
});

test('source-backed memory with expired raw evidence is excluded rather than hiding its invalid reference', () => {
  const data = fixture();
  data.memories = [memory('sourced', { sourceSession: 's1', sourceId: 'u1', sources: [makeSourceReference(data, { kind: 'session', id: 's1', sourceId: 'u1' })] })];
  assert.ok(buildPersonalContext(data).entries.some(entry => entry.id === 'sourced'));
  data.sessions[0].storage = { mode: 'meeting', transcriptState: 'expired' };
  assert.equal(buildPersonalContext(data).entries.some(entry => entry.id === 'sourced'), false);
});

test('manual confirmed habits use the selected memory scenario, preserve provenance and stay private', () => {
  const data = fixture(); data.memories = [memory('manual', { title: '回复习惯', body: '先给三点。', tags: ['偏好', '沟通习惯', '本人确认', '场景:写作'] })];
  data.settings.retention['memory-context:manual'] = '写作';
  assert.equal(buildPersonalContext(data, { scenario: '会议' }).entries.some(entry => entry.id === 'manual'), false);
  const context = buildPersonalContext(data, { scenario: '写作' });
  assert.equal(context.entries.find(entry => entry.id === 'manual').kind, 'habit');
  assert.ok(context.sources.some(ref => ref.kind === 'memory' && ref.id === 'manual'));
});

test('manual memory titles that repeat or prefix their body are not duplicated in personal context', () => {
  const data = fixture();
  data.memories = [memory('same', { title: '先给三点。', body: '先给三点。' }), memory('prefix', { title: '先给三点', body: '先给三点，再展开依据。' })];
  const context = buildPersonalContext(data);
  assert.equal(context.entries.find(entry => entry.id === 'same').text, '先给三点。');
  assert.equal(context.entries.find(entry => entry.id === 'prefix').text, '先给三点，再展开依据。');
});

test('explicit scopes support narrow scenarios and deliberate exclusion without copying them to other contexts', () => {
  let data = fixture();
  data.memories = [memory('m1')];
  data = setPersonalContextScope(data, 'memory', ['研究'], 'm1');
  data = setPersonalContextScope(data, 'preferences', ['写作']);
  assert.equal(buildPersonalContext(data, { scenario: '会议' }).entries.some(entry => entry.id === 'm1'), false);
  assert.equal(buildPersonalContext(data, { scenario: '会议' }).preferences, undefined);
  assert.ok(buildPersonalContext(data, { scenario: '研究' }).entries.some(entry => entry.id === 'm1'));
});

test('free form old project context stays useful; explicit meeting preferences match scenario or the current question', () => {
  const data = fixture(); data.settings.retention.preferenceContext = '项目会议';
  assert.ok(buildPersonalContext(data, { scenario: '研究' }).identity);
  assert.equal(buildPersonalContext(data, { scenario: '研究' }).preferences, undefined);
  assert.ok(buildPersonalContext(data, { scenario: '研究', query: '帮我研究会议里这个问题' }).preferences);
});

test('per-request exclusions and bounded text remain frozen and are never restored by currentness checking', () => {
  const data = confirmed(fixture()); data.memories = Array.from({ length: 30 }, (_, i) => memory('m' + i, { body: '背景'.repeat(500) }));
  const context = buildPersonalContext(data, { scenario: '会议', query: '当前问题', maxChars: 1000, excludeIds: ['m0', 'my-profile:preferences', 'm0'] });
  assert.deepEqual(context.excludedIds, ['m0', 'my-profile:preferences']);
  assert.equal(context.preferences, undefined); assert.equal(context.entries.some(entry => entry.id === 'm0'), false);
  assert.ok(context.charCount <= 1000); assert.equal(context.charCount, context.entries.reduce((sum, entry) => sum + entry.text.length, 0));
  assert.ok(context.entries.length <= 16); assert.equal(personalContextCurrent(data, context), true);
  const empty = buildPersonalContext(data, { maxChars: 0 });
  assert.deepEqual(empty.entries, []); assert.equal(empty.identity, undefined); assert.equal(empty.preferences, undefined);
});

test('profile changes, changed source memories and disabled memory invalidate a frozen generation context', () => {
  const base = fixture(); base.memories = [memory('m1')];
  const context = buildPersonalContext(base, { scenario: '会议' });
  for (const mutate of [data => { data.settings.tone = '先提问'; }, data => { data.memories[0].body = '新的背景'; },
    data => { data.memories[0].tags.push('已停用'); }]) {
    const data = structuredClone(base); mutate(data); assert.equal(personalContextCurrent(data, context), false);
  }
});

test('malformed persisted state and invalid review time are safe and never replace existing user data', () => {
  const data = fixture(); data.settings.retention[PERSONAL_ASSISTANT_STATE_KEY] = '{not json';
  assert.deepEqual(readPersonalAssistantState(data).candidates, []);
  const valid = collect(fixture()), candidate = first(valid);
  const result = reviewPersonalHabitCandidate(valid, candidate.id, { action: 'confirm', now: new Date('invalid') });
  assert.ok(result.error); assert.equal(result.data, valid);
});
