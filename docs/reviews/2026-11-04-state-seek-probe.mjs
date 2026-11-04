// State Seek on Boot — Probe Test
// Verifies the ported FRAYNIX stateSeek subsystem.
// Run: node docs/reviews/2026-11-04-state-seek-probe.mjs

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assertNode from 'node:assert/strict';

// Never import a DB-backed module before a fresh, isolated child is selected.
if (process.argv[2] !== '--isolated-child') {
  const directory = mkdtempSync(join(tmpdir(), 'chandra-state-seek-probe-'));
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child', directory], {
    env: { ...process.env, CHANDRA_DATA_DIR: directory, HOST: '127.0.0.1' },
    encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error('Isolated probe failed:', result.error.message);
  process.exit(result.status ?? 1);
}
const directory = process.argv[3];
assertNode.equal(resolve(process.env.CHANDRA_DATA_DIR), resolve(directory));
const relativeDirectory = relative(realpathSync(tmpdir()), realpathSync(directory));
assertNode.ok(!relativeDirectory.startsWith('..') && relativeDirectory.split(sep)[0].startsWith('chandra-state-seek-probe-'));
const { stateSeekOnBoot, getBootManifest } = await import('../../server/integrity/state-seek.js');

const results = {};
let pass = 0;
let fail = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    pass++;
    results[label] = { pass: true, detail };
  } else {
    fail++;
    results[label] = { pass: false, detail };
    console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  }
}

// 1. Run state seek
let report;
try {
  report = stateSeekOnBoot();
} catch (e) {
  console.error('stateSeekOnBoot threw:', e.message);
  process.exit(1);
}

// 2. Report structure
assert('report:has_ts', typeof report.ts === 'string', `ts: ${report.ts}`);
assert('report:has_verdict', typeof report.verdict === 'string', `verdict: ${report.verdict}`);
assert('report:has_duration', typeof report.duration_ms === 'number', `duration: ${report.duration_ms}ms`);
assert('report:has_directories', Array.isArray(report.directories), `dirs: ${report.directories?.length}`);
assert('report:has_continuity_files', typeof report.continuity_files === 'number', `files: ${report.continuity_files}`);
assert('report:has_registration', report.registration !== null, `reg: ${JSON.stringify(report.registration)}`);
assert('report:has_verify', report.verify !== null, `verify: ${JSON.stringify(report.verify)}`);

// 3. Directories exist
assert('dirs:all_existed_or_created',
  report.directories.every(d => d.existed || d.dir),
  `dirs: ${report.directories.map(d => `${d.dir}:${d.existed ? 'existed' : 'created'}`).join(', ')}`);

// 4. Critical directories present
const expectedDirs = ['dreams', 'remembered', 'fossils', 'ledger', 'carbon', 'agents'];
for (const dir of expectedDirs) {
  assert(`dir:${dir}`, report.directories.some(d => d.dir === dir), `looking for ${dir}`);
}

// 5. Verify result has expected shape
assert('verify:intact_type', typeof report.verify.intact === 'number', `intact: ${report.verify.intact}`);
assert('verify:tampered_type', typeof report.verify.tampered === 'number', `tampered: ${report.verify.tampered}`);
assert('verify:missing_type', typeof report.verify.missing === 'number', `missing: ${report.verify.missing}`);
assert('verify:healed_type', typeof report.verify.healed === 'number', `healed: ${report.verify.healed}`);

// 6. Manifest generated
assert('manifest:has_name', report.manifest?.name === 'CHANDRA-FRAYMUS', `name: ${report.manifest?.name}`);
assert('manifest:has_artifacts', typeof report.manifest?.artifact_count === 'number', `count: ${report.manifest?.artifact_count}`);
assert('manifest:has_boot_seek', report.manifest?.boot_seek !== undefined, `boot_seek: ${JSON.stringify(report.manifest?.boot_seek)}`);

// 7. Verdict is not ERROR
assert('verdict:no_error', !report.verdict.startsWith('BOOT_ERROR'), `verdict: ${report.verdict}`);

// 8. Boot manifest file readable
const manifest = getBootManifest();
assert('manifest:readable', manifest !== null, `readable: ${manifest !== null}`);
assert('manifest:matches_report', manifest?.built === report.manifest?.built, `built: ${manifest?.built}`);

// 9. Artifacts have SHA-256 hashes
if (manifest && manifest.artifacts) {
  const entries = Object.entries(manifest.artifacts);
  if (entries.length > 0) {
    const [key, val] = entries[0];
    assert('artifact:has_sha256', typeof val.sha256 === 'string' && val.sha256.length === 64, `first: ${key} -> ${val.sha256?.slice(0, 16)}...`);
    assert('artifact:has_bytes', typeof val.bytes === 'number', `bytes: ${val.bytes}`);
  }
}

// 10. Duration is reasonable (< 10s)
assert('perf:under_10s', report.duration_ms < 10000, `duration: ${report.duration_ms}ms`);

console.log('\n=== State Seek Probe Results ===');
console.log(`Pass: ${pass}  Fail: ${fail}`);
console.log(JSON.stringify(results, null, 2));
process.exit(fail > 0 ? 1 : 0);
