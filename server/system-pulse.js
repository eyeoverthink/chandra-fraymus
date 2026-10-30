import { Router } from 'express';
import { db } from './db.js';

const router = Router();
const now = () => Date.now();

function safe(sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch { return []; }
}
function safeOne(sql, params = []) {
  try { return db.prepare(sql).get(...params) || {}; }
  catch { return {}; }
}

router.get('/api/system-pulse', (_req, res) => {
  const ts = now();
  const hour = ts - 3600000;
  const day = ts - 86400000;
  const week = ts - 604800000;

  // Agent fleet
  const totalAgents = safeOne('SELECT COUNT(*) as c FROM agents').c || 0;
  const forgedAgents = safe("SELECT id, goal, model, created_at FROM forged_agents ORDER BY created_at DESC LIMIT 3");
  const agentMemories = safeOne('SELECT COUNT(*) as c FROM agent_memories').c || 0;

  // Bus activity
  const busTotal = safeOne('SELECT COUNT(*) as c FROM bus_messages').c || 0;
  const busToday = safeOne('SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?', [day]).c || 0;
  const busHour = safeOne('SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?', [hour]).c || 0;
  const busTopics = safeOne('SELECT COUNT(DISTINCT topic) as c FROM bus_messages WHERE topic != ?', ['dm']).c || 0;
  const busSubs = safeOne('SELECT COUNT(*) as c FROM bus_subscriptions').c || 0;

  // Runs (across all 7 tables)
  const runTables = [
    { table: 'runs', type: 'agent' },
    { table: 'workflow_runs', type: 'workflow' },
    { table: 'automation_runs', type: 'automation' },
    { table: 'commerce_pipeline_runs', type: 'commerce' },
    { table: 'apparel_pipeline_runs', type: 'apparel' },
    { table: 'mystery_shopper_runs', type: 'mystery-shopper' },
    { table: 'store_fixer_runs', type: 'store-fixer' },
  ];
  let totalRuns = 0, runsToday = 0;
  const runsByType = {};
  for (const { table, type } of runTables) {
    const t = safeOne(`SELECT COUNT(*) as c FROM ${table}`).c || 0;
    const td = safeOne(`SELECT COUNT(*) as c FROM ${table} WHERE created_at > ?`, [day]).c || 0;
    totalRuns += t;
    runsToday += td;
    if (t > 0) runsByType[type] = { total: t, today: td };
  }

  // Evolution / autonomy
  const reflections = safeOne('SELECT COUNT(*) as c FROM reflections').c || 0;
  const reflectionsWeek = safeOne('SELECT COUNT(*) as c FROM reflections WHERE created_at > ?', [week]).c || 0;
  const verifications = safeOne('SELECT COUNT(*) as c FROM verification_loops').c || 0;
  const daemonCycles = safeOne('SELECT COUNT(*) as c FROM daemon_cycles').c || 0;
  const forgeCount = safeOne('SELECT COUNT(*) as c FROM forged_agents').c || 0;
  const synthCount = safeOne('SELECT COUNT(*) as c FROM synthesized_workflows').c || 0;

  // Vertiso memory
  const vertisoMems = safeOne('SELECT COUNT(*) as c FROM vertiso_memories').c || 0;
  const rsiEvals = safeOne('SELECT COUNT(*) as c FROM rsi_evaluations').c || 0;
  const rsiGens = safeOne('SELECT COUNT(*) as c FROM rsi_generations').c || 0;

  // Workflows
  const workflows = safeOne('SELECT COUNT(*) as c FROM workflows').c || 0;

  // Health metrics (sparkline: last 12 data points at 5-min intervals)
  const healthSparkline = safe(
    `SELECT value, recorded_at FROM health_metrics
     WHERE metric = 'cpu_usage' ORDER BY recorded_at DESC LIMIT 12`
  ).reverse().map(r => r.value);

  // FRAYMUS entities
  const entities = safeOne('SELECT COUNT(*) as c FROM fraymus_entities').c || 0;

  // Events (recent 5)
  const recentEvents = safe(
    `SELECT type, summary, created_at FROM events ORDER BY created_at DESC LIMIT 5`
  );

  // Commerce pipeline summary
  const commerceRuns = safe(
    `SELECT status, COUNT(*) as c FROM commerce_pipeline_runs GROUP BY status`
  );
  const apparelRuns = safe(
    `SELECT status, COUNT(*) as c FROM apparel_pipeline_runs GROUP BY status`
  );

  // Uptime (first health metric as proxy)
  const firstMetric = safeOne('SELECT MIN(recorded_at) as t FROM health_metrics');
  const uptimeMs = firstMetric.t ? ts - firstMetric.t : 0;

  res.json({
    timestamp: ts,
    uptime: uptimeMs,
    fleet: { agents: totalAgents, forged: forgeCount, memories: agentMemories, recentForges: forgedAgents },
    bus: { total: busTotal, today: busToday, hour: busHour, topics: busTopics, subscriptions: busSubs },
    runs: { total: totalRuns, today: runsToday, byType: runsByType },
    evolution: { reflections, reflectionsWeek, verifications, daemonCycles, forged: forgeCount, synthesized: synthCount },
    vertiso: { memories: vertisoMems, rsiEvals, rsiGens },
    workflows,
    entities,
    healthSparkline,
    recentEvents,
    commerce: {
      pipeline: commerceRuns.reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {}),
      apparel: apparelRuns.reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {}),
    },
  });
});

export default router;
