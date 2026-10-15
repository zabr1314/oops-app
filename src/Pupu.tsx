import { useId } from 'react';

/* Pupu (噗噗), the Oops mascot, as inline SVG — the same drawing as the Android H5 (android/.../web/pupu.js).
   The outline, eyes and the three "oops" lines are traced from public/brand/mascot.png: a rounded triangle
   leaning to the upper right, never a circle. Inline so prototype.css can start and stop its motion (.pupu).
   Pupu only appears at emotional moments (empty, not found, waiting, done, listening), at most one per screen. */

export type PupuMood = 'surprised' | 'happy' | 'oops' | 'sleepy' | 'thinking' | 'cheer' | 'listening';

const BODY = 'M57.9 30.6C52.9 30.8 47.8 32.9 43.1 34.9C38.4 36.9 33.9 39.6 29.8 42.7C25.7 45.8 21.6 49.3 18.8 53.5C16 57.7 13.4 62.9 13.1 67.7C12.8 72.5 14.5 78.2 17 82.4C19.5 86.6 23.8 90.3 28 93.1C32.2 95.8 37.3 97.6 42.3 99C47.2 100.3 52.4 101.1 57.5 101.3C62.7 101.6 67.9 101.6 72.9 100.7C77.9 99.7 83.3 98.3 87.5 95.6C91.7 93 96.3 89.2 98.3 84.9C100.4 80.6 100.6 74.7 99.8 69.8C99.1 64.9 96.3 60.1 93.8 55.6C91.4 51.1 88.4 46.7 84.9 42.9C81.5 39.2 77.5 35.3 73 33.3C68.5 31.2 62.9 30.3 57.9 30.6Z';
const EYES: [number, number][] = [[57, 69.9], [78.8, 63.8]];
const EYE_TILT = -14.6;
// [outer x, outer y, outer r, inner x, inner y, inner r]: tapered strokes, heavier at the tip.
const LINES: [number, number, number, number, number, number][] = [[96.2, 23.5, 4.1, 90.4, 37.1, 3], [112.3, 36.5, 4.1, 99.3, 45.7, 3], [112.8, 56.8, 3.3, 103.4, 56.5, 2.7]];
const INK = '#121130', LILAC = '#966cf2', PERI = '#919ef6';
const TILT: Record<PupuMood, number> = { surprised: 0, happy: 2, oops: -5, sleepy: 3, thinking: -2, cheer: 0, listening: 0 };

const r2 = (n: number) => Math.round(n * 100) / 100;
function capsule(ax: number, ay: number, ra: number, bx: number, by: number, rb: number) {
  const dx = bx - ax, dy = by - ay, length = Math.sqrt(dx * dx + dy * dy), nx = -dy / length, ny = dx / length;
  return `M${r2(ax + nx * ra)} ${r2(ay + ny * ra)}L${r2(bx + nx * rb)} ${r2(by + ny * rb)}A${rb} ${rb} 0 0 0 ${r2(bx - nx * rb)} ${r2(by - ny * rb)}`
    + `L${r2(ax - nx * ra)} ${r2(ay - ny * ra)}A${ra} ${ra} 0 0 0 ${r2(ax + nx * ra)} ${r2(ay + ny * ra)}Z`;
}
function star(x: number, y: number, r: number) {
  const k = r * 0.2;
  return `M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`;
}
function EyeRect({ cx, cy, w, h }: { cx: number; cy: number; w: number; h: number }) {
  return <rect x={r2(cx - w / 2)} y={r2(cy - h / 2)} width={w} height={h} rx={r2(w / 2)} transform={`rotate(${EYE_TILT} ${cx} ${cy})`} fill={INK} />;
}
function EyeGlyph({ cx, cy, d }: { cx: number; cy: number; d: string }) {
  return <path d={d} transform={`translate(${cx} ${cy}) rotate(${EYE_TILT})`} fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />;
}
function Eyes({ mood }: { mood: PupuMood }) {
  const [[x1, y1], [x2, y2]] = EYES;
  if (mood === 'thinking') return <><EyeRect cx={x1 + 2.2} cy={y1 - 2.8} w={7.2} h={13.8} /><EyeRect cx={x2 + 2.2} cy={y2 - 2.8} w={7.2} h={13.8} /></>;
  if (mood === 'happy' || mood === 'cheer') return <><EyeGlyph cx={x1} cy={y1} d="M-5 2.5q5-7 10 0" /><EyeGlyph cx={x2} cy={y2} d="M-5 2.5q5-7 10 0" /></>;
  if (mood === 'sleepy') return <><EyeGlyph cx={x1} cy={y1} d="M-5 -1q5 5 10 0" /><EyeGlyph cx={x2} cy={y2} d="M-5 -1q5 5 10 0" /></>;
  if (mood === 'oops') return <><EyeGlyph cx={x1} cy={y1} d="M-3.5 -5l7 5-7 5" /><EyeGlyph cx={x2} cy={y2} d="M3.5 -5l-7 5 7 5" /></>;
  return <><EyeRect cx={x1} cy={y1} w={7.7} h={15.3} /><EyeRect cx={x2} cy={y2} w={7.7} h={15.3} /></>;
}

/** Decorative unless `label` is given. `still` keeps the pose and stops every motion. */
export function Pupu({ mood = 'surprised', still = false, label, className = '' }: { mood?: PupuMood; still?: boolean; label?: string; className?: string }) {
  const uid = 'pupu' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const squash = mood === 'oops' ? ' translate(58 101) scale(1.05 .93) translate(-58 -101)'
    : mood === 'cheer' ? ' translate(58 101) scale(.95 1.06) translate(-58 -101)' : '';
  const lift = mood === 'cheer' ? 'translate(0 -6) ' : '';
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return <svg className={`pupu pupu-${mood}${still ? ' is-still' : ''}${className ? ' ' + className : ''}`} viewBox="0 0 120 120" focusable="false" {...a11y}>
    <defs>
      <clipPath id={`${uid}c`}><path d={BODY} /></clipPath>
      <linearGradient id={`${uid}b`} x1="20" y1="98" x2="88" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#3f6cf3" /><stop offset=".34" stopColor="#7d93f5" /><stop offset=".6" stopColor="#cdc9f8" /><stop offset=".84" stopColor="#ead7fa" /><stop offset="1" stopColor="#f7e3fc" /></linearGradient>
      <radialGradient id={`${uid}g`} cx="74" cy="69" r="27" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#fff" stopOpacity=".98" /><stop offset=".55" stopColor="#fbfaff" stopOpacity=".7" /><stop offset="1" stopColor="#fbfaff" stopOpacity="0" /></radialGradient>
      <radialGradient id={`${uid}d`} cx="34" cy="100" r="40" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#3567f2" stopOpacity=".75" /><stop offset="1" stopColor="#3567f2" stopOpacity="0" /></radialGradient>
      <radialGradient id={`${uid}v`} cx="98" cy="94" r="30" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#7c6cf1" stopOpacity=".7" /><stop offset="1" stopColor="#7c6cf1" stopOpacity="0" /></radialGradient>
      <radialGradient id={`${uid}r`} cx="9" cy="70" r="12" gradientUnits="userSpaceOnUse" gradientTransform="translate(9 70) scale(.55 1.6) translate(-9 -70)"><stop offset="0" stopColor="#b4d0fb" stopOpacity=".9" /><stop offset="1" stopColor="#b4d0fb" stopOpacity="0" /></radialGradient>
      <radialGradient id={`${uid}h`} cx="86" cy="46" r="8" gradientUnits="userSpaceOnUse" gradientTransform="translate(86 46) rotate(52) scale(1 .38) translate(-86 -46)"><stop offset="0" stopColor="#fff" /><stop offset=".5" stopColor="#fff" stopOpacity=".6" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
      {LINES.map((l, i) => <linearGradient key={i} id={`${uid}l${i}`} x1={l[0]} y1={l[1]} x2={l[3]} y2={l[4]} gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#7a6ef0" /><stop offset="1" stopColor="#bf93f3" /></linearGradient>)}
    </defs>
    <ellipse className="pupu-shadow" cx="58" cy="106.5" rx={mood === 'cheer' ? 26 : 34} ry="3.6" fill="#5b4fe0" fillOpacity=".16" />
    <g transform={`${lift}rotate(${TILT[mood]} 58 70)${squash}`}>
      <g className="pupu-body">
        <path d={BODY} fill={`url(#${uid}b)`} />
        <g clipPath={`url(#${uid}c)`}>
          <rect x="0" y="20" width="120" height="90" fill={`url(#${uid}d)`} /><rect x="0" y="20" width="120" height="90" fill={`url(#${uid}v)`} />
          <rect x="0" y="20" width="120" height="90" fill={`url(#${uid}g)`} /><rect x="0" y="20" width="40" height="90" fill={`url(#${uid}r)`} />
          <rect x="70" y="30" width="30" height="30" fill={`url(#${uid}h)`} />
        </g>
        <Eyes mood={mood} />
      </g>
    </g>
    {(mood === 'surprised' || mood === 'oops') && <>
      <g className="pupu-lines">{LINES.map((l, i) => <path key={i} d={capsule(...l)} fill={`url(#${uid}l${i})`} />)}</g>
      <g className="pupu-wobble" fill="none" stroke={PERI} strokeLinecap="round"><path d="M6.6 70.9Q2.8 77.9 6.3 84.8" strokeWidth={3.1} /><path d="M10.2 80.1Q9.6 86.6 14.7 89.8" strokeWidth={2.6} /></g>
    </>}
    {mood === 'sleepy' && <g className="pupu-z" fill="none" stroke={LILAC} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round"><path d="M92 30h8l-8 9h8" /><path d="M104 18h6l-6 7h6" /></g>}
    {mood === 'thinking' && <g className="pupu-dots" fill={LILAC}><circle cx="97" cy="36" r="3" /><circle cx="105" cy="27" r="4" /><circle cx="113" cy="17" r="5" /></g>}
    {mood === 'cheer' && <g className="pupu-sparks"><path d={star(102, 30, 8)} fill={LILAC} /><path d={star(17, 40, 5.5)} fill="#446df4" /><path d={star(111, 62, 4.5)} fill="#b9a6ff" /></g>}
    {mood === 'listening' && <g className="pupu-sound" fill="none" stroke={LILAC} strokeWidth={3.4} strokeLinecap="round"><path d="M8 60q-5 9 0 18" /><path d="M2 54q-7 15 0 30" /><path d="M106 58q5 9 0 18" /><path d="M112 52q7 15 0 30" /></g>}
  </svg>;
}
