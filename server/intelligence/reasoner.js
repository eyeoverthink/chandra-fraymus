/**
 * Reasoner — Phase AD. A deliberate reasoning layer over the local models.
 *
 * solve(problem, { strategy }) → { answer, confidence, strategy, trace, ms, skipped? }
 *
 * Strategies:
 *   direct   one short answer
 *   cot      step by step, final ANSWER: / CONFIDENCE: lines
 *   vote     3 cot samples at higher temperature, majority answer, confidence = share
 *   program  coder model writes a Node program; the Skill Forge sandbox runs it; printed answer is used
 *   induce   (problems with examples) coder model writes solve(input); the sandbox checks it against
 *            the examples and failures are fed back; the answer comes from a function that fits them
 *
 * `auto` picks by Thompson sampling over reasoner_arms (Beta posteriors per family × strategy), which
 * are updated only when ground truth is known (the capability benchmark). Kept lessons for the family
 * (reasoner_lessons, written by general-intelligence.js after an A/B test) are injected into prompts.
 *
 * Every model call runs at the `goal` scheduler class (never dropped); a dropped or timed-out call
 * returns { skipped: true } so a benchmark records it as skipped, never as wrong.
 */
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { SKILL_DIR, runSkillProcess } from './skill-forge.js';
import { codeHarness, extractFunction, toPlain } from './capability-bench.js';

const MODEL = process.env.REASONER_MODEL || process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b';
const CODE_MODEL = process.env.REASONER_CODE_MODEL || process.env.SMK_CODE_MODEL || 'qwen2.5-coder:7b';
const CALL_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.REASONER_TIMEOUT_MS, 10) || 150_000);
const INDUCE_ITERATIONS = 3;
const VOTE_SAMPLES = 3;
export const STRATEGIES = ['direct', 'cot', 'vote', 'program', 'induce'];

const now = () => Date.now();
const clip = (s, n) => String(s ?? '').slice(0, n);

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reasoner_arms (
      family TEXT NOT NULL, strategy TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 1, beta REAL NOT NULL DEFAULT 1,
      pulls INTEGER NOT NULL DEFAULT 0, total_ms INTEGER NOT NULL DEFAULT 0, updated_at INTEGER,
      PRIMARY KEY (family, strategy)
    );
    CREATE TABLE IF NOT EXISTS reasoner_lessons (
      id TEXT PRIMARY KEY, family TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'testing',
      base_correct INTEGER, lesson_correct INTEGER, wins INTEGER, losses INTEGER, n INTEGER,
      source_run TEXT, note TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reasoner_lessons_family ON reasoner_lessons(family, status);
    CREATE TABLE IF NOT EXISTS reasoner_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, run_id TEXT, family TEXT, strategy TEXT,
      answered INTEGER, confidence REAL, ms INTEGER, error TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reasoner_calls_created ON reasoner_calls(created_at);
  `);
}
try { ensureTables(); } catch (e) { console.error('[reasoner] table setup failed:', e.message); }

// ── strategy applicability + bandit ──────────────────────────────────────────
export function applicableStrategies(problem) {
  const hasExamples = Array.isArray(problem.examples) && problem.examples.length >= 2;
  if (problem.answerType === 'code') return hasExamples ? ['direct', 'cot', 'induce'] : ['direct', 'cot'];
  return hasExamples ? ['direct', 'cot', 'vote', 'program', 'induce'] : ['direct', 'cot', 'vote', 'program'];
}

function gaussian() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function sampleGamma(k) { // Marsaglia–Tsang
  if (k < 1) return sampleGamma(k + 1) * Math.pow(Math.random() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = gaussian(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = Math.random(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
const sampleBeta = (a, b) => { const x = sampleGamma(a), y = sampleGamma(b); return x / (x + y); };

export function getArms(family = null) {
  try {
    return (family ? db.prepare(`SELECT * FROM reasoner_arms WHERE family = ? ORDER BY strategy`).all(family) : db.prepare(`SELECT * FROM reasoner_arms ORDER BY family, strategy`).all())
      .map(r => ({ ...r, mean: r.alpha / (r.alpha + r.beta), avgMs: r.pulls ? Math.round(r.total_ms / r.pulls) : null }));
  } catch (e) { console.error('[reasoner] getArms:', e.message); return []; }
}

export function chooseStrategy(family, applicable) {
  const arms = new Map(getArms(family).map(a => [a.strategy, a]));
  let best = applicable[0], bestDraw = -1;
  for (const s of applicable) {
    const a = arms.get(s);
    const draw = sampleBeta(a?.alpha ?? 1, a?.beta ?? 1);
    if (draw > bestDraw) { bestDraw = draw; best = s; }
  }
  return best;
}

/** Ground truth only — called by the benchmark, never from a model's own confidence. */
export function recordOutcome(family, strategy, correct, ms = 0) {
  try {
    db.prepare(`INSERT INTO reasoner_arms (family, strategy, alpha, beta, pulls, total_ms, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(family, strategy) DO UPDATE SET alpha = alpha + ?, beta = beta + ?, pulls = pulls + 1, total_ms = total_ms + ?, updated_at = ?`)
      .run(family, strategy, 1 + (correct ? 1 : 0), 1 + (correct ? 0 : 1), Math.round(ms), now(), correct ? 1 : 0, correct ? 0 : 1, Math.round(ms), now());
  } catch (e) { console.error('[reasoner] recordOutcome:', e.message); }
}

// ── lessons ──────────────────────────────────────────────────────────────────
export function activeLessons(family, limit = 3) {
  try { return db.prepare(`SELECT text FROM reasoner_lessons WHERE family = ? AND status = 'kept' ORDER BY created_at DESC LIMIT ?`).all(family, limit).map(r => r.text); }
  catch (e) { console.error('[reasoner] activeLessons:', e.message); return []; }
}
const lessonBlock = lessons => (lessons?.length ? `\nLessons from past mistakes on this kind of problem:\n${lessons.map(l => `- ${l}`).join('\n')}\n` : '');

// ── sandbox ──────────────────────────────────────────────────────────────────
const FORBIDDEN = /\bfetch\s*\(|node:(?:net|http|https|http2|dgram|dns|tls|child_process|worker_threads|fs|os|cluster|vm)\b|\bfrom\s+['"](?:net|http|https|dgram|dns|tls|child_process|worker_threads|fs|os|vm)['"]|\bimport\s*\(|\brequire\s*\(|process\.env|\beval\s*\(|new\s+Function/;

/** Run generated source in the Skill Forge sandbox. Returns { ok, output, error }. */
export async function runProgram(source, { timeoutMs = 10_000 } = {}) {
  const bad = String(source).match(FORBIDDEN);
  if (bad) return { ok: false, output: null, error: `refused before execution: uses ${bad[0].trim()}` };
  mkdirSync(SKILL_DIR, { recursive: true });
  const file = join(SKILL_DIR, `_r_${randomUUID().slice(0, 12)}.mjs`);
  try {
    writeFileSync(file, source);
    const r = await runSkillProcess(file, {}, { timeoutMs });
    return { ok: r.ok, output: r.output ?? null, error: r.ok ? null : clip(r.timedOut ? 'timed out' : (r.stderr || r.parseError || `exit ${r.exitCode}`), 400) };
  } finally {
    try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') console.error('[reasoner] scratch cleanup:', e.message); }
  }
}

// ── prompts + parsing ────────────────────────────────────────────────────────
const FORMAT = {
  number: 'a single number (digits only, no units)',
  string: 'the exact answer only (one word or string, no explanation)',
  list: 'a JSON array on one line',
  code: 'the complete function in a ```js code block',
};
const formatFor = t => FORMAT[t] || FORMAT.string;

function extractFence(raw) {
  const m = String(raw).match(/```(?:javascript|js|mjs)?\b[^\n]*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

export function parseReply(raw, answerType) {
  const text = String(raw ?? '');
  const cm = text.match(/CONFIDENCE\s*[:=]\s*([01](?:\.\d+)?|\.\d+)/i);
  const confidence = cm ? Math.max(0, Math.min(1, parseFloat(cm[1]))) : 0.5;
  if (answerType === 'code') return { answer: extractFunction(text), confidence };
  const idx = text.toUpperCase().lastIndexOf('ANSWER:');
  let ans = idx >= 0 ? text.slice(idx + 7) : text.trim().split('\n').filter(Boolean).pop() || '';
  ans = ans.replace(/CONFIDENCE\s*[:=][\s\S]*$/i, '').trim();
  if (answerType !== 'list') ans = ans.split('\n')[0].trim();
  ans = ans.replace(/^\*+|\*+$/g, '').trim();
  return { answer: ans || null, confidence };
}

async function ask(system, user, { model = MODEL, temperature = 0.2, maxTokens = 900, label }) {
  return chatOllama([{ role: 'system', content: system }, { role: 'user', content: user }], { priority: 'goal', label, model, temperature, maxTokens, timeoutMs: CALL_TIMEOUT_MS });
}

// ── strategies ───────────────────────────────────────────────────────────────
async function direct(p, lessons) {
  const raw = await ask(
    `You are a precise problem solver.${lessonBlock(lessons)}\nReply with exactly:\nANSWER: <${formatFor(p.answerType)}>\nCONFIDENCE: <a number from 0 to 1>`,
    p.prompt, { temperature: 0.1, maxTokens: p.answerType === 'code' ? 900 : 300, label: 'reasoner:direct' });
  return { ...parseReply(raw, p.answerType), trace: [{ step: 'direct', raw: clip(raw, 600) }] };
}

async function cot(p, lessons, temperature = 0.2) {
  const raw = await ask(
    `You are a careful problem solver. Work step by step, briefly, checking each step.${lessonBlock(lessons)}\nFinish with exactly these two lines:\nANSWER: <${formatFor(p.answerType)}>\nCONFIDENCE: <a number from 0 to 1>`,
    p.prompt, { temperature, maxTokens: 1100, label: 'reasoner:cot' });
  return { ...parseReply(raw, p.answerType), trace: [{ step: 'cot', raw: clip(raw, 900) }] };
}

const voteKey = (a, type) => (type === 'number' ? String(Number(String(a).replace(/[^\d.-]/g, ''))) : type === 'list' ? String(a).replace(/\s+/g, '').toLowerCase() : toPlain(a).toLowerCase());
async function vote(p, lessons) {
  const tallies = new Map(), trace = [];
  for (let i = 0; i < VOTE_SAMPLES; i++) {
    const r = await cot(p, lessons, 0.7);
    trace.push({ step: `vote ${i + 1}`, answer: clip(r.answer, 120), confidence: r.confidence });
    if (r.answer == null) continue;
    const k = voteKey(r.answer, p.answerType);
    const t = tallies.get(k) || { answer: r.answer, count: 0 };
    t.count++; tallies.set(k, t);
  }
  const best = [...tallies.values()].sort((a, b) => b.count - a.count)[0];
  if (!best) return { answer: null, confidence: 0, trace };
  return { answer: best.answer, confidence: best.count / VOTE_SAMPLES, trace };
}

const PROGRAM_SYSTEM = `You write small Node.js programs that COMPUTE the answer to a problem.
Rules: plain JavaScript (ES module), no imports, no input reading, no network, no files.
Compute the answer with code; do not hard-code a guess and do not derive a formula by hand.
Prefer brute-force SEARCH: enumerate candidate answers (integers in a range, permutations, move
sequences by breadth-first search) and test each candidate against EVERY condition stated in the
problem; print the candidate that satisfies all of them.
The LAST line printed must be: console.log(JSON.stringify({ answer: <the answer> }))
Reply with the program only, in a \`\`\`js code block.`;
async function program(p, lessons) {
  const trace = [];
  let feedback = '';
  for (let i = 0; i < 2; i++) {
    const raw = await ask(PROGRAM_SYSTEM + lessonBlock(lessons), `${p.prompt}\n\nThe answer must be ${formatFor(p.answerType)}.${feedback}`, { model: CODE_MODEL, temperature: 0.1, maxTokens: 1200, label: 'reasoner:program' });
    const code = extractFence(raw);
    if (!code) { trace.push({ step: `program ${i + 1}`, error: 'no code block' }); feedback = '\n\nYour previous reply had no ```js code block. Reply with the program only.'; continue; }
    const r = await runProgram(code);
    const answer = r.output && Object.prototype.hasOwnProperty.call(r.output, 'answer') ? r.output.answer : null;
    trace.push({ step: `program ${i + 1}`, code: clip(code, 700), ok: r.ok, answer: clip(JSON.stringify(answer), 160), error: r.error });
    if (r.ok && answer != null) return { answer: typeof answer === 'object' ? JSON.stringify(answer) : answer, confidence: i === 0 ? 0.85 : 0.7, trace };
    feedback = `\n\nYour previous program failed: ${r.error || 'it did not print {"answer": …} as its last line'}. Fix it.`;
  }
  const fb = await cot(p, lessons); // the sandbox gave nothing — fall back to thinking, at reduced confidence
  return { answer: fb.answer, confidence: Math.min(fb.confidence, 0.4), trace: [...trace, ...fb.trace, { step: 'fallback', to: 'cot' }] };
}

const INDUCE_SYSTEM = `You write one JavaScript function that implements a rule shown by examples.
Rules: \`function solve(input) { … }\`, plain JavaScript, no imports, no console output, deterministic.
It must return the exact expected output for EVERY example and generalise to new inputs.
Reply with the function only, in a \`\`\`js code block.`;
async function induce(p, lessons) {
  const tests = p.examples.map(e => ({ input: e.input, expect: e.output }));
  const trace = [];
  let feedback = '', best = null;
  for (let i = 0; i < INDUCE_ITERATIONS; i++) {
    const raw = await ask(INDUCE_SYSTEM + lessonBlock(lessons),
      `${p.answerType === 'code' ? p.prompt : `Examples (input -> output):\n${tests.map(t => `${JSON.stringify(t.input)} -> ${JSON.stringify(t.expect)}`).join('\n')}\n\nContext: ${clip(p.prompt, 500)}`}${feedback}`,
      { model: CODE_MODEL, temperature: i === 0 ? 0.1 : 0.4, maxTokens: 900, label: 'reasoner:induce' });
    const fn = extractFunction(raw);
    if (!fn) { trace.push({ step: `induce ${i + 1}`, error: 'no solve() function in reply' }); feedback = '\n\nYour previous reply did not contain `function solve(input)`. Reply with that function only.'; continue; }
    const r = await runProgram(codeHarness(fn, tests));
    const pass = r.output?.pass ?? 0, total = tests.length;
    trace.push({ step: `induce ${i + 1}`, code: clip(fn, 600), pass, total, error: r.error });
    if (!best || pass > best.pass) best = { fn, pass };
    if (r.ok && pass === total) break;
    const fails = (r.output?.fails || []).map(f => `solve(${JSON.stringify(f.input)}) must return ${JSON.stringify(f.expect)} but ${f.error ? `threw: ${f.error}` : `returned ${JSON.stringify(f.got)}`}`).join('\n');
    feedback = `\n\nYour previous function passed ${pass}/${total} examples.\n${fails || r.error || ''}\nFind a rule that explains ALL examples and rewrite the function.`;
  }
  if (!best) return { answer: null, confidence: 0, trace };
  const fit = best.pass / tests.length;
  const confidence = fit === 1 ? 0.95 : fit * 0.4;
  if (p.answerType === 'code') return { answer: best.fn, confidence, trace };
  const r = await runProgram(`${best.fn.replace(/^\s*export\s+(default\s+)?/gm, '')}\nprocess.stdout.write('\\n' + JSON.stringify({ answer: solve(${JSON.stringify(p.query)}) }) + '\\n');`);
  const answer = r.output && Object.prototype.hasOwnProperty.call(r.output, 'answer') ? r.output.answer : null;
  trace.push({ step: 'apply', query: p.query, answer: clip(JSON.stringify(answer), 160), error: r.error });
  return { answer: answer != null && typeof answer === 'object' ? JSON.stringify(answer) : answer, confidence: answer == null ? 0 : confidence, trace };
}

const RUNNERS = { direct, cot, vote, program, induce };

/**
 * problem: { prompt, family?, answerType?, examples?: [{input, output}], query? }
 * opts.strategy: 'auto' | one of STRATEGIES. opts.lessons: undefined = kept lessons for the family,
 * [] = none, [text…] = exactly these (used by the lesson A/B test).
 */
export async function solve(problem, { strategy = 'auto', lessons } = {}) {
  const p = { family: 'general', answerType: 'string', ...problem };
  if (!p.prompt || typeof p.prompt !== 'string') return { answer: null, confidence: 0, strategy: null, trace: [], ms: 0, error: 'prompt is required' };
  const applicable = applicableStrategies(p);
  const chosen = strategy === 'auto' ? chooseStrategy(p.family, applicable) : (applicable.includes(strategy) ? strategy : 'cot');
  const useLessons = lessons === undefined ? activeLessons(p.family) : lessons;
  const t0 = now();
  try {
    const r = await RUNNERS[chosen](p, useLessons);
    // calibration from track record: a small model's stated confidence carries little information
    // (baseline Brier 0.615), so blend it with this strategy's measured success rate for the family
    const arm = getArms(p.family).find(a => a.strategy === chosen);
    const stated = r.confidence ?? 0.5;
    const confidence = r.answer == null ? 0 : arm && arm.pulls >= 3 ? (stated + arm.mean) / 2 : stated;
    return { answer: r.answer ?? null, confidence, statedConfidence: stated, strategy: chosen, requested: strategy, lessonsUsed: useLessons.length, trace: r.trace || [], ms: now() - t0 };
  } catch (e) {
    // infrastructure failure (scheduler drop, Ollama timeout) — not a wrong answer
    return { answer: null, confidence: 0, strategy: chosen, requested: strategy, trace: [], ms: now() - t0, skipped: true, error: clip(e.code === 'scheduler_dropped' ? 'scheduler_dropped' : e.message, 200) };
  }
}

/** Agent-facing entry (fleet tool `reason`): solves and logs the call as the consumer measurement. */
export async function reasonForAgent({ problem, kind, strategy, examples, query }, ctx = {}) {
  const answerType = ['number', 'string', 'list', 'code'].includes(kind) ? kind : 'string';
  const r = await solve({ prompt: String(problem || ''), family: 'general', answerType, examples: Array.isArray(examples) ? examples.slice(0, 8) : undefined, query }, { strategy: STRATEGIES.includes(strategy) ? strategy : 'auto' });
  try {
    db.prepare(`INSERT INTO reasoner_calls (agent_id, run_id, family, strategy, answered, confidence, ms, error, created_at) VALUES (?, ?, 'general', ?, ?, ?, ?, ?, ?)`)
      .run(ctx.agentId || ctx.agent?.id || null, ctx.runId || null, r.strategy, r.answer != null ? 1 : 0, r.confidence, r.ms, r.error || null, now());
  } catch (e) { console.error('[reasoner] call log:', e.message); }
  return { answer: r.answer, confidence: r.confidence, strategy: r.strategy, ms: r.ms, verifiedByExecution: ['program', 'induce'].includes(r.strategy) && r.confidence >= 0.7, error: r.error };
}

export function reasonerStats({ days = 7 } = {}) {
  const since = now() - days * 86_400_000;
  try {
    const calls = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT agent_id) agents, SUM(answered) answered, AVG(ms) avgMs FROM reasoner_calls WHERE created_at > ?`).get(since);
    return { models: { reason: MODEL, code: CODE_MODEL }, strategies: STRATEGIES, agentCalls: { ...calls, avgMs: calls.avgMs ? Math.round(calls.avgMs) : null, days }, arms: getArms() };
  } catch (e) { return { models: { reason: MODEL, code: CODE_MODEL }, strategies: STRATEGIES, error: e.message }; }
}
