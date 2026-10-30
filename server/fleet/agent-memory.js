import { db } from '../db.js';

const now = () => Date.now();

export function storeMemory(agentId, category, key, value, { confidence = 1.0, source = 'agent' } = {}) {
  const existing = db.prepare(
    `SELECT id FROM agent_memories WHERE agent_id = ? AND key = ?`
  ).get(agentId, key);

  if (existing) {
    db.prepare(
      `UPDATE agent_memories SET value = ?, category = ?, confidence = ?, source = ?, access_count = access_count + 1, updated_at = ? WHERE id = ?`
    ).run(typeof value === 'string' ? value : JSON.stringify(value), category, confidence, source, now(), existing.id);
    return { stored: true, updated: true, id: existing.id };
  }

  const info = db.prepare(
    `INSERT INTO agent_memories (agent_id, category, key, value, confidence, source, access_count, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
  ).run(agentId, category, key, typeof value === 'string' ? value : JSON.stringify(value), confidence, source, now(), now());
  return { stored: true, updated: false, id: info.lastInsertRowid };
}

export function recallMemories(agentId, { category, limit = 20, query } = {}) {
  let sql = `SELECT * FROM agent_memories WHERE agent_id = ?`;
  const params = [agentId];

  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }

  if (query) {
    sql += ` AND (key LIKE ? OR value LIKE ?)`;
    const q = `%${query}%`;
    params.push(q, q);
  }

  sql += ` ORDER BY updated_at DESC LIMIT ?`;
  params.push(Math.min(100, Math.max(1, limit)));

  const rows = db.prepare(sql).all(...params);
  for (const r of rows) {
    db.prepare(`UPDATE agent_memories SET access_count = access_count + 1 WHERE id = ?`).run(r.id);
  }
  return rows;
}

export function verifyMemory(id) {
  db.prepare(`UPDATE agent_memories SET verified_at = ? WHERE id = ?`).run(now(), id);
  return { verified: true, id };
}

export function forgetMemory(id) {
  const info = db.prepare(`DELETE FROM agent_memories WHERE id = ?`).run(id);
  return { forgotten: info.changes > 0 };
}

export function agentMemoryStats(agentId) {
  if (agentId) {
    const total = db.prepare(`SELECT COUNT(*) as count FROM agent_memories WHERE agent_id = ?`).get(agentId).count;
    const verified = db.prepare(`SELECT COUNT(*) as count FROM agent_memories WHERE agent_id = ? AND verified_at IS NOT NULL`).get(agentId).count;
    const categories = db.prepare(
      `SELECT category, COUNT(*) as count FROM agent_memories WHERE agent_id = ? GROUP BY category`
    ).all(agentId);
    const recent = db.prepare(
      `SELECT * FROM agent_memories WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 5`
    ).all(agentId);
    return { agentId, total, verified, unverified: total - verified, categories, recent };
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM agent_memories`).get().count;
  const agents = db.prepare(
    `SELECT agent_id, COUNT(*) as count, MAX(updated_at) as lastActive FROM agent_memories GROUP BY agent_id ORDER BY lastActive DESC`
  ).all();
  return { total, agents };
}

export function buildPromptContext(agentId, taskText) {
  const memories = recallMemories(agentId, { limit: 10 });
  if (memories.length === 0) return '';

  const lines = memories.map(m => {
    const verified = m.verified_at ? ' [verified]' : ' [unverified]';
    return `- [${m.category}] ${m.key}: ${String(m.value).slice(0, 300)}${verified}`;
  });

  return `\n--- Agent Memory (${memories.length} entries) ---\n${lines.join('\n')}\n--- End Memory ---\n`;
}

export function autoStoreFromCompletion(agentId, task, result) {
  if (!result || !task) return 0;
  let stored = 0;

  const taskSlice = String(task).slice(0, 200);
  storeMemory(agentId, 'interaction', `task:${Date.now()}`, taskSlice, { confidence: 1.0, source: 'auto' });
  stored++;

  const resultSlice = String(result).slice(0, 500);
  if (resultSlice.length > 20) {
    storeMemory(agentId, 'outcome', `result:${Date.now()}`, resultSlice, { confidence: 0.8, source: 'auto' });
    stored++;
  }

  return stored;
}

export function installAgentMemoryRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/fleet/memory/stats', route((req, res) => {
    res.json(agentMemoryStats(req.query.agentId || null));
  }));

  app.get('/api/fleet/memory/:agentId', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const memories = recallMemories(req.params.agentId, {
      category: req.query.category || undefined,
      query: req.query.q || undefined,
      limit,
    });
    res.json({ memories, count: memories.length });
  }));

  app.post('/api/fleet/memory/:agentId', route((req, res) => {
    const { category, key, value, confidence } = req.body;
    if (!category || !key || value === undefined) return res.status(400).json({ error: 'category, key, and value required' });
    res.status(201).json(storeMemory(req.params.agentId, category, key, value, { confidence: confidence || 1.0, source: 'manual' }));
  }));

  app.post('/api/fleet/memory/verify/:id', route((req, res) => {
    res.json(verifyMemory(parseInt(req.params.id)));
  }));

  app.delete('/api/fleet/memory/:id', route((req, res) => {
    res.json(forgetMemory(parseInt(req.params.id)));
  }));
}
