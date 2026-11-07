import { db } from '../db.js';

const TABLE = 'api_registry_snapshots';
let cachedCatalog = null;
let catalogTimestamp = 0;
const CACHE_TTL_MS = 60_000;

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_count INTEGER,
    method_counts TEXT,
    category_counts TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function categorizeRoute(path) {
  if (path.startsWith('/api/fleet')) return 'fleet';
  if (path.startsWith('/api/agents')) return 'fleet';
  if (path.startsWith('/api/workflows')) return 'workflow';
  if (path.startsWith('/api/intelligence')) return 'intelligence';
  if (path.startsWith('/api/commerce') || path.startsWith('/api/apparel') || path.startsWith('/api/mystery') || path.startsWith('/api/store-fixer')) return 'commerce';
  if (path.startsWith('/api/streaming')) return 'streaming';
  if (path.startsWith('/api/media') || path.startsWith('/api/images') || path.startsWith('/api/video') || path.startsWith('/api/tts') || path.startsWith('/api/stt') || path.startsWith('/api/ocr')) return 'media';
  if (path.startsWith('/api/supervisor')) return 'supervisor';
  if (path.startsWith('/api/gateway')) return 'gateway';
  if (path.startsWith('/api/observability') || path.startsWith('/api/metrics')) return 'observability';
  if (path.startsWith('/api/resilience') || path.startsWith('/api/backup') || path.startsWith('/api/circuit-breaker') || path.startsWith('/api/recovery')) return 'resilience';
  if (path.startsWith('/api/profiling') || path.startsWith('/api/cache') || path.startsWith('/api/compression') || path.startsWith('/api/etag')) return 'performance';
  if (path.startsWith('/api/db-optimize') || path.startsWith('/api/index-analyzer') || path.startsWith('/api/wal') || path.startsWith('/api/retention')) return 'database';
  if (path.startsWith('/api/deploy')) return 'deploy';
  if (path.startsWith('/api/mcp')) return 'mcp';
  if (path.startsWith('/api/vertiso') || path.startsWith('/api/memory') || path.startsWith('/api/rsi')) return 'vertiso';
  if (path.startsWith('/api/health')) return 'health';
  if (path.startsWith('/api/bus')) return 'bus';
  if (path.startsWith('/api/integrity')) return 'integrity';
  if (path.startsWith('/api/fraymus') || path.startsWith('/api/carbon') || path.startsWith('/api/nudp')) return 'fraymus';
  if (path.startsWith('/api/creation') || path.startsWith('/api/distribution') || path.startsWith('/api/analytics')) return 'content';
  if (path.startsWith('/api/command')) return 'command';
  if (path.startsWith('/api/search')) return 'search';
  if (path.startsWith('/api/')) return 'other';
  return 'static';
}

function extractRoutes(app) {
  const routes = [];
  const seen = new Set();

  function walkStack(stack, basePath = '') {
    if (!stack) return;
    for (const layer of stack) {
      if (layer.route) {
        const path = basePath + (layer.route.path || '');
        const methods = Object.keys(layer.route.methods || {}).map(m => m.toUpperCase());
        for (const method of methods) {
          const key = `${method}:${path}`;
          if (!seen.has(key) && path.startsWith('/api/')) {
            seen.add(key);
            routes.push({
              method,
              path,
              category: categorizeRoute(path),
            });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const routerPath = layer.regexp?.source
          ?.replace(/\\\//g, '/')
          ?.replace(/\^/g, '')
          ?.replace(/\?\(\?=.*$/g, '')
          ?.replace(/\(\?:.*$/g, '')
          || '';
        walkStack(layer.handle.stack, basePath + routerPath);
      }
    }
  }

  walkStack(app._router?.stack || app.stack || []);
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function discoverEndpoints(app) {
  const now = Date.now();
  if (cachedCatalog && (now - catalogTimestamp) < CACHE_TTL_MS) return cachedCatalog;

  const routes = extractRoutes(app);

  const methodCounts = {};
  const categoryCounts = {};
  for (const r of routes) {
    methodCounts[r.method] = (methodCounts[r.method] || 0) + 1;
    categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;
  }

  const catalog = {
    endpointCount: routes.length,
    methodCounts,
    categoryCounts,
    endpoints: routes,
    discoveredAt: new Date().toISOString(),
  };
  if (routes.length > 0) {
    cachedCatalog = catalog;
    catalogTimestamp = now;
  }
  return catalog;
}

function snapshotCatalog(catalog) {
  try {
    db.prepare(`INSERT INTO ${TABLE} (endpoint_count, method_counts, category_counts)
      VALUES (?,?,?)`).run(
      catalog.endpointCount,
      JSON.stringify(catalog.methodCounts),
      JSON.stringify(catalog.categoryCounts)
    );
  } catch (e) { console.error('[api-registry] snapshot error:', e.message); }
}

export function getRegistryHistory(limit = 20) {
  try {
    ensureTable();
    const rows = db.prepare(`SELECT * FROM ${TABLE} ORDER BY id DESC LIMIT ?`)
      .all(Math.min(100, Math.max(1, limit)));
    return rows.map(r => {
      try { r.method_counts = JSON.parse(r.method_counts); } catch {}
      try { r.category_counts = JSON.parse(r.category_counts); } catch {}
      return r;
    });
  } catch { return []; }
}

let registeredApp = null;

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installApiRegistryRoutes(app) {
  ensureTable();
  registeredApp = app;

  app.get('/api/gateway/catalog', route(async (req, res) => {
    const catalog = discoverEndpoints(app);
    const category = req.query.category;
    if (category) {
      const filtered = catalog.endpoints.filter(e => e.category === category);
      return res.json({ ...catalog, endpoints: filtered, endpointCount: filtered.length, filtered: true });
    }
    res.json(catalog);
  }));

  app.get('/api/gateway/catalog/categories', route(async (req, res) => {
    const catalog = discoverEndpoints(app);
    res.json({ categories: catalog.categoryCounts });
  }));

  app.get('/api/gateway/catalog/history', route(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json(getRegistryHistory(limit));
  }));

  app.post('/api/gateway/catalog/snapshot', route(async (req, res) => {
    const catalog = discoverEndpoints(app);
    snapshotCatalog(catalog);
    res.json({ snapshot: true, endpointCount: catalog.endpointCount });
  }));

  app.get('/api/gateway/catalog/search', route(async (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.status(400).json({ error: 'q parameter required' });
    const catalog = discoverEndpoints(app);
    const matches = catalog.endpoints.filter(e =>
      e.path.toLowerCase().includes(q) || e.category.includes(q) || e.method.toLowerCase().includes(q)
    );
    res.json({ query: q, matches, count: matches.length });
  }));
}
