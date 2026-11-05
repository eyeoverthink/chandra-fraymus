// Isolated UI integration check: in-memory SQLite + actual routes + bundled panel.
// Never starts the application, background engines, or a live-data writer.
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { build } from '../client/node_modules/esbuild/lib/main.js';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { nexusFixture } from '../test/helpers/content-nexus-fixture.js';
import { installContentNexusRoutes } from '../server/intelligence/content-nexus-routes.js';

const checks = [], modelRequests = [], browserErrors = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const { db, nexus } = nexusFixture({ seed: true, chat: async messages => {
  const request = JSON.parse(messages[1].content);
  modelRequests.push(request);
  return JSON.stringify([{ id: request.items[0].id, action: 'creation', reason: 'Use the evolving agent discussion to choose the next experiment.' }]);
} });
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Panel from './src/panels/ContentNexusPanel.jsx'; createRoot(document.getElementById('root')).render(<Panel onOpenPanel={(panel) => { window.openedPanel = panel; }} />);`, loader: 'jsx', resolveDir: resolve('client') },
  bundle: true, write: false, format: 'esm', define: { 'process.env.NODE_ENV': '"production"' },
});
const app = express();
app.use(express.json());
let failFeed = false;
app.get('/api/nexus/feed', (_req, res, next) => failFeed ? res.status(503).json({ error: 'Fixture feed unavailable' }) : next());
installContentNexusRoutes(app, { nexus });
app.get('/preview.js', (_req, res) => res.type('application/javascript').send(bundle.outputFiles[0].text));
app.get('/', (_req, res) => res.type('html').send('<!doctype html><html><head><title>Content Nexus isolated check</title></head><body style="margin:0;background:#0a0a0f"><div id="root"></div><script type="module" src="/preview.js"></script></body></html>'));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 850, height: 1000, deviceScaleFactor: 1 });
  page.on('pageerror', error => browserErrors.push(error.message));
  const clickText = async text => {
    const button = await page.evaluateHandle(text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text), text);
    assert.ok(button.asElement(), `Button exists: ${text}`);
    await button.asElement().click();
    await button.dispose();
  };
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('How should Fraynix evaluate local models?'));
  check('opening the panel auto-syncs eight real-schema fixture items', nexus.getStats().total === 8);
  await clickText('Agent insights');
  await page.waitForFunction(() => ['debate', 'reflection', 'memory'].every(kind => new RegExp(`Agent-generated\\s*·\\s*${kind}`).test(document.body.innerText)));
  check('agent filter shows all three provenance kinds', true);
  await page.screenshot({ path: 'docs/reviews/2026-11-05-content-nexus-feed.png', fullPage: true });
  await clickText('sources');
  check('all six sources have setup actions', await page.evaluate(() => ['Open agent discussions', 'Find and save videos', 'Ask an agent to research', 'Open Trend Radar', 'Set up browsing capture', 'Open content calendar'].every(text => document.body.innerText.includes(text))));
  await clickText('Open agent discussions');
  check('source navigation reaches the provided drawer callback', await page.evaluate(() => window.openedPanel === 'debate'));
  await clickText('recommendations');
  await page.waitForFunction(() => document.body.innerText.includes('Use the evolving agent discussion'));
  await page.type('input[aria-label="Optional focus"]', 'AI, local models, Fraynix development');
  await clickText('Refresh');
  await page.waitForFunction(() => document.body.innerText.includes('Use the evolving agent discussion'));
  check('optional focus and current agent records reach recommendation generation', modelRequests.at(-1).focus === 'AI, local models, Fraynix development' && modelRequests.at(-1).agentContext.length === 3);
  failFeed = true;
  await clickText('Sync saved content');
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('Fixture feed unavailable'));
  check('HTTP failures are visible instead of rendering a false empty feed', true);
  failFeed = false;
  db.exec('DELETE FROM nexus_items; DELETE FROM outlier_board; DELETE FROM agent_web_sources; DELETE FROM trend_signals; DELETE FROM cross_tab_visits; DELETE FROM content_calendar; DELETE FROM debates; DELETE FROM reflections; DELETE FROM agent_memories;');
  await clickText('feed');
  await clickText('All');
  await clickText('Sync saved content');
  await page.waitForFunction(() => document.body.innerText.includes('Your feed is waiting for source content'));
  check('genuinely empty sources show a setup path', await page.evaluate(() => document.body.innerText.includes('Check sources and get started')));
  await page.screenshot({ path: 'docs/reviews/2026-11-05-content-nexus-empty.png', fullPage: true });
  await page.setViewport({ width: 450, height: 900, deviceScaleFactor: 1 });
  check('panel fits a narrow drawer without horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check('panel rendered without uncaught browser errors', browserErrors.length === 0);
  writeFileSync('docs/reviews/2026-11-05-content-nexus-ui-evidence.json', JSON.stringify({ generatedAt: new Date().toISOString(), safety: 'in-memory database, fixture model, ephemeral local HTTP only', checks, browserErrors }, null, 2) + '\n');
  console.log(JSON.stringify({ checks: checks.length, browserErrors, status: 'passed' }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  db.close();
}
