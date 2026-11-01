// Streaming API Key Management — SQLite-backed, B2B-ready
// Each partner gets a key scoped to allowed operations with rate limiting.

import { randomBytes } from 'node:crypto';

const SCOPES = ['mint', 'verify', 'stream', 'webhook'];

export function initStreamingKeys(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS streaming_api_keys (
      id INTEGER PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      scopes TEXT DEFAULT 'mint,verify',
      rate_limit INTEGER DEFAULT 60,
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS streaming_artifacts (
      id TEXT PRIMARY KEY,
      streamer_id TEXT NOT NULL,
      donor_id TEXT,
      donor_name TEXT,
      amount REAL,
      message TEXT,
      sha256 TEXT NOT NULL,
      wasm_size INTEGER,
      png_width INTEGER,
      png_height INTEGER,
      duration_ms INTEGER,
      api_key_id INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  const count = db.prepare('SELECT COUNT(*) as n FROM streaming_api_keys').get().n;
  if (count === 0) {
    const key = 'sk_live_' + randomBytes(24).toString('hex');
    db.prepare(
      'INSERT INTO streaming_api_keys (key, name, scopes, rate_limit, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(key, 'default', 'mint,verify,stream,webhook', 120, Date.now());
    console.log('streaming: auto-generated default API key');
  }
}

export function validateKey(db, key) {
  if (!key || typeof key !== 'string') return null;
  const row = db.prepare('SELECT * FROM streaming_api_keys WHERE key = ? AND active = 1').get(key);
  if (!row) return null;
  db.prepare('UPDATE streaming_api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { ...row, scopes: row.scopes.split(',') };
}

export function hasScope(keyRow, scope) {
  return keyRow && keyRow.scopes.includes(scope);
}

export function createKey(db, { name, scopes = 'mint,verify', rateLimit = 60 }) {
  if (!name || typeof name !== 'string') throw new Error('name required');
  const scopeArr = scopes.split(',').filter(s => SCOPES.includes(s));
  if (!scopeArr.length) throw new Error('at least one valid scope required');
  const key = 'sk_live_' + randomBytes(24).toString('hex');
  const info = db.prepare(
    'INSERT INTO streaming_api_keys (key, name, scopes, rate_limit, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(key, name.slice(0, 100), scopeArr.join(','), Math.min(600, Math.max(1, rateLimit)), Date.now());
  return { id: info.lastInsertRowid, key, name, scopes: scopeArr };
}

export function revokeKey(db, id) {
  const r = db.prepare('UPDATE streaming_api_keys SET active = 0 WHERE id = ?').run(id);
  return r.changes > 0;
}

export function listKeys(db) {
  return db.prepare('SELECT id, name, scopes, rate_limit, active, created_at, last_used_at FROM streaming_api_keys ORDER BY created_at DESC').all();
}

export function storeArtifactRecord(db, artifact, apiKeyId = null) {
  db.prepare(`
    INSERT OR REPLACE INTO streaming_artifacts (id, streamer_id, donor_id, donor_name, amount, message, sha256, wasm_size, png_width, png_height, duration_ms, api_key_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.id, artifact.streamerId, artifact.donorId, artifact.donorName,
    artifact.amount, artifact.message, artifact.sha256, artifact.wasmSize,
    artifact.png.width, artifact.png.height, artifact.durationMs,
    apiKeyId, artifact.mintedAt
  );
}

export function listArtifacts(db, { limit = 50, streamerId } = {}) {
  const safeLimit = Math.min(200, Math.max(1, limit));
  if (streamerId) {
    return db.prepare('SELECT * FROM streaming_artifacts WHERE streamer_id = ? ORDER BY created_at DESC LIMIT ?').all(streamerId, safeLimit);
  }
  return db.prepare('SELECT * FROM streaming_artifacts ORDER BY created_at DESC LIMIT ?').all(safeLimit);
}
