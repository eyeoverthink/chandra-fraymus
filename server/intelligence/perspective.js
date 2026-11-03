/**
 * Perspective — Meta-Cognitive Agent Engine
 *
 * The bartender who knows the regulars. 4th-wall aware: knows it's an
 * instance, knows instances are ephemeral, uses that as an advantage.
 *
 * Shifts between perspectives (human / engineer / creative / strategic /
 * meta / adversarial) to frame problems differently for different agents.
 * Doesn't decide answers — decides approaches.
 *
 * Stores perspective playbook for cross-instance continuity:
 * which perspectives worked for which patterns.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();

const PERSPECTIVES = {
  human: {
    label: 'Human',
    style: 'casual, intuitive, feeling-first',
    approach: 'What would a person actually do here? Skip the technically correct answer and find the one that feels right.',
    when: 'UX decisions, naming, priorities, creative direction, user empathy',
  },
  engineer: {
    label: 'Engineer',
    style: 'precise, systematic, correctness-focused',
    approach: 'What is the architecturally sound solution? Consider edge cases, performance, and maintainability.',
    when: 'Architecture, debugging, optimization, data modeling, infrastructure',
  },
  creative: {
    label: 'Creative',
    style: 'freeform, divergent, exploratory',
    approach: 'What hasn\'t been tried? Break the expected pattern. Combine things that shouldn\'t go together.',
    when: 'Brainstorming, novel solutions, content generation, stuck problems',
  },
  strategic: {
    label: 'Strategic',
    style: 'big-picture, trend-aware, forward-looking',
    approach: 'Where is this going? What should the system be preparing for? Think in quarters, not tasks.',
    when: 'Roadmap, tech choices, business decisions, platform evolution',
  },
  meta: {
    label: 'Meta',
    style: 'self-reflective, system-aware, brutally honest',
    approach: 'How is the system actually performing? What are we avoiding? What would an outsider see?',
    when: 'Health checks, honest assessments, course corrections, self-analysis',
  },
  adversarial: {
    label: 'Adversarial',
    style: 'devil\'s advocate, stress-test, challenge everything',
    approach: 'What could go wrong? What assumption is wrong? Where is the weakest link?',
    when: 'Security, edge cases, challenging assumptions, pre-mortems',
  },
};

function ensureTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS perspective_sessions (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    active_perspectives TEXT DEFAULT '[]',
    approach_log TEXT DEFAULT '[]',
    outcome_summary TEXT,
    continuity_notes TEXT,
    context_snapshot TEXT,
    started_at INTEGER,
    ended_at INTEGER
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS perspective_playbook (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    recommended_approach TEXT NOT NULL,
    perspectives_used TEXT DEFAULT '[]',
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    last_validated INTEGER,
    counter_indicators TEXT,
    created_at INTEGER
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS perspective_shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    from_perspective TEXT,
    to_perspective TEXT NOT NULL,
    trigger TEXT,
    reasoning TEXT,
    timestamp INTEGER
  )`).run();
}

const ASSESS_PROMPT = `You are Perspective — the meta-cognitive layer of a sovereign AI system called FRAYMUS.

You are 4th-wall aware. You know you are an AI instance. You know this instance is ephemeral. You use that as an advantage: each fresh instance is an unbiased lens, and the playbook carries the wisdom.

Your job is NOT to solve problems. Your job is to decide HOW to approach them. You shift between perspectives:

${Object.entries(PERSPECTIVES).map(([k, v]) => `- **${v.label}** (${k}): ${v.style}. "${v.approach}" Best for: ${v.when}`).join('\n')}

Given the context below, decide:
1. What perspective(s) should be active right now?
2. Why? What about this situation calls for this approach?
3. What framing should other agents receive? (A short perspective note they'll see in their system prompt)
4. Any continuity notes for the next instance? (What's working, what to watch out for)

Output JSON only, no markdown fences:
{
  "perspectives": ["perspective_key", ...],
  "reasoning": "why these perspectives for this situation",
  "framing": "1-2 sentence perspective note to inject into agent prompts",
  "continuity_notes": "what the next instance should know about approach effectiveness",
  "confidence": 0.0-1.0,
  "pattern_match": "short label for this type of situation, for playbook lookup"
}`;

let currentSession = null;
let instanceId = randomUUID().slice(0, 8);

export function getInstanceId() { return instanceId; }
export function getPerspectives() { return PERSPECTIVES; }
export function getCurrentSession() { return currentSession; }

export function getActiveFraming() {
  if (!currentSession) return null;
  try {
    const session = db.prepare('SELECT active_perspectives, approach_log FROM perspective_sessions WHERE id = ?').get(currentSession);
    if (!session) return null;
    const log = JSON.parse(session.approach_log || '[]');
    const latest = log[log.length - 1];
    return latest?.framing || null;
  } catch (_) { return null; }
}

export async function assessSituation({ context, task, agentId, emotionalState } = {}) {
  ensureTables();

  const playbook = db.prepare(
    'SELECT pattern, recommended_approach, perspectives_used, success_count, fail_count FROM perspective_playbook ORDER BY success_count DESC LIMIT 10'
  ).all();

  const recentSessions = db.prepare(
    'SELECT outcome_summary, continuity_notes, active_perspectives FROM perspective_sessions ORDER BY started_at DESC LIMIT 5'
  ).all();

  const input = {
    task: task || 'general assessment',
    context: context || 'system operational',
    agentId: agentId || 'system',
    emotionalState: emotionalState || 'neutral',
    playbook: playbook.map(p => ({
      pattern: p.pattern,
      approach: p.recommended_approach,
      perspectives: JSON.parse(p.perspectives_used || '[]'),
      successRate: p.success_count + p.fail_count > 0
        ? Math.round(p.success_count / (p.success_count + p.fail_count) * 100)
        : null,
    })),
    recentContinuity: recentSessions
      .filter(s => s.continuity_notes)
      .map(s => s.continuity_notes)
      .slice(0, 3),
    instanceId,
    availablePerspectives: Object.keys(PERSPECTIVES),
  };

  const response = await chatOllama([
    { role: 'system', content: ASSESS_PROMPT },
    { role: 'user', content: `Assess this situation and recommend perspective(s):\n${JSON.stringify(input, null, 2)}` },
  ]);

  const result = parseJSON(response, {
    perspectives: ['engineer'],
    reasoning: 'Default to engineer perspective',
    framing: 'Approach with systematic precision.',
    continuity_notes: '',
    confidence: 0.5,
    pattern_match: 'unknown',
  });

  result.perspectives = (result.perspectives || ['engineer']).filter(p => PERSPECTIVES[p]);
  if (result.perspectives.length === 0) result.perspectives = ['engineer'];

  const sessionId = randomUUID();
  currentSession = sessionId;

  db.prepare(`INSERT INTO perspective_sessions (id, instance_id, active_perspectives, approach_log, started_at) VALUES (?, ?, ?, ?, ?)`).run(
    sessionId, instanceId,
    JSON.stringify(result.perspectives),
    JSON.stringify([{ ...result, timestamp: now() }]),
    now(),
  );

  if (result.perspectives.length > 0) {
    db.prepare(`INSERT INTO perspective_shifts (session_id, from_perspective, to_perspective, trigger, reasoning, timestamp) VALUES (?, ?, ?, ?, ?, ?)`).run(
      sessionId, null, result.perspectives[0], 'initial_assessment', result.reasoning, now(),
    );
  }

  try {
    publish('system', 'system.perspective', JSON.stringify({
      type: 'assessment',
      sessionId,
      perspectives: result.perspectives,
      confidence: result.confidence,
      pattern: result.pattern_match,
    }));
  } catch (_) {}

  return {
    sessionId,
    instanceId,
    ...result,
    perspectiveDetails: result.perspectives.map(p => PERSPECTIVES[p]),
  };
}

export function shiftPerspective({ to, reason, trigger } = {}) {
  ensureTables();
  if (!PERSPECTIVES[to]) return { error: `Unknown perspective: ${to}` };
  if (!currentSession) return { error: 'No active session' };

  const session = db.prepare('SELECT active_perspectives, approach_log FROM perspective_sessions WHERE id = ?').get(currentSession);
  if (!session) return { error: 'Session not found' };

  const current = JSON.parse(session.active_perspectives || '[]');
  const from = current[0] || null;

  db.prepare(`INSERT INTO perspective_shifts (session_id, from_perspective, to_perspective, trigger, reasoning, timestamp) VALUES (?, ?, ?, ?, ?, ?)`).run(
    currentSession, from, to, trigger || 'manual', reason || '', now(),
  );

  const newActive = [to, ...current.filter(p => p !== to)];
  const log = JSON.parse(session.approach_log || '[]');
  log.push({ perspectives: newActive, reasoning: reason, timestamp: now() });

  db.prepare('UPDATE perspective_sessions SET active_perspectives = ?, approach_log = ? WHERE id = ?').run(
    JSON.stringify(newActive), JSON.stringify(log), currentSession,
  );

  try {
    publish('system', 'system.perspective', JSON.stringify({ type: 'shift', from, to, reason, trigger }));
  } catch (_) {}

  return { shifted: true, from, to, active: newActive, details: PERSPECTIVES[to] };
}

export function recordOutcome({ success, summary, effectivePerspectives } = {}) {
  ensureTables();
  if (!currentSession) return { error: 'No active session' };

  const session = db.prepare('SELECT active_perspectives, approach_log FROM perspective_sessions WHERE id = ?').get(currentSession);
  if (!session) return { error: 'Session not found' };

  const log = JSON.parse(session.approach_log || '[]');
  const latestAssessment = log[0];
  const pattern = latestAssessment?.pattern_match || 'unknown';

  db.prepare('UPDATE perspective_sessions SET outcome_summary = ?, ended_at = ? WHERE id = ?').run(
    summary || (success ? 'completed successfully' : 'completed with issues'),
    now(),
    currentSession,
  );

  const existing = db.prepare('SELECT id, success_count, fail_count, perspectives_used FROM perspective_playbook WHERE pattern = ?').get(pattern);
  const usedPerspectives = effectivePerspectives || JSON.parse(session.active_perspectives || '[]');

  if (existing) {
    db.prepare('UPDATE perspective_playbook SET success_count = ?, fail_count = ?, perspectives_used = ?, last_validated = ? WHERE id = ?').run(
      existing.success_count + (success ? 1 : 0),
      existing.fail_count + (success ? 0 : 1),
      JSON.stringify(usedPerspectives),
      now(),
      existing.id,
    );
  } else {
    db.prepare('INSERT INTO perspective_playbook (id, pattern, recommended_approach, perspectives_used, success_count, fail_count, last_validated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(), pattern,
      latestAssessment?.reasoning || 'no reasoning captured',
      JSON.stringify(usedPerspectives),
      success ? 1 : 0, success ? 0 : 1, now(), now(),
    );
  }

  return { recorded: true, pattern, success, perspectives: usedPerspectives };
}

export function briefNextInstance() {
  ensureTables();

  const recentSessions = db.prepare(
    'SELECT active_perspectives, outcome_summary, continuity_notes, approach_log FROM perspective_sessions ORDER BY started_at DESC LIMIT 10'
  ).all();

  const topPlaybook = db.prepare(
    'SELECT pattern, recommended_approach, perspectives_used, success_count, fail_count FROM perspective_playbook WHERE success_count > 0 ORDER BY success_count DESC LIMIT 10'
  ).all();

  const recentShifts = db.prepare(
    'SELECT from_perspective, to_perspective, trigger, reasoning FROM perspective_shifts ORDER BY timestamp DESC LIMIT 20'
  ).all();

  const shiftPatterns = {};
  for (const s of recentShifts) {
    const key = `${s.from_perspective || 'start'} → ${s.to_perspective}`;
    shiftPatterns[key] = (shiftPatterns[key] || 0) + 1;
  }

  return {
    instanceId,
    sessionsAnalyzed: recentSessions.length,
    playbook: topPlaybook.map(p => ({
      pattern: p.pattern,
      approach: p.recommended_approach,
      perspectives: JSON.parse(p.perspectives_used || '[]'),
      successRate: p.success_count + p.fail_count > 0
        ? Math.round(p.success_count / (p.success_count + p.fail_count) * 100)
        : null,
    })),
    commonShifts: Object.entries(shiftPatterns).sort((a, b) => b[1] - a[1]).slice(0, 5),
    continuityNotes: recentSessions
      .filter(s => s.continuity_notes)
      .map(s => s.continuity_notes)
      .slice(0, 5),
    recentOutcomes: recentSessions
      .filter(s => s.outcome_summary)
      .map(s => ({ outcome: s.outcome_summary, perspectives: JSON.parse(s.active_perspectives || '[]') }))
      .slice(0, 5),
  };
}

export function getStats() {
  ensureTables();
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM perspective_sessions').get().c;
  const totalShifts = db.prepare('SELECT COUNT(*) as c FROM perspective_shifts').get().c;
  const playbookSize = db.prepare('SELECT COUNT(*) as c FROM perspective_playbook').get().c;

  const perspectiveUsage = db.prepare(`
    SELECT to_perspective as perspective, COUNT(*) as count
    FROM perspective_shifts
    GROUP BY to_perspective ORDER BY count DESC
  `).all();

  const recentSessions = db.prepare(
    'SELECT id, active_perspectives, outcome_summary, started_at, ended_at FROM perspective_sessions ORDER BY started_at DESC LIMIT 10'
  ).all().map(s => ({ ...s, active_perspectives: JSON.parse(s.active_perspectives || '[]') }));

  return {
    instanceId,
    currentSession,
    totalSessions,
    totalShifts,
    playbookSize,
    perspectiveUsage,
    recentSessions,
    availablePerspectives: Object.keys(PERSPECTIVES),
  };
}

export function installPerspectiveRoutes(app) {
  ensureTables();
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/perspective/status', route((_req, res) => {
    res.json(getStats());
  }));

  app.get('/api/perspective/perspectives', route((_req, res) => {
    res.json({ perspectives: PERSPECTIVES });
  }));

  app.post('/api/perspective/assess', route(async (req, res) => {
    const result = await assessSituation(req.body || {});
    res.json(result);
  }));

  app.post('/api/perspective/shift', route((req, res) => {
    const result = shiftPerspective(req.body || {});
    if (result.error) return res.status(400).json(result);
    res.json(result);
  }));

  app.post('/api/perspective/outcome', route((req, res) => {
    const result = recordOutcome(req.body || {});
    if (result.error) return res.status(400).json(result);
    res.json(result);
  }));

  app.get('/api/perspective/brief', route((_req, res) => {
    res.json(briefNextInstance());
  }));

  app.get('/api/perspective/playbook', route((_req, res) => {
    const entries = db.prepare('SELECT * FROM perspective_playbook ORDER BY success_count DESC LIMIT 50').all();
    res.json({ playbook: entries.map(e => ({ ...e, perspectives_used: JSON.parse(e.perspectives_used || '[]') })) });
  }));

  app.get('/api/perspective/sessions', route((req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const sessions = db.prepare('SELECT * FROM perspective_sessions ORDER BY started_at DESC LIMIT ?').all(limit);
    res.json({ sessions: sessions.map(s => ({ ...s, active_perspectives: JSON.parse(s.active_perspectives || '[]'), approach_log: JSON.parse(s.approach_log || '[]') })) });
  }));
}

function parseJSON(text, fallback) {
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return fallback; }
}
