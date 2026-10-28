import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createLocalOcrProvider} from '../server/ocr/local.js';
import {encodeRgbaPng} from '../server/transport/rgba.js';
import {validateImage} from '../server/image-validation.js';
const sha=data=>createHash('sha256').update(data).digest('hex');
const png=encodeRgbaPng(Buffer.from('owned OCR pipeline fixture')).png;
const dimensions=validateImage(png,'image/png');
const source=Buffer.from('%PDF-owned-controlled-renderer-seam');
function fixture({nativeTransform,renderTransform,renderImpl}={}){
 const calls=[];const native={health:async()=>({available:true,engine:'windows-media-ocr',languages:['en-US']}),recognize:async(data,options)=>{
  calls.push({kind:'ocr',bytes:Buffer.from(data),options});
  const result={text:'Observed source text 004219',engine:{name:'windows-media-ocr',language:'en-US',helperSha256:'a'.repeat(64)},dimensions:{width:dimensions.width,height:dimensions.height},imageSha256:sha(data),resource:{cleanupConfirmed:true}};
  return nativeTransform?nativeTransform(result,data,options):result;
 }};
 const render=renderImpl??(async(data,page,options)=>{
  calls.push({kind:'render',bytes:Buffer.from(data),page,options});
  const result={png,sourceSha256:sha(data),page,pageCount:4,image:{mimeType:'image/png',sha256:sha(png),width:dimensions.width,height:dimensions.height,dpi:150,requestedDpi:150,pixels:dimensions.width*dimensions.height,downscaled:false},renderer:{identityHash:'b'.repeat(64)},resourceBoundary:{cleanup:{confirmed:true}},warnings:[]};
  return renderTransform?renderTransform(result):result;
 });
 return {calls,provider:createLocalOcrProvider({native,render,policyId:'c'.repeat(64)})};
}

test('image OCR forwards exact validated bytes with no page rendering/model calls and retains independent native image/engine facts',async()=>{
 const f=fixture(),result=await f.provider.recognize(png,{mimeType:'image/png'});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].kind,'ocr');assert.deepEqual(f.calls[0].bytes,png);
 assert.equal(result.sourceSha256,sha(png));assert.equal(result.imageSha256,sha(png));assert.equal(result.render,undefined);assert.equal(result.engine.name,'windows-media-ocr');
 const health=await f.provider.health();assert.equal(health.available,true);assert.equal(health.accuracyVerified,false);assert.equal(health.requiresReview,true);assert.equal(health.imageMode,'local-ocr');
});

test('PDF OCR binds original source and explicit page to rendered pixels and preserves render resource evidence',async()=>{
 const f=fixture(),result=await f.provider.recognize(source,{mimeType:'application/pdf',page:3});
 assert.deepEqual(f.calls.map(call=>call.kind),['render','ocr']);assert.deepEqual(f.calls[0].bytes,source);assert.deepEqual(f.calls[1].bytes,png);
 assert.equal(f.calls[1].options.mimeType,'image/png');assert.equal(result.sourceSha256,sha(source));assert.equal(result.imageSha256,sha(png));
 assert.equal(result.page,3);assert.equal(result.render.page,3);assert.equal(result.render.pageCount,4);assert.equal(result.render.resourceBoundary.cleanup.confirmed,true);
});

test('missing PDF page, image page, unsupported language/type and invalid bytes fail before a native call',async()=>{
 for(const [data,options] of [[source,{mimeType:'application/pdf'}],[png,{mimeType:'image/png',page:1}],
  [png,{mimeType:'image/png',language:'xx'}],[png,{mimeType:'text/plain'}],[Buffer.from('bad'),{mimeType:'image/png'}]]){
  const f=fixture();await assert.rejects(f.provider.recognize(data,options));assert.equal(f.calls.length,0);
 }
});

test('source/page/pixel mismatch stops before native OCR and native image mismatch never becomes an observation',async()=>{
 for(const renderTransform of [value=>({...value,sourceSha256:'d'.repeat(64)}),value=>({...value,page:2}),value=>({...value,image:{...value.image,sha256:'d'.repeat(64)}})]){
  const f=fixture({renderTransform});await assert.rejects(f.provider.recognize(source,{mimeType:'application/pdf',page:1}),{code:'ocr_render_receipt'});assert.equal(f.calls.filter(call=>call.kind==='ocr').length,0);
 }
 const f=fixture({nativeTransform:value=>({...value,imageSha256:'d'.repeat(64)})});await assert.rejects(f.provider.recognize(png,{mimeType:'image/png'}),{code:'ocr_receipt'});
});

test('cancellation after page render prevents OCR dispatch and cancellation after OCR prevents returned text',async()=>{
 const first=new AbortController();const f=fixture({renderTransform:value=>{first.abort(new Error('cancelled after render'));return value;}});
 await assert.rejects(f.provider.recognize(source,{mimeType:'application/pdf',page:1,signal:first.signal}),/cancelled after render/);assert.equal(f.calls.filter(call=>call.kind==='ocr').length,0);
 const last=new AbortController();const g=fixture({nativeTransform:value=>{last.abort(new Error('cancelled after OCR'));return value;}});
 await assert.rejects(g.provider.recognize(png,{mimeType:'image/png',signal:last.signal}),/cancelled after OCR/);
});

test('image OCR availability does not conceal independently quarantined PDF rendering',async()=>{
 const f=fixture();const provider=createLocalOcrProvider({native:{health:async()=>({available:true,engine:'windows-media-ocr',languages:['en-US']}),recognize:async()=>{}},render:async()=>{},policyId:'c'.repeat(64),rendererState:()=>({active:0,quarantined:true})});
 const health=await provider.health();assert.equal(health.available,true);assert.equal(health.pdf.available,false);assert.equal(health.pdf.rendererQuarantined,true);assert.ok(!health.supportedMimeTypes.includes('application/pdf'));
});
