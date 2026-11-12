import { poolChat } from './model-pool.js';
import { db } from '../db.js';
import { sanitizeOllamaContent } from '../fraymus/intelligence/ollama-sanitize.js';

const OLLAMA = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

db.exec(`
  CREATE TABLE IF NOT EXISTS thought_streams (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    task TEXT NOT NULL,
    domain TEXT DEFAULT 'general',
    reasoning_trace TEXT NOT NULL,
    alternatives TEXT DEFAULT '[]',
    pivots TEXT DEFAULT '[]',
    dead_ends TEXT DEFAULT '[]',
    confidence_arc TEXT DEFAULT '[]',
    insights TEXT DEFAULT '[]',
    emotional_valence TEXT DEFAULT '{}',
    depth INTEGER DEFAULT 1,
    duration_ms INTEGER,
    source TEXT DEFAULT 'fleet',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS subconscious_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    pattern_type TEXT NOT NULL,
    pattern TEXT NOT NULL,
    description TEXT,
    domain TEXT DEFAULT 'general',
    frequency INTEGER DEFAULT 1,
    strength REAL DEFAULT 0.5,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    examples TEXT DEFAULT '[]',
    UNIQUE(agent_id, pattern_type, pattern)
  );
  CREATE INDEX IF NOT EXISTS idx_thought_agent ON thought_streams(agent_id, domain);
  CREATE INDEX IF NOT EXISTS idx_thought_created ON thought_streams(created_at);
  CREATE INDEX IF NOT EXISTS idx_pattern_agent ON subconscious_patterns(agent_id, domain);
`);

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function chatOllama(prompt, system, timeout = 45000) {
  // through the model pool: the first machine that has the model and answers (intelligence/model-pool.js)
  return sanitizeOllamaContent(await poolChat([{ role: 'system', content: system }, { role: 'user', content: prompt }],
    { model: process.env.OLLAMA_MODEL || 'llama3.1:8b', label: 'subconscious', timeoutMs: timeout, temperature: 0.4 }));
}

function parseJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export function captureThought({
  agentId, task, domain = 'general', reasoningTrace,
  alternatives = [], pivots = [], deadEnds = [], confidenceArc = [],
  insights = [], emotionalValence = {}, depth = 1, durationMs, source = 'fleet',
}) {
  if (!agentId || !task || !reasoningTrace) throw new Error('agentId, task, and reasoningTrace are required');

  const id = uid();
  db.prepare(`
    INSERT INTO thought_streams (id, agent_id, task, domain, reasoning_trace, alternatives, pivots, dead_ends, confidence_arc, insights, emotional_valence, depth, duration_ms, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, agentId, task, domain, reasoningTrace,
    JSON.stringify(alternatives), JSON.stringify(pivots), JSON.stringify(deadEnds),
    JSON.stringify(confidenceArc), JSON.stringify(insights), JSON.stringify(emotionalValence),
    depth, durationMs ?? null, source,
  );

  try {
    import('../fleet/bus.js').then(({ publish }) => {
      publish('subconscious', 'system.subconscious', {
        thoughtId: id, agentId, domain, depth,
        insightCount: insights.length, pivotCount: pivots.length,
      });
    });
  } catch {}

  return { id, agentId, domain, depth, insightCount: insights.length };
}

export function getThought(id) {
  const row = db.prepare(`SELECT * FROM thought_streams WHERE id = ?`).get(id);
  if (!row) return null;
  return deserializeThought(row);
}

function deserializeThought(row) {
  return {
    ...row,
    alternatives: JSON.parse(row.alternatives || '[]'),
    pivots: JSON.parse(row.pivots || '[]'),
    dead_ends: JSON.parse(row.dead_ends || '[]'),
    confidence_arc: JSON.parse(row.confidence_arc || '[]'),
    insights: JSON.parse(row.insights || '[]'),
    emotional_valence: JSON.parse(row.emotional_valence || '{}'),
  };
}

export function listThoughts({ agentId, domain, limit = 30 } = {}) {
  let sql = 'SELECT * FROM thought_streams WHERE 1=1';
  const params = [];
  if (agentId) { sql += ' AND agent_id = ?'; params.push(agentId); }
  if (domain) { sql += ' AND domain = ?'; params.push(domain); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(100, Math.max(1, limit)));
  return db.prepare(sql).all(...params).map(deserializeThought);
}

export async function getSubconsciousContext({ agentId, task, domain = 'general', maxItems = 5 }) {
  const relevantThoughts = db.prepare(`
    SELECT id, agent_id, task, domain, insights, dead_ends, pivots, confidence_arc, emotional_valence, depth
    FROM thought_streams
    WHERE (agent_id = ? OR domain = ?)
    ORDER BY created_at DESC LIMIT 30
  `).all(agentId, domain);

  if (relevantThoughts.length === 0) return { context: '', thoughtIds: [], patternIds: [] };

  const thoughtSummaries = relevantThoughts.slice(0, 10).map(t => {
    const insights = JSON.parse(t.insights || '[]');
    const deadEnds = JSON.parse(t.dead_ends || '[]');
    const pivots = JSON.parse(t.pivots || '[]');
    return [
      `Task: ${t.task}`,
      insights.length ? `  Learned: ${insights.slice(0, 2).join('; ')}` : '',
      deadEnds.length ? `  Avoid: ${deadEnds.slice(0, 2).map(d => typeof d === 'string' ? d : d.approach || d).join('; ')}` : '',
      pivots.length ? `  Pivoted: ${pivots.slice(0, 1).map(p => typeof p === 'string' ? p : p.reason || p).join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const patterns = db.prepare(`
    SELECT pattern_type, pattern, description, strength
    FROM subconscious_patterns
    WHERE agent_id = ? AND (domain = ? OR domain = 'general')
    ORDER BY strength DESC, frequency DESC LIMIT 10
  `).all(agentId, domain);

  const patternBlock = patterns.length > 0
    ? '\n\nRecurring patterns:\n' + patterns.map(p =>
      `- [${p.pattern_type}] ${p.pattern}: ${p.description || ''} (strength: ${Math.round(p.strength * 100)}%)`
    ).join('\n')
    : '';

  const context = `[Subconscious context — reasoning traces from past work]\n\n${thoughtSummaries}${patternBlock}`;

  return {
    context,
    thoughtIds: relevantThoughts.slice(0, 10).map(t => t.id),
    patternIds: patterns.map(p => p.id),
  };
}

export async function distillPatterns(agentId, { domain, limit = 50 } = {}) {
  let sql = 'SELECT * FROM thought_streams WHERE agent_id = ?';
  const params = [agentId];
  if (domain) { sql += ' AND domain = ?'; params.push(domain); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const thoughts = db.prepare(sql).all(...params).map(deserializeThought);
  if (thoughts.length < 3) return { patterns: [], message: 'Need at least 3 thought streams to distill patterns' };

  const thoughtBlock = thoughts.map((t, i) => [
    `--- Thought ${i + 1}: "${t.task}" (depth: ${t.depth}) ---`,
    `Insights: ${t.insights.join('; ') || 'none'}`,
    `Dead ends: ${t.dead_ends.map(d => typeof d === 'string' ? d : d.approach || JSON.stringify(d)).join('; ') || 'none'}`,
    `Pivots: ${t.pivots.map(p => typeof p === 'string' ? p : p.reason || JSON.stringify(p)).join('; ') || 'none'}`,
    `Confidence arc: ${t.confidence_arc.join(' → ') || 'stable'}`,
  ].join('\n')).join('\n\n');

  const system = `You analyze an AI agent's reasoning traces to identify subconscious patterns — recurring biases, heuristics, blind spots, strengths, and preferences in how it thinks.

Pattern types:
- bias: systematic tendency to favor/avoid certain approaches
- heuristic: mental shortcut the agent uses repeatedly
- blind_spot: areas consistently overlooked or underexplored
- strength: domains/approaches where reasoning is consistently strong
- preference: recurring stylistic or methodological preferences

Respond in JSON:
{
  "patterns": [
    {
      "type": "bias|heuristic|blind_spot|strength|preference",
      "pattern": "short name (3-6 words)",
      "description": "1-2 sentence description of the pattern",
      "evidence": "brief evidence from the traces",
      "strength": 0.0-1.0,
      "domain": "domain this applies to"
    }
  ]
}

Return 3-8 patterns. Be specific and grounded in the evidence.`;

  const raw = await chatOllama(
    `Agent: ${agentId}\nDomain: ${domain || 'all'}\n\n${thoughtBlock}`,
    system,
    60000,
  );

  const parsed = parseJSON(raw);
  if (!parsed?.patterns) return { patterns: [], message: 'Pattern extraction failed', raw };

  const saved = [];
  for (const p of parsed.patterns.slice(0, 8)) {
    if (!p.type || !p.pattern) continue;

    const existing = db.prepare(
      `SELECT id, frequency, strength, examples FROM subconscious_patterns WHERE agent_id = ? AND pattern_type = ? AND pattern = ?`
    ).get(agentId, p.type, p.pattern);

    if (existing) {
      const examples = JSON.parse(existing.examples || '[]');
      if (p.evidence) examples.push(p.evidence);
      const newStrength = (existing.strength * existing.frequency + (p.strength || 0.5)) / (existing.frequency + 1);
      db.prepare(`
        UPDATE subconscious_patterns SET frequency = frequency + 1, strength = ?, description = ?, last_seen = datetime('now'), examples = ?, domain = ? WHERE id = ?
      `).run(newStrength, p.description || existing.description, JSON.stringify(examples.slice(-10)), p.domain || domain || 'general', existing.id);
      saved.push({ ...p, id: existing.id, updated: true });
    } else {
      const result = db.prepare(`
        INSERT INTO subconscious_patterns (agent_id, pattern_type, pattern, description, domain, strength, examples)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(agentId, p.type, p.pattern, p.description, p.domain || domain || 'general', p.strength || 0.5, JSON.stringify(p.evidence ? [p.evidence] : []));
      saved.push({ ...p, id: result.lastInsertRowid, created: true });
    }
  }

  return { patterns: saved, thoughtsAnalyzed: thoughts.length };
}

export async function introspect(agentId, { domain } = {}) {
  const patterns = db.prepare(`
    SELECT * FROM subconscious_patterns WHERE agent_id = ? ${domain ? 'AND (domain = ? OR domain = \'general\')' : ''}
    ORDER BY strength DESC, frequency DESC LIMIT 15
  `).all(...(domain ? [agentId, domain] : [agentId]));

  const recentThoughts = db.prepare(`
    SELECT task, insights, dead_ends, pivots, depth, created_at FROM thought_streams
    WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10
  `).all(agentId).map(t => ({
    ...t,
    insights: JSON.parse(t.insights || '[]'),
    dead_ends: JSON.parse(t.dead_ends || '[]'),
    pivots: JSON.parse(t.pivots || '[]'),
  }));

  if (patterns.length === 0 && recentThoughts.length === 0) {
    return { agentId, report: 'No subconscious data yet. Run tasks and capture thinking to build the subconscious.', patterns: [], blindSpots: [], strengths: [] };
  }

  const biases = patterns.filter(p => p.pattern_type === 'bias');
  const blindSpots = patterns.filter(p => p.pattern_type === 'blind_spot');
  const strengths = patterns.filter(p => p.pattern_type === 'strength');
  const heuristics = patterns.filter(p => p.pattern_type === 'heuristic');
  const preferences = patterns.filter(p => p.pattern_type === 'preference');

  const avgDepth = recentThoughts.length > 0
    ? recentThoughts.reduce((s, t) => s + t.depth, 0) / recentThoughts.length
    : 0;

  const totalInsights = recentThoughts.reduce((s, t) => s + t.insights.length, 0);
  const totalDeadEnds = recentThoughts.reduce((s, t) => s + t.dead_ends.length, 0);
  const totalPivots = recentThoughts.reduce((s, t) => s + t.pivots.length, 0);

  const report = [
    `## Introspection: ${agentId}`,
    `Subconscious depth: ${patterns.length} patterns from ${recentThoughts.length} recent thought streams`,
    `Average reasoning depth: ${avgDepth.toFixed(1)} | Insights: ${totalInsights} | Dead ends: ${totalDeadEnds} | Pivots: ${totalPivots}`,
    '',
    strengths.length ? `**Strengths**: ${strengths.map(s => `${s.pattern} (${Math.round(s.strength * 100)}%)`).join(', ')}` : '',
    biases.length ? `**Biases**: ${biases.map(b => `${b.pattern} (${Math.round(b.strength * 100)}%)`).join(', ')}` : '',
    blindSpots.length ? `**Blind spots**: ${blindSpots.map(b => `${b.pattern} (${Math.round(b.strength * 100)}%)`).join(', ')}` : '',
    heuristics.length ? `**Heuristics**: ${heuristics.map(h => `${h.pattern} (${Math.round(h.strength * 100)}%)`).join(', ')}` : '',
    preferences.length ? `**Preferences**: ${preferences.map(p => `${p.pattern} (${Math.round(p.strength * 100)}%)`).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  return {
    agentId,
    report,
    patterns: patterns.map(p => ({ ...p, examples: JSON.parse(p.examples || '[]') })),
    meta: { avgDepth, totalInsights, totalDeadEnds, totalPivots, patternCount: patterns.length, thoughtCount: recentThoughts.length },
    blindSpots: blindSpots.map(b => b.pattern),
    strengths: strengths.map(s => s.pattern),
    biases: biases.map(b => b.pattern),
  };
}

export function getSubconsciousStats() {
  const totalThoughts = db.prepare(`SELECT COUNT(*) as c FROM thought_streams`).get().c;
  const totalPatterns = db.prepare(`SELECT COUNT(*) as c FROM subconscious_patterns`).get().c;
  const agents = db.prepare(`SELECT COUNT(DISTINCT agent_id) as c FROM thought_streams`).get().c;
  const domains = db.prepare(`SELECT COUNT(DISTINCT domain) as c FROM thought_streams`).get().c;
  const avgDepth = db.prepare(`SELECT AVG(depth) as v FROM thought_streams`).get().v;

  const patternTypes = db.prepare(`
    SELECT pattern_type, COUNT(*) as count, AVG(strength) as avg_strength
    FROM subconscious_patterns GROUP BY pattern_type ORDER BY count DESC
  `).all();

  const topAgents = db.prepare(`
    SELECT agent_id, COUNT(*) as thoughts,
      (SELECT COUNT(*) FROM subconscious_patterns sp WHERE sp.agent_id = ts.agent_id) as patterns
    FROM thought_streams ts GROUP BY agent_id ORDER BY thoughts DESC LIMIT 5
  `).all();

  const recentInsights = db.prepare(`
    SELECT agent_id, task, insights, created_at FROM thought_streams
    WHERE insights != '[]' ORDER BY created_at DESC LIMIT 5
  `).all().map(r => ({ ...r, insights: JSON.parse(r.insights || '[]') }));

  return { totalThoughts, totalPatterns, agents, domains, avgDepth, patternTypes, topAgents, recentInsights };
}

export function getPatterns(agentId, { domain, type, limit = 20 } = {}) {
  let sql = 'SELECT * FROM subconscious_patterns WHERE agent_id = ?';
  const params = [agentId];
  if (domain) { sql += ' AND (domain = ? OR domain = \'general\')'; params.push(domain); }
  if (type) { sql += ' AND pattern_type = ?'; params.push(type); }
  sql += ' ORDER BY strength DESC, frequency DESC LIMIT ?';
  params.push(Math.min(50, Math.max(1, limit)));
  return db.prepare(sql).all(...params).map(p => ({ ...p, examples: JSON.parse(p.examples || '[]') }));
}

export function installSubconsciousRoutes(app) {
  app.get('/api/intelligence/subconscious/stats', (_req, res, next) => {
    try { res.json(getSubconsciousStats()); } catch (e) { next(e); }
  });

  app.post('/api/intelligence/subconscious/capture', async (req, res, next) => {
    try {
      const { agentId, task, domain, reasoningTrace, alternatives, pivots, deadEnds, confidenceArc, insights, emotionalValence, depth, durationMs, source } = req.body;
      if (!agentId || !task || !reasoningTrace) return res.status(400).json({ error: 'agentId, task, and reasoningTrace are required' });
      const result = captureThought({ agentId, task, domain, reasoningTrace, alternatives, pivots, deadEnds, confidenceArc, insights, emotionalValence, depth, durationMs, source });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/subconscious/thoughts', (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
      res.json({ thoughts: listThoughts({ agentId: req.query.agentId, domain: req.query.domain, limit }) });
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/subconscious/thought/:id', (req, res, next) => {
    try {
      const thought = getThought(req.params.id);
      if (!thought) return res.status(404).json({ error: 'Thought stream not found' });
      res.json(thought);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/subconscious/context', async (req, res, next) => {
    try {
      const { agentId, task, domain } = req.query;
      if (!agentId || !task) return res.status(400).json({ error: 'agentId and task are required' });
      const ctx = await getSubconsciousContext({ agentId, task, domain });
      res.json(ctx);
    } catch (e) { next(e); }
  });

  app.post('/api/intelligence/subconscious/distill', async (req, res, next) => {
    try {
      const { agentId, domain, limit } = req.body;
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });
      const result = await distillPatterns(agentId, { domain, limit });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/subconscious/introspect/:agentId', async (req, res, next) => {
    try {
      const result = await introspect(req.params.agentId, { domain: req.query.domain });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/subconscious/patterns/:agentId', (req, res, next) => {
    try {
      const patterns = getPatterns(req.params.agentId, {
        domain: req.query.domain,
        type: req.query.type,
        limit: parseInt(req.query.limit) || 20,
      });
      res.json({ patterns });
    } catch (e) { next(e); }
  });
}
