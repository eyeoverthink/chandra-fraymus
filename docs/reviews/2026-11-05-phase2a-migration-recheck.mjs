// Independent b999ed7 review. Pinned sources; in-memory migration fixtures.
// Author suite runs in an archived source copy with its own cwd and persistence.
// Usage: node this_file.mjs --output FILE
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = 'b999ed7e74b1b7db441131e4227ae3dc57e44e59';
const oldRef = 'dcb065868448978ac5f8b963b7e326ca64a7b374';
const localRef = 'e8410f30c7344cd291014e01cb3c971725d65dcf';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--output'));
const sha = data => createHash('sha256').update(data).digest('hex');
const cache = new Map(), sourceHashes = {};
function source(path, pin = ref) {
  const key = `${pin}:${path}`;
  if (!cache.has(key)) {
    const text = execFileSync('git', ['show', key], { cwd: root, encoding: 'utf8' });
    cache.set(key, text); sourceHashes[key] = sha(text);
  }
  return cache.get(key);
}
function moduleFrom(path, bindings, names, pin = ref) {
  const body = source(path, pin).replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '').replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body));
  return new vm.Script(`(() => { ${body}\nreturn { ${names} }; })()`, { filename: path }).runInNewContext({ Date, Math, JSON, console, ...bindings });
}
const ddl = source('server/db-migrate.js').match(/CREATE TABLE IF NOT EXISTS agent_memories \([\s\S]*?\n\s*\)/)[0];
function context() {
  const db = new Database(':memory:'); db.exec(ddl);
  db.exec('CREATE UNIQUE INDEX fixture_identity ON agent_memories(agent_id,key)');
  const memory = moduleFrom('server/fleet/agent-memory.js', { db }, 'storeMemory,recallMemories,verifyMemory');
  const tools = pin => moduleFrom('server/fleet/re-tools.js', { db, ...memory, verifyHiveChain: () => { throw new Error('No chain operations in migration fixture'); } }, 'seedBuildGates,createRETools,BUILD_GATES', pin);
  return { db, memory, re: tools(ref), tools };
}
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const rows = db => db.prepare('SELECT * FROM agent_memories ORDER BY id').all();
const get = (db, key) => db.prepare('SELECT * FROM agent_memories WHERE agent_id=? AND key=?').get('re-analyst', key);
const fixturePath = 'docs/reviews/fixtures/re-build-gates-2f75cee7.md';
const fixtureBlob = execFileSync('git', ['rev-parse', `${ref}:${fixturePath}`], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(fixtureBlob, '43377715d18c7d892fa71c3dab3167da070f6936');
const upstreamText = source(fixturePath);
const headings = [...upstreamText.matchAll(/^(\d+)\. \*\*(.*?)\*\*/gm)].map(m => ({ gate: Number(m[1]), title: m[2] }));
const anchors = [['r2','sudo'],['dylib','path'],['JDK','21'],['flat','repo'],['engine','gate'],['runtime','incompat'],['npm','install'],['prepare','git'],['entrypoint'],['JDK','TTY'],['Bad','argument'],['Directory','found'],['headless','python'],['Node','brew'],['ReVa','gradle'],['setuptools','metadata'],['regex'],['r2ai']];

const fresh = context();
let catalog, preservation;
try {
  const seed = fresh.re.seedBuildGates(), first = rows(fresh.db), repeat = fresh.re.seedBuildGates();
  check('clean catalog has eighteen distinct numbered source entries at confidence 0.9', seed.seeded === 18 && first.length === 18 && new Set(first.map(m => JSON.parse(m.value).gate)).size === 18 && first.every(m => m.confidence === 0.9));
  check('all eighteen source identities have the expected independent source anchors', fresh.re.BUILD_GATES.every((g,i) => g.gate === i+1 && anchors[i].every(a => g.title.toLowerCase().includes(a.toLowerCase()))));
  check('unchanged authentic entries are idempotent with no row mutation', repeat.skipped === 18 && repeat.updated === 0 && repeat.cleaned === 0 && JSON.stringify(first) === JSON.stringify(rows(fresh.db)));
  const keywordResults = [];
  for (const keyword of ['JDK','dylib','npm']) keywordResults.push(await fresh.re.createRETools().find(t => t.name === 're.build_gate_lookup').execute({ args: { keyword } }));
  check('source provenance reaches keyword lookup consumers', keywordResults.every(r => r.matches > 0 && r.gates.every(g => g.source.includes('2f75cee7'))));
  catalog = { seed, repeat, entries: fresh.re.BUILD_GATES.map((g,i) => ({ ...g, upstreamTitle: headings[i].title })), keywordResults };
  const entry = fresh.memory.storeMemory('re-analyst','local_fix','build_gate_3','VERIFIED_LOCAL_FIX',{ confidence: 1, source:'local reproduction fixture' });
  fresh.memory.verifyMemory(entry.id);
  const before = get(fresh.db,'build_gate_3'), seeded = fresh.re.seedBuildGates(), after = get(fresh.db,'build_gate_3');
  check('verified recategorized row survives unchanged across authentic seeding', JSON.stringify(before) === JSON.stringify(after));
  preservation = { before, seeded, after };
} finally { fresh.db.close(); }

const upgradeCtx = context();
let upgrade;
try {
  upgradeCtx.tools(oldRef).seedBuildGates(); upgradeCtx.tools(localRef).seedBuildGates();
  const before = rows(upgradeCtx.db).length, result = upgradeCtx.re.seedBuildGates(), after = rows(upgradeCtx.db);
  check('actual two-version upgrade reconciles thirty-six seed rows to eighteen authentic rows', before === 36 && after.length === 18 && result.updated === 18 && result.cleaned === 18);
  check('known unverified legacy false source labels are replaced', after.every(m => m.source.includes('upstream 2f75cee7')));
  upgrade = { beforeRows: before, result, afterRows: after.length, sources: [...new Set(after.map(m => m.source))] };
} finally { upgradeCtx.db.close(); }

const historyCtx = context();
let historical;
try {
  historyCtx.tools(localRef).seedBuildGates();
  const entry = historyCtx.memory.storeMemory('re-analyst','local_fix','build_gate_L1','VERIFIED_HISTORICAL_LOCAL_FIX',{ confidence:1,source:'local reproduction fixture' });
  historyCtx.memory.verifyMemory(entry.id);
  const before = get(historyCtx.db,'build_gate_L1'), seeded = historyCtx.re.seedBuildGates(), after = get(historyCtx.db,'build_gate_L1');
  check('verified historical local-ID correction is retained', JSON.stringify(before) === JSON.stringify(after) && seeded.cleaned === 17 && rows(historyCtx.db).length === 19);
  historical = { before, seeded, after, totalRows: rows(historyCtx.db).length };
} finally { historyCtx.db.close(); }

const unrelatedCtx = context();
let unrelated;
try {
  unrelatedCtx.memory.storeMemory('re-analyst','local_fix','build_gate_L77','OPERATOR_WORK_IN_PROGRESS',{ confidence:0.8,source:'operator notes fixture; never seeded' });
  unrelatedCtx.memory.storeMemory('re-analyst','local_fix','build_gate_3','LOCAL_PENDING_CORRECTION',{ confidence:0.8,source:'operator notes fixture; never seeded' });
  const before = rows(unrelatedCtx.db), result = unrelatedCtx.re.seedBuildGates();
  const deleted = get(unrelatedCtx.db,'build_gate_L77'), overwritten = get(unrelatedCtx.db,'build_gate_3');
  check('migration deletes an unverified local note that no prior seeder created', !deleted && result.cleaned === 1);
  check('migration overwrites an unrelated unverified local note without testing source ownership', overwritten.value !== before.find(r => r.key === 'build_gate_3').value && overwritten.source.includes('upstream 2f75cee7'));
  unrelated = { before, result, localL77Deleted: !deleted, numeric3After: overwritten };
} finally { unrelatedCtx.db.close(); }

// The new full-registry import initializes cwd-based ledger/dream directories.
// Run exact archived source, not live source with a disposable DB alone.
const directory = mkdtempSync(join(tmpdir(),'chandra-2a-migration-review-'));
const sourceCopy = join(directory,'source');
const archive = execFileSync('git',['archive','--format=zip',ref,'server','agents','package.json','docs/reviews/2026-11-05-phase2a-gate-acceptance.mjs'],{ cwd:root,maxBuffer:64*1024*1024 });
execFileSync('python',['-c',String.raw`
import io,sys,zipfile
from pathlib import Path
target=Path(sys.argv[1]).resolve(); target.mkdir()
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 for item in z.infolist():
  p=(target/item.filename).resolve()
  assert p.is_relative_to(target),item.filename
 z.extractall(target)
`,sourceCopy],{ input:archive });
symlinkSync(join(root,'node_modules'),join(sourceCopy,'node_modules'),'junction');
const authorPath='docs/reviews/2026-11-05-phase2a-gate-acceptance.mjs';
const authorScript=source(authorPath);
const authorOutput=join(directory,'author-evidence.json');
const child=spawnSync(process.execPath,[join(sourceCopy,authorPath),'--output',authorOutput],{ cwd:sourceCopy,env:{ ...process.env,CHANDRA_DATA_DIR:join(directory,'sentinel-data'),FRAYMUS_WORKSPACE:sourceCopy },encoding:'utf8',timeout:30000 });
const authorEvidence=existsSync(authorOutput)?JSON.parse(readFileSync(authorOutput,'utf8')):null;
check('author suite reproduces fourteen successful subchecks in isolated archived source', child.status===0 && authorEvidence.summary.passed===14 && authorEvidence.summary.failed===0);
check('G6b now constructs the real registry but still does not run an agent task', authorScript.includes('createFleetTools({ workflowStore: null })') && !authorScript.includes('fetch(') && !authorScript.includes('startRun('));
check('prior default-isolation fix remains ordered before DB imports', authorScript.indexOf('process.env.CHANDRA_DATA_DIR = DISPOSABLE_DIR') < authorScript.indexOf('await import('));
const registryResult=authorEvidence.gates.find(g=>g.id==='RE-P2A-G6b');
const evidence={ generatedAt:new Date().toISOString(),implementationRef:ref,sourceHashes,upstreamBuildGateBlob:fixtureBlob,
 safety:'No live database or live app imported. Pinned seeder/memory code runs in-memory. Exact author suite runs in an archived server/agents/package source copy, with installed dependencies reused through a junction, cwd/workspace under a fresh temp directory, and its own disposable DB. No fleet task, model invocation, or live server restart. No fixture deletion attempted.',
 retainedTemporaryDirectory:directory,checks,diagnosticAssertionCount:checks.length,catalog,preservation,upgrade,historical,unrelated,
 authorRerun:{ status:child.status,stdout:child.stdout,stderr:child.stderr,evidence:authorEvidence,registryResult,sourceCopy },
 findingDisposition:{'RE2A-01':'SCOPED_FIX_CONFIRMED: authentic numbered summaries, source lookup, known legacy migration','RE2A-02':'SCOPED_FIX_CONFIRMED: verified rows preserved across categories and local-ID history','RE2A-03':'DB_ISOLATION_CONFIRMED: full registry import additionally requires cwd isolation for a fully disposable runtime','RE2A-04':'OPEN: registry construction is not task/response evidence','RE2A-05':'NEW: migration mutates/deletes unverified non-seed notes without checking source ownership'},
 gateResults:[{id:'RE-P2A-G1',status:'PARTIAL'},{id:'RE-P2A-G2',status:'PASS_ISOLATED'},{id:'RE-P2A-G3',status:'PASS_ISOLATED'},{id:'RE-P2A-G4',status:'PARTIAL'},{id:'RE-P2A-G5',status:'PARTIAL'},{id:'RE-P2A-G6',status:'UNVERIFIED'}],
 summary:{ scopedPasses:2,partial:3,unverified:1,failures:0,independentlyAcceptedPhases:0 } };
writeFileSync(resolve(arg('--output')),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({diagnosticAssertions:checks.length,authorReported:authorEvidence.summary,registry:registryResult.detail,...evidence.summary,output:resolve(arg('--output'))}));
