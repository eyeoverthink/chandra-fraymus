import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { DATA_DIR } from '../config.js';

const execFileAsync = promisify(execFile);

const TTS_DIR = join(DATA_DIR, 'tts');
mkdirSync(TTS_DIR, { recursive: true });

export { TTS_DIR };

function outName(ext = 'mp3') {
  return `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
}

function savePath(name) { return join(TTS_DIR, name); }

export function ttsUrl(name) { return `/tts/${name}`; }

export function listTTSFiles(limit = 50) {
  try {
    return readdirSync(TTS_DIR)
      .filter(f => /\.(mp3|wav|ogg)$/i.test(f))
      .sort((a, b) => statSync(join(TTS_DIR, b)).mtimeMs - statSync(join(TTS_DIR, a)).mtimeMs)
      .slice(0, Math.min(limit, 200))
      .map(f => {
        const s = statSync(join(TTS_DIR, f));
        return { name: f, size: s.size, url: ttsUrl(f), modified: s.mtimeMs };
      });
  } catch { return []; }
}

// ── Engine Detection ──────────────────────────
async function detectEngine(preferred) {
  if (preferred === 'piper') {
    try {
      await execFileAsync('piper', ['--version'], { timeout: 5000, windowsHide: true });
      return 'piper';
    } catch { /* not available */ }
  }

  if (!preferred || preferred === 'edge-tts') {
    try {
      await execFileAsync('edge-tts', ['--list-voices'], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
      return 'edge-tts';
    } catch {
      try {
        await execFileAsync('python', ['-m', 'edge_tts', '--list-voices'], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
        return 'edge-tts-py';
      } catch { /* not available */ }
    }
  }

  if (!preferred || preferred === 'sapi') {
    try {
      await execFileAsync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; echo ok'], { timeout: 5000, windowsHide: true });
      return 'sapi';
    } catch { /* not available */ }
  }

  return null;
}

// ── TTS Status ────────────────────────────────
export async function ttsStatus() {
  const engines = {};

  try {
    await execFileAsync('piper', ['--version'], { timeout: 5000, windowsHide: true });
    engines.piper = { available: true, quality: 'high', offline: true };
  } catch { engines.piper = { available: false }; }

  try {
    const { stdout } = await execFileAsync('edge-tts', ['--list-voices'], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
    engines.edgeTts = { available: true, quality: 'high', offline: false, voiceCount: stdout.split('\n').filter(l => l.startsWith('Name:')).length };
  } catch {
    try {
      const { stdout } = await execFileAsync('python', ['-m', 'edge_tts', '--list-voices'], { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
      engines.edgeTts = { available: true, quality: 'high', offline: false, mode: 'python-module', voiceCount: stdout.split('\n').filter(l => l.startsWith('Name:')).length };
    } catch { engines.edgeTts = { available: false }; }
  }

  try {
    await execFileAsync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; echo ok'], { timeout: 5000, windowsHide: true });
    engines.sapi = { available: true, quality: 'basic', offline: true };
  } catch { engines.sapi = { available: false }; }

  const primary = engines.piper?.available ? 'piper' : engines.edgeTts?.available ? 'edge-tts' : engines.sapi?.available ? 'sapi' : null;
  return { engines, primary, anyAvailable: !!primary };
}

// ── List Voices ───────────────────────────────
export async function ttsVoices(engine) {
  const eng = engine || (await detectEngine());
  if (!eng) return { voices: [], engine: null, error: 'No TTS engine available' };

  if (eng === 'edge-tts' || eng === 'edge-tts-py') {
    try {
      const cmd = eng === 'edge-tts' ? ['edge-tts', ['--list-voices']] : ['python', ['-m', 'edge_tts', '--list-voices']];
      const { stdout } = await execFileAsync(cmd[0], cmd[1], { timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      const voices = [];
      let current = {};
      for (const line of stdout.split('\n')) {
        if (line.startsWith('Name:')) {
          if (current.name) voices.push(current);
          current = { name: line.replace('Name: ', '').trim() };
        } else if (line.startsWith('Gender:')) {
          current.gender = line.replace('Gender: ', '').trim();
        } else if (line.startsWith('Locale:')) {
          current.locale = line.replace('Locale: ', '').trim();
        }
      }
      if (current.name) voices.push(current);
      return { voices, engine: 'edge-tts', count: voices.length };
    } catch (e) { return { voices: [], engine: 'edge-tts', error: e.message }; }
  }

  if (eng === 'sapi') {
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Gender + "|" + $_.VoiceInfo.Culture.Name }',
      ], { timeout: 10000, windowsHide: true });
      const voices = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [name, gender, locale] = line.trim().split('|');
        return { name, gender, locale };
      });
      return { voices, engine: 'sapi', count: voices.length };
    } catch (e) { return { voices: [], engine: 'sapi', error: e.message }; }
  }

  return { voices: [], engine: eng, error: 'Voice listing not supported for this engine' };
}

// ── Generate Speech ───────────────────────────
export async function ttsSpeak(text, opts = {}) {
  if (!text || typeof text !== 'string') throw new Error('text is required');
  const cleanText = text.slice(0, 5000);

  const preferredEngine = opts.engine;
  const eng = await detectEngine(preferredEngine);
  if (!eng) throw new Error('No TTS engine available. Install edge-tts (pip install edge-tts) or Piper.');

  const errors = [];
  const cascade = buildCascade(eng);

  for (const attempt of cascade) {
    try {
      if (attempt === 'edge-tts' || attempt === 'edge-tts-py') {
        return await edgeTtsSpeak(cleanText, opts, attempt);
      }
      if (attempt === 'piper') {
        return await piperSpeak(cleanText, opts);
      }
      if (attempt === 'sapi') {
        return await sapiSpeak(cleanText, opts);
      }
    } catch (e) {
      errors.push(`${attempt}: ${e.message}`);
    }
  }

  throw new Error(`All TTS engines failed: ${errors.join('; ')}`);
}

function buildCascade(primary) {
  const all = ['piper', 'edge-tts', 'edge-tts-py', 'sapi'];
  const order = [primary, ...all.filter(e => e !== primary)];
  return [...new Set(order)];
}

// ── edge-tts Engine ───────────────────────────
async function edgeTtsSpeak(text, opts, mode) {
  const voice = opts.voice || 'en-US-AriaNeural';
  const rate = opts.rate || '+0%';
  const pitch = opts.pitch || '+0Hz';
  const name = outName('mp3');
  const out = savePath(name);

  const args = mode === 'edge-tts'
    ? ['--voice', voice, '--rate', rate, '--pitch', pitch, '--text', text, '--write-media', out]
    : ['-m', 'edge_tts', '--voice', voice, '--rate', rate, '--pitch', pitch, '--text', text, '--write-media', out];
  const cmd = mode === 'edge-tts' ? 'edge-tts' : 'python';

  await execFileAsync(cmd, args, { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const s = statSync(out);
  return {
    url: ttsUrl(name), path: out, size: s.size, format: 'mp3',
    engine: 'edge-tts', voice, rate, pitch,
    durationEstimate: Math.round(text.length / 15),
  };
}

// ── Piper Engine ──────────────────────────────
async function piperSpeak(text, opts) {
  const model = opts.model || 'en_US-amy-medium';
  const name = outName('wav');
  const out = savePath(name);
  const tmpInput = join(tmpdir(), `chandra-tts-${randomBytes(4).toString('hex')}.txt`);
  writeFileSync(tmpInput, text);

  try {
    await execFileAsync('piper', [
      '--model', model, '--output_file', out,
    ], { timeout: 60000, windowsHide: true, input: text });
    const s = statSync(out);
    return {
      url: ttsUrl(name), path: out, size: s.size, format: 'wav',
      engine: 'piper', model,
      durationEstimate: Math.round(text.length / 15),
    };
  } finally { try { unlinkSync(tmpInput); } catch { /* ok */ } }
}

// ── Windows SAPI Engine ───────────────────────
async function sapiSpeak(text, opts) {
  const voice = opts.voice || '';
  const rate = opts.rate != null ? parseInt(opts.rate) : 0;
  const name = outName('wav');
  const out = savePath(name);
  const escaped = text.replace(/'/g, "''").replace(/`/g, '``');

  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voice ? `$synth.SelectVoice('${voice.replace(/'/g, "''")}')` : ''}
$synth.Rate = ${Math.max(-10, Math.min(10, rate))}
$synth.SetOutputToWaveFile('${out.replace(/\\/g, '\\\\')}')
$synth.Speak('${escaped}')
$synth.Dispose()
`.trim();

  await execFileAsync('powershell', ['-NoProfile', '-Command', script], {
    timeout: 60000, windowsHide: true,
  });
  const s = statSync(out);
  return {
    url: ttsUrl(name), path: out, size: s.size, format: 'wav',
    engine: 'sapi', voice: voice || 'default',
    durationEstimate: Math.round(text.length / 15),
  };
}
