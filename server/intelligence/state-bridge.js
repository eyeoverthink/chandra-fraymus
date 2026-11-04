import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

/**
 * State Bridge — Persistence Unifier
 *
 * Bridges dynamic runtime state with semantic memory by periodically
 * snapshotting the system's operational state and fossilizing it into
 * the agent_memories table.
 *
 * Biological analogue: Epigenetic state → long-term memory consolidation.
 *
 * Three snapshot types:
 * 1. Autonomy fossils — generation, fitness, phase sync, connectivity
 * 2. Intelligence fossils — mood, dream state, cognition pipeline, OPEG stats
 * 3. Fleet fossils — agent activity, bus topology, workflow patterns
 */

const MAX_FOSSILS_PER_SNAPSHOT = 8;
const FOSSIL_RETENTION_DAYS = 30;

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS state_fossils (
      id TEXT PRIMARY KEY,
      snapshot_type TEXT NOT NULL,
      state_hash TEXT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_fossils_type ON state_fossils(snapshot_type)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_fossils_ts ON state_fossils(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function hashState(obj) {
  const str = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function collectAutonomyState() {
  const state = {};
  try {
    const latest = db.prepare(`SELECT * FROM neurogenesis_events ORDER BY created_at DESC LIMIT 1`).get();
    state.lastNeurogenesis = latest ? { type: latest.trigger_type, score: latest.connectivity_score, ts: latest.created_at } : null;
  } catch (_) {}

  try {
    const opeg = db.prepare(`SELECT state, COUNT(*) as c FROM opeg_proposals GROUP BY state`).all();
    const approved = db.prepare(`SELECT COUNT(*) as c FROM opeg_proposals WHERE sanitize_verdict LIKE '%APPROVED%'`).get()?.c || 0;
    const rejected = db.prepare(`SELECT COUNT(*) as c FROM opeg_proposals WHERE sanitize_verdict LIKE '%REJECTED%'`).get()?.c || 0;
    state.opeg = { byState: Object.fromEntries(opeg.map(r => [r.state, r.c])), approved, rejected };
  } catch (_) { state.opeg = { byState: {}, approved: 0, rejected: 0 }; }

  try {
    const reflections = db.prepare(`SELECT COUNT(*) as c FROM reflections`).get()?.c || 0;
    const lastReflection = db.prepare(`SELECT trigger, actions_taken, insights, duration_ms FROM reflections ORDER BY created_at DESC LIMIT 1`).get();
    state.reflections = { total: reflections, last: lastReflection };
  } catch (_) { state.reflections = { total: 0, last: null }; }

  return state;
}

function collectIntelligenceState() {
  const state = {};
  try {
    const memories = db.prepare(`SELECT COUNT(*) as c FROM agent_memories`).get()?.c || 0;
    const verified = db.prepare(`SELECT COUNT(*) as c FROM agent_memories WHERE verified_at IS NOT NULL`).get()?.c || 0;
    const categories = db.prepare(`SELECT category, COUNT(*) as c FROM agent_memories GROUP BY category ORDER BY c DESC LIMIT 10`).all();
    state.memory = { total: memories, verified, categories: Object.fromEntries(categories.map(r => [r.category, r.c])) };
  } catch (_) { state.memory = { total: 0, verified: 0, categories: {} }; }

  try {
    const verLoops = db.prepare(`SELECT COUNT(*) as c FROM verification_loops`).get()?.c || 0;
    const approved = db.prepare(`SELECT COUNT(*) as c FROM verification_loops WHERE LOWER(status) = 'approved'`).get()?.c || 0;
    state.verification = { total: verLoops, approved };
  } catch (_) { state.verification = { total: 0, approved: 0 }; }

  try {
    const daemonCycles = db.prepare(`SELECT COUNT(*) as c FROM daemon_cycles`).get()?.c || 0;
    state.daemon = { cycles: daemonCycles };
  } catch (_) { state.daemon = { cycles: 0 }; }

  try {
    const debates = db.prepare(`SELECT COUNT(*) as c FROM debates`).get()?.c || 0;
    const avgConf = db.prepare(`SELECT AVG(confidence) as avg FROM debates`).get()?.avg || 0;
    state.debates = { total: debates, avgConfidence: Math.round(avgConf * 100) };
  } catch (_) { state.debates = { total: 0, avgConfidence: 0 }; }

  return state;
}

function collectFleetState() {
  const state = {};
  try {
    const agents = db.prepare(`SELECT COUNT(*) as c FROM agents`).get()?.c || 0;
    const forged = db.prepare(`SELECT COUNT(*) as c FROM forged_agents`).get()?.c || 0;
    const runs = db.prepare(`SELECT COUNT(*) as c FROM runs`).get()?.c || 0;
    const recentRuns = db.prepare(`SELECT COUNT(*) as c FROM runs WHERE created_at > ?`).get(now() - 3600_000)?.c || 0;
    state.agents = { total: agents, forged, totalRuns: runs, recentRuns };
  } catch (_) { state.agents = { total: 0, forged: 0, totalRuns: 0, recentRuns: 0 }; }

  try {
    const busTotal = db.prepare(`SELECT COUNT(*) as c FROM bus_messages`).get()?.c || 0;
    const topics = db.prepare(`SELECT topic, COUNT(*) as c FROM bus_messages GROUP BY topic ORDER BY c DESC LIMIT 10`).all();
    state.bus = { total: busTotal, topTopics: Object.fromEntries(topics.map(r => [r.topic, r.c])) };
  } catch (_) { state.bus = { total: 0, topTopics: {} }; }

  try {
    const workflows = db.prepare(`SELECT COUNT(*) as c FROM workflows`).get()?.c || 0;
    const synthesized = db.prepare(`SELECT COUNT(*) as c FROM synthesized_workflows`).get()?.c || 0;
    state.workflows = { total: workflows, synthesized };
  } catch (_) { state.workflows = { total: 0, synthesized: 0 }; }

  return state;
}

export async function snapshotState() {
  const autonomy = collectAutonomyState();
  const intelligence = collectIntelligenceState();
  const fleet = collectFleetState();

  const snapshot = { autonomy, intelligence, fleet, ts: now() };
  const hash = hashState(snapshot);

  const lastFossil = db.prepare(`SELECT state_hash FROM state_fossils ORDER BY created_at DESC LIMIT 1`).get();
  if (lastFossil?.state_hash === hash) {
    return { stored: false, reason: 'State unchanged since last snapshot', hash };
  }

  const id = randomUUID().slice(0, 12);
  const data = JSON.stringify(snapshot);

  db.prepare(`INSERT INTO state_fossils (id, snapshot_type, state_hash, data, created_at) VALUES (?, 'full', ?, ?, ?)`).run(
    id, hash, data, now()
  );

  const fossilMemories = [];

  fossilMemories.push({
    key: `fossil:autonomy:${id}`,
    category: 'state_fossil',
    value: `Autonomy snapshot: OPEG approved=${autonomy.opeg.approved} rejected=${autonomy.opeg.rejected}. Reflections=${autonomy.reflections.total}. Neurogenesis=${autonomy.lastNeurogenesis ? `score=${autonomy.lastNeurogenesis.score}` : 'none'}.`,
  });

  fossilMemories.push({
    key: `fossil:intelligence:${id}`,
    category: 'state_fossil',
    value: `Intelligence snapshot: ${intelligence.memory.total} memories (${intelligence.memory.verified} verified). ${intelligence.verification.total} verifier loops (${intelligence.verification.approved} approved). ${intelligence.daemon.cycles} daemon cycles. ${intelligence.debates.total} debates (avg confidence ${intelligence.debates.avgConfidence}%).`,
  });

  fossilMemories.push({
    key: `fossil:fleet:${id}`,
    category: 'state_fossil',
    value: `Fleet snapshot: ${fleet.agents.total} agents (${fleet.agents.forged} forged), ${fleet.agents.recentRuns} recent runs. Bus: ${fleet.bus.total} messages. Workflows: ${fleet.workflows.total} (${fleet.workflows.synthesized} synthesized).`,
  });

  for (const mem of fossilMemories.slice(0, MAX_FOSSILS_PER_SNAPSHOT)) {
    try {
      db.prepare(
        `INSERT OR REPLACE INTO agent_memories (agent_id, category, key, value, confidence, source, access_count, created_at, updated_at)
         VALUES ('system', ?, ?, ?, 0.85, 'state-bridge', 0, ?, ?)`
      ).run(mem.category, mem.key, mem.value, now(), now());
    } catch (_) {}
  }

  publish('system', 'state.fossil', JSON.stringify({ id, hash, fossilCount: fossilMemories.length }));

  return { stored: true, id, hash, fossilCount: fossilMemories.length, snapshot };
}

export function pruneFossils() {
  const cutoff = now() - (FOSSIL_RETENTION_DAYS * 86400_000);
  const pruned = db.prepare(`DELETE FROM state_fossils WHERE created_at < ?`).run(cutoff);
  const memPruned = db.prepare(`DELETE FROM agent_memories WHERE agent_id = 'system' AND category = 'state_fossil' AND created_at < ?`).run(cutoff);
  return { fossilsPruned: pruned.changes, memoriesPruned: memPruned.changes, retentionDays: FOSSIL_RETENTION_DAYS };
}

export function fossilStats() {
  const total = db.prepare(`SELECT COUNT(*) as c FROM state_fossils`).get()?.c || 0;
  const recent = db.prepare(`SELECT id, snapshot_type, state_hash, created_at FROM state_fossils ORDER BY created_at DESC LIMIT 10`).all();
  const memCount = db.prepare(`SELECT COUNT(*) as c FROM agent_memories WHERE agent_id = 'system' AND category = 'state_fossil'`).get()?.c || 0;
  return { total, memoryCount: memCount, recent };
}

export function getFossil(id) {
  const row = db.prepare(`SELECT * FROM state_fossils WHERE id = ?`).get(id);
  if (!row) return null;
  try { row.data = JSON.parse(row.data); } catch {}
  return row;
}

export function fossilTimeline({ limit = 50, since } = {}) {
  let sql = `SELECT id, snapshot_type, state_hash, created_at FROM state_fossils`;
  const args = [];
  if (since) { sql += ` WHERE created_at > ?`; args.push(since); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  args.push(Math.min(200, Math.max(1, limit)));
  return db.prepare(sql).all(...args);
}
