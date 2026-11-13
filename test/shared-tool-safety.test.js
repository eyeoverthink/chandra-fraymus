import test from 'node:test';
import assert from 'node:assert/strict';
import { needsApproval } from '../server/fleet/tool-select.js';
import { classifyHost } from '../server/fraymus-os/registry.js';
import { assertPublicPageUrl } from '../server/browser/service.js';

// Every agent may use every shared tool (2026-11-12), so what stops a harmful call is safety, not membership:
// approvals for effects outside Chandra, and a browser that cannot reach this machine or the LAN.

test('approval can depend on the call: shopper.audit asks only when it would change the store', () => {
  const audit = { name: 'shopper.audit', risk: 'safe', approvalWhen: args => !!args.autoApply };
  assert.equal(needsApproval(audit, { autoApply: true }), true);
  assert.equal(needsApproval(audit, { storeUrl: 'x' }), false);
  assert.equal(needsApproval(audit), true, 'arguments unknown: assume the effectful case');
  assert.equal(needsApproval({ approvalWhen: () => { throw new Error('bad'); } }, {}), true, 'a check that throws asks');
  assert.equal(needsApproval({ risk: 'approval' }, {}), true);
  assert.equal(needsApproval({ risk: 'safe' }, {}), false);
});

test('addresses that reach this machine or a private network are never public', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', '10.0.0.163', '192.168.1.1',
    '172.20.0.1', '100.99.98.101', '169.254.169.254', 'printer.local', '[::ffff:10.0.0.1]', 'fd12::1'])
    assert.notEqual(classifyHost(host), 'public', host);
  for (const host of ['93.184.215.14', 'example.com', '2606:4700::1111']) assert.equal(classifyHost(host), 'public', host);
});

test('an agent page may open only public http(s) addresses', async () => {
  for (const url of ['file:///C:/secret/.env', 'http://127.0.0.1:8787/api/fleet/approvals', 'http://localhost:5173/', 'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'javascript:alert(1)', 'ftp://example.com/', 'not a url'])
    await assert.rejects(assertPublicPageUrl(url), /public|http\(s\)|not a URL/, url);
  assert.equal(await assertPublicPageUrl('http://93.184.215.14/'), 'http://93.184.215.14/');
});
