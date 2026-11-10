/**
 * Narrator — the organism speaks about what it did (absorbed from looseScrew's Avatar Host).
 *
 * Chandra had a TTS cascade (Piper → edge-tts → SAPI), an OBS overlay on /ws/obs, and a bus
 * full of events — none connected. This module subscribes to the few bus topics that mean
 * something happened in the world (a goal completed well, a human vote, a consciousness tier
 * change, an REA verdict, a retirement, a digest posted, a world scan) and turns each into
 * one spoken line: deterministic template → TTS clip → overlay card with audio → row in
 * `narrations` → bus `system.narration`. No LLM in the path; narration is a report, not a
 * performance.
 *
 * Economy: lines are rate-limited (NARRATOR_MIN_GAP_MS, 45 s), the queue holds 5, and audio is
 * synthesised only while an overlay client is connected (or NARRATOR_ALWAYS=1) — otherwise
 * the line is logged as text so the record exists without burning TTS calls on nobody.
 * Operators and agents can also speak directly: POST /api/intelligence/narrator/say, fleet
 * tool `narrate`.
 */

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { db } from '../db.js';
import { onTopic, offTopic, publish } from '../fleet/bus.js';
import { tunable } from './tunables.js';
import { ttsSpeak } from '../media/tts-engine.js';
import { getObsBridge } from '../streaming/overlay.js';

const now = () => Date.now();
const AGENT = 'narrator';
const ENABLED = process.env.NARRATOR_ENABLED !== '0';
const DEFAULT_GAP_MS = Math.max(5_000, parseInt(process.env.NARRATOR_MIN_GAP_MS, 10) || 45_000);
const minGapMs = () => tunable('narrator.min_gap_ms', DEFAULT_GAP_MS); // Phase Y: live tunable
const ALWAYS = process.env.NARRATOR_ALWAYS === '1';
const VOICE = process.env.NARRATOR_VOICE || 'en-US-GuyNeural';
const QUEUE_MAX = 5;
const MIN_GOAL_QUALITY = 0.5;

let running = false;
let lastSpokenAt = 0;
let speaking = false;          // a speak() in flight holds the gap; pump() waits for it
let timer = null;
const queue = [];
const DEDUP_WINDOW_MS = 10 * 60_000;
const state = { spoken: 0, textOnly: 0, dropped: 0, ttsErrors: 0, lastLine: null, lastAt: 0, byTopic: {} };

function ensureTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS narrations (
    id TEXT PRIMARY KEY,
    topic TEXT,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    audio_url TEXT,
    engine TEXT,
    duration_est INTEGER,
    overlay_clients INTEGER DEFAULT 0,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_narrations_ts ON narrations(created_at)`).run();
}
try { ensureTable(); } catch (e) { console.error('[narrator] schema:', e.message); }

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const parse = p => { try { return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch (_) { return {}; } };

// ─── Event → line ────────────────────────────────────────────────
// Each returns a sentence or null (nothing worth saying). Numbers come from the payload.

const LINES = {
  'system.goals': p => {
    if (p.action === 'goal_executed' && p.status === 'completed' && Number(p.quality) >= MIN_GOAL_QUALITY)
      return { kind: 'goal', text: `Goal complete. ${clip(p.objective, 110)} — by ${p.agentId}, quality ${Number(p.quality).toFixed(2)}.` };
    if (p.action === 'human_feedback')
      return { kind: 'feedback', text: `Vaughn rated ${p.agentId}'s result ${p.rating > 0 ? 'useful' : 'not useful'}.${p.note ? ' ' + clip(p.note, 100) : ''}` };
    if (p.action === 'goal_shelved')
      return { kind: 'goal', text: `Shelved a goal with a poor track record: ${clip(p.objective, 90)}.` };
    return null;
  },
  'system.consciousness.transition': p => ({ kind: 'consciousness', text: `Consciousness moved from ${p.from || p.from_tier || '?'} to ${p.to || p.to_tier || '?'}.` }),
  'system.re.rea.completed': p => ({ kind: 'rea', text: `Reverse engineering finished on ${basename(String(p.target || 'target'))}: ${p.label}, ${p.proven} of ${p.claims} claims proven.` }),
  'system.re.rea.reverified': p => ({ kind: 'rea', text: `Re-verified ${p.runId}: ${p.passed} of ${p.checks} checks passed, label ${p.label}.` }),
  'system.fleet.retired': p => ({ kind: 'fleet', text: `${p.agentId} retired from autonomous selection after ${p.samples} outcomes averaging ${Number(p.quality).toFixed(2)}.` }),
  'system.fleet.restored': p => ({ kind: 'fleet', text: `${p.agentId} restored to the roster.` }),
  'hive.bridge.chandra': p => ({ kind: 'hive', text: `Digest ${p.seq} posted to the hive: ${p.outcomes ?? 0} outcomes, ${p.findings ?? 0} open findings${p.pushed ? ', pushed' : ''}.` }),
  'system.world.observed': p => (Number(p.newObservations) >= 8 ? { kind: 'world', text: `Scanned the world: ${p.newObservations} new observations across ${p.web} web and ${p.youtube} video queries.` } : null),
  'system.self_audit': p => { const b = Number(p.counts?.blocking ?? p.blocking ?? 0); return b > 0 ? { kind: 'audit', text: `Self-audit found ${b} blocking issue${b === 1 ? '' : 's'}.` } : null; },
  'system.ollama.dropped': p => ({ kind: 'scheduler', text: `Dropped a ${p.class} job after waiting ${Math.round((p.waitedMs || 0) / 1000)} seconds — the inference queue is full.` }),
  'system.research': p => {
    if (p.action === 'proposal' && p.kind === 'experiment') return { kind: 'research', text: `I read "${clip(p.title, 70)}" and want to test it: ${clip(p.hypothesis, 110)}` };
    if (p.action === 'proposal' && p.kind === 'code') return { kind: 'research', text: `A paper suggested a change to ${basename(String(p.targetFile || ''))}: "${clip(p.title, 80)}". Drafting it for review.` };
    if (p.action === 'proposal' && p.kind === 'idea') return { kind: 'research', text: `Filed an idea from "${clip(p.title, 70)}": ${clip(p.idea, 100)}` };
    if (p.action === 'scan' && (p.proposals || 0) > 0) return { kind: 'research', text: `Research scan: ${p.fetched} items read, ${p.newItems} new, ${p.proposals} turned into proposals.` };
    return null;
  },
  'system.self_modification': p => {
    const name = String(p.tunable || '').replace(/_/g, ' ').replace(/\./g, ' ');
    if (p.action === 'experiment_started') return { kind: 'smk', text: `Trying a change to myself: ${name} from ${p.before} to ${p.after}. I will measure it for ${Math.round((p.windowMs || 0) / 60000)} minutes.` };
    if (p.action === 'experiment_evaluated') return { kind: 'smk', text: p.verdict === 'kept' ? `Kept the change to ${name}: the objective moved ${p.delta >= 0 ? 'up' : 'within tolerance'} by ${Math.abs(Number(p.delta || 0)).toFixed(3)}.` : p.verdict === 'reverted' ? `Reverted ${name} to ${p.before}: ${clip(p.reason, 90)}.` : `Inconclusive test on ${name}; put it back.` };
    if (p.action === 'code_ready') return { kind: 'smk', text: `I wrote and tested a change to ${basename(String(p.targetFile || ''))}: ${clip(p.title, 80)}. It is on a branch waiting for Vaughn's review.` };
    if (p.action === 'code_merged') return { kind: 'smk', text: `My change to ${basename(String(p.targetFile || ''))} was approved and merged. A restart will make it live.` };
    return null;
  },
  // Phase AC: proven programs becoming callable tools
  'system.skills': p => {
    const name = String(p.name || '').replace(/^skill\./, '').replace(/_/g, ' ');
    if (p.action === 'crystallized') return { kind: 'skills', text: `I turned a proven program into a new skill: ${name}. ${clip(p.description, 100)} Every agent can call it now.` };
    if (p.action === 'retired') return { kind: 'skills', text: `Retired the skill ${name}${p.reason ? `: ${clip(p.reason, 80)}` : ''}.` };
    if (p.action === 'composition' && p.status === 'passed') return { kind: 'skills', text: `Two of my skills, ${String(p.a || '').replace(/^skill\./, '')} and ${String(p.b || '').replace(/^skill\./, '')}, combined into a program that proved itself. It will become a third.` };
    return null;
  },
  // Phase AD: measured capability — benchmark results and lessons that survived an A/B test
  'system.capability': p => {
    if (p.action === 'benchmark_completed' && typeof p.g === 'number') return { kind: 'capability', text: `Capability check: ${p.correct} of ${p.n} fresh problems solved, g-score ${p.g.toFixed(2)}.${p.strongest && p.weakest && p.strongest !== p.weakest ? ` Strongest at ${p.strongest}, weakest at ${p.weakest}.` : ''}` };
    if (p.action === 'lesson_kept') return { kind: 'capability', text: `A lesson about ${p.family} problems held up under test: ${p.withLesson} of ${p.n} right with it, ${p.base} without. I am keeping it.` };
    return null;
  },
};
export const TOPICS = Object.keys(LINES);

// ─── Speaking ────────────────────────────────────────────────────

async function speak(item) {
  // Reserve the gap now: the first live test showed a bus line starting 5 s after a forced
  // line because lastSpokenAt was only set when the previous speak finished.
  speaking = true;
  lastSpokenAt = now();
  try {
  const bridge = getObsBridge();
  const clients = bridge.clients.size;
  let audio = null, engine = null, durationEst = Math.round(item.text.length / 15);
  if (clients > 0 || ALWAYS) {
    try {
      const r = await ttsSpeak(item.text, { voice: VOICE });
      audio = r.url; engine = r.engine; durationEst = r.durationEstimate || durationEst;
    } catch (e) { state.ttsErrors++; console.error('[narrator] tts:', e.message.slice(0, 120)); }
  }
  const id = 'nar_' + randomUUID().replace(/-/g, '').slice(0, 10);
  const payload = { id, text: item.text, kind: item.kind, topic: item.topic, audioUrl: audio, engine, durationMs: Math.max(4000, durationEst * 1000 + 1500), at: now() };
  try {
    db.prepare(`INSERT INTO narrations (id, topic, kind, text, audio_url, engine, duration_est, overlay_clients, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, item.topic || null, item.kind, item.text, audio, engine, durationEst, clients, item.source || 'bus', now());
  } catch (e) { console.error('[narrator] persist:', e.message); }
  try { bridge.broadcastNarration(payload); } catch (_) {}
  try { publish(AGENT, 'system.narration', JSON.stringify({ id, kind: item.kind, topic: item.topic, text: item.text, audio: !!audio, clients })); } catch (_) {}
  if (audio) state.spoken++; else state.textOnly++;
  state.lastLine = item.text; state.lastAt = now(); lastSpokenAt = now();
  state.byTopic[item.kind] = (state.byTopic[item.kind] || 0) + 1;
  return payload;
  } finally {
    speaking = false;
    lastSpokenAt = now();
    setTimeout(pump, 0);
  }
}

function recentlySaid(text) {
  try { return !!db.prepare(`SELECT 1 FROM narrations WHERE text = ? AND created_at > ? LIMIT 1`).get(text, now() - DEDUP_WINDOW_MS); } catch (_) { return false; }
}

function pump() {
  if (!running || !queue.length || speaking) return;
  const wait = minGapMs() - (now() - lastSpokenAt);
  if (wait > 0) { if (!timer) timer = setTimeout(() => { timer = null; pump(); }, wait); return; }
  const item = queue.shift();
  speak(item).catch(e => console.error('[narrator] speak:', e.message));
}

function enqueue(item) {
  if (!running || !item) return false;
  // the same sentence twice in ten minutes is noise, not news (the self-audit repeats every 15 min)
  if (recentlySaid(item.text) || queue.some(q => q.text === item.text)) { state.dropped++; return false; }
  if (queue.length >= QUEUE_MAX) { queue.shift(); state.dropped++; }
  queue.push(item);
  pump();
  return true;
}

function handlerFor(topic) {
  return msg => {
    try {
      const line = LINES[topic](parse(msg.payload));
      if (line) enqueue({ ...line, topic, source: 'bus' });
    } catch (e) { console.error(`[narrator] ${topic}:`, e.message); }
  };
}

export function startNarrator() {
  if (!ENABLED) return { started: false, reason: 'NARRATOR_ENABLED=0' };
  if (running) return { started: false, reason: 'already running' };
  running = true;
  for (const t of TOPICS) onTopic(t, AGENT, handlerFor(t));
  return { started: true, topics: TOPICS, minGapMs: minGapMs(), voice: VOICE, audioOnlyWithOverlay: !ALWAYS };
}

export function stopNarrator() {
  running = false;
  for (const t of TOPICS) offTopic(t, AGENT);
  if (timer) { clearTimeout(timer); timer = null; }
  queue.length = 0;
  return { stopped: true };
}

/** Say something now (operator or agent). Goes through the same gap/queue as events. */
export function narrate(text, { kind = 'say', source = 'operator', force = false } = {}) {
  const t = clip(text, 300);
  if (!t) throw Object.assign(new Error('text required'), { status: 400 });
  if (force) return speak({ kind, text: t, topic: null, source });
  const queued = enqueue({ kind, text: t, topic: null, source });
  return Promise.resolve({ queued, position: queue.length, minGapMs: minGapMs(), text: t });
}

export function listNarrations({ limit = 30 } = {}) {
  return db.prepare(`SELECT * FROM narrations ORDER BY created_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit)));
}

export function getNarratorStatus() {
  let overlayClients = 0;
  try { overlayClients = getObsBridge().clients.size; } catch (_) {}
  const last24 = db.prepare(`SELECT COUNT(*) n, SUM(audio_url IS NOT NULL) spoken FROM narrations WHERE created_at > ?`).get(now() - 86400_000);
  return { enabled: ENABLED, running, overlayClients, audioOnlyWithOverlay: !ALWAYS, voice: VOICE, minGapMs: minGapMs(), queued: queue.length, topics: TOPICS, ...state, last24h: { lines: last24?.n || 0, spoken: last24?.spoken || 0 }, recent: listNarrations({ limit: 8 }) };
}

export function installNarratorRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/narrator', route((_req, res) => res.json(getNarratorStatus())));
  app.get('/api/intelligence/narrator/history', route((req, res) => res.json({ narrations: listNarrations({ limit: parseInt(req.query.limit) || 30 }) })));
  app.post('/api/intelligence/narrator/say', route(async (req, res) => {
    try { res.json(await narrate(String(req.body?.text || ''), { source: 'operator', force: req.body?.force === true })); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  }));
  app.post('/api/intelligence/narrator/start', route((_req, res) => res.json(startNarrator())));
  app.post('/api/intelligence/narrator/stop', route((_req, res) => res.json(stopNarrator())));
}
