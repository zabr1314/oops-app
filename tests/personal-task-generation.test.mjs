import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

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

const workflow = await import('../src/taskWorkflow.ts');
const logic = await import('../src/taskLogic.ts');
const work = await import('../src/assistantWorkPresentation.ts');
const personal = await import('../src/personalAssistant.ts');
const access = await import('../src/sourceAccess.ts');

function fixture(mode = '文档') {
  return {
    sessions: [], people: [], projects: [], receipts: [], messages: [], notifications: [], recallCleared: false,
    tasks: [{ id: 'personal-draft', title: '整理首版观察', description: '核对成本与试用观察，保留未知数据',
      owner: '我', requester: '我', due: '无固定期限', priority: '中', status: '已承接', aiStatus: '未启动',
      workKind: '交付', outputMode: mode, activities: [], results: [], version: 1, authorized: true,
      criteria: ['不得补造未知数据', '保留两份材料的原始观察'],
      scope: { sources: '本人要求与两份所选材料', destination: '个人草稿', includeSource: false,
        space: '我的空间', materialIds: ['interaction', 'cost'] },
      materialRefs: [{ id: 'interaction', title: '交互观察', body: '测试者希望先看到正文。' },
        { id: 'cost', title: '成本依据', body: '目前尚无单位成本数据。' }] }],
    memories: [{ id: 'own-background', title: '当前工作', body: '我正在组织首版试用。', category: '记忆',
      tags: ['角色背景'], visibility: '私有', updated: '今天', confirmed: true }],
    settings: { name: '林', role: '产品负责人', space: '我的空间', tone: '先结论，再给依据', avatar: '林',
      toggles: {}, connections: {}, devices: {}, retention: { focus: '降低成本', answerLength: '简短',
        avoid: '不要把缺失数据当作结论', roleContext: '首版试用' } },
  };
}
const begin = data => workflow.beginGeneration(data, data.tasks[0].id, { token: 'fixed-request' });
const finish = data => logic.finishLocalGeneration(data, data.tasks[0].id, 'fixed-request');
const text = task => (task.artifacts || []).flatMap(artifact => artifact.body).join('\n');

test('a new local generation freezes the exact personal context and sources with the authorized request', () => {
  const data = fixture(), original = structuredClone(data), started = begin(data);
  assert.equal(started.error, undefined);
  const snapshot = started.data.tasks[0].generationSnapshot;
  assert.equal(snapshot.personalContext.preferences.focus, '降低成本');
  assert.equal(snapshot.personalContext.identity.role, '产品负责人');
  assert.equal(snapshot.personalContext.scenario, '汇报');
  assert.ok(snapshot.sourceRefs.some(ref => ref.kind === 'memory' && ref.id === 'own-background' && ref.fingerprint));
  assert.ok(snapshot.sourceRefs.some(ref => ref.kind === 'profile' && ref.profileScope === 'preferences'));
  data.memories[0].body = '后来的背景';
  assert.match(snapshot.personalContext.entries.find(entry => entry.id === 'own-background').text, /组织首版试用/);
  assert.deepEqual(original.tasks, data.tasks);
});

test('saved preferences alter material order, writing structure and detail without dropping any selected facts', () => {
  const short = fixture();
  const shortTask = finish(begin(short).data).tasks[0];
  const body = text(shortTask);
  assert.ok(body.indexOf('成本依据') < body.indexOf('交互观察'));
  assert.match(body, /目前尚无单位成本数据/);
  assert.match(body, /测试者希望先看到正文/);
  assert.match(body, /不得补造未知数据/);
  assert.match(body, /产品负责人/);
  assert.match(body, /我正在组织首版试用/);
  assert.ok(shortTask.artifacts[0].body.every(paragraph => !paragraph.includes('\n')));
  assert.equal(shortTask.status, '已承接');
  assert.equal(shortTask.needsReview, true);
  assert.ok(shortTask.artifacts[0].sources.some(ref => ref.kind === 'memory' && ref.id === 'own-background'));

  const detailed = fixture();
  detailed.settings.tone = '先给依据，再说结论';
  detailed.settings.retention.answerLength = '详细展开';
  const detailedTask = finish(begin(detailed).data).tasks[0];
  assert.match(detailedTask.artifacts[0].body[0], /^本次允许的资料/);
  assert.match(text(detailedTask), /逐项核对路径/);
  assert.ok(text(detailedTask).length > body.length);
});

test('reply tone changes the actual greeting while keeping factual questions and sending review separate', () => {
  const direct = fixture('回复草稿'); direct.settings.tone = '直接，先结论';
  const warm = fixture('回复草稿'); warm.settings.tone = '自然温和';
  const directText = text(finish(begin(direct).data).tasks[0]);
  const warmText = text(finish(begin(warm).data).tasks[0]);
  assert.match(directText, /^关于/);
  assert.match(warmText, /^你好，想和你确认/);
  assert.match(directText, /发送须另外核对/);
  assert.match(warmText, /发送须另外核对/);
});

test('preference changes, personalization on/off, scope edits and source changes stop delayed output without charging', () => {
  for (const change of [
    data => { data.settings.retention.avoid = '新的个人边界'; return data; },
    data => personal.setPersonalizationEnabled(data, false),
    data => personal.setPersonalContextScope(data, 'preferences', ['会议']),
    data => { data.memories[0].body = '这项背景已修订'; return data; },
    data => { data.memories[0].confirmed = false; return data; },
    data => { data.tasks[0].scope.personalContextExcludedIds = ['own-background']; return data; },
  ]) {
    const changed = change(begin(fixture()).data), stopped = finish(changed).tasks[0];
    assert.equal(stopped.aiStatus, '待授权');
    assert.equal(stopped.authorized, false);
    assert.equal(stopped.generationToken, undefined);
    assert.equal(stopped.artifacts, undefined);
    assert.equal(stopped.used || 0, 0);
  }
  const disabled = personal.setPersonalizationEnabled(fixture(), false);
  const started = begin(disabled).data;
  assert.equal(started.tasks[0].generationSnapshot.personalContext.enabled, false);
  const reenabled = personal.setPersonalizationEnabled(started, true);
  assert.equal(finish(reenabled).tasks[0].aiStatus, '待授权');
});

test('excluded personal entries stay out of the output and an unrelated unconfirmed memory never becomes an input', () => {
  const data = fixture();
  data.tasks[0].scope.personalContextExcludedIds = ['own-background', 'my-profile:preferences'];
  data.memories.push({ ...data.memories[0], id: 'candidate', body: '不可读取的候选', confirmed: false });
  const started = begin(data), snapshot = started.data.tasks[0].generationSnapshot;
  assert.equal(snapshot.personalContext.preferences, undefined);
  assert.ok(!snapshot.personalContext.entries.some(entry => ['own-background', 'candidate'].includes(entry.id)));
  assert.ok(!snapshot.sourceRefs.some(ref => ref.kind === 'memory' && ['own-background', 'candidate'].includes(ref.id)));
  const output = text(finish(started.data).tasks[0]);
  assert.doesNotMatch(output, /组织首版试用|不可读取的候选|本次关注/);
  assert.ok(output.indexOf('交互观察') < output.indexOf('成本依据'));
});

test('team task bindings exclude private context even in a personal view, and a new team binding stops pending private work', () => {
  const data = fixture();
  data.settings.retention['task-space:personal-draft'] = 'Oops 产品团队';
  const started = begin(data);
  assert.equal(started.error, undefined);
  assert.equal(started.data.tasks[0].generationSnapshot.personalContext.enabled, false);
  assert.deepEqual(started.data.tasks[0].generationSnapshot.personalContext.sources, []);
  assert.doesNotMatch(text(finish(started.data).tasks[0]), /产品负责人|组织首版试用|个人边界|本次关注/);

  const privateWork = begin(fixture()).data;
  privateWork.settings.retention['task-space:personal-draft'] = 'Oops 产品团队';
  assert.equal(finish(privateWork).tasks[0].aiStatus, '待授权');
});

test('completed personalized artifacts retain their sources and lose current delivery eligibility after a preference edit', () => {
  const generated = finish(begin(fixture()).data), artifact = generated.tasks[0].artifacts[0];
  assert.equal(access.provenanceAvailable(generated, artifact.sources), true);
  generated.settings.retention.focus = '现在优先看交互';
  assert.equal(access.provenanceAvailable(generated, artifact.sources), false);
  assert.match(artifact.body.join('\n'), /降低成本/);
  assert.doesNotMatch(artifact.body.join('\n'), /现在优先看交互/);
});

test('queued work freezes context, binds consent to it, and cannot recover after personal context changes', () => {
  const data = fixture(), task = data.tasks[0], before = structuredClone(data);
  const consent = work.assistantWorkConsentKey(data, task, 'report', 'offline');
  const started = work.startAssistantWorkPreview(data, task.id, work.initialAssistantWorkPreview('report', 'offline'), { read: true, draft: true }, 'queued-one').state;
  assert.equal(started.stage, 'queued');
  assert.equal(started.personalContext.scenario, '汇报');
  assert.ok(started.sources.some(ref => ref.kind === 'memory' && ref.id === 'own-background'));
  assert.deepEqual(data, before);
  const disabled = personal.setPersonalizationEnabled(data, false);
  assert.notEqual(work.assistantWorkConsentKey(disabled, task, 'report', 'offline'), consent);
  const late = work.advanceAssistantWorkPreview(disabled, started, 'online', 'queued-one');
  assert.equal(late.stage, 'revoked');
  assert.equal(late.authorized, false);
  assert.equal(late.requestId, 'queued-one');
  assert.equal(data.tasks[0].aiStatus, '未启动');
});

test('research uses its own allowed scenario and never receives preferences restricted to report writing', () => {
  const scoped = personal.setPersonalContextScope(fixture(), 'preferences', ['汇报']);
  const task = scoped.tasks[0];
  const research = work.startAssistantWorkPreview(scoped, task.id, work.initialAssistantWorkPreview('research'), { read: true, draft: true }, 'research-one').state;
  assert.equal(research.personalContext.scenario, '研究');
  assert.equal(research.personalContext.preferences, undefined);
  const report = work.startAssistantWorkPreview(scoped, task.id, work.initialAssistantWorkPreview('report'), { read: true, draft: true }, 'report-one').state;
  assert.equal(report.personalContext.preferences.focus, '降低成本');
});
