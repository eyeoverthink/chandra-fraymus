import { createHash } from 'node:crypto';
import { db } from '../db.js';

const now = () => Date.now();

// ── Akashic Record — Structured Knowledge Store ────────────────
// Cross-agent store for decisions, entities, and verified modules.
// SHA-256 keyed for idempotent upsert. Seeded from verified chains,
// fossils, and reflections. Ported from FRAYNIX tools/akashic.py.

export function migrateAkashic() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS akashic_records (
      sha TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_akashic_kind ON akashic_records(kind);
    CREATE INDEX IF NOT EXISTS idx_akashic_subject ON akashic_records(subject);
  `);
}

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// Add or update a record. Idempotent via SHA-256(kind + subject).
export function add(kind, subject, body, source = null, confidence = 1.0) {
  const sha = sha256(`${kind}:${subject}`);
  const ts = now();

  db.prepare(`
    INSERT INTO akashic_records (sha, kind, subject, body, source, confidence, access_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(sha) DO UPDATE SET body = excluded.body, source = excluded.source,
      confidence = MAX(akashic_records.confidence, excluded.confidence),
      updated_at = excluded.updated_at
  `).run(sha, kind, subject, body, source, confidence, ts, ts);

  return { sha, kind, subject, isNew: true };
}

// Query records by kind and/or subject pattern.
export function query(kind = null, subjectPattern = null, limit = 20) {
  let sql = 'SELECT sha, kind, subject, body, source, confidence, access_count, created_at, updated_at FROM akashic_records WHERE 1=1';
  const params = [];

  if (kind) { sql += ' AND kind = ?'; params.push(kind); }
  if (subjectPattern) { sql += ' AND subject LIKE ?'; params.push(`%${subjectPattern}%`); }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);

  // Increment access count
  for (const row of rows) {
    db.prepare('UPDATE akashic_records SET access_count = access_count + 1 WHERE sha = ?').run(row.sha);
  }

  return rows;
}

// Get a specific record by SHA.
export function get(sha) {
  const row = db.prepare('SELECT * FROM akashic_records WHERE sha = ?').get(sha);
  if (row) {
    db.prepare('UPDATE akashic_records SET access_count = access_count + 1 WHERE sha = ?').run(sha);
  }
  return row;
}

// Remove a record.
export function remove(sha) {
  const info = db.prepare('DELETE FROM akashic_records WHERE sha = ?').run(sha);
  return { removed: info.changes > 0 };
}

// Summary: kind counts + latest 3 decisions. For prompt injection.
export function summary() {
  const kindCounts = db.prepare(
    'SELECT kind, COUNT(*) as count FROM akashic_records GROUP BY kind ORDER BY count DESC'
  ).all();

  const latestDecisions = db.prepare(
    `SELECT subject, body FROM akashic_records WHERE kind = 'decision' ORDER BY updated_at DESC LIMIT 3`
  ).all();

  const latestEntities = db.prepare(
    `SELECT subject, body FROM akashic_records WHERE kind = 'entity' ORDER BY updated_at DESC LIMIT 3`
  ).all();

  const totalRecords = db.prepare('SELECT COUNT(*) as c FROM akashic_records').get().c;

  return {
    totalRecords,
    kinds: kindCounts,
    recentDecisions: latestDecisions,
    recentEntities: latestEntities,
  };
}

// Build context block for injection into agent prompts.
export function buildPromptContext(maxChars = 1500) {
  const s = summary();
  if (s.totalRecords === 0) return '';

  const parts = [`[Akashic Record — ${s.totalRecords} entries across ${s.kinds.length} kinds]`];

  if (s.recentDecisions.length) {
    parts.push('Recent decisions:');
    for (const d of s.recentDecisions) {
      parts.push(`- ${d.subject}: ${d.body.slice(0, 200)}`);
    }
  }

  if (s.recentEntities.length) {
    parts.push('Known entities:');
    for (const e of s.recentEntities) {
      parts.push(`- ${e.subject}: ${e.body.slice(0, 200)}`);
    }
  }

  let text = parts.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n[… truncated]';

  return '\n\n' + text;
}

// Seed from verified agent memories (fossils, chain findings).
export function seedFromMemories() {
  let seeded = 0;

  // Seed from fossils
  const fossils = db.prepare(
    `SELECT key, value FROM agent_memories WHERE category = 'fossil' AND confidence >= 1.0 LIMIT 50`
  ).all();

  for (const f of fossils) {
    try {
      const data = JSON.parse(f.value);
      if (data.goal) {
        add('module', data.goal.slice(0, 200), JSON.stringify({
          language: data.language,
          iterations: data.iterations,
          verified: true,
        }), 'fossil', 1.0);
        seeded++;
      }
    } catch (_) {}
  }

  // Seed from chain verified findings
  const chainFindings = db.prepare(
    `SELECT key, value FROM agent_memories WHERE category = 'chain_verified' AND confidence >= 0.9 LIMIT 50`
  ).all();

  for (const cf of chainFindings) {
    try {
      const data = JSON.parse(cf.value);
      if (data.objective && data.text) {
        add('decision', data.objective.slice(0, 200), data.text, 'chain', 0.9);
        seeded++;
      }
    } catch (_) {}
  }

  // Seed from reflections
  const reflections = db.prepare(
    `SELECT insights FROM reflections WHERE insights IS NOT NULL ORDER BY created_at DESC LIMIT 10`
  ).all();

  for (const r of reflections) {
    try {
      const insights = JSON.parse(r.insights);
      if (Array.isArray(insights)) {
        for (const insight of insights.slice(0, 3)) {
          if (typeof insight === 'string' && insight.length > 20) {
            add('decision', insight.slice(0, 200), insight, 'reflection', 0.8);
            seeded++;
          }
        }
      }
    } catch (_) {}
  }

  return { seeded };
}

// ── Selftest ───────────────────────────────────────────────────
// Proves: (1) add creates record, (2) idempotent upsert, (3) query
// by kind, (4) summary returns counts.

export function selftest() {
  const results = [];
  const testKind = `__test_${now()}`;

  // Test 1: add creates record
  const a1 = add(testKind, 'test-subject-1', 'First test body', 'selftest');
  results.push({ test: 'add_creates', pass: a1.sha.length === 64 });

  // Test 2: idempotent upsert (same kind+subject → same SHA)
  const a2 = add(testKind, 'test-subject-1', 'Updated body', 'selftest-2');
  results.push({ test: 'idempotent_upsert', pass: a1.sha === a2.sha });

  // Test 3: query by kind
  add(testKind, 'test-subject-2', 'Second body', 'selftest');
  const q1 = query(testKind);
  results.push({ test: 'query_by_kind', pass: q1.length === 2 });

  // Test 4: query by subject pattern
  const q2 = query(null, 'test-subject-1');
  results.push({ test: 'query_by_subject', pass: q2.length >= 1 && q2[0].subject === 'test-subject-1' });

  // Test 5: get by SHA
  const g1 = get(a1.sha);
  results.push({ test: 'get_by_sha', pass: g1 && g1.body === 'Updated body' });

  // Test 6: summary returns data
  const s = summary();
  results.push({ test: 'summary_works', pass: s.totalRecords >= 2 });

  // Cleanup
  remove(a1.sha);
  const a2sha = sha256(`${testKind}:test-subject-2`);
  remove(a2sha);

  const allPass = results.every(r => r.pass);
  return { ok: allPass, tests: results };
}
