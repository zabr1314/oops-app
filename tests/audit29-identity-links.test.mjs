import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(target.pathname)) for (const ext of ['.ts', '.tsx', '.js']) {
      const candidate = new URL(target.href + ext);
      if (existsSync(candidate)) return next(candidate.href, context);
    }
  }
  return next(specifier, context);
} });
const suggestions = await import('../src/taskSuggestionsLogic.ts');
const access = await import('../src/sourceAccess.ts');
const workflow = await import('../src/taskWorkflow.ts');
const communication = await import('../src/communicationLogic.ts');
const source = readFileSync(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));

function makeCandidate(person, speaker = person.name) {
  let data = initialData();
  data.people.push(person);
  data.sessions[0].transcript.push({ id: 'identity-task', time: '00:22:00', speaker, personId: person.id, text: '我来准备走查清单。' });
  data.settings.toggles['speaker-confirmed:session-001:identity-task'] = true;
  data = suggestions.refreshTaskSuggestions(data, 'session-001');
  const item = suggestions.readTaskSuggestions(data, 'session-001').items.find(item => item.sourceId === 'identity-task');
  return { data, item };
}

test('a confirmed namesake saying I will do it remains that person across suggestion, task and follow-up', () => {
  const { data, item } = makeCandidate({ id: 'namesake', name: '林', role: '已核对身份', company: '另一团队', note: '', voice: false, shared: false });
  assert.equal(item.ownerId, 'person:namesake');
  const result = suggestions.createTaskFromSuggestion(data, 'session-001', item.id, { title: item.title, ownerId: item.ownerId, due: '', priority: item.priority });
  assert.equal(result.error, undefined);
  const task = result.data.tasks.find(task => task.id === result.taskId);
  assert.equal(task.ownerPersonId, 'namesake');
  assert.equal(task.requesterPersonId, 'namesake');
  assert.equal(workflow.taskBelongsToMe(result.data, task), false);
  assert.equal(workflow.taskRequestedByMe(result.data, task), false);
  assert.equal(communication.buildCommunicationDraft(task, '消息', '林', [], { data: result.data }).target, '林');
});

test('a renamed confirmed speaker uses their current card for newly created tasks while retaining the historic quote', () => {
  const { data, item } = makeCandidate({ id: 'renamed', name: '陈明', role: '已核对身份', company: '', note: '', voice: false, shared: false }, '小陈');
  const result = suggestions.createTaskFromSuggestion(data, 'session-001', item.id, { title: item.title, ownerId: 'me', due: '', priority: item.priority });
  const task = result.data.tasks.find(task => task.id === result.taskId);
  assert.equal(task.requester, '陈明');
  assert.equal(task.requesterPersonId, 'renamed');
  assert.equal(access.sourceTurn(result.data, task).speaker, '小陈');
  assert.equal(communication.buildCommunicationDraft(task, '消息', '林', [], { data: result.data }).target, '陈明');
});

test('switching same-name identity invalidates preparation and communication snapshots', () => {
  const data = initialData();
  const task = { ...data.tasks[0], owner: '我', requester: '王宁', requesterPersonId: 'first', status: '已承接', aiStatus: '未启动', sourceSession: undefined, sourceTime: undefined, sources: [], authorized: true, scope: { sources: '本人资料', destination: '个人成果', space: '我的空间', includeSource: false, materialIds: [] } };
  data.tasks = [task];
  const started = workflow.beginGeneration(data, task.id, { token: 'identity-run' });
  assert.equal(started.error, undefined);
  const current = started.data.tasks[0];
  const draft = communication.buildCommunicationDraft(current, '消息', '林', [], { data: started.data });
  const changed = { ...current, requesterPersonId: 'second' };
  assert.notEqual(access.generationConfigurationFingerprint(current), access.generationConfigurationFingerprint(changed));
  assert.notEqual(communication.communicationTaskSnapshot(current), communication.communicationTaskSnapshot(changed));
  const updated = { ...started.data, tasks: [changed] };
  assert.equal(access.generationCanComplete(updated, changed, 'identity-run'), false);
  assert.equal(communication.canSubmitCommunication(updated, changed, draft).ok, false);
});
