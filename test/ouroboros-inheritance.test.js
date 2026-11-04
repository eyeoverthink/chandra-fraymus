import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let directory, temporaryParent, workspace, db, engine;
const previousDataDir = process.env.CHANDRA_DATA_DIR;

before(async () => {
  temporaryParent = await fs.realpath(os.tmpdir());
  directory = await fs.mkdtemp(path.join(temporaryParent, 'chandra-inheritance-'));
  workspace = path.join(directory, 'workspace');
  const serverDir = path.join(workspace, 'server');
  await fs.mkdir(serverDir, { recursive: true });
  // Make the outline longer than the production compaction threshold.
  await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(
    path.join(serverDir, `module_${String(i).padStart(3, '0')}_with_a_descriptive_name.js`),
    `export function example${i}() { return ${i}; }\n`,
  )));
  // Set the database location BEFORE importing modules that open it.
  process.env.CHANDRA_DATA_DIR = path.join(directory, 'data');
  ({ db } = await import('../server/db.js'));
  engine = await import('../server/intelligence/ouroboros-cycle.js');
  // Only the bus table is needed for the cycle completion event.
  db.exec(`CREATE TABLE bus_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT, to_agent TEXT,
    topic TEXT, payload TEXT, created_at INTEGER
  )`);
});

beforeEach(() => {
  db.exec(`DELETE FROM ouroboros_genome;
    DELETE FROM ouroboros_workspaces;
    DELETE FROM ouroboros_templates;
    DELETE FROM ouroboros_proposals;
    DELETE FROM ouroboros_cycles;
    DELETE FROM bus_messages;`);
});

after(async () => {
  db?.close();
  if (previousDataDir === undefined) delete process.env.CHANDRA_DATA_DIR;
  else process.env.CHANDRA_DATA_DIR = previousDataDir;
  if (directory) {
    const target = await fs.realpath(directory);
    assert.equal(target, directory);
    assert.equal(path.dirname(target), temporaryParent);
    assert.ok(path.basename(target).startsWith('chandra-inheritance-'));
    await fs.rm(target, { recursive: true, force: true });
  }
});

function seedCycle(id, generation, createdAt) {
  db.prepare(`INSERT INTO ouroboros_cycles
    (id, generation, phase, status, created_at) VALUES (?, ?, 'complete', 'complete', ?)`)
    .run(id, generation, createdAt);
}

function seedGene(cycleId, id, title, active = 1) {
  db.prepare(`INSERT INTO ouroboros_proposals
    (id, cycle_id, category, title, status) VALUES (?, ?, 'reliability', ?, 'accepted')`)
    .run(id, cycleId, title);
  db.prepare(`INSERT INTO ouroboros_genome
    (id, cycle_id, proposal_id, gene_type, origin_cycle_id, generation_acquired, active)
    VALUES (?, ?, ?, 'mutation', ?, 1, ?)`)
    .run(`gene-${id}`, cycleId, id, cycleId, active);
}

function mockModel(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    // There is deliberately no fallback to a real model or network service.
    const target = new URL(url);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
    assert.equal(target.pathname, '/api/chat');
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.messages[0].content.startsWith('You are Ouroboros')) {
      return Response.json({ message: { content: JSON.stringify([{
        title: 'Add independent regression coverage', category: 'testing', priority: 'high',
        description: 'Exercise the inherited construction path', targetFiles: ['server/example.js'],
      }]) } });
    }
    assert.ok(body.messages[0].content.startsWith('You are a senior code reviewer'));
    const proposal = db.prepare('SELECT id FROM ouroboros_proposals ORDER BY rowid DESC LIMIT 1').get();
    return Response.json({ message: { content: JSON.stringify([{
      proposalId: proposal.id, verdict: 'approve', notes: 'Approved by the deterministic test reviewer',
    }]) } });
  });
  return calls;
}

function assertContext(calls, included, excluded = []) {
  assert.equal(calls.length, 2, 'one analysis and one review request');
  for (const call of calls) {
    const prompt = call.messages.find(message => message.role === 'user').content;
    for (const text of included) assert.ok(prompt.includes(text), `Model request lost inherited context: ${text}`);
    for (const text of excluded) assert.ok(!prompt.includes(text), `Model request leaked unrelated context: ${text}`);
  }
}

test('a first generation still analyzes and reviews without inherited context', async t => {
  const calls = mockModel(t);
  const result = await engine.runCycle(workspace);
  assert.equal(result.generation, 1);
  assert.equal(result.inheritedGenes, 0);
  assert.equal(engine.getCycle(result.cycleId).status, 'complete');
  assert.ok(engine.getCycle(result.cycleId).outline.length > 3000);
  assert.equal(calls.length, 2);
  assert.match(calls[0].messages[1].content, /Stats: 100 files/);
  assert.equal(engine.getGenomeForCycle(result.cycleId).length, 1);
});

test('fork analysis and review receive the selected ancestor beyond outline compaction', async t => {
  seedCycle('ancestor', 2, '2026-01-01 00:00:00');
  seedGene('ancestor', 'ancestor-lesson', 'Retain the ALPHA_ANCESTOR recovery contract');
  seedGene('ancestor', 'inactive-lesson', 'Do not inherit INACTIVE_PATTERN', 0);
  seedCycle('newer-unrelated', 8, '2026-02-01 00:00:00');
  seedGene('newer-unrelated', 'unrelated-lesson', 'Unrelated BETA_BRANCH policy');
  const calls = mockModel(t);
  const result = await engine.forkCycle('ancestor', workspace);
  assert.equal(result.generation, 3);
  assert.equal(result.inheritedGenes, 1);
  assert.equal(engine.getCycle(result.cycleId).parent_cycle_id, 'ancestor');
  assert.ok(engine.getCycle(result.cycleId).outline.length > 3000);
  const inherited = engine.getGenomeForCycle(result.cycleId).filter(g => g.gene_type === 'inherited');
  assert.deepEqual(inherited.map(g => g.proposal_id), ['ancestor-lesson']);
  assertContext(calls, ['ALPHA_ANCESTOR', 'ancestor'], ['BETA_BRANCH', 'INACTIVE_PATTERN']);
});

test('template cycles pass the saved genome to both model stages after the source changes', async t => {
  seedCycle('template-source', 4, '2026-01-01 00:00:00');
  seedGene('template-source', 'saved-lesson', 'Preserve the SAVED_TEMPLATE journal');
  const template = engine.saveTemplate('template-source', 'Recovery baseline', 'Frozen ancestor context');
  db.prepare('UPDATE ouroboros_genome SET active = 0 WHERE proposal_id = ?').run('saved-lesson');
  seedGene('template-source', 'later-lesson', 'Later SOURCE_CHANGED_AFTER_SAVE strategy');
  const calls = mockModel(t);
  const result = await engine.instantiateTemplate(template.id, workspace);
  assert.equal(result.generation, 5);
  assert.equal(result.inheritedGenes, 1);
  assert.deepEqual(engine.getGenomeForCycle(result.cycleId)
    .filter(g => g.gene_type === 'inherited').map(g => g.proposal_id), ['saved-lesson']);
  assertContext(calls, ['Recovery baseline', 'SAVED_TEMPLATE'], ['SOURCE_CHANGED_AFTER_SAVE']);
});

test('ordinary generations also use the latest parent genome in analysis and review', async t => {
  seedCycle('older-parent', 1, '2026-01-01 00:00:00');
  seedGene('older-parent', 'old-lesson', 'Obsolete OLD_BRANCH behavior');
  seedCycle('latest-parent', 7, '2026-02-01 00:00:00');
  seedGene('latest-parent', 'latest-lesson', 'Keep the LATEST_PARENT invariant');
  const calls = mockModel(t);
  const result = await engine.runCycle(workspace);
  assert.equal(result.generation, 8);
  assert.equal(result.inheritedGenes, 1);
  assert.equal(engine.getCycle(result.cycleId).parent_cycle_id, 'latest-parent');
  assertContext(calls, ['LATEST_PARENT', 'latest-parent'], ['OLD_BRANCH']);
});
