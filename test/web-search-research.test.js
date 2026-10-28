import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createWebResearch } from '../server/web/research.js';
import { extractWebPage } from '../server/web/parser.js';
import { SEARCH_PROVIDER, searchRequest } from '../server/web/search.js';

const html = '<html><title>Example at DuckDuckGo</title><form action="/lite/" method="post"><input name="q" value="fixture"></form><table>' + Array.from({length:8},(_,i)=>
  `<tr><td>${i+1}.</td><td><a class="result-link" href="https://example.com/source-${i+1}">Source ${i+1}</a></td></tr><tr><td></td><td class="result-snippet">Untrusted search snippet ${i+1}: φ and data only.</td></tr>`).join('')+'</table></html>';
const digest=text=>createHash('sha256').update(text).digest('hex');
function fixture(t, requestOverride) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const calls=[];
  const research=createWebResearch({db,requestPage:async(url,options)=>{calls.push(url);
    const query=new URL(url).searchParams.get('q').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
    const body=html.replace('value="fixture"',`value="${query}"`);
    return requestOverride?requestOverride(url,options):{url,status:200,contentType:'text/html',bytes:Buffer.byteLength(body),text:body,fetchedAt:123456789,rawSha256:digest(body)};}});
  const tools=Object.fromEntries(research.tools().map(tool=>[tool.name,tool]));
  const run={id:'search-test',budget:{maxToolResultChars:12000}};
  const call=(name,args,current=run,signal=new AbortController().signal)=>tools[name].execute({args,run:current,signal});
  return{db,research,tools,run,call,calls};
}

test('search discloses the canonical provider/query, stores ranked results and requires separate follow approval',async t=>{
  const f=fixture(t),args={query:'  CTranslate2 φ Windows  ',maxResults:8};
  const preview=await f.tools['web.search'].prepare({args,run:f.run});
  assert.deepEqual(preview.provider,SEARCH_PROVIDER);assert.equal(preview.query,'CTranslate2 φ Windows');
  assert.equal(preview.url,searchRequest(args.query).url);assert.equal(preview.fetchesResultPages,false);assert.equal(preview.sendsCookies,false);
  assert.equal(f.calls.length,0);assert.equal(f.tools['web.search'].approvalRequired,true);
  const first=await f.call('web.search',args);assert.equal(first.search.resultCount,8);assert.equal(first.results[0].rank,1);
  assert.equal(first.results[0].url,'https://example.com/source-1');assert.equal(first.untrusted,true);assert.equal(first.snapshotSha256.length,64);
  const follow=await f.tools['web.follow'].prepare({args:{sourceId:first.sourceId,linkId:first.results[0].linkId},run:f.run});
  assert.equal(follow.url,first.results[0].url);assert.equal(follow.parentSearch.query,preview.query);assert.equal(follow.parentSearch.rank,1);
  assert.equal(follow.parentSnapshotSha256,first.snapshotSha256);assert.equal(f.calls.length,1);
  const more=await f.call('web.results',{sourceId:first.sourceId,offset:4,maxResults:2});assert.equal(more.results[0].rank,5);
  const line=await f.call('web.read',{sourceId:first.sourceId,startLine:first.results[0].startLine,maxLines:3});assert.match(line.lines.map(x=>x.text).join('\n'),/Source 1/);
  const found=await f.call('web.find',{sourceId:first.sourceId,query:'snippet 1'});assert.ok(found.matches.length);
  assert.equal(f.calls.length,1);
  await assert.rejects(f.call('web.results',{sourceId:first.sourceId},{...f.run,id:'another-run'}),/not found/);
  await assert.rejects(f.call('web.results',{sourceId:first.sourceId,offset:9}),/outside/);
});

test('search pagination respects the result budget and does not lose retained results',async t=>{
  const f=fixture(t),first=await f.call('web.search',{query:'fixture',maxResults:8}),small={...f.run,budget:{maxToolResultChars:1600}};
  let offset=0,ranked=[];
  do {const page=await f.call('web.results',{sourceId:first.sourceId,offset,maxResults:8},small);assert.ok(JSON.stringify(page).length<=1600);assert.ok(page.results.length);ranked.push(...page.results.map(x=>x.rank));offset=page.nextOffset;} while(offset!==null);
  assert.deepEqual(ranked,[1,2,3,4,5,6,7,8]);assert.equal(f.calls.length,1);
  await assert.rejects(f.call('web.results',{sourceId:first.sourceId},{...f.run,budget:{maxToolResultChars:256}}),/too small/);
});

test('challenged, redirected and malformed search responses never become successful empty results or stored sources',async t=>{
  for(const response of[
    {status:202,text:'challenge'}, {status:302,text:'',redirect:'https://example.com/'},
    {status:200,text:'<form action="//duckduckgo.com/anomaly.js">Select all squares containing a duck</form>'},
    {status:200,text:'<h1>Unexpected provider layout</h1>'},
  ]){
    const f=fixture(t,async url=>({url,contentType:'text/html',bytes:response.text.length,fetchedAt:1,rawSha256:digest(response.text),...response}));
    await assert.rejects(f.call('web.search',{query:'fixture'}),{code:'web_search_unavailable'});
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_web_sources').get().n,0);assert.equal(f.calls.length,1);
  }
});

test('rate limits and concurrent searches fail without automatic retry, provider fallback or extra network requests',async t=>{
  const limited=fixture(t,async()=>{throw Object.assign(new Error('HTTP 429'),{httpStatus:429,retryAfterSeconds:120});});
  await assert.rejects(limited.call('web.search',{query:'fixture'}),{code:'web_search_rate_limited'});
  await assert.rejects(limited.call('web.search',{query:'different'}),{code:'web_search_rate_limited'});assert.equal(limited.calls.length,1);
  let release;const busy=fixture(t,async(url,{signal})=>new Promise((resolve,reject)=>{release=()=>reject(new Error('probe stopped'));signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
  const first=busy.call('web.search',{query:'fixture'});await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(busy.call('web.search',{query:'different'}),{code:'web_search_busy'});release();await assert.rejects(first);assert.equal(busy.calls.length,1);
});

test('real parser workers accept Lite result data and honour cancellation',async()=>{
  const input={kind:'search',...searchRequest('fixture'),maxResults:3,contentType:'text/html',text:html};
  const result=await extractWebPage(input);assert.equal(result.results.length,3);
  const controller=new AbortController(),pending=extractWebPage({...input,text:html.repeat(100)},controller.signal);
  controller.abort(new Error('cancelled search parser'));await assert.rejects(pending,/cancelled search parser/);
});
