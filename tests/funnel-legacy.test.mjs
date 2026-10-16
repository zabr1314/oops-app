import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('public/funnel.html', 'utf8');
const css = readFileSync('public/funnel.css', 'utf8');
const engine = readFileSync('public/funnel.js', 'utf8');

test('the restored page loads only the terminal and fan replay engines', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  const styles = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['./funnel-spider.js', './funnel.js', './funnel-after.js']);
  assert.deepEqual(styles, ['./funnel.css']);
  assert.doesNotMatch(html, /funnel-(?:studio|after-studio|web|crawler|dashboard|reference)\.(?:js|css)/);
});

test('the original controls, terminal, fan, four route cards and post-meeting board are visible app content', () => {
  assert.match(html, />逐句 · 判断回放<\/button>/);
  assert.match(html, />会后 · 整理<\/button>/);
  for (const id of ['history-meeting', 'reanalysis-run', 'play', 'restart', 'speed', 'scrub', 'file', 'transcript', 'fan', 'stream', 'canvas', 'doc', 'after-canvas', 'board-task', 'board-decision', 'board-open']) assert.match(html, new RegExp('id="' + id + '"'));
  for (const layer of ['code', 'jev', 'model', 'you']) assert.match(html, new RegExp('class="route r-' + layer + '"'));
  assert.match(css, /\.stage\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /\.transcript-pane\s*\{/);
  assert.match(css, /\.routes\s*\{/);
  assert.doesNotMatch(css, /\.legacy-(?:live|after)[^{]*\{[^}]*display:\s*none/);
});

test('restoring the layout retains the current scoped history recovery and full recorded probabilities', () => {
  assert.match(engine, /let listVersion = 0/);
  assert.match(engine, /pendingRequestedRun/);
  assert.match(engine, /attempt < 2/);
  assert.match(engine, /Only one readable meeting/);
  assert.match(engine, /setInterval\(verifyHistory, 30000\)/);
  assert.match(engine, /f\.probabilities/);
  assert.match(engine, /重新分析 · Jev/);
  assert.match(engine, /function geometry\(\)/);
  assert.match(engine, /function arcPoint\(/);
  assert.match(engine, /function drawSpider\(/);
});

test('only the spider is replaced: a neon crawler both replays draw through, with the old one as fallback', () => {
  assert.ok(html.indexOf('funnel-spider.js') < html.indexOf('funnel.js"'));
  const context = vm.createContext({ window: {}, performance: { now: () => 0 } });
  vm.runInContext(readFileSync('public/funnel-spider.js', 'utf8'), context);
  assert.equal(context.window.OopsSpider.footTargets(0, 0, 0, 40).length, 8);
  for (const file of ['public/funnel.js', 'public/funnel-after.js']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /window\.OopsSpider \? window\.OopsSpider\.create/);
    assert.match(source, /function drawSpider\(/);
  }
});
