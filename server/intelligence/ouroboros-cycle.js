import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ─── Schema ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ouroboros_cycles (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'absorb',
    status TEXT NOT NULL DEFAULT 'running',
    parent_cycle_id TEXT,
    generation INTEGER DEFAULT 1,
    genome_hash TEXT,
    outline TEXT,
    outline_hash TEXT,
    proposal_count INTEGER DEFAULT 0,
    accepted_count INTEGER DEFAULT 0,
    rejected_count INTEGER DEFAULT 0,
    implemented_count INTEGER DEFAULT 0,
    duration_ms INTEGER,
    insights TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ouroboros_proposals (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    description TEXT,
    target_files TEXT,
    rationale TEXT,
    implementation_sketch TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    review_verdict TEXT,
    review_notes TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (cycle_id) REFERENCES ouroboros_cycles(id)
  );
  CREATE TABLE IF NOT EXISTS ouroboros_genome (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    gene_type TEXT NOT NULL DEFAULT 'mutation',
    origin_cycle_id TEXT NOT NULL,
    generation_acquired INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (cycle_id) REFERENCES ouroboros_cycles(id),
    FOREIGN KEY (proposal_id) REFERENCES ouroboros_proposals(id)
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_cycle ON ouroboros_proposals(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_proposals_status ON ouroboros_proposals(status);
  CREATE INDEX IF NOT EXISTS idx_genome_cycle ON ouroboros_genome(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_genome_active ON ouroboros_genome(active);

  CREATE TABLE IF NOT EXISTS ouroboros_workspaces (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (cycle_id) REFERENCES ouroboros_cycles(id)
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_cycle ON ouroboros_workspaces(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_gen ON ouroboros_workspaces(generation);
`);

// Migrate existing cycles that lack generation columns
try {
  db.exec(`ALTER TABLE ouroboros_cycles ADD COLUMN parent_cycle_id TEXT`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE ouroboros_cycles ADD COLUMN generation INTEGER DEFAULT 1`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE ouroboros_cycles ADD COLUMN genome_hash TEXT`);
} catch (_) {}

// ─── Genome Helpers ─────────────────────────────────────────────────

function computeGenomeHash(genes) {
  const sorted = genes.map(g => g.proposal_id).sort().join(':');
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

function getLatestCompletedCycle() {
  return db.prepare(
    `SELECT id, generation, genome_hash FROM ouroboros_cycles WHERE status = 'complete' ORDER BY created_at DESC LIMIT 1`
  ).get() || null;
}

function inheritGenome(parentCycleId, newCycleId, newGeneration) {
  const parentGenes = db.prepare(
    `SELECT proposal_id, origin_cycle_id, generation_acquired FROM ouroboros_genome WHERE cycle_id = ? AND active = 1`
  ).all(parentCycleId);
  const insert = db.prepare(
    `INSERT INTO ouroboros_genome (id, cycle_id, proposal_id, gene_type, origin_cycle_id, generation_acquired, active) VALUES (?, ?, ?, 'inherited', ?, ?, 1)`
  );
  for (const g of parentGenes) {
    insert.run(uid(), newCycleId, g.proposal_id, g.origin_cycle_id, g.generation_acquired);
  }
  return parentGenes.length;
}

function addMutations(cycleId, proposals, generation) {
  const insert = db.prepare(
    `INSERT INTO ouroboros_genome (id, cycle_id, proposal_id, gene_type, origin_cycle_id, generation_acquired, active) VALUES (?, ?, ?, 'mutation', ?, ?, 1)`
  );
  for (const p of proposals) {
    insert.run(uid(), cycleId, p.id, cycleId, generation);
  }
}

function getGenome(cycleId) {
  return db.prepare(
    `SELECT g.*, p.title, p.category, p.priority, p.status as proposal_status
     FROM ouroboros_genome g
     JOIN ouroboros_proposals p ON g.proposal_id = p.id
     WHERE g.cycle_id = ? AND g.active = 1
     ORDER BY g.generation_acquired ASC`
  ).all(cycleId);
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ─── Workspace Capture ──────────────────────────────────────────────

function safeQuery(sql, params = []) {
  try { return Array.isArray(params) && params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all(); } catch { return []; }
}

function safeQueryGet(sql) {
  try { return db.prepare(sql).get() || {}; } catch { return {}; }
}

function captureFleetState(rootDir) {
  const agents = [];
  try {
    const agentDir = path.join(rootDir, 'server/fleet/agents');
    for (const f of fs.readdirSync(agentDir).filter(x => x.endsWith('.md'))) {
      const raw = fs.readFileSync(path.join(agentDir, f), 'utf8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (fm) {
        const id = (fm[1].match(/id:\s*(.+)/) || [])[1]?.trim();
        const name = (fm[1].match(/name:\s*(.+)/) || [])[1]?.trim();
        const role = (fm[1].match(/role:\s*(.+)/) || [])[1]?.trim();
        const tools = (fm[1].match(/tools:\n([\s\S]*?)(?:\n\w|$)/) || [])[1];
        const toolCount = tools ? (tools.match(/^\s*-/gm) || []).length : 0;
        agents.push({ id: id || f, name: name || f, role: role || '', toolCount, source: 'manifest' });
      }
    }
  } catch {}
  const forged = safeQuery(`SELECT agent_id, forged_by, goal FROM forged_agents ORDER BY created_at DESC`);
  for (const f of forged) {
    agents.push({ id: f.agent_id, name: f.agent_id, role: f.goal || '', toolCount: 0, source: 'forged', forgedBy: f.forged_by });
  }
  const runStats = safeQueryGet(`SELECT COUNT(*) as totalRuns, SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) as successRuns FROM runs`);
  return { agents, count: agents.length, manifestCount: agents.filter(a => a.source === 'manifest').length, forgedCount: forged.length, totalRuns: runStats.totalRuns || 0, successRuns: runStats.successRuns || 0 };
}

function captureWorkflowState() {
  const workflows = safeQuery(`SELECT id, name, node_count, status FROM workflows ORDER BY created_at DESC LIMIT 100`);
  const synthesized = safeQuery(`SELECT workflow_id, goal, node_count FROM synthesized_workflows ORDER BY created_at DESC`);
  const runStats = safeQueryGet(`SELECT COUNT(*) as total, SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) as completed FROM workflow_runs`);
  return { definitions: workflows.map(w => ({ id: w.id, name: w.name, nodes: w.node_count })), count: workflows.length, synthesizedCount: synthesized.length, totalRuns: runStats.total || 0, completedRuns: runStats.completed || 0 };
}

function captureIntelligenceState() {
  const reflections = safeQueryGet(`SELECT COUNT(*) as total FROM reflections`);
  const verifications = safeQueryGet(`SELECT COUNT(*) as total, SUM(CASE WHEN final_status='APPROVED' THEN 1 ELSE 0 END) as approved FROM verification_loops`);
  const daemonCycles = safeQueryGet(`SELECT COUNT(*) as total FROM daemon_cycles`);
  const memories = safeQueryGet(`SELECT COUNT(*) as total, COUNT(DISTINCT agent_id) as agents FROM agent_memories`);
  const verifiedMemories = safeQueryGet(`SELECT COUNT(*) as total FROM agent_memories WHERE verified_at IS NOT NULL`);
  return {
    reflections: reflections.total || 0,
    verifications: verifications.total || 0, verificationsApproved: verifications.approved || 0,
    daemonCycles: daemonCycles.total || 0,
    memories: memories.total || 0, memoriesAgents: memories.agents || 0,
    verifiedMemories: verifiedMemories.total || 0,
  };
}

function captureBusState() {
  const topics = safeQuery(`SELECT DISTINCT topic FROM bus_messages`);
  const msgCount = safeQueryGet(`SELECT COUNT(*) as total FROM bus_messages`);
  const triggers = safeQuery(`SELECT topic, label, enabled FROM bus_triggers`);
  return { topicCount: topics.length, topics: topics.map(t => t.topic), messageCount: msgCount.total || 0, triggers: triggers.length, activeTriggers: triggers.filter(t => t.enabled).length };
}

function captureSystemVitals() {
  const mem = process.memoryUsage();
  return { heapMB: Math.round(mem.heapUsed / 1024 / 1024), rssMB: Math.round(mem.rss / 1024 / 1024), uptimeSec: Math.round(process.uptime()) };
}

export function captureWorkspace(cycleId, rootDir) {
  const cycle = db.prepare(`SELECT id, generation, genome_hash, status, proposal_count, accepted_count, rejected_count, duration_ms, created_at FROM ouroboros_cycles WHERE id = ?`).get(cycleId);
  if (!cycle) return null;

  const genome = getGenome(cycleId);
  const outline = absorbCodebase(rootDir || process.cwd());

  const snapshot = {
    capturedAt: new Date().toISOString(),
    generation: cycle.generation || 1,
    fleet: captureFleetState(rootDir || process.cwd()),
    workflows: captureWorkflowState(),
    intelligence: captureIntelligenceState(),
    genome: { size: genome.length, hash: cycle.genome_hash || '', mutations: genome.filter(g => g.gene_type === 'mutation').length, inherited: genome.filter(g => g.gene_type === 'inherited').length, categories: [...new Set(genome.map(g => g.category))] },
    codebase: { files: outline.stats.totalFiles, lines: outline.stats.totalLines, routes: outline.stats.totalRoutes, tables: outline.stats.dbTableCount, tableList: outline.stats.dbTables, agents: outline.stats.agentCount },
    bus: captureBusState(),
    vitals: captureSystemVitals(),
  };

  const snapshotJson = JSON.stringify(snapshot);
  const fingerprint = createHash('sha256').update(snapshotJson).digest('hex').slice(0, 16);
  const wsId = uid();

  db.prepare(`INSERT OR REPLACE INTO ouroboros_workspaces (id, cycle_id, generation, snapshot, fingerprint) VALUES (?, ?, ?, ?, ?)`)
    .run(wsId, cycleId, cycle.generation || 1, snapshotJson, fingerprint);

  return { id: wsId, cycleId, generation: cycle.generation || 1, fingerprint, snapshot };
}

export function getWorkspace(cycleId) {
  const row = db.prepare(`SELECT * FROM ouroboros_workspaces WHERE cycle_id = ?`).get(cycleId);
  if (!row) return null;
  row.snapshot = JSON.parse(row.snapshot);
  return row;
}

export function diffWorkspaces(cycleA, cycleB) {
  const wsA = getWorkspace(cycleA);
  const wsB = getWorkspace(cycleB);
  if (!wsA || !wsB) return null;
  const a = wsA.snapshot;
  const b = wsB.snapshot;

  const agentIdsA = new Set(a.fleet.agents.map(x => x.id));
  const agentIdsB = new Set(b.fleet.agents.map(x => x.id));

  const wfIdsA = new Set(a.workflows.definitions.map(x => x.id));
  const wfIdsB = new Set(b.workflows.definitions.map(x => x.id));

  return {
    generationA: a.generation, generationB: b.generation,
    fingerprintA: wsA.fingerprint, fingerprintB: wsB.fingerprint,
    identical: wsA.fingerprint === wsB.fingerprint,
    fleet: {
      added: b.fleet.agents.filter(x => !agentIdsA.has(x.id)),
      removed: a.fleet.agents.filter(x => !agentIdsB.has(x.id)),
      countDelta: b.fleet.count - a.fleet.count,
      runsDelta: (b.fleet.totalRuns || 0) - (a.fleet.totalRuns || 0),
    },
    workflows: {
      added: b.workflows.definitions.filter(x => !wfIdsA.has(x.id)),
      removed: a.workflows.definitions.filter(x => !wfIdsB.has(x.id)),
      countDelta: b.workflows.count - a.workflows.count,
    },
    genome: {
      sizeDelta: b.genome.size - a.genome.size,
      hashChanged: a.genome.hash !== b.genome.hash,
      newMutations: b.genome.mutations,
    },
    codebase: {
      filesDelta: b.codebase.files - a.codebase.files,
      linesDelta: b.codebase.lines - a.codebase.lines,
      routesDelta: b.codebase.routes - a.codebase.routes,
      tablesDelta: b.codebase.tables - a.codebase.tables,
      newTables: b.codebase.tableList.filter(t => !a.codebase.tableList.includes(t)),
      removedTables: a.codebase.tableList.filter(t => !b.codebase.tableList.includes(t)),
    },
    intelligence: {
      reflectionsDelta: b.intelligence.reflections - a.intelligence.reflections,
      memoriesDelta: b.intelligence.memories - a.intelligence.memories,
      verificationsDelta: b.intelligence.verifications - a.intelligence.verifications,
    },
    bus: {
      topicsDelta: b.bus.topicCount - a.bus.topicCount,
      messagesDelta: b.bus.messageCount - a.bus.messageCount,
      newTopics: b.bus.topics.filter(t => !a.bus.topics.includes(t)),
    },
  };
}

// ─── Phase 1: ABSORB — scan real codebase ───────────────────────────

const SCAN_DIRS = [
  { dir: 'server', label: 'Server', ext: ['.js', '.mjs'] },
  { dir: 'client/src', label: 'Client', ext: ['.jsx', '.js'] },
];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.claude']);

function walkDir(base, ext, maxDepth = 5) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (ext.some(x => e.name.endsWith(x))) {
        const rel = path.relative(base, full).replace(/\\/g, '/');
        let lines = 0;
        try { lines = fs.readFileSync(full, 'utf8').split('\n').length; } catch {}
        results.push({ path: rel, lines });
      }
    }
  }
  walk(base, 0);
  return results;
}

function extractExports(filePath) {
  try {
    const src = fs.readFileSync(filePath, 'utf8');
    const exports = [];
    const re = /export\s+(?:async\s+)?(?:function|class|const|let|default\s+function)\s+(\w+)/g;
    let m;
    while ((m = re.exec(src))) exports.push(m[1]);
    return exports;
  } catch { return []; }
}

function countDbTables() {
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    return rows.map(r => r.name);
  } catch { return []; }
}

function countRoutes(filePath) {
  try {
    const src = fs.readFileSync(filePath, 'utf8');
    const gets = (src.match(/\.(get|GET)\s*\(/g) || []).length;
    const posts = (src.match(/\.(post|POST)\s*\(/g) || []).length;
    const puts = (src.match(/\.(put|PUT)\s*\(/g) || []).length;
    const deletes = (src.match(/\.(delete|DELETE)\s*\(/g) || []).length;
    return { gets, posts, puts, deletes, total: gets + posts + puts + deletes };
  } catch { return { gets: 0, posts: 0, puts: 0, deletes: 0, total: 0 }; }
}

export function absorbCodebase(rootDir) {
  const outline = { timestamp: new Date().toISOString(), modules: {}, stats: {} };
  let totalFiles = 0;
  let totalLines = 0;

  for (const { dir, label, ext } of SCAN_DIRS) {
    const absDir = path.join(rootDir, dir);
    const files = walkDir(absDir, ext);
    const grouped = {};
    for (const f of files) {
      const parts = f.path.split('/');
      const group = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
      if (!grouped[group]) grouped[group] = [];
      const absPath = path.join(absDir, f.path);
      const exports = extractExports(absPath);
      grouped[group].push({ file: parts[parts.length - 1], lines: f.lines, exports: exports.slice(0, 10) });
    }
    outline.modules[label] = grouped;
    totalFiles += files.length;
    totalLines += files.reduce((s, f) => s + f.lines, 0);
  }

  // DB tables
  outline.stats.dbTables = countDbTables();
  outline.stats.dbTableCount = outline.stats.dbTables.length;

  // Route counts from key route files
  const routeFiles = [
    'server/app.js', 'server/fleet/routes.js', 'server/commerce/routes.js',
    'server/workflow/routes.js', 'server/fraymus-routes.js',
    'server/streaming/routes.js', 'server/media/image-routes.js',
    'server/media/video-routes.js', 'server/media/tts-routes.js',
    'server/media/stt-routes.js', 'server/media/ocr-routes.js',
  ];
  let totalRoutes = 0;
  for (const rf of routeFiles) {
    const abs = path.join(rootDir, rf);
    const c = countRoutes(abs);
    totalRoutes += c.total;
  }

  // Agent manifests
  let agentCount = 0;
  try {
    const agentDir = path.join(rootDir, 'server/fleet/agents');
    agentCount = fs.readdirSync(agentDir).filter(f => f.endsWith('.md')).length;
  } catch {}
  let forgedCount = 0;
  try {
    const forgedDir = path.join(rootDir, 'data/agents');
    forgedCount = fs.readdirSync(forgedDir).filter(f => f.endsWith('.md')).length;
  } catch {}

  outline.stats.totalFiles = totalFiles;
  outline.stats.totalLines = totalLines;
  outline.stats.totalRoutes = totalRoutes;
  outline.stats.agentCount = agentCount + forgedCount;
  outline.stats.agentManifests = agentCount;
  outline.stats.forgedAgents = forgedCount;

  return outline;
}

function outlineToText(outline) {
  const lines = [];
  lines.push(`# Chandra-FRAYMUS Codebase Outline — ${outline.timestamp}`);
  lines.push(`\nStats: ${outline.stats.totalFiles} files, ${outline.stats.totalLines} lines, ${outline.stats.totalRoutes} REST endpoints, ${outline.stats.dbTableCount} DB tables, ${outline.stats.agentCount} agents`);
  lines.push(`\nDB Tables: ${outline.stats.dbTables.join(', ')}`);

  for (const [label, groups] of Object.entries(outline.modules)) {
    lines.push(`\n## ${label}`);
    for (const [group, files] of Object.entries(groups)) {
      lines.push(`\n### ${group}`);
      for (const f of files) {
        const exp = f.exports.length ? ` — exports: ${f.exports.join(', ')}` : '';
        lines.push(`- ${f.file} (${f.lines} lines)${exp}`);
      }
    }
  }
  return lines.join('\n');
}

// ─── Phase 2: ANALYZE — LLM improvement proposals ──────────────────

const ANALYSIS_PROMPT = `You are Ouroboros, a recursive self-improvement engine analyzing a codebase for concrete improvements.

Given the full codebase outline below, identify 5-10 specific, actionable improvements. Each must be:
1. CONCRETE — name exact files and functions
2. CATEGORIZED — one of: performance, reliability, security, architecture, feature, refactor, testing
3. PRIORITIZED — critical, high, medium, low
4. IMPLEMENTABLE — describe what code changes are needed

Focus on:
- Missing error handling or resilience gaps
- Performance bottlenecks (N+1 queries, missing indexes, unbounded fetches)
- Architecture improvements (duplicated patterns, missing abstractions)
- Security gaps (input validation, auth checks)
- Missing integrations between subsystems that would create synergy
- Testing gaps for critical paths

DO NOT suggest:
- Cosmetic changes (renaming, formatting)
- Adding comments or documentation
- Framework migrations
- Vague "consider" suggestions

Return ONLY valid JSON array:
[{
  "category": "performance|reliability|security|architecture|feature|refactor|testing",
  "priority": "critical|high|medium|low",
  "title": "Short imperative title",
  "description": "What the problem is and why it matters",
  "targetFiles": ["exact/file/paths"],
  "rationale": "Why this improves the system",
  "implementationSketch": "Concrete steps to implement"
}]`;

function parseJSONArray(raw) {
  const parsed = parseJSON(raw);
  if (Array.isArray(parsed)) return parsed;
  // Try extracting array from within object
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed)) {
      if (Array.isArray(v)) return v;
    }
  }
  // Last resort: find [...] in raw text
  const bracketMatch = raw.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try { const arr = JSON.parse(bracketMatch[0]); if (Array.isArray(arr)) return arr; } catch {}
  }
  return null;
}

function condensedOutline(outlineText) {
  const lines = outlineText.split('\n');
  const kept = [];
  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('Stats:') || line.startsWith('DB Tables:')) {
      kept.push(line);
    } else if (line.startsWith('- ') && line.includes(' lines)')) {
      const trimLine = line.replace(/ — exports:.*$/, '');
      kept.push(trimLine);
    }
    if (kept.join('\n').length > 3000) break;
  }
  return kept.join('\n');
}

async function analyzeForImprovements(outlineText) {
  const trimmed = condensedOutline(outlineText);
  const raw = await chatOllama([
    { role: 'system', content: ANALYSIS_PROMPT },
    { role: 'user', content: 'Analyze this codebase and return a JSON array of improvements:\n\n' + trimmed },
  ], { temperature: 0.3, maxTokens: 4096 });
  const proposals = parseJSONArray(raw);
  if (!proposals) throw new Error('LLM did not return a parseable JSON array');
  return proposals.filter(p => p.title && p.category).slice(0, 10);
}

// ─── Phase 3: REVIEW — adversarial second-pass ─────────────────────

const REVIEW_PROMPT = `You are a senior code reviewer evaluating improvement proposals for a production system.

For each proposal, assess:
1. FEASIBILITY — can this actually be implemented as described?
2. RISK — could this break existing functionality?
3. VALUE — is the improvement worth the effort?
4. CORRECTNESS — is the analysis accurate?

Return ONLY valid JSON array with one entry per proposal:
[{
  "proposalId": "the id",
  "verdict": "approve|revise|reject",
  "confidence": 0.0-1.0,
  "notes": "Specific feedback"
}]`;

async function reviewProposals(proposals, outlineText) {
  const summaryForReview = proposals.map(p => ({
    id: p.id, title: p.title, category: p.category,
    description: p.description, targetFiles: p.target_files,
    implementationSketch: p.implementation_sketch,
  }));

  const raw = await chatOllama([
    { role: 'system', content: REVIEW_PROMPT },
    { role: 'user', content: `Codebase context (abbreviated):\n${outlineText.slice(0, 3000)}\n\nProposals to review:\n${JSON.stringify(summaryForReview, null, 2)}` },
  ], { temperature: 0.3, maxTokens: 3000 });

  const reviews = parseJSONArray(raw);
  if (!reviews) return [];
  return reviews;
}

// ─── Cycle Orchestrator ─────────────────────────────────────────────

export async function runCycle(rootDir) {
  const cycleId = uid();
  const start = Date.now();

  // Determine parent and generation
  const parent = getLatestCompletedCycle();
  const parentId = parent?.id || null;
  const generation = parent ? (parent.generation || 1) + 1 : 1;

  db.prepare(`INSERT INTO ouroboros_cycles (id, phase, status, parent_cycle_id, generation) VALUES (?, 'absorb', 'running', ?, ?)`)
    .run(cycleId, parentId, generation);

  try {
    // Inherit genome from parent
    let inheritedGenes = 0;
    if (parentId) {
      inheritedGenes = inheritGenome(parentId, cycleId, generation);
    }

    // Phase 1: ABSORB
    const outline = absorbCodebase(rootDir || process.cwd());
    const outlineText = outlineToText(outline);
    const outlineHash = createHash('sha256').update(outlineText.slice(0, 4000)).digest('hex').slice(0, 16);

    db.prepare(`UPDATE ouroboros_cycles SET phase = 'absorb_done', outline = ?, outline_hash = ? WHERE id = ?`)
      .run(outlineText, outlineHash, cycleId);

    // Phase 2: ANALYZE
    db.prepare(`UPDATE ouroboros_cycles SET phase = 'analyze' WHERE id = ?`).run(cycleId);
    const rawProposals = await analyzeForImprovements(outlineText);

    // Store proposals
    const insert = db.prepare(`INSERT INTO ouroboros_proposals (id, cycle_id, category, priority, title, description, target_files, rationale, implementation_sketch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of rawProposals) {
      insert.run(
        uid(), cycleId, p.category || 'refactor', p.priority || 'medium',
        p.title, p.description || '',
        JSON.stringify(p.targetFiles || []),
        p.rationale || '',
        p.implementationSketch || '',
      );
    }

    db.prepare(`UPDATE ouroboros_cycles SET phase = 'analyze_done', proposal_count = ? WHERE id = ?`)
      .run(rawProposals.length, cycleId);

    // Phase 3: REVIEW
    db.prepare(`UPDATE ouroboros_cycles SET phase = 'review' WHERE id = ?`).run(cycleId);
    const storedProposals = db.prepare(`SELECT * FROM ouroboros_proposals WHERE cycle_id = ?`).all(cycleId);
    const reviews = await reviewProposals(storedProposals, outlineText);

    let accepted = 0, rejected = 0;
    const updateProposal = db.prepare(`UPDATE ouroboros_proposals SET status = ?, review_verdict = ?, review_notes = ? WHERE id = ?`);
    for (const r of reviews) {
      const prop = storedProposals.find(p => p.id === r.proposalId);
      if (!prop) continue;
      const status = r.verdict === 'approve' ? 'accepted' : r.verdict === 'reject' ? 'rejected' : 'needs_revision';
      updateProposal.run(status, r.verdict, r.notes || '', prop.id);
      if (r.verdict === 'approve') accepted++;
      else if (r.verdict === 'reject') rejected++;
    }
    // Proposals not reviewed default to accepted (LLM may not return all)
    const unreviewed = storedProposals.filter(p => !reviews.find(r => r.proposalId === p.id));
    for (const p of unreviewed) {
      updateProposal.run('accepted', 'approve', 'Auto-accepted (not challenged by reviewer)', p.id);
      accepted++;
    }

    // Add accepted proposals as new mutations in the genome
    const acceptedProposals = db.prepare(
      `SELECT id FROM ouroboros_proposals WHERE cycle_id = ? AND status = 'accepted'`
    ).all(cycleId);
    addMutations(cycleId, acceptedProposals, generation);

    // Compute genome hash from all active genes
    const allGenes = db.prepare(
      `SELECT proposal_id FROM ouroboros_genome WHERE cycle_id = ? AND active = 1`
    ).all(cycleId);
    const genomeHash = computeGenomeHash(allGenes);

    const durationMs = Date.now() - start;
    const insights = {
      generation,
      parentCycleId: parentId,
      inheritedGenes,
      filesScanned: outline.stats.totalFiles,
      linesAnalyzed: outline.stats.totalLines,
      tablesFound: outline.stats.dbTableCount,
      proposalsGenerated: rawProposals.length,
      accepted, rejected,
      revised: rawProposals.length - accepted - rejected,
      newMutations: acceptedProposals.length,
      totalGenomeSize: allGenes.length,
      genomeHash,
      categories: [...new Set(rawProposals.map(p => p.category))],
    };

    db.prepare(`UPDATE ouroboros_cycles SET phase = 'complete', status = 'complete', accepted_count = ?, rejected_count = ?, implemented_count = 0, duration_ms = ?, insights = ?, genome_hash = ? WHERE id = ?`)
      .run(accepted, rejected, durationMs, JSON.stringify(insights), genomeHash, cycleId);

    // Capture workspace snapshot for this generation
    let workspace = null;
    try {
      workspace = captureWorkspace(cycleId, rootDir || process.cwd());
    } catch (wsErr) {
      insights.workspaceError = wsErr.message;
    }

    // Broadcast evolution event
    try {
      publish('system', 'system.evolution', JSON.stringify({
        type: 'ouroboros_cycle', cycleId, generation, genomeHash,
        parentId, accepted, rejected, durationMs,
        workspaceFingerprint: workspace?.fingerprint || null,
      }));
    } catch (_) {}

    return { cycleId, ...insights, durationMs, workspaceFingerprint: workspace?.fingerprint || null };

  } catch (err) {
    db.prepare(`UPDATE ouroboros_cycles SET status = 'failed', insights = ? WHERE id = ?`)
      .run(JSON.stringify({ error: err.message }), cycleId);
    throw err;
  }
}

// ─── Queries ────────────────────────────────────────────────────────

export function getCycle(cycleId) {
  const cycle = db.prepare(`SELECT * FROM ouroboros_cycles WHERE id = ?`).get(cycleId);
  if (!cycle) return null;
  cycle.insights = cycle.insights ? JSON.parse(cycle.insights) : null;
  cycle.proposals = db.prepare(`SELECT * FROM ouroboros_proposals WHERE cycle_id = ? ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`).all(cycleId);
  for (const p of cycle.proposals) {
    try { p.target_files = JSON.parse(p.target_files); } catch { p.target_files = []; }
  }
  return cycle;
}

export function listCycles(limit = 20) {
  return db.prepare(`SELECT id, phase, status, proposal_count, accepted_count, rejected_count, implemented_count, duration_ms, created_at FROM ouroboros_cycles ORDER BY created_at DESC LIMIT ?`).all(Math.min(50, Math.max(1, limit)));
}

export function getProposal(proposalId) {
  const p = db.prepare(`SELECT * FROM ouroboros_proposals WHERE id = ?`).get(proposalId);
  if (p) try { p.target_files = JSON.parse(p.target_files); } catch { p.target_files = []; }
  return p;
}

export function updateProposalStatus(proposalId, status) {
  db.prepare(`UPDATE ouroboros_proposals SET status = ? WHERE id = ?`).run(status, proposalId);
  return getProposal(proposalId);
}

export function getStats() {
  const cycles = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed, AVG(duration_ms) as avgDuration FROM ouroboros_cycles`).get();
  const proposals = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) as accepted, SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) as rejected, SUM(CASE WHEN status='implemented' THEN 1 ELSE 0 END) as implemented FROM ouroboros_proposals`).get();
  const byCategory = db.prepare(`SELECT category, COUNT(*) as count, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) as accepted FROM ouroboros_proposals GROUP BY category ORDER BY count DESC`).all();
  return { cycles, proposals, byCategory };
}

export function getOutline(cycleId) {
  const row = db.prepare(`SELECT outline FROM ouroboros_cycles WHERE id = ?`).get(cycleId);
  return row?.outline || null;
}

// ─── Lineage Queries ──────────────────────────────────────────────

export function getLineage(cycleId, maxDepth = 50) {
  const chain = [];
  let current = cycleId;
  let depth = 0;
  while (current && depth < maxDepth) {
    const row = db.prepare(
      `SELECT id, parent_cycle_id, generation, genome_hash, status, proposal_count, accepted_count, rejected_count, duration_ms, created_at FROM ouroboros_cycles WHERE id = ?`
    ).get(current);
    if (!row) break;
    chain.push(row);
    current = row.parent_cycle_id;
    depth++;
  }
  return chain;
}

export function getFullLineageTree() {
  const cycles = db.prepare(
    `SELECT id, parent_cycle_id, generation, genome_hash, status, phase, proposal_count, accepted_count, rejected_count, implemented_count, duration_ms, insights, created_at FROM ouroboros_cycles ORDER BY created_at ASC`
  ).all();

  for (const c of cycles) {
    try { c.insights = c.insights ? JSON.parse(c.insights) : null; } catch { c.insights = null; }
    const genes = db.prepare(
      `SELECT g.gene_type, g.generation_acquired, g.origin_cycle_id, p.title, p.category, p.status as proposal_status
       FROM ouroboros_genome g JOIN ouroboros_proposals p ON g.proposal_id = p.id
       WHERE g.cycle_id = ? AND g.active = 1`
    ).all(c.id);
    c.genome = genes;
    c.genomeSize = genes.length;
    c.mutations = genes.filter(g => g.gene_type === 'mutation').length;
    c.inherited = genes.filter(g => g.gene_type === 'inherited').length;
  }

  // Build adjacency: parent → children
  const children = {};
  for (const c of cycles) {
    if (c.parent_cycle_id) {
      if (!children[c.parent_cycle_id]) children[c.parent_cycle_id] = [];
      children[c.parent_cycle_id].push(c.id);
    }
  }

  // Compute cumulative genome drift: how much the genome changed from parent
  for (const c of cycles) {
    if (c.parent_cycle_id) {
      const parent = cycles.find(p => p.id === c.parent_cycle_id);
      if (parent) {
        c.genomeDrift = c.genomeSize - parent.genomeSize;
        c.parentGeneration = parent.generation;
      }
    }
  }

  return { cycles, children, totalGenerations: cycles.length > 0 ? Math.max(...cycles.map(c => c.generation || 1)) : 0 };
}

export function getGenomeForCycle(cycleId) {
  return getGenome(cycleId);
}

export function getGenomeDiff(cycleA, cycleB) {
  const genesA = new Set(db.prepare(`SELECT proposal_id FROM ouroboros_genome WHERE cycle_id = ? AND active = 1`).all(cycleA).map(g => g.proposal_id));
  const genesB = new Set(db.prepare(`SELECT proposal_id FROM ouroboros_genome WHERE cycle_id = ? AND active = 1`).all(cycleB).map(g => g.proposal_id));

  const added = [...genesB].filter(g => !genesA.has(g));
  const removed = [...genesA].filter(g => !genesB.has(g));
  const shared = [...genesA].filter(g => genesB.has(g));

  const getProposalDetails = (ids) => ids.length > 0 ? db.prepare(
    `SELECT id, title, category, priority, status FROM ouroboros_proposals WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids) : [];

  return {
    added: getProposalDetails(added),
    removed: getProposalDetails(removed),
    shared: shared.length,
    totalA: genesA.size,
    totalB: genesB.size,
    similarity: genesA.size + genesB.size > 0 ? (shared.length * 2) / (genesA.size + genesB.size) : 1,
  };
}

// ─── Fork & Restore ────────────────────────────────────────────────

export async function forkCycle(ancestorCycleId, rootDir) {
  const ancestor = db.prepare(
    `SELECT id, generation, genome_hash FROM ouroboros_cycles WHERE id = ?`
  ).get(ancestorCycleId);
  if (!ancestor) throw new Error('Ancestor cycle not found');

  const cycleId = uid();
  const start = Date.now();
  const generation = (ancestor.generation || 1) + 1;

  db.prepare(`INSERT INTO ouroboros_cycles (id, phase, status, parent_cycle_id, generation) VALUES (?, 'absorb', 'running', ?, ?)`)
    .run(cycleId, ancestorCycleId, generation);

  try {
    const inheritedGenes = inheritGenome(ancestorCycleId, cycleId, generation);

    // Phase 1: ABSORB (fresh scan)
    const outline = absorbCodebase(rootDir || process.cwd());
    const outlineText = outlineToText(outline);
    const outlineHash = createHash('sha256').update(outlineText.slice(0, 4000)).digest('hex').slice(0, 16);

    db.prepare(`UPDATE ouroboros_cycles SET phase = 'absorb_done', outline = ?, outline_hash = ? WHERE id = ?`)
      .run(outlineText, outlineHash, cycleId);

    // Phase 2: ANALYZE — with ancestor context
    db.prepare(`UPDATE ouroboros_cycles SET phase = 'analyze' WHERE id = ?`).run(cycleId);

    const ancestorGenome = getGenome(ancestorCycleId);
    const ancestorContext = ancestorGenome.length > 0
      ? `\n\nThis cycle is forked from generation ${ancestor.generation} (${ancestorCycleId}). Its genome carries ${inheritedGenes} inherited genes:\n${ancestorGenome.map(g => `- [${g.category}] ${g.title}`).join('\n')}\n\nPropose improvements that BUILD ON these proven patterns. Avoid re-proposing what is already in the genome.`
      : '';

    const rawProposals = await analyzeForImprovements(outlineText + ancestorContext);

    const insert = db.prepare(`INSERT INTO ouroboros_proposals (id, cycle_id, category, priority, title, description, target_files, rationale, implementation_sketch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of rawProposals) {
      insert.run(
        uid(), cycleId, p.category || 'refactor', p.priority || 'medium',
        p.title, p.description || '',
        JSON.stringify(p.targetFiles || []),
        p.rationale || '',
        p.implementationSketch || '',
      );
    }

    db.prepare(`UPDATE ouroboros_cycles SET phase = 'analyze_done', proposal_count = ? WHERE id = ?`)
      .run(rawProposals.length, cycleId);

    // Phase 3: REVIEW
    db.prepare(`UPDATE ouroboros_cycles SET phase = 'review' WHERE id = ?`).run(cycleId);
    const storedProposals = db.prepare(`SELECT * FROM ouroboros_proposals WHERE cycle_id = ?`).all(cycleId);
    const reviews = await reviewProposals(storedProposals, outlineText);

    let accepted = 0, rejected = 0;
    const updateP = db.prepare(`UPDATE ouroboros_proposals SET status = ?, review_verdict = ?, review_notes = ? WHERE id = ?`);
    for (const r of reviews) {
      const prop = storedProposals.find(p => p.id === r.proposalId);
      if (!prop) continue;
      const status = r.verdict === 'approve' ? 'accepted' : r.verdict === 'reject' ? 'rejected' : 'needs_revision';
      updateP.run(status, r.verdict, r.notes || '', prop.id);
      if (r.verdict === 'approve') accepted++;
      else if (r.verdict === 'reject') rejected++;
    }
    const unreviewed = storedProposals.filter(p => !reviews.find(r => r.proposalId === p.id));
    for (const p of unreviewed) {
      updateP.run('accepted', 'approve', 'Auto-accepted (not challenged by reviewer)', p.id);
      accepted++;
    }

    addMutations(cycleId, db.prepare(`SELECT id FROM ouroboros_proposals WHERE cycle_id = ? AND status = 'accepted'`).all(cycleId), generation);

    const allGenes = db.prepare(`SELECT proposal_id FROM ouroboros_genome WHERE cycle_id = ? AND active = 1`).all(cycleId);
    const genomeHash = computeGenomeHash(allGenes);

    const durationMs = Date.now() - start;
    const insights = {
      generation, forkedFrom: ancestorCycleId, forkedFromGeneration: ancestor.generation,
      parentCycleId: ancestorCycleId, inheritedGenes,
      filesScanned: outline.stats.totalFiles, linesAnalyzed: outline.stats.totalLines,
      tablesFound: outline.stats.dbTableCount,
      proposalsGenerated: rawProposals.length, accepted, rejected,
      revised: rawProposals.length - accepted - rejected,
      newMutations: db.prepare(`SELECT COUNT(*) as c FROM ouroboros_proposals WHERE cycle_id = ? AND status = 'accepted'`).get(cycleId).c,
      totalGenomeSize: allGenes.length, genomeHash,
      categories: [...new Set(rawProposals.map(p => p.category))],
    };

    db.prepare(`UPDATE ouroboros_cycles SET phase = 'complete', status = 'complete', accepted_count = ?, rejected_count = ?, implemented_count = 0, duration_ms = ?, insights = ?, genome_hash = ? WHERE id = ?`)
      .run(accepted, rejected, durationMs, JSON.stringify(insights), genomeHash, cycleId);

    let workspace = null;
    try { workspace = captureWorkspace(cycleId, rootDir || process.cwd()); } catch {}

    try {
      publish('system', 'system.evolution', JSON.stringify({
        type: 'ouroboros_fork', cycleId, generation, genomeHash,
        forkedFrom: ancestorCycleId, accepted, rejected, durationMs,
        workspaceFingerprint: workspace?.fingerprint || null,
      }));
    } catch (_) {}

    return { cycleId, ...insights, durationMs, workspaceFingerprint: workspace?.fingerprint || null };
  } catch (err) {
    db.prepare(`UPDATE ouroboros_cycles SET status = 'failed', insights = ? WHERE id = ?`)
      .run(JSON.stringify({ error: err.message, forkedFrom: ancestorCycleId }), cycleId);
    throw err;
  }
}

export function compareWorkspaces(cycleIdA, cycleIdB) {
  const diff = diffWorkspaces(cycleIdA, cycleIdB);
  if (!diff) return null;

  const genomeDiff = getGenomeDiff(cycleIdA, cycleIdB);
  const cycleA = db.prepare(`SELECT generation, genome_hash, status, created_at, duration_ms FROM ouroboros_cycles WHERE id = ?`).get(cycleIdA);
  const cycleB = db.prepare(`SELECT generation, genome_hash, status, created_at, duration_ms FROM ouroboros_cycles WHERE id = ?`).get(cycleIdB);

  return {
    cycleA: { id: cycleIdA, ...cycleA },
    cycleB: { id: cycleIdB, ...cycleB },
    workspace: diff,
    genome: genomeDiff,
    summary: {
      generationGap: Math.abs((cycleB?.generation || 1) - (cycleA?.generation || 1)),
      sameGenome: cycleA?.genome_hash === cycleB?.genome_hash,
      identical: diff.identical,
      genesAdded: genomeDiff.added.length,
      genesRemoved: genomeDiff.removed.length,
      genomeSimilarity: genomeDiff.similarity,
    },
  };
}

// ─── Routes ─────────────────────────────────────────────────────────

export function installOuroborosCycleRoutes(app) {
  app.get('/api/intelligence/ouroboros-cycle/stats', (_req, res, next) => {
    try { res.json(getStats()); } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/cycles', (req, res, next) => {
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      res.json({ cycles: listCycles(limit) });
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/cycle/:id', (req, res, next) => {
    try {
      const cycle = getCycle(req.params.id);
      if (!cycle) return res.status(404).json({ error: 'Cycle not found' });
      res.json(cycle);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/cycle/:id/outline', (req, res, next) => {
    try {
      const outline = getOutline(req.params.id);
      if (!outline) return res.status(404).json({ error: 'Outline not found' });
      res.json({ outline });
    } catch (e) { next(e); }
  });

  app.post('/api/intelligence/ouroboros-cycle/run', async (req, res, next) => {
    try {
      const result = await runCycle(req.body.rootDir || process.cwd());
      res.json(result);
    } catch (e) { next(e); }
  });

  app.post('/api/intelligence/ouroboros-cycle/absorb', (req, res, next) => {
    try {
      const outline = absorbCodebase(req.body.rootDir || process.cwd());
      const text = outlineToText(outline);
      res.json({ stats: outline.stats, outline: text });
    } catch (e) { next(e); }
  });

  app.put('/api/intelligence/ouroboros-cycle/proposal/:id/status', (req, res, next) => {
    try {
      const { status } = req.body;
      if (!['accepted', 'rejected', 'implemented', 'needs_revision'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const p = updateProposalStatus(req.params.id, status);
      if (!p) return res.status(404).json({ error: 'Proposal not found' });
      res.json(p);
    } catch (e) { next(e); }
  });

  // ── Lineage endpoints ──

  app.get('/api/intelligence/ouroboros-cycle/lineage', (_req, res, next) => {
    try { res.json(getFullLineageTree()); } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/lineage/:id', (req, res, next) => {
    try {
      const depth = Math.min(100, Math.max(1, parseInt(req.query.depth) || 50));
      res.json({ ancestry: getLineage(req.params.id, depth) });
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/genome/:id', (req, res, next) => {
    try {
      const genome = getGenomeForCycle(req.params.id);
      if (!genome) return res.status(404).json({ error: 'Cycle not found' });
      res.json({ genes: genome, total: genome.length });
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/genome-diff', (req, res, next) => {
    try {
      const { a, b } = req.query;
      if (!a || !b) return res.status(400).json({ error: 'Provide ?a=cycleId&b=cycleId' });
      res.json(getGenomeDiff(a, b));
    } catch (e) { next(e); }
  });

  // ── Workspace endpoints ──

  app.get('/api/intelligence/ouroboros-cycle/workspace/:cycleId', (req, res, next) => {
    try {
      const ws = getWorkspace(req.params.cycleId);
      if (!ws) return res.status(404).json({ error: 'No workspace captured for this cycle' });
      res.json(ws);
    } catch (e) { next(e); }
  });

  app.post('/api/intelligence/ouroboros-cycle/workspace/:cycleId/capture', (req, res, next) => {
    try {
      const ws = captureWorkspace(req.params.cycleId, req.body.rootDir || process.cwd());
      if (!ws) return res.status(404).json({ error: 'Cycle not found' });
      res.json(ws);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/workspace-diff', (req, res, next) => {
    try {
      const { a, b } = req.query;
      if (!a || !b) return res.status(400).json({ error: 'Provide ?a=cycleId&b=cycleId' });
      const diff = diffWorkspaces(a, b);
      if (!diff) return res.status(404).json({ error: 'Workspace not found for one or both cycles' });
      res.json(diff);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/workspaces', (_req, res, next) => {
    try {
      const workspaces = db.prepare(`SELECT id, cycle_id, generation, fingerprint, created_at FROM ouroboros_workspaces ORDER BY generation DESC`).all();
      res.json({ workspaces });
    } catch (e) { next(e); }
  });

  // ── Fork & Compare endpoints ──

  app.post('/api/intelligence/ouroboros-cycle/fork/:cycleId', async (req, res, next) => {
    try {
      const result = await forkCycle(req.params.cycleId, req.body.rootDir || process.cwd());
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/ouroboros-cycle/compare', (req, res, next) => {
    try {
      const { a, b } = req.query;
      if (!a || !b) return res.status(400).json({ error: 'Provide ?a=cycleId&b=cycleId' });
      const result = compareWorkspaces(a, b);
      if (!result) return res.status(404).json({ error: 'Could not compare — workspace missing for one or both cycles' });
      res.json(result);
    } catch (e) { next(e); }
  });
}
