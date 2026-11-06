import { db } from '../db.js';
import { DATA_DIR } from '../config.js';
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../observability/logger.js';

const log = createLogger('backup');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const MAX_BACKUPS = 10;
const DB_PATH = join(DATA_DIR, 'chandra.db');

try { if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true }); } catch (_) {}

try {
  db.exec(`CREATE TABLE IF NOT EXISTS backup_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    error TEXT,
    created_at INTEGER NOT NULL
  )`);
} catch (e) { log.error('backup migration failed', { err: e.message }); }

function checkpointWAL() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    log.info('WAL checkpoint completed');
  } catch (e) {
    log.warn('WAL checkpoint failed, proceeding with backup', { err: e.message });
  }
}

function pruneOldBackups() {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('chandra-') && f.endsWith('.db'))
      .map(f => ({ name: f, path: join(BACKUP_DIR, f), mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length <= MAX_BACKUPS) return 0;
    let pruned = 0;
    for (const f of files.slice(MAX_BACKUPS)) {
      try { unlinkSync(f.path); pruned++; } catch (_) {}
    }
    if (pruned > 0) log.info('pruned old backups', { pruned, kept: MAX_BACKUPS });
    return pruned;
  } catch (e) {
    log.warn('backup pruning failed', { err: e.message });
    return 0;
  }
}

export function createBackup(trigger = 'manual') {
  const start = Date.now();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `chandra-${ts}.db`;
  const destPath = join(BACKUP_DIR, filename);

  try {
    checkpointWAL();

    if (db.backup) {
      db.backup(destPath);
    } else {
      copyFileSync(DB_PATH, destPath);
    }

    const size = statSync(destPath).size;
    const duration = Date.now() - start;

    try {
      db.prepare(`INSERT INTO backup_history (filename, size_bytes, duration_ms, trigger, status, created_at)
        VALUES (?, ?, ?, ?, 'completed', ?)`).run(filename, size, duration, trigger, Date.now());
    } catch (_) {}

    pruneOldBackups();
    log.info('backup completed', { filename, sizeMB: Math.round(size / 1048576 * 10) / 10, duration });
    return { filename, size, duration, status: 'completed' };
  } catch (e) {
    const duration = Date.now() - start;
    try {
      db.prepare(`INSERT INTO backup_history (filename, size_bytes, duration_ms, trigger, status, error, created_at)
        VALUES (?, 0, ?, ?, 'failed', ?, ?)`).run(filename, duration, trigger, e.message, Date.now());
    } catch (_) {}
    log.error('backup failed', { err: e.message, trigger });
    return { filename, size: 0, duration, status: 'failed', error: e.message };
  }
}

export function listBackups() {
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('chandra-') && f.endsWith('.db'))
      .map(f => {
        const fpath = join(BACKUP_DIR, f);
        const stats = statSync(fpath);
        return { filename: f, size: stats.size, created: stats.mtimeMs };
      })
      .sort((a, b) => b.created - a.created);
    return files;
  } catch (e) {
    return [];
  }
}

export function getBackupStats() {
  const files = listBackups();
  const history = db.prepare('SELECT * FROM backup_history ORDER BY created_at DESC LIMIT 20').all();
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  return {
    backupCount: files.length,
    totalSizeMB: Math.round(totalSize / 1048576 * 10) / 10,
    maxBackups: MAX_BACKUPS,
    backupDir: BACKUP_DIR,
    latestBackup: files[0] || null,
    history,
  };
}

let scheduleHandle = null;

export function startScheduledBackups(intervalMs = 6 * 3600_000) {
  if (scheduleHandle) return;
  scheduleHandle = setInterval(() => createBackup('scheduled'), intervalMs);
  if (scheduleHandle.unref) scheduleHandle.unref();
  log.info('scheduled backups started', { intervalHours: intervalMs / 3600_000 });
}

export function stopScheduledBackups() {
  if (scheduleHandle) { clearInterval(scheduleHandle); scheduleHandle = null; }
}

export function installBackupRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/resilience/backups', route((_req, res) => {
    res.json(getBackupStats());
  }));

  app.post('/api/resilience/backups', route((_req, res) => {
    const result = createBackup('api');
    res.status(result.status === 'completed' ? 201 : 500).json(result);
  }));

  app.post('/api/resilience/backups/schedule', route((req, res) => {
    const hours = Math.min(24, Math.max(1, parseInt(req.body?.intervalHours) || 6));
    startScheduledBackups(hours * 3600_000);
    res.json({ scheduled: true, intervalHours: hours });
  }));

  app.post('/api/resilience/backups/stop', route((_req, res) => {
    stopScheduledBackups();
    res.json({ scheduled: false });
  }));
}
