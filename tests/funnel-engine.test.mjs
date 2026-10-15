import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const fixture = JSON.parse(readFileSync('public/funnel-sample.json', 'utf8'));
const source = readFileSync('public/funnel.js', 'utf8');
const afterSource = readFileSync('public/funnel-after.js', 'utf8');
const afterStudioSource = readFileSync('public/funnel-after-studio.js', 'utf8');
const html = readFileSync('public/funnel.html', 'utf8');

// Exercise the shipped browser scripts. The DOM shell records output and events;
// it contains no replay, history, selection, or scheduling implementation.
class Target {
  listeners = new Map();
  addEventListener(name, fn) { const listeners = this.listeners.get(name) || []; listeners.push(fn); this.listeners.set(name, listeners); }
  dispatchEvent(event) { event.target ||= this; for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
}
class Element extends Target {
  constructor(tag = 'div') {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.hidden = false; this.value = ''; this._text = ''; this.scrollTop = 0; this.clientHeight = 300; this.offsetTop = 0;
    this.style = { setProperty() {} };
    this.classList = {
      contains: name => (this.className || '').split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...(this.className || '').split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = (this.className || '').split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); if (on) this.classList.add(name); else this.classList.remove(name); return on; },
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  get options() { return this.children; }
  get previousElementSibling() { const peers = this.parentElement?.children || []; return peers[peers.indexOf(this) - 1]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
  querySelector(selector) { return this.children.find(child => selector === '[data-after-state]' ? child.dataset.afterState != null : child.className?.split(' ').includes(selector.slice(1))) || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (selector.startsWith('.') && node.classList.contains(selector.slice(1))) return node; return null; }
  scrollTo({ top }) { this.scrollTop = top; }
  focus() {}
  click() { this.dispatchEvent({ type: 'click' }); }
}
const flush = async () => { for (let i = 0; i < 128; i++) await Promise.resolve(); };

async function browser({ privatePage = false, run = '', hash = '#live', routes = {}, after = true, afterStudio = false, reduceMotion = false } = {}) {
  const ids = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  ids.get('mode-after').hidden = true;
  for (const id of ['tab-live', 'tab-after']) ids.get(id).dataset.mode = id.slice(4);
  const tabs = [ids.get('tab-live'), ids.get('tab-after')];
  const afterStations = ['minutes', 'research', 'review', 'delivery'].map(key => {
    const button = new Element('button'); button.dataset.afterStation = key;
    const label = new Element('span'); label.dataset.afterState = key; button.append(label); return button;
  });
  const board = new Element(); board.className = 'board';
  for (const kind of ['task', 'decision', 'open']) {
    const column = new Element(); board.append(column); column.append(new Element('h3'), ids.get('board-' + kind));
  }
  const cards = new Map(['code', 'jev', 'model', 'you'].map(layer => ['.route.r-' + layer, new Element()]));
  const pipeline = Array.from({ length: 4 }, () => new Element('li'));
  const document = new Target(); document.body = new Element('body'); document.hidden = false;
  document.getElementById = id => ids.get(id) || null;
  document.createElement = tag => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag);
  document.querySelector = selector => cards.get(selector) || new Element();
  document.querySelectorAll = selector => selector === '.modes button' ? tabs : selector === '#pipeline li' ? pipeline : selector === '[data-after-station]' ? afterStations : [];
  let paintCount = 0;
  const canvasContext = new Proxy({ measureText: text => ({ width: String(text).length * 7 }) }, {
    get: (obj, key) => obj[key] || (() => { paintCount++; }), set: (obj, key, value) => { obj[key] = value; return true; },
  });
  for (const id of ['canvas', 'after-canvas']) ids.get(id).getContext = () => canvasContext;
  const window = new Target(); window.matchMedia = () => ({ matches: reduceMotion }); window.devicePixelRatio = 1;
  const location = { pathname: privatePage ? '/oops-meeting/history/' : '/funnel.html', hash, search: run ? '?run=' + run : '' };
  const frames = [], requests = [], events = [], delays = [];
  const overrides = new Map(Object.entries(routes));
  for (const name of ['funnel:data', 'funnel:tick', 'funnel:selection', 'funnel:play', 'funnel:mode', 'funnel:after-data', 'funnel:after-tick', 'funnel:after-play']) document.addEventListener(name, event => events.push({ type: name, detail: event.detail }));
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
  const reanalysis = { ...structuredClone(fixture), source: { kind: 'reanalysis', label: 'VM fixture', snapshot_hash: 'one' } };
  let authorized = true;
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (overrides.has(url)) {
      const route = overrides.get(url);
      const value = typeof route === 'function' ? await route({ url, options }) : route;
      if (value instanceof Error) throw value;
      if (value !== undefined) return response(value.body ?? {}, value.status ?? 200);
    }
    if (url === './funnel-sample.json') return response(fixture);
    if (String(url).endsWith('/pipeline')) return response({ pipeline: { scope: 'deployed_source' } });
    if (!authorized) return response({}, 401);
    if (url === './api/meetings') return response({ meetings: [] });
    if (url === './api/reanalyses') return response({ reanalyses: [{ run_id: 'vm-run', status: 'ready', title: 'VM fixture', utterance_count: fixture.sentences.length }] });
    if (url === './api/reanalyses/vm-run') return response(reanalysis);
    if (url === './api/session') return response({}, 204);
    throw Error('unexpected fetch: ' + url);
  };
  const context = vm.createContext({
    window, document, location, fetch, URLSearchParams, console, performance: { now: () => 10000 },
    history: { replaceState: (_, __, hash) => { if (hash.startsWith('#')) location.hash = hash; } },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    ResizeObserver: class { observe() {} }, getComputedStyle: () => ({ fontFamily: 'sans-serif' }),
    requestAnimationFrame: fn => frames.push(fn), setInterval: () => 1, setTimeout: (fn, delay) => { delays.push(delay); fn(); return 1; }, clearTimeout() {},
  });
  vm.runInContext(source, context, { filename: 'public/funnel.js' });
  if (after) vm.runInContext(afterSource, context, { filename: 'public/funnel-after.js' });
  if (afterStudio) vm.runInContext(afterStudioSource, context, { filename: 'public/funnel-after-studio.js' });
  await flush();
  return {
    window, document, ids, requests, events, location, delays,
    get paints() { return paintCount; },
    revoke: () => { authorized = false; },
    setRoute: (url, route) => overrides.set(url, route),
    clearRoute: url => overrides.delete(url),
    replaceAfter: detail => document.dispatchEvent({ type: 'funnel:data', detail }),
    frame: time => { const pending = frames.splice(0); for (const fn of pending) fn(time); },
  };
}

test('the shipped engine boots paused and selection exposes all saved steps without starting playback', async () => {
  const b = await browser();
  const engine = b.window.OopsReplay;
  assert.equal(engine.state().data.source.kind, 'example');
  assert.equal(engine.state().playing, false);
  assert.equal(engine.state().now, 0);
  const count = b.requests.length;
  engine.select(3);
  const state = engine.state(), sentence = state.sentences[3];
  assert.equal(state.selected, 3);
  assert.equal(state.now, sentence.doneAt);
  assert.equal(sentence.firedSteps, sentence.forks.length);
  assert.equal(state.playing, false);
  assert.equal(b.requests.length, count);
  assert.equal(b.events.at(-1).type, 'funnel:selection');
});

test('play resumes from a selected sentence; backward seek rebuilds progress and pause freezes time', async () => {
  const b = await browser();
  const engine = b.window.OopsReplay;
  engine.select(2); engine.play(true);
  assert.equal(engine.state().selected, null);
  assert.equal(engine.state().playing, true);
  engine.seek(0);
  assert.equal(engine.state().fired, 0);
  assert.ok(engine.state().sentences.every(sentence => sentence.firedSteps === 0));
  engine.play(false);
  b.frame(100); b.frame(300);
  assert.equal(engine.state().now, 0);
  engine.select(-1);
  assert.equal(engine.state().selected, null);
});

test('a scoped run deep-link reads the existing reanalysis and 401 clears both live and after content', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run' });
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'reanalysis', JSON.stringify({ requests: b.requests, status: b.ids.get('history-status').textContent }));
  assert.equal(b.window.OopsReplay.state().playing, false);
  assert.equal(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length, 1);
  assert.ok(b.requests.filter(request => String(request.url).startsWith('./api/') && request.url !== './api/pipeline').every(request => request.options.credentials === 'same-origin'));
  b.revoke(); b.window.dispatchEvent({ type: 'focus' }); await flush();
  const state = b.window.OopsReplay.state();
  assert.equal(state.sentences.length, 0);
  assert.equal(state.playing, false);
  assert.equal(b.ids.get('transcript').children.length, 0);
  assert.equal(b.ids.get('board-task').children.length, 0);
  assert.equal(b.ids.get('overview').textContent, '');
  assert.ok(!b.ids.get('doc').textContent.includes(fixture.sentences[0].text));
  assert.equal(b.events.filter(event => event.type === 'funnel:data').at(-1).detail.sentences.length, 0);
});

test('unknown run deep-links never issue a detail read outside the listed authorized runs', async () => {
  const b = await browser({ privatePage: true, run: 'not-listed' });
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'empty');
  assert.ok(!b.requests.some(request => request.url === './api/reanalyses/not-listed'));
});

test('switching to after results waits for play and pause prevents further canvas updates', async () => {
  const b = await browser();
  b.ids.get('tab-after').click();
  assert.equal(b.ids.get('mode-after').hidden, false);
  assert.equal(b.ids.get('after-play').textContent, '▶ 播放');
  const pausedPaints = b.paints;
  b.frame(100); b.frame(300);
  assert.equal(b.paints, pausedPaints);
  b.ids.get('after-play').click();
  assert.equal(b.ids.get('after-play').textContent, '❚❚ 暂停');
  b.frame(400);
  assert.ok(b.paints > pausedPaints);
  b.ids.get('after-play').click();
  const stoppedPaints = b.paints;
  b.frame(500); b.frame(700);
  assert.equal(b.paints, stoppedPaints);
  b.ids.get('tab-live').click(); b.ids.get('tab-after').click();
  assert.equal(b.ids.get('after-play').textContent, '▶ 播放');
});

test('after seek rebuilds saved items and queue deterministically without duplicates or network calls', async () => {
  const b = await browser();
  const engine = b.window.OopsAfterReplay;
  const initial = engine.state();
  assert.equal(initial.playing, false);
  assert.equal(initial.timeline_kind, 'presentation');
  assert.equal(initial.now, initial.at);
  assert.equal(initial.duration, initial.total);
  const requestCount = b.requests.length;
  engine.seek(initial.total);
  const first = engine.state();
  assert.equal(first.phase, 'complete');
  assert.equal(first.next, first.events.length);
  assert.equal(b.ids.get('queue').children.length, fixture.post.queue.length);
  const counts = ['task', 'decision', 'open'].map(kind => b.ids.get('n-' + kind).textContent);
  assert.deepEqual(counts, ['task', 'decision', 'open'].map(kind => String(fixture.post.items.filter(item => item.kind === kind).length)));
  const references = first.items.map(item => [...item.seen].sort().join(','));
  engine.seek(0);
  assert.equal(engine.state().phase, 'minutes');
  assert.equal(b.ids.get('queue').children.length, 0);
  assert.ok(engine.state().items.every(item => item.seen.size === 0));
  engine.seek(engine.state().total);
  assert.deepEqual(engine.state().items.map(item => [...item.seen].sort().join(',')), references);
  assert.deepEqual(['task', 'decision', 'open'].map(kind => b.ids.get('n-' + kind).textContent), counts);
  assert.equal(b.ids.get('queue').children.length, fixture.post.queue.length);
  assert.equal(b.requests.length, requestCount);
});

test('after data invalidation empties its event bridge, rendered results, phase and duration immediately', async () => {
  const b = await browser();
  const engine = b.window.OopsAfterReplay;
  engine.seek(engine.state().total);
  b.replaceAfter({ version: 2, source: { kind: 'empty' }, sentences: [], post: null, post_status: { reason: 'source_changed' } });
  const state = engine.state();
  assert.equal(state.available, false);
  assert.equal(state.phase, 'missing');
  assert.equal(state.playing, false);
  assert.equal(state.now, 0);
  assert.equal(state.duration, 1);
  assert.equal(state.post, null);
  assert.equal(state.rows.length, 0);
  assert.equal(state.items.length, 0);
  assert.equal(state.events.length, 0);
  assert.equal(b.ids.get('queue').children.length, 0);
  assert.equal(b.ids.get('board-task').children.length, 0);
  assert.equal(b.ids.get('overview').textContent, '');
  assert.equal(b.events.filter(event => event.type === 'funnel:after-data').at(-1).detail.available, false);
  engine.play(true); engine.seek(999999);
  assert.equal(engine.state().playing, false);
  assert.equal(engine.state().items.length, 0);
});

test('after playback requires its visible mode and does not resume after page hiding or mode switches', async () => {
  const b = await browser();
  const engine = b.window.OopsAfterReplay;
  engine.play(true);
  assert.equal(engine.state().playing, false);
  b.ids.get('tab-after').click(); engine.play(true);
  assert.equal(engine.state().playing, true);
  b.document.hidden = true; b.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(engine.state().playing, false);
  engine.play(true);
  assert.equal(engine.state().playing, false);
  b.document.hidden = false; b.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(engine.state().playing, false);
  b.ids.get('tab-live').click(); b.ids.get('tab-after').click();
  assert.equal(engine.state().playing, false);
});

test('after clock is explicitly presentation time and stored generation latency remains separate', async () => {
  const b = await browser();
  const data = structuredClone(fixture);
  data.source = { kind: 'reanalysis' };
  data.post.latency_ms = 987654;
  data.post.generation = { evidence: 'reused_history', recorded_calls: 3 };
  data.post.delivery_record = { document_created: true, sent_receipts: 2, ledger_written: true, done: true };
  b.replaceAfter(data);
  const state = b.window.OopsAfterReplay.state();
  assert.equal(state.timeline_kind, 'presentation');
  assert.notEqual(state.duration, data.post.latency_ms);
  assert.match(b.ids.get('after-cost').textContent, /复用原纪要/);
  assert.match(b.ids.get('after-cost').textContent, /本次没有调用 DeepSeek/);
  assert.match(b.ids.get('after-cost').textContent, /历史回执摘要/);
  assert.match(b.ids.get('after-cost').textContent, /不表示本页执行过发送/);
  assert.doesNotMatch(b.ids.get('after-cost').textContent, /本次已发送/);
});

test('source invalidation clears the actual after studio items, selected detail and scene animation', async () => {
  const b = await browser({ afterStudio: true });
  const engine = b.window.OopsAfterReplay;
  b.ids.get('tab-after').click();
  b.ids.get('after-studio-items').children[0].click();
  assert.ok(b.ids.get('after-inspector-content').textContent.includes(fixture.post.items[0].title));
  engine.seek(engine.state().ends[0] + 1); engine.play(true);
  assert.equal(b.ids.get('after-studio-room').classList.contains('is-handoff'), true);
  b.replaceAfter({ version: 2, source: { kind: 'empty' }, sentences: [], post: null, post_status: { reason: 'source_changed' } });
  assert.equal(b.ids.get('after-studio-item-count').textContent, '0');
  assert.ok(!b.ids.get('after-studio-items').textContent.includes(fixture.post.items[0].title));
  assert.ok(!b.ids.get('after-inspector-content').textContent.includes(fixture.post.items[0].title));
  assert.ok(!b.ids.get('after-result-copy').textContent.includes(fixture.post.overview));
  assert.equal(b.ids.get('after-studio-room').classList.contains('is-handoff'), false);
  assert.equal(engine.state().playing, false);
});

test('bootstrap preserves 401 and exhausted 503 root causes instead of declaring its requested run missing', async () => {
  for (const status of [401, 503]) {
    const b = await browser({ privatePage: true, run: 'vm-run', routes: { './api/meetings': { status } } });
    assert.equal(b.window.OopsReplay.state().data.source.kind, 'empty');
    assert.match(b.ids.get('history-status').textContent, status === 401 ? /无读取权限/ : /HTTP 503/);
    assert.doesNotMatch(b.ids.get('history-status').textContent, /指定的重新分析/);
    assert.equal(b.requests.filter(request => request.url === './api/meetings').length, status === 401 ? 1 : 3);
    assert.equal(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length, 0);
    assert.ok(b.delays.every(delay => delay <= 1500));
  }
});

test('a failed reanalysis listing preserves the service error and can later restore the URL target by refresh', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run', routes: { './api/reanalyses': { status: 503 } } });
  assert.match(b.ids.get('history-status').textContent, /HTTP 503/);
  assert.doesNotMatch(b.ids.get('history-status').textContent, /指定的重新分析/);
  assert.equal(b.requests.filter(request => request.url === './api/reanalyses').length, 3);
  b.clearRoute('./api/reanalyses'); b.ids.get('history-refresh').click(); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'reanalysis');
  assert.equal(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length, 1);
  assert.equal(b.ids.get('reanalysis-run').disabled, false);
});

test('a failed meeting listing restores exactly the URL target after successful manual refresh', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run', routes: { './api/meetings': { status: 503 } } });
  b.clearRoute('./api/meetings'); b.ids.get('history-refresh').click(); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'reanalysis');
  assert.equal(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length, 1);
  assert.equal(b.ids.get('reanalysis-run').value, 'vm-run');
});

test('GET network failures and transient statuses have at most two short rereads', async () => {
  for (const status of [429, 502, 504]) {
    const b = await browser({ privatePage: true, run: 'vm-run', routes: { './api/meetings': { status } } });
    assert.equal(b.requests.filter(request => request.url === './api/meetings').length, 3);
    assert.deepEqual(b.delays, [500, 1000]);
    assert.match(b.ids.get('history-status').textContent, new RegExp('HTTP ' + status));
  }
  let attempts = 0;
  const b = await browser({ privatePage: true, run: 'vm-run', routes: { './api/meetings': () => ++attempts < 3 ? new TypeError('synthetic offline') : undefined } });
  assert.equal(attempts, 3);
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'reanalysis');
  assert.deepEqual(b.delays, [500, 1000]);
});

test('invitation exchange and logout never automatically retry POST or DELETE', async () => {
  const invited = await browser({ privatePage: true, run: 'vm-run', hash: '#invite=synthetic', routes: { './api/session': { status: 503 } } });
  assert.equal(invited.requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(invited.delays.length, 0);
  const b = await browser({ privatePage: true, run: 'vm-run' });
  b.setRoute('./api/session', { status: 503 }); b.ids.get('history-disconnect').click(); await flush();
  assert.equal(b.requests.filter(request => request.options.method === 'DELETE').length, 1);
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'example');
  assert.equal(b.delays.length, 0);
});

test('choosing the example cancels deferred URL restoration after a temporary bootstrap failure', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run', routes: { './api/meetings': { status: 503 } } });
  b.ids.get('history-example').click(); await flush();
  b.clearRoute('./api/meetings'); b.ids.get('history-refresh').click(); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'example');
  assert.equal(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length, 0);
});

test('list refresh and a newer explicit meeting selection cannot lock controls or overwrite the selected meeting', async () => {
  const meetings = [{ session_id: 'other', title: 'Synthetic other meeting', utterance_count: fixture.sentences.length }];
  const b = await browser({ privatePage: true, run: 'vm-run', routes: { './api/meetings': { body: { meetings } } } });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  b.setRoute('./api/meetings', () => pending);
  b.ids.get('history-refresh').click();
  assert.equal(b.ids.get('history-meeting').disabled, true);
  assert.equal(b.ids.get('reanalysis-run').disabled, true);
  b.setRoute('./api/meetings/other', { body: { ...structuredClone(fixture), source: { kind: 'history', label: 'Explicit selection' } } });
  // A user action already queued before disabling must still take precedence.
  b.ids.get('history-meeting').value = 'other'; b.ids.get('history-meeting').dispatchEvent({ type: 'change' }); await flush();
  release({ body: { meetings } }); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'Explicit selection');
  assert.equal(b.ids.get('history-meeting').disabled, false);
  assert.equal(b.ids.get('reanalysis-run').disabled, false);
  assert.equal(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length, 1);
  let releaseStale;
  const stale = new Promise(resolve => { releaseStale = resolve; });
  b.setRoute('./api/meetings', () => stale); b.ids.get('history-refresh').click();
  b.ids.get('history-meeting').value = 'other'; b.ids.get('history-meeting').dispatchEvent({ type: 'change' }); await flush();
  releaseStale({ body: { meetings: [] } }); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'Explicit selection');
});

test('logout invalidates delayed list responses and cannot resurrect private data or reenable selectors', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run' });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  b.setRoute('./api/meetings', () => pending); b.ids.get('history-refresh').click();
  b.ids.get('history-disconnect').click(); await flush();
  release({ body: { meetings: [{ session_id: 'stale', title: 'Stale private title' }] } }); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'example');
  assert.equal(b.ids.get('history-meeting').disabled, true);
  assert.equal(b.ids.get('reanalysis-run').disabled, true);
  assert.ok(!b.ids.get('history-meeting').textContent.includes('Stale private title'));
});

test('a delayed private detail cannot replace a newer explicit example selection', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run' });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  b.setRoute('./api/reanalyses/vm-run', () => pending);
  b.ids.get('reanalysis-run').dispatchEvent({ type: 'change' });
  b.ids.get('history-example').click(); await flush();
  release({ body: { ...structuredClone(fixture), source: { kind: 'reanalysis', label: 'Stale result' } } }); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'example');
});

test('a loaded run is cleared after failed revalidation and restored only after a fresh authorized ready listing', async () => {
  for (const status of [401, 503]) {
    const b = await browser({ privatePage: true, run: 'vm-run' });
    assert.equal(b.window.OopsReplay.state().data.source.kind, 'reanalysis');
    b.setRoute('./api/reanalyses/vm-run', { status });
    b.window.dispatchEvent({ type: 'focus' }); await flush();
    assert.equal(b.window.OopsReplay.state().data.source.kind, 'empty');
    assert.equal(b.window.OopsReplay.state().sentences.length, 0);
    assert.match(b.ids.get('history-status').textContent, status === 401 ? /无读取权限/ : /HTTP 503/);
    b.clearRoute('./api/reanalyses/vm-run'); b.ids.get('history-refresh').click(); await flush();
    assert.equal(b.window.OopsReplay.state().data.source.kind, 'reanalysis');
    assert.equal(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length, status === 401 ? 3 : 5);
  }
});

test('after progress captures the chosen target before pausing redraws the slider', async () => {
  const b = await browser({ afterStudio: true });
  const engine = b.window.OopsAfterReplay;
  b.ids.get('tab-after').click(); engine.play(true);
  const requests = b.requests.length, duration = engine.state().duration;
  const slider = b.ids.get('after-studio-scrub');
  slider.value = '1000'; slider.dispatchEvent({ type: 'input' });
  assert.equal(engine.state().now, duration);
  assert.equal(engine.state().phase, 'complete');
  assert.equal(engine.state().playing, false);
  slider.value = '500'; slider.dispatchEvent({ type: 'input' });
  assert.equal(engine.state().now, duration / 2);
  assert.equal(b.requests.length, requests);
});
