import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { DATA_DIR } from '../config.js';

const execFileAsync = promisify(execFile);

const STT_DIR = join(DATA_DIR, 'stt');
mkdirSync(STT_DIR, { recursive: true });

export { STT_DIR };

function outName() {
  return `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
}

export function listSTTFiles(limit = 50) {
  try {
    return readdirSync(STT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => statSync(join(STT_DIR, b)).mtimeMs - statSync(join(STT_DIR, a)).mtimeMs)
      .slice(0, Math.min(limit, 200))
      .map(f => {
        const s = statSync(join(STT_DIR, f));
        const data = JSON.parse(readFileSync(join(STT_DIR, f), 'utf8'));
        return { name: f, size: s.size, modified: s.mtimeMs, transcript: data.transcript, engine: data.engine, confidence: data.confidence };
      });
  } catch { return []; }
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') {
    if (input.startsWith('data:')) {
      const comma = input.indexOf(',');
      if (comma > -1) return Buffer.from(input.slice(comma + 1), 'base64');
    }
    return Buffer.from(input, 'base64');
  }
  throw new Error('Input must be Buffer, Uint8Array, base64 string, or data URI');
}

function writeTempInput(buf, ext) {
  const p = join(tmpdir(), `chandra-stt-${randomBytes(4).toString('hex')}.${ext}`);
  writeFileSync(p, buf);
  return p;
}
function cleanTemp(p) { try { unlinkSync(p); } catch { /* ok */ } }

async function toWav(inputBuf, inputExt) {
  if (inputExt === 'wav' || inputExt === '.wav') return inputBuf;

  const tmpIn = writeTempInput(inputBuf, inputExt.replace('.', ''));
  const tmpOut = join(tmpdir(), `chandra-stt-${randomBytes(4).toString('hex')}.wav`);

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', tmpIn,
      '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
      tmpOut,
    ], { timeout: 30000, windowsHide: true });
    return readFileSync(tmpOut);
  } finally {
    cleanTemp(tmpIn);
    cleanTemp(tmpOut);
  }
}

// ── Engine Detection ──────────────────────────
async function detectEngine(preferred) {
  if (preferred === 'whisper') {
    try {
      await execFileAsync('python', ['-c', 'import faster_whisper; print("ok")'], { timeout: 10000, windowsHide: true });
      return 'whisper';
    } catch { /* not available */ }
  }

  if (!preferred || preferred === 'sapi') {
    try {
      await execFileAsync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; echo ok'], { timeout: 5000, windowsHide: true });
      return 'sapi';
    } catch { /* not available */ }
  }

  return null;
}

// ── STT Status ────────────────────────────────
export async function sttStatus() {
  const engines = {};

  try {
    const { stdout } = await execFileAsync('python', ['-c', 'import faster_whisper; print(faster_whisper.__version__)'], { timeout: 10000, windowsHide: true });
    engines.whisper = { available: true, quality: 'high', offline: true, version: stdout.trim() };
  } catch { engines.whisper = { available: false }; }

  try {
    await execFileAsync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; echo ok'], { timeout: 5000, windowsHide: true });
    engines.sapi = { available: true, quality: 'basic', offline: true };
  } catch { engines.sapi = { available: false }; }

  let ffmpeg = false;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true });
    ffmpeg = true;
  } catch { /* no ffmpeg for format conversion */ }

  const primary = engines.whisper?.available ? 'whisper' : engines.sapi?.available ? 'sapi' : null;
  return { engines, primary, anyAvailable: !!primary, ffmpegConversion: ffmpeg };
}

// ── Transcribe ───────────────────────────────
export async function sttTranscribe(input, opts = {}) {
  if (!input) throw new Error('audio input is required (Buffer, base64, data URI, or file path)');

  let audioBuf;
  if (typeof input === 'string' && !input.startsWith('data:') && input.length < 500 && /\.(wav|mp3|ogg|m4a|flac|webm)$/i.test(input)) {
    audioBuf = readFileSync(input);
  } else {
    audioBuf = toBuffer(input);
  }

  if (!audioBuf.length) throw new Error('Audio input is empty');
  if (audioBuf.length > 25 * 1024 * 1024) throw new Error('Audio too large (max 25MB)');

  const ext = detectAudioFormat(audioBuf);
  let wavBuf;
  if (ext === 'wav') {
    wavBuf = audioBuf;
  } else {
    try {
      wavBuf = await toWav(audioBuf, ext);
    } catch (e) {
      throw new Error(`Cannot convert ${ext} to WAV: ${e.message}. Install ffmpeg for format conversion.`);
    }
  }

  const preferredEngine = opts.engine;
  const eng = await detectEngine(preferredEngine);
  if (!eng) throw new Error('No STT engine available. Install faster-whisper (pip install faster-whisper) or use Windows with SAPI.');

  const errors = [];
  const cascade = buildCascade(eng);

  for (const attempt of cascade) {
    try {
      if (attempt === 'whisper') {
        return await whisperTranscribe(wavBuf, audioBuf, opts);
      }
      if (attempt === 'sapi') {
        return await sapiTranscribe(wavBuf, audioBuf, opts);
      }
    } catch (e) {
      errors.push(`${attempt}: ${e.message}`);
    }
  }

  throw new Error(`All STT engines failed: ${errors.join('; ')}`);
}

function buildCascade(primary) {
  const all = ['whisper', 'sapi'];
  const order = [primary, ...all.filter(e => e !== primary)];
  return [...new Set(order)];
}

function detectAudioFormat(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'mp3';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  return 'wav';
}

// ── SAPI Speech Recognition ─────────────────
async function sapiTranscribe(wavBuf, originalBuf, opts) {
  const language = opts.language || 'en-US';
  const tmpWav = writeTempInput(wavBuf, 'wav');

  try {
    const escaped = tmpWav.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const script = `
Add-Type -AssemblyName System.Speech
$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5)
$recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(3)
$recognizer.EndSilenceTimeout = [TimeSpan]::FromSeconds(1)
$recognizer.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(1)
$recognizer.SetInputToWaveFile('${escaped}')
$grammar = New-Object System.Speech.Recognition.DictationGrammar
$recognizer.LoadGrammar($grammar)
$result = $recognizer.Recognize([TimeSpan]::FromSeconds(30))
if ($result -ne $null) {
  $out = @{
    transcript = $result.Text
    confidence = [math]::Round($result.Confidence, 4)
    segmentCount = 1
    segments = @(@{ text = $result.Text; confidence = [math]::Round($result.Confidence, 4) })
  }
} else {
  $out = @{ transcript = ''; confidence = 0; segmentCount = 0; segments = @() }
}
$recognizer.Dispose()
ConvertTo-Json -Depth 3 $out -Compress
`.trim();

    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], {
      timeout: 60000, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
    });

    const result = JSON.parse(stdout.trim());
    if (!result.transcript) throw new Error('No speech recognized in audio');

    const name = outName();
    const record = {
      transcript: result.transcript,
      confidence: result.confidence,
      engine: 'sapi',
      language,
      segments: Array.isArray(result.segments) ? result.segments : [],
      audioSize: originalBuf.length,
      timestamp: Date.now(),
    };
    writeFileSync(join(STT_DIR, name), JSON.stringify(record, null, 2));

    return {
      transcript: result.transcript,
      confidence: result.confidence,
      engine: 'sapi',
      language,
      segments: record.segments,
      file: name,
      audioSize: originalBuf.length,
    };
  } finally {
    cleanTemp(tmpWav);
  }
}

// ── Whisper Transcription ────────────────────
async function whisperTranscribe(wavBuf, originalBuf, opts) {
  const language = opts.language || 'en';
  const model = opts.model || 'small.en';
  const tmpWav = writeTempInput(wavBuf, 'wav');

  try {
    const pyScript = `
import json, sys
from faster_whisper import WhisperModel
model = WhisperModel("${model}", device="cpu", compute_type="int8")
segments, info = model.transcribe("${tmpWav.replace(/\\/g, '/')}", language="${language}")
result = {"transcript": "", "segments": [], "confidence": 0}
total_conf = 0
count = 0
for seg in segments:
    result["segments"].append({"text": seg.text.strip(), "start": round(seg.start, 2), "end": round(seg.end, 2), "confidence": round(seg.avg_logprob, 4)})
    result["transcript"] += seg.text
    total_conf += seg.avg_logprob
    count += 1
result["transcript"] = result["transcript"].strip()
result["confidence"] = round(total_conf / count, 4) if count else 0
result["language"] = info.language
print(json.dumps(result))
`.trim();

    const tmpPy = writeTempInput(Buffer.from(pyScript), 'py');

    try {
      const { stdout } = await execFileAsync('python', ['-I', tmpPy], {
        timeout: 120000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      });

      const result = JSON.parse(stdout.trim());
      if (!result.transcript) throw new Error('No speech recognized in audio');

      const name = outName();
      const record = {
        transcript: result.transcript,
        confidence: result.confidence,
        engine: 'whisper',
        model,
        language: result.language || language,
        segments: result.segments || [],
        audioSize: originalBuf.length,
        timestamp: Date.now(),
      };
      writeFileSync(join(STT_DIR, name), JSON.stringify(record, null, 2));

      return {
        transcript: result.transcript,
        confidence: result.confidence,
        engine: 'whisper',
        model,
        language: record.language,
        segments: record.segments,
        file: name,
        audioSize: originalBuf.length,
      };
    } finally {
      cleanTemp(tmpPy);
    }
  } finally {
    cleanTemp(tmpWav);
  }
}
