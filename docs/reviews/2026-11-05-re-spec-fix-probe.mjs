// Independent recheck of spec 5e23e01. All DB and event effects stay in memory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = '5e23e01769a393645270633b80e70ff3b225f724';
const sources = {};
const read = path => {
  const source = execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
  sources[path] = createHash('sha256').update(source).digest('hex');
  return source;
};
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const spec = read('docs/RE-AGENT-INTEGRATION.md');
const progress = read('docs/RE-AGENT-PROGRESS.md');
const yaml = spec.match(/```yaml\n([\s\S]*?)```/)[1];
const parseSource = read('server/fleet/manifest.js').match(/export function parseManifest\([\s\S]*?\n}/)[0].replace('export ', '');
const manifest = new vm.Script(`(${parseSource})`).runInNewContext()(yaml);
check('corrected manifest restricts exactly ten distinct tools', Array.isArray(manifest.tools) && new Set(manifest.tools).size === 10 && manifest.tools.every(tool => !tool.includes('*')));
check('corrected manifest includes measured and predicted compile tools separately', manifest.tools.includes('re.compile_rate_measure') && manifest.tools.includes('re.compile_rate_predict'));

const workflow = read('server/workflow/engine.js');
const classify = new vm.Script(`(${workflow.match(/function nodeKind\(type\) \{[\s\S]*?\n}/)[0]})`).runInNewContext();
const nodeKinds = Object.fromEntries(['llm', 'memory_recall', 'debate_run', 'bus_publish'].map(type => [type, classify(type)]));
check('three revised node types are supported', ['llm', 'memory_recall', 'debate_run'].every(type => nodeKinds[type] !== 'unknown'));
check('revised bus_publish node remains unsupported', nodeKinds.bus_publish === 'unknown');
const llmBranch = workflow.slice(workflow.indexOf("if (k === 'llm')"), workflow.indexOf("} else if (k === 'image_gen')"));
check('LLM execution branch only generates text, not HTTP/tool actions', llmBranch.includes('callOllama') && !llmBranch.includes('fetch(') && !llmBranch.includes('executeTool'));

const fixture = JSON.parse(readFileSync(resolve(root, 'docs/reviews/2026-11-05-re-upstream-evidence.json'), 'utf8')).fixtureReceipt;
const payload = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'self'));
const pythonCanonical = execFileSync('python', ['-X', 'utf8', '-c', 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))'], { input: JSON.stringify(payload), encoding: 'utf8' }).trimEnd();
const compactSorted = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
const replacerSorted = JSON.stringify(payload, Object.keys(payload).sort());
const sha = value => createHash('sha256').update(value).digest('hex');
check('producer-compatible Python bytes match the recorded raw fixture hash', sha(pythonCanonical) === fixture.self);
check('compact sorted JavaScript bytes do not match the producer', sha(compactSorted) !== fixture.self);
check('JSON.stringify sorted-key replacer also drops nested evidence fields', Object.keys(JSON.parse(replacerSorted).evidence).length === 0 && Object.keys(payload.evidence).length === 2);
check('revised spec still explicitly prescribes no extra spacing', spec.includes('sorted keys, no extra spacing'));

const db = new Database(':memory:');
let trust, crash;
try {
  const migrations = read('server/db-migrate.js');
  for (const table of ['bus_messages', 'bus_triggers', 'workflows', 'workflow_runs']) {
    db.exec(migrations.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  }
  const evaluate = (path, bindings, names) => {
    const source = read(path).replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');
    assert.ok(!/^import /m.test(source));
    return new vm.Script(`(() => { ${source}\n return {${names.join(',')}}; })()`, { filename: path }).runInNewContext({ Date, Math, JSON, console, ...bindings });
  };
  const bus = evaluate('server/fleet/bus.js', { db }, ['publish', 'onTopic', 'offTopic']);
  const executions = [];
  const triggers = evaluate('server/fleet/bus-triggers.js', {
    db, onTopic: bus.onTopic, offTopic: bus.offTopic,
    runPipeline: async (...args) => { executions.push(args); return { status: 'success', results: {}, durationMs: 0 }; },
  }, ['createTrigger', 'deleteTrigger']);
  const now = Date.now();
  db.prepare('INSERT INTO workflows(id,name,nodes,edges,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('fixture-workflow', 'Trusted dossier fixture', '[]', '[]', now, now);
  const trigger = triggers.createTrigger('hive.fra-pipeline:dossier', 'fixture-workflow', 'Trusted dossier trigger');
  bus.publish('review-fixture', 'hive.fra-pipeline:dossier', { chainVerified: false, sourceFormat: 'projection', msg: 'untrusted fixture' });
  await new Promise(resolve => setImmediate(resolve));
  trust = { workflowInvocations: executions.length, triggerFireCount: db.prepare('SELECT fire_count FROM bus_triggers WHERE id = ?').get(trigger.id).fire_count, chainVerifiedInPrompt: executions[0]?.[2]?.prompt.includes('"chainVerified":false') };
  check('actual trigger dispatches a projection event despite chainVerified false', executions.length === 1 && trust.triggerFireCount === 1);
  triggers.deleteTrigger(trigger.id);

  const receiptId = 'review-raw-fixture';
  let observerCalls = 0;
  bus.onTopic('hive.fra-pipeline:dossier', 'review-observer', () => observerCalls++);
  const beforeRows = db.prepare('SELECT COUNT(*) AS n FROM bus_messages').get().n;
  try {
    db.transaction(() => {
      bus.publish('review-fixture', 'hive.fra-pipeline:dossier', { receiptId, chainVerified: true });
      throw new Error('simulated crash before watermark write');
    })();
  } catch (error) { assert.equal(error.message, 'simulated crash before watermark write'); }
  check('transaction rollback removes persisted event but cannot retract subscriber call', db.prepare('SELECT COUNT(*) AS n FROM bus_messages').get().n === beforeRows && observerCalls === 1);
  db.transaction(() => bus.publish('review-fixture', 'hive.fra-pipeline:dossier', { receiptId, chainVerified: true }))();
  crash = { persistedNewEvents: db.prepare('SELECT COUNT(*) AS n FROM bus_messages').get().n - beforeRows, observerCalls };
  check('retry can produce one durable event but two subscriber side effects', crash.persistedNewEvents === 1 && crash.observerCalls === 2);
} finally { db.close(); }

const counts = {};
let group;
for (const line of spec.split('\n')) {
  const match = line.match(/^### Verification Gate (\d+[AB]?)/);
  if (match) { group = match[1]; counts[group] = 0; }
  if (group && /^- \[[ xX]\]/.test(line)) counts[group]++;
}
const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
const claimedTotal = Number(progress.match(/0\/(\d+) \(expanded/)?.[1]);
check('revised spec defines 56 phase criteria, including six in 2A and four in 2B', total === 56 && counts['2A'] === 6 && counts['2B'] === 4);
check('author tracker still claims 47 instead of actual 56', claimedTotal === 47 && total !== claimedTotal);
const result = {
  generatedAt: new Date().toISOString(), sourceRef: ref, sources,
  safety: 'Pinned Git source, isolated modules, in-memory SQLite and counter-only workflow mock; Python canonicalizes stdin JSON only; no live DB, network, model, binary, or real workflow execution',
  assertionCount: checks.length, checks,
  manifest: { tools: manifest.tools, count: manifest.tools.length }, workflow: { nodeKinds, llmBranch },
  canonicalization: { producerHash: fixture.self, pythonCanonicalHash: sha(pythonCanonical), compactSortedHash: sha(compactSorted), sortedKeyReplacerHash: sha(replacerSorted), pythonCanonical, compactSorted, sortedKeyReplacer: replacerSorted },
  projectionTrust: trust, transactionNotification: crash,
  acceptanceCriteria: { counts, actualTotal: total, authorClaimedTotal: claimedTotal },
};
const outputFlag = process.argv.indexOf('--output');
if (outputFlag >= 0) {
  assert.ok(process.argv[outputFlag + 1]);
  writeFileSync(resolve(process.argv[outputFlag + 1]), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ assertionCount: checks.length, sourceRef: ref, output: resolve(process.argv[outputFlag + 1]) }));
} else console.log(JSON.stringify(result, null, 2));
