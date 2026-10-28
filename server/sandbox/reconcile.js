import Database from 'better-sqlite3';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from '../config.js';
import { acquireDataLock } from '../data-lock.js';
import { createCodeEffectStore } from '../agent/code-effects.js';
import { createDockerCleanupObserver } from './observe-cleanup.js';

/** Offline operator command: owns the same OS lock as the app. Engine operations
 * are observation only; mutations update the durable cleanup receipt and append
 * its history event without changing the source-run state. */
export async function reconcileSandbox({ executionId, dataDir = DATA_DIR,
  observe = createDockerCleanupObserver() } = {}) {
  if (typeof executionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(executionId)) throw Object.assign(new Error('Provide one exact execution UUID'), { code: 'code_reconcile_arguments' });
  const directory = await realpath(dataDir), databaseFile = path.join(directory, 'chandra.db');
  if (!(await stat(databaseFile)).isFile()) throw new Error('Existing agent database required');
  const lock = await acquireDataLock(directory);
  let db;
  try {
    db = new Database(databaseFile, { fileMustExist: true });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_code_effects'").get()) throw new Error('Existing code journal required');
    db.pragma('synchronous = FULL');
    const store = createCodeEffectStore({ db, onReceipt(runId, receipt) {
      db.transaction(() => {
        const owner = db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId);
        if (!owner || !['completed', 'failed', 'cancelled'].includes(owner.status)) throw new Error('Reconciliation requires a terminal source run');
        const sequence = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM agent_run_events WHERE run_id=?').get(runId).n;
        db.prepare('INSERT INTO agent_run_events(run_id,sequence,type,data_json,created_at) VALUES(?,?,?,?,?)')
          .run(runId, sequence, 'code_receipt', JSON.stringify({ receipt }), Date.now());
      }).immediate();
    } });
    const receipt = await store.reconcileCleanup(executionId, observe);
    return { executionId, receipt, historyEventPublished: db.prepare('SELECT notified_at FROM agent_code_effects WHERE id=?').get(executionId).notified_at !== null,
      quarantined: store.quarantined('docker').map(value => value.executionId),
      engineResourcesChanged: false, sourceRunRevived: false };
  } finally { try { db?.close(); } finally { await lock.release(); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--execution') {
    console.error('Usage: npm run sandbox:reconcile -- --execution <UUID> (app must be stopped)');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await reconcileSandbox({ executionId: args[1] }), null, 2)); }
    catch (error) { console.error(JSON.stringify({ pass: false, code: error.code || 'code_reconcile_failed', error: error.message, quarantineState: 'inspect_durable_receipts', engineResourcesChanged: false })); process.exitCode = 1; }
  }
}
