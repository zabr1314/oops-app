'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function ui() {
  const elements = new Map(), errors = [], messages = [];
  function el(id) {
    if (!elements.has(id)) elements.set(id, {id, dataset: {}, children: [], style: {setProperty() {}},
      classList: {toggle() {}, add() {}, remove() {}}, setAttribute() {}, appendChild() {}, insertBefore(child) {this.children.push(child);},
      querySelectorAll: () => [], listeners: {}, addEventListener(type, fn) {(this.listeners[type] ||= []).push(fn);}});
    return elements.get(id);
  }
  const native = {postMessage(raw) {messages.push(JSON.parse(raw));}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../main/assets/web/app.js'), 'utf8'), {
    window: {OopsNative: native}, location: {search: ''}, URLSearchParams,
    document: {getElementById: el, createElement: () => el(Symbol('node')), querySelectorAll: () => [], documentElement: {dataset: {}}},
    console: {...console, error(error) {errors.push(error);}}, setTimeout: () => 1, clearTimeout() {},
  });
  const receive = (type, payload) => native.onmessage({data: JSON.stringify({type, payload})});
  const click = (act, data = {}, sheet = false) => el(sheet ? 'sheet' : 'root').listeners.click.forEach(fn => fn({stopPropagation() {},
    target: {closest(selector) {return selector === '#sheet' ? null : {dataset: {act, ...data}};}}}));
  receive('snapshot', {state: {capturing: false, selfName: 'Alice'}, team: ['Alice', 'Bob'], transcript: []});
  return {el, receive, click, messages, errors, screen: () => el('screen').innerHTML, sheet: () => el('sheet').innerHTML,
    sheetOpen: () => !el('sheet').hidden,
    last: type => messages.filter(x => x.type === type).at(-1)?.payload};
}

const ev = (id, text, s) => ({id, text, start_ms: s, end_ms: s + 900, speaker: null});
const item = (id, kind, title, extra = {}) => ({id, kind, title, ids: [id + '-u'], fingerprint: 'fp-' + id, review: null, stale: false,
  evidence: [ev(id + '-u', '原话 ' + title, 1000)], ...extra});
const meeting = (items) => ({session_id: 's1', title: '产品评审', started_at: '2026-10-12T00:00:00Z', ended_at: '2026-10-12T01:00:00Z',
  items, review_queue: items.filter(i => !i.review && !i.stale).map(i => ({kind: 'item', id: i.id, item_kind: i.kind})),
  utterances: [{id: 'x1', text: '大家好', start_ms: 0, end_ms: 500, tag: 'decision'}],
  digest: {decision: [{id: 'x1', text: '大家好', tag: 'decision', start_ms: 0}], constraint: [], commitment: []}});
const ITEMS = () => [item('a', 'task', '问对接人是否两人一间', {owner_hint: 'Bob', due: ''}), item('b', 'decision', 'P0 先把 App 跑通'),
  item('c', 'open', '固定设备是否要和录音豆结合？', {detail: '一方要结合，一方认为冲突'})];
function open(u, items = ITEMS()) { u.click('review-start', {id: 's1'}); u.receive('history.open', meeting(items)); return items; }

test('with minutes items the review is one thing at a time, not sentences', () => {
  const u = ui(); open(u);
  assert.match(u.sheet(), /问对接人是否两人一间/);
  assert.match(u.sheet(), /待办/);
  assert.match(u.sheet(), /原话里有人认领：Bob/);
  assert.doesNotMatch(u.sheet(), /chip selected/);  // the claimed name is a hint, never pre-selected
  assert.doesNotMatch(u.sheet(), /这句是谁说的/);
  assert.equal(u.errors.length, 0);
});

test('a task needs an owner, then the confirm carries item id, fingerprint and owner', () => {
  const u = ui(); open(u);
  u.click('item-confirm', {}, true);
  assert.equal(u.last('items.review'), undefined);
  u.click('item-owner', {name: '大家'}, true);
  u.click('item-confirm', {}, true);
  assert.deepEqual(u.last('items.review'), {sessionId: 's1', itemId: 'a', fingerprint: 'fp-a', action: 'confirm', owner: '大家'});
  const saved = ITEMS(); saved[0].review = {status: 'confirmed', kind: 'task', title: saved[0].title, owner: '大家', due: ''};
  u.receive('items.saved', {sessionId: 's1', itemId: 'a', items: saved, review_queue: [{kind: 'item', id: 'b'}, {kind: 'item', id: 'c'}]});
  assert.match(u.sheet(), /P0 先把 App 跑通/);  // moved on to the next one still to check
});

test('reject, merge and rewrite send their own actions', () => {
  const u = ui(); open(u);
  u.click('item-next', {}, true);
  u.click('item-reject', {}, true);
  assert.equal(u.last('items.review').action, 'reject');
  assert.equal(u.last('items.review').itemId, 'b');
  u.receive('error', {scope: 'items', sessionId: 's1', itemId: 'b', message: '网络未连接'});
  assert.match(u.sheet(), /网络未连接/);
  u.click('item-retry', {}, true);
  assert.equal(u.messages.filter(m => m.type === 'items.review').length, 2);
  const saved = ITEMS(); saved[1].review = {status: 'rejected'};
  u.receive('items.saved', {sessionId: 's1', itemId: 'b', items: saved, review_queue: []});
  assert.match(u.sheet(), /固定设备是否要和录音豆结合/);
  u.el('sheet').listeners.change.forEach(fn => fn({target: {id: 'item-merge', value: 'a'}}));
  assert.deepEqual([u.last('items.review').action, u.last('items.review').into], ['merge', 'a']);
});

test('rewriting keeps the typed title and confirms with the edited fields', () => {
  const u = ui(); open(u);
  u.click('item-next', {}, true);
  u.click('item-edit', {}, true);
  u.el('item-title').value = 'P0：先把 App 跑通，硬件后放';
  u.el('item-due').value = '比赛前';
  u.click('item-save', {}, true);
  assert.deepEqual(u.last('items.review'), {sessionId: 's1', itemId: 'b', fingerprint: 'fp-b', action: 'confirm', kind: 'decision',
    title: 'P0：先把 App 跑通，硬件后放', due: '比赛前'});
});

test('stale items are read-only and the overview lists items instead of sentence candidates', () => {
  const u = ui();
  const items = ITEMS().map(i => ({...i, stale: true}));
  u.click('review-start', {id: 's1'}); u.receive('history.open', meeting(items));
  assert.match(u.sheet(), /只能查看/);
  assert.doesNotMatch(u.sheet(), /确认这件事/);
  const fresh = ui(); fresh.click('meeting-open', {id: 's1'}); fresh.receive('history.open', meeting(ITEMS()));
  assert.match(fresh.screen(), /会后事项/);
  assert.match(fresh.screen(), /还没定的事/);
  assert.doesNotMatch(fresh.screen(), /Oops 整理出的候选/);
  assert.equal(fresh.errors.length, 0);
});


test('board review candidates remain separate from executable tasks and retain original source', () => {
  const u = ui();
  u.receive('state', {capturing: true, recordingMode: 'meeting', sessionId: 'quality-session', selfName: 'Alice'});
  u.click('go', {route: 'live'});
  u.receive('tasks.board', {session_id: 'quality-session', pending: false, tasks: [], review_queue: [
    {id: 't1', what: '将代码叠出一百版', sources: ['u3', 'u4'], status: 'needs_review',
     quality: {status: 'needs_review', reason: 'quantity_ambiguity', issues: ['原话数字需回听核对']}}
  ]});
  u.click('tab', {tab: 'actions'});
  assert.match(u.screen(), /原话待核对 1 条/);
  assert.match(u.screen(), /以下内容尚未作为任务/);
  assert.match(u.screen(), /本场任务清单 0/);
  assert.match(u.screen(), /data-id="u4"/);
  assert.equal(u.messages.filter(x => x.type === 'action.confirm').length, 0);
  assert.equal(u.errors.length, 0);
});

test('incomplete ASR is visible after meeting sync even if item queue is empty', () => {
  const u = ui();
  u.click('meeting-open', {id: 's1'});
  u.receive('history.open', {...meeting([]), asr_closure: 'incomplete'});
  assert.match(u.screen(), /转写结束未确认/);
  assert.match(u.screen(), /转写可能不完整/);
  assert.doesNotMatch(u.screen(), /已保存 · 已核对/);
});
