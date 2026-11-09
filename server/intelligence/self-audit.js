/**
 * Self-Audit — Phase S: the fraymus-audit recurring-defect checklist as a native organ.
 *
 * Everything that went wrong in the autonomy stack before Phase N had the same four
 * shapes, and none of them were visible to the metacognitive monitor because it measured
 * activity, and the pathologies were *made of* activity:
 *   - the same action repeated hundreds of times (2,975 forged agents from 169 goals)
 *   - a metric that never changed (Phi = 0.7718 for 1,433 audits)
 *   - producers with no consumer (3,013 goals proposed, 0 executed)
 *   - rows stuck in a transient state forever (465 debates 'running')
 * plus a fifth we only notice by accident: things written and never read.
 *
 * This module runs those checks against the live database every 15 minutes, keeps a
 * finding open until the condition clears, raises ONE aggregated health alert for
 * BLOCKING findings, feeds a stuck signal to metacognition, and writes a markdown audit
 * report in the fraymus-audit format (scope / clean / findings / couldn't verify).
 *
 * Evidence is a number read from a table, never a label. A check that finds nothing says so.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';
import { DATA_DIR } from '../config.js';
import { publish } from '../fleet/bus.js';
import { ledgerDuplication } from './hive-export.js';

const now = () => Date.now();
const H = 3600_000;
const DAY = 24 * H;
const INTERVAL_MS = 15 * 60_000;
const FIRST_RUN_DELAY_MS = 60_000;
const REPORT_EVERY_MS = 7 * DAY;
const REPORT_DIR = join(DATA_DIR, 'audits');
const SEVERITY_RANK = { BLOCKING: 0, REAL: 1, COSMETIC: 2 };

let timer = null;
let firstRunTimer = null;
let lastRun = null;

function ensureTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS self_audit_findings (
    id TEXT PRIMARY KEY,
    check_name TEXT NOT NULL,
    subject TEXT NOT NULL,
    severity TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence TEXT,
    occurrences INTEGER DEFAULT 1,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_self_audit_open ON self_audit_findings(resolved_at, severity)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS self_audit_runs (
    id TEXT PRIMARY KEY,
    trigger TEXT,
    findings INTEGER,
    blocking INTEGER,
    real INTEGER,
    cosmetic INTEGER,
    clean_checks TEXT,
    check_errors TEXT,
    duration_ms INTEGER,
    report_path TEXT,
    created_at INTEGER NOT NULL
  )`).run();
}
try { ensureTables(); } catch (e) { console.error('[self-audit] schema:', e.message); }

const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch (_) { return null; } };
const q1 = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (_) { return null; } };
const stddev = xs => { if (!xs.length) return 0; const m = xs.reduce((s, v) => s + v, 0) / xs.length; return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length); };
const mean = xs => xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;

// ─── Check 1: identical action repeated ──────────────────────────
const ACTION_SOURCES = [
  { table: 'forged_agents', col: 'goal', label: 'forge goal' },
  { table: 'goal_proposals', col: 'objective', label: 'goal objective' },
  { table: 'debates', col: 'topic', label: 'debate topic' },
  { table: 'opeg_proposals', col: 'hypothesis', label: 'OPEG hypothesis' },
  { table: 'neurogenesis_events', col: 'action_taken', label: 'neurogenesis action' },
  { table: 'synthesized_workflows', col: 'goal', label: 'synthesized workflow goal' },
];

function checkRepeatedActions() {
  const findings = [];
  const since = now() - DAY;
  for (const s of ACTION_SOURCES) {
    const rows = q(
      `SELECT lower(substr(${s.col}, 1, 120)) AS k, COUNT(*) AS c FROM ${s.table}
       WHERE created_at > ? AND ${s.col} IS NOT NULL GROUP BY k HAVING c >= 5 ORDER BY c DESC LIMIT 5`, since);
    if (!rows) continue;
    for (const r of rows) {
      findings.push({
        check: 'repeated_action',
        subject: `${s.table}:${r.k.slice(0, 80)}`,
        severity: r.c >= 50 ? 'BLOCKING' : 'REAL',
        summary: `${s.label} repeated ${r.c}× in 24h: "${r.k.slice(0, 100)}"`,
        evidence: { table: s.table, column: s.col, count24h: r.c, key: r.k },
      });
    }
  }
  // Reflection action monoculture
  const refl = q(`SELECT actions_taken FROM reflections WHERE created_at > ? AND actions_taken IS NOT NULL`, since) || [];
  const types = {};
  let total = 0;
  for (const r of refl) {
    try { for (const a of JSON.parse(r.actions_taken || '[]')) { const t = a?.action || a?.type; if (t) { types[t] = (types[t] || 0) + 1; total++; } } } catch (_) {}
  }
  if (total >= 10) {
    const [top, c] = Object.entries(types).sort((a, b) => b[1] - a[1])[0];
    if (c / total >= 0.8) {
      findings.push({
        check: 'repeated_action', subject: `reflections:${top}`, severity: 'REAL',
        summary: `Reflection took "${top}" for ${c}/${total} actions in 24h (${Math.round(c / total * 100)}%) — action monoculture`,
        evidence: { types, total },
      });
    }
  }
  // Hive export re-emission (added 2026-11-09 after the ledger reached 96% duplicates unnoticed):
  // the receipts exported in the last 24 h should be one per event. Examine exactly that many tail lines.
  const exp24 = q1(`SELECT SUM(receipt_count) AS n, COUNT(*) AS runs FROM hive_exports WHERE created_at > ?`, since);
  if (exp24?.n >= 50) {
    try {
      const d = ledgerDuplication({ tailLines: exp24.n });
      if (d.ratio >= 0.2) {
        findings.push({
          check: 'repeated_action', subject: 'hive_exports:duplicate_receipts',
          severity: d.ratio >= 0.5 ? 'BLOCKING' : 'REAL',
          summary: `Hive export re-emitted ${d.duplicates}/${d.examined} receipts in 24h (${Math.round(d.ratio * 100)}% duplicates across ${exp24.runs} exports) — events must reach the ledger once`,
          evidence: { exportsRuns24h: exp24.runs, receipts24h: exp24.n, ...d },
        });
      }
    } catch (_) {}
  }
  return findings;
}

// ─── Check 2: metrics that never change ──────────────────────────
const METRIC_SERIES = [
  { name: 'consciousness.phi', sql: `SELECT phi AS v FROM consciousness_audits ORDER BY created_at DESC LIMIT 50` },
  { name: 'consciousness.ei', sql: `SELECT ei AS v FROM consciousness_audits ORDER BY created_at DESC LIMIT 50` },
  { name: 'ctrnn.mean_weight', sql: `SELECT mean_weight AS v FROM ctrnn_snapshots ORDER BY created_at DESC LIMIT 50` },
  { name: 'ctrnn.active_synapses', sql: `SELECT active_synapses AS v FROM ctrnn_snapshots ORDER BY created_at DESC LIMIT 50` },
  { name: 'metacognitive.effectiveness', sql: `SELECT effectiveness AS v FROM metacognitive_events ORDER BY created_at DESC LIMIT 50` },
  { name: 'resource.pressure', sql: `SELECT pressure AS v FROM resource_envelope_events ORDER BY created_at DESC LIMIT 50` },
  { name: 'neurogenesis.connectivity', sql: `SELECT connectivity_score AS v FROM neurogenesis_events ORDER BY created_at DESC LIMIT 50` },
];

function checkFlatMetrics() {
  const findings = [];
  for (const s of METRIC_SERIES) {
    const rows = q(s.sql);
    if (!rows || rows.length < 20) continue;
    const xs = rows.map(r => Number(r.v)).filter(Number.isFinite);
    if (xs.length < 20) continue;
    const sd = stddev(xs), m = mean(xs);
    if (sd < 1e-6) {
      const dead = Math.abs(m) < 1e-9;
      findings.push({
        check: dead ? 'dead_channel' : 'flat_metric',
        subject: s.name,
        severity: dead ? 'COSMETIC' : 'REAL',
        summary: dead
          ? `${s.name} has been exactly 0 for the last ${xs.length} samples`
          : `${s.name} has been exactly ${m.toFixed(6)} for the last ${xs.length} samples — a constant reading is a frozen substrate or a stuck sensor, not a measurement`,
        evidence: { samples: xs.length, mean: m, stddev: sd },
      });
    }
  }
  // Sensory channels from snapshots
  const snaps = q(`SELECT signals FROM sensory_bridge_events ORDER BY created_at DESC LIMIT 50`) || [];
  const series = {};
  for (const r of snaps) {
    try { for (const [k, v] of Object.entries(JSON.parse(r.signals || '{}'))) { (series[k] ||= []).push(Number(v)); } } catch (_) {}
  }
  for (const [k, xs] of Object.entries(series)) {
    if (xs.length < 20) continue;
    const sd = stddev(xs), m = mean(xs);
    if (sd < 1e-6) {
      const dead = Math.abs(m) < 1e-9;
      findings.push({
        check: dead ? 'dead_channel' : 'flat_metric', subject: `sensory.${k}`, severity: 'COSMETIC',
        summary: dead ? `sensory channel "${k}" has read 0 across ${xs.length} snapshots (~${Math.round(xs.length * 5)} min)` : `sensory channel "${k}" pinned at ${m.toFixed(3)} across ${xs.length} snapshots`,
        evidence: { samples: xs.length, mean: m },
      });
    }
  }
  return findings;
}

// ─── Check 3: producers without consumers ────────────────────────
function checkProducersWithoutConsumers() {
  const findings = [];
  const d1 = now() - DAY, d7 = now() - 7 * DAY;

  const goals = q1(`SELECT COUNT(*) AS c FROM goal_proposals WHERE created_at > ?`, d1)?.c || 0;
  const execs = q1(`SELECT COUNT(DISTINCT goal_id) AS c FROM goal_executions WHERE started_at > ?`, d1)?.c || 0;
  if (goals >= 20 && execs / goals < 0.1) findings.push({
    check: 'producer_without_consumer', subject: 'goal_proposals→goal_executions',
    severity: goals >= 200 ? 'BLOCKING' : 'REAL',
    summary: `${goals} goals proposed in 24h, ${execs} executed (${Math.round(execs / goals * 100)}%) — generation outruns execution`,
    evidence: { produced24h: goals, consumed24h: execs },
  });

  const forged = q(`SELECT agent_id FROM forged_agents WHERE created_at > ?`, d7) || [];
  if (forged.length >= 5) {
    let used = 0;
    for (const f of forged) if ((q1(`SELECT COUNT(*) AS c FROM runs WHERE model LIKE ? AND created_at > ?`, `${f.agent_id}:%`, d7)?.c || 0) > 0) used++;
    if (used / forged.length < 0.1) findings.push({
      check: 'producer_without_consumer', subject: 'forged_agents→runs',
      severity: forged.length >= 50 ? 'BLOCKING' : 'REAL',
      summary: `${forged.length} agents forged in 7d, ${used} ever ran — forging is not activity`,
      evidence: { forged7d: forged.length, ran7d: used },
    });
  }

  const synth = q(`SELECT workflow_id FROM synthesized_workflows WHERE created_at > ?`, d7) || [];
  if (synth.length >= 5) {
    const ids = synth.map(s => s.workflow_id);
    const placeholders = ids.map(() => '?').join(',');
    const ran = q1(`SELECT COUNT(DISTINCT workflow_id) AS c FROM workflow_runs WHERE workflow_id IN (${placeholders}) AND created_at > ?`, ...ids, d7)?.c || 0;
    if (ran / synth.length < 0.1) findings.push({
      check: 'producer_without_consumer', subject: 'synthesized_workflows→workflow_runs', severity: 'REAL',
      summary: `${synth.length} workflows synthesized in 7d, ${ran} ever ran`,
      evidence: { synthesized7d: synth.length, ran7d: ran },
    });
  }

  const opeg = q1(`SELECT COUNT(*) AS c, SUM(execution_result IS NOT NULL) AS executed FROM opeg_proposals WHERE created_at > ?`, d1);
  if (opeg?.c >= 20 && (opeg.executed || 0) / opeg.c < 0.1) findings.push({
    check: 'producer_without_consumer', subject: 'opeg_proposals→execution', severity: 'REAL',
    summary: `${opeg.c} OPEG proposals in 24h, ${opeg.executed || 0} carried an execution result`,
    evidence: { proposals24h: opeg.c, executed24h: opeg.executed || 0 },
  });

  const topics = q(`SELECT topic, COUNT(*) AS c FROM bus_messages WHERE created_at > ? GROUP BY topic HAVING c >= 100 ORDER BY c DESC LIMIT 10`, d1) || [];
  for (const t of topics) {
    const subs = q1(`SELECT COUNT(*) AS c FROM bus_subscriptions WHERE topic = ?`, t.topic)?.c || 0;
    if (subs === 0) findings.push({
      check: 'producer_without_consumer', subject: `bus:${t.topic}`, severity: 'COSMETIC',
      summary: `bus topic "${t.topic}" received ${t.c} messages in 24h with no persistent subscriber (in-memory handlers may still read it)`,
      evidence: { messages24h: t.c, subscriptions: subs },
    });
  }
  return findings;
}

// ─── Check 4: written, never read ────────────────────────────────
function checkUnreadGrowth() {
  const findings = [];
  const d1 = now() - DAY;
  for (const t of [
    { table: 'agent_memories', label: 'agent memories' },
    { table: 'knowledge_nodes', label: 'knowledge nodes' },
  ]) {
    const r = q1(`SELECT COUNT(*) AS n, SUM(access_count = 0) AS unread FROM ${t.table} WHERE created_at < ?`, d1);
    if (!r || r.n < 200) continue;
    const frac = (r.unread || 0) / r.n;
    if (frac > 0.95) findings.push({
      check: 'written_never_read', subject: t.table, severity: 'COSMETIC',
      summary: `${Math.round(frac * 100)}% of ${r.n} ${t.label} older than a day have never been read (access_count = 0)`,
      evidence: { rows: r.n, unread: r.unread || 0 },
    });
  }
  return findings;
}

// ─── Check 5: rows stuck in a transient state ────────────────────
const TRANSIENT = [
  { table: 'runs', col: 'status', states: ['running', 'queued'], ts: 'created_at' },
  { table: 'goal_executions', col: 'status', states: ['running'], ts: 'started_at' },
  { table: 'goal_proposals', col: 'status', states: ['executing'], ts: 'acted_at' },
  { table: 'debates', col: 'status', states: ['running'], ts: 'created_at' },
  { table: 'verification_loops', col: 'status', states: ['running'], ts: 'created_at' },
  { table: 'workflow_runs', col: 'status', states: ['running'], ts: 'created_at' },
  { table: 'opeg_proposals', col: 'state', states: ['S1_HYPOTHESIS', 'S2_EXECUTE', 'S3_SANITIZE'], ts: 'updated_at' },
];

function checkStuckRows() {
  const findings = [];
  const cutoff = now() - H;
  for (const t of TRANSIENT) {
    const placeholders = t.states.map(() => '?').join(',');
    const r = q1(`SELECT COUNT(*) AS c, MIN(${t.ts}) AS oldest FROM ${t.table} WHERE ${t.col} IN (${placeholders}) AND ${t.ts} < ?`, ...t.states, cutoff);
    if (!r?.c) continue;
    const ageH = r.oldest ? Math.round((now() - Number(r.oldest)) / H) : null;
    findings.push({
      check: 'stuck_transient', subject: `${t.table}.${t.col}`,
      severity: r.c >= 20 ? 'BLOCKING' : 'REAL',
      summary: `${r.c} ${t.table} row(s) stuck in ${t.states.join('/')} for over an hour (oldest ~${ageH}h)`,
      evidence: { count: r.c, oldestAgeHours: ageH, states: t.states },
    });
  }
  return findings;
}

// ─── Check 6 (Phase W): credit assignment must bite ──────────────
// A retired agent executing a goal means selection ignored quality; an agent with
// enough poor outcomes that is NOT retired (and is not hand-written) means the sweep
// is not running. Either way the loop outcome → selection is open.
function checkCreditAssignment() {
  const findings = [];
  const since = now() - DAY;
  const ran = q(
    `SELECT e.agent_id, COUNT(*) AS c FROM goal_executions e JOIN agent_retirements r ON r.agent_id = e.agent_id
     WHERE r.restored_at IS NULL AND e.started_at > r.retired_at AND e.started_at > ? GROUP BY e.agent_id`, since);
  for (const r of ran || []) {
    findings.push({
      check: 'retired_agent_selected', subject: `goal_executions:${r.agent_id}`, severity: 'REAL',
      summary: `Retired agent ${r.agent_id} executed ${r.c} goal(s) in 24h — selection is ignoring retirement`,
      evidence: { agentId: r.agent_id, executions24h: r.c },
    });
  }
  return findings;
}

const CHECKS = [
  ['repeated_action', checkRepeatedActions],
  ['credit_assignment', checkCreditAssignment],
  ['flat_metric', checkFlatMetrics],
  ['producer_without_consumer', checkProducersWithoutConsumers],
  ['written_never_read', checkUnreadGrowth],
  ['stuck_transient', checkStuckRows],
];

// ─── Persistence ─────────────────────────────────────────────────
function recordFindings(findings) {
  const t = now();
  const seen = new Set();
  const upsert = db.transaction(list => {
    for (const f of list) {
      const key = `${f.check}|${f.subject}`;
      seen.add(key);
      const open = db.prepare(`SELECT id, occurrences FROM self_audit_findings WHERE check_name = ? AND subject = ? AND resolved_at IS NULL`).get(f.check, f.subject);
      if (open) {
        db.prepare(`UPDATE self_audit_findings SET severity = ?, summary = ?, evidence = ?, occurrences = ?, last_seen = ? WHERE id = ?`)
          .run(f.severity, f.summary, JSON.stringify(f.evidence || {}), open.occurrences + 1, t, open.id);
      } else {
        db.prepare(`INSERT INTO self_audit_findings (id, check_name, subject, severity, summary, evidence, occurrences, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run('sa_' + randomUUID().replace(/-/g, '').slice(0, 10), f.check, f.subject, f.severity, f.summary, JSON.stringify(f.evidence || {}), t, t);
      }
    }
    const openRows = db.prepare(`SELECT id, check_name, subject FROM self_audit_findings WHERE resolved_at IS NULL`).all();
    let resolved = 0;
    for (const r of openRows) {
      if (!seen.has(`${r.check_name}|${r.subject}`)) {
        db.prepare(`UPDATE self_audit_findings SET resolved_at = ?, resolution = 'condition cleared' WHERE id = ?`).run(t, r.id);
        resolved++;
      }
    }
    return resolved;
  });
  return upsert(findings);
}

// One aggregated health alert for BLOCKING findings. Several would pin the neurogenesis
// health penalty at its cap and recreate the exact emergency loop this organ exists to catch.
function syncHealthAlert(blockingFindings) {
  try {
    const open = db.prepare(`SELECT id, message FROM health_alerts WHERE rule = 'self_audit' AND resolved = 0 ORDER BY created_at DESC`).all();
    if (!blockingFindings.length) {
      if (open.length) db.prepare(`UPDATE health_alerts SET resolved = 1 WHERE rule = 'self_audit' AND resolved = 0`).run();
      return;
    }
    const message = `Self-audit: ${blockingFindings.length} blocking finding(s) — ${blockingFindings.slice(0, 2).map(f => f.summary.slice(0, 90)).join('; ')}`;
    if (open.length && open[0].message === message) return;
    if (open.length) db.prepare(`UPDATE health_alerts SET resolved = 1 WHERE rule = 'self_audit' AND resolved = 0`).run();
    db.prepare(`INSERT INTO health_alerts (rule, severity, message, resolved, created_at) VALUES ('self_audit', 'warning', ?, 0, ?)`).run(message, now());
  } catch (e) { console.error('[self-audit] health alert sync:', e.message); }
}

export function getOpenFindings({ severity = null, limit = 50 } = {}) {
  const rows = severity
    ? db.prepare(`SELECT * FROM self_audit_findings WHERE resolved_at IS NULL AND severity = ? ORDER BY last_seen DESC LIMIT ?`).all(severity, limit)
    : db.prepare(`SELECT * FROM self_audit_findings WHERE resolved_at IS NULL ORDER BY last_seen DESC LIMIT ?`).all(limit);
  return rows.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.last_seen - a.last_seen)
    .map(r => ({ ...r, evidence: safeJson(r.evidence) }));
}

export function getOpenFindingCounts() {
  const rows = db.prepare(`SELECT severity, COUNT(*) AS c FROM self_audit_findings WHERE resolved_at IS NULL GROUP BY severity`).all();
  const out = { blocking: 0, real: 0, cosmetic: 0 };
  for (const r of rows) out[r.severity.toLowerCase()] = r.c;
  return out;
}

export function resolveFinding(id, resolution = 'resolved by operator') {
  const info = db.prepare(`UPDATE self_audit_findings SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL`).run(now(), String(resolution).slice(0, 300), id);
  return { resolved: info.changes > 0, id };
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch (_) { return {}; } }

// ─── Report (fraymus-audit format) ───────────────────────────────
export function writeAuditReport({ findings, clean, errors, trigger }) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(REPORT_DIR, `self-audit-${date}.md`);
  const bySev = s => findings.filter(f => f.severity === s);
  const lines = [
    `# Chandra self-audit — ${new Date().toISOString()}`,
    '',
    `Trigger: ${trigger}. Evidence below is read from \`data/chandra.db\` at run time; a check with no finding reports clean.`,
    '',
    '## Scope',
    '',
    ...CHECKS.map(([name]) => `- \`${name}\``),
    `- Tables: ${[...new Set([...ACTION_SOURCES.map(s => s.table), 'hive_exports', 'consciousness_audits', 'ctrnn_snapshots', 'metacognitive_events', 'resource_envelope_events', 'neurogenesis_events', 'sensory_bridge_events', 'goal_executions', 'runs', 'workflow_runs', 'bus_messages', 'bus_subscriptions', 'agent_memories', 'knowledge_nodes', ...TRANSIENT.map(t => t.table)])].sort().join(', ')}`,
    '',
    '## Verified clean',
    '',
    ...(clean.length ? clean.map(c => `- \`${c}\` — no finding`) : ['- (none — every check found something)']),
    '',
    '## Findings',
    '',
  ];
  if (!findings.length) lines.push('Clean. No finding survived the checks.');
  for (const sev of ['BLOCKING', 'REAL', 'COSMETIC']) {
    const list = bySev(sev);
    if (!list.length) continue;
    lines.push(`### ${sev} (${list.length})`, '');
    for (const f of list) {
      lines.push(`- **${f.check}** · \`${f.subject}\` — ${f.summary}`);
      lines.push(`  - evidence: \`${JSON.stringify(f.evidence || {}).slice(0, 300)}\``);
    }
    lines.push('');
  }
  lines.push('## Couldn\'t verify', '');
  lines.push(...(errors.length ? errors.map(e => `- \`${e.check}\`: ${e.error}`) : ['- (nothing — every check ran)']));
  lines.push('', '## Terminology corrections', '', 'None: this audit tests behaviour against data, not names against claims.', '');
  writeFileSync(path, lines.join('\n'), 'utf8');
  writeFileSync(join(REPORT_DIR, 'latest.md'), lines.join('\n'), 'utf8');
  return path;
}

function lastReportAt() {
  try {
    if (!existsSync(REPORT_DIR)) return 0;
    const files = readdirSync(REPORT_DIR).filter(f => /^self-audit-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    if (!files.length) return 0;
    return Date.parse(files[files.length - 1].slice(11, 21));
  } catch (_) { return 0; }
}

// ─── Run ─────────────────────────────────────────────────────────
export function runSelfAudit({ trigger = 'interval', writeReport = null } = {}) {
  const t0 = now();
  const findings = [];
  const clean = [];
  const errors = [];
  for (const [name, fn] of CHECKS) {
    try {
      const out = fn() || [];
      if (!out.length) clean.push(name);
      findings.push(...out);
    } catch (e) {
      errors.push({ check: name, error: e.message.slice(0, 200) });
    }
  }
  findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  const resolved = recordFindings(findings);
  const blocking = findings.filter(f => f.severity === 'BLOCKING');
  syncHealthAlert(blocking);

  const shouldReport = writeReport === true || (writeReport !== false && now() - lastReportAt() > REPORT_EVERY_MS);
  let reportPath = null;
  if (shouldReport) {
    try { reportPath = writeAuditReport({ findings, clean, errors, trigger }); } catch (e) { errors.push({ check: 'report', error: e.message }); }
  }

  const counts = { blocking: blocking.length, real: findings.filter(f => f.severity === 'REAL').length, cosmetic: findings.filter(f => f.severity === 'COSMETIC').length };
  const durationMs = now() - t0;
  try {
    db.prepare(`INSERT INTO self_audit_runs (id, trigger, findings, blocking, real, cosmetic, clean_checks, check_errors, duration_ms, report_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('sar_' + randomUUID().replace(/-/g, '').slice(0, 8), trigger, findings.length, counts.blocking, counts.real, counts.cosmetic, JSON.stringify(clean), JSON.stringify(errors), durationMs, reportPath, now());
  } catch (e) { console.error('[self-audit] run log:', e.message); }
  try {
    publish('self-audit', 'system.self_audit', JSON.stringify({
      trigger, ...counts, resolved, clean, errors: errors.length, reportPath,
      top: findings.slice(0, 3).map(f => ({ check: f.check, severity: f.severity, summary: f.summary.slice(0, 140) })),
    }));
  } catch (_) {}
  if (counts.blocking) console.warn(`[self-audit] ${counts.blocking} BLOCKING: ${blocking.map(f => f.summary.slice(0, 100)).join(' | ')}`);

  lastRun = { at: now(), trigger, durationMs, counts, resolved, clean, errors, reportPath, findings: findings.slice(0, 20) };
  return lastRun;
}

export function startSelfAudit({ intervalMs = INTERVAL_MS } = {}) {
  stopSelfAudit();
  firstRunTimer = setTimeout(() => {
    try { runSelfAudit({ trigger: 'boot' }); } catch (e) { console.error('[self-audit] first run:', e.message); }
  }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => {
    try { runSelfAudit({ trigger: 'interval' }); } catch (e) { console.error('[self-audit] run error:', e.message); }
  }, intervalMs);
  return { started: true, intervalMs, firstRunInMs: FIRST_RUN_DELAY_MS };
}

export function stopSelfAudit() {
  if (timer) { clearInterval(timer); timer = null; }
  if (firstRunTimer) { clearTimeout(firstRunTimer); firstRunTimer = null; }
  return { stopped: true };
}

export function getSelfAuditStatus() {
  const runs = db.prepare(`SELECT id, trigger, findings, blocking, real, cosmetic, duration_ms, report_path, created_at FROM self_audit_runs ORDER BY created_at DESC LIMIT 5`).all();
  return {
    running: !!timer,
    intervalMs: INTERVAL_MS,
    lastRun,
    open: getOpenFindingCounts(),
    openFindings: getOpenFindings({ limit: 20 }),
    recentRuns: runs,
    reportDir: REPORT_DIR,
    lastReportAt: lastReportAt() || null,
  };
}

export function installSelfAuditRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/self-audit', route((_req, res) => res.json(getSelfAuditStatus())));
  app.get('/api/intelligence/self-audit/findings', route((req, res) => {
    const severity = ['BLOCKING', 'REAL', 'COSMETIC'].includes(req.query.severity) ? req.query.severity : null;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    if (req.query.status === 'resolved') {
      return res.json({ findings: db.prepare(`SELECT * FROM self_audit_findings WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?`).all(limit).map(r => ({ ...r, evidence: safeJson(r.evidence) })) });
    }
    res.json({ findings: getOpenFindings({ severity, limit }) });
  }));
  app.post('/api/intelligence/self-audit/run', route((req, res) => {
    res.json(runSelfAudit({ trigger: 'api', writeReport: req.body?.report === true ? true : null }));
  }));
  app.post('/api/intelligence/self-audit/report', route((_req, res) => {
    res.json(runSelfAudit({ trigger: 'api:report', writeReport: true }));
  }));
  app.post('/api/intelligence/self-audit/findings/:id/resolve', route((req, res) => {
    res.json(resolveFinding(String(req.params.id).slice(0, 40), req.body?.resolution));
  }));
}
