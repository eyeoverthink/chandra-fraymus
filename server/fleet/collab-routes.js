import { Router } from 'express';
import { createCollab, runCollab, getCollab, listCollabs } from './collab.js';

const router = Router();

router.post('/api/collab', async (req, res, next) => {
  try {
    const { goal, strategy, agents, initiator } = req.body;
    const session = createCollab({ initiator, goal, strategy: strategy || 'chain', agents });
    const result = await runCollab(session.id);
    const full = getCollab(session.id);
    res.json(full);
  } catch (e) {
    next(e);
  }
});

router.post('/api/collab/create', (req, res, next) => {
  try {
    const { goal, strategy, agents, initiator } = req.body;
    const session = createCollab({ initiator, goal, strategy: strategy || 'chain', agents });
    res.json(session);
  } catch (e) {
    next(e);
  }
});

router.post('/api/collab/:id/run', async (req, res, next) => {
  try {
    await runCollab(req.params.id);
    const full = getCollab(req.params.id);
    res.json(full);
  } catch (e) {
    next(e);
  }
});

router.get('/api/collab', (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json(listCollabs(limit));
  } catch (e) {
    next(e);
  }
});

router.get('/api/collab/:id', (req, res, next) => {
  try {
    const session = getCollab(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (e) {
    next(e);
  }
});

export function installCollabRoutes(app) {
  app.use(router);
}
