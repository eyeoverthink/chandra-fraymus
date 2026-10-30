import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { DATA_DIR } from '../config.js';

const OCR_DIR = join(DATA_DIR, 'ocr');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const HELPER = join(import.meta.dirname, '..', 'ocr', 'windows-ocr.ps1');
const sha = value => createHash('sha256').update(value).digest('hex');

function detectMimeType(buf) {
  if (buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return null;
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input !== 'string') throw new Error('Input must be Buffer, base64 string, data URI, or file path');
  if (input.startsWith('data:')) {
    const comma = input.indexOf(',');
    if (comma < 0) throw new Error('Invalid data URI');
    return Buffer.from(input.slice(comma + 1), 'base64');
  }
  if (/^[A-Za-z0-9+/]+=*$/.test(input) && input.length > 100) {
    return Buffer.from(input, 'base64');
  }
  throw new Error('Input must be Buffer, base64 string, or data URI');
}

function runOcrHelper(requestJson) {
  return new Promise((resolve, reject) => {
    const child = spawn(PS, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('OCR timed out after 30s'));
    }, 30_000);

    child.stdout.on('data', d => { stdout += d; if (stdout.length > 512_000) child.kill(); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 64_000) child.kill(); });
    child.on('close', () => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        reject(new Error(`OCR helper returned no output. stderr: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch {
        reject(new Error(`OCR helper returned invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdin.write(requestJson);
    child.stdin.end();
  });
}

export async function ocrRecognize(input, opts = {}) {
  const buf = toBuffer(input);
  if (!buf.length || buf.length > 4 * 1024 * 1024) {
    throw new Error('Image must be 1 byte to 4 MiB');
  }
  const mimeType = opts.mimeType || detectMimeType(buf);
  if (!mimeType || !['image/png', 'image/jpeg'].includes(mimeType)) {
    throw new Error('OCR requires PNG or JPEG input');
  }
  const language = opts.language || 'en-US';
  if (language !== 'en-US') {
    throw new Error('Only en-US language is currently supported');
  }

  const imageBase64 = buf.toString('base64');
  const request = JSON.stringify({ action: 'recognize', imageBase64, mimeType, language });
  const result = await runOcrHelper(request);

  if (!result.ok) {
    throw new Error(result.detail || result.code || 'OCR recognition failed');
  }

  const output = {
    text: result.text || '',
    lines: (result.lines || []).map(l => typeof l === 'string' ? l : l.text),
    wordCount: result.wordCount || 0,
    engine: 'windows-media-ocr',
    language,
    imageSha256: result.imageSha256 || sha(buf),
    dimensions: { width: result.width || 0, height: result.height || 0 },
  };

  await mkdir(OCR_DIR, { recursive: true });
  const filename = `${Date.now()}-${sha(buf).slice(0, 8)}.json`;
  await writeFile(join(OCR_DIR, filename), JSON.stringify(output, null, 2));
  return { ...output, file: filename };
}

export async function ocrFromFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
  const mimeType = mimeMap[ext];
  if (!mimeType) throw new Error('OCR requires PNG or JPEG file');
  const buf = await readFile(filePath);
  return ocrRecognize(buf, { mimeType });
}

export async function ocrStatus() {
  try {
    const request = JSON.stringify({ action: 'health' });
    const result = await runOcrHelper(request);
    return {
      available: result.available === true,
      engine: 'windows-media-ocr',
      languages: result.languages || [],
      maxImageDimension: result.maxImageDimension,
      platform: process.platform,
    };
  } catch (e) {
    return {
      available: false,
      engine: 'windows-media-ocr',
      reason: e.message,
      platform: process.platform,
    };
  }
}

export async function listOCRFiles(limit = 50) {
  try {
    const files = await readdir(OCR_DIR);
    return files
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, Math.min(limit, 200));
  } catch {
    return [];
  }
}

export async function getOCRResult(filename) {
  const safe = basename(filename);
  if (!safe.endsWith('.json')) throw new Error('Invalid OCR result filename');
  const data = await readFile(join(OCR_DIR, safe), 'utf8');
  return JSON.parse(data);
}
