import { db } from '../db.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();
let intervalHandle = null;
let broadcastFn = () => {};
let ollamaUrl = 'http://127.0.0.1:11434';

const ALERT_COOLDOWN_MS = 300_000;
const lastAlertTimes = new Map();

function shouldAlert(ruleKey) {
  const last = lastAlertTimes.get(ruleKey) || 0;
  if (now() - last < ALERT_COOLDOWN_MS) return false;
  lastAlertTimes.set(ruleKey, now());
  return true;
}

export function initHealthMonitor({ broadcast, ollamaBaseUrl, pollIntervalMs = 60_000 } = {}) {
  if (broadcast) broadcastFn = broadcast;
  if (ollamaBaseUrl) ollamaUrl = ollamaBaseUrl;

  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => collectMetrics().catch(e => console.error('health-monitor:', e.message)), pollIntervalMs);
  collectMetrics().catch(() => {});
  return { started: true, intervalMs: pollIntervalMs };
}

export function stopHealthMonitor() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

async function collectMetrics() {
  const ts = now();
  const metrics = {};

  // Ollama health
  try {
    const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    const data = await r.json();
    metrics.ollama_up = 1;
    metrics.ollama_models = (data.models || []).length;
  } catch {
    metrics.ollama_up = 0;
    metrics.ollama_models = 0;
    if (shouldAlert('ollama_down')) {
      const msg = 'Ollama is unreachable — LLM inference unavailable';
      recordAlert('ollama_down', 'critical', msg);
      publish('system', 'system.alert', { rule: 'ollama_down', severity: 'critical', message: msg });
    }
  }

  // DB stats
  try {
    metrics.db_agents = db.prepare(`SELECT COUNT(*) as c FROM threads`).get().c;
    metrics.db_workflows = db.prepare(`SELECT COUNT(*) as c FROM workflows`).get().c;
    metrics.db_bus_messages = db.prepare(`SELECT COUNT(*) as c FROM bus_messages`).get().c;
    metrics.db_bus_today = db.prepare(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?`).get(ts - 86400000).c;
  } catch (e) {
    console.error('health-monitor db stats:', e.message);
  }

  // Needle queue
  try {
    const pending = db.prepare(`SELECT COUNT(*) as c FROM needle_jobs WHERE status = 'pending'`).get()?.c || 0;
    const running = db.prepare(`SELECT COUNT(*) as c FROM needle_jobs WHERE status = 'running'`).get()?.c || 0;
    metrics.needle_pending = pending;
    metrics.needle_running = running;
    if (pending > 20 && shouldAlert('needle_backlog')) {
      const msg = `Needle queue backlog: ${pending} pending jobs`;
      recordAlert('needle_backlog', 'warning', msg);
      publish('system', 'system.alert', { rule: 'needle_backlog', severity: 'warning', message: msg });
    }
  } catch {
    metrics.needle_pending = 0;
    metrics.needle_running = 0;
  }

  // Agent activity (last hour)
  try {
    metrics.agent_runs_1h = db.prepare(`SELECT COUNT(*) as c FROM runs WHERE created_at > ?`).get(ts - 3600000).c;
    metrics.agent_errors_1h = db.prepare(`SELECT COUNT(*) as c FROM runs WHERE status = 'error' AND created_at > ?`).get(ts - 3600000).c;

    if (metrics.agent_errors_1h > 10 && shouldAlert('error_spike')) {
      const msg = `Error spike: ${metrics.agent_errors_1h} agent errors in last hour`;
      recordAlert('error_spike', 'warning', msg);
      publish('system', 'system.alert', { rule: 'error_spike', severity: 'warning', message: msg });
    }
  } catch {
    metrics.agent_runs_1h = 0;
    metrics.agent_errors_1h = 0;
  }

  // Pipeline runs (last 24h)
  try {
    metrics.commerce_runs_24h = db.prepare(`SELECT COUNT(*) as c FROM commerce_pipeline_runs WHERE created_at > ?`).get(ts - 86400000).c;
  } catch {
    metrics.commerce_runs_24h = 0;
  }

  // Subscriptions & triggers
  try {
    metrics.bus_subscriptions = db.prepare(`SELECT COUNT(*) as c FROM bus_subscriptions`).get().c;
    metrics.bus_triggers = db.prepare(`SELECT COUNT(*) as c FROM bus_triggers WHERE enabled = 1`).get()?.c || 0;
  } catch {
    metrics.bus_subscriptions = 0;
    metrics.bus_triggers = 0;
  }

  // Memory usage (process)
  const mem = process.memoryUsage();
  metrics.heap_mb = Math.round(mem.heapUsed / 1048576);
  metrics.rss_mb = Math.round(mem.rss / 1048576);

  // Store all metrics
  const insert = db.prepare(
    `INSERT INTO health_metrics (metric, value, collected_at) VALUES (?, ?, ?)`
  );
  const batch = db.transaction((entries) => {
    for (const [k, v] of entries) insert.run(k, v, ts);
  });
  batch(Object.entries(metrics));

  // Prune old metrics (keep 48h)
  db.prepare(`DELETE FROM health_metrics WHERE collected_at < ?`).run(ts - 172800000);
  db.prepare(`DELETE FROM health_alerts WHERE resolved = 1 AND created_at < ?`).run(ts - 604800000);

  broadcastFn('health', { event: 'metrics', metrics });
  return metrics;
}

function recordAlert(rule, severity, message) {
  db.prepare(
    `INSERT INTO health_alerts (rule, severity, message, resolved, created_at) VALUES (?, ?, ?, 0, ?)`
  ).run(rule, severity, message, now());
  broadcastFn('health', { event: 'alert', rule, severity, message });
}

export function resolveAlert(id) {
  db.prepare(`UPDATE health_alerts SET resolved = 1 WHERE id = ?`).run(id);
  return { resolved: true };
}

export function getLatestMetrics() {
  const latest = db.prepare(
    `SELECT metric, value, collected_at FROM health_metrics WHERE collected_at = (SELECT MAX(collected_at) FROM health_metrics)`
  ).all();
  const map = {};
  for (const r of latest) map[r.metric] = r.value;
  map._collectedAt = latest[0]?.collected_at || 0;
  return map;
}

export function getMetricHistory(metric, { hours = 24 } = {}) {
  const since = now() - hours * 3600000;
  return db.prepare(
    `SELECT value, collected_at FROM health_metrics WHERE metric = ? AND collected_at > ? ORDER BY collected_at ASC`
  ).all(metric, since);
}

export function getAlerts({ resolved = false, limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM health_alerts WHERE resolved = ? ORDER BY created_at DESC LIMIT ?`
  ).all(resolved ? 1 : 0, Math.min(200, Math.max(1, limit)));
}

export function healthStats() {
  const metrics = getLatestMetrics();
  const activeAlerts = db.prepare(`SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0`).get().c;
  return { ...metrics, activeAlerts };
}

export function installHealthRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/health/metrics', route((_req, res) => {
    res.json(getLatestMetrics());
  }));

  app.get('/api/health/metrics/:metric', route((req, res) => {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours) || 24));
    res.json({ metric: req.params.metric, history: getMetricHistory(req.params.metric, { hours }) });
  }));

  app.get('/api/health/alerts', route((req, res) => {
    const resolved = req.query.resolved === 'true';
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ alerts: getAlerts({ resolved, limit }) });
  }));

  app.post('/api/health/alerts/:id/resolve', route((req, res) => {
    res.json(resolveAlert(parseInt(req.params.id)));
  }));

  app.get('/api/health/stats', route((_req, res) => {
    res.json(healthStats());
  }));

  app.post('/api/health/collect', route(async (_req, res) => {
    const metrics = await collectMetrics();
    res.json(metrics);
  }));
}
