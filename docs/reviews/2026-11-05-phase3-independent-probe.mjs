// Independent Phase 3 diagnostic review; no live app/DB/model/compiler calls.
// Run with: node --experimental-vm-modules this_file.mjs --upstream PINNED_DIRECTORY --output FILE
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,readdirSync,statSync,existsSync,mkdirSync,mkdtempSync } from 'node:fs';
import { join,resolve,basename,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const ref='5f7f17a5a8a64c296be6156c4e15bac61f105636';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
assert.ok(arg('--upstream')&&arg('--output'));
const sourceCache=new Map(),sourceHashes={};
const sha=data=>createHash('sha256').update(data).digest('hex');
function source(path){
 if(!sourceCache.has(path)){const text=execFileSync('git',['show',`${ref}:${path}`],{cwd:root,encoding:'utf8'});sourceCache.set(path,text);sourceHashes[path]=sha(text);}
 return sourceCache.get(path);
}
function moduleFrom(path,bindings,names,dynamic={}){
 const body=source(path).replace(/^import [\s\S]*?;\r?$/gm,'').replace(/^export \{[^}]+\};\s*$/gm,'').replace(/^export /gm,'');
 assert.ok(!/^import /m.test(body));
 const context=vm.createContext({Date,Math,JSON,console,...bindings});
 const modules=new Map();
 const script=new vm.Script(`(()=>{${body}\nreturn {${names}};})()`,{filename:path,importModuleDynamically:async specifier=>{
  assert.ok(dynamic[specifier],`Unexpected dynamic import: ${specifier}`);
  if(!modules.has(specifier)){
   const values=dynamic[specifier];
   const m=new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});
   await m.link(()=>{throw new Error('Synthetic imports disabled');});await m.evaluate();modules.set(specifier,m);
  }
  return modules.get(specifier);
 }});
 return script.runInContext(context);
}
const ddl=source('server/db-migrate.js');
function context(){
 const db=new Database(':memory:');
 for(const table of ['agent_memories','bus_messages','bus_subscriptions'])db.exec(ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
 db.exec('CREATE UNIQUE INDEX fixture_memory_identity ON agent_memories(agent_id,key)');
 const memory=moduleFrom('server/fleet/agent-memory.js',{db},'storeMemory,recallMemories');
 const bus=moduleFrom('server/fleet/bus.js',{db},'publish,onTopic,history');
 const publishFailures=[],publishAttempts=[];
 const publish=(...args)=>{publishAttempts.push({arity:args.length,from:args[0],topicType:typeof args[1]});try{return bus.publish(...args);}catch(e){publishFailures.push(e.message);throw e;}};
 const engine=moduleFrom('server/intelligence/dossier-engine.js',{db,...memory,publish,createHash,readFileSync,readdirSync,statSync,existsSync,join,resolve,basename},'ensureDossierTable,parseDecompiledC,parseAnnotations,parseImports,verifyDossierSeal,gradeEvidence,parseDossier,gradeDossier,storeDossier,processDossier,listDossiers,getDossier,getDossierFunctions,getDossierFunction');
 engine.ensureDossierTable();
 const compiler={available:false,commands:[],files:new Map(),writes:[],deletes:[]};
 const model={calls:[],response:'{"predictedRate":87,"confidence":"high","reasoning":"fixture opinion"}'};
 const tools=moduleFrom('server/fleet/re-tools.js',{db,...memory,...engine,verifyHiveChain:()=>({error:'not used'})},'createRETools',{
  'node:child_process':{execSync:(command,options)=>{compiler.commands.push({command,timeout:options.timeout});if(!compiler.available)throw Object.assign(new Error('clang not found'),{code:'ENOENT'});return Buffer.from('');}},
  'node:fs':{writeFileSync:(path,data)=>{compiler.writes.push({path,existed:compiler.files.has(path)});compiler.files.set(path,data);},unlinkSync:path=>{compiler.deletes.push(path);compiler.files.delete(path);}},
  'node:path':{join},
  '../commerce/shared.js':{chatOllama:async(messages,options)=>{model.calls.push({messages,options});return model.response;}},
 }).createRETools();
 return{db,memory,bus,engine,publishFailures,publishAttempts,tools,compiler,model};
}
const directory=mkdtempSync(join(tmpdir(),'chandra-phase3-review-'));
const makeDossier=(name,binary,functions)=>{
 const path=join(directory,name);mkdirSync(path);
 if(binary)writeFileSync(join(path,'binary.sha256'),binary+' fixture.bin\n');
 writeFileSync(join(path,'decompiled.c'),functions.map(f=>`// ==== ${f.name} @ ${f.address||'0x1000'} ====\n${f.body}\n`).join('\n'));
 return path;
};
const checks=[];const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
const upstream=join(resolve(arg('--upstream')),'dossier-ls');
const expectedBlobs={'decompiled.c':'7c61c5b00a778d62afa12bcc1c06325db8463128','annotations.md':'5d2de19c3a5a38aa25b1fb41b2b130d0763fde20','imports.txt':'c67e01e367bb73d422327bc0708f9ef082823bea','binary.sha256':'d7d4e85ed3e71aaf5a901926f95e4579e783b765','dossier.seal':'2a9cada682e45598688f9f91a7772dc08966dd6d'};
for(const[name,expected]of Object.entries(expectedBlobs)){const bytes=readFileSync(join(upstream,name));assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex'),expected);}

const raw=context();let upstreamResults,grading;
try{
 const c=readFileSync(join(upstream,'decompiled.c'),'utf8'),imports=readFileSync(join(upstream,'imports.txt'),'utf8'),annotations=readFileSync(join(upstream,'annotations.md'),'utf8');
 const observedMarkers=[...c.matchAll(/^\/\/ ==== .*? @ [0-9a-fA-F]+ ====/gm)].length;
 const observedImports=[...imports.matchAll(/^\d+\s+/gm)].length;
 const parsed=raw.engine.parseDossier(upstream);
 check('pinned upstream has 136 markers but production parser returns zero functions',observedMarkers===136&&parsed.functions.length===0);
 check('pinned upstream has 90 import rows but production parser returns zero imports',observedImports===90&&parsed.imports.length===0);
 check('real annotation headings and verification/score syntax are not parsed',annotations.includes('## FUN_100002439 @ 100002439')&&Object.keys(parsed.annotations.functions).length===0&&Object.keys(parsed.annotations.importVerification).length===0);
 const synthetic=raw.engine.parseDecompiledC('// ==== fixture @ 0x1000 ====\nint fixture(void){return 1;}\n');
 check('0x-prefixed synthetic marker is a working parser control',synthetic.length===1&&synthetic[0].body.includes('return 1'));
 const processed=raw.engine.processDossier(upstream);
 check('actual bus publish fails on wrong argument arity while process reports one event',raw.publishAttempts[0].arity===2&&raw.publishFailures.length===1&&processed.busEvents===1&&raw.bus.history('system.re.dossier.processed').length===0);
 check('committed upstream subset is labeled invalid rather than unverifiable',parsed.seal.status==='invalid');
 const g=raw.engine.gradeEvidence([{name:'string_only',address:'0x9000',body:'int string_only(void){ const char *s="printf"; return 0; }',lines:1}],{functions:{'string_only@0x9000':{annotation:'The model mentions printf.'}},importVerification:{printf:{status:'verified'}}},[{name:'printf'}]);
 check('a string-literal import mention is promoted to verified evidence',g[0].grade==='verified'&&g[0].value.importHits.includes('printf'));
 grading=g;
 upstreamResults={observedMarkers,observedImports,parsedFunctions:parsed.functions.length,parsedImports:parsed.imports.length,parsedAnnotationFunctions:Object.keys(parsed.annotations.functions).length,parsedAnnotationImports:Object.keys(parsed.annotations.importVerification).length,parsedSeal:parsed.seal,processed,publishAttempts:raw.publishAttempts,publishFailures:raw.publishFailures,busTopicRows:raw.bus.history('system.re.dossier.processed').length};
}finally{raw.db.close();}

const sealCtx=context();let seals;
try{
 const path=join(directory,'seal-control');mkdirSync(path);writeFileSync(join(path,'a.txt'),'ORIGINAL');
 const engineHash=sha(`a.txt:${sha('ORIGINAL')}\n`);
 writeFileSync(join(path,'dossier.seal'),engineHash+'\n');
 const bare=sealCtx.engine.verifyDossierSeal(path);
 writeFileSync(join(path,'dossier.seal'),engineHash+'  -\n');
 const twoColumn=sealCtx.engine.verifyDossierSeal(path);
 check('engine self-format positive control verifies, but same digest with producer suffix does not',bare.status==='valid'&&twoColumn.status==='invalid');
 const shellManifestDigest=sha(`${sha('ORIGINAL')}  a.txt\n`);
 check('upstream shasum manifest bytes differ from implemented name-colon-hash bytes',shellManifestDigest!==engineHash);
 seals={bare,twoColumn,engineHash,shellManifestDigest,producerRecipe:'shasum -a 256 file rows piped to shasum -a 256; producer also includes dossier.seal state from redirection; original manifest required'};
}finally{sealCtx.db.close();}

const storage=context();let identity,pagination,queryOnly;
const aSha='a'.repeat(64),bSha='b'.repeat(64),cSha='c'.repeat(64);
const aPath=makeDossier('binary-a',aSha,[{name:'shared',body:'int shared(void){return 1;}'}]);
const bPath=makeDossier('binary-b',bSha,[{name:'shared',body:'int shared(void){return 2;}'}]);
try{
 storage.engine.processDossier(aPath);
 const summary=storage.engine.getDossier(aSha);
 storage.engine.processDossier(bPath);
 const a=storage.engine.getDossierFunction(aSha,'shared'),b=storage.engine.getDossierFunction(bSha,'shared');
 const fnRows=storage.db.prepare("SELECT * FROM agent_memories WHERE key LIKE 'fn:%'").all();
 check('same function name/address from another binary overwrites the first binary fact',!a&&b.c.includes('return 2')&&fnRows.length===1);
 check('summary lookup only searches key/value and omits function rows stored under source SHA',summary.memories.every(m=>!m.key.startsWith('fn:')));
 let queryError;try{await storage.tools.find(t=>t.name==='re.query_dossier').execute({args:{functionName:'shared'}});}catch(e){queryError=e.message;}
 check('function-name-only tool query is rejected despite being an advertised query mode',!!queryError);
 queryOnly={error:queryError};identity={aFound:!!a,bFound:!!b,functionRows:fnRows.length,summaryFunctionMemories:summary.memories.filter(m=>m.key.startsWith('fn:')).length};
}finally{storage.db.close();}
const page=context();
const manyPath=makeDossier('many-functions',cSha,Array.from({length:136},(_,i)=>({name:`fixture_${i}`,address:`0x${(4096+i).toString(16)}`,body:`int fixture_${i}(void){return ${i};}`})));
try{
 page.engine.processDossier(manyPath);
 const listed=page.engine.getDossierFunctions(cSha,{limit:200,offset:0});
 check('function query truncates before pagination and cannot expose all 136 stored functions',listed.total<136&&page.db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE key LIKE 'fn:%'").get().n===136);
 pagination={storedFunctions:136,reportedTotal:listed.total,returned:listed.functions.length};
}finally{page.db.close();}

const compile=context();let compilation,prediction;
try{
 compile.engine.processDossier(aPath);
 const tempTarget=join(aPath,'_compile_test_shared.c');compile.compiler.files.set(tempTarget,'PREEXISTING_DOSSIER_ARTIFACT');
 const measure=compile.tools.find(t=>t.name==='re.compile_rate_measure');
 const missing=await measure.execute({args:{dossierPath:aPath}});
 check('missing compiler is counted as zero-percent failed compilation without not_available state',missing.total===1&&missing.compileRate===0&&missing.failed===1&&missing.compiler===undefined);
 check('compiler tool overwrites and unlinks a preexisting input-directory artifact in the intercepted FS protocol',compile.compiler.writes[0].existed&&!compile.compiler.files.has(tempTarget)&&compile.compiler.deletes.includes(tempTarget));
 compile.compiler.available=true;
 const available=await measure.execute({args:{dossierPath:aPath}});
 const storedFunction=compile.engine.getDossierFunction(aSha,'shared');
 const storedDossier=compile.engine.getDossier(aSha).dossier;
 check('successful compiler return does not fill stored compile status or aggregate rate',available.compiled===1&&storedFunction.compileStatus===null&&storedDossier.compile_rate===null);
 const traversalName='../../../outside_forensic_record';
 const traversalDir=makeDossier('compiler-path-traversal','d'.repeat(64),[{name:traversalName,body:'int harmless(void){return 0;}'}]);
 const traversalTarget=join(traversalDir,`_compile_test_${traversalName}.c`);
 compile.compiler.files.set(traversalTarget,'PREEXISTING_OUTSIDE_RECORD');
 const traversalResult=await measure.execute({args:{dossierPath:traversalDir}});
 const escaped=!traversalTarget.startsWith(traversalDir);
 check('untrusted marker name escapes the dossier and overwrites/deletes the intercepted outside record',escaped&&!compile.compiler.files.has(traversalTarget));
 compile.model.response='{"predictedRate":900,"confidence":"high","reasoning":"fixture model opinion"}';
 const predicted=await compile.tools.find(t=>t.name==='re.compile_rate_predict').execute({args:{dossierPath:aPath}});
 check('prediction has a human opinion note but no structured llm_prediction evidence type',predicted.note.includes('NOT a compiler measurement')&&predicted.evidence_type===undefined);
 check('prediction accepts an out-of-range model percentage without validation',predicted.prediction.predictedRate===900);
 compilation={missing,available,commands:compile.compiler.commands,interceptedWrites:compile.compiler.writes,interceptedDeletes:compile.compiler.deletes,preexistingArtifactRemoved:!compile.compiler.files.has(tempTarget),storedCompileStatus:storedFunction.compileStatus,storedCompileRate:storedDossier.compile_rate,traversal:{markerName:traversalName,dossierDir:traversalDir,target:traversalTarget,escaped,result:traversalResult,outsideRecordRemoved:!compile.compiler.files.has(traversalTarget)}};
 prediction={result:predicted,modelCalls:compile.model.calls.length,storedPredictions:compile.db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE source LIKE '%llm_prediction%'").get().n};
}finally{compile.db.close();}

const apiCtx=context();const app=express();app.use(express.json());
moduleFrom('server/intelligence/dossier-engine-routes.js',apiCtx.engine,'installDossierRoutes').installDossierRoutes(app);
app.use((e,_req,res,_next)=>res.status(500).json({error:e.message}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let api;
try{
 const base=`http://127.0.0.1:${server.address().port}`;
 const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dossierPath:aPath})};
 const declared=await fetch(`${base}/api/intelligence/dossier/process`,options);
 const actual=await fetch(`${base}/api/intelligence/dossier/ingest`,options);const result=await actual.json();
 const list=await(await fetch(`${base}/api/intelligence/dossier`)).json();
 const fn=await(await fetch(`${base}/api/intelligence/dossier/${aSha}/functions/shared`)).json();
 check('actual installer/ingest/list/detail routes work on a compatible synthetic fixture',actual.status===200&&list.total===1&&fn.name==='shared');
 check('declared process endpoint is not installed',declared.status===404);
 const runtimeWiring=source('server/runtime.js').includes('installDossierRoutes(app)');
 check('runtime contains actual dossier route registration',runtimeWiring);
 api={declaredProcessStatus:declared.status,actualIngestStatus:actual.status,result,listCount:list.total,functionName:fn.name,runtimeWiring};
}finally{await new Promise(resolve=>server.close(resolve));apiCtx.db.close();}

const gateResults=[['RE-P3-G1','FAIL','Real upstream: 136 markers, parser extracts 0.'],['RE-P3-G2','FAIL','Real annotation/import evidence not parsed; string-literal mention can be verified.'],['RE-P3-G3','FAIL','Binary identities overwrite and bounded query windows omit stored functions.'],['RE-P3-G4','FAIL','Actual bus rejects wrong arity; returned busEvents remains 1.'],['RE-P3-G5','PARTIAL','Synthetic actual routes work; declared process route absent and query completeness fails.'],['RE-P3-G6','FAIL','Seal format/recipe mismatch and missing-original-file evidence incorrectly invalid.'],['RE-P2B-G1','FAIL','Tool is wired, but actual dossier stores no function facts and binary identities collide.'],['RE-P2B-G2','FAIL','Function-name-only query fails and binary query data is overwritten/truncated.'],['RE-P2B-G3','FAIL','Missing compiler reported as failed compilation rather than not measured; results not persisted.'],['RE-P2B-G4','PARTIAL','Opinion note exists; structured type/confidence/provenance and validation are absent.']].map(([id,status,detail])=>({id,status,detail}));
const evidence={generatedAt:new Date().toISOString(),implementationRef:ref,progressClaimRef:'f2b6c2e',upstreamRef:'2f75cee7f54a4aa6bae219ec9241fc44f980c36b',upstreamBlobs:expectedBlobs,sourceHashes,
 safety:'Pinned function bodies use disposable SQLite and temporary fixtures. Actual bus and Express handlers are exercised. Dynamic compiler, writable FS and model boundaries are SyntheticModule fixtures: no real compiler/shell/model or deletion is executed. Upstream dossier reads are read-only. No live application/database imported or server restarted.',
 retainedTemporaryDirectory:directory,checks,diagnosticAssertionCount:checks.length,upstreamResults,grading,seals,identity,queryOnly,pagination,compilation,prediction,api,gateResults,
 summary:{phase3:{passes:0,failures:5,partial:1},phase2B:{passes:0,failures:3,partial:1},independentlyAcceptedPhases:0}};
writeFileSync(resolve(arg('--output')),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({diagnosticAssertions:checks.length,...evidence.summary,output:resolve(arg('--output'))}));
