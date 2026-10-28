import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Controller} from '../server/controller.ts';
import {createHttpServer} from '../server/http.ts';
import {createNativeProbeService} from '../server/capability-probe.ts';
import type {CapabilityExecutionRecord} from '../shared/capability-execution.ts';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';
import type {QualityLoopPreview} from '../shared/quality-loop-record.ts';
import type {ProjectProgress} from '../shared/project-progress.ts';
import {claudeFixture,outcome,session,tick} from './claude-task-fixture.ts';

// Real HTTP, Controller, persistence, artifacts and Quality Loop; provider discovery/processes are mocks.
for(const observed of [false,true])test(`mock provider vertical HTTP execution: ${observed?'independent evidence reaches verified quality':'unknown identity stays blocked'}`,async()=>{
 const f=claudeFixture();let reviews=0,probes=0;
 const controller=new Controller(f.store,f.dir,()=>{throw Error('LIVE_CODEX_FORBIDDEN');},f.projects,[],[],f.dependencies,{}, {
  findExecutable:()=>'/fake/claude',claudeFactory:()=>({interrupt:()=> 'requested',async start(_prompt,onEvent){
   reviews++;onEvent({kind:'session',sessionId:'independent-review',model:'alias',permissionMode:'plan',auth:'subscription',tools:[]});
   return outcome('completed',{identity:{providerId:'anthropic',modelId:'model-b',sessionId:'independent-review',executionId:null,modelEvidence:'assistant_message'},response:JSON.stringify({verdict:'approve',baseline_respected:true,criteria:[{criterion:'Cite evidence',status:'met',evidence:'Local report includes citation'}],findings:[]})});
  }})
 });
 const probe=createNativeProbeService(async()=>{probes++;return {checkedAt:new Date().toISOString(),codex:{status:'not_found_on_path',version:null},claude:{status:'found',version:'2.1.259'}};});
 const server=createHttpServer(controller,'unused',{nativeProbe:probe});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const {task}=f.plan(),base='/api/projects/'+f.project.id,path=base+'/capability-executions';
  assert.equal((await fetch(origin+path)).status,401);
  assert.equal((await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const sessionResponse=await fetch(origin+'/api/session'),cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await sessionResponse.json() as {csrfToken:string};
  const headers={cookie,origin,'x-csrf-token':csrfToken,'content-type':'application/json'};
  const get=(url:string)=>fetch(origin+url,{headers:{cookie}}),post=(url:string,input:unknown)=>fetch(origin+url,{method:'POST',headers,body:JSON.stringify(input)});
  async function json<T>(response:Response):Promise<T>{const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value as T;}
  assert.equal((await get(path)).status,200);assert.equal(probes,0);
  assert.equal((await fetch(origin+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'})).status,403);
  await json(await post('/api/capability-orchestration/refresh',{}));assert.equal(probes,1);
  const route=await json<CapabilityRouteDecision>(await post(base+'/capability-routes',{requestId:randomUUID(),taskId:task.id,text:'보고서 작성'}));
  assert.equal(route.status,'recommended');assert.equal(route.executionAuthorized,false);
  const input={requestId:randomUUID(),routeId:route.id};
  for(const forged of [{actualModelId:'forged'},{runtimeId:'codex'},{approved:true},{command:'/unsupported'}])assert.equal((await post(path,{...input,...forged})).status,400);
  const plan=await json<CapabilityExecutionRecord>(await post(path,input)),url=path+'/'+plan.id;
  assert.equal(plan.status,'awaiting_approval');assert.equal(plan.models.actualModelId,'unknown');assert.equal(f.runners.length,0);
  assert.equal((await json<CapabilityExecutionRecord>(await post(path,input))).id,plan.id);
  assert.equal((await post(path,{...input,routeId:randomUUID()})).status,409);
  const seq=f.store.lastSeq();
  await json(await get(url));await json(await get(path));await json(await get(base+'/progress'));
  assert.equal(f.store.lastSeq(),seq);assert.equal(f.runners.length,0);assert.equal(probes,1);
  assert.equal((await get(url+'/start')).status,404);assert.equal((await get(url+'?run=1')).status,400);
  const approval={confirmed:true,expectedPlanDigest:plan.planDigest};
  assert.equal((await post(url+'/start',{...approval,confirmed:false})).status,409);
  assert.equal((await post(url+'/start',{...approval,actualModelId:'forged'})).status,400);
  assert.equal((await post(url+'/start',{...approval,expectedPlanDigest:'0'.repeat(64)})).status,409);
  const starts=await Promise.all([post(url+'/start',approval),post(url+'/start',approval)]);
  const started=await json<CapabilityExecutionRecord>(starts[0]);await json(starts[1]);
  assert.equal(started.status,'running');assert.equal(f.runners.length,1);assert.equal(f.store.runs().length,1);
  assert.equal(f.store.getRun(started.runId!)!.taskId,task.id);
  writeFileSync(join(f.project.path,`task-${task.id.slice(0,8)}.md`),'# Report\nCitation: local evidence.');
  f.runners[0].finish(outcome('completed',observed?{identity:{providerId:'anthropic',modelId:'model-a',sessionId:session.sessionId,executionId:null,modelEvidence:'assistant_message'}}:{}));await tick();
  const completed=await json<CapabilityExecutionRecord>(await get(url));
  assert.equal(completed.status,'execution_completed');assert.equal(completed.models.actualModelId,observed?'model-a':'unknown');
  const qualityInput={reviewers:[{id:'reader',providerId:'anthropic',modelId:'model-b'}],limits:{maxRepairs:0,maxCalls:1,timeoutMs:3000}};
  const preview=await json<QualityLoopPreview>(await post(url+'/quality-preview',qualityInput));
  assert.equal(reviews,0);assert.equal(preview.producer.source,observed?'native_observed':'unknown');
  const qualityStart={...qualityInput,requestId:randomUUID(),confirmed:true,expectedPreviewDigest:preview.previewDigest};
  assert.equal((await post(url+'/quality-start',{...qualityStart,producer:{modelId:'forged'}})).status,400);
  const quality=await json<CapabilityExecutionRecord>(await post(url+'/quality-start',qualityStart));
  await controller.qualityLoops.settled(quality.qualityLoopId!);
  const final=await json<CapabilityExecutionRecord>(await get(url));
  assert.equal(final.providerEvidence?.source,'mock');assert.equal(final.providerEvidence?.livePipelineVerified,false);
  assert.equal(final.providerEvidence?.costUsd,null);assert.equal(final.providerEvidence?.remainingQuota,null);
  assert.equal(final.status,observed?'quality_passed':'quality_blocked',JSON.stringify(final.quality));assert.equal(reviews,observed?1:0);
  if(!observed){assert.equal(final.quality!.result.issue,'QUALITY_PRODUCER_MODEL_UNKNOWN');await json(await post(url+'/quality-preview',qualityInput));assert.equal(reviews,0);}
  else{assert.equal(final.quality!.verification.status,'passed');assert.ok(final.quality!.verification.checkIds.length);}
  const board=await json<ProjectProgress>(await get(base+'/progress')),visible=board.tasks.find(item=>item.id===task.id)!;
  assert.deepEqual(visible.capabilityExecutions![0].providerEvidence,final.providerEvidence);
  assert.equal(visible.capabilityExecutions![0].status,final.status);assert.equal(visible.qualityLoops![0].id,final.qualityLoopId);
  assert.equal(f.store.getRun(started.runId!)!.verification,'not_run');
  const finalSeq=f.store.lastSeq();await get(url);await get(base+'/progress');assert.equal(f.store.lastSeq(),finalSeq);
  assert.equal(probes,1);assert.equal(f.runners.length,1);
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await controller.close();await f.close();
 }
});
