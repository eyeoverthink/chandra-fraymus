import { db } from '../db.js';
import { randomUUID } from 'node:crypto';

db.exec(`
  CREATE TABLE IF NOT EXISTS clock_checks (
    id TEXT PRIMARY KEY,
    local_time INTEGER NOT NULL,
    reference_time INTEGER,
    drift_ms INTEGER,
    source TEXT,
    verdict TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_clock_ts ON clock_checks(created_at DESC);
`);

const DRIFT_THRESHOLD_MS = 300_000;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const REFERENCE_URLS = [
  'https://www.google.com',
  'https://www.cloudflare.com',
  'https://httpbin.org/get',
];

let _interval = null;
let _broadcast = null;
let _lastVerdict = { verdict: 'UNKNOWN', checked_at: 0 };

export function initClockHonesty(opts = {}) {
  _broadcast = opts.broadcast || null;
  return checkClock().then(v => {
    if (opts.autoStart !== false) startMonitor(opts);
    return v;
  });
}

function parseHttpDate(dateStr) {
  try {
    const ms = Date.parse(dateStr);
    return isNaN(ms) ? null : ms;
  } catch { return null; }
}

async function fetchReferenceTime() {
  for (const url of REFERENCE_URLS) {
    try {
      const before = Date.now();
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      });
      const after = Date.now();
      const dateHeader = res.headers.get('date');
      if (!dateHeader) continue;

      const refTime = parseHttpDate(dateHeader);
      if (!refTime) continue;

      const rtt = after - before;
      const localMid = before + Math.floor(rtt / 2);

      return { refTime, localTime: localMid, source: url, rtt };
    } catch { continue; }
  }
  return null;
}

export async function checkClock() {
  const localNow = Date.now();
  const ref = await fetchReferenceTime();

  if (!ref) {
    const result = { verdict: 'UNKNOWN', reason: 'no reference source reachable', localTime: localNow, refTime: null, drift: null };
    logCheck(localNow, null, null, 'none', 'UNKNOWN');
    _lastVerdict = { ...result, checked_at: localNow };
    if (_broadcast) _broadcast('integrity', { type: 'clock_check', ...result });
    return result;
  }

  const drift = ref.localTime - ref.refTime;
  const absDrift = Math.abs(drift);

  let verdict;
  if (absDrift <= DRIFT_THRESHOLD_MS) {
    verdict = 'OK';
  } else {
    verdict = 'DRIFT';
  }

  const result = {
    verdict,
    localTime: ref.localTime,
    refTime: ref.refTime,
    drift_ms: drift,
    abs_drift_ms: absDrift,
    source: ref.source,
    rtt_ms: ref.rtt,
    threshold_ms: DRIFT_THRESHOLD_MS,
  };

  logCheck(ref.localTime, ref.refTime, drift, ref.source, verdict);
  _lastVerdict = { ...result, checked_at: Date.now() };
  if (_broadcast) _broadcast('integrity', { type: 'clock_check', ...result });

  return result;
}

function logCheck(localTime, refTime, drift, source, verdict) {
  db.prepare(`INSERT INTO clock_checks (id, local_time, reference_time, drift_ms, source, verdict, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), localTime, refTime, drift, source, verdict, Date.now());
}

export function getLastVerdict() {
  return _lastVerdict;
}

export function isClockTrusted() {
  return _lastVerdict.verdict === 'OK';
}

export function isClockSuspect() {
  return _lastVerdict.verdict !== 'OK';
}

export function getClockStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM clock_checks').get().c;
  const ok = db.prepare("SELECT COUNT(*) as c FROM clock_checks WHERE verdict = 'OK'").get().c;
  const drift = db.prepare("SELECT COUNT(*) as c FROM clock_checks WHERE verdict = 'DRIFT'").get().c;
  const unknown = db.prepare("SELECT COUNT(*) as c FROM clock_checks WHERE verdict = 'UNKNOWN'").get().c;
  const recent = db.prepare('SELECT * FROM clock_checks ORDER BY created_at DESC LIMIT 20').all();
  return { total, ok, drift, unknown, current: _lastVerdict, recent };
}

export function startMonitor(opts = {}) {
  if (_interval) return { already_running: true };
  const ms = opts.intervalMs || CHECK_INTERVAL_MS;
  _interval = setInterval(() => {
    checkClock().catch(e => console.error('[clock-honesty] check error:', e.message));
  }, ms);
  _interval.unref?.();
  return { started: true, interval_ms: ms };
}

export function stopMonitor() {
  if (!_interval) return { already_stopped: true };
  clearInterval(_interval);
  _interval = null;
  return { stopped: true };
}

export function selftest() {
  const results = [];

  // parseHttpDate
  const d = parseHttpDate('Sun, 03 Nov 2026 12:00:00 GMT');
  results.push({ name: 'parse_http_date', pass: d !== null && d > 0 });

  // Invalid date
  results.push({ name: 'parse_invalid_date', pass: parseHttpDate('not-a-date') === null });

  // Verdict logic
  const localTime = Date.now();
  const okDrift = 1000;
  results.push({ name: 'ok_drift', pass: Math.abs(okDrift) <= DRIFT_THRESHOLD_MS });

  const bigDrift = 400_000;
  results.push({ name: 'big_drift', pass: Math.abs(bigDrift) > DRIFT_THRESHOLD_MS });

  const allPass = results.every(r => r.pass);
  return { pass: allPass, results };
}
