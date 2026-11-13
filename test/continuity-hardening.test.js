import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

let directory, db, watchdog, seek, continuity, RememberedVault, generateIdentity, writ;
const originalDataDir = process.env.CHANDRA_DATA_DIR;
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'chandra-continuity-hardening-'));
  process.env.CHANDRA_DATA_DIR = directory;
  ({ db } = await import('../server/db.js'));
  watchdog = await import('../server/integrity/watchdog.js');
  seek = await import('../server/integrity/state-seek.js');
  ({ continuitySelftest: continuity } = await import('../server/integrity/continuity-selftest.js'));
  ({ RememberedVault } = await import('../server/fraymus/intelligence/remembered.js'));
  ({ generateIdentity } = await import('../server/fraymus/core/identity.js'));
  writ = await import('../server/integrity/writ-system.js');
});

after(() => {
  if (db?.open) db.close();
  if (originalDataDir === undefined) delete process.env.CHANDRA_DATA_DIR;
  else process.env.CHANDRA_DATA_DIR = originalDataDir;
});

test('an unperformed watchdog check cannot produce an all-clear continuity verdict', () => {
  const result = continuity().selftest;
  const check = result.probes.find(item => item.name === 'watchdog');
  assert.equal(check.detail.checked, false);
  assert.equal(check.pass, false);
  assert.notEqual(result.verdict, 'ALL_CLEAR');
});

test('state seeking ignores legacy SQLite fossils and preserves checkpointed commits', async () => {
  const path = join(directory, 'chandra.db');
  db.exec('CREATE TABLE regression_records (id INTEGER PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO regression_records(value) VALUES (?)').run('baseline');
  db.pragma('wal_checkpoint(TRUNCATE)');
  mkdirSync(join(directory, 'fossils'), { recursive: true });
  copyFileSync(path, join(directory, 'fossils', 'legacy-sqlite-fossil'));
  const manifest = { tracked: { [path]: { hash: digest(path), fossil: 'legacy-sqlite-fossil' } }, version: 1 };
  writeFileSync(join(directory, 'integrity-manifest.json'), JSON.stringify(manifest));
  db.prepare('INSERT INTO regression_records(value) VALUES (?)').run('committed later');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const committedHash = digest(path);
  const report = seek.stateSeekOnBoot();
  assert.equal(report.verify.healed, 0);
  assert.equal(report.verify.skipped, 1);
  assert.equal(report.registration.protected_mutable, 1);
  assert.equal(digest(path), committedHash);
  const { default: Database } = await import('better-sqlite3');
  const reader = new Database(path, { readonly: true });
  try { assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM regression_records').get().n, 2); }
  finally { reader.close(); }
  assert.throws(() => watchdog.trackFile(path), /Mutable databases/);
  assert.equal(watchdog.healFile(path).protected, true);
  assert.equal(watchdog.healFile(path + '-wal').protected, true);
});

test('append-only ledger updates survive legacy file-watchdog tracking', () => {
  const path = join(directory, 'ledger', 'events.jsonl');
  mkdirSync(join(directory, 'ledger'), { recursive: true });
  writeFileSync(path, '{"sequence":1}\n');
  copyFileSync(path, join(directory, 'fossils', 'legacy-ledger-fossil'));
  const manifest = watchdog.getManifest();
  manifest.tracked[path] = { hash: digest(path), fossil: 'legacy-ledger-fossil' };
  writeFileSync(join(directory, 'integrity-manifest.json'), JSON.stringify(manifest));
  writeFileSync(path, '{"sequence":1}\n{"sequence":2}\n');
  const report = seek.stateSeekOnBoot();
  assert.equal(report.verify.healed, 0);
  assert.equal(report.verify.skipped, 2);
  assert.match(readFileSync(path, 'utf8'), /"sequence":2/);
  assert.throws(() => watchdog.trackFile(path), /append-only journals/);
});

test('immutable file healing still works and reference-only fossils are not reported restored', () => {
  const path = join(directory, 'remembered', '0001-remembered-recovery.md');
  writeFileSync(path, 'immutable original');
  const tracked = watchdog.trackFile(path);
  writeFileSync(path, 'tampered');
  assert.equal(watchdog.verifyAll().healed, 1);
  assert.equal(readFileSync(path, 'utf8'), 'immutable original');
  unlinkSync(path);
  unlinkSync(join(directory, 'fossils', tracked.fossil));
  db.exec('CREATE TABLE state_fossils (data TEXT, created_at INTEGER)');
  db.prepare('INSERT INTO state_fossils(data, created_at) VALUES (?, ?)')
    .run(JSON.stringify({ reference: path.replaceAll('\\', '/') }), Date.now());
  const report = seek.stateSeekOnBoot();
  assert.equal(report.fossil_fallback.references_found, 1);
  assert.equal(report.fossil_fallback.restored, 0);
  assert.equal(existsSync(path), false);
  assert.match(report.verdict, /UNRECOVERABLE/);
  watchdog.untrackFile(path);
  watchdog.verifyAll();
});

test('writ receipt links follow append order when clock readings tie or move backwards', () => {
  const originalNow = Date.now;
  db.exec('SAVEPOINT receipt_clock_fixture');
  try {
    Date.now = () => 1_000_000;
    for (let index = 0; index < 8; index++) writ.requestWrit('clock-test', `tool-${index}`, 'TASK: synthetic');
    Date.now = () => 999_000;
    writ.requestWrit('clock-test', 'tool-after-clock-change', 'TASK: synthetic');
    assert.equal(writ.verifyReceiptChain(100).valid, true);
  } finally {
    Date.now = originalNow;
    db.exec('ROLLBACK TO receipt_clock_fixture; RELEASE receipt_clock_fixture');
  }
});

test('continuity verdict reflects failed integrity probes without changing owner permission', () => {
  writ.mintOwnerSlot('operator-owned test fixture');
  const beforeSlot = writ.getOwnerSlot();
  const receiptsBefore = db.prepare('SELECT COUNT(*) AS n FROM writ_receipts').get().n;
  const result = continuity({
    remembered: { stats: () => ({ total: 1 }), verify: () => ({ verified: false }) },
    ledger: { countByKind: () => ({}), verify: () => ({ valid: false, checked: 1 }) },   // the real Ledger.verify() shape
  }).selftest;
  assert.notEqual(result.verdict, 'ALL_CLEAR');
  assert.equal(result.probes.find(item => item.name === 'remembered_vault').pass, false);
  assert.equal(result.probes.find(item => item.name === 'ledger').pass, false);
  assert.deepEqual(writ.getOwnerSlot(), beforeSlot);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM writ_receipts').get().n, receiptsBefore);
  const healthy = continuity({
    remembered: { stats: () => ({ total: 1 }), verify: () => ({ verified: true }) },
    ledger: { countByKind: () => ({}), verify: () => ({ valid: true, checked: 1 }) },
  }).selftest;
  assert.equal(healthy.probes.find(item => item.name === 'remembered_vault').pass, true);
  assert.equal(healthy.probes.find(item => item.name === 'ledger').pass, true);
  assert.equal(healthy.verdict, 'ALL_CLEAR');
});

test('vault verifies exact feed bytes and rejects forged signatures or altered attribution', async () => {
  const identity = await generateIdentity('continuity-test-only');
  const vault = new RememberedVault(null, identity, join(directory, 'signed-vault'));
  for (const text of ['normal feed', 'trailing space  ', 'trailing newline\n', 'CRLF\r\n']) {
    const entry = await vault.remember(text);
    assert.equal(vault.verify(entry.number).verified, true);
    assert.equal(vault.verify(entry.number).signature_valid, true);
  }
  const path = join(vault.dir, vault.read(1).filename);
  writeFileSync(path, readFileSync(path, 'utf8').replace('- source: VAUGHN', '- source: forged'));
  assert.equal(vault.verify(1).hash_match, true);
  assert.equal(vault.verify(1).verified, false);
  writeFileSync(path + '.sig', '00'.repeat(64));
  assert.equal(vault.verify(1).signature_valid, false);
  assert.equal(vault.verify(1).authenticated, false);
  const signed = join(vault.dir, vault.read(2).filename);
  unlinkSync(signed + '.sig');
  assert.equal(vault.verify(2).hash_match, true);
  assert.equal(vault.verify(2).verified, false);
  assert.equal(vault.verify(2).signature_required, true);
  const unavailableKey = new RememberedVault(null, null, vault.dir).verify(3);
  assert.equal(unavailableKey.verified, false);
  assert.match(unavailableKey.signature_error, /public key unavailable/);
});

test('numbering stays append-only beyond 9999 and default vault uses configured data directory', async () => {
  const vault = new RememberedVault(null, null, join(directory, 'large-vault'));
  writeFileSync(join(vault.dir, '9999-remembered-seed.md'), 'number seed');
  const shared = 'same-title '.repeat(8);
  const first = await vault.remember(shared + 'FIRST');
  const second = await vault.remember(shared + 'SECOND');
  assert.equal(first.number, 10000);
  assert.equal(second.number, 10001);
  assert.notEqual(first.filename, second.filename);
  assert.match(vault.read(first.number).body, /FIRST/);
  assert.match(vault.read(second.number).body, /SECOND/);
  assert.equal(vault.stats().total, 3);
  assert.equal(vault.verify(10000).verified, true);
  assert.equal(new RememberedVault(null, null).dir, join(directory, 'remembered'));
});

test('signing identity and vault authentication survive a fresh process', async () => {
  const { getSystemIdentity } = await import('../server/fraymus/core/system-identity.js');
  const firstIdentity = await getSystemIdentity();
  const vaultPath = join(directory, 'persistent-vault');
  const firstVault = new RememberedVault(null, firstIdentity, vaultPath);
  const receipt = await firstVault.remember('survive restart');
  const script = `
    const { getSystemIdentity } = await import(${JSON.stringify(new URL('../server/fraymus/core/system-identity.js', import.meta.url).href)});
    const { RememberedVault } = await import(${JSON.stringify(new URL('../server/fraymus/intelligence/remembered.js', import.meta.url).href)});
    const identity = await getSystemIdentity();
    const vault = new RememberedVault(null, identity, ${JSON.stringify(vaultPath)});
    console.log(JSON.stringify({ pubkey: identity.pubkey, authenticated: vault.verify(${receipt.number}).authenticated }));
  `;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CHANDRA_DATA_DIR: directory }, encoding: 'utf8', timeout: 10000,
  }));
  assert.equal(restored.pubkey, firstIdentity.pubkey);
  assert.equal(restored.authenticated, true);
  const file = join(directory, 'fraymus-identity.json');
  const original = readFileSync(file);
  try {
    writeFileSync(file, 'invalid stored key');
    const invalidRestart = await import('../server/fraymus/core/system-identity.js?invalid-key-fixture');
    await assert.rejects(invalidRestart.getSystemIdentity(), error => {
      assert.match(error.message, /existing key preserved/);
      assert.equal(error.message.includes('invalid stored key'), false);
      return true;
    });
    assert.equal(readFileSync(file, 'utf8'), 'invalid stored key');
  } finally { writeFileSync(file, original); }
});
