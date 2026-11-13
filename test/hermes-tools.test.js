import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// The artifact shelf reads data/ — so this test brings its own: one of every kind, known exactly. It used to list
// whatever the real data folder held, which made its checks depend on what the organism had made that week.
const DATA = mkdtempSync(join(os.tmpdir(), 'chandra-shelf-'));
const previousDataDir = process.env.CHANDRA_DATA_DIR;
process.env.CHANDRA_DATA_DIR = DATA;
const put = (rel, body) => { mkdirSync(join(DATA, rel, '..'), { recursive: true }); writeFileSync(join(DATA, rel), body); };
put('sites/demo-page/index.html', '<!doctype html><title>Demo page</title><h1>Welcome</h1>');
put('wiki/myproj/Architecture.md', '# My project architecture\n\nThree modules.');
put('har-clients/shop-api.mjs', 'export async function getItems() { return []; }\n');
put('rea/rea-1.md', '# REA report\n\nPROVEN: two claims.');
put('media/1794000000000-aa.png', 'png bytes');
put('video/1794000000100-bb.mp4', 'mp4 bytes');
for (const n of [1, 2, 3]) put(`tts/179400000020${n}-cc.mp3`, 'mp3 bytes');

const { htmlToMarkdown, parseFeed, readSpore, assertPublicUrl, underRoots, createHermesTools, HERMES_SKILLS, scanRepo } = await import('../server/hermes/free-tools.js');
const { db } = await import('../server/db.js');
db.exec(`CREATE TABLE IF NOT EXISTS fraymus_os_artifacts (id TEXT PRIMARY KEY, preset TEXT, topic TEXT, status TEXT, payload TEXT, error TEXT, created_at INTEGER)`);
db.prepare(`INSERT INTO fraymus_os_artifacts (id, preset, topic, status, payload, created_at) VALUES ('draft-1', 'blog-post', 'A drafted post', 'done', '{"text":"Body of the post."}', 1794000000300)`).run();

after(() => {
  try { db.close(); } catch (e) { console.error('close:', e.message); }
  if (previousDataDir === undefined) delete process.env.CHANDRA_DATA_DIR; else process.env.CHANDRA_DATA_DIR = previousDataDir;
  rmSync(DATA, { recursive: true, force: true });
});

test('htmlToMarkdown keeps structure and drops scripts, styles and navigation', () => {
  const { title, markdown } = htmlToMarkdown('<html><head><title>T &amp; U</title><style>p{color:red}</style></head><body><nav>menu</nav><h1>Head</h1><p>One <a href="/x">link</a>.</p><ul><li>a</li><li>b</li></ul><script>alert(1)</script></body></html>', 'https://example.com/p');
  assert.equal(title, 'T & U');
  assert.match(markdown, /^# Head/m);
  assert.match(markdown, /\[link\]\(https:\/\/example\.com\/x\)/);
  assert.match(markdown, /^- a$/m);
  assert.ok(!/alert|color:red|menu/.test(markdown));
});

test('parseFeed reads RSS and Atom', () => {
  const rss = parseFeed('<rss><channel><item><title><![CDATA[A &amp; B]]></title><link>https://a.example/1</link><guid>g1</guid><pubDate>Mon, 09 Nov 2026</pubDate><description>&lt;p&gt;hi&lt;/p&gt;</description></item></channel></rss>');
  assert.deepEqual([rss[0].title, rss[0].link, rss[0].id], ['A & B', 'https://a.example/1', 'g1']);
  const atom = parseFeed('<feed><entry><title>E</title><link rel="alternate" href="https://b.example/2"/><id>tag:2</id><updated>2026-11-10</updated><summary>s</summary></entry></feed>');
  assert.deepEqual([atom[0].title, atom[0].link, atom[0].published], ['E', 'https://b.example/2', '2026-11-10']);
  assert.deepEqual(parseFeed('<html>not a feed</html>'), []);
});

// a minimal lazarus-spore-v1 container: wasm header + custom sections
function spore(payload, { tamper = false } = {}) {
  const text = JSON.stringify(payload);
  const section = (name, body) => { const n = Buffer.from(name), b = Buffer.isBuffer(body) ? body : Buffer.from(body); const inner = Buffer.concat([Buffer.from([n.length]), n, b]); const size = []; let v = inner.length; do { let byte = v & 0x7f; v >>>= 7; if (v) byte |= 0x80; size.push(byte); } while (v); return Buffer.concat([Buffer.from([0]), Buffer.from(size), inner]); };
  return Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), section('fraymus.baseline', createHash('sha256').update(text).digest('hex')), section('fraymus.ledger', JSON.stringify({ lineage: ['INGEST'] })), section('fraymus.data', Buffer.from(tamper ? text.replace('alpha', 'omega') : text).toString('base64'))]);
}

test('readSpore verifies the payload against its baseline and detects tampering', () => {
  const payload = { protocol: 'lazarus-spore-v1', topic: 'alpha topic', forks: [{ lane: 'ALPHA', title: 't' }] };
  const ok = readSpore(spore(payload));
  assert.equal(ok.intact, true);
  assert.equal(ok.data.topic, 'alpha topic');
  assert.deepEqual(ok.ledger.lineage, ['INGEST']);
  assert.equal(readSpore(spore(payload, { tamper: true })).intact, false);
  assert.throws(() => readSpore(Buffer.from('<!DOCTYPE html>')), /not a WASM file/);
});

test('network and file guards refuse private targets', async () => {
  for (const url of ['http://127.0.0.1:8787/api/health', 'http://10.0.0.163/', 'http://localhost/', 'file:///C:/Windows/win.ini', 'http://192.168.1.1/', 'http://[::1]/']) await assert.rejects(assertPublicUrl(url), undefined, url);
  assert.throws(() => underRoots('C:/Windows/System32'), /outside the allowed roots/);
  assert.ok(underRoots(process.cwd()));
});

test('scanRepo builds an import graph of this repository', () => {
  const { files, dependents } = scanRepo(`${process.cwd()}/server/fleet`);
  assert.ok(files.some(f => f.rel === 'runtime.js' && f.exports.includes('startRun')));
  assert.ok((dependents.get('narration-guard.js') || []).includes('runtime.js'));
});

test('every tool has a valid schema, and the skill map covers the whole manifest', () => {
  const tools = createHermesTools();
  assert.ok(tools.length >= 15);
  for (const t of tools) {
    assert.match(t.name, /^(hermes|spore)\.[a-z_]+$/);
    assert.equal(t.parameters.type, 'object');
    assert.ok(t.description.length > 40, t.name);
    assert.ok(['safe', 'approval'].includes(t.risk));
    for (const req of t.parameters.required || []) assert.ok(req in t.parameters.properties, `${t.name}.${req}`);
    for (const [k, v] of Object.entries(t.parameters.properties)) { assert.ok(v.type, `${t.name}.${k} has no type`); if (v.type === 'array') assert.ok(v.items?.type, `${t.name}.${k} array needs typed items`); }
  }
  assert.equal(tools.find(t => t.name === 'hermes.api_request').risk, 'approval');
  assert.equal(HERMES_SKILLS.length, 34); // the manifest numbers 33 entries; entry 30 holds two skills
  const names = new Set(tools.map(t => t.name));
  for (const s of HERMES_SKILLS.filter(x => x.status === 'built')) for (const tool of s.tool.split(' / ')) assert.ok(names.has(tool), `${s.skill} → ${tool}`);
});

test('a tool call that hits a guard returns an error object instead of throwing', async () => {
  const scrape = createHermesTools().find(t => t.name === 'hermes.scrape');
  const r = await scrape.execute({ args: { url: 'http://127.0.0.1:8787/api/health' } }, {});
  assert.match(r.error, /not a public host/);
});

test('artifact shelf lists what exists and refuses to read outside its folders', async () => {
  const { listArtifacts, readArtifact } = await import('../server/hermes/free-tools.js');
  const all = listArtifacts({ limit: 100 });
  assert.equal(typeof all.total, 'number');
  // exactly the fixture: one of each document kind, the draft row, one image, one video, and audio capped at 2
  const kinds = all.artifacts.map(a => a.kind).sort();
  assert.deepEqual(kinds, ['audio', 'audio', 'client', 'draft', 'image', 'report', 'site', 'video', 'wiki']);
  assert.equal(all.artifacts.find(a => a.kind === 'site').title, 'Demo page');
  assert.equal(readArtifact('wiki', 'myproj/Architecture.md').text.includes('Three modules'), true);
  assert.match(readArtifact('draft', 'draft-1').text, /A drafted post/);
  assert.ok(all.artifacts.every(a => ['site', 'wiki', 'client', 'report', 'draft', 'image', 'video', 'audio'].includes(a.kind) && a.title && a.at >= 0));
  assert.deepEqual([...all.artifacts].sort((a, b) => b.at - a.at).map(a => a.id), all.artifacts.map(a => a.id), 'newest first');
  for (const a of all.artifacts.filter(x => x.kind === 'site')) assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+\/sites\/[a-z0-9-]+\/$/);
  for (const a of all.artifacts.filter(x => ['wiki', 'client', 'report', 'draft'].includes(x.kind)).slice(0, 6)) { const r = readArtifact(a.kind, a.id); assert.ok(r && typeof r.text === 'string' && r.text.length > 0, `${a.kind} ${a.id}`); }
  assert.ok(listArtifacts({ kind: 'wiki' }).artifacts.every(a => a.kind === 'wiki'));
  for (const [kind, id] of [['wiki', '../../.env'], ['wiki', '..%2F..%2F.env/x.md'], ['wiki', 'a/../../.env'], ['client', '../chandra.db'], ['client', 'x.js'], ['report', '../../package.json'], ['report', 'C:/Windows/win.ini'], ['site', 'anything'], ['nope', 'x'], ['draft', 'no-such-id']]) assert.equal(readArtifact(kind, id), null, `${kind}:${id}`);
});

test('media on the shelf: typed, capped when unfiltered, and only reachable by bare file name', async () => {
  const { listArtifacts, mediaFile } = await import('../server/hermes/free-tools.js');
  const all = listArtifacts({ limit: 100 });
  assert.equal(all.artifacts.filter(a => a.kind === 'audio').length, 2, 'narration audio must not bury the shelf (3 on disk, 2 shown)');
  assert.equal(listArtifacts({ kind: 'audio' }).artifacts.length, 3, 'the Audio filter shows them all');
  for (const kind of ['image', 'video', 'audio']) {
    const only = listArtifacts({ kind, limit: 5 }).artifacts;
    assert.ok(only.every(a => a.kind === kind && a.media.startsWith('/api/hermes/artifacts/media?kind=' + kind + '&id=')));
    for (const a of only.slice(0, 2)) { const f = mediaFile(kind, a.id); assert.ok(f && f.mime.startsWith(kind + '/'), kind + ' ' + a.id + ' → ' + (f && f.mime)); }
    if (all.counts[kind]) assert.ok(all.counts[kind] >= only.length);
  }
  for (const [kind, id] of [['image', '../chandra.db'], ['image', '..\..\.env'], ['image', 'a/b.png'], ['image', 'chandra.db'], ['audio', '../../.env'], ['video', 'C:/Windows/win.ini'], ['audio', 'x.png'], ['doc', 'x.png'], ['image', '']]) assert.equal(mediaFile(kind, id), null, kind + ':' + id);
});
