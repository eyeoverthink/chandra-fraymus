import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('circuit-breaker');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS circuit_breaker_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    failure_count INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cbe_service ON circuit_breaker_events(service)');
} catch (e) { log.error('circuit-breaker migration failed', { err: e.message }); }

const DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxCalls: 2,
};

const breakers = new Map();

class CircuitBreaker {
  constructor(service, opts = {}) {
    this.service = service;
    this.failureThreshold = opts.failureThreshold || DEFAULTS.failureThreshold;
    this.resetTimeoutMs = opts.resetTimeoutMs || DEFAULTS.resetTimeoutMs;
    this.halfOpenMaxCalls = opts.halfOpenMaxCalls || DEFAULTS.halfOpenMaxCalls;
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.lastFailureAt = 0;
    this.halfOpenCalls = 0;
    this.totalCalls = 0;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
  }

  _transition(to, reason) {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    log.info(`circuit ${this.service}: ${from} → ${to}`, { reason, failures: this.failures });
    try {
      db.prepare(`INSERT INTO circuit_breaker_events (service, from_state, to_state, failure_count, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(this.service, from, to, this.failures, reason, Date.now());
    } catch (_) {}
  }

  async call(fn) {
    this.totalCalls++;

    if (this.state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
        this._transition('half-open', 'reset timeout elapsed');
        this.halfOpenCalls = 0;
      } else {
        throw new CircuitOpenError(this.service, this.resetTimeoutMs - (Date.now() - this.lastFailureAt));
      }
    }

    if (this.state === 'half-open' && this.halfOpenCalls >= this.halfOpenMaxCalls) {
      throw new CircuitOpenError(this.service, this.resetTimeoutMs);
    }

    if (this.state === 'half-open') this.halfOpenCalls++;

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (e) {
      this._onFailure(e.message);
      throw e;
    }
  }

  _onSuccess() {
    this.totalSuccesses++;
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.halfOpenMaxCalls) {
        this.failures = 0;
        this.successes = 0;
        this._transition('closed', 'half-open calls succeeded');
      }
    } else {
      this.failures = Math.max(0, this.failures - 1);
    }
  }

  _onFailure(reason) {
    this.totalFailures++;
    this.failures++;
    this.lastFailureAt = Date.now();

    if (this.state === 'half-open') {
      this._transition('open', `half-open call failed: ${reason}`);
      this.successes = 0;
    } else if (this.failures >= this.failureThreshold) {
      this._transition('open', `${this.failures} consecutive failures: ${reason}`);
    }
  }

  reset() {
    const prev = this.state;
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
    if (prev !== 'closed') {
      log.info(`circuit ${this.service}: manually reset from ${prev}`);
    }
  }

  status() {
    return {
      service: this.service,
      state: this.state,
      failures: this.failures,
      totalCalls: this.totalCalls,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      lastFailureAt: this.lastFailureAt || null,
      msUntilRetry: this.state === 'open'
        ? Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureAt))
        : 0,
    };
  }
}

export class CircuitOpenError extends Error {
  constructor(service, retryAfterMs) {
    super(`Circuit breaker open for ${service}, retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.service = service;
    this.retryAfterMs = retryAfterMs;
  }
}

export function getCircuitBreaker(service, opts) {
  if (!breakers.has(service)) {
    breakers.set(service, new CircuitBreaker(service, opts));
  }
  return breakers.get(service);
}

export function getAllCircuitStatus() {
  const result = {};
  for (const [name, cb] of breakers) {
    result[name] = cb.status();
  }
  return result;
}

export function installCircuitBreakerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/resilience/circuits', route((_req, res) => {
    const circuits = getAllCircuitStatus();
    const events = db.prepare('SELECT * FROM circuit_breaker_events ORDER BY created_at DESC LIMIT 50').all();
    res.json({ circuits, recentEvents: events });
  }));

  app.post('/api/resilience/circuits/:service/reset', route((req, res) => {
    const cb = breakers.get(req.params.service);
    if (!cb) return res.status(404).json({ error: 'unknown service' });
    cb.reset();
    res.json({ reset: true, ...cb.status() });
  }));
}
