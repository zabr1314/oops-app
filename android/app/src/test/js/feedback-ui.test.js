'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {id, dataset: {}, children: [], style: {setProperty() {}},
    classList: {toggle() {}, add() {}, remove() {}}, setAttribute() {}, appendChild() {}, insertBefore(child) {this.children.push(child);},
    querySelectorAll: () => [], listeners: {}, addEventListener(type, fn) {(this.listeners[type] ||= []).push(fn);}});
  return elements.get(id);
}
const errors = [], messages = [], native = {postMessage(raw) {messages.push(JSON.parse(raw));}};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../main/assets/web/app.js'), 'utf8'), {
  window: {OopsNative: native, addEventListener() {}}, location: {search: ''}, URLSearchParams,
  document: {addEventListener() {}, getElementById: element, createElement: () => element(Symbol('node')), querySelectorAll: () => [], documentElement: {dataset: {}}},
  console: {...console, error(error) {errors.push(error);}}, setTimeout, clearTimeout,
});
const receive = (type, payload) => native.onmessage({data: JSON.stringify({type, payload})});
const click = (dataset) => element('root').listeners.click.forEach(fn => fn({stopPropagation() {},
  target: {closest(selector) {return selector === '#sheet' ? null : {dataset};}}}));

const idle = element('screen').innerHTML;
assert.ok(idle.indexOf('data-act="capture-start"') < idle.indexOf('id="home-ask"'));
assert.match(idle, /重要的话/);
assert.doesNotMatch(idle, /正在记录|72%/);

receive('state', {capturing: true, sourceReady: false, sessionId: 's1', sessionMs: 12000, source: 'mic'});
click({act: 'go', route: 'home'});
assert.match(element('screen').innerHTML, /等待收音/);
assert.match(element('screen').innerHTML, /回到记录现场/);
assert.doesNotMatch(element('screen').innerHTML, /data-act="capture-start"/);
receive('state', {capturing: true, sourceReady: true, sessionId: 's1', sessionMs: 61000});
assert.equal(element('home-record-time').textContent, '01:01');
assert.equal(element('home-record-status').textContent, '正在记录');
assert.equal(element('home-record-people').textContent, '等待第一段对话');
receive('asr.final', {id: 'live-unknown', text: '已经收到这段话', startMs: 1000, endMs: 3000, speaker: null});
receive('state', {sessionMs: 62000});
assert.equal(element('home-record-people').textContent, '已收到1段对话 · 说话人待识别');
receive('asr.speaker', {id: 'live-unknown', speaker: '洪玉麟'});
receive('state', {sessionMs: 63000});
assert.equal(element('home-record-people').textContent, '1位发言人 · 身份可在原文核对');

receive('history.open', {session_id: 'past', title: '项目讨论', started_at: '2026-10-12T00:00:00Z', ended_at: '2026-10-12T01:00:00Z',
  review_queue: [{kind: 'decision'}], utterances: [], digest: {decision: [
    {id: 'u1', text: '候选决定', tag: 'decision', start_ms: 1000},
    {id: 'u2', text: '已确认决定', tag: 'decision', start_ms: 2000, review: {verdict: 'confirmed'}},
  ], commitment: [], constraint: []}});
const overview = element('screen').innerHTML;
assert.ok(overview.indexOf('Oops 整理出的候选') < overview.indexOf('本次确认的结论'));
assert.match(overview, /data-act="history-quote" data-id="u1"/);
assert.match(overview, /逐条核对后/);
assert.match(overview, /已确认决定/);
assert.deepEqual(errors, []);
assert.ok(messages.every(message => !['action.execute', 'capture.start'].includes(message.type)));
console.log('native feedback UI: capture state, primary entry, live clock and candidate-first review passed');
