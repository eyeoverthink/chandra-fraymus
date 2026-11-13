import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { mayRecoverAtBoot, REAL_DATA_DIR, DATA_DIR } from '../server/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 2026-11-13: test/http.test.js loaded the runtime with no data folder named; make.js "recovered" the REAL
// creation_jobs table and a live render was marked "interrupted by restart" the minute `npm test` began. Since then a
// test process that names no folder gets a throwaway one, and boot recovery refuses to run on the real store from a test.

test('this test process itself is not on the real data folder', () => {
  assert.notEqual(resolve(DATA_DIR), REAL_DATA_DIR);
});

test('boot recovery is refused only to a test process on the real data folder', () => {
  assert.equal(mayRecoverAtBoot({}, REAL_DATA_DIR), true, 'the server recovers');
  assert.equal(mayRecoverAtBoot({ NODE_TEST_CONTEXT: 'child-v8' }, REAL_DATA_DIR), false, 'a test on the real store does not');
  assert.equal(mayRecoverAtBoot({ NODE_TEST_CONTEXT: 'child-v8' }, join(os.tmpdir(), 'x')), true, 'a test on its own folder recovers its own rows');
});

test('a test process that names no data folder gets a throwaway one, removed on exit', () => {
  const env = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
  delete env.CHANDRA_DATA_DIR;
  const code = `const { db } = await import(${JSON.stringify(pathToFileURL(resolve(ROOT, 'server/db.js')).href)});
    const { DATA_DIR } = await import(${JSON.stringify(pathToFileURL(resolve(ROOT, 'server/config.js')).href)});
    db.prepare('CREATE TABLE IF NOT EXISTS probe (x)').run(); console.log('DIR=' + DATA_DIR);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.match(/DIR=(.*)/)[1].trim();
  assert.notEqual(resolve(dir), REAL_DATA_DIR, 'never the real data folder');
  assert.ok(resolve(dir).startsWith(resolve(os.tmpdir())), `under the temp folder: ${dir}`);
  assert.equal(existsSync(dir), false, 'removed when the process exits');
});

test('a test process with its own data folder still closes the jobs a dead process left there', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'chandra-recover-'));
  try {
    const run = code => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
        { env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', CHANDRA_DATA_DIR: dir }, encoding: 'utf8', timeout: 120_000 });
      assert.equal(r.status, 0, r.stderr.slice(-2000));
      return r.stdout;
    };
    const dbUrl = JSON.stringify(pathToFileURL(resolve(ROOT, 'server/db.js')).href);
    const makeUrl = JSON.stringify(pathToFileURL(resolve(ROOT, 'server/media/make.js')).href);
    // a "dead process": the table with one job left running
    run(`const { db } = await import(${dbUrl});
      db.exec("CREATE TABLE IF NOT EXISTS creation_jobs (id TEXT PRIMARY KEY, request TEXT NOT NULL, kind TEXT NOT NULL, style TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, progress REAL, plan TEXT, script TEXT, title TEXT, output TEXT, error TEXT, source TEXT, agent_id TEXT, seconds REAL, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER)");
      db.prepare("INSERT INTO creation_jobs (id, request, kind, style, status, created_at) VALUES ('j1', 'x', 'video', 'flat', 'running', 1)").run();`);
    // the next process loads make.js: the job is closed
    const out = run(`await import(${makeUrl}); const { db } = await import(${dbUrl});
      console.log('ROW=' + JSON.stringify(db.prepare("SELECT status, error FROM creation_jobs WHERE id = 'j1'").get())); process.exit(0);`);
    assert.deepEqual(JSON.parse(out.match(/ROW=(.*)/)[1]), { status: 'error', error: 'interrupted by restart' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every boot recovery in server/ is behind the guard', () => {
  const files = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); } else if (p.endsWith('.js')) files.push(p); } };
  walk(resolve(ROOT, 'server'));
  const unguarded = files.filter(f => {
    const src = readFileSync(f, 'utf8');
    return /UPDATE\s+\w+\s+SET[^`]*(interrupted by|process restarted)/.test(src) && !/mayRecoverAtBoot/.test(src);
  }).map(f => f.slice(ROOT.length + 1));
  assert.deepEqual(unguarded, [], 'a module that closes "left running" rows must ask mayRecoverAtBoot() first');
});
