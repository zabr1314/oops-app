import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
const base = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, base), 'utf8');
const load = code => import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code, { mode: 'strip' })).toString('base64'));
const store = read('src/store.tsx');
const { initialData } = await load(store.slice(store.indexOf('export function initialData')));
const source = read('src/features/MemorySettings.tsx');
const imports = `import { sharedMemoryEligible } from '${new URL('src/memoryAccess.ts', base)}';\nimport { sourceAvailable, sourceTurn, taskVisible, findSourceTask, invalidateSessionSources, makeSourceReference, provenanceAvailable } from '${new URL('src/sourceAccess.ts', base)}';\n`;
const memory = await load(imports + source.slice(source.indexOf('const PERSONAL'), source.indexOf('function Download')));
const access = await import('../src/sourceAccess.ts');
const { projectMemorySummary } = await import('../src/projectMemoryLogic.ts');
const { assistantQuestion, unansweredAssistantQuestion } = await import('../src/assistantLogic.ts');
const TEAM = 'Oops 产品团队';
const draftFor = item => ({ body: item.body, editing: false, sourceSession: item.sourceSession || '', sourceId: item.sourceId || '', sourceTouched: false, replace: false });

function revisedCandidate() {
  let data = initialData();
  const item = { id: 'audit-candidate', title: '待核对', body: '修订前的建议', category: '记忆', tags: ['待确认'], visibility: '私有', confirmed: false, updated: '今天', sourceSession: 'session-001', sourceId: 'tr2', sources: [access.makeSourceReference(data, { kind: 'session', id: 'session-001', sourceId: 'tr2' })] };
  data.memories.push(item);
  data = access.invalidateSessionSources(data, 'session-001', ['tr2']);
  data.sessions[0].transcript.find(turn => turn.id === 'tr2').text = '修订后的建议，需先核对预算';
  return { data, item: data.memories.find(row => row.id === item.id) };
}

test('a stale candidate cannot rebind unchanged old prose without explicitly checking current evidence', () => {
  const { data, item } = revisedCandidate();
  const draft = draftFor(item);
  const blocked = memory.confirmMemoryReview(data, item.id, draft, false);
  assert.match(blocked.error, /查看当前原话/);
  assert.equal(blocked.data.memories.find(row => row.id === item.id).confirmed, false);
  assert.equal(memory.memoryUsable(blocked.data, item), false);
  const checked = { ...draft, body: '核对后：先确认预算', checkedSources: memory.memoryReviewEvidence(data, item, draft) };
  const result = memory.confirmMemoryReview(data, item.id, checked, false);
  assert.equal(result.error, undefined);
  assert.equal(memory.memoryUsable(result.data, result.data.memories.find(row => row.id === item.id)), true);
  assert.equal(memory.memoryReviewQueue(result.data).some(row => row.id === item.id), false);
});

test('source changes after the evidence checkbox require another review, including legacy pointers', () => {
  const { data, item } = revisedCandidate();
  item.sources = undefined;
  const draft = draftFor(item);
  const checkedSources = memory.memoryReviewEvidence(data, item, draft);
  assert.equal(checkedSources[0].sourceId, 'tr2');
  data.sessions[0].transcript.find(turn => turn.id === 'tr2').speaker = '另一个已核对的人';
  assert.match(memory.confirmMemoryReview(data, item.id, { ...draft, checkedSources }, false).error, /来源再次变化/);
});

test('reselecting one primary source does not silently replace independent citations from the same meeting', () => {
  const { data, item } = revisedCandidate();
  item.sources.push(access.makeSourceReference(data, { kind: 'session', id: 'session-001', sourceId: 'tr4', sourceTime: '00:18:02' }));
  const draft = { ...draftFor(item), sourceTouched: true, sourceId: 'tr3' };
  const evidence = memory.memoryReviewEvidence(data, item, draft);
  assert.equal(evidence.some(ref => ref.sourceId === 'tr2'), false);
  assert.equal(evidence.some(ref => ref.sourceId === 'tr3'), true);
  assert.equal(evidence.some(ref => ref.sourceId === 'tr4'), true);
});

test('project rename retains tagged memories and reviewable derived tasks without changing workspace ownership', () => {
  let data = initialData();
  data.settings.toggles['shared-session-001'] = true;
  const project = data.projects[0];
  const item = { id: 'project-note', title: '项目背景', body: '已核对的项目正文', category: '记忆', tags: [project.name, project.name + ' 附加'], visibility: '项目共享', confirmed: true, updated: '今天' };
  data.memories.push(item);
  data.settings.retention['memory-space:' + item.id] = TEAM;
  data = memory.taskFromMemory(data, item.id, false, 'project-task').data;
  data.settings.retention['task-space:project-task'] = TEAM;
  const task = data.tasks.find(row => row.id === 'project-task');
  task.authorized = true;
  task.generationToken = 'pending';
  const next = memory.saveProjectBackground(data, { ...project, name: 'Oops 更新名称' });
  const saved = next.memories.find(row => row.id === item.id), derived = next.tasks.find(row => row.id === task.id);
  assert.deepEqual(saved.tags, ['Oops 更新名称', project.name + ' 附加']);
  assert.equal(saved.body, item.body);
  assert.equal(saved.confirmed, true);
  assert.equal(saved.visibility, '项目共享');
  assert.equal(next.settings.retention['memory-space:' + item.id], TEAM);
  assert.equal(next.settings.retention['task-space:' + task.id], TEAM);
  assert.equal(derived.authorized, false);
  assert.equal(derived.generationToken, undefined);
  assert.equal(derived.sourceNeedsReview, true);
  assert.equal(derived.version, task.version + 1);
  assert.equal(projectMemorySummary(next, project.id).tasks.some(row => row.id === task.id), true);
  const team = { ...next, settings: { ...next.settings, space: TEAM } };
  assert.equal(projectMemorySummary(team, project.id).tasks.some(row => row.id === task.id), false);
  assert.equal(next.sessions.filter(session => session.project === project.name).length, 0);
});

test('changing project evidence withdraws direct and transitive derivations while unrelated work stays intact', () => {
  let data = initialData();
  const project = data.projects[0];
  const direct = { ...data.tasks[0], id: 'project-budget-task', sourceSession: undefined, sourceTime: undefined, authorized: true, generationToken: 'pending-project', sources: [access.makeSourceReference(data, { kind: 'project', id: project.id })] };
  data.tasks.push(direct);
  data.memories.push({ id: 'budget-derived-memory', title: '预算结果', body: '旧预算结果', category: '记忆', tags: [project.name], visibility: '私有', confirmed: true, updated: '今天', sources: [access.makeSourceReference(data, { kind: 'task', id: direct.id })] });
  data = memory.taskFromMemory(data, 'budget-derived-memory', false, 'budget-derived-task').data;
  const next = memory.saveProjectBackground(data, { ...project, budget: project.budget + 100 });
  assert.equal(next.tasks.find(row => row.id === direct.id).authorized, false);
  assert.equal(next.tasks.find(row => row.id === direct.id).generationToken, undefined);
  assert.equal(next.memories.find(row => row.id === 'budget-derived-memory').needsReview, true);
  assert.equal(next.tasks.find(row => row.id === 'budget-derived-task').sourceNeedsReview, true);
  assert.equal(next.tasks.find(row => row.id === 'TASK-021'), data.tasks.find(row => row.id === 'TASK-021'));
});

test('interrupted follow-up cannot associate an old answer with the new question; retry completes the same turn', () => {
  const messages = [
    { id: 'q1', role: 'user', text: '项目预算是多少？' },
    { id: 'a1', role: 'assistant', text: '项目预算结果' },
    { id: 'q2', role: 'user', text: '帮我整理桌面伙伴灵感' },
  ];
  assert.equal(assistantQuestion(messages, messages[1]).id, 'q1');
  assert.equal(unansweredAssistantQuestion(messages).id, 'q2');
  const resumed = [...messages, { id: 'a2', role: 'assistant', text: '桌面伙伴结果', replyToId: 'q2' }];
  assert.equal(unansweredAssistantQuestion(resumed), undefined);
  assert.equal(assistantQuestion(resumed, resumed[3]).text, '帮我整理桌面伙伴灵感');
});

test('explicit answer binding cannot fall back to another question or cross workspace boundaries', () => {
  const messages = [
    { id: 'personal-q', role: 'user', text: '私人问题', space: '我的空间' },
    { id: 'team-q', role: 'user', text: '团队问题', space: TEAM },
    { id: 'team-a', role: 'assistant', text: '团队回答', space: TEAM, replyToId: 'personal-q' },
    { id: 'legacy-a', role: 'assistant', text: '旧回答', space: '我的空间' },
    { id: 'missing-a', role: 'assistant', text: '不完整关联', replyToId: 'deleted-q' },
  ];
  assert.equal(assistantQuestion(messages, messages[2]), undefined);
  assert.equal(assistantQuestion(messages, messages[3]).id, 'personal-q');
  assert.equal(assistantQuestion(messages, messages[4]), undefined);
});

test('review evidence shows current project, task and profile bodies rather than stale answer text', () => {
  const data = initialData();
  const sources = [access.makeSourceReference(data, { kind: 'project', id: 'project-1' }), access.makeSourceReference(data, { kind: 'task', id: 'TASK-021' }), access.makeSourceReference(data, { kind: 'profile', id: 'my-profile', profileScope: 'preferences' })];
  data.projects[0].budget = 230000;
  data.tasks[0].description = '当前任务要求';
  data.settings.retention.focus = '当前最关注预算';
  const cards = memory.memoryReviewSourceCards(data, sources);
  assert.match(cards[0].body, /230,000/);
  assert.match(cards[1].body, /当前任务要求/);
  assert.match(cards[2].body, /当前最关注预算/);
  assert.ok(cards.every(card => card.route && card.available));
});

test('team evidence cards reveal neither private task/memory bodies nor identity and preference data', () => {
  const data = initialData();
  data.settings.space = TEAM;
  data.settings.name = 'PRIVATE-NAME';
  data.settings.retention.focus = 'PRIVATE-FOCUS';
  data.tasks[0].description = 'PRIVATE-TASK';
  data.memories[0].body = 'PRIVATE-MEMORY';
  data.projects[0].description = 'FOREIGN-PROJECT';
  data.settings.retention['project-space:project-1'] = '别的空间';
  const cards = memory.memoryReviewSourceCards(data, [{ kind: 'task', id: data.tasks[0].id }, { kind: 'memory', id: data.memories[0].id }, { kind: 'profile', id: 'my-profile', profileScope: 'identity' }, { kind: 'profile', id: 'my-profile', profileScope: 'preferences' }, { kind: 'project', id: 'project-1' }]);
  assert.doesNotMatch(JSON.stringify(cards), /PRIVATE-|FOREIGN-PROJECT/);
  assert.ok(cards.every(card => !card.available && !card.route));
});

test('current source cards keep pending references visible to their owner while blocking their use', () => {
  const data = initialData();
  data.tasks[0].sourceNeedsReview = true;
  data.memories[0].needsReview = true;
  const cards = memory.memoryReviewSourceCards(data, [{ kind: 'task', id: data.tasks[0].id }, { kind: 'memory', id: data.memories[0].id }]);
  assert.equal(cards[0].available, false);
  assert.equal(cards[0].route.view, 'task-detail');
  assert.equal(cards[1].available, false);
  assert.equal(cards[1].route.view, 'memory-candidate');
});

test('person rename updates only exact task identities, preserves history and withdraws old execution', () => {
  const data = initialData();
  const person = data.people.find(item => item.id === 'p1');
  data.people.find(item => item.id === 'p2').name = person.name;
  const task = { ...data.tasks[0], id: 'bound-person-task', owner: person.name, ownerPersonId: person.id, requester: person.name, requesterPersonId: person.id, authorized: true, generationToken: 'pending-person', artifacts: [{ id: 'old-person-artifact', kind: '文档', title: '原稿', version: 1, body: ['旧稿'], created: '昨天', reviewedAt: '昨天' }] };
  const namesake = { ...task, id: 'namesake-task', ownerPersonId: 'p2', requesterPersonId: 'p2' };
  const legacy = { ...task, id: 'legacy-id-task', ownerPersonId: undefined, requesterPersonId: undefined };
  const unbound = { ...task, id: 'name-only-task', ownerPersonId: undefined, requesterPersonId: undefined };
  data.tasks.push(task, namesake, legacy, unbound);
  data.settings.retention['task-owner-person:' + legacy.id] = person.id;
  data.settings.retention['task-space:' + task.id] = TEAM;
  data.receipts.push({ id: 'history-receipt', taskId: task.id, kind: '消息', target: person.name, body: '历史原文', date: '昨天' });
  const next = memory.savePersonProfile(data, { ...person, name: '王宁新名' });
  const current = next.tasks.find(item => item.id === task.id);
  assert.equal(current.owner, '王宁新名');
  assert.equal(current.requester, '王宁新名');
  assert.equal(current.version, task.version + 1);
  assert.equal(current.authorized, false);
  assert.equal(current.generationToken, undefined);
  assert.equal(current.artifacts[0].needsReview, true);
  assert.equal(current.artifacts[0].reviewedAt, undefined);
  assert.equal(next.settings.retention['task-space:' + task.id], TEAM);
  assert.equal(next.tasks.find(item => item.id === namesake.id), namesake);
  assert.equal(next.tasks.find(item => item.id === unbound.id), unbound);
  assert.equal(next.tasks.find(item => item.id === legacy.id).owner, '王宁新名');
  assert.equal(next.tasks.find(item => item.id === legacy.id).requester, person.name);
  assert.equal(next.sessions, data.sessions);
  assert.equal(next.sessions[0].transcript.find(turn => turn.id === 'tr4').speaker, person.name);
  assert.equal(next.receipts, data.receipts);
  assert.equal(next.receipts[0].target, person.name);
});

test('renaming a person invalidates downstream source snapshots without rewriting their prose', () => {
  const data = initialData();
  const person = data.people.find(item => item.id === 'p1');
  const task = { ...data.tasks[0], id: 'owner-source', owner: person.name, ownerPersonId: person.id, requester: '我' };
  data.tasks.push(task);
  data.memories.push({ id: 'person-result', title: '旧任务观察', body: '保留的原始判断', category: '记忆', tags: [], visibility: '私有', updated: '今天', confirmed: true, sources: [access.makeSourceReference(data, { kind: 'task', id: task.id })] });
  const next = memory.savePersonProfile(data, { ...person, name: '王宁新名' });
  const derived = next.memories.find(item => item.id === 'person-result');
  assert.equal(derived.body, '保留的原始判断');
  assert.equal(derived.confirmed, false);
  assert.equal(derived.needsReview, true);
  assert.equal(memory.memoryUsable(next, derived), false);
});


test('sharing public identity does not reveal private role context in review evidence',()=>{
  const data=initialData();data.settings.space=TEAM;data.settings.toggles.publicIdentity=true;data.settings.retention.roleContext='PRIVATE-ROLE-CONTEXT';
  const cards=memory.memoryReviewSourceCards(data,[{kind:'profile',id:'my-profile',profileScope:'identity'}]);
  assert.equal(cards[0].available,true);assert.ok(cards[0].body.includes(data.settings.name));assert.doesNotMatch(cards[0].body,/PRIVATE-ROLE-CONTEXT/);
});
