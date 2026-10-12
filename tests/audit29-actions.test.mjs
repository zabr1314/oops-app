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
const communication = await import('../src/communicationLogic.ts');
const uiSource = readFileSync(new URL('../src/features/Tasks.tsx', import.meta.url), 'utf8');

function taskData() {
  return {
    sessions: [], tasks: [{ id: 'plain', title: '核实库存', description: '核实可售数量', owner: '我', requester: '我', due: '无固定期限', priority: '中', status: '已承接', aiStatus: '未启动', workKind: '行动', activities: [], results: [], version: 1 }],
    memories: [], people: [{ id: 'alex', name: 'Alex', role: '已核对身份', company: '', note: '', voice: false, shared: false }], projects: [], receipts: [], settings: { name: '林', space: '我的空间', retention: {}, toggles: {}, connections: {}, devices: {}, tone: '', avatar: '', role: '' }, messages: [], notifications: [], recallCleared: false,
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
    visibleSession: (data, id) => access.sessionVisible(data, id), materialsAvailable: () => true, validMoment: dates.parseLocalMoment, normalizeMoment: dates.normalizeMoment,
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


test('changing an open deadline withdraws permission and a delayed generation cannot return', () => {
  const data = taskData();
  Object.assign(data.tasks[0], { due: '2026-10-10T10:00', authorized: true, scope: { sources: '本人资料', destination: '个人成果', space: '我的空间', materialIds: [], includeSource: false } });
  const started = workflow.beginGeneration(data, 'plain', { token: 'before-deadline-edit' });
  assert.equal(started.error, undefined);
  const harness = uiHandlerHarness(started.data);
  harness.overrides[`task-requirements:我的空间:plain:${started.data.tasks[0].version}:due`] = '2026-10-11 10:00';
  harness.load('Requirements', 'save')({ task: started.data.tasks[0] }).save();
  const updated = harness.data.tasks[0];
  assert.deepEqual(harness.errors, []);
  assert.equal(updated.due, '2026-10-11T10:00');
  assert.equal(updated.authorized, false);
  assert.equal(updated.generationToken, undefined);
  assert.equal(updated.generationSnapshot, undefined);
  assert.equal(updated.status, '已承接');
  assert.match(workflow.beginGeneration(harness.data, 'plain').error, /范围/);
  const late = logic.finishLocalGeneration(harness.data, 'plain', 'before-deadline-edit');
  assert.equal(late.tasks[0].artifacts?.length || 0, 0);
  assert.equal(late.tasks[0].used || 0, 0);
});

test('changing only a closed deadline preserves its historical completion', () => {
  const data = taskData();
  Object.assign(data.tasks[0], { status: '已完成', completion: { id: 'finished', kind: '人工完成', summary: '已完成核实', completedAt: '昨天' } });
  const harness = uiHandlerHarness(data); harness.overrides['task-requirements:我的空间:plain:1:due'] = '2026-10-11 10:00';
  harness.load('Requirements', 'save')({ task: data.tasks[0] }).save();
  assert.equal(harness.data.tasks[0].status, '已完成');
  assert.equal(harness.data.tasks[0].completion.id, 'finished');
  assert.equal(harness.data.tasks[0].completionHistory?.length || 0, 0);
});

function sourceTaskData() {
  const data = taskData();
  data.people.push({ id: 'wang', name: '王宁', role: '已核对身份', company: '', note: '', voice: false, shared: false });
  data.sessions = [{ id: 's1', title: '试用会议', transcript: [{ id: 't1', speaker: '王宁', personId: 'wang', time: '00:01', text: '请准备核实结果。' }] }];
  Object.assign(data.tasks[0], { requester: '王宁', sourceSession: 's1', sourceId: 't1', sourceTime: '00:01', sources: [access.makeSourceReference(data, { kind: 'session', id: 's1', sourceId: 't1' })] });
  return data;
}

test('source identity recheck requires an explicit requester and new communications use that person', () => {
  const data = sourceTaskData(), oldDraft = communication.buildCommunicationDraft(data.tasks[0], '消息', data.settings.name, [], { data });
  const reviewed = communication.buildCommunicationReview(data, data.tasks[0], oldDraft, '消息');
  const submitted = communication.submitCommunication(data, reviewed.review, oldDraft, 'old-receipt', '昨天');
  assert.equal(submitted.error, undefined);
  const receiptBefore = structuredClone(submitted.receipt);
  const changed = access.invalidateSessionSources(submitted.data, 's1', ['t1'], '说话人纠正');
  Object.assign(changed.sessions[0].transcript[0], { speaker: 'Alex', personId: 'alex' });
  assert.equal(communication.canSubmitCommunication(changed, changed.tasks[0], oldDraft).ok, false);
  const missing = uiHandlerHarness(changed), key = `task-requirements:我的空间:plain:${changed.tasks[0].version}`;
  missing.overrides[key + ':checked'] = true;
  missing.load('Requirements', 'save')({ task: changed.tasks[0] }).save();
  assert.match(missing.errors[0], /提出人/);
  assert.equal(missing.data.tasks[0].sourceNeedsReview, true);
  const confirmed = uiHandlerHarness(changed);
  confirmed.overrides[key + ':checked'] = true; confirmed.overrides[key + ':requester'] = 'alex';
  confirmed.load('Requirements', 'save')({ task: changed.tasks[0] }).save();
  assert.deepEqual(confirmed.errors, []);
  const current = confirmed.data.tasks[0];
  assert.equal(current.owner, '我', 'source recheck does not silently reassign responsibility');
  assert.equal(current.requester, 'Alex'); assert.equal(current.requesterPersonId, 'alex');
  assert.equal(current.sourceNeedsReview, false);
  const newDraft = communication.buildCommunicationDraft(current, '消息', confirmed.data.settings.name, [], { data: confirmed.data });
  assert.equal(newDraft.target, 'Alex');
  assert.equal(communication.canSubmitCommunication(confirmed.data, current, newDraft).ok, true);
  assert.deepEqual(confirmed.data.receipts[0], receiptBefore, 'past receipts remain immutable historical snapshots');
});

test('source recheck can explicitly preserve an unidentified requester without inventing a recipient', () => {
  let data = sourceTaskData(); data = access.invalidateSessionSources(data, 's1', ['t1']);
  data.sessions[0].transcript[0].speaker = '未知';
  const harness = uiHandlerHarness(data), key = `task-requirements:我的空间:plain:${data.tasks[0].version}`;
  harness.overrides[key + ':checked'] = true; harness.overrides[key + ':requester'] = 'unknown';
  harness.load('Requirements', 'save')({ task: data.tasks[0] }).save();
  assert.deepEqual(harness.errors, []);
  assert.equal(harness.data.tasks[0].requester, '待确认');
  assert.equal(harness.data.tasks[0].requesterPersonId, undefined);
  assert.equal(communication.buildCommunicationDraft(harness.data.tasks[0], '消息', data.settings.name, [], { data: harness.data }).target, '');
});

test('invalid sources block a new or agreed handoff while withdrawal and refusal remain possible', () => {
  const data = taskData(); data.tasks[0].sourceNeedsReview = true;
  assert.match(workflow.beginTransfer(data, 'plain', { to: 'Alex', toPersonId: 'alex', reason: '交接' }).error, /来源/);
  data.tasks[0].sourceNeedsReview = false;
  const proposed = workflow.beginTransfer(data, 'plain', { to: 'Alex', toPersonId: 'alex', reason: '交接' });
  const request = proposed.data.tasks[0].transferRequest;
  proposed.data.tasks[0].sourceNeedsReview = true;
  assert.match(workflow.resolveTransfer(proposed.data, 'plain', request.id, '同意').error, /来源/);
  for (const response of ['撤回', '婉拒']) {
    const recovered = workflow.resolveTransfer(proposed.data, 'plain', request.id, response);
    assert.equal(recovered.error, undefined); assert.equal(recovered.data.tasks[0].owner, '我');
    assert.equal(recovered.data.tasks[0].status, '已承接');
    assert.equal(recovered.data.tasks[0].sourceNeedsReview, true);
  }
});

test('handoffs bind exact confirmed person IDs and cannot silently select another same-name person', () => {
  const data = taskData();
  data.people.push({ id: 'alex-2', name: 'Alex', role: '已核对身份', company: '另一个组织', note: '', voice: false, shared: false });
  assert.match(workflow.beginTransfer(data, 'plain', { to: 'Alex', reason: '交接' }).error, /同名/);
  const proposed = workflow.beginTransfer(data, 'plain', { to: 'Alex', toPersonId: 'alex-2', reason: '交给第二位' });
  assert.equal(proposed.error, undefined); assert.equal(proposed.data.tasks[0].transferRequest.toPersonId, 'alex-2');
  const request = proposed.data.tasks[0].transferRequest;
  const removed = structuredClone(proposed.data); removed.people = removed.people.filter(person => person.id !== 'alex-2');
  assert.match(workflow.resolveTransfer(removed, 'plain', request.id, '同意').error, /身份/);
  const accepted = workflow.resolveTransfer(proposed.data, 'plain', request.id, '同意');
  assert.equal(accepted.error, undefined); assert.equal(accepted.data.tasks[0].ownerPersonId, 'alex-2');
  assert.equal(accepted.data.settings.retention['task-owner-person:plain'], 'alex-2');
});

test('unconfirmed people are excluded and a same-name external person never becomes the current user', () => {
  const data = taskData();
  data.people.push({ id: 'unchecked', name: '小陈', role: '', company: '', note: '', voice: false, shared: false }, { id: 'same-as-me', name: '林', role: '已核对身份', company: '别的团队', note: '', voice: false, shared: false });
  assert.equal(workflow.taskTransferPeople(data).some(person => person.id === 'unchecked'), false);
  assert.match(workflow.beginTransfer(data, 'plain', { to: '小陈', toPersonId: 'unchecked', reason: '交接' }).error, /核对/);
  const proposed = workflow.beginTransfer(data, 'plain', { to: '林', toPersonId: 'same-as-me', reason: '交给同名联系人' });
  assert.equal(proposed.error, undefined);
  const accepted = workflow.resolveTransfer(proposed.data, 'plain', proposed.data.tasks[0].transferRequest.id, '同意');
  assert.equal(accepted.error, undefined);
  assert.equal(workflow.taskBelongsToMe(accepted.data, accepted.data.tasks[0]), false);
  assert.equal(workflow.taskBelongsToMe(data, { ...data.tasks[0], owner: '林', ownerPersonId: 'same-as-me' }), false);
  assert.equal(workflow.taskFollowedByMe(data, { ...data.tasks[0], owner: 'Alex', requester: '林', requesterPersonId: 'same-as-me' }), false);
});
