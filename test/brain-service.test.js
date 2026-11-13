import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// brain-service and knowledge-graph write through the shared db handle: give them their own data folder BEFORE
// anything imports server/db.js, or this test would read and write the real store.
let directory, db, B, KG;
const previousDataDir = process.env.CHANDRA_DATA_DIR;
before(async () => {
  directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'chandra-brain-'));
  process.env.CHANDRA_DATA_DIR = path.join(directory, 'data');
  ({ db } = await import('../server/db.js'));
  KG = await import('../server/intelligence/knowledge-graph.js');
  B = await import('../server/fraymus-os/brain-service.js');
  KG.migrateKnowledgeGraph();
  db.exec(`CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, entity TEXT, claim TEXT, kind TEXT, confidence REAL, fingerprint TEXT, source TEXT, source_memory_id INTEGER, asserted_by TEXT, quote TEXT, seen_count INTEGER, created_at INTEGER, last_seen_at INTEGER, expired_at INTEGER, superseded_by INTEGER);
    CREATE TABLE IF NOT EXISTS goal_proposals (id TEXT PRIMARY KEY, objective TEXT);
    CREATE TABLE IF NOT EXISTS goal_executions (id INTEGER PRIMARY KEY, goal_id TEXT, agent_id TEXT, status TEXT, quality REAL, started_at INTEGER, finished_at INTEGER);
    CREATE TABLE IF NOT EXISTS forged_skills (id TEXT PRIMARY KEY, name TEXT, status TEXT, calls INTEGER, failures INTEGER, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS forged_skill_calls (id INTEGER PRIMARY KEY, skill_id TEXT, agent_id TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS fleet_model_calls (id INTEGER PRIMARY KEY, run_id TEXT, agent_id TEXT, host TEXT, model TEXT, ms INTEGER, ok INTEGER, error TEXT, at INTEGER);`);
});
after(async () => {
  if (previousDataDir === undefined) delete process.env.CHANDRA_DATA_DIR; else process.env.CHANDRA_DATA_DIR = previousDataDir;
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
});

test('metrics: counts, average degree, density, islands, unlinked', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
  const m = B.brainMetrics(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'd', to: 'd' }, { from: 'a', to: 'zz' }]);
  assert.deepEqual([m.nodes, m.edges, m.components, m.orphans, m.maxDegree], [5, 2, 3, 2, 2], 'self-loops and dangling links do not count');
  assert.equal(m.avgDegree, 0.8); assert.equal(m.density, 0.2); assert.equal(m.orphanShare, 0.4);
});

test('ego graph: nearest first, within depth, capped', () => {
  const edges = [['f', 'a'], ['a', 'b'], ['b', 'c'], ['f', 'x'], ['x', 'y']].map(([from, to]) => ({ from, to }));
  const hops = B.egoGraph('f', edges, { depth: 2 });
  assert.deepEqual([...hops.keys()].sort(), ['a', 'b', 'f', 'x', 'y']);
  assert.equal(hops.get('b'), 2); assert.ok(!hops.has('c'), 'three hops is too far');
  assert.equal(B.egoGraph('f', edges, { depth: 5, cap: 3 }).size, 3);
});

test('selection: every agent, then the used part, and no single owner fills the picture', () => {
  const now = Date.now();
  const rows = [{ id: 'ag1', type: 'agent', metadata: '{}' }, { id: 'ag2', type: 'agent', metadata: '{}' }];
  for (let i = 0; i < 50; i++) rows.push({ id: `s${i}`, type: 'memory', metadata: '{"agent_id":"system"}', access_count: 0, created_at: now - 30 * 86_400_000 });
  for (let i = 0; i < 10; i++) rows.push({ id: `o${i}`, type: 'memory', metadata: '{"agent_id":"other"}', access_count: 0, created_at: now - 30 * 86_400_000 });
  const degree = new Map(rows.map((r, i) => [r.id, r.id.startsWith('s') ? 100 - i : 1]));          // system's memories are the most connected
  const picked = B.selectNodes(rows, degree, { budget: 42, now, ownerShare: 0.5 });
  assert.equal(picked.filter(r => r.type === 'agent').length, 2);
  assert.equal(picked.filter(r => r.id.startsWith('s')).length, 20, 'system capped at half the room');
  assert.equal(picked.filter(r => r.id.startsWith('o')).length, 10, "the other agent's memories get in");
});

test('a snapshot reads the real stores and joins them; search and focus stay one connected picture', () => {
  const now = Date.now();
  // createNode returns the new node's id
  const ag = { id: KG.createNode({ type: 'agent', sourceTable: 'agents', sourceId: 'scout', label: 'scout', content: 'Agent scout' }) };
  const m1 = { id: KG.createNode({ type: 'memory', sourceTable: 'agent_memories', sourceId: '7', label: 'scout:lighthouse', content: 'the lighthouse keeper saw a ship', metadata: { agent_id: 'scout', confidence: 0.9 } }) };
  const m2 = { id: KG.createNode({ type: 'memory', sourceTable: 'agent_memories', sourceId: '8', label: 'scout:fog', content: 'fog rolled in at night', metadata: { agent_id: 'scout' } }) };
  KG.createEdge({ fromNodeId: ag.id, toNodeId: m1.id, relation: 'owns_memory', weight: 0.7 });
  KG.createEdge({ fromNodeId: m1.id, toNodeId: m2.id, relation: 'semantically_related', weight: 0.5 });
  db.prepare("INSERT INTO facts (entity, claim, kind, confidence, fingerprint, source_memory_id, asserted_by, seen_count, created_at, last_seen_at) VALUES ('lighthouse', 'is 40 m tall', 'fact', 0.8, 'x', 7, 'scout', 1, ?, ?)").run(now, now);
  db.prepare("INSERT INTO goal_proposals (id, objective) VALUES ('g1', 'map the coast')").run();
  db.prepare("INSERT INTO goal_executions (goal_id, agent_id, status, quality, started_at, finished_at) VALUES ('g1', 'scout', 'completed', 0.7, ?, ?)").run(now - 5000, now);
  db.prepare("INSERT INTO fleet_model_calls (agent_id, host, model, ms, ok, at) VALUES ('scout', 'home', 'qwen3:14b', 900, 1, ?)").run(now);
  const brain = B.createBrainService(db);
  const s = brain.snapshot({ budget: 100 });
  assert.equal(s.nodes[0].id, 'core');
  const kinds = new Set(s.nodes.map(n => n.kind));
  for (const k of ['core', 'agent', 'memory', 'fact', 'goal', 'model']) assert.ok(kinds.has(k), k);
  const rel = new Set(s.edges.map(e => e.type));
  for (const r of ['owns_memory', 'semantically_related', 'core', 'fact_of', 'executed', 'answered_by']) assert.ok(rel.has(r), r);
  assert.equal(s.edges.find(e => e.type === 'fact_of').to, m1.id, 'a fact hangs on the memory it was read from');
  assert.equal(s.nodes.find(n => n.kind === 'goal').metrics.quality, 0.7);
  assert.equal(s.shown.components, 1);
  assert.ok(s.whole.knowledgeNodes >= 3 && s.whole.facts >= 1);
  const found = brain.snapshot({ budget: 100, q: 'lighthouse' });
  assert.ok(found.nodes.some(n => n.id === m1.id)); assert.equal(found.shown.components, 1, 'a search view has no floating islands');
  const focused = brain.snapshot({ budget: 100, focus: m2.id });
  assert.ok(focused.nodes.some(n => n.id === ag.id), 'two hops from the fog memory reaches its agent'); assert.equal(focused.shown.components, 1);
  const p = brain.pulse(now - 1000);
  assert.ok(p.ids.includes('fact:lighthouse') && p.ids.includes('goal:g1') && p.ids.includes('model:qwen3:14b@home'));
});

test('recall marks what it hands to an agent, so the brain can show what is in use', () => {
  const before = db.prepare("SELECT access_count FROM knowledge_nodes WHERE label = 'scout:lighthouse'").get().access_count;
  const got = KG.contextualRecall('lighthouse keeper ship', { agentId: 'scout', limit: 3 });
  assert.ok(got.some(r => r.label === 'scout:lighthouse'));
  assert.equal(db.prepare("SELECT access_count FROM knowledge_nodes WHERE label = 'scout:lighthouse'").get().access_count, before + 1);
});
