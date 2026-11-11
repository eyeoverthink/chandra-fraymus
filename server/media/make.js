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
import { join, resolve, dirname, basename, delimiter, extname } from 'node:path';
import sharp from 'sharp';
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
import { renderStill, renderStillBatch } from './studio.js';
import { classifyUrl } from '../fraymus-os/registry.js';
import { buildPage } from './page-builder.js';
import { pickWorker, runOnWorker, workersStatus, workersConfigured, installWorkerRoutes } from './workers.js';
import { pixelateBuffer, STYLES } from './pixel-art.js';
import { forgeCast, spritePixels } from './sprite-forge.js';
import { planCreation, settleKind, describePlan, scriptMessages, normalizeScript, buildStudioMarkdown, speakerLines, normalizeLine, stillPrompt, backdropPrompt, backdropNegative, conditionsOf, subjectOf, PACES, bestDraft, extractJson, WIRED_STYLES, PIXEL_STYLES, RECIPES } from './make-plan.js';
import { scriptMessagesFor, normalizeFor, buildMarkdownFor, paintsBackdrops, forgePeople } from './make-looks.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = join(HERE, 'pyshim');
const LAUNCHER = join(HERE, 'pystudio', 'chandra_studio.py');   // runs the studio with this film's forged cast
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
// VoiceStudio (OpenAI-style /v1/audio/speech) holds Vaughn's cloned voices. Used for film lines when it is configured, not on a public host and answering.
// CREATION_VOICE_ENGINE=cascade opts out. Only the voices the home screen allows are used; nothing else is ever labelled as his voice.
const VOICESTUDIO = classifyUrl(process.env.FRAYMUS_VOICESTUDIO_URL || '');
const VS_ALLOWED = new Set(['vaughn-one', 'overlord']);
const vsVoice = (v, d) => (VS_ALLOWED.has(v) ? v : d);
const VS_VOICES = { hero: vsVoice(process.env.CREATION_VS_VOICE_HERO || process.env.FRAYMUS_VOICE_ID, 'vaughn-one'), robot: vsVoice(process.env.CREATION_VS_VOICE_ROBOT, 'overlord') };
const VS_LINE_TIMEOUT_MS = 240_000;
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

/**
 * Who writes the script. CREATION_WRITERS="model@http://host:11434,…" lists Ollama servers on the private
 * network, best first (measured 2026-11-10: qwen3:14b on the RTX 5070 wrote a usable script first time in
 * 4–14 s; the local 8B model took 16–126 s and half the length). The local model is always the last resort.
 * A writer whose call fails is skipped for this film; a writer that answers gets all three attempts.
 */
const WRITERS = (process.env.CREATION_WRITERS || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
  const i = x.lastIndexOf('@'); const c = classifyUrl(i > 0 ? x.slice(i + 1) : '');
  return i > 0 && c.url && c.routeClass !== 'public' ? { model: x.slice(0, i), url: c.url, label: `${x.slice(0, i)} on ${c.host}` } : null;
}).filter(Boolean);
const LOCAL_WRITER = { model: null, url: null, label: `${process.env.FRAYMUS_DEFAULT_MODEL || 'the local model'} on this PC` };
const WRITER_TIMEOUT_MS = 180_000;

async function askWriter(w, messages) {
  if (!w.url) return chatOllama(messages, { format: 'json', priority: 'agent_run', temperature: 0.8, maxTokens: 1500, timeoutMs: 240_000, label: 'creation:script' });
  const send = think => fetch(`${w.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(WRITER_TIMEOUT_MS),
    body: JSON.stringify({ model: w.model, messages, stream: false, format: 'json', ...(think ? {} : { think: false }), options: { temperature: 0.8, num_predict: 1500 } }) });
  let r = await send(false);
  if (r.status === 400) r = await send(true);               // a model without a thinking switch refuses the flag
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.message?.content || '';
}

async function writeScript(plan, onAttempt) {
  const refusals = [];
  let lastError = null;
  for (const w of [...WRITERS, LOCAL_WRITER]) {
    let feedback = null;
    const drafts = [];      // earlier replies refused only for their length: one of them may beat the last attempt
    for (let attempt = 1; attempt <= SCRIPT_ATTEMPTS; attempt++) {
      onAttempt?.(attempt, w.label);
      let raw;
      try { raw = await askWriter(w, scriptMessagesFor(plan, feedback)); }
      catch (e) { lastError = e.message; refusals.push(`${w.label}: call failed: ${clip(e.message, 120)}`); if (w.url || attempt >= 2) break; continue; }
      const s = normalizeFor(raw, plan, { final: attempt === SCRIPT_ATTEMPTS });
      if (s.ok) {
        const offLength = (s.fixes || []).some(f => /shorter than asked|cut lines/.test(f));
        const best = offLength && plan.seconds ? bestDraft([...drafts, { script: s, reason: null, attempt }], plan.seconds) : null;
        if (best && best.script !== s) return { ...best.script, fixes: [...(best.script.fixes || []), `attempt ${best.attempt} of ${attempt} kept: it was the closest to the asked length`], attempts: refusals.length + 1, refusals, writtenBy: w.label };
        return { ...s, attempts: refusals.length + 1, refusals, writtenBy: w.label };
      }
      if (/too short|too long/.test(s.reason || '')) { const kept = normalizeFor(raw, plan, { final: true }); if (kept.ok) drafts.push({ script: kept, reason: s.reason, attempt }); }
      feedback = s.reason; lastError = s.reason; refusals.push(`${w.label}, attempt ${attempt}: ${s.reason}`);
    }
  }
  throw new Error(`no usable script after ${refusals.length} attempts: ${clip(lastError, 200)}`);
}

// ── voice bridge ─────────────────────────────────────────────────────────────────────────────────────

const voiceJobs = new Map(); // job id → { lines: Map<text, speaker>, dir, n, engines:Set, voices:Set }

/** Decide once per film which engine speaks, so a film never changes voice half way through. */
async function pickVoiceEngine() {
  if (TTS_ENGINE || process.env.CREATION_VOICE_ENGINE === 'cascade') return { engine: 'cascade', why: 'set by configuration' };
  if (!VOICESTUDIO.url) return { engine: 'cascade', why: 'VoiceStudio is not configured' };
  if (VOICESTUDIO.routeClass === 'public') return { engine: 'cascade', why: 'VoiceStudio is on a public host; not used' };
  try {
    const r = await fetch(`${VOICESTUDIO.url}/health`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { engine: 'cascade', why: `VoiceStudio answered HTTP ${r.status}` };
    const h = await r.json().catch(() => ({}));
    return { engine: 'voicestudio', why: 'VoiceStudio is running', device: h.device || null, version: h.version || null };
  } catch (e) { return { engine: 'cascade', why: `VoiceStudio is not answering (${clip(e.message, 60)})` }; }
}

async function speakWithVoiceStudio(text, voice) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`${VOICESTUDIO.url}/v1/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'wav' }), signal: AbortSignal.timeout(VS_LINE_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 2000) throw new Error(`only ${buf.length} bytes of audio`);
      return { buf, ext: (r.headers.get('content-type') || '').includes('mpeg') ? 'mp3' : 'wav' };
    } catch (e) { lastError = e; }
  }
  // No substitute voice: a film that started in the owner's voice does not finish in another one.
  throw Object.assign(new Error(`VoiceStudio could not speak a line as ${voice}: ${clip(lastError?.message, 120)}`), { status: 502 });
}

async function speakLine(jobId, text) {
  const v = voiceJobs.get(jobId);
  if (!v) throw Object.assign(new Error('no render is waiting for a voice under that id'), { status: 404 });
  const speaker = v.lines.get(normalizeLine(text)) || v.names[0];
  const role = speaker === v.names[1] ? 'robot' : 'hero';   // voice slot: first cast member, second cast member
  if (v.engine === 'voicestudio') {
    const voice = VS_VOICES[role];
    const t0 = now();
    const { buf, ext } = await speakWithVoiceStudio(text, voice);
    const raw = join(v.dir, `line-${String(++v.n).padStart(2, '0')}-${speaker}.src.${ext}`), wavOut = raw.replace(/\.src\.\w+$/, '.wav');
    writeFileSync(raw, buf);
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wavOut], { timeout: 60_000, windowsHide: true });
    try { rmSync(raw, { force: true }); } catch (_) { /* the converted copy is what matters */ }
    v.engines.add('voicestudio'); v.voices.add(`${speaker}: ${voice}`); v.seconds += (now() - t0) / 1000;
    return readFileSync(wavOut);
  }
  const spoken = await ttsSpeak(text, TTS_ENGINE ? { ...VOICES[role], engine: TTS_ENGINE } : VOICES[role]);
  const wav = join(v.dir, `line-${String(++v.n).padStart(2, '0')}-${speaker}.wav`);
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', spoken.path, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wav], { timeout: 60_000, windowsHide: true });
  v.engines.add(spoken.engine || 'unknown'); if (spoken.voice) v.voices.add(`${speaker}: ${spoken.voice}`);
  return readFileSync(wav);
}

// ── running the studio ───────────────────────────────────────────────────────────────────────────────

let child = null, currentId = null;
process.once('exit', () => { try { child?.kill(); } catch (_) { /* process is ending */ } });

const STAGE_PROGRESS = { plan: 0.08, audio: 0.18, frames: 0.22, encode: 0.93 };

function renderWithStudio(id, plan, scriptPath, outDir, ready, spritesPath = null, pagesOnly = false) {
  return new Promise((resolveP, reject) => {
    const args = [LAUNCHER, 'render', scriptPath, ...(pagesOnly ? ['--set', 'video=false'] : []), '--recipe', RECIPES[plan.style], '-o', outDir, '--workers', '1', '--voice', plan.voice === 'silent' || pagesOnly ? 'silent' : 'http', '--format', plan.format];
    // A short, explicit environment: the child needs a PATH for ffmpeg and nothing of the server's secrets.
    const env = { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', NO_PROXY: '127.0.0.1,localhost', STUDIO_TTS_URL: `http://127.0.0.1:${PORT}/api/studio/create/voice/${id}` };
    for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME']) if (process.env[k]) env[k] = process.env[k];
    env.PYTHONPATH = ready.soundfile !== 'installed' ? [STUDIO_REPO, SHIM_DIR].join(delimiter) : STUDIO_REPO;
    if (spritesPath) env.CHANDRA_SPRITES = spritesPath;
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

/**
 * Paint one backdrop per place the script names (or one for the whole film from the request), all under a
 * single GPU lease. Never fails the job: without the card or the image model the film keeps the recipe's
 * built-in landscape and the result says why.
 */
async function paintBackdrops(id, plan, script) {
  if (!paintsBackdrops(plan)) return { files: [], info: { asked: 0, made: 0, note: plan.style === 'cartoon' ? 'the cartoon look draws its own sets' : 'not asked for' } };
  const looks = script.places?.length ? script.places : [subjectOf(plan)];
  const from = script.places?.length ? 'the script' : 'the request (the script named no place)';
  setJob(id, { stage: 'painting backdrops', progress: 0.04 });
  const conditions = looks.map(look => { const c = conditionsOf(plan, look); return { shown: c.words, fromRequest: c.fromRequest }; });
  const items = looks.map(look => ({ prompt: backdropPrompt(plan, look), negative: backdropNegative(plan, look), width: 1024, height: 576, steps: 22, seed: Math.floor(Math.random() * 2 ** 31) }));
  let workerNote = null;
  const picked = await pickWorker('stills');
  if (picked.worker) {
    try {
      const r = await runOnWorker(picked.worker, { id: `${id}-stills`, kind: 'stills', spec: { items }, purpose: `backdrops for ${id}` },
        { outDir: join(CREATIONS_DIR, id, 'from-worker'), onProgress: stage => setJob(id, { stage: `${picked.worker.name}: ${stage}` }), timeoutMs: 1_800_000 });
      const detail = r.receipt.detail?.items || [];
      const files = looks.map((_, i) => {
        const d = detail[i], o = d?.ok ? r.outputs.find(x => x.name === d.file) : null;
        if (!o) return null;
        const name = mediaName('png');
        copyFileSync(o.path, join(MEDIA_DIR, name));
        noteMedia(name, 'generate', [items[i].prompt, { seed: d.seed, width: d.width, height: d.height, steps: d.steps, model: 'sdxl-base-1.0', paintedOn: picked.worker.name, job: id }], { source: 'creation' });
        return join(MEDIA_DIR, name);
      });
      const made = files.filter(Boolean).length;
      return { files, info: { asked: looks.length, made, seconds: r.seconds, placesFrom: from, conditions, paintedOn: picked.worker.name, receipt: { digest: r.receipt.digest, finishedAt: r.receipt.finishedAt },
        items: looks.map((look, i) => detail[i]?.ok ? { look, file: basename(files[i]), seed: detail[i].seed, seconds: detail[i].seconds } : { look, error: detail[i]?.error || 'not painted' }),
        note: made < looks.length ? 'scenes whose backdrop failed use the built-in landscape' : null } };
    } catch (e) { workerNote = `${clip(e.message, 200)}; painted on this PC instead`; console.error('[creation] worker stills:', e.message); }
  } else if (workersConfigured()) workerNote = `no worker took it (${clip(picked.why, 200)}); painted on this PC`;
  try {
    const batch = await renderStillBatch(items,
      { source: 'creation', purpose: `backdrops for ${id}`, onProgress: (i, n) => setJob(id, { stage: `painting backdrop ${i + 1} of ${n}` }) });
    const painted = batch.results.map((r, i) => r.ok ? { look: looks[i], file: basename(r.path), seed: r.seed, seconds: r.seconds } : { look: looks[i], error: r.error });
    const made = batch.results.filter(r => r.ok).length;
    return { files: batch.results.map(r => r.ok ? r.path : null), info: { asked: looks.length, made, seconds: batch.seconds, placesFrom: from, conditions, paintedOn: 'this PC', workerNote, items: painted, note: made < looks.length ? 'scenes whose backdrop failed use the built-in landscape' : null } };
  } catch (e) {
    console.error('[creation] backdrops:', e.message);
    return { files: [], info: { asked: looks.length, made: 0, placesFrom: from, note: `no backdrops, built-in landscape used: ${clip(e.code === 'gpu_unavailable' ? 'the graphics card was in use' : e.message, 200)}` } };
  }
}

/**
 * Who writes a web page. CREATION_CODERS="model@http://host:11434,…" (same form as CREATION_WRITERS, which is used when it is unset),
 * then the local coding model. A coder whose call fails is skipped; the next one is asked.
 */
const CODERS = (process.env.CREATION_CODERS || process.env.CREATION_WRITERS || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
  const i = x.lastIndexOf('@'); const c = classifyUrl(i > 0 ? x.slice(i + 1) : '');
  return i > 0 && c.url && c.routeClass !== 'public' ? { model: x.slice(0, i), url: c.url, label: `${x.slice(0, i)} on ${c.host}` } : null;
}).filter(Boolean);
const LOCAL_CODER_MODEL = process.env.CREATION_CODE_MODEL || process.env.SMK_CODE_MODEL || 'qwen2.5-coder:7b';

async function askCoder(messages) {
  let lastError = null;
  for (const w of CODERS) {
    try {
      const send = think => fetch(`${w.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(480_000),
        body: JSON.stringify({ model: w.model, messages, stream: false, ...(think ? {} : { think: false }), options: { temperature: 0.4, num_predict: 7000, num_ctx: 12288 } }) });
      let r = await send(false);
      if (r.status === 400) r = await send(true);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.message?.content) return { reply: j.message.content, by: w.label };
      throw new Error('empty reply');
    } catch (e) { lastError = e; console.error(`[creation] coder ${w.label}:`, e.message); }
  }
  try { return { reply: await chatOllama(messages, { model: LOCAL_CODER_MODEL, priority: 'agent_run', temperature: 0.4, maxTokens: 7000, timeoutMs: 600_000, label: 'creation:page' }), by: `${LOCAL_CODER_MODEL} on this PC` }; }
  catch (e) { throw new Error(`no coding model answered (${clip(lastError?.message || '', 80)}; local: ${clip(e.message, 80)})`); }
}

/** A web page: written, checked, opened in a browser, and only then saved where the library lists it. */
async function makePage(id, plan) {
  const dir = join(CREATIONS_DIR, id);
  mkdirSync(dir, { recursive: true });
  let page;
  try { page = await buildPage({ id, request: plan.request, ask: askCoder, draftsDir: dir, onStage: stage => setJob(id, { stage, progress: stage.startsWith('opening') ? 0.7 : 0.3 }) }); }
  catch (e) { try { writeFileSync(join(dir, 'lineage.json'), JSON.stringify({ job: id, request: plan.request, plan, kept: false, attempts: e.log || [], madeAt: new Date().toISOString() }, null, 2), 'utf8'); } catch (_) { /* the error below is what matters */ } throw e; }
  setJob(id, { title: page.title });
  try { writeFileSync(join(dir, 'lineage.json'), JSON.stringify({ job: id, request: plan.request, plan, kept: true, page: { ...page, dir: undefined, log: undefined }, earlierAttempts: page.log, madeAt: page.madeAt }, null, 2), 'utf8'); }
  catch (e) { console.error('[creation] lineage:', e.message); }
  return { kind: 'page', file: page.slug, slug: page.slug, url: `/sites/${page.slug}/`, openAt: `http://127.0.0.1:${PORT}/sites/${page.slug}/`, title: page.title, bytes: page.bytes, lines: page.lines, components: page.components,
    writtenBy: page.writtenBy, attempts: page.attempts, earlierAttempts: page.log, checked: page.checked, preview: page.hasPreview ? `/sites/${page.slug}/preview.png` : null, folder: page.dir };
}

/**
 * Render on a worker: the lines are recorded HERE first (the voices never leave this machine as a service — only
 * the finished recordings travel), then script, cast, backdrops and recordings go as one bundle.
 */
async function renderOnWorker(worker, id, plan, script, backdropFiles, spritesPath, outDir) {
  const lines = [];
  const spoken = plan.voice !== 'silent' && plan.kind !== 'still';   // comic pages alone need no recording
  if (spoken) {
    for (const [i, sc] of script.scenes.entries()) {
      setJob(id, { stage: `voicing line ${i + 1} of ${script.scenes.length}`, progress: 0.06 });
      lines.push({ text: sc.say, file: `line-${String(i + 1).padStart(2, '0')}.wav`, wav: await speakLine(id, sc.say) });
    }
  }
  const rel = backdropFiles.map((f, i) => (f ? `backdrop-${i}${extname(f).toLowerCase()}` : null));
  const files = { 'script.md': Buffer.from(buildMarkdownFor(plan, script, rel), 'utf8'), 'cast.json': readFileSync(spritesPath) };
  backdropFiles.forEach((f, i) => { if (f) files[rel[i]] = readFileSync(f); });
  for (const l of lines) files[l.file] = l.wav;
  const r = await runOnWorker(worker, { id: `${id}-video`, kind: 'video', purpose: `render ${id}`, files,
    spec: { recipe: RECIPES[plan.style], pagesOnly: plan.kind === 'still', format: plan.format, voice: spoken ? 'lines' : 'silent', lines: lines.map(l => ({ text: l.text, file: l.file })) } },
    { outDir, onProgress: (stage, p) => setJob(id, { stage: `${worker.name}: ${stage}`, progress: Math.max(0.08, Number(p) || 0) }), timeoutMs: RENDER_TIMEOUT_MS + 600_000 });
  if (plan.kind !== 'still' && !r.outputs.some(o => /_master\.mp4$/i.test(o.name))) throw new Error('the worker returned no master video');
  return { result: { ok: true, files: r.outputs.map(o => o.path), duration_s: r.receipt.detail?.duration_s, render_s: r.receipt.detail?.render_s }, log: [], receipt: r.receipt };
}

async function makeVideo(id, plan, opts) {
  const ready = await studioReadiness();
  if (!ready.ready) throw new Error(`the video studio cannot run here: ${ready.problems.join('; ')}`);
  // The voice is chosen before the script is written: how many words fill the asked time depends on who speaks them.
  const picked = plan.voice === 'silent' ? { engine: 'silent', why: 'asked for no voice' } : await pickVoiceEngine();
  if (PACES[picked.engine] && plan.style !== 'explainer') plan = { ...plan, pace: PACES[picked.engine] };
  let script;
  if (Array.isArray(opts.scenes) && opts.scenes.length) {
    script = normalizeFor({ title: opts.title, cast: opts.cast, scenes: opts.scenes, panels: opts.scenes }, plan, { final: true });
    if (!script.ok) throw new Error(`the supplied script was refused: ${script.reason}`);
    script.attempts = 0; script.writtenBy = 'supplied by the caller';
  } else {
    setJob(id, { stage: 'writing', progress: 0.02 });
    script = await writeScript(plan, (attempt, who) => setJob(id, { stage: `writing: ${who}${attempt > 1 ? `, attempt ${attempt}` : ''}` }));
  }
  const dir = join(CREATIONS_DIR, id), outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  // The cast: one sprite per character, forged from the script's description of each
  const pixel = PIXEL_STYLES.includes(plan.style), pagesOnly = plan.kind === 'still';
  const sprites = pixel ? forgeCast(script.cast, { style: plan.style, request: plan.request }) : [];
  const people = !pixel && plan.style !== 'explainer' ? forgePeople(script.cast) : [];
  const castInfo = pixel ? sprites.map(s => ({ name: s.name, look: s.look, kind: s.kind, template: s.template, colors: s.colors, why: s.why }))
    : people.length ? people.map(p => ({ name: p.name, look: p.look, kind: 'person', template: 'flat cartoon person', colors: { clothes: p.color, skin: p.skin, hair: p.hair }, why: p.why }))
    : [{ name: 'narrator', look: 'one narrating voice', kind: 'voice', template: 'none', colors: {}, why: [] }];
  if (pixel) script.cast.forEach((c, i) => { if (sprites[i].name !== c.name) { for (const sc of script.scenes) if (sc.speaker === c.name) sc.speaker = sprites[i].name; c.name = sprites[i].name; } });
  const spritesPath = join(dir, 'cast.json');
  writeFileSync(spritesPath, JSON.stringify(pixel ? { cast: sprites.map(s => ({ name: s.name, rows: s.rows, colors: s.colors, closed: s.closed })) } : { people: people.map(p => ({ name: p.name, color: p.color, skin: p.skin, hair: p.hair })) }, null, 1), 'utf8');
  if (pixel) try {
    const S = 10, tiles = [];
    for (const [i, s] of sprites.entries()) for (const talk of [false, true]) tiles.push({ input: await sharp(spritePixels(s, { talk }), { raw: { width: 16, height: 16, channels: 4 } }).resize(16 * S, 16 * S, { kernel: 'nearest' }).png().toBuffer(), left: (i * 2 + (talk ? 1 : 0)) * 16 * S, top: 0 });
    await sharp({ create: { width: sprites.length * 2 * 16 * S, height: 16 * S, channels: 3, background: plan.style === '2bit' ? '#9bbc0f' : '#3cbcfc' } }).composite(tiles).png().toFile(join(dir, 'cast.png'));
  } catch (e) { console.error('[creation] cast preview:', e.message); }
  const backdrops = await paintBackdrops(id, plan, script);
  if (cancelled.has(id)) throw new Error('cancelled');
  const markdown = buildMarkdownFor(plan, script, backdrops.files);
  const scriptPath = join(dir, 'script.md');
  writeFileSync(scriptPath, markdown, 'utf8');
  setJob(id, { script: markdown, title: script.title, stage: 'voicing', progress: 0.05 });

  const voice = { lines: speakerLines(script), names: script.cast.map(c => c.name), dir, n: 0, engines: new Set(), voices: new Set(), engine: picked.engine, seconds: 0 };
  voiceJobs.set(id, voice);
  let done, renderedOn = 'this PC', renderNote = null;
  try {
    const pw = await pickWorker('video');
    if (pw.worker) {
      try { done = await renderOnWorker(pw.worker, id, plan, script, backdrops.files, spritesPath, outDir); renderedOn = pw.worker.name; }
      catch (e) { if (cancelled.has(id)) throw e; renderNote = `${clip(e.message, 200)}; rendered on this PC instead`; console.error('[creation] worker render:', e.message); }
    } else if (workersConfigured()) renderNote = `no worker took it (${clip(pw.why, 200)}); rendered on this PC`;
    if (!done) done = await renderWithStudio(id, plan, scriptPath, outDir, ready, spritesPath, pagesOnly);
  } finally { voiceJobs.delete(id); }

  const produced = done.result.files || [];
  const master = produced.find(f => /_master\.mp4$/i.test(f));
  if (!pagesOnly && (!master || !existsSync(master))) throw new Error('the studio finished without a master video');
  // comic pages go on the shelf as pictures; the PDF stays in the film's folder
  const pageFiles = produced.filter(f => /page_\d+\.png$/i.test(f) && existsSync(f)).sort();
  const pages = pageFiles.map((f, i) => { const n = mediaName('png'); copyFileSync(f, join(MEDIA_DIR, n)); noteMedia(n, 'create', [plan.request, { style: plan.style, page: i + 1, of: pageFiles.length, title: script.title, job: id, renderer: 'fraymus-video-studio' }], { source: 'creation' }); return n; });
  const pdfSrc = produced.find(f => /_comic\.pdf$/i.test(f) && existsSync(f));
  let pdf = null;
  if (pdfSrc) { pdf = join(dir, basename(pdfSrc)); try { copyFileSync(pdfSrc, pdf); } catch (e) { console.error('[creation] pdf:', e.message); pdf = pdfSrc; } }
  if (pagesOnly && !pages.length) throw new Error('the studio finished without any comic page');
  const name = master ? mediaName('mp4') : pages[0];
  if (master) copyFileSync(master, join(VIDEO_DIR, name));
  const voiced = plan.voice === 'silent' ? 'silent' : [...voice.engines].join('+') || 'none';
  if (master) noteMedia(name, 'create', [plan.request, { style: plan.style, palette: plan.palette, format: plan.format, seconds: done.result.duration_s, scenes: script.scenes.length, backdrops: backdrops.info.made, title: script.title, voice: voiced, job: id, renderer: 'fraymus-video-studio' }], { source: 'creation' });
  try { rmSync(join(outDir, 'work'), { recursive: true, force: true }); } catch (e) { console.error('[creation] cleanup:', e.message); }
  // Lineage: everything needed to say how this file came to be, and to make it again or change one line
  try {
    writeFileSync(join(dir, 'lineage.json'), JSON.stringify({ job: id, request: plan.request, plan, cast: castInfo,
      script: { title: script.title, places: script.places, scenes: script.scenes, writtenBy: script.writtenBy, attempts: script.attempts, refusals: script.refusals || [], fixes: script.fixes },
      backdrops: backdrops.info,
      voice: { engine: voiced, voices: [...voice.voices], chosen: picked, synthSeconds: +voice.seconds.toFixed(1), offline: voiced === 'sapi' || voiced === 'piper' || voiced === 'silent' || (voiced === 'voicestudio' && VOICESTUDIO.routeClass === 'local') }, wordTiming: ready.wordTiming,
      renderer: { name: 'fraymus-video-studio', renderedOn, note: renderNote, receipt: done.receipt ? { digest: done.receipt.digest, worker: done.receipt.worker, finishedAt: done.receipt.finishedAt } : null, recipe: plan.style, repo: STUDIO_REPO, python: ready.pythonVersion, workers: 1, renderSeconds: done.result.render_s },
      output: { file: name, seconds: done.result.duration_s, pages, pdf }, madeAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) { console.error('[creation] lineage:', e.message); }
  return {
    kind: master ? 'video' : 'pages', file: name, url: `/api/hermes/artifacts/media?kind=${master ? 'video' : 'image'}&id=${name}`, pages, pdf, title: script.title, seconds: done.result.duration_s, renderSeconds: done.result.render_s,
    scenes: script.scenes.length, words: script.words, scriptAttempts: script.attempts, scriptRefusals: script.refusals || [], scriptBy: script.writtenBy, scriptFixes: script.fixes,
    cast: castInfo.map(c => ({ name: c.name, look: c.look, sprite: c.template })), backdrops: backdrops.info, voice: voiced, voiceWhy: picked.why, voices: [...voice.voices], wordTiming: ready.wordTiming, renderedOn, renderNote, folder: dir, files: (done.result.files || []).map(f => basename(f)),
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
    const output = plan.kind === 'page' ? await makePage(id, plan) : plan.kind === 'still' && plan.style !== 'comic' ? await makeStill(id, plan, opts) : await makeVideo(id, plan, opts);
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
export async function createFromRequest({ request, kind, style, seconds, format, palette, voice, backdrops, image, scenes, cast, title, source = 'api', agentId = null } = {}) {
  const text = clip(request, 1500).replace(/\s+/g, ' ').trim();
  if (text.length < 3) throw Object.assign(new Error('request is required: say what to make'), { status: 400 });
  let plan = planCreation(text, { kind: image ? 'still' : kind, style, seconds, format, palette, voice, backdrops });
  if (plan.blocked) return { accepted: false, reason: plan.blocked.reason, message: describePlan(plan), plan, summary: describePlan(plan) };
  if (plan.kind) plan = settleKind(plan, plan.kind);
  if (image && plan.kind !== 'page' && !PIXEL_STYLES.includes(plan.style)) return { accepted: false, reason: 'image_needs_pixel_look', message: 'Turning a picture into pixel art needs the 8-bit or 2-bit look.', plan, summary: describePlan(plan) };
  if (plan.kind !== 'page' && (plan.kind !== 'still' || plan.style === 'comic')) {
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
  const opts = { image: image || null, scenes: Array.isArray(scenes) ? scenes.slice(0, 30) : null, cast: Array.isArray(cast) ? cast.slice(0, 2) : null, title: title ? clip(title, 60) : null };
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
    writers: [...WRITERS, LOCAL_WRITER].map(w => w.label), coders: [...CODERS.map(w => w.label), `${LOCAL_CODER_MODEL} on this PC`], workers: await workersStatus(), studio: ready, voices: VOICES, voiceStudio: { ...(await pickVoiceEngine()), url: VOICESTUDIO.url || null, routeClass: VOICESTUDIO.routeClass || null, voices: VS_VOICES }, ttsEngine: TTS_ENGINE || 'cascade (edge-tts online first, then offline SAPI)', running: currentId, counts, timing, agentCapPerDay: MAX_AGENT_JOBS_PER_DAY, jobs: listCreations(8),
  };
}

// ── fleet tools ──────────────────────────────────────────────────────────────────────────────────────

export function createMakeTools() {
  return [
    {
      name: 'studio.create', group: 'studio', risk: 'safe', ownsReply: true,
      description: 'Make something from a plain sentence and save it to the library: a web page or small web app (one self-contained file, opened in a real browser to check it runs), or a picture or a short film — animation, 8-bit or 2-bit pixel art, a flat cartoon, a comic strip (pages and a film of them), a narrated explainer video, a still image, a movie, a short with dialogue. Pass the user\'s own words as `request`; the kind (still or video), look, length and shape are read from the sentence, so do not ask the user to choose a category. Runs on this machine, no paid service. Returns a job id at once; the finished file appears on the home screen shelf. Check progress with studio.create_status. When the user asks for a web page, an app, a game or anything else to build, call this tool — never paste code into the chat as the result: pasted code is not saved, not checked, and is not in the library. If this tool refuses, tell the user exactly what it said; do not ask them to pick a look unless they asked for a picture or a film.',
      parameters: { type: 'object', required: ['request'], properties: {
        request: { type: 'string', description: 'what to make, in the user\'s words, e.g. "a 40 second 8-bit short about a robot who finds a lighthouse"' },
        kind: { type: 'string', description: 'optional: "page", "still" or "video" (only if the user said so explicitly)' },
        style: { type: 'string', description: 'optional: "8bit", "2bit", "cartoon", "comic" or "explainer" (only if the user named the look)' },
        seconds: { type: 'integer', description: 'optional video length in seconds (8-180)' },
        image: { type: 'string', description: 'optional: file name of a picture already in data/media to turn into pixel art instead of generating one' },
      } },
      execute: async ({ args = {} } = {}, ctx = {}) => {
        try {
          const r = await createFromRequest({ request: args.request, kind: args.kind, style: args.style, seconds: args.seconds, image: args.image, source: 'agent', agentId: ctx?.agent?.id || ctx?.agentId || null });
          if (!r.accepted) return { accepted: false, reason: r.reason, message: r.message, replyToUser: `I did not start anything. ${r.message}` };
          const what = r.plan.kind === 'page' ? 'a web page' : r.plan.kind === 'still' ? (r.plan.style === 'comic' ? 'comic pages' : `a ${r.plan.style} still`) : r.plan.kind === 'video' ? `a ${r.plan.style} film` : `something in the ${r.plan.style} look`;
          const where = r.plan.kind === 'page' ? 'under Sites' : r.plan.kind === 'still' ? 'under Images' : 'under Video';
          const wait = r.plan.kind === 'page' ? 'a few minutes' : r.plan.kind === 'still' && r.plan.style !== 'comic' ? 'about two minutes' : r.plan.style === 'explainer' ? 'around ten minutes' : 'a few minutes';
          const replyToUser = r.duplicateOf
            ? `${r.message} It is job ${r.id}, currently ${r.status}.`
            : `I have started ${what}. Here is how I read your request: ${r.summary}.\n\nIt is not finished yet. It takes ${wait}, and it will appear in the library on this screen ("Made here", ${where}) when it is done` +
              (r.plan.kind === 'page' ? ' — but only if it runs without errors when opened in a real browser. If it never passes that check, nothing is added and the job will say what went wrong.' : '.') + ` Job ${r.id}.`;
          return { accepted: true, jobId: r.id, status: r.status, willMake: r.summary, replyToUser };
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
  installWorkerRoutes(app);
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
      const r = await createFromRequest({ request: b.request, kind: b.kind, style: b.style, seconds: b.seconds, format: b.format, palette: b.palette, voice: b.voice, backdrops: b.backdrops, image: b.image, scenes: b.scenes, cast: b.cast, title: b.title, source: 'api' });
      res.status(r.accepted ? 202 : r.reason === 'queue_full' ? 429 : 422).json(r);
    } catch (e) { if (e.status === 400) return res.status(400).json({ error: e.message }); throw e; }
  }));
  app.post('/api/studio/create/:id/cancel', route((req, res) => res.json(cancelCreation(req.params.id))));
  app.get('/api/studio/create/:id', route((req, res) => { const j = getCreation(req.params.id); if (!j) return res.status(404).json({ error: 'no such job' }); res.json(j); }));
}
