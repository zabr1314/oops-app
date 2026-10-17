import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('public/funnel-spider.js', 'utf8');

function recordingCanvas() {
  const arcs = [], alphas = [];
  const context = new Proxy({
    arc(x, y, radius, start, end) {
      assert.ok([x, y, radius, start, end].every(Number.isFinite), 'canvas arc values must be finite');
      if (radius < 0) throw new RangeError('negative canvas arc radius');
      arcs.push({ radius, color: context.strokeStyle });
    },
  }, {
    get: (object, key) => object[key] ?? (() => {}),
    set(object, key, value) {
      if (key === 'globalAlpha') alphas.push(value);
      object[key] = value;
      return true;
    },
  });
  return { context, arcs, alphas };
}

function spider() {
  const window = {};
  vm.runInNewContext(source, { window, performance: { now: () => 1000 } }, { filename: 'public/funnel-spider.js' });
  return window.OopsSpider.create();
}

function assertSafeOpacity(alphas) {
  assert.ok(alphas.length > 0);
  assert.ok(alphas.every(value => Number.isFinite(value) && value >= 0 && value <= 1), 'canvas opacity must stay in [0, 1]');
}

test('a landing newer than the RAF timestamp draws safely with nonnegative radii and valid opacity', () => {
  const crawler = spider(), canvas = recordingCanvas();
  crawler.land(100, 100, '#aabbcc');
  assert.doesNotThrow(() => crawler.draw(canvas.context, { x: 100, y: 100 }, 900, { playing: true }));
  assert.ok(canvas.arcs.length > 0);
  assert.ok(canvas.arcs.every(arc => arc.radius >= 0));
  assert.equal(canvas.arcs.find(arc => arc.color === '#aabbcc').radius, 4);
  assertSafeOpacity(canvas.alphas);
});

test('a landing expands, expires and resets without leaving unsafe or stale canvas effects', () => {
  const crawler = spider(), canvas = recordingCanvas();
  const draw = now => crawler.draw(canvas.context, { x: 100, y: 100 }, now, { playing: true });
  crawler.land(100, 100, '#aabbcc');
  assert.doesNotThrow(() => { draw(1000); draw(1350); draw(1699); });
  const radii = canvas.arcs.filter(arc => arc.color === '#aabbcc').map(arc => arc.radius);
  assert.equal(radii.length, 3);
  assert.equal(radii[0], 4);
  assert.ok(radii[1] > radii[0] && radii[2] > radii[1]);
  canvas.arcs.length = 0;
  assert.doesNotThrow(() => draw(1700));
  assert.ok(!canvas.arcs.some(arc => arc.color === '#aabbcc'));
  crawler.land(100, 100, '#aabbcc');
  crawler.reset(); canvas.arcs.length = 0;
  assert.doesNotThrow(() => draw(2000));
  assert.ok(!canvas.arcs.some(arc => arc.color === '#aabbcc'));
  assertSafeOpacity(canvas.alphas);
});
