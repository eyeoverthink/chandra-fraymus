/**
 * 3-D models on Chandra's shelf: read a .glb (binary glTF 2.0), draw it with a small software rasterizer, and turn
 * it into turntable frames that any look (looks/convert.js) can restyle — ASCII, 8-bit, 2-bit, bricks, woodblock…
 *
 * Pure: no GPU, no library, no I/O. Hunyuan3D gives a shape without texture, so a model is drawn either in clay or
 * coloured from the picture it was made from, projected onto it from the front (`colorFrom`): that is the camera the
 * picture was taken with, so the front matches and the sides and back take the nearest colour along the same line.
 */
import { image, blurImage } from './filters.js';

const GLB_MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** A .glb buffer → { positions: Float32Array (xyz…), indices: Uint32Array, triangles, vertices }. All primitives are merged. */
export function parseGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a .glb file');
  if (buf.readUInt32LE(4) !== 2) throw new Error(`glTF version ${buf.readUInt32LE(4)} is not supported`);
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), body = buf.subarray(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    else if (type === CHUNK_BIN) bin = body;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('the .glb has no JSON or no binary chunk');
  const read = (accIndex) => {
    const acc = json.accessors[accIndex], view = json.bufferViews[acc.bufferView], n = acc.count * COMPONENTS[acc.type];
    const start = (view.byteOffset || 0) + (acc.byteOffset || 0), stride = view.byteStride || 0;
    const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[acc.componentType];
    if (!T) throw new Error(`accessor component type ${acc.componentType} is not supported`);
    const per = COMPONENTS[acc.type], size = T.BYTES_PER_ELEMENT;
    if (!stride || stride === per * size) return new T(bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + n * size));
    const out = new T(n);
    for (let i = 0; i < acc.count; i++) for (let k = 0; k < per; k++) out[i * per + k] = new T(bin.buffer.slice(bin.byteOffset + start + i * stride + k * size, bin.byteOffset + start + i * stride + (k + 1) * size))[0];
    return out;
  };
  const pos = [], idx = [];
  let base = 0;
  for (const mesh of json.meshes || []) for (const prim of mesh.primitives || []) {
    if (prim.mode !== undefined && prim.mode !== 4) continue;                     // triangles only
    const p = read(prim.attributes.POSITION), count = p.length / 3;
    pos.push(p);
    if (prim.indices !== undefined) { const ix = read(prim.indices); const u = new Uint32Array(ix.length); for (let i = 0; i < ix.length; i++) u[i] = ix[i] + base; idx.push(u); }
    else { const u = new Uint32Array(count); for (let i = 0; i < count; i++) u[i] = i + base; idx.push(u); }
    base += count;
  }
  if (!base) throw new Error('the .glb has no triangle mesh');
  const positions = new Float32Array(base * 3); let o = 0; for (const p of pos) { positions.set(p, o); o += p.length; }
  const total = idx.reduce((s, a) => s + a.length, 0), indices = new Uint32Array(total); o = 0; for (const a of idx) { indices.set(a, o); o += a.length; }
  return { positions, indices, vertices: base, triangles: total / 3 };
}

/** positions (Float32Array xyz) + indices (Uint32Array) → a minimal .glb buffer (one mesh, one primitive). */
export function buildGlb(positions, indices) {
  const pb = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength), ib = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
  const json = { asset: { version: '2.0', generator: 'chandra mesh3d' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    buffers: [{ byteLength: pb.length + ib.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pb.length }, { buffer: 0, byteOffset: pb.length, byteLength: ib.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }] };
  const pad = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);
  const jb = pad(Buffer.from(JSON.stringify(json)), 0x20), bb = pad(Buffer.concat([pb, ib]), 0);
  const head = Buffer.alloc(12); head.writeUInt32LE(GLB_MAGIC, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8);
  const ch = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, body]); };
  return Buffer.concat([head, ch(CHUNK_JSON, jb), ch(CHUNK_BIN, bb)]);
}

/** A UV sphere (for tests and for a placeholder). */
export function sphere(segments = 24, rings = 16) {
  const pos = [], idx = [];
  for (let r = 0; r <= rings; r++) for (let s = 0; s <= segments; s++) { const th = Math.PI * r / rings, ph = 2 * Math.PI * s / segments; pos.push(Math.sin(th) * Math.cos(ph) * 0.5, Math.cos(th) * 0.5, Math.sin(th) * Math.sin(ph) * 0.5); }
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) { const a = r * (segments + 1) + s, b = a + segments + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Centre the model and scale it so its longest side is 1. Returns a new positions array and the original bounds. */
export function normalize(mesh) {
  const p = mesh.positions, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < min[k]) min[k] = p[i + k]; if (p[i + k] > max[k]) max[k] = p[i + k]; }
  const c = [0, 1, 2].map(k => (min[k] + max[k]) / 2), s = 1 / Math.max(1e-9, ...[0, 1, 2].map(k => max[k] - min[k]));
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) out[i + k] = (p[i + k] - c[k]) * s;
  return { ...mesh, positions: out, bounds: { min, max } };
}

const CLAY = [196, 182, 164];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * Draw a normalized mesh. yaw/pitch in radians turn the model; the camera looks down −z with a slight perspective.
 * `colorFrom` = { img (looks image), front: '+z' | '-z' } colours each triangle from the picture seen from the front.
 * Returns a looks image (RGB) of w×h.
 */
export function renderMesh(mesh, { w = 960, h = 540, yaw = 0, pitch = -0.18, zoom = 1, background = [24, 26, 32], colorFrom = null } = {}) {
  const out = image(w, h), depth = new Float32Array(w * h).fill(Infinity), p = mesh.positions, ix = mesh.indices;
  for (let i = 0; i < w * h; i++) { const y = Math.floor(i / w), t = y / h; out.d[i * 3] = background[0] * (1 - 0.35 * t); out.d[i * 3 + 1] = background[1] * (1 - 0.35 * t); out.d[i * 3 + 2] = background[2] * (1 - 0.25 * t); }
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const scale = Math.min(w, h) * 0.82 * zoom, camZ = 2.6;
  const tr = new Float32Array(p.length);                                           // rotated positions
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] * cy + p[i + 2] * sy, z0 = -p[i] * sy + p[i + 2] * cy, y = p[i + 1];
    tr[i] = x; tr[i + 1] = y * cp - z0 * sp; tr[i + 2] = y * sp + z0 * cp;
  }
  const key = norm([-0.45, 0.65, 0.6]), fill = norm([0.6, 0.15, 0.4]), view = [0, 0, 1];
  const proj = (i) => { const z = camZ - tr[i + 2], f = camZ / z; return [w / 2 + tr[i] * scale * f, h / 2 - tr[i + 1] * scale * f, z]; };
  const sample = colorFrom?.sample || null;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const A = [tr[a], tr[a + 1], tr[a + 2]], B = [tr[b], tr[b + 1], tr[b + 2]], C = [tr[c], tr[c + 1], tr[c + 2]];
    let n = norm(cross(sub(B, A), sub(C, A)));
    if (n[2] < 0) n = [-n[0], -n[1], -n[2]];                                         // two-sided: generated meshes do not keep one winding
    let base = CLAY;
    if (sample) base = sample((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3);   // colour from the source picture, seen from the front
    const lam = Math.max(0, n[0] * key[0] + n[1] * key[1] + n[2] * key[2]), lf = Math.max(0, n[0] * fill[0] + n[1] * fill[1] + n[2] * fill[2]);
    const facing = n[0] * view[0] + n[1] * view[1] + n[2] * view[2], rim = Math.pow(1 - Math.abs(facing), 3) * 0.35;
    const light = 0.32 + 0.62 * lam + 0.22 * lf;
    const col = [0, 1, 2].map(k => Math.min(255, base[k] * light + 255 * rim));
    const P = [proj(a), proj(b), proj(c)];
    const minX = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))), maxX = Math.min(w - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))), maxY = Math.min(h - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
    const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[2][0] - px) * (P[1][1] - py)) / area;
      const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[0][0] - px) * (P[2][1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2], o = y * w + x;
      if (z >= depth[o]) continue;
      depth[o] = z; out.d[o * 3] = col[0]; out.d[o * 3 + 1] = col[1]; out.d[o * 3 + 2] = col[2];
    }
  }
  return out;
}

/**
 * A colour sampler for renderMesh: the picture the model was made from, with the model's x/y extent mapped onto the
 * figure's bounding box in that picture (everything not close to the background colour). `mirror` flips x for a
 * model whose front faces −z. Points outside the figure take the nearest edge pixel.
 */
export function pictureSampler(img, mesh, { background = 'auto', tolerance = 40, share = 0.04, mirror = false } = {}) {
  // 'auto': the picture's own background, read from its four corners (a painted "white" studio is often light grey)
  if (background === 'auto') {
    const k = Math.max(2, Math.round(Math.min(img.w, img.h) * 0.04)), acc = [0, 0, 0]; let n = 0;
    for (const [cx, cy] of [[0, 0], [img.w - k, 0], [0, img.h - k], [img.w - k, img.h - k]]) for (let y = cy; y < cy + k; y++) for (let x = cx; x < cx + k; x++) { const q = (y * img.w + x) * 3; acc[0] += img.d[q]; acc[1] += img.d[q + 1]; acc[2] += img.d[q + 2]; n++; }
    background = acc.map(v => v / n);
  }
  // a column or row belongs to the figure when at least `share` of its pixels differ clearly from the background:
  // a soft studio gradient or a floor shadow leaves a few stray pixels everywhere and must not widen the box
  const cols = new Uint32Array(img.w), rows = new Uint32Array(img.h);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const q = (y * img.w + x) * 3;
    if (Math.abs(img.d[q] - background[0]) + Math.abs(img.d[q + 1] - background[1]) + Math.abs(img.d[q + 2] - background[2]) > tolerance * 3) { cols[x]++; rows[y]++; }
  }
  const first = (a, lim) => { for (let i = 0; i < a.length; i++) if (a[i] > lim) return i; return -1; }, last = (a, lim) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] > lim) return i; return -1; };
  let x0 = first(cols, img.h * share), x1 = last(cols, img.h * share), y0 = first(rows, img.w * share), y1 = last(rows, img.w * share);
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) { x0 = 0; x1 = img.w - 1; y0 = 0; y1 = img.h - 1; }
  const p = mesh.positions; let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (let i = 0; i < p.length; i += 3) { mnx = Math.min(mnx, p[i]); mxx = Math.max(mxx, p[i]); mny = Math.min(mny, p[i + 1]); mxy = Math.max(mxy, p[i + 1]); }
  const box = { x0, x1, y0, y1 };
  // what the picture saw: the front-most surface along each line of sight (front = +z, the side Hunyuan3D faces the
  // camera). A point well behind it (the back, the far side) was never in the picture: it takes the figure's mean colour.
  const G = 192, front = new Float32Array(G * G).fill(-Infinity);
  const gx = x => Math.min(G - 1, Math.max(0, Math.floor((x - mnx) / Math.max(1e-9, mxx - mnx) * G))), gy = y => Math.min(G - 1, Math.max(0, Math.floor((mxy - y) / Math.max(1e-9, mxy - mny) * G)));
  for (let i = 0; i < p.length; i += 3) { const k = gy(p[i + 1]) * G + gx(p[i]); if (p[i + 2] > front[k]) front[k] = p[i + 2]; }
  // what was never seen takes the regional colour of the front at the same place, without its details: the picture
  // blurred by ~7 % of the figure's width (a face becomes the colour of the head, a logo the colour of the shirt)
  const soft = blurImage(img, Math.max(2, Math.round((x1 - x0) * 0.07)), 2);
  const DEPTH = 0.06;
  return {
    box,
    sample: (mx, my, mz) => {
      const from = mz !== undefined && mz < front[gy(my) * G + gx(mx)] - DEPTH ? soft : img;
      let fx = (mx - mnx) / Math.max(1e-9, mxx - mnx); if (mirror) fx = 1 - fx;
      const fy = (mxy - my) / Math.max(1e-9, mxy - mny);
      const u = Math.min(img.w - 1, Math.max(0, Math.round(x0 + fx * (x1 - x0)))), v = Math.min(img.h - 1, Math.max(0, Math.round(y0 + fy * (y1 - y0))));
      const q = (v * img.w + u) * 3; return [from.d[q], from.d[q + 1], from.d[q + 2]];
    },
  };
}

/** How much of a frame the model covers (0–1): a drawing that shows nothing is a failure, not a picture. */
export function coverage(img, background = [24, 26, 32]) {
  let n = 0; const total = img.w * img.h;
  for (let i = 0; i < total; i++) { const y = Math.floor(i / img.w), t = y / img.h; if (Math.abs(img.d[i * 3] - background[0] * (1 - 0.35 * t)) > 2 || Math.abs(img.d[i * 3 + 2] - background[2] * (1 - 0.25 * t)) > 2) n++; }
  return n / total;
}
