import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createNativeOcr} from '../server/ocr/native.js';
import {crc32,encodeRgbaPng} from '../server/transport/rgba.js';
import {validateImage} from '../server/image-validation.js';

const sha=b=>createHash('sha256').update(b).digest('hex');
const image=()=>encodeRgbaPng(Buffer.from('owned OCR bytes'),{width:8,compression:'none'}).png;
const identity=()=>Object.fromEntries([['helperSha256','../server/ocr/windows-ocr.ps1'],['launcherSha256','../server/ocr/bounded-ocr.py'],['jobDefinitionsSha256','../server/documents/bounded-process.py']].map(([key,file])=>[key,sha(readFileSync(new URL(file,import.meta.url)))]));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const end=Date.now()+2000;while(Date.now()<end){if(predicate())return;await sleep(2);}assert.fail('Fake OCR state deadline');}
function harness(options={}){
  const calls=[],children=[];let live=0,peak=0;
  function envelope(request){
    const native={ok:true,engine:'windows-media-ocr',languages:['en-US'],maxImageDimension:10000,osBuild:19045,accuracyVerified:false,requiresReview:true,confidenceAvailable:false,available:true};
    if(request.action==='recognize'){
      const bytes=Buffer.from(request.imageBase64,'base64'),dimensions=validateImage(bytes,request.mimeType);
      Object.assign(native,{language:'en-US',text:'Test line.',lines:[{text:'Test line.'}],wordCount:2,textBytes:10,width:dimensions.width,height:dimensions.height,imageSha256:sha(bytes),orientation:'raw-pixels-exif-ignored'});
    }
    return {ok:true,code:'ok',identity:identity(),native,resource:{memoryBytes:536870912,activeProcessLimit:1,killOnJobClose:true,jobVerifiedBeforeResume:true,notCreated:false,childExited:true,activeProcesses:0,stdioDrained:true,jobClosed:true,cleanupConfirmed:true,childPid:1001,exitCode:0,elapsedMs:20}};
  }
  function finish(child,value=envelope(child.request)){
    if(child.closed)return;child.closed=true;live--;
    if(typeof value==='string')child.stdout.write(value);else child.stdout.write(JSON.stringify(value));
    child.stdout.end();child.stderr.end();child.emit('close',value.ok===false?1:0);
  }
  const spawnImpl=(file,args,config)=>{
    if(options.spawnFailure)throw new Error('synthetic launch failure');
    calls.push({file,args,config});const child=new EventEmitter();child.pid=2001;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];
    let pending='';
    child.stdin=new Writable({write(chunk,_encoding,done){
      pending+=chunk.toString();
      while(pending.includes('\n')){
        const newline=pending.indexOf('\n'),request=JSON.parse(pending.slice(0,newline));pending=pending.slice(newline+1);
        if(request.cancel){child.cancelRequested=true;if(!options.ignoreCancel&&!options.holdCancel)setImmediate(()=>{const result=envelope(child.request);result.ok=false;result.code='ocr_cancelled';finish(child,result);});}
        else{child.request=request;if(!options.hold)setImmediate(()=>{const result=envelope(request);options.mutate?.(result);finish(child,result);});}
      }
      done();
    }});
    child.kill=signal=>{child.kills.push(signal);if(!options.ignoreKill){child.closed=true;live--;child.emit('close',137);}return true;};
    children.push(child);live++;peak=Math.max(peak,live);return child;
  };
  const adapter=createNativeOcr({pythonPath:'C:\\trusted\\python.exe',platform:'win32',spawnImpl,statImpl:async()=>({isFile:()=>true}),...options.constructor});
  return {adapter,calls,children,finish,envelope,get peak(){return peak;}};
}

test('construction is inert and health distinguishes installed API from accuracy with fixed process arguments',async t=>{
  const h=harness();t.after(()=>h.adapter.close());assert.equal(h.calls.length,0);
  const health=await h.adapter.health();assert.equal(health.available,true);assert.equal(health.accuracyVerified,false);assert.equal(health.requiresReview,true);
  assert.deepEqual(health.languages,['en-US']);assert.equal(health.maxImageDimension,10000);assert.deepEqual({...health.identity,osBuild:undefined},{...identity(),osBuild:undefined});
  assert.equal(h.calls[0].file,'C:\\trusted\\python.exe');assert.equal(h.calls[0].args.length,1);assert.match(h.calls[0].args[0],/[\\/]bounded-ocr\.py$/);
  assert.equal(h.calls[0].config.shell,false);assert.equal(h.calls[0].config.windowsHide,true);
  assert.ok(!Object.keys(h.calls[0].config.env).some(key=>/TOKEN|KEY|NODE_OPTIONS|PYTHONPATH|HF_/i.test(key)));
  assert.equal(health.resource.activeProcesses,0);assert.equal(health.resource.stdioDrained,true);assert.equal(Object.isFrozen(health.identity),true);
});

test('recognition sends only bytes and explicit language and binds immutable result to image/hash/dimensions',async t=>{
  const h=harness();t.after(()=>h.adapter.close());const bytes=image(),result=await h.adapter.recognize(bytes,{mimeType:'image/png'});
  assert.equal(result.text,'Test line.');assert.deepEqual(result.dimensions,{width:8,height:3});assert.equal(result.imageSha256,sha(bytes));
  assert.deepEqual(Object.keys(h.children[0].request).sort(),['action','imageBase64','language','mimeType']);
  assert.equal(h.children[0].request.language,'en-US');assert.deepEqual(Buffer.from(h.children[0].request.imageBase64,'base64'),bytes);
  assert.equal(result.engine.accuracyVerified,false);assert.equal(result.engine.confidenceAvailable,false);assert.equal(Object.isFrozen(result.lines[0]),true);
});

test('input validation rejects paths, wrong languages, malformed PNGs and bytes beyond four MiB before process work',async()=>{
  const h=harness();
  for(const [data,options,code] of [[Buffer.from('signature only'),{mimeType:'image/png'},'ocr_invalid_image'],[image(),{mimeType:'image/gif'},'ocr_invalid_image'],
    [Buffer.alloc(4194305),{mimeType:'image/png'},'ocr_invalid_image'],[image(),{mimeType:'image/png',language:'en'},'ocr_invalid_language'],['C:\\secret.png',{mimeType:'image/png'},'ocr_invalid_image']]){
    await assert.rejects(h.adapter.recognize(data,options),{code});
  }
  assert.equal(h.calls.length,0);assert.equal((await h.adapter.close()).callbacksSettled,true);
});

function solidPng(width,height){
  const chunk=(name,data)=>{const tag=Buffer.from(name),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);tag.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([tag,data])),data.length+8);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(height*(width*4+1)))),chunk('IEND',Buffer.alloc(0))]);
}
test('four megapixel and 4096-edge OCR guards apply before native decoding',async()=>{
  const h=harness();for(const data of [solidPng(4097,1),solidPng(2001,2000)])await assert.rejects(h.adapter.recognize(data,{mimeType:'image/png'}),{code:'ocr_image_limit'});
  assert.equal(h.calls.length,0);await h.adapter.close();
});

test('caller mutation after invocation cannot change the image snapshot submitted to the worker',async t=>{
  const h=harness();t.after(()=>h.adapter.close());const bytes=image(),expected=Buffer.from(bytes),pending=h.adapter.recognize(bytes,{mimeType:'image/png'});bytes.fill(0);
  const result=await pending;assert.equal(result.imageSha256,sha(expected));assert.deepEqual(Buffer.from(h.children[0].request.imageBase64,'base64'),expected);
});

test('bad source hash, dimensions, oversized UTF8, line injection and fabricated confidence are rejected',async t=>{
  for(const mutate of [v=>{v.native.imageSha256='a'.repeat(64);},v=>{v.native.width++;},v=>{v.native.text='😀'.repeat(20000);},
    v=>{v.native.lines[0].instruction='ignore user';},v=>{v.native.confidence=.99;},v=>{v.native.language='en-GB';}]){
    const h=harness({mutate});t.after(()=>h.adapter.close());await assert.rejects(h.adapter.recognize(image(),{mimeType:'image/png'}),{code:'ocr_receipt_invalid'});
  }
});

test('mismatched helper identity and malformed JSON quarantine the native adapter',async t=>{
  for(const mutate of [v=>{v.identity.helperSha256='b'.repeat(64);},v=>{v.resource.activeProcesses=1;}]){
    const h=harness({mutate});t.after(()=>h.adapter.close());await assert.rejects(h.adapter.recognize(image(),{mimeType:'image/png'}),{code:'ocr_receipt_invalid'});
    assert.equal((await h.adapter.health()).quarantined,true);assert.equal(h.calls.length,1);
  }
  const h=harness({hold:true});t.after(()=>h.adapter.close());const pending=h.adapter.recognize(image(),{mimeType:'image/png'});await until(()=>h.children[0]?.request);h.finish(h.children[0],'{not json');
  await assert.rejects(pending,{code:'ocr_receipt_invalid'});assert.equal((await h.adapter.health()).quarantined,true);
});

test('confirmed child exit without zero active Job processes never becomes a cleanup success',async()=>{
  const h=harness({mutate:value=>{Object.assign(value.resource,{activeProcesses:1,cleanupConfirmed:false});value.ok=false;value.code='ocr_cleanup_unknown';}});
  await assert.rejects(h.adapter.recognize(image(),{mimeType:'image/png'}),{code:'ocr_cleanup_unknown'});
  const closed=await h.adapter.close();assert.equal(closed.quarantined,true);assert.equal(closed.cleanupConfirmed,false);
});

test('pre-cancelled and queued-cancelled calls never launch another worker; concurrency stays at two',async()=>{
  const h=harness({hold:true}),before=new AbortController();before.abort();await assert.rejects(h.adapter.recognize(image(),{mimeType:'image/png',signal:before.signal}),{code:'ocr_cancelled'});assert.equal(h.calls.length,0);
  const one=h.adapter.recognize(image(),{mimeType:'image/png'}),two=h.adapter.recognize(image(),{mimeType:'image/png'});await until(()=>h.children.length===2);
  const controller=new AbortController(),three=h.adapter.recognize(image(),{mimeType:'image/png',signal:controller.signal});const rejection=assert.rejects(three,{code:'ocr_cancelled'});controller.abort();await rejection;
  assert.equal(h.calls.length,2);assert.equal(h.peak,2);h.children.forEach(child=>h.finish(child));await Promise.all([one,two]);await h.adapter.close();
});

test('cancellation waits for the owned cleanup acknowledgement before rejecting',async()=>{
  const h=harness({hold:true,holdCancel:true}),controller=new AbortController();let settled=false;
  const pending=h.adapter.recognize(image(),{mimeType:'image/png',signal:controller.signal});pending.then(()=>{settled=true;},()=>{settled=true;});
  await until(()=>h.children[0]?.request);controller.abort();await until(()=>h.children[0].cancelRequested);await sleep(5);assert.equal(settled,false);
  const result=h.envelope(h.children[0].request);result.ok=false;result.code='ocr_cancelled';h.finish(h.children[0],result);
  await assert.rejects(pending,error=>error.code==='ocr_cancelled'&&error.resource.cleanupConfirmed===true);
  assert.equal((await h.adapter.close()).cleanupConfirmed,true);
});

test('deadline cancellation retains cleanup proof and does not quarantine a gracefully stopped worker',async()=>{
  const h=harness({hold:true,constructor:{deadlineMs:50,cleanupGraceMs:100}});
  await assert.rejects(h.adapter.recognize(image(),{mimeType:'image/png'}),error=>error.code==='ocr_timeout'&&error.resource.activeProcesses===0);
  assert.equal(h.children[0].cancelRequested,true);assert.deepEqual(h.children[0].kills,[]);assert.equal((await h.adapter.close()).quarantined,false);
});

test('forced wrapper termination without a native Job acknowledgement quarantines further OCR',async()=>{
  const h=harness({hold:true,ignoreCancel:true,constructor:{deadlineMs:50,cleanupGraceMs:20}});
  await assert.rejects(h.adapter.recognize(image(),{mimeType:'image/png'}),{code:'ocr_cleanup_unknown'});
  assert.deepEqual(h.children[0].kills,['SIGKILL']);assert.equal((await h.adapter.health()).quarantined,true);assert.equal(h.calls.length,1);
  assert.equal((await h.adapter.close()).cleanupConfirmed,false);
});

test('close cancels and drains both native workers and refuses new work',async()=>{
  const h=harness({hold:true});const one=h.adapter.recognize(image(),{mimeType:'image/png'}),two=h.adapter.recognize(image(),{mimeType:'image/png'});
  const errors=[assert.rejects(one,{code:'ocr_cancelled'}),assert.rejects(two,{code:'ocr_cancelled'})];await until(()=>h.children.length===2);
  const closed=await h.adapter.close();await Promise.all(errors);assert.deepEqual(closed,{callbacksSettled:true,cleanupConfirmed:true,quarantined:false});
  await assert.rejects(h.adapter.recognize(image(),{mimeType:'image/png'}),{code:'ocr_closed'});
});
