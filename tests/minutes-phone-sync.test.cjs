const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('android/app/src/main/assets/web/minutes-sync.js', 'utf8');
function harness() {
  let clock = 1000000, serial = 0;
  const timers = new Map(), sent = [], results = [], ready = [], removed = [], failures = [], invalidated = [];
  const context = { module: { exports: {} }, setTimeout(fn, ms) { const id = ++serial; timers.set(id, { at: clock + ms, fn }); return id; }, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(source, context);
  const sync = context.module.exports.create({ now: () => clock, send: (type, payload) => sent.push({ type, ...payload }),
    onResult: p => results.push(p), onReady: sid => ready.push(sid), onRemove: sid => removed.push(sid), onListFailure: () => failures.push('list'), onInvalidate: sid => invalidated.push(sid) });
  function advance(ms) {
    const until = clock + ms;
    while (true) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > until) break;
      timers.delete(first[0]); clock = first[1].at; first[1].fn();
    }
    clock = until;
  }
  const latest = type => sent.filter(x => x.type === type).at(-1);
  const list = rows => sync.receive('history.list', { requestId: latest('history.list').requestId, items: rows });
  const result = (status, request = latest('history.minutes')) => sync.receive('history.minutes', { requestId: request.requestId, session_id: request.sessionId, status, minutes: status === 'ready' ? { overview: 'stored' } : undefined });
  return { sync, advance, latest, list, result, sent, results, ready, removed, failures, invalidated };
}
const meeting = (extra = {}) => ({ session_id: 'm1', ended_at: '2026-10-16T08:00:00Z', utterance_count: 10, transcript_status: 'available', ...extra });

test('pending minutes become ready without a tap; all requests remain read only', () => {
  const h = harness(); h.sync.start(); h.list([meeting()]); h.advance(1000); h.result('pending');
  h.advance(10000); h.result('ready');
  assert.equal(h.ready.length, 1); assert.equal(h.results.at(-1).status, 'ready');
  assert.ok(h.sent.every(x => ['history.list', 'history.minutes'].includes(x.type))); h.sync.pause();
});
test('background pauses requests and retires replies before resuming', () => {
  const h = harness(); h.sync.start(); h.list([meeting()]); h.advance(1000); const old = h.latest('history.minutes');
  h.sync.pause(); const count = h.sent.length; h.advance(120000); h.result('ready', old);
  assert.equal(h.sent.length, count); assert.equal(h.results.length, 0);
  h.sync.start(); h.list([meeting()]); h.advance(1000); h.result('ready', old);
  assert.equal(h.results.length, 0); h.result('ready'); assert.equal(h.results.length, 1); h.sync.pause();
});
test('list failure clears pending replies and recovers after reconnect', () => {
  const h = harness(); h.sync.start(); h.list([meeting()]); h.advance(1000); const old = h.latest('history.minutes');
  h.advance(19000); h.sync.receive('error', { requestId: h.latest('history.list').requestId });
  h.result('ready', old); assert.equal(h.results.length, 0); assert.equal(h.failures.length, 1);
  h.advance(20000); h.list([meeting()]); h.advance(1000); h.result('ready'); assert.equal(h.results.length, 1); h.sync.pause();
});
test('source revision changes discard an older in-flight result', () => {
  const h = harness(); h.sync.start(); h.list([meeting()]); h.advance(1000); const old = h.latest('history.minutes');
  h.advance(19000); h.list([meeting({ utterance_count: 11 })]); h.result('ready', old);
  assert.equal(h.invalidated[0], 'm1');
  assert.equal(h.results.length, 0); h.advance(1000); h.result('ready'); assert.equal(h.results.length, 1); h.sync.pause();
});
test('an explicitly open older meeting is refreshed even outside the latest list', () => {
  const h = harness(); h.sync.select(meeting({ utterance_count: undefined, utterances: [{}, {}, {}, {}, {}] }));
  h.sync.start(); h.list([]); h.advance(1000); assert.equal(h.latest('history.minutes').sessionId, 'm1'); h.sync.pause();
});
test('expired, live and empty records are not downloaded; removed sources are cleared', () => {
  const h = harness(); h.sync.start(); h.list([meeting({ ended_at: null }), meeting({ session_id: 'expired', transcript_status: 'expired' }), meeting({ session_id: 'empty', utterance_count: 0 })]);
  h.advance(1000); assert.equal(h.latest('history.minutes'), undefined);
  h.advance(19000); h.list([meeting()]); h.advance(1000); h.result('ready');
  h.advance(19000); h.list([]); assert.equal(h.removed[0], 'm1'); h.sync.pause();
});
