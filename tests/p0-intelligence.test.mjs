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
const logic = await import('../src/sessionIntelligenceLogic.ts');
const access = await import('../src/sourceAccess.ts');
const taskSuggestions = await import('../src/taskSuggestionsLogic.ts');
const source = await readFile(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
const sessionId = 'session-001';
const refresh = (data, kind) => logic.refreshSessionIntelligence(data, sessionId, kind);
const read = (data, kind) => logic.readSessionIntelligence(data, sessionId, kind);
const review = data => JSON.parse(data.settings.retention[`session-review-items:${sessionId}`] || '[]');
const candidateFor = (data, sourceId) => read(data, 'decisions').items.find(value => value.sources.some(ref => ref.sourceId === sourceId));
const mutateTurn = (data, sourceId, patch) => ({ ...data, sessions: data.sessions.map(session => session.id === sessionId ? { ...session, transcript: session.transcript.map(turn => turn.id === sourceId ? { ...turn, ...patch } : turn) } : session) });

test('five understanding results use exact visible evidence and preserve user corrections', () => {
  let data = refresh(initialData(), 'understanding');
  assert.deepEqual(read(data, 'understanding').items.map(value => value.kind), ['topic', 'people', 'event', 'intent', 'context']);
  const focus = read(data, 'understanding').items[0];
  data = logic.updateIntelligenceItem(data, sessionId, 'understanding', focus.id, { text: '我修正的本次议题' }).data;
  data.sessions[0].transcript.push({ id: 'extra', time: '00:18:30', speaker: '我', text: '继续确认首版目标。' });
  data = refresh(data, 'understanding');
  assert.equal(read(data, 'understanding').items.find(value => value.kind === 'topic').text, '我修正的本次议题');
  assert.equal(read(data, 'understanding').items.find(value => value.kind === 'topic').edited, true);
});

test('no raw text and entirely private text produce real empty states', () => {
  for (const privateOnly of [false, true]) {
    const data = initialData();
    data.sessions[0].transcript = privateOnly ? data.sessions[0].transcript.map(turn => ({ ...turn, private: true })) : [];
    const next = refresh(data);
    for (const kind of ['understanding', 'decisions', 'notices', 'personal']) assert.deepEqual(read(next, kind).items, []);
  }
});

test('team space cannot read, generate, correct or adopt private intelligence', () => {
  let data = refresh(initialData());
  const candidate = candidateFor(data, 'tr2');
  const stored = data.settings.retention[logic.intelligenceKey('decisions', sessionId)];
  data.settings.space = 'Oops 产品团队';
  data.settings.toggles[`shared-${sessionId}`] = true;
  assert.deepEqual(read(data, 'decisions'), { items: [], staleCount: 0, generated: false });
  assert.equal(refresh(data).settings.retention[logic.intelligenceKey('decisions', sessionId)], stored);
  assert.ok(logic.updateIntelligenceItem(data, sessionId, 'decisions', candidate.id, { state: 'accepted' }).error);
});

test('source revision hides old text, blocks old acceptance and replaces only its intelligent conclusion', () => {
  let data = initialData();
  data.settings.retention[`session-review-items:${sessionId}`] = JSON.stringify([{ id: 'manual', kind: 'conclusion', text: '另一项人工确认', confirmed: true, shared: false, sourceId: 'tr2' }]);
  data = refresh(data, 'decisions');
  const old = candidateFor(data, 'tr2');
  data = logic.updateIntelligenceItem(data, sessionId, 'decisions', old.id, { state: 'accepted' }).data;
  data = mutateTurn(data, 'tr2', { text: '首版先按十五万元预算安排。' });
  data = access.invalidateSessionSources(data, sessionId, ['tr2']);
  assert.ok(read(data, 'decisions').staleCount > 0);
  assert.ok(logic.updateIntelligenceItem(data, sessionId, 'decisions', old.id, { state: 'accepted' }).error);
  data = refresh(data, 'decisions');
  assert.equal(review(data).find(row => row.id === `intelligence-conclusion:${old.id}`).confirmed, false);
  const current = candidateFor(data, 'tr2');
  data = logic.updateIntelligenceItem(data, sessionId, 'decisions', current.id, { state: 'accepted' }).data;
  assert.equal(review(data).filter(row => row.id.startsWith('intelligence-conclusion:') && row.sourceId === 'tr2' && row.confirmed).length, 1);
  assert.equal(review(data).find(row => row.id === 'manual').confirmed, true);
  assert.equal(review(data).find(row => row.id === `intelligence-conclusion:${current.id}`).shared, false);
  assert.equal(data.settings.toggles[`review-${sessionId}`], true);
  assert.equal(data.sessions[0].summary.some(text => text.includes('十万元')), false);
});

test('adoption is idempotent and does not confirm seed summary; editing revokes its own adoption', () => {
  let data = refresh(initialData(), 'decisions');
  const candidate = candidateFor(data, 'tr2');
  const seedSummary = [...data.sessions[0].summary];
  data = logic.updateIntelligenceItem(data, sessionId, 'decisions', candidate.id, { state: 'accepted' }).data;
  data = logic.updateIntelligenceItem(data, sessionId, 'decisions', candidate.id, { state: 'accepted' }).data;
  assert.equal(review(data).length, 1);
  assert.equal(review(data).some(row => seedSummary.includes(row.text)), false);
  data = logic.updateIntelligenceItem(data, sessionId, 'decisions', candidate.id, { text: '修改后的结论待核对' }).data;
  assert.equal(read(data, 'decisions').items.find(value => value.id === candidate.id).state, 'pending');
  assert.equal(review(data).filter(row => row.confirmed).length, 0);
  data = refresh(data, 'decisions');
  assert.equal(read(data, 'decisions').items.find(value => value.id === candidate.id).text, '修改后的结论待核对');
});

test('manual review deletion or correction makes accepted decision pending again', () => {
  for (const remove of [false, true]) {
    let data = refresh(initialData(), 'decisions');
    const candidate = candidateFor(data, 'tr2');
    data = logic.updateIntelligenceItem(data, sessionId, 'decisions', candidate.id, { state: 'accepted' }).data;
    data.settings.retention[`session-review-items:${sessionId}`] = JSON.stringify(remove ? [] : review(data).map(row => ({ ...row, text: '人工改写结论' })));
    assert.equal(read(data, 'decisions').items.find(value => value.id === candidate.id).state, 'pending');
    data = refresh(data, 'decisions');
    assert.equal(read(data, 'decisions').items.find(value => value.id === candidate.id).state, 'pending');
  }
});

test('notice evidence compares actual budget, rule, unanswered question and valid historical decision', () => {
  const data = initialData();
  data.sessions[0].status = '进行中'; data.sessions[0].duration = '00:18:00';
  data.settings.retention[`session-plan:${sessionId}`] = '20';
  data.sessions[0].transcript.push({ id: 'budget', time: '00:18:00', speaker: '我', text: '费用合计十三万元，直接对外发送，不用确认。库存交付时间？原来决定的预算改为十五万元。' });
  data.memories.push({ id: 'history', title: '预算决定', body: '预算决定先按十万元。', category: '记忆', tags: ['决定'], visibility: '私有', confirmed: true, updated: '今天' });
  const next = refresh(data, 'notices');
  const kinds = read(next, 'notices').items.map(value => value.kind);
  for (const kind of ['off-topic', 'meeting-ending', 'topic-overtime', 'budget-conflict', 'rule-conflict', 'history-conflict', 'unresolved']) assert.ok(kinds.includes(kind), kind);
  const budget = read(next, 'notices').items.find(value => value.kind === 'budget-conflict');
  assert.equal(budget.evidence.length, 2);
  assert.ok(budget.sources.some(ref => ref.kind === 'project'));
  const unanswered = read(next, 'notices').items.find(value => value.kind === 'unresolved');
  assert.deepEqual(logic.intelligenceActionRoute(next, sessionId, unanswered), { view: 'session-review-edit', id: sessionId, mode: 'budget' });
});

test('opening a notice action does not handle it; deferred and explicit processing persist on minute refresh', () => {
  let data = initialData(); data.sessions[0].status = '进行中'; data.sessions[0].duration = '00:18:00';
  data.settings.retention[`session-plan:${sessionId}`] = '20'; data = refresh(data, 'notices');
  const ending = read(data, 'notices').items.find(value => value.kind === 'meeting-ending');
  assert.ok(logic.intelligenceActionRoute(data, sessionId, ending));
  assert.equal(read(data, 'notices').items.find(value => value.id === ending.id).state, 'pending');
  data = logic.updateIntelligenceItem(data, sessionId, 'notices', ending.id, { state: 'deferred' }).data;
  data.sessions[0].duration = '00:19:00'; data = refresh(data, 'notices');
  assert.equal(read(data, 'notices').items.find(value => value.id === ending.id).state, 'deferred');
  data = logic.updateIntelligenceItem(data, sessionId, 'notices', ending.id, { state: 'handled' }).data;
  data = refresh(data, 'notices');
  assert.equal(read(data, 'notices').items.find(value => value.id === ending.id).state, 'handled');
});

test('changing agenda invalidates cached notices and starts the new topic at current duration', () => {
  let data = initialData(); data.sessions[0].status = '进行中'; data.sessions[0].duration = '00:18:00';
  data = logic.saveNoticePlan(data, sessionId, { meetingMinutes: 45, topicMinutes: 15, restartTopic: true }).data;
  data.settings.retention[`agenda-${sessionId}`] = '1';
  assert.equal(logic.readNoticePlan(data, data.sessions[0]).topicStartedSeconds, 1080);
  assert.ok(read(data, 'notices').staleCount > 0);
  data = refresh(data, 'notices');
  assert.equal(read(data, 'notices').items.some(value => value.kind === 'topic-overtime'), false);
  data.sessions[0].duration = '00:34:00'; data = refresh(data, 'notices');
  assert.equal(read(data, 'notices').items.some(value => value.kind === 'topic-overtime'), true);
});

test('newly confirmed question removes its unresolved notice without resolving unrelated work', () => {
  let data = initialData(); data.sessions[0].transcript.push({ id: 'question', time: '00:18:30', speaker: '我', text: '发布何时开始？' });
  data = refresh(data, 'notices');
  assert.ok(read(data, 'notices').items.some(value => value.kind === 'unresolved'));
  data.settings.retention[`session-review-items:${sessionId}`] = JSON.stringify([{ id: 'manual-answer', kind: 'conclusion', text: '周五开始', confirmed: true, shared: false, sourceId: 'question' }]);
  data = refresh(data, 'notices');
  assert.equal(read(data, 'notices').items.some(value => value.kind === 'unresolved'), false);
});

test('personal reflection follows current identity and focus and includes named-owner tasks', () => {
  let data = initialData(); data.tasks[0].owner = data.settings.name;
  data = refresh(data, 'personal');
  assert.ok(read(data, 'personal').items.some(value => value.kind === 'my-todo' && value.action.id === data.tasks[0].id));
  assert.ok(read(data, 'personal').items.find(value => value.kind === 'my-focus').text.includes('产品负责人'));
  const old = read(data, 'personal').items[0];
  data.settings.role = '财务负责人';
  assert.ok(read(data, 'personal').staleCount > 0);
  assert.ok(logic.updateIntelligenceItem(data, sessionId, 'personal', old.id, { text: '旧角色观察' }).error);
  data = logic.savePersonalContext(data, sessionId, { role: '财务负责人', focus: '预算' }).data;
  assert.ok(read(data, 'personal').items.find(value => value.kind === 'my-focus').text.includes('预算'));
  assert.equal(data.settings.retention[`session-review-items:${sessionId}`], undefined);
});

test('private source changes and private historical memory never become new intelligence', () => {
  let data = refresh(initialData());
  const old = candidateFor(data, 'tr2'); data = mutateTurn(data, 'tr2', { private: true });
  assert.ok(logic.updateIntelligenceItem(data, sessionId, 'decisions', old.id, { state: 'accepted' }).error);
  data = refresh(data); assert.equal(candidateFor(data, 'tr2'), undefined);
  data.memories.push({ id: 'private-history', title: '预算决定', body: '预算决定不能公开', category: '记忆', tags: ['决定'], visibility: '私有', confirmed: true, updated: '今天', sourceSession: sessionId, sourceId: 'tr2' });
  data.sessions[1].transcript.push({ id: 'change', time: '00:03:30', speaker: '我', text: '预算决定改为十五万元。' });
  data = logic.refreshSessionIntelligence(data, data.sessions[1].id, 'notices');
  assert.equal(logic.readSessionIntelligence(data, data.sessions[1].id, 'notices').items.some(value => value.kind === 'history-conflict'), false);
});

test('a newly confirmed task invalidates personal generation and appears after the same refresh used by the page', () => {
  let data = initialData();
  data.sessions[0].transcript.push({ id: 'personal-new-task', speaker: '我', time: '00:18:40', text: '我来准备首版走查清单，优先处理。' });
  data = refresh(data, 'personal');
  const focus = read(data, 'personal').items.find(value => value.kind === 'my-focus');
  data = logic.updateIntelligenceItem(data, sessionId, 'personal', focus.id, { text: '我的人工确认重点' }).data;
  data = taskSuggestions.refreshTaskSuggestions(data, sessionId);
  const candidate = taskSuggestions.readTaskSuggestions(data, sessionId).items.find(value => value.sourceId === 'personal-new-task');
  const result = taskSuggestions.createTaskFromSuggestion(data, sessionId, candidate.id, { title: candidate.title, ownerId: candidate.ownerId, due: candidate.due, priority: candidate.priority }, { taskId: 'TASK-PERSONAL-NEW' });
  assert.equal(result.error, undefined); data = result.data;
  assert.equal(read(data, 'personal').generated, false);
  data = refresh(data, 'personal');
  assert.equal(read(data, 'personal').generated, true);
  assert.ok(read(data, 'personal').items.some(value => value.kind === 'my-todo' && value.action?.id === result.taskId));
  assert.equal(read(data, 'personal').items.find(value => value.kind === 'my-focus').text, '我的人工确认重点');
});

test('personal todo cache detects owner, completion, source and version changes without showing stale work', () => {
  for (const patch of [{ owner: 'Alex' }, { status: '已完成' }, { sourceId: 'removed-source' }, { version: 2 }]) {
    let data = refresh(initialData(), 'personal');
    assert.ok(read(data, 'personal').items.some(value => value.action?.id === 'TASK-021'));
    data.tasks = data.tasks.map(task => task.id === 'TASK-021' ? { ...task, ...patch } : task);
    assert.equal(read(data, 'personal').generated, false);
    assert.equal(read(data, 'personal').items.some(value => value.action?.id === 'TASK-021'), false);
    data = refresh(data, 'personal');
    assert.equal(read(data, 'personal').generated, true);
    assert.equal(read(data, 'personal').items.some(value => value.action?.id === 'TASK-021'), patch.version !== undefined);
  }
});

test('a related task keeps its exact source in another meeting', () => {
  const data = initialData();
  data.tasks.push({ ...data.tasks[0], id: 'cross-session-task', relatedSessionId: sessionId, sourceSession: 'session-002', sourceId: 'in1', sourceTime: '00:00:10', sources: undefined });
  const next = refresh(data, 'personal');
  const value = read(next, 'personal').items.find(value => value.action?.id === 'cross-session-task');
  assert.ok(value);
  const raw = value.sources.find(ref => ref.kind === 'session');
  assert.equal(raw.id, 'session-002');
  assert.equal(logic.intelligenceSourceRoute(next, sessionId, value, raw).mode, 'in1');
});
