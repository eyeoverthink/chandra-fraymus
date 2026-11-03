import { Router } from 'express';
import { db } from './db.js';

const router = Router();

function safeTs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (!Number.isNaN(n) && n > 1e12) return n;
  const d = Date.parse(v);
  return Number.isNaN(d) ? 0 : d;
}

function query(sql, limit) {
  try { return db.prepare(sql).all({ limit }); }
  catch { return []; }
}

function getEvents(limit = 20) {
  const perTable = Math.max(limit, 50);

  const agentRuns = query(
    `SELECT id, thread_id, status, provider, model, created_at
     FROM runs ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `run-${r.id}`, type: 'agent-run', category: 'agent',
    title: `Agent run${r.model ? ' (' + r.model + ')' : ''}`,
    detail: `Status: ${r.status || 'unknown'}`,
    status: r.status || 'unknown',
    timestamp: safeTs(r.created_at),
  }));

  const workflowRuns = query(
    `SELECT id, workflow_id, status, input_prompt, duration_ms, created_at
     FROM workflow_runs ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `wf-${r.id}`, type: 'workflow-run', category: 'workflow',
    title: `Workflow ${r.workflow_id || 'run'}`,
    detail: r.input_prompt ? r.input_prompt.slice(0, 120) : `Status: ${r.status}`,
    status: r.status || 'unknown',
    timestamp: safeTs(r.created_at),
  }));

  const automationRuns = query(
    `SELECT id, automation_id, trigger_type, status, started_at
     FROM automation_runs ORDER BY started_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `auto-${r.id}`, type: 'automation-run', category: 'workflow',
    title: `Automation ${r.automation_id || 'run'}`,
    detail: `Trigger: ${r.trigger_type || 'cron'} — ${r.status || 'unknown'}`,
    status: r.status || 'unknown',
    timestamp: safeTs(r.started_at),
  }));

  const commerceRuns = query(
    `SELECT id, topic, content_type, status, created_at
     FROM commerce_pipeline_runs ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `comm-${r.id}`, type: 'commerce-pipeline', category: 'commerce',
    title: `Commerce: ${r.topic || 'pipeline'}`,
    detail: `Type: ${r.content_type} — ${r.status}`,
    status: r.status || 'unknown',
    timestamp: safeTs(r.created_at),
  }));

  const apparelRuns = query(
    `SELECT id, niche, status, products_created, created_at
     FROM apparel_pipeline_runs ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `aprl-${r.id}`, type: 'apparel-pipeline', category: 'commerce',
    title: `Apparel: ${r.niche || 'design'}`,
    detail: `${r.products_created || 0} products — ${r.status}`,
    status: r.status || 'unknown',
    timestamp: safeTs(r.created_at),
  }));

  const mysteryRuns = query(
    `SELECT id, store_domain, overall_grade, created_at
     FROM mystery_shopper_runs ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `myst-${r.id}`, type: 'mystery-shopper', category: 'commerce',
    title: `Mystery Shopper: ${r.store_domain || 'audit'}`,
    detail: r.overall_grade ? `Grade: ${r.overall_grade}` : 'Audit complete',
    status: r.overall_grade ? 'complete' : 'running',
    timestamp: safeTs(r.created_at),
  }));

  const fixerRuns = query(
    `SELECT id, audit_run_id, pages_generated, collections_created, apply_status, created_at
     FROM store_fixer_runs ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `fix-${r.id}`, type: 'store-fixer', category: 'commerce',
    title: 'Store Fixer run',
    detail: `${r.pages_generated || 0} pages, ${r.collections_created || 0} collections — ${r.apply_status || 'pending'}`,
    status: r.apply_status || 'pending',
    timestamp: safeTs(r.created_at),
  }));

  const busMessages = query(
    `SELECT id, from_agent, to_agent, topic, created_at
     FROM bus_messages ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `bus-${r.id}`, type: 'bus-message', category: 'bus',
    title: `${r.from_agent} → ${r.to_agent || 'broadcast'}`,
    detail: r.topic || 'message',
    status: 'delivered',
    timestamp: safeTs(r.created_at),
  }));

  const healthAlerts = query(
    `SELECT id, rule, severity, message, resolved, created_at
     FROM health_alerts ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `hlth-${r.id}`, type: 'health-alert', category: 'health',
    title: `Health: ${r.rule}`,
    detail: r.message,
    status: r.resolved ? 'resolved' : r.severity,
    timestamp: safeTs(r.created_at),
  }));

  const reflections = query(
    `SELECT id, trigger, input_summary, actions_taken, duration_ms, created_at
     FROM reflections ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `refl-${r.id}`, type: 'reflection', category: 'evolution',
    title: `Reflection (${r.trigger})`,
    detail: r.input_summary ? r.input_summary.slice(0, 120) : 'Self-analysis',
    status: 'complete',
    timestamp: safeTs(r.created_at),
  }));

  const forged = query(
    `SELECT id, agent_id, forged_by, goal, created_at
     FROM forged_agents ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `forge-${r.id}`, type: 'agent-forge', category: 'evolution',
    title: `Forged: ${r.agent_id}`,
    detail: r.goal ? r.goal.slice(0, 120) : 'New agent created',
    status: 'complete',
    timestamp: safeTs(r.created_at),
  }));

  const synthesized = query(
    `SELECT id, workflow_id, synthesized_by, goal, node_count, created_at
     FROM synthesized_workflows ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `synth-${r.id}`, type: 'workflow-synthesis', category: 'evolution',
    title: `Synthesized: ${r.workflow_id}`,
    detail: `${r.node_count} nodes — ${r.goal ? r.goal.slice(0, 100) : 'goal'}`,
    status: 'complete',
    timestamp: safeTs(r.created_at),
  }));

  const creationRuns = query(
    `SELECT id, topic, format, status, shot_count, channels, created_at
     FROM creation_pipeline_runs ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `crea-${r.id}`, type: 'creation-pipeline', category: 'creation',
    title: `Creation: ${r.topic || 'pipeline'}`,
    detail: `${r.format || 'short_video'} — ${r.shot_count || 0} shots — ${r.status}`,
    status: r.status || 'unknown',
    timestamp: safeTs(r.created_at),
  }));

  const distributionRuns = query(
    `SELECT id, platform, status, content_topic, published_url, created_at
     FROM distribution_runs ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `dist-${r.id}`, type: 'distribution', category: 'distribution',
    title: `Distribute: ${r.platform || 'social'}`,
    detail: `${r.content_topic || 'content'} — ${r.status}`,
    status: r.status || 'unknown',
    timestamp: safeTs(r.created_at),
  }));

  const analyticsEntries = query(
    `SELECT id, platform, content_topic, views, engagement_rate, collected_at
     FROM content_analytics ORDER BY collected_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `anl-${r.id}`, type: 'analytics', category: 'analytics',
    title: `Analytics: ${r.platform || 'metrics'}`,
    detail: `${r.content_topic || 'content'} — ${r.views || 0} views, ${(r.engagement_rate || 0).toFixed(1)}% eng`,
    status: 'collected',
    timestamp: safeTs(r.collected_at),
  }));

  const revenueEvents = query(
    `SELECT id, order_id, order_total, source_content_topic, source_platform, attribution_confidence, attribution_method, attributed_at
     FROM revenue_attributions ORDER BY attributed_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `rev-${r.id}`, type: 'revenue-attribution', category: 'revenue',
    title: `Revenue: $${(r.order_total || 0).toFixed(2)}`,
    detail: `${r.source_content_topic || 'unknown'} via ${r.source_platform || 'unknown'} (${r.attribution_method}, ${((r.attribution_confidence || 0) * 100).toFixed(0)}%)`,
    status: 'attributed',
    timestamp: safeTs(r.attributed_at),
  }));

  const calendarEvents = query(
    `SELECT id, topic, format, platforms, scheduled_at, status, priority, source, reasoning, created_at
     FROM smart_calendar ORDER BY scheduled_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `cal-${r.id}`, type: 'calendar-item', category: 'calendar',
    title: `Calendar: ${r.topic || 'scheduled'}`,
    detail: `${r.format || 'content'} — ${r.source || 'manual'} — ${r.status}`,
    status: r.status || 'scheduled',
    timestamp: safeTs(r.scheduled_at || r.created_at),
  }));

  const abExperiments = query(
    `SELECT id, name, hypothesis, dimension, variant_a, variant_b, status, winner, confidence, created_at, concluded_at
     FROM ab_experiments ORDER BY created_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `ab-${r.id}`, type: 'ab-experiment', category: 'ab-testing',
    title: `Experiment: ${r.name || 'unnamed'}`,
    detail: `${r.dimension || 'general'}: ${(r.variant_a || 'A').slice(0, 25)} vs ${(r.variant_b || 'B').slice(0, 25)}${r.winner ? ` — winner: ${r.winner}` : ''}`,
    status: r.status || 'running',
    timestamp: safeTs(r.concluded_at || r.created_at),
  }));

  const trendSignals = query(
    `SELECT id, topic, source, category, relevance_score, velocity, status, first_seen_at, last_seen_at
     FROM trend_signals WHERE status IN ('emerging', 'trending', 'peaked') ORDER BY last_seen_at DESC LIMIT :limit`, perTable
  ).map(r => ({
    id: `trend-${r.id}`, type: 'trend-signal', category: 'trend-radar',
    title: `Trend: ${r.topic || 'unknown'}`,
    detail: `${r.category || 'general'} — relevance ${((r.relevance_score || 0) * 100).toFixed(0)}% — velocity ${((r.velocity || 0) * 100).toFixed(0)}%`,
    status: r.status || 'emerging',
    timestamp: safeTs(r.last_seen_at || r.first_seen_at),
  }));

  const all = [
    ...agentRuns, ...workflowRuns, ...automationRuns,
    ...commerceRuns, ...apparelRuns, ...mysteryRuns, ...fixerRuns,
    ...creationRuns, ...distributionRuns, ...analyticsEntries,
    ...revenueEvents, ...calendarEvents, ...abExperiments, ...trendSignals,
    ...busMessages, ...healthAlerts, ...reflections,
    ...forged, ...synthesized,
  ];

  all.sort((a, b) => b.timestamp - a.timestamp);
  return all.slice(0, limit);
}

router.get('/api/timeline', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const category = req.query.category || null;
    let events = getEvents(limit);
    if (category) events = events.filter(e => e.category === category);
    const categories = ['agent', 'workflow', 'commerce', 'creation', 'distribution', 'analytics', 'revenue', 'calendar', 'ab-testing', 'trend-radar', 'bus', 'health', 'evolution'];
    res.json({ events, categories, total: events.length });
  } catch (err) {
    console.error('[timeline]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
