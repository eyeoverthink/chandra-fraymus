import test from 'node:test';
import assert from 'node:assert/strict';
import { rollups, buildEvidence, triage, fingerprint, checkLesson, alreadyKnown, anchoredness, dreamMessages, storedText } from '../server/intelligence/dream-ground.js';

const activity = {
  goals: [{ objective: 'Write a parser for FMP/1 receipts', status: 'completed', priority: 'high' }, { objective: 'Summarise hive digests', status: 'failed' }],
  runs: [{ agent: 'fraymus_prime', status: 'error', error: 'Ollama timeout after 180 s' }, { agent: 'helix', status: 'done' }],
  verifications: [{ goal: 'anti-replay window', status: 'passed', iterations_used: 2 }],
  alerts: [{ rule: 'ollama_down', severity: 'critical', message: 'Ollama did not answer for 120 s' }],
  bus: [{ topic: 'system.motor.impulse', from_agent: 'motor', payload: 'tick' }, { topic: 'system.goals', from_agent: 'goal-executor', payload: 'goal_completed quality 0.71' }],
};

test('evidence is short numbered lines written by code, outcomes before intents; self-talk on the bus is left out', () => {
  const lines = buildEvidence({ ...activity, executions: [{ agent_id: 'helix', status: 'completed', quality: 0.27, objective: 'Write a parser for FMP/1 receipts', reply_excerpt: 'I am unable to parse' }] });
  assert.equal(lines[0].id, 'E1'); assert.equal(lines[0].kind, 'outcome');
  assert.equal(lines[0].text, 'helix completed goal "Write a parser for FMP/1 receipts" with quality 0.27; reply began: "I am unable to parse"');
  const intent = lines.find(l => /goal proposed: "Write a parser for FMP\/1 receipts" \(high priority\)/.test(l.text));
  assert.equal(intent.kind, 'intent'); assert.ok(lines.indexOf(intent) > lines.findIndex(l => l.kind === 'outcome'));
  assert.ok(lines.some(l => /fraymus_prime ended error: Ollama timeout after 180 s/.test(l.text)));
  assert.ok(lines.some(l => /system\.goals/.test(l.text)));
  assert.ok(!lines.some(l => /motor\.impulse/.test(l.text)), 'motor ticks are not evidence of anything');
  assert.equal(buildEvidence({ goals: [activity.goals[0], activity.goals[0]] }).length, 1, 'repeats collapse');
});

test('triage: too little, or the same hour again, is not worth a model call', () => {
  const lines = buildEvidence(activity);
  assert.equal(triage(lines.slice(0, 2)).go, false);
  assert.equal(triage(lines).go, true);
  const same = triage(lines, fingerprint(lines));
  assert.equal(same.go, false); assert.match(same.reason, /100 % the same/);
  assert.equal(triage(lines, ['unrelated', 'words']).go, true);
});

test('a lesson stands only on a cited line it quotes exactly, with no number of its own', () => {
  const lines = buildEvidence(activity);
  const e = id => lines.find(l => l.id === id).text, timeout = lines.find(l => /timeout/.test(l.text)).id;
  const good = { lesson: 'fraymus_prime runs fail on an Ollama timeout after 180 s', evidence: [timeout], quote: 'Ollama timeout after 180 s' };
  assert.deepEqual(checkLesson(good, lines), { ok: true, cited: [timeout] });
  assert.equal(checkLesson({ ...good, evidence: [] }, lines).why, 'no_citation');
  assert.equal(checkLesson({ ...good, evidence: ['E99'] }, lines).why, 'unknown_citation');
  assert.equal(checkLesson({ ...good, quote: 'timeout' }, lines).why, 'no_quote');
  assert.equal(checkLesson({ ...good, quote: 'Ollama timeout after 90 s' }, lines).why, 'quote_not_in_evidence');
  assert.equal(checkLesson({ ...good, lesson: 'fraymus_prime fails 40 % of runs on an Ollama timeout' }, lines).why, 'number_not_in_evidence');
  assert.equal(checkLesson({ ...good, lesson: 'Goal-seeking behavior appears to be increasing, indicating a need for ongoing monitoring' }, lines).why, 'too_vague');
  assert.equal(checkLesson({ ...good, evidence: `${timeout}` }, lines).ok, true, 'a string of ids is accepted');
  assert.ok(e(timeout));
});

// The first live measurement: lessons quoted a goal's objective and restated it as a finding. A real quote, nothing learned.
test('a lesson that rests only on what was intended is dropped', () => {
  const lines = buildEvidence(activity), goal = lines.find(l => l.kind === 'intent' && /parser/.test(l.text)).id;
  const restated = { lesson: 'Writing a parser for FMP/1 receipts improves the hive', evidence: [goal], quote: 'Write a parser for FMP/1 receipts' };
  assert.equal(checkLesson(restated, lines).why, 'no_outcome');
  const timeout = lines.find(l => /timeout/.test(l.text)).id;
  assert.equal(checkLesson({ ...restated, evidence: [goal, timeout] }, lines).why, 'no_result', 'an outcome beside it is not enough: it must say how it went');
  assert.equal(checkLesson({ lesson: 'Writing a parser for FMP/1 receipts failed while fraymus_prime runs hit an Ollama timeout', evidence: [goal, timeout], quote: 'Ollama timeout after 180 s' }, lines).ok, true);
});

// Second measurement: the objective came back inside the outcome line, and a 0.20 score was called a success.
test('a lesson must state the result, and not the opposite of it', () => {
  const lines = buildEvidence({ ...activity, executions: [
    { agent_id: 'hybrid-predictor-v1', status: 'completed', quality: 0.2, objective: 'Integrate outcome and pattern memory categories', reply_excerpt: 'I found no relevant memories' },
    { agent_id: 'helix', status: 'completed', quality: 0.82, objective: 'Summarise hive digests', reply_excerpt: 'Digest 164 covers' },
  ] });
  const low = lines.find(l => /hybrid/.test(l.text)).id, high = lines.find(l => /helix completed/.test(l.text)).id;
  const objective = { lesson: 'Outcome and pattern memory categories can be integrated to uncover hidden correlations', evidence: [low], quote: 'Integrate outcome and pattern memory categories' };
  assert.equal(checkLesson(objective, lines).why, 'no_result');
  assert.equal(checkLesson({ ...objective, lesson: 'hybrid-predictor-v1 successfully integrated outcome and pattern memory categories' }, lines).why, 'result_contradicts');
  assert.equal(checkLesson({ ...objective, lesson: 'hybrid-predictor-v1 scored 0.20 integrating outcome and pattern memory categories and found no relevant memories' }, lines).ok, true);
  assert.equal(checkLesson({ lesson: 'helix failed to summarise hive digests', evidence: [high], quote: 'helix completed goal Summarise hive digests' }, lines).why, 'result_contradicts');
});

// First live grounded dream: five "found nothing" replies all scored low; the model wrote about single goals instead.
test('patterns across the hour are computed by code and offered first, and a lesson may stand on them', () => {
  const ex = [
    { agent_id: 'hybrid', status: 'completed', quality: 0.27, objective: 'a', reply_excerpt: 'I am unable to generate a dream' },
    { agent_id: 'hybrid', status: 'completed', quality: 0.20, objective: 'b', reply_excerpt: 'I found no relevant memories in the search' },
    { agent_id: 'pattern', status: 'completed', quality: 0.06, objective: 'c', reply_excerpt: 'It seems that no relevant memories were found' },
    { agent_id: 'synth', status: 'completed', quality: 0.69, objective: 'd', reply_excerpt: '**Investigation Report:**' },
    { agent_id: 'hybrid', status: 'completed', quality: 0.48, objective: 'e', reply_excerpt: 'The reasoning process has identified' },
  ];
  assert.deepEqual(rollups(ex), [
    'hybrid ran 3 goals this hour, quality 0.20 to 0.48, mean 0.32',
    '3 of 5 goals this hour got a reply saying the agent found nothing or could not act; those scored 0.06 to 0.27, mean 0.18; the other 2 scored mean 0.58',
  ]);
  const lines = buildEvidence({ executions: ex });
  assert.match(lines[0].text, /^hybrid ran 3 goals/); assert.match(lines[1].text, /^3 of 5 goals/);
  const lesson = { lesson: 'Goals whose reply found nothing scored a mean of 0.18, against 0.58 for the rest', evidence: [lines[1].id], quote: 'the other 2 scored mean 0.58' };
  assert.deepEqual(checkLesson(lesson, lines), { ok: true, cited: [lines[1].id] });
  assert.deepEqual(rollups(ex.slice(3)), [], 'no pattern from too little');
  // fourth measurement: praise over a middling record is refused, an honest summary of it is kept
  assert.equal(checkLesson({ lesson: 'hybrid completes its goals with high quality', evidence: [lines[0].id], quote: 'hybrid ran 3 goals this hour' }, lines).why, 'result_contradicts');
  assert.equal(checkLesson({ lesson: 'hybrid ran 3 goals and scored poorly, a mean quality of 0.32', evidence: [lines[0].id], quote: 'hybrid ran 3 goals this hour' }, lines).ok, true);
});

test('a lesson already known is not stored again; anchoredness is the share of its words in the evidence', () => {
  assert.equal(alreadyKnown('fraymus_prime runs fail on an Ollama timeout', ['Fraymus_prime runs fail on Ollama timeouts often', 'unrelated']), false);
  assert.equal(alreadyKnown('fraymus_prime runs fail on an Ollama timeout', ['fraymus_prime runs fail on an Ollama timeout [evidence E2: "x"]']), true);
  assert.equal(anchoredness('helix done', [{ text: 'agent run by helix ended done' }]), 1);
  assert.equal(anchoredness('', [{ text: 'x' }]), 0);
});

test('the prompt numbers the evidence and asks for citations; what is stored carries its quote', () => {
  const lines = buildEvidence(activity), m = dreamMessages(lines);
  assert.match(m[0].content, /copied EXACTLY/); assert.match(m[1].content, /^EVIDENCE:\nE1\. \[outcome\] /); assert.match(m[1].content, /\[intent\] goal proposed/);
  assert.equal(storedText({ lesson: 'L', evidence: ['E1'], quote: 'q q q q' }), 'L [evidence E1: "q q q q"]');
});
