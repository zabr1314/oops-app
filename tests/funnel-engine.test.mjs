import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const fixture = JSON.parse(readFileSync('public/funnel-sample.json', 'utf8'));
const source = readFileSync('public/funnel.js', 'utf8');
const afterSource = readFileSync('public/funnel-after.js', 'utf8');
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

async function browser({ privatePage = false, run = '', meeting = '', follow = false, hash = '#live', routes = {}, after = true, reduceMotion = false, useAbort = false, visibleCanvas = false, initialTime = 10000 } = {}) {
  const ids = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  ids.get('mode-after').hidden = true;
  for (const id of ['tab-live', 'tab-after']) ids.get(id).dataset.mode = id.slice(4);
  const tabs = [ids.get('tab-live'), ids.get('tab-after')];
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
  document.querySelectorAll = selector => selector === '.modes button' ? tabs : selector === '#pipeline li' ? pipeline : [];
  let paintCount = 0;
  const paintCalls = new Map();
  const canvasContext = new Proxy({ measureText: text => ({ width: String(text).length * 7 }) }, {
    get: (obj, key) => obj[key] || ((...args) => {
      if (key === 'drawImage' && !(args[0].width > 0 && args[0].height > 0)) throw new Error('InvalidStateError: zero-sized canvas');
      paintCount++; paintCalls.set(key, (paintCalls.get(key) || 0) + 1);
    }), set: (obj, key, value) => { obj[key] = value; return true; },
  });
  for (const id of ['canvas', 'after-canvas']) ids.get(id).getContext = () => canvasContext;
  if (visibleCanvas) {
    const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
    ids.get('stage').getBoundingClientRect = () => rect(0, 0, 1000, 600);
    ids.get('transcript').getBoundingClientRect = () => rect(0, 0, 400, 500);
    ids.get('fan').getBoundingClientRect = () => rect(400, 0, 300, 500);
    [...cards.values()].forEach((card, index) => { card.getBoundingClientRect = () => rect(750, index * 120, 200, 100); });
    document.createElement = tag => { const element = new Element(tag); if (tag === 'canvas') element.getContext = () => canvasContext; return element; };
  }
  const window = new Target(); window.matchMedia = () => ({ matches: reduceMotion }); window.devicePixelRatio = 1;
  const query = new URLSearchParams(); if (run) query.set('run', run); if (meeting) query.set('meeting', meeting); if (follow) query.set('follow', '1');
  const location = { pathname: privatePage ? '/oops-meeting/history/' : '/funnel.html', hash, search: query.size ? '?' + query : '' };
  const frames = [], requests = [], events = [], delays = [], intervals = [], resizeObservers = new Map();
  const timeouts = new Map(); let timeoutId = 100;
  const overrides = new Map(Object.entries(routes));
  for (const name of ['funnel:data', 'funnel:tick', 'funnel:selection', 'funnel:play', 'funnel:mode', 'funnel:after-data', 'funnel:after-tick', 'funnel:after-play']) document.addEventListener(name, event => events.push({ type: name, detail: event.detail }));
  const response = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name] || null }, json: async () => structuredClone(body) });
  const reanalysis = { ...structuredClone(fixture), source: { kind: 'reanalysis', label: 'VM fixture', snapshot_hash: 'one' } };
  let authorized = true;
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (overrides.has(url)) {
      const route = overrides.get(url);
      const value = typeof route === 'function' ? await route({ url, options }) : route;
      if (value instanceof Error) throw value;
      if (value !== undefined) return response(value.body ?? {}, value.status ?? 200, value.headers);
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
  let currentTime = initialTime;
  const context = vm.createContext({
    window, document, location, fetch, URLSearchParams, console, ...(useAbort ? { AbortController } : {}), performance: { now: () => currentTime },
    history: { replaceState: (_, __, hash) => { if (hash.startsWith('#')) location.hash = hash; } },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(element) { resizeObservers.set(element, this.callback); }
    }, getComputedStyle: () => ({ fontFamily: 'sans-serif' }),
    requestAnimationFrame: fn => frames.push(fn), setInterval: (fn, delay) => { intervals.push({ fn, delay }); return intervals.length; }, setTimeout: (fn, delay) => { if (delay === 15000) { timeouts.set(++timeoutId, fn); return timeoutId; } delays.push(delay); fn(); return 1; }, clearTimeout: id => timeouts.delete(id),
  });
  vm.runInContext(source, context, { filename: 'public/funnel.js' });
  if (after) vm.runInContext(afterSource, context, { filename: 'public/funnel-after.js' });
  await flush();
  return {
    window, document, ids, requests, events, location, delays, paintCalls,
    get paints() { return paintCount; },
    revoke: () => { authorized = false; },
    setRoute: (url, route) => overrides.set(url, route),
    clearRoute: url => overrides.delete(url),
    replaceAfter: detail => document.dispatchEvent({ type: 'funnel:data', detail }),
    setTime: time => { currentTime = time; },
    frame: time => { const pending = frames.splice(0); for (const fn of pending) fn(time); },
    interval: delay => { intervals.filter(i => i.delay === delay).forEach(i => i.fn()); },
    timeout: () => { [...timeouts.values()].forEach(fn => fn()); },
    resizeStage: (width, height) => {
      const stage = ids.get('stage');
      stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height });
      resizeObservers.get(stage)?.();
    },
  };
}

function scrollingFixture({ step = 1000, spoken = 500 } = {}) {
  return { version: 2, source: { kind: 'history', label: 'Scrolling fixture' }, sentences: Array.from({ length: 12 }, (_, index) => ({
    id: 'scroll-' + index, text: '这一句应随播放进度保持可见。', speaker: '甲',
    start_ms: index * step, end_ms: index * step + spoken, route: 'code',
    forks: [{ layer: 'code', ms: 1, settled: true }],
  })) };
}

function transcriptLayout(b, { top = 230, clientTop = 3, rowHeight = 80, bottomPadding = 36, ancestorOffset = 40 } = {}) {
  const box = b.ids.get('transcript');
  box.clientHeight = 200; box.clientTop = clientTop;
  const rect = (y, height) => ({ left: 0, right: 400, top: y, bottom: y + height, width: 400, height });
  box.getBoundingClientRect = () => rect(top, box.clientHeight + 2 * clientTop);
  Object.defineProperty(box, 'scrollHeight', { get: () => Math.max(box.clientHeight, box.children.filter(row => !row.hidden).length * rowHeight + bottomPadding) });
  box.scrollTo = ({ top: next }) => { box.scrollTop = Math.min(Math.max(0, next), box.scrollHeight - box.clientHeight); };
  box.children.forEach((row, index) => {
    // offsetTop belongs to a separate positioned ancestor; the viewport rect
    // and scroll offset are the reliable coordinates for this scroller.
    row.offsetTop = index * rowHeight + ancestorOffset;
    row.getBoundingClientRect = () => rect(top + clientTop + box.children.slice(0, index).filter(item => !item.hidden).length * rowHeight - box.scrollTop, rowHeight);
  });
  return box;
}

function assertRowVisible(row, box) {
  const rowBounds = row.getBoundingClientRect(), boxBounds = box.getBoundingClientRect();
  assert.ok(rowBounds.top >= boxBounds.top + box.clientTop, 'the current sentence starts inside its own scroll viewport');
  assert.ok(rowBounds.bottom <= boxBounds.top + box.clientTop + box.clientHeight, 'the current sentence ends inside its own scroll viewport');
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
  assert.match(b.ids.get('after-cost').textContent, /本次 Jev 重新分析没有重新生成纪要/);
  assert.match(b.ids.get('after-cost').textContent, /历史回执摘要/);
  assert.match(b.ids.get('after-cost').textContent, /不表示本页执行过发送/);
  assert.doesNotMatch(b.ids.get('after-cost').textContent, /本次已发送/);
});

test('the restored terminal shows complete recorded probabilities and clears them after permission loss', async () => {
  const result = structuredClone(fixture);
  result.source = { kind: 'reanalysis', label: 'Synthetic recorded result' };
  const fork = result.sentences[0].forks.find(value => value.layer === 'jev');
  assert.ok(fork);
  Object.assign(fork, { request: { state: { text: result.sentences[0].text } }, criteria: { decision: '明确决定', other: '其他' }, probabilities: { decision: .83, other: .17 }, choice: 'decision' });
  const b = await browser({ privatePage: true, run: 'vm-run', routes: { './api/reanalyses/vm-run': { body: result } } });
  b.window.OopsReplay.select(0);
  assert.match(b.ids.get('source-badge').textContent, /重新分析/);
  assert.match(b.ids.get('stream').textContent, /全部选项概率/);
  assert.match(b.ids.get('stream').textContent, /0\.83/);
  assert.match(b.ids.get('stream').textContent, /0\.17/);
  b.window.OopsAfterReplay.seek(b.window.OopsAfterReplay.state().total);
  assert.ok(b.ids.get('board-task').textContent.includes(fixture.post.items.find(item => item.kind === 'task').title));
  b.clearRoute('./api/reanalyses/vm-run');
  b.revoke(); b.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(b.ids.get('stream').textContent, '还没有判断记录。');
  assert.equal(b.ids.get('transcript').children.length, 0);
  assert.equal(b.ids.get('board-task').children.length, 0);
  assert.equal(b.ids.get('overview').textContent, '');
  assert.equal(b.window.OopsAfterReplay.state().playing, false);
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

test('the restored after controls replay stored items with explicit play, speed and restart', async () => {
  const b = await browser();
  const engine = b.window.OopsAfterReplay;
  b.ids.get('tab-after').click();
  assert.equal(engine.state().playing, false);
  const requests = b.requests.length, duration = engine.state().duration;
  b.ids.get('after-play').click();
  assert.equal(engine.state().playing, true);
  b.ids.get('after-speed').value = '2'; b.ids.get('after-speed').dispatchEvent({ type: 'change' });
  assert.equal(engine.state().speed, 2);
  engine.seek(duration);
  assert.equal(engine.state().now, duration);
  assert.equal(engine.state().phase, 'complete');
  assert.equal(engine.state().playing, false);
  b.ids.get('after-restart').click();
  assert.equal(engine.state().now, 0);
  assert.equal(engine.state().playing, true);
  assert.equal(b.requests.length, requests);
});

test('the only readable meeting still opens automatically on the restored history page', async () => {
  const saved = { ...structuredClone(fixture), source: { kind: 'replay', label: 'Only readable replay' } };
  const b = await browser({ privatePage: true, routes: {
    './api/meetings': { body: { meetings: [{ session_id: 'only-replay', title: 'Only readable replay', utterance_count: fixture.sentences.length }] } },
    './api/meetings/only-replay': { body: saved },
  } });
  assert.equal(b.window.OopsReplay.state().data.source.label, 'Only readable replay');
  assert.equal(b.ids.get('source-badge').textContent, '事后分析 · 只读');
  assert.equal(b.ids.get('history-meeting').value, 'only-replay');
  assert.equal(b.window.OopsReplay.state().playing, false);
  assert.equal(b.requests.filter(request => request.url === './api/meetings/only-replay').length, 1);
});

test('full-chain results keep deployed metadata separate and describe recorded DeepSeek generation', async () => {
  const saved = structuredClone(fixture);
  saved.source = { kind: 'reanalysis', label: 'Full chain', deepseek_run: 'ds-run', request_count: 20 };
  saved.pipeline = { scope: 'workspace_source', minutes_configured_runs: 9 };
  saved.post.generation = { evidence: 'reanalysis', recorded_calls: 3, successful_runs: 3 };
  const b = await browser({ privatePage: true, routes: {
    './api/pipeline': { body: { scope: 'deployed_source', minutes_configured_runs: 3, asr_review_supported: false } },
    './api/meetings': { body: { meetings: [{ session_id: 'full', utterance_count: saved.sentences.length }] } },
    './api/meetings/full': { body: saved },
  } });
  assert.match(b.ids.get('source-badge').textContent, /Jev \/ DeepSeek/);
  assert.match(b.ids.get('pipeline-note').textContent, /已部署源码.*3 次/);
  assert.match(b.ids.get('minutes-generation').textContent, /部署源码：3 次/);
  assert.match(b.ids.get('asr-review-note').textContent, /当前部署源码未包含/);
  assert.match(b.ids.get('after-note').textContent, /DeepSeek 新生成/);
  assert.match(b.ids.get('after-cost').textContent, /本次重新分析的已存纪要生成调用/);
  assert.equal(b.window.OopsReplay.state().data.pipeline.minutes_configured_runs, 9);
  assert.ok(!b.requests.some(r => r.url === './funnel-sample.json'));
});

test('conditional revalidation preserves playback on 304 and still clears on permission loss', async () => {
  const saved = { ...structuredClone(fixture), source: { kind: 'replay', label: 'Conditional', snapshot_hash: 'one' } };
  const b = await browser({ privatePage: true, routes: {
    './api/meetings': { body: { meetings: [{ session_id: 'conditional', utterance_count: saved.sentences.length }] } },
    './api/meetings/conditional': { body: saved, headers: { ETag: '"saved-one"' } },
  } });
  b.window.OopsReplay.seek(1000);
  const events = b.events.filter(e => e.type === 'funnel:data').length;
  b.setRoute('./api/meetings/conditional', ({ options }) => {
    assert.equal(options.headers['If-None-Match'], '"saved-one"');
    return { status: 304 };
  });
  b.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(b.window.OopsReplay.state().now, 1000);
  assert.equal(b.events.filter(e => e.type === 'funnel:data').length, events);
  b.setRoute('./api/meetings/conditional', { status: 403 });
  b.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  assert.equal(b.window.OopsAfterReplay.state().items.length, 0);
});

test('live updates follow new saved sentences, pause on selection, preserve the selected sentence and clear on revoke', async () => {
  const saved = structuredClone(fixture);
  saved.source = { kind: 'history', session_id: 'ongoing', snapshot_hash: 'live-one', live: { active: true, last_sync_at: '2026-10-16T03:00:00Z' } };
  const b = await browser({ privatePage: true, meeting: 'ongoing', routes: {
    './api/meetings': { body: { meetings: [{ session_id: 'ongoing', is_live: true }, { session_id: 'other' }] } },
    './api/meetings/ongoing': { body: saved },
  } });
  assert.equal(b.ids.get('live-follow').getAttribute('aria-pressed'), 'true');
  assert.equal(b.window.OopsReplay.state().now, b.window.OopsReplay.state().duration);
  const next = structuredClone(saved);
  next.source.snapshot_hash = 'live-two';
  next.sentences.push({ ...structuredClone(saved.sentences.at(-1)), id: 'new-one', start_ms: 200000, end_ms: 201000 });
  b.setRoute('./api/meetings/ongoing', { body: next });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, next.sentences.length);
  assert.equal(b.window.OopsReplay.state().now, b.window.OopsReplay.state().duration);
  b.window.OopsReplay.select(3);
  const position = b.window.OopsReplay.state().now;
  assert.equal(b.ids.get('live-follow').getAttribute('aria-pressed'), 'false');
  const ended = structuredClone(next); ended.source.snapshot_hash = 'ended'; ended.source.live.active = false; ended.source.live.ended_at = '2026-10-16T04:00:00Z';
  b.setRoute('./api/meetings/ongoing', { body: ended });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().selected, 3);
  assert.equal(b.window.OopsReplay.state().now, position);
  assert.match(b.ids.get('live-status').textContent, /已结束/);
  b.setRoute('./api/meetings/ongoing', { status: 403 });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  assert.equal(b.ids.get('live-follow').hidden, true);
});

test('a live meeting link never reads a meeting absent from the authorized list', async () => {
  const b = await browser({ privatePage: true, meeting: 'unlisted', follow: true });
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  assert.ok(!b.requests.some(r => r.url === './api/meetings/unlisted'));
  assert.match(b.ids.get('history-status').textContent, /指定会话当前不可读取/);
});

test('meeting links load independently of the reanalysis list and recover the intended meeting after detail failure', async () => {
  const saved = { ...structuredClone(fixture), source: { kind: 'history', label: 'Chosen meeting' } };
  const b = await browser({ privatePage: true, meeting: 'chosen', routes: {
    './api/meetings': { body: { meetings: [{ session_id: 'chosen' }, { session_id: 'other' }] } },
    './api/reanalyses': { status: 503 },
    './api/meetings/chosen': { status: 503 },
  } });
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  b.setRoute('./api/meetings/chosen', { body: saved });
  b.ids.get('history-refresh').click(); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'Chosen meeting');
  assert.match(b.ids.get('history-status').textContent, /当前会话仍可读取/);
});

test('a hung live read times out, clears private content and can be restored by refresh', async () => {
  const saved = { ...structuredClone(fixture), source: { kind: 'history', label: 'Live timeout', live: { active: true }, snapshot_hash: 'timeout-one' } };
  const b = await browser({ privatePage: true, meeting: 'live-timeout', useAbort: true, routes: {
    './api/meetings': { body: { meetings: [{ session_id: 'live-timeout' }, { session_id: 'other' }] } },
    './api/meetings/live-timeout': { body: saved },
  } });
  b.setRoute('./api/meetings/live-timeout', ({ options }) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  b.interval(5000); await flush();
  b.timeout(); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  assert.match(b.ids.get('history-status').textContent, /超时/);
  b.setRoute('./api/meetings/live-timeout', { body: saved });
  b.ids.get('history-refresh').click(); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'Live timeout');
});

test('automatic mode discovers the next server meeting and switches without a refresh or fixed ID', async () => {
  const row = (id, time) => ({ session_id: id, started_at: time, is_live: true });
  const saved = id => ({ ...structuredClone(fixture), source: { kind: 'history', label: id, session_id: id, live: { active: true }, snapshot_hash: id } });
  const list = meetings => ({ body: { auto_connect: { enabled: true }, meetings } });
  const b = await browser({ privatePage: true, routes: {
    './api/meetings': list([row('first', '2026-10-16T05:00:00Z')]),
    './api/meetings/first': { body: saved('first') },
    './api/meetings/next': { body: saved('next') },
  } });
  assert.equal(b.window.OopsReplay.state().data.source.label, 'first');
  assert.equal(b.ids.get('history-auto').getAttribute('aria-pressed'), 'true');
  b.setRoute('./api/meetings', list([row('next', '2026-10-16T05:10:00Z'), row('first', '2026-10-16T05:00:00Z')]));
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'next');
  assert.equal(b.window.OopsReplay.state().now, b.window.OopsReplay.state().duration);
  b.window.OopsReplay.select(0);
  b.setRoute('./api/meetings/newer', { body: saved('newer') });
  b.setRoute('./api/meetings', list([row('newer', '2026-10-16T05:20:00Z'), row('next', '2026-10-16T05:10:00Z')]));
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'next');
  assert.equal(b.window.OopsReplay.state().selected, 0);
  assert.ok(b.ids.get('history-meeting').options.some(o => o.value === 'newer'));
  b.ids.get('history-auto').click(); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'newer');
});

test('automatic mode waits for the first recording and ignores delayed discovery after choosing the example', async () => {
  const saved = { ...structuredClone(fixture), source: { kind: 'history', label: 'First arrival', live: { active: true } } };
  const b = await browser({ privatePage: true, routes: {
    './api/meetings': { body: { auto_connect: { enabled: true }, meetings: [] } },
    './api/meetings/arrival': { body: saved },
  } });
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  let resolveList;
  b.setRoute('./api/meetings', () => new Promise(resolve => { resolveList = resolve; }));
  b.interval(5000); await flush();
  b.ids.get('history-example').click(); await flush();
  resolveList({ body: { auto_connect: { enabled: true }, meetings: [{ session_id: 'arrival', started_at: '2026-10-16T05:10:00Z' }] } }); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'example');
  assert.ok(!b.requests.some(r => r.url === './api/meetings/arrival'));
  b.setRoute('./api/meetings', { status: 503 });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'example');
});

test('automatic detail failures retry from a fresh authorized list and scope removal clears current content', async () => {
  const entry = { session_id: 'retry-live', started_at: '2026-10-16T05:10:00Z' };
  const saved = { ...structuredClone(fixture), source: { kind: 'history', label: 'Recovered auto', live: { active: true } } };
  const b = await browser({ privatePage: true, routes: {
    './api/meetings': { body: { auto_connect: { enabled: true }, meetings: [entry] } },
    './api/meetings/retry-live': { status: 503 },
  } });
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  b.setRoute('./api/meetings/retry-live', { body: saved });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'Recovered auto');
  b.setRoute('./api/meetings', { body: { auto_connect: { enabled: true }, meetings: [] } });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
});

test('transient detail failures automatically reread authorization and restore replay position, speed and play', async () => {
  for (const failure of [new TypeError('synthetic offline'), { status: 429 }, { status: 503 }]) {
    const b = await browser({ privatePage: true, run: 'vm-run' });
    const engine = b.window.OopsReplay;
    engine.seek(23000); engine.setSpeed(30); engine.play(true);
    b.setRoute('./api/reanalyses/vm-run', failure);
    b.window.dispatchEvent({ type: 'focus' }); await flush();
    assert.equal(engine.state().sentences.length, 0);
    assert.equal(engine.state().playing, false);
    assert.equal(b.window.OopsAfterReplay.state().items.length, 0);
    b.clearRoute('./api/reanalyses/vm-run');
    b.interval(5000); await flush();
    assert.equal(engine.state().data.source.kind, 'reanalysis');
    assert.equal(engine.state().now, 23000);
    assert.equal(engine.state().speed, 30);
    assert.equal(engine.state().playing, true);
    b.frame(100); b.frame(200);
    assert.ok(engine.state().now > 23000);
  }
});

test('a hung detail read clears private content, then reconnects automatically without losing the replay position', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run', useAbort: true });
  const engine = b.window.OopsReplay;
  engine.seek(18000); engine.setSpeed(10); engine.play(true);
  b.setRoute('./api/reanalyses/vm-run', ({ options }) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  b.window.dispatchEvent({ type: 'focus' }); await flush();
  b.timeout(); await flush();
  assert.equal(engine.state().sentences.length, 0);
  assert.match(b.ids.get('history-status').textContent, /超时/);
  b.clearRoute('./api/reanalyses/vm-run');
  b.interval(5000); await flush();
  assert.equal(engine.state().now, 18000);
  assert.equal(engine.state().speed, 10);
  assert.equal(engine.state().playing, true);
});

test('authorization loss or source removal clears content and cancels automatic replay recovery', async () => {
  for (const status of [401, 403, 404, 410]) {
    const b = await browser({ privatePage: true, run: 'vm-run' });
    b.window.OopsReplay.seek(18000); b.window.OopsReplay.play(true);
    b.setRoute('./api/reanalyses/vm-run', { status });
    b.window.dispatchEvent({ type: 'focus' }); await flush();
    assert.equal(b.window.OopsReplay.state().sentences.length, 0);
    assert.equal(b.window.OopsAfterReplay.state().items.length, 0);
    const count = b.requests.filter(r => r.url === './api/reanalyses/vm-run').length;
    b.clearRoute('./api/reanalyses/vm-run');
    b.interval(5000); await flush();
    b.window.dispatchEvent({ type: 'focus' }); await flush();
    assert.equal(b.window.OopsReplay.state().sentences.length, 0);
    assert.equal(b.requests.filter(r => r.url === './api/reanalyses/vm-run').length, count);
  }
});

test('leaving an interrupted source cancels recovery and ignores its delayed successful response', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run' });
  b.setRoute('./api/reanalyses/vm-run', { status: 503 });
  b.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  let resolveRecovery;
  b.setRoute('./api/reanalyses/vm-run', () => new Promise(resolve => { resolveRecovery = resolve; }));
  b.interval(5000); await flush();
  assert.equal(typeof resolveRecovery, 'function');
  b.ids.get('history-example').click(); await flush();
  resolveRecovery({ body: { ...structuredClone(fixture), source: { kind: 'reanalysis', label: 'Old interrupted source' } } }); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'example');
  const count = b.requests.filter(r => r.url === './api/reanalyses/vm-run').length;
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.kind, 'example');
  assert.equal(b.requests.filter(r => r.url === './api/reanalyses/vm-run').length, count);
});

test('temporary discovery failure verifies the current detail without interrupting an authorized replay', async () => {
  const saved = { ...structuredClone(fixture), source: { kind: 'history', session_id: 'verified', label: 'Verified source', snapshot_hash: 'verified-one' } };
  const b = await browser({ privatePage: true, routes: {
    './api/meetings': { body: { auto_connect: { enabled: true }, meetings: [{ session_id: 'verified', started_at: '2026-10-16T05:10:00Z' }] } },
    './api/meetings/verified': { body: saved },
  } });
  b.window.OopsReplay.seek(27000); b.window.OopsReplay.setSpeed(5); b.window.OopsReplay.play(true);
  const dataEvents = b.events.filter(e => e.type === 'funnel:data').length;
  const reads = b.requests.filter(r => r.url === './api/meetings/verified').length;
  b.setRoute('./api/meetings', { status: 503 });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.label, 'Verified source');
  assert.equal(b.window.OopsReplay.state().now, 27000);
  assert.equal(b.window.OopsReplay.state().speed, 5);
  assert.equal(b.window.OopsReplay.state().playing, true);
  assert.equal(b.events.filter(e => e.type === 'funnel:data').length, dataEvents);
  assert.ok(b.requests.filter(r => r.url === './api/meetings/verified').length > reads);
});

test('discovery and detail interruption clears the snapshot and recovers the same manually selected position', async () => {
  const saved = { ...structuredClone(fixture), source: { kind: 'history', session_id: 'both-fail', snapshot_hash: 'both-one' } };
  const list = { body: { auto_connect: { enabled: true }, meetings: [{ session_id: 'both-fail', started_at: '2026-10-16T05:10:00Z' }] } };
  const b = await browser({ privatePage: true, routes: {
    './api/meetings': list,
    './api/meetings/both-fail': { body: saved },
  } });
  // A manual play operation pauses automatic source switching while keeping discovery active.
  b.ids.get('play').click(); b.window.OopsReplay.seek(19000); b.window.OopsReplay.setSpeed(10); b.window.OopsReplay.play(true);
  b.setRoute('./api/meetings', { status: 503 });
  b.setRoute('./api/meetings/both-fail', { status: 503 });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  b.setRoute('./api/meetings', list); b.setRoute('./api/meetings/both-fail', { body: saved });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().data.source.session_id, 'both-fail');
  assert.equal(b.window.OopsReplay.state().now, 19000);
  assert.equal(b.window.OopsReplay.state().speed, 10);
  assert.equal(b.window.OopsReplay.state().playing, true);
});

test('same-source after updates preserve time, speed and play while a different source resets them', async () => {
  const b = await browser();
  const saved = { ...structuredClone(fixture), source: { kind: 'history', session_id: 'after-same', snapshot_hash: 'after-one' } };
  b.replaceAfter(saved); b.ids.get('tab-after').click();
  const engine = b.window.OopsAfterReplay;
  engine.seek(7000); engine.setSpeed(4); engine.play(true);
  const next = structuredClone(saved);
  next.source.snapshot_hash = 'after-two';
  next.post.overview = 'A newer stored overview for the same source.';
  b.replaceAfter(next);
  assert.equal(engine.state().now, 7000);
  assert.equal(engine.state().speed, 4);
  assert.equal(engine.state().playing, true);
  assert.match(b.ids.get('overview').textContent, /newer stored overview/);
  b.frame(100); b.frame(200);
  assert.ok(engine.state().now > 7000);
  next.source.session_id = 'after-different';
  b.replaceAfter(next);
  assert.equal(engine.state().now, 0);
  assert.equal(engine.state().playing, false);
});

test('run list reconnect keeps an independently authorized replay playing at its current position', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run' });
  const engine = b.window.OopsReplay;
  engine.seek(26000); engine.setSpeed(5); engine.play(true);
  const reads = b.requests.filter(request => request.url === './api/reanalyses/vm-run').length;
  const loads = b.events.filter(event => event.type === 'funnel:data').length;
  b.setRoute('./api/meetings', { status: 503 });
  b.ids.get('history-refresh').click(); await flush();
  assert.equal(engine.state().now, 26000);
  assert.equal(engine.state().playing, true);
  assert.ok(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length > reads);
  b.clearRoute('./api/meetings');
  b.interval(5000); await flush();
  assert.equal(engine.state().now, 26000);
  assert.equal(engine.state().speed, 5);
  assert.equal(engine.state().playing, true);
  assert.equal(b.events.filter(event => event.type === 'funnel:data').length, loads);
});

test('malformed recovery data clears private content and explicitly stops reconnecting', async () => {
  const b = await browser({ privatePage: true, run: 'vm-run' });
  b.setRoute('./api/reanalyses/vm-run', { status: 503 });
  b.window.dispatchEvent({ type: 'focus' }); await flush();
  b.setRoute('./api/reanalyses/vm-run', { body: { version: 99, sentences: [] } });
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  assert.equal(b.window.OopsAfterReplay.state().items.length, 0);
  assert.match(b.ids.get('history-status').textContent, /格式异常.*已停止恢复/);
  assert.doesNotMatch(b.ids.get('history-status').textContent, /正在自动重连/);
  const reads = b.requests.filter(request => request.url === './api/reanalyses/vm-run').length;
  b.clearRoute('./api/reanalyses/vm-run');
  b.interval(5000); await flush();
  assert.equal(b.window.OopsReplay.state().sentences.length, 0);
  assert.equal(b.requests.filter(request => request.url === './api/reanalyses/vm-run').length, reads);
});

test('nonzero canvas handles empty text and malformed probability while paused frames reuse stable strands', async () => {
  const saved = structuredClone(fixture);
  saved.sentences[0].text = '';
  saved.sentences[0].forks[0].p = 'unrecorded';
  const b = await browser({ visibleCanvas: true, after: false, routes: { './funnel-sample.json': { body: saved } } });
  const engine = b.window.OopsReplay;
  engine.seek(engine.state().duration);
  assert.equal(engine.state().sentences[0].forks[0].p, null);
  assert.doesNotMatch(b.ids.get('source-note').textContent, /回放显示暂时中断/);
  const strands = b.paintCalls.get('quadraticCurveTo') || 0;
  assert.ok(strands > 0);
  const pausedPaints = b.paints;
  b.frame(100); b.frame(200);
  assert.equal(b.paints, pausedPaints);
  b.ids.get('transcript').dispatchEvent({ type: 'scroll' }); b.frame(300);
  assert.ok(b.paints > pausedPaints);
  assert.equal(b.paintCalls.get('quadraticCurveTo'), strands);
  assert.equal(engine.state().playing, false);
});

test('hidden-panel resizing preserves the live canvas until its visible layout returns', async () => {
  const b = await browser({ visibleCanvas: true });
  const engine = b.window.OopsReplay, canvas = b.ids.get('canvas');
  engine.seek(20000);
  const visibleBounds = b.ids.get('stage').getBoundingClientRect();
  assert.ok(b.paintCalls.get('drawImage') > 0);
  b.ids.get('tab-after').click();
  b.resizeStage(0, 0);
  assert.equal(canvas.width, 1000);
  assert.equal(canvas.height, 600);
  // The panel is visible before ResizeObserver delivers its next layout notification.
  b.ids.get('stage').getBoundingClientRect = () => visibleBounds;
  b.ids.get('tab-live').click(); engine.play(true);
  const before = engine.state().now;
  b.frame(100); b.frame(200);
  assert.ok(engine.state().now > before);
  assert.equal(engine.state().playing, true);
  assert.doesNotMatch(b.ids.get('source-note').textContent, /回放显示暂时中断/);
  b.resizeStage(1000, 600); b.frame(300);
  assert.equal(engine.state().playing, true);
});

test('60x playback follows the latest transcript row when brief thinking states and the final frame are skipped', async () => {
  const b = await browser({ after: false, routes: { './funnel-sample.json': { body: scrollingFixture() } } });
  const engine = b.window.OopsReplay, box = transcriptLayout(b);
  b.frame(0);
  engine.setSpeed(60); engine.play(true);
  b.frame(250);
  const state = engine.state();
  assert.equal(state.now, state.duration);
  assert.equal(state.playing, false);
  assert.ok(state.sentences.every(sentence => sentence.state === 'done'));
  assert.ok(box.scrollTop > 0, 'finishing playback must still bring the last original sentence into view');
  assertRowVisible(state.sentences.at(-1).row, box);
});

test('the initial seek follows history.readonly inside its own scroller before four seconds have elapsed', async () => {
  const b = await browser({ after: false, initialTime: 500, routes: { './funnel-sample.json': { body: scrollingFixture() } } });
  const engine = b.window.OopsReplay;
  const box = transcriptLayout(b, { top: 530, clientTop: 7, bottomPadding: 600, ancestorOffset: 600 });
  engine.seek(engine.state().duration);
  assert.equal(b.ids.get('pane-title').textContent, 'history.readonly');
  assert.ok(box.scrollTop > 0, 'first navigation must not be mistaken for a recent manual scroll');
  assertRowVisible(engine.state().sentences.at(-1).row, box);
  assert.ok(box.scrollTop <= box.scrollHeight - box.clientHeight);
});

test('manual transcript scrolling pauses following for four seconds and resumes within the same partial sentence', async () => {
  const b = await browser({ after: false, routes: { './funnel-sample.json': { body: scrollingFixture({ step: 10000, spoken: 8000 }) } } });
  const engine = b.window.OopsReplay, box = transcriptLayout(b);
  const last = engine.state().sentences.at(-1);
  engine.seek(last.start_ms + 500); engine.setSpeed(1); engine.play(true);
  assertRowVisible(last.row, box);
  box.scrollTop = 0; box.dispatchEvent({ type: 'wheel' });
  b.setTime(11000); b.frame(100);
  assert.equal(box.scrollTop, 0, 'the reader can inspect earlier sentences during the manual-scroll cooldown');
  assert.equal(last.state, 'partial');
  b.setTime(14001); b.frame(200);
  assert.equal(last.state, 'partial', 'resuming must not depend on entering a new sentence state');
  assert.equal(engine.state().playing, true);
  assertRowVisible(last.row, box);
});
