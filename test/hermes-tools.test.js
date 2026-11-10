import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { htmlToMarkdown, parseFeed, readSpore, assertPublicUrl, underRoots, createHermesTools, HERMES_SKILLS, scanRepo } from '../server/hermes/free-tools.js';

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
  assert.ok(all.artifacts.filter(a => a.kind === 'audio').length <= 2, 'narration audio must not bury the shelf');
  for (const kind of ['image', 'video', 'audio']) {
    const only = listArtifacts({ kind, limit: 5 }).artifacts;
    assert.ok(only.every(a => a.kind === kind && a.media.startsWith('/api/hermes/artifacts/media?kind=' + kind + '&id=')));
    for (const a of only.slice(0, 2)) { const f = mediaFile(kind, a.id); assert.ok(f && f.mime.startsWith(kind + '/'), kind + ' ' + a.id + ' → ' + (f && f.mime)); }
    if (all.counts[kind]) assert.ok(all.counts[kind] >= only.length);
  }
  for (const [kind, id] of [['image', '../chandra.db'], ['image', '..\..\.env'], ['image', 'a/b.png'], ['image', 'chandra.db'], ['audio', '../../.env'], ['video', 'C:/Windows/win.ini'], ['audio', 'x.png'], ['doc', 'x.png'], ['image', '']]) assert.equal(mediaFile(kind, id), null, kind + ':' + id);
});
