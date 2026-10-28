import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createWorkspacePolicy} from '../server/agent/workspace.js';
import {createWorkspaceEditTool,planLiteralEdits,recoverWorkspaceEffects} from '../server/agent/workspace-edit.js';
import {createAgentService} from '../server/agent/service.js';
import {builtinTools} from '../server/agent/tools.js';
import {hash,stableJson} from '../server/agent/schema.js';

async function fixture(t,text='alpha beta\n') {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chandra-edit-')),original=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE agent_approvals(id TEXT PRIMARY KEY,run_id TEXT,tool_name TEXT,args_json TEXT,args_hash TEXT,preview_json TEXT,status TEXT)');
  const policy=createWorkspacePolicy(directory),target=path.join(directory,'sample.txt');await fs.writeFile(target,text,'utf8');
  const receipts=[],tool=createWorkspaceEditTool({db,policy,onReceipt:(id,receipt)=>receipts.push({id,receipt})});
  const args=edits=>({path:'sample.txt',expectedHash:hash(text),edits});
  const context=args=>({args,run:{id:'edit-source'},signal:new AbortController().signal});
  function approve(ctx,preview,status='consumed') {
    const id='approval-'+db.prepare('SELECT count(*) AS n FROM agent_approvals').get().n,argsJson=stableJson(ctx.args);
    db.prepare('INSERT INTO agent_approvals VALUES(?,?,?,?,?,?,?)').run(id,ctx.run.id,'workspace.edit',argsJson,hash('workspace.edit\n'+argsJson),JSON.stringify(preview),status);
    return {...ctx,approvalId:id};
  }
  t.after(async()=>{db.close();const resolved=await fs.realpath(directory);assert.equal(resolved,original);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('chandra-edit-'));await fs.rm(resolved,{recursive:true,force:true});});
  return {db,policy,target,directory,tool,receipts,args,context,approve};
}

test('approved literal edits preserve untouched BOM, mixed terminators and UTF-8 bytes',async t=>{
  const original='\uFEFFalpha😀\r\nbeta\nz\r',f=await fixture(t,original),ctx=f.context(f.args([{oldText:'alpha😀',newText:'changed😀'},{oldText:'beta',newText:'beta\r\nplus'}]));
  const preview=await f.tool.prepare(ctx);assert.equal(preview.utf8Bom,true);assert.deepEqual(preview.lineEndings,{lf:1,crlf:1,cr:1});
  assert.equal(preview.edits[0].startColumn,2);assert.equal(preview.edits[1].startLine,2);assert.equal(preview.complete,true);
  const result=await f.tool.execute(f.approve(ctx,preview)),expected=Buffer.from('\uFEFFchanged😀\r\nbeta\r\nplus\nz\r');
  assert.deepEqual(await fs.readFile(f.target),expected);assert.equal(result.receipt.outcome,'verified');assert.equal(result.sha256,hash(expected));assert.equal(result.receipt.atomic,false);
  assert.equal(f.receipts.length,1);assert.equal(f.db.prepare('SELECT status FROM agent_workspace_effects').get().status,'verified');
});

test('all replacements refer to the same original; reverse input order gives the same result',async t=>{
  const f=await fixture(t),file=await f.policy.read('sample.txt'),edits=[{oldText:'alpha',newText:'beta'},{oldText:'beta',newText:'gamma'}];
  const one=planLiteralEdits(file,f.args(edits)),two=planLiteralEdits(file,f.args(edits.slice().reverse()));
  assert.equal(one.content,'beta gamma\n');assert.deepEqual(one,two);assert.equal(one.preview.edits[1].newStartColumn,6);
  const adjacent=planLiteralEdits({...file,text:'ab',sha256:hash('ab'),bytes:2}, {path:'sample.txt',expectedHash:hash('ab'),edits:[{oldText:'a',newText:''},{oldText:'b',newText:'B'}]});assert.equal(adjacent.content,'B');
  assert.throws(()=>planLiteralEdits({...file,text:'ab',sha256:hash('ab'),bytes:2},{path:'sample.txt',expectedHash:hash('ab'),edits:[{oldText:'a',newText:''},{oldText:'b',newText:'ab'}]}),{code:'edit_no_change'});
});

test('ambiguous, self-overlapping, overlapping, empty, invalid and no-op edits fail before mutation',async t=>{
  const f=await fixture(t,'aaa alpha\r\n'),file=await f.policy.read('sample.txt');
  for(const [edits,code] of [
    [[{oldText:'aa',newText:'b'}],'edit_ambiguous'],
    [[{oldText:'alpha',newText:'x'},{oldText:'lpha',newText:'y'}],'edit_overlap'],
    [[{oldText:'absent',newText:'x'}],'edit_not_found'],
    [[{oldText:'alpha',newText:'alpha'}],'edit_no_change'],
    [[{oldText:'',newText:'x'}],'invalid_arguments'],
    [[{oldText:'alpha',newText:'\ud800'}],'invalid_text'],
    [[{oldText:'alpha',newText:'x\0y'}],'invalid_text'],
    [[{oldText:'\n',newText:'x'}],'edit_boundary'],
    [Array.from({length:9},()=>({oldText:'alpha',newText:'x'})),'invalid_arguments'],
  ])assert.throws(()=>planLiteralEdits(file,f.args(edits)),{code});
  assert.deepEqual(f.receipts,[]);assert.equal(await fs.readFile(f.target,'utf8'),'aaa alpha\r\n');
});

test('actual serialized approval size and UTF-8 output size are hard limits',async t=>{
  const f=await fixture(t,'\\'.repeat(12000)),ctx=f.context(f.args([{oldText:'\\'.repeat(12000),newText:'x'.repeat(12000)}]));
  await assert.rejects(f.tool.prepare(ctx),{code:'edit_preview_too_large'});
  const text='a'+'😀'.repeat(65000),file={path:'large.txt',text,bytes:Buffer.byteLength(text),sha256:hash(text),utf8Bom:false,lineEndings:{lf:0,crlf:0,cr:0}};
  assert.throws(()=>planLiteralEdits(file,{path:'large.txt',expectedHash:file.sha256,edits:[{oldText:'a',newText:'😀'.repeat(1000)}]}),{code:'file_too_large'});
});

test('raw read preserves selected terminators and search uses the same CR-aware line references',async t=>{
  const f=await fixture(t,'\uFEFFone\r\ntwo\rthree\nfour'),read=builtinTools({db:f.db,policy:f.policy}).find(tool=>tool.name==='workspace.read');
  const raw=await read.execute({args:{path:'sample.txt',startLine:1,endLine:3,preserveLineEndings:true}});
  assert.equal(raw.content,'\uFEFFone\r\ntwo\rthree\n');assert.equal(raw.totalLines,4);
  const normal=await read.execute({args:{path:'sample.txt',startLine:1,endLine:3}});assert.equal(normal.content,'\uFEFFone\ntwo\nthree');
  const matches=await f.policy.search({query:'three'});assert.equal(matches.matches[0].line,3);
  assert.equal((await read.execute({args:{path:'sample.txt',startLine:3,endLine:3}})).content,'three');
});

test('file changes and changed or incomplete approvals cannot authorize an edit',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}])),preview=await f.tool.prepare(ctx);
  await assert.rejects(f.tool.execute(f.approve(ctx,preview,'pending')),{code:'approval_mismatch'});
  await assert.rejects(f.tool.execute(f.approve(ctx,{...preview,complete:false})),{code:'approval_mismatch'});
  await assert.rejects(f.tool.execute(f.approve(ctx,{...preview,newHash:hash('forged')})),{code:'approval_mismatch'});
  const approved=f.approve(ctx,preview);await fs.writeFile(f.target,'External work must survive.');
  await assert.rejects(f.tool.execute(approved),{code:'write_conflict'});assert.equal(await fs.readFile(f.target,'utf8'),'External work must survive.');
});

test('cancellation after a committed write still records exact independent readback',async t=>{
  const f=await fixture(t),controller=new AbortController(),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}]));ctx.signal=controller.signal;
  const tool=createWorkspaceEditTool({db:f.db,policy:{...f.policy,write:async(...args)=>{const result=await f.policy.write(...args);controller.abort();return result;}},onReceipt:(id,receipt)=>f.receipts.push({id,receipt})});
  const approved=f.approve(ctx,await tool.prepare(ctx)),result=await tool.execute(approved);
  assert.equal(controller.signal.aborted,true);assert.equal(result.receipt.outcome,'verified');assert.equal(f.receipts.length,1);assert.equal(await fs.readFile(f.target,'utf8'),'new beta\n');
});

test('post-dispatch failure is an unknown durable effect and the same approval never writes twice',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}]));let writes=0;
  const tool=createWorkspaceEditTool({db:f.db,policy:{...f.policy,write:async(args,options)=>{writes++;options.beforeDispatch();await fs.writeFile(f.target,'partial');throw new Error('Synthetic fsync failure');}},onReceipt:(id,receipt)=>f.receipts.push({id,receipt})});
  const approved=f.approve(ctx,await tool.prepare(ctx)),result=await tool.execute(approved);
  assert.equal(result.ok,false);assert.equal(result.receipt.outcome,'unknown');assert.equal(result.receipt.dispatchAttempted,true);assert.equal(result.code,'edit_write_unknown');
  assert.equal((await tool.execute(approved)).receipt.effectId,result.receipt.effectId);assert.equal(writes,1);assert.equal(await fs.readFile(f.target,'utf8'),'partial');
});

test('changed readback stays unknown and never claims a planned hash was observed',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}]));
  const tool=createWorkspaceEditTool({db:f.db,policy:{...f.policy,write:async(...args)=>{await f.policy.write(...args);await fs.writeFile(f.target,'Another writer changed it.');}},onReceipt:()=>{}});
  const result=await tool.execute(f.approve(ctx,await tool.prepare(ctx)));
  assert.equal(result.receipt.outcome,'unknown');assert.equal(result.receipt.observedHash,hash('Another writer changed it.'));assert.notEqual(result.receipt.newHash,result.receipt.observedHash);
});

test('receipt observers cannot turn a persisted unknown edit into a verified returned result',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}]));let observed;
  const tool=createWorkspaceEditTool({db:f.db,policy:{...f.policy,write:async(_args,options)=>{options.beforeDispatch();throw new Error('Synthetic postdispatch failure');}},onReceipt:(_id,receipt)=>{
    observed=receipt;assert.equal(Object.isFrozen(receipt),true);try{receipt.outcome='verified';receipt.verified=true;}catch{}
  }});
  const result=await tool.execute(f.approve(ctx,await tool.prepare(ctx)));assert.equal(result.ok,false);assert.equal(result.receipt.outcome,'unknown');assert.equal(result.receipt.verified,false);assert.notEqual(result.receipt,observed);
  assert.equal(JSON.parse(f.db.prepare('SELECT receipt_json FROM agent_workspace_effects').get().receipt_json).outcome,'unknown');
});

test('async receipt observers are not falsely acknowledged and recovery only retries notification',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}]));let writes=0;
  const tool=createWorkspaceEditTool({db:f.db,policy:{...f.policy,write:async(...args)=>{writes++;return f.policy.write(...args);}},onReceipt:()=>Promise.reject(new Error('Synthetic async observer failed'))});
  const result=await tool.execute(f.approve(ctx,await tool.prepare(ctx)));assert.equal(result.receipt.outcome,'verified');assert.equal(f.db.prepare('SELECT notified_at FROM agent_workspace_effects').get().notified_at,null);
  let notifications=0;recoverWorkspaceEffects(f.db,(_id,receipt)=>{notifications++;assert.equal(Object.isFrozen(receipt),true);assert.equal(receipt.outcome,'verified');});
  assert.equal(notifications,1);assert.equal(writes,1);assert.ok(f.db.prepare('SELECT notified_at FROM agent_workspace_effects').get().notified_at);
});

test('cached terminal receipt corruption cannot claim a different outcome or repeat an approved write',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}]));let writes=0;
  const tool=createWorkspaceEditTool({db:f.db,policy:{...f.policy,write:async(...args)=>{writes++;return f.policy.write(...args);}}}),approved=f.approve(ctx,await tool.prepare(ctx));
  const result=await tool.execute(approved);assert.equal(result.ok,true);
  f.db.prepare('UPDATE agent_workspace_effects SET receipt_json=?').run(JSON.stringify({...result.receipt,outcome:'unknown',verified:false}));
  await assert.rejects(tool.execute(approved),{code:'edit_journal_corrupt'});assert.equal(writes,1);assert.equal(await fs.readFile(f.target,'utf8'),'new beta\n');
});

test('unsafe SQLite synchronous mode refuses a new edit before staging or dispatch',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}])),approved=f.approve(ctx,await f.tool.prepare(ctx));
  f.db.exec('PRAGMA synchronous=NORMAL');await assert.rejects(f.tool.execute(approved),{code:'workspace_journal_not_durable'});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_effects').get().n,0);assert.equal(await fs.readFile(f.target,'utf8'),'alpha beta\n');
});

test('a synchronous downgrade after staging prevents dispatch and never claims a write happened',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}]));
  const tool=createWorkspaceEditTool({db:f.db,policy:{...f.policy,write:async(...args)=>{f.db.exec('PRAGMA synchronous=NORMAL');return f.policy.write(...args);}}});
  const result=await tool.execute(f.approve(ctx,await tool.prepare(ctx)));assert.equal(result.receipt.outcome,'not_dispatched');assert.equal(result.receipt.dispatchAttempted,false);assert.equal(await fs.readFile(f.target,'utf8'),'alpha beta\n');
});

test('restart preserves dispatch uncertainty and retries only missing acknowledgement, never the write',async t=>{
  const f=await fixture(t),ctx=f.context(f.args([{oldText:'alpha',newText:'new'}])),preview=await f.tool.prepare(ctx);
  for(const [id,status] of [['before','prepared'],['after','dispatching']])f.db.prepare('INSERT INTO agent_workspace_effects(id,run_id,approval_id,args_hash,path,expected_hash,new_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'run',id,'unused','sample.txt',preview.expectedHash,preview.newHash,status,1,1);
  const receipts=[];recoverWorkspaceEffects(f.db,(id,receipt)=>receipts.push(receipt));
  assert.equal(receipts.find(receipt=>receipt.effectId==='before').outcome,'not_dispatched');assert.equal(receipts.find(receipt=>receipt.effectId==='after').outcome,'unknown');
  recoverWorkspaceEffects(f.db,()=>assert.fail('Acknowledged effects must not replay'));assert.equal(await fs.readFile(f.target,'utf8'),'alpha beta\n');
  const silent=createWorkspaceEditTool({db:f.db,policy:f.policy,onReceipt:()=>{throw new Error('Synthetic observer failure');}});
  const result=await silent.execute(f.approve(ctx,preview));assert.equal(result.receipt.outcome,'verified');
  const recovered=[];recoverWorkspaceEffects(f.db,(id,receipt)=>recovered.push(receipt));assert.equal(recovered.length,1);assert.equal(recovered[0].effectId,result.receipt.effectId);
});

test('cooperative writers across policy instances serialize the exact-hash precondition',async t=>{
  const f=await fixture(t),other=createWorkspacePolicy(f.directory),expectedHash=hash('alpha beta\n');
  const results=await Promise.allSettled([f.policy.write({path:'sample.txt',expectedHash,content:'first'}),other.write({path:'sample.txt',expectedHash,content:'second'})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.code,'write_conflict');
  assert.ok(['first','second'].includes(await fs.readFile(f.target,'utf8')));
});

test('native service persists the full edit receipt when the model tool-result budget is256',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chandra-edit-service-')),target=path.join(directory,'source.js'),original='export const value = 1;\r\n';await fs.writeFile(target,original);
  const db=new DatabaseSync(':memory:');let calls=0;
  const response=(text,calls=[])=>Response.json({done:true,prompt_eval_count:100,eval_count:10,message:{role:'assistant',content:text,...(calls.length?{tool_calls:calls}:{})}});
  const call=(name,args)=>({function:{name,arguments:args}});
  const agent=createAgentService({db,workspace:directory,fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/api/show')return Response.json({capabilities:['completion','tools']});
    const body=JSON.parse(options.body);calls++;
    if(calls===1)return response('',[call('tools.enable',{group:'coding'})]);
    if(calls===2)return response('',[call('workspace.edit',{path:'source.js',expectedHash:hash(original),edits:[{oldText:'value = 1',newText:'value = 2'}]})]);
    assert.ok(body.messages.at(-1).content.includes('verified'));return response('The approved edit is verified.');
  }});
  t.after(async()=>{await agent.close();db.close();await fs.unlink(target);await fs.rmdir(directory);});
  const run=await agent.start({requestId:'native-edit',goal:'Change the fixture constant.',model:'test:local',budget:{maxToolResultChars:256}});
  const until=async predicate=>{for(let i=0;i<500;i++){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Agent fixture timed out');};
  const approval=await until(()=>agent.get(run.id).approval);assert.equal(approval.name,'workspace.edit');assert.equal(await fs.readFile(target,'utf8'),original);
  agent.approve(run.id,{approvalId:approval.approvalId,approved:true});await until(()=>agent.get(run.id).status==='completed');
  const events=agent.events(run.id),receipt=events.find(event=>event.type==='workspace_receipt').data.receipt,result=events.find(event=>event.type==='tool_result'&&event.data.name==='workspace.edit');
  assert.equal(receipt.outcome,'verified');assert.equal(result.data.receipt.observedHash,hash('export const value = 2;\r\n'));assert.equal(result.data.result.outcome,'verified');assert.ok(JSON.stringify(result.data.result).length<=256);
});
