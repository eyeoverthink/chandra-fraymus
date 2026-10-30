import { db } from '../db.js';
import { runPipeline } from '../workflow/engine.js';
import { requireApiKey, optionalApiKey } from './middleware.js';
import { logInvocation, usageBySlug, usageStats, globalStats } from './usage.js';
import { bucketStatus } from './rate-limiter.js';

const now = () => Date.now();

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

export function installDeployRoutes(app, { broadcast, memoryBridge }) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/deploy/catalog', (_req, res) => {
    const rows = db.prepare('SELECT id, name, deploy_slug, updated_at FROM workflows WHERE is_deployed = 1 ORDER BY updated_at DESC').all();
    res.json({ endpoints: rows.map(r => ({ id: r.id, name: r.name, slug: r.deploy_slug, endpoint: `/api/run/${r.deploy_slug}`, updatedAt: r.updated_at })) });
  });

  app.post('/api/workflows/:id/deploy', route((req, res) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const slug = (req.body?.slug || wf.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).slice(0, 40);
    const existing = db.prepare('SELECT id FROM workflows WHERE deploy_slug = ? AND id != ?').get(slug, req.params.id);
    if (existing) return res.status(409).json({ error: `Slug '${slug}' already in use by another workflow` });
    db.prepare('UPDATE workflows SET is_deployed = 1, deploy_slug = ?, updated_at = ? WHERE id = ?')
      .run(slug, now(), req.params.id);
    broadcast('workflow', { type: 'deployed', id: req.params.id, slug });
    const host = process.env.PUBLIC_URL || 'http://127.0.0.1:8787';
    res.json({
      deployed: true, slug,
      endpoint: `/api/run/${slug}`,
      curl: `curl -X POST ${host}/api/run/${slug} -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" -d '{"prompt": "hello"}'`,
    });
  }));

  app.post('/api/workflows/:id/undeploy', route((req, res) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    db.prepare('UPDATE workflows SET is_deployed = 0, deploy_slug = NULL, updated_at = ? WHERE id = ?')
      .run(now(), req.params.id);
    broadcast('workflow', { type: 'undeployed', id: req.params.id });
    res.json({ undeployed: true });
  }));

  app.post('/api/run/:slug', requireApiKey('run'), route(async (req, res) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE deploy_slug = ? AND is_deployed = 1').get(req.params.slug);
    if (!wf) return res.status(404).json({ error: 'No deployed workflow with that slug' });
    const started = now();
    let result, error;
    try {
      const nodes = safeParse(wf.nodes, []);
      const edges = safeParse(wf.edges, []);
      result = await runPipeline(nodes, edges, {
        prompt: req.body?.prompt,
        image: req.body?.image ? Buffer.from(req.body.image, 'base64') : undefined,
        memoryBridge,
      });
    } catch (e) {
      error = e.message;
    }
    const durationMs = now() - started;
    const p = req.apiPrincipal || {};
    logInvocation({
      keyId: p.via || 'unknown',
      keyName: p.via,
      slug: req.params.slug,
      workflowId: wf.id,
      status: error ? 'error' : 'ok',
      durationMs,
      error,
      ip: req.ip,
    });
    broadcast('deploy', { type: 'invocation', slug: req.params.slug, durationMs, status: error ? 'error' : 'ok' });
    if (error) return res.status(500).json({ error, durationMs });
    res.json({ ...result, durationMs });
  }));

  app.get('/api/deploy/usage', route((_req, res) => {
    res.json(globalStats());
  }));

  app.get('/api/deploy/usage/:slug', route((req, res) => {
    const since = req.query.since ? parseInt(req.query.since) : undefined;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
    const stats = usageStats(req.params.slug);
    const recent = usageBySlug(req.params.slug, { limit, since });
    res.json({ stats, recent });
  }));

  app.get('/api/deploy/rate-status', route((req, res) => {
    const principal = req.apiPrincipal;
    if (!principal) return res.json({ note: 'No API key provided — rate limit applies per key' });
    res.json(bucketStatus(principal.via));
  }));
}
