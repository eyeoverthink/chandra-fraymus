/**
 * Facts service — the live fact store over data/chandra.db: where facts come from, and who reads them.
 *
 * In:  agents assert facts with the `fact_assert` tool; and a slow background reader turns stored memories into
 *      facts, a few at a time. A model proposes them; code decides whether to believe the proposal — every
 *      proposed fact must QUOTE the memory it came from, the quote must really be there, the entity must be named
 *      in it, and every number in the claim must appear in it (gbrain calls this mechanical grounding). A proposal
 *      that fails any of these is dropped and counted.
 * Out: `fact_lookup` for agents, a "Known facts" block in an agent's prompt when its task names an entity, and routes.
 * Nothing is deleted: a replaced fact is expired and points at its replacement.
 */
import Database from 'better-sqlite3';
import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { createFactStore, runFactsBench, entitySlug, KINDS, grounded, extractMessages } from './facts.js';
import { isResourceConstrained } from './resource-envelope.js';

const now = () => Date.now();
const READ_EVERY_MS = Math.max(60_000, parseInt(process.env.FACTS_READ_INTERVAL_MS, 10) || 600_000);
const READ_BATCH = Math.min(20, Math.max(1, parseInt(process.env.FACTS_READ_BATCH, 10) || 3));
const READ_CATEGORIES = ['outcome', 'insight', 'world', 'hive_message', 'fossil', 'research', 'binary_dossier'];
const ENABLED = process.env.FACTS_READER !== '0';

export const facts = createFactStore({ db });
let ready = false, timer = null, reading = false;
const stats = { read: 0, proposed: 0, accepted: 0, dropped: { no_quote: 0, quote_not_in_source: 0, entity_not_in_quote: 0, number_not_in_quote: 0, claim_does_not_name_entity: 0, refused: 0 }, duplicates: 0, superseded: 0, lastAt: null, lastError: null };

function ensure() {
  if (ready) return;
  facts.ensure();
  db.exec(`CREATE TABLE IF NOT EXISTS facts_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  ready = true;
}

/** Turn proposals into stored facts, keeping only the grounded ones. */
function acceptProposals(proposals, memory) {
  const out = { accepted: 0, duplicates: 0, superseded: 0, dropped: 0 };
  for (const p of (Array.isArray(proposals) ? proposals : []).slice(0, 4)) {
    stats.proposed++;
    const g = grounded(p, memory.value);
    if (!g.ok) { stats.dropped[g.why]++; out.dropped++; continue; }
    const r = facts.assertFact({ entity: p.entity, claim: p.claim, kind: KINDS.includes(p.kind) ? p.kind : 'fact', confidence: Math.min(0.85, Number(memory.confidence) || 0.6), source: `memory:${memory.category}`, sourceMemoryId: memory.id, assertedBy: memory.agent_id, quote: p.quote });
    if (r.status === 'refused') { stats.dropped.refused++; out.dropped++; }
    else if (r.status === 'duplicate') { stats.duplicates++; out.duplicates++; }
    else { stats.accepted++; out.accepted++; if (r.status === 'superseded') { stats.superseded++; out.superseded++; } }
  }
  return out;
}

/** Read the next few memories nobody has read for facts yet. One reader at a time; never throws. */
export async function readMemoriesForFacts({ max = READ_BATCH, force = false } = {}) {
  if (reading) return { skipped: 'already reading' };
  if (!force && isResourceConstrained()) return { skipped: 'the system is under load' };
  reading = true;
  const result = { read: 0, accepted: 0, duplicates: 0, superseded: 0, dropped: 0, errors: 0 };
  try {
    ensure();
    const mark = parseInt(db.prepare(`SELECT value FROM facts_state WHERE key = 'last_memory_id'`).get()?.value, 10) || 0;
    const rows = db.prepare(`SELECT id, agent_id, category, value, confidence FROM agent_memories WHERE id > ? AND category IN (${READ_CATEGORIES.map(() => '?').join(',')}) AND LENGTH(value) >= 80 ORDER BY id LIMIT ?`).all(mark, ...READ_CATEGORIES, Math.min(20, Math.max(1, max)));
    for (const m of rows) {
      let reply;
      try { reply = await chatOllama(extractMessages(m.value), { format: 'json', priority: 'background', temperature: 0.1, maxTokens: 500, timeoutMs: 120_000, label: 'facts:read' }); }
      catch (e) { result.errors++; stats.lastError = String(e.message).slice(0, 160); break; }           // dropped by the scheduler or timed out: stop, and try this memory again next time
      let obj = null; try { const a = String(reply).indexOf('{'), z = String(reply).lastIndexOf('}'); obj = a >= 0 && z > a ? JSON.parse(String(reply).slice(a, z + 1)) : null; } catch (_) { obj = null; }
      const r = acceptProposals(obj?.facts, m);
      for (const k of ['accepted', 'duplicates', 'superseded', 'dropped']) result[k] += r[k];
      result.read++; stats.read++;
      db.prepare(`INSERT INTO facts_state (key, value) VALUES ('last_memory_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(m.id));
    }
    stats.lastAt = now();
  } catch (e) { stats.lastError = String(e.message).slice(0, 160); console.error('[facts] read:', e.message); }
  finally { reading = false; }
  return result;
}

export function startFactsReader() {
  if (timer || !ENABLED) return { started: false, reason: ENABLED ? 'already running' : 'switched off (FACTS_READER=0)' };
  try { ensure(); } catch (e) { return { started: false, reason: e.message }; }
  timer = setInterval(() => { readMemoriesForFacts().catch(e => console.error('[facts] reader:', e.message)); }, READ_EVERY_MS);
  timer.unref?.();
  return { started: true, everyMs: READ_EVERY_MS, batch: READ_BATCH };
}
export function stopFactsReader() { if (timer) clearInterval(timer); timer = null; return { stopped: true }; }

/** Current facts about the things a task names, as a prompt block. Synchronous; empty when the task names nothing known. */
export function factsPromptContext(taskText, { maxFacts = 5 } = {}) {
  try {
    ensure();
    const ents = facts.entitiesIn(taskText, { limit: 3 }); if (!ents.length) return '';
    const lines = ents.flatMap(e => facts.currentFacts({ entity: e, limit: 3, minConfidence: 0.15 })).slice(0, maxFacts).map(f => `- ${f.claim} (confidence ${f.confidence.toFixed(2)}${f.seen > 1 ? `, stated ${f.seen} times` : ''})`);
    return lines.length ? `\n--- Known facts (current; older versions were replaced) ---\n${lines.join('\n')}\n--- End facts ---\n` : '';
  } catch (e) { console.error('[facts] prompt:', e.message); return ''; }
}

export function factsStatus() {
  try { ensure(); const mark = db.prepare(`SELECT value FROM facts_state WHERE key = 'last_memory_id'`).get()?.value || '0';
    const waiting = db.prepare(`SELECT COUNT(*) n FROM agent_memories WHERE id > ? AND category IN (${READ_CATEGORIES.map(() => '?').join(',')}) AND LENGTH(value) >= 80`).get(parseInt(mark, 10) || 0, ...READ_CATEGORIES).n;
    return { ...facts.stats(), reader: { running: !!timer, busy: reading, everyMs: READ_EVERY_MS, batch: READ_BATCH, memoriesWaiting: waiting, ...stats } };
  } catch (e) { return { error: e.message }; }
}

export function createFactTools() {
  return [
    { name: 'fact_assert', group: 'fleet', risk: 'safe',
      description: 'Record one checkable fact about one named thing ("the render worker", "port 47210"). If the same statement is already known nothing changes; if it is the same statement with a different number, date or a "not", the old fact is kept as history and this one becomes current. Use it for things that are true about the world or this system, not for opinions or plans.',
      parameters: { type: 'object', required: ['entity', 'claim'], properties: {
        entity: { type: 'string', description: 'the thing the fact is about, one to four words' },
        claim: { type: 'string', description: 'one sentence that stands on its own and names the entity' },
        kind: { type: 'string', description: 'fact (default), event, preference, commitment, belief or idea' },
        confidence: { type: 'number', description: '0 to 1, how sure you are (default 0.7)' },
      } },
      execute: async ({ args = {} } = {}, ctx = {}) => { ensure(); return facts.assertFact({ entity: args.entity, claim: args.claim, kind: args.kind, confidence: args.confidence ?? 0.7, source: 'agent', assertedBy: ctx?.agentId || ctx?.agent?.id || null }); } },
    { name: 'fact_lookup', group: 'fleet', risk: 'safe',
      description: 'What is currently known about a named thing: the current facts, most believable first, and how many older versions were replaced. Pass history=true to read every version in order.',
      parameters: { type: 'object', required: ['entity'], properties: { entity: { type: 'string', description: 'the thing to look up' }, history: { type: 'boolean', description: 'true to list every version, oldest first' } } },
      execute: async ({ args = {} } = {}) => { ensure(); const h = facts.history(args.entity); return args.history ? { entity: entitySlug(args.entity), versions: h } : { entity: entitySlug(args.entity), current: facts.currentFacts({ entity: args.entity, limit: 10 }), replaced: h.filter(f => f.supersededBy).length }; } },
  ];
}

export function installFactsRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/facts', route((req, res) => { ensure(); res.json({ ...factsStatus(), facts: facts.currentFacts({ entity: req.query.entity ? String(req.query.entity).slice(0, 80) : null, limit: Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 30)) }) }); }));
  app.get('/api/intelligence/facts/history', route((req, res) => { ensure(); if (!req.query.entity) return res.status(400).json({ error: 'entity is required' }); res.json({ entity: entitySlug(req.query.entity), versions: facts.history(String(req.query.entity).slice(0, 80)) }); }));
  app.post('/api/intelligence/facts', route((req, res) => { ensure(); const r = facts.assertFact({ entity: req.body?.entity, claim: req.body?.claim, kind: req.body?.kind, confidence: req.body?.confidence, source: 'operator', assertedBy: 'operator' }); res.status(r.status === 'refused' ? 422 : 200).json(r); }));
  app.post('/api/intelligence/facts/read', route(async (req, res) => res.json(await readMemoriesForFacts({ max: Math.min(20, Math.max(1, parseInt(req.body?.max, 10) || READ_BATCH)), force: true }))));
  app.post('/api/intelligence/facts/bench', route((req, res) => res.json(runFactsBench({ Database, seed: Math.min(1_000_000, Math.max(1, parseInt(req.body?.seed, 10) || 42)) }))));
  app.post('/api/intelligence/facts/:id/expire', route((req, res) => { ensure(); res.json(facts.expire(parseInt(req.params.id, 10))); }));
}
