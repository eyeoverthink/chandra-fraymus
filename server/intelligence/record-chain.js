import { createHash } from 'node:crypto';
import { db } from '../db.js';

const now = () => Date.now();

// ── Schema ─────────────────────────────────────────────────────
// Hash-chained append-only record per agent. Each entry's self_hash =
// SHA-256(prev_hash + JSON(payload)). Tampering at index N breaks the
// chain from N onward. Ported from FRAYNIX tools/record.py.

export function migrateRecordChain() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS record_chain (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      self_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rc_agent ON record_chain(agent_id, id);
  `);
}

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// Append a new entry to an agent's chain. Returns the entry with its hash.
export function append(agentId, kind, payload) {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  const last = db.prepare(
    'SELECT self_hash FROM record_chain WHERE agent_id = ? ORDER BY id DESC LIMIT 1'
  ).get(agentId);

  const prevHash = last ? last.self_hash : '0'.repeat(64);
  const selfHash = sha256(prevHash + payloadStr);
  const ts = now();

  const info = db.prepare(
    'INSERT INTO record_chain (agent_id, kind, payload, prev_hash, self_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(agentId, kind, payloadStr, prevHash, selfHash, ts);

  return { id: info.lastInsertRowid, agentId, kind, prevHash, selfHash, createdAt: ts };
}

// Verify the entire chain for an agent. Returns { ok, entries, brokenAt }.
// brokenAt is the id of the first entry where recomputed hash != stored hash.
export function verify(agentId) {
  const rows = db.prepare(
    'SELECT id, payload, prev_hash, self_hash FROM record_chain WHERE agent_id = ? ORDER BY id ASC'
  ).all(agentId);

  if (rows.length === 0) return { ok: true, entries: 0, brokenAt: null };

  let expectedPrev = '0'.repeat(64);

  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, entries: rows.length, brokenAt: row.id, reason: 'prev_hash_mismatch' };
    }

    const recomputed = sha256(row.prev_hash + row.payload);
    if (recomputed !== row.self_hash) {
      return { ok: false, entries: rows.length, brokenAt: row.id, reason: 'self_hash_mismatch' };
    }

    expectedPrev = row.self_hash;
  }

  return { ok: true, entries: rows.length, brokenAt: null };
}

// Read the last N entries for an agent.
export function tail(agentId, limit = 20) {
  return db.prepare(
    'SELECT id, kind, payload, prev_hash, self_hash, created_at FROM record_chain WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
  ).all(agentId, limit).reverse();
}

// Count entries per agent.
export function stats() {
  return db.prepare(
    'SELECT agent_id, COUNT(*) as entries, MAX(created_at) as last_at FROM record_chain GROUP BY agent_id ORDER BY entries DESC'
  ).all();
}

// ── Selftest ───────────────────────────────────────────────────
// Proves: (1) chain links correctly, (2) tamper detection works,
// (3) empty chain verifies clean. Deterministic, no LLM calls.

export function selftest() {
  const testAgent = `__selftest_${now()}`;
  const results = [];

  // Test 1: empty chain verifies ok
  const v0 = verify(testAgent);
  results.push({ test: 'empty_chain_ok', pass: v0.ok === true && v0.entries === 0 });

  // Test 2: append 3 entries, chain verifies
  append(testAgent, 'action', { step: 1, tool: 'read_file', result: 'ok' });
  append(testAgent, 'action', { step: 2, tool: 'write_file', result: 'ok' });
  append(testAgent, 'observation', { step: 3, note: 'task complete' });

  const v1 = verify(testAgent);
  results.push({ test: 'three_entries_verify', pass: v1.ok === true && v1.entries === 3 });

  // Test 3: hash chaining is correct
  const chain = tail(testAgent, 10);
  const hashesLink = chain[0].prev_hash === '0'.repeat(64) &&
    chain[1].prev_hash === chain[0].self_hash &&
    chain[2].prev_hash === chain[1].self_hash;
  results.push({ test: 'hash_linking_correct', pass: hashesLink });

  // Test 4: tamper detection — modify middle entry's payload
  db.prepare('UPDATE record_chain SET payload = ? WHERE id = ?')
    .run('{"tampered": true}', chain[1].id);

  const v2 = verify(testAgent);
  results.push({ test: 'tamper_detected', pass: v2.ok === false && v2.brokenAt === chain[1].id });

  // Cleanup
  db.prepare('DELETE FROM record_chain WHERE agent_id = ?').run(testAgent);

  const allPass = results.every(r => r.pass);
  return { ok: allPass, tests: results };
}
