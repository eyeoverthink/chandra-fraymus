// Independent Phase 2A review. No live app/database import.
// Usage: node this_file.mjs --ref COMMIT --upstream PINNED_DIRECTORY --output FILE
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--ref') && arg('--upstream') && arg('--output'));
const ref = execFileSync('git', ['rev-parse', arg('--ref')], { cwd: root, encoding: 'utf8' }).trim();
const cache = new Map(), sourceHashes = {};
const sha = text => createHash('sha256').update(text).digest('hex');
function source(path) {
  if (!cache.has(path)) {
    const content = execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
    cache.set(path, content); sourceHashes[path] = sha(content);
  }
  return cache.get(path);
}
function moduleFrom(path, bindings, names) {
  const body = source(path).replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '').replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body));
  return new vm.Script(`(() => { ${body}\nreturn { ${names} }; })()`, { filename: path }).runInNewContext({ Date, Math, JSON, console, ...bindings });
}
const directory = mkdtempSync(join(tmpdir(), 'chandra-phase2a-review-'));
const dataDir = join(directory, 'data'); mkdirSync(dataDir);
const upstream = resolve(arg('--upstream'));
const gateBytes = readFileSync(join(upstream, 'docs/BUILD-GATES.md'));
const gitBlob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${gateBytes.length}\0`), gateBytes])).digest('hex');
assert.equal(gitBlob, '43377715d18c7d892fa71c3dab3167da070f6936');
const upstreamGates = [...gateBytes.toString('utf8').matchAll(/^(\d+)\. \*\*(.*?)\*\*(.*)$/gm)].map(m => ({ gate: Number(m[1]), title: m[2], detail: m[3].trim() }));
assert.equal(upstreamGates.length, 18);
const db = new Database(':memory:');
const ddl = source('server/db-migrate.js');
const tableDDL = table => ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0];
db.exec(tableDDL('agent_memories'));
db.exec('CREATE UNIQUE INDEX idx_review_agent_key ON agent_memories(agent_id,key)');
db.exec(tableDDL('custom_agents'));
db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,role TEXT)');
db.prepare('INSERT INTO agents(id,name,role) VALUES(?,?,?)').run('fixture-host', 'Fixture host', 'host node');
const memory = moduleFrom('server/fleet/agent-memory.js', { db }, 'storeMemory,recallMemories,verifyMemory');
const hive = moduleFrom('server/intelligence/hive-bridge.js', { db, createHash, readFileSync, statSync, publish: () => { throw new Error('No ingestion authorized in Phase 2A probe'); } }, 'verifyHiveChain');
const re = moduleFrom('server/fleet/re-tools.js', { ...memory, verifyHiveChain: hive.verifyHiveChain }, 'seedBuildGates,createRETools,BUILD_GATES');
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const firstSeed = re.seedBuildGates();
const initialRows = db.prepare('SELECT * FROM agent_memories ORDER BY id').all();
check('fresh fixture gets eighteen build-gate rows at confidence 0.9', firstSeed.seeded === 18 && initialRows.length === 18 && initialRows.every(r => r.confidence === 0.9));
const catalogComparison = re.BUILD_GATES.map(g => ({ gate: g.gate, seededTitle: g.title, upstreamTitle: upstreamGates.find(u => u.gate === g.gate).title }));
check('source and seed disagree on gate 1 identity', catalogComparison[0].upstreamTitle.includes('sudo hang') && catalogComparison[0].seededTitle.includes('JDK'));
check('source and seed disagree on gate 7 identity', catalogComparison[6].upstreamTitle.includes('install-scripts') && catalogComparison[6].seededTitle.includes('Python 3.12'));
check('source and seed disagree on gate 18 identity', catalogComparison[17].upstreamTitle.includes('r2ai') && catalogComparison[17].seededTitle.includes('permission'));
const tools = re.createRETools();
const lookup = tools.find(t => t.name === 're.build_gate_lookup');
const lookupResults = [];
for (const keyword of ['JDK', 'dylib', 'npm']) lookupResults.push(await lookup.execute({ args: { keyword } }));
check('lookup searches return stored keyword matches', lookupResults.every(r => r.matches > 0));
const localValue = JSON.stringify({ gate: 1, title: 'Locally reproduced correction', fix: 'Preserve this verified fixture lesson' });
const lesson = memory.storeMemory('re-analyst', 'build_gate', 'build_gate_1', localValue, { confidence: 1.0, source: 'local reproduction fixture' });
memory.verifyMemory(lesson.id);
const beforeReseed = db.prepare('SELECT * FROM agent_memories WHERE id=?').get(lesson.id);
const reseed = re.seedBuildGates();
const afterReseed = db.prepare('SELECT * FROM agent_memories WHERE id=?').get(lesson.id);
check('startup reseeding overwrites a locally verified correction and lowers confidence', afterReseed.value !== localValue && afterReseed.confidence === 0.9 && afterReseed.source !== beforeReseed.source);
check('replacement content retains the old verified_at flag', afterReseed.verified_at === beforeReseed.verified_at && afterReseed.verified_at !== null);
check('seeding reports eighteen skipped despite mutating existing rows', reseed.skipped === 18 && afterReseed.access_count > beforeReseed.access_count);

mkdirSync(join(directory, 'agents'));
for (const file of ['re-analyst.md', 'rea_analyst.md']) writeFileSync(join(directory, 'agents', file), source(`agents/${file}`));
const manifests = moduleFrom('server/fleet/manifest.js', { DATA_DIR: dataDir, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, join, resolve }, 'parseManifest,loadManifests');
const fleet = moduleFrom('server/fleet/runtime.js', { db, loadManifests: manifests.loadManifests }, 'initFleet,setFleetTools,listAgents,getAgent,agentTools,startRun,decideApproval,saveAgentManifest,resetAgentManifest,listThreads,getThread');
fleet.initFleet({});
fleet.setFleetTools([...tools, ...['bus_publish', 'bus_read', 'agent_remember', 'agent_recall', 'forbidden_fixture_tool'].map(name => ({ name }))]);
const reManifest = fleet.getAgent('local', 're-analyst');
const tycho = fleet.getAgent('local', 'rea_analyst');
check('actual manifest loader discovers RE Analyst with ten explicit tools', reManifest.tools.length === 10 && reManifest.tools !== '*');
check('actual fleet allowlist excludes an unrelated registered tool', fleet.agentTools(reManifest).length === 10 && !fleet.agentTools(reManifest).some(t => t.name === 'forbidden_fixture_tool'));
check('actual loader retains the separate Tycho manifest', tycho.id === 'rea_analyst' && tycho.name === 'Tycho');
const bridgeTool = tools.find(t => t.name === 're.verify_chain');
const rawResult = await bridgeTool.execute({ args: { path: join(upstream, 'hive/receipts.jsonl') } });
const projectionPath = join(directory, 'projection.jsonl'); writeFileSync(projectionPath, JSON.stringify({ src: 'fixture', msg: 'fixture' }) + '\n');
const projectionResult = await bridgeTool.execute({ args: { path: projectionPath } });
check('actual RE wrapper returns valid raw status and rejects projection verification', rawResult.total === 13 && rawResult.intact && !!projectionResult.error);
const deferred = [];
for (const name of ['re.ingest_dossier', 're.query_dossier', 're.compile_rate_measure', 're.compile_rate_predict']) {
  try { await tools.find(t => t.name === name).execute({ args: { dossierPath: '/fixture' } }); deferred.push({ name, deferred: false }); }
  catch (e) { deferred.push({ name, deferred: e.message.includes('Phase 3') }); }
}
check('four Phase 2B tools explicitly defer instead of faking measurements', deferred.every(r => r.deferred));
const registration = { spread: source('server/fleet/tools.js').includes('...createRETools(),'), startupSeed: source('server/runtime.js').includes('const bg = seedBuildGates()') };
check('fleet registry spread and startup seed are wired in source', registration.spread && registration.startupSeed);

const app = express();
const hostRoute = source('server/app.js').match(/app\.get\('\/api\/agents',[\s\S]*?\n\}\);/)[0];
new vm.Script(hostRoute).runInNewContext({ app, db });
moduleFrom('server/fleet/routes.js', fleet, 'installFleetRoutes').installFleetRoutes(app);
app.use((e, _req, res, _next) => res.status(500).json({ error: e.message }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let api;
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const host = await (await fetch(`${base}/api/agents`)).json();
  const manifestList = await (await fetch(`${base}/api/fleet/agents`)).json();
  const selected = manifestList.agents.find(a => a.id === 're-analyst');
  check('declared /api/agents gate targets host rows rather than manifest-backed fleet', !host.some(a => a.id === 're-analyst') && selected.tools.length === 10);
  api = { hostAgentIds: host.map(a => a.id), fleetAgentIds: manifestList.agents.map(a => a.id), reAnalystToolCount: selected.tools.length, fleetTaskSubmitted: false, modelResponseVerified: false };
} finally { await new Promise(resolve => server.close(resolve)); }

// Reproduce the author test only with CHANDRA_DATA_DIR forced to a disposable
// directory. The submitted default command imports and writes the real DB.
const authorDir = join(directory, 'author-data'); mkdirSync(authorDir);
const authorDb = new Database(join(authorDir, 'chandra.db'));
authorDb.exec(tableDDL('agent_memories')); authorDb.exec('CREATE UNIQUE INDEX idx_review_author_key ON agent_memories(agent_id,key)'); authorDb.close();
const authorScript = 'docs/reviews/2026-11-05-phase2a-gate-acceptance.mjs';
const authorScriptText = source(authorScript);
for (const path of [authorScript, 'server/fleet/re-tools.js', 'server/intelligence/hive-bridge.js', 'server/fleet/agent-memory.js', 'agents/re-analyst.md']) assert.equal(sha(readFileSync(join(root, path), 'utf8')), sha(source(path)), `Working source drift: ${path}`);
const authorOutput = join(directory, 'author-evidence.json');
const child = spawnSync(process.execPath, [join(root, authorScript), '--output', authorOutput], { cwd: root, env: { ...process.env, CHANDRA_DATA_DIR: authorDir }, encoding: 'utf8', timeout: 20000 });
const authorEvidence = existsSync(authorOutput) ? JSON.parse(readFileSync(authorOutput, 'utf8')) : null;
check('author script reproduces reported passes in a prepared disposable database', child.status === 0 && authorEvidence.summary.failed === 0);
check('author script directly imports DB-owning modules and never submits the required fleet task', authorScriptText.includes("await import(pathToFileURL(resolve(ROOT, 'server/fleet/re-tools.js'))") && !authorScriptText.includes('/api/fleet/runs') && !authorScriptText.includes('fetch('));
const authorData = new Database(join(authorDir, 'chandra.db'), { readonly: true });
const authorSeeded = authorData.prepare('SELECT COUNT(*) AS n FROM agent_memories').get().n; authorData.close();
check('author acceptance run writes eighteen memories into its selected database', authorSeeded === 18);

const gateResults = [
  { id: 'RE-P2A-G1', status: 'PARTIAL', detail: 'Actual manifest and fleet API have ten tools; spec /api/agents route is a different host-node registry.' },
  { id: 'RE-P2A-G2', status: rawResult.intact && !!projectionResult.error ? 'PASS_ISOLATED' : 'FAIL', detail: 'Wrapper works on positive raw/projection fixtures; underlying Phase 1 findings remain open.' },
  { id: 'RE-P2A-G3', status: 'PARTIAL', detail: 'Keyword search works, but seeded gate identities/content do not match documented upstream source.' },
  { id: 'RE-P2A-G4', status: 'FAIL', detail: 'Eighteen confidence-0.9 rows exist, but sourced lessons are substituted and startup overwrites local verified corrections.' },
  { id: 'RE-P2A-G5', status: 'PARTIAL', detail: 'Tycho manifest coexists; functional model-backed execution not exercised.' },
  { id: 'RE-P2A-G6', status: 'UNVERIFIED', detail: 'Required POST /api/fleet/runs response was replaced by tool-registration checks in author test.' },
];
const evidence = { generatedAt: new Date().toISOString(), implementationRef: ref, upstreamRef: '2f75cee7f54a4aa6bae219ec9241fc44f980c36b', upstreamBuildGateBlob: gitBlob, sourceHashes,
  safety: 'Pinned production bodies evaluated with in-memory SQLite and temporary manifest/data directories. Actual fleet GET routes tested on ephemeral loopback. No fleet run/model call. Author script run only in a child with CHANDRA_DATA_DIR explicitly set to a prepared disposable database. No live DB opened/checkpointed or server restarted.',
  retainedTemporaryDirectory: directory, checks, diagnosticAssertionCount: checks.length, firstSeed, initialConfidenceCount: initialRows.filter(r => r.confidence === 0.9).length, catalogComparison, lookupResults, reseed: { result: reseed, before: beforeReseed, after: afterReseed }, manifest: { id: reManifest.id, tools: reManifest.tools, tychoId: tycho.id, effectiveAllowedTools: fleet.agentTools(reManifest).map(t => t.name) }, rawResult, projectionResult, deferred, registration, api, authorRerun: { status: child.status, stdout: child.stdout, stderr: child.stderr, evidence: authorEvidence, seededRows: authorSeeded }, gateResults,
  summary: { scopedPasses: 1, failures: 1, partial: 3, unverified: 1, independentlyAcceptedPhases: 0 } };
db.close();
writeFileSync(resolve(arg('--output')), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ implementationRef: ref, diagnosticAssertions: checks.length, authorReported: authorEvidence.summary, ...evidence.summary, output: resolve(arg('--output')) }));
