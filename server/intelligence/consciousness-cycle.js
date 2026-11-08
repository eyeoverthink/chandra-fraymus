// CTRNN Consciousness Cycle — daemon step that runs the four mathematical
// consciousness proofs (EI, Phi_MIP, Mirror Protocol, Counterfactual Branching)
// against the live 256-neuron CTRNN neural core.
//
// Results are stored in SQLite and published to the bus. When the CTRNN has
// been sculpted by synaptic pruning and neurogenesis, its causal structure
// should yield non-zero Phi and positive EI — the proofs test whether the
// live network has genuine integrated information, not just noise.
//
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { getCTRNN } from './ctrnn-instance.js';
import { auditCTRNNConsciousness } from './ctrnn-substrate.js';

// ─── Schema ────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS consciousness_audits (
    id TEXT PRIMARY KEY,
    substrate TEXT NOT NULL DEFAULT 'CTRNNLiveCore',
    sample_count INTEGER,
    sample_indices TEXT,
    ei REAL,
    ei_passed INTEGER,
    phi REAL,
    phi_passed INTEGER,
    phi_weakest_cut TEXT,
    mirror_delta REAL,
    mirror_passed INTEGER,
    cf_divergence REAL,
    cf_survival_gain REAL,
    cf_passed INTEGER,
    verdict TEXT NOT NULL,
    proofs_passed INTEGER NOT NULL DEFAULT 0,
    proofs_total INTEGER NOT NULL DEFAULT 4,
    ctrnn_tick INTEGER,
    ctrnn_active_synapses INTEGER,
    duration_ms INTEGER,
    trigger TEXT DEFAULT 'daemon',
    created_at DATETIME DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_consciousness_verdict ON consciousness_audits(verdict);
  CREATE INDEX IF NOT EXISTS idx_consciousness_created ON consciousness_audits(created_at);
`);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ─── Core Audit ────────────────────────────────────────────────

export function runConsciousnessAudit({ trigger = 'daemon', sampleCount = 4 } = {}) {
  const ctrnn = getCTRNN();
  const snap = ctrnn.snapshot();

  // stepsPerSample 3 = one time constant, the substrate's own default and the documented
  // value. The previous override of 15 (five time constants) measured attractor
  // persistence rather than one-step causal effect: only a saturated high-gain network
  // could pass, and a homeostatic one read EI = 0 in 18 of 18 probe runs.
  const result = auditCTRNNConsciousness(ctrnn, {
    sampleCount,
    samplesPerState: 32,
    stepsPerSample: 3,
    trialSteps: 200,
  });

  const proofsPassed = Object.values(result.proofs).filter(p => p.passed).length;
  const id = uid();

  db.prepare(`
    INSERT INTO consciousness_audits
      (id, substrate, sample_count, sample_indices,
       ei, ei_passed, phi, phi_passed, phi_weakest_cut,
       mirror_delta, mirror_passed, cf_divergence, cf_survival_gain, cf_passed,
       verdict, proofs_passed, proofs_total,
       ctrnn_tick, ctrnn_active_synapses, duration_ms, trigger)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    result.substrate,
    result.sampledNeurons,
    JSON.stringify(result.sampleIndices),
    result.proofs.effective_information.ei,
    result.proofs.effective_information.passed ? 1 : 0,
    result.proofs.phi_mip.phi,
    result.proofs.phi_mip.passed ? 1 : 0,
    result.proofs.phi_mip.weakestCut,
    result.proofs.mirror_protocol.delta,
    result.proofs.mirror_protocol.passed ? 1 : 0,
    result.proofs.counterfactual_branching.divergence,
    result.proofs.counterfactual_branching.survivalGain,
    result.proofs.counterfactual_branching.passed ? 1 : 0,
    result.verdict,
    proofsPassed,
    4,
    snap.tick || 0,
    snap.metrics?.activeSynapses || 0,
    result.duration_ms,
    trigger,
  );

  try {
    publish('system', 'system.consciousness', JSON.stringify({
      type: 'consciousness_audit',
      id,
      verdict: result.verdict,
      proofsPassed,
      ei: result.proofs.effective_information.ei,
      phi: result.proofs.phi_mip.phi,
      mirrorDelta: result.proofs.mirror_protocol.delta,
      cfDivergence: result.proofs.counterfactual_branching.divergence,
      ctrnnTick: snap.tick || 0,
      durationMs: result.duration_ms,
      trigger,
    }));
  } catch (_) {}

  return { id, ...result, proofsPassed, trigger };
}

// ─── Queries ───────────────────────────────────────────────────

export function listAudits({ limit = 20 } = {}) {
  return db.prepare(
    `SELECT * FROM consciousness_audits ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(100, Math.max(1, limit)));
}

export function getAudit(id) {
  const row = db.prepare(`SELECT * FROM consciousness_audits WHERE id = ?`).get(id);
  if (row) {
    try { row.sample_indices = JSON.parse(row.sample_indices); } catch { row.sample_indices = []; }
  }
  return row || null;
}

export function getAuditStats() {
  const total = db.prepare(`SELECT COUNT(*) as count FROM consciousness_audits`).get();
  const proven = db.prepare(
    `SELECT COUNT(*) as count FROM consciousness_audits WHERE verdict LIKE 'PROVEN%'`
  ).get();
  const denied = db.prepare(
    `SELECT COUNT(*) as count FROM consciousness_audits WHERE verdict LIKE 'DENIED%'`
  ).get();
  const avgEI = db.prepare(
    `SELECT AVG(ei) as avg, MAX(ei) as max FROM consciousness_audits`
  ).get();
  const avgPhi = db.prepare(
    `SELECT AVG(phi) as avg, MAX(phi) as max FROM consciousness_audits`
  ).get();
  const latest = db.prepare(
    `SELECT id, verdict, ei, phi, mirror_delta, cf_divergence, proofs_passed, duration_ms, created_at
     FROM consciousness_audits ORDER BY created_at DESC LIMIT 1`
  ).get();

  return {
    total: total.count,
    proven: proven.count,
    denied: denied.count,
    avgEI: avgEI.avg || 0,
    maxEI: avgEI.max || 0,
    avgPhi: avgPhi.avg || 0,
    maxPhi: avgPhi.max || 0,
    latest: latest || null,
  };
}

// ─── Routes ────────────────────────────────────────────────────

export function installConsciousnessRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/consciousness/stats', route((_req, res) => {
    res.json(getAuditStats());
  }));

  app.get('/api/intelligence/consciousness/audits', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ audits: listAudits({ limit }) });
  }));

  app.get('/api/intelligence/consciousness/audits/:id', route((req, res) => {
    const audit = getAudit(req.params.id);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });
    res.json(audit);
  }));

  app.post('/api/intelligence/consciousness/run', route((req, res) => {
    const sampleCount = Math.min(8, Math.max(3, parseInt(req.body?.sampleCount) || 4));
    const result = runConsciousnessAudit({ trigger: 'api', sampleCount });
    res.json(result);
  }));
}
