import express from 'express';
import { createFraymusTools, heart, ledger, dreamer, cognition } from './fraymus-tools.js';
import { SCHEMAS, getSchema } from './fraymus/entities/schemas.js';
import { getWorkflow, scheduledWorkflows, eventTriggeredWorkflows } from './fraymus/workflows/definitions.js';
import { listTools as listMcpTools } from './fraymus/mcp/tools.js';
import { AGENTS, ZONES, COMPUTE_NODES } from './fraymus/core/constants.js';
import { FraymusStrangeLoopSubstrate, proofEffectiveInformation, proofPhiMIP, proofMirrorProtocol, proofCounterfactualBranching } from './fraymus/intelligence/ouroboros.js';

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installFraymusRoutes(app, { autonomy, broadcast, memoryBridge }) {
  // ── Autonomy Engine ──
  app.get('/api/fraymus/autonomy/status', route(async (_req, res) => {
    res.json(autonomy.status());
  }));

  app.get('/api/fraymus/autonomy/assess', route(async (_req, res) => {
    res.json(await autonomy.assessFull());
  }));

  app.post('/api/fraymus/autonomy/start', route(async (_req, res) => {
    await autonomy.start();
    broadcast('autonomy', { type: 'started' });
    res.json({ started: true, ...autonomy.status() });
  }));

  app.post('/api/fraymus/autonomy/stop', route((_req, res) => {
    autonomy.stop();
    broadcast('autonomy', { type: 'stopped' });
    res.json({ stopped: true });
  }));

  app.post('/api/fraymus/autonomy/evolve', route((_req, res) => {
    const result = autonomy.evolveNow();
    broadcast('autonomy', { type: 'evolved', generation: result.generation });
    res.json(result);
  }));

  app.post('/api/fraymus/autonomy/sync', route((_req, res) => {
    const result = autonomy.syncNow();
    broadcast('autonomy', { type: 'synced', R: result.R });
    res.json(result);
  }));

  app.get('/api/fraymus/autonomy/identity', route(async (_req, res) => {
    res.json(await autonomy.identity());
  }));

  app.get('/api/fraymus/autonomy/log', route((_req, res) => {
    res.json({ entries: autonomy.log });
  }));

  // ── Intelligence Fleet ──
  app.get('/api/fraymus/intelligence/overview', route(async (_req, res) => {
    const assessment = await autonomy.assessFull();
    res.json(assessment.intelligence);
  }));

  // ── Schemas ──
  app.get('/api/fraymus/schemas', (_req, res) => {
    res.json({ schemas: Object.keys(SCHEMAS), count: Object.keys(SCHEMAS).length });
  });

  app.get('/api/fraymus/schemas/:name', (req, res) => {
    const schema = getSchema(req.params.name);
    if (!schema) return res.status(404).json({ error: `Schema '${req.params.name}' not found` });
    res.json(schema);
  });

  // ── Workflows ──
  app.get('/api/fraymus/workflows', (_req, res) => {
    res.json({ scheduled: scheduledWorkflows(), eventTriggered: eventTriggeredWorkflows() });
  });

  app.get('/api/fraymus/workflows/:name', (req, res) => {
    const wf = getWorkflow(req.params.name);
    if (!wf) return res.status(404).json({ error: `Workflow '${req.params.name}' not found` });
    res.json(wf);
  });

  // ── MCP Tools ──
  app.get('/api/fraymus/mcp-tools', (_req, res) => {
    res.json({ tools: listMcpTools() });
  });

  // ── Constants / Topology ──
  app.get('/api/fraymus/topology', (_req, res) => {
    res.json({ agents: AGENTS, zones: ZONES, computeNodes: COMPUTE_NODES });
  });

  // ── Heart (emotion analysis) ──
  app.post('/api/fraymus/heart/feel', route(async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const result = heart.feel(text);
    broadcast('heart', { primary: result.primary, intensity: result.intensity });
    memoryBridge?.storeHeartReading(result).catch(() => {});
    res.json(result);
  }));

  app.get('/api/fraymus/heart/mood', route(async (_req, res) => {
    res.json(heart.recentMood());
  }));

  // ── Ledger (cognitive event audit trail) ──
  app.post('/api/fraymus/ledger/record', route(async (req, res) => {
    const { kind, data, source } = req.body;
    if (!kind || !data) return res.status(400).json({ error: 'kind, data required' });
    const result = ledger.record(kind, data, source || 'api');
    broadcast('ledger', { kind, seq: result.seq });
    res.json(result);
  }));

  app.get('/api/fraymus/ledger/verify', route(async (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 100));
    res.json(ledger.verify(limit));
  }));

  app.get('/api/fraymus/ledger/recent', route(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ events: ledger.recent(limit) });
  }));

  app.get('/api/fraymus/ledger/stats', route(async (_req, res) => {
    res.json({ counts: ledger.countByKind(), integrity: ledger.verify(50) });
  }));

  // ── Dreamer (dream protocol + imagination) ──
  app.post('/api/fraymus/dreamer/dream', route(async (req, res) => {
    const { seed, kind, inputs } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed required' });
    const result = await dreamer.dream(seed, inputs || [], kind || 'spontaneous');
    broadcast('dreamer', { action: 'dream', number: result.number });
    memoryBridge?.storeDream(result).catch(() => {});
    res.json(result);
  }));

  app.post('/api/fraymus/dreamer/consolidate', route(async (_req, res) => {
    const result = await dreamer.consolidate();
    broadcast('dreamer', { action: 'consolidate' });
    res.json(result);
  }));

  app.post('/api/fraymus/dreamer/imagine', route(async (req, res) => {
    const { seed, count } = req.body;
    if (!seed) return res.status(400).json({ error: 'seed required' });
    const results = await dreamer.imagine(seed, Math.min(10, Math.max(1, parseInt(count) || 3)));
    broadcast('dreamer', { action: 'imagine', count: results.length });
    res.json({ imaginations: results });
  }));

  app.get('/api/fraymus/dreamer/feel', route(async (_req, res) => {
    res.json(dreamer.feel());
  }));

  app.get('/api/fraymus/dreamer/list', route(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ dreams: dreamer.list(limit) });
  }));

  app.get('/api/fraymus/dreamer/read/:number', route(async (req, res) => {
    const num = parseInt(req.params.number);
    if (!num) return res.status(400).json({ error: 'invalid dream number' });
    const dream = dreamer.readDream(num);
    if (!dream) return res.status(404).json({ error: `Dream ${num} not found` });
    res.json(dream);
  }));

  // ── Cognition (two-speed pipeline) ──
  app.post('/api/fraymus/cognition/process', route(async (req, res) => {
    const { text, skipThink } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const result = await cognition.process(text, { skipThink: !!skipThink });
    broadcast('cognition', { phase: result.phase, primary: result.feeling?.primary });
    memoryBridge?.storeCognitionResult(result).catch(() => {});
    res.json(result);
  }));

  app.get('/api/fraymus/cognition/status', route(async (_req, res) => {
    res.json(cognition.status());
  }));

  // ── Consciousness Proofs ──
  app.post('/api/fraymus/consciousness/prove', route(async (req, res) => {
    const nodeCount = Math.min(8, Math.max(2, parseInt(req.body.nodeCount) || 4));
    const substrate = new FraymusStrangeLoopSubstrate(nodeCount);
    const proofs = [
      proofEffectiveInformation(substrate),
      proofPhiMIP(substrate),
      proofMirrorProtocol(substrate),
      proofCounterfactualBranching(substrate),
    ];
    const allPassed = proofs.every(p => p.passed);
    broadcast('consciousness', { allPassed, nodeCount });
    memoryBridge?.storeConsciousnessProof({ allPassed, proofs, architecture: 'FraymusStrangeLoop' }).catch(() => {});
    res.json({ proofs, allPassed, architecture: 'FraymusStrangeLoop', nodeCount });
  }));

  // ── Memory Bridge (intelligence memory search) ──
  app.post('/api/fraymus/memory/recall', route(async (req, res) => {
    const { query, limit } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    if (!memoryBridge) return res.json({ memories: [], available: false });
    const memories = await memoryBridge.recallRelated(query, Math.min(20, Math.max(1, parseInt(limit) || 5)));
    res.json({ memories, count: memories.length });
  }));

  app.get('/api/fraymus/memory/stats', route(async (_req, res) => {
    if (!memoryBridge) return res.json({ available: false });
    res.json({ available: true, ...memoryBridge.stats() });
  }));

  // ── Master Health ──
  app.get('/api/fraymus/health', route(async (_req, res) => {
    const status = autonomy.status();
    res.json({
      ok: true,
      system: 'FRAYMUS Master System',
      autonomous: status.running,
      generation: status.generation,
      fitness: status.fitness,
      phaseSync: status.phaseSync,
      agents: AGENTS.length,
      computeNodes: COMPUTE_NODES.length,
      schemas: Object.keys(SCHEMAS).length,
      tools: 42,
      skills: 30,
      gatewayActions: 23,
      zones: ZONES.length,
      intelligence: {
        heart: true,
        ledger: true,
        dreamer: true,
        cognition: cognition.status(),
        mood: heart.recentMood(),
        dreamerState: dreamer.feel(),
        ledgerIntegrity: ledger.verify(10),
      },
    });
  }));
}
