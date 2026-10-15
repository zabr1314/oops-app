/* Jev as a wireframe crawler that walks across the page to whatever the replay just reached.
   Purely presentational: it visits elements and labels that already show saved results. */
(() => {
  'use strict';
  const LEGS = 8, REACH = 56, STEP = 34, STEP_MS = 120;
  const TONE = { code: '#5fd6a4', jev: '#b9a3ff', model: '#f3b56f', you: '#ff8cc0', idle: '#b9a3ff' };

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
  window.OopsCrawler = { footTargets };
  if (typeof document === 'undefined' || !document.createElement || !document.body) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = document.createElement('canvas');
  canvas.className = 'crawler-layer'; canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  let body = null, heading = 0, feet = [], queue = [], current = null, dwellUntil = 0, raf = 0, last = 0, home = null, tone = 'jev';

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
  function flash(el) {
    if (!el?.classList) return;
    el.classList.remove('is-touched'); void el.offsetWidth; el.classList.add('is-touched');
    setTimeout(() => el.classList.remove('is-touched'), 900);
  }
  function tag(text, at, color) {
    if (!text || !at) return;
    const node = document.createElement('span');
    node.className = 'crawler-tag'; node.textContent = text; node.style.setProperty('--tone', color);
    node.style.left = Math.min(innerWidth - 12, at.x + 14) + 'px'; node.style.top = Math.max(8, at.y - 30) + 'px';
    document.body.append(node);
    setTimeout(() => node.remove(), 1500);
  }

  function next(now) {
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
    if (!body) { raf = 0; return; }
    if (!current || (current.rest && queue.length)) next(t);
    if (current && !current.rest && current.point) current.at = current.point() || current.at;
    let moving = false;
    if (current) {
      const dx = current.at.x - body.x, dy = current.at.y - body.y, d = Math.hypot(dx, dy);
      if (d > 2) {
        // Ease in long walks, but keep up with fast replays.
        const speed = Math.min(d * 7, 950) * dt / 1000;
        body = { x: body.x + dx / d * Math.min(d, speed), y: body.y + dy / d * Math.min(d, speed) };
        const want = Math.atan2(dy, dx); let da = Math.atan2(Math.sin(want - heading), Math.cos(want - heading));
        heading += da * Math.min(1, dt / 90); moving = true;
      } else if (!current.arrived) {
        current.arrived = true; dwellUntil = t + (current.dwell ?? 380);
        if (!current.rest) { flash(current.el); tag(current.label, current.at, TONE[current.tone] || TONE.jev); tone = current.tone || tone; }
      } else if (t >= dwellUntil && !current.rest) current = null;
    }
    // Gait: a foot replants once it trails too far, alternating groups so the body never floats.
    const targets = footTargets(body.x, body.y, heading);
    if (!feet.length) feet = targets.map(p => ({ ...p, from: p, to: p, start: -1 }));
    const stepping = feet.filter(f => f.start >= 0).length;
    feet.forEach((f, i) => {
      if (f.start >= 0) {
        const k = Math.min(1, (t - f.start) / STEP_MS);
        f.x = f.from.x + (f.to.x - f.from.x) * k; f.y = f.from.y + (f.to.y - f.from.y) * k;
        if (k >= 1) f.start = -1;
      } else {
        const gap = Math.hypot(f.x - targets[i].x, f.y - targets[i].y);
        // Alternate groups normally; a foot left far behind always catches up so legs never stretch.
        if (!(gap > STEP * 2.2 || (gap > STEP && stepping < 4 && (i + Math.floor(t / STEP_MS)) % 2 === 0))) return;
        const lead = { x: targets[i].x + Math.cos(heading) * STEP * 0.6, y: targets[i].y + Math.sin(heading) * STEP * 0.6 };
        Object.assign(f, { from: { x: f.x, y: f.y }, to: moving ? lead : targets[i], start: t });
      }
    });
    draw(t, moving);
    if (moving || feet.some(f => f.start >= 0) || queue.length || (current && !current.rest)) raf = requestAnimationFrame(frame);
  }
  function draw(t, moving) {
    const line = TONE[tone] || TONE.jev;
    // Faint constellation between the planted feet, as in the reference.
    ctx.globalAlpha = 0.28; ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.beginPath();
    feet.forEach((f, i) => { const g = feet[(i + 2) % LEGS]; ctx.moveTo(f.x, f.y); ctx.lineTo(g.x, g.y); }); ctx.stroke();
    ctx.globalAlpha = 1;
    if (current && !current.rest && !current.arrived) {
      ctx.setLineDash([3, 5]); ctx.strokeStyle = line; ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.moveTo(body.x, body.y); ctx.lineTo(current.at.x, current.at.y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    feet.forEach((f, i) => {
      const side = i < LEGS / 2 ? -1 : 1;
      const hip = { x: body.x + Math.cos(heading + side * 1.2) * 7, y: body.y + Math.sin(heading + side * 1.2) * 7 };
      const mx = (hip.x + f.x) / 2, my = (hip.y + f.y) / 2, len = Math.hypot(f.x - hip.x, f.y - hip.y) || 1;
      const lift = f.start >= 0 ? 10 : 0;
      const knee = { x: mx + (-(f.y - hip.y) / len) * side * (17 + lift), y: my + ((f.x - hip.x) / len) * side * (17 + lift) };
      ctx.strokeStyle = i % 2 ? '#ff8cc0' : line; ctx.lineWidth = 1.7;
      ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(knee.x, knee.y); ctx.lineTo(f.x, f.y); ctx.stroke();
      ctx.fillStyle = '#5fd6a4';
      ctx.beginPath(); ctx.arc(knee.x, knee.y, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(f.x, f.y, f.start >= 0 ? 2 : 3, 0, Math.PI * 2); ctx.fill();
    });
    ctx.save(); ctx.translate(body.x, body.y); ctx.rotate(heading);
    ctx.strokeStyle = '#efe9ff'; ctx.lineWidth = 1.4; ctx.fillStyle = '#1a1530';
    ctx.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * 12, Math.sin(a) * 8.5); } ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = line; ctx.shadowColor = line; ctx.shadowBlur = moving ? 14 : 8;
    ctx.beginPath(); ctx.arc(9, 0, 4.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function wake() { if (!raf && body && !reduce.matches) raf = requestAnimationFrame(frame); }

  window.OopsCrawler = Object.freeze({
    footTargets,
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
    clear() { queue = []; current = null; document.querySelectorAll('.crawler-tag').forEach(n => n.remove()); wake(); },
  });
  addEventListener('resize', wake);
  addEventListener('scroll', wake, { passive: true, capture: true });
  reduce.addEventListener?.('change', () => { if (reduce.matches) { body = null; queue = []; current = null; size(); ctx.clearRect(0, 0, innerWidth, innerHeight); } });
})();
