import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db.js';

const now = () => Date.now();

// ── Replay/RSI Engine ──────────────────────────────────────────
// Records agent loop runs as "worlds". Replays them deterministically
// under different policies (read_budget, max_steps). Scores each
// policy and writes the winner. This is the RSI seam — the agent
// improves its own loop parameters through measured replay, not
// model calls. Ported from FRAYNIX tools/replay.py.

const WORLDS_DIR = join(process.cwd(), 'data', 'replay-worlds');

export function migrateReplay() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_worlds (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task TEXT NOT NULL,
      model TEXT,
      steps INTEGER NOT NULL,
      quality REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      chain TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replay_sweeps (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL,
      policy TEXT NOT NULL,
      score REAL NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loop_policy (
      key TEXT PRIMARY KEY,
      value REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_rw_agent ON replay_worlds(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rs_world ON replay_sweeps(world_id);
  `);

  // Seed default policy values (from FRAYNIX policy/loop_policy.py)
  const defaults = [
    ['read_budget', 3],
    ['reminder_step', 4],
    ['max_steps', 8],
    ['budget_warn_60', 0.60],
    ['budget_warn_75', 0.75],
    ['budget_warn_85', 0.85],
    ['report_reserve', 0.85],
    ['compaction_threshold', 9500],
    ['keep_recent_pairs', 2],
    ['bounce_max_lines', 48],
    ['bounce_max_chars', 4000],
    ['skill_cap', 2],
  ];

  const insert = db.prepare(
    'INSERT OR IGNORE INTO loop_policy (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)'
  );
  for (const [key, value] of defaults) {
    insert.run(key, value, now(), 'seed');
  }
}

// ── Record ─────────────────────────────────────────────────────
// Record an agent loop run as a replayable world.

export function record(agentId, task, model, chain, quality = 0, cost = 0) {
  const id = randomUUID().slice(0, 12);
  const chainStr = typeof chain === 'string' ? chain : JSON.stringify(chain);

  db.prepare(
    'INSERT INTO replay_worlds (id, agent_id, task, model, steps, quality, cost, chain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, agentId, task, model || 'unknown', Array.isArray(chain) ? chain.length : 0, quality, cost, chainStr, now());

  // Also save to filesystem for portability
  if (!existsSync(WORLDS_DIR)) mkdirSync(WORLDS_DIR, { recursive: true });
  writeFileSync(
    join(WORLDS_DIR, `${id}.json`),
    JSON.stringify({ id, agentId, task, model, quality, cost, chain: typeof chain === 'string' ? JSON.parse(chain) : chain }, null, 2)
  );

  return { id, agentId, steps: Array.isArray(chain) ? chain.length : 0 };
}

// ── Replay ─────────────────────────────────────────────────────
// Walk a recorded chain under a read_budget policy. Score it.
// Zero LLM calls — purely deterministic.

export function replay(worldId, readBudget) {
  const world = db.prepare('SELECT * FROM replay_worlds WHERE id = ?').get(worldId);
  if (!world) return { error: 'world_not_found' };

  let chain;
  try { chain = JSON.parse(world.chain); } catch { return { error: 'chain_parse_error' }; }
  if (!Array.isArray(chain)) return { error: 'chain_not_array' };

  // Simulate the loop under the given read_budget
  let readsUsed = 0;
  let stepsUsed = 0;
  let qualityAccum = 0;
  const replayLog = [];

  for (const node of chain) {
    stepsUsed++;

    // Check if this step is a "read" operation
    const isRead = node.type === 'read' || node.tool === 'read_file' || node.tool === 'read_dream' ||
      node.tool === 'read_ledger' || node.kind === 'read' ||
      (typeof node.action === 'string' && node.action.startsWith('read'));

    if (isRead) {
      if (readsUsed >= readBudget) {
        replayLog.push({ step: stepsUsed, action: 'read_blocked', reason: 'budget_exceeded' });
        continue;
      }
      readsUsed++;
    }

    // Accumulate quality from nodes that produced output
    if (node.quality != null) qualityAccum += node.quality;
    else if (node.status === 'success' || node.status === 'done') qualityAccum += 1;
    else if (node.status === 'error') qualityAccum -= 0.5;

    replayLog.push({ step: stepsUsed, tool: node.tool || node.type || 'unknown', quality: qualityAccum });
  }

  // Score: V = quality - 0.05 * (cost / steps)
  const effectiveCost = world.cost || stepsUsed * 0.1;
  const score = qualityAccum - 0.05 * (effectiveCost / Math.max(stepsUsed, 1));

  return {
    worldId,
    readBudget,
    stepsUsed,
    readsUsed,
    quality: Math.round(qualityAccum * 1000) / 1000,
    score: Math.round(score * 1000) / 1000,
    replayLog,
  };
}

// ── Sweep ──────────────────────────────────────────────────────
// Score every read_budget from 1 to maxBudget for a world.
// Returns ranked results. The winner is the optimal policy.

export function sweep(worldId, maxBudget = 12) {
  const results = [];

  for (let budget = 1; budget <= maxBudget; budget++) {
    const r = replay(worldId, budget);
    if (r.error) return { error: r.error };
    results.push({
      readBudget: budget,
      score: r.score,
      quality: r.quality,
      stepsUsed: r.stepsUsed,
      readsUsed: r.readsUsed,
    });
  }

  results.sort((a, b) => b.score - a.score);

  // Record sweep results
  const sweepId = randomUUID().slice(0, 12);
  db.prepare(
    'INSERT INTO replay_sweeps (id, world_id, policy, score, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sweepId, worldId, `read_budget=${results[0].readBudget}`, results[0].score, JSON.stringify(results), now());

  return {
    sweepId,
    worldId,
    winner: results[0],
    ranked: results,
  };
}

// ── Apply Winner ───────────────────────────────────────────────
// Write the winning policy parameter to the DB. This is the RSI seam.

export function applyWinner(key, value, reason = 'sweep') {
  db.prepare(
    'INSERT INTO loop_policy (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by'
  ).run(key, value, now(), reason);

  return { applied: true, key, value, reason };
}

// ── Policy Reader ──────────────────────────────────────────────
// Read current policy parameters.

export function getPolicy() {
  const rows = db.prepare('SELECT key, value, updated_at, updated_by FROM loop_policy ORDER BY key').all();
  const policy = {};
  for (const r of rows) policy[r.key] = { value: r.value, updatedAt: r.updated_at, updatedBy: r.updated_by };
  return policy;
}

export function getPolicyValue(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM loop_policy WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

// ── World Listing ──────────────────────────────────────────────

export function listWorlds(agentId = null, limit = 50) {
  if (agentId) {
    return db.prepare('SELECT id, agent_id, task, model, steps, quality, cost, created_at FROM replay_worlds WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, limit);
  }
  return db.prepare('SELECT id, agent_id, task, model, steps, quality, cost, created_at FROM replay_worlds ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

export function getWorld(worldId) {
  return db.prepare('SELECT * FROM replay_worlds WHERE id = ?').get(worldId);
}

export function listSweeps(worldId = null, limit = 50) {
  if (worldId) {
    return db.prepare('SELECT * FROM replay_sweeps WHERE world_id = ? ORDER BY created_at DESC LIMIT ?').all(worldId, limit);
  }
  return db.prepare('SELECT * FROM replay_sweeps ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ── Selftest ───────────────────────────────────────────────────
// Proves: (1) record creates world, (2) replay is deterministic,
// (3) sweep ranks budgets, (4) policy read/write works.
// No LLM, no network. Pure computation.

export function selftest() {
  const results = [];
  const testAgent = `__replay_test_${now()}`;

  // Build a synthetic chain with 6 steps (3 reads, 3 actions)
  const chain = [
    { type: 'read', tool: 'read_file', status: 'success', quality: 1.0 },
    { type: 'action', tool: 'write_plan', status: 'success', quality: 2.0 },
    { type: 'read', tool: 'read_dream', status: 'success', quality: 0.5 },
    { type: 'action', tool: 'execute', status: 'success', quality: 3.0 },
    { type: 'read', tool: 'read_ledger', status: 'success', quality: 0.5 },
    { type: 'action', tool: 'write_plan', status: 'done', quality: 1.0 },
  ];

  // Test 1: record creates world
  const w = record(testAgent, 'selftest task', 'test-model', chain, 8.0, 0.6);
  results.push({ test: 'record_creates_world', pass: !!w.id && w.steps === 6 });

  // Test 2: replay is deterministic (same input → same output)
  const r1 = replay(w.id, 3);
  const r2 = replay(w.id, 3);
  results.push({
    test: 'replay_deterministic',
    pass: r1.score === r2.score && r1.stepsUsed === r2.stepsUsed && r1.readsUsed === r2.readsUsed,
  });

  // Test 3: lower budget blocks reads
  const r3 = replay(w.id, 1);
  results.push({
    test: 'budget_blocks_reads',
    pass: r3.readsUsed === 1 && r3.readsUsed < r1.readsUsed,
  });

  // Test 4: sweep ranks budgets
  const s = sweep(w.id, 6);
  results.push({
    test: 'sweep_ranks',
    pass: s.ranked.length === 6 && s.winner.score >= s.ranked[s.ranked.length - 1].score,
  });

  // Test 5: policy read/write
  applyWinner('__test_param', 42, 'selftest');
  const pv = getPolicyValue('__test_param');
  results.push({ test: 'policy_write_read', pass: pv === 42 });

  // Cleanup
  db.prepare('DELETE FROM replay_worlds WHERE agent_id = ?').run(testAgent);
  db.prepare('DELETE FROM loop_policy WHERE key = ?').run('__test_param');

  const allPass = results.every(r => r.pass);
  return { ok: allPass, tests: results };
}
