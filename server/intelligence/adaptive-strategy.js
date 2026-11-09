/**
 * Phase 15 — Adaptive Strategy Engine: Metacognitive → Behavioral Change
 *
 * Consumes Phase 14's metacognitive assessments and translates abstract
 * strategy recommendations (nominal/diversify/conserve/calibrate) into
 * concrete parameter adjustments that other subsystems query. Closes the
 * full detect → assess → adjust → act → detect feedback loop.
 *
 * Born from debate analysis: the system can argue abstractly about
 * autonomy scaling (debate 1, 80% proponent win) but cannot propose
 * concrete parameters (debate 2, draw). This module bridges that gap.
 *
 * Adaptive CTRNN regions (row 12 — between sensory-action and motor):
 *   Adaptation pressure  (12, 4)   σ=1.5  — magnitude of behavioral adjustment
 *   Strategy mode signal  (12, 12)  σ=1.5  — active strategy encoding
 *
 * Runs synchronously (called by metacognitive monitor each assessment).
 * Consciousness-aware: gate evolutionRate scales adaptation sensitivity.
 */

import { db } from '../db.js';
import { getCTRNN } from './ctrnn-instance.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const SNAPSHOT_EVERY = 30;
const ANTI_FLICKER_MS = 120_000;
const BASE_ADAPT_SENSITIVITY = 0.5;

const STRATEGY_ENCODING = {
  nominal:   0.0,
  diversify: 0.6,
  conserve:  -0.4,
  calibrate: 0.3,
};

const ADAPTIVE_REGIONS = {
  pressure: { tx: 12, ty: 4,  sigma: 1.5, label: 'Adaptation pressure' },
  mode:     { tx: 12, ty: 12, sigma: 1.5, label: 'Strategy mode signal' },
};

const STRATEGY_PARAMS = {
  nominal: {
    cycleMultiplier: 1.0,
    reflectionCap: null,
    opegToleranceScale: 1.0,
    preferredActions: null,
    suppressedActions: [],
    neurogenesisFloorAdjust: 0,
    description: 'All systems nominal — no adjustments needed',
  },
  // Action keys (Phase V): generation and execution are distinct —
  //   goal_generate (goal engine proposes)   vs   goal_execute (executor drains the queue)
  //   debate, verify, forge, synthesize, neurogenesis, dream, consciousness_audit, reflect, communicate
  //   goal_seek = the motor region that executes-then-generates (suppress only when both should stop)
  diversify: {
    cycleMultiplier: 0.8,
    reflectionCap: 7,
    opegToleranceScale: 1.2,
    preferredActions: ['dream', 'consciousness_audit', 'goal_execute'],
    suppressedActions: ['forge', 'synthesize', 'goal_generate'],
    neurogenesisFloorAdjust: -0.03,
    description: 'Stuck pattern — diversify action types, suppress repetition, drain the goal queue, encourage dreams and new connections',
  },
  // Inverted 2026-11-09. The old conserve suppressed goal_seek (which the EXECUTOR honoured
  // and the generator did not) and preferred reflect — so low effectiveness → fewer
  // outcomes → lower effectiveness, while reflections kept spawning debates. Conserve now
  // means: stop talking, finish what you started. Suppress everything that generates new
  // cognition; keep executing goals, since outcomes are the only way effectiveness recovers.
  conserve: {
    cycleMultiplier: 1.5,
    reflectionCap: 2,
    opegToleranceScale: 0.7,
    preferredActions: ['goal_execute'],
    suppressedActions: ['forge', 'synthesize', 'neurogenesis', 'goal_generate', 'debate', 'verify', 'dream', 'self_modify'],
    neurogenesisFloorAdjust: 0.05,
    description: 'Low effectiveness — stop generating cognition (debates, verifier loops, forges, new goals, dreams); keep draining the goal queue so outcomes can recover',
  },
  calibrate: {
    cycleMultiplier: 1.0,
    reflectionCap: 5,
    opegToleranceScale: 0.6,
    preferredActions: ['verify', 'goal_execute'],
    suppressedActions: ['forge', 'synthesize', 'goal_generate', 'self_modify'],
    neurogenesisFloorAdjust: 0,
    description: 'Poor prediction accuracy — tighten OPEG gates, verify before autonomous changes, no new self-modification',
  },
};

let adaptiveState = {
  activeStrategy: 'nominal',
  lastSwitchedAt: 0,
  switchCount: 0,
  assessmentsInCurrentStrategy: 0,
  totalAdaptations: 0,
  lastInjections: {},
  currentModifiers: { ...STRATEGY_PARAMS.nominal },
  lastUpdatedAt: 0,
  flickerGuardActive: false,
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS adaptive_strategy_events (
      id TEXT PRIMARY KEY,
      strategy TEXT NOT NULL,
      effectiveness REAL,
      stuck_score REAL,
      confidence REAL,
      modifiers TEXT,
      injections TEXT,
      gate_tier TEXT,
      sensitivity REAL,
      trigger_reason TEXT,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_adaptive_ts ON adaptive_strategy_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function updateAdaptiveStrategy(metacogResult) {
  if (!metacogResult || !metacogResult.strategy) return adaptiveState;

  const newStrategy = metacogResult.strategy.strategy || 'nominal';
  const prevStrategy = adaptiveState.activeStrategy;

  const gateMods = getAutonomyModifiers();
  const sensitivity = clamp(
    BASE_ADAPT_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3,
    0.2, 1.0
  );

  const timeSinceSwitch = now() - adaptiveState.lastSwitchedAt;
  const flickerGuard = timeSinceSwitch < ANTI_FLICKER_MS && adaptiveState.lastSwitchedAt > 0;

  if (newStrategy !== prevStrategy && !flickerGuard) {
    adaptiveState.activeStrategy = newStrategy;
    adaptiveState.lastSwitchedAt = now();
    adaptiveState.switchCount++;
    adaptiveState.assessmentsInCurrentStrategy = 0;
    adaptiveState.currentModifiers = { ...STRATEGY_PARAMS[newStrategy] };
    adaptiveState.flickerGuardActive = false;

    try {
      publish('adaptive-strategy', 'system.adaptation.strategy-applied', JSON.stringify({
        from: prevStrategy,
        to: newStrategy,
        reason: metacogResult.strategy.reason,
        modifiers: STRATEGY_PARAMS[newStrategy],
        effectiveness: metacogResult.effectiveness,
        stuckScore: metacogResult.stuckScore,
        confidence: metacogResult.confidence,
        tier: gateMods.tier,
        ts: now(),
      }));
    } catch (_) {}
  } else if (newStrategy !== prevStrategy && flickerGuard) {
    adaptiveState.flickerGuardActive = true;
  }

  adaptiveState.assessmentsInCurrentStrategy++;
  adaptiveState.totalAdaptations++;
  adaptiveState.lastUpdatedAt = now();

  const ctrnn = getCTRNN();
  const injections = {};
  if (ctrnn.running) {
    const adaptationMagnitude = newStrategy === 'nominal' ? 0 :
      Math.abs(metacogResult.stuckScore || 0) + Math.abs(1 - (metacogResult.effectiveness || 0.5)) + Math.abs(0.5 - (metacogResult.confidence || 0.5));
    const pressureAmp = clamp(adaptationMagnitude * sensitivity * 1.5, 0, 1.2);
    if (pressureAmp > 0.01) {
      ctrnn.inject(ADAPTIVE_REGIONS.pressure.tx, ADAPTIVE_REGIONS.pressure.ty, ADAPTIVE_REGIONS.pressure.sigma, pressureAmp);
      injections.pressure = Math.round(pressureAmp * 1000) / 1000;
    }

    const modeSignal = STRATEGY_ENCODING[adaptiveState.activeStrategy] || 0;
    const modeAmp = modeSignal * sensitivity;
    if (Math.abs(modeAmp) > 0.01) {
      ctrnn.inject(ADAPTIVE_REGIONS.mode.tx, ADAPTIVE_REGIONS.mode.ty, ADAPTIVE_REGIONS.mode.sigma, modeAmp);
      injections.mode = Math.round(modeAmp * 1000) / 1000;
    }
  }

  adaptiveState.lastInjections = injections;

  if (adaptiveState.totalAdaptations % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(
        `INSERT INTO adaptive_strategy_events (id, strategy, effectiveness, stuck_score, confidence, modifiers, injections, gate_tier, sensitivity, trigger_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        adaptiveState.activeStrategy,
        metacogResult.effectiveness || 0,
        metacogResult.stuckScore || 0,
        metacogResult.confidence || 0.5,
        JSON.stringify(adaptiveState.currentModifiers),
        JSON.stringify(injections),
        gateMods.tier,
        Math.round(sensitivity * 1000) / 1000,
        metacogResult.strategy?.reason || '',
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM adaptive_strategy_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return adaptiveState;
}

export function getAdaptiveModifiers() {
  const params = STRATEGY_PARAMS[adaptiveState.activeStrategy] || STRATEGY_PARAMS.nominal;
  return {
    strategy: adaptiveState.activeStrategy,
    ...params,
    assessmentsInCurrentStrategy: adaptiveState.assessmentsInCurrentStrategy,
    flickerGuardActive: adaptiveState.flickerGuardActive,
  };
}

export function isActionSuppressed(actionType) {
  const mods = getAdaptiveModifiers();
  return mods.suppressedActions.includes(actionType);
}

export function isActionPreferred(actionType) {
  const mods = getAdaptiveModifiers();
  return mods.preferredActions ? mods.preferredActions.includes(actionType) : false;
}

export function resetAdaptiveStrategy() {
  adaptiveState = {
    activeStrategy: 'nominal',
    lastSwitchedAt: 0,
    switchCount: 0,
    assessmentsInCurrentStrategy: 0,
    totalAdaptations: 0,
    lastInjections: {},
    currentModifiers: { ...STRATEGY_PARAMS.nominal },
    lastUpdatedAt: 0,
    flickerGuardActive: false,
  };
  return { reset: true };
}

export function getAdaptiveStatus() {
  const gateMods = getAutonomyModifiers();
  return {
    ...adaptiveState,
    regions: ADAPTIVE_REGIONS,
    strategyParams: STRATEGY_PARAMS,
    gateTier: gateMods.tier,
    sensitivity: clamp(BASE_ADAPT_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3, 0.2, 1.0),
    antiFlickerMs: ANTI_FLICKER_MS,
  };
}

export function getAdaptiveHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM adaptive_strategy_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function installAdaptiveStrategyRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/adaptive-strategy', route((_req, res) => {
    res.json(getAdaptiveStatus());
  }));

  app.get('/api/intelligence/adaptive-strategy/modifiers', route((_req, res) => {
    res.json(getAdaptiveModifiers());
  }));

  app.get('/api/intelligence/adaptive-strategy/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getAdaptiveHistory({ limit }) });
  }));

  app.get('/api/intelligence/adaptive-strategy/check', route((req, res) => {
    const action = req.query.action;
    if (!action) return res.status(400).json({ error: 'action query param required' });
    res.json({
      action,
      suppressed: isActionSuppressed(action),
      preferred: isActionPreferred(action),
      strategy: adaptiveState.activeStrategy,
    });
  }));

  app.post('/api/intelligence/adaptive-strategy/reset', route((_req, res) => {
    res.json(resetAdaptiveStrategy());
  }));
}
