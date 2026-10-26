import test from 'node:test';
import assert from 'node:assert/strict';
import type {RunMetrics,TokenCounters} from '../shared/analytics.ts';
const module=await import('../server/run-telemetry.ts').catch(()=>null);
const counters=(input=100,output=20):TokenCounters=>({inputTokens:input,cachedInputTokens:Math.floor(input/4),cacheWriteInputTokens:Math.floor(input/8),outputTokens:output,reasoningOutputTokens:Math.floor(output/4),totalTokens:input+output});
function fixture(save?:(metrics:RunMetrics)=>void){
  assert.ok(module,'passive telemetry collector required');const records=new Map<string,RunMetrics>(),writes:RunMetrics[]=[];
  const telemetry=new module.RunTelemetry(value=>{records.set(value.runId,structuredClone(value));writes.push(structuredClone(value));return save?.(value);});
  telemetry.connect('thread-1','gpt-6.1-sol','openai');
  const usage=(turnId:string,total:unknown=counters(),last:unknown=counters(8,4),threadId='thread-1')=>telemetry.event({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total,last,modelContextWindow:200000}}});
  const begin=(id:string,turn=id)=>{telemetry.begin(id);telemetry.acknowledge(id,turn);};
  const seed=()=>{begin('seed');usage('seed');telemetry.finish('seed');};
  const get=(id:string)=>{const value=records.get(id);assert.ok(value);return value;};
  return {telemetry,records,writes,usage,begin,seed,get};
}
test('first run has no inferred zero baseline; next continuous run reports a cumulative difference',()=>{
  const f=fixture();f.begin('first');f.usage('first');f.telemetry.finish('first');
  assert.equal(f.get('first').tokens,null);assert.equal(f.get('first').tokenStatus,'unknown');assert.equal(f.get('first').tokenIssue,'NO_BASELINE');
  f.begin('second');f.usage('second',counters(180,60));f.telemetry.finish('second');
  assert.deepEqual(f.get('second').tokens,{inputTokens:80,cachedInputTokens:20,cacheWriteInputTokens:10,outputTokens:40,reasoningOutputTokens:10,totalTokens:120});
  assert.equal(f.get('second').tokenStatus,'observed');assert.equal(f.get('second').tokenIssue,null);assert.ok(f.get('second').observedAt);
  assert.equal(f.get('second').modelAtStart,'gpt-6.1-sol');assert.equal(f.get('second').modelProvider,'openai');
});
test('cumulative snapshots replace observations; duplicates and last increments are never added',()=>{
  const f=fixture();f.seed();f.begin('run');f.usage('run',counters(120,40));const writes=f.writes.length;
  f.usage('run',counters(120,40));f.usage('run',counters(120,40),counters(4,0));assert.equal(f.writes.length,writes);
  f.usage('run',counters(160,80));assert.equal(f.get('run').tokens?.totalTokens,120);
  f.telemetry.finish('run');const result=f.get('run');f.telemetry.finish('run');assert.deepEqual(f.get('run'),result);
});
test('pre-ack telemetry binds only after exact acknowledgement and is bounded to 128 projected entries',()=>{
  const f=fixture();f.seed();f.telemetry.begin('run');f.usage('turn-run',counters(140,40));assert.equal(f.get('run').turnId,null);assert.equal(f.get('run').tokens,null);
  f.telemetry.acknowledge('run','turn-run');assert.equal(f.get('run').tokens?.totalTokens,60);
  const g=fixture();g.seed();g.telemetry.begin('run');for(let i=0;i<129;i++)g.usage('turn-run',counters(140,40));
  g.telemetry.acknowledge('run','turn-run');assert.equal(g.get('run').tokens,null);assert.equal(g.get('run').tokenIssue,'BUFFER_LIMIT');assert.equal(g.get('run').tokenStatus,'incomplete');
});
test('foreign thread events are inert; same-thread unknown turns and conflicting acknowledgements invalidate attribution',()=>{
  const f=fixture();f.seed();f.begin('run');const before=f.writes.length;f.usage('run',counters(900,100),counters(8,4),'other-thread');assert.equal(f.writes.length,before);
  f.usage('foreign-turn',counters(900,100));f.usage('run',counters(180,60));assert.equal(f.get('run').tokens,null);assert.equal(f.get('run').tokenIssue,'DISCONTINUITY');
  const g=fixture();g.seed();g.telemetry.begin('run');g.usage('foreign-turn',counters(150,40));g.usage('turn-run',counters(180,60));g.telemetry.acknowledge('run','turn-run');assert.equal(g.get('run').tokenIssue,'DISCONTINUITY');
  const h=fixture();h.seed();h.begin('run');h.telemetry.acknowledge('run','different');assert.equal(h.get('run').turnId,'run');assert.equal(h.get('run').tokenIssue,'DISCONTINUITY');
});
test('negative, fractional, unsafe, inconsistent, missing and accessor-bearing token values fail safely',()=>{
  let accessed=false;const getter={...counters()};Object.defineProperty(getter,'inputTokens',{get(){accessed=true;throw new Error('PRIVATE_GETTER');}});
  const invalid:unknown[]=[null,[],{}, {...counters(),inputTokens:-1},{...counters(),outputTokens:0.5},{...counters(),totalTokens:Infinity},
    {...counters(),inputTokens:Number.MAX_SAFE_INTEGER+1},{...counters(),inputTokens:'100'}, {...counters(),totalTokens:200000,inputTokens:0,outputTokens:0},
    {...counters(),cachedInputTokens:101},{...counters(),cacheWriteInputTokens:101},{...counters(),reasoningOutputTokens:21},getter];
  for(const total of invalid){const f=fixture();f.seed();f.begin('run');assert.doesNotThrow(()=>f.usage('run',total));assert.equal(f.get('run').tokens,null);assert.equal(f.get('run').tokenIssue,'INVALID_OBSERVATION');}
  assert.equal(accessed,false);
  const f=fixture();f.seed();f.begin('run');f.usage('run',counters(180,60),{...counters(8,4),totalTokens:999});assert.equal(f.get('run').tokenIssue,'INVALID_OBSERVATION');
});
test('counter regression and invalid subcount differences never become clamped or partial totals',()=>{
  const f=fixture();f.seed();f.begin('run');f.usage('run',counters(180,60));f.usage('run',counters(160,40));assert.equal(f.get('run').tokens,null);assert.equal(f.get('run').tokenIssue,'DISCONTINUITY');
  const g=fixture();g.seed();g.begin('run');g.usage('run',{...counters(110,30),cachedInputTokens:100});assert.equal(g.get('run').tokens,null);assert.equal(g.get('run').tokenIssue,'DISCONTINUITY');
});
test('late terminal telemetry preserves duration and finish timestamp, and changed predecessor totals invalidate its successor',()=>{
  const f=fixture();f.seed();f.begin('first');f.usage('first',counters(140,40));f.telemetry.finish('first');const completed=f.get('first');
  f.usage('first',counters(160,60));assert.equal(f.get('first').tokens?.totalTokens,100);assert.equal(f.get('first').finishedAt,completed.finishedAt);assert.equal(f.get('first').durationMs,completed.durationMs);
  f.begin('second');f.usage('second',counters(200,100));const before=f.writes.length;f.usage('first',counters(160,60));assert.equal(f.writes.length,before);
  f.usage('first',counters(180,80));assert.equal(f.get('second').tokens,null);assert.equal(f.get('second').tokenIssue,'DISCONTINUITY');
});
test('terminal-before-ack preserves local completion and can accept buffered matching usage',()=>{
  const f=fixture();f.seed();f.telemetry.begin('run');f.usage('turn-run',counters(140,40));f.telemetry.finish('run');const ended=f.get('run');
  f.usage('turn-run',counters(160,60));f.telemetry.acknowledge('run','turn-run');assert.equal(f.get('run').tokens?.totalTokens,100);assert.equal(f.get('run').finishedAt,ended.finishedAt);assert.equal(f.get('run').durationMs,ended.durationMs);
});
test('later loss invalidates a measured terminal boundary while repeated normal finish remains immutable',()=>{
  const f=fixture();f.seed();f.telemetry.begin('run');f.usage('turn-run',counters(160,60));f.telemetry.finish('run');f.telemetry.acknowledge('run','turn-run');
  const ended=f.get('run');assert.ok(ended.finishedAt);assert.notEqual(ended.durationMs,null);assert.equal(ended.tokens?.totalTokens,100);
  f.telemetry.finish('run');assert.deepEqual(f.get('run'),ended);
  f.telemetry.finish('run',true);const lost=f.get('run');assert.equal(lost.finishedAt,null);assert.equal(lost.durationMs,null);assert.equal(lost.tokens,null);
  assert.equal(lost.tokenStatus,'incomplete');assert.equal(lost.tokenIssue,'CONNECTION_LOST');
  const writes=f.writes.length;f.telemetry.finish('run');f.telemetry.finish('run',true);assert.deepEqual(f.get('run'),lost);assert.equal(f.writes.length,writes);
  f.begin('next');f.usage('next',counters(200,100));assert.equal(f.get('next').tokens,null);assert.equal(f.get('next').tokenIssue,'NO_BASELINE');
});
test('retry notice count stays unknown when completion precedes acknowledged ownership',()=>{
  const f=fixture();f.telemetry.begin('run');f.telemetry.event({method:'error',params:{threadId:'thread-1',turnId:'turn-run',willRetry:true}});
  f.telemetry.finish('run');assert.equal(f.get('run').retryNotices,null);f.telemetry.acknowledge('run','turn-run');assert.equal(f.get('run').retryNotices,null);
  f.telemetry.event({method:'error',params:{threadId:'thread-1',turnId:'turn-run',willRetry:true}});assert.equal(f.get('run').retryNotices,null);
});
test('late malformed predecessor telemetry invalidates successors that copied its baseline',()=>{
  const f=fixture();f.seed();f.begin('successor');f.usage('successor',counters(160,60));assert.equal(f.get('successor').tokenStatus,'observed');
  f.usage('seed',{...counters(),totalTokens:999});assert.equal(f.get('seed').tokenIssue,'INVALID_OBSERVATION');
  assert.equal(f.get('successor').tokens,null);assert.equal(f.get('successor').tokenStatus,'incomplete');assert.equal(f.get('successor').tokenIssue,'DISCONTINUITY');
});
test('disconnect/reconnect and lost runs retain unknown duration and cannot reuse earlier baselines',async()=>{
  const f=fixture();f.seed();f.begin('run');f.usage('run',counters(140,40));await new Promise(resolve=>setTimeout(resolve,5));f.telemetry.disconnect();
  assert.equal(f.get('run').durationMs,null);assert.equal(f.get('run').tokenIssue,'CONNECTION_LOST');assert.equal(f.get('run').tokens,null);
  f.telemetry.connect('thread-2','gpt-6.1-sol','openai');f.begin('new');f.usage('run',counters(300,100));f.usage('new',counters(500,100),counters(8,4),'thread-2');f.telemetry.finish('new');
  assert.equal(f.get('new').tokenIssue,'NO_BASELINE');assert.equal(f.get('new').tokens,null);assert.ok(f.get('new').durationMs!==null&&f.get('new').durationMs!>=0);
  f.begin('lost');f.telemetry.finish('lost',true);assert.equal(f.get('lost').durationMs,null);assert.equal(f.get('lost').tokenIssue,'CONNECTION_LOST');
});
test('missing observations stay unknown, model changes are conservative, and metadata is bounded and privacy checked',()=>{
  const f=fixture();f.seed();f.begin('empty');f.telemetry.finish('empty');assert.equal(f.get('empty').tokenIssue,'NO_OBSERVATION');assert.equal(f.get('empty').tokens,null);
  f.begin('run');f.telemetry.event({method:'model/rerouted',params:{threadId:'thread-1',turnId:'run',fromModel:'gpt-6.1-sol',toModel:'gpt-6-sol',reason:'highRiskCyberActivity'}});
  assert.equal(f.get('run').modelChanged,true);assert.equal(f.get('run').tokens,null);assert.equal(f.get('run').tokenIssue,'DISCONTINUITY');
  const g=fixture();g.seed();g.begin('run');g.telemetry.event({method:'thread/settings/updated',params:{threadId:'thread-1',threadSettings:{model:'gpt-6-sol',modelProvider:'openai'}}});assert.equal(g.get('run').modelChanged,true);assert.equal(g.get('run').tokenIssue,'DISCONTINUITY');
  for(const model of ['person@example.invalid','sk-fixture-token','https://private.invalid/path','/private/path','x'.repeat(129),null,{}]){
    const h=fixture();h.telemetry.connect('thread-1',model,model);h.begin('run');assert.equal(h.get('run').modelAtStart,null);assert.equal(h.get('run').modelProvider,null);
    assert.doesNotMatch(JSON.stringify(h.get('run')),/person@|sk-fixture|private.invalid|private\/path/);
  }
});
test('retry notices are owned observed notifications and malformed/save failures never interrupt coding',()=>{
  const f=fixture(()=>{throw new Error('PRIVATE_PERSISTENCE');});f.begin('run');
  for(const turnId of ['run','run','foreign'])assert.doesNotThrow(()=>f.telemetry.event({method:'error',params:{threadId:'thread-1',turnId,willRetry:true,error:{message:'PRIVATE_PROVIDER_ERROR'}}}));
  assert.equal(f.get('run').retryNotices,2);assert.equal(f.get('run').tokenIssue,'DISCONTINUITY');
  for(const event of [null,{},[],{method:'thread/tokenUsage/updated',params:null},{method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'run',delta:'PRIVATE_OUTPUT'}}])assert.doesNotThrow(()=>f.telemetry.event(event));
  assert.doesNotThrow(()=>f.telemetry.finish('run'));assert.doesNotMatch(JSON.stringify(f.writes),/PRIVATE_/);
});
test('recent terminal ownership is bounded and evicted turns cannot rewrite old metrics',()=>{
  const f=fixture();for(let index=0;index<130;index++){f.begin('run-'+index);f.usage('run-'+index,counters(100+index*20,20+index*4));f.telemetry.finish('run-'+index);}
  const before=f.writes.length;f.usage('run-0',counters(10000,2000));assert.equal(f.writes.length,before);
  f.begin('active');f.usage('run-0',counters(10000,2000));assert.equal(f.get('active').tokenIssue,'DISCONTINUITY');
});
test('any same-thread foreign turn notice breaks continuity even when it has no token payload or retry',()=>{
  for(const event of [{method:'item/completed',params:{threadId:'thread-1',turnId:'foreign',item:{text:'PRIVATE_OUTPUT'}}},
    {method:'turn/completed',params:{threadId:'thread-1',turn:{id:'foreign',status:'completed'}}},
    {method:'error',params:{threadId:'thread-1',turnId:'foreign',willRetry:false}}]){
    const f=fixture();f.seed();f.begin('run');f.telemetry.event(event);assert.equal(f.get('run').tokenIssue,'DISCONTINUITY');assert.equal(f.get('run').tokens,null);
    assert.doesNotMatch(JSON.stringify(f.writes),/PRIVATE_OUTPUT/);
  }
});
test('zero counters are measured zero and the schema optional cache-write field defaults to zero',()=>{
  const f=fixture(),zero=counters(0,0);delete (zero as Partial<TokenCounters>).cacheWriteInputTokens;
  f.begin('first');f.usage('first',zero,zero);f.telemetry.finish('first');assert.equal(f.get('first').tokens,null);
  f.begin('next');f.usage('next',zero,zero);assert.deepEqual(f.get('next').tokens,counters(0,0));assert.equal(f.get('next').tokenStatus,'observed');
});
test('saved metrics are detached and promise-rejecting callbacks are isolated',async()=>{
  const f=fixture(value=>{value.modelAtStart='mutated';if(value.tokens)value.tokens.totalTokens=999;return Promise.reject(new Error('PRIVATE_SAVE'));});
  f.seed();f.begin('run');f.usage('run',counters(180,60));f.telemetry.finish('run');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.get('run').modelAtStart,'gpt-6.1-sol');assert.equal(f.get('run').tokens?.totalTokens,120);
  for(const unsafe of ['C:\\private\\path','C:/private/path','provider/../secret','127.0.0.1','111-22-3333']){
    const g=fixture();g.telemetry.connect('thread-1',unsafe,unsafe);g.begin('run');assert.equal(g.get('run').modelAtStart,null);assert.equal(g.get('run').modelProvider,null);
  }
});
