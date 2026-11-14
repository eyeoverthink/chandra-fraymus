/**
 * Vector rotoscope on real files: a picture becomes an SVG (plus a PNG of it), a clip becomes an SVG per drawn frame
 * and a film of them. The drawing itself is vector.js; this file decodes, renders and checks.
 *
 * Rendering is Skia (@napi-rs/canvas), the same as the flat films: the SVG's width/height are set to the output size,
 * so lines are rasterised there and stay sharp. A clip is drawn at 8 pictures a second and held for three frames
 * ("on threes", how hand rotoscope is usually shot); one palette, taken from the first frame, is used for every frame,
 * so colours do not flicker — the lines moving is the look.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../../config.js';
import { image } from './filters.js';
import { vectorize, vectorFidelity, resize, VECTOR_STYLES } from './vector.js';
import { probe } from './convert.js';
import { noteMedia } from '../media-meta.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const MEDIA_DIR = join(DATA_DIR, 'media'), VIDEO_DIR = join(DATA_DIR, 'video');
const DRAW_FPS = 8, FPS = 24;
export const MAX_VECTOR_SECONDS = Math.max(2, Number(process.env.LOOKS_MAX_VECTOR_SECONDS) || 30);
// a filled drawing must keep the picture's colours: mean difference on 48-px copies (measured 9–38 on real pictures)
export const MAX_COLOUR_ERROR = 45;
const stamp = ext => `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
const even = n => Math.max(2, Math.round(n / 2) * 2);

/** Draw an SVG with Skia at its own width/height; returns an RGB image (filters.js format) and the RGBA bytes. */
export async function renderSvg(svg) {
  const pic = await loadImage(Buffer.from(svg));
  const w = pic.width, h = pic.height;
  if (!w || !h) throw new Error('the SVG did not render (no size)');
  const c = createCanvas(w, h), ctx = c.getContext('2d');
  ctx.drawImage(pic, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data, rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; }
  return { img: image(w, h, rgb), rgba: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h };
}

/** The check every drawing passes: it rendered, it drew lines, and (filled styles) it kept the picture's colours. */
export function checkDrawing(source, rendered, stats, style) {
  const fid = vectorFidelity(resize(source, rendered.w, rendered.h), rendered);
  const problems = [];
  if (!stats.lines && !stats.fillPaths) problems.push('nothing was drawn');
  if (VECTOR_STYLES[style].fills && fid.colourError > MAX_COLOUR_ERROR) problems.push(`the colours drifted from the picture (difference ${fid.colourError}, at most ${MAX_COLOUR_ERROR})`);
  return { ...fid, ok: !problems.length, problems };
}

/** A picture (bytes) as vector art: SVG + PNG on the shelf. */
export async function vectorImage(input, { style = 'cutout', detail = 1, source = 'looks', note = '' } = {}) {
  const t0 = Date.now();
  const { data, info } = await sharp(input).rotate().flatten({ background: '#ffffff' }).removeAlpha().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const src = image(info.width, info.height, new Uint8ClampedArray(data));
  const scale = Math.min(1920 / Math.max(src.w, src.h), 2), outW = even(src.w * scale), outH = even(src.h * scale);
  const v = vectorize(src, { style, detail, outW, outH });
  const r = await renderSvg(v.svg);
  const check = checkDrawing(src, r.img, v.stats, style);
  if (!check.ok) throw new Error(`the drawing failed its check: ${check.problems.join('; ')}`);
  mkdirSync(MEDIA_DIR, { recursive: true });
  const base = stamp('x').slice(0, -2), svgFile = `${base}.svg`, pngFile = `${base}.png`;
  writeFileSync(join(MEDIA_DIR, svgFile), v.svg);
  await sharp(r.rgba, { raw: { width: r.w, height: r.h, channels: 4 } }).removeAlpha().png({ compressionLevel: 8 }).toFile(join(MEDIA_DIR, pngFile));
  const params = { style, label: VECTOR_STYLES[style].label, detail, ...v.stats, check, svg: svgFile };
  noteMedia(pngFile, 'vector', [note || `${VECTOR_STYLES[style].label}`, params], { source });
  noteMedia(svgFile, 'vector', [note || `${VECTOR_STYLES[style].label} (SVG)`, { ...params, png: pngFile }], { source });
  return { file: pngFile, svg: svgFile, width: r.w, height: r.h, style, label: VECTOR_STYLES[style].label, stats: v.stats, check, ms: Date.now() - t0 };
}

/**
 * A clip as vector rotoscope: frames drawn at 8 a second (held for three at 24 fps), one SVG per drawing kept in
 * `framesDir`, the film encoded with the clip's own sound. At most MAX_VECTOR_SECONDS.
 */
export async function vectorVideo(inputPath, { style = 'cutout', detail = 1, framesDir, maxSeconds = MAX_VECTOR_SECONDS, onProgress = null, source = 'looks', note = '' } = {}) {
  const t0 = Date.now(), info = await probe(inputPath);
  const seconds = Math.min(info.seconds || maxSeconds, Math.max(1, Math.min(MAX_VECTOR_SECONDS, Number(maxSeconds) || MAX_VECTOR_SECONDS)));
  const workScale = Math.min(1, 640 / Math.max(info.w, info.h)), ww = even(info.w * workScale), wh = even(info.h * workScale);
  const outScale = Math.min(1280 / Math.max(info.w, info.h), 2), outW = even(info.w * outScale), outH = even(info.h * outScale);
  mkdirSync(framesDir, { recursive: true }); mkdirSync(VIDEO_DIR, { recursive: true });
  const file = stamp('mp4'), path = join(VIDEO_DIR, file);
  const dec = spawn('ffmpeg', ['-v', 'error', '-i', inputPath, '-t', String(seconds), '-vf', `fps=${DRAW_FPS},scale=${ww}:${wh}:flags=area`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
  const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${outW}x${outH}`, '-r', String(DRAW_FPS), '-i', 'pipe:0'];
  if (info.audio) args.push('-t', String(seconds), '-i', inputPath, '-map', '0:v', '-map', '1:a?', '-c:a', 'aac', '-b:a', '160k', '-shortest');
  args.push('-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', path);
  const enc = spawn('ffmpeg', args, { windowsHide: true });
  let encErr = '', decErr = '';
  enc.stderr.on('data', d => { encErr += d; }); dec.stderr.on('data', d => { decErr += d; });
  const encDone = new Promise((res, rej) => enc.on('close', code => (code === 0 ? res() : rej(new Error(`encoder exited ${code}: ${encErr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`)))));
  const frameBytes = ww * wh * 3, total = Math.max(1, Math.round(seconds * DRAW_FPS));
  let pending = Buffer.alloc(0), frames = 0, palette = null, firstCheck = null, svgBytes = 0;
  for await (const chunk of dec.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const raw = pending.subarray(0, frameBytes); pending = pending.subarray(frameBytes);
      const src = image(ww, wh, new Uint8ClampedArray(raw));
      const v = vectorize(src, { style, detail, palette, outW, outH, work: 640 });
      palette = v.palette;                                         // the first frame's palette for the whole clip
      const r = await renderSvg(v.svg);
      if (!firstCheck) {
        firstCheck = checkDrawing(src, r.img, v.stats, style);
        if (!firstCheck.ok) { dec.kill(); enc.stdin.destroy(); throw new Error(`the first frame failed its check: ${firstCheck.problems.join('; ')}`); }
      }
      frames++; svgBytes += v.svg.length;
      writeFileSync(join(framesDir, `${String(frames).padStart(5, '0')}.svg`), v.svg);
      if (!enc.stdin.write(r.rgba)) await new Promise(res => enc.stdin.once('drain', res));
      if (onProgress && frames % 4 === 0) onProgress(Math.min(0.99, frames / total), frames, total);
    }
  }
  await new Promise(r => (dec.exitCode != null ? r() : dec.on('close', r)));
  if (!frames) throw new Error(`no frames could be read from that clip${decErr ? `: ${decErr.trim().split('\n').pop().slice(0, 200)}` : ''}`);
  enc.stdin.end();
  await encDone;
  const params = { style, label: VECTOR_STYLES[style].label, detail, drawnPerSecond: DRAW_FPS, frames, seconds: +seconds.toFixed(2), from: basename(inputPath), svgFrames: framesDir, firstCheck };
  noteMedia(file, 'vector', [note || `${VECTOR_STYLES[style].label} rotoscope`, params], { source });
  return { file, path, seconds: +seconds.toFixed(2), frames, drawnPerSecond: DRAW_FPS, width: outW, height: outH, style, label: VECTOR_STYLES[style].label,
    framesDir, avgSvgBytes: Math.round(svgBytes / frames), firstCheck, ms: Date.now() - t0 };
}
