import express from 'express';
import { createFraymusTools } from './fraymus-tools.js';
import { SCHEMAS, getSchema } from './fraymus/entities/schemas.js';
import { getWorkflow, scheduledWorkflows, eventTriggeredWorkflows } from './fraymus/workflows/definitions.js';
import { listTools as listMcpTools } from './fraymus/mcp/tools.js';
import { AGENTS, ZONES, COMPUTE_NODES } from './fraymus/core/constants.js';

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installFraymusRoutes(app, { autonomy, broadcast }) {
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
      skills: 30,
      gatewayActions: 23,
      zones: ZONES.length,
    });
  }));
}
