/**
 * Music — words become a song, or an instrumental, made on our own card (gap 9 in docs/NEXUS-ENGINE-CREATION-METHODS.md).
 *
 *   plan     — from a sentence the model pool writes {title, tags, bpm, key, time signature, lyrics}; `checkSongPlan`
 *              refuses what ACE-Step cannot use well (no sound described, an artist named as the style, lyrics that
 *              cannot fill — or would overflow — the length asked) and the reason goes back to the writer (≤ 3 tries).
 *              Explicit tags / lyrics from the caller skip the writer.
 *   compose  — ACE-Step 1.5 turbo on fraymus-home through worker kind `music` (ComfyUI's native nodes, under the
 *              card lock; nothing leaves the tailnet). No machine able to → the job fails and says why; there is
 *              no paid fallback.
 *   check    — measured from the audio, no model: how long the MUSIC lasts (the model fills the asked length as a
 *              budget and often pads silence at the end), how much of it is sound, clipping, and the tempo by
 *              autocorrelating an onset envelope (half / double tempo count as the same beat). Too short or mostly
 *              silent → one retry with a new seed, then the job fails; a tempo that differs is a note, not a failure.
 *              A song's words are heard back: the worker runs Whisper on its CPU and `lyricRecall` counts how much of
 *              the lyrics was sung; under 40 % fails the attempt (mumbling), under 70 % is a note.
 *   master   — trailing silence cut, loudness to −14 LUFS with a −1.5 dB true-peak ceiling, 320k MP3 on the shelf
 *              (data/music) with provenance; the lossless FLAC and lineage stay in data/creations/<id>/.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { mayRecoverAtBoot, DATA_DIR } from '../config.js';
import { withOrigin, assertCardBudget } from '../intelligence/card-ledger.js';
import { publish } from '../fleet/bus.js';
import { chatOllama } from '../commerce/shared.js';
import { pickWorker, runOnWorker } from './workers.js';
import { noteMedia } from './media-meta.js';

const clip = (s, n) => String(s ?? '').slice(0, n);
const now = () => Date.now();
const emit = p => { try { publish('studio', 'system.studio', JSON.stringify(p)); } catch (e) { console.error('[music] publish:', e.message); } };
export const MUSIC_DIR = join(DATA_DIR, 'music');
const CREATIONS = join(DATA_DIR, 'creations');

export const MIN_SECONDS = 10, MAX_SECONDS = 240, DEFAULT_SECONDS = 60;
export const KEYS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'].flatMap(r => [`${r} major`, `${r} minor`]);
export const LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'ko', 'zh', 'ru'];
// a sung line takes about this long in ACE-Step's songs, intro and breaks included (fitted on the first songs; see CLAUDE.md)
export const SECONDS_PER_LINE = 4.5;

db.exec(`CREATE TABLE IF NOT EXISTS music_jobs (id TEXT PRIMARY KEY, request TEXT, source TEXT, status TEXT NOT NULL, stage TEXT, plan TEXT, file TEXT,
  check_result TEXT, error TEXT, created_at INTEGER, completed_at INTEGER)`);
if (mayRecoverAtBoot()) db.prepare(`UPDATE music_jobs SET status = 'error', error = 'interrupted by restart', completed_at = ? WHERE status IN ('queued', 'running')`).run(now());

// ── reading the request ──────────────────────────────────────────────────────────────────────────────

/** Length asked in the sentence ("a 90 second", "2 minute", "1:30"), else null. */
export function secondsAsked(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/\b(\d{1,2}):([0-5]\d)\b/);
  if (m) return +m[1] * 60 + +m[2];
  m = s.match(/(\d+(?:\.\d+)?)\s*-?\s*(seconds?|secs?|s\b|minutes?|mins?)/);
  if (!m) return null;
  return Math.round(+m[1] * (/^m/.test(m[2]) ? 60 : 1));
}
/** A song with a voice is asked for in so many words; anything else (a beat, a score, background music) is instrumental. */
export function wantsVocals(text) {
  const s = String(text || '').toLowerCase();
  if (/\b(instrumental|no vocals?|without (vocals?|words|singing|lyrics)|no singing|no lyrics)\b/.test(s)) return false;
  return /\b(song|sing|sings|sung|singer|singing|vocals?|lyrics|rap|rapper|chorus|verse|ballad|anthem|lullaby|duet|choir)\b/.test(s);
}

export function songMessages(request, { seconds, vocals, lyrics = null }, feedback = null) {
  const lines = Math.max(2, Math.round(seconds / SECONDS_PER_LINE));
  return [
    { role: 'system', content: `You plan one piece of music for a local music model (ACE-Step). Reply with ONE JSON object and nothing else:
{"title": short title, "tags": "comma-separated sound description: genre, instruments, mood, tempo feel, production, and for a song the voice (e.g. warm female vocal)", "bpm": integer 40-220, "keyscale": e.g. "E minor", "timesignature": "4" | "3" | "6", "language": "en", "lyrics": string}
Rules:
- Describe the sound by its traits. Never name an artist, band, song or album, and never write "in the style of".
- ${vocals ? (lyrics ? 'The lyrics are given; return them unchanged in "lyrics", only adding section tags if they have none.' : `Write ORIGINAL lyrics (never quote an existing song) with section tags on their own lines: [Verse], [Chorus], [Bridge], [Outro]. The piece lasts ${seconds} seconds, so write about ${lines} sung lines in all (not counting the tags).`) : 'This is an instrumental: "lyrics" must be exactly "[Instrumental]" and the tags must say instrumental.'}
- Choose bpm and key that fit the mood asked for.` },
    { role: 'user', content: `Music to make (${seconds} seconds): ${request}${lyrics ? `\n\nLyrics:\n${lyrics}` : ''}${feedback ? `\n\nYour last answer was not usable: ${feedback}` : ''}` },
  ];
}

// ── checking a plan ──────────────────────────────────────────────────────────────────────────────────

const TAG_LINE = /^\s*\[[^\]]{2,40}\]\s*$/;
export function lyricLines(lyrics) { return String(lyrics || '').split('\n').map(l => l.trim()).filter(l => l && !TAG_LINE.test(l)); }
function normKey(k) {
  const m = String(k || '').trim().match(/^([A-Ga-g])([#b♯♭]?)\s*(maj(?:or)?|min(?:or)?|m)?$/);
  if (!m) return null;
  const root = m[1].toUpperCase() + m[2].replace('♯', '#').replace('♭', 'b');
  const q = !m[3] ? 'major' : /^min|^m$/.test(m[3]) ? 'minor' : 'major';
  const key = `${root} ${q}`;
  return KEYS.includes(key) ? key : null;
}
function normTime(t) { const m = String(t ?? '').match(/^\s*([2346])(?:\s*\/\s*\d+)?\s*$/); return m ? m[1] : null; }

/**
 * The writer's JSON → a plan ACE-Step can use, or the reason it cannot. `fixes` records every change made quietly.
 * `final`: on the last attempt a lyric count that is off is accepted with a fix instead of refused.
 */
export function checkSongPlan(raw, { seconds, vocals, final = false }) {
  let p;
  try { p = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return { ok: false, reason: 'the answer was not JSON' }; }
  if (!p || typeof p !== 'object') return { ok: false, reason: 'the answer was not a JSON object' };
  const fixes = [];
  let tags = Array.isArray(p.tags) ? p.tags.join(', ') : String(p.tags || '');
  tags = tags.replace(/\s+/g, ' ').trim();
  const words = tags.split(/[\s,]+/).filter(Boolean).length;
  if (words < 3) return { ok: false, reason: 'the tags do not describe the sound (give genre, instruments and mood)' };
  if (/\b(in the style of|style of|sounds? like|inspired by)\b/i.test(tags)) return { ok: false, reason: 'the tags name a style by an artist or song; describe the sound by its traits instead' };
  if (words > 90) { tags = tags.split(/\s+/).slice(0, 90).join(' '); fixes.push('tags cut to 90 words'); }
  let bpm = parseInt(p.bpm, 10);
  if (!(bpm >= 40 && bpm <= 220)) { fixes.push(`bpm ${p.bpm ?? 'missing'} → 100`); bpm = 100; }
  let keyscale = normKey(p.keyscale);
  if (!keyscale) { fixes.push(`key "${clip(p.keyscale, 20)}" not usable → C major`); keyscale = 'C major'; }
  let timesignature = normTime(p.timesignature);
  if (!timesignature) { if (p.timesignature != null) fixes.push(`time signature "${clip(p.timesignature, 10)}" → 4`); timesignature = '4'; }
  let language = String(p.language || 'en').toLowerCase().slice(0, 2);
  if (!LANGUAGES.includes(language)) { fixes.push(`language "${clip(p.language, 10)}" → en`); language = 'en'; }
  let lyrics = String(p.lyrics || '').replace(/\r/g, '').replace(/```\w*|```/g, '').trim();
  if (!vocals) {
    if (lyrics !== '[Instrumental]') { if (lyrics) fixes.push('lyrics dropped: an instrumental was asked for'); lyrics = '[Instrumental]'; }
    if (!/instrumental/i.test(tags)) { tags = `${tags}, instrumental`; fixes.push('"instrumental" added to the tags'); }
  } else {
    const lines = lyricLines(lyrics);
    if (lines.length < 2) return { ok: false, reason: 'a song was asked for and there are no lyrics' };
    if (!lyrics.split('\n').some(l => TAG_LINE.test(l))) { lyrics = `[Verse]\n${lyrics}`; fixes.push('[Verse] tag added'); }
    const want = Math.max(2, Math.round(seconds / SECONDS_PER_LINE)), lo = Math.max(2, Math.floor(want * 0.5)), hi = Math.ceil(want * 1.8);
    if (lines.length < lo || lines.length > hi) {
      const msg = `${lines.length} sung lines for ${seconds} seconds; about ${want} fit (between ${lo} and ${hi})`;
      if (!final) return { ok: false, reason: msg };
      fixes.push(`kept on the last attempt: ${msg}`);
    }
    if (lyrics.length > 4000) { lyrics = lyrics.slice(0, 4000); fixes.push('lyrics cut to 4000 characters'); }
  }
  const title = clip(String(p.title || '').replace(/["\n]/g, '').trim(), 80) || 'Untitled';
  return { ok: true, plan: { title, tags: clip(tags, 1200), bpm, keyscale, timesignature, language, lyrics, seconds, instrumental: !vocals }, fixes };
}

// ── measuring the audio ──────────────────────────────────────────────────────────────────────────────

const WIN = 0.05;          // 50 ms windows for loudness
const SILENT_DB = -45;     // a window quieter than this is silence
/** Tempo from an onset envelope: autocorrelation over 50–220 BPM. Pure. */
export function tempoOf(env, hopSeconds) {
  const n = env.length;
  if (n < 64) return { bpm: null, confidence: 0 };
  const mean = env.reduce((a, b) => a + b, 0) / n;
  const x = env.map(v => v - mean);
  let zero = 0; for (let i = 0; i < n; i++) zero += x[i] * x[i];
  if (!zero) return { bpm: null, confidence: 0 };
  let best = -Infinity, bestLag = 0, bestRaw = 0;
  const lo = Math.max(1, Math.floor(60 / 220 / hopSeconds)), hi = Math.min(n - 1, Math.ceil(60 / 50 / hopSeconds));
  const at = l => { let s = 0; for (let i = 0; i + l < n; i++) s += x[i] * x[i + l]; return s / ((n - l) / n); }; // unbiased: long lags are not penalised for fewer pairs
  for (let lag = lo; lag <= hi; lag++) {
    // perceptual weighting: a log-Gaussian around 120 BPM (one octave wide), so a slow sub-multiple of the beat does not win
    const s = at(lag), w = Math.exp(-0.5 * Math.log2(60 / (lag * hopSeconds) / 120) ** 2);
    if (s * w > best) { best = s * w; bestLag = lag; bestRaw = s; }
  }
  if (!bestLag || bestRaw <= 0) return { bpm: null, confidence: 0 };
  // parabolic interpolation around the peak for a sub-hop lag
  const a = at(bestLag - 1), c = bestLag + 1 < n ? at(bestLag + 1) : bestRaw, d = a - 2 * bestRaw + c;
  const lag = d < 0 ? bestLag + 0.5 * (a - c) / d : bestLag;
  return { bpm: +(60 / (lag * hopSeconds)).toFixed(1), confidence: +(bestRaw / zero).toFixed(3) };
}
/** A found tempo matches the asked one when it is within `tol` of it, half of it or double it (the same beat, counted differently). */
export function tempoMatches(asked, found, tol = 0.06) {
  if (!asked || !found) return false;
  return [1, 2, 0.5].some(f => Math.abs(found * f - asked) / asked <= tol);
}
/**
 * Loudness and tempo measurements on mono samples. Pure. `peakSamples` (the real channels, interleaved) gives peak and
 * clipping: a mono downmix can exceed full scale where no channel does.
 */
export function analyseSamples(samples, sampleRate, peakSamples = samples) {
  const w = Math.max(1, Math.round(WIN * sampleRate)), wins = Math.floor(samples.length / w);
  const db = new Float64Array(wins);
  let peak = 0, clipped = 0;
  for (const v of peakSamples) { const a = Math.abs(v); if (a > peak) peak = a; if (a >= 0.999) clipped++; }
  for (let k = 0; k < wins; k++) {
    let s = 0;
    for (let i = k * w; i < (k + 1) * w; i++) s += samples[i] * samples[i];
    db[k] = 10 * Math.log10(s / w + 1e-12);
  }
  let last = -1; for (let k = wins - 1; k >= 0; k--) if (db[k] > SILENT_DB) { last = k; break; }
  const musicSeconds = +((last + 1) * WIN).toFixed(2);
  let sound = 0; for (let k = 0; k <= last; k++) if (db[k] > SILENT_DB - 5) sound++;
  // onset envelope: half-wave rectified rise of log energy in ~23 ms hops, over the music part only. The energy is of the
  // first difference of the signal (a high-pass): drums and plucks carry it, sustained bass and pads mostly do not
  const hop = Math.max(1, Math.round(sampleRate * 0.0232)), hops = Math.floor(Math.min(samples.length, (last + 1) * w) / hop);
  const e = new Float64Array(hops);
  for (let k = 0; k < hops; k++) { let s = 0; for (let i = Math.max(1, k * hop); i < (k + 1) * hop; i++) { const d = samples[i] - samples[i - 1]; s += d * d; } e[k] = Math.log10(s / hop + 1e-10); }
  const env = Array.from({ length: Math.max(0, hops - 1) }, (_, k) => Math.max(0, e[k + 1] - e[k]));
  return { seconds: +(samples.length / sampleRate).toFixed(2), musicSeconds, soundShare: last >= 0 ? +(sound / (last + 1)).toFixed(3) : 0,
    peak: +peak.toFixed(4), clippedShare: +(clipped / Math.max(1, samples.length)).toFixed(5), tempo: tempoOf(env, hop / sampleRate) };
}
const wordsOf = s => String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').match(/[a-z][a-z']*/g)?.map(w => w.replace(/'/g, '')).filter(w => w.length >= 2) || [];
/**
 * How much of the lyrics was heard back: the share of the lyric words (as a multiset — a repeated chorus must be sung
 * again to count again) found in the transcript. Pure.
 */
export function lyricRecall(lyrics, segments) {
  const want = wordsOf(lyrics), heard = new Map();
  for (const w of wordsOf((segments || []).map(s => s.text).join(' '))) heard.set(w, (heard.get(w) || 0) + 1);
  if (!want.length) return { recall: null, lyricWords: 0, heardWords: 0, missed: [] };
  let found = 0; const missed = [];
  for (const w of want) { const n = heard.get(w) || 0; if (n > 0) { found++; heard.set(w, n - 1); } else missed.push(w); }
  return { recall: +(found / want.length).toFixed(3), lyricWords: want.length, heardWords: wordsOf((segments || []).map(s => s.text).join(' ')).length, missed: [...new Set(missed)].slice(0, 12) };
}
export const MIN_RECALL = 0.4, GOOD_RECALL = 0.7;

/** Hard problems fail an attempt; notes are kept with the song. `heard`: lyricRecall's result, or { error } when the words could not be checked. */
export function songCheck(a, { seconds, bpm, instrumental = true }, heard = null) {
  const problems = [], notes = [];
  if (!instrumental) {
    if (heard?.recall != null) {
      if (heard.recall < MIN_RECALL) problems.push(`only ${Math.round(heard.recall * 100)} % of the lyrics could be heard sung`);
      else if (heard.recall < GOOD_RECALL) notes.push(`${Math.round(heard.recall * 100)} % of the lyrics were heard back (some words are unclear)`);
    } else notes.push(`the sung words were not checked${heard?.error ? ` (${clip(heard.error, 120)})` : ''}`);
  }
  if (a.musicSeconds < seconds * 0.5) problems.push(`only ${a.musicSeconds} s of music for ${seconds} s asked`);
  else if (a.musicSeconds < seconds * 0.8) notes.push(`${a.musicSeconds} s of music for ${seconds} s asked (the model ended early)`);
  if (a.soundShare < 0.6) problems.push(`mostly silence (${Math.round(a.soundShare * 100)} % of it is sound)`);
  if (a.clippedShare > 0.001) notes.push(`${(a.clippedShare * 100).toFixed(2)} % of samples were at full scale before mastering`);
  if (a.tempo.bpm && bpm && !tempoMatches(bpm, a.tempo.bpm)) notes.push(`the beat measures about ${Math.round(a.tempo.bpm)} BPM; ${bpm} was asked`);
  return { ok: problems.length === 0, problems, notes, tempoMatches: !!(a.tempo.bpm && tempoMatches(bpm, a.tempo.bpm)) };
}

function ffmpeg(args, { stdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', ...args], { windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(stdout ? Buffer.concat(out) : null) : reject(new Error(`ffmpeg: ${clip(Buffer.concat(err).toString().trim(), 300)}`))));
  });
}
export async function analyseFile(path) {
  const rate = 22050;
  // two channels always (a mono file is duplicated); the mono signal for timing is their average, the peak is per channel
  const pcm = await ffmpeg(['-i', path, '-ac', '2', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { stdout: true });
  const both = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + Math.floor(pcm.length / 8) * 8));
  const mono = new Float32Array(both.length / 2);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (both[2 * i] + both[2 * i + 1]);
  return analyseSamples(mono, rate, both);
}

// ── jobs ─────────────────────────────────────────────────────────────────────────────────────────────

const tail = { p: Promise.resolve() };
const setM = (id, f) => { const k = Object.keys(f); db.prepare(`UPDATE music_jobs SET ${k.map(x => `${x} = ?`).join(', ')} WHERE id = ?`).run(...k.map(x => (typeof f[x] === 'object' && f[x] !== null ? JSON.stringify(f[x]) : f[x])), id); };
const parse = s => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
const rowOut = r => r && ({ id: r.id, request: r.request, source: r.source, status: r.status, stage: r.stage, plan: parse(r.plan), file: r.file,
  media: r.file ? `/api/hermes/artifacts/media?kind=audio&id=${encodeURIComponent(r.file)}` : null, check: parse(r.check_result), error: r.error, createdAt: r.created_at, completedAt: r.completed_at });
export const getSong = id => rowOut(db.prepare(`SELECT * FROM music_jobs WHERE id = ?`).get(String(id)));
export const listSongs = (limit = 20) => db.prepare(`SELECT * FROM music_jobs ORDER BY created_at DESC LIMIT ?`).all(Math.min(100, Math.max(1, parseInt(limit, 10) || 20))).map(rowOut);

async function planSong(id, { request, seconds, vocals, tags, lyrics, bpm, keyscale, timesignature, language }) {
  if (tags) {
    // the caller described the sound: no writer, only the checks
    const r = checkSongPlan({ title: request || tags.split(',')[0], tags, bpm, keyscale, timesignature, language, lyrics: lyrics || (vocals ? '' : '[Instrumental]') }, { seconds, vocals, final: true });
    if (!r.ok) throw Object.assign(new Error(r.reason), { status: 400 });
    return { ...r, writer: 'caller', attempts: 0 };
  }
  let r = null, feedback = null, refused = [];
  for (let n = 1; n <= 3 && !r?.ok; n++) {
    setM(id, { stage: `planning the music${n > 1 ? `, attempt ${n}` : ''}` });
    const raw = await chatOllama(songMessages(request, { seconds, vocals, lyrics }, feedback), { format: 'json', temperature: 0.7, maxTokens: 1600, priority: 'goal', label: 'music:plan', timeoutMs: 150_000 });
    r = checkSongPlan(raw, { seconds, vocals, final: n === 3 });
    if (!r.ok) { feedback = r.reason; refused.push(r.reason); }
    else if (lyrics && vocals) r.plan.lyrics = checkSongPlan({ ...r.plan, lyrics }, { seconds, vocals, final: true }).plan?.lyrics || r.plan.lyrics;
    r.attempts = n;
  }
  if (!r?.ok) throw new Error(`no usable plan (${r?.reason})`);
  // the writer may only set the sound and words: explicit numbers from the caller win
  if (bpm) r.plan.bpm = Math.min(220, Math.max(40, parseInt(bpm, 10) || r.plan.bpm));
  if (keyscale && normKey(keyscale)) r.plan.keyscale = normKey(keyscale);
  return { ...r, writer: 'pool', refused };
}

async function runSong(id, opts) {
  const t0 = now();
  setM(id, { status: 'running', stage: 'starting' });
  try {
    const { plan, fixes, writer, attempts, refused } = await planSong(id, opts);
    setM(id, { plan, stage: 'finding a machine' });
    const { worker, why } = await pickWorker('music');
    if (!worker) throw new Error(`no machine can make music now (${why})`);
    const dir = join(CREATIONS, id);
    mkdirSync(dir, { recursive: true });
    let made = null, check = null, analysis = null, heard = null, tries = [];
    for (let n = 1; n <= 2 && !check?.ok; n++) {
      const seed = (opts.seed != null && n === 1) ? opts.seed : Math.floor(Math.random() * 2 ** 31);
      const spec = { tags: plan.tags, lyrics: plan.lyrics, seconds: plan.seconds, bpm: plan.bpm, keyscale: plan.keyscale, timesignature: plan.timesignature, language: plan.language, seed };
      setM(id, { stage: `composing on ${worker.name}${n > 1 ? ' (second try, new seed)' : ''}` });
      const res = await runOnWorker(worker, { id: `${id}-${n}`, kind: 'music', spec, purpose: `music: ${clip(plan.title, 80)}` },
        { outDir: join(dir, `try-${n}`), timeoutMs: 25 * 60_000, onProgress: s => s && setM(id, { stage: `${worker.name}: ${s}` }) });
      const flac = res.outputs.find(o => o.name === 'song.flac');
      if (!flac) throw new Error('the worker returned no song.flac');
      setM(id, { stage: 'listening to it' });
      analysis = await analyseFile(flac.path);
      // the words the worker heard sung (Whisper on its CPU), compared with the lyrics
      const heardFile = res.outputs.find(o => o.name === 'heard.json');
      heard = plan.instrumental ? null : heardFile ? { ...lyricRecall(plan.lyrics, JSON.parse(readFileSync(heardFile.path, 'utf8'))), transcript: JSON.parse(readFileSync(heardFile.path, 'utf8')) }
        : { error: res.receipt?.detail?.heard?.error || 'the worker sent no transcript' };
      check = songCheck(analysis, plan, heard);
      tries.push({ seed, seconds: res.seconds, generateSeconds: res.receipt?.detail?.generateSeconds ?? null, musicSeconds: analysis.musicSeconds, recall: heard?.recall ?? null, problems: check.problems });
      made = { flac: flac.path, sha256: flac.sha256, receipt: res.receipt, seed };
    }
    if (!check.ok) throw Object.assign(new Error(`the music failed its check: ${check.problems.join('; ')}`), { check: { analysis, tries } });
    // master: cut what follows the music, even the loudness out, keep a ceiling under full scale
    setM(id, { stage: 'mastering' });
    mkdirSync(MUSIC_DIR, { recursive: true });
    const name = `${now()}-${id}.mp3`, out = join(MUSIC_DIR, name);
    const length = Math.min(analysis.seconds, analysis.musicSeconds + 0.4);
    await ffmpeg(['-i', made.flac, '-t', length.toFixed(2), '-af', `afade=t=out:st=${Math.max(0, length - 0.4).toFixed(2)}:d=0.4,loudnorm=I=-14:TP=-1.5:LRA=11`, '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '320k', out]);
    copyFileSync(made.flac, join(dir, 'song.flac'));
    const mastered = await analyseFile(out);
    noteMedia(name, 'compose', [`${plan.title} — ${plan.tags}`, { bpm: plan.bpm, key: plan.keyscale, seconds: mastered.seconds, instrumental: plan.instrumental, seed: made.seed, engine: 'ace-step-1.5-turbo', machine: made.receipt?.worker || worker.name }], { source: opts.source });
    const result = { ...check, analysis, heard, mastered: { seconds: mastered.seconds, peak: mastered.peak }, tries, fixes, writer, attempts, refused, machine: worker.name, seconds: +((now() - t0) / 1000).toFixed(1) };
    writeFileSync(join(dir, 'lineage.json'), JSON.stringify({ id, request: opts.request, plan, result, file: name, sha256: made.sha256, madeAt: new Date().toISOString() }, null, 2));
    setM(id, { status: 'completed', stage: 'done', file: name, check_result: result, completed_at: now() });
    emit({ action: 'music_ready', id, file: name, title: plan.title });
  } catch (e) {
    setM(id, { status: 'error', stage: 'failed', error: clip(e.message, 600), check_result: e.check || null, completed_at: now() });
    emit({ action: 'music_failed', id, error: clip(e.message, 200) });
  }
}

/**
 * Start a piece of music. `request` is the sentence; or pass `tags` (and `lyrics`) to skip the writer.
 * `vocals` defaults to what the sentence says (a song, singing, lyrics) or whether lyrics were given.
 */
export function startMusic({ request = '', seconds, vocals, instrumental, tags = '', lyrics = '', bpm, keyscale, timesignature, language, seed, source = 'api' } = {}) {
  const text = clip(request, 800).replace(/\s+/g, ' ').trim();
  if (!text && !tags) throw Object.assign(new Error('say what music to make (request), or describe its sound (tags)'), { status: 400 });
  assertCardBudget();
  const secs = Math.round(Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number(seconds) || secondsAsked(text) || DEFAULT_SECONDS)));
  const voc = instrumental === true ? false : vocals != null ? !!vocals : (!!String(lyrics).trim() || wantsVocals(text));
  const id = `music-${randomUUID().slice(0, 10)}`;
  db.prepare(`INSERT INTO music_jobs (id, request, source, status, stage, created_at) VALUES (?, ?, ?, 'queued', 'queued', ?)`).run(id, text || clip(tags, 300), source, now());
  const opts = { request: text, seconds: secs, vocals: voc, tags: clip(tags, 1200), lyrics: clip(lyrics, 4000), bpm, keyscale, timesignature, language, seed: Number.isInteger(seed) ? seed : null, source };
  const done = tail.p.then(() => withOrigin({ via: id }, () => runSong(id, opts)));
  tail.p = done.catch(e => console.error('[music] queue:', e.message));
  return { id, status: 'queued', seconds: secs, vocals: voc, done };
}

// ── tools and routes ─────────────────────────────────────────────────────────────────────────────────

export function createMusicTools() {
  return [
    { name: 'music.create', group: 'studio', risk: 'safe', ownsReply: true,
      description: 'Compose original music on our own machine (ACE-Step 1.5 on fraymus-home, no paid service): an instrumental (a beat, a score, background music) or a song with lyrics and a voice when the user asks for one. Pass the user\'s words as `request`; `seconds` 10–240 (default from the words, else 60). The music is measured (length, sound, tempo) and mastered before it goes on the shelf. Returns a job id at once; a piece takes about a minute.',
      parameters: { type: 'object', properties: {
        request: { type: 'string', description: "What music to make, in the user's words" },
        seconds: { type: 'number', description: 'Length, 10–240 seconds' },
        instrumental: { type: 'boolean', description: 'true: no voice even if the words mention a song' },
        lyrics: { type: 'string', description: "Optional: the user's own lyrics" } } },
      execute: async ({ args = {} } = {}) => {
        try {
          const r = startMusic({ request: args.request, seconds: args.seconds, instrumental: args.instrumental, lyrics: args.lyrics, source: 'agent' });
          return { jobId: r.id, status: r.status, replyToUser: `I have started ${r.vocals ? 'the song' : 'the music'} (${r.seconds} s${r.vocals ? ', with lyrics and a voice' : ', instrumental'}). It is not finished yet: it is composed on our own card, then measured for length, sound and tempo, and it appears on the shelf only if it passes. Job ${r.id}.` };
        } catch (e) { return { error: clip(e.message, 300), replyToUser: `I did not start the music. ${clip(e.message, 300)}` }; }
      } },
    { name: 'music.status', group: 'studio', risk: 'safe',
      description: 'Progress and result of music started with music.create: stage, the plan (title, tags, tempo, key, lyrics), the measured check and the file on the shelf.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      execute: async ({ args = {} } = {}) => (args.id ? (getSong(args.id) || { error: 'no such music job' }) : { songs: listSongs(5) }) },
  ];
}

export function installMusicRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => (e.status ? res.status(e.status).json({ error: e.message }) : next(e)));
  app.get('/api/music', route((req, res) => res.json({ songs: listSongs(req.query.limit), engine: 'ace-step-1.5-turbo (worker kind music)', seconds: { min: MIN_SECONDS, max: MAX_SECONDS, default: DEFAULT_SECONDS }, keys: KEYS })));
  app.post('/api/music', route((req, res) => { const r = startMusic({ ...(req.body || {}), source: 'api' }); res.status(202).json({ id: r.id, status: r.status, seconds: r.seconds, vocals: r.vocals }); }));
  app.get('/api/music/:id', route((req, res) => { const s = getSong(req.params.id); if (!s) return res.status(404).json({ error: 'no such music job' }); res.json(s); }));
}
