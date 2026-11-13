import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The worker and fraymus-video-studio share FRAYMUS-HOME's card through one lock file (handoff 2026-11-12, section 9).
// scripts/worker/gpu_lock_check.py runs the worker's lock against the studio's algorithm in both directions.
test('the worker and the video studio never hold the card at once', t => {
  const python = process.env.PYTHON || 'python';
  const probe = spawnSync(python, ['-I', '-c', 'print(1)'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('python is not available'); return; }
  const run = spawnSync(python, ['-I', 'scripts/worker/gpu_lock_check.py'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /ALL PASS\s*$/);
  assert.doesNotMatch(run.stdout, /^FAIL/m);
});
