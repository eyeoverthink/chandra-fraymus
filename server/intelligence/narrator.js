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
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ttsSpeak, TTS_DIR } from '../media/tts-engine.js';
import { getObsBridge } from '../streaming/overlay.js';
import { chatOllama } from '../commerce/shared.js';
import { classifyUrl } from '../fraymus-os/registry.js';

const now = () => Date.now();
const AGENT = 'narrator';
const ENABLED = process.env.NARRATOR_ENABLED !== '0';
const DEFAULT_GAP_MS = Math.max(5_000, parseInt(process.env.NARRATOR_MIN_GAP_MS, 10) || 45_000);
const minGapMs = () => tunable('narrator.min_gap_ms', DEFAULT_GAP_MS); // Phase Y: live tunable
// Every line is voiced and saved to data/tts (the shelf's Audio), whether or not an OBS overlay is listening — Vaughn
// hears the organism through the shelf. Measured 2026-11-13: of 111 lines in 24 h, the 7 spoken with no overlay
// attached (OBS reconnecting, server restarts) were text-only and never reached the shelf. The old "audio only with an
// overlay" saving dates from the online edge-tts voice; VoiceStudio is local. NARRATOR_AUDIO_WITH_OVERLAY_ONLY=1 restores it.
const ALWAYS = process.env.NARRATOR_AUDIO_WITH_OVERLAY_ONLY !== '1' || process.env.NARRATOR_ALWAYS === '1';
// The voice is Vaughn's (VoiceStudio, the same allow-list as the home screen and the films). The stock edge-tts voice is
// only a fallback when VoiceStudio does not answer, and every fallback is counted — until 2026-11-13 the stream spoke
// in en-US-GuyNeural all the time and nothing said so.
const VOICE = process.env.NARRATOR_VOICE || 'en-US-GuyNeural';
const VOICESTUDIO = classifyUrl(process.env.FRAYMUS_VOICESTUDIO_URL || '');
const VS_ALLOWED = new Set(['vaughn-one', 'overlord']);
const VS_VOICE = VS_ALLOWED.has(process.env.NARRATOR_VS_VOICE) ? process.env.NARRATOR_VS_VOICE
  : VS_ALLOWED.has(process.env.FRAYMUS_VOICE_ID) ? process.env.FRAYMUS_VOICE_ID : 'vaughn-one';
const VS_USABLE = !!VOICESTUDIO.url && VOICESTUDIO.routeClass !== 'public' && process.env.NARRATOR_VOICE_ENGINE !== 'cascade';
// Lines are said by a model from the event's facts (NARRATOR_PHRASING=0 keeps the plain line).
const PHRASING = process.env.NARRATOR_PHRASING !== '0';
const PHRASE_TIMEOUT_MS = 25_000;
const QUEUE_MAX = 5;
const MIN_GOAL_QUALITY = 0.5;

let running = false;
let lastSpokenAt = 0;
let speaking = false;          // a speak() in flight holds the gap; pump() waits for it
let timer = null;
const queue = [];
const DEDUP_WINDOW_MS = 10 * 60_000;
const state = { spoken: 0, textOnly: 0, dropped: 0, ttsErrors: 0, lastLine: null, lastAt: 0, byTopic: {},
  voiceUse: { own: 0, fallback: 0, lastFallback: null }, phrasing: { model: 0, plain: 0, lastPlainReason: null } };

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
  // plain: the event's plain line (the ten-minute duplicate filter compares on it); text is what was actually said
  try { db.prepare(`ALTER TABLE narrations ADD COLUMN plain TEXT`).run(); } catch (_) { /* column exists */ }
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
    // a millisecond knob is said in minutes or seconds: "2100000" means nothing out loud
    const say = v => (/_ms$/.test(String(p.tunable)) && Number(v) >= 1000 ? (Number(v) >= 60_000 ? `${Math.round(v / 60_000)} minutes` : `${Math.round(v / 1000)} seconds`) : v);
    if (p.action === 'experiment_started') return { kind: 'smk', text: `Trying a change to myself: ${name.replace(/ ms$/, '')} from ${say(p.before)} to ${say(p.after)}. I will measure it for ${Math.round((p.windowMs || 0) / 60000)} minutes.` };
    if (p.action === 'experiment_evaluated') return { kind: 'smk', text: p.verdict === 'kept' ? `Kept the change to ${name}: the objective moved ${p.delta >= 0 ? 'up' : 'within tolerance'} by ${Math.abs(Number(p.delta || 0)).toFixed(3)}.` : p.verdict === 'reverted' ? `Reverted ${name.replace(/ ms$/, "")} to ${say(p.before)}: ${clip(p.reason, 90)}.` : `Inconclusive test on ${name}; put it back.` };
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
  // What the dream step concluded about the hour, after every lesson passed the evidence checks (dream-ground.js).
  // These are the system's own checked conclusions, the closest thing in the stream to a thought.
  'system.dream': p => {
    if (p.action === 'lessons' && Array.isArray(p.lessons) && p.lessons.length) return { kind: 'dream', text: `I noticed: ${clip(p.lessons[0], 170)}${p.lessons.length > 1 ? ` And ${p.lessons.length - 1} more from the same hour.` : ''}` };
    if (p.action === 'reel_ready' && p.lessons) return { kind: 'dream', text: `I made a film of what I learned: ${p.lessons} lesson${p.lessons === 1 ? '' : 's'}, ${Math.round(p.seconds || 0)} seconds. It is on the shelf.` };
    if (p.action === 'dream_translated' && p.kind && p.kind !== 'none') return { kind: 'dream', text: `One of my lessons became ${p.kind === 'experiment' ? 'an experiment I will measure' : p.kind === 'code' ? 'a code change for review' : 'an idea to prove in code'}: ${clip(p.lesson, 120)}` };
    return null;
  },
  // The daemon's cycle (every ~18 min): what it did, from the bus event it already publishes.
  'system.daemon': p => {
    if (p.action !== 'cycle_complete') return null;
    const did = [];
    if (p.goalsGenerated) did.push(`${p.goalsGenerated} new goal${p.goalsGenerated === 1 ? '' : 's'}`);
    if (p.reflectionActions) did.push(`${p.reflectionActions} reflection action${p.reflectionActions === 1 ? '' : 's'}`);
    if (p.consolidation) did.push('a dream consolidation');
    if (p.ouroborosAccepted) did.push(`${p.ouroborosAccepted} accepted self-improvement proposal${p.ouroborosAccepted === 1 ? '' : 's'}`);
    if (p.consciousnessVerdict) did.push(`a consciousness audit (${p.consciousnessProofsPassed} of 4 proofs)`);
    // only what the line says goes to the model: given the whole event it spoke the cycle interval as a duration
    const facts = { goalsGenerated: p.goalsGenerated || 0, reflectionActions: p.reflectionActions || 0, dreamConsolidated: !!p.consolidation,
      acceptedSelfImprovementProposals: p.ouroborosAccepted || 0, consciousnessProofsPassed: p.consciousnessVerdict ? p.consciousnessProofsPassed : null };
    return { kind: 'daemon', text: `Daemon cycle done${did.length ? `: ${did.join(', ')}` : ', nothing new to act on'}.`, facts };
  },
  // Agent runs, tool calls and model calls, summed over the last few minutes (activityFacts below). One run at a time
  // would be ~500 lines a day against a 45-second gap; a digest every NARRATOR_ACTIVITY_MS says what the fleet is doing.
  'system.activity': p => {
    if (!p.runs && !p.tools) return null;
    const agents = p.agents?.length ? ` (${p.agents.join(', ')})` : '';
    const tools = p.tools ? `; ${p.tools} tool call${p.tools === 1 ? '' : 's'}${p.topTools?.length ? `, mostly ${p.topTools.join(', ')}` : ''}` : '';
    const models = p.modelCalls ? `; ${p.modelCalls} model call${p.modelCalls === 1 ? '' : 's'}${p.hosts?.length ? ` on ${p.hosts.join(' and ')}` : ''}` : '';
    return { kind: 'activity', text: `In the last ${p.minutes} minutes: ${p.runs} agent run${p.runs === 1 ? '' : 's'} finished${p.failed ? `, ${p.failed} of them failed` : ''}${agents}${tools}${models}.` };
  },
  // Phase AD: measured capability — benchmark results and lessons that survived an A/B test
  'system.capability': p => {
    if (p.action === 'benchmark_completed' && typeof p.g === 'number') return { kind: 'capability', text: `Capability check: ${p.correct} of ${p.n} fresh problems solved, g-score ${p.g.toFixed(2)}.${p.strongest && p.weakest && p.strongest !== p.weakest ? ` Strongest at ${p.strongest}, weakest at ${p.weakest}.` : ''}` };
    if (p.action === 'lesson_kept') return { kind: 'capability', text: `A lesson about ${p.family} problems held up under test: ${p.withLesson} of ${p.n} right with it, ${p.base} without. I am keeping it.` };
    return null;
  },
};
// system.activity is not a bus topic: the narrator builds it itself from the database
export const TOPICS = Object.keys(LINES).filter(t => t !== 'system.activity');

const ACTIVITY_MS = Math.max(60_000, parseInt(process.env.NARRATOR_ACTIVITY_MS, 10) || 5 * 60_000);

/** What the fleet did between `since` and `to`: finished runs (agent = prefix of runs.model), tool calls, model calls. */
export function activityFacts(database, since, to = now()) {
  const q = (sql, ...p) => { try { return database.prepare(sql).all(...p); } catch (e) { console.error('[narrator] activity:', e.message); return []; } };
  const runs = q(`SELECT status, model FROM runs WHERE updated_at > ? AND updated_at <= ? AND status IN ('done', 'error')`, since, to);
  const byAgent = {};
  for (const r of runs) { const a = String(r.model || '').split(':')[0]; if (a) byAgent[a] = (byAgent[a] || 0) + 1; }
  const tools = q(`SELECT name, COUNT(*) AS c FROM messages WHERE role = 'tool' AND created_at > ? AND created_at <= ? GROUP BY name ORDER BY c DESC`, since, to);
  const calls = q(`SELECT host, COUNT(*) AS c FROM fleet_model_calls WHERE at > ? AND at <= ? GROUP BY host ORDER BY c DESC`, since, to);
  return {
    minutes: Math.round((to - since) / 60_000),
    runs: runs.length,
    failed: runs.filter(r => r.status === 'error').length,
    agents: Object.entries(byAgent).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a),
    tools: tools.reduce((n, t) => n + t.c, 0),
    topTools: tools.slice(0, 3).map(t => t.name),
    modelCalls: calls.reduce((n, c) => n + c.c, 0),
    hosts: calls.slice(0, 2).map(c => (c.host === 'local' ? 'this PC' : c.host)),
  };
}

let activityTimer = null, activitySince = now();
function activityTick() {
  const to = now();
  const facts = activityFacts(db, activitySince, to);
  activitySince = to;
  const line = LINES['system.activity'](facts);
  if (line) enqueue({ ...line, topic: 'system.activity', facts, source: 'activity' });
}

// ─── Saying it ───────────────────────────────────────────────────
// The line above is the plain version; a model says it the way a person would, from the same facts. What it may not
// do is invent: every number it speaks must be one of the event's numbers (or that number in seconds, minutes,
// hours or percent), and the reply must be short and on topic. Anything else and the plain line is spoken, counted.

export function numbersIn(text) {
  return (String(text).match(/\d+(?:[.,]\d+)*/g) || []).map(s => Number(s.replace(/,/g, ''))).filter(Number.isFinite);
}

export function allowedNumbers(...sources) {
  const ok = new Set();
  const add = n => { for (const v of [n, Math.round(n), Math.round(n * 10) / 10, Math.round(n * 100) / 100, Math.round(n * 1000) / 1000]) ok.add(v); };
  const walk = v => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      add(v);
      for (const d of [1000, 60_000, 3_600_000]) { add(v / d); }        // ms → s, min, h
      if (v > 0 && v <= 1) add(v * 100);                                // a share said as a percent
    } else if (typeof v === 'string') numbersIn(v).forEach(walk);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  sources.forEach(walk);
  for (let i = 0; i <= 10; i++) ok.add(i);                              // "one", "two"… written as digits
  return ok;
}

export function checkPhrasing(said, plain, facts) {
  const text = String(said || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (text.length < 8) return { ok: false, reason: 'empty' };
  if (text.length > 320) return { ok: false, reason: 'too long' };
  const ok = allowedNumbers(plain, facts);
  const extra = numbersIn(text).filter(n => !ok.has(n) && !ok.has(Math.round(n)));
  if (extra.length) return { ok: false, reason: `invented number ${extra[0]}` };
  // an agent or identifier name (has a hyphen, underscore or digit inside a word) must come from the event
  const source = `${plain} ${JSON.stringify(facts || {})}`.toLowerCase();
  const ids = (text.match(/\b[a-z][\w]*(?:[-_][\w]+)+\b/gi) || []).filter(w => /\d|_|-/.test(w));
  const foreign = ids.find(w => !source.includes(w.toLowerCase()));
  if (foreign) return { ok: false, reason: `named something not in the event: ${foreign}` };
  // a score in the event (a decimal such as 0.62) is said as that number — "about average" is the model's opinion of it
  const spoken = numbersIn(text);
  const lostScore = (String(plain).match(/\b0?\.\d+\b/g) || []).map(Number).find(x => !spoken.some(n => Math.abs(n - x) < 0.006 || Math.abs(n - x * 100) < 0.6));
  if (lostScore != null) return { ok: false, reason: `left out the score ${lostScore}` };
  // one sentence: a second one is where commentary the facts do not support creeps in
  if ((text.match(/[.!?](\s|$)/g) || []).length > 1) return { ok: false, reason: 'more than one sentence' };
  return { ok: true, text };
}

const PHRASE_SYSTEM = `You are Chandra, a local autonomous AI system, speaking aloud on a live stream about something that just happened inside you.
Say it in ONE natural spoken sentence, in the first person, the way a thoughtful person would tell a friend.
Use only the facts given. Do not add numbers, names, causes or promises that are not in them, and add no opinions, feelings, lessons or advice.
An agentId is another agent in your fleet, not you: say what that agent did. Say a quality score as the number given. A dream lesson is something you noticed about the last hour, not a dream you had.
"Meaning" tells you what happened so you get it right; say it in your own different words, never copying its sentence.
Turn technical names into plain words (say "how often I reflect", not "motor.reflect_min_ms"; say minutes, not milliseconds).
Never read out a raw number with more than four digits — use the "_spoken" version of a value when one is given.
Reply with the sentences only — no quotes, no preamble.`;

// Millisecond values are added in spoken form ("35 minutes"), so the model never has to read "2100000" aloud.
export function spokenFacts(facts) {
  const out = { ...facts };
  const msLike = /_ms$|Ms$|windowMs|waitedMs|durationMs/;
  const tunableMs = /_ms$/.test(String(facts?.tunable || ''));
  for (const [k, v] of Object.entries(facts || {})) {
    if (typeof v !== 'number' || v < 1000) continue;
    if (msLike.test(k) || (tunableMs && ['before', 'after', 'value'].includes(k)))
      out[`${k}_spoken`] = v >= 60_000 ? `${Math.round(v / 60_000)} minutes` : `${Math.round(v / 1000)} seconds`;
  }
  return out;
}

async function phrase(item) {
  if (!PHRASING || !item.facts) return item.text;
  try {
    // Facts plus the meaning. With only facts the model made things up (another agent's timeout became "my dream");
    // with the meaning labelled as a sentence to say, it read it back word for word. A reply that copies it is refused.
    const facts = JSON.stringify(spokenFacts(item.facts)).slice(0, 1500);
    const reply = await chatOllama([
      { role: 'system', content: PHRASE_SYSTEM },
      { role: 'user', content: `Event: ${item.topic}\nFacts: ${facts}\nMeaning: ${item.text}` },
    ], { priority: 'scoring', label: 'narrator', timeoutMs: PHRASE_TIMEOUT_MS, temperature: 0.3, maxTokens: 120 });
    const check = checkPhrasing(String(reply ?? ''), item.text, item.facts);
    if (check.ok && check.text.toLowerCase() !== String(item.text).toLowerCase()) { state.phrasing.model++; return check.text; }
    if (check.ok) check.reason = 'model repeated the plain line';
    state.phrasing.plain++; state.phrasing.lastPlainReason = check.reason;
  } catch (e) {
    state.phrasing.plain++; state.phrasing.lastPlainReason = clip(e.message, 100);
    console.error('[narrator] phrasing:', clip(e.message, 120));
  }
  return item.text;
}

async function voiceStudioSay(text) {
  const r = await fetch(`${VOICESTUDIO.url}/v1/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', input: text, voice: VS_VOICE, response_format: 'wav' }), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`VoiceStudio HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2000) throw new Error(`VoiceStudio sent only ${buf.length} bytes`);
  const name = `${now()}-${randomUUID().slice(0, 8)}.wav`;
  writeFileSync(join(TTS_DIR, name), buf);
  // 16-bit mono WAV at 24 kHz is 48,000 bytes a second; close enough to size the overlay card
  return { url: `/tts/${name}`, engine: `voicestudio:${VS_VOICE}`, durationEstimate: Math.max(2, Math.round(buf.length / 48_000)) };
}

async function voiceLine(text) {
  if (VS_USABLE) {
    try { const r = await voiceStudioSay(text); state.voiceUse.own++; return r; }
    catch (e) { state.voiceUse.lastFallback = clip(e.message, 120); console.error('[narrator] VoiceStudio:', state.voiceUse.lastFallback); }
  } else state.voiceUse.lastFallback = VOICESTUDIO.url ? 'VoiceStudio is on a public host or switched off' : 'FRAYMUS_VOICESTUDIO_URL is not set';
  const r = await ttsSpeak(text, { voice: VOICE });
  state.voiceUse.fallback++;
  return { url: r.url, engine: `${r.engine}:${VOICE} (fallback)`, durationEstimate: r.durationEstimate };
}

// ─── Speaking ────────────────────────────────────────────────────

async function speak(item) {
  // Reserve the gap now: the first live test showed a bus line starting 5 s after a forced
  // line because lastSpokenAt was only set when the previous speak finished.
  speaking = true;
  lastSpokenAt = now();
  try {
  const bridge = getObsBridge();
  const clients = bridge.clients.size;
  item = { ...item, plain: item.text, text: await phrase(item) };
  let audio = null, engine = null, durationEst = Math.round(item.text.length / 15);
  if (clients > 0 || ALWAYS) {
    try {
      const r = await voiceLine(item.text);
      audio = r.url; engine = r.engine; durationEst = r.durationEstimate || durationEst;
    } catch (e) { state.ttsErrors++; console.error('[narrator] tts:', e.message.slice(0, 120)); }
  }
  const id = 'nar_' + randomUUID().replace(/-/g, '').slice(0, 10);
  const payload = { id, text: item.text, kind: item.kind, topic: item.topic, audioUrl: audio, engine, durationMs: Math.max(4000, durationEst * 1000 + 1500), at: now() };
  try {
    db.prepare(`INSERT INTO narrations (id, topic, kind, text, plain, audio_url, engine, duration_est, overlay_clients, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, item.topic || null, item.kind, item.text, item.plain ?? item.text, audio, engine, durationEst, clients, item.source || 'bus', now());
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
  try { return !!db.prepare(`SELECT 1 FROM narrations WHERE (plain = ? OR text = ?) AND created_at > ? LIMIT 1`).get(text, text, now() - DEDUP_WINDOW_MS); } catch (_) { return false; }
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

// Kinds that arrive in floods are spoken at most once per window, with a count. Measured 2026-11-12: of 308 lines in
// 24 h, 173 of the most frequent said a job was dropped because the queue was full, and 41 announced the consciousness
// tier flipping between AWAKENING and INTEGRATED — the stream was mostly about congestion and flicker.
const KIND_WINDOW_MS = { scheduler: 3600_000, consciousness: 3600_000 };
const kindState = {};
function throttled(line) {
  const win = KIND_WINDOW_MS[line.kind];
  if (!win) return line;
  const s = (kindState[line.kind] = kindState[line.kind] || { lastAt: 0, held: 0 });
  if (now() - s.lastAt < win) { s.held++; state.throttled = (state.throttled || 0) + 1; return null; }
  const held = s.held; s.lastAt = now(); s.held = 0;
  if (!held) return line;
  if (line.kind === 'scheduler') return { ...line, text: `${held + 1} inference jobs were dropped in the last hour because the queue was full; the latest: ${line.text.replace(/^Dropped a /, 'a ').replace(/ — the inference queue is full\.$/, '.')}` };
  return { ...line, text: `${line.text} It changed tier ${held + 1} times in the last hour.` };
}

function handlerFor(topic) {
  return msg => {
    try {
      const facts = parse(msg.payload);
      const raw = LINES[topic](facts);
      const line = raw && throttled(raw);
      if (line) enqueue({ ...line, topic, facts: line.facts || facts, source: 'bus' });
    } catch (e) { console.error(`[narrator] ${topic}:`, e.message); }
  };
}

export function startNarrator() {
  if (!ENABLED) return { started: false, reason: 'NARRATOR_ENABLED=0' };
  if (running) return { started: false, reason: 'already running' };
  running = true;
  for (const t of TOPICS) onTopic(t, AGENT, handlerFor(t));
  activitySince = now();
  activityTimer = setInterval(activityTick, ACTIVITY_MS);
  activityTimer.unref?.();
  return { started: true, topics: TOPICS, minGapMs: minGapMs(), voice: VOICE, audioOnlyWithOverlay: !ALWAYS };
}

export function stopNarrator() {
  running = false;
  for (const t of TOPICS) offTopic(t, AGENT);
  if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
  if (timer) { clearTimeout(timer); timer = null; }
  queue.length = 0;
  return { stopped: true };
}

/** What the narrator would say and how it would sound for an event — phrased and voiced, never broadcast or stored. */
export async function previewLine(topic, facts = {}, { voice = true } = {}) {
  if (!LINES[topic]) throw Object.assign(new Error(`not a narrated topic: ${topic}`), { status: 400 });
  const line = LINES[topic](facts);
  if (!line) return { said: null, reason: 'the narrator stays quiet for this event' };
  const said = await phrase({ ...line, topic, facts: line.facts || facts });
  const audio = voice ? await voiceLine(said) : null;
  return { plain: line.text, said, phrasedByModel: said !== line.text, audioUrl: audio?.url || null, engine: audio?.engine || null };
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
  return { enabled: ENABLED, running, overlayClients, audioOnlyWithOverlay: !ALWAYS,
    voice: VS_USABLE ? `${VS_VOICE} (VoiceStudio), fallback ${VOICE}` : `${VOICE} (VoiceStudio not usable)`, phrasingEnabled: PHRASING, minGapMs: minGapMs(), queued: queue.length, topics: TOPICS, ...state, last24h: { lines: last24?.n || 0, spoken: last24?.spoken || 0 }, recent: listNarrations({ limit: 8 }) };
}

export function installNarratorRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/narrator', route((_req, res) => res.json(getNarratorStatus())));
  app.get('/api/intelligence/narrator/history', route((req, res) => res.json({ narrations: listNarrations({ limit: parseInt(req.query.limit) || 30 }) })));
  app.post('/api/intelligence/narrator/say', route(async (req, res) => {
    try { res.json(await narrate(String(req.body?.text || ''), { source: 'operator', force: req.body?.force === true })); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  }));
  // {topic, facts, voice?}: phrased and voiced exactly as the stream would, but not broadcast and not stored
  app.post('/api/intelligence/narrator/preview', route(async (req, res) => {
    try { res.json(await previewLine(String(req.body?.topic || ''), req.body?.facts || {}, { voice: req.body?.voice !== false })); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  }));
  app.post('/api/intelligence/narrator/start', route((_req, res) => res.json(startNarrator())));
  app.post('/api/intelligence/narrator/stop', route((_req, res) => res.json(stopNarrator())));
}
