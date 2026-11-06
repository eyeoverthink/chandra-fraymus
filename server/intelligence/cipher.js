/**
 * Agent Cipher — Compositional Team Intelligence
 *
 * Composes agents into persistent, evolving teams. A "cipher" is a team
 * recipe: which agents, what roles, what communication topology, and what
 * workflow connects them. Ciphers are saved, versioned, evolved, and can
 * reference other ciphers as sub-teams (teams of teams).
 *
 * Biological analogue: cell differentiation and organ formation — individual
 * cells (agents) specialize into tissues (teams) that form organs (ciphers
 * of ciphers), each with emergent capabilities beyond their components.
 *
 * Key concepts:
 *   - Cipher: a saved team recipe (agents + roles + topology + workflow)
 *   - Composition: LLM-driven team design from a natural language goal
 *   - Topology: how agents communicate (chain, mesh, hub-spoke, pipeline)
 *   - Evolution: OPEG-gated mutation of team composition based on performance
 *   - Materialization: running a cipher as a callable tool
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { listAgents, runAgentAndWait } from '../fleet/runtime.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { getAgentTrust, recommendAgents } from './trust.js';
import { analyze as analyzeEmotion } from '../fraymus/intelligence/heart.js';

const now = () => Date.now();

// ─── DB Schema ───────────────────────────────────────────────

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cipher_teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      goal TEXT NOT NULL,
      description TEXT DEFAULT '',
      topology TEXT NOT NULL DEFAULT 'chain',
      members TEXT NOT NULL DEFAULT '[]',
      sub_ciphers TEXT DEFAULT '[]',
      workflow TEXT DEFAULT '{}',
      parameters TEXT DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      parent_id TEXT,
      total_runs INTEGER DEFAULT 0,
      avg_quality REAL,
      avg_duration_ms REAL,
      best_run_quality REAL,
      evolved_from TEXT,
      gate_tier TEXT,
      status TEXT DEFAULT 'active',
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS cipher_runs (
      id TEXT PRIMARY KEY,
      cipher_id TEXT NOT NULL,
      cipher_version INTEGER,
      task TEXT NOT NULL,
      input TEXT,
      contributions TEXT DEFAULT '[]',
      synthesis TEXT,
      quality_score REAL,
      emotional_tone TEXT,
      duration_ms INTEGER,
      topology_used TEXT,
      status TEXT DEFAULT 'pending',
      gate_tier TEXT,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS cipher_evolutions (
      id TEXT PRIMARY KEY,
      cipher_id TEXT NOT NULL,
      from_version INTEGER,
      to_version INTEGER,
      mutation_type TEXT,
      mutation_detail TEXT,
      reason TEXT,
      quality_before REAL,
      quality_after REAL,
      gate_tier TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cipher_runs_cipher ON cipher_runs(cipher_id);
    CREATE INDEX IF NOT EXISTS idx_cipher_evolutions_cipher ON cipher_evolutions(cipher_id);
  `);
} catch (_) {}

// ─── Topologies ──────────────────────────────────────────────

const TOPOLOGIES = {
  chain: {
    label: 'Chain',
    desc: 'Sequential: each agent builds on the previous output',
    run: runChainTopology,
  },
  mesh: {
    label: 'Mesh',
    desc: 'All-to-all: every agent sees every other agents output, then synthesize',
    run: runMeshTopology,
  },
  hub_spoke: {
    label: 'Hub-Spoke',
    desc: 'Lead agent coordinates, delegates sub-tasks to specialists',
    run: runHubSpokeTopology,
  },
  pipeline: {
    label: 'Pipeline',
    desc: 'Staged workflow: agents grouped into stages, each stage runs in parallel',
    run: runPipelineTopology,
  },
};

// ─── Composition Prompt ──────────────────────────────────────

const COMPOSE_PROMPT = `You are the Cipher Architect for an autonomous AI organism called CHANDRA. Your job is to compose TEAMS of AI agents that work together to accomplish goals.

Available agents (with trust scores and specialties):
{agent_catalog}

Available topologies:
- chain: sequential processing, each agent builds on prior output (best for linear tasks)
- mesh: all-to-all communication then synthesis (best for multi-perspective analysis)
- hub_spoke: one lead coordinates specialists (best for complex decomposable tasks)
- pipeline: parallel stages then merge (best for multi-step production)

Rules:
- Select 2-6 agents per team
- Assign each a ROLE: "lead" (one only, coordinates), "specialist" (domain expert), "critic" (quality checker), "synthesizer" (combines outputs)
- A team needs at least one lead OR one synthesizer
- Match topology to the task structure
- Draw from trust scores — prefer agents with proven track records in relevant domains
- Write a brief system prompt OVERRIDE for each member that tells them their specific role in THIS team

Respond in JSON only, no markdown fences:
{
  "name": "kebab-case-team-name",
  "description": "1-2 sentence team purpose",
  "topology": "chain|mesh|hub_spoke|pipeline",
  "members": [
    {
      "agent_id": "agent-id-from-catalog",
      "role": "lead|specialist|critic|synthesizer",
      "stage": 1,
      "prompt_override": "Your specific role in this team..."
    }
  ],
  "parameters": {
    "max_rounds": 3,
    "quality_threshold": 0.7,
    "timeout_ms": 120000
  }
}`;

// ─── Core: Compose a Cipher ──────────────────────────────────

export async function composeCipher(goal, { context, composedBy = 'system', userId = 'local' } = {}) {
  if (!goal || typeof goal !== 'string') throw new Error('goal is required');

  const t0 = now();
  const mods = getAutonomyModifiers();
  const agents = listAgents(userId);

  // Heart emotion analysis of the goal — emotional tone shapes team composition
  const goalEmotion = analyzeEmotion(goal);

  const catalog = agents.map(a => {
    const trust = getAgentTrust(a.id);
    return `- ${a.id} (${a.name}): ${a.role || 'general'} | trust: ${(trust?.score ?? 0.5).toFixed(2)} | runs: ${trust?.total_runs ?? 0}`;
  }).join('\n');

  const prompt = COMPOSE_PROMPT
    .replace('{agent_catalog}', catalog);

  const emotionContext = goalEmotion.primary !== 'neutral'
    ? `\n\nEmotional tone of this goal: ${goalEmotion.primary} (intensity ${goalEmotion.intensity.toFixed(2)}, sentiment ${goalEmotion.sentiment.toFixed(2)}). Consider this emotional context when selecting team roles — e.g., high-anxiety tasks need a calming lead, creative/joyful goals benefit from a diverse mesh topology.`
    : '';

  const userMsg = context
    ? `Goal: ${goal}\n\nContext: ${context}${emotionContext}`
    : `Goal: ${goal}${emotionContext}`;

  let composition;
  try {
    const raw = await chatOllama([
      { role: 'system', content: prompt },
      { role: 'user', content: userMsg },
    ], { temperature: 0.7, maxTokens: 1024 });
    composition = parseJSON(raw);
  } catch (e) {
    throw new Error(`Cipher composition failed: ${e.message}`);
  }

  // Validate
  if (!composition.name || !composition.members || !Array.isArray(composition.members)) {
    throw new Error('Invalid composition: missing name or members');
  }
  if (composition.members.length < 2) throw new Error('Team needs at least 2 members');
  if (composition.members.length > 8) composition.members = composition.members.slice(0, 8);

  const topology = TOPOLOGIES[composition.topology] ? composition.topology : 'chain';
  const hasLeadOrSynth = composition.members.some(m => m.role === 'lead' || m.role === 'synthesizer');
  if (!hasLeadOrSynth) composition.members[0].role = 'lead';

  // Validate agent IDs exist
  const agentIds = new Set(agents.map(a => a.id));
  for (const m of composition.members) {
    if (!agentIds.has(m.agent_id)) {
      const closest = agents.find(a =>
        a.id.includes(m.agent_id.split('-')[0]) || a.name.toLowerCase().includes(m.agent_id.split('-')[0])
      );
      if (closest) m.agent_id = closest.id;
      else throw new Error(`Unknown agent: ${m.agent_id}`);
    }
  }

  const cipherId = randomUUID();
  const cipherName = composition.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 60);

  // Check for name collision
  const existing = db.prepare('SELECT id FROM cipher_teams WHERE name = ?').get(cipherName);
  const finalName = existing ? `${cipherName}-${Date.now().toString(36)}` : cipherName;

  const record = {
    id: cipherId,
    name: finalName,
    goal,
    description: composition.description || '',
    topology,
    members: JSON.stringify(composition.members),
    sub_ciphers: '[]',
    workflow: '{}',
    parameters: JSON.stringify(composition.parameters || {}),
    version: 1,
    parent_id: null,
    total_runs: 0,
    avg_quality: null,
    avg_duration_ms: null,
    best_run_quality: null,
    evolved_from: null,
    gate_tier: mods.tier,
    status: 'active',
    created_at: now(),
    updated_at: now(),
  };

  db.prepare(`INSERT INTO cipher_teams (id, name, goal, description, topology, members, sub_ciphers, workflow, parameters, version, parent_id, total_runs, avg_quality, avg_duration_ms, best_run_quality, evolved_from, gate_tier, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id, record.name, record.goal, record.description, record.topology,
    record.members, record.sub_ciphers, record.workflow, record.parameters,
    record.version, record.parent_id, record.total_runs, record.avg_quality,
    record.avg_duration_ms, record.best_run_quality, record.evolved_from,
    record.gate_tier, record.status, record.created_at, record.updated_at,
  );

  publish('system', 'system.cipher.composed', JSON.stringify({
    cipherId, name: finalName, goal: goal.slice(0, 200),
    topology, memberCount: composition.members.length,
    emotionalTone: goalEmotion.primary,
    durationMs: now() - t0,
  }));

  return {
    id: cipherId,
    name: finalName,
    goal,
    description: composition.description,
    topology,
    members: composition.members,
    parameters: composition.parameters || {},
    emotionalTone: { primary: goalEmotion.primary, intensity: goalEmotion.intensity, sentiment: goalEmotion.sentiment },
    version: 1,
    gateTier: mods.tier,
    composedAt: record.created_at,
  };
}

// ─── Core: Run a Cipher ──────────────────────────────────────

export async function runCipher(cipherIdOrName, task, { input, timeout, userId = 'local' } = {}) {
  const cipher = getCipher(cipherIdOrName);
  if (!cipher) throw new Error(`Cipher not found: ${cipherIdOrName}`);
  if (cipher.status !== 'active') throw new Error(`Cipher "${cipher.name}" is ${cipher.status}`);

  const t0 = now();
  const mods = getAutonomyModifiers();
  const members = JSON.parse(cipher.members);
  const params = JSON.parse(cipher.parameters || '{}');
  const effectiveTimeout = timeout || params.timeout_ms || 120_000;

  // Heart reads the emotional tone of the incoming task
  const taskEmotion = analyzeEmotion(task);

  const runId = randomUUID();
  db.prepare(`INSERT INTO cipher_runs (id, cipher_id, cipher_version, task, input, status, gate_tier, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`).run(
    runId, cipher.id, cipher.version, task, input ? JSON.stringify(input) : null, mods.tier, now(),
  );

  let contributions = [];
  let synthesis = null;
  let qualityScore = null;
  let status = 'completed';

  try {
    const topologyFn = TOPOLOGIES[cipher.topology]?.run || runChainTopology;
    const result = await topologyFn(members, task, input, { timeout: effectiveTimeout, params, userId });
    contributions = result.contributions;
    synthesis = result.synthesis;
    qualityScore = result.quality;
  } catch (e) {
    status = 'failed';
    synthesis = `Cipher run failed: ${e.message}`;
  }

  const duration = now() - t0;

  // Emotional analysis of the synthesis output
  const synthesisEmotion = synthesis ? analyzeEmotion(typeof synthesis === 'string' ? synthesis : JSON.stringify(synthesis)) : null;
  const emotionalTone = JSON.stringify({
    task: { primary: taskEmotion.primary, intensity: taskEmotion.intensity, sentiment: taskEmotion.sentiment },
    output: synthesisEmotion ? { primary: synthesisEmotion.primary, intensity: synthesisEmotion.intensity, sentiment: synthesisEmotion.sentiment } : null,
  });

  db.prepare(`UPDATE cipher_runs SET contributions = ?, synthesis = ?, quality_score = ?, emotional_tone = ?, duration_ms = ?, topology_used = ?, status = ? WHERE id = ?`).run(
    JSON.stringify(contributions), synthesis, qualityScore, emotionalTone, duration, cipher.topology, status, runId,
  );

  // Update cipher stats
  if (status === 'completed' && qualityScore != null) {
    const runs = cipher.total_runs + 1;
    const avgQ = cipher.avg_quality != null ? (cipher.avg_quality * cipher.total_runs + qualityScore) / runs : qualityScore;
    const avgD = cipher.avg_duration_ms != null ? (cipher.avg_duration_ms * cipher.total_runs + duration) / runs : duration;
    const bestQ = Math.max(cipher.best_run_quality || 0, qualityScore);
    db.prepare(`UPDATE cipher_teams SET total_runs = ?, avg_quality = ?, avg_duration_ms = ?, best_run_quality = ?, updated_at = ? WHERE id = ?`).run(
      runs, avgQ, avgD, bestQ, now(), cipher.id,
    );
  }

  publish('system', 'system.cipher.run', JSON.stringify({
    runId, cipherId: cipher.id, name: cipher.name, task: task.slice(0, 200),
    topology: cipher.topology, memberCount: members.length,
    quality: qualityScore, status, durationMs: duration,
    taskEmotion: taskEmotion.primary,
    outputEmotion: synthesisEmotion?.primary || 'neutral',
  }));

  return {
    id: runId,
    cipherId: cipher.id,
    cipherName: cipher.name,
    version: cipher.version,
    topology: cipher.topology,
    task,
    contributions,
    synthesis,
    quality: qualityScore,
    emotionalTone: {
      task: { primary: taskEmotion.primary, intensity: taskEmotion.intensity, sentiment: taskEmotion.sentiment },
      output: synthesisEmotion ? { primary: synthesisEmotion.primary, intensity: synthesisEmotion.intensity, sentiment: synthesisEmotion.sentiment } : null,
    },
    status,
    durationMs: duration,
    gateTier: mods.tier,
  };
}

// ─── Topology Runners ────────────────────────────────────────

async function runChainTopology(members, task, input, { timeout, userId = 'local' }) {
  const sorted = [...members].sort((a, b) => (a.stage || 1) - (b.stage || 1));
  const contributions = [];
  let lastOutput = '';

  for (const member of sorted) {
    const prompt = `${member.prompt_override || ''}\n\nTeam task: ${task}\n\nPrior output from chain:\n${lastOutput || '(you are first in the chain)'}`;
    try {
      const result = await runAgentAndWait(userId, member.agent_id, prompt, null, timeout);
      lastOutput = result?.lastReply || (typeof result === 'string' ? result : JSON.stringify(result));
      contributions.push({ agent_id: member.agent_id, role: member.role, output: lastOutput.slice(0, 4000) });
    } catch (e) {
      contributions.push({ agent_id: member.agent_id, role: member.role, output: `[error: ${e.message}]` });
    }
  }

  return { contributions, synthesis: lastOutput, quality: estimateQuality(contributions) };
}

async function runMeshTopology(members, task, input, { timeout, userId = 'local' }) {
  const contributions = [];

  // Phase 1: all agents tackle independently
  const independent = await Promise.allSettled(
    members.filter(m => m.role !== 'synthesizer').map(async member => {
      const prompt = `${member.prompt_override || ''}\n\nTeam task: ${task}`;
      const result = await runAgentAndWait(userId, member.agent_id, prompt, null, timeout);
      const output = result?.lastReply || (typeof result === 'string' ? result : JSON.stringify(result));
      return { agent_id: member.agent_id, role: member.role, output: output.slice(0, 3000) };
    })
  );

  for (const r of independent) {
    if (r.status === 'fulfilled') contributions.push(r.value);
    else contributions.push({ agent_id: 'unknown', role: 'error', output: r.reason?.message || 'failed' });
  }

  // Phase 2: synthesizer (or lead) merges
  const synthesizer = members.find(m => m.role === 'synthesizer') || members.find(m => m.role === 'lead') || members[0];
  const meshSummary = contributions.map(c => `[${c.agent_id} (${c.role})]: ${c.output}`).join('\n\n---\n\n');
  const synthPrompt = `${synthesizer.prompt_override || ''}\n\nYou are synthesizing outputs from your team on: ${task}\n\nTeam contributions:\n${meshSummary}\n\nProvide a unified synthesis that combines the best insights from all contributions.`;

  try {
    const result = await runAgentAndWait(userId, synthesizer.agent_id, synthPrompt, null, timeout);
    const synthesis = result?.lastReply || (typeof result === 'string' ? result : JSON.stringify(result));
    contributions.push({ agent_id: synthesizer.agent_id, role: 'synthesizer', output: synthesis.slice(0, 4000) });
    return { contributions, synthesis, quality: estimateQuality(contributions) };
  } catch (e) {
    return { contributions, synthesis: `Synthesis failed: ${e.message}`, quality: estimateQuality(contributions) * 0.5 };
  }
}

async function runHubSpokeTopology(members, task, input, { timeout, userId = 'local' }) {
  const lead = members.find(m => m.role === 'lead') || members[0];
  const spokes = members.filter(m => m !== lead);
  const contributions = [];

  // Phase 1: lead decomposes the task
  const decomposePrompt = `${lead.prompt_override || ''}\n\nYou are the team lead. Decompose this task into ${spokes.length} sub-tasks, one per specialist:\n\nTask: ${task}\n\nSpecialists: ${spokes.map(s => `${s.agent_id} (${s.role})`).join(', ')}\n\nRespond in JSON: {"subtasks": [{"agent_id": "...", "subtask": "..."}]}`;

  let subtasks = [];
  try {
    const result = await runAgentAndWait(userId, lead.agent_id, decomposePrompt, null, timeout);
    const output = result?.lastReply || (typeof result === 'string' ? result : JSON.stringify(result));
    contributions.push({ agent_id: lead.agent_id, role: 'lead', output: `[decomposition] ${output.slice(0, 2000)}` });
    const parsed = parseJSON(output);
    subtasks = Array.isArray(parsed.subtasks) ? parsed.subtasks : [];
  } catch (e) {
    subtasks = spokes.map(s => ({ agent_id: s.agent_id, subtask: task }));
    contributions.push({ agent_id: lead.agent_id, role: 'lead', output: `[decomposition failed, broadcasting full task]` });
  }

  // Phase 2: spokes execute sub-tasks
  const spokeResults = await Promise.allSettled(
    spokes.map(async (spoke, i) => {
      const sub = subtasks.find(st => st.agent_id === spoke.agent_id)?.subtask || subtasks[i]?.subtask || task;
      const prompt = `${spoke.prompt_override || ''}\n\nYour lead assigned you this sub-task: ${sub}\n\nFull team task context: ${task}`;
      const result = await runAgentAndWait(userId, spoke.agent_id, prompt, null, timeout);
      const output = result?.lastReply || (typeof result === 'string' ? result : JSON.stringify(result));
      return { agent_id: spoke.agent_id, role: spoke.role, output: output.slice(0, 3000) };
    })
  );

  for (const r of spokeResults) {
    if (r.status === 'fulfilled') contributions.push(r.value);
    else contributions.push({ agent_id: 'unknown', role: 'error', output: r.reason?.message || 'failed' });
  }

  // Phase 3: lead synthesizes
  const spokeOutputs = contributions.filter(c => c.role !== 'lead').map(c => `[${c.agent_id}]: ${c.output}`).join('\n\n');
  const synthPrompt = `${lead.prompt_override || ''}\n\nYour team has completed their sub-tasks. Synthesize into a final output:\n\nTask: ${task}\n\nTeam outputs:\n${spokeOutputs}`;
  try {
    const result = await runAgentAndWait(userId, lead.agent_id, synthPrompt, null, timeout);
    const synthesis = result?.lastReply || (typeof result === 'string' ? result : JSON.stringify(result));
    return { contributions, synthesis, quality: estimateQuality(contributions) };
  } catch (e) {
    return { contributions, synthesis: spokeOutputs, quality: estimateQuality(contributions) * 0.6 };
  }
}

async function runPipelineTopology(members, task, input, { timeout, userId = 'local' }) {
  const stages = new Map();
  for (const m of members) {
    const s = m.stage || 1;
    if (!stages.has(s)) stages.set(s, []);
    stages.get(s).push(m);
  }
  const sortedStages = [...stages.entries()].sort((a, b) => a[0] - b[0]);

  const contributions = [];
  let stageInput = input ? JSON.stringify(input) : '';

  for (const [stageNum, stageMembers] of sortedStages) {
    const results = await Promise.allSettled(
      stageMembers.map(async member => {
        const prompt = `${member.prompt_override || ''}\n\nStage ${stageNum} of pipeline.\nTeam task: ${task}\n\nInput from previous stage:\n${stageInput || '(first stage)'}`;
        const result = await runAgentAndWait(userId, member.agent_id, prompt, null, timeout);
        const output = result?.lastReply || (typeof result === 'string' ? result : JSON.stringify(result));
        return { agent_id: member.agent_id, role: member.role, stage: stageNum, output: output.slice(0, 3000) };
      })
    );

    const stageOutputs = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        contributions.push(r.value);
        stageOutputs.push(r.value.output);
      } else {
        contributions.push({ agent_id: 'unknown', role: 'error', stage: stageNum, output: r.reason?.message || 'failed' });
      }
    }
    stageInput = stageOutputs.join('\n\n---\n\n');
  }

  return { contributions, synthesis: stageInput, quality: estimateQuality(contributions) };
}

// ─── Quality Estimation ──────────────────────────────────────

function estimateQuality(contributions) {
  if (!contributions.length) return 0;
  const errors = contributions.filter(c => c.output?.startsWith('[error'));
  const successRate = 1 - (errors.length / contributions.length);
  const avgLength = contributions.reduce((s, c) => s + (c.output?.length || 0), 0) / contributions.length;
  const lengthScore = Math.min(1, avgLength / 500);
  return parseFloat((successRate * 0.7 + lengthScore * 0.3).toFixed(3));
}

// ─── Evolution ───────────────────────────────────────────────

export async function evolveCipher(cipherIdOrName, { reason, trigger = 'manual' } = {}) {
  const cipher = getCipher(cipherIdOrName);
  if (!cipher) throw new Error(`Cipher not found: ${cipherIdOrName}`);
  if (cipher.total_runs < 2) throw new Error('Need at least 2 runs before evolving');

  const mods = getAutonomyModifiers();
  const members = JSON.parse(cipher.members);
  const params = JSON.parse(cipher.parameters || '{}');

  // Get recent runs for performance data
  const recentRuns = db.prepare(
    'SELECT quality_score, duration_ms, status FROM cipher_runs WHERE cipher_id = ? ORDER BY created_at DESC LIMIT 10'
  ).all(cipher.id);

  const avgRecent = recentRuns.filter(r => r.quality_score != null).reduce((s, r) => s + r.quality_score, 0) / Math.max(1, recentRuns.filter(r => r.quality_score != null).length);
  const failRate = recentRuns.filter(r => r.status === 'failed').length / Math.max(1, recentRuns.length);

  // Decide mutation type
  let mutationType, mutationDetail;

  if (failRate > 0.3) {
    mutationType = 'replace_weak';
    const weakest = members.reduce((w, m) => {
      const trust = getAgentTrust(m.agent_id);
      return (!w || (trust?.score ?? 0.5) < (getAgentTrust(w.agent_id)?.score ?? 0.5)) ? m : w;
    }, null);
    const recommended = recommendAgents(cipher.goal, 3);
    const replacement = recommended.find(r => !members.some(m => m.agent_id === r.agent_id));
    if (weakest && replacement) {
      mutationDetail = `Replaced ${weakest.agent_id} with ${replacement.agent_id}`;
      weakest.agent_id = replacement.agent_id;
    } else {
      mutationType = 'tune_params';
      params.timeout_ms = (params.timeout_ms || 120000) * 1.5;
      mutationDetail = 'Increased timeout (no better agent available)';
    }
  } else if (avgRecent < 0.5) {
    mutationType = 'add_critic';
    if (!members.some(m => m.role === 'critic') && members.length < 7) {
      const recommended = recommendAgents('quality review critique verification', 1);
      if (recommended.length) {
        members.push({
          agent_id: recommended[0].agent_id,
          role: 'critic',
          stage: Math.max(...members.map(m => m.stage || 1)) + 1,
          prompt_override: 'Review and critique the team output. Rate quality 0-1 and suggest improvements.',
        });
        mutationDetail = `Added ${recommended[0].agent_id} as critic`;
      }
    } else {
      mutationType = 'change_topology';
      const topologies = Object.keys(TOPOLOGIES);
      const current = topologies.indexOf(cipher.topology);
      const next = topologies[(current + 1) % topologies.length];
      mutationDetail = `Topology: ${cipher.topology} → ${next}`;
      cipher.topology = next;
    }
  } else {
    mutationType = 'tune_params';
    params.quality_threshold = Math.min(0.95, (params.quality_threshold || 0.7) + 0.05);
    mutationDetail = `Raised quality threshold to ${params.quality_threshold}`;
  }

  const newVersion = cipher.version + 1;

  db.prepare(`UPDATE cipher_teams SET members = ?, topology = ?, parameters = ?, version = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(members), cipher.topology, JSON.stringify(params), newVersion, now(), cipher.id,
  );

  const evoId = randomUUID();
  db.prepare(`INSERT INTO cipher_evolutions (id, cipher_id, from_version, to_version, mutation_type, mutation_detail, reason, quality_before, quality_after, gate_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    evoId, cipher.id, cipher.version, newVersion, mutationType, mutationDetail,
    reason || trigger, cipher.avg_quality, null, mods.tier, now(),
  );

  publish('system', 'system.cipher.evolved', JSON.stringify({
    cipherId: cipher.id, name: cipher.name, mutationType, mutationDetail,
    fromVersion: cipher.version, toVersion: newVersion,
  }));

  return {
    cipherId: cipher.id,
    name: cipher.name,
    mutationType,
    mutationDetail,
    fromVersion: cipher.version,
    toVersion: newVersion,
    gateTier: mods.tier,
  };
}

// ─── Nest Ciphers (Teams of Teams) ──────────────────────────

export function nestCipher(parentIdOrName, childIdOrName) {
  const parent = getCipher(parentIdOrName);
  const child = getCipher(childIdOrName);
  if (!parent) throw new Error(`Parent cipher not found: ${parentIdOrName}`);
  if (!child) throw new Error(`Child cipher not found: ${childIdOrName}`);
  if (parent.id === child.id) throw new Error('Cannot nest a cipher in itself');

  const subs = JSON.parse(parent.sub_ciphers || '[]');
  if (subs.includes(child.id)) throw new Error(`${child.name} is already nested in ${parent.name}`);

  // Cycle detection
  const childSubs = JSON.parse(child.sub_ciphers || '[]');
  if (childSubs.includes(parent.id)) throw new Error('Circular nesting detected');

  subs.push(child.id);
  db.prepare('UPDATE cipher_teams SET sub_ciphers = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(subs), now(), parent.id,
  );

  return { parentId: parent.id, parentName: parent.name, childId: child.id, childName: child.name, totalSubs: subs.length };
}

// ─── Lookups ─────────────────────────────────────────────────

export function getCipher(idOrName) {
  if (!idOrName) return null;
  return db.prepare('SELECT * FROM cipher_teams WHERE id = ? OR name = ?').get(idOrName, idOrName) || null;
}

export function listCiphers({ status = 'active', limit = 50 } = {}) {
  if (status === 'all') {
    return db.prepare('SELECT * FROM cipher_teams ORDER BY updated_at DESC LIMIT ?').all(Math.min(200, Math.max(1, limit)));
  }
  return db.prepare('SELECT * FROM cipher_teams WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, Math.min(200, Math.max(1, limit)));
}

export function getCipherRuns(cipherId, limit = 20) {
  return db.prepare('SELECT * FROM cipher_runs WHERE cipher_id = ? ORDER BY created_at DESC LIMIT ?').all(cipherId, Math.min(100, Math.max(1, limit)));
}

export function getCipherEvolutions(cipherId, limit = 20) {
  return db.prepare('SELECT * FROM cipher_evolutions WHERE cipher_id = ? ORDER BY created_at DESC LIMIT ?').all(cipherId, Math.min(100, Math.max(1, limit)));
}

export function getCipherStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM cipher_teams').get()?.c ?? 0;
  const active = db.prepare("SELECT COUNT(*) as c FROM cipher_teams WHERE status = 'active'").get()?.c ?? 0;
  const totalRuns = db.prepare('SELECT COUNT(*) as c FROM cipher_runs').get()?.c ?? 0;
  const avgQuality = db.prepare('SELECT AVG(quality_score) as a FROM cipher_runs WHERE quality_score IS NOT NULL').get()?.a;
  const evolutions = db.prepare('SELECT COUNT(*) as c FROM cipher_evolutions').get()?.c ?? 0;
  const topCiphers = db.prepare('SELECT name, total_runs, avg_quality, best_run_quality FROM cipher_teams WHERE total_runs > 0 ORDER BY avg_quality DESC LIMIT 5').all();
  return { total, active, totalRuns, avgQuality, evolutions, topCiphers };
}

export function deactivateCipher(idOrName) {
  const cipher = getCipher(idOrName);
  if (!cipher) throw new Error(`Cipher not found: ${idOrName}`);
  db.prepare("UPDATE cipher_teams SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), cipher.id);
  return { id: cipher.id, name: cipher.name, status: 'archived' };
}

// ─── REST Routes ─────────────────────────────────────────────

export function installCipherRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/cipher/stats', route((_req, res) => {
    res.json(getCipherStats());
  }));

  app.get('/api/intelligence/cipher/teams', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const status = req.query.status || 'active';
    res.json({ teams: listCiphers({ status, limit }) });
  }));

  app.get('/api/intelligence/cipher/teams/:id', route((req, res) => {
    const cipher = getCipher(req.params.id);
    if (!cipher) return res.status(404).json({ error: 'Cipher not found' });
    const members = JSON.parse(cipher.members);
    const subs = JSON.parse(cipher.sub_ciphers || '[]');
    const subDetails = subs.map(id => getCipher(id)).filter(Boolean).map(c => ({ id: c.id, name: c.name, topology: c.topology }));
    res.json({ ...cipher, members, sub_ciphers: subDetails });
  }));

  app.post('/api/intelligence/cipher/compose', route(async (req, res) => {
    const { goal, context } = req.body || {};
    if (!goal) return res.status(400).json({ error: 'goal is required' });
    const result = await composeCipher(goal, { context });
    res.json(result);
  }));

  app.post('/api/intelligence/cipher/run', route(async (req, res) => {
    const { cipher, task, input, timeout } = req.body || {};
    if (!cipher || !task) return res.status(400).json({ error: 'cipher and task are required' });
    const result = await runCipher(cipher, task, { input, timeout });
    res.json(result);
  }));

  app.post('/api/intelligence/cipher/evolve', route(async (req, res) => {
    const { cipher, reason } = req.body || {};
    if (!cipher) return res.status(400).json({ error: 'cipher is required' });
    const result = await evolveCipher(cipher, { reason });
    res.json(result);
  }));

  app.post('/api/intelligence/cipher/nest', route((req, res) => {
    const { parent, child } = req.body || {};
    if (!parent || !child) return res.status(400).json({ error: 'parent and child are required' });
    const result = nestCipher(parent, child);
    res.json(result);
  }));

  app.get('/api/intelligence/cipher/runs/:cipherId', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ runs: getCipherRuns(req.params.cipherId, limit) });
  }));

  app.get('/api/intelligence/cipher/evolutions/:cipherId', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ evolutions: getCipherEvolutions(req.params.cipherId, limit) });
  }));

  app.post('/api/intelligence/cipher/deactivate', route((req, res) => {
    const { cipher } = req.body || {};
    if (!cipher) return res.status(400).json({ error: 'cipher is required' });
    res.json(deactivateCipher(cipher));
  }));
}
