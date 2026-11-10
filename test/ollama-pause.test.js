import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withOllama, pauseOllama, resumeOllama, ollamaPaused, waitForOllamaIdle, getSchedulerStatus } from '../server/intelligence/ollama-scheduler.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a paused scheduler admits nothing, lets running work finish, and resumes in order', async () => {
  const order = [];
  const running = withOllama('goal', async () => { await sleep(150); order.push('running-before-pause'); }, { label: 'before' });
  await sleep(20);
  pauseOllama('unit test');
  assert.equal(ollamaPaused().by, 'unit test');
  const queued = withOllama('interactive', async () => { order.push('queued-during-pause'); }, { label: 'during' });
  await sleep(60);
  assert.equal(getSchedulerStatus().queued, 1, 'the new job waits');
  assert.equal(await waitForOllamaIdle(2000), true, 'the job that was already running finishes');
  await running;
  await sleep(60);
  assert.deepEqual(order, ['running-before-pause'], 'nothing is admitted while paused');
  resumeOllama();
  await queued;
  assert.deepEqual(order, ['running-before-pause', 'queued-during-pause']);
  assert.equal(ollamaPaused(), null);
});

test('waitForOllamaIdle reports false when work outlasts the deadline', async () => {
  const long = withOllama('goal', () => sleep(300), { label: 'long' });
  await sleep(20);
  assert.equal(await waitForOllamaIdle(60), false);
  await long;
  assert.equal(await waitForOllamaIdle(500), true);
});

test('resume without a pause is harmless', () => {
  assert.deepEqual(resumeOllama(), { resumed: true, was: null });
});
