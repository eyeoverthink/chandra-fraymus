#!/usr/bin/env node
// `npm test`: node's test runner with a wall-clock deadline instead of --test-force-exit.
//
// Why (2026-11-12): --test-force-exit hid every leak — five housekeeping timers and a headless browser kept test
// processes alive for days without anyone noticing — and on Windows it aborts Node (libuv UV_HANDLE_CLOSING) when the
// forced exit lands while a socket is closing (content-nexus, every run). Without it a leak shows up as a file that
// does not exit, and two such runs once lived for days writing reflections into the real database. So: no forced exit,
// but a deadline — when it passes, the whole process tree is killed and the run fails, saying so.
//
// Usage: node scripts/run-tests.mjs [test files…]   (default test/*.test.js)
// Env:   TEST_DEADLINE_MS (default 45 min)
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests that name no data folder get a throwaway one (server/config.js) and db.js removes it on exit; one a process
// could not remove (a killed test, a file still open on Windows) is swept here — this run's at the end, and anything
// older than six hours at the start (never a younger one: another run may be using it).
const SCRATCH = 'chandra-test-data-';
const runStarted = Date.now();
function sweepScratch(keep) {
  let n = 0;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(SCRATCH)) continue;
    const dir = join(tmpdir(), name);
    try { if (keep(statSync(dir).mtimeMs)) continue; rmSync(dir, { recursive: true, force: true }); n++; }
    catch (e) { console.error(`[run-tests] scratch ${name}: ${e.message}`); }
  }
  return n;
}
sweepScratch(mtime => mtime > runStarted - 6 * 3600_000);

const deadlineMs = Math.max(60_000, Number(process.env.TEST_DEADLINE_MS) || 45 * 60_000);
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync('test').filter(f => f.endsWith('.test.js')).sort().map(f => `test/${f}`);

// Files that must run after the parallel phase, on their own. Empty now: sandbox-docker was here (its fake daemon
// raced a 500 ms timer against a 300 ms cleanup deadline, and any ~100 ms pause of the test process flipped the
// order — reproduced by freezing the event loop 250 ms in every 300: 9–10 failures a run). Its fake daemon is now
// event-driven and the window is the production 5 s, and it passes under the same pauses. Before adding a file here,
// make its ordering explicit instead; a solo phase only hides the race.
const ALONE = new Set([]);
const crowd = files.filter(f => !ALONE.has(f)), alone = files.filter(f => ALONE.has(f));

let current = null, killed = false;
const timer = setTimeout(() => {
  console.error(`\n[run-tests] still running after ${Math.round(deadlineMs / 60_000)} min: a test file did not exit (an open handle — timer, socket, browser, child process). Killing the run.`);
  killed = true;
  if (current) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(current.pid), '/T', '/F'], { stdio: 'ignore' });
    else try { process.kill(-current.pid, 'SIGKILL'); } catch { current.kill('SIGKILL'); }
  }
  process.exitCode = 1;
}, deadlineMs);
timer.unref();

const phase = (list, extra = []) => new Promise(done => {
  if (!list.length || killed) return done(0);
  current = spawn(process.execPath, ['--test', '--test-timeout=600000', ...extra, ...list], { stdio: 'inherit' });
  current.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
});

const crowdCode = await phase(crowd);
const aloneCode = await phase(alone, ['--test-concurrency=1']);
clearTimeout(timer);
const left = sweepScratch(mtime => mtime < runStarted - 60_000);
if (left) console.error(`[run-tests] removed ${left} test data folder(s) a test process left behind`);
if (alone.length) console.error(`[run-tests] parallel phase exit ${crowdCode}; timing-sensitive phase (${alone.join(', ')}) exit ${aloneCode}`);
if (process.exitCode !== 1) process.exitCode = crowdCode || aloneCode ? 1 : 0;
