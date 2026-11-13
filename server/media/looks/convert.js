/**
 * Convert a user's picture or video into any look, and give a still picture a camera move.
 *
 * - Images: decoded with sharp at a working size, filtered (looks/filters.js, looks/glyph-looks.js, or the pixel
 *   looks of pixel-art.js), saved at full size into data/media with provenance.
 * - Video: ffmpeg decodes frames at the look's own beat (on ones, twos or threes: a look "held on twos" draws a new
 *   picture every second frame, like hand animation), each frame is filtered, ffmpeg encodes 24 fps with the
 *   original sound. Saved into data/video with provenance.
 * - Camera moves (`animateStill`): push, pull, pans, tilts, crash zoom, orbit, handheld, whip pan, spiral, Ken
 *   Burns — rendered from the still by cropping, scaling and turning it per frame, with any look on top. This is
 *   the camera-motion side of tools like Higgsfield. Making a still *come alive* (a model moving what is in it) is
 *   Wan 2.2 on a worker's card (looks/index.js startMotion); this file only prepares its start frame (`coverPng`),
 *   measures whether the result moves (`measureMotion`) and puts it on the shelf (`shelveClip`).
 *
 * Nothing leaves the machine. A real person's face in an input needs that person's consent (`consent: true`).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../../config.js';
import { image, FILTER_LOOKS } from './filters.js';
import { GLYPH_LOOKS } from './glyph-looks.js';
import { STYLES as PIXEL_STYLES, resolvePalette, quantize } from '../pixel-art.js';
import { noteMedia } from '../media-meta.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const MEDIA_DIR = join(DATA_DIR, 'media'), VIDEO_DIR = join(DATA_DIR, 'video');
const MAX_VIDEO_SECONDS = Number(process.env.LOOKS_MAX_VIDEO_SECONDS) || 90;
const FPS = 24;

// ── the catalog ──────────────────────────────────────────────────────────────────────────────────────

function boxDown(src, w, h) {
  const out = image(w, h), sx = src.w / w, sy = src.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const p = (yy * src.w + xx) * 3; r += src.d[p]; g += src.d[p + 1]; b += src.d[p + 2]; n++; }
    const o = (y * w + x) * 3; out.d[o] = r / n; out.d[o + 1] = g / n; out.d[o + 2] = b / n;
  }
  return out;
}
const pixelLook = style => ({
  label: style === '2bit' ? '2-bit' : '8-bit', technique: PIXEL_STYLES[style].label, hold: 2, pixel: true,
  fn: (src) => {
    const [nw, nh] = PIXEL_STYLES[style].native, portrait = src.h > src.w, w = portrait ? nh : nw, h = portrait ? nw : nh;
    const small = boxDown(src, w, h), pal = resolvePalette(PIXEL_STYLES[style].palette, PIXEL_STYLES[style].palette);
    return image(w, h, new Uint8ClampedArray(quantize(Buffer.from(small.d.buffer, small.d.byteOffset, small.d.length), w, h, pal.colours, { dither: true })));
  },
});

/** Every look a picture or video can be turned into. */
export const LOOKS = Object.freeze({ ...FILTER_LOOKS, ...GLYPH_LOOKS, '8bit': pixelLook('8bit'), '2bit': pixelLook('2bit') });
export const LOOK_NAMES = Object.freeze(Object.keys(LOOKS));
export function lookInfo() { return LOOK_NAMES.map(id => ({ id, label: LOOKS[id].label, technique: LOOKS[id].technique, heldOn: LOOKS[id].hold })); }

/** Even sizes for a picture of w×h: the working size the filters see, and the size that is saved. */
export function sizesFor(w, h, { work = 960, out = 1920 } = {}) {
  const even = n => Math.max(2, Math.round(n / 2) * 2), long = Math.max(w, h);
  const ws = Math.min(1, work / long), os = Math.min(out / long, 3);
  return { work: [even(w * ws), even(h * ws)], out: [even(w * os), even(h * os)] };
}

/** Apply a look to one RGB frame. Returns { img, scaleKernel } — the picture and how to bring it to output size. */
export function applyLook(look, src, ctx = {}) {
  const L = LOOKS[look];
  if (!L) throw new Error(`unknown look: ${look} (have ${LOOK_NAMES.join(', ')})`);
  const img = L.fullSize ? L.fn(src, { ...ctx, w: ctx.outW, h: ctx.outH }) : L.fn(src, ctx);
  return { img, kernel: L.pixel ? 'nearest' : 'lanczos3' };
}

function guardConsent({ realFace, consent }) {
  if (realFace && consent !== true) throw Object.assign(new Error("a real person's face is only used with that person's consent: pass consent: true once they agreed"), { status: 422, code: 'consent_required' });
}
const stamp = ext => `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

// ── images ───────────────────────────────────────────────────────────────────────────────────────────

/** A picture (bytes) into a look. Saved into data/media; returns { file, path, width, height, look, ms }. */
export async function convertImage(input, { look, seed = 7, realFace = false, consent = false, source = 'looks', note = '' } = {}) {
  guardConsent({ realFace, consent });
  const t0 = Date.now();
  const meta = await sharp(input).rotate().metadata();
  const w0 = meta.autoOrient?.width || meta.width, h0 = meta.autoOrient?.height || meta.height;
  const { work, out } = sizesFor(w0, h0);
  const { data } = await sharp(input).rotate().flatten({ background: '#000' }).resize(work[0], work[1], { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { img, kernel } = applyLook(look, image(work[0], work[1], new Uint8ClampedArray(data)), { seed, frame: 0, state: {}, outW: out[0], outH: out[1] });
  mkdirSync(MEDIA_DIR, { recursive: true });
  const file = stamp('png'), path = join(MEDIA_DIR, file);
  await sharp(Buffer.from(img.d.buffer, img.d.byteOffset, img.d.length), { raw: { width: img.w, height: img.h, channels: 3 } })
    .resize(out[0], out[1], { kernel, fit: 'fill' }).png({ compressionLevel: 8 }).toFile(path);
  noteMedia(file, 'look', [note || `${LOOKS[look].label} look`, { look, seed, from: `${w0}x${h0}` }], { source });
  return { file, path, width: out[0], height: out[1], look, label: LOOKS[look].label, ms: Date.now() - t0 };
}

// ── video ────────────────────────────────────────────────────────────────────────────────────────────

function run(cmd, args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`))));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}
export async function probe(path) {
  const j = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path])).toString());
  const v = (j.streams || []).find(s => s.codec_type === 'video');
  if (!v) throw new Error('no video stream in that file');
  const rot = Number(v.tags?.rotate || v.side_data_list?.find(s => s.rotation != null)?.rotation || 0);
  const turned = Math.abs(rot) % 180 === 90;
  return { w: turned ? v.height : v.width, h: turned ? v.width : v.height, seconds: Number(j.format?.duration || v.duration || 0), audio: (j.streams || []).some(s => s.codec_type === 'audio') };
}

/**
 * A video file into a look, at most LOOKS_MAX_VIDEO_SECONDS long. Frames are drawn at 24 / hold per second and
 * held, so a look on twos shows 12 new pictures a second. Returns { file, path, seconds, frames, look, ms }.
 */
export async function convertVideo(inputPath, { look, seed = 7, realFace = false, consent = false, onProgress = null, source = 'looks', note = '', maxSeconds = MAX_VIDEO_SECONDS } = {}) {
  guardConsent({ realFace, consent });
  if (!LOOKS[look]) throw new Error(`unknown look: ${look}`);
  const t0 = Date.now(), info = await probe(inputPath);
  const cap = Math.max(1, Math.min(MAX_VIDEO_SECONDS, Number(maxSeconds) || MAX_VIDEO_SECONDS));
  const seconds = Math.min(info.seconds || cap, cap), hold = LOOKS[look].hold || 1, drawFps = FPS / hold;
  const { work, out } = sizesFor(info.w, info.h);
  const frameBytes = work[0] * work[1] * 3;
  mkdirSync(VIDEO_DIR, { recursive: true });
  const file = stamp('mp4'), path = join(VIDEO_DIR, file);
  const dec = spawn('ffmpeg', ['-v', 'error', '-i', inputPath, '-t', String(seconds), '-vf', `fps=${drawFps},scale=${work[0]}:${work[1]}:flags=area`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
  // the first frame decides the encoder's input size (full-size looks draw at output size, pixel looks at native size)
  let enc = null, encErr = '', frames = 0, pending = Buffer.alloc(0), state = {}, encDone = null;
  const startEncoder = (img, kernel) => {
    const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${img.w}x${img.h}`, '-r', String(drawFps), '-i', 'pipe:0'];
    if (info.audio) args.push('-t', String(seconds), '-i', inputPath, '-map', '0:v', '-map', '1:a?', '-c:a', 'aac', '-b:a', '160k', '-shortest');
    args.push('-vf', `scale=${out[0]}:${out[1]}:flags=${kernel === 'nearest' ? 'neighbor' : 'lanczos'},fps=${FPS}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path);
    enc = spawn('ffmpeg', args, { windowsHide: true });
    enc.stderr.on('data', d => { encErr += d; });
    encDone = new Promise((res, rej) => enc.on('close', code => (code === 0 ? res() : rej(new Error(`encoder exited ${code}: ${encErr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`)))));
  };
  const total = Math.max(1, Math.round(seconds * drawFps));
  let decErr = '';
  dec.stderr.on('data', d => { decErr += d; });
  for await (const chunk of dec.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const raw = pending.subarray(0, frameBytes); pending = pending.subarray(frameBytes);
      const { img, kernel } = applyLook(look, image(work[0], work[1], new Uint8ClampedArray(raw)), { seed, frame: frames, state, outW: out[0], outH: out[1] });
      if (!enc) startEncoder(img, kernel);
      const buf = Buffer.from(img.d.buffer, img.d.byteOffset, img.d.length);
      if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once('drain', r));
      frames++;
      if (onProgress && frames % 12 === 0) onProgress(Math.min(0.99, frames / total), frames, total);
    }
  }
  await new Promise(r => (dec.exitCode != null ? r() : dec.on('close', r)));
  if (!enc) throw new Error(`no frames could be read from that video${decErr ? `: ${decErr.trim().split('\n').pop().slice(0, 200)}` : ''}`);
  enc.stdin.end();
  await encDone;
  noteMedia(file, 'look', [note || `${LOOKS[look].label} look on a video`, { look, seed, heldOn: hold, seconds: +seconds.toFixed(2), frames, from: basename(inputPath) }], { source });
  return { file, path, seconds: +seconds.toFixed(2), frames, drawnPerSecond: drawFps, width: out[0], height: out[1], look, label: LOOKS[look].label, ms: Date.now() - t0 };
}

// ── camera moves for a still ─────────────────────────────────────────────────────────────────────────

const ease = x => x * x * (3 - 2 * x), easeIn = x => x * x * x, clamp01 = x => Math.max(0, Math.min(1, x));
/** Each move gives, for progress p in 0..1, a view: zoom z (1 = whole frame), centre cx, cy in 0..1, turn in degrees. */
export const CAMERA_MOVES = Object.freeze({
  'push-in': p => ({ z: 1 + 0.35 * ease(p), cx: 0.5, cy: 0.5 }),
  'pull-out': p => ({ z: 1.35 - 0.35 * ease(p), cx: 0.5, cy: 0.5 }),
  // at zoom 1.3 the view is 0.77 of the picture, so its centre can travel 0.385..0.615 and no further
  'pan-left': p => ({ z: 1.3, cx: 0.61 - 0.22 * ease(p), cy: 0.5 }),
  'pan-right': p => ({ z: 1.3, cx: 0.39 + 0.22 * ease(p), cy: 0.5 }),
  'tilt-up': p => ({ z: 1.3, cx: 0.5, cy: 0.61 - 0.22 * ease(p) }),
  'tilt-down': p => ({ z: 1.3, cx: 0.5, cy: 0.39 + 0.22 * ease(p) }),
  'crash-zoom': p => { const k = easeIn(clamp01((p - 0.35) / 0.4)); return { z: 1 + 1.4 * k, cx: 0.5, cy: 0.5 - 0.04 * k }; },
  orbit: p => ({ z: 1.25 + 0.06 * Math.sin(p * Math.PI), cx: 0.5 + 0.1 * Math.sin(p * Math.PI * 2), cy: 0.5 + 0.03 * Math.cos(p * Math.PI * 2), turn: 2.5 * Math.sin(p * Math.PI * 2) }),
  handheld: (p, f) => ({ z: 1.12, cx: 0.5 + 0.012 * Math.sin(f * 0.31) + 0.006 * Math.sin(f * 1.7), cy: 0.5 + 0.01 * Math.cos(f * 0.27) + 0.005 * Math.sin(f * 2.3), turn: 0.6 * Math.sin(f * 0.19) }),
  'whip-pan': p => ({ z: 1.3, cx: p < 0.45 ? 0.39 : p > 0.6 ? 0.61 : 0.39 + 0.22 * ease((p - 0.45) / 0.15), cy: 0.5, blur: p > 0.43 && p < 0.62 }),
  spiral: p => ({ z: 1.1 + 0.5 * ease(p), cx: 0.5, cy: 0.5, turn: 25 * ease(p) }),
  'ken-burns': p => ({ z: 1.2 + 0.22 * ease(p), cx: 0.45 + 0.11 * ease(p), cy: 0.47 + 0.06 * ease(p) }),
});
export const CAMERA_MOVE_NAMES = Object.freeze(Object.keys(CAMERA_MOVES));

/**
 * A still picture becomes a short film with a camera move (and an optional look).
 * @returns { file, path, seconds, frames, move, look, ms }
 */
export async function animateStill(input, { move = 'push-in', seconds = 5, look = null, format = '16:9', seed = 7, realFace = false, consent = false, source = 'looks', note = '' } = {}) {
  guardConsent({ realFace, consent });
  if (!CAMERA_MOVES[move]) throw new Error(`unknown camera move: ${move} (have ${CAMERA_MOVE_NAMES.join(', ')})`);
  if (look && !LOOKS[look]) throw new Error(`unknown look: ${look}`);
  seconds = Math.max(2, Math.min(20, Number(seconds) || 5));
  const t0 = Date.now(), [ow, oh] = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] }[format] || [1920, 1080];
  const work = look ? sizesFor(ow, oh).work : [ow, oh];
  // one big copy of the still (cover-cropped to the frame shape, with room to zoom), turned per frame when the move turns
  const big = await sharp(input).rotate().flatten({ background: '#000' }).resize(Math.round(work[0] * 2.4), Math.round(work[1] * 2.4), { fit: 'cover' }).removeAlpha().png().toBuffer();
  const bigMeta = await sharp(big).metadata();
  const hold = look ? LOOKS[look].hold || 1 : 1, total = Math.round(seconds * FPS), drawn = Math.ceil(total / hold);
  mkdirSync(VIDEO_DIR, { recursive: true });
  const file = stamp('mp4'), path = join(VIDEO_DIR, file);
  let enc = null, encErr = '', encDone = null, state = {}, prev = null;
  for (let k = 0; k < drawn; k++) {
    const f = k * hold, p = total > 1 ? f / (total - 1) : 0, v = CAMERA_MOVES[move](p, f);
    let pic = sharp(big);
    if (v.turn) pic = sharp(await pic.rotate(v.turn, { background: '#000' }).toBuffer());
    const meta = v.turn ? await pic.metadata() : bigMeta;
    // the view: 1/z of the big copy (a turned copy is cropped a little tighter so its black corners stay out)
    const cw = Math.min(meta.width, Math.round(meta.width / v.z / (v.turn ? 1.08 : 1))), ch = Math.min(meta.height, Math.round(cw * work[1] / work[0]));
    const left = Math.max(0, Math.min(meta.width - cw, Math.round(v.cx * meta.width - cw / 2))), top = Math.max(0, Math.min(meta.height - ch, Math.round(v.cy * meta.height - ch / 2)));
    const { data } = await pic.extract({ left, top, width: cw, height: ch }).resize(work[0], work[1], { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const frame = image(work[0], work[1], new Uint8ClampedArray(data));
    if (v.blur && prev) { const d = frame.d; for (let i = 0; i < d.length; i++) d[i] = (d[i] + prev.d[i]) / 2; }   // motion smear on the whip
    prev = frame;
    const { img, kernel } = look ? applyLook(look, frame, { seed, frame: k, state, outW: ow, outH: oh }) : { img: frame, kernel: 'lanczos3' };
    if (!enc) {
      enc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${img.w}x${img.h}`, '-r', String(FPS / hold), '-i', 'pipe:0',
        '-vf', `scale=${ow}:${oh}:flags=${kernel === 'nearest' ? 'neighbor' : 'lanczos'},fps=${FPS}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], { windowsHide: true });
      enc.stderr.on('data', d => { encErr += d; });
      encDone = new Promise((res, rej) => enc.on('close', code => (code === 0 ? res() : rej(new Error(`encoder exited ${code}: ${encErr.trim().slice(-300)}`)))));
    }
    const buf = Buffer.from(img.d.buffer, img.d.byteOffset, img.d.length);
    if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once('drain', r));
  }
  enc.stdin.end();
  await encDone;
  noteMedia(file, 'animate', [note || `${move} camera move${look ? ` in the ${LOOKS[look].label} look` : ''}`, { move, look, seconds, format }], { source });
  return { file, path, seconds, frames: drawn, move, look, ms: Date.now() - t0 };
}

// ── motion clips from a model (Wan 2.2 on a worker) ──────────────────────────────────────────────────

/** A picture cover-cropped to w×h as PNG: the start frame an image-to-video model animates. */
export async function coverPng(input, w, h, { realFace = false, consent = false } = {}) {
  guardConsent({ realFace, consent });
  return sharp(input).rotate().flatten({ background: '#000' }).resize(w, h, { fit: 'cover' }).png().toBuffer();
}

/**
 * Does a clip move? Mean absolute grey difference (0–255) between the first frame and four later ones (`overall`),
 * and between neighbours of those (`step`), on a 96 px wide copy. A model that returns its start frame five times
 * over scores about 0; a clip worth keeping scores well above MOTION_MIN (the same 1.5 fraymus-video-studio uses).
 */
export const MOTION_MIN = 1.5;
export async function measureMotion(path) {
  const raw = await run('ffmpeg', ['-v', 'error', '-i', path, '-vf', 'scale=96:-2,format=gray', '-f', 'rawvideo', 'pipe:1']);
  const info = await probe(path), w = 96, h = Math.max(2, Math.round(96 * info.h / info.w / 2) * 2), n = Math.floor(raw.length / (w * h));
  if (n < 2) return { overall: 0, step: 0, frames: n };
  const frame = i => raw.subarray(i * w * h, (i + 1) * w * h);
  const idx = [...new Set([0, 1, 2, 3, 4].map(k => Math.round(k * (n - 1) / 4)))];
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const overall = idx.slice(1).reduce((s, i) => s + diff(frame(i), frame(0)), 0) / (idx.length - 1);
  const step = idx.slice(1).reduce((s, i, k) => s + diff(frame(i), frame(idx[k])), 0) / (idx.length - 1);
  return { overall: +overall.toFixed(2), step: +step.toFixed(2), frames: n };
}

/** A finished clip onto the shelf (data/video) with provenance; returns the shelf file name. */
export function shelveClip(buf, { op = 'motion', note = '', params = {}, source = 'looks' } = {}) {
  mkdirSync(VIDEO_DIR, { recursive: true });
  const file = stamp('mp4');
  writeFileSync(join(VIDEO_DIR, file), buf);
  noteMedia(file, op, [note, params], { source });
  return file;
}

/** Find a file on Chandra's shelf by bare name (data/media or data/video), never outside those folders. */
export function shelfFile(name) {
  if (!/^[\w.-]{1,160}$/.test(String(name || ''))) throw new Error('give a bare file name from the shelf');
  for (const dir of [MEDIA_DIR, VIDEO_DIR]) { const p = join(dir, name); if (existsSync(p) && statSync(p).isFile()) return p; }
  throw Object.assign(new Error(`no file named ${name} on the shelf`), { status: 404 });
}
export function saveUpload(base64, ext) {
  if (!/^(png|jpe?g|webp|gif|mp4|webm|mov|mkv)$/i.test(ext)) throw new Error('unsupported file type');
  const dir = /^(mp4|webm|mov|mkv)$/i.test(ext) ? VIDEO_DIR : MEDIA_DIR; mkdirSync(dir, { recursive: true });
  const file = stamp(ext.toLowerCase()); writeFileSync(join(dir, file), Buffer.from(base64, 'base64'));
  return join(dir, file);
}
