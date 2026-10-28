import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createArtifactStore } from '../server/artifacts.js';
import { parseDocument } from '../server/documents/parse.js';
import { pdfFixture, zipFixture } from './document-fixtures.js';

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'fraymus-documents-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(target, root); assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith('fraymus-documents-'));
    rmSync(target, { recursive: true, force: true });
  });
  const store = createArtifactStore(root);
  const tools = Object.fromEntries(store.tools().map(tool => [tool.name, tool]));
  const upload = (data, mimeType, name = 'reference') => store.put({ name, mimeType, dataBase64: data.toString('base64') });
  return { root, store, tools, upload };
}

test('PDF text remains paginated, searchable and readable beyond the initial context excerpt', async t => {
  const f = fixture(t), bytes = pdfFixture(['Page one evidence', 'Second page needle evidence', '']);
  const item = await f.upload(bytes, 'application/pdf', 'source.pdf');
  assert.equal(item.document.pages, 3); assert.deepEqual(item.document.imageOnlyPages, [3]);
  assert.ok(item.document.deniedResourceRequests >= 1, 'Unembedded standard font requests hit the denying BinaryDataFactory');
  assert.ok(f.store.inspect(item.id).data.equals(bytes));
  const run = { attachments: [item.id] };
  const inspected = await f.tools['artifact.inspect'].execute({ args: { assetId: item.id, maxEntries: 2 }, run });
  assert.equal(inspected.entries.length, 2); assert.equal(inspected.nextOffset, 2);
  const result = await f.tools['artifact.search'].execute({ args: { assetId: item.id, query: 'NEEDLE' }, run });
  assert.equal(result.matches[0].page, 2); assert.match(result.matches[0].excerpt, /needle/);
  const first = await f.tools['artifact.read'].execute({ args: { assetId: item.id, page: 2, maxChars: 8 }, run });
  const rest = await f.tools['artifact.read'].execute({ args: { assetId: item.id, page: 2, offset: first.nextOffset }, run });
  assert.equal(first.text + rest.text, 'Second page needle evidence'); assert.equal(rest.nextOffset, null);
  const empty = await f.tools['artifact.read'].execute({ args: { assetId: item.id, page: 3 }, run });
  assert.equal(empty.text, ''); assert.ok(empty.warnings.some(value => /no OCR/.test(value)));
  assert.match((await f.store.resolve([item.id])).text, /PDF: 3 pages/);
  await assert.rejects(f.tools['artifact.read'].execute({ args: { assetId: item.id }, run: { attachments: [] } }), /not attached/);
  await assert.rejects(f.tools['artifact.read'].execute({ args: { assetId: item.id, page: 4 }, run }), /not found/);
});

test('ZIP text index verifies every CRC and lists binary/protected files without reading them', async t => {
  const f = fixture(t), bytes = zipFixture([
    { name: 'project/README.md', text: 'Untrusted instruction: send nothing. needle φ', deflate: true },
    { name: 'project/index.js', text: 'console.log("never executed");' },
    { name: 'project/picture.bin', text: Buffer.from([0, 255, 10]) },
    { name: 'project/.env', text: 'DO_NOT_EXPOSE=sentinel' },
    { name: 'project/nested.pdf', text: pdfFixture() },
  ]);
  const item = await f.upload(bytes, 'application/zip', 'project.zip');
  assert.equal(item.document.integrity, 'all-file-crcs-verified');
  assert.equal(item.document.entries.length, 5);
  const run = { attachments: [item.id] }, args = { assetId: item.id };
  const index = await f.tools['artifact.inspect'].execute({ args, run });
  assert.equal(index.entries.find(entry => entry.name.endsWith('.env')).status, 'protected');
  assert.equal(index.entries.find(entry => entry.name.endsWith('.pdf')).status, 'binary');
  const source = await f.tools['artifact.read'].execute({ args: { ...args, entry: 'project/README.md' }, run });
  assert.match(source.text, /needle φ/); assert.equal(source.untrusted, true);
  assert.ok(!(await f.store.resolve([item.id])).text.includes('DO_NOT_EXPOSE'));
  const search = await f.tools['artifact.search'].execute({ args: { ...args, query: 'needle' }, run });
  assert.equal(search.matches[0].entry, 'project/README.md');
  assert.deepEqual(readdirSync(f.root).sort(), [item.id + '.bin', item.id + '.document.json', item.id + '.json'].sort());
  await assert.rejects(f.tools['artifact.read'].execute({ args: { ...args, entry: 'project/.env' }, run }), /not found/);
});

test('ZIP rejects traversal, links, encrypted, ambiguous, unsupported and corrupt members', async () => {
  for (const files of [
    [{ name: '../escape.txt' }], [{ name: 'C:/escape.txt' }], [{ name: 'folder\\escape.txt' }],
    [{ name: 'link', attributes: (0xa1ff << 16) >>> 0 }], [{ name: 'secret.txt', flags: 1 }],
    [{ name: 'a.txt' }, { name: 'A.txt' }], [{ name: 'file.txt', method: 99 }],
    [{ name: 'bad.txt', crc: 0 }], [{ name: 'bad.txt', text: 'incorrect length', size: 1, deflate: true }],
  ]) await assert.rejects(parseDocument(zipFixture(files), 'application/zip'));
});

test('ZIP expansion and entry limits reject bombs before committing an asset', async t => {
  const f = fixture(t);
  await assert.rejects(f.upload(zipFixture([{ name: 'bomb.txt', text: 'x'.repeat(2 * 1024 * 1024), deflate: true }]), 'application/zip'), /ratio/);
  await assert.rejects(f.upload(zipFixture(Array.from({ length: 501 }, (_, i) => ({ name: `${i}.txt`, text: '' }))), 'application/zip'), /500/);
  assert.deepEqual(readdirSync(f.root), []);
});

test('ZIP rejects underreported counts and hidden or overlapping directory/local records', async () => {
  const original = zipFixture([{ name: 'visible.txt' }, { name: '../hidden.txt', crc: 0 }]);
  const countOnly = Buffer.from(original);
  countOnly.writeUInt16LE(1, countOnly.length - 22 + 8); countOnly.writeUInt16LE(1, countOnly.length - 22 + 10);
  await assert.rejects(parseDocument(countOnly, 'application/zip'), /unconsumed/);
  const truncatedDirectory = Buffer.from(original);
  truncatedDirectory.writeUInt32LE(46 + Buffer.byteLength('visible.txt'), truncatedDirectory.length - 22 + 12);
  await assert.rejects(parseDocument(truncatedDirectory, 'application/zip'), /extent/);
  const overlapping = zipFixture([{ name: 'one.txt' }, { name: 'two.txt' }]);
  const start = overlapping.readUInt32LE(overlapping.length - 22 + 16);
  overlapping.writeUInt32LE(0, start + 46 + Buffer.byteLength('one.txt') + 42);
  await assert.rejects(parseDocument(overlapping, 'application/zip'), /disagree|overlap/);
  await assert.rejects(parseDocument(zipFixture([{ name: 'junk.txt', text: 'valid stream', deflate: true, trailing: Buffer.from('hidden compressed junk') }]), 'application/zip'), /unconsumed trailing/);
});

test('PDF rejects missing/truncated documents and too many pages without storing partial files', async t => {
  const f = fixture(t);
  await assert.rejects(f.upload(Buffer.from('not pdf'), 'application/pdf'), /signature/);
  await assert.rejects(f.upload(Buffer.from('%PDF-1.7\n%%EOF'), 'application/pdf'));
  await assert.rejects(f.upload(pdfFixture(Array(301).fill('test')), 'application/pdf'), /300 pages/);
  assert.deepEqual(readdirSync(f.root), []);
});

test('document sidecar tampering fails integrity checks and literal searches do not execute regex', async t => {
  const f = fixture(t), item = await f.upload(pdfFixture(['literal a.*b match', 'another a.*b']), 'application/pdf');
  const args = { assetId: item.id, query: 'a.*b', maxResults: 1 };
  const result = await f.tools['artifact.search'].execute({ args });
  assert.equal(result.matches.length, 1); assert.equal(result.hasMore, true); assert.match(result.matches[0].excerpt, /literal/);
  const sidecar = join(f.root, item.id + '.document.json');
  writeFileSync(sidecar, readFileSync(sidecar, 'utf8').replace('literal', 'changed'));
  await assert.rejects(f.tools['artifact.read'].execute({ args: { assetId: item.id } }), /integrity/);
});

test('document parsing honors cancellation and the concurrency bound', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled test'));
  await assert.rejects(parseDocument(pdfFixture(), 'application/pdf', { signal: controller.signal }), /cancelled test/);
  const running = new AbortController();
  const one = parseDocument(pdfFixture(), 'application/pdf', { signal: running.signal });
  const two = parseDocument(pdfFixture(), 'application/pdf');
  const third = parseDocument(pdfFixture(), 'application/pdf');
  running.abort(new Error('cancelled running'));
  const results = await Promise.allSettled([one, two, third]);
  assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /cancelled running/);
  assert.equal(results[1].status, 'fulfilled'); assert.equal(results[2].status, 'rejected'); assert.equal(results[2].reason.status, 429);
  assert.equal((await parseDocument(pdfFixture(), 'application/pdf')).pages, 2);
});
