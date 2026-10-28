import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture} from './capability-fixtures.ts';
import {CapabilityInvocationService} from '../server/capability-invocation.ts';
import {CapabilityRuntimeAdapters} from '../server/capability-runtime-adapters.ts';
import {ProjectAiPreferencesService} from '../server/project-ai-preferences.ts';
function setup(){const f=fixture('code');let stops=0;const run=f.store.createRun(randomUUID(),'digest','approved',undefined,{runtime:'claude-code',projectId:'p',taskId:f.task.id,planningVersionId:f.plan.id,planningContentHash:f.plan.contentHash});
 const adapters=new CapabilityRuntimeAdapters({store:f.store,submitTask:async()=>{throw Error('NO_DISPATCH');},interrupt:async()=>{stops++;f.store.updateRun(run.id,{execution:'interrupting'},'interrupt.requested');}});
 const service=new CapabilityInvocationService(f.store,adapters);
 const recommend=(text:string,runId:string|undefined=run.id)=>f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text,runId},f.registry);
 return {...f,routing:f.service,run,adapters,service,recommend,get stops(){return stops;}};}
test('natural lifecycle requests bind the exact existing provider even after preference switch; status is not a new task',async()=>{
 const f=setup();try{assert.equal(new ProjectAiPreferencesService(f.store).read('p').execution,'codex');
 const route=f.recommend('실행 상태 조회');assert.equal(route.status,'recommended');assert.equal(route.runtimeId,'claude-code');assert.ok(route.reasons.includes('EXISTING_RUN_RUNTIME_PRESERVED'));
 const input={requestId:randomUUID(),routeId:route.id,expectedDigest:route.invocationDigest!,confirmed:true as const};const r=await f.service.invoke('p',input);assert.equal(r.status,'completed');assert.equal(r.result?.runId,f.run.id);assert.equal(r.result?.response,null);assert.equal(f.store.runs().length,1);assert.equal(f.stops,0);
 assert.deepEqual(await f.service.invoke('p',input),r);
 }finally{f.store.close();}
});
test('interrupt requires bound approval, is idempotent, survives restart and does not pretend task stopped',async()=>{
 const f=setup();try{const route=f.recommend('실행 중단'),input={requestId:randomUUID(),routeId:route.id,expectedDigest:route.invocationDigest!,confirmed:true as const};
 await assert.rejects(f.service.invoke('p',{...input,confirmed:false as true}),/APPROVAL_REQUIRED/);await assert.rejects(f.service.invoke('p',{...input,expectedDigest:'0'.repeat(64)}),/ROUTE_CHANGED/);assert.equal(f.stops,0);
 const r=await f.service.invoke('p',input);assert.equal(r.status,'requested');assert.equal(r.result?.stopConfirmed,false);assert.equal(f.stops,1);
 const resumed=new CapabilityInvocationService(f.store,f.adapters);await resumed.invoke('p',input);assert.equal(f.stops,1);
 await assert.rejects(resumed.invoke('p',{...input,routeId:randomUUID()}),/IDEMPOTENCY_CONFLICT/);
 }finally{f.store.close();}
});
test('result collection preserves mock provenance and never enables independent verification',async()=>{
 const f=setup();try{f.store.updateRun(f.run.id,{execution:'completed',response:'saved result'},'run.completed');f.store.append('run.runtime_source',f.run.id,{source:'mock',interface:'claude.print'});
 const route=f.recommend('결과 수집');const r=await f.service.invoke('p',{requestId:randomUUID(),routeId:route.id,expectedDigest:route.invocationDigest!,confirmed:true});assert.equal(r.result?.response,'saved result');assert.equal(r.result?.providerEvidence.source,'mock');assert.equal(r.result?.providerEvidence.livePipelineVerified,false);
 }finally{f.store.close();}
});
test('subagent and slash requests cannot become ordinary task execution; ambiguous targets never dispatch',()=>{
 const f=setup();try{for(const text of ['서브에이전트 실행','subagent 실행','/review 실행'])assert.equal(f.routing.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text},f.registry).status,'blocked');
 assert.equal(f.routing.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'상태 조회'},f.registry).status,'needs_clarification');
 assert.throws(()=>f.recommend('상태 조회','00000000-0000-0000-0000-000000000000'),/TARGET_RUN_NOT_FOUND/);
 }finally{f.store.close();}
});
