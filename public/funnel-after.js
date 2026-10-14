// Oops 会后整理：回放 scripts/funnel_replay.py 输出里的 post 段。
// 第 1 步 DeepSeek 一次读完全文写纪要（真实耗时来自回放）；第 2–4 步是后端现有代码：
// minutes_items 把纪要变成事项并对回原话，item_quality 复核，review_queue 排出会后核对顺序。
// 蜘蛛按原话顺序爬过全文，抓住被引用的句子，把事项标题提出来放到右侧。文字一律用 textContent 写入。
(() => {
  'use strict';
  const KIND = { task: { name: '待办', color: '#3fd9a0' }, decision: { name: '决定', color: '#f2896b' }, open: { name: '未决问题', color: '#ff3dd2' } };
  const KIND_ORDER = ['task', 'decision', 'open'];
  const QUEUE = { commitment: '核对待办', decision: '核对决定', speaker: '补说话人' };
  const PINK = '#ff3d8b', CYAN = '#5cc3ff';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const fmt = (ms) => ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';

  const ui = {
    stage: $('after-stage'), canvas: $('after-canvas'), doc: $('doc'), docMeta: $('doc-meta'), docTitle: $('doc-title'),
    play: $('after-play'), restart: $('after-restart'), speed: $('after-speed'), note: $('after-note'),
    overview: $('overview'), queue: $('queue'), cost: $('after-cost'), pipeline: [...document.querySelectorAll('#pipeline li')],
    boards: { task: $('board-task'), decision: $('board-decision'), open: $('board-open') },
    counts: { task: $('n-task'), decision: $('n-decision'), open: $('n-open') },
    tabs: [...document.querySelectorAll('.modes button')], live: $('mode-live'), after: $('mode-after'),
  };
  const ctx = ui.canvas.getContext('2d');

  let data = null, post = null, rows = [], items = [], events = [], next = 0;
  let at = 0, playing = false, speed = 1, lastFrame = 0, started = false, total = 1;
  let here = -1, grabUntil = 0, flyers = [], phases = [0, 0, 0, 0], ends = [0, 0, 0, 0];
  const spider = { x: 0, y: 0, ready: false, feet: [] };

  // ---------------------------------------------------------------- build
  function clauses(text) {
    const parts = text.match(/[^，。！？,.!?；;、]+[，。！？,.!?；;、]*|[，。！？,.!?；;、]+/g) || [text];
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function build(raw) {
    data = raw; post = raw && raw.post;
    events = []; next = 0; at = 0; here = -1; flyers = []; phases = [0, 0, 0, 0]; spider.ready = false;
    ui.queue.replaceChildren(); KIND_ORDER.forEach((k) => { ui.boards[k].replaceChildren(); ui.counts[k].textContent = '0'; });
    ui.pipeline.forEach((li) => { li.classList.remove('active', 'done'); li.style.setProperty('--p', '0%'); });
    ['p0', 'p1', 'p2', 'p3'].forEach((id) => { $(id).textContent = ''; });
    const replay = data.source && data.source.kind === 'replay';
    ui.docTitle.textContent = replay ? 'replay.full' : 'transcript.full';
    if (!post) {
      ui.doc.replaceChildren(el('li', null, '这份回放没有会后纪要，看不了会后整理。'));
      ui.note.textContent = ''; ui.overview.replaceChildren(); ui.cost.replaceChildren();
      setPlaying(false); started = false;
      return;
    }
    ui.note.textContent = '纪要由 DeepSeek 一次读完全文生成；下面按原话顺序展示每条结果引用了哪些原话，再用规则复核、排进核对队列。第 2–4 步都是现有后端代码，不调模型。' +
      (replay ? ' 真实会议回放，仅限本机查看。' : ' 示例会议，纪要内容为演示编写。');

    const byId = new Map();
    rows = data.sentences.map((s, i) => {
      const li = el('li');
      const txt = el('span', 'txt');
      const segs = clauses(s.text).map((c) => el('span', 'seg', c));
      txt.append(...segs);
      li.append(el('span', 'num', s.id), el('span', 'spk', s.speaker || '—'), txt);
      const row = { i, id: s.id, text: s.text, outcome: s.outcome, li, txt, segs, items: [] };
      byId.set(s.id, row);
      return row;
    });
    ui.doc.replaceChildren(...rows.map((r) => r.li));

    items = post.items.map((it, n) => {
      const card = el('li', 'card');
      const meta = el('div', 'm');
      const who = [it.owner, it.due].filter(Boolean).join(' · ');
      if (who) meta.append(el('span', null, who));
      const ev = el('span', 'ev');
      const q = el('span', 'q', '');
      meta.append(ev, q);
      card.append(el('div', 't', it.title), meta);
      ui.boards[it.kind].append(card);
      const item = { ...it, n, card, ev, q, shown: false, seen: new Set() };
      it.ids.forEach((id) => { const r = byId.get(id); if (r) r.items.push(item); });
      return item;
    });

    ui.overview.replaceChildren(el('p', null, post.overview || '（纪要没有概览）'));
    if (post.topics && post.topics.length) {
      const t = el('div', 'topics');
      post.topics.forEach((x) => t.append(el('span', null, x)));
      ui.overview.append(t);
    }
    renderCost();
    schedule();
    speed = total > 45000 ? 2 : 1;
    ui.speed.value = String(speed);
    ui.docMeta.textContent = '已读 0 / ' + rows.length;
    started = false;
    if (reduceMotion) { at = total; runUntil(total); }
    if (!ui.after.hidden) start();
  }

  function renderCost() {
    const cited = rows.filter((r) => r.items.length).length;
    const rest = new Map();
    rows.filter((r) => !r.items.length).forEach((r) => {
      const key = String(r.outcome || '').split('，')[0] || '其他';
      rest.set(key, (rest.get(key) || 0) + 1);
    });
    const restText = [...rest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => k + ' ' + n).join(' · ');
    const a = el('div'); a.append(el('div', 'big l-model', '1 次'), el('p', null, 'DeepSeek 写纪要' + (post.latency_ms ? '，耗时 ' + fmt(post.latency_ms) : '') + '。会后只调这一次模型。'));
    const b = el('div'); b.append(el('div', 'big l-code', cited + ' / ' + rows.length), el('p', null, '句被纪要引用为依据。没被引用的：' + (restText || '—')));
    const c = el('p', 'verdict', '对回原话、规则复核、排核对队列都是本地代码：' + items.length + ' 个事项，' + post.queue.length + ' 项待你核对。');
    ui.cost.replaceChildren(a, b, c);
  }

  // ---------------------------------------------------------------- schedule
  function schedule() {
    let t = 0;
    const T0 = Math.min(3200, Math.max(1400, (post.latency_ms || 3000) * 0.5));
    ends[0] = t + T0; t = ends[0];
    events.push({ t: 0, fn: () => step(0, 'active') });
    events.push({ t: ends[0], fn: () => { step(0, 'done'); $('p0').textContent = (post.latency_ms ? fmt(post.latency_ms) + ' · ' : '') + items.length + ' 条结果'; step(1, 'active'); } });
    const start1 = t;
    rows.forEach((r, i) => {
      const cited = r.items.length > 0;
      const dwell = cited ? 1250 : r.outcome && r.outcome.startsWith('语气词') ? 90 : 170;
      const arrive = t;
      events.push({ t: arrive, fn: () => arriveAt(i) });
      if (cited) events.push({ t: arrive + 260, fn: () => grab(r) });
      t += dwell;
    });
    ends[1] = t; const len1 = t - start1;
    events.push({ t, fn: () => { leave(); step(1, 'done'); step(2, 'active'); } });
    phases.start1 = start1; phases.len1 = len1;
    const start2 = t;
    items.forEach((it) => {
      events.push({ t, fn: () => { it.q.className = 'q checking'; it.q.textContent = '复核中'; } });
      t += 380;
      events.push({ t, fn: () => checked(it) });
    });
    ends[2] = t + 200; t = ends[2];
    phases.start2 = start2;
    events.push({ t, fn: () => { step(2, 'done'); step(3, 'active'); } });
    const start3 = t;
    post.queue.forEach((q, n) => { t += 240; events.push({ t, fn: () => enqueue(q, n) }); });
    if (!post.queue.length) events.push({ t, fn: () => ui.queue.append(el('li', 'empty', '没有需要你核对的项。')) });
    ends[3] = t + 300; t = ends[3];
    phases.start3 = start3;
    events.push({ t, fn: () => { step(3, 'done'); $('p3').textContent = post.queue.length + ' 项 · ' + summary(); } });
    total = t + 400;
    events.sort((a, b) => a.t - b.t);
  }

  function summary() {
    const c = { commitment: 0, decision: 0, speaker: 0 };
    post.queue.forEach((q) => { c[q.kind] = (c[q.kind] || 0) + 1; });
    return Object.entries(c).filter(([, n]) => n).map(([k, n]) => QUEUE[k].replace('核对', '') + ' ' + n).join(' · ');
  }

  function step(n, state) {
    const li = ui.pipeline[n];
    li.classList.toggle('active', state === 'active');
    li.classList.toggle('done', state === 'done');
    if (state === 'done') li.style.setProperty('--p', '100%');
  }

  function arriveAt(i) {
    if (here >= 0) { rows[here].li.classList.remove('here'); rows[here].li.classList.add('read'); }
    here = i;
    rows[i].li.classList.add('here');
    ui.docMeta.textContent = '已读 ' + (i + 1) + ' / ' + rows.length;
    $('p1').textContent = '已读 ' + (i + 1) + ' / ' + rows.length + ' · 引用 ' + rows.slice(0, i + 1).filter((r) => r.items.length).length + ' 句';
    follow(rows[i].li);
  }

  function leave() {
    if (here >= 0) { rows[here].li.classList.remove('here'); rows[here].li.classList.add('read'); }
    here = -1;
  }

  function grab(r) {
    grabUntil = at + 800;
    const kinds = KIND_ORDER.filter((k) => r.items.some((it) => it.kind === k));
    r.li.classList.add('cited', 'k-' + kinds[0]);
    kinds.forEach((k) => r.li.querySelector('.txt').append(el('span', 'tagged k-' + k, KIND[k].name)));
    r.items.forEach((it, n) => {
      const from = r.segs[Math.min(r.segs.length - 1, n)];
      if (!it.shown) {
        it.shown = true;
        flyers.push({ text: it.title, color: KIND[it.kind].color, from, to: ui.boards[it.kind].previousElementSibling, start: at + n * 180, dur: 1100, big: true, done: () => land(it, r.id) });
      } else {
        flyers.push({ text: r.id, color: KIND[it.kind].color, from, to: it.card, start: at + n * 180, dur: 700, big: false, done: () => addEvidence(it, r.id, true) });
      }
    });
  }

  function land(it, id) {
    it.card.classList.add('in');
    ui.counts[it.kind].textContent = String(items.filter((x) => x.kind === it.kind && x.card.classList.contains('in')).length);
    addEvidence(it, id, false);
    ensureVisible(it.card);
  }

  function addEvidence(it, id, pulse) {
    if (it.seen.has(id)) return;
    it.seen.add(id);
    const chip = el('span', pulse ? 'new' : '', id);
    chip.title = '定位到原话 ' + id;
    chip.addEventListener('click', () => ping(id));
    it.ev.append(chip);
    if (pulse) { it.card.classList.add('pulse'); setTimeout(() => it.card.classList.remove('pulse'), 450); }
  }

  function checked(it) {
    it.q.className = 'q ' + it.quality.status;
    it.q.textContent = it.quality.label + (it.quality.status === 'accepted' ? '' : '：' + it.quality.reason);
    it.q.title = it.quality.reason;
    const done = items.filter((x) => !x.q.classList.contains('checking') && x.q.textContent).length;
    const c = { accepted: 0, needs_review: 0, rejected: 0 };
    items.forEach((x) => { if (x.q.textContent && !x.q.classList.contains('checking')) c[x.quality.status] = (c[x.quality.status] || 0) + 1; });
    $('p2').textContent = done + ' / ' + items.length + ' · 通过 ' + c.accepted + ' · 待人核对 ' + c.needs_review + (c.rejected ? ' · 否决 ' + c.rejected : '');
    ensureVisible(it.card);
  }

  function enqueue(q, n) {
    const r = rows.find((x) => x.id === q.id);
    const li = el('li');
    li.append(el('span', 'k ' + (q.kind === 'commitment' ? 'l-code' : q.kind === 'decision' ? 'l-model' : 'l-you'), QUEUE[q.kind] || q.kind),
      el('span', 'id', q.id), el('span', 'x', r ? r.text : ''));
    li.addEventListener('click', () => ping(q.id));
    ui.queue.append(li);
    ui.queue.scrollTop = ui.queue.scrollHeight;
    $('p3').textContent = (n + 1) + ' / ' + post.queue.length + ' 项';
  }

  function ping(id) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    follow(r.li, true);
    r.li.classList.add('ping');
    setTimeout(() => r.li.classList.remove('ping'), 900);
  }

  function follow(li, force) {
    const box = ui.doc;
    const top = li.offsetTop - box.clientHeight * 0.42;
    if (force || Math.abs(box.scrollTop - top) > 30) box.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function ensureVisible(card) {
    const board = card.closest('.board');
    const b = board.getBoundingClientRect(), c = card.getBoundingClientRect();
    if (c.bottom > b.bottom || c.top < b.top) board.scrollTo({ top: board.scrollTop + (c.top - b.top) - 40, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function runUntil(t) {
    while (next < events.length && events[next].t <= t) { events[next].fn(); next++; }
  }

  // ---------------------------------------------------------------- playback
  function setPlaying(on) {
    playing = on && post && at < total;
    ui.play.textContent = playing ? '❚❚ 暂停' : '▶ 播放';
  }

  function start() {
    if (!post) return;
    started = true;
    setPlaying(!reduceMotion);
  }

  function restart() { if (data) { build(data); start(); } }

  // ---------------------------------------------------------------- canvas
  function sizeCanvas() {
    const r = ui.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(r.width * dpr); ui.canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function rel(r, base) { return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }; }

  function draw(realNow) {
    const base = ui.stage.getBoundingClientRect();
    ctx.clearRect(0, 0, base.width, base.height);
    if (!post || !base.width) return;
    const doc = rel(ui.doc.getBoundingClientRect(), base);

    // step 1: one sweep over the whole transcript while DeepSeek reads it
    if (at < ends[0]) {
      const p = at / ends[0];
      const y = doc.y + p * doc.h;
      const g = ctx.createLinearGradient(0, y - 40, 0, y);
      g.addColorStop(0, 'rgba(242,137,107,0)'); g.addColorStop(1, 'rgba(242,137,107,.28)');
      ctx.fillStyle = g; ctx.fillRect(doc.x, y - 40, doc.w, 40);
      ctx.strokeStyle = '#f2896b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(doc.x, y); ctx.lineTo(doc.x + doc.w, y); ctx.stroke();
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily; ctx.fillStyle = '#f2896b';
      ctx.fillText('DeepSeek 正在读全文' + (post.latency_ms ? ' · 实际 ' + fmt(post.latency_ms) : ''), doc.x + 12, Math.max(doc.y + 16, y - 8));
      ui.pipeline[0].style.setProperty('--p', Math.round(p * 100) + '%');
    } else if (at < ends[1] && phases.len1) {
      ui.pipeline[1].style.setProperty('--p', Math.round(((at - phases.start1) / phases.len1) * 100) + '%');
    } else if (at < ends[2] && ends[2] > phases.start2) {
      ui.pipeline[2].style.setProperty('--p', Math.round(((at - phases.start2) / (ends[2] - phases.start2)) * 100) + '%');
    } else if (at < ends[3] && ends[3] > phases.start3) {
      ui.pipeline[3].style.setProperty('--p', Math.round(((at - phases.start3) / (ends[3] - phases.start3)) * 100) + '%');
    }

    if (here >= 0) drawSpider(base, doc, realNow);
    else spider.ready = false;

    flyers = flyers.filter((f) => {
      if (at < f.start) return true;
      const k = Math.min(1, (at - f.start) / f.dur);
      const a = rel(f.from.getBoundingClientRect(), base), b = rel(f.to.getBoundingClientRect(), base);
      const sx = a.x + a.w / 2, sy = a.y + a.h / 2, tx = b.x + 14, ty = b.y + 14;
      const lift = f.big ? 0.38 : 0.15;
      let x, y, size, alpha;
      if (k < lift) { const e = k / lift; x = sx + 8 * e; y = sy - 26 * e; size = (f.big ? 13 + 11 * e : 11); alpha = e; }
      else { const e = (k - lift) / (1 - lift), ease = e * e * (3 - 2 * e); x = sx + 8 + (tx - sx - 8) * ease; y = sy - 26 + (ty - sy + 26) * ease; size = f.big ? 24 - 11 * ease : 11; alpha = 1 - 0.35 * ease; }
      glitch(f.text, x, y, size, f.color, alpha, f.big);
      if (k >= 1) { f.done(); return false; }
      return true;
    });
  }

  function glitch(text, x, y, size, color, alpha, big) {
    const font = getComputedStyle(document.body).fontFamily;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = (big ? '600 ' : '') + size + 'px ' + font;
    const t = big ? clip(text, 22) : text;
    const w = ctx.measureText(t).width;
    const W = ui.canvas.width / Math.min(2, window.devicePixelRatio || 1);
    x = Math.min(Math.max(4, x), W - w - 8);
    ctx.fillStyle = 'rgba(10,11,13,.82)'; ctx.fillRect(x - 5, y - size * 0.9, w + 10, size * 1.3);
    ctx.fillStyle = color; ctx.fillRect(x - 5, y + size * 0.4 - 2, w + 10, 2);
    if (big) {
      ctx.fillStyle = 'rgba(92,195,255,.55)'; ctx.fillText(t, x - 1.5, y);
      ctx.fillStyle = 'rgba(255,61,139,.55)'; ctx.fillText(t, x + 1.5, y);
    }
    ctx.fillStyle = color; ctx.fillText(t, x, y);
    ctx.restore();
  }

  function drawSpider(base, doc, realNow) {
    const r = rows[here];
    const segRects = r.segs.map((s) => rel(s.getBoundingClientRect(), base)).filter((q) => q.w > 0);
    if (!segRects.length) return;
    const first = segRects[0], last = segRects[segRects.length - 1];
    let tx = (first.x + last.x + last.w) / 2, ty = first.y - 18;
    tx = Math.min(Math.max(tx, doc.x + 40), doc.x + doc.w - 40);
    ty = Math.min(Math.max(ty, doc.y + 30), doc.y + doc.h - 30);
    if (!spider.ready) { spider.x = tx; spider.y = ty; spider.ready = true; spider.feet = []; }
    const k = reduceMotion ? 1 : 0.2;
    spider.x += (tx - spider.x) * k; spider.y += (ty - spider.y) * k;
    const grabbing = at < grabUntil && r.items.length;
    const wob = reduceMotion || !playing ? 0 : realNow / 110;
    for (let n = 0; n < 8; n++) {
      const side = n < 4 ? -1 : 1, j = n % 4;
      let want;
      if (grabbing && n < Math.max(2, segRects.length * 2)) {
        const s = segRects[n % segRects.length];
        want = { x: s.x + ((n * 37) % Math.max(8, s.w)), y: s.y + s.h / 2 };
      } else {
        const ang = (-0.9 + j * 0.6) + Math.sin(wob + n) * 0.12;
        want = { x: spider.x + side * Math.cos(ang) * 34, y: spider.y + Math.sin(ang) * 26 + 8 };
      }
      const f = spider.feet[n] || (spider.feet[n] = { x: want.x, y: want.y });
      const d = Math.hypot(want.x - f.x, want.y - f.y);
      if (grabbing || d > 14) { f.x += (want.x - f.x) * (grabbing ? 0.35 : 0.5); f.y += (want.y - f.y) * (grabbing ? 0.35 : 0.5); }
      const mx = (spider.x + f.x) / 2, my = (spider.y + f.y) / 2;
      const nx = -(f.y - spider.y), ny = f.x - spider.x, nl = Math.hypot(nx, ny) || 1;
      const kneeX = mx + (nx / nl) * 9 * side, kneeY = my + (ny / nl) * 9 * side - 6;
      ctx.strokeStyle = grabbing && n < segRects.length * 2 ? PINK : 'rgba(92,195,255,.85)';
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(spider.x, spider.y); ctx.lineTo(kneeX, kneeY); ctx.lineTo(f.x, f.y); ctx.stroke();
      ctx.fillStyle = '#e6e8eb';
      ctx.beginPath(); ctx.arc(kneeX, kneeY, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(f.x, f.y, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(10,11,13,.9)'; ctx.strokeStyle = CYAN; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.ellipse(spider.x, spider.y + 4, 7, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(spider.x, spider.y - 7, 4.5, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = grabbing ? PINK : '#3fd9a0'; ctx.beginPath(); ctx.arc(spider.x, spider.y + 4, 2.6, 0, Math.PI * 2); ctx.fill();
  }

  function frame(realNow) {
    const dt = Math.min(100, realNow - lastFrame);
    lastFrame = realNow;
    if (post && !ui.after.hidden) {
      if (playing) {
        at = Math.min(total, at + dt * speed);
        runUntil(at);
        if (at >= total) setPlaying(false);
      }
      draw(realNow);
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- tabs & controls
  function showMode(mode) {
    const after = mode === 'after';
    ui.tabs.forEach((b) => { const on = b.dataset.mode === mode; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    ui.live.hidden = after; ui.after.hidden = !after;
    document.body.classList.toggle('mode-after', after);
    if (after) {
      if (window.oopsFunnel) window.oopsFunnel.pause();
      sizeCanvas();
      if (!started) start(); else if (at < total) setPlaying(true);
    } else {
      setPlaying(false);
      if (window.oopsFunnel) window.oopsFunnel.resume();
    }
    try { history.replaceState(null, '', after ? '#after' : '#live'); } catch (e) { /* hash is optional */ }
  }
  ui.tabs.forEach((b, n) => {
    b.addEventListener('click', () => showMode(b.dataset.mode));
    b.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const other = ui.tabs[(n + 1) % ui.tabs.length]; other.focus(); showMode(other.dataset.mode);
    });
  });
  ui.play.addEventListener('click', () => { if (at >= total) { restart(); return; } if (!started) start(); else setPlaying(!playing); });
  ui.restart.addEventListener('click', restart);
  ui.speed.addEventListener('change', () => { speed = Number(ui.speed.value) || 1; });

  document.addEventListener('funnel:data', (ev) => {
    build(ev.detail);
    if (location.hash === '#after' && ui.after.hidden) showMode('after');
  });
  new ResizeObserver(sizeCanvas).observe(ui.stage);
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });
})();
