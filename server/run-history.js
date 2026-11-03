import { Router } from 'express';
import { db } from './db.js';

const router = Router();

function safe(sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch { return []; }
}

function ts(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  return isNaN(n) ? new Date(v).getTime() || 0 : n > 1e12 ? n : n * 1000;
}

function getHistory({ type, status, limit = 100, offset = 0 }) {
  const rows = [];

  if (!type || type === 'agent') {
    safe(`SELECT r.id, r.status, r.provider, r.model, r.steps, r.created_at, r.error,
            t.agent_id, t.title AS thread_title
          FROM runs r LEFT JOIN threads t ON t.id = r.thread_id
          ORDER BY r.created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'agent', status: r.status || 'unknown',
        label: r.agent_id || 'unknown', detail: r.thread_title || '',
        meta: { provider: r.provider, model: r.model, steps: r.steps, error: r.error },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'workflow') {
    safe(`SELECT id, workflow_id, status, input_prompt, duration_ms, created_at
          FROM workflow_runs ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'workflow', status: r.status || 'unknown',
        label: r.workflow_id || 'workflow', detail: (r.input_prompt || '').slice(0, 120),
        meta: { duration_ms: r.duration_ms },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'automation') {
    safe(`SELECT id, automation_id, trigger_type, status, error, started_at, finished_at
          FROM automation_runs ORDER BY started_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'automation', status: r.status || 'unknown',
        label: r.automation_id || 'cron', detail: r.trigger_type || 'cron',
        meta: { error: r.error, duration_ms: r.finished_at && r.started_at ? r.finished_at - r.started_at : null },
        timestamp: ts(r.started_at || r.finished_at)
      }));
  }

  if (!type || type === 'commerce') {
    safe(`SELECT id, topic, content_type, status, score, created_at
          FROM commerce_pipeline_runs ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'commerce', status: r.status || 'unknown',
        label: r.topic || 'content', detail: r.content_type || '',
        meta: { score: r.score },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'apparel') {
    safe(`SELECT id, niche, status, products_created, created_at
          FROM apparel_pipeline_runs ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'apparel', status: r.status || 'unknown',
        label: r.niche || 'apparel', detail: `${r.products_created || 0} products`,
        meta: { products_created: r.products_created },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'mystery-shopper') {
    safe(`SELECT id, store_domain, overall_grade, created_at
          FROM mystery_shopper_runs ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'mystery-shopper', status: r.overall_grade ? 'completed' : 'unknown',
        label: r.store_domain || 'store', detail: r.overall_grade ? `Grade: ${r.overall_grade}` : '',
        meta: { grade: r.overall_grade },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'store-fixer') {
    safe(`SELECT id, pages_generated, collections_created, prices_adjusted, apply_status, created_at
          FROM store_fixer_runs ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'store-fixer', status: r.apply_status || 'unknown',
        label: 'Store Fixer', detail: `${r.pages_generated || 0}pg ${r.collections_created || 0}col ${r.prices_adjusted || 0}px`,
        meta: { pages: r.pages_generated, collections: r.collections_created, prices: r.prices_adjusted },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'creation') {
    safe(`SELECT id, topic, format, status, shot_count, channels, created_at
          FROM creation_pipeline_runs ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'creation', status: r.status || 'unknown',
        label: r.topic || 'creation', detail: r.format || 'short_video',
        meta: { shot_count: r.shot_count, channels: r.channels, format: r.format },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'distribution') {
    safe(`SELECT id, platform, status, content_topic, published_url, created_at
          FROM distribution_runs ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'distribution', status: r.status || 'unknown',
        label: r.platform || 'social', detail: r.content_topic || '',
        meta: { platform: r.platform, published_url: r.published_url },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'analytics') {
    safe(`SELECT id, platform, content_topic, views, likes, engagement_rate, collected_at
          FROM content_analytics ORDER BY collected_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'analytics', status: 'collected',
        label: r.platform || 'analytics', detail: r.content_topic || '',
        meta: { views: r.views, likes: r.likes, engagement: r.engagement_rate },
        timestamp: ts(r.collected_at)
      }));
  }

  if (!type || type === 'revenue') {
    safe(`SELECT id, order_id, order_total, source_content_topic, source_platform, attribution_confidence, attribution_method, attributed_at
          FROM revenue_attributions ORDER BY attributed_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'revenue', status: 'attributed',
        label: r.source_content_topic || 'revenue', detail: `$${(r.order_total || 0).toFixed(2)} via ${r.source_platform || 'unknown'}`,
        meta: { order_id: r.order_id, total: r.order_total, confidence: r.attribution_confidence, method: r.attribution_method },
        timestamp: ts(r.attributed_at)
      }));
  }

  if (!type || type === 'calendar') {
    safe(`SELECT id, topic, format, platforms, scheduled_at, status, priority, source, reasoning, created_at
          FROM smart_calendar ORDER BY scheduled_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'calendar', status: r.status || 'scheduled',
        label: r.topic || 'calendar', detail: `${r.format || 'content'} — ${r.source || 'manual'}`,
        meta: { format: r.format, priority: r.priority, source: r.source, reasoning: r.reasoning },
        timestamp: ts(r.scheduled_at || r.created_at)
      }));
  }

  if (!type || type === 'ab-test') {
    safe(`SELECT id, name, hypothesis, dimension, variant_a, variant_b, status, winner, confidence, created_at, concluded_at
          FROM ab_experiments ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'ab-test', status: r.status || 'running',
        label: r.name || 'experiment', detail: `${r.dimension || 'general'}: ${(r.variant_a || 'A').slice(0, 30)} vs ${(r.variant_b || 'B').slice(0, 30)}`,
        meta: { hypothesis: r.hypothesis, dimension: r.dimension, winner: r.winner, confidence: r.confidence },
        timestamp: ts(r.concluded_at || r.created_at)
      }));
  }

  if (!type || type === 'trend') {
    safe(`SELECT id, topic, source, category, relevance_score, velocity, status, first_seen_at, last_seen_at
          FROM trend_signals WHERE status IN ('emerging', 'trending', 'peaked') ORDER BY last_seen_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'trend', status: r.status || 'emerging',
        label: r.topic || 'trend', detail: `${r.category || 'general'} — relevance ${((r.relevance_score || 0) * 100).toFixed(0)}%`,
        meta: { category: r.category, relevance: r.relevance_score, velocity: r.velocity, source: r.source },
        timestamp: ts(r.last_seen_at || r.first_seen_at)
      }));
  }

  if (!type || type === 'audience') {
    safe(`SELECT id, name, description, size_estimate, engagement_avg, status, source, created_at
          FROM audience_segments ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'audience', status: r.status || 'active',
        label: r.name || 'segment', detail: `${r.source || 'manual'} — ${r.size_estimate || 0} est. size`,
        meta: { engagement: r.engagement_avg, source: r.source, description: r.description },
        timestamp: ts(r.created_at)
      }));
  }

  if (!type || type === 'repurpose') {
    safe(`SELECT id, source_format, variant_count, quality_score, status, duration_ms, created_at
          FROM repurpose_jobs ORDER BY created_at DESC LIMIT 200`)
      .forEach(r => rows.push({
        id: r.id, type: 'repurpose', status: r.status || 'pending',
        label: `${r.source_format || 'content'} repurpose`, detail: `${r.variant_count || 0} variants — quality ${((r.quality_score || 0) * 100).toFixed(0)}%`,
        meta: { sourceFormat: r.source_format, variants: r.variant_count, quality: r.quality_score, duration: r.duration_ms },
        timestamp: ts(r.created_at)
      }));
  }

  rows.sort((a, b) => b.timestamp - a.timestamp);

  if (status) {
    const filtered = rows.filter(r => r.status === status);
    return { runs: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  return { runs: rows.slice(offset, offset + limit), total: rows.length };
}

router.get('/api/run-history', (req, res) => {
  const { type, status, limit, offset } = req.query;
  res.json(getHistory({
    type: type || null,
    status: status || null,
    limit: Math.min(Number(limit) || 100, 500),
    offset: Number(offset) || 0
  }));
});

router.get('/api/run-history/stats', (_req, res) => {
  const counts = {};
  counts.agent = safe('SELECT COUNT(*) as c FROM runs')[0]?.c || 0;
  counts.workflow = safe('SELECT COUNT(*) as c FROM workflow_runs')[0]?.c || 0;
  counts.automation = safe('SELECT COUNT(*) as c FROM automation_runs')[0]?.c || 0;
  counts.commerce = safe('SELECT COUNT(*) as c FROM commerce_pipeline_runs')[0]?.c || 0;
  counts.apparel = safe('SELECT COUNT(*) as c FROM apparel_pipeline_runs')[0]?.c || 0;
  counts['mystery-shopper'] = safe('SELECT COUNT(*) as c FROM mystery_shopper_runs')[0]?.c || 0;
  counts['store-fixer'] = safe('SELECT COUNT(*) as c FROM store_fixer_runs')[0]?.c || 0;
  counts.creation = safe('SELECT COUNT(*) as c FROM creation_pipeline_runs')[0]?.c || 0;
  counts.distribution = safe('SELECT COUNT(*) as c FROM distribution_runs')[0]?.c || 0;
  counts.analytics = safe('SELECT COUNT(*) as c FROM content_analytics')[0]?.c || 0;
  counts.revenue = safe('SELECT COUNT(*) as c FROM revenue_attributions')[0]?.c || 0;
  counts.calendar = safe('SELECT COUNT(*) as c FROM smart_calendar')[0]?.c || 0;
  counts['ab-test'] = safe('SELECT COUNT(*) as c FROM ab_experiments')[0]?.c || 0;
  counts.trend = safe('SELECT COUNT(*) as c FROM trend_signals')[0]?.c || 0;
  counts.audience = safe('SELECT COUNT(*) as c FROM audience_segments')[0]?.c || 0;
  counts.repurpose = safe('SELECT COUNT(*) as c FROM repurpose_jobs')[0]?.c || 0;
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  res.json({ total, counts });
});

export default router;
