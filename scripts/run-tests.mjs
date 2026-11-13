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
import { readdirSync } from 'node:fs';

const deadlineMs = Math.max(60_000, Number(process.env.TEST_DEADLINE_MS) || 45 * 60_000);
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync('test').filter(f => f.endsWith('.test.js')).sort().map(f => `test/${f}`);

const child = spawn(process.execPath, ['--test', '--test-timeout=600000', ...files], { stdio: 'inherit' });
const timer = setTimeout(() => {
  console.error(`\n[run-tests] still running after ${Math.round(deadlineMs / 60_000)} min: a test file did not exit (an open handle — timer, socket, browser, child process). Killing the run.`);
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  process.exitCode = 1;
}, deadlineMs);
timer.unref();
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (process.exitCode !== 1) process.exitCode = code ?? (signal ? 1 : 0);
});
