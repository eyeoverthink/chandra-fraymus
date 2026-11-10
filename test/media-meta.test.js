import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db.js';
import { describeArgs, opName, noteMedia, notePromptJob, notePromptFile, mediaMetaFor, searchMediaFiles } from '../server/media/media-meta.js';

const TAG = `zz-test-${process.pid}`;
const files = [`${TAG}-a.png`, `${TAG}-b.png`, `${TAG}-c.mp3`, `${TAG}-d.mp4`, `${TAG}-e.txt`];
after(() => {
  // leave no rows behind in the live database
  db.prepare(`DELETE FROM media_meta WHERE file LIKE ?`).run(`${TAG}%`);
  db.prepare(`DELETE FROM media_prompt_jobs WHERE prompt_id LIKE ?`).run(`${TAG}%`);
  db.prepare(`DELETE FROM media_prompt_files WHERE remote_file LIKE ?`).run(`${TAG}%`);
});

test('describeArgs keeps the text and scalar options, and drops payloads', () => {
  const base64 = 'A'.repeat(400);
  const d = describeArgs([Buffer.from('x'), 'a neon llama at dusk', { opacity: 0.4, position: 'southeast', huge: base64, nested: { a: 1 } }, 2]);
  assert.equal(d.prompt, 'a neon llama at dusk');
  assert.deepEqual(d.params, { opacity: 0.4, position: 'southeast', arg3: 2 });
  assert.equal(describeArgs([base64, { width: 10 }]).prompt, null, 'a base64 input is not a description');
  assert.equal(describeArgs(['data:image/png;base64,AAAA']).prompt, null);
  assert.equal(describeArgs(['first text', 'second text']).prompt, 'first text');
  assert.deepEqual(describeArgs([[1, 2, 3]]).params, { arg0_count: 3 });
  assert.deepEqual(describeArgs(undefined), { prompt: null, params: {} });
});

test('opName turns engine function names into shelf words', () => {
  assert.deepEqual(['imageResize', 'videoToGif', 'edgeTtsSpeak', 'sapiSpeak', 'imageCreate', 'generate'].map(opName), ['resize', 'toGif', 'speak', 'speak', 'create', 'generate']);
});

test('noteMedia records by file type and ignores files that are not media', () => {
  (function watermark() { noteMedia(files[0], 'imageWatermark', arguments); })(Buffer.from('img'), `${TAG} watermark text`, { opacity: 0.5 });
  (function speak() { noteMedia(files[2], 'edgeTtsSpeak', arguments); })(`${TAG} spoken line`, { voice: 'en-US-GuyNeural' }, 'edge');
  (function trim() { noteMedia(files[3], 'videoTrim', arguments); })(Buffer.from('vid'), { start: 1, duration: 3 });
  noteMedia(files[4], 'imageResize', []);
  const m = mediaMetaFor(files);
  assert.equal(m.size, 3);
  assert.deepEqual([m.get(files[0]).op, m.get(files[0]).prompt, m.get(files[0]).params.opacity], ['watermark', `${TAG} watermark text`, 0.5]);
  assert.deepEqual([m.get(files[2]).op, m.get(files[2]).prompt, m.get(files[2]).params.voice], ['speak', `${TAG} spoken line`, 'en-US-GuyNeural']);
  assert.deepEqual([m.get(files[3]).op, m.get(files[3]).prompt, m.get(files[3]).params], ['trim', null, { start: 1, duration: 3 }]);
  assert.equal(db.prepare(`SELECT kind FROM media_meta WHERE file = ?`).get(files[3]).kind, 'video');
});

test('a ComfyUI image gets the prompt that was submitted, not its remote file name', () => {
  notePromptJob(`${TAG}-job`, `${TAG} a glass lighthouse in fog`, { seed: 7, width: 1024, height: 1024, steps: 4 });
  notePromptFile(`${TAG}-chandra_00001_.png`, `${TAG}-job`);
  (function comfyuiFetchImage() { noteMedia(files[1], 'comfyuiFetchImage', arguments); })(`${TAG}-chandra_00001_.png`, '');
  const m = mediaMetaFor([files[1]]).get(files[1]);
  assert.equal(m.op, 'generate');
  assert.equal(m.prompt, `${TAG} a glass lighthouse in fog`);
  assert.equal(m.params.seed, 7);
  // no parked job → recorded as a generation with no prompt, never with the remote file name as its text
  (function comfyuiFetchImage() { noteMedia(files[0], 'comfyuiFetchImage', arguments); })('unknown_remote.png', '');
  assert.equal(mediaMetaFor([files[0]]).get(files[0]).prompt, null);
});

test('search finds files by prompt text and by operation, and treats % and _ literally', () => {
  assert.ok(searchMediaFiles('glass lighthouse').has(files[1]));
  assert.ok(searchMediaFiles(`${TAG} SPOKEN`).has(files[2]), 'case-insensitive');
  assert.ok([...searchMediaFiles('trim')].includes(files[3]));
  assert.equal(searchMediaFiles(`${TAG}%nothing`).size, 0);
  assert.equal(searchMediaFiles(`${TAG}_spoken`).size, 0, '_ is not a wildcard');
});

test('recording never throws, whatever it is handed', () => {
  assert.doesNotThrow(() => { noteMedia(null, 'x', null); noteMedia(undefined); noteMedia(`${TAG}-z.png`, 'imageResize', { length: 'nope' }); notePromptJob(null, null); notePromptFile(null, null); });
});
