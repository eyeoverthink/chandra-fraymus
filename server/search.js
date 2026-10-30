import { Router } from 'express';

export function installSearchRoutes(app, { db }) {
  const router = Router();

  router.get('/api/search', (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q || q.length < 2) return res.json({ results: [], query: q });

      const like = `%${q}%`;
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
      const results = [];

      // 1. Agents (DB table)
      const agentRows = db.prepare(
        `SELECT id, name, status FROM agents WHERE name LIKE ? OR id LIKE ? LIMIT ?`
      ).all(like, like, limit);
      for (const r of agentRows) {
        results.push({ category: 'agents', id: r.id, title: r.name || r.id, subtitle: r.status || 'agent', panel: 'fleet' });
      }

      // 2. Workflows
      const wfRows = db.prepare(
        `SELECT id, name FROM workflows WHERE name LIKE ? LIMIT ?`
      ).all(like, limit);
      for (const r of wfRows) {
        results.push({ category: 'workflows', id: r.id, title: r.name, subtitle: 'Workflow', panel: 'canvas' });
      }

      // 3. Agent memories
      const memRows = db.prepare(
        `SELECT agent_id, category, key, value FROM agent_memories WHERE key LIKE ? OR value LIKE ? ORDER BY updated_at DESC LIMIT ?`
      ).all(like, like, limit);
      for (const r of memRows) {
        results.push({ category: 'memories', id: `${r.agent_id}:${r.key}`, title: r.key, subtitle: `${r.agent_id} / ${r.category}`, panel: 'vertiso' });
      }

      // 4. Bus messages
      const busRows = db.prepare(
        `SELECT id, topic, payload FROM bus_messages WHERE topic LIKE ? OR payload LIKE ? ORDER BY created_at DESC LIMIT ?`
      ).all(like, like, limit);
      for (const r of busRows) {
        let preview = '';
        try { preview = JSON.parse(r.payload); preview = typeof preview === 'object' ? Object.values(preview).join(' ').slice(0, 60) : String(preview).slice(0, 60); } catch { preview = String(r.payload).slice(0, 60); }
        results.push({ category: 'bus', id: String(r.id), title: r.topic, subtitle: preview, panel: 'bus' });
      }

      // 5. Commerce runs
      const comRows = db.prepare(
        `SELECT id, topic, status FROM commerce_pipeline_runs WHERE topic LIKE ? OR status LIKE ? ORDER BY created_at DESC LIMIT ?`
      ).all(like, like, limit);
      for (const r of comRows) {
        results.push({ category: 'commerce', id: r.id, title: `Commerce: ${r.topic}`, subtitle: r.status, panel: 'commerce' });
      }

      // 6. Threads
      const thrRows = db.prepare(
        `SELECT id, agent_id, title FROM threads WHERE title LIKE ? OR agent_id LIKE ? ORDER BY updated_at DESC LIMIT ?`
      ).all(like, like, limit);
      for (const r of thrRows) {
        results.push({ category: 'threads', id: r.id, title: r.title || 'Untitled', subtitle: r.agent_id, panel: 'fleet' });
      }

      // 7. Reflections
      const refRows = db.prepare(
        `SELECT id, trigger, insights FROM reflections WHERE insights LIKE ? ORDER BY created_at DESC LIMIT ?`
      ).all(like, limit);
      for (const r of refRows) {
        results.push({ category: 'reflections', id: String(r.id), title: `Reflection (${r.trigger})`, subtitle: String(r.insights).slice(0, 60), panel: 'health' });
      }

      // 8. Forged agents
      const forgeRows = db.prepare(
        `SELECT agent_id, goal FROM forged_agents WHERE agent_id LIKE ? OR goal LIKE ? ORDER BY created_at DESC LIMIT ?`
      ).all(like, like, limit);
      for (const r of forgeRows) {
        results.push({ category: 'forged', id: r.agent_id, title: r.agent_id, subtitle: String(r.goal).slice(0, 60), panel: 'forge' });
      }

      res.json({ results: results.slice(0, 50), query: q, total: results.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.use(router);
}
