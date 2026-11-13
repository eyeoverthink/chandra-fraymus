/**
 * Flat render — recorded lines + a checked shot list become a film, and the film is measured.
 *
 * Order of work: the voice first, then the picture. Each line's exact start in the soundtrack is known
 * (audio.js lays the lines out itself), so each shot is cut in a tenth of a second before its line begins.
 * Frames are SVG drawn by Skia (@napi-rs/canvas, about 30 ms a frame on a CPU core — no graphics card, so a
 * film never waits for the GPU lease) and piped raw into ffmpeg, which also brings the sound to −14 LUFS,
 * the level short-video platforms normalise to.
 *
 * `checkFilm` then verifies by measurement what a person would otherwise have to watch for.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FORMATS, LAYOUT } from './kit.js';
import { shotSvg, layoutOf } from './scene.js';
import { RATE, readWav, writeWav, trimSilence, buildSoundtrack, synthSfx, longestSilence, captionTimeline } from './audio.js';
import { FLAT_PACE } from './plan.js';

const execFileAsync = promisify(execFile);
export const FPS = 30;
const CUT_LEAD = 0.1;   // a picture arrives this long before the words it shows

/** Where each shot starts and ends, and what the caption shows when. Pure. */
export function buildTimeline(shots, track) {
  const cuts = track.starts.map((s, k) => (k === 0 ? 0 : Math.max(track.ends[k - 1], s - CUT_LEAD)));
  const spans = shots.map((sh, k) => ({ from: cuts[k], to: k + 1 < cuts.length ? cuts[k + 1] : track.seconds, lineStart: track.starts[k], lineEnd: track.ends[k] }));
  const captions = shots.flatMap((sh, k) => captionTimeline(sh.say, track.starts[k], track.ends[k], { perGroup: 3, maxChars: 16 }).map(g => ({ ...g, shot: k })));
  return { cuts, spans, captions, seconds: track.seconds };
}

/** A 16×9 luminance thumbprint of a frame, cheap enough to take from every frame that is rendered. */
function signature(data, w, h) {
  const gx = 16, gy = 9, out = new Float32Array(gx * gy);
  for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) { const px = Math.floor((x + 0.5) * w / gx), py = Math.floor((y + 0.5) * h / gy), i = (py * w + px) * 4; out[y * gx + x] = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2]; }
  return out;
}
const sigDiff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
const sigSpread = a => { let mn = 255, mx = 0; for (const v of a) { mn = Math.min(mn, v); mx = Math.max(mx, v); } return mx - mn; };

/**
 * Render the film.
 * @param shots     checked shots from plan.js
 * @param lineWavs  one WAV file per shot (any 16-bit PCM rate; resampled by the caller to 24 kHz mono)
 * @returns {{ file, seconds, frames, renderSeconds, timeline, audio: {seconds, longestGap, longestSilence}, signatures }}
 */
export async function renderFlatFilm({ shots, lineWavs, format = '16:9', outPath, workDir, fps = FPS, onProgress = null, isCancelled = () => false, figures = 'flat' }) {
  const [w, h] = FORMATS[format] || FORMATS['16:9'];
  const lines = lineWavs.map((p, k) => { const { samples, rate } = readWav(readFileSync(p)); if (rate !== RATE) throw new Error(`line ${k + 1} is ${rate} Hz; the soundtrack is built at ${RATE}`); return { samples: trimSilence(samples, rate) }; });
  if (lines.length !== shots.length) throw new Error(`${lines.length} recorded lines for ${shots.length} shots`);
  const sfx = shots.map((s, k) => (s.sfx && s.sfx !== 'none' ? { samples: synthSfx(s.sfx, k + 1) } : null));
  const track = buildSoundtrack(lines, sfx, { gap: FLAT_PACE.gap });
  const audioPath = join(workDir, 'soundtrack.wav');
  writeFileSync(audioPath, writeWav(track.mix));
  const tl = buildTimeline(shots, track);
  const total = Math.ceil(tl.seconds * fps);
  const t0 = Date.now();

  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0', '-i', audioPath,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-shortest', outPath], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = ''; ff.stderr.on('data', d => { ffErr = (ffErr + d).slice(-2000); });
  const done = new Promise((res, rej) => { ff.on('error', rej); ff.on('close', code => (code === 0 ? res() : rej(new Error(`ffmpeg ended with code ${code}: ${ffErr.trim().slice(-300)}`)))); });
  ff.stdin.on('error', () => { /* reported through the close code */ });

  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  const sigs = shots.map(() => ({ first: null, mid: null, last: null }));
  let k = 0, ci = 0;
  try {
    for (let n = 0; n < total; n++) {
      if (isCancelled()) throw new Error('cancelled');
      const t = n / fps;
      while (k + 1 < tl.spans.length && t >= tl.spans[k + 1].from) k++;
      while (ci + 1 < tl.captions.length && t >= tl.captions[ci + 1].at) ci++;
      const cap = tl.captions[ci], span = tl.spans[k];
      const showing = cap && t >= cap.at - 0.02 && t <= cap.until + 0.18;
      let hot = -1; if (showing) for (let i = 0; i < cap.times.length; i++) if (t >= cap.times[i]) hot = i;
      const svg = shotSvg(shots[k], t - span.from, { format, dur: span.to - span.from, caption: showing ? { words: cap.words, hot } : null, figures });
      const img = await loadImage(Buffer.from(svg));
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const local = t - span.from, len = span.to - span.from, s = sigs[k];
      if (!s.first && local >= Math.min(0.2, len * 0.3)) s.first = signature(data, w, h);
      if (!s.mid && local >= len * 0.55) s.mid = signature(data, w, h);
      if (local >= len - 2.5 / fps) s.last = signature(data, w, h);
      if (!ff.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) await new Promise(r => ff.stdin.once('drain', r));
      if (onProgress && n % 15 === 0) onProgress(n / total, k);
    }
    ff.stdin.end();
    await done;
  } catch (e) { try { ff.kill(); } catch (_) { /* already gone */ } throw e; }
  if (!existsSync(outPath) || statSync(outPath).size < 10_000) throw new Error('ffmpeg wrote no film');
  return { file: outPath, seconds: tl.seconds, frames: total, fps, width: w, height: h, renderSeconds: +((Date.now() - t0) / 1000).toFixed(1), timeline: tl,
    audio: { seconds: track.seconds, longestGap: +track.longestGap.toFixed(2), longestSilence: +longestSilence(track.mix).toFixed(2), path: audioPath }, signatures: sigs };
}

/**
 * Measure the finished film against what was planned. Every check is a number, not a judgement.
 * `hard` failures mean the film is not kept.
 */
export async function checkFilm({ shots, format, render }) {
  const out = [], add = (name, ok, detail, hard = true) => out.push({ name, ok: !!ok, detail, hard });
  let probed = null;
  try { const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', render.file], { timeout: 30_000, windowsHide: true }); probed = JSON.parse(stdout); } catch (e) { add('the file opens', false, e.message.slice(0, 120)); }
  if (probed) {
    const dur = Number(probed.format?.duration), v = (probed.streams || []).find(s => s.codec_type === 'video'), a = (probed.streams || []).find(s => s.codec_type === 'audio');
    add('the file opens', !!v && !!a, `${v ? `${v.width}x${v.height} video` : 'no video'}, ${a ? 'sound' : 'no sound'}`);
    add('length matches the soundtrack', Math.abs(dur - render.seconds) <= 0.35, `${dur.toFixed(2)} s on disk, ${render.seconds.toFixed(2)} s planned`);
    const [w, h] = FORMATS[format]; add('shape is what was asked', v && v.width === w && v.height === h, `${format}`);
  }
  const tl = render.timeline, sig = render.signatures;
  const flat = sig.findIndex(s => !s.mid || sigSpread(s.mid) < 12);
  add('no shot is blank', flat < 0, flat < 0 ? `${sig.length} shots drawn` : `shot ${flat + 1} is a flat colour`);
  const still = sig.findIndex(s => !s.first || !s.last || sigDiff(s.first, s.last) < 0.15);
  add('every shot moves', still < 0, still < 0 ? 'first and last frame differ in every shot' : `shot ${still + 1} does not move`);
  let same = -1; for (let i = 1; i < sig.length; i++) if (sig[i].mid && sig[i - 1].mid && sigDiff(sig[i].mid, sig[i - 1].mid) < 0.4) { same = i; break; }
  add('each cut changes the picture', same < 0, same < 0 ? 'neighbouring shots differ' : `shots ${same} and ${same + 1} look the same`, false);
  const offs = tl.spans.slice(1).map(s => s.lineStart - s.from), worst = offs.length ? Math.max(...offs.map(Math.abs)) : 0;
  add('each picture lands on its words', worst <= 0.25, `${offs.filter(o => Math.abs(o) <= 0.25).length} of ${offs.length} cuts within a quarter second of the line (worst ${worst.toFixed(2)} s)`);
  add('no long silence', render.audio.longestSilence <= 1.0, `longest quiet stretch ${render.audio.longestSilence} s`);
  const said = shots.map(s => s.say.split(/\s+/).filter(Boolean).join(' ')).join(' '), shown = tl.captions.map(c => c.words.join(' ')).join(' ');
  add('captions carry every word', said === shown, said === shown ? `${shown.split(' ').length} words in ${tl.captions.length} captions` : 'caption text differs from the narration');
  const L = LAYOUT[format], hpx = FORMATS[format][1], capTop = hpx * L.caption - hpx * 0.075;
  const low = shots.findIndex(s => layoutOf(s, format).cast.some(c => c.faceBottom > capTop));
  add('faces sit above the captions', low < 0, low < 0 ? 'every face clears the caption line' : `a face in shot ${low + 1} reaches the captions`, false);
  const short = tl.spans.findIndex(s => s.to - s.from < 0.8);
  add('no shot is a flash', short < 0, short < 0 ? `shots run ${Math.min(...tl.spans.map(s => s.to - s.from)).toFixed(1)}–${Math.max(...tl.spans.map(s => s.to - s.from)).toFixed(1)} s` : `shot ${short + 1} lasts under 0.8 s`, false);
  return { passed: out.every(c => c.ok || !c.hard), checks: out };
}
