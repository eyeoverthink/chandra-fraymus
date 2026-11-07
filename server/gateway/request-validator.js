import { db } from '../db.js';

const TABLE = 'validation_events';
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_URL_LENGTH = 2048;

const ALLOWED_CONTENT_TYPES = new Set([
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]);

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    path TEXT NOT NULL,
    violation TEXT NOT NULL,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function recordViolation(ip, path, violation, detail) {
  try {
    db.prepare(`INSERT INTO ${TABLE} (ip, path, violation, detail)
      VALUES (?,?,?,?)`).run(ip, path, violation, detail || '');
  } catch (e) { console.error('[request-validator] record error:', e.message); }
}

function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/\0/g, '');
}

function deepSanitize(obj) {
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(deepSanitize);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(obj)) {
      result[sanitizeString(key)] = deepSanitize(val);
    }
    return result;
  }
  return obj;
}

export function requestValidator() {
  ensureTable();
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    // URL length check
    if (req.originalUrl.length > MAX_URL_LENGTH) {
      recordViolation(ip, req.path, 'url_too_long', `length=${req.originalUrl.length}`);
      return res.status(414).json({ error: 'URI too long', maxLength: MAX_URL_LENGTH });
    }

    // Content-Type validation for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType)) {
        recordViolation(ip, req.path, 'invalid_content_type', contentType);
        return res.status(415).json({ error: 'Unsupported content type', allowed: [...ALLOWED_CONTENT_TYPES] });
      }

      // Body size check (Content-Length header)
      const contentLength = parseInt(req.headers['content-length'] || '0');
      if (contentLength > MAX_BODY_SIZE) {
        recordViolation(ip, req.path, 'body_too_large', `size=${contentLength}`);
        return res.status(413).json({ error: 'Request body too large', maxBytes: MAX_BODY_SIZE });
      }
    }

    // Query param sanitization
    if (req.query && Object.keys(req.query).length > 0) {
      req.query = deepSanitize(req.query);
    }

    // Body sanitization (only for parsed JSON bodies)
    if (req.body && typeof req.body === 'object' && req.headers['content-type']?.includes('json')) {
      req.body = deepSanitize(req.body);
    }

    next();
  };
}

export function getValidationStatus() {
  try {
    ensureTable();
    const total = db.prepare(`SELECT COUNT(*) as count FROM ${TABLE}`).get()?.count || 0;
    const recent = db.prepare(`SELECT COUNT(*) as count FROM ${TABLE} WHERE created_at > datetime('now', '-1 hour')`).get()?.count || 0;
    const byType = db.prepare(`SELECT violation, COUNT(*) as count FROM ${TABLE} GROUP BY violation ORDER BY count DESC`).all();
    return {
      totalViolations: total,
      lastHour: recent,
      byType,
      config: {
        maxBodySize: MAX_BODY_SIZE,
        maxUrlLength: MAX_URL_LENGTH,
        allowedContentTypes: [...ALLOWED_CONTENT_TYPES],
      },
    };
  } catch { return { totalViolations: 0, lastHour: 0, byType: [], config: {} }; }
}

export function getValidationHistory(limit = 50) {
  try {
    ensureTable();
    return db.prepare(`SELECT * FROM ${TABLE} ORDER BY id DESC LIMIT ?`)
      .all(Math.min(200, Math.max(1, limit)));
  } catch { return []; }
}

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installRequestValidatorRoutes(app) {
  ensureTable();

  app.get('/api/gateway/validator', route(async (req, res) => {
    res.json(getValidationStatus());
  }));

  app.get('/api/gateway/validator/history', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json(getValidationHistory(limit));
  }));

  app.post('/api/gateway/validator/prune', route(async (req, res) => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare(`DELETE FROM ${TABLE} WHERE created_at < ?`).run(cutoff);
    res.json({ pruned: info.changes });
  }));
}
