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
const presentation = await import('../src/feedbackPresentation.ts');
const memorySource = readFileSync(new URL('../src/features/MemorySettings.tsx', import.meta.url), 'utf8');
const base = new URL('../', import.meta.url);
const dependency = `import { sharedMemoryEligible } from '${new URL('src/memoryAccess.ts', base)}';\nimport { sourceAvailable, sourceTurn, taskVisible, findSourceTask, invalidateSessionSources, makeSourceReference, provenanceAvailable } from '${new URL('src/sourceAccess.ts', base)}';\n`;
const memory = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(dependency + memorySource.slice(memorySource.indexOf('const PERSONAL'), memorySource.indexOf('function Download')), { mode: 'strip' })).toString('base64'));
const reference = new Date('2026-10-12T04:00:00Z');
const person = id => ({ id, name: '待确认', role: '未核对身份', company: '', note: '', voice: false, shared: false });

test('a person card uses only explicit unresolved bindings, ordered by conversation and passage time', () => {
  const data = initialData();
  const session = data.sessions[0]; session.date = '2026年10月10日 10:00';
  session.transcript = [
    { id: 'early', personId: 'p3', speaker: '待确认', time: '00:01:00', text: '资料需要同步。' },
    { id: 'late', personId: 'p3', speaker: '待确认', time: '00:03:00', text: '再确认预算。' },
    { id: 'pool', speaker: '待确认', time: '00:04:00', text: '另一个未关联的人。' },
    { id: 'other', personId: 'someone-else', speaker: '待确认', time: '00:05:00', text: '另一个明确人物。' },
    { id: 'name-only', speaker: '王宁', time: '00:06:00', text: '没有身份ID。' },
  ];
  data.sessions.push({ ...session, id: 'newest', date: '昨天 15:00', transcript: [{ id: 'latest', personId: 'p3', speaker: '待确认', time: '00:02:00', text: '项目任务。' }] });
  const before = structuredClone(data);
  assert.deepEqual(presentation.personIdentityClues(data, 'p3', reference).map(clue => clue.turn.id), ['latest', 'late', 'early']);
  assert.deepEqual(presentation.unboundIdentityClues(data, reference).map(clue => clue.turn.id), ['pool']);
  assert.deepEqual(data, before);
});

test('unbound passages are kept separate from legacy unknown cards and expose no invented attribution', () => {
  const data = initialData();
  assert.equal(presentation.personIdentityClues(data, 'p3').length, 0);
  assert.equal(presentation.personIdentityClues(data, 'missing').length, 0);
  const clues = presentation.unboundIdentityClues(data);
  assert.deepEqual(clues.map(clue => [clue.session.id, clue.turn.id, clue.exactPerson]), [['session-001', 'tr3', false]]);
  assert.equal(clues[0].turn.personId, undefined);
});

test('checked, archived, planned and team-space identity clues are excluded', () => {
  const data = initialData(), session = data.sessions[0];
  session.transcript = [{ id: 'unknown', personId: 'p3', speaker: '待确认', time: '00:01', text: '本人私有内容。', private: true }];
  assert.equal(presentation.personIdentityClues(data, 'p3').length, 1);
  data.settings.toggles['speaker-confirmed:session-001:unknown'] = true;
  assert.equal(presentation.personIdentityClues(data, 'p3').length, 0);
  delete data.settings.toggles['speaker-confirmed:session-001:unknown'];
  session.archived = true;
  assert.equal(presentation.personIdentityClues(data, 'p3').length, 0);
  session.archived = false; session.status = '待开始';
  assert.equal(presentation.personIdentityClues(data, 'p3').length, 0);
  session.status = '已结束'; data.people[2].shared = true; data.settings.space = 'Oops 产品团队'; data.settings.toggles['shared-session-001'] = true;
  assert.equal(presentation.personIdentityClues(data, 'p3').length, 0);
  assert.equal(presentation.unboundIdentityClues(data).length, 0);
});

test('front-card routes bind the selected passage and reject another person or stale evidence', () => {
  const data = initialData();
  data.sessions[0].transcript[2].personId = 'p3';
  data.people.push(person('p4'));
  const clue = presentation.personIdentityClues(data, 'p3')[0];
  const route = presentation.identityClueRoute(clue, 'p3', true);
  const selected = presentation.identityClueSelection(data, route.id, route.mode);
  assert.equal(selected.session.id, 'session-001');
  assert.equal(selected.turn.id, 'tr3');
  assert.equal(selected.create, true);
  assert.equal(presentation.identityClueSelection(data, 'p4', route.mode), undefined);
  assert.equal(presentation.identityClueSelection(data, undefined, route.mode), undefined);
  data.settings.toggles['speaker-confirmed:session-001:tr3'] = true;
  assert.equal(presentation.identityClueSelection(data, 'p3', route.mode), undefined);
  delete data.settings.toggles['speaker-confirmed:session-001:tr3']; data.sessions[0].archived = true;
  assert.equal(presentation.identityClueSelection(data, 'p3', route.mode), undefined);
  assert.equal(presentation.identityClueSelection(data, 'p3', '{bad'), undefined);
});

test('unbound route is an explicit passage choice, not an automatic person confirmation', () => {
  const data = initialData(), before = structuredClone(data);
  const clue = presentation.unboundIdentityClues(data)[0];
  const route = presentation.identityClueRoute(clue, undefined, true);
  assert.equal(route.id, undefined);
  assert.equal(presentation.identityClueSelection(data, undefined, route.mode).turn.id, 'tr3');
  assert.equal(presentation.identityClueSelection(data, 'p3', route.mode).exactPerson, false);
  assert.deepEqual(data, before);
  data.settings.space = 'Oops 产品团队';
  assert.equal(presentation.identityClueSelection(data, undefined, route.mode), undefined);
});

test('content keywords are literal evidence, never guessed interests or a person name', () => {
  const data = initialData(), clue = presentation.unboundIdentityClues(data)[0];
  assert.deepEqual(presentation.identityClueTopics(clue), ['资料']);
  clue.turn = { ...clue.turn, text: '周五同步预算，然后把设计方案和PPT发来。' };
  assert.deepEqual(presentation.identityClueTopics(clue), ['同步', '预算', '设计']);
  clue.turn = { ...clue.turn, text: '你好，下次见。' };
  assert.deepEqual(presentation.identityClueTopics(clue), []);
});

test('choosing an existing contact reuses that record without voice consent or a new archive', () => {
  const data = initialData(); data.people[0].voice = false;
  const route = presentation.identityClueRoute(presentation.unboundIdentityClues(data)[0]);
  const selected = presentation.identityClueSelection(data, undefined, route.mode);
  const result = memory.confirmPersonSpeaker(data, { sessionId: selected.session.id, turnId: selected.turn.id, targetPersonId: 'p1', name: '王宁', voiceConsent: false });
  assert.equal(result.error, undefined);
  assert.equal(result.data.people.length, data.people.length);
  assert.equal(result.personId, 'p1');
  assert.equal(result.data.people.find(person => person.id === 'p1').voice, false);
  assert.equal(result.data.sessions[0].transcript.find(turn => turn.id === 'tr3').personId, 'p1');
  assert.equal(result.data.tasks.find(task => task.id === 'TASK-033').owner, data.tasks.find(task => task.id === 'TASK-033').owner);
  assert.equal(result.data.settings.toggles['voiceShare:p1'], undefined);
});

test('building from a bound unknown keeps one archive and changes only the selected passage', () => {
  const data = initialData(); data.sessions[0].transcript[2].personId = 'p3';
  data.sessions[0].transcript.push({ id: 'unselected', personId: 'p3', speaker: '待确认', time: '00:17:00', text: '另一段仍需核对。' });
  const clue = presentation.personIdentityClues(data, 'p3').find(clue => clue.turn.id === 'tr3');
  const route = presentation.identityClueRoute(clue, 'p3', true), selected = presentation.identityClueSelection(data, 'p3', route.mode);
  const result = memory.confirmPersonSpeaker(data, { personId: route.id, sessionId: selected.session.id, turnId: selected.turn.id, name: '陈晨', voiceConsent: false });
  assert.equal(result.error, undefined);
  assert.equal(result.personId, 'p3');
  assert.equal(result.data.people.length, data.people.length);
  assert.equal(result.data.people.find(person => person.id === 'p3').name, '陈晨');
  assert.equal(result.data.people.find(person => person.id === 'p3').voice, false);
  assert.equal(result.data.settings.toggles['speaker-confirmed:session-001:unselected'], undefined);
  assert.equal(result.data.sessions[0].transcript.find(turn => turn.id === 'unselected').speaker, '待确认');
  assert.deepEqual(presentation.personIdentityClues(result.data, 'p3').map(clue => clue.turn.id), ['unselected']);
});
