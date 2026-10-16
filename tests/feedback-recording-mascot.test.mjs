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
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleUrl = path => new URL(path, import.meta.url).href;
const load = code => import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code, { mode: 'strip' })).toString('base64'));
const store = read('../src/store.tsx');
const { initialData } = await load(store.slice(store.indexOf('export function initialData')));
const home = read('../src/features/Home.tsx');
const { homeMascotPresentation } = await load(`import {activeHomeRecording,homeAssistantWork} from '${moduleUrl('../src/feedbackPresentation.ts')}'; import {taskSourceAvailable,taskVisible} from '${moduleUrl('../src/sourceAccess.ts')}'; import {taskBelongsToMe} from '${moduleUrl('../src/taskWorkflow.ts')}';` + home.slice(home.indexOf('export function homeMascotPresentation'), home.indexOf('function HomeMascot')));
const controls = read('../src/features/RecordingControls.tsx');
const { recordingControlContext } = await load(controls.slice(controls.indexOf('export function recordingControlContext'), controls.indexOf('export function RecordingControls')));

function empty() {
  const data = initialData();
  data.tasks = []; data.memories = []; data.activeSessionId = undefined;
  return data;
}
function task(data, aiStatus, patch = {}) {
  const base = initialData().tasks[0];
  const value = { ...base, id: 'mascot-task', status: '进行中', aiStatus, sourceSession: undefined, sourceTime: undefined, sourceId: undefined, sources: [], ...patch };
  data.tasks.push(value);
  return value;
}

test('only the active record scene has full controls, while tabs and other sessions stay compact', () => {
  const scene = { view: 'session-detail', id: 'one' };
  assert.equal(recordingControlContext('one', '我的空间', scene, '现场').onsite, true);
  assert.equal(recordingControlContext('one', '我的空间', scene, '概览').onsite, true);
  for (const tab of ['原文', '资料', '行动']) assert.equal(recordingControlContext('one', '我的空间', scene, tab).onsite, false);
  assert.equal(recordingControlContext('two', '我的空间', scene, '现场').onsite, false);
  assert.equal(recordingControlContext('one', '我的空间', { view: 'session-transcript', id: 'one' }, '现场').onsite, false);
  assert.equal(recordingControlContext(undefined, '我的空间', scene, '现场').onsite, false);
});

test('expanded control identity cannot carry to another route, recording, tab or space', () => {
  const context = (id, space, route, tab = '现场') => recordingControlContext(id, space, route, tab).key;
  const route = { view: 'tasks' };
  const original = context('one', '我的空间', route);
  for (const next of [context('two', '我的空间', route), context('one', '团队', route), context('one', '我的空间', { view: 'memory' }), context('one', '我的空间', { view: 'tasks', mode: '我的待办' }), context('one', '我的空间', route, '行动')]) assert.notEqual(next, original);
});

test('mascot listening reflects visible active capture and stops when paused or ended', () => {
  const data = empty(), session = data.sessions[0];
  session.status = '进行中'; data.activeSessionId = session.id;
  task(data, '准备中');
  assert.equal(homeMascotPresentation(data).state, 'listening');
  session.status = '暂停';
  assert.deepEqual(homeMascotPresentation(data), { state: 'idle', label: '记录已暂停' });
  session.status = '已结束';
  assert.equal(homeMascotPresentation(data).state, 'thinking');
});

test('native active capture never inherits the website sample-recording label', () => {
  const data = empty(), session = data.sessions[0];
  session.status = '进行中'; data.activeSessionId = session.id;
  assert.equal(homeMascotPresentation(data, 0, true).label, '正在记录');
  assert.equal(homeMascotPresentation(data).label, '示例记录中');
  session.status = '暂停';
  assert.equal(homeMascotPresentation(data, 0, true).label, '记录已暂停');
});

test('mascot does not expose a hidden recording, archived recording or another persons work', () => {
  const data = empty(), session = data.sessions[0];
  session.status = '进行中'; data.activeSessionId = session.id;
  data.settings.space = 'Oops 产品团队';
  assert.equal(homeMascotPresentation(data).state, 'idle');
  data.settings.space = '我的空间'; session.archived = true;
  task(data, '失败', { ownerPersonId: 'another-person' });
  assert.equal(homeMascotPresentation(data).state, 'idle');
});

test('thinking and failed are grounded in current unfinished work, with stale sources awaiting review', () => {
  const data = empty(), item = task(data, '准备中');
  assert.equal(homeMascotPresentation(data).state, 'thinking');
  item.aiStatus = '失败';
  assert.equal(homeMascotPresentation(data).state, 'failed');
  item.sourceNeedsReview = true;
  assert.equal(homeMascotPresentation(data).state, 'review');
  item.status = '已完成';
  assert.equal(homeMascotPresentation(data).state, 'idle');
});

test('review reflects pending memory or a draft requiring review, while accepted content returns idle', () => {
  const data = empty(), item = task(data, '草稿完成', { needsReview: true });
  assert.equal(homeMascotPresentation(data).state, 'review');
  item.needsReview = false;
  assert.equal(homeMascotPresentation(data).state, 'idle');
  assert.equal(homeMascotPresentation(data, 1).state, 'review');
  assert.equal(homeMascotPresentation(data, 0).state, 'idle');
});
