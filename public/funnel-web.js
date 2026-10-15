/* Jev's web: one strand per saved question of the current sentence, one ring per finished sentence.
   Draws only steps the replay has already reached; never invents an answer, probability or call. */
(() => {
  'use strict';
  const LAYER = { code: '规则', jev: 'Jev', model: '生成', you: '你' };
  const COLOR = { code: '#5fd6a4', jev: '#b9a3ff', model: '#f3b56f', you: '#ff8cc0', idle: '#4a4760' };
  const KIND_NAME = { task: '待办', decision: '决定', open: '未决' };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clip = (text, n) => { const s = String(text ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const pct = p => Number.isFinite(p) ? Math.round(p * 100) + '%' : '';

  /* Which saved steps of a sentence the replay has reached. Selection shows the whole saved row. */
  function reachedForks(snapshot, index) {
    const rows = snapshot.sentences || snapshot.data?.sentences || [];
    const row = rows[index];
    if (!row) return [];
    const forks = row.forks || [];
    if (snapshot.selected === index) return forks.map((fork, i) => ({ fork, i, at: -Infinity }));
    const now = snapshot.now || 0;
    const timeline = snapshot.timeline || [];
    const fired = timeline.filter(e => e.i === index && e.f && e.t <= now);
    if (fired.length || timeline.some(e => e.i === index)) return fired.map(e => ({ fork: e.f, i: forks.indexOf(e.f), at: e.t }));
    return Number.isFinite(row.doneAt) && now >= row.doneAt ? forks.map((fork, i) => ({ fork, i, at: row.doneAt })) : [];
  }

  function liveScene(snapshot = {}, current = -1) {
    const rows = snapshot.data?.sentences?.length ? (snapshot.sentences || snapshot.data.sentences) : [];
    if (!rows.length || !rows[current]) return { hub: 'Jev', spokes: [], rings: [], spider: null, empty: true };
    const now = snapshot.now || 0;
    const reached = reachedForks(snapshot, current);
    const total = Math.max(reached.length, 1);
    const spokes = reached.map(({ fork, at }, k) => ({
      layer: LAYER[fork.layer] ? fork.layer : 'idle',
      angle: -Math.PI / 2 + (k / total) * Math.PI * 2 + (total === 1 ? 0 : Math.PI / total / 2),
      reach: Number.isFinite(fork.p) ? 0.45 + 0.5 * clamp(fork.p, 0, 1) : 0.62,
      measured: Number.isFinite(fork.p),
      answer: clip(fork.a || '未记录', 9),
      p: fork.p,
      at,
    }));
    const done = rows.filter((row, i) => i < current && (snapshot.selected != null || !Number.isFinite(row.doneAt) || row.doneAt <= now));
    const rings = done.slice(-10).map(row => row.route && LAYER[row.route] ? row.route : 'idle');
    // The spider sits on the newest strand while that step is fresh, otherwise rests at the hub.
    const latest = spokes.length ? spokes.reduce((a, b) => (b.at >= a.at ? b : a)) : null;
    const fresh = latest && snapshot.playing && now - latest.at <= Math.max(1, snapshot.speed || 1) * 900;
    const working = !!snapshot.playing && Number.isFinite(rows[current].doneAt) && now >= (rows[current].end_ms ?? 0) && now < rows[current].doneAt;
    return { hub: 'Jev', spokes, rings, spider: fresh ? { angle: latest.angle, reach: latest.reach } : { angle: 0, reach: 0 }, working: working || !!fresh, empty: false };
  }

  /* After the meeting: items on three sectors around the minutes hub, revealed in the engine's phase order. */
  function afterScene(snapshot = {}, selected = null) {
    const post = snapshot.data?.sentences?.length ? snapshot.data.post : null;
    if (!post) return { hub: '纪要', nodes: [], spider: null, empty: true };
    const items = post.items || [];
    const at = snapshot.at ?? snapshot.now ?? 0, ends = snapshot.ends || [];
    const phase = { minutes: 0, evidence: 1, quality: 2, queue: 3, complete: 4, missing: 0 }[snapshot.phase] ?? 4;
    const started = snapshot.started !== false && (at > 0 || phase > 0 || snapshot.playing);
    const shown = !started ? items.length : phase > 0 ? items.length : Math.ceil(clamp(at / Math.max(1, ends[0] || 1), 0, 1) * items.length);
    const queue = (post.queue || []).map(q => q.id);
    // Whole circle, items kept together by kind, alternating reach so neighbouring labels do not collide.
    const order = ['task', 'decision', 'open'];
    const ranked = items.map((item, index) => ({ item, index })).sort((a, b) => ((order.indexOf(a.item.kind) + 4) % 4) - ((order.indexOf(b.item.kind) + 4) % 4) || a.index - b.index);
    const nodes = [];
    ranked.forEach(({ item, index }, k) => {
      if (index >= shown) return;
      nodes.push({
        id: item.id, kind: item.kind, kindName: KIND_NAME[item.kind] || '事项',
        angle: -Math.PI / 2 + (k + 0.5) / ranked.length * Math.PI * 2,
        reach: ranked.length > 6 && k % 2 ? 0.6 : 0.9,
        title: clip(item.title, 9),
        evidence: phase >= 1 || !started ? (item.ids || []).length : 0,
        quality: phase >= 2 || !started ? item.quality?.status || null : null,
        order: phase >= 3 || !started ? queue.indexOf(item.id) + 1 || null : null,
        selected: item.id === selected,
      });
    });
    let spider = { angle: 0, reach: 0 };
    if (snapshot.playing && nodes.length) {
      const target = phase === 0 ? nodes.find(n => items.findIndex(i => i.id === n.id) === shown - 1) : nodes[Math.floor(at / 900) % nodes.length];
      if (target) spider = { angle: target.angle, reach: target.reach };
    } else if (selected) {
      const target = nodes.find(n => n.selected);
      if (target) spider = { angle: target.angle, reach: target.reach };
    }
    return { hub: '纪要', nodes, spider, empty: false, working: !!snapshot.playing };
  }

  window.OopsWeb = Object.freeze({ reachedForks, liveScene, afterScene, COLOR });
  if (typeof document === 'undefined' || !document.createElement) return;

  /* ------------------------------------------------------------ canvas renderer */
  function createWeb(canvas, { onPick, outsideSpider } = {}) {
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return { draw() {}, stop() {} };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let scene = { spokes: [], rings: [], nodes: [], empty: true }, pos = { angle: 0, reach: 0 }, raf = 0, last = 0, phase = 0, hits = [], anchors = { hub: null, spokes: [], nodes: [] };
    let W = 0, H = 0;
    function size() {
      const box = canvas.getBoundingClientRect(); const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(1, box.width); H = Math.max(1, box.height);
      const w = Math.round(W * dpr), h = Math.round(H * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const polar = (cx, cy, r, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    function frameLines(cx, cy, R) {
      ctx.strokeStyle = '#2c2a3d'; ctx.lineWidth = 1;
      for (let k = 0; k < 12; k++) { const [x, y] = polar(cx, cy, R, k * Math.PI / 6); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke(); }
    }
    function ring(cx, cy, r, color, alpha) {
      ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = 1.2; ctx.beginPath();
      for (let k = 0; k <= 12; k++) { const a = k * Math.PI / 6, sag = k % 2 ? 0.94 : 1; const [x, y] = polar(cx, cy, r * sag, a); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    function label(text, x, y, color, align = 'center', size = 12, weight = 500) {
      ctx.font = `${weight} ${size}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      // Keep every answer readable inside the stage rather than clipped by its edge.
      const w = ctx.measureText(text).width;
      if (align === 'left') x = Math.min(x, W - 6 - w);
      else if (align === 'right') x = Math.max(x, 6 + w);
      ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, x, y);
    }
    function spider(cx, cy, R, t) {
      const [x, y] = polar(cx, cy, R * pos.reach, pos.angle);
      const moving = scene.working && !reduce.matches;
      ctx.save(); ctx.translate(x, y); ctx.rotate(pos.reach > 0.05 ? pos.angle + Math.PI / 2 : 0);
      ctx.strokeStyle = '#d9ccff'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      for (let side = -1; side <= 1; side += 2) for (let k = 0; k < 4; k++) {
        const wave = moving ? Math.sin(t / 110 + k * 1.7 + (side > 0 ? Math.PI : 0)) * 0.18 : 0;
        const base = (-0.75 + k * 0.5) + wave;
        const kx = side * 13 * Math.cos(base * 0.6), ky = -3 + k * 3.2 - 6;
        const fx = side * 21 * Math.cos(base * 0.4), fy = -9 + k * 7 + wave * 10;
        ctx.beginPath(); ctx.moveTo(side * 3, -2 + k * 2); ctx.quadraticCurveTo(kx, ky - 6, fx, fy); ctx.stroke();
      }
      ctx.fillStyle = '#b9a3ff'; ctx.shadowColor = '#9c82ff'; ctx.shadowBlur = scene.working ? 16 : 6;
      ctx.beginPath(); ctx.ellipse(0, 5, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, -6, 5, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#1b1530';
      ctx.beginPath(); ctx.arc(-2, -7, 1.3, 0, Math.PI * 2); ctx.arc(2, -7, 1.3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    function draw(t) {
      size(); ctx.clearRect(0, 0, W, H); hits = [];
      const cx = W / 2, cy = H / 2 + 6, R = Math.max(40, Math.min(W * 0.42, H * 0.43));
      anchors = { hub: { x: cx, y: cy }, spokes: [], nodes: [] };
      frameLines(cx, cy, R);
      if (scene.empty) { label('等待来源', cx, cy, '#6f6a86', 'center', 13); return; }
      // Finished sentences make the web grow outward, newest ring innermost-out.
      const rings = scene.rings || [];
      rings.forEach((layer, k) => ring(cx, cy, R * (0.2 + 0.78 * (k + 1) / Math.max(10, rings.length)), COLOR[layer] || COLOR.idle, 0.28 + 0.5 * (k + 1) / rings.length));
      for (const s of scene.spokes || []) {
        const [x, y] = polar(cx, cy, R * s.reach, s.angle);
        ctx.strokeStyle = COLOR[s.layer]; ctx.lineWidth = s.measured ? 1 + 2.4 * (s.p || 0) : 1.2; ctx.setLineDash(s.measured ? [] : [4, 4]);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = COLOR[s.layer]; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        anchors.spokes.push({ x, y, layer: s.layer, label: s.answer + (s.measured ? ' ' + pct(s.p) : '') });
        const right = Math.cos(s.angle) >= 0, lx = x + (right ? 10 : -10);
        label(s.answer, lx, y - 7, '#ece8f7', right ? 'left' : 'right', 12, 600);
        label((LAYER[s.layer] || '') + (s.measured ? ' · ' + pct(s.p) : ' · 无概率'), lx, y + 9, COLOR[s.layer], right ? 'left' : 'right', 10);
      }
      for (const n of scene.nodes || []) {
        const [x, y] = polar(cx, cy, R * n.reach, n.angle);
        const color = n.quality === 'accepted' ? COLOR.code : n.quality === 'rejected' ? '#ff6b7a' : n.quality ? COLOR.model : COLOR.jev;
        ctx.strokeStyle = n.selected ? '#ffffff' : '#5b4f86'; ctx.lineWidth = n.selected ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
        for (let e = 0; e < Math.min(6, n.evidence); e++) { const [ex, ey] = polar(cx, cy, R * n.reach * (0.3 + e * 0.1), n.angle); ctx.fillStyle = '#8fd8ff'; ctx.beginPath(); ctx.arc(ex, ey, 2.2, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, n.selected ? 8 : 6, 0, Math.PI * 2); ctx.fill();
        if (n.order) label(String(n.order), x, y, '#15121f', 'center', 9, 700);
        const right = Math.cos(n.angle) >= 0, lx = x + (right ? 12 : -12);
        label(n.title, lx, y - 7, n.selected ? '#ffffff' : '#ddd8ea', right ? 'left' : 'right', 12, 600);
        label(n.kindName + (n.evidence ? ' · ' + n.evidence + ' 句依据' : ''), lx, y + 9, '#9a93b4', right ? 'left' : 'right', 10);
        hits.push({ id: n.id, x, y });
        anchors.nodes.push({ id: n.id, x, y, label: n.kindName + ' · ' + n.title });
      }
      ctx.fillStyle = '#16131f'; ctx.strokeStyle = '#6d5aa8'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, 18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (pos.reach > 0.05) label(scene.hub, cx, cy, '#cbbcff', 'center', 11, 700);
      // A page-wide crawler, when running, is the spider; the web keeps only its own hub then.
      if (!outsideSpider?.()) spider(cx, cy, R, t);
    }
    function tick(t) {
      raf = 0;
      const target = scene.spider || { angle: 0, reach: 0 };
      if (reduce.matches) pos = { ...target };
      else {
        const k = Math.min(1, (t - (last || t)) / 220);
        let da = target.angle - pos.angle; da = Math.atan2(Math.sin(da), Math.cos(da));
        // Leave via the hub when changing strands, as a spider walks the radials.
        const switching = Math.abs(da) > 0.05 && pos.reach > 0.08;
        pos = switching ? { angle: pos.angle, reach: pos.reach + (0 - pos.reach) * k * 1.6 } : { angle: pos.reach < 0.08 ? target.angle : pos.angle + da * k, reach: pos.reach + (target.reach - pos.reach) * k };
      }
      last = t; phase = t;
      draw(t);
      const settled = Math.abs(pos.reach - (scene.spider?.reach || 0)) < 0.004;
      if (!reduce.matches && (scene.working || !settled)) raf = requestAnimationFrame(tick);
    }
    canvas.addEventListener('click', event => {
      if (!onPick || !hits.length) return;
      const box = canvas.getBoundingClientRect(); const x = event.clientX - box.left, y = event.clientY - box.top;
      const hit = hits.find(h => Math.hypot(h.x - x, h.y - y) < 18);
      if (hit) onPick(hit.id);
    });
    return {
      draw(next) { scene = next; if (next.empty) pos = { angle: 0, reach: 0 }; if (!raf) raf = requestAnimationFrame(tick); },
      stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
      get time() { return phase; },
      /* Viewport positions of what is drawn now: hub, reached strands, item nodes. */
      anchors() {
        const box = canvas.getBoundingClientRect(); const at = p => p && { ...p, x: p.x + box.left, y: p.y + box.top };
        return { hub: at(anchors.hub), spokes: anchors.spokes.map(at), nodes: anchors.nodes.map(at) };
      },
    };
  }
  window.OopsWeb = Object.freeze({ reachedForks, liveScene, afterScene, COLOR, createWeb });
})();
