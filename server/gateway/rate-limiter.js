import { db } from '../db.js';

const TABLE = 'rate_limit_events';
const windows = new Map();

const ROUTE_LIMITS = {
  '/api/command':           { maxRequests: 30,  windowMs: 60_000 },
  '/api/fleet/runs':        { maxRequests: 20,  windowMs: 60_000 },
  '/api/workflows/run':     { maxRequests: 10,  windowMs: 60_000 },
  '/api/streaming':         { maxRequests: 40,  windowMs: 60_000 },
  '/api/intelligence':      { maxRequests: 30,  windowMs: 60_000 },
  '/api/commerce':          { maxRequests: 15,  windowMs: 60_000 },
  '/api/media':             { maxRequests: 10,  windowMs: 60_000 },
  _read:                    { maxRequests: 600, windowMs: 60_000 },
  _default:                 { maxRequests: 120, windowMs: 60_000 },
};

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    route_prefix TEXT NOT NULL,
    blocked INTEGER DEFAULT 0,
    window_hits INTEGER,
    limit_max INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function getRouteLimit(path, method) {
  // Dashboards poll dozens of read endpoints per page load; only writes get the tight per-route budgets.
  if (method === 'GET' || method === 'HEAD') return { prefix: '_read', ...ROUTE_LIMITS._read };
  for (const [prefix, limit] of Object.entries(ROUTE_LIMITS)) {
    if (!prefix.startsWith('_') && path.startsWith(prefix)) return { prefix, ...limit };
  }
  return { prefix: '_default', ...ROUTE_LIMITS._default };
}

function getWindowKey(ip, prefix) {
  return `${ip}:${prefix}`;
}

function slidingWindowCheck(ip, prefix, maxRequests, windowMs) {
  const key = getWindowKey(ip, prefix);
  const now = Date.now();

  if (!windows.has(key)) {
    windows.set(key, { hits: [], blocked: 0 });
  }

  const win = windows.get(key);
  win.hits = win.hits.filter(t => t > now - windowMs);

  if (win.hits.length >= maxRequests) {
    win.blocked++;
    const oldestInWindow = win.hits[0] || now;
    const retryAfterMs = oldestInWindow + windowMs - now;
    return {
      allowed: false,
      remaining: 0,
      limit: maxRequests,
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
      windowHits: win.hits.length,
    };
  }

  win.hits.push(now);
  return {
    allowed: true,
    remaining: maxRequests - win.hits.length,
    limit: maxRequests,
    retryAfterSec: 0,
    windowHits: win.hits.length,
  };
}

function recordBlock(ip, prefix, windowHits, limitMax) {
  try {
    db.prepare(`INSERT INTO ${TABLE} (ip, route_prefix, blocked, window_hits, limit_max)
      VALUES (?,?,1,?,?)`).run(ip, prefix, windowHits, limitMax);
  } catch (e) { console.error('[rate-limiter] record error:', e.message); }
}

export function globalRateLimiter() {
  ensureTable();
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.path.startsWith('/api/gateway/') || req.path.startsWith('/api/health') || req.path.startsWith('/api/supervisor/') || req.path.startsWith('/api/config-mgr/')) return next();

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const { prefix, maxRequests, windowMs } = getRouteLimit(req.path, req.method);
    const result = slidingWindowCheck(ip, prefix, maxRequests, windowMs);

    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSec);
      res.setHeader('X-RateLimit-Reset', result.retryAfterSec);
      recordBlock(ip, prefix, result.windowHits, result.limit);
      return res.status(429).json({
        error: 'Too many requests',
        retryAfterSec: result.retryAfterSec,
        limit: result.limit,
      });
    }

    next();
  };
}

export function getRateLimiterStatus() {
  const entries = [];
  for (const [key, win] of windows) {
    const now = Date.now();
    const activeHits = win.hits.filter(t => t > now - 60_000).length;
    if (activeHits > 0 || win.blocked > 0) {
      const [ip, prefix] = key.split(':');
      entries.push({ ip, prefix, activeHits, blocked: win.blocked });
    }
  }
  return {
    activeWindows: entries.length,
    routeLimits: { ...ROUTE_LIMITS },
    windows: entries.slice(0, 50),
  };
}

export function getRateLimitHistory(limit = 50) {
  try {
    ensureTable();
    return db.prepare(`SELECT * FROM ${TABLE} WHERE blocked = 1 ORDER BY id DESC LIMIT ?`)
      .all(Math.min(200, Math.max(1, limit)));
  } catch { return []; }
}

export function updateRouteLimit(prefix, maxRequests, windowMs) {
  if (!prefix || maxRequests < 1 || windowMs < 1000) return false;
  ROUTE_LIMITS[prefix] = { maxRequests, windowMs };
  return true;
}

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installRateLimiterRoutes(app) {
  ensureTable();

  app.get('/api/gateway/rate-limiter', route(async (req, res) => {
    res.json(getRateLimiterStatus());
  }));

  app.get('/api/gateway/rate-limiter/history', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json(getRateLimitHistory(limit));
  }));

  app.post('/api/gateway/rate-limiter/configure', route(async (req, res) => {
    const { prefix, maxRequests, windowMs } = req.body || {};
    if (!prefix || !maxRequests) return res.status(400).json({ error: 'prefix and maxRequests required' });
    const ok = updateRouteLimit(prefix, maxRequests, windowMs || 60_000);
    res.json({ updated: ok, routeLimits: ROUTE_LIMITS });
  }));

  app.post('/api/gateway/rate-limiter/prune', route(async (req, res) => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare(`DELETE FROM ${TABLE} WHERE created_at < ?`).run(cutoff);
    res.json({ pruned: info.changes });
  }));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, win] of windows) {
    const activeHits = win.hits.filter(t => t > now - 120_000).length;
    if (activeHits === 0 && win.blocked === 0) windows.delete(key);
  }
}, 120_000).unref?.();
