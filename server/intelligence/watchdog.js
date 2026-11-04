import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();

// ── Schema ─────────────────────────────────────────────────────
// File-level checksum watchdog with automatic fossil restoration.
// Ported from FRAYNIX FraymusDreamer120BDaemon.java verifyAndSelfHeal().

export function migrateWatchdog() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchdog_files (
      path TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'system',
      registered_at INTEGER NOT NULL,
      last_verified_at INTEGER NOT NULL,
      heal_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS watchdog_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wd_events ON watchdog_events(created_at DESC);
  `);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sha256File(filePath) {
  const content = readFileSync(filePath);
  return sha256(content);
}

// ── Configuration ──────────────────────────────────────────────

const FOSSIL_DIR = join(process.cwd(), 'data', 'fossil-archive');
const POLL_INTERVAL_MS = 60_000;
let watchdogTimer = null;
let watchdogState = {
  running: false,
  lastScanAt: 0,
  scansRun: 0,
  healsPerformed: 0,
  filesWatched: 0,
};

// ── Core Operations ────────────────────────────────────────────

// Register a file for watchdog monitoring. Creates fossil backup.
export function register(filePath, category = 'system') {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const hash = sha256File(filePath);
  const ts = now();

  db.prepare(`
    INSERT INTO watchdog_files (path, sha256, category, registered_at, last_verified_at, heal_count)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, last_verified_at = excluded.last_verified_at
  `).run(filePath, hash, category, ts, ts);

  // Create fossil backup
  if (!existsSync(FOSSIL_DIR)) mkdirSync(FOSSIL_DIR, { recursive: true });
  const fossilPath = join(FOSSIL_DIR, `${basename(filePath)}.${hash.slice(0, 12)}.bak`);
  copyFileSync(filePath, fossilPath);

  logEvent(filePath, 'registered', `sha256=${hash.slice(0, 16)}… category=${category}`);
  return { path: filePath, sha256: hash, fossil: fossilPath };
}

// Update a file's known-good hash (after legitimate modification).
export function updateHash(filePath) {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const hash = sha256File(filePath);
  db.prepare('UPDATE watchdog_files SET sha256 = ?, last_verified_at = ? WHERE path = ?')
    .run(hash, now(), filePath);

  // Update fossil
  if (!existsSync(FOSSIL_DIR)) mkdirSync(FOSSIL_DIR, { recursive: true });
  const fossilPath = join(FOSSIL_DIR, `${basename(filePath)}.${hash.slice(0, 12)}.bak`);
  copyFileSync(filePath, fossilPath);

  logEvent(filePath, 'hash_updated', `sha256=${hash.slice(0, 16)}…`);
  return { path: filePath, sha256: hash };
}

// Unregister a file from watchdog monitoring.
export function unregister(filePath) {
  db.prepare('DELETE FROM watchdog_files WHERE path = ?').run(filePath);
  logEvent(filePath, 'unregistered', null);
}

// Single-file verify. Returns { ok, path, expected, actual }.
export function verifyFile(filePath) {
  const row = db.prepare('SELECT sha256 FROM watchdog_files WHERE path = ?').get(filePath);
  if (!row) return { ok: null, path: filePath, error: 'not_registered' };
  if (!existsSync(filePath)) return { ok: false, path: filePath, error: 'file_missing', expected: row.sha256 };

  const actual = sha256File(filePath);
  const ok = actual === row.sha256;

  db.prepare('UPDATE watchdog_files SET last_verified_at = ? WHERE path = ?').run(now(), filePath);

  return { ok, path: filePath, expected: row.sha256, actual };
}

// Find the newest fossil backup for a file.
function findFossil(filePath, expectedHash) {
  if (!existsSync(FOSSIL_DIR)) return null;

  const base = basename(filePath);
  const fossils = readdirSync(FOSSIL_DIR)
    .filter(f => f.startsWith(base + '.') && f.endsWith('.bak'))
    .map(f => join(FOSSIL_DIR, f));

  // Prefer the fossil matching the expected hash
  if (expectedHash) {
    const exactMatch = fossils.find(f => f.includes(expectedHash.slice(0, 12)));
    if (exactMatch && existsSync(exactMatch)) return exactMatch;
  }

  // Fall back to any fossil for this file (newest by mtime)
  const withStats = fossils
    .filter(f => existsSync(f))
    .map(f => ({ path: f, mtime: readFileSync.length })); // sort by name (hash suffix acts as version)

  return withStats.length > 0 ? fossils[fossils.length - 1] : null;
}

// Heal a corrupted file from its fossil backup.
export function heal(filePath) {
  const row = db.prepare('SELECT sha256 FROM watchdog_files WHERE path = ?').get(filePath);
  if (!row) return { healed: false, error: 'not_registered' };

  const fossil = findFossil(filePath, row.sha256);
  if (!fossil) return { healed: false, error: 'no_fossil_found' };

  // Verify fossil integrity before restoring
  const fossilHash = sha256File(fossil);
  if (fossilHash !== row.sha256) {
    logEvent(filePath, 'heal_failed', `fossil hash mismatch: ${fossilHash.slice(0, 16)}… != ${row.sha256.slice(0, 16)}…`);
    return { healed: false, error: 'fossil_corrupted' };
  }

  copyFileSync(fossil, filePath);
  db.prepare('UPDATE watchdog_files SET last_verified_at = ?, heal_count = heal_count + 1 WHERE path = ?')
    .run(now(), filePath);

  logEvent(filePath, 'healed', `restored from ${basename(fossil)}`);
  watchdogState.healsPerformed++;
  return { healed: true, fossil: basename(fossil), sha256: row.sha256 };
}

// ── Full Scan ──────────────────────────────────────────────────

export function scan() {
  const files = db.prepare('SELECT path, sha256, category FROM watchdog_files ORDER BY category, path').all();
  const results = { scanned: 0, ok: 0, corrupted: 0, missing: 0, healed: 0, failed: 0, details: [] };

  for (const file of files) {
    results.scanned++;
    if (!existsSync(file.path)) {
      results.missing++;
      const healResult = heal(file.path);
      if (healResult.healed) {
        results.healed++;
        results.details.push({ path: file.path, status: 'healed_missing' });
      } else {
        results.failed++;
        results.details.push({ path: file.path, status: 'missing_no_fossil', error: healResult.error });
      }
      continue;
    }

    const actual = sha256File(file.path);
    if (actual === file.sha256) {
      results.ok++;
      db.prepare('UPDATE watchdog_files SET last_verified_at = ? WHERE path = ?').run(now(), file.path);
      continue;
    }

    results.corrupted++;
    logEvent(file.path, 'corruption_detected', `expected=${file.sha256.slice(0, 16)}… actual=${actual.slice(0, 16)}…`);

    const healResult = heal(file.path);
    if (healResult.healed) {
      results.healed++;
      results.details.push({ path: file.path, status: 'healed_corruption' });
    } else {
      results.failed++;
      results.details.push({ path: file.path, status: 'corruption_no_heal', error: healResult.error });
    }
  }

  watchdogState.lastScanAt = now();
  watchdogState.scansRun++;
  watchdogState.filesWatched = files.length;

  // Alert on corruption via bus
  if (results.corrupted > 0 || results.missing > 0) {
    try {
      publish('system', 'system.watchdog', JSON.stringify({
        event: 'corruption_scan',
        corrupted: results.corrupted,
        missing: results.missing,
        healed: results.healed,
        failed: results.failed,
        at: now(),
      }));
    } catch (_) {}
  }

  return results;
}

// ── Scheduled Monitoring ───────────────────────────────────────

export function startWatchdog(intervalMs = POLL_INTERVAL_MS) {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogState.running = true;

  watchdogTimer = setInterval(() => {
    try {
      scan();
    } catch (e) {
      console.error('watchdog scan error:', e.message);
    }
  }, intervalMs);

  // Initial scan
  try { scan(); } catch (_) {}

  return { started: true, intervalMs, filesWatched: watchdogState.filesWatched };
}

export function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  watchdogState.running = false;
  return { stopped: true };
}

export function status() {
  return { ...watchdogState };
}

// ── Event Log ──────────────────────────────────────────────────

function logEvent(path, eventType, detail) {
  db.prepare('INSERT INTO watchdog_events (path, event_type, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(path, eventType, detail, now());
}

export function recentEvents(limit = 50) {
  return db.prepare('SELECT * FROM watchdog_events ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function registeredFiles() {
  return db.prepare('SELECT * FROM watchdog_files ORDER BY category, path').all();
}

// ── Selftest ───────────────────────────────────────────────────
// Proves: (1) register captures hash, (2) corruption detected,
// (3) fossil restores original, (4) clean file passes.
// Uses real files in data/fossil-archive. Deterministic, no LLM.

export function selftest() {
  const testDir = join(process.cwd(), 'data', 'watchdog-selftest');
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  const testFile = join(testDir, `test-${now()}.txt`);
  const results = [];

  try {
    // Test 1: register a file
    writeFileSync(testFile, 'original content for watchdog selftest');
    const reg = register(testFile, 'selftest');
    results.push({ test: 'register', pass: reg.sha256.length === 64 });

    // Test 2: clean file verifies ok
    const v1 = verifyFile(testFile);
    results.push({ test: 'clean_verify', pass: v1.ok === true });

    // Test 3: corrupt the file → detected
    writeFileSync(testFile, 'CORRUPTED CONTENT');
    const v2 = verifyFile(testFile);
    results.push({ test: 'corruption_detected', pass: v2.ok === false && v2.actual !== v2.expected });

    // Test 4: heal restores original
    const h = heal(testFile);
    results.push({ test: 'heal_restores', pass: h.healed === true });

    // Test 5: after heal, verify passes
    const v3 = verifyFile(testFile);
    results.push({ test: 'post_heal_verify', pass: v3.ok === true });

    // Cleanup
    unregister(testFile);
    try { unlinkSync(testFile); } catch (_) {}
  } catch (e) {
    results.push({ test: 'exception', pass: false, error: e.message });
  }

  const allPass = results.every(r => r.pass);
  return { ok: allPass, tests: results };
}
