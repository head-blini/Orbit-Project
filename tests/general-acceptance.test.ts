import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ClaudeTaskService} from '../server/claude-task-service.ts';
import {CapabilityExecutionService} from '../server/capability-execution.ts';
import {CapabilityRuntimeAdapters} from '../server/capability-runtime-adapters.ts';
import {AcceptanceService,generalAcceptance} from '../server/acceptance.ts';
import {ProjectProgressService} from '../server/project-progress.ts';
import type {Controller} from '../server/controller.ts';
import type {CompletionEvidence} from '../shared/task-completion.ts';
import {claudeFixture,planningInput,outcome,tick} from './claude-task-fixture.ts';
import {fixture} from './capability-fixtures.ts';

const twoRequirements={...planningInput,text:JSON.stringify({...JSON.parse(planningInput.text),requirements:[{id:'REQ-1',description:'Write a report',acceptance_criteria:['Cite evidence']},{id:'REQ-2',description:'Summarize',acceptance_criteria:['Short']}]})};
const service=(f:ReturnType<typeof claudeFixture>,beforeStart:(guard:()=>void)=>void=guard=>guard())=>new ClaudeTaskService(f.store,f.projects,{findExecutable:()=>'/fake/claude',runnerFactory:config=>({
 async start(){beforeStart(config.beforeDispatch);return outcome('completed',{dispatch:'started',evidenceSource:'mock'});},interrupt(){return 'not_running';}
})});

test('general Claude run stores the server acceptance digest and baseline row; code status ignores it',async()=>{
 const f=claudeFixture(),s=service(f);
 try{
  const {task}=f.plan(twoRequirements),expected=generalAcceptance(f.store,f.project.id,task.id);
  assert.equal(expected.kind,'general');assert.match(expected.digest,/^[a-f0-9]{64}$/);
  assert.deepEqual(expected.criteria.map(c=>c.label),[...task.requirementLabels].sort());
  const run=s.submit(f.project.id,task.id,randomUUID());await tick();
  assert.equal(run.acceptanceDigest,expected.digest);
  const row=f.store.db.prepare('SELECT digest,body FROM run_acceptance_baselines WHERE run_id=?').get(run.id);
  assert.equal(row?.digest,expected.digest);assert.deepEqual(JSON.parse(String(row?.body)),expected);
  // AcceptanceService.status only reads workspace (code) runs.
  assert.equal(new AcceptanceService(f.store,f.projects,()=>[]).status('workspace',run.id).state,'unavailable');
  const code=f.store.createRun(randomUUID(),'d','code',undefined,{projectId:f.project.id,taskId:task.id});
  assert.equal(code.acceptanceDigest,undefined);assert.equal(f.store.db.prepare('SELECT 1 FROM run_acceptance_baselines WHERE run_id=?').get(code.id),undefined);
 }finally{await s.close();await f.close();}
});

test('stale plan refuses dispatch without creating a run',async()=>{
 const f=claudeFixture(),s=service(f);
 try{
  const {task,version}=f.plan();
  f.store.db.prepare('UPDATE planning_heads SET version_id=? WHERE version_id=?').run('other',version.id);
  assert.throws(()=>s.submit(f.project.id,task.id,randomUUID()),/PLANNING_VERSION_STALE/);
  assert.throws(()=>generalAcceptance(f.store,f.project.id,task.id),/PLANNING_VERSION_STALE/);
  assert.equal(f.store.runs().length,0);
 }finally{await s.close();await f.close();}
});

test('plan going stale between durable intent and launch is refused by the launch guard',async()=>{
 // buildExecutionBrief pins the task to exactly its plan criteria, so any acceptance change also
 // changes or invalidates the brief; the digest recheck is defense in depth behind it.
 const f=claudeFixture();let guardError:unknown,versionId='';
 const s=service(f,guard=>{
  f.store.db.prepare('UPDATE planning_heads SET version_id=? WHERE version_id=?').run('other',versionId);
  try{guard();}catch(error){guardError=error;throw error;}
 });
 try{
  const {task,version}=f.plan(twoRequirements);versionId=version.id;const run=s.submit(f.project.id,task.id,randomUUID());await tick();
  assert.match(String((guardError as Error)?.message),/PLANNING_VERSION_STALE|LAUNCH_CONTEXT_CHANGED/);
  assert.notEqual(f.store.getRun(run.id)?.execution,'completed');
 }finally{await s.close();await f.close();}
});

function capability(){
 const f=fixture();f.registry.providers[1].version='2.1.312';let calls=0;
 const controller={store:f.store,submitTask:async(projectId:string,taskId:string,input:Record<string,unknown>)=>{
  calls++;assert.deepEqual(Object.keys(input),['requestId']);
  const run=f.store.createRun(String(input.requestId),'digest','approved task',undefined,{runtime:'claude-code',projectId,taskId,planningVersionId:f.plan.id,planningContentHash:f.plan.contentHash,requirementLabels:f.task.requirementLabels},undefined,generalAcceptance(f.store,projectId,taskId));
  return f.store.updateRun(run.id,{execution:'running'},'run.started');
 },interrupt:async()=>{}} as unknown as Controller;
 const adapters=new CapabilityRuntimeAdapters(controller),service=new CapabilityExecutionService(f.store,controller,()=>f.registry,adapters);
 const route=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'문서 작성'},f.registry);
 return {...f,controller,adapters,service,route,get calls(){return calls;}};
}

test('general capability plan binds the server digest through execute and restart',async()=>{
 const f=capability();try{
  const expected=generalAcceptance(f.store,'p',f.task.id).digest;
  const p=f.service.plan('p',{requestId:randomUUID(),routeId:f.route.id});assert.equal(p.expectedAcceptanceDigest,expected);
  assert.equal((await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest})).status,'running');
  const run=f.store.findRequest(p.dispatchRequestId)!.run;assert.equal(run.acceptanceDigest,expected);
  f.store.updateRun(run.id,{execution:'completed'},'run.completed');
  const reopened=new CapabilityExecutionService(f.store,f.controller,()=>f.registry,f.adapters).record('p',p.id);
  assert.equal(reopened.status,'execution_completed');assert.equal(reopened.recoveryRequired,false);assert.equal(f.calls,1);
  // A client-supplied digest must equal the server value; matching is accepted.
  assert.throws(()=>f.service.plan('p',{requestId:randomUUID(),routeId:f.route.id,expectedAcceptanceDigest:'0'.repeat(64)}),/ACCEPTANCE_PREVIEW_STALE/);
  assert.equal(f.service.plan('p',{requestId:randomUUID(),routeId:f.route.id,expectedAcceptanceDigest:expected}).expectedAcceptanceDigest,expected);
  assert.throws(()=>f.service.plan('p',{requestId:randomUUID(),routeId:f.route.id,workspaceId:'w'}),/INVALID_FIELDS/);
 }finally{f.store.close();}
});

test('legacy general records without a digest stay blocked and are never auto-filled',async()=>{
 const f=capability();try{
  const p=f.service.plan('p',{requestId:randomUUID(),routeId:f.route.id});
  f.store.db.prepare("UPDATE capability_executions SET body=json_set(body,'$.expectedAcceptanceDigest',json('null')) WHERE id=?").run(p.id);
  await assert.rejects(f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest}),/PLAN_CHANGED/);assert.equal(f.calls,0);
  assert.equal(f.service.record('p',p.id).expectedAcceptanceDigest,null);
  // A legacy dispatching record whose receipt carries a digest cannot be reconciled.
  const q=f.service.plan('p',{requestId:randomUUID(),routeId:f.route.id});await f.service.start('p',q.id,{confirmed:true,expectedPlanDigest:q.planDigest});
  const run=f.store.findRequest(q.dispatchRequestId)!.run;f.store.updateRun(run.id,{execution:'completed'},'run.completed');
  f.store.db.prepare("UPDATE capability_executions SET body=json_set(body,'$.expectedAcceptanceDigest',json('null'),'$.status','dispatching') WHERE id=?").run(q.id);
  const reopened=new CapabilityExecutionService(f.store,f.controller,()=>f.registry,f.adapters);
  assert.equal(reopened.record('p',q.id).recoveryRequired,true);await assert.rejects(reopened.recover('p',q.id),/EXECUTION_UNCONFIRMED/);
 }finally{f.store.close();}
});

test('receipt without the expected acceptance digest is not confirmed',async()=>{
 const f=capability();try{
  f.controller.submitTask=async(projectId:string,taskId:string,input:{requestId:string})=>{
   const run=f.store.createRun(input.requestId,'digest','approved task',undefined,{runtime:'claude-code',projectId,taskId,planningVersionId:f.plan.id,planningContentHash:f.plan.contentHash});
   return f.store.updateRun(run.id,{execution:'running'},'run.started');
  };
  const p=f.service.plan('p',{requestId:randomUUID(),routeId:f.route.id});
  const record=await f.service.start('p',p.id,{confirmed:true,expectedPlanDigest:p.planDigest});
  assert.equal(record.status,'recovery_required');assert.equal(record.issue,'EXECUTION_DISPATCH_UNCONFIRMED');
 }finally{f.store.close();}
});

test('CQG-1 binds the general acceptance digest without releasing other gates',async()=>{
 const f=claudeFixture(),s=service(f);
 try{
  const {task}=f.plan();const run=s.submit(f.project.id,task.id,randomUUID());await tick();
  let producer:CompletionEvidence['producer'];
  const progress=new ProjectProgressService(f.store,f.studio,{evidence:base=>({...base,producer})});
  const read=()=>progress.read(f.project.id,{}).tasks.find(t=>t.id===task.id)!.completion!;
  // Fixture producer echoes the captured binding; it is not live provider evidence.
  producer={binding:{...read().binding},model:{providerId:'fixture',modelId:'producer',sessionId:'session',runId:run.id,source:'native_observed',evidenceSource:'native'}};
  const completion=read();
  assert.equal(completion.binding.acceptanceDigest,run.acceptanceDigest);
  assert.ok(!completion.reasonCodes.includes('CQG_BINDING_MISSING:acceptanceDigest'),completion.reasonCodes.join());
  assert.equal(completion.verifiedDone,false);assert.ok(completion.reasonCodes.length>0);
 }finally{await s.close();await f.close();}
});
