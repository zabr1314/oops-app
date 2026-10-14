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
    window: {OopsNative: native, addEventListener() {}}, location: {search: ''}, URLSearchParams,
    document: {addEventListener() {}, getElementById: el, createElement: () => el(Symbol('node')), querySelectorAll: () => [], documentElement: {dataset: {}}},
    console: {...console, error(error) {errors.push(error);}}, setTimeout: () => 1, clearTimeout() {},
  });
  const receive = (type, payload) => native.onmessage({data: JSON.stringify({type, payload})});
  const click = (act, data = {}, sheet = false) => el(sheet ? 'sheet' : 'root').listeners.click.forEach(fn => fn({stopPropagation() {},
    target: {closest(selector) {return selector === '#sheet' ? null : {dataset: {act, ...data}};}}}));
  receive('snapshot', {state: {capturing: false, selfName: 'Alice'}, team: ['Alice', 'Bob'], transcript: []});
  return {receive, click, messages, errors, screen: () => el('screen').innerHTML, sheet: () => el('sheet').innerHTML,
    sheetOpen: () => !el('sheet').hidden,
    last: type => messages.filter(x => x.type === type).at(-1)?.payload};
}
const meeting = () => ({session_id: 's1', title: '产品评审', started_at: '2026-10-12T00:00:00Z', ended_at: '2026-10-12T01:00:00Z',
  review_queue: [{kind: 'decision', id: 'd1'}, {kind: 'speaker', id: 'u1'}],
  utterances: [{id: 'd1', text: '本周先做接口适配', tag: 'decision', start_ms: 1000, end_ms: 2000}, {id: 'u1', text: '需要重新核对负责人', start_ms: 3000, end_ms: 4000}],
  digest: {decision: [{id: 'd1', text: '本周先做接口适配', tag: 'decision', start_ms: 1000}], constraint: [], commitment: []}});
const task = (what, who = 'Alice', state = 'open') => ({what, who, feishu: {state}});
function review(u, row = meeting()) { u.click('review-start', {id: row.session_id}); u.receive('history.open', row); }

test('review advances only after matching saved; failures retain selection and retry the same write', () => {
  const u = ui(); review(u);
  u.click('review-verdict', {value: 'confirmed'}, true);
  const original = u.last('review.set');
  assert.match(u.sheet(), /1 \/ 2/); assert.match(u.sheet(), /正在保存/);
  u.receive('error', {scope: 'review', operation: 'review.set', sessionId: 'other', utteranceId: 'd1', message: '其他错误'});
  assert.doesNotMatch(u.sheet(), /其他错误/);
  u.receive('error', {scope: 'review', operation: 'review.set', sessionId: 's1', utteranceId: 'd1', message: '网络未连接'});
  assert.match(u.sheet(), /网络未连接/); assert.match(u.sheet(), /是决定/); assert.match(u.sheet(), /1 \/ 2/);
  u.click('review-retry', {}, true); assert.deepEqual(u.last('review.set'), original);
  u.receive('review.saved', {sessionId: 'other', utteranceId: 'd1', review: {verdict: 'confirmed'}});
  assert.match(u.sheet(), /1 \/ 2/);
  u.receive('review.saved', {sessionId: 's1', utteranceId: 'd1', review: {verdict: 'confirmed'}});
  assert.match(u.sheet(), /2 \/ 2/); assert.doesNotMatch(u.sheet(), /核对完了/);
  assert.deepEqual(u.errors, []);
});

test('owner choice remains uncounted on failure and clears only after server acknowledgement', () => {
  const u = ui(), row = meeting(); row.review_queue = [{kind: 'commitment', id: 'd1'}];
  review(u, row); u.click('review-verdict', {value: 'confirmed'}, true); u.click('review-owner', {name: 'Bob'}, true);
  assert.deepEqual(u.last('review.set').fields, {verdict: 'confirmed', owner: 'Bob'});
  u.receive('error', {scope: 'review', operation: 'review.set', sessionId: 's1', utteranceId: 'd1', message: '未保存'});
  assert.match(u.sheet(), /本次选择：Bob/); assert.doesNotMatch(u.sheet(), /核对完了/);
  u.click('review-retry', {}, true); u.receive('review.saved', {sessionId: 's1', utteranceId: 'd1', review: {verdict: 'confirmed', owner: 'Bob'}});
  assert.match(u.sheet(), /核对完了/); assert.match(u.sheet(), /已核对 1 条/); assert.deepEqual(u.errors, []);
});

test('local speaker correction does not count as server-saved review', () => {
  const u = ui(), row = meeting(); row.review_queue = [{kind: 'speaker', id: 'u1'}]; review(u, row);
  u.click('review-speaker', {name: 'Bob'}, true);
  u.receive('speaker.corrected', {sessionId: 's1', utteranceId: 'u1', speaker: 'Bob', status: 'local'});
  assert.match(u.sheet(), /等待服务器保存/); assert.doesNotMatch(u.sheet(), /核对完了/);
  u.receive('error', {scope: 'review', operation: 'speaker.correct', sessionId: 's1', utteranceId: 'u1', message: '只改了本机'});
  assert.match(u.sheet(), /重试保存本条/); u.click('review-retry', {}, true);
  u.receive('speaker.corrected', {sessionId: 's1', utteranceId: 'u1', speaker: 'Bob', status: 'saved'});
  assert.match(u.sheet(), /已核对 1 条/); assert.deepEqual(u.errors, []);
});

test('history list failure is persistent, retry clears failure, and refresh keeps prior rows', () => {
  const u = ui(); u.click('go', {route: 'sessions'});
  u.receive('error', {scope: 'history', operation: 'history.list', message: '连接失败'});
  assert.match(u.screen(), /连接失败/); assert.doesNotMatch(u.screen(), /正在读取会议/);
  u.click('history-retry'); assert.match(u.screen(), /正在读取会议/); assert.doesNotMatch(u.screen(), /连接失败/);
  u.receive('history.list', {items: [{session_id: 's1', title: '保留的会议', utterance_count: 1}]});
  u.click('history-retry'); u.receive('error', {scope: 'history', operation: 'history.list', message: '刷新失败'});
  assert.match(u.screen(), /保留的会议/); assert.match(u.screen(), /可能不是最新/); assert.deepEqual(u.errors, []);
});

test('out-of-order task filters never overwrite visible filter or homepage identity', () => {
  const u = ui(); u.click('go', {route: 'tasks'}); u.click('tasks-scope', {value: 'all'}); u.click('tasks-status-cycle');
  u.receive('tasks.list', {mine: true, status: 'open', selfName: 'Alice', items: [task('我的工作')]});
  assert.doesNotMatch(u.screen(), /我的工作<\/h3>/);
  u.receive('tasks.list', {mine: false, status: 'open', items: [task('团队工作', 'Bob')]}); assert.match(u.screen(), /团队工作/);
  u.click('tasks-status-cycle');
  u.receive('tasks.list', {mine: false, status: 'open', items: [task('迟到的未完成')]}); assert.doesNotMatch(u.screen(), /迟到的未完成/);
  u.receive('error', {scope: 'tasks', operation: 'tasks.list', mine: false, status: 'open', message: '旧筛选失败'}); assert.doesNotMatch(u.screen(), /旧筛选失败/);
  u.receive('tasks.list', {mine: false, status: 'done', items: [task('完成的团队工作', 'Bob', 'done')]}); assert.match(u.screen(), /完成的团队工作/);
  u.click('go', {route: 'home'}); assert.match(u.screen(), /我的工作/); assert.doesNotMatch(u.screen(), /完成的团队工作|团队工作/);
  assert.deepEqual(u.errors, []);
});

test('failed task reads preserve matching cached rows and identity changes reject old person replies', () => {
  const u = ui(); u.click('go', {route: 'tasks'}); u.click('tasks-scope', {value:'mine'}); u.click('tasks-status-cycle');
  u.receive('tasks.list', {mine: true, status: 'open', selfName: 'Alice', items: [task('Alice的任务')]});
  u.click('tasks-retry'); u.receive('error', {scope: 'tasks', mine: true, status: 'open', selfName: 'Alice', message: '刷新失败'});
  assert.match(u.screen(), /Alice的任务/); assert.match(u.screen(), /刷新未成功/);
  u.receive('state', {selfName: 'Bob'}); u.click('go', {route: 'home'});
  u.receive('tasks.list', {mine: true, status: 'open', selfName: 'Alice', items: [task('过时身份任务')]});
  assert.doesNotMatch(u.screen(), /过时身份任务|Alice的任务/);
  u.receive('tasks.list', {mine: true, status: 'open', selfName: 'Bob', items: [task('Bob的任务', 'Bob')]}); assert.match(u.screen(), /Bob的任务/);
  assert.deepEqual(u.errors, []);
});

test('projects show retry on failure and ignore another project response', () => {
  const u = ui(); u.click('go', {route: 'memory'});
  u.receive('error', {scope: 'projects', operation: 'projects.list', message: '项目读取失败'});
  assert.match(u.screen(), /项目读取失败/); assert.doesNotMatch(u.screen(), /正在读取项目/);
  u.click('projects-retry'); u.receive('projects.list', {items: [{name: '甲', meeting_count: 1}]}); assert.match(u.screen(), /甲/);
  u.click('project-open', {name: '甲'});
  u.receive('project.open', {name: '乙', decisions: [], tasks: [], meetings: []}); assert.doesNotMatch(u.screen(), /<h1 class="title">乙/);
  u.receive('error', {scope: 'projects', operation: 'project.open', name: '甲', message: '甲读取失败'}); assert.match(u.screen(), /甲读取失败/);
  u.click('project-retry'); assert.equal(u.last('project.open').name, '甲'); assert.deepEqual(u.errors, []);
});

test('meeting open failure retains requested destination and permits explicit retry', () => {
  const u = ui(); u.click('meeting-open', {id: 's1'});
  u.receive('error', {scope: 'history', operation: 'history.open', sessionId: 's1', message: '打开失败'}); assert.match(u.sheet(), /重新打开会议/);
  u.click('meeting-retry', {}, true); assert.equal(u.last('history.open').sessionId, 's1');
  u.receive('history.open', {...meeting(), session_id: 'other', title: '迟到会议'}); assert.doesNotMatch(u.screen(), /迟到会议/);
  u.receive('history.open', meeting()); assert.match(u.screen(), /产品评审/); assert.deepEqual(u.errors, []);
});

test('closing an opening meeting discards its delayed reply instead of navigating unexpectedly', () => {
  const u = ui(); u.click('meeting-open', {id: 's1'}); u.click('close', {}, true);
  u.receive('history.open', meeting()); assert.doesNotMatch(u.screen(), /产品评审/);
  u.click('meeting-open', {id: 's1'}); u.receive('history.open', meeting()); assert.match(u.screen(), /产品评审/);
  u.receive('history.open', {...meeting(), title: '重复的打开回包'}); assert.doesNotMatch(u.screen(), /重复的打开回包/);
  assert.deepEqual(u.errors, []);
});

test('minutes pending and unavailable are explicit and only refresh on a user query', () => {
  const u = ui(); u.receive('history.open', meeting()); const first = u.last('history.minutes');
  u.receive('history.minutes', {session_id: 's1', requestId: first.requestId, status: 'pending', reason: 'writing'});
  assert.match(u.screen(), /纪要正在整理/); assert.equal(u.messages.filter(x => x.type === 'history.minutes').length, 1);
  u.click('minutes-refresh'); const next = u.last('history.minutes'); assert.notEqual(next.requestId, first.requestId);
  u.receive('history.minutes', {session_id: 's1', requestId: next.requestId, status: 'unavailable', reason: 'bot_off'});
  assert.match(u.screen(), /尚未启用纪要机器人/); assert.deepEqual(u.errors, []);
});

test('source-changed minutes never reuse old body and old document is history only', () => {
  const u = ui(); u.receive('history.open', meeting()); const first = u.last('history.minutes');
  u.receive('history.minutes', {session_id: 's1', requestId: first.requestId, status: 'ready', minutes: {overview: '旧版AI正文'}, doc_url: 'https://example.com/current', sources: {}});
  assert.match(u.screen(), /旧版AI正文/);
  u.click('minutes-refresh'); const second = u.last('history.minutes'); assert.doesNotMatch(u.screen(), /旧版AI正文/);
  u.receive('history.minutes', {session_id: 's1', requestId: second.requestId, status: 'unavailable', reason: 'source_changed', historical_doc_url: 'https://example.com/old'});
  u.receive('history.minutes', {session_id: 's1', requestId: first.requestId, status: 'ready', minutes: {overview: '迟到旧版AI正文'}});
  assert.match(u.screen(), /来源已经变化/); assert.match(u.screen(), /查看旧版历史文档/); assert.doesNotMatch(u.screen(), /旧版AI正文/);
  u.click('minutes-history-doc'); assert.equal(u.last('open.url').url, 'https://example.com/old');
  assert.ok(u.messages.every(x => !['minutes.generate', 'minutes.send', 'action.confirm'].includes(x.type))); assert.deepEqual(u.errors, []);
});

test('server-saved review invalidates displayed minutes and queries matching new result', () => {
  const u = ui(); u.receive('history.open', meeting()); const old = u.last('history.minutes');
  u.receive('history.minutes', {session_id: 's1', requestId: old.requestId, status: 'ready', minutes: {overview: '核对前正文'}});
  u.receive('review.saved', {sessionId: 's1', utteranceId: 'd1', review: {verdict: 'confirmed'}});
  const next = u.last('history.minutes'); assert.notEqual(next.requestId, old.requestId); assert.doesNotMatch(u.screen(), /核对前正文/);
  u.receive('history.minutes', {session_id: 's1', requestId: old.requestId, status: 'ready', minutes: {overview: '核对前正文'}});
  assert.doesNotMatch(u.screen(), /核对前正文/);
  u.receive('history.minutes', {session_id: 's1', requestId: next.requestId, status: 'unavailable', reason: 'source_changed'});
  assert.match(u.screen(), /来源已经变化/); assert.deepEqual(u.errors, []);
});

test('minutes failure removes spinner, retry is explicit, and older failure cannot replace new result', () => {
  const u = ui(); u.receive('history.open', meeting()); const first = u.last('history.minutes');
  u.receive('error', {scope: 'minutes', operation: 'history.minutes', sessionId: 's1', requestId: first.requestId, message: '纪要网络失败'});
  assert.match(u.screen(), /纪要网络失败/); assert.doesNotMatch(u.screen(), /正在读取已保存/);
  u.click('minutes-refresh'); const next = u.last('history.minutes');
  u.receive('history.minutes', {session_id: 's1', requestId: next.requestId, status: 'ready', minutes: {overview: '当前结果'}});
  u.receive('error', {scope: 'minutes', sessionId: 's1', requestId: first.requestId, message: '迟到的失败'});
  assert.match(u.screen(), /当前结果/); assert.doesNotMatch(u.screen(), /迟到的失败/); assert.deepEqual(u.errors, []);
});

test('server switch clears remote caches and pending review and rejects previous server replies', () => {
  const u = ui(), a = {backendUrl: 'https://a.example', serviceEpoch: 0}, b = {backendUrl: 'https://b.example', serviceEpoch: 1};
  u.receive('state', {backend: 'http', backendUrl: a.backendUrl});
  u.receive('history.list', {...a, items: [{session_id: 's1', title: 'A服务会议', utterance_count: 1}]});
  u.receive('tasks.list', {...a, mine: true, status: 'open', selfName: 'Alice', items: [task('A服务任务')]});
  u.receive('projects.list', {...a, items: [{name: 'A项目', meeting_count: 1}]});
  review(u); u.click('review-verdict', {value: 'confirmed'}, true); assert.equal(u.sheetOpen(), true);
  u.receive('state', {backend: 'http', backendUrl: b.backendUrl});
  u.receive('backend.changed', {backend: 'http', ...b});
  assert.equal(u.sheetOpen(), false); assert.doesNotMatch(u.screen(), /产品评审|A服务会议/);
  u.receive('history.list', {...b, items: [{session_id: 'b1', title: 'B服务会议', utterance_count: 1}]});
  u.receive('history.list', {...a, items: [{session_id: 'a1', title: '迟到A服务会议'}]});
  u.receive('review.saved', {...a, sessionId: 's1', utteranceId: 'd1', review: {verdict: 'confirmed'}});
  u.receive('error', {...a, scope: 'history', operation: 'history.list', message: '迟到A服务失败'});
  assert.match(u.screen(), /B服务会议/); assert.doesNotMatch(u.screen(), /迟到A服务会议|迟到A服务失败/); assert.equal(u.sheetOpen(), false);
  u.click('go', {route: 'home'}); assert.doesNotMatch(u.screen(), /A服务任务/);
  u.receive('tasks.list', {...b, mine: true, status: 'open', selfName: 'Alice', items: [task('B服务任务')]});
  u.receive('tasks.list', {...a, mine: true, status: 'open', selfName: 'Alice', items: [task('迟到A服务任务')]});
  assert.match(u.screen(), /B服务任务/); assert.doesNotMatch(u.screen(), /迟到A服务任务/);
  u.click('go', {route: 'memory'}); assert.doesNotMatch(u.screen(), /A项目/);
  assert.deepEqual(u.errors, []);
});

test('permission epoch change on the same server clears prior results; unchanged settings keep current content', () => {
  const u = ui(), backendUrl = 'https://same.example';
  u.receive('state', {backend: 'http', backendUrl});
  u.receive('history.open', {...meeting(), serviceEpoch: 0, backendUrl}); const old = u.last('history.minutes');
  u.receive('history.minutes', {session_id: 's1', requestId: old.requestId, serviceEpoch: 0, backendUrl, status: 'ready', minutes: {overview: '旧权限的纪要'}});
  const queries = u.messages.filter(x => x.type === 'history.minutes').length;
  u.receive('state', {backend: 'http', backendUrl, voiceTrigger: false});
  assert.match(u.screen(), /旧权限的纪要/); assert.equal(u.messages.filter(x => x.type === 'history.minutes').length, queries);
  u.receive('backend.changed', {backend: 'http', backendUrl, serviceEpoch: 1});
  assert.doesNotMatch(u.screen(), /旧权限的纪要/);
  u.receive('history.list', {backendUrl, serviceEpoch: 1, items: [{session_id: 'new', title: '新权限会议'}]});
  u.receive('history.list', {backendUrl, serviceEpoch: 0, items: [{session_id: 'old', title: '旧权限迟到会议'}]});
  assert.match(u.screen(), /新权限会议/); assert.doesNotMatch(u.screen(), /旧权限迟到会议/);
  u.receive('history.minutes', {session_id: 's1', requestId: old.requestId, backendUrl, serviceEpoch: 0, status: 'ready', minutes: {overview: '旧权限迟到正文'}});
  assert.doesNotMatch(u.screen(), /旧权限迟到正文/); assert.deepEqual(u.errors, []);
});

test('server permission change closes a historical quote sheet before clearing its backing card', () => {
  const u = ui(), backendUrl = 'https://same.example'; u.receive('state', {backend: 'http', backendUrl});
  u.receive('history.search', {backendUrl, serviceEpoch: 0, query: '项目原话', engine: 'archive', items: [{id: 'q1', text: '旧权限可见的历史原话', start_ms: 1000, end_ms: 2000, speaker: 'Alice'}]});
  assert.equal(u.sheetOpen(), true); assert.match(u.sheet(), /旧权限可见的历史原话/);
  u.receive('backend.changed', {backend: 'http', backendUrl, serviceEpoch: 1});
  assert.equal(u.sheetOpen(), false);
  u.receive('state', {backend: 'http', backendUrl, sessionMs: 1000}); assert.equal(u.sheetOpen(), false); assert.deepEqual(u.errors, []);
});

test('undoing manual identity restores unknown-speaker review only when the model identity is unknown', () => {
  const u = ui(), row = meeting(); row.review_queue = []; row.utterances[1].review = {speaker: 'Bob'};
  u.receive('history.open', row);
  u.receive('speaker.corrected', {sessionId: 's1', utteranceId: 'u1', speaker: null, status: 'saved'});
  assert.match(u.screen(), /会后核对 1/);
  const v = ui(), known = meeting(); known.review_queue = []; known.utterances[1].speaker = 'Alice'; known.utterances[1].review = {speaker: 'Bob'};
  v.receive('history.open', known); v.receive('speaker.corrected', {sessionId: 's1', utteranceId: 'u1', speaker: null, status: 'saved'});
  assert.doesNotMatch(v.screen(), /会后核对 1/); assert.match(v.screen(), /已保存/); assert.doesNotMatch(v.screen(), /已保存 · 已核对/);
  assert.deepEqual(u.errors, []); assert.deepEqual(v.errors, []);
});
