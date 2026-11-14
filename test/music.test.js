import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { secondsAsked, wantsVocals, checkSongPlan, lyricLines, tempoOf, tempoMatches, analyseSamples, analyseFile, songCheck, lyricRecall, SECONDS_PER_LINE } from '../server/media/music.js';
import { STEP_KINDS } from '../server/media/make-chains.js';
import { WORKER_KINDS, MEDIA_KINDS } from '../server/intelligence/card-ledger.js';

const RATE = 22050;
/** A synthetic "song": a quiet chord bed with a click on every beat, then silence. */
function track({ bpm = 120, seconds = 20, tail = 5 } = {}) {
  const n = Math.round((seconds + tail) * RATE), x = new Float32Array(n), beat = Math.round(RATE * 60 / bpm);
  for (let i = 0; i < seconds * RATE; i++) {
    x[i] = 0.08 * (Math.sin(2 * Math.PI * 220 * i / RATE) + Math.sin(2 * Math.PI * 277 * i / RATE));
    const k = i % beat; if (k < 300) x[i] += 0.7 * Math.exp(-k / 60) * (k % 2 ? 1 : -1);
  }
  return x;
}

test('the request says the length and whether there is a voice', () => {
  assert.equal(secondsAsked('a 90 second lofi beat'), 90);
  assert.equal(secondsAsked('a 2 minute ballad'), 120);
  assert.equal(secondsAsked('about 1:30 of ambient'), 90);
  assert.equal(secondsAsked('a beat for my stream'), null);
  assert.equal(wantsVocals('a song about the sea'), true);
  assert.equal(wantsVocals('an instrumental song about the sea'), false);
  assert.equal(wantsVocals('a beat for my stream'), false);
  assert.equal(wantsVocals('music without vocals for a rap video'), false);
});

test('a plan is refused for what ACE-Step cannot use, and fixed quietly where it can', () => {
  const ok = { title: 'Harbour', tags: 'acoustic folk, fingerpicked guitar, warm male vocal, gentle', bpm: 92, keyscale: 'Em', timesignature: '3/4', language: 'en' };
  // a 60 s song wants about 13 sung lines
  const want = Math.round(60 / SECONDS_PER_LINE);
  const lyrics = '[Verse]\n' + Array.from({ length: want }, (_, i) => `line ${i} about the harbour lights`).join('\n');
  const r = checkSongPlan({ ...ok, lyrics }, { seconds: 60, vocals: true });
  assert.ok(r.ok, r.reason);
  assert.equal(r.plan.keyscale, 'E minor');
  assert.equal(r.plan.timesignature, '3');
  assert.equal(lyricLines(r.plan.lyrics).length, want);

  assert.match(checkSongPlan({ ...ok, tags: 'pop' , lyrics }, { seconds: 60, vocals: true }).reason, /describe the sound/);
  assert.match(checkSongPlan({ ...ok, tags: 'pop in the style of a famous band, piano', lyrics }, { seconds: 60, vocals: true }).reason, /traits/);
  assert.match(checkSongPlan({ ...ok, lyrics: '[Verse]\nonly\ntwo' }, { seconds: 120, vocals: true }).reason, /2 sung lines for 120 seconds/);
  // the same short lyrics are accepted on the last attempt, with the reason recorded
  const last = checkSongPlan({ ...ok, lyrics: '[Verse]\nonly\ntwo' }, { seconds: 120, vocals: true, final: true });
  assert.ok(last.ok && last.fixes.some(f => /kept on the last attempt/.test(f)));
  // an instrumental never sings, and says so in its tags
  const inst = checkSongPlan({ ...ok, lyrics: 'la la la' }, { seconds: 60, vocals: false });
  assert.equal(inst.plan.lyrics, '[Instrumental]');
  assert.match(inst.plan.tags, /instrumental/);
  // nonsense numbers become defaults, recorded
  const bad = checkSongPlan({ ...ok, bpm: 900, keyscale: 'H dorian', lyrics }, { seconds: 60, vocals: true });
  assert.equal(bad.plan.bpm, 100); assert.equal(bad.plan.keyscale, 'C major');
  assert.equal(bad.fixes.length >= 2, true);
  assert.equal(checkSongPlan('not json', { seconds: 60, vocals: false }).ok, false);
});

test('tempo is found from the beat, and half or double time count as the same beat', () => {
  for (const bpm of [82, 100, 128]) {
    const a = analyseSamples(track({ bpm, seconds: 20, tail: 0 }), RATE);
    assert.ok(tempoMatches(bpm, a.tempo.bpm), `${bpm} BPM measured as ${a.tempo.bpm}`);
  }
  assert.equal(tempoMatches(120, 60), true);
  assert.equal(tempoMatches(120, 240), true);
  assert.equal(tempoMatches(120, 97), false);
  assert.equal(tempoOf(new Array(10).fill(0), 0.02).bpm, null);
});

test('the music is measured without its trailing silence', () => {
  const a = analyseSamples(track({ bpm: 100, seconds: 20, tail: 6 }), RATE);
  assert.ok(Math.abs(a.musicSeconds - 20) < 0.2, `music ${a.musicSeconds}`);
  assert.ok(Math.abs(a.seconds - 26) < 0.1);
  assert.ok(a.soundShare > 0.95);
  // asked for 30: 20 s of music is a note; asked for 60 it is a failure
  assert.equal(songCheck(a, { seconds: 30, bpm: 100 }).ok, true);
  assert.match(songCheck(a, { seconds: 30, bpm: 100 }).notes.join(' '), /20(\.\d+)? s of music for 30 s/);
  assert.match(songCheck(a, { seconds: 60, bpm: 100 }).problems.join(' '), /only 20/);
  // silence is never a song
  const quiet = analyseSamples(new Float32Array(RATE * 10), RATE);
  assert.equal(songCheck(quiet, { seconds: 10, bpm: 100 }).ok, false);
  // a wrong tempo is a note, not a failure
  const off = songCheck(analyseSamples(track({ bpm: 100, seconds: 20, tail: 0 }), RATE), { seconds: 20, bpm: 140 });
  assert.equal(off.ok, true); assert.match(off.notes.join(' '), /BPM/);
});

test("a song's words are heard back: recall counts each sung word once, repeats included", () => {
  // the first real song (2026-11-14) as Whisper heard it on fraymus-home: "fog" came back as "fall"
  const lyrics = '[Verse]\nThrough the fog, the beacon glows,\nWaiting for the ship to show.\n[Chorus]\nOh, come sail through the mist\n[Outro]\nThrough the fog, the beacon glows,';
  const heard = [{ text: 'Through the fall the beacon glows, waiting for the ship to show' }, { text: "Oh, come sail through the mist" }, { text: 'Through the fall the beacon glows' }];
  const r = lyricRecall(lyrics, heard);
  assert.equal(r.lyricWords, 24);
  assert.equal(r.recall, +(22 / 24).toFixed(3)); // "fog" missed in the verse and in the outro
  assert.deepEqual(r.missed, ['fog']);
  // a repeated line has to be sung again to count again
  assert.ok(lyricRecall(lyrics, heard.slice(0, 2)).recall < r.recall);
  // mumbling fails a song; an instrumental is never asked for words
  const a = analyseSamples(track({ bpm: 100, seconds: 20, tail: 0 }), RATE);
  assert.match(songCheck(a, { seconds: 20, bpm: 100, instrumental: false }, lyricRecall(lyrics, [{ text: 'la la la ooh' }])).problems.join(' '), /lyrics could be heard/);
  assert.match(songCheck(a, { seconds: 20, bpm: 100, instrumental: false }, { error: 'no Whisper model' }).notes.join(' '), /not checked \(no Whisper/);
  assert.equal(songCheck(a, { seconds: 20, bpm: 100, instrumental: true }, null).notes.length, 0);
});

test('a real file goes through ffmpeg and measures the same', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chandra-music-'));
  try {
    const x = track({ bpm: 120, seconds: 12, tail: 3 }), data = Buffer.alloc(x.length * 2);
    for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    const f = join(dir, 't.wav'); writeFileSync(f, Buffer.concat([h, data]));
    const a = await analyseFile(f);
    assert.ok(Math.abs(a.musicSeconds - 12) < 0.2, `music ${a.musicSeconds}`);
    assert.ok(tempoMatches(120, a.tempo.bpm), `tempo ${a.tempo.bpm}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('music is wired: a chain step, a worker kind on the card, and agent card budgets count it', () => {
  assert.equal(STEP_KINDS.music.gives, 'audio');
  assert.deepEqual(WORKER_KINDS.music, ['music', 'gpu']);
  assert.ok(MEDIA_KINDS.includes('music'));
});

test("the worker cleans a music job's inputs and builds the ACE-Step graph", { skip: spawnSync('python', ['--version']).status !== 0 && 'no python' }, () => {
  const code = `
import importlib.util, json
s = importlib.util.spec_from_file_location('w', 'scripts/worker/chandra_worker.py'); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
c = m.clean_music({'tags': 'lofi, piano', 'seconds': 999, 'bpm': 'x', 'keyscale': 'H minor', 'timesignature': '5', 'seed': 7}, 'job1')
wf = m.ace15_workflow(c)
try:
    m.clean_music({}, 'j'); refused = False
except ValueError:
    refused = True
print(json.dumps({'c': c, 'types': sorted(n['class_type'] for n in wf.values()), 'refused': refused, 'kinds': list(m.KINDS)}))`;
  const r = spawnSync('python', ['-I', '-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.c.seconds, 240); assert.equal(out.c.bpm, 110); assert.equal(out.c.keyscale, 'C major'); assert.equal(out.c.timesignature, '4');
  assert.equal(out.c.lyrics, '[Instrumental]');
  assert.ok(out.types.includes('TextEncodeAceStepAudio1.5') && out.types.includes('EmptyAceStep1.5LatentAudio') && out.types.includes('SaveAudio'));
  assert.equal(out.refused, true);
  assert.ok(out.kinds.includes('music'));
});
