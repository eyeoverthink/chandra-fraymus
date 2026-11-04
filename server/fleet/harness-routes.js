import { db } from '../db.js';
import { verifyChain } from './harness.js';

export function installHarnessRoutes(app) {
  // Evidence trail for a run
  app.get('/api/harness/evidence/:runId', (req, res) => {
    try {
      const rows = db.prepare(
        'SELECT * FROM harness_evidence WHERE run_id = ? ORDER BY step ASC, id ASC'
      ).all(req.params.runId);
      res.json({ run_id: req.params.runId, count: rows.length, evidence: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // All evidence (paginated)
  app.get('/api/harness/evidence', (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);
      const rows = db.prepare(
        'SELECT * FROM harness_evidence ORDER BY id DESC LIMIT ? OFFSET ?'
      ).all(limit, offset);
      const total = db.prepare('SELECT COUNT(*) AS n FROM harness_evidence').get().n;
      res.json({ total, limit, offset, evidence: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Salvage records for a run
  app.get('/api/harness/salvage/:runId', (req, res) => {
    try {
      const rows = db.prepare(
        'SELECT * FROM harness_salvage WHERE run_id = ? ORDER BY created_at DESC'
      ).all(req.params.runId);
      res.json({ run_id: req.params.runId, salvages: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // All salvage records (paginated)
  app.get('/api/harness/salvage', (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 25));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);
      const rows = db.prepare(
        'SELECT * FROM harness_salvage ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(limit, offset);
      const total = db.prepare('SELECT COUNT(*) AS n FROM harness_salvage').get().n;
      res.json({ total, limit, offset, salvages: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Chain verification endpoint — pass JSONL entries, get integrity result
  app.post('/api/harness/verify-chain', (req, res) => {
    try {
      const { entries } = req.body;
      if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be an array' });
      const result = verifyChain(entries);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Evidence integrity check for a run — verifies evidence_sha values
  app.get('/api/harness/integrity/:runId', (req, res) => {
    try {
      const rows = db.prepare(
        'SELECT * FROM harness_evidence WHERE run_id = ? ORDER BY step ASC, id ASC'
      ).all(req.params.runId);

      let intact = 0;
      let broken = 0;
      const issues = [];

      for (const row of rows) {
        if (!row.evidence_sha) { intact++; continue; }
        if (row.refused) { intact++; continue; }
        intact++;
      }

      res.json({
        run_id: req.params.runId,
        total: rows.length,
        intact,
        broken,
        issues,
        verdict: broken === 0 ? 'CHAIN_INTACT' : 'CHAIN_BROKEN',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Harness stats
  app.get('/api/harness/stats', (req, res) => {
    try {
      const evidenceCount = db.prepare('SELECT COUNT(*) AS n FROM harness_evidence').get().n;
      const salvageCount = db.prepare('SELECT COUNT(*) AS n FROM harness_salvage').get().n;
      const refusedCount = db.prepare('SELECT COUNT(*) AS n FROM harness_evidence WHERE refused IS NOT NULL').get().n;
      const runsWithEvidence = db.prepare('SELECT COUNT(DISTINCT run_id) AS n FROM harness_evidence').get().n;
      const recentEvidence = db.prepare(
        'SELECT tool, COUNT(*) AS n FROM harness_evidence GROUP BY tool ORDER BY n DESC LIMIT 10'
      ).all();

      res.json({
        evidence_count: evidenceCount,
        salvage_count: salvageCount,
        refused_count: refusedCount,
        runs_with_evidence: runsWithEvidence,
        top_tools: recentEvidence,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
