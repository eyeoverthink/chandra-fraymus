/**
 * Looks: shared tools and routes for turning pictures and videos into a look, giving a still a camera move, and
 * generating new pictures in a look (style recipes). See filters.js (the looks), glyph-looks.js (ASCII, bricks),
 * convert.js (images, video, camera moves) and recipes.js (generation, the franchise-character guard).
 *
 * Jobs run one at a time from an in-memory queue (a 90 s video takes a few minutes on the CPU); finished files are
 * on the shelf with provenance, so a restart loses only the job record, never the work.
 */
import { readFileSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../../config.js';
import { LOOKS, LOOK_NAMES, lookInfo, convertImage, convertVideo, animateStill, CAMERA_MOVE_NAMES, shelfFile, saveUpload, coverPng, measureMotion, shelveClip, MOTION_MIN } from './convert.js';
import { RECIPES, RECIPE_NAMES, recipeFor, cleanSubject, recipePrompt } from './recipes.js';
import { pickWorker, runOnWorker } from '../workers.js';
import { renderStillBatch } from '../studio.js';
import { noteMedia } from '../media-meta.js';

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
    const r = await runOnWorker(picked.worker, { id: `${job.id}-i2v`, kind: 'i2v', spec: { prompt: what, seconds: secs, width: w, height: h, ...(steps ? { steps: Number(steps) } : {}), ...(Number.isInteger(seed) ? { seed } : {}) }, files: { 'start.png': start }, purpose: `motion: ${clip(what, 120)}` },
      { outDir, onProgress: (s, p) => { job.stage = `${picked.worker.name}: ${s}`; job.progress = Math.min(0.9, Number(p) || 0); }, timeoutMs: 2_400_000 });
    const out = r.outputs.find(o => o.name === 'clip.mp4');
    if (!out) throw new Error('the worker finished without a clip');
    job.stage = 'checking that it moves';
    const motion = await measureMotion(out.path);
    const detail = r.receipt.detail || {};
    if (motion.overall < MOTION_MIN) throw new Error(`the clip barely moves (difference ${motion.overall} of at least ${MOTION_MIN}); not put on the shelf. It is in ${outDir}`);
    const params = { engine: detail.engine || 'wan2.2-ti2v-5b', seconds: secs, frames: detail.frames, size: `${w}x${h}`, steps: detail.steps, seed: detail.seed, from: basename(path), paintedOn: picked.worker.name, motion: motion.overall };
    const made = shelveClip(readFileSync(out.path), { op: 'motion', note: what, params, source: source === 'agent' ? 'agent' : 'looks' });
    let styled = null;
    if (look) { job.stage = `finishing in ${LOOKS[look].label}`; styled = await convertVideo(join(DATA_DIR, 'video', made), { look, source: 'looks', note: `${LOOKS[look].label}: ${what}` }); }
    return { file: styled?.file || made, motion: made, styled: styled?.file || null, look, seconds: +(detail.frames / 24).toFixed(2), frames: detail.frames, size: [w, h], seed: detail.seed, steps: detail.steps,
      generateSeconds: detail.generateSeconds, workerSeconds: r.seconds, paintedOn: picked.worker.name, movement: motion, unloaded: detail.unloaded || [] };
  });
}

async function paint(items, purpose, job) {
  const picked = await pickWorker('stills');
  if (picked.worker) {
    try {
      const r = await runOnWorker(picked.worker, { id: `${job.id}-stills`, kind: 'stills', spec: { items }, purpose }, { outDir: join(DATA_DIR, 'creations', job.id), onProgress: s => { job.stage = `${picked.worker.name}: ${s}`; }, timeoutMs: 1_800_000 });
      const detail = r.receipt.detail?.items || [];
      return items.map((it, i) => {
        const d = detail[i], o = d?.ok ? r.outputs.find(x => x.name === d.file) : null;
        if (!o) return { ok: false, error: d?.error || 'not painted' };
        const name = `${Date.now()}-${randomUUID().slice(0, 8)}.png`;
        copyFileSync(o.path, join(MEDIA_DIR, name));
        noteMedia(name, 'generate', [it.prompt, { seed: d.seed, width: d.width, height: d.height, steps: d.steps, model: 'sdxl-base-1.0', paintedOn: picked.worker.name }], { source: 'looks' });
        return { ok: true, path: join(MEDIA_DIR, name), paintedOn: picked.worker.name };
      });
    } catch (e) { console.error('[looks] worker paint:', e.message); job.stage = 'the worker could not paint; painting on this PC'; }
  }
  const batch = await renderStillBatch(items, { source: 'looks', purpose, onProgress: (i, n) => { job.stage = `painting ${i + 1} of ${n} on this PC`; } });
  return batch.results.map(r => (r.ok ? { ok: true, path: r.path, paintedOn: 'this PC' } : { ok: false, error: r.error }));
}

/** Generate new pictures in a look: subject cleaned of franchise characters, recipe prompt, paint, finish with the look's filter. */
export function startGenerate({ prompt, look = null, count = 1, format = '16:9', source = 'api' }) {
  const recipe = look && RECIPES[look] ? look : recipeFor(prompt) || look;
  if (!recipe || !RECIPES[recipe]) throw Object.assign(new Error(`name a look for the picture. Looks: ${RECIPE_NAMES.join(', ')}`), { status: 400 });
  const { subject, replaced } = cleanSubject(prompt);
  const { prompt: p, negative, post } = recipePrompt(recipe, subject);
  const [width, height] = { '16:9': [1216, 704], '9:16': [704, 1216], '1:1': [1024, 1024] }[format] || [1216, 704];
  const n = Math.max(1, Math.min(4, Number(count) || 1));
  const items = Array.from({ length: n }, () => ({ prompt: p, negative, width, height, steps: 26, seed: Math.floor(Math.random() * 2 ** 31) }));
  const job = enqueue('generate', `${n} × ${RECIPES[recipe].label}: ${clip(subject, 80)}`, async j => {
    const painted = await paint(items, `${RECIPES[recipe].label} pictures`, j);
    const out = [];
    for (const r of painted) {
      if (!r.ok) { out.push({ ok: false, error: r.error }); continue; }
      if (!post) { out.push({ ok: true, file: basename(r.path), paintedOn: r.paintedOn }); continue; }
      j.stage = `finishing in ${LOOKS[post].label}`;
      const f = await convertImage(readFileSync(r.path), { look: post, source: 'looks', note: `${RECIPES[recipe].label}: ${subject}` });
      out.push({ ok: true, file: f.file, painted: basename(r.path), paintedOn: r.paintedOn });
    }
    return { recipe, label: RECIPES[recipe].label, subject, prompt: p, replacedCharacters: replaced, pictures: out };
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
    { name: 'looks.generate', group: 'looks', risk: 'safe', ownsReply: true,
      description: 'Paint new pictures in a style recipe (pastoral hand-painted anime, classic 1960s manga, retro robot anime, 90s shonen action, comic hybrid, painted 3D, gold ornament, woodblock, brunaille, paper cutout, low-poly ink, charcoal watercolour, rotoscope, flat vector, toy bricks, 8-bit, 2-bit, ASCII). Pass the user\'s words; style names like "Miyazaki" or "Spider-Verse" pick the recipe. Franchise characters are never drawn — they become original characters. Returns a job id.',
      parameters: { type: 'object', properties: { prompt: str(600, "What to paint, in the user's words", { minLength: 3 }), look: { type: 'string', enum: [...RECIPE_NAMES], description: 'Recipe, if the words do not name one' }, count: { type: 'integer', minimum: 1, maximum: 4 }, format: { type: 'string', enum: ['16:9', '9:16', '1:1'] } }, required: ['prompt'], additionalProperties: false },
      execute: async ({ args }) => started(startGenerate({ ...args, source: 'agent' }), 'Painting') },
    { name: 'looks.status', group: 'looks', risk: 'safe',
      description: 'Progress and result of a looks job (convert, animate, generate): status, stage and the files made.',
      parameters: { type: 'object', properties: { id: str(40, 'Job id', { minLength: 6 }) }, required: ['id'], additionalProperties: false },
      execute: async ({ args }) => { const j = lookJob(args.id); if (!j) throw new Error('no such looks job (jobs are kept until a restart)'); return view(j); } },
  ];
}

export function installLooksRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => (e.status ? res.status(e.status).json({ error: e.message, code: e.code }) : next(e)));
  app.get('/api/looks', route((_req, res) => res.json({ looks: lookInfo(), recipes: RECIPE_NAMES.map(id => ({ id, label: RECIPES[id].label, aliases: RECIPES[id].aliases, finishedWith: RECIPES[id].post })), cameraMoves: CAMERA_MOVE_NAMES, jobs: [...jobs.values()].slice(-20).reverse().map(view) })));
  app.post('/api/looks/convert', route((req, res) => res.status(202).json(view(startConvert(req.body || {})))));
  app.post('/api/looks/animate', route((req, res) => res.status(202).json(view(startAnimate(req.body || {})))));
  app.post('/api/looks/motion', route((req, res) => res.status(202).json(view(startMotion(req.body || {})))));
  app.post('/api/looks/generate', route((req, res) => res.status(202).json({ ...view(startGenerate(req.body || {})) })));
  app.get('/api/looks/jobs/:id', route((req, res) => { const j = lookJob(req.params.id); if (!j) return res.status(404).json({ error: 'no such job' }); res.json(view(j)); }));
}
