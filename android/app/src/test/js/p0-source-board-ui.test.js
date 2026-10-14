'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const directory = path.resolve(__dirname, '../../main/assets/web');

function ui() {
  const nodes = new Map(), messages = [], errors = [];
  function el(id) {
    if (!nodes.has(id)) nodes.set(id, {id, value: '', dataset: {}, children: [], style: {setProperty() {}},
      classList: {toggle() {}, add() {}, remove() {}}, setAttribute() {}, appendChild() {}, insertBefore() {},
      querySelectorAll: () => [], listeners: {}, addEventListener(type, fn) {(this.listeners[type] ||= []).push(fn);}});
    return nodes.get(id);
  }
  const native = {postMessage(raw) {messages.push(JSON.parse(raw));}};
  const context = {window: {OopsNative: native, addEventListener() {}}, location: {search: ''}, URLSearchParams,
    document: {addEventListener() {}, getElementById: el, createElement: () => el(Symbol()), querySelectorAll: () => [], documentElement: {dataset: {}}},
    console: {...console, error(e) {errors.push(e);}}, setTimeout: () => 1, clearTimeout() {}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(directory, 'draft-state.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(directory, 'app.js'), 'utf8'), context);
  const receive = (type, payload) => native.onmessage({data: JSON.stringify({type, payload})});
  const click = (act, data = {}, sheet = false) => el(sheet ? 'sheet' : 'root').listeners.click.forEach(fn => fn({stopPropagation() {},
    target: {closest(selector) {return selector === '#sheet' ? null : {dataset: {act, ...data}};}}}));
  receive('snapshot', {state: {capturing:true,sessionId:'s1',recordingMode:'meeting',backend:'http',backendUrl:'current',boardSourceRevision:0},transcript:[],team:['Alice']});
  return {el, messages, errors, receive, click, sheet: () => el('sheet').innerHTML, screen: () => el('screen').innerHTML,
    actions() {click('go', {route:'live'});click('tab', {tab:'actions'});},
    confirm() {el('f-who').value='Alice';el('f-what').value='核对预算';el('f-when').value='';el('f-constraint').value='';click('confirm', {}, true);}};
}
const binding = (kind='transcript') => ({version:1,session_id:'s1',sources:[{id:'u1',kind,text_hash:'a'.repeat(64),source_revision:'server-r1',quote:'周五核对预算'}]});
const draft = (b=binding()) => ({draftId:'d1',cardId:'c1',who:'Alice',what:'核对预算',assigneeCandidates:['Alice'],
  evidence:{utteranceIds:['u1'],quote:'周五核对预算',sourceBinding:b}});
const board = (name='当前任务', b=binding()) => ({session_id:'s1',backendUrl:'current',serviceEpoch:1,sourceRevision:0,
  tasks:[{id:'t1',what:name,owner:'Alice',priority:'P0',status:'open',sources:['u1'],source_binding:b}]});

test('unverified source disables new confirmation without discarding editable draft', () => {
  const u=ui();u.receive('action.draft',draft(null));
  assert.match(u.sheet(),/原话依据尚未核验/);assert.match(u.sheet(),/data-act="confirm" disabled/);
  assert.match(u.sheet(),/核对预算/);u.confirm();assert.ok(!u.messages.some(m=>m.type==='action.confirm'));assert.deepEqual(u.errors,[]);
});
test('verified source permits normal task confirmation', () => {
  const u=ui();u.receive('action.draft',draft());u.confirm();
  assert.equal(u.messages.filter(m=>m.type==='action.confirm').length,1);assert.deepEqual(u.errors,[]);
});
test('source excerpt limit counts Unicode characters consistently with the server', () => {
  const u=ui(), b=binding();b.sources[0].quote='😀'.repeat(280);
  const d=draft(b);d.evidence.quote=b.sources[0].quote;u.receive('action.draft',d);u.confirm();
  assert.equal(u.messages.filter(m=>m.type==='action.confirm').length,1);
});
test('malformed or mismatched binding cannot be confirmed', () => {
  for (const mutate of [b=>b.sources[0].id='other',b=>b.sources[0].text_hash='invalid',b=>b.sources[0].source_revision='',b=>b.version=2]) {
    const b=binding();mutate(b);const u=ui();u.receive('action.draft',draft(b));u.confirm();
    assert.ok(!u.messages.some(m=>m.type==='action.confirm'));
  }
});
test('source error blocks a formerly verified token and owner edits cannot bypass it', () => {
  const u=ui();u.receive('action.draft',{...draft(),sourceError:'source_changed'});u.confirm();
  assert.ok(!u.messages.some(m=>m.type==='action.confirm'));
});
test('review change invalidates a draft but keeps entered task text', () => {
  const u=ui();u.receive('action.draft',draft());u.receive('review.saved',{sessionId:'s1',utteranceId:'u1',review:{owner:'Bob'}});
  assert.match(u.sheet(),/核对预算/);assert.match(u.sheet(),/原话依据已变化/);u.confirm();
  assert.ok(!u.messages.some(m=>m.type==='action.confirm'));
});
test('pending external outcome can still be queried even without current evidence', () => {
  const u=ui();u.receive('action.draft',draft(null));u.receive('action.result',{draftId:'d1',opId:'op1',status:'pending',polling:false});
  assert.match(u.sheet(),/data-act="query-action"/);u.click('query-action',{},true);
  assert.ok(u.messages.some(m=>m.type==='action.status'));assert.ok(!u.messages.some(m=>m.type==='action.confirm'));
});
test('definite source conflict does not retry the old operation and offers current source review', () => {
  const u=ui();u.receive('action.draft',draft());u.confirm();
  u.receive('action.result',{draftId:'d1',opId:'op1',status:'failed',sourceInvalidated:true,message:'原话已变化，本次未创建'});
  // The old draft is withdrawn: review goes back to the current sentences instead of re-running the old evidence.
  assert.match(u.sheet(),/重新核对当前原话/);u.confirm();
  assert.equal(u.messages.filter(m=>m.type==='action.confirm').length,1);
  u.click('draft-source-reopen',{},true);
  assert.equal(u.messages.filter(m=>m.type==='action.confirm').length,1);
  assert.equal(u.el('sheet').hidden,true);
});
test('new invalidation revision clears board and rejects older responses on same service', () => {
  const u=ui();u.actions();u.receive('tasks.board',board());assert.match(u.screen(),/当前任务/);
  u.receive('tasks.board',{...board(),sourceRevision:2,tasks:[],invalidated:true});
  u.receive('tasks.board',{...board('不应复活的旧任务'),sourceRevision:1});assert.doesNotMatch(u.screen(),/不应复活的旧任务|当前任务/);
});
test('partial source invalidation does not withdraw an unrelated draft', () => {
  const u=ui();u.receive('action.draft',draft());
  u.receive('tasks.board',{...board(),sourceRevision:2,invalidatedSourceIds:['unrelated']});
  u.confirm();assert.equal(u.messages.filter(m=>m.type==='action.confirm').length,1);
});
test('changed context dependency invalidates a draft without discarding its text', () => {
  const u=ui(), b=binding();b.context_sources=[{...b.sources[0],id:'context1'}];
  u.receive('action.draft',draft(b));u.receive('tasks.board',{...board(),sourceRevision:2,invalidatedSourceIds:['context1']});
  assert.match(u.sheet(),/核对预算/);u.confirm();assert.ok(!u.messages.some(m=>m.type==='action.confirm'));
});
test('malformed context sources cannot bypass source validation', () => {
  const u=ui(), b=binding();b.context_sources=[{...b.sources[0],id:'context1',text_hash:'invalid'}];
  u.receive('action.draft',draft(b));u.confirm();assert.ok(!u.messages.some(m=>m.type==='action.confirm'));
});
test('daily source without a server binding offers private candidates instead of endless reload', () => {
  const u=ui();u.receive('state',{recordingMode:'daily'});u.receive('action.draft',{...draft(null),sourceError:'来源未保存'});
  assert.match(u.sheet(),/当前不能核验并创建飞书任务/);assert.match(u.sheet(),/查看私人候选/);
  assert.doesNotMatch(u.sheet(),/data-act="draft-source-reload"/);u.confirm();assert.ok(!u.messages.some(m=>m.type==='action.confirm'));
});
test('service epoch and backend URL reject stale board replies', () => {
  const u=ui();u.receive('backend.changed',{backend:'http',backendUrl:'current',serviceEpoch:2});u.actions();
  u.receive('tasks.board',board('旧服务任务'));u.receive('tasks.board',{...board('旧地址任务'),serviceEpoch:2,backendUrl:'old'});
  assert.doesNotMatch(u.screen(),/旧服务任务|旧地址任务/);
});
test('natural transcript expiry retains only independently saved source tasks', () => {
  const u=ui();u.actions();u.receive('tasks.board',{...board(),tasks:[...board('全文任务').tasks,...board('独立短依据任务',binding('saved_excerpt')).tasks.map(t=>({...t,id:'t2'}))]});
  u.receive('capture.assetsExpired',{asset:'transcript'});u.actions();
  assert.match(u.screen(),/独立短依据任务/);assert.doesNotMatch(u.screen(),/全文任务/);
});
test('ordinary meeting rolling window does not invalidate archived task evidence', () => {
  const u=ui();u.actions();u.receive('tasks.board',board());u.receive('transcript.pruned',{ids:['u1']});u.actions();
  assert.match(u.screen(),/当前任务/);
});
test('snapshot rejects a board captured from another backend', () => {
  const u=ui();u.receive('snapshot',{state:{capturing:true,sessionId:'s1',recordingMode:'meeting',backend:'http',backendUrl:'current'},transcript:[],team:['Alice'],board:{...board('旧快照'),backendUrl:'old'}});
  u.actions();assert.doesNotMatch(u.screen(),/旧快照/);
});
