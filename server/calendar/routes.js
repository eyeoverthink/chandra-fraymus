import { Router } from 'express';
import {
  initSmartCalendarTables, getCalendar, scheduleItem, updateItemStatus,
  cancelItem, getCalendarStats, learnTimingPatterns, suggestSchedule,
} from './smart-calendar.js';

export function installCalendarRoutes(app, { memoryBridge, broadcast } = {}) {
  initSmartCalendarTables();
  const router = Router();

  router.get('/api/calendar', (req, res, next) => {
    try {
      const { status, from, to, limit } = req.query;
      const items = getCalendar({
        status: status || undefined,
        from: from ? parseInt(from) : undefined,
        to: to ? parseInt(to) : undefined,
        limit: parseInt(limit) || 50,
      });
      res.json({ items });
    } catch (e) { next(e); }
  });

  router.get('/api/calendar/stats', (req, res, next) => {
    try {
      res.json(getCalendarStats());
    } catch (e) { next(e); }
  });

  router.post('/api/calendar/schedule', (req, res, next) => {
    try {
      const result = scheduleItem(req.body);
      if (broadcast) broadcast('calendar', { type: 'scheduled', id: result.id, topic: req.body.topic });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/calendar/:id/status', (req, res, next) => {
    try {
      const ok = updateItemStatus(req.params.id, req.body.status, req.body);
      res.json({ updated: ok });
    } catch (e) { next(e); }
  });

  router.delete('/api/calendar/:id', (req, res, next) => {
    try {
      const ok = cancelItem(req.params.id);
      if (ok && broadcast) broadcast('calendar', { type: 'cancelled', id: req.params.id });
      res.json({ cancelled: ok });
    } catch (e) { next(e); }
  });

  router.post('/api/calendar/learn-patterns', async (req, res, next) => {
    try {
      const result = await learnTimingPatterns();
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/calendar/suggest', async (req, res, next) => {
    try {
      const { count, daysAhead } = req.body;
      const result = await suggestSchedule({ count, daysAhead, memoryBridge });
      if (broadcast) broadcast('calendar', { type: 'suggestions', count: result.suggestions?.length || 0 });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.use(router);
}
