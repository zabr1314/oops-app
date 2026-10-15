/* Jev as a neon wireframe crawler that walks across the page to whatever the replay just reached.
   Purely presentational: it visits elements and labels that already show saved results. */
(() => {
  'use strict';
  const LEGS = 8, REACH = 84, STEP = 50, STEP_MS = 120;
  const TONE = { code: '#3dffa8', jev: '#b88cff', model: '#ffb547', you: '#ff4fa3', idle: '#b88cff' };
  const JOINT = '#5dffb0', SILK = '#ff4fa3';

  /* Ideal foot positions around a body heading; legs fan forward and back like the reference crawler. */
  function footTargets(x, y, heading, reach = REACH) {
    const out = [];
    for (let i = 0; i < LEGS; i++) {
      const side = i < LEGS / 2 ? -1 : 1, k = i % (LEGS / 2);
      const a = heading + side * (0.45 + k * 0.62);
      const r = reach * (k === 0 || k === 3 ? 1.08 : 0.92);
      out.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
    }
    return out;
  }
  /* Tendrils reach the nearest visible anchors, so the crawler looks wired into the page around it. */
  function nearest(points, x, y, count = 5, range = 320) {
    return points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map(p => ({ ...p, d: Math.hypot(p.x - x, p.y - y) })).filter(p => p.d > 12 && p.d < range)
      .sort((a, b) => a.d - b.d).slice(0, count);
  }
  window.OopsCrawler = { footTargets, nearest };
  if (typeof document === 'undefined' || !document.createElement || !document.body) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = document.createElement('canvas');
  canvas.className = 'crawler-layer'; canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  let body = null, heading = 0, feet = [], queue = [], current = null, dwellUntil = 0, raf = 0, last = 0, home = null, tone = 'jev';
  let trail = [], bursts = [], anchors = () => [], live = false;

  function size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = innerWidth, h = innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const visible = r => r && r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  function pointOf(step) {
    if (step.point) return step.point();
    const r = step.el?.getBoundingClientRect?.();
    if (!visible(r)) return null;
    return { x: r.left + Math.min(r.width - 14, Math.max(14, r.width * (step.ax ?? 0.82))), y: r.top + Math.min(r.height - 8, Math.max(8, r.height * (step.ay ?? 0.5))) };
  }
  function flash(el, color) {
    if (!el?.classList) return;
    el.style.setProperty('--touch', color);
    el.classList.remove('is-touched'); void el.offsetWidth; el.classList.add('is-touched');
    setTimeout(() => el.classList.remove('is-touched'), 1100);
  }
  function tag(text, at, color) {
    if (!text || !at) return;
    const node = document.createElement('span');
    node.className = 'crawler-tag'; node.textContent = text; node.style.setProperty('--tone', color);
    const left = Math.min(innerWidth - 16, at.x + 26), top = Math.max(8, at.y - 46);
    node.style.left = left + 'px'; node.style.top = top + 'px';
    document.body.append(node);
    bursts.push({ x: at.x, y: at.y, tx: left, ty: top + 14, color, start: performance.now(), tag: true });
    setTimeout(() => node.remove(), 1700);
  }

  function next() {
    while (queue.length) {
      const step = queue.shift(); const at = pointOf(step);
      if (at) { current = { ...step, at }; return; }
    }
    current = null;
    if (home) { const at = home(); if (at) current = { at, rest: true }; }
  }
  function frame(t) {
    raf = 0;
    const dt = Math.min(50, t - (last || t)); last = t;
    size(); ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!body) return;
    if (!current || (current.rest && queue.length)) next();
    if (current && !current.rest && current.point) current.at = current.point() || current.at;
    let moving = false;
    if (current) {
      const dx = current.at.x - body.x, dy = current.at.y - body.y, d = Math.hypot(dx, dy);
      if (d > 2) {
        // Dash between targets, ease into each landing.
        const speed = Math.min(d * 8, 1200) * dt / 1000;
        body = { x: body.x + dx / d * Math.min(d, speed), y: body.y + dy / d * Math.min(d, speed) };
        const want = Math.atan2(dy, dx); const da = Math.atan2(Math.sin(want - heading), Math.cos(want - heading));
        heading += da * Math.min(1, dt / 80); moving = true;
      } else if (!current.arrived) {
        current.arrived = true; dwellUntil = t + (current.dwell ?? 380);
        if (!current.rest) {
          const color = TONE[current.tone] || TONE.jev; tone = current.tone || tone;
          flash(current.el, color); tag(current.label, current.at, color);
          bursts.push({ x: current.at.x, y: current.at.y, color, start: t });
        }
      } else if (t >= dwellUntil && !current.rest) current = null;
    }
    trail.push({ x: body.x, y: body.y, t }); trail = trail.filter(p => t - p.t < 650);
    bursts = bursts.filter(b => t - b.start < 700);
    // Gait: a foot replants once it trails too far, alternating groups so the body never floats.
    const targets = footTargets(body.x, body.y, heading);
    if (!feet.length) feet = targets.map(p => ({ ...p, from: p, to: p, start: -1 }));
    const stepping = feet.filter(f => f.start >= 0).length;
    feet.forEach((f, i) => {
      if (f.start >= 0) {
        const k = Math.min(1, (t - f.start) / STEP_MS);
        f.x = f.from.x + (f.to.x - f.from.x) * k; f.y = f.from.y + (f.to.y - f.from.y) * k;
        if (k >= 1) f.start = -1;
        return;
      }
      const gap = Math.hypot(f.x - targets[i].x, f.y - targets[i].y);
      // Alternate groups normally; a foot left far behind always catches up so legs never stretch.
      if (!(gap > STEP * 2.2 || (gap > STEP && stepping < 4 && (i + Math.floor(t / STEP_MS)) % 2 === 0))) return;
      const lead = { x: targets[i].x + Math.cos(heading) * STEP * 0.6, y: targets[i].y + Math.sin(heading) * STEP * 0.6 };
      Object.assign(f, { from: { x: f.x, y: f.y }, to: moving ? lead : targets[i], start: t });
    });
    draw(t, moving);
    const busy = moving || feet.some(f => f.start >= 0) || queue.length || (current && !current.rest) || bursts.length || trail.length > 1;
    if (busy || live) raf = requestAnimationFrame(frame);
  }
  function glowLine(points, color, width, blur) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.shadowColor = color; ctx.shadowBlur = blur;
    ctx.beginPath(); points.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.stroke();
  }
  function dot(x, y, r, color, blur = 8) { ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  function draw(t, moving) {
    const line = TONE[tone] || TONE.jev;
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    // Silk trail.
    if (trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        const a = 1 - (t - trail[i].t) / 650;
        ctx.globalAlpha = a * 0.7; glowLine([trail[i - 1], trail[i]], SILK, 2 * a + 0.5, 10);
      }
      ctx.globalAlpha = 1;
    }
    // Tendrils into the page around it.
    const pulse = 0.5 + 0.5 * Math.sin(t / 180);
    for (const p of nearest(anchors(), body.x, body.y)) {
      const a = (1 - p.d / 320) * (0.35 + 0.35 * pulse);
      ctx.globalAlpha = a; glowLine([body, p], line, 1, 6); dot(p.x, p.y, 2.6, JOINT, 10);
    }
    ctx.globalAlpha = 1;
    // Constellation between the planted feet.
    ctx.globalAlpha = 0.35;
    feet.forEach((f, i) => { const g = feet[(i + 2) % LEGS]; glowLine([f, g], line, 1, 4); });
    ctx.globalAlpha = 1;
    if (current && !current.rest && !current.arrived) {
      ctx.setLineDash([4, 6]); ctx.lineDashOffset = -t / 20; ctx.globalAlpha = 0.6; glowLine([body, current.at], line, 1.2, 8);
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    feet.forEach((f, i) => {
      const side = i < LEGS / 2 ? -1 : 1;
      const hip = { x: body.x + Math.cos(heading + side * 1.2) * 9, y: body.y + Math.sin(heading + side * 1.2) * 9 };
      const mx = (hip.x + f.x) / 2, my = (hip.y + f.y) / 2, len = Math.hypot(f.x - hip.x, f.y - hip.y) || 1;
      const lift = f.start >= 0 ? 14 : 0;
      const knee = { x: mx + (-(f.y - hip.y) / len) * side * (24 + lift), y: my + ((f.x - hip.x) / len) * side * (24 + lift) };
      glowLine([hip, knee, f], i % 2 ? SILK : line, 2.2, 12);
      dot(knee.x, knee.y, 3, JOINT, 10);
      dot(f.x, f.y, f.start >= 0 ? 2.4 : 3.6, JOINT, 12);
    });
    // Landing bursts: a ring, sparks and a wire to the label.
    for (const b of bursts) {
      const k = (t - b.start) / 700, e = 1 - Math.pow(1 - k, 3);
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = b.color; ctx.lineWidth = 2; ctx.shadowColor = b.color; ctx.shadowBlur = 16;
      if (b.tag) { glowLine([{ x: b.x, y: b.y }, { x: b.x + (b.tx - b.x) * Math.min(1, k * 4), y: b.y + (b.ty - b.y) * Math.min(1, k * 4) }], b.color, 1.4, 10); continue; }
      ctx.beginPath(); ctx.arc(b.x, b.y, 6 + e * 46, 0, Math.PI * 2); ctx.stroke();
      for (let s = 0; s < 8; s++) {
        const a = s * Math.PI / 4 + 0.3, r0 = 10 + e * 22, r1 = r0 + 12 * (1 - k);
        glowLine([{ x: b.x + Math.cos(a) * r0, y: b.y + Math.sin(a) * r0 }, { x: b.x + Math.cos(a) * r1, y: b.y + Math.sin(a) * r1 }], b.color, 2, 10);
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // Body: hexagon carapace with a glowing head.
    ctx.translate(body.x, body.y); ctx.rotate(heading);
    ctx.shadowColor = line; ctx.shadowBlur = moving ? 26 : 16;
    ctx.fillStyle = '#140f24'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.8;
    ctx.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * 16, Math.sin(a) * 11); } ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = line; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(8, 0); ctx.moveTo(-4, -6); ctx.lineTo(-4, 6); ctx.stroke();
    dot(13, 0, 5.5 + (moving ? 0 : pulse), line, 22);
    ctx.restore();
  }
  function wake() { if (!raf && body && !reduce.matches) raf = requestAnimationFrame(frame); }

  window.OopsCrawler = Object.freeze({
    footTargets, nearest,
    get active() { return !reduce.matches && !!body; },
    /* Replace pending visits; at high replay speeds only the newest stays relevant. */
    visit(steps) {
      if (reduce.matches || !steps?.length) return;
      if (!body) { const start = pointOf(steps[0]) || (home && home()); if (!start) return; body = { ...start }; }
      queue = steps.slice(-6);
      if (current?.rest) current = null;
      wake();
    },
    rest(point) { home = point; if (!queue.length && current?.rest) current = null; if (!body && point?.()) body = { ...point() }; wake(); },
    /* Points the tendrils may reach; `on` keeps it breathing while the replay plays. */
    anchors(fn) { anchors = typeof fn === 'function' ? fn : () => []; },
    live(on) { live = !!on && !reduce.matches; wake(); },
    clear() { queue = []; current = null; bursts = []; document.querySelectorAll('.crawler-tag').forEach(n => n.remove()); wake(); },
  });
  addEventListener('resize', wake);
  addEventListener('scroll', wake, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) live = false; });
  reduce.addEventListener?.('change', () => { if (reduce.matches) { body = null; queue = []; current = null; live = false; size(); ctx.clearRect(0, 0, innerWidth, innerHeight); } });
})();
