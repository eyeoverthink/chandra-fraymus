import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createNativeOcr } from './native.js';
import { renderPdfPage, pdfRendererState } from './pdf.js';
import { validateImage } from '../image-validation.js';
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function defaultPolicy() {
  const paths=['./local.js','./native.js','./windows-ocr.ps1','./bounded-ocr.py','./pdf.js','./pdf-child.mjs','./limits.mjs','../documents/bounded-process.py'];
  return hash(JSON.stringify(paths.map(path=>[path,hash(readFileSync(new URL(path,import.meta.url)))])));
}

/** Local file processing only. PNG pixels/decoded PDF pages never enter the
 * primary model here; it receives fallible OCR text through the native tool. */
export function createLocalOcrProvider({ native = createNativeOcr(), render = renderPdfPage,
  policyId = defaultPolicy(), rendererState = pdfRendererState } = {}) {
  if(!native||typeof native.health!=='function'||typeof native.recognize!=='function'||typeof render!=='function'
    ||typeof policyId!=='string'||!/^[a-f0-9]{64}$/.test(policyId))throw new TypeError('Trusted local OCR implementation and policy identity required');
  return Object.freeze({policyId,
    async health({signal}={}) {
      signal?.throwIfAborted();
      const observed=await native.health({signal});signal?.throwIfAborted();
      const pdf=rendererState(),pdfAvailable=observed.available===true&&process.platform==='win32'&&!pdf.quarantined;
      return {...observed,policyId,imageMode:'local-ocr',accuracyVerified:false,requiresReview:true,
        supportedMimeTypes:['image/png','image/jpeg',...(pdfAvailable?['application/pdf']:[])],pdfPageRequired:true,
        pdf:{available:pdfAvailable,rendererQuarantined:pdf.quarantined===true,active:pdf.active},
        limitations:['OCR can misread numbers, small text and stylized fonts.','Availability does not establish transcription accuracy.','No desktop capture, visual reasoning or model inference is performed.']};
    },
    async recognize(data,{mimeType,page,language='en-US',signal}={}) {
      signal?.throwIfAborted();
      if(!Buffer.isBuffer(data)||!data.length||data.length>4*1024*1024)fail('ocr_input','Provide bounded attached file bytes');
      if(language!=='en-US')fail('ocr_language','This configured OCR path supports en-US only');
      const snapshot=Buffer.from(data),sourceSha256=hash(snapshot);let pixels=snapshot,renderReceipt;
      if(mimeType==='application/pdf') {
        if(!Number.isInteger(page)||page<1||page>300)fail('ocr_page','PDF OCR requires one explicit page');
        const result=await render(snapshot,page,{signal});signal?.throwIfAborted();
        if(!result||!Buffer.isBuffer(result.png)||result.sourceSha256!==sourceSha256||result.page!==page
          ||!Number.isInteger(result.pageCount)||result.pageCount<page||result.pageCount>300
          ||result.image?.mimeType!=='image/png'||result.image.sha256!==hash(result.png))fail('ocr_render_receipt','PDF renderer returned mismatched source/page/image evidence');
        const dimensions=validateImage(result.png,'image/png');
        if(dimensions.width!==result.image.width||dimensions.height!==result.image.height)fail('ocr_render_receipt','Rendered page dimensions do not match its receipt');
        pixels=Buffer.from(result.png);
        renderReceipt={page,pageCount:result.pageCount,sourceBytes:snapshot.length,imageSha256:result.image.sha256,
          width:dimensions.width,height:dimensions.height,dpi:result.image.dpi,requestedDpi:result.image.requestedDpi,
          pixels:result.image.pixels,downscaled:result.image.downscaled,renderer:result.renderer,
          resourceBoundary:result.resourceBoundary,warnings:result.warnings};
      } else {
        if(!['image/png','image/jpeg'].includes(mimeType)||page!==undefined)fail('ocr_input','Image OCR accepts PNG/JPEG without a page selector');
        validateImage(snapshot,mimeType);
      }
      signal?.throwIfAborted();
      const result=await native.recognize(pixels,{mimeType:renderReceipt?'image/png':mimeType,language,signal});
      signal?.throwIfAborted();
      if(!result||typeof result.text!=='string'||Buffer.byteLength(result.text)>65536||result.imageSha256!==hash(pixels)
        ||result.engine?.name!=='windows-media-ocr'||result.engine.language!==language
        ||!Number.isInteger(result.dimensions?.width)||!Number.isInteger(result.dimensions?.height))fail('ocr_receipt','Native OCR returned mismatched image or engine evidence');
      return {text:result.text,sourceSha256,sourceMimeType:mimeType,...(page!==undefined?{page}:{}),
        engine:result.engine,imageSha256:result.imageSha256,dimensions:result.dimensions,
        ...(renderReceipt?{render:renderReceipt}:{}),resource:result.resource,policyId};
    },
    async close(){return typeof native.close==='function'?native.close():{callbacksSettled:true,cleanupConfirmed:true};}
  });
}
