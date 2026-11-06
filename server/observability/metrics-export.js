import { db } from '../db.js';

const BOOT_TIME = Date.now();

function safeCount(sql, params = []) {
  try { return db.prepare(sql).get(...params)?.c ?? 0; } catch { return 0; }
}

function collectMetrics() {
  const now = Date.now();
  const hour = now - 3600_000;
  const day = now - 86400_000;
  const mem = process.memoryUsage();

  return {
    process: {
      uptime_seconds: Math.floor((now - BOOT_TIME) / 1000),
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      rss_bytes: mem.rss,
      external_bytes: mem.external,
    },
    gateway: {
      requests_1h: safeCount('SELECT COUNT(*) as c FROM gateway_requests WHERE created_at > ?', [hour]),
      errors_1h: safeCount('SELECT COUNT(*) as c FROM gateway_requests WHERE created_at > ? AND status >= 400', [hour]),
      requests_24h: safeCount('SELECT COUNT(*) as c FROM gateway_requests WHERE created_at > ?', [day]),
      avg_duration_1h: (() => {
        try { return Math.round(db.prepare('SELECT AVG(duration_ms) as a FROM gateway_requests WHERE created_at > ?').get(hour)?.a || 0); } catch { return 0; }
      })(),
      p99_duration_1h: (() => {
        try {
          const total = safeCount('SELECT COUNT(*) as c FROM gateway_requests WHERE created_at > ?', [hour]);
          if (total < 2) return 0;
          const offset = Math.max(0, Math.floor(total * 0.99) - 1);
          return db.prepare('SELECT duration_ms FROM gateway_requests WHERE created_at > ? ORDER BY duration_ms ASC LIMIT 1 OFFSET ?').get(hour, offset)?.duration_ms || 0;
        } catch { return 0; }
      })(),
    },
    fleet: {
      total_agents: safeCount('SELECT COUNT(DISTINCT agent_id) as c FROM runs'),
      runs_1h: safeCount('SELECT COUNT(*) as c FROM runs WHERE created_at > ?', [hour]),
      runs_success_1h: safeCount("SELECT COUNT(*) as c FROM runs WHERE created_at > ? AND status = 'completed'", [hour]),
      runs_failed_1h: safeCount("SELECT COUNT(*) as c FROM runs WHERE created_at > ? AND status = 'failed'", [hour]),
    },
    bus: {
      messages_1h: safeCount('SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?', [hour]),
      topics_active: safeCount('SELECT COUNT(DISTINCT topic) as c FROM bus_messages WHERE created_at > ?', [hour]),
    },
    intelligence: {
      memories: safeCount('SELECT COUNT(*) as c FROM agent_memories'),
      reflections_24h: safeCount('SELECT COUNT(*) as c FROM reflections WHERE created_at > ?', [day]),
      consciousness_audits_24h: safeCount('SELECT COUNT(*) as c FROM consciousness_audits WHERE created_at > ?', [day]),
      knowledge_nodes: safeCount('SELECT COUNT(*) as c FROM knowledge_nodes'),
      knowledge_edges: safeCount('SELECT COUNT(*) as c FROM knowledge_edges'),
    },
    health: {
      active_alerts: safeCount("SELECT COUNT(*) as c FROM health_alerts WHERE status = 'active'"),
    },
    db: {
      size_bytes: (() => {
        try {
          const { page_count } = db.prepare('PRAGMA page_count').get();
          const { page_size } = db.prepare('PRAGMA page_size').get();
          return page_count * page_size;
        } catch { return 0; }
      })(),
    },
  };
}

function toPrometheus(metrics, prefix = 'chandra') {
  const lines = [];
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj)) {
      const full = path ? `${path}_${k}` : k;
      if (typeof v === 'number') {
        lines.push(`${prefix}_${full} ${v}`);
      } else if (typeof v === 'object' && v !== null) {
        walk(v, full);
      }
    }
  };
  walk(metrics, '');
  return lines.join('\n') + '\n';
}

export function getMetricsJSON() {
  return collectMetrics();
}

export function getMetricsPrometheus() {
  return toPrometheus(collectMetrics());
}

export function installMetricsExportRoutes(app) {
  app.get('/api/observability/metrics', (_req, res, next) => {
    try { res.json(getMetricsJSON()); }
    catch (e) { next(e); }
  });

  app.get('/api/observability/metrics/prometheus', (_req, res, next) => {
    try {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(getMetricsPrometheus());
    } catch (e) { next(e); }
  });

  app.get('/api/observability/uptime', (_req, res) => {
    res.json({
      bootTime: new Date(BOOT_TIME).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
    });
  });
}
