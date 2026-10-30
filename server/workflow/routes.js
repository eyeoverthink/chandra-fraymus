import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { runPipeline, validateWorkflow } from './engine.js';

const now = () => Date.now();

function getWorkflow(id) {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, nodes: JSON.parse(row.nodes), edges: JSON.parse(row.edges) };
}

function listWorkflows(userId = 'local') {
  return db.prepare('SELECT id, name, is_deployed, deploy_slug, created_at, updated_at FROM workflows WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

export function createWorkflowStore() {
  return {
    get: getWorkflow,
    list: listWorkflows,
    listWorkflows: (userId) => {
      const rows = db.prepare('SELECT * FROM workflows WHERE user_id = ? ORDER BY updated_at DESC').all(userId || 'local');
      return rows.map(r => ({ ...r, nodes: JSON.parse(r.nodes), edges: JSON.parse(r.edges) }));
    },
    getWorkflow: (id) => getWorkflow(id),
    consumeCredit: () => true,
    saveRun: (run) => {
      db.prepare(`INSERT INTO workflow_runs (id, workflow_id, user_id, status, input_prompt, results, final_image_url, final_html, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(), run.workflow_id, run.user_id || 'local', run.status,
        run.input_prompt, JSON.stringify(run.results), run.final_image_url, run.final_html,
        run.duration_ms, now()
      );
    },
  };
}

export function installWorkflowRoutes(app, { broadcast }) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/workflows', (_req, res) => {
    res.json({ workflows: listWorkflows() });
  });

  app.get('/api/workflows/:id', route((req, res) => {
    const wf = getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    res.json(wf);
  }));

  app.post('/api/workflows', route((req, res) => {
    const { name, nodes = [], edges = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return res.status(400).json({ error: 'nodes and edges must be arrays' });
    if (nodes.length > 200) return res.status(400).json({ error: 'too many nodes (200 max)' });
    if (nodes.length) validateWorkflow(nodes, edges);
    const id = randomUUID();
    const t = now();
    db.prepare(`INSERT INTO workflows (id, user_id, name, nodes, edges, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, 'local', name, JSON.stringify(nodes), JSON.stringify(edges), t, t);
    broadcast('workflow', { type: 'created', id });
    res.status(201).json({ id, name });
  }));

  app.put('/api/workflows/:id', route((req, res) => {
    const wf = getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const { name, nodes, edges } = req.body;
    if (nodes && edges) validateWorkflow(nodes, edges);
    db.prepare(`UPDATE workflows SET name = COALESCE(?, name), nodes = COALESCE(?, nodes), edges = COALESCE(?, edges), updated_at = ? WHERE id = ?`)
      .run(name || null, nodes ? JSON.stringify(nodes) : null, edges ? JSON.stringify(edges) : null, now(), req.params.id);
    broadcast('workflow', { type: 'updated', id: req.params.id });
    res.json({ ok: true });
  }));

  app.delete('/api/workflows/:id', route((req, res) => {
    const r = db.prepare('DELETE FROM workflows WHERE id = ? AND user_id = ?').run(req.params.id, 'local');
    if (!r.changes) return res.status(404).json({ error: 'Workflow not found' });
    broadcast('workflow', { type: 'deleted', id: req.params.id });
    res.json({ ok: true });
  }));

  app.post('/api/workflows/:id/run', route(async (req, res) => {
    const wf = getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const result = await runPipeline(wf.nodes, wf.edges, { prompt: req.body?.prompt });
    const runId = randomUUID();
    db.prepare(`INSERT INTO workflow_runs (id, workflow_id, user_id, status, input_prompt, results, final_image_url, final_html, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      runId, wf.id, 'local', result.status, req.body?.prompt || null,
      JSON.stringify(result.results), result.imageUrl || null, result.html || null,
      result.durationMs, now()
    );
    broadcast('workflow', { type: 'run_complete', id: wf.id, runId });
    res.json({ runId, ...result });
  }));

  app.get('/api/workflows/:id/runs', route((req, res) => {
    const runs = db.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
    res.json({ runs: runs.map(r => ({ ...r, results: JSON.parse(r.results || '{}') })) });
  }));

  app.post('/api/workflows/:id/deploy', route((req, res) => {
    const wf = getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const slug = req.body?.slug || wf.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    db.prepare('UPDATE workflows SET is_deployed = 1, deploy_slug = ?, updated_at = ? WHERE id = ?')
      .run(slug, now(), req.params.id);
    broadcast('workflow', { type: 'deployed', id: req.params.id, slug });
    res.json({ deployed: true, slug, endpoint: `/api/run/${slug}` });
  }));

  app.post('/api/run/:slug', route(async (req, res) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE deploy_slug = ? AND is_deployed = 1').get(req.params.slug);
    if (!wf) return res.status(404).json({ error: 'No deployed workflow with that slug' });
    const nodes = JSON.parse(wf.nodes);
    const edges = JSON.parse(wf.edges);
    const result = await runPipeline(nodes, edges, { prompt: req.body?.prompt, image: req.body?.image ? Buffer.from(req.body.image, 'base64') : undefined });
    res.json(result);
  }));
}
