// Independent fix review. Diagnostics cover successful controls and remaining defects.
// Usage: node this_file.mjs --upstream PINNED_DIRECTORY --output FILE
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import Database from 'better-sqlite3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = 'e8410f30c7344cd291014e01cb3c971725d65dcf';
const oldRef = 'dcb065868448978ac5f8b963b7e326ca64a7b374';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--upstream') && arg('--output'));
const sha = data => createHash('sha256').update(data).digest('hex');
const cache = new Map(), sourceHashes = {};
function source(path, pin = ref) {
  const key = `${pin}:${path}`;
  if (!cache.has(key)) {
    const content = execFileSync('git', ['show', key], { cwd: root, encoding: 'utf8' });
    cache.set(key, content); sourceHashes[key] = sha(content);
  }
  return cache.get(key);
}
function moduleFrom(path, bindings, names, pin = ref) {
  const body = source(path, pin).replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '').replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body));
  return new vm.Script(`(() => { ${body}\nreturn { ${names} }; })()`, { filename: path }).runInNewContext({ Date, Math, JSON, console, ...bindings });
}
const directory = mkdtempSync(join(tmpdir(), 'chandra-2a-fix-review-'));
const ddl = source('server/db-migrate.js').match(/CREATE TABLE IF NOT EXISTS agent_memories \([\s\S]*?\n\s*\)/)[0];
function context() {
  const db = new Database(':memory:'); db.exec(ddl);
  db.exec('CREATE UNIQUE INDEX fixture_key_identity ON agent_memories(agent_id,key)');
  const memory = moduleFrom('server/fleet/agent-memory.js', { db }, 'storeMemory,recallMemories,verifyMemory');
  const build = pin => moduleFrom('server/fleet/re-tools.js', { db, ...memory, verifyHiveChain: () => { throw new Error('Not used in seeding review'); } }, 'seedBuildGates,createRETools,BUILD_GATES', pin);
  return { db, memory, re: build(ref), legacy: () => build(oldRef) };
}
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const row = db => db.prepare("SELECT * FROM agent_memories WHERE agent_id='re-analyst' AND key='build_gate_L1'").get();
const ordinary = context();
let preservation, catalog;
try {
  const first = ordinary.re.seedBuildGates();
  const all = ordinary.db.prepare('SELECT * FROM agent_memories ORDER BY id').all();
  check('fresh seeding creates eighteen local-ID entries with reconstructed source labels', first.seeded === 18 && all.every(m => JSON.parse(m.value).localId && m.source.includes('not verified')));
  const local = ordinary.memory.storeMemory('re-analyst', 'build_gate', 'build_gate_L1', 'LOCALLY_VERIFIED_CORRECTION', { confidence: 1.0, source: 'local reproduction fixture' });
  ordinary.memory.verifyMemory(local.id);
  const before = row(ordinary.db), reseed = ordinary.re.seedBuildGates(), after = row(ordinary.db);
  check('same-category reseeding preserves the entire verified row unchanged', JSON.stringify(before) === JSON.stringify(after) && reseed.skipped === 18);
  preservation = { first, reseed, before, after };
  catalog = { localIds: ordinary.re.BUILD_GATES.map(g => g.localId), stillReconstructed: all.every(m => m.source.includes('not verified')), storedConfidence: all[1].confidence, toolDescription: ordinary.re.createRETools().find(t => t.name === 're.build_gate_lookup').description };
} finally { ordinary.db.close(); }

const reclassified = context();
let crossCategory;
try {
  const local = reclassified.memory.storeMemory('re-analyst', 'local_fix', 'build_gate_L1', 'LOCALLY_VERIFIED_RECLASSIFIED_CORRECTION', { confidence: 1.0, source: 'local reproduction fixture' });
  reclassified.memory.verifyMemory(local.id);
  const before = row(reclassified.db), seeded = reclassified.re.seedBuildGates(), after = row(reclassified.db);
  check('a recategorized existing key is still overwritten and downgraded', before.category === 'local_fix' && after.category === 'build_gate' && after.value !== before.value && after.confidence === 0.9);
  check('recategorized replacement still inherits the prior value verification stamp', after.verified_at === before.verified_at && after.verified_at !== null);
  crossCategory = { before, seeded, after };
} finally { reclassified.db.close(); }

const upgradeCtx = context();
let upgrade;
try {
  upgradeCtx.legacy().seedBuildGates();
  const before = upgradeCtx.db.prepare('SELECT COUNT(*) AS n FROM agent_memories').get().n;
  const seed = upgradeCtx.re.seedBuildGates();
  const all = upgradeCtx.db.prepare('SELECT * FROM agent_memories').all();
  const lookup = await upgradeCtx.re.createRETools().find(t => t.name === 're.build_gate_lookup').execute({ args: { keyword: 'JDK' } });
  check('upgrading the prior seeder leaves eighteen old rows and adds eighteen new rows', before === 18 && all.length === 36 && seed.seeded === 18);
  const falselySourced = all.filter(m => m.source === 'BUILD-GATES.md (upstream, not reproduced locally)');
  check('upgrade preserves the eighteen prior false source attributions', falselySourced.length === 18);
  check('lookup mixes old numeric IDs and new local IDs without returning source labels', lookup.gates.some(g => typeof g.gate === 'number') && lookup.gates.some(g => g.localId) && lookup.gates.every(g => !Object.hasOwn(g, 'source')));
  upgrade = { beforeRows: before, afterRows: all.length, seed, falselySourcedRows: falselySourced.length, jdkLookup: lookup };
} finally { upgradeCtx.db.close(); }

const upstream = resolve(arg('--upstream'));
const gateBytes = readFileSync(join(upstream, 'docs/BUILD-GATES.md'));
const upstreamBlob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${gateBytes.length}\0`), gateBytes])).digest('hex');
assert.equal(upstreamBlob, '43377715d18c7d892fa71c3dab3167da070f6936');
const upstreamHeadings = [...gateBytes.toString('utf8').matchAll(/^(\d+)\. \*\*(.*?)\*\*/gm)].map(m => ({ gate: Number(m[1]), title: m[2] }));
check('the exact eighteen-entry upstream source is available locally for this review', upstreamHeadings.length === 18);
const scriptPath = 'docs/reviews/2026-11-05-phase2a-gate-acceptance.mjs';
const script = source(scriptPath);
const sourceMentionsTaskPost = script.includes("fetch(") || script.includes('startRun(');
check('new G6b still checks Map discovery without running an agent', script.includes("manifests.get('re-analyst')") && !sourceMentionsTaskPost);
check('test data-directory override precedes the first DB-owning import', script.indexOf('process.env.CHANDRA_DATA_DIR = DISPOSABLE_DIR') < script.indexOf('await import('));

// Prove isolation even when the child inherits a different data-directory value.
const sentinel = join(directory, 'sentinel-data'); mkdirSync(sentinel);
const sentinelDb = join(sentinel, 'chandra.db'); writeFileSync(sentinelDb, 'DO_NOT_OPEN_OR_CHANGE');
const sentinelHash = sha(readFileSync(sentinelDb));
const authorOutput = join(directory, 'author-evidence.json');
for (const path of [scriptPath, 'server/fleet/re-tools.js', 'server/fleet/agent-memory.js', 'server/config.js', 'server/db.js', 'server/db-migrate.js']) assert.equal(sha(readFileSync(join(root, path), 'utf8')), sha(source(path)), `Working source drift: ${path}`);
const child = spawnSync(process.execPath, [join(root, scriptPath), '--output', authorOutput], { cwd: root, env: { ...process.env, CHANDRA_DATA_DIR: sentinel }, encoding: 'utf8', timeout: 20000 });
const authorEvidence = existsSync(authorOutput) ? JSON.parse(readFileSync(authorOutput, 'utf8')) : null;
check('author test reproduces eleven successful subchecks with built-in disposable persistence', child.status === 0 && authorEvidence.summary.passed === 11 && authorEvidence.summary.failed === 0);
check('inherited sentinel database remains byte-identical and is not the selected test directory', sha(readFileSync(sentinelDb)) === sentinelHash && authorEvidence.disposableDir !== sentinel);
const cleanupLeftovers = existsSync(authorEvidence.disposableDir) ? readdirSync(authorEvidence.disposableDir) : [];
const changes = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', ref], { cwd: root, encoding: 'utf8' }).trim().split('\n');
check('claimed tracker update is absent from the two-file fix commit', changes.length === 2 && !changes.includes('docs/RE-AGENT-PROGRESS.md'));

const gateResults = [
  { id: 'RE-P2A-G1', status: 'PARTIAL', detail: 'No change to the mismatched spec endpoint; actual discovery remains confirmed by prior review.' },
  { id: 'RE-P2A-G2', status: 'PASS_ISOLATED', detail: 'Wrapper unchanged from independently tested positive fixtures; Phase 1 findings remain open.' },
  { id: 'RE-P2A-G3', status: 'PARTIAL', detail: 'Reconstructed keyword entries still substitute for source lessons; upgraded lookups mix old and new identities.' },
  { id: 'RE-P2A-G4', status: 'FAIL', detail: 'Actual source not imported; upgrade retains false provenance and creates 36 rows; category-scoped skip can still overwrite existing keys.' },
  { id: 'RE-P2A-G5', status: 'PARTIAL', detail: 'Manifest coexistence unchanged; model-backed functional regression still unverified.' },
  { id: 'RE-P2A-G6', status: 'UNVERIFIED', detail: 'Map.get is discovery; POST /api/fleet/runs and a response are not exercised.' },
];
const evidence = { generatedAt: new Date().toISOString(), implementationRef: ref, previousRef: oldRef, upstreamRef: '2f75cee7f54a4aa6bae219ec9241fc44f980c36b', upstreamBuildGateBlob: upstreamBlob, sourceHashes,
  safety: 'Pinned seeder/memory function bodies evaluated in disposable in-memory SQLite. Author script runs only as a child after source inspection confirms its data override precedes imports; inherited sentinel is an extra disposable file. No live app/database import by reviewer, no fleet/model run, no server restart.',
  retainedTemporaryDirectory: directory, checks, diagnosticAssertionCount: checks.length, preservation, catalog, crossCategory, upgrade, upstreamHeadings, sourceMentionsTaskPost, changedFiles: changes,
  authorRerun: { status: child.status, stdout: child.stdout, stderr: child.stderr, evidence: authorEvidence, sentinelUnchanged: true, cleanupLeftovers }, gateResults,
  findingDisposition: { 'RE2A-01': 'PARTIAL: new labels are more honest, but source requirement and existing false-attribution migration remain open', 'RE2A-02': 'PARTIAL: same-category preservation fixed; recategorized keys still overwritten', 'RE2A-03': 'SCOPED_FIX_CONFIRMED: default test data override and schema migration verified', 'RE2A-04': 'OPEN: manifest discovery does not meet task/response gate' },
  summary: { scopedPasses: 1, failures: 1, partial: 3, unverified: 1, independentlyAcceptedPhases: 0 } };
writeFileSync(resolve(arg('--output')), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ diagnosticAssertions: checks.length, authorReported: authorEvidence.summary, ...evidence.summary, cleanupLeftovers, output: resolve(arg('--output')) }));
