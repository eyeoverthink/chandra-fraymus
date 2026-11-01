import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const baseUrl = process.env.CHANDRA_BASE_URL || 'http://127.0.0.1:8787';
const evidenceDir = join(projectRoot, 'docs', 'evidence', 'latest');
const screenshotDir = join(projectRoot, 'docs', 'screenshots', 'e2e-latest');

await mkdir(evidenceDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

async function requestJson(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { url, ok: response.ok, status: response.status, body, text };
}

const checks = [];

const health = await requestJson('/api/health');
checks.push({ name: 'health', required: true, pass: health.ok && health.body?.ok === true, status: health.status });

const fraymus = await requestJson('/api/fraymus/health');
checks.push({ name: 'fraymus_health', required: true, pass: fraymus.ok && fraymus.body?.ok === true, status: fraymus.status });

const voice = await requestJson('/api/voice/health');
checks.push({ name: 'voice_health', required: true, pass: voice.ok && voice.body?.ready === true, status: voice.status });

const partner = await fetch(`${baseUrl}/partner/`, { method: 'GET' });
checks.push({ name: 'partner_route', required: true, pass: partner.ok, status: partner.status });

const fleet = await requestJson('/api/fleet/agents');
const agentIds = Array.isArray(fleet.body?.agents) ? fleet.body.agents.map(a => a.id).filter(Boolean) : [];
checks.push({ name: 'fleet_agents', required: true, pass: fleet.ok && agentIds.length >= 2, status: fleet.status, count: agentIds.length });

let collabCreate = null;
if (agentIds.length >= 2) {
  collabCreate = await requestJson('/api/collab/create', {
    method: 'POST',
    body: JSON.stringify({
      goal: 'Automated E2E smoke check',
      strategy: 'chain',
      agents: [agentIds[0], agentIds[1]],
      initiator: 'e2e-smoke-script',
    }),
  });
  checks.push({
    name: 'collab_create',
    required: true,
    pass: collabCreate.ok && !!collabCreate.body?.id,
    status: collabCreate.status,
    id: collabCreate.body?.id || null,
  });
}

const screenshotResults = [];
let browser = null;
try {
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  const shots = [
    { name: 'root', url: `${baseUrl}/` },
    { name: 'partner', url: `${baseUrl}/partner/` },
  ];

  for (const shot of shots) {
    await page.goto(shot.url, { waitUntil: 'networkidle2', timeout: 30000 });
    const file = `${shot.name}.png`;
    const filePath = join(screenshotDir, file);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshotResults.push({ ...shot, file: `docs/screenshots/e2e-latest/${file}`, pass: existsSync(filePath) });
  }
} catch (error) {
  screenshotResults.push({ name: 'screenshot_error', pass: false, error: String(error.message || error) });
} finally {
  if (browser) await browser.close();
}

const requiredFailures = checks.filter(c => c.required && !c.pass);
const passed = requiredFailures.length === 0;

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  passed,
  checks,
  screenshotResults,
  snapshots: {
    health: health.body,
    fraymus: fraymus.body,
    voice: voice.body,
    fleetCount: agentIds.length,
    collabCreate: collabCreate?.body || null,
  },
};

const reportPath = join(evidenceDir, 'e2e-smoke-report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const summaryLines = [
  '# E2E Smoke Report',
  '',
  `- Generated: ${report.generatedAt}`,
  `- Base URL: ${baseUrl}`,
  `- Passed: ${passed ? 'YES' : 'NO'}`,
  '',
  '## Checks',
  ...checks.map(c => `- ${c.pass ? 'PASS' : 'FAIL'} - ${c.name} (status: ${c.status}${c.count != null ? `, count: ${c.count}` : ''}${c.id ? `, id: ${c.id}` : ''})`),
  '',
  '## Screenshots',
  ...screenshotResults.map(s => `- ${s.pass ? 'PASS' : 'FAIL'} - ${s.name}${s.file ? ` -> ${s.file}` : ''}${s.error ? ` (${s.error})` : ''}`),
  '',
  '## Artifacts',
  '- docs/evidence/latest/e2e-smoke-report.json',
  '- docs/screenshots/e2e-latest/root.png',
  '- docs/screenshots/e2e-latest/partner.png',
  '',
];

await writeFile(join(evidenceDir, 'e2e-smoke-report.md'), `${summaryLines.join('\n')}\n`, 'utf8');

console.log(summaryLines.join('\n'));
if (!passed) process.exit(1);

