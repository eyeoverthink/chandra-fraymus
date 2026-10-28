import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createCodeNavigationTools } from '../server/agent/code-navigation.js';
import { createWorkspacePolicy } from '../server/agent/workspace.js';
import { checkSchema } from '../server/agent/schema.js';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const parent = await fs.realpath(work), directory = await fs.mkdtemp(path.join(parent, 'code-navigation-')), original = await fs.realpath(directory), workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace); const policy = createWorkspacePolicy(workspace), tools = createCodeNavigationTools();
  t.after(async () => { const target = await fs.realpath(directory); assert.equal(target, original); assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('code-navigation-')); await fs.rm(target, { recursive: true, force: true }); });
  const write = async (relative, content) => { const file = path.join(workspace, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  const execute = (name, args, overrides = {}) => tools.find(tool => tool.name === name).execute({ args, workspacePolicy: policy, signal: new AbortController().signal, ...overrides });
  return { directory, workspace, policy, tools, write, execute };
}

test('navigation descriptors register as a small read-only coding group', t => {
  const tools = createCodeNavigationTools(); assert.deepEqual(tools.map(tool => tool.name), ['workspace.readMany','workspace.map']);
  for (const tool of tools) { checkSchema(tool.parameters); assert.equal(tool.group, 'coding'); assert.equal(tool.approvalRequired, false); assert.equal(tool.prepare, undefined); }
  const wireBytes = Buffer.byteLength(JSON.stringify(tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))));
  assert.ok(wireBytes < 4000); t.diagnostic(`Coding navigation adds ${wireBytes} UTF-8 tool-schema bytes when enabled.`);
});

test('cross-file ranges preserve raw BOM, CRLF, LF and CR while hashes and counts cover complete files', async t => {
  const f = await fixture(t), one = '\ufeffalpha\r\nβeta\r\n', two = 'one\rtwo\nthree\r\nlast';
  await f.write('one.txt', one); await f.write('nested/two.txt', two); await f.write('empty.txt', '');
  const result = await f.execute('workspace.readMany', { files: [{ path: 'one.txt', startLine: 1, endLine: 2 }, { path: 'nested/two.txt', startLine: 2, endLine: 3 }, { path: 'empty.txt' }] });
  const [a,b,empty] = result.files; assert.equal(a.content, one); assert.equal(a.sha256, digest(Buffer.from(one))); assert.notEqual(a.sha256, digest(one.replaceAll('\r\n','\n')));
  assert.equal(a.bytes, Buffer.byteLength(one)); assert.equal(a.totalLines, 3); assert.equal(a.utf8Bom, true); assert.deepEqual(a.lineEndings, { lf: 0, crlf: 2, cr: 0, kind: 'crlf', endsWithNewline: true });
  assert.equal(b.content, 'two\nthree\r\n'); assert.equal(b.sha256, digest(two)); assert.equal(b.totalLines, 4); assert.equal(b.startLine, 2); assert.equal(b.endLine, 3);
  assert.equal(b.rangeTruncated, false); assert.equal(b.completeFile, false); assert.equal(b.truncated, true); assert.equal(b.lineEndings.kind, 'mixed');
  assert.equal(empty.totalLines, 1); assert.equal(empty.content, ''); assert.equal(empty.completeFile, true); assert.equal(empty.endLine, 1);
  assert.equal(result.filesRead, 3); assert.equal(result.untrusted, true); assert.ok(result.lineConvention.includes('final-empty')); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12000);
});

test('raw multiple BOMs, standalone CR and final empty lines remain unmodified source data', async t => {
  const f = await fixture(t), raw = '\ufeff\ufefffirst\rsecond\r'; await f.write('cr.txt', raw);
  const result = await f.execute('workspace.readMany', { files: [{ path: 'cr.txt' }, { path: 'cr.txt', startLine: 3, endLine: 3 }, { path: 'cr.txt', startLine: 99 }] });
  assert.equal(result.files[0].content, raw); assert.equal(result.files[0].sha256, digest(raw)); assert.equal(result.files[0].totalLines, 3); assert.equal(result.files[0].lineEndings.cr, 2); assert.equal(result.files[0].endLine, 3);
  assert.equal(result.files[1].content, ''); assert.equal(result.files[1].endLine, 3); assert.equal(result.files[1].rangeTruncated, false);
  assert.equal(result.files[2].ok, false); assert.equal(result.files[2].error.code, 'line_range'); assert.equal(result.files[2].sha256, digest(raw)); assert.equal(result.files[2].bytes, Buffer.byteLength(raw));
});

test('aggregate escaped/Unicode output fits its complete JSON budget without losing full-file metadata', async t => {
  const f = await fixture(t), raw = '"\\\t\r\n😀'.repeat(1200); await f.write('large.txt', raw);
  const result = await f.execute('workspace.readMany', { files: [{ path: 'large.txt' }], maxChars: 1600 }); const file = result.files[0];
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1600); assert.ok(JSON.stringify(result).length <= 1600);
  assert.equal(file.sha256, digest(raw)); assert.equal(file.bytes, Buffer.byteLength(raw)); assert.equal(file.rangeTruncated, true); assert.equal(file.completeFile, false);
  assert.ok(file.content.isWellFormed()); assert.ok(raw.startsWith(file.content)); assert.ok(!(file.content.endsWith('\r') && raw[file.content.length] === '\n'));
  assert.ok(file.content.length < raw.length); assert.equal(result.returnedContentChars, file.content.length);
  const requests = []; for (let i = 0; i < 8; i++) { const name = `file-${i}.txt`; await f.write(name, 'x'.repeat(4000)); requests.push({ path: name }); }
  const many = await f.execute('workspace.readMany', { files: requests }); assert.equal(many.files.length, 8); assert.ok(many.files.every(item => item.sha256 === digest('x'.repeat(4000)) && item.content.length > 0));
  assert.ok(Buffer.byteLength(JSON.stringify(many)) <= 12000);
});

test('invalid batch schemas and descending ranges are rejected before filesystem reads', async t => {
  const f = await fixture(t); let reads = 0; const policy = { ...f.policy, read: async value => { reads++; return f.policy.read(value); } };
  for (const args of [{ files: [] }, { files: Array.from({ length: 9 }, () => ({ path: 'a' })) }, { files: [{ path: 'a', startLine: 3, endLine: 2 }] },
    { files: [{ path: 'a' }], maxChars: 20001 }, { files: [{ path: 'a' }], maxChars: 1023 }, { files: [{ path: 'a', rawHostPath: '/private' }] }])
    await assert.rejects(f.execute('workspace.readMany', args, { workspacePolicy: policy }), { code: 'invalid_arguments' });
  assert.equal(reads, 0); await assert.rejects(f.execute('workspace.readMany', { files: [{ path: 'a' }] }, { workspacePolicy: undefined }), { code: 'workspace_policy_unavailable' });
});

test('run tool-result budgets clamp requested output and reject metadata that cannot fit instead of losing hashes', async t => {
  const f = await fixture(t), content = 'full file contents\r\n'.repeat(500); await f.write('budget.txt', content);
  const run = { budget: { maxToolResultChars: 1100 } };
  const read = await f.execute('workspace.readMany', { files: [{ path: 'budget.txt' }], maxChars: 20000 }, { run });
  assert.equal(read.maxChars, 1100); assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 1100); assert.equal(read.files[0].sha256, digest(content)); assert.equal(read.files[0].rangeTruncated, true);
  const map = await f.execute('workspace.map', { maxChars: 20000 }, { run }); assert.equal(map.maxChars, 1100); assert.ok(Buffer.byteLength(JSON.stringify(map)) <= 1100);
  for (const [tool,args] of [['workspace.readMany',{ files: [{ path: 'budget.txt' }] }],['workspace.map',{}]])
    await assert.rejects(f.execute(tool, args, { run: { budget: { maxToolResultChars: 256 } } }), { code: 'navigation_output_budget' });
});

test('real policy denies traversal, secrets, hardlinks and junctions while retaining independent permitted results', async t => {
  const f = await fixture(t); await f.write('safe.txt', 'allowed'); await f.write('.env', 'must not return');
  const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'outside data');
  await fs.link(path.join(outside, 'secret.txt'), path.join(f.workspace, 'hardlink.txt'));
  await fs.symlink(outside, path.join(f.workspace, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const paths = ['../outside/secret.txt','.env','.git/config','private.key','hardlink.txt','junction/secret.txt','safe.txt'];
  const result = await f.execute('workspace.readMany', { files: paths.map(path => ({ path })) });
  for (const file of result.files.slice(0, -1)) { assert.equal(file.ok, false); assert.equal(file.error.code, 'path_denied'); assert.equal(file.content, undefined); }
  assert.equal(result.files.at(-1).content, 'allowed'); assert.ok(!JSON.stringify(result).includes('outside data')); assert.ok(!JSON.stringify(result).includes(f.directory));
  await f.write('binary.bin', Buffer.from([1, 0, 2])); await f.write('oversized.txt', Buffer.alloc(262145, 65));
  const denied = await f.execute('workspace.readMany', { files: [{ path: 'binary.bin' }, { path: 'oversized.txt' }] });
  assert.deepEqual(denied.files.map(file => file.error.code), ['binary_file','file_too_large']); assert.equal(denied.truncated, true);
});

test('map is a bounded policy-scoped tree with explicit generated/depth/filter omissions and no source reads', async t => {
  const f = await fixture(t);
  for (const [name,text] of Object.entries({ 'README.md': 'root', 'src/main.js': 'globalThis.__navigationSideEffect = true;', 'src/deeper/leaf.js': 'leaf',
    'node_modules/package/code.js': 'excluded', 'dist/bundle.js': 'excluded', 'build/output.js': 'excluded', '.venv/lib/code.py': 'excluded', '.git/config': 'secret', '.env': 'secret' })) await f.write(name, text);
  await fs.link(path.join(f.workspace, 'README.md'), path.join(f.workspace, 'hardlink.md')); // Both hard-linked names must fail file resolution.
  const external = path.join(f.directory, 'external'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'outside.js'), 'not visible');
  await fs.symlink(external, path.join(f.workspace, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const policy = { ...f.policy, read: () => assert.fail('workspace.map must not read source bodies') };
  const result = await f.execute('workspace.map', { maxDepth: 2 }, { workspacePolicy: policy }), names = result.entries.map(entry => entry.path);
  assert.ok(names.includes('src/main.js')); assert.ok(names.includes('src/deeper')); assert.ok(!names.includes('src/deeper/leaf.js'));
  assert.ok(!names.some(name => /(?:node_modules|dist|build|\.venv|\.git|\.env|junction|hardlink|README)/.test(name)));
  assert.equal(result.complete, false); assert.equal(result.truncated, true); assert.ok(result.omissions.skippedDirectories >= 4); assert.ok(result.omissions.depthLimitedDirectories > 0);
  assert.ok(result.omissions.limitedOrFilteredListings > 0); assert.equal(result.omissions.policyFilteredCountUnknown, true); assert.ok(result.omissions.policyRejected >= 2);
  assert.equal(globalThis.__navigationSideEffect, undefined); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12000);
  const deeper = await f.execute('workspace.map', { path: 'src', maxDepth: 6 }); assert.ok(deeper.entries.some(entry => entry.path === 'src/deeper/leaf.js'));
  await assert.rejects(f.execute('workspace.map', { path: 'node_modules' }), { code: 'navigation_directory_skipped' });
  await assert.rejects(f.execute('workspace.map', { path: 'junction' }), { code: 'path_denied' });
});

test('map file, directory, depth and output limits are explicit even when few source files exist', async t => {
  const f = await fixture(t); for (let i = 0; i < 110; i++) await f.write(`dir-${String(i).padStart(3,'0')}/file.txt`, 'x');
  const bounded = await f.execute('workspace.map', { maxDepth: 6, maxFiles: 300, maxChars: 1800 });
  assert.ok(bounded.counts.directoriesVisited <= 100); assert.ok(bounded.omissions.directoryLimit > 0); assert.equal(bounded.truncated, true);
  assert.equal(bounded.omissions.outputLimit, true); assert.ok(bounded.omissions.outputEntriesDropped > 0); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1800);
  const limited = await f.execute('workspace.map', { maxDepth: 6, maxFiles: 2 }); assert.equal(limited.counts.returnedFiles, 2); assert.equal(limited.omissions.fileLimit, true);
  const rootOnly = await f.execute('workspace.map', { maxDepth: 0 }); assert.deepEqual(rootOnly.entries, []); assert.equal(rootOnly.omissions.depthLimitedDirectories, 1);
  await assert.rejects(f.execute('workspace.map', { maxDepth: 7 }), { code: 'invalid_arguments' }); await assert.rejects(f.execute('workspace.map', { maxFiles: 301 }), { code: 'invalid_arguments' });
});

test('abort before and between policy operations stops navigation instead of returning disguised per-file errors', async t => {
  const f = await fixture(t); await f.write('one.txt', 'one'); await f.write('two.txt', 'two'); const reason = new Error('Owned fixture cancelled');
  const before = new AbortController(); before.abort(reason); await assert.rejects(f.execute('workspace.readMany', { files: [{ path: 'one.txt' }] }, { signal: before.signal }), caught => caught === reason);
  let reads = 0; const during = new AbortController();
  const readPolicy = { ...f.policy, read: async input => { reads++; const value = await f.policy.read(input); during.abort(reason); return value; } };
  await assert.rejects(f.execute('workspace.readMany', { files: [{ path: 'one.txt' }, { path: 'two.txt' }] }, { signal: during.signal, workspacePolicy: readPolicy }), caught => caught === reason); assert.equal(reads, 1);
  let listings = 0; const mapping = new AbortController(), mapPolicy = { ...f.policy, list: async (...args) => { listings++; const value = await f.policy.list(...args); mapping.abort(reason); return value; } };
  await assert.rejects(f.execute('workspace.map', {}, { signal: mapping.signal, workspacePolicy: mapPolicy }), caught => caught === reason); assert.equal(listings, 1);
});
