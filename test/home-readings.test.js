// 2026-11-13: the logic ring read "still" while Logic Chains ran (it counted only reason calls, verifier loops and an
// empty cipher table); the protocol modes changed nothing and reset on restart; 65 chains stayed "running" forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readPulse } from '../server/fraymus-os/pulse.js';
import { activateProtocol, getProtocolModifiers, autonomyPaused } from '../server/awareness/protocol-engine.js';
import { allowedByProtocol } from '../server/intelligence/narrator.js';

test('the logic ring counts every reasoning process and shows the neurons', () => {
  const db = new Database(':memory:');
  const now = Date.now();
  db.exec(`CREATE TABLE runs (status TEXT); CREATE TABLE messages (role TEXT, created_at INTEGER); CREATE TABLE approvals (status TEXT);
    CREATE TABLE fleet_model_calls (at INTEGER); CREATE TABLE reasoner_calls (created_at INTEGER);
    CREATE TABLE chain_stages (ended_at INTEGER); CREATE TABLE chain_runs (status TEXT);
    CREATE TABLE debates (status TEXT, created_at INTEGER); CREATE TABLE capability_items (created_at INTEGER);
    CREATE TABLE verification_loops (status TEXT, created_at INTEGER); CREATE TABLE cipher_runs (status TEXT, created_at INTEGER);`);
  for (let i = 0; i < 6; i++) db.prepare('INSERT INTO chain_stages VALUES (?)').run(now - 60_000);
  db.prepare("INSERT INTO chain_runs VALUES ('running')").run();
  db.prepare("INSERT INTO debates VALUES ('done', ?)").run(now - 30_000);
  db.prepare('INSERT INTO capability_items VALUES (?)').run(now - 10_000);
  const ctrnn = { tick: 100, running: true, metrics: () => ({ activeSynapses: 10, meanActivation: 0.5, connectivityRatio: 0.3, saturationRatio: 0 }), state: () => ({ B: [0, 1, -1, 3], gridSize: 2 }) };
  const p = readPulse({ db, ctrnn, now });
  const logic = p.rings.find(r => r.id === 'logic');
  assert.equal(logic.rate, 1.6, '8 reasoning steps in 5 minutes');
  assert.deepEqual(logic.parts, { 'chain stages': 6, debates: 1, reasoner: 0, benchmark: 1, verifier: 0, cipher: 0 });
  assert.equal(logic.active, 1);
  assert.match(logic.detail, /chain stages 6 · debates 1 · benchmark 1 in 5 min · 1 chain running/);
  assert.deepEqual(p.rings.find(r => r.id === 'matrix').grid, [0, 0.76, -0.76, 1], 'each neuron as tanh(B)');
  db.close();
});

test('a protocol mode changes behaviour: lockdown pauses autonomy, deep work quiets the narrator', () => {
  try {
    activateProtocol('lockdown', 'test');
    assert.equal(autonomyPaused(), true);
    activateProtocol('deep_work', 'test');
    assert.equal(autonomyPaused(), false);
    assert.equal(getProtocolModifiers().intelligenceDepth, 1.5);
    assert.equal(allowedByProtocol('activity'), false, 'routine digest held');
    assert.equal(allowedByProtocol('audit'), true, 'a blocking audit still speaks');
    activateProtocol('creative', 'test');
    assert.equal(allowedByProtocol('daemon'), false);
    assert.equal(allowedByProtocol('goal'), true);
  } finally { activateProtocol('sentinel', 'test'); }
  assert.equal(allowedByProtocol('activity'), true);
});
