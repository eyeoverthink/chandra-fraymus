import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

const GATEWAY_VERSION = '1.0';
const REQUEST_LOG_RETENTION_DAYS = 30;

try {
  db.exec(`CREATE TABLE IF NOT EXISTS gateway_requests (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    api_key TEXT,
    status INTEGER,
    duration_ms INTEGER,
    ip TEXT,
    user_agent TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gateway_requests_created ON gateway_requests(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gateway_requests_key ON gateway_requests(api_key)`);
} catch (e) { console.error('[gateway] migration failed (non-fatal):', e.message); }

export function gatewayMiddleware() {
  return (req, res, next) => {
    const requestId = randomUUID();
    const start = Date.now();

    req.gatewayRequestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Gateway-Version', GATEWAY_VERSION);
    res.setHeader('X-Powered-By', 'Chandra-FRAYMUS');

    const origEnd = res.end;
    res.end = function (...args) {
      const duration = Date.now() - start;
      try {
        db.prepare(`INSERT INTO gateway_requests (id, method, path, api_key, status, duration_ms, ip, user_agent, error, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          requestId,
          req.method,
          req.path,
          req.apiPrincipal?.via || null,
          res.statusCode,
          duration,
          req.ip || req.headers['x-real-ip'] || req.socket?.remoteAddress || null,
          (req.headers['user-agent'] || '').slice(0, 200),
          res.statusCode >= 400 ? (res.statusMessage || '').slice(0, 200) : null,
          start,
        );
      } catch (_) {}
      return origEnd.apply(this, args);
    };

    next();
  };
}

export function externalCors(allowedOrigins = []) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();

    const allowed = allowedOrigins.length === 0 ||
      allowedOrigins.includes('*') ||
      allowedOrigins.includes(origin);

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-RateLimit-Remaining, X-RateLimit-Limit, X-Gateway-Version');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  };
}

export function apiVersionRouter() {
  return (req, _res, next) => {
    const versionMatch = req.path.match(/^\/api\/v(\d+)\//);
    if (versionMatch) {
      req.apiVersion = parseInt(versionMatch[1]);
      req.url = req.url.replace(/\/api\/v\d+\//, '/api/');
    } else {
      req.apiVersion = 1;
    }
    next();
  };
}

export function getGatewayStats() {
  const now = Date.now();
  const hour = now - 3600_000;
  const day = now - 86400_000;

  const hourly = db.prepare(`SELECT COUNT(*) as total,
    SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors,
    AVG(duration_ms) as avgDuration,
    MAX(duration_ms) as maxDuration
    FROM gateway_requests WHERE created_at > ?`).get(hour);

  const daily = db.prepare(`SELECT COUNT(*) as total,
    SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors
    FROM gateway_requests WHERE created_at > ?`).get(day);

  const topPaths = db.prepare(`SELECT path, COUNT(*) as count, AVG(duration_ms) as avgMs
    FROM gateway_requests WHERE created_at > ?
    GROUP BY path ORDER BY count DESC LIMIT 10`).all(hour);

  const topKeys = db.prepare(`SELECT api_key, COUNT(*) as count
    FROM gateway_requests WHERE created_at > ? AND api_key IS NOT NULL
    GROUP BY api_key ORDER BY count DESC LIMIT 5`).all(hour);

  return {
    version: GATEWAY_VERSION,
    hourly: { ...hourly, avgDuration: Math.round(hourly?.avgDuration || 0) },
    daily,
    topPaths,
    topKeys,
  };
}

export function pruneGatewayLogs() {
  const cutoff = Date.now() - (REQUEST_LOG_RETENTION_DAYS * 86400_000);
  const result = db.prepare('DELETE FROM gateway_requests WHERE created_at < ?').run(cutoff);
  return { pruned: result.changes };
}

export function installGatewayRoutes(app) {
  app.get('/api/gateway/stats', (req, res, next) => {
    try { res.json(getGatewayStats()); }
    catch (e) { next(e); }
  });

  app.post('/api/gateway/prune', (req, res, next) => {
    try { res.json(pruneGatewayLogs()); }
    catch (e) { next(e); }
  });
}
