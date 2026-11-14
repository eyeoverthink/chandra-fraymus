/**
 * Looks: shared tools and routes for turning pictures and videos into a look, giving a still a camera move, and
 * generating new pictures in a look (style recipes). See filters.js (the looks), glyph-looks.js (ASCII, bricks),
 * convert.js (images, video, camera moves) and recipes.js (generation, the franchise-character guard).
 *
 * Jobs run one at a time from an in-memory queue (a 90 s video takes a few minutes on the CPU); finished files are
 * on the shelf with provenance, so a restart loses only the job record, never the work.
 */
import { readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { subjectMask, finishMask, alphaFromMask, morph, maskBox, fillHole, softMask, plateCheck, levelFromPicture, matteClarity, MIN_CLARITY, silhouetteScore, SILHOUETTE_MAX, boxHole, borderSpread, PLAIN_BORDER } from './layers.js';
import { VECTOR_STYLES, VECTOR_STYLE_NAMES } from './vector.js';
import { vectorImage, vectorVideo, MAX_VECTOR_SECONDS } from './vector-render.js';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../../config.js';
import { LOOKS, LOOK_NAMES, lookInfo, convertImage, convertVideo, animateStill, CAMERA_MOVE_NAMES, shelfFile, saveUpload, coverPng, measureMotion, shelveClip, MOTION_MIN, containPng, turntableVideo } from './convert.js';
import { parseGlb, normalize, renderMesh, pictureSampler, coverage } from './mesh3d.js';
import { image as rgbImage } from './filters.js';
import { RECIPES, RECIPE_NAMES, recipeFor, cleanSubject, recipePrompt, animeTagsMessages, checkTags, taggedPrompt, taggedNegative } from './recipes.js';
import { chatOllama } from '../../commerce/shared.js';

/** The subject as checked Danbooru-style tags for the anime checkpoint, or null (then the sentence is used). */
async function animeTags(subject) {
  try {
    const raw = await chatOllama(animeTagsMessages(subject), { format: 'json', temperature: 0.2, maxTokens: 400, priority: 'goal', label: 'looks:anime-tags', timeoutMs: 60_000 });
    return checkTags(raw);
  } catch (e) { console.error('[looks] anime tags:', e.message); return null; }
}
import { pickWorker, runOnWorker } from '../workers.js';
import { renderStillBatch } from '../studio.js';
import { noteMedia } from '../media-meta.js';

const sharp = createRequire(import.meta.url)('sharp');
const MEDIA_DIR = join(DATA_DIR, 'media');
const jobs = new Map();
let chain = Promise.resolve();
const clip = (s, n) => String(s ?? '').slice(0, n);
const isVideo = p => /\.(mp4|webm|mov|mkv)$/i.test(p);

function enqueue(kind, describe, work) {
  const id = `look-${randomUUID().slice(0, 8)}`;
  const job = { id, kind, describe, status: 'queued', stage: 'waiting', progress: 0, result: null, error: null, createdAt: Date.now() };
  jobs.set(id, job);
  while (jobs.size > 200) jobs.delete(jobs.keys().next().value);
  chain = chain.then(async () => {
    job.status = 'running'; job.stage = 'working';
    try { job.result = await work(job); job.status = 'done'; job.progress = 1; job.stage = 'done'; }
    catch (e) { job.status = 'error'; job.error = clip(e.message, 400); console.error(`[looks] ${kind}:`, e.message); }
  });
  return job;
}
export const lookJob = id => jobs.get(id) || null;

function inputPath({ file, dataBase64, ext }) {
  if (file) return shelfFile(file);
  if (dataBase64) return saveUpload(dataBase64, String(ext || 'png'));
  throw Object.assign(new Error('give a shelf file name (file) or an upload (dataBase64 + ext)'), { status: 400 });
}

/** Start a conversion of a shelf file (picture or video) into a look. */
export function startConvert({ file, dataBase64, ext, look, consent = false, realFace = false, maxSeconds, source = 'api' }) {
  if (!LOOKS[look]) throw Object.assign(new Error(`unknown look: ${look}. Looks: ${LOOK_NAMES.join(', ')}`), { status: 400 });
  const path = inputPath({ file, dataBase64, ext });
  return enqueue('convert', `${basename(path)} → ${LOOKS[look].label}`, job => isVideo(path)
    ? convertVideo(path, { look, consent, realFace, maxSeconds, source, onProgress: p => { job.progress = p; job.stage = `drawing frames (${Math.round(p * 100)}%)`; } })
    : convertImage(readFileSync(path), { look, consent, realFace, source }));
}

/** Start a camera move on a still (optionally in a look). */
export function startAnimate({ file, dataBase64, ext, move = 'push-in', seconds = 5, look = null, format = '16:9', consent = false, realFace = false, source = 'api' }) {
  if (!CAMERA_MOVE_NAMES.includes(move)) throw Object.assign(new Error(`unknown camera move: ${move}. Moves: ${CAMERA_MOVE_NAMES.join(', ')}`), { status: 400 });
  if (look && !LOOKS[look]) throw Object.assign(new Error(`unknown look: ${look}`), { status: 400 });
  const path = inputPath({ file, dataBase64, ext });
  if (isVideo(path)) throw Object.assign(new Error('a camera move is made from a still picture; to restyle a video use convert'), { status: 400 });
  return enqueue('animate', `${move} on ${basename(path)}${look ? ` in ${LOOKS[look].label}` : ''}`, () => animateStill(readFileSync(path), { move, seconds, look, format, consent, realFace, source }));
}

// Wan's working sizes (multiples of 32; the 5B model is trained at 1280×704): the same ones fraymus-video-studio uses
const MOTION_SIZES = { '16:9': [960, 544], '9:16': [544, 960], '1:1': [704, 704] };
// Wan pans and relights unless told not to: the worker's own negative plus camera and light changes. A prompt that asks
// for a camera move (pan, zoom, dolly, orbit, tracking…) keeps the camera free.
const WAN_NEGATIVE = 'static, still image, frozen, blurry, low quality, distorted, deformed, morphing, melting, extra limbs, duplicate, changing face, melting eyes, new features, text, letters, watermark, subtitles, colour shift, flicker, jpeg artifacts';
const HOLD_NEGATIVE = 'camera movement, camera pan, panning, tracking shot, dolly, zoom in, zoom out, camera rotation, handheld, changing light, lighting change, shadows moving across';
const asksCameraMove = text => /\b(pan(s|ning)?|zoom(s|ing)?|dolly|orbit(s|ing)?|tracking|crane|tilt(s|ing)?|camera (moves?|follows|flies|pushes|pulls))\b/i.test(text);
export function motionPrompts(prompt) {
  const free = asksCameraMove(prompt);
  return { prompt: free ? prompt : `${prompt} Static locked-off camera, steady lighting.`, negative: free ? WAN_NEGATIVE : `${WAN_NEGATIVE}, ${HOLD_NEGATIVE}`, camera: free ? 'free' : 'held' };
}
const AGENT_MOTION_PER_DAY = Math.max(0, parseInt(process.env.LOOKS_MOTION_AGENT_PER_DAY, 10) || 6);
const agentMotionAt = [];

/**
 * Bring a still to life: Wan 2.2 TI2V 5B on a worker's card (fraymus-home) animates what is in the picture, as the
 * prompt says. Only a worker that reports i2v ready can do it — this PC's 8 GB card cannot hold the 5B model — so
 * with none free the job fails and says why. A clip that barely moves is not put on the shelf (it cost minutes of
 * GPU time and shows a still). A look, if asked, is applied to the moving clip afterwards.
 */
export function startMotion({ file, dataBase64, ext, prompt, seconds = 2, format = '16:9', look = null, steps, seed, consent = false, realFace = false, source = 'api' }) {
  const what = String(prompt || '').trim();
  if (what.length < 3) throw Object.assign(new Error('say what should move in the picture (prompt)'), { status: 400 });
  if (look && !LOOKS[look]) throw Object.assign(new Error(`unknown look: ${look}`), { status: 400 });
  if (realFace && consent !== true) throw Object.assign(new Error("a real person's face is only animated with that person's consent: pass consent: true once they agreed"), { status: 422, code: 'consent_required' });
  if (source === 'agent') {
    const dayAgo = Date.now() - 86_400_000;
    while (agentMotionAt.length && agentMotionAt[0] < dayAgo) agentMotionAt.shift();
    if (agentMotionAt.length >= AGENT_MOTION_PER_DAY) throw Object.assign(new Error(`agents have started ${AGENT_MOTION_PER_DAY} motion clips in the last 24 hours (each holds fraymus-home's card for minutes); try again later or ask a person to start one`), { status: 429 });
    agentMotionAt.push(Date.now());
  }
  const path = inputPath({ file, dataBase64, ext });
  if (isVideo(path)) throw Object.assign(new Error('motion starts from a still picture; to restyle a video use convert'), { status: 400 });
  const secs = Math.max(1, Math.min(5, Number(seconds) || 2)), [w, h] = MOTION_SIZES[format] || MOTION_SIZES['16:9'];
  return enqueue('motion', `${basename(path)} comes alive: ${clip(what, 80)}`, async job => {
    const picked = await pickWorker('i2v');
    if (!picked.worker) throw new Error(`no machine can animate a still right now (${picked.why}); this PC's 8 GB card cannot hold Wan 2.2 5B`);
    job.stage = `${picked.worker.name}: sending the picture`;
    const start = await coverPng(readFileSync(path), w, h, { realFace, consent });
    const outDir = join(DATA_DIR, 'creations', job.id);
    const asked = motionPrompts(what);
    const r = await runOnWorker(picked.worker, { id: `${job.id}-i2v`, kind: 'i2v', spec: { prompt: asked.prompt, negative: asked.negative, seconds: secs, width: w, height: h, ...(steps ? { steps: Number(steps) } : {}), ...(Number.isInteger(seed) ? { seed } : {}) }, files: { 'start.png': start }, purpose: `motion: ${clip(what, 120)}` },
      { outDir, onProgress: (s, p) => { job.stage = `${picked.worker.name}: ${s}`; job.progress = Math.min(0.9, Number(p) || 0); }, timeoutMs: 2_400_000 });
    const out = r.outputs.find(o => o.name === 'clip.mp4');
    if (!out) throw new Error('the worker finished without a clip');
    job.stage = 'checking that it moves';
    const motion = await measureMotion(out.path);
    const detail = r.receipt.detail || {};
    if (motion.overall < MOTION_MIN) throw new Error(`the clip barely moves (difference ${motion.overall} of at least ${MOTION_MIN}); not put on the shelf. It is in ${outDir}`);
    const params = { engine: detail.engine || 'wan2.2-ti2v-5b', seconds: secs, frames: detail.frames, size: `${w}x${h}`, steps: detail.steps, seed: detail.seed, from: basename(path), paintedOn: picked.worker.name, motion: motion.overall, scene: motion.scene, drift: motion.drift, camera: asked.camera };
    const made = shelveClip(readFileSync(out.path), { op: 'motion', note: what, params, source: source === 'agent' ? 'agent' : 'looks' });
    let styled = null;
    if (look) { job.stage = `finishing in ${LOOKS[look].label}`; styled = await convertVideo(join(DATA_DIR, 'video', made), { look, source: 'looks', note: `${LOOKS[look].label}: ${what}` }); }
    return { file: styled?.file || made, motion: made, styled: styled?.file || null, look, seconds: +(detail.frames / 24).toFixed(2), frames: detail.frames, size: [w, h], seed: detail.seed, steps: detail.steps,
      generateSeconds: detail.generateSeconds, workerSeconds: r.seconds, paintedOn: picked.worker.name, movement: motion, camera: asked.camera, unloaded: detail.unloaded || [] };
  });
}

async function paint(items, purpose, job) {
  const picked = await pickWorker('stills');
  // an item may name a checkpoint (and the prompt that goes with it): used only when this worker has that file
  const has = new Set(picked.worker?.capabilities?.stills?.checkpoints || []);
  items = items.map(({ checkpoint, checkpointPrompt, checkpointNegative, ...it }) => (checkpoint && has.has(checkpoint)
    ? { ...it, checkpoint, prompt: checkpointPrompt || it.prompt, negative: checkpointNegative || it.negative } : it));
  if (picked.worker) {
    try {
      const r = await runOnWorker(picked.worker, { id: `${job.id}-stills`, kind: 'stills', spec: { items }, purpose }, { outDir: join(DATA_DIR, 'creations', job.id), onProgress: s => { job.stage = `${picked.worker.name}: ${s}`; }, timeoutMs: 1_800_000 });
      const detail = r.receipt.detail?.items || [];
      return items.map((it, i) => {
        const d = detail[i], o = d?.ok ? r.outputs.find(x => x.name === d.file) : null;
        if (!o) return { ok: false, error: d?.error || 'not painted' };
        const name = `${Date.now()}-${randomUUID().slice(0, 8)}.png`;
        copyFileSync(o.path, join(MEDIA_DIR, name));
        noteMedia(name, 'generate', [items[i].prompt, { seed: d.seed, width: d.width, height: d.height, steps: d.steps, model: d.checkpoint || 'sd_xl_base_1.0.safetensors', paintedOn: picked.worker.name }], { source: 'looks' });
        return { ok: true, path: join(MEDIA_DIR, name), paintedOn: picked.worker.name, checkpoint: d.checkpoint || null };
      });
    } catch (e) { console.error('[looks] worker paint:', e.message); job.stage = 'the worker could not paint; painting on this PC'; }
  }
  const batch = await renderStillBatch(items, { source: 'looks', purpose, onProgress: (i, n) => { job.stage = `painting ${i + 1} of ${n} on this PC`; } });
  return batch.results.map(r => (r.ok ? { ok: true, path: r.path, paintedOn: 'this PC' } : { ok: false, error: r.error }));
}

/**
 * A 3-D avatar: a picture (a shelf file, an upload, or one painted first from `prompt` as a full-body character on
 * white) → Hunyuan3D 2.0 on a worker's card → a .glb model on the shelf → a turntable film and a still, drawn by
 * mesh3d.js and restyled in any look (ascii, 8bit, 2bit, brick, woodblock…). The model has shape only; it is coloured
 * from the picture seen from the front (`colour: 'picture'`) or left as clay (`colour: 'clay'`).
 */
export function startAvatar({ file, dataBase64, ext, prompt, model = null, look = null, colour = 'picture', seconds = 6, format = '1:1', steps, seed, consent = false, realFace = false, source = 'api' }) {
  if (look && !LOOKS[look]) throw Object.assign(new Error(`unknown look: ${look}`), { status: 400 });
  if (realFace && consent !== true) throw Object.assign(new Error("a real person's face is only made into a 3-D model with that person's consent: pass consent: true once they agreed"), { status: 422, code: 'consent_required' });
  const words = String(prompt || '').trim();
  const path = file || dataBase64 ? inputPath({ file, dataBase64, ext }) : null;
  const modelPath = model ? shelfFile(model) : null;                         // an existing model: film it again, no GPU
  if (modelPath && !/\.glb$/i.test(modelPath)) throw Object.assign(new Error('model must be a .glb on the shelf'), { status: 400 });
  if (!path && !modelPath && words.length < 3) throw Object.assign(new Error('give a picture (file or upload), describe the character (prompt), or name a model (.glb) to film again'), { status: 400 });
  if (path && isVideo(path)) throw Object.assign(new Error('a 3-D model is made from a still picture'), { status: 400 });
  const { subject, replaced } = cleanSubject(words || 'a character');
  const job = enqueue('avatar', modelPath ? `turntable of ${basename(modelPath)}` : path ? `3-D model of ${basename(path)}` : `3-D model: ${clip(subject, 80)}`, async j => {
    if (modelPath) {
      j.stage = 'drawing the turntable';
      const mesh = normalize(parseGlb(readFileSync(modelPath)));
      let sampler = null;
      if (path && colour !== 'clay') { const pic = await sharp(await containPng(readFileSync(path), 768, { realFace, consent })).removeAlpha().raw().toBuffer({ resolveWithObject: true }); sampler = pictureSampler(rgbImage(pic.info.width, pic.info.height, new Uint8ClampedArray(pic.data)), mesh); }
      const draw = (yaw, w, h) => renderMesh(mesh, { w, h, yaw, colorFrom: sampler });
      const t = await turntableVideo(draw, { seconds, look, format, source: source === 'agent' ? 'agent' : 'looks', note: words || basename(modelPath), params: { model: basename(modelPath) } });
      return { model: basename(modelPath), film: t.file, still: t.still, look, triangles: mesh.triangles, colour: sampler ? 'picture' : 'clay', drawSeconds: +(t.ms / 1000).toFixed(1) };
    }
    let src = path, painted = null;
    if (!src) {
      j.stage = 'painting the character';
      const recipe = recipeFor(words), style = recipe ? recipePrompt(recipe, subject) : null;
      const pose = 'full body, standing, facing the viewer, arms slightly away from the body, centered, single character, plain white background, no shadow, no scenery';
      const r = (await paint([{ prompt: `${style ? style.prompt : subject}, ${pose}`, negative: `${style ? style.negative + ', ' : ''}background scenery, cropped, cut off, multiple characters, text`,
        width: 1024, height: 1024, steps: 28, seed: Math.floor(Math.random() * 2 ** 31),
        ...(style?.checkpoint ? { checkpoint: style.checkpoint, checkpointPrompt: `${style.checkpointPrompt}, ${pose}`, checkpointNegative: style.checkpointNegative, cfg: 5 } : {}) }], '3-D avatar source', j))[0];
      if (!r.ok) throw new Error(`could not paint the character: ${r.error}`);
      src = r.path; painted = basename(r.path);
    }
    const start = await containPng(readFileSync(src), 768, { realFace, consent });
    const picked = await pickWorker('mesh');
    if (!picked.worker) throw new Error(`no machine can make a 3-D model right now (${picked.why})`);
    const r = await runOnWorker(picked.worker, { id: `${j.id}-mesh`, kind: 'mesh', spec: { ...(steps ? { steps: Number(steps) } : {}), ...(Number.isInteger(seed) ? { seed } : {}) }, files: { 'start.png': start }, purpose: `avatar: ${clip(words || basename(src), 120)}` },
      { outDir: join(DATA_DIR, 'creations', j.id), onProgress: (s, p) => { j.stage = `${picked.worker.name}: ${s}`; j.progress = Math.min(0.7, (Number(p) || 0) * 0.7); }, timeoutMs: 2_400_000 });
    const glb = r.outputs.find(o => o.name === 'model.glb');
    if (!glb) throw new Error('the worker finished without a model');
    const buf = readFileSync(glb.path), mesh = normalize(parseGlb(buf));
    const modelFile = `${Date.now()}-${j.id.slice(5)}.glb`;
    writeFileSync(join(MEDIA_DIR, modelFile), buf);
    noteMedia(modelFile, 'mesh', [words || `3-D model of ${basename(src)}`, { engine: 'hunyuan3d-2.0', triangles: mesh.triangles, from: painted || basename(src), paintedOn: picked.worker.name, seed: r.receipt.detail?.seed }], { source: source === 'agent' ? 'agent' : 'looks' });
    j.stage = 'drawing the turntable';
    const pic = await sharp(start).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const sampler = colour === 'clay' ? null : pictureSampler(rgbImage(pic.info.width, pic.info.height, new Uint8ClampedArray(pic.data)), mesh);
    const draw = (yaw, w, h) => renderMesh(mesh, { w, h, yaw, colorFrom: sampler });
    const check = coverage(draw(Math.PI / 5, 320, 320));
    if (check < 0.02) throw new Error(`the model draws as almost nothing (${(check * 100).toFixed(1)} % of the frame); it is kept as ${modelFile}`);
    const t = await turntableVideo(draw, { seconds, look, format, source: source === 'agent' ? 'agent' : 'looks', note: words || basename(src), params: { model: modelFile } });
    return { model: modelFile, film: t.file, still: t.still, painted, look, triangles: mesh.triangles, coverage: +check.toFixed(3), colour,
      generateSeconds: r.receipt.detail?.generateSeconds, workerSeconds: r.seconds, drawSeconds: +(t.ms / 1000).toFixed(1), paintedOn: picked.worker.name, replacedCharacters: replaced };
  });
  job.notice = replaced.length ? `Franchise characters are not drawn: ${replaced.join(', ')} became an original character.` : null;
  return job;
}

/**
 * Scene → layers: a picture becomes (1) its subject on a transparent background, (2) the background with the subject
 * removed, and (3) a coarse tile level read from that background. From Nexus Engine's "scene abstractor" (see
 * docs/NEXUS-ENGINE-CREATION-METHODS.md), with Chandra's own tools and a check on each layer:
 *   matte  — U^2-Net on a worker's CPU (finds the subject in a full scene); without one, the colour fill in layers.js,
 *            which refuses a busy background instead of guessing
 *   plate  — the hole (subject, grown) is first filled from the colours around it, then repainted by SDXL on the
 *            worker's card (plate: 'paint'); the result is blended back so nothing outside the hole moves, and
 *            plateCheck() must see the hole changed and the rest unchanged
 *   level  — layers.levelFromPicture(plate)
 */
/**
 * Vector rotoscope: a picture or clip from the shelf traced into vector art (vector.js / vector-render.js) in one of
 * VECTOR_STYLES — ink, cutout, comic, neon. A picture gives an SVG and a PNG of it; a clip gives a film drawn at
 * 8 pictures a second with its own sound, and the SVG of every drawing in the job folder.
 */
export function startVector({ file, dataBase64, ext, style = 'cutout', detail = 1, maxSeconds, consent = false, realFace = false, source = 'api' }) {
  if (!VECTOR_STYLES[style]) throw Object.assign(new Error(`unknown vector style: ${style}. Styles: ${VECTOR_STYLE_NAMES.join(', ')}`), { status: 400 });
  if (realFace && consent !== true) throw Object.assign(new Error("a real person is only traced with that person's consent: pass consent: true once they agreed"), { status: 422, code: 'consent_required' });
  const path = inputPath({ file, dataBase64, ext });
  const det = Math.max(0.5, Math.min(2, Number(detail) || 1));
  const label = VECTOR_STYLES[style].label;
  return enqueue('vector', `${basename(path)} → ${label}`, job => (isVideo(path)
    ? vectorVideo(path, { style, detail: det, maxSeconds, framesDir: join(DATA_DIR, 'creations', job.id, 'frames'), source: source === 'agent' ? 'agent' : 'looks',
      onProgress: (p, n, t) => { job.progress = p; job.stage = `drawing ${n} of ${t}`; } })
    : vectorImage(readFileSync(path), { style, detail: det, source: source === 'agent' ? 'agent' : 'looks' })));
}

/**
 * The picture the inpaint worker gets: the prefilled colours with the hole as transparency (ComfyUI repaints where
 * alpha is 0), at the painting size. Colour and mask are resized apart and joined: resizing RGBA premultiplies, so
 * every transparent pixel's colour became black — the prefill never reached the model, which then repainted dark
 * slabs and silhouettes (found 2026-11-14).
 */
export async function inpaintInput(prefill, hole, pw, ph) {
  const { w: W, h: H } = prefill;
  const rgb = await sharp(Buffer.from(prefill.d.buffer, prefill.d.byteOffset, prefill.d.byteLength), { raw: { width: W, height: H, channels: 3 } }).resize(pw, ph, { fit: 'fill' }).raw().toBuffer();
  const a = await sharp(Buffer.from(Uint8Array.from(hole, v => (v ? 0 : 255))), { raw: { width: W, height: H, channels: 1 } }).resize(pw, ph, { fit: 'fill', kernel: 'nearest' }).extractChannel(0).raw().toBuffer();
  return sharp(rgb, { raw: { width: pw, height: ph, channels: 3 } }).joinChannel(a, { raw: { width: pw, height: ph, channels: 1 } }).png().toBuffer();
}

// denoise 0.9 by default: on the girl-and-tree scene 1.0 painted a darker, flatter trunk than 0.9 (2026-11-14, one seed each)
export function startLayers({ file, dataBase64, ext, point = null, context = '', plate = 'paint', denoise = 0.9, consent = false, realFace = false, source = 'api' }) {
  if (realFace && consent !== true) throw Object.assign(new Error("a real person is only cut out of a picture with that person's consent: pass consent: true once they agreed"), { status: 422, code: 'consent_required' });
  const path = inputPath({ file, dataBase64, ext });
  if (isVideo(path)) throw Object.assign(new Error('layers are made from a still picture'), { status: 400 });
  const pt = Array.isArray(point) && point.length === 2 && point.every(v => Number.isFinite(+v)) ? point.map(v => Math.max(0, Math.min(1, +v))) : null;
  return enqueue('layers', `layers of ${basename(path)}`, async job => {
    const { data, info } = await sharp(readFileSync(path)).rotate().removeAlpha().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, img = rgbImage(W, H, new Uint8ClampedArray(data));
    const outDir = join(DATA_DIR, 'creations', job.id);
    mkdirSync(outDir, { recursive: true });
    const rawPng = (buf, ch) => sharp(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), { raw: { width: W, height: H, channels: ch } }).png().toBuffer();
    const src = basename(path);

    // 1. the subject's matte
    let alpha = null, matteBy = null, matteNote = null, share = null;
    const mw = Math.max(8, Math.round(W * Math.min(1, 384 / Math.max(W, H)))), mh = Math.max(8, Math.round(H * Math.min(1, 384 / Math.max(W, H))));
    const picked = await pickWorker('matte');
    if (picked.worker) {
      job.stage = `${picked.worker.name}: finding the subject`;
      let soft = null;
      try {
        const r = await runOnWorker(picked.worker, { id: `${job.id}-matte`, kind: 'matte', spec: {}, files: { 'image.png': await rawPng(img.d, 3) }, purpose: `subject matte of ${src}` },
          { outDir, onProgress: s => { job.stage = `${picked.worker.name}: ${s}`; }, timeoutMs: 300_000 });
        const m = r.outputs.find(o => o.name === 'mask.png');
        if (!m) throw new Error('the worker sent no mask');
        // extractChannel(0): sharp returns 3 channels from a resized grey image unless told otherwise
        soft = await sharp(readFileSync(m.path)).greyscale().resize(W, H, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
        matteBy = `U^2-Net on ${picked.worker.name}`;
      } catch (e) { matteNote = `the worker could not make the matte (${clip(e.message, 160)}); the colour fill was used`; console.error('[looks] matte:', e.message); }
      if (soft) {
        const clarity = matteClarity(soft);
        if (clarity < MIN_CLARITY) throw new Error(`no clear subject in this picture: the matte is undecided over ${Math.round((1 - clarity) * 100)} % of it (a landscape or a pattern has nothing to cut out)`);
        const small = await sharp(soft, { raw: { width: W, height: H, channels: 1 } }).resize(mw, mh, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
        const fm = finishMask(Uint8Array.from(small, v => (v > 127 ? 1 : 0)), mw, mh, { point: pt });
        if (!fm.ok) throw new Error(`no clear subject in this picture: ${fm.reason}`);
        const keep = alphaFromMask(morph(fm.mask, mw, mh, 2), mw, mh, W, H, 1);
        alpha = new Uint8ClampedArray(W * H);
        for (let i = 0; i < alpha.length; i++) alpha[i] = Math.min(soft[i], keep[i]);
        share = fm.share;
      }
    } else matteNote = `no worker can make a matte (${picked.why}); the colour fill was used`;
    if (!alpha) {
      job.stage = 'finding the subject by colour';
      const sm = subjectMask(img, { point: pt });
      if (!sm.ok) throw new Error(`could not separate the subject: ${sm.reason}`);
      alpha = alphaFromMask(sm.mask, sm.w, sm.h, W, H);
      matteBy = 'colour fill (no model)'; share = sm.share;
    }

    // 2. the subject layer, cropped to its box with a small margin
    job.stage = 'cutting out the subject'; job.progress = 0.3;
    const solid = Uint8Array.from(alpha, v => (v > 127 ? 1 : 0)), box = maskBox(solid, W, H);
    if (!box) throw new Error('the matte is empty');
    const pad = Math.round(Math.max(W, H) * 0.02), cx = Math.max(0, box.x - pad), cy = Math.max(0, box.y - pad);
    const cw = Math.min(W - cx, box.w + 2 * pad), ch = Math.min(H - cy, box.h + 2 * pad);
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = img.d[i * 3]; rgba[i * 4 + 1] = img.d[i * 3 + 1]; rgba[i * 4 + 2] = img.d[i * 3 + 2]; rgba[i * 4 + 3] = alpha[i]; }
    const subjectFile = `${Date.now()}-${job.id.slice(5)}-subject.png`;
    writeFileSync(join(MEDIA_DIR, subjectFile), await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).extract({ left: cx, top: cy, width: cw, height: ch }).png().toBuffer());
    noteMedia(subjectFile, 'layers', [`subject of ${src}`, { role: 'subject', from: src, matte: matteBy, share, box: { x: cx, y: cy, w: cw, h: ch } }], { source: source === 'agent' ? 'agent' : 'looks' });

    // 3. the background plate: grow the hole past the subject's halo, fill it from around, repaint it on the card
    job.stage = 'filling the background'; job.progress = 0.45;
    const R = Math.max(3, Math.round(Math.max(W, H) * 0.012));
    const shaped = morph(Uint8Array.from(alpha, v => (v > 8 ? 1 : 0)), W, H, R);
    // a plain background (a studio, a flat colour) is already right when filled from around: painting one invented a
    // room with a door and a ceiling light behind the robot (2026-11-14), so the card is only used for a real scene
    const spread = borderSpread(img), plainBackground = spread <= PLAIN_BORDER;
    const painter = plate !== 'paint' ? { worker: null, why: 'plate: fill was asked for' }
      : plainBackground ? { worker: null, why: `the background is plain (border spread ${spread})` } : await pickWorker('inpaint');
    const prompt = `${clip(context, 300) ? `${clip(context, 300)}, ` : ''}empty background scenery, nobody in it, same style, same lighting, seamless`;
    // one plate for one hole: prefill from around, repaint on the worker if there is one, blend back, check
    const makePlate = async (hole, attempt) => {
      const prefill = fillHole(img, hole);
      let out = prefill, by = 'filled from the colours around the subject (no painting)';
      if (painter.worker) {
        const s = 1024 / Math.max(W, H), pw = Math.max(512, Math.round((W * s) / 64) * 64), ph = Math.max(512, Math.round((H * s) / 64) * 64);
        const sent = await inpaintInput(prefill, hole, pw, ph);
        job.stage = `${painter.worker.name}: repainting the background${attempt > 1 ? ' (second try, box-shaped hole)' : ''}`;
        const r = await runOnWorker(painter.worker, { id: `${job.id}-inpaint${attempt}`, kind: 'inpaint', spec: { prompt, denoise: Math.max(0.3, Math.min(1, Number(denoise) || 0.9)) }, files: { 'image.png': sent }, purpose: `background plate of ${src}` },
          { outDir, onProgress: st => { job.stage = `${painter.worker.name}: ${st}`; }, timeoutMs: 1_200_000 });
        const p = r.outputs.find(o => o.name === 'plate.png');
        if (!p) throw new Error('the worker sent no plate');
        const painted = await sharp(readFileSync(p.path)).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer();
        const blend = softMask(hole, W, H, R / 2);
        out = rgbImage(W, H);
        for (let i = 0; i < W * H; i++) { const t = hole[i] ? 1 : Math.min(1, blend[i] * 2); for (let c = 0; c < 3; c++) out.d[i * 3 + c] = t * painted[i * 3 + c] + (1 - t) * img.d[i * 3 + c]; }
        by = `repainted by SDXL on ${painter.worker.name}${attempt > 1 ? ' (box-shaped hole)' : ''}`;
      }
      const check = plateCheck(img, out, morph(hole, W, H, R), { w: W, h: H });   // the blend reaches about R past the hole
      const sil = silhouetteScore(out, solid, hole);
      check.silhouette = sil.score;
      if (check.ok && !sil.ok) { check.ok = false; check.reason = `a figure was painted back where the subject was (silhouette ${sil.score}, at most ${SILHOUETTE_MAX})`; }
      return { out, by, check };
    };
    let plateNote = painter.worker || plate !== 'paint' ? null : plainBackground ? `the background is plain (border spread ${spread}), so it is filled from the surrounding colours without painting` : `no worker can repaint (${painter.why}); the background is filled from the surrounding colours`;
    let made = await makePlate(shaped, 1);
    // a figure-shaped hole invites a figure: try once more with a box around the subject, which suggests none
    if (!made.check.ok && painter.worker && /figure was painted|flatter than its surroundings/.test(made.check.reason)) {
      writeFileSync(join(outDir, 'plate-refused-1.png'), await rawPng(made.out.d, 3));
      const first = made.check.reason;
      made = await makePlate(morph(boxHole(solid, W, H, 2 * R), W, H, 0), 2);
      plateNote = `first try refused: ${first}; a box-shaped hole was used`;
    }
    const { out: plateImg, by: plateBy, check } = made;
    const paintedOn = painter.worker?.name || null;
    if (!check.ok) {
      writeFileSync(join(outDir, 'plate-refused.png'), await rawPng(plateImg.d, 3));
      throw new Error(`the background plate failed its check: ${check.reason} (the subject layer ${subjectFile} was kept; the refused plate is in ${outDir})`);
    }
    const plateFile = `${Date.now()}-${job.id.slice(5)}-plate.png`;
    writeFileSync(join(MEDIA_DIR, plateFile), await rawPng(plateImg.d, 3));
    noteMedia(plateFile, 'layers', [`background of ${src} with the subject removed`, { role: 'plate', from: src, by: plateBy, check }], { source: source === 'agent' ? 'agent' : 'looks' });

    // 4. a coarse game level read from the plate
    job.stage = 'reading a level'; job.progress = 0.95;
    const level = levelFromPicture(plateImg);
    writeFileSync(join(outDir, 'level.json'), JSON.stringify({ from: src, plate: plateFile, ...level }, null, 1));
    return { from: src, subject: subjectFile, plate: plateFile, size: [W, H], matte: matteBy, matteNote, share, box: { x: cx, y: cy, w: cw, h: ch },
      plateBy, plateNote, paintedOn, plateCheck: check, level, folder: outDir };
  });
}

/** Generate new pictures in a look: subject cleaned of franchise characters, recipe prompt, paint, finish with the look's filter. */
export function startGenerate({ prompt, look = null, count = 1, format = '16:9', seed = null, source = 'api' }) {
  const recipe = look && RECIPES[look] ? look : recipeFor(prompt) || look;
  if (!recipe || !RECIPES[recipe]) throw Object.assign(new Error(`name a look for the picture. Looks: ${RECIPE_NAMES.join(', ')}`), { status: 400 });
  const { subject, replaced } = cleanSubject(prompt);
  const rp = recipePrompt(recipe, subject), { prompt: p, negative, post } = rp;
  const [width, height] = { '16:9': [1216, 704], '9:16': [704, 1216], '1:1': [1024, 1024] }[format] || [1216, 704];
  const n = Math.max(1, Math.min(4, Number(count) || 1));
  const alt = rp.checkpoint ? { checkpoint: rp.checkpoint, checkpointPrompt: rp.checkpointPrompt, checkpointNegative: rp.checkpointNegative, cfg: 5 } : {};
  // a given seed makes the first picture repeatable (the rest follow it), for comparing a change on the same noise
  const items = Array.from({ length: n }, (_, i) => ({ prompt: p, negative, width, height, steps: 26, seed: Number.isInteger(seed) ? seed + i : Math.floor(Math.random() * 2 ** 31), ...alt }));
  const job = enqueue('generate', `${n} × ${RECIPES[recipe].label}: ${clip(subject, 80)}`, async j => {
    let tagged = null;
    if (rp.checkpoint) {
      j.stage = 'writing the anime tags';
      tagged = await animeTags(subject);
      if (tagged) for (const it of items) { it.checkpointPrompt = taggedPrompt(recipe, tagged); it.checkpointNegative = taggedNegative(recipe, tagged); }
    }
    const painted = await paint(items, `${RECIPES[recipe].label} pictures`, j);
    const out = [];
    for (const r of painted) {
      if (!r.ok) { out.push({ ok: false, error: r.error }); continue; }
      const finish = r.checkpoint && r.checkpoint === rp.checkpoint ? rp.postWithCheckpoint : post;
      if (!finish) { out.push({ ok: true, file: basename(r.path), paintedOn: r.paintedOn, checkpoint: r.checkpoint }); continue; }
      j.stage = `finishing in ${LOOKS[finish].label}`;
      const f = await convertImage(readFileSync(r.path), { look: finish, source: 'looks', note: `${RECIPES[recipe].label}: ${subject}` });
      out.push({ ok: true, file: f.file, painted: basename(r.path), paintedOn: r.paintedOn, checkpoint: r.checkpoint });
    }
    return { recipe, label: RECIPES[recipe].label, subject, prompt: p, tags: tagged, replacedCharacters: replaced, pictures: out };
  });
  job.notice = replaced.length ? `Franchise characters are not drawn: ${replaced.join(', ')} became an original character in this look.` : null;
  return job;
}

const view = j => ({ id: j.id, kind: j.kind, what: j.describe, status: j.status, stage: j.stage, progress: +j.progress.toFixed(2), result: j.result, error: j.error, notice: j.notice || null });
const started = (j, what) => ({ ...view(j), replyToUser: `${what} — not finished yet. It is job ${j.id}; it appears on the shelf when done${j.notice ? `. ${j.notice}` : ''}.` });

export function createLooksTools() {
  const str = (maxLength, description, extra = {}) => ({ type: 'string', maxLength, description, ...extra });
  const lookEnum = { type: 'string', enum: [...LOOK_NAMES], description: 'The look' };
  return [
    { name: 'looks.list', group: 'looks', risk: 'safe',
      description: 'What looks Chandra can turn a picture or video into (comic hybrid, woodblock, brunaille, paper cutout, charcoal watercolour, rotoscope, painted 3D, gold ornament, low-poly ink, anime cel, ASCII, toy bricks, 8-bit, 2-bit), the style recipes it can generate new pictures in (pastoral anime, classic manga, retro robot anime, shonen action…), and the camera moves.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ looks: lookInfo(), recipes: RECIPE_NAMES.map(id => ({ id, label: RECIPES[id].label, finishedWith: RECIPES[id].post })), cameraMoves: CAMERA_MOVE_NAMES }) },
    { name: 'looks.convert', group: 'looks', risk: 'safe', ownsReply: true,
      description: "Turn a picture or video from Chandra's shelf into a look (comic hybrid, woodblock, ASCII, toy bricks, 8-bit…). Pass the shelf file name. A real person's face needs consent: true. Returns a job id; videos take minutes.",
      parameters: { type: 'object', properties: { file: str(160, 'Shelf file name', { minLength: 3 }), look: lookEnum, consent: { type: 'boolean', description: 'The person in it agreed' }, realFace: { type: 'boolean', description: 'It shows a real person' } }, required: ['file', 'look'], additionalProperties: false },
      execute: async ({ args }) => started(startConvert({ ...args, source: 'agent' }), `Turning ${args.file} into the ${LOOKS[args.look]?.label} look`) },
    { name: 'looks.animate', group: 'looks', risk: 'safe', ownsReply: true,
      description: `Give a still picture from the shelf a camera move (${CAMERA_MOVE_NAMES.join(', ')}), 2–20 s, optionally in a look. Returns a job id.`,
      parameters: { type: 'object', properties: { file: str(160, 'Shelf file name of a picture', { minLength: 3 }), move: { type: 'string', enum: [...CAMERA_MOVE_NAMES] }, seconds: { type: 'integer', minimum: 2, maximum: 20 }, look: lookEnum, format: { type: 'string', enum: ['16:9', '9:16', '1:1'] } }, required: ['file'], additionalProperties: false },
      execute: async ({ args }) => started(startAnimate({ ...args, source: 'agent' }), `Making a ${args.move || 'push-in'} move on ${args.file}`) },
    { name: 'looks.motion', group: 'looks', risk: 'safe', ownsReply: true,
      description: 'Bring a still picture from the shelf to life: Wan 2.2 animates what is in it (a character turns, water flows, hair moves) for 1–5 s, optionally finished in a look. Runs on fraymus-home\'s card and takes a few minutes. For a camera move over a still use looks.animate instead. A real person\'s face needs consent: true. Returns a job id.',
      parameters: { type: 'object', properties: { file: str(160, 'Shelf file name of a picture', { minLength: 3 }), prompt: str(600, 'What moves and how, in plain words', { minLength: 3 }), seconds: { type: 'integer', minimum: 1, maximum: 5 }, format: { type: 'string', enum: ['16:9', '9:16', '1:1'] }, look: lookEnum, consent: { type: 'boolean', description: 'The person in it agreed' }, realFace: { type: 'boolean', description: 'It shows a real person' } }, required: ['file', 'prompt'], additionalProperties: false },
      execute: async ({ args }) => started(startMotion({ ...args, source: 'agent' }), `Bringing ${args.file} to life`) },
    { name: 'looks.avatar', group: 'looks', risk: 'safe', ownsReply: true,
      description: 'Make a 3-D model (avatar) of a character: from a shelf picture, or from a description painted first as a full-body character. Hunyuan3D on fraymus-home makes the .glb; Chandra then films it turning around, optionally in a look (ascii, 8bit, 2bit, brick, woodblock, comic-hybrid…). A real person needs consent: true. Takes a few minutes. Returns a job id.',
      parameters: { type: 'object', properties: { file: str(160, 'Shelf file name of a picture of the character'), prompt: str(600, 'Or: describe the character'), model: str(160, 'Or: a .glb already on the shelf, to film again in another look (no GPU)'), look: lookEnum, colour: { type: 'string', enum: ['picture', 'clay'] }, seconds: { type: 'integer', minimum: 2, maximum: 12 }, format: { type: 'string', enum: ['16:9', '9:16', '1:1'] }, consent: { type: 'boolean', description: 'The person in it agreed' }, realFace: { type: 'boolean', description: 'It shows a real person' } }, additionalProperties: false },
      execute: async ({ args }) => started(startAvatar({ ...args, source: 'agent' }), 'Making a 3-D model') },
    { name: 'looks.generate', group: 'looks', risk: 'safe', ownsReply: true,
      description: 'Paint new pictures in a style recipe (pastoral hand-painted anime, classic 1960s manga, retro robot anime, 90s shonen action, comic hybrid, painted 3D, gold ornament, woodblock, brunaille, paper cutout, low-poly ink, charcoal watercolour, rotoscope, flat vector, toy bricks, 8-bit, 2-bit, ASCII). Pass the user\'s words; style names like "Miyazaki" or "Spider-Verse" pick the recipe. Franchise characters are never drawn — they become original characters. Returns a job id.',
      parameters: { type: 'object', properties: { prompt: str(600, "What to paint, in the user's words", { minLength: 3 }), look: { type: 'string', enum: [...RECIPE_NAMES], description: 'Recipe, if the words do not name one' }, count: { type: 'integer', minimum: 1, maximum: 4 }, format: { type: 'string', enum: ['16:9', '9:16', '1:1'] } }, required: ['prompt'], additionalProperties: false },
      execute: async ({ args }) => started(startGenerate({ ...args, source: 'agent' }), 'Painting') },
    { name: 'looks.layers', group: 'looks', risk: 'safe', ownsReply: true,
      description: 'Split a picture from the shelf into layers: the subject on a transparent background (a sprite or cutout), the background with the subject removed and repainted (a clean plate or game backdrop), and a coarse tile level read from that background. The subject is found by U^2-Net on fraymus-home, so a full scene works; with no worker only a plain background can be separated. `point` = [x, y] in 0-1 picks the subject when there are several. A real person needs consent: true. Returns a job id.',
      parameters: { type: 'object', properties: { file: str(160, 'Shelf file name of a picture', { minLength: 3 }), context: str(300, 'What the scene is, to guide the repainted background'),
        point: { type: 'array', items: { type: 'number' }, description: '[x, y] of the subject, each 0-1' }, plate: { type: 'string', enum: ['paint', 'fill'], description: 'paint (default) = repaint the hole on the card; fill = colours only' },
        consent: { type: 'boolean', description: 'The person in it agreed' }, realFace: { type: 'boolean', description: 'It shows a real person' } }, required: ['file'], additionalProperties: false },
      execute: async ({ args }) => started(startLayers({ ...args, source: 'agent' }), `Splitting ${args.file} into a subject, a background and a level`) },
    { name: 'looks.vector', group: 'looks', risk: 'safe', ownsReply: true,
      description: `Trace a picture or a video clip from the shelf into vector art (rotoscope): ${VECTOR_STYLE_NAMES.map(s => `${s} (${VECTOR_STYLES[s].about})`).join('; ')}. A picture gives an SVG you can scale or edit plus a PNG; a clip (at most ${MAX_VECTOR_SECONDS} s) gives a film drawn at 8 pictures a second with its own sound, and the SVG of every drawing. No model, runs on this PC. \`detail\` 0.5–2 (default 1: more = more lines). A real person needs consent: true. Returns a job id.`,
      parameters: { type: 'object', properties: { file: str(160, 'Shelf file name of a picture or a video', { minLength: 3 }), style: { type: 'string', enum: [...VECTOR_STYLE_NAMES] },
        detail: { type: 'number', minimum: 0.5, maximum: 2 }, maxSeconds: { type: 'integer', minimum: 1, maximum: MAX_VECTOR_SECONDS },
        consent: { type: 'boolean', description: 'The person in it agreed' }, realFace: { type: 'boolean', description: 'It shows a real person' } }, required: ['file'], additionalProperties: false },
      execute: async ({ args }) => started(startVector({ ...args, source: 'agent' }), `Tracing ${args.file} as ${VECTOR_STYLES[args.style || 'cutout']?.label || 'vector art'}`) },
    { name: 'looks.status', group: 'looks', risk: 'safe',
      description: 'Progress and result of a looks job (convert, animate, generate): status, stage and the files made.',
      parameters: { type: 'object', properties: { id: str(40, 'Job id', { minLength: 6 }) }, required: ['id'], additionalProperties: false },
      execute: async ({ args }) => { const j = lookJob(args.id); if (!j) throw new Error('no such looks job (jobs are kept until a restart)'); return view(j); } },
  ];
}

export function installLooksRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => (e.status ? res.status(e.status).json({ error: e.message, code: e.code }) : next(e)));
  app.get('/api/looks', route((_req, res) => res.json({ looks: lookInfo(), recipes: RECIPE_NAMES.map(id => ({ id, label: RECIPES[id].label, aliases: RECIPES[id].aliases, finishedWith: RECIPES[id].post })), cameraMoves: CAMERA_MOVE_NAMES, vectorStyles: VECTOR_STYLE_NAMES.map(id => ({ id, label: VECTOR_STYLES[id].label, about: VECTOR_STYLES[id].about })), jobs: [...jobs.values()].slice(-20).reverse().map(view) })));
  app.post('/api/looks/convert', route((req, res) => res.status(202).json(view(startConvert(req.body || {})))));
  app.post('/api/looks/animate', route((req, res) => res.status(202).json(view(startAnimate(req.body || {})))));
  app.post('/api/looks/avatar', route((req, res) => res.status(202).json(view(startAvatar(req.body || {})))));
  app.post('/api/looks/motion', route((req, res) => res.status(202).json(view(startMotion(req.body || {})))));
  app.post('/api/looks/vector', route((req, res) => res.status(202).json(view(startVector(req.body || {})))));
  app.post('/api/looks/layers', route((req, res) => res.status(202).json(view(startLayers(req.body || {})))));
  app.post('/api/looks/generate', route((req, res) => res.status(202).json({ ...view(startGenerate(req.body || {})) })));
  app.get('/api/looks/jobs/:id', route((req, res) => { const j = lookJob(req.params.id); if (!j) return res.status(404).json({ error: 'no such job' }); res.json(view(j)); }));
}
