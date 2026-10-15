import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the actual presentation's pure state projection without a browser or
// provider transport. Fixtures contain no private meeting text.
const window = {};
runInNewContext(readFileSync('public/funnel-studio.js', 'utf8'), {
  window,
  document: { getElementById: () => null },
});
const deriveStations = window.OopsStudio.deriveStations;
const currentIndex = window.OopsStudio.currentIndex;
const stationKeys = ['listen', 'judge', 'query', 'minutes', 'delivery'];
const sentence = (id, start = 0, forks = [{ layer: 'jev', provenance: 'reanalysis', p: .8 }]) => ({
  id, text: 'Synthetic public test fixture', start_ms: start, end_ms: start + 1000, doneAt: start + 1800, forks,
});
function snapshot(overrides = {}) {
  const sentences = [sentence('test-1'), sentence('test-2', 2000)];
  const data = {
    source: { kind: 'reanalysis', analysis_status: 'complete', completed_tag_sentences: 2 },
    pipeline: { in_meeting_research: true, legacy_auto_delivery_supported: true },
    sentences,
    post: {
      generation: { evidence: 'reused_history', configured_runs: 3 },
      delivery_record: { document_created: true, sent_receipts: 2, done: true },
      items: [],
    },
  };
  return { data, sentences, timeline: [], now: 500, duration: 4000, playing: false,
    selected: null, mode: 'live', ...overrides };
}

test('reanalysis separates this Jev run from reused input and minutes', () => {
  const result = deriveStations(snapshot());
  assert.equal(result.listen.status, 'reused');
  assert.equal(result.judge.status, 'recorded');
  assert.equal(result.minutes.status, 'reused');
  assert.equal(result.query.status, 'idle');
  assert.equal(result.delivery.status, 'idle');
  assert.ok(stationKeys.every(key => !result[key].active));
});

test('playing the recorded run can activate judgment, never reused or unexecuted stations', () => {
  const result = deriveStations(snapshot({ playing: true, now: 1500 }));
  assert.equal(result.judge.active, true);
  for (const key of ['listen', 'query', 'minutes', 'delivery']) assert.equal(result[key].active, false, key);
});

test('showing an original utterance does not animate a fresh ASR pass in reanalysis', () => {
  const result = deriveStations(snapshot({ playing: true, now: 500 }));
  assert.equal(result.listen.status, 'reused');
  assert.equal(result.listen.active, false);
});

test('judgment is quiet before the utterance arrives and after its saved processing window', () => {
  const before = snapshot({ playing: true, now: 0 });
  before.sentences = [sentence('future', 1000)];
  before.data.sentences = before.sentences;
  assert.equal(deriveStations(before).judge.active, false);
  assert.equal(deriveStations(snapshot({ playing: true, now: 1900 })).judge.active, false);
});

test('historical delivery receipts and deployed capabilities do not imply sending on this run', () => {
  for (const mode of ['live', 'after']) {
    const result = deriveStations(snapshot({ mode, playing: true, now: 3500 }));
    assert.equal(result.query.status, 'idle');
    assert.equal(result.query.active, false);
    assert.equal(result.delivery.status, 'idle');
    assert.equal(result.delivery.active, false);
    assert.equal(result.minutes.active, false);
  }
});

test('a sentence with no saved judgment never animates an invented call', () => {
  const current = snapshot({ playing: true, now: 3500 });
  current.sentences[1] = sentence('test-2', 2000, []);
  current.data.sentences = current.sentences;
  current.data.source.analysis_status = 'partial';
  current.data.source.completed_tag_sentences = 1;
  const result = deriveStations(current);
  assert.equal(result.judge.active, false);
});

test('pausing removes all active work even when inspecting a completed sentence', () => {
  const result = deriveStations(snapshot({ selected: 0, playing: false, now: 1100 }));
  assert.ok(stationKeys.every(key => result[key].active === false));
});

test('missing minutes remain missing and are never inferred from configured model rounds', () => {
  const current = snapshot({ mode: 'after', playing: true });
  current.data.post = null;
  const result = deriveStations(current);
  assert.equal(result.minutes.status, 'empty');
  assert.equal(result.minutes.active, false);
});

test('source invalidation clears every station even if an old snapshot still held sentences', () => {
  const stale = snapshot({ playing: true });
  stale.data = { source: { kind: 'empty' }, sentences: [], post: null };
  const result = deriveStations(stale);
  for (const key of stationKeys) {
    assert.equal(result[key].status, 'empty', key);
    assert.equal(result[key].active, false, key);
    assert.doesNotMatch(result[key].note, /Synthetic public test fixture/);
  }
});

test('state projection is read-only and preserves the original analysis', () => {
  const current = snapshot();
  const before = JSON.stringify(current);
  deriveStations(current);
  assert.equal(JSON.stringify(current), before);
});

test('a late judgment stays with its original sentence during the visible handoff', () => {
  const state = snapshot({ playing: true, speed: 30, now: 2500, fired: 1,
    timeline: [{ i: 0, t: 2400, real: 100, f: { layer: 'jev' } }] });
  assert.equal(currentIndex(state), 0);
  assert.equal(currentIndex({ ...state, selected: 1 }), 1);
  assert.equal(currentIndex({ ...state, playing: false }), 1);
  assert.equal(currentIndex({ ...state, now: 2400 + 30 * 700 + 1 }), 1);
  assert.equal(currentIndex({ ...state, timeline: [{ ...state.timeline[0], real: 0 }] }), 1);
});
