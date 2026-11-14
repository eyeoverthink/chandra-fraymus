/**
 * Shape morphs for the flat look — one prop's outline flowing into the next prop's at a cut (a cell becomes a planet),
 * the transition Kurzgesagt is known for. Pure: outlines in, SVG out.
 *
 * From Vaughn's Nexus Engine KurzgesagtStudio (docs/NEXUS-ENGINE-CREATION-METHODS.md, method 13), which resampled
 * every shape to the same number of points by arc length and interpolated point i to point i. That twists or
 * crosses itself when the two outlines start at different places or run in opposite directions, so here the second
 * outline is first turned to the first one's direction and rotated to the starting point that makes the two
 * closest (least squares over every shift), then interpolated with easing.
 *
 * Also from Nexus: `enforceContrast` — WCAG contrast between a shape's colour and what is behind it, lightened or
 * darkened in small steps until it reads (3:1, the WCAG minimum for graphics).
 */
import { smoothPath } from '../looks/vector.js';

export const MORPH_SECONDS = 0.6;
export const MORPH_POINTS = 96;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export const easeInOut = x => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };

export const signedArea = loop => { let a = 0; for (let i = 0; i < loop.length; i++) { const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length]; a += x1 * y2 - x2 * y1; } return a / 2; };
export const centroid = loop => { let x = 0, y = 0; for (const p of loop) { x += p[0]; y += p[1]; } return [x / loop.length, y / loop.length]; };

/** `n` points evenly spaced along a closed outline (by arc length). */
export function resampleClosed(loop, n = MORPH_POINTS) {
  if (!loop.length) return [];
  const seg = [], m = loop.length;
  let total = 0;
  for (let i = 0; i < m; i++) { const a = loop[i], b = loop[(i + 1) % m], d = Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push(d); total += d; }
  if (!total) return Array.from({ length: n }, () => [...loop[0]]);
  const out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (i < m - 1 && acc + seg[i] < target) { acc += seg[i]; i++; }
    const a = loop[i], b = loop[(i + 1) % m], t = seg[i] ? (target - acc) / seg[i] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/**
 * Line `b` up with `a` (both resampled to the same length): same direction, and the starting point that minimises
 * the summed squared distance between point i of `a` and point i of `b`, with both centred. Returns the new `b`
 * and the cost before and after, so a test can see the alignment did something.
 */
export function alignLoops(a, b) {
  const n = a.length;
  if (b.length !== n) throw new Error(`outlines must have the same number of points (${n} and ${b.length})`);
  let bb = Math.sign(signedArea(a)) !== Math.sign(signedArea(b)) ? [...b].reverse() : b;
  const [ax, ay] = centroid(a), [bx, by] = centroid(bb);
  const cost = s => { let c = 0; for (let i = 0; i < n; i++) { const p = a[i], q = bb[(i + s) % n]; c += (p[0] - ax - (q[0] - bx)) ** 2 + (p[1] - ay - (q[1] - by)) ** 2; } return c; };
  let best = 0, bestCost = Infinity;
  for (let s = 0; s < n; s++) { const c = cost(s); if (c < bestCost) { bestCost = c; best = s; } }
  const naive = (() => { let c = 0; const [cx, cy] = centroid(b); for (let i = 0; i < n; i++) c += (a[i][0] - ax - (b[i][0] - cx)) ** 2 + (a[i][1] - ay - (b[i][1] - cy)) ** 2; return c; })();
  return { b: Array.from({ length: n }, (_, i) => bb[(i + best) % n]), shift: best, reversed: bb !== b, cost: bestCost, naiveCost: naive };
}

// ── colour ─────────────────────────────────────────────────────────────────────────────────────────────
export const hexToRgb = h => { const s = String(h).replace('#', ''); const n = parseInt(s.length === 3 ? s.split('').map(c => c + c).join('') : s, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgbToHex = rgb => `#${rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
export const lerpHex = (a, b, t) => { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.map((v, i) => v + (y[i] - v) * t)); };
/** WCAG relative luminance. */
export function relativeLuminance(hex) {
  return hexToRgb(hex).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrastRatio(a, b) { const x = relativeLuminance(a), y = relativeLuminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
/** Lighten (on a dark background) or darken (on a light one) in 12 steps until the ratio reaches `min`. */
export function enforceContrast(fg, bg, min = 3) {
  let c = fg;
  const dark = relativeLuminance(bg) < 0.35;
  for (let i = 0; i < 12 && contrastRatio(c, bg) < min; i++) c = lerpHex(c, dark ? '#ffffff' : '#000000', 0.16);
  return c;
}

/**
 * One frame of a morph: outline `from` (prop units, placed at from.x/y × from.scale) flowing into `to`, at progress
 * p (0..1, eased). Colour runs from one prop's main colour to the other's and is kept readable on `bg`.
 * `from.loop` and `to.loop` must already be resampled and aligned.
 */
export function morphSvg({ from, to, p, bg = '#4cc9f0' }) {
  const e = easeInOut(p), n = from.loop.length;
  const pts = new Array(n);
  // a slight swell in the middle of the move, so the shape feels like it travels rather than slides
  const swell = 1 + 0.08 * Math.sin(Math.PI * e);
  const cx = from.x + (to.x - from.x) * e, cy = from.y + (to.y - from.y) * e;
  for (let i = 0; i < n; i++) {
    const ax = from.x + from.loop[i][0] * from.scale, ay = from.y + from.loop[i][1] * from.scale;
    const bx = to.x + to.loop[i][0] * to.scale, by = to.y + to.loop[i][1] * to.scale;
    const x = ax + (bx - ax) * e, y = ay + (by - ay) * e;
    pts[i] = [cx + (x - cx) * swell, cy + (y - cy) * swell];
  }
  const fill = enforceContrast(lerpHex(from.colour, to.colour, e), bg, 3);
  return `<path d="${smoothPath(pts, 1, true)}" fill="${fill}"/>`;
}
