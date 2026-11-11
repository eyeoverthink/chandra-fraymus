import { db } from '../db.js';
import { relevantMemories } from '../intelligence/memory-search-service.js';
import { isTaskEcho } from '../intelligence/memory-rank.js';

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

/**
 * The memories an agent carries into a run. With the task in hand, up to six are the ones that are ABOUT the task
 * (keyword search over everything the agent ever stored, synchronous — a prompt never waits on a model) and the rest
 * are the newest. Without a task it is the ten newest, as before. The task's own echo (the line auto-stored when the
 * run began) is not counted as a memory of it.
 */
/**
 * An operator's or an experiment's override of the memory block for one agent: `mode` 'recent' is the block as it
 * was before task-relevant recall (the ten newest), 'relevant' the block as it is now; `maxId` hides memories stored
 * after a point, so two runs being compared read the same store. `null` removes the override.
 */
const contextOverride = new Map();
export function setMemoryContextMode(agentId, mode, { maxId = null } = {}) {
  if (!mode) { contextOverride.delete(agentId); return { agentId, mode: null }; }
  contextOverride.set(agentId, { mode: mode === 'recent' ? 'recent' : 'relevant', maxId: Number.isFinite(maxId) ? maxId : null });
  return { agentId, ...contextOverride.get(agentId) };
}

function pickContext(agentId, taskText, override = contextOverride.get(agentId)) {
  const task = String(taskText || '').trim(), mode = override?.mode || 'relevant', maxId = override?.maxId ?? null;
  const visible = m => maxId == null || m.id <= maxId;
  const relevant = task && mode === 'relevant' ? relevantMemories(agentId, task, { limit: 14 }).filter(m => visible(m) && !isTaskEcho(m, task)).slice(0, 6) : [];
  const seen = new Set(relevant.map(m => m.id));
  const newest = db.prepare(`SELECT * FROM agent_memories WHERE agent_id = ?${maxId == null ? '' : ' AND id <= ?'} ORDER BY updated_at DESC LIMIT 10`).all(...(maxId == null ? [agentId] : [agentId, maxId]));
  const recent = newest.filter(m => !seen.has(m.id)).slice(0, 10 - relevant.length);
  return { relevant, recent, mode };
}

/** What the block would hold, without touching anything: for experiments and for looking. */
export function memoryContextPreview(agentId, taskText, mode = null, { maxId = null } = {}) {
  const c = pickContext(agentId, taskText, mode ? { mode, maxId } : undefined);
  return { mode: c.mode, aboutTask: c.relevant.length, shown: c.relevant.length + c.recent.length, ids: [...c.relevant, ...c.recent].map(m => m.id) };
}

export function buildPromptContext(agentId, taskText) {
  const { relevant, recent } = pickContext(agentId, taskText);
  const up = db.prepare(`UPDATE agent_memories SET access_count = access_count + 1 WHERE id = ?`);
  for (const m of [...relevant, ...recent]) up.run(m.id);
  const memories = [...relevant, ...recent];
  if (memories.length === 0) return '';

  const line = m => `- [${m.category}] ${m.key}: ${String(m.value).slice(0, 300)}${m.verified_at ? ' [verified]' : ' [unverified]'}`;
  const body = relevant.length
    ? `About this task (${relevant.length}):\n${relevant.map(line).join('\n')}${recent.length ? `\nMost recent (${recent.length}):\n${recent.map(line).join('\n')}` : ''}`
    : memories.map(line).join('\n');
  return `\n--- Agent Memory (${memories.length} entries) ---\n${body}\n--- End Memory ---\n`;
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
