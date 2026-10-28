import {
  openPage, navigatePage, screenshotPage, extractText, extractLinks,
  extractImages, clickElement, scrollPage, closePage, browserStatus,
  closeBrowser,
} from './service.js';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { readFileSync } from 'node:fs';

export function installBrowserRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/browser/status', route(async (_req, res) => {
    res.json(browserStatus());
  }));

  app.post('/api/browser/open', route(async (req, res) => {
    const { url, userAgent } = req.body;
    res.status(201).json(await openPage(url, { userAgent }));
  }));

  app.post('/api/browser/pages/:id/navigate', route(async (req, res) => {
    res.json(await navigatePage(req.params.id, req.body.url));
  }));

  app.post('/api/browser/pages/:id/screenshot', route(async (req, res) => {
    const result = await screenshotPage(req.params.id, req.body);
    res.json(result);
  }));

  app.get('/api/browser/pages/:id/text', route(async (req, res) => {
    res.json(await extractText(req.params.id, { selector: req.query.selector, maxChars: Number(req.query.maxChars) || undefined }));
  }));

  app.get('/api/browser/pages/:id/links', route(async (req, res) => {
    res.json(await extractLinks(req.params.id));
  }));

  app.get('/api/browser/pages/:id/images', route(async (req, res) => {
    res.json(await extractImages(req.params.id));
  }));

  app.post('/api/browser/pages/:id/click', route(async (req, res) => {
    res.json(await clickElement(req.params.id, req.body.selector));
  }));

  app.post('/api/browser/pages/:id/scroll', route(async (req, res) => {
    res.json(await scrollPage(req.params.id, req.body.direction, req.body.amount));
  }));

  app.delete('/api/browser/pages/:id', route(async (req, res) => {
    res.json(await closePage(req.params.id));
  }));

  app.post('/api/browser/shutdown', route(async (_req, res) => {
    await closeBrowser();
    res.json({ ok: true });
  }));

  app.get('/api/browser/screenshots/:filename', (req, res) => {
    const filepath = join(DATA_DIR, 'screenshots', req.params.filename.replace(/[^a-zA-Z0-9_.-]/g, ''));
    try {
      const data = readFileSync(filepath);
      res.type('image/png').send(data);
    } catch { res.status(404).json({ error: 'Screenshot not found' }); }
  });
}
