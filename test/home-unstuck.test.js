// 2026-11-13: two questions on the home screen went wrong. "analyze your system status" got a list of installed
// Ollama models; "how far is the system from AGI?" spun forever, queued behind four fleet runs that were each waiting
// on a tool that never returned. These tests hold the three fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { withToolDeadline } from '../server/fleet/runtime.js';
import { systemFacts, renderSystemReport } from '../server/fraymus-os/system-report.js';
import { createFraymusOs } from '../server/fraymus-os/index.js';

test('a tool that never returns is abandoned at its deadline; a quick one passes through', async () => {
  const never = { timeoutMs: 1000 };
  const t0 = Date.now();
  const out = await withToolDeadline(never, 'chain.run', () => new Promise(() => {}));
  assert.equal(out.timedOut, true);
  assert.match(out.error, /chain\.run did not finish within 1 s/);
  assert.ok(Date.now() - t0 < 3000, 'returned at the deadline, not later');
  assert.deepEqual(await withToolDeadline({}, 'clock.now', () => ({ ok: 1 })), { ok: 1 });
  await assert.rejects(withToolDeadline({}, 'boom', () => { throw new Error('bad'); }), /bad/);
});

function fixtureDb() {
  const db = new Database(':memory:');
  const now = Date.now();
  db.exec(`
    CREATE TABLE runs (id TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE goal_executions (id TEXT, status TEXT, quality REAL, started_at INTEGER);
    CREATE TABLE daemon_cycles (id TEXT, duration_ms INTEGER, created_at INTEGER);
    CREATE TABLE consciousness_audits (verdict TEXT, proofs_passed INTEGER, proofs_total INTEGER, phi REAL, created_at DATETIME);
    CREATE TABLE self_audit_findings (severity TEXT, summary TEXT, last_seen INTEGER, resolved_at INTEGER);
    CREATE TABLE approvals (id TEXT, status TEXT);
  `);
  const run = db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)');
  run.run('a', 'done', now - 1000, now - 900);
  run.run('b', 'error', now - 2000, now - 1900);
  run.run('c', 'running', now - 90 * 60_000, now - 80 * 60_000);   // stuck: no progress for 80 min
  run.run('d', 'queued', now - 5000, now - 5000);
  db.prepare('INSERT INTO goal_executions VALUES (?, ?, ?, ?)').run('g1', 'completed', 0.5, now - 3000);
  db.prepare('INSERT INTO daemon_cycles VALUES (?, ?, ?)').run('d1', 46_000, now - 120_000);
  db.prepare(`INSERT INTO consciousness_audits VALUES ('PROVEN_INTEGRATED_CORE', 4, 4, 0.27, datetime('now', '-5 minutes'))`).run();
  db.prepare('INSERT INTO self_audit_findings VALUES (?, ?, ?, NULL)').run('REAL', 'verifier has no passes', now);
  db.prepare(`INSERT INTO approvals VALUES ('p1', 'pending')`).run();
  return db;
}

test('the system report reads the live tables, flags stuck runs, and skips what does not exist', () => {
  const db = fixtureDb();
  const facts = systemFacts(db, { fleet: { poolStatus: () => ({ hosts: [{ name: 'home', defaultModel: 'qwen3:14b', healthy: true, calls: 3, meanSeconds: 2.1 }] }) } });
  assert.deepEqual(facts.runs, { total24h: 4, errors24h: 1, running: 1, queued: 1, stuck: 1 });
  assert.equal(facts.consciousness.proofs, '4/4');
  assert.ok(facts.consciousness.agoMs > 4 * 60_000 && facts.consciousness.agoMs < 6 * 60_000, 'TEXT UTC time read as UTC');
  assert.equal(facts.capability, undefined, 'no capability table, no line');
  const text = renderSystemReport(facts);
  assert.match(text, /Agent runs, last 24 h: 4 \(1 errors, 25 %\)\. Now: 1 running, 1 queued\./);
  assert.match(text, /⚠ 1 run has been running with no progress for over 30 min/);
  assert.match(text, /REAL: verifier has no passes/);
  assert.match(text, /1 tool call is waiting for your approval/);
  assert.match(text, /Model pool: home qwen3:14b up, 3 calls ~2\.1 s/);
  assert.doesNotMatch(text, /Installed models/);
  db.close();
});

function osOn(db) {
  return createFraymusOs({
    db, audioDir: mkdtempSync(join(tmpdir(), 'home-unstuck-')), ollamaUrl: 'http://127.0.0.1:11434', voiceStudioUrl: '',
    allowPublicCloud: false, listAgents: () => [], piperAvailable: async () => false,
    fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'fraynix-dna:8b' }] }), { headers: { 'content-type': 'application/json' } }),
  });
}

test('"analyze your system status" answers with the system, not the model list', async () => {
  const db = fixtureDb();
  const os = osOn(db);
  const { sessionId, turnId } = os.command.start({ text: 'analyze your system status' });
  let turn;
  for (let i = 0; i < 200 && (!turn || turn.state === 'thinking'); i++) {
    await new Promise(r => setTimeout(r, 15));
    turn = os.command.session(sessionId).turns.find(t => t.id === turnId);
  }
  assert.equal(turn.state, 'idle', turn.error || '');
  assert.match(turn.answer, /Agent runs, last 24 h/);
  assert.match(turn.answer, /This PC's Ollama: 1 models installed/);
  assert.equal(turn.model, 'live system tables (no model call)');
  db.close();
});

test('a question about the system\'s distance from AGI is answered from the blueprint measurements', async () => {
  const db = new Database(':memory:');
  const now = Date.now();
  db.exec(`CREATE TABLE capability_runs (status TEXT, strategy_mode TEXT, level INTEGER, n INTEGER, g_score REAL, brier REAL, by_family TEXT, completed_at INTEGER);
    CREATE TABLE reasoner_lessons (status TEXT);
    CREATE TABLE smk_experiments (verdict TEXT);
    CREATE TABLE goal_executions (status TEXT, quality REAL, started_at INTEGER);`);
  const fam = JSON.stringify({ planning: { n: 4, correct: 4, skipped: 0 }, transform: { n: 4, correct: 1, skipped: 0 }, code: { n: 4, correct: 4, skipped: 0 } });
  const run = db.prepare(`INSERT INTO capability_runs VALUES ('completed', ?, 1, 12, ?, 0.1, ?, ?)`);
  for (let i = 0; i < 3; i++) run.run('auto', 0.75, fam, now - i * 1000);
  run.run('direct', 0.58, fam, now);
  db.prepare(`INSERT INTO reasoner_lessons VALUES ('reverted')`).run();
  db.prepare(`INSERT INTO smk_experiments VALUES ('kept')`).run();
  db.prepare(`INSERT INTO goal_executions VALUES ('completed', 0.4, ?)`).run(now);

  const os = osOn(db);
  assert.equal(os.command.classify('how far is the system from AGI?').type, 'agi');
  assert.equal(os.command.classify('are you close to superintelligence').type, 'agi');
  assert.notEqual(os.command.classify('make a 45 second explainer about AGI').type, 'agi', 'a request to make something about AGI is not a status question');

  const { sessionId, turnId } = os.command.start({ text: 'how far is the system from AGI?' });
  let turn;
  for (let i = 0; i < 200 && (!turn || turn.state === 'thinking'); i++) {
    await new Promise(r => setTimeout(r, 15));
    turn = os.command.session(sessionId).turns.find(t => t.id === turnId);
  }
  assert.equal(turn.state, 'idle', turn.error || '');
  assert.equal(turn.model, 'AGI blueprint measurements (no model call)');
  assert.match(turn.answer, /This is not AGI/);
  assert.match(turn.answer, /✔ 5\. Planning — planning \(checked by a simulator\) 100 % of 12 graded items/);
  assert.match(turn.answer, /✖ 4\. Abstraction/, '25 % on hidden-rule tasks is not met');
  assert.match(turn.answer, /✖ 7\. Learning — 0 lesson\(s\) kept, 1 reverted/);
  assert.match(turn.answer, /◐ 10\. Self-improvement/, 'judged on an internal objective: a proxy pass, never counted as met');
  assert.match(turn.answer, /raw model without the reasoner 0\.580/);
  db.close();
});

test('a turn left thinking by a restart is closed when the service starts again', () => {
  const db = new Database(':memory:');
  osOn(db);   // creates the schema
  const sessionId = 's1', turnId = 't1', now = Date.now();
  db.prepare('INSERT INTO fraymus_os_sessions (id, created_at, updated_at) VALUES (?, ?, ?)').run(sessionId, now, now);
  // as the dead process left it: the question asked, the answer still "thinking"
  db.prepare(`INSERT INTO fraymus_os_turns (id, session_id, role, text, state, sources, created_at, updated_at)
    VALUES ('u1', ?, 'user', 'how far is the system from AGI?', 'idle', NULL, ?, ?), (?, ?, 'assistant', '', 'thinking', '[]', ?, ?)`)
    .run(sessionId, now, now, turnId, sessionId, now + 1, now + 1);
  const second = osOn(db);
  const turn = second.command.session(sessionId).turns.find(t => t.id === turnId);
  assert.equal(turn.state, 'error');
  assert.match(turn.error, /server restarted/);
  db.close();
});
