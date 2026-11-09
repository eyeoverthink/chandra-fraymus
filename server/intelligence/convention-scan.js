/**
 * Convention scan — Phase Z: a grounded proposal source for the self-modification kernel.
 *
 * The Ouroboros proposer reads a file LIST and invents advice ("use JWT", "add Jest").
 * This module reads the CODE and finds violations of the conventions this codebase has
 * already written down in CLAUDE.md → Code Conventions:
 *   - no silent `catch {}` blocks — always log e.message
 *   - query params are coerced AND clamped (Math.min/Math.max)
 *   - external fetch() calls carry AbortSignal.timeout(...)
 *   - async Express routes forward errors to next()
 * Every finding is file:line + the offending snippet + a sketch the coder model can act on
 * inside ONE function. Findings are deterministic, deduplicated by (file, rule, snippet) and
 * resolved automatically when a later scan no longer sees them — the consumer is the kernel's
 * code tier, which builds a branch per finding; the operator merges.
 *
 * Measured 2026-11-09 before the first scan: 481 silent catches, 15 unclamped parseInt(req.query.*).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();
const REPO_ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'test', 'fixtures', 'vendor']);
// Files the kernel must never edit (mirrors self-modification.js DENIED) — findings there are reported but marked unbuildable.
export const PROTECTED = new Set(['server/db.js', 'server/db-migrate.js', 'server/config.js', 'server/index.js', 'server/app.js', 'server/runtime.js', 'server/lifecycle.js', 'server/local-http.js', 'server/mcp/auth.js', 'server/data-lock.js', 'server/intelligence/self-modification.js', 'server/intelligence/tunables.js', 'server/intelligence/opeg.js', 'server/intelligence/convention-scan.js']);

// priority: lower = build first. Deterministic, so the kernel's queue is explainable.
export const RULES = [
  {
    id: 'unclamped_query_param', priority: 1, title: 'Clamp a query parameter',
    test(line) { return /parseInt\(\s*(?:req\.query|query)\.(\w+)/.test(line) && !/Math\.(min|max)|clamp\(/.test(line); },
    sketch(line) {
      const m = line.match(/parseInt\(\s*(?:req\.query|query)\.(\w+)/);
      return `The query parameter "${m?.[1] || 'value'}" is parsed with parseInt but never clamped. Coerce and clamp it to a sane range in the same expression, e.g. Math.min(500, Math.max(1, parseInt(req.query.${m?.[1] || 'value'}, 10) || <default>)), keeping the existing default. Change nothing else.`;
    },
  },
  {
    id: 'route_without_next', priority: 2, title: 'Forward route errors to next()',
    // an inline async handler that does not receive `next` and is not wrapped by a route() helper
    test(line) { return /app\.(get|post|put|delete|patch)\(\s*['"`]/.test(line) && /async\s*\(\s*req\s*,\s*res\s*\)\s*=>/.test(line) && !/route\(/.test(line); },
    sketch() { return 'This async route handler does not receive `next`, so a thrown error becomes an unhandled rejection instead of a JSON error response. Change the handler signature to (req, res, next) and wrap its body in try/catch that calls next(e) on error (or wrap it with the file\'s existing route() helper if one exists). Behaviour on success must not change.'; },
  },
  {
    id: 'fetch_without_timeout', priority: 3, title: 'Add a timeout to an external fetch',
    test(line, ctx) {
      if (!/\bfetch\(/.test(line) || /AbortSignal|signal\s*:/.test(ctx)) return false;
      if (/127\.0\.0\.1|localhost|OLLAMA|ollamaUrl|\/api\/chat|\/api\/tags/.test(ctx)) return false; // local calls are governed by the scheduler, not this rule
      return /https?:\/\/|url|endpoint|href/i.test(ctx);
    },
    sketch() { return 'This fetch() to an external service has no timeout. Add `signal: AbortSignal.timeout(15_000)` to its options object (create the options object if the call has none), matching the codebase convention for external APIs. Change nothing else.'; },
    contextLines: 8,
  },
  {
    id: 'silent_catch', priority: 4, title: 'Log a silently swallowed error',
    test(line) { return /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/.test(line); },
    sketch(line, ctx, file) {
      const mod = file.split('/').pop().replace(/\.js$/, '');
      return `This catch block swallows the error silently. Give it a bound error (catch (e)) and log a one-line message with the module and what was being attempted, e.g. console.error('[${mod}] <what failed>:', e.message). If the surrounding comment proves silence is intentional (a best-effort cleanup), add a short comment saying so instead of a log. Keep every other statement unchanged.`;
    },
  },
];
const RULE_BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]));

function ensureTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS smk_convention_findings (
    key TEXT PRIMARY KEY,
    rule TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    snippet TEXT,
    title TEXT,
    sketch TEXT,
    protected INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    proposal_id TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    resolved_at INTEGER
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_smk_conv_status ON smk_convention_findings(status, rule)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS smk_convention_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    files INTEGER, findings INTEGER, new_findings INTEGER, resolved INTEGER, duration_ms INTEGER, created_at INTEGER NOT NULL
  )`).run();
}
try { ensureTable(); } catch (e) { console.error('[convention-scan] schema:', e.message); }

function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name), depth + 1); }
    else if (e.isFile() && /\.(js|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name)) yield join(dir, e.name);
  }
}

export function scanFile(abs) {
  const rel = relative(REPO_ROOT, abs).split(sep).join('/');
  let src; try { src = readFileSync(abs, 'utf8'); } catch { return []; }
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // comment lines
    for (const r of RULES) {
      const ctx = r.contextLines ? lines.slice(i, i + r.contextLines).join('\n') : line;
      if (!r.test(line, ctx)) continue;
      const snippet = line.trim().slice(0, 200);
      const key = createHash('sha1').update(`${rel}|${r.id}|${snippet}`).digest('hex').slice(0, 20);
      out.push({ key, rule: r.id, file: rel, line: i + 1, snippet, title: `${r.title}: ${rel}:${i + 1}`, sketch: r.sketch(line, ctx, rel), protected: PROTECTED.has(rel) ? 1 : 0, priority: r.priority });
    }
  }
  return out;
}

/** Scan the tree, upsert findings, resolve the ones that disappeared. */
export function scanConventions({ roots = ['server'] } = {}) {
  const t0 = now();
  const findings = [];
  let files = 0;
  for (const root of roots) for (const f of walk(join(REPO_ROOT, root))) { files++; findings.push(...scanFile(f)); }
  const t = now();
  const seen = new Set(findings.map(f => f.key));
  const upsert = db.prepare(`INSERT INTO smk_convention_findings (key, rule, file, line, snippet, title, sketch, protected, status, first_seen, last_seen)
    VALUES (@key, @rule, @file, @line, @snippet, @title, @sketch, @protected, 'open', @t, @t)
    ON CONFLICT(key) DO UPDATE SET line = excluded.line, last_seen = excluded.last_seen, resolved_at = NULL,
      status = CASE WHEN smk_convention_findings.status = 'fixed' THEN 'open' ELSE smk_convention_findings.status END`);
  let newCount = 0;
  const tx = db.transaction(() => {
    for (const f of findings) {
      const existed = db.prepare(`SELECT 1 FROM smk_convention_findings WHERE key = ?`).get(f.key);
      if (!existed) newCount++;
      upsert.run({ ...f, t });
    }
    // anything open that this scan did not see is gone from the code → resolved
    const open = db.prepare(`SELECT key FROM smk_convention_findings WHERE resolved_at IS NULL`).all();
    let resolved = 0;
    const res = db.prepare(`UPDATE smk_convention_findings SET resolved_at = ?, status = CASE WHEN status IN ('building') THEN status ELSE 'fixed' END WHERE key = ?`);
    for (const r of open) if (!seen.has(r.key)) { res.run(t, r.key); resolved++; }
    return resolved;
  });
  const resolved = tx();
  const dur = now() - t0;
  db.prepare(`INSERT INTO smk_convention_scans (files, findings, new_findings, resolved, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(files, findings.length, newCount, resolved, dur, t);
  const byRule = countsByRule();
  try { publish('smk', 'system.self_modification', JSON.stringify({ action: 'convention_scan', files, findings: findings.length, newFindings: newCount, resolved, byRule, durationMs: dur })); } catch (_) {}
  return { files, findings: findings.length, newFindings: newCount, resolved, durationMs: dur, byRule };
}

export function countsByRule() {
  const rows = db.prepare(`SELECT rule, COUNT(*) AS c FROM smk_convention_findings WHERE resolved_at IS NULL AND status = 'open' GROUP BY rule`).all();
  return Object.fromEntries(rows.map(r => [r.rule, r.c]));
}

export function listConventionFindings({ rule = null, status = 'open', limit = 50 } = {}) {
  const where = [`resolved_at IS NULL`];
  const params = [];
  if (status) { where.push(`status = ?`); params.push(status); }
  if (rule) { where.push(`rule = ?`); params.push(rule); }
  const rows = db.prepare(`SELECT * FROM smk_convention_findings WHERE ${where.join(' AND ')} ORDER BY protected ASC, file, line LIMIT ?`).all(...params, Math.min(500, Math.max(1, limit)));
  return rows.sort((a, b) => (RULE_BY_ID[a.rule]?.priority ?? 9) - (RULE_BY_ID[b.rule]?.priority ?? 9) || a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * The next finding the code tier should build: open, unprotected, not yet attempted, highest
 * rule priority; among equals prefer files that a test references (`preferTested(file)`),
 * then stable file/line order so the queue is explainable.
 */
export function nextConventionCandidate({ preferTested = () => false, exclude = new Set() } = {}) {
  const rows = listConventionFindings({ status: 'open', limit: 500 }).filter(f => !f.protected && !f.proposal_id && !exclude.has(f.key));
  if (!rows.length) return null;
  rows.sort((a, b) => (RULE_BY_ID[a.rule].priority - RULE_BY_ID[b.rule].priority) || (Number(preferTested(b.file)) - Number(preferTested(a.file))) || a.file.localeCompare(b.file) || a.line - b.line);
  const f = rows[0];
  return { key: f.key, rule: f.rule, title: f.title, targetFile: f.file, line: f.line, sketch: `${f.sketch}\n\nOffending line ${f.line}: ${f.snippet}`, rationale: `Codebase convention (CLAUDE.md → Code Conventions): ${RULE_BY_ID[f.rule].title.toLowerCase()}.` };
}

export function markFinding(key, { status, proposalId = null, clearProposal = false }) {
  if (clearProposal) db.prepare(`UPDATE smk_convention_findings SET status = ?, proposal_id = NULL WHERE key = ?`).run(status, key);
  else db.prepare(`UPDATE smk_convention_findings SET status = ?, proposal_id = COALESCE(?, proposal_id) WHERE key = ?`).run(status, proposalId, key);
}

export function getConventionStatus() {
  const last = db.prepare(`SELECT * FROM smk_convention_scans ORDER BY created_at DESC LIMIT 1`).get() || null;
  const statuses = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS c FROM smk_convention_findings WHERE resolved_at IS NULL GROUP BY status`).all().map(r => [r.status, r.c]));
  const fixed = db.prepare(`SELECT COUNT(*) AS c FROM smk_convention_findings WHERE resolved_at IS NOT NULL`).get()?.c || 0;
  const protectedOpen = db.prepare(`SELECT COUNT(*) AS c FROM smk_convention_findings WHERE resolved_at IS NULL AND protected = 1`).get()?.c || 0;
  return { lastScan: last, open: countsByRule(), statuses, fixedTotal: fixed, protectedOpen, rules: RULES.map(r => ({ id: r.id, priority: r.priority, title: r.title })) };
}
