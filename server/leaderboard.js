import { Router } from 'express';
import { db } from './db.js';

const router = Router();

function safe(sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch { return []; }
}

function safeOne(sql, params = []) {
  try { return db.prepare(sql).get(...params) || {}; }
  catch { return {}; }
}

router.get('/api/leaderboard', (req, res, next) => {
  try {
    const agents = safe(`SELECT id, name FROM agents ORDER BY name`);
    const agentMap = new Map(agents.map(a => [a.id, a.name]));

    const runsByAgent = safe(`SELECT model, status, COUNT(*) as c FROM runs GROUP BY model, status`);
    const busByAgent = safe(`SELECT from_agent, COUNT(*) as c FROM bus_messages GROUP BY from_agent ORDER BY c DESC`);
    const memoriesByAgent = safe(`SELECT agent_id, COUNT(*) as c, ROUND(AVG(confidence), 2) as avgConf FROM agent_memories GROUP BY agent_id`);
    const forgedByAgent = safe(`SELECT forged_by, COUNT(*) as c FROM forged_agents GROUP BY forged_by`);
    const forgedAgents = safe(`SELECT agent_id, forged_by, goal, created_at FROM forged_agents ORDER BY created_at DESC`);

    const workflowRuns = safe(`SELECT status, COUNT(*) as c FROM workflow_runs GROUP BY status`);
    const commerceRuns = safe(`SELECT status, COUNT(*) as c FROM commerce_pipeline_runs GROUP BY status`);
    const apparelRuns = safe(`SELECT status, COUNT(*) as c FROM apparel_pipeline_runs GROUP BY status`);

    const scores = new Map();

    function ensure(id) {
      if (!scores.has(id)) {
        scores.set(id, {
          id,
          name: agentMap.get(id) || id,
          runs: 0, successes: 0, failures: 0,
          busMessages: 0,
          memories: 0, avgConfidence: 0,
          forged: 0,
          score: 0,
        });
      }
      return scores.get(id);
    }

    for (const r of runsByAgent) {
      const agentId = (r.model || '').split(':')[0];
      if (!agentId) continue;
      const entry = ensure(agentId);
      entry.runs += r.c;
      if (r.status === 'done' || r.status === 'success') entry.successes += r.c;
      if (r.status === 'error' || r.status === 'failed') entry.failures += r.c;
    }

    for (const b of busByAgent) {
      if (!b.from_agent) continue;
      const entry = ensure(b.from_agent);
      entry.busMessages += b.c;
    }

    for (const m of memoriesByAgent) {
      if (!m.agent_id) continue;
      const entry = ensure(m.agent_id);
      entry.memories += m.c;
      entry.avgConfidence = m.avgConf || 0;
    }

    for (const f of forgedByAgent) {
      if (!f.forged_by) continue;
      const entry = ensure(f.forged_by);
      entry.forged += f.c;
    }

    for (const [, entry] of scores) {
      entry.score =
        (entry.runs * 10) +
        (entry.successes * 5) +
        (entry.busMessages * 2) +
        (entry.memories * 3) +
        (entry.forged * 20) +
        Math.round(entry.avgConfidence * 10);
    }

    const ranked = [...scores.values()]
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score);

    ranked.forEach((entry, i) => { entry.rank = i + 1; });

    const totalRuns = ranked.reduce((s, e) => s + e.runs, 0);
    const totalBus = ranked.reduce((s, e) => s + e.busMessages, 0);
    const totalMemories = ranked.reduce((s, e) => s + e.memories, 0);
    const totalForged = forgedAgents.length;

    const topRunner = ranked.reduce((best, e) => e.runs > (best?.runs || 0) ? e : best, null);
    const topCommunicator = ranked.reduce((best, e) => e.busMessages > (best?.busMessages || 0) ? e : best, null);
    const topScholar = ranked.reduce((best, e) => e.memories > (best?.memories || 0) ? e : best, null);
    const topForger = ranked.reduce((best, e) => e.forged > (best?.forged || 0) ? e : best, null);

    res.json({
      leaderboard: ranked,
      totals: { agents: agents.length, runs: totalRuns, busMessages: totalBus, memories: totalMemories, forged: totalForged },
      titles: {
        runner: topRunner ? { id: topRunner.id, name: topRunner.name, value: topRunner.runs } : null,
        communicator: topCommunicator ? { id: topCommunicator.id, name: topCommunicator.name, value: topCommunicator.busMessages } : null,
        scholar: topScholar ? { id: topScholar.id, name: topScholar.name, value: topScholar.memories } : null,
        forger: topForger ? { id: topForger.id, name: topForger.name, value: topForger.forged } : null,
      },
      forgeLineage: forgedAgents.map(f => ({ id: f.agent_id, by: f.forged_by, goal: f.goal, at: f.created_at })),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
