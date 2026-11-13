/**
 * The second brain as Chandra really uses it (2026-11-13). The home screen used to draw a separate projection — the
 * newest 400 rows per table joined only by shared tags (180 memories, 4 edges) — while the agents recall from
 * intelligence/knowledge-graph.js (8,315 nodes, 18,858 weighted edges). This reads the real stores:
 *
 *   knowledge_nodes / knowledge_edges   agents, memories, reflections, fossils; semantically_related, owns_memory
 *   facts                                current claims per entity (facts.js), tied to the memory they were read from
 *   goal_executions + goal_proposals     goals an agent executed, with their quality
 *   forged_skills + forged_skill_calls   skills the organism made, and who calls them
 *   fleet_model_calls                    which model on which machine answered each agent
 *
 * A snapshot is the most connected part of the brain within a budget, every node carrying its metrics, plus metrics of
 * the whole brain and of the part shown. Read-only: nothing here writes a store. The pure parts (selection, metrics,
 * ego graph) are exported for tests.
 */
import { getConsciousnessState } from '../intelligence/consciousness-gate.js';

const DAY = 86_400_000;
const clip = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const parse = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? d); } catch { return d; } };

/** Graph metrics: counts, average degree, density, connected components, orphan share. */
export function brainMetrics(nodes, edges) {
  const n = nodes.length, ids = new Map(nodes.map((x, i) => [x.id, i])), parent = nodes.map((_, i) => i), deg = new Array(n).fill(0);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  let e = 0;
  for (const edge of edges) {
    const a = ids.get(edge.from), b = ids.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    e++; deg[a]++; deg[b]++;
    const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb;
  }
  const roots = new Set(); for (let i = 0; i < n; i++) roots.add(find(i));
  const orphans = deg.filter(d => d === 0).length;
  return { nodes: n, edges: e, avgDegree: n ? +(2 * e / n).toFixed(2) : 0, density: n > 1 ? +(2 * e / (n * (n - 1))).toFixed(4) : 0,
    components: roots.size, orphans, orphanShare: n ? +(orphans / n).toFixed(3) : 0, maxDegree: n ? Math.max(...deg) : 0 };
}

/** Everything within `depth` links of `focus`, at most `cap` nodes, nearest first. */
export function egoGraph(focus, edges, { depth = 2, cap = 300 } = {}) {
  const adj = new Map();
  for (const e of edges) { (adj.get(e.from) || adj.set(e.from, []).get(e.from)).push(e.to); (adj.get(e.to) || adj.set(e.to, []).get(e.to)).push(e.from); }
  const seen = new Map([[focus, 0]]), queue = [focus];
  while (queue.length && seen.size < cap) {
    const cur = queue.shift(), d = seen.get(cur);
    if (d >= depth) continue;
    for (const nx of adj.get(cur) || []) { if (seen.has(nx)) continue; seen.set(nx, d + 1); queue.push(nx); if (seen.size >= cap) break; }
  }
  return seen;                                                                        // id → hops from focus
}

/**
 * Which knowledge nodes to show within a budget: every agent, then the rest by a score of connections, recall and
 * recency (a node touched this week counts as several links), so the picture is the part of the brain that is used.
 */
export function selectNodes(rows, degree, { budget = 600, now = Date.now(), ownerShare = 0.15 } = {}) {
  const agents = rows.filter(r => r.type === 'agent');
  const room = Math.max(0, budget - agents.length), perOwner = Math.max(20, Math.floor(room * ownerShare));
  const owner = r => { try { return JSON.parse(r.metadata || '{}').agent_id || r.type; } catch { return r.type; } };
  // no single owner may fill the picture: 'system' owns most memories and was drawing as one giant blob
  const used = new Map(), picked = [];
  const ranked = rows.filter(r => r.type !== 'agent').map(r => ({ r, s: (degree.get(r.id) || 0) + Math.min(10, r.access_count || 0) * 0.5 + (now - (r.created_at || 0) < 7 * DAY ? 3 : 0) })).sort((a, b) => b.s - a.s);
  for (const { r } of ranked) {
    if (picked.length >= room) break;
    const o = owner(r), n = used.get(o) || 0;
    if (n >= perOwner) continue;
    used.set(o, n + 1); picked.push(r);
  }
  return [...agents, ...picked];
}

export function createBrainService(db) {
  const all = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch (e) { console.error('[brain]', e.message); return []; } };
  const one = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch (e) { console.error('[brain]', e.message); return null; } };

  function core() {
    let state = null;
    try { state = getConsciousnessState(); } catch (e) { console.error('[brain] gate:', e.message); }
    const tier = state?.tier?.label || null;
    return { id: 'core', kind: 'core', title: 'Chandra', summary: state ? `${tier || 'unknown'} · ${state.proofsPassed ?? '?'}/${state.proofsTotal ?? 4} proofs${state.phi != null ? ` · Φ ${Number(state.phi).toFixed(2)}` : ''}` : 'the core',
      metrics: { tier, level: state?.tier?.level ?? null, phi: state?.phi ?? null, proofs: state?.proofsPassed ?? null, stale: !!state?.stale } };
  }

  /** The whole brain's size, not just the part drawn. */
  function totals() {
    const now = Date.now();
    return {
      knowledgeNodes: one('SELECT COUNT(*) n FROM knowledge_nodes')?.n || 0,
      knowledgeEdges: one('SELECT COUNT(*) n FROM knowledge_edges')?.n || 0,
      memories: one('SELECT COUNT(*) n FROM agent_memories')?.n || 0,
      memoriesEmbedded: one('SELECT COUNT(*) n FROM agent_memory_vectors')?.n || 0,
      facts: one('SELECT COUNT(*) n FROM facts WHERE expired_at IS NULL')?.n || 0,
      factsSuperseded: one('SELECT COUNT(*) n FROM facts WHERE expired_at IS NOT NULL')?.n || 0,
      added24h: one('SELECT COUNT(*) n FROM knowledge_nodes WHERE created_at > ?', now - DAY)?.n || 0,
      memories24h: one('SELECT COUNT(*) n FROM agent_memories WHERE updated_at > ?', now - DAY)?.n || 0,
      recallHits: one('SELECT COALESCE(SUM(access_count),0) n FROM knowledge_nodes')?.n || 0,
      goals7d: one('SELECT COUNT(*) n, ROUND(AVG(quality),3) q FROM goal_executions WHERE finished_at > ?', now - 7 * DAY) || { n: 0, q: null },
      lastConsolidation: one("SELECT MAX(created_at) t FROM knowledge_graph_events WHERE event_type = 'consolidation'")?.t || null,
    };
  }

  function snapshot({ budget = 600, q = '', focus = '' } = {}) {
    budget = Math.min(1500, Math.max(60, parseInt(budget, 10) || 600));
    const now = Date.now();
    const rows = all('SELECT id, type, source_table, source_id, label, content, metadata, access_count, created_at FROM knowledge_nodes');
    const kgEdges = all('SELECT from_node_id f, to_node_id t, relation, weight FROM knowledge_edges').map(e => ({ from: e.f, to: e.t, type: e.relation, weight: e.weight }));
    const degree = new Map();
    for (const e of kgEdges) { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); }
    const agentNode = new Map(rows.filter(r => r.type === 'agent').map(r => [r.label, r.id]));
    const memNode = new Map(rows.filter(r => r.source_table === 'agent_memories').map(r => [String(r.source_id), r.id]));

    // which knowledge nodes: a search, a focus (two hops around one node), or the most used part within the budget
    let chosen;
    const query = String(q || '').trim().toLowerCase();
    if (focus && rows.some(r => r.id === focus)) {
      const hops = egoGraph(focus, kgEdges, { depth: 2, cap: budget });
      chosen = rows.filter(r => hops.has(r.id));
    } else if (query) {
      const hit = new Set(rows.filter(r => `${r.label} ${r.content || ''}`.toLowerCase().includes(query)).slice(0, Math.floor(budget / 3)).map(r => r.id));
      for (const e of kgEdges) { if (hit.size >= budget) break; if (hit.has(e.from)) hit.add(e.to); else if (hit.has(e.to)) hit.add(e.from); }
      chosen = rows.filter(r => hit.has(r.id));                                   // the matches, their neighbours and owners
    } else chosen = selectNodes(rows, degree, { budget, now });

    const nodes = [core()], ids = new Set(['core']);
    for (const r of chosen) {
      const meta = parse(r.metadata, {});
      nodes.push({ id: r.id, kind: r.type, title: clip(r.label, 80), summary: clip(r.content, 240), source: r.source_table, sourceId: r.source_id,
        agentId: meta.agent_id || (r.type === 'agent' ? r.label : null), category: meta.category || null,
        openPath: r.source_table === 'agent_memories' ? `/api/fraymus-os/graph/node/memory:agent:${r.source_id}` : null,
        metrics: { degree: degree.get(r.id) || 0, access: r.access_count || 0, createdAt: r.created_at, confidence: meta.confidence ?? null, verified: meta.verified ?? null } });
      ids.add(r.id);
    }
    const edges = kgEdges.filter(e => ids.has(e.from) && ids.has(e.to));
    for (const a of nodes.filter(x => x.kind === 'agent')) edges.push({ from: 'core', to: a.id, type: 'core', weight: 1 });
    // in a search or focus view only what touches the picture is added: facts, goals, skills and models that link to
    // nothing shown would float as separate islands (85 of them in the first focus view)
    const narrowed = !!(focus || query);
    const agentId = name => { if (!name) return null; if (agentNode.has(name)) { const id = agentNode.get(name); return !narrowed || ids.has(id) ? id : null; } if (narrowed) return null; const id = `agent:${name}`; if (!ids.has(id)) { nodes.push({ id, kind: 'agent', title: name, summary: 'agent (no knowledge-graph node yet)', agentId: name, metrics: { degree: 0, access: 0 } }); ids.add(id); edges.push({ from: 'core', to: id, type: 'core', weight: 1 }); } return id; };

    // facts: one node per entity, tied to the memory it was read from (or to the agent that asserted it)
    const facts = all(`SELECT entity, COUNT(*) n, ROUND(AVG(confidence),2) c, MAX(last_seen_at) seen, MAX(source_memory_id) mem, MAX(asserted_by) by, GROUP_CONCAT(claim, ' · ') claims
      FROM facts WHERE expired_at IS NULL GROUP BY entity ORDER BY seen DESC LIMIT 60`);
    for (const f of facts) {
      const id = `fact:${f.entity}`;
      const memAnchor = f.mem && memNode.get(String(f.mem)) && ids.has(memNode.get(String(f.mem))) ? memNode.get(String(f.mem)) : null;
      const anchor = memAnchor || agentId(f.by || 'system');
      if (!anchor) continue;
      nodes.push({ id, kind: 'fact', title: f.entity, summary: clip(f.claims, 240), source: 'facts', sourceId: f.entity, metrics: { degree: 0, claims: f.n, confidence: f.c, createdAt: f.seen } });
      ids.add(id);
      edges.push({ from: id, to: anchor, type: 'fact_of', weight: f.c || 0.5 });
    }

    // goals executed in the last week, by the agent that ran them, coloured by quality
    const goals = all(`SELECT e.goal_id g, e.agent_id a, e.status s, e.quality q, MAX(e.finished_at) t, COUNT(*) n, p.objective o
      FROM goal_executions e LEFT JOIN goal_proposals p ON p.id = e.goal_id WHERE e.finished_at > ? GROUP BY e.goal_id ORDER BY t DESC LIMIT 60`, now - 7 * DAY);
    for (const g of goals) {
      const id = `goal:${g.g}`, from = agentId(g.a);
      if (!from) continue;
      nodes.push({ id, kind: 'goal', title: clip(g.o || g.g, 80), summary: `${g.s}${g.q != null ? ` · quality ${g.q.toFixed(2)}` : ''}${g.n > 1 ? ` · ${g.n} attempts` : ''}`, source: 'goal_executions', sourceId: g.g,
        metrics: { degree: 0, quality: g.q, status: g.s, attempts: g.n, createdAt: g.t } });
      ids.add(id);
      edges.push({ from, to: id, type: 'executed', weight: g.q ?? 0.3 });
    }

    // forged skills, and who calls them
    for (const s of narrowed ? [] : all('SELECT id, name, status, calls, failures, created_at FROM forged_skills')) {
      const id = `skill:${s.id}`;
      nodes.push({ id, kind: 'skill', title: `skill.${s.name}`, summary: `${s.status} · ${s.calls || 0} calls · ${s.failures || 0} failures`, source: 'forged_skills', sourceId: s.id,
        metrics: { degree: 0, status: s.status, calls: s.calls || 0, quality: s.calls ? 1 - (s.failures || 0) / s.calls : null, createdAt: s.created_at } });
      ids.add(id); edges.push({ from: 'core', to: id, type: 'core', weight: 0.3 });
      for (const c of all('SELECT agent_id a, COUNT(*) n FROM forged_skill_calls WHERE skill_id = ? GROUP BY agent_id', s.id)) { const from = agentId(c.a); if (from) edges.push({ from, to: id, type: 'calls', weight: Math.min(1, c.n / 10) }); }
    }

    // which model on which machine answered each agent (last 7 days)
    const calls = all('SELECT agent_id a, model m, host h, COUNT(*) n, SUM(ok) good, ROUND(AVG(ms)) ms, MAX(at) t FROM fleet_model_calls WHERE at > ? GROUP BY agent_id, model, host', now - 7 * DAY);
    for (const c of calls) {
      const id = `model:${c.m}@${c.h}`, from = agentId(c.a);
      if (!from) continue;
      if (!ids.has(id)) { nodes.push({ id, kind: 'model', title: `${c.m} on ${c.h}`, summary: 'answers agent calls', source: 'fleet_model_calls', sourceId: id, metrics: { degree: 0, calls: 0, ok: 0, ms: c.ms, createdAt: c.t } }); ids.add(id); }
      const m = nodes.find(x => x.id === id); m.metrics.calls += c.n; m.metrics.ok += c.good; m.metrics.quality = m.metrics.calls ? m.metrics.ok / m.metrics.calls : null;
      edges.push({ from, to: id, type: 'answered_by', weight: Math.min(1, c.n / 20) });
    }

    // notes saved from the home screen: yours, tied to the core
    for (const n of narrowed ? [] : all('SELECT id, title, body, tags, updated_at FROM fraymus_os_notes ORDER BY updated_at DESC LIMIT 40')) {
      const id = `note:${n.id}`;
      nodes.push({ id, kind: 'note', title: clip(n.title, 80), summary: clip(n.body, 240), source: 'fraymus_os_notes', sourceId: n.id, openPath: `/api/fraymus-os/notes/${n.id}`, metrics: { degree: 0, createdAt: n.updated_at } });
      ids.add(id); edges.push({ from: 'core', to: id, type: 'note', weight: 0.6 });
    }

    // degree inside the picture, for size
    const shownDeg = new Map(); for (const e of edges) { shownDeg.set(e.from, (shownDeg.get(e.from) || 0) + 1); shownDeg.set(e.to, (shownDeg.get(e.to) || 0) + 1); }
    for (const x of nodes) { x.metrics = x.metrics || {}; x.metrics.links = shownDeg.get(x.id) || 0; if (!x.metrics.degree) x.metrics.degree = x.metrics.links; x.metrics.recent = x.metrics.createdAt ? now - x.metrics.createdAt < DAY : false; }

    const counts = {}; for (const x of nodes) counts[x.kind] = (counts[x.kind] || 0) + 1;
    const relations = {}; for (const e of edges) relations[e.type] = (relations[e.type] || 0) + 1;
    return { generatedAt: now, budget, focus: focus || null, query: query || null, nodes, edges, counts, relations,
      shown: brainMetrics(nodes, edges), whole: { ...brainMetrics(rows, kgEdges), ...totals() } };
  }

  /** Ids of nodes touched since `since` (ms): memories written, facts seen, goals finished, model calls answered. */
  function pulse(since) {
    const t = Math.max(Date.now() - 10 * 60_000, parseInt(since, 10) || Date.now() - 60_000);
    const mem = all('SELECT k.id FROM agent_memories m JOIN knowledge_nodes k ON k.source_table = \'agent_memories\' AND k.source_id = CAST(m.id AS TEXT) WHERE m.updated_at > ? LIMIT 200', t).map(r => r.id);
    const facts = all('SELECT DISTINCT entity FROM facts WHERE last_seen_at > ? LIMIT 100', t).map(r => `fact:${r.entity}`);
    const goals = all('SELECT DISTINCT goal_id FROM goal_executions WHERE finished_at > ? LIMIT 100', t).map(r => `goal:${r.goal_id}`);
    const calls = all('SELECT DISTINCT agent_id a, model m, host h FROM fleet_model_calls WHERE at > ? LIMIT 100', t);
    const kgNew = all('SELECT id FROM knowledge_nodes WHERE created_at > ? LIMIT 200', t).map(r => r.id);
    return { at: Date.now(), since: t, ids: [...new Set([...mem, ...facts, ...goals, ...kgNew, ...calls.map(c => `model:${c.m}@${c.h}`)])], agents: [...new Set(calls.map(c => c.a))] };
  }

  return { snapshot, pulse, totals };
}
