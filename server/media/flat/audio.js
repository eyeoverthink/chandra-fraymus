/**
 * Flat audio — sound effects made from arithmetic, and the soundtrack assembled sample by sample.
 *
 * No samples are downloaded and no service is called: each effect is a few oscillators and noise shaped by
 * envelopes, with a seeded noise source so the same film always sounds the same. The soundtrack is built
 * here rather than with an ffmpeg filter graph so that the exact time of every line is known — the picture
 * cuts are placed from those times, which is how each picture lands on the words it shows.
 *
 * Pure except for nothing: buffers in, buffers out.
 */
export const RATE = 24000;

function noise(seed) { let a = seed >>> 0 || 1; return () => { a ^= a << 13; a >>>= 0; a ^= a >> 17; a ^= a << 5; a >>>= 0; return a / 2147483648 - 1; }; }
const env = (i, n, attack, release) => { const t = i / n; return Math.min(1, t / attack) * Math.min(1, (1 - t) / release); };

/** name → Float32Array at RATE, peak about 1. */
export function synthSfx(name, seed = 1) {
  const R = RATE, nz = noise(seed * 7919 + 13);
  const make = (secs, fn) => { const n = Math.round(secs * R), out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = fn(i / R, i, n); return out; };
  let lp = 0;
  switch (name) {
    case 'whoosh': return make(0.55, (t, i, n) => { const cut = 0.04 + 0.5 * Math.sin(Math.PI * i / n) ** 2; lp += cut * (nz() - lp); return lp * 2.2 * env(i, n, 0.3, 0.5); });
    case 'pop': return make(0.14, (t, i, n) => Math.sin(2 * Math.PI * (520 - 2400 * t) * t) * env(i, n, 0.03, 0.9));
    case 'ding': return make(0.9, (t, i, n) => (Math.sin(2 * Math.PI * 1318 * t) * 0.6 + Math.sin(2 * Math.PI * 2637 * t) * 0.3 + Math.sin(2 * Math.PI * 3951 * t) * 0.1) * Math.exp(-5 * t) * Math.min(1, i / 60));
    case 'thud': return make(0.32, (t, i, n) => { lp += 0.08 * (nz() - lp); return (Math.sin(2 * Math.PI * (95 - 110 * t) * t) * 0.9 + lp * 0.8) * Math.exp(-13 * t) * Math.min(1, i / 40); });
    case 'boom': return make(1.1, (t, i, n) => { lp += 0.05 * (nz() - lp); return (Math.sin(2 * Math.PI * (70 - 34 * t) * t) + lp * 2.4) * Math.exp(-4.2 * t) * Math.min(1, i / 50); });
    case 'zap': return make(0.4, (t, i, n) => { const fr = 1500 - 2800 * t + 260 * Math.sin(2 * Math.PI * 38 * t); return (Math.sign(Math.sin(2 * Math.PI * fr * t)) * 0.45 + nz() * 0.25) * env(i, n, 0.02, 0.7); });
    case 'tick': return make(0.5, (t, i) => { const k = t % 0.25, j = Math.round(k * R); return Math.sin(2 * Math.PI * 2200 * k) * Math.exp(-90 * k) * Math.min(1, j / 20) * 0.9; });
    case 'sparkle': return make(0.8, (t, i, n) => { const step = Math.floor(t / 0.09), fr = [1568, 2093, 2637, 3136, 2637, 3520, 4186, 3136, 4186][step % 9], k = t - step * 0.09; return Math.sin(2 * Math.PI * fr * k) * Math.exp(-28 * k) * env(i, n, 0.02, 0.4); });
    case 'rumble': return make(1.4, (t, i, n) => { lp += 0.02 * (nz() - lp); return (lp * 5 + Math.sin(2 * Math.PI * 46 * t) * 0.4) * env(i, n, 0.25, 0.45); });
    case 'splash': return make(0.7, (t, i, n) => { const cut = 0.5 * Math.exp(-5 * t) + 0.04; lp += cut * (nz() - lp); return lp * 2.4 * Math.exp(-4 * t) * Math.min(1, i / 80); });
    default: return new Float32Array(0);
  }
}

/** Read a PCM WAV (16-bit; mono or stereo) into mono Float32 at its own rate. */
export function readWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) { const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4); if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }; else if (id === 'data') { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); break; } off += 8 + size + (size % 2); }
  if (!fmt || !data) throw new Error('WAV has no fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`only 16-bit PCM is read here (got format ${fmt.format}, ${fmt.bits} bits)`);
  const frames = Math.floor(data.length / (2 * fmt.channels)), out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let s = 0; for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2); out[i] = s / fmt.channels / 32768; }
  return { samples: out, rate: fmt.rate };
}

export function writeWav(samples, rate = RATE) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

/** Cut the silence off both ends of a spoken line, keeping a short breath of `pad` seconds. */
export function trimSilence(samples, rate = RATE, { threshold = 0.012, pad = 0.03 } = {}) {
  const win = Math.round(rate * 0.01); let a = 0, z = samples.length;
  const loud = i => { let m = 0; for (let k = i; k < Math.min(samples.length, i + win); k++) m = Math.max(m, Math.abs(samples[k])); return m > threshold; };
  while (a < samples.length - win && !loud(a)) a += win;
  while (z > a + win && !loud(z - win)) z -= win;
  const p = Math.round(pad * rate);
  return samples.subarray(Math.max(0, a - p), Math.min(samples.length, z + p));
}

/**
 * Lay the lines end to end with a fixed gap, and the effects underneath at the start of their shots.
 * @param lines  [{ samples: Float32Array }]                 one per shot, in order
 * @param sfx    [{ samples: Float32Array } | null]          one per shot or null
 * @returns {{ mix: Float32Array, starts: number[], ends: number[], seconds: number, longestGap: number }}
 */
export function buildSoundtrack(lines, sfx = [], { rate = RATE, gap = 0.22, lead = 0.25, tail = 0.45, sfxGain = 0.22, voicePeak = 0.89 } = {}) {
  const starts = [], ends = []; let cursor = lead;
  for (const l of lines) { starts.push(cursor); cursor += l.samples.length / rate; ends.push(cursor); cursor += gap; }
  const total = Math.round((cursor - gap + tail) * rate), mix = new Float32Array(total);
  let peak = 0; for (const l of lines) for (let i = 0; i < l.samples.length; i++) peak = Math.max(peak, Math.abs(l.samples[i]));
  const vg = peak > 0 ? voicePeak / peak : 1;
  lines.forEach((l, k) => { const o = Math.round(starts[k] * rate); for (let i = 0; i < l.samples.length && o + i < total; i++) mix[o + i] += l.samples[i] * vg; });
  sfx.forEach((e, k) => { if (!e?.samples?.length || starts[k] == null) return; const o = Math.max(0, Math.round((starts[k] - 0.08) * rate)); for (let i = 0; i < e.samples.length && o + i < total; i++) mix[o + i] += e.samples[i] * sfxGain; });
  for (let i = 0; i < total; i++) { const x = mix[i]; mix[i] = Math.abs(x) > 0.95 ? Math.sign(x) * (0.95 + 0.05 * Math.tanh((Math.abs(x) - 0.95) * 8)) : x; }
  let longestGap = lead; for (let k = 1; k < starts.length; k++) longestGap = Math.max(longestGap, starts[k] - ends[k - 1]);
  return { mix, starts, ends, seconds: total / rate, longestGap };
}

/** The longest stretch quieter than `threshold`, in seconds: a film with a two-second hole feels slow. */
export function longestSilence(samples, rate = RATE, threshold = 0.01) {
  let run = 0, best = 0; const win = Math.round(rate * 0.02);
  for (let i = 0; i < samples.length; i += win) { let m = 0; for (let k = i; k < Math.min(samples.length, i + win); k++) m = Math.max(m, Math.abs(samples[k])); if (m < threshold) { run += win; best = Math.max(best, run); } else run = 0; }
  return best / rate;
}

/** Split a line into caption groups of a few words and give every word a time, in proportion to its length. */
export function captionTimeline(text, start, end, { perGroup = 3, maxChars = 16 } = {}) {
  const ws = String(text || '').trim().split(/\s+/).filter(Boolean); if (!ws.length) return [];
  const weight = w => Math.max(2, w.replace(/[^A-Za-z0-9]/g, '').length) + (/[.,!?;:]$/.test(w) ? 2 : 0);
  const total = ws.reduce((n, w) => n + weight(w), 0); let acc = 0;
  const timed = ws.map(w => { const a = start + (end - start) * acc / total; acc += weight(w); return { word: w, at: a, until: start + (end - start) * acc / total }; });
  const groups = []; let cur = [];
  for (const w of timed) { const len = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length; if (cur.length && (cur.length >= perGroup || len > maxChars)) { groups.push(cur); cur = []; } cur.push(w); }
  if (cur.length) groups.push(cur);
  return groups.map(g => ({ words: g.map(x => x.word), at: g[0].at, until: g[g.length - 1].until, times: g.map(x => x.at) }));
}
