import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

const now = () => Date.now();

export function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron must be 5 fields: minute hour dom month dow');
  const parse = (s, min, max) => {
    if (s === '*') return null;
    const vals = [];
    for (const p of s.split(',')) {
      if (p.includes('/')) {
        const [range, step] = p.split('/');
        const st = Number(step);
        const [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
        for (let i = lo; i <= (hi ?? max); i += st) vals.push(i);
      } else if (p.includes('-')) {
        const [lo, hi] = p.split('-').map(Number);
        for (let i = lo; i <= hi; i++) vals.push(i);
      } else {
        vals.push(Number(p));
      }
    }
    return vals.filter(v => v >= min && v <= max);
  };
  return {
    minute: parse(parts[0], 0, 59),
    hour: parse(parts[1], 0, 23),
    dom: parse(parts[2], 1, 31),
    month: parse(parts[3], 1, 12),
    dow: parse(parts[4], 0, 6),
  };
}

function matches(cron, date) {
  const m = date.getUTCMinutes();
  const h = date.getUTCHours();
  const d = date.getUTCDate();
  const mo = date.getUTCMonth() + 1;
  const w = date.getUTCDay();
  if (cron.minute && !cron.minute.includes(m)) return false;
  if (cron.hour && !cron.hour.includes(h)) return false;
  if (cron.dom && !cron.dom.includes(d)) return false;
  if (cron.month && !cron.month.includes(mo)) return false;
  if (cron.dow && !cron.dow.includes(w)) return false;
  return true;
}

let tickTimer = null;
let runAgentFn = null;
let runToolFn = null;
let broadcastFn = () => {};

export function initScheduler({ runAgent, runTool, broadcast }) {
  runAgentFn = runAgent;
  runToolFn = runTool;
  broadcastFn = broadcast || (() => {});
}

export function startScheduler() {
  if (tickTimer) return;
  tickTimer = setInterval(tick, 15_000);
  tick();
}

export function stopScheduler() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

function currentMinute() {
  return Math.floor(Date.now() / 60_000);
}

async function tick() {
  const minute = currentMinute();
  const date = new Date(minute * 60_000);
  const automations = db.prepare('SELECT * FROM automations WHERE enabled = 1').all();

  for (const a of automations) {
    if (a.last_minute >= minute) continue;
    let cron;
    try { cron = parseCron(a.cron); } catch { continue; }
    if (!matches(cron, date)) continue;

    db.prepare('UPDATE automations SET last_minute = ? WHERE id = ?').run(minute, a.id);
    runAutomation(a.user_id, a.id, 'cron').catch(() => {});
  }
}

export async function runAutomation(userId, automationId, trigger = 'manual') {
  const a = db.prepare('SELECT * FROM automations WHERE id = ? AND user_id = ?').get(automationId, userId || 'local');
  if (!a) throw new Error('Automation not found');

  const runId = randomUUID();
  db.prepare('INSERT INTO automation_runs (id, automation_id, user_id, trigger_type, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, a.id, a.user_id, trigger, 'running', now());

  broadcastFn('automation', { type: 'run_started', automationId: a.id, runId });

  try {
    let output;
    const payload = JSON.parse(a.payload || '{}');

    if (a.kind === 'agent' && runAgentFn) {
      const result = await runAgentFn(a.user_id, a.agent_id || 'concierge', payload.prompt || 'Scheduled task', null, 120_000);
      output = JSON.stringify(result);
    } else if (a.kind === 'tool' && runToolFn) {
      const result = await runToolFn(a.user_id, a.tool, payload);
      output = JSON.stringify(result);
    } else {
      output = `No executor for kind="${a.kind}"`;
    }

    db.prepare('UPDATE automation_runs SET status = ?, output = ?, finished_at = ? WHERE id = ?')
      .run('done', (output || '').slice(0, 50_000), now(), runId);
    broadcastFn('automation', { type: 'run_done', automationId: a.id, runId });
    return { runId, status: 'done', output };
  } catch (e) {
    db.prepare('UPDATE automation_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?')
      .run('error', e.message, now(), runId);
    broadcastFn('automation', { type: 'run_error', automationId: a.id, runId });
    return { runId, status: 'error', error: e.message };
  }
}

export function listAutomations(userId) {
  const rows = db.prepare('SELECT * FROM automations WHERE user_id = ? ORDER BY created_at DESC').all(userId || 'local');
  return rows.map(a => {
    const lastRun = db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1').get(a.id);
    return { ...a, payload: JSON.parse(a.payload || '{}'), lastRun };
  });
}

export function saveAutomation(userId, input) {
  const id = input.id || randomUUID();
  parseCron(input.cron);

  const existing = db.prepare('SELECT id FROM automations WHERE id = ?').get(id);
  if (existing) {
    db.prepare(`UPDATE automations SET name = ?, cron = ?, kind = ?, agent_id = ?, tool = ?, payload = ?, enabled = ? WHERE id = ? AND user_id = ?`)
      .run(input.name, input.cron, input.kind || 'agent', input.agentId || input.agent_id || null,
        input.tool || null, JSON.stringify(input.args || input.payload || {}),
        input.enabled !== false ? 1 : 0, id, userId || 'local');
  } else {
    db.prepare(`INSERT INTO automations (id, user_id, name, cron, kind, agent_id, tool, payload, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId || 'local', input.name, input.cron, input.kind || 'agent',
        input.agentId || input.agent_id || null, input.tool || null,
        JSON.stringify(input.args || input.payload || {}), input.enabled !== false ? 1 : 0, now());
  }

  broadcastFn('automation', { type: 'saved', id });
  return { id, saved: true };
}

export function deleteAutomation(userId, id) {
  const r = db.prepare('DELETE FROM automations WHERE id = ? AND user_id = ?').run(id, userId || 'local');
  if (Number(r.changes)) db.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(id);
  return Number(r.changes) > 0;
}

export function automationRuns(userId, automationId) {
  return db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 25').all(automationId);
}
