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
const { contentScopes, selectContentScope } = await import('../src/contentScopeLogic.ts');
const { sessionVisible, sourceAvailable, taskVisible, makeSourceReference, provenanceAvailable } = await import('../src/sourceAccess.ts');
const { projectMemorySummary } = await import('../src/projectMemoryLogic.ts');
const PERSONAL = '我的空间', TEAM = 'Oops 产品团队';

test('existing named ranges, current range and every object binding remain reachable without creating memberships', () => {
  const data = initialData();
  data.settings.space = '旧范围';
  data.settings.retention.spaces = JSON.stringify([{ name: '已保存范围', role: '管理员', members: [{ name: '旧邀请', state: '待加入（示例）' }] }, null, 1, { name: '' }, { name: 4 }, { name: TEAM }]);
  for (const kind of ['session', 'memory', 'person', 'project', 'material', 'task']) data.settings.retention[kind + '-space:old-id'] = kind + '旧范围';
  data.settings.retention['unrelated-space:value'] = '不是内容范围';
  const before = structuredClone(data);
  const scopes = contentScopes(data);
  assert.deepEqual(scopes, [PERSONAL, TEAM, '已保存范围', '旧范围', 'session旧范围', 'memory旧范围', 'person旧范围', 'project旧范围', 'material旧范围', 'task旧范围']);
  assert.deepEqual(data, before);
  assert.equal(scopes.includes('旧邀请'), false);
  assert.equal(scopes.includes('管理员'), false);
});

test('broken legacy space settings do not strand currently selected or bound content', () => {
  for (const stored of ['{bad', '{}', 'null', '42', '"text"']) {
    const data = initialData();
    data.settings.retention.spaces = stored;
    data.settings.space = '历史范围';
    data.settings.retention['project-space:kept'] = '项目历史范围';
    assert.deepEqual(contentScopes(data), [PERSONAL, TEAM, '历史范围', '项目历史范围']);
  }
});

test('view changes preserve object IDs, recorded membership history, sharing, drafts and execution state', () => {
  const data = initialData();
  data.settings.retention.spaces = JSON.stringify([{ name: TEAM, role: '管理员', members: [{ name: '待加入的人', state: '待加入（示例）' }] }]);
  data.tasks[0].authorized = true;
  data.tasks[0].generationToken = 'existing-job';
  data.tasks[0].drafts = { 消息: { target: 'Alex', body: '私人草稿', attachments: '', snapshotSpace: PERSONAL } };
  const before = structuredClone(data);
  const shared = selectContentScope(data, TEAM);
  assert.equal(shared.settings.space, TEAM);
  for (const key of ['sessions', 'tasks', 'memories', 'people', 'projects', 'receipts', 'messages', 'notifications']) assert.equal(shared[key], data[key]);
  for (const key of ['retention', 'toggles', 'connections', 'devices']) assert.equal(shared.settings[key], data.settings[key]);
  assert.deepEqual(selectContentScope(shared, PERSONAL), data);
  assert.deepEqual(data, before);
  assert.equal(shared.tasks[0].generationToken, 'existing-job');
  assert.equal(shared.tasks[0].drafts.消息.snapshotSpace, PERSONAL);
});

test('unknown range and repeated selection do not implicitly create or join a team', () => {
  const data = initialData();
  assert.equal(selectContentScope(data, '新建的团队'), data);
  assert.equal(selectContentScope(data, ''), data);
  assert.equal(selectContentScope(data, PERSONAL), data);
});

function projectData() {
  const data = initialData(), base = data.sessions[0];
  data.projects = [{ id: 'stable-project', name: '项目上下文', description: '背景保留', members: ['我'], budget: 100, rule: '逐项确认' }];
  data.sessions = [{ ...base, id: 'shared-session', project: '项目上下文', status: '已结束', transcript: [{ id: 'exact-turn', speaker: '我', time: '00:01', text: '整理这份项目资料。' }] }, { ...base, id: 'private-session', project: '项目上下文', status: '已结束' }];
  data.memories = [];
  data.settings.toggles['shared-shared-session'] = true;
  data.settings.retention['session-space:shared-session'] = TEAM;
  data.settings.retention['project-space:stable-project'] = TEAM;
  data.tasks = [{ ...data.tasks[0], id: 'same-task', sourceSession: 'shared-session', sourceId: 'exact-turn', sourceTime: '00:01', sources: [], scope: undefined, materialRefs: [], needsReview: false, sourceNeedsReview: false }];
  return data;
}

test('project context remains reachable through the same session, project and task objects after convergence', () => {
  const data = projectData(), personal = projectMemorySummary(data, 'stable-project');
  assert.deepEqual(personal.sessions.map(item => item.id), ['shared-session', 'private-session']);
  const shared = selectContentScope(data, TEAM), context = projectMemorySummary(shared, 'stable-project');
  assert.deepEqual(context.sessions.map(item => item.id), ['shared-session']);
  assert.deepEqual(context.tasks.map(item => item.id), ['same-task']);
  assert.equal(context.tasks[0], personal.tasks[0]);
  assert.equal(context.sessions[0], personal.sessions[0]);
  assert.equal(sessionVisible(shared, 'private-session'), false);
  assert.equal(taskVisible(shared, data.tasks[0]), true);
});

test('choosing a retained range never bypasses private sources, explicit revocation or stale evidence', () => {
  let data = projectData();
  data.tasks[0].sources = [makeSourceReference(data, { kind: 'session', id: 'shared-session', sourceId: 'exact-turn' })];
  data = selectContentScope(data, TEAM);
  assert.equal(taskVisible(data, data.tasks[0]), true);
  data.sessions[0].transcript[0].private = true;
  assert.equal(sourceAvailable(data, data.tasks[0], { publicOnly: true, requireShared: true }), false);
  assert.equal(taskVisible(data, data.tasks[0]), false);
  data.sessions[0].transcript[0].private = false;
  data.settings.toggles['shared-shared-session'] = false;
  assert.equal(projectMemorySummary(data, 'stable-project').tasks.length, 0);
  data.settings.toggles['shared-shared-session'] = true;
  data.sessions[0].transcript[0].text = '已改动的原话';
  assert.equal(provenanceAvailable(data, data.tasks[0].sources), false);
  assert.equal(projectMemorySummary(data, 'stable-project').tasks.length, 0);
});
