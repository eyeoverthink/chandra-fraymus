import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('lru-cache');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS cache_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hits INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0,
    evictions INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    recorded_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cs_recorded ON cache_stats(recorded_at)');
} catch (e) { log.error('lru-cache migration failed', { err: e.message }); }

class LRUNode {
  constructor(key, value, ttlMs) {
    this.key = key;
    this.value = value;
    this.expiresAt = Date.now() + ttlMs;
    this.prev = null;
    this.next = null;
  }

  get expired() {
    return Date.now() >= this.expiresAt;
  }
}

export class LRUCache {
  constructor(opts = {}) {
    this.capacity = opts.capacity || 500;
    this.defaultTtlMs = opts.ttlMs || 60_000;
    this.name = opts.name || 'default';
    this.map = new Map();
    this.head = null;
    this.tail = null;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  _detach(node) {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  _pushFront(node) {
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  get(key) {
    const node = this.map.get(key);
    if (!node) { this.misses++; return undefined; }
    if (node.expired) {
      this._detach(node);
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this._detach(node);
    this._pushFront(node);
    this.hits++;
    return node.value;
  }

  set(key, value, ttlMs) {
    const existing = this.map.get(key);
    if (existing) {
      this._detach(existing);
      this.map.delete(key);
    }

    const node = new LRUNode(key, value, ttlMs || this.defaultTtlMs);
    this._pushFront(node);
    this.map.set(key, node);

    while (this.map.size > this.capacity) {
      const victim = this.tail;
      if (!victim) break;
      this._detach(victim);
      this.map.delete(victim.key);
      this.evictions++;
    }
  }

  has(key) {
    const node = this.map.get(key);
    return node && !node.expired;
  }

  delete(key) {
    const node = this.map.get(key);
    if (node) {
      this._detach(node);
      this.map.delete(key);
      return true;
    }
    return false;
  }

  invalidatePattern(pattern) {
    let count = 0;
    for (const [key, node] of this.map) {
      if (key.includes(pattern)) {
        this._detach(node);
        this.map.delete(key);
        count++;
      }
    }
    return count;
  }

  clear() {
    this.map.clear();
    this.head = null;
    this.tail = null;
    const cleared = this.map.size;
    return cleared;
  }

  purgeExpired() {
    let purged = 0;
    let node = this.tail;
    while (node) {
      const prev = node.prev;
      if (node.expired) {
        this._detach(node);
        this.map.delete(node.key);
        purged++;
      }
      node = prev;
    }
    return purged;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      size: this.map.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? Math.round((this.hits / total) * 1000) / 10 : 0,
      defaultTtlMs: this.defaultTtlMs,
    };
  }
}

const caches = new Map();

export function getCache(name, opts = {}) {
  if (!caches.has(name)) {
    caches.set(name, new LRUCache({ name, ...opts }));
  }
  return caches.get(name);
}

export function getAllCacheStats() {
  return [...caches.values()].map(c => c.stats());
}

export function getCacheHistory(limit = 30) {
  return db.prepare(
    'SELECT * FROM cache_stats ORDER BY recorded_at DESC LIMIT ?'
  ).all(limit).reverse();
}

export function recordCacheSnapshot() {
  const all = getAllCacheStats();
  const totals = all.reduce((acc, s) => ({
    hits: acc.hits + s.hits,
    misses: acc.misses + s.misses,
    evictions: acc.evictions + s.evictions,
    size: acc.size + s.size,
  }), { hits: 0, misses: 0, evictions: 0, size: 0 });

  try {
    db.prepare('INSERT INTO cache_stats (hits, misses, evictions, size, recorded_at) VALUES (?, ?, ?, ?, ?)')
      .run(totals.hits, totals.misses, totals.evictions, totals.size, Date.now());
  } catch (_) {}
  return totals;
}

let snapshotTimer = null;

export function startCacheSnapshots(intervalMs) {
  if (snapshotTimer) return;
  const interval = Math.max(30_000, intervalMs || 60_000);
  snapshotTimer = setInterval(() => recordCacheSnapshot(), interval);
  snapshotTimer.unref();
  log.info('cache snapshots started', { intervalMs: interval });
}

export function stopCacheSnapshots() {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}

export function cachedEndpoint(cacheName, keyFn, ttlMs) {
  const cache = getCache(cacheName, { ttlMs: ttlMs || 30_000 });
  return (handler) => async (req, res, next) => {
    try {
      const key = typeof keyFn === 'function' ? keyFn(req) : `${req.method}:${req.originalUrl}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        res.set('X-Cache', 'HIT');
        return res.json(cached);
      }
      const origJson = res.json.bind(res);
      res.json = (data) => {
        cache.set(key, data, ttlMs);
        res.set('X-Cache', 'MISS');
        return origJson(data);
      };
      await handler(req, res, next);
    } catch (e) { next(e); }
  };
}

export function installCacheRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/caching/stats', route((_req, res) => {
    res.json({ caches: getAllCacheStats() });
  }));

  app.get('/api/caching/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 30));
    res.json({ history: getCacheHistory(limit) });
  }));

  app.post('/api/caching/purge', route((req, res) => {
    const { name, pattern } = req.body || {};
    if (name && caches.has(name)) {
      if (pattern) {
        const count = caches.get(name).invalidatePattern(pattern);
        return res.json({ purged: count, cache: name, pattern });
      }
      caches.get(name).clear();
      return res.json({ cleared: name });
    }
    caches.forEach(c => c.clear());
    res.json({ cleared: 'all' });
  }));

  app.post('/api/caching/purge-expired', route((_req, res) => {
    let total = 0;
    caches.forEach(c => { total += c.purgeExpired(); });
    res.json({ purged: total });
  }));
}
