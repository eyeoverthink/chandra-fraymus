import { Router } from 'express';
import { db } from './db.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const router = Router();

function safe(sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch { return []; }
}

function safeOne(sql, params = []) {
  try { return db.prepare(sql).get(...params) || {}; }
  catch { return {}; }
}

function loadManifestRoles() {
  const roles = new Map();
  try {
    const dir = join(process.cwd(), 'agents');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const txt = readFileSync(join(dir, f), 'utf8');
      const m = txt.match(/^id:\s*(.+)/m);
      const r = txt.match(/^role:\s*(.+)/m);
      if (m) roles.set(m[1].trim(), r ? r[1].trim() : 'agent');
    }
  } catch { /* agents dir missing */ }
  try {
    const dir = join(process.cwd(), 'data', 'agents');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const txt = readFileSync(join(dir, f), 'utf8');
      const m = txt.match(/^id:\s*(.+)/m);
      const r = txt.match(/^role:\s*(.+)/m);
      if (m) roles.set(m[1].trim(), r ? r[1].trim() : 'forged');
    }
  } catch { /* data/agents dir missing */ }
  return roles;
}

const ACHIEVEMENTS = [
  { id: 'first_run', label: 'First Steps', emoji: '👣', desc: 'Completed first run', check: e => e.runs >= 1 },
  { id: 'marathoner', label: 'Marathoner', emoji: '🏃', desc: '10+ runs completed', check: e => e.runs >= 10 },
  { id: 'chatterbox', label: 'Chatterbox', emoji: '💬', desc: '5+ bus messages sent', check: e => e.busMessages >= 5 },
  { id: 'broadcaster', label: 'Broadcaster', emoji: '📢', desc: '20+ bus messages', check: e => e.busMessages >= 20 },
  { id: 'learner', label: 'Learner', emoji: '📚', desc: 'Stored first memory', check: e => e.memories >= 1 },
  { id: 'encyclopedia', label: 'Encyclopedia', emoji: '🔮', desc: '5+ memories stored', check: e => e.memories >= 5 },
  { id: 'creator', label: 'Creator', emoji: '⚒️', desc: 'Forged an agent', check: e => e.forged >= 1 },
  { id: 'architect', label: 'Architect', emoji: '🏛️', desc: 'Forged 3+ agents', check: e => e.forged >= 3 },
  { id: 'thinker', label: 'Thinker', emoji: '🤔', desc: 'Triggered a reflection', check: e => e.reflections >= 1 },
  { id: 'perfectionist', label: 'Perfectionist', emoji: '✅', desc: 'Perfect success rate', check: e => e.runs > 0 && e.successes === e.runs },
  { id: 'confident', label: 'High Confidence', emoji: '🎯', desc: 'Avg memory confidence > 0.8', check: e => e.avgConfidence > 0.8 },
  { id: 'polymath', label: 'Polymath', emoji: '🌟', desc: 'Active in 3+ categories', check: e => [e.runs, e.busMessages, e.memories, e.forged, e.reflections].filter(v => v > 0).length >= 3 },
];

const ROLE_COLORS = {
  'intelligence': '#a78bfa',
  'commerce': '#f472b6',
  'research': '#22d3ee',
  'operations': '#34d399',
  'security': '#ef4444',
  'creative': '#f59e0b',
  'forged': '#c084fc',
  'agent': '#60a5fa',
};

function roleColor(role) {
  if (!role) return '#60a5fa';
  const lower = role.toLowerCase();
  for (const [key, col] of Object.entries(ROLE_COLORS)) {
    if (lower.includes(key)) return col;
  }
  return '#60a5fa';
}

router.get('/api/leaderboard', (req, res, next) => {
  try {
    const agents = safe(`SELECT id, name FROM agents ORDER BY name`);
    const agentMap = new Map(agents.map(a => [a.id, a.name]));
    const manifestRoles = loadManifestRoles();

    const runsByAgent = safe(`SELECT model, status, COUNT(*) as c FROM runs GROUP BY model, status`);
    const busByAgent = safe(`SELECT from_agent, COUNT(*) as c FROM bus_messages GROUP BY from_agent ORDER BY c DESC`);
    const memoriesByAgent = safe(`SELECT agent_id, COUNT(*) as c, ROUND(AVG(confidence), 2) as avgConf FROM agent_memories GROUP BY agent_id`);
    const forgedByAgent = safe(`SELECT forged_by, COUNT(*) as c FROM forged_agents GROUP BY forged_by`);
    const forgedAgents = safe(`SELECT agent_id, forged_by, goal, created_at FROM forged_agents ORDER BY created_at DESC`);

    const reflectionsByTrigger = safe(`SELECT trigger, COUNT(*) as c, ROUND(AVG(duration_ms), 0) as avgDur FROM reflections GROUP BY trigger`);
    const verificationLoops = safe(`SELECT triggered_by, status, COUNT(*) as c FROM verification_loops GROUP BY triggered_by, status`);
    const daemonCycles = safe(`SELECT type, COUNT(*) as c FROM daemon_cycles GROUP BY type`);
    const threadsByAgent = safe(`SELECT agent_id, COUNT(*) as c FROM threads GROUP BY agent_id`);

    const busTopics = safe(`SELECT from_agent, topic, COUNT(*) as c FROM bus_messages GROUP BY from_agent, topic ORDER BY c DESC`);

    const recentRuns = safe(`SELECT model, created_at FROM runs WHERE created_at > ? ORDER BY created_at ASC`, [Date.now() - 7 * 86400000]);
    const recentBus = safe(`SELECT from_agent, created_at FROM bus_messages WHERE created_at > ? ORDER BY created_at ASC`, [Date.now() - 7 * 86400000]);

    const scores = new Map();

    function ensure(id) {
      if (!scores.has(id)) {
        const role = manifestRoles.get(id) || 'agent';
        scores.set(id, {
          id,
          name: agentMap.get(id) || id,
          role,
          roleColor: roleColor(role),
          runs: 0, successes: 0, failures: 0,
          busMessages: 0,
          memories: 0, avgConfidence: 0,
          forged: 0,
          reflections: 0,
          verifications: 0,
          threads: 0,
          topTopics: [],
          achievements: [],
          categories: { execution: 0, communication: 0, knowledge: 0, creation: 0, evolution: 0, reliability: 0 },
          sparkline: new Array(7).fill(0),
          score: 0,
        });
      }
      return scores.get(id);
    }

    for (const r of runsByAgent) {
      const agentId = (r.model || '').split(':')[0];
      if (!agentId) continue;
      const entry = ensure(agentId);
      entry.runs += r.c;
      if (r.status === 'done' || r.status === 'success') entry.successes += r.c;
      if (r.status === 'error' || r.status === 'failed') entry.failures += r.c;
    }

    for (const b of busByAgent) {
      if (!b.from_agent) continue;
      const entry = ensure(b.from_agent);
      entry.busMessages += b.c;
    }

    for (const m of memoriesByAgent) {
      if (!m.agent_id) continue;
      const entry = ensure(m.agent_id);
      entry.memories += m.c;
      entry.avgConfidence = m.avgConf || 0;
    }

    for (const f of forgedByAgent) {
      if (!f.forged_by) continue;
      const entry = ensure(f.forged_by);
      entry.forged += f.c;
    }

    for (const t of threadsByAgent) {
      if (!t.agent_id) continue;
      const entry = ensure(t.agent_id);
      entry.threads += t.c;
    }

    const topicMap = new Map();
    for (const bt of busTopics) {
      if (!bt.from_agent) continue;
      if (!topicMap.has(bt.from_agent)) topicMap.set(bt.from_agent, []);
      topicMap.get(bt.from_agent).push({ topic: bt.topic, count: bt.c });
    }
    for (const [agentId, topics] of topicMap) {
      if (scores.has(agentId)) {
        scores.get(agentId).topTopics = topics.slice(0, 3);
      }
    }

    const now = Date.now();
    const dayMs = 86400000;
    for (const r of recentRuns) {
      const agentId = (r.model || '').split(':')[0];
      if (!agentId || !scores.has(agentId)) continue;
      const dayIdx = 6 - Math.floor((now - r.created_at) / dayMs);
      if (dayIdx >= 0 && dayIdx < 7) scores.get(agentId).sparkline[dayIdx]++;
    }
    for (const b of recentBus) {
      if (!b.from_agent || !scores.has(b.from_agent)) continue;
      const dayIdx = 6 - Math.floor((now - b.created_at) / dayMs);
      if (dayIdx >= 0 && dayIdx < 7) scores.get(b.from_agent).sparkline[dayIdx]++;
    }

    const totalReflections = reflectionsByTrigger.reduce((s, r) => s + r.c, 0);
    const totalVerifications = verificationLoops.reduce((s, v) => s + v.c, 0);
    const totalDaemonCycles = daemonCycles.reduce((s, d) => s + d.c, 0);

    for (const [, entry] of scores) {
      const cat = entry.categories;
      cat.execution = (entry.runs * 10) + (entry.successes * 5);
      cat.communication = (entry.busMessages * 2) + (entry.threads * 3);
      cat.knowledge = (entry.memories * 3) + Math.round(entry.avgConfidence * 10);
      cat.creation = (entry.forged * 20);
      cat.evolution = (entry.reflections * 8) + (entry.verifications * 12);
      cat.reliability = entry.runs > 0
        ? Math.round((entry.successes / entry.runs) * 20)
        : 0;

      entry.score = cat.execution + cat.communication + cat.knowledge + cat.creation + cat.evolution + cat.reliability;

      entry.achievements = ACHIEVEMENTS.filter(a => a.check(entry)).map(a => ({
        id: a.id, label: a.label, emoji: a.emoji, desc: a.desc,
      }));
    }

    const ranked = [...scores.values()]
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score);

    ranked.forEach((entry, i) => { entry.rank = i + 1; });

    const totalRuns = ranked.reduce((s, e) => s + e.runs, 0);
    const totalBus = ranked.reduce((s, e) => s + e.busMessages, 0);
    const totalMemories = ranked.reduce((s, e) => s + e.memories, 0);
    const totalForged = forgedAgents.length;
    const totalThreads = ranked.reduce((s, e) => s + e.threads, 0);

    const topRunner = ranked.reduce((best, e) => e.runs > (best?.runs || 0) ? e : best, null);
    const topCommunicator = ranked.reduce((best, e) => e.busMessages > (best?.busMessages || 0) ? e : best, null);
    const topScholar = ranked.reduce((best, e) => e.memories > (best?.memories || 0) ? e : best, null);
    const topForger = ranked.reduce((best, e) => e.forged > (best?.forged || 0) ? e : best, null);
    const mvp = ranked[0] || null;

    res.json({
      leaderboard: ranked,
      totals: {
        agents: agents.length,
        runs: totalRuns,
        busMessages: totalBus,
        memories: totalMemories,
        forged: totalForged,
        threads: totalThreads,
        reflections: totalReflections,
        verifications: totalVerifications,
        daemonCycles: totalDaemonCycles,
      },
      titles: {
        runner: topRunner ? { id: topRunner.id, name: topRunner.name, value: topRunner.runs } : null,
        communicator: topCommunicator ? { id: topCommunicator.id, name: topCommunicator.name, value: topCommunicator.busMessages } : null,
        scholar: topScholar ? { id: topScholar.id, name: topScholar.name, value: topScholar.memories } : null,
        forger: topForger ? { id: topForger.id, name: topForger.name, value: topForger.forged } : null,
        mvp: mvp ? { id: mvp.id, name: mvp.name, value: mvp.score } : null,
      },
      forgeLineage: forgedAgents.map(f => ({ id: f.agent_id, by: f.forged_by, goal: f.goal, at: f.created_at })),
      achievementCatalog: ACHIEVEMENTS.map(a => ({ id: a.id, label: a.label, emoji: a.emoji, desc: a.desc })),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
