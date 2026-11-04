// Fraynix - By Vaughn Scott
// Isolated Phase 2 review. All application DB imports run in guarded temp children.
// node docs/reviews/2026-11-04-phase2-continuity-probe.mjs [--verify-fixed] [--output relative-path]
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const moduleUrl = path => new URL('../../' + path, import.meta.url);

async function worker(mode, directory, token) {
  const withinTemp = relative(realpathSync(tmpdir()), realpathSync(directory));
  assert.ok(!withinTemp.startsWith('..') && withinTemp.split(sep)[0].startsWith('chandra-phase2-review-'));
  assert.equal(JSON.parse(readFileSync(join(directory, '.review-sandbox.json'), 'utf8')).token, token);
  assert.equal(resolve(process.env.CHANDRA_DATA_DIR), resolve(directory));

  if (mode === 'remembered') {
    const { RememberedVault } = await import(moduleUrl('server/fraymus/intelligence/remembered.js'));
    const { generateIdentity, verifyText } = await import(moduleUrl('server/fraymus/core/identity.js'));
    const identity = await generateIdentity('synthetic-review-only');
    const vault = new RememberedVault(null, identity, join(directory, 'remembered'));
    const first = await vault.remember('synthetic remembered entry', 'VAUGHN');
    const path = join(vault.dir, first.filename);
    const original = readFileSync(path, 'utf8');
    const signature = readFileSync(path + '.sig', 'utf8');
    const originalSignatureValid = await verifyText(identity.pubkey, original.slice(0, -1), signature);
    assert.equal(originalSignatureValid, true);
    const before = vault.verify(first.number);
    const changed = original.replace('- source: VAUGHN', '- source: FORGED_SOURCE');
    writeFileSync(path, changed);
    writeFileSync(path + '.sig', '00'.repeat(64));
    const after = vault.verify(first.number);
    const actualTamperedSignatureValid = await verifyText(identity.pubkey, changed.slice(0, -1), '00'.repeat(64));
    const whitespace = await vault.remember('synthetic exact text with trailing whitespace \n');
    const whitespaceVerification = vault.verify(whitespace.number);

    const overflow = new RememberedVault(null, null, join(directory, 'overflow'));
    writeFileSync(join(overflow.dir, '9999-remembered-seed.md'), 'synthetic numbering seed');
    const shared = 'shared-title '.repeat(6);
    const a = await overflow.remember(shared + 'FIRST_VALUE');
    const b = await overflow.remember(shared + 'SECOND_VALUE');
    const retainedFirst = readFileSync(join(overflow.dir, a.filename), 'utf8');
    const retained = readFileSync(join(overflow.dir, b.filename), 'utf8');
    return { originalSignatureValid, before, afterMetadataAndSignatureTampering: after,
      actualTamperedSignatureValid, whitespaceVerification,
      numberingBoundary: { firstNumber: a.number, secondNumber: b.number,
        sameFilename: a.filename === b.filename, listedEntries: overflow.stats().total,
        retainedFirst: retainedFirst.includes('FIRST_VALUE'), retainedSecond: retained.includes('SECOND_VALUE') } };
  }

  const { db } = await import(moduleUrl('server/db.js'));
  const watchdog = await import(moduleUrl('server/integrity/watchdog.js'));
  try {
    if (mode === 'selftest') {
      const { continuitySelftest } = await import(moduleUrl('server/integrity/continuity-selftest.js'));
      const result = continuitySelftest({
        remembered: { stats: () => ({ total: 1 }), verify: () => ({ verified: false }) },
        ledger: { countByKind: () => ({ test: 1 }), verify: () => ({ verified: false, checked: 1 }) },
      }).selftest;
      return { verdict: result.verdict, passed: result.passed, failed: result.failed,
        falseDetailProbes: result.probes.filter(item => item.name === 'remembered_vault' || item.name === 'ledger'),
        governanceDetails: result.probes.filter(item => ['strix_laws', 'guard_tasks', 'writ_system', 'clock_honesty'].includes(item.name)) };
    }
    const seek = await import(moduleUrl('server/integrity/state-seek.js'));
    if (mode === 'boot-db') {
      db.pragma('wal_autocheckpoint = 0');
      db.exec('CREATE TABLE review_records (id INTEGER PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO review_records(value) VALUES (?)').run('BASELINE');
      db.pragma('wal_checkpoint(TRUNCATE)');
      const first = seek.stateSeekOnBoot();
      const databasePath = join(directory, 'chandra.db');
      const baselineHash = hashFile(databasePath);
      db.prepare('INSERT INTO review_records(value) VALUES (?)').run('LEGITIMATE_COMMITTED_UPDATE');
      db.pragma('wal_checkpoint(TRUNCATE)');
      const rowsBeforeSeek = db.prepare('SELECT COUNT(*) AS n FROM review_records').get().n;
      const changedHash = hashFile(databasePath);
      const second = seek.stateSeekOnBoot();
      const afterSeekHash = hashFile(databasePath);
      db.close();
      const { default: Database } = await import('better-sqlite3');
      const reopened = new Database(databasePath);
      let rowsAfterReopen;
      let integrity;
      try {
        rowsAfterReopen = reopened.prepare('SELECT COUNT(*) AS n FROM review_records').get().n;
        integrity = reopened.pragma('integrity_check', { simple: true });
      } catch (error) { rowsAfterReopen = { error: error.message }; }
      finally { reopened.close(); }
      return { firstVerdict: first.verdict, rowsBeforeSeek, rowsAfterReopen, integrity,
        changedByLegitimateCommit: baselineHash !== changedHash,
        restoredBaselineBytes: afterSeekHash === baselineHash,
        secondVerdict: second.verdict, secondVerify: second.verify };
    }
    if (mode === 'fossil-fallback') {
      const dataPath = join(directory, 'remembered', '0001-remembered-review.md');
      mkdirSync(join(directory, 'remembered'), { recursive: true });
      writeFileSync(dataPath, 'synthetic immutable artifact');
      const tracked = watchdog.trackFile(dataPath);
      const fossil = join(directory, 'fossils', tracked.fossil);
      assert.ok(resolve(fossil).startsWith(resolve(directory) + sep));
      unlinkSync(fossil);
      unlinkSync(dataPath);
      db.exec('CREATE TABLE state_fossils (data TEXT, created_at INTEGER)');
      db.prepare('INSERT INTO state_fossils(data, created_at) VALUES (?, ?)')
        .run(JSON.stringify({ referenceOnly: dataPath.replaceAll('\\', '/') }), Date.now());
      const report = seek.stateSeekOnBoot();
      return { reportedFallback: report.fossil_fallback, fileExistsAfter: existsSync(dataPath),
        verdict: report.verdict, verify: report.verify };
    }
    throw new Error('Unknown worker mode');
  } finally { if (db.open) db.close(); }
}

if (process.argv[2] === '--worker') {
  try {
    const result = await worker(process.argv[3], process.argv[4], process.argv[5]);
    process.stdout.write('\nREVIEW_RESULT=' + JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write('\nREVIEW_RESULT=' + JSON.stringify({ workerError: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  }
} else {
  const sources = ['server/fraymus/intelligence/remembered.js', 'server/integrity/state-seek.js',
    'server/integrity/continuity-selftest.js', 'server/integrity/watchdog.js',
    'server/runtime.js', 'server/fraymus-tools.js', 'server/fraymus-routes.js',
    'server/integrity/writ-system.js', 'server/fraymus/core/system-identity.js'];
  const sourceHash = path => existsSync(resolve(root, path)) ? hashFile(resolve(root, path)) : null;
  const before = Object.fromEntries(sources.map(path => [path, sourceHash(path)]));
  const sandbox = mkdtempSync(join(tmpdir(), 'chandra-phase2-review-'));
  const results = {};
  for (const mode of ['remembered', 'selftest', 'boot-db', 'fossil-fallback']) {
    const directory = join(sandbox, mode);
    const token = randomUUID();
    mkdirSync(directory);
    writeFileSync(join(directory, '.review-sandbox.json'), JSON.stringify({ token }));
    const env = { ...process.env, CHANDRA_DATA_DIR: directory, FRAYMUS_WORKSPACE: directory, HOST: '127.0.0.1' };
    let stdout;
    let exitCode = 0;
    try { stdout = execFileSync(process.execPath, [self, '--worker', mode, directory, token],
      { cwd: root, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }); }
    catch (error) { stdout = String(error.stdout || ''); exitCode = error.status; }
    const line = stdout.split(/\r?\n/).find(item => item.startsWith('REVIEW_RESULT='));
    results[mode] = { exitCode, result: line ? JSON.parse(line.slice('REVIEW_RESULT='.length)) : null };
  }
  const after = Object.fromEntries(sources.map(path => [path, sourceHash(path)]));
  const evidence = { capturedAt: new Date().toISOString(),
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    platform: process.platform, node: process.version, sandbox,
    method: 'Guarded temporary child data directories; never imports app/server or opens application data',
    sourceSha256: before, sourcesStableDuringProbe: JSON.stringify(before) === JSON.stringify(after), results };
  if (process.argv.includes('--verify-fixed')) {
    assert.equal(evidence.sourcesStableDuringProbe, true);
    assert.ok(Object.values(results).every(result => result.exitCode === 0 && !result.result?.workerError));
    const vault = results.remembered.result;
    assert.equal(vault.before.verified, true);
    assert.equal(vault.afterMetadataAndSignatureTampering.verified, false);
    assert.equal(vault.whitespaceVerification.verified, true);
    assert.equal(vault.numberingBoundary.secondNumber, 10001);
    assert.equal(vault.numberingBoundary.retainedFirst, true);
    assert.equal(vault.numberingBoundary.retainedSecond, true);
    assert.notEqual(results.selftest.result.verdict, 'ALL_CLEAR');
    assert.ok(results.selftest.result.falseDetailProbes.every(probe => probe.pass === false));
    const database = results['boot-db'].result;
    assert.equal(database.rowsAfterReopen, database.rowsBeforeSeek);
    assert.equal(database.restoredBaselineBytes, false);
    assert.equal(results['fossil-fallback'].result.reportedFallback.restored, 0);
    assert.equal(results['fossil-fallback'].result.reportedFallback.references_found, 1);
    evidence.localFixChecks = { passed: true, independentReview: 'Required from a different agent' };
  }
  const output = JSON.stringify(evidence, null, 2) + '\n';
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    assert.ok(process.argv[outputIndex + 1]);
    writeFileSync(resolve(root, process.argv[outputIndex + 1]), output);
  }
  process.stdout.write(output);
}
