/**
 * Media provenance — what made each generated file.
 *
 * The image, video and speech engines write files named <epoch ms>-<id>.<ext> and, until now, kept
 * nothing about them: 18 images and 8 videos on the shelf were titled by a timestamp. Every engine
 * function that saves a file now calls noteMedia(name, op, arguments); the operation, any text it was
 * given (a generation prompt, a watermark, a spoken line) and its small scalar options are stored in
 * media_meta, keyed by file name. ComfyUI generation is asynchronous — prompt at submit, file at
 * fetch — so the prompt is parked under its prompt id and joined when the image is downloaded.
 *
 * Recording must never break media work: every function here swallows and logs its own errors.
 */
import { extname } from 'node:path';
import { db } from '../db.js';

const KIND_BY_EXT = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio' };
const MAX_TEXT = 2000;

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_meta (
      file TEXT PRIMARY KEY, kind TEXT NOT NULL, op TEXT NOT NULL, prompt TEXT, params TEXT, source TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_meta_created ON media_meta(created_at);
    CREATE TABLE IF NOT EXISTS media_prompt_jobs (
      prompt_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, params TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_prompt_files (remote_file TEXT PRIMARY KEY, prompt_id TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
} catch (e) { console.error('[media-meta] table setup failed:', e.message); }

const looksEncoded = s => s.startsWith('data:') || (s.length > 200 && !/\s/.test(s)); // base64 payloads and data URIs are inputs, not descriptions

/** Pull the human-meaningful part out of an engine call: the first real text argument and scalar options. */
export function describeArgs(args) {
  let prompt = null;
  const params = {};
  const list = Array.from(args || []);
  list.forEach((a, i) => {
    if (a == null || Buffer.isBuffer(a) || ArrayBuffer.isView(a) || a instanceof ArrayBuffer) return;
    if (typeof a === 'string') { if (!looksEncoded(a) && a.length <= 5000 && prompt == null && /[A-Za-z]/.test(a)) prompt = a.slice(0, MAX_TEXT); return; }
    if (typeof a === 'number' || typeof a === 'boolean') { params[`arg${i}`] = a; return; }
    if (Array.isArray(a)) { params[`arg${i}_count`] = a.length; return; }
    if (typeof a === 'object') for (const [k, v] of Object.entries(a)) {
      if (typeof v === 'number' || typeof v === 'boolean') params[k] = v;
      else if (typeof v === 'string' && !looksEncoded(v) && v.length <= 200) params[k] = v;
    }
  });
  return { prompt, params };
}

/** Engine function name → the word shown on the shelf: imageResize → resize, videoToGif → toGif, edgeTtsSpeak → speak. */
export function opName(fn) {
  const s = String(fn);
  if (/Speak$/.test(s)) return 'speak';
  const short = s.replace(/^(image|video)(?=[A-Z])/, '');
  return short ? short[0].toLowerCase() + short.slice(1) : s;
}

/** Call right after an engine picks an output name. `args` is the engine function's own `arguments`. */
export function noteMedia(file, op, args, { source = null } = {}) {
  try {
    const kind = KIND_BY_EXT[extname(String(file)).toLowerCase()];
    if (!kind) return;
    let { prompt, params } = describeArgs(args);
    let operation = op;
    if (op === 'comfyuiFetchImage') {
      // the first argument is ComfyUI's own file name, not a description: join the parked prompt instead
      prompt = null;
      const job = db.prepare(`SELECT j.prompt, j.params FROM media_prompt_files f JOIN media_prompt_jobs j ON j.prompt_id = f.prompt_id WHERE f.remote_file = ?`).get(String(args?.[0] ?? ''));
      if (job) { prompt = job.prompt; try { params = JSON.parse(job.params || '{}'); } catch (_) { params = {}; } }
      operation = 'generate';
    }
    db.prepare(`INSERT OR REPLACE INTO media_meta (file, kind, op, prompt, params, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(String(file), kind, opName(operation), prompt, JSON.stringify(params), source, Date.now());
  } catch (e) { console.error('[media-meta] noteMedia:', e.message); }
}

/** ComfyUI: remember what was asked for under the id the server returned. */
export function notePromptJob(promptId, prompt, params = {}) {
  try { if (promptId) db.prepare(`INSERT OR REPLACE INTO media_prompt_jobs (prompt_id, prompt, params, created_at) VALUES (?, ?, ?, ?)`).run(String(promptId), String(prompt ?? '').slice(0, MAX_TEXT), JSON.stringify(params), Date.now()); }
  catch (e) { console.error('[media-meta] notePromptJob:', e.message); }
}
/** ComfyUI: a finished job names its output files; tie each to the job so the download can find the prompt. */
export function notePromptFile(remoteFile, promptId) {
  try { if (remoteFile && promptId) db.prepare(`INSERT OR REPLACE INTO media_prompt_files (remote_file, prompt_id, created_at) VALUES (?, ?, ?)`).run(String(remoteFile), String(promptId), Date.now()); }
  catch (e) { console.error('[media-meta] notePromptFile:', e.message); }
}

/** file name → { op, prompt, params } for the given names. */
export function mediaMetaFor(files) {
  const out = new Map();
  try {
    const get = db.prepare(`SELECT file, kind, op, prompt, params, created_at FROM media_meta WHERE file = ?`);
    for (const f of files) { const r = get.get(String(f)); if (r) { let params = {}; try { params = JSON.parse(r.params || '{}'); } catch (_) { /* keep {} */ } out.set(r.file, { op: r.op, prompt: r.prompt, params, at: r.created_at }); } }
  } catch (e) { console.error('[media-meta] mediaMetaFor:', e.message); }
  return out;
}

/** File names whose recorded text or operation contains q (case-insensitive). */
export function searchMediaFiles(q, limit = 500) {
  try {
    const like = `%${String(q).replace(/[\\%_]/g, m => `\\${m}`)}%`;
    return new Set(db.prepare(`SELECT file FROM media_meta WHERE prompt LIKE ? ESCAPE '\\' OR op LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`).all(like, like, limit).map(r => r.file));
  } catch (e) { console.error('[media-meta] searchMediaFiles:', e.message); return new Set(); }
}

export function mediaMetaStats() {
  try { return db.prepare(`SELECT kind, COUNT(*) n, SUM(CASE WHEN prompt IS NOT NULL THEN 1 ELSE 0 END) withText FROM media_meta GROUP BY kind`).all(); }
  catch (e) { return []; }
}
