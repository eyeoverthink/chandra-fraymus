/**
 * Creation — type what you want, get it on the shelf.
 *
 *   "a 40 second 8-bit short about a robot who finds a lighthouse"   → a finished 1080p video
 *   "a 2-bit still of a lighthouse in a storm"                        → a pixel-art PNG
 *
 * No category is chosen by the user. make-plan.js reads the sentence into a plan and records why
 * each choice was made; this module carries the plan out, one job at a time:
 *
 *   video  → a local model writes a two-character script (checked, retried with the reason, never
 *            invented by this code) → the script is rendered by fraymus-video-studio, run as a child
 *            process from its own checkout (VIDEO_STUDIO_DIR) → the master is copied to data/video with
 *            its provenance. The studio is used, not absorbed: nothing of it is copied into this repo.
 *   still  → a source picture (one already on the shelf, or one rendered by the local SDXL engine under
 *            the GPU lease) → pixel-art.js → data/media with its provenance.
 *
 * Voice: the studio's `http` voice backend is pointed at POST /api/studio/create/voice/<job>, which
 * speaks through Chandra's own TTS cascade and — because Chandra wrote the script and knows who says
 * each line — gives the two characters different voices.
 *
 * Every job is a row in creation_jobs; rows a dead process left open are closed at load and by the
 * transient sweeper. Agent-started jobs are deduplicated for 24 h and capped per day.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { DATA_DIR, PORT } from '../config.js';
import { publish } from '../fleet/bus.js';
import { chatOllama } from '../commerce/shared.js';
import { noteMedia } from './media-meta.js';
import { MEDIA_DIR } from './image-engine.js';
import { VIDEO_DIR } from './video-engine.js';
import { ttsSpeak } from './tts-engine.js';
import { renderStill } from './studio.js';
import { pixelateBuffer, STYLES } from './pixel-art.js';
import { planCreation, settleKind, describePlan, scriptMessages, normalizeScript, buildStudioMarkdown, speakerLines, normalizeLine, stillPrompt, extractJson, WIRED_STYLES } from './make-plan.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = join(HERE, 'pyshim');
const STUDIO_REPO = resolve(process.env.VIDEO_STUDIO_DIR || 'F:/Claude-Work/vaughn-systems/fraymus-video-studio');
const ENGINE_DIR = resolve(process.env.CHANDRA_STUDIO_DIR || 'F:/Chandra-Studio');
const CREATIONS_DIR = join(DATA_DIR, 'creations');
const RENDER_TIMEOUT_MS = Math.max(120_000, parseInt(process.env.CREATION_RENDER_TIMEOUT_MS, 10) || 2_400_000);
const MAX_QUEUED = 6;
const MAX_AGENT_JOBS_PER_DAY = Math.max(0, parseInt(process.env.CREATION_MAX_AGENT_JOBS_PER_DAY, 10) || 8);
const SCRIPT_ATTEMPTS = 3;
const VOICES = {
  hero: { voice: process.env.CREATION_VOICE_HERO || 'en-US-GuyNeural' },
  robot: { voice: process.env.CREATION_VOICE_ROBOT || 'en-GB-RyanNeural', pitch: process.env.CREATION_VOICE_ROBOT_PITCH || '-12Hz', rate: '-4%' },
};
// CREATION_TTS_ENGINE=sapi keeps the voice fully offline (Windows built-in); unset, the TTS cascade picks (edge-tts is an online Microsoft service)
const TTS_ENGINE = process.env.CREATION_TTS_ENGINE || null;
const now = () => Date.now();
const clip = (s, n) => String(s ?? '').slice(0, n);
const mediaName = ext => `${now()}-${randomBytes(4).toString('hex')}.${ext}`;

mkdirSync(CREATIONS_DIR, { recursive: true });

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS creation_jobs (
      id TEXT PRIMARY KEY, request TEXT NOT NULL, kind TEXT, style TEXT, status TEXT NOT NULL, stage TEXT, progress REAL DEFAULT 0,
      plan TEXT, script TEXT, title TEXT, output TEXT, error TEXT, source TEXT, agent_id TEXT,
      seconds REAL, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_creation_jobs_created ON creation_jobs(created_at);
  `);
  const closed = db.prepare(`UPDATE creation_jobs SET status = 'error', error = 'interrupted by restart', completed_at = ? WHERE status IN ('queued', 'running')`).run(now()).changes;
  if (closed) console.log(`[creation] closed ${closed} job(s) left open by a previous process`);
} catch (e) { console.error('[creation] table setup failed:', e.message); }

const emit = payload => { try { publish('studio', 'system.studio', JSON.stringify(payload)); } catch (e) { console.error('[creation] publish:', e.message); } };
const setJob = (id, fields) => {
  const keys = Object.keys(fields);
  try { db.prepare(`UPDATE creation_jobs SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => fields[k]), id); }
  catch (e) { console.error('[creation] update:', e.message); }
};
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
const rowOut = r => r && ({ id: r.id, request: r.request, kind: r.kind, style: r.style, status: r.status, stage: r.stage, progress: r.progress, title: r.title,
  plan: parse(r.plan), script: r.script, output: parse(r.output), error: r.error, source: r.source, seconds: r.seconds, createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at });

// ── the video studio: where it is and whether it can run here ────────────────────────────────────────

const PROBE = 'import importlib.util as u, json, sys; print(json.dumps(dict(v=sys.version.split()[0], **{m: u.find_spec(m) is not None for m in ["numpy","PIL","scipy","soundfile","piper","faster_whisper"]})))';
let readiness = null, readinessAt = 0;

async function probePython(py) {
  try {
    const { stdout } = await execFileAsync(py, ['-I', '-c', PROBE], { timeout: 30_000, windowsHide: true });
    return parse(stdout.trim().split('\n').pop());
  } catch (_) { return null; }
}

/** Find an interpreter that can run the studio's pixel recipes. Cached for five minutes. */
export async function studioReadiness({ force = false } = {}) {
  if (readiness && !force && now() - readinessAt < 300_000) return readiness;
  const problems = [];
  const present = existsSync(join(STUDIO_REPO, 'studio', '__main__.py'));
  if (!present) problems.push(`fraymus-video-studio not found at ${STUDIO_REPO} (set VIDEO_STUDIO_DIR)`);
  const candidates = [process.env.VIDEO_STUDIO_PYTHON, join(ENGINE_DIR, 'video-env', 'Scripts', 'python.exe'), join(ENGINE_DIR, 'comfyui-env', 'Scripts', 'python.exe'), 'python']
    .filter((p, i, a) => p && a.indexOf(p) === i && (p === 'python' || existsSync(p)));
  let python = null, modules = null;
  for (const c of candidates) {
    const m = await probePython(c);
    if (m && m.numpy && m.PIL && m.scipy) { python = c; modules = m; break; }
  }
  if (!python) problems.push('no Python with numpy, pillow and scipy was found (set VIDEO_STUDIO_PYTHON)');
  let ffmpeg = false;
  try { await execFileAsync('ffmpeg', ['-version'], { timeout: 15_000, windowsHide: true }); ffmpeg = true; } catch (_) { problems.push('ffmpeg is not on PATH'); }
  readiness = {
    ready: present && !!python && ffmpeg, problems, repo: STUDIO_REPO, python, pythonVersion: modules?.v || null, ffmpeg,
    soundfile: modules ? (modules.soundfile ? 'installed' : 'built-in WAV stand-in') : null,
    wordTiming: modules?.faster_whisper ? 'faster-whisper' : 'estimated from text length',
    workers: 1, // the studio's parallel renderer uses fork, which Windows does not have
  };
  readinessAt = now();
  return readiness;
}

// ── the model's two jobs ─────────────────────────────────────────────────────────────────────────────

async function decideKind(request) {
  try {
    const raw = await chatOllama([
      { role: 'system', content: 'Reply with JSON only: {"kind":"still"} or {"kind":"video"}. "still" means one picture. "video" means an animation or short film in which characters talk or something happens over time.' },
      { role: 'user', content: request },
    ], { format: 'json', priority: 'agent_run', temperature: 0, maxTokens: 30, timeoutMs: 90_000, label: 'creation:kind' });
    const k = extractJson(raw)?.kind;
    if (k === 'still' || k === 'video') return { kind: k, why: 'the model read the request that way' };
  } catch (e) { console.error('[creation] kind:', e.message); }
  return { kind: 'video', why: 'not stated and the model gave no answer — defaulted to video' };
}

async function writeScript(plan, onAttempt) {
  let feedback = null, lastError = null;
  const refusals = [];
  for (let attempt = 1; attempt <= SCRIPT_ATTEMPTS; attempt++) {
    onAttempt?.(attempt);
    let raw;
    try { raw = await chatOllama(scriptMessages(plan, feedback), { format: 'json', priority: 'agent_run', temperature: 0.8, maxTokens: 1500, timeoutMs: 240_000, label: 'creation:script' }); }
    catch (e) { lastError = e.message; refusals.push(`attempt ${attempt}: model call failed: ${clip(e.message, 120)}`); continue; }
    const s = normalizeScript(raw, plan, { final: attempt === SCRIPT_ATTEMPTS });
    if (s.ok) return { ...s, attempts: attempt, refusals, writtenBy: process.env.FRAYMUS_DEFAULT_MODEL || 'local model' };
    feedback = s.reason; lastError = s.reason; refusals.push(`attempt ${attempt}: ${s.reason}`);
  }
  throw new Error(`no usable script after ${SCRIPT_ATTEMPTS} attempts: ${clip(lastError, 200)}`);
}

// ── voice bridge ─────────────────────────────────────────────────────────────────────────────────────

const voiceJobs = new Map(); // job id → { lines: Map<text, speaker>, dir, n, engines:Set, voices:Set }

async function speakLine(jobId, text) {
  const v = voiceJobs.get(jobId);
  if (!v) throw Object.assign(new Error('no render is waiting for a voice under that id'), { status: 404 });
  const speaker = v.lines.get(normalizeLine(text)) || 'hero';
  const spoken = await ttsSpeak(text, TTS_ENGINE ? { ...VOICES[speaker], engine: TTS_ENGINE } : VOICES[speaker]);
  const wav = join(v.dir, `line-${String(++v.n).padStart(2, '0')}-${speaker}.wav`);
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', spoken.path, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wav], { timeout: 60_000, windowsHide: true });
  v.engines.add(spoken.engine || 'unknown'); if (spoken.voice) v.voices.add(`${speaker}: ${spoken.voice}`);
  return readFileSync(wav);
}

// ── running the studio ───────────────────────────────────────────────────────────────────────────────

let child = null, currentId = null;
process.once('exit', () => { try { child?.kill(); } catch (_) { /* process is ending */ } });

const STAGE_PROGRESS = { plan: 0.08, audio: 0.18, frames: 0.22, encode: 0.93 };

function renderWithStudio(id, plan, scriptPath, outDir, ready) {
  return new Promise((resolveP, reject) => {
    const args = ['-m', 'studio', 'render', scriptPath, '--recipe', plan.style, '-o', outDir, '--workers', '1', '--voice', plan.voice === 'silent' ? 'silent' : 'http', '--format', plan.format];
    // A short, explicit environment: the child needs a PATH for ffmpeg and nothing of the server's secrets.
    const env = { PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_PROXY: '127.0.0.1,localhost', STUDIO_TTS_URL: `http://127.0.0.1:${PORT}/api/studio/create/voice/${id}` };
    for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME']) if (process.env[k]) env[k] = process.env[k];
    if (ready.soundfile !== 'installed') env.PYTHONPATH = SHIM_DIR;
    const log = [];
    let stderrBuf = '';
    child = spawn(ready.python, args, { cwd: STUDIO_REPO, env, windowsHide: true });
    const timer = setTimeout(() => { log.push('[creation] render timed out'); try { child?.kill(); } catch (_) { /* already gone */ } }, RENDER_TIMEOUT_MS);
    child.stderr.on('data', d => {
      stderrBuf += d.toString();
      const lines = stderrBuf.split(/\r?\n/); stderrBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        log.push(line); if (log.length > 60) log.shift();
        const m = /^\[studio\] (\w+)(?: (\d+)%)?/.exec(line);
        if (m && m[1] in STAGE_PROGRESS) {
          const frac = m[1] === 'frames' ? 0.22 + 0.7 * ((Number(m[2]) || 0) / 100) : STAGE_PROGRESS[m[1]];
          setJob(id, { stage: m[1] === 'plan' ? 'voicing' : m[1] === 'frames' ? 'rendering' : m[1] === 'audio' ? 'mixing' : 'encoding', progress: +frac.toFixed(3) });
        }
      }
    });
    child.stdout.on('data', () => { /* the result is read from result.json */ });
    child.on('error', e => { clearTimeout(timer); child = null; reject(new Error(`could not start the studio: ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer); child = null;
      const result = parse(existsSync(join(outDir, 'result.json')) ? readFileSync(join(outDir, 'result.json'), 'utf8') : null);
      if (code === 0 && result?.ok) return resolveP({ result, log });
      reject(new Error(`the studio stopped (exit ${code}): ${clip(log.filter(l => !l.startsWith('[studio]')).slice(-4).join(' | ') || log.slice(-2).join(' | ') || 'no output', 500)}`));
    });
  });
}

async function makeVideo(id, plan, opts) {
  const ready = await studioReadiness();
  if (!ready.ready) throw new Error(`the video studio cannot run here: ${ready.problems.join('; ')}`);
  let script;
  if (Array.isArray(opts.scenes) && opts.scenes.length) {
    script = normalizeScript({ title: opts.title, scenes: opts.scenes }, plan, { final: true });
    if (!script.ok) throw new Error(`the supplied script was refused: ${script.reason}`);
    script.attempts = 0; script.writtenBy = 'supplied by the caller';
  } else {
    setJob(id, { stage: 'writing', progress: 0.02 });
    script = await writeScript(plan, attempt => setJob(id, { stage: attempt > 1 ? `writing (attempt ${attempt})` : 'writing' }));
  }
  const dir = join(CREATIONS_DIR, id), outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  const markdown = buildStudioMarkdown(plan, script);
  const scriptPath = join(dir, 'script.md');
  writeFileSync(scriptPath, markdown, 'utf8');
  setJob(id, { script: markdown, title: script.title, stage: 'voicing', progress: 0.05 });

  const voice = { lines: speakerLines(script), dir, n: 0, engines: new Set(), voices: new Set() };
  voiceJobs.set(id, voice);
  let done;
  try { done = await renderWithStudio(id, plan, scriptPath, outDir, ready); }
  finally { voiceJobs.delete(id); }

  const master = (done.result.files || []).find(f => /_master\.mp4$/i.test(f));
  if (!master || !existsSync(master)) throw new Error('the studio finished without a master video');
  const name = mediaName('mp4');
  copyFileSync(master, join(VIDEO_DIR, name));
  const voiced = plan.voice === 'silent' ? 'silent' : [...voice.engines].join('+') || 'none';
  noteMedia(name, 'create', [plan.request, { style: plan.style, palette: plan.palette, format: plan.format, seconds: done.result.duration_s, scenes: script.scenes.length, title: script.title, voice: voiced, job: id, renderer: 'fraymus-video-studio' }], { source: 'creation' });
  try { rmSync(join(outDir, 'work'), { recursive: true, force: true }); } catch (e) { console.error('[creation] cleanup:', e.message); }
  // Lineage: everything needed to say how this file came to be, and to make it again or change one line
  try {
    writeFileSync(join(dir, 'lineage.json'), JSON.stringify({ job: id, request: plan.request, plan, script: { title: script.title, scenes: script.scenes, writtenBy: script.writtenBy, attempts: script.attempts, refusals: script.refusals || [], fixes: script.fixes },
      voice: { engine: voiced, voices: [...voice.voices], offline: voiced === 'sapi' || voiced === 'piper' || voiced === 'silent' }, wordTiming: ready.wordTiming,
      renderer: { name: 'fraymus-video-studio', recipe: plan.style, repo: STUDIO_REPO, python: ready.pythonVersion, workers: 1, renderSeconds: done.result.render_s },
      output: { file: name, seconds: done.result.duration_s }, madeAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) { console.error('[creation] lineage:', e.message); }
  return {
    kind: 'video', file: name, url: `/api/hermes/artifacts/media?kind=video&id=${name}`, title: script.title, seconds: done.result.duration_s, renderSeconds: done.result.render_s,
    scenes: script.scenes.length, words: script.words, scriptAttempts: script.attempts, scriptRefusals: script.refusals || [], scriptBy: script.writtenBy, scriptFixes: script.fixes,
    voice: voiced, voices: [...voice.voices], wordTiming: ready.wordTiming, folder: dir, files: (done.result.files || []).map(f => basename(f)),
  };
}

async function makeStill(id, plan, opts) {
  let srcPath, from;
  if (opts.image) {
    const file = String(opts.image);
    if (!/^[\w.-]{1,120}\.(png|jpe?g|webp)$/i.test(file) || !existsSync(join(MEDIA_DIR, file))) throw new Error('image must be the file name of a picture already in data/media');
    srcPath = join(MEDIA_DIR, file); from = { source: 'shelf', file };
  } else {
    setJob(id, { stage: 'generating', progress: 0.1 });
    const [w, h] = plan.format === '9:16' ? [768, 1344] : plan.format === '1:1' ? [1024, 1024] : [1344, 768];
    const prompt = stillPrompt(plan);
    const still = await renderStill({ prompt, negative: 'photo, photograph, blurry, gradient, watermark, text, letters, deformed', width: w, height: h, steps: 24, source: 'creation' });
    srcPath = still.path; from = { source: 'sdxl', file: basename(still.path), prompt, seed: still.seed, seconds: still.seconds };
  }
  setJob(id, { stage: 'pixelating', progress: 0.9 });
  const px = await pixelateBuffer(readFileSync(srcPath), { style: plan.style, palette: plan.palette, format: plan.format });
  const name = mediaName('png');
  writeFileSync(join(MEDIA_DIR, name), px.png);
  noteMedia(name, 'pixelate', [plan.request, { style: plan.style, palette: px.palette, native: `${px.native.w}x${px.native.h}`, scale: px.scale, colours: px.colours, from: from.file, job: id }], { source: 'creation' });
  return { kind: 'still', file: name, url: `/api/hermes/artifacts/media?kind=image&id=${name}`, width: px.width, height: px.height, native: px.native, scale: px.scale, palette: px.palette, colours: px.colours, from };
}

// ── the queue ────────────────────────────────────────────────────────────────────────────────────────

let tail = Promise.resolve();
const cancelled = new Set();

async function runJob(id, opts) {
  const row = db.prepare(`SELECT * FROM creation_jobs WHERE id = ?`).get(id);
  if (!row || row.status !== 'queued') return;
  const t0 = now();
  currentId = id;
  setJob(id, { status: 'running', stage: 'planning', started_at: t0 });
  let plan = parse(row.plan);
  try {
    if (!plan.kind) { const k = await decideKind(plan.request); plan = settleKind(plan, k.kind, k.why); setJob(id, { plan: JSON.stringify(plan), kind: plan.kind }); }
    emit({ action: 'creation_started', id, kind: plan.kind, style: plan.style });
    const output = plan.kind === 'still' ? await makeStill(id, plan, opts) : await makeVideo(id, plan, opts);
    if (cancelled.has(id)) throw new Error('cancelled');
    const seconds = +((now() - t0) / 1000).toFixed(1);
    setJob(id, { status: 'completed', stage: 'done', progress: 1, output: JSON.stringify(output), seconds, completed_at: now() });
    emit({ action: 'creation_completed', id, kind: plan.kind, style: plan.style, file: output.file, seconds });
  } catch (e) {
    const wasCancelled = cancelled.has(id);
    setJob(id, { status: wasCancelled ? 'cancelled' : 'error', error: wasCancelled ? 'cancelled' : clip(e.code === 'gpu_unavailable' ? `the graphics card is in use: ${e.message}` : e.message, 600), seconds: +((now() - t0) / 1000).toFixed(1), completed_at: now() });
    emit({ action: wasCancelled ? 'creation_cancelled' : 'creation_failed', id, error: clip(e.message, 160) });
  } finally { currentId = null; cancelled.delete(id); }
}

/**
 * Accept a typed request. Returns at once; the work happens in the queue.
 * @returns {{ accepted: boolean, id?, status?, plan, summary, reason?, message? }}
 */
export async function createFromRequest({ request, kind, style, seconds, format, palette, voice, image, scenes, title, source = 'api', agentId = null } = {}) {
  const text = clip(request, 1500).replace(/\s+/g, ' ').trim();
  if (text.length < 3) throw Object.assign(new Error('request is required: say what to make'), { status: 400 });
  let plan = planCreation(text, { kind: image ? 'still' : kind, style, seconds, format, palette, voice });
  if (plan.blocked) return { accepted: false, reason: plan.blocked.reason, message: describePlan(plan), plan, summary: describePlan(plan) };
  if (plan.kind) plan = settleKind(plan, plan.kind);
  if (plan.kind !== 'still') {
    const ready = await studioReadiness();
    if (!ready.ready) return { accepted: false, reason: 'studio_not_ready', message: `The video studio cannot run here: ${ready.problems.join('; ')}`, plan, summary: describePlan(plan) };
  }
  const open = db.prepare(`SELECT id, status FROM creation_jobs WHERE request = ? AND style = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`).get(text, plan.style);
  if (open) return { accepted: true, duplicateOf: open.id, id: open.id, status: open.status, plan, summary: describePlan(plan), message: 'The same request is already being made.' };
  if (source === 'agent') {
    const recent = db.prepare(`SELECT id, status FROM creation_jobs WHERE request = ? AND style = ? AND status = 'completed' AND created_at > ? ORDER BY created_at DESC LIMIT 1`).get(text, plan.style, now() - 86_400_000);
    if (recent) return { accepted: true, duplicateOf: recent.id, id: recent.id, status: recent.status, plan, summary: describePlan(plan), message: 'This exact request was already made in the last 24 hours; see that job.' };
    const today = db.prepare(`SELECT COUNT(*) n FROM creation_jobs WHERE source = 'agent' AND created_at > ?`).get(now() - 86_400_000).n;
    if (today >= MAX_AGENT_JOBS_PER_DAY) return { accepted: false, reason: 'daily_cap', message: `Agents have started ${today} creations in 24 hours (cap ${MAX_AGENT_JOBS_PER_DAY}).`, plan, summary: describePlan(plan) };
  }
  const queued = db.prepare(`SELECT COUNT(*) n FROM creation_jobs WHERE status = 'queued'`).get().n;
  if (queued >= MAX_QUEUED) return { accepted: false, reason: 'queue_full', message: `${queued} creations are already waiting.`, plan, summary: describePlan(plan) };

  const id = `make-${randomUUID().slice(0, 10)}`;
  db.prepare(`INSERT INTO creation_jobs (id, request, kind, style, status, stage, plan, source, agent_id, created_at) VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?)`)
    .run(id, text, plan.kind, plan.style, JSON.stringify(plan), source, agentId, now());
  const opts = { image: image || null, scenes: Array.isArray(scenes) ? scenes.slice(0, 30) : null, title: title ? clip(title, 60) : null };
  tail = tail.then(() => runJob(id, opts)).catch(e => console.error('[creation] queue:', e.message));
  return { accepted: true, id, status: 'queued', plan, summary: describePlan(plan) };
}

export function getCreation(id) { return rowOut(db.prepare(`SELECT * FROM creation_jobs WHERE id = ?`).get(String(id))); }

export function listCreations(limit = 20) {
  return db.prepare(`SELECT * FROM creation_jobs ORDER BY created_at DESC LIMIT ?`).all(Math.min(100, Math.max(1, parseInt(limit, 10) || 20))).map(r => ({ ...rowOut(r), script: undefined }));
}

export function cancelCreation(id) {
  const row = db.prepare(`SELECT id, status FROM creation_jobs WHERE id = ?`).get(String(id));
  if (!row) return { cancelled: false, reason: 'not_found' };
  if (row.status === 'queued') { setJob(row.id, { status: 'cancelled', error: 'cancelled', completed_at: now() }); return { cancelled: true, was: 'queued' }; }
  if (row.status === 'running' && currentId === row.id) { cancelled.add(row.id); try { child?.kill(); } catch (e) { console.error('[creation] cancel:', e.message); } return { cancelled: true, was: 'running' }; }
  return { cancelled: false, reason: `job is ${row.status}` };
}

export async function creationStatus() {
  const ready = await studioReadiness();
  let counts = {}, timing = null;
  try {
    for (const r of db.prepare(`SELECT status, COUNT(*) n FROM creation_jobs GROUP BY status`).all()) counts[r.status] = r.n;
    timing = db.prepare(`SELECT kind, COUNT(*) n, ROUND(AVG(seconds), 1) avgSeconds FROM creation_jobs WHERE status = 'completed' GROUP BY kind`).all();
  } catch (e) { console.error('[creation] status:', e.message); }
  return {
    wired: { styles: WIRED_STYLES, kinds: ['video', 'still'], looks: STYLES, videoFormats: ['16:9'], stillFormats: ['16:9', '9:16', '1:1'] },
    studio: ready, voices: VOICES, ttsEngine: TTS_ENGINE || 'cascade (edge-tts online first, then offline SAPI)', running: currentId, counts, timing, agentCapPerDay: MAX_AGENT_JOBS_PER_DAY, jobs: listCreations(8),
  };
}

// ── fleet tools ──────────────────────────────────────────────────────────────────────────────────────

export function createMakeTools() {
  return [
    {
      name: 'studio.create', group: 'studio', risk: 'safe',
      description: 'Make a picture or a short film from a plain sentence — animation, 8-bit or 2-bit pixel art, retro game look, a still image, a movie, a short with dialogue. Pass the user\'s own words as `request`; the kind (still or video), look, length and shape are read from the sentence, so do not ask the user to choose a category. Runs on this machine, no paid service. Returns a job id at once; the finished file appears on the home screen shelf. Check progress with studio.create_status.',
      parameters: { type: 'object', required: ['request'], properties: {
        request: { type: 'string', description: 'what to make, in the user\'s words, e.g. "a 40 second 8-bit short about a robot who finds a lighthouse"' },
        kind: { type: 'string', description: 'optional: "still" or "video" (only if the user said so explicitly)' },
        style: { type: 'string', description: 'optional: "8bit" or "2bit"' },
        seconds: { type: 'integer', description: 'optional video length in seconds (8-180)' },
        image: { type: 'string', description: 'optional: file name of a picture already in data/media to turn into pixel art instead of generating one' },
      } },
      execute: async ({ args = {} } = {}, ctx = {}) => {
        try {
          const r = await createFromRequest({ request: args.request, kind: args.kind, style: args.style, seconds: args.seconds, image: args.image, source: 'agent', agentId: ctx?.agent?.id || ctx?.agentId || null });
          return r.accepted
            ? { accepted: true, jobId: r.id, status: r.status, willMake: r.summary, note: r.message || 'Queued. The file will appear on the shelf when it is finished; a video takes a few minutes. Tell the user what will be made and that it is in progress — do not claim it is finished.' }
            : { accepted: false, reason: r.reason, message: r.message };
        } catch (e) { return { error: clip(e.message, 300) }; }
      },
    },
    {
      name: 'studio.create_status', group: 'studio', risk: 'safe',
      description: 'Progress and result of creations started with studio.create: stage, percent, and the finished file. Pass `id` for one job, or nothing for the most recent few.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'job id returned by studio.create' } } },
      execute: async ({ args = {} } = {}) => {
        try {
          const brief = j => j && ({ id: j.id, request: clip(j.request, 140), kind: j.kind, style: j.style, status: j.status, stage: j.stage, percent: Math.round((j.progress || 0) * 100), title: j.title, error: j.error, output: j.output });
          if (args.id) { const j = getCreation(args.id); return j ? brief(j) : { error: 'no such job' }; }
          return { jobs: listCreations(5).map(brief) };
        } catch (e) { return { error: clip(e.message, 300) }; }
      },
    },
  ];
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────

export function installMakeRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/studio/create', route(async (req, res) => res.json(await creationStatus())));
  app.post('/api/studio/create/plan', route((req, res) => {
    const b = req.body || {};
    let plan = planCreation(b.request, { kind: b.kind, style: b.style, seconds: b.seconds, format: b.format, palette: b.palette, voice: b.voice });
    if (plan.kind && !plan.blocked) plan = settleKind(plan, plan.kind);
    res.json({ plan, summary: describePlan(plan) });
  }));
  app.post('/api/studio/create/voice/:id', route(async (req, res) => {
    const text = clip(req.body?.text, 2000).trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    try { const wav = await speakLine(req.params.id, text); res.type('audio/wav').send(wav); }
    catch (e) { res.status(e.status || 502).json({ error: clip(e.message, 300) }); }
  }));
  app.post('/api/studio/create', route(async (req, res) => {
    const b = req.body || {};
    try {
      const r = await createFromRequest({ request: b.request, kind: b.kind, style: b.style, seconds: b.seconds, format: b.format, palette: b.palette, voice: b.voice, image: b.image, scenes: b.scenes, title: b.title, source: 'api' });
      res.status(r.accepted ? 202 : r.reason === 'queue_full' ? 429 : 422).json(r);
    } catch (e) { if (e.status === 400) return res.status(400).json({ error: e.message }); throw e; }
  }));
  app.post('/api/studio/create/:id/cancel', route((req, res) => res.json(cancelCreation(req.params.id))));
  app.get('/api/studio/create/:id', route((req, res) => { const j = getCreation(req.params.id); if (!j) return res.status(404).json({ error: 'no such job' }); res.json(j); }));
}
