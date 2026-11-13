/**
 * Outcome Scorer — Phase R credit assignment.
 *
 * The executor records that a goal *completed*; this module says how *well*. An 8B
 * agent will happily answer "I'll delegate this to the relevant agents…" and return
 * status done. Completion is not credit. Quality is a blend of deterministic signals
 * read from the run itself (did it call tools, did it store memory, is the reply
 * concrete, how much of it is talk about doing rather than doing) and an Ollama judge
 * that scores specificity, actionability and evidence. The judge is optional: if it
 * fails, the deterministic half stands alone.
 *
 * Quality flows outward: goal_executions.quality, the outcome memory's confidence,
 * per-agent quality stats (prompt evolution reads them), and computeRealityFitness(),
 * which the ouroboros engine blends into its fitness so mutations are only kept
 * while real outcomes hold up.
 */

import { db } from '../db.js';
import { ensureGoalExecutionsTable } from './goal-executions-schema.js';
import { chatOllama } from '../commerce/shared.js';

const now = () => Date.now();

const META_TALK = /\b(i(?:'ll| will| would| plan to| am going to| can) |let me |first,? i |next,? i |i(?:'d| would) (?:suggest|recommend)|to (?:tackle|address|approach) this)/gi;
const CONCRETE = /\d+(?:\.\d+)?%?|`[^`]+`|\b[a-z0-9_-]+\.(?:js|py|md|json|ts)\b|https?:\/\/|\bagent_remember\b|\b(?:result|finding|measured|observed|confirmed|failed|returned)\b/gi;

const JUDGE_PROMPT = `You grade the output of an autonomous agent that was given an objective. Score 0.0-1.0 on each:
- specificity: concrete facts, numbers, names, decisions (1.0) vs generalities (0.0)
- actionability: did it DO or decide something usable (1.0) vs describe what it would do (0.0)
- evidence: does it show results of work — data, outputs, checks (1.0) vs assertions (0.0)
- meta_talk: fraction of the reply that narrates intentions instead of delivering (1.0 = all narration)
Then overall 0.0-1.0 and a one-sentence critique naming the single biggest weakness.
Output JSON only: {"specificity":0.0,"actionability":0.0,"evidence":0.0,"meta_talk":0.0,"overall":0.0,"critique":"..."}`;

function ensureColumns() {
  ensureGoalExecutionsTable();
  const cols = db.prepare(`PRAGMA table_info(goal_executions)`).all().map(c => c.name);
  if (!cols.includes('quality')) db.prepare(`ALTER TABLE goal_executions ADD COLUMN quality REAL`).run();
  if (!cols.includes('quality_detail')) db.prepare(`ALTER TABLE goal_executions ADD COLUMN quality_detail TEXT`).run();
}
try { ensureColumns(); } catch (e) { console.error('[outcome-scorer] schema:', e.message); }

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }

export function deterministicSignals({ threadId, reply }) {
  const text = String(reply || '');
  let toolCalls = 0, assistantMsgs = 0, memoryWrites = 0;
  if (threadId) {
    try {
      const rows = db.prepare(`SELECT role, tool_calls, name FROM messages WHERE thread_id = ?`).all(threadId);
      for (const r of rows) {
        if (r.role === 'assistant') assistantMsgs++;
        if (r.tool_calls && r.tool_calls !== '[]' && r.tool_calls !== 'null') {
          toolCalls++;
          if (/agent_remember|memory_save/.test(r.tool_calls)) memoryWrites++;
        }
      }
    } catch (_) {}
  }
  const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) || []).length);
  const metaHits = (text.match(META_TALK) || []).length;
  const concreteHits = (text.match(CONCRETE) || []).length;

  const toolUse = clamp01(toolCalls / 3);
  const length = clamp01(text.length / 600);
  const metaRatio = clamp01(metaHits / sentences);
  const concreteness = clamp01(concreteHits / Math.max(4, sentences));
  const memory = memoryWrites > 0 ? 1 : 0;

  const score = clamp01(
    0.30 * toolUse +
    0.15 * length +
    0.25 * (1 - metaRatio) +
    0.20 * concreteness +
    0.10 * memory
  );
  return { score, toolCalls, assistantMsgs, memoryWrites, metaHits, metaRatio, concreteHits, concreteness, length: text.length };
}

export async function judgeReply({ objective, reply }) {
  const text = String(reply || '').slice(0, 6000);
  if (!text.trim()) return null;
  try {
    const raw = await chatOllama([
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: `Objective:\n${String(objective).slice(0, 1500)}\n\nAgent output:\n${text}` },
    ], { temperature: 0.1, format: 'json', maxTokens: 400, priority: 'scoring', label: 'outcome-judge' });
    const cleaned = String(raw).replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1) return null;
    const j = JSON.parse(cleaned.slice(s, e + 1));
    return {
      specificity: clamp01(+j.specificity), actionability: clamp01(+j.actionability), evidence: clamp01(+j.evidence),
      metaTalk: clamp01(+j.meta_talk), overall: clamp01(+j.overall), critique: String(j.critique || '').slice(0, 300),
    };
  } catch (e) {
    return { error: e.message.slice(0, 200) };
  }
}

export async function scoreOutcome({ execId, objective, threadId, reply, runStatus }) {
  const det = deterministicSignals({ threadId, reply });
  const judge = runStatus === 'done' ? await judgeReply({ objective, reply }) : null;
  const judgeOk = judge && !judge.error;
  let quality;
  if (runStatus !== 'done') quality = Math.min(0.2, det.score * 0.4);
  else quality = judgeOk ? clamp01(0.5 * judge.overall + 0.5 * det.score) : det.score;

  const detail = { deterministic: det, judge: judge || null, blended: judgeOk, runStatus };
  if (execId) {
    try {
      db.prepare(`UPDATE goal_executions SET quality = ?, quality_detail = ? WHERE id = ?`)
        .run(quality, JSON.stringify(detail).slice(0, 8000), execId);
    } catch (e) { console.error('[outcome-scorer] persist:', e.message); }
  }
  return { quality, detail };
}

export function agentQualityStats(agentId, { windowMs = 7 * 86400_000, limit = 20 } = {}) {
  const rows = db.prepare(
    `SELECT quality, status, quality_detail FROM goal_executions WHERE agent_id = ? AND quality IS NOT NULL AND started_at > ? ORDER BY started_at DESC LIMIT ?`
  ).all(agentId, now() - windowMs, limit);
  if (!rows.length) return { agentId, n: 0, mean: null, completed: 0, critiques: [] };
  const mean = rows.reduce((s, r) => s + r.quality, 0) / rows.length;
  const completed = rows.filter(r => r.status === 'completed').length;
  const critiques = [];
  for (const r of rows) {
    try { const c = JSON.parse(r.quality_detail || '{}')?.judge?.critique; if (c) critiques.push(c); } catch (_) {}
    if (critiques.length >= 3) break;
  }
  return { agentId, n: rows.length, mean, completed, completionRate: completed / rows.length, critiques };
}

export function fleetQualityStats({ windowMs = 7 * 86400_000 } = {}) {
  return db.prepare(
    `SELECT agent_id, COUNT(*) as n, AVG(quality) as mean, SUM(status = 'completed') as completed
     FROM goal_executions WHERE quality IS NOT NULL AND started_at > ? GROUP BY agent_id ORDER BY mean DESC`
  ).all(now() - windowMs);
}

// Real-world fitness for the ouroboros engine: what the organism actually achieved,
// not how close its genome sits to phi. Weighted composite over the last 24 h.
export function computeRealityFitness({ windowMs = 86400_000 } = {}) {
  const since = now() - windowMs;
  const q = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (_) { return null; } };

  const goals = q(`SELECT COUNT(*) as n, SUM(status = 'completed') as ok, AVG(quality) as quality FROM goal_executions WHERE started_at > ?`, since);
  const runs = q(`SELECT COUNT(*) as n, SUM(status = 'done') as ok FROM runs WHERE created_at > ?`, since);
  const verif = q(`SELECT COUNT(*) as n, SUM(status = 'passed') as ok FROM verification_loops WHERE created_at > ?`, since);
  const debates = q(`SELECT COUNT(*) as n, SUM(verdict IN ('proponent','opponent','CONFIRMED','CHALLENGED')) as decided FROM debates WHERE created_at > ?`, since);

  const parts = [];
  if (goals?.n) { parts.push({ k: 'goalCompletion', w: 0.25, v: goals.ok / goals.n }); if (goals.quality != null) parts.push({ k: 'goalQuality', w: 0.35, v: goals.quality }); }
  if (runs?.n) parts.push({ k: 'runSuccess', w: 0.20, v: runs.ok / runs.n });
  if (verif?.n) parts.push({ k: 'verifierPass', w: 0.10, v: verif.ok / verif.n });
  if (debates?.n) parts.push({ k: 'debateDecisiveness', w: 0.10, v: debates.decided / debates.n });

  if (!parts.length) return { available: false, score: null, parts: [], windowMs };
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  const score = parts.reduce((s, p) => s + p.w * p.v, 0) / wsum;
  return { available: true, score: clamp01(score), parts: parts.map(p => ({ ...p, v: +p.v.toFixed(3) })), samples: { goals: goals?.n || 0, runs: runs?.n || 0, verifier: verif?.n || 0, debates: debates?.n || 0 }, windowMs };
}

export function installOutcomeScorerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/goal-executor/quality', route((_req, res) => {
    res.json({ fleet: fleetQualityStats(), reality: computeRealityFitness() });
  }));
  app.get('/api/goal-executor/quality/:agentId', route((req, res) => {
    res.json(agentQualityStats(String(req.params.agentId).slice(0, 80)));
  }));
}
