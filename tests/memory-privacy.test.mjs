import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(url.pathname)) for (const extension of ['.ts', '.tsx', '.js']) {
      const candidate = new URL(url.href + extension);
      if (existsSync(candidate)) return next(candidate.href, context);
    }
  }
  return next(specifier, context);
} });

const base = new URL('../', import.meta.url);
const read = promisify(readFile);
async function loadModel(path, select) {
  const source = select(await read(new URL(path, base), 'utf8'));
  return import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'strip' })).toString('base64'));
}
const { initialData } = await loadModel('src/store.tsx', source => source.slice(source.indexOf('export function initialData')));
const dependency = `import { sharedMemoryEligible } from '${new URL('src/memoryAccess.ts', base)}';\nimport { sourceAvailable, sourceTurn, taskVisible, findSourceTask, invalidateSessionSources, makeSourceReference, provenanceAvailable } from '${new URL('src/sourceAccess.ts', base)}';\n`;
const memory = await loadModel('src/features/MemorySettings.tsx', source => dependency + source.slice(source.indexOf('const PERSONAL'), source.indexOf('function Download')));
const access = await import(new URL('src/sourceAccess.ts', base));
const TEAM = 'Oops 产品团队';
const asTeam = data => ({ ...data, settings: { ...data.settings, space: TEAM } });

test('replacing a shared role consumes the candidate, keeps one private current record, and withdraws derivations', () => {
  const data = initialData(), old = data.memories.find(item => item.id === 'MEM-001');
  old.visibility = '项目共享'; data.settings.retention['memory-space:' + old.id] = TEAM;
  data.settings.toggles['shared-session-001'] = true;
  const derived = { ...data.tasks[0], id: 'role-derived', sourceSession: undefined, sourceId: undefined, sourceTime: undefined, sourceMemoryId: old.id, sources: [access.makeSourceReference(data, { kind: 'memory', id: old.id })], authorized: true, generationToken: 'pending-role', aiStatus: '准备中' };
  data.tasks.push(derived);
  data.messages.push({ id: 'old-role-answer', role: 'assistant', text: old.body, sources: [access.makeSourceReference(data, { kind: 'memory', id: old.id })] });
  const saved = memory.saveIdentityBackground(data, { name: '林', role: '保密角色', roles: '', context: 'PRIVATE-NEW-SCENE', plannedCandidateId: 'new-role' });
  const candidate = saved.data.memories.find(item => item.id === saved.candidateId);
  const result = memory.confirmMemoryReview(saved.data, candidate.id, { body: candidate.body, editing: false, sourceSession: '', sourceId: '', sourceTouched: false, replace: true }, true);
  assert.equal(result.error, undefined);
  assert.equal(result.confirmedId, old.id);
  assert.equal(result.data.memories.some(item => item.id === candidate.id), false);
  assert.equal(result.data.memories.filter(item => item.tags.includes('身份') && memory.memoryUsable(result.data, item)).length, 1);
  assert.equal(result.data.memories.find(item => item.id === old.id).visibility, '私有');
  assert.equal(access.provenanceAvailable(asTeam(result.data), [{ kind: 'memory', id: old.id }]), false);
  assert.equal(JSON.parse(result.data.settings.retention['memory-history:' + old.id])[0].body, old.body);
  assert.equal(result.data.tasks.find(item => item.id === derived.id).authorized, false);
  assert.equal(result.data.tasks.find(item => item.id === derived.id).generationToken, undefined);
  assert.equal(result.data.messages.find(item => item.id === 'old-role-answer').invalidated, true);
});

test('a verified person name never adopts other same-name turns and renaming preserves exact bindings', () => {
  const data = initialData();
  data.people.push({ id: 'lydia', name: 'Lydia', role: '', company: '', note: '', shared: false, voice: false });
  data.sessions.push({ ...data.sessions[1], id: 'same-name-import', transcript: [{ id: 'unverified', speaker: 'Lydia', time: '', text: 'Another namesake' }] });
  const result = memory.confirmPersonSpeaker(data, { sessionId: 'session-001', turnId: 'tr3', name: 'Lydia', targetPersonId: 'lydia', voiceConsent: false });
  assert.equal(result.error, undefined);
  const person = result.data.people.find(item => item.id === 'lydia');
  assert.deepEqual(memory.personConversations(result.data, person).map(link => link.session.id), ['session-001']);
  person.name = 'Lydia Chen';
  assert.deepEqual(memory.personConversations(result.data, person).map(link => link.session.id), ['session-001']);
  assert.equal(result.data.sessions.find(item => item.id === 'same-name-import').transcript[0].personId, undefined);
  const duplicate = { ...person, id: 'other-lydia', name: person.name };
  result.data.people.push(duplicate);
  assert.match(memory.confirmPersonSpeaker(result.data, { sessionId: 'session-001', turnId: 'tr3', name: person.name, voiceConsent: false }).error, /同名/);
});

test('explicit batches confirm only selected turns and invalidate a whole-session derivation once', () => {
  const data = initialData();
  data.sessions[0].transcript.push({ id: 'tr-another', speaker: '待确认', time: '', text: 'Another selected passage' }, { id: 'tr-outside', speaker: '待确认', time: '', text: 'Not selected' });
  data.tasks.push({ ...data.tasks[0], id: 'whole-session-task', sourceSession: 'session-001', sourceId: undefined, sourceTime: undefined, sources: undefined, version: 7, authorized: true });
  const result = memory.confirmPersonSpeakers(data, { sessionId: 'session-001', turnIds: ['tr3', 'tr-another'], name: '王宁', targetPersonId: 'p1', voiceConsent: false });
  assert.equal(result.error, undefined);
  assert.equal(result.data.tasks.find(item => item.id === 'whole-session-task').version, 8);
  assert.equal(result.data.sessions[0].transcript.find(item => item.id === 'tr-another').personId, 'p1');
  assert.equal(result.data.sessions[0].transcript.find(item => item.id === 'tr-outside').personId, undefined);
});

test('growth reviews and legacy personal notes stay private until individually shared, then disappear after source withdrawal', () => {
  let data = initialData(); const id = 'MEM-004';
  data.memories.find(item => item.id === id).visibility = '项目共享'; data.settings.retention['memory-space:' + id] = TEAM;
  data.settings.retention['reviews:' + id] = JSON.stringify([{ text: 'PRIVATE-LEGACY', date: '昨天', sourceId: 'session-001' }]);
  data = memory.saveGrowthReview(data, id, { id: 'new-review', text: 'PUBLIC-IF-CHOSEN', sourceSession: 'session-001', sourceId: 'tr1' }).data;
  assert.equal(memory.visibleGrowthReviews(asTeam(data), id).length, 0);
  assert.equal(memory.growthReviews(data, id).find(item => item.id.startsWith('legacy')).visibility, '私有');
  assert.ok(memory.setGrowthReviewSharing(data, id, 'new-review', true).error);
  data.settings.toggles['shared-session-001'] = true;
  data = memory.setGrowthReviewSharing(data, id, 'new-review', true).data;
  assert.equal(memory.visibleGrowthReviews(asTeam(data), id).length, 1);
  data.settings.toggles['shared-session-001'] = false;
  assert.equal(memory.visibleGrowthReviews(asTeam(data), id).length, 0);
  data.settings.toggles['shared-session-001'] = true; data.sessions[0].transcript[0].private = true;
  assert.equal(memory.visibleGrowthReviews(asTeam(data), id).length, 0);
});

test('public export excludes personal tasks and filters private materials, historical bodies and draft caches', () => {
  const data = initialData(), personal = { ...data.tasks[0], id: 'private-task', sourceSession: undefined, sourceId: undefined, sourceTime: undefined, relatedSessionId: undefined, sourceMemoryId: undefined, sources: undefined, description: 'PRIVATE-PERSONAL-TASK' };
  data.settings.retention['task-space:' + personal.id] = '我的空间';
  assert.equal(memory.exportTaskRecord(data, personal, false), undefined);
  data.settings.toggles['shared-session-001'] = true;
  const task = { ...data.tasks[0], description: 'PUBLIC-TASK', sourceSession: 'session-001', sourceId: 'tr4', sourceTime: '00:18:02', sources: undefined, activities: ['PRIVATE-HISTORY'], results: ['PRIVATE-LEGACY-RESULT'], materialRefs: [{ id: 'private-material', title: 'PRIVATE-MATERIAL', body: 'PRIVATE-CACHED-MATERIAL', note: 'PRIVATE-NOTE' }], drafts: { 消息: { target: 'Alex', body: 'PRIVATE-DRAFT', attachments: '', snapshotSpace: '我的空间' } }, draftHistory: [{ kind: '消息', date: '昨天', draft: { target: 'Alex', body: 'PRIVATE-OLD-DRAFT', attachments: '' } }] };
  const exported = memory.exportTaskRecord(data, task, false);
  assert.equal(exported.title, task.title);
  assert.equal(exported.description, 'PUBLIC-TASK');
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE-/);
  assert.equal(memory.exportTaskRecord(data, personal, true).description, 'PRIVATE-PERSONAL-TASK');
  data.sessions[0].transcript.find(turn => turn.id === 'tr4').private = true;
  assert.equal(memory.exportTaskRecord(data, task, false), undefined);
});

test('public export retains valid selected artifacts and space-specific drafts without their historical metadata', () => {
  const data = initialData(); data.settings.toggles['shared-session-001'] = true;
  const ref = access.makeSourceReference(data, { kind: 'session', id: 'session-001', sourceId: 'tr4' });
  const artifact = { id: 'public-artifact', title: 'PUBLIC-ARTIFACT', kind: '文档', body: ['PUBLIC-BODY'], version: 1, created: '今天', reviewedAt: '今天', sources: [ref], reviewHistory: [{ reviewedAt: 'PRIVATE-OLD-DATE', version: 0 }] };
  const task = { ...data.tasks[0], sourceSession: 'session-001', sourceId: 'tr4', sources: [ref], artifacts: [artifact], materialRefs: [], drafts: { 邮件: { target: 'Alex', body: 'PUBLIC-DRAFT', attachments: 'PUBLIC-ARTIFACT', snapshotSpace: TEAM, sourceSnapshots: [ref], artifactRefs: [{ id: artifact.id, version: 1, fingerprint: 'current-binding', title: artifact.title, sources: [ref] }] } } };
  const record = memory.exportTaskRecord(data, task, false);
  assert.equal(record.artifacts.length, 1);
  assert.equal(record.drafts.邮件.body, 'PUBLIC-DRAFT');
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE-OLD-DATE/);
});

test('permanent memory deletion erases only its own retained content and invalidates derivation chains', () => {
  const data = initialData(), id = 'MEM-001';
  data.settings.retention['memory-history:' + id] = JSON.stringify([{ body: 'PRIVATE-OLD-VERSION' }]);
  data.settings.retention['reviews:' + id] = JSON.stringify([{ text: 'PRIVATE-REVIEW' }]);
  data.settings.retention['recall-source:' + id] = JSON.stringify({ body: 'PRIVATE-RECALL' });
  data.settings.retention['memory-history:' + id + '-other'] = 'UNRELATED';
  data.tasks.push({ ...data.tasks[0], id: 'from-memory', sourceSession: undefined, sourceId: undefined, sourceTime: undefined, sourceMemoryId: id, sources: [{ kind: 'memory', id }], authorized: true, generationToken: 'still-running' });
  data.memories.push({ ...data.memories[0], id: 'from-task', sourceSession: undefined, sourceId: undefined, sourceTime: undefined, sources: [{ kind: 'task', id: 'from-memory' }] });
  data.messages.push({ id: 'dependent-answer', role: 'assistant', text: 'PRIVATE-ANSWER', sources: [{ kind: 'memory', id: 'from-task' }] });
  const next = memory.permanentlyDeleteMemory(data, id);
  assert.equal(next.memories.some(item => item.id === id), false);
  assert.equal(next.settings.retention['memory-history:' + id], undefined);
  assert.equal(next.settings.retention['reviews:' + id], undefined);
  assert.equal(next.settings.retention['recall-source:' + id], undefined);
  assert.equal(next.settings.retention['memory-history:' + id + '-other'], 'UNRELATED');
  assert.equal(next.tasks.find(item => item.id === 'from-memory').authorized, false);
  assert.equal(next.tasks.find(item => item.id === 'from-memory').generationToken, undefined);
  assert.equal(next.memories.find(item => item.id === 'from-task').confirmed, false);
  assert.equal(next.messages.find(item => item.id === 'dependent-answer').invalidated, true);
  assert.equal(access.provenanceAvailable(next, [{ kind: 'memory', id }]), false);
});
