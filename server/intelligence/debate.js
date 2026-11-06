/**
 * Debate Protocol — adversarial multi-agent reasoning engine.
 *
 * Two agents argue opposing positions on a topic across three structured rounds:
 *   Round 1: Opening — each side states its position and supporting evidence
 *   Round 2: Rebuttal — each side responds to the opponent's opening
 *   Round 3: Synthesis — a judge agent analyzes both sides and renders a verdict
 *
 * Agents are drawn from the existing fleet. The protocol enforces structured
 * argumentation so weak positions get exposed through adversarial pressure.
 */

import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { loadManifests } from '../fleet/manifest.js';
import { getAutonomyModifiers } from './consciousness-gate.js';

const BASE_REBUTTAL_ROUNDS = 1;

const FALLBACK_ROLES = {
  proponent: {
    agentId: 'fraymus-prime',
    perspective: 'Construct the strongest possible argument FOR the proposition. Use evidence, logical reasoning, and concrete examples. Anticipate counterarguments and address them preemptively.',
  },
  opponent: {
    agentId: 'solon',
    perspective: 'Construct the strongest possible argument AGAINST the proposition. Identify logical weaknesses, missing evidence, unexamined assumptions, and adverse consequences. Be rigorous but fair.',
  },
  judge: {
    agentId: 'cantor',
    perspective: 'You are an impartial analytical judge. Evaluate both arguments on: logical soundness, evidence quality, assumption awareness, practical implications, and intellectual honesty. Identify the strongest and weakest points from each side.',
  },
};

function discoverDebateAgents() {
  try {
    const manifests = loadManifests();
    const found = { proponent: null, opponent: null, judge: null };
    for (const [id, agent] of manifests) {
      const role = (agent.role || '').toLowerCase();
      const name = (agent.name || '').toLowerCase();
      const combined = `${id} ${name} ${role}`;
      if (!combined.includes('debate')) continue;
      if (/evaluat|judge|scor/i.test(combined) && !found.judge) {
        found.judge = { agentId: id, perspective: agent.systemPrompt?.slice(0, 500) || FALLBACK_ROLES.judge.perspective };
      } else if (/outcome|resolution|analyz/i.test(combined) && !found.opponent) {
        found.opponent = { agentId: id, perspective: agent.systemPrompt?.slice(0, 500) || FALLBACK_ROLES.opponent.perspective };
      } else if (/specialist|expert|manag/i.test(combined) && !found.proponent) {
        found.proponent = { agentId: id, perspective: agent.systemPrompt?.slice(0, 500) || FALLBACK_ROLES.proponent.perspective };
      }
    }
    return {
      proponent: found.proponent || FALLBACK_ROLES.proponent,
      opponent: found.opponent || FALLBACK_ROLES.opponent,
      judge: found.judge || FALLBACK_ROLES.judge,
    };
  } catch (_) {
    return FALLBACK_ROLES;
  }
}

let cachedRoles = null;
let rolesLoadedAt = 0;
function getDebateRoles() {
  if (!cachedRoles || Date.now() - rolesLoadedAt > 300_000) {
    cachedRoles = discoverDebateAgents();
    rolesLoadedAt = Date.now();
  }
  return cachedRoles;
}

function fossilizeVerdict(debateId, topic, verdict, verdictReasoning, confidence) {
  try {
    const key = `debate:${debateId}`;
    const value = `Debate on "${topic}": verdict=${verdict} (confidence ${Math.round(confidence * 100)}%). ${verdictReasoning}`.slice(0, 4000);
    db.prepare(
      `INSERT OR REPLACE INTO agent_memories (agent_id, category, key, value, confidence, source, access_count, created_at, updated_at) VALUES ('system', 'debate_verdict', ?, ?, ?, 'debate-engine', 0, ?, ?)`
    ).run(key, value, confidence, Date.now(), Date.now());
  } catch (_) {}
}

const ROUND_PROMPTS = {
  opening: (topic, proposition, side) =>
    `TOPIC: ${topic}\nPROPOSITION: "${proposition}"\nYOU ARGUE: ${side === 'proponent' ? 'FOR' : 'AGAINST'} this proposition.\n\nPresent your opening argument. Structure it as:\n1. Core thesis (1-2 sentences)\n2. Supporting evidence/reasoning (3-5 points)\n3. Key implications if your position is correct\n\nReturn JSON: { "thesis": "...", "points": ["...", "..."], "implications": "..." }`,

  rebuttal: (topic, proposition, side, opponentPrevious, roundNum) =>
    `TOPIC: ${topic}\nPROPOSITION: "${proposition}"\nYOU ARGUE: ${side === 'proponent' ? 'FOR' : 'AGAINST'}\n${roundNum > 1 ? `[Counter-rebuttal round ${roundNum}]\n` : ''}\nYour opponent argued:\nThesis: ${opponentPrevious.thesis || opponentPrevious.strengthened_position || ''}\nPoints: ${(opponentPrevious.points || opponentPrevious.counters || []).map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nRespond to their argument:\n1. Identify the weakest point(s) in their reasoning\n2. Counter each major claim with evidence or logic\n3. Strengthen your own position based on what they missed\n\nReturn JSON: { "weaknesses_found": ["...", "..."], "counters": ["...", "..."], "strengthened_position": "..." }`,

  synthesis: (topic, proposition, proponentArgs, opponentArgs) =>
    `TOPIC: ${topic}\nPROPOSITION: "${proposition}"\n\nPROPONENT (arguing FOR):\nOpening thesis: ${proponentArgs.opening.thesis}\nRebuttal counters: ${(proponentArgs.latestRebuttal.counters || []).join('; ')}\nStrengthened position: ${proponentArgs.latestRebuttal.strengthened_position}\n\nOPPONENT (arguing AGAINST):\nOpening thesis: ${opponentArgs.opening.thesis}\nRebuttal counters: ${(opponentArgs.latestRebuttal.counters || []).join('; ')}\nStrengthened position: ${opponentArgs.latestRebuttal.strengthened_position}\n\nRender your verdict. Evaluate:\n1. Which side presented stronger logical reasoning?\n2. Which side had better evidence and examples?\n3. Which side better addressed the opponent's arguments?\n4. What did both sides miss or get wrong?\n5. Final verdict: which position is more defensible, and why?\n\nReturn JSON: { "logic_winner": "proponent|opponent|draw", "evidence_winner": "proponent|opponent|draw", "rebuttal_winner": "proponent|opponent|draw", "blind_spots": ["...", "..."], "verdict": "proponent|opponent|draw", "verdict_reasoning": "...", "confidence": 0.0-1.0, "synthesis": "..." }`,
};

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS debates (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      proposition TEXT NOT NULL,
      proponent_agent TEXT NOT NULL,
      opponent_agent TEXT NOT NULL,
      judge_agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      rounds TEXT,
      verdict TEXT,
      verdict_reasoning TEXT,
      confidence REAL,
      model TEXT,
      duration_ms INTEGER,
      source TEXT,
      created_at INTEGER NOT NULL
    )
  `);
}

async function runRound(roundName, prompt, role, config = {}) {
  const model = config.model || 'llama3.1:8b';
  const systemPrompt = `You are an expert debater assigned the role of ${role.agentId}. ${role.perspective}\n\nYou must return ONLY valid JSON. No markdown, no explanation outside the JSON.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  const raw = await chatOllama(messages, { model, temperature: 0.4 });
  const parsed = parseJSON(raw);

  if (!parsed) {
    return { raw, parsed: null, error: `Failed to parse ${roundName} response` };
  }

  return { raw, parsed, error: null };
}

export async function runDebate({ topic, proposition, config = {}, source = 'api' }) {
  ensureTable();

  const gateMods = getAutonomyModifiers();
  const rebuttalRounds = Math.min(3, Math.max(1, Math.round(BASE_REBUTTAL_ROUNDS * gateMods.evolutionRate)));
  const totalRounds = 1 + rebuttalRounds + 1; // opening + N rebuttals + synthesis

  const debateId = `debate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const DEBATE_ROLES = getDebateRoles();
  const proRole = { ...DEBATE_ROLES.proponent, ...(config.proponent || {}) };
  const oppRole = { ...DEBATE_ROLES.opponent, ...(config.opponent || {}) };
  const judgeRole = { ...DEBATE_ROLES.judge, ...(config.judge || {}) };
  const started = Date.now();

  db.prepare(`INSERT INTO debates (id, topic, proposition, proponent_agent, opponent_agent, judge_agent, status, model, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`).run(
    debateId, topic, proposition, proRole.agentId, oppRole.agentId, judgeRole.agentId, config.model || 'llama3.1:8b', source, started,
  );

  try { publish('system.debate', { type: 'debate.start', debateId, topic, proposition, gateTier: gateMods.tier, rebuttalRounds, totalRounds }); } catch {}

  const rounds = { opening: {}, rebuttals: [], synthesis: null };

  // Round 1: Opening Arguments
  try { publish('system.debate', { type: 'debate.round', debateId, round: 'opening' }); } catch {}

  const proOpening = await runRound('opening', ROUND_PROMPTS.opening(topic, proposition, 'proponent'), proRole, config);
  const oppOpening = await runRound('opening', ROUND_PROMPTS.opening(topic, proposition, 'opponent'), oppRole, config);

  rounds.opening.proponent = proOpening.parsed || { thesis: proOpening.raw?.slice(0, 500), points: [], implications: '' };
  rounds.opening.opponent = oppOpening.parsed || { thesis: oppOpening.raw?.slice(0, 500), points: [], implications: '' };

  // Rebuttal rounds — scaled by consciousness tier
  let proPrev = rounds.opening.opponent;
  let oppPrev = rounds.opening.proponent;

  for (let r = 1; r <= rebuttalRounds; r++) {
    try { publish('system.debate', { type: 'debate.round', debateId, round: `rebuttal-${r}` }); } catch {}

    const proRebuttal = await runRound('rebuttal', ROUND_PROMPTS.rebuttal(topic, proposition, 'proponent', proPrev, r), proRole, config);
    const oppRebuttal = await runRound('rebuttal', ROUND_PROMPTS.rebuttal(topic, proposition, 'opponent', oppPrev, r), oppRole, config);

    const proResult = proRebuttal.parsed || { weaknesses_found: [], counters: [], strengthened_position: '' };
    const oppResult = oppRebuttal.parsed || { weaknesses_found: [], counters: [], strengthened_position: '' };

    rounds.rebuttals.push({ round: r, proponent: proResult, opponent: oppResult });

    proPrev = oppResult;
    oppPrev = proResult;
  }

  // Synthesis & Verdict
  try { publish('system.debate', { type: 'debate.round', debateId, round: 'synthesis' }); } catch {}

  const latestRebuttal = rounds.rebuttals[rounds.rebuttals.length - 1];
  const proArgs = { opening: rounds.opening.proponent, latestRebuttal: latestRebuttal.proponent };
  const oppArgs = { opening: rounds.opening.opponent, latestRebuttal: latestRebuttal.opponent };

  const synthesis = await runRound('synthesis', ROUND_PROMPTS.synthesis(topic, proposition, proArgs, oppArgs), judgeRole, config);

  rounds.synthesis = synthesis.parsed || {
    verdict: 'draw', verdict_reasoning: synthesis.raw?.slice(0, 500) || 'Judge failed to parse',
    confidence: 0, blind_spots: [], synthesis: '',
  };

  const durationMs = Date.now() - started;
  const verdict = rounds.synthesis.verdict || 'draw';
  const verdictReasoning = String(rounds.synthesis.verdict_reasoning || '').slice(0, 2000);
  const confidence = Math.max(0, Math.min(1, parseFloat(rounds.synthesis.confidence) || 0));

  db.prepare(`UPDATE debates SET status = 'completed', rounds = ?, verdict = ?, verdict_reasoning = ?, confidence = ?, duration_ms = ? WHERE id = ?`).run(
    JSON.stringify(rounds), verdict, verdictReasoning, confidence, durationMs, debateId,
  );

  fossilizeVerdict(debateId, topic, verdict, verdictReasoning, confidence);

  try {
    publish('system.debate', {
      type: 'debate.complete', debateId, topic, verdict, confidence, durationMs,
      gateTier: gateMods.tier, rebuttalRounds, totalRounds,
    });
  } catch {}

  return {
    id: debateId,
    topic,
    proposition,
    agents: { proponent: proRole.agentId, opponent: oppRole.agentId, judge: judgeRole.agentId },
    rounds,
    verdict,
    verdictReasoning,
    confidence,
    durationMs,
    gateTier: gateMods.tier,
    rebuttalRounds,
    totalRounds,
  };
}

// ─── Binary Annotation Debate ─────────────────────────────────
// Phase 4: Feed RE Agent's red/blue annotation scores into Chandra's
// adversarial debate engine. Proponent defends the annotation, opponent
// challenges unverified imports, vague descriptions, missing edge cases.

const BINARY_PROMPTS = {
  proponent: (fn) =>
    `You are analyzing a decompiled function from binary reverse engineering.\n\nFunction: ${fn.name} @ ${fn.address}\nLines: ${fn.lines}\n\nDecompiled C:\n\`\`\`c\n${fn.body.slice(0, 2000)}\n\`\`\`\n\nAnnotations:\n${fn.annotations.map(a => a.annotation || '(empty)').join('\n') || '(none)'}\n\nImport hits: ${fn.importHits?.join(', ') || '(none)'}\n\nARGUE FOR this interpretation: "This function does what the annotations claim based on the following evidence." Build the strongest case using the decompiled code, import references, and structural patterns.\n\nReturn JSON: { "thesis": "...", "points": ["...", "..."], "implications": "..." }`,

  opponent: (fn) =>
    `You are a skeptical reverse engineer reviewing a decompiled function analysis.\n\nFunction: ${fn.name} @ ${fn.address}\nLines: ${fn.lines}\n\nDecompiled C:\n\`\`\`c\n${fn.body.slice(0, 2000)}\n\`\`\`\n\nAnnotations:\n${fn.annotations.map(a => a.annotation || '(empty)').join('\n') || '(none)'}\n\nImport hits: ${fn.importHits?.join(', ') || '(none)'}\n\nARGUE AGAINST: Challenge the annotation claims. Look for: unverified imports, vague descriptions, missing edge cases, Ghidra decompilation artifacts that could mislead, type confusion, buffer handling issues.\n\nReturn JSON: { "thesis": "...", "points": ["...", "..."], "implications": "..." }`,

  judge: (fn, proArgs, oppArgs) =>
    `You are judging a debate about a decompiled function's annotation accuracy.\n\nFunction: ${fn.name} @ ${fn.address} (${fn.lines} lines)\n\nPROPONENT (defending annotations):\nThesis: ${proArgs.opening.thesis}\nRebuttal: ${(proArgs.latestRebuttal?.counters || []).join('; ')}\nStrengthened: ${proArgs.latestRebuttal?.strengthened_position || ''}\n\nOPPONENT (challenging annotations):\nThesis: ${oppArgs.opening.thesis}\nRebuttal: ${(oppArgs.latestRebuttal?.counters || []).join('; ')}\nStrengthened: ${oppArgs.latestRebuttal?.strengthened_position || ''}\n\nVerdict: Is the annotation accurate and trustworthy? Consider: code evidence, annotation specificity, unresolved challenges.\n\nReturn JSON: { "verdict": "CONFIRMED|CHALLENGED|SPLIT", "verdict_reasoning": "...", "confidence": 0.0-1.0, "challenged_claims": ["...", "..."], "proponent_score": 0.0-1.0, "opponent_score": 0.0-1.0 }`,
};

export async function debateBinaryAnnotation(functionData, opts = {}) {
  ensureTable();

  const gateMods = getAutonomyModifiers();
  const rebuttalRounds = Math.min(3, Math.max(1, Math.round(BASE_REBUTTAL_ROUNDS * gateMods.evolutionRate)));
  const totalRounds = 1 + rebuttalRounds + 1;

  const debateId = `debate-binary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const DEBATE_ROLES = getDebateRoles();
  const proRole = DEBATE_ROLES.proponent;
  const oppRole = DEBATE_ROLES.opponent;
  const judgeRole = DEBATE_ROLES.judge;
  const config = opts.config || {};
  const started = Date.now();

  // Empty annotations are auto-CHALLENGED per spec (qwen3.5 think-block issue)
  const hasAnnotation = functionData.annotations?.some(a => a.annotation && a.annotation.length > 10);
  if (!hasAnnotation) {
    const result = {
      functionName: functionData.name,
      address: functionData.address,
      verdict: 'CHALLENGED',
      rounds: 0,
      proponentScore: 0,
      opponentScore: 1,
      challengedClaims: ['Empty or missing annotation — likely qwen3.5 think-block artifact'],
      gateTier: gateMods.tier,
      totalRounds: 0,
    };

    try { publish('system.debate.binary', { type: 'debate.binary.empty', debateId, ...result }); } catch {}
    return result;
  }

  const topic = `Binary annotation accuracy: ${functionData.name} @ ${functionData.address}`;
  const proposition = `The annotations for function ${functionData.name} accurately describe its behavior`;

  db.prepare(`INSERT INTO debates (id, topic, proposition, proponent_agent, opponent_agent, judge_agent, status, model, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 'binary_annotation', ?)`).run(
    debateId, topic, proposition, proRole.agentId, oppRole.agentId, judgeRole.agentId, config.model || 'llama3.1:8b', started,
  );

  try { publish('system.debate.binary', { type: 'debate.binary.start', debateId, functionName: functionData.name, address: functionData.address, gateTier: gateMods.tier }); } catch {}

  const rounds = { opening: {}, rebuttals: [], synthesis: null };

  // Opening
  const proOpening = await runRound('opening', BINARY_PROMPTS.proponent(functionData), proRole, config);
  const oppOpening = await runRound('opening', BINARY_PROMPTS.opponent(functionData), oppRole, config);

  rounds.opening.proponent = proOpening.parsed || { thesis: proOpening.raw?.slice(0, 500), points: [], implications: '' };
  rounds.opening.opponent = oppOpening.parsed || { thesis: oppOpening.raw?.slice(0, 500), points: [], implications: '' };

  // Rebuttals
  let proPrev = rounds.opening.opponent;
  let oppPrev = rounds.opening.proponent;

  for (let r = 1; r <= rebuttalRounds; r++) {
    const proRebuttal = await runRound('rebuttal', ROUND_PROMPTS.rebuttal(topic, proposition, 'proponent', proPrev, r), proRole, config);
    const oppRebuttal = await runRound('rebuttal', ROUND_PROMPTS.rebuttal(topic, proposition, 'opponent', oppPrev, r), oppRole, config);

    const proResult = proRebuttal.parsed || { weaknesses_found: [], counters: [], strengthened_position: '' };
    const oppResult = oppRebuttal.parsed || { weaknesses_found: [], counters: [], strengthened_position: '' };

    rounds.rebuttals.push({ round: r, proponent: proResult, opponent: oppResult });
    proPrev = oppResult;
    oppPrev = proResult;
  }

  // Synthesis
  const latestRebuttal = rounds.rebuttals[rounds.rebuttals.length - 1] || { proponent: {}, opponent: {} };
  const proArgs = { opening: rounds.opening.proponent, latestRebuttal: latestRebuttal.proponent };
  const oppArgs = { opening: rounds.opening.opponent, latestRebuttal: latestRebuttal.opponent };

  const synthesis = await runRound('synthesis', BINARY_PROMPTS.judge(functionData, proArgs, oppArgs), judgeRole, config);

  const judgeResult = synthesis.parsed || {
    verdict: 'SPLIT', verdict_reasoning: synthesis.raw?.slice(0, 500) || 'Judge failed to parse',
    confidence: 0, challenged_claims: [], proponent_score: 0.5, opponent_score: 0.5,
  };

  const durationMs = Date.now() - started;
  const verdict = ['CONFIRMED', 'CHALLENGED', 'SPLIT'].includes(judgeResult.verdict) ? judgeResult.verdict : 'SPLIT';
  const verdictReasoning = String(judgeResult.verdict_reasoning || '').slice(0, 2000);
  const confidence = Math.max(0, Math.min(1, parseFloat(judgeResult.confidence) || 0));

  db.prepare(`UPDATE debates SET status = 'completed', rounds = ?, verdict = ?, verdict_reasoning = ?, confidence = ?, duration_ms = ? WHERE id = ?`).run(
    JSON.stringify(rounds), verdict, verdictReasoning, confidence, durationMs, debateId,
  );

  fossilizeVerdict(debateId, topic, verdict, verdictReasoning, confidence);

  const result = {
    functionName: functionData.name,
    address: functionData.address,
    verdict,
    rounds: totalRounds,
    proponentScore: Math.max(0, Math.min(1, parseFloat(judgeResult.proponent_score) || 0.5)),
    opponentScore: Math.max(0, Math.min(1, parseFloat(judgeResult.opponent_score) || 0.5)),
    challengedClaims: Array.isArray(judgeResult.challenged_claims) ? judgeResult.challenged_claims : [],
    gateTier: gateMods.tier,
    totalRounds,
    debateId,
    durationMs,
  };

  try { publish('system.debate.binary', { type: 'debate.binary.complete', ...result }); } catch {}

  return result;
}

export function listDebates({ status, limit = 20 } = {}) {
  ensureTable();
  const lim = Math.min(100, Math.max(1, parseInt(limit) || 20));
  if (status) {
    return db.prepare(`SELECT id, topic, proposition, proponent_agent, opponent_agent, judge_agent, status, verdict, confidence, duration_ms, source, created_at FROM debates WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, lim);
  }
  return db.prepare(`SELECT id, topic, proposition, proponent_agent, opponent_agent, judge_agent, status, verdict, confidence, duration_ms, source, created_at FROM debates ORDER BY created_at DESC LIMIT ?`).all(lim);
}

export function getDebate(id) {
  ensureTable();
  const row = db.prepare(`SELECT * FROM debates WHERE id = ?`).get(id);
  if (!row) return null;
  try { row.rounds = JSON.parse(row.rounds); } catch { row.rounds = null; }
  return row;
}

export function deleteDebate(id) {
  ensureTable();
  return db.prepare(`DELETE FROM debates WHERE id = ?`).run(id);
}

export function installDebateRoutes(app) {
  ensureTable();

  app.post('/api/debates/run', async (req, res, next) => {
    try {
      const { topic, proposition, model, proponent, opponent, judge } = req.body;
      if (!topic || !proposition) return res.status(400).json({ error: 'topic and proposition required' });
      const config = { model: model || undefined, proponent, opponent, judge };
      const result = await runDebate({ topic, proposition, config, source: 'api' });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/debates', (req, res) => {
    const { status, limit } = req.query;
    res.json({ debates: listDebates({ status, limit }) });
  });

  app.get('/api/debates/:id', (req, res) => {
    const debate = getDebate(req.params.id);
    if (!debate) return res.status(404).json({ error: 'Debate not found' });
    res.json(debate);
  });

  app.delete('/api/debates/:id', (req, res) => {
    deleteDebate(req.params.id);
    res.json({ deleted: req.params.id });
  });
}
