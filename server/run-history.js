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
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  res.json({ total, counts });
});

export default router;
