import test from 'node:test';
import assert from 'node:assert/strict';
import { studioConfig, createVideoStudioTools } from '../server/media/video-studio-bridge.js';
import { needsApproval } from '../server/fleet/tool-select.js';

test('the studio is reached over SSH or a private address, never a public one', () => {
  const ssh = studioConfig('ssh://eyeov@100.99.98.101:8790');
  assert.equal(ssh.via, 'ssh'); assert.equal(ssh.remotePort, 8790); assert.match(ssh.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(studioConfig('http://100.99.98.101:8790').via, 'direct');
  assert.match(studioConfig('https://fraymus-video-studio.fly.dev').refused, /private or local/);
  assert.match(studioConfig('ftp://10.0.0.5:8790').refused, /private or local/);
  assert.equal(studioConfig(''), null);
});

test('reading the studio is free; rendering and teaching it wait for a person', () => {
  const tools = Object.fromEntries(createVideoStudioTools().map(t => [t.name, t]));
  for (const name of ['videostudio.recipes', 'videostudio.job_status', 'videostudio.fetch_file', 'videostudio.brain_search', 'videostudio.brain_consult'])
    assert.equal(needsApproval(tools[name], {}), false, name);
  for (const name of ['videostudio.render', 'videostudio.brain_remember']) assert.equal(needsApproval(tools[name], {}), true, name);
});

test('job ids and file names are checked before anything is sent', async () => {
  const tools = Object.fromEntries(createVideoStudioTools().map(t => [t.name, t]));
  await assert.rejects(tools['videostudio.job_status'].execute({ args: { id: '../../etc' } }), /not a studio job id/);
  await assert.rejects(tools['videostudio.fetch_file'].execute({ args: { id: 'abcdef012345', name: '../secret.env' } }), /bad job id or file name/);
});
