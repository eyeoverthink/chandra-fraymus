import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

const route = fn => (req, res, next) => Promise.resolve()
  .then(() => fn(req, res))
  .catch(error => {
    if (res.headersSent) return next(error);
    const aborted = error?.name === 'AbortError' || error?.message === 'cancelled';
    if (!aborted) console.error('fraymus-os:', error.message);
    res.status(error.status || (aborted ? 499 : 500)).json({
      error: aborted ? 'Cancelled. No further action was run.' : (error.message || 'request failed'),
      ...(error.artifact ? { artifact: error.artifact } : {}),
      ...(error.fallback ? { fallback: error.fallback, available: false } : {}),
    });
  });

export function installFraymusOsRoutes(app, options = {}) {
  const os = options.os;
  if (!os) throw new Error('fraymus-os routes require a created service');
  const { db } = os;

  app.get('/api/fraymus-os/status', route(async (_req, res) => {
    const snapshot = await os.registry.snapshot();
    const voice = await os.voice.status();
    res.json({
      name: 'F.R.A.Y.M.U.S.',
      expansion: 'Fractal Reasoning, Adaptive Yield — Memory Unified System',
      ...snapshot,
      voice,
      telemetry: os.telemetry.summary(),
      suggestedPrompts: os.command.suggest,
      brain: os.command.brain(),
      deck: os.command.deck,
    });
  }));

  app.get('/api/fraymus-os/telemetry', route((_req, res) => {
    res.json(os.telemetry.summary());
  }));

  app.get('/api/fraymus-os/telemetry/log', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ requests: os.telemetry.list(limit) });
  }));

  app.get('/api/fraymus-os/graph', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    res.json(await os.graph.query({
      q: String(req.query.q || ''),
      kind: String(req.query.kind || ''),
      cursor: String(req.query.cursor || '0'),
      limit,
    }));
  }));

  app.get('/api/fraymus-os/graph/path', route(async (req, res) => {
    if (!req.query.from || !req.query.to) return res.status(400).json({ error: 'from and to are required' });
    res.json(await os.graph.path(String(req.query.from), String(req.query.to)));
  }));

  app.get('/api/fraymus-os/graph/node/:id', route(async (req, res) => {
    const node = await os.graph.getNode(req.params.id);
    if (!node) return res.status(404).json({ error: 'Record not found' });
    res.json(node);
  }));

  app.get('/api/fraymus-os/notes/:id', route((req, res) => {
    const row = db.prepare('SELECT id, title, body, tags, provenance, created_at AS createdAt, updated_at AS updatedAt FROM fraymus_os_notes WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Note not found' });
    res.json({ ...row, tags: safeParse(row.tags, []), provenance: safeParse(row.provenance, {}) });
  }));

  app.post('/api/fraymus-os/notes', route((req, res) => {
    const title = String(req.body?.title || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!title || title.length > 200) return res.status(400).json({ error: 'title is required (max 200 characters)' });
    if (!body || body.length > 8000) return res.status(400).json({ error: 'body is required (max 8000 characters)' });
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(tag => String(tag).slice(0, 40)).slice(0, 12) : [];
    const id = randomUUID();
    const now = Date.now();
    const provenance = { store: 'fraymus_os_notes', writer: 'user', createdAt: now };
    db.prepare('INSERT INTO fraymus_os_notes (id, title, body, tags, provenance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, body, JSON.stringify(tags), JSON.stringify(provenance), now, now);
    res.status(201).json({ id, title, body, tags, provenance, createdAt: now, updatedAt: now });
  }));

  app.post('/api/fraymus-os/command', route((req, res) => {
    res.status(202).json(os.command.start({ text: req.body?.text, sessionId: req.body?.sessionId, mode: req.body?.mode }));
  }));

  app.post('/api/fraymus-os/command/voice', upload.single('audio'), route(async (req, res) => {
    let audio = req.file?.buffer;
    if (!audio && req.body?.audioBase64) audio = Buffer.from(String(req.body.audioBase64), 'base64');
    if (!audio?.length) return res.status(400).json({ error: 'audio file or audioBase64 is required', fallback: 'text', available: false });
    let transcript;
    try {
      transcript = await os.voice.transcribe(audio);
    } catch (error) {
      console.error('fraymus-os stt:', error.message);
      return res.status(503).json({
        error: 'Voice input is not available on this machine. Type your request instead.',
        detail: error.message,
        fallback: 'text',
        available: false,
      });
    }
    const started = os.command.start({ text: transcript.text, sessionId: req.body?.sessionId });
    res.status(202).json({ ...started, transcript: transcript.text, stt: { engine: transcript.engine, routeClass: transcript.routeClass } });
  }));

  app.get('/api/fraymus-os/sessions/:id', route((req, res) => {
    const found = os.command.session(req.params.id);
    if (!found) return res.status(404).json({ error: 'session not found' });
    res.json(found);
  }));

  app.post('/api/fraymus-os/runs/:id/cancel', route((req, res) => {
    res.json(os.command.cancel(req.params.id));
  }));

  app.post('/api/fraymus-os/approvals/:id', route(async (req, res) => {
    res.json(await os.command.decide(req.params.id, req.body?.decision));
  }));

  app.get('/api/fraymus-os/recipes', route((_req, res) => {
    res.json({ presets: os.recipes.presets });
  }));

  app.post('/api/fraymus-os/recipes/:id/run', route(async (req, res) => {
    const artifact = await os.recipes.run(req.params.id, req.body || {});
    res.status(201).json({ artifact });
  }));

  app.get('/api/fraymus-os/artifacts', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    res.json({ artifacts: os.recipes.listArtifacts(limit) });
  }));

  app.get('/api/fraymus-os/artifacts/:id', route((req, res) => {
    const artifact = os.recipes.getArtifact(req.params.id);
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    res.json(artifact);
  }));

  app.post('/api/fraymus-os/skills/propose', route(async (req, res) => {
    const goal = String(req.body?.goal || '').trim();
    if (!goal || goal.length > 500) return res.status(400).json({ error: 'goal is required (max 500 characters)' });
    const proposal = await os.command.proposeSkill(goal);
    res.status(201).json(proposal);
  }));

  app.get('/api/fraymus-os/skills/:id', route((req, res) => {
    const row = db.prepare('SELECT id, goal, manifest, status, created_at AS createdAt FROM fraymus_os_skill_proposals WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Skill proposal not found' });
    res.json({ ...row, manifest: safeParse(row.manifest, {}), execution: 'blocked', install: 'blocked' });
  }));

  app.post('/api/fraymus-os/skills/:id/enable', route((req, res) => {
    const row = db.prepare('SELECT id FROM fraymus_os_skill_proposals WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Skill proposal not found' });
    db.prepare("UPDATE fraymus_os_skill_proposals SET status = 'blocked' WHERE id = ?").run(req.params.id);
    res.status(403).json({
      error: 'Execution and installation of generated skills are blocked in this MVP. Nothing was installed.',
      executed: false,
      status: 'blocked',
    });
  }));

  app.post('/api/fraymus-os/speak', route(async (req, res) => {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    req.on('close', onClose);
    try {
      const result = await os.voice.speak(req.body?.text, { voice: req.body?.voice, signal: controller.signal });
      if (controller.signal.aborted || res.writableEnded) return;
      res.json(result);
    } finally {
      req.off('close', onClose);
    }
  }));

  app.post('/api/fraymus-os/speak/cancel', route((_req, res) => {
    res.json(os.voice.cancel());
  }));

  app.get('/api/fraymus-os/audio/:file', (req, res) => {
    const file = basename(req.params.file);
    if (!/^[\w.-]+$/.test(file)) return res.status(400).json({ error: 'Invalid file name' });
    const full = join(os.voice.audioDir, file);
    if (!existsSync(full)) return res.status(404).json({ error: 'Audio not found' });
    res.setHeader('Content-Type', file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
    createReadStream(full).pipe(res);
  });

  return os;
}
