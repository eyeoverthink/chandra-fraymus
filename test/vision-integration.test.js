import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createArtifactStore} from '../server/artifacts.js';
import {createAgentService} from '../server/agent/service.js';
import {createVisionTools} from '../server/vision/tools.js';
import {encodeRgbaPng} from '../server/transport/rgba.js';
const MODEL='vision-text-primary:local',ORIGIN='http://127.0.0.1:49951';
const native=(assetId)=>({function:{name:'artifact.analyzeImage',arguments:{assetId,question:'Name the large rectangle color.'}}});
const response=(text='',calls=[])=>({done:true,done_reason:'stop',prompt_eval_count:100,eval_count:10,message:{role:'assistant',content:text,...(calls.length?{tool_calls:calls}:{})}});
async function until(predicate){const end=Date.now()+4000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Vision integration fixture timed out');}
async function fixture(t,{analyze,chat,vision=false,tools=true}={}){
 const parent=await fs.realpath(fileURLToPath(new URL('../../work/',import.meta.url))),directory=await fs.mkdtemp(path.join(parent,'vision-integration-'));
 const original=await fs.realpath(directory),assetsDir=path.join(directory,'assets');await fs.mkdir(assetsDir);
 const db=new DatabaseSync(':memory:'),artifacts=createArtifactStore(assetsDir),asset=await artifacts.put({name:'test-source.png',mimeType:'image/png',dataBase64:encodeRgbaPng(Buffer.from('owned deterministic carrier fixture')).png.toString('base64')});
 const state={chats:[],helperCalls:[],releases:[]};
 const provider={analyze:async input=>{
  state.helperCalls.push(input);
  if(analyze)return analyze(input,state);
  await input.beforeRequest({estimatedInputTokens:5000,maxOutputTokens:input.maxOutputTokens});
  return {text:'The rectangle is yellow. Exact text is uncertain.',identity:{provider:'ollama',model:'gemma3:latest',digest:'a'.repeat(64)},imageSha256:asset.sha256,dimensions:{width:64,height:1},usage:{inputTokens:1000,outputTokens:20,costUsd:0}};
 }};
 const agent=createAgentService({db,workspace:directory,ollamaUrl:ORIGIN,resolveAttachments:(ids,options)=>artifacts.resolve(ids,options),extraTools:createVisionTools({artifacts,provider}),fetchImpl:async(url,options)=>{
  const address=new URL(url);assert.equal(address.origin,ORIGIN);const body=options.body?JSON.parse(options.body):undefined;
  if(address.pathname==='/api/show')return Response.json({capabilities:['completion',...(tools?['tools']:[]),...(vision?['vision']:[])]});
  assert.equal(address.pathname,'/api/chat');state.chats.push(body);
  return Response.json(chat?await chat(body,state.chats.length,asset,state):state.chats.length===1?response('',[native(asset.id)]):response('Observed yellow; exact text remains uncertain.'));
 }});
 t.after(async()=>{
  state.releases.forEach(release=>release());assert.equal((await agent.close()).callbacksSettled,true);db.close();
  assert.equal(await fs.realpath(directory),original);assert.equal(path.dirname(original),parent);assert.ok(path.basename(original).startsWith('vision-integration-'));
  for(const name of await fs.readdir(assetsDir)){assert.match(name,/^[a-f0-9-]{36}\.(?:bin|json)$/);await fs.unlink(path.join(assetsDir,name));}await fs.rmdir(assetsDir);await fs.rmdir(directory);
 });
 return {agent,db,artifacts,asset,assetsDir,state,start:input=>agent.start({requestId:'vision-test',conversationId:'vision-test',goal:'Inspect the attached image with the local helper.',model:MODEL,attachments:[asset.id],imageMode:'local-tool',...input}),terminal:id=>until(()=>{const run=agent.get(id);return ['completed','failed','cancelled'].includes(run.status)&&run;})};
}

test('explicit helper mode passes only references to text primary and charges known helper input/output once',async t=>{
 const f=await fixture(t),run=await f.terminal((await f.start()).id);assert.equal(run.status,'completed',JSON.stringify(run.error));
 assert.equal(f.state.helperCalls.length,1);assert.equal(f.state.chats.length,2);
 assert.ok(f.state.chats[0].messages.some(message=>message.content?.includes(f.asset.id)));
 assert.ok(f.state.chats.every(body=>body.messages.every(message=>!message.images)));
 assert.ok(!JSON.stringify(f.state.chats).includes((await fs.readFile(path.join(f.assetsDir,f.asset.id+'.bin'))).toString('base64')));
 assert.equal(run.imageMode,'local-tool');assert.equal(run.privateContextLocalOnly,true);
 assert.equal(run.usage.inputTokens,1200);assert.equal(run.usage.outputTokens,40);assert.equal(run.usage.totalTokens,1240);
 assert.equal(run.usage.auxiliaryInputTokens,1000);assert.equal(run.usage.auxiliaryOutputTokens,20);assert.equal(run.usage.reservedInputTokens,0);assert.equal(run.usage.reservedOutputTokens,0);assert.equal(run.usage.auxiliaryUsageKnown,true);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_auxiliary_generations WHERE status='settled'").get().n,1);
 const observation=f.agent.events(run.id).find(event=>event.type==='tool_result'&&event.data.name==='artifact.analyzeImage').data.result;
 assert.equal(observation.assetSha256,f.asset.sha256);assert.equal(observation.untrusted,true);assert.match(observation.limitations.join(' '),/wrong/);
 assert.ok(f.state.chats[1].messages.some(message=>message.role==='tool'&&message.content.includes('UNTRUSTED TOOL OUTPUT')));
});

test('direct default still rejects text-only primary images and never silently routes to helper',async t=>{
 const f=await fixture(t),run=await f.terminal((await f.start({imageMode:undefined})).id);assert.equal(run.status,'failed');assert.equal(run.error.code,'model_vision_unsupported');assert.equal(f.state.chats.length,0);assert.equal(f.state.helperCalls.length,0);
});

test('direct vision model path remains image-bearing and helper mode needs native tools',async t=>{
 const f=await fixture(t,{vision:true,chat:()=>response('Direct image answer.')}),run=await f.terminal((await f.start({imageMode:undefined})).id);
 assert.equal(run.status,'completed');assert.equal(f.state.chats[0].messages.filter(message=>message.images?.length).length,1);assert.equal(f.state.helperCalls.length,0);
 const denied=await fixture(t,{tools:false}),failed=await denied.terminal((await denied.start()).id);assert.equal(failed.error.code,'vision_helper_unavailable');assert.equal(denied.state.chats.length,0);
});

test('invalid or cloud helper mode is rejected before a run; replay cannot change image mode',async t=>{
 const f=await fixture(t);await assert.rejects(f.start({imageMode:'automatic'}),{code:'invalid_image_mode'});
 await assert.rejects(f.start({provider:'openai',allowCloud:true}),{code:'vision_local_only'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_runs').get().n,0);
 const first=await f.start();assert.equal((await f.start()).id,first.id);await assert.rejects(f.start({imageMode:undefined}),{code:'idempotency_conflict'});
 await f.terminal(first.id);await assert.rejects(f.start({requestId:'cloud-followup',attachments:[],imageMode:undefined,provider:'openai',allowCloud:true}),{code:'private_conversation_local_only'});
});

test('unauthorized attached-image ID never reaches helper or reveals another asset',async t=>{
 let other;const f=await fixture(t,{chat:(_body,count)=>count===1?response('',[native(other.id)]):response('Image unavailable.')});other=await f.artifacts.put({name:'other.png',mimeType:'image/png',dataBase64:encodeRgbaPng('not attached').png.toString('base64')});
 const run=await f.terminal((await f.start()).id);assert.equal(run.status,'completed');assert.equal(f.state.helperCalls.length,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_auxiliary_generations').get().n,0);
 const result=f.agent.events(run.id).find(event=>event.type==='tool_result').data.result;assert.match(result.error,/not attached/);assert.ok(!JSON.stringify(result).includes(other.sha256));
});

test('source integrity failure stops before any helper model request',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.assetsDir,f.asset.id+'.bin'),Buffer.from('changed bytes'));
 const run=await f.terminal((await f.start()).id);assert.equal(run.status,'failed');assert.equal(f.state.helperCalls.length,0);assert.equal(f.state.chats.length,0);
});

test('cancelled helper settles late known actuals without reviving run, emitting observation or losing tracked cleanup',async t=>{
 let release,entered=false;const f=await fixture(t,{analyze:async(input,state)=>{
  input.beforeRequest({estimatedInputTokens:5000,maxOutputTokens:input.maxOutputTokens});entered=true;await new Promise(resolve=>{release=resolve;state.releases.push(resolve);});
  return {text:'Late observed answer',identity:{provider:'ollama',model:'gemma3:latest',digest:'a'.repeat(64)},imageSha256:'b'.repeat(64),dimensions:{width:1,height:1},usage:{inputTokens:600,outputTokens:30,costUsd:0}};
 }});
 const run=await f.start();await until(()=>entered);assert.equal(f.agent.get(run.id).usage.reservedOutputTokens,256);f.agent.cancel(run.id);assert.equal(f.agent.get(run.id).status,'cancelled');
 release();await until(()=>f.agent.get(run.id).usage.auxiliaryOutputTokens===30);
 const saved=f.agent.get(run.id);assert.equal(saved.status,'cancelled');assert.equal(saved.usage.totalTokens,740);assert.equal(saved.usage.reservedOutputTokens,0);assert.equal(saved.usage.reservedInputTokens,0);assert.equal(f.state.chats.length,1);
 assert.ok(!f.agent.events(run.id).some(event=>event.type==='tool_result'&&event.data.result?.observation));
});

test('unknown dispatch preserves input and output holds, deducts future allowance and reports no fabricated actuals',async t=>{
 const f=await fixture(t,{analyze:async input=>{input.beforeRequest({estimatedInputTokens:5000,maxOutputTokens:256});throw Object.assign(new Error('Unknown response'),{dispatched:true});}});
 const run=await f.terminal((await f.start()).id);assert.equal(run.status,'completed');assert.equal(run.usage.auxiliaryInputTokens,0);assert.equal(run.usage.auxiliaryOutputTokens,0);assert.equal(run.usage.reservedInputTokens,5000);assert.equal(run.usage.reservedOutputTokens,256);assert.equal(run.usage.auxiliaryUsageKnown,false);
 assert.ok(f.state.chats[1].options.num_predict<=1782);assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_auxiliary_generations WHERE status='unknown'").get().n,1);
});

test('known helper failure is charged and output overage blocks a second model request',async t=>{
 const f=await fixture(t,{analyze:async input=>{input.beforeRequest({estimatedInputTokens:5000,maxOutputTokens:256});throw Object.assign(new Error('Provider exceeded requested output'),{dispatched:true,usage:{inputTokens:500,outputTokens:3000,costUsd:0}});}});
 const run=await f.terminal((await f.start()).id);assert.equal(run.status,'failed');assert.equal(run.error.code,'budget_tokens');assert.equal(run.usage.auxiliaryInputTokens,500);assert.equal(run.usage.auxiliaryOutputTokens,3000);assert.equal(run.usage.outputTokens,3010);assert.equal(run.usage.reservedOutputTokens,0);assert.equal(f.state.chats.length,1);
});

test('partially known helper input is actual and only missing output retains a hold',async t=>{
 const f=await fixture(t,{analyze:async input=>{input.beforeRequest({estimatedInputTokens:5000,maxOutputTokens:256});throw Object.assign(new Error('Output count missing'),{dispatched:true,usage:{inputTokens:7000,costUsd:0}});}});
 const run=await f.terminal((await f.start({budget:{maxTotalTokens:64000}})).id);assert.equal(run.status,'completed');assert.equal(run.usage.auxiliaryInputTokens,7000);assert.equal(run.usage.auxiliaryOutputTokens,0);assert.equal(run.usage.reservedInputTokens,0);assert.equal(run.usage.reservedOutputTokens,256);assert.equal(run.usage.auxiliaryUsageKnown,false);
});

test('known helper input over per-request limit terminates before another inference even with cumulative headroom',async t=>{
 const f=await fixture(t,{analyze:async input=>{input.beforeRequest({estimatedInputTokens:5000,maxOutputTokens:256});throw Object.assign(new Error('Output count missing'),{dispatched:true,usage:{inputTokens:17000,costUsd:0}});}});
 const run=await f.terminal((await f.start({budget:{maxInputTokens:16384,maxTotalTokens:64000}})).id);assert.equal(run.status,'failed');assert.equal(run.error.code,'budget_context');assert.equal(run.usage.auxiliaryInputTokens,17000);assert.equal(run.usage.reservedInputTokens,0);assert.equal(run.usage.reservedOutputTokens,256);assert.equal(f.state.chats.length,1);
});
