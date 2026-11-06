import {
  ensureDossierTable,
  processDossier,
  parseDossier,
  gradeDossier,
  debateDossierFunctions,
  listDossiers,
  getDossier,
  getDossierFunctions,
  getDossierFunction,
} from './dossier-engine.js';

export function installDossierRoutes(app) {
  ensureDossierTable();

  // POST /api/intelligence/dossier/ingest — full pipeline: parse → grade → store → bus event
  app.post('/api/intelligence/dossier/ingest', (req, res, next) => {
    try {
      const { dossierPath } = req.body;
      if (!dossierPath || typeof dossierPath !== 'string') {
        return res.status(400).json({ error: 'dossierPath required' });
      }
      const result = processDossier(dossierPath);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/intelligence/dossier — list ingested dossiers
  app.get('/api/intelligence/dossier', (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);
      res.json(listDossiers({ limit, offset }));
    } catch (e) {
      next(e);
    }
  });

  // GET /api/intelligence/dossier/:sha — get dossier detail by binary SHA
  app.get('/api/intelligence/dossier/:sha', (req, res, next) => {
    try {
      const result = getDossier(req.params.sha);
      if (!result) return res.status(404).json({ error: 'Dossier not found' });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/intelligence/dossier/:sha/functions — list functions in a dossier
  app.get('/api/intelligence/dossier/:sha/functions', (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);
      res.json(getDossierFunctions(req.params.sha, { limit, offset }));
    } catch (e) {
      next(e);
    }
  });

  // GET /api/intelligence/dossier/:sha/functions/:name — get single function detail
  app.get('/api/intelligence/dossier/:sha/functions/:name', (req, res, next) => {
    try {
      const result = getDossierFunction(req.params.sha, req.params.name);
      if (!result) return res.status(404).json({ error: 'Function not found in dossier' });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // POST /api/intelligence/dossier/debate — run adversarial debate on top dossier functions
  app.post('/api/intelligence/dossier/debate', async (req, res, next) => {
    try {
      const { dossierPath, maxFunctions } = req.body;
      if (!dossierPath || typeof dossierPath !== 'string') {
        return res.status(400).json({ error: 'dossierPath required' });
      }
      const parsed = parseDossier(dossierPath);
      const graded = gradeDossier(parsed);
      const opts = {};
      if (maxFunctions) opts.maxFunctions = Math.min(20, Math.max(1, parseInt(maxFunctions) || 10));
      const result = await debateDossierFunctions(parsed, graded, opts);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
}
