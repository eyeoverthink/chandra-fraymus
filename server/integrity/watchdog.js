import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { db } from '../db.js';
import { DATA_DIR } from '../config.js';

const FOSSIL_DIR = join(DATA_DIR, 'fossils');
const MANIFEST_FILE = join(DATA_DIR, 'integrity-manifest.json');
const CHECK_INTERVAL_MS = 60_000;

let _interval = null;
let _broadcast = null;
let _lastCheck = null;
let _violations = [];

db.exec(`
  CREATE TABLE IF NOT EXISTS integrity_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    file_path TEXT,
    expected_hash TEXT,
    actual_hash TEXT,
    action TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_integrity_ts ON integrity_events(created_at DESC);
`);

function sha256File(filePath) {
  try {
    const data = readFileSync(filePath);
    return createHash('sha256').update(data).digest('hex');
  } catch {
    return null;
  }
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function loadManifest() {
  if (!existsSync(MANIFEST_FILE)) return { tracked: {}, version: 0, updated_at: 0 };
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf-8'));
  } catch {
    return { tracked: {}, version: 0, updated_at: 0 };
  }
}

function saveManifest(manifest) {
  manifest.updated_at = Date.now();
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

function logEvent(type, filePath, expectedHash, actualHash, action, detail) {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO integrity_events (id, type, file_path, expected_hash, actual_hash, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, type, filePath, expectedHash, actualHash, action, detail, now);
  if (_broadcast) {
    _broadcast('integrity', { type, file_path: filePath, action, detail, ts: now });
  }
  return id;
}

// SQLite changes its main file during ordinary commits/checkpoints. Restoring
// one file behind an open connection can roll back committed state or corrupt it.
export function isDatabaseFile(filePath) {
  const absPath = resolve(filePath);
  if (absPath === resolve(db.name) || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(absPath)
      || /-(?:wal|shm|journal)$/i.test(absPath)) return true;
  let handle;
  try {
    handle = openSync(absPath, 'r');
    const header = Buffer.alloc(16);
    return readSync(handle, header, 0, 16, 0) === 16 && header.toString('binary') === 'SQLite format 3\0';
  } catch { return false; }
  finally { if (handle !== undefined) closeSync(handle); }
}

export function isProtectedMutableFile(filePath) {
  return isDatabaseFile(filePath) || /\.(?:jsonl|ndjson)$/i.test(filePath);
}

export function trackFile(filePath) {
  const absPath = resolve(filePath);
  if (isProtectedMutableFile(absPath)) throw new Error('Mutable databases and append-only journals require application-level recovery, not file-watchdog tracking');
  const hash = sha256File(absPath);
  if (!hash) throw new Error(`Cannot track: file not readable at ${absPath}`);
  mkdirSync(FOSSIL_DIR, { recursive: true });
  const fossilName = `${hash.slice(0, 16)}-${absPath.replace(/[\\/:]/g, '_').slice(-80)}`;
  const fossilPath = join(FOSSIL_DIR, fossilName);
  copyFileSync(absPath, fossilPath);
  const manifest = loadManifest();
  manifest.tracked[absPath] = { hash, fossil: fossilName, tracked_at: Date.now(), size: statSync(absPath).size };
  manifest.version = (manifest.version || 0) + 1;
  saveManifest(manifest);
  logEvent('tracked', absPath, hash, hash, 'track', `File tracked, fossil stored as ${fossilName}`);
  return { path: absPath, hash, fossil: fossilName };
}

export function untrackFile(filePath) {
  const absPath = resolve(filePath);
  const manifest = loadManifest();
  if (!manifest.tracked[absPath]) return { removed: false };
  delete manifest.tracked[absPath];
  manifest.version = (manifest.version || 0) + 1;
  saveManifest(manifest);
  return { removed: true };
}

export function verifyFile(filePath) {
  const absPath = resolve(filePath);
  const manifest = loadManifest();
  const entry = manifest.tracked[absPath];
  if (!entry) return { tracked: false, path: absPath };
  if (isProtectedMutableFile(absPath)) return { tracked: true, path: absPath, status: 'protected_mutable' };
  const currentHash = sha256File(absPath);
  if (currentHash === null) {
    return { tracked: true, path: absPath, status: 'missing', expected: entry.hash, actual: null };
  }
  if (currentHash === entry.hash) {
    return { tracked: true, path: absPath, status: 'intact', hash: currentHash };
  }
  return { tracked: true, path: absPath, status: 'tampered', expected: entry.hash, actual: currentHash };
}

export function healFile(filePath) {
  const absPath = resolve(filePath);
  if (isProtectedMutableFile(absPath)) return { healed: false, protected: true, reason: 'Mutable state requires coordinated application recovery' };
  const manifest = loadManifest();
  const entry = manifest.tracked[absPath];
  if (!entry) return { healed: false, reason: 'not tracked' };
  const fossilPath = join(FOSSIL_DIR, entry.fossil);
  if (!existsSync(fossilPath)) {
    logEvent('heal_failed', absPath, entry.hash, null, 'no_fossil', 'Fossil backup not found');
    return { healed: false, reason: 'fossil not found' };
  }
  if (isDatabaseFile(fossilPath)) return { healed: false, protected: true, reason: 'SQLite fossil cannot be restored by the file watchdog' };
  const fossilHash = sha256File(fossilPath);
  if (fossilHash !== entry.hash) {
    logEvent('heal_failed', absPath, entry.hash, fossilHash, 'fossil_corrupt', 'Fossil itself is corrupted');
    return { healed: false, reason: 'fossil corrupted' };
  }
  const dir = absPath.substring(0, absPath.lastIndexOf(/[\\/]/.test(absPath) ? absPath.match(/[\\/]/g).pop() : '/'));
  try { mkdirSync(join(absPath, '..'), { recursive: true }); } catch {}
  copyFileSync(fossilPath, absPath);
  logEvent('healed', absPath, entry.hash, sha256File(absPath), 'restored', `Restored from fossil ${entry.fossil}`);
  return { healed: true, fossil: entry.fossil, hash: entry.hash };
}

export function verifyAll() {
  const manifest = loadManifest();
  const results = { intact: 0, tampered: 0, missing: 0, healed: 0, failed: 0, skipped: 0, files: [] };
  for (const [absPath, entry] of Object.entries(manifest.tracked)) {
    const check = verifyFile(absPath);
    if (check.status === 'protected_mutable') {
      results.skipped++;
      results.files.push({ path: absPath, status: check.status, healed: false });
    } else if (check.status === 'intact') {
      results.intact++;
    } else if (check.status === 'tampered') {
      results.tampered++;
      logEvent('tampered', absPath, entry.hash, check.actual, 'detected', 'Hash mismatch detected by watchdog');
      const heal = healFile(absPath);
      if (heal.healed) results.healed++;
      else results.failed++;
      results.files.push({ path: absPath, status: 'tampered', healed: heal.healed });
    } else if (check.status === 'missing') {
      results.missing++;
      logEvent('missing', absPath, entry.hash, null, 'detected', 'File missing, attempting restore');
      const heal = healFile(absPath);
      if (heal.healed) results.healed++;
      else results.failed++;
      results.files.push({ path: absPath, status: 'missing', healed: heal.healed });
    }
  }
  _lastCheck = { ts: Date.now(), results };
  if (results.tampered > 0 || results.missing > 0) {
    _violations.push(_lastCheck);
    if (_violations.length > 100) _violations.shift();
  }
  return results;
}

export function negativeControlVerify(data) {
  const original = Buffer.from(data);
  const originalHash = sha256Buffer(original);
  const tampered = Buffer.from(original);
  if (tampered.length > 0) {
    tampered[0] = (tampered[0] + 1) % 256;
  }
  const tamperedHash = sha256Buffer(tampered);
  const positivePass = sha256Buffer(original) === originalHash;
  const negativePass = tamperedHash !== originalHash;
  return {
    positive: { pass: positivePass, hash: originalHash },
    negative: { pass: negativePass, originalHash, tamperedHash },
    proven: positivePass && negativePass,
    verdict: positivePass && negativePass
      ? 'VERIFIED: intact bytes pass AND tampered bytes fail'
      : 'DENIED: verification is unreliable'
  };
}

export function startWatchdog(opts = {}) {
  if (_interval) return { already_running: true };
  _broadcast = opts.broadcast || null;
  const intervalMs = opts.intervalMs || CHECK_INTERVAL_MS;
  logEvent('watchdog_start', null, null, null, 'start', `Watchdog started, interval ${intervalMs}ms`);
  const results = verifyAll();
  _interval = setInterval(() => {
    try { verifyAll(); }
    catch (e) { console.error('[integrity] watchdog cycle error:', e.message); }
  }, intervalMs);
  _interval.unref?.(); // a finished test or script may exit even though the watchdog was started
  return { started: true, interval_ms: intervalMs, initial_check: results };
}

export function stopWatchdog() {
  if (!_interval) return { already_stopped: true };
  clearInterval(_interval);
  _interval = null;
  logEvent('watchdog_stop', null, null, null, 'stop', 'Watchdog stopped');
  return { stopped: true };
}

export function getManifest() {
  return loadManifest();
}

export function getStatus() {
  const manifest = loadManifest();
  return {
    running: _interval !== null,
    tracked_files: Object.keys(manifest.tracked).length,
    manifest_version: manifest.version,
    last_check: _lastCheck,
    recent_violations: _violations.slice(-10),
    events: db.prepare('SELECT * FROM integrity_events ORDER BY created_at DESC LIMIT 20').all(),
  };
}

export function autoTrackCriticalFiles() {
  const critical = [
    join(DATA_DIR, 'streaming-identity.json'),
  ];
  const tracked = [];
  for (const f of critical) {
    if (existsSync(f)) {
      try {
        const result = trackFile(f);
        tracked.push(result);
      } catch (e) {
        console.error(`[integrity] auto-track failed for ${f}:`, e.message);
      }
    }
  }
  return tracked;
}

export function installIntegrityRoutes(app) {
  app.get('/api/integrity/status', (_req, res) => {
    res.json(getStatus());
  });

  app.get('/api/integrity/manifest', (_req, res) => {
    res.json(getManifest());
  });

  app.post('/api/integrity/verify', (_req, res) => {
    try {
      const results = verifyAll();
      res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/integrity/track', (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const result = trackFile(filePath);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/integrity/untrack', (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const result = untrackFile(filePath);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/integrity/heal', (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const result = healFile(filePath);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/integrity/negative-control', (req, res) => {
    const { data } = req.body || {};
    if (!data) return res.status(400).json({ error: 'data required (base64 or string)' });
    try {
      const buf = Buffer.from(data, 'base64');
      res.json(negativeControlVerify(buf));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/integrity/events', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const events = db.prepare('SELECT * FROM integrity_events ORDER BY created_at DESC LIMIT ?').all(limit);
    res.json({ events });
  });

  app.post('/api/integrity/watchdog/start', (req, res) => {
    const intervalMs = parseInt(req.body?.intervalMs) || CHECK_INTERVAL_MS;
    res.json(startWatchdog({ intervalMs, broadcast: _broadcast }));
  });

  app.post('/api/integrity/watchdog/stop', (_req, res) => {
    res.json(stopWatchdog());
  });
}
