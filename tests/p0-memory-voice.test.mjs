import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(target.pathname)) for (const extension of ['.ts', '.tsx', '.js']) {
      const candidate = new URL(target.href + extension);
      if (existsSync(candidate)) return next(candidate.href, context);
    }
  }
  return next(specifier, context);
} });
const source = await readFile(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
const { projectMemorySummary } = await import('../src/projectMemoryLogic.ts');
const voice = await import('../src/voiceIdentityLogic.ts');
const access = await import('../src/sourceAccess.ts');
const intelligence = await import('../src/sessionIntelligenceLogic.ts');
const TEAM = 'Oops 产品团队';
const asTeam = data => ({ ...data, settings: { ...data.settings, space: TEAM } });
const decision = (id, sourceId, fields = {}) => ({ id, sourceId, text: id, kind: 'conclusion', confirmed: true, shared: true, ...fields });
const saveDecisions = (data, items) => { data.settings.toggles['review-session-001'] = false; data.settings.retention['session-review-items:session-001'] = JSON.stringify(items); return data; };
const makeSample = (id = 'sample-1') => ({ id, label: '对话声音', duration: 8, phrase: '示例一句话', quality: '清晰', created: '10/9 10:00' });
const withSample = (data = initialData(), id = 'sample-1') => voice.addVoiceSample(data, makeSample(id)).data;

test('project summary separates actual project tasks from similarly titled unrelated tasks', () => {
  const data = initialData();
  const unrelated = { ...data.sessions[0], id: 'foreign-session', project: '另一个项目' };
  data.sessions.push(unrelated);
  data.tasks.push({ ...data.tasks[0], id: 'foreign-task', title: 'Oops 首版相关名词', sourceSession: unrelated.id });
  data.tasks.push({ ...data.tasks[0], id: 'manual-project-task', sourceSession: undefined, sourceTime: undefined, sources: [{ kind: 'project', id: 'project-1' }] });
  const result = projectMemorySummary(data, 'project-1');
  assert.equal(result.sessions.every(session => session.project === 'Oops 首版'), true);
  assert.equal(result.tasks.some(task => task.id === 'foreign-task'), false);
  assert.equal(result.tasks.some(task => task.id === 'manual-project-task'), true);
  assert.equal(result.tasks.some(task => task.id === 'TASK-021'), true);
});

test('only confirmed decisions with a current exact source enter the project summary', () => {
  const data = saveDecisions(initialData(), [decision('public', 'tr2'), decision('manual', undefined), decision('missing', 'removed-turn'), decision('candidate', 'tr4', { confirmed: false }), decision('question', 'tr4', { kind: 'question' })]);
  assert.deepEqual(projectMemorySummary(data, 'project-1').decisions.map(row => row.item.id), ['public', 'manual']);
  data.settings.toggles['review-session-001'] = true;
  assert.deepEqual(projectMemorySummary(data, 'project-1').decisions, []);
});

test('a fresh single decision appears during session review without exposing old stale confirmations', () => {
  let data = saveDecisions(initialData(), [decision('old-manual-decision', 'tr2')]);
  data = access.invalidateSessionSources(data, 'session-001', ['tr2'], '原话发生变化');
  data.sessions[0].transcript.find(turn => turn.id === 'tr2').text = '决定先把首版记录流程跑通';
  data = intelligence.refreshSessionIntelligence(data, 'session-001', 'decisions');
  const candidate = intelligence.readSessionIntelligence(data, 'session-001', 'decisions').items.find(row => row.sources.some(ref => ref.sourceId === 'tr2'));
  const accepted = intelligence.updateIntelligenceItem(data, 'session-001', 'decisions', candidate.id, { state: 'accepted' });
  assert.equal(accepted.error, undefined);
  data = accepted.data;
  assert.equal(data.settings.toggles['review-session-001'], true);
  assert.deepEqual(projectMemorySummary(data, 'project-1').decisions.map(row => row.item.text), [candidate.text]);
  assert.equal(projectMemorySummary(data, 'project-1').decisions.some(row => row.item.id === 'old-manual-decision'), false);
  data.settings.toggles['shared-session-001'] = true;
  data.settings.retention['session-review-items:session-001'] = JSON.stringify(JSON.parse(data.settings.retention['session-review-items:session-001']).map(row => ({ ...row, shared: true })));
  assert.deepEqual(projectMemorySummary(asTeam(data), 'project-1').decisions.map(row => row.item.text), [candidate.text]);
  data.sessions[0].transcript.find(turn => turn.id === 'tr2').text = '决定改为先做另一个方案';
  assert.deepEqual(projectMemorySummary(data, 'project-1').decisions, []);
  assert.deepEqual(projectMemorySummary(asTeam(data), 'project-1').decisions, []);
});

test('team project summary excludes private or unshared decisions and unavailable sessions', () => {
  const data = saveDecisions(initialData(), [decision('public', 'tr2'), decision('private', 'tr4'), decision('unshared', 'tr2', { shared: false }), decision('shared-manual', undefined)]);
  data.sessions[0].transcript.find(turn => turn.id === 'tr4').private = true;
  data.settings.toggles['shared-session-001'] = true;
  const team = asTeam(data);
  assert.deepEqual(projectMemorySummary(team, 'project-1').decisions.map(row => row.item.id), ['public', 'shared-manual']);
  team.settings.toggles['shared-session-001'] = false;
  assert.deepEqual(projectMemorySummary(team, 'project-1').decisions, []);
  assert.deepEqual(projectMemorySummary(team, 'project-1').tasks, []);
  team.settings.retention['project-space:project-1'] = '别的团队';
  assert.deepEqual(projectMemorySummary(team, 'project-1').sessions, []);
});

test('project task summaries reject stale provenance even when the main session is visible', () => {
  const data = initialData(), task = data.tasks[0];
  const ref = access.makeSourceReference(data, { kind: 'session', id: 'session-001', sourceId: 'tr2' });
  task.sources = [ref];
  data.sessions[0].transcript.find(turn => turn.id === 'tr2').text = '已经改写';
  assert.equal(projectMemorySummary(data, 'project-1').tasks.some(row => row.id === task.id), false);
});

test('a private memory cannot provide team task membership through a legacy sourceMemoryId', () => {
  const data = initialData(), memory = data.memories[0];
  memory.tags.push('Oops 首版'); memory.visibility = '私有';
  data.settings.retention['task-space:private-memory-task'] = TEAM;
  data.tasks.push({ ...data.tasks[0], id: 'private-memory-task', sourceSession: undefined, sourceTime: undefined, sourceMemoryId: memory.id, sources: undefined });
  assert.equal(projectMemorySummary(asTeam(data), 'project-1').tasks.some(row => row.id === 'private-memory-task'), false);
});

test('new sound samples require a separate explicit identity association and personal space', () => {
  const data = initialData(), sample = { ...makeSample(), subjectId: 'p1' };
  const result = voice.addVoiceSample(data, sample);
  assert.equal(voice.voiceSamples(result.data)[0].subjectId, undefined);
  assert.match(voice.addVoiceSample(asTeam(data), sample).error, /个人空间/);
  assert.match(voice.addVoiceSample(result.data, sample).error, /已保存/);
});

test('name confirmation and voice consent stay separate without adopting transcript turns', () => {
  const data = withSample();
  data.people.push({ id: 'checked-no-voice', name: '林可', role: '产品', company: '', note: '', voice: false, shared: false });
  data.settings.toggles['person-name-confirmed:checked-no-voice'] = true;
  assert.match(voice.bindVoiceSample(data, 'sample-1', 'checked-no-voice').error, /声音许可/);
  const bound = voice.bindVoiceSample(data, 'sample-1', 'checked-no-voice', true).data;
  assert.equal(bound.people.find(person => person.id === 'checked-no-voice').voice, true);
  assert.deepEqual(bound.sessions, data.sessions);
  assert.equal(bound.settings.toggles['voiceShare:checked-no-voice'], undefined);
  assert.equal(voice.voiceSamples(bound)[0].subjectId, 'checked-no-voice');
  data.people.push({ id: 'unverified', name: '林可', role: '', company: '', note: '', voice: false, shared: false });
  assert.match(voice.bindVoiceSample(data, 'sample-1', 'unverified', true).error, /先确认联系人姓名/);
});

test('self association cannot bypass the complete self-registration permission', () => {
  const data = withSample(); data.settings.toggles.voice = false;
  assert.match(voice.bindVoiceSample(data, 'sample-1', voice.SELF_VOICE_ID, true).error, /声音登记/);
  data.settings.toggles.voice = true;
  assert.equal(voice.voiceSamples(voice.bindVoiceSample(data, 'sample-1', voice.SELF_VOICE_ID).data)[0].subjectId, voice.SELF_VOICE_ID);
});

test('low-confidence and failed recognition remain unconfirmed, while matching uses the exact permitted ID', () => {
  const data = voice.bindVoiceSample(withSample(), 'sample-1', 'p1').data;
  const low = voice.runVoiceMatch(data, 'sample-1', '低置信度', 'low', '现在').match;
  assert.equal(low.status, '待确认'); assert.equal(low.proposedSubjectId, 'p1'); assert.equal(low.confirmedSubjectId, undefined);
  const failed = voice.runVoiceMatch(data, 'sample-1', '识别失败', 'fail', '现在').match;
  assert.equal(failed.status, '识别失败'); assert.equal(failed.proposedSubjectId, undefined); assert.equal(failed.confirmedSubjectId, undefined);
  const match = voice.runVoiceMatch(data, 'sample-1', '匹配', 'match', '现在').match;
  assert.equal(match.status, '已匹配'); assert.equal(match.confirmedSubjectId, 'p1'); assert.equal(match.confidence, 94);
});

test('correction binds a specific namesake and invalidates other results for that sound sample', () => {
  let data = voice.bindVoiceSample(withSample(), 'sample-1', 'p1').data;
  data.people.push({ ...data.people.find(person => person.id === 'p1'), id: 'namesake', voice: false });
  data.settings.toggles['person-name-confirmed:namesake'] = true;
  data = voice.runVoiceMatch(data, 'sample-1', '匹配', 'first', '10:01').data;
  data = voice.runVoiceMatch(data, 'sample-1', '匹配', 'second', '10:02').data;
  const corrected = voice.resolveVoiceMatch(data, 'second', 'namesake', true).data;
  assert.equal(voice.voiceSamples(corrected)[0].subjectId, 'namesake');
  assert.equal(voice.voiceMatches(corrected).find(match => match.id === 'second').status, '已纠正');
  assert.equal(voice.voiceMatches(corrected).find(match => match.id === 'second').previousSubjectId, 'p1');
  assert.equal(voice.voiceMatches(corrected).find(match => match.id === 'first').confirmedSubjectId, undefined);
  assert.equal(voice.voiceMatches(corrected).find(match => match.id === 'first').status, '待确认');
  assert.deepEqual(corrected.sessions, data.sessions);
});

test('revoking voice permission preserves a legacy confirmed name and blocks old recognition results', () => {
  let data = voice.bindVoiceSample(withSample(), 'sample-1', 'p1').data;
  delete data.settings.toggles['person-name-confirmed:p1'];
  data.settings.toggles['voiceShare:p1'] = true;
  data = voice.runVoiceMatch(data, 'sample-1', '匹配', 'match', '现在').data;
  const revoked = voice.revokeContactVoice(data, 'p1').data;
  assert.equal(revoked.people.find(person => person.id === 'p1').voice, false);
  assert.equal(revoked.settings.toggles['person-name-confirmed:p1'], true);
  assert.equal(revoked.settings.toggles['voiceShare:p1'], false);
  assert.equal(voice.currentVoiceMatch(revoked, voice.voiceMatches(revoked)[0]).status, '待确认');
  assert.equal(voice.currentVoiceMatch(revoked, voice.voiceMatches(revoked)[0]).confirmedSubjectId, undefined);
});

test('anonymous choice, unbinding, and deletion do not change names or other sound samples', () => {
  let data = voice.bindVoiceSample(withSample(), 'sample-1', 'p1').data;
  data = withSample(data, 'sample-2');
  data = voice.runVoiceMatch(data, 'sample-1', '匹配', 'match', '现在').data;
  const anonymous = voice.resolveVoiceMatch(data, 'match', undefined).data;
  assert.equal(voice.voiceMatches(anonymous)[0].status, '保持匿名');
  assert.equal(voice.voiceMatches(anonymous)[0].confirmedSubjectId, undefined);
  const unbound = voice.unbindVoiceSample(data, 'sample-1').data;
  assert.equal(voice.voiceSamples(unbound).find(sample => sample.id === 'sample-1').subjectId, undefined);
  assert.equal(voice.voiceMatches(unbound)[0].status, '待确认');
  const removed = voice.unbindVoiceSample(data, 'sample-1', true).data;
  assert.deepEqual(voice.voiceSamples(removed).map(sample => sample.id), ['sample-2']);
  assert.deepEqual(voice.voiceMatches(removed), []);
  assert.deepEqual(removed.people, data.people);
});
