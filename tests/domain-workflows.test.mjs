import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function loadModel(path) {
  const text = await readFile(new URL(path, import.meta.url), 'utf8');
  // Load the actual seed without importing its React context or JSX extension.
  let source = path.endsWith('store.tsx') ? text.slice(text.indexOf('export function initialData')) : text;
  if (path.endsWith('MemorySettings.tsx')) {
    // Run the actual workflow functions without loading phone UI components.
    const dependencies = `import { sharedMemoryEligible } from '${new URL('../src/memoryAccess.ts', import.meta.url).href}';\nimport { sourceAvailable, sourceTurn, taskVisible, findSourceTask, invalidateSessionSources, makeSourceReference, provenanceAvailable } from '${new URL('../src/sourceAccess.ts', import.meta.url).href}';\n`;
    source = dependencies + text.slice(text.indexOf('const PERSONAL'), text.indexOf('function Download'));
  }
  if (path.endsWith('Sessions.tsx')) {
    const dependencies = `import { sharedMemoryEligible } from '${new URL('../src/memoryAccess.ts', import.meta.url).href}';\nimport { findSourceTask, invalidateSessionSources, makeSourceReference, provenanceAvailable, sourceAvailable, taskSourceAvailable, taskVisible } from '${new URL('../src/sourceAccess.ts', import.meta.url).href}';\n`;
    source = dependencies + text.slice(text.indexOf('const uid'), text.indexOf('const DEMO')) + '\n' + text.slice(text.indexOf('export function parseImportedTranscript'), text.indexOf('function ImportSession')) + '\n' + text.slice(text.indexOf('export function buildSessionExport'), text.indexOf('function Sharing'));
  }
  if (path.endsWith('Home.tsx')) {
    const dependencies = `import { sharedMemoryEligible } from '${new URL('../src/memoryAccess.ts', import.meta.url).href}';\nimport { makeSourceReference, materialVisible, provenanceAvailable, sourceAvailable, taskSourceAvailable, taskVisible as scopedTaskVisible, sessionVisible as scopedSessionVisible } from '${new URL('../src/sourceAccess.ts', import.meta.url).href}';\n`;
    source = dependencies + text.slice(text.indexOf('export function homeTitle'), text.indexOf('export function Home()')) + '\n' + text.slice(text.indexOf('type LocalAnswer'), text.indexOf('function referenceRoute'));
  }
  const code = stripTypeScriptTypes(source, { mode: 'strip' }).replace(/from (['"])(\.[^'"]+)\1/g, (_match, _quote, relative) => {
    const url = new URL(relative + (/\.[a-z]+$/i.test(relative) ? '' : '.ts'), new URL(path, import.meta.url));
    return `from '${url.href}'`;
  });
  return import('data:text/javascript;base64,' + Buffer.from(code + '\n//# sourceURL=oops-test:' + path.split('/').at(-1)).toString('base64'));
}
const { initialData } = await loadModel('../src/store.tsx');
const model = await loadModel('../src/sourceAccess.ts');
const recording = await loadModel('../src/recordingLogic.ts');
const taskLogic = await loadModel('../src/taskLogic.ts');
const memoryLogic = await loadModel('../src/features/MemorySettings.tsx');
const migration = await loadModel('../src/stateMigrations.ts');
const sessionLogic = await loadModel('../src/features/Sessions.tsx');
const homeLogic = await loadModel('../src/features/Home.tsx');
const team = 'Oops 产品团队';
function sharedData() {
  const data = initialData();
  data.settings.space = team;
  data.settings.toggles['shared-session-001'] = true;
  data.settings.retention['session-space:session-001'] = team;
  return data;
}

test('current identity has explicit visibility and private preferences remain personal', () => {
  const data = initialData();
  data.settings.toggles.publicIdentity = false;
  const identity = model.makeSourceReference(data, { kind: 'profile', id: 'my-profile', profileScope: 'identity' });
  const preferences = model.makeSourceReference(data, { kind: 'profile', id: 'my-profile', profileScope: 'preferences' });
  assert.equal(model.provenanceAvailable(data, [identity, preferences]), true);
  data.settings.space = team;
  assert.equal(model.provenanceAvailable(data, [identity]), false);
  data.settings.toggles.publicIdentity = true;
  assert.equal(model.provenanceAvailable(data, [identity]), true);
  assert.equal(model.provenanceAvailable(data, [preferences]), false);
  data.settings.role = 'Updated role';
  assert.equal(model.provenanceAvailable(data, [identity]), false);
});

test('role answers show the current profile separately from verified historical background', () => {
  const data = initialData();
  data.settings.role = 'Current product designer';
  data.settings.retention.roleContext = 'Current independent project';
  data.memories = [{ id: 'role-history', title: 'Earlier role', body: 'Historical operations role', category: '个人背景', tags: ['角色'], visibility: '私有', updated: 'today', confirmed: true }];
  const answer = homeLogic.buildLocalAnswer('我是谁，当前角色是什么', data, true);
  assert.match(answer.text, /当前档案：.*Current product designer/);
  assert.match(answer.text, /适用场景：Current independent project/);
  assert.match(answer.text, /已核对的历史背景（单独保留）：\nHistorical operations role/);
  assert.equal(answer.sources.some(ref => ref.kind === 'profile' && ref.profileScope === 'identity'), true);
  assert.equal(answer.sources.some(ref => ref.kind === 'memory' && ref.id === 'role-history'), true);
  assert.equal(model.provenanceAvailable(data, answer.sources), true);
  data.settings.role = 'Next role';
  assert.equal(model.provenanceAvailable(data, answer.sources), false);
});

test('personal answer preferences affect local suggestions and never enter team answers', () => {
  const data = initialData();
  data.settings.tone = '逐步说明操作';
  data.settings.retention.answerLength = '详细';
  data.settings.retention.focus = 'PRIVATE-PREFERENCE-ONLY';
  const personal = homeLogic.buildLocalAnswer('下一步任务', data, true);
  assert.match(personal.text, /^1\. 查看已有内容/);
  assert.match(personal.text, /PRIVATE-PREFERENCE-ONLY/);
  assert.equal(personal.sources.some(ref => ref.kind === 'profile' && ref.profileScope === 'preferences'), true);
  data.settings.space = team;
  data.settings.toggles.publicIdentity = true;
  const shared = homeLogic.buildLocalAnswer('下一步任务', data, true);
  assert.doesNotMatch(shared.text, /PRIVATE-PREFERENCE-ONLY|^1\. 查看已有内容/);
  assert.equal(shared.sources.some(ref => ref.kind === 'profile' && ref.profileScope === 'preferences'), false);
  const preferences = homeLogic.buildLocalAnswer('我的偏好是什么', data, true);
  assert.doesNotMatch(preferences.text, /PRIVATE-PREFERENCE-ONLY/);
  assert.equal(preferences.sources.length, 0);
});

test('explicit task-space does not expose a private or missing original passage', () => {
  const data = sharedData(), task = data.tasks[0];
  task.sourceId = 'tr4'; data.settings.retention['task-space:' + task.id] = team;
  assert.equal(model.taskVisible(data, task), true);
  data.sessions[0].transcript.find(t => t.id === 'tr4').private = true;
  assert.equal(model.taskVisible(data, task), false);
  data.sessions[0].transcript = data.sessions[0].transcript.filter(t => t.id !== 'tr4');
  data.sessions[0].transcript.push({ id: 'replacement', time: task.sourceTime, speaker: '我', text: 'A different passage at the same time' });
  assert.equal(model.sourceAvailable(data, task), false);
  assert.equal(model.taskVisible(data, task), false);
});

test('a manual action belongs to its conversation without claiming original words', () => {
  const data = sharedData();
  const manual = { ...data.tasks[0], id: 'manual', sourceSession: undefined, sourceTime: undefined, relatedSessionId: 'session-001' };
  assert.equal(model.taskVisible(data, manual), false);
  data.settings.retention['task-space:manual'] = team;
  assert.equal(model.taskVisible(data, manual), true);
  assert.equal(model.sourceTurn(data, manual), undefined);
  data.settings.toggles['shared-session-001'] = false;
  assert.equal(model.taskVisible(data, manual), false);
  data.settings.space = '我的空间';
  assert.equal(model.taskSourceAvailable(data, manual), true);
});

test('the same passage returns the existing active action, while a cancelled action allows a new draft', () => {
  const data = initialData();
  const pointer = { sourceSession: 'session-001', sourceId: 'tr4' };
  assert.equal(model.findSourceTask(data, pointer)?.id, 'TASK-021');
  data.tasks[0].status = '已取消';
  assert.equal(model.findSourceTask(data, pointer), undefined);
  assert.equal(model.findSourceTask(data, { ...pointer, sourceId: 'missing', sourceTime: '00:18:02' }), undefined);
});

test('editing one passage invalidates its task, artifacts, memory and derived answer; unrelated actions survive', () => {
  const data = sharedData(), task = data.tasks[0];
  task.sourceId = 'tr4'; task.authorized = true; task.aiStatus = '准备中'; task.generationToken = 'old-generation';
  task.artifacts = [{ id: 'old-draft', kind: '文档', title: 'Old result', body: ['Preserved for review'], version: 1, created: 'today', reviewedAt: 'yesterday' }];
  data.memories.push({ ...data.memories[0], id: 'derived-memory', sourceId: 'tr4', sourceTime: '00:18:02', visibility: '项目共享' });
  data.messages.push({ id: 'derived-answer', role: 'assistant', text: 'Old task answer', space: team, sources: [model.makeSourceReference(data, { kind: 'task', id: task.id, version: 1 })] });
  const unchanged = data.tasks[1];
  const next = model.invalidateSessionSources(data, 'session-001', ['tr4'], 'Original wording edited');
  const updated = next.tasks.find(t => t.id === task.id);
  assert.equal(updated.authorized, false);
  assert.equal(updated.generationToken, undefined);
  assert.equal(updated.aiStatus, '待授权');
  assert.equal(updated.sourceNeedsReview, true);
  assert.equal(updated.artifacts[0].needsReview, true);
  assert.equal(updated.artifacts[0].reviewedAt, undefined);
  assert.deepEqual(updated.artifacts[0].body, ['Preserved for review']);
  assert.equal(next.settings.retention['task-space:' + task.id], '我的空间');
  assert.equal(next.memories.find(m => m.id === 'derived-memory').confirmed, false);
  assert.equal(next.memories.find(m => m.id === 'derived-memory').visibility, '私有');
  assert.equal(next.messages.find(m => m.id === 'derived-answer').invalidated, true);
  assert.equal(next.tasks[1], unchanged);
  assert.equal(model.taskSourceAvailable(next, updated), false);
  assert.equal(task.authorized, true, 'the previous state is immutable');
});

test('invalidation follows memory-to-task and task-to-memory derivation chains', () => {
  const data = initialData();
  data.memories[0].sourceId = 'tr1';
  data.tasks.push({ ...data.tasks[0], id: 'from-memory', sourceSession: undefined, sourceTime: undefined, sourceMemoryId: 'MEM-001', sources: [{ kind: 'memory', id: 'MEM-001' }] });
  data.memories.push({ ...data.memories[0], id: 'from-task', sourceSession: undefined, sourceId: undefined, sourceTime: undefined, sources: [{ kind: 'task', id: 'from-memory' }] });
  const next = model.invalidateSessionSources(data, 'session-001', ['tr1']);
  assert.equal(next.tasks.find(t => t.id === 'from-memory').sourceNeedsReview, true);
  assert.equal(next.memories.find(m => m.id === 'from-task').confirmed, false);
});

test('discarding an unrelated passage does not invalidate an exact retained ID citation', () => {
  const data = initialData(); data.tasks[0].sourceId = 'tr4';
  const next = model.invalidateSessionSources(data, 'session-001', ['tr3']);
  assert.equal(next.tasks[0], data.tasks[0]);
  assert.equal(next.tasks[2].sourceNeedsReview, true);
  assert.equal(model.invalidateSessionSources(data, 'session-001', []), data);
});

test('revoking sharing withdraws old answer content and derivation eligibility', () => {
  const data = sharedData();
  const message = { id: 'm', role: 'assistant', text: 'Source-based text', sources: [model.makeSourceReference(data, { kind: 'session', id: 'session-001', sourceId: 'tr4' })] };
  assert.equal(model.messageAvailable(data, message), true);
  data.settings.toggles['shared-session-001'] = false;
  assert.equal(model.messageAvailable(data, message), false);
  assert.equal(model.provenanceAvailable(data, message.sources), false);
});

test('an edited passage fingerprint cannot certify an earlier answer', () => {
  const data = initialData();
  const sources = [model.makeSourceReference(data, { kind: 'session', id: 'session-001', sourceId: 'tr4' })];
  assert.equal(model.provenanceAvailable(data, sources), true);
  data.sessions[0].transcript.find(t => t.id === 'tr4').text = 'Different agreed deliverable';
  assert.equal(model.provenanceAvailable(data, sources), false);
});

test('legacy timestamps with multiple passages require exact IDs', () => {
  const data = initialData();
  const pointer = { sourceSession: 'session-001', sourceTime: '00:18:02' };
  data.sessions[0].transcript.push({ id: 'same-time', time: pointer.sourceTime, speaker: '我', text: 'Another passage' });
  assert.equal(model.sourceTurn(data, pointer), undefined);
  assert.equal(model.sourceAvailable(data, pointer), false);
  assert.equal(model.sourceAvailable(data, { ...pointer, sourceId: 'tr4' }), true);
});

test('generation completion rechecks current authorization, state, source and token', () => {
  const data = initialData(), task = data.tasks[0];
  Object.assign(task, { sourceId: 'tr4', authorized: true, status: '已承接', aiStatus: '准备中', generationToken: 'run-1', scope: { sources: '当前原话与所选资料', destination: '本机草稿' } });
  assert.equal(model.generationCanComplete(data, task, 'run-1'), true);
  assert.equal(model.generationCanComplete(data, task, 'old-run'), false);
  assert.equal(model.generationCanComplete(data, { ...task, authorized: false }, 'run-1'), false);
  assert.equal(model.generationCanComplete(data, { ...task, aiStatus: '已停止' }, 'run-1'), false);
  assert.equal(model.generationCanComplete(data, { ...task, status: '已取消' }, 'run-1'), false);
  assert.equal(model.generationCanComplete(data, { ...task, scope: { sources: '', destination: '本机' } }, 'run-1'), false);
  const invalidated = model.invalidateSessionSources(data, 'session-001', ['tr4']);
  assert.equal(model.generationCanComplete(invalidated, invalidated.tasks[0], 'run-1'), false);
});

test('generation cannot finish from revoked or detached supplemental materials', () => {
  const data = sharedData(), task = data.tasks[0], title = data.sessions[0].attachments[0];
  Object.assign(task, { sourceId: 'tr4', authorized: true, status: '已承接', aiStatus: '准备中', generationToken: 'run', scope: { sources: '所选资料', destination: '本机' }, materialRefs: [{ id: 'material', sourceSession: 'session-001', title }] });
  data.settings.toggles['material-shared:session-001:' + title] = true;
  assert.equal(model.generationCanComplete(data, task, 'run'), true);
  data.settings.toggles['material-shared:session-001:' + title] = false;
  assert.equal(model.generationCanComplete(data, task, 'run'), false);
  data.settings.space = '我的空间';
  assert.equal(model.generationCanComplete(data, task, 'run'), true);
  data.sessions[0].attachments = [];
  assert.equal(model.generationCanComplete(data, task, 'run'), false);
});

test('the actual completion callback stops when its team authorization source is revoked, even after switching space', () => {
  const data = sharedData(), task = data.tasks[0], title = data.sessions[0].attachments[0];
  Object.assign(task, { sourceId: 'tr4', authorized: true, status: '已承接', aiStatus: '准备中', generationToken: 'run', generationSpace: team, scope: { sources: '所选资料', destination: '本机' }, materialRefs: [{ id: 'material', sourceSession: 'session-001', title }] });
  data.settings.toggles['material-shared:session-001:' + title] = true;
  data.settings.toggles['material-shared:session-001:' + title] = false;
  data.settings.space = '我的空间';
  const next = taskLogic.finishLocalGeneration(data, task.id, 'run', 1);
  const stopped = next.tasks[0];
  assert.equal(stopped.aiStatus, '待授权');
  assert.equal(stopped.authorized, false);
  assert.equal(stopped.artifacts?.length || 0, 0);
  assert.equal(stopped.used || 0, 0);
});

test('a delayed result cannot overwrite a stopped or replaced generation', () => {
  const data = initialData(), task = data.tasks[0];
  Object.assign(task, { authorized: true, status: '已承接', aiStatus: '已停止', generationToken: undefined, scope: { sources: '手工要求', destination: '本机' } });
  assert.equal(taskLogic.finishLocalGeneration(data, task.id, 'old', 1).tasks[0], task);
  Object.assign(task, { aiStatus: '准备中', generationToken: 'new' });
  assert.equal(taskLogic.finishLocalGeneration(data, task.id, 'old', 1).tasks[0], task);
});

test('ordinary tasks produce their own requirements, materials and acceptance criteria instead of the KPI sample', () => {
  const task = { ...initialData().tasks[0], id: 'manual-visit', title: '准备下周用户访谈', description: '访谈三位新用户，了解首次记录的困难', sourceSession: undefined, sourceTime: undefined, criteria: ['问题不超过十条', '先确认受访者时间'], materialRefs: [{ id: 'notes', title: '访谈观察.txt', body: '新用户希望更快开始记录' }], outputMode: '仅提纲' };
  const artifacts = taskLogic.buildTaskArtifacts(task);
  assert.equal(artifacts.length, 1);
  assert.match(artifacts[0].title, /准备下周用户访谈/);
  const text = artifacts[0].body.join('\n');
  assert.match(text, /访谈三位新用户/);
  assert.match(text, /问题不超过十条/);
  assert.match(text, /访谈观察\.txt/);
  assert.doesNotMatch(text, /第三季度|KPI|李晴|王宁/);
  assert.equal(artifacts[0].needsReview, true);
});

test('valid completion saves reviewable drafts and preserves earlier results', () => {
  const data = initialData(), task = data.tasks[0];
  Object.assign(task, { sourceId: 'tr4', authorized: true, status: '已承接', aiStatus: '准备中', generationToken: 'run', generationSpace: '我的空间', scope: { sources: '实际原话', destination: '本机' }, outputMode: '仅提纲' });
  const next = taskLogic.finishLocalGeneration(data, task.id, 'run', 2);
  assert.equal(next.tasks[0].status, '待验收');
  assert.equal(next.tasks[0].aiStatus, '草稿完成');
  assert.equal(next.tasks[0].artifacts.length, 1);
  assert.equal(next.tasks[0].artifacts[0].needsReview, true);
  assert.equal(next.tasks[0].generationToken, undefined);
  assert.equal(next.tasks[0].used, 2);
  assert.equal(data.tasks[0].artifacts, undefined);
});

test('team supplemental material must still be attached and explicitly shared', () => {
  const data = sharedData(); const title = data.sessions[0].attachments[0];
  assert.equal(model.materialVisible(data, 'session-001', title), false);
  data.settings.toggles['material-shared:session-001:' + title] = true;
  assert.equal(model.materialVisible(data, 'session-001', title), true);
  data.sessions[0].attachments = [];
  assert.equal(model.materialVisible(data, 'session-001', title), false);
});

test('saving preferences and actual retention use selected fragment IDs', () => {
  const data = initialData();
  data.settings.retention['session-session-001'] = '结束后选择片段';
  assert.equal(recording.preferredSaveScope(data, 'session-001'), '手动选择片段');
  const transcript = [{ id: 'a', time: '00:01', speaker: '我', text: 'A' }, { id: 'b', time: '00:01', speaker: '我', text: 'B', private: true }];
  assert.deepEqual(recording.retainedTranscript(transcript, '手动选择片段', ['b']).map(t => t.id), ['b']);
  assert.deepEqual(recording.retainedTranscript(transcript, '仅保存非敏感片段', ['b']).map(t => t.id), ['a']);
  assert.equal(recording.retainedTranscript(transcript, '手动选择片段', []).length, 0);
  assert.equal(recording.preferredSaveScope(data, 'missing'), '完整保存');
});

test('the attention queue includes handoff, acceptance and source review consistently', () => {
  const task = initialData().tasks[0];
  for (const status of ['待承接', '待转交', '待验收']) assert.equal(model.taskNeedsAttention({ ...task, status }), true);
  assert.equal(model.taskNeedsAttention({ ...task, status: '已完成', needsReview: true }), true);
  assert.equal(model.taskNeedsAttention({ ...task, status: '进行中' }), false);
});

test('confirming a candidate removes it from the queue and permits local advice', () => {
  const data = initialData(), candidate = data.memories.find(m => m.id === 'MEM-003');
  assert.equal(memoryLogic.memoryUsable(data, candidate), false);
  const result = memoryLogic.confirmMemoryReview(data, candidate.id, { body: '目前负责首版规划，适用于 Oops 首版', editing: true, sourceSession: '', sourceId: '', sourceTouched: false, replace: false }, false);
  assert.equal(result.error, undefined);
  assert.equal(memoryLogic.memoryReviewQueue(result.data).some(m => m.id === candidate.id), false);
  assert.equal(memoryLogic.memoryUsable(result.data, result.data.memories.find(m => m.id === candidate.id)), true);
  assert.equal(result.data.memories.find(m => m.id === 'MEM-001').body, data.memories.find(m => m.id === 'MEM-001').body);
});

test('a candidate with a missing exact source cannot be confirmed by an unrelated matching timestamp', () => {
  const data = initialData(), candidate = data.memories.find(m => m.id === 'MEM-003');
  Object.assign(candidate, { sourceSession: 'session-001', sourceId: 'missing', sourceTime: '00:06:20' });
  const draft = { body: candidate.body, editing: false, sourceSession: candidate.sourceSession, sourceId: candidate.sourceId, sourceTouched: false, replace: false };
  assert.ok(memoryLogic.confirmMemoryReview(data, candidate.id, draft, false).error);
  assert.equal(candidate.confirmed, false);
  assert.ok(memoryLogic.confirmMemoryReview(data, candidate.id, { ...draft, sourceTouched: true, sourceSession: '', sourceId: '' }, false).error);
});

test('memory actions retain exact evidence and return existing actions unless explicitly creating another', () => {
  const data = initialData();
  const same = memoryLogic.taskFromMemory(data, 'MEM-024');
  assert.equal(same.existing, true);
  assert.equal(same.task.id, 'TASK-033');
  assert.equal(same.data.tasks.length, data.tasks.length);
  const another = memoryLogic.taskFromMemory(data, 'MEM-024', true, 'memory-action');
  assert.equal(another.error, undefined);
  assert.equal(another.task.sourceId, 'tr3');
  assert.equal(another.task.sourceMemoryId, 'MEM-024');
  assert.equal(another.task.relatedSessionId, 'session-001');
  assert.equal(another.task.authorized, undefined);
  assert.ok(memoryLogic.taskFromMemory(data, 'MEM-003').error);
});

test('confirming a speaker changes only the selected passage, preserves task ownership and does not grant voice consent', () => {
  const data = initialData();
  data.tasks[2].authorized = true; data.tasks[2].generationToken = 'speaker-run';
  const beforeOther = data.sessions[0].transcript.find(t => t.id === 'tr4');
  const result = memoryLogic.confirmPersonSpeaker(data, { personId: 'p3', sessionId: 'session-001', turnId: 'tr3', name: 'Lydia', voiceConsent: false });
  assert.equal(result.error, undefined);
  assert.equal(result.data.people.find(p => p.id === result.personId).voice, false);
  assert.equal(result.data.settings.toggles['speaker-confirmed:session-001:tr3'], true);
  assert.equal(result.data.sessions[0].transcript.find(t => t.id === 'tr3').speaker, 'Lydia');
  assert.equal(result.data.sessions[0].transcript.find(t => t.id === 'tr4'), beforeOther);
  assert.equal(result.data.tasks[2].owner, data.tasks[2].owner);
  assert.equal(result.data.tasks[2].authorized, false);
  assert.equal(result.data.tasks[2].generationToken, undefined);
  assert.equal(result.data.memories.find(m => m.id === 'MEM-024').confirmed, false);
  assert.ok(memoryLogic.confirmPersonSpeaker(data, { sessionId: 'missing', turnId: 'tr3', name: 'Lydia', voiceConsent: true }).error);
});

test('saving a new profile role creates a reviewable candidate and preserves the confirmed role history', () => {
  const data = initialData(), old = data.memories.find(m => m.id === 'MEM-001');
  const result = memoryLogic.saveIdentityBackground(data, { name: '林', role: '增长负责人', roles: '产品与增长', context: '新项目', plannedCandidateId: 'new-role' });
  assert.equal(result.error, undefined);
  assert.equal(result.data.settings.role, '增长负责人');
  assert.equal(result.data.memories.find(m => m.id === old.id).body, old.body);
  const candidate = result.data.memories.find(m => m.id === result.candidateId);
  assert.equal(candidate.confirmed, false);
  assert.equal(candidate.visibility, '私有');
  assert.match(candidate.body, /增长负责人/);
  assert.equal(memoryLogic.memoryUsable(result.data, candidate), false);
});

test('legacy saved Recall snapshots remain usable after the short term cache is cleared', () => {
  const data = initialData();
  data.recallCleared = true;
  const saved = { id: 'saved-recall', title: 'Saved words', body: '10:17:30 我：下次找两位同事试用', category: '灵感', tags: ['Recall', '待验证'], visibility: '私有', updated: 'today', confirmed: true, sourceTime: '10:17:30' };
  data.memories.push(saved);
  data.tasks.push({ ...data.tasks[0], id: 'recall-action', sourceSession: undefined, sourceTime: undefined, activities: ['来自已保存片段 saved-recall'] });
  const next = migration.migrateStoredData(data), memory = next.memories.find(m => m.id === saved.id);
  assert.equal(memory.sourceTime, undefined);
  assert.equal(memory.body, saved.body);
  assert.equal(memoryLogic.memoryUsable(next, memory), true);
  assert.equal(next.tasks.find(t => t.id === 'recall-action').sourceMemoryId, saved.id);
  assert.equal(model.taskSourceAvailable(next, next.tasks.find(t => t.id === 'recall-action')), true);
  assert.match(next.settings.retention['recall-source:' + saved.id], /10:17:30/);
  assert.equal(next.recallCleared, true);
});

test('circular task and attached-memory citations fail closed without recursive crashes', () => {
  const data = sharedData(), task = data.tasks[0];
  const title = '由任务保存的资料';
  const memory = { ...data.memories[0], id: 'task-derived-material', title, sourceId: 'tr4', sourceTime: '00:18:02', visibility: '项目共享', tags: ['资料'], sources: [{ kind: 'task', id: task.id }] };
  data.sessions[0].attachments.push(title); data.memories.push(memory);
  data.settings.toggles['material-shared:session-001:' + title] = true;
  data.settings.retention['memory-space:' + memory.id] = team;
  task.sourceId = 'tr4'; task.materialRefs = [{ id: 'ref', title, sourceSession: 'session-001', sourceId: 'tr4', memoryId: memory.id }];
  assert.equal(model.taskVisible(data, task), false);
  assert.equal(model.materialVisible(data, 'session-001', title), false);
});

test('imported text retains supplied timestamps without inventing time for plain paragraphs', () => {
  const turns = sessionLogic.parseImportedTranscript('王宁：先确认预算\n00:02:10 Alex：保留这个时间\n00:88:10 我：这个时间无效', 'file');
  assert.deepEqual(turns.map(t => t.id), ['file-1', 'file-2', 'file-3']);
  assert.equal(turns[0].time, '');
  assert.equal(turns[1].time, '00:02:10');
  assert.equal(turns[2].time, '');
  assert.equal(turns[0].text, '先确认预算');
});

function reviewedSessionData() {
  const data = sharedData(); data.settings.space = '我的空间';
  const s = data.sessions[0];
  s.privateNotes = ['PRIVATE-NOTE'];
  s.transcript.push({ id: 'private-passage', time: '00:19:00', speaker: '我', text: 'PRIVATE-PASSAGE', private: true });
  data.settings.retention['session-review-items:' + s.id] = JSON.stringify([
    { id: 'public-conclusion', kind: 'conclusion', text: 'SHARED-CONCLUSION', confirmed: true, shared: true, sourceId: 'tr4' },
    { id: 'private-conclusion', kind: 'conclusion', text: 'PRIVATE-CONCLUSION', confirmed: true, shared: false, sourceId: 'private-passage' },
    { id: 'open-question', kind: 'question', text: 'UNDECIDED-QUESTION', confirmed: true, shared: false },
  ]);
  return data;
}

test('common minutes ignore the private switch and include only individually shared conclusions', () => {
  const data = reviewedSessionData();
  const exported = sessionLogic.buildSessionExport(data, 'session-001', '共同纪要', true);
  assert.match(exported, /SHARED-CONCLUSION/);
  assert.doesNotMatch(exported, /PRIVATE-NOTE|PRIVATE-PASSAGE|PRIVATE-CONCLUSION|UNDECIDED-QUESTION/);
});

test('personal review includes confirmed results, questions, actions and selected private content', () => {
  const data = reviewedSessionData();
  const text = sessionLogic.buildSessionExport(data, 'session-001', '个人复盘', true);
  for (const value of ['SHARED-CONCLUSION', 'PRIVATE-CONCLUSION', 'UNDECIDED-QUESTION', 'PRIVATE-NOTE', 'PRIVATE-PASSAGE', data.tasks[0].title]) assert.ok(text.includes(value), value);
  const invalidated = model.invalidateSessionSources(data, 'session-001', ['tr4']);
  assert.match(sessionLogic.buildSessionExport(invalidated, 'session-001', '个人复盘', true), /待.*核对|待复核/);
  assert.doesNotMatch(sessionLogic.buildSessionExport(invalidated, 'session-001', '共同纪要', true), /SHARED-CONCLUSION/);
});

test('revoking a shared conversation removes common export content on its next projection', () => {
  const data = reviewedSessionData();
  data.settings.toggles['shared-session-001'] = false;
  const text = sessionLogic.buildSessionExport(data, 'session-001', '共同纪要', true);
  assert.doesNotMatch(text, /SHARED-CONCLUSION|PRIVATE|第三季度|首版先按十万元/);
});
