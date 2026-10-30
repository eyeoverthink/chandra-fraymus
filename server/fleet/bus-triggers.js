import { db } from '../db.js';
import { onTopic, offTopic } from './bus.js';
import { runPipeline } from '../workflow/engine.js';

const now = () => Date.now();
const activeTriggers = new Map();
let broadcastFn = () => {};

export function initTriggers({ broadcast } = {}) {
  if (broadcast) broadcastFn = broadcast;
  const rows = db.prepare(
    `SELECT * FROM bus_triggers WHERE enabled = 1`
  ).all();
  for (const row of rows) wire(row);
  return { loaded: rows.length };
}

function wire(row) {
  if (activeTriggers.has(row.id)) return;
  const handler = (msg) => {
    fireTrigger(row, msg).catch(e =>
      console.error(`bus-trigger ${row.id} error:`, e.message)
    );
  };
  onTopic(row.topic, `trigger:${row.id}`, handler);
  activeTriggers.set(row.id, handler);
}

function unwire(id) {
  const row = db.prepare(`SELECT * FROM bus_triggers WHERE id = ?`).get(id);
  if (row) offTopic(row.topic, `trigger:${row.id}`);
  activeTriggers.delete(id);
}

async function fireTrigger(trigger, busMsg) {
  const wf = db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(trigger.workflow_id);
  if (!wf) return;

  const nodes = JSON.parse(wf.nodes || '[]');
  const edges = JSON.parse(wf.edges || '[]');
  const prompt = `[Bus trigger] Topic: ${busMsg.topic} | From: ${busMsg.from} | Payload: ${String(busMsg.payload).slice(0, 500)}`;

  db.prepare(
    `UPDATE bus_triggers SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?`
  ).run(now(), trigger.id);

  broadcastFn({ type: 'bus', event: 'trigger_fired', triggerId: trigger.id, topic: trigger.topic, workflowId: trigger.workflow_id });

  try {
    const result = await runPipeline(nodes, edges, { prompt });
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, user_id, status, input_prompt, results, duration_ms, created_at)
       VALUES (?, ?, 'local', ?, ?, ?, ?, ?)`
    ).run(
      `trigger-${trigger.id}-${now()}`, wf.id, result.status,
      prompt, JSON.stringify(result.results || {}),
      result.durationMs || 0, now()
    );
  } catch (e) {
    console.error(`bus-trigger ${trigger.id} workflow failed:`, e.message);
  }
}

export function createTrigger(topic, workflowId, label) {
  const id = `bt-${Date.now().toString(36)}`;
  db.prepare(
    `INSERT INTO bus_triggers (id, topic, workflow_id, label, enabled, fire_count, created_at)
     VALUES (?, ?, ?, ?, 1, 0, ?)`
  ).run(id, topic, workflowId, label || `${topic} → workflow`, now());
  const row = db.prepare(`SELECT * FROM bus_triggers WHERE id = ?`).get(id);
  wire(row);
  return row;
}

export function deleteTrigger(id) {
  unwire(id);
  const info = db.prepare(`DELETE FROM bus_triggers WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

export function toggleTrigger(id, enabled) {
  db.prepare(`UPDATE bus_triggers SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  if (enabled) {
    const row = db.prepare(`SELECT * FROM bus_triggers WHERE id = ?`).get(id);
    if (row) wire(row);
  } else {
    unwire(id);
  }
  return { id, enabled: !!enabled };
}

export function listTriggers() {
  return db.prepare(
    `SELECT * FROM bus_triggers ORDER BY created_at DESC`
  ).all();
}

export function installTriggerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/fleet/bus/triggers', route((_req, res) => {
    res.json({ triggers: listTriggers() });
  }));

  app.post('/api/fleet/bus/triggers', route((req, res) => {
    const { topic, workflowId, label } = req.body;
    if (!topic || !workflowId) return res.status(400).json({ error: 'topic and workflowId required' });
    res.status(201).json(createTrigger(topic, workflowId, label));
  }));

  app.delete('/api/fleet/bus/triggers/:id', route((req, res) => {
    res.json(deleteTrigger(req.params.id));
  }));

  app.post('/api/fleet/bus/triggers/:id/toggle', route((req, res) => {
    const enabled = req.body.enabled !== false;
    res.json(toggleTrigger(req.params.id, enabled));
  }));
}
