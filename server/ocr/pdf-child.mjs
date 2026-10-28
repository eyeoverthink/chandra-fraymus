// Trusted fixed bootstrap: the unchanged Windows launcher assigns this process
// to its verified 384MiB Job before reading bytes or importing PDF.js.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PDF_RENDER_LIMITS as LIMITS, PDF_RENDERER_IDENTITY, pdfPageGeometry, validatePdfRenderRequest,
  createPdfRenderPolicy, assertStaticPdfDocument, assertStaticPdfPage } from './limits.mjs';

const requireInstalled = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const warnings = [];
const note = (...values) => { if (warnings.length < 12) warnings.push(values.map(value => String(value)).join(' ').slice(0, 240)); };
console.log = console.info = console.warn = console.error = note;
let task, page, rootCanvas, canvasApi, response;
const policy = createPdfRenderPolicy({ createCanvas: (width, height) => canvasApi.createCanvas(width, height) });
globalThis.fetch = policy.denyFetch;
try {
  const chunks = []; let inputSize = 0;
  for await (const chunk of process.stdin) {
    inputSize += chunk.length;
    if (inputSize > LIMITS.maxRequestBytes) throw new Error('PDF render request exceeds 6 MiB.');
    chunks.push(chunk);
  }
  const { data, page: pageNumber } = validatePdfRenderRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const sourceSha256 = hash(data);
  canvasApi = requireInstalled('@napi-rs/canvas');
  const { getDocument, AnnotationMode, version } = await import(pathToFileURL(requireInstalled.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  if (version !== PDF_RENDERER_IDENTITY.pdfjsVersion || requireInstalled('@napi-rs/canvas/package.json').version !== PDF_RENDERER_IDENTITY.canvasVersion) throw new Error('Installed PDF renderer versions differ from the verified renderer identity.');
  task = getDocument({ data: new Uint8Array(data), verbosity: 0, useWorkerFetch: false, useWasm: false,
    isEvalSupported: false, enableXfa: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: true,
    disableRange: true, disableStream: true, disableAutoFetch: true, isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false, maxImageSize: LIMITS.maxPixels, canvasMaxAreaInBytes: LIMITS.maxPixels * 4,
    CanvasFactory: policy.CanvasFactory, BinaryDataFactory: policy.BinaryDataFactory });
  const document = await task.promise;
  await assertStaticPdfDocument(document);
  if (pageNumber > document.numPages) throw new Error('Selected page is outside this PDF.');
  page = await document.getPage(pageNumber);
  await assertStaticPdfPage(page);
  const baseViewport = page.getViewport({ scale: 1 }), geometry = pdfPageGeometry(baseViewport.width, baseViewport.height);
  const factory = new policy.CanvasFactory(); rootCanvas = factory.create(geometry.width, geometry.height);
  await page.render({ canvasContext: rootCanvas.context, viewport: page.getViewport({ scale: geometry.scale }),
    annotationMode: AnnotationMode.DISABLE, background: 'rgb(255,255,255)', intent: 'display' }).promise;
  const png = rootCanvas.canvas.toBuffer('image/png');
  if (png.length > LIMITS.maxPngBytes) throw new Error('Rendered PNG exceeds 4 MiB.');
  if (policy.metrics().deniedResourceRequests) throw new Error('The page required disabled PDF resources; a complete render is not confirmed.');
  response = { ok: true, sourceSha256, sourceBytes: data.length, page: pageNumber, pageCount: document.numPages,
    image: { mimeType: 'image/png', sha256: hash(png), bytes: png.length, ...geometry, dataBase64: png.toString('base64') },
    renderer: { ...PDF_RENDERER_IDENTITY, peakCanvasPixels: policy.metrics().peakCanvasPixels, externalRequests: 0 },
    warnings: [...warnings, 'Static page pixels only; no OCR accuracy or model vision is established. Annotations and XFA are excluded.'] };
  factory.destroy(rootCanvas); rootCanvas = null;
} catch (error) {
  response = { ok: false, error: String(error?.message || 'PDF rendering failed').slice(0, 300), deniedResourceRequests: policy.metrics().deniedResourceRequests, warnings };
} finally {
  if (rootCanvas?.canvas) rootCanvas.canvas.width = rootCanvas.canvas.height = 0;
  try { page?.cleanup(); await task?.destroy(); } catch { response = { ok: false, error: 'PDF renderer cleanup could not be confirmed.', warnings }; }
}
const output = JSON.stringify(response);
if (Buffer.byteLength(output) > LIMITS.maxResponseBytes) process.stdout.write(JSON.stringify({ ok: false, error: 'PDF render response exceeds 6 MiB.' }));
else process.stdout.write(output);
