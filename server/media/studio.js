/**
 * Studio — the local image engine, run under the GPU lease.
 *
 * ComfyUI lives outside the repository (CHANDRA_STUDIO_DIR, default F:/Chandra-Studio) in its own
 * Python environment. This module supervises it as a child process and renders stills with SDXL:
 *
 *   renderStill() → take the GPU lease (Ollama paused + unloaded) → make sure ComfyUI is up →
 *   submit an SDXL workflow → wait for the result → download the image into data/media with its
 *   provenance → ask ComfyUI to free its models → release the lease.
 *
 * One render at a time (the lease enforces it). Every job is a row in studio_jobs with a state that
 * is closed at boot if a previous process left it open. Nothing here calls a paid or remote service:
 * the only network traffic is to 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { comfyuiFetchImage } from './image-engine.js';
import { notePromptJob, notePromptFile } from './media-meta.js';
import { withGpuLease, heartbeatGpuLease, vramSnapshot } from './gpu-lease.js';

const STUDIO_DIR = resolve(process.env.CHANDRA_STUDIO_DIR || 'F:/Chandra-Studio');
const COMFY_DIR = join(STUDIO_DIR, 'ComfyUI');
const COMFY_PY = join(STUDIO_DIR, 'comfyui-env', 'Scripts', 'python.exe');
const COMFY_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const COMFY_PORT = Number(new URL(COMFY_URL).port || 8188);
const CHECKPOINT = process.env.STUDIO_SDXL_CHECKPOINT || 'sd_xl_base_1.0.safetensors';
const VAE = process.env.STUDIO_SDXL_VAE || 'sdxl_vae.safetensors';
const START_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = Math.max(120_000, parseInt(process.env.STUDIO_RENDER_TIMEOUT_MS, 10) || 900_000);
const OWNER = 'studio';
const now = () => Date.now();
const clip = (s, n) => String(s ?? '').slice(0, n);

let child = null;
let childLog = [];
let startedAt = null;

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT, params TEXT,
      output TEXT, error TEXT, lease_id TEXT, seconds REAL, created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_studio_jobs_created ON studio_jobs(created_at);
  `);
  const closed = db.prepare(`UPDATE studio_jobs SET status = 'error', error = 'interrupted by restart', completed_at = ? WHERE status IN ('queued', 'running')`).run(now()).changes;
  if (closed) console.log(`[studio] closed ${closed} job(s) left open by a previous process`);
} catch (e) { console.error('[studio] table setup failed:', e.message); }

const emit = payload => { try { publish('studio', 'system.studio', JSON.stringify(payload)); } catch (e) { console.error('[studio] publish:', e.message); } };

function modelFiles(sub) { try { return readdirSync(join(COMFY_DIR, 'models', sub)).filter(f => /\.(safetensors|ckpt|pth|pt|gguf)$/i.test(f)).map(f => ({ file: f, gb: +(statSync(join(COMFY_DIR, 'models', sub, f)).size / 1e9).toFixed(2) })); } catch (_) { return []; } }

export function studioInstalled() {
  return { studioDir: STUDIO_DIR, comfyui: existsSync(join(COMFY_DIR, 'main.py')), python: existsSync(COMFY_PY), checkpoint: existsSync(join(COMFY_DIR, 'models', 'checkpoints', CHECKPOINT)), vae: existsSync(join(COMFY_DIR, 'models', 'vae', VAE)) };
}

async function comfyAlive() {
  try { const r = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; }
  catch (_) { return null; }
}

/** Start ComfyUI if it is not answering. Resolves its system stats, or throws with the last log lines. */
export async function ensureComfy() {
  const up = await comfyAlive();
  if (up) return up;
  const inst = studioInstalled();
  if (!inst.comfyui || !inst.python) throw new Error(`ComfyUI is not installed under ${STUDIO_DIR}`);
  if (!child) {
    childLog = [];
    // --lowvram: SDXL fits 8 GB, but the card is shared with the desktop; let ComfyUI offload rather than fail
    child = spawn(COMFY_PY, ['main.py', '--listen', '127.0.0.1', '--port', String(COMFY_PORT), '--disable-auto-launch', '--lowvram'], { cwd: COMFY_DIR, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    startedAt = now();
    const keep = buf => { for (const line of String(buf).split(/\r?\n/)) if (line.trim()) { childLog.push(line.slice(0, 300)); if (childLog.length > 80) childLog.shift(); } };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', (code, signal) => { console.log(`[studio] ComfyUI exited (code ${code}, signal ${signal})`); child = null; startedAt = null; });
    child.on('error', e => { console.error('[studio] ComfyUI spawn error:', e.message); child = null; });
    process.once('exit', () => { try { child?.kill(); } catch (_) { /* process is exiting */ } });
  }
  const deadline = now() + START_TIMEOUT_MS;
  while (now() < deadline) {
    const stats = await comfyAlive();
    if (stats) return stats;
    if (!child) throw new Error(`ComfyUI exited while starting: ${childLog.slice(-4).join(' | ')}`);
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`ComfyUI did not answer within ${START_TIMEOUT_MS / 1000} s: ${childLog.slice(-3).join(' | ')}`);
}

export function stopComfy() {
  if (!child) return { stopped: false, reason: 'not started by this server' };
  try { child.kill(); } catch (e) { return { stopped: false, reason: e.message }; }
  return { stopped: true };
}

/** Tell ComfyUI to drop its models so the card is empty when the lease goes back. */
async function comfyFree() {
  try { await fetch(`${COMFY_URL}/free`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(15_000) }); await new Promise(r => setTimeout(r, 1500)); }
  catch (e) { console.error('[studio] ComfyUI free:', e.message); }
}

function sdxlWorkflow({ prompt, negative, width, height, steps, cfg, seed, useVae }) {
  const wf = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed, steps, cfg, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: useVae ? ['10', 0] : ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'chandra', images: ['8', 0] } },
  };
  if (useVae) wf['10'] = { class_type: 'VAELoader', inputs: { vae_name: VAE } };
  return wf;
}

const even64 = (v, d) => Math.min(1536, Math.max(512, Math.round((parseInt(v, 10) || d) / 64) * 64));

/** Submit one SDXL workflow to a running lease and bring the image home. Call only while holding the GPU lease. */
async function runWorkflow(text, p) {
    await ensureComfy();
    const useVae = studioInstalled().vae;
    const res = await fetch(`${COMFY_URL}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: sdxlWorkflow({ prompt: text, ...p, useVae }) }), signal: AbortSignal.timeout(60_000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.prompt_id) throw new Error(`ComfyUI refused the workflow: ${clip(JSON.stringify(body.error || body.node_errors || body), 300)}`);
    notePromptJob(body.prompt_id, text, { seed: p.seed, width: p.width, height: p.height, steps: p.steps, cfg: p.cfg, model: 'sdxl-base-1.0', licence: 'openrail++' });
    const deadline = now() + RENDER_TIMEOUT_MS;
    let image = null;
    while (now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      heartbeatGpuLease(OWNER, RENDER_TIMEOUT_MS + 240_000);
      const h = await fetch(`${COMFY_URL}/history/${body.prompt_id}`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()).catch(() => ({}));
      const entry = h[body.prompt_id];
      if (!entry) { if (!child && !(await comfyAlive())) throw new Error(`ComfyUI stopped during the render: ${childLog.slice(-3).join(' | ')}`); continue; }
      if (entry.status?.status_str === 'error') throw new Error(`ComfyUI render failed: ${clip(JSON.stringify(entry.status.messages?.slice(-1)), 300)}`);
      image = Object.values(entry.outputs || {}).flatMap(o => o.images || [])[0];
      if (image) break;
    }
    if (!image) throw new Error(`no image after ${RENDER_TIMEOUT_MS / 1000} s`);
    notePromptFile(image.filename, body.prompt_id);
    return comfyuiFetchImage(image.filename, image.subfolder || '');
}

/**
 * Render one still with SDXL. Resolves { jobId, url, path, width, height, seconds, seed, vram }.
 * Throws with code 'gpu_unavailable' when another job holds the card.
 */
export async function renderStill({ prompt, negative = 'blurry, low quality, watermark, text, deformed', width = 1024, height = 1024, steps = 28, cfg = 6.5, seed, source = 'api' } = {}) {
  const text = clip(prompt, 1500).trim();
  if (!text) throw Object.assign(new Error('prompt is required'), { status: 400 });
  const p = { width: even64(width, 1024), height: even64(height, 1024), steps: Math.min(60, Math.max(8, parseInt(steps, 10) || 28)), cfg: Math.min(15, Math.max(1, Number(cfg) || 6.5)), seed: Number.isInteger(seed) ? seed : Math.floor(Math.random() * 2 ** 32), negative: clip(negative, 600), model: CHECKPOINT };
  const jobId = `still-${randomUUID().slice(0, 10)}`;
  db.prepare(`INSERT INTO studio_jobs (id, kind, status, prompt, params, created_at) VALUES (?, 'still', 'queued', ?, ?, ?)`).run(jobId, text, JSON.stringify({ ...p, source }), now());
  const t0 = now();
  try {
    const result = await withGpuLease(OWNER, { purpose: `still: ${clip(text, 80)}`, ttlMs: RENDER_TIMEOUT_MS + 240_000 }, async lease => {
      db.prepare(`UPDATE studio_jobs SET status = 'running', lease_id = ? WHERE id = ?`).run(lease.leaseId, jobId);
      emit({ action: 'still_started', jobId, prompt: clip(text, 120) });
      const saved = await runWorkflow(text, p);
      const peak = await vramSnapshot();
      await comfyFree();
      return { ...saved, vramDuring: peak };
    });
    const seconds = +((now() - t0) / 1000).toFixed(1);
    const out = { jobId, url: result.url, path: result.path, width: result.width, height: result.height, bytes: result.size, seconds, seed: p.seed, steps: p.steps, model: CHECKPOINT, vramDuringMB: result.vramDuring?.usedMB ?? null };
    db.prepare(`UPDATE studio_jobs SET status = 'completed', output = ?, seconds = ?, completed_at = ? WHERE id = ?`).run(JSON.stringify(out), seconds, now(), jobId);
    emit({ action: 'still_completed', jobId, seconds, url: out.url });
    return out;
  } catch (e) {
    db.prepare(`UPDATE studio_jobs SET status = 'error', error = ?, seconds = ?, completed_at = ? WHERE id = ?`).run(clip(e.message, 400), +((now() - t0) / 1000).toFixed(1), now(), jobId);
    emit({ action: 'still_failed', jobId, error: clip(e.message, 160) });
    throw e;
  }
}

/**
 * Render several stills under ONE GPU lease, so the model is loaded once (most of a single still's
 * time is model load after the card was emptied). items: [{ prompt, negative?, width?, height?, steps?, cfg?, seed? }], at most 8.
 * One item failing does not stop the rest. Resolves { seconds, results: [{ ok, jobId, path?, url?, seed?, seconds, error? }] } in input order.
 * Throws with code 'gpu_unavailable' when another job holds the card.
 */
export async function renderStillBatch(items, { source = 'api', purpose = 'stills', onProgress } = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, 8).map(it => {
    const text = clip(it?.prompt, 1500).trim();
    return { text, p: { width: even64(it?.width, 1024), height: even64(it?.height, 1024), steps: Math.min(60, Math.max(8, parseInt(it?.steps, 10) || 28)), cfg: Math.min(15, Math.max(1, Number(it?.cfg) || 6.5)), seed: Number.isInteger(it?.seed) ? it.seed : Math.floor(Math.random() * 2 ** 32), negative: clip(it?.negative ?? 'blurry, low quality, watermark, text, deformed', 600), model: CHECKPOINT } };
  }).filter(it => it.text);
  if (!list.length) throw Object.assign(new Error('at least one prompt is required'), { status: 400 });
  const ids = list.map(() => `still-${randomUUID().slice(0, 10)}`);
  list.forEach((it, i) => db.prepare(`INSERT INTO studio_jobs (id, kind, status, prompt, params, created_at) VALUES (?, 'still', 'queued', ?, ?, ?)`).run(ids[i], it.text, JSON.stringify({ ...it.p, source, batch: ids[0] }), now()));
  const closeOpen = reason => { for (const id of ids) db.prepare(`UPDATE studio_jobs SET status = 'error', error = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running')`).run(clip(reason, 400), now(), id); };
  const t0 = now();
  try {
    const results = await withGpuLease(OWNER, { purpose: `${purpose} (${list.length})`, ttlMs: RENDER_TIMEOUT_MS + 240_000 }, async lease => {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const { text, p } = list[i], jobId = ids[i], s0 = now();
        db.prepare(`UPDATE studio_jobs SET status = 'running', lease_id = ? WHERE id = ?`).run(lease.leaseId, jobId);
        onProgress?.(i, list.length);
        try {
          const saved = await runWorkflow(text, p);
          const seconds = +((now() - s0) / 1000).toFixed(1);
          const r = { ok: true, jobId, url: saved.url, path: saved.path, width: saved.width, height: saved.height, seed: p.seed, steps: p.steps, seconds };
          db.prepare(`UPDATE studio_jobs SET status = 'completed', output = ?, seconds = ?, completed_at = ? WHERE id = ?`).run(JSON.stringify(r), seconds, now(), jobId);
          out.push(r);
        } catch (e) {
          const seconds = +((now() - s0) / 1000).toFixed(1);
          db.prepare(`UPDATE studio_jobs SET status = 'error', error = ?, seconds = ?, completed_at = ? WHERE id = ?`).run(clip(e.message, 400), seconds, now(), jobId);
          out.push({ ok: false, jobId, seconds, error: clip(e.message, 300) });
        }
      }
      await comfyFree();
      return out;
    });
    const seconds = +((now() - t0) / 1000).toFixed(1);
    emit({ action: 'still_batch_completed', count: results.length, ok: results.filter(r => r.ok).length, seconds });
    return { seconds, results };
  } catch (e) { closeOpen(e.message); emit({ action: 'still_batch_failed', error: clip(e.message, 160) }); throw e; }
}

export async function studioStatus() {
  const stats = await comfyAlive();
  let jobs = [], timing = null;
  try {
    jobs = db.prepare(`SELECT id, kind, status, substr(prompt, 1, 120) AS prompt, seconds, error, created_at FROM studio_jobs ORDER BY created_at DESC LIMIT 10`).all();
    timing = db.prepare(`SELECT COUNT(*) n, ROUND(AVG(seconds), 1) avgSeconds, ROUND(MIN(seconds), 1) fastest, ROUND(MAX(seconds), 1) slowest FROM studio_jobs WHERE kind = 'still' AND status = 'completed'`).get();
  } catch (e) { console.error('[studio] status:', e.message); }
  return {
    installed: studioInstalled(),
    comfyui: { url: COMFY_URL, running: !!stats, startedByServer: !!child, upForMs: startedAt ? now() - startedAt : null, version: stats?.system?.comfyui_version || null, device: stats?.devices?.[0]?.name || null, lastLog: childLog.slice(-5) },
    models: { checkpoints: modelFiles('checkpoints'), vae: modelFiles('vae'), upscalers: modelFiles('upscale_models') },
    stills: timing, jobs,
  };
}

export function installStudioRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/studio', route(async (req, res) => res.json(await studioStatus())));
  app.post('/api/studio/still', route(async (req, res) => {
    const b = req.body || {};
    try { res.json(await renderStill({ prompt: b.prompt, negative: b.negative, width: b.width, height: b.height, steps: b.steps, cfg: b.cfg, seed: Number.isInteger(b.seed) ? b.seed : undefined, source: 'api' })); }
    catch (e) { if (e.code === 'gpu_unavailable') return res.status(409).json({ error: e.message, detail: e.detail }); if (e.status === 400) return res.status(400).json({ error: e.message }); throw e; }
  }));
  app.post('/api/studio/comfy/start', route(async (req, res) => { const s = await ensureComfy(); res.json({ running: true, version: s?.system?.comfyui_version || null }); }));
  app.post('/api/studio/comfy/stop', route((req, res) => res.json(stopComfy())));
}
