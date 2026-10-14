// Oops 实时漏斗（视频风格）：按会议时间回放 scripts/funnel_replay.py 生成的数据。
// 每句话被问几个带类型的问题；每个问题由一层来答，线从这句话连到右侧弧上属于那一层的扇区，扇区正对该层的卡片。
// 刻度长度 = 置信度 p（没有 p 的按满长画）。文字一律用 textContent 写入；打开的回放文件只在本机读取，不上传。
(() => {
  'use strict';
  const LAYERS = {
    code: { name: '规则', color: '#3fd9a0', delay: 1 },
    jev: { name: 'Jev', color: '#5cc3ff', delay: 480 },
    model: { name: 'DeepSeek', color: '#f2896b', delay: 950 },
    you: { name: '你', color: '#f4cc4e', delay: 300 },
  };
  const ORDER = ['code', 'jev', 'model', 'you'];
  const IDX = { code: 0, jev: 1, model: 2, you: 3 };
  const SPEEDS = [1, 2, 5, 10, 30, 60];
  const PINK = '#ff3d8b';
  const GOLD = 0.6180339887;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; };

  const ui = {
    stage: $('stage'), fan: $('fan'), canvas: $('canvas'), transcript: $('transcript'), play: $('play'), restart: $('restart'),
    speed: $('speed'), scrub: $('scrub'), clock: $('clock'), file: $('file'), badge: $('source-badge'), label: $('source-label'),
    note: $('source-note'), stream: $('stream'), scope: $('stream-scope'), follow: $('follow'), spark: $('spark'),
    sparkFoot: $('spark-foot'), dots: $('dots'), dotsFoot: $('dots-foot'), bars: $('bars'), exits: $('exits'), lens: $('lens'),
    statusLeft: $('status-left'), statusRight: $('status-right'), drop: $('drop'), paneLine: $('pane-line'),
    cards: ORDER.map((k) => document.querySelector('.route.r-' + k)),
  };
  const ctx = ui.canvas.getContext('2d');

  let data = null, sentences = [], timeline = [], duration = 1;
  let now = 0, fired = 0, playing = false, speed = 1, lastFrame = 0, lastRendered = -1;
  let selected = null, userScrolledAt = 0;
  const spider = { x: 0, y: 0, ready: false };

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
      const out = { ...s, i, start_ms: Number.isFinite(s.start_ms) ? s.start_ms : s.end_ms, state: '', firedSteps: 0 };
      let cursor = s.end_ms;
      s.forks.forEach((f, k) => {
        cursor += Number.isFinite(f.ms) && f.ms > 0 ? f.ms : LAYERS[f.layer].delay;
        timeline.push({ t: cursor, i, k, f });
      });
      out.doneAt = cursor;
      out.route = out.route || s.forks.reduce((a, f) => (IDX[f.layer] > IDX[a] ? f.layer : a), 'code');
      out.outcome = s.outcome || LAYERS[out.route].name + ' 结束';
      out.filler = s.forks.length === 1 && s.forks[0].layer === 'code' && s.forks[0].settled;
      return out;
    });
    for (const e of data.session || []) {
      if (e && e.fork && LAYERS[e.fork.layer]) timeline.push({ t: (e.at_ms || 0) + (e.fork.ms || 0), i: -1, k: 0, f: e.fork });
    }
    timeline.sort((a, b) => a.t - b.t);
    const seq = { code: 0, jev: 0, model: 0, you: 0 };
    timeline.forEach((e) => { e.slot = (seq[e.f.layer]++ * GOLD + 0.5 * GOLD) % 1; e.real = 0; });
    duration = Math.max(1, ...timeline.map((e) => e.t), ...sentences.map((s) => s.end_ms)) + 1500;

    const replay = data.source && data.source.kind === 'replay';
    ui.badge.textContent = replay ? '真实回放 · 仅本机' : '示例数据';
    ui.badge.className = 'badge ' + (replay ? 'replay' : 'example');
    ui.label.textContent = (data.source && data.source.label) || '';
    ui.note.textContent = (data.source && data.source.note) || '';
    $('pane-title').textContent = replay ? 'replay.local' : 'meeting.example';

    buildTranscript();
    buildDots();
    buildExits();
    renderLens();
    speed = SPEEDS.find((v) => v >= duration / 60000) || 60;
    ui.speed.value = String(speed);
    selected = null; ui.follow.hidden = true;
    seek(reduceMotion ? duration : 0);
    setPlaying(!reduceMotion && !document.getElementById('mode-live').hidden);
    document.dispatchEvent(new CustomEvent('funnel:data', { detail: data }));
  }

  function clauses(text) {
    const parts = text.match(/[^，。！？,.!?；;、]+[，。！？,.!?；;、]*|[，。！？,.!?；;、]+/g) || [text];
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function buildTranscript() {
    ui.transcript.replaceChildren(...sentences.map((s, i) => {
      const li = el('li');
      li.hidden = true; li.tabIndex = 0;
      li.append(el('span', 'ts', mmss(s.start_ms)), el('span', 'spk', s.speaker || '—'));
      s.txt = el('span', 'txt');
      s.typing = el('span', 'typing');
      s.boxes = clauses(s.text).map((c) => el('span', 'box', c));
      li.append(s.txt);
      li.title = '点开看这句话经过的每个问题';
      const pick = () => { selected = i; ui.follow.hidden = false; markSelected(); lastRendered = -1; };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      s.row = li;
      return li;
    }));
  }

  function buildDots() {
    ui.dots.replaceChildren(...sentences.map((s) => { const d = el('i'); d.title = s.id + ' · ' + s.outcome; s.dot = d; return d; }));
  }

  function buildExits() {
    const rows = [];
    ORDER.forEach((k) => {
      const counts = new Map();
      sentences.filter((s) => s.route === k).forEach((s) => counts.set(s.outcome, (counts.get(s.outcome) || 0) + 1));
      [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([label]) => {
        const li = el('li', 'zero');
        li.dataset.layer = k; li.dataset.label = label;
        li.append(el('span', 'ly l-' + k, LAYERS[k].name), el('span', 'lab', label), el('b', null, '0'));
        rows.push(li);
      });
    });
    ui.exits.replaceChildren(...rows);
  }

  // ---------------------------------------------------------------- state
  function setPlaying(on) {
    playing = on && now < duration;
    ui.play.textContent = playing ? '❚❚ 暂停' : '▶ 播放';
    ui.play.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  function seek(t) {
    now = Math.min(Math.max(0, t), duration);
    fired = 0;
    sentences.forEach((s) => { s.state = ''; s.firedSteps = 0; });
    while (fired < timeline.length && timeline[fired].t <= now) {
      timeline[fired].real = 0;
      if (timeline[fired].i >= 0) sentences[timeline[fired].i].firedSteps++;
      fired++;
    }
    lastRendered = -1;
    render(true);
  }

  const stateOf = (s) => now < s.start_ms ? 'hidden' : now < s.end_ms ? 'partial' : now >= s.doneAt ? 'done' : 'thinking';

  // ---------------------------------------------------------------- DOM render
  function render(full) {
    let heard = 0;
    for (const s of sentences) {
      const st = stateOf(s);
      if (st === 'partial') {
        const share = (now - s.start_ms) / Math.max(1, s.end_ms - s.start_ms);
        s.typing.textContent = s.text.slice(0, Math.max(1, Math.round(s.text.length * share)));
      }
      if (st === 'thinking' || st === 'done') heard++;
      if (st === s.state && !full) continue;
      if (st === 'partial') s.txt.replaceChildren(s.typing);
      else if (s.state === 'partial' || s.state === '' || s.state === 'hidden' || full) s.txt.replaceChildren(...s.boxes);
      s.state = st;
      s.row.hidden = st === 'hidden';
      s.row.className = [st, st === 'done' ? 'route-' + s.route : '', s.filler && st === 'done' ? 'filler' : '', selected === s.i ? 'selected' : ''].join(' ').trim();
      s.dot.className = st === 'done' ? s.route : st === 'thinking' ? 'heard' : '';
      if (st === 'thinking' && playing && !full) autoScroll(s.row);
    }
    ui.paneLine.textContent = '句 ' + heard + ' / ' + sentences.length;
    ui.dotsFoot.textContent = heard + ' / ' + sentences.length + ' 句已听完';
    ui.clock.textContent = mmss(now) + ' / ' + mmss(duration);
    ui.scrub.value = String(Math.round((now / duration) * 1000));
    if (fired === lastRendered && !full) return;
    lastRendered = fired;

    const c = { code: 0, jev: 0, model: 0, you: 0 };
    for (let j = 0; j < fired; j++) c[timeline[j].f.layer]++;
    const total = c.code + c.jev + c.model + c.you;
    $('c-sent').textContent = heard; $('c-fork').textContent = total;
    const ended = { code: new Map(), jev: new Map(), model: new Map(), you: new Map() };
    const endedN = { code: 0, jev: 0, model: 0, you: 0 };
    for (const s of sentences) if (now >= s.doneAt) { ended[s.route].set(s.outcome, (ended[s.route].get(s.outcome) || 0) + 1); endedN[s.route]++; }
    ORDER.forEach((k) => {
      $('c-' + k).textContent = c[k];
      $('r-' + k).textContent = c[k];
      $('r-' + k + '-sub').textContent = '在这层结束 ' + endedN[k] + ' 句';
      const top = [...ended[k].entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
      $('r-' + k + '-top').replaceChildren(...top.map(([l, n]) => { const li = el('li'); li.append(el('span', null, l), el('span', null, String(n))); return li; }));
    });
    for (const li of ui.exits.children) {
      const n = ended[li.dataset.layer].get(li.dataset.label) || 0;
      li.lastChild.textContent = n; li.classList.toggle('zero', !n);
    }
    renderBars(c, total, heard);
    renderStream();
    renderSpark();
    ui.statusLeft.textContent = 'oops@funnel · ' + sentences.length + ' 句 · ' + (data.source && data.source.kind === 'replay' ? '真实回放（仅本机）' : '示例数据') + ' · ' + mmss(now);
    ui.statusRight.textContent = '岔口 ' + total + ' · 规则 ' + c.code + ' · Jev ' + c.jev + ' · DeepSeek ' + c.model + ' · 你 ' + c.you;
  }

  function renderBars(c, total, heard) {
    if (!ui.bars.children.length) {
      for (const k of ORDER) {
        const li = el('li'), track = el('span', 'track'), fill = el('span', 'fill');
        fill.style.background = LAYERS[k].color; track.append(fill);
        li.append(el('span', 'l-' + k, LAYERS[k].name), track, el('span', 'n l-' + k, '0'));
        ui.bars.append(li);
      }
    }
    [...ui.bars.children].forEach((li, idx) => {
      const k = ORDER[idx];
      li.children[1].firstChild.style.width = (total ? (c[k] / total) * 100 : 0) + '%';
      li.children[2].textContent = c[k];
    });
    $('routed-n').textContent = total;
    $('routed-sub').textContent = '个岔口 · 来自 ' + heard + ' 句';
  }

  function renderStream() {
    let rows;
    if (selected != null) {
      const s = sentences[selected];
      ui.scope.textContent = '· ' + s.id + ' 的 ' + s.forks.length + ' 个问题';
      const done = s.firedSteps;
      rows = s.forks.map((f, k) => ({ i: selected, k, f, t: null, pending: k >= done || s.state === 'hidden' || s.state === 'partial' }));
    } else {
      ui.scope.textContent = '';
      rows = [];
      for (let j = fired - 1; j >= 0 && rows.length < 9; j--) rows.push(timeline[j]);
    }
    ui.stream.replaceChildren(...rows.map((e) => {
      const li = el('li', e.pending ? 'pending' : '');
      const s = e.i >= 0 ? sentences[e.i] : null;
      const w = el('button', 'w', s ? clip(s.text, 12) : '本场');
      w.type = 'button';
      if (s) w.addEventListener('click', () => { selected = s.i; ui.follow.hidden = false; markSelected(); lastRendered = -1; });
      const a = el('span', 'a', e.pending ? '等待…' : e.f.a);
      if (!e.pending && e.f.settled) a.append(el('span', 'stop', '  ← 到此为止'));
      const p = el('span', 'p' + (e.f.p != null && e.f.p < data.thresholds.settle ? ' low' : ''), !e.pending && e.f.p != null ? 'p ' + e.f.p.toFixed(2) : '');
      li.append(el('span', 't', e.t != null ? mmss(e.t) : '#' + (e.k + 1)), w, el('span', 'q', e.f.q), a, p, el('span', 'to l-' + e.f.layer, '→ ' + LAYERS[e.f.layer].name));
      return li;
    }));
    if (!rows.length) ui.stream.append(el('li', 'muted', '还没有岔口。'));
  }

  function markSelected() { sentences.forEach((s) => s.row.classList.toggle('selected', selected === s.i)); }

  function renderSpark() {
    const ps = [];
    for (let j = fired - 1; j >= 0 && ps.length < 40; j--) { const f = timeline[j].f; if (f.layer === 'jev' && f.p != null) ps.unshift(f.p); }
    const W = 300, H = 120, y = (p) => 6 + (1 - p) * (H - 12);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = ui.spark; svg.replaceChildren();
    const add = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); return n; };
    add('line', { x1: 0, x2: W, y1: y(data.thresholds.settle), y2: y(data.thresholds.settle), stroke: '#3fd9a0', 'stroke-dasharray': '3 4', 'vector-effect': 'non-scaling-stroke' });
    add('line', { x1: 0, x2: W, y1: y(data.thresholds.tag_floor), y2: y(data.thresholds.tag_floor), stroke: '#4a5058', 'stroke-dasharray': '2 5', 'vector-effect': 'non-scaling-stroke' });
    if (ps.length > 1) {
      const step = W / 39, x0 = W - (ps.length - 1) * step;
      const pts = ps.map((p, k) => (x0 + k * step).toFixed(1) + ',' + y(p).toFixed(1));
      add('polygon', { points: x0.toFixed(1) + ',' + H + ' ' + pts.join(' ') + ' ' + W + ',' + H, fill: 'rgba(255,61,139,.10)' });
      add('polyline', { points: pts.join(' '), fill: 'none', stroke: PINK, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' });
      ps.forEach((p, k) => add('rect', { x: (x0 + k * step - 2).toFixed(1), y: (y(p) - 2).toFixed(1), width: 4, height: 4, fill: p >= data.thresholds.settle ? '#3fd9a0' : '#f4cc4e' }));
    }
    const avg = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
    const steady = ps.filter((p) => p >= data.thresholds.settle).length;
    ui.sparkFoot.textContent = avg == null ? '绿线 0.95：到这条线以上当场定' : '平均 ' + avg.toFixed(3) + ' · 当场定 ' + steady + ' / ' + ps.length + ' · 绿线 0.95';
  }

  function renderLens() {
    const L = data.lens || {}, n = sentences.length || 1;
    const decided = L.rules_decided || 0, agree = L.agree || 0, shape = L.question_shape || 0, skipped = L.question_skipped || 0;
    const pct = Math.round((decided / n) * 100);
    const a = el('div'); a.append(el('div', 'big l-code', decided + ' / ' + sentences.length), el('p', null, '句关键词规则能直接定（待办 / 约束），其中 Jev 也这么判的 ' + agree + ' 句'));
    const b = el('div'); b.append(el('div', 'big l-model', skipped + ' / ' + shape), el('p', null, '句被「像在提问」送去 DeepSeek，结论是不用查'));
    const v = el('p', 'verdict', pct < 30
      ? '模型只该在规则定不了的地方思考。现在规则只能定 ' + pct + '% 的句子，要让规则扛大头，得先补强规则，最快见效的是收紧「像在提问」。'
      : '规则能定 ' + pct + '% 的句子，可以让它先判，省下这部分 Jev 调用。');
    ui.lens.replaceChildren(a, b, v);
  }

  function autoScroll(row) {
    if (performance.now() - userScrolledAt < 4000) return;
    const box = ui.transcript;
    const top = row.offsetTop - box.clientHeight * 0.55;
    if (Math.abs(box.scrollTop - top) > 4) box.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // ---------------------------------------------------------------- canvas
  function rel(r, base) { return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top, width: r.width, height: r.height }; }

  function geometry() {
    const base = ui.stage.getBoundingClientRect();
    const tr = rel(ui.transcript.getBoundingClientRect(), base);
    const fan = rel(ui.fan.getBoundingClientRect(), base);
    const cards = ui.cards.map((c) => rel(c.getBoundingClientRect(), base));
    const side = cards[0].left >= fan.right - 4 && fan.width > 40 ? 'right' : 'bottom';
    const g = { W: base.width, H: base.height, base, tr, fan, cards, side };
    if (side === 'right') {
      const top = cards[0].top + 6, bottom = cards[3].bottom - 6;
      const half = (bottom - top) / 2, cardsLeft = cards[0].left;
      const gap = Math.min(230, Math.max(70, fan.width * 0.8));
      const d = Math.max(30, gap - 22);
      g.R = (half * half + d * d) / (2 * d);
      g.cx = cardsLeft - gap + g.R; g.cy = (top + bottom) / 2; g.limit = cardsLeft - 6;
    } else {
      const half = (fan.width - 24) / 2, d = fan.height * 0.32;
      g.R = (half * half + d * d) / (2 * d);
      g.cx = fan.left + fan.width / 2; g.cy = fan.top + fan.height * 0.3 + g.R; g.limit = fan.bottom - 6;
    }
    return g;
  }

  function arcPoint(g, k, frac) {
    let x, y;
    if (g.side === 'right') {
      const c = g.cards[k];
      y = c.top + 10 + frac * Math.max(4, c.height - 20);
      x = g.cx - Math.sqrt(Math.max(0, g.R * g.R - (y - g.cy) ** 2));
    } else {
      const w = (g.fan.width - 24) / 4;
      x = g.fan.left + 12 + k * w + 6 + frac * (w - 12);
      y = g.cy - Math.sqrt(Math.max(0, g.R * g.R - (x - g.cx) ** 2));
    }
    const len = Math.hypot(g.cx - x, g.cy - y) || 1;
    return { x, y, ux: (g.cx - x) / len, uy: (g.cy - y) / len };
  }

  function sectorEnds(g, k) { return [arcPoint(g, k, 0), arcPoint(g, k, 1)]; }

  function fractionOrigin(g, i) {
    const f = i >= 0 ? (i + 0.5) / Math.max(1, sentences.length) : 1;
    if (g.side === 'right') return { x: g.tr.right, y: g.tr.top + 8 + f * (g.tr.height - 16) };
    return { x: g.tr.left + 8 + f * (g.tr.width - 16), y: g.tr.bottom };
  }

  function rowOrigin(g, i) {
    if (i < 0) return null;
    const s = sentences[i];
    if (s.row.hidden) return null;
    const node = s.state === 'partial' ? s.typing : s.boxes[s.boxes.length - 1];
    const r = node.getBoundingClientRect();
    if (!r.width) return null;
    const p = { x: r.right - g.base.left, y: r.top + r.height / 2 - g.base.top };
    if (p.y < g.tr.top + 30 || p.y > g.tr.bottom) return null;
    return p;
  }

  function activeSentence() {
    let latest = -1;
    for (let n = sentences.length - 1; n >= 0; n--) {
      const st = sentences[n].state;
      if (st === 'thinking') return n;
      if (latest < 0 && (st === 'partial' || st === 'done')) latest = n;
    }
    return latest;
  }

  function placeSpider(g, i) {
    if (i < 0) { spider.ready = false; return null; }
    const s = sentences[i];
    if (s.row.hidden) return null;
    let node;
    if (s.state === 'partial') node = s.typing;
    else {
      const progress = s.state === 'thinking' ? s.firedSteps / Math.max(1, s.forks.length) : 1;
      node = s.boxes[Math.min(s.boxes.length - 1, Math.floor(progress * s.boxes.length))];
    }
    const r = node.getBoundingClientRect();
    if (!r.width) return null;
    let x = r.left + r.width * 0.5 - g.base.left, y = r.top - g.base.top - 6;
    y = Math.min(Math.max(y, g.tr.top + 36), g.tr.bottom - 14);
    x = Math.min(Math.max(x, g.tr.left + 24), g.tr.right - 14);
    if (!spider.ready) { spider.x = x; spider.y = y; spider.ready = true; }
    const k = reduceMotion ? 1 : 0.16;
    spider.x += (x - spider.x) * k; spider.y += (y - spider.y) * k;
    return spider;
  }

  function drawSpider(p, realNow) {
    const t = reduceMotion || !playing ? 0 : realNow / 120;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.strokeStyle = 'rgba(63,217,160,.85)'; ctx.lineWidth = 1.1;
    for (const side of [-1, 1]) {
      for (let n = 0; n < 4; n++) {
        const a = -0.8 + n * 0.53 + Math.sin(t + n * 1.7 + (side > 0 ? 0 : 2.1)) * 0.16;
        const kx = side * Math.cos(a) * 10, ky = Math.sin(a) * 9 - 3;
        const fx = side * Math.cos(a) * 18, fy = Math.sin(a) * 11 + 7;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
      }
    }
    ctx.fillStyle = '#0a0b0d'; ctx.strokeStyle = '#3fd9a0'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(0, 0, 7, 8.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = PINK; ctx.beginPath(); ctx.arc(0, 0.5, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function sizeCanvas() {
    const r = ui.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(r.width * dpr); ui.canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(realNow) {
    if (!ui.stage.getBoundingClientRect().width) return;
    const g = geometry();
    ctx.clearRect(0, 0, g.W, g.H);
    if (!data) return;

    // sector guides: one faint arc per layer, with its name
    ORDER.forEach((k, idx) => {
      const pts = [];
      for (let f = 0; f <= 1.0001; f += 0.1) pts.push(arcPoint(g, idx, f));
      ctx.strokeStyle = hexA(LAYERS[k].color, 0.35); ctx.lineWidth = 1;
      ctx.beginPath(); pts.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    });

    const active = activeSentence();
    const sp = placeSpider(g, active);
    const fresh = [];
    for (let j = 0; j < fired; j++) {
      const e = timeline[j];
      const age = e.real ? (realNow - e.real) / 1000 : 99;
      const P = arcPoint(g, IDX[e.f.layer], e.slot);
      const color = LAYERS[e.f.layer].color;
      const p = e.f.p != null ? e.f.p : 1;
      const room = g.side === 'right' ? Math.max(8, g.limit - P.x) : Math.max(8, g.limit - P.y);
      const len = Math.min(room, 8 + p * room * 0.9);
      const sel = selected != null && e.i === selected;
      if (age < 1.6 || sel) { fresh.push({ e, P, len, age, sel }); continue; }
      const O = fractionOrigin(g, e.i);
      ctx.globalAlpha = selected != null ? 0.03 : 0.07;
      ctx.strokeStyle = '#c8ccd2'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(O.x, O.y); ctx.quadraticCurveTo((O.x + P.x) / 2, (O.y + P.y) / 2, P.x, P.y); ctx.stroke();
      ctx.globalAlpha = selected != null ? 0.35 : 0.85;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(P.x + P.ux * len, P.y + P.uy * len); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    fresh.sort((a, b) => (a.e.real || 0) - (b.e.real || 0));
    fresh.forEach((o, idx) => {
      const { e, P, len } = o;
      const a = o.sel ? 1 : Math.max(0, 1 - o.age / 1.6);
      const O = sp && e.i === active ? sp : rowOrigin(g, e.i) || fractionOrigin(g, e.i);
      ctx.globalAlpha = 0.3 + 0.7 * a;
      ctx.strokeStyle = PINK; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(O.x, O.y); ctx.lineTo(P.x, P.y); ctx.stroke();
      ctx.strokeStyle = LAYERS[e.f.layer].color; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(P.x + P.ux * len, P.y + P.uy * len); ctx.stroke();
      if (e.f.settled) { ctx.fillStyle = PINK; ctx.beginPath(); ctx.arc(P.x + P.ux * len, P.y + P.uy * len, 2.6, 0, Math.PI * 2); ctx.fill(); }
      const showLabel = o.sel ? true : idx >= fresh.length - (g.side === 'right' ? 5 : 1);
      if (showLabel) label(g, P, e, ctx.globalAlpha);
    });
    ctx.globalAlpha = 1;
    if (sp) drawSpider(sp, realNow);
  }

  function label(g, P, e, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const font = getComputedStyle(document.body).fontFamily;
    ctx.font = '11px ' + font;
    const q = e.f.q + (e.f.p != null ? '  p ' + e.f.p.toFixed(2) : '');
    const a = clip(e.f.a, 16);
    const right = g.side === 'right';
    const tx = right ? P.x - 12 : P.x, ty = right ? P.y : P.y - 22;
    ctx.fillStyle = '#9aa1ab';
    const qw = ctx.measureText(q).width;
    ctx.fillText(q, Math.min(Math.max(4, right ? tx - qw : tx - qw / 2), g.W - qw - 4), ty - 13);
    ctx.font = '12px ' + font;
    const w = ctx.measureText(a).width + 10;
    const bx = Math.min(Math.max(4, right ? tx - w : tx - w / 2), g.W - w - 4);
    ctx.fillStyle = PINK; ctx.fillRect(bx, ty - 9, w, 18);
    ctx.fillStyle = '#12060b'; ctx.fillText(a, bx + 5, ty + 4);
    ctx.restore();
  }

  // ---------------------------------------------------------------- loop & controls
  const flashTimers = {};
  function flash(layer) {
    const card = ui.cards[IDX[layer]];
    card.classList.add('flash');
    clearTimeout(flashTimers[layer]);
    flashTimers[layer] = setTimeout(() => card.classList.remove('flash'), 260);
  }

  function frame(realNow) {
    const dt = Math.min(250, realNow - lastFrame);
    lastFrame = realNow;
    if (data) {
      if (playing) {
        now = Math.min(duration, now + dt * speed);
        while (fired < timeline.length && timeline[fired].t <= now) {
          const e = timeline[fired];
          e.real = realNow;
          if (e.i >= 0) sentences[e.i].firedSteps++;
          flash(e.f.layer);
          fired++;
        }
        if (now >= duration) setPlaying(false);
      }
      render(false);
      draw(realNow);
    }
    requestAnimationFrame(frame);
  }

  ui.play.addEventListener('click', () => { if (now >= duration) seek(0); setPlaying(!playing); });
  ui.restart.addEventListener('click', () => { seek(0); setPlaying(true); });
  ui.speed.addEventListener('change', () => { speed = Number(ui.speed.value) || 1; });
  ui.scrub.addEventListener('input', () => seek((Number(ui.scrub.value) / 1000) * duration));
  ui.follow.addEventListener('click', () => { selected = null; ui.follow.hidden = true; markSelected(); lastRendered = -1; });
  ['wheel', 'touchmove'].forEach((t) => ui.transcript.addEventListener(t, () => { userScrolledAt = performance.now(); }, { passive: true }));
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

  window.oopsFunnel = { pause: () => setPlaying(false), resume: () => { if (data && now < duration) setPlaying(true); } };
  new ResizeObserver(sizeCanvas).observe(ui.stage);
  sizeCanvas();
  fetch('./funnel-sample.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(load)
    .catch((err) => { ui.badge.textContent = '载入失败'; ui.note.textContent = '示例数据载入失败：' + err.message; });
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });
})();
