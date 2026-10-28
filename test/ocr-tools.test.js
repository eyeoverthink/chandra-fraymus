import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOcrTools} from '../server/ocr/tools.js';
import {checkSchema} from '../server/agent/schema.js';
const sha=value=>createHash('sha256').update(value).digest('hex');

function fixture({recognize,text='Line one\n033598 😀\nLine three',mimeType='image/png',page,outputBudget=12000}={}) {
  const controller=new AbortController(),calls=[],sources=new Map();
  function source(id='asset-1',mime=mimeType) {
    if(!sources.has(id)){const data=Buffer.from('owned-source-'+id);sources.set(id,{metadata:{id,mimeType:mime,sha256:sha(data)},data});}
    return sources.get(id);
  }
  const initial=source(),run={id:'ocr-run',provider:'ollama',allowCloud:false,imageMode:'local-ocr',attachments:['asset-1'],budget:{maxToolResultChars:outputBudget}};
  const artifacts={ocrInput(id,selector,owner){assert.ok(owner.attachments.includes(id),'unattached asset');const input=source(id);return {...input,data:Buffer.from(input.data),...(selector.page!==undefined?{page:selector.page}:{})};}};
  const result=(input,options)=>({text,sourceSha256:sha(input),sourceMimeType:options.mimeType,...(options.page!==undefined?{page:options.page}:{}),
    engine:{name:'windows-media-ocr',language:'en-US',helperSha256:'a'.repeat(64),confidenceAvailable:false},
    imageSha256:options.page!==undefined?'b'.repeat(64):sha(input),dimensions:{width:100,height:50},
    ...(options.page!==undefined?{render:{page:options.page,pageCount:2,imageSha256:'b'.repeat(64),width:100,height:50,dpi:150,renderer:{engine:'pdfjs-canvas',identityHash:'c'.repeat(64)}}}:{})});
  const provider={policyId:'fixed-ocr-policy-v1',recognize:async(input,options)=>{calls.push({input,options});return recognize?recognize(input,options,result):result(input,options);}};
  const tool=createOcrTools({artifacts,provider})[0];
  const execute=(args={},overrides={})=>tool.execute({args:{assetId:'asset-1',...(page!==undefined?{page}:{}),...args},run,signal:controller.signal,
    auxiliaryInput:new Proxy({}, {get(){assert.fail('Native OCR must not touch model inference accounting');}}),...overrides});
  return {tool,execute,calls,run,controller,source,result,provider,initial};
}

test('OCR native tool has a strict documents schema with no host path, action or model selector',()=>{
  const f=fixture();checkSchema(f.tool.parameters);assert.equal(f.tool.name,'artifact.ocrText');assert.equal(f.tool.group,'documents');assert.equal(f.tool.approvalRequired,false);
  assert.deepEqual(Object.keys(f.tool.parameters.properties),['assetId','page','language','offset','maxChars']);
  assert.throws(()=>createOcrTools({artifacts:{ocrInput(){}},provider:{recognize(){}}}),/fixed-policy/);
});

test('local mode and attachment authority gate OCR before provider dispatch',async()=>{
  const f=fixture();f.run.imageMode=undefined;await assert.rejects(f.execute(),{code:'ocr_mode_required'});
  f.run.imageMode='local-ocr';f.run.provider='openai';await assert.rejects(f.execute(),{code:'ocr_local_only'});
  f.run.provider='ollama';f.run.allowCloud=true;await assert.rejects(f.execute(),{code:'ocr_local_only'});
  f.run.allowCloud=false;f.run.attachments=[];await assert.rejects(f.execute(),/unattached/);assert.equal(f.calls.length,0);
});

test('scheduled provenance cannot obtain OCR source authority even from a permissive test artifact adapter',async()=>{
  const f=fixture();f.run.provenance={kind:'scheduled_task'};await assert.rejects(f.execute(),{code:'ocr_scheduled_denied'});assert.equal(f.calls.length,0);
});

test('attached PDF page OCR works in default image mode and preserves page/render provenance',async()=>{
  const f=fixture({mimeType:'application/pdf',page:2});delete f.run.imageMode;delete f.run.provider;
  const receipt=await f.execute();assert.equal(receipt.page,2);assert.equal(receipt.render.page,2);assert.equal(receipt.sourceMimeType,'application/pdf');
  assert.equal(receipt.assetSha256,f.initial.metadata.sha256);assert.equal(receipt.imageSha256,'b'.repeat(64));assert.equal(f.calls[0].options.page,2);
});

test('completed OCR pagination reuses exact text/hash/engine evidence without another native call or model meter',async()=>{
  const f=fixture(),a=await f.execute({maxChars:9}),b=await f.execute({offset:a.nextOffset,maxChars:8000});
  assert.equal(a.text+b.text,'Line one\n033598 😀\nLine three');assert.equal(a.offsetUnit,'utf16');assert.equal(b.nextOffset,null);
  assert.equal(a.resultId,b.resultId);assert.equal(a.textSha256,sha('Line one\n033598 😀\nLine three'));assert.equal(a.totalChars,'Line one\n033598 😀\nLine three'.length);
  assert.equal(a.engine.name,'windows-media-ocr');assert.equal(a.confidenceAvailable,false);assert.equal(a.confidence,undefined);assert.equal(a.modelInference,false);assert.equal(a.untrusted,true);assert.equal(a.usage,undefined);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.language,'en-US');
});

test('blank OCR is a complete honest empty result, not a fabricated transcript or failure',async()=>{
  const f=fixture({text:''}),receipt=await f.execute();assert.equal(receipt.text,'');assert.equal(receipt.totalChars,0);assert.equal(receipt.nextOffset,null);assert.equal(receipt.textSha256,sha(''));
});

test('pagination preserves surrogate boundaries and exact escaped text within the run output ceiling',async()=>{
  const text=('😀"\\\n'.repeat(200)),f=fixture({text,outputBudget:1800});let offset=0,combined='',last;
  do {last=await f.execute({offset,maxChars:8000});assert.ok(JSON.stringify(last).length<=1800);assert.ok(last.text.isWellFormed());combined+=last.text;offset=last.nextOffset;}while(offset!==null);
  assert.equal(combined,text);assert.equal(f.calls.length,1);await assert.rejects(f.execute({offset:1}),{code:'invalid_arguments'});
  await assert.rejects(f.execute({offset:text.length+1}),{code:'invalid_arguments'});
});

test('evidence too large for tool-output budget fails explicitly without disguising a truncated receipt',async()=>{
  const f=fixture({outputBudget:256});await assert.rejects(f.execute(),{code:'ocr_output_budget'});assert.equal(f.calls.length,1);
  f.run.budget.maxToolResultChars=12000;assert.equal((await f.execute()).text,'Line one\n033598 😀\nLine three');assert.equal(f.calls.length,1);
});

test('same source concurrent calls share one in-flight native operation and completed immutable metadata',async()=>{
  let release,candidate;
  const f=fixture({recognize:async(input,options,result)=>{await new Promise(resolve=>{release=resolve;});candidate=result(input,options);return candidate;}});
  const first=f.execute({maxChars:4}),second=f.execute({maxChars:5});await Promise.resolve();await Promise.resolve();assert.equal(f.calls.length,1);release();
  const [a,b]=await Promise.all([first,second]);candidate.engine.language='mutated';assert.throws(()=>{a.engine.language='caller mutation';},TypeError);
  assert.equal(b.engine.language,'en-US');assert.equal((await f.execute()).engine.language,'en-US');assert.equal(f.calls.length,1);
});

test('provider failures are not completed-cache entries and never silently retry in the same run',async()=>{
  const f=fixture({recognize:async()=>{throw Object.assign(new Error('Native cleanup uncertain'),{code:'ocr_cleanup_unknown'});}});
  await assert.rejects(f.execute(),{code:'ocr_cleanup_unknown'});await assert.rejects(f.execute(),{code:'ocr_attempt_failed'});assert.equal(f.calls.length,1);
});

test('cancel before dispatch and during native work never return a late OCR success',async()=>{
  const before=fixture();before.controller.abort(new Error('cancel before'));await assert.rejects(before.execute(),/cancel before/);assert.equal(before.calls.length,0);
  let release;const after=fixture({recognize:async(input,options,result)=>{await new Promise(resolve=>{release=resolve;});return result(input,options);}});
  const pending=after.execute();await Promise.resolve();await Promise.resolve();after.controller.abort(new Error('cancel during'));release();await assert.rejects(pending,/cancel during/);assert.equal(after.calls.length,1);
});

test('source, page, image and engine mismatches are rejected without returning unbound OCR text',async()=>{
  for(const mutate of [r=>r.sourceSha256='0'.repeat(64),r=>r.sourceMimeType='image/jpeg',r=>r.page=1,
    r=>r.imageSha256='d'.repeat(64),r=>r.engine.helperSha256='bad',r=>r.engine.language='en-GB',r=>r.dimensions.width=4097,
    r=>r.text='\uD800',r=>r.text='\0hidden',r=>r.text='x'.repeat(65537)]) {
    const f=fixture({recognize:async(input,options,result)=>{const r=result(input,options);mutate(r);return r;}});
    await assert.rejects(f.execute(),{code:'ocr_invalid_result'});assert.equal(f.calls.length,1);
  }
  const pdf=fixture({mimeType:'application/pdf',page:1,recognize:async(input,options,result)=>({...result(input,options),render:{page:2}})});
  await assert.rejects(pdf.execute(),{code:'ocr_invalid_result'});
});

test('cache separates exact source and PDF page identities and authorizes every cached read again',async()=>{
  const f=fixture({mimeType:'application/pdf',page:1});await f.execute();await f.execute({page:2});assert.equal(f.calls.length,2);
  f.run.attachments.push('asset-2');f.source('asset-2','application/pdf');await f.execute({assetId:'asset-2',page:1});assert.equal(f.calls.length,3);
  f.run.attachments=[];await assert.rejects(f.execute(),/unattached/);assert.equal(f.calls.length,3);
});

test('cache bounds distinct attempted sources to eight and completed UTF8 storage to 256 KiB',async()=>{
  const f=fixture();for(let i=1;i<=8;i++){const id='asset-'+i;f.run.attachments.push(id);await f.execute({assetId:id});}
  f.run.attachments.push('asset-9');await assert.rejects(f.execute({assetId:'asset-9'}),{code:'ocr_cache_limit'});assert.equal(f.calls.length,8);
  const large=fixture({text:'x'.repeat(65536)});for(let i=1;i<=3;i++){const id='asset-'+i;large.run.attachments.push(id);await large.execute({assetId:id});}
  large.run.attachments.push('asset-4');await assert.rejects(large.execute({assetId:'asset-4'}),{code:'ocr_cache_limit'});
  await assert.rejects(large.execute({assetId:'asset-4'}),{code:'ocr_attempt_failed'});assert.equal(large.calls.length,4);
});

test('strict optional arguments do not invoke OCR on unknown language, path or coercible numbers',async()=>{
  const f=fixture();for(const args of [{language:'en'},{path:'C:\\private'},{page:'1'},{offset:-1},{maxChars:8001}])await assert.rejects(f.execute(args),{code:'invalid_arguments'});
  assert.equal(f.calls.length,0);
});
