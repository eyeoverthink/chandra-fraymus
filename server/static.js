import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './config.js';

export function installStatic(app, { production = process.env.NODE_ENV === 'production',
  partnerDist = process.env.CHANDRA_PARTNER_DIST || join(PROJECT_ROOT, '..', 'MyAIPartner', 'dist'),
  vendoredDist = process.env.CHANDRA_VENDORED_PARTNER_DIST || join(PROJECT_ROOT, 'partner-dist'),
  fallbackDist,
  distDir } = {}) {
  const fallbackPartnerDist = distDir || fallbackDist || join(PROJECT_ROOT, 'client', 'dist');
  // vendored real partner build (in-repo, survives fresh clones — no sibling needed):
  const vendoredPartnerDist = vendoredDist;
  const selectedPartnerDist = existsSync(join(partnerDist, 'index.html'))
    ? partnerDist
    : (existsSync(join(vendoredPartnerDist, 'index.html')) ? vendoredPartnerDist : fallbackPartnerDist);
  const index = join(selectedPartnerDist, 'index.html');
  const fallbackIndex = join(fallbackPartnerDist, 'index.html');
  const servePartner = (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(index, error => {
      if (!error || res.headersSent || res.destroyed) return;
      if (index !== fallbackIndex) {
        res.sendFile(fallbackIndex, fallbackError => {
          if (!fallbackError || res.headersSent || res.destroyed) return;
          res.status(fallbackError.code === 'ENOENT' || fallbackError.status === 404 ? 503 : 500).json({
            error: 'partner_build_unavailable',
            message: 'Build the partner UI (CHANDRA_PARTNER_DIST or sibling MyAIPartner/dist) or run npm run build to generate client/dist fallback.',
          });
        });
        return;
      }
      res.status(error.code === 'ENOENT' || error.status === 404 ? 503 : 500).json({
        error: 'partner_build_unavailable',
        message: 'Build the partner UI (CHANDRA_PARTNER_DIST or sibling MyAIPartner/dist) or run npm run build to generate client/dist fallback.',
      });
    });
  };
  // Express's default loose slash matching would redirect /partner/ to itself.
  app.get(/^\/partner$/, (req, res) => res.redirect(`/partner/${req.url.slice('/partner'.length)}`));
  app.get(/^\/partner\/(?:index\.html)?$/, servePartner);
  app.use('/partner/', express.static(selectedPartnerDist, { index: false, redirect: false }));
  // Both entry URLs render the same real application. Its /partner/ asset base
  // remains valid at /; no outer dashboard, iframe or legacy client is served.
  if (production) app.get(/^\/(?:index\.html)?$/, servePartner);
}
