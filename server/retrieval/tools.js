import {assertSchema,fail,hash} from '../agent/schema.js';

export const CHUNK_POLICY=Object.freeze({version:1,maxChars:1000,overlapChars:120,offsetUnits:'UTF-16',skipWhitespaceOnly:true});
export function semanticChunks(text) {
  if(typeof text!=='string'||!text.isWellFormed()||text.includes('\0')||!text.trim())fail('semantic_empty_source','Selected source must contain well-formed readable text');
  const chunks=[];let start=0,windows=0;
  while(start<text.length) {
    if(++windows>1024)fail('semantic_source_limit','Selected source exceeds 1024 windows; explicitly select a PDF page or ZIP entry');
    let end=Math.min(text.length,start+CHUNK_POLICY.maxChars);
    if(end<text.length&&(text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff||text[end-1]==='\r'&&text[end]==='\n'))end--;
    const content=text.slice(start,end);
    if(content.trim())chunks.push({ordinal:chunks.length,start,end,textHash:hash(content)});
    if(end===text.length)break;
    start=end-CHUNK_POLICY.overlapChars;
    if(text.charCodeAt(start)>=0xdc00&&text.charCodeAt(start)<=0xdfff||text[start-1]==='\r'&&text[start]==='\n')start++;
  }
  return chunks;
}
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const str=maxLength=>({type:'string',maxLength});
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const sourceParameters={assetId:{...str(128),minLength:1,description:'Exact ID of a source attached to this run.'},
  page:{...integer(1,300),description:'Optional positive PDF page only. OMIT this key for plain text, WAV, ZIP or full-document search; never use 0 or a placeholder.'},
  entry:{...str(512),minLength:1,description:'Optional exact readable ZIP member only. OMIT this key for plain text, WAV, PDF or full-archive search; never use an empty string or dot.'}};
function cosine(a,b) {
  if(a.length!==b.length)fail('semantic_dimensions','Query and index dimensions differ');
  let dot=0,left=0,right=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];left+=a[i]*a[i];right+=b[i]*b[i];}
  if(!left||!right)fail('semantic_vectors','Zero vectors cannot be ranked');
  return Math.max(-1,Math.min(1,dot/Math.sqrt(left*right)));
}
async function meteredEmbedding(embedder,texts,kind,identity,context) {
  const meter=context.auxiliaryInput;if(!meter)fail('semantic_budget_unavailable','Semantic retrieval requires durable model-input accounting');
  let ticket;
  const pending=embedder.embed(texts,{kind,expectedIdentity:identity,signal:context.signal,beforeRequest:({estimatedInputTokens})=>{ticket=meter.reserve(estimatedInputTokens);}})
    .then(result=>{
      if(!ticket)fail('semantic_budget_unavailable','Embedding dispatch did not reserve its input budget');
      const settled=meter.settle(ticket,result.inputTokens);
      if(settled.overBudget)throw Object.assign(new Error('Actual embedding input exceeded this run budget'),{code:'budget_tokens',inputTokens:result.inputTokens});
      return result;
    },error=>{
      if(ticket){
        if(Number.isSafeInteger(error.inputTokens)&&error.inputTokens>=0)meter.settle(ticket,error.inputTokens);
        else if(error.dispatched===false)meter.notDispatched(ticket);
        else meter.unknown(ticket);
      }
      throw error;
    });
  return meter.track(pending);
}

export function createSemanticTools({artifacts,store,embedder}) {
  async function selected(args,context) {
    context.signal.throwIfAborted();
    // textScope performs attachment authorization before reading any cache or
    // model metadata. A persistent cache never widens the current run's scope.
    const source=artifacts.textScope(args.assetId,{...(args.page!==undefined?{page:args.page}:{}),...(args.entry!==undefined?{entry:args.entry}:{})},context.run);
    const chunks=semanticChunks(source.text),identity=await embedder.inspect({signal:context.signal});
    context.signal.throwIfAborted();
    const index=store.ensure({assetId:source.assetId,sourceHash:source.sourceHash,scopeKey:source.scopeKey,identity,chunkPolicy:CHUNK_POLICY,chunks});
    return {source,chunks,identity,index};
  }
  const summary=(index,source)=>({id:index.id,complete:index.complete,storedChunks:index.storedChunks,totalChunks:index.totalChunks,dimensions:index.dimensions,
    vectorBytes:index.vectorBytes,storageFormat:'float32',embeddingModel:index.identity.model,embeddingDigest:index.identity.digest,
    assetId:source.assetId,assetSha256:source.assetSha256,sourceHash:source.sourceHash,scope:source.selector,totalChars:source.text.length,baseOffset:source.baseOffset});
  const statusParameters=object(sourceParameters,['assetId']);
  const searchParameters=object({...sourceParameters,query:{...str(512),minLength:1},maxResults:integer(1,8),maxNewChunks:integer(0,128)},['assetId','query']);
  const forgetParameters=object({...sourceParameters,indexId:{...str(64),pattern:'^[a-f0-9]{64}$'}},['assetId','indexId']);
  return [{name:'artifact.semanticStatus',group:'semantic',description:'Inspect a local derived semantic index for this attached source scope. All vectors must be present before ranked search. Does not embed source text or change original files.',parameters:statusParameters,
    execute:async context=>{assertSchema(context.args,statusParameters);const {index,source}=await selected(context.args,context);return {index:summary(index,source),untrusted:true,warnings:source.warnings};}},
  {name:'artifact.semanticSearch',group:'semantic',description:'Find meaning-related passages in an attached text/PDF/ZIP/WAV transcript using local embeddings. For full source search, pass assetId and query and OMIT page and entry entirely. Builds/resumes a bounded index, default up to32 new chunks; all selected text must be indexed before any ranked hits. maxNewChunks0 queries existing complete cache only. Local embedding input counts against this run token budget; no OCR, cloud embedding, downloads or implicit full-reading claim. Page/entry explicitly narrow scope.',parameters:searchParameters,
    execute:async context=>{
      assertSchema(context.args,searchParameters);if(!context.args.query.isWellFormed()||!context.args.query.trim()||context.args.query.includes('\0'))fail('invalid_arguments','Query must contain well-formed text');
      const {source,identity,index:initial}=await selected(context.args,context);let index=initial,built=0,stop=null,embeddingInputTokens=0;
      const maximum=context.args.maxNewChunks??32;
      while(!index.complete&&built<maximum){
        context.signal.throwIfAborted();
        // Eight 1000-UTF16-unit windows fit the adapter's 32-KiB UTF-8
        // request bound even for three-byte scripts and the model prefix.
        const pending=store.pending(index.id,Math.min(8,maximum-built)),texts=pending.map(chunk=>source.text.slice(chunk.start,chunk.end));
        if(!pending.length)break;
        try{
          const result=await meteredEmbedding(embedder,texts,'document',identity,context);embeddingInputTokens+=result.inputTokens;
          context.signal.throwIfAborted();
          index=store.put(index.id,pending.map((chunk,i)=>({ordinal:chunk.ordinal,vector:result.vectors[i]})),identity);built+=pending.length;
        }catch(error){if(context.signal.aborted)throw context.signal.reason;if(Number.isSafeInteger(error.inputTokens)&&error.inputTokens>=0)embeddingInputTokens+=error.inputTokens;stop={code:error.code??'semantic_embedding_failed',message:String(error.message||'Embedding failed').slice(0,300)};break;}
      }
      index=store.get(index.id);
      if(!index.complete)return {ok:false,index:summary(index,source),newChunks:built,embeddingInputTokens,hits:[],querySkipped:true,
        stop:stop??{code:'semantic_index_incomplete',message:'Indexing is incomplete; continue explicitly with the same attached source and a sufficient budget.'},untrusted:true};
      if(stop)fail(stop.code,stop.message);
      const query=await meteredEmbedding(embedder,[context.args.query],'query',identity,context);embeddingInputTokens+=query.inputTokens;
      context.signal.throwIfAborted();
      const records=store.vectors(index.id),ranked=records.map(chunk=>({...chunk,score:cosine(query.vectors[0],chunk.vector)}))
        .sort((a,b)=>b.score-a.score||a.ordinal-b.ordinal).slice(0,context.args.maxResults??5);
      const hits=ranked.map(chunk=>{const offset=source.baseOffset+chunk.start,end=source.baseOffset+chunk.end;
        return {score:chunk.score,ordinal:chunk.ordinal,offset,endOffset:end,sourceOffset:chunk.start,text:source.text.slice(chunk.start,chunk.end),
          references:source.references.filter(ref=>ref.end>offset&&ref.start<end).slice(0,8)};});
      return {ok:true,index:summary(index,source),newChunks:built,embeddingInputTokens,query:context.args.query,hits,untrusted:true,warnings:source.warnings,
        meaning:'Cosine-ranked candidate passages, not proof of truth, full reading or understanding.'};
    }},
  {name:'artifact.semanticForget',group:'semantic',description:'Remove only one exact derived semantic cache for the attached source after approval. Original uploads and extracted text remain. Rebuilding costs embedding tokens.',parameters:forgetParameters,approvalRequired:true,
    prepare:async context=>{assertSchema(context.args,forgetParameters);const {index,source}=await selected(context.args,context);if(index.id!==context.args.indexId)fail('semantic_index_mismatch','Index does not match the current attached source/model scope');return {kind:'semantic_forget',index:summary(index,source),originalAssetPreserved:true};},
    execute:async context=>{assertSchema(context.args,forgetParameters);context.signal.throwIfAborted();const {index}=await selected(context.args,context);if(index.id!==context.args.indexId)fail('semantic_index_mismatch','Index scope changed after approval');context.signal.throwIfAborted();return {removed:store.remove(index.id),indexId:index.id,originalAssetPreserved:true};}}];
}
