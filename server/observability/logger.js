import { writeFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';

const LOG_DIR = join(DATA_DIR, 'logs');
const MAX_LOG_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
let minLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;
let logBuffer = [];
let flushHandle = null;
let currentLogFile = null;

try { if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function rotateIfNeeded() {
  if (!currentLogFile) currentLogFile = join(LOG_DIR, 'chandra.log');
  try {
    const stats = statSync(currentLogFile);
    if (stats.size < MAX_LOG_SIZE_BYTES) return;
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const from = `${currentLogFile}.${i}`;
      const to = `${currentLogFile}.${i + 1}`;
      try { renameSync(from, to); } catch (_) {}
    }
    renameSync(currentLogFile, `${currentLogFile}.1`);
  } catch (_) {}
}

function flushBuffer() {
  if (logBuffer.length === 0) return;
  const batch = logBuffer.join('\n') + '\n';
  logBuffer = [];
  try {
    rotateIfNeeded();
    writeFileSync(currentLogFile, batch, { flag: 'a' });
  } catch (_) {}
}

function scheduleFlush() {
  if (flushHandle) return;
  flushHandle = setTimeout(() => {
    flushHandle = null;
    flushBuffer();
  }, 1000);
  if (flushHandle.unref) flushHandle.unref();
}

function formatEntry(level, subsystem, message, meta = {}) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    sub: subsystem,
    msg: message,
    ...meta,
  });
}

export function createLogger(subsystem) {
  const log = (level, message, meta) => {
    if (LEVELS[level] < minLevel) return;
    const entry = formatEntry(level, subsystem, message, meta);
    logBuffer.push(entry);
    scheduleFlush();
    if (LEVELS[level] >= LEVELS.warn) {
      process.stderr.write(`[${subsystem}] ${level}: ${message}\n`);
    }
  };

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    fatal: (msg, meta) => log('fatal', msg, meta),
    child: (childSub) => createLogger(`${subsystem}.${childSub}`),
  };
}

export function requestLogger() {
  const log = createLogger('http');
  return (req, res, next) => {
    const start = Date.now();
    const origEnd = res.end;
    res.end = function (...args) {
      const duration = Date.now() - start;
      log.info(`${req.method} ${req.path} ${res.statusCode}`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: duration,
        rid: req.gatewayRequestId || null,
        ip: req.ip || req.headers['x-real-ip'] || null,
      });
      return origEnd.apply(this, args);
    };
    next();
  };
}

export function setLogLevel(level) {
  if (LEVELS[level] !== undefined) {
    minLevel = LEVELS[level];
    return { level, numeric: minLevel };
  }
  return { error: `Unknown level: ${level}. Use: ${Object.keys(LEVELS).join(', ')}` };
}

export function getLogLevel() {
  const name = Object.entries(LEVELS).find(([, v]) => v === minLevel)?.[0] || 'info';
  return { level: name, numeric: minLevel };
}

export function getRecentLogs({ limit = 100, level, subsystem } = {}) {
  const all = [...logBuffer];
  let parsed = all.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  if (level) parsed = parsed.filter(e => LEVELS[e.level] >= LEVELS[level]);
  if (subsystem) parsed = parsed.filter(e => e.sub === subsystem || e.sub?.startsWith(subsystem + '.'));
  return parsed.slice(-Math.min(500, Math.max(1, limit)));
}

export function forceFlush() {
  flushBuffer();
}

export function installLoggerRoutes(app) {
  app.get('/api/observability/logs', (req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
      res.json({ logs: getRecentLogs({ limit, level: req.query.level, subsystem: req.query.sub }) });
    } catch (e) { next(e); }
  });

  app.get('/api/observability/log-level', (_req, res) => {
    res.json(getLogLevel());
  });

  app.post('/api/observability/log-level', (req, res) => {
    const result = setLogLevel(req.body?.level);
    res.json(result);
  });
}
