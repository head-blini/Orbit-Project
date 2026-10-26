import test from 'node:test';
import assert from 'node:assert/strict';
import {unknownUsage,parseCodexUsage,collectCodexUsage} from '../server/usage.ts';

const checkedAt='2026-10-25T00:00:00.000Z';
const summary={lifetimeTokens:100,peakDailyTokens:20,longestRunningTurnSec:1,currentStreakDays:0,longestStreakDays:2};
const usage=()=>({summary:{...summary},dailyUsageBuckets:[{startDate:'2026-10-25',tokens:0}]});
const quota=()=>({rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:0},secondary:null}});

test('unqueried usage is explicitly unknown and never invents token counts, quota or API cost',()=>{
  assert.deepEqual(unknownUsage(),{status:'unknown',source:'not_queried',checkedAt:null,buckets:null,summary:null,daily:null,billing:'unknown',apiCostUsd:null});
  const mutated=unknownUsage();mutated.status='available';assert.equal(unknownUsage().status,'unknown');
});
test('official response fields produce explicit quota, token activity and source without private metadata',()=>{
  const rate={...quota(),accountId:'SYNTHETIC_PRIVATE_ACCOUNT',credits:{balance:'SYNTHETIC_PRIVATE_BALANCE'},label:'SYNTHETIC_PRIVATE_LABEL'};
  const output=parseCodexUsage(rate,{...usage(),threadUsage:{estimatedUsageUsdMicros:1000,user:'SYNTHETIC_PRIVATE_USER'}},checkedAt);
  assert.equal(output.status,'available');assert.equal(output.source,'codex_app_server');assert.equal(output.checkedAt,checkedAt);assert.equal(output.billing,'chatgpt_subscription');assert.equal(output.apiCostUsd,null);
  assert.deepEqual(output.buckets,[{id:'codex',primary:{usedPercent:25,remainingPercent:75,windowDurationMins:300,resetsAt:'1970-01-01T00:00:00.000Z'},secondary:null}]);
  assert.deepEqual(output.summary,summary);assert.deepEqual(output.daily,[{date:'2026-10-25',tokens:0}]);assert.equal(JSON.stringify(output).includes('SYNTHETIC_PRIVATE'),false);
});
test('multi-bucket quota is authoritative over legacy, including empty and malformed maps',()=>{
  const rate={...quota(),rateLimitsByLimitId:{codex_other:{limitId:'codex_other',primary:{usedPercent:125}},codex:{primary:{usedPercent:0}}}};
  const output=parseCodexUsage(rate,null,checkedAt);assert.equal(output.status,'partial');assert.deepEqual(output.buckets?.map(bucket=>bucket.id),['codex','codex_other']);assert.equal(output.buckets?.[0].primary?.remainingPercent,100);assert.equal(output.buckets?.[1].primary?.remainingPercent,0);
  assert.deepEqual(parseCodexUsage({...quota(),rateLimitsByLimitId:{}},null,checkedAt).buckets,[]);
  assert.equal(parseCodexUsage({...quota(),rateLimitsByLimitId:[]},null,checkedAt).buckets,null);
  assert.equal(parseCodexUsage({...quota(),rateLimitsByLimitId:null},null,checkedAt).buckets?.[0].id,'codex');
  assert.equal(parseCodexUsage({rateLimits:{primary:{usedPercent:1}}},null,checkedAt).buckets?.[0].id,'legacy');
});
test('missing and null quota values stay unknown while optional invalid metadata becomes null',()=>{
  for(const usedPercent of [undefined,null,-1,0.5,NaN,Infinity,'25'])assert.equal(parseCodexUsage({rateLimits:{limitId:'codex',primary:{usedPercent}}},null,checkedAt).buckets,null);
  const output=parseCodexUsage({rateLimits:{primary:{usedPercent:50,windowDurationMins:'300',resetsAt:Infinity}}},{summary:{lifetimeTokens:0}},checkedAt);
  assert.equal(output.status,'partial');assert.deepEqual(output.buckets?.[0].primary,{usedPercent:50,remainingPercent:50,windowDurationMins:null,resetsAt:null});assert.equal(output.summary?.lifetimeTokens,0);assert.equal(output.summary?.peakDailyTokens,null);assert.equal(output.daily,null);
});
test('token counters reject coercion, negatives, fractions and unsafe integers without replacing unknown with zero',()=>{
  for(const count of [undefined,null,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'0']){
    const output=parseCodexUsage(null,{summary:{lifetimeTokens:count},dailyUsageBuckets:[{startDate:'2026-10-25',tokens:count}]},checkedAt);
    assert.equal(output.summary,null);assert.deepEqual(output.daily,[{date:'2026-10-25',tokens:null}]);assert.equal(output.status,'partial');
  }
});
test('calendar dates and reset timestamps are validated, never echoed or normalized from invalid inputs',()=>{
  const output=parseCodexUsage({rateLimits:{primary:{usedPercent:2,resetsAt:Number.MAX_SAFE_INTEGER}}},{summary:{},dailyUsageBuckets:[{startDate:'2026-02-30',tokens:3},{startDate:'2024-02-29',tokens:4},{startDate:'SYNTHETIC_PRIVATE_DATE',tokens:5}]},checkedAt);
  assert.equal(output.buckets?.[0].primary?.resetsAt,null);assert.deepEqual(output.daily,[{date:'2024-02-29',tokens:4}]);assert.equal(output.status,'partial');assert.equal(JSON.stringify(output).includes('SYNTHETIC_PRIVATE_DATE'),false);
  const invalidTimestamp=parseCodexUsage(quota(),usage(),'SYNTHETIC_PRIVATE_TIMESTAMP');assert.equal(invalidTimestamp.status,'unknown');assert.equal(invalidTimestamp.checkedAt,null);assert.equal(JSON.stringify(invalidTimestamp).includes('SYNTHETIC_PRIVATE'),false);
});
test('bucket IDs reject credential patterns and mismatched identities while preserving independent valid facts',()=>{
  const output=parseCodexUsage({rateLimitsByLimitId:{'sk-synthetic-secret':{primary:{usedPercent:1}},'glpat-SYNTHETIC':{primary:{usedPercent:1}},'person@example.test':{primary:{usedPercent:1}},mismatch:{limitId:'other',primary:{usedPercent:1}},codex:{primary:{usedPercent:20},limitName:'SYNTHETIC_PRIVATE_LABEL'}}},usage(),checkedAt);
  assert.deepEqual(output.buckets?.map(bucket=>bucket.id),['codex']);assert.equal(output.status,'partial');assert.equal(JSON.stringify(output).includes('synthetic-secret'),false);assert.equal(JSON.stringify(output).includes('SYNTHETIC_PRIVATE'),false);
});
test('oversized and duplicate sections fail closed instead of truncating or double-counting facts',()=>{
  const many=Object.fromEntries(Array.from({length:33},(_,index)=>['bucket'+index,{primary:{usedPercent:1}}]));
  const output=parseCodexUsage({rateLimitsByLimitId:many},usage(),checkedAt);assert.equal(output.buckets,null);assert.equal(output.status,'partial');
  const days=Array.from({length:367},(_,index)=>({startDate:new Date(Date.UTC(2024,0,index+1)).toISOString().slice(0,10),tokens:1}));
  assert.equal(parseCodexUsage(quota(),{summary,dailyUsageBuckets:days},checkedAt).daily,null);
  assert.equal(parseCodexUsage(quota(),{summary,dailyUsageBuckets:[{startDate:'2026-10-25',tokens:1},{startDate:'2026-10-25',tokens:2}]},checkedAt).daily,null);
  const allowedBuckets=Object.fromEntries(Array.from({length:32},(_,index)=>['bucket'+index,{primary:{usedPercent:1}}]));
  assert.equal(parseCodexUsage({rateLimitsByLimitId:allowedBuckets},null,checkedAt).buckets?.length,32);
  const allowedDays=days.slice(0,366),atBoundary=parseCodexUsage(quota(),{summary,dailyUsageBuckets:allowedDays},checkedAt);
  assert.equal(atBoundary.daily?.length,366);assert.deepEqual(atBoundary.daily?.at(-1),{date:'2024-12-31',tokens:1});
});
test('parsing is detached and never invokes data getters or prints proxy exceptions',()=>{
  let invoked=0;const rate=quota(),activity=usage();
  const output=parseCodexUsage(rate,activity,checkedAt);rate.rateLimits.primary.usedPercent=99;activity.summary.lifetimeTokens=999;assert.equal(output.buckets?.[0].primary?.usedPercent,25);assert.equal(output.summary?.lifetimeTokens,100);
  const getters={};Object.defineProperty(getters,'rateLimits',{enumerable:true,get(){invoked++;throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});Object.defineProperty(getters,'accountId',{enumerable:true,get(){invoked++;throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});
  assert.equal(parseCodexUsage(getters,null,checkedAt).status,'unknown');assert.equal(invoked,0);
  const proxy=new Proxy({},{getPrototypeOf(){throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});const result=parseCodexUsage(proxy,proxy,checkedAt);assert.equal(result.status,'unknown');assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);
  const inherited=Object.create({rateLimits:quota().rateLimits});assert.equal(parseCodexUsage(inherited,null,checkedAt).status,'unknown');
});
test('an authoritative map accessor cannot enable the legacy fallback or expose mismatched identity',()=>{
  let invoked=0;const data=quota();Object.defineProperty(data,'rateLimitsByLimitId',{get(){invoked++;throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});
  assert.equal(parseCodexUsage(data,null,checkedAt).buckets,null);assert.equal(invoked,0);
  const legacy=quota();Object.defineProperty(legacy.rateLimits,'limitId',{get(){invoked++;return 'SYNTHETIC_PRIVATE_DETAILS';}});
  assert.equal(parseCodexUsage(legacy,null,checkedAt).buckets,null);assert.equal(invoked,0);
});
test('collector launches exactly two read-only requests in parallel and preserves partial failures',async()=>{
  const calls:{method:string;params:unknown}[]=[];let resolveRate!:(value:unknown)=>void,resolveUsage!:(value:unknown)=>void;
  const collected=collectCodexUsage((method,params)=>{calls.push({method,params});return new Promise(resolve=>{if(method==='account/rateLimits/read')resolveRate=resolve;else resolveUsage=resolve;});});
  await Promise.resolve();assert.deepEqual(calls,[{method:'account/rateLimits/read',params:{excludeResetCreditDetails:true}},{method:'account/usage/read',params:{}}]);resolveRate(quota());resolveUsage(usage());assert.equal((await collected).status,'available');
  const partial=await collectCodexUsage(async method=>{if(method==='account/rateLimits/read')throw new Error('SYNTHETIC_PRIVATE_DETAILS');return usage();});assert.equal(partial.status,'partial');assert.equal(partial.buckets,null);assert.deepEqual(partial.summary,summary);assert.equal(JSON.stringify(partial).includes('SYNTHETIC_PRIVATE'),false);
});
test('synchronous request failures cannot prevent the other read and unavailable results stay unknown',async()=>{
  let calls=0;const output=await collectCodexUsage(()=>{calls++;throw new Error('SYNTHETIC_PRIVATE_DETAILS');});assert.equal(calls,2);assert.equal(output.status,'unknown');assert.equal(output.source,'codex_app_server');assert.equal(output.apiCostUsd,null);assert.equal(JSON.stringify(output).includes('SYNTHETIC_PRIVATE'),false);
});
