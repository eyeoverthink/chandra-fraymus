import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { chatOllama } from '../commerce/shared.js';
import { getAutonomyModifiers } from './consciousness-gate.js';

const now = () => Date.now();

// ─── Schema ───────────────────────────────────────────────────
export function migrateKnowledgeGraph() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_table TEXT,
      source_id TEXT,
      label TEXT NOT NULL,
      content TEXT,
      content_hash TEXT,
      keywords TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      access_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kn_type ON knowledge_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_kn_source ON knowledge_nodes(source_table, source_id);
    CREATE INDEX IF NOT EXISTS idx_kn_hash ON knowledge_nodes(content_hash);

    CREATE TABLE IF NOT EXISTS knowledge_edges (
      id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_node_id) REFERENCES knowledge_nodes(id),
      FOREIGN KEY (to_node_id) REFERENCES knowledge_nodes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ke_from ON knowledge_edges(from_node_id);
    CREATE INDEX IF NOT EXISTS idx_ke_to ON knowledge_edges(to_node_id);
    CREATE INDEX IF NOT EXISTS idx_ke_relation ON knowledge_edges(relation);

    CREATE TABLE IF NOT EXISTS knowledge_graph_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      node_count INTEGER,
      edge_count INTEGER,
      details TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kge_created ON knowledge_graph_events(created_at DESC);
  `);
}

// ─── Keyword Extraction ───────────────────────────────────────
const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','must','can','could',
  'and','but','or','nor','for','yet','so','in','on','at','to','from','by','with',
  'of','about','into','through','during','before','after','above','below','between',
  'out','off','over','under','again','further','then','once','here','there','when',
  'where','why','how','all','each','every','both','few','more','most','other','some',
  'such','no','not','only','own','same','than','too','very','just','that','this',
  'these','those','it','its','i','me','my','we','our','you','your','he','him','his',
  'she','her','they','them','their','what','which','who','whom',
]);

function extractKeywords(text) {
  if (!text) return [];
  const words = String(text).toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

function jaccardSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function contentHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

// ─── Node Operations ──────────────────────────────────────────
export function createNode({ type, sourceTable, sourceId, label, content, metadata }) {
  const id = `kn_${randomUUID().slice(0, 12)}`;
  const hash = contentHash(content);
  const existing = db.prepare('SELECT id FROM knowledge_nodes WHERE content_hash = ? AND type = ?').get(hash, type);
  if (existing) return existing.id;

  const keywords = JSON.stringify(extractKeywords(`${label} ${content}`));
  db.prepare(
    `INSERT INTO knowledge_nodes (id, type, source_table, source_id, label, content, content_hash, keywords, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, type, sourceTable || null, sourceId || null,
    String(label).slice(0, 200), String(content || '').slice(0, 2000),
    hash, keywords, JSON.stringify(metadata || {}), now());
  return id;
}

export function getNode(id) {
  const row = db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(id);
  if (row) {
    row.keywords = JSON.parse(row.keywords || '[]');
    row.metadata = JSON.parse(row.metadata || '{}');
    db.prepare('UPDATE knowledge_nodes SET access_count = access_count + 1 WHERE id = ?').run(id);
  }
  return row || null;
}

export function searchNodes(query, { type, limit = 20 } = {}) {
  const keywords = extractKeywords(query);
  if (!keywords.length) return [];
  const likeClause = keywords.slice(0, 5).map(() => 'keywords LIKE ?').join(' OR ');
  const params = keywords.slice(0, 5).map(k => `%${k}%`);
  let sql = `SELECT * FROM knowledge_nodes WHERE (${likeClause})`;
  if (type) { sql += ' AND type = ?'; params.push(type); }
  sql += ' ORDER BY access_count DESC, created_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => {
    r.keywords = JSON.parse(r.keywords || '[]');
    r.metadata = JSON.parse(r.metadata || '{}');
    r.relevance = jaccardSimilarity(keywords, r.keywords);
    return r;
  }).sort((a, b) => b.relevance - a.relevance);
}

// ─── Edge Operations ──────────────────────────────────────────
export function createEdge({ fromNodeId, toNodeId, relation, weight, metadata }) {
  const existing = db.prepare(
    'SELECT id FROM knowledge_edges WHERE from_node_id = ? AND to_node_id = ? AND relation = ?'
  ).get(fromNodeId, toNodeId, relation);
  if (existing) {
    db.prepare('UPDATE knowledge_edges SET weight = MAX(weight, ?) WHERE id = ?')
      .run(weight || 1.0, existing.id);
    return existing.id;
  }
  const id = `ke_${randomUUID().slice(0, 12)}`;
  db.prepare(
    `INSERT INTO knowledge_edges (id, from_node_id, to_node_id, relation, weight, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, fromNodeId, toNodeId, relation, weight || 1.0, JSON.stringify(metadata || {}), now());
  return id;
}

export function getEdgesFrom(nodeId) {
  return db.prepare(
    `SELECT e.*, n.label as target_label, n.type as target_type
     FROM knowledge_edges e JOIN knowledge_nodes n ON e.to_node_id = n.id
     WHERE e.from_node_id = ? ORDER BY e.weight DESC`
  ).all(nodeId);
}

export function getEdgesTo(nodeId) {
  return db.prepare(
    `SELECT e.*, n.label as source_label, n.type as source_type
     FROM knowledge_edges e JOIN knowledge_nodes n ON e.from_node_id = n.id
     WHERE e.to_node_id = ? ORDER BY e.weight DESC`
  ).all(nodeId);
}

// ─── Graph Traversal ──────────────────────────────────────────
export function queryRelated(nodeId, { depth = 2, limit = 30 } = {}) {
  const visited = new Set();
  const results = [];
  const queue = [{ id: nodeId, d: 0, path: [] }];

  while (queue.length > 0 && results.length < limit) {
    const { id, d, path } = queue.shift();
    if (visited.has(id) || d > depth) continue;
    visited.add(id);

    if (d > 0) {
      const node = db.prepare('SELECT id, type, label, content, keywords FROM knowledge_nodes WHERE id = ?').get(id);
      if (node) {
        node.keywords = JSON.parse(node.keywords || '[]');
        node.depth = d;
        node.path = path;
        results.push(node);
      }
    }

    if (d < depth) {
      const outEdges = db.prepare(
        'SELECT to_node_id as next, relation, weight FROM knowledge_edges WHERE from_node_id = ? ORDER BY weight DESC LIMIT 10'
      ).all(id);
      const inEdges = db.prepare(
        'SELECT from_node_id as next, relation, weight FROM knowledge_edges WHERE to_node_id = ? ORDER BY weight DESC LIMIT 10'
      ).all(id);

      for (const e of [...outEdges, ...inEdges]) {
        if (!visited.has(e.next)) {
          queue.push({ id: e.next, d: d + 1, path: [...path, e.relation] });
        }
      }
    }
  }
  return results;
}

// ─── Indexing: Memories → Nodes ───────────────────────────────
export function indexMemories() {
  const memories = db.prepare(
    `SELECT id, agent_id, category, key, value, confidence, verified_at FROM agent_memories ORDER BY updated_at DESC LIMIT 500`
  ).all();

  let created = 0;
  let edges = 0;
  const agentNodeMap = new Map();

  for (const m of memories) {
    const nodeId = createNode({
      type: 'memory',
      sourceTable: 'agent_memories',
      sourceId: String(m.id),
      label: `${m.agent_id}:${m.category}:${m.key}`,
      content: String(m.value || '').slice(0, 1500),
      metadata: { agent_id: m.agent_id, category: m.category, confidence: m.confidence, verified: !!m.verified_at },
    });

    if (!agentNodeMap.has(m.agent_id)) {
      const agentNodeId = createNode({
        type: 'agent',
        sourceTable: 'agents',
        sourceId: m.agent_id,
        label: m.agent_id,
        content: `Agent ${m.agent_id}`,
      });
      agentNodeMap.set(m.agent_id, agentNodeId);
    }
    createEdge({ fromNodeId: agentNodeMap.get(m.agent_id), toNodeId: nodeId, relation: 'owns_memory', weight: m.confidence || 0.5 });
    edges++;
    created++;
  }
  return { indexed: created, edges };
}

// ─── Indexing: Reflections → Nodes ────────────────────────────
export function indexReflections() {
  const reflections = db.prepare(
    `SELECT id, trigger, input_summary, actions_taken, insights, duration_ms, created_at FROM reflections ORDER BY created_at DESC LIMIT 200`
  ).all();

  let created = 0;
  for (const r of reflections) {
    const insights = r.insights || r.input_summary || '';
    createNode({
      type: 'reflection',
      sourceTable: 'reflections',
      sourceId: String(r.id),
      label: `Reflection ${String(r.id).slice(0, 8)} (${r.trigger || 'manual'})`,
      content: String(insights).slice(0, 1500),
      metadata: { trigger: r.trigger, actions_taken: r.actions_taken, duration_ms: r.duration_ms },
    });
    created++;
  }
  return { indexed: created };
}

// ─── Indexing: Fossils → Nodes ────────────────────────────────
export function indexFossils() {
  let created = 0;
  try {
    const fossils = db.prepare(
      `SELECT id, snapshot_type, state_hash, data, created_at FROM state_fossils ORDER BY created_at DESC LIMIT 100`
    ).all();

    for (const f of fossils) {
      const data = f.data ? String(f.data).slice(0, 800) : '';
      createNode({
        type: 'fossil',
        sourceTable: 'state_fossils',
        sourceId: String(f.id),
        label: `Fossil:${f.snapshot_type} ${String(f.state_hash || '').slice(0, 8)}`,
        content: data,
        metadata: { snapshot_type: f.snapshot_type, state_hash: f.state_hash },
      });
      created++;
    }
  } catch (_) {}
  return { indexed: created };
}

// ─── Semantic Edge Building ───────────────────────────────────
// Phase R: threshold raised from 0.15 — at 0.15 nearly every pair of reflection
// memories qualified and the graph reached 91,467 edges over 1,653 nodes (~55 per
// node, a near-complete graph that carries no structure). consolidateGraph() also
// caps each node to its MAX_EDGES_PER_NODE strongest edges.
export const MAX_EDGES_PER_NODE = 8;

export function buildSemanticEdges({ threshold = 0.35 } = {}) {
  const nodes = db.prepare(
    'SELECT id, type, keywords, label FROM knowledge_nodes ORDER BY created_at DESC LIMIT 300'
  ).all().map(n => ({ ...n, kw: JSON.parse(n.keywords || '[]') }));

  let edgesCreated = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].type === nodes[j].type && nodes[i].type === 'agent') continue;
      const sim = jaccardSimilarity(nodes[i].kw, nodes[j].kw);
      if (sim >= threshold) {
        createEdge({
          fromNodeId: nodes[i].id,
          toNodeId: nodes[j].id,
          relation: 'semantically_related',
          weight: sim,
        });
        edgesCreated++;
      }
    }
  }
  return { edgesCreated };
}

// ─── Contextual Recall (for brain.js) ─────────────────────────
export function contextualRecall(query, { agentId, limit = 5 } = {}) {
  const matches = searchNodes(query, { limit: 3 });
  if (!matches.length) return [];

  const allRelated = new Map();
  for (const match of matches) {
    const related = queryRelated(match.id, { depth: 2, limit: 10 });
    for (const r of related) {
      if (!allRelated.has(r.id)) {
        allRelated.set(r.id, r);
      }
    }
    allRelated.set(match.id, { ...match, depth: 0, path: [] });
  }

  let results = [...allRelated.values()];
  if (agentId) {
    results.sort((a, b) => {
      const aAgent = a.label?.startsWith(agentId) ? 1 : 0;
      const bAgent = b.label?.startsWith(agentId) ? 1 : 0;
      return bAgent - aAgent || a.depth - b.depth;
    });
  } else {
    results.sort((a, b) => a.depth - b.depth);
  }

  return results.slice(0, limit).map(r => ({
    id: r.id,
    type: r.type,
    label: r.label,
    content: String(r.content || '').slice(0, 200),
    depth: r.depth,
    path: r.path,
  }));
}

// ─── Consolidation (daemon step) ──────────────────────────────
export function consolidateGraph() {
  const t0 = now();
  const indexResult = { memories: indexMemories(), reflections: indexReflections(), fossils: indexFossils() };
  const edgeResult = buildSemanticEdges();

  // Prune orphan nodes (no edges, older than 7 days)
  const sevenDaysAgo = now() - 7 * 86400_000;
  const orphans = db.prepare(`
    SELECT n.id FROM knowledge_nodes n
    LEFT JOIN knowledge_edges e1 ON n.id = e1.from_node_id
    LEFT JOIN knowledge_edges e2 ON n.id = e2.to_node_id
    WHERE e1.id IS NULL AND e2.id IS NULL AND n.created_at < ? AND n.access_count = 0
  `).all(sevenDaysAgo);
  let pruned = 0;
  for (const o of orphans) {
    db.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(o.id);
    pruned++;
  }

  // Prune weak edges older than 14 days
  const fourteenDaysAgo = now() - 14 * 86400_000;
  const weakPruned = db.prepare(
    'DELETE FROM knowledge_edges WHERE weight < 0.1 AND created_at < ?'
  ).run(fourteenDaysAgo);

  // Degree cap: keep each node's MAX_EDGES_PER_NODE strongest edges (by weight,
  // newest wins ties). Density beyond that is noise, not knowledge.
  const capPruned = pruneToDegreeCap(MAX_EDGES_PER_NODE);

  // Prune old events
  db.prepare('DELETE FROM knowledge_graph_events WHERE created_at < ?').run(sevenDaysAgo);

  const stats = getStats();
  const duration = now() - t0;

  db.prepare(
    'INSERT INTO knowledge_graph_events (event_type, node_count, edge_count, details, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('consolidation', stats.nodeCount, stats.edgeCount,
    JSON.stringify({ indexed: indexResult, edges: edgeResult.edgesCreated, pruned, weakPruned: weakPruned.changes, capPruned }),
    duration, now());

  try {
    publish('system', 'system.knowledge_graph', JSON.stringify({
      type: 'consolidation', nodes: stats.nodeCount, edges: stats.edgeCount,
      newEdges: edgeResult.edgesCreated, pruned, capPruned, durationMs: duration,
    }));
  } catch (_) {}

  return { indexed: indexResult, edges: edgeResult, pruned, weakPruned: weakPruned.changes, capPruned, stats, durationMs: duration };
}

export function pruneToDegreeCap(cap = MAX_EDGES_PER_NODE) {
  // Rank each node's edges (as either endpoint) by weight desc, created_at desc;
  // delete every edge that is beyond the cap for BOTH of its endpoints would keep
  // hubs intact, so we delete edges beyond the cap for the endpoint that ranks them lowest.
  const victims = db.prepare(`
    WITH ranked AS (
      SELECT e.id, ROW_NUMBER() OVER (PARTITION BY n.node ORDER BY e.weight DESC, e.created_at DESC) AS rn
      FROM knowledge_edges e
      JOIN (SELECT id, from_node_id AS node FROM knowledge_edges UNION ALL SELECT id, to_node_id FROM knowledge_edges) n ON n.id = e.id
      WHERE e.relation = 'semantically_related'
    )
    SELECT DISTINCT id FROM ranked WHERE rn > ?
  `).all(cap).map(r => r.id);
  if (!victims.length) return 0;
  const del = db.prepare('DELETE FROM knowledge_edges WHERE id = ?');
  const tx = db.transaction(ids => { for (const id of ids) del.run(id); });
  tx(victims);
  return victims.length;
}

// ─── Stats ────────────────────────────────────────────────────
export function getStats() {
  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM knowledge_nodes').get().c;
  const edgeCount = db.prepare('SELECT COUNT(*) as c FROM knowledge_edges').get().c;
  const byType = db.prepare('SELECT type, COUNT(*) as c FROM knowledge_nodes GROUP BY type ORDER BY c DESC').all();
  const byRelation = db.prepare('SELECT relation, COUNT(*) as c FROM knowledge_edges GROUP BY relation ORDER BY c DESC').all();
  const topAccessed = db.prepare('SELECT id, label, type, access_count FROM knowledge_nodes ORDER BY access_count DESC LIMIT 10').all();
  return { nodeCount, edgeCount, byType, byRelation, topAccessed };
}

// ─── Find Clusters ────────────────────────────────────────────
export function findClusters({ minSize = 3 } = {}) {
  const nodes = db.prepare('SELECT id FROM knowledge_nodes').all();
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, new Set());
  const edges = db.prepare('SELECT from_node_id, to_node_id FROM knowledge_edges').all();
  for (const e of edges) {
    if (adj.has(e.from_node_id)) adj.get(e.from_node_id).add(e.to_node_id);
    if (adj.has(e.to_node_id)) adj.get(e.to_node_id).add(e.from_node_id);
  }

  const visited = new Set();
  const clusters = [];
  for (const [startId] of adj) {
    if (visited.has(startId)) continue;
    const cluster = [];
    const q = [startId];
    while (q.length) {
      const id = q.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      cluster.push(id);
      for (const neighbor of (adj.get(id) || [])) {
        if (!visited.has(neighbor)) q.push(neighbor);
      }
    }
    if (cluster.length >= minSize) {
      const clusterNodes = db.prepare(
        `SELECT id, type, label FROM knowledge_nodes WHERE id IN (${cluster.map(() => '?').join(',')})`
      ).all(...cluster);
      clusters.push({ size: cluster.length, nodes: clusterNodes });
    }
  }
  return clusters.sort((a, b) => b.size - a.size);
}

// ─── REST Routes ──────────────────────────────────────────────
export function installKnowledgeGraphRoutes(app) {
  app.get('/api/intelligence/knowledge-graph', (_req, res) => {
    try { res.json(getStats()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/knowledge-graph/search', (req, res) => {
    try {
      const q = req.query.q || '';
      const type = req.query.type || undefined;
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      if (!q) return res.json([]);
      res.json(searchNodes(q, { type, limit }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/knowledge-graph/node/:id', (req, res) => {
    try {
      const node = getNode(req.params.id);
      if (!node) return res.status(404).json({ error: 'Node not found' });
      const outEdges = getEdgesFrom(node.id);
      const inEdges = getEdgesTo(node.id);
      res.json({ node, outEdges, inEdges });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/knowledge-graph/related/:id', (req, res) => {
    try {
      const depth = Math.min(4, Math.max(1, parseInt(req.query.depth) || 2));
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      res.json(queryRelated(req.params.id, { depth, limit }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/knowledge-graph/clusters', (req, res) => {
    try {
      const minSize = Math.min(20, Math.max(2, parseInt(req.query.minSize) || 3));
      res.json(findClusters({ minSize }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/knowledge-graph/recall', (req, res) => {
    try {
      const q = req.query.q || '';
      const agentId = req.query.agent || undefined;
      const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 5));
      if (!q) return res.json([]);
      res.json(contextualRecall(q, { agentId, limit }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/intelligence/knowledge-graph/consolidate', async (_req, res) => {
    try { res.json(consolidateGraph()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/intelligence/knowledge-graph/history', (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
      const rows = db.prepare('SELECT * FROM knowledge_graph_events ORDER BY created_at DESC LIMIT ?').all(limit);
      res.json(rows.map(r => ({ ...r, details: JSON.parse(r.details || '{}') })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
