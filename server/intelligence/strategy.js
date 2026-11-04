import { db } from '../db.js';
import { sanitizeOllamaContent } from '../fraymus/intelligence/ollama-sanitize.js';

const OLLAMA = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

db.exec(`
  CREATE TABLE IF NOT EXISTS strategy_sessions (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    context TEXT DEFAULT '',
    analysis TEXT DEFAULT '{}',
    plan TEXT DEFAULT '{}',
    execution_path TEXT DEFAULT '',
    result TEXT DEFAULT '{}',
    outcome_score REAL,
    duration_ms INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS strategy_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    recommended_path TEXT NOT NULL,
    success_rate REAL DEFAULT 0.5,
    uses INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

const EXECUTION_PATHS = [
  { id: 'single_agent', label: 'Single Agent', desc: 'One specialist agent handles the task directly' },
  { id: 'swarm', label: 'Swarm Protocol', desc: 'Multiple agents tackle it from different perspectives, outputs synthesized' },
  { id: 'debate', label: 'Debate Protocol', desc: 'Adversarial debate between agents to find the strongest position' },
  { id: 'pipeline', label: 'Workflow Pipeline', desc: 'Sequential multi-step workflow with specialized nodes' },
  { id: 'decompose', label: 'Decompose + Multi-path', desc: 'Break into sub-tasks, each routed to the best execution path' },
  { id: 'verify_loop', label: 'Generator-Verifier Loop', desc: 'Generate code/solution, verify adversarially, iterate until approved' },
];

const ANALYSIS_PROMPT = `You are a strategic task analyzer for an AI agent system. Given a task, analyze it and recommend the best execution path.

Available execution paths:
${EXECUTION_PATHS.map(p => `- ${p.id}: ${p.desc}`).join('\n')}

Available agents (partial list): Ariadne (navigation/search), Cantor (math/logic), Concierge (user-facing), DevArchivist (code/docs), Director (orchestration), Fraymus Prime (intelligence), Genesis (creation), Helix (data), Lumen (analysis), Solon (policy/ethics), Spearhead (execution), Tycho (research)

Historical patterns that worked well:
{patterns}

Respond in JSON only:
{
  "complexity": "low|medium|high|critical",
  "domain": "brief domain classification",
  "requires_creativity": true/false,
  "requires_precision": true/false,
  "requires_multiple_viewpoints": true/false,
  "requires_adversarial_checking": true/false,
  "decomposable": true/false,
  "sub_tasks": ["only if decomposable, list 2-5 sub-tasks"],
  "recommended_path": "one of the execution path ids",
  "recommended_agents": ["1-3 agent names best suited"],
  "reasoning": "2-3 sentences explaining the choice",
  "confidence": 0.0-1.0,
  "parameters": {
    "agentCount": 3,
    "perspectiveMode": "diverse|focused|auto",
    "timeoutMs": 60000
  }
}`;

async function chatOllama(prompt, system) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: { temperature: 0.3 },
      }),
      signal: ctrl.signal,
    });
    const data = await res.json();
    return sanitizeOllamaContent(data.message?.content || '');
  } finally { clearTimeout(timer); }
}

function parseJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function getPatterns() {
  try {
    return db.prepare(
      `SELECT pattern, recommended_path, success_rate FROM strategy_patterns WHERE uses > 0 ORDER BY success_rate DESC LIMIT 5`
    ).all();
  } catch { return []; }
}

export async function analyzeTask(task, context = '') {
  const patterns = getPatterns();
  const patternBlock = patterns.length > 0
    ? patterns.map(p => `- "${p.pattern}" → ${p.recommended_path} (${Math.round(p.success_rate * 100)}% success)`).join('\n')
    : 'No historical patterns yet.';

  const system = ANALYSIS_PROMPT.replace('{patterns}', patternBlock);
  const prompt = `Task: ${task}${context ? `\nContext: ${context}` : ''}`;

  const raw = await chatOllama(prompt, system);
  const analysis = parseJSON(raw);

  if (!analysis) {
    return {
      complexity: 'medium',
      domain: 'general',
      recommended_path: 'single_agent',
      recommended_agents: ['fraymus-prime'],
      reasoning: 'Analysis parsing failed, defaulting to single agent execution.',
      confidence: 0.3,
      parameters: { agentCount: 1, timeoutMs: 60000 },
    };
  }
  return analysis;
}

export async function executeStrategy({ task, context = '', autoExecute = false }) {
  const id = uid();
  const start = Date.now();

  db.prepare(
    `INSERT INTO strategy_sessions (id, task, context, status) VALUES (?, ?, ?, 'analyzing')`
  ).run(id, task, context);

  let analysis;
  try {
    analysis = await analyzeTask(task, context);
  } catch (e) {
    db.prepare(`UPDATE strategy_sessions SET status = 'error', result = ? WHERE id = ?`)
      .run(JSON.stringify({ error: e.message }), id);
    return { strategyId: id, status: 'error', error: e.message };
  }

  db.prepare(
    `UPDATE strategy_sessions SET analysis = ?, plan = ?, execution_path = ?, status = ? WHERE id = ?`
  ).run(
    JSON.stringify(analysis),
    JSON.stringify({
      path: analysis.recommended_path,
      agents: analysis.recommended_agents,
      parameters: analysis.parameters,
    }),
    analysis.recommended_path,
    autoExecute ? 'executing' : 'planned',
    id
  );

  if (!autoExecute) {
    const duration = Date.now() - start;
    db.prepare(`UPDATE strategy_sessions SET duration_ms = ? WHERE id = ?`).run(duration, id);

    updatePattern(task, analysis.recommended_path);

    return {
      strategyId: id,
      status: 'planned',
      analysis,
      recommendedPath: analysis.recommended_path,
      recommendedAgents: analysis.recommended_agents,
      reasoning: analysis.reasoning,
      confidence: analysis.confidence,
      parameters: analysis.parameters,
    };
  }

  let execResult;
  try {
    execResult = await dispatchExecution(task, context, analysis);
  } catch (e) {
    execResult = { error: e.message };
  }

  const duration = Date.now() - start;
  const outcomeScore = execResult.error ? 0.1 : (execResult.quality || 0.5);

  db.prepare(
    `UPDATE strategy_sessions SET result = ?, outcome_score = ?, duration_ms = ?, status = ? WHERE id = ?`
  ).run(JSON.stringify(execResult), outcomeScore, duration, execResult.error ? 'error' : 'completed', id);

  updatePattern(task, analysis.recommended_path, outcomeScore);

  try {
    const { publish } = await import('../fleet/bus.js');
    publish('strategy-engine', 'system.strategy', {
      strategyId: id, path: analysis.recommended_path,
      agents: analysis.recommended_agents, quality: outcomeScore, durationMs: duration,
    });
  } catch {}

  return {
    strategyId: id,
    status: execResult.error ? 'error' : 'completed',
    analysis,
    executionPath: analysis.recommended_path,
    result: execResult,
    quality: outcomeScore,
    durationMs: duration,
  };
}

async function dispatchExecution(task, context, analysis) {
  const path = analysis.recommended_path;

  if (path === 'single_agent') {
    const agentId = analysis.recommended_agents?.[0] || 'fraymus-prime';
    try {
      const { runAgentAndWait } = await import('../fleet/runtime.js');
      const result = await runAgentAndWait('system', agentId, task, null, analysis.parameters?.timeoutMs || 60000);
      return { type: 'single_agent', agentId, runId: result.runId, reply: result.lastReply, quality: result.status === 'completed' ? 0.7 : 0.3 };
    } catch (e) { return { type: 'single_agent', error: e.message }; }
  }

  if (path === 'swarm') {
    try {
      const { initiateSwarm } = await import('./swarm.js');
      const result = await initiateSwarm({
        task, context,
        agentCount: analysis.parameters?.agentCount || 3,
        perspectiveMode: analysis.parameters?.perspectiveMode || 'diverse',
        timeoutMs: analysis.parameters?.timeoutMs || 90000,
      });
      return { type: 'swarm', swarmId: result.swarmId, synthesis: result.synthesis, quality: result.quality, insights: result.keyInsights };
    } catch (e) { return { type: 'swarm', error: e.message }; }
  }

  if (path === 'debate') {
    try {
      const { initiateDebate } = await import('./debate.js');
      const result = await initiateDebate({ proposition: task, context, rounds: 3 });
      return { type: 'debate', debateId: result.debateId, verdict: result.verdict, confidence: result.confidence, quality: result.confidence || 0.5 };
    } catch (e) { return { type: 'debate', error: e.message }; }
  }

  if (path === 'verify_loop') {
    try {
      const { runVerificationLoop } = await import('./verifier-loop.js');
      const result = await runVerificationLoop({ task, language: 'javascript', maxIterations: 3 });
      return { type: 'verify_loop', loopId: result.loopId, approved: result.approved, iterations: result.iterations, quality: result.approved ? 0.9 : 0.3 };
    } catch (e) { return { type: 'verify_loop', error: e.message }; }
  }

  if (path === 'decompose') {
    const subTasks = analysis.sub_tasks || [task];
    const subResults = [];
    for (const sub of subTasks.slice(0, 5)) {
      try {
        const subAnalysis = await analyzeTask(sub, `Part of larger task: ${task}`);
        const subResult = await dispatchExecution(sub, context, { ...subAnalysis, recommended_path: subAnalysis.recommended_path === 'decompose' ? 'single_agent' : subAnalysis.recommended_path });
        subResults.push({ task: sub, path: subAnalysis.recommended_path, result: subResult });
      } catch (e) { subResults.push({ task: sub, error: e.message }); }
    }
    const successCount = subResults.filter(r => !r.error && !r.result?.error).length;
    return { type: 'decompose', subResults, quality: subResults.length > 0 ? successCount / subResults.length : 0.1 };
  }

  // Fallback: single agent
  try {
    const { runAgentAndWait } = await import('../fleet/runtime.js');
    const result = await runAgentAndWait('system', 'fraymus-prime', task, null, 60000);
    return { type: 'fallback', reply: result.lastReply, quality: 0.5 };
  } catch (e) { return { type: 'fallback', error: e.message }; }
}

function updatePattern(task, path, score) {
  const words = task.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
  const pattern = words.join(' ');
  if (!pattern) return;

  const existing = db.prepare(`SELECT id, success_rate, uses FROM strategy_patterns WHERE pattern = ?`).get(pattern);
  if (existing) {
    const newRate = score != null
      ? (existing.success_rate * existing.uses + score) / (existing.uses + 1)
      : existing.success_rate;
    db.prepare(
      `UPDATE strategy_patterns SET recommended_path = ?, success_rate = ?, uses = uses + 1, updated_at = datetime('now') WHERE id = ?`
    ).run(path, newRate, existing.id);
  } else {
    db.prepare(
      `INSERT INTO strategy_patterns (pattern, recommended_path, success_rate, uses) VALUES (?, ?, ?, 1)`
    ).run(pattern, path, score || 0.5);
  }
}

export function getStrategySession(id) {
  const row = db.prepare(`SELECT * FROM strategy_sessions WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    ...row,
    analysis: JSON.parse(row.analysis || '{}'),
    plan: JSON.parse(row.plan || '{}'),
    result: JSON.parse(row.result || '{}'),
  };
}

export function listStrategies(limit = 30) {
  return db.prepare(`SELECT * FROM strategy_sessions ORDER BY created_at DESC LIMIT ?`).all(limit).map(r => ({
    ...r,
    analysis: JSON.parse(r.analysis || '{}'),
    plan: JSON.parse(r.plan || '{}'),
    result: JSON.parse(r.result || '{}'),
  }));
}

export function getStrategyStats() {
  const total = db.prepare(`SELECT COUNT(*) as c FROM strategy_sessions`).get().c;
  const completed = db.prepare(`SELECT COUNT(*) as c FROM strategy_sessions WHERE status = 'completed'`).get().c;
  const avgQuality = db.prepare(`SELECT AVG(outcome_score) as v FROM strategy_sessions WHERE outcome_score IS NOT NULL`).get().v;
  const avgDuration = db.prepare(`SELECT AVG(duration_ms) as v FROM strategy_sessions WHERE duration_ms IS NOT NULL`).get().v;

  const pathDistribution = db.prepare(
    `SELECT execution_path as path, COUNT(*) as count, AVG(outcome_score) as avg_quality
     FROM strategy_sessions WHERE execution_path != '' GROUP BY execution_path ORDER BY count DESC`
  ).all();

  const topPatterns = db.prepare(
    `SELECT pattern, recommended_path, success_rate, uses FROM strategy_patterns ORDER BY uses DESC LIMIT 8`
  ).all();

  return { total, completed, avgQuality, avgDurationMs: avgDuration, pathDistribution, topPatterns };
}

export function installStrategyRoutes(app) {
  app.post('/api/intelligence/strategy', async (req, res, next) => {
    try {
      const { task, context, autoExecute } = req.body;
      if (!task) return res.status(400).json({ error: 'task is required' });
      const result = await executeStrategy({ task, context, autoExecute: !!autoExecute });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/strategy/stats', (_req, res, next) => {
    try { res.json(getStrategyStats()); } catch (e) { next(e); }
  });

  app.get('/api/intelligence/strategies', (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
      res.json({ strategies: listStrategies(limit) });
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/strategy/:id', (req, res, next) => {
    try {
      const session = getStrategySession(req.params.id);
      if (!session) return res.status(404).json({ error: 'Strategy session not found' });
      res.json(session);
    } catch (e) { next(e); }
  });
}
