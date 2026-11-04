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

  // ─── Arena endpoints ───
  app.post('/api/perspective/arena', route(async (req, res) => {
    const { task, context, agentCount, timeoutMs } = req.body || {};
    if (!task) return res.status(400).json({ error: 'task is required' });
    const result = await arenaChallenge({ task, context, agentCount, timeoutMs });
    res.json(result);
  }));

  app.get('/api/perspective/arena/list', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ arenas: listArenas({ limit }) });
  }));

  app.get('/api/perspective/arena/:id', route((req, res) => {
    const session = getArenaSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'arena session not found' });
    res.json(session);
  }));

  app.get('/api/perspective/arena-stats', route((_req, res) => {
    res.json(getArenaStats());
  }));
}

// ─── Arena Mode ─────────────────────────────────────────────
// Competitive evaluation: N agents tackle the same task from different
// lenses. Perspective judges through ALL lenses, picks a winner, and
// burns the winning approach into the playbook.

function ensureArenaTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS arena_sessions (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    pattern_match TEXT,
    contestant_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    winner_agent TEXT,
    winner_perspective TEXT,
    judgments TEXT,
    duration_ms INTEGER,
    created_at INTEGER
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS arena_entries (
    id TEXT PRIMARY KEY,
    arena_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    perspective TEXT NOT NULL,
    output TEXT,
    scores TEXT,
    aggregate_score REAL,
    duration_ms INTEGER,
    created_at INTEGER
  )`).run();
}

const JUDGE_PROMPT = `You are the Arena Judge for a sovereign AI system called FRAYMUS.

Multiple agents approached the SAME task from different cognitive lenses. Your job is to evaluate each response through ALL six lenses and declare a winner.

For each contestant, score 0.0–1.0 on EACH lens:
- human: Does it feel right? Would a person actually use/want this?
- engineer: Is it technically correct, robust, and maintainable?
- creative: Does it bring a novel angle or unexpected insight?
- strategic: Does it serve long-term goals and anticipate consequences?
- meta: Is it self-aware about its assumptions and limitations?
- adversarial: Does it hold up under stress? What could go wrong?

Then pick the winner — the response with the best AGGREGATE across all lenses. The winner doesn't need to top every category. A response that's solid across all six beats one that's brilliant in two and weak in four.

Output ONLY valid JSON, no markdown fences:
{
  "evaluations": [
    {
      "agentId": "...",
      "perspective": "their assigned lens",
      "scores": { "human": 0.0, "engineer": 0.0, "creative": 0.0, "strategic": 0.0, "meta": 0.0, "adversarial": 0.0 },
      "aggregate": 0.0,
      "strengths": "what this response does best",
      "weaknesses": "where it falls short"
    }
  ],
  "winner": { "agentId": "...", "perspective": "...", "reason": "why this response won" },
  "pattern_match": "short label for this type of task (for playbook)",
  "lesson": "what the playbook should remember about which perspective works for this kind of task"
}`;

export async function arenaChallenge({ task, context = '', agentCount = 3, timeoutMs = 180_000 } = {}) {
  ensureTables();
  ensureArenaTables();

  const { runAgentAndWait, listAgents } = await import('../fleet/runtime.js');

  const arenaId = randomUUID().slice(0, 12);
  const t0 = now();
  const count = Math.min(6, Math.max(2, agentCount));

  // Perspective assesses to find the pattern and seed lenses
  let assessment;
  try {
    assessment = await Promise.race([
      assessSituation({ task, context }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
  } catch (_) {
    assessment = { perspectives: Object.keys(PERSPECTIVES).slice(0, count), pattern_match: 'unknown', confidence: 0.3 };
  }

  // Select agents by relevance to the task
  const agents = listAgents('local');
  const taskLower = task.toLowerCase();
  const words = taskLower.match(/[a-z]{3,}/g) || [];
  const scored = agents.map(a => {
    const text = `${a.id} ${a.name} ${a.role || ''} ${a.description || ''}`.toLowerCase();
    const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
    return { agent: a, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, count).map(s => s.agent);
  while (selected.length < count && selected.length < agents.length) {
    const extra = agents.find(a => !selected.find(s => s.id === a.id));
    if (extra) selected.push(extra); else break;
  }

  // Assign diverse perspectives — each contestant gets a different lens
  const lenses = Object.keys(PERSPECTIVES);
  const assignments = selected.map((agent, i) => ({
    agent,
    perspective: lenses[i % lenses.length],
  }));

  db.prepare(
    `INSERT INTO arena_sessions (id, task, pattern_match, contestant_count, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)`
  ).run(arenaId, task.slice(0, 4000), assessment.pattern_match || 'unknown', count, t0);

  try {
    publish('system', 'system.arena', JSON.stringify({
      action: 'started', arenaId, contestants: assignments.map(a => ({ agent: a.agent.id, perspective: a.perspective })),
    }));
  } catch (_) {}

  // Run all contestants in parallel
  const promises = assignments.map(({ agent, perspective }) => {
    const framedTask = `[Arena challenge — ${PERSPECTIVES[perspective]?.label || perspective} perspective]\n${PERSPECTIVES[perspective]?.approach || ''}\n\nTask: ${task}${context ? `\nContext: ${context}` : ''}`;
    return runAgentAndWait('local', agent.id, framedTask, undefined, timeoutMs)
      .then(result => ({ agentId: agent.id, perspective, output: result.lastReply || '[no output]', status: result.status, durationMs: now() - t0 }))
      .catch(e => ({ agentId: agent.id, perspective, output: `[error: ${e.message}]`, status: 'error', durationMs: now() - t0 }));
  });

  const results = await Promise.allSettled(promises);
  const entries = results.map(r => r.status === 'fulfilled' ? r.value : { agentId: 'unknown', perspective: 'unknown', output: '[promise rejected]', status: 'error', durationMs: 0 });

  // Judge through all lenses
  const contribText = entries.map(e =>
    `--- Contestant: ${e.agentId} | Lens: ${e.perspective} ---\n${e.output}`
  ).join('\n\n');

  let judgment;
  try {
    const response = await chatOllama([
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: `Task: ${task}\n\nContestants:\n${contribText}` },
    ]);
    judgment = parseJSON(response, { evaluations: [], winner: null, pattern_match: 'unknown', lesson: '' });
  } catch (_) {
    judgment = { evaluations: [], winner: null, pattern_match: 'unknown', lesson: 'judging failed' };
  }

  // Store entries with scores
  for (const entry of entries) {
    const eval_ = (judgment.evaluations || []).find(e => e.agentId === entry.agentId);
    db.prepare(
      `INSERT INTO arena_entries (id, arena_id, agent_id, perspective, output, scores, aggregate_score, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID().slice(0, 12), arenaId, entry.agentId, entry.perspective,
      entry.output?.slice(0, 8000), JSON.stringify(eval_?.scores || {}),
      eval_?.aggregate || null, entry.durationMs, now(),
    );
  }

  // Record winner and update playbook
  const winner = judgment.winner;
  const pattern = judgment.pattern_match || assessment.pattern_match || 'unknown';
  const duration = now() - t0;

  db.prepare(
    `UPDATE arena_sessions SET status = 'completed', winner_agent = ?, winner_perspective = ?, judgments = ?, duration_ms = ? WHERE id = ?`
  ).run(
    winner?.agentId || null, winner?.perspective || null,
    JSON.stringify(judgment).slice(0, 16000), duration, arenaId,
  );

  // Burn winning approach into the playbook
  if (winner?.perspective) {
    const existing = db.prepare('SELECT id, success_count, fail_count FROM perspective_playbook WHERE pattern = ?').get(pattern);
    if (existing) {
      db.prepare('UPDATE perspective_playbook SET success_count = success_count + 1, perspectives_used = ?, recommended_approach = ?, last_validated = ? WHERE id = ?').run(
        JSON.stringify([winner.perspective]), judgment.lesson || winner.reason || '', now(), existing.id,
      );
    } else {
      db.prepare('INSERT INTO perspective_playbook (id, pattern, recommended_approach, perspectives_used, success_count, fail_count, last_validated, created_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)').run(
        randomUUID(), pattern, judgment.lesson || winner.reason || '',
        JSON.stringify([winner.perspective]), now(), now(),
      );
    }
  }

  try {
    publish('system', 'system.arena', JSON.stringify({
      action: 'completed', arenaId, winner: winner?.agentId, winningPerspective: winner?.perspective,
      pattern, contestantCount: count, durationMs: duration,
    }));
  } catch (_) {}

  return {
    arenaId, task: task.slice(0, 200), pattern,
    contestants: entries.map(e => ({ agent: e.agentId, perspective: e.perspective, status: e.status })),
    evaluations: judgment.evaluations || [],
    winner, lesson: judgment.lesson,
    durationMs: duration,
  };
}

export function getArenaSession(id) {
  ensureArenaTables();
  const session = db.prepare('SELECT * FROM arena_sessions WHERE id = ?').get(id);
  if (!session) return null;
  session.entries = db.prepare('SELECT * FROM arena_entries WHERE arena_id = ? ORDER BY aggregate_score DESC').all(id);
  session.entries.forEach(e => { try { e.scores_parsed = JSON.parse(e.scores || '{}'); } catch { e.scores_parsed = {}; } });
  try { session.judgments_parsed = JSON.parse(session.judgments || '{}'); } catch { session.judgments_parsed = {}; }
  return session;
}

export function listArenas({ limit = 20 } = {}) {
  ensureArenaTables();
  return db.prepare(
    'SELECT id, task, pattern_match, contestant_count, status, winner_agent, winner_perspective, duration_ms, created_at FROM arena_sessions ORDER BY created_at DESC LIMIT ?'
  ).all(Math.min(100, Math.max(1, limit)));
}

export function getArenaStats() {
  ensureArenaTables();
  const total = db.prepare('SELECT COUNT(*) as c FROM arena_sessions').get().c;
  const completed = db.prepare("SELECT COUNT(*) as c FROM arena_sessions WHERE status = 'completed'").get().c;
  const avgDuration = db.prepare('SELECT AVG(duration_ms) as avg FROM arena_sessions WHERE duration_ms IS NOT NULL').get().avg;
  const winsByPerspective = db.prepare(
    "SELECT winner_perspective, COUNT(*) as wins FROM arena_sessions WHERE winner_perspective IS NOT NULL GROUP BY winner_perspective ORDER BY wins DESC"
  ).all();
  const topAgents = db.prepare(
    "SELECT winner_agent, COUNT(*) as wins FROM arena_sessions WHERE winner_agent IS NOT NULL GROUP BY winner_agent ORDER BY wins DESC LIMIT 10"
  ).all();
  return { total, completed, avgDurationMs: avgDuration ? Math.round(avgDuration) : null, winsByPerspective, topAgents };
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
