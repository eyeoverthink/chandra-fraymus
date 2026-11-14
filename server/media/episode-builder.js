/**
 * Episodes: a premise becomes a multi-act film — an outline, each act made by Make as its own checked flat (or stick)
 * film, joined with title cards into one episode on the shelf.
 *
 * Gap 7 in docs/NEXUS-ENGINE-CREATION-METHODS.md (Nexus /api/cartoon/episode). The plan and its checks are in
 * episode-plan.js; this file runs the job:
 *   premise   — given, or (topical) something the world poller found on the web recently, recorded with its address
 *   facts     — looked up once for the premise (Make's groundFacts), or that page's own snippet, handed to every act
 *   outline   — one model call, refused and re-asked with the reason (≤ 3 attempts)
 *   acts      — one Make job each, in order; act k is handed the last lines of act k−1 (rule 18 in the flat checker
 *               refuses an act that skips its beat or repeats an earlier line). Each act also passes Make's own 17 plan
 *               rules and 11 film checks, or it is not on the shelf. An act that fails is tried once more.
 *   assembly  — an episode card, an act card before each act, every segment normalised to one encoding, then joined
 *   check     — the episode opens, has picture and sound, and lasts the sum of its parts (± 1.5 s)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { db } from '../db.js';
import { mayRecoverAtBoot, DATA_DIR } from '../config.js';
import { publish } from '../fleet/bus.js';
import { chatOllama } from '../commerce/shared.js';
import { createFromRequest, getCreation, groundFacts } from './make.js';
import { shelveClip } from './looks/convert.js';
import { FORMATS } from './flat/kit.js';
import { FONT } from './flat/scene.js';
import { outlineMessages, checkOutline, actContext, topicalPick, EPISODE_LOOKS, ACTS_MIN, ACTS_MAX, SECONDS_PER_ACT } from './episode-plan.js';

const run = promisify(execFile);
const clip = (s, n) => String(s ?? '').slice(0, n);
const now = () => Date.now();
const emit = p => { try { publish('studio', 'system.studio', JSON.stringify(p)); } catch (e) { console.error('[episodes] publish:', e.message); } };
const CREATIONS = join(DATA_DIR, 'creations');
/** One act may take this long in Make (writing, voicing, drawing) before the episode gives up on it. */
const ACT_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.EPISODE_ACT_TIMEOUT_MS, 10) || 30 * 60_000);
export const CARD = Object.freeze({ episodeSeconds: 3.0, actSeconds: 1.6, bg: '#1b2440', fg: '#ffffff', accent: '#ffcc4d' });
/** The joined episode may differ from the sum of its parts by this much (encoder rounding at each join). */
export const LENGTH_TOLERANCE = 1.5;

db.exec(`CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, premise TEXT, style TEXT, format TEXT, acts_asked INTEGER, seconds_per_act INTEGER, status TEXT NOT NULL, stage TEXT,
  topical TEXT, outline TEXT, acts TEXT, file TEXT, check_result TEXT, error TEXT, source TEXT, created_at INTEGER, completed_at INTEGER)`);
if (mayRecoverAtBoot()) db.prepare(`UPDATE episodes SET status = 'error', error = 'interrupted by restart', completed_at = ? WHERE status IN ('queued', 'running')`).run(now());

const setE = (id, f) => { const k = Object.keys(f); db.prepare(`UPDATE episodes SET ${k.map(x => `${x} = ?`).join(', ')} WHERE id = ?`).run(...k.map(x => (typeof f[x] === 'object' && f[x] !== null ? JSON.stringify(f[x]) : f[x])), id); };
const parse = s => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
const rowOut = r => r && ({ id: r.id, premise: r.premise, style: r.style, format: r.format, actsAsked: r.acts_asked, secondsPerAct: r.seconds_per_act, status: r.status, stage: r.stage,
  topical: parse(r.topical), outline: parse(r.outline), acts: parse(r.acts) || [], file: r.file, url: r.file ? `/api/hermes/artifacts/media?kind=video&id=${r.file}` : null,
  check: parse(r.check_result), error: r.error, source: r.source, createdAt: r.created_at, completedAt: r.completed_at });
export const getEpisode = id => rowOut(db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(String(id)));
export const listEpisodes = (limit = 10) => db.prepare(`SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?`).all(Math.min(50, Math.max(1, parseInt(limit, 10) || 10))).map(rowOut);

// ── cards and joining ────────────────────────────────────────────────────────────────────────────────

/** Fit text into lines no wider than maxW at the given font. */
function wrap(ctx, text, maxW) {
  const out = []; let line = '';
  for (const w of String(text).split(/\s+/).filter(Boolean)) { const t = line ? `${line} ${w}` : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
  if (line) out.push(line);
  return out;
}
/** A title card as PNG: a small label above, a big title, an optional line below. */
export function cardPng({ label = '', title, sub = '' }, format = '16:9') {
  const [w, h] = FORMATS[format] || FORMATS['16:9'], c = createCanvas(w, h), ctx = c.getContext('2d'), u = Math.min(w, h) / 1080;
  ctx.fillStyle = CARD.bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = CARD.accent; ctx.fillRect(w / 2 - 60 * u, h * 0.5 + 30 * u, 120 * u, 8 * u);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (label) { ctx.fillStyle = CARD.accent; ctx.font = `${Math.round(40 * u)}px ${FONT}`; ctx.fillText(label.toUpperCase(), w / 2, h * 0.5 - 120 * u); }
  ctx.fillStyle = CARD.fg; ctx.font = `${Math.round(96 * u)}px ${FONT}`;
  const lines = wrap(ctx, title, w * 0.84).slice(0, 2);
  lines.forEach((l, i) => ctx.fillText(l, w / 2, h * 0.5 - (lines.length - 1 - i) * 104 * u));
  if (sub) { ctx.font = `${Math.round(36 * u)}px Arial, sans-serif`; ctx.globalAlpha = 0.85; wrap(ctx, sub, w * 0.7).slice(0, 3).forEach((l, i) => ctx.fillText(l, w / 2, h * 0.5 + 110 * u + i * 48 * u)); ctx.globalAlpha = 1; }
  return c.toBuffer('image/png');
}

const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];
/** A card as a short clip with silence, in the episode's encoding. */
async function cardClip(png, seconds, out) {
  await run('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-t', seconds.toFixed(2), '-i', png, '-f', 'lavfi', '-t', seconds.toFixed(2), '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', 'fade=t=in:st=0:d=0.25,fade=t=out:st=' + Math.max(0, seconds - 0.25).toFixed(2) + ':d=0.25', ...ENCODE, '-shortest', out], { timeout: 120_000, windowsHide: true });
}
/** An act's film re-encoded to the episode's encoding and size (so the joined file is one consistent stream). */
async function normalise(src, out, [w, h]) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`, ...ENCODE, out], { timeout: 900_000, windowsHide: true });
}
export async function durationOf(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path], { timeout: 60_000, windowsHide: true });
  const j = JSON.parse(stdout);
  return { seconds: +(+j.format?.duration || 0).toFixed(2), video: (j.streams || []).some(s => s.codec_type === 'video'), audio: (j.streams || []).some(s => s.codec_type === 'audio') };
}
/** Join clips (same encoding) with the concat demuxer; no re-encode. */
async function join_(parts, out, dir) {
  const list = join(dir, 'parts.txt');
  writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { timeout: 600_000, windowsHide: true });
}

/**
 * The episode card, then a card before each act, every act re-encoded to one size and encoding, all joined.
 * `acts` = [{ n, title, path }]. Returns the joined file, its parts, each part's measured length and the whole.
 */
export async function assemble({ dir, format = '16:9', title, logline = '', acts, onStage = () => {} }) {
  const size = FORMATS[format] || FORMATS['16:9'], parts = [], lengths = [];
  const ep = join(dir, 'card-episode.png');
  writeFileSync(ep, cardPng({ label: 'An episode', title, sub: logline }, format));
  await cardClip(ep, CARD.episodeSeconds, join(dir, 'seg-00-card.mp4')); parts.push(join(dir, 'seg-00-card.mp4'));
  for (const a of acts) {
    const n = String(a.n).padStart(2, '0'), card = join(dir, `card-act-${a.n}.png`), cardMp4 = join(dir, `seg-${n}a-card.mp4`), actMp4 = join(dir, `seg-${n}b-act.mp4`);
    writeFileSync(card, cardPng({ label: `Act ${a.n} of ${acts.length}`, title: a.title }, format));
    await cardClip(card, CARD.actSeconds, cardMp4);
    onStage(`joining the acts: act ${a.n} of ${acts.length}`);
    await normalise(a.path, actMp4, size);
    parts.push(cardMp4, actMp4);
  }
  for (const p of parts) lengths.push((await durationOf(p)).seconds);
  const out = join(dir, 'episode.mp4');
  await join_(parts, out, dir);
  return { out, parts, lengths, measured: await durationOf(out) };
}

/** Check a joined episode against its parts. Pure on the numbers measured. */
export function checkEpisode({ measured, parts, actsAsked, actsMade }) {
  const expected = +parts.reduce((s, p) => s + p, 0).toFixed(2);
  const checks = [
    { name: 'opens', ok: measured.seconds > 0, detail: `${measured.seconds} s` },
    { name: 'picture and sound', ok: measured.video && measured.audio, detail: `video ${measured.video}, audio ${measured.audio}` },
    { name: 'every act', ok: actsMade === actsAsked, detail: `${actsMade} of ${actsAsked} acts` },
    { name: 'length is the sum of its parts', ok: Math.abs(measured.seconds - expected) <= LENGTH_TOLERANCE, detail: `${measured.seconds} s measured, ${expected} s expected` },
  ];
  return { ok: checks.every(c => c.ok), checks, expected };
}

// ── the job ──────────────────────────────────────────────────────────────────────────────────────────

async function waitCreation(id, onStage) {
  const t0 = now();
  for (;;) {
    const j = getCreation(id);
    if (!j) throw new Error(`the act's job ${id} disappeared`);
    if (j.status === 'completed') return j;
    if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || j.status);
    onStage(j.stage);
    if (now() - t0 > ACT_TIMEOUT_MS) throw new Error(`the act took over ${Math.round(ACT_TIMEOUT_MS / 60_000)} minutes`);
    await new Promise(r => setTimeout(r, 3000));
  }
}

async function writeOutline(premise, { acts, secondsPerAct, facts, topical, onStage }) {
  let feedback = null, last = null;
  for (let n = 1; n <= 3; n++) {
    onStage(`outlining the episode${n > 1 ? `, attempt ${n}` : ''}`);
    const raw = await chatOllama(outlineMessages(premise, { acts, secondsPerAct, facts, topical, feedback }), { format: 'json', temperature: 0.6, maxTokens: 1800, priority: 'goal', label: 'episodes:outline', timeoutMs: 240_000 });
    last = checkOutline(raw, { acts });
    if (last.ok) return { ...last, attempts: n };
    feedback = last.reason;
  }
  throw new Error(`no usable outline after 3 attempts (${last?.reason})`);
}

async function runEpisode(id, { premise, acts, secondsPerAct, style, format, topical }) {
  const t0 = now(), dir = join(CREATIONS, id);
  mkdirSync(dir, { recursive: true });
  setE(id, { status: 'running', stage: 'starting' });
  const made = [];
  try {
    // the premise: given, or something the web watch found recently
    let pick = null;
    if (!premise) {
      setE(id, { stage: 'choosing something found on the web recently' });
      const used = new Set(db.prepare(`SELECT topical FROM episodes WHERE topical IS NOT NULL`).all().map(r => parse(r.topical)?.url).filter(Boolean));
      let rows = [];
      try { rows = db.prepare(`SELECT title, url, snippet, observed_at FROM world_observations WHERE kind = 'web' ORDER BY observed_at DESC LIMIT 40`).all(); } catch (e) { console.error('[episodes] observations:', e.message); }
      pick = topicalPick(rows, used);
      if (!pick) throw new Error('no premise was given and the web watch has found nothing recent that holds a story');
      premise = `${pick.title}. ${pick.snippet}`.trim();
      setE(id, { premise: clip(premise, 600), topical: pick });
    }
    // facts, once for the whole episode
    setE(id, { stage: 'reading about the premise' });
    const looked = pick ? { text: pick.snippet || pick.title, source: `the page "${clip(pick.title, 100)}"`, url: pick.url, why: 'from the page the premise came from' } : await groundFacts(premise);
    const facts = looked.text ? { text: looked.text, source: looked.source, url: looked.url, why: looked.why } : { text: null, why: looked.why };
    // the outline
    const o = await writeOutline(premise, { acts, secondsPerAct, facts: facts.text ? facts : null, topical: pick, onStage: s => setE(id, { stage: s }) });
    const outline = o.outline;
    setE(id, { outline: { ...outline, fixes: o.fixes, attempts: o.attempts, facts: { source: facts.source || null, url: facts.url || null, note: facts.why || null } } });
    writeFileSync(join(dir, 'outline.json'), JSON.stringify({ premise, outline, fixes: o.fixes, facts }, null, 2), 'utf8');

    // the acts, in order; each is handed how the story stands
    for (let k = 1; k <= outline.acts.length; k++) {
      const act = outline.acts[k - 1];
      const ctx = { ...actContext(outline, k, made), facts: facts.text ? facts : null };
      let job = null, tries = 0, lastErr = null;
      while (!job && tries < 2) {
        tries++;
        setE(id, { stage: `act ${k} of ${outline.acts.length}: queued${tries > 1 ? ' (second try)' : ''}` });
        const req = clip(`Act ${k} of ${outline.acts.length} of "${outline.title}" (${act.title}): ${act.beat}`, 1400);
        const r = await createFromRequest({ request: req, kind: 'video', style, seconds: secondsPerAct, format, title: `${outline.title}: ${act.title}`, episode: ctx, source: 'episode' });
        if (!r.accepted) throw new Error(`act ${k} was not accepted by Make: ${r.message || r.reason}`);
        try { job = await waitCreation(r.id, s => setE(id, { stage: `act ${k} of ${outline.acts.length}: ${s}` })); }
        catch (e) { lastErr = e; console.error(`[episodes] ${id} act ${k} try ${tries}:`, e.message); }
      }
      if (!job) throw new Error(`act ${k} ("${act.title}") failed twice: ${clip(lastErr?.message, 300)}`);
      const shotsFile = job.output?.folder ? join(job.output.folder, 'shots.json') : null;
      const shots = shotsFile && existsSync(shotsFile) ? (parse(readFileSync(shotsFile, 'utf8'))?.shots || []) : [];
      made.push({ n: k, title: act.title, beat: act.beat, job: job.id, file: job.output.file, seconds: job.output.seconds, shots: shots.map(s => ({ say: s.say })), tries,
        rule18: (job.output.rules || []).find(r => r.n === 18) || null, checks: (job.output.checks || []).filter(c => c.ok).length + ' of ' + (job.output.checks || []).length + ' film checks' });
      setE(id, { acts: made });
    }

    setE(id, { stage: 'joining the acts' });
    const { out, parts, lengths, measured } = await assemble({ dir, format, title: outline.title, logline: outline.logline,
      acts: made.map(m => ({ n: m.n, title: m.title, path: join(DATA_DIR, 'video', m.file) })), onStage: s => setE(id, { stage: s }) });
    const verdict = checkEpisode({ measured, parts: lengths, actsAsked: outline.acts.length, actsMade: made.length });
    const record = { premise, topical: pick, outline, acts: made, parts: parts.map((p, i) => ({ file: p.split(/[\\/]/).pop(), seconds: lengths[i] })), check: verdict, madeAt: new Date().toISOString() };
    writeFileSync(join(dir, 'episode.json'), JSON.stringify(record, null, 2), 'utf8');
    if (!verdict.ok) throw Object.assign(new Error(`the joined episode failed its check: ${verdict.checks.filter(c => !c.ok).map(c => `${c.name} (${c.detail})`).join('; ')}; it is kept in ${dir}`), { check: verdict });
    const file = shelveClip(readFileSync(out), { op: 'episode', note: outline.title, params: { premise: clip(premise, 300), acts: made.length, seconds: measured.seconds, style, format, actJobs: made.map(m => m.job), topical: pick?.url || null }, source: 'creation' });
    setE(id, { status: 'completed', stage: 'done', file, check_result: { ...verdict, seconds: measured.seconds, minutes: +((now() - t0) / 60_000).toFixed(1) }, completed_at: now() });
    emit({ action: 'episode_ready', id, file, title: outline.title, acts: made.length, seconds: measured.seconds });
  } catch (e) {
    setE(id, { status: 'error', stage: 'failed', error: clip(e.message, 600), check_result: e.check || null, completed_at: now() });
    emit({ action: 'episode_failed', id, error: clip(e.message, 200) });
  }
}

const tail = { p: Promise.resolve() };
/** Start an episode. No premise → one is taken from a recent web find (`topical`). Returns at once. */
export function startEpisode({ premise = '', acts = 4, secondsPerAct = SECONDS_PER_ACT.default, style = 'flat', format = '16:9', source = 'api' } = {}) {
  const text = clip(premise, 600).replace(/\s+/g, ' ').trim();
  if (!EPISODE_LOOKS.includes(style)) throw Object.assign(new Error(`episodes are made in the ${EPISODE_LOOKS.join(' or ')} look`), { status: 400 });
  if (!FORMATS[format]) throw Object.assign(new Error(`format must be one of ${Object.keys(FORMATS).join(', ')}`), { status: 400 });
  const n = Math.max(ACTS_MIN, Math.min(ACTS_MAX, parseInt(acts, 10) || 4));
  const secs = Math.max(SECONDS_PER_ACT.min, Math.min(SECONDS_PER_ACT.max, parseInt(secondsPerAct, 10) || SECONDS_PER_ACT.default));
  const open = db.prepare(`SELECT COUNT(*) n FROM episodes WHERE status IN ('queued', 'running')`).get().n;
  if (open >= 2) throw Object.assign(new Error(`${open} episodes are already being made; each takes many minutes`), { status: 429 });
  const id = `ep-${randomUUID().slice(0, 10)}`;
  db.prepare(`INSERT INTO episodes (id, premise, style, format, acts_asked, seconds_per_act, status, stage, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?)`).run(id, text || null, style, format, n, secs, source, now());
  const done = tail.p.then(() => runEpisode(id, { premise: text, acts: n, secondsPerAct: secs, style, format }));
  tail.p = done.catch(e => console.error('[episodes] queue:', e.message));
  return { id, status: 'queued', acts: n, secondsPerAct: secs, topical: !text, done };
}

// ── tools and routes ─────────────────────────────────────────────────────────────────────────────────

export function createEpisodeTools() {
  return [
    { name: 'episode.create', group: 'studio', risk: 'safe', ownsReply: true,
      description: 'Make a multi-act animated episode (flat or stick figures, narrated in Vaughn\'s voice): a premise becomes an outline of 3 to 8 acts, each act is made and checked as its own film, and the acts are joined with title cards into one episode on the shelf. With no premise, one is taken from something Chandra\'s web watch found recently (a page that holds a story, never a reference, stock or how-to page). Takes many minutes. Returns a job id.',
      parameters: { type: 'object', properties: {
        premise: { type: 'string', description: "What the episode is about, in the user's words (leave empty for a premise from something found on the web recently)" },
        acts: { type: 'integer', description: 'Number of acts, 3 to 8 (default 4)' },
        secondsPerAct: { type: 'integer', description: 'Length of each act in seconds, 15 to 60 (default 25)' },
        style: { type: 'string', enum: [...EPISODE_LOOKS], description: 'flat (default) or stick' },
        format: { type: 'string', enum: Object.keys(FORMATS), description: 'Shape (default 16:9)' } } },
      execute: async ({ args = {} } = {}) => {
        try {
          const r = startEpisode({ ...args, source: 'agent' });
          return { jobId: r.id, status: r.status, acts: r.acts, replyToUser: `I have started the episode (${r.acts} acts of about ${r.secondsPerAct} seconds${r.topical ? ', from something found on the web recently' : ''}). It is not finished yet: it is outlined, every act is made and checked as its own film, then they are joined; it appears on the shelf only if every act passes. Job ${r.id}.` };
        } catch (e) { return { error: clip(e.message, 300), replyToUser: `I did not start the episode. ${clip(e.message, 300)}` }; }
      } },
    { name: 'episode.status', group: 'studio', risk: 'safe',
      description: 'Progress and result of an episode started with episode.create: stage, outline, each act and its checks, the joined file.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      execute: async ({ args = {} } = {}) => (args.id ? (getEpisode(args.id) || { error: 'no such episode' }) : { episodes: listEpisodes(5) }) },
  ];
}

export function installEpisodeRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => (e.status ? res.status(e.status).json({ error: e.message }) : next(e)));
  app.get('/api/episodes', route((req, res) => res.json({ episodes: listEpisodes(req.query.limit), looks: EPISODE_LOOKS, acts: { min: ACTS_MIN, max: ACTS_MAX }, secondsPerAct: SECONDS_PER_ACT })));
  app.post('/api/episodes', route((req, res) => { const r = startEpisode({ ...(req.body || {}), source: 'api' }); res.status(202).json({ id: r.id, status: r.status, acts: r.acts, secondsPerAct: r.secondsPerAct, topical: r.topical }); }));
  app.get('/api/episodes/:id', route((req, res) => { const e = getEpisode(req.params.id); if (!e) return res.status(404).json({ error: 'no such episode' }); res.json(e); }));
}
