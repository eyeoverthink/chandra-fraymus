import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDockerCleanupObserver } from '../server/sandbox/observe-cleanup.js';
import { dockerResourceIdentity, DEFAULT_DOCKER_PATH } from '../server/sandbox/resource-identity.js';
import { createCodeEffectStore } from '../server/agent/code-effects.js';
import { reconcileSandbox } from '../server/sandbox/reconcile.js';
import { acquireDataLock } from '../server/data-lock.js';
const endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const resource = (executionId = randomUUID()) => ({version:1,engine:'docker',executionId,endpoint,daemonId:'test-daemon',name:'fraymus-code-'+executionId,image:'sha256:'+'a'.repeat(64),containerId:'c'.repeat(64)});
const missing = reference => Object.assign(new Error('inspect failed'), { code: 1, stdout: '', stderr: 'Error: No such object: ' + reference });
function engine(extra = {}) {
  const calls=[]; let infos=0, inspections=0;
  const execute=async (file,args,options)=>{
    calls.push({file,args,options});
    const cmd=args.slice(4);
    if(cmd[0]==='info') { infos++;return {stdout:JSON.stringify({OSType:'linux',ID:infos===2&&extra.changedDaemon?'different-daemon':'test-daemon'})}; }
    assert.deepEqual(cmd.slice(0,4),['container','inspect','--format','{{json .}}']);
    inspections++;
    if(extra.presentAt===inspections)return {stdout:JSON.stringify({Id:'d'.repeat(64)})};
    throw extra.inspectError?.(cmd.at(-1))??missing(cmd.at(-1));
  };
  return {calls,observer:createDockerCleanupObserver({dockerHost:endpoint,execFileImpl:execute})};
}

test('cleanup observation uses six bounded read-only commands with exact ID/name and same daemon before/after',async()=>{
  const h=engine(),r=resource();const proof=await h.observer(r);
  assert.deepEqual({...proof,observedAt:0},{confirmed:true,endpoint,daemonId:r.daemonId,name:r.name,containerId:r.containerId,checks:2,observedAt:0});
  assert.equal(Object.isFrozen(proof),true);assert.equal(h.calls.length,6);
  assert.deepEqual(h.calls.slice(1,5).map(c=>c.args.at(-1)),[r.containerId,r.name,r.containerId,r.name]);
  for(const call of h.calls){
    assert.equal(call.file,DEFAULT_DOCKER_PATH);assert.equal(call.options.windowsHide,true);assert.equal(call.options.shell,false);
    assert.equal(call.options.timeout,2000);assert.ok(call.options.maxBuffer<=131072);
    assert.deepEqual(call.args.slice(0,3),['--host',endpoint,'--config']);
    assert.ok(!Object.keys(call.options.env).some(key=>key.startsWith('DOCKER_')));
  }
});

test('a present ID, conflicting name, or late second-round appearance refuses reconciliation without removing anything',async()=>{
  for(const presentAt of [1,2,3,4]){
    const h=engine({presentAt});await assert.rejects(h.observer(resource()),{code:'code_resource_present'});
    assert.ok(h.calls.every(call=>['info','container'].includes(call.args[4])));
  }
});

test('daemon switch and different local endpoint cannot clear another resource owner',async()=>{
  const h=engine({changedDaemon:true});await assert.rejects(h.observer(resource()),{code:'code_resource_daemon'});
  const other=engine();await assert.rejects(other.observer({...resource(),endpoint:'npipe:////./pipe/docker_engine'}),{code:'code_resource_endpoint'});assert.equal(other.calls.length,0);
});

test('only exact missing-object stderr and exit1 with empty stdout establish absence',async()=>{
  const variants=[
    ref=>Object.assign(missing(ref),{code:'ETIMEDOUT'}),
    ref=>Object.assign(missing(ref),{killed:true}),
    ref=>Object.assign(missing(ref),{stdout:'unexpected output'}),
    ref=>Object.assign(missing(ref),{stderr:'connection failed\nError: No such object: '+ref}),
    ref=>missing(ref+'-other'),
    ref=>Object.assign(missing(ref),{signal:'SIGKILL'})
  ];
  for(const inspectError of variants)await assert.rejects(engine({inspectError}).observer(resource()),{code:'code_reconcile_unavailable'});
});

test('missing running witness, extra metadata, wrong image/name or remote endpoint is rejected before a command',async()=>{
  const r=resource();const variants=[{...r,containerId:undefined},{...r,extra:'ignored?'},{...r,image:'node:latest'},
    {...r,name:'another-container'},{...r,endpoint:'tcp://localhost:2375'}];
  for(const value of variants){const h=engine();await assert.rejects(h.observer(value));assert.equal(h.calls.length,0);}
  assert.throws(()=>dockerResourceIdentity({...r,executionId:'bad'},r.executionId));
});

async function fixture(t,{witness=true,terminal=true}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fraymus-reconcile-test-'));
  t.after(async()=>{for(const name of ['chandra.db','chandra.db-wal','chandra.db-shm'])await fs.unlink(path.join(directory,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});await fs.rmdir(directory);});
  const databaseFile=path.join(directory,'chandra.db'),db=new Database(databaseFile);
  db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');
  db.exec(`CREATE TABLE agent_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,deadline_at INTEGER NOT NULL,usage_json TEXT NOT NULL);
    CREATE TABLE agent_run_events(run_id TEXT NOT NULL,sequence INTEGER NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,sequence));`);
  db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?)').run('source','running',Date.now()+60000,'{"totalTokens":12}');
  const store=createCodeEffectStore({db});const ticket=store.begin({runId:'source',callId:'native-call',engine:'docker',language:'python',argsHash:'b'.repeat(64)});
  store.dispatch(ticket);const r=resource(ticket.executionId);const {containerId,...binding}=r;
  store.recordResource(ticket,binding);if(witness)store.recordResource(ticket,r);
  store.settle(ticket,{outcome:'unknown',dispatchAttempted:true,codeMayHaveRun:true,isolationVerified:false,termination:'interrupted_unknown',cleanup:{confirmed:false},proof:{recovered:true}});
  if(terminal)db.prepare("UPDATE agent_runs SET status='cancelled'").run();db.close();
  return {directory,databaseFile,executionId:ticket.executionId,resource:r};
}

test('offline reconciliation commits only cleanup facts, records receipt history, preserves cancellation/usage and reopens cleanly',async t=>{
  const f=await fixture(t),h=engine();const result=await reconcileSandbox({dataDir:f.directory,executionId:f.executionId,observe:h.observer});
  assert.deepEqual(result.quarantined,[]);assert.equal(result.receipt.cleanup.confirmed,true);assert.equal(result.receipt.cleanup.verifiedAbsent,true);
  assert.equal(result.receipt.cleanup.removed,undefined);assert.equal(result.receipt.outcome,'unknown');assert.equal(result.receipt.codeMayHaveRun,true);assert.equal(result.receipt.isolationVerified,false);
  const db=new Database(f.databaseFile,{readonly:true});try{
    assert.deepEqual(db.prepare('SELECT status,usage_json FROM agent_runs').get(),{status:'cancelled',usage_json:'{"totalTokens":12}'});
    const events=db.prepare('SELECT type,data_json FROM agent_run_events').all();assert.equal(events.length,1);assert.equal(events[0].type,'code_receipt');assert.deepEqual(JSON.parse(events[0].data_json).receipt,result.receipt);
    const store=createCodeEffectStore({db});assert.equal(store.quarantined('docker').length,0);
    assert.equal(store.get(f.executionId).receipt.cleanup.confirmed,true);
  }finally{db.close();}
});

test('offline command cannot take a live application data lock or observe while another owner holds it',async t=>{
  const f=await fixture(t);const lock=await acquireDataLock(f.directory);let observations=0;
  try{await assert.rejects(reconcileSandbox({dataDir:f.directory,executionId:f.executionId,observe:async()=>{observations++;}}),{code:'data_directory_in_use'});assert.equal(observations,0);}
  finally{await lock.release();}
});

test('unwitnessed or active source records remain blocked without any engine observation',async t=>{
  for(const options of [{witness:false},{terminal:false}]){
    const f=await fixture(t,options);let observations=0;
    await assert.rejects(reconcileSandbox({dataDir:f.directory,executionId:f.executionId,observe:async()=>{observations++;}}));assert.equal(observations,0);
    const db=new Database(f.databaseFile,{readonly:true});try{assert.equal(JSON.parse(db.prepare('SELECT receipt_json FROM agent_code_effects').get().receipt_json).cleanup.confirmed,false);}finally{db.close();}
  }
});
