/**
 * REA Protocol — Reverse Engineer Anything, evidence-first, 8 stages.
 *
 * Absorbed 2026-11-09 from Vaughn's looseScrew spec. The spec's eight stages are the right
 * shape; what the demo lacked was anything that could fail. Here every stage is bound to
 * evidence the CODE collected, and only an executed check can earn PROVEN:
 *
 *   1 Target Scoping        5 Evidence Collection
 *   2 Setup & Readiness     6 Reconstruction
 *   3 Surface Mapping       7 Verification   ← runs real checks in the verifier sandbox
 *   4 Feature Tracing       8 Final Report
 *
 * Facts come from deterministic collectors (file walk, exports/imports, hashes, grep hits,
 * HTTP headers, link/script hosts) and are numbered F1…Fn. The LLM may only make claims
 * that cite fact ids; a claim with valid citations is LIKELY, without them UNVERIFIED, and
 * the model is forbidden from writing PROVEN at all. Stage 7 asks for up to three
 * standalone Node checks (built-ins only) that print PASS/FAIL against the target; a PASS
 * promotes the claim it tests to PROVEN. The run's confidence is the best label any claim
 * earned honestly. Results go to rea_runs / rea_evidence, a markdown report under
 * data/rea/, a `binary_dossier` memory for the RE Analyst (the store was empty), and the
 * bus. Targets: a local path under REA_ROOTS, a public URL, or pasted text.
 */

import { randomUUID, createHash } from 'node:crypto';
import { statSync, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import { requestPublicPage } from '../web/request.js';
import { executeCode, nonBuiltinImports } from './verifier-loop.js';
import { PROJECT_ROOT, DATA_DIR } from '../config.js';

const now = () => Date.now();
const RE_AGENT_ID = 're-analyst';
const MAX_FILES = 400, MAX_HASHES = 60, MAX_HITS = 80, MAX_FACTS = 160, MAX_CHECKS = 3;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.py', '.java', '.html', '.css', '.yml', '.yaml', '.toml', '.txt', '.sh', '.ps1', '.sql', '.c', '.h', '.cpp', '.rs', '.go']);
const ROOTS = (process.env.REA_ROOTS || `${PROJECT_ROOT},F:/Claude-Work,F:/Fraymus-Skill-Lab`).split(',').map(s => resolve(s.trim())).filter(Boolean);
const LABEL_CONF = { PROVEN: 1.0, LIKELY: 0.6, UNVERIFIED: 0.3 };

export const STAGES = [
  { key: 'target_scoping', n: 1, title: 'Target Scoping', ask: 'State precisely what the target is, what kind of artifact, which feature or question is in scope, and what is explicitly out of scope. Name the risks of misreading it.' },
  { key: 'setup_readiness', n: 2, title: 'Setup & Readiness', ask: 'From the facts, state what is reachable and readable, what limits apply (size, access, missing tools), and what cannot be inspected from here.' },
  { key: 'surface_mapping', n: 3, title: 'Surface Mapping', ask: 'Map the surface: the modules/files/pages/endpoints that exist, their sizes and roles, the public exports or visible interfaces, and the dependency edges you can see.' },
  { key: 'feature_tracing', n: 4, title: 'Feature Tracing', ask: 'Trace the in-scope feature from its entry points to its core logic using the hit facts: which file/function handles what, in what order, and where data crosses a boundary.' },
  { key: 'evidence_collection', n: 5, title: 'Evidence Collection', ask: 'Pin the hard facts the rebuild depends on: hashes, counts, signatures, versions, dependencies, formats. Anything a rebuild must reproduce exactly.' },
  { key: 'reconstruction', n: 6, title: 'Reconstruction', ask: 'Describe a clean-room rebuild of the feature: components, interfaces, data flow, and the order to build them. Mark which parts you would implement differently and why.' },
  { key: 'verification', n: 7, title: 'Verification', ask: 'Executable checks.' },
  { key: 'final_report', n: 8, title: 'Final Report', ask: 'Report.' },
];

function ensureSchema() {
  db.prepare(`CREATE TABLE IF NOT EXISTS rea_runs (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    target_type TEXT NOT NULL,
    feature TEXT,
    question TEXT,
    agent_id TEXT,
    trigger TEXT,
    status TEXT NOT NULL,
    current_stage TEXT,
    fact_count INTEGER DEFAULT 0,
    claim_count INTEGER DEFAULT 0,
    proven INTEGER DEFAULT 0,
    likely INTEGER DEFAULT 0,
    unverified INTEGER DEFAULT 0,
    confidence_label TEXT,
    report_path TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS rea_evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    kind TEXT NOT NULL,
    claim TEXT,
    fact_ids TEXT,
    label TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_rea_evidence_run ON rea_evidence(run_id, created_at)`).run();
}
try { ensureSchema(); } catch (e) { console.error('[rea] schema:', e.message); }

const sha = s => createHash('sha256').update(s).digest('hex');
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clipKeepLines = (s, n) => String(s ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const words = s => new Set(String(s).toLowerCase().match(/[a-z0-9_$]{3,}/g) || []);
function similar(a, b) { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let i = 0; for (const w of A) if (B.has(w)) i++; return i / (A.size + B.size - i); }

// ─── Deterministic fact collectors ──────────────────────────────

function insideRoots(p) { const r = resolve(p); return ROOTS.some(root => r === root || r.startsWith(root + sep)); }

function walk(dir, out, depth = 0) {
  if (depth > 4 || out.length >= MAX_FILES) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), out, depth + 1); }
    else if (e.isFile()) out.push(join(dir, e.name));
  }
}

function collectPathFacts(target, feature) {
  const facts = [];
  const add = (kind, text, data) => addFact(facts, kind, text, data);
  const abs = resolve(target);
  if (!insideRoots(abs)) throw Object.assign(new Error(`path is outside REA_ROOTS (${ROOTS.join(', ')})`), { status: 400 });
  if (!existsSync(abs)) throw Object.assign(new Error('path does not exist'), { status: 404 });
  const st = statSync(abs);
  const files = [];
  if (st.isDirectory()) walk(abs, files); else files.push(abs);
  add('stat', `${st.isDirectory() ? 'directory' : 'file'} ${abs}; ${files.length} file(s) considered${files.length >= MAX_FILES ? ' (capped)' : ''}`, { files: files.length, directory: st.isDirectory() });
  const byExt = {};
  let totalLines = 0, hashed = 0;
  const exportsByFile = {}, importEdges = [], hits = [];
  const featRe = feature ? new RegExp(feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    byExt[ext || '(none)'] = (byExt[ext || '(none)'] || 0) + 1;
    let fst; try { fst = statSync(f); } catch (_) { continue; }
    const rel = relative(st.isDirectory() ? abs : resolve(abs, '..'), f) || f;
    if (!TEXT_EXT.has(ext) || fst.size > 512 * 1024) { if (hashed < MAX_HASHES) { try { add('hash', `${rel} sha256=${sha(readFileSync(f))} bytes=${fst.size}`, { file: rel, bytes: fst.size }); hashed++; } catch (_) {} } continue; }
    let text; try { text = readFileSync(f, 'utf8'); } catch (_) { continue; }
    const lines = text.split('\n');
    totalLines += lines.length;
    if (hashed < MAX_HASHES) { add('hash', `${rel} sha256=${sha(text)} bytes=${fst.size} lines=${lines.length}`, { file: rel, bytes: fst.size, lines: lines.length }); hashed++; }
    const exps = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class|default)\s+([A-Za-z_$][\w$]*)?/gm)].map(m => m[1] || 'default').filter(Boolean);
    if (exps.length) exportsByFile[rel] = exps.slice(0, 40);
    for (const m of text.matchAll(/(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g)) importEdges.push([rel, m[1]]);
    if (featRe) for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) if (featRe.test(lines[i])) hits.push({ file: rel, line: i + 1, text: clip(lines[i], 160), context: lines.slice(Math.max(0, i - 3), i + 4).map((l, k) => `${Math.max(0, i - 3) + k + 1}: ${l}`).join('\n') });
    // Single files (or small trees) get their internal structure: top-level symbols with line
    // numbers and the header comment. Without these a one-file target yields ~7 facts and the
    // model repeats itself; the first live run claimed "no concurrency limit" two lines from MAX_CONCURRENT.
    if (files.length <= 12) {
      const symbols = [];
      for (let i = 0; i < lines.length && symbols.length < 60; i++) {
        const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|class\s+([A-Za-z_$][\w$]*))/);
        if (m) symbols.push(`${m[1] || m[2] || m[3]}@${i + 1}`);
      }
      if (symbols.length) add('symbol', `${rel} top-level symbols (name@line): ${symbols.join(' ')}`, { file: rel, symbols });
      const header = text.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
      if (header) add('doc', `${rel} header: ${clip(header[1].replace(/^\s*\*\s?/gm, ''), 400)}`, { file: rel });
      const consts = [...text.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*([^;\n]{1,80})/gm)].slice(0, 25).map(m => `${m[1]}=${clip(m[2], 60)}`);
      if (consts.length) add('const', `${rel} constants: ${consts.join('; ')}`, { file: rel, consts });
    }
  }
  add('stat', `extensions: ${Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(' ')}; total text lines ${totalLines}`, { byExt, totalLines });
  for (const [file, exps] of Object.entries(exportsByFile).slice(0, 40)) add('export', `${file} exports: ${exps.join(', ')}`, { file, exports: exps });
  const extDeps = {};
  for (const [file, spec] of importEdges) { if (!spec.startsWith('.') && !spec.startsWith('node:')) extDeps[spec] = (extDeps[spec] || 0) + 1; }
  if (Object.keys(extDeps).length) add('dep', `external imports: ${Object.entries(extDeps).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}(${v})`).join(' ')}`, { extDeps });
  const internal = importEdges.filter(([, s]) => s.startsWith('.')).slice(0, 60);
  if (internal.length) add('import', `internal edges (file → module): ${internal.map(([f, s]) => `${f}→${s}`).join('; ')}`, { edges: internal });
  const pkg = files.find(f => /package\.json$/.test(f));
  if (pkg) { try { const p = JSON.parse(readFileSync(pkg, 'utf8')); add('dep', `package.json name=${p.name} version=${p.version} deps=${Object.keys(p.dependencies || {}).length} devDeps=${Object.keys(p.devDependencies || {}).length} scripts=${Object.keys(p.scripts || {}).join(',')}`, { name: p.name, version: p.version, dependencies: Object.keys(p.dependencies || {}) }); } catch (_) {} }
  for (const h of hits) add('hit', `${h.file}:${h.line}  ${h.text}`, { file: h.file, line: h.line });
  for (const h of hits.slice(0, 4)) if (h.context) add('snippet', `${h.file} around line ${h.line}:\n${h.context}`, { file: h.file, line: h.line });
  if (featRe && !hits.length) add('hit', `no occurrences of "${feature}" in the considered files`, { feature, hits: 0 });
  return { facts, targetPath: abs, kind: st.isDirectory() ? 'directory' : 'file' };
}

async function collectUrlFacts(target, feature) {
  const facts = [];
  const add = (kind, text, data) => { if (facts.length < MAX_FACTS) facts.push({ id: `F${facts.length + 1}`, kind, text: clip(text, 220), data }); };
  const page = await requestPublicPage(target, { timeoutMs: 15_000 });
  const text = String(page.text || '');
  add('http', `GET ${page.url} → ${page.status} ${page.contentType}; ${page.bytes ?? Buffer.byteLength(text)} bytes; sha256=${sha(text)}`, { status: page.status, contentType: page.contentType, redirect: page.redirect });
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) add('surface', `title: ${clip(title, 160)}`, { title: clip(title, 160) });
  const desc = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1];
  if (desc) add('surface', `meta description: ${clip(desc, 200)}`, {});
  const scripts = [...text.matchAll(/<script[^>]+src=["']([^"']+)/gi)].map(m => m[1]);
  const inlineScripts = (text.match(/<script(?![^>]*src=)[^>]*>/gi) || []).length;
  add('surface', `scripts: ${scripts.length} external (${[...new Set(scripts.map(s => { try { return new URL(s, page.url).hostname; } catch { return s.slice(0, 40); } }))].slice(0, 10).join(', ')}), ${inlineScripts} inline`, { scripts: scripts.slice(0, 40), inlineScripts });
  const links = [...text.matchAll(/<a[^>]+href=["']([^"'#]+)/gi)].map(m => m[1]);
  const hosts = {};
  for (const l of links) { try { const h = new URL(l, page.url).hostname; hosts[h] = (hosts[h] || 0) + 1; } catch (_) {} }
  add('surface', `links: ${links.length}; hosts: ${Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([h, n]) => `${h}(${n})`).join(' ')}`, { links: links.length, hosts });
  add('surface', `forms: ${(text.match(/<form\b/gi) || []).length}; iframes: ${(text.match(/<iframe\b/gi) || []).length}; images: ${(text.match(/<img\b/gi) || []).length}`, {});
  if (feature) {
    const re = new RegExp(feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const lines = text.split('\n'); let n = 0;
    for (let i = 0; i < lines.length && n < MAX_HITS; i++) if (re.test(lines[i])) { add('hit', `line ${i + 1}: ${clip(lines[i].replace(/<[^>]+>/g, ' '), 160)}`, { line: i + 1 }); n++; }
    if (!n) add('hit', `no occurrences of "${feature}" in the page`, { feature, hits: 0 });
  }
  return { facts, text, kind: 'url' };
}

function collectTextFacts(target, feature) {
  const facts = [];
  const add = (kind, text, data) => { if (facts.length < MAX_FACTS) facts.push({ id: `F${facts.length + 1}`, kind, text: clip(text, 220), data }); };
  const text = String(target);
  const lines = text.split('\n');
  add('stat', `text: ${text.length} chars, ${lines.length} lines, sha256=${sha(text)}`, { chars: text.length, lines: lines.length });
  const headings = lines.filter(l => /^\s{0,3}#{1,6}\s|^[A-Z][A-Za-z &/-]{3,60}:$/.test(l)).slice(0, 30);
  if (headings.length) add('surface', `headings: ${headings.map(h => clip(h, 60)).join(' | ')}`, { headings });
  const urls = [...new Set(text.match(/https?:\/\/[^\s)"'<>]+/g) || [])].slice(0, 30);
  if (urls.length) add('surface', `urls: ${urls.join(' ')}`, { urls });
  const fences = text.match(/```(\w+)?/g) || [];
  if (fences.length) add('surface', `code blocks: ${Math.floor(fences.length / 2)} (${[...new Set(fences.map(f => f.slice(3)).filter(Boolean))].join(',')})`, {});
  if (feature) {
    const re = new RegExp(feature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); let n = 0;
    for (let i = 0; i < lines.length && n < MAX_HITS; i++) if (re.test(lines[i])) { add('hit', `line ${i + 1}: ${clip(lines[i], 160)}`, { line: i + 1 }); n++; }
    if (!n) add('hit', `no occurrences of "${feature}"`, { feature, hits: 0 });
  }
  return { facts, text, kind: 'text' };
}

// ─── Stage reasoning (LLM bound to facts) ───────────────────────

const STAGE_SYSTEM = `You are executing one stage of the REA protocol (Reverse Engineer Anything), evidence-first.
Rules you cannot break:
- Every claim must cite fact ids from the FACTS list (e.g. ["F3","F17"]). A claim with no supporting fact is allowed only if labelled UNVERIFIED.
- Labels you may use: LIKELY (supported by the cited facts) or UNVERIFIED (inference). NEVER write PROVEN — only an executed check earns that, later.
- Be concrete: names, numbers, paths, counts from the facts. No generalities, no filler, no restating the stage.
- Do NOT repeat a claim already made in an earlier stage (they are listed). Each stage adds NEW claims specific to its question; if the facts do not support anything new for this stage, return fewer claims.
- If a fact contradicts an earlier claim, say so in a new claim that cites both.
- 2 to 8 claims. One short summary sentence.
Output JSON only: {"claims":[{"claim":"...","factIds":["F1"],"label":"LIKELY"}],"summary":"..."}`;

function factsBlock(facts) { return facts.map(f => `${f.id} [${f.kind}] ${f.text}`).join('\n'); }
// snippet facts keep their newlines (code context); everything else is one line
function addFact(facts, kind, text, data) { if (facts.length < MAX_FACTS) facts.push({ id: `F${facts.length + 1}`, kind, text: kind === 'snippet' ? clipKeepLines(text, 700) : clip(text, 220), data }); }

async function reasonStage(stage, ctx, priority) {
  const prior = ctx.claims.length ? `\nCLAIMS FROM EARLIER STAGES (cite, build on, or contradict them):\n${ctx.claims.slice(-24).map(c => `- (${c.stage}, ${c.label}) ${c.claim} [${c.factIds.join(',')}]`).join('\n')}` : '';
  const user = `TARGET: ${ctx.targetLabel} (${ctx.kind})${ctx.feature ? `\nFEATURE IN SCOPE: ${ctx.feature}` : ''}${ctx.question ? `\nQUESTION: ${ctx.question}` : ''}\n\nSTAGE ${stage.n}/8 — ${stage.title}: ${stage.ask}\n\nFACTS:\n${factsBlock(ctx.facts)}${prior}`;
  const raw = await chatOllama([{ role: 'system', content: STAGE_SYSTEM }, { role: 'user', content: user }], { temperature: 0.2, format: 'json', maxTokens: 1200, priority, label: `rea:${stage.key}` });
  const parsed = parseJSON(raw);
  const valid = new Set(ctx.facts.map(f => f.id));
  let duplicates = 0;
  const claims = (Array.isArray(parsed?.claims) ? parsed.claims : []).slice(0, 8).map(c => {
    const factIds = (Array.isArray(c.factIds) ? c.factIds : []).map(String).filter(id => valid.has(id)).slice(0, 8);
    return { stage: stage.key, claim: clip(c.claim, 400), factIds, label: factIds.length ? 'LIKELY' : 'UNVERIFIED' }; // PROVEN is never accepted from the model
  }).filter(c => c.claim).filter(c => {
    // a restatement of an earlier claim is not evidence — drop it (Jaccard ≥ 0.75 on word sets)
    if (ctx.claims.some(p => similar(p.claim, c.claim) >= 0.75)) { duplicates++; return false; }
    return true;
  });
  return { claims, duplicates, summary: clip(parsed?.summary, 300) || '' };
}

const CHECK_SYSTEM = `You write verification checks for the REA protocol. For up to ${MAX_CHECKS} of the LIKELY claims, write a standalone Node.js ES module that tests the claim against the target and prints exactly "PASS" or "FAIL" as its LAST line (one earlier line may explain why).
Rules: import only node: built-ins (node:fs, node:path, node:crypto, …). The constant TARGET (absolute path of the target file/directory, or of a file holding the fetched page/text) is ALREADY defined at the top of your module — do not redeclare it. Every check MUST read from TARGET (readFileSync / readdirSync / statSync) and MUST end with console.log('PASS') or console.log('FAIL'). Never write, never use the network, never define stubs or placeholder functions. Keep each check under 40 lines and deterministic.
A check is a real test of the claim against the artifact, like:
  import { readFileSync } from 'node:fs';
  const src = readFileSync(TARGET, 'utf8');
  const hasExport = /export\\s+async\\s+function\\s+withOllama\\s*\\(/.test(src);
  const hasLimit = /MAX_CONCURRENT\\s*=/.test(src);
  console.log(hasExport && hasLimit ? 'PASS' : 'FAIL');
Output JSON only: {"checks":[{"claimIndex":0,"title":"...","code":"..."}]}`;

async function verificationStage(ctx, priority) {
  const candidates = ctx.claims.map((c, i) => ({ ...c, i })).filter(c => c.label === 'LIKELY').slice(-12);
  if (!candidates.length) return { checks: [], note: 'no LIKELY claims to verify' };
  const user = `TARGET kind: ${ctx.kind}. TARGET path: ${ctx.checkTarget}\n\nFACTS:\n${factsBlock(ctx.facts)}\n\nCLAIMS (index: claim):\n${candidates.map(c => `${c.i}: ${c.claim} [${c.factIds.join(',')}]`).join('\n')}`;
  const raw = await chatOllama([{ role: 'system', content: CHECK_SYSTEM }, { role: 'user', content: user }], { temperature: 0.1, format: 'json', maxTokens: 1800, priority, label: 'rea:verification' });
  const parsed = parseJSON(raw);
  const checks = (Array.isArray(parsed?.checks) ? parsed.checks : []).slice(0, MAX_CHECKS);
  const results = [];
  for (const ch of checks) {
    const idx = Number(ch.claimIndex);
    const claim = ctx.claims[idx];
    const code = String(ch.code || '');
    const entry = { claimIndex: idx, title: clip(ch.title, 120), claim: claim?.claim || null, passed: false, output: '', code: code.slice(0, 4000) };
    if (!claim || !code.trim()) { entry.output = 'invalid check (no claim or no code)'; results.push(entry); continue; }
    const deps = nonBuiltinImports(code, 'javascript');
    if (deps.length) { entry.output = `rejected: non-builtin imports ${deps.join(', ')}`; results.push(entry); continue; }
    if (/\b(fetch|http\.|https\.|net\.|child_process|writeFile|unlink|rm\b|mkdir)/.test(code)) { entry.output = 'rejected: network or write access in a check'; results.push(entry); continue; }
    if (!/\bTARGET\b/.test(code) || !/['"]PASS['"]/.test(code)) { entry.output = 'rejected: a check must read TARGET and print PASS/FAIL (this one is a stub)'; results.push(entry); continue; }
    // Standard prelude: the second live run failed every check because the model used
    // readFileSync / fs.statSync without importing them. Provide the built-ins it will reach
    // for and drop its own imports of those modules so nothing is declared twice.
    const prelude = `import * as fs from 'node:fs';\nimport * as path from 'node:path';\nimport * as crypto from 'node:crypto';\nconst { readFileSync, readdirSync, statSync, existsSync } = fs;\nconst { createHash } = crypto;\nconst TARGET = ${JSON.stringify(ctx.checkTarget)};\n`;
    const body = code
      .replace(/^\s*const\s+TARGET\s*=.*$/m, '')
      .replace(/^\s*import\s+[^;\n]*?from\s+['"]node:(?:fs|path|crypto)['"];?\s*$/gm, '')
      .replace(/^\s*import\s+[^;\n]*?from\s+['"](?:fs|path|crypto)['"];?\s*$/gm, '')
      .replace(/^\s*const\s+\{[^}]*\}\s*=\s*(?:fs|path|crypto)\s*;?\s*$/gm, '');
    try {
      const r = await executeCode(prelude + body, 'javascript');
      const lines = String(r.stdout || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      entry.passed = r.exitCode === 0 && /^PASS\b/.test(last);
      entry.output = clip((r.stdout || '(no output)') + (r.stderr ? `\nstderr: ${r.stderr}` : '') + (r.exitCode ? `\nexit ${r.exitCode}` : ''), 600);
      if (entry.passed) claim.label = 'PROVEN';
    } catch (e) { entry.output = `execution error: ${e.message.slice(0, 200)}`; }
    results.push(entry);
  }
  return { checks: results };
}

function buildReport(ctx, run) {
  const by = l => ctx.claims.filter(c => c.label === l);
  const lines = [
    `# REA report — ${ctx.targetLabel}`,
    '',
    `Run ${run.id} · ${ctx.kind} · ${new Date(run.started_at).toISOString()} · trigger ${run.trigger} · agent ${run.agent_id || 'operator'}`,
    ctx.feature ? `Feature in scope: **${ctx.feature}**` : '',
    ctx.question ? `Question: ${ctx.question}` : '',
    '',
    `**Confidence: ${run.confidence_label}** — ${by('PROVEN').length} PROVEN (executed checks passed), ${by('LIKELY').length} LIKELY (fact-backed), ${by('UNVERIFIED').length} UNVERIFIED (inference). ${ctx.facts.length} facts collected.`,
    '',
    ...STAGES.filter(s => s.n <= 6).map(s => {
      const cs = ctx.claims.filter(c => c.stage === s.key);
      return [`## ${s.n}. ${s.title}`, ctx.summaries[s.key] ? `_${ctx.summaries[s.key]}_` : '', ...(cs.length ? cs.map(c => `- **${c.label}** ${c.claim} _(${c.factIds.join(', ') || 'no facts'})_`) : ['- no claims']), ''].join('\n');
    }),
    '## 7. Verification',
    ...(ctx.checks.length ? ctx.checks.map(c => `- ${c.passed ? '✅ PASS' : '❌ FAIL'} **${c.title}** → claim: ${c.claim || '?'}\n  \`\`\`\n  ${c.output.replace(/\n/g, '\n  ')}\n  \`\`\``) : [`- ${ctx.verificationNote || 'no checks executed'}`]),
    '',
    '## 8. Final Report',
    `The ${ctx.kind} "${ctx.targetLabel}" was mapped from ${ctx.facts.length} collected facts across ${STAGES.length} stages. ${by('PROVEN').length ? `${by('PROVEN').length} claim(s) were proven by executed checks.` : 'No claim reached PROVEN — nothing was executed successfully against the target, so treat every statement above as fact-backed inference at best.'}`,
    '',
    '### Facts (as collected, not interpreted)',
    ...ctx.facts.map(f => `- ${f.id} [${f.kind}] ${f.text}`),
    '',
  ];
  return lines.filter(l => l !== null && l !== undefined).join('\n');
}

// ─── Run ─────────────────────────────────────────────────────────

const running = new Map();

function evidence(runId, stage, kind, { claim = null, factIds = [], label = null, detail = null } = {}) {
  try {
    db.prepare(`INSERT INTO rea_evidence (id, run_id, stage, kind, claim, fact_ids, label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID().slice(0, 12), runId, stage, kind, claim, JSON.stringify(factIds), label, detail == null ? null : JSON.stringify(detail).slice(0, 8000), now());
  } catch (e) { console.error('[rea] evidence:', e.message); }
}

export function detectTargetType(target) {
  const t = String(target || '').trim();
  if (/^https?:\/\//i.test(t)) return 'url';
  if (/^[A-Za-z]:[\\/]|^\/|^\.{1,2}[\\/]/.test(t) && t.length < 600 && !/\n/.test(t)) return 'path';
  return 'text';
}

export async function runReaProtocol({ target, targetType = null, feature = null, question = null, agentId = null, trigger = 'api', priority = 'agent_run' } = {}) {
  if (!target || typeof target !== 'string') throw Object.assign(new Error('target required'), { status: 400 });
  const type = targetType || detectTargetType(target);
  const id = 'rea_' + randomUUID().replace(/-/g, '').slice(0, 10);
  const startedAt = now();
  const targetLabel = type === 'text' ? `pasted text (${target.length} chars)` : target.slice(0, 300);
  db.prepare(`INSERT INTO rea_runs (id, target, target_type, feature, question, agent_id, trigger, status, current_stage, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
    .run(id, targetLabel, type, feature ? String(feature).slice(0, 200) : null, question ? String(question).slice(0, 500) : null, agentId, trigger, STAGES[0].key, startedAt);
  const ctx = { id, kind: type, targetLabel, feature: feature ? String(feature).slice(0, 200) : null, question: question ? String(question).slice(0, 500) : null, facts: [], claims: [], summaries: {}, checks: [], checkTarget: null };
  running.set(id, ctx);
  const setStage = key => { try { db.prepare(`UPDATE rea_runs SET current_stage = ? WHERE id = ?`).run(key, id); } catch (_) {} };
  try {
    // Facts first — stages 1–6 reason over them; nothing is asked of the model before the code has looked.
    let collected;
    if (type === 'path') collected = collectPathFacts(target, ctx.feature);
    else if (type === 'url') collected = await collectUrlFacts(target, ctx.feature);
    else collected = collectTextFacts(target, ctx.feature);
    ctx.facts = collected.facts;
    if (type === 'path') ctx.checkTarget = collected.targetPath;
    else { const dir = join(tmpdir(), 'chandra-rea'); mkdirSync(dir, { recursive: true }); ctx.checkTarget = join(dir, `${id}.${type === 'url' ? 'html' : 'txt'}`); writeFileSync(ctx.checkTarget, collected.text || '', 'utf8'); }
    for (const f of ctx.facts) evidence(id, 'evidence_collection', 'fact', { claim: f.text, label: 'MEASURED', detail: { factId: f.id, kind: f.kind, ...f.data } });
    db.prepare(`UPDATE rea_runs SET fact_count = ? WHERE id = ?`).run(ctx.facts.length, id);

    for (const stage of STAGES) {
      setStage(stage.key);
      if (stage.n <= 6) {
        const r = await reasonStage(stage, ctx, priority);
        ctx.summaries[stage.key] = r.summary + (r.duplicates ? ` (${r.duplicates} restated claim(s) dropped)` : '');
        for (const c of r.claims) { ctx.claims.push(c); evidence(id, stage.key, 'claim', { claim: c.claim, factIds: c.factIds, label: c.label }); }
      } else if (stage.key === 'verification') {
        const v = await verificationStage(ctx, priority);
        ctx.checks = v.checks || []; ctx.verificationNote = v.note || null;
        for (const c of ctx.checks) evidence(id, 'verification', 'check', { claim: c.claim, label: c.passed ? 'PROVEN' : 'FAILED', detail: { title: c.title, output: c.output, code: c.code } });
      }
    }
    const proven = ctx.claims.filter(c => c.label === 'PROVEN').length, likely = ctx.claims.filter(c => c.label === 'LIKELY').length, unverified = ctx.claims.filter(c => c.label === 'UNVERIFIED').length;
    const label = proven ? 'PROVEN' : (likely && likely >= unverified ? 'LIKELY' : 'UNVERIFIED');
    const finishedAt = now();
    const run = { id, started_at: startedAt, trigger, agent_id: agentId, confidence_label: label };
    const report = buildReport(ctx, run);
    const dir = join(DATA_DIR, 'rea'); mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, `${id}.md`); writeFileSync(reportPath, report, 'utf8');
    db.prepare(`UPDATE rea_runs SET status = 'completed', current_stage = 'final_report', claim_count = ?, proven = ?, likely = ?, unverified = ?, confidence_label = ?, report_path = ?, finished_at = ?, duration_ms = ? WHERE id = ?`)
      .run(ctx.claims.length, proven, likely, unverified, label, reportPath, finishedAt, finishedAt - startedAt, id);
    const summary = `REA ${label}: ${targetLabel}${ctx.feature ? ` / ${ctx.feature}` : ''} — ${ctx.facts.length} facts, ${ctx.claims.length} claims (${proven} proven, ${likely} likely, ${unverified} unverified), ${ctx.checks.filter(c => c.passed).length}/${ctx.checks.length} checks passed. Report ${reportPath}`;
    try { storeMemory(RE_AGENT_ID, 'binary_dossier', `rea:${id}`, JSON.stringify({ runId: id, target: targetLabel, type, feature: ctx.feature, label, facts: ctx.facts.length, claims: ctx.claims.length, proven, likely, unverified, report: reportPath, top: ctx.claims.filter(c => c.label !== 'UNVERIFIED').slice(0, 5).map(c => c.claim) }), { confidence: LABEL_CONF[label], source: 'rea-protocol' }); } catch (_) {}
    try { storeMemory('system', 'outcome', `rea:${id}`, summary, { confidence: LABEL_CONF[label], source: 'rea-protocol' }); } catch (_) {}
    try { publish('rea', 'system.re.rea.completed', JSON.stringify({ runId: id, target: targetLabel, type, label, facts: ctx.facts.length, claims: ctx.claims.length, proven, likely, unverified, trigger, agentId })); } catch (_) {}
    return { runId: id, status: 'completed', confidenceLabel: label, facts: ctx.facts.length, claims: ctx.claims.length, proven, likely, unverified, checks: ctx.checks.map(c => ({ title: c.title, passed: c.passed })), reportPath, durationMs: finishedAt - startedAt, summary };
  } catch (e) {
    db.prepare(`UPDATE rea_runs SET status = 'failed', error = ?, finished_at = ?, duration_ms = ? WHERE id = ?`).run(String(e.message).slice(0, 500), now(), now() - startedAt, id);
    throw e;
  } finally { running.delete(id); }
}

/**
 * Re-run stage 7 on a completed run (path targets, or url/text runs whose temp file still
 * exists): reload facts and claims from rea_evidence, execute fresh checks, promote claims
 * that pass, recompute the label and the report. Earlier checks stay in the evidence log.
 */
export async function reverifyReaRun(id, { priority = 'agent_run' } = {}) {
  const run = db.prepare(`SELECT * FROM rea_runs WHERE id = ?`).get(String(id || '').slice(0, 40));
  if (!run) throw Object.assign(new Error('run not found'), { status: 404 });
  if (run.status !== 'completed') throw Object.assign(new Error(`run is ${run.status}`), { status: 409 });
  const rows = db.prepare(`SELECT stage, kind, claim, fact_ids, label, detail FROM rea_evidence WHERE run_id = ? ORDER BY created_at ASC`).all(run.id);
  const facts = rows.filter(r => r.kind === 'fact').map(r => { const d = JSON.parse(r.detail || '{}'); return { id: d.factId, kind: d.kind, text: r.claim, data: d }; });
  const claims = rows.filter(r => r.kind === 'claim').map(r => ({ stage: r.stage, claim: r.claim, factIds: JSON.parse(r.fact_ids || '[]'), label: r.label === 'PROVEN' ? 'LIKELY' : r.label }));
  let checkTarget = null;
  if (run.target_type === 'path') checkTarget = resolve(run.target);
  else { const guess = join(tmpdir(), 'chandra-rea', `${run.id}.${run.target_type === 'url' ? 'html' : 'txt'}`); if (existsSync(guess)) checkTarget = guess; }
  if (!checkTarget || !existsSync(checkTarget)) throw Object.assign(new Error('target no longer available for checks'), { status: 409 });
  const ctx = { id: run.id, kind: run.target_type, targetLabel: run.target, feature: run.feature, question: run.question, facts, claims, summaries: {}, checks: [], checkTarget };
  const v = await verificationStage(ctx, priority);
  ctx.checks = v.checks || []; ctx.verificationNote = v.note || null;
  for (const c of ctx.checks) evidence(run.id, 'verification', 'check', { claim: c.claim, label: c.passed ? 'PROVEN' : 'FAILED', detail: { title: c.title, output: c.output, code: c.code, reverify: true } });
  // claims promoted in ctx.claims — persist the new labels on the matching claim rows
  for (const c of ctx.claims.filter(c => c.label === 'PROVEN')) {
    try { db.prepare(`UPDATE rea_evidence SET label = 'PROVEN' WHERE run_id = ? AND kind = 'claim' AND claim = ?`).run(run.id, c.claim); } catch (_) {}
  }
  const proven = ctx.claims.filter(c => c.label === 'PROVEN').length, likely = ctx.claims.filter(c => c.label === 'LIKELY').length, unverified = ctx.claims.filter(c => c.label === 'UNVERIFIED').length;
  const label = proven ? 'PROVEN' : (likely && likely >= unverified ? 'LIKELY' : 'UNVERIFIED');
  const report = buildReport(ctx, { ...run, confidence_label: label });
  if (run.report_path) { try { writeFileSync(run.report_path, report, 'utf8'); } catch (_) {} }
  db.prepare(`UPDATE rea_runs SET proven = ?, likely = ?, unverified = ?, confidence_label = ? WHERE id = ?`).run(proven, likely, unverified, label, run.id);
  try { db.prepare(`UPDATE agent_memories SET confidence = ? WHERE agent_id = ? AND key = ?`).run(LABEL_CONF[label], RE_AGENT_ID, `rea:${run.id}`); } catch (_) {}
  try { publish('rea', 'system.re.rea.reverified', JSON.stringify({ runId: run.id, label, proven, likely, unverified, checks: ctx.checks.length, passed: ctx.checks.filter(c => c.passed).length })); } catch (_) {}
  return { runId: run.id, confidenceLabel: label, proven, likely, unverified, checks: ctx.checks.map(c => ({ title: c.title, passed: c.passed, output: c.output })) };
}

export function listReaRuns({ limit = 20 } = {}) {
  return db.prepare(`SELECT * FROM rea_runs ORDER BY started_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit)));
}

export function getReaRun(id) {
  const run = db.prepare(`SELECT * FROM rea_runs WHERE id = ?`).get(String(id || '').slice(0, 40));
  if (!run) return null;
  const rows = db.prepare(`SELECT stage, kind, claim, fact_ids, label, detail, created_at FROM rea_evidence WHERE run_id = ? ORDER BY created_at ASC`).all(run.id)
    .map(r => ({ ...r, fact_ids: JSON.parse(r.fact_ids || '[]'), detail: r.detail ? JSON.parse(r.detail) : null }));
  let report = null;
  if (run.report_path && existsSync(run.report_path)) { try { report = readFileSync(run.report_path, 'utf8'); } catch (_) {} }
  return { ...run, live: running.has(run.id) ? { stage: run.current_stage, facts: running.get(run.id).facts.length, claims: running.get(run.id).claims.length } : null, evidence: rows, report };
}

export function getReaStatus() {
  const totals = db.prepare(`SELECT COUNT(*) n, SUM(status = 'completed') done, SUM(status = 'failed') failed, SUM(confidence_label = 'PROVEN') proven, SUM(confidence_label = 'LIKELY') likely, SUM(confidence_label = 'UNVERIFIED') unverified FROM rea_runs`).get();
  return { stages: STAGES.map(s => ({ n: s.n, key: s.key, title: s.title })), roots: ROOTS, running: [...running.keys()], totals, recent: listReaRuns({ limit: 10 }) };
}

export function installReaRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/rea', route((_req, res) => res.json(getReaStatus())));
  app.get('/api/intelligence/rea/runs', route((req, res) => res.json({ runs: listReaRuns({ limit: parseInt(req.query.limit) || 20 }) })));
  app.get('/api/intelligence/rea/runs/:id', route((req, res) => { const r = getReaRun(req.params.id); if (!r) return res.status(404).json({ error: 'run not found' }); res.json(r); }));
  app.post('/api/intelligence/rea/runs/:id/verify', route(async (req, res) => {
    try { res.json(await reverifyReaRun(req.params.id)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  }));
  // Starts asynchronously (a run is several minutes of model time); poll GET /runs/:id.
  app.post('/api/intelligence/rea/run', route((req, res) => {
    const { target, targetType, feature, question, wait } = req.body || {};
    if (!target) return res.status(400).json({ error: 'target required (path under REA_ROOTS, public URL, or text)' });
    const p = runReaProtocol({ target: String(target), targetType: targetType ? String(targetType) : null, feature, question, trigger: 'api', priority: 'agent_run' });
    if (wait === true) return p.then(r => res.json(r)).catch(e => res.status(e.status || 500).json({ error: e.message }));
    p.catch(e => console.error('[rea] run failed:', e.message));
    setTimeout(() => {
      const latest = db.prepare(`SELECT id FROM rea_runs ORDER BY started_at DESC LIMIT 1`).get();
      res.json({ started: true, runId: latest?.id || null, poll: `/api/intelligence/rea/runs/${latest?.id || '<id>'}` });
    }, 300);
  }));
}
