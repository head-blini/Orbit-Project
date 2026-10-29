import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import ts from 'typescript';
import type {SubscriptionUsageObservation,SubscriptionQuotaWindow} from '../shared/usage.ts';

async function load(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/usage.tsx');}finally{hooks.deregister();}
}
const window=(over:Partial<SubscriptionQuotaWindow>={}):SubscriptionQuotaWindow=>({usedPercent:20,remainingPercent:80,windowDurationMins:300,resetsAt:null,remainingSource:'computed',providerStatus:'allowed',...over});
const observation=(over:Partial<SubscriptionUsageObservation>={}):SubscriptionUsageObservation=>({providerId:'claude-code',runtimeId:'claude-code',connectionRef:'run-1',accountRef:null,identityStatus:'unknown',
  source:{interfaceId:'claude.stream-json.rate_limit_event',evidence:'native',evidenceRefs:[]},observedAt:'2026-10-29T01:00:00.000Z',providerObservedAt:null,lastAttemptAt:null,
  dataStatus:'available',freshness:'stale',providerStatus:'allowed',unknownReasons:['IDENTITY_UNKNOWN','POOL_UNKNOWN'],buckets:[],poolRef:null,sharing:'unknown',poolEvidenceRefs:[],...over});

test('subscription usage labels never invent quota, identity, freshness or sharing',async()=>{
  const {windowLabel,subscriptionSummary}=await load();
  assert.match(windowLabel(window()),/잔여 80% \(계산값\) · 허용/);
  assert.match(windowLabel(window({remainingPercent:null,usedPercent:null,remainingSource:'unknown',providerStatus:'rejected'})),/^잔여 unknown · 한도 도달/);
  const summary=subscriptionSummary(observation());
  for(const part of ['Claude Code','계정 미식별','마지막 관측 · 오래됨','공유 여부 미확인','공식 관측'])assert.ok(summary.includes(part),part);
  assert.match(subscriptionSummary(observation({source:{interfaceId:'x',evidence:'mock',evidenceRefs:[]},freshness:'fresh'})),/최신.*모의 관측/);
  assert.match(subscriptionSummary(observation({observedAt:null,freshness:'unknown'})),/관측 시각 미확인 · 관측 없음/);
});
