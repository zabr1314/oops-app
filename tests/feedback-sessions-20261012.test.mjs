import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(target.pathname)) for (const extension of ['.ts', '.tsx', '.js', '.mjs']) {
      const candidate = new URL(target.href + extension);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
} });
const presentation = await import('../src/sessionPresentationLogic.ts');
const intelligence = await import('../src/sessionIntelligenceLogic.ts');
const suggestions = await import('../src/taskSuggestionsLogic.ts');
const access = await import('../src/sourceAccess.ts');
const source = await readFile(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
const id = 'session-001';
const current = data => data.sessions.find(session => session.id === id);
const read = (data, shared = false) => presentation.readSessionPresentation(data, current(data), shared);
const setup = () => {
  const data = initialData();
  data.tasks = []; data.memories = [];
  current(data).agenda = ['库存核实', '预算确认'];
  current(data).transcript = [
    { id: 'decision', speaker: '我', time: '00:01:00', text: '决定先按十万元预算。' },
    { id: 'action', speaker: '我', time: '00:02:00', text: '我来核实蓝色椅子的库存，周五17点前给一版清单。' },
    { id: 'chat', speaker: '我', time: '00:03:00', text: '今天聊得挺开心。' },
  ];
  return data;
};
const prepared = data => presentation.prepareSessionCandidates(data, id);
const draft = value => ({ title: value.title, ownerId: value.ownerId, due: value.due, priority: value.priority, constraint: value.constraint });

test('session list can preview findings without mutating or accepting any data', () => {
  const data = setup(), before = JSON.stringify(data), result = read(data);
  assert.equal(JSON.stringify(data), before);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.actions.length, 1);
  assert.equal(result.findings.find(value => value.kind === '决定').route.mode, result.decisions[0].id);
  assert.equal(result.findings.find(value => value.kind === '行动').route.mode, result.actions[0].id);
  assert.equal(result.decisions[0].state, 'pending');
  assert.equal(data.tasks.length, 0);
});

test('accepting or rejecting a decision updates the list pending count without losing confirmed results', () => {
  let data = prepared(setup());
  const result = read(data), decision = result.decisions[0];
  const before = result.pendingCount;
  data = intelligence.updateIntelligenceItem(data, id, 'decisions', decision.id, { state: 'accepted' }).data;
  assert.equal(read(data).pendingCount, before - 1);
  assert.equal(read(data).decisions[0].state, 'accepted');
  assert.equal(read(data).checks.some(value => value.label === '决定候选'), false);
  data = intelligence.updateIntelligenceItem(data, id, 'decisions', decision.id, { state: 'rejected' }).data;
  assert.equal(read(data).decisions.length, 0);
});

test('creating an action replaces its draft with the existing task check instead of counting it twice', () => {
  let data = prepared(setup());
  const action = read(data).actions[0];
  data = suggestions.createTaskFromSuggestion(data, id, action.id, draft(action), { taskId: 'new-work' }).data;
  assert.equal(read(data).actions.length, 0);
  assert.equal(read(data).checks.find(value => value.label === '已有任务').count, 1);
  assert.equal(read(data).checks.some(value => value.label === '行动草稿'), false);
  data.tasks[0].status = '已承接';
  assert.equal(read(data).checks.some(value => value.label === '已有任务'), false);
  assert.equal(data.tasks[0].authorized, false);
});

test('ignored action candidates stay ignored when list preview and overview refresh their contents', () => {
  let data = prepared(setup());
  const action = read(data).actions[0];
  data = suggestions.setTaskSuggestionIgnored(data, id, action.id, true).data;
  assert.equal(read(data).actions.length, 0);
  data = prepared(data);
  assert.equal(read(data).actions.length, 0);
  assert.equal(suggestions.readTaskSuggestions(data, id).items.find(value => value.id === action.id).state, 'ignored');
});

test('source edits replace candidate IDs and remove old quotes from findings, chapters and action drafts', () => {
  let data = prepared(setup());
  const old = read(data).actions[0];
  data = access.invalidateSessionSources(data, id, ['action'], '原话修订');
  current(data).transcript.find(value => value.id === 'action').text = '我来整理用户访谈摘要。';
  const next = read(data);
  assert.equal(next.actions.some(value => value.id === old.id), false);
  assert.equal(next.actions[0].title.includes('用户访谈'), true);
  assert.equal(JSON.stringify(next).includes('蓝色椅子'), false);
  assert.match(suggestions.createTaskFromSuggestion(data, id, old.id, draft(old)).error, /来源已变化/);
});

test('chapter state follows the selected agenda index and never confirms decisions automatically', () => {
  const data = setup();
  data.settings.retention[`agenda-${id}`] = '1';
  const result = read(data);
  assert.equal(result.topic, '预算确认');
  assert.deepEqual(result.chapters.slice(0, 2).map(value => value.state), ['已讨论', '当前']);
  assert.deepEqual(result.chapters.find(value => value.id === 'other').turns.map(value => value.id), ['chat']);
  assert.equal(result.chapters.filter(value => value.state === '当前').length, 1);
  assert.equal(result.decisions[0].state, 'pending');
  assert.equal(data.settings.retention[`session-review-items:${id}`], undefined);
});

test('shared preview exposes public chapters only and never includes personal candidates or counts', () => {
  const data = prepared(setup());
  current(data).transcript.push({ id: 'secret', speaker: '未知访客', time: '00:04:00', text: '私密项目底价。', private: true });
  const result = read(data, true);
  assert.equal(JSON.stringify(result).includes('私密项目'), false);
  for (const key of ['actions', 'decisions', 'understanding', 'notices', 'checks', 'findings']) assert.deepEqual(result[key], []);
  data.settings.space = '其他团队';
  const forbidden = read(data);
  assert.equal(forbidden.topic, '');
  assert.deepEqual(forbidden.chapters, []);
});

test('editing delivery requirements survives regeneration and is saved independently from the original quote', () => {
  let data = prepared(setup());
  let value = read(data).actions[0];
  const fields = { ...draft(value), constraint: '只核对现货与预留，交付一页清单；缺失数据先提问。' };
  data = suggestions.saveTaskSuggestionDraft(data, id, value.id, fields).data;
  data = prepared(data); value = read(data).actions[0];
  assert.equal(value.constraint, fields.constraint);
  assert.equal(value.text.includes('蓝色椅子'), true);
  const result = suggestions.createTaskFromSuggestion(data, id, value.id, fields, { taskId: 'requirements' });
  assert.equal(result.error, undefined);
  const task = result.data.tasks.find(value => value.id === 'requirements');
  assert.equal(task.description, fields.constraint);
  assert.equal(task.sourceId, 'action');
  assert.equal(access.sourceTurn(result.data, task).text.includes('蓝色椅子'), true);
  assert.equal(task.aiStatus, '未启动');
  assert.equal(task.authorized, false);
});

test('legacy drafts without constraint retain the saved requirement and empty explicit requirements are rejected', () => {
  let data = prepared(setup());
  const value = read(data).actions[0];
  const saved = suggestions.saveTaskSuggestionDraft(data, id, value.id, { ...draft(value), constraint: '保存过的明确要求' });
  data = saved.data;
  const { constraint, ...legacy } = draft(value);
  const result = suggestions.createTaskFromSuggestion(data, id, value.id, legacy, { taskId: 'legacy' });
  assert.equal(result.error, undefined);
  assert.equal(result.data.tasks.find(value => value.id === 'legacy').description, '保存过的明确要求');
  assert.match(suggestions.createTaskFromSuggestion(data, id, value.id, { ...draft(value), constraint: '  ' }).error, /具体要求/);
});
