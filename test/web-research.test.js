import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createWebResearch } from '../server/web/research.js';
import { extractPage } from '../server/web/extract.js';
import { extractWebPage } from '../server/web/parser.js';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, html = '<title>Source title</title><main><h1>Reference</h1><p>literal a.*b needle φ</p><a href="/child">Child reference</a></main>') {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const calls = [];
  const research = createWebResearch({ db, requestPage: async url => {
    calls.push(url);
    return { url, status: 200, contentType: 'text/html;charset=utf-8', bytes: Buffer.byteLength(html), fetchedAt: 123456789, rawSha256: hash(html), text: html };
  }, parsePage: async input => extractPage(input) });
  const tools = Object.fromEntries(research.tools().map(tool => [tool.name, tool]));
  const run = { id: 'research-run', budget: { maxToolResultChars: 12000 } };
  const call = (name, args, currentRun = run) => tools[name].execute({ args, run: currentRun, signal: new AbortController().signal });
  return { db, research, tools, run, call, calls };
}

test('web snapshots retain source facts and line search/read need no further network requests', async t => {
  const f = fixture(t), first = await f.call('web.fetch', { url: 'https://example.com/start' });
  assert.equal(first.title, 'Source title'); assert.equal(first.fetchedAt, 123456789); assert.equal(first.untrusted, true);
  assert.equal(first.rawSha256.length, 64); assert.equal(first.snapshotSha256.length, 64);
  const found = await f.call('web.find', { sourceId: first.sourceId, query: 'A.*B' });
  assert.equal(found.matches.length, 1); assert.match(found.matches[0].excerpt, /literal a\.\*b/);
  const read = await f.call('web.read', { sourceId: first.sourceId, startLine: found.matches[0].line, maxLines: 1 });
  assert.match(read.lines[0].text, /needle φ/); assert.equal(read.snapshotSha256, first.snapshotSha256);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.call('web.read', { sourceId: first.sourceId }, { id: 'different-run' }), /not found/);
  await assert.rejects(f.call('web.read', { sourceId: first.sourceId, startLine: 999 }), /outside/);
});

test('web follow preview resolves a retained link and preserves the exact parent snapshot', async t => {
  const f = fixture(t), source = await f.call('web.fetch', { url: 'https://example.com/start' });
  const listed = await f.call('web.links', { sourceId: source.sourceId });
  assert.equal(listed.links[0].url, 'https://example.com/child');
  const preview = await f.tools['web.follow'].prepare({ args: { sourceId: source.sourceId, linkId: 1 }, run: f.run });
  assert.equal(preview.url, 'https://example.com/child'); assert.equal(preview.parentSnapshotSha256, source.snapshotSha256);
  assert.equal(preview.sendsCookies, false); assert.equal(f.calls.length, 1);
  const followed = await f.call('web.follow', { sourceId: source.sourceId, linkId: 1 });
  assert.equal(followed.url, preview.url); assert.notEqual(followed.sourceId, source.sourceId); assert.equal(f.calls.length, 2);
  assert.equal(f.tools['web.fetch'].approvalRequired, true); assert.equal(f.tools['web.follow'].approvalRequired, true);
});

test('web redirect snapshots require a distinct approved follow and do not invent a page body', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let requests = 0;
  const research = createWebResearch({ db, requestPage: async url => { requests++; return { url, status: 302, bytes: 0, fetchedAt: 1, redirect: 'https://example.com/destination' }; } });
  const tools = Object.fromEntries(research.tools().map(tool => [tool.name, tool])), run = { id: 'redirect-run' };
  const first = await tools['web.fetch'].execute({ args: { url: 'https://example.com/' }, run });
  assert.equal(requests, 1); assert.equal(first.totalChars, 0); assert.match(first.warnings[0], /not followed/);
  const preview = await tools['web.follow'].prepare({ args: { sourceId: first.sourceId, linkId: 1 }, run });
  assert.equal(preview.url, 'https://example.com/destination'); assert.equal(requests, 1);
});

test('web reads continue long lines using exact cursors and link/find results paginate', async t => {
  const f = fixture(t, '<p>' + 'x'.repeat(14000) + 'TARGET</p>' + Array.from({ length: 30 }, (_, index) => `<a href="/${index}">item ${index}</a>`).join(''));
  const source = await f.call('web.fetch', { url: 'https://example.com/' });
  const expected = f.research.get(source.sourceId, f.run).lines[0];
  let cursor = { startLine: 1, charOffset: 0 }, text = '';
  while (cursor && cursor.startLine === 1) {
    const chunk = await f.call('web.read', { sourceId: source.sourceId, ...cursor, maxLines: 1, maxChars: 3000 });
    text += chunk.lines[0].text; cursor = chunk.next;
  }
  assert.equal(text, expected); assert.match(text, /TARGET/);
  const links = await f.call('web.links', { sourceId: source.sourceId, maxLinks: 3 });
  assert.equal(links.links.length, 3); assert.equal(links.nextOffset, 3);
  const more = await f.call('web.links', { sourceId: source.sourceId, offset: links.nextOffset, maxLinks: 3 });
  assert.equal(more.links[0].id, 4);
  const matches = await f.call('web.find', { sourceId: source.sourceId, query: 'item', maxResults: 2 });
  assert.equal(matches.matches.length, 2); assert.equal(matches.hasMore, true);
});

test('web source integrity and per-run quotas reject changes without discarding stored evidence', async t => {
  const f = fixture(t), source = await f.call('web.fetch', { url: 'https://example.com/' });
  f.db.prepare('UPDATE agent_web_sources SET record_json=? WHERE id=?').run('{}', source.sourceId);
  await assert.rejects(f.call('web.read', { sourceId: source.sourceId }), /integrity/);
  for (let index = 1; index < 16; index++) await f.call('web.fetch', { url: `https://example.com/${index}` });
  await assert.rejects(f.call('web.fetch', { url: 'https://example.com/limit' }), /16 web source/);
  assert.equal(f.calls.length, 16); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_web_sources').get().n, 16);
});

test('web parser runs off-loop and cancellation closes workers without consuming future slots', async () => {
  const page = await extractWebPage({ url: 'https://example.com/', contentType: 'text/html', text: '<h1>Worker φ</h1><p>reference</p>' });
  assert.equal(page.title, 'Worker φ'); assert.match(page.text, /reference/);
  const controller = new AbortController();
  const parsing = extractWebPage({ url: 'https://example.com/', contentType: 'text/html', text: '<p>x</p>'.repeat(10000) }, controller.signal);
  controller.abort(new Error('cancelled parser'));
  await assert.rejects(parsing, /cancelled parser/);
  assert.equal((await extractWebPage({ url: 'https://example.com/', contentType: 'text/plain', text: '' })).text, '');
});

test('web read preserves progress and cursor facts when JSON escaping consumes its result budget', async t => {
  const expected = ('\\"\t'.repeat(3000)) + 'tail';
  const f = fixture(t, '<pre>' + expected.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>');
  const source = await f.call('web.fetch', { url: 'https://example.com/' });
  const run = { ...f.run, budget: { maxToolResultChars: 1500 } };
  let cursor = { startLine: 1, charOffset: 0 }, text = '', chunks = 0;
  while (cursor) {
    const result = await f.call('web.read', { sourceId: source.sourceId, ...cursor, maxChars: 8000 }, run);
    assert.ok(JSON.stringify(result).length <= 1500); assert.ok(result.lines.some(line => line.text.length));
    text += result.lines.map(line => line.text).join('\n'); cursor = result.next; chunks++;
    assert.ok(chunks < 100);
  }
  assert.equal(text, expected); assert.ok(chunks > 1);
  await assert.rejects(f.call('web.links', { sourceId: source.sourceId }, { ...run, budget: { maxToolResultChars: 256 } }));
});
