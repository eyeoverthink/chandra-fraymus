import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { isActionSuppressed } from './adaptive-strategy.js';
import { builtinModules } from 'node:module';

const now = () => Date.now();
const BASE_MAX_ITERATIONS = 5;
const EXEC_TIMEOUT = 15_000;
// Phase AB (2026-11-09): 476 executions, 55 exited 0, 0 loops ever passed — because APPROVAL was
// the LLM critic's call, the critic was prompted to be adversarial (it always found a "major"),
// and it ruled BEFORE the code ran. Inverted. Now: the program must prove itself (PASS markers,
// exit 0), the critic sees the real output and may reject only on a CRITICAL, demonstrated issue,
// and the generator is the coder model.
const GEN_MODEL = process.env.VERIFIER_GEN_MODEL || process.env.SMK_CODE_MODEL || 'qwen2.5-coder:7b';
// the second opinion after an unchanged retry; null = the model pool's default (qwen3:14b on fraymus-home today)
const ESCALATE_MODEL = process.env.VERIFIER_ESCALATE_MODEL || null;
const PASS_MARK = /^PASS\b/m, ALL_PASS = /^ALL PASS\b/m, FAIL_MARK = /^FAIL\b/m;

const GENERATOR_PROMPT = `You are a Generator agent — an expert implementer writing a SELF-PROVING program.
Given a goal, produce one complete, runnable program. Output ONLY the code inside a single markdown code block with the language tag.

Rules:
- JavaScript: an ES module (import syntax, never require) using only node: built-ins (node:assert, node:fs, node:crypto, …) or nothing. Python: standard library only. The sandbox has no packages installed.
- The program must demonstrate the goal on sample data and CHECK its own results with assertions.
- For every check that succeeds print a line starting with "PASS " followed by what was checked; on any failure print a line starting with "FAIL " and exit with a non-zero code.
- The last line printed on success must be exactly "ALL PASS".
- No stubs, no placeholders, no TODOs, no network, no file writes outside the current directory.
- If given feedback from a previous iteration, fix every issue it raises.`;

const VERIFIER_PROMPT = `You are a Verifier agent reviewing a self-proving program TOGETHER WITH ITS ACTUAL EXECUTION OUTPUT.
The sandbox already ran the code; its stdout, stderr and exit code are given. Judge from evidence.

Rules:
- A CRITICAL issue is one that makes the demonstration false or dangerous: the asserts do not test the stated goal, a check always passes trivially, the output contradicts the claim, or the code does something unsafe. You must state the concrete input or line that proves it.
- Everything else (edge cases not covered, missing error handling, style) is MAJOR or MINOR — report it, but it does NOT block approval.
- If the program ran, printed ALL PASS, and has no CRITICAL issue, the verdict is APPROVED.
- If the program failed to run or printed FAIL, the verdict is REJECTED and your issues must explain why from the output.

Output format (JSON only, no markdown fences):
{"verdict": "APPROVED" or "REJECTED", "issues": [{"severity": "critical|major|minor", "description": "..."}], "summary": "one-line assessment"}`;

const EXECUTOR_PROMPT = `You are an Executor agent — you analyze code execution results.
Given code and its execution output (stdout, stderr, exit code), determine if it ran correctly.

Output format (JSON only, no markdown fences):
{"passed": true/false, "analysis": "what happened", "suggestions": ["fix1", "fix2"]}`;

function parseJSON(text, fallback) {
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return fallback; }
}

function extractCode(text) {
  const match = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : text.trim();
}

// Phase V. 0 of 136 loops passed in 24 h: 74 hit max_iterations writing `import pandas from
// 'pandas-js'` in Node (no such package in the sandbox), 56 timed out behind the
// reflection storm, and reflection handed in goals like "Debate on …". Two cheap gates:
// a goal must name something buildable, and code that imports packages the sandbox does
// not have is rejected before it is executed (and never approved as a fossil).
const BUILDABLE = /\b(implement|write|build|create|function|class|module|parse|parser|compute|calculate|sort|search|validate|convert|transform|generate|script|algorithm|simulate|encode|decode|hash|cache|queue|scheduler|state machine|regex|tokeni[sz]e|serial|cli|utility|helper)\b/i;
export function goalUnsuitable(goal) {
  const g = String(goal || '').trim();
  if (g.length < 24) return 'goal too short to specify a program';
  if (/^(debate|discuss|analy[sz]e the intersection|explore|reflect on|consider)\b/i.test(g)) return 'not a programming task';
  if (!BUILDABLE.test(g)) return 'goal names no buildable artifact (expects a verb like implement/parse/compute)';
  return null;
}

const PY_THIRD_PARTY = new Set(['pandas', 'numpy', 'np', 'pd', 'requests', 'scipy', 'sklearn', 'torch', 'tensorflow', 'tf', 'matplotlib', 'flask', 'django', 'bs4', 'yaml', 'httpx', 'aiohttp', 'pydantic', 'sqlalchemy', 'seaborn', 'plotly', 'cv2', 'PIL', 'nltk', 'transformers']);
export function nonBuiltinImports(code, language) {
  const found = new Set();
  if (['javascript', 'js', 'node'].includes(language)) {
    for (const m of String(code).matchAll(/(?:from\s+|import\s+|require\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const base = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!builtinModules.includes(base)) found.add(base);
    }
  } else if (['python', 'py'].includes(language)) {
    for (const m of String(code).matchAll(/^\s*(?:from\s+([A-Za-z_]\w*)|import\s+([A-Za-z_]\w*))/gm)) {
      const name = m[1] || m[2];
      if (PY_THIRD_PARTY.has(name)) found.add(name);
    }
  }
  return [...found];
}

function detectLanguage(text) {
  const match = text.match(/```(\w+)/);
  if (match) return match[1].toLowerCase();
  return detectCodeLanguage(text) || 'unknown';
}

// The language the code is actually written in, from the code itself. Until 2026-11-13 a loop asked for Python ran
// whatever the generator wrote as Python: 3 of 5 tries on the factorial loop were JavaScript and died on line 1 with a
// SyntaxError. The old guesser also tested "import " as a JavaScript sign before any Python sign.
export function detectCodeLanguage(code) {
  const s = String(code || '');
  const js = (s.match(/\bimport\s*\{|\bfrom\s+['"]|\bconst\s+\w|\blet\s+\w|\bfunction\s+\w*\s*\(|=>|console\.log|;\s*$|require\(/gm) || []).length;
  const py = (s.match(/^\s*def\s+\w+\s*\(|^\s*class\s+\w+.*:\s*$|^\s*import\s+[A-Za-z_][\w.]*\s*$|^\s*from\s+[A-Za-z_][\w.]*\s+import\b|\bprint\(|\bself\b|^\s*if\s+__name__\s*==|:\s*$/gm) || []).length;
  if (!js && !py) return null;
  return js > py ? 'javascript' : 'python';
}

const LANG_NAME = { javascript: 'JavaScript (Node.js)', js: 'JavaScript (Node.js)', node: 'JavaScript (Node.js)', python: 'Python 3', py: 'Python 3' };
const canonical = lang => (['javascript', 'js', 'node'].includes(lang) ? 'javascript' : ['python', 'py'].includes(lang) ? 'python' : lang);

// A short, correct example of the proof format in the language asked for — told only in prose, the generator wrote
// Python that proved itself with unittest (no ALL PASS) or switched to JavaScript.
export function languageInstruction(lang) {
  if (canonical(lang) === 'python') return `Write it in Python 3 — not JavaScript. Standard library only. At most 8 distinct checks. The FORMAT to follow (replace solve and the checks with the goal's own function and real checks — never keep this example):
\`\`\`python
def solve(x):
    ...
checks = [(solve(2), 4, "solve(2) == 4")]
for got, want, what in checks:
    if got != want:
        print(f"FAIL {what}: got {got!r}"); raise SystemExit(1)
    print(f"PASS {what}")
print("ALL PASS")
\`\`\``;
  if (canonical(lang) === 'javascript') return `Write it in JavaScript (an ES module for Node.js) — not Python. node: built-ins only. At most 8 distinct checks. The FORMAT to follow (replace solve and the checks with the goal's own function and real checks — never keep this example):
\`\`\`javascript
import assert from 'node:assert/strict';
const solve = x => x * 2;
for (const [got, want, what] of [[solve(2), 4, 'solve(2) === 4']]) { assert.deepEqual(got, want, what); console.log('PASS ' + what); }
console.log('ALL PASS');
\`\`\``;
  return '';
}

// What a failed run failed on, comparable across attempts: the first FAIL line, else the last line of the error,
// with the sandbox's random temp-folder name and line numbers removed so the same error compares equal (three
// cut-off tries on the email loop died on "unterminated string literal (detected at line 116 / 117 / 142)").
export function failureSignature(execResult) {
  const out = String(execResult?.stdout || ''), err = String(execResult?.stderr || '').replace(/\x1b\[[0-9;]*m/g, '');
  const fail = out.match(/^FAIL\b.*$/m)?.[0];
  if (fail) return fail.trim();
  const lines = err.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length) return lines[lines.length - 1].replace(/chandra-verify-[0-9a-f]+/g, 'chandra-verify-*').replace(/\bline \d+/g, 'line N');
  return `exit ${execResult?.exitCode}${execResult?.timedOut ? ' (timeout)' : ''}`;
}

// A reply cut off at the length limit: an opened code fence that never closes. Seen live (email loop, 2026-11-13):
// the 7B generator fell into a repetition loop listing checks ("user@domain.com\x4c", "\x4d", …) until the 3,000-token
// limit cut it mid-line — three tries lost to a SyntaxError that said nothing about the real problem.
export function cutOffReply(text) {
  return ((String(text || '').match(/```/g) || []).length % 2) === 1;
}
export const CUT_OFF_ERROR = 'not executed: the reply was cut off at the length limit (a code block that never closes) — usually an endless list of checks';

// Proof by execution. The program's own ALL PASS (no FAIL, exit 0) — or the standard library's test runner reporting
// success: a Python unittest run that ran ≥ 1 test and ended "OK" is the same evidence in another format (2 of the 5
// factorial tries were correct unittest programs rejected only for not printing ALL PASS).

// The example's own check, left in the code: the program proves the example, not the goal (seen live: a merge goal
// came back as solve(x) = x + 2 with "solve(2) == 4").
export function copiedExample(code) {
  return /solve\(2\)\s*={2,3}\s*4|\[solve\(2\),\s*4,/.test(String(code || ''));
}

export function proofOf(execResult) {
  const out = String(execResult?.stdout || ''), err = String(execResult?.stderr || '');
  const ranClean = execResult?.exitCode === 0 && !execResult?.timedOut;
  if (!ranClean) return { proved: false, how: null };
  if (ALL_PASS.test(out) && !FAIL_MARK.test(out)) return { proved: true, how: 'all_pass' };
  const ran = (out + '\n' + err).match(/^Ran (\d+) tests? in /m);
  if (ran && Number(ran[1]) >= 1 && /^OK\b/m.test(out + '\n' + err) && !/^FAILED\b|^(FAIL|ERROR): /m.test(out + '\n' + err)) return { proved: true, how: 'unittest' };
  return { proved: false, how: null };
}

export async function executeCode(code, language) {
  const tmpDir = path.join(os.tmpdir(), 'chandra-verify-' + randomUUID().slice(0, 8));
  await mkdir(tmpDir, { recursive: true });

  let ext, cmd, args;
  switch (language) {
    case 'javascript':
    case 'js':
    case 'node':
      ext = '.mjs';
      cmd = process.execPath;
      args = [];
      break;
    case 'python':
    case 'py':
      ext = '.py';
      cmd = 'python';
      args = ['-I'];
      break;
    default:
      return { exitCode: -1, stdout: '', stderr: `Unsupported language: ${language}`, executed: false };
  }

  const filePath = path.join(tmpDir, 'verify' + ext);
  await writeFile(filePath, code, 'utf8');
  args.push(filePath);

  return new Promise(resolve => {
    const proc = execFile(cmd, args, {
      timeout: EXEC_TIMEOUT,
      maxBuffer: 64 * 1024,
      cwd: tmpDir,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }, (error, stdout, stderr) => {
      unlink(filePath).catch(() => {});
      resolve({
        exitCode: error ? (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 137 : error.code ?? 1) : 0,
        stdout: String(stdout).slice(0, 8000),
        stderr: String(stderr).slice(0, 8000),
        executed: true,
        timedOut: error?.killed ?? false,
      });
    });
  });
}

export async function runVerifierLoop(goal, { language, maxIterations, context, triggeredBy = 'api' } = {}) {
  if (!goal || typeof goal !== 'string') throw new Error('goal is required');
  // Phase V gates — autonomous loops only; an operator calling the API gets what they asked for.
  if (triggeredBy === 'reflection') {
    if (isActionSuppressed('verify')) return { loopId: null, status: 'suppressed', reason: 'suppressed_by_strategy', iterations: 0 };
    const unsuitable = goalUnsuitable(goal);
    if (unsuitable) {
      try { publish('verifier', 'system.verifier.rejected', JSON.stringify({ goal: goal.slice(0, 120), reason: unsuitable, triggeredBy })); } catch (_) {}
      return { loopId: null, status: 'rejected', reason: unsuitable, iterations: 0 };
    }
  }
  const loopId = randomUUID().slice(0, 12);

  const gateMods = getAutonomyModifiers();
  const scaledMax = Math.round(BASE_MAX_ITERATIONS * gateMods.evolutionRate);
  const effectiveMax = Math.min(10, Math.max(1, scaledMax));
  const iterations = Math.min(effectiveMax, Math.max(1, parseInt(maxIterations) || Math.round(3 * gateMods.evolutionRate)));

  db.prepare(`INSERT INTO verification_loops (id, goal, language, max_iterations, triggered_by, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(
    loopId, goal, language || 'auto', iterations, triggeredBy, now()
  );

  let currentCode = null;
  let feedback = '';
  let finalVerdict = 'incomplete';
  let iteration = 0;
  let lastRanAs = null;   // the language the latest code really ran in
  // A retry that fails the same way cannot pass: the email loop (2026-11-13) got the same regex back five times after
  // the sandbox showed it accepts "user@domain..com" (once with only a variable renamed, so comparing code text missed
  // it). When an attempt fails exactly like the previous one, the next attempt goes to the pool's default model
  // (qwen3:14b on fraymus-home) as a second opinion, told plainly that its change did not touch the cause.
  let prevFailure = null, escalated = false;
  // Reflection's speculative loops may be dropped under load ('verifier' class, 2-min max wait);
  // an operator, agent or research demo asked for this run — 'goal' class is queued but never dropped
  // (a dropped critic call killed the first revived run after the sandbox had already caught a real bug).
  const prio = triggeredBy === 'reflection' ? 'verifier' : 'goal';

  try {
    for (iteration = 1; iteration <= iterations; iteration++) {
      // ── GENERATE ──────────────────────────────────────────
      const wanted = language && language !== 'auto' ? canonical(language) : null;
      const langLine = wanted ? `\n\n${languageInstruction(wanted)}` : '';
      const genPrompt = iteration === 1
        ? (context ? `Goal: ${goal}\n\nContext: ${context}${langLine}` : `Goal: ${goal}${langLine}`)
        : `Goal: ${goal}${langLine}\n\nPrevious code had issues. Feedback:\n${feedback}\n\nFix ALL issues and produce the corrected implementation${wanted ? ` in ${LANG_NAME[wanted]}` : ''}.`;

      const genResponse = await chatOllama([
        { role: 'system', content: GENERATOR_PROMPT },
        { role: 'user', content: genPrompt },
      ], { priority: prio, label: escalated ? 'verifier:generate:escalated' : 'verifier:generate', model: escalated ? ESCALATE_MODEL : GEN_MODEL, temperature: escalated ? 0.4 : 0.2, maxTokens: 3000, timeoutMs: 600_000 });

      currentCode = extractCode(genResponse);
      // run the code as what it is: the fence tag, else the code itself; the requested language only when neither says
      const fence = (genResponse.match(/```(\w+)/) || [])[1]?.toLowerCase();
      const written = canonical(['javascript', 'js', 'node', 'mjs', 'python', 'py'].includes(fence) ? fence : (detectCodeLanguage(currentCode) || ''));
      const detectedLang = written || wanted || detectLanguage(genResponse);
      const switched = wanted && written && written !== wanted;
      lastRanAs = detectedLang;

      db.prepare(`INSERT INTO verification_steps (loop_id, iteration, role, input, output, created_at) VALUES (?, ?, 'generator', ?, ?, ?)`).run(
        loopId, iteration, genPrompt.slice(0, 4000), currentCode.slice(0, 8000), now()
      );

      // ── EXECUTE FIRST — the sandbox is the primary witness ─────────
      const missingDeps = nonBuiltinImports(currentCode, detectedLang);
      const cutOff = cutOffReply(genResponse);
      let execResult;
      if (cutOff) {
        execResult = { exitCode: 1, stdout: '', stderr: CUT_OFF_ERROR, executed: false, timedOut: false };
      } else if (missingDeps.length) {
        execResult = { exitCode: 1, stdout: '', stderr: `not executed: missing packages ${missingDeps.join(', ')}`, executed: false, timedOut: false };
      } else if (['javascript', 'js', 'node', 'python', 'py'].includes(detectedLang)) {
        execResult = await executeCode(currentCode, detectedLang);
      } else {
        execResult = { exitCode: 1, stdout: '', stderr: `not executed: language ${detectedLang} has no sandbox`, executed: false, timedOut: false };
      }
      // proved = ran clean and declared ALL PASS with no FAIL line, or the stdlib test runner reported success
      // (proofOf). Per-check "PASS …" lines are requested but not required — an assert throwing is evidence enough.
      const { proved, how: provedBy } = proofOf(execResult);
      // stuck = the same check failed the same way as last time (behaviour, not code text)
      const failure = proved ? null : failureSignature(execResult);
      const stuck = !!(failure && prevFailure && failure === prevFailure);
      if (stuck) escalated = true;
      prevFailure = failure;
      const perCheckLines = (execResult.stdout.match(/^PASS\b.*$/gm) || []).length;
      db.prepare(`INSERT INTO verification_steps (loop_id, iteration, role, input, output, verdict, created_at) VALUES (?, ?, 'executor', ?, ?, ?, ?)`).run(
        loopId, iteration, currentCode.slice(0, 4000),
        JSON.stringify({ exitCode: execResult.exitCode, stdout: execResult.stdout.slice(0, 2000), stderr: execResult.stderr.slice(0, 2000), timedOut: execResult.timedOut, proved, provedBy, ranAs: detectedLang, asked: wanted, perCheckLines }).slice(0, 8000),
        proved ? 'PASSED' : 'FAILED', now()
      );

      // ── VERIFY — the critic reviews code + real output; only CRITICAL blocks ─────
      const verifyResponse = await chatOllama([
        { role: 'system', content: VERIFIER_PROMPT },
        { role: 'user', content: `Goal: ${goal}\nLanguage: ${detectedLang}\n\nCode:\n\`\`\`${detectedLang}\n${currentCode.slice(0, 6000)}\n\`\`\`\n\nExecution: exit code ${execResult.exitCode}${execResult.timedOut ? ' (timed out)' : ''}\nstdout:\n${execResult.stdout.slice(0, 1500) || '(empty)'}\nstderr:\n${execResult.stderr.slice(0, 1000) || '(empty)'}` },
      ], { priority: prio, label: 'verifier:review', format: 'json', temperature: 0.1, timeoutMs: 300_000 });

      const verdict = parseJSON(verifyResponse, { verdict: 'REJECTED', issues: [{ severity: 'critical', description: 'Failed to parse verifier output' }], summary: 'Parse error' });
      if (!Array.isArray(verdict.issues)) verdict.issues = [];
      if (copiedExample(currentCode)) verdict.issues.unshift({ severity: 'critical', description: 'The program still contains the format example (solve(2) == 4). Replace it with a function and checks for the goal itself.' });
      if (cutOff) verdict.issues.unshift({ severity: 'critical', description: 'Your reply was cut off before the code block closed: it ran past the length limit, almost always by listing checks without end. Write at most 8 distinct checks and close the code block.' });
      if (missingDeps.length) verdict.issues.unshift({ severity: 'critical', description: `Imports packages that do not exist in the sandbox: ${missingDeps.join(', ')}. Use the standard library only (Node: node:* built-ins).` });
      if (!proved) {
        const why = execResult.timedOut ? 'timed out after 15 s' : execResult.exitCode !== 0 ? `exited ${execResult.exitCode}` : FAIL_MARK.test(execResult.stdout) ? 'printed a FAIL line' : 'did not print "ALL PASS"';
        verdict.issues.unshift({ severity: 'critical', description: `The program did not prove itself: ${why}. Fix the failing check, print "PASS …" for each check, and end with "ALL PASS".` });
      } else if (perCheckLines === 0 && provedBy !== 'unittest') {
        verdict.issues.push({ severity: 'minor', description: 'No per-check "PASS …" lines were printed; the run proved itself by exit code and ALL PASS only.' });
      }
      const critical = verdict.issues.filter(i => String(i.severity).toLowerCase() === 'critical');
      // Approval = proved by execution AND no demonstrated critical issue. The critic cannot approve an unproven run, and cannot block a proven one on majors.
      verdict.verdict = proved && critical.length === 0 ? 'APPROVED' : 'REJECTED';
      verdict.proved = proved;

      db.prepare(`INSERT INTO verification_steps (loop_id, iteration, role, input, output, verdict, created_at) VALUES (?, ?, 'verifier', ?, ?, ?, ?)`).run(
        loopId, iteration, currentCode.slice(0, 4000), JSON.stringify(verdict).slice(0, 8000), verdict.verdict, now()
      );

      if (verdict.verdict === 'APPROVED') {
        finalVerdict = 'approved';
        break;
      }

      // ── BUILD FEEDBACK ────────────────────────────────────
      feedback = `Issues (fix the critical ones first):\n${verdict.issues.map(i => `- [${i.severity}] ${i.description}`).join('\n')}`;
      if (switched) feedback = `- [critical] You wrote ${LANG_NAME[written]}, but this program must be ${LANG_NAME[wanted]}. Rewrite it in ${LANG_NAME[wanted]}.\n${feedback}`;
      if (stuck) feedback = `- [critical] This attempt failed EXACTLY like the previous one (${failure.slice(0, 160)}). Your change did not touch the cause. Rethink the logic this check exercises; do not resubmit the same approach.\n${feedback}`;
      feedback += `\n\nExecution result (exit code ${execResult.exitCode}):`;
      if (execResult.stdout) feedback += `\nstdout: ${execResult.stdout.slice(0, 2000)}`;
      if (execResult.stderr) feedback += `\nstderr: ${execResult.stderr.slice(0, 2000)}`;
      if (execResult.timedOut) feedback += '\n(TIMED OUT — process killed after 15s)';
    }

    // ── FINALIZE ──────────────────────────────────────────────
    const status = finalVerdict === 'approved' ? 'passed' : (iteration > iterations ? 'max_iterations' : 'failed');
    const triesUsed = Math.min(iteration, iterations);

    // the for-loop leaves `iteration` one past the last try when every try was used (it recorded 6 of 5)
    db.prepare(`UPDATE verification_loops SET status = ?, iterations_used = ?, final_code = ?, language = COALESCE(?, language), completed_at = ? WHERE id = ?`).run(
      status, triesUsed, currentCode?.slice(0, 16000), ['javascript', 'python'].includes(lastRanAs) ? lastRanAs : null, now(), loopId
    );

    // Save fossil if approved
    if (status === 'passed' && currentCode) {
      try {
        storeMemory('system', 'fossil', `verified:${goal.slice(0, 100)}`, JSON.stringify({
          goal, code: currentCode.slice(0, 4000), language: language || 'auto',
          iterations: triesUsed, escalated, verifiedAt: now(), loopId, // Phase AC: the skill forge crystallizes by loop id
        }), { confidence: 1.0, source: 'verifier-loop' });
      } catch (_) {}

      try {
        publish('system', 'system.evolution', JSON.stringify({
          action: 'code_verified', loopId, goal: goal.slice(0, 200),
          iterations: triesUsed, escalated, status, gateTier: gateMods.tier,
          evolutionRate: gateMods.evolutionRate, effectiveMax, at: now(),
        }));
      } catch (_) {}
    }

    return {
      loopId, status, iterations: triesUsed, escalated, maxIterations: iterations,
      effectiveMax, gateTier: gateMods.tier, evolutionRate: gateMods.evolutionRate,
      code: currentCode?.slice(0, 8000), goal,
    };
  } catch (err) {
    db.prepare(`UPDATE verification_loops SET status = 'error', error = ?, completed_at = ? WHERE id = ?`).run(
      err.message.slice(0, 2000), now(), loopId
    );
    throw err;
  }
}

export function getLoop(id) {
  const loop = db.prepare('SELECT * FROM verification_loops WHERE id = ?').get(id);
  if (!loop) return null;
  const steps = db.prepare('SELECT * FROM verification_steps WHERE loop_id = ? ORDER BY iteration, created_at').all(id);
  return { ...loop, steps };
}

export function listLoops({ limit = 20 } = {}) {
  return db.prepare('SELECT id, goal, language, status, iterations_used, max_iterations, triggered_by, created_at, completed_at FROM verification_loops ORDER BY created_at DESC LIMIT ?').all(
    Math.min(100, Math.max(1, limit))
  );
}

export function installVerifierRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.post('/api/verify/run', route(async (req, res) => {
    const { goal, language, maxIterations, context } = req.body;
    if (!goal) return res.status(400).json({ error: 'goal required' });
    const result = await runVerifierLoop(goal, { language, maxIterations, context, triggeredBy: 'api' });
    res.status(201).json(result);
  }));

  app.get('/api/verify/loops', route((_req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(_req.query.limit) || 20));
    res.json({ loops: listLoops({ limit }) });
  }));

  app.get('/api/verify/loops/:id', route((req, res) => {
    const loop = getLoop(req.params.id);
    if (!loop) return res.status(404).json({ error: 'Loop not found' });
    res.json(loop);
  }));
}
