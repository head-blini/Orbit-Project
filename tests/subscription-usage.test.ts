import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCodexSubscriptionUsage,normalizeClaudeSubscriptionUsage,subscriptionUsageFreshness,parseCodexUsage} from '../server/usage.ts';
import type {SubscriptionUsageContext} from '../server/usage.ts';

const at='2026-10-29T00:00:00.000Z',later='2026-10-29T01:00:00.000Z';
const context:SubscriptionUsageContext={providerId:'provider-1',runtimeId:'runtime-1',connectionRef:'connection-1',evidence:'mock',observedAt:at,lastAttemptAt:at,now:at,connected:true};
const window=(utilization:unknown,status='allowed',resetsAt:unknown=later)=>({id:'five_hour',utilization,status,resetsAt});
const claude=(windows:unknown[],status='allowed',options=context)=>normalizeClaudeSubscriptionUsage({status,windows},options);
const codex=(rate:unknown,activity:unknown=null,options=context)=>normalizeCodexSubscriptionUsage(parseCodexUsage(rate,activity,at),options);

test('Codex zero remaining is known, missing quota stays null despite known activity',()=>{
  const zero=codex({rateLimits:{primary:{usedPercent:100,windowDurationMins:300,resetsAt:1793235600}}});
  assert.equal(zero.buckets?.[0].primary?.remainingPercent,0);
  assert.equal(zero.buckets?.[0].primary?.remainingSource,'computed');
  assert.equal(zero.providerStatus,'unknown');
  const absent=codex(null,{summary:{lifetimeTokens:0},dailyUsageBuckets:[]});
  assert.equal(absent.dataStatus,'unknown');assert.equal(absent.buckets,null);assert.equal(absent.observedAt,null);
  assert.equal(absent.lastAttemptAt,at);assert.ok(absent.unknownReasons.includes('QUOTA_UNAVAILABLE'));
});
test('Codex partial failure preserves independent windows without claiming completeness',()=>{
  const result=codex({rateLimitsByLimitId:{good:{primary:{usedPercent:25}},bad:{primary:{usedPercent:null}}}});
  assert.equal(result.dataStatus,'partial');assert.equal(result.buckets?.length,1);
  assert.equal(result.buckets?.[0].primary?.remainingPercent,75);
});
test('Claude decimal utilization and endpoints yield computed percentages',()=>{
  for(const [u,remaining] of [[0,100],[1,0],[0.125,87.5]]){
    const result=claude([window(u)]);
    assert.equal(result.dataStatus,'available');assert.equal(result.buckets?.[0].primary?.remainingPercent,remaining);
    assert.equal(result.buckets?.[0].primary?.remainingSource,'computed');
    assert.equal(result.buckets?.[0].primary?.windowDurationMins,null);
  }
});
test('Claude status alone never becomes a percentage',()=>{
  for(const status of ['allowed','allowed_warning','rejected'])for(const u of [null,undefined,-0.1,1.1,NaN,Infinity,'0']){
    const result=claude([window(u,status)],status);
    assert.equal(result.providerStatus,status);assert.equal(result.dataStatus,'partial');
    assert.equal(result.buckets?.[0].primary?.remainingPercent,null);
    assert.equal(result.buckets?.[0].primary?.remainingSource,'unknown');
  }
});
test('unknown-only Claude windows never become available, even with a known overall status',()=>{
  for(const status of ['unknown','allowed']){
    const result=claude([window(null,'unknown')],status);
    assert.notEqual(result.dataStatus,'available');
    assert.equal(result.buckets?.[0].primary?.providerStatus,'unknown');
  }
  assert.equal(claude([window(null,'unknown')],'unknown').dataStatus,'unknown');
});
test('Claude partial windows preserve independent values and statuses',()=>{
  const result=claude([window(0.25),{...window(null,'unknown'),id:'seven_day'}]);
  assert.equal(result.dataStatus,'partial');assert.equal(result.buckets?.[0].primary?.remainingPercent,75);
  assert.equal(result.buckets?.[1].primary?.remainingPercent,null);
});
test('freshness uses only the supplied clock, reset and active connection',()=>{
  assert.equal(subscriptionUsageFreshness(at,'2026-10-29T00:00:59.999Z',later,true),'fresh');
  assert.equal(subscriptionUsageFreshness(at,'2026-10-29T00:01:00.000Z',later,true),'stale');
  assert.equal(subscriptionUsageFreshness(at,at,at,true),'stale');
  assert.equal(subscriptionUsageFreshness(at,at,later,false),'stale');
  assert.equal(subscriptionUsageFreshness(at,at,null,true),'fresh');
  assert.equal(subscriptionUsageFreshness(null,at,null,false),'unknown');
  for(const invalid of ['invalid','2026-02-30T00:00:00.000Z']){
    assert.equal(subscriptionUsageFreshness(invalid,at,null,true),'unknown');
    assert.equal(subscriptionUsageFreshness(at,invalid,null,true),'unknown');
    assert.equal(subscriptionUsageFreshness(at,at,invalid,true),'unknown');
  }
  assert.equal(subscriptionUsageFreshness(later,at,null,true),'unknown');
});
test('restart and elapsed resets preserve last observed values and time',()=>{
  const saved=claude([window(1)]);
  const restored=claude([window(1)],'allowed',{...context,connected:false,lastAttemptAt:later});
  assert.equal(restored.freshness,'stale');assert.equal(restored.observedAt,saved.observedAt);
  assert.deepEqual(restored.buckets,saved.buckets);assert.equal(restored.lastAttemptAt,later);
  const resetPassed=claude([window(1,'rejected',at)],'rejected');
  assert.equal(resetPassed.freshness,'stale');assert.equal(resetPassed.buckets?.[0].primary?.remainingPercent,0);
});
test('invalid observation and reset timestamps are not echoed or refreshed',()=>{
  const result=claude([window(0.5,'allowed','2026-02-30T00:00:00.000Z')],'allowed',{...context,observedAt:'bad',lastAttemptAt:'bad'});
  assert.equal(result.observedAt,null);assert.equal(result.lastAttemptAt,null);assert.equal(result.freshness,'unknown');
  assert.equal(result.buckets?.[0].primary?.resetsAt,null);assert.notEqual(result.dataStatus,'available');
});
test('windows and pools are never summed or inferred from matching names',()=>{
  const result=claude([window(0.25),{...window(0.5),id:'seven_day'}]);
  assert.deepEqual(result.buckets?.map(b=>b.primary?.remainingPercent),[75,50]);
  assert.equal(result.poolRef,null);assert.equal(result.sharing,'unknown');
  assert.equal(result.accountRef,null);assert.equal(result.identityStatus,'unknown');
  const second=claude([window(0.25)],'allowed',{...context,connectionRef:'connection-2'});
  assert.equal(second.poolRef,null);assert.notEqual(second.connectionRef,result.connectionRef);
});
test('evidence and explicit account/pool references stay separate and detached',()=>{
  const refs=['event-1'];
  const options:SubscriptionUsageContext={...context,accountRef:'account-1',identityStatus:'observed',evidenceRefs:refs,pool:{poolRef:'pool-1',sharing:'shared',evidenceRefs:['proof-1']}};
  const mock=claude([window(0)],'allowed',options);
  const native=claude([window(0)],'allowed',{...options,evidence:'native'});
  assert.equal(mock.source.evidence,'mock');assert.equal(native.source.evidence,'native');
  assert.equal(native.source.interfaceId,'claude-code.stream-json.rate_limit_event.rate_limit_info');
  assert.equal(native.accountRef,'account-1');assert.equal(native.identityStatus,'observed');
  assert.equal(native.poolRef,'pool-1');assert.equal(native.sharing,'shared');
  refs.push('event-2');assert.deepEqual(mock.source.evidenceRefs,['event-1']);
  assert.equal(claude([window(0)],'allowed',{...context,accountRef:'alias'}).accountRef,null);
  assert.equal(claude([window(0)],'allowed',{...options,pool:{poolRef:'pool-1',sharing:'shared',evidenceRefs:[]}}).sharing,'unknown');
});
test('malformed Claude windows fail closed without invoking getters or leaking raw fields',()=>{
  let reads=0;const bad={id:'bad'};Object.defineProperty(bad,'utilization',{get(){reads++;return 0;}});
  const result=claude([bad,{...window(0.5),private:'PRIVATE_RAW'}]);
  assert.equal(reads,0);assert.equal(result.dataStatus,'partial');assert.equal(JSON.stringify(result).includes('PRIVATE_RAW'),false);
  assert.equal(claude(Array.from({length:33},(_,i)=>({...window(0),id:'w'+i}))).dataStatus,'partial');
});
test('complete Codex parse preserves bucket/window boundaries, source and original observation time',()=>{
  const reset=Date.parse(later)/1000;
  const parsed=parseCodexUsage({rateLimitsByLimitId:{first:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:reset},secondary:{usedPercent:50,windowDurationMins:10080,resetsAt:reset}},second:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:reset}}}},
    {summary:{lifetimeTokens:0,peakDailyTokens:0,longestRunningTurnSec:0,currentStreakDays:0,longestStreakDays:0},dailyUsageBuckets:[]},at);
  const result=normalizeCodexSubscriptionUsage(parsed,{...context,observedAt:later,evidence:'unknown'});
  assert.equal(result.dataStatus,'available');assert.equal(result.observedAt,at);assert.equal(result.providerObservedAt,null);
  assert.equal(result.source.interfaceId,'codex-app-server.account/rateLimits/read');assert.equal(result.source.evidence,'unknown');
  assert.ok(result.unknownReasons.includes('EVIDENCE_UNKNOWN'));
  assert.deepEqual(result.buckets?.map(b=>[b.primary?.remainingPercent,b.secondary?.remainingPercent??null]),[[75,50],[90,null]]);
  parsed.buckets![0].primary!.remainingPercent=1;assert.equal(result.buckets?.[0].primary?.remainingPercent,75);
});
test('the earliest window reset makes an observation stale without changing any percentages',()=>{
  const result=claude([window(0.25),{...window(0.5,'allowed',at),id:'seven_day'}]);
  assert.equal(result.freshness,'stale');assert.deepEqual(result.buckets?.map(b=>b.primary?.remainingPercent),[75,50]);
});

test('every observed reset is checked regardless of bucket order or missing earlier resets',()=>{
  for(const windows of [
    [window(0.25),{...window(0.5,'allowed',at),id:'seven_day'}],
    [window(0.25,'allowed',null),{...window(0.5,'allowed',at),id:'seven_day'}],
    [{...window(0.5,'allowed',at),id:'seven_day'},window(0.25)],
  ])assert.equal(claude(windows).freshness,'stale');
});
