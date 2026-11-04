import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Uses production modules with a private database. No live model or app actions.
const temporaryParent = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(temporaryParent, 'chandra-core-review-'));
const previousDataDir = process.env.CHANDRA_DATA_DIR;
const originalRandom = Math.random;
const originalFetch = globalThis.fetch;
process.env.CHANDRA_DATA_DIR = path.join(directory, 'data');
let db;
try {
  ({ db } = await import('../../server/db.js'));
  const { migrateWorkspaces } = await import('../../server/db-migrate.js');
  migrateWorkspaces();
  const opeg = await import('../../server/intelligence/opeg.js');
  const { neurogenesisCycle } = await import('../../server/intelligence/neurogenesis.js');
  const bridge = await import('../../server/intelligence/state-bridge.js');
  const { createCTRNN } = await import('../../server/intelligence/ctrnn.js');
  const observations = [];

  const rejectedForge = await opeg.runPipeline({
    type: 'forge_agent', hypothesis: 'Create a specialist', source: 'isolated-review',
    // Reproduce the real forge's DB effect, without writing manifests or using a model.
    executeFn: async () => {
      db.prepare('INSERT INTO forged_agents (agent_id, forged_by, goal, created_at) VALUES (?, ?, ?, ?)')
        .run('isolated-review-agent', 'review', 'Specialist', Date.now());
      return { ok: true, agent: { id: 'isolated-review-agent' } };
    },
  });
  observations.push({ id: 'CORE-01-rejection-side-effect', approved: rejectedForge.approved,
    verdict: rejectedForge.verdict, persistedForgedRows: db.prepare('SELECT COUNT(*) AS n FROM forged_agents').get().n });

  const noOpVerify = await opeg.runPipeline({
    type: 'verify_memory', hypothesis: 'Verify one memory', source: 'isolated-review',
    executeFn: async () => ({ ok: true }),
  });
  observations.push({ id: 'CORE-02-failed-check-approved', approved: noOpVerify.approved,
    failedChecks: noOpVerify.verdict.checks.filter(check => !check.passed) });

  db.prepare('DELETE FROM bus_messages').run();
  Math.random = () => 0.5;
  const forgedBefore = db.prepare('SELECT COUNT(*) AS n FROM forged_agents').get().n;
  const neuro = await neurogenesisCycle();
  const forgedAfter = db.prepare('SELECT COUNT(*) AS n FROM forged_agents').get().n;
  observations.push({ id: 'CORE-03-emergency-forge-request-only', triggered: neuro.triggered,
    type: neuro.type, forgeStimulus: neuro.stimuli.find(stimulus => stimulus.type === 'forge_agent'),
    newForgedRows: forgedAfter - forgedBefore });
  Math.random = originalRandom;

  db.prepare('INSERT INTO verification_loops (id, goal, status, created_at) VALUES (?, ?, ?, ?)')
    .run('review-approved', 'Example verified code', 'approved', Date.now());
  const fossil = await bridge.snapshotState();
  observations.push({ id: 'CORE-04-verification-case', actualApprovedRows: 1,
    reportedVerification: fossil.snapshot.intelligence.verification });

  const neural = createCTRNN();
  neural.initialize();
  neural.inject(7, 7, 2, 1);
  await neural.step();
  const beforeRestart = neural.tick;
  const snapshot = neural.snapshot();
  neural.start(() => {});
  neural.stop();
  observations.push({ id: 'CORE-05-neural-continuity', beforeRestart, afterRestart: neural.tick,
    snapshotWeightCount: snapshot.W.length, requiredWeightCount: neural.weights().W.length,
    fullStateRestoreApiPresent: typeof neural.restore === 'function' });

  // Independently compare the serial and worker Euler implementations.
  const config = { gridSize: 8, pruneRate: 0, neurogenesisThreshold: 0,
    connectivityFloor: 0, biosphereRate: 0 };
  function initializeDeterministically(core) {
    let seed = 42;
    Math.random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
    try { core.initialize(); } finally { Math.random = originalRandom; }
    core.inject(3, 4, 2, 0.7);
  }
  const serial = createCTRNN(config), parallel = createCTRNN(config);
  initializeDeterministically(serial);
  initializeDeterministically(parallel);
  await serial.step(false);
  await parallel.step(true);
  const maxDifference = Math.max(...serial.state().B.map((value, i) => Math.abs(value - parallel.state().B[i])));
  assert.ok(maxDifference <= 1e-12);
  observations.push({ id: 'CTRNN-positive-serial-worker-agreement', maxDifference,
    allFinite: serial.state().B.every(Number.isFinite) && parallel.state().B.every(Number.isFinite) });

  const { createContentNexus } = await import('../../server/intelligence/content-nexus.js');
  const nexus = createContentNexus({ db, ollamaUrl: 'http://127.0.0.1:11434' });
  db.prepare("INSERT INTO nexus_items (source, item_type, title) VALUES ('web', 'article', 'Synthetic review item')").run();
  let nexusRequest;
  globalThis.fetch = async (_url, options) => {
    nexusRequest = JSON.parse(options.body);
    return Response.json({ error: 'Contract probe: messages must be an array' }, { status: 400 });
  };
  const recommendations = await nexus.generateRecommendations();
  globalThis.fetch = originalFetch;
  observations.push({ id: 'NEXUS-01-chat-contract', requestMessagesType: typeof nexusRequest?.messages,
    isArray: Array.isArray(nexusRequest?.messages), result: recommendations });

  console.log(JSON.stringify({ method: 'Production functions, isolated SQLite, simulated forge DB effect, no live model or browser mutation', observations }, null, 2));
} finally {
  Math.random = originalRandom;
  globalThis.fetch = originalFetch;
  db?.close();
  if (previousDataDir === undefined) delete process.env.CHANDRA_DATA_DIR;
  else process.env.CHANDRA_DATA_DIR = previousDataDir;
  const target = await fs.realpath(directory);
  assert.equal(target, directory);
  assert.equal(path.dirname(target), temporaryParent);
  assert.ok(path.basename(target).startsWith('chandra-core-review-'));
  await fs.rm(target, { recursive: true, force: true });
}
