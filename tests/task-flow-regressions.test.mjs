import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const target = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(target.pathname)) {
      for (const extension of ['.ts', '.tsx', '.js', '.mjs']) {
        const candidate = new URL(target.href + extension);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
  }
  return nextResolve(specifier, context);
} });

const dates = await import('../src/dateLogic.ts');
const workflow = await import('../src/taskWorkflow.ts');
const access = await import('../src/sourceAccess.ts');
const logic = await import('../src/taskLogic.ts');
const uiSource = readFileSync(new URL('../src/features/Tasks.tsx', import.meta.url), 'utf8');

function taskData() {
  return {
    sessions: [], tasks: [{ id: 'plain', title: '核实库存', description: '核实可售数量', owner: '我', requester: '我', due: '无固定期限', priority: '中', status: '已承接', aiStatus: '未启动', workKind: '行动', activities: [], results: [], version: 1 }],
    memories: [], people: [], projects: [], receipts: [], settings: { name: '林', space: '我的空间', retention: {}, toggles: {}, connections: {}, devices: {}, tone: '', avatar: '', role: '' }, messages: [], notifications: [], recallCleared: false,
  };
}

// Run the source's actual handlers in memory; the phone JSX is outside these checks.
function uiHandlerHarness(initial) {
  let data = initial;
  const overrides = {}, values = {}, errors = [];
  const dependencies = {
    useOops: () => ({ data, route: { mode: 'a1' }, update: change => { data = change(data); }, navigate: () => {}, toast: () => {} }),
    useTaskActions: task => ({ patch: patch => { data = { ...data, tasks: data.tasks.map(item => item.id === task.id ? { ...item, ...patch } : item) }; }, go: () => {}, apply: helper => { const next = helper(data); if (next.error) { errors.push(next.error); return false; } data = next.data; return true; } }),
    useViewState: (key, initialValue) => { const value = Object.hasOwn(overrides, key) ? overrides[key] : typeof initialValue === 'function' ? initialValue() : initialValue; values[key] = value; return [value, () => {}]; },
    useState: initialValue => [initialValue, error => errors.push(error)], useEffect: () => {},
    closed: task => workflow.taskClosed(task), accepted: task => ['已承接', '进行中', '待验收'].includes(task.status),
    stamp: () => '今天', artifactId: () => 'new-artifact', artifacts: workflow.taskArtifacts, latestArtifacts: workflow.latestTaskArtifacts,
    taskBelongsToMe: workflow.taskBelongsToMe, taskWorkKind: workflow.taskWorkKind, taskSourceAvailable: access.taskSourceAvailable,
    provenanceAvailable: access.provenanceAvailable, sourceAvailable: access.sourceAvailable, sourceTurn: access.sourceTurn,
    makeSourceReference: access.makeSourceReference, archiveTaskCompletion: workflow.archiveTaskCompletion, taskArtifactExportAccess: workflow.taskArtifactExportAccess,
    visibleSession: () => false, materialsAvailable: () => true, validMoment: dates.parseLocalMoment, normalizeMoment: dates.normalizeMoment,
    deliveryKey: (space, task) => `task-delivery:${space}:${task.id}:${task.version}`,
    availableTaskMaterials: () => [],
  };
  return {
    get data() { return data; }, overrides, values, errors,
    load(name, method) {
      const start = uiSource.indexOf('function ' + name + '('), end = uiSource.indexOf('  return <div', start);
      const body = uiSource.slice(start, end).split('\n').filter(line => !line.trim().startsWith('if(!a)return <Empty')).join('\n') + `\nreturn {${method}};\n}`;
      const code = stripTypeScriptTypes(body, { mode: 'strip' });
      return new Function('dependencies', `const {${Object.keys(dependencies).join(',')}} = dependencies;${code};return ${name};`)(dependencies);
    },
  };
}

test('accepted date formats normalize to one local wall-clock time and reject invalid dates', () => {
  const now = new Date(2026, 9, 8, 12);
  for (const value of ['2026-10-8 9:00', '2026/10/08 09:00', '2026年10月8日 09:00', '10-08 09:00']) {
    assert.equal(dates.normalizeMoment(value, now), '2026-10-08T09:00');
    assert.equal(dates.parseLocalMoment(value, now), new Date(2026, 9, 8, 9).getTime());
  }
  for (const value of ['', '无固定期限', '2026-02-29 10:00', '2026-10-08 24:00', '2026-13-08 09:00']) assert.equal(dates.normalizeMoment(value, now), undefined);
});

test('only pending acceptance can be accepted, and progress keeps a handoff withdrawable', () => {
  const data = taskData(); data.tasks[0].status = '待承接';
  const accepted = workflow.acceptTask(data, 'plain', { due: '2026/10/08 09:00' });
  assert.equal(accepted.data.tasks[0].due, '2026-10-08T09:00');
  assert.match(workflow.acceptTask(accepted.data, 'plain', { due: '' }).error, /只有待承接/);
  const proposed = workflow.beginTransfer(accepted.data, 'plain', { to: 'Alex', reason: '由库存负责人接手', nextFollowUp: '2026年10月9日 10:00' });
  assert.equal(proposed.data.tasks[0].transferRequest.nextFollowUp, '2026-10-09T10:00');
  assert.match(workflow.acceptTask(proposed.data, 'plain', { due: '' }).error, /只有待承接/);
  const progress = workflow.saveTaskProgress(proposed.data, 'plain', { note: '已补齐库存记录', nextFollowUp: '2026/10/10 11:00' });
  assert.equal(progress.data.tasks[0].status, '待转交');
  assert.equal(progress.data.tasks[0].transferRequest.id, proposed.data.tasks[0].transferRequest.id);
  assert.equal(progress.data.tasks[0].transferRequest.nextFollowUp, '2026-10-10T11:00');
  const withdrawn = workflow.resolveTransfer(progress.data, 'plain', progress.data.tasks[0].transferRequest.id, '撤回');
  assert.equal(withdrawn.error, undefined);
  assert.equal(withdrawn.data.tasks[0].status, '已承接');
});

test('a followed task reminds on the inquiry deadline and clears that reason when resolved', () => {
  const data = taskData();
  const proposed = workflow.beginTransfer(data, 'plain', { to: 'Alex', reason: '库存核对' });
  const agreed = workflow.resolveTransfer(proposed.data, 'plain', proposed.data.tasks[0].transferRequest.id, '同意');
  const waiting = workflow.setInquiry(agreed.data, 'plain', { id: 'q1', question: '可售数量是否变化？', status: '待回答', nextFollowUp: '2026/10/08 09:00' });
  assert.equal(waiting.data.tasks[0].inquiries[0].nextFollowUp, '2026-10-08T09:00');
  assert.equal(workflow.taskIsMyAttention(waiting.data, waiting.data.tasks[0], new Date(2026, 9, 8, 8)), false);
  assert.equal(workflow.taskIsMyAttention(waiting.data, waiting.data.tasks[0], new Date(2026, 9, 8, 10)), true);
  const solved = workflow.setInquiry(waiting.data, 'plain', { ...waiting.data.tasks[0].inquiries[0], status: '已解决', answer: '没有变化' });
  assert.equal(workflow.taskIsMyAttention(solved.data, solved.data.tasks[0], new Date(2026, 9, 8, 10)), false);
});

test('task reminder parsing also handles legacy noncanonical dates', () => {
  const data = taskData(), now = new Date(2026, 9, 8, 10);
  for (const value of ['2026/10/08 09:00', '2026年10月8日 09:00', '10-08 09:00']) assert.equal(workflow.taskAttentionReason({ ...data.tasks[0], nextFollowUp: value }, now), '到时间跟进这项工作');
});

test('reopening changed requirements archives the completion and starts a fresh form', () => {
  const data = taskData();
  data.tasks[0] = { ...data.tasks[0], status: '已完成', completion: { id: 'c1', kind: '人工完成', summary: '已核实18件可售', completedAt: '昨天', remaining: '继续核对' } };
  const harness = uiHandlerHarness(data);
  harness.overrides['task-requirements:我的空间:plain:1:title'] = '重新核实库存';
  harness.load('Requirements', 'save')({ task: data.tasks[0] }).save();
  const reopened = harness.data.tasks[0];
  assert.equal(reopened.status, '已承接');
  assert.equal(reopened.completion, undefined);
  assert.equal(reopened.completionHistory[0].summary, '已核实18件可售');
  harness.load('Complete', 'finish')({ task: reopened });
  assert.equal(Object.entries(harness.values).find(([key]) => key.endsWith(':summary'))?.[1], '');
  assert.equal(Object.entries(harness.values).find(([key]) => key.endsWith(':remaining'))?.[1], '');
  assert.deepEqual(harness.errors, []);
});

test('changing only a completed task deadline preserves its completed round', () => {
  const data = taskData(); data.tasks[0] = { ...data.tasks[0], status: '已完成', completion: { id: 'c1', kind: '人工完成', summary: '核对完成', completedAt: '昨天' } };
  const harness = uiHandlerHarness(data); harness.overrides['task-requirements:我的空间:plain:1:due'] = '2026/10/09 10:00';
  harness.load('Requirements', 'save')({ task: data.tasks[0] }).save();
  assert.equal(harness.data.tasks[0].status, '已完成');
  assert.equal(harness.data.tasks[0].completion.id, 'c1');
  assert.equal(harness.data.tasks[0].due, '2026-10-09T10:00');
});

test('saving an artifact while preparing stops the run and its late callback cannot resurrect it', () => {
  const data = taskData();
  data.tasks[0] = { ...data.tasks[0], authorized: true, scope: { sources: '本人资料', destination: '个人成果', space: '我的空间', materialIds: [], includeSource: false }, artifacts: [{ id: 'a1', title: '库存结果', kind: '资料', version: 1, body: ['18件可售'], created: '昨天', needsReview: false, reviewedAt: '昨天' }] };
  const started = workflow.beginGeneration(data, 'plain', { token: 'run-1' });
  const harness = uiHandlerHarness(started.data);
  harness.load('Preview', 'save')({ task: started.data.tasks[0], edit: true }).save();
  const stopped = harness.data.tasks[0];
  assert.equal(stopped.aiStatus, '已停止');
  assert.equal(stopped.generationToken, undefined);
  assert.equal(stopped.generationSnapshot, undefined);
  assert.equal(stopped.generationSources, undefined);
  assert.equal(stopped.generationSpace, undefined);
  assert.equal(stopped.authorized, false);
  const late = logic.finishLocalGeneration(harness.data, 'plain', 'run-1');
  assert.equal(late.tasks[0].aiStatus, '已停止');
  assert.equal(late.tasks[0].artifacts.length, 2);
  assert.equal(late.tasks[0].used || 0, 0);
});

test('supplementing a completed task archives its result once', () => {
  const data = taskData(); data.tasks[0] = { ...data.tasks[0], status: '已完成', completion: { id: 'c1', kind: '人工完成', summary: '核对完成', completedAt: '昨天' } };
  const harness = uiHandlerHarness(data); harness.load('Supplement', 'changeMaterials')({ task: data.tasks[0] }).changeMaterials([{ id: 'm1', title: '新资料', body: '20件可售' }], '本人附入资料');
  assert.equal(harness.data.tasks[0].status, '已承接');
  assert.equal(harness.data.tasks[0].completion, undefined);
  assert.equal(harness.data.tasks[0].completionHistory.length, 1);
  assert.equal(workflow.archiveTaskCompletion(harness.data.tasks[0]).completionHistory.length, 1);
});

test('unavailable-source exports are personal history backups and remain blocked in a team', () => {
  const data = taskData(), artifact = { id: 'a1', title: '旧成果', kind: '资料', version: 1, body: ['旧正文'], created: '昨天', needsReview: false, reviewedAt: '昨天', sourceNeedsReview: true };
  assert.equal(workflow.taskArtifactExportAccess(data, data.tasks[0], artifact).mode, 'history');
  data.settings.space = 'Oops 产品团队'; data.settings.retention['task-space:plain'] = 'Oops 产品团队';
  assert.equal(workflow.taskArtifactExportAccess(data, data.tasks[0], artifact).mode, 'blocked');
  assert.equal(workflow.taskArtifactExportAccess(data, data.tasks[0], { ...artifact, sourceNeedsReview: false }).mode, 'normal');
  assert.equal(workflow.taskArtifactExportAccess(data, data.tasks[0], { ...artifact, sourceNeedsReview: false, needsReview: true }).mode, 'blocked');
  data.sessions = [{ id: 's1', transcript: [{ id: 't1', time: '00:01', speaker: '我', text: '私人原话', private: true }] }];
  data.settings.toggles['shared-s1'] = true; data.settings.retention['session-space:s1'] = 'Oops 产品团队';
  assert.equal(workflow.taskArtifactExportAccess(data, data.tasks[0], { ...artifact, sourceNeedsReview: false, sourceSession: 's1', sourceId: 't1' }).mode, 'blocked');
});
