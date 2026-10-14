// Oops 实时漏斗：按会议时间回放 scripts/funnel_replay.py 生成的数据。
// 每句话是一个数据包：进入后依次经过 规则 → Jev → DeepSeek → 你，在它最深的那一层结束并落进该层的出口。
// 文字一律用 textContent 写入；打开的回放文件只在本机浏览器读取，不上传。
(() => {
  'use strict';
  const LAYERS = {
    code: { name: '规则', color: '#34c3a0', delay: 1 },
    jev: { name: 'Jev', color: '#5b8cff', delay: 480 },
    model: { name: 'DeepSeek', color: '#b27cff', delay: 950 },
    you: { name: '你', color: '#f2b84b', delay: 300 },
  };
  const ORDER = ['code', 'jev', 'model', 'you'];
  const IDX = { code: 0, jev: 1, model: 2, you: 3 };
  const SPEEDS = [1, 2, 5, 10, 30, 60];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const fmtMs = (ms) => ms >= 10000 ? (ms / 1000).toFixed(0) + ' s' : ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';

  const ui = {
    stages: $('stages'), canvas: $('canvas'), ticker: $('transcript'), play: $('play'), restart: $('restart'), speed: $('speed'),
    scrub: $('scrub'), clock: $('clock'), file: $('file'), badge: $('source-badge'), label: $('source-label'), note: $('source-note'),
    trace: $('trace'), traceMeta: $('trace-meta'), follow: $('follow'), log: $('log'), cost: $('cost'), costFoot: $('cost-foot'),
    hist: $('hist'), histFoot: $('hist-foot'), lens: $('lens'), drop: $('drop'),
  };
  const ctx = ui.canvas.getContext('2d');

  let data = null, sentences = [], timeline = [], duration = 1;
  let now = 0, fired = 0, playing = false, speed = 1, lastFrame = 0, lastRendered = -1;
  let selected = null, userScrolledAt = 0;
  let packets = new Map();          // sentence index → packet
  const gateFlash = [0, 0, 0, 0];

  // ---------------------------------------------------------------- data
  function validate(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.sentences)) throw new Error('不是 funnel_replay.py 生成的漏斗数据（version 1）');
    for (const s of raw.sentences) {
      if (typeof s.text !== 'string' || !Number.isFinite(s.end_ms) || !Array.isArray(s.forks) || !s.forks.length) throw new Error('句子格式无效：' + (s.id || '?'));
      for (const f of s.forks) if (!LAYERS[f.layer]) throw new Error('未知的层：' + f.layer);
    }
    return raw;
  }

  function load(raw) {
    data = validate(raw);
    timeline = [];
    sentences = data.sentences.map((s, i) => {
      const out = { ...s, i, start_ms: Number.isFinite(s.start_ms) ? s.start_ms : s.end_ms, state: '', steps: [] };
      let cursor = s.end_ms;
      s.forks.forEach((f, k) => {
        const est = !(Number.isFinite(f.ms) && f.ms > 0);
        const dur = est ? LAYERS[f.layer].delay : f.ms;
        out.steps.push({ start: cursor - s.end_ms, end: cursor + dur - s.end_ms, est });
        cursor += dur;
        timeline.push({ t: cursor, i, k, f });
      });
      out.doneAt = cursor;
      out.route = out.route || s.forks.reduce((a, f) => (IDX[f.layer] > IDX[a] ? f.layer : a), 'code');
      out.outcome = s.outcome || LAYERS[out.route].name + ' 结束';
      return out;
    });
    for (const e of data.session || []) {
      if (e && e.fork && LAYERS[e.fork.layer]) timeline.push({ t: (e.at_ms || 0) + (e.fork.ms || 0), i: -1, k: 0, f: e.fork });
    }
    timeline.sort((a, b) => a.t - b.t);
    duration = Math.max(1, ...timeline.map((e) => e.t), ...sentences.map((s) => s.end_ms)) + 1500;

    const replay = data.source && data.source.kind === 'replay';
    ui.badge.textContent = replay ? '真实回放 · 仅本机' : '示例数据';
    ui.badge.className = 'badge ' + (replay ? 'replay' : 'example');
    ui.label.textContent = (data.source && data.source.label) || '';
    ui.note.textContent = (data.source && data.source.note) || '';
    $('n-total').textContent = sentences.length;

    buildTicker();
    buildBins();
    renderLens();
    speed = SPEEDS.find((v) => v >= duration / 60000) || 60;
    ui.speed.value = String(speed);
    selected = null; ui.follow.hidden = true;
    seek(reduceMotion ? duration : 0);
    setPlaying(!reduceMotion);
  }

  function buildTicker() {
    ui.ticker.replaceChildren(...sentences.map((s, i) => {
      const li = el('li');
      li.hidden = true; li.tabIndex = 0;
      const ts = el('span', 'ts', mmss(s.start_ms));
      const who = el('span', 'who', s.speaker || '说话人未知');
      s.txt = el('span', 'txt'); s.out = el('span', 'out', '');
      li.append(ts, who, s.txt, s.out);
      const pick = () => { selected = i; ui.follow.hidden = false; markSelected(); renderTrace(true); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      s.row = li;
      return li;
    }));
  }

  function buildBins() {
    for (const k of ORDER) {
      const counts = new Map();
      sentences.filter((s) => s.route === k).forEach((s) => counts.set(s.outcome, (counts.get(s.outcome) || 0) + 1));
      const labels = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
      const ul = $('bins-' + k);
      ul.replaceChildren(...(labels.length ? labels : ['（这一场没有句子在这层结束）']).map((label) => {
        const li = el('li', 'zero');
        li.dataset.label = label;
        li.append(el('span', null, label), el('b', null, labels.length ? '0' : ''), el('i'));
        return li;
      }));
    }
  }

  // ---------------------------------------------------------------- state
  function setPlaying(on) {
    playing = on && now < duration;
    ui.play.textContent = playing ? '❚❚ 暂停' : '▶ 播放';
    ui.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    lastFrame = performance.now();
  }

  function seek(t) {
    now = Math.min(Math.max(0, t), duration);
    fired = 0;
    while (fired < timeline.length && timeline[fired].t <= now) fired++;
    packets = new Map();
    sentences.forEach((s) => { s.state = ''; s.firedSteps = 0; });
    for (let j = 0; j < fired; j++) if (timeline[j].i >= 0) sentences[timeline[j].i].firedSteps++;
    lastRendered = -1;
    render(true);
  }

  const stateOf = (s) => now < s.start_ms ? 'hidden' : now < s.end_ms ? 'partial' : now >= s.doneAt ? 'done' : 'thinking';

  function onFork(e, realNow) {
    gateFlash[IDX[e.f.layer]] = realNow;
    if (e.i < 0) return;
    const s = sentences[e.i];
    s.firedSteps++;
    if (reduceMotion) return;
    let p = packets.get(e.i);
    if (!p) {
      const g = geometry();
      if (!g) return;
      p = { stage: -1, j: (Math.random() * 2 - 1), queue: [], x: g.entryX, y: g.cy, color: '#e6e9ef', leaving: false, alpha: 1 };
      p.y = g.cy + p.j * g.half[0] * 0.75;
      packets.set(e.i, p);
    }
    const target = IDX[e.f.layer];
    if (target > p.stage) {
      if (p.stage >= 0 && target - p.stage > 1) p.queue.push({ kind: 'skip', from: p.stage, to: target });
      p.queue.push({ kind: 'gate', k: target, color: LAYERS[e.f.layer].color });
      p.stage = target;
    }
    if (e.k === s.forks.length - 1) { p.queue.push({ kind: 'bin', k: IDX[s.route], color: LAYERS[s.route].color }); p.leaving = true; }
  }

  // ---------------------------------------------------------------- render (DOM)
  function render(full) {
    // ticker rows (partial typing every frame)
    let heard = 0, latest = -1;
    for (const s of sentences) {
      const st = stateOf(s);
      if (st === 'partial') {
        const share = (now - s.start_ms) / Math.max(1, s.end_ms - s.start_ms);
        s.txt.textContent = s.text.slice(0, Math.max(1, Math.round(s.text.length * share)));
      }
      if (st === 'thinking' || st === 'done') heard++;
      if (st !== 'hidden') latest = s.i;
      if (st === s.state && !full) continue;
      if (st !== 'partial') s.txt.textContent = s.text;
      s.state = st;
      s.row.hidden = st === 'hidden';
      s.row.className = [st, st === 'done' ? 'r-' + s.route : '', selected === s.i ? 'selected' : ''].join(' ').trim();
      s.out.textContent = st === 'done' ? LAYERS[s.route].name + ' · ' + s.outcome : st === 'thinking' ? '判断中…' : '';
      if (st === 'thinking' && playing && !full) autoScroll(s.row);
    }
    $('n-heard').textContent = heard;
    ui.clock.textContent = mmss(now) + ' / ' + mmss(duration);
    ui.scrub.value = String(Math.round((now / duration) * 1000));

    if (fired !== lastRendered || full) {
      lastRendered = fired;
      renderStages(heard);
      renderLog();
      renderCost();
      renderHist();
    }
    renderTrace(false, latest);
  }

  function reachedCounts() {
    const reached = ORDER.map(() => new Set());
    for (let j = 0; j < fired; j++) { const e = timeline[j]; if (e.i >= 0) reached[IDX[e.f.layer]].add(e.i); }
    return reached.map((set) => set.size);
  }

  function renderStages(heard) {
    const reach = reachedCounts();
    const exits = { code: new Map(), jev: new Map(), model: new Map(), you: new Map() };
    const exitTotal = { code: 0, jev: 0, model: 0, you: 0 };
    for (const s of sentences) if (now >= s.doneAt) { exits[s.route].set(s.outcome, (exits[s.route].get(s.outcome) || 0) + 1); exitTotal[s.route]++; }
    const last = {};
    for (let j = fired - 1; j >= 0 && Object.keys(last).length < 4; j--) { const e = timeline[j]; if (!last[e.f.layer]) last[e.f.layer] = e; }
    ORDER.forEach((k, idx) => {
      const pct = heard ? Math.round((reach[idx] / heard) * 100) : 0;
      $('reach-' + k).textContent = reach[idx];
      $('pct-' + k).textContent = pct + '%';
      $('bar-' + k).style.width = pct + '%';
      $('exit-' + k).textContent = exitTotal[k];
      const lastEl = $('last-' + k);
      const e = last[k];
      if (e) {
        lastEl.replaceChildren(el('span', null, e.f.q + ' → '), el('b', null, clip(e.f.a, 40)), el('span', null, e.f.p != null ? '  p ' + e.f.p.toFixed(2) : ''));
      }
      const max = Math.max(1, ...exits[k].values());
      for (const li of $('bins-' + k).children) {
        const n = exits[k].get(li.dataset.label) || 0;
        if (!li.children[1].textContent && !n) continue;
        li.children[1].textContent = n;
        li.children[2].style.width = (n / max) * 100 + '%';
        li.classList.toggle('zero', !n);
      }
    });
    ui.stages.dataset.heard = heard;
    ui.stages._reach = reach; ui.stages._exits = exitTotal; ui.stages._heard = heard;
  }

  function renderLog() {
    const rows = [];
    for (let j = fired - 1; j >= 0 && rows.length < 16; j--) rows.push(timeline[j]);
    ui.log.replaceChildren(...rows.map((e) => {
      const li = el('li', 'c-' + e.f.layer);
      const qa = el('span', 'qa');
      qa.append(el('b', null, e.f.q), document.createTextNode(' → ' + e.f.a));
      if (e.f.p != null) qa.append(el('span', 'p' + (e.f.p < data.thresholds.settle ? ' low' : ''), '  p' + e.f.p.toFixed(2)));
      li.append(el('span', 't', mmss(e.t)), el('span', 'id', e.i >= 0 ? sentences[e.i].id : '本场'), el('span', 'ly', LAYERS[e.f.layer].name), qa);
      li.title = (e.i >= 0 ? sentences[e.i].text + '\n' : '') + e.f.q + ' → ' + e.f.a;
      return li;
    }));
    if (!rows.length) ui.log.append(el('li', 'muted', '还没有判断。'));
  }

  function renderTrace(force, latest) {
    let i = selected != null ? selected : -1;
    if (i < 0) {   // follow the newest sentence that is being judged, else the newest finished one
      for (let n = sentences.length - 1; n >= 0; n--) { const st = sentences[n].state; if (st === 'thinking') { i = n; break; } if (i < 0 && st === 'done') i = n; }
      if (i < 0) i = latest != null ? latest : -1;
    }
    if (i < 0) return;
    const s = sentences[i];
    const done = s.state === 'hidden' || s.state === 'partial' ? 0 : s.firedSteps;
    const key = i + ':' + done + ':' + s.state;
    if (!force && ui.trace.dataset.key === key) return;
    ui.trace.dataset.key = key;
    ui.traceMeta.textContent = s.id + ' · ' + mmss(s.start_ms) + ' · ' + s.forks.length + ' 个问题';
    const quote = el('p', 'quote');
    quote.append(el('small', null, s.speaker || '说话人未知'), document.createTextNode(s.text));
    const total = Math.max(1, s.steps[s.steps.length - 1].end);
    const chip = el('span', 'exit-chip', s.state === 'done' ? '在「' + LAYERS[s.route].name + '」结束：' + s.outcome : '还在判断…');
    chip.style.setProperty('--dot', s.state === 'done' ? LAYERS[s.route].color : '#566070');
    const wf = el('div', 'wf');
    s.forks.forEach((f, k) => {
      const st = s.steps[k];
      const row = el('div', 'wf-row c-' + f.layer + (k < done ? '' : ' pending'));
      const a = el('span', 'wf-a', k < done ? f.a : '等待…');
      if (k < done) {
        const meta = [f.p != null ? 'p ' + f.p.toFixed(2) : '', st.est ? '' : fmtMs(st.end - st.start)].filter(Boolean).join(' · ');
        if (meta) a.append(el('span', 'meta', meta));
        if (f.settled) a.append(el('span', 'stop', '到此为止'));
      }
      const track = el('div', 'wf-track');
      const bar = el('i', st.est ? 'est' : '');
      bar.style.left = (st.start / total) * 100 + '%';
      bar.style.width = Math.max(1, ((st.end - st.start) / total) * 100) + '%';
      track.append(bar);
      row.append(el('span', 'wf-layer', LAYERS[f.layer].name), el('span', 'wf-q', f.q), a, track);
      wf.append(row);
    });
    const axis = el('div', 'wf-axis');
    const ends = el('span'); ends.append(el('span', null, '定稿 0'), el('span', null, '+' + fmtMs(total)));
    axis.append(el('span'), el('span'), ends);
    const legend = el('p', 'wf-legend', '条形是从这句话定稿起的时间线。实心 = 回放记录的真实耗时；斜纹 = 没记录，按该层典型耗时估算。');
    ui.trace.replaceChildren(quote, chip, wf, axis, legend);
  }

  function markSelected() { sentences.forEach((s) => s.row.classList.toggle('selected', selected === s.i)); }

  function renderCost() {
    const agg = Object.fromEntries(ORDER.map((k) => [k, { n: 0, ms: 0, known: 0 }]));
    for (let j = 0; j < fired; j++) {
      const f = timeline[j].f, a = agg[f.layer];
      a.n++;
      if (Number.isFinite(f.ms) && f.ms > 0) { a.ms += f.ms; a.known++; }
    }
    ui.cost.replaceChildren(...ORDER.map((k) => {
      const a = agg[k], tr = el('tr', 'c-' + k);
      const avg = a.known ? fmtMs(a.ms / a.known) : k === 'code' ? '<1 ms' : k === 'you' ? '看人' : '未记录';
      tr.append(el('td', null, LAYERS[k].name), el('td', null, String(a.n)), el('td', null, a.known ? fmtMs(a.ms) : '—'), el('td', null, avg));
      return tr;
    }));
    const modelShare = agg.jev.n + agg.model.n;
    const total = modelShare + agg.code.n + agg.you.n;
    ui.costFoot.textContent = total ? '模型回答了 ' + Math.round((modelShare / total) * 100) + '% 的问题；耗时只统计回放里记录到的调用。' : '';
  }

  function renderHist() {
    const edges = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001];
    const names = ['<.5', '.5', '.6', '.7', '.8', '.9', '≥.95'];
    const counts = names.map(() => 0);
    for (let j = 0; j < fired; j++) {
      const f = timeline[j].f;
      if (f.layer !== 'jev' || f.p == null) continue;
      for (let b = 0; b < names.length; b++) if (f.p >= edges[b] && f.p < edges[b + 1]) { counts[b]++; break; }
    }
    const W = 320, H = 150, top = 16, base = 124, bw = W / names.length;
    const max = Math.max(1, ...counts);
    const svg = ui.hist; svg.replaceChildren();
    const NS = 'http://www.w3.org/2000/svg';
    const add = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; svg.append(n); return n; };
    add('line', { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, stroke: '#303846' });
    counts.forEach((c, b) => {
      const h = ((base - top) * c) / max;
      const settle = b === names.length - 1;
      add('rect', { x: b * bw + 6, y: base - h, width: bw - 12, height: Math.max(0, h), rx: 2, fill: settle ? '#34c3a0' : b === 0 ? '#566070' : '#5b8cff', opacity: settle ? 1 : 0.75 });
      add('text', { x: b * bw + bw / 2, y: base - h - 4, 'text-anchor': 'middle', fill: '#e6e9ef', 'font-size': 11, 'font-family': 'Menlo, monospace' }, c ? String(c) : '');
      add('text', { x: b * bw + bw / 2, y: base + 16, 'text-anchor': 'middle', fill: '#8b94a4', 'font-size': 10.5, 'font-family': 'Menlo, monospace' }, names[b]);
    });
    const all = counts.reduce((a, b) => a + b, 0);
    ui.histFoot.textContent = all ? '≥ 0.95 当场定 ' + counts[counts.length - 1] + ' / ' + all + '；其余要么照样记下，要么还得往后问。' : '还没有 Jev 回答。';
  }

  function renderLens() {
    const L = data.lens || {}, n = sentences.length || 1;
    const decided = L.rules_decided || 0, agree = L.agree || 0, shape = L.question_shape || 0, skipped = L.question_skipped || 0;
    const pct = Math.round((decided / n) * 100);
    const a = el('div'); a.append(el('div', 'big', decided + ' / ' + sentences.length), el('p', null, '句能被关键词规则直接判定（待办或约束），其中 Jev 也这么判的有 ' + agree + ' 句。'));
    const b = el('div'); b.append(el('div', 'big', skipped + ' / ' + shape), el('p', null, '句被「像在提问」的规则送去 DeepSeek，结论是不用查。'));
    const v = el('p', 'verdict', pct < 30
      ? '规则现在只能定 ' + pct + '% 的句子，所以第 2 层几乎每句都要调用模型。想让规则多扛一些，得先补强规则；最快见效的是收紧「像在提问」，减少白跑的 DeepSeek 调用。'
      : '规则能定 ' + pct + '% 的句子，可以考虑让它先判，省下这部分 Jev 调用。');
    ui.lens.replaceChildren(a, b, v);
  }

  function autoScroll(row) {
    if (performance.now() - userScrolledAt < 4000) return;
    const box = ui.ticker;
    const top = row.offsetTop - box.clientHeight * 0.6;
    if (Math.abs(box.scrollTop - top) > 4) box.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // ---------------------------------------------------------------- canvas
  let geo = null;
  function geometry() {
    if (getComputedStyle(ui.canvas).display === 'none') return null;
    const box = ui.stages.getBoundingClientRect();
    const lanes = [...ui.stages.querySelectorAll('.lane')].map((l) => l.getBoundingClientRect());
    if (!lanes.length || !lanes[0].height) return null;
    const top = lanes[0].top - box.top, bottom = lanes[0].bottom - box.top;
    const gates = lanes.map((r) => r.left - box.left + r.width / 2);
    const cy = top + (bottom - top) * 0.38;
    const bandMax = Math.min((bottom - top) * 0.58, 170);
    const heard = ui.stages._heard || 0, reach = ui.stages._reach || [0, 0, 0, 0];
    const half = reach.map((r) => (heard ? Math.max(r ? 3 : 0, (bandMax / 2) * (r / heard)) : 0));
    return { W: box.width, H: box.height, top, bottom, gates, cy, bandMax, half, entryX: 0, colW: lanes[0].width, exits: ui.stages._exits || {}, heard };
  }

  function sizeCanvas() {
    const r = ui.stages.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(r.width * dpr); ui.canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function edgePoints(g, sign) {
    const pts = [[g.entryX, g.cy + sign * (g.heard ? g.bandMax / 2 : 0)]];
    g.gates.forEach((x, k) => pts.push([x, g.cy + sign * g.half[k]]));
    pts.push([g.W, g.cy + sign * g.half[3]]);
    return pts;
  }

  function curve(pts, move) {
    pts.forEach(([x, y], n) => {
      if (n === 0) { if (move) ctx.moveTo(x, y); else ctx.lineTo(x, y); return; }
      const [px, py] = pts[n - 1], mx = (px + x) / 2;
      ctx.bezierCurveTo(mx, py, mx, y, x, y);
    });
  }

  function waypoint(g, w, p) {
    if (w.kind === 'gate') return { x: g.gates[w.k] + (Math.random() - 0.5) * 6, y: g.cy + p.j * Math.max(2, g.half[w.k]) * 0.8 };
    if (w.kind === 'skip') return { x: (g.gates[w.from] + g.gates[w.to]) / 2, y: g.cy - g.bandMax / 2 - 18 };
    return { x: g.gates[w.k] + p.j * g.colW * 0.12, y: g.bottom + 2 };
  }

  function draw(realNow, dt) {
    geo = geometry();
    const g = geo;
    ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    if (!g || !data) return;

    // exit chutes: from the band down to the bins, width = sentences that ended in that layer
    ORDER.forEach((k, idx) => {
      const n = g.exits[k] || 0;
      if (!n || !g.heard) return;
      const w = Math.max(3, g.bandMax * (n / g.heard));
      const x = g.gates[idx], y0 = g.cy + Math.max(2, g.half[idx]) - 2;
      const grad = ctx.createLinearGradient(0, y0, 0, g.bottom);
      grad.addColorStop(0, hexA(LAYERS[k].color, 0.32)); grad.addColorStop(1, hexA(LAYERS[k].color, 0.08));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x - w / 2, y0);
      ctx.bezierCurveTo(x - w / 2, y0 + 30, x - w * 0.6, g.bottom - 30, x - w * 0.6, g.bottom);
      ctx.lineTo(x + w * 0.6, g.bottom);
      ctx.bezierCurveTo(x + w * 0.6, g.bottom - 30, x + w / 2, y0 + 30, x + w / 2, y0);
      ctx.closePath(); ctx.fill();
    });

    // the band itself: height at each gate = share of heard sentences that reached it
    if (g.heard) {
      const topPts = edgePoints(g, -1), botPts = edgePoints(g, 1);
      const grad = ctx.createLinearGradient(0, 0, g.W, 0);
      grad.addColorStop(0, 'rgba(230,233,239,0.16)');
      g.gates.forEach((x, k) => grad.addColorStop(Math.min(1, x / g.W), hexA(LAYERS[ORDER[k]].color, 0.22)));
      ctx.fillStyle = grad;
      ctx.beginPath(); curve(topPts, true); curve(botPts.slice().reverse(), false); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(230,233,239,0.22)'; ctx.lineWidth = 1;
      ctx.beginPath(); curve(topPts, true); ctx.stroke();
      ctx.beginPath(); curve(botPts, true); ctx.stroke();
    }

    // gates
    g.gates.forEach((x, k) => {
      const flash = Math.max(0, 1 - (realNow - gateFlash[k]) / 450);
      const h = Math.max(14, g.half[k] + 12);
      ctx.strokeStyle = hexA(LAYERS[ORDER[k]].color, 0.45 + 0.55 * flash);
      ctx.lineWidth = 2 + 2 * flash;
      ctx.beginPath(); ctx.moveTo(x, g.cy - h); ctx.lineTo(x, g.cy + h); ctx.stroke();
      if (flash > 0) {
        ctx.strokeStyle = hexA(LAYERS[ORDER[k]].color, 0.22 * flash);
        ctx.lineWidth = 10;
        ctx.beginPath(); ctx.moveTo(x, g.cy - h); ctx.lineTo(x, g.cy + h); ctx.stroke();
      }
    });

    // packets
    for (const [i, p] of packets) {
      let budget = dt * (0.35 + 0.12 * p.queue.length);
      while (budget > 0 && p.queue.length) {
        const w = p.queue[0];
        if (!w.pt) w.pt = waypoint(g, w, p);
        const dx = w.pt.x - p.x, dy = w.pt.y - p.y, d = Math.hypot(dx, dy);
        if (d <= budget) { p.x = w.pt.x; p.y = w.pt.y; budget -= d; if (w.color) p.color = w.color; p.queue.shift(); }
        else { p.x += (dx / d) * budget; p.y += (dy / d) * budget; budget = 0; }
      }
      if (p.leaving && !p.queue.length) { p.alpha -= dt / 350; if (p.alpha <= 0) { packets.delete(i); continue; } }
      const sel = selected === i;
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, sel ? 5.5 : 3.6, 0, Math.PI * 2); ctx.fill();
      if (sel) { ctx.strokeStyle = '#e6e9ef'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;

  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ---------------------------------------------------------------- loop & controls
  function frame(realNow) {
    const dt = Math.min(80, realNow - lastFrame);
    lastFrame = realNow;
    if (data) {
      if (playing) {
        now = Math.min(duration, now + dt * speed);
        while (fired < timeline.length && timeline[fired].t <= now) { onFork(timeline[fired], realNow); fired++; }
        render(false);
        if (now >= duration) setPlaying(false);
      }
      draw(realNow, dt);
    }
    requestAnimationFrame(frame);
  }

  ui.play.addEventListener('click', () => { if (now >= duration) seek(0); setPlaying(!playing); });
  ui.restart.addEventListener('click', () => { seek(0); setPlaying(true); });
  ui.speed.addEventListener('change', () => { speed = Number(ui.speed.value) || 1; });
  ui.scrub.addEventListener('input', () => seek((Number(ui.scrub.value) / 1000) * duration));
  ui.follow.addEventListener('click', () => { selected = null; ui.follow.hidden = true; markSelected(); renderTrace(true); });
  ['wheel', 'touchmove'].forEach((t) => ui.ticker.addEventListener(t, () => { userScrolledAt = performance.now(); }, { passive: true }));
  document.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || /^(INPUT|SELECT|BUTTON|TEXTAREA|LI)$/.test(ev.target.tagName)) return;
    ev.preventDefault(); ui.play.click();
  });

  function readFile(file) {
    if (!file) return;
    file.text().then((text) => load(JSON.parse(text))).catch((err) => {
      ui.note.textContent = '打不开这个文件：' + err.message + '。请选 scripts/funnel_replay.py 生成的 build/funnel-*.json。';
    });
  }
  ui.file.addEventListener('change', () => readFile(ui.file.files[0]));
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => { if ([...(ev.dataTransfer?.types || [])].includes('Files')) { dragDepth++; ui.drop.hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) ui.drop.hidden = true; });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => { ev.preventDefault(); dragDepth = 0; ui.drop.hidden = true; readFile(ev.dataTransfer?.files?.[0]); });

  new ResizeObserver(() => { sizeCanvas(); packets.forEach((p) => p.queue.forEach((w) => { w.pt = null; })); }).observe(ui.stages);
  sizeCanvas();
  fetch('./funnel-sample.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(load)
    .catch((err) => { ui.badge.textContent = '载入失败'; ui.note.textContent = '示例数据载入失败：' + err.message; });
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });
})();
