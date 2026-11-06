import { createGzip, createDeflate, constants } from 'node:zlib';
import { createLogger } from '../observability/logger.js';
import { pipeline } from 'node:stream';

const log = createLogger('compression');

const COMPRESSIBLE_TYPES = /^(text\/|application\/json|application\/javascript|application\/xml|image\/svg)/;
const MIN_SIZE = 1024;

let totalCompressed = 0;
let totalOriginal = 0;
let compressedCount = 0;
let skippedCount = 0;

export function compression(opts = {}) {
  const threshold = opts.threshold || MIN_SIZE;
  const level = opts.level || constants.Z_DEFAULT_COMPRESSION;

  return (req, res, next) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding) { skippedCount++; return next(); }

    const origWrite = res.write;
    const origEnd = res.end;
    const chunks = [];
    let ended = false;

    res.write = function (chunk, encoding, cb) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof encoding === 'function') { cb = encoding; }
      if (cb) cb();
      return true;
    };

    res.end = function (chunk, encoding, cb) {
      if (ended) return;
      ended = true;

      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }

      const body = Buffer.concat(chunks);
      const contentType = res.getHeader('content-type') || '';

      if (body.length < threshold || !COMPRESSIBLE_TYPES.test(contentType) || res.getHeader('content-encoding')) {
        skippedCount++;
        res.setHeader('content-length', body.length);
        origWrite.call(res, body);
        origEnd.call(res, null, encoding, cb);
        return;
      }

      const useGzip = acceptEncoding.includes('gzip');
      const useDeflate = !useGzip && acceptEncoding.includes('deflate');

      if (!useGzip && !useDeflate) {
        skippedCount++;
        res.setHeader('content-length', body.length);
        origWrite.call(res, body);
        origEnd.call(res, null, encoding, cb);
        return;
      }

      const compressor = useGzip
        ? createGzip({ level })
        : createDeflate({ level });

      res.removeHeader('content-length');
      res.setHeader('content-encoding', useGzip ? 'gzip' : 'deflate');
      res.setHeader('vary', 'Accept-Encoding');

      const compressed = [];
      compressor.on('data', (chunk) => compressed.push(chunk));
      compressor.on('end', () => {
        const result = Buffer.concat(compressed);
        totalOriginal += body.length;
        totalCompressed += result.length;
        compressedCount++;
        origWrite.call(res, result);
        origEnd.call(res, null, encoding, cb);
      });
      compressor.on('error', (err) => {
        log.error('compression error', { err: err.message });
        skippedCount++;
        res.removeHeader('content-encoding');
        res.setHeader('content-length', body.length);
        origWrite.call(res, body);
        origEnd.call(res, null, encoding, cb);
      });

      compressor.write(body);
      compressor.end();
    };

    next();
  };
}

export function getCompressionStats() {
  const ratio = totalOriginal > 0
    ? Math.round((1 - totalCompressed / totalOriginal) * 1000) / 10
    : 0;
  return {
    compressedCount,
    skippedCount,
    totalOriginalBytes: totalOriginal,
    totalCompressedBytes: totalCompressed,
    savedBytes: totalOriginal - totalCompressed,
    compressionRatio: ratio,
  };
}

export function installCompressionRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/caching/compression', route((_req, res) => {
    res.json(getCompressionStats());
  }));
}
