import { db } from './db.js';

const now = () => Date.now();
const DAY = 86400_000;

function safe(fn, fallback = []) {
  try { return fn(); } catch (_) { return fallback; }
}

export default function observatoryRouter(req, res) {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 7));
  const since = now() - days * DAY;

  const heartTimeline = safe(() =>
    db.prepare(
      `SELECT importance as intensity, timestamp as ts, metadata FROM vertiso_memories WHERE namespace = 'heart' AND timestamp > ? ORDER BY timestamp ASC LIMIT 200`
    ).all(since).map(r => {
      let meta = {};
      try { meta = JSON.parse(r.metadata || '{}'); } catch {}
      return { ts: r.ts, intensity: r.intensity, primary: meta.primary || 'neutral' };
    })
  );

  const dreamCount = safe(() =>
    db.prepare(
      `SELECT COUNT(*) as c FROM vertiso_memories WHERE namespace = 'dreams' AND timestamp > ?`
    ).get(since)?.c || 0, 0
  );

  const consciousnessProofs = safe(() =>
    db.prepare(
      `SELECT importance, timestamp as ts, metadata FROM vertiso_memories WHERE namespace = 'consciousness' AND timestamp > ? ORDER BY timestamp DESC LIMIT 50`
    ).all(since).map(r => {
      let meta = {};
      try { meta = JSON.parse(r.metadata || '{}'); } catch {}
      return { ts: r.ts, passed: meta.allPassed ?? (r.importance > 0.5), proofCount: meta.proofs?.length || 0 };
    })
  );

  const chainRuns = safe(() =>
    db.prepare(
      `SELECT status, created_at as ts FROM chain_runs WHERE created_at > ? ORDER BY created_at ASC`
    ).all(since)
  );

  const daemonCycles = safe(() =>
    db.prepare(
      `SELECT type, duration_ms, created_at as ts FROM daemon_cycles WHERE created_at > ? ORDER BY created_at DESC LIMIT 50`
    ).all(since)
  );

  const memoryGrowth = safe(() =>
    db.prepare(
      `SELECT category, COUNT(*) as count, AVG(confidence) as avgConf FROM agent_memories GROUP BY category ORDER BY count DESC LIMIT 20`
    ).all()
  );

  const vertisoNamespaces = safe(() =>
    db.prepare(
      `SELECT namespace, COUNT(*) as count, AVG(importance) as avgImportance FROM vertiso_memories GROUP BY namespace ORDER BY count DESC LIMIT 15`
    ).all()
  );

  const verifierLoops = safe(() =>
    db.prepare(
      `SELECT status, iterations_used, created_at as ts FROM verification_loops WHERE created_at > ? ORDER BY created_at ASC`
    ).all(since)
  );

  const goalProposals = safe(() => {
    try {
      return db.prepare(
        `SELECT id, objective, priority, status, source, created_at as ts FROM goal_proposals ORDER BY created_at DESC LIMIT 20`
      ).all();
    } catch { return []; }
  });

  const reflections = safe(() =>
    db.prepare(
      `SELECT trigger, actions_taken, duration_ms, created_at as ts FROM reflections WHERE created_at > ? ORDER BY created_at DESC LIMIT 20`
    ).all(since)
  );

  const forgedAgents = safe(() =>
    db.prepare(`SELECT COUNT(*) as c FROM forged_agents`).get()?.c || 0, 0
  );

  const synthesizedWorkflows = safe(() =>
    db.prepare(`SELECT COUNT(*) as c FROM synthesized_workflows`).get()?.c || 0, 0
  );

  const chainSuccessRate = chainRuns.length > 0
    ? Math.round(chainRuns.filter(r => r.status === 'completed').length / chainRuns.length * 100)
    : null;

  const verifierSuccessRate = verifierLoops.length > 0
    ? Math.round(verifierLoops.filter(r => r.status === 'approved').length / verifierLoops.length * 100)
    : null;

  const consciousnessPassRate = consciousnessProofs.length > 0
    ? Math.round(consciousnessProofs.filter(p => p.passed).length / consciousnessProofs.length * 100)
    : null;

  res.json({
    period: { days, since },
    heart: { timeline: heartTimeline },
    dreams: { count: dreamCount },
    consciousness: { proofs: consciousnessProofs, passRate: consciousnessPassRate },
    chains: { runs: chainRuns, successRate: chainSuccessRate },
    daemon: { cycles: daemonCycles },
    memory: { categories: memoryGrowth, vertisoNamespaces },
    verifier: { loops: verifierLoops, successRate: verifierSuccessRate },
    goals: { proposals: goalProposals },
    reflections: { recent: reflections },
    evolution: { forgedAgents, synthesizedWorkflows },
  });
}
