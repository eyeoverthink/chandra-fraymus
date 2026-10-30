// SQLite-backed entity store — replaces Base44's entityStore API
// Provides .create(), .update(), .filter(), .get(), .delete() per collection
import { db } from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS fraymus_entities (
    id TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fent_coll ON fraymus_entities(collection, created_at DESC);
`);

const stmts = {
  insert: db.prepare('INSERT INTO fraymus_entities (id, collection, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE fraymus_entities SET data = ?, updated_at = ? WHERE id = ? AND collection = ?'),
  get: db.prepare('SELECT * FROM fraymus_entities WHERE id = ? AND collection = ?'),
  del: db.prepare('DELETE FROM fraymus_entities WHERE id = ? AND collection = ?'),
  list: db.prepare('SELECT * FROM fraymus_entities WHERE collection = ? ORDER BY created_at DESC LIMIT ?'),
  filter: db.prepare('SELECT * FROM fraymus_entities WHERE collection = ? ORDER BY created_at DESC LIMIT ?'),
};

function safeParse(str, fallback = {}) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

class Collection {
  constructor(name) {
    this.name = name;
  }

  create(data) {
    const id = data.id || makeId();
    const now = new Date().toISOString();
    const record = { ...data, id };
    stmts.insert.run(id, this.name, JSON.stringify(record), now, now);
    return { ...record, id, created_date: now };
  }

  update(id, fields) {
    const row = stmts.get.get(id, this.name);
    if (!row) return null;
    const existing = safeParse(row.data);
    const merged = { ...existing, ...fields };
    const now = new Date().toISOString();
    stmts.update.run(JSON.stringify(merged), now, id, this.name);
    return merged;
  }

  get(id) {
    const row = stmts.get.get(id, this.name);
    if (!row) return null;
    return safeParse(row.data);
  }

  delete(id) {
    stmts.del.run(id, this.name);
    return { deleted: true };
  }

  filter(conditions = {}, opts = {}) {
    const limit = opts.limit || 50;
    const rows = stmts.list.all(this.name, limit);
    let items = rows.map(r => safeParse(r.data));

    for (const [key, val] of Object.entries(conditions)) {
      items = items.filter(item => item[key] === val);
    }

    if (opts.sort) {
      const desc = opts.sort.startsWith('-');
      const field = desc ? opts.sort.slice(1) : opts.sort;
      items.sort((a, b) => {
        const av = a[field] || '';
        const bv = b[field] || '';
        return desc ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
      });
    }

    return { items, total: items.length };
  }
}

// Proxy that auto-creates Collection instances on property access
export const entityStore = new Proxy({}, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined;
    if (!target[prop]) {
      target[prop] = new Collection(prop);
    }
    return target[prop];
  }
});
