import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(target.pathname)) for (const extension of ['.ts', '.tsx', '.js', '.mjs']) {
      const candidate = new URL(target.href + extension); if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
} });
const feedback = await import('../src/taskFeedbackLogic.ts');
const workflow = await import('../src/taskWorkflow.ts');
const communication = await import('../src/communicationLogic.ts');
const source = readFileSync(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
const now = new Date(2026, 9, 14, 12, 30);
const task = (patch = {}) => ({ id: 'test', title: '核对试用反馈', description: '整理观察，不预写结论', owner: '我', requester: '王宁', due: '2026-10-14T17:00', status: '已承接', aiStatus: '未启动', priority: '中', activities: [], results: [], version: 1, ...patch });
const filters = patch => ({ ...feedback.initialTaskListFilters(undefined, now), ...patch });

test('today and the week follow local device boundaries, including both month and year transitions', () => {
  const day = feedback.taskTimeWindow('今天', '', now), week = feedback.taskTimeWindow('本周', '', now);
  assert.equal(day.start, new Date(2026, 9, 14).getTime()); assert.equal(day.end, new Date(2026, 9, 15).getTime());
  assert.equal(week.start, new Date(2026, 9, 12).getTime()); assert.equal(week.end, new Date(2026, 9, 19).getTime());
  const rollover = feedback.taskTimeWindow('本周', '', new Date(2027, 0, 1, 9));
  assert.equal(rollover.start, new Date(2026, 11, 28).getTime()); assert.equal(rollover.end, new Date(2027, 0, 4).getTime());
  assert.equal(feedback.taskLocalDate(now), '2026-10-14');
});

test('date, actual task state and Oops help remain independent filters', () => {
  const data = initialData(), current = task(), completed = task({ status: '已完成' });
  assert.equal(feedback.taskMatchesList(data, current, filters({ time: '今天' }), '', now), true);
  assert.equal(feedback.taskMatchesList(data, completed, filters({ time: '今天', status: '已完成' }), '', now), true);
  assert.equal(feedback.taskMatchesList(data, completed, filters({ time: '今天', status: '未结束' }), '', now), false);
  assert.equal(feedback.taskMatchesList(data, completed, filters({ time: '今天', status: '已完成', help: '可让Oops帮忙' }), '', now), false);
  assert.equal(feedback.taskMatchesList(data, current, filters({ time: '今天', status: '进行中', help: '可让Oops帮忙' }), '', now), true);
});

test('sample dates are never relabelled today, and exact date selection rejects impossible dates', () => {
  const data = initialData(), old = task({ due: '2026-10-08T18:00' });
  assert.equal(feedback.taskMatchesList(data, old, filters({ time: '今天' }), '', now), false);
  assert.equal(feedback.taskDateGroup(data, old, now), '此前到期');
  assert.equal(feedback.taskMatchesList(data, old, filters({ time: '具体日期', date: '2026-10-08' }), '', now), true);
  assert.equal(feedback.taskMatchesList(data, old, filters({ time: '具体日期', date: '2026-02-30' }), '', now), false);
  assert.equal(feedback.taskDateStart('2026-02-30'), undefined);
});

test('unknown deadlines stay in all-time results and a followed task uses the chosen follow-up date', () => {
  const data = initialData(), undated = task({ due: '' }), followed = task({ owner: 'Alex', requester: '我', due: '2026-10-08T18:00', nextFollowUp: '2026-10-14T15:00' });
  assert.equal(feedback.taskMatchesList(data, undated, filters({ time: '全部时间' }), '', now), true);
  assert.equal(feedback.taskMatchesList(data, undated, filters({ time: '今天' }), '', now), false);
  assert.equal(feedback.taskDateGroup(data, undated, now), '无固定期限');
  assert.equal(feedback.taskMatchesList(data, followed, filters({ time: '今天', relation: '我跟进' }), '', now), true);
  assert.equal(feedback.taskDateGroup(data, followed, now), '今天');
});

test('open question follow-ups appear today from Home attention and resolved questions stop affecting the date', () => {
  const data = initialData();
  for (const owner of ['我', 'Alex']) {
    const current = task({ owner, requester: '我', due: '2026-10-20T18:00', inquiries: [
      { id: 'past-solved', question: '已结束的旧问题', status: '已解决', nextFollowUp: '2026-10-08T09:00' },
      { id: 'later', question: '下次再核对', status: '待回答', nextFollowUp: '2026-10-16T09:00' },
      { id: 'today', question: '今天核对库存口径', status: '待回答', nextFollowUp: '2026-10-14T09:00' },
    ] });
    const attention = { ...feedback.initialTaskListFilters('待我处理', now), time: '今天' };
    assert.equal(workflow.taskIsMyAttention(data, current, now), true);
    assert.equal(feedback.taskMatchesList(data, current, attention, '', now), true);
    assert.equal(feedback.taskDateGroup(data, current, now), '今天');
    assert.equal(feedback.taskScheduleMoment(data, current, now), new Date(2026, 9, 14, 9).getTime());
    current.inquiries.find(value => value.id === 'today').status = '已解决';
    assert.equal(feedback.taskMatchesList(data, current, { ...attention, attention: false }, '', now), false);
    assert.equal(feedback.taskScheduleMoment(data, current, now), new Date(2026, 9, 16, 9).getTime());
    current.inquiries.forEach(value => { value.status = '已解决'; });
    assert.equal(feedback.taskScheduleMoment(data, current, now), new Date(2026, 9, 20, 18).getTime());
  }
});

test('a question without a separate date follows the task reminder date while invalid dates are ignored', () => {
  const data = initialData(), current = task({ due: '2026-10-20T18:00', nextFollowUp: '2026-10-14T10:00', inquiries: [
    { id: 'shared-date', question: '沿用工作跟进日期', status: '待回答' },
    { id: 'invalid', question: '非法日期不进入排序', status: '待回答', nextFollowUp: '2026-02-30T09:00' },
  ] });
  assert.equal(workflow.taskIsMyAttention(data, current, now), true);
  assert.equal(feedback.taskScheduleMoment(data, current, now), new Date(2026, 9, 14, 10).getTime());
  assert.equal(feedback.taskMatchesList(data, current, filters({ time: '今天' }), '', now), true);
});

test('legacy routes still preset attention, ownership and assistant work without mixing the time dimension', () => {
  const data = initialData(), pending = task({ status: '待承接' }), quiet = task();
  const attention = feedback.initialTaskListFilters('待我处理', now), own = feedback.initialTaskListFilters('我的待办', now), assistant = feedback.initialTaskListFilters('助手工作', now);
  assert.equal(attention.time, '全部时间'); assert.equal(attention.attention, true); assert.equal(attention.relation, '全部关系');
  assert.equal(feedback.taskMatchesList(data, pending, attention, '', now), true);
  assert.equal(feedback.taskMatchesList(data, quiet, attention, '', now), false);
  assert.equal(own.relation, '我负责'); assert.equal(own.attention, false);
  assert.equal(assistant.help, '助手工作');
  assert.equal(feedback.taskMatchesList(data, quiet, assistant, '', now), false);
  assert.equal(feedback.taskMatchesList(data, task({ aiStatus: '草稿完成' }), assistant, '', now), true);
});

test('help entry preserves source, acceptance, transfer and owner gates without changing authorization', () => {
  const data = initialData();
  for (const [current, route] of [[task({ sourceNeedsReview: true }), 'task-edit'], [task({ status: '待承接' }), 'task-accept'], [task({ status: '待转交' }), 'task-transfer-response'], [task({ aiStatus: '准备中' }), 'task-progress'], [task(), 'task-plan'], [task({ owner: 'Alex', requester: '我' }), 'task-ask']]) {
    const before = structuredClone(current), summary = feedback.taskHelpSummary(data, current);
    assert.equal(summary.route, route); assert.deepEqual(current, before);
    assert.equal(current.authorized, undefined);
  }
  assert.equal(feedback.taskHelpSummary(data, task({ owner: 'Alex' })).possible, false);
  assert.equal(feedback.taskHelpSummary(data, task({ status: '待转交' })).possible, false);
  assert.equal(feedback.taskHelpSummary(data, task({ status: '已完成' })).possible, false);
  const withQuestion = task({ inquiries: [{ id: 'q1', question: '指标口径是什么？', status: '待回答' }] });
  assert.deepEqual(feedback.taskHelpSummary(data, withQuestion).missing, ['指标口径是什么？']);
});

test('one or several selected artifact versions become exact communication bindings, never every latest artifact', () => {
  const data = initialData(), current = task({ artifacts: [
    { id: 'doc:1', title: '旧正文', kind: '文档', version: 1, body: ['OLD-TEXT'], created: '昨天' },
    { id: 'doc:2', title: '新正文', kind: '文档', version: 2, body: ['NEW-TEXT'], created: '今天' },
    { id: 'slides:2', title: '汇报提纲', kind: 'PPT', version: 2, body: ['SLIDE-TEXT'], created: '今天' },
  ] });
  const entry = feedback.taskArtifactEntry(current.artifacts, feedback.taskArtifactMode(['doc:1', 'slides:2']));
  assert.equal(entry.missing, false); assert.deepEqual(entry.ids, ['doc:1', 'slides:2']);
  const draft = communication.buildCommunicationDraft(current, '消息', data.settings.name, entry.ids, { data });
  assert.deepEqual(draft.artifactRefs.map(ref => ref.id), ['doc:1', 'slides:2']);
  assert.match(draft.body, /OLD-TEXT/); assert.match(draft.body, /SLIDE-TEXT/); assert.doesNotMatch(draft.body, /NEW-TEXT/);
  assert.equal(draft.target, '王宁');
  assert.deepEqual(feedback.taskArtifactEntry(current.artifacts, 'doc:1'), { ids: ['doc:1'], missing: false });
  assert.deepEqual(feedback.taskArtifactEntry(current.artifacts, feedback.taskArtifactMode([])), { ids: [], missing: false });
});

test('removed selected versions are flagged and cannot silently fall back to new versions', () => {
  const artifacts = [{ id: 'new', title: '新正文', kind: '文档', version: 2, body: ['NEW'], created: '今天' }];
  assert.deepEqual(feedback.taskArtifactEntry(artifacts, feedback.taskArtifactMode(['old'])), { ids: [], missing: true });
  assert.deepEqual(feedback.taskArtifactEntry(artifacts, 'artifacts:%ZZ'), { ids: [], missing: true });
  assert.deepEqual(feedback.taskArtifactEntry(artifacts, 'old'), { ids: [], missing: true });
  assert.deepEqual(feedback.taskArtifactEntry(artifacts, undefined), { missing: false });
});

test('preparing and communicating drafts do not complete the business task', () => {
  const data = initialData(), current = task({ authorized: true, scope: { sources: '本人要求', destination: '个人草稿', materialIds: [], includeSource: false } });
  data.tasks = [current];
  const started = workflow.beginGeneration(data, current.id, { token: 'test-feedback' });
  assert.equal(started.error, undefined); assert.equal(started.data.tasks[0].status, '已承接');
  const draft = communication.buildCommunicationDraft(current, '消息', data.settings.name, [], { data });
  const review = communication.buildCommunicationReview(data, current, draft, '消息');
  const sent = communication.submitCommunication(data, review.review, draft, 'test-receipt', '今天');
  assert.equal(sent.error, undefined); assert.equal(sent.data.tasks[0].status, '已承接');
  assert.equal(sent.data.tasks[0].completion, undefined);
});
