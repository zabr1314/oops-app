import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(url.pathname)) for (const ext of ['.ts', '.tsx']) if (existsSync(new URL(url.href + ext))) return next(url.href + ext, context);
  }
  return next(specifier, context);
} });
const { beginGeneration, taskPersonalContext } = await import('../src/taskWorkflow.ts');

// Execute the actual nested UI submission function with its captured view state.
// This exercises the configuration step before beginGeneration, where scope can be lost.
const source = readFileSync(new URL('../src/features/Tasks.tsx', import.meta.url), 'utf8');
const setupStart = source.indexOf('function AssistantSetup(');
const configuredStart = source.indexOf('  function configured(', setupStart);
const configuredEnd = source.indexOf('\n  function save(', configuredStart);
assert.ok(setupStart >= 0 && configuredStart > setupStart && configuredEnd > configuredStart, 'AssistantSetup configuration function must be available');
const declarations = ['closed', 'accepted', 'stamp'].map(name => source.match(new RegExp('^const ' + name + ' = .*$', 'm'))?.[0]);
assert.ok(declarations.every(Boolean), 'use the real status and activity helpers');
const factorySource = stripTypeScriptTypes(`function factory(beginGeneration) {
${declarations.join('\n')}
return function configure(current, view, startNow = true, token = 'ui-personal-request') {
  const { task: t, mode, limit, includeSource, ids, personalExcluded } = view;
  const refs = t.materialRefs || [], selected = refs.filter(material => ids.includes(material.id));
  ${source.slice(configuredStart, configuredEnd)}
  return configured(current, startNow, token);
};
}`, { mode: 'strip' });
const makeConfigure = new Function(`return (${factorySource});`)();
const configure = makeConfigure(beginGeneration);

function fixture(space = '我的空间') {
  return {
    sessions: [], people: [], projects: [], receipts: [], messages: [], notifications: [], recallCleared: false,
    tasks: [{ id: 'ui-draft', title: '准备首版汇报', description: '只使用本人填写的要求。', owner: '我', requester: '我',
      due: '', priority: '中', status: '已承接', aiStatus: '未启动', workKind: '交付', outputMode: '文档', activities: [], results: [], version: 1,
      scope: { sources: '本人要求', destination: '个人草稿', space, includeSource: false, materialIds: [] } }],
    memories: [{ id: 'private-background', title: '私人背景', body: '本次先验证首版。', category: '记忆', tags: ['角色背景'], visibility: '私有', updated: '今天', confirmed: true }],
    settings: { name: '本人', role: '产品负责人', space: '我的空间', tone: '先说结论', avatar: '', toggles: {}, connections: {}, devices: {},
      retention: { answerLength: '简短', focus: '首版验证' } },
  };
}
const view = data => ({ task: data.tasks[0], mode: '文档', limit: '40', includeSource: false, ids: [], personalExcluded: [] });

test('the actual setup submission preserves a team binding stored only in scope.space and never adds private context', () => {
  const data = fixture('Oops 产品团队'), original = structuredClone(data);
  assert.equal(data.settings.retention['task-space:ui-draft'], undefined);
  assert.equal(taskPersonalContext(data, data.tasks[0]).enabled, false);
  const result = configure(data, view(data));
  assert.equal(result.error, undefined);
  const task = result.data.tasks[0];
  assert.equal(task.scope.space, 'Oops 产品团队');
  assert.equal(task.generationSnapshot.space, 'Oops 产品团队');
  assert.equal(task.generationSnapshot.personalContext.enabled, false);
  assert.deepEqual(task.generationSnapshot.personalContext.entries, []);
  assert.deepEqual(task.generationSnapshot.personalContext.sources, []);
  assert.ok(!task.generationSnapshot.sourceRefs.some(ref => ref.kind === 'profile' || ref.id === 'private-background'));
  assert.deepEqual(data, original);
});

test('saving setup without starting also preserves a scope-only team binding', () => {
  const data = fixture('Oops 产品团队'), result = configure(data, view(data), false);
  assert.equal(result.error, undefined);
  assert.equal(result.data.tasks[0].scope.space, 'Oops 产品团队');
  assert.equal(result.data.tasks[0].generationSnapshot, undefined);
  assert.equal(result.data.tasks[0].authorized, false);
});

test('a team assignment arriving after render is respected by the current submission instead of stale captured scope', () => {
  const rendered = fixture(), captured = view(rendered), current = structuredClone(rendered);
  current.tasks[0].scope.space = 'Oops 产品团队';
  const result = configure(current, captured);
  assert.equal(result.error, undefined);
  assert.equal(result.data.tasks[0].scope.space, 'Oops 产品团队');
  assert.equal(result.data.tasks[0].generationSnapshot.personalContext.enabled, false);
});

test('personal setup keeps private context available and freezes the exact per-request exclusions', () => {
  const data = fixture(), captured = { ...view(data), personalExcluded: ['private-background'] };
  const result = configure(data, captured);
  assert.equal(result.error, undefined);
  const snapshot = result.data.tasks[0].generationSnapshot;
  assert.equal(snapshot.space, '我的空间');
  assert.equal(snapshot.personalContext.enabled, true);
  assert.deepEqual(snapshot.personalContext.excludedIds, ['private-background']);
  assert.equal(snapshot.personalContext.preferences.answerLength, '简短');
  assert.ok(!snapshot.personalContext.entries.some(entry => entry.id === 'private-background'));
  assert.ok(snapshot.sourceRefs.some(ref => ref.kind === 'profile' && ref.profileScope === 'preferences'));
});
