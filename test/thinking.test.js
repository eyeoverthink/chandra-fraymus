import test from 'node:test';
import assert from 'node:assert/strict';
import {createOllamaProvider} from '../server/agent/provider.js';
import {normalizeThinking,thinkingControls,requireThinking,consumePrivateThinking} from '../server/agent/thinking.js';

const answer=(extra={})=>({done:true,done_reason:'stop',prompt_eval_count:123,eval_count:47,message:{role:'assistant',content:'Public answer.'},...extra});
function providerFixture(metadata={thinking:{values:[false,true,'false','low','Low'],default:'low'}},reply=()=>answer()) {
  const requests=[];
  const provider=createOllamaProvider({fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname,body=JSON.parse(options.body);requests.push({path,body});
    if(path==='/api/show')return Response.json({capabilities:['completion','tools','thinking'],...(typeof metadata==='function'?metadata(requests.filter(r=>r.path==='/api/show').length):metadata)});
    assert.equal(path,'/api/chat');return Response.json(reply(body));
  }});
  return {provider,requests,chat:thinking=>provider.chat({model:'test:local',messages:[{role:'user',content:'Test.'}],tools:[],maxOutputTokens:300,maxInputTokens:4096,signal:AbortSignal.timeout(3000),...(thinking!==undefined?{thinking}:{})})};
}

test('default reasoning is omitted while exact booleans and named values retain their identity',()=>{
  assert.equal(normalizeThinking(undefined),undefined);assert.equal(normalizeThinking(null),undefined);
  for(const value of [false,true,'false','low','Low'])assert.equal(normalizeThinking(value),value);
  for(const value of [0,1,{},[],NaN,'','a'.repeat(65),'low\n','\ud800','low\u202e','\u0085'])assert.throws(()=>normalizeThinking(value),{code:'invalid_thinking'});
  const metadata=thinkingControls({thinking:{values:[false,'false',false,'low'],default:false,ignored:'private metadata'}});
  assert.deepEqual(metadata,{values:[false,'false','low'],default:false});
  requireThinking(false,{thinking:metadata});requireThinking('false',{thinking:metadata});
  assert.throws(()=>requireThinking(true,{thinking:metadata}),{code:'thinking_unsupported'});
  assert.throws(()=>requireThinking('Low',{thinking:metadata}),{code:'thinking_unsupported'});
});

test('only bounded valid advertised metadata creates override controls; unknown does not mean reasoning off',()=>{
  for(const thinking of [null,{},[],{values:[]},{values:Array.from({length:17},()=>false)},{values:['low',7]},{values:['low'],default:false},{values:['\ud800']},{values:['low\t']},{values:['\u2067low']},false])
    assert.equal(thinkingControls({thinking}),undefined);
  assert.equal(thinkingControls({capabilities:['thinking']}),undefined);
  assert.deepEqual(thinkingControls({thinking:{values:[false],default:false}}),{values:[false],default:false});
  assert.deepEqual(thinkingControls({thinking:{values:['低','high effort']}}),{values:['低','high effort']});
  requireThinking(undefined,{});
  assert.throws(()=>requireThinking(false,{}),{code:'thinking_unsupported'});
  assert.throws(()=>requireThinking(false,{thinking:{values:'false'}}),{code:'thinking_unsupported'});
});

test('wire requests omit default think and preserve false, strings and case exactly',async()=>{
  const f=providerFixture();
  for(const choice of [undefined,null,false,true,'false','low','Low']){
    const result=await f.chat(choice),body=f.requests.at(-1).body;
    assert.equal(result.usage.outputTokens,47);
    if(choice===null||choice===undefined)assert.equal(Object.hasOwn(body,'think'),false);
    else {assert.equal(body.think,choice);assert.equal(typeof body.think,typeof choice);}
    assert.equal(body.options.num_predict,300);assert.equal(body.options.num_ctx,4096);
  }
});

test('explicit unsupported or invalid overrides never reach generation; missing metadata preserves default',async()=>{
  for(const metadata of [{},{thinking:{values:[]}},{thinking:{values:['low'],default:'bad'}}]){
    const f=providerFixture(metadata);await f.chat(undefined);
    assert.equal(f.requests.filter(r=>r.path==='/api/chat').length,1);
    await assert.rejects(f.chat('low'),{code:'thinking_unsupported'});
    assert.equal(f.requests.filter(r=>r.path==='/api/chat').length,1);
  }
  const f=providerFixture({thinking:{values:['low'],default:'low'}});
  await assert.rejects(f.chat(false),{code:'thinking_unsupported'});
  await assert.rejects(f.chat('LOW'),{code:'thinking_unsupported'});
  assert.equal(f.requests.some(r=>r.path==='/api/chat'),false);
  await assert.rejects(f.chat(1),{code:'invalid_thinking'});
});

test('fresh inference inspection rejects a revoked choice or a remotely retargeted alias',async()=>{
  const revoked=providerFixture(index=>({thinking:{values:index===1?['low','high']:['low'],default:'low'}}));
  assert.ok((await revoked.provider.inspectModel('test:local',AbortSignal.timeout(1000))).thinking.values.includes('high'));
  await assert.rejects(revoked.chat('high'),{code:'thinking_unsupported'});assert.ok(!revoked.requests.some(r=>r.path==='/api/chat'));
  const remote=providerFixture(index=>({thinking:{values:['low'],default:'low'},...(index>1?{remote_host:'https://example.test'}:{})}));
  await remote.provider.inspectModel('test:local',AbortSignal.timeout(1000));
  await assert.rejects(remote.chat('low'),{code:'local_cloud_blocked'});assert.ok(!remote.requests.some(r=>r.path==='/api/chat'));
});

test('private tool continuation is one-use in-memory data, absent from enumerable provider output',async()=>{
  const sentinel='PRIVATE_SYNTHETIC_REASONING_SENTINEL',f=providerFixture(undefined,()=>answer({message:{role:'assistant',content:'',thinking:sentinel,
    tool_calls:[{function:{name:'workspace.list',arguments:{}}}]}}));
  const result=await f.chat('low');
  assert.ok(!JSON.stringify(result).includes(sentinel));assert.equal(result.message.thinking,undefined);assert.equal(result.message.content,'');
  assert.equal(consumePrivateThinking(result),sentinel);assert.equal(consumePrivateThinking(result),undefined);
  assert.deepEqual(result.usage,{inputTokens:123,outputTokens:47,costUsd:0});
});

test('malformed or oversized private tool continuation retains actual usage and returns only a safe failure',async()=>{
  for(const thinking of [42,'\ud800','x'.repeat(32769),'😀'.repeat(16384)+'a']){
    const f=providerFixture(undefined,()=>answer({message:{role:'assistant',content:'',thinking,tool_calls:[{function:{name:'workspace.list',arguments:{}}}]}}));
    const result=await f.chat('low');assert.match(result.providerError,/private context limit/);assert.equal(result.usage.outputTokens,47);assert.equal(consumePrivateThinking(result),undefined);
  }
});

test('answer-only reasoning is neither persisted as continuation nor exposed, and full generation usage remains',async()=>{
  const f=providerFixture(undefined,()=>answer({message:{role:'assistant',content:'Public answer.',thinking:'private'.repeat(10000)}}));
  const result=await f.chat('low');assert.equal(result.providerError,undefined);assert.equal(result.message.content,'Public answer.');
  assert.equal(consumePrivateThinking(result),undefined);assert.ok(!JSON.stringify(result).includes('privateprivate'));assert.equal(result.usage.outputTokens,47);
});
