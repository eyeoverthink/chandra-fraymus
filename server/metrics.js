import { Router } from 'express';
import { db } from './db.js';

const router = Router();

function safe(sql) {
  try { return db.prepare(sql).all(); }
  catch { return []; }
}

function safeGet(sql) {
  try { return db.prepare(sql).get(); }
  catch { return null; }
}

function getMetrics() {
  const now = Date.now();
  const h24 = now - 86_400_000;
  const d7 = now - 7 * 86_400_000;

  const totalRuns = safeGet(`SELECT COUNT(*) as c FROM runs`) || { c: 0 };
  const runs24h = safeGet(`SELECT COUNT(*) as c FROM runs WHERE created_at > ${h24}`) || { c: 0 };
  const runsSuccess = safeGet(`SELECT COUNT(*) as c FROM runs WHERE status = 'completed'`) || { c: 0 };
  const runsFailed = safeGet(`SELECT COUNT(*) as c FROM runs WHERE status = 'failed'`) || { c: 0 };

  const totalWorkflows = safeGet(`SELECT COUNT(*) as c FROM workflow_runs`) || { c: 0 };
  const wf24h = safeGet(`SELECT COUNT(*) as c FROM workflow_runs WHERE created_at > ${h24}`) || { c: 0 };

  const totalBus = safeGet(`SELECT COUNT(*) as c FROM bus_messages`) || { c: 0 };
  const bus24h = safeGet(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ${h24}`) || { c: 0 };

  const totalAlerts = safeGet(`SELECT COUNT(*) as c FROM health_alerts`) || { c: 0 };
  const unresolvedAlerts = safeGet(`SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0`) || { c: 0 };

  const totalReflections = safeGet(`SELECT COUNT(*) as c FROM reflections`) || { c: 0 };
  const totalForged = safeGet(`SELECT COUNT(*) as c FROM forged_agents`) || { c: 0 };
  const totalSynthesized = safeGet(`SELECT COUNT(*) as c FROM synthesized_workflows`) || { c: 0 };

  const totalCommerce = safeGet(`SELECT COUNT(*) as c FROM commerce_pipeline_runs`) || { c: 0 };
  const totalApparel = safeGet(`SELECT COUNT(*) as c FROM apparel_pipeline_runs`) || { c: 0 };
  const totalMystery = safeGet(`SELECT COUNT(*) as c FROM mystery_shopper_runs`) || { c: 0 };
  const totalFixer = safeGet(`SELECT COUNT(*) as c FROM store_fixer_runs`) || { c: 0 };

  const topAgents = safe(
    `SELECT m.agent_id, COUNT(*) as run_count
     FROM threads m
     JOIN runs r ON r.thread_id = m.id
     GROUP BY m.agent_id ORDER BY run_count DESC LIMIT 5`
  );

  const topBusTopics = safe(
    `SELECT topic, COUNT(*) as msg_count
     FROM bus_messages
     GROUP BY topic ORDER BY msg_count DESC LIMIT 5`
  );

  const runsByStatus = safe(
    `SELECT status, COUNT(*) as c FROM runs GROUP BY status ORDER BY c DESC`
  );

  const recentActivity = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = now - (i + 1) * 86_400_000;
    const dayEnd = now - i * 86_400_000;
    const label = new Date(dayEnd).toLocaleDateString('en-US', { weekday: 'short' });
    const runs = safeGet(`SELECT COUNT(*) as c FROM runs WHERE created_at > ${dayStart} AND created_at <= ${dayEnd}`) || { c: 0 };
    const bus = safeGet(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ${dayStart} AND created_at <= ${dayEnd}`) || { c: 0 };
    recentActivity.push({ label, runs: runs.c, bus: bus.c });
  }

  return {
    overview: {
      totalRuns: totalRuns.c,
      runs24h: runs24h.c,
      successRate: totalRuns.c > 0 ? Math.round((runsSuccess.c / totalRuns.c) * 100) : 0,
      failedRuns: runsFailed.c,
      totalWorkflows: totalWorkflows.c,
      workflows24h: wf24h.c,
      totalBusMessages: totalBus.c,
      busMessages24h: bus24h.c,
      totalAlerts: totalAlerts.c,
      unresolvedAlerts: unresolvedAlerts.c,
      totalReflections: totalReflections.c,
      totalForgedAgents: totalForged.c,
      totalSynthesizedWorkflows: totalSynthesized.c,
      commercePipelines: totalCommerce.c,
      apparelPipelines: totalApparel.c,
      mysteryShopperRuns: totalMystery.c,
      storeFixerRuns: totalFixer.c,
    },
    topAgents,
    topBusTopics,
    runsByStatus,
    recentActivity,
  };
}

router.get('/api/metrics', (_req, res) => {
  try {
    const metrics = getMetrics();
    res.json(metrics);
  } catch (err) {
    console.error('[metrics]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
