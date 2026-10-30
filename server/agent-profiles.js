import { Router } from 'express';
import { db } from './db.js';
import { listAgents } from './fleet/runtime.js';

const router = Router();

function safe(sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch { return []; }
}

function safeGet(sql, params = []) {
  try { return db.prepare(sql).get(...params); }
  catch { return null; }
}

function getProfiles() {
  const agents = listAgents('local').map(({ systemPrompt, ...a }) => a);

  const runCounts = safe(
    `SELECT t.agent_id, COUNT(r.id) as run_count,
       SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) as success,
       SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) as failed,
       MAX(r.created_at) as last_run
     FROM threads t JOIN runs r ON r.thread_id = t.id
     GROUP BY t.agent_id`
  );
  const runMap = Object.fromEntries(runCounts.map(r => [r.agent_id, r]));

  const threadCounts = safe(
    `SELECT agent_id, COUNT(*) as thread_count FROM threads GROUP BY agent_id`
  );
  const threadMap = Object.fromEntries(threadCounts.map(t => [t.agent_id, t.thread_count]));

  const busSent = safe(
    `SELECT from_agent, COUNT(*) as sent FROM bus_messages GROUP BY from_agent`
  );
  const busMap = Object.fromEntries(busSent.map(b => [b.from_agent, b.sent]));

  const busReceived = safe(
    `SELECT to_agent, COUNT(*) as received FROM bus_messages WHERE to_agent IS NOT NULL GROUP BY to_agent`
  );
  const busRecvMap = Object.fromEntries(busReceived.map(b => [b.to_agent, b.received]));

  const memoryCounts = safe(
    `SELECT agent_id, COUNT(*) as mem_count,
       AVG(confidence) as avg_confidence
     FROM agent_memories GROUP BY agent_id`
  );
  const memMap = Object.fromEntries(memoryCounts.map(m => [m.agent_id, m]));

  return agents.map(agent => {
    const runs = runMap[agent.id] || { run_count: 0, success: 0, failed: 0, last_run: null };
    const mems = memMap[agent.id] || { mem_count: 0, avg_confidence: 0 };
    return {
      ...agent,
      stats: {
        runs: runs.run_count,
        success: runs.success,
        failed: runs.failed,
        successRate: runs.run_count > 0 ? Math.round((runs.success / runs.run_count) * 100) : null,
        lastRun: runs.last_run,
        threads: threadMap[agent.id] || 0,
        busSent: busMap[agent.id] || 0,
        busReceived: busRecvMap[agent.id] || 0,
        memories: mems.mem_count,
        avgConfidence: mems.avg_confidence ? Math.round(mems.avg_confidence * 100) : null,
      },
    };
  });
}

function getProfile(id) {
  const profiles = getProfiles();
  return profiles.find(p => p.id === id) || null;
}

router.get('/api/agent-profiles', (_req, res) => {
  try {
    res.json({ profiles: getProfiles() });
  } catch (err) {
    console.error('[agent-profiles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/agent-profiles/:id', (req, res) => {
  try {
    const profile = getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Agent not found' });
    res.json(profile);
  } catch (err) {
    console.error('[agent-profiles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
