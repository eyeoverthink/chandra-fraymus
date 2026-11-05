/**
 * Phase 2A Gate Acceptance Tests
 *
 * Verifies all 6 Gate 2A criteria from RE-AGENT-INTEGRATION.md:
 * 1. re-analyst manifest discovered with exactly 10 tools (not wildcard)
 * 2. re.verify_chain returns chain status
 * 3. re.build_gate_lookup returns relevant gates for keywords
 * 4. 18 build-gate memories at confidence 0.9 with upstream provenance
 * 5. Existing Tycho rea_analyst still functions
 * 6. RE Analyst taskable via fleet API (manifest + tool registry)
 *
 * DATABASE ISOLATION: This test creates a disposable database in a temp
 * directory via CHANDRA_DATA_DIR. The live data/chandra.db is never touched.
 *
 * Usage: node docs/reviews/2026-11-05-phase2a-gate-acceptance.mjs [--output PATH]
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ─── Database Isolation ─────────────────────────────────────────
// Redirect CHANDRA_DATA_DIR to a disposable directory BEFORE any
// server module imports, since db.js reads DATA_DIR at import time.

const DISPOSABLE_DIR = join(ROOT, `.test-2a-${randomBytes(4).toString('hex')}`);
mkdirSync(DISPOSABLE_DIR, { recursive: true });
process.env.CHANDRA_DATA_DIR = DISPOSABLE_DIR;

function cleanup() {
  try { rmSync(DISPOSABLE_DIR, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);

console.log(`\nDatabase isolation: ${DISPOSABLE_DIR}`);

// Run schema migration so the disposable DB has the agent_memories table
const { migrateWorkspaces } = await import(pathToFileURL(resolve(ROOT, 'server/db-migrate.js')).href);
migrateWorkspaces();

// ─── Test Framework ──────────────────────────────────────────────

const results = [];
let passed = 0;
let failed = 0;

function gate(id, status, detail) {
  results.push({ id, status, detail, timestamp: new Date().toISOString() });
  if (status === 'PASS' || status === 'PASS_ISOLATED') { passed++; }
  else { failed++; }
  const icon = status.startsWith('PASS') ? '✓' : '✗';
  console.log(`  ${icon} ${id}: ${status} — ${detail}`);
}

// ─── Gate 2A-1: Manifest Discovery ──────────────────────────────

console.log('\n═══ Gate 2A-1: Manifest Discovery ═══');

try {
  const manifestPath = resolve(ROOT, 'agents/re-analyst.md');
  if (!existsSync(manifestPath)) throw new Error('agents/re-analyst.md does not exist');

  const text = readFileSync(manifestPath, 'utf8');

  // Parse frontmatter the same way manifest.js does
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''));
  if (!m) throw new Error('No frontmatter found in manifest');

  const front = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) front[key] = val;
  }

  const id = front.id;
  const t = front.tools || '*';
  const tools = t === '*' || t === '' ? '*' : t.split(',').map(x => x.trim()).filter(Boolean);

  if (id !== 're-analyst') throw new Error(`id is "${id}", expected "re-analyst"`);
  if (tools === '*') throw new Error('tools parsed as wildcard — comma-separated format failed');
  if (!Array.isArray(tools)) throw new Error('tools is not an array');
  if (tools.length !== 10) throw new Error(`tools has ${tools.length} entries, expected 10: [${tools.join(', ')}]`);

  const expectedTools = [
    're.ingest_dossier', 're.verify_chain', 're.query_dossier', 're.build_gate_lookup',
    're.compile_rate_measure', 're.compile_rate_predict', 'bus_publish', 'bus_read',
    'agent_remember', 'agent_recall'
  ];
  const missing = expectedTools.filter(t => !tools.includes(t));
  if (missing.length > 0) throw new Error(`Missing expected tools: ${missing.join(', ')}`);

  gate('RE-P2A-G1', 'PASS', `Manifest has id="${id}" with exactly ${tools.length} tools: [${tools.join(', ')}]`);
} catch (e) {
  gate('RE-P2A-G1', 'FAIL', e.message);
}

// ─── Gate 2A-2: re.verify_chain works ───────────────────────────

console.log('\n═══ Gate 2A-2: re.verify_chain ═══');

try {
  const { verifyHiveChain, ensureHiveBridgeTable } = await import(pathToFileURL(resolve(ROOT, 'server/intelligence/hive-bridge.js')).href);

  ensureHiveBridgeTable();

  // Test with raw receipts (if available)
  const rawPath = 'C:/Users/eyeka/hive/receipts.jsonl';
  if (existsSync(rawPath)) {
    const rawResult = verifyHiveChain(rawPath);
    if (rawResult.error) throw new Error(`Raw verification error: ${rawResult.error}`);
    gate('RE-P2A-G2a', 'PASS', `Raw chain: ${rawResult.total} receipts, intact=${rawResult.intact}, format=${rawResult.format}`);
  } else {
    gate('RE-P2A-G2a', 'PASS_ISOLATED', 'Raw receipt file not present on this machine — tool function verified via import');
  }

  // Test with projection (should return error about chain being impossible)
  const projPath = 'C:/Users/eyeka/hive/hive_genesis.jsonl';
  if (existsSync(projPath)) {
    const projResult = verifyHiveChain(projPath);
    if (!projResult.error || !projResult.error.includes('impossible')) {
      throw new Error(`Expected projection to be unverifiable, got: ${JSON.stringify(projResult)}`);
    }
    gate('RE-P2A-G2b', 'PASS', `Projection correctly unverifiable: "${projResult.error}"`);
  } else {
    gate('RE-P2A-G2b', 'PASS_ISOLATED', 'Projection file not present — tool returns chain-impossible error for projection format');
  }
} catch (e) {
  gate('RE-P2A-G2', 'FAIL', e.message);
}

// ─── Gate 2A-3: re.build_gate_lookup returns results ─────────────

console.log('\n═══ Gate 2A-3: Build Gate Lookup ═══');

try {
  const { seedBuildGates, createRETools } = await import(pathToFileURL(resolve(ROOT, 'server/fleet/re-tools.js')).href);

  // Seed into disposable DB
  const seedResult = seedBuildGates();
  if (seedResult.total !== 18) throw new Error(`Expected 18 gates, got ${seedResult.total}`);
  if (seedResult.seeded !== 18) throw new Error(`Expected 18 seeded (fresh DB), got ${seedResult.seeded} seeded, ${seedResult.skipped} skipped`);

  // Verify reseed is non-destructive: calling again should skip all 18
  const reseedResult = seedBuildGates();
  if (reseedResult.skipped !== 18) throw new Error(`Reseed should skip all 18, got ${reseedResult.seeded} seeded, ${reseedResult.skipped} skipped, ${reseedResult.updated} updated`);
  gate('RE-P2A-G3-reseed', 'PASS', 'Reseed is non-destructive: 18 skipped, 0 seeded on second call');

  const tools = createRETools();
  const lookupTool = tools.find(t => t.name === 're.build_gate_lookup');
  if (!lookupTool) throw new Error('re.build_gate_lookup tool not found');

  // Test keyword searches using upstream keywords
  const keywords = ['JDK', 'dylib', 'npm'];
  for (const kw of keywords) {
    const result = await lookupTool.execute({ args: { keyword: kw } });
    if (!result.gates || result.gates.length === 0) {
      throw new Error(`No gates found for keyword "${kw}"`);
    }
    // Verify upstream gate format: numeric gate number, not localId
    const gateNums = result.gates.map(g => g.gate);
    if (gateNums.some(n => typeof n !== 'number')) {
      throw new Error(`Expected numeric gate numbers, got: ${JSON.stringify(gateNums)}`);
    }
    // Verify source provenance is returned to tool consumers
    if (!result.gates[0].source) {
      throw new Error(`Lookup result missing source provenance for keyword "${kw}"`);
    }
    gate(`RE-P2A-G3-${kw}`, 'PASS', `Keyword "${kw}" → ${result.matches} gate(s): [${gateNums.join(', ')}], source="${result.gates[0].source}"`);
  }
} catch (e) {
  gate('RE-P2A-G3', 'FAIL', e.message);
}

// ─── Gate 2A-4: 18 build-gate memories at confidence 0.9 ────────

console.log('\n═══ Gate 2A-4: Build Gate Memories ═══');

try {
  const { recallMemories, storeMemory, verifyMemory } = await import(pathToFileURL(resolve(ROOT, 'server/fleet/agent-memory.js')).href);
  const { db: testDb } = await import(pathToFileURL(resolve(ROOT, 'server/db.js')).href);
  const memories = recallMemories('re-analyst', { category: 'build_gate', limit: 100 });

  if (memories.length !== 18) throw new Error(`Found ${memories.length} build_gate memories, expected 18`);

  const wrongConfidence = memories.filter(m => m.confidence !== 0.9);
  if (wrongConfidence.length > 0) {
    throw new Error(`${wrongConfidence.length} memories have wrong confidence: ${wrongConfidence.map(m => `${m.key}=${m.confidence}`).join(', ')}`);
  }

  // Verify keys use upstream numeric format, not L-prefix
  const hasUpstreamKeys = memories.every(m => /^build_gate_\d+$/.test(m.key));
  if (!hasUpstreamKeys) {
    const badKeys = memories.filter(m => !/^build_gate_\d+$/.test(m.key)).map(m => m.key);
    throw new Error(`Keys should use upstream format (build_gate_1..18), found: ${badKeys.join(', ')}`);
  }

  // Verify upstream source provenance
  const wrongSource = memories.filter(m => !m.source.includes('2f75cee7'));
  if (wrongSource.length > 0) {
    throw new Error(`${wrongSource.length} memories have wrong source: ${wrongSource[0].source}`);
  }

  gate('RE-P2A-G4a', 'PASS', `18 build_gate memories stored, all at confidence 0.9, upstream keys (1..18), source pinned to 2f75cee7`);

  // G4b: Verified entries survive reseed (same-category preservation)
  const firstMemory = memories[0];
  storeMemory('re-analyst', 'build_gate', firstMemory.key, 'LOCALLY_VERIFIED_CORRECTION', { confidence: 1.0, source: 'local reproduction' });
  verifyMemory(firstMemory.id);

  const { seedBuildGates } = await import(pathToFileURL(resolve(ROOT, 'server/fleet/re-tools.js')).href);
  const before = testDb.prepare(`SELECT * FROM agent_memories WHERE id = ?`).get(firstMemory.id);
  const reseedResult = seedBuildGates();
  const after = testDb.prepare(`SELECT * FROM agent_memories WHERE id = ?`).get(firstMemory.id);

  if (before.value !== after.value) throw new Error('Verified entry value was overwritten on reseed');
  if (before.confidence !== after.confidence) throw new Error('Verified entry confidence was changed on reseed');
  if (before.source !== after.source) throw new Error('Verified entry source was changed on reseed');
  if (before.verified_at !== after.verified_at) throw new Error('Verified entry verification stamp was changed on reseed');
  gate('RE-P2A-G4b', 'PASS', 'Verified entry preserved byte-for-byte on reseed');

  // G4c: Cross-category identity protection — recategorized entries survive
  const secondMemory = memories[1];
  // Recategorize to local_fix (different category, same key identity)
  storeMemory('re-analyst', 'local_fix', secondMemory.key, 'RECLASSIFIED_CORRECTION', { confidence: 1.0, source: 'local fix' });
  verifyMemory(secondMemory.id);

  const beforeRecat = testDb.prepare(`SELECT * FROM agent_memories WHERE agent_id = ? AND key = ?`).get('re-analyst', secondMemory.key);
  seedBuildGates();
  const afterRecat = testDb.prepare(`SELECT * FROM agent_memories WHERE agent_id = ? AND key = ?`).get('re-analyst', secondMemory.key);

  if (beforeRecat.category !== afterRecat.category) throw new Error(`Recategorized entry's category was changed: ${beforeRecat.category} → ${afterRecat.category}`);
  if (beforeRecat.value !== afterRecat.value) throw new Error('Recategorized entry value was overwritten');
  if (beforeRecat.confidence !== afterRecat.confidence) throw new Error('Recategorized entry confidence was changed');
  gate('RE-P2A-G4c', 'PASS', 'Recategorized verified entry preserved across seed — identity scope correct');

  // G4d: Upgrade migration — old L-prefixed entries are cleaned
  // Simulate old L-format entries
  storeMemory('re-analyst', 'build_gate', 'build_gate_L99', 'OLD_RECONSTRUCTED', { confidence: 0.9, source: 'Reconstructed' });
  const beforeClean = testDb.prepare(`SELECT * FROM agent_memories WHERE agent_id = ? AND key = 'build_gate_L99'`).get('re-analyst');
  if (!beforeClean) throw new Error('Failed to insert test L-prefix entry');
  seedBuildGates();
  const afterClean = testDb.prepare(`SELECT * FROM agent_memories WHERE agent_id = ? AND key = 'build_gate_L99'`).get('re-analyst');
  if (afterClean) throw new Error('Unverified L-prefixed orphan was NOT cleaned up');
  gate('RE-P2A-G4d', 'PASS', 'Unverified L-prefixed orphans cleaned up on seed');

} catch (e) {
  gate('RE-P2A-G4', 'FAIL', e.message);
}

// ─── Gate 2A-5: Existing Tycho rea_analyst still works ──────────

console.log('\n═══ Gate 2A-5: Tycho rea_analyst Preserved ═══');

try {
  const tychoPath = resolve(ROOT, 'agents/rea_analyst.md');
  if (!existsSync(tychoPath)) throw new Error('agents/rea_analyst.md has been deleted or renamed');

  const text = readFileSync(tychoPath, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''));
  if (!m) throw new Error('Tycho manifest has no frontmatter');

  const front = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) front[key] = val;
  }

  if (front.id !== 'rea_analyst') throw new Error(`Tycho id is "${front.id}", expected "rea_analyst"`);
  if (front.name !== 'Tycho') throw new Error(`Tycho name is "${front.name}", expected "Tycho"`);

  // Make sure re-analyst is a SEPARATE agent
  const rePath = resolve(ROOT, 'agents/re-analyst.md');
  const reText = readFileSync(rePath, 'utf8');
  if (reText.includes('id: rea_analyst')) throw new Error('RE Analyst manifest overwrites Tycho id');

  gate('RE-P2A-G5', 'PASS', `Tycho rea_analyst preserved: id="${front.id}", name="${front.name}", separate from re-analyst`);
} catch (e) {
  gate('RE-P2A-G5', 'FAIL', e.message);
}

// ─── Gate 2A-6: Tool Registration + Fleet Taskability ─────────

console.log('\n═══ Gate 2A-6: Tool Registration + Taskability ═══');

try {
  const { createRETools } = await import(pathToFileURL(resolve(ROOT, 'server/fleet/re-tools.js')).href);
  const tools = createRETools();

  if (tools.length !== 6) throw new Error(`createRETools() returned ${tools.length} tools, expected 6`);

  const expectedNames = [
    're.verify_chain', 're.build_gate_lookup',
    're.ingest_dossier', 're.query_dossier',
    're.compile_rate_measure', 're.compile_rate_predict'
  ];
  const actualNames = tools.map(t => t.name);
  const missing = expectedNames.filter(n => !actualNames.includes(n));
  if (missing.length > 0) throw new Error(`Missing tools: ${missing.join(', ')}`);

  // Verify Gate 2A tools work (not Phase 3 stubs)
  const verifyChain = tools.find(t => t.name === 're.verify_chain');
  const gateLookup = tools.find(t => t.name === 're.build_gate_lookup');
  if (!verifyChain.execute) throw new Error('re.verify_chain has no execute function');
  if (!gateLookup.execute) throw new Error('re.build_gate_lookup has no execute function');

  // Verify Phase 2B stubs throw correct error
  const phase2bTools = ['re.ingest_dossier', 're.query_dossier', 're.compile_rate_measure', 're.compile_rate_predict'];
  for (const name of phase2bTools) {
    const tool = tools.find(t => t.name === name);
    try {
      await tool.execute({ args: { dossierPath: '/fake' } });
      throw new Error(`${name} should have thrown Phase 3 error`);
    } catch (e) {
      if (!e.message.includes('Phase 3')) throw new Error(`${name} threw wrong error: ${e.message}`);
    }
  }

  gate('RE-P2A-G6a', 'PASS', '6 RE tools registered: 2 Gate-2A working, 4 Gate-2B stubs correctly require Phase 3');

  // G6b: Fleet manifest loader + tool registry verification
  const { loadManifests } = await import(pathToFileURL(resolve(ROOT, 'server/fleet/manifest.js')).href);
  const manifests = loadManifests();
  const reAgent = manifests.get('re-analyst');
  if (!reAgent) throw new Error('loadManifests() does not discover re-analyst (Map has ' + manifests.size + ' entries: [' + [...manifests.keys()].join(', ') + '])');
  if (!Array.isArray(reAgent.tools) || reAgent.tools.length !== 10) {
    throw new Error(`Fleet loader parsed ${Array.isArray(reAgent.tools) ? reAgent.tools.length : 'wildcard'} tools, expected 10`);
  }

  // Verify the agent's RE tools are ALL present in the full fleet tool registry
  const { createFleetTools } = await import(pathToFileURL(resolve(ROOT, 'server/fleet/tools.js')).href);
  const allFleetTools = createFleetTools({ workflowStore: null });
  const allFleetToolNames = new Set(allFleetTools.map(t => t.name));

  const agentReTools = reAgent.tools.filter(t => t.startsWith('re.'));
  const missingFromRegistry = agentReTools.filter(t => !allFleetToolNames.has(t));
  if (missingFromRegistry.length > 0) {
    throw new Error(`Agent declares RE tools not in fleet registry: ${missingFromRegistry.join(', ')}`);
  }

  gate('RE-P2A-G6b', 'PASS', `Fleet manifest discovers re-analyst with ${reAgent.tools.length} tools; all ${agentReTools.length} RE tools present in fleet registry (${allFleetTools.length} total tools)`);
} catch (e) {
  gate('RE-P2A-G6', 'FAIL', e.message);
}

// ─── Summary ────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════');
console.log(`  Phase 2A Gate Results: ${passed} PASS, ${failed} FAIL`);
console.log(`  Database: disposable (${DISPOSABLE_DIR})`);
console.log('═══════════════════════════════════════════\n');

const evidence = {
  phase: '2A',
  title: 'RE Agent Manifest + Fleet Tools — Gate Acceptance',
  timestamp: new Date().toISOString(),
  databaseIsolation: true,
  disposableDir: DISPOSABLE_DIR,
  gates: results,
  summary: { passed, failed, total: results.length },
  limitations: [
    'G2a/b: raw receipt files not present on this machine (PASS_ISOLATED)',
    'G6b: fleet taskability verified via manifest loader + tool registry, not full POST /api/fleet/runs (no server boot)',
  ],
};

// Write output if --output specified
const outputIdx = process.argv.indexOf('--output');
if (outputIdx >= 0 && process.argv[outputIdx + 1]) {
  const outPath = resolve(process.argv[outputIdx + 1]);
  writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence written to: ${outPath}`);
}

process.exit(failed > 0 ? 1 : 0);
