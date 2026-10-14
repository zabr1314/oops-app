import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sample = JSON.parse(readFileSync('public/funnel-sample.json', 'utf8'));
const layers = new Set(['code', 'jev', 'model', 'you']);

test('the public funnel uses the labelled example, never a real replay', () => {
  assert.equal(sample.version, 1);
  assert.equal(sample.source.kind, 'example');
  assert.match(sample.source.note, /示例/);
  assert.ok(sample.sentences.length >= 20);
  for (const s of sample.sentences) {
    assert.ok(s.forks.length > 0, s.id);
    for (const f of s.forks) {
      assert.ok(layers.has(f.layer), s.id);
      assert.ok(f.p === null || (f.p >= 0 && f.p <= 1), s.id);
    }
    assert.ok(layers.has(s.route));
  }
  assert.deepEqual([...new Set(sample.sentences.map(s => s.route))].sort(), ['code', 'jev', 'model', 'you']);
});

test('the example carries post-meeting items checked by backend code', () => {
  const post = sample.post;
  assert.ok(post && post.items.length >= 5);
  const ids = new Set(sample.sentences.map(s => s.id));
  for (const item of post.items) {
    assert.ok(['task', 'decision', 'open'].includes(item.kind), item.title);
    assert.ok(item.ids.length && item.ids.every(id => ids.has(id)), item.title);
    assert.ok(['accepted', 'needs_review', 'rejected'].includes(item.quality.status), item.title);
  }
  assert.ok(post.queue.every(q => ids.has(q.id)));
});

test('the funnel page is reachable from the showcase and writes text safely', () => {
  assert.match(readFileSync('public/showcase.html', 'utf8'), /href="\.\/funnel\.html"/);
  for (const file of ['public/funnel.js', 'public/funnel-after.js']) assert.doesNotMatch(readFileSync(file, 'utf8'), /innerHTML/, file);
  const html = readFileSync('public/funnel.html', 'utf8');
  assert.match(html, /funnel\.js/);
  assert.match(html, /funnel-after\.js/);
  assert.match(html, /id="mode-after"/);
});
