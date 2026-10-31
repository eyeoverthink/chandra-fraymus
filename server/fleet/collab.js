import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { publish } from './bus.js';

const now = () => Date.now();

try {
  db.prepare(`CREATE TABLE IF NOT EXISTS collab_sessions (
    id TEXT PRIMARY KEY,
    initiator TEXT NOT NULL,
    goal TEXT NOT NULL,
    strategy TEXT NOT NULL DEFAULT 'chain',
    agents TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS collab_steps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    task TEXT NOT NULL,
    result TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    step_order INTEGER NOT NULL,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES collab_sessions(id)
  )`).run();
} catch (e) {
  console.error('collab: table create failed:', e.message);
}

let runAgentFn = null;
let broadcastFn = () => {};

export function initCollab({ runAgent, broadcast }) {
  if (runAgent) runAgentFn = runAgent;
  if (broadcast) broadcastFn = broadcast;
}

export function createCollab({ initiator, goal, strategy, agents }) {
  if (!goal) throw new Error('Goal is required');
  if (!agents || agents.length < 2) throw new Error('At least 2 agents required');
  if (!['chain', 'parallel', 'debate'].includes(strategy)) {
    throw new Error('Strategy must be chain, parallel, or debate');
  }

  const id = randomUUID().slice(0, 11);
  db.prepare(`INSERT INTO collab_sessions (id, initiator, goal, strategy, agents, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(
    id, initiator || 'user', goal, strategy, JSON.stringify(agents), now()
  );

  publish('system', 'collab.created', { id, goal, strategy, agents });
  broadcastFn('collab', { type: 'created', id, goal, strategy });
  return { id, goal, strategy, agents };
}

export async function runCollab(sessionId) {
  const session = db.prepare('SELECT * FROM collab_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');
  if (session.status === 'running') throw new Error('Already running');
  if (!runAgentFn) throw new Error('Agent runner not initialized');

  const agents = JSON.parse(session.agents);
  db.prepare('UPDATE collab_sessions SET status = ? WHERE id = ?').run('running', sessionId);
  broadcastFn('collab', { type: 'started', id: sessionId });

  try {
    let result;
    if (session.strategy === 'chain') {
      result = await runChain(sessionId, session.goal, agents);
    } else if (session.strategy === 'parallel') {
      result = await runParallel(sessionId, session.goal, agents);
    } else if (session.strategy === 'debate') {
      result = await runDebate(sessionId, session.goal, agents);
    }

    db.prepare('UPDATE collab_sessions SET status = ?, result = ?, completed_at = ? WHERE id = ?')
      .run('done', JSON.stringify(result), now(), sessionId);
    publish('system', 'collab.done', { id: sessionId, strategy: session.strategy });
    broadcastFn('collab', { type: 'done', id: sessionId });
    return result;
  } catch (e) {
    db.prepare('UPDATE collab_sessions SET status = ?, result = ?, completed_at = ? WHERE id = ?')
      .run('error', JSON.stringify({ error: e.message }), now(), sessionId);
    broadcastFn('collab', { type: 'error', id: sessionId, error: e.message });
    throw e;
  }
}

async function runAgent(agentId, task) {
  const result = await runAgentFn('local', agentId, task);
  return result.lastReply || result.content || '[No response]';
}

function addStep(sessionId, agentId, task, order) {
  const id = randomUUID().slice(0, 11);
  db.prepare(`INSERT INTO collab_steps (id, session_id, agent_id, task, status, step_order, created_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?)`).run(id, sessionId, agentId, task, order, now());
  broadcastFn('collab', { type: 'step_started', sessionId, stepId: id, agentId, order });
  return id;
}

function completeStep(stepId, result, duration) {
  db.prepare('UPDATE collab_steps SET status = ?, result = ?, duration_ms = ?, completed_at = ? WHERE id = ?')
    .run('done', result, duration, now(), stepId);
}

function failStep(stepId, error) {
  db.prepare('UPDATE collab_steps SET status = ?, result = ?, completed_at = ? WHERE id = ?')
    .run('error', error, now(), stepId);
}

async function runChain(sessionId, goal, agents) {
  let context = goal;
  const outputs = [];

  for (let i = 0; i < agents.length; i++) {
    const agentId = agents[i];
    const task = i === 0
      ? `You are the first agent in a collaboration chain. Goal: ${goal}\nProvide your contribution.`
      : `You are agent ${i + 1} of ${agents.length} in a collaboration chain.\nOriginal goal: ${goal}\nPrevious agent's output:\n${context}\n\nBuild on this and add your contribution.`;

    const stepId = addStep(sessionId, agentId, task.slice(0, 500), i);
    const start = Date.now();

    try {
      const result = await runAgent(agentId, task);
      completeStep(stepId, result.slice(0, 4000), Date.now() - start);
      context = result;
      outputs.push({ agent: agentId, output: result.slice(0, 2000) });
    } catch (e) {
      failStep(stepId, e.message);
      outputs.push({ agent: agentId, error: e.message });
    }
  }

  return { strategy: 'chain', outputs, finalOutput: context.slice(0, 4000) };
}

async function runParallel(sessionId, goal, agents) {
  const promises = agents.map((agentId, i) => {
    const task = `You are one of ${agents.length} agents working in parallel on this goal: ${goal}\nProvide your independent contribution.`;
    const stepId = addStep(sessionId, agentId, task.slice(0, 500), i);
    const start = Date.now();

    return runAgent(agentId, task)
      .then(result => {
        completeStep(stepId, result.slice(0, 4000), Date.now() - start);
        return { agent: agentId, output: result.slice(0, 2000) };
      })
      .catch(e => {
        failStep(stepId, e.message);
        return { agent: agentId, error: e.message };
      });
  });

  const outputs = await Promise.all(promises);

  const synthesisTask = `You are the synthesis agent. Multiple agents worked on this goal in parallel: ${goal}\n\nHere are their contributions:\n${outputs.map(o => `--- ${o.agent} ---\n${o.output || o.error}\n`).join('\n')}\n\nSynthesize these into a unified, coherent result.`;
  const synthStepId = addStep(sessionId, agents[0], 'Synthesis', agents.length);
  const synthStart = Date.now();

  try {
    const synthesis = await runAgent(agents[0], synthesisTask);
    completeStep(synthStepId, synthesis.slice(0, 4000), Date.now() - synthStart);
    return { strategy: 'parallel', outputs, synthesis: synthesis.slice(0, 4000) };
  } catch (e) {
    failStep(synthStepId, e.message);
    return { strategy: 'parallel', outputs, synthesisError: e.message };
  }
}

async function runDebate(sessionId, goal, agents) {
  if (agents.length < 2) throw new Error('Debate needs at least 2 agents');
  const [proponent, opponent, ...rest] = agents;
  const judge = rest[0] || proponent;

  const proTask = `You are the PROPONENT in a debate. Argue FOR this position/goal: ${goal}\nMake your strongest case.`;
  const proStepId = addStep(sessionId, proponent, 'Proponent argument', 0);
  const proStart = Date.now();
  let proResult;
  try {
    proResult = await runAgent(proponent, proTask);
    completeStep(proStepId, proResult.slice(0, 4000), Date.now() - proStart);
  } catch (e) {
    failStep(proStepId, e.message);
    proResult = `[Error: ${e.message}]`;
  }

  const oppTask = `You are the OPPONENT in a debate. The topic/goal: ${goal}\nThe proponent argued:\n${proResult}\n\nPresent counterarguments, identify weaknesses, and argue the opposing view.`;
  const oppStepId = addStep(sessionId, opponent, 'Opponent argument', 1);
  const oppStart = Date.now();
  let oppResult;
  try {
    oppResult = await runAgent(opponent, oppTask);
    completeStep(oppStepId, oppResult.slice(0, 4000), Date.now() - oppStart);
  } catch (e) {
    failStep(oppStepId, e.message);
    oppResult = `[Error: ${e.message}]`;
  }

  const judgeTask = `You are the JUDGE in a debate. The topic/goal: ${goal}\n\nProponent (${proponent}) argued:\n${proResult}\n\nOpponent (${opponent}) argued:\n${oppResult}\n\nDeliver your verdict: who made the stronger case, what are the key insights, and what is the best path forward? Be decisive.`;
  const judgeStepId = addStep(sessionId, judge, 'Judge verdict', 2);
  const judgeStart = Date.now();
  let verdict;
  try {
    verdict = await runAgent(judge, judgeTask);
    completeStep(judgeStepId, verdict.slice(0, 4000), Date.now() - judgeStart);
  } catch (e) {
    failStep(judgeStepId, e.message);
    verdict = `[Error: ${e.message}]`;
  }

  return {
    strategy: 'debate',
    proponent: { agent: proponent, argument: proResult?.slice(0, 2000) },
    opponent: { agent: opponent, argument: oppResult?.slice(0, 2000) },
    verdict: { agent: judge, decision: verdict?.slice(0, 2000) },
  };
}

export function getCollab(id) {
  const session = db.prepare('SELECT * FROM collab_sessions WHERE id = ?').get(id);
  if (!session) return null;
  const steps = db.prepare('SELECT * FROM collab_steps WHERE session_id = ? ORDER BY step_order').all(id);
  return {
    ...session,
    agents: JSON.parse(session.agents),
    result: session.result ? JSON.parse(session.result) : null,
    steps,
  };
}

export function listCollabs(limit = 20) {
  const sessions = db.prepare('SELECT * FROM collab_sessions ORDER BY created_at DESC LIMIT ?').all(limit);
  return sessions.map(s => ({
    ...s,
    agents: JSON.parse(s.agents),
    result: s.result ? JSON.parse(s.result) : null,
  }));
}
