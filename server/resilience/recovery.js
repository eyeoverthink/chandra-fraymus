import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';
import { getAllCircuitStatus } from './circuit-breaker.js';
import { getBackupStats } from './backup.js';

const log = createLogger('recovery');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subsystem TEXT NOT NULL,
    action TEXT NOT NULL,
    trigger_rule TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 1,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ra_created ON recovery_actions(created_at)');
} catch (e) { log.error('recovery migration failed', { err: e.message }); }

const COOLDOWN_MS = 120_000;
const lastRecovery = new Map();

function shouldRecover(subsystem) {
  const last = lastRecovery.get(subsystem) || 0;
  if (Date.now() - last < COOLDOWN_MS) return false;
  return true;
}

function recordRecovery(subsystem, action, rule, success, detail) {
  lastRecovery.set(subsystem, Date.now());
  try {
    db.prepare(`INSERT INTO recovery_actions (subsystem, action, trigger_rule, success, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(subsystem, action, rule, success ? 1 : 0, detail || null, Date.now());
  } catch (_) {}
}

let recoveryInterval = null;
let recoveryTargets = {};

export function initRecovery(targets = {}) {
  recoveryTargets = targets;
}

export function runRecoveryCheck() {
  const results = [];

  try {
    const activeAlerts = db.prepare("SELECT rule, severity, message FROM health_alerts WHERE status = 'active' ORDER BY created_at DESC LIMIT 20").all();

    for (const alert of activeAlerts) {
      if (alert.rule === 'ollama_down' && shouldRecover('ollama')) {
        log.warn('ollama_down detected, marking circuit open');
        recordRecovery('ollama', 'circuit_opened', 'ollama_down', true, 'Ollama unreachable, circuit breaker will handle retry');
        results.push({ subsystem: 'ollama', action: 'circuit_opened', rule: 'ollama_down' });
      }

      if (alert.rule === 'error_spike' && shouldRecover('error_spike')) {
        log.warn('error spike detected, logging recovery event');
        recordRecovery('error_spike', 'logged', 'error_spike', true, alert.message);
        results.push({ subsystem: 'error_spike', action: 'logged', rule: 'error_spike' });
      }
    }
  } catch (e) {
    log.error('recovery check failed', { err: e.message });
  }

  return results;
}

export function startRecoveryMonitor(intervalMs = 60_000) {
  if (recoveryInterval) return;
  recoveryInterval = setInterval(runRecoveryCheck, intervalMs);
  if (recoveryInterval.unref) recoveryInterval.unref();
  log.info('recovery monitor started', { intervalSeconds: intervalMs / 1000 });
}

export function stopRecoveryMonitor() {
  if (recoveryInterval) { clearInterval(recoveryInterval); recoveryInterval = null; }
}

export function getRecoveryStats() {
  const recent = db.prepare('SELECT * FROM recovery_actions ORDER BY created_at DESC LIMIT 30').all();
  const total = db.prepare('SELECT COUNT(*) as c FROM recovery_actions').get()?.c || 0;
  const successCount = db.prepare('SELECT COUNT(*) as c FROM recovery_actions WHERE success = 1').get()?.c || 0;

  return {
    totalActions: total,
    successRate: total > 0 ? Math.round((successCount / total) * 100) : 100,
    recentActions: recent,
    monitorActive: recoveryInterval !== null,
    cooldownMs: COOLDOWN_MS,
  };
}

export function getResilienceDashboard() {
  const circuits = getAllCircuitStatus();
  const backups = getBackupStats();
  const recovery = getRecoveryStats();

  const openCircuits = Object.values(circuits).filter(c => c.state === 'open').length;
  const totalCircuits = Object.keys(circuits).length;

  return {
    status: openCircuits > 0 ? 'degraded' : 'healthy',
    circuits: {
      total: totalCircuits,
      open: openCircuits,
      services: circuits,
    },
    backups: {
      count: backups.backupCount,
      totalSizeMB: backups.totalSizeMB,
      latest: backups.latestBackup,
    },
    recovery: {
      totalActions: recovery.totalActions,
      successRate: recovery.successRate,
      monitorActive: recovery.monitorActive,
    },
  };
}

export function installRecoveryRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/resilience/dashboard', route((_req, res) => {
    res.json(getResilienceDashboard());
  }));

  app.get('/api/resilience/recovery', route((_req, res) => {
    res.json(getRecoveryStats());
  }));

  app.post('/api/resilience/recovery/check', route((_req, res) => {
    const results = runRecoveryCheck();
    res.json({ checked: true, actions: results });
  }));

  app.post('/api/resilience/recovery/start', route((_req, res) => {
    startRecoveryMonitor();
    res.json({ started: true });
  }));

  app.post('/api/resilience/recovery/stop', route((_req, res) => {
    stopRecoveryMonitor();
    res.json({ stopped: true });
  }));
}
