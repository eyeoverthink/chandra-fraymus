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
  if (text.includes('import ') || text.includes('const ') || text.includes('function ')) return 'javascript';
  if (text.includes('def ') || text.includes('import ')) return 'python';
  return 'unknown';
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
  // Reflection's speculative loops may be dropped under load ('verifier' class, 2-min max wait);
  // an operator, agent or research demo asked for this run — 'goal' class is queued but never dropped
  // (a dropped critic call killed the first revived run after the sandbox had already caught a real bug).
  const prio = triggeredBy === 'reflection' ? 'verifier' : 'goal';

  try {
    for (iteration = 1; iteration <= iterations; iteration++) {
      // ── GENERATE ──────────────────────────────────────────
      const genPrompt = iteration === 1
        ? (context ? `Goal: ${goal}\n\nContext: ${context}` : `Goal: ${goal}`)
        : `Goal: ${goal}\n\nPrevious code had issues. Feedback:\n${feedback}\n\nFix ALL issues and produce the corrected implementation.`;

      const genResponse = await chatOllama([
        { role: 'system', content: GENERATOR_PROMPT },
        { role: 'user', content: genPrompt },
      ], { priority: prio, label: 'verifier:generate', model: GEN_MODEL, temperature: 0.2, maxTokens: 3000, timeoutMs: 600_000 });

      currentCode = extractCode(genResponse);
      const detectedLang = language && language !== 'auto' ? language : detectLanguage(genResponse);

      db.prepare(`INSERT INTO verification_steps (loop_id, iteration, role, input, output, created_at) VALUES (?, ?, 'generator', ?, ?, ?)`).run(
        loopId, iteration, genPrompt.slice(0, 4000), currentCode.slice(0, 8000), now()
      );

      // ── EXECUTE FIRST — the sandbox is the primary witness ─────────
      const missingDeps = nonBuiltinImports(currentCode, detectedLang);
      let execResult;
      if (missingDeps.length) {
        execResult = { exitCode: 1, stdout: '', stderr: `not executed: missing packages ${missingDeps.join(', ')}`, executed: false, timedOut: false };
      } else if (['javascript', 'js', 'node', 'python', 'py'].includes(detectedLang)) {
        execResult = await executeCode(currentCode, detectedLang);
      } else {
        execResult = { exitCode: 1, stdout: '', stderr: `not executed: language ${detectedLang} has no sandbox`, executed: false, timedOut: false };
      }
      const ranClean = execResult.exitCode === 0 && !execResult.timedOut;
      const proved = ranClean && ALL_PASS.test(execResult.stdout) && PASS_MARK.test(execResult.stdout) && !FAIL_MARK.test(execResult.stdout);
      db.prepare(`INSERT INTO verification_steps (loop_id, iteration, role, input, output, verdict, created_at) VALUES (?, ?, 'executor', ?, ?, ?, ?)`).run(
        loopId, iteration, currentCode.slice(0, 4000),
        JSON.stringify({ exitCode: execResult.exitCode, stdout: execResult.stdout.slice(0, 2000), stderr: execResult.stderr.slice(0, 2000), timedOut: execResult.timedOut, proved }).slice(0, 8000),
        proved ? 'PASSED' : 'FAILED', now()
      );

      // ── VERIFY — the critic reviews code + real output; only CRITICAL blocks ─────
      const verifyResponse = await chatOllama([
        { role: 'system', content: VERIFIER_PROMPT },
        { role: 'user', content: `Goal: ${goal}\nLanguage: ${detectedLang}\n\nCode:\n\`\`\`${detectedLang}\n${currentCode.slice(0, 6000)}\n\`\`\`\n\nExecution: exit code ${execResult.exitCode}${execResult.timedOut ? ' (timed out)' : ''}\nstdout:\n${execResult.stdout.slice(0, 1500) || '(empty)'}\nstderr:\n${execResult.stderr.slice(0, 1000) || '(empty)'}` },
      ], { priority: prio, label: 'verifier:review', format: 'json', temperature: 0.1, timeoutMs: 300_000 });

      const verdict = parseJSON(verifyResponse, { verdict: 'REJECTED', issues: [{ severity: 'critical', description: 'Failed to parse verifier output' }], summary: 'Parse error' });
      if (!Array.isArray(verdict.issues)) verdict.issues = [];
      if (missingDeps.length) verdict.issues.unshift({ severity: 'critical', description: `Imports packages that do not exist in the sandbox: ${missingDeps.join(', ')}. Use the standard library only (Node: node:* built-ins).` });
      if (!proved) {
        const why = execResult.timedOut ? 'timed out after 15 s' : execResult.exitCode !== 0 ? `exited ${execResult.exitCode}` : !ALL_PASS.test(execResult.stdout) ? 'did not print "ALL PASS" as its last successful line' : 'printed a FAIL line';
        verdict.issues.unshift({ severity: 'critical', description: `The program did not prove itself: ${why}. Every check must print "PASS …" and the run must end with "ALL PASS".` });
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
      feedback += `\n\nExecution result (exit code ${execResult.exitCode}):`;
      if (execResult.stdout) feedback += `\nstdout: ${execResult.stdout.slice(0, 2000)}`;
      if (execResult.stderr) feedback += `\nstderr: ${execResult.stderr.slice(0, 2000)}`;
      if (execResult.timedOut) feedback += '\n(TIMED OUT — process killed after 15s)';
    }

    // ── FINALIZE ──────────────────────────────────────────────
    const status = finalVerdict === 'approved' ? 'passed' : (iteration > iterations ? 'max_iterations' : 'failed');

    db.prepare(`UPDATE verification_loops SET status = ?, iterations_used = ?, final_code = ?, completed_at = ? WHERE id = ?`).run(
      status, iteration, currentCode?.slice(0, 16000), now(), loopId
    );

    // Save fossil if approved
    if (status === 'passed' && currentCode) {
      try {
        storeMemory('system', 'fossil', `verified:${goal.slice(0, 100)}`, JSON.stringify({
          goal, code: currentCode.slice(0, 4000), language: language || 'auto',
          iterations: iteration, verifiedAt: now(),
        }), { confidence: 1.0, source: 'verifier-loop' });
      } catch (_) {}

      try {
        publish('system', 'system.evolution', JSON.stringify({
          action: 'code_verified', loopId, goal: goal.slice(0, 200),
          iterations: iteration, status, gateTier: gateMods.tier,
          evolutionRate: gateMods.evolutionRate, effectiveMax, at: now(),
        }));
      } catch (_) {}
    }

    return {
      loopId, status, iterations: iteration, maxIterations: iterations,
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
