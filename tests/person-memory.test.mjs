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
const p = await import('../src/personMemory.ts');
const context = await import('../src/personalAssistant.ts');
const access = await import('../src/sourceAccess.ts');
const workflow = await import('../src/taskWorkflow.ts');
const logic = await import('../src/taskLogic.ts');
const storage = await import('../src/storagePolicy.ts');
const NOW = new Date('2026-10-16T09:00:00Z');
const person = (id, name = '王宁') => ({ id, name, role: '', company: '', note: '', shared: false, voice: false });
const turn = (id, text, personId = 'p1') => ({ id, text, personId, speaker: '王宁', time: '00:00:10' });
function fixture() {
  return { sessions: [{ id: 's1', title: '项目讨论', kind: '会议', status: '已结束', date: '今天', duration: '01:00',
    transcript: [turn('u1', '我希望先看结论，再看依据。'), turn('u2', '我周五把样片发给你。'), turn('u3', '交付期限是下周一。')],
    summary: [], agenda: [], participants: [], attachments: [], privateNotes: [], project: '' }],
    people: [person('p1'), person('p2')], projects: [], receipts: [], messages: [], notifications: [], recallCleared: false, memories: [],
    tasks: [{ id: 'draft', title: '准备沟通', description: '确认样片安排。', owner: '我', requester: '我', due: '', priority: '中', status: '已承接', aiStatus: '未启动',
      outputMode: '回复草稿', workKind: '行动', authorized: true, budget: 40, version: 1, activities: [], results: [],
      scope: { sources: '本人要求', destination: '个人草稿', space: '我的空间', includeSource: false, materialIds: [] } }],
    settings: { name: '本人', role: '产品负责人', tone: '先说结论', space: '我的空间', avatar: '', toggles: {
      'speaker-confirmed:s1:u1': true, 'speaker-confirmed:s1:u2': true, 'speaker-confirmed:s1:u3': true }, retention: {}, devices: {}, connections: {} } };
}
function save(data, extra = {}) {
  const result = p.savePersonMemory(data, { personId: 'p1', kind: 'preference', text: '汇报时先给三点。', scenario: '通用', now: NOW, ...extra });
  assert.equal(result.error, undefined); return result;
}
function remember(data, extra = {}) {
  const saved = save(data, extra), pending = p.readPersonMemories(saved.data).find(item => item.id === saved.id);
  const confirmed = p.reviewPersonMemory(saved.data, saved.id, 'confirm', undefined, pending.fingerprint);
  assert.equal(confirmed.error, undefined); return { data: confirmed.data, id: saved.id };
}
const byId = (data, id) => p.readPersonMemories(data).find(item => item.id === id);
const oldFingerprint = value => { const text = JSON.stringify(value); let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return (hash >>> 0).toString(36); };

test('manual records are pending until explicit confirmation, retain their origin, and never claim the other person spoke', () => {
  const data = fixture(), before = structuredClone(data), saved = save(data);
  assert.equal(byId(saved.data, saved.id).status, 'pending'); assert.equal(byId(saved.data, saved.id).origin, 'manual');
  assert.deepEqual(byId(saved.data, saved.id).sources, []);
  assert.deepEqual(p.buildPersonContext(saved.data, 'p1').entries, []);
  const confirmed = p.reviewPersonMemory(saved.data, saved.id, 'confirm').data;
  const entry = p.buildPersonContext(confirmed, 'p1').entries[0];
  assert.equal(entry.origin, 'manual'); assert.equal(entry.kind, 'person_preference');
  assert.equal(entry.sources[0].kind, 'person_memory'); assert.equal(entry.sources[0].personId, 'p1');
  assert.deepEqual(data, before);
});

test('stable selected IDs separate namesakes and nobody is automatically injected by a requester name', () => {
  const { data } = remember(fixture());
  assert.equal(p.buildPersonContext(data, 'p1').entries.length, 1);
  assert.equal(p.buildPersonContext(data, 'p2').entries.length, 0);
  data.tasks[0].requester = '王宁'; data.tasks[0].requesterPersonId = 'p1';
  assert.ok(!workflow.taskPersonalContext(data, data.tasks[0]).entries.some(entry => entry.kind.startsWith('person_')));
  assert.ok(!context.buildPersonalContext(data).entries.some(entry => entry.kind.startsWith('person_')));
  assert.equal(context.buildPersonalContext(data, { personId: 'p1' }).personLabel, '王宁');
});

test('missing and anonymous people, team scopes and logged out users cannot save or read person memories', () => {
  for (const mutate of [data => { data.settings.space = '团队'; }, data => { data.settings.toggles.loggedOut = true; },
    data => { data.people[0].name = '待确认'; }, data => { data.people = []; }]) {
    const data = fixture(); mutate(data);
    assert.ok(p.savePersonMemory(data, { personId: 'p1', kind: 'fact', text: '明确信息' }).error);
    assert.deepEqual(p.buildPersonContext(data, 'p1').entries, []);
  }
  const remembered = remember(fixture()).data; remembered.settings.space = '团队';
  assert.deepEqual(p.readPersonMemories(remembered), []);
  assert.deepEqual(context.buildPersonalContext(remembered, { personId: 'p1', space: '我的空间' }).entries, []);
});

test('quote memory requires exact person attribution and explicit sentence identity review', () => {
  for (const mutate of [data => { data.sessions[0].transcript[0].personId = undefined; },
    data => { data.sessions[0].transcript[0].personId = 'p2'; }, data => { data.settings.toggles['speaker-confirmed:s1:u1'] = false; }]) {
    const data = fixture(); mutate(data);
    assert.ok(p.savePersonMemory(data, { personId: 'p1', kind: 'preference', text: '先看结论。', source: { sessionId: 's1', sourceId: 'u1' } }).error);
  }
  const { data, id } = remember(fixture(), { text: '我希望先看结论，再看依据。', source: { sessionId: 's1', sourceId: 'u1' } });
  assert.equal(byId(data, id).origin, 'quote'); assert.equal(byId(data, id).sources[0].sourceId, 'evidence-u1');
  assert.equal(data.sessions[0].savedEvidence[0].personId, 'p1');
});

test('discovery proposes explicit preferences and commitments without treating ordinary speech as a habit or a task', () => {
  const data = fixture(), discovered = p.collectPersonMemoryCandidates(data, 'p1', '会议');
  assert.deepEqual(p.readPersonMemories(discovered).map(item => item.kind), ['preference', 'commitment']);
  assert.ok(p.readPersonMemories(discovered).every(item => item.status === 'pending' && item.scenario === '会议'));
  assert.deepEqual(discovered.tasks, data.tasks);
  assert.deepEqual(p.buildPersonContext(discovered, 'p1', '会议').entries, []);
});

test('reject, disable and delete leave deduplication tombstones across scenarios and evidence retention', () => {
  for (const action of ['reject', 'disable', 'delete']) {
    let data = p.collectPersonMemoryCandidates(fixture(), 'p1', '会议');
    const item = p.readPersonMemories(data)[0];
    data = action === 'delete' ? p.deletePersonMemory(data, item.id).data : p.reviewPersonMemory(data, item.id, action).data;
    const next = p.collectPersonMemoryCandidates(data, 'p1', '写作');
    assert.equal(p.readPersonMemories(next).length, 2);
    assert.equal(byId(next, item.id).status, action === 'reject' ? 'rejected' : 'disabled');
    assert.ok(p.reviewPersonMemory(next, item.id, 'confirm').error);
  }
});

test('confirming or correcting does not create a new cross-scenario copy when collection runs again', () => {
  const base = p.collectPersonMemoryCandidates(fixture(), 'p1', '会议'), item = p.readPersonMemories(base)[0];
  const data = p.reviewPersonMemory(base, item.id, 'correct', '先看三个要点。', item.fingerprint, '汇报').data;
  const next = p.collectPersonMemoryCandidates(data, 'p1', '通用');
  assert.equal(p.readPersonMemories(next).length, 2);
  assert.equal(byId(next, item.id).scenario, '汇报');
});

test('source edits, attribution changes and explicit deletion redact copied text and withdraw frozen context', () => {
  const remembered = remember(fixture(), { text: '先看结论。', source: { sessionId: 's1', sourceId: 'u1' } });
  const snapshot = context.buildPersonalContext(remembered.data, { personId: 'p1' });
  for (const mutate of [data => { data.sessions[0].transcript[0].text = '新的原话'; return data; },
    data => { data.sessions[0].transcript[0].personId = 'p2'; return data; },
    data => { data.settings.toggles['speaker-confirmed:s1:u1'] = false; return data; },
    data => access.invalidateSessionSources(data, 's1', ['u1'], '主动删除')]) {
    const data = mutate(structuredClone(remembered.data)), item = byId(data, remembered.id);
    assert.equal(item.text, ''); assert.equal(item.stale, true); assert.deepEqual(item.sources, []);
    assert.equal(context.personalContextCurrent(data, snapshot), false);
    assert.equal(p.buildPersonContext(data, 'p1').entries.length, 0);
  }
});

test('confirmed daily quotes survive natural stop with bounded independent evidence; pending text does not survive archives', () => {
  const base = fixture(); base.sessions[0].status = '进行中'; base.activeSessionId = 's1';
  base.sessions[0].storage = storage.newStoragePolicy(base, 'daily', false, NOW.getTime());
  const remembered = remember(base, { text: '先看结论。', source: { sessionId: 's1', sourceId: 'u1' } });
  const saved = save(remembered.data, { kind: 'fact', text: '期限下周一。', source: { sessionId: 's1', sourceId: 'u3' } });
  const archived = storage.archiveSafeData(saved.data, NOW.getTime());
  assert.equal(byId(archived, remembered.id).status, 'confirmed'); assert.equal(byId(archived, remembered.id).stale, undefined);
  assert.equal(byId(archived, saved.id).text, '');
  assert.ok(p.buildPersonContext(archived, 'p1').entries.length);
});

test('a long quote cannot be silently clipped when confirming a person record', () => {
  const data = fixture(); data.sessions[0].transcript[0].text = '我希望' + '完整表达'.repeat(36);
  const saved = save(data, { source: { sessionId: 's1', sourceId: 'u1' } });
  assert.match(p.reviewPersonMemory(saved.data, saved.id, 'confirm').error, /不会截断/);
  assert.equal(saved.data.sessions[0].savedEvidence, undefined);
});

test('deleting and restoring a person or legacy note cannot restore redacted personal memory or its prior snapshot', () => {
  const remembered = remember(fixture()), snapshot = context.buildPersonalContext(remembered.data, { personId: 'p1' });
  const deleted = structuredClone(remembered.data); deleted.people = deleted.people.filter(value => value.id !== 'p1');
  const sanitized = context.reconcilePersonalAssistantState(deleted);
  sanitized.people.push(person('p1')); sanitized.people[0].note = '恢复的旧备注';
  assert.equal(byId(sanitized, remembered.id).text, '');
  assert.equal(context.personalContextCurrent(sanitized, snapshot), false);
  assert.deepEqual(p.buildPersonContext(sanitized, 'p1').entries, []);
});

test('manual and quoted memory changes require current fingerprints rather than overwriting a later edit', () => {
  const saved = save(fixture()), pending = byId(saved.data, saved.id);
  const changed = p.savePersonMemory(saved.data, { id: saved.id, personId: 'p1', kind: 'background', text: '新的明确背景', now: NOW }, pending.fingerprint);
  assert.equal(changed.error, undefined);
  assert.ok(p.savePersonMemory(changed.data, { id: saved.id, personId: 'p1', kind: 'fact', text: '迟到覆盖' }, pending.fingerprint).error);
  assert.ok(p.reviewPersonMemory(changed.data, saved.id, 'confirm', undefined, pending.fingerprint).error);
  assert.ok(p.deletePersonMemory(changed.data, saved.id, pending.fingerprint).error);
  assert.equal(byId(changed.data, saved.id).deleted, undefined);
});

test('invalid actions or scenarios do not confirm pending person information or widen its intended use', () => {
  const data = fixture();
  assert.ok(p.savePersonMemory(data, { personId: 'p1', kind: 'fact', text: '明确内容', scenario: '未知范围' }).error);
  const saved = save(data, { scenario: '会议' }), item = byId(saved.data, saved.id);
  assert.ok(p.reviewPersonMemory(saved.data, item.id, 'anything').error);
  assert.ok(p.reviewPersonMemory(saved.data, item.id, 'confirm', undefined, undefined, '未知范围').error);
  const edited = p.savePersonMemory(saved.data, { id: item.id, personId: 'p1', kind: 'fact', text: '新的明确内容' }, item.fingerprint);
  assert.equal(byId(edited.data, item.id).scenario, '会议');
  assert.equal(byId(saved.data, item.id).status, 'pending');
});

test('scenario and single-request exclusions select only the explicitly chosen person', () => {
  let first = remember(fixture(), { scenario: '写作' });
  const second = remember(first.data, { personId: 'p2', text: '另一位同名人物的背景。', kind: 'background' });
  assert.deepEqual(p.buildPersonContext(second.data, 'p1', '会议').entries, []);
  const selected = context.buildPersonalContext(second.data, { personId: 'p1', scenario: '写作' });
  assert.ok(selected.entries.some(entry => entry.id === first.id)); assert.ok(!selected.entries.some(entry => entry.id === second.id));
  assert.ok(!context.buildPersonalContext(second.data, { personId: 'p1', scenario: '写作', excludeIds: [first.id] }).entries.some(entry => entry.id === first.id));
});

test('team views preserve valid private records during reconciliation but never expose their text or references', () => {
  const remembered = remember(fixture()); remembered.data.settings.space = '团队';
  const safe = p.reconcilePersonMemories(remembered.data);
  assert.ok(safe.settings.retention[p.PERSON_MEMORY_STATE_KEY].includes('汇报时先给三点'));
  assert.deepEqual(p.readPersonMemories(safe), []);
  const ref = { kind: 'person_memory', id: remembered.id, personId: 'p1' };
  assert.equal(access.provenanceAvailable(safe, [ref]), false);
});

test('task generation freezes selected person context, visibly includes relevant commitments and never creates an assigned task', () => {
  let remembered = remember(fixture(), { kind: 'commitment', text: '我周五把样片发给你。', source: { sessionId: 's1', sourceId: 'u2' } });
  remembered.data.tasks[0].scope.personId = 'p1';
  const begun = workflow.beginGeneration(remembered.data, 'draft', { token: 'person-request' });
  assert.equal(begun.error, undefined);
  assert.equal(begun.data.tasks[0].generationSnapshot.personalContext.personId, 'p1');
  const completed = logic.finishLocalGeneration(begun.data, 'draft', 'person-request');
  assert.equal(completed.tasks.length, 1); assert.equal(completed.tasks[0].aiStatus, '草稿完成');
  const body = completed.tasks[0].artifacts.flatMap(artifact => artifact.body).join('\n');
  assert.match(body, /需要向王宁核对的约定/); assert.match(body, /我周五把样片发给你/); assert.match(body, /不自动确定负责人/);
  assert.match(body, /对方原话整理：我周五/);
  assert.ok(completed.tasks[0].artifacts[0].sources.some(ref => ref.kind === 'person_memory'));
});

test('a manually written commitment remains the recorder\'s note and is never attributed as the person\'s quotation in a task draft', () => {
  const remembered = remember(fixture(), { kind: 'commitment', text: '我答应王宁周五发一版提纲。' });
  remembered.data.tasks[0].scope.personId = 'p1';
  const begun = workflow.beginGeneration(remembered.data, 'draft', { token: 'manual-person-request' });
  const completed = logic.finishLocalGeneration(begun.data, 'draft', 'manual-person-request');
  const body = completed.tasks[0].artifacts.flatMap(artifact => artifact.body).join('\n');
  assert.match(body, /我的私人记录（不是对方原话）：我答应王宁/);
  assert.doesNotMatch(body, /对方原话整理：我答应/);
  assert.equal(begun.data.tasks[0].generationSnapshot.personalContext.entries.find(entry => entry.kind === 'person_commitment').origin, 'manual');
});

test('late generation is withdrawn after selected person scope, memory or identity changes, without charging', () => {
  const remembered = remember(fixture()); remembered.data.tasks[0].scope.personId = 'p1';
  const started = workflow.beginGeneration(remembered.data, 'draft', { token: 'person-request' }).data;
  for (const mutate of [data => { data.tasks[0].scope.personId = 'p2'; return data; },
    data => p.reviewPersonMemory(data, remembered.id, 'disable').data,
    data => { data.people[0].name = '新显示名'; return data; },
    data => { data.settings.retention['task-space:draft'] = '团队'; return data; }]) {
    const finished = logic.finishLocalGeneration(mutate(structuredClone(started)), 'draft', 'person-request');
    assert.equal(finished.tasks[0].aiStatus, '待授权'); assert.equal(finished.tasks[0].used || 0, 0); assert.equal(finished.tasks[0].artifacts, undefined);
  }
});

test('invalid persisted state and private context limits do not broaden the selected person scope', () => {
  const data = fixture(); data.settings.retention[p.PERSON_MEMORY_STATE_KEY] = '{invalid';
  assert.deepEqual(p.readPersonMemories(data), []);
  for (let i = 0; i < 12; i++) { const next = remember(data, { kind: 'fact', text: '事实记录 ' + i }); Object.assign(data, next.data); }
  const snapshot = context.buildPersonalContext(data, { personId: 'p1', maxChars: 300 });
  assert.ok(snapshot.charCount <= 300); assert.ok(snapshot.entries.filter(entry => entry.kind.startsWith('person_')).length <= 8);
  const personEntries = snapshot.entries.filter(entry => entry.kind.startsWith('person_'));
  assert.ok(personEntries.length > 0); assert.ok(personEntries.every(entry => entry.sources.some(ref => ref.kind === 'person_memory' && ref.personId === 'p1')));
});

test('disabled personalization contains no person label, text or references even when a person is selected', () => {
  const remembered = remember(fixture());
  const disabled = context.setPersonalizationEnabled(remembered.data, false);
  const snapshot = context.buildPersonalContext(disabled, { personId: 'p1' });
  assert.equal(snapshot.enabled, false); assert.deepEqual(snapshot.entries, []); assert.deepEqual(snapshot.sources, []);
  assert.equal(snapshot.personLabel, undefined); assert.equal(snapshot.personId, undefined);
});

test('v1 own-personal snapshots and task configuration fingerprints keep their legacy shape until a person is selected', () => {
  const data = fixture(), snapshot = context.buildPersonalContext(data), task = data.tasks[0], scope = task.scope;
  const legacySnapshot = { ...snapshot, fingerprint: oldFingerprint([snapshot.enabled, snapshot.scenario, snapshot.query, snapshot.maxChars, snapshot.space,
    snapshot.excludedIds, snapshot.entries, snapshot.identity, snapshot.preferences]) };
  assert.equal(context.personalContextCurrent(data, legacySnapshot), true);
  const legacyTask = oldFingerprint([task.title, task.description, task.owner, task.ownerPersonId, task.requester, task.requesterPersonId, task.due,
    task.version, task.workKind, task.criteria, task.outputMode, task.sourceSession, task.sourceId, task.sourceTime,
    [scope.sources, scope.destination, scope.space, [...scope.materialIds].sort(), scope.includeSource !== false, [...(scope.personalContextExcludedIds || [])].sort()]]);
  assert.equal(access.generationConfigurationFingerprint(task), legacyTask);
  const remembered = remember(data);
  assert.equal(context.personalContextCurrent(remembered.data, legacySnapshot), true, 'an unrelated private person note cannot invalidate own context');
  task.scope.personId = 'p1';
  assert.notEqual(access.generationConfigurationFingerprint(task), legacyTask);
});
