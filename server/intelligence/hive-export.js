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
}

ensureTable();

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

function collectReflections(since) {
  try {
    const rows = db.prepare(
      `SELECT id, trigger, input_summary, actions_taken, insights, duration_ms, created_at
       FROM reflections WHERE created_at > ? ORDER BY created_at ASC`
    ).all(since);
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
        ts: new Date(r.created_at).toISOString(),
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
       FROM debates WHERE created_at > ? ORDER BY created_at ASC`
    ).all(since);
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
      ts: new Date(r.created_at).toISOString(),
    }));
  } catch (_) {
    return [];
  }
}

function collectGoalProposals(since) {
  try {
    const rows = db.prepare(
      `SELECT id, title, description, priority, status, source, created_at
       FROM goal_proposals WHERE created_at > ? ORDER BY created_at ASC`
    ).all(since);
    return rows.map(r => ({
      type: 'goal',
      claim: `Goal proposed: "${(r.title || 'unknown').slice(0, 80)}" [${r.priority || 'normal'}]`,
      evidence: {
        goalId: r.id,
        title: r.title,
        description: (r.description || '').slice(0, 200),
        priority: r.priority,
        status: r.status,
        source: r.source,
      },
      ts: new Date(r.created_at).toISOString(),
    }));
  } catch (_) {
    return [];
  }
}

function collectConsciousnessAudits(since) {
  try {
    const rows = db.prepare(
      `SELECT id, substrate, ei, ei_passed, phi, phi_passed, mirror_delta, mirror_passed,
              cf_divergence, cf_passed, verdict, proofs_passed, proofs_total, trigger, created_at
       FROM consciousness_audits WHERE created_at > ? ORDER BY created_at ASC`
    ).all(since);
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
      ts: new Date(r.created_at).toISOString(),
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
  const lookback = since || now() - (2 * 60 * 60 * 1000); // default 2 hours

  // Collect intelligence events
  const reflections = collectReflections(lookback);
  const debates = collectDebateVerdicts(lookback);
  const goals = collectGoalProposals(lookback);
  const consciousness = collectConsciousnessAudits(lookback);

  // Merge and sort chronologically
  const allEvents = [...reflections, ...debates, ...goals, ...consciousness]
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (allEvents.length === 0) {
    return {
      exported: 0,
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
      `INSERT INTO hive_exports (receipt_count, chain_length, chain_intact, last_receipt_self, export_path, duration_ms, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`
    ).run(receipts.length, chainLength, lastSelf, path, duration, t0);
  } catch (_) {}

  // Bus event
  try {
    publish('system', 'system.hive.export', JSON.stringify({
      exported: receipts.length,
      chainLength,
      lastSelf,
      types: {
        reflection: reflections.length,
        debate_verdict: debates.length,
        goal: goals.length,
        consciousness: consciousness.length,
      },
      durationMs: duration,
    }));
  } catch (_) {}

  return {
    exported: receipts.length,
    chainLength,
    lastSelf,
    path,
    types: {
      reflection: reflections.length,
      debate_verdict: debates.length,
      goal: goals.length,
      consciousness: consciousness.length,
    },
    durationMs: duration,
  };
}

export function writeExportLedger(exportPath) {
  return exportChandraReceipts({ exportPath });
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

  return {
    exportPath,
    chainLength: index,
    lastReceiptPrev: prev,
    isGenesis: prev === GENESIS_PREV,
    totalExports,
    totalReceipts,
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
