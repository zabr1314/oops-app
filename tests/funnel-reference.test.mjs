import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync('public/funnel-reference.js', 'utf8');
const context = vm.createContext({ window: {} });
vm.runInContext(script, context, { filename: 'public/funnel-reference.js' });
const { derive, probabilityPoints, evidencePoints, wallBars, legTargets } = context.window.OopsReference;
function source(length = 6) {
  const sentences = Array.from({ length }, (_, i) => ({ id: 's' + (i + 1), text: 'Synthetic sentence ' + i, end_ms: (i + 1) * 1000, forks: [{ layer: 'jev', p: .6 + i % 4 / 10, provenance: 'reanalysis' }] }));
  return { version: 2, source: { kind: 'reanalysis' }, sentences, post: { items: [{ id: 'a', kind: 'task', ids: ['s2', 's4'] }, { id: 'b', kind: 'decision', ids: ['s4'] }], queue: [{ id: 'a' }], generation: { evidence: 'reused_history' }, handoffs: { stages: [] } } };
}
function snapshot(data = source()) {
  const timeline = data.sentences.flatMap((row, i) => row.forks.map(f => ({ i, t: row.end_ms + 100, f })));
  return { data, timeline, fired: timeline.length, mode: 'live', playing: true, now: 10000 };
}

test('invalidating the owning source clears every card and chart despite stale snapshot rows', () => {
  const state = snapshot();
  state.sentences = state.data.sentences;
  state.data = { version: 2, source: { kind: 'empty' }, sentences: [], post: null };
  for (const mode of ['live', 'after']) {
    const model = derive(state, mode);
    assert.equal(model.valid, false);
    assert.equal(model.playing, false);
    assert.equal(model.points.length, 0);
    assert.ok(model.cards.every(card => card.status === 'missing' && !card.active && card.value === '—'));
  }
  assert.equal(probabilityPoints(state).length, 0);
  assert.equal(evidencePoints(state).length, 0);
});

test('after missing research and delivery never become active or acquire fabricated counts', () => {
  const data = source();
  data.post.handoffs.stages = [{ id: 'research', provenance: 'missing', status: 'not_recorded', counts: { records: 0 } }, { id: 'delivery', provenance: 'missing', status: 'not_recorded', counts: { sent_receipts: null } }];
  const model = derive({ ...snapshot(data), mode: 'after', phase: 'queue' }, 'after');
  for (const key of ['query', 'delivery']) {
    const card = model.cards.find(card => card.key === key);
    assert.equal(card.status, 'missing');
    assert.equal(card.active, false);
    assert.equal(card.value, '—');
    assert.match(card.note, /未记录/);
  }
  assert.equal(model.cards.find(card => card.key === 'minutes').status, 'reused');
  assert.match(model.cards.find(card => card.key === 'minutes').note, /本次未生成/);
});

test('probability telemetry uses only returned Jev values already reached, never accuracy or legacy display values', () => {
  const data = source(55), state = snapshot(data);
  state.timeline.push({ i: 0, t: 99999, f: { layer: 'code', p: .95 } });
  state.timeline.push({ i: 0, t: 99999, f: { layer: 'jev', p: 1.2 } });
  state.timeline.push({ i: 0, t: 99999, f: { layer: 'jev', p: .95, provenance: 'missing' } });
  state.fired = state.timeline.length;
  const points = probabilityPoints(state);
  assert.equal(points.length, 40);
  assert.equal(points[0].sentence, 15);
  assert.equal(points.at(-1).sentence, 54);
  assert.equal(points.at(-1).y, data.sentences[54].forks[0].p);
  assert.match(derive(state).chartLabel, /不是准确率/);
  state.fired = 2;
  assert.equal(probabilityPoints(state).length, 2);
  state.data.version = 1;
  assert.equal(probabilityPoints(state).length, 0);
});

test('after telemetry counts distinct cited source sentences at the displayed reading position', () => {
  const state = { ...snapshot(), mode: 'after', phase: 'evidence', here: 4 };
  const points = evidencePoints(state);
  assert.deepEqual(Array.from(points, point => point.y), [0, 1, 1, 2, 2]);
  assert.equal(points.at(-1).x, 5);
  assert.match(derive(state, 'after').chartLabel, /展示进度，不是实际耗时/);
  state.phase = 'minutes';
  assert.equal(evidencePoints(state).length, 0);
  state.phase = 'complete';
  assert.equal(evidencePoints(state).length, 6);
  assert.equal(evidencePoints(state).at(-1).y, 2);
});

test('question summaries and document state summaries do not claim successful research or sending', () => {
  const state = snapshot();
  state.data.post.handoffs.stages = [
    { id: 'research', provenance: 'recorded', status: 'recorded_summary', counts: { records: 2 } },
    { id: 'delivery', provenance: 'recorded', status: 'recorded_summary', counts: { document_created: true, sent_receipts: 0 } },
  ];
  const cards = derive(state).cards;
  assert.match(cards.find(card => card.key === 'query').note, /不证明已查询/);
  const delivery = cards.find(card => card.key === 'delivery');
  assert.equal(delivery.status, 'historical');
  assert.match(delivery.note, /不证明已发送/);
  assert.equal(delivery.active, false);
});

test('the crawler has eight long alternating leg targets and this presentation cannot call a service', () => {
  const feet = legTargets({ x: 200, y: 200, angle: 0 });
  assert.equal(feet.length, 8);
  assert.equal(new Set(feet.map(foot => foot.x + ':' + foot.y)).size, 8);
  assert.equal(feet.filter(foot => foot.group === 0).length, 4);
  assert.ok(feet.every(foot => Math.hypot(foot.x - 200, foot.y - 200) > 90));
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket|Math\.random|localStorage|sessionStorage/);
});

test('the wall preserves every returned option and never fabricates alternatives to a lone saved p', () => {
  const state = snapshot();
  state.selected = 1;
  state.data.sentences[1].forks.push({ layer: 'jev', provenance: 'reanalysis', choice: 'decision', p: .74, probabilities: { decision: .74, task: .19, other: .07 } });
  state.timeline.push({ i: 1, t: 9900, f: state.data.sentences[1].forks.at(-1) }); state.fired = state.timeline.length;
  const full = wallBars(state);
  assert.equal(full.sentenceId, 's2');
  assert.equal(full.bars.length, 3);
  assert.deepEqual(Array.from(full.bars, bar => bar.value), [.74, .19, .07]);
  assert.equal(full.bars.find(bar => bar.selected).key, 'decision');
  delete state.data.sentences[1].forks.at(-1).probabilities;
  const single = wallBars(state);
  assert.equal(single.bars.length, 1);
  assert.equal(single.bars[0].value, .74);
  assert.equal(single.selectedOnly, true);
  assert.match(single.label, /其他选项未记录/);
});

test('after wall counts the original item kinds and source invalidation removes every wall bar', () => {
  const state = snapshot();
  const wall = wallBars(state, 'after');
  assert.match(wall.label, /已有事项分布/);
  assert.deepEqual(Array.from(wall.bars, bar => bar.value), [1, 1, 0]);
  state.data = { version: 2, source: { kind: 'empty' }, sentences: [], post: null };
  assert.equal(wallBars(state, 'after').bars.length, 0);
  assert.equal(wallBars(state, 'live').bars.length, 0);
});


test('the wall follows the reached question rather than exposing a future clause probability', () => {
  const data = source(1);
  const whole = { layer: 'jev', q: '整句分类', provenance: 'reanalysis', choice: 'idea', probabilities: { idea: .7, task: .3 } };
  const clause = { layer: 'jev', q: '后续小句', provenance: 'reanalysis', choice: 'yes', probabilities: { yes: .9, no: .1 } };
  data.sentences[0].forks = [whole, clause];
  const state = { data, selected: 0, timeline: [{i: 0, f: whole}, {i: 0, f: clause}], fired: 1 };
  let wall = wallBars(state);
  assert.deepEqual(Array.from(wall.bars, b => b.key), ['idea', 'task']);
  assert.match(wall.label, /整句分类/);
  state.fired = 2;
  wall = wallBars(state);
  assert.deepEqual(Array.from(wall.bars, b => b.key), ['yes', 'no']);
  assert.match(wall.label, /后续小句/);
  state.fired = 0;
  assert.equal(wallBars(state).bars.length, 0);
});
