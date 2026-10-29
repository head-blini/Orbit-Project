import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './capability-fixtures.ts';
import {CapabilityExecutionService} from '../server/capability-execution.ts';
import {CapabilityRuntimeAdapters} from '../server/capability-runtime-adapters.ts';
import type {Controller} from '../server/controller.ts';
import {generalAcceptance} from '../server/acceptance.ts';

function setup(){
 const f=fixture(); f.registry.providers[1].version='2.1.312'; let calls=0;
 const controller={store:f.store,submitTask:async(projectId:string,taskId:string,input:{requestId:string})=>{
  calls++;const run=f.store.createRun(input.requestId,'digest','approved task',undefined,{runtime:'claude-code',projectId,taskId,planningVersionId:f.plan.id,planningContentHash:f.plan.contentHash,requirementLabels:f.task.requirementLabels},undefined,generalAcceptance(f.store,projectId,taskId));
  return f.store.updateRun(run.id,{execution:'running'},'run.started');
 },interrupt:async(id:string)=>{f.store.updateRun(id,{execution:'interrupting'},'interrupt.requested');}} as unknown as Controller;
 const adapters=new CapabilityRuntimeAdapters(controller),service=new CapabilityExecutionService(f.store,controller,()=>f.registry,adapters);
 const route=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'문서 작성'},f.registry);
 const plan=()=>service.plan('p',{requestId:randomUUID(),routeId:route.id});
 return {...f,routing:f.service,controller,adapters,service,route,plan,get calls(){return calls;}};
}
test('execution plan requires explicit digest approval, dispatches approved task once and keeps actual model unknown',async()=>{
 const f=setup();try{const p=f.plan();assert.equal(p.status,'awaiting_approval');assert.equal(f.calls,0);
 await assert.rejects(f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:'0'.repeat(64)}),/PLAN_CHANGED/);
 const input={confirmed:true as const,expectedPlanDigest:p.planDigest};
 const [a,b]=await Promise.all([f.service.start('p',p.id,input),f.service.start('p',p.id,input)]);
 assert.equal(f.calls,1);assert.equal(a.id,b.id);assert.equal(f.service.record('p',p.id).models.actualModelId,'unknown');
 assert.equal(f.service.record('p',p.id).status,'running');
 }finally{f.store.close();}
});
test('version changes invalidate a plan and unsupported slash recommendations never dispatch',async()=>{
 const f=setup();try{const p=f.plan();f.registry.providers[1].version='2.1.313';
 await assert.rejects(f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest}),/PLAN_CHANGED/);assert.equal(f.calls,0);
 const route=f.routing.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'/review 실행'},f.registry);
 assert.throws(()=>f.service.plan('p',{requestId:randomUUID(),routeId:route.id}),/ROUTE_NOT_EXECUTABLE/);
 }finally{f.store.close();}
});
test('interrupt requested is not confirmed; restart recovery observes original run without redispatch',async()=>{
 const f=setup();try{const p=f.plan();await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
 await f.service.interrupt('p',p.id);assert.equal(f.service.record('p',p.id).status,'interrupt_requested');
 f.store.updateRun(f.service.record('p',p.id).runId!,{execution:'interrupted'},'run.interrupted');
 const reopened=new CapabilityExecutionService(f.store,f.controller,()=>f.registry,f.adapters);
 assert.equal(reopened.record('p',p.id).status,'interrupted');
 await reopened.recover('p',p.id);assert.equal(f.calls,1);
 }finally{f.store.close();}
});
test('failed dispatch is quarantined and duplicate request cannot silently retry or switch providers',async()=>{
 const f=setup();try{f.controller.submitTask=async()=>{throw Error('secret-token-should-not-be-stored');};
 const p=f.plan();const record=await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
 assert.equal(record.status,'recovery_required');assert.doesNotMatch(JSON.stringify(record),/secret-token/);
 await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
 assert.equal(f.service.record('p',p.id).status,'recovery_required');
 await assert.rejects(f.service.recover('p',p.id),/EXECUTION_UNCONFIRMED/);
 assert.throws(()=>f.plan(),/EXECUTION_RECOVERY_REQUIRED/);
 }finally{f.store.close();}
});
test('code plan captures selected workspace and acceptance before approval',()=>{
 const f=fixture('code');try{
 const route=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'코드 구현'},f.registry);
 const controller={store:f.store,snapshot:()=>({selectedWorkspaceId:'workspace'}),taskVerificationPreview:()=>({digest:'a'.repeat(64)}),submitTask:async()=>{throw Error('not approved');},interrupt:async()=>{}} as unknown as Controller;
 const service=new CapabilityExecutionService(f.store,controller,()=>f.registry);
 const p=service.plan('p',{requestId:randomUUID(),routeId:route.id});assert.equal(p.workspaceId,'workspace');assert.equal(p.expectedAcceptanceDigest,'a'.repeat(64));
 }finally{f.store.close();}
});
test('credential shaped request identifiers are rejected before persistence',()=>{
 const f=setup();try{assert.throws(()=>f.service.plan('p',{requestId:'sk-proj-'+'A'.repeat(50),routeId:f.route.id}),/INVALID_FIELDS/);assert.equal(f.service.records('p').length,0);}finally{f.store.close();}
});
test('adapter replacement invalidates saved approval and disable prevents a new plan',async()=>{
 const f=setup();try{const p=f.plan();f.adapters.register({runtimeId:'claude-code',adapterId:'reviewed-v2',compatible:()=>true},{trusted:true});
 await assert.rejects(f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest}),/PLAN_CHANGED/);assert.equal(f.calls,0);
 f.adapters.disable('claude-code');assert.throws(()=>f.plan(),/ADAPTER_DISABLED/);
 }finally{f.store.close();}
});
test('a second prepared plan cannot dispatch concurrently and stale provider selection cannot fall back',async()=>{
 const f=setup();try{const a=f.plan(),b=f.plan();await f.service.start('p',a.id,{confirmed:true,expectedPlanDigest:a.planDigest});
 await assert.rejects(f.service.start('p',b.id,{confirmed:true,expectedPlanDigest:b.planDigest}),/EXECUTION_RECOVERY_REQUIRED/);assert.equal(f.calls,1);
 }finally{f.store.close();}
});
test('changed provider preferences invalidate existing plan without fallback',async()=>{
 const f=fixture('code');try{const route=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'코드 구현'},f.registry);
 const controller={snapshot:()=>({selectedWorkspaceId:'workspace'}),taskVerificationPreview:()=>null} as unknown as Controller;
 const service=new CapabilityExecutionService(f.store,controller,()=>f.registry);const p=service.plan('p',{requestId:randomUUID(),routeId:route.id});
 const {ProjectAiPreferencesService}=await import('../server/project-ai-preferences.ts');new ProjectAiPreferencesService(f.store).update('p',{execution:'codex',planning:'claude-code',expectedRevision:0});
 await assert.rejects(service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest}),/PLAN_CHANGED/);
 }finally{f.store.close();}
});
test('quality approval cannot smuggle credentials into persisted reviewer settings',()=>{
 const f=setup();try{const p=f.plan();assert.throws(()=>f.service.qualityPreview('p',p.id,[{id:'review',providerId:'anthropic',modelId:'sk-proj-'+'A'.repeat(50)}],{maxRepairs:0,maxCalls:1,timeoutMs:100}),/SENSITIVE_EXECUTION_INPUT/);}finally{f.store.close();}
});
test('synchronous policy change before adapter entry is a known failure, not permanent unknown dispatch',async()=>{
 const f=setup();try{const p=f.plan();f.store.on('event',event=>{if(event.kind==='capability.execution'&&event.data.status==='dispatching')f.registry.providers[1].version='2.1.313';});
 const result=await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
 assert.equal(f.calls,0);assert.equal(result.status,'failed');assert.equal(result.recoveryRequired,false);assert.equal(result.issue,'EXECUTION_PREFLIGHT_CHANGED');assert.doesNotThrow(()=>f.plan());
 }finally{f.store.close();}
});
test('durable dispatch intent survives database reopen and only observed terminal execution releases recovery',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('./temp.ts'),{Store}=await import('../server/store.ts');
 const dir=mkdtempSync(join(tmpdir(),'orbit-capability-restart-')),path=join(dir,'db.sqlite'),f=fixture('general',path);f.registry.providers[1].version='2.1.312';
 const controller={submitTask:async()=>{throw Error('uncertain');},interrupt:async()=>{}} as unknown as Controller;
 const service=new CapabilityExecutionService(f.store,controller,()=>f.registry),route=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'문서 작성'},f.registry),p=service.plan('p',{requestId:randomUUID(),routeId:route.id});
 await service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});f.store.close();
 const store=new Store(path);try{let calls=0;controller.submitTask=async()=>{calls++;throw Error();};const resumed=new CapabilityExecutionService(store,controller,()=>f.registry);
 await resumed.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});assert.equal(calls,0);await assert.rejects(resumed.recover('p',p.id),/EXECUTION_UNCONFIRMED/);
 const run=store.createRun(p.dispatchRequestId,'known','approved',undefined,{runtime:'claude-code',projectId:'p',taskId:f.task.id,planningVersionId:p.baseline.planningVersionId,planningContentHash:p.baseline.planningContentHash},undefined,generalAcceptance(store,'p',f.task.id));store.updateRun(run.id,{execution:'failed'},'run.failed');
 const recovered=await resumed.recover('p',p.id);assert.equal(recovered.recoveryRequired,false);assert.equal(recovered.status,'failed');assert.equal(calls,0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('adapter result must reference the durable request and approved task, never a fabricated completed run',async()=>{
 const f=setup();try{f.controller.submitTask=async()=>({id:'invented',execution:'completed'}) as never;const p=f.plan();
 const result=await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});assert.equal(result.status,'recovery_required');assert.equal(result.runId,null);
 }finally{f.store.close();}
});
test('history display limits cannot hide an older unresolved dispatch from the safety gate',async()=>{
 const f=setup();try{f.controller.submitTask=async()=>{throw Error('uncertain');};const p=f.plan();await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
 const insert=f.store.db.prepare('INSERT INTO capability_executions VALUES(?,?,?,?,?)');
 for(let i=0;i<201;i++)insert.run('other-'+i,'p','request-'+i,'digest',JSON.stringify({...p,id:'other-'+i,taskId:'other',status:'awaiting_approval'}));
 assert.throws(()=>f.plan(),/EXECUTION_RECOVERY_REQUIRED/);
 }finally{f.store.close();}
});

test('restart reconciles the original terminal dispatch without demanding recovery or launching again',async()=>{
 for(const execution of ['completed','failed','interrupted'] as const){
  const f=setup();try{
   const p=f.plan();await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
   const run=f.store.findRequest(p.dispatchRequestId)!.run;f.store.updateRun(run.id,{execution},'run.'+execution);
   const reopened=new CapabilityExecutionService(f.store,f.controller,()=>f.registry,f.adapters),record=reopened.record('p',p.id);
   assert.equal(record.recoveryRequired,false);assert.equal(record.issue,null);assert.equal(record.status,execution==='completed'?'execution_completed':execution);
   assert.equal(record.runId,run.id);assert.doesNotThrow(()=>f.plan());assert.equal(f.calls,1);
  }finally{f.store.close();}
 }
});
test('restart and explicit recovery never release a mismatched receipt or an unconfirmed process',async()=>{
 for(const field of ['requestId','runId','taskId','projectId','runtime','workspaceId','planningVersionId','planningContentHash','acceptanceDigest','lost','running'] as const){
  const f=setup();try{
   const p=f.plan();await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
   const run=f.store.findRequest(p.dispatchRequestId)!.run;
   if(field==='runId')f.store.db.prepare("UPDATE capability_executions SET body=json_set(body,'$.runId',?) WHERE id=?").run(randomUUID(),p.id);
   else if(field!=='lost'&&field!=='running')(run as unknown as Record<string,unknown>)[field]=field==='runtime'?'codex':'mismatch';
   run.execution=field==='lost'?'lost':field==='running'?'running':'completed';
   f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run),run.id);
   const reopened=new CapabilityExecutionService(f.store,f.controller,()=>f.registry,f.adapters);
   assert.equal(reopened.record('p',p.id).recoveryRequired,true,field);
   await assert.rejects(reopened.recover('p',p.id),/EXECUTION_UNCONFIRMED/,field);assert.throws(()=>f.plan(),/EXECUTION_RECOVERY_REQUIRED/);assert.equal(f.calls,1);
  }finally{f.store.close();}
 }
});

test('restart finds a completed receipt after dispatch journal loss and preserves reconciliation across another restart',async()=>{
 const f=setup();try{
  const p=f.plan();await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
  const run=f.store.findRequest(p.dispatchRequestId)!.run;f.store.updateRun(run.id,{execution:'completed'},'run.completed');
  f.store.db.prepare("UPDATE capability_executions SET body=json_set(body,'$.runId',null,'$.status','recovery_required','$.recoveryRequired',json('true')) WHERE id=?").run(p.id);
  const reopened=new CapabilityExecutionService(f.store,f.controller,()=>f.registry,f.adapters),record=reopened.record('p',p.id);
  assert.equal(record.runId,run.id);assert.equal(record.recoveryRequired,false);assert.equal(record.status,'execution_completed');
  const seq=f.store.lastSeq();new CapabilityExecutionService(f.store,f.controller,()=>f.registry,f.adapters);
  assert.equal(f.store.lastSeq(),seq);assert.equal(f.calls,1);
 }finally{f.store.close();}
});
