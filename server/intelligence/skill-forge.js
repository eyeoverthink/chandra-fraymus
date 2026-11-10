/**
 * Skill Forge — Phase AC: proven programs become callable capabilities.
 *
 * Why (2026-11-10). Phase AB made the verifier pass (3 of 4 loops in the last 24 h) and every pass
 * became a "fossil": a memory with confidence 1.0 that prompt evolution pastes into agents as text.
 * Nothing ever EXECUTED a fossil again. That is the self-audit's F1 defect — a producer without a
 * consumer — sitting on the one output the organism can actually prove. This module closes it:
 *
 *   passed verification loop ──► crystallize (coder model wraps the proven mechanism as a
 *   stdin-JSON → stdout-JSON module with a declared input schema and examples)
 *   ──► static gate (allow-listed node: builtins only; no fs/net/child_process/env/eval)
 *   ──► smoke gate (every example runs in the sandbox and must print what it promised; run twice,
 *   determinism recorded) ──► registered at runtime as fleet tool `skill.<name>` for every agent
 *   ──► every call is measured (ms, ok/fail, which run) ──► outcomes compared with executions that
 *   used no skill ──► failing skills retire themselves; unused ones are flagged by the self-audit.
 *
 * The ladder (curriculum): once two skills exist, one verifier goal a day asks for a program that
 * COMBINES two of them. A pass is a fossil, and the next crystallization turns it into a third skill.
 * Capability accretes from the organism's own verified work, never from merged source: a skill is a
 * file in data/skills/ plus a row, reversible with one retire call, and it never touches the repo.
 *
 * Sandbox (defence in depth, in order): static scan → `--permission --allow-fs-read=<skills dir>`
 * (Node ≥ 22: no fs write, no child_process, no worker_threads) → `--disallow-code-generation-from-
 * strings` → stripped env (PATH only; the verifier's sandbox still inherits the server env — this one
 * does not) → 15 s timeout → 256 KB output cap.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { chatOllama } from '../commerce/shared.js';
import { nonBuiltinImports, runVerifierLoop } from './verifier-loop.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { isResourceConstrained } from './resource-envelope.js';
import { tunable } from './tunables.js';

const now = () => Date.now();
const H = 3_600_000, DAY = 24 * H;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// absolute on purpose: the sandbox child runs with SKILL_DIR as cwd, and `--allow-fs-read` resolves
// a relative path against that cwd (a relative `data/skills` would have pointed inside itself)
const DATA_DIR = resolve(process.env.CHANDRA_DATA_DIR || join(REPO_ROOT, 'data'));
export const SKILL_DIR = resolve(DATA_DIR, 'skills');

const ENABLED = process.env.SKILL_FORGE_ENABLED !== '0';
const MODEL = process.env.SKILL_FORGE_MODEL || process.env.SMK_CODE_MODEL || 'qwen2.5-coder:7b';
const MAX_ITER = Math.max(1, Math.min(4, parseInt(process.env.SKILL_CRYSTALLIZE_ITERATIONS, 10) || 3));
const DEFAULT_PER_DAY = Math.max(0, parseInt(process.env.SKILL_CRYSTALLIZE_PER_DAY, 10) || 3);
const perDay = () => Math.round(tunable('skills.crystallize_per_day', DEFAULT_PER_DAY));
const COMPOSE_PER_DAY = Math.max(0, parseInt(process.env.SKILL_COMPOSE_PER_DAY, 10) || 1);
const SMOKE_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 15_000;
const RETIRE_MIN_CALLS = 10;
const RETIRE_FAILURE_RATE = 0.5;
const MAX_CODE_CHARS = 12_000;
const FOR_ALL_AGENTS = process.env.SKILLS_FOR_ALL_AGENTS !== '0';

const ALLOWED_BUILTINS = new Set(['crypto', 'util', 'buffer', 'events', 'stream', 'string_decoder', 'zlib', 'assert', 'url', 'querystring', 'readline', 'path', 'perf_hooks', 'process', 'stream/promises']);
const FORBIDDEN_BODY = [
  [/process\.env\b/, 'reads process.env'],
  [/\beval\s*\(/, 'uses eval'],
  [/new\s+Function\s*\(/, 'uses new Function'],
  [/\bimport\s*\(/, 'uses dynamic import()'],
  [/\brequire\s*\(/, 'uses require() — this is an ES module; use `import x from "node:…"` or no imports at all'],
  [/process\.binding|process\.dlopen|process\.chdir|process\.kill/, 'touches process internals'],
  [/\bWebAssembly\b/, 'uses WebAssembly'],
  [/\bfetch\s*\(|new\s+WebSocket|XMLHttpRequest/, 'opens a network connection'],
];

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const SANDBOX_FLAGS = (() => {
  const flags = ['--disallow-code-generation-from-strings', '--no-warnings'];
  if (nodeMajor >= 22) flags.push('--permission', `--allow-fs-read=${SKILL_DIR}`);
  else if (nodeMajor >= 20) flags.push('--experimental-permission', `--allow-fs-read=${SKILL_DIR}`);
  return flags;
})();

// ─── Schema ──────────────────────────────────────────────────────
function ensureTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS forged_skills (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    examples TEXT NOT NULL,
    code TEXT NOT NULL,
    file TEXT,
    source_loop_id TEXT,
    source_goal TEXT,
    source_kind TEXT NOT NULL DEFAULT 'fossil',
    status TEXT NOT NULL,
    failure TEXT,
    smoke TEXT,
    deterministic INTEGER,
    iterations INTEGER DEFAULT 1,
    calls INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    total_ms INTEGER NOT NULL DEFAULT 0,
    last_called_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    retired_at INTEGER,
    retired_by TEXT
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_forged_skills_status ON forged_skills(status)`).run();
  // calls refused before the sandbox because the caller omitted required fields — the agent's error, not the skill's
  try { db.prepare(`ALTER TABLE forged_skills ADD COLUMN caller_errors INTEGER NOT NULL DEFAULT 0`).run(); } catch (_) {}
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_forged_skills_loop ON forged_skills(source_loop_id)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS forged_skill_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL,
    agent_id TEXT,
    run_id TEXT,
    thread_id TEXT,
    ok INTEGER NOT NULL,
    ms INTEGER NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_forged_skill_calls_skill ON forged_skill_calls(skill_id, created_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_forged_skill_calls_run ON forged_skill_calls(run_id)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS skill_compositions (
    id TEXT PRIMARY KEY,
    skill_a TEXT NOT NULL,
    skill_b TEXT NOT NULL,
    goal TEXT NOT NULL,
    loop_id TEXT,
    status TEXT NOT NULL,
    result_skill_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
}
try { ensureTables(); mkdirSync(SKILL_DIR, { recursive: true }); } catch (e) { console.error('[skills] schema:', e.message); }

const q1 = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (e) { console.error('[skills] q1:', e.message); return null; } };
const qa = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { console.error('[skills] qa:', e.message); return []; } };
const parse = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };

const state = { running: false, crystallizing: false, composing: false, cycles: 0, lastCycleAt: 0, lastCycle: null, registered: 0, lastError: null };

// ─── Sandbox runner ──────────────────────────────────────────────
export function runSkillProcess(file, input, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return new Promise(resolvePromise => {
    const t0 = now();
    let child;
    try {
      child = execFile(process.execPath, [...SANDBOX_FLAGS, file], {
        timeout: timeoutMs, maxBuffer: 256 * 1024, cwd: SKILL_DIR, windowsHide: true,
        env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', SKILL_SANDBOX: '1' },
      }, (error, stdout, stderr) => {
        const ms = now() - t0;
        const out = String(stdout || '');
        const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
        let output = null, parseError = null;
        try { output = JSON.parse(lastLine); } catch (e) { parseError = lastLine ? `last stdout line is not JSON: ${e.message}` : 'no stdout'; }
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        const ok = exitCode === 0 && output !== null && typeof output === 'object';
        resolvePromise({ ok, exitCode, timedOut: !!error?.killed, stdout: out.slice(0, 4000), stderr: String(stderr || '').slice(0, 2000), output, parseError, ms });
      });
    } catch (e) { return resolvePromise({ ok: false, exitCode: -1, timedOut: false, stdout: '', stderr: e.message, output: null, parseError: null, ms: now() - t0 }); }
    try { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input ?? {})); } catch (_) {}
  });
}

// ─── Static gate ─────────────────────────────────────────────────
export function staticCheck(code) {
  const problems = [];
  const text = String(code || '');
  if (!text.trim()) return ['empty code'];
  if (text.length > MAX_CODE_CHARS) problems.push(`code is ${text.length} chars (max ${MAX_CODE_CHARS})`);
  const thirdParty = nonBuiltinImports(text, 'javascript');
  if (thirdParty.length) problems.push(`imports packages the sandbox lacks: ${thirdParty.join(', ')}`);
  for (const m of text.matchAll(/(?:from\s+|import\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1].replace(/^node:/, '');
    if (!ALLOWED_BUILTINS.has(spec)) problems.push(`import "${m[1]}" is not on the allow-list (${[...ALLOWED_BUILTINS].join(', ')})`);
  }
  for (const [re, why] of FORBIDDEN_BODY) if (re.test(text)) problems.push(why);
  if (!/\bstdin\b|readline/.test(text)) problems.push('never reads stdin — a skill must read one JSON object from stdin');
  if (!/\bstdout\b|console\.log/.test(text)) problems.push('never writes stdout');
  return problems;
}

function validManifest(m) {
  const problems = [];
  if (!m || typeof m !== 'object') return ['manifest is not a JSON object'];
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(String(m.name || ''))) problems.push('name must be snake_case, 3–41 chars');
  if (typeof m.description !== 'string' || m.description.trim().length < 12 || m.description.length > 400) problems.push('description must be one sentence (12–400 chars)');
  const s = m.input_schema;
  if (!s || typeof s !== 'object' || s.type !== 'object' || !s.properties || typeof s.properties !== 'object' || Object.keys(s.properties).length === 0 || Object.keys(s.properties).length > 8) problems.push('input_schema must be {type:"object", properties:{1–8 fields}}');
  if (!Array.isArray(m.examples) || m.examples.length < 1 || m.examples.length > 5) problems.push('examples must list 1–5 entries');
  else for (const [i, ex] of m.examples.entries()) {
    if (!ex || typeof ex.input !== 'object' || ex.input === null) problems.push(`example ${i + 1} has no input object`);
    if (ex.expect == null) problems.push(`example ${i + 1} has no expect — an example without an expectation proves nothing`);
    else if (typeof ex.expect === 'string' ? !ex.expect.trim().length : ['number', 'boolean'].includes(typeof ex.expect) ? false : (typeof ex.expect !== 'object' || Array.isArray(ex.expect) || !Object.keys(ex.expect).length)) problems.push(`example ${i + 1}: expect must be a value (string, number, true/false) or an object of expected output fields`);
  }
  return problems;
}

function extractBlocks(raw) {
  const text = String(raw || '');
  // `\b` matters: without it "```js" matched the prefix of "```json" and the manifest's tail was
  // validated as the module (first live attempt: "never reads stdin" twice, for a program that did)
  const json = text.match(/```json\b[ \t]*\r?\n([\s\S]*?)```/i);
  const code = text.match(/```(?:javascript|mjs|js)\b[ \t]*\r?\n([\s\S]*?)```/i);
  return { manifest: json ? parse(json[1].trim(), null) : null, code: code ? code[1].trim() : null, manifestRaw: json ? json[1].trim() : null };
}

// ─── Crystallization ─────────────────────────────────────────────
const CRYSTALLIZE_SYSTEM = `You convert a PROVEN program into a reusable, sandboxed SKILL: a Node ES module that reads ONE JSON object from stdin and writes ONE JSON object to stdout.

Rules (violations are rejected by a machine, not a reviewer):
- STATELESS: every call is a fresh process that lives for one input. If the mechanism has state (a window, a bitmap, a model, a history), the caller passes the state IN as an input field and you return the updated state in the output. Never keep state between calls.
- ES module syntax only. Imports, only if needed, only from this list: node:crypto, node:util, node:buffer, node:events, node:stream, node:string_decoder, node:zlib, node:assert, node:url, node:querystring, node:readline, node:path, node:perf_hooks. No require(). No fs, net, http, child_process, os, process.env, eval, new Function, dynamic import(), fetch.
- Read stdin completely using process.stdin directly (for example: let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => s += c); process.stdin.on('end', () => { ... })), JSON.parse it, validate the fields, compute with the SAME mechanism the proven program demonstrated, then write exactly one line: process.stdout.write(JSON.stringify(result) + "\\n"). The result must always be a JSON OBJECT (never undefined, null or a bare value). On invalid input write {"error":"..."} and process.exit(2).
- Deterministic: identical input → identical output. No Date.now(), no Math.random() unless a seed field is part of the input.
- Under 150 lines. Nothing else on stdout. Keep the mechanism; DROP the demo's assertions, PASS/ALL PASS checks and hard-coded demo data entirely — a skill computes a result from its input, it never asserts what the result should be and never exits because a check "failed".

Respond with exactly two fenced blocks and nothing else:

\`\`\`json
{"name": "snake_case_name", "description": "One sentence: what the skill computes, from what input.", "input_schema": {"type": "object", "properties": {"field": {"type": "string", "description": "..."}}, "required": ["field"]}, "examples": [{"input": {"field": "..."}, "expect": "a substring the JSON output line will contain"}, {"input": {"field": "..."}, "expect": "..."}]}
\`\`\`

\`\`\`javascript
// the module
\`\`\`

Give 2 or 3 examples (each a complete, independent input — they do not share state). "expect" is a VALUE that must appear in the output (a number, a word, true/false) or an object of output fields that must be equal, e.g. {"old": true}. Key names alone never satisfy an expectation. The examples are executed; wrong expectations fail the skill.`;

function uniqueName(base) {
  let name = `skill.${base}`;
  let n = 2;
  while (q1(`SELECT 1 FROM forged_skills WHERE name = ?`, name)) name = `skill.${base}_${n++}`;
  return name;
}

/**
 * Does the output satisfy the example's expectation? A string expectation must equal one of the
 * output's leaf VALUES (stringified) or appear inside a string value — keys never count: the first
 * live skill "passed" an example expecting "dup" because the output was {"dup":false}. An object
 * expectation must deep-equal every field it names.
 */
export function expectationMet(output, expect) {
  if (expect == null) return true;
  if (output == null || typeof output !== 'object') return false;
  if (typeof expect === 'object') {
    return Object.entries(expect).every(([k, v]) => JSON.stringify(output[k]) === JSON.stringify(v));
  }
  const want = String(expect).trim();   // numbers and booleans compare by their string form against leaf values
  const leaves = [];
  const walk = v => { if (v && typeof v === 'object') Object.values(v).forEach(walk); else leaves.push(v); };
  walk(output);
  return leaves.some(v => String(v) === want || (typeof v === 'string' && want.length >= 2 && v.includes(want)));
}

async function smokeTest(file, examples) {
  const results = [];
  for (const [i, ex] of examples.entries()) {
    const r = await runSkillProcess(file, ex.input, { timeoutMs: SMOKE_TIMEOUT_MS });
    const printed = r.output ? JSON.stringify(r.output) : '';
    const expectOk = expectationMet(r.output, ex.expect);
    results.push({ i: i + 1, ok: r.ok && expectOk, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms, expect: ex.expect ?? null, expectOk, output: printed.slice(0, 400), stderr: r.stderr.slice(0, 300), parseError: r.parseError });
  }
  let deterministic = null;
  if (results[0]?.ok) {
    const again = await runSkillProcess(file, examples[0].input, { timeoutMs: SMOKE_TIMEOUT_MS });
    deterministic = again.ok && JSON.stringify(again.output) === results[0].output;
  }
  return { results, passed: results.every(r => r.ok), deterministic };
}

function smokeFeedback(smoke, staticProblems, manifestProblems) {
  const lines = [];
  for (const p of manifestProblems) lines.push(`- manifest: ${p}`);
  for (const p of staticProblems) lines.push(`- code: ${p}`);
  let stateHint = false, assertHint = false;
  for (const r of (smoke?.results || [])) if (!r.ok) {
    lines.push(`- example ${r.i} failed: exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}; ${r.parseError || (r.expectOk ? 'the process exited non-zero although the output looked right' : `output ${r.output || '(empty)'} has no VALUE equal to ${JSON.stringify(r.expect)} (keys do not count)`)}${r.stderr ? `; stderr: ${r.stderr.slice(0, 200)}` : ''}`);
    if (r.i > 1 && r.exitCode === 0 && !r.expectOk) stateHint = true;
    if (r.exitCode === 2 || /assert|expected|actual/i.test(r.output || '') || /AssertionError/.test(r.stderr || '')) assertHint = true;
  }
  // the first live fossil (an anti-replay window) failed twice on the same misunderstanding: the model
  // expected example 2 to see example 1's effect. Say exactly what to do instead of restating the rule.
  if (stateHint) lines.push(`- DESIGN: examples run as separate processes, so example ${2} cannot see what example 1 did. If the mechanism carries state (window, bitmap, counters, history, model weights), add an optional input field "state" (the full state object; absent = fresh), return the updated "state" in every output, and write example 2's input.state as the exact state object example 1's output contains. Alternatively make each example self-contained (pass the whole sequence of events in one input and return the verdict for each).`);
  if (assertHint) lines.push(`- DESIGN: the skill must not assert or validate the RESULT. Remove every assert / PASS check copied from the demo and every process.exit on a failed check; compute from the input and print the result. Exit 2 only when the INPUT is malformed.`);
  return lines.join('\n');
}

/** Pick the next passed verification loop that was never crystallized (newest first). */
export function nextFossilCandidate() {
  return q1(`SELECT v.id, v.goal, v.final_code, v.created_at, v.triggered_by FROM verification_loops v
             WHERE v.status = 'passed' AND v.final_code IS NOT NULL AND length(v.final_code) > 80
               AND NOT EXISTS (SELECT 1 FROM forged_skills s WHERE s.source_loop_id = v.id)
             ORDER BY v.created_at DESC LIMIT 1`);
}

/**
 * Turn one passed loop into a registered skill. Up to MAX_ITER coder calls; each failed attempt feeds
 * its machine-produced reasons back. Every attempt ends in a row: `active` or `failed` (so the same
 * fossil is never retried silently — `force` re-attempts a failed one).
 */
export async function crystallize({ loopId = null, force = false, trigger = 'api' } = {}) {
  if (!ENABLED) return { crystallized: false, reason: 'disabled' };
  if (state.crystallizing) return { crystallized: false, reason: 'already_crystallizing' };
  const loop = loopId
    ? q1(`SELECT id, goal, final_code, created_at, triggered_by, status FROM verification_loops WHERE id = ?`, loopId)
    : nextFossilCandidate();
  if (!loop) return { crystallized: false, reason: loopId ? 'loop_not_found' : 'no_fossil_candidates' };
  if (loop.status && loop.status !== 'passed') return { crystallized: false, reason: 'loop_not_passed' };
  const prior = q1(`SELECT id, status FROM forged_skills WHERE source_loop_id = ?`, loop.id);
  if (prior && !force) return { crystallized: false, reason: prior.status === 'active' ? 'already_crystallized' : 'previously_failed', skillId: prior.id };
  if (prior && force) {
    // every earlier row for this loop goes (failed attempts included) so the ledger shows one outcome per fossil
    try { for (const r of qa(`SELECT id, name, file FROM forged_skills WHERE source_loop_id = ?`, loop.id)) { if (r.file && existsSync(r.file)) { try { unlinkSync(r.file); } catch (_) {} } if (r.name?.startsWith('skill.')) unregisterSkillTool(r.name).catch(() => {}); } db.prepare(`DELETE FROM forged_skills WHERE source_loop_id = ?`).run(loop.id); } catch (e) { console.error('[skills] force cleanup:', e.message); }
  }

  state.crystallizing = true;
  const id = `sk_${randomUUID().slice(0, 8)}`;
  const t0 = now();
  const file = join(SKILL_DIR, `${id}.mjs`);
  const attempts = [];
  let feedback = '';
  let lastCode = '', lastManifest = null;
  try {
    for (let iteration = 1; iteration <= MAX_ITER; iteration++) {
      const user = iteration === 1
        ? `Proven program (it printed ALL PASS in the sandbox) for the goal:\n"${clip(loop.goal, 600)}"\n\n\`\`\`javascript\n${String(loop.final_code).slice(0, 9000)}\n\`\`\`\n\nWrap its mechanism as a skill.`
        : `Your previous skill was rejected. Reasons:\n${feedback}\n\nProduce the corrected manifest and module (same two fenced blocks). Proven program for reference:\n\`\`\`javascript\n${String(loop.final_code).slice(0, 6000)}\n\`\`\``;
      let raw;
      try {
        raw = await chatOllama([{ role: 'system', content: CRYSTALLIZE_SYSTEM }, { role: 'user', content: user }],
          { model: MODEL, priority: 'goal', label: `skills:crystallize:${id}`, temperature: 0.1, maxTokens: 3500, timeoutMs: 600_000 });
      } catch (e) {
        attempts.push({ iteration, error: e.message });
        feedback = `the model call failed: ${e.message}`;
        continue;
      }
      const { manifest, code } = extractBlocks(raw);
      lastCode = code || clip(raw, 4000); lastManifest = manifest;
      const manifestProblems = validManifest(manifest);
      const staticProblems = code ? staticCheck(code) : ['no javascript block in the answer'];
      let smoke = null;
      if (!manifestProblems.length && !staticProblems.length) {
        writeFileSync(file, code, 'utf8');
        smoke = await smokeTest(file, manifest.examples);
      }
      const ok = smoke?.passed === true;
      attempts.push({ iteration, manifestProblems, staticProblems, smoke: smoke && { passed: smoke.passed, deterministic: smoke.deterministic, results: smoke.results.map(r => ({ i: r.i, ok: r.ok, ms: r.ms, expectOk: r.expectOk })) } });
      if (ok) {
        const name = uniqueName(manifest.name);
        const t = now();
        db.prepare(`INSERT INTO forged_skills (id, name, description, input_schema, examples, code, file, source_loop_id, source_goal, source_kind, status, smoke, deterministic, iterations, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
          .run(id, name, manifest.description.trim(), JSON.stringify(manifest.input_schema), JSON.stringify(manifest.examples), code, file, loop.id, loop.goal,
            String(loop.triggered_by || '').startsWith('skill-forge') ? 'composition' : 'fossil', JSON.stringify(smoke), smoke.deterministic ? 1 : 0, iteration, t, t);
        const row = getSkill(id);
        await registerSkillTool(row);
        try { db.prepare(`UPDATE skill_compositions SET status = 'crystallized', result_skill_id = ?, updated_at = ? WHERE loop_id = ?`).run(id, t, loop.id); } catch (_) {}
        try { storeMemory('system', 'skill', `skill:${name}`, JSON.stringify({ id, name, description: row.description, examples: manifest.examples.slice(0, 2), fromGoal: clip(loop.goal, 200) }), { confidence: 1.0, source: 'skill-forge' }); } catch (_) {}
        try { publish('skills', 'system.skills', JSON.stringify({ action: 'crystallized', id, name, description: row.description, loopId: loop.id, iterations: iteration, deterministic: smoke.deterministic, durationMs: now() - t0, trigger })); } catch (_) {}
        console.log(`[skills] crystallized ${name} from loop ${loop.id} in ${iteration} attempt(s), ${Math.round((now() - t0) / 1000)} s`);
        return { crystallized: true, id, name, iterations: iteration, deterministic: smoke.deterministic, durationMs: now() - t0 };
      }
      feedback = smokeFeedback(smoke, staticProblems, manifestProblems);
    }
    // all attempts failed → record so the fossil is not retried every cycle
    try { if (existsSync(file)) unlinkSync(file); } catch (_) {}
    const t = now();
    const failure = clip(feedback || 'no usable answer', 1500);
    // keep the last rejected code + manifest so the failure is diagnosable from the panel, not just a reason string
    db.prepare(`INSERT INTO forged_skills (id, name, description, input_schema, examples, code, file, source_loop_id, source_goal, status, failure, iterations, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'failed', ?, ?, ?, ?)`)
      .run(id, `failed.${id}`, `crystallization failed: ${clip(loop.goal, 120)}`, JSON.stringify(lastManifest?.input_schema || {}), JSON.stringify(Array.isArray(lastManifest?.examples) ? lastManifest.examples : []), String(lastCode).slice(0, MAX_CODE_CHARS), loop.id, loop.goal, failure, MAX_ITER, t, t);
    try { publish('skills', 'system.skills', JSON.stringify({ action: 'crystallize_failed', id, loopId: loop.id, reason: clip(failure, 200), attempts: attempts.length, trigger })); } catch (_) {}
    return { crystallized: false, reason: 'all_attempts_failed', id, attempts, failure };
  } catch (e) {
    state.lastError = e.message;
    try { if (existsSync(file)) unlinkSync(file); } catch (_) {}
    return { crystallized: false, reason: 'error', error: e.message, attempts };
  } finally { state.crystallizing = false; }
}

// ─── Runtime registration ────────────────────────────────────────
let runtimeRef = null;
async function runtime() {
  // late import: fleet/runtime.js is a leaf for the daemon; a static import here would form a cycle
  if (!runtimeRef) runtimeRef = await import('../fleet/runtime.js');
  return runtimeRef;
}

function safeSchema(json) {
  const s = parse(json, null);
  if (!s || typeof s !== 'object') return { type: 'object', properties: {} };
  return { type: 'object', properties: s.properties || {}, ...(Array.isArray(s.required) ? { required: s.required } : {}) };
}

function toolFor(row) {
  const examples = parse(row.examples, []);
  const example = examples[0]?.input ? ` Example input: ${clip(JSON.stringify(examples[0].input), 160)}.` : '';
  return {
    name: row.name,
    group: 'skill',
    risk: 'safe',
    skillId: row.id,
    forAllAgents: FOR_ALL_AGENTS,
    // the first live agent call sent {seq} without the required action field — the example in the
    // description is what a 7B model actually reads; the schema's `required` alone was not enough
    description: `${row.description}${example} [forged skill: sandboxed, stateless, proven by execution; from "${clip(row.source_goal, 90)}"]`,
    parameters: safeSchema(row.input_schema),
    execute: async ({ args }, ctx) => invokeSkill(row.id, args || {}, ctx || {}),
  };
}

/** Required-field check before the sandbox: a caller's omission is reported, not executed. */
function missingRequired(row, input) {
  const schema = parse(row.input_schema, {});
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.filter(k => input == null || typeof input !== 'object' || input[k] === undefined);
}

export async function registerSkillTool(row) {
  const rt = await runtime();
  if (typeof rt.addFleetTools !== 'function') throw new Error('fleet runtime has no addFleetTools');
  rt.addFleetTools([toolFor(row)]);
  state.registered = qa(`SELECT id FROM forged_skills WHERE status = 'active'`).length;
  return true;
}

async function unregisterSkillTool(name) {
  const rt = await runtime();
  if (typeof rt.removeFleetTools === 'function') rt.removeFleetTools([name]);
  state.registered = qa(`SELECT id FROM forged_skills WHERE status = 'active'`).length;
}

/** Called by agents through the tool, by the API test route, and by the judge. */
export async function invokeSkill(id, input, ctx = {}) {
  const row = q1(`SELECT * FROM forged_skills WHERE id = ?`, id);
  if (!row) return { error: 'unknown skill' };
  if (row.status !== 'active') return { error: `skill is ${row.status}` };
  const missing = missingRequired(row, input);
  if (missing.length) {
    const examples = parse(row.examples, []);
    const t = now();
    try {
      db.prepare(`INSERT INTO forged_skill_calls (skill_id, agent_id, run_id, thread_id, ok, ms, error, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)`)
        .run(id, ctx.agentId || ctx.agent?.id || null, ctx.runId || null, ctx.threadId || null, `caller: missing required ${missing.join(', ')}`, t);
      db.prepare(`UPDATE forged_skills SET caller_errors = caller_errors + 1, updated_at = ? WHERE id = ?`).run(t, id);
    } catch (e) { console.error('[skills] record caller error:', e.message); }
    return { skill: row.name, error: `missing required field(s): ${missing.join(', ')}`, required: parse(row.input_schema, {}).required || [], example: examples[0]?.input ?? null };
  }
  if (!row.file || !existsSync(row.file)) {
    // file lost (data dir moved?) — rewrite from the stored code; the row is the source of truth
    try { writeFileSync(row.file || join(SKILL_DIR, `${row.id}.mjs`), row.code, 'utf8'); } catch (e) { return { error: `skill file missing and could not be restored: ${e.message}` }; }
  }
  const r = await runSkillProcess(row.file, input);
  const t = now();
  const err = r.ok ? null : clip(r.output?.error || r.parseError || r.stderr || `exit ${r.exitCode}${r.timedOut ? ' (timeout)' : ''}`, 300);
  try {
    db.prepare(`INSERT INTO forged_skill_calls (skill_id, agent_id, run_id, thread_id, ok, ms, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.agentId || ctx.agent?.id || null, ctx.runId || null, ctx.threadId || null, r.ok ? 1 : 0, r.ms, err, t);
    db.prepare(`UPDATE forged_skills SET calls = calls + 1, failures = failures + ?, total_ms = total_ms + ?, last_called_at = ?, updated_at = ? WHERE id = ?`).run(r.ok ? 0 : 1, r.ms, t, t, id);
  } catch (e) { console.error('[skills] record call:', e.message); }
  if (!r.ok) maybeAutoRetire(id);
  return r.ok ? { skill: row.name, output: r.output, ms: r.ms } : { skill: row.name, error: err, exitCode: r.exitCode, timedOut: r.timedOut, stderr: r.stderr.slice(0, 500), ms: r.ms };
}

function maybeAutoRetire(id) {
  const row = q1(`SELECT id, name, calls, failures, status FROM forged_skills WHERE id = ?`, id);
  if (!row || row.status !== 'active' || row.calls < RETIRE_MIN_CALLS) return;
  if (row.failures / row.calls > RETIRE_FAILURE_RATE) retireSkill(id, { by: 'auto', reason: `failure rate ${Math.round(row.failures / row.calls * 100)}% over ${row.calls} calls` });
}

export function retireSkill(id, { by = 'operator', reason = '' } = {}) {
  const row = q1(`SELECT id, name, status FROM forged_skills WHERE id = ?`, id);
  if (!row) return { ok: false, error: 'unknown skill' };
  if (row.status === 'retired') return { ok: false, error: 'already retired' };
  if (row.status !== 'active') return { ok: false, error: `cannot retire a ${row.status} skill` };
  const t = now();
  db.prepare(`UPDATE forged_skills SET status = 'retired', retired_at = ?, retired_by = ?, failure = ?, updated_at = ? WHERE id = ?`).run(t, by, reason || null, t, id);
  unregisterSkillTool(row.name).catch(e => console.error('[skills] unregister:', e.message));
  try { publish('skills', 'system.skills', JSON.stringify({ action: 'retired', id, name: row.name, by, reason })); } catch (_) {}
  return { ok: true, id, name: row.name, by, reason };
}

export async function restoreSkill(id, { by = 'operator' } = {}) {
  const row = q1(`SELECT * FROM forged_skills WHERE id = ?`, id);
  if (!row) return { ok: false, error: 'unknown skill' };
  if (row.status !== 'retired') return { ok: false, error: `skill is ${row.status}, not retired` };
  const t = now();
  db.prepare(`UPDATE forged_skills SET status = 'active', retired_at = NULL, retired_by = NULL, failure = NULL, calls = 0, failures = 0, total_ms = 0, updated_at = ? WHERE id = ?`).run(t, id);
  await registerSkillTool(getSkill(id));
  try { publish('skills', 'system.skills', JSON.stringify({ action: 'restored', id, name: row.name, by })); } catch (_) {}
  return { ok: true, id, name: row.name };
}

// ─── Composition ladder ──────────────────────────────────────────
export async function proposeComposition({ trigger = 'api', force = false } = {}) {
  if (!ENABLED) return { composed: false, reason: 'disabled' };
  if (state.composing) return { composed: false, reason: 'already_composing' };
  if (!force && isResourceConstrained()) return { composed: false, reason: 'resource_constrained' };
  const today = q1(`SELECT COUNT(*) AS c FROM skill_compositions WHERE created_at > ?`, now() - DAY)?.c || 0;
  if (!force && today >= COMPOSE_PER_DAY) return { composed: false, reason: 'daily_compose_cap', today, max: COMPOSE_PER_DAY };
  const active = qa(`SELECT id, name, description FROM forged_skills WHERE status = 'active' ORDER BY RANDOM()`);
  if (active.length < 2) return { composed: false, reason: 'fewer_than_two_skills', active: active.length };
  // least-recently-paired first: avoid re-proposing the same pair
  let pair = null;
  for (const a of active) for (const b of active) {
    if (a.id === b.id) continue;
    const seen = q1(`SELECT 1 FROM skill_compositions WHERE (skill_a = ? AND skill_b = ?) OR (skill_a = ? AND skill_b = ?)`, a.id, b.id, b.id, a.id);
    if (!seen) { pair = [a, b]; break; }
    if (!pair) pair = [a, b];
  }
  if (!pair) return { composed: false, reason: 'no_pair' };
  const [a, b] = pair;
  const goal = `Build a minimal self-contained Node ES module that COMBINES two proven mechanisms into one useful computation: (A) ${a.description} (B) ${b.description} Feed A's result into B, or run both on the same toy data and check an invariant that only holds when both are correct. Deterministic, ≤ 150 lines, standard library only; make each check print "PASS …" and finish with "ALL PASS".`;
  const id = `comp_${randomUUID().slice(0, 8)}`;
  const t = now();
  db.prepare(`INSERT INTO skill_compositions (id, skill_a, skill_b, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`).run(id, a.id, b.id, goal, t, t);
  state.composing = true;
  let r;
  try { r = await runVerifierLoop(goal, { language: 'javascript', maxIterations: 3, triggeredBy: `skill-forge:${trigger}` }); }
  catch (e) { r = { loopId: null, status: 'error', error: e.message }; }
  finally { state.composing = false; }
  const status = r.status === 'passed' ? 'passed' : `loop_${r.status || 'error'}`;
  db.prepare(`UPDATE skill_compositions SET loop_id = ?, status = ?, updated_at = ? WHERE id = ?`).run(r.loopId || null, status, now(), id);
  try { publish('skills', 'system.skills', JSON.stringify({ action: 'composition', id, a: a.name, b: b.name, loopId: r.loopId, status: r.status, iterations: r.iterations, trigger })); } catch (_) {}
  return { composed: r.status === 'passed', id, a: a.name, b: b.name, loopId: r.loopId, status: r.status, iterations: r.iterations };
}

// ─── Daemon cycle ────────────────────────────────────────────────
/** One crystallization (≤ skills.crystallize_per_day) then one composition (≤ COMPOSE_PER_DAY). */
export async function skillForgeCycle({ trigger = 'daemon' } = {}) {
  const out = { trigger, at: now(), crystallize: null, compose: null };
  state.cycles++; state.lastCycleAt = out.at;
  if (!ENABLED) { out.reason = 'disabled'; state.lastCycle = out; return out; }
  if (isResourceConstrained()) { out.reason = 'resource_constrained'; state.lastCycle = out; return out; }
  // the cap counts skills that EXIST (active or since retired), not attempts: attempts are bounded by the
  // number of passed loops (each fossil is tried once) and must not be able to starve the next fossil
  const today = q1(`SELECT COUNT(*) AS c FROM forged_skills WHERE status != 'failed' AND created_at > ?`, now() - DAY)?.c || 0;
  if (today >= perDay()) out.crystallize = { crystallized: false, reason: 'daily_cap', today, max: perDay() };
  else if (!nextFossilCandidate()) out.crystallize = { crystallized: false, reason: 'no_fossil_candidates' };
  else out.crystallize = await crystallize({ trigger });
  out.compose = await proposeComposition({ trigger });
  state.lastCycle = out;
  return out;
}

// ─── Measurement (the consumer side) ─────────────────────────────
export function skillOutcomes({ days = 7 } = {}) {
  const since = now() - days * DAY;
  const withSkill = q1(`SELECT COUNT(*) AS n, AVG(quality) AS q FROM goal_executions ge WHERE ge.quality IS NOT NULL AND ge.started_at > ?
                        AND EXISTS (SELECT 1 FROM forged_skill_calls c WHERE c.run_id = ge.run_id)`, since) || { n: 0, q: null };
  const without = q1(`SELECT COUNT(*) AS n, AVG(quality) AS q FROM goal_executions ge WHERE ge.quality IS NOT NULL AND ge.started_at > ?
                      AND NOT EXISTS (SELECT 1 FROM forged_skill_calls c WHERE c.run_id = ge.run_id)`, since) || { n: 0, q: null };
  const r = n => n == null ? null : Math.round(n * 1000) / 1000;
  return { days, withSkill: { n: withSkill.n, meanQuality: r(withSkill.q) }, without: { n: without.n, meanQuality: r(without.q) }, delta: withSkill.q != null && without.q != null ? r(withSkill.q - without.q) : null };
}

export function getSkill(id) {
  const row = q1(`SELECT * FROM forged_skills WHERE id = ? OR name = ?`, id, id);
  if (!row) return null;
  return { ...row, input_schema: parse(row.input_schema, {}), examples: parse(row.examples, []), smoke: parse(row.smoke, null), meanMs: row.calls ? Math.round(row.total_ms / row.calls) : null,
    recentCalls: qa(`SELECT agent_id, run_id, ok, ms, error, created_at FROM forged_skill_calls WHERE skill_id = ? ORDER BY created_at DESC LIMIT 20`, row.id) };
}

export function listSkills({ status = null, limit = 50 } = {}) {
  const rows = status ? qa(`SELECT * FROM forged_skills WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, limit) : qa(`SELECT * FROM forged_skills ORDER BY created_at DESC LIMIT ?`, limit);
  return rows.map(r => ({ id: r.id, name: r.name, description: r.description, status: r.status, source_kind: r.source_kind, source_loop_id: r.source_loop_id, source_goal: clip(r.source_goal, 160), deterministic: !!r.deterministic, iterations: r.iterations, calls: r.calls, failures: r.failures, caller_errors: r.caller_errors || 0, meanMs: r.calls ? Math.round(r.total_ms / r.calls) : null, last_called_at: r.last_called_at, failure: r.failure, examples: parse(r.examples, []), input_schema: parse(r.input_schema, {}), created_at: r.created_at, retired_at: r.retired_at, retired_by: r.retired_by }));
}

export function getSkillForgeStatus() {
  const counts = {};
  for (const r of qa(`SELECT status, COUNT(*) AS c FROM forged_skills GROUP BY status`)) counts[r.status] = r.c;
  const calls24h = q1(`SELECT COUNT(*) AS c, SUM(ok) AS ok, COUNT(DISTINCT agent_id) AS agents FROM forged_skill_calls WHERE created_at > ?`, now() - DAY) || { c: 0, ok: 0, agents: 0 };
  const compositions = {};
  for (const r of qa(`SELECT status, COUNT(*) AS c FROM skill_compositions GROUP BY status`)) compositions[r.status] = r.c;
  const candidate = nextFossilCandidate();
  return {
    enabled: ENABLED, running: state.running, crystallizing: state.crystallizing, composing: state.composing, cycles: state.cycles, lastCycleAt: state.lastCycleAt, lastCycle: state.lastCycle, lastError: state.lastError,
    registered: state.registered, counts, calls24h: { total: calls24h.c, ok: calls24h.ok || 0, agents: calls24h.agents || 0 }, compositions,
    nextCandidate: candidate && { loopId: candidate.id, goal: clip(candidate.goal, 160), createdAt: candidate.created_at },
    outcomes: skillOutcomes({ days: 7 }),
    config: { model: MODEL, maxIterations: MAX_ITER, perDay: perDay(), composePerDay: COMPOSE_PER_DAY, forAllAgents: FOR_ALL_AGENTS, sandboxFlags: SANDBOX_FLAGS, skillDir: SKILL_DIR, callTimeoutMs: CALL_TIMEOUT_MS, retire: { minCalls: RETIRE_MIN_CALLS, failureRate: RETIRE_FAILURE_RATE } },
    sandboxStripsEnv: true,
  };
}

// ─── Lifecycle ───────────────────────────────────────────────────
export async function startSkillForge() {
  if (!ENABLED) return { started: false, reason: 'SKILL_FORGE_ENABLED=0' };
  mkdirSync(SKILL_DIR, { recursive: true });
  const rows = qa(`SELECT * FROM forged_skills WHERE status = 'active' ORDER BY created_at ASC`);
  let loaded = 0;
  for (const row of rows) {
    try {
      if (!row.file || !existsSync(row.file)) writeFileSync(row.file || join(SKILL_DIR, `${row.id}.mjs`), row.code, 'utf8');
      const problems = staticCheck(row.code);
      if (problems.length) { console.error(`[skills] ${row.name} fails today's static gate (${problems[0]}) — retiring`); retireSkill(row.id, { by: 'boot', reason: `static gate: ${problems[0]}` }); continue; }
      await registerSkillTool(row); loaded++;
    } catch (e) { console.error(`[skills] load ${row.name}:`, e.message); }
  }
  state.running = true;
  return { started: true, loaded, sandboxFlags: SANDBOX_FLAGS, model: MODEL, perDay: perDay(), forAllAgents: FOR_ALL_AGENTS };
}

export function stopSkillForge() { state.running = false; return { stopped: true, registeredKept: state.registered }; }

// ─── Routes ──────────────────────────────────────────────────────
export function installSkillForgeRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const B = '/api/intelligence/skills';
  app.get(B, route((_req, res) => res.json(getSkillForgeStatus())));
  app.get(`${B}/list`, route((req, res) => res.json({ skills: listSkills({ status: req.query.status || null, limit: Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50)) }) })));
  app.get(`${B}/outcomes`, route((req, res) => res.json(skillOutcomes({ days: Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7)) }))));
  app.get(`${B}/compositions`, route((req, res) => res.json({ compositions: qa(`SELECT * FROM skill_compositions ORDER BY created_at DESC LIMIT ?`, Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))) })));
  app.post(`${B}/cycle`, route(async (_req, res) => res.json(await skillForgeCycle({ trigger: 'api' }))));
  app.post(`${B}/crystallize`, route(async (req, res) => { const r = await crystallize({ loopId: req.body?.loopId || null, force: !!req.body?.force, trigger: 'api' }); res.status(r.crystallized ? 201 : 409).json(r); }));
  app.post(`${B}/compose`, route(async (req, res) => { const r = await proposeComposition({ trigger: 'api', force: !!req.body?.force }); res.status(r.composed ? 201 : 200).json(r); }));
  app.get(`${B}/:id`, route((req, res) => { const s = getSkill(req.params.id); s ? res.json(s) : res.status(404).json({ error: 'not found' }); }));
  app.post(`${B}/:id/test`, route(async (req, res) => { const s = getSkill(req.params.id); if (!s) return res.status(404).json({ error: 'not found' }); res.json(await invokeSkill(s.id, req.body?.input ?? s.examples[0]?.input ?? {}, { agentId: 'operator', threadId: 'api' })); }));
  app.post(`${B}/:id/retire`, route((req, res) => { const r = retireSkill(req.params.id, { by: req.body?.by || 'operator', reason: req.body?.reason || '' }); res.status(r.ok ? 200 : 409).json(r); }));
  app.post(`${B}/:id/restore`, route(async (req, res) => { const r = await restoreSkill(req.params.id, { by: req.body?.by || 'operator' }); res.status(r.ok ? 200 : 409).json(r); }));
}
