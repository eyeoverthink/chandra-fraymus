import {randomUUID} from 'node:crypto';
import {assertSchema,fail,hash,stableJson} from './schema.js';
import {requireDurableEffectJournal} from './effect-durability.js';

const string=maxLength=>({type:'string',maxLength});
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const WORKSPACE_EDIT_PARAMETERS=object({path:{...string(1024),minLength:1},expectedHash:{...string(64),pattern:'^[a-f0-9]{64}$'},
  edits:{type:'array',minItems:1,maxItems:8,items:object({oldText:{...string(32768),minLength:1,description:'Exact unique original literal. The property name is oldText, with a capital T.'},newText:{...string(32768),description:'Replacement literal; empty string deletes. The property name is newText, with a capital T.'}})}});
function validate(args) {
  assertSchema(args,WORKSPACE_EDIT_PARAMETERS);
  for(const edit of args.edits) {
    if(!edit.oldText.isWellFormed()||!edit.newText.isWellFormed()||edit.oldText.includes('\0')||edit.newText.includes('\0'))fail('invalid_text','Literal edits must be well-formed text without NUL');
    if(edit.oldText===edit.newText)fail('edit_no_change','Each replacement must change its matched text');
  }
}
function position(text,offset) {
  const prefix=text.slice(0,offset),boundaries=[...prefix.matchAll(/\r\n|\n|\r/g)],last=boundaries.at(-1);
  return {line:boundaries.length+1,column:offset-(last?last.index+last[0].length:0)+1};
}
export function planLiteralEdits(file,args) {
  validate(args);
  if(file.sha256!==args.expectedHash)fail('write_conflict','File hash does not match expectedHash');
  const intervals=args.edits.map(edit=>{
    const start=file.text.indexOf(edit.oldText);
    if(start<0)fail('edit_not_found','A literal oldText was not found in the original file');
    if(file.text.indexOf(edit.oldText,start+1)>=0)fail('edit_ambiguous','Each oldText must occur exactly once; include more unchanged context');
    const end=start+edit.oldText.length;
    if(start>0&&file.text[start-1]==='\r'&&file.text[start]==='\n'||end>0&&file.text[end-1]==='\r'&&file.text[end]==='\n')fail('edit_boundary','Match the complete CRLF terminator rather than splitting it');
    return {...edit,start,end};
  }).sort((a,b)=>a.start-b.start);
  for(let i=1;i<intervals.length;i++)if(intervals[i].start<intervals[i-1].end)fail('edit_overlap','Literal matches must not overlap in the original file');
  let content='',cursor=0;const edits=[];
  for(const edit of intervals) {
    content+=file.text.slice(cursor,edit.start);
    const before=position(file.text,edit.start),after=position(content,content.length);
    edits.push({startLine:before.line,startColumn:before.column,newStartLine:after.line,newStartColumn:after.column,
      offsetUtf16:edit.start,oldText:edit.oldText,newText:edit.newText});
    content+=edit.newText;cursor=edit.end;
  }
  content+=file.text.slice(cursor);
  const bytesAfter=Buffer.byteLength(content,'utf8');
  if(bytesAfter>262144)fail('file_too_large','Edited file exceeds 262144 UTF-8 bytes');
  if(hash(content)===args.expectedHash)fail('edit_no_change','The combined replacements leave the original bytes unchanged');
  const preview={kind:'workspace_edit',path:file.path,expectedHash:file.sha256,newHash:hash(content),bytesBefore:file.bytes,bytesAfter,
    edits,complete:true,atomic:false,offsetUnits:'UTF-16 code units; offsets zero-based, lines and columns one-based',
    lineEndings:file.lineEndings,utf8Bom:file.utf8Bom,
    warning:'Only these exact literal fragments change. The original full hash binds unchanged bytes. External-writer preconditions are best effort, not atomic compare-and-swap. Cancellation cannot undo a dispatched write.'};
  if(JSON.stringify(preview).length>24000)fail('edit_preview_too_large','The full edit does not fit an approval; propose fewer or smaller literal replacements');
  return {content,preview};
}

function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_workspace_effects (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL,approval_id TEXT NOT NULL UNIQUE,args_hash TEXT NOT NULL,
    path TEXT NOT NULL,expected_hash TEXT NOT NULL,new_hash TEXT NOT NULL,status TEXT NOT NULL,
    receipt_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,notified_at INTEGER
  )`);
  if(!db.prepare('PRAGMA table_info(agent_workspace_effects)').all().some(column=>column.name==='notified_at'))db.exec('ALTER TABLE agent_workspace_effects ADD COLUMN notified_at INTEGER');
}
function savedResult(row) {
  let receipt;try{receipt=JSON.parse(row.receipt_json);}catch{fail('edit_journal_corrupt','Stored edit receipt is invalid JSON');}
  if(!receipt||receipt.kind!=='workspace_edit'||receipt.effectId!==row.id||receipt.path!==row.path||receipt.expectedHash!==row.expected_hash||receipt.newHash!==row.new_hash
    ||!['verified','unknown','not_dispatched'].includes(receipt.outcome)||receipt.outcome!==row.status||receipt.atomic!==false
    ||receipt.outcome==='verified'&&(receipt.verified!==true||receipt.dispatchAttempted!==true||receipt.observedHash!==row.new_hash||!Number.isSafeInteger(receipt.bytesAfter)||receipt.bytesAfter<0||receipt.observedBytes!==receipt.bytesAfter)
    ||receipt.outcome==='unknown'&&(receipt.verified!==false||receipt.dispatchAttempted!==true)
    ||receipt.outcome==='not_dispatched'&&(receipt.verified!==false||receipt.dispatchAttempted!==false))fail('edit_journal_corrupt','Stored edit receipt contradicts its independent journal');
  return {ok:receipt.outcome==='verified',path:receipt.path,sha256:receipt.observedHash??null,bytes:receipt.observedBytes??null,
    ...(receipt.code?{code:receipt.code}:{}),receipt};
}
function publish(db,row,receipt,onReceipt) {
  const serialized=JSON.stringify(receipt);
  db.prepare('UPDATE agent_workspace_effects SET status=?,receipt_json=?,updated_at=?,notified_at=NULL WHERE id=?').run(receipt.outcome,serialized,Date.now(),row.id);
  notifyReceipt(db,row,serialized,onReceipt);
  return savedResult({...row,status:receipt.outcome,receipt_json:serialized});
}
function frozenReceipt(serialized){const value=JSON.parse(serialized);const freeze=item=>{if(item&&typeof item==='object'){Object.values(item).forEach(freeze);Object.freeze(item);}return item;};return freeze(value);}
function notifyReceipt(db,row,serialized,onReceipt){
  try{
    const pending=onReceipt(row.run_id,frozenReceipt(serialized));
    if(pending&&typeof pending.then==='function'){Promise.resolve(pending).catch(()=>{});return;}
    db.prepare('UPDATE agent_workspace_effects SET notified_at=? WHERE id=? AND receipt_json=?').run(Date.now(),row.id,serialized);
  }catch{/* The independent receipt remains authoritative; retry only acknowledgement. */}
}
export function recoverWorkspaceEffects(db,onReceipt) {
  initialize(db);
  for(const row of db.prepare("SELECT * FROM agent_workspace_effects WHERE status IN ('prepared','dispatching')").all()) {
    const dispatched=row.status==='dispatching';
    publish(db,row,{kind:'workspace_edit',effectId:row.id,path:row.path,expectedHash:row.expected_hash,newHash:row.new_hash,
      outcome:dispatched?'unknown':'not_dispatched',dispatchAttempted:dispatched,atomic:false,
      code:dispatched?'edit_interrupted_unknown':'edit_interrupted_before_dispatch',verified:false},onReceipt);
  }
  for(const row of db.prepare('SELECT * FROM agent_workspace_effects WHERE receipt_json IS NOT NULL AND notified_at IS NULL').all()) {
    notifyReceipt(db,row,row.receipt_json,onReceipt);
  }
}
export function createWorkspaceEditTool({db,policy,onReceipt=()=>{}}) {
  initialize(db);
  return {name:'workspace.edit',group:'coding',description:'Propose 1–8 small, unique literal replacements against an exact original SHA-256. Arguments: {path,expectedHash,edits:[{oldText:"exact original text",newText:"replacement"}]}. Use those exact camelCase property names. All matches refer to the original file, cannot overlap, and preserve untouched bytes/BOM/line endings. Read exact fragments using workspace.read preserveLineEndings:true or workspace.readMany. Full before/after hunks require approval; no regex, evaluation, or automatic retries after an unknown write.',
    parameters:WORKSPACE_EDIT_PARAMETERS,approvalRequired:true,preserveReceipt:true,
    prepare:async({args,signal})=>{signal.throwIfAborted();return planLiteralEdits(await policy.read(args.path),args).preview;},
    execute:async context=>{
      const {args,run,approvalId,signal}=context;validate(args);signal.throwIfAborted();
      const argsJson=stableJson(args),argsHash=hash('workspace.edit\n'+argsJson);
      const approval=db.prepare('SELECT * FROM agent_approvals WHERE id=? AND run_id=?').get(approvalId,run.id);
      if(!approval||approval.status!=='consumed'||approval.tool_name!=='workspace.edit'||approval.args_json!==argsJson||approval.args_hash!==argsHash)fail('approval_mismatch','Literal edit requires its exact consumed approval');
      const approved=JSON.parse(approval.preview_json);
      if(approved.kind!=='workspace_edit'||approved.complete!==true||approved.truncated||JSON.stringify(approved).length>24000)fail('approval_mismatch','The complete literal-edit preview was not approved');
      const old=db.prepare('SELECT * FROM agent_workspace_effects WHERE approval_id=?').get(approvalId);
      if(old) {
        if(old.run_id!==run.id||old.args_hash!==argsHash)fail('approval_mismatch','Effect identity does not match this approval');
        if(old.path!==approved.path||old.expected_hash!==approved.expectedHash||old.new_hash!==approved.newHash)fail('edit_journal_corrupt','Cached edit metadata differs from its approved preview');
        if(!old.receipt_json)fail('edit_in_progress','This approved edit is already dispatched; do not repeat it');
        return savedResult(old);
      }
      const planned=planLiteralEdits(await policy.read(args.path),args);
      if(stableJson(planned.preview)!==stableJson(approved))fail('approval_mismatch','Recomputed edit differs from its complete approved preview');
      signal.throwIfAborted();
      requireDurableEffectJournal(db);
      const row={id:randomUUID(),run_id:run.id,approval_id:approvalId,args_hash:argsHash,path:planned.preview.path,expected_hash:args.expectedHash,new_hash:planned.preview.newHash};
      db.prepare('INSERT INTO agent_workspace_effects(id,run_id,approval_id,args_hash,path,expected_hash,new_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(row.id,row.run_id,row.approval_id,row.args_hash,row.path,row.expected_hash,row.new_hash,'prepared',Date.now(),Date.now());
      let attempted=false;
      const receipt={kind:'workspace_edit',effectId:row.id,path:row.path,expectedHash:row.expected_hash,newHash:row.new_hash,
        bytesBefore:planned.preview.bytesBefore,bytesAfter:planned.preview.bytesAfter,editCount:args.edits.length,atomic:false};
      try {
        await policy.write({path:args.path,expectedHash:args.expectedHash,content:planned.content},{signal,beforeDispatch:()=>{
          signal.throwIfAborted();requireDurableEffectJournal(db);const changed=db.prepare("UPDATE agent_workspace_effects SET status='dispatching',updated_at=? WHERE id=? AND status='prepared'").run(Date.now(),row.id);
          if(Number(changed.changes)!==1)fail('edit_in_progress','The prepared edit no longer owns dispatch');attempted=true;
        }});
        // Once dispatch starts, finish verification and its receipt even after
        // cancellation. A run cancellation is not filesystem rollback.
        const observed=await policy.read(args.path);
        if(observed.sha256!==row.new_hash) return publish(db,row,{...receipt,outcome:'unknown',dispatchAttempted:true,verified:false,
          observedHash:observed.sha256,observedBytes:observed.bytes,code:'edit_readback_mismatch'},onReceipt);
        return publish(db,row,{...receipt,outcome:'verified',dispatchAttempted:true,verified:true,observedHash:observed.sha256,observedBytes:observed.bytes},onReceipt);
      }catch(error){
        const code=attempted?'edit_write_unknown':/^(?:write_conflict|path_changed|path_denied|file_too_large|cancelled)$/.test(error.code??'')?error.code:'edit_not_dispatched';
        return publish(db,row,{...receipt,outcome:attempted?'unknown':'not_dispatched',dispatchAttempted:attempted,verified:false,code},onReceipt);
      }
    }};
}
