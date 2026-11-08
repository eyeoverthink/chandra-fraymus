#!/usr/bin/env node
/**
 * skills-sync — Phase T: the /chandra-* skills regenerate from the live system.
 *
 * The five skills in .claude/commands/ were a hand-written inventory frozen on
 * 2026-10-31 ("8 panels, 62 features, 14 Hermes executors") while the system moved to
 * 59 panels, 96 features and 30 executors. A skill that lies about counts teaches every
 * future agent the wrong system. This script reads the counts from where they actually
 * live — the filesystem, the SQLite database, the running server — and rewrites only
 * the blocks between `<!-- skills-sync:begin NAME -->` and `<!-- skills-sync:end NAME -->`.
 * Hand-written prose outside the markers is never touched.
 *
 *   node scripts/skills-sync.mjs            # rewrite blocks in place
 *   node scripts/skills-sync.mjs --check    # exit 1 if any block is stale (CI drift guard)
 *   node scripts/skills-sync.mjs --print    # print the inventory JSON only
 *
 * Every number carries its source in the rendered table so a reader can verify it.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const PRINT = args.has('--print');

const SKILL_FILES = [
  '.claude/commands/chandra-dev.md',
  '.claude/commands/chandra-extend.md',
  '.claude/commands/chandra-intelligence.md',
  '.claude/commands/chandra-commerce.md',
  '.claude/commands/chandra-audit.md',
  'README.md',
];

// ─── Collectors ─────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

function collectRoutes() {
  const files = walk(join(ROOT, 'server'));
  const re = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  const routes = new Set();
  const byPrefix = {};
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const key = `${m[1].toUpperCase()} ${m[2]}`;
      if (routes.has(key)) continue;
      routes.add(key);
      const parts = m[2].split('/').filter(Boolean);
      const prefix = parts.length >= 2 ? `/${parts[0]}/${parts[1]}` : `/${parts[0] || ''}`;
      byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
    }
  }
  const prefixes = Object.entries(byPrefix).sort((a, b) => b[1] - a[1]);
  return { total: routes.size, prefixes, files: files.length };
}

function collectTables() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(join(ROOT, 'data', 'chandra.db'), { readonly: true });
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(r => r.name);
    const count = t => { try { return db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch (_) { return null; } };
    const group = (t, col) => { try { return Object.fromEntries(db.prepare(`SELECT ${col} k, COUNT(*) c FROM ${t} GROUP BY ${col}`).all().map(r => [r.k, r.c])); } catch (_) { return null; } };
    const vitals = {
      agent_memories: count('agent_memories'),
      memory_categories: group('agent_memories', 'category'),
      goal_proposals: group('goal_proposals', 'status'),
      goal_executions: group('goal_executions', 'status'),
      consciousness_audits: count('consciousness_audits'),
      debates: group('debates', 'status'),
      forged_agents: count('forged_agents'),
      runs: group('runs', 'status'),
      knowledge_nodes: count('knowledge_nodes'),
      knowledge_edges: count('knowledge_edges'),
      self_audit_open: group(`(SELECT severity FROM self_audit_findings WHERE resolved_at IS NULL)`, 'severity'),
    };
    let findings = [];
    try { findings = db.prepare(`SELECT severity, check_name, summary FROM self_audit_findings WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'BLOCKING' THEN 0 WHEN 'REAL' THEN 1 ELSE 2 END, last_seen DESC LIMIT 8`).all(); } catch (_) {}
    db.close();
    return { count: names.length, names, vitals, findings };
  } catch (e) {
    return { count: null, names: [], vitals: null, findings: [], error: e.message };
  }
}

function collectPanels() {
  const dir = join(ROOT, 'client', 'src', 'panels');
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jsx')) : [];
  const drawer = readFileSync(join(ROOT, 'client', 'src', 'nexus', 'DetailDrawer.jsx'), 'utf8');
  const entries = [...drawer.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*\{\s*component:\s*(\w+),\s*label:\s*'([^']+)'/gm)]
    .map(m => ({ key: m[1], component: m[2], label: m[3] }));
  const views = (() => {
    const dir2 = join(ROOT, 'client', 'src', 'nexus');
    return existsSync(dir2) ? readdirSync(dir2).filter(f => f.endsWith('.jsx') && !['DetailDrawer.jsx', 'CommandBar.jsx'].includes(f)).map(f => f.replace('.jsx', '')) : [];
  })();
  return { files: files.length, drawerEntries: entries.length, entries, views };
}

function collectAgents() {
  const defaults = readdirSync(join(ROOT, 'agents')).filter(f => f.endsWith('.md'));
  const forgedDir = join(ROOT, 'data', 'agents');
  const forged = existsSync(forgedDir) ? readdirSync(forgedDir).filter(f => f.endsWith('.md')) : [];
  return { defaults: defaults.length, defaultIds: defaults.map(f => f.replace('.md', '')), forgedOnDisk: forged.length };
}

function collectTools() {
  const files = ['server/fleet/tools.js', 'server/fraymus-tools.js', 'server/commerce/tools.js', 'server/streaming/tools.js', 'server/vertiso/tools.js', 'server/vertiso/rsi-tools.js', 'server/chain/tools.js'];
  const perFile = [];
  const names = new Set();
  for (const rel of files) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    const found = [...src.matchAll(/^\s+name:\s*'([a-z][a-z0-9_.]+)'/gm)].map(m => m[1]);
    found.forEach(n => names.add(n));
    perFile.push({ file: rel, count: found.length });
  }
  let hermes = 0;
  try {
    const src = readFileSync(join(ROOT, 'server', 'fraymus-tools.js'), 'utf8');
    const start = src.indexOf('function buildHermesExecutors');
    if (start >= 0) {
      // Bound the function at the next column-0 declaration. Brace-matching raw source
      // fails on braces inside strings/regex literals (it never returned to depth 0 here),
      // and a naive "\n}\n" search ran past the function and counted 111 executors.
      const rest = src.slice(start + 1);
      const next = rest.search(/\r?\n(?:export |async function |function |const |let |class )/);
      const body = next >= 0 ? src.slice(start, start + 1 + next) : src.slice(start);
      hermes = (body.match(/^\s{4}[a-z_0-9]+:\s*async/gm) || []).length;
    }
  } catch (_) {}
  return { total: names.size, perFile, hermesExecutors: hermes };
}

function collectNodeTypes() {
  const canvas = readFileSync(join(ROOT, 'client', 'src', 'panels', 'WorkflowCanvas.jsx'), 'utf8');
  const catStart = canvas.indexOf('NODE_CATEGORIES');
  const catEnd = canvas.indexOf('const NODE_TYPES');
  const block = catStart >= 0 && catEnd > catStart ? canvas.slice(catStart, catEnd) : canvas;
  const types = [...new Set([...block.matchAll(/type:\s*'([a-z][a-z0-9_]+)'/g)].map(m => m[1]))];
  const engine = readFileSync(join(ROOT, 'server', 'workflow', 'engine.js'), 'utf8');
  const unhandled = types.filter(t => !engine.includes(`'${t}'`));
  return { total: types.length, types, engineHandled: types.length - unhandled.length, unhandled };
}

function firstDocLine(src) {
  const m = src.match(/^\s*\/\*\*?\s*\n\s*\*\s*(.+?)\s*$/m) || src.match(/^\/\/\s*(.+)$/m);
  return m ? m[1].replace(/\*+\/?$/, '').replace(/^[\s─═\-—]+|[\s─═\-—]+$/g, '').trim().slice(0, 110) : '';
}

function collectModules(relDir, { excludeRoutes = true } = {}) {
  const dir = join(ROOT, relDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.js') && !(excludeRoutes && /-routes\.js$/.test(f)))
    .sort()
    .map(f => {
      const src = readFileSync(join(dir, f), 'utf8');
      return { file: f, lines: src.split('\n').length, doc: firstDocLine(src), exports: (src.match(/^export (?:async )?function (\w+)/gm) || []).length };
    });
}

function collectPhases() {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // README documents some phases twice (infrastructure summary + per-phase section); keep
  // the first occurrence of each id, in document order.
  const seen = new Map();
  for (const m of readme.matchAll(/^### Phase ([A-Z0-9]+)(?::\s*([^\n(]+))?/gm)) {
    if (!seen.has(m[1])) seen.set(m[1], { id: m[1], title: (m[2] || '').trim() });
  }
  return [...seen.values()];
}

async function collectSystemMap() {
  try {
    const mod = await import(pathToFileURL(join(ROOT, 'server', 'intelligence', 'self-model.js')).href);
    const map = mod.getSystemMap?.() || [];
    const list = Array.isArray(map) ? map : (map.subsystems || []);
    const byCategory = {};
    for (const s of list) byCategory[s.category || 'other'] = (byCategory[s.category || 'other'] || 0) + 1;
    return { count: list.length, byCategory };
  } catch (e) {
    return { count: null, byCategory: {}, error: e.message.slice(0, 120) };
  }
}

async function collectLive() {
  try {
    const res = await fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(3000) });
    const j = await res.json();
    return { online: true, features: j.features?.length || 0, featureList: j.features || [] };
  } catch (_) {
    // Fallback: count the static feature list in app.js
    try {
      const src = readFileSync(join(ROOT, 'server', 'app.js'), 'utf8');
      const start = src.indexOf('features');
      const block = src.slice(start, start + 6000);
      const arr = block.match(/\[([\s\S]*?)\]/);
      const list = arr ? [...arr[1].matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]) : [];
      return { online: false, features: list.length, featureList: list, source: 'app.js static list' };
    } catch (e) { return { online: false, features: null, featureList: [], error: e.message }; }
  }
}

function collectGit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
    const date = execFileSync('git', ['log', '-1', '--format=%cs'], { cwd: ROOT }).toString().trim();
    return { sha, date };
  } catch (_) { return { sha: 'unknown', date: 'unknown' }; }
}

function countLines(dir) {
  let files = 0, lines = 0;
  for (const f of walk(dir)) { files++; lines += readFileSync(f, 'utf8').split('\n').length; }
  return { files, lines };
}

// ─── Inventory ──────────────────────────────────────────────────

export async function buildInventory() {
  const [systemMap, live] = await Promise.all([collectSystemMap(), collectLive()]);
  return {
    generatedAt: new Date().toISOString(),
    git: collectGit(),
    live,
    routes: collectRoutes(),
    tables: collectTables(),
    panels: collectPanels(),
    agents: collectAgents(),
    tools: collectTools(),
    nodeTypes: collectNodeTypes(),
    intelligenceModules: collectModules('server/intelligence'),
    fraymusModules: collectModules('server/fraymus/intelligence'),
    phases: collectPhases(),
    systemMap,
    serverCode: countLines(join(ROOT, 'server')),
  };
}

// ─── Renderers ──────────────────────────────────────────────────

const stamp = inv => `_Regenerated by \`npm run skills:sync\` on ${inv.generatedAt.slice(0, 10)} from commit \`${inv.git.sha}\`. Do not hand-edit this block._`;

const RENDERERS = {
  inventory: inv => [
    stamp(inv), '',
    '| Thing | Count | Source |',
    '|---|---|---|',
    `| Features registered | **${inv.live.features ?? '?'}** | ${inv.live.online ? 'live \`GET /api/health\`' : (inv.live.source || 'server offline')} |`,
    `| REST routes | **${inv.routes.total}** | regex over ${inv.routes.files} server files (\`app.get/post/put/patch/delete\`) |`,
    `| SQLite tables | **${inv.tables.count ?? '?'}** | \`sqlite_master\` in \`data/chandra.db\` |`,
    `| Server code | **${inv.serverCode.files} files / ${inv.serverCode.lines.toLocaleString()} lines** | \`server/**/*.js\` |`,
    `| Intelligence modules | **${inv.intelligenceModules.length}** | \`server/intelligence/*.js\` (routes files excluded) |`,
    `| FRAYMUS intelligence modules | **${inv.fraymusModules.length}** | \`server/fraymus/intelligence/*.js\` |`,
    `| Fleet tool definitions | **${inv.tools.total}** unique names | \`name: '…'\` across ${inv.tools.perFile.length} tools files |`,
    `| Hermes executor functions | **${inv.tools.hermesExecutors}** (Hermes exposes 30 skills; extras are aliases/sub-skills) | \`buildHermesExecutors()\` in \`fraymus-tools.js\` |`,
    `| Workflow node types | **${inv.nodeTypes.total}** (${inv.nodeTypes.engineHandled} handled in engine${inv.nodeTypes.unhandled.length ? `; unhandled: ${inv.nodeTypes.unhandled.join(', ')}` : ''}) | \`NODE_CATEGORIES\` in WorkflowCanvas.jsx vs \`workflow/engine.js\` |`,
    `| Detail Drawer panels | **${inv.panels.drawerEntries}** entries / ${inv.panels.files} panel files | \`DetailDrawer.jsx\` PANELS map, \`client/src/panels/\` |`,
    `| Nexus views | **${inv.panels.views.length}** (${inv.panels.views.join(', ')}) | \`client/src/nexus/*.jsx\` |`,
    `| Agent manifests | **${inv.agents.defaults}** default + **${inv.agents.forgedOnDisk}** forged on disk | \`agents/*.md\`, \`data/agents/*.md\` |`,
    `| Self-model subsystems | **${inv.systemMap.count ?? '?'}** (${Object.entries(inv.systemMap.byCategory).map(([k, v]) => `${k} ${v}`).join(', ')}) | \`self-model.js\` SYSTEM_MAP |`,
    `| README phases | **${inv.phases.length}** (${inv.phases.map(p => p.id).sort().join(' ')}) | \`### Phase X\` headers in README.md |`,
  ].join('\n'),

  routes: inv => [
    stamp(inv), '',
    `${inv.routes.total} unique routes. Top prefixes:`, '',
    '| Prefix | Routes |', '|---|---|',
    ...inv.routes.prefixes.slice(0, 30).map(([p, c]) => `| \`${p}\` | ${c} |`),
  ].join('\n'),

  'intelligence-modules': inv => [
    stamp(inv), '',
    `${inv.intelligenceModules.length} modules in \`server/intelligence/\` (the consciousness / autonomy stack; route files omitted):`, '',
    '| Module | Lines | Exports | First doc line |', '|---|---|---|---|',
    ...inv.intelligenceModules.map(m => `| \`${m.file}\` | ${m.lines} | ${m.exports} | ${m.doc.replace(/\|/g, '\\|')} |`),
  ].join('\n'),

  'fraymus-modules': inv => [
    stamp(inv), '',
    `${inv.fraymusModules.length} modules in \`server/fraymus/intelligence/\`; Hermes has **${inv.tools.hermesExecutors}** real executors:`, '',
    '| Module | Lines | Exports | First doc line |', '|---|---|---|---|',
    ...inv.fraymusModules.map(m => `| \`${m.file}\` | ${m.lines} | ${m.exports} | ${m.doc.replace(/\|/g, '\\|')} |`),
  ].join('\n'),

  tools: inv => [
    stamp(inv), '',
    `${inv.tools.total} unique fleet tool names:`, '',
    '| File | Definitions |', '|---|---|',
    ...inv.tools.perFile.map(f => `| \`${f.file}\` | ${f.count} |`),
  ].join('\n'),

  panels: inv => [
    stamp(inv), '',
    `${inv.panels.drawerEntries} Detail Drawer panels (key → component — label):`, '',
    ...inv.panels.entries.map(e => `- \`${e.key}\` → ${e.component} — ${e.label}`),
  ].join('\n'),

  'node-types': inv => [
    stamp(inv), '',
    `${inv.nodeTypes.total} workflow node types; ${inv.nodeTypes.engineHandled} have a handler string in \`workflow/engine.js\`${inv.nodeTypes.unhandled.length ? ` — **unhandled: ${inv.nodeTypes.unhandled.join(', ')}**` : ''}.`, '',
    inv.nodeTypes.types.map(t => `\`${t}\``).join(', '),
  ].join('\n'),

  phases: inv => [
    stamp(inv), '',
    ...inv.phases.map(p => `- Phase ${p.id}${p.title ? ` — ${p.title}` : ''}`),
  ].join('\n'),

  vitals: inv => {
    const v = inv.tables.vitals || {};
    const g = o => o ? Object.entries(o).map(([k, c]) => `${k} ${c}`).join(', ') : 'n/a';
    return [
      stamp(inv), '',
      '| Vital | Value |', '|---|---|',
      `| agent_memories | ${v.agent_memories ?? 'n/a'} (${g(v.memory_categories)}) |`,
      `| goal_proposals by status | ${g(v.goal_proposals)} |`,
      `| goal_executions by status | ${g(v.goal_executions)} |`,
      `| runs by status | ${g(v.runs)} |`,
      `| debates by status | ${g(v.debates)} |`,
      `| forged_agents (DB rows) | ${v.forged_agents ?? 'n/a'} |`,
      `| consciousness_audits | ${v.consciousness_audits ?? 'n/a'} |`,
      `| knowledge graph | ${v.knowledge_nodes ?? 'n/a'} nodes / ${v.knowledge_edges ?? 'n/a'} edges |`,
      `| open self-audit findings | ${g(v.self_audit_open) || 'none'} |`,
      '',
      ...(inv.tables.findings.length ? ['Open self-audit findings (top):', '', ...inv.tables.findings.map(f => `- **${f.severity}** \`${f.check_name}\` — ${f.summary.slice(0, 140)}`)] : ['No open self-audit findings.']),
    ].join('\n');
  },

  agents: inv => [
    stamp(inv), '',
    `${inv.agents.defaults} default manifests in \`agents/\`: ${inv.agents.defaultIds.join(', ')}.`,
    `${inv.agents.forgedOnDisk} forged manifests on disk in \`data/agents/\` (${inv.tables.vitals?.forged_agents ?? 'n/a'} rows in \`forged_agents\`).`,
  ].join('\n'),
};

// ─── Apply ──────────────────────────────────────────────────────

function applyBlocks(text, inv) {
  const re = /(<!-- skills-sync:begin ([a-z-]+) -->)[\s\S]*?(<!-- skills-sync:end \2 -->)/g;
  let changed = 0;
  const out = text.replace(re, (whole, open, name, close) => {
    const render = RENDERERS[name];
    if (!render) return whole;
    const body = render(inv);
    const next = `${open}\n${body}\n${close}`;
    if (next !== whole) changed++;
    return next;
  });
  return { out, changed };
}

async function main() {
  const inv = await buildInventory();
  if (PRINT) { console.log(JSON.stringify(inv, null, 2)); return; }
  let stale = 0;
  for (const rel of SKILL_FILES) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const { out, changed } = applyBlocks(text, inv);
    if (!changed) { console.log(`  ${rel}: up to date`); continue; }
    stale += changed;
    if (CHECK) { console.log(`  ${rel}: ${changed} stale block(s)`); continue; }
    writeFileSync(p, out, 'utf8');
    console.log(`  ${rel}: regenerated ${changed} block(s)`);
  }
  console.log(`\nskills-sync: features ${inv.live.features ?? '?'}${inv.live.online ? ' (live)' : ' (offline)'}, routes ${inv.routes.total}, tables ${inv.tables.count}, panels ${inv.panels.drawerEntries}, tools ${inv.tools.total}, node types ${inv.nodeTypes.total}, intelligence modules ${inv.intelligenceModules.length}, commit ${inv.git.sha}`);
  if (CHECK && stale) { console.error(`\n${stale} block(s) are stale — run \`npm run skills:sync\``); process.exit(1); }
}

main().catch(e => { console.error('skills-sync failed:', e); process.exit(1); });
