import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sample = JSON.parse(readFileSync('public/funnel-sample.json', 'utf8'));
const layers = new Set(['code', 'jev', 'model', 'you']);

test('the public funnel uses the labelled example, never a real replay', () => {
  assert.equal(sample.version, 2);
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
  assert.equal(sample.thresholds.settle, undefined);
  assert.equal(sample.pipeline.scope, 'local_source');
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
  assert.ok(post.queue.every(q => q.kind === 'item' && q.ids.every(id => ids.has(id))));
  assert.equal(post.generation.recorded_calls, null);
  assert.equal(post.generation.configured_runs, 3);
});

test('the funnel page is reachable from the showcase and writes text safely', () => {
  assert.match(readFileSync('public/showcase.html', 'utf8'), /href="\.\/funnel\.html"/);
  for (const file of ['public/funnel.js', 'public/funnel-after.js']) assert.doesNotMatch(readFileSync(file, 'utf8'), /innerHTML/, file);
  const html = readFileSync('public/funnel.html', 'utf8');
  assert.match(html, /funnel\.js/);
  assert.match(html, /funnel-after\.js/);
  assert.match(html, /id="mode-after"/);
});


test('history access is same-origin and invitation credentials are never persisted or put in URLs', () => {
  const js = readFileSync('public/funnel.js', 'utf8');
  assert.match(js, /credentials: 'same-origin'/);
  assert.match(js, /historyRequest\('session', \{ method: 'POST'/);
  assert.match(js, /historyRequest\('session', \{ method: 'DELETE'/);
  assert.doesNotMatch(js, /(?:localStorage|sessionStorage)\./);
  assert.doesNotMatch(js, /OOPS_API_TOKEN|X-Oops-Api/);
  assert.match(js, /requestVersion/);
  assert.match(js, /歷史|历史/);
});

test('the page does not claim model calls or an invented automatic confidence threshold', () => {
  const html = readFileSync('public/funnel.html', 'utf8');
  const after = readFileSync('public/funnel-after.js', 'utf8');
  assert.doesNotMatch(html, /p ≥ 0\.95|一次读完全文/);
  assert.doesNotMatch(after, /会后只调这一次模型|DeepSeek 正在读全文/);
  assert.match(after, /次数未记录/);
  assert.match(after, /q\.item_kind/);
});


test('private history is cleared on loss of access and periodically revalidated without replaying unchanged data', () => {
  const js = readFileSync('public/funnel.js', 'utf8');
  assert.match(js, /function clearHistoricalData/);
  assert.match(js, /clearHistoricalData\(error\.message\)/);
  assert.match(js, /setInterval\(verifyHistory, 30000\)/);
  assert.match(js, /snapshot !== currentSnapshot/);
  assert.match(js, /addEventListener\('focus', verifyHistory\)/);
  assert.match(js, /source\?\.snapshot_hash/);
  assert.match(js, /rows = \[\]|sentences: \[\]/);
});


test('the public page reads only deployed configuration metadata without credentials', () => {
  const js = readFileSync('public/funnel.js', 'utf8');
  assert.match(js, /https:\/\/giftedprofessor\.xyz\/oops-meeting\/history\/api\/pipeline/);
  assert.match(js, /fetch\(endpoint, \{ credentials: 'omit', cache: 'no-store' \}\)/);
  assert.match(js, /pipeline\.scope !== 'deployed_source'/);
  assert.match(js, /部署配置暂不可读取/);
  assert.match(js, /funnel:pipeline/);
});

test('invalidated post-meeting data clears the full canvas before any absent-post return', () => {
  const js = readFileSync('public/funnel-after.js', 'utf8');
  const build = js.slice(js.indexOf('  function build(raw) {'), js.indexOf('  function renderPipelineLabels()'));
  const clear = build.indexOf('ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height)');
  assert.ok(clear >= 0 && clear < build.indexOf('if (!post)'));
  assert.match(build, /ctx\.save\(\);\s*ctx\.setTransform\(1, 0, 0, 1, 0, 0\);\s*ctx\.clearRect\(0, 0, ui\.canvas\.width, ui\.canvas\.height\);\s*ctx\.restore\(\);/);
  assert.match(build, /flyers = \[\]/);
  assert.match(build, /spider\.feet = \[\]/);
});

test('deployed legacy sharing and historical receipts are described without exposing destinations', () => {
  const js = readFileSync('public/funnel.js', 'utf8');
  const after = readFileSync('public/funnel-after.js', 'utf8');
  assert.match(js, /legacy_auto_delivery_supported === true/);
  assert.match(js, /部署源码还包含旧自动共享链路；本页只读取历史，不触发发送/);
  assert.match(after, /历史回执摘要/);
  assert.match(after, /delivery\.sent_receipts/);
  assert.doesNotMatch(after, /delivery\.(?:doc_url|recipients)/);
});


test('reanalysis is a separate private selection with actual request and probability details', () => {
  const js = readFileSync('public/funnel.js', 'utf8');
  const html = readFileSync('public/funnel.html', 'utf8');
  const after = readFileSync('public/funnel-after.js', 'utf8');
  assert.match(html, /id="reanalysis-run"/);
  assert.match(js, /historyRequest\('reanalyses'/);
  assert.match(js, /historyRequest\('reanalyses\/'/);
  assert.match(js, /source\?\.kind === 'reanalysis' \? '重新分析/);
  assert.match(js, /全部选项概率/);
  assert.match(js, /f\.request\.state/);
  assert.match(js, /f\.probabilities/);
  assert.match(after, /复用原有纪要；本次重新分析只调用 Jev/);
});
