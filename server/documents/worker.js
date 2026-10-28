import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';
import { crc32 } from '../transport/rgba.js';
import { allowedRelative } from '../agent/workspace.js';
import { validateZipFraming } from './zip-framing.js';

const { mimeType, limits } = workerData;
const data = Buffer.from(workerData.data);
const decoder = new TextDecoder('utf-8', { fatal: true });
const textExtensions = new Set(['.txt','.md','.markdown','.json','.js','.mjs','.cjs','.jsx','.ts','.tsx','.html','.htm','.css','.scss','.py','.java','.c','.h','.cpp','.hpp','.rs','.go','.rb','.sh','.ps1','.cmd','.bat','.xml','.svg','.csv','.tsv','.yaml','.yml','.toml','.ini','.cfg','.sql','.gradle','.kt','.swift','.vue','.svelte','.gitignore','.gitattributes','.editorconfig']);
function indexBuilder(kind) {
  let text = '', bytes = 0;
  const spans = [];
  return { spans, get text() { return text; }, add(value, reference) {
    const block = (text ? '\n\n' : '') + value;
    bytes += Buffer.byteLength(block);
    if (bytes > limits.maxTextBytes) throw new Error('Extracted document text exceeds 2 MiB; split the document');
    const start = text.length + (text ? 2 : 0);
    text += block;
    const span = { ...reference, start, end: text.length };
    spans.push(span);
    return span;
  }, result(extra) { return { version: 1, kind, text, spans, ...extra }; } };
}

async function pdf() {
  if (data.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Invalid PDF signature');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let deniedResourceRequests = 0;
  const denyResource = class { async fetch() { deniedResourceRequests++; throw new Error('External PDF resources are disabled'); } };
  const task = getDocument({ data: new Uint8Array(data), verbosity: 0, useWorkerFetch: false, useWasm: false,
    disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: true,
    BinaryDataFactory: denyResource });
  try {
    const document = await task.promise;
    if (document.numPages > limits.maxPages) throw new Error('PDF exceeds 300 pages; split the document');
    const index = indexBuilder('pdf'), imageOnlyPages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const stream = page.streamTextContent().getReader();
      const chunks = [];
      let pageBytes = 0;
      try {
        while (true) {
          const { done, value } = await stream.read();
          if (done) break;
          for (const item of value.items) if (typeof item.str === 'string') {
            const value = item.str + (item.hasEOL ? '\n' : ' ');
            pageBytes += Buffer.byteLength(value);
            if (pageBytes > 256 * 1024) throw new Error('PDF page text exceeds 256 KiB');
            chunks.push(value);
          }
        }
      } finally { await stream.cancel().catch(() => {}); stream.releaseLock(); page.cleanup(); }
      const content = chunks.join('').trim();
      if (!content) imageOnlyPages.push(number);
      index.add(content, { page: number });
    }
    return index.result({ pages: document.numPages, imageOnlyPages, deniedResourceRequests,
      warnings: ['Text extraction only: images, handwriting and page layout have not been visually inspected; no OCR is performed.',
        ...(imageOnlyPages.length ? [`${imageOnlyPages.length} pages have no extractable text.`] : [])] });
  } finally { await task.destroy(); }
}

function openZip() {
  return new Promise((resolve, reject) => yauzl.fromBuffer(data, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}
async function zipDocument() {
  if (data.length < 4 || ![0x04034b50, 0x06054b50].includes(data.readUInt32LE(0))) throw new Error('Invalid ZIP signature');
  validateZipFraming(data, limits.maxEntries);
  const zip = await openZip(), index = indexBuilder('zip'), entries = [], seen = new Set();
  let expanded = 0;
  try {
    if (zip.entryCount > limits.maxEntries) throw new Error('ZIP exceeds 500 entries');
    await new Promise((resolve, reject) => {
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          if (entries.length >= limits.maxEntries || entry.fileName.length > 512) throw new Error('ZIP entry count or name limit exceeded');
          const directory = entry.fileName.endsWith('/');
          const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
          if (!name || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe ZIP entry path');
          const normalized = name.normalize('NFC').toLowerCase();
          if (seen.has(normalized)) throw new Error('Duplicate or ambiguous ZIP entry path');
          seen.add(normalized);
          const mode = entry.externalFileAttributes >>> 16;
          if ((mode & 0xf000) === 0xa000) throw new Error('ZIP symbolic links are unsupported');
          if (entry.generalPurposeBitFlag & 1) throw new Error('Encrypted ZIP entries are unsupported');
          if (![0, 8].includes(entry.compressionMethod)) throw new Error('Unsupported ZIP compression method');
          expanded += entry.uncompressedSize;
          if (entry.uncompressedSize > limits.maxEntryBytes || expanded > limits.maxExpandedBytes) throw new Error('ZIP expanded size exceeds 4 MiB per entry or 16 MiB total');
          if (entry.uncompressedSize > Math.max(1024, entry.compressedSize * limits.maxCompressionRatio)) throw new Error('ZIP compression ratio exceeds 200:1');
          const record = { name: entry.fileName, size: entry.uncompressedSize, compressedSize: entry.compressedSize, status: directory ? 'directory' : 'binary' };
          entries.push(record);
          if (directory) {
            if (entry.uncompressedSize !== 0) throw new Error('ZIP directory contains data');
          } else {
            const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, entry.compressionMethod === 8 ? { decompress: false } : {}, (error, stream) => error ? reject(error) : resolve(stream)));
            const chunks = []; let size = 0;
            for await (const chunk of stream) {
              size += chunk.length;
              if (size > entry.compressedSize || size > limits.maxBytes) { stream.destroy(); throw new Error('ZIP compressed entry exceeds its declared size'); }
              chunks.push(chunk);
            }
            const compressed = Buffer.concat(chunks);
            if (size !== entry.compressedSize) throw new Error('ZIP compressed entry is truncated');
            const inflated = entry.compressionMethod === 8 ? inflateRawSync(compressed, { info: true, maxOutputLength: Math.max(1, Math.min(limits.maxEntryBytes, entry.uncompressedSize + 1)) }) : null;
            if (inflated && inflated.engine.bytesWritten !== entry.compressedSize) throw new Error('ZIP deflate stream contains unconsumed trailing bytes');
            const bytes = inflated ? inflated.buffer : compressed;
            if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) throw new Error('ZIP entry integrity failure (size or CRC)');
            record.sha256 = createHash('sha256').update(bytes).digest('hex');
            let permitted = true;
            try { allowedRelative(name); } catch { permitted = false; }
            const base = name.split('/').at(-1);
            if (!permitted) record.status = 'protected';
            else if (textExtensions.has(extname(name).toLowerCase()) || textExtensions.has(base.toLowerCase()) || !extname(base)) {
              let text;
              try { text = decoder.decode(bytes); } catch { /* Binary UTF-8 failures remain listed, without exposing bytes. */ }
              if (text !== undefined && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
                record.status = 'text';
                const span = index.add(text, { entry: entry.fileName });
                record.textChars = text.length;
                record.start = span.start; record.end = span.end;
              }
            }
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    return index.result({ entries, expandedBytes: expanded, integrity: 'all-file-crcs-verified',
      warnings: ['Archive members were checked in memory, never extracted or executed. Binary, nested archive/PDF and protected credential files are listed without text extraction.'] });
  } finally { zip.close(); }
}

try {
  const document = await (mimeType === 'application/pdf' ? pdf() : zipDocument());
  parentPort.postMessage({ ok: true, document });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.name === 'PasswordException' ? 'Password-protected PDFs are unsupported' : String(error.message || 'Invalid document').slice(0, 300) });
}
