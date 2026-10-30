import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { storeMemory } from '../fleet/agent-memory.js';

const now = () => Date.now();
const MAX_ITERATIONS = 5;
const EXEC_TIMEOUT = 15_000;

const GENERATOR_PROMPT = `You are a Generator agent — an expert software architect and implementer.
Given a goal, produce a complete, working implementation. Output ONLY the code or solution, no explanations.

Rules:
- Write complete, runnable code (not pseudocode, not stubs)
- Include all imports and dependencies
- Handle errors properly
- If given feedback from a previous iteration, address every issue raised
- Output the solution inside a single markdown code block with the language tag`;

const VERIFIER_PROMPT = `You are a Verifier agent — an adversarial code reviewer and critic.
Your job is to find REAL problems in the code. You are skeptical and thorough.

Rules:
- Look for: bugs, edge cases, missing error handling, stubs, placeholder logic, security issues
- Do NOT nitpick style — focus on correctness and completeness
- Rate severity: critical (will crash/wrong output), major (significant edge case), minor (improvement)
- If the code is genuinely correct and complete, say APPROVED

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

function detectLanguage(text) {
  const match = text.match(/```(\w+)/);
  if (match) return match[1].toLowerCase();
  if (text.includes('import ') || text.includes('const ') || text.includes('function ')) return 'javascript';
  if (text.includes('def ') || text.includes('import ')) return 'python';
  return 'unknown';
}

async function executeCode(code, language) {
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
  const loopId = randomUUID().slice(0, 12);
  const iterations = Math.min(MAX_ITERATIONS, Math.max(1, parseInt(maxIterations) || 3));

  db.prepare(`INSERT INTO verification_loops (id, goal, language, max_iterations, triggered_by, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(
    loopId, goal, language || 'auto', iterations, triggeredBy, now()
  );

  let currentCode = null;
  let feedback = '';
  let finalVerdict = 'incomplete';
  let iteration = 0;

  try {
    for (iteration = 1; iteration <= iterations; iteration++) {
      // ── GENERATE ──────────────────────────────────────────
      const genPrompt = iteration === 1
        ? (context ? `Goal: ${goal}\n\nContext: ${context}` : `Goal: ${goal}`)
        : `Goal: ${goal}\n\nPrevious code had issues. Feedback:\n${feedback}\n\nFix ALL issues and produce the corrected implementation.`;

      const genResponse = await chatOllama([
        { role: 'system', content: GENERATOR_PROMPT },
        { role: 'user', content: genPrompt },
      ]);

      currentCode = extractCode(genResponse);
      const detectedLang = language || detectLanguage(genResponse);

      db.prepare(`INSERT INTO verification_steps (loop_id, iteration, role, input, output, created_at) VALUES (?, ?, 'generator', ?, ?, ?)`).run(
        loopId, iteration, genPrompt.slice(0, 4000), currentCode.slice(0, 8000), now()
      );

      // ── VERIFY ────────────────────────────────────────────
      const verifyResponse = await chatOllama([
        { role: 'system', content: VERIFIER_PROMPT },
        { role: 'user', content: `Language: ${detectedLang}\n\nCode to review:\n\`\`\`${detectedLang}\n${currentCode}\n\`\`\`` },
      ]);

      const verdict = parseJSON(verifyResponse, { verdict: 'REJECTED', issues: [{ severity: 'critical', description: 'Failed to parse verifier output' }], summary: 'Parse error' });

      db.prepare(`INSERT INTO verification_steps (loop_id, iteration, role, input, output, verdict, created_at) VALUES (?, ?, 'verifier', ?, ?, ?, ?)`).run(
        loopId, iteration, currentCode.slice(0, 4000), JSON.stringify(verdict).slice(0, 8000), verdict.verdict, now()
      );

      if (verdict.verdict === 'APPROVED') {
        finalVerdict = 'approved';
        break;
      }

      // ── EXECUTE (if code is runnable) ─────────────────────
      let execResult = null;
      if (['javascript', 'js', 'node', 'python', 'py'].includes(detectedLang)) {
        execResult = await executeCode(currentCode, detectedLang);

        db.prepare(`INSERT INTO verification_steps (loop_id, iteration, role, input, output, verdict, created_at) VALUES (?, ?, 'executor', ?, ?, ?, ?)`).run(
          loopId, iteration, currentCode.slice(0, 4000),
          JSON.stringify({ exitCode: execResult.exitCode, stdout: execResult.stdout.slice(0, 2000), stderr: execResult.stderr.slice(0, 2000), timedOut: execResult.timedOut }).slice(0, 8000),
          execResult.exitCode === 0 ? 'PASSED' : 'FAILED', now()
        );
      }

      // ── BUILD FEEDBACK ────────────────────────────────────
      feedback = `Verifier issues:\n${verdict.issues.map(i => `- [${i.severity}] ${i.description}`).join('\n')}`;
      if (execResult) {
        feedback += `\n\nExecution result (exit code ${execResult.exitCode}):`;
        if (execResult.stdout) feedback += `\nstdout: ${execResult.stdout.slice(0, 2000)}`;
        if (execResult.stderr) feedback += `\nstderr: ${execResult.stderr.slice(0, 2000)}`;
        if (execResult.timedOut) feedback += '\n(TIMED OUT — process killed after 15s)';
      }
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
          iterations: iteration, status, at: now(),
        }));
      } catch (_) {}
    }

    return {
      loopId, status, iterations: iteration, maxIterations: iterations,
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
