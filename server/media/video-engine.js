import { mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { DATA_DIR } from '../config.js';

const execFileAsync = promisify(execFile);

const VIDEO_DIR = join(DATA_DIR, 'video');
mkdirSync(VIDEO_DIR, { recursive: true });

export { VIDEO_DIR };

function outName(ext = 'mp4') {
  return `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
}

function savePath(name) { return join(VIDEO_DIR, name); }

export function videoUrl(name) { return `/video/${name}`; }

export function listVideos(limit = 50) {
  try {
    return readdirSync(VIDEO_DIR)
      .filter(f => /\.(mp4|webm|mkv|gif|mp3|wav|aac|png|jpg)$/i.test(f))
      .sort((a, b) => statSync(join(VIDEO_DIR, b)).mtimeMs - statSync(join(VIDEO_DIR, a)).mtimeMs)
      .slice(0, Math.min(limit, 200))
      .map(f => {
        const s = statSync(join(VIDEO_DIR, f));
        return { name: f, size: s.size, url: videoUrl(f), modified: s.mtimeMs };
      });
  } catch { return []; }
}

async function runFF(bin, args, timeoutMs = 120_000) {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout, stderr };
}

function writeTempInput(buf, ext = '.mp4') {
  const name = `chandra-tmp-${randomBytes(6).toString('hex')}${ext}`;
  const p = join(tmpdir(), name);
  writeFileSync(p, buf);
  return p;
}

function cleanTemp(p) { try { unlinkSync(p); } catch { /* ok */ } }

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string' && input.startsWith('data:')) {
    const m = input.match(/^data:[^;]+;base64,(.+)$/s);
    if (m) return Buffer.from(m[1], 'base64');
  }
  if (typeof input === 'string') return Buffer.from(input, 'base64');
  throw new Error('Invalid video input — expected Buffer, Uint8Array, base64, or data URI');
}

// ── Video Info (ffprobe) ──────────────────────
export async function videoInfo(input) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  try {
    const { stdout } = await runFF('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', tmp,
    ]);
    const data = JSON.parse(stdout);
    const vs = data.streams?.find(s => s.codec_type === 'video');
    const as = data.streams?.find(s => s.codec_type === 'audio');
    return {
      duration: parseFloat(data.format?.duration) || 0,
      size: parseInt(data.format?.size) || buf.length,
      bitrate: parseInt(data.format?.bit_rate) || 0,
      format: data.format?.format_name,
      video: vs ? {
        codec: vs.codec_name, width: vs.width, height: vs.height,
        fps: vs.r_frame_rate, pixFmt: vs.pix_fmt,
      } : null,
      audio: as ? {
        codec: as.codec_name, sampleRate: parseInt(as.sample_rate),
        channels: as.channels,
      } : null,
      streams: data.streams?.length || 0,
    };
  } finally { cleanTemp(tmp); }
}

// ── Extract Thumbnail Frame ───────────────────
export async function videoThumbnail(input, opts = {}) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  const time = opts.time || '00:00:01';
  const name = outName('png');
  const out = savePath(name);
  try {
    await runFF('ffmpeg', [
      '-y', '-ss', String(time), '-i', tmp,
      '-frames:v', '1', '-q:v', '2', out,
    ]);
    const s = statSync(out);
    return { url: videoUrl(name), path: out, size: s.size, time };
  } finally { cleanTemp(tmp); }
}

// ── Trim Video ────────────────────────────────
export async function videoTrim(input, opts = {}) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  const ext = opts.format || 'mp4';
  const name = outName(ext);
  const out = savePath(name);
  const args = ['-y', '-i', tmp];
  if (opts.start) args.push('-ss', String(opts.start));
  if (opts.end) args.push('-to', String(opts.end));
  if (opts.duration) args.push('-t', String(opts.duration));
  args.push('-c', 'copy', '-movflags', '+faststart', out);
  try {
    await runFF('ffmpeg', args, 180_000);
    const s = statSync(out);
    return { url: videoUrl(name), path: out, size: s.size, format: ext };
  } finally { cleanTemp(tmp); }
}

// ── Resize Video ──────────────────────────────
export async function videoResize(input, opts = {}) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  const w = Math.min(opts.width || -2, 7680);
  const h = Math.min(opts.height || -2, 4320);
  const scale = `scale=${w}:${h}`;
  const ext = opts.format || 'mp4';
  const name = outName(ext);
  const out = savePath(name);
  try {
    await runFF('ffmpeg', [
      '-y', '-i', tmp, '-vf', scale,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'copy', '-movflags', '+faststart', out,
    ], 300_000);
    const s = statSync(out);
    return { url: videoUrl(name), path: out, size: s.size, width: w, height: h };
  } finally { cleanTemp(tmp); }
}

// ── Convert Format ────────────────────────────
export async function videoConvert(input, opts = {}) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  const ext = opts.format || 'webm';
  const name = outName(ext);
  const out = savePath(name);
  const args = ['-y', '-i', tmp];
  if (ext === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus');
  } else if (ext === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart');
  } else if (ext === 'mkv') {
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'copy');
  } else {
    args.push('-c', 'copy');
  }
  args.push(out);
  try {
    await runFF('ffmpeg', args, 300_000);
    const s = statSync(out);
    return { url: videoUrl(name), path: out, size: s.size, format: ext };
  } finally { cleanTemp(tmp); }
}

// ── Extract Audio ─────────────────────────────
export async function videoExtractAudio(input, opts = {}) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  const ext = opts.format || 'mp3';
  const name = outName(ext);
  const out = savePath(name);
  const args = ['-y', '-i', tmp, '-vn'];
  if (ext === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');
  else if (ext === 'wav') args.push('-c:a', 'pcm_s16le');
  else if (ext === 'aac') args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-c:a', 'copy');
  args.push(out);
  try {
    await runFF('ffmpeg', args, 120_000);
    const s = statSync(out);
    return { url: videoUrl(name), path: out, size: s.size, format: ext };
  } finally { cleanTemp(tmp); }
}

// ── Video to GIF ──────────────────────────────
export async function videoToGif(input, opts = {}) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  const width = opts.width || 480;
  const fps = opts.fps || 10;
  const name = outName('gif');
  const out = savePath(name);
  const args = ['-y', '-i', tmp];
  if (opts.start) args.push('-ss', String(opts.start));
  if (opts.duration) args.push('-t', String(opts.duration));
  else if (!opts.start) args.push('-t', '5');
  args.push(
    '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
    '-loop', '0', out,
  );
  try {
    await runFF('ffmpeg', args, 120_000);
    const s = statSync(out);
    return { url: videoUrl(name), path: out, size: s.size, width, fps };
  } finally { cleanTemp(tmp); }
}

// ── Concatenate Videos ────────────────────────
export async function videoConcat(inputs, opts = {}) {
  if (!Array.isArray(inputs) || inputs.length < 2) throw new Error('videoConcat requires at least 2 inputs');
  const tmpFiles = inputs.map((inp, i) => {
    const buf = toBuffer(inp);
    return writeTempInput(buf, `.${i}.mp4`);
  });
  const listContent = tmpFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
  const listFile = join(tmpdir(), `chandra-concat-${randomBytes(4).toString('hex')}.txt`);
  writeFileSync(listFile, listContent);
  const ext = opts.format || 'mp4';
  const name = outName(ext);
  const out = savePath(name);
  try {
    await runFF('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-movflags', '+faststart', out,
    ], 300_000);
    const s = statSync(out);
    return { url: videoUrl(name), path: out, size: s.size, inputCount: inputs.length };
  } finally {
    tmpFiles.forEach(cleanTemp);
    cleanTemp(listFile);
  }
}

// ── Overlay Text ──────────────────────────────
export async function videoOverlayText(input, text, opts = {}) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  const fontSize = opts.fontSize || 48;
  const color = opts.color || 'white';
  const x = opts.x || '(w-text_w)/2';
  const y = opts.y || 'h-th-40';
  const escapedText = text.replace(/'/g, "'\\''").replace(/:/g, '\\:');
  const ext = opts.format || 'mp4';
  const name = outName(ext);
  const out = savePath(name);
  try {
    await runFF('ffmpeg', [
      '-y', '-i', tmp,
      '-vf', `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${color}:x=${x}:y=${y}:borderw=2:bordercolor=black`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'copy', '-movflags', '+faststart', out,
    ], 300_000);
    const s = statSync(out);
    return { url: videoUrl(name), path: out, size: s.size, text };
  } finally { cleanTemp(tmp); }
}

// ── Extract Frames ────────────────────────────
export async function videoFrames(input, opts = {}) {
  const buf = toBuffer(input);
  const tmp = writeTempInput(buf);
  const count = Math.min(opts.count || 5, 30);
  const prefix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const pattern = join(VIDEO_DIR, `${prefix}-frame-%03d.png`);
  try {
    const info = await videoInfo(buf);
    const interval = info.duration / (count + 1);
    await runFF('ffmpeg', [
      '-y', '-i', tmp,
      '-vf', `fps=1/${Math.max(interval, 0.1)}`,
      '-frames:v', String(count), '-q:v', '2', pattern,
    ]);
    const frames = [];
    for (let i = 1; i <= count; i++) {
      const fname = `${prefix}-frame-${String(i).padStart(3, '0')}.png`;
      const fp = join(VIDEO_DIR, fname);
      try {
        const s = statSync(fp);
        frames.push({ url: videoUrl(fname), path: fp, size: s.size, frame: i });
      } catch { break; }
    }
    return { frames, count: frames.length };
  } finally { cleanTemp(tmp); }
}

// ── ffmpeg Status ─────────────────────────────
export async function ffmpegStatus() {
  try {
    const { stdout } = await runFF('ffmpeg', ['-version'], 5000);
    const ver = stdout.split('\n')[0] || 'unknown';
    return { available: true, version: ver.trim() };
  } catch (e) {
    return { available: false, error: e.message };
  }
}
