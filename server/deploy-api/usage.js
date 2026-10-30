import { db } from '../db.js';

const now = () => Date.now();

export function logInvocation({ keyId, keyName, slug, workflowId, status, durationMs, inputTokens, outputTokens, error, ip }) {
  db.prepare(`INSERT INTO api_usage (key_id, key_name, slug, workflow_id, status, duration_ms, input_tokens, output_tokens, error, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    keyId, keyName || null, slug, workflowId, status || 'ok',
    durationMs || 0, inputTokens || 0, outputTokens || 0,
    error || null, ip || null, now()
  );
}

export function usageBySlug(slug, { limit = 50, since } = {}) {
  const cutoff = since || 0;
  return db.prepare('SELECT * FROM api_usage WHERE slug = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?')
    .all(slug, cutoff, Math.min(limit, 500));
}

export function usageByKey(keyId, { limit = 50, since } = {}) {
  const cutoff = since || 0;
  return db.prepare('SELECT * FROM api_usage WHERE key_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?')
    .all(keyId, cutoff, Math.min(limit, 500));
}

export function usageStats(slug) {
  const day = now() - 86400_000;
  const week = now() - 604800_000;
  const total = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(duration_ms),0) as totalMs, COALESCE(AVG(duration_ms),0) as avgMs FROM api_usage WHERE slug = ?').get(slug);
  const today = db.prepare('SELECT COUNT(*) as count FROM api_usage WHERE slug = ? AND created_at > ?').get(slug, day);
  const thisWeek = db.prepare('SELECT COUNT(*) as count FROM api_usage WHERE slug = ? AND created_at > ?').get(slug, week);
  const errors = db.prepare("SELECT COUNT(*) as count FROM api_usage WHERE slug = ? AND status = 'error'").get(slug);
  return {
    total: total.count, totalDurationMs: total.totalMs, avgDurationMs: Math.round(total.avgMs),
    today: today.count, thisWeek: thisWeek.count, errors: errors.count,
  };
}

export function globalStats() {
  const day = now() - 86400_000;
  const total = db.prepare('SELECT COUNT(*) as count FROM api_usage').get();
  const today = db.prepare('SELECT COUNT(*) as count FROM api_usage WHERE created_at > ?').get(day);
  const slugs = db.prepare('SELECT slug, COUNT(*) as count, COALESCE(AVG(duration_ms),0) as avgMs FROM api_usage GROUP BY slug ORDER BY count DESC LIMIT 20').all();
  const keys = db.prepare('SELECT key_id, key_name, COUNT(*) as count FROM api_usage GROUP BY key_id ORDER BY count DESC LIMIT 20').all();
  return { total: total.count, today: today.count, slugs, keys };
}
