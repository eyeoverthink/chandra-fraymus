import { db } from '../db.js';
import { createLogger } from './logger.js';

const log = createLogger('alert-webhook');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS alert_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    label TEXT,
    severity_filter TEXT DEFAULT 'critical',
    enabled INTEGER DEFAULT 1,
    secret TEXT,
    last_fired_at INTEGER,
    fire_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS alert_webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    status INTEGER,
    response TEXT,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (webhook_id) REFERENCES alert_webhooks(id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_awd_created ON alert_webhook_deliveries(created_at)');
} catch (e) { log.error('migration failed', { err: e.message }); }

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

function shouldFire(hook, severity) {
  const hookRank = SEVERITY_RANK[hook.severity_filter] ?? 0;
  const alertRank = SEVERITY_RANK[severity] ?? 0;
  return alertRank >= hookRank;
}

export async function fireWebhooks(alert) {
  const hooks = db.prepare('SELECT * FROM alert_webhooks WHERE enabled = 1').all();
  if (hooks.length === 0) return { fired: 0 };

  let fired = 0;
  for (const hook of hooks) {
    if (!shouldFire(hook, alert.severity)) continue;

    const payload = JSON.stringify({
      event: 'alert',
      severity: alert.severity,
      rule: alert.rule,
      message: alert.message,
      timestamp: new Date().toISOString(),
      source: 'chandra-fraymus',
    });

    const start = Date.now();
    let status = 0;
    let responseText = '';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (hook.secret) headers['X-Webhook-Secret'] = hook.secret;
      const resp = await fetch(hook.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      status = resp.status;
      responseText = (await resp.text()).slice(0, 500);
      fired++;
      log.info('webhook delivered', { hookId: hook.id, url: hook.url, status });
    } catch (e) {
      responseText = e.message;
      log.warn('webhook delivery failed', { hookId: hook.id, url: hook.url, err: e.message });
    }

    const duration = Date.now() - start;
    try {
      db.prepare(`INSERT INTO alert_webhook_deliveries (webhook_id, payload, status, response, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(hook.id, payload, status, responseText, duration, Date.now());
      db.prepare('UPDATE alert_webhooks SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?').run(Date.now(), hook.id);
    } catch (_) {}
  }
  return { fired, total: hooks.length };
}

export function installAlertWebhookRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/observability/webhooks', route((_req, res) => {
    const hooks = db.prepare('SELECT id, url, label, severity_filter, enabled, last_fired_at, fire_count, created_at FROM alert_webhooks ORDER BY created_at DESC').all();
    res.json({ webhooks: hooks });
  }));

  app.post('/api/observability/webhooks', route((req, res) => {
    const { url, label, severity_filter, secret } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const severity = SEVERITY_RANK[severity_filter] !== undefined ? severity_filter : 'critical';
    const result = db.prepare('INSERT INTO alert_webhooks (url, label, severity_filter, secret, created_at) VALUES (?, ?, ?, ?, ?)').run(
      url, label || null, severity, secret || null, Date.now()
    );
    res.status(201).json({ id: result.lastInsertRowid, url, severity_filter: severity });
  }));

  app.delete('/api/observability/webhooks/:id', route((req, res) => {
    const result = db.prepare('DELETE FROM alert_webhooks WHERE id = ?').run(req.params.id);
    res.json({ deleted: result.changes > 0 });
  }));

  app.post('/api/observability/webhooks/:id/toggle', route((req, res) => {
    db.prepare('UPDATE alert_webhooks SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
    const hook = db.prepare('SELECT id, enabled FROM alert_webhooks WHERE id = ?').get(req.params.id);
    res.json(hook || { error: 'not found' });
  }));

  app.post('/api/observability/webhooks/test', route(async (req, res) => {
    const result = await fireWebhooks({
      severity: 'info',
      rule: 'test_webhook',
      message: 'Test alert from Chandra-FRAYMUS observability system',
    });
    res.json({ test: true, ...result });
  }));

  app.get('/api/observability/webhooks/:id/deliveries', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const deliveries = db.prepare('SELECT * FROM alert_webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?').all(req.params.id, limit);
    res.json({ deliveries });
  }));
}
