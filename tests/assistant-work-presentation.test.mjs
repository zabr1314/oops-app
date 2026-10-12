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
const work = await import('../src/assistantWorkPresentation.ts');
const access = await import('../src/sourceAccess.ts');
const store = readFileSync(new URL('../src/store.tsx', import.meta.url), 'utf8');
const seed = stripTypeScriptTypes(store.slice(store.indexOf('export function initialData')), { mode: 'strip' });
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(seed).toString('base64'));
function example(patch = {}) {
  const data = initialData();
  const task = { id: 'work-example', title: '整理试用观察', description: '区分观察与未核实想法', owner: '我', requester: '王宁', due: '', priority: '中', status: '已承接', aiStatus: '未启动', activities: [], results: [], version: 1, scope: { sources: '本人要求与所选资料', destination: '个人草稿', includeSource: false, materialIds: ['one'] }, materialRefs: [{ id: 'one', title: '走查观察', body: '同伴希望先看到正文。' }, { id: 'two', title: '未选择资料', body: '不要读取。' }], ...patch };
  data.tasks = [task]; return { data, task };
}
const permissions = { read: true, draft: true };
function start(data, task, scenario = 'normal', kind = 'report') {
  return work.startAssistantWorkPreview(data, task.id, work.initialAssistantWorkPreview(kind, scenario), permissions, 'request-one').state;
}
function receipt(data, task, patch = {}) {
  const sources = task.scope?.includeSource !== false && task.sourceSession ? [access.makeSourceReference(data, { kind: 'session', id: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime })] : [];
  return { source: 'server', taskId: task.id, sessionId: task.sourceSession, jobId: 'job-example', space: data.settings.space, kind: 'report', fingerprint: work.assistantWorkFingerprint(task), sources, docUrl: 'https://example.feishu.cn/docx/unit_test_document', files: [], ...patch };
}

test('existing worker types describe real research/report/ppt capabilities without promising arbitrary execution', () => {
  assert.deepEqual(work.ASSISTANT_WORK_CHOICES.map(choice => choice.kind), ['research', 'report', 'ppt']);
  assert.match(work.ASSISTANT_WORK_CHOICES.find(choice => choice.kind === 'ppt').output, /PPTX/);
  assert.equal(work.assistantWorkKind('python'), 'report');
  assert.equal(work.initialAssistantWorkPreview().authorized, false);
});
test('starting a preview requires separate read and private draft consent and never changes task data', () => {
  const { data, task } = example(), before = structuredClone(data), initial = work.initialAssistantWorkPreview();
  assert.match(work.startAssistantWorkPreview(data, task.id, initial, { read: true, draft: false }, 'r').error, /分别/);
  const result = work.startAssistantWorkPreview(data, task.id, initial, permissions, 'r');
  assert.equal(result.state.stage, 'preparing'); assert.equal(result.state.authorized, true);
  assert.deepEqual(data, before); assert.equal(task.authorized, undefined); assert.equal(data.receipts.length, 0);
});
test('offline work keeps one request and resumes without re-authorizing or duplicate starts', () => {
  const { data, task } = example(), queued = start(data, task, 'offline');
  assert.equal(queued.stage, 'queued');
  const duplicate = work.startAssistantWorkPreview(data, task.id, queued, permissions, 'request-two');
  assert.equal(duplicate.state.requestId, 'request-one'); assert.match(duplicate.error, /重复/);
  const running = work.advanceAssistantWorkPreview(data, queued, 'online', 'request-one');
  assert.equal(running.stage, 'preparing'); assert.equal(running.requestId, queued.requestId);
  const ready = work.advanceAssistantWorkPreview(data, running, 'result', 'request-one');
  assert.equal(ready.stage, 'ready'); assert.equal(task.status, '已承接'); assert.equal(task.aiStatus, '未启动');
});
test('generation failure permits a new explicitly consented attempt while retaining existing artifacts', () => {
  const { data, task } = example({ artifacts: [{ id: 'kept', kind: '文档', title: '旧稿', body: ['KEEP'], version: 1, created: '今天' }] });
  const failed = work.advanceAssistantWorkPreview(data, start(data, task, 'generation-failure'), 'result', 'request-one');
  assert.equal(failed.stage, 'generation-failed');
  assert.match(work.startAssistantWorkPreview(data, task.id, failed, { read: false, draft: true }, 'request-two').error, /分别/);
  const retried = work.startAssistantWorkPreview(data, task.id, failed, permissions, 'request-two');
  assert.equal(retried.state.stage, 'preparing'); assert.equal(retried.state.requestId, 'request-two');
  assert.deepEqual(task.artifacts[0].body, ['KEEP']);
});
test('delivery failure reads the same existing result and cannot become a second generation or send receipt', () => {
  const { data, task } = example(), before = structuredClone(data);
  const failed = work.advanceAssistantWorkPreview(data, start(data, task, 'delivery-failure'), 'result', 'request-one');
  assert.equal(failed.stage, 'delivery-failed');
  const recovered = work.advanceAssistantWorkPreview(data, failed, 'recover-result', 'request-one');
  assert.equal(recovered.stage, 'ready'); assert.equal(recovered.requestId, failed.requestId);
  assert.equal(work.advanceAssistantWorkPreview(data, recovered, 'recover-result', 'request-one'), recovered);
  assert.match(work.startAssistantWorkPreview(data, task.id, recovered, permissions, 'request-one').error, /重复/);
  assert.deepEqual(data, before);
});
test('a late response for another request cannot advance the current work', () => {
  const { data, task } = example(), running = start(data, task);
  assert.equal(work.advanceAssistantWorkPreview(data, running, 'result', 'old-request'), running);
});
test('changing selected material content revokes permission and blocks recovery from a late response', () => {
  const { data, task } = example(), running = start(data, task);
  task.materialRefs[0].body = '已经修订，不能继续用旧快照';
  const revoked = work.advanceAssistantWorkPreview(data, running, 'result', 'request-one');
  assert.equal(revoked.stage, 'revoked'); assert.equal(revoked.authorized, false);
  assert.match(revoked.message, /重新核对/);
});
test('unselected material changes do not expand the original input or cancel selected work', () => {
  const { data, task } = example(), running = start(data, task);
  task.materialRefs[1].body = '未选择资料的修改';
  assert.equal(work.validateAssistantWorkPreview(data, running), running);
  assert.equal(work.advanceAssistantWorkPreview(data, running, 'result', 'request-one').stage, 'ready');
});
test('removed selected IDs, closed work, another owner and unaccepted work are rejected', () => {
  for (const patch of [{ scope: { sources: '缺失', destination: '个人草稿', materialIds: ['missing'] } }, { status: '已完成' }, { owner: 'Alex' }, { status: '待承接' }]) {
    const { data, task } = example(patch);
    const result = work.startAssistantWorkPreview(data, task.id, work.initialAssistantWorkPreview(), permissions, 'r');
    assert.ok(result.error); assert.equal(result.state.authorized, false);
  }
});
test('selected original speech changes revoke pending work and whole meeting references cannot replace a chosen turn', () => {
  const data = initialData(), task = data.tasks[0]; task.status = '已承接'; task.scope = { sources: '选中的原话', destination: '个人草稿', includeSource: true, materialIds: [] };
  const running = start(data, task), turn = access.sourceTurn(data, task); turn.text = '修订后的原话';
  assert.equal(work.validateAssistantWorkPreview(data, running).stage, 'revoked');
  delete task.sourceId; delete task.sourceTime;
  assert.match(work.startAssistantWorkPreview(data, task.id, work.initialAssistantWorkPreview(), permissions, 'new').error, /整场会议/);
});
test('space changes and stopping revoke the preview without changing task authorization or business status', () => {
  const { data, task } = example({ authorized: true }), running = start(data, task);
  data.settings.space = '另一个空间';
  assert.equal(work.validateAssistantWorkPreview(data, running).authorized, false);
  const cancelled = work.cancelAssistantWorkPreview(running);
  assert.equal(cancelled.stage, 'cancelled'); assert.equal(cancelled.authorized, false);
  assert.equal(work.advanceAssistantWorkPreview(data, cancelled, 'result', 'request-one'), cancelled);
  assert.equal(task.authorized, true); assert.equal(task.status, '已承接');
});
test('missing remote receipts never manufacture documents, file URLs or completed delivery', () => {
  const { data, task } = example();
  assert.deepEqual(work.existingAssistantResult(data, task), { status: 'absent', files: [] });
});
test('only explicit bound document links and allowlisted file origins become usable', () => {
  const { data, task } = example(), result = receipt(data, task, { files: [{ name: '实际文件.pptx', bytes: 2048, url: 'https://giftedprofessor.xyz/oops-meeting/files/unit-test' }, { name: '只有文件名.pptx' }, { name: '外站', url: 'https://untrusted.example/file' }] });
  const view = work.existingAssistantResult(data, task, result, ['https://giftedprofessor.xyz']);
  assert.equal(view.status, 'current'); assert.equal(view.docUrl, result.docUrl);
  assert.equal(view.files[0].url, result.files[0].url); assert.equal(view.files[0].bytes, 2048);
  assert.equal(view.files[1].url, undefined); assert.equal(view.files[2].url, undefined);
});
test('unsafe links and credentials in URLs are not exposed as document or file actions', () => {
  const { data, task } = example();
  for (const docUrl of ['javascript:alert(1)', 'http://example.feishu.cn/docx/id', 'https://feishu.cn.evil.example/docx/id', 'https://me:secret@example.feishu.cn/docx/id', 'https://example.feishu.cn/docx/id?access_token=secret']) {
    assert.equal(work.existingAssistantResult(data, task, receipt(data, task, { docUrl })).docUrl, undefined);
  }
});
test('source changes retain a personal history document but withdraw files, while another task or space is blocked', () => {
  const { data, task } = example(), result = receipt(data, task, { files: [{ name: '文件', url: 'https://giftedprofessor.xyz/file' }] });
  task.materialRefs[0].body = '新资料';
  const history = work.existingAssistantResult(data, task, result, ['https://giftedprofessor.xyz']);
  assert.equal(history.status, 'historical'); assert.equal(history.docUrl, result.docUrl); assert.deepEqual(history.files, []);
  assert.equal(work.existingAssistantResult(data, task, { ...result, taskId: 'another' }).status, 'blocked');
  data.settings.space = '团队';
  assert.equal(work.existingAssistantResult(data, task, result).status, 'blocked');
});
test('a receipt omitting required source snapshots cannot present current results', () => {
  const data = initialData(), task = data.tasks[0]; task.scope = { sources: '任务原话', destination: '个人草稿', includeSource: true, materialIds: [] };
  const valid = receipt(data, task);
  assert.equal(work.existingAssistantResult(data, task, valid).status, 'current');
  assert.equal(work.existingAssistantResult(data, task, { ...valid, sources: [] }).status, 'historical');
});
test('consent attaches to the exact task inputs, service kind, scenario and space before a request starts', () => {
  const { data, task } = example(), original = work.assistantWorkConsentKey(data, task, 'report', 'normal');
  assert.notEqual(work.assistantWorkConsentKey(data, task, 'ppt', 'normal'), original);
  assert.notEqual(work.assistantWorkConsentKey(data, task, 'report', 'offline'), original);
  task.materialRefs[1].body = '不选的材料变化';
  assert.equal(work.assistantWorkConsentKey(data, task, 'report', 'normal'), original);
  task.materialRefs[0].body = '被选择的材料变化';
  assert.notEqual(work.assistantWorkConsentKey(data, task, 'report', 'normal'), original);
});
