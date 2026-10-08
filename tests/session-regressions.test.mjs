import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

const logic = await import('../src/sessionLogic.ts');
const workflow = await import('../src/taskWorkflow.ts');
const generation = await import('../src/taskLogic.ts');
const sourceText = await readFile(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seedCode = stripTypeScriptTypes(sourceText.slice(sourceText.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seedCode).toString('base64'));
const makeId = (kind, index) => `${kind}-${index}`;
const item = (text, sourceId) => ({ id: text, kind: 'conclusion', text, sourceId, confirmed: true, shared: true });
const emptyAction = () => ({ title: '', body: '', due: '', sourceId: '', another: false });

test('revoking session sharing stops an actual authorized generation and clears item scopes', () => {
  let data = initialData();
  const id = data.sessions[0].id;
  data.settings.toggles[`shared-${id}`] = true;
  data.settings.toggles[`material-shared:${id}:产品指标.xlsx`] = true;
  data.settings.retention[`session-review-items:${id}`] = JSON.stringify([item('确认结果', 'tr1')]);
  data = workflow.authorizeTask(data, 'TASK-032', { sources: '已确认原话', destination: '我的个人成果', space: '我的空间', materialIds: [], includeSource: true }, '资料整理').data;
  data = workflow.beginGeneration(data, 'TASK-032', { token: 'session-revoke-token' }).data;
  assert.equal(data.tasks.find(task => task.id === 'TASK-032').aiStatus, '准备中');
  const revoked = logic.setSessionShared(data, id, false);
  const finished = generation.finishLocalGeneration(revoked, 'TASK-032', 'session-revoke-token');
  const task = finished.tasks.find(task => task.id === 'TASK-032');
  assert.equal(task.authorized, false);
  assert.equal(task.generationToken, undefined);
  assert.equal(task.generationSnapshot, undefined);
  assert.equal(task.aiStatus, '待授权');
  assert.equal(task.sourceNeedsReview, true);
  assert.equal(task.used || 0, 0);
  assert.equal(finished.settings.toggles[`material-shared:${id}:产品指标.xlsx`], false);
  assert.equal(JSON.parse(finished.settings.retention[`session-review-items:${id}`])[0].shared, false);
  const twice = logic.setSessionShared(finished, id, false);
  assert.deepEqual(twice.tasks.map(value => [value.id, value.version]), finished.tasks.map(value => [value.id, value.version]));
  assert.equal(twice.tasks.find(value => value.id === 'TASK-032').version, task.version);
});

test('ending a review round retains pending work even after an earlier confirmation', () => {
  let data = initialData();
  const session = data.sessions[0];
  data.settings.retention[`session-reviewed:${session.id}`] = '此前确认';
  data.settings.retention[`session-review-completed:${session.id}`] = '此前完成';
  data = logic.finishSessionReviewRound(data, session.id, 3, '本轮结束');
  assert.equal(data.settings.retention[`session-review-round-ended:${session.id}`], '本轮结束');
  assert.equal(data.settings.retention[`session-review-completed:${session.id}`], undefined);
  assert.equal(logic.sessionNeedsReview(data, session, 3), true);
  const done = logic.finishSessionReviewRound(data, session.id, 0, '全部核对');
  assert.equal(logic.sessionNeedsReview(done, session, 0), false);
  assert.equal(logic.sessionNeedsReview(done, session, 1), true);
});

test('manual conclusions can explicitly clear a removed citation without claiming another turn', () => {
  const data = initialData();
  const session = data.sessions[0];
  session.transcript = session.transcript.filter(turn => turn.id !== 'tr1');
  const result = logic.buildReviewItems(session, [item('旧结论', 'tr1')], { conclusions: '旧结论', questions: '人工新增问题', sourceId: '', sourceMode: 'clear' }, makeId);
  assert.equal(result.error, undefined);
  assert.equal(result.items.length, 2);
  assert.equal(result.items.every(row => row.sourceId === undefined && row.shared === false), true);
});

test('reordering preserves the matching conclusion citation, while rewritten text does not inherit by index', () => {
  const session = initialData().sessions[0];
  const previous = [item('预算结论', 'tr2'), item('工作安排', 'tr4')];
  const reordered = logic.buildReviewItems(session, previous, { conclusions: '工作安排\n预算结论', questions: '', sourceId: '', sourceMode: 'preserve' }, makeId);
  assert.deepEqual(reordered.items.map(row => row.sourceId), ['tr4', 'tr2']);
  const rewritten = logic.buildReviewItems(session, previous, { conclusions: '新的人工判断\n工作安排', questions: '', sourceId: '', sourceMode: 'preserve' }, makeId);
  assert.deepEqual(rewritten.items.map(row => row.sourceId), [undefined, 'tr4']);
});

test('preserve and selected modes reject missing citations instead of silently detaching them', () => {
  const session = initialData().sessions[0];
  session.transcript = session.transcript.filter(turn => turn.id !== 'tr1');
  const previous = [item('原结论', 'tr1')];
  assert.match(logic.buildReviewItems(session, previous, { conclusions: '原结论', questions: '', sourceId: '', sourceMode: 'preserve' }, makeId).error, /人工整理/);
  assert.match(logic.buildReviewItems(session, previous, { conclusions: '原结论', questions: '', sourceId: 'tr1', sourceMode: 'selected' }, makeId).error, /已变化/);
  const selected = logic.buildReviewItems(session, previous, { conclusions: '人工重新核对', questions: '', sourceId: 'tr4', sourceMode: 'selected' }, makeId);
  assert.equal(selected.items[0].sourceId, 'tr4');
  assert.equal(logic.reviewDraftSourceMode({ conclusions: '', questions: '', sourceId: 'tr4' }), 'selected');
});

test('closing or revisiting an action continues the draft; an explicit new action resets it', () => {
  const source = initialData().sessions[0].transcript[3];
  const draft = { title: '已经写好的名称', body: '已经核对过的要求', due: '2026-10-09T17:00', sourceId: 'tr2', another: false };
  assert.equal(logic.openActionDraft(draft), draft);
  assert.equal(logic.openActionDraft(draft, source), draft);
  const another = logic.openActionDraft(draft, source, true);
  assert.equal(another.body, source.text);
  assert.equal(another.sourceId, source.id);
  assert.equal(another.due, '');
  assert.equal(another.another, true);
  assert.deepEqual(logic.openActionDraft(draft, undefined, true), emptyAction());
  assert.equal(logic.openActionDraft(emptyAction(), source).sourceId, source.id);
});

function history(data, { structured = false, removed = false } = {}) {
  const session = data.sessions[0];
  const original = { ...session.transcript[0], text: '第一行\n第二行\n第三行', personId: 'p1' };
  const memory = { id: 'history-regression', title: '修订前原文', body: `原文：${original.text}\n${removed ? '本次：片段已删除' : '修订：修改后的一行'}\n原说话人：${original.speaker}\n原敏感：false\n可见范围：私有`, category: '收藏', tags: ['修订历史', original.id], visibility: '私有', updated: '今天', confirmed: true, sourceSession: session.id, sourceId: original.id, sourceTime: original.time, ...(structured ? { revision: { original, action: removed ? 'delete' : 'edit' } } : {}) };
  data.memories.push(memory);
  session.transcript = removed ? session.transcript.filter(turn => turn.id !== original.id) : session.transcript.map(turn => turn.id === original.id ? { ...turn, text: '修改后的一行', private: true, personId: 'current-person' } : turn);
  return { session, original, memory };
}

test('structured revision restores all lines without broadening current visibility or restoring authorization', () => {
  const data = initialData();
  const { session, original, memory } = history(data, { structured: true });
  const task = data.tasks[0];
  task.sourceId = original.id;
  task.sourceTime = original.time;
  task.authorized = true;
  const result = logic.restoreSessionRevision(data, session.id, memory.id, 'fallback');
  const turn = result.data.sessions[0].transcript.find(value => value.id === original.id);
  assert.equal(turn.text, original.text);
  assert.equal(turn.private, true);
  assert.equal(turn.personId, 'current-person');
  assert.equal(result.data.tasks[0].authorized, false);
  assert.equal(result.data.tasks[0].sourceNeedsReview, true);
});

test('structured deleted revisions preserve complete text and person reference when restored privately', () => {
  const data = initialData();
  const { session, original, memory } = history(data, { structured: true, removed: true });
  memory.revision.original.text = '第一行\n修订：这是原话正文\n原说话人：这也是正文\n最后一行';
  const result = logic.restoreSessionRevision(data, session.id, memory.id, 'fallback');
  const turn = result.data.sessions[0].transcript.find(value => value.id === original.id);
  assert.equal(turn.text, memory.revision.original.text);
  assert.equal(turn.personId, original.personId);
  assert.equal(turn.private, true);
});

test('legacy multiline edit and deletion histories restore the full original', () => {
  for (const removed of [false, true]) {
    const data = initialData();
    const { session, original, memory } = history(data, { removed });
    const result = logic.restoreSessionRevision(data, session.id, memory.id, 'fallback');
    assert.equal(result.error, undefined);
    assert.equal(result.data.sessions[0].transcript.find(turn => turn.id === original.id).text, original.text);
  }
});

test('an unreadable or removed history never replaces a current turn with an empty original', () => {
  const data = initialData();
  const { session, memory } = history(data);
  memory.body = '仅有残缺记录';
  assert.equal(logic.restoreSessionRevision(data, session.id, memory.id, 'fallback').data, data);
  assert.match(logic.restoreSessionRevision(data, session.id, memory.id, 'fallback').error, /完整读取/);
  memory.deleted = true;
  assert.match(logic.restoreSessionRevision(data, session.id, memory.id, 'fallback').error, /已.*移除/);
});

// Execute the real preparation handler to cover its ownership and sharing integration.
const sessionsText = await readFile(new URL('../src/features/Sessions.tsx', import.meta.url), 'utf8');
const createComponent = sessionsText.slice(sessionsText.indexOf('function CreateSession'));
const saveHandler = createComponent.slice(createComponent.indexOf('  function save(start: boolean)'), createComponent.indexOf('  return <form'));
const prepareCode = `import { setSessionShared } from '${new URL('../src/sessionLogic.ts', import.meta.url).href}';
const uid = () => 'new-session'; const dateLabel = () => '今天'; const untitled = kind => kind;
export function saveExisting(data, existing, allowShare, start = false) {
  let next = data; const update = fn => { next = fn(next); }; const navigate = () => {}, toast = () => {}, setError = () => {};
  const kind = existing.kind, project = existing.project, members = existing.participants, agenda = existing.agenda.join('\\n'), title = existing.title, scope = '完整保存', busy = false;
  ${saveHandler}
  save(start); return next;
}`;
const prepare = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(prepareCode, { mode: 'strip' })).toString('base64'));

test('saving existing preparation retains archival status and team scope while using the shared revocation rule', () => {
  const data = initialData();
  const session = data.sessions[0];
  session.archived = true;
  data.settings.toggles[`shared-${session.id}`] = true;
  data.settings.retention[`session-space:${session.id}`] = '另一团队';
  data.tasks[1].authorized = true;
  const saved = prepare.saveExisting(data, session, false);
  assert.equal(saved.sessions[0].archived, true);
  assert.equal(saved.settings.retention[`session-space:${session.id}`], '另一团队');
  assert.equal(saved.tasks[1].authorized, false);
  assert.equal(saved.tasks[1].sourceNeedsReview, true);
});

test('editing preparation preserves newer recording content, while explicitly starting an archived plan makes it active', () => {
  const data = initialData();
  const session = data.sessions[2];
  session.archived = true;
  const oldView = { ...session, transcript: [...session.transcript], privateNotes: [...session.privateNotes] };
  session.transcript.push({ id: 'new-content', time: '', speaker: '我', text: '编辑准备期间保留的内容' });
  session.privateNotes.push('同时留下的便签');
  const saved = prepare.saveExisting(data, oldView, false);
  assert.equal(saved.sessions[2].transcript[0].text, '编辑准备期间保留的内容');
  assert.deepEqual(saved.sessions[2].privateNotes, ['同时留下的便签']);
  assert.equal(saved.sessions[2].archived, true);
  const started = prepare.saveExisting(saved, saved.sessions[2], false, true);
  assert.equal(started.sessions[2].archived, false);
  assert.equal(started.sessions[2].status, '进行中');
  assert.equal(started.activeSessionId, session.id);
});

const memoryText = await readFile(new URL('../src/features/MemorySettings.tsx', import.meta.url), 'utf8');
const memoryDependencies = `import { sharedMemoryEligible } from '${new URL('../src/memoryAccess.ts', import.meta.url).href}';
import { sourceAvailable, sourceTurn, taskVisible, findSourceTask, invalidateSessionSources, makeSourceReference, provenanceAvailable } from '${new URL('../src/sourceAccess.ts', import.meta.url).href}';`;
const memoryCode = stripTypeScriptTypes(memoryDependencies + memoryText.slice(memoryText.indexOf('const PERSONAL'), memoryText.indexOf('function Download')), { mode: 'strip' });
const memoryUrl = 'data:text/javascript;base64,' + Buffer.from(memoryCode).toString('base64');
const identityComponent = sessionsText.slice(sessionsText.indexOf('function Identity'));
const identityHandler = identityComponent.slice(identityComponent.indexOf('  function confirm()'), identityComponent.indexOf('  return <div'));
const identityCode = `import { confirmPersonSpeakers } from '${memoryUrl}';
const uid = () => 'new-person-stable'; const unknownSpeaker = name => /待确认|说话人|未知/.test(name);
export function confirmIdentity(data, s, draft, item) {
  let next = data; const messages = []; const update = fn => { next = fn(next); }; const toast = text => messages.push(text); const finish = () => {};
  ${identityHandler}
  confirm(); return { data: next, messages };
}`;
const identity = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(identityCode, { mode: 'strip' })).toString('base64'));

test('actual conversation identity confirmation uses exact person cards, selected turns, and separate voice permission', () => {
  const data = initialData();
  const session = data.sessions[0];
  const first = session.transcript[2];
  session.transcript.push({ id: 'another-anonymous', speaker: first.speaker, time: '00:19:00', text: '同一个匿名标签的另一段话' });
  data.people.push(...['person-a', 'person-b'].map(id => ({ id, name: '小陈', role: '同名人物', company: '', note: '', voice: false, shared: false })));
  data.tasks[0].sourceTime = undefined;
  const ambiguous = identity.confirmIdentity(data, session, { name: '小陈', scope: '仅这个片段', voice: false }, first);
  assert.equal(ambiguous.data, data);
  assert.match(ambiguous.messages[0], /同名人物/);
  const single = identity.confirmIdentity(data, session, { name: '小陈', scope: '仅这个片段', voice: false, targetPersonId: 'person-b' }, first);
  assert.equal(single.data.sessions[0].transcript.find(turn => turn.id === first.id).personId, 'person-b');
  assert.equal(single.data.sessions[0].transcript.find(turn => turn.id === 'another-anonymous').personId, undefined);
  assert.equal(single.data.people.find(person => person.id === 'person-b').voice, false);
  const grouped = identity.confirmIdentity(data, session, { name: '小陈', scope: '本次同一匿名标签', voice: false, targetPersonId: 'person-b' }, first);
  assert.equal(grouped.data.sessions[0].transcript.find(turn => turn.id === 'another-anonymous').personId, 'person-b');
  assert.equal(grouped.data.tasks[0].version, data.tasks[0].version + 1);
  assert.equal(grouped.data.tasks[0].owner, data.tasks[0].owner);
});
