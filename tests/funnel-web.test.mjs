import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const fixture = JSON.parse(readFileSync('public/funnel-sample.json', 'utf8'));
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync('public/funnel-web.js', 'utf8'), context, { filename: 'public/funnel-web.js' });
const { reachedForks, liveScene, afterScene } = context.window.OopsWeb;

// The same schedule shape funnel.js builds: each fork fires after the sentence ends.
function replay(now, { playing = true, selected = null } = {}) {
  const sentences = fixture.sentences.map(row => ({ ...row }));
  const timeline = [];
  for (const [i, row] of sentences.entries()) {
    let cursor = row.end_ms;
    for (const f of row.forks) { cursor += 300; timeline.push({ t: cursor, i, f }); }
    row.doneAt = cursor;
  }
  return { data: fixture, sentences, timeline, now, playing, speed: 1, selected };
}
const index = fixture.sentences.findIndex(row => row.forks.length >= 3);

test('a strand appears only after its saved step is reached, never ahead of the replay', () => {
  const row = replay(0).sentences[index];
  assert.equal(liveScene(replay(row.end_ms), index).spokes.length, 0);
  assert.equal(liveScene(replay(row.end_ms + 300), index).spokes.length, 1);
  assert.equal(liveScene(replay(row.doneAt), index).spokes.length, row.forks.length);
});

test('selecting a sentence shows every saved step and the spider rests at the hub when paused', () => {
  const scene = liveScene(replay(0, { playing: false, selected: index }), index);
  assert.equal(scene.spokes.length, fixture.sentences[index].forks.length);
  assert.deepEqual({ ...scene.spider }, { angle: 0, reach: 0 });
});

test('a missing probability is drawn as unmeasured, not as a confident strand', () => {
  const scene = liveScene(replay(0, { playing: false, selected: index }), index);
  for (const [k, spoke] of scene.spokes.entries()) {
    const p = fixture.sentences[index].forks[k].p;
    assert.equal(spoke.measured, Number.isFinite(p));
    if (!Number.isFinite(p)) assert.equal(spoke.p, p);
  }
});

test('a cleared source leaves an empty web', () => {
  assert.equal(liveScene({ data: { sentences: [] }, sentences: fixture.sentences }, 0).empty, true);
  assert.equal(afterScene({ data: { sentences: [], post: fixture.post } }).empty, true);
  assert.equal(reachedForks({ sentences: [] }, 3).length, 0);
});

test('after the meeting, items, evidence, checks and order appear only in their phase', () => {
  const items = fixture.post.items.length;
  const base = { data: fixture, started: true, playing: true, ends: [1000, 2000, 3000, 4000] };
  const early = afterScene({ ...base, phase: 'minutes', at: 500 });
  assert.ok(early.nodes.length > 0 && early.nodes.length < items);
  assert.ok(early.nodes.every(n => n.evidence === 0 && n.quality === null && n.order === null));
  const evidence = afterScene({ ...base, phase: 'evidence', at: 1500 });
  assert.equal(evidence.nodes.length, items);
  assert.ok(evidence.nodes.some(n => n.evidence > 0) && evidence.nodes.every(n => n.quality === null));
  const queue = afterScene({ ...base, phase: 'queue', at: 3500 });
  assert.ok(queue.nodes.some(n => n.order));
});
