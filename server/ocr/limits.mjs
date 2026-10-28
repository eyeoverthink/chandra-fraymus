import { createHash } from 'node:crypto';

export const PDF_RENDER_LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxPages: 300, maxPixels: 4_000_000,
  maxEdge: 2600, targetDpi: 150, timeoutMs: 15000, cleanupTimeoutMs: 2000, memoryBytes: 384 * 1024 * 1024,
  maxPngBytes: 4 * 1024 * 1024, maxRequestBytes: 6 * 1024 * 1024, maxResponseBytes: 6 * 1024 * 1024,
  maxActiveCanvasPixels: 8_000_000, maxConcurrent: 2 });
const identity = Object.freeze({ engine: 'pdfjs-canvas', contractVersion: 1, pdfjsVersion: '6.4.299', canvasVersion: '1.0.13',
  targetDpi: 150, maxEdge: 2600, maxPixels: 4_000_000, maxPngBytes: 4194304,
  externalResources: false, scripting: false, xfa: false, annotations: false, wasm: false, systemFonts: false, standardFonts: 'disabled' });
export const PDF_RENDERER_IDENTITY = Object.freeze({ ...identity,
  identityHash: createHash('sha256').update(JSON.stringify(identity)).digest('hex') });

export function validatePdfInput(bytes, page) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > PDF_RENDER_LIMITS.maxBytes) throw new Error('PDF bytes must be 1 byte to 4 MiB.');
  if (Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 5)).toString('ascii') !== '%PDF-') throw new Error('Invalid PDF signature.');
  if (!Number.isSafeInteger(page) || page < 1 || page > PDF_RENDER_LIMITS.maxPages) throw new Error('Select exactly one page from 1 through 300.');
}

export function validatePdfRenderRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).sort().join(',') !== 'dataBase64,page,version' || request.version !== 1
    || typeof request.dataBase64 !== 'string' || !request.dataBase64.length || request.dataBase64.length > Math.ceil(PDF_RENDER_LIMITS.maxBytes / 3) * 4
    || request.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(request.dataBase64)) throw new Error('Exact PDF bytes and one page are required; paths and resource URLs are unsupported.');
  const data = Buffer.from(request.dataBase64, 'base64');
  if (data.toString('base64') !== request.dataBase64) throw new Error('PDF base64 encoding is not canonical.');
  validatePdfInput(data, request.page);
  return { data, page: request.page };
}

export function pdfPageGeometry(width, height) {
  const limits = PDF_RENDER_LIMITS;
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 1e6)) throw new Error('PDF page dimensions are invalid or excessive.');
  let scale = Math.min(limits.targetDpi / 72, limits.maxEdge / Math.max(width, height), Math.sqrt(limits.maxPixels / (width * height)));
  let outputWidth = Math.ceil(width * scale), outputHeight = Math.ceil(height * scale);
  while (outputWidth * outputHeight > limits.maxPixels || Math.max(outputWidth, outputHeight) > limits.maxEdge) {
    scale *= Math.min((limits.maxEdge - 1) / Math.max(outputWidth, outputHeight), Math.sqrt((limits.maxPixels - 2 * limits.maxEdge) / (outputWidth * outputHeight)));
    outputWidth = Math.ceil(width * scale); outputHeight = Math.ceil(height * scale);
  }
  return { width: outputWidth, height: outputHeight, scale, dpi: scale * 72, requestedDpi: limits.targetDpi,
    pixels: outputWidth * outputHeight, downscaled: scale < limits.targetDpi / 72 };
}

export function createPdfRenderPolicy({ createCanvas }) {
  let activePixels = 0, peakCanvasPixels = 0, deniedResourceRequests = 0;
  const limits = PDF_RENDER_LIMITS;
  const dimensions = (width, height, prior = 0) => {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= limits.maxEdge)
      || width * height > limits.maxPixels || activePixels - prior + width * height > limits.maxActiveCanvasPixels) throw new Error('PDF canvas exceeds the bounded edge, page or simultaneous pixel limit.');
    activePixels = activePixels - prior + width * height; peakCanvasPixels = Math.max(peakCanvasPixels, activePixels);
  };
  class CanvasFactory {
    create(width, height) {
      dimensions(width, height);
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    }
    reset(item, width, height) {
      dimensions(width, height, item.canvas.width * item.canvas.height);
      item.canvas.width = width; item.canvas.height = height;
    }
    destroy(item) {
      if (!item.canvas) return;
      activePixels -= item.canvas.width * item.canvas.height;
      item.canvas.width = item.canvas.height = 0; item.canvas = item.context = null;
    }
  }
  const denyFetch = async () => { deniedResourceRequests++; throw new Error('External PDF resources, standard fonts, CMaps and WASM are disabled.'); };
  class BinaryDataFactory { fetch() { return denyFetch(); } }
  return { CanvasFactory, BinaryDataFactory, denyFetch, metrics: () => ({ activePixels, peakCanvasPixels, deniedResourceRequests }) };
}

export async function assertStaticPdfDocument(document) {
  if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > PDF_RENDER_LIMITS.maxPages) throw new Error('PDF exceeds 300 pages or has invalid page metadata.');
  const metadata = await document.getMetadata();
  if (document.isPureXfa || metadata?.info?.IsXFAPresent === true) throw new Error('XFA PDFs are unsupported.');
  if (await document.hasJSActions() || await document.getJSActions()) throw new Error('PDF JavaScript actions are unsupported.');
}

export async function assertStaticPdfPage(page) {
  if (await page.getJSActions()) throw new Error('PDF page JavaScript actions are unsupported.');
}
