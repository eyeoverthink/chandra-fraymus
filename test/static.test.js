import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { once } from 'node:events';
import { installStatic } from '../server/static.js';

const html = '<!doctype html><title>My AI Partner</title><script type="module" src="/partner/assets/chat.js"></script><link rel="stylesheet" href="/partner/assets/chat.css"><div id="root"></div>';

async function fixture(t, { production = true, built = true } = {}) {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'fraymus-static-'));
  const original = await realpath(root), partnerDist = join(root, 'partner'), distDir = join(root, 'old-client');
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<h1>Removed legacy dashboard</h1>');
  await writeFile(join(distDir, 'assets', 'legacy.js'), 'throw new Error("Legacy bundle must not be served");');
  if (built) {
    await mkdir(join(partnerDist, 'assets'), { recursive: true });
    await writeFile(join(partnerDist, 'index.html'), html);
    await writeFile(join(partnerDist, 'assets', 'chat.js'), 'export const app = "canonical companion";');
    await writeFile(join(partnerDist, 'assets', 'chat.css'), 'body{margin:0}');
  }
  const app = express();
  installStatic(app, { production, partnerDist, distDir });
  app.get('/api/health', (_req, res) => res.json({ fixture: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    const target = await realpath(root);
    assert.equal(target, original);
    assert.equal(dirname(target), base);
    assert.ok(basename(target).startsWith('fraymus-static-'));
    await rm(target, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

test('production root serves the canonical full-screen companion with its existing asset base', async t => {
  const { origin } = await fixture(t);
  const root = await fetch(origin);
  assert.equal(root.status, 200);
  assert.equal(root.redirected, false);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.equal(root.headers.get('cache-control'), 'no-cache');
  assert.equal(await root.text(), html);
  assert.equal(await (await fetch(origin + '/partner/')).text(), html);
  assert.equal(await (await fetch(origin + '/index.html')).text(), html);
  const asset = await fetch(origin + '/partner/assets/chat.js');
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'export const app = "canonical companion";');
  assert.equal(await (await fetch(origin + '/partner/assets/chat.css')).text(), 'body{margin:0}');
  const head = await fetch(origin, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('partner compatibility redirects once while preserving query and serves its index directly', async t => {
  const { origin } = await fixture(t);
  const redirect = await fetch(origin + '/partner?source=saved-link', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/partner/?source=saved-link');
  const page = await fetch(origin + '/partner/?source=saved-link', { redirect: 'manual' });
  assert.equal(page.status, 200);
  assert.equal(page.redirected, false);
  assert.equal(await page.text(), html);
  assert.equal(await (await fetch(origin + '/partner/index.html')).text(), html);
});

test('removed pages and old client bundles are unreachable without swallowing API or asset failures', async t => {
  const { origin } = await fixture(t);
  for (const path of ['/lab', '/transport', '/mesh', '/simulations', '/v3', '/assets/legacy.js', '/partner/mesh', '/partner/assets/missing.js']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404, path);
    assert.notEqual(await response.text(), html, path);
  }
  const health = await fetch(origin + '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { fixture: true });
  assert.equal((await fetch(origin + '/api/missing')).status, 404);
});

test('missing companion build fails clearly and never serves an old dashboard or fake application', async t => {
  const { origin } = await fixture(t, { built: false });
  for (const path of ['/', '/index.html', '/partner/', '/partner/index.html']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 503, path);
    const error = await response.json();
    assert.equal(error.error, 'partner_build_unavailable');
    assert.match(error.message, /MyAIPartner/);
    assert.doesNotMatch(error.message, /fraymus-static-|Removed legacy/);
  }
  assert.equal((await fetch(origin + '/assets/legacy.js')).status, 404);
});

test('development keeps the companion and assets available for the Vite handoff', async t => {
  const { origin } = await fixture(t, { production: false });
  assert.equal((await fetch(origin)).status, 404);
  assert.equal(await (await fetch(origin + '/partner/')).text(), html);
  assert.equal((await fetch(origin + '/partner/assets/chat.js')).status, 200);
});
