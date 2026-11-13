/**
 * What the goal engine is shown: the system's real problems and Vaughn's projects — never its own filing labels.
 *
 * Why (2026-11-13): the engine was shown memory category names with counts and confidence as "knowledge domains"
 * plus its own past chain objectives, and told to "fill knowledge gaps" and be "cross-domain". 2,108 of 2,719 goals in a
 * week (78 %) named a category as their subject ("unify 'world', 'dream' and 'neurogenesis_seed'", "the evolutionary
 * origin of 'world'", "the causal influence of 'dream_duplicate'") and the rest did the same with categories since
 * emptied; 1,256 agent runs went to them, and the local quality judge scored them higher than other work.
 *
 * Every item here has an id the model must cite (P1… for problems, a project id for projects), and checkObjective()
 * refuses an objective that cites nothing real or makes a memory label its subject.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';

export const PROJECTS_FILE = join(DATA_DIR, 'projects.json');

// Starting list, written once to data/projects.json; Vaughn edits that file (or PUT /api/goal-engine/projects).
export const DEFAULT_PROJECTS = [
  { id: 'stream', name: 'Live stream and Sovereign Emotes', aim: 'Living Artifact emotes minted from stream moments, shown on the OBS overlay, narrated in Vaughn\'s voice.',
    where: 'server/streaming/, server/intelligence/narrator.js, /streaming/overlay', check: 'POST /api/streaming/simulate-donation mints and verifies an artifact; the overlay shows it; narration lines reach the Audio shelf.' },
  { id: 'store', name: 'Shopify and Printify store', aim: 'A store that sells: products, listings and fixes found by the mystery shopper.',
    where: 'server/commerce/', check: 'mystery shopper grade and findings; anything that changes the live store needs Vaughn\'s approval.' },
  { id: 'studio', name: 'Media studio (Make, looks, avatars)', aim: 'Type a sentence, get a film, still, page or avatar that is right the first time.',
    where: 'server/media/ (make.js, flat/, looks/), fraymus-home worker', check: 'creation jobs complete; the film checks pass; a person can watch the result without errors.' },
  { id: 'hive', name: 'Hive and mesh', aim: 'Chandra, the Pi and the other agents talking reliably over fmp1 and the fraymus-bridge.',
    where: 'server/intelligence/hive-mesh.js, fmp1-node.js, hive-peers.js', check: 'fmp1 neighbour is bidirectional; digests post; messages arrive in both directions.' },
  { id: 'fraynix', name: 'FRAYNIX continuity', aim: 'FRAYNIX saves, verifies and recalls its own state.',
    where: 'H:/FRAYNIX-CONTINUITY, server/fraynix/continuity-tools.js', check: 'fraynix.verify passes on the newest plasmid; recall answers questions about stored knowledge.' },
];

export function loadProjects() {
  try {
    if (!existsSync(PROJECTS_FILE)) writeFileSync(PROJECTS_FILE, JSON.stringify(DEFAULT_PROJECTS, null, 2));
    const list = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter(p => p && typeof p.id === 'string' && p.name) : DEFAULT_PROJECTS;
  } catch (e) { console.error('[goal-landscape] projects:', e.message); return DEFAULT_PROJECTS; }
}

export function saveProjects(list) {
  if (!Array.isArray(list) || !list.length) throw Object.assign(new Error('projects must be a non-empty array'), { status: 400 });
  const clean = list.map(p => ({ id: String(p.id || '').replace(/[^\w-]/g, '').slice(0, 30), name: String(p.name || '').slice(0, 120),
    aim: String(p.aim || '').slice(0, 400), where: String(p.where || '').slice(0, 300), check: String(p.check || '').slice(0, 400) }))
    .filter(p => p.id && p.name);
  if (!clean.length) throw Object.assign(new Error('each project needs an id and a name'), { status: 400 });
  writeFileSync(PROJECTS_FILE, JSON.stringify(clean, null, 2));
  return clean;
}

// failures that are not a problem an agent can work on: restarts and cancellations
const NOT_A_PROBLEM = /interrupted by restart|^aborted$|swept: interrupted/i;

/** Real, checkable problems, each with an id the model must cite. */
export function realProblems(db, { now = Date.now() } = {}) {
  const q = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return []; } };
  const out = [];
  const add = (kind, text, check) => out.push({ id: `P${out.length + 1}`, kind, text, check });

  for (const f of q(`SELECT severity, check_name, summary FROM self_audit_findings WHERE resolved_at IS NULL AND severity IN ('BLOCKING','REAL') ORDER BY CASE severity WHEN 'BLOCKING' THEN 0 ELSE 1 END, last_seen DESC LIMIT 4`))
    add('self_audit', `${f.severity} self-audit finding (${f.check_name}): ${String(f.summary).slice(0, 160)}`, 'the finding resolves on the next audit');

  for (const e of q(`SELECT substr(error, 1, 160) AS e, COUNT(*) AS c FROM runs WHERE status = 'error' AND updated_at > ? GROUP BY substr(error, 1, 60) ORDER BY c DESC LIMIT 6`, now - 86400_000)
    .filter(e => e.e && !NOT_A_PROBLEM.test(e.e)).slice(0, 3))
    add('run_failure', `${e.c} agent run(s) failed in 24 h with: ${e.e}`, 'the same error does not recur in the next 24 h');

  const fam = {};
  for (const r of q(`SELECT by_family FROM capability_runs WHERE status = 'completed' AND strategy_mode = 'auto' ORDER BY completed_at DESC LIMIT 8`)) {
    let bf = {}; try { bf = JSON.parse(r.by_family || '{}'); } catch { /* skip a bad row */ }
    for (const [k, v] of Object.entries(bf)) { const p = fam[k] || (fam[k] = { n: 0, c: 0 }); p.n += (v.n || 0) - (v.skipped || 0); p.c += v.correct || 0; }
  }
  for (const [k, p] of Object.entries(fam).filter(([, p]) => p.n >= 6 && p.c / p.n < 0.7).sort((a, b) => a[1].c / a[1].n - b[1].c / b[1].n).slice(0, 2))
    add('capability', `capability gauge: ${k} problems solved ${Math.round((100 * p.c) / p.n)} % of ${p.n} recent items`, `the ${k} family scores higher on fresh seeds in the next benchmark`);

  for (const c of q(`SELECT title, target_file, substr(failure, 1, 140) AS failure FROM smk_code_proposals WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 2`))
    add('code', `a tested code change failed: "${String(c.title).slice(0, 90)}" in ${c.target_file} — ${c.failure || 'no reason recorded'}`, 'a corrected change passes its tests on a branch');

  for (const r of q(`SELECT title, topic FROM research_items WHERE status = 'new' AND relevance >= 0.5 ORDER BY relevance DESC LIMIT 2`))
    add('research', `unread relevant research (${r.topic}): "${String(r.title).slice(0, 110)}"`, 'translated into an experiment, a code sketch or an honest "none"');

  for (const j of q(`SELECT request, substr(error, 1, 120) AS error FROM creation_jobs WHERE status = 'error' AND created_at > ? ORDER BY created_at DESC LIMIT 2`, now - 7 * 86400_000))
    add('studio', `a Make job failed: "${String(j.request).slice(0, 80)}" — ${j.error}`, 'the same request completes');

  return out;
}

export function memoryCategories(db) {
  try { return db.prepare(`SELECT DISTINCT category FROM agent_memories`).all().map(r => r.category).filter(Boolean); }
  catch { return []; }
}

const LABEL_TALK = /\bcategor(y|ies)\b|low-confidence (area|data)|knowledge domains?|mediator-aware|cross-domain (synthesis|model|evolutionary)|evolutionary (origin|model)|fossil (data|insights)/i;

// Same job in other words: word-set overlap of the objectives without filler. Exact-text dedup let the same
// "model llama3.2:3b not found" goal back in three batches running.
const FILLER = new Set('the a an and or of to in on for with by is be it that this from into as at related investigate resolve fix'.split(' '));
const words = s => new Set(String(s).toLowerCase().replace(/\(done when:.*$/s, '').match(/[a-z0-9.:_-]+/g)?.filter(w => !FILLER.has(w) && w.length > 2) || []);
export function sameJob(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.5;
}

/** Refuse an objective that cites nothing real or makes the system's own memory labels its subject. */
export function checkObjective(p, { problems = [], projects = [], categories = [] } = {}) {
  const objective = String(p?.objective || '').trim();
  if (objective.length < 25) return { ok: false, reason: 'too short to act on' };
  const ids = new Set([...problems.map(x => x.id), ...projects.map(x => x.id)]);
  const ref = String(p?.grounded_in || '').trim();
  if (!ids.has(ref)) return { ok: false, reason: ref ? `cites "${ref}", which is not a listed problem or project` : 'cites no problem or project' };
  if (LABEL_TALK.test(objective)) return { ok: false, reason: 'talks about memory categories / knowledge domains instead of a real problem' };
  const quoted = (objective.match(/['"‘“]([\w-]+)['"’”]/g) || []).map(s => s.slice(1, -1).toLowerCase());
  const label = quoted.find(w => categories.map(c => c.toLowerCase()).includes(w));
  if (label) return { ok: false, reason: `makes the memory label '${label}' its subject` };
  const doneWhen = String(p?.done_when || '').trim();
  if (doneWhen.length < 10) return { ok: false, reason: 'says no way to check it is done' };
  return { ok: true, objective, ref, doneWhen };
}
