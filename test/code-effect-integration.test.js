import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAgentService} from '../server/agent/service.js';
const MODEL='code-audit-fixture:local',ORIGIN='http://127.0.0.1:49942';
const goodReceipt=extra=>({ok:true,exitCode:0,stdout:'42\n',stderr:'',sandboxed:true,engine:'docker',isolation:'docker-linux',network:false,hostMounts:false,language:'javascript',image:'sha256:'+'a'.repeat(64),termination:'exit',cleanup:{removed:true,verifiedAbsent:true,name:'fraymus-code-fixture'},...extra});
const response=(calls)=>({done:true,done_reason:'stop',prompt_eval_count:100,eval_count:10,message:{role:'assistant',content:calls?'':'The recorded fixture completed.',...(calls?{tool_calls:calls}:{})}});
async function until(predicate){const end=Date.now()+4000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Code audit fixture timed out');}
async function fixture(t,{runImpl,sibling=false,allowContinuation=true,onEvent}={}){
 const parent=await fs.realpath(path.resolve(import.meta.dirname,'../../work')),folder=await fs.mkdtemp(path.join(parent,'code-audit-integration-')),original=await fs.realpath(folder),db=new DatabaseSync(':memory:');
 const state={engineCalls:0,chats:0,events:[],releases:[],services:[]};
 function makeService(){
  const agent=createAgentService({db,workspace:folder,ollamaUrl:ORIGIN,codeExecutor:{kind:'docker',health:async()=>({kind:'docker',engine:'docker',isolation:'docker-linux',available:true}),run:async(args,options)=>{state.engineCalls++;return runImpl?runImpl(args,options,state,db):goodReceipt();}},
   onEvent:event=>{state.events.push(event);try{onEvent?.(event);}catch{}},fetchImpl:async(url,options)=>{
    assert.equal(new URL(url).origin,ORIGIN);if(new URL(url).pathname==='/api/show')return Response.json({capabilities:['completion','tools']});
    assert.equal(new URL(url).pathname,'/api/chat');state.chats++;
    const body=JSON.parse(options.body),hasResult=body.messages.some(message=>message.role==='tool');
    if(!hasResult)return Response.json(response([{function:{name:'code.run',arguments:{language:'javascript',code:'console.log(6 * 7)',timeoutMs:1000}}},...(sibling?[{function:{name:'workspace.write',arguments:{path:'must-not-run.txt',content:'unapproved',createOnly:true}}}]:[])]));
    assert.equal(allowContinuation,true,'Uncertain cleanup must prevent another inference');return Response.json(response());
   }});state.services.push(agent);return agent;
 }
 const agent=makeService();t.after(async()=>{state.releases.forEach(resolve=>resolve());for(const service of state.services)assert.equal((await service.close()).callbacksSettled,true);db.close();assert.equal(await fs.realpath(folder),original);assert.equal(path.dirname(original),parent);assert.ok(path.basename(original).startsWith('code-audit-integration-'));assert.deepEqual(await fs.readdir(folder),[]);await fs.rmdir(folder);});
 return {agent,db,state,folder,makeService,start:(service=agent,id='source')=>service.start({requestId:id,conversationId:id,goal:'Use the code tool for this synthetic arithmetic fixture.',model:MODEL}),terminal:(service,id)=>until(()=>{const run=service.get(id);return ['completed','failed','cancelled'].includes(run.status)&&run;})};
}

test('known Docker lifecycle is independently durable before ordinary tool result, without storing code/output twice',async t=>{
 const f=await fixture(t,{runImpl:async(_args,{executionId,onResource},_state,db)=>{
  assert.equal(typeof onResource,'function');const resource={version:1,engine:'docker',executionId,endpoint:'npipe:////./pipe/dockerDesktopLinuxEngine',daemonId:'fixture-daemon',name:'fraymus-code-'+executionId,image:'sha256:'+'a'.repeat(64)};
  assert.equal(db.prepare('SELECT status FROM agent_code_effects WHERE id=?').get(executionId).status,'dispatching');
  onResource(resource);assert.deepEqual(JSON.parse(db.prepare('SELECT resource_json FROM agent_code_effects WHERE id=?').get(executionId).resource_json),resource);
  const witnessed={...resource,containerId:'c'.repeat(64)};onResource(witnessed);
  assert.equal(JSON.parse(db.prepare('SELECT resource_json FROM agent_code_effects WHERE id=?').get(executionId).resource_json).containerId,witnessed.containerId);
  return goodReceipt({resource:witnessed,cleanup:{removed:true,verifiedAbsent:true,name:resource.name}});
 }}),run=await f.terminal(f.agent,(await f.start()).id);assert.equal(run.status,'completed');
 const events=f.agent.events(run.id),audit=events.find(event=>event.type==='code_receipt'),tool=events.find(event=>event.type==='tool_result');
 assert.ok(audit.sequence<tool.sequence);assert.equal(audit.data.receipt.outcome,'finished');assert.equal(audit.data.receipt.cleanup.confirmed,true);assert.equal(audit.data.receipt.proof.programOk,true);
 const row=f.db.prepare('SELECT * FROM agent_code_effects').get();assert.equal(row.status,'settled');assert.ok(!row.receipt_json.includes('console.log'));assert.ok(!row.receipt_json.includes('stdout'));assert.equal(f.state.engineCalls,1);assert.equal((await f.agent.capabilities()).codeExecution.available,true);
 assert.equal(audit.data.receipt.proof.resource.containerId,'c'.repeat(64));assert.equal(JSON.parse(row.resource_json).executionId,row.id);
});

test('late cleanup after cancellation is journaled without source revival or ordinary tool-result publication',async t=>{
 let release,entered=false;const f=await fixture(t,{runImpl:async(_args,_options,state)=>{entered=true;await new Promise(resolve=>{release=resolve;state.releases.push(resolve);});return goodReceipt({ok:false,exitCode:137,termination:'cancelled'});}});
 const started=await f.start();await until(()=>entered);f.agent.cancel(started.id);assert.equal(f.agent.get(started.id).status,'cancelled');assert.equal((await f.agent.close({timeoutMs:20})).callbacksSettled,false);
 release();await until(()=>f.agent.events(started.id).some(event=>event.type==='code_receipt'));
 const saved=f.agent.get(started.id),events=f.agent.events(started.id);assert.equal(saved.status,'cancelled');assert.ok(events.some(event=>event.type==='code_receipt'&&event.data.receipt.cleanup.confirmed));assert.ok(!events.some(event=>event.type==='tool_result'));assert.equal(f.state.chats,1);assert.equal(f.db.prepare('SELECT status FROM agent_code_effects').get().status,'settled');
});

test('unknown cleanup stops a sibling effect and remains quarantined after service restart',async t=>{
 const f=await fixture(t,{sibling:true,allowContinuation:false,runImpl:async()=>{throw Object.assign(new Error('Synthetic lost cleanup'),{code:'sandbox_cleanup_failed'});}});
 const first=await f.terminal(f.agent,(await f.start()).id);assert.equal(first.status,'failed');assert.equal(first.error.code,'code_cleanup_unknown');assert.equal(f.state.engineCalls,1);assert.ok(!first.pendingApproval);await assert.rejects(fs.access(path.join(f.folder,'must-not-run.txt')),{code:'ENOENT'});
 const receipt=f.agent.events(first.id).find(event=>event.type==='code_receipt').data.receipt;assert.equal(receipt.cleanup.confirmed,false);assert.equal((await f.agent.capabilities()).codeExecution.available,false);
 await f.agent.close();const restarted=f.makeService();assert.equal((await restarted.capabilities()).codeExecution.available,false);
 const second=await f.terminal(restarted,(await f.start(restarted,'second')).id);assert.equal(second.error.code,'code_cleanup_unknown');assert.equal(f.state.engineCalls,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_code_effects').get().n,1);
});

test('a verified never-created native failure is recorded without permanent quarantine',async t=>{
 const f=await fixture(t,{runImpl:async()=>{throw Object.assign(new Error('Queued request cancelled before launch'),{code:'cancelled',executionAudit:{engine:'docker',dispatchAttempted:false,codeMayHaveRun:false,isolationVerified:false,termination:'not_started',cleanup:{confirmed:true,notCreated:true},proof:{isolation:'docker-linux'}}});}});
 const run=await f.terminal(f.agent,(await f.start()).id);assert.equal(run.status,'completed');const receipt=f.agent.events(run.id).find(event=>event.type==='code_receipt').data.receipt;
 assert.equal(receipt.outcome,'not_started');assert.equal(receipt.codeMayHaveRun,false);assert.equal(receipt.cleanup.confirmed,true);assert.equal((await f.agent.capabilities()).codeExecution.available,true);
});

test('failed lifecycle persistence blocks new execution in the same process and after recovery',async t=>{
 let restore;const f=await fixture(t,{sibling:true,allowContinuation:false,runImpl:async(_args,_options,_state,db)=>{
  const originalPrepare=db.prepare.bind(db);restore=()=>{db.prepare=originalPrepare;};db.prepare=sql=>{if(sql.startsWith('UPDATE agent_code_effects SET status=?'))throw new Error('Synthetic independent audit write failure');return originalPrepare(sql);};return goodReceipt();
 }});
 const first=await f.terminal(f.agent,(await f.start()).id);restore();assert.equal(first.status,'failed');assert.equal(first.error.code,'code_cleanup_unknown');assert.equal((await f.agent.capabilities()).codeExecution.available,false);assert.equal(f.db.prepare('SELECT status FROM agent_code_effects').get().status,'dispatching');
 const next=await f.terminal(f.agent,(await f.start(f.agent,'next')).id);assert.equal(next.error.code,'code_cleanup_unknown');assert.equal(f.state.engineCalls,1);
 await f.agent.close();const restarted=f.makeService();assert.equal(f.db.prepare('SELECT status FROM agent_code_effects').get().status,'unknown');assert.equal((await restarted.capabilities()).codeExecution.available,false);
});

test('event observers cannot relabel independent cleanup proof or bypass the quarantine stop',async t=>{
 let frozen=false;const f=await fixture(t,{sibling:true,allowContinuation:false,runImpl:async()=>{throw new Error('Synthetic unverified execution');},onEvent:event=>{
  if(event.type==='code_receipt'){frozen=Object.isFrozen(event.data.receipt.cleanup);event.data.receipt.cleanup.confirmed=true;}
 }});
 const run=await f.terminal(f.agent,(await f.start()).id);assert.equal(run.error.code,'code_cleanup_unknown');assert.equal(frozen,true);assert.equal(JSON.parse(f.db.prepare('SELECT receipt_json FROM agent_code_effects').get().receipt_json).cleanup.confirmed,false);assert.ok(!run.pendingApproval);
});
