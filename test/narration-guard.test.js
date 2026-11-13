import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narratedToolCall, nudgeMessage, recoverTextToolCall } from '../server/fleet/narration-guard.js';

const tools = [{ name: 'reason' }, { name: 'skill.replay_window' }, { name: 'bus_publish' }];

test('detects a described call with an invented result', () => {
  assert.equal(narratedToolCall('I will call the `reason` tool.\n**Tool Response:**\n{"answer": 4211, "exitCode": 0}', tools), 'reason');
  assert.equal(narratedToolCall('Using the reason tool.\nInput: {"problem": "58 x 73"}\nOutput: {"result": 4234}', tools), 'reason');
  assert.equal(narratedToolCall('Calling skill.replay_window now. Tool output: {"dup": false}', tools), 'skill.replay_window');
});

test('leaves ordinary answers alone', () => {
  assert.equal(narratedToolCall('The answer is 4945. I worked it out step by step.', tools), null);
  assert.equal(narratedToolCall('There is no reason to wait for a tool response from the vendor.', tools), null);
  assert.equal(narratedToolCall('I can publish that on the bus if you want.', tools), null);
  assert.equal(narratedToolCall('', tools), null);
  assert.equal(narratedToolCall(null, tools), null);
});

test('tool names are matched literally, not as patterns', () => {
  assert.equal(narratedToolCall('I called the `skillXreplay_window` tool. Tool response: {}', tools), null);
});

test('the nudge names the tool and says the output was invented', () => {
  const m = nudgeMessage('reason');
  assert.match(m, /reason/);
  assert.match(m, /invented/);
});

test('catches a fabricated response from a tool the agent was never given', () => {
  const reply = ['**Tool Call:**', '* Problem: "58 x 73"', '', '**Tool Response:**', '', 'The `reason` tool returns the following JSON:', '', '```', '{', '  "result": { "answer": 4211 }', '}', '```'].join('\n');
  assert.equal(narratedToolCall(reply, []), 'reason');
  assert.equal(narratedToolCall('Tool output: {"ok": true}', []), 'unknown_tool');
  assert.equal(narratedToolCall('The reason tool gave a response: it is 4945.', []), null);
});

test('a call written as text is caught, and the nudge says when the tool does not exist', () => {
  const reply = 'I will provide a function call.\n\n{"name": "weather_lookup", "parameters": {"location": "Oslo"}}';
  assert.equal(narratedToolCall(reply, tools), 'weather_lookup');
  assert.match(nudgeMessage('weather_lookup', tools), /no shared tool has that name/);
  assert.match(nudgeMessage('weather_lookup', tools), /reason, skill\.replay_window, bus_publish/);
  assert.match(nudgeMessage('weather_lookup', tools), /tools\.search/);
  assert.match(nudgeMessage('reason', tools), /Make the real reason tool call/);
  // a shared tool that is only not attached to this step: say how to attach it, not that it does not exist
  const shared = [...tools, { name: 'weather_lookup' }];
  assert.match(nudgeMessage('weather_lookup', tools, shared), /shared tool that is not attached/);
  assert.match(nudgeMessage('weather_lookup', tools, shared), /tools\.load with \{"names": \["weather_lookup"\]\}/);
  assert.equal(narratedToolCall('The config is {"name": "prod", "region": "eu"} as before.', tools), null);
});

test('a text-form call for a tool the agent holds is recovered as a real call', () => {
  const body = JSON.stringify({ test: 'x \\ "quoted" }' });
  const reply = ['Here is the JSON for a function call:', '', JSON.stringify({ name: 'reason', parameters: { problem: 'compute {2+2}', body } }), '', 'Done.'].join('\n');
  const call = recoverTextToolCall(reply, tools);
  assert.equal(call.function.name, 'reason');
  assert.equal(call.function.arguments.problem, 'compute {2+2}');
  assert.equal(call.function.arguments.body, body);
  assert.equal(recoverTextToolCall(JSON.stringify({ name: 'reason', arguments: JSON.stringify({ problem: 'p' }) }), tools).function.arguments.problem, 'p');
  assert.equal(recoverTextToolCall(JSON.stringify({ name: 'weather_lookup', parameters: {} }), tools), null, 'unknown tool is not executed');
  assert.equal(recoverTextToolCall('{"name": "reason", "parameters": {"problem": ', tools), null, 'truncated JSON');
  assert.equal(recoverTextToolCall('{"name": "reason", "parameters": [1]}', tools), null, 'arguments must be an object');
  assert.equal(recoverTextToolCall('no call here', tools), null);
});
