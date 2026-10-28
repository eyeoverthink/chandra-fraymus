import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodeEffectStore } from '../server/agent/code-effects.js';
import { hash, stableJson } from '../server/agent/schema.js';

const identity = (extra = {}) => ({ runId: 'owner', callId: 'native-call', engine: 'docker', language: 'python', argsHash: hash('not-stored-code'), ...extra });
const finished = extra => ({ outcome: 'finished', dispatchAttempted: true, codeMayHaveRun: true, isolationVerified: true,
  termination: 'exit', cleanup: { confirmed: true, removed: true }, exitCode: 0, proof: { isolation: 'docker-linux', network: false, hostMounts: false, limits: { memoryBytes: 268435456, pids: 64 } }, ...extra });
const unknown = extra => finished({ outcome: 'unknown', termination: 'interrupted_unknown', cleanup: { confirmed: false }, ...extra });
const notStarted = extra => ({ outcome: 'not_started', dispatchAttempted: false, codeMayHaveRun: false, isolationVerified: false,
  termination: 'not_started', cleanup: { confirmed: true }, ...extra });
function initialize(db) {
  db.exec('CREATE TABLE agent_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,deadline_at INTEGER NOT NULL,usage_json TEXT NOT NULL)');
  db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?)').run('owner', 'running', Date.now() + 60000, JSON.stringify({ totalTokens: 12 }));
}
function fixture(t, onReceipt) {
  const db = new DatabaseSync(':memory:'); initialize(db); const events = [];
  const store = createCodeEffectStore({ db, onReceipt: onReceipt ?? ((runId, receipt) => events.push({ runId, receipt })) });
  t.after(() => db.close());
  return { db, store, events, row: () => db.prepare('SELECT * FROM agent_code_effects').get(), count: () => db.prepare('SELECT count(*) AS n FROM agent_code_effects').get().n };
}

test('begin/dispatch are silent durable state transitions; opaque original tickets contain no serializable code or identity', t => {
  const f = fixture(t); assert.equal(f.count(), 0); assert.equal(f.events.length, 0);
  const ticket = f.store.begin(identity()); assert.equal(Object.isFrozen(ticket), true); assert.deepEqual(Object.keys(ticket), []); assert.equal(JSON.stringify(ticket), '{}');
  assert.match(ticket.executionId, /^[a-f0-9-]{36}$/); assert.throws(() => { ticket.executionId = 'changed'; }, TypeError);
  const prepared = f.store.get(ticket.executionId); assert.equal(prepared.status, 'prepared'); assert.equal(prepared.receipt, null);
  assert.equal(prepared.argsHash, identity().argsHash); assert.equal(f.row().dispatch_attempted, 0); assert.equal(f.events.length, 0);
  assert.equal(f.store.dispatch(ticket).status, 'dispatching'); assert.equal(f.row().dispatch_attempted, 1); assert.equal(f.events.length, 0);
  const receipt = f.store.settle(ticket, finished({ exitCode: 7 }));
  assert.equal(receipt.kind, 'code_execution'); assert.equal(receipt.effectId, ticket.executionId); assert.equal(receipt.complete, true);
  assert.equal(receipt.outcome, 'finished'); assert.equal(receipt.exitCode, 7, 'finished is lifecycle completion, not a successful program result');
  assert.equal(f.store.get(ticket.executionId).status, 'settled'); assert.equal(f.events.length, 1); assert.equal(f.events[0].runId, 'owner');
  assert.equal(f.row().receipt_json, stableJson(receipt)); assert.ok(!JSON.stringify(f.row()).includes('not-stored-code'));
  assert.equal(Object.isFrozen(receipt.proof.limits), true); assert.equal(Object.isFrozen(f.store.get(ticket.executionId)), true);
});

test('identity validation accepts only exact bounded run/call/hash and supported server-owned engine/language', t => {
  const f = fixture(t);
  for (const input of [{}, identity({ runId: 'bad\nrun' }), identity({ callId: 'x'.repeat(129) }), identity({ engine: 'host' }),
    identity({ language: 'node' }), identity({ argsHash: 'short' }), { ...identity(), code: 'raw source' }])
    assert.throws(() => f.store.begin(input), { code: 'code_effect_arguments' });
  assert.equal(f.count(), 0); assert.equal(f.store.get('absent'), null);
  assert.throws(() => f.store.quarantined('host'), { code: 'code_effect_arguments' });
});

test('begin requires a running unexpired owner and FULL or EXTRA before any journal row', t => {
  const f = fixture(t);
  for (const status of ['queued', 'awaiting_approval', 'cancelled', 'failed', 'completed']) {
    f.db.prepare('UPDATE agent_runs SET status=?').run(status);
    assert.throws(() => f.store.begin(identity()), { code: 'code_effect_inactive' }); assert.equal(f.count(), 0);
  }
  f.db.prepare("UPDATE agent_runs SET status='running',deadline_at=?").run(Date.now() - 1);
  assert.throws(() => f.store.begin(identity()), { code: 'code_effect_inactive' });
  f.db.prepare('UPDATE agent_runs SET deadline_at=?').run(Date.now() + 60000); f.db.exec('PRAGMA synchronous=NORMAL');
  assert.throws(() => f.store.begin(identity()), { code: 'workspace_journal_not_durable' }); assert.equal(f.count(), 0);
  f.db.exec('PRAGMA synchronous=EXTRA'); assert.ok(f.store.begin(identity()).executionId);
});

test('dispatch independently rechecks owner, deadline and FULL and cannot be called twice', t => {
  const f = fixture(t), ticket = f.store.begin(identity());
  f.db.prepare("UPDATE agent_runs SET status='cancelled'").run(); assert.throws(() => f.store.dispatch(ticket), { code: 'code_effect_inactive' });
  f.db.prepare("UPDATE agent_runs SET status='running',deadline_at=?").run(Date.now() - 1); assert.throws(() => f.store.dispatch(ticket), { code: 'code_effect_inactive' });
  f.db.prepare('UPDATE agent_runs SET deadline_at=?').run(Date.now() + 60000); f.db.exec('PRAGMA synchronous=NORMAL');
  assert.throws(() => f.store.dispatch(ticket), { code: 'workspace_journal_not_durable' }); assert.equal(f.store.get(ticket.executionId).status, 'prepared');
  f.db.exec('PRAGMA synchronous=FULL'); f.store.dispatch(ticket);
  assert.throws(() => f.store.dispatch(ticket), { code: 'code_effect_already_dispatched' }); assert.equal(f.events.length, 0);
});

test('run/call idempotence returns only the original local ticket; different identity and transferred/forged tickets fail', t => {
  const f = fixture(t), ticket = f.store.begin(identity()); assert.equal(f.store.begin(identity()), ticket); assert.equal(f.count(), 1);
  for (const changed of [identity({ argsHash: hash('different') }), identity({ language: 'javascript' })])
    assert.throws(() => f.store.begin(changed), { code: 'code_effect_identity' });
  const another = createCodeEffectStore({ db: f.db });
  assert.throws(() => another.begin(identity()), { code: 'code_effect_exists' });
  assert.throws(() => another.dispatch(ticket), { code: 'code_effect_ticket' });
  for (const forged of [{ executionId: ticket.executionId }, { ...ticket }, null, Object.create(ticket)])
    assert.throws(() => f.store.dispatch(forged), { code: 'code_effect_ticket' });
  f.db.prepare('UPDATE agent_code_effects SET args_hash=?').run(hash('journal tamper'));
  assert.throws(() => f.store.dispatch(ticket), { code: 'code_effect_identity' });
});

test('late original-ticket settlement after run cancellation/deadline preserves receipts without reviving run or charging anything', t => {
  const f = fixture(t), ticket = f.store.begin(identity()); f.store.dispatch(ticket);
  f.db.prepare("UPDATE agent_runs SET status='cancelled',deadline_at=?").run(Date.now() - 100);
  const receipt = f.store.settle(ticket, finished({ termination: 'cancelled', exitCode: null }));
  assert.equal(receipt.outcome, 'finished'); assert.equal(f.events.length, 1);
  assert.equal(f.db.prepare('SELECT status FROM agent_runs').get().status, 'cancelled');
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT usage_json FROM agent_runs').get().usage_json), { totalTokens: 12 });
  assert.deepEqual(f.store.settle(ticket, finished({ termination: 'cancelled', exitCode: null })), receipt);
  assert.equal(f.events.length, 1); assert.equal(f.row().receipt_version, 1);
});

test('unknown cleanup quarantines its engine across new stores and blocks already-prepared dispatch too', t => {
  const f = fixture(t), one = f.store.begin(identity()), two = f.store.begin(identity({ callId: 'other-call' }));
  f.store.dispatch(one); const uncertain = f.store.settle(one, unknown());
  assert.equal(uncertain.outcome, 'unknown'); assert.equal(uncertain.complete, true); assert.equal(f.store.get(one.executionId).status, 'unknown');
  assert.equal(f.store.quarantined('docker').length, 1); assert.equal(createCodeEffectStore({ db: f.db }).quarantined('docker').length, 1);
  assert.throws(() => f.store.begin(identity({ callId: 'new-call' })), { code: 'code_engine_quarantined' });
  assert.throws(() => f.store.dispatch(two), { code: 'code_engine_quarantined' }); assert.equal(f.store.get(two.executionId).status, 'prepared');
  assert.deepEqual(f.store.settle(one, unknown()), uncertain); assert.equal(f.events.length, 1);
  const certain = f.store.settle(one, finished()); assert.equal(certain.effectId, uncertain.effectId);
  assert.equal(f.store.quarantined('docker').length, 0); assert.equal(f.events.length, 2); assert.equal(f.store.dispatch(two).status, 'dispatching');
});

test('unknown may resolve to proven not-started after engine launch, while conflicting terminal outcomes cannot overwrite evidence', t => {
  const f = fixture(t), ticket = f.store.begin(identity()); f.store.dispatch(ticket);
  f.store.settle(ticket, unknown({ codeMayHaveRun: true }));
  const proven = notStarted({ dispatchAttempted: true, termination: 'preflight_failed' });
  const receipt = f.store.settle(ticket, proven); assert.equal(receipt.outcome, 'not_started'); assert.equal(receipt.dispatchAttempted, true);
  assert.equal(receipt.codeMayHaveRun, false); assert.equal(f.store.quarantined('docker').length, 0);
  assert.deepEqual(f.store.settle(ticket, proven), receipt);
  assert.throws(() => f.store.settle(ticket, finished()), { code: 'code_effect_conflict' }); assert.equal(f.events.length, 2);
});

test('unknown with conclusive cleanup is an immutable audit outcome but does not quarantine a clean engine', t => {
  const f = fixture(t), ticket = f.store.begin(identity()); f.store.dispatch(ticket);
  f.store.settle(ticket, unknown({ cleanup: { confirmed: true, removed: true } }));
  assert.equal(f.store.quarantined('docker').length, 0); assert.equal(f.store.get(ticket.executionId).status, 'unknown');
  assert.throws(() => f.store.settle(ticket, finished()), { code: 'code_effect_conflict' });
  assert.ok(f.store.begin(identity({ callId: 'new-call' })).executionId);
});

test('failed settlement write quarantines the current engine until the original ticket conclusively proves cleanup', t => {
  const f = fixture(t), ticket = f.store.begin(identity()); f.store.dispatch(ticket);
  f.db.exec("CREATE TRIGGER fail_owned_settlement BEFORE UPDATE ON agent_code_effects WHEN NEW.status='settled' BEGIN SELECT RAISE(ABORT,'owned settlement failure'); END");
  assert.throws(() => f.store.settle(ticket, finished()), /owned settlement failure/);
  assert.equal(f.store.get(ticket.executionId).status, 'dispatching'); assert.equal(f.store.quarantined('docker').length, 1);
  assert.throws(() => f.store.begin(identity({ callId: 'blocked-new-call' })), { code: 'code_engine_quarantined' });
  f.store.settle(ticket, unknown()); assert.equal(f.store.quarantined('docker').length, 1, 'persisted unknown and runtime failure are deduplicated');
  f.db.exec('DROP TRIGGER fail_owned_settlement'); f.store.settle(ticket, finished());
  assert.equal(f.store.quarantined('docker').length, 0); assert.ok(f.store.begin(identity({ callId: 'allowed-new-call' })).executionId);
  assert.throws(() => f.store.settle(ticket, finished({ exitCode: 7 })), { code: 'code_effect_conflict' });
  assert.equal(f.store.quarantined('docker').length, 0, 'conflicting replay of a healthy terminal effect cannot poison engine health');
});

test('post-dispatch receipt validation failure also blocks new work without inventing a durable settlement', t => {
  const f = fixture(t), ticket = f.store.begin(identity()); f.store.dispatch(ticket);
  assert.throws(() => f.store.settle(ticket, finished({ stdout: 'invalid independent output' })), { code: 'code_effect_receipt' });
  assert.equal(f.store.get(ticket.executionId).status, 'dispatching'); assert.equal(f.store.quarantined('docker').length, 1);
  assert.throws(() => f.store.begin(identity({ callId: 'blocked-call' })), { code: 'code_engine_quarantined' });
  f.store.settle(ticket, finished()); assert.equal(f.store.quarantined('docker').length, 0);
});

test('silently ignored SQLite updates cannot authorize dispatch or report phantom settled success', t => {
  const f = fixture(t), ticket = f.store.begin(identity());
  f.db.exec("CREATE TRIGGER ignore_owned_dispatch BEFORE UPDATE ON agent_code_effects WHEN NEW.status='dispatching' BEGIN SELECT RAISE(IGNORE); END");
  assert.throws(() => f.store.dispatch(ticket), { code: 'code_effect_write' }); assert.equal(f.store.get(ticket.executionId).status, 'prepared');
  f.db.exec('DROP TRIGGER ignore_owned_dispatch'); f.store.dispatch(ticket);
  f.db.exec("CREATE TRIGGER ignore_owned_settlement BEFORE UPDATE ON agent_code_effects WHEN NEW.status='settled' BEGIN SELECT RAISE(IGNORE); END");
  assert.throws(() => f.store.settle(ticket, finished()), { code: 'code_effect_write' });
  assert.equal(f.store.get(ticket.executionId).status, 'dispatching'); assert.equal(f.events.length, 0); assert.equal(f.store.quarantined('docker').length, 1);
  assert.throws(() => f.store.begin(identity({ callId: 'blocked-call' })), { code: 'code_engine_quarantined' });
  f.db.exec('DROP TRIGGER ignore_owned_settlement'); f.store.settle(ticket, finished()); assert.equal(f.store.quarantined('docker').length, 0);
});

test('prepared tickets can only settle as conclusively not started; cleanup uncertainty normalizes dispatched finished to unknown', t => {
  const f = fixture(t), first = f.store.begin(identity());
  assert.throws(() => f.store.settle(first, finished()), { code: 'code_effect_receipt' });
  const stopped = f.store.settle(first, notStarted()); assert.equal(stopped.outcome, 'not_started'); assert.equal(stopped.dispatchAttempted, false);
  const second = f.store.begin(identity({ callId: 'second' })); f.store.dispatch(second);
  const normalized = f.store.settle(second, finished({ cleanup: { confirmed: false } }));
  assert.equal(normalized.outcome, 'unknown'); assert.equal(normalized.cleanup.confirmed, false); assert.equal(f.store.quarantined('docker').length, 1);
});

test('malformed identities, inconsistent lifecycle facts, source/output payloads and excessive metadata cannot become receipts', t => {
  const f = fixture(t), ticket = f.store.begin(identity()); f.store.dispatch(ticket);
  const excessive = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['field' + i, 'x'.repeat(1024)]));
  const deep = {}; let cursor = deep; for (let i = 0; i < 8; i++) cursor = cursor.next = {};
  const sparse = new Array(2); sparse[1] = 'only second';
  for (const receipt of [{}, finished({ effectId: 'other' }), finished({ executionId: 'other' }), finished({ engine: 'host' }), finished({ language: 'javascript' }),
    finished({ kind: 'other' }), finished({ complete: false }), finished({ dispatchAttempted: false }), finished({ codeMayHaveRun: false }),
    finished({ cleanup: {} }), finished({ termination: 'bad\ntermination' }), finished({ exitCode: 1.1 }), finished({ errorCode: 'private failure text' }),
    finished({ stdout: 'must not persist' }), finished({ code: 'raw script' }), finished({ proof: 'text' }), finished({ proof: { commandLine: 'raw script' } }),
    finished({ proof: { source: 'raw source' } }), finished({ proof: { env: { KEY: 'secret' } } }), finished({ proof: { label: '\ud800' } }),
    finished({ proof: { label: 'bad\0text' } }), finished({ proof: deep }), finished({ proof: excessive }), finished({ proof: { items: sparse } }),
    finished({ proof: { binary: Buffer.from('bytes') } }), finished({ proof: { items: new Array(33).fill(1) } })]) {
    assert.throws(() => f.store.settle(ticket, receipt), caught => ['code_effect_receipt', 'code_effect_identity'].includes(caught.code));
    assert.equal(f.store.get(ticket.executionId).status, 'dispatching'); assert.equal(f.events.length, 0);
  }
});

test('stored status/dispatch/receipt corruption is rejected before get, replay or quarantine can claim success', t => {
  const f = fixture(t), ticket = f.store.begin(identity()); f.store.dispatch(ticket); f.store.settle(ticket, finished());
  const row = f.row(), base = JSON.parse(row.receipt_json);
  const mutations = [
    () => f.db.prepare("UPDATE agent_code_effects SET status='unknown'").run(),
    () => f.db.prepare('UPDATE agent_code_effects SET dispatch_attempted=0').run(),
    () => f.db.prepare('UPDATE agent_code_effects SET receipt_json=?').run(stableJson({ ...base, effectId: 'other' })),
    () => f.db.prepare('UPDATE agent_code_effects SET receipt_json=?').run(stableJson({ ...base, outcome: 'not_started' })),
    () => f.db.prepare('UPDATE agent_code_effects SET receipt_json=?').run('x'.repeat(20000)),
    () => f.db.prepare('UPDATE agent_code_effects SET receipt_json=?').run(JSON.stringify(Object.fromEntries(Object.entries(base).reverse()))),
  ];
  for (const mutate of mutations) {
    mutate(); assert.throws(() => f.store.get(ticket.executionId), { code: 'code_effect_corrupt' });
    assert.throws(() => f.store.settle(ticket, finished()), { code: 'code_effect_corrupt' });
    f.db.prepare('UPDATE agent_code_effects SET status=?,dispatch_attempted=?,receipt_json=?').run(row.status, row.dispatch_attempted, row.receipt_json);
  }
  assert.equal(f.events.length, 1);
});

test('recovery is metadata-only: prepared becomes not started, dispatched becomes unknown, and every original run may be terminal', t => {
  const f = fixture(t), prepared = f.store.begin(identity()), sent = f.store.begin(identity({ callId: 'sent' })); f.store.dispatch(sent);
  f.db.prepare("UPDATE agent_runs SET status='cancelled'").run();
  const recovered = f.store.recover(); assert.equal(recovered.length, 2); assert.equal(f.events.length, 2);
  assert.equal(f.store.get(prepared.executionId).receipt.outcome, 'not_started'); assert.equal(f.store.get(prepared.executionId).receipt.cleanup.confirmed, true);
  const uncertain = f.store.get(sent.executionId).receipt; assert.equal(uncertain.outcome, 'unknown'); assert.equal(uncertain.codeMayHaveRun, true); assert.equal(uncertain.isolationVerified, false);
  assert.equal(f.store.quarantined('docker').length, 1); assert.equal(f.store.recover().length, 0); assert.equal(f.events.length, 2);
  assert.throws(() => f.store.dispatch(prepared), { code: 'code_effect_already_dispatched' });
  f.store.settle(sent, finished()); assert.equal(f.store.quarantined('docker').length, 0);
});

test('file SQLite restart preserves unknown quarantine, forbids minting original tickets and retries only missing acknowledgement', async t => {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'chandra-code-effect-')), original = await fs.realpath(directory), file = path.join(directory, 'journal.sqlite');
  let db = new DatabaseSync(file);
  t.after(async () => {
    db.close(); const resolved = await fs.realpath(directory); assert.equal(resolved, original); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('chandra-code-effect-'));
    for (const suffix of ['', '-wal', '-shm', '-journal']) await fs.unlink(file + suffix).catch(caught => { if (caught.code !== 'ENOENT') throw caught; });
    await fs.rmdir(resolved);
  });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'); initialize(db);
  const first = createCodeEffectStore({ db }), before = first.begin(identity()), after = first.begin(identity({ callId: 'after' })); first.dispatch(after);
  db.exec("CREATE TRIGGER fail_owned_settlement BEFORE UPDATE ON agent_code_effects WHEN NEW.call_id='after' AND NEW.status='settled' BEGIN SELECT RAISE(ABORT,'owned durable settlement failure'); END");
  assert.throws(() => first.settle(after, finished()), /owned durable settlement failure/); assert.equal(first.quarantined('docker').length, 1); db.close();
  db = new DatabaseSync(file); const events = [], restarted = createCodeEffectStore({ db, onReceipt: (_runId, receipt) => { events.push(receipt); throw new Error('Owned ack failure'); } });
  assert.equal(events.length, 0, 'construction is inert'); restarted.recover(); assert.equal(events.length, 2);
  assert.equal(restarted.get(before.executionId).receipt.outcome, 'not_started'); assert.equal(restarted.get(after.executionId).receipt.outcome, 'unknown');
  assert.throws(() => restarted.settle(after, finished()), { code: 'code_effect_ticket' }); assert.equal(restarted.quarantined('docker').length, 1);
  const acknowledged = [], final = createCodeEffectStore({ db, onReceipt: (_runId, receipt) => acknowledged.push(receipt) });
  final.recover(); assert.equal(acknowledged.length, 2); final.recover(); assert.equal(acknowledged.length, 2);
  assert.equal(final.quarantined('docker').length, 1);
});

test('frozen observer snapshots cannot alter canonical persisted or returned receipts; failure leaves only the latest ack pending', t => {
  let observed;
  const f = fixture(t, (_runId, receipt) => { observed = receipt; assert.throws(() => { receipt.outcome = 'finished'; }, TypeError);
    assert.throws(() => { receipt.cleanup.confirmed = true; }, TypeError); throw new Error('Owned observer failure'); });
  const ticket = f.store.begin(identity()); f.store.dispatch(ticket); const receipt = f.store.settle(ticket, unknown());
  assert.equal(receipt.outcome, 'unknown'); assert.equal(f.row().notified_at, null); assert.notEqual(receipt, observed); assert.deepEqual(receipt, observed);
  const seen = [], recovery = createCodeEffectStore({ db: f.db, onReceipt: (_runId, value) => seen.push(value) });
  recovery.recover(); assert.equal(seen.length, 1); assert.equal(seen[0].outcome, 'unknown'); recovery.recover(); assert.equal(seen.length, 1);
});

test('async observers never schedule an untracked database acknowledgement or an unhandled rejection', async t => {
  const f = fixture(t, async () => { throw new Error('Owned async callback failure'); }), ticket = f.store.begin(identity()); f.store.dispatch(ticket);
  f.store.settle(ticket, finished()); await Promise.resolve(); assert.equal(f.row().notified_at, null);
  const seen = [], restarted = createCodeEffectStore({ db: f.db, onReceipt: (_runId, receipt) => seen.push(receipt) });
  restarted.recover(); assert.equal(seen.length, 1); assert.equal(seen[0].complete, true); assert.ok(f.row().notified_at);
});

test('a newer reentrant late-cleanup receipt cannot be overwritten or falsely acknowledged by an older callback', t => {
  let ticket, store, nested = false; const events = [], db = new DatabaseSync(':memory:'); initialize(db); t.after(() => db.close());
  store = createCodeEffectStore({ db, onReceipt: (_runId, receipt) => { events.push(receipt); if (!nested) { nested = true; store.settle(ticket, finished()); } } });
  ticket = store.begin(identity()); store.dispatch(ticket); const initial = store.settle(ticket, unknown());
  assert.equal(initial.outcome, 'unknown'); assert.deepEqual(events.map(value => value.outcome), ['unknown', 'finished']);
  const row = db.prepare('SELECT * FROM agent_code_effects').get(); assert.equal(row.receipt_version, 2); assert.ok(row.notified_at);
  assert.equal(store.get(ticket.executionId).receipt.outcome, 'finished'); assert.equal(store.quarantined('docker').length, 0);
});
