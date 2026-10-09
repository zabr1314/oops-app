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
const logic = await import('../src/taskSuggestionsLogic.ts');
const access = await import('../src/sourceAccess.ts');
const source = await readFile(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
const sessionId = 'session-001';
const refresh = data => logic.refreshTaskSuggestions(data, sessionId);
const read = data => logic.readTaskSuggestions(data, sessionId);
const fresh = (text = '我来准备首版走查清单，2026-10-10 17:00前完成，优先处理。', extra = {}) => {
  const data = initialData();
  data.sessions[0].transcript.push({ id: 'suggestion', time: '00:18:40', speaker: '我', text, ...extra });
  return refresh(data);
};
const suggestion = data => read(data).items.find(value => value.sourceId === 'suggestion');
const draft = value => ({ title: value.title, ownerId: value.ownerId, due: value.due, priority: value.priority });

test('only actionable text produces candidates; silence, ordinary chat, negated actions and private turns are empty', () => {
  for (const text of ['', '今天聊得挺开心。', '我们讨论了预算和用户。', '不需要准备报告。', '暂不发送邮件。', '桌面伙伴不需要一直说话。']) {
    const data = initialData(); data.sessions[0].transcript = [{ id: 'only', time: '', speaker: '我', text }];
    assert.deepEqual(read(refresh(data)).items, [], text);
  }
  const data = initialData(); data.sessions[0].transcript = [{ id: 'only', time: '', speaker: '我', text: '我来准备走查清单。', private: true }];
  assert.deepEqual(read(refresh(data)).items, []);
});

test('explicit own action extracts title, exact deadline and priority without establishing work', () => {
  const data = fresh(), value = suggestion(data);
  assert.equal(value.ownerId, 'me'); assert.equal(value.due, '2026-10-10T17:00'); assert.equal(value.priority, '高');
  assert.ok(value.title.includes('走查清单')); assert.equal(value.state, 'pending');
  assert.equal(data.tasks.length, initialData().tasks.length);
  assert.ok(value.sources[0].fingerprint);
});

test('unknown recipient and unconfirmed first-person speaker never default to current user', () => {
  for (const [text, speaker] of [['请核实库存。', '王宁'], ['我来核实库存。', '说话人D']]) {
    const data = fresh(text, { speaker }), value = suggestion(data);
    assert.equal(value.ownerId, '');
    assert.ok(logic.createTaskFromSuggestion(data, sessionId, value.id, draft(value)).error);
  }
});

test('only separately name-confirmed contacts can be chosen; voice consent remains off', () => {
  const data = fresh('由叶青负责整理用户访谈。');
  data.people.push({ id: 'confirmed', name: '叶青', role: '设计', company: '', note: '', voice: false, shared: false });
  data.people.push({ id: 'unchecked', name: '陈某', role: '身份待核对', company: '', note: '', voice: false, shared: false });
  data.settings.toggles['person-name-confirmed:confirmed'] = true;
  const next = refresh(data), value = suggestion(next), owners = logic.taskSuggestionOwners(next);
  assert.ok(owners.some(owner => owner.id === 'person:confirmed')); assert.equal(owners.some(owner => owner.id === 'person:unchecked'), false);
  assert.equal(owners.some(owner => owner.id === 'person:p3'), false); assert.equal(value.ownerId, 'person:confirmed');
  const result = logic.createTaskFromSuggestion(next, sessionId, value.id, draft(value), { taskId: 'new-confirmed' });
  assert.equal(result.data.tasks.find(task => task.id === result.taskId).owner, '叶青');
  assert.equal(result.data.people.find(person => person.id === 'confirmed').voice, false);
  assert.equal(result.data.settings.retention[`task-owner-person:${result.taskId}`], 'confirmed');
});

test('ambiguous same-name contacts remain unassigned until an exact card is selected', () => {
  const data = fresh('请王宁准备报告。');
  data.people.push({ id: 'p1-duplicate', name: '王宁', role: '另一项目负责人', company: '', note: '', voice: false, shared: false });
  data.settings.toggles['person-name-confirmed:p1-duplicate'] = true;
  const next = refresh(data), value = suggestion(next);
  assert.equal(value.ownerId, '');
  const owners = logic.taskSuggestionOwners(next).filter(owner => owner.name === '王宁');
  assert.equal(new Set(owners.map(owner => owner.label)).size, 2);
  const result = logic.createTaskFromSuggestion(next, sessionId, value.id, { ...draft(value), ownerId: 'person:p1-duplicate' });
  assert.equal(result.data.settings.retention[`task-owner-person:${result.taskId}`], 'p1-duplicate');
});

test('unknown deadline stays explicit; editing fields persists across repeated extraction', () => {
  let data = fresh('请准备周五要交的报告，周五17点前给我。');
  const value = suggestion(data); assert.equal(value.due, ''); assert.ok(value.dueHint.includes('日期待核对'));
  const fields = { title: '核对后确定的报告', ownerId: 'me', due: '2026-10-09 17:00', priority: '低' };
  data = logic.saveTaskSuggestionDraft(data, sessionId, value.id, fields).data;
  data = refresh(data); data = refresh(data);
  assert.deepEqual(draft(suggestion(data)), { ...fields, due: '2026-10-09T17:00' });
});

test('new task is explicitly pending, private and unauthorized; repeated creation returns same work', () => {
  let data = fresh(), value = suggestion(data);
  const first = logic.createTaskFromSuggestion(data, sessionId, value.id, draft(value), { taskId: 'TASK-NEW', created: '本轮' });
  data = first.data;
  const task = data.tasks.find(task => task.id === first.taskId);
  assert.equal(task.status, '待承接'); assert.equal(task.aiStatus, '未启动'); assert.equal(task.authorized, false);
  assert.equal(task.sourceId, 'suggestion'); assert.equal(task.sources[0].fingerprint, value.sources[0].fingerprint);
  assert.equal(data.settings.retention[`task-space:${task.id}`], '我的空间');
  assert.equal(read(data).items.find(row => row.id === value.id).state, 'created');
  data = refresh(data);
  const twice = logic.createTaskFromSuggestion(data, sessionId, value.id, draft(value), { taskId: 'SHOULD-NOT-CREATE' });
  assert.equal(twice.taskId, first.taskId); assert.equal(twice.existing, true); assert.equal(twice.data.tasks.length, data.tasks.length);
});

test('pre-existing legacy tasks use unique source time and remain links even after cancellation', () => {
  let data = refresh(initialData());
  const original = read(data).items.find(value => value.sourceId === 'tr4');
  assert.equal(original.state, 'created'); assert.equal(original.taskId, 'TASK-021');
  data.tasks.find(task => task.id === 'TASK-021').status = '已取消'; data = refresh(data);
  const value = read(data).items.find(value => value.sourceId === 'tr4');
  assert.equal(value.state, 'created');
  const result = logic.createTaskFromSuggestion(data, sessionId, value.id, { ...draft(value), ownerId: 'me' });
  assert.equal(result.existing, true); assert.equal(result.taskId, 'TASK-021');
});

test('ambiguous time cannot claim another turn or block a task with exact source ID', () => {
  const data = fresh();
  data.sessions[0].transcript.push({ id: 'same-time', time: '00:18:40', speaker: '我', text: '闲聊。' });
  data.tasks.push({ ...data.tasks[0], id: 'ambiguous-time', sourceSession: sessionId, sourceId: undefined, sourceTime: '00:18:40' });
  const next = refresh(data), value = suggestion(next);
  assert.equal(value.state, 'pending');
  const result = logic.createTaskFromSuggestion(next, sessionId, value.id, draft(value));
  assert.equal(result.existing, undefined); assert.equal(result.data.tasks.find(task => task.id === result.taskId).sourceId, 'suggestion');
});

test('ignored state survives reopening and requires explicit recovery before creation', () => {
  let data = fresh(), value = suggestion(data);
  data = logic.setTaskSuggestionIgnored(data, sessionId, value.id).data; data = refresh(data);
  assert.equal(suggestion(data).state, 'ignored');
  assert.ok(logic.createTaskFromSuggestion(data, sessionId, value.id, draft(value)).error);
  data = logic.setTaskSuggestionIgnored(data, sessionId, value.id, false).data;
  assert.equal(suggestion(data).state, 'pending');
});

test('source changes block old drafts and show existing tasks needing review rather than duplicate', () => {
  let data = fresh(), value = suggestion(data);
  data = logic.createTaskFromSuggestion(data, sessionId, value.id, draft(value), { taskId: 'old-source-task' }).data;
  data.sessions[0].transcript = data.sessions[0].transcript.map(turn => turn.id === 'suggestion' ? { ...turn, text: '我来整理用户访谈，明天再核对。' } : turn);
  data = access.invalidateSessionSources(data, sessionId, ['suggestion']);
  assert.ok(read(data).staleCount > 0);
  assert.ok(logic.saveTaskSuggestionDraft(data, sessionId, value.id, draft(value)).error);
  assert.ok(logic.createTaskFromSuggestion(data, sessionId, value.id, draft(value)).error);
  data = refresh(data); const latest = suggestion(data);
  assert.equal(latest.state, 'created'); assert.equal(latest.taskNeedsReview, true); assert.equal(latest.taskId, 'old-source-task');
  assert.equal(data.tasks.filter(task => task.sourceId === 'suggestion').length, 1);
});

test('private and removed sources block adoption and cannot be regenerated', () => {
  for (const remove of [false, true]) {
    let data = fresh(), value = suggestion(data);
    data.sessions[0].transcript = remove ? data.sessions[0].transcript.filter(turn => turn.id !== 'suggestion') : data.sessions[0].transcript.map(turn => turn.id === 'suggestion' ? { ...turn, private: true } : turn);
    assert.ok(logic.createTaskFromSuggestion(data, sessionId, value.id, draft(value)).error);
    data = refresh(data); assert.equal(suggestion(data), undefined);
  }
});

test('team space cannot read or mutate personal candidates and bad fields do not create work', () => {
  const data = fresh(), value = suggestion(data);
  for (const fields of [{ ...draft(value), title: '' }, { ...draft(value), due: '2026-02-30 17:00' }, { ...draft(value), ownerId: 'person:p3' }]) assert.ok(logic.createTaskFromSuggestion(data, sessionId, value.id, fields).error);
  assert.equal(data.tasks.length, 3);
  data.settings.space = 'Oops 产品团队'; data.settings.toggles[`shared-${sessionId}`] = true;
  assert.deepEqual(read(data), { items: [], staleCount: 0, generated: false });
  assert.strictEqual(refresh(data), data);
  assert.ok(logic.createTaskFromSuggestion(data, sessionId, value.id, draft(value)).error);
});
