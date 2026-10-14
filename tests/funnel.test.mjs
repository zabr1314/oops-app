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

test('the funnel page is reachable from the showcase and writes text safely', () => {
  assert.match(readFileSync('public/showcase.html', 'utf8'), /href="\.\/funnel\.html"/);
  const js = readFileSync('public/funnel.js', 'utf8');
  assert.doesNotMatch(js.replace(/ui\.spark\.innerHTML = parts\.join\(''\)/, ''), /innerHTML/);
  assert.match(readFileSync('public/funnel.html', 'utf8'), /funnel\.js/);
});
