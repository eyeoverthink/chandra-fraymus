/**
 * Phase 7 — Cross-Machine Dream Bridge (Outbound Ledger)
 *
 * Exports Chandra intelligence as hive-compatible receipts in raw format,
 * producing an append-only JSONL ledger at data/chandra-to-hive.jsonl.
 *
 * Receipt format matches hive-receipts.py raw protocol:
 *   { organ, type, claim, evidence, seal, i, ts, prev, self }
 *
 * Chain hash algorithm:
 *   self = SHA-256(pythonCanonical(record_without_self))
 *   prev = prior receipt's self, or 64 zeroes for genesis
 *
 * Reuses Phase 1's Python-compatible canonicalization from hive-bridge.js
 * to guarantee byte-exact SHA-256 interop with the upstream Python chain.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import {
  _pythonCanonical as pythonCanonical,
  _computeReceiptSelf as computeReceiptSelf,
  verifyHiveChain,
} from './hive-bridge.js';

const now = () => Date.now();
const GENESIS_PREV = '0'.repeat(64);
const DEFAULT_EXPORT_PATH = resolve('data', 'chandra-to-hive.jsonl');

// ─── DB Setup ─────────────────────────────────────────────────

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS hive_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_count INTEGER NOT NULL,
      chain_length INTEGER NOT NULL,
      chain_intact INTEGER NOT NULL DEFAULT 1,
      last_receipt_self TEXT,
      export_path TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_hive_exports_ts ON hive_exports(created_at)`).run();
  } catch (_) {}
  // Watermark fix (2026-11-09): record what window each export covered and how many
  // already-exported events it refused to re-emit. Additive columns; ignore "duplicate column".
  for (const col of ['since_ts INTEGER', 'skipped_duplicates INTEGER NOT NULL DEFAULT 0']) {
    try { db.prepare(`ALTER TABLE hive_exports ADD COLUMN ${col}`).run(); } catch (_) {}
  }
}

ensureTable();

// ─── Watermark + dedup ────────────────────────────────────────
//
// Before 2026-11-09 every export re-read a fixed 2 h window, so with a 30 min daemon
// cycle each event reached the ledger ~4× (live ledger: 117,812 receipts, 4,324 unique).
// Two independent guards now:
//   1. since = start time of the previous export (hive_exports.created_at), capped at
//      MAX_LOOKBACK_MS so a long downtime does not dump a week in one receipt burst.
//   2. the tail of the ledger is scanned for (type, source id) keys and any event already
//      present is skipped — this covers the ms-wide gap between a run's t0 and its reads.

const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEDUP_TAIL_LINES = 5000;

function lastExportStart() {
  try { return db.prepare(`SELECT MAX(created_at) AS t FROM hive_exports`).get()?.t || null; } catch (_) { return null; }
}

function resolveSince(explicit) {
  if (explicit) return { since: explicit, source: 'explicit' };
  const last = lastExportStart();
  if (!last) return { since: now() - DEFAULT_LOOKBACK_MS, source: 'genesis_2h' };
  const floor = now() - MAX_LOOKBACK_MS;
  return last < floor ? { since: floor, source: 'capped_7d' } : { since: last, source: 'watermark' };
}

// Identity of an exported event: its type plus the source row id the collectors put in evidence.
export function receiptKey(typeOrReceipt, evidence) {
  const type = typeof typeOrReceipt === 'string' ? typeOrReceipt : typeOrReceipt?.type;
  const ev = evidence ?? typeOrReceipt?.evidence ?? {};
  const id = ev.reflectionId ?? ev.debateId ?? ev.goalId ?? ev.auditId ?? ev.executionId ?? ev.runId;
  return id == null ? null : `${type}:${id}`;
}

function readLedgerLines(path) {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8').trim();
  return content ? content.split('\n').filter(l => l.trim()) : [];
}

function recentLedgerKeys(path, tailLines = DEDUP_TAIL_LINES) {
  const keys = new Set();
  const lines = readLedgerLines(path);
  for (const line of lines.slice(-tailLines)) {
    try { const k = receiptKey(JSON.parse(line)); if (k) keys.add(k); } catch (_) {}
  }
  return keys;
}

/** How duplicated the ledger tail is — the self-audit reads this. */
export function ledgerDuplication({ tailLines = DEDUP_TAIL_LINES, exportPath } = {}) {
  const lines = readLedgerLines(exportPath || DEFAULT_EXPORT_PATH);
  const tail = lines.slice(-Math.max(1, tailLines));
  const seen = new Set();
  let duplicates = 0, keyed = 0;
  for (const line of tail) {
    try {
      const k = receiptKey(JSON.parse(line));
      if (!k) continue;
      keyed++;
      if (seen.has(k)) duplicates++; else seen.add(k);
    } catch (_) {}
  }
  return { ledgerLength: lines.length, examined: tail.length, unique: seen.size, duplicates, ratio: keyed ? duplicates / keyed : 0 };
}

// ─── Chain State ──────────────────────────────────────────────

function readLastReceiptSelf(exportPath) {
  if (!existsSync(exportPath)) return { prev: GENESIS_PREV, index: 0 };

  const content = readFileSync(exportPath, 'utf8').trim();
  if (!content) return { prev: GENESIS_PREV, index: 0 };

  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { prev: GENESIS_PREV, index: 0 };

  const lastLine = lines[lines.length - 1];
  try {
    const lastReceipt = JSON.parse(lastLine);
    return { prev: lastReceipt.self || GENESIS_PREV, index: (lastReceipt.i ?? -1) + 1 };
  } catch (_) {
    return { prev: GENESIS_PREV, index: 0 };
  }
}

// ─── Intelligence Collectors ──────────────────────────────────

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// Timestamp columns are not uniform: most tables store epoch ms (INTEGER), but
// consciousness_audits uses SQLite's datetime('now') TEXT ('YYYY-MM-DD HH:MM:SS', UTC).
// SQLite orders every INTEGER below every TEXT, so `text_col > 1794208331889` is true for
// every row — which is how the whole consciousness_audits table was exported on every run.
// sinceClause() compares in the column's own type; toIso() reads both shapes as UTC.
function sinceClause(col) {
  return `((typeof(${col}) = 'text' AND ${col} > datetime(? / 1000, 'unixepoch')) OR (typeof(${col}) != 'text' AND ${col} > ?))`;
}
function toIso(v) {
  if (v == null) return new Date(0).toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return new Date(s.replace(' ', 'T') + 'Z').toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function collectReflections(since) {
  try {
    const rows = db.prepare(
      `SELECT id, trigger, input_summary, actions_taken, insights, duration_ms, created_at
       FROM reflections WHERE ${sinceClause('created_at')} ORDER BY created_at ASC`
    ).all(since, since);
    return rows.map(r => {
      let actions = [];
      let insights = '';
      try { actions = JSON.parse(r.actions_taken || '[]'); } catch (_) {}
      try { insights = r.insights || ''; } catch (_) {}
      return {
        type: 'reflection',
        claim: `Reflection cycle (${r.trigger || 'unknown'} trigger): ${actions.length} actions taken`,
        evidence: {
          reflectionId: r.id,
          trigger: r.trigger,
          actionsCount: actions.length,
          actions: actions.slice(0, 5).map(a => typeof a === 'object' ? (a.type || a.action || 'unknown') : String(a)),
          insightPreview: typeof insights === 'string' ? insights.slice(0, 200) : JSON.stringify(insights).slice(0, 200),
          durationMs: r.duration_ms,
        },
        ts: toIso(r.created_at),
      };
    });
  } catch (_) {
    return [];
  }
}

function collectDebateVerdicts(since) {
  try {
    const rows = db.prepare(
      `SELECT id, topic, rounds, verdict, confidence, created_at
       FROM debates WHERE ${sinceClause('created_at')} ORDER BY created_at ASC`
    ).all(since, since);
    return rows.map(r => ({
      type: 'debate_verdict',
      claim: `Debate verdict on "${(r.topic || 'unknown').slice(0, 80)}": ${r.verdict || 'undecided'}`,
      evidence: {
        debateId: r.id,
        topic: r.topic,
        rounds: r.rounds,
        verdict: r.verdict,
        confidence: r.confidence,
      },
      ts: toIso(r.created_at),
    }));
  } catch (_) {
    return [];
  }
}

function collectGoalProposals(since) {
  try {
    // goal_proposals has objective/rationale, not title/description — the old query
    // threw on every export and goals never reached the ledger.
    const rows = db.prepare(
      `SELECT id, objective, rationale, priority, status, source, created_at
       FROM goal_proposals WHERE ${sinceClause('created_at')} ORDER BY created_at ASC`
    ).all(since, since);
    return rows.map(r => ({
      type: 'goal',
      claim: `Goal proposed: "${(r.objective || 'unknown').slice(0, 80)}" [${r.priority || 'normal'}]`,
      evidence: {
        goalId: r.id,
        objective: r.objective,
        rationale: (r.rationale || '').slice(0, 200),
        priority: r.priority,
        status: r.status,
        source: r.source,
      },
      ts: toIso(r.created_at),
    }));
  } catch (_) {
    return [];
  }
}

// Phase U: what the organism actually did and how well — the receipts the hive should care about most.
function collectGoalOutcomes(since) {
  try {
    const rows = db.prepare(
      `SELECT e.id, e.goal_id, e.agent_id, e.status, e.quality, e.duration_ms, e.finished_at, g.objective
       FROM goal_executions e LEFT JOIN goal_proposals g ON g.id = e.goal_id
       WHERE ${sinceClause('e.finished_at')} AND e.status IN ('completed','failed','blocked') ORDER BY e.finished_at ASC`
    ).all(since, since);
    return rows.map(r => ({
      type: 'goal_outcome',
      claim: `Goal ${r.status} by ${r.agent_id} (quality ${r.quality == null ? 'unscored' : r.quality.toFixed(2)}): "${(r.objective || r.goal_id).slice(0, 80)}"`,
      evidence: { executionId: r.id, goalId: r.goal_id, agentId: r.agent_id, status: r.status, quality: r.quality, durationMs: r.duration_ms },
      ts: toIso(r.finished_at),
    }));
  } catch (_) { return []; }
}

function collectSelfAudits(since) {
  try {
    const rows = db.prepare(
      `SELECT id, trigger, findings, blocking, real, cosmetic, clean_checks, created_at FROM self_audit_runs WHERE ${sinceClause('created_at')} ORDER BY created_at ASC`
    ).all(since, since);
    return rows.map(r => ({
      type: 'self_audit',
      claim: `Self-audit (${r.trigger}): ${r.findings} findings — ${r.blocking} blocking, ${r.real} real, ${r.cosmetic} cosmetic`,
      evidence: { runId: r.id, trigger: r.trigger, findings: r.findings, blocking: r.blocking, real: r.real, cosmetic: r.cosmetic, cleanChecks: safeParse(r.clean_checks, []) },
      ts: toIso(r.created_at),
    }));
  } catch (_) { return []; }
}

function safeParse(s, fallback) { try { return JSON.parse(s); } catch (_) { return fallback; } }

function collectConsciousnessAudits(since) {
  try {
    const rows = db.prepare(
      `SELECT id, substrate, ei, ei_passed, phi, phi_passed, mirror_delta, mirror_passed,
              cf_divergence, cf_passed, verdict, proofs_passed, proofs_total, trigger, created_at
       FROM consciousness_audits WHERE ${sinceClause('created_at')} ORDER BY created_at ASC`
    ).all(since, since);
    return rows.map(r => ({
      type: 'consciousness',
      claim: `Consciousness audit: ${r.verdict || 'unknown'} (${r.proofs_passed}/${r.proofs_total} proofs)`,
      evidence: {
        auditId: r.id,
        substrate: r.substrate,
        ei: r.ei,
        eiPassed: !!r.ei_passed,
        phi: r.phi,
        phiPassed: !!r.phi_passed,
        mirrorDelta: r.mirror_delta,
        mirrorPassed: !!r.mirror_passed,
        cfDivergence: r.cf_divergence,
        cfPassed: !!r.cf_passed,
        verdict: r.verdict,
        proofsPassed: r.proofs_passed,
        proofsTotal: r.proofs_total,
        trigger: r.trigger,
      },
      ts: toIso(r.created_at),
    }));
  } catch (_) {
    return [];
  }
}

// ─── Receipt Builder ──────────────────────────────────────────

function buildReceipt(item, index, prev) {
  const record = {
    organ: 'chandra',
    type: item.type,
    claim: item.claim,
    evidence: item.evidence,
    seal: sha256(pythonCanonical(item.evidence)),
    i: index,
    ts: item.ts,
    prev,
  };
  record.self = computeReceiptSelf(record);
  return record;
}

// ─── Export Engine ─────────────────────────────────────────────

export function exportChandraReceipts({ since, exportPath } = {}) {
  const t0 = now();
  const path = exportPath || DEFAULT_EXPORT_PATH;
  const { since: lookback, source: sinceSource } = resolveSince(since);

  // Collect intelligence events
  const reflections = collectReflections(lookback);
  const debates = collectDebateVerdicts(lookback);
  const goals = collectGoalProposals(lookback);
  const consciousness = collectConsciousnessAudits(lookback);
  const outcomes = collectGoalOutcomes(lookback);
  const audits = collectSelfAudits(lookback);

  // Merge, drop anything the ledger tail already holds, sort chronologically
  const already = recentLedgerKeys(path);
  let skippedDuplicates = 0;
  const allEvents = [...reflections, ...debates, ...goals, ...consciousness, ...outcomes, ...audits]
    .filter(ev => { const k = receiptKey(ev.type, ev.evidence); if (k && already.has(k)) { skippedDuplicates++; return false; } return true; })
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (allEvents.length === 0) {
    // Still advance the watermark, otherwise the same window is re-scanned forever.
    try {
      db.prepare(`INSERT INTO hive_exports (receipt_count, chain_length, chain_intact, last_receipt_self, export_path, duration_ms, created_at, since_ts, skipped_duplicates)
                  VALUES (0, ?, 1, NULL, ?, ?, ?, ?, ?)`).run(readLastReceiptSelf(path).index, path, now() - t0, t0, lookback, skippedDuplicates);
    } catch (_) {}
    return {
      exported: 0,
      skippedDuplicates,
      since: lookback,
      sinceSource,
      chainLength: readLastReceiptSelf(path).index,
      path,
      durationMs: now() - t0,
      skipped: 'no_new_events',
    };
  }

  // Read chain state
  const { prev: lastPrev, index: startIndex } = readLastReceiptSelf(path);

  // Build receipts
  const receipts = [];
  let currentPrev = lastPrev;
  for (let i = 0; i < allEvents.length; i++) {
    const receipt = buildReceipt(allEvents[i], startIndex + i, currentPrev);
    receipts.push(receipt);
    currentPrev = receipt.self;
  }

  // Append to ledger
  const lines = receipts.map(r => JSON.stringify(r)).join('\n') + '\n';
  appendFileSync(path, lines, 'utf8');

  const chainLength = startIndex + receipts.length;
  const lastSelf = receipts[receipts.length - 1].self;
  const duration = now() - t0;

  // Log export
  try {
    db.prepare(
      `INSERT INTO hive_exports (receipt_count, chain_length, chain_intact, last_receipt_self, export_path, duration_ms, created_at, since_ts, skipped_duplicates)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
    ).run(receipts.length, chainLength, lastSelf, path, duration, t0, lookback, skippedDuplicates);
  } catch (_) {}

  // Bus event
  try {
    publish('system', 'system.hive.export', JSON.stringify({
      exported: receipts.length,
      skippedDuplicates,
      sinceSource,
      chainLength,
      lastSelf,
      types: {
        reflection: reflections.length,
        debate_verdict: debates.length,
        goal: goals.length,
        consciousness: consciousness.length,
        goal_outcome: outcomes.length,
        self_audit: audits.length,
      },
      durationMs: duration,
    }));
  } catch (_) {}

  return {
    exported: receipts.length,
    skippedDuplicates,
    since: lookback,
    sinceSource,
    chainLength,
    lastSelf,
    path,
    types: {
      reflection: reflections.length,
      debate_verdict: debates.length,
      goal: goals.length,
      consciousness: consciousness.length,
      goal_outcome: outcomes.length,
      self_audit: audits.length,
    },
    durationMs: duration,
  };
}

export function writeExportLedger(exportPath) {
  return exportChandraReceipts({ exportPath });
}

/**
 * Rebuild the ledger with one receipt per event. The old chain is archived next to the
 * ledger (never deleted) and a fresh chain is sealed from genesis over the unique receipts
 * in their original order, with i / prev / self recomputed. This rewrites signed history,
 * so it is operator-triggered only (POST …/compact) and never runs from the daemon.
 */
export function compactExportLedger({ dryRun = false, exportPath } = {}) {
  const t0 = now();
  const path = exportPath || DEFAULT_EXPORT_PATH;
  const lines = readLedgerLines(path);
  const seen = new Set();
  const unique = [];
  let unkeyed = 0;
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    const k = receiptKey(r);
    if (!k) { unkeyed++; unique.push(r); continue; }
    if (seen.has(k)) continue;
    seen.add(k); unique.push(r);
  }
  const before = lines.length, after = unique.length;
  if (dryRun || before === after) {
    return { dryRun, before, after, removed: before - after, unkeyed, changed: false, durationMs: now() - t0 };
  }
  // Re-seal: keep organ/type/claim/evidence/seal/ts, recompute i/prev/self
  let prev = GENESIS_PREV;
  const resealed = unique.map((r, i) => {
    const record = { organ: r.organ, type: r.type, claim: r.claim, evidence: r.evidence, seal: r.seal ?? sha256(pythonCanonical(r.evidence)), i, ts: r.ts, prev };
    record.self = computeReceiptSelf(record);
    prev = record.self;
    return record;
  });
  const archive = path.replace(/\.jsonl$/, '') + `.pre-compact-${new Date(t0).toISOString().replace(/[:.]/g, '-')}.jsonl`;
  writeFileSync(archive, lines.join('\n') + '\n', 'utf8');
  writeFileSync(path, resealed.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const verification = verifyHiveChain(path);
  try {
    db.prepare(`INSERT INTO hive_exports (receipt_count, chain_length, chain_intact, last_receipt_self, export_path, duration_ms, created_at, since_ts, skipped_duplicates)
                VALUES (0, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(after, verification?.intact ? 1 : 0, resealed[resealed.length - 1]?.self || null, path, now() - t0, t0, before - after);
  } catch (_) {}
  try { publish('system', 'system.hive.export.compacted', JSON.stringify({ before, after, removed: before - after, archive })); } catch (_) {}
  return { dryRun: false, before, after, removed: before - after, unkeyed, changed: true, archive, chainVerification: verification, durationMs: now() - t0 };
}

// ─── Stats & Queries ──────────────────────────────────────────

export function getExportStats() {
  const exportPath = DEFAULT_EXPORT_PATH;
  const { prev, index } = readLastReceiptSelf(exportPath);

  const lastExport = db.prepare(
    `SELECT * FROM hive_exports ORDER BY created_at DESC LIMIT 1`
  ).get();

  const totalExports = db.prepare(
    `SELECT COUNT(*) as c FROM hive_exports`
  ).get()?.c || 0;

  const totalReceipts = db.prepare(
    `SELECT SUM(receipt_count) as s FROM hive_exports`
  ).get()?.s || 0;

  const watermark = lastExportStart();
  return {
    exportPath,
    chainLength: index,
    lastReceiptPrev: prev,
    isGenesis: prev === GENESIS_PREV,
    totalExports,
    totalReceipts,
    watermark,
    nextSince: resolveSince(),
    duplication: ledgerDuplication(),
    lastExport: lastExport ? {
      receiptCount: lastExport.receipt_count,
      chainLength: lastExport.chain_length,
      chainIntact: !!lastExport.chain_intact,
      durationMs: lastExport.duration_ms,
      at: lastExport.created_at,
    } : null,
  };
}

export function getRecentReceipts({ limit = 20 } = {}) {
  const exportPath = DEFAULT_EXPORT_PATH;
  if (!existsSync(exportPath)) return { receipts: [], total: 0 };

  const content = readFileSync(exportPath, 'utf8').trim();
  if (!content) return { receipts: [], total: 0 };

  const lines = content.split('\n').filter(l => l.trim());
  const total = lines.length;
  const clamped = Math.min(200, Math.max(1, limit));
  const tail = lines.slice(-clamped);

  const receipts = [];
  for (const line of tail) {
    try { receipts.push(JSON.parse(line)); }
    catch (_) {}
  }

  return { receipts, total };
}

export function verifyExportChain() {
  const exportPath = DEFAULT_EXPORT_PATH;
  if (!existsSync(exportPath)) {
    return { intact: true, reason: 'no_ledger_file', chainLength: 0 };
  }
  return verifyHiveChain(exportPath);
}

export { DEFAULT_EXPORT_PATH, GENESIS_PREV };
