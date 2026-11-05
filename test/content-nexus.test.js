import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import { createContentNexus } from '../server/intelligence/content-nexus.js';
import { installContentNexusRoutes } from '../server/intelligence/content-nexus-routes.js';
import { nexusFixture } from './helpers/content-nexus-fixture.js';

function fixture(t, opts = {}) {
  const f = nexusFixture(opts);
  t.after(() => f.db.close());
  t.mock.method(console, 'error', () => {});
  return f;
}

test('source readiness distinguishes empty stores from missing source tables', t => {
  const { db, nexus } = fixture(t);
  assert.equal(nexus.getSourceStatus().find(s => s.source === 'youtube').status, 'empty');
  db.exec('DROP TABLE cross_tab_visits');
  const details = nexus.getSourceStatus();
  assert.equal(details.find(s => s.source === 'browsing').status, 'unavailable');
  const result = nexus.ingestAll();
  assert.equal(result.total, 0);
  assert.equal(result.status, 'partial_failure');
  assert.equal(result.results.find(s => s.source === 'browsing').status, 'unavailable');
});

test('all six source contracts import real-schema fixtures and repeat sync is idempotent', t => {
  const events = [];
  const { nexus } = fixture(t, { seed: true, broadcast: (...args) => events.push(args) });
  const first = nexus.ingestAll();
  assert.equal(first.total, 8);
  assert.equal(first.counts.agents, 3);
  assert.deepEqual(Object.keys(first.counts), nexus.SOURCES);
  assert.equal(nexus.getStats().total, 8);
  assert.equal(nexus.ingestAll().total, 0);
  assert.equal(events.length, 1);
  assert.equal(nexus.getFeed({ source: 'web' })[0].description, 'Retained research text');
});

test('source updates refresh content without resetting handled state', t => {
  const { db, nexus } = fixture(t, { seed: true });
  nexus.ingestAll();
  const item = nexus.getFeed({ source: 'youtube' })[0];
  nexus.actOnItem(item.id, 'creation', 'existing-run');
  db.prepare('UPDATE outlier_board SET title = ? WHERE video_id = ?').run('Updated local AI hardware', 'video-1');
  assert.equal(nexus.ingestFromYouTube(), 1);
  const refreshed = nexus.getFeed({ source: 'youtube' })[0];
  assert.equal(refreshed.title, 'Updated local AI hardware');
  assert.equal(refreshed.acted_on, 1);
  assert.equal(refreshed.action_run_id, 'existing-run');
  assert.equal(nexus.ingestFromYouTube(), 0);
});

test('classified browsing uses numeric scores, skips unclassified visits, and preserves zero scores', t => {
  const { db, nexus } = fixture(t, { seed: true });
  db.prepare('INSERT INTO cross_tab_visits(id,url,domain,title,visited_at,created_at) VALUES(?,?,?,?,?,?)').run('raw','https://example.test/raw','example.test','Unclassified',1,1);
  nexus.ingestAll();
  const browsing = nexus.getFeed({ source: 'browsing' });
  assert.equal(browsing.length, 1);
  assert.equal(browsing[0].relevance_score, 0.9);
  assert.equal(nexus.getFeed({ source: 'trends' })[0].relevance_score, 0);
  assert.equal(nexus.getFeed({ minScore: 0 }).length, 8);
});

test('malformed web rows are reported as skipped while good records still sync', t => {
  const { db, nexus } = fixture(t, { seed: true });
  db.prepare('INSERT INTO agent_web_sources(id,run_id,record_json,snapshot_hash,stored_bytes,created_at) VALUES(?,?,?,?,?,?)').run('bad','run-1','{bad','fixture',4,Date.now());
  const result = nexus.ingestSource('web');
  assert.equal(result.ingested, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.status, 'partial_failure');
});

test('agent source excludes running discussions and unreviewed memory, and picks up new reflections', t => {
  const { db, nexus } = fixture(t, { seed: true });
  db.prepare('INSERT INTO agent_memories(agent_id,key,value,created_at,updated_at) VALUES(?,?,?,?,?)').run('researcher','Unreviewed','Not a reviewed memory',1,1);
  db.prepare("UPDATE debates SET status = 'running'").run();
  assert.equal(nexus.ingestFromAgents(), 2);
  const items = nexus.getFeed({ source: 'agents' });
  assert.ok(items.every(i => i.metadata.provenance === 'agent_generated' && i.metadata.recordId));
  assert.ok(!items.some(i => i.metadata.kind === 'debate'));
  db.prepare('INSERT INTO reflections(trigger,input_summary,actions_taken,insights,duration_ms,created_at) VALUES(?,?,?,?,?,?)').run('test','New context','[]','A new discussion changes the research direction.',1,Date.now()+1000);
  assert.equal(nexus.ingestFromAgents(), 1);
  assert.ok(nexus.getFeed({ source: 'agents' }).some(i => i.description.includes('changes the research direction')));
});

test('recommendations receive evolving agent context, optional guidance, and real item IDs', async t => {
  let request;
  const { nexus } = fixture(t, { seed: true, chat: async messages => {
    request = JSON.parse(messages[1].content);
    const item = request.items[0];
    return JSON.stringify([
      {id:999999,action:'creation',reason:'invented'},
      {id:item.id,title:'invented title',action:'creation',reason:'Based on the recent discussion'},
      {id:item.id,action:'creation',reason:'duplicate'},
    ]);
  } });
  nexus.ingestAll();
  const result = await nexus.generateRecommendations(5, { focus: 'AI, local models, Fraynix development' });
  assert.equal(request.focus, 'AI, local models, Fraynix development');
  assert.ok(request.agentContext.some(i => i.provenance.kind === 'debate'));
  assert.ok(request.items.every(i => Number.isInteger(i.id)));
  assert.equal(result.recommendations.length, 1);
  assert.notEqual(result.recommendations[0].title, 'invented title');
  assert.equal(result.recommendations[0].id, request.items[0].id);
});

test('new agent thinking remains eligible ahead of old high-confidence memories', async t => {
  let request;
  const { db, nexus } = fixture(t, { seed: true, chat: async messages => {
    request = JSON.parse(messages[1].content);
    return JSON.stringify([{ id: request.items[0].id, action: 'creation', reason: 'Follow the current discussion' }]);
  } });
  nexus.ingestAll();
  db.prepare('INSERT INTO reflections(trigger,input_summary,actions_taken,insights,duration_ms,created_at) VALUES(?,?,?,?,?,?)').run('test','New goal','[]','The agents have a new research direction.',1,Date.now()+2000);
  nexus.ingestFromAgents();
  const newest = nexus.getFeed({ source: 'agents' })[0];
  assert.ok(newest.description.includes('new research direction'));
  await nexus.generateRecommendations();
  assert.equal(request.items[0].id, newest.id);
});

test('empty sources and model failures are distinct and unsafe URLs are not rendered', async t => {
  const { db, nexus } = fixture(t, { chat: async () => { throw new Error('provider fixture'); } });
  const empty = await nexus.generateRecommendations();
  assert.equal(empty.recommendations.length, 0);
  assert.equal(empty.error, undefined);
  db.prepare('INSERT INTO nexus_items(source,item_type,external_id,title,url,thumbnail) VALUES(?,?,?,?,?,?)').run('web','article','unsafe','Untrusted record','javascript:alert(1)','data:text/html,unsafe');
  assert.equal(nexus.getFeed()[0].url, '');
  assert.equal(nexus.getFeed()[0].thumbnail, '');
  assert.ok((await nexus.generateRecommendations()).error);
});

test('partial agent initialization keeps available intelligence channels readable', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE reflections(id INTEGER, insights TEXT, trigger TEXT, created_at INTEGER)');
  db.prepare('INSERT INTO reflections VALUES(?,?,?,?)').run(1,'Useful dynamic thought','test',Date.now());
  const nexus = createContentNexus({ db });
  assert.equal(nexus.ingestSource('agents').ingested, 1);
  const agents = nexus.getSourceStatus().find(s => s.source === 'agents');
  assert.equal(agents.saved, 1);
  assert.equal(agents.available, true);
  assert.equal(agents.channels.filter(c => !c.available).length, 2);
});

test('HTTP routes expose source diagnostics and reject invalid filters and actions', async t => {
  const { db, nexus } = fixture(t, { seed: true });
  const app = express();
  app.use(express.json());
  installContentNexusRoutes(app, { nexus });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, opts) => fetch(`http://127.0.0.1:${server.address().port}/api/nexus/${path}`, opts);
  assert.equal((await (await request('sources')).json()).details.length, 6);
  assert.equal((await request('feed?source=bogus')).status, 400);
  assert.equal((await request('feed?minScore=NaN')).status, 400);
  assert.equal((await request('ingest/bogus', {method:'POST'})).status, 400);
  const sync = await (await request('ingest', {method:'POST'})).json();
  assert.equal(sync.total, 8);
  assert.equal((await (await request('feed?source=agents')).json()).items.length, 3);
  db.exec('DROP TABLE cross_tab_visits');
  assert.equal((await request('ingest/browsing', {method:'POST'})).status, 503);
  const action = actionType => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actionType})});
  assert.equal((await request('act/1junk',action('creation'))).status, 400);
  assert.equal((await request('act/1',action('publish_everything'))).status, 400);
  assert.equal((await request('act/999999',action('creation'))).status, 404);
});
