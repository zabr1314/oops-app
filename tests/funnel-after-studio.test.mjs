import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the production derivation without a DOM. This tests the same role model
// the interactive room consumes, rather than duplicating it in test code.
const context = vm.createContext({ window: {}, document: { getElementById: () => null } });
vm.runInContext(readFileSync('public/funnel-after-studio.js', 'utf8'), context, { filename: 'public/funnel-after-studio.js' });
const { derive, phaseAt } = context.window.OopsAfterStudio;
const fixture = JSON.parse(readFileSync('public/funnel-sample.json', 'utf8'));

function snapshot(overrides = {}) {
  const data = structuredClone(fixture);
  data.source = { kind: 'reanalysis', label: 'Synthetic test fixture' };
  data.post.generation = { evidence: 'reused_history', successful_runs: 3, recorded_calls: null };
  delete data.post.delivery_record;
  return { data, post: data.post, at: 0, total: 60000, playing: false, started: false, mode: 'after', timeline_kind: 'presentation', ...overrides };
}

test('reused minutes and old delivery receipts retain their historical scope throughout playback', () => {
  const state = snapshot({ playing: true, started: true, phase: 'complete', at: 60000 });
  state.post.delivery_record = { document_created: true, sent_receipts: 2, ledger_written: true, done: true };
  state.post.handoffs = { version: 1, order: 'presentation', chronology: 'not_recorded', run_scope: 'jev_only', stages: [
    { id: 'delivery', provenance: 'recorded', status: 'historical_receipt', label: '原会议历史回执', counts: { sent_receipts: 2 }, evidence_scope: 'historical', run_scope: 'historical' },
  ] };
  const roles = derive(state);
  assert.equal(roles.minutes.status, 'reused');
  assert.match(roles.minutes.label + roles.minutes.note, /复用|原纪要/);
  assert.equal(roles.delivery.status, 'historical');
  assert.match(roles.delivery.label + roles.delivery.note, /历史|原会议/);
  assert.doesNotMatch(roles.delivery.label + roles.delivery.note, /本次已发送|已重新发送|本页已发送/);
  assert.equal(roles.review.presenting, false);
});

test('missing research history cannot be inferred from questions, open items, configuration or progress', () => {
  const state = snapshot({ playing: true, started: true, phase: 'evidence', at: 20000 });
  state.data.pipeline = { in_meeting_research: true, minutes_configured_runs: 3 };
  state.post.handoffs = { version: 1, order: 'presentation', chronology: 'not_recorded', stages: [
    { id: 'research', provenance: 'missing', status: 'not_recorded', counts: {}, run_scope: 'not_run' },
  ] };
  assert.ok(state.post.items.some(item => item.kind === 'open'));
  const { research } = derive(state);
  assert.equal(research.status, 'missing');
  assert.equal(research.presenting, false);
  assert.match(research.label + research.note, /未记录|无.*记录|没有.*记录/);
  assert.doesNotMatch(research.label + research.note, /查到资料|资料已找到|正在搜索|已完成搜索/);
});

test('an expired or cleared source cannot be revived by a stale post snapshot', () => {
  const old = snapshot();
  const roles = derive({ ...old, data: { version: 2, source: { kind: 'empty' }, sentences: [], post: null }, playing: true, phase: 'complete' });
  for (const role of Object.values(roles)) {
    assert.equal(role.status, 'empty');
    assert.equal(role.presenting, false);
    assert.ok(!role.label.includes(old.post.items[0].title));
  }
});

test('manual review remains unconfirmed after every presentation phase', () => {
  for (const phase of ['minutes', 'evidence', 'quality', 'queue', 'complete']) {
    const state = snapshot({ phase, playing: true, started: true, at: 60000 });
    const { review } = derive(state);
    assert.equal(review.status, 'pending');
    assert.equal(review.presenting, false);
    assert.match(review.label + review.note, /未记录|待.*核对|未.*确认/);
    assert.doesNotMatch(review.label, /已确认|已验收|全部通过/);
  }
});

test('an absent delivery receipt is missing rather than an assertion that no sending happened', () => {
  const state = snapshot({ phase: 'complete', playing: true, started: true });
  state.post.delivery_record = {};
  const { delivery } = derive(state);
  assert.equal(delivery.status, 'missing');
  assert.equal(delivery.presenting, false);
  assert.doesNotMatch(delivery.label, /未发送|发送成功|本次已发送/);
});

test('the room uses engine phases before any fallback presentation fraction', () => {
  for (const [phase, expected] of [['minutes', 0], ['evidence', 1], ['quality', 2], ['queue', 3], ['complete', 3]]) {
    assert.equal(phaseAt({ phase, at: 59000, total: 60000 }), expected);
  }
  assert.equal(phaseAt({ at: -100, total: 60000 }), 0);
  assert.equal(phaseAt({ at: 90000, total: 60000 }), 3);
});

test('pausing or viewing live mode does not animate an after role', () => {
  for (const controls of [{ playing: false, mode: 'after' }, { playing: true, mode: 'live' }]) {
    const roles = derive(snapshot({ phase: 'minutes', started: true, ...controls }));
    assert.ok(Object.values(roles).every(role => role.presenting === false));
  }
});

test('recorded problem and partial review summaries do not claim research success or universal confirmation', () => {
  const state = snapshot({ playing: true, started: true, phase: 'complete', at: 60000 });
  state.post.handoffs = { version: 1, order: 'presentation', chronology: 'not_recorded', stages: [
    { id: 'research', provenance: 'recorded', status: 'recorded_summary', counts: { records: 2 }, run_scope: 'not_run' },
    { id: 'review', provenance: 'recorded', status: 'recorded_summary', counts: { confirmed: 1, rejected: 1, merged: 0, pending: 4, stale: 1 }, run_scope: 'historical' },
  ] };
  const { research, review } = derive(state);
  assert.equal(research.status, 'historical');
  assert.match(research.label, /问题.*摘要/);
  assert.doesNotMatch(research.label, /查询成功|查到资料|已找到|已完成搜索/);
  assert.equal(research.presenting, false);
  assert.equal(review.status, 'historical');
  assert.match(review.label, /核对.*摘要/);
  assert.doesNotMatch(review.label, /全部.*核对|全部.*确认|全.*通过|已完成核对/);
  assert.equal(review.presenting, false);
  assert.equal(state.post.handoffs.stages[1].counts.pending, 4);
});

test('a created document or zero sent receipts is a recorded delivery summary, not a successful sending receipt', () => {
  for (const counts of [{ document_created: true, sent_receipts: null }, { document_created: true, sent_receipts: 0, ledger_written: true, done: true }]) {
    const state = snapshot({ playing: true, started: true, phase: 'complete' });
    state.post.delivery_record = { ...counts };
    state.post.handoffs = { version: 1, order: 'presentation', chronology: 'not_recorded', stages: [
      { id: 'delivery', provenance: 'recorded', status: 'recorded_summary', counts, run_scope: 'not_run', evidence_scope: 'historical' },
    ] };
    const { delivery } = derive(state);
    assert.equal(delivery.status, 'historical');
    assert.match(delivery.label, /状态摘要/);
    assert.doesNotMatch(delivery.label, /历史回执|已发送|发送成功|未记录/);
    assert.equal(delivery.presenting, false);
  }
});
