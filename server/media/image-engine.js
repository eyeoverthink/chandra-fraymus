import sharp from 'sharp';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from '../config.js';

const MEDIA_DIR = join(DATA_DIR, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

export { MEDIA_DIR };

function outName(ext = 'png') {
  return `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
}

function savePath(name) { return join(MEDIA_DIR, name); }

export function mediaUrl(name) { return `/media/${name}`; }

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string' && input.startsWith('data:')) {
    const m = input.match(/^data:[^;]+;base64,(.+)$/);
    if (m) return Buffer.from(m[1], 'base64');
  }
  if (typeof input === 'string') return Buffer.from(input, 'base64');
  throw new Error('Invalid image input — expected Buffer, Uint8Array, base64 string, or data URI');
}

// ── Image Info ─────────────────────────────────
export async function imageInfo(input) {
  const buf = toBuffer(input);
  const meta = await sharp(buf).metadata();
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha,
    space: meta.space,
    size: buf.length,
    density: meta.density,
  };
}

// ── Resize ─────────────────────────────────────
export async function imageResize(input, { width, height, fit = 'inside' } = {}) {
  const buf = toBuffer(input);
  const w = width ? Math.min(8192, Math.max(1, Number(width))) : undefined;
  const h = height ? Math.min(8192, Math.max(1, Number(height))) : undefined;
  if (!w && !h) throw new Error('width or height required');
  const result = await sharp(buf).resize(w, h, { fit }).png().toBuffer();
  const name = outName('png');
  await sharp(result).toFile(savePath(name));
  const meta = await sharp(result).metadata();
  return { url: mediaUrl(name), path: savePath(name), width: meta.width, height: meta.height, size: result.length };
}

// ── Crop ───────────────────────────────────────
export async function imageCrop(input, { left, top, width, height }) {
  const buf = toBuffer(input);
  const result = await sharp(buf)
    .extract({ left: Number(left), top: Number(top), width: Number(width), height: Number(height) })
    .png().toBuffer();
  const name = outName('png');
  await sharp(result).toFile(savePath(name));
  return { url: mediaUrl(name), path: savePath(name), width: Number(width), height: Number(height), size: result.length };
}

// ── Format Convert ─────────────────────────────
export async function imageConvert(input, { format = 'png', quality = 80 } = {}) {
  const buf = toBuffer(input);
  const q = Math.min(100, Math.max(1, Number(quality)));
  let pipeline = sharp(buf);
  const ext = format.toLowerCase();
  if (ext === 'jpeg' || ext === 'jpg') pipeline = pipeline.jpeg({ quality: q });
  else if (ext === 'webp') pipeline = pipeline.webp({ quality: q });
  else if (ext === 'avif') pipeline = pipeline.avif({ quality: q });
  else if (ext === 'tiff') pipeline = pipeline.tiff({ quality: q });
  else pipeline = pipeline.png();
  const result = await pipeline.toBuffer();
  const name = outName(ext === 'jpg' ? 'jpeg' : ext);
  await sharp(result).toFile(savePath(name));
  const meta = await sharp(result).metadata();
  return { url: mediaUrl(name), path: savePath(name), format: ext, width: meta.width, height: meta.height, size: result.length };
}

// ── Effects Chain ──────────────────────────────
export async function imageEffects(input, opts = {}) {
  const buf = toBuffer(input);
  let pipeline = sharp(buf);
  if (opts.rotate) pipeline = pipeline.rotate(Number(opts.rotate));
  if (opts.flip) pipeline = pipeline.flip();
  if (opts.flop) pipeline = pipeline.flop();
  if (opts.grayscale || opts.greyscale) pipeline = pipeline.grayscale();
  if (opts.negate) pipeline = pipeline.negate();
  if (opts.blur) pipeline = pipeline.blur(Math.max(0.3, Number(opts.blur)));
  if (opts.sharpen) pipeline = pipeline.sharpen(Number(opts.sharpen) || 1);
  if (opts.tint) pipeline = pipeline.tint(opts.tint);
  if (opts.gamma) pipeline = pipeline.gamma(Number(opts.gamma));
  if (opts.normalize || opts.normalise) pipeline = pipeline.normalize();
  const result = await pipeline.png().toBuffer();
  const name = outName('png');
  await sharp(result).toFile(savePath(name));
  const meta = await sharp(result).metadata();
  return { url: mediaUrl(name), path: savePath(name), width: meta.width, height: meta.height, size: result.length, effects: Object.keys(opts).filter(k => opts[k]) };
}

// ── Composite ──────────────────────────────────
export async function imageComposite(baseInput, overlays = []) {
  const baseBuf = toBuffer(baseInput);
  const compositeInputs = [];
  for (const ov of overlays) {
    const ovBuf = toBuffer(ov.input);
    compositeInputs.push({
      input: ovBuf,
      top: Number(ov.top || 0),
      left: Number(ov.left || 0),
      blend: ov.blend || 'over',
    });
  }
  const result = await sharp(baseBuf).composite(compositeInputs).png().toBuffer();
  const name = outName('png');
  await sharp(result).toFile(savePath(name));
  const meta = await sharp(result).metadata();
  return { url: mediaUrl(name), path: savePath(name), width: meta.width, height: meta.height, size: result.length, layers: overlays.length + 1 };
}

// ── Text Watermark (SVG overlay) ───────────────
export async function imageWatermark(input, text = 'CHANDRA', opts = {}) {
  const buf = toBuffer(input);
  const meta = await sharp(buf).metadata();
  const fontSize = opts.fontSize || Math.max(16, Math.round(meta.width / 20));
  const color = opts.color || 'rgba(255,255,255,0.35)';
  const position = opts.position || 'bottom-right';
  let x = meta.width - fontSize * text.length * 0.55 - 20;
  let y = meta.height - fontSize - 10;
  if (position === 'top-left') { x = 20; y = fontSize + 10; }
  else if (position === 'top-right') { y = fontSize + 10; }
  else if (position === 'bottom-left') { x = 20; }
  else if (position === 'center') { x = meta.width / 2 - fontSize * text.length * 0.275; y = meta.height / 2; }
  const svg = `<svg width="${meta.width}" height="${meta.height}">
    <text x="${Math.max(0, x)}" y="${Math.max(fontSize, y)}" font-size="${fontSize}" font-family="sans-serif" fill="${color}">${text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])}</text>
  </svg>`;
  const result = await sharp(buf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png().toBuffer();
  const name = outName('png');
  await sharp(result).toFile(savePath(name));
  return { url: mediaUrl(name), path: savePath(name), width: meta.width, height: meta.height, size: result.length, watermark: text };
}

// ── Thumbnail ──────────────────────────────────
export async function imageThumbnail(input, size = 256) {
  const s = Math.min(2048, Math.max(16, Number(size)));
  const buf = toBuffer(input);
  const result = await sharp(buf).resize(s, s, { fit: 'cover' }).png().toBuffer();
  const name = outName('png');
  await sharp(result).toFile(savePath(name));
  return { url: mediaUrl(name), path: savePath(name), width: s, height: s, size: result.length };
}

// ── Upscale (Lanczos) ──────────────────────────
export async function imageUpscale(input, scale = 2) {
  const s = Math.min(4, Math.max(1, Number(scale)));
  const buf = toBuffer(input);
  const meta = await sharp(buf).metadata();
  const newW = Math.min(8192, meta.width * s);
  const newH = Math.min(8192, meta.height * s);
  const result = await sharp(buf)
    .resize(newW, newH, { kernel: 'lanczos3' })
    .png().toBuffer();
  const name = outName('png');
  await sharp(result).toFile(savePath(name));
  return { url: mediaUrl(name), path: savePath(name), width: newW, height: newH, size: result.length, scale: s, method: 'lanczos3' };
}

// ── Create Blank Canvas ────────────────────────
export async function imageCreate({ width = 512, height = 512, color = '#000000' } = {}) {
  const w = Math.min(4096, Math.max(1, Number(width)));
  const h = Math.min(4096, Math.max(1, Number(height)));
  const result = await sharp({
    create: { width: w, height: h, channels: 4, background: color },
  }).png().toBuffer();
  const name = outName('png');
  await sharp(result).toFile(savePath(name));
  return { url: mediaUrl(name), path: savePath(name), width: w, height: h, size: result.length };
}

// ── List Outputs ───────────────────────────────
export function listMedia(limit = 50) {
  try {
    const files = readdirSync(MEDIA_DIR)
      .filter(f => /\.(png|jpe?g|webp|avif|tiff?)$/i.test(f))
      .map(f => {
        const st = statSync(join(MEDIA_DIR, f));
        return { name: f, url: mediaUrl(f), size: st.size, created: st.mtimeMs };
      })
      .sort((a, b) => b.created - a.created)
      .slice(0, Math.min(200, Math.max(1, limit)));
    return files;
  } catch { return []; }
}

// ── ComfyUI Bridge ─────────────────────────────
const COMFYUI_BASE = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';

export async function comfyuiStatus() {
  try {
    const res = await fetch(`${COMFYUI_BASE}/system_stats`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { available: true, ...data };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

export async function comfyuiGenerate(prompt, { width = 1024, height = 1024, steps = 4, cfg = 1, seed } = {}) {
  const s = seed ?? Math.floor(Math.random() * 2 ** 32);
  const workflow = {
    "3": {
      class_type: "KSampler",
      inputs: { seed: s, steps, cfg, sampler_name: "euler", scheduler: "simple", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-schnell.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: String(prompt).slice(0, 2000), clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "chandra", images: ["8", 0] } },
  };
  const res = await fetch(`${COMFYUI_BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ComfyUI error: HTTP ${res.status}`);
  const data = await res.json();
  return { promptId: data.prompt_id, seed: s, width, height, steps, cfg, status: 'queued' };
}

export async function comfyuiResult(promptId) {
  const res = await fetch(`${COMFYUI_BASE}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ComfyUI history error: HTTP ${res.status}`);
  const data = await res.json();
  const entry = data[promptId];
  if (!entry) return { status: 'pending' };
  if (entry.status?.status_str === 'error') return { status: 'error', error: entry.status.messages };
  const outputs = entry.outputs || {};
  const images = [];
  for (const nodeOut of Object.values(outputs)) {
    if (nodeOut.images) {
      for (const img of nodeOut.images) {
        images.push({ filename: img.filename, subfolder: img.subfolder, type: img.type });
      }
    }
  }
  return { status: images.length ? 'complete' : 'processing', images };
}

export async function comfyuiFetchImage(filename, subfolder = '') {
  const url = `${COMFYUI_BASE}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ComfyUI fetch error: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const name = outName('png');
  await sharp(buf).png().toFile(savePath(name));
  const meta = await sharp(buf).metadata();
  return { url: mediaUrl(name), path: savePath(name), width: meta.width, height: meta.height, size: buf.length };
}
