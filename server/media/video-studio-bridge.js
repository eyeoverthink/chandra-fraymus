/**
 * fraymus-video-studio (OhGee's studio on FRAYMUS-HOME) as shared Chandra tools.
 *
 * Why (handoff 2026-11-12, section 4.1): the studio has ten film recipes, a job queue, scorecards and its own memory, and
 * says "Chandra can call it". Every agent may now use it through these tools. The studio listens on FRAYMUS-HOME's loopback
 * (127.0.0.1:8790), so the hub reaches it through an SSH tunnel, the same pattern as the worker (media/workers.js).
 *
 * Config (.env, no secrets): VIDEO_STUDIO_URL = ssh://user@host:port (tunnelled) or http://private-host:port.
 * Token, first that exists: VIDEO_STUDIO_TOKEN, VIDEO_STUDIO_TOKEN_FILE, or VIDEO_STUDIO_REMOTE_ENV — a path on the
 * studio's own machine; only its `STUDIO_TOKEN=` line is read over SSH, kept in memory, never written here or logged.
 *
 * Free: recipes, job status, fetching a finished file onto the shelf, brain search / consult. Ask a person first:
 * render (it occupies FRAYMUS-HOME's renderer and card) and brain_remember (it writes into another agent's memory).
 * The studio owns its queue and its GPU lock (studio/gpu_lock.py); nothing here starts, stops or changes it.
 */
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { classifyHost } from '../fraymus-os/registry.js';
import { noteMedia } from './media-meta.js';

const LOCAL_PORT = Number(process.env.VIDEO_STUDIO_LOCAL_PORT) || 47390;
const clip = (s, n) => String(s ?? '').slice(0, n);
let tunnel = null, token = null;

export function studioConfig(spec = process.env.VIDEO_STUDIO_URL || '') {
  const ssh = String(spec).match(/^ssh:\/\/([\w.-]+)@([\w.-]+):(\d{2,5})$/);
  if (ssh) return { via: 'ssh', user: ssh[1], host: ssh[2], remotePort: Number(ssh[3]), url: `http://127.0.0.1:${LOCAL_PORT}` };
  if (!spec) return null;
  let u; try { u = new URL(spec); } catch { return { refused: `not a URL: ${clip(spec, 60)}` }; }
  if (!['http:', 'https:'].includes(u.protocol) || classifyHost(u.hostname) === 'public') return { refused: 'only a private or local studio address is accepted' };
  return { via: 'direct', host: u.hostname, url: u.origin };
}

function sshArgs(cfg, ...rest) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...rest, `${cfg.user}@${cfg.host}`];
}

async function ensureTunnel(cfg) {
  if (cfg.via !== 'ssh') return;
  if (tunnel && tunnel.exitCode == null) return;
  tunnel = spawn('ssh', [...sshArgs(cfg, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-L', `127.0.0.1:${LOCAL_PORT}:127.0.0.1:${cfg.remotePort}`)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = ''; tunnel.stderr.on('data', d => { err += d; });
  tunnel.on('exit', code => { if (code) console.error(`[video-studio] tunnel closed (${code}): ${clip(err.trim().split('\n').pop(), 160)}`); tunnel = null; });
  process.once('exit', () => { try { tunnel?.kill(); } catch (e) { console.error('[video-studio] tunnel stop:', e.message); } });
  for (let i = 0; i < 40; i++) {                       // up to 10 s for the forward to answer
    try { const r = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return; } catch { /* not up yet */ }
    if (!tunnel || tunnel.exitCode != null) break;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`no SSH tunnel to the studio on ${cfg.host}:${cfg.remotePort}`);
}

/** The studio's token, from the first source that has one. Never logged or returned. */
async function studioToken(cfg) {
  if (token) return token;
  if (process.env.VIDEO_STUDIO_TOKEN) return (token = process.env.VIDEO_STUDIO_TOKEN.trim());
  if (process.env.VIDEO_STUDIO_TOKEN_FILE) return (token = readFileSync(process.env.VIDEO_STUDIO_TOKEN_FILE, 'utf8').trim());
  const remote = process.env.VIDEO_STUDIO_REMOTE_ENV;
  if (remote && cfg.via === 'ssh') {
    if (!/^[A-Za-z]:[\\/][\w .\\/-]+$|^\/[\w .\/-]+$/.test(remote)) throw new Error('VIDEO_STUDIO_REMOTE_ENV is not a plain path');
    const ps = `(Select-String -Path '${remote.replace(/'/g, "''")}' -Pattern '^STUDIO_TOKEN=' | Select-Object -First 1).Line`;
    // -EncodedCommand: the remote shell is cmd, which splits a plain -Command at its `|` (measured on FRAYMUS-HOME)
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const line = await new Promise((res, rej) => execFile('ssh', [...sshArgs(cfg), 'powershell', '-NoProfile', '-EncodedCommand', encoded], { timeout: 20_000, windowsHide: true },
      (e, out) => (e ? rej(new Error('could not read the studio token over SSH')) : res(String(out).trim()))));
    const value = line.replace(/^STUDIO_TOKEN=/, '').trim();
    if (value.length < 8) throw new Error('the studio env file has no STUDIO_TOKEN');
    return (token = value);
  }
  throw new Error('no studio token: set VIDEO_STUDIO_TOKEN, VIDEO_STUDIO_TOKEN_FILE or VIDEO_STUDIO_REMOTE_ENV');
}

/** One call to the studio's HTTP API. */
export async function studioCall(path, { method = 'GET', body, raw = false, timeoutMs = 60_000 } = {}) {
  const cfg = studioConfig();
  if (!cfg) throw new Error('the video studio is not configured (VIDEO_STUDIO_URL)');
  if (cfg.refused) throw new Error(cfg.refused);
  await ensureTunnel(cfg);
  const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(path === '/health' ? {} : { Authorization: `Bearer ${await studioToken(cfg)}` }) };
  const res = await fetch(cfg.url + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401 || res.status === 403) { token = null; }
  if (raw) { if (!res.ok) throw new Error(`studio ${res.status}`); return res; }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* the studio answered with text */ }
  if (!res.ok) throw new Error(`studio ${res.status}: ${clip(json?.error || text, 200)}`);
  return json ?? { text: clip(text, 4000) };
}

export async function studioStatus() {
  const cfg = studioConfig();
  if (!cfg) return { configured: false };
  if (cfg.refused) return { configured: false, refused: cfg.refused };
  try { return { configured: true, via: cfg.via, host: cfg.host, ...(await studioCall('/health', { timeoutMs: 8000 })) }; }
  catch (e) { return { configured: true, via: cfg.via, host: cfg.host, ok: false, error: clip(e.message, 200) }; }
}

const SAFE_ID = /^[a-f0-9]{8,32}$/i, SAFE_FILE = /^[\w.-]{1,120}$/;
const str = (maxLength, description, extra = {}) => ({ type: 'string', maxLength, description, ...extra });

export function createVideoStudioTools() {
  return [
    {
      name: 'videostudio.recipes', group: 'videostudio', risk: 'safe',
      description: "List the film recipes of fraymus-video-studio on FRAYMUS-HOME (explainer, cartoon, 2bit, 8bit, comic-strip, music-video, song, avatar, cosmos, story-short) and the fields each takes.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => studioCall('/recipes'),
    },
    {
      name: 'videostudio.render', group: 'videostudio', risk: 'approval',
      description: "Render a film with fraymus-video-studio on FRAYMUS-HOME: pass a recipe and a markdown script. Returns a job id at once (renders take minutes); follow it with videostudio.job_status. Uses FRAYMUS-HOME's renderer and card, so it waits for a person to approve. For Chandra's own looks, studio.create is the usual tool.",
      parameters: { type: 'object', properties: {
        recipe: str(40, 'Recipe name from videostudio.recipes', { minLength: 1 }),
        script: str(40000, 'The script, in the studio markdown format the recipe expects', { minLength: 1 }),
        format: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Frame shape' },
        voice: str(80, 'Voice, e.g. piper:en_US-ryan-high or kokoro:af_heart'),
      }, required: ['recipe', 'script'], additionalProperties: false },
      execute: async ({ args }) => studioCall('/jobs', { method: 'POST', body: { recipe: args.recipe, script: args.script, options: { ...(args.format ? { format: args.format } : {}), ...(args.voice ? { voice: args.voice } : {}) } } }),
    },
    {
      name: 'videostudio.job_status', group: 'videostudio', risk: 'safe',
      description: 'Status of a fraymus-video-studio job: queued, running, done or error, its stage and progress, and the files it made.',
      parameters: { type: 'object', properties: { id: str(32, 'Job id from videostudio.render', { minLength: 8 }) }, required: ['id'], additionalProperties: false },
      execute: async ({ args }) => { if (!SAFE_ID.test(String(args.id))) throw new Error('not a studio job id'); return studioCall(`/jobs/${args.id}`); },
    },
    {
      name: 'videostudio.fetch_file', group: 'videostudio', risk: 'safe',
      description: "Copy one finished file of a fraymus-video-studio job (mp4, png, pdf, wav, mp3) into Chandra's library, so it appears on the shelf with where it came from.",
      parameters: { type: 'object', properties: { id: str(32, 'Job id', { minLength: 8 }), name: str(120, 'File name from videostudio.job_status', { minLength: 1 }) }, required: ['id', 'name'], additionalProperties: false },
      execute: async ({ args }) => {
        if (!SAFE_ID.test(String(args.id)) || !SAFE_FILE.test(String(args.name))) throw new Error('bad job id or file name');
        const ext = String(args.name).split('.').pop().toLowerCase();
        const kind = ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) ? 'media' : ['wav', 'mp3'].includes(ext) ? 'tts' : 'documents';
        const res = await studioCall(`/jobs/${args.id}/files/${encodeURIComponent(args.name)}`, { raw: true, timeoutMs: 300_000 });
        const bytes = Buffer.from(await res.arrayBuffer());
        const dir = join(DATA_DIR, kind); mkdirSync(dir, { recursive: true });
        const file = `${Date.now()}-videostudio-${args.id.slice(0, 8)}-${String(args.name).replace(/[^\w.-]/g, '_')}`;
        writeFileSync(join(dir, file), bytes);
        try { noteMedia(file, 'videostudioFetch', [`fraymus-video-studio job ${args.id}: ${args.name}`]); } catch (e) { console.error('[video-studio] provenance:', e.message); }
        return { saved: file, folder: kind, bytes: bytes.length };
      },
    },
    {
      name: 'videostudio.brain_search', group: 'videostudio', risk: 'safe',
      description: "Search fraymus-video-studio's own memory (lessons, cast, style rules) by keyword.",
      parameters: { type: 'object', properties: { query: str(300, 'What to look for', { minLength: 1 }), kind: str(40, 'Optional kind filter') }, required: ['query'], additionalProperties: false },
      execute: async ({ args }) => studioCall(`/brain/search?q=${encodeURIComponent(args.query)}${args.kind ? `&kind=${encodeURIComponent(args.kind)}` : ''}`),
    },
    {
      name: 'videostudio.brain_consult', group: 'videostudio', risk: 'safe',
      description: "Ask fraymus-video-studio's memory what it has learned about a film idea before making it: lessons, cast and style rules that apply.",
      parameters: { type: 'object', properties: { query: str(300, 'The film idea', { minLength: 1 }) }, required: ['query'], additionalProperties: false },
      execute: async ({ args }) => studioCall(`/brain/consult?q=${encodeURIComponent(args.query)}`),
    },
    {
      name: 'videostudio.brain_remember', group: 'videostudio', risk: 'approval',
      description: "Teach fraymus-video-studio one lesson (written into the studio's memory with its source). Waits for a person to approve, since it changes another agent's memory.",
      parameters: { type: 'object', properties: {
        slug: str(120, 'Where it goes, e.g. projects/lighthouse-short', { minLength: 3, pattern: '^[a-z0-9][a-z0-9/_-]+$' }),
        body: str(6000, 'The lesson', { minLength: 1 }), kind: str(40, 'e.g. lesson, style, cast'),
      }, required: ['slug', 'body'], additionalProperties: false },
      execute: async ({ args }) => studioCall('/brain/remember', { method: 'POST', body: { slug: args.slug, body: args.body, kind: args.kind || 'lesson', tags: ['chandra'], provenance: 'chandra-fraymus agent, approved by a person' } }),
    },
  ];
}

export function installVideoStudioRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/video-studio', route(async (_req, res) => res.json(await studioStatus())));
}
