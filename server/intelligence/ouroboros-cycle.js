import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import fs from 'node:fs';
import path from 'node:path';

// ─── Schema ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ouroboros_cycles (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'absorb',
    status TEXT NOT NULL DEFAULT 'running',
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
  CREATE INDEX IF NOT EXISTS idx_proposals_cycle ON ouroboros_proposals(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_proposals_status ON ouroboros_proposals(status);
`);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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

  db.prepare(`INSERT INTO ouroboros_cycles (id, phase, status) VALUES (?, 'absorb', 'running')`).run(cycleId);

  try {
    // Phase 1: ABSORB
    const outline = absorbCodebase(rootDir || process.cwd());
    const outlineText = outlineToText(outline);
    const outlineHash = Buffer.from(outlineText.slice(0, 1000)).toString('base64').slice(0, 32);

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

    const durationMs = Date.now() - start;
    const insights = {
      filesScanned: outline.stats.totalFiles,
      linesAnalyzed: outline.stats.totalLines,
      tablesFound: outline.stats.dbTableCount,
      proposalsGenerated: rawProposals.length,
      accepted, rejected,
      revised: rawProposals.length - accepted - rejected,
      categories: [...new Set(rawProposals.map(p => p.category))],
    };

    db.prepare(`UPDATE ouroboros_cycles SET phase = 'complete', status = 'complete', accepted_count = ?, rejected_count = ?, duration_ms = ?, insights = ? WHERE id = ?`)
      .run(accepted, rejected, durationMs, JSON.stringify(insights), cycleId);

    return { cycleId, ...insights, durationMs };

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
}
