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
const { activeHomeRecording, homeDeviceSummary, recordingPeople, homeAssistantWork, assistantStage, unknownConversationClues, preferenceDraft } = await import('../src/feedbackPresentation.ts');

test('home follows only a visible current active recording, including pause, rather than a recent finished session', () => {
  const data = initialData();
  data.activeSessionId = data.sessions[0].id;
  assert.equal(activeHomeRecording(data), undefined);
  data.sessions[0].status = '暂停';
  assert.equal(activeHomeRecording(data)?.status, '暂停');
  data.settings.space = 'Oops 产品团队';
  assert.equal(activeHomeRecording(data), undefined);
  data.settings.toggles['shared-' + data.sessions[0].id] = true;
  assert.equal(activeHomeRecording(data)?.id, data.sessions[0].id);
  data.sessions[0].archived = true;
  assert.equal(activeHomeRecording(data), undefined);
});

test('recording participants distinguish exact confirmed identities, same-name people and unresolved voices', () => {
  const data = initialData(), session = data.sessions[0];
  data.people.push({ ...data.people[0], id: 'second', name: data.people[0].name });
  session.transcript = [
    { id: 'self', speaker: '我', time: '00:00', text: 'hello' },
    { id: 'a', personId: 'p1', speaker: '王宁', time: '00:01', text: 'one' },
    { id: 'b', personId: 'second', speaker: '王宁', time: '00:02', text: 'two' },
    { id: 'c', speaker: '说话人 C', time: '00:03', text: 'three' },
    { id: 'd', speaker: '说话人 C', time: '00:04', text: 'four' },
  ];
  data.settings.toggles['speaker-confirmed:' + session.id + ':a'] = true;
  data.settings.toggles['speaker-confirmed:' + session.id + ':b'] = true;
  assert.deepEqual(recordingPeople(data, session), { names: ['我', '王宁', '王宁'], unknown: 1, count: 4 });
  delete data.settings.toggles['speaker-confirmed:' + session.id + ':b'];
  assert.equal(recordingPeople(data, session).unknown, 2);
});

test('team participant summary excludes private utterances', () => {
  const data = initialData(), session = data.sessions[0];
  data.settings.space = 'Oops 产品团队';
  session.transcript = [{ id: 'private', speaker: '匿名私密参与人', text: 'secret', time: '', private: true }];
  assert.deepEqual(recordingPeople(data, session), { names: [], unknown: 0, count: 0 });
});

test('assistant summary keeps actual stages, excludes ended work and does not treat a namesake as the user', () => {
  const data = initialData(), base = data.tasks[0];
  data.tasks = [
    { ...base, id: 'running', aiStatus: '准备中', status: '进行中' },
    { ...base, id: 'draft', aiStatus: '草稿完成', status: '已承接', needsReview: true },
    { ...base, id: 'ended', aiStatus: '草稿完成', status: '已完成' },
    { ...base, id: 'other', owner: '我', ownerPersonId: 'namesake', aiStatus: '准备中', status: '进行中' },
  ];
  assert.deepEqual(homeAssistantWork(data).map(task => task.id), ['running', 'draft']);
  assert.equal(assistantStage(data.tasks[0]), '正在按已确认要求准备');
  assert.equal(assistantStage(data.tasks[1]), '草稿已准备，等你核对');
  data.tasks[0].sourceNeedsReview = true;
  assert.equal(assistantStage(data.tasks[0]), '来源变化，等待重新核对');
});

test('unknown identity clues never adopt a matching display name or identify an unrelated person', () => {
  const data = initialData(), session = data.sessions[0];
  session.transcript = [
    { id: 'exact', personId: 'p3', speaker: '待确认', time: '00:01', text: 'explicit unknown' },
    { id: 'unbound', speaker: '待确认', time: '00:02', text: 'needs user selection' },
    { id: 'other', personId: 'other', speaker: '待确认', time: '00:03', text: 'different identity' },
    { id: 'named', speaker: '王宁', time: '00:04', text: 'bare name is not the unknown identity' },
  ];
  const clues = unknownConversationClues(data, 'p3');
  assert.deepEqual(clues.map(clue => [clue.turn.id, clue.exactPerson]), [['exact', true], ['unbound', false]]);
  assert.equal(data.settings.toggles['speaker-confirmed:' + session.id + ':exact'], undefined);
});

test('already checked, archived and team-space unknown source clues do not reappear', () => {
  const data = initialData(), session = data.sessions[0];
  session.transcript = [{ id: 'unknown', speaker: '待确认', text: 'question', time: '' }];
  assert.equal(unknownConversationClues(data).length, 1);
  data.settings.toggles['speaker-confirmed:' + session.id + ':unknown'] = true;
  assert.equal(unknownConversationClues(data).length, 0);
  delete data.settings.toggles['speaker-confirmed:' + session.id + ':unknown'];
  session.archived = true;
  assert.equal(unknownConversationClues(data).length, 0);
  session.archived = false; data.settings.space = 'Oops 产品团队';
  assert.equal(unknownConversationClues(data).length, 0);
});

test('quick preference draft preserves the user description and leaves identity and settings unchanged', () => {
  const values = { role: '设计师', focus: ' 首版流程 ', description: '请分步骤，简短一点', avoid: ' 不要频繁打断 ' };
  const before = structuredClone(values);
  assert.deepEqual(preferenceDraft(values), { role: '设计师', focus: '首版流程', tone: '逐步说明操作', length: '简短', customTone: '请分步骤，简短一点', avoid: '不要频繁打断' });
  assert.deepEqual(values, before);
});

test('custom answer preferences use current profile evidence and cannot silently survive later changes', async () => {
  const home = readFileSync(new URL('../src/features/Home.tsx', import.meta.url), 'utf8');
  const url = path => new URL(path, import.meta.url).href;
  const imports = `import { buildPersonalContext } from '${url('../src/personalAssistant.ts')}';import { sharedMemoryEligible } from '${url('../src/memoryAccess.ts')}';import { makeSourceReference, materialVisible, provenanceAvailable, sourceAvailable, taskSourceAvailable, taskVisible as scopedTaskVisible, sessionVisible as scopedSessionVisible } from '${url('../src/sourceAccess.ts')}';import { taskIsMyAttention, taskBelongsToMe } from '${url('../src/taskWorkflow.ts')}';`;
  const code = imports + home.slice(home.indexOf('export function homeTitle'), home.indexOf('export function Home()')) + home.slice(home.indexOf('type LocalAnswer'), home.indexOf('function referenceRoute'));
  const { buildLocalAnswer } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code, { mode: 'strip' })).toString('base64'));
  const { provenanceAvailable } = await import('../src/sourceAccess.ts');
  const data = initialData();
  data.settings.tone = '自定义：分步骤说明';
  data.settings.retention.answerLength = '自定义：100字以内';
  const answer = buildLocalAnswer('项目预算是多少？', data, true);
  assert.ok(answer.text.startsWith('1.'));
  assert.ok(answer.text.length <= 100);
  assert.ok(answer.sources.some(ref => ref.kind === 'profile' && ref.profileScope === 'preferences'));
  assert.equal(provenanceAvailable(data, answer.sources), true);
  data.settings.tone = '自定义：先一起探索';
  assert.equal(provenanceAvailable(data, answer.sources), false);
  data.settings.space = 'Oops 产品团队';
  assert.equal(buildLocalAnswer('项目预算是多少？', data, true).sources.some(ref => ref.kind === 'profile'), false);
});


test('home device summary reuses explicit demo connection and battery without inventing readings', () => {
  const data = initialData();
  assert.match(homeDeviceSummary(data), /连接录音豆/);
  assert.doesNotMatch(homeDeviceSummary(data), /%/);
  data.settings.devices['录音豆'] = true;
  assert.match(homeDeviceSummary(data), /示例已连接/);
  assert.doesNotMatch(homeDeviceSummary(data), /%/);
  data.settings.retention['device-status:录音豆'] = '离线';
  data.settings.retention['device-battery:录音豆'] = '51%';
  assert.match(homeDeviceSummary(data), /示例离线 · 51%/);
  data.settings.devices['桌面伙伴'] = true;
  assert.match(homeDeviceSummary(data), /另有1台/);
});
