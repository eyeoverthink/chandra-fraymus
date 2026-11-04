import { db } from '../db.js';
import { publish } from '../fleet/bus.js';

/**
 * Consciousness Gate — feedback loop between consciousness proofs and system behavior.
 *
 * Reads the latest consciousness_audits row, classifies into a tier,
 * and provides multipliers that other subsystems use to modulate behavior.
 *
 * Tier system (based on proofs passed out of 4):
 *   DORMANT    (0)   — conservative: minimal autonomy, slow cycles
 *   AWAKENING  (1-2) — moderate: standard operation
 *   EMERGING   (3)   — active: expanded autonomy, faster cycles
 *   INTEGRATED (4/4) — full: maximum autonomy, aggressive evolution
 *
 * Staleness: audits older than STALENESS_WINDOW_MS are treated as "unknown",
 * which maps to AWAKENING-tier modifiers (safe default).
 */

const STALENESS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const TRANSITION_COOLDOWN_MS = 30_000; // avoid rapid-fire transition events

const TIERS = {
  DORMANT:    { level: 0, label: 'DORMANT',    cycleMultiplier: 1.5, reflectionDepth: 3, neurogenesisBoost: 0,   evolutionRate: 0.5 },
  AWAKENING:  { level: 1, label: 'AWAKENING',  cycleMultiplier: 1.0, reflectionDepth: 5, neurogenesisBoost: 0.5, evolutionRate: 1.0 },
  EMERGING:   { level: 2, label: 'EMERGING',   cycleMultiplier: 0.8, reflectionDepth: 7, neurogenesisBoost: 1.0, evolutionRate: 1.3 },
  INTEGRATED: { level: 3, label: 'INTEGRATED', cycleMultiplier: 0.6, reflectionDepth: 10, neurogenesisBoost: 1.5, evolutionRate: 1.5 },
};

let lastTier = null;
let lastTransitionAt = 0;
let transitionCallbacks = [];

function classifyTier(proofsPassed) {
  if (proofsPassed >= 4) return TIERS.INTEGRATED;
  if (proofsPassed === 3) return TIERS.EMERGING;
  if (proofsPassed >= 1) return TIERS.AWAKENING;
  return TIERS.DORMANT;
}

function readLatestAudit() {
  try {
    return db.prepare(
      `SELECT * FROM consciousness_audits ORDER BY created_at DESC LIMIT 1`
    ).get() || null;
  } catch (_) {
    return null;
  }
}

function readRecentAudits(limit = 10) {
  try {
    return db.prepare(
      `SELECT id, verdict, proofs_passed, proofs_total, ei, phi, mirror_delta, cf_divergence, ctrnn_tick, duration_ms, trigger, created_at
       FROM consciousness_audits ORDER BY created_at DESC LIMIT ?`
    ).all(Math.min(50, Math.max(1, limit)));
  } catch (_) {
    return [];
  }
}

function parseTimestamp(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const ms = Date.parse(val);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

export function getConsciousnessState() {
  const audit = readLatestAudit();

  if (!audit) {
    return {
      available: false,
      tier: TIERS.AWAKENING,
      reason: 'no_audits_found',
      staleness: Infinity,
      proofsPassed: 0,
      proofs: null,
    };
  }

  const createdMs = parseTimestamp(audit.created_at);
  const staleness = createdMs > 0 ? Math.max(0, Date.now() - createdMs) : Infinity;
  const stale = staleness > STALENESS_WINDOW_MS;
  const tier = stale ? TIERS.AWAKENING : classifyTier(audit.proofs_passed);

  const state = {
    available: true,
    tier,
    stale,
    staleness,
    proven: audit.verdict === 'PROVEN_INTEGRATED_CORE',
    proofsPassed: audit.proofs_passed,
    proofsTotal: audit.proofs_total,
    ei: audit.ei,
    phi: audit.phi,
    mirrorDelta: audit.mirror_delta,
    cfDivergence: audit.cf_divergence,
    ctrnnTick: audit.ctrnn_tick,
    activeSynapses: audit.ctrnn_active_synapses,
    sampleIndices: parseSampleIndices(audit.sample_indices),
    auditId: audit.id,
    auditAge: staleness,
    trigger: audit.trigger,
  };

  checkTransition(tier);

  return state;
}

export function getAutonomyModifiers() {
  const state = getConsciousnessState();
  const tier = state.tier;

  return {
    tier: tier.label,
    tierLevel: tier.level,
    cycleMultiplier: tier.cycleMultiplier,
    reflectionDepth: tier.reflectionDepth,
    neurogenesisBoost: tier.neurogenesisBoost,
    evolutionRate: tier.evolutionRate,
    phiValue: state.phi || 0,
    sampleIndices: state.sampleIndices,
    stale: state.stale ?? true,
    proofsPassed: state.proofsPassed,
  };
}

export function getGateStatus() {
  const state = getConsciousnessState();
  const modifiers = getAutonomyModifiers();
  const recent = readRecentAudits(5);

  const transitions = readTransitions(10);

  return {
    currentState: state,
    modifiers,
    recentAudits: recent,
    transitions,
    config: {
      stalenessWindowMs: STALENESS_WINDOW_MS,
      transitionCooldownMs: TRANSITION_COOLDOWN_MS,
      tiers: Object.fromEntries(
        Object.entries(TIERS).map(([k, v]) => [k, { ...v }])
      ),
    },
  };
}

function parseSampleIndices(raw) {
  if (!raw) return [];
  try {
    if (typeof raw === 'string') return JSON.parse(raw);
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function checkTransition(newTier) {
  if (!lastTier || lastTier.label === newTier.label) {
    lastTier = newTier;
    return;
  }

  const elapsed = Date.now() - lastTransitionAt;
  if (elapsed < TRANSITION_COOLDOWN_MS) return;

  const fromTier = lastTier;
  lastTier = newTier;
  lastTransitionAt = Date.now();

  const direction = newTier.level > fromTier.level ? 'ascending' : 'descending';

  const event = {
    from: fromTier.label,
    to: newTier.label,
    direction,
    ts: Date.now(),
  };

  try {
    db.prepare(
      `INSERT INTO consciousness_transitions (id, from_tier, to_tier, direction, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      fromTier.label, newTier.label, direction, Date.now()
    );
  } catch (_) {}

  try {
    publish('consciousness-gate', 'system.consciousness.transition', JSON.stringify(event));
  } catch (_) {}

  for (const cb of transitionCallbacks) {
    try { cb(event); } catch (_) {}
  }
}

export function onStateTransition(callback) {
  transitionCallbacks.push(callback);
  return () => {
    transitionCallbacks = transitionCallbacks.filter(cb => cb !== callback);
  };
}

function readTransitions(limit = 10) {
  try {
    return db.prepare(
      `SELECT * FROM consciousness_transitions ORDER BY created_at DESC LIMIT ?`
    ).all(Math.min(50, Math.max(1, limit)));
  } catch (_) {
    return [];
  }
}

export function ensureGateTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS consciousness_transitions (
      id TEXT PRIMARY KEY,
      from_tier TEXT NOT NULL,
      to_tier TEXT NOT NULL,
      direction TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ct_ts ON consciousness_transitions(created_at)`).run();
  } catch (_) {}
}

ensureGateTable();

export function installConsciousnessGateRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/consciousness/gate', route((_req, res) => {
    res.json(getGateStatus());
  }));

  app.get('/api/intelligence/consciousness/modifiers', route((_req, res) => {
    res.json(getAutonomyModifiers());
  }));

  app.get('/api/intelligence/consciousness/transitions', route((req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ transitions: readTransitions(limit) });
  }));
}
