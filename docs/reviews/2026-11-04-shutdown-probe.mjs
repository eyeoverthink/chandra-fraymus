import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

// Only the child processes and disposable databases created here are terminated.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const temporaryParent = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(temporaryParent, 'chandra-shutdown-review-'));
const childCode = `
const fs = require('node:fs');
const Database = require('better-sqlite3');
const [filename, marker, mode] = process.argv.slice(1);
const db = new Database(filename);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('wal_autocheckpoint = 0');
db.exec('CREATE TABLE committed_records (value TEXT NOT NULL)');
db.prepare('INSERT INTO committed_records VALUES (?)').run('committed before termination');
process.on('exit', () => { fs.writeFileSync(marker, 'exit listener ran'); db.close(); });
setInterval(() => {}, 1000);
process.send({ready: true}, () => { if (mode === 'normal') process.exit(0); });
`;

async function runCase(mode) {
  const filename = path.join(directory, `${mode}.db`);
  const marker = path.join(directory, `${mode}.exit-marker`);
  const child = spawn(process.execPath, ['-e', childCode, filename, marker, mode], {
    cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Child readiness timeout: ${stderr}`)), 5000);
      child.once('message', message => message.ready ? resolve() : reject(new Error('Unexpected child message')));
      child.once('error', reject);
    });
    clearTimeout(timer);
    if (mode === 'forced') assert.equal(child.kill('SIGKILL'), true);
    const termination = await closed;
    const exitListenerRan = await fs.stat(marker).then(() => true, () => false);
    const walBytesBeforeReopen = await fs.stat(filename + '-wal').then(stat => stat.size, () => 0);
    const connection = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      return { mode, ...termination, exitListenerRan, walBytesBeforeReopen,
        committedRowsAfterReopen: connection.prepare('SELECT COUNT(*) AS n FROM committed_records').get().n,
        integrityCheck: connection.pragma('integrity_check', { simple: true }) };
    } finally { connection.close(); }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
  }
}

try {
  const normal = await runCase('normal');
  const forced = await runCase('forced');
  assert.equal(normal.exitListenerRan, true);
  assert.equal(forced.exitListenerRan, false);
  assert.equal(forced.committedRowsAfterReopen, 1);
  assert.equal(forced.integrityCheck, 'ok');
  console.log(JSON.stringify({ platform: process.platform, node: process.version,
    scope: 'Disposable child processes and databases only; no live app or user database touched', normal, forced }, null, 2));
} finally {
  const target = await fs.realpath(directory);
  assert.equal(target, directory);
  assert.equal(path.dirname(target), temporaryParent);
  assert.ok(path.basename(target).startsWith('chandra-shutdown-review-'));
  await fs.rm(target, { recursive: true, force: true });
}
