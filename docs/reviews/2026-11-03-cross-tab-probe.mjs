import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// A controlled review probe, not a live-model or live-browser test.
const temporaryParent = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(temporaryParent, 'chandra-cross-tab-review-'));
const previousDataDir = process.env.CHANDRA_DATA_DIR;
const originalFetch = globalThis.fetch;
process.env.CHANDRA_DATA_DIR = path.join(directory, 'data');
let db;

try {
  ({ db } = await import('../../server/db.js'));
  const ct = await import('../../server/intelligence/cross-tab.js');
  const observations = [];
  const outgoing = [];
  globalThis.fetch = async (_url, options) => {
    outgoing.push(JSON.parse(options.body));
    return Response.json({ error: 'Contract probe: messages must be an array' }, { status: 400 });
  };

  const first = await ct.recordAndClassify({
    url: 'https://review.example/first', title: 'Test recovery', content: 'Example content',
  });
  const callsAfterFirst = outgoing.length;
  const retry = await ct.recordAndClassify({
    url: 'https://review.example/first', title: 'Test recovery', content: 'Example content',
  });
  observations.push({
    id: 'CT-01-classification-contract', requestMessagesType: typeof outgoing[0]?.messages,
    isArray: Array.isArray(outgoing[0]?.messages), classified: first.classified, classifyError: first.classifyError,
  });
  observations.push({
    id: 'CT-02-retry', deduplicated: retry.deduplicated, classified: retry.classified,
    newModelCalls: outgoing.length - callsAfterFirst, unclassified: ct.getVisitStats().unclassified,
  });

  const extra = ct.recordVisit({ url: 'https://review.example/a', title: 'A' });
  ct.recordVisit({ url: 'https://review.example/b', title: 'B' });
  db.prepare("UPDATE cross_tab_visits SET classified_at = ?, category = 'tech', topics = '[\"review\"]'")
    .run(Date.now());
  try {
    await ct.generateInsights();
  } catch (e) {
    const last = outgoing.at(-1);
    observations.push({
      id: 'CT-01-insights-contract', requestMessagesType: typeof last?.messages,
      isArray: Array.isArray(last?.messages), error: e.message,
    });
  }

  globalThis.fetch = async () => Response.json({ message: { content: JSON.stringify({
    category: 'tech', topics: 'not-an-array', entities: [], summary: 'Example', actionability: 0.4,
  }) } });
  await ct.classifyVisit(extra.id, { content: 'Example' });
  const row = ct.getVisits().find(visit => visit.id === extra.id);
  let consumerError = null;
  try { JSON.parse(row.topics).map(topic => topic); } catch (e) { consumerError = e.message; }
  observations.push({
    id: 'CT-03-model-shape', storedTopicsType: typeof JSON.parse(row.topics), consumerError,
  });

  try {
    ct.getVisits({ limit: Number.NaN, offset: Number.NaN });
    observations.push({ id: 'CT-04-pagination', threw: false });
  } catch (e) {
    observations.push({ id: 'CT-04-pagination', threw: true, error: e.message });
  }

  const sourcePath = fileURLToPath(new URL('../../server/intelligence/cross-tab.js', import.meta.url));
  const sourceSha256 = createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex');
  console.log(JSON.stringify({
    sourceSha256,
    method: 'Production functions; temporary SQLite; intercepted HTTP; no real model or browsing',
    observations,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  db?.close();
  if (previousDataDir === undefined) delete process.env.CHANDRA_DATA_DIR;
  else process.env.CHANDRA_DATA_DIR = previousDataDir;
  const target = await fs.realpath(directory);
  assert.equal(target, directory);
  assert.equal(path.dirname(target), temporaryParent);
  assert.ok(path.basename(target).startsWith('chandra-cross-tab-review-'));
  await fs.rm(target, { recursive: true, force: true });
}
