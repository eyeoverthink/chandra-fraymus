import express from 'express';
import { join } from 'node:path';
import { PROJECT_ROOT } from './config.js';

export function installStatic(app, { production = process.env.NODE_ENV === 'production',
  partnerDist = join(PROJECT_ROOT, '..', 'MyAIPartner', 'dist') } = {}) {
  const index = join(partnerDist, 'index.html');
  const servePartner = (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(index, error => {
      if (!error || res.headersSent || res.destroyed) return;
      res.status(error.code === 'ENOENT' || error.status === 404 ? 503 : 500).json({
        error: 'partner_build_unavailable',
        message: 'Build the sibling MyAIPartner application before opening Chandra. Run npm run build from Chandra after installing both repositories\' dependencies.',
      });
    });
  };
  // Express's default loose slash matching would redirect /partner/ to itself.
  app.get(/^\/partner$/, (req, res) => res.redirect(`/partner/${req.url.slice('/partner'.length)}`));
  app.get(/^\/partner\/(?:index\.html)?$/, servePartner);
  app.use('/partner/', express.static(partnerDist, { index: false, redirect: false }));
  // Both entry URLs render the same real application. Its /partner/ asset base
  // remains valid at /; no outer dashboard, iframe or legacy client is served.
  if (production) app.get(/^\/(?:index\.html)?$/, servePartner);
}
