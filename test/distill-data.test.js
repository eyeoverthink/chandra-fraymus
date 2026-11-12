import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDistiller, isHeldOut, secretIn, narrates, rejectChat, pixelReply, runToChat } from '../server/intelligence/distill-data.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE goal_executions (id TEXT, run_id TEXT, thread_id TEXT, agent_id TEXT, quality REAL);
    CREATE TABLE outcome_feedback (exec_id TEXT, rating INTEGER, created_at INTEGER);
    CREATE TABLE messages (thread_id TEXT, run_id TEXT, role TEXT, content TEXT, tool_calls TEXT, name TEXT, created_at INTEGER);
    CREATE TABLE verification_loops (id TEXT, goal TEXT, language TEXT, final_code TEXT, status TEXT);`);
  // as stored live: the task sits on the thread with no run id; the run's own messages carry the run id
  const run = (id, run, agent, q, msgs) => {
    db.prepare(`INSERT INTO goal_executions VALUES (?,?,?,?,?)`).run(id, run, `t-${id}`, agent, q);
    db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?)`).run(`t-${id}`, null, 'user', 'an older, unrelated task', null, null, -5);
    msgs.forEach((m, i) => db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?)`).run(`t-${id}`, m.role === 'user' ? null : run, m.role, m.content ?? '', m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.name ?? null, i));
  };
  const call = [{ id: 'c1', function: { name: 'self_audit_status', arguments: { mode: 'status' } } }];
  const good = [{ role: 'user', content: 'Check the self audit' }, { role: 'assistant', content: '', tool_calls: call }, { role: 'tool', name: 'self_audit_status', content: '{"open":2}' }, { role: 'assistant', content: 'Two findings are open.' }];
  run('up1', 'r1', 'helix', 0.4, good);                                   // 👍 although the machine scored it 0.4
  run('tool1', 'r2', 'helix', 0.7, good);                                 // good run with a real tool call
  run('down1', 'r3', 'helix', 0.9, good);                                 // scored high, voted down: never used
  run('narr', 'r4', 'helix', 0.8, [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: call }, { role: 'tool', content: '{}' }, { role: 'assistant', content: 'The tool returned: {"ok":true}' }]);
  run('nudged', 'r5', 'helix', 0.8, [...good.slice(0, 3), { role: 'system', content: '[harness] make the real call' }, good[3]]);
  run('notool', 'r6', 'helix', 0.9, [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'done' }]);
  run('badcall', 'r8', 'helix', 0.6, [good[0], good[1], { role: 'tool', content: '{"result":{"error":"missing required field(s): inputs"}}' }, { role: 'assistant', content: 'The objective is not actionable.' }]);
  run('leak', 'r7', 'helix', 0.8, [...good.slice(0, 3), { role: 'assistant', content: 'use api_key = "abcd1234efgh5678ijkl"' }]);
  db.prepare(`INSERT INTO outcome_feedback VALUES (?,?,?)`).run('up1', 1, 1);
  db.prepare(`INSERT INTO outcome_feedback VALUES (?,?,?)`).run('down1', 1, 1);
  db.prepare(`INSERT INTO outcome_feedback VALUES (?,?,?)`).run('down1', -1, 2);     // latest vote wins
  db.prepare(`INSERT INTO verification_loops VALUES (?,?,?,?,?)`).run('v1', 'anti-replay window', 'javascript', 'console.log("ALL PASS")', 'passed');
  db.prepare(`INSERT INTO verification_loops VALUES (?,?,?,?,?)`).run('v2', 'x', 'javascript', 'boom', 'error');
  return db;
}

test('only verified work is collected; votes, narration, harness nudges and secrets decide what is left out', () => {
  const { records, excluded, bySource } = createDistiller({ db: fixture() }).collect();
  const ids = records.map(r => `${r.source}:${r.id}`).sort();
  assert.deepEqual(ids, ['human_up:up1', 'tool_run:tool1', 'verified_code:v1']);
  assert.deepEqual(excluded.tool_run, { narrated_tool_call: 1, harness_nudged: 1, secret_shaped: 1, tool_call_failed: 1 });
  assert.equal(Object.values(bySource).reduce((s, b) => s + b.train + b.heldOut, 0), 3);
  const chat = records.find(r => r.id === 'tool1').messages;
  assert.equal(chat[0].role, 'system');
  assert.equal(chat[1].content, 'Check the self audit', 'the task is the thread message just before the run, not an older one');
  assert.deepEqual(chat[2].tool_calls, [{ type: 'function', function: { name: 'self_audit_status', arguments: { mode: 'status' } } }]);
  assert.equal(chat[3].role, 'tool'); assert.equal(chat.at(-1).content, 'Two findings are open.');
});

test('the held-out share is fixed by id, about a fifth, and the same every time', () => {
  const n = 5000, held = Array.from({ length: n }, (_, i) => isHeldOut('tool_run', `x${i}`)).filter(Boolean).length;
  assert.ok(held > n * 0.18 && held < n * 0.22, `${held}`);
  assert.equal(isHeldOut('tool_run', 'abc'), isHeldOut('tool_run', 'abc'));
});

test('secret-shaped strings and narrated calls are recognised; ordinary hashes are not secrets', () => {
  assert.ok(secretIn('token: ghp_' + 'a'.repeat(36)));
  assert.ok(secretIn('-----BEGIN OPENSSH PRIVATE KEY-----'));
  assert.equal(secretIn('sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'), null);
  assert.ok(narrates('Tool Response: {"x":1}')); assert.ok(narrates('{"name": "weather_lookup", "parameters": {"city": "x"}}'));
  assert.equal(narrates('I called self_audit_status and two findings are open.'), false);
  assert.equal(rejectChat(runToChat('a', [{ role: 'user', content: 'x' }])), 'no_final_answer');
});

test('a film script is rebuilt into the reply shape and kept only if the checker accepts it', () => {
  const reply = pixelReply({ title: 'T', places: ['a pier', 'a boat'], cast: [{ name: 'mo', look: 'a girl' }, { name: 'bo', look: 'a dog' }], scenes: [{ speaker: 'mo', say: 'Hi.', place: 1 }] });
  assert.deepEqual(reply, { title: 'T', cast: [{ name: 'mo', look: 'a girl' }, { name: 'bo', look: 'a dog' }], scenes: [{ speaker: 'mo', place: 'a boat', say: 'Hi.' }] });
  assert.equal(pixelReply({ scenes: [{ say: 'x' }] }), null, 'no cast in an old lineage: cannot be rebuilt');
});
