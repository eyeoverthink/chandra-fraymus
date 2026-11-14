/**
 * Vector rotoscope, pure (no model, no I/O): a picture becomes an SVG — ink lines traced from its edges and,
 * for the filled styles, flat colour regions traced from a posterised copy.
 *
 * From Vaughn's Nexus Engine RotoscopeStudio (docs/NEXUS-ENGINE-CREATION-METHODS.md, method 14), which thresholded a
 * luma gradient at 160×90, followed 8-direction chains and dropped points closer than 4.5 px. That gives thick,
 * doubled lines (a gradient threshold marks both sides of every edge). Here:
 *   ink    — Canny: Gaussian blur, Sobel, non-maximum suppression (one-pixel edges), hysteresis (weak edges kept
 *            only where they touch strong ones), chain tracing from endpoints, Ramer–Douglas–Peucker, smoothed into
 *            quadratic curves; a line's width follows how strong its edge was
 *   fills  — k-means palette, a majority filter and small-region merging (no speckle), then each colour's outline
 *            by marching squares, simplified; drawn largest first so no gap shows between regions
 * Images are filters.js images: { w, h, d: Uint8ClampedArray RGB }.
 */
import { image, luminance, blurPlane, kmeansPalette } from './filters.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hex = ([r, g, b]) => `#${[r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
const r1 = v => Math.round(v * 10) / 10;

/** Box resample (shrinking averages, so edges are found on smoothed colour). */
export function resize(img, w, h) {
  if (img.w === w && img.h === h) return img;
  const out = image(w, h), sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < Math.min(y1, img.h); yy++) for (let xx = x0; xx < Math.min(x1, img.w); xx++) { const k = (yy * img.w + xx) * 3; r += img.d[k]; g += img.d[k + 1]; b += img.d[k + 2]; n++; }
    const o = (y * w + x) * 3; out.d[o] = r / n; out.d[o + 1] = g / n; out.d[o + 2] = b / n;
  }
  return out;
}

/**
 * Canny edges. `low` / `high` are fractions of the strongest gradient in the picture, so the same settings work on
 * a dark and a bright picture. Returns { edges: Uint8Array (1 = edge), mag: Float32Array (gradient strength) }.
 */
export function canny(img, { blur = 2, low = 0.08, high = 0.2 } = {}) {
  const { w, h } = img;
  let L = luminance(img);
  for (let i = 0; i < 2; i++) L = blurPlane(L, w, h, blur);           // two box passes ≈ a Gaussian
  const mag = new Float32Array(w * h), dir = new Uint8Array(w * h);
  let max = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1] + L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
    const gy = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1] + L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
    const m = Math.hypot(gx, gy);
    mag[i] = m; if (m > max) max = m;
    const a = (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180;      // gradient direction, 4 bins
    dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
  }
  // non-maximum suppression: keep a pixel only if it is the peak across the edge
  const thin = new Float32Array(w * h);
  const off = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, [dx, dy] = off[dir[i]];
    if (mag[i] >= mag[i + dy * w + dx] && mag[i] >= mag[i - dy * w - dx]) thin[i] = mag[i];
  }
  // hysteresis: strong edges, and weak edges connected to them
  const hi = high * max, lo = low * max, edges = new Uint8Array(w * h), stack = [];
  for (let i = 0; i < thin.length; i++) if (thin[i] >= hi) { edges[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!edges[j] && thin[j] >= lo) { edges[j] = 1; stack.push(j); }
    }
  }
  return { edges, mag, max };
}

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * Edge pixels into polylines: start from endpoints (one neighbour) so a line is traced end to end, then pick up
 * closed loops; at a junction keep going in the direction closest to the current heading. Chains shorter than
 * `minLength` pixels are dropped (texture noise).
 */
export function traceEdges(edges, w, h, { minLength = 8 } = {}) {
  const seen = new Uint8Array(w * h), lines = [];
  const nb = i => { const x = i % w, y = (i - x) / w, out = []; for (const [dx, dy] of N8) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && edges[yy * w + xx]) out.push(yy * w + xx); } return out; };
  const follow = start => {
    const pts = [start]; seen[start] = 1;
    let cur = start, hx = 0, hy = 0;
    for (;;) {
      const cx = cur % w, cy = (cur - cx) / w;
      let best = -1, bestScore = -Infinity;
      for (const j of nb(cur)) {
        if (seen[j]) continue;
        const jx = j % w, jy = (j - jx) / w, dx = jx - cx, dy = jy - cy;
        const score = (hx || hy) ? (dx * hx + dy * hy) / Math.hypot(dx, dy) : 0;
        if (score > bestScore) { bestScore = score; best = j; }
      }
      if (best < 0) break;
      const bx = best % w, by = (best - bx) / w;
      hx = bx - cx; hy = by - cy;
      seen[best] = 1; pts.push(best); cur = best;
    }
    return pts;
  };
  const order = [];
  for (let i = 0; i < edges.length; i++) if (edges[i] && nb(i).length === 1) order.push(i);   // endpoints first
  for (let i = 0; i < edges.length; i++) if (edges[i]) order.push(i);                          // then everything else (loops)
  for (const i of order) {
    if (seen[i]) continue;
    const chain = follow(i);
    if (chain.length >= minLength) lines.push(chain.map(k => [k % w, (k - (k % w)) / w]));
  }
  return lines;
}

/** Ramer–Douglas–Peucker: drop points within `eps` of the line through their neighbours. */
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1, fd = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** A polyline as a smooth SVG path: quadratic curves through the midpoints, scaled by `s`. Closed when `close`. */
export function smoothPath(pts, s = 1, close = false) {
  if (pts.length < 2) return '';
  const P = pts.map(([x, y]) => [x * s, y * s]);
  if (P.length === 2) return `M${r1(P[0][0])} ${r1(P[0][1])}L${r1(P[1][0])} ${r1(P[1][1])}`;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (close) {
    const m0 = mid(P[P.length - 1], P[0]);
    let d = `M${r1(m0[0])} ${r1(m0[1])}`;
    for (let i = 0; i < P.length; i++) { const m = mid(P[i], P[(i + 1) % P.length]); d += `Q${r1(P[i][0])} ${r1(P[i][1])} ${r1(m[0])} ${r1(m[1])}`; }
    return d + 'Z';
  }
  let d = `M${r1(P[0][0])} ${r1(P[0][1])}`;
  for (let i = 1; i < P.length - 1; i++) { const m = mid(P[i], P[i + 1]); d += `Q${r1(P[i][0])} ${r1(P[i][1])} ${r1(m[0])} ${r1(m[1])}`; }
  const l = P[P.length - 1];
  return d + `L${r1(l[0])} ${r1(l[1])}`;
}

/** Each pixel's palette index, then a 3×3 majority filter `passes` times (single pixels and thin speckle go). */
export function labelMap(img, palette, passes = 2) {
  const { w, h, d } = img;
  let lab = new Uint8Array(w * h);
  for (let i = 0; i < lab.length; i++) {
    let bi = 0, bd = Infinity;
    for (let j = 0; j < palette.length; j++) { const c = palette[j], dd = (d[i * 3] - c[0]) ** 2 * 0.3 + (d[i * 3 + 1] - c[1]) ** 2 * 0.59 + (d[i * 3 + 2] - c[2]) ** 2 * 0.11; if (dd < bd) { bd = dd; bi = j; } }
    lab[i] = bi;
  }
  const counts = new Uint16Array(palette.length);
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(lab);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      counts.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) counts[lab[(y + dy) * w + x + dx]]++;
      let best = lab[y * w + x];
      for (let j = 0; j < counts.length; j++) if (counts[j] > counts[best]) best = j;
      out[y * w + x] = best;
    }
    lab = out;
  }
  return lab;
}

/** Merge regions smaller than `minArea` pixels into the label that surrounds them most. */
export function mergeSmall(lab, w, h, minArea) {
  const reg = new Int32Array(w * h).fill(-1), regs = [];
  for (let i = 0; i < lab.length; i++) {
    if (reg[i] >= 0) continue;
    const id = regs.length, stack = [i], px = []; reg[i] = id;
    while (stack.length) {
      const k = stack.pop(), x = k % w; px.push(k);
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) if (j >= 0 && j < lab.length && reg[j] < 0 && lab[j] === lab[i]) { reg[j] = id; stack.push(j); }
    }
    regs.push(px);
  }
  const out = new Uint8Array(lab);
  for (const px of regs) {
    if (px.length >= minArea) continue;
    const votes = new Map();
    for (const k of px) { const x = k % w; for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) if (j >= 0 && j < lab.length && lab[j] !== lab[k]) votes.set(out[j], (votes.get(out[j]) || 0) + 1); }
    let best = null, bv = 0;
    for (const [l, v] of votes) if (v > bv) { bv = v; best = l; }
    if (best !== null) for (const k of px) out[k] = best;
  }
  return out;
}

/**
 * Closed outlines of a binary mask by marching squares on the pixel corners (the mask is padded with 0 so every
 * outline closes). Returns loops of [x, y] points in pixel units (corners at integer coordinates).
 */
export function contours(mask, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const segs = new Map();                    // "x,y" of a start point (doubled coordinates) → list of end points
  const add = (ax, ay, bx, by) => { const k = `${ax},${ay}`; (segs.get(k) || segs.set(k, []).get(k)).push([bx, by]); };
  // cell (x, y) spans pixel corners; pixel centres sit at (x + 0.5); we work in doubled coordinates to stay integral
  for (let y = -1; y < h; y++) for (let x = -1; x < w; x++) {
    const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
    const c = (tl << 3) | (tr << 2) | (br << 1) | bl;
    if (c === 0 || c === 15) continue;
    // edge midpoints between the four pixel centres, doubled: top, right, bottom, left
    const T = [2 * x + 2, 2 * y + 1], R = [2 * x + 3, 2 * y + 2], B = [2 * x + 2, 2 * y + 3], Lf = [2 * x + 1, 2 * y + 2];
    // oriented so the inside (1) is on the left; saddles (5, 10) are split
    const table = { 1: [[Lf, B]], 2: [[B, R]], 3: [[Lf, R]], 4: [[R, T]], 5: [[Lf, T], [R, B]], 6: [[B, T]], 7: [[Lf, T]],
      8: [[T, Lf]], 9: [[T, B]], 10: [[T, R], [B, Lf]], 11: [[T, R]], 12: [[R, Lf]], 13: [[R, B]], 14: [[B, Lf]] };
    for (const [a, b] of table[c]) add(a[0], a[1], b[0], b[1]);
  }
  const loops = [];
  for (const [startKey] of segs) {
    while ((segs.get(startKey) || []).length) {
      const [sx, sy] = startKey.split(',').map(Number), loop = [[sx / 2, sy / 2]];
      let key = startKey, guard = 0;
      for (;;) {
        const list = segs.get(key);
        if (!list || !list.length) break;
        const [nx, ny] = list.pop();
        key = `${nx},${ny}`;
        if (key === startKey || ++guard > 1e6) break;
        loop.push([nx / 2, ny / 2]);
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

const area = loop => { let a = 0; for (let i = 0; i < loop.length; i++) { const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length]; a += x1 * y2 - x2 * y1; } return a / 2; };

/** The vector styles: what is drawn and how. */
export const VECTOR_STYLES = {
  ink:     { label: 'Ink line drawing', fills: 0, paper: '#f3eee2', ink: '#1c1a18', width: 1.6, about: 'traced ink lines on paper, no fills' },
  cutout:  { label: 'Rotoscope cutout', fills: 6, paper: null, ink: '#16130f', width: 1.1, mute: 0.18, about: 'flat muted colour shapes with thin outlines (Waltz-with-Bashir-like rotoscope)' },
  comic:   { label: 'Comic ink and flats', fills: 5, paper: null, ink: '#000000', width: 2.4, mute: -0.12, about: 'saturated flat colours under heavy black ink' },
  neon:    { label: 'Neon wireframe', fills: 0, paper: '#05060d', ink: null, width: 1.4, about: 'glowing coloured lines on black, each line in the colour of the picture under it' },
};
export const VECTOR_STYLE_NAMES = Object.keys(VECTOR_STYLES);

const muted = ([r, g, b], m) => { const l = 0.299 * r + 0.587 * g + 0.114 * b; return [r + (l - r) * m, g + (l - g) * m, b + (l - b) * m]; };
const brighten = ([r, g, b]) => { const m = Math.max(r, g, b, 1), k = 235 / m; return [r * k, g * k, b * k].map(v => Math.max(70, v)); };

/**
 * A picture as SVG. Works at `work` px on the long side (the SVG keeps that coordinate system; `viewBox` scales it).
 * `palette` may be passed in so every frame of a clip uses the same colours. Returns { svg, stats, palette, w, h }.
 */
export function vectorize(img, { style = 'cutout', work = 640, palette = null, detail = 1, seed = 7, outW = null, outH = null } = {}) {
  const S = VECTOR_STYLES[style];
  if (!S) throw new Error(`unknown vector style: ${style} (have ${VECTOR_STYLE_NAMES.join(', ')})`);
  const s = Math.min(1, work / Math.max(img.w, img.h));
  const src = s < 1 ? resize(img, Math.max(16, Math.round(img.w * s)), Math.max(16, Math.round(img.h * s))) : img;
  const { w, h } = src, long = Math.max(w, h);
  const parts = [];
  let pal = palette, fillPaths = 0, fillPoints = 0;
  if (S.fills) {
    pal = pal || kmeansPalette(src, S.fills, { seed });
    const lab = mergeSmall(labelMap(src, pal, 2), w, h, Math.round((long * long) / 2500));
    const count = new Array(pal.length).fill(0);
    for (const l of lab) count[l]++;
    const order = pal.map((_, i) => i).sort((a, b) => count[b] - count[a]);
    parts.push(`<rect width="${w}" height="${h}" fill="${hex(muted(pal[order[0]], S.mute || 0))}"/>`);
    for (const li of order.slice(1)) {
      if (!count[li]) continue;
      const mask = Uint8Array.from(lab, v => (v === li ? 1 : 0));
      // points on the frame edge are pushed just outside it, so smoothing cannot round a region off at the corners
      const snap = ([x, y]) => [x <= 1 ? -2 : x >= w - 1 ? w + 2 : x, y <= 1 ? -2 : y >= h - 1 ? h + 2 : y];
      const loops = contours(mask, w, h).filter(l => Math.abs(area(l)) >= 4).map(l => rdp(l.map(snap), 0.9 / detail));
      if (!loops.length) continue;
      const d = loops.filter(l => l.length >= 3).map(l => smoothPath(l, 1, true)).join('');
      fillPaths += loops.length; fillPoints += loops.reduce((n, l) => n + l.length, 0);
      parts.push(`<path d="${d}" fill="${hex(muted(pal[li], S.mute || 0))}" fill-rule="evenodd"/>`);
    }
  } else parts.push(`<rect width="${w}" height="${h}" fill="${S.paper}"/>`);

  const { edges, mag, max } = canny(src, { blur: long > 400 ? 2 : 1, low: 0.07 / detail, high: 0.18 / detail });
  const lines = traceEdges(edges, w, h, { minLength: Math.max(6, Math.round(long / 90)) });
  const base = S.width * (long / 640);
  let linePoints = 0;
  const strokes = [];
  for (const line of lines) {
    let m = 0; for (const [x, y] of line) m += mag[y * w + x];
    const strength = m / line.length / (max || 1);                 // 0..1: how strong this edge is
    const pts = rdp(line, 0.8 / detail), d = smoothPath(pts);
    if (!d) continue;
    linePoints += pts.length;
    const width = r1(base * (0.55 + 1.1 * Math.min(1, strength * 2.2)));
    if (style === 'neon') {
      const [x, y] = line[line.length >> 1], c = hex(brighten([src.d[(y * w + x) * 3], src.d[(y * w + x) * 3 + 1], src.d[(y * w + x) * 3 + 2]]));
      strokes.push(`<path d="${d}" stroke="${c}" stroke-opacity="0.28" stroke-width="${r1(width * 4)}"/><path d="${d}" stroke="${c}" stroke-width="${width}"/>`);
    } else strokes.push(`<path d="${d}" stroke-width="${width}"/>`);
  }
  const strokeGroup = style === 'neon' ? `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${strokes.join('')}</g>`
    : `<g fill="none" stroke="${S.ink}" stroke-linecap="round" stroke-linejoin="round">${strokes.join('')}</g>`;
  // width/height = the size it is drawn at (a renderer rasterises at this size, so frames stay sharp); viewBox = the working grid
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${outW || w}" height="${outH || h}">${parts.join('')}${strokeGroup}</svg>`;
  return { svg, w, h, palette: pal, stats: { lines: strokes.length, linePoints, fillPaths, fillPoints, bytes: svg.length, style } };
}

/**
 * How well a drawing keeps its picture: `edgeRecall` = share of the picture's strong edges (top fifth of gradient)
 * that have a drawn edge within 2 px in the rendering; `colourError` = mean colour difference on 48-px copies (only
 * meaningful for the filled styles). Both images must be the same size.
 */
export function vectorFidelity(source, rendered) {
  const a = canny(source, { blur: 1, low: 0.12, high: 0.3 }).edges;
  const L = luminance(rendered), { w, h } = rendered, E = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; E[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]); }
  let strong = 0, hit = 0;
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    if (!a[y * w + x]) continue;
    strong++;
    let found = false;
    for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2; dx++) if (E[(y + dy) * w + x + dx] > 40) { found = true; break; }
    if (found) hit++;
  }
  const sa = resize(source, 48, Math.max(1, Math.round(48 * h / w))), sb = resize(rendered, sa.w, sa.h);
  let diff = 0;
  for (let i = 0; i < sa.d.length; i++) diff += Math.abs(sa.d[i] - sb.d[i]);
  return { edgeRecall: +(strong ? hit / strong : 1).toFixed(3), colourError: +(diff / sa.d.length).toFixed(1), strongEdges: strong };
}
