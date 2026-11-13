/**
 * Dream capture (2026-11-13). Grounded dreams (dream-ground.js) are lessons the daemon may only keep when they cite
 * and quote what really happened in the hour. Until now a kept lesson was stored as text and nothing used it. This
 * gives each one two ways out, both through consumers that already exist and are measured:
 *
 *   code     every kept dream becomes a research item (source 'dream') and is translated by research-scout's
 *            translateItem with a dream-specific instruction into ONE of: an experiment on a live tunable (the
 *            self-modification kernel runs it for an hour and keeps or reverts it), a code change (built and
 *            tested on a branch a human merges), an idea (the verifier must prove a working model; a pass becomes
 *            a fossil and can become a skill), or none. Proposals are credited 'dream', apart from papers.
 *   video    once a day, the day's lessons become a short narrated flat-vector film (the "dream reel"), built
 *            from the lessons' own words split into narration lines — no writer model adds claims. Two framing
 *            lines are fixed text. The flat look's 17-rule checker still has to accept it.
 *
 * Nothing here writes outside Chandra; a dream that implies a code change still waits for a person to merge it.
 */
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateItem, moduleList, functionsByModule } from './research-scout.js';
import { isResourceConstrained } from './resource-envelope.js';
import { flatSeconds } from '../media/flat/plan.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const now = () => Date.now();
const H = 3600_000;
const ENABLED = process.env.DREAM_BRIDGE !== '0';
const TRANSLATE_PER_RUN = Math.max(1, parseInt(process.env.DREAM_TRANSLATE_PER_RUN, 10) || 2);
const TRANSLATE_PER_DAY = Math.max(1, parseInt(process.env.DREAM_TRANSLATE_PER_DAY, 10) || 8);
const BRIDGE_INTERVAL_MS = Math.max(5 * 60_000, parseInt(process.env.DREAM_BRIDGE_INTERVAL_MS, 10) || H);
const REEL_MIN_LESSONS = Math.max(1, parseInt(process.env.DREAM_REEL_MIN_LESSONS, 10) || 3);
const REEL_MAX_LESSONS = Math.max(1, parseInt(process.env.DREAM_REEL_MAX_LESSONS, 10) || 6);
const REEL_GAP_MS = Math.max(H, parseInt(process.env.DREAM_REEL_GAP_MS, 10) || 20 * H);
export const DREAM_RELEVANCE = 0.9;      // ahead of most papers in the kernel's queue, below nothing a person set

// ─── pure ───────────────────────────────────────────────────────────

/** A stored dream → { lesson, evidence: ['E3', …], quote }. dream-ground.storedText wrote it as `lesson [evidence E3, E7: "quote"]`. */
export function parseDream(text) {
  const s = String(text || '').trim();
  const m = s.match(/^([\s\S]*?)\s*\[evidence ([^\]:]*?)(?::\s*"([\s\S]*)")?\]\s*$/);
  if (!m) return { lesson: s, evidence: [], quote: null };
  return { lesson: m[1].trim(), evidence: m[2].split(',').map(x => x.trim()).filter(Boolean), quote: m[3] ? m[3].trim() : null };
}

/**
 * A lesson as narration lines of 6–12 words, using only its own words: split at clause boundaries (punctuation,
 * then as / with / while / because / which / leading / indicating), greedily filled up to 12 words. A line never
 * drops a word and never adds one.
 */
const CLAUSE_START = /^(as|with|while|because|which|leading|indicating|suggesting|showing|but|so|whereas|although)$/i;
const NO_END = /^(or|and|that|the|a|an|of|to|from|as|with|in|on|by|for|at|its|their|is|are|was|were|has|have|than|between|some|no)$/i;

export function splitLesson(lesson, { min = 4, max = 12 } = {}) {
  const words = String(lesson || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  // a good break is after punctuation or before a clause word — and never leaves a line ending on a function word
  const good = i => !NO_END.test(words[i].replace(/[^\w'-]/g, '')) && (/[,;:]$/.test(words[i]) || CLAUSE_START.test(words[i + 1] || ''));
  const cuts = [];
  let start = 0;
  while (words.length - start > max) {
    let cut = -1;
    for (let i = Math.min(start + max - 1, words.length - min - 1); i >= start + min - 1; i--) if (good(i)) { cut = i; break; }
    if (cut < 0) {   // no clause boundary: the longest line that leaves a tail of at least `min` and does not end on a function word
      const left = words.length - start;
      cut = start + (left - max < min ? Math.ceil(left / 2) : max) - 1;
      while (cut > start + min - 1 && NO_END.test(words[cut].replace(/[^\w'-]/g, ''))) cut--;
    }
    cuts.push([start, cut + 1]); start = cut + 1;
  }
  cuts.push([start, words.length]);
  // a line opens with a capital only where the sentence does, and ends with a stop only where the lesson does
  return cuts.map(([a, b], k) => {
    let s = words.slice(a, b).join(' ').replace(/[,;:]$/, '');
    if (k === 0) s = s.replace(/^./, c => c.toUpperCase());
    if (k === cuts.length - 1 && !/[.!?]$/.test(s)) s += '.';
    return s;
  });
}

const NEGATIVE = /\b(fail\w*|error\w*|low|no result|no memories|timed? ?out|timeout|stuck|crash\w*|drop\w*|poor\w*|spike\w*|declin\w*|wrong)\b/i;
const POSITIVE = /\b(improv\w*|success\w*|pass\w*|high quality|better|rose|grew|kept|proved)\b/i;
const SETTINGS = ['lab', 'room', 'space', 'city', 'micro', 'night'];
const SECOND = ['prof', 'dot', 'bru', 'zee', 'baron'];

/** The feeling a lesson's lines carry: a failure is sad or tired, a success proud or happy, anything else curious. */
export function feelingOf(text, i = 0) {
  if (NEGATIVE.test(text)) return i % 2 ? 'tired' : 'sad';
  if (POSITIVE.test(text)) return i % 2 ? 'happy' : 'proud';
  return 'curious';
}

/**
 * The reel's shot list: a fixed opening, each lesson's lines in order, a fixed close. The lead (nilo) is in every
 * shot; a second cast member and the setting change with each lesson, so the film visits several places.
 */
export function reelShots(lessons, { max = REEL_MAX_LESSONS } = {}) {
  const picked = lessons.slice(0, max);
  const shots = [{ say: 'Here is what I learned about myself today.', where: 'space', show: [], who: ['nilo'], feel: 'curious' }];
  picked.forEach((l, k) => {
    const lines = splitLesson(l.lesson);
    lines.forEach((say, j) => shots.push({ say, where: SETTINGS[k % SETTINGS.length], show: [], who: ['nilo', SECOND[k % SECOND.length]], feel: feelingOf(l.lesson, j) }));
  });
  shots.push({ say: 'Each of these came from what really happened.', where: 'space', show: [], who: ['nilo'], feel: 'proud' });
  return shots;
}

const GENERIC_STEM = new Set(['routes', 'tools', 'service', 'engine', 'index', 'shared', 'runtime', 'instance', 'cycle', 'loop', 'bridge', 'agent', 'agents']);
const wordsOf = s => String(s || '').toLowerCase().match(/[a-z]{4,}/g) || [];

/**
 * Source files a lesson may be about: those whose file-name words appear in the lesson ("world" → world-pollers.js,
 * "error spike" → health/monitor.js only through "error" if the name carries it). Ranked by how many words they
 * share; a plural or -ing form matches its stem. Pure: the caller passes the file list.
 */
export function relatedModules(lesson, files, max = 12) {
  const lw = wordsOf(lesson);
  const hit = t => lw.some(w => w === t || (t.length >= 5 && (w.startsWith(t) || t.startsWith(w) && w.length >= 5)));
  return files
    .map(f => { const stem = f.split('/').pop().replace(/\.(m?js|jsx)$/, ''); const toks = wordsOf(stem.replace(/[-_.]/g, ' ')).filter(t => !GENERIC_STEM.has(t)); return { f, score: toks.filter(hit).length }; })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f))
    .slice(0, max).map(x => x.f);
}

const MODULE_DIRS = ['server/intelligence', 'server/fleet', 'server/health', 'server/workflow', 'server/daemon', 'server/media', 'server/fraymus-os'];
function serverModules() {
  const out = [];
  for (const d of MODULE_DIRS) {
    try { for (const f of readdirSync(join(REPO_ROOT, d))) if (/\.(m?js)$/.test(f) && !/\.test\./.test(f)) out.push(`${d}/${f}`); }
    catch (e) { console.error('[dream-bridge] modules:', d, e.message); }
  }
  return out;
}

/**
 * How long the reel must be so the checker cuts no lesson: the flat look's own estimate (flatSeconds), with room
 * for the gaps between shots, clamped to what Make accepts.
 */
export function reelSeconds(shots) {
  return Math.max(15, Math.min(180, Math.ceil(flatSeconds(shots) * 1.08) + 2));
}

/** The instruction translateItem uses for a dream: the same four answers, read as a lesson about this system. */
export const DREAM_TRANSLATE_SYSTEM = `You are the self-improvement planner of Chandra-FRAYMUS, a local autonomous system that can change itself in exactly two ways: (A) move one of its LIVE TUNABLES inside declared bounds for a measured one-hour experiment, or (B) rewrite one function in one of its existing source files, tested on a branch a human merges.
The item is NOT a paper: it is a lesson the system learned about ITSELF in the last hour, with the evidence it quoted. Decide whether the lesson implies ONE concrete, falsifiable change. Never invent tunables or files.
Decision order: (1) if the lesson is about pacing, frequency, thresholds or capacity that an existing tunable controls → "experiment"; (2) if it names a fault in one existing module's behaviour (a query that returns nothing, a missing timeout, a loop that repeats) → "code", naming that module and the one function to change — the function must be one listed for that file in functionsByModule, written exactly as listed, or the answer is refused; if no listed function holds the fault, do not answer "code"; (3) if it describes a mechanism the system lacks and a small self-contained program could demonstrate → "idea"; (4) otherwise "none". A lesson that only says one agent did badly is "none": agent quality already drives selection and retirement.
Return ONLY JSON, one of:
{"kind":"experiment","tunable":"<exact name from the list>","value":<number inside its bounds>,"hypothesis":"<one sentence: the lesson → metric expected to move>","citation":"<the lesson, shortened>"}
{"kind":"code","targetFile":"<exact path from the module list>","sketch":"<what to change in one function, concretely>","rationale":"<why, grounded in the lesson's evidence>","citation":"<the lesson, shortened>"}
{"kind":"idea","idea":"<one or two sentences: the mechanism to build and prove>","citation":"<the lesson, shortened>"}
{"kind":"none","reason":"<short>"}`;

// ─── stores ────────────────────────────────────────────────────────

export function migrateDreamBridge() {
  db.exec(`CREATE TABLE IF NOT EXISTS dream_reels (
    id TEXT PRIMARY KEY, memory_ids TEXT NOT NULL, lessons INTEGER NOT NULL, job_id TEXT, status TEXT NOT NULL,
    file TEXT, seconds REAL, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)`);
}

const groundedSince = (since, limit = 200) => db.prepare(`SELECT id, key, value, created_at FROM agent_memories
  WHERE category = 'dream' AND source = 'daemon-dream-grounded' AND created_at > ? ORDER BY created_at ASC LIMIT ?`).all(since, limit);

/** Every kept dream not yet seen becomes a research item (status 'dream_new', so the paper scout leaves it alone). */
export function enqueueDreams() {
  const rows = groundedSince(0, 2000);
  const insert = db.prepare(`INSERT OR IGNORE INTO research_items (id, source, ext_id, title, abstract, url, published_at, topic, relevance, relevance_terms, status, fetched_at)
    VALUES (?, 'dream', ?, ?, ?, ?, ?, 'self', ?, '[]', 'dream_new', ?)`);
  let added = 0;
  for (const r of rows) {
    const d = parseDream(r.value);
    const abstract = `${d.lesson}${d.quote ? `\nEvidence (${d.evidence.join(', ')}): "${d.quote}"` : ''}`;
    added += insert.run(`dream:${r.id}`, String(r.id), d.lesson.slice(0, 400), abstract.slice(0, 2000), `chandra://memory/${r.id}`, new Date(r.created_at).toISOString(), DREAM_RELEVANCE, now()).changes;
  }
  return { dreams: rows.length, added };
}

let bridging = false;
/** Translate up to `max` waiting dreams (the daily cap counts what was translated in 24 h). */
export async function runDreamBridge({ max = TRANSLATE_PER_RUN, force = false } = {}) {
  if (bridging) return { ran: false, reason: 'already running' };
  if (!force && isResourceConstrained()) return { ran: false, reason: 'resource_constrained' };
  bridging = true;
  try {
    const queued = enqueueDreams();
    const today = db.prepare("SELECT COUNT(*) n FROM research_items WHERE source = 'dream' AND status IN ('translated', 'ignored') AND fetched_at > ?").get(now() - 24 * H).n;
    const room = force ? max : Math.max(0, Math.min(max, TRANSLATE_PER_DAY - today));
    const waiting = db.prepare("SELECT id, title, abstract FROM research_items WHERE source = 'dream' AND status = 'dream_new' ORDER BY published_at ASC LIMIT ?").all(room);
    const files = serverModules();
    const mapped = moduleList();
    const out = [];
    for (const it of waiting) {
      // the files the lesson names come first, so a "code" answer can point at the module that really holds the fault
      const related = relatedModules(it.abstract, files);
      const modules = [...new Set([...related, ...mapped])];
      // and the real function names in those files: a code answer must name one of them or it is refused
      const extra = { functionsByModule: functionsByModule(related.slice(0, 6)) };
      let r;
      try { r = await translateItem(it.id, { system: DREAM_TRANSLATE_SYSTEM, modules, extra }); }
      catch (e) { r = { ok: false, error: e.message }; }
      if (!r?.ok) { console.error('[dream-bridge] translate:', it.id, r?.error); break; }      // a dropped call: try again next run
      db.prepare('UPDATE research_items SET fetched_at = ? WHERE id = ?').run(now(), it.id);   // when it was decided, for the daily cap
      out.push({ itemId: it.id, kind: r.kind, proposalId: r.proposalId, reason: r.reason });
      try { publish('dream-bridge', 'system.dream', JSON.stringify({ action: 'dream_translated', itemId: it.id, kind: r.kind, proposalId: r.proposalId, lesson: it.title })); } catch (e) { console.error('[dream-bridge] publish:', e.message); }
    }
    return { ran: true, ...queued, translatedToday: today, translated: out };
  } finally { bridging = false; }
}

/** Make today's reel if enough new lessons wait and the last one is older than the gap (or force). */
export async function makeDreamReel({ force = false, createFromRequest = null } = {}) {
  migrateDreamBridge();
  const last = db.prepare("SELECT MAX(created_at) t FROM dream_reels WHERE status IN ('rendering', 'done')").get().t || 0;
  if (!force && now() - last < REEL_GAP_MS) return { made: false, reason: 'made recently', last };
  const used = new Set(db.prepare("SELECT memory_ids FROM dream_reels WHERE status IN ('rendering', 'done')").all().flatMap(r => JSON.parse(r.memory_ids)));
  const fresh = groundedSince(now() - 48 * H).filter(r => !used.has(r.id)).map(r => ({ id: r.id, ...parseDream(r.value) }));
  if (fresh.length < (force ? 1 : REEL_MIN_LESSONS)) return { made: false, reason: 'not enough new lessons', waiting: fresh.length, needed: REEL_MIN_LESSONS };
  const lessons = fresh.slice(-REEL_MAX_LESSONS);
  const shots = reelShots(lessons);
  const create = createFromRequest || (await import('../media/make.js')).createFromRequest;
  const id = `reel_${now().toString(36)}`;
  db.prepare("INSERT INTO dream_reels (id, memory_ids, lessons, status, created_at) VALUES (?, ?, ?, 'rendering', ?)").run(id, JSON.stringify(lessons.map(l => l.id)), lessons.length, now());
  let started;
  try {
    started = await create({ request: `a flat vector reel of what Chandra learned about itself today: ${lessons.length} lessons`, style: 'flat', kind: 'video', format: '16:9', seconds: reelSeconds(shots),
      title: `What I learned, ${new Date().toISOString().slice(0, 10)}`, scenes: shots, source: 'dream-reel' });
  } catch (e) { started = { accepted: false, reason: e.message }; }
  if (!started?.accepted) {
    db.prepare("UPDATE dream_reels SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(String(started?.reason || started?.message || 'refused').slice(0, 400), now(), id);
    return { made: false, reason: started?.reason || 'refused', reelId: id };
  }
  db.prepare('UPDATE dream_reels SET job_id = ? WHERE id = ?').run(started.id, id);
  return { made: true, reelId: id, jobId: started.id, lessons: lessons.length, shots: shots.length };
}

/** Close reels whose render finished: file and length from the creation job. */
export function settleReels() {
  migrateDreamBridge();
  // a reel whose job was never recorded (the process died between the two writes) cannot finish
  let settled = db.prepare("UPDATE dream_reels SET status = 'error', error = 'no render job was recorded', finished_at = ? WHERE status = 'rendering' AND job_id IS NULL AND created_at < ?").run(now(), now() - 10 * 60_000).changes;
  for (const r of db.prepare("SELECT id, job_id FROM dream_reels WHERE status = 'rendering' AND job_id IS NOT NULL").all()) {
    let job;
    try { job = db.prepare('SELECT status, output, error FROM creation_jobs WHERE id = ?').get(r.job_id); } catch (e) { console.error('[dream-bridge] job:', e.message); continue; }
    if (!job || job.status === 'queued' || job.status === 'running') continue;
    let out = {}; try { out = JSON.parse(job.output || '{}'); } catch { out = {}; }
    if (job.status === 'completed' && out.file) {
      db.prepare("UPDATE dream_reels SET status = 'done', file = ?, seconds = ?, finished_at = ? WHERE id = ?").run(out.file, out.seconds || null, now(), r.id);
      const lessons = db.prepare('SELECT lessons FROM dream_reels WHERE id = ?').get(r.id).lessons;
      try { publish('dream-bridge', 'system.dream', JSON.stringify({ action: 'reel_ready', reelId: r.id, file: out.file, seconds: out.seconds, lessons })); } catch (e) { console.error('[dream-bridge] publish:', e.message); }
    } else db.prepare("UPDATE dream_reels SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(String(job.error || job.status).slice(0, 400), now(), r.id);
    settled++;
  }
  return settled;
}

export function dreamBridgeStatus() {
  try {
    migrateDreamBridge();
    const items = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM research_items WHERE source = 'dream' GROUP BY status").all().map(r => [r.status, r.n]));
    const proposals = db.prepare(`SELECT p.kind, p.status, COUNT(*) n FROM research_proposals p JOIN research_items i ON i.id = p.item_id WHERE i.source = 'dream' GROUP BY p.kind, p.status`).all();
    const recent = db.prepare(`SELECT i.id, i.title, i.status, i.translate_note, p.kind, p.status AS proposal_status FROM research_items i LEFT JOIN research_proposals p ON p.item_id = i.id
      WHERE i.source = 'dream' AND i.status != 'dream_new' ORDER BY i.fetched_at DESC LIMIT 10`).all();
    const reels = db.prepare('SELECT id, lessons, status, file, seconds, error, created_at, finished_at FROM dream_reels ORDER BY created_at DESC LIMIT 10').all();
    const kept = db.prepare("SELECT COUNT(*) n FROM agent_memories WHERE category = 'dream' AND source = 'daemon-dream-grounded'").get().n;
    return { enabled: ENABLED, keptDreams: kept, items, proposals, recent, reels, running: !!timer, limits: { perRun: TRANSLATE_PER_RUN, perDay: TRANSLATE_PER_DAY, reelMin: REEL_MIN_LESSONS, reelMax: REEL_MAX_LESSONS, reelGapH: REEL_GAP_MS / H } };
  } catch (e) { return { error: e.message }; }
}

let timer = null;
export function startDreamBridge() {
  if (!ENABLED || timer) return { started: false };
  migrateDreamBridge();
  const tick = async () => {
    try { settleReels(); } catch (e) { console.error('[dream-bridge] settle:', e.message); }
    try { await runDreamBridge(); } catch (e) { console.error('[dream-bridge] run:', e.message); }
    try { await makeDreamReel(); } catch (e) { console.error('[dream-bridge] reel:', e.message); }
  };
  timer = setInterval(tick, BRIDGE_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 120_000).unref?.();
  return { started: true, intervalMs: BRIDGE_INTERVAL_MS };
}
export function stopDreamBridge() { if (timer) clearInterval(timer); timer = null; }

export function installDreamBridgeRoutes(app) {
  const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
  app.get('/api/intelligence/dreams/bridge', route((_req, res) => res.json(dreamBridgeStatus())));
  app.post('/api/intelligence/dreams/bridge/run', route(async (req, res) => res.json(await runDreamBridge({ max: Math.min(10, Math.max(1, parseInt(req.body?.max, 10) || TRANSLATE_PER_RUN)), force: true }))));
  app.post('/api/intelligence/dreams/reel', route(async (_req, res) => res.json(await makeDreamReel({ force: true }))));
  app.post('/api/intelligence/dreams/reel/settle', route((_req, res) => res.json({ settled: settleReels() })));
}
