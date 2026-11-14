/**
 * Scene → layers, pure (no model, no I/O): separate the subject of a picture from its background, fill the hole the
 * subject leaves, and read a coarse tile grid out of a picture for a game level.
 *
 * Absorbed from Vaughn's Nexus Engine (docs/NEXUS-ENGINE-CREATION-METHODS.md, methods 10, 16 and 17). Nexus asked a
 * paid image model to "remove the characters" and "isolate the character on magenta", plus a corner flood fill that
 * compared every pixel with the corner's own colour. That fill leaks into the subject on a gradient sky and stops short
 * on a lit one, so here the fill grows across *smooth* change (neighbour to neighbour) and stops at edges, with a loose
 * bound against the seed colour so a slow gradient cannot walk all the way into the subject.
 *
 * Images are filters.js images: { w, h, d: Uint8ClampedArray RGB }. Masks are Uint8Array w*h (1 = subject).
 */
import { image } from './filters.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (d, i, j) => { const a = d[i * 3] - d[j * 3], b = d[i * 3 + 1] - d[j * 3 + 1], c = d[i * 3 + 2] - d[j * 3 + 2]; return a * a + b * b + c * c; };
const distRgb2 = (d, i, r, g, b) => { const x = d[i * 3] - r, y = d[i * 3 + 1] - g, z = d[i * 3 + 2] - b; return x * x + y * y + z * z; };

/** Nearest-neighbour or box resample of an RGB image (box when shrinking, so the mask sees averaged colour). */
export function resize(img, w, h) {
  const out = image(w, h), sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < Math.min(y1, img.h); yy++) for (let xx = x0; xx < Math.min(x1, img.w); xx++) { const k = (yy * img.w + xx) * 3; r += img.d[k]; g += img.d[k + 1]; b += img.d[k + 2]; n++; }
    const o = (y * w + x) * 3; out.d[o] = r / n; out.d[o + 1] = g / n; out.d[o + 2] = b / n;
  }
  return out;
}

/** Sobel gradient magnitude of luma (0 at the outer pixels). */
export function edgeMap(img) {
  const { w, h, d } = img, L = new Float32Array(w * h), E = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = 0.299 * d[i * 3] + 0.587 * d[i * 3 + 1] + 0.114 * d[i * 3 + 2];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1] + L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
    const gy = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1] + L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
    E[i] = Math.hypot(gx, gy) / 4;
  }
  return E;
}

/**
 * How varied the picture's border is: mean RGB distance of border pixels from their mean colour. A studio backdrop
 * or a flat colour is under ~25; a scene (sky, trees, ground all touching the edge) is far above. The colour fill is
 * only trusted on a plain border — a busy one needs the U^2-Net matte.
 */
export function borderSpread(img) {
  const { w, h, d } = img, seeds = borderSeeds(w, h, 1);
  let r = 0, g = 0, b = 0;
  for (const s of seeds) { r += d[s * 3]; g += d[s * 3 + 1]; b += d[s * 3 + 2]; }
  r /= seeds.length; g /= seeds.length; b /= seeds.length;
  let sum = 0;
  for (const s of seeds) sum += Math.sqrt(distRgb2(d, s, r, g, b));
  return +(sum / seeds.length).toFixed(1);
}
export const PLAIN_BORDER = 30;

/** Edge seeds: every pixel of the border, sampled. */
function borderSeeds(w, h, step) {
  const s = [];
  for (let x = 0; x < w; x += step) s.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y += step) s.push(y * w, y * w + w - 1);
  return s;
}

/**
 * Background = everything reachable from the picture's border by small steps.
 *   local  : a step to a neighbour is allowed when the two pixels differ by less than this (0-255 RGB distance)
 *   global : …and the pixel is within this of the border colour the walk started from
 * `floor` (0-1) keeps the bottom rows out of the seeds: a figure standing on the ground touches the bottom edge.
 */
export function backgroundMask(img, { local = 22, global = 140, floor = 0.0, edgeStop = 55 } = {}) {
  const { w, h, d } = img, n = w * h;
  // a drawn outline stops the walk even where the colours on both sides match (a white face on a white studio)
  const E = edgeStop ? edgeMap(img) : null;
  const bg = new Uint8Array(n), seedOf = new Int32Array(n).fill(-1);
  const L2 = local * local, G2 = global * global;
  const stack = [];
  const cut = Math.floor(h * (1 - floor));
  for (const s of borderSeeds(w, h, 1)) if (Math.floor(s / w) < cut && !bg[s]) { bg[s] = 1; seedOf[s] = s; stack.push(s); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w, s = seedOf[i];
    const sr = d[s * 3], sg = d[s * 3 + 1], sb = d[s * 3 + 2];
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || bg[j]) continue;
      if (dist2(d, i, j) > L2 || distRgb2(d, j, sr, sg, sb) > G2 || (E && E[j] > edgeStop)) continue;
      bg[j] = 1; seedOf[j] = s; stack.push(j);
    }
  }
  return bg;
}

/** Connected components of `mask` (4-neighbour). Returns { label: Int32Array, sizes: [] } (label 0 = outside). */
export function components(mask, w, h) {
  const label = new Int32Array(w * h), sizes = [0];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    const id = sizes.length; let size = 0; const stack = [i]; label[i] = id;
    while (stack.length) {
      const k = stack.pop(), x = k % w; size++;
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) if (j >= 0 && j < mask.length && mask[j] && !label[j]) { label[j] = id; stack.push(j); }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

/** Grow (r > 0) or shrink (r < 0) a mask by r pixels (square neighbourhood, separable). */
export function morph(mask, w, h, r) {
  if (!r) return Uint8Array.from(mask);
  const grow = r > 0, R = Math.abs(r), want = grow ? 1 : 0;
  const pass = (src, horiz) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hit = !grow;                                      // grow: any 1 in reach; shrink: all 1 in reach
      for (let k = -R; k <= R; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        const v = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
        if (grow && v === want) { hit = true; break; }
        if (!grow && v !== 1) { hit = false; break; }
      }
      out[y * w + x] = hit ? 1 : 0;
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/**
 * The subject mask of a picture: not background, the largest piece (or the piece under `point` = [fx, fy] in 0-1),
 * holes inside it filled. Works at `work` px on the long side. Returns the mask at the working size plus a verdict:
 * a subject that is almost nothing or almost everything was not separated, and `ok` says so.
 */
export function subjectMask(img, { work = 384, local, global, floor, edgeStop, point = null, minShare = 0.01, maxShare = 0.8 } = {}) {
  const s = Math.min(1, work / Math.max(img.w, img.h));
  const small = s < 1 ? resize(img, Math.max(8, Math.round(img.w * s)), Math.max(8, Math.round(img.h * s))) : img;
  const { w, h } = small;
  const spread = borderSpread(small);
  if (spread > PLAIN_BORDER) {
    return { mask: new Uint8Array(w * h), w, h, share: 0, box: null, ok: false, spread,
      reason: `the background is busy (border colour spread ${spread}, plain is under ${PLAIN_BORDER}); a colour fill cannot separate this subject — it needs the U^2-Net matte on a worker` };
  }
  const bg = backgroundMask(small, { local, global, floor, edgeStop });
  return finishMask(Uint8Array.from(bg, v => (v ? 0 : 1)), w, h, { point, minShare, maxShare, spread });
}

/**
 * From a rough foreground (1 = subject) at w×h: open away speckle, keep the largest piece (or the one under `point`),
 * fill holes that do not open to the border, and judge the result by its share of the picture.
 */
export function finishMask(fgIn, w, h, { point = null, minShare = 0.01, maxShare = 0.85, spread = null } = {}) {
  if (fgIn.length !== w * h) throw new Error(`mask is ${fgIn.length} values for a ${w}×${h} picture`);
  let fg = fgIn;
  fg = morph(morph(fg, w, h, -1), w, h, 1);                 // open: drop single-pixel speckle along edges
  const { label, sizes } = components(fg, w, h);
  let keep = 0;
  if (point) { const px = clamp(Math.round(point[0] * (w - 1)), 0, w - 1), py = clamp(Math.round(point[1] * (h - 1)), 0, h - 1); keep = label[py * w + px]; }
  if (!keep) for (let id = 1; id < sizes.length; id++) if (!keep || sizes[id] > sizes[keep]) keep = id;
  const mask = new Uint8Array(w * h);
  if (keep) for (let i = 0; i < mask.length; i++) mask[i] = label[i] === keep ? 1 : 0;
  // fill holes: background pieces that do not touch the border are inside the subject (eyes, a gap under an arm stays if it opens out)
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) outside[i] = mask[i] ? 0 : 1;
  const holes = components(outside, w, h), touches = new Set();
  for (const sIdx of borderSeeds(w, h, 1)) if (holes.label[sIdx]) touches.add(holes.label[sIdx]);
  for (let i = 0; i < mask.length; i++) if (outside[i] && !touches.has(holes.label[i])) mask[i] = 1;
  let area = 0; for (const v of mask) area += v;
  const share = area / mask.length, box = maskBox(mask, w, h);
  const ok = share >= minShare && share <= maxShare;
  return { mask, w, h, share: +share.toFixed(4), box, ok, spread, reason: ok ? null : share < minShare ? 'the subject could not be told apart from the background (almost nothing left)' : 'the background could not be found (the subject would be almost the whole picture)' };
}

/**
 * How decided a soft matte (0-255) is: the share of pixels that are clearly background (< 32) or clearly subject
 * (> 223). U^2-Net on a picture with a subject is near 1; on a landscape with nothing salient it paints a grey haze
 * over clouds and sky (measured 2026-11-14: robot on white 0.985, girl in a painted scene 0.959, flat landscape 0.626).
 */
export function matteClarity(soft) {
  let clear = 0;
  for (const v of soft) if (v < 32 || v > 223) clear++;
  return +(clear / Math.max(1, soft.length)).toFixed(3);
}
export const MIN_CLARITY = 0.85;

/** Bounding box of a mask, in pixels: { x, y, w, h } or null. */
export function maskBox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Scale a working-size mask to full size as a soft alpha (0-255): bilinear, then a smooth step around one half so the
 * edge is anti-aliased over about `feather` full-size pixels.
 */
export function alphaFromMask(mask, mw, mh, W, H, feather = 1.5) {
  const a = new Uint8ClampedArray(W * H), fx = mw / W, fy = mh / H, soft = Math.max(0.01, feather * Math.max(fx, fy));
  for (let y = 0; y < H; y++) {
    const sy = clamp((y + 0.5) * fy - 0.5, 0, mh - 1), y0 = Math.floor(sy), y1 = Math.min(mh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = clamp((x + 0.5) * fx - 0.5, 0, mw - 1), x0 = Math.floor(sx), x1 = Math.min(mw - 1, x0 + 1), tx = sx - x0;
      const v = (mask[y0 * mw + x0] * (1 - tx) + mask[y0 * mw + x1] * tx) * (1 - ty) + (mask[y1 * mw + x0] * (1 - tx) + mask[y1 * mw + x1] * tx) * ty;
      const t = clamp((v - 0.5) / soft + 0.5, 0, 1);
      a[y * W + x] = Math.round(t * t * (3 - 2 * t) * 255);
    }
  }
  return a;
}

/** A 0/1 mask blurred into a 0..1 ramp of radius r (separable box blur, twice). */
export function softMask(mask, w, h, r) {
  let a = Float32Array.from(mask);
  const R = Math.max(1, Math.round(r));
  const pass = (src, horiz) => {
    const out = new Float32Array(src.length), len = horiz ? w : h, lines = horiz ? h : w;
    for (let l = 0; l < lines; l++) {
      let sum = 0;
      const at = k => (horiz ? l * w + k : k * w + l);
      for (let k = -R; k <= R; k++) sum += src[at(clamp(k, 0, len - 1))];
      for (let k = 0; k < len; k++) {
        out[at(k)] = sum / (2 * R + 1);
        sum += src[at(clamp(k + R + 1, 0, len - 1))] - src[at(clamp(k - R, 0, len - 1))];
      }
    }
    return out;
  };
  for (let i = 0; i < 2; i++) a = pass(pass(a, true), false);
  return a;
}

/**
 * Fill the pixels where `hole` = 1 from the pixels around them: a push-pull pyramid (average the known pixels down
 * to coarser levels, then pull the coarse colour back up into the gaps). Known pixels are left exactly as they were.
 * Smooth, not textured — the worker's painting step repaints it; with no worker this is the plate.
 */
export function fillHole(img, hole) {
  const levels = [];
  let w = img.w, h = img.h;
  let col = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) if (!hole[i]) { wt[i] = 1; col[i * 3] = img.d[i * 3]; col[i * 3 + 1] = img.d[i * 3 + 1]; col[i * 3 + 2] = img.d[i * 3 + 2]; }
  levels.push({ w, h, col, wt });
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), ncol = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, j = Math.min(nh - 1, y >> 1) * nw + Math.min(nw - 1, x >> 1);
      nwt[j] += wt[i]; ncol[j * 3] += col[i * 3]; ncol[j * 3 + 1] += col[i * 3 + 1]; ncol[j * 3 + 2] += col[i * 3 + 2];
    }
    levels.push({ w: nw, h: nh, col: ncol, wt: nwt });
    w = nw; h = nh; col = ncol; wt = nwt;
  }
  // pull: from the coarsest level up, each level's empty (or thin) pixels take the coarser level's average colour
  for (let k = levels.length - 2; k >= 0; k--) {
    const L = levels[k], C = levels[k + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x;
      if (L.wt[i] >= 1) continue;
      const sx = clamp((x + 0.5) / 2 - 0.5, 0, C.w - 1), sy = clamp((y + 0.5) / 2 - 0.5, 0, C.h - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(C.w - 1, x0 + 1), y1 = Math.min(C.h - 1, y0 + 1), tx = sx - x0, ty = sy - y0;
      for (let c = 0; c < 3; c++) {
        const avg = j => (C.wt[j] > 0 ? C.col[j * 3 + c] / C.wt[j] : 0);
        const up = (avg(y0 * C.w + x0) * (1 - tx) + avg(y0 * C.w + x1) * tx) * (1 - ty) + (avg(y1 * C.w + x0) * (1 - tx) + avg(y1 * C.w + x1) * tx) * ty;
        const have = L.wt[i] > 0 ? L.col[i * 3 + c] / L.wt[i] : 0;
        L.col[i * 3 + c] = have * L.wt[i] + up * (1 - L.wt[i]);
      }
      L.wt[i] = 1;
    }
  }
  const out = image(img.w, img.h);
  for (let i = 0; i < img.w * img.h; i++) for (let c = 0; c < 3; c++) out.d[i * 3 + c] = hole[i] ? levels[0].col[i * 3 + c] : img.d[i * 3 + c];
  return out;
}

/**
 * How much of the subject is still visible in a plate: mean colour difference between plate and original inside the
 * hole (a plate that changed nothing there still shows the subject) and outside it (a plate must not move the rest).
 */
export function plateCheck(original, plate, hole, { w = null, h = null, flatRatio = 0.35 } = {}) {
  let inside = 0, nIn = 0, outside = 0, nOut = 0;
  for (let i = 0; i < hole.length; i++) {
    const diff = (Math.abs(original.d[i * 3] - plate.d[i * 3]) + Math.abs(original.d[i * 3 + 1] - plate.d[i * 3 + 1]) + Math.abs(original.d[i * 3 + 2] - plate.d[i * 3 + 2])) / 3;
    if (hole[i]) { inside += diff; nIn++; } else { outside += diff; nOut++; }
  }
  const changedInside = nIn ? inside / nIn : 0, changedOutside = nOut ? outside / nOut : 0;
  // texture: local detail inside the hole against a ring of the same width around it. A patch far flatter than its
  // surroundings is a slab, not background (seen live: a tree trunk replaced by a flat brown block passed the
  // change test alone).
  let texture = null;
  if (w && h) {
    const E = edgeMap(plate), ring = morph(hole, w, h, Math.max(4, Math.round(Math.max(w, h) * 0.03)));
    let eIn = 0, cIn = 0, eRing = 0, cRing = 0;
    for (let i = 0; i < hole.length; i++) { if (hole[i]) { eIn += E[i]; cIn++; } else if (ring[i]) { eRing += E[i]; cRing++; } }
    const a = cIn ? eIn / cIn : 0, b = cRing ? eRing / cRing : 0;
    texture = { inside: +a.toFixed(2), around: +b.toFixed(2), ratio: b > 1 ? +(a / b).toFixed(2) : null };
  }
  const flat = texture?.ratio !== null && texture?.ratio !== undefined && texture.ratio < flatRatio;
  const ok = nIn > 0 && changedInside >= 12 && changedOutside <= 2 && !flat;
  return { changedInside: +changedInside.toFixed(1), changedOutside: +changedOutside.toFixed(1), texture, ok,
    reason: ok ? null : flat ? `the filled area is much flatter than its surroundings (detail ${texture.inside} against ${texture.around}): a patch, not background` : changedInside < 12 ? 'the subject is still there' : 'the rest of the picture moved' };
}

/**
 * Did the painter put a figure back where the subject was? A non-inpainting model given a figure-shaped hole tends to
 * paint a figure in it (seen live: a dark knight-shaped silhouette in a misty forest). Compare the plate's mean colour
 * over the subject's own pixels with its mean over the rest of the hole (the margin grown around it): a real
 * background continues through both, a repainted figure stands apart.
 */
export function silhouetteScore(plate, subject, hole) {
  let a = [0, 0, 0], na = 0, b = [0, 0, 0], nb = 0;
  for (let i = 0; i < hole.length; i++) {
    if (!hole[i]) continue;
    const t = subject[i] ? a : b;
    for (let c = 0; c < 3; c++) t[c] += plate.d[i * 3 + c];
    if (subject[i]) na++; else nb++;
  }
  if (!na || !nb) return { score: 0, ok: true };
  const score = Math.sqrt(a.reduce((s, v, c) => s + (v / na - b[c] / nb) ** 2, 0));
  return { score: +score.toFixed(1), ok: score < SILHOUETTE_MAX };
}
export const SILHOUETTE_MAX = 40;

/** A box-shaped hole around a mask (its bounding box grown by `pad`): a shape that does not suggest a body. */
export function boxHole(mask, w, h, pad) {
  const b = maskBox(mask, w, h), out = new Uint8Array(w * h);
  if (!b) return out;
  const x0 = Math.max(0, b.x - pad), y0 = Math.max(0, b.y - pad), x1 = Math.min(w, b.x + b.w + pad), y1 = Math.min(h, b.y + b.h + pad);
  for (let y = y0; y < y1; y++) out.fill(1, y * w + x0, y * w + x1);
  return out;
}

/**
 * A coarse level read from a picture: `cols` × `rows` cells, each '.' (open, like the sky at the top of the picture)
 * or '#' (solid). The top row's mean colour is the sky; a cell far enough from it is solid. The bottom row is always
 * solid (somewhere to stand), and '=' marks a solid cell with open space above it (a platform top).
 */
export function levelFromPicture(img, { cols = 24, rows = 13, threshold = 70 } = {}) {
  const small = resize(img, cols, rows);
  let sr = 0, sg = 0, sb = 0;
  for (let x = 0; x < cols; x++) { sr += small.d[x * 3]; sg += small.d[x * 3 + 1]; sb += small.d[x * 3 + 2]; }
  sr /= cols; sg /= cols; sb /= cols;
  const solid = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => y === rows - 1 || Math.sqrt(distRgb2(small.d, y * cols + x, sr, sg, sb)) > threshold));
  const tiles = solid.map((row, y) => row.map((s, x) => (!s ? '.' : y > 0 && !solid[y - 1][x] ? '=' : '#')).join(''));
  const open = tiles.join('').split('').filter(c => c === '.').length / (cols * rows);
  return { cols, rows, tiles, sky: [Math.round(sr), Math.round(sg), Math.round(sb)], open: +open.toFixed(3) };
}
