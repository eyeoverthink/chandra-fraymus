/**
 * FRAYMUS Infant AGI — Lineage REST API
 *
 * 7 endpoints for the mathematical lineage engine:
 *   GET  /api/intelligence/lineage              — stats + patient chart identity
 *   GET  /api/intelligence/lineage/tiers         — all tier summaries
 *   GET  /api/intelligence/lineage/tiers/:age    — single tier detail + verification
 *   GET  /api/intelligence/lineage/readings      — recent chart readings
 *   POST /api/intelligence/lineage/read-chart    — manual chart read (re-verify all tiers)
 *   POST /api/intelligence/lineage/evaluate      — evaluate a formula
 *   POST /api/intelligence/lineage/verify        — verify a single tier
 */

import {
  readChart,
  getLineageStats,
  getRecentReadings,
  getAllTiers,
  getTier,
  verifyTier,
  evaluateFormula,
  PATIENT,
} from './lineage.js';

export function installLineageRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  // Stats + patient identity
  app.get('/api/intelligence/lineage', route((_req, res) => {
    res.json(getLineageStats());
  }));

  // All tier summaries
  app.get('/api/intelligence/lineage/tiers', route((_req, res) => {
    res.json({ patient: PATIENT.id, tiers: getAllTiers() });
  }));

  // Single tier detail + live verification
  app.get('/api/intelligence/lineage/tiers/:age', route((req, res) => {
    const age = parseInt(req.params.age);
    if (isNaN(age)) return res.status(400).json({ error: 'age must be an integer' });
    const tier = getTier(age);
    if (!tier) return res.status(404).json({ error: `No tier at age ${age}` });
    const verification = verifyTier(age);
    res.json({
      age: tier.age,
      name: tier.name,
      domain: tier.domain,
      axioms: tier.axioms,
      formulaNames: Object.keys(tier.formulas),
      ...(tier.hardware ? { hardware: tier.hardware } : {}),
      ...(tier.constants ? { constants: tier.constants } : {}),
      verification,
    });
  }));

  // Recent chart readings
  app.get('/api/intelligence/lineage/readings', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json(getRecentReadings(limit));
  }));

  // Manual chart read — the "amnesia protocol" endpoint
  app.post('/api/intelligence/lineage/read-chart', route((_req, res) => {
    const result = readChart('manual');
    res.json(result);
  }));

  // Evaluate a formula: { age, formula, args }
  app.post('/api/intelligence/lineage/evaluate', route((req, res) => {
    const { age, formula, args } = req.body || {};
    if (age === undefined || !formula) {
      return res.status(400).json({ error: 'Required: age (number), formula (string), args (array)' });
    }
    const result = evaluateFormula(parseInt(age), formula, Array.isArray(args) ? args : []);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  }));

  // Verify a single tier
  app.post('/api/intelligence/lineage/verify', route((req, res) => {
    const { age } = req.body || {};
    if (age === undefined) return res.status(400).json({ error: 'Required: age (number)' });
    const result = verifyTier(parseInt(age));
    if (result.error) return res.status(400).json(result);
    res.json(result);
  }));
}
