/**
 * Looks as filters: one function per look, from an RGB picture to an RGB picture, pure (no disk, no network,
 * no clock; any randomness comes from a seed). They turn any image or video frame — a user's photo, a film,
 * a generated still — into a graphic technique, offline, with no model.
 *
 * Each look reproduces the *technique* it is named after (halftone and ink over moving shapes, flat woodblock
 * planes, brunaille washes, paper cutouts on threes…), never a studio's characters or artwork.
 *
 * Image: { w, h, d } where d is a Uint8ClampedArray of w*h*3 RGB bytes.
 */

const clampByte = v => (v < 0 ? 0 : v > 255 ? 255 : v);
export const image = (w, h, d = new Uint8ClampedArray(w * h * 3)) => ({ w, h, d });
const copy = img => image(img.w, img.h, new Uint8ClampedArray(img.d));
const hex = s => { const n = parseInt(String(s).replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** Seeded hash noise in 0..1 for a pixel: the same seed always gives the same paper. */
export function noise2(x, y, seed = 1) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise (bilinear between hashed lattice points) — for paper fibre and washes. */
export function smoothNoise(x, y, scale, seed) {
  const gx = x / scale, gy = y / scale, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const a = noise2(x0, y0, seed), b = noise2(x0 + 1, y0, seed), c = noise2(x0, y0 + 1, seed), e = noise2(x0 + 1, y0 + 1, seed);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + e * sx) * sy;
}

/** Luminance 0..255 per pixel. */
export function luminance(img) {
  const { w, h, d } = img, L = new Float32Array(w * h);
  for (let i = 0, p = 0; i < L.length; i++, p += 3) L[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  return L;
}

/** Separable box blur of a float plane, radius r (repeat for a softer, near-Gaussian blur). */
export function blurPlane(src, w, h, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) { tmp[row + x] = acc / n; acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = acc / n; acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}
export function blurImage(img, r, passes = 2) {
  const { w, h, d } = img, out = image(w, h);
  for (let c = 0; c < 3; c++) {
    let plane = new Float32Array(w * h);
    for (let i = 0; i < plane.length; i++) plane[i] = d[i * 3 + c];
    for (let p = 0; p < passes; p++) plane = blurPlane(plane, w, h, r);
    for (let i = 0; i < plane.length; i++) out.d[i * 3 + c] = plane[i];
  }
  return out;
}

/** Edge strength (Sobel magnitude) of a luminance plane. */
export function sobel(L, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1] + L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
    const gy = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1] + L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
    out[i] = Math.sqrt(gx * gx + gy * gy);
  }
  return out;
}
/** A 0/1 ink mask from edges above `threshold`, grown by `thick` pixels. */
export function inkMask(img, { threshold = 90, blur = 1, thick = 1 } = {}) {
  const { w, h } = img;
  const E = sobel(blurPlane(luminance(img), w, h, blur), w, h);
  let m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = E[i] > threshold ? 1 : 0;
  for (let t = 0; t < thick; t++) {
    const g = new Uint8Array(m);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (m[i] || m[i - 1] || m[i + 1] || m[i - w] || m[i + w]) g[i] = 1; }
    m = g;
  }
  return m;
}
function applyInk(img, mask, ink = [18, 16, 22], strength = 1) {
  const d = img.d;
  for (let i = 0; i < mask.length; i++) if (mask[i]) for (let c = 0; c < 3; c++) d[i * 3 + c] = d[i * 3 + c] * (1 - strength) + ink[c] * strength;
  return img;
}

/** Kuwahara: the smoothest of four quadrants wins — flat brush-like areas with crisp edges (painted looks). */
export function kuwahara(img, r = 3) {
  const { w, h, d } = img, out = image(w, h);
  // summed-area tables of each channel and of luminance squared, so every quadrant costs O(1)
  const W = w + 1, sat = [0, 1, 2].map(() => new Float64Array(W * (h + 1))), satL = new Float64Array(W * (h + 1)), satL2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 3, l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2], i = (y + 1) * W + x + 1;
    for (let c = 0; c < 3; c++) sat[c][i] = d[p + c] + sat[c][i - 1] + sat[c][i - W] - sat[c][i - W - 1];
    satL[i] = l + satL[i - 1] + satL[i - W] - satL[i - W - 1];
    satL2[i] = l * l + satL2[i - 1] + satL2[i - W] - satL2[i - W - 1];
  }
  const sum = (t, x0, y0, x1, y1) => t[(y1 + 1) * W + x1 + 1] - t[y0 * W + x1 + 1] - t[(y1 + 1) * W + x0] + t[y0 * W + x0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = Infinity, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
    for (const [qx, qy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x0 = Math.max(0, qx < 0 ? x - r : x), x1 = Math.min(w - 1, qx < 0 ? x : x + r), y0 = Math.max(0, qy < 0 ? y - r : y), y1 = Math.min(h - 1, qy < 0 ? y : y + r);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1), m = sum(satL, x0, y0, x1, y1) / n, v = sum(satL2, x0, y0, x1, y1) / n - m * m;
      if (v < best) { best = v; bx0 = x0; by0 = y0; bx1 = x1; by1 = y1; }
    }
    const n = (bx1 - bx0 + 1) * (by1 - by0 + 1), o = (y * w + x) * 3;
    for (let c = 0; c < 3; c++) out.d[o + c] = sum(sat[c], bx0, by0, bx1, by1) / n;
  }
  return out;
}

/** k-means palette of `k` colours from a sample of the picture (seeded, so a video keeps one palette). */
export function kmeansPalette(img, k = 6, { iters = 8, step = 7, seed = 7 } = {}) {
  const { d } = img, pts = [];
  for (let p = 0; p < d.length; p += 3 * step) pts.push([d[p], d[p + 1], d[p + 2]]);
  const cent = [];
  for (let i = 0; i < k; i++) cent.push([...pts[Math.floor(noise2(i, 3, seed) * pts.length)]]);
  for (let it = 0; it < iters; it++) {
    const acc = cent.map(() => [0, 0, 0, 0]);
    for (const q of pts) { let bi = 0, bd = Infinity; for (let i = 0; i < k; i++) { const c = cent[i], dd = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2; if (dd < bd) { bd = dd; bi = i; } } const a = acc[bi]; a[0] += q[0]; a[1] += q[1]; a[2] += q[2]; a[3]++; }
    for (let i = 0; i < k; i++) if (acc[i][3]) cent[i] = [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]];
  }
  return cent.map(c => c.map(Math.round));
}
/** Map every pixel to its nearest palette colour; returns the picture and the index map (regions). */
export function mapToPalette(img, palette) {
  const { w, h, d } = img, out = image(w, h), idx = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < idx.length; i++, p += 3) {
    let bi = 0, bd = Infinity;
    for (let j = 0; j < palette.length; j++) { const c = palette[j], dd = (d[p] - c[0]) ** 2 * 0.3 + (d[p + 1] - c[1]) ** 2 * 0.59 + (d[p + 2] - c[2]) ** 2 * 0.11; if (dd < bd) { bd = dd; bi = j; } }
    idx[i] = bi; out.d[p] = palette[bi][0]; out.d[p + 1] = palette[bi][1]; out.d[p + 2] = palette[bi][2];
  }
  return { img: out, idx };
}

function paper(img, { seed = 11, amount = 18, scale = 3, tint = null } = {}) {
  const { w, h, d } = img;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const n = (smoothNoise(x, y, scale, seed) - 0.5) * amount + (noise2(x, y, seed + 1) - 0.5) * amount * 0.5, p = (y * w + x) * 3;
    for (let c = 0; c < 3; c++) d[p + c] = clampByte(d[p + c] + n + (tint ? (tint[c] - 128) * 0.04 : 0));
  }
  return img;
}
function vignette(img, k = 0.35) {
  const { w, h, d } = img, cx = w / 2, cy = h / 2, rr = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const f = 1 - k * Math.pow(Math.hypot(x - cx, y - cy) / rr, 2.2), p = (y * w + x) * 3; for (let c = 0; c < 3; c++) d[p + c] = d[p + c] * f; }
  return img;
}
function posterize(img, levels = 4) {
  const step = 255 / (levels - 1), d = img.d;
  for (let i = 0; i < d.length; i++) d[i] = Math.round(d[i] / step) * step;
  return img;
}
function rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn; let hh = 0; if (df) { if (mx === r) hh = ((g - b) / df) % 6; else if (mx === g) hh = (b - r) / df + 2; else hh = (r - g) / df + 4; hh *= 60; if (hh < 0) hh += 360; } return [hh, mx ? df / mx : 0, mx]; }
function hsvToRgb(hh, s, v) { const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c; const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x]; return [(r + m) * 255, (g + m) * 255, (b + m) * 255]; }

// ── the looks ────────────────────────────────────────────────────────────────────────────────────────

/** Comic hybrid (the Into the Spider-Verse technique): bold flat colour, ink lines, halftone dots in the
 *  shadows, printing misregistration; on video the frames are held "on twos". */
export function comicHybrid(src, { seed = 1 } = {}) {
  const { w, h } = src;
  const base = posterize(blurImage(src, 1, 1), 5);
  const L = luminance(base);
  const out = copy(base), cell = Math.max(5, Math.round(w / 150));
  // halftone: in each cell a dark dot grows as the cell darkens, only below mid-grey
  for (let cy = 0; cy < h; cy += cell) for (let cx = (Math.floor(cy / cell) % 2) * (cell >> 1); cx < w; cx += cell) {
    let s = 0, n = 0; for (let y = cy; y < Math.min(h, cy + cell); y++) for (let x = cx; x < Math.min(w, cx + cell); x++) { s += L[y * w + x]; n++; }
    const avg = s / Math.max(1, n); if (avg > 170) continue;
    const rad = (cell / 2) * Math.sqrt(1 - avg / 200), ox = cx + cell / 2, oy = cy + cell / 2;
    for (let y = Math.max(0, Math.floor(oy - rad)); y < Math.min(h, Math.ceil(oy + rad)); y++) for (let x = Math.max(0, Math.floor(ox - rad)); x < Math.min(w, Math.ceil(ox + rad)); x++) {
      if ((x - ox) ** 2 + (y - oy) ** 2 > rad * rad) continue;
      const p = (y * w + x) * 3; for (let c = 0; c < 3; c++) out.d[p + c] = out.d[p + c] * 0.45;
    }
  }
  // misregistration: the red plate is printed a few pixels off
  const shift = Math.max(2, Math.round(w / 480)), reg = copy(out);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const sx = Math.min(w - 1, x + shift); reg.d[(y * w + x) * 3] = out.d[(y * w + sx) * 3]; }
  return applyInk(reg, inkMask(src, { threshold: 70, blur: 1, thick: w > 1200 ? 2 : 1 }), [16, 12, 30]);
}

// Traditional pigments: Prussian and indigo blues (with two slate washes, or every grey-blue sky turns pine green),
// vermilion, ochre, pale ochre, pine and sage, washi cream and sumi black.
const UKIYO = ['#1f2f4a', '#2e4f7a', '#3f5a72', '#5d7f96', '#7fa8c9', '#d9ccb0', '#efe6cf', '#b8402c', '#d98b3a', '#e3c27a', '#4f6b3a', '#7d9a5a', '#2a2522'].map(hex);
/** Woodblock print (ukiyo-e): flat planes in traditional pigments, sumi outlines, bokashi sky, washi paper. */
export function woodblock(src, { seed = 2 } = {}) {
  const { w, h } = src;
  const flat = mapToPalette(kuwahara(blurImage(src, 1, 1), 3), UKIYO).img;
  const top = Math.round(h * 0.28);
  for (let y = 0; y < top; y++) { const k = Math.pow(1 - y / top, 1.6) * 0.55; for (let x = 0; x < w; x++) { const p = (y * w + x) * 3; flat.d[p] = flat.d[p] * (1 - k) + 31 * k; flat.d[p + 1] = flat.d[p + 1] * (1 - k) + 47 * k; flat.d[p + 2] = flat.d[p + 2] * (1 - k) + 74 * k; } }
  applyInk(flat, inkMask(src, { threshold: 80, blur: 2, thick: 1 }), [32, 28, 26], 0.92);
  return paper(flat, { seed, amount: 14, scale: 2, tint: [239, 230, 207] });
}

/** Brunaille (Fleischer-era storybook): monochrome brown watercolour, pooled edges, paper, vignette. */
export function brunaille(src, { seed = 3 } = {}) {
  const { w, h } = src;
  const L = blurPlane(blurPlane(luminance(src), w, h, 2), w, h, 2), wide = blurPlane(L, w, h, 7);
  const ramp = [[38, 26, 18], [104, 74, 50], [176, 142, 104], [238, 226, 204]];
  const out = image(w, h);
  for (let i = 0; i < L.length; i++) {
    const pool = Math.max(0, wide[i] - L[i]) * 0.6, v = Math.max(0, Math.min(1, (L[i] - pool) / 255)) * 3, a = Math.min(2, Math.floor(v)), t = v - a;
    for (let c = 0; c < 3; c++) out.d[i * 3 + c] = ramp[a][c] * (1 - t) + ramp[a + 1][c] * t;
  }
  applyInk(out, inkMask(src, { threshold: 110, blur: 2, thick: 0 }), [44, 30, 20], 0.55);
  return vignette(paper(out, { seed, amount: 16, scale: 4 }), 0.42);
}

/** Paper cutout stop-motion (Fantastic Planet): few flat paper colours, cut-edge drop shadows, paper grain,
 *  and on video a small jitter per held frame, on threes. `state.palette` keeps the colours across a video. */
export function cutout(src, { seed = 4, frame = 0, state = {} } = {}) {
  const { w, h } = src;
  const soft = blurImage(src, 3, 2);
  const pal = state.palette || (state.palette = kmeansPalette(soft, 7, { seed }));
  const { img, idx } = mapToPalette(soft, pal);
  const sh = Math.max(3, Math.round(w / 240)), out = copy(img);
  for (let y = sh; y < h; y++) for (let x = sh; x < w; x++) {
    const i = y * w + x, j = (y - sh) * w + (x - sh);
    if (idx[i] !== idx[j] && pal[idx[j]].reduce((a, b) => a + b) > pal[idx[i]].reduce((a, b) => a + b)) for (let c = 0; c < 3; c++) out.d[i * 3 + c] *= 0.62;
  }
  for (let i = 0; i < idx.length; i++) { const x = i % w, y = (i / w) | 0, n = (smoothNoise(x + idx[i] * 97, y, 2, seed + idx[i]) - 0.5) * 22; for (let c = 0; c < 3; c++) out.d[i * 3 + c] = clampByte(out.d[i * 3 + c] + n); }
  const jx = Math.round((noise2(frame, 1, seed) - 0.5) * 6), jy = Math.round((noise2(frame, 2, seed) - 0.5) * 6);
  if (!jx && !jy) return out;
  const moved = image(w, h); moved.d.fill(30);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const sx = x - jx, sy = y - jy; if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue; const p = (y * w + x) * 3, q = (sy * w + sx) * 3; moved.d[p] = out.d[q]; moved.d[p + 1] = out.d[q + 1]; moved.d[p + 2] = out.d[q + 2]; }
  return moved;
}

/** Charcoal and watercolour (The Red Turtle): soft broken charcoal lines over a pale watercolour wash. */
export function charcoalWatercolor(src, { seed = 5 } = {}) {
  const { w, h } = src;
  const wash = blurImage(src, 4, 2), d = wash.d;
  for (let p = 0; p < d.length; p += 3) { const l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; for (let c = 0; c < 3; c++) d[p + c] = 236 * 0.45 + (d[p + c] * 0.6 + l * 0.4) * 0.55 + 18; }
  const E = sobel(blurPlane(luminance(src), w, h, 1), w, h);
  for (let i = 0; i < E.length; i++) {
    const x = i % w, y = (i / w) | 0, grain = smoothNoise(x, y, 1.5, seed), s = Math.min(1, E[i] / 260) * (0.35 + grain * 0.9);
    if (s > 0.18) for (let c = 0; c < 3; c++) d[i * 3 + c] = d[i * 3 + c] * (1 - s) + 34 * s;
  }
  return paper(wash, { seed, amount: 20, scale: 3 });
}

/** Rotoscope graphic novel (Waltz with Bashir): smoothed shapes in a few flat tones, strong black outlines;
 *  `state.palette` keeps one palette for a whole video so tones do not flicker. */
export function rotoscope(src, { seed = 6, state = {} } = {}) {
  const smooth = kuwahara(blurImage(src, 1, 1), 3);
  const pal = state.palette || (state.palette = kmeansPalette(smooth, 6, { seed }).map(c => c.map(v => Math.round(v * 0.92))));
  const { img } = mapToPalette(smooth, pal);
  return applyInk(img, inkMask(src, { threshold: 60, blur: 2, thick: src.w > 1200 ? 2 : 1 }), [10, 10, 12]);
}

/** Painted 3D (the Arcane technique): Kuwahara brush strokes, teal shadows and warm highlights, canvas weave. */
export function painted(src, { seed = 7 } = {}) {
  // two Kuwahara passes, the second wider: strokes a viewer reads as paint (one narrow pass looked like the source)
  const out = kuwahara(kuwahara(src, Math.max(3, Math.round(src.w / 240))), Math.max(5, Math.round(src.w / 130))), d = out.d;
  for (let p = 0; p < d.length; p += 3) {
    const l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2], sh = Math.max(0, (120 - l) / 120), hi = Math.max(0, (l - 140) / 115);
    d[p] = clampByte(d[p] - 22 * sh + 24 * hi); d[p + 1] = clampByte(d[p + 1] + 6 * sh + 8 * hi); d[p + 2] = clampByte(d[p + 2] + 28 * sh - 18 * hi);
  }
  const { w, h } = out;
  // brush streaks: value noise stretched along a slant reads as the direction of a stroke
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const streak = (smoothNoise(x * 0.35 + y * 0.9, y * 0.35 - x * 0.12, 5, seed) - 0.5) * 26, weave = ((x % 4 < 2) !== (y % 4 < 2) ? 1 : -1) * 2, p = (y * w + x) * 3; for (let c = 0; c < 3; c++) d[p + c] = clampByte(d[p + c] + streak + weave); }
  return applyInk(out, inkMask(src, { threshold: 120, blur: 1, thick: 0 }), [26, 22, 34], 0.45);
}

const GOLDS = ['#d4af37', '#b8892a', '#f0d47a', '#8a6420', '#e8c25a'].map(hex);
/** Ornamental gold mosaic (inspired by Klimt's golden period): calm areas become gold squares, spirals and eyes;
 *  detailed areas keep the picture, warmed, with dark gold contour. */
export function ornament(src, { seed = 8 } = {}) {
  const { w, h } = src;
  const L = luminance(src), energy = blurPlane(sobel(blurPlane(L, w, h, 1), w, h), w, h, 6);
  // the figure keeps its detail, the ground becomes gold: ground = calm and unsaturated (smoothed so the mosaic
  // has clean borders). Without the saturation test the fox in the first trial became mosaic too.
  const ground = new Float32Array(w * h);
  for (let i = 0, p = 0; i < ground.length; i++, p += 3) { const [, s] = rgbToHsv(src.d[p], src.d[p + 1], src.d[p + 2]); ground[i] = energy[i] < 45 && s < 0.42 ? 1 : 0; }
  const mask = blurPlane(blurPlane(ground, w, h, 4), w, h, 4);
  const out = copy(src), cell = Math.max(10, Math.round(w / 70));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, p = i * 3;
    if (mask[i] < 0.55) { out.d[p] = clampByte(out.d[p] * 1.06 + 8); out.d[p + 2] = out.d[p + 2] * 0.88; continue; }
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), motif = Math.floor(noise2(cx, cy, seed) * 4), u = (x % cell) / cell - 0.5, v = (y % cell) / cell - 0.5, r = Math.hypot(u, v);
    let ink = false;
    if (motif === 0) ink = Math.abs(u) > 0.42 || Math.abs(v) > 0.42 || (Math.abs(u) < 0.16 && Math.abs(v) < 0.16);
    else if (motif === 1) ink = Math.abs(Math.sin((r * 18 - Math.atan2(v, u)) )) < 0.25 && r < 0.48;
    else if (motif === 2) ink = Math.abs(r - 0.32) < 0.05 || r < 0.1;
    else ink = Math.abs(u) + Math.abs(v) > 0.44 && Math.abs(u) + Math.abs(v) < 0.5;
    const g = GOLDS[Math.floor(noise2(cx, cy, seed + 3) * GOLDS.length)], leaf = (noise2(x, y, seed) - 0.5) * 26;
    for (let c = 0; c < 3; c++) out.d[p + c] = ink ? g[c] * 0.42 : clampByte(g[c] + leaf);
  }
  return applyInk(out, inkMask(src, { threshold: 95, blur: 1, thick: 0 }), [74, 52, 16], 0.8);
}

/** Low-poly with hand-drawn ink (Tekkonkinkreet): flat triangles from a jittered grid, loose ink lines,
 *  cross-hatching in the shadows. */
export function lowpolyInk(src, { seed = 9 } = {}) {
  const { w, h, d } = src, g = Math.max(14, Math.round(w / 48)), out = image(w, h);
  const cols = Math.ceil(w / g) + 1, rows = Math.ceil(h / g) + 1, V = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const edge = i === 0 || j === 0 || i === cols || j === rows;
    V.push([i * g + (edge ? 0 : (noise2(i, j, seed) - 0.5) * g * 0.7), j * g + (edge ? 0 : (noise2(i, j, seed + 1) - 0.5) * g * 0.7)]);
  }
  const tri = (a, b, c) => {
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (!den) return;
    const inside = (x, y) => { const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den; return l1 >= -1e-6 && l2 >= -1e-6 && 1 - l1 - l2 >= -1e-6; };
    let r = 0, gg = 0, bb = 0, n = 0;
    for (let y = minY; y <= maxY; y += 2) for (let x = minX; x <= maxX; x += 2) if (inside(x + 0.5, y + 0.5)) { const p = (y * w + x) * 3; r += d[p]; gg += d[p + 1]; bb += d[p + 2]; n++; }
    if (!n) { const x = Math.min(w - 1, Math.round((a[0] + b[0] + c[0]) / 3)), y = Math.min(h - 1, Math.round((a[1] + b[1] + c[1]) / 3)), p = (y * w + x) * 3; r = d[p]; gg = d[p + 1]; bb = d[p + 2]; n = 1; }
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (inside(x + 0.5, y + 0.5)) { const p = (y * w + x) * 3; out.d[p] = r / n; out.d[p + 1] = gg / n; out.d[p + 2] = bb / n; }
  };
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * (cols + 1) + i, a = V[k], b = V[k + 1], c = V[k + cols + 1], e = V[k + cols + 2];
    if ((i + j) % 2) { tri(a, b, e); tri(a, e, c); } else { tri(a, b, c); tri(b, e, c); }
  }
  const L = luminance(src);
  for (let i = 0; i < L.length; i++) { const x = i % w, y = (i / w) | 0; if ((L[i] < 85 && (x + y) % 7 === 0) || (L[i] < 45 && (x - y + 1000) % 7 === 0)) for (let c = 0; c < 3; c++) out.d[i * 3 + c] *= 0.35; }
  return applyInk(out, inkMask(src, { threshold: 85, blur: 1, thick: 0 }), [20, 18, 24], 0.85);
}

/** Cel-shaded anime finish: smoothed shapes, three value steps per hue, a little more colour, clean ink.
 *  Used after style-recipe generation and as its own look on photos and video. */
export function animeCel(src, { seed = 10 } = {}) {
  const sm = kuwahara(src, 2), d = sm.d;
  for (let p = 0; p < d.length; p += 3) {
    const [hh, s, v] = rgbToHsv(d[p], d[p + 1], d[p + 2]);
    const step = v < 0.32 ? 0.24 : v < 0.62 ? 0.55 : v < 0.86 ? 0.8 : 0.97;
    const rgb = hsvToRgb(hh, Math.min(1, s * 1.18), step);
    d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2];
  }
  return applyInk(sm, inkMask(src, { threshold: 75, blur: 1, thick: src.w > 1200 ? 1 : 0 }), [30, 22, 40], 0.9);
}

// Pop silkscreen inks, chosen in sets of three (ground, mid tone, highlight) so a picture reads as one print run
const POP_SETS = [['#ff3fa4', '#ffe14d', '#3fd6ff'], ['#ff7a1a', '#7d4dff', '#a8ff3f'], ['#00c2a8', '#ff4d6d', '#ffd23f'], ['#3b5bff', '#ff9ec7', '#fff36b']].map(s => s.map(hex));
/** Pop silkscreen (1960s screen-print portraits): three flat ink tones, a black key plate printed slightly off
 *  register, and uneven ink coverage. `state.inks` keeps one ink set for a whole video. */
export function silkscreen(src, { seed = 12, state = {} } = {}) {
  const { w, h } = src, L = blurPlane(luminance(src), w, h, 2), inks = state.inks || (state.inks = POP_SETS[Math.floor(noise2(seed, 5, seed) * POP_SETS.length)]);
  // tone cuts at this picture's own thirds, so a dark photo still prints all three inks
  const sorted = Float32Array.from(L).sort(), t1 = sorted[Math.floor(sorted.length * 0.33)], t2 = sorted[Math.floor(sorted.length * 0.7)];
  const out = image(w, h), sh = Math.max(3, Math.round(w / 160));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, l = L[i], ink = l < t1 ? inks[0] : l < t2 ? inks[1] : inks[2];
    const cover = 0.9 + (smoothNoise(x, y, 3, seed) - 0.5) * 0.25;                     // a squeegee never lays ink evenly
    for (let c = 0; c < 3; c++) out.d[i * 3 + c] = clampByte(ink[c] * cover + 245 * (1 - cover));
  }
  // the black key: the darkest third and the contours, printed `sh` pixels off from the colour
  const key = inkMask(src, { threshold: 60, blur: 2, thick: w > 1200 ? 2 : 1 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x - sh, sy = y - Math.round(sh / 2); if (sx < 0 || sy < 0) continue;
    const j = sy * w + sx, dark = L[j] < t1 * 0.62 || key[j] > 0.5;
    if (dark) { const p = (y * w + x) * 3; out.d[p] = 18; out.d[p + 1] = 14; out.d[p + 2] = 20; }
  }
  return out;
}

/** Urban stencil graffiti: a two-tone spray-paint stencil (black and one accent colour) with overspray and drips
 *  on a weathered concrete wall. */
export function stencil(src, { seed = 13 } = {}) {
  const { w, h } = src, L = blurPlane(luminance(src), w, h, 2);
  const sorted = Float32Array.from(L).sort(), dark = sorted[Math.floor(sorted.length * 0.38)], mid = sorted[Math.floor(sorted.length * 0.62)];
  const ink = new Float32Array(w * h), accent = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) { ink[i] = L[i] < dark ? 1 : 0; accent[i] = L[i] >= dark && L[i] < mid ? 1 : 0; }
  const spray = blurPlane(ink, w, h, Math.max(2, Math.round(w / 300)));                  // the soft edge of a can held off the wall
  const out = image(w, h), brick = Math.max(16, Math.round(w / 32)), red = [214, 38, 46];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, p = i * 3;
    // the wall: grey concrete with stains and faint brick courses
    const course = (y % brick === 0 || ((x + (Math.floor(y / brick) % 2) * brick / 2) % (brick * 2) === 0)) ? -10 : 0;
    const wall = 196 + (smoothNoise(x, y, 6, seed) - 0.5) * 34 + (noise2(x, y, seed) - 0.5) * 14 + course;
    let r = wall, g = wall - 3, b = wall - 8;
    if (accent[i]) { const a = 0.82 + (noise2(x, y, seed + 2) - 0.5) * 0.3; r = r * (1 - a) + red[0] * a; g = g * (1 - a) + red[1] * a; b = b * (1 - a) + red[2] * a; }
    const k = ink[i] ? 0.96 : Math.min(0.55, spray[i] * 0.9) * (noise2(x, y, seed + 3) > 0.45 ? 1 : 0.4);   // speckled overspray
    out.d[p] = clampByte(r * (1 - k) + 16 * k); out.d[p + 1] = clampByte(g * (1 - k) + 16 * k); out.d[p + 2] = clampByte(b * (1 - k) + 18 * k);
  }
  // a few drips run down from the lower edges of the black
  for (let x = 0; x < w; x += 3) {
    if (noise2(x, 7, seed) < 0.985) continue;
    let y0 = -1; for (let y = h - 1; y >= 0; y--) if (ink[y * w + x]) { y0 = y; break; }
    if (y0 < 0) continue;
    const len = Math.round(h * (0.02 + noise2(x, 9, seed) * 0.06));
    for (let y = y0; y < Math.min(h, y0 + len); y++) { const p = (y * w + x) * 3; out.d[p] = out.d[p + 1] = out.d[p + 2] = 18; }
  }
  return out;
}

// Four-colour newsprint: the few flat inks a 1950s Sunday strip was printed in, over yellowed paper
const NEWS_INKS = ['#f3e7c9', '#f1c7a3', '#e3463a', '#3e6fb5', '#f2cc3d', '#6aa35a', '#8f6c4a', '#1b1b1b'].map(hex);
/** Mid-century newspaper strip: confident ink lines, a handful of flat inks printed as Ben-Day dots over
 *  yellowed newsprint, the colour plate a little off register. */
export function newsprint(src, { seed = 14 } = {}) {
  const { w, h } = src, flat = mapToPalette(kuwahara(blurImage(src, 1, 1), 2), NEWS_INKS).img, paperCol = NEWS_INKS[0];
  const out = image(w, h), cell = Math.max(4, Math.round(w / 220)), sh = Math.max(1, Math.round(w / 640));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.max(0, x - sh), i = (y * w + sx) * 3, p = (y * w + x) * 3;
    const col = [flat.d[i], flat.d[i + 1], flat.d[i + 2]], isPaper = Math.abs(col[0] - paperCol[0]) + Math.abs(col[1] - paperCol[1]) + Math.abs(col[2] - paperCol[2]) < 20;
    // Ben-Day: inks other than black print as dots of a fixed size on a grid; black and paper print solid
    const dark = col[0] + col[1] + col[2] < 120, u = (x % cell) - cell / 2, v = (y % cell) - cell / 2, dot = u * u + v * v < (cell * 0.42) ** 2;
    const c = isPaper || (!dark && !dot) ? paperCol : col;
    for (let k = 0; k < 3; k++) out.d[p + k] = c[k];
  }
  applyInk(out, inkMask(src, { threshold: 70, blur: 1, thick: w > 1200 ? 2 : 1 }), [22, 20, 18], 0.95);
  return paper(out, { seed, amount: 12, scale: 3, tint: [240, 228, 196] });
}

/** Every look the filter engine can apply, with what it is and how video frames are held. */
export const FILTER_LOOKS = Object.freeze({
  'comic-hybrid': { fn: comicHybrid, label: 'Comic hybrid', technique: 'halftone dots, ink lines and misregistered colour over moving shapes, held on twos (the Into the Spider-Verse technique)', hold: 2 },
  woodblock: { fn: woodblock, label: 'Woodblock print', technique: 'flat planes in traditional pigments, sumi outlines, graded sky, washi paper (ukiyo-e; Samurai Jack, Kubo)', hold: 2 },
  brunaille: { fn: brunaille, label: 'Brunaille storybook', technique: 'brown monochrome watercolour with pooled edges and paper (Fleischer-era; Over the Garden Wall)', hold: 2 },
  cutout: { fn: cutout, label: 'Paper cutout stop-motion', technique: 'a few flat paper colours, cut-edge shadows, jitter on threes (Fantastic Planet)', hold: 3 },
  'charcoal-watercolor': { fn: charcoalWatercolor, label: 'Charcoal and watercolour', technique: 'soft broken charcoal over a pale wash (The Red Turtle)', hold: 2 },
  rotoscope: { fn: rotoscope, label: 'Rotoscope graphic novel', technique: 'smoothed flat tones with heavy outlines, one palette for the whole film (Waltz with Bashir)', hold: 2 },
  painted: { fn: painted, label: 'Painted 3D', technique: 'brush-stroke smoothing, teal shadows and warm light, canvas weave (the Arcane technique)', hold: 1 },
  ornament: { fn: ornament, label: 'Gold ornament', technique: 'calm areas become a gold mosaic of squares, spirals and eyes (after Klimt\'s golden period)', hold: 1 },
  'lowpoly-ink': { fn: lowpolyInk, label: 'Low-poly ink', technique: 'flat low-poly triangles with loose ink and hatching (Tekkonkinkreet)', hold: 2 },
  'anime-cel': { fn: animeCel, label: 'Anime cel', technique: 'smoothed shapes, three value steps per hue, clean ink', hold: 2 },
  silkscreen: { fn: silkscreen, label: 'Pop silkscreen', technique: 'three flat ink tones and a black key plate off register, uneven coverage (1960s pop screen prints)', hold: 2 },
  stencil: { fn: stencil, label: 'Stencil graffiti', technique: 'black and one red spray stencil with overspray and drips on a concrete wall', hold: 2 },
  newsprint: { fn: newsprint, label: 'Newspaper strip', technique: 'ink lines and a few flat inks as Ben-Day dots on yellowed newsprint (1950s Sunday strips)', hold: 2 },
});
