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

router.get('/api/evolution-log', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const type = req.query.type || null;
  const events = [];

  if (!type || type === 'reflection') {
    safe('SELECT id, trigger, input_summary, actions_taken, insights, duration_ms, created_at FROM reflections ORDER BY created_at DESC LIMIT 200')
      .forEach(r => events.push({
        id: `ref-${r.id}`, type: 'reflection', trigger: r.trigger,
        summary: r.input_summary, detail: r.actions_taken,
        insights: r.insights, duration_ms: r.duration_ms,
        timestamp: r.created_at
      }));
  }

  if (!type || type === 'verification') {
    safe('SELECT id, goal, language, max_iterations, iterations_used, status, error, created_at, completed_at FROM verification_loops ORDER BY created_at DESC LIMIT 200')
      .forEach(r => events.push({
        id: `vloop-${r.id}`, type: 'verification', status: r.status,
        summary: r.goal, detail: `${r.language} · ${r.iterations_used}/${r.max_iterations} iterations`,
        language: r.language, iterations: r.iterations_used, maxIterations: r.max_iterations,
        error: r.error, duration_ms: r.completed_at && r.created_at ? r.completed_at - r.created_at : null,
        timestamp: r.created_at
      }));
  }

  if (!type || type === 'daemon') {
    safe('SELECT id, type, input_summary, output, duration_ms, created_at FROM daemon_cycles ORDER BY created_at DESC LIMIT 200')
      .forEach(r => events.push({
        id: `daemon-${r.id}`, type: 'daemon', subtype: r.type,
        summary: r.input_summary || r.type,
        detail: (r.output || '').slice(0, 200),
        duration_ms: r.duration_ms, timestamp: r.created_at
      }));
  }

  if (!type || type === 'forge') {
    safe(`SELECT fa.id, fa.agent_id, fa.goal, fa.forged_by, fa.created_at, fa.context
          FROM forged_agents fa ORDER BY fa.created_at DESC LIMIT 200`)
      .forEach(r => events.push({
        id: `forge-${r.id}`, type: 'forge', agentId: r.agent_id,
        summary: r.goal, detail: `Forged by ${r.forged_by}`,
        context: r.context, timestamp: r.created_at
      }));
  }

  if (!type || type === 'synthesis') {
    safe(`SELECT id, workflow_id, goal, node_count, synthesized_by, created_at
          FROM synthesized_workflows ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => events.push({
        id: `synth-${r.id}`, type: 'synthesis', workflowId: r.workflow_id,
        summary: r.goal, detail: `${r.node_count} nodes · by ${r.synthesized_by}`,
        nodeCount: r.node_count, timestamp: r.created_at
      }));
  }

  events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json({ events: events.slice(0, limit), total: events.length });
});

router.get('/api/evolution-log/stats', (_req, res) => {
  const reflections = safeOne('SELECT COUNT(*) as c FROM reflections').c || 0;
  const verifications = safeOne('SELECT COUNT(*) as c FROM verification_loops').c || 0;
  const daemon = safeOne('SELECT COUNT(*) as c FROM daemon_cycles').c || 0;
  const forged = safeOne('SELECT COUNT(*) as c FROM forged_agents').c || 0;
  const synthesized = safeOne('SELECT COUNT(*) as c FROM synthesized_workflows').c || 0;
  const total = reflections + verifications + daemon + forged + synthesized;

  const successRate = (() => {
    const v = safeOne('SELECT COUNT(*) as total, SUM(CASE WHEN status = \'completed\' THEN 1 ELSE 0 END) as ok FROM verification_loops');
    return v.total > 0 ? Math.round((v.ok / v.total) * 100) : 0;
  })();

  const avgReflectionMs = safeOne('SELECT AVG(duration_ms) as avg FROM reflections').avg || 0;

  res.json({ total, reflections, verifications, daemon, forged, synthesized, successRate, avgReflectionMs: Math.round(avgReflectionMs) });
});

router.get('/api/evolution-log/verification/:id/steps', (req, res) => {
  const loopId = req.params.id;
  const steps = safe('SELECT id, iteration, role, input, output, verdict, created_at FROM verification_steps WHERE loop_id = ? ORDER BY iteration, id', [loopId]);
  res.json({ steps });
});

export default router;
