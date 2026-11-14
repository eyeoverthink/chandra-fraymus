import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { groundFacts } from '../server/media/make.js';
import { offlineWikiConfig, offlineWikiSource, offlineWikiInfo, remoteArg } from '../server/media/offline-wiki.js';

const LONG = 'The immune system is a network of biological systems that protects an organism from diseases. It detects and responds to a wide variety of pathogens, from viruses to parasitic worms, as well as cancer cells and objects such as wood splinters, distinguishing them from the organism\'s own healthy tissue.';
const fake = (name, { hits = [], text = LONG, fail = null } = {}) => {
  const calls = [];
  return { name, ready: true, calls, url: k => `x://${k}`,
    async search(s) { calls.push(['search', s]); if (fail) throw new Error(fail); return hits; },
    async intro(k) { calls.push(['intro', k]); return text; } };
};

test('grounding falls back to the offline copy only when the live source cannot be reached', async () => {
  const online = fake('Wikipedia', { fail: 'fetch failed' });
  const offline = fake('Wikipedia (offline copy test)', { hits: [{ title: 'HIV', key: 'HIV' }, { title: 'Immune system', key: 'Immune_system' }] });
  const r = await groundFacts('a 60 second flat animation: the immune system fights a virus', { sources: [online, offline] });
  // the top hit is HIV, as it was online on 2026-11-11: refused, because the article must be ABOUT the subject
  assert.equal(r.title, 'Immune system');
  assert.match(r.source, /offline copy/);
  assert.match(r.why, /Wikipedia could not be reached: fetch failed/);
  assert.deepEqual(offline.calls.at(-1), ['intro', 'Immune_system']);

  // a source that answers "nothing fits" is final: the other copy is not asked
  const answers = fake('Wikipedia', { hits: [{ title: 'Something else', key: 1 }] }), never = fake('offline');
  const r2 = await groundFacts('a short film about the emu war in australia', { sources: [answers, never] });
  assert.equal(r2.text, null);
  assert.match(r2.why, /no article whose title matches/);
  assert.equal(never.calls.length, 0);

  // nothing reachable, or nothing configured: written from memory, and the record says why
  assert.match((await groundFacts('a film about the emu war', { sources: [fake('a', { fail: 'down' }), fake('b', { fail: 'gone' })] })).why, /a could not be reached: down; b could not be reached: gone: written from the model's memory/);
  assert.match((await groundFacts('a film about the emu war', { sources: [] })).why, /no source is configured/);
});

test('the offline source reports what it lacks instead of failing later', () => {
  const c = offlineWikiConfig({});
  assert.equal(c.ready, false);
  assert.deepEqual(c.problems, ['OFFLINE_WIKI_ZIM is not set', 'OFFLINE_WIKI_PYTHON is not set']);
  assert.equal(offlineWikiConfig({ OFFLINE_WIKI_ZIM: 'Z:/nope.zim', OFFLINE_WIKI_PYTHON: 'Z:/nope.exe' }).problems.length, 2);
  // no local copy, a remote one configured: the reader runs over SSH there
  const remote = { OFFLINE_WIKI_ZIM: 'Z:/nope.zim', OFFLINE_WIKI_PYTHON: 'Z:/nope.exe', OFFLINE_WIKI_SSH: 'eyeov@100.99.98.101',
    OFFLINE_WIKI_REMOTE_ZIM: 'E:\\Offline\\w\\wikipedia_en_all_maxi_2026-08.zim', OFFLINE_WIKI_REMOTE_PYTHON: 'E:\\Offline\\zim-env\\Scripts\\python.exe', OFFLINE_WIKI_REMOTE_SCRIPT: 'E:\\Offline\\offline-wiki.py' };
  const r = offlineWikiConfig(remote);
  assert.equal(r.ready, true); assert.equal(r.where, 'ssh eyeov@100.99.98.101'); assert.equal(r.name, 'wikipedia_en_all_maxi_2026-08');
  assert.match(offlineWikiSource(r).name, /on 100\.99\.98\.101/);
  // a malformed host is not used
  assert.equal(offlineWikiConfig({ ...remote, OFFLINE_WIKI_SSH: 'eyeov@host; rm -rf' }).ready, false);
});

test('a search phrase cannot reach the remote shell', () => {
  // cmd expands %VAR% even inside quotes, and a quote would end the argument: all of that is removed
  assert.equal(remoteArg('emu war'), '"emu war"');
  assert.equal(remoteArg('a" & del /q C:\\x & "'), '"a del /q C:\\x"');
  assert.equal(remoteArg('%USERPROFILE% | calc ^ <x> !y!'), '"USERPROFILE calc x y"');
  assert.equal(remoteArg('line\r\nbreak\t`tick`'), '"line break tick"');
  assert.equal(remoteArg('E:\\Offline\\zim-env\\Scripts\\python.exe'), '"E:\\Offline\\zim-env\\Scripts\\python.exe"');
});

// The real reader against a ZIM it writes itself (libzim's Creator). Needs a Python with libzim: OFFLINE_WIKI_PYTHON,
// or the vault's environment.
const PY = process.env.OFFLINE_WIKI_PYTHON || 'F:/Claude-Work/offline-vault/tools/zim-env/Scripts/python.exe';
const hasLibzim = existsSync(PY) && spawnSync(PY, ['-I', '-c', 'import libzim'], { encoding: 'utf8' }).status === 0;
test('a real ZIM is searched and read, and grounds a film', { skip: !hasLibzim && 'no Python with libzim' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chandra-zim-'));
  try {
    const zim = join(dir, 't.zim');
    writeFileSync(join(dir, 'pages.json'), JSON.stringify([
      { path: 'Emu_War', title: 'Emu War', html: `<html><body><p>The <b>Emu War</b> was a nuisance wildlife management military operation undertaken in Australia over the later part of 1932 to address public concern over the number of emus said to be running out of control in the Campion district of Western Australia.</p><table><tr><td>infobox noise that must not appear</td></tr></table><p>Soldiers armed with Lewis guns were deployed, and the operation was widely reported as a failure.</p><h2>Background</h2><p>After the First World War, ex-soldiers took up farming.</p></body></html>` },
      { path: 'HIV', title: 'HIV', html: '<html><body><p>The human immunodeficiency viruses are two species of virus that infect humans and attack the immune system.</p></body></html>' },
    ]));
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'offline-wiki.py');
    const made = spawnSync(PY, ['-I', script, zim, 'make', join(dir, 'pages.json')], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const cfg = offlineWikiConfig({ OFFLINE_WIKI_ZIM: zim, OFFLINE_WIKI_PYTHON: PY });
    assert.equal(cfg.ready, true);
    const info = await offlineWikiInfo(cfg);
    assert.equal(info.articles, 2); assert.equal(info.fulltext, true);
    const src = offlineWikiSource(cfg);
    assert.deepEqual((await src.search('emu war')).map(h => h.title), ['Emu War']);
    const r = await groundFacts('a 40 second story short about the emu war', { sources: [src] });
    assert.equal(r.title, 'Emu War');
    assert.match(r.text, /1932/); assert.match(r.text, /Lewis guns/);
    assert.doesNotMatch(r.text, /infobox noise|ex-soldiers took up farming/); // tables skipped, stops at the first section
    await assert.rejects(src.intro('No_such_article'), /Cannot find entry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
