// State Seek on Boot — Probe Test
// Verifies the ported FRAYNIX stateSeek subsystem.
// Run: node docs/reviews/2026-11-04-state-seek-probe.mjs

import { stateSeekOnBoot, getBootManifest } from '../../server/integrity/state-seek.js';

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
