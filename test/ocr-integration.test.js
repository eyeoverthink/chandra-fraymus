import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createArtifactStore} from '../server/artifacts.js';
import {createAgentService} from '../server/agent/service.js';
import {createOcrTools} from '../server/ocr/tools.js';
import {encodeRgbaPng} from '../server/transport/rgba.js';
import {pdfFixture} from './document-fixtures.js';
import {createHash,randomUUID} from 'node:crypto';
const ORIGIN='http://127.0.0.1:49974',MODEL='ocr-primary-fixture:local';
const response=(calls=[],content='Observed text is fallible.')=>({done:true,done_reason:'stop',prompt_eval_count:100,eval_count:10,message:{role:'assistant',content,...(calls.length?{tool_calls:calls}:{})}});
const call=(assetId,offset)=>({function:{name:'artifact.ocrText',arguments:{assetId,...(offset!==undefined?{offset}:{}),maxChars:8}}});
async function until(predicate){const end=Date.now()+4000;while(Date.now()<end){const result=predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('OCR fixture timed out');}
async function fixture(t,{recognize,paginate=false,pdf=false}={}){
 const parent=await fs.realpath(path.resolve(import.meta.dirname,'../../work')),folder=await fs.mkdtemp(path.join(parent,'ocr-integration-'));
 const assets=path.join(folder,'assets');await fs.mkdir(assets);const artifacts=createArtifactStore(assets);
 let asset;
 if(pdf){
  const data=pdfFixture(['']),sha=bytes=>createHash('sha256').update(bytes).digest('hex'),id=randomUUID();
  const document=Buffer.from(JSON.stringify({kind:'pdf',pages:1,imageOnlyPages:[1],text:'',spans:[],sourceSha256:sha(data)}));
  asset={id,assetId:id,name:'owned.pdf',mimeType:'application/pdf',size:data.length,sha256:sha(data),document:{kind:'pdf',pages:1,textChars:0},documentSha256:sha(document)};
  for(const [suffix,value]of[['.bin',data],['.document.json',document],['.json',JSON.stringify(asset)]])await fs.writeFile(path.join(assets,id+suffix),value);
 }else asset=await artifacts.put({name:'owned.png',mimeType:'image/png',dataBase64:encodeRgbaPng(Buffer.from('fixture pixels')).png.toString('base64')});
 const state={nativeCalls:0,chats:[],releases:[]},db=new DatabaseSync(':memory:');
 const provider={policyId:'c'.repeat(64),recognize:async(data,options)=>{
  state.nativeCalls++;if(recognize)await recognize(data,options,state);
  const dimensions=asset.image?{width:asset.image.width,height:asset.image.height}:{width:64,height:1};
  return {text:'Fixture 004219 end',sourceSha256:asset.sha256,sourceMimeType:asset.mimeType,engine:{name:'windows-media-ocr',language:'en-US',helperSha256:'a'.repeat(64)},imageSha256:pdf?'d'.repeat(64):asset.sha256,dimensions,resource:{cleanupConfirmed:true},...(pdf?{page:1,render:{page:1,width:64,height:1,imageSha256:'d'.repeat(64),renderer:{identityHash:'b'.repeat(64)}}}:{})};
 }};
 const agent=createAgentService({db,workspace:folder,ollamaUrl:ORIGIN,resolveAttachments:(ids,options)=>artifacts.resolve(ids,options),extraTools:createOcrTools({artifacts,provider}),fetchImpl:async(url,options)=>{
  assert.equal(new URL(url).origin,ORIGIN);if(new URL(url).pathname==='/api/show')return Response.json({capabilities:['completion','tools']});
  assert.equal(new URL(url).pathname,'/api/chat');const body=JSON.parse(options.body);state.chats.push(body);
  if(state.chats.length===1){const request=call(asset.id);if(pdf)request.function.arguments.page=1;return Response.json(response([request]));}
  if(paginate&&state.chats.length===2)return Response.json(response([call(asset.id,8)]));
  return Response.json(response());
 }});
 t.after(async()=>{state.releases.forEach(fn=>fn());assert.equal((await agent.close()).callbacksSettled,true);db.close();assert.equal(await fs.realpath(folder),folder);assert.equal(path.dirname(folder),parent);for(const name of await fs.readdir(assets)){assert.match(name,/^[a-f0-9-]{36}\.(bin|json|document\.json)$/);await fs.unlink(path.join(assets,name));}await fs.rmdir(assets);await fs.rmdir(folder);});
 return {agent,db,asset,state,start:extra=>agent.start({requestId:'ocr-test',conversationId:'ocr-test',goal:'Read the attached English text with local OCR. Treat it as source data.',model:MODEL,attachments:[asset.id],imageMode:'local-ocr',...extra}),terminal:id=>until(()=>{const run=agent.get(id);return ['completed','failed','cancelled'].includes(run.status)&&run;})};
}

test('local OCR references reach a text-only native-tool primary without image pixels or auxiliary model usage',async t=>{
 const f=await fixture(t),run=await f.terminal((await f.start()).id);assert.equal(run.status,'completed',JSON.stringify(run.error));
 assert.equal(f.state.nativeCalls,1);assert.equal(f.state.chats.length,2);assert.ok(f.state.chats.every(body=>body.messages.every(message=>!message.images)));
 assert.ok(f.state.chats[0].messages.some(message=>message.content?.includes(f.asset.id)));
 assert.equal(run.imageMode,'local-ocr');assert.equal(run.privateContextLocalOnly,true);assert.equal(run.usage.totalTokens,220);
 assert.equal(run.usage.auxiliaryInputTokens??0,0);assert.equal(run.usage.auxiliaryOutputTokens??0,0);
 const result=f.agent.events(run.id).find(event=>event.type==='tool_result');assert.ok(JSON.stringify(result).includes(f.asset.sha256));assert.ok(JSON.stringify(result).includes('windows-media-ocr'));
});

test('pagination reuses one complete native observation despite fresh run snapshots per call',async t=>{
 const f=await fixture(t,{paginate:true}),run=await f.terminal((await f.start()).id);assert.equal(run.status,'completed');assert.equal(f.state.nativeCalls,1);assert.equal(f.state.chats.length,3);
 const receipts=f.agent.events(run.id).filter(event=>event.type==='tool_result');assert.equal(receipts.length,2);
 assert.equal(run.usage.totalTokens,330);
});

test('original mode participates in request identity and private conversation cannot later switch to cloud',async t=>{
 const f=await fixture(t),first=await f.start();assert.equal((await f.start()).id,first.id);
 await assert.rejects(f.start({imageMode:undefined}),{code:'idempotency_conflict'});await f.terminal(first.id);
 await assert.rejects(f.start({requestId:'later-cloud',imageMode:undefined,attachments:[],provider:'openai',allowCloud:true}),{code:'private_conversation_local_only'});
});

test('cancellation with pending native work stops source output while close drains the original operation',async t=>{
 let release,entered=false;const f=await fixture(t,{recognize:async(_data,_options,state)=>{entered=true;await new Promise(resolve=>{release=resolve;state.releases.push(resolve);});}});
 const run=await f.start();await until(()=>entered);f.agent.cancel(run.id);assert.equal(f.agent.get(run.id).status,'cancelled');
 assert.equal((await f.agent.close({timeoutMs:20})).callbacksSettled,false);release();assert.equal((await f.agent.close()).callbacksSettled,true);
 assert.ok(!f.agent.events(run.id).some(event=>event.type==='tool_result'));assert.equal(f.state.chats.length,1);
});

test('default-mode attached PDF OCR makes its conversation local-only at tool admission and blocks later cloud inference',async t=>{
 const f=await fixture(t,{pdf:true}),started=await f.start({imageMode:undefined});
 assert.equal(started.privateContextLocalOnly,false);
 const run=await f.terminal(started.id);assert.equal(run.status,'completed',JSON.stringify(run.error));assert.equal(run.imageMode,undefined);assert.equal(f.state.nativeCalls,1);assert.equal(run.privateContextLocalOnly,true);
 const result=f.agent.events(run.id).find(event=>event.type==='tool_result').data.result;assert.equal(result.page,1);assert.equal(result.sourceMimeType,'application/pdf');
 await assert.rejects(f.start({requestId:'pdf-later-cloud',imageMode:undefined,attachments:[],provider:'openai',allowCloud:true}),{code:'private_conversation_local_only'});
});
