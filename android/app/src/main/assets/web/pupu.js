/* Pupu (噗噗), the Oops mascot, as inline SVG. The outline, eyes and the three "oops" lines are traced from
   brand/mascot.png: a rounded triangle leaning to the upper right, never a circle. Inline (not <img>) so the
   page's CSS can start and stop its motion; see oops-design.css (.pupu). No dependencies. */
(() => {
  'use strict';
  const BODY = 'M57.9 30.6C52.9 30.8 47.8 32.9 43.1 34.9C38.4 36.9 33.9 39.6 29.8 42.7C25.7 45.8 21.6 49.3 18.8 53.5C16 57.7 13.4 62.9 13.1 67.7C12.8 72.5 14.5 78.2 17 82.4C19.5 86.6 23.8 90.3 28 93.1C32.2 95.8 37.3 97.6 42.3 99C47.2 100.3 52.4 101.1 57.5 101.3C62.7 101.6 67.9 101.6 72.9 100.7C77.9 99.7 83.3 98.3 87.5 95.6C91.7 93 96.3 89.2 98.3 84.9C100.4 80.6 100.6 74.7 99.8 69.8C99.1 64.9 96.3 60.1 93.8 55.6C91.4 51.1 88.4 46.7 84.9 42.9C81.5 39.2 77.5 35.3 73 33.3C68.5 31.2 62.9 30.3 57.9 30.6Z';
  const EYES = [[57, 69.9], [78.8, 63.8]];
  const EYE_TILT = -14.6;
  // [outer x, outer y, outer r, inner x, inner y, inner r]: tapered strokes, heavier at the tip.
  const LINES = [[96.2, 23.5, 4.1, 90.4, 37.1, 3], [112.3, 36.5, 4.1, 99.3, 45.7, 3], [112.8, 56.8, 3.3, 103.4, 56.5, 2.7]];
  const MOODS = ['surprised', 'happy', 'oops', 'sleepy', 'thinking', 'cheer', 'listening'];
  const INK = '#121130', LILAC = '#966cf2', PERI = '#919ef6';
  let seq = 0;

  const r2 = (n) => Math.round(n * 100) / 100;
  function capsule(ax, ay, ra, bx, by, rb) {
    const dx = bx - ax, dy = by - ay, L = Math.sqrt(dx * dx + dy * dy), nx = -dy / L, ny = dx / L;
    return `M${r2(ax + nx * ra)} ${r2(ay + ny * ra)}L${r2(bx + nx * rb)} ${r2(by + ny * rb)}A${rb} ${rb} 0 0 0 ${r2(bx - nx * rb)} ${r2(by - ny * rb)}` +
      `L${r2(ax - nx * ra)} ${r2(ay - ny * ra)}A${ra} ${ra} 0 0 0 ${r2(ax + nx * ra)} ${r2(ay + ny * ra)}Z`;
  }
  function star(x, y, r) {
    const k = r * 0.2;
    return `M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`;
  }
  const eyeRect = (cx, cy, w, h) =>
    `<rect x="${r2(cx - w / 2)}" y="${r2(cy - h / 2)}" width="${w}" height="${h}" rx="${r2(w / 2)}" transform="rotate(${EYE_TILT} ${cx} ${cy})" fill="${INK}"/>`;
  const eyeGlyph = (cx, cy, d) =>
    `<path d="${d}" transform="translate(${cx} ${cy}) rotate(${EYE_TILT})" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;

  /** SVG markup for a mood. Decorative unless `label` is given. */
  function svg(mood, opts = {}) {
    if (!MOODS.includes(mood)) mood = 'surprised';
    const uid = `pupu${++seq}`;
    const tilt = { surprised: 0, happy: 2, oops: -5, sleepy: 3, thinking: -2, cheer: 0, listening: 0 }[mood];
    const squash = mood === 'oops' ? ' translate(58 101) scale(1.05 .93) translate(-58 -101)'
      : mood === 'cheer' ? ' translate(58 101) scale(.95 1.06) translate(-58 -101)' : '';
    const lift = mood === 'cheer' ? 'translate(0 -6) ' : '';
    const a11y = opts.label ? `role="img" aria-label="${String(opts.label).replace(/"/g, '&quot;')}"` : 'aria-hidden="true"';
    let s = `<svg class="pupu pupu-${mood}${opts.still ? ' is-still' : ''}" viewBox="0 0 120 120" ${a11y} focusable="false">` +
      '<defs>' +
      `<clipPath id="${uid}c"><path d="${BODY}"/></clipPath>` +
      `<linearGradient id="${uid}b" x1="20" y1="98" x2="88" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3f6cf3"/><stop offset=".34" stop-color="#7d93f5"/><stop offset=".6" stop-color="#cdc9f8"/><stop offset=".84" stop-color="#ead7fa"/><stop offset="1" stop-color="#f7e3fc"/></linearGradient>` +
      `<radialGradient id="${uid}g" cx="74" cy="69" r="27" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".98"/><stop offset=".55" stop-color="#fbfaff" stop-opacity=".7"/><stop offset="1" stop-color="#fbfaff" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="${uid}d" cx="34" cy="100" r="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3567f2" stop-opacity=".75"/><stop offset="1" stop-color="#3567f2" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="${uid}v" cx="98" cy="94" r="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7c6cf1" stop-opacity=".7"/><stop offset="1" stop-color="#7c6cf1" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="${uid}r" cx="9" cy="70" r="12" gradientUnits="userSpaceOnUse" gradientTransform="translate(9 70) scale(.55 1.6) translate(-9 -70)"><stop offset="0" stop-color="#b4d0fb" stop-opacity=".9"/><stop offset="1" stop-color="#b4d0fb" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="${uid}h" cx="86" cy="46" r="8" gradientUnits="userSpaceOnUse" gradientTransform="translate(86 46) rotate(52) scale(1 .38) translate(-86 -46)"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
      LINES.map((l, i) => `<linearGradient id="${uid}l${i}" x1="${l[0]}" y1="${l[1]}" x2="${l[3]}" y2="${l[4]}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7a6ef0"/><stop offset="1" stop-color="#bf93f3"/></linearGradient>`).join('') +
      '</defs>';
    s += `<ellipse class="pupu-shadow" cx="58" cy="106.5" rx="${mood === 'cheer' ? 26 : 34}" ry="3.6" fill="#5b4fe0" fill-opacity=".16"/>`;
    s += `<g transform="${lift}rotate(${tilt} 58 70)${squash}"><g class="pupu-body">`;
    s += `<path d="${BODY}" fill="url(#${uid}b)"/><g clip-path="url(#${uid}c)">` +
      `<rect x="0" y="20" width="120" height="90" fill="url(#${uid}d)"/><rect x="0" y="20" width="120" height="90" fill="url(#${uid}v)"/>` +
      `<rect x="0" y="20" width="120" height="90" fill="url(#${uid}g)"/><rect x="0" y="20" width="40" height="90" fill="url(#${uid}r)"/>` +
      `<rect x="70" y="30" width="30" height="30" fill="url(#${uid}h)"/></g>`;
    const [e1, e2] = EYES;
    if (mood === 'thinking') s += eyeRect(e1[0] + 2.2, e1[1] - 2.8, 7.2, 13.8) + eyeRect(e2[0] + 2.2, e2[1] - 2.8, 7.2, 13.8);
    else if (mood === 'happy' || mood === 'cheer') s += eyeGlyph(e1[0], e1[1], 'M-5 2.5q5-7 10 0') + eyeGlyph(e2[0], e2[1], 'M-5 2.5q5-7 10 0');
    else if (mood === 'sleepy') s += eyeGlyph(e1[0], e1[1], 'M-5 -1q5 5 10 0') + eyeGlyph(e2[0], e2[1], 'M-5 -1q5 5 10 0');
    else if (mood === 'oops') s += eyeGlyph(e1[0], e1[1], 'M-3.5 -5l7 5-7 5') + eyeGlyph(e2[0], e2[1], 'M3.5 -5l-7 5 7 5');
    else s += eyeRect(e1[0], e1[1], 7.7, 15.3) + eyeRect(e2[0], e2[1], 7.7, 15.3);
    s += '</g></g>';
    if (mood === 'surprised' || mood === 'oops') {
      s += `<g class="pupu-lines">${LINES.map((l, i) => `<path d="${capsule(...l)}" fill="url(#${uid}l${i})"/>`).join('')}</g>` +
        `<g class="pupu-wobble" fill="none" stroke="${PERI}" stroke-linecap="round"><path d="M6.6 70.9Q2.8 77.9 6.3 84.8" stroke-width="3.1"/><path d="M10.2 80.1Q9.6 86.6 14.7 89.8" stroke-width="2.6"/></g>`;
    }
    if (mood === 'sleepy') s += `<g class="pupu-z" fill="none" stroke="${LILAC}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M92 30h8l-8 9h8"/><path d="M104 18h6l-6 7h6"/></g>`;
    if (mood === 'thinking') s += `<g class="pupu-dots" fill="${LILAC}"><circle cx="97" cy="36" r="3"/><circle cx="105" cy="27" r="4"/><circle cx="113" cy="17" r="5"/></g>`;
    if (mood === 'cheer') s += `<g class="pupu-sparks"><path d="${star(102, 30, 8)}" fill="${LILAC}"/><path d="${star(17, 40, 5.5)}" fill="#446df4"/><path d="${star(111, 62, 4.5)}" fill="#b9a6ff"/></g>`;
    if (mood === 'listening') s += `<g class="pupu-sound" fill="none" stroke="${LILAC}" stroke-width="3.4" stroke-linecap="round"><path d="M8 60q-5 9 0 18"/><path d="M2 54q-7 15 0 30"/><path d="M106 58q5 9 0 18"/><path d="M112 52q7 15 0 30"/></g>`;
    return s + '</svg>';
  }

  window.OopsPupu = { svg, moods: MOODS.slice() };
})();
