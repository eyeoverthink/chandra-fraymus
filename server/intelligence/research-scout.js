/**
 * Research Scout — the self-modification kernel's third proposer (Phase AA, 2026-11-09).
 *
 * The kernel's first two proposers look inward (deterministic rules, the convention scanner).
 * This one reads the world: once a day it pulls recent research on the things this organism is
 * made of — continual learning and forgetting, memory consolidation and replay, inference and
 * KV-cache efficiency, Hebbian / neuromodulatory plasticity, active inference, verifier-gated
 * self-improving agents, integrated information — from KEYLESS sources (arXiv Atom API, Hacker
 * News via Algolia; Semantic Scholar best-effort), scores each item against the system's own
 * map (tunable names and effects, module stems from the self-model, topic vocabulary), and
 * translates the few most relevant into ONE actionable thing each:
 *    experiment — a hypothesis on an existing tunable (→ tier A, measured and auto-reverted)
 *    code       — a one-file sketch for an existing module (→ tier B, tested branch, human merge)
 *    idea       — not actionable with today's knobs; stored as a `research` memory so a later
 *                 session (or the LLM proposer) can turn it into a new tunable
 *    none       — the honest answer most of the time
 * The scout never acts itself: the kernel pulls `nextResearchExperiment()` / `nextResearchCode()`
 * (one-directional dependency, kernel → scout) so proposer credit attributes outcomes to
 * `research:<source:id>` and a week of verdicts tells us whether reading makes it smarter.
 *
 * No paid APIs. Dedup by source id. Translation budget RESEARCH_MAX_TRANSLATE (3) per scan.
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { REGISTRY, TUNABLE_NAMES, tunable } from './tunables.js';
import { getSystemMap } from './self-model.js';   // module list for the translator's `code` targets
import { isResourceConstrained } from './resource-envelope.js';

const now = () => Date.now();
const H = 3_600_000;
const REPO_ROOT = resolve(process.cwd());
const ENABLED = process.env.RESEARCH_ENABLED !== '0';
const SCAN_INTERVAL_MS = Math.max(H, parseInt(process.env.RESEARCH_SCAN_INTERVAL_MS, 10) || 24 * H);
const MAX_TRANSLATE = Math.max(0, parseInt(process.env.RESEARCH_MAX_TRANSLATE, 10) || 3);
const MIN_RELEVANCE = Math.min(1, Math.max(0, parseFloat(process.env.RESEARCH_MIN_RELEVANCE) || 0.45));
const PER_QUERY = Math.max(3, Math.min(50, parseInt(process.env.RESEARCH_PER_QUERY, 10) || 15));
const UA = 'chandra-fraymus research-scout (+local sovereign agent; keyless; daily)';
const ALLOWED_ROOTS = ['server', 'client/src', 'scripts'];

// Topics are the organism's own concerns. `arxiv` is an arXiv search_query; `hn` a plain query; `terms` score relevance.
export const TOPICS = [
  { id: 'continual_learning', arxiv: 'all:"continual learning" AND (cat:cs.LG OR cat:cs.AI)', hn: 'continual learning', terms: ['continual learning', 'catastrophic forgetting', 'lifelong learning', 'replay', 'consolidation', 'plasticity'] },
  { id: 'memory_consolidation', arxiv: 'all:"memory consolidation" OR all:"episodic memory" AND cat:cs.AI', hn: 'agent memory consolidation', terms: ['episodic memory', 'memory consolidation', 'retrieval', 'forgetting curve', 'working memory', 'long-term memory'] },
  { id: 'inference_efficiency', arxiv: 'all:"KV cache" OR all:"speculative decoding" OR all:"inference efficiency" AND cat:cs.LG', hn: 'LLM inference efficiency', terms: ['kv cache', 'speculative decoding', 'quantization', 'throughput', 'latency', 'batching', 'scheduler'] },
  { id: 'neuromodulation', arxiv: 'all:"Hebbian" OR all:"neuromodulation" OR all:"synaptic plasticity" AND (cat:cs.NE OR cat:q-bio.NC)', hn: 'Hebbian learning neural', terms: ['hebbian', 'neuromodulation', 'dopamine', 'homeostatic', 'synaptic scaling', 'intrinsic plasticity', 'ctrnn', 'recurrent'] },
  { id: 'active_inference', arxiv: 'all:"active inference" OR all:"free energy principle" AND cat:cs.AI', hn: 'active inference free energy', terms: ['active inference', 'free energy', 'prediction error', 'predictive processing', 'surprise', 'efference'] },
  { id: 'self_improving_agents', arxiv: 'all:"self-improving" OR all:"self-improvement" AND all:agent AND cat:cs.AI', hn: 'self-improving AI agent', terms: ['self-improv', 'recursive', 'verifier', 'self-correction', 'reflection', 'meta-learning', 'autonomous agent', 'tool use'] },
  { id: 'program_synthesis_verification', arxiv: 'all:"code generation" AND (all:verification OR all:tests) AND cat:cs.SE', hn: 'LLM code generation tests verification', terms: ['code generation', 'unit test', 'verification', 'program repair', 'patch', 'static analysis'] },
  { id: 'integrated_information', arxiv: 'all:"integrated information" OR all:"consciousness" AND (cat:q-bio.NC OR cat:cs.AI)', hn: 'integrated information theory', terms: ['integrated information', 'phi', 'consciousness', 'causal', 'emergence'] },
];
const EXTRA = (process.env.RESEARCH_TOPICS || '').split(',').map(s => s.trim()).filter(Boolean);
for (const q of EXTRA) TOPICS.push({ id: 'env:' + q.toLowerCase().replace(/\W+/g, '_').slice(0, 40), arxiv: `all:"${q}"`, hn: q, terms: [q.toLowerCase()] });

function ensureTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS research_items (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, ext_id TEXT, title TEXT NOT NULL, abstract TEXT, url TEXT, published_at INTEGER,
    topic TEXT, relevance REAL, relevance_terms TEXT, status TEXT NOT NULL DEFAULT 'new', fetched_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_items_status ON research_items(status, relevance)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS research_proposals (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, kind TEXT NOT NULL, tunable TEXT, value REAL, hypothesis TEXT,
    target_file TEXT, sketch TEXT, rationale TEXT, idea TEXT, citation TEXT,
    status TEXT NOT NULL DEFAULT 'proposed', experiment_id TEXT, code_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_research_props_status ON research_proposals(status, kind)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS research_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, topics INTEGER, fetched INTEGER, new_items INTEGER, translated INTEGER, proposals INTEGER, errors TEXT, duration_ms INTEGER, created_at INTEGER NOT NULL
  )`).run();
}
try { ensureTables(); } catch (e) { console.error('[research] schema:', e.message); }

const q1 = (s, ...p) => { try { return db.prepare(s).get(...p); } catch (e) { return { _error: e.message }; } };
const qa = (s, ...p) => { try { return db.prepare(s).all(...p); } catch { return []; } };
const state = { enabled: ENABLED, running: false, timer: null, scans: 0, lastScanAt: 0, lastScan: null, scanning: false };

// ─── Sources ─────────────────────────────────────────────────────
const xmlText = (block, tag) => { const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : ''; };
async function fetchArxiv(topic) {
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(topic.arxiv)}&sortBy=submittedDate&sortOrder=descending&max_results=${PER_QUERY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`arxiv ${res.status}`);
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const idUrl = xmlText(e, 'id');
    const extId = idUrl.replace(/^.*\/abs\//, '').replace(/v\d+$/, '');
    if (!extId) continue;
    out.push({ id: `arxiv:${extId}`, source: 'arxiv', ext_id: extId, title: xmlText(e, 'title'), abstract: xmlText(e, 'summary').slice(0, 3000), url: idUrl.replace(/^http:/, 'https:'), published_at: Date.parse(xmlText(e, 'published')) || null, topic: topic.id });
  }
  return out;
}
async function fetchHN(topic) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(topic.hn)}&tags=story&hitsPerPage=${PER_QUERY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`hn ${res.status}`);
  const j = await res.json();
  return (j.hits || []).filter(h => h.title && (h.url || h.objectID)).map(h => ({ id: `hn:${h.objectID}`, source: 'hn', ext_id: String(h.objectID), title: h.title, abstract: (h.story_text || '').replace(/<[^>]+>/g, ' ').slice(0, 2000), url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, published_at: h.created_at ? Date.parse(h.created_at) : null, topic: topic.id }));
}
async function fetchS2(topic) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(topic.terms.slice(0, 3).join(' '))}&fields=title,abstract,url,year,externalIds&limit=${Math.min(PER_QUERY, 20)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`s2 ${res.status}`);
  const j = await res.json();
  return (j.data || []).filter(p => p.title && p.paperId).map(p => ({ id: `s2:${p.paperId}`, source: 's2', ext_id: p.paperId, title: p.title, abstract: (p.abstract || '').slice(0, 3000), url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`, published_at: p.year ? Date.UTC(p.year, 0, 1) : null, topic: topic.id }));
}
const SOURCES = [['arxiv', fetchArxiv], ['hn', fetchHN], ['s2', fetchS2]];

// ─── Relevance: does this item name something the organism can move? ──────
// First version mined words out of tunable `effect` prose and self-model keys; "agent",
// "generation", "execution", "quality" then matched 74 % of everything (2026-11-09). The
// vocabulary is now a curated list of MECHANISMS this system actually has — a paper is
// relevant when it names one of these, not when it shares our adjectives.
export const SYSTEM_MECHANISMS = [
  'reflection loop', 'self-reflection', 'metacognit', 'neurogenesis', 'habituation', 'homeostatic', 'homeostasis', 'synaptic scaling', 'intrinsic plasticity',
  'hebbian', 'neuromodulat', 'dopamine', 'continuous-time recurrent', 'ctrnn', 'recurrent neural', 'integrated information', 'phi measure', 'causal structure',
  'active inference', 'free energy', 'prediction error', 'predictive processing', 'efference', 'working memory', 'episodic memory', 'memory consolidation', 'experience replay', 'catastrophic forgetting',
  'kv cache', 'kv-cache', 'speculative decoding', 'inference latency', 'priority schedul', 'request schedul',
  'self-modif', 'self-improv', 'recursive self', 'hyperparameter', 'auto-tun', 'autotun', 'bandit', 'a/b test', 'ablation', 'verifier', 'test-time', 'program repair', 'unit test',
  'credit assignment', 'reward model', 'quality estimat', 'retire', 'curriculum',
];
export function scoreRelevance(item, topic) {
  const text = `${item.title} ${item.abstract || ''}`.toLowerCase();
  const hits = [];
  let score = 0;
  for (const t of topic?.terms || []) if (text.includes(t.toLowerCase())) { score += 2; hits.push(t); }
  for (const t of SYSTEM_MECHANISMS) if (text.includes(t)) { score += 3; hits.push(t); }
  if (!item.abstract || item.abstract.length < 200) score *= 0.5;      // a bare title is weak evidence
  return { relevance: Math.min(1, score / 16), terms: [...new Set(hits)].slice(0, 12) };
}
/** Re-score every stored item with the current vocabulary (cheap; run after changing SYSTEM_MECHANISMS / TOPICS). */
export function rescoreAll() {
  const rows = qa(`SELECT id, title, abstract, topic FROM research_items`);
  const upd = db.prepare(`UPDATE research_items SET relevance = ?, relevance_terms = ? WHERE id = ?`);
  const byTopic = Object.fromEntries(TOPICS.map(t => [t.id, t]));
  const tx = db.transaction(() => { for (const r of rows) { const { relevance, terms } = scoreRelevance(r, byTopic[r.topic]); upd.run(relevance, JSON.stringify(terms), r.id); } });
  tx();
  const relevant = q1(`SELECT COUNT(*) AS c FROM research_items WHERE relevance >= ?`, MIN_RELEVANCE)?.c || 0;
  return { rescored: rows.length, relevant, threshold: MIN_RELEVANCE };
}

// ─── Scan ─────────────────────────────────────────────────────────
export async function scanResearch({ translate = true, trigger = 'timer' } = {}) {
  if (!ENABLED) return { skipped: true, reason: 'disabled' };
  if (state.scanning) return { skipped: true, reason: 'scan_in_progress' };
  state.scanning = true;
  const t0 = now();
  const errors = [];
  let fetched = 0, newItems = 0;
  const upsert = db.prepare(`INSERT OR IGNORE INTO research_items (id, source, ext_id, title, abstract, url, published_at, topic, relevance, relevance_terms, status, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`);
  const exhausted = new Set();   // a source that answered 429 is left alone for the rest of this scan
  try {
    for (const topic of TOPICS) {
      for (const [name, fn] of SOURCES) {
        if (exhausted.has(name)) continue;
        try {
          const items = await fn(topic);
          fetched += items.length;
          for (const it of items) {
            const { relevance, terms } = scoreRelevance(it, topic);
            const r = upsert.run(it.id, it.source, it.ext_id, it.title.slice(0, 400), it.abstract || null, it.url, it.published_at, it.topic, relevance, JSON.stringify(terms), now());
            if (r.changes) newItems++;
          }
        } catch (e) { errors.push(`${topic.id}/${name}: ${e.message}`); if (/\b429\b/.test(e.message)) exhausted.add(name); }
        await new Promise(r => setTimeout(r, 350)); // be polite to keyless endpoints
      }
    }
  } finally { state.scanning = false; }
  let translated = 0, proposals = 0;
  if (translate) { try { const tr = await translateTop({ max: MAX_TRANSLATE }); translated = tr.translated; proposals = tr.proposals; } catch (e) { errors.push('translate: ' + e.message); } }
  const dur = now() - t0;
  db.prepare(`INSERT INTO research_scans (topics, fetched, new_items, translated, proposals, errors, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(TOPICS.length, fetched, newItems, translated, proposals, JSON.stringify(errors.slice(0, 20)), dur, now());
  state.scans++; state.lastScanAt = now(); state.lastScan = { trigger, fetched, newItems, translated, proposals, errors: errors.length, durationMs: dur };
  try { publish('research', 'system.research', JSON.stringify({ action: 'scan', trigger, fetched, newItems, translated, proposals, errors: errors.slice(0, 5), durationMs: dur })); } catch (_) {}
  return { fetched, newItems, translated, proposals, errors, durationMs: dur };
}

// ─── Translation: one abstract → one actionable thing, or none ─────
const TRANSLATE_SYSTEM = `You are the Research Scout of Chandra-FRAYMUS, a local autonomous system that can change itself in exactly two ways: (A) move one of its LIVE TUNABLES inside declared bounds for a measured one-hour experiment, or (B) rewrite one function in one of its existing source files, tested on a branch a human merges.
Read the research item and decide whether it implies ONE concrete, falsifiable change to THIS system. Prefer "none": most research does not map onto a knob this system exposes. Never invent tunables or files.
Return ONLY JSON, one of:
{"kind":"experiment","tunable":"<exact name from the list>","value":<number inside its bounds>,"hypothesis":"<one sentence: mechanism from the paper → metric expected to move>","citation":"<title>"}
{"kind":"code","targetFile":"<exact path from the module list>","sketch":"<what to change in one function, concretely>","rationale":"<why, grounded in the paper>","citation":"<title>"}
{"kind":"idea","idea":"<one or two sentences: what new tunable or mechanism this system would need before the paper's insight applies>","citation":"<title>"}
{"kind":"none","reason":"<short>"}`;

function moduleList() {
  const mods = new Set();
  try { for (const entry of Object.values(getSystemMap() || {})) { const m = entry?.backend?.module; if (m) mods.add(String(m).startsWith('server/') ? String(m) : 'server/' + String(m).replace(/^\.?\//, '')); } } catch {}
  return [...mods].filter(m => existsSync(join(REPO_ROOT, m))).slice(0, 60);
}
function targetOk(file) {
  const rel = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!ALLOWED_ROOTS.some(r => rel.startsWith(r + '/'))) return null;
  const abs = resolve(REPO_ROOT, rel);
  if (!abs.startsWith(REPO_ROOT + sep)) return null;
  try { return statSync(abs).isFile() ? rel : null; } catch { return null; }
}

export async function translateItem(itemId) {
  const it = q1(`SELECT * FROM research_items WHERE id = ?`, itemId);
  if (!it || it._error) return { ok: false, error: 'item not found' };
  const tunables = TUNABLE_NAMES.map(n => ({ name: n, value: tunable(n), min: REGISTRY[n].min, max: REGISTRY[n].max, unit: REGISTRY[n].unit, effect: REGISTRY[n].effect }));
  const raw = await chatOllama([
    { role: 'system', content: TRANSLATE_SYSTEM },
    { role: 'user', content: JSON.stringify({ item: { title: it.title, abstract: (it.abstract || '').slice(0, 2500), source: it.source, url: it.url, matchedTerms: JSON.parse(it.relevance_terms || '[]') }, liveTunables: tunables, modules: moduleList() }) },
  ], { priority: 'goal', label: `research:translate:${it.id}`, format: 'json', temperature: 0.2, maxTokens: 700 }); // 'goal': ≤ 3 calls/day, must not be dropped while waiting for a slot
  const j = parseJSON(raw) || {};
  const t = now();
  const id = 'rp_' + Math.random().toString(36).slice(2, 10);
  let kind = String(j.kind || 'none').toLowerCase();
  let row = null;
  if (kind === 'experiment' && REGISTRY[j.tunable] && Number.isFinite(parseFloat(j.value))) {
    const r = REGISTRY[j.tunable]; const v = Math.min(r.max, Math.max(r.min, parseFloat(j.value)));
    if (v === tunable(j.tunable)) kind = 'none'; else row = { kind, tunable: j.tunable, value: v, hypothesis: String(j.hypothesis || '').slice(0, 400) };
  } else if (kind === 'code' && targetOk(j.targetFile) && j.sketch) {
    row = { kind, target_file: targetOk(j.targetFile), sketch: String(j.sketch).slice(0, 1500), rationale: String(j.rationale || '').slice(0, 600) };
  } else if (kind === 'idea' && j.idea) {
    row = { kind, idea: String(j.idea).slice(0, 800) };
  } else kind = 'none';
  if (kind !== 'none' && row) {
    db.prepare(`INSERT INTO research_proposals (id, item_id, kind, tunable, value, hypothesis, target_file, sketch, rationale, idea, citation, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, it.id, kind, row.tunable || null, row.value ?? null, row.hypothesis || null, row.target_file || null, row.sketch || null, row.rationale || null, row.idea || null, String(j.citation || it.title).slice(0, 300), kind === 'idea' ? 'stored' : 'proposed', t, t);
    if (kind === 'idea') {
      try { storeMemory('system', 'research', `research:${it.id}`, `[Research idea] ${row.idea}\nSource: ${it.title} (${it.url})`, { confidence: 0.5, source: 'research-scout' }); } catch (e) { console.error('[research] memory:', e.message); }
    }
    try { publish('research', 'system.research', JSON.stringify({ action: 'proposal', id, kind, title: it.title, url: it.url, tunable: row.tunable, value: row.value, hypothesis: row.hypothesis, targetFile: row.target_file, idea: row.idea })); } catch (_) {}
  }
  db.prepare(`UPDATE research_items SET status = ? WHERE id = ?`).run(kind === 'none' ? 'ignored' : 'translated', it.id);
  return { ok: true, itemId: it.id, kind, proposalId: kind !== 'none' ? id : null, reason: j.reason || null };
}

export async function translateTop({ max = MAX_TRANSLATE } = {}) {
  if (isResourceConstrained()) return { translated: 0, proposals: 0, reason: 'resource_constrained' };
  const items = qa(`SELECT id FROM research_items WHERE status = 'new' AND relevance >= ? ORDER BY relevance DESC, published_at DESC LIMIT ?`, MIN_RELEVANCE, max);
  let proposals = 0;
  for (const it of items) { const r = await translateItem(it.id); if (r.proposalId) proposals++; }
  return { translated: items.length, proposals };
}

// ─── What the kernel pulls ────────────────────────────────────────
export function nextResearchExperiment() {
  const r = q1(`SELECT p.*, i.title, i.url FROM research_proposals p JOIN research_items i ON i.id = p.item_id WHERE p.kind = 'experiment' AND p.status = 'proposed' ORDER BY i.relevance DESC, p.created_at ASC LIMIT 1`);
  if (!r || r._error) return null;
  return { proposalId: r.id, tunable: r.tunable, value: r.value, hypothesis: `${r.hypothesis} [${r.citation}]`.slice(0, 480), rule: 'research', source: `research:${r.item_id}`, citation: r.citation, url: r.url };
}
export function nextResearchCode() {
  const r = q1(`SELECT p.*, i.title, i.url FROM research_proposals p JOIN research_items i ON i.id = p.item_id WHERE p.kind = 'code' AND p.status = 'proposed' ORDER BY i.relevance DESC, p.created_at ASC LIMIT 1`);
  if (!r || r._error) return null;
  return { proposalId: r.id, originId: r.id, title: `Research: ${String(r.citation || r.title).slice(0, 120)}`, targetFile: r.target_file, sketch: r.sketch, rationale: `${r.rationale} — source: ${r.url}`, source: `research:${r.item_id}` };
}
export function markResearchProposal(id, { status, experimentId = null, codeId = null }) {
  db.prepare(`UPDATE research_proposals SET status = ?, experiment_id = COALESCE(?, experiment_id), code_id = COALESCE(?, code_id), updated_at = ? WHERE id = ?`).run(status, experimentId, codeId, now(), id);
}

// ─── Lifecycle / status / routes ──────────────────────────────────
export function startResearchScout() {
  if (!ENABLED) return { started: false, reason: 'RESEARCH_ENABLED=0' };
  if (state.running) return { started: false, reason: 'already running' };
  state.running = true;
  const due = () => { const last = q1(`SELECT created_at FROM research_scans ORDER BY created_at DESC LIMIT 1`)?.created_at || 0; return now() - last >= SCAN_INTERVAL_MS; };
  state.timer = setInterval(() => { if (due()) scanResearch({ trigger: 'timer' }).catch(e => console.error('[research] scan:', e.message)); }, 15 * 60_000);
  setTimeout(() => { if (due()) scanResearch({ trigger: 'boot' }).then(r => console.log(`[research] scan: ${r.fetched} fetched, ${r.newItems} new, ${r.translated} translated → ${r.proposals} proposals (${r.errors?.length || 0} errors) in ${r.durationMs} ms`)).catch(e => console.error('[research] scan:', e.message)); }, 120_000);
  return { started: true, topics: TOPICS.length, scanIntervalMs: SCAN_INTERVAL_MS, maxTranslate: MAX_TRANSLATE, minRelevance: MIN_RELEVANCE };
}
export function stopResearchScout() { if (state.timer) clearInterval(state.timer); state.timer = null; state.running = false; return { stopped: true }; }

export function listResearchItems({ status = null, topic = null, limit = 40, minRelevance = 0 } = {}) {
  const where = ['relevance >= ?']; const params = [minRelevance];
  if (status) { where.push('status = ?'); params.push(status); }
  if (topic) { where.push('topic = ?'); params.push(topic); }
  return qa(`SELECT id, source, title, url, topic, relevance, relevance_terms, status, published_at, fetched_at FROM research_items WHERE ${where.join(' AND ')} ORDER BY relevance DESC, published_at DESC LIMIT ?`, ...params, Math.min(200, Math.max(1, limit)))
    .map(r => ({ ...r, relevance_terms: JSON.parse(r.relevance_terms || '[]') }));
}
export function listResearchProposals({ status = null, limit = 40 } = {}) {
  return status
    ? qa(`SELECT p.*, i.title AS item_title, i.url FROM research_proposals p JOIN research_items i ON i.id = p.item_id WHERE p.status = ? ORDER BY p.created_at DESC LIMIT ?`, status, Math.min(200, limit))
    : qa(`SELECT p.*, i.title AS item_title, i.url FROM research_proposals p JOIN research_items i ON i.id = p.item_id ORDER BY p.created_at DESC LIMIT ?`, Math.min(200, limit));
}
export function getResearchStatus() {
  const items = Object.fromEntries(qa(`SELECT status, COUNT(*) AS c FROM research_items GROUP BY status`).map(r => [r.status, r.c]));
  const bySource = Object.fromEntries(qa(`SELECT source, COUNT(*) AS c FROM research_items GROUP BY source`).map(r => [r.source, r.c]));
  const byTopic = Object.fromEntries(qa(`SELECT topic, COUNT(*) AS c, ROUND(AVG(relevance), 2) AS rel FROM research_items GROUP BY topic`).map(r => [r.topic, { count: r.c, meanRelevance: r.rel }]));
  const relevant = q1(`SELECT COUNT(*) AS c FROM research_items WHERE relevance >= ?`, MIN_RELEVANCE)?.c || 0;
  const props = Object.fromEntries(qa(`SELECT kind || ':' || status AS k, COUNT(*) AS c FROM research_proposals GROUP BY k`).map(r => [r.k, r.c]));
  const last = q1(`SELECT * FROM research_scans ORDER BY created_at DESC LIMIT 1`) || null;
  return { enabled: ENABLED, running: state.running, scanning: state.scanning, scans: state.scans, lastScanAt: state.lastScanAt, lastScan: last && { ...last, errors: JSON.parse(last.errors || '[]') },
    config: { topics: TOPICS.map(t => t.id), scanIntervalMs: SCAN_INTERVAL_MS, maxTranslate: MAX_TRANSLATE, minRelevance: MIN_RELEVANCE, perQuery: PER_QUERY, sources: SOURCES.map(s => s[0]) },
    items, bySource, byTopic, relevantItems: relevant, proposals: props, pendingExperiment: nextResearchExperiment(), pendingCode: nextResearchCode() };
}
export function installResearchRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const B = '/api/intelligence/research';
  app.get(B, route((_req, res) => res.json(getResearchStatus())));
  app.get(`${B}/items`, route((req, res) => res.json({ items: listResearchItems({ status: req.query.status || null, topic: req.query.topic || null, limit: parseInt(req.query.limit, 10) || 40, minRelevance: parseFloat(req.query.minRelevance) || 0 }) })));
  app.get(`${B}/proposals`, route((req, res) => res.json({ proposals: listResearchProposals({ status: req.query.status || null, limit: parseInt(req.query.limit, 10) || 40 }) })));
  app.post(`${B}/scan`, route(async (req, res) => res.json(await scanResearch({ translate: req.body?.translate !== false, trigger: 'api' }))));
  app.post(`${B}/rescore`, route((_req, res) => res.json(rescoreAll())));
  app.post(`${B}/translate`, route(async (req, res) => res.json(req.body?.itemId ? await translateItem(String(req.body.itemId)) : await translateTop({ max: Math.min(10, Math.max(1, parseInt(req.body?.max, 10) || MAX_TRANSLATE)) }))));
}
