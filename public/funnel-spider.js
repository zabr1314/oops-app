/* Jev drawn as a neon wireframe crawler on an existing canvas. Presentation only: the page decides
   where it stands and what it reaches for; this file only walks, glows and lands. */
(() => {
  'use strict';
  const LEGS = 8;
  const JOINT = '#5dffb0', SILK = '#ff3d8b';

  function footTargets(x, y, heading, reach) {
    const out = [];
    for (let i = 0; i < LEGS; i++) {
      const side = i < LEGS / 2 ? -1 : 1, k = i % (LEGS / 2);
      const a = heading + side * (0.45 + k * 0.62);
      const r = reach * (k === 0 || k === 3 ? 1.08 : 0.92);
      out.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
    }
    return out;
  }

  function create({ scale = 0.6, tone = '#5cc3ff' } = {}) {
    const REACH = 84 * scale, STEP = 50 * scale, STEP_MS = 120;
    let feet = [], heading = -Math.PI / 2, last = null, trail = [], bursts = [];

    function line(ctx, pts, color, width, blur) {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.shadowColor = color; ctx.shadowBlur = blur;
      ctx.beginPath(); pts.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.stroke();
    }
    function dot(ctx, x, y, r, color, blur = 8) {
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = blur;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    /* body: where the page put the spider. opts.grab: points legs reach for. opts.tendrils: points to wire to. */
    function draw(ctx, body, now, opts = {}) {
      const reduce = !!opts.reduce, moving0 = !!opts.playing && !reduce;
      const color = opts.tone || tone;
      if (last) {
        const dx = body.x - last.x, dy = body.y - last.y;
        if (Math.hypot(dx, dy) > 0.6) {
          const want = Math.atan2(dy, dx);
          heading += Math.atan2(Math.sin(want - heading), Math.cos(want - heading)) * (reduce ? 1 : 0.25);
        }
      }
      const moving = !!last && Math.hypot(body.x - last.x, body.y - last.y) > 0.6;
      last = { x: body.x, y: body.y };
      if (!reduce) { trail.push({ x: body.x, y: body.y, t: now }); trail = trail.filter(p => now - p.t < 600); }
      bursts = bursts.filter(b => now - b.start < 700);

      const targets = footTargets(body.x, body.y, heading, REACH);
      const grab = opts.grab || [];
      if (!feet.length || reduce) feet = targets.map(p => ({ ...p, from: p, to: p, start: -1 }));
      const stepping = feet.filter(f => f.start >= 0).length;
      feet.forEach((f, i) => {
        const want = grab[i] || targets[i];
        if (f.start >= 0) {
          const k = Math.min(1, (now - f.start) / STEP_MS);
          f.x = f.from.x + (f.to.x - f.from.x) * k; f.y = f.from.y + (f.to.y - f.from.y) * k;
          if (k >= 1) f.start = -1;
          return;
        }
        const gap = Math.hypot(f.x - want.x, f.y - want.y);
        if (grab[i] ? gap > 2 : (gap > STEP * 2.2 || (gap > STEP && stepping < 4 && (i + Math.floor(now / STEP_MS)) % 2 === 0))) {
          const lead = grab[i] || (moving ? { x: want.x + Math.cos(heading) * STEP * 0.6, y: want.y + Math.sin(heading) * STEP * 0.6 } : want);
          Object.assign(f, { from: { x: f.x, y: f.y }, to: lead, start: now });
        }
      });

      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i < trail.length; i++) {
        const a = 1 - (now - trail[i].t) / 600;
        ctx.globalAlpha = a * 0.6; line(ctx, [trail[i - 1], trail[i]], SILK, 1.6 * a + 0.4, 8);
      }
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      for (const p of (opts.tendrils || []).slice(-6)) {
        const d = Math.hypot(p.x - body.x, p.y - body.y); if (d < 8) continue;
        ctx.globalAlpha = 0.25 + 0.3 * pulse; line(ctx, [body, p], color, 0.9, 6); dot(ctx, p.x, p.y, 2.2, JOINT, 8);
      }
      ctx.globalAlpha = 0.3;
      feet.forEach((f, i) => line(ctx, [f, feet[(i + 2) % LEGS]], color, 0.8, 4));
      ctx.globalAlpha = 1;
      feet.forEach((f, i) => {
        const side = i < LEGS / 2 ? -1 : 1;
        const hip = { x: body.x + Math.cos(heading + side * 1.2) * 6 * scale, y: body.y + Math.sin(heading + side * 1.2) * 6 * scale };
        const mx = (hip.x + f.x) / 2, my = (hip.y + f.y) / 2, len = Math.hypot(f.x - hip.x, f.y - hip.y) || 1;
        const bend = (24 + (f.start >= 0 ? 14 : 0)) * scale;
        const knee = { x: mx - (f.y - hip.y) / len * side * bend, y: my + (f.x - hip.x) / len * side * bend };
        line(ctx, [hip, knee, f], grab[i] ? SILK : i % 2 ? SILK : color, 1.9 * Math.max(0.8, scale), 10);
        dot(ctx, knee.x, knee.y, 2.4 * Math.max(0.8, scale), JOINT, 8);
        dot(ctx, f.x, f.y, (f.start >= 0 ? 2 : 3) * Math.max(0.8, scale), JOINT, 10);
      });
      for (const b of bursts) {
        // RAF timestamps precede the work in that frame. A land() triggered
        // during rendering uses performance.now() and can be slightly newer;
        // clamp the animation age before computing radii and opacity.
        const k = Math.max(0, Math.min(1, (now - b.start) / 700)), e = 1 - Math.pow(1 - k, 3);
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = b.color; ctx.lineWidth = 1.8; ctx.shadowColor = b.color; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.arc(b.x, b.y, 4 + e * 34 * scale * 1.4, 0, Math.PI * 2); ctx.stroke();
        for (let s = 0; s < 8; s++) {
          const a = s * Math.PI / 4 + 0.3, r0 = 8 + e * 18, r1 = r0 + 10 * (1 - k);
          line(ctx, [{ x: b.x + Math.cos(a) * r0, y: b.y + Math.sin(a) * r0 }, { x: b.x + Math.cos(a) * r1, y: b.y + Math.sin(a) * r1 }], b.color, 1.6, 8);
        }
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.translate(body.x, body.y); ctx.rotate(heading);
      ctx.shadowColor = color; ctx.shadowBlur = moving || moving0 ? 22 : 12;
      ctx.fillStyle = '#0d0b18'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; ctx[k ? 'lineTo' : 'moveTo'](Math.cos(a) * 14 * scale, Math.sin(a) * 10 * scale); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(-9 * scale, 0); ctx.lineTo(7 * scale, 0); ctx.moveTo(-3 * scale, -5 * scale); ctx.lineTo(-3 * scale, 5 * scale); ctx.stroke();
      dot(ctx, 12 * scale, 0, 4.6 * scale + (moving0 ? 0 : pulse * 0.8), opts.headTone || SILK, 20);
      ctx.restore();
      return bursts.length > 0 || trail.length > 1 || feet.some(f => f.start >= 0);
    }
    return {
      draw,
      land(x, y, color) { bursts.push({ x, y, color: color || SILK, start: performance.now() }); },
      reset() { feet = []; last = null; trail = []; bursts = []; },
    };
  }

  window.OopsSpider = Object.freeze({ create, footTargets });
})();
